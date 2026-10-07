"""Validate the public skill bundle's entrypoints and local references."""

from __future__ import annotations

import re
import sys
from pathlib import Path


SKILL_NAME = re.compile(r"^[a-z0-9-]{1,63}$")
LOCAL_LINK = re.compile(r"\[[^\]]*\]\(([^)]+)\)")


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    skills_root = root / "skills"
    errors: list[str] = []
    skill_dirs = sorted(path for path in skills_root.iterdir() if path.is_dir()) if skills_root.is_dir() else []

    if not skill_dirs:
        errors.append("skills/ contains no skill directories")

    for skill_dir in skill_dirs:
        skill_file = skill_dir / "SKILL.md"
        if not skill_file.is_file():
            errors.append(f"missing entrypoint: {skill_file.relative_to(root)}")
            continue
        content = skill_file.read_text(encoding="utf-8")
        if not content.startswith("---\n"):
            errors.append(f"missing frontmatter: {skill_file.relative_to(root)}")
        name_match = re.search(r"(?m)^name:\s*([^\s]+)\s*$", content)
        if not name_match or not SKILL_NAME.fullmatch(name_match.group(1)):
            errors.append(f"invalid skill name: {skill_file.relative_to(root)}")
        elif name_match.group(1) != skill_dir.name:
            errors.append(f"skill name/folder mismatch: {skill_file.relative_to(root)}")
        if not re.search(r"(?m)^description:\s*\S+", content):
            errors.append(f"missing description: {skill_file.relative_to(root)}")

        for target in LOCAL_LINK.findall(content):
            target = target.split("#", 1)[0].strip("<>").strip()
            if not target or "://" in target or target.startswith("mailto:"):
                continue
            candidate = (skill_file.parent / target).resolve()
            if not candidate.exists():
                errors.append(f"broken local link: {skill_file.relative_to(root)} -> {target}")

    if errors:
        print("validate-skill-structure: FAILED")
        for error in errors:
            print(f"- {error}")
        return 1
    print(f"validate-skill-structure: passed ({len(skill_dirs)} skills)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

