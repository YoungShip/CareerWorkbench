import json
from types import SimpleNamespace

import pytest

from jobmatch.checkpoint import run_lock, run_status
from jobmatch.evaluation.pool import PoolEntry
from jobmatch.evaluation.run import run_batch
from jobmatch.workflow import run_research
from test_workflow import request, engine, replies, RULES


def test_research_resume_reuses_completed_jobs_with_frozen_inputs(corpus, tmp_path):
    path, _ = request(tmp_path)
    out = tmp_path / "run"
    first = engine(corpus, replies())
    result = run_research(path, out, first, RULES, stop_after=1)
    assert result["execution_status"] == "interrupted"
    completed_file = out / "jobs/job-001/attempt-001/result.json"
    before = completed_file.read_bytes()
    # 外部JD改变不影响恢复已冻结的批次。
    (tmp_path / "jd.txt").write_text("新的不同JD", encoding="utf-8")
    resumed = engine(corpus, replies())
    result = run_research(path, out, resumed, RULES, resume=True)
    assert result["mechanical_passed"] and len(resumed.llm.requests) == 2
    assert completed_file.read_bytes() == before
    done = engine(corpus, [])
    again = run_research(path, out, done, RULES, resume=True)
    assert again["matching_file"] == result["matching_file"] and done.llm.requests == []


def test_interrupted_job_gets_new_attempt_without_overwriting_partial(corpus, tmp_path):
    path, _ = request(tmp_path)
    out = tmp_path / "run"
    with pytest.raises(KeyboardInterrupt):
        run_research(path, out, engine(corpus, replies() + [KeyboardInterrupt()]), RULES)
    partial = out / "jobs/job-002/attempt-001/trace.jsonl"
    original = partial.read_bytes()
    resumed = engine(corpus, replies())
    result = run_research(path, out, resumed, RULES, resume=True)
    assert result["mechanical_passed"]
    assert partial.read_bytes() == original
    assert (out / "jobs/job-002/attempt-002/result.json").is_file()
    assert result["jobs"][1]["interrupted_attempts"] == 1
    assert result["jobs"][1]["usage_complete"] is False


def test_failed_jobs_need_explicit_retry_and_original_failure_survives(corpus, tmp_path):
    path, _ = request(tmp_path)
    out = tmp_path / "run"
    run_research(path, out, engine(corpus, [RuntimeError("fixture")] + replies()), RULES)
    no_retry = engine(corpus, [])
    result = run_research(path, out, no_retry, RULES, resume=True)
    assert result["execution_status"] == "completed_with_failures" and not no_retry.llm.requests
    failure = (out / "jobs/job-001/attempt-001/result.json").read_bytes()
    retried = run_research(path, out, engine(corpus, replies()), RULES, resume=True, retry_failed=True)
    assert retried["mechanical_passed"] and retried["jobs"][0]["prior_failures"] == 1
    assert (out / "jobs/job-001/attempt-001/result.json").read_bytes() == failure
    assert (out / "pipeline").is_dir() and (out / "pipeline-002").is_dir()


def test_changed_completed_output_or_engine_is_not_reused(corpus, tmp_path):
    path, _ = request(tmp_path)
    out = tmp_path / "run"
    run_research(path, out, engine(corpus, replies()), RULES, stop_after=1)
    changed = engine(corpus, [])
    changed.max_calls = 15
    with pytest.raises(ValueError, match="版本发生变化"):
        run_research(path, out, changed, RULES, resume=True)
    (out / "jobs/job-001/attempt-001/jd.txt").write_text("篡改", encoding="utf-8")
    no_calls = engine(corpus, [])
    with pytest.raises(ValueError, match="文件缺失或变动"):
        run_research(path, out, no_calls, RULES, resume=True)
    assert no_calls.llm.requests == []


def test_running_batch_lock_prevents_second_writer(tmp_path):
    with run_lock(tmp_path):
        with pytest.raises(ValueError, match="正在运行"):
            with run_lock(tmp_path):
                pass
    with run_lock(tmp_path):
        pass  # 正常离开后自动释放。


def test_process_death_releases_os_lock(tmp_path):
    import subprocess
    import sys
    code = "import os,sys;from pathlib import Path;from jobmatch.checkpoint import run_lock\nwith run_lock(Path(sys.argv[1])): os._exit(7)"
    result = subprocess.run([sys.executable, "-c", code, str(tmp_path)], capture_output=True, timeout=15)
    assert result.returncode == 7
    with run_lock(tmp_path):
        pass


def test_resume_after_report_failure_does_not_repeat_model_jobs(corpus, tmp_path, monkeypatch):
    import jobmatch.workflow as workflow
    path, _ = request(tmp_path)
    out = tmp_path / "run"
    original = workflow.publish
    def interrupted(raw, scripts, target, **kwargs):
        target.mkdir()
        (target / "partial.txt").write_text("preserve")
        raise RuntimeError("fixture publication interrupted")
    monkeypatch.setattr(workflow, "publish", interrupted)
    with pytest.raises(RuntimeError):
        run_research(path, out, engine(corpus, replies()*2), RULES)
    assert run_status(out)["reports_current"] is False
    monkeypatch.setattr(workflow, "publish", original)
    runner = engine(corpus, [])
    result = run_research(path, out, runner, RULES, resume=True)
    assert result["mechanical_passed"] and not runner.llm.requests
    assert (out / "pipeline/partial.txt").read_text() == "preserve"
    assert "pipeline-002" in result["matching_file"]


