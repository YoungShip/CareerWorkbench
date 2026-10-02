"""研究 Skill 的只读适配器：冻结来源、逐岗匹配、组装公司记录、交回原流程。"""

from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import AwareDatetime, Field, StrictBool, model_validator

from .compare import SUPPORTS, CONCLUSIONS, _md
from .privacy import redact
from .record import Job, publish, write_json
from .runtime import source_fingerprint
from .schemas import StrictModel
from .verifier import load_verifier
from .checkpoint import RunJournal, atomic_json, digest, engine_contract, run_lock

GATES = ("cohort", "employment_type", "city", "open_status", "application_limit",
         "preference_order", "change_or_withdraw", "deadline", "interview_format")
SHA = r"^[0-9a-f]{64}$"


class Snapshot(StrictModel):
    file: str = Field(min_length=1)
    sha256: str = Field(pattern=SHA)


class Source(Snapshot):
    url: str = Field(pattern=r"^https?://")
    read_at: AwareDatetime


class JDSource(Source):
    position_id: str = Field(min_length=1)


class Catalog(Snapshot):
    format: Literal["json", "csv", "tsv"]
    records_path: str | None = None
    id_path: str | None = None
    id_column: str | None = None
    encoding: str = "utf-8"
    total_positions: int = Field(strict=True, ge=1)


