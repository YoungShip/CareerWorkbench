"""Local consistency checks across declared resumes, canonical projects and generated views."""
from __future__ import annotations

import hashlib
import html
import json
import re
from pathlib import Path


def file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def sha_matches(expected, path: Path) -> bool:
    # Generators hash text with CRLF folded to LF; older manifests hold the raw hash of a
    # Windows (CRLF) or Linux (LF) checkout. Accept all three so line endings alone never fail.
    raw = path.read_bytes()
    lf = raw.replace(b"\r\n", b"\n")
    return expected in {hashlib.sha256(form).hexdigest() for form in (raw, lf, lf.replace(b"\n", b"\r\n"))}


def normalized_text(text: str) -> str:
    # Layout only. Do not normalize radicals, ligatures or other Unicode characters.
    return re.sub(r"[\s\ue000-\uf8ff•·]", "", text)


def markdown_text(text: str) -> str:
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = html.unescape(re.sub(r"<[^>]*>", "", text))
    text = re.sub(r"(?m)^\s*(?:#{1,6}|>|[-*])\s*", "", text)
    return text.replace("**", "").replace("`", "")


def project_titles(text: str) -> list[str]:
    lines, block, inside = text.splitlines(), [], False
    for line in lines:
        if line.startswith("## "):
            inside = "项目经历" in line
        elif inside:
            block.append(line)
    titles = []
    for match in re.finditer(r"<h3\b[^>]*>(.*?)</h3>|^###\s+([^\n]+)", "\n".join(block), re.S | re.I | re.M):
        value = markdown_text(match.group(1) or match.group(2)).strip()
        value = re.sub(r"\s+(?:GitHub|源码|代码)\s*$", "", value, flags=re.I)
        titles.append(value)
    return titles


def title_key(value: str) -> str:
    return re.sub(r"\s+", "", value).casefold()


