from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any


SCRIPT = Path(__file__).with_name("verify-matching.py")

ALLOWED_SUPPORT_CONCLUSIONS = (
    ("direct_support", "satisfied"),
    ("direct_support", "pending"),
    ("transferable", "pending"),
    ("no_evidence", "pending"),
    ("conflict", "pending"),
    ("conflict", "not_satisfied"),
)


def expected_decision_for_combination(hard, core_a, core_b):
    """Independent test contract; deliberately does not call production code."""
    hard_pending = hard == ("transferable", "pending") or hard == ("direct_support", "pending") or hard == ("no_evidence", "pending") or hard == ("conflict", "pending")
    hard_failed = hard == ("conflict", "not_satisfied")
    cores = (core_a, core_b)
    core_failed = any(support == "conflict" and conclusion == "not_satisfied" for support, conclusion in cores)
    core_pending = [pair for pair in cores if pair[1] == "pending"]
    if hard == ("direct_support", "satisfied") and all(pair == ("direct_support", "satisfied") for pair in cores):
        return "recommended"
    if not hard_pending and not hard_failed and not core_failed and core_pending and all(support == "transferable" for support, _ in core_pending):
        return "consider"
    return "pending"


def apply_requirement_pair(requirement, pair, evidence_id):
    support, conclusion = pair
    requirement["support"] = support
    requirement["conclusion"] = conclusion
    requirement["candidate_evidence_ids"] = [] if support == "no_evidence" else [evidence_id]


class Fixture:
    """Temporary directory plus its mutable JSON record."""

    def __init__(self, temp: tempfile.TemporaryDirectory[str], path: Path, record: dict[str, Any]):
        self._temp = temp
        self.path = path
        self.record = record

    def __truediv__(self, value: str) -> Path:
        return self.path / value


def summary_for(requirements: list[dict[str, Any]]) -> dict[str, int]:
    categories = {key: 0 for key in ("hard_qualification", "core_capability", "plus", "ambiguous")}
    supports = {key: 0 for key in ("direct_support", "transferable", "no_evidence", "conflict")}
    conclusions = {key: 0 for key in ("satisfied", "not_satisfied", "pending")}
    for requirement in requirements:
        categories[requirement["category"]] += 1
        supports[requirement["support"]] += 1
        conclusions[requirement["conclusion"]] += 1
    return {
        "requirements_total": len(requirements),
        **categories,
        "core_total": categories["hard_qualification"] + categories["core_capability"],
        **supports,
        **conclusions,
    }


def write_fixture_source(root: Path, role_id: str) -> None:
    (root / f"{role_id}-jd.txt").write_text(
        "本科或以上学历。\n独立完成自动化测试。\n有相关行业经验。\n", encoding="utf-8"
    )
    (root / f"{role_id}-candidate.txt").write_text(
        "已取得本科或以上学历。\n独立维护自动化测试。\n", encoding="utf-8"
    )


def valid_position(role_id: str = "role-1") -> dict[str, Any]:
    requirements = [
        {
            "requirement_id": f"{role_id}-req-1",
            "text": "本科或以上学历",
            "category": "hard_qualification",
            "category_basis_quote_ids": ["jd-q1"],
            "jd_quote_ids": ["jd-q1"],
            "candidate_evidence_ids": ["ev-1"],
            "support": "direct_support",
            "conclusion": "satisfied",
            "judgment": "候选人证据直接覆盖该学历要求。",
        },
        {
            "requirement_id": f"{role_id}-req-2",
            "text": "独立完成自动化测试",
            "category": "core_capability",
            "category_basis_quote_ids": ["jd-q2"],
            "jd_quote_ids": ["jd-q2"],
            "candidate_evidence_ids": ["ev-2"],
            "support": "direct_support",
            "conclusion": "satisfied",
            "judgment": "候选人证据直接覆盖自动化测试能力。",
        },
        {
            "requirement_id": f"{role_id}-req-3",
            "text": "有相关行业经验",
            "category": "plus",
            "category_basis_quote_ids": ["jd-q3"],
            "jd_quote_ids": ["jd-q3"],
            "candidate_evidence_ids": [],
            "support": "no_evidence",
            "conclusion": "pending",
            "judgment": "档案中没有该加分项的直接证据，暂不据此排除。",
        },
    ]
    return {
        "id": role_id,
        "title": "Fixture QA Engineer",
        "city": "Fixture City",
        "jd_source": {
            "position_id": role_id,
            "url": "https://example.invalid/jobs/fixture-qa",
            "read_at": "2026-01-01T00:00:00Z",
            "snapshot_file": f"{role_id}-jd.txt",
            "quotes": [
                {"id": "jd-q1", "text": "本科或以上学历。", "locator": {"line_start": 1, "line_end": 1}},
                {"id": "jd-q2", "text": "独立完成自动化测试。", "locator": {"line_start": 2, "line_end": 2}},
                {"id": "jd-q3", "text": "有相关行业经验。", "locator": {"line_start": 3, "line_end": 3}},
            ],
        },
        "candidate_source": {
            "profile_version": "fixture-profile-v1",
            "snapshot_file": f"{role_id}-candidate.txt",
            "evidence": [
                {"id": "ev-1", "text": "已取得本科或以上学历。", "locator": {"line_start": 1, "line_end": 1}},
                {"id": "ev-2", "text": "独立维护自动化测试。", "locator": {"line_start": 2, "line_end": 2}},
            ],
        },
        "requirements": requirements,
        "requirement_summary": summary_for(requirements),
        "decision": {
            "state": "recommended",
            "basis": "requirement_summary",
            "reason": "硬资格和核心能力均有直接证据，加分项缺证据但不构成排除。",
        },
    }


