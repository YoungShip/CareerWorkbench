import importlib.util
import json
import sys
import subprocess
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("assemble-matching-summary.py")
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("assemble_matching_summary", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def requirement(requirement_id, category, support, conclusion):
    return {
        "requirement_id": requirement_id,
        "text": f"要求 {requirement_id}",
        "category": category,
        "category_basis_quote_ids": [f"jd-{requirement_id}"],
        "jd_quote_ids": [f"jd-{requirement_id}"],
        "candidate_evidence_ids": [] if support == "no_evidence" else [f"ev-{requirement_id}"],
        "support": support,
        "conclusion": conclusion,
        "judgment": "fixture judgment",
    }


class AssembleMatchingSummaryTests(unittest.TestCase):
    def test_counts_hard_core_plus_and_ambiguous_independently(self):
        requirements = [
            requirement("r1", "hard_qualification", "direct_support", "satisfied"),
            requirement("r2", "core_capability", "direct_support", "satisfied"),
            requirement("r3", "core_capability", "transferable", "pending"),
            requirement("r4", "plus", "no_evidence", "pending"),
            requirement("r5", "ambiguous", "no_evidence", "pending"),
        ]
        record = {"positions": [{"requirements": requirements, "requirement_summary": {}}]}

        assembled, errors, changed = MODULE.assemble(record)

        self.assertEqual(errors, [])
        self.assertEqual(
            assembled["positions"][0]["requirement_summary"],
            {
                "requirements_total": 5,
                "hard_qualification": 1,
                "core_capability": 2,
                "plus": 1,
                "ambiguous": 1,
                "core_total": 3,
                "direct_support": 2,
                "transferable": 1,
                "no_evidence": 2,
                "conflict": 0,
                "satisfied": 2,
                "not_satisfied": 0,
                "pending": 3,
            },
        )
        self.assertIn("positions[0].requirement_summary.core_total", changed)

    def test_empty_requirements_are_not_guessed(self):
        record = {"positions": [{"requirements": [], "requirement_summary": {"core_total": 99}}]}

        assembled, errors, changed = MODULE.assemble(record)

        self.assertEqual(assembled, record)
        self.assertTrue(any("REQUIREMENTS_MISSING_OR_EMPTY" in error for error in errors))
        self.assertEqual(changed, [])

    def test_damaged_requirement_is_not_dropped_or_defaulted(self):
        damaged = requirement("r1", "core_capability", "direct_support", "satisfied")
        damaged.pop("category")
        record = {"positions": [{"requirements": [damaged], "requirement_summary": {}}]}
        original = json.loads(json.dumps(record))

        assembled, errors, changed = MODULE.assemble(record)

        self.assertEqual(assembled, original)
        self.assertTrue(any("REQUIREMENT_FIELDS_MISSING=category" in error for error in errors))
        self.assertEqual(changed, [])

    def test_non_string_enum_values_are_diagnostic_not_unhashable_errors(self):
        for field in ("category", "support", "conclusion"):
            with self.subTest(field=field):
                item = requirement("r1", "core_capability", "direct_support", "satisfied")
                item[field] = [] if field != "conclusion" else {}
                record = {"positions": [{"requirements": [item], "requirement_summary": {}}]}

                assembled, errors, changed = MODULE.assemble(record)

                self.assertEqual(assembled, record)
                self.assertTrue(any(f".{field}: REQUIREMENT_{field.upper()}_INVALID" in error for error in errors))
                self.assertEqual(changed, [])

    def test_invalid_summary_containers_are_rebuilt_as_derived_data(self):
        requirements = [
            requirement("r1", "hard_qualification", "direct_support", "satisfied"),
            requirement("r2", "core_capability", "transferable", "pending"),
            requirement("r3", "core_capability", "no_evidence", "pending"),
        ]
        expected_core_total = 3
        boolean_summary = {
            "requirements_total": True,
            "hard_qualification": True,
            "core_capability": False,
            "plus": False,
            "ambiguous": False,
            "core_total": True,
            "direct_support": False,
            "transferable": True,
            "no_evidence": True,
            "conflict": False,
            "satisfied": False,
            "not_satisfied": True,
            "pending": True,
        }
        for old_summary in (None, [], "invalid", {"core_total": False}, boolean_summary):
            with self.subTest(old_summary=old_summary):
                record = {"positions": [{"requirements": requirements, "requirement_summary": old_summary}]}
                assembled, errors, changed = MODULE.assemble(record)

                self.assertEqual(errors, [])
                self.assertEqual(assembled["positions"][0]["requirement_summary"]["core_total"], expected_core_total)
                self.assertTrue(all(type(value) is int for value in assembled["positions"][0]["requirement_summary"].values()))
                self.assertTrue(changed)

    def test_equal_valued_boolean_counts_are_rebuilt_as_integers(self):
        # 审阅 5.1：从合法记录出发，只把数值 0/1 的计数换成对应布尔值。
        # Python 中 False == 0、True == 1，因此整体相等比较会漏掉这种替换，
        # 必须逐字段按 type(v) is int 核对，否则布尔计数被静默保留。
        requirements = [requirement("r1", "hard_qualification", "direct_support", "satisfied")]
        expected_summary = MODULE.summary(requirements)
        # 前置条件：该记录的派生计数确实只由 0/1 组成，才能构造"等值布尔"反例
        self.assertTrue(all(value in (0, 1) for value in expected_summary.values()))
        self.assertEqual(expected_summary["hard_qualification"], 1)
        self.assertEqual(expected_summary["core_capability"], 0)

        boolean_summary = {key: bool(value) for key, value in expected_summary.items()}
        # 确认这些布尔值与整数计数相等（正是旧实现漏判的原因）
        self.assertEqual(boolean_summary, expected_summary)

        record = {
            "positions": [
                {
                    "requirements": requirements,
                    "requirement_summary": json.loads(json.dumps(boolean_summary)),
                    "title": "Fixture title",
                    "decision": {"state": "recommended", "basis": "requirement_summary", "reason": "fixture"},
                }
            ]
        }
        original = json.loads(json.dumps(record))

        assembled, errors, changed = MODULE.assemble(record)

        self.assertEqual(errors, [])
        rebuilt = assembled["positions"][0]["requirement_summary"]
        # 必须重建为整数
        self.assertTrue(
            all(type(value) is int for value in rebuilt.values()),
            f"计数必须重建为整数，实际类型：{ {k: type(v).__name__ for k, v in rebuilt.items()} }",
        )
        self.assertEqual(rebuilt, expected_summary)
        # 差异必须被记录（不能静默）
        self.assertTrue(changed, "等值布尔替换必须产生 changed_paths")
        self.assertTrue(any("requirement_summary" in path for path in changed))
        # 语义字段原样保留，原始记录不被改动
        self.assertEqual(assembled["positions"][0]["decision"], original["positions"][0]["decision"])
        self.assertEqual(assembled["positions"][0]["title"], "Fixture title")
        self.assertEqual(record, original, "原始记录不得被就地修改")

    def test_cli_writes_structured_diagnostics_for_invalid_requirement(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            record = {"positions": [{"requirements": [{"category": []}], "requirement_summary": None}]}
            source = root / "matching.json"
            output = root / "assembled.json"
            diagnostics = root / "diagnostics.json"
            diff = root / "diff.json"
            original = json.dumps(record, ensure_ascii=False, indent=2) + "\n"
            source.write_text(original, encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    "-X",
                    "utf8",
                    str(SCRIPT),
                    str(source),
                    str(output),
                    "--diagnostics",
                    str(diagnostics),
                    "--diff",
                    str(diff),
                ],
                capture_output=True,
            )

            self.assertEqual(result.returncode, 1)
            self.assertEqual(output.read_text(encoding="utf-8"), source.read_text(encoding="utf-8"))
            report = json.loads(diagnostics.read_text(encoding="utf-8"))
            self.assertEqual(report["status"], "failed")
            self.assertTrue(any("positions[0].requirements[0].category" in error for error in report["errors"]))
            self.assertEqual(json.loads(diff.read_text(encoding="utf-8"))["changed_paths"], [])


if __name__ == "__main__":
    unittest.main()
