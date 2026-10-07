"""Offline cross-skill contract tests.

The test uses fictional records only. It verifies that the handoff between
matching, tracker, form audit and online sync can be represented without
leaking sensitive values or losing optimistic-concurrency metadata.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any

from test_verify_matching import valid_record


ROOT = Path(__file__).resolve().parents[3]
MATCHING_VALIDATOR = Path(__file__).with_name("verify-matching.py")
MATCHING_PIPELINE = Path(__file__).with_name("run-matching-pipeline.py")

ALLOWED_STATUSES = {
    "Pending",
    "Deferred",
    "Needs user",
    "Blocked",
    "Submitted",
    "Ended",
    "Skipped",
    "Rejected",
    "Offer",
}


def validate_tracker_plan(plan: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if not isinstance(plan.get("expected_revision"), str) or not plan["expected_revision"].strip():
        errors.append("expected_revision is required")
    operations = plan.get("operations")
    if not isinstance(operations, list) or not operations:
        errors.append("operations must be a non-empty array")
        return errors
    seen: set[str] = set()
    for operation in operations:
        if not isinstance(operation, dict) or operation.get("type") not in {"job.add", "job.patch", "log.add", "event.add", "event.patch"}:
            errors.append("operation type is not supported")
            continue
        job_id = operation.get("job_id")
        if not isinstance(job_id, str) or not job_id.strip():
            errors.append("operation job_id is required")
        elif operation["type"] == "job.patch":
            if job_id in seen:
                errors.append(f"duplicate job.patch: {job_id}")
            seen.add(job_id)
            status = operation.get("patch", {}).get("status")
            if status is not None and status not in ALLOWED_STATUSES:
                errors.append(f"invalid status: {status}")
    return errors


def validate_application_audit(audit: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    fields = audit.get("fields")
    if not isinstance(fields, list):
        return ["fields must be an array"]
    for field in fields:
        if not isinstance(field, dict) or not isinstance(field.get("label"), str):
            errors.append("every audit field needs a label")
            continue
        if field.get("sensitive") is True:
            if type(field.get("matches")) is not bool:
                errors.append(f"sensitive field {field['label']} must use matches boolean")
            if "value" in field:
                errors.append(f"sensitive field {field['label']} must not contain raw value")
    if audit.get("attachment_names") is not None and not isinstance(audit["attachment_names"], list):
        errors.append("attachment_names must be an array")
    return errors


def validate_sync_payload(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if type(payload.get("dryRun")) is not bool:
        errors.append("dryRun must be boolean")
    entries = payload.get("entries")
    index = payload.get("identity_index")
    if not isinstance(entries, list) or not isinstance(index, list):
        return errors + ["entries and identity_index must be arrays"]
    entry_ids = [entry.get("job_id") for entry in entries if isinstance(entry, dict)]
    index_ids = [item.get("job_id") for item in index if isinstance(item, dict)]
    if len(entry_ids) != len(entries) or any(not isinstance(item, str) or not item for item in entry_ids):
        errors.append("every entry needs a non-empty job_id")
    if len(entry_ids) != len(set(entry_ids)):
        errors.append("entries contain duplicate job_id")
    if len(index_ids) != len(index) or len(index_ids) != len(set(index_ids)):
        errors.append("identity_index contains duplicate or empty job_id")
    if not set(entry_ids).issubset(set(index_ids)):
        errors.append("every entry must be represented in identity_index")
    return errors


def validate_ack(results: list[dict[str, Any]], expected_changes: dict[str, str]) -> list[str]:
    errors: list[str] = []
    seen: set[str] = set()
    for result in results:
        job_id = result.get("job_id")
        seen.add(job_id)
        if result.get("verified") is not True or result.get("error") not in (None, ""):
            errors.append(f"{job_id}: only verified results can be acknowledged")
            continue
        if not isinstance(result.get("change_id"), str) or not result["change_id"].strip():
            errors.append(f"{job_id}: change_id is required")
        elif expected_changes.get(job_id) != result["change_id"]:
            errors.append(f"{job_id}: stale or unexpected change_id")
    for job_id in expected_changes:
        if job_id not in seen:
            errors.append(f"{job_id}: missing acknowledgement")
    return errors


class WorkflowContractTests(unittest.TestCase):
    def test_happy_path_across_all_stages(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            matching = valid_record(root)
            matching_path = root / "matching.json"
            matching_path.write_text(json.dumps(matching, ensure_ascii=False), encoding="utf-8")
            process = subprocess.run(
                [sys.executable, "-X", "utf8", str(MATCHING_VALIDATOR), str(matching_path)],
                capture_output=True,
            )
            output = process.stdout.decode("utf-8", errors="replace") + process.stderr.decode("utf-8", errors="replace")
            self.assertEqual(process.returncode, 0, output)
            report = json.loads(process.stdout.decode("utf-8"))
            self.assertTrue(report["readiness"]["can_register_selected_position"])
            selected_id = report["readiness"]["selected_position_id"]
            self.assertIn(selected_id, report["readiness"]["registerable_position_ids"])

            plan = {
                "expected_revision": "fixture-revision-1",
                "operations": [{"type": "job.patch", "job_id": selected_id, "patch": {"status": "Pending"}}],
            }
            self.assertEqual(validate_tracker_plan(plan), [])

            audit = {
                "fields": [
                    {"label": "name", "sensitive": True, "matches": True},
                    {"label": "phone", "sensitive": True, "matches": True},
                    {"label": "city", "value": "Fixture City"},
                ],
                "attachment_names": ["fixture-resume.pdf"],
            }
            self.assertEqual(validate_application_audit(audit), [])

            payload = {
                "dryRun": True,
                "entries": [{"job_id": selected_id, "company": "Fixture Company"}],
                "identity_index": [{"job_id": selected_id, "online_record_id": None}],
            }
            self.assertEqual(validate_sync_payload(payload), [])

            results = [{"job_id": selected_id, "verified": True, "change_id": "change-1", "error": None}]
            self.assertEqual(validate_ack(results, {selected_id: "change-1"}), [])

    def test_rejects_sensitive_leak_and_duplicate_identity(self):
        audit = {"fields": [{"label": "phone", "sensitive": True, "matches": True, "value": "raw-value"}]}
        self.assertTrue(validate_application_audit(audit))

        payload = {
            "dryRun": True,
            "entries": [{"job_id": "job-1"}, {"job_id": "job-1"}],
            "identity_index": [{"job_id": "job-1"}, {"job_id": "job-1"}],
        }
        errors = validate_sync_payload(payload)
        self.assertTrue(any("duplicate" in error for error in errors))

    def test_rejects_stale_ack_and_invalid_tracker_status(self):
        plan = {
            "expected_revision": "fixture-revision-1",
            "operations": [{"type": "job.patch", "job_id": "job-1", "patch": {"status": "Pretend submitted"}}],
        }
        self.assertTrue(validate_tracker_plan(plan))
        results = [{"job_id": "job-1", "verified": True, "change_id": "old-change", "error": None}]
        self.assertTrue(validate_ack(results, {"job-1": "new-change"}))
        self.assertTrue(validate_ack([], {"job-1": "new-change"}))


    def test_pipeline_separates_execution_from_partial_verification(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            matching = valid_record(root)
            matching["coverage"]["human_attested"] = False
            raw = root / "raw.json"
            raw.write_text(json.dumps(matching, ensure_ascii=False), encoding="utf-8")
            run_dir = root / "run"
            process = subprocess.run(
                [sys.executable, "-X", "utf8", str(MATCHING_PIPELINE), "--raw", str(raw), "--run-dir", str(run_dir)],
                capture_output=True,
            )
            output = process.stdout.decode("utf-8", errors="replace") + process.stderr.decode("utf-8", errors="replace")
            self.assertEqual(process.returncode, 0, output)
            result = json.loads((run_dir / "pipeline-result.json").read_text(encoding="utf-8"))
            self.assertEqual(result["status"], "completed")
            self.assertEqual(result["execution_status"], "completed")
            self.assertEqual(result["verification_status"], "partial")
            self.assertEqual(result["readiness_status"], "partial")
            self.assertTrue(result["mechanical_passed"])
            self.assertNotEqual(result["verifier_exit_code"], 0)
            self.assertEqual(result["human_summary_status"], "generated")
            self.assertTrue((run_dir / "human-summary.json").is_file())


if __name__ == "__main__":
    unittest.main()
