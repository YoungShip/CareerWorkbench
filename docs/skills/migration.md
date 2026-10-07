# Legacy matching-record migration

旧版记录（没有 `schema_version: 2`）仍可被读取和展示，但校验器会返回 `legacy/unverified`、非零退出码，并且不会自动改写原文件、补造证据或升级验证状态。

## Manual migration

1. 保留旧 `catalog_index`、原始快照和旧岗位说明，先确认岗位身份没有变化。
2. 在 `raw_catalog` 中显式声明 `format` 与 ID 提取规则；无法可靠提取 ID 时保持 `unverifiable`。
3. 添加 `coverage`，区分 `complete`、`partial`、`unknown`，不要从抓取条数反推官网全量。
4. 对范围内岗位补齐 `jd_source`、`candidate_source` 和 `requirements[]`；旧的 `jd_evidence`、自由文本 `match_reasons` 和百分比不能自动转换成证据映射。
5. 只有实际存在于相应快照/档案版本中的引文才能作为引用。找不到的旧证据保持待确认，不能复制一段新文字冒充历史证据。
6. 重新计算 `requirement_summary`，再填写 `decision`；通过后仍要人工审阅岗位语义和推荐顺序。

## Caller migration

旧调用如果只判断 `passed` 或退出码，应改为读取完整 JSON 报告：

- `checks` 判断结构、目录、证据和决策的一致性；
- `positions[]` 判断某个岗位是否 `verified`；
- `readiness.can_generate_full_comparison` 判断能否生成全量比较；
- `readiness.registerable_position_ids` 列出可登记复核的稳定岗位 ID；
- 传入 `selected_position_id` 后，只有该 ID 在上述列表中且 `can_register_selected_position=true`，才能进入主表登记前的人审与用户确认。

非零报告仍可能包含已核实岗位，可以展示这些岗位；但不能因此宣称全量完成或直接写入主表。

如果输入 JSON 本身损坏，报告会把 `structure` 标为 `failed`，其余尚未运行的维度标为 `not_run`，并将 `readiness.status` 设为 `blocked`。调用方不能把这种兼容读取或部分岗位展示当作目录、证据和推荐已经核验完成。
