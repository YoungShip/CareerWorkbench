"""Validate matching.json schema v2 without making semantic hiring decisions.

The validator checks structure, explicit catalog identity, source references,
and derived readiness. It cannot prove that a URL is official or that an AI or
human interpreted a requirement correctly.
"""

from __future__ import annotations

import csv
import hashlib
import json
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 2
GRADES = {"S", "A", "B", "C"}
CATEGORIES = {"hard_qualification", "core_capability", "plus", "ambiguous"}
CONCLUSIONS = {"satisfied", "not_satisfied", "pending"}
SUPPORTS = {"direct_support", "transferable", "no_evidence", "conflict"}
DECISIONS = {"recommended", "consider", "pending", "excluded", "not_applicable"}
CAPTURE_STATES = {"complete", "partial", "unknown"}


def nonempty(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def canon_id(value: Any) -> str | None:
    if value is None or isinstance(value, (bool, list, dict)):
        return None
    value = str(value).strip()
    return value or None


def normalize(value: str) -> str:
    """Normalize layout whitespace for comparison, never for stored text."""
    value = re.sub(r"\s+", " ", value).strip()
    # A browser line-wrap between CJK characters is not a semantic separator;
    # preserve separators between Latin words.
    return re.sub(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff]) (?=[\u3400-\u4dbf\u4e00-\u9fff])", "", value)


def resolve(base: Path, value: Any) -> Path | None:
    if not nonempty(value):
        return None
    path = Path(value)
    return (base.parent / path).resolve() if not path.is_absolute() else path.resolve()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_pointer(value: Any, pointer: str) -> Any:
    if pointer == "":
        return value
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise ValueError("JSON Pointer must be empty or start with '/'")
    node = value
    for token in pointer.split("/")[1:]:
        token = token.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list) and token.isdigit():
            node = node[int(token)]
        elif isinstance(node, dict) and token in node:
            node = node[token]
        else:
            raise KeyError(token)
    return node


class Issues:
    def __init__(self) -> None:
        self.items: list[dict[str, Any]] = []
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def add(
        self,
        code: str,
        check: str,
        message: str,
        next_step: str,
        *,
        path: str | None = None,
        position_id: str | None = None,
        severity: str = "error",
        outcome: str = "failed",
    ) -> None:
        item: dict[str, Any] = {
            "code": code,
            "severity": severity,
            "check": check,
            "outcome": outcome,
            "message": message,
            "next_step": next_step,
        }
        if path:
            item["path"] = path
        if position_id:
            item["position_id"] = position_id
        self.items.append(item)
        rendered = f"{position_id}: {message}" if position_id else message
        (self.errors if severity == "error" else self.warnings).append(rendered)

    def for_position(self, position_id: str) -> list[dict[str, Any]]:
        return [item for item in self.items if item.get("position_id") == position_id]


def report(**values: Any) -> dict[str, Any]:
    return values


def read_json(path: Path) -> tuple[Any | None, str | None]:
    try:
        return json.loads(path.read_text(encoding="utf-8")), None
    except Exception as exc:  # noqa: BLE001 - reported as input status
        return None, str(exc)


def legacy_result(data: dict[str, Any]) -> dict[str, Any]:
    catalog = data.get("catalog_index") if isinstance(data.get("catalog_index"), list) else []
    positions = data.get("positions") if isinstance(data.get("positions"), list) else []
    ids = {canon_id(item.get("id")) for item in catalog if isinstance(item, dict)}
    ids.discard(None)
    position_results = []
    for item in positions:
        item_id = canon_id(item.get("id")) if isinstance(item, dict) else None
        position_results.append({
            "id": item_id or "<missing-id>",
            "in_scope": None,
            "status": "legacy_unverified",
            "checks": {
                "structure": "legacy_unverified",
                "evidence_consistency": "unverified",
                "decision_consistency": "unverified",
            },
            "issues": ["LEGACY_SCHEMA"],
            "next_step": "migrate_to_schema_2",
        })
    issue = {
        "code": "LEGACY_SCHEMA",
        "severity": "error",
        "check": "structure",
        "outcome": "unverified",
        "message": "缺少 schema_version=2，只按 legacy/unverified 兼容读取，不满足新标准",
        "next_step": "补齐 schema v2 的目录身份、来源和逐项证据映射",
    }
    return report(
        passed=False,
        overall_status="legacy_unverified",
        compatibility={"mode": "legacy/unverified", "readable": True, "migration_required": True},
        checks={
            "structure": "legacy_unverified",
            "catalog_reconciliation": "unverified",
            "evidence_consistency": "unverified",
            "decision_consistency": "unverified",
            "coverage_attestation": "unverified",
        },
        coverage={
            "snapshot_consistency": "unverified",
            "official_completeness": "unproven",
            "attestation_check": "unresolved",
            "message": "旧记录可展示但不能宣称已验证",
        },
        counts={
            "catalog_total": len(catalog),
            "in_scope_catalog": sum(1 for item in catalog if isinstance(item, dict) and item.get("in_scope") is True),
            "positions_listed": len(positions),
            "positions_with_validated_evidence": 0,
            "recommended": 0,
            "pending": 0,
            "excluded": 0,
            "out_of_scope_explanations": 0,
        },
        positions=position_results,
        readiness={
            "status": "blocked",
            "can_show_verified_positions": False,
            "verified_position_ids": [],
            "registerable_position_ids": [],
            "selected_position_id": None,
            "selected_position_status": "invalid",
            "can_generate_full_comparison": False,
            "can_register_selected_position": False,
            "next_step": "migrate_to_schema_2",
            "unresolved": ["LEGACY_SCHEMA"],
        },
        issues=[issue],
        errors=[issue["message"]],
        warnings=[],
        company=data.get("company"),
        date=data.get("date"),
        mechanical_passed=False,
    )


