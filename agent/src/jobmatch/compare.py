"""从已保存、重新校验的单岗结果生成公司内只读对照；不打综合分或替用户选岗。"""

from __future__ import annotations

import hashlib
import html
import json
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from .evaluation.pool import company_key
from .record import write_json
from .schemas import Extraction, extraction_check
from .verifier import verify

STATES = {"recommended": "证据支持", "consider": "有可迁移经历", "pending": "有待核对项", "excluded": "存在明确不满足项"}
CONCLUSIONS = {"satisfied": "满足", "pending": "待核对", "not_satisfied": "不满足"}
SUPPORTS = {"direct_support": "有直接证据", "transferable": "相邻经历可迁移", "no_evidence": "缺少相关证据", "conflict": "证据存在冲突"}
UNKNOWN = {
    "application_limit": None,
    "preference_order": None,
    "official_open_status": "unknown",
    "current_selection_rules_checked": False,
    "catalog_coverage": "partial",
}


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_run(directory: Path) -> dict:
    directory = directory.resolve()
    result = _read(directory / "result.json")
    path = directory / "pipeline/assembled-matching.json"
    record = _read(path)
    if result.get("execution_status") != "completed" or not result.get("verification_passed"):
        raise ValueError("比较输入包含失败或未通过校验的运行")
    positions = record.get("positions", [])
    if len(positions) != 1 or positions[0]["id"] != result.get("job_id"):
        raise ValueError("比较输入必须是单岗且身份一致的运行")
    pos = positions[0]
    if result.get("decision") != pos["decision"]["state"] or not verify(record, path, pos["id"]).passed:
        raise ValueError("结果已变动或不再通过原校验器")
    audit_path = directory / "pipeline/jd-preprocessing.json"
    if not audit_path.is_file():
        raise ValueError("缺少原文追溯审计，旧运行请先用当前版本重跑")
    audit = _read(audit_path)
    if audit.get("provided_sha256") != _digest(directory / "pipeline/jd-original.txt") or audit.get("model_sha256") != _digest(directory / "pipeline/jd.txt"):
        raise ValueError("JD 原文或转换快照哈希不一致")
    if audit["provided_sha256"] != pos["jd_source"].get("provided_sha256") or audit["model_sha256"] != pos["jd_source"]["sha256"]:
        raise ValueError("匹配结果引用的 JD 与原文审计不对应")
    coverage = _read(directory / "pipeline/extraction-audit.json")
    if coverage.get("all_lines_accounted") is not True:
        raise ValueError("未完成 JD 逐行用途审计")
    extraction_check(Extraction.model_validate({k: coverage[k] for k in ("requirements", "ignored_lines")}),
                     len((directory / "pipeline/jd.txt").read_text(encoding="utf-8").splitlines()))
    return {"directory": str(directory), "record": record, "position": pos, "result": result,
            "ignored_jd_lines": [{**item, "text": (directory / "pipeline/jd.txt").read_text(encoding="utf-8").splitlines()[item["line"] - 1]}
                                 for item in coverage["ignored_lines"]],
            "input_hashes": {str(p.relative_to(directory)): _digest(p) for p in (
                directory / "result.json", path, audit_path, directory / "pipeline/extraction-audit.json")},
            "provided_sha256": audit["provided_sha256"]}


