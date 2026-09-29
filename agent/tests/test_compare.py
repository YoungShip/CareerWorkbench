import json
from pathlib import Path

import pytest

from jobmatch.compare import compare_runs, render_markdown
from jobmatch.config import default_paths
from jobmatch.corpus import Chunk, Corpus
from jobmatch.graph import Matcher
from jobmatch.record import Job
from jobmatch.retrieval import Retriever
from conftest import FakeLLM


def create(corpus, root, identifier, company="测试集团（甲公司）"):
    extraction = json.dumps({"requirements": [{"text": "Python", "category": "core_capability",
        "jd_lines": [1], "category_basis_lines": [1]}]})
    judgment = json.dumps({"judgments": [{"requirement_id": "R1", "support": "direct_support", "conclusion": "satisfied",
        "evidence_ids": ["python"], "judgment": "项目直接支持接口开发。"}]})
    target = root / identifier
    engine = Matcher(FakeLLM([extraction, judgment]), Retriever(corpus, "full"), corpus, default_paths().matching_scripts)
    result = engine.run(Job(identifier, company, "接口工程师", "需要 Python 开发经验。"), target)
    assert result["verification_passed"]
    return target


def test_compare_does_not_select_rank_or_invent_application_constraints(corpus, tmp_path):
    first, second = [create(corpus, tmp_path, i) for i in ("a", "b")]
    report = compare_runs([second, first])
    assert [j["position_id"] for j in report["jobs"]] == ["b", "a"]
    assert report["selected_position_id"] is None and report["tracker_written"] is False
    assert report["constraints"]["application_limit"] is None
    assert report["constraints"]["official_open_status"] == "unknown"
    assert report["jobs"][0]["requirements"][0]["candidate_evidence"]
    text = render_markdown(report)
    assert "未知 / 未完成" in text and "开发 Python 数据处理" in text


def test_company_subject_and_candidate_version_must_match(corpus, tmp_path):
    a = create(corpus, tmp_path, "a")
    b = create(corpus, tmp_path, "b", company="测试集团（乙公司）")
    with pytest.raises(ValueError, match="公司主体"):
        compare_runs([a, b])
    changed = Corpus(corpus.chunks + [Chunk("new", "边界", "新增课程边界。", "fixture")])
    c = create(changed, tmp_path, "c")
    with pytest.raises(ValueError, match="证据版本"):
        compare_runs([a, c])


def test_changed_jd_cannot_reuse_verified_flag(corpus, tmp_path):
    a, b = [create(corpus, tmp_path, i) for i in ("a", "b")]
    (b / "pipeline/jd-original.txt").write_text("改成博士门槛", encoding="utf-8")
    with pytest.raises(ValueError, match="哈希"):
        compare_runs([a, b])
    with pytest.raises(ValueError, match="重复"):
        compare_runs([a, a])


def test_failed_run_has_no_comparable_decision(corpus, tmp_path):
    a, b = [create(corpus, tmp_path, i) for i in ("a", "b")]
    result = json.loads((b / "result.json").read_text(encoding="utf-8"))
    result["verification_passed"] = False
    (b / "result.json").write_text(json.dumps(result), encoding="utf-8")
    with pytest.raises(ValueError, match="未通过"):
        compare_runs([a, b])
