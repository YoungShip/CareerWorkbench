"""JD 文本清洗与断句。

研究时保存的 JD 快照常夹带抓取注释（来源链接、接口字段、页面导航），先清掉；
再切成「一行一条」的子句。Agent 只输出行号，引文原文由代码按行回填，
所以快照里的每一行都必须是能被原样引用的完整子句。
"""

from __future__ import annotations

import re
import hashlib
from dataclasses import dataclass

from .privacy import redact

# 只删除可识别的抓取技术字段；标题、主体、地点、批次、性质与日期属于业务上下文。
_META_EXACT = (
    "官方来源|官方快照日期"
)
_META_PREFIX = "来源(?:URL|链接|网址)?|目录来源|读取时间|抓取(?:时间|日期|地址|URL|链接|方式)|回填日期|归档日期|登记日期"
_API_FIELDS = (
    "CategoryId|OrgId|Status|JobAdId|ChangeDate|Id|id|UUID"
)
_META_KEY = re.compile(
    rf"^(?:(?:{_META_EXACT})\s*(?:[(（][^)）]{{0,20}}[)）])?|(?:{_META_PREFIX})"
    rf"|(?:{_API_FIELDS})\s*(?:[(（][^)）]{{0,20}}[)）])?)\s*[：:]"
)
_RESEARCH_NOTE = re.compile(r"^(?:取证|抓取|原文保存)说明[：:]")
# 行内的研究注释，如「学历：（官方字段未填）」里的括号部分
_NOTE_PAREN = re.compile(r"^[^：:]{1,16}[：:]\s*[（(]\s*(?:官方|API)[^（）()]{0,60}(?:未填|为空)[^（）()]*[）)]$")
_MD_HEADER = re.compile(r"^#{1,6}\s+(\S.*)$")
_FENCED = re.compile(r"^[-=]{2,}\s*(.*?)\s*[-=]{2,}$")  # ---- 岗位职责（content 原文）----
_SEPARATOR = re.compile(r"[-=—_*#]{3,}")
_PUNCT_ONLY = re.compile(r"^[\W\d_]{1,3}$")
# 「工作地点：无锡；学历：本科及以上；招聘项目：校招」这类键值串要拆开逐项判断，别让学历跟着元数据一起被删
_KV_SERIES = re.compile(r"^[^：:；;]{1,12}[：:][^；;]*[；;]\s*[^：:；;]{1,12}[：:]")
_KV_SPLIT = re.compile(r"[；;]\s*")
_END_PUNCT = re.compile(r"[。；;：:！!？?]$")
_FRAGMENT = re.compile(r"^[一-鿿][。；;，,]?$")  # 抓取时被折断的单字尾巴，如「能。」
_HEADER_SPLIT = re.compile(r"(?<=[。；;])(?=(?:职位|任职|岗位|工作)(?:要求|资格|职责|描述)[：:])")
_NAV = {
    "首页", "关于我们", "登录", "注册", "分享", "申请职位", "投递简历",
    "职位信息", "职位详情", "发布日期", "职位名称", "返回", "收藏", "立即申请", "算法大赛", "现在申请",
    "立即投递", "更多", "分享到", "最新职位", "热招职位",
}
_INLINE_NUMBER = re.compile(r"(?<![0-9A-Za-z\-])(?=(?:\d{1,2}[、．](?!\d)|\d{1,2}\.(?!\d)|[（(]\d{1,2}[)）]))")
_SENTENCE_END = re.compile(r"(?<=[；;。])")
MAX_CLAUSE = 90
PREPROCESS_VERSION = "jd-v2-preserve-context"


def _normalize(line: str) -> str:
    line = line.strip()
    match = _MD_HEADER.match(line)
    if match:
        line = match.group(1).strip()
    match = _FENCED.match(line)
    if match:
        return match.group(1).strip()
    if _NOTE_PAREN.fullmatch(line):
        return ""  # 明确说明字段未填的独立占位行，不删除正文中的失败条件。
    if line.count('"') % 2 == 1:  # CSV 转义残留的半个引号
        line = line.strip('"').strip()
    return line


