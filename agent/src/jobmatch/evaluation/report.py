"""真实标签一致率与运行指标；缺少标签/价格时返回 null，不填造数字。"""

from collections import Counter
from statistics import median
from math import floor, ceil

MAP = {"recommended": "投", "consider": "投", "pending": "说不准", "excluded": "不投", "not_applicable": "不投"}
PREFERENCES = {"方向不想做", "城市或其他偏好"}


def ratio(n, d):
    return n / d if d else None


def percentile(values, p):
    if not values:
        return None
    rank = (len(values) - 1) * p
    lo, hi = floor(rank), ceil(rank)
    return values[lo] + (values[hi] - values[lo]) * (rank - lo)


def agreement(results: list[dict], labels: dict, *, exclude_preferences=False) -> dict:
    rows = []
    for result in results:
        label = labels.get(result["eval_id"])
        if not label or (exclude_preferences and label.get("reason") in PREFERENCES):
            continue
        if label.get("judgment") not in {"投", "不投", "说不准"}:
            raise ValueError("非法人工判断")
        prediction = MAP.get(result.get("decision")) if result.get("verification_passed") else None
        rows.append((label["judgment"], prediction))
    confusion = {truth: {prediction: 0 for prediction in ("投", "不投", "说不准", "运行失败")} for truth in ("投", "不投", "说不准")}
    for truth, prediction in rows:
        confusion[truth][prediction or "运行失败"] += 1
    binary = [(truth, prediction) for truth, prediction in rows if truth != "说不准"]
    tp = sum(t == "投" and p == "投" for t, p in binary)
    predicted = sum(p == "投" for _, p in binary)
    positives = sum(t == "投" for t, _ in binary)
    precision, recall = ratio(tp, predicted), ratio(tp, positives)
    f1 = None if precision is None or recall is None else (2 * precision * recall / (precision + recall) if precision + recall else 0.0)
    return {
        "annotated_attempts": len(rows), "agreement": ratio(sum(t == p for t, p in rows), len(rows)),
        "confusion": confusion, "failed_or_unclassified": sum(p is None for _, p in rows),
        "binary": {"n": len(binary), "precision": precision, "recall": recall, "f1": f1,
                   "accuracy": ratio(sum((t == "投") == (p == "投") for t, p in binary if p is not None), len(binary)),
                   "uncertain_prediction_is_negative": True},
    }


def make_report(results: list[dict], labels: dict, label_metadata: dict | None = None) -> dict:
    ids = [r["eval_id"] for r in results]
    if len(ids) != len(set(ids)):
        raise ValueError("结果含重复 eval_id，不能重复计入指标")
    variants = {r.get("variant") for r in results}
    if len(variants) > 1:
        raise ValueError("每份报告仅接受一个消融版本")
    passed = sum(r.get("verification_passed") is True for r in results)
    first = sum(r.get("first_passed") is True for r in results)
    usage = [u for r in results for u in r.get("usage", [])]
    usage_complete = all(r.get("usage_complete", True) for r in results)
    elapsed = sorted(r["elapsed_ms"] for r in results if isinstance(r.get("elapsed_ms"), (int, float)))
    badcases = [{"eval_id": r["eval_id"], "decision": r.get("decision"), "error_type": r.get("error_type"),
                "issues": r.get("attempts", [])} for r in results
               if not r.get("verification_passed") or (r["eval_id"] in labels and MAP.get(r.get("decision")) != labels[r["eval_id"]]["judgment"])]
    def total(field):
        return sum(u[field] for u in usage) if usage and all(u.get(field) is not None for u in usage) else None
    applied = [r for r in results if r.get("applied")]
    return {
        "status": "evaluated_against_user_labels" if any(r["eval_id"] in labels for r in results) else "no_manual_labels",
        "label_semantics": label_metadata or {"kind": "unspecified_user_preference", "ability_ground_truth": False},
        "variant": next(iter(variants)) if variants else None,
        "attempted": len(results), "mechanical_passed": passed,
        "first_pass_rate": ratio(first, len(results)), "final_pass_rate": ratio(passed, len(results)),
        "all_labels": agreement(results, labels), "excluding_preferences": agreement(results, labels, exclude_preferences=True),
        "applied_weak_label": {"n": len(applied), "recall": ratio(sum(r.get("verification_passed") and MAP.get(r.get("decision")) == "投" for r in applied), len(applied))},
        "label_count": len(labels), "labels_not_in_run": len(set(labels) - set(ids)),
        "repairs": dict(Counter(r.get("repairs", 0) for r in results)),
        "failure_codes": dict(Counter(c for r in results for a in r.get("attempts", []) for c in a.get("codes", []))),
        "input_tokens": total("input_tokens"), "output_tokens": total("output_tokens"),
        "usage_complete": usage_complete, "estimated_cost_cny": total("cost_cny") if usage_complete else None,
        "recovery": {"retried_jobs": sum(r.get("attempt_count", 1) > 1 for r in results),
                     "prior_failed_attempts": sum(r.get("prior_failures", 0) for r in results),
                     "interrupted_attempts": sum(r.get("interrupted_attempts", 0) for r in results)},
        "latency_ms": {"p50": median(elapsed) if elapsed else None, "p90": percentile(elapsed, .9)},
        "badcases": badcases,
        "limitations": [
            "结构校验与引用存在性不能证明语义判断正确。",
            "本人投递偏好一致率不是录用率，已投历史只是弱标签。",
            "人工标签不进入模型输入；失败样本保留在分母与失败列。",
            "小样本、历史岗位与当前档案的组合不代表所有公司或候选人。",
            "恢复后的指标保留已封存失败尝试；中断或缺少API回执时用量不完整，token只计已知部分，不估算总费用。",
        ],
    }
