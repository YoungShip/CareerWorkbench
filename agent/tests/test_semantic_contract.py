import pytest
from jobmatch.schemas import Judgment


def test_admitted_missing_aspect_cannot_be_reported_as_satisfied():
    row = {"requirement_id": "R1", "support": "direct_support", "conclusion": "satisfied",
           "evidence_ids": ["python"], "judgment": "有 Python 项目但异步编程未核实。",
           "unverified_aspects": ["异步编程"]}
    with pytest.raises(ValueError, match="必要部分"):
        Judgment.model_validate(row)
    row["conclusion"] = "pending"
    assert Judgment.model_validate(row).unverified_aspects == ["异步编程"]
