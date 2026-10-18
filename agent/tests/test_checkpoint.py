import json

import pytest

from jobmatch.checkpoint import run_lock, run_status
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


def test_cli_reports_interruption_without_turning_it_into_success(monkeypatch, capsys):
    import jobmatch.cli as cli
    from jobmatch.runtime import RunInterrupted
    def interrupted(args):
        raise RunInterrupted()
    monkeypatch.setattr(cli, "cmd_doctor", interrupted)
    assert cli.main(["doctor"]) == 130
    assert "jobmatch resume" in capsys.readouterr().err