def _noise_reason(line: str) -> str | None:
    if line in _NAV:
        return "navigation_label"
    if _PUNCT_ONLY.fullmatch(line) or _SEPARATOR.fullmatch(line):
        return "separator"
    if re.fullmatch(r"https?://\S+", line, re.I):
        return "standalone_link"
    if _META_KEY.match(line):
        return "capture_metadata"
    if _RESEARCH_NOTE.match(line):
        return "capture_note"
    return None


def _is_noise(line: str) -> bool:
    return _noise_reason(line) is not None


def _pieces(raw: str) -> list[str]:
    """把一行原文拆成待判断的片段：先拆开粘在句尾的节标题，再拆键值串。"""
    out: list[str] = []
    for part in _HEADER_SPLIT.split(raw.strip()):
        out.extend(_KV_SPLIT.split(part) if _KV_SERIES.match(part) else [part])
    return out


@dataclass
class PreparedJD:
    clean_text: str
    clauses: list[str]
    line_map: list[dict]
    changes: list[dict]
    provided_sha256: str

    def audit(self) -> dict:
        return {
            "version": PREPROCESS_VERSION, "provided_sha256": self.provided_sha256,
            "provided_snapshot": "jd-original.txt", "model_snapshot": "jd.txt",
            "model_sha256": hashlib.sha256(("\n".join(self.clauses) + "\n").encode("utf-8")).hexdigest(),
            "line_map": self.line_map, "changes": self.changes,
            "note": "源行指调用方提供文本，不是对官网原始响应或当前开放状态的认证。",
        }


def prepare_jd(text: str, *, redact_text: bool = False) -> PreparedJD:
    """清洗、断句并记录每条模型输入对应的原文行；正文带链接的要求保留。"""
    kept: list[dict] = []
    changes: list[dict] = []
    for source_line, raw in enumerate((text or "").splitlines(), 1):
        for piece in _pieces(raw):
            line = _normalize(piece)
            reason = _noise_reason(line) if line else "empty_or_capture_placeholder"
            if reason:
                changes.append({"source_line": source_line, "action": "removed", "reason": reason})
                continue
            original_line = line
            if redact_text:
                line = redact(line)
            if kept and _FRAGMENT.fullmatch(line) and not _END_PUNCT.search(kept[-1]["text"]):
                kept[-1]["text"] += line
                kept[-1]["source_lines"].append(source_line)
                changes.append({"source_line": source_line, "action": "merged_fragment"})
                continue
            if kept and kept[-1]["text"] == line:
                kept[-1]["source_lines"].append(source_line)
                changes.append({"source_line": source_line, "action": "merged_exact_duplicate"})
                continue
            kept.append({"text": line, "source_lines": [source_line]})
            if line != piece.strip():
                changes.append({"source_line": source_line, "action": "normalized",
                                "privacy_redacted": line != original_line})
    clauses, mapping = [], []
    for entry in kept:
        for clause in _split_long(entry["text"]):
            clauses.append(clause)
            mapping.append({"clause_id": f"L{len(clauses)}", "source_lines": sorted(set(entry["source_lines"]))})
    return PreparedJD("\n".join(k["text"] for k in kept), clauses, mapping, changes,
                      hashlib.sha256((text or "").encode("utf-8")).hexdigest())


def clean_jd(text: str) -> str:
    return prepare_jd(text).clean_text


def _split_long(line: str) -> list[str]:
    # 行中间出现编号（「…相关专业2、掌握…3、…」）说明几条要求挤在一行，不论长短都拆开
    parts = [p.strip() for p in _INLINE_NUMBER.split(line) if p.strip()]
    if len(parts) <= 1 and len(line) <= MAX_CLAUSE:
        return [line]
    out: list[str] = []
    for part in parts:
        if len(part) <= MAX_CLAUSE:
            out.append(part)
            continue
        out.extend(p.strip() for p in _SENTENCE_END.split(part) if p.strip())
    return out


def split_clauses(text: str) -> list[str]:
    """清洗后按行切分，过长的行再按行内编号、句末标点切开。"""
    return prepare_jd(text).clauses


def numbered(clauses: list[str]) -> str:
    """给模型看的带行号版本：L1: ...。"""
    return "\n".join(f"L{i}: {c}" for i, c in enumerate(clauses, start=1))
