"""Scan a skill bundle for common accidental personal-data and credential leaks.

This is a release gate, not a complete privacy review. It intentionally reports
high-signal patterns and leaves semantic review to the maintainer.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SKIP_DIRS = {".git", "node_modules", "__pycache__", ".pytest_cache"}
FORBIDDEN_NAME_PARTS = {
    "private",
    "data",
    "tmp",
    "output",
    "outputs",
    "snapshots",
    "artifacts",
    "browser-profile",
    "chrome-profile",
    "cookies",
    "credentials",
}

EMAIL = re.compile(r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-])")
PHONE = re.compile(r"(?<!\d)(?:\+?86[ -]?)?1[3-9]\d{9}(?!\d)")
NATIONAL_ID = re.compile(r"(?<!\d)(?:\d{17}[0-9Xx])(?!\d)")
# Build the Unix fragment in pieces so the scanner does not flag its own
# detection pattern as a leaked path.
WINDOWS_PERSONAL_PATH = re.compile(
    r"(?i)(?:[A-Z]:[\\/](?:Users|Documents and Settings|AppData)[\\/]|/" + "Users" + r"/)")
JWT = re.compile(r"\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b")
SECRET_ASSIGNMENT = re.compile(
    r"(?i)\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie)\b\s*[:=]\s*['\"][^'\"]{12,}['\"]"
)


def iter_files(root: Path):
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        yield path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("root", nargs="?", default=".")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    findings: list[str] = []

    for path in iter_files(root):
        relative = path.relative_to(root)
        lowered_parts = {part.lower() for part in relative.parts}
        if lowered_parts & FORBIDDEN_NAME_PARTS:
            findings.append(f"private-looking path: {relative}")
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for label, pattern in (
            ("email-like value", EMAIL),
            ("phone-like value", PHONE),
            ("national-id-like value", NATIONAL_ID),
            ("personal absolute path", WINDOWS_PERSONAL_PATH),
            ("JWT-like token", JWT),
            ("secret assignment", SECRET_ASSIGNMENT),
        ):
            match = pattern.search(text)
            if match:
                # Do not print the matched secret/value; only report location.
                line = text[: match.start()].count("\n") + 1
                findings.append(f"{label}: {relative}:{line}")

    if findings:
        print("public-safety-check: FAILED")
        for finding in findings:
            print(f"- {finding}")
        return 1
    print("public-safety-check: passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