def compare_runs(directories: list[Path]) -> dict:
    if not 2 <= len(directories) <= 20:
        raise ValueError("一次比较须包含同公司 2–20 个岗位")
    if len({p.resolve() for p in directories}) != len(directories):
        raise ValueError("同一个运行目录不能重复计入")
    sources = [load_run(p) for p in directories]
    companies = {company_key(r["record"].get("company", "")) for r in sources}
    if len(companies) != 1 or not next(iter(companies)):
        raise ValueError("岗位公司主体不一致；不能依据前缀、简称或集团关系合并")
    profiles = {r["position"]["candidate_source"]["sha256"] for r in sources}
    if len(profiles) != 1:
        raise ValueError("候选证据版本不同，请用同一版资料重跑后比较")
    versions = {r["result"].get("source_sha256") for r in sources}
    models = {r["result"].get("model") for r in sources}
    if len(versions) != 1 or len(models) != 1:
        raise ValueError("实现或模型版本不同，请统一版本后比较")
    if len({r["position"]["id"] for r in sources}) != len(sources):
        raise ValueError("同一岗位 ID 出现多次，请明确使用哪个版本")
    jobs = []
    for source in sources:
        pos = source["position"]
        rows = pos["requirements"]
        quotes = {q["id"]: q["text"] for q in pos["jd_source"]["quotes"]}
        evidence = {e["id"]: e["text"] for e in pos["candidate_source"]["evidence"]}
        counts = Counter(r["conclusion"] for r in rows)
        jobs.append({
            "position_id": pos["id"], "title": pos["title"], "city": pos.get("city"),
            "decision": pos["decision"]["state"], "decision_label": STATES[pos["decision"]["state"]],
            "reason": pos["decision"]["reason"], "counts": dict(counts),
            "hard_pending": [r["requirement_id"] for r in rows if r["category"] == "hard_qualification" and r["conclusion"] == "pending"],
            "explicit_conflicts": [r["requirement_id"] for r in rows if r["category"] in {"hard_qualification", "core_capability"} and r["conclusion"] == "not_satisfied"],
            "source_url": pos["jd_source"]["url"], "provided_sha256": source["provided_sha256"],
            "source_identity_status": "caller_provided_not_officially_reverified",
            "requirements": [{**r, "jd_quotes": [quotes[q] for q in r["jd_quote_ids"]],
                              "candidate_evidence": [evidence[e] for e in r["candidate_evidence_ids"]]} for r in rows],
            "run_directory": source["directory"], "input_hashes": source["input_hashes"],
            "ignored_jd_lines": source["ignored_jd_lines"],
        })
    return {
        "schema_version": 1, "company": sources[0]["record"]["company"],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "mode": "read_only_comparison", "identity_basis": "exact_normalized_caller_provided_company",
        "corpus_sha256": next(iter(profiles)), "jobs": jobs, "constraints": dict(UNKNOWN),
        "source_sha256": next(iter(versions)), "model": next(iter(models)),
        "runtime_version_known": None not in versions and None not in models,
        "selected_position_id": None, "tracker_written": False, "submission_authorized": False,
        "semantic_accuracy_verified": False,
        "review_steps": [
            "先核对标题、正文和官方岗位身份；这里仅确认输入文本一致性。",
            "优先阅读明确不满足项与硬条件待核对项，再比较核心能力证据和个人兴趣。",
            "回到官方目录确认开放状态、批次、额度和志愿顺序；按当前求职档案核对选岗规则。",
            "由本人选定后，另按主表 preview → apply → 读回协议登记。",
        ],
        "limitation": "不排名、不预测录用概率；要求数量不同不能用满足数作为综合分。机械校验和覆盖审计不证明语义完全正确。",
    }


def _md(value) -> str:
    return html.escape(str(value), quote=False).replace("|", "&#124;").replace("\n", " ").replace("\r", " ")


def render_markdown(report: dict) -> str:
    lines = [f"# {_md(report['company'])}：岗位证据对照", "",
             "只读预览；按输入顺序展示，尚未选定岗位或写入投递表。", "",
             "额度、志愿顺序、当前开放状态和选岗规则核对：**未知 / 未完成**。", "",
             "| 岗位 | 地点 | 证据结论 | 硬条件待核对 | 明确不满足项 |",
             "|---|---|---|---|---|"]
    for job in report["jobs"]:
        lines.append(f"| {_md(job['title'])} | {_md(job['city'])} | {job['decision_label']} | {len(job['hard_pending'])} | {len(job['explicit_conflicts'])} |")
    lines += ["", report["limitation"], ""]
    for job in report["jobs"]:
        lines += [f"## {_md(job['title'])}", "", f"岗位 ID：{_md(job['position_id'])}",
                  "", _md(job["reason"]), "", f"输入来源：{_md(job['source_url'])}（未重新核验官网）", ""]
        for req in job["requirements"]:
            lines += [f"- **{_md(req['requirement_id'])} {_md(req['text'])}**：{CONCLUSIONS[req['conclusion']]}（{SUPPORTS[req['support']]}）",
                      f"  - JD：{_md(' '.join(req['jd_quotes']))}",
                      f"  - 证据：{_md(' '.join(req['candidate_evidence'])) or '没有相关证据'}",
                      f"  - 依据：{_md(req['judgment'])}", ""]
            if req.get("unverified_aspects"):
                lines += [f"  - 待补证据：{_md('；'.join(req['unverified_aspects']))}", ""]
        if job.get("ignored_jd_lines"):
            lines += ["### 被识别为背景或非要求的行（需复核）", ""]
            lines += [f"- 第 {item['line']} 行：{_md(item['text'])}；排除理由：{_md(item['reason'])}" for item in job["ignored_jd_lines"]]
            lines.append("")
    lines += ["## 选岗前待办", ""] + [f"- {step}" for step in report["review_steps"]]
    return "\n".join(lines) + "\n"


def save_comparison(report: dict, directory: Path) -> None:
    directory.mkdir(parents=True, exist_ok=False)
    write_json(directory / "comparison.json", report)
    (directory / "comparison.md").write_text(render_markdown(report), encoding="utf-8", newline="\n")
