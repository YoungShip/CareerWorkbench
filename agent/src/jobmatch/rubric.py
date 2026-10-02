"""Narrow semantic guards for demonstrated judgment errors; not an accuracy proof."""
from __future__ import annotations

import re

_UNSOURCED_QUALIFIERS = (
    (re.compile(r"独立|自主|手写|脱离\s*AI|不借助\s*AI", re.I), "独立/手写/脱离 AI"),
    (re.compile(r"企业级|大规模|量产|生产环境|高并发|高可用"), "规模或生产级经验"),
)


def rubric_issues(requirements: list[dict], judgments: list[dict], clauses: list[str]) -> list[dict]:
    issues = []
    by_id = {j["requirement_id"]: j for j in judgments}
    for number, requirement in enumerate(requirements, 1):
        rid = f"R{number}"
        judgment = by_id[rid]
        category = judgment.get("category") or requirement["category"]
        source = requirement["text"] + "\n" + "\n".join(clauses[n - 1] for n in requirement["jd_lines"])
        gaps = judgment.get("unverified_aspects") or []
        explanation = judgment.get("judgment", "") + "\n" + "\n".join(gaps)
        if category == "hard_qualification" and re.search(r"专业|背景", source) and re.search(r"相关|等", source) and re.search(r"官方.{0,4}专业目录|专业名称.{0,5}(?:完全|一致|相同)|专业.{0,5}全称", explanation):
            issues.append({"code": "UNSOURCED_EXACT_MAJOR_GATE", "requirement_id": rid,
                "message": "开放的等/相关专业要求没有规定专业名称逐字相同或官方专业目录。按真实学历、专业及相关课程/研究重判；不同学科或缺少实际相关性仍保留 pending，不能自动判通过。"})
        for pattern, label in _UNSOURCED_QUALIFIERS:
            invented = [gap for gap in gaps if pattern.search(gap)]
            if invented and not pattern.search(source):
                issues.append({"code": "UNSOURCED_EXPERIENCE_QUALIFIER", "requirement_id": rid,
                    "message": f"缺口增加了原要求及其引文没有的{label}门槛：{invented}。删去额外门槛，按 JD 实际层次重判；不能删去原文已有的技术要求。"})
        # 直接做过同一种实践、仅 JD 明写的丰富/熟练程度待面试核实，
        # 不等于复合要求中缺失了另一种必要技术；仍保留 pending，不能升级满足。
        degree_only = bool(gaps) and all(
            re.search(r"JD所称|JD.{0,6}(?:丰富|熟练|精通)|原文.{0,6}(?:丰富|熟练|精通)", gap)
            and any(word in source for word in ("丰富", "熟练", "精通")) for gap in gaps)
        if category == "core_capability" and judgment["support"] == "direct_support" and judgment["conclusion"] == "pending" and gaps and not degree_only:
            issues.append({"code": "PARTIAL_COVERAGE_MARKED_DIRECT", "requirement_id": rid,
                "message": "已列出未覆盖的必要部分，却把整条核心能力标为直接覆盖。按实际证据范围选 transferable/no_evidence，或明确该项为何已直接覆盖并纠正非必要缺口；不得为了通过而删除真实缺口。"})
    return issues
