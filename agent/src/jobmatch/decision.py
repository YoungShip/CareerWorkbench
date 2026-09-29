"""由逐条判定推导岗位决策：规则与校验器 evaluate_decision_policy 一一对应，模型不直接给结论。

只看硬性条件（hard_qualification）和核心能力（core_capability）：
- 有明确不满足（not_satisfied）→ excluded，写明哪几条不满足；
- 全部满足、且至少一条直接证据 → recommended；
- 硬性条件都满足，核心待确认项全是「可迁移」→ consider；
- 其余（硬性条件待确认、核心无证据或有冲突待确认）→ pending。
"""

from __future__ import annotations

from typing import Any

CORE = {"hard_qualification", "core_capability"}
_LABEL = {"hard_qualification": "硬性条件", "core_capability": "核心能力"}


def _brief(items: list[dict[str, Any]], limit: int = 3) -> str:
    texts = [str(item.get("text", "")).strip()[:24] for item in items[:limit]]
    more = f"等 {len(items)} 项" if len(items) > limit else ""
    return "、".join(f"「{t}」" for t in texts) + more


def derive_decision(requirements: list[dict[str, Any]]) -> dict[str, Any]:
    """返回 {state, reason, excluded, exclusion_reason}。"""
    core = [r for r in requirements if r.get("category") in CORE]
    hard = [r for r in core if r.get("category") == "hard_qualification"]
    failed = [r for r in core if r.get("conclusion") == "not_satisfied"]
    pending = [r for r in core if r.get("conclusion") == "pending"]
    hard_pending = [r for r in hard if r.get("conclusion") == "pending"]
    direct = any(r.get("support") == "direct_support" for r in core)

    if failed:
        kinds = "、".join(sorted({_LABEL[r["category"]] for r in failed}, key=list(_LABEL.values()).index))
        reason = f"{kinds}不满足：{_brief(failed)}"
        return {"state": "excluded", "reason": reason, "excluded": True, "exclusion_reason": reason}
    if not pending and direct:
        satisfied = sum(1 for r in core if r.get("conclusion") == "satisfied")
        reason = f"硬性条件与核心能力共 {len(core)} 项，{satisfied} 项有直接证据支持，无待确认项"
        return {"state": "recommended", "reason": reason, "excluded": False, "exclusion_reason": None}
    if pending and not hard_pending and all(r.get("support") == "transferable" for r in pending):
        reason = f"硬性条件已满足；核心能力 {len(pending)} 项为可迁移经验，待确认：{_brief(pending)}"
        return {"state": "consider", "reason": reason, "excluded": False, "exclusion_reason": None}
    if pending:
        parts = []
        if hard_pending:
            parts.append(f"硬性条件待确认 {_brief(hard_pending)}")
        other = [r for r in pending if r.get("category") != "hard_qualification"]
        unsupported = [r for r in other if r.get("support") != "transferable"]
        if unsupported:
            parts.append(f"核心能力缺少证据或有冲突 {_brief(unsupported)}")
        elif other:
            parts.append(f"核心能力可迁移待确认 {_brief(other)}")
        return {"state": "pending", "reason": "；".join(parts), "excluded": False, "exclusion_reason": None}
    # 兜底：拆要求阶段会拒绝没有核心条目的结果；「满足」却没有直接证据属于逐条判定自相矛盾，交给校验和纠错
    reason = "核心条目的支持关系与结论不一致，待校验后修正" if core else "未识别出硬性条件或核心能力要求"
    return {"state": "pending", "reason": reason, "excluded": False, "exclusion_reason": None}