def inspect_materials(profile_json: Path, project: Path, *, check_pdf=True) -> dict:
    errors, warnings, resume_rows = [], [], []
    def fail(code, **detail): errors.append({"code": code, **detail})
    def warn(code, **detail): warnings.append({"code": code, **detail})
    if not profile_json.is_file():
        return {"status": "unavailable", "errors": [{"code": "PROFILE_MISSING"}], "warnings": [], "resumes": []}
    try:
        data = json.loads(profile_json.read_text(encoding="utf-8-sig"))
    except (ValueError, OSError):
        return {"status": "failed", "errors": [{"code": "PROFILE_INVALID"}], "warnings": [], "resumes": []}
    if not isinstance(data, dict) or not isinstance(data.get("项目经历", []), list) or any(not isinstance(p, dict) for p in data.get("项目经历", [])):
        return {"status": "failed", "errors": [{"code": "PROFILE_PROJECT_SCHEMA_INVALID"}], "warnings": [], "resumes": []}
    materials_root = profile_json.parent.parent.resolve()
    projects = data.get("项目经历", [])
    ids, titles = set(), {}
    legacy_groups = {"project_nurec": "NuRec项目", "project_multicam": "工业视觉项目"}
    for entry in projects:
        pid = entry.get("id")
        if not isinstance(pid, str) or not pid or pid in ids:
            fail("PROJECT_ID_MISSING_OR_DUPLICATE")
            continue
        ids.add(pid)
        name = entry.get("名称")
        if not isinstance(name, str) or not name.strip():
            fail("PROJECT_NAME_MISSING", project_id=pid)
            continue
        aliases = entry.get("简历标题别名", [])
        if not isinstance(aliases, list) or any(not isinstance(x, str) for x in aliases):
            fail("PROJECT_ALIASES_INVALID", project_id=pid); aliases = []
        for title in [name, *aliases]:
            titles.setdefault(title_key(title), set()).add(pid)
        group = entry.get("网申文本组") or legacy_groups.get(pid)
        if not group:
            fail("PROJECT_COPYTEXT_GROUP_MISSING", project_id=pid)
        if group:
            variants = data.get("可复制文本", {}).get(group)
            if not variants or "300" not in variants:
                fail("PROJECT_COPYTEXT_MISSING", project_id=pid, group=group)
            elif entry.get("描述") != [variants["300"].get("文本")]:
                fail("PROJECT_DESCRIPTION_OUTDATED", project_id=pid)
    for group, variants in data.get("可复制文本", {}).items():
        for limit, entry in variants.items():
            text = entry.get("文本")
            try:
                valid = isinstance(text, str) and len(text) == entry.get("字符数") and len(text) <= int(limit) and entry.get("上限") == int(limit)
            except (TypeError, ValueError): valid = False
            if not valid: fail("COPYTEXT_COUNT_OR_LIMIT", group=group, variant=limit)
    def local_file(value):
        if not isinstance(value, str): return None
        path = (materials_root / value).resolve()
        return path if path.is_relative_to(materials_root) else None
    for key, value in data.get("附件", {}).items():
        if key == "默认投递版本": continue
        path = local_file(value)
        if path is None or not path.is_file():
            fail("ATTACHMENT_MISSING_OR_OUTSIDE_ROOT", attachment=key)
            continue
        stored = data.get("_附件核验", {}).get(key, {})
        if stored and stored.get("字节数") != path.stat().st_size:
            fail("ATTACHMENT_SIZE_OUTDATED", attachment=key)
        if stored.get("SHA256") and stored["SHA256"] != file_sha(path):
            fail("ATTACHMENT_HASH_OUTDATED", attachment=key)
        if "国企" in key or "-国企.pdf" in str(value):
            fail("RETIRED_RESUME_SELECTED", attachment=key)
    sources = data.get("_文本来源", {})
    for variant in ("A", "C"):
        value = sources.get("原简历" + variant)
        if not value:
            if "简历_" + variant in data.get("附件", {}):
                fail("RESUME_SOURCE_NOT_DECLARED", variant=variant)
            else:
                warn("RESUME_SOURCE_NOT_DECLARED", variant=variant)
            continue
        source = local_file(value)
        pdf = local_file(data.get("附件", {}).get("简历_" + variant))
        if source is None or not source.is_file():
            fail("RESUME_SOURCE_MISSING", variant=variant)
            continue
        text = source.read_text(encoding="utf-8-sig")
        names, mapped = project_titles(text), []
        for name in names:
            matches = titles.get(title_key(name), set())
            if len(matches) != 1:
                fail("RESUME_PROJECT_NOT_IN_MASTER" if not matches else "RESUME_PROJECT_AMBIGUOUS",
                     variant=variant, title=name)
            else: mapped.extend(matches)
        row = {"variant": variant, "project_titles": names, "project_ids": mapped}
        if check_pdf and pdf is not None and pdf.is_file():
            try:
                from pypdf import PdfReader
                from pypdf.errors import PyPdfError
                reader = PdfReader(pdf)
                extracted = "\n".join(p.extract_text() or "" for p in reader.pages)
                row.update(pages=len(reader.pages), text_matches=normalized_text(extracted) == normalized_text(markdown_text(text)))
                if len(reader.pages) != 1: fail("STANDARD_RESUME_NOT_ONE_PAGE", variant=variant)
                if not row["text_matches"]: fail("RESUME_PDF_TEXT_OUTDATED", variant=variant)
                if any("\u2e80" <= char <= "\u2fdf" for char in extracted):
                    fail("RESUME_PDF_RADICAL_CHARACTERS", variant=variant)
            except (ValueError, OSError, PyPdfError): fail("RESUME_PDF_UNREADABLE", variant=variant)
        resume_rows.append(row)
    for entry in projects:
        if entry.get("适用版本") is not None and not (isinstance(entry["适用版本"], list) and set(entry["适用版本"]) <= {"A", "B", "C"}):
            fail("PROJECT_VARIANTS_INVALID", project_id=entry.get("id"))
    # A declared generator output must carry a source/output hash manifest.
    output_names = data.get("_生成管理", {}).get("输出", [])
    if output_names:
        manifest_path = profile_json.parent / "资料生成核验.json"
        if not manifest_path.is_file(): fail("GENERATED_MATERIALS_MANIFEST_MISSING")
        else:
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
                if not sha_matches(manifest.get("master_sha256"), profile_json): fail("GENERATED_MATERIALS_SOURCE_OUTDATED")
                for name in output_names:
                    target = local_file(name)
                    if target is None or not target.is_file() or not sha_matches(manifest.get("outputs", {}).get(name), target):
                        fail("GENERATED_MATERIALS_OUTPUT_OUTDATED", file=Path(name).name)
            except (ValueError, OSError): fail("GENERATED_MATERIALS_MANIFEST_INVALID")
    views_manifest = project / "data/private/workflow-views-manifest.json"
    view_names = ["candidate_profile.json", "experience_bank.md", "answer_bank.md", "application_rules.md"]
    if any((project / name).is_file() for name in view_names):
        if not views_manifest.is_file(): fail("WORKFLOW_VIEWS_MANIFEST_MISSING")
        else:
            try:
                view = json.loads(views_manifest.read_text(encoding="utf-8-sig"))
                if not sha_matches(view.get("master_sha256"), profile_json): fail("WORKFLOW_VIEWS_SOURCE_OUTDATED")
                rules_path = profile_json.parent / "求职档案.md"
                if rules_path.is_file() and not sha_matches(view.get("rules_sha256"), rules_path): fail("WORKFLOW_VIEWS_RULES_OUTDATED")
                for name in view_names:
                    target = project / name
                    if not target.is_file() or not sha_matches(view.get("outputs", {}).get(name), target):
                        fail("WORKFLOW_VIEW_OUTDATED", file=name)
            except (ValueError, OSError): fail("WORKFLOW_VIEWS_MANIFEST_INVALID")
    extra = project / "data/private/agent-corpus/extra-evidence.md"
    if extra.is_file():
        extra_text = extra.read_text(encoding="utf-8-sig")
        for entry in projects:
            for name in [entry.get("名称", ""), *entry.get("简历标题别名", [])]:
                if len(name) > 4 and name in extra_text:
                    warn("PROJECT_ALSO_IN_SUPPLEMENT", project_id=entry.get("id")); break
    return {"status": "failed" if errors else "passed", "errors": errors, "warnings": warnings,
            "project_count": len(projects), "copytext_groups": len(data.get("可复制文本", {})), "resumes": resume_rows}