class BatchRunner:
    retriever = SimpleNamespace(mode="full")
    corpus = SimpleNamespace(version="fixture")
    llm = SimpleNamespace()

    def __init__(self):
        self.seen = []

    def run(self, job, directory):
        self.seen.append(job.id)
        directory.mkdir(parents=True)
        result = {"job_id": job.id, "verification_passed": True, "execution_status": "completed",
                  "first_passed": True, "decision": "recommended"}
        (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")
        return result


def test_eval_resume_keeps_order_and_completed_results(tmp_path):
    entries = [PoolEntry(i, "测试公司", "岗位", "城市", "JD") for i in ("a", "b", "c")]
    out = tmp_path / "batch"
    first = BatchRunner()
    run_batch(first, entries, out, model_name="fixture", stop_after=1)
    second = BatchRunner()
    results = run_batch(second, entries, out, model_name="fixture", resume=True)
    assert first.seen == ["a"] and second.seen == ["b", "c"]
    assert [r["eval_id"] for r in results] == ["a", "b", "c"]
    assert run_status(out)["counts"]["passed"] == 3


def test_retry_metrics_keep_the_first_failure_and_both_usage_records(tmp_path):
    class WithUsage(BatchRunner):
        def __init__(self, passed):
            super().__init__()
            self.passed = passed
        def run(self, job, directory):
            result = super().run(job, directory)
            result.update(verification_passed=self.passed, first_passed=self.passed,
                          decision="recommended" if self.passed else None, calls=1,
                          usage=[{"input_tokens": 10, "output_tokens": 5, "cost_cny": 1.0}])
            (directory / "result.json").write_text(json.dumps(result), encoding="utf-8")
            return result
    entries = [PoolEntry("a", "测试", "岗位", "城市", "JD")]
    out = tmp_path / "run"
    run_batch(WithUsage(False), entries, out, model_name="fixture")
    result = run_batch(WithUsage(True), entries, out, model_name="fixture", resume=True, retry_failed=True)[0]
    assert result["first_passed"] is False and result["verification_passed"] is True
    assert result["prior_failures"] == 1 and result["calls"] == 2
    assert sum(u["input_tokens"] for u in result["usage"]) == 20


def test_moved_run_is_rejected_instead_of_returning_stale_absolute_paths(tmp_path):
    import shutil
    entries = [PoolEntry("a", "测试", "岗位", "城市", "JD")]
    source, moved = tmp_path / "original", tmp_path / "copied"
    run_batch(BatchRunner(), entries, source, model_name="fixture")
    shutil.copytree(source, moved)
    with pytest.raises(ValueError, match="运行目录已移动"):
        run_batch(BatchRunner(), entries, moved, model_name="fixture", resume=True)


def test_parallel_interrupt_does_not_start_queued_model_jobs(tmp_path):
    import threading
    from jobmatch.runtime import RunInterrupted
    barrier = threading.Barrier(2)
    seen = []
    class Interrupting(BatchRunner):
        def __init__(self):
            super().__init__()
            self.llm = SimpleNamespace()
        def run(self, job, directory):
            if self.cancel_event.is_set():
                raise RunInterrupted()
            seen.append(job.id)
            directory.mkdir(parents=True)
            barrier.wait(timeout=5)
            if job.id == "a":
                raise KeyboardInterrupt()
            assert self.cancel_event.wait(5)
            raise RunInterrupted()
    entries = [PoolEntry(i, "测试", "岗位", "城市", "JD") for i in ("a", "b", "c", "d")]
    with pytest.raises((KeyboardInterrupt, RunInterrupted)):
        run_batch(Interrupting(), entries, tmp_path / "run", model_name="fixture", workers=2, matcher_factory=Interrupting)
    assert set(seen) == {"a", "b"}
    assert run_status(tmp_path / "run")["recorded_status"] == "interrupted"


def test_cli_reports_interruption_without_turning_it_into_success(monkeypatch, capsys):
    import jobmatch.cli as cli
    from jobmatch.runtime import RunInterrupted
    def interrupted(args):
        raise RunInterrupted()
    monkeypatch.setattr(cli, "cmd_doctor", interrupted)
    assert cli.main(["doctor"]) == 130
    assert "jobmatch resume" in capsys.readouterr().err


def test_interrupt_does_not_poison_reusable_matcher(corpus, tmp_path):
    from jobmatch.record import Job
    runner = engine(corpus, [KeyboardInterrupt()])
    entries = [PoolEntry("a", "测试", "岗位", "城市", "有Python接口经验。")]
    with pytest.raises(KeyboardInterrupt):
        run_batch(runner, entries, tmp_path / "batch", model_name="fixture")
    runner.llm.replies.extend(replies())
    result = runner.run(Job("b", "测试", "岗位", "有Python接口经验。"), tmp_path / "next")
    assert result["verification_passed"]


def test_empty_batch_cannot_claim_completion(tmp_path):
    with pytest.raises(ValueError, match="不能为空"):
        run_batch(BatchRunner(), [], tmp_path / "empty", model_name="fixture")
    assert not (tmp_path / "empty").exists()


def test_partial_batch_cannot_publish_full_evaluation_score(tmp_path):
    from jobmatch.evaluation.run import ensure_batch_complete
    entries = [PoolEntry(i, "测试", "岗位", "城市", "JD") for i in ("a", "b")]
    out = tmp_path / "run"
    rows = run_batch(BatchRunner(), entries, out, model_name="fixture", stop_after=1)
    with pytest.raises(ValueError, match="未完成全部"):
        ensure_batch_complete(out, rows)
    completed = run_batch(BatchRunner(), entries, out, model_name="fixture", resume=True)
    ensure_batch_complete(out, completed)
