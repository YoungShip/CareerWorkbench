import pytest

from jobmatch.jd import InvalidJDSource, prepare_jd
from jobmatch.record import Job
from test_graph import matcher


def test_raw_web_document_requires_source_extraction():
    with pytest.raises(InvalidJDSource, match="可见岗位正文"):
        prepare_jd('\ufeff<!DOCTYPE html><html><body>需要 Python 开发</body></html>')


def test_html_skill_requirement_is_still_plain_job_text():
    result = prepare_jd('熟悉 HTML/CSS，能解释 <button> 的作用。\n使用 Python 开发接口。')
    assert '<button>' in result.clean_text and len(result.clauses) == 2


def test_raw_html_fails_before_any_model_or_retrieval_call(corpus, tmp_path):
    match, client = matcher(corpus, [])
    result = match.run(Job('role', 'Fixture', 'Developer', '<html><body>需要 Python 开发</body></html>'), tmp_path/'run')
    assert result['execution_status'] == 'failed' and result['error_type'] == 'InvalidJDSource'
    assert not result['verification_passed'] and result['decision'] is None
    assert '原始 HTML' in result['error_message'] and client.requests == []
