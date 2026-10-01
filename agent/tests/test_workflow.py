import hashlib
import json

import pytest

from jobmatch.config import default_paths
from jobmatch.graph import Matcher
from jobmatch.retrieval import Retriever
from jobmatch.workflow import inspect_request, run_research
from conftest import FakeLLM


def write(path, value):
    data = (json.dumps(value, ensure_ascii=False) if not isinstance(value, str) else value).encode("utf-8")
    path.write_bytes(data)
    return hashlib.sha256(data).hexdigest()


def request(tmp_path, *, complete=False):
    catalog_sha = write(tmp_path / "catalog.json", {"records": [{"id": "a"}, {"id": "b"}, {"id": "other"}]})
    jd_sha = write(tmp_path / "jd.txt", "需要 Python 开发经验。")
    obj = {"schema_version": 1, "company": "测试公司", "scope": "测试公司两岗研究",
        "coverage": {"capture_status": "complete" if complete else "partial", "note": "合成测试目录",
                     "official_total": 3, "last_page_reached": complete, "human_attested": complete},
        "raw_catalog": {"file": "catalog.json", "sha256": catalog_sha, "format": "json",
                        "records_path": "/records", "id_path": "/id", "total_positions": 3},
        "catalog_index": [{"id": i, "title": "接口开发"+i, "city": "上海", "in_scope": True} for i in ("a", "b")]
            + [{"id": "other", "title": "范围外岗位", "in_scope": False, "exclusion": "不属于本次技术岗位范围"}],
        "jd_sources": [{"position_id": i, "file": "jd.txt", "sha256": jd_sha, "url": "https://example.invalid/"+i,
                        "read_at": "2026-09-29T10:00:00+08:00"} for i in ("a", "b")]}
    path = tmp_path / "request.json"
    write(path, obj)
    return path, obj


def engine(corpus, replies):
    return Matcher(FakeLLM(replies), Retriever(corpus, "full"), corpus, default_paths().matching_scripts)


def replies():
    return [json.dumps({"requirements": [{"text": "Python", "category": "core_capability", "jd_lines": [1], "category_basis_lines": [1]}]}),
            json.dumps({"judgments": [{"requirement_id": "R1", "support": "direct_support", "conclusion": "satisfied",
              "evidence_ids": ["python"], "judgment": "有直接开发证据。", "unverified_aspects": []}]})]


RULES = {"read_only": True, "selection_rules": "合成规则：仅研究，不投递。"}


def test_full_catalog_survives_handoff_without_user_selection(corpus, tmp_path):
    path, _ = request(tmp_path, complete=True)
    out = tmp_path / "run"
    report = run_research(path, out, engine(corpus, replies()*2), RULES)
    assert report["mechanical_passed"] and report["execution_status"] == "completed"
    ready = report["readiness"]
    assert ready["can_generate_full_comparison"]
    assert set(ready["registerable_position_ids"]) == {"a", "b"}
    assert not ready["can_register_selected_position"] and ready["selected_position_id"] is None
    assert report["gate_checks"]["application_limit"]["status"] == "unknown"
    raw = json.loads((out / "pipeline/assembled-matching.json").read_text(encoding="utf-8"))
    assert "selected_position_id" not in raw
    assert len(raw["catalog_index"]) == 3 and len(raw["positions"]) == 2
    assert raw["positions"][0]["jd_source"]["read_at"] == "2026-09-29T10:00:00+08:00"
    assert (out / "pipeline" / raw["positions"][0]["jd_source"]["provided_snapshot_file"]).is_file()
    assert "S/A/B/C" in (out / "research-report.md").read_text(encoding="utf-8")
    display = json.loads((out / "pipeline/human-summary.json").read_text(encoding="utf-8"))
    assert display["metric"] == "evidence_match_not_hire_probability"


def test_partial_source_never_becomes_full_by_matching_all_supplied_jobs(corpus, tmp_path):
    path, _ = request(tmp_path)
    report = run_research(path, tmp_path / "run", engine(corpus, replies()*2), RULES)
    assert report["mechanical_passed"]
    assert not report["readiness"]["can_generate_full_comparison"]
    assert report["readiness"]["registerable_position_ids"] == []


def test_changed_jd_and_missing_identity_are_rejected_before_model(corpus, tmp_path):
    path, obj = request(tmp_path)
    write(tmp_path / "jd.txt", "改成博士要求")
    with pytest.raises(ValueError, match="哈希"):
        inspect_request(path)
    obj["catalog_index"][0]["id"] = "invented"
    write(path, obj)
    with pytest.raises(ValueError, match="ID"):
        inspect_request(path)


def test_unknown_and_fake_rule_observations_do_not_become_verified(tmp_path):
    path, obj = request(tmp_path)
    source = {k:v for k,v in obj["jd_sources"][0].items() if k != "position_id"}
    obj["observations"] = [{"topic": "application_limit", "text": "无限额", "quote": "无限额", "source": source}]
    write(path, obj)
    with pytest.raises(ValueError, match="引文"):
        inspect_request(path)
    obj.pop("observations")
    obj["selected_position_id"] = "a"
    write(path, obj)
    with pytest.raises(ValueError):
        inspect_request(path)


def test_failed_job_is_retained_and_blocks_full_handoff(corpus, tmp_path):
    path, _ = request(tmp_path, complete=True)
    match = engine(corpus, replies() + [RuntimeError("fixture model failed")])
    report = run_research(path, tmp_path / "run", match, RULES)
    assert report["execution_status"] == "completed_with_failures"
    assert len(report["jobs"]) == 2 and report["jobs"][1]["decision"] is None
    assert not report["readiness"]["can_generate_full_comparison"]
    assert report["readiness"]["can_register_selected_position"] is False


def test_scoped_cohort_context_reaches_both_model_steps_and_published_snapshot(corpus, tmp_path):
    path, obj = request(tmp_path, complete=True)
    obj["observations"] = []
    for pid, year in (("a", "2027"), ("b", "2026")):
        name = f"cohort-{pid}.txt"
        quote = year + "届校园招聘"
        value = write(tmp_path / name, quote)
        obj["observations"].append({"topic": "cohort", "position_ids": [pid], "text": "官方届别观察",
            "quote": quote, "source": {"file": name, "sha256": value,
            "url": "https://example.invalid/cohort-" + pid, "read_at": "2026-09-29T10:00:00+08:00"}})
    write(path, obj)
    match = engine(corpus, replies() * 2)
    out = tmp_path / "run"
    report = run_research(path, out, match, RULES)
    assert report["mechanical_passed"]
    for offset, year in ((0, "2027"), (2, "2026")):
        extracted = json.loads(match.llm.requests[offset][0][1]["content"])
        judged = json.loads(match.llm.requests[offset + 1][0][1]["content"])
        assert extracted["source_context"][0]["quote"] == year + "届校园招聘"
        assert judged["job_context"]["source_context"] == extracted["source_context"]
        assert len(extracted["source_context"]) == 1
    pipeline = out / "pipeline"
    raw = json.loads((pipeline / "assembled-matching.json").read_text(encoding="utf-8"))
    for pos in raw["positions"]:
        source = pos["jd_source"]
        context = pipeline / source["context_snapshot_file"]
        assert hashlib.sha256(context.read_bytes()).hexdigest() == source["context_sha256"]
        assert (pipeline / source["provided_snapshot_file"]).read_text(encoding="utf-8") == "需要 Python 开发经验。"
