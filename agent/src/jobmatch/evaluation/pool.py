"""从主表和 v2 匹配记录构建评测池（只读）。

主表 job_pool.csv 提供本人决定（投了没有）和部分 JD 全文；
lapis-cv/tmp 下的 v2 匹配记录提供 JD 快照和原工作流给出的结论（baseline）。
身份关联要求精确主体、绑定的 matching_file 和岗位 ID；同名或相似正文不足以证明身份。
保留各次来源快照，不用最新修改时间替代历史事实。旧评测池及标签不迁移或覆盖。
"""

from __future__ import annotations

import csv
import hashlib
import json
import random
import re
import unicodedata
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from ..config import resolve_artifact_path

APPLIED = {"Submitted", "Rejected"}  # 本人已投；被拒也说明投过
MIN_JD_CHARS = 150
DUPLICATE_MARK = "重复登记"
IN_SCOPE_STATES = {"recommended", "consider", "pending"}
OUT_STATES = {"excluded", "not_applicable"}
STATUS_RANK = {"Submitted": 0, "Rejected": 1, "Pending": 2, "Deferred": 3, "Blocked": 4, "Skipped": 5}

IDENTITY_VERSION = "pool-v2-explicit-identity"


def compact(text: str | None) -> str:
    return re.sub(r"\s+", "", text or "")


def title_key(title: str | None) -> str:
    return company_key(title)


def company_key(name: str | None) -> str:
    value = re.sub(r"\s+", " ", unicodedata.normalize("NFKC", name or "")).strip().casefold()
    return re.sub(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff]) (?=[\u3400-\u4dbf\u4e00-\u9fff])", "", value)


def group_key(name: str | None) -> str:
    """仅规范化字符和排版，不猜集团、子公司或简称的对应关系。"""
    return company_key(name)


def same_company(a: str, b: str) -> bool:
    ka, kb = group_key(a), group_key(b)
    return bool(ka) and ka == kb


def jd_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _eval_id(parts: list[str]) -> str:
    return "V2-" + jd_hash(json.dumps(parts, ensure_ascii=False))[:24]


def _path_key(value: str, base_dir: Path | None = None) -> str:
    if not value:
        return ""
    path = Path(value.replace("\\", "/"))
    if base_dir is not None and not path.is_absolute():
        path = base_dir / path
    return str(resolve_artifact_path(path).resolve()).replace("\\", "/")


def id_in_url(position_id: str, url: str) -> bool:
    if len(position_id) < 4:
        return False
    return re.search(rf"(?<![0-9A-Za-z]){re.escape(position_id)}(?![0-9A-Za-z])", url or "") is not None


@dataclass
class PoolEntry:
    eval_id: str
    company: str
    title: str
    city: str
    jd_text: str
    tracker: dict | None = None  # {job_id, status, skip_reason}
    baseline: dict | None = None  # {file, position_id, state, excluded, exclusion_reason}
    identity: dict | None = None  # v1 文件缺此字段，仍可原样读取

    @property
    def applied(self) -> bool:
        return bool(self.tracker) and self.tracker["status"] in APPLIED


def read_tracker(csv_path: Path) -> list[dict]:
    with csv_path.open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh))


