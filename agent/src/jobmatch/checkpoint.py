"""批次级持久检查点。只复用已封存的岗位，保留中断和失败尝试。"""

from __future__ import annotations

import copy
import hashlib
import json
import os
import threading
import sys
from importlib.metadata import version, PackageNotFoundError
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from .runtime import source_fingerprint


def digest(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path: Path, value) -> None:
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def atomic_text(path: Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def engine_contract(matcher, model_name: str) -> dict:
    config = getattr(matcher.llm, "config", None)
    settings = {key: getattr(config, key, None) for key in
                ("provider", "base_url", "model", "max_output_tokens", "input_price", "output_price", "fixture_sha256")}
    # 只保存摘要；凭据不参与保存或输出。
    scripts = getattr(matcher, "scripts", None)
    validators = {name: file_sha(scripts / name) for name in
                  ("verify-matching.py", "assemble-matching-summary.py", "derive_matching_display.py", "run-matching-pipeline.py")} if scripts else {}
    dependencies = {}
    for name in ("langgraph", "openai", "pydantic", "numpy", "fastembed", "faiss-cpu", "jieba", "rank-bm25", "langsmith"):
        try:
            dependencies[name] = version(name)
        except PackageNotFoundError:
            dependencies[name] = None
    return {"source_sha256": source_fingerprint(), "model": model_name, "provider": getattr(config, "provider", None),
            "model_settings_sha256": digest(settings), "variant": matcher.retriever.mode,
            "corpus_version": matcher.corpus.version,
            "corpus_sha256": hashlib.sha256(getattr(matcher.corpus, "snapshot", matcher.corpus.version).encode()).hexdigest(),
            "validator_sha256": validators,
            "runtime": {"python": list(sys.version_info[:3]), "platform": sys.platform, "dependencies": dependencies},
            "limits": {key: getattr(matcher, key, None) for key in ("max_searches", "max_repairs", "max_calls")}}


@contextmanager
def run_lock(directory: Path):
    """进程退出由操作系统释放锁，不靠超时猜测活跃进程。"""
    path = directory / ".run.lock"
    stream = path.open("a+b")
    acquired = False
    try:
        if path.stat().st_size == 0:
            stream.write(b"0")
            stream.flush()
        stream.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            acquired = True
        except OSError:
            raise ValueError("这个批次正在运行；不能同时恢复或重试") from None
        yield
    finally:
        if acquired:
            stream.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


class RunJournal:
    def __init__(self, directory: Path, kind: str, contract: dict, identifiers: list[str], *, resume=False):
        self.directory = directory.resolve()
        self.path = self.directory / "checkpoint.json"
        self.mutex = threading.RLock()
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("岗位身份重复，不能建立恢复检查点")
        if resume:
            if not self.path.is_file():
                raise ValueError("该运行没有新版检查点；保留原目录，使用新运行")
            self.state = json.loads(self.path.read_text(encoding="utf-8"))
            if self.state.get("schema_version") != 1 or self.state.get("kind") != kind:
                raise ValueError("检查点类型或版本不兼容")
            if Path(self.state.get("directory", "")) != self.directory:
                raise ValueError("运行目录已移动；报告中的绝对引用不能直接复用，请还原原路径或新建运行")
            if self.state["contract"] != contract or [j["id"] for j in self.state["jobs"]] != identifiers:
                raise ValueError("代码、依赖、模型配置、来源或候选资料版本发生变化；请新建运行，不能混用旧结果")
            self._verify_files(self.state["frozen_files"])
            for job in self.state["jobs"]:
                for attempt in job["attempts"]:
                    if attempt["status"] == "running":
                        attempt["status"] = "interrupted"
                        attempt["ended_at"] = self._now()
            self.state["resumptions"] += 1
        else:
            if self.path.exists():
                raise FileExistsError("检查点已存在")
            self.state = {"schema_version": 1, "kind": kind, "contract": contract, "directory": str(self.directory),
                          "created_at": self._now(), "resumptions": 0, "status": "running",
                          "frozen_files": {}, "jobs": [{"id": i, "attempts": []} for i in identifiers],
                          "publications": []}
        self._save()

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat()

    def _save(self):
        atomic_json(self.path, self.state)

    def _safe(self, relative: str) -> Path:
        path = (self.directory / relative).resolve()
        if not path.is_relative_to(self.directory):
            raise ValueError("检查点文件路径越出运行目录")
        return path

    def _verify_files(self, files: dict):
        for name, expected in files.items():
            path = self._safe(name)
            if not path.is_file() or file_sha(path) != expected:
                raise ValueError(f"已冻结/已完成文件缺失或变动：{name}；停止复用，保留现场")

    def freeze(self, files: list[Path]):
        with self.mutex:
            self.state["frozen_files"] = {str(p.resolve().relative_to(self.directory)).replace("\\", "/"): file_sha(p) for p in files}
            self._save()

    def cached(self, index: int, *, retry_failed=False) -> dict | None:
        with self.mutex:
            attempts = self.state["jobs"][index]["attempts"]
            if not attempts or attempts[-1]["status"] != "finished":
                return None
            latest = attempts[-1]
            for attempt in attempts:
                if attempt["status"] == "finished":
                    self._verify_files(attempt["artifacts"])
            if retry_failed and not latest["result"].get("verification_passed"):
                return None
            return copy.deepcopy(latest["result"])

    def begin(self, index: int) -> Path:
        with self.mutex:
            attempts = self.state["jobs"][index]["attempts"]
            relative = f"jobs/job-{index + 1:03}/attempt-{len(attempts) + 1:03}"
            target = self._safe(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise ValueError("尝试目录已存在，拒绝覆盖")
            attempts.append({"status": "running", "directory": relative, "started_at": self._now()})
            self.state["status"] = "running"
            self._save()
            return target

    def finish(self, index: int, result: dict):
        with self.mutex:
            attempt = self.state["jobs"][index]["attempts"][-1]
            target = self._safe(attempt["directory"])
            if result.get("job_id") != self.state["jobs"][index]["id"]:
                raise ValueError("执行结果的岗位ID与检查点不一致")
            if not target.is_dir() or not (target / "result.json").is_file():
                raise ValueError("执行器未完整保存 result.json，不能封存完成")
            paths = sorted(p for p in target.rglob("*") if p.is_file())
            artifacts = {str(p.relative_to(self.directory)).replace("\\", "/"): file_sha(self._safe(str(p.relative_to(self.directory)))) for p in paths}
            attempt.update(status="finished", ended_at=self._now(), result=copy.deepcopy(result), artifacts=artifacts)
            self._save()

    def attempt_directory(self, index: int) -> Path:
        return self._safe(self.state["jobs"][index]["attempts"][-1]["directory"])

    def results(self) -> list[dict]:
        rows = []
        with self.mutex:
            for job in self.state["jobs"]:
                attempts = job["attempts"]
                if not attempts or attempts[-1]["status"] != "finished":
                    continue
                latest = copy.deepcopy(attempts[-1]["result"])
                finished = [a["result"] for a in attempts if a["status"] == "finished"]
                latest["attempt_count"] = len(attempts)
                latest["prior_failures"] = sum(not r.get("verification_passed", False) for r in finished[:-1])
                latest["interrupted_attempts"] = sum(a["status"] == "interrupted" for a in attempts)
                real_model = self.state["contract"]["engine"].get("provider") not in {None, "scripted"}
                missing_usage = real_model and any(r.get("calls", 0) > len(r.get("usage", [])) or
                    any(u.get("attempts", 1) > 1 for u in r.get("usage", [])) for r in finished)
                latest["usage_complete"] = latest["interrupted_attempts"] == 0 and not missing_usage
                latest["usage"] = [u for r in finished for u in r.get("usage", [])]
                latest["calls"] = sum(r.get("calls", 0) for r in finished)
                latest["elapsed_ms"] = sum(r.get("elapsed_ms", 0) for r in finished)
                latest["first_passed"] = attempts[0].get("result", {}).get("first_passed")
                rows.append(latest)
        return rows

    def finalize(self):
        with self.mutex:
            rows = self.results()
            self.state["status"] = ("completed" if all(r.get("verification_passed") for r in rows) else "completed_with_failures") if len(rows) == len(self.state["jobs"]) else "interrupted"
            self.state["updated_at"] = self._now()
            self._save()

    def publication(self, fingerprint: str) -> dict | None:
        if not self.state["publications"]:
            return None
        item = self.state["publications"][-1]
        if item["fingerprint"] != fingerprint:
            return None
        self._verify_files(item["artifacts"])
        self._verify_files(self.state.get("current_aliases", {}))
        return copy.deepcopy(item["result"])

    def seal_publication(self, fingerprint: str, files: list[Path], result: dict, *, aliases=()):
        self.state["publications"].append({"fingerprint": fingerprint,
            "artifacts": {str(p.relative_to(self.directory)).replace("\\", "/"): file_sha(p) for p in files},
            "result": copy.deepcopy(result)})
        self.state["current_aliases"] = {str(p.relative_to(self.directory)).replace("\\", "/"): file_sha(p) for p in aliases}
        self._save()


def run_status(directory: Path) -> dict:
    state = json.loads((directory / "checkpoint.json").read_text(encoding="utf-8"))
    counts = {"unstarted": 0, "incomplete": 0, "passed": 0, "failed": 0}
    for job in state["jobs"]:
        latest = job["attempts"][-1] if job["attempts"] else None
        key = "unstarted" if latest is None else "incomplete" if latest["status"] != "finished" else "passed" if latest["result"].get("verification_passed") else "failed"
        counts[key] += 1
    publications = state.get("publications", [])
    return {"kind": state["kind"], "recorded_status": state["status"], "counts": counts,
            "reports_current": bool(publications and publications[-1]["fingerprint"] == digest(state["jobs"])) if state["kind"] in {"research", "semantic"} else None,
            "semantic_checks": {"passed": sum(j["attempts"][-1].get("result", {}).get("semantic_check", {}).get("passed", False) for j in state["jobs"] if j["attempts"]),
                                "total": len(state["jobs"])} if state["kind"] == "semantic" else None,
            "resumptions": state["resumptions"], "code_matches": state["contract"]["engine"]["source_sha256"] == source_fingerprint(),
            "note": "只读状态；未检验运行锁或全部工件。恢复时逐项复核。"}
