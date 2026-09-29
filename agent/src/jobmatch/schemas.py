"""模型只输出语义字段；来源、引文、汇总与最终决策由程序生成。"""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Category = Literal["hard_qualification", "core_capability", "plus", "ambiguous"]
Support = Literal["direct_support", "transferable", "no_evidence", "conflict"]
Conclusion = Literal["satisfied", "not_satisfied", "pending"]
Line = Annotated[int, Field(strict=True, ge=1)]


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Requirement(StrictModel):
    text: str = Field(min_length=1, max_length=600)
    category: Category
    jd_lines: list[Line] = Field(min_length=1, max_length=20)
    category_basis_lines: list[Line] = Field(min_length=1, max_length=20)


class IgnoredLine(StrictModel):
    line: Line
    kind: Literal["context", "not_requirement"]
    reason: str = Field(min_length=1, max_length=160)


class Extraction(StrictModel):
    requirements: list[Requirement] = Field(min_length=1, max_length=30)
    ignored_lines: list[IgnoredLine] = Field(default_factory=list, max_length=500)

    @model_validator(mode="after")
    def has_core(self):
        if not any(r.category in {"hard_qualification", "core_capability"} for r in self.requirements):
            raise ValueError("至少需要一条硬性条件或核心能力")
        return self


class Judgment(StrictModel):
    requirement_id: str = Field(pattern=r"^R[1-9]\d*$")
    support: Support
    conclusion: Conclusion
    evidence_ids: list[str] = Field(max_length=20)
    judgment: str = Field(min_length=1, max_length=300)
    category: Category | None = None
    unverified_aspects: list[str] = Field(default_factory=list, max_length=12)

    @model_validator(mode="after")
    def gaps_cannot_be_satisfied(self):
        if self.unverified_aspects and self.conclusion == "satisfied":
            raise ValueError("要求含未核实的必要部分，不能判 satisfied；请保留 pending 并解释缺口")
        return self


class Judgments(StrictModel):
    judgments: list[Judgment] = Field(min_length=1, max_length=30)


def extraction_check(value: Extraction, line_count: int) -> Extraction:
    used = set()
    for req in value.requirements:
        if any(n > line_count for n in req.jd_lines + req.category_basis_lines):
            raise ValueError("JD 引用行号越界")
        if not req.text.strip():
            raise ValueError("要求正文不能为空")
        used.update(req.jd_lines)
    ignored = [item.line for item in value.ignored_lines]
    if len(ignored) != len(set(ignored)) or used.intersection(ignored):
        raise ValueError("非要求行不能重复声明，也不能与要求引用重叠")
    if any(n > line_count for n in ignored):
        raise ValueError("非要求行号越界")
    missing = set(range(1, line_count + 1)) - used - set(ignored)
    if missing:
        raise ValueError(f"以下 JD 行未说明用途：{sorted(missing)}。要求须引用；仅背景/非要求须说明排除理由。")
    return value


def judgments_check(value: Judgments, count: int) -> Judgments:
    ids = [j.requirement_id for j in value.judgments]
    if len(ids) != count or set(ids) != {f"R{i}" for i in range(1, count + 1)}:
        raise ValueError("每条要求必须恰好返回一个判定，不能缺失、重复或增加 ID")
    return value