def valid_record(root: Path, role_ids: tuple[str, ...] = ("role-1",)) -> dict[str, Any]:
    for role_id in role_ids:
        write_fixture_source(root, role_id)
    raw = [{"id": role_id, "title": "Fixture QA Engineer"} for role_id in role_ids]
    (root / "catalog.json").write_text(json.dumps(raw), encoding="utf-8")
    return {
        "schema_version": 2,
        "company": "Fixture Company",
        "date": "2026-01-01",
        "scope": "Fictional fixture only",
        "selected_position_id": "role-1",
        "coverage": {
            "capture_status": "complete",
            "official_total": len(role_ids),
            "last_page_reached": True,
            "human_attested": True,
        },
        "raw_catalog": {
            "file": "catalog.json",
            "format": "json",
            "records_path": "",
            "id_path": "/id",
            "total_positions": len(role_ids),
        },
        "catalog_index": [
            {"id": role_id, "title": "Fixture QA Engineer", "city": "Fixture City", "in_scope": True}
            for role_id in role_ids
        ],
        "positions": [valid_position(role_id) for role_id in role_ids],
    }


def vla_record(root: Path) -> dict[str, Any]:
    (root / "catalog.json").write_text('[{"id":"vla-role"}]', encoding="utf-8")
    (root / "vla-jd.txt").write_text("独立完成 VLA 训练。\n", encoding="utf-8")
    (root / "vla-candidate.txt").write_text("运行开源 VLA 推理。\n", encoding="utf-8")
    requirements = [{
        "requirement_id": "vla-role-req-1",
        "text": "独立完成 VLA 训练",
        "category": "core_capability",
        "category_basis_quote_ids": ["jd-vla"],
        "jd_quote_ids": ["jd-vla"],
        "candidate_evidence_ids": ["ev-vla"],
        "support": "transferable",
        "conclusion": "pending",
        "judgment": "运行开源 VLA 推理不能证明独立完成 VLA 训练。",
    }]
    return {
        "schema_version": 2,
        "company": "Fixture Robotics",
        "date": "2026-01-01",
        "scope": "Fictional semantic fixture",
        "selected_position_id": "vla-role",
        "coverage": {"capture_status": "complete", "official_total": 1, "last_page_reached": True, "human_attested": True},
        "raw_catalog": {"file": "catalog.json", "format": "json", "records_path": "", "id_path": "/id", "total_positions": 1},
        "catalog_index": [{"id": "vla-role", "title": "VLA Engineer", "city": "Fixture City", "in_scope": True}],
        "positions": [{
            "id": "vla-role",
            "title": "VLA Engineer",
            "city": "Fixture City",
            "jd_source": {
                "position_id": "vla-role",
                "url": "https://example.invalid/jobs/vla-role",
                "read_at": "2026-01-01T00:00:00Z",
                "snapshot_file": "vla-jd.txt",
                "quotes": [{"id": "jd-vla", "text": "独立完成 VLA 训练。", "locator": {"line_start": 1, "line_end": 1}}],
            },
            "candidate_source": {
                "profile_version": "fixture-profile-vla-v1",
                "snapshot_file": "vla-candidate.txt",
                "evidence": [{"id": "ev-vla", "text": "运行开源 VLA 推理。", "locator": {"line_start": 1, "line_end": 1}}],
            },
            "requirements": requirements,
            "requirement_summary": summary_for(requirements),
            "decision": {"state": "consider", "basis": "requirement_summary", "reason": "核心训练能力有可迁移证据，允许用户考虑尝试性申请。"},
        }],
    }


