# Matching record contract (schema v2)

`matching.json` 对账四件事：目录身份、研究范围、JD/候选人证据引用、岗位级决策。它能证明引用与本地快照一致，不能单独证明官方来源真实、候选人语义匹配正确，或官网岗位已经抓全。

## 1. Root contract

必填字段：

```text
schema_version: 2
company, date, scope
coverage
raw_catalog
catalog_index[]
positions[]
```

### Coverage is a separate claim

`raw_catalog` 对账只针对提供的本地快照。为了让“目录与快照一致”和“本次确实完成官方范围抓取”不混淆，使用独立的 `coverage`：

```json
{
  "capture_status": "complete|partial|unknown",
  "official_total": 1,
  "last_page_reached": true,
  "human_attested": true
}
```

当 `capture_status=complete` 时，必须提供官方总数、最后一页/API 穷尽证据，并由人工确认 `human_attested=true`。校验器最多报告 `attested_not_independently_proven`，不会把它升级成“官网全量已被自动证明”。

## 2. Raw catalog identity contract

不能根据扩展名猜字段，也不能用标题模糊匹配岗位身份。必须显式声明原始数据格式和 ID 提取方式：

### JSON

```json
{
  "file": "catalog.json",
  "format": "json",
  "records_path": "/data/items",
  "id_path": "/positionId",
  "total_positions": 1
}
```

根数组使用 `records_path: ""`。`records_path` 和 `id_path` 都是 JSON Pointer；`id_path` 为空字符串表示记录本身就是 ID。

### CSV/TSV

```json
{
  "file": "catalog.csv",
  "format": "csv",
  "id_column": "position_id",
  "total_positions": 1
}
```

如果身份无法可靠提取，报告必须是 `unverifiable`，退出码非零，不得仅给 warning 后宣称通过。原始快照和 `catalog_index` 的 ID 集合必须分别核对缺失、多余和重复项；数量相同不能替代身份对账。任一侧出现重复 ID 都会阻断目录对账，即使去重后的集合和数量看起来相同；损坏/不支持的输入标记为 `invalid`，缺少可靠提取规则或 ID 缺失标记为 `unverifiable`。

## 3. Scope semantics

- `catalog_index[].in_scope` 表示岗位是否属于本次研究范围，不表示候选人是否适合。
- 范围内岗位可以在完整要求核对后 `excluded=true`，但必须写 `exclusion_reason`；例如明确硬条件不满足或用户偏好排除。
- 范围外岗位若保留解释记录，必须 `excluded=true` 且 `decision.state=not_applicable`，不得计入有效匹配或推荐。
- 范围内未排除岗位的 `decision.state` 为 `recommended`、`consider` 或 `pending`；决策必须由逐项 `requirements` 汇总产生。
- 汇总中的 `recommended`、`pending`、`excluded` 计数只统计范围内岗位；范围外解释记录只能单独展示，不能进入有效匹配、推荐或主表登记条件。

## 4. Shared source records

每个范围内岗位在 `positions[]` 中共享一份 JD 来源和一份候选人档案来源，要求条目只引用 ID，避免逐条复制完整正文：

```json
{
  "jd_source": {
    "position_id": "role-1",
    "url": "https://example.invalid/jobs/role-1",
    "read_at": "2026-01-01T00:00:00Z",
    "snapshot_file": "fixtures/role-1-jd.txt",
    "quotes": [
      {
        "id": "jd-r1",
        "text": "独立完成 VLA 训练。",
        "locator": {"line_start": 1, "line_end": 1}
      }
    ]
  },
  "candidate_source": {
    "profile_version": "fixture-profile-v1",
    "snapshot_file": "fixtures/candidate-evidence.txt",
    "evidence": [
      {
        "id": "ev-r1",
        "text": "运行开源 VLA 推理。",
        "locator": {"line_start": 1, "line_end": 1}
      }
    ]
  }
}
```

`url`、`read_at`、`position_id`、`profile_version` 和本地 `snapshot_file` 都必须可核对。提供 `sha256` 时校验器实际计算文件哈希；提供 `locator` 时实际检查引文位于对应 1-based 行区间；没有 locator 时仍会在整个快照中搜索规范化引文。规范化只用于比较：折叠连续空白，并去掉中文字符之间由换行/排版产生的空白，不改写保存的引文原文。

## 5. Requirement-to-evidence mapping

每条要求使用以下最小结构：

```json
{
  "requirement_id": "role-1-req-1",
  "text": "独立完成 VLA 训练",
  "category": "core_capability",
  "category_basis_quote_ids": ["jd-r1"],
  "jd_quote_ids": ["jd-r1"],
  "candidate_evidence_ids": ["ev-r1"],
  "support": "transferable",
  "conclusion": "pending",
  "judgment": "已有推理证据，但不能证明独立完成训练。"
}
```