def scan_v2(root: Path) -> list[dict]:
    """保留来源记录的各次快照；时间新不表示与历史投递绑定。"""
    items = []
    for path in sorted(root.rglob("*.json")):
        name = path.name
        if "verification" in name or "raw" in name or name.startswith("_"):
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8-sig"))
        except (OSError, ValueError):
            continue
        if not isinstance(record, dict) or record.get("schema_version") != 2:
            continue
        positions = record.get("positions")
        if not isinstance(positions, list):
            continue
        mtime = path.stat().st_mtime
        company = str(record.get("company") or "")
        for pos in positions:
            if not isinstance(pos, dict):
                continue
            snapshot = (pos.get("jd_source") or {}).get("snapshot_file")
            if not snapshot:
                continue
            try:
                text = resolve_artifact_path(path.parent / snapshot).resolve().read_text(encoding="utf-8-sig")
            except OSError:
                continue
            if not str(pos.get("title") or "").strip():
                continue
            decision = pos.get("decision") or {}
            item = {
                "company": company,
                "title": str(pos.get("title") or ""),
                "city": str(pos.get("city") or ""),
                "position_id": str(pos.get("id") or ""),
                "jd_text": text,
                "state": decision.get("state"),
                "excluded": bool(pos.get("excluded")),
                "exclusion_reason": pos.get("exclusion_reason") or "",
                "file": str(path),
                "mtime": mtime,
                "url": str((pos.get("jd_source") or {}).get("url") or ""),
                "jd_source": pos.get("jd_source") or {},
                "selected_position_id": str(record.get("selected_position_id") or ""),
                "source_record_sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "snapshot_file": str(resolve_artifact_path(path.parent / snapshot).resolve()),
            }
            items.append(item)
    return items


def _linked(row: dict, item: dict, base_dir: Path | None = None) -> bool:
    if not same_company(row.get("company", ""), item["company"]):
        return False
    # 同一 URL 可能跨批次复用；必须先有主表明确绑定的来源记录。
    if not row.get("matching_file") or _path_key(row["matching_file"], base_dir) != _path_key(item["file"], base_dir):
        return False
    explicit_id = str(row.get("selected_position_id") or "")
    return (bool(explicit_id) and explicit_id == item["position_id"]) or id_in_url(item["position_id"], row.get("job_url", ""))


def _baseline(item: dict) -> dict:
    return {k: item.get(k) for k in ("file", "position_id", "state", "excluded", "exclusion_reason", "url")} | {
        "kind": "historical_ai_output_not_gold",
    }


def build_pool(rows: list[dict], items: list[dict], *, base_dir: Path | None = None, audit: list | None = None) -> list[PoolEntry]:
    audit = audit if audit is not None else []
    by_company: dict[str, list[int]] = defaultdict(list)
    for index, item in enumerate(items):
        by_company[company_key(item["company"])].append(index)

    entries: dict[str, PoolEntry] = {}
    linked: set[int] = set()
    ordered = sorted(rows, key=lambda r: STATUS_RANK.get(r.get("status", ""), 9))
    for row in ordered:
        matches = [
            i
            for i in by_company.get(company_key(row.get("company")), [])
            if _linked(row, items[i], base_dir)
        ]
        base = items[matches[0]] if len(matches) == 1 else None
        jd = row.get("job_description") or ""
        if len(compact(jd)) < MIN_JD_CHARS and base:
            jd = base["jd_text"]
        if len(compact(jd)) < MIN_JD_CHARS:
            audit.append({"job_id": row.get("job_id"), "action": "skipped_insufficient_jd", "identity_matches": len(matches)})
            continue
        job_id = row.get("job_id", "")
        if not job_id:
            raise ValueError("主表岗位缺少稳定 job_id")
        eval_id = _eval_id(["tracker", job_id])
        if eval_id in entries:
            raise ValueError("主表 job_id 重复，须先核对，不能按状态覆盖")
        if base:
            linked.add(matches[0])
        else:
            audit.append({"job_id": job_id, "action": "kept_tracker_without_baseline", "identity_matches": len(matches)})
        entries[eval_id] = PoolEntry(
            eval_id=eval_id,
            company=row.get("company", ""),
            title=row.get("job_title", ""),
            city=row.get("location", "") or (base["city"] if base else ""),
            jd_text=jd,
            tracker={
                "job_id": row.get("job_id", ""),
                "status": row.get("status", ""),
                "skip_reason": row.get("skip_reason", ""),
            },
            baseline=_baseline(base) if base else None,
            identity={"version": IDENTITY_VERSION, "basis": "bound_record_and_position_id" if base else "tracker_job_id_only",
                      "jd_sha256": jd_hash(jd), "source_url": row.get("job_url") or "",
                      "source_file": row.get("matching_file") or "", "official_freshness_verified": False,
                      "jd_backfilled": jd != (row.get("job_description") or "")},
        )

    # 不按名称或相似正文归并；保留独立来源及版本，不把它们冒称独立真人标签。
    for index, item in enumerate(items):
        if index in linked or len(compact(item["jd_text"])) < MIN_JD_CHARS:
            continue
        eval_id = _eval_id(["research", company_key(item["company"]), item["position_id"],
                            _path_key(item["file"], base_dir), jd_hash(item["jd_text"])])
        if eval_id in entries:
            continue
        entries[eval_id] = PoolEntry(
            eval_id=eval_id,
            company=item["company"],
            title=item["title"],
            city=item["city"],
            jd_text=item["jd_text"],
            baseline=_baseline(item),
            identity={"version": IDENTITY_VERSION, "basis": "research_snapshot_unlinked_to_tracker",
                      "jd_sha256": jd_hash(item["jd_text"]), "source_url": item.get("url", ""),
                      "source_file": item["file"], "official_freshness_verified": False},
        )
    return sorted(entries.values(), key=lambda e: e.eval_id)


