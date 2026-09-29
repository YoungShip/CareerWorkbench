from jobmatch.evaluation.report import make_report


def result(identifier, decision, passed=True, **extra):
    return {"eval_id": identifier, "decision": decision, "verification_passed": passed,
        "variant": "bm25", "elapsed_ms": 100, "first_passed": passed, "usage": [], **extra}


def test_missing_labels_and_prices_are_unknown():
    report = make_report([result("a", "recommended")], {})
    assert report["status"] == "no_manual_labels"
    assert report["all_labels"]["agreement"] is None
    assert report["estimated_cost_cny"] is None


def test_failures_stay_in_denominator_and_preference_split():
    rows = [result("a", "recommended"), result("b", None, False), result("c", "pending")]
    labels = {"a": {"judgment": "投"}, "b": {"judgment": "不投"},
              "c": {"judgment": "不投", "reason": "方向不想做"}}
    report = make_report(rows, labels)
    assert report["all_labels"]["agreement"] == 1 / 3
    assert report["all_labels"]["confusion"]["不投"]["运行失败"] == 1
    assert report["all_labels"]["binary"]["accuracy"] == 2 / 3
    assert report["excluding_preferences"]["agreement"] == .5
    assert report["final_pass_rate"] == 2 / 3


def test_duplicate_results_cannot_inflate_score():
    import pytest
    with pytest.raises(ValueError):
        make_report([result("a", "recommended")] * 2, {})


def test_zero_f1_and_interest_labels_are_not_ability_gold():
    report = make_report([result("a", "excluded"), result("b", "recommended")],
        {"a": {"judgment": "投"}, "b": {"judgment": "不投"}},
        {"kind": "initial_application_interest", "ability_ground_truth": False})
    assert report["all_labels"]["binary"]["f1"] == 0.0
    assert report["label_semantics"]["ability_ground_truth"] is False


def test_interrupted_usage_is_not_reported_as_total_cost():
    row = result("a", "recommended", usage_complete=False, attempt_count=2, interrupted_attempts=1,
                 usage=[{"input_tokens": 10, "output_tokens": 5, "cost_cny": 1.0}])
    report = make_report([row], {})
    assert report["input_tokens"] == 10 and report["usage_complete"] is False
    assert report["estimated_cost_cny"] is None
    assert report["recovery"]["interrupted_attempts"] == 1
