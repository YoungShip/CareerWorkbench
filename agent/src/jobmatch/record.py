"""把模型语义输出与可信快照合为 matching v2；最终调用原有正式流水线。"""

from __future__ import annotations

import copy
import hashlib
import json
import subprocess
import shutil
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .corpus import Corpus
from .decision import derive_decision
from .privacy import redact
from .jd import prepare_jd
from .verifier import load_verifier, summary


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Job:
    id: str
    company: str
    title: str
    jd_text: str
    city: str = ""
    url: str = ""


def prepare_snapshots(directory: Path, job: Job, clauses: list[str], corpus: Corpus) -> None:
    prepared = prepare_jd(job.jd_text, redact_text=True)
    if prepared.clauses != clauses:
        raise ValueError("JD 快照与转换记录不一致")
    (directory / "jd-original.txt").write_bytes(job.jd_text.encode("utf-8"))
    write_json(directory / "jd-preprocessing.json", prepared.audit())
    (directory / "jd.txt").write_text("\n".join(clauses) + "\n", encoding="utf-8", newline="\n")
    corpus.write(directory)
    write_json(directory / "catalog.json", {"records": [{"id": job.id, "title": redact(job.title)}]})


def build_record(job: Job, clauses: list[str], requirements: list[dict], judgments: list[dict], corpus: Corpus, scripts_dir=None) -> dict:
    normal = load_verifier(scripts_dir).normalize
    line_ids, quotes, seen = {}, {}, {}
    for n, line in enumerate(clauses, 1):
        normalized = normal(line)
        first = seen.setdefault(normalized, n)
        qid = f"L{first}"
        line_ids[n] = qid
        quotes[qid] = {"id": qid, "text": clauses[first - 1], "locator": {"line_start": first, "line_end": first}}
    by_id = {j["requirement_id"]: j for j in judgments}
    entries, used_quotes, used_evidence = [], set(), set()
    for n, req in enumerate(requirements, 1):
        rid = f"R{n}"
        judged = by_id[rid]
        jd_ids = list(dict.fromkeys(line_ids[i] for i in req["jd_lines"]))
        basis = list(dict.fromkeys(line_ids[i] for i in req["category_basis_lines"]))
        evidence_ids = list(dict.fromkeys(judged["evidence_ids"]))
        used_quotes.update(jd_ids + basis)
        used_evidence.update(evidence_ids)
        entries.append({
            "requirement_id": rid, "text": redact(req["text"]),
            "category": judged.get("category") or req["category"],
            "category_basis_quote_ids": basis, "jd_quote_ids": jd_ids,
            "candidate_evidence_ids": evidence_ids,
            "support": judged["support"], "conclusion": judged["conclusion"],
            "judgment": redact(judged["judgment"]),
            "unverified_aspects": [redact(s) for s in judged.get("unverified_aspects", [])],
        })
    decision = derive_decision(entries)
    evidence = []
    for chunk in corpus.chunks:
        if chunk.id in used_evidence:
            line = corpus.line_of(chunk.id)
            evidence.append({"id": chunk.id, "text": chunk.text, "locator": {"line_start": line, "line_end": line}})
    # 未知 evidence_ids 留在 requirements 中，由校验器拒绝，不静默修饰模型输出。
    stamp = datetime.now(timezone.utc).isoformat()
    position = {
        "id": job.id, "title": redact(job.title), "city": redact(job.city or "未标注"),
        "excluded": decision["excluded"],
        "jd_source": {
            "position_id": job.id, "url": redact(job.url) or "local:jd.txt", "read_at": stamp,
            "snapshot_file": "jd.txt", "sha256": sha("\n".join(clauses) + "\n"),
            "provided_snapshot_file": "jd-original.txt", "provided_sha256": sha(job.jd_text),
            "preprocessing_file": "jd-preprocessing.json",
            "read_at_scope": "local_processing_time_not_official_capture_time",
            "quotes": [q for k, q in quotes.items() if k in used_quotes],
        },
        "candidate_source": {
            "profile_version": corpus.version, "snapshot_file": "candidate-evidence.txt",
            "sha256": sha(corpus.snapshot), "evidence": evidence,
        },
        "requirements": entries,
        "decision": {k: decision[k] for k in ("state", "reason")} | {"basis": "requirement_summary"},
    }
    if decision["excluded"]:
        position["exclusion_reason"] = decision["exclusion_reason"]
    return {
        "schema_version": 2, "company": redact(job.company), "date": stamp[:10],
        "scope": "jobmatch 单岗匹配；未做全量目录抓取与岗位开放核验",
        "selected_position_id": job.id,
        "coverage": {"capture_status": "partial", "note": "输入单岗快照，不构成全量研究或投递授权"},
        "raw_catalog": {"file": "catalog.json", "format": "json", "records_path": "/records", "id_path": "/id", "total_positions": 1},
        "catalog_index": [{"id": job.id, "title": redact(job.title), "city": redact(job.city or "未标注"), "in_scope": True}],
        "positions": [position],
    }


def assembled(record: dict, scripts_dir=None) -> dict:
    result = copy.deepcopy(record)
    for position in result["positions"]:
        position["requirement_summary"] = summary(position["requirements"], scripts_dir)
    return result


def publish(raw: Path, scripts: Path, directory: Path, *, extra_files=None) -> dict:
    result = subprocess.run(
        [sys.executable, "-X", "utf8", str(scripts / "run-matching-pipeline.py"), "--raw", str(raw), "--run-dir", str(directory)],
        stdin=subprocess.DEVNULL, capture_output=True, timeout=90,
    )
    report_path = directory / "pipeline-result.json"
    if not report_path.is_file():
        raise RuntimeError(f"正式匹配流水线没有生成报告（退出码 {result.returncode}）")
    report = json.loads(report_path.read_text(encoding="utf-8"))
    if report.get("execution_status") != "completed" or report.get("human_summary_status") != "generated":
        raise RuntimeError("正式匹配流水线未完整生成结果")
    # 原流水线只复制标准快照；补入本模块的原文与转换审计，保证产物可独立核对。
    for name in extra_files if extra_files is not None else ("jd-original.txt", "jd-preprocessing.json", "extraction-audit.json"):
        source = raw.parent / name
        (directory / name).parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, directory / name)
        if (directory / name).read_bytes() != source.read_bytes():
            raise RuntimeError("原文审计复制校验失败")
    return report
