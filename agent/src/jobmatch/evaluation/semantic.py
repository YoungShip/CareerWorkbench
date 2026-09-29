"""有明确原文与预期的语义回归；通过表示这些断言通过，不估计总体准确率。"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ..corpus import Chunk, Corpus
from ..graph import Matcher
from ..record import Job, write_json
from ..retrieval import Retriever
from ..checkpoint import digest as payload_digest, RunJournal, engine_contract, atomic_json, run_lock

PROVENANCE_KINDS = {"synthetic", "assistant_reviewed", "user_confirmed"}


def load_cases(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    if data.get("schema_version") != 1 or data.get("provenance", {}).get("kind") not in PROVENANCE_KINDS:
        raise ValueError("语义案例必须说明版本及来源类别")
    cases = data.get("cases", [])
    if not 1 <= len(cases) <= 10 or len({c["id"] for c in cases}) != len(cases):
        raise ValueError("每轮须有 1–10 个唯一案例")
    for case in cases:
        if not case.get("jd") or not case.get("evidence") or not case.get("assertions") or not case.get("rationale"):
            raise ValueError("案例须包含原文、候选事实、断言和预期依据")
        if any(a.get("jd_contains", "") not in case["jd"] or not a.get("jd_contains") for a in case["assertions"]):
            raise ValueError("断言必须锚定 JD 中的真实片段")
        evidence_ids = {e["id"] for e in case["evidence"]}
        if len(evidence_ids) != len(case["evidence"]):
            raise ValueError("案例证据ID重复")
        for assertion in case["assertions"]:
            if not any(assertion.get(k) for k in ("conclusions", "supports", "categories")):
                raise ValueError("语义断言须有明确预期，不仅检查引文存在")
            if not set(assertion.get("required_evidence_ids", [])) <= evidence_ids:
                raise ValueError("预期证据ID不在给定事实中")
    identifiers = {c["id"] for c in cases}
    pairs = data.get("pairs", [])
    if len({p["id"] for p in pairs}) != len(pairs):
        raise ValueError("反事实配对ID重复")
    for pair in data.get("pairs", []):
        if type(pair.get("decision_should_change")) is not bool:
            raise ValueError("成对变化预期必须为布尔值")
        if pair["before"] == pair["after"] or not {pair["before"], pair["after"]} <= identifiers:
            raise ValueError("反事实配对必须引用两个不同的有效案例")
    return data


def check_case(case: dict, result: dict, record: dict | None) -> dict:
    errors, categories, details = [], [], []
    covered, total_requirements = set(), 0
    def fail(message, code):
        errors.append(message)
        categories.append(code)
    if not result.get("verification_passed") or not record:
        fail("没有通过机械校验的匹配结果", "mechanical_or_execution_failure")
    else:
        pos = record["positions"][0]
        total_requirements = len(pos["requirements"])
        quotes = {q["id"]: q["text"] for q in pos["jd_source"]["quotes"]}
        for assertion_index, assertion in enumerate(case["assertions"], 1):
            start = len(errors)
            matching = [(i, r) for i, r in enumerate(pos["requirements"]) if assertion["jd_contains"] in
                        "".join(quotes.get(q, "") for q in r["jd_quote_ids"])
                        and (not assertion.get("requirement_contains") or assertion["requirement_contains"] in r["text"])]
            if not matching:
                fail(f"未提取或未定位到要求：{assertion['jd_contains']}", "missing_requirement")
            for index, req in matching:
                covered.add(index)
                for field, allowed_key in (("conclusion", "conclusions"), ("support", "supports"), ("category", "categories")):
                    if allowed_key in assertion and req[field] not in assertion[allowed_key]:
                        code = ("false_satisfied" if req[field] == "satisfied" else "false_not_satisfied" if req[field] == "not_satisfied"
                                else "wrong_conclusion") if field == "conclusion" else f"wrong_{field}"
                        fail(f"{assertion['jd_contains']} / {field}={req[field]}，预期 {assertion[allowed_key]}", code)
                ids = set(req.get("candidate_evidence_ids", []))
                if not set(assertion.get("required_evidence_ids", [])) <= ids:
                    fail(f"{assertion['jd_contains']} 未引用预期的关键事实", "missing_expected_evidence")
                if ids & set(assertion.get("forbidden_evidence_ids", [])):
                    fail(f"{assertion['jd_contains']} 引用了不应支持该判断的事实", "irrelevant_evidence")
            details.append({"assertion": assertion_index, "anchor": assertion["jd_contains"], "passed": len(errors) == start,
                            "matched_requirements": [r.get("requirement_id", f"row-{i + 1}") for i, r in matching]})
        if case.get("decisions") and result.get("decision") not in case["decisions"]:
            fail(f"汇总 {result.get('decision')} 不在预期 {case['decisions']}", "wrong_decision")
        if case.get("max_requirements") is not None and total_requirements > case["max_requirements"]:
            fail("提取了超过本例预期数量的要求，检查是否把附加指令/背景当作要求", "unexpected_requirements")
    return {"case_id": case["id"], "passed": not errors, "errors": errors,
            "error_categories": categories, "assertions": details,
            "assertions_total": len(case["assertions"]), "assertions_passed": sum(d["passed"] for d in details),
            "requirements_total": total_requirements, "requirements_checked": len(covered),
            "unasserted_requirements": total_requirements - len(covered),
            "expected_basis": case["rationale"], "verification_passed": bool(result.get("verification_passed")),
            "decision": result.get("decision")}


def case_corpus(case):
    # 案例ID、预期、理由、来源文件名可能透露答案，只把中性来源标识送给模型。
    return Corpus([Chunk(c["id"], c["kind"], c["text"], "provided-evidence") for c in case["evidence"]])


def run_semantic(case_file: Path, directory: Path, llm_factory, scripts_dir: Path, *, model_name: str,
                 resume=False, retry_failed=False, stop_after=None) -> dict:
    directory = directory.resolve()
    if stop_after is not None and stop_after < 1:
        raise ValueError("stop_after 必须为正整数")
    if not resume:
        data = load_cases(case_file)
        directory.mkdir(parents=True, exist_ok=False)
    with run_lock(directory):
        if not resume:
            write_json(directory / "cases.json", data)
        data = load_cases(directory / "cases.json")
        corpus = case_corpus(data["cases"][0])
        probe = llm_factory()
        try:
            engine = engine_contract(Matcher(probe, Retriever(corpus, "full"), corpus, scripts_dir), model_name)
        finally:
            if hasattr(probe, "client"):
                probe.client.close()
        contract = {"engine": engine, "dataset_sha256": payload_digest(data)}
        if not resume:
            write_json(directory / "manifest.json", {"checkpoint_schema_version": 1, "kind": "semantic",
                "model": model_name, "variant": "full", "source_sha256": engine["source_sha256"],
                "runtime": engine["runtime"], "model_settings_sha256": engine["model_settings_sha256"],
                "case_file_sha256": hashlib.sha256(case_file.read_bytes()).hexdigest(), "provenance": data["provenance"],
                "dataset_sha256": payload_digest(data), "expectations_sent_to_model": False,
                "case_source_names_sent_to_model": False})
        journal = RunJournal(directory, "semantic", contract, [c["id"] for c in data["cases"]], resume=resume)
        if not resume:
            journal.freeze([directory / "cases.json", directory / "manifest.json"])
        completed = 0
        try:
            for index, case in enumerate(data["cases"]):
                if journal.cached(index, retry_failed=retry_failed) is not None:
                    continue
                target = journal.begin(index)
                corpus = case_corpus(case)
                llm = llm_factory()
                try:
                    matcher = Matcher(llm, Retriever(corpus, "full"), corpus, scripts_dir)
                    result = matcher.run(Job(case["id"], case.get("company", "合成案例公司"), case["title"], case["jd"],
                                         case.get("city", ""), case.get("url", "")), target)
                finally:
                    if hasattr(llm, "client"):
                        llm.client.close()
                path = target / "pipeline/assembled-matching.json"
                record = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None
                check = check_case(case, result, record)
                write_json(target / "semantic-check.json", check)
                journal.finish(index, {**result, "semantic_check": check})
                completed += 1
                print(f"[{index + 1}/{len(data['cases'])}] {case['id']}: semantic_assertions={check['passed']}", flush=True)
                if stop_after is not None and completed >= stop_after:
                    break
        finally:
            journal.finalize()
            checks = [r["semantic_check"] for r in journal.results()]
            if len(checks) != len(data["cases"]):
                atomic_json(directory / "semantic-report.json", semantic_report(data, checks))
        checks = [r["semantic_check"] for r in journal.results()]
        if len(checks) != len(data["cases"]):
            return semantic_report(data, checks)
        fingerprint = payload_digest(journal.state["jobs"])
        cached = journal.publication(fingerprint)
        if cached is not None:
            return cached
        report = semantic_report(data, checks)
        report["recovery"] = {"prior_failed_attempts": sum(r["prior_failures"] for r in journal.results()),
                              "interrupted_attempts": sum(r["interrupted_attempts"] for r in journal.results())}
        number = len(journal.state["publications"]) + 1
        target = directory / f"semantic-report-{number:03}.json"
        while target.exists():
            number += 1
            target = directory / f"semantic-report-{number:03}.json"
        write_json(target, report)
        atomic_json(directory / "semantic-report.json", report)
        journal.seal_publication(fingerprint, [target], report, aliases=[directory / "semantic-report.json"])
        return report


def semantic_report(data: dict, checks: list[dict]) -> dict:
    from collections import Counter
    by_id = {c["case_id"]: c for c in checks}
    pairs = []
    for pair in data.get("pairs", []):
        if pair["before"] not in by_id or pair["after"] not in by_id:
            pairs.append({"id": pair["id"], "passed": False, "status": "incomplete"})
            continue
        before, after = by_id[pair["before"]], by_id[pair["after"]]
        changed = before["decision"] != after["decision"]
        passed = before["passed"] and after["passed"] and changed == pair["decision_should_change"]
        pairs.append({"id": pair["id"], "passed": passed, "before": before["decision"], "after": after["decision"],
                      "expected_change": pair["decision_should_change"]})
    report = {"provenance": data["provenance"], "total": len(data["cases"]), "passed": sum(c["passed"] for c in checks),
              "execution_status": "completed" if len(checks) == len(data["cases"]) else "interrupted",
              "completed_cases": len(checks),
              "assertions_total": sum(len(c["assertions"]) for c in data["cases"]),
              "assertions_passed": sum(c["assertions_passed"] for c in checks),
              "unasserted_requirements": sum(c["unasserted_requirements"] for c in checks),
              "error_categories": dict(Counter(code for c in checks for code in c["error_categories"])),
              "pairs": pairs, "pairs_passed": sum(p["passed"] for p in pairs),
              "checks": checks, "population_accuracy": None,
              "limitation": "只验证已列明的案例断言；非完整人工审计，不推算真实岗位总体准确率。"}
    return report


def semantic_success(report: dict) -> bool:
    return (report.get("total", 0) > 0 and report.get("passed") == report["total"]
            and all(pair["passed"] for pair in report.get("pairs", [])))


def compare_semantic(before: Path, after: Path) -> dict:
    manifests = [json.loads((p / "manifest.json").read_text(encoding="utf-8")) for p in (before, after)]
    if not manifests[0].get("dataset_sha256") or manifests[0]["dataset_sha256"] != manifests[1].get("dataset_sha256"):
        raise ValueError("语义评测集或断言不同，不能直接比较分数")
    reports = [json.loads((p / "semantic-report.json").read_text(encoding="utf-8")) for p in (before, after)]
    rows = [{c["case_id"]: c for c in report["checks"]} for report in reports]
    for directory, manifest, report, mapped in zip((before, after), manifests, reports, rows):
        dataset = json.loads((directory / "cases.json").read_text(encoding="utf-8"))
        if payload_digest(dataset) != manifest["dataset_sha256"]:
            raise ValueError("冻结案例文件已经变动，拒绝比较")
        if len(mapped) != len(report["checks"]) or set(mapped) != {c["id"] for c in dataset["cases"]}:
            raise ValueError("语义运行未完成全部案例或结果重复，不能比较为完整基准")
    if set(rows[0]) != set(rows[1]):
        raise ValueError("案例集合不一致")
    pairs = [{p["id"]: p["passed"] for p in r.get("pairs", [])} for r in reports]
    if set(pairs[0]) != set(pairs[1]):
        raise ValueError("成对检查集合不一致")
    return {"dataset_sha256": manifests[0]["dataset_sha256"],
            "changed_factors": [key for key in ("source_sha256", "model", "variant", "runtime", "model_settings_sha256") if manifests[0].get(key) != manifests[1].get(key)],
            "untracked_factors": [key for key in ("runtime", "model_settings_sha256") if any(key not in m for m in manifests)],
            "regressions": [i for i in rows[0] if rows[0][i]["passed"] and not rows[1][i]["passed"]],
            "improvements": [i for i in rows[0] if not rows[0][i]["passed"] and rows[1][i]["passed"]],
            "unchanged_failures": [i for i in rows[0] if not rows[0][i]["passed"] and not rows[1][i]["passed"]],
            "pair_regressions": [i for i in pairs[0] if pairs[0][i] and not pairs[1][i]],
            "pair_improvements": [i for i in pairs[0] if not pairs[0][i] and pairs[1][i]],
            "before_passed": reports[0]["passed"], "after_passed": reports[1]["passed"],
            "limitation": "只比较同一冻结基准；多个因素同时变化时不能归因于某一项，也不能外推总体准确率。"}