def run_validator(root: Fixture, expected_exit: int | None = None) -> dict[str, Any]:
    path = root / "matching.json"
    path.write_text(json.dumps(root.record, ensure_ascii=False, indent=2), encoding="utf-8")
    result = subprocess.run(
        [sys.executable, "-X", "utf8", str(SCRIPT), str(path)],
        capture_output=True,
    )
    if expected_exit is not None and result.returncode != expected_exit:
        raise AssertionError(result.stdout.decode("utf-8", errors="replace") + result.stderr.decode("utf-8", errors="replace"))
    if not result.stdout.strip():
        raise AssertionError(result.stderr.decode("utf-8", errors="replace"))
    return json.loads(result.stdout.decode("utf-8"))


class MatchingValidatorTests(unittest.TestCase):
    def with_record(self, builder=valid_record):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        return Fixture(temp, root, builder(root))

    def test_valid_new_record_is_mechanically_consistent(self):
        report = run_validator(self.with_record(), 0)
        self.assertTrue(report["passed"])
        self.assertEqual(report["checks"]["catalog_reconciliation"], "verified")
        self.assertEqual(report["checks"]["evidence_consistency"], "passed")
        self.assertTrue(report["readiness"]["can_generate_full_comparison"])
        self.assertTrue(report["readiness"]["can_register_selected_position"])

    def test_register_permission_is_bound_to_selected_position(self):
        root = self.with_record(lambda path: valid_record(path, ("role-a", "role-b")))
        root.record["selected_position_id"] = "role-b"
        b_position = root.record["positions"][1]
        hard_requirement = b_position["requirements"][0]
        hard_requirement["candidate_evidence_ids"] = []
        hard_requirement["support"] = "no_evidence"
        hard_requirement["conclusion"] = "pending"
        b_position["requirement_summary"] = summary_for(b_position["requirements"])
        b_position["decision"] = {
            "state": "pending",
            "basis": "requirement_summary",
            "reason": "B 岗位硬资格仍待确认。",
        }
        report = run_validator(root, 0)
        self.assertEqual(report["readiness"]["registerable_position_ids"], ["role-a"])
        self.assertEqual(report["readiness"]["selected_position_id"], "role-b")
        self.assertEqual(report["readiness"]["selected_position_status"], "not_registerable")
        self.assertFalse(report["readiness"]["can_register_selected_position"])

        root.record["selected_position_id"] = "role-a"
        report = run_validator(root, 0)
        self.assertEqual(report["readiness"]["selected_position_status"], "registerable")
        self.assertTrue(report["readiness"]["can_register_selected_position"])

    def test_conflict_cannot_be_satisfied_or_recommended(self):
        root = self.with_record()
        position = root.record["positions"][0]
        requirement = position["requirements"][1]
        requirement["support"] = "conflict"
        requirement["conclusion"] = "satisfied"
        position["requirement_summary"] = summary_for(position["requirements"])
        report = run_validator(root, 1)
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("SUPPORT_CONCLUSION_CONFLICT", codes)
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_combined_core_conflict_and_transferable_pending(self):
        root = self.with_record()
        position = root.record["positions"][0]
        conflict_requirement = position["requirements"][1]
        conflict_requirement["support"] = "conflict"
        conflict_requirement["conclusion"] = "not_satisfied"
        transferable_requirement = position["requirements"][2]
        transferable_requirement["category"] = "core_capability"
        transferable_requirement["candidate_evidence_ids"] = ["ev-2"]
        transferable_requirement["support"] = "transferable"
        transferable_requirement["conclusion"] = "pending"
        position["requirement_summary"] = summary_for(position["requirements"])

        position["decision"]["state"] = "pending"
        report = run_validator(root, 0)
        self.assertTrue(report["mechanical_passed"])
        self.assertEqual(report["positions"][0]["status"], "verified")
        self.assertFalse(report["readiness"]["can_register_selected_position"])

        position["decision"]["state"] = "consider"
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "DECISION_STATE_MISMATCH" for issue in report["issues"]))
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_core_no_evidence_conflict_and_transferable_are_not_registerable(self):
        root = self.with_record()
        position = root.record["positions"][0]
        conflict_requirement = position["requirements"][1]
        conflict_requirement["support"] = "conflict"
        conflict_requirement["conclusion"] = "not_satisfied"
        no_evidence_requirement = position["requirements"][2]
        no_evidence_requirement["category"] = "core_capability"
        no_evidence_requirement["candidate_evidence_ids"] = []
        no_evidence_requirement["support"] = "no_evidence"
        no_evidence_requirement["conclusion"] = "pending"
        transferable_requirement = dict(no_evidence_requirement)
        transferable_requirement["requirement_id"] = "role-1-req-4"
        transferable_requirement["candidate_evidence_ids"] = ["ev-2"]
        transferable_requirement["support"] = "transferable"
        position["requirements"].append(transferable_requirement)
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "pending"
        report = run_validator(root, 0)
        self.assertEqual(report["positions"][0]["status"], "verified")
        self.assertEqual(report["positions"][0]["requirement_summary"]["pending"], 2)
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_hard_pending_with_transferable_core_cannot_register(self):
        root = self.with_record()
        position = root.record["positions"][0]
        hard_requirement = position["requirements"][0]
        hard_requirement["candidate_evidence_ids"] = []
        hard_requirement["support"] = "no_evidence"
        hard_requirement["conclusion"] = "pending"
        core_requirement = position["requirements"][1]
        core_requirement["candidate_evidence_ids"] = ["ev-2"]
        core_requirement["support"] = "transferable"
        core_requirement["conclusion"] = "pending"
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "consider"
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "HARD_QUALIFICATION_UNRESOLVED" for issue in report["issues"]))
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_finite_state_combinations_cover_three_role_states(self):
        """Enumerate contract pairs; expected states are test-owned, not production-derived."""
        cases = []
        # Each requirement role receives every allowed support/conclusion pair
        # while the other two roles remain a complete, legal baseline.
        for index in range(3):
            for pair in ALLOWED_SUPPORT_CONCLUSIONS:
                values = [("direct_support", "satisfied")] * 3
                values[index] = pair
                cases.append((f"role-{index}-{pair[0]}-{pair[1]}", tuple(values)))
        # Explicit multi-core combinations exercise non-cancellation.
        cases.extend([
            ("core-conflict-plus-transferable", (("direct_support", "satisfied"), ("conflict", "not_satisfied"), ("transferable", "pending"))),
            ("core-no-evidence-plus-conflict", (("direct_support", "satisfied"), ("no_evidence", "pending"), ("conflict", "pending"))),
            ("core-transferable-plus-transferable", (("direct_support", "satisfied"), ("transferable", "pending"), ("transferable", "pending"))),
        ])
        for label, (hard_pair, core_a_pair, core_b_pair) in cases:
            expected = expected_decision_for_combination(hard_pair, core_a_pair, core_b_pair)
            for state in ("pending", "consider", "recommended"):
                with self.subTest(label=label, state=state):
                    root = self.with_record()
                    position = root.record["positions"][0]
                    position["requirements"][1]["category"] = "core_capability"
                    position["requirements"][2]["category"] = "core_capability"
                    apply_requirement_pair(position["requirements"][0], hard_pair, "ev-1")
                    apply_requirement_pair(position["requirements"][1], core_a_pair, "ev-2")
                    apply_requirement_pair(position["requirements"][2], core_b_pair, "ev-2")
                    position["requirement_summary"] = summary_for(position["requirements"])
                    position["decision"]["state"] = state
                    report = run_validator(root, 0 if state == expected else 1)
                    if state == expected:
                        self.assertEqual(report["positions"][0]["status"], "verified")
                        self.assertEqual(report["readiness"]["can_register_selected_position"], state in {"recommended", "consider"})

    def test_requirement_order_does_not_change_decision_or_permission(self):
        root = self.with_record()
        position = root.record["positions"][0]
        position["requirements"][1]["category"] = "core_capability"
        position["requirements"][2]["category"] = "core_capability"
        for requirement, pair, evidence_id in zip(
            position["requirements"],
            (("direct_support", "satisfied"), ("conflict", "not_satisfied"), ("transferable", "pending")),
            ("ev-1", "ev-2", "ev-2"),
        ):
            apply_requirement_pair(requirement, pair, evidence_id)
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "pending"
        before = run_validator(root, 0)
        position["requirements"] = list(reversed(position["requirements"]))
        position["requirement_summary"] = summary_for(position["requirements"])
        after = run_validator(root, 0)
        self.assertEqual(before["positions"][0]["status"], after["positions"][0]["status"])
        self.assertEqual(before["readiness"]["can_register_selected_position"], after["readiness"]["can_register_selected_position"])

    def test_adding_adverse_core_evidence_cannot_raise_permission(self):
        root = self.with_record()
        position = root.record["positions"][0]
        position["requirements"][1]["category"] = "core_capability"
        position["requirements"][2]["category"] = "core_capability"
        for requirement, pair, evidence_id in zip(
            position["requirements"],
            (("direct_support", "satisfied"), ("transferable", "pending"), ("direct_support", "satisfied")),
            ("ev-1", "ev-2", "ev-2"),
        ):
            apply_requirement_pair(requirement, pair, evidence_id)
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "consider"
        before = run_validator(root, 0)
        self.assertTrue(before["readiness"]["can_register_selected_position"])
        adverse = dict(position["requirements"][2])
        adverse["requirement_id"] = "role-1-adverse"
        adverse["support"] = "conflict"
        adverse["conclusion"] = "not_satisfied"
        adverse["candidate_evidence_ids"] = ["ev-2"]
        position["requirements"].append(adverse)
        position["requirement_summary"] = summary_for(position["requirements"])
        after = run_validator(root, 1)
        self.assertFalse(after["readiness"]["can_register_selected_position"])


    def test_invalid_enum_types_return_structured_reports(self):
        invalid_values = [[], {}, 1, True, None]
        for field in ("category", "support", "conclusion", "decision.state", "coverage.capture_status", "grade"):
            for invalid in invalid_values:
                with self.subTest(field=field, invalid=repr(invalid)):
                    root = self.with_record()
                    position = root.record["positions"][0]
                    if field == "category":
                        position["requirements"][0]["category"] = invalid
                    elif field == "support":
                        position["requirements"][0]["support"] = invalid
                    elif field == "conclusion":
                        position["requirements"][0]["conclusion"] = invalid
                    elif field == "decision.state":
                        position["decision"]["state"] = invalid
                    elif field == "coverage.capture_status":
                        root.record["coverage"]["capture_status"] = invalid
                    else:
                        position["grade"] = invalid
                    report = run_validator(root, 1)
                    self.assertEqual(set(report["checks"]), {
                        "structure", "catalog_reconciliation", "evidence_consistency", "decision_consistency", "coverage_attestation"
                    })
                    self.assertIn("issues", report)
                    self.assertIn("readiness", report)

    def test_summary_boolean_counts_are_invalid(self):
        root = self.with_record()
        summary = root.record["positions"][0]["requirement_summary"]
        summary["pending"] = True
        summary["not_satisfied"] = False
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "SUMMARY_FIELD_TYPE_INVALID" for issue in report["issues"]))

    def test_core_transferable_pending_requires_consider_and_is_registerable(self):
        root = self.with_record()
        position = root.record["positions"][0]
        requirement = position["requirements"][1]
        requirement["support"] = "transferable"
        requirement["conclusion"] = "pending"
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "consider"
        report = run_validator(root, 0)
        self.assertTrue(report["readiness"]["can_register_selected_position"])

        position["decision"]["state"] = "pending"
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "DECISION_STATE_MISMATCH" for issue in report["issues"]))
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_core_no_evidence_pending_is_not_consider(self):
        root = self.with_record()
        position = root.record["positions"][0]
        requirement = position["requirements"][1]
        requirement["support"] = "no_evidence"
        requirement["candidate_evidence_ids"] = []
        requirement["conclusion"] = "pending"
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"]["state"] = "consider"
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "DECISION_STATE_MISMATCH" for issue in report["issues"]))

    def test_a1_same_count_different_identity_set(self):
        root = self.with_record()
        (root / "catalog.json").write_text('[{"id":"raw-only"}]', encoding="utf-8")
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "mismatch")
        self.assertEqual(report["catalog_identity"]["missing_in_catalog"], ["raw-only"])
        self.assertEqual(report["catalog_identity"]["extra_in_catalog"], ["role-1"])
        self.assertTrue(any(issue["code"] == "CATALOG_ID_SET_MISMATCH" for issue in report["issues"]))

    def test_a2_whitespace_normalized_duplicate_quotes(self):
        root = self.with_record()
        root.record["positions"][0]["jd_source"]["quotes"].append(  # type: ignore[attr-defined]
            {"id": "jd-q4", "text": " 本科\n或以上学历。 ", "locator": {"line_start": 1, "line_end": 1}}
        )
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "NORMALIZED_QUOTE_DUPLICATE" for issue in report["issues"]))

    def test_a3_out_of_scope_record_cannot_be_matched(self):
        root = self.with_record()
        root.record["catalog_index"][0]["in_scope"] = False  # type: ignore[attr-defined]
        root.record["catalog_index"][0]["exclusion"] = "outside fixture scope"  # type: ignore[attr-defined]
        root.record["positions"][0]["excluded"] = False  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "SCOPE_DECISION_CONFLICT" for issue in report["issues"]))
        self.assertEqual(report["counts"]["recommended"], 0)

    def test_a4_invalid_raw_catalog_is_blocking_not_warning(self):
        root = self.with_record()
        (root / "catalog.json").write_text("{not json", encoding="utf-8")
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "invalid")
        self.assertEqual(report["readiness"]["status"], "partial")
        self.assertTrue(any(issue["code"] == "RAW_CATALOG_INVALID_JSON" and issue["severity"] == "error" for issue in report["issues"]))

    def test_duplicate_catalog_identity_blocks_reconciliation(self):
        root = self.with_record()
        root.record["catalog_index"].append(dict(root.record["catalog_index"][0]))  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertNotEqual(report["checks"]["catalog_reconciliation"], "verified")
        self.assertFalse(report["passed"])
        self.assertTrue(any(issue["code"] == "CATALOG_DUPLICATE_IDS" for issue in report["issues"]))

    def test_invalid_catalog_encoding_is_reported_not_crashed(self):
        root = self.with_record()
        (root / "catalog.csv").write_text("position_id,title\nrole-1,Fixture QA Engineer\n", encoding="utf-8")
        root.record["raw_catalog"] = {  # type: ignore[attr-defined]
            "file": "catalog.csv",
            "format": "csv",
            "id_column": "position_id",
            "encoding": 123,
            "total_positions": 1,
        }
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "invalid")
        self.assertTrue(any(issue["code"] == "RAW_CATALOG_INVALID_TABLE" for issue in report["issues"]))

    def test_explicit_csv_id_extraction_is_supported(self):
        root = self.with_record()
        (root / "catalog.csv").write_text("position_id,title\nrole-1,Fixture QA Engineer\n", encoding="utf-8")
        root.record["raw_catalog"] = {"file": "catalog.csv", "format": "csv", "id_column": "position_id", "total_positions": 1}  # type: ignore[attr-defined]
        report = run_validator(root, 0)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "verified")

    def test_missing_explicit_id_extraction_is_unverifiable(self):
        root = self.with_record()
        root.record["raw_catalog"].pop("id_path")  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "unverifiable")
        self.assertTrue(any(issue["code"] == "RAW_ID_EXTRACTION_UNVERIFIABLE" for issue in report["issues"]))

    def test_missing_raw_id_is_unverifiable(self):
        root = self.with_record()
        (root / "catalog.json").write_text('[{"title":"ID missing"}]', encoding="utf-8")
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "unverifiable")
        self.assertTrue(any(issue["code"] == "RAW_ID_MISSING" for issue in report["issues"]))

    def test_unsupported_raw_format_is_unverifiable(self):
        root = self.with_record()
        root.record["raw_catalog"]["format"] = "xml"  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["catalog_reconciliation"], "unverifiable")
        self.assertTrue(any(issue["code"] == "RAW_FORMAT_UNSUPPORTED" for issue in report["issues"]))

    def test_unknown_quote_and_candidate_evidence_references_fail(self):
        root = self.with_record()
        requirement = root.record["positions"][0]["requirements"][0]  # type: ignore[attr-defined]
        requirement["jd_quote_ids"] = ["other-position-quote"]
        requirement["candidate_evidence_ids"] = ["missing-evidence"]
        report = run_validator(root, 1)
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("JD_QUOTE_REFERENCE_UNKNOWN", codes)
        self.assertIn("CANDIDATE_EVIDENCE_REFERENCE_UNKNOWN", codes)

    def test_reference_ids_must_remain_strings(self):
        root = self.with_record()
        position = root.record["positions"][0]  # type: ignore[attr-defined]
        position["jd_source"]["quotes"][0]["id"] = "1"
        position["candidate_source"]["evidence"][0]["id"] = "1"
        position["requirements"][0]["jd_quote_ids"] = [1]
        position["requirements"][0]["category_basis_quote_ids"] = [1]
        position["requirements"][0]["candidate_evidence_ids"] = [1]
        report = run_validator(root, 1)
        codes = {issue["code"] for issue in report["issues"]}
        self.assertIn("REQUIREMENT_REFERENCE_MISSING", codes)
        self.assertIn("REQUIREMENT_REFERENCE_TYPE_INVALID", codes)

    def test_quote_must_exist_in_declared_snapshot(self):
        root = self.with_record()
        root.record["positions"][0]["jd_source"]["quotes"][0]["text"] = "不存在于快照的要求。"  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "SOURCE_QUOTE_NOT_FOUND" for issue in report["issues"]))

    def test_no_evidence_cannot_be_satisfied_or_failed(self):
        root = self.with_record()
        requirement = root.record["positions"][0]["requirements"][1]  # type: ignore[attr-defined]
        requirement["support"] = "no_evidence"
        requirement["candidate_evidence_ids"] = []
        requirement["conclusion"] = "satisfied"
        root.record["positions"][0]["requirement_summary"] = summary_for(root.record["positions"][0]["requirements"])  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "SATISFIED_WITHOUT_EVIDENCE" for issue in report["issues"]))

        requirement["conclusion"] = "not_satisfied"
        root.record["positions"][0]["requirement_summary"] = summary_for(root.record["positions"][0]["requirements"])  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "NO_EVIDENCE_NOT_FAILURE" for issue in report["issues"]))

    def test_empty_candidate_source_can_represent_no_evidence(self):
        root = self.with_record()
        position = root.record["positions"][0]  # type: ignore[attr-defined]
        position["candidate_source"]["evidence"] = []
        for requirement in position["requirements"]:
            requirement["candidate_evidence_ids"] = []
            requirement["support"] = "no_evidence"
            requirement["conclusion"] = "pending"
        position["requirement_summary"] = summary_for(position["requirements"])
        position["decision"] = {"state": "pending", "basis": "requirement_summary", "reason": "候选人档案暂未提供相关证据。"}
        report = run_validator(root, 0)
        self.assertEqual(report["checks"]["evidence_consistency"], "passed")
        self.assertEqual(report["positions"][0]["requirement_summary"]["no_evidence"], 3)
        self.assertFalse(report["readiness"]["can_register_selected_position"])

    def test_explicit_hard_failure_differs_from_missing_evidence(self):
        root = self.with_record()
        requirement = root.record["positions"][0]["requirements"][0]  # type: ignore[attr-defined]
        requirement["support"] = "conflict"
        requirement["conclusion"] = "not_satisfied"
        root.record["positions"][0]["excluded"] = True  # type: ignore[attr-defined]
        root.record["positions"][0]["exclusion_reason"] = "明确证据显示硬资格不满足"  # type: ignore[attr-defined]
        root.record["positions"][0]["decision"] = {"state": "excluded", "basis": "requirement_summary", "reason": "硬资格不满足，停止推荐。"}  # type: ignore[attr-defined]
        root.record["positions"][0]["requirement_summary"] = summary_for(root.record["positions"][0]["requirements"])  # type: ignore[attr-defined]
        report = run_validator(root, 0)
        self.assertEqual(report["positions"][0]["status"], "verified")
        self.assertEqual(report["positions"][0]["requirement_summary"]["not_satisfied"], 1)

        requirement["support"] = "no_evidence"
        requirement["candidate_evidence_ids"] = []
        requirement["conclusion"] = "pending"
        root.record["positions"][0]["excluded"] = False  # type: ignore[attr-defined]
        root.record["positions"][0]["decision"] = {"state": "pending", "basis": "requirement_summary", "reason": "硬资格证据待确认。"}  # type: ignore[attr-defined]
        root.record["positions"][0]["requirement_summary"] = summary_for(root.record["positions"][0]["requirements"])  # type: ignore[attr-defined]
        report = run_validator(root, 0)
        self.assertEqual(report["positions"][0]["status"], "verified")
        self.assertEqual(report["positions"][0]["requirement_summary"]["pending"], 2)

    def test_summary_must_be_derived_from_requirements(self):
        root = self.with_record()
        root.record["positions"][0]["requirement_summary"]["direct_support"] = 99  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "REQUIREMENT_SUMMARY_MISMATCH" for issue in report["issues"]))

    def test_required_position_fields_are_structurally_checked(self):
        root = self.with_record()
        root.record["positions"][0].pop("city")  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["structure"], "failed")
        self.assertTrue(any(issue["code"] == "POSITION_FIELD_INVALID" for issue in report["issues"]))

    def test_boolean_scope_fields_are_not_coerced(self):
        root = self.with_record()
        root.record["positions"][0]["excluded"] = "false"  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["structure"], "failed")
        self.assertTrue(any(issue["code"] == "POSITION_FIELD_INVALID" for issue in report["issues"]))

    def test_non_object_coverage_is_structural_failure(self):
        root = self.with_record()
        root.record["coverage"] = "complete"  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertEqual(report["checks"]["structure"], "failed")
        self.assertTrue(any(issue["code"] == "COVERAGE_INVALID" for issue in report["issues"]))

    def test_hash_and_locator_are_actually_checked(self):
        root = self.with_record()
        for name in ("role-1-jd.txt", "role-1-candidate.txt"):
            digest = hashlib.sha256((root / name).read_bytes()).hexdigest()
            source_name = "jd_source" if name.endswith("jd.txt") else "candidate_source"
            root.record["positions"][0][source_name]["sha256"] = digest  # type: ignore[attr-defined]
        report = run_validator(root, 0)
        self.assertTrue(report["passed"])
        (root / "role-1-jd.txt").write_text("tampered\n", encoding="utf-8")
        report = run_validator(root, 1)
        self.assertTrue(any(issue["code"] == "SOURCE_HASH_MISMATCH" for issue in report["issues"]))

    def test_legacy_record_is_readable_but_not_new_standard_pass(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            record = {
                "company": "Legacy Fixture",
                "date": "2026-01-01",
                "scope": "legacy",
                "raw_catalog": {"file": "raw.json", "total_positions": 1},
                "catalog_index": [{"id": "old-1", "title": "Old Role", "city": "Fixture City", "in_scope": True}],
                "positions": [{"id": "old-1", "jd_evidence": ["old quote", "another quote"], "grade": "A"}],
            }
            (path / "raw.json").write_text('[{"id":"old-1"}]', encoding="utf-8")
            path_record = path / "matching.json"
            original = json.dumps(record)
            path_record.write_text(original, encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-X", "utf8", str(SCRIPT), str(path_record)],
                capture_output=True,
            )
            self.assertEqual(result.returncode, 1)
            report = json.loads(result.stdout.decode("utf-8"))
            self.assertTrue(report["compatibility"]["readable"])
            self.assertEqual(report["compatibility"]["mode"], "legacy/unverified")
            self.assertFalse(report["passed"])
            self.assertFalse(report["readiness"]["can_generate_full_comparison"])
            self.assertEqual(path_record.read_text(encoding="utf-8"), original)

    def test_invalid_json_report_keeps_all_check_dimensions(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "matching.json"
            path.write_text("{not json", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, "-X", "utf8", str(SCRIPT), str(path)],
                capture_output=True,
            )
            self.assertEqual(result.returncode, 1)
            report = json.loads(result.stdout.decode("utf-8"))
            self.assertEqual(
                set(report["checks"]),
                {"structure", "catalog_reconciliation", "evidence_consistency", "decision_consistency", "coverage_attestation"},
            )
            self.assertFalse(report["mechanical_passed"])
            self.assertEqual(report["readiness"]["status"], "blocked")

    def test_partial_positions_are_displayable_without_full_claim(self):
        root = self.with_record(lambda path: valid_record(path, ("role-1", "role-2")))
        root.record["positions"][1]["requirements"] = []  # type: ignore[attr-defined]
        root.record["positions"][1].pop("jd_source")  # type: ignore[attr-defined]
        root.record["positions"][1].pop("candidate_source")  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        statuses = {position["id"]: position["status"] for position in report["positions"]}
        self.assertEqual(statuses["role-1"], "verified")
        self.assertEqual(statuses["role-2"], "unverified")
        self.assertTrue(report["readiness"]["can_show_verified_positions"])
        self.assertEqual(report["readiness"]["verified_position_ids"], ["role-1"])
        self.assertFalse(report["readiness"]["can_generate_full_comparison"])

    def test_partial_capture_keeps_valid_position_but_blocks_full_and_registration(self):
        root = self.with_record()
        root.record["coverage"]["capture_status"] = "partial"  # type: ignore[attr-defined]
        root.record["coverage"]["human_attested"] = False  # type: ignore[attr-defined]
        report = run_validator(root, 1)
        self.assertTrue(report["readiness"]["can_show_verified_positions"])
        self.assertFalse(report["readiness"]["can_generate_full_comparison"])
        self.assertFalse(report["readiness"]["can_register_selected_position"])
        self.assertEqual(report["checks"]["coverage_attestation"], "unverified")

    def test_vla_inference_is_transferable_pending_not_satisfied(self):
        root = self.with_record(vla_record)
        report = run_validator(root, 0)
        requirement = root.record["positions"][0]["requirements"][0]  # type: ignore[attr-defined]
        self.assertEqual(requirement["support"], "transferable")
        self.assertEqual(requirement["conclusion"], "pending")
        self.assertEqual(report["positions"][0]["requirement_summary"]["pending"], 1)
        self.assertEqual(report["readiness"]["selected_position_status"], "registerable")
        self.assertTrue(report["readiness"]["can_register_selected_position"])


if __name__ == "__main__":
    unittest.main()