def parse_catalog(raw: dict[str, Any], matching_path: Path, issues: Issues) -> dict[str, Any]:
    result: dict[str, Any] = {"status": "unverifiable", "ids": [], "duplicate_ids": [], "count": None}
    raw_file = resolve(matching_path, raw.get("file"))
    if raw_file is None:
        issues.add(
            "RAW_CATALOG_FILE_MISSING", "catalog_reconciliation",
            "raw_catalog.file 必须指向原始快照文件",
            "提供快照路径；缺少输入时保持覆盖待核验",
            path="raw_catalog.file", outcome="unverified",
        )
        return result
    if not raw_file.is_file():
        issues.add(
            "RAW_CATALOG_FILE_NOT_FOUND", "catalog_reconciliation",
            f"原始目录文件不存在：{raw.get('file')}",
            "修正快照路径；不存在的输入不能被当作已核验",
            path="raw_catalog.file",
        )
        result["status"] = "invalid"
        return result

    fmt = raw.get("format")
    records: list[Any] | None = None
    missing_id = False
    if fmt == "json":
        records_path, id_path = raw.get("records_path"), raw.get("id_path")
        if not isinstance(records_path, str) or not isinstance(id_path, str):
            issues.add(
                "RAW_ID_EXTRACTION_UNVERIFIABLE", "catalog_reconciliation",
                "JSON 原始目录缺少显式 records_path/id_path，拒绝猜测字段或按标题匹配",
                "填写 JSON Pointer 的 records_path 和 id_path",
                path="raw_catalog.id_path", outcome="unverified",
            )
            return result
        data, error = read_json(raw_file)
        if error:
            issues.add(
                "RAW_CATALOG_INVALID_JSON", "catalog_reconciliation",
                f"原始 JSON 无法解析：{error}",
                "修复或重新保存原始快照；损坏输入不能降级为 warning",
                path="raw_catalog.file",
            )
            result["status"] = "invalid"
            return result
        try:
            records = json_pointer(data, records_path)
        except (KeyError, IndexError, TypeError, ValueError) as error:
            issues.add(
                "RAW_RECORDS_PATH_INVALID", "catalog_reconciliation",
                f"records_path 无法定位岗位数组：{error}",
                "修正 records_path，不要用标题字段代替岗位 ID",
                path="raw_catalog.records_path",
            )
            result["status"] = "invalid"
            return result
        if not isinstance(records, list):
            issues.add(
                "RAW_RECORDS_NOT_ARRAY", "catalog_reconciliation",
                "records_path 定位到的内容不是岗位数组",
                "修正 records_path 或保存明确的记录数组",
                path="raw_catalog.records_path",
            )
            result["status"] = "invalid"
            return result
        ids: list[str] = []
        for index, item in enumerate(records):
            try:
                value = json_pointer(item, id_path)
            except (KeyError, IndexError, TypeError, ValueError):
                value = None
            item_id = canon_id(value)
            if item_id is None:
                missing_id = True
                issues.add(
                    "RAW_ID_MISSING", "catalog_reconciliation",
                    f"原始目录第 {index + 1} 条无法按显式 id_path 提取岗位 ID",
                    "补齐可靠岗位 ID 或保持覆盖待核验；不能凭标题补 ID",
                    path=f"raw_catalog.id_path[{index}]", outcome="unverified",
                )
            else:
                ids.append(item_id)
    elif fmt in {"csv", "tsv"}:
        id_column = raw.get("id_column")
        if not nonempty(id_column):
            issues.add(
                "RAW_ID_EXTRACTION_UNVERIFIABLE", "catalog_reconciliation",
                "CSV/TSV 原始目录缺少显式 id_column，拒绝猜测字段",
                "填写准确的 ID 列名",
                path="raw_catalog.id_column", outcome="unverified",
            )
            return result
        delimiter = raw.get("delimiter", "\t" if fmt == "tsv" else ",")
        if not isinstance(delimiter, str) or len(delimiter) != 1:
            issues.add(
                "RAW_DELIMITER_INVALID", "catalog_reconciliation",
                "CSV/TSV delimiter 必须是单字符",
                "修正 raw_catalog.delimiter",
                path="raw_catalog.delimiter",
            )
            result["status"] = "invalid"
            return result
        try:
            with raw_file.open("r", encoding=raw.get("encoding", "utf-8"), newline="") as handle:
                reader = csv.DictReader(handle, delimiter=delimiter)
                if not reader.fieldnames or id_column not in reader.fieldnames:
                    raise KeyError(id_column)
                records = list(reader)
        except KeyError:
            issues.add(
                "RAW_ID_COLUMN_NOT_FOUND", "catalog_reconciliation",
                f"原始目录不存在显式 ID 列：{id_column}",
                "核对 id_column；不能用标题列替代身份字段",
                path="raw_catalog.id_column", outcome="unverified",
            )
            return result
        except (OSError, UnicodeDecodeError, LookupError, TypeError, ValueError, csv.Error) as error:
            issues.add(
                "RAW_CATALOG_INVALID_TABLE", "catalog_reconciliation",
                f"原始表格无法解析：{error}",
                "修复编码/格式或重新保存原始快照",
                path="raw_catalog.file",
            )
            result["status"] = "invalid"
            return result
        ids = []
        for index, record in enumerate(records):
            item_id = canon_id(record.get(id_column))
            if item_id is None:
                missing_id = True
                issues.add(
                    "RAW_ID_MISSING", "catalog_reconciliation",
                    f"原始目录第 {index + 1} 条的显式 ID 为空",
                    "补齐可靠岗位 ID 或保持覆盖待核验",
                    path=f"raw_catalog.id_column[{index}]", outcome="unverified",
                )
            else:
                ids.append(item_id)
    else:
        issues.add(
            "RAW_FORMAT_UNSUPPORTED", "catalog_reconciliation",
            f"原始目录格式不受支持或未声明：{fmt!r}",
            "声明 json/csv/tsv 以及显式 ID 提取规则；否则保持覆盖待核验",
            path="raw_catalog.format", outcome="unverified",
        )
        return result

    result["count"] = len(records or [])
    result["ids"] = ids
    result["duplicate_ids"] = sorted(item_id for item_id, count in Counter(ids).items() if count > 1)
    if missing_id:
        result["status"] = "unverifiable"
        return result
    if result["duplicate_ids"]:
        issues.add(
            "RAW_DUPLICATE_IDS", "catalog_reconciliation",
            f"原始目录存在重复岗位 ID：{', '.join(result['duplicate_ids'])}",
            "先解决原始快照中的身份重复",
            path="raw_catalog",
        )
        result["status"] = "invalid"
        return result
    total = raw.get("total_positions")
    if not isinstance(total, int) or isinstance(total, bool) or total < 0:
        issues.add(
            "RAW_TOTAL_INVALID", "catalog_reconciliation",
            "raw_catalog.total_positions 必须是非负整数",
            "填写可核对的原始快照岗位总数",
            path="raw_catalog.total_positions",
        )
        result["status"] = "invalid"
        return result
    if total != result["count"]:
        issues.add(
            "RAW_TOTAL_MISMATCH", "catalog_reconciliation",
            f"声明总数 {total} 与原始快照记录数 {result['count']} 不一致",
            "重新核对快照记录数和 total_positions",
            path="raw_catalog.total_positions",
        )
        result["status"] = "mismatch"
        return result
    result["status"] = "parsed"
    return result


