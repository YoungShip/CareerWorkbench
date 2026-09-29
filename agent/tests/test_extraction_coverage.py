import pytest

from jobmatch.schemas import Extraction, extraction_check


def sample(ignored=None):
    return Extraction.model_validate({
        "requirements": [{"text": "Python", "category": "core_capability", "jd_lines": [2], "category_basis_lines": [2]}],
        "ignored_lines": ignored or [],
    })


def test_omitted_jd_line_is_not_silently_accepted():
    with pytest.raises(ValueError, match="未说明用途"):
        extraction_check(sample(), 3)


def test_context_is_retained_with_reason_and_no_double_accounting():
    ignored = [{"line": 1, "kind": "context", "reason": "公司背景"},
               {"line": 3, "kind": "not_requirement", "reason": "章节结束"}]
    assert extraction_check(sample(ignored), 3).ignored_lines[0].line == 1
    with pytest.raises(ValueError, match="重叠"):
        extraction_check(sample(ignored + [{"line": 2, "kind": "context", "reason": "不合法重叠"}]), 3)