### Categories

- `hard_qualification`：JD 明确的学历、届别、证书、年限等硬资格；
- `core_capability`：岗位核心能力或主要职责；
- `plus`：加分项、优先项、nice-to-have；
- `ambiguous`：原文语义不足以可靠分类，必须保持待确认。

未给具体任务、经验或验收标准的“兴趣、好奇心、自驱力、学习快、沟通高效”等纯个人特质，保留为 `ambiguous + pending`，由面试核实。同句中的需求分析、具体问题定位、方案设计与交付等可观察能力须单独保留为 `core_capability`。不得额外要求 JD 没写的企业级规模或完全独立手写；AI 辅助经历仍按已确认职责与边界逐项判断。

类别必须有 `category_basis_quote_ids`。不能把“优先/加分”自行升级为硬门槛。

### Conclusion versus support

`conclusion`：`satisfied`、`not_satisfied`、`pending`。

`support`：`direct_support`、`transferable`、`no_evidence`、`conflict`。

约束：

- `satisfied`、`direct_support`、`transferable`、`conflict` 都必须有候选人证据 ID；
- `no_evidence` 必须是空证据数组，且结论不能是 `not_satisfied`；无证据只能 `pending`；
- 候选人来源的 `evidence` 数组可以为空，以表达当前档案没有相关证据；此时对应要求必须使用 `no_evidence + pending`；
- `hard_qualification` 为 `pending` 时不能声称满足资格，也不能直接推荐；
- `ambiguous` 必须 `pending`；
- 引用 ID 必须是非空字符串，并存在于同一岗位/版本的共享来源记录；不能把数字或空值强制转换成 ID。

允许的支持关系—结论组合：`direct_support` 允许 `satisfied/pending`；`transferable` 只允许 `pending`；`no_evidence` 只允许 `pending`；`conflict` 允许 `pending/not_satisfied`。因此未解决冲突不能 `satisfied`，可迁移证据也不能自动升级为满足。校验器检查的是状态一致性，不是对语义正确性的自动理解。

## 6. Requirement summary and decision

### Deterministic count semantics

`requirement_summary` is derived from `requirements[]`; the model must not invent, omit, or hand-edit these counts. The category counts are mutually exclusive and must satisfy:

- `requirements_total` = the number of `requirements[]` items;
- `hard_qualification`, `core_capability`, `plus`, and `ambiguous` count their exact `category` values, and their sum equals `requirements_total`;
- `core_total` = `hard_qualification + core_capability`; it excludes `plus` and `ambiguous`;
- `direct_support`, `transferable`, `no_evidence`, and `conflict` count exact `support` values, and their sum equals `requirements_total`;
- `satisfied`, `not_satisfied`, and `pending` count exact `conclusion` values, and their sum equals `requirements_total`;
- every count is an integer in `0..requirements_total`.

`requirement_summary` 必须由 `requirements` 逐项统计，至少包含：

```json
{
  "requirements_total": 1,
  "hard_qualification": 0,
  "core_capability": 1,
  "plus": 0,
  "ambiguous": 0,
  "core_total": 1,
  "direct_support": 0,
  "transferable": 1,
  "no_evidence": 0,
  "conflict": 0,
  "satisfied": 0,
  "not_satisfied": 0,
  "pending": 1
}
```

Example with one hard qualification, two core capabilities, and one plus item:

```json
{
  "requirements_total": 4,
  "hard_qualification": 1,
  "core_capability": 2,
  "plus": 1,
  "ambiguous": 0,
  "core_total": 3,
  "direct_support": 2,
  "transferable": 1,
  "no_evidence": 1,
  "conflict": 0,
  "satisfied": 2,
  "not_satisfied": 0,
  "pending": 2
}
```

Here `core_total=3` is `1` hard qualification plus `2` core capabilities; the one `plus` item is not included.

`decision` 必须包含：

```json
{
  "state": "recommended|consider|pending|excluded|not_applicable",
  "basis": "requirement_summary",
  "reason": "由逐项证据汇总产生的简短说明。"
}
```

正式执行路径为：模型输出 → 原样保存 raw → `scripts/run-matching-pipeline.py` 组装派生汇总 → `scripts/verify-matching.py` → 按 `checks`/`readiness` 消费正式结果。校验器会重新计算 summary，拒绝手工篡改数量；raw 仅用于审计，不是最终消费记录。pipeline 的 `execution_status=completed`（兼容字段仍为 `status=completed`）只表示子流程执行结束，不表示验证通过；消费者必须读取 `verification_status`、`readiness_status`、`mechanical_passed` 与完整内层报告。推荐规则保持简单：

