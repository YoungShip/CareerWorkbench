import json

import pytest

from jobmatch.schemas import Extraction, extraction_check
from jobmatch.record import Job
from test_graph import matcher, judgment


def extracted(condition="身体健康", kind="application_gate"):
    return {"requirements": [{"text": "Python 开发", "category": "core_capability",
        "jd_lines": [1], "category_basis_lines": [1]}],
        "ignored_lines": [{"line": 1, "kind": kind, "reason": "本地投前核查", "condition_text": condition}]}


def test_mixed_line_keeps_skill_and_audits_unchecked_gate(corpus, tmp_path):
    match, _ = matcher(corpus, [json.dumps(extracted()), judgment()])
    directory = tmp_path / 'run'
    result = match.run(Job('role', 'Fixture', 'Developer', '需要 Python 开发能力，身体健康。'), directory)
    assert result['verification_passed'] and result['decision'] == 'recommended'
    assert result['local_application_gates_checked'] is False
    audit = json.loads((directory / 'pipeline/application-gates.json').read_text())
    assert audit['gates'][0]['condition_text'] == '身体健康'
    assert audit['gates'][0]['checked'] is False


@pytest.mark.parametrize('text', ['本科及以上且身体健康', '掌握 Python 且能出差', 'SQL 专业证书', '健康管理系统研发'])
def test_technical_or_qualification_cannot_be_hidden_as_gate(text):
    with pytest.raises(ValueError, match='非技术'):
        extraction_check(Extraction.model_validate(extracted(text)), 1, [text])


def test_gate_requires_exact_source_substring():
    with pytest.raises(ValueError, match='原文子串'):
        extraction_check(Extraction.model_validate(extracted()), 1, ['需要 Python 开发能力。'])


def test_preference_gate_is_retained_without_technical_penalty():
    value = Extraction.model_validate(extracted('接受出差', 'preference_gate'))
    assert extraction_check(value, 1, ['Python 开发，接受出差。']) is value


def test_law_abiding_declaration_is_a_local_gate():
    value = Extraction.model_validate(extracted('遵纪守法'))
    assert extraction_check(value, 1, ['Python 开发，遵纪守法。']) is value


def test_physical_and_psychological_declaration_remains_unchecked():
    text = '具备良好的心理素质及身体素质'
    value = Extraction.model_validate(extracted(text))
    assert extraction_check(value, 1, ['Python 开发，' + text]) is value
