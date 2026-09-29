"""顺序运行冻结样本；不向模型传人工标签或旧 AI 结论。"""

import json
import threading
from dataclasses import asdict
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..record import Job, sha, write_json
from ..checkpoint import RunJournal, atomic_text, digest, engine_contract, run_lock
from ..runtime import RunInterrupted
from .pool import read_pool


def ensure_batch_complete(directory: Path, results: list[dict]) -> None:
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    expected = [item["eval_id"] for item in manifest.get("samples", [])]
    actual = [row["eval_id"] for row in results]
    if not expected or len(actual) != len(set(actual)) or set(actual) != set(expected):
        raise ValueError("评测未完成全部冻结样本，不能生成完整成绩；用run-status查看或resume继续")
    path = directory / "checkpoint.json"
    if path.is_file():
        state = json.loads(path.read_text(encoding="utf-8"))
        if state["status"] not in {"completed", "completed_with_failures"} or any(
            not job["attempts"] or job["attempts"][-1]["status"] != "finished" for job in state["jobs"]
        ):
            raise ValueError("检查点仍有未完成岗位，不能把部分成功结果当完整成绩")


def select_entries(pool_path: Path, sample_path: Path, dataset="blind", limit=3):
    pool = read_pool(pool_path)
    if len({e.eval_id for e in pool}) != len(pool):
        raise ValueError("评测池含重复 eval_id")
    if dataset == "blind":
        selected = [s["eval_id"] for s in json.loads(sample_path.read_text(encoding="utf-8"))]
        if len(selected) != len(set(selected)):
            raise ValueError("盲标样本编号重复")
        by_id = {e.eval_id: e for e in pool}
        if any(i not in by_id for i in selected):
            raise ValueError("盲标样本与评测池不对应")
        entries = [by_id[i] for i in selected]
    elif dataset == "applied":
        entries = [e for e in pool if e.applied]
    else:
        raise ValueError("set 必须为 blind 或 applied")
    if not 1 <= limit <= 200:
        raise ValueError("limit 必须在 1–200")
    if not entries:
        raise ValueError("选择的评测集为空")
    return entries[:limit]


def run_batch(matcher, entries, directory: Path, *, model_name: str, workers=1, matcher_factory=None,
              resume=False, retry_failed=False, stop_after=None):
    if not entries:
        raise ValueError("评测批次不能为空")
    if not 1 <= workers <= 4:
        raise ValueError("workers 必须在 1–4")
    if workers > 1 and matcher_factory is None:
        raise ValueError("并发运行必须为每岗建立独立的模型会话")
    if stop_after is not None and (workers != 1 or stop_after < 1):
        raise ValueError("受控停止只用于顺序运行，stop_after 必须为正整数")
    directory = directory.resolve()
    if not resume:
        directory.mkdir(parents=True, exist_ok=False)
    contract = {"engine": engine_contract(matcher, model_name), "samples_sha256": digest([asdict(e) for e in entries]), "workers": workers}
    with run_lock(directory):
        if not resume:
            write_json(directory / "manifest.json", {
                "checkpoint_schema_version": 1, "kind": "evaluation", "model": model_name,
                "variant": matcher.retriever.mode, "corpus_version": matcher.corpus.version,
                "source_sha256": contract["engine"]["source_sha256"],
                "samples": [{"eval_id": e.eval_id, "jd_sha256": sha(e.jd_text)} for e in entries],
                "labels_sent_to_model": False, "workers": workers})
            write_json(directory / "samples.json", [asdict(e) for e in entries])
            if hasattr(matcher.corpus, "write"):
                matcher.corpus.write(directory)
        journal = RunJournal(directory, "evaluation", contract, [e.eval_id for e in entries], resume=resume)
        if not resume:
            journal.freeze([directory / "manifest.json", directory / "samples.json"] +
                           [p for p in (directory / "corpus.json", directory / "candidate-evidence.txt") if p.is_file()])
        pending = [(i, e) for i, e in enumerate(entries) if journal.cached(i, retry_failed=retry_failed) is None]
        cancel = threading.Event()

        def execute(index, entry):
            if cancel.is_set():
                raise RunInterrupted()
            runner = None
            previous = (None, None)
            try:
                runner = matcher_factory() if matcher_factory else matcher
                previous = (getattr(runner, "cancel_event", None), getattr(runner.llm, "cancel_event", None))
                runner.cancel_event = cancel
                runner.llm.cancel_event = cancel
                target = journal.begin(index)
                result = runner.run(Job(entry.eval_id, entry.company, entry.title, entry.jd_text, entry.city), target)
                result.update(eval_id=entry.eval_id, applied=entry.applied)
                journal.finish(index, result)
                return result
            except BaseException:
                cancel.set()
                raise
            finally:
                if runner is not None:
                    runner.cancel_event, runner.llm.cancel_event = previous
                    if matcher_factory and hasattr(runner.llm, "client"):
                        runner.llm.client.close()

        def save(result):
            rows = journal.results()
            atomic_text(directory / "results.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
            print(f"[{len(rows)}/{len(entries)}] {result['eval_id']}: {result['execution_status']}, verified={result['verification_passed']}", flush=True)

        try:
            if workers == 1:
                for completed, (index, entry) in enumerate(pending, 1):
                    save(execute(index, entry))
                    if stop_after is not None and completed >= stop_after:
                        break
            else:
                executor = ThreadPoolExecutor(max_workers=workers)
                try:
                    futures = [executor.submit(execute, i, e) for i, e in pending]
                    for future in as_completed(futures):
                        save(future.result())
                except BaseException:
                    cancel.set()
                    raise
                finally:
                    executor.shutdown(wait=True, cancel_futures=True)
        finally:
            journal.finalize()
            rows = journal.results()
            atomic_text(directory / "results.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
        return journal.results()
