"""Run the daily raw -> derived summary -> verification matching path.

The caller must save the model response as a UTF-8 raw JSON file first. This
pipeline creates a new, non-empty run directory, copies the raw record, derives
only requirement_summary, and then invokes the current verifier. It never
changes semantic matching fields and never replaces the raw input.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
ASSEMBLER = SCRIPT_DIR / "assemble-matching-summary.py"
VERIFIER = SCRIPT_DIR / "verify-matching.py"
DISPLAY = SCRIPT_DIR / "derive_matching_display.py"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def strict_text(data: bytes, path: Path) -> str:
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as exc:
        diagnostic = {
            "status": "stopped",
            "path": str(path),
            "encoding": "utf-8-strict",
            "error": str(exc),
            "raw_sha256": hashlib.sha256(data).hexdigest(),
            "raw_prefix_hex": data[:64].hex(),
        }
        path.with_suffix(path.suffix + ".encoding-failure.json").write_text(
            json.dumps(diagnostic, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        raise


def capture_process(result: subprocess.CompletedProcess[bytes], raw_path: Path, readable_path: Path) -> None:
    raw = (result.stdout or b"") + (result.stderr or b"")
    raw_path.write_bytes(raw)
    readable_path.write_text(strict_text(raw, raw_path), encoding="utf-8")


def copy_declared_snapshots(record: object, raw_parent: Path, run_dir: Path) -> list[str]:
    if not isinstance(record, dict):
        return []
    references: set[str] = set()
    raw_catalog = record.get("raw_catalog")
    if isinstance(raw_catalog, dict) and isinstance(raw_catalog.get("file"), str):
        references.add(raw_catalog["file"])
    for position in record.get("positions", []):
        if not isinstance(position, dict):
            continue
        for source_name in ("jd_source", "candidate_source"):
            source = position.get(source_name)
            if isinstance(source, dict) and isinstance(source.get("snapshot_file"), str):
                references.add(source["snapshot_file"])
    copied: list[str] = []
    for reference in sorted(references):
        source = Path(reference)
        if source.is_absolute() or ".." in source.parts:
            raise ValueError(f"snapshot_file must be a safe relative path: {reference}")
        source_path = (raw_parent / source).resolve()
        if not source_path.is_file():
            raise FileNotFoundError(f"declared snapshot_file is missing: {reference}")
        destination = run_dir / source
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_path, destination)
        copied.append(reference)
    return copied


def run_verifier(run_dir: Path, target: Path, label: str) -> dict[str, object]:
    command = [sys.executable, "-X", "utf8", str(VERIFIER), str(target)]
    started = time.perf_counter()
    result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 3)
    capture_process(result, run_dir / f"{label}-verifier.raw.log", run_dir / f"{label}-verifier.log")
    report_path = target.with_name(target.stem + "-verification.json")
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
    return {
        "label": label,
        "exit_code": result.returncode,
        "elapsed_ms": elapsed_ms,
        "report_path": str(report_path),
        "report": report,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raw", type=Path, required=True, help="saved raw model JSON, decoded as strict UTF-8")
    parser.add_argument("--run-dir", type=Path, required=True, help="new empty output directory")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    raw = args.raw.resolve()
    run_dir = args.run_dir.resolve()
    if not raw.is_file():
        raise SystemExit(f"raw input does not exist: {raw}")
    if run_dir.exists():
        raise SystemExit(f"refusing to reuse output directory: {run_dir}")
    if raw == run_dir:
        raise SystemExit("raw input and output directory must be separate")
    run_dir.mkdir(parents=True)

    raw_bytes = raw.read_bytes()
    raw_text = strict_text(raw_bytes, raw)
    try:
        raw_record = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"raw input is not valid JSON: {exc}")
    raw_copy = run_dir / "model-raw.json"
    raw_copy.write_bytes(raw_bytes)
    snapshots = copy_declared_snapshots(raw_record, raw.parent, run_dir)
    (run_dir / "source-lock.json").write_text(
        json.dumps(
            {
                "assembler": str(ASSEMBLER),
                "assembler_sha256": sha256(ASSEMBLER),
                "verifier": str(VERIFIER),
                "verifier_sha256": sha256(VERIFIER),
                "display": str(DISPLAY),
                "display_sha256": sha256(DISPLAY),
                "raw_source": str(raw),
                "raw_sha256": hashlib.sha256(raw_bytes).hexdigest(),
                "utf8_strict": True,
                "copied_declared_snapshots": snapshots,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    raw_validation = run_verifier(run_dir, raw_copy, "raw")

    assembled = run_dir / "assembled-matching.json"
    diagnostics = run_dir / "assembly-diagnostics.json"
    diff = run_dir / "assembly-field-diff.json"
    assemble_command = [
        sys.executable,
        "-X",
        "utf8",
        str(ASSEMBLER),
        str(raw_copy),
        str(assembled),
        "--diagnostics",
        str(diagnostics),
        "--diff",
        str(diff),
    ]
    assemble_started = time.perf_counter()
    assemble_result = subprocess.run(assemble_command, stdin=subprocess.DEVNULL, capture_output=True)
    assemble_ms = round((time.perf_counter() - assemble_started) * 1000, 3)
    capture_process(assemble_result, run_dir / "assembler.raw.log", run_dir / "assembler.log")
    if assemble_result.returncode != 0:
        result = {
            "status": "assembly_failed",
            "execution_status": "assembly_failed",
            "verification_status": "not_run",
            "readiness_status": "blocked",
            "mechanical_passed": False,
            "assembler_exit_code": assemble_result.returncode,
            "assembler_elapsed_ms": assemble_ms,
            "raw_verification": raw_validation,
            "assembled_verification": None,
            "raw_preserved": raw_copy.exists(),
        }
        (run_dir / "pipeline-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return assemble_result.returncode

    verify_command = [sys.executable, "-X", "utf8", str(VERIFIER), str(assembled)]
    verify_started = time.perf_counter()
    verify_result = subprocess.run(verify_command, stdin=subprocess.DEVNULL, capture_output=True)
    verify_ms = round((time.perf_counter() - verify_started) * 1000, 3)
    capture_process(verify_result, run_dir / "verifier.raw.log", run_dir / "verifier.log")
    report_path = assembled.with_name(assembled.stem + "-verification.json")
    report = json.loads(report_path.read_text(encoding="utf-8")) if report_path.exists() else None
    human_summary_path = run_dir / "human-summary.json"
    display_command = [sys.executable, "-X", "utf8", str(DISPLAY), str(assembled), str(human_summary_path)]
    display_result = subprocess.run(display_command, stdin=subprocess.DEVNULL, capture_output=True)
    capture_process(display_result, run_dir / "display.raw.log", run_dir / "display.log")
    human_summary = json.loads(human_summary_path.read_text(encoding="utf-8")) if human_summary_path.exists() else None
    result = {
        "status": "completed",
        "execution_status": "completed",
        "verification_status": (report or {}).get("overall_status", "missing_report"),
        "readiness_status": (report or {}).get("readiness", {}).get("status", "unknown"),
        "mechanical_passed": (report or {}).get("mechanical_passed") is True,
        "assembler_exit_code": assemble_result.returncode,
        "assembler_elapsed_ms": assemble_ms,
        "verifier_exit_code": verify_result.returncode,
        "verifier_elapsed_ms": verify_ms,
        "raw_verification": raw_validation,
        "assembled_verification": report,
        "human_summary_status": "generated" if display_result.returncode == 0 and human_summary is not None else "failed",
        "human_summary_path": str(human_summary_path),
        "human_summary": human_summary,
        "raw_preserved": raw_copy.exists(),
        "assembled_path": str(assembled),
    }
    (run_dir / "pipeline-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
