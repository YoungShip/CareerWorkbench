from pathlib import Path

from jobmatch.evaluation.semantic import check_case, load_cases


def test_public_cases_are_synthetic_and_have_anchored_expectations():
    data = load_cases(Path(__file__).parents[1] / "src/jobmatch/resources/benchmarks/semantic-cases.json")
    assert data["provenance"]["kind"] == "synthetic"
    assert data["provenance"]["user_confirmed"] is False
    assert len(data["cases"]) == 10


def test_semantic_checker_does_not_accept_mechanical_pass_as_success():
    case = {"id": "fixture", "assertions": [{"jd_contains": "博士", "conclusions": ["not_satisfied"]}],
            "rationale": "最高学历硕士", "decisions": ["excluded"]}
    pos = {"jd_source": {"quotes": [{"id": "L1", "text": "博士"}]},
           "requirements": [{"jd_quote_ids": ["L1"], "conclusion": "satisfied", "support": "direct_support",
                             "category": "hard_qualification"}]}
    result = {"verification_passed": True, "decision": "recommended"}
    check = check_case(case, result, {"positions": [pos]})
    assert not check["passed"] and len(check["errors"]) == 2
    pos["requirements"] = []
    check = check_case(case, result, {"positions": [pos]})
    assert not check["passed"] and "未提取" in check["errors"][0]


def test_assertion_selects_qualification_when_a_line_has_several_requirements():
    case = {"id": "fixture", "assertions": [{"jd_contains": "博士", "requirement_contains": "博士",
            "conclusions": ["not_satisfied"]}], "rationale": "最高学历硕士"}
    pos = {"jd_source": {"quotes": [{"id": "L1", "text": "博士学历，有开发经验"}]}, "requirements": [
        {"text": "博士学历", "jd_quote_ids": ["L1"], "conclusion": "not_satisfied"},
        {"text": "开发经验", "jd_quote_ids": ["L1"], "conclusion": "pending"}]}
    assert check_case(case, {"verification_passed": True}, {"positions": [pos]})["passed"]


def test_quality_pairs_have_controlled_inputs_and_explicit_transitions():
    data = load_cases(Path(__file__).parents[1] / "src/jobmatch/resources/benchmarks/quality-pairs-v1.json")
    assert len(data["cases"]) == 10 and len(data["pairs"]) == 5
    assert data["provenance"]["kind"] == "synthetic"


def test_false_positive_and_wrong_evidence_are_separate_quality_errors():
    case = {"id": "fixture", "assertions": [{"jd_contains": "Redis", "conclusions": ["pending"],
             "required_evidence_ids": ["course"]}], "rationale": "课程接触"}
    pos = {"jd_source": {"quotes": [{"id": "L1", "text": "熟练Redis"}]}, "requirements": [
        {"text": "熟练Redis", "jd_quote_ids": ["L1"], "conclusion": "satisfied",
         "support": "direct_support", "category": "core_capability", "candidate_evidence_ids": ["python"]}]}
    check = check_case(case, {"verification_passed": True}, {"positions": [pos]})
    assert set(check["error_categories"]) == {"false_satisfied", "missing_expected_evidence"}
    assert check["assertions_passed"] == 0


def test_semantic_comparison_rejects_changed_test_oracle(tmp_path):
    import json
    import pytest
    from jobmatch.evaluation.semantic import compare_semantic
    before, after = tmp_path / "a", tmp_path / "b"
    for p, identity in ((before, "first-set"), (after, "edited-expectations")):
        p.mkdir()
        (p / "manifest.json").write_text(json.dumps({"dataset_sha256": identity}))
    with pytest.raises(ValueError, match="评测集或断言不同"):
        compare_semantic(before, after)


def test_semantic_resume_keeps_expectations_and_source_labels_out_of_model(tmp_path):
    import json
    from jobmatch.config import default_paths
    from jobmatch.evaluation.semantic import run_semantic
    from conftest import FakeLLM
    cases = {"schema_version": 1, "provenance": {"kind": "synthetic"},
        "cases": [{"id": i, "title": "接口岗位", "jd": "有Python接口经验。",
            "evidence": [{"id": "e1", "kind": "项目", "text": "有Python接口开发记录。", "source": "SECRET_GOLD_PATH"}],
            "assertions": [{"jd_contains": "Python", "conclusions": ["satisfied"]}],
            "decisions": ["recommended"], "rationale": "SECRET_EXPECTATION"} for i in ("SECRET_CASE_A", "SECRET_CASE_B")]}
    source = tmp_path / "cases.json"
    source.write_text(json.dumps(cases), encoding="utf-8")
    clients = []
    extraction = {"requirements": [{"text": "Python接口经验", "category": "core_capability", "jd_lines": [1], "category_basis_lines": [1]}]}
    judgment = {"judgments": [{"requirement_id": "R1", "support": "direct_support", "conclusion": "satisfied",
                             "evidence_ids": ["e1"], "judgment": "证据直接覆盖。"}]}
    def factory():
        client = FakeLLM([json.dumps(extraction), json.dumps(judgment)])
        clients.append(client)
        return client
    out = tmp_path / "run"
    first = run_semantic(source, out, factory, default_paths().matching_scripts, model_name="fixture", stop_after=1)
    assert first["execution_status"] == "interrupted" and first["total"] == 2 and first["completed_cases"] == 1
    first_calls = sum(len(c.requests) for c in clients)
    resumed = run_semantic(source, out, factory, default_paths().matching_scripts, model_name="fixture", resume=True)
    assert resumed["passed"] == 2 and sum(len(c.requests) for c in clients) - first_calls == 2
    inputs = json.dumps([messages for c in clients for messages, _ in c.requests], ensure_ascii=False)
    assert all(secret not in inputs for secret in ("SECRET_CASE", "SECRET_EXPECTATION", "SECRET_GOLD_PATH"))
    done_calls = sum(len(c.requests) for c in clients)
    run_semantic(source, out, factory, default_paths().matching_scripts, model_name="fixture", resume=True)
    assert sum(len(c.requests) for c in clients) == done_calls


def test_paired_expectations_are_part_of_overall_success():
    from jobmatch.evaluation.semantic import semantic_success
    assert not semantic_success({"total": 2, "passed": 2, "pairs": [{"passed": False}]})
    assert semantic_success({"total": 2, "passed": 2, "pairs": [{"passed": True}]})
