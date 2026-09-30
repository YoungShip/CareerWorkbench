"""候选人证据库：从网申母表和求职档案按白名单抽取可引用的经历事实。

- 只读教育、工作、项目、技能、英语、奖项、专利、课题进展这些字段；基本信息里只取英语成绩和预计毕业时间，
  联系方式、证件、家庭、薪资等字段不读。
- 求职档案只取「经历与表述边界」一节；保留其中的限定，不能因含“填写”等字样整条删除。这些「[边界]」条目
  是负向约束（哪些经历不能夸大），判定时和正向证据一起给模型。
- 每条证据写成一行，整份语料就是 candidate-evidence.txt 快照，行号即 locator；
  profile_version 取快照内容的哈希，语料一变版本就变。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .privacy import redact

_SENTENCE = re.compile(r"(?<=[。；;])")
_MD_LINK = re.compile(r"\[([^\]]+)\]\([^)]*\)")
_MD_MARK = re.compile(r"\*\*|`")
_BULLET = re.compile(r"^\s*[-*]\s+(.*\S)\s*$")
BOUNDARY_SECTION = "经历与表述边界"
DEGREES = ("大专", "本科", "硕士研究生", "博士研究生")


@dataclass(frozen=True)
class Chunk:
    id: str
    kind: str
    text: str
    source: str


def _clean(text: Any) -> str:
    text = _MD_MARK.sub("", _MD_LINK.sub(r"\1", str(text or "")))
    return redact(re.sub(r"\s+", " ", text).strip())


def _sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENTENCE.split(_clean(text)) if len(s.strip()) > 4]


def _dedupe(texts: list[str]) -> list[str]:
    """只合并文本相同的描述；近似文本中的责任、否定词和数字可能不同。"""
    kept: list[str] = []
    seen: set[str] = set()
    for text in texts:
        key = re.sub(r"\s+", " ", text).strip()
        if key not in seen:
            seen.add(key)
            kept.append(text)
    return kept


def _texts(value: Any) -> list[str]:
    """描述类字段有的是字符串、有的是字符串列表。"""
    if isinstance(value, str):
        return [value] if value.strip() else []
    return [str(v) for v in value or [] if str(v).strip()]


def _course(item: dict) -> str:
    score, full = item.get("成绩"), item.get("满分")
    if score in (None, ""):
        return str(item["课程"])
    return f"{item['课程']}（{score}）" if full in (None, "", 100, "100") else f"{item['课程']}（{score}/{full}）"


def _education(items: list[dict], source: str) -> list[Chunk]:
    has_college = any(e.get("学历") == "大专" for e in items)
    chunks = []
    for e in items:
        level = e.get("学历")
        if level not in DEGREES:
            continue  # 高中不作为岗位匹配证据
        eid = str(e.get("id") or f"edu_{level}")
        degree = e.get("学位名称")
        notes = [f"档案学位名称：{degree}"] if degree and degree != "无" else []
        if level == "本科" and has_college and e.get("学制") == "两年":
            notes.append("专升本")
        head = " ".join(x for x in (e.get("学校"), e.get("专业"), level) if x)
        head += f"（{'，'.join(notes)}）" if notes else ""
        facts = [f"{e.get('开始')} 至 {e.get('结束')}"]
        if e.get("是否全日制") is True:
            facts.append("全日制")
        if e.get("学制"):
            facts.append(f"学制{e['学制']}")
        if e.get("研究方向"):
            facts.append(f"研究方向：{e['研究方向']}")
        if e.get("GPA成绩") is not None:
            facts.append(f"GPA {e['GPA成绩']}（{e.get('GPA类型') or '分制未注明'}）")
        if e.get("成绩排名"):
            facts.append(f"成绩排名{e['成绩排名']}")
        for key in ("学位说明", "日期状态"):
            if e.get(key):
                facts.append(f"{key}：{e[key]}")
        if e.get("学位授予时间"):
            facts.append(f"学位授予时间：{e['学位授予时间']}")
        chunks.append(Chunk(eid, "教育", _clean(f"[教育] {head} {'，'.join(facts)}"), f"{source}#教育经历"))
        courses = [_course(c) for c in e.get("主修课程") or [] if isinstance(c, dict) and c.get("课程")]
        if courses:
            text = f"[课程·{level}] {e.get('学校')}主修课程：{'、'.join(courses)}"
            chunks.append(Chunk(f"{eid}_courses", "教育", _clean(text), f"{source}#教育经历.主修课程"))
    return chunks


def _work(items: list[dict], source: str) -> list[Chunk]:
    chunks = []
    for w in items:
        if w.get("是否默认填写") is False:
            continue  # 本人决定默认不写进网申的经历，匹配时也不当证据
        wid = str(w.get("id") or "work")
        brand = w.get("公司品牌") or w.get("公司")
        period = f"{w.get('开始')} 至 {w.get('结束')}"
        extra = "，".join(x for x in (w.get("经历性质"), w.get("实际时长")) if x)
        head = " ".join(x for x in (w.get("公司"), w.get("部门"), w.get("职位")) if x)
        chunks.append(Chunk(wid, "工作", _clean(f"[工作] {head}，{period}（{extra}）"), f"{source}#工作经历"))
        lines = [s for key in ("描述_C", "描述_A", "描述") for d in _texts(w.get(key)) for s in _sentences(d)]
        for n, sentence in enumerate(_dedupe(lines), start=1):
            chunks.append(Chunk(f"{wid}_{n}", "工作", f"[工作·{brand}] {sentence}", f"{source}#工作经历"))
    return chunks


def _projects(items: list[dict], source: str) -> list[Chunk]:
    chunks = []
    for p in items:
        pid = str(p.get("id") or "project")
        name = _clean(p.get("名称"))
        owner = p.get("项目归属")
        period = f"{p.get('开始')} 至 {p.get('结束')}"
        head = f"[项目] {name}（{'，'.join(x for x in (owner, period) if x)}）"
        if p.get("角色"):
            head += f"，角色：{p['角色']}"
        chunks.append(Chunk(pid, "项目", _clean(head), f"{source}#项目经历"))
        # 「描述」是整段版，简介/职责/成果是网申分栏版，数字细节常只在分栏里，合并后去重
        lines = [s for key in ("描述", "项目简介", "个人职责", "项目成果") for d in _texts(p.get(key)) for s in _sentences(d)]
        for n, sentence in enumerate(_dedupe(lines), start=1):
            chunks.append(Chunk(f"{pid}_{n}", "项目", f"[项目·{name}] {sentence}", f"{source}#项目经历"))
        if p.get("边界"):
            chunks.append(Chunk(f"{pid}_boundary", "边界", f"[边界·{name}] {_clean(p['边界'])}", f"{source}#项目经历"))
    return chunks


def _profile_facts(profile: dict, source: str) -> list[Chunk]:
    chunks: list[Chunk] = []
    chunks += _education(profile.get("教育经历") or [], source)
    chunks += _work(profile.get("工作经历") or [], source)
    chunks += _projects(profile.get("项目经历") or [], source)
    skills = [s for version in ("C", "A") for d in (profile.get("专业技能") or {}).get(version) or [] for s in _sentences(d)]
    chunks += [Chunk(f"skill_{n}", "技能", f"[技能] {s}", f"{source}#专业技能") for n, s in enumerate(_dedupe(skills), 1)]

    basic = profile.get("基本信息") or {}  # 只取下面两项，其余（联系方式、证件、家庭等）不读
    english = basic.get("英语") or {}
    scores = [f"{k}：{english[k]}" for k in ("CET-4", "CET-6") if english.get(k)]
    if scores:
        chunks.append(Chunk("cert_english", "证书", f"[证书] 英语 {'；'.join(scores)}", f"{source}#基本信息.英语"))
    graduation = basic.get("预计毕业时间")
    if graduation:
        year = basic.get("预计毕业年份") or str(graduation)[:4]
        chunks.append(Chunk("graduation", "其他", f"[其他] 预计毕业时间 {graduation}（{year} 届）", f"{source}#基本信息.预计毕业时间"))

    awards = [
        f"{a['奖项名称']}（{'，'.join(x for x in (a.get('奖项级别'), a.get('获奖年月')) if x)}）"
        for a in profile.get("获奖信息") or []
        if a.get("奖项名称")
    ]
    if awards:
        chunks.append(Chunk("awards", "获奖", f"[获奖] {'；'.join(awards)}", f"{source}#获奖信息"))
    for n, item in enumerate(profile.get("学术成果") or [], start=1):
        if not item.get("名称"):
            continue
        facts = [item.get("状态")]
        if item.get("发明人排序"):
            facts.append(f"第 {item['发明人排序']} 发明人（共 {item.get('发明人总人数', '?')} 人）")
        if item.get("公开日期"):
            facts.append(f"公开日期 {item['公开日期']}")
        if item.get("实际分工说明"):
            facts.append(f"实际分工说明：{item['实际分工说明']}")
        text = f"[成果] {item.get('类型', '成果')}《{item['名称']}》：{'；'.join(f for f in facts if f)}"
        chunks.append(Chunk(f"ip_{n}", "成果", _clean(text), f"{source}#学术成果"))
    thesis = profile.get("硕士课题") or {}
    if thesis.get("已知进展"):
        title = f"《{thesis['正式名称']}》" if thesis.get("正式名称") else ""
        chunks.append(Chunk("thesis", "项目", _clean(f"[项目·硕士课题{title}] {thesis['已知进展']}"), f"{source}#硕士课题"))
    if thesis.get("阶段边界"):
        chunks.append(Chunk("thesis_boundary", "边界", _clean(f"[边界·硕士课题] {thesis['阶段边界']}"), f"{source}#硕士课题"))
    # 「有学生干部经历优先」这类要求：明确写出没有，避免模型脑补
    campus = profile.get("校园与补充经历") or {}
    if campus.get("校园经历状态"):
        text = f"[边界·校园经历] {campus['校园经历状态']}"
        chunks.append(Chunk("campus_boundary", "边界", _clean(text), f"{source}#校园与补充经历"))
    return chunks


def section_bullets(markdown: str, title: str) -> list[str]:
    """取某个二级标题下的「- 」条目。"""
    bullets: list[str] = []
    inside = False
    for line in markdown.splitlines():
        if line.startswith("## "):
            inside = line[3:].strip() == title
            continue
        match = _BULLET.match(line) if inside else None
        if match:
            bullets.append(match.group(1))
    return bullets


def _boundaries(markdown: str, source: str) -> list[Chunk]:
    bullets = [_clean(b) for b in section_bullets(markdown, BOUNDARY_SECTION)]
    return [Chunk(f"boundary_{n}", "边界", f"[边界] {b}", f"{source}#{BOUNDARY_SECTION}") for n, b in enumerate(bullets, 1)]


def _extra(markdown: str, source: str) -> list[Chunk]:
    lines = [_BULLET.match(line) for line in markdown.splitlines()]
    return [Chunk(f"extra_{n}", "补充", f"[补充] {_clean(m.group(1))}", source) for n, m in enumerate([m for m in lines if m], 1)]


@dataclass
class Corpus:
    chunks: list[Chunk]

    def __post_init__(self) -> None:
        # 规范化后重复的条目会被校验器判为 NORMALIZED_QUOTE_DUPLICATE，这里先去掉
        seen: set[str] = set()
        unique = []
        for chunk in self.chunks:
            chunk = Chunk(chunk.id, chunk.kind, _clean(chunk.text), chunk.source)
            key = re.sub(r"(?<=[\u3400-\u4dbf\u4e00-\u9fff]) (?=[\u3400-\u4dbf\u4e00-\u9fff])", "", chunk.text)
            if key in seen:
                continue
            seen.add(key)
            unique.append(chunk)
        self.chunks = unique
        self._by_id = {c.id: c for c in self.chunks}
        self._line = {c.id: i for i, c in enumerate(self.chunks, start=1)}
        if len(self._by_id) != len(self.chunks):
            raise ValueError("证据 ID 重复")

    @property
    def snapshot(self) -> str:
        return "\n".join(c.text for c in self.chunks) + "\n"

    @property
    def version(self) -> str:
        return "corpus@" + hashlib.sha256(self.snapshot.encode("utf-8")).hexdigest()[:12]

    def get(self, chunk_id: str) -> Chunk | None:
        return self._by_id.get(chunk_id)

    def line_of(self, chunk_id: str) -> int:
        return self._line[chunk_id]

    def write(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "candidate-evidence.txt").write_text(self.snapshot, encoding="utf-8", newline="\n")
        payload = {"version": self.version, "chunks": [asdict(c) for c in self.chunks]}
        (directory / "corpus.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: Path) -> Corpus:
        payload = json.loads(path.read_text(encoding="utf-8"))
        return cls([Chunk(**c) for c in payload["chunks"]])


def build_corpus(profile_json: Path, profile_md: Path, extra: Path | None = None) -> Corpus:
    profile = json.loads(profile_json.read_text(encoding="utf-8-sig"))
    chunks = _profile_facts(profile, profile_json.name)
    chunks += _boundaries(profile_md.read_text(encoding="utf-8-sig"), profile_md.name)
    if extra and extra.is_file():
        chunks += _extra(extra.read_text(encoding="utf-8-sig"), extra.name)
    return Corpus(chunks)
