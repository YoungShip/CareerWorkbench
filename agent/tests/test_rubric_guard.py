import json

from test_graph import extraction, matcher
from jobmatch.record import Job
from jobmatch.rubric import rubric_issues


def row(gap="核心代码独立实现", support="direct_support"):
    return {"requirement_id": "R1", "support": support, "conclusion": "pending",
        "evidence_ids": ["python"], "judgment": "有 Python 接口开发实践，业务场景适配待确认。",
        "unverified_aspects": [gap]}


def reply(value):
    return json.dumps({"judgments": [value]})


def test_unsupported_extra_experience_threshold_is_repaired(corpus, tmp_path):
    match, _ = matcher(corpus, [extraction(), reply(row()), reply(row("业务场景适配", "transferable"))])
    result = match.run(Job("role", "Fixture", "校招工程师", "参与 Python 开发。"), tmp_path / "run")
    assert result["verification_passed"] and result["decision"] == "consider"
    assert result["repairs"] == 1 and not result["first_passed"]
    assert "UNSOURCED_EXPERIENCE_QUALIFIER" in result["attempts"][0]["codes"]


def test_pipeline_cannot_reaccept_exhausted_rubric_failure(corpus, tmp_path):
    match, _ = matcher(corpus, [extraction(), reply(row()), reply(row())], max_repairs=1)
    directory = tmp_path / "run"
    result = match.run(Job("role", "Fixture", "校招工程师", "参与 Python 开发。"), directory)
    assert not result["verification_passed"] and result["decision"] is None
    assert result["repairs"] == 1
    assert json.loads((directory / "pipeline/pipeline-result.json").read_text())["mechanical_passed"]


def test_original_independent_and_scale_thresholds_remain_required():
    req = {"text": "独立完成高并发 Python 服务", "category": "core_capability", "jd_lines": [1]}
    result = rubric_issues([req], [row("独立实现高并发服务", "transferable")], ["独立完成高并发 Python 服务。"])
    assert result == []


def test_same_practice_with_richness_pending_is_not_missing_another_technology():
    req = {"text": "有丰富的 LLM API 对接经验", "category": "core_capability", "jd_lines": [1]}
    judged = row('LLM API 对接经验是否达到 JD所称丰富的程度')
    assert rubric_issues([req], [judged], [req['text']]) == []
    judged['unverified_aspects'] = ['异步编程缺少项目证据']
    assert rubric_issues([req], [judged], [req['text']])[0]['code'] == 'PARTIAL_COVERAGE_MARKED_DIRECT'


def test_open_major_does_not_require_an_unspecified_official_directory():
    req = {"text": "电子、计算机等相关专业", "category": "hard_qualification", "jd_lines": [1]}
    judged = row('', 'transferable')
    judged['unverified_aspects'] = ['官方专业目录未提供']
    assert rubric_issues([req], [judged], [req['text']])[0]['code'] == 'UNSOURCED_EXACT_MAJOR_GATE'