- `recommended`：硬/核心要求均为 `satisfied`，至少一项直接支持，且无冲突；
- `consider`：硬资格全部满足，核心要求存在 `transferable + pending` 的可迁移证据缺口；允许用户在复核后尝试性申请，但不代表满足；
- `pending`：硬资格未核实，或核心要求只有 `no_evidence/conflict` 等未解决状态；不能因为把同一事实改名为 `consider` 就获得许可；
- `excluded`：有明确可追溯排除依据；
- `not_applicable`：仅用于范围外解释记录。

多要求组合按以下优先级处理：先检查硬资格；硬资格 `pending/not_satisfied` 时不能 `recommended/consider`。再检查核心要求：任一核心 `not_satisfied` 或 `conflict` 时，`pending` 可以如实保存但不可登记，`consider`/`recommended` 均阻断；只有硬资格已满足、核心缺口全部是 `transferable + pending` 时，才允许 `consider` 进入用户复核后的尝试性登记。`no_evidence` 或 `conflict` 不能被另一项可迁移证据抵消。

S/A/B/C 不作为 raw semantic record 的许可字段，但**用户可读报告必须生成派生等级与证据匹配度**。derive_matching_display.py 从已核实 requirements[] 确定性计算：
- 权重：hard_qualification/core_capability=3，plus/ambiguous=1；
- 单项证据系数：direct_support+satisfied=1.0、direct_support+pending=0.75、transferable+pending=0.55、conflict+pending=0.25、conflict+not_satisfied=0、no_evidence+pending=0；
- 得分只表示**证据匹配度，不是录用率**，对外以 5% 区间显示；
- excluded=true 的岗位展示等级固定为 C；S 仅限 recommended 且硬/核心全满足；A/B 再按得分和硬/核心失败门确定。
派生等级和区间可写入主表 match_grade/match_estimate 方便阅读，但**不能反向修改 decision，也不能绕过 readiness 登记门**。

## 7. Report semantics

校验器输出以下独立维度：

- `checks.structure`：字段和类型是否合法；
- `checks.catalog_reconciliation`：原始快照与 `catalog_index` 的身份/数量对账；
- `checks.evidence_consistency`：来源、哈希、定位、引文和引用 ID 是否一致；
- `checks.decision_consistency`：范围、summary、结论和推荐状态是否一致；
- `checks.coverage_attestation`：抓取范围是否有明确人工确认；
- `positions[]`：逐岗位 status、checks、issues 和 next_step；
- `readiness`：是否可展示已核实岗位、生成全量比较、或进入主表登记前的人审；
- `issues[]`：带 code、severity、path、position_id、message 和 next_step。

向后兼容保留 `passed/errors/warnings`，但新格式的 `passed=true` 只表示：结构、目录身份、证据引用、决策一致性和完整覆盖声明均达到进入人工复核/登记前的机械条件；它不表示官方来源真实性或语义推荐正确。`mechanical_passed` 单独表示结构/对账/证据/决策四项机械检查是否通过。新调用点应优先读取 `checks`、`coverage` 和 `readiness`；即使旧调用只看退出码，也不能把非零时已列出的单岗结果丢弃。

登记许可必须绑定身份：`readiness.registerable_position_ids` 列出满足全量覆盖和机械校验条件、且决策为 `recommended/consider` 的岗位；若输入 `selected_position_id`，只有它位于该列表时 `can_register_selected_position=true`。缺少选择时为 `selection_required`，不能用全局布尔值替代用户选中的岗位核对。

输入 JSON 损坏时也必须返回完整检查维度：`structure=failed`，目录、证据、决策和覆盖检查为 `not_run`，`readiness.status=blocked`。旧记录则返回所有维度的 `legacy_unverified/unverified`；可读取或可展示不等于满足新标准。

## 8. Example: VLA inference is not VLA training

虚构 JD：“独立完成 VLA 训练。”

虚构候选人证据：“运行开源 VLA 推理。”

正确记录：`support=transferable`、`conclusion=pending`，并在 `judgment` 说明推理经验不能证明独立训练。不能因为“VLA”两个关键词相同就写 `direct_support` 或 `satisfied`。这条是给 AI/人工验收的语义约束，不是声称校验器能理解技术语义。

## Validation command

```powershell
python -X utf8 skills/campus-recruitment/scripts/verify-matching.py path/to/matching.json
```

退出码 0 表示记录已满足完整机械条件；退出码非零表示存在结构/对账/证据/决策阻断、覆盖待核验或 legacy/unverified 状态。非零报告仍可包含已核实的 `positions[]`，应按岗位读取并展示，但不得生成全量比较或越过用户确认/必要校验。即便退出码为 0，仍应根据 `readiness` 和人工语义审查决定是否推荐或登记。