# 盲标分层：本人已有明确决定的（已投）不进盲标，只作正例集。
STRATA = [
    ("tracker_pending", 12, lambda e: e.tracker and e.tracker["status"] == "Pending"),
    (
        "tracker_skipped",
        8,
        lambda e: e.tracker and e.tracker["status"] == "Skipped" and DUPLICATE_MARK not in e.tracker["skip_reason"],
    ),
    ("research_in_scope", 18, lambda e: not e.tracker and e.baseline and e.baseline["state"] in IN_SCOPE_STATES),
    ("research_out_of_scope", 12, lambda e: not e.tracker and e.baseline and e.baseline["state"] in OUT_STATES),
]


def sample_blind(entries: list[PoolEntry], seed: int = 20260928, per_company: int = 2) -> list[dict]:
    """分层随机抽样。

    同一公司先最多取 per_company 个，某层凑不满时放宽 1 个；
    全部分层走完仍不足总数时，按「研究过未登记 → 主表待投 → 方向不符」的顺序再放宽 1 个补齐。
    """
    rng = random.Random(seed)
    pools = {}
    for name, _, rule in STRATA:
        pool = [e for e in entries if rule(e)]
        rng.shuffle(pool)
        pools[name] = pool
    taken: set[str] = set()
    company_count: dict[str, int] = defaultdict(int)
    picked: list[dict] = []

    def fill(name: str, quota: int, cap: int) -> int:
        got = 0
        for entry in pools[name]:
            if got >= quota:
                break
            key = group_key(entry.company)
            if entry.eval_id in taken or company_count[key] >= cap:
                continue
            taken.add(entry.eval_id)
            company_count[key] += 1
            picked.append({"eval_id": entry.eval_id, "stratum": name})
            got += 1
        return got

    for name, quota, _ in STRATA:
        got = fill(name, quota, per_company)
        if got < quota:
            fill(name, quota - got, per_company + 1)
    total = sum(quota for _, quota, _ in STRATA)
    for name in ("research_in_scope", "tracker_pending", "research_out_of_scope"):
        if len(picked) < total:
            fill(name, total - len(picked), per_company + 2)
    rng.shuffle(picked)
    return picked


def write_pool(entries: list[PoolEntry], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("x", encoding="utf-8", newline="\n") as fh:
        for entry in entries:
            fh.write(json.dumps(asdict(entry), ensure_ascii=False) + "\n")


def read_pool(path: Path) -> list[PoolEntry]:
    with path.open(encoding="utf-8") as fh:
        return [PoolEntry(**json.loads(line)) for line in fh if line.strip()]