def require_consistent_materials(profile_json: Path, project: Path) -> dict:
    result = inspect_materials(profile_json, project)
    if result["status"] in {"failed", "unavailable"}:
        codes = ", ".join(sorted({item["code"] for item in result["errors"]}))
        raise ValueError("资料链路未同步，先更新母表并重新生成资料：" + codes)
    return result


def matching_freshness(path: Path, current_version: str) -> dict:
    try:
        if path.is_dir():
            candidate = path / "corpus.json"
            value = json.loads(candidate.read_text(encoding="utf-8"))
            raw_versions = [value.get("version")]
        else:
            value = json.loads(path.read_text(encoding="utf-8"))
            positions = value.get("positions", [])
            if not isinstance(positions, list): raise ValueError("positions must be a list")
            raw_versions = [p.get("candidate_source", {}).get("profile_version") for p in positions]
        versions = {v for v in raw_versions if isinstance(v, str)}
        known = bool(raw_versions) and all(isinstance(v, str) and v.startswith("corpus@") for v in raw_versions)
        status = "current" if known and versions == {current_version} else "stale" if known else "unknown"
        return {"status": status, "current_version": current_version, "frozen_versions": sorted(versions),
                "note": "历史结果保留；当前选岗使用新事实复核。" if status != "current" else "与当前事实快照一致。"}
    except (OSError, ValueError, TypeError, AttributeError):
        return {"status": "unknown", "note": "无法读取可比较的冻结证据版本，需要人工复核。"}