class ScopeEntry(StrictModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    city: str = ""
    in_scope: StrictBool
    exclusion: str | None = None

    @model_validator(mode="after")
    def needs_reason(self):
        if not self.in_scope and not (self.exclusion or "").strip():
            raise ValueError("范围外岗位须说明原因，不得用匹配差冒充范围外")
        return self


class Coverage(StrictModel):
    capture_status: Literal["complete", "partial", "unknown"]
    official_total: int | None = Field(default=None, strict=True, ge=1)
    last_page_reached: StrictBool = False
    human_attested: StrictBool = False
    note: str = Field(min_length=1)

    @model_validator(mode="after")
    def complete_has_evidence(self):
        if self.capture_status == "complete" and (not self.last_page_reached or self.official_total is None):
            raise ValueError("complete 需要官方总数和最后一页证据；程序不自动生成完整声明")
        return self


class Observation(StrictModel):
    topic: Literal["cohort", "employment_type", "city", "open_status", "application_limit",
                   "preference_order", "change_or_withdraw", "deadline", "interview_format"]
    position_ids: list[str] = Field(default_factory=list)
    text: str = Field(min_length=1)
    source: Source
    quote: str = Field(min_length=1)


class ResearchRequest(StrictModel):
    schema_version: Literal[1]
    company: str = Field(min_length=1)
    scope: str = Field(min_length=1)
    coverage: Coverage
    raw_catalog: Catalog
    catalog_index: list[ScopeEntry] = Field(min_length=1)
    jd_sources: list[JDSource] = Field(min_length=1, max_length=20)
    observations: list[Observation] = Field(default_factory=list, max_length=100)


def _bytes(source: Snapshot, base: Path) -> bytes:
    path = Path(source.file)
    path = path if path.is_absolute() else base / path
    data = path.read_bytes()
    if hashlib.sha256(data).hexdigest() != source.sha256:
        raise ValueError(f"来源哈希已变动：{path.name}；重新核对后再运行")
    return data


def inspect_request(path: Path, *, scripts_dir=None) -> tuple[ResearchRequest, dict]:
    """全部输入检查先于任何模型调用；未声明字段（包括用户选择）拒绝进入。"""
    request = ResearchRequest.model_validate_json(path.read_text(encoding="utf-8-sig"))
    catalog_bytes = _bytes(request.raw_catalog, path.parent)
    verifier = load_verifier(scripts_dir)
    issues = verifier.Issues()
    parsed = verifier.parse_catalog(request.raw_catalog.model_dump(exclude_none=True), path, issues)
    ids = [p.id for p in request.catalog_index]
    if parsed["status"] != "parsed" or len(ids) != len(set(ids)) or set(ids) != set(parsed["ids"]):
        raise ValueError("原始目录与索引 ID 不一致、重复或不可解析；不能猜测身份")
    selected = {p.id for p in request.catalog_index if p.in_scope}
    inputs = [j.position_id for j in request.jd_sources]
    if len(inputs) != len(set(inputs)) or set(inputs) != selected:
        raise ValueError("每个范围内岗位必须恰有一份完整 JD，不能遗漏或跨范围关联")
    if request.coverage.capture_status == "complete" and request.coverage.official_total != len(ids):
        raise ValueError("官方总数与目录数量不同；不能声明 complete")
    jds = {j.position_id: _bytes(j, path.parent) for j in request.jd_sources}
    if any(not data.decode("utf-8-sig").strip() for data in jds.values()):
        raise ValueError("JD 为空")
    observations = []
    for obs in request.observations:
        if not set(obs.position_ids) <= selected:
            raise ValueError("规则观察关联了未知或范围外岗位")
        data = _bytes(obs.source, path.parent)
        if verifier.normalize(obs.quote) not in verifier.normalize(data.decode("utf-8-sig")):
            raise ValueError("规则观察的引文不在所声明快照中")
        observations.append(data)
    return request, {"catalog": catalog_bytes, "jds": jds, "observations": observations}


def _freeze_research(request: ResearchRequest, inputs: dict, directory: Path, rules: dict, matcher):
    request = request.model_copy(deep=True)
    (directory / "inputs").mkdir()
    catalog_file = f"inputs/catalog.{request.raw_catalog.format}"
    (directory / catalog_file).write_bytes(inputs["catalog"])
    request.raw_catalog.file = catalog_file
    for n, source in enumerate(request.jd_sources, 1):
        source.file = f"inputs/jd-{n:03}.txt"
        (directory / source.file).write_bytes(inputs["jds"][source.position_id])
    for n, (obs, data) in enumerate(zip(request.observations, inputs["observations"]), 1):
        filename = f"inputs/observation-{n:03}.txt"
        (directory / filename).write_bytes(data)
        obs.source.file = filename
    write_json(directory / "research-request.json", request.model_dump(mode="json", exclude_none=True))
    write_json(directory / "current-rules.json", rules)
    matcher.corpus.write(directory)


def run_research(request_path: Path, directory: Path, matcher, rules: dict, *, resume=False,
                 retry_failed=False, stop_after=None) -> dict:
    directory = directory.resolve()
    if stop_after is not None and stop_after < 1:
        raise ValueError("stop_after 必须为正整数")
    if not resume:
        request, inputs = inspect_request(request_path, scripts_dir=matcher.scripts)
        if rules.get("read_only") is not True or not isinstance(rules.get("selection_rules"), str):
            raise ValueError("需要现行 tracker rules 只读输出；不能使用未知版本的规则摘要")
        directory.mkdir(parents=True, exist_ok=False)
    with run_lock(directory):
        if not resume:
            _freeze_research(request, inputs, directory, rules, matcher)
        frozen_request = directory / "research-request.json"
        request, inputs = inspect_request(frozen_request, scripts_dir=matcher.scripts)
        rules = json.loads((directory / "current-rules.json").read_text(encoding="utf-8"))
        model_name = getattr(getattr(matcher.llm, "config", None), "model", None)
        contract = {"engine": engine_contract(matcher, model_name),
                    "request_sha256": digest(request.model_dump(mode="json")),
                    "rules_sha256": digest(rules)}
        if not resume:
            write_json(directory / "manifest.json", {"checkpoint_schema_version": 1, "kind": "research",
                "variant": matcher.retriever.mode, "model": model_name,
                "source_sha256": contract["engine"]["source_sha256"]})
        journal = RunJournal(directory, "research", contract, [s.position_id for s in request.jd_sources], resume=resume)
        if not resume:
            journal.freeze([frozen_request, directory / "current-rules.json", directory / "manifest.json",
                            directory / "corpus.json", directory / "candidate-evidence.txt"] +
                           list((directory / "inputs").iterdir()))
        index = {p.id: p for p in request.catalog_index}
        completed = 0
        try:
            for n, source in enumerate(request.jd_sources):
                if journal.cached(n, retry_failed=retry_failed) is not None:
                    continue
                entry = index[source.position_id]
                target = journal.begin(n)
                context = [o.model_dump(mode="json") for o in request.observations
                           if o.topic in {"cohort", "employment_type", "city"}
                           and (not o.position_ids or entry.id in o.position_ids)]
                result = matcher.run(Job(entry.id, request.company, entry.title,
                    inputs["jds"][entry.id].decode("utf-8-sig"), entry.city, source.url, context), target)
                journal.finish(n, result)
                completed += 1
                print(f"[{n + 1}/{len(request.jd_sources)}] {entry.id}: verified={result['verification_passed']}", flush=True)
                if stop_after is not None and completed >= stop_after:
                    break
        finally:
            journal.finalize()
            atomic_json(directory / "job-results.json", journal.results())
        if len(journal.results()) != len(request.jd_sources):
            result = {"execution_status": "interrupted", "mechanical_passed": False, "jobs": journal.results(),
                      "readiness": {"can_register_selected_position": False},
                      "selected_position_id": None, "tracker_written": False,
                      "next_step": "使用resume恢复冻结批次；不会覆盖已完成岗位"}
            atomic_json(directory / "workflow-result.json", result)
            return result
        fingerprint = digest(journal.state["jobs"])
        cached = journal.publication(fingerprint)
        if cached is not None:
            return cached
        publication = 1
        while (directory / ("pipeline" if publication == 1 else f"pipeline-{publication:03}")).exists():
            publication += 1
        report = _publish_research(request, directory, matcher, journal, publication)
        frozen_report = directory / f"workflow-result-{publication:03}.json"
        write_json(frozen_report, report)
        report_file = directory / f"research-report-{publication:03}.md"
        atomic_json(directory / "workflow-result.json", report)
        journal.seal_publication(fingerprint, [frozen_report, report_file] +
                                 [p for p in Path(report["matching_file"]).parent.rglob("*") if p.is_file()], report,
                                 aliases=[directory / "workflow-result.json", directory / "research-report.md"])
        return report


def _publish_research(request, directory, matcher, journal, publication):
    index = {p.id: p for p in request.catalog_index}
    positions, jobs, extras = [], journal.results(), []
    for n, source in enumerate(request.jd_sources, 1):
        entry = index[source.position_id]
        target = journal.attempt_directory(n - 1)
        result = jobs[n - 1]
        result.update(position_id=entry.id, directory=str(target))
        if not result.get("verification_passed"):
            continue  # 保留缺失岗位，由公司级验证明确阻断，而不是转成 excluded。
        raw = json.loads((target / "matching-raw.json").read_text(encoding="utf-8"))
        pos = copy.deepcopy(raw["positions"][0])
        jd = pos["jd_source"]
        jd["processed_at"] = jd.pop("read_at")
        jd.pop("read_at_scope", None)
        jd["read_at"] = source.read_at.isoformat()
        jd["read_at_scope"] = "caller_captured_at_not_model_processing_time"
        jd["captured_bytes_sha256"] = source.sha256
        prefix = target.relative_to(directory).as_posix()
        for key in ("snapshot_file", "provided_snapshot_file", "preprocessing_file"):
            jd[key] = f"{prefix}/{jd[key]}"
        if jd.get("context_snapshot_file"):
            jd["context_snapshot_file"] = f"{prefix}/{jd['context_snapshot_file']}"
            extras.append(f"{prefix}/source-context.json")
        pos["candidate_source"]["snapshot_file"] = "candidate-evidence.txt"
        positions.append(pos)
        extras.extend(f"{prefix}/{name}" for name in ("jd-original.txt", "jd-preprocessing.json", "extraction-audit.json", "application-gates.json"))
    raw_record = {
        "schema_version": 2, "company": redact(request.company), "date": datetime.now(timezone.utc).date().isoformat(),
        "scope": redact(request.scope), "coverage": request.coverage.model_dump(exclude_none=True),
        "raw_catalog": request.raw_catalog.model_dump(exclude_none=True),
        "catalog_index": [e.model_dump(exclude_none=True) for e in request.catalog_index],
        "positions": positions,
    }
    # 不传 selected_position_id。是否选择、登记和提交仍由原 Skill 处理。
    raw_path = directory / ("company-matching-raw.json" if publication == 1 else f"company-matching-raw-{publication:03}.json")
    write_json(raw_path, raw_record)
    pipeline_dir = directory / ("pipeline" if publication == 1 else f"pipeline-{publication:03}")
    pipeline = publish(raw_path, matcher.scripts, pipeline_dir, extra_files=extras)
    verification = pipeline["assembled_verification"]
    readiness = verification.get("readiness", {})
    gates = {topic: {"status": "observed_needs_review" if any(o.topic == topic for o in request.observations) else "unknown"}
             for topic in GATES}
    obs_records = [o.model_dump(mode="json") | {"saved_snapshot": o.source.file,
        "status": "quote_matches_provided_snapshot_not_independent_official_verification"} for o in request.observations]
    report = {
        "execution_status": "completed" if all(j.get("verification_passed") for j in jobs) else "completed_with_failures",
        "request_sha256": hashlib.sha256((directory / "research-request.json").read_bytes()).hexdigest(),
        "company": request.company, "scope": request.scope, "source_sha256": source_fingerprint(),
        "corpus_version": matcher.corpus.version, "mechanical_passed": pipeline["mechanical_passed"],
        "coverage": verification.get("coverage"), "readiness": readiness,
        "human_summary": pipeline.get("human_summary"), "jobs": jobs, "gate_checks": gates, "observations": obs_records,
        "current_rules_sha256": hashlib.sha256((directory / "current-rules.json").read_bytes()).hexdigest(),
        "selection_rules_reviewed": False, "semantic_accuracy_verified": False,
        "selected_position_id": None, "tracker_written": False, "submission_authorized": False,
        "local_application_gates": [{"position_id": j["job_id"], "gates": j.get("local_application_gates", [])}
                                    for j in jobs if j.get("local_application_gates")],
        "local_application_gates_checked": all(j.get("local_application_gates_checked", True) for j in jobs),
        "matching_file": str(pipeline_dir / "assembled-matching.json"),
        "report_file": str(directory / f"research-report-{publication:03}.md"),
        "resumptions": journal.state["resumptions"],
        "rules_snapshot_scope": "frozen_at_batch_start",
        "frozen_at": journal.state["created_at"],
        "requires_current_rules_recheck": True,
        "next_step": "Skill核对来源、现行选岗规则及未知条件，展示等级/证据区间/缺口，等待本人选岗；不自动登记。",
    }
    rendered = render_research(report, raw_record)
    (directory / f"research-report-{publication:03}.md").write_text(rendered, encoding="utf-8", newline="\n")
    (directory / "research-report.md").write_text(rendered, encoding="utf-8", newline="\n")
    return report


def render_research(report: dict, record: dict) -> str:
    lines = [f"# {_md(report['company'])}：研究匹配结果", "", _md(report["scope"]), "",
        "**证据匹配度不是录用率。来源观察、岗位匹配与用户选择分别核对；本次未选岗、未登记。**", "",
        f"流程：{report['execution_status']}；机械校验：{report['mechanical_passed']}；全量比较就绪：{report['readiness'].get('can_generate_full_comparison', False)}。",
        "", "| 岗位 | S/A/B/C | 证据匹配度 | decision | 匹配记录允许登记 |", "|---|---|---|---|---|"]
    display = {p["id"]: p for p in (report.get("human_summary") or {}).get("positions", [])}
    for entry in record["catalog_index"]:
        if not entry["in_scope"]:
            continue
        item = display.get(entry["id"], {})
        registerable = entry["id"] in report["readiness"].get("registerable_position_ids", [])
        lines.append(f"| {_md(entry['title'])} | {item.get('grade', '不可用')} | {item.get('evidence_match_range', '未知')} | {item.get('decision', '运行失败/待修复')} | {'是，仍需本人选定及其他核查' if registerable else '否'} |")
    lines += ["", "## 必须交回 Skill 核对", "", "- 现行选岗规则已保存为 current-rules.json，尚未声明规则审阅完成。"]
    for topic, gate in report["gate_checks"].items():
        lines.append(f"- {topic}：{'已有快照引文，需核对适用范围' if gate['status'] != 'unknown' else '未知'}")
    for item in report.get("local_application_gates", []):
        lines.append(f"- {item['position_id']} 本地投前条件尚未核查：" + "；".join(g['condition_text'] for g in item['gates']))
    for obs in report["observations"]:
        lines += ["", f"- {_md(obs['topic'])} 观察：{_md(obs['text'])}", f"  - 原文：{_md(obs['quote'])}",
                  f"  - 来源：{_md(obs['source']['url'])}；时间：{_md(obs['source']['read_at'])}"]
    for pos in record["positions"]:
        lines += ["", f"## {_md(pos['title'])}", "", _md(pos["decision"]["reason"]), ""]
        quotes = {q["id"]: q["text"] for q in pos["jd_source"]["quotes"]}
        evidence = {e["id"]: e["text"] for e in pos["candidate_source"]["evidence"]}
        for req in pos["requirements"]:
            lines += [f"- **{_md(req['text'])}**：{CONCLUSIONS[req['conclusion']]}（{SUPPORTS[req['support']]}）",
                f"  - JD：{_md(' '.join(quotes[q] for q in req['jd_quote_ids']))}",
                f"  - 证据：{_md(' '.join(evidence[e] for e in req['candidate_evidence_ids'])) or '未找到相关证据'}",
                f"  - 依据：{_md(req['judgment'])}"]
            if req.get("unverified_aspects"):
                lines.append(f"  - 必要部分未核实：{_md('；'.join(req['unverified_aspects']))}")
    return "\n".join(lines) + "\n"
