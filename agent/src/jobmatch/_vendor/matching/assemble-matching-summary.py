"""Derive requirement_summary without changing semantic matching fields.

This adapter only validates requirement fields and replaces the derived
requirement_summary. It never changes requirements, evidence, support,
conclusion, decision, exclusion_reason, or coverage.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
from pathlib import Path
from typing import Any

VERIFIER_SPEC = importlib.util.spec_from_file_location(
    "matching_verifier", Path(__file__).with_name("verify-matching.py")
)
if VERIFIER_SPEC is None or VERIFIER_SPEC.loader is None:
    raise ImportError("cannot load verify-matching.py")
VERIFIER = importlib.util.module_from_spec(VERIFIER_SPEC)
VERIFIER_SPEC.loader.exec_module(VERIFIER)
summary = VERIFIER.summary


CATEGORIES = {"hard_qualification", "core_capability", "plus", "ambiguous"}
SUPPORTS = {"direct_support", "transferable", "no_evidence", "conflict"}
CONCLUSIONS = {"satisfied", "not_satisfied", "pending"}
REQUIRED_REQUIREMENT_FIELDS = {
    "requirement_id",
    "text",
    "category",
    "category_basis_quote_ids",
    "jd_quote_ids",
    "candidate_evidence_ids",
    "support",
    "conclusion",
    "judgment",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--diagnostics", type=Path, required=True)
    parser.add_argument("--diff", type=Path, required=True)
    return parser.parse_args()


def read_json(path: Path) -> tuple[Any | None, list[str]]:
    try:
        text = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError as exc:
        return None, [f"INPUT_UTF8_INVALID: {exc}"]
    try:
        return json.loads(text), []
    except json.JSONDecodeError as exc:
        return None, [f"INPUT_JSON_INVALID: {exc}"]


def validate_requirements(position: Any, position_index: int) -> list[str]:
    prefix = f"positions[{position_index}]"
    if not isinstance(position, dict):
        return [f"{prefix}: POSITION_NOT_OBJECT"]
    requirements = position.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        return [f"{prefix}.requirements: REQUIREMENTS_MISSING_OR_EMPTY"]
    errors: list[str] = []
    seen_ids: set[str] = set()
    for index, requirement in enumerate(requirements):
        path = f"{prefix}.requirements[{index}]"
        if not isinstance(requirement, dict):
            errors.append(f"{path}: REQUIREMENT_NOT_OBJECT")
            continue
        missing = sorted(REQUIRED_REQUIREMENT_FIELDS - set(requirement))
        if missing:
            errors.append(f"{path}: REQUIREMENT_FIELDS_MISSING={','.join(missing)}")
        requirement_id = requirement.get("requirement_id")
        if not isinstance(requirement_id, str) or not requirement_id.strip():
            errors.append(f"{path}.requirement_id: REQUIREMENT_ID_INVALID")
        elif requirement_id in seen_ids:
            errors.append(f"{path}.requirement_id: REQUIREMENT_ID_DUPLICATE")
        else:
            seen_ids.add(requirement_id)
        if not isinstance(requirement.get("text"), str) or not requirement.get("text", "").strip():
            errors.append(f"{path}.text: REQUIREMENT_TEXT_INVALID")
        category = requirement.get("category")
        if not isinstance(category, str) or category not in CATEGORIES:
            errors.append(f"{path}.category: REQUIREMENT_CATEGORY_INVALID")
        support = requirement.get("support")
        if not isinstance(support, str) or support not in SUPPORTS:
            errors.append(f"{path}.support: REQUIREMENT_SUPPORT_INVALID")
        conclusion = requirement.get("conclusion")
        if not isinstance(conclusion, str) or conclusion not in CONCLUSIONS:
            errors.append(f"{path}.conclusion: REQUIREMENT_CONCLUSION_INVALID")
    return errors


def assemble_detailed(record: Any) -> tuple[Any, list[str], list[str], list[dict[str, Any]]]:
    if not isinstance(record, dict):
        return record, ["ROOT_NOT_OBJECT"], [], []
    positions = record.get("positions")
    if not isinstance(positions, list):
        return record, ["POSITIONS_NOT_ARRAY"], [], []
    errors: list[str] = []
    for index, position in enumerate(positions):
        errors.extend(validate_requirements(position, index))
    if errors:
        return record, errors, [], []

    assembled = json.loads(json.dumps(record, ensure_ascii=False))
    changed_paths: list[str] = []
    summary_diagnostics: list[dict[str, Any]] = []
    for index, position in enumerate(assembled["positions"]):
        expected = summary(position["requirements"])
        supplied = position.get("requirement_summary")
        if not isinstance(supplied, dict):
            changed_paths.append(f"positions[{index}].requirement_summary")
            summary_diagnostics.append(
                {
                    "path": f"positions[{index}].requirement_summary",
                    "reason": "derived summary missing or has invalid container type; rebuilt from requirements",
                    "old_type": type(supplied).__name__,
                    "strategy": "rebuild_derived_field",
                }
            )
            position["requirement_summary"] = expected
            continue
        # 逐字段无条件核对，不能先比较整体相等再检查类型：
        # Python 中 False == 0、True == 1，若只把数值 0/1 换成等值布尔，
        # supplied != expected 会判定为相等而整体跳过，布尔计数就被静默保留。
        for field in expected:
            actual = supplied.get(field)
            if type(actual) is not int or actual != expected[field]:
                changed_paths.append(f"positions[{index}].requirement_summary.{field}")
                summary_diagnostics.append(
                    {
                        "path": f"positions[{index}].requirement_summary.{field}",
                        "reason": "derived count missing, wrong type, or wrong value; rebuilt from requirements",
                        "old_type": type(actual).__name__,
                        "old_value": actual,
                        "expected_value": expected[field],
                        "strategy": "replace_derived_field",
                    }
                )
        # 始终以从 requirements 重建的计数为准，保留其余字段差异与原始记录
        position["requirement_summary"] = expected
    return assembled, [], changed_paths, summary_diagnostics


def assemble(record: Any) -> tuple[Any, list[str], list[str]]:
    assembled, errors, changed_paths, _ = assemble_detailed(record)
    return assembled, errors, changed_paths


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main() -> int:
    args = parse_args()
    record, read_errors = read_json(args.input)
    if read_errors:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(args.input, args.output)
        write_json(args.diagnostics, {"status": "failed", "errors": read_errors, "changed_paths": []})
        write_json(args.diff, {"changed_paths": [], "status": "failed"})
        return 1

    assembled, errors, changed_paths, summary_diagnostics = assemble_detailed(record)
    if errors:
        shutil.copyfile(args.input, args.output)
        write_json(
            args.diagnostics,
            {
                "status": "failed",
                "errors": errors,
                "changed_paths": [],
                "summary_diagnostics": [],
            },
        )
        write_json(args.diff, {"changed_paths": [], "status": "failed"})
        return 1

    write_json(args.output, assembled)
    write_json(
        args.diagnostics,
        {
            "status": "assembled",
            "errors": [],
            "changed_paths": changed_paths,
            "summary_diagnostics": summary_diagnostics,
            "derived_fields_only": True,
            "semantic_fields_changed": [],
        },
    )
    write_json(args.diff, {"changed_paths": changed_paths, "status": "assembled"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