def source_entries(source: Any, kind: str, position_id: str, base: Path, issues: Issues) -> set[str]:
    name = "jd_source" if kind == "jd" else "candidate_source"
    prefix = f"positions[{position_id}].{name}"
    if not isinstance(source, dict):
        issues.add(
            "SOURCE_OBJECT_MISSING", "evidence_consistency", f"{kind} source 必须是对象",
            "提供共享来源记录并让 requirement 通过 ID 引用",
            path=prefix, position_id=position_id, outcome="unverified",
        )
        return set()
    snapshot = resolve(base, source.get("snapshot_file"))
    if snapshot is None or not snapshot.is_file():
        issues.add(
            "SOURCE_SNAPSHOT_MISSING", "evidence_consistency", f"{kind} source 的 snapshot_file 不存在",
            "提供本地正文快照；来源 URL 不能替代快照",
            path=f"{prefix}.snapshot_file", position_id=position_id, outcome="unverified",
        )
        return set()
    try:
        text = snapshot.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        issues.add(
            "SOURCE_SNAPSHOT_UNREADABLE", "evidence_consistency", f"{kind} source 快照无法读取：{error}",
            "修正快照编码或路径",
            path=f"{prefix}.snapshot_file", position_id=position_id, outcome="unverified",
        )
        return set()
    supplied_hash = source.get("sha256")
    if supplied_hash is not None:
        if not isinstance(supplied_hash, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", supplied_hash):
            issues.add(
                "SOURCE_HASH_INVALID", "evidence_consistency", f"{kind} source.sha256 格式无效",
                "填写真实 SHA-256 或删除哈希字段",
                path=f"{prefix}.sha256", position_id=position_id,
            )
        elif sha256(snapshot).lower() != supplied_hash.lower():
            issues.add(
                "SOURCE_HASH_MISMATCH", "evidence_consistency", f"{kind} source.sha256 与本地快照不一致",
                "重新生成哈希或指向正确快照版本",
                path=f"{prefix}.sha256", position_id=position_id,
            )
    if kind == "jd":
        if canon_id(source.get("position_id")) != position_id:
            issues.add(
                "JD_SOURCE_POSITION_MISMATCH", "evidence_consistency", "JD 来源的 position_id 与岗位记录不一致",
                "按岗位 ID 绑定正确 JD 来源",
                path=f"{prefix}.position_id", position_id=position_id,
            )
        for field in ("url", "read_at"):
            if not nonempty(source.get(field)):
                issues.add(
                    "JD_SOURCE_METADATA_MISSING", "evidence_consistency", f"JD 来源缺少 {field}",
                    "补齐来源 URL 和读取时间",
                    path=f"{prefix}.{field}", position_id=position_id, outcome="unverified",
                )
        entries = source.get("quotes")
    else:
        if not nonempty(source.get("profile_version")):
            issues.add(
                "CANDIDATE_SOURCE_VERSION_MISSING", "evidence_consistency", "候选人证据源缺少 profile_version",
                "引用有版本的候选人档案",
                path=f"{prefix}.profile_version", position_id=position_id, outcome="unverified",
            )
        entries = source.get("evidence")
    if not isinstance(entries, list) or (kind == "jd" and not entries):
        issues.add(
            "SOURCE_ENTRIES_MISSING", "evidence_consistency", f"{kind} source 必须包含可用的 {'quotes' if kind == 'jd' else 'evidence'} 数组",
            "在共享来源中保存原文条目；候选人无相关证据时可使用空 evidence 数组",
            path=f"{prefix}.{'quotes' if kind == 'jd' else 'evidence'}", position_id=position_id, outcome="unverified",
        )
        return set()

    ids: set[str] = set()
    normalized: dict[str, str] = {}
    lines = text.splitlines()
    for index, entry in enumerate(entries):
        entry_path = f"{prefix}.{'quotes' if kind == 'jd' else 'evidence'}[{index}]"
        if not isinstance(entry, dict) or not nonempty(entry.get("id")) or not nonempty(entry.get("text")):
            issues.add(
                "SOURCE_ENTRY_INVALID", "evidence_consistency", f"{kind} 引文条目必须包含非空 id/text",
                "补齐可引用的原文条目",
                path=entry_path, position_id=position_id, outcome="unverified",
            )
            continue
        entry_id = str(entry["id"]).strip()
        ids.add(entry_id)
        value = str(entry["text"])
        key = normalize(value)
        if entry_id in ids and sum(1 for item in entries[: index + 1] if isinstance(item, dict) and str(item.get("id", "")).strip() == entry_id) > 1:
            issues.add(
                "SOURCE_ENTRY_ID_DUPLICATE", "evidence_consistency", f"{kind} source 引文 ID 重复：{entry_id}",
                "为每条原文引文分配唯一 ID",
                path=f"{entry_path}.id", position_id=position_id,
            )
        if key in normalized:
            issues.add(
                "NORMALIZED_QUOTE_DUPLICATE", "evidence_consistency",
                f"{kind} source 存在规范化空白后重复的引文：{entry_id} 与 {normalized[key]}",
                "保留一条或补充真正不同的原文；不改写保存的引文",
                path=entry_path, position_id=position_id,
            )
        else:
            normalized[key] = entry_id
        locator = entry.get("locator")
        if locator is not None:
            start = locator.get("line_start") if isinstance(locator, dict) else None
            end = locator.get("line_end", start) if isinstance(locator, dict) else None
            if not isinstance(start, int) or isinstance(start, bool) or not isinstance(end, int) or isinstance(end, bool) or start < 1 or end < start or end > len(lines):
                issues.add(
                    "SOURCE_LOCATOR_INVALID", "evidence_consistency", "引文 locator 行号无效",
                    "修正 1-based line_start/line_end",
                    path=f"{entry_path}.locator", position_id=position_id,
                )
                continue
            haystack = normalize("\n".join(lines[start - 1 : end]))
        else:
            haystack = normalize(text)
        if key not in haystack:
            issues.add(
                "SOURCE_QUOTE_NOT_FOUND", "evidence_consistency", f"{kind} 引文不在声明的正文快照/定位范围内：{entry_id}",
                "修正 snapshot_file/locator 或重新复制同版本原文",
                path=f"{entry_path}.text", position_id=position_id,
            )
    return ids


def summary(requirements: list[dict[str, Any]]) -> dict[str, int]:
    def count(field: str, value: str) -> int:
        return sum(1 for item in requirements if isinstance(item, dict) and type(item.get(field)) is str and item.get(field) == value)

    return {
        "requirements_total": len(requirements),
        **{key: count("category", key) for key in ("hard_qualification", "core_capability", "plus", "ambiguous")},
        "core_total": count("category", "hard_qualification") + count("category", "core_capability"),
        **{key: count("support", key) for key in ("direct_support", "transferable", "no_evidence", "conflict")},
        **{key: count("conclusion", key) for key in ("satisfied", "not_satisfied", "pending")},
    }


def evaluate_decision_policy(requirements: list[Any], state: Any, position_id: str, issues: Issues) -> dict[str, Any]:
    """Apply the finite decision-state policy once for a multi-requirement role."""
    hard_pending = any(
        item.get("category") == "hard_qualification" and item.get("conclusion") == "pending"
        for item in requirements if isinstance(item, dict)
    )
    hard_failed = any(
        item.get("category") == "hard_qualification" and item.get("conclusion") == "not_satisfied"
        for item in requirements if isinstance(item, dict)
    )
    core_failed = any(
        type(item.get("category")) is str
        and item.get("category") in {"hard_qualification", "core_capability"}
        and item.get("conclusion") == "not_satisfied"
        for item in requirements if isinstance(item, dict)
    )
    core_pending_items = [
        item for item in requirements
        if isinstance(item, dict)
        and type(item.get("category")) is str
        and item.get("category") in {"hard_qualification", "core_capability"}
        and item.get("conclusion") == "pending"
    ]
    core_pending_supports = [item.get("support") for item in core_pending_items]
    core_pending = bool(core_pending_items)
    direct_core = any(
        type(item.get("category")) is str
        and item.get("category") in {"hard_qualification", "core_capability"}
        and item.get("support") == "direct_support"
        for item in requirements if isinstance(item, dict)
    )
    state_valid = type(state) is str and state in DECISIONS
    if state == "recommended" and (hard_pending or hard_failed or core_failed or core_pending or not direct_core):
        issues.add(
            "RECOMMENDATION_NOT_SUPPORTED", "decision_consistency",
            "recommended 不能含待确认/失败的硬/核心要求，且需至少一项直接支持证据",
            "改为 pending/consider/excluded，或补齐并核实逐项证据",
            path="positions[].decision.state", position_id=position_id,
        )
    if state_valid and state in {"recommended", "consider"} and (hard_pending or hard_failed):
        issues.add(
            "HARD_QUALIFICATION_UNRESOLVED", "decision_consistency",
            "硬资格待确认/不满足时不能进入推荐或考虑",
            "保持 pending 或 excluded，先核实硬资格",
            path="positions[].decision.state", position_id=position_id,
        )
    if state == "consider" and (
        hard_pending
        or hard_failed
        or core_failed
        or not core_pending_items
        or any(support != "transferable" for support in core_pending_supports)
    ):
        issues.add(
            "DECISION_STATE_MISMATCH", "decision_consistency",
            "consider 只适用于硬资格已满足且所有核心缺口均为 transferable + pending",
            "核心明确不满足、无证据或冲突保持 pending；没有核心待确认项不能标 consider",
            path="positions[].decision.state", position_id=position_id,
        )
    if state == "pending":
        unresolved = hard_pending or hard_failed or core_failed or core_pending
        if not unresolved or (
            not hard_pending
            and not hard_failed
            and not core_failed
            and core_pending_items
            and all(support == "transferable" for support in core_pending_supports)
        ):
            issues.add(
                "DECISION_STATE_MISMATCH", "decision_consistency",
                "pending 只用于保留未解决事实；硬资格待确认可 pending，核心全为可迁移待确认时应 consider",
                "按要求结果选择 pending 或 consider；不要用标签改变登记许可",
                path="positions[].decision.state", position_id=position_id,
            )
    return {
        "hard_pending": hard_pending,
        "hard_failed": hard_failed,
        "core_failed": core_failed,
        "core_pending": core_pending,
        "direct_core": direct_core,
    }


def validate_position(position: Any, catalog_entry: dict[str, Any] | None, base: Path, issues: Issues) -> dict[str, Any]:
    position_id = canon_id(position.get("id")) if isinstance(position, dict) else None
    position_id = position_id or "<missing-id>"
    start = len(issues.items)
    if catalog_entry is None:
        issues.add(
            "POSITION_ID_NOT_IN_CATALOG", "structure", "岗位 ID 不在 catalog_index 中",
            "使用原始目录中的稳定岗位 ID；不要凭空创建岗位",
            path="positions[].id", position_id=position_id,
        )
        catalog_entry = {"in_scope": True}
    if not isinstance(position, dict):
        issues.add(
            "POSITION_NOT_OBJECT", "structure", "positions 条目必须是对象",
            "修正记录结构", position_id=position_id,
        )
        return finalize_position(position_id, True, "failed", issues, start, None)
    if not position_id or position_id == "<missing-id>":
        issues.add(
            "POSITION_ID_MISSING", "structure", "positions 条目缺少岗位 ID",
            "使用 catalog_index 中的稳定岗位 ID", path="positions[].id", position_id=position_id,
        )
    in_scope = catalog_entry.get("in_scope") is True
    decision = position.get("decision")
    state = decision.get("state") if isinstance(decision, dict) else None
    state_valid = type(state) is str and state in DECISIONS
    if not state_valid:
        issues.add(
            "DECISION_INVALID", "decision_consistency", "decision.state 枚举值无效",
            "使用 recommended/consider/pending/excluded/not_applicable，并由 summary 汇总产生",
            path="positions[].decision.state", position_id=position_id,
        )
    elif not nonempty(decision.get("reason")) or decision.get("basis") != "requirement_summary":
        issues.add(
            "DECISION_BASIS_MISSING", "decision_consistency", "decision 必须有 reason 且 basis=requirement_summary",
            "从逐项 requirements 产生决策，不先写等级再补理由",
            path="positions[].decision", position_id=position_id,
        )

    if "excluded" in position and type(position.get("excluded")) is not bool:
        issues.add(
            "POSITION_FIELD_INVALID", "structure", "positions[].excluded 必须是布尔值",
            "使用 true/false，不要用字符串或数字替代布尔值", path="positions[].excluded", position_id=position_id,
        )
    excluded = position.get("excluded") is True
    if not in_scope:
        if not excluded or state != "not_applicable":
            issues.add(
                "SCOPE_DECISION_CONFLICT", "decision_consistency",
                "范围外岗位只能作为解释记录保留，必须 excluded=true 且 decision.state=not_applicable",
                "不要把范围外岗位计入有效匹配或推荐",
                path="positions[].excluded", position_id=position_id,
            )
        return finalize_position(position_id, False, "verified", issues, start, "not_counted_as_match")
    for field in ("title", "city"):
        if not nonempty(position.get(field)):
            issues.add(
                "POSITION_FIELD_INVALID", "structure", f"范围内岗位缺少非空 {field}",
                "补齐与目录身份对应的岗位标题和地点", path=f"positions[].{field}", position_id=position_id,
            )
    if excluded and state != "excluded":
        issues.add(
            "EXCLUSION_DECISION_CONFLICT", "decision_consistency", "范围内被排除岗位必须 decision.state=excluded",
            "补充排除理由或取消 excluded 并完成匹配", path="positions[].decision.state", position_id=position_id,
        )
    if state_valid and not excluded and state in {"excluded", "not_applicable"}:
        issues.add(
            "MATCH_DECISION_CONFLICT", "decision_consistency", "范围内未排除岗位不能使用 excluded/not_applicable",
            "根据 requirements 选择 recommended/consider/pending", path="positions[].decision.state", position_id=position_id,
        )
    if excluded and not nonempty(position.get("exclusion_reason")):
        issues.add(
            "EXCLUSION_REASON_MISSING", "decision_consistency", "排除岗位必须有 exclusion_reason",
            "写明硬条件、用户偏好或其他可追溯排除依据", path="positions[].exclusion_reason", position_id=position_id,
        )

    jd_ids = source_entries(position.get("jd_source"), "jd", position_id, base, issues)
    candidate_ids = source_entries(position.get("candidate_source"), "candidate", position_id, base, issues)
    requirements = position.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        issues.add(
            "REQUIREMENTS_MISSING", "evidence_consistency", "范围内岗位必须有非空 requirements",
            "逐条记录要求类别、JD 引文 ID、候选证据 ID、支持关系和结论",
            path="positions[].requirements", position_id=position_id, outcome="unverified",
        )
        return finalize_position(position_id, True, "unverified", issues, start, "complete_requirement_mapping")

    requirement_ids: set[str] = set()
    for index, item in enumerate(requirements):
        path = f"positions[{position_id}].requirements[{index}]"
        if not isinstance(item, dict):
            issues.add(
                "REQUIREMENT_INVALID", "evidence_consistency", "requirement 必须是对象",
                "补齐逐项要求记录", path=path, position_id=position_id,
            )
            continue
        raw_requirement_id = item.get("requirement_id")
        requirement_id = raw_requirement_id.strip() if isinstance(raw_requirement_id, str) else ""
        if not requirement_id or requirement_id in requirement_ids:
            issues.add(
                "REQUIREMENT_ID_INVALID", "evidence_consistency", "requirement_id 必须非空且岗位内唯一",
                "为每条岗位要求分配稳定唯一 ID", path=f"{path}.requirement_id", position_id=position_id,
            )
        requirement_ids.add(requirement_id)
        for field in ("text", "judgment"):
            if not nonempty(item.get(field)):
                issues.add(
                    "REQUIREMENT_FIELD_MISSING", "evidence_consistency", f"requirement 缺少 {field}",
                    "保留要求原文语义和该项判断", path=f"{path}.{field}", position_id=position_id, outcome="unverified",
                )
        category, conclusion, support = item.get("category"), item.get("conclusion"), item.get("support")
        category_valid = type(category) is str and category in CATEGORIES
        conclusion_valid = type(conclusion) is str and conclusion in CONCLUSIONS
        support_valid = type(support) is str and support in SUPPORTS
        if not category_valid:
            issues.add(
                "REQUIREMENT_CATEGORY_INVALID", "evidence_consistency", "requirement.category 枚举值无效",
                "按 JD 原文分类；语义不明确使用 ambiguous", path=f"{path}.category", position_id=position_id,
            )
        if not conclusion_valid:
            issues.add(
                "REQUIREMENT_CONCLUSION_INVALID", "evidence_consistency", "requirement.conclusion 枚举值无效",
                "使用 satisfied/not_satisfied/pending", path=f"{path}.conclusion", position_id=position_id,
            )
        if not support_valid:
            issues.add(
                "REQUIREMENT_SUPPORT_INVALID", "evidence_consistency", "requirement.support 枚举值无效",
                "使用 direct_support/transferable/no_evidence/conflict", path=f"{path}.support", position_id=position_id,
            )
        if not conclusion_valid or not support_valid:
            issues.add(
                "REQUIREMENT_JUDGMENT_INVALID", "evidence_consistency", "requirement conclusion/support 枚举值无效",
                "分别填写 satisfied/not_satisfied/pending 与支持关系", path=path, position_id=position_id,
            )
        jd_refs, category_refs, candidate_refs = item.get("jd_quote_ids"), item.get("category_basis_quote_ids"), item.get("candidate_evidence_ids")
        for field, refs, known, missing_code, message in (
            ("jd_quote_ids", jd_refs, jd_ids, "JD_QUOTE_REFERENCE_UNKNOWN", "每条 requirement 必须引用该岗位的 JD 引文 ID"),
            ("category_basis_quote_ids", category_refs, jd_ids, "CATEGORY_BASIS_UNKNOWN", "要求类别必须引用该岗位的 JD 引文 ID"),
            ("candidate_evidence_ids", candidate_refs, candidate_ids, "CANDIDATE_EVIDENCE_REFERENCE_UNKNOWN", "候选人证据引用必须属于当前档案版本"),
        ):
            references_valid = (
                isinstance(refs, list)
                and (field == "candidate_evidence_ids" or bool(refs))
                and all(isinstance(ref, str) and bool(ref.strip()) for ref in refs)
            )
            if not references_valid:
                issues.add(
                    "REQUIREMENT_REFERENCE_MISSING", "evidence_consistency", message,
                    "补齐共享来源中的 ID；无候选证据使用空数组+pending",
                    path=f"{path}.{field}", position_id=position_id, outcome="unverified",
                )
                if isinstance(refs, list) and any(not isinstance(ref, str) or not ref.strip() for ref in refs):
                    issues.add(
                        "REQUIREMENT_REFERENCE_TYPE_INVALID", "evidence_consistency", "引用 ID 必须是非空字符串",
                        "不要把数字或空值强制转换成来源 ID；引用同一岗位/版本中保存的字符串 ID",
                        path=f"{path}.{field}", position_id=position_id,
                    )
            elif any(ref not in known for ref in refs):
                issues.add(
                    missing_code, "evidence_consistency", message,
                    "只引用同一岗位/版本来源中已核验的 ID",
                    path=f"{path}.{field}", position_id=position_id,
                )
        candidate_refs = candidate_refs if isinstance(candidate_refs, list) else []
        if support == "no_evidence" and candidate_refs:
            issues.add(
                "NO_EVIDENCE_HAS_REFERENCES", "evidence_consistency", "support=no_evidence 时候选证据数组必须为空",
                "无证据保持空引用和 pending", path=f"{path}.candidate_evidence_ids", position_id=position_id,
            )
        if support_valid and support in {"direct_support", "transferable", "conflict"} and not candidate_refs:
            issues.add(
                "SUPPORT_WITHOUT_EVIDENCE", "evidence_consistency", f"support={support} 必须有候选证据引用",
                "补充证据 ID，或改为 no_evidence+pending", path=f"{path}.candidate_evidence_ids", position_id=position_id,
            )
        if conclusion == "satisfied" and not candidate_refs:
            issues.add(
                "SATISFIED_WITHOUT_EVIDENCE", "evidence_consistency", "肯定结论 satisfied 必须有候选人证据",
                "补充可定位证据；没有证据只能 pending", path=f"{path}.conclusion", position_id=position_id,
            )
        if conclusion == "not_satisfied" and support == "no_evidence":
            issues.add(
                "NO_EVIDENCE_NOT_FAILURE", "evidence_consistency", "无证据不能直接推出 not_satisfied",
                "改为 pending，或提供明确不满足/冲突证据", path=f"{path}.conclusion", position_id=position_id,
            )
        allowed_conclusions = {
            "direct_support": {"satisfied", "pending"},
            "transferable": {"pending"},
            "no_evidence": {"pending"},
            "conflict": {"pending", "not_satisfied"},
        }
        if support_valid and conclusion_valid and conclusion not in allowed_conclusions[support]:
            issues.add(
                "SUPPORT_CONCLUSION_CONFLICT", "evidence_consistency",
                f"support={support} 不允许与 conclusion={conclusion} 组合",
                "冲突不得 satisfied；可迁移/无证据必须 pending；不满足需有冲突或明确失败依据",
                path=path, position_id=position_id,
            )
        if category_valid and category == "ambiguous" and conclusion != "pending":
            issues.add(
                "AMBIGUOUS_NOT_PENDING", "evidence_consistency", "语义不明确的要求必须保持 conclusion=pending",
                "先核实 JD 语义，不要升级为满足或不满足", path=f"{path}.conclusion", position_id=position_id,
            )

    expected = summary([item for item in requirements if isinstance(item, dict)])
    supplied = position.get("requirement_summary")
    if not isinstance(supplied, dict):
        issues.add(
            "REQUIREMENT_SUMMARY_MISSING", "decision_consistency", "必须提供由 requirements 计算的 requirement_summary",
            "展示核心总数、直接支持、可迁移、待确认和明确不满足数量",
            path="positions[].requirement_summary", position_id=position_id,
        )
    else:
        for field, value in expected.items():
            actual = supplied.get(field)
            if type(actual) is not int:
                issues.add(
                    "SUMMARY_FIELD_TYPE_INVALID", "decision_consistency",
                    f"requirement_summary.{field} 必须是整数，不能使用布尔值、数字字符串或空值",
                    "使用由 requirements 统计得到的整数计数",
                    path=f"positions[].requirement_summary.{field}", position_id=position_id,
                )
            elif actual != value:
                issues.add(
                    "REQUIREMENT_SUMMARY_MISMATCH", "decision_consistency", f"requirement_summary.{field} 应为 {value}",
                    "从逐项 requirements 重新计算汇总，不手工填匹配度",
                    path=f"positions[].requirement_summary.{field}", position_id=position_id,
                )

    policy = evaluate_decision_policy(requirements, state, position_id, issues)
    hard_pending = policy["hard_pending"]
    hard_failed = policy["hard_failed"]
    core_failed = policy["core_failed"]
    core_pending = policy["core_pending"]
    direct_core = policy["direct_core"]
    grade = position.get("grade")
    if "grade" in position and (type(grade) is not str or grade not in GRADES):
        issues.add(
            "GRADE_INVALID", "decision_consistency", "grade 只能是 S/A/B/C",
            "优先使用 requirement_summary；如保留等级请修正枚举值",
            path="positions[].grade", position_id=position_id,
        )
    elif grade == "S" and (core_pending or core_failed or not direct_core):
        issues.add(
            "GRADE_RULE_MISMATCH", "decision_consistency", "S 级要求硬/核心要求均满足且至少一项直接支持",
            "改等级或先解决待确认/不满足项", path="positions[].grade", position_id=position_id,
        )
    elif grade == "A" and (hard_pending or hard_failed or core_failed):
        issues.add(
            "GRADE_RULE_MISMATCH", "decision_consistency", "A 级不能含待确认/不满足的硬资格或明确不满足的核心能力",
            "改为 B/C 或先补证据核实", path="positions[].grade", position_id=position_id,
        )
    elif grade == "B" and state == "recommended":
        issues.add(
            "GRADE_RULE_MISMATCH", "decision_consistency", "B 级不能直接标记 recommended",
            "改为 consider/pending 或提升到符合规则的等级", path="positions[].grade", position_id=position_id,
        )
    elif grade == "C" and not (hard_pending or hard_failed or core_failed):
        issues.add(
            "GRADE_RULE_MISMATCH", "decision_consistency", "C 级应有硬/核心待确认或明确不满足依据",
            "改等级或补充明确缺口", path="positions[].grade", position_id=position_id,
        )
    if "coverage_estimate" in position:
        issues.add(
            "LEGACY_COVERAGE_FIELD_IGNORED", "decision_consistency", "coverage_estimate 不参与新格式推荐",
            "使用 requirement_summary；旧字段仅保留供读取",
            path="positions[].coverage_estimate", position_id=position_id, severity="warning", outcome="unverified",
        )
    result = finalize_position(position_id, True, None, issues, start, None)
    result["requirement_summary"] = expected
    if result["status"] == "verified" and state == "pending":
        result["next_step"] = "resolve_pending_requirements"
    elif result["status"] == "verified" and state == "excluded":
        result["next_step"] = "retain_exclusion_reason"
    return result


def finalize_position(position_id: str, in_scope: bool, forced_status: str | None, issues: Issues, start: int, next_step: str | None) -> dict[str, Any]:
    own = issues.items[start:]
    if forced_status:
        status = forced_status
    elif any(item.get("outcome") == "failed" for item in own):
        status = "failed"
    elif any(item.get("outcome") == "unverified" for item in own):
        status = "unverified"
    else:
        status = "verified"
    checks: dict[str, str] = {}
    for check in ("structure", "evidence_consistency", "decision_consistency"):
        relevant = [item for item in own if item.get("check") == check]
        if not relevant:
            checks[check] = "not_applicable" if check == "evidence_consistency" and not in_scope else "passed"
        elif any(item.get("outcome") == "failed" for item in relevant):
            checks[check] = "failed"
        elif any(item.get("outcome") == "unverified" for item in relevant):
            checks[check] = "unverified"
        else:
            checks[check] = "passed"
    if next_step is None:
        next_step = "user_review_before_tracker_registration" if status == "verified" else "resolve_position_issues"
    return {
        "id": position_id,
        "in_scope": in_scope,
        "status": status,
        "checks": checks,
        "issues": [item["code"] for item in own],
        "next_step": next_step,
    }


def validate_v2(data: dict[str, Any], matching_path: Path) -> tuple[dict[str, Any], int]:
    issues = Issues()
    structure_ok = True
    selected_position_id = data.get("selected_position_id") if "selected_position_id" in data else None
    if "selected_position_id" in data and (type(selected_position_id) is not str or not selected_position_id.strip()):
        issues.add(
            "SELECTED_POSITION_ID_INVALID", "structure",
            "selected_position_id 必须是非空字符串",
            "将用户选中的稳定岗位 ID 作为字符串传入；未选择时省略该字段",
            path="selected_position_id",
        )
        structure_ok = False
    for field in ("company", "date", "scope", "coverage", "raw_catalog", "catalog_index", "positions"):
        if field not in data:
            issues.add("ROOT_FIELD_MISSING", "structure", f"缺少根字段：{field}", "按 schema v2 补齐记录结构", path=field)
            structure_ok = False
    for field in ("company", "date", "scope"):
        if not nonempty(data.get(field)):
            issues.add("ROOT_FIELD_INVALID", "structure", f"{field} 必须是非空字符串", "修正根字段", path=field)
            structure_ok = False
    catalog = data.get("catalog_index") if isinstance(data.get("catalog_index"), list) else []
    positions = data.get("positions") if isinstance(data.get("positions"), list) else []
    raw = data.get("raw_catalog") if isinstance(data.get("raw_catalog"), dict) else {}
    if not isinstance(data.get("catalog_index"), list):
        issues.add("CATALOG_INDEX_INVALID", "structure", "catalog_index 必须是对象数组", "提供完整目录索引", path="catalog_index")
        structure_ok = False
    if not isinstance(data.get("positions"), list):
        issues.add("POSITIONS_INVALID", "structure", "positions 必须是对象数组", "提供逐岗匹配记录", path="positions")
        structure_ok = False
    if not isinstance(data.get("raw_catalog"), dict):
        issues.add("RAW_CATALOG_INVALID", "structure", "raw_catalog 必须是对象", "提供原始目录和显式身份规则", path="raw_catalog")
        structure_ok = False
    if "coverage" in data and not isinstance(data.get("coverage"), dict):
        issues.add("COVERAGE_INVALID", "structure", "coverage 必须是对象", "提供 capture_status 及其覆盖声明字段", path="coverage")
        structure_ok = False

    catalog_map: dict[str, dict[str, Any]] = {}
    for index, item in enumerate(catalog):
        path = f"catalog_index[{index}]"
        if not isinstance(item, dict):
            issues.add("CATALOG_ENTRY_INVALID", "structure", "catalog_index 条目必须是对象", "修正目录索引条目", path=path)
            structure_ok = False
            continue
        item_id = canon_id(item.get("id"))
        if item_id is None or not nonempty(item.get("title")) or type(item.get("in_scope")) is not bool:
            issues.add("CATALOG_ENTRY_FIELDS_INVALID", "structure", "目录条目必须有非空 id/title 和布尔 in_scope", "补齐目录索引字段", path=path)
            structure_ok = False
            continue
        if item_id in catalog_map:
            issues.add("CATALOG_DUPLICATE_IDS", "catalog_reconciliation", f"catalog_index 存在重复岗位 ID：{item_id}", "每个岗位在 catalog_index 中只保留一条", path=path)
        catalog_map[item_id] = item
        if "city" in item and not isinstance(item.get("city"), str):
            issues.add("CATALOG_ENTRY_FIELDS_INVALID", "structure", "目录条目的 city 必须是字符串", "修正目录条目地点字段", path=f"{path}.city")
            structure_ok = False
        if "url" in item and not isinstance(item.get("url"), str):
            issues.add("CATALOG_ENTRY_FIELDS_INVALID", "structure", "目录条目的 url 必须是字符串", "修正目录条目来源链接字段", path=f"{path}.url")
            structure_ok = False
        if "exclusion" in item and not isinstance(item.get("exclusion"), str):
            issues.add("CATALOG_ENTRY_FIELDS_INVALID", "structure", "目录条目的 exclusion 必须是字符串", "修正范围外岗位的排除说明", path=f"{path}.exclusion")
            structure_ok = False
        if item.get("in_scope") is False and not nonempty(item.get("exclusion")):
            issues.add("CATALOG_SCOPE_REASON_MISSING", "structure", "范围外目录条目必须有 exclusion 解释", "说明不在本次研究范围的原因", path=f"{path}.exclusion")
            structure_ok = False

    raw_result = parse_catalog(raw, matching_path, issues)
    catalog_ids = set(catalog_map)
    raw_ids = set(raw_result["ids"])
    missing = sorted(raw_ids - catalog_ids)
    extra = sorted(catalog_ids - raw_ids)
    catalog_index_reconciliation_failed = any(
        item.get("check") == "catalog_reconciliation" and item.get("outcome") == "failed"
        for item in issues.items
    )
    if raw_result["status"] == "parsed":
        if missing or extra:
            issues.add(
                "CATALOG_ID_SET_MISMATCH", "catalog_reconciliation",
                f"原始目录与 catalog_index ID 集合不一致；原始有而索引缺失={missing or []}，索引有而原始缺失={extra or []}",
                "按岗位 ID 对齐目录；不能只看数量或按标题匹配", path="catalog_index",
            )
        if catalog_index_reconciliation_failed:
            catalog_status = "invalid"
        elif missing or extra:
            catalog_status = "mismatch"
        else:
            catalog_status = "verified"
    else:
        catalog_status = raw_result["status"]
        if catalog_status == "unverifiable" and catalog_map:
            issues.add(
                "CATALOG_IDENTITY_UNVERIFIABLE", "catalog_reconciliation", "无法可靠提取原始目录岗位身份，覆盖标记为待核验",
                "补充显式 ID 提取规则或人工核对身份集合", path="raw_catalog", outcome="unverified",
            )

    coverage = data.get("coverage") if isinstance(data.get("coverage"), dict) else {}
    capture = coverage.get("capture_status")
    coverage_start = len(issues.items)
    if type(capture) is not str or capture not in CAPTURE_STATES:
        issues.add("COVERAGE_STATUS_INVALID", "coverage", "coverage.capture_status 必须是 complete/partial/unknown", "明确目录覆盖状态", path="coverage.capture_status", outcome="unverified")
        capture = "unknown"
    official_total = coverage.get("official_total")
    attested = coverage.get("human_attested") is True
    coverage_valid = True
    if capture == "complete":
        if coverage.get("last_page_reached") is not True:
            issues.add("COVERAGE_LAST_PAGE_UNCONFIRMED", "coverage", "complete 必须有 last_page_reached=true", "补充最后一页/API 穷尽证据或改为 partial/unknown", path="coverage.last_page_reached", outcome="unverified")
            coverage_valid = False
        if not isinstance(official_total, int) or isinstance(official_total, bool) or official_total < 0:
            issues.add("COVERAGE_OFFICIAL_TOTAL_MISSING", "coverage", "complete 必须提供官方总数 official_total", "补充官方总数来源", path="coverage.official_total", outcome="unverified")
            coverage_valid = False
        elif official_total != len(catalog_map):
            issues.add("COVERAGE_OFFICIAL_TOTAL_MISMATCH", "coverage", f"official_total={official_total} 与 catalog_index 数量 {len(catalog_map)} 不一致", "重新核对官方总数与目录快照", path="coverage.official_total")
            coverage_valid = False
        if not attested:
            issues.add("COVERAGE_HUMAN_ATTESTATION_MISSING", "coverage", "完整目录仍需人工确认抓取范围", "人工核对官方总数/最后一页后设置 human_attested=true", path="coverage.human_attested", severity="warning", outcome="unverified")
            coverage_valid = False
    else:
        issues.add("COVERAGE_NOT_COMPLETE", "coverage", "目录覆盖不是 complete，不能宣称官网岗位已抓全", "补齐快照和穷尽证据，或只展示已核实岗位", path="coverage.capture_status", severity="warning", outcome="unverified")
        coverage_valid = False
    coverage_report = {
        "capture_status": capture,
        "official_total": official_total,
        "human_attested": attested,
        "snapshot_consistency": catalog_status,
        "official_completeness": "attested_not_independently_proven" if coverage_valid else "unproven",
        "message": "ID/数量对账只证明与所提供快照一致，不自动证明官网岗位已经抓全",
        "attestation_check": "passed_for_human_review" if coverage_valid else "unresolved",
    }

    in_scope_ids = {item_id for item_id, item in catalog_map.items() if item.get("in_scope") is True}
    position_map: dict[str, dict[str, Any]] = {}
    duplicate_position_ids: set[str] = set()
    for item in positions:
        item_id = canon_id(item.get("id")) if isinstance(item, dict) else None
        if item_id is not None:
            if item_id in position_map:
                duplicate_position_ids.add(item_id)
            position_map[item_id] = item
    if duplicate_position_ids:
        issues.add("POSITIONS_DUPLICATE_IDS", "structure", f"positions 存在重复岗位 ID：{', '.join(sorted(duplicate_position_ids))}", "每个岗位在 positions 中只保留一条", path="positions")
        structure_ok = False
    missing_positions = sorted(in_scope_ids - set(position_map))
    if missing_positions:
        issues.add("IN_SCOPE_POSITION_MISSING", "evidence_consistency", f"范围内岗位未出现在 positions：{', '.join(missing_positions)}", "逐个补齐范围内岗位的证据映射；已核实岗位仍可展示", path="positions", outcome="unverified")

    position_results = []
    for item in positions:
        item_id = canon_id(item.get("id")) if isinstance(item, dict) else None
        position_results.append(validate_position(item, catalog_map.get(item_id) if item_id else None, matching_path, issues))
    # Add non-position structural issues (e.g. duplicate IDs) to affected rows.
    for result in position_results:
        own = issues.for_position(result["id"])
        result["issues"] = [item["code"] for item in own]
        if any(item.get("outcome") == "failed" for item in own):
            result["status"] = "failed"
        elif result["status"] == "verified" and any(item.get("outcome") == "unverified" for item in own):
            result["status"] = "unverified"

    position_by_id = {result["id"]: result for result in position_results}
    if isinstance(selected_position_id, str) and selected_position_id not in position_by_id:
        issues.add(
            "SELECTED_POSITION_NOT_FOUND", "decision_consistency",
            f"selected_position_id 不在 positions 中：{selected_position_id}",
            "核对用户选择的岗位 ID，并只允许从本次报告中的岗位中选择",
            path="selected_position_id",
        )

    verified_ids = [result["id"] for result in position_results if result["in_scope"] is True and result["status"] == "verified"]
    all_positions_valid = not missing_positions and all(result["status"] == "verified" for result in position_results if result["in_scope"] is True)
    structure_status = "failed" if structure_ok is False or any(item["check"] == "structure" and item["outcome"] == "failed" for item in issues.items) else "passed"
    evidence_status = "failed" if any(item["check"] == "evidence_consistency" and item["outcome"] == "failed" for item in issues.items) else "unverified" if any(item["check"] == "evidence_consistency" and item["outcome"] == "unverified" for item in issues.items) else "passed"
    decision_status = "failed" if any(item["check"] == "decision_consistency" and item["outcome"] == "failed" for item in issues.items) else "passed"
    mechanical_passed = structure_status == "passed" and catalog_status == "verified" and evidence_status == "passed" and decision_status == "passed"
    full_ready = mechanical_passed and all_positions_valid and coverage_valid
    recommended = sum(1 for item_id, item in position_map.items() if item_id in position_by_id and position_by_id[item_id]["status"] == "verified" and isinstance(item.get("decision"), dict) and item["decision"].get("state") == "recommended" and item.get("excluded") is not True and item_id in in_scope_ids)
    pending = sum(1 for item_id, item in position_map.items() if item_id in in_scope_ids and isinstance(item.get("decision"), dict) and item["decision"].get("state") == "pending")
    excluded = sum(1 for item_id, item in position_map.items() if item_id in in_scope_ids and item.get("excluded") is True)
    counts = {
        "catalog_total": len(catalog_map),
        "in_scope_catalog": len(in_scope_ids),
        "positions_listed": len(positions),
        "positions_with_validated_evidence": len(verified_ids),
        "recommended": recommended,
        "pending": pending,
        "excluded": excluded,
        "out_of_scope_explanations": sum(1 for result in position_results if result["in_scope"] is False),
        "missing_in_scope_positions": len(missing_positions),
        "raw_catalog_total": raw_result.get("count"),
    }
    registerable_position_ids = [] if not full_ready else [
        result["id"] for result in position_results
        if result["id"] in position_map
        and result["status"] == "verified"
        and result["in_scope"] is True
        and isinstance(position_map[result["id"]].get("decision"), dict)
        and position_map[result["id"]]["decision"].get("state") in {"recommended", "consider"}
        and position_map[result["id"]].get("excluded") is not True
    ]
    if selected_position_id is None:
        selected_position_status = "selection_required"
    elif not isinstance(selected_position_id, str) or not selected_position_id.strip():
        selected_position_status = "invalid"
    elif selected_position_id not in position_by_id:
        selected_position_status = "unknown"
    elif selected_position_id in registerable_position_ids:
        selected_position_status = "registerable"
    else:
        selected_position_status = "not_registerable"
    can_register = selected_position_status == "registerable" and selected_position_id in registerable_position_ids
    if not full_ready:
        next_step = "review_verified_positions_only" if verified_ids else "resolve_unresolved_checks"
    elif selected_position_status == "selection_required":
        next_step = "select_position_from_registerable_ids"
    elif selected_position_status == "registerable":
        next_step = "user_review_and_register_selected_position"
    else:
        next_step = "selected_position_not_registerable"
    readiness = {
        "status": "ready_for_human_review" if full_ready else "partial" if verified_ids else "blocked",
        "can_show_verified_positions": bool(verified_ids),
        "verified_position_ids": verified_ids,
        "registerable_position_ids": registerable_position_ids,
        "selected_position_id": selected_position_id,
        "selected_position_status": selected_position_status,
        "can_generate_full_comparison": full_ready,
        "can_register_selected_position": can_register,
        "next_step": next_step,
        "unresolved": sorted({item["code"] for item in issues.items if item["severity"] in {"error", "warning"}}),
        "message": "可展示单岗核验结果不等于全量比较完成；可进入下一步也不等于语义推荐一定正确",
    }
    result = report(
        passed=full_ready,
        overall_status="complete" if full_ready else "partial" if verified_ids else "failed",
        compatibility={"mode": "schema-v2", "readable": True, "migration_required": False},
        checks={
            "structure": structure_status,
            "catalog_reconciliation": catalog_status,
            "evidence_consistency": evidence_status,
            "decision_consistency": decision_status,
            "coverage_attestation": "passed" if coverage_valid else "unverified",
        },
        coverage=coverage_report,
        counts=counts,
        positions=position_results,
        readiness=readiness,
        issues=issues.items,
        errors=issues.errors,
        warnings=issues.warnings,
        company=data.get("company"),
        date=data.get("date"),
        mechanical_passed=mechanical_passed,
        catalog_identity={"raw_ids": sorted(raw_ids), "catalog_ids": sorted(catalog_ids), "missing_in_catalog": missing, "extra_in_catalog": extra, "raw_duplicate_ids": raw_result.get("duplicate_ids", [])},
    )
    return result, 0 if full_ready else 1


def invalid_input_report(message: str) -> dict[str, Any]:
    return report(
        passed=False,
        overall_status="failed",
        compatibility={"mode": "unreadable", "readable": False, "migration_required": False},
        checks={
            "structure": "failed",
            "catalog_reconciliation": "not_run",
            "evidence_consistency": "not_run",
            "decision_consistency": "not_run",
            "coverage_attestation": "not_run",
        },
        coverage={
            "snapshot_consistency": "not_run",
            "official_completeness": "unproven",
            "attestation_check": "not_run",
            "message": "输入 JSON 无法读取，其他检查尚未运行",
        },
        counts={}, positions=[], readiness={"status": "blocked", "can_show_verified_positions": False, "verified_position_ids": [], "registerable_position_ids": [], "selected_position_id": None, "selected_position_status": "invalid", "can_generate_full_comparison": False, "can_register_selected_position": False, "next_step": "repair_input_json", "unresolved": ["INPUT_JSON_INVALID"]},
        issues=[{"code": "INPUT_JSON_INVALID", "severity": "error", "check": "structure", "outcome": "failed", "message": f"matching.json 无法解析：{message}", "next_step": "修复 JSON 后重新运行校验"}],
        errors=[f"matching.json 无法解析：{message}"], warnings=[],
        mechanical_passed=False,
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: python -X utf8 verify-matching.py <matching.json>")
        return 2
    path = Path(sys.argv[1]).resolve()
    data, error = read_json(path)
    if error:
        result, code = invalid_input_report(error), 1
    elif not isinstance(data, dict):
        result, code = invalid_input_report("根节点必须是对象"), 1
    elif data.get("schema_version") != SCHEMA_VERSION:
        result, code = legacy_result(data), 1
    else:
        result, code = validate_v2(data, path)
    path.with_name(path.stem + "-verification.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
