# 本机投递主数据（2026-09-13 起）

主目录：`CareerWorkbench/dashboard/`（路径相对工作区根 `resume/`，本机位置见 [local-setup.md](local-setup.md)）。八份 CSV 是唯一投递主数据；Excel 已退役，只保留迁移备份，不再维护。研究报告、matching.json、求职档案和网申母表仍在 lapis-cv，个人事实不搬家。

## 读取与写入

所有 AI 和网页写入共用 `store.js`。不要直接重写 CSV，不运行旧 `import_tracker.py`。

```powershell
# 会话先读行动摘要；不发送通知、不生成写入计划；默认每类最多 8 条，全清单加 --limit=100
node CareerWorkbench/dashboard/tracker-cli.js brief
# 尚未研究的线索：临近截止候选、断点与待研究队列
node CareerWorkbench/discovery/cli.js next
# 公司研究仅提取当前规则；不读整张历史公司表
node CareerWorkbench/dashboard/tracker-cli.js rules
# 常规查询优先精简读取；已知对象时加 --job_id 或 --company
node CareerWorkbench/dashboard/tracker-cli.js query
# 全量审计、队列核查及 apply 前完整审计
node CareerWorkbench/dashboard/tracker-cli.js snapshot
node CareerWorkbench/dashboard/tracker-cli.js validate
node CareerWorkbench/dashboard/tracker-cli.js check-artifacts   # 列出 matching_file/research_file 指向但已不存在的证据文件（只读）
node CareerWorkbench/dashboard/tracker-cli.js preview <计划文件绝对路径>
node CareerWorkbench/dashboard/tracker-cli.js apply <计划文件绝对路径>
```

brief 只读汇总主表临期事项、discovery 临近截止候选、规则复核与同步积压；文本提取的 discovery 日期必须回官方来源确认。query 返回按需字段及 expected_revision 所需的整体 revision，snapshot 返回全部表和同一口径 revision。日常查询先 brief/query，缺少字段再按需补读；未返回字段不代表空值，不得据此清空原值。同步队列详情仍须 snapshot 核查。所有 JSON 输出命令可用 `--out=<绝对路径>` 由程序原子写出严格 UTF-8 文件，避免旧 Windows shell 重定向损坏中文。用脚本解析 JSON，不用按行 grep 推算 CSV 记录数。中文、逗号、引号和换行均合法。

CLI 输出的 JSON 需要落盘时用 `--out=<绝对路径>`，由程序以严格 UTF-8 原子写入；不要用旧版 Windows PowerShell 的文本管道保存中文 JSON。

计划结构（apply 前保留完整 snapshot 审计，先预览实际差异再 apply；随后按岗位 query 显式读回本次改动字段和关联事件，跨表或无法定向验证时用 snapshot）：

```json
{
  "expected_revision": "query/snapshot 返回的最新整体 revision",
  "operations": [
    {"type":"job.patch","job_id":"已有固定ID","patch":{"next_action":"准备笔试"}}
  ]
}
```

修改冲突返回错误，重新读取并按原意合并，不自动覆盖。写入锁只在提交期间持有；每次提交备份八表，多文件写入中断后，下次经 store 读取会恢复上次完整状态。备份在 `dashboard/.store/backups/`，禁止将此目录发布。

Windows 上若 `apply` 报 `EPERM ... rename <表>.csv.tmp-* -> <表>.csv`，先用 `query`/`snapshot` 核对事务是否回滚和 revision 是否未变；不要直接编辑 CSV，也不要只凭报错推断写入了一半。再用只读文件句柄诊断定位占用者，确认具体进程及是否有活动会话；必要时让该进程正常退出，重新读取 revision、重做 preview 后重试。2026-10-02 实测 `daily_dashboard.csv` 被 Desktop Commander 进程持有，事务回滚无残留；确认无活动会话后让其正常退出，重试成功。不要按此例盲停其他进程。

保存只替换发生变化的表，恢复只替换与备份字节不同的文件，避免无关文件被占用时阻断整次事务。仅更新辅助规则表不会刷新岗位日汇总，也不新增 OfferNotes 待同步任务；八表备份、整体版本校验和写后读回仍执行。

## 读取

- `snapshot`：返回全部八表与完整 JD、legacy 字段，体积较大（本机实测约 1.0 MB）。需要完整状态或做全量审计时使用。
- `query`：按需精简读取，内部仍校验完整状态，**revision 与 snapshot 完全一致**（同一个整体 revision 语义），只是少返回内容。
  - 过滤：`--job_id=<id>`（可重复或用 `--job_ids=a,b`）、`--company=<名>`、`--status=<状态>`
  - 投影：`--fields=a,b,c` 指定字段；默认 15 个常用字段，**不含** `job_description`、`notes`、`legacy_record`、`legacy_row`
  - 需要 JD 时：`--include_description`；不需要关联日程时：`--no_events`
  - 返回 `jobs[]`、必要关联事件 `events[]`（含共享测评的 `related_job_ids`）、`counts` 与 `meta.utf8_bytes`
  - 本机实测：全量 1,043,456 字节 → 默认投影 150,224 字节（14.4%）；单岗位含 JD 约 4.5 KB
  - 常规维护（进度、待办、排期）优先用 `query`；**提交前审计仍读全量 `snapshot`**，不减少审计，不丢历史事实。

## 操作

- `job.add`：job_id 用新 UUID（例如 `job_<UUID>`）；record 为字段对象。新线索只能 Pending/Deferred/Needs user/Blocked/Skipped，研究后待投登记仍需本人选定；research_file、matching_file 指向已通过校验的材料。
  登记许可由写入路径强制校验，必须显式声明 `registration` 二选一，没有默认值、不静默兜底：
  - `registration:"research"`：研究后待投登记。必须提供 `matching_file`（绝对路径）与本人选中的 `selected_position_id`；写入路径会用受信任校验器真实验证该记录，并要求 `readiness.can_register_selected_position=true` 且 `selected_position_id` 位于 `readiness.registerable_position_ids`。**pipeline 退出码 0 或 `status=completed` 不等于匹配通过**，只认 `checks`/`readiness`。旧 schema 记录、缺证据快照、引文不在快照内都会被拒绝。
  - `registration:"manual"`：人工直接登记（新线索或历史补录）。必须提供 `registration_reason`，且不得声称 `matching_file`。写入后 `source` 保留原始来源（如有），并另起一行追加 `manual: <理由>`，与自动路径可区分、可追溯；原来源不能覆盖登记理由。
  - 校验器运行时只来自受信任启动配置：默认环境配置，或程序创建 store 时显式传入 `createStore(root, {runtime})`。配置在创建时复制并固定；计划根、operation 及 record 中的 `runtime` 都会拒绝，不能由待审计划更换校验器。测试也只能在创建 store 时注入依赖。
  - research 登记同样保留原始 `source`，另起一行追加 `research: matching=<路径> position=<ID> readiness=<状态>`，不以已有来源覆盖验证留痕。
  - position_id 与 job_id 不假设相同：默认要求 `job_id === selected_position_id`；若两者本就不同，须用 `position_job_map` 显式声明映射，例如 `{"role-1":"job_xxx"}`。
  历史岗位的备注、测评、面试与提交证据维护走 `job.patch`/`log.add`/`event.*`，**不经过**登记许可，无需重做研究。
- `job.patch`：job_id + patch，仅更新列出的字段，未列字段保留。job_id 不可改。
- `job.delete`：仅用于本人明确要求删除的岗位，提供 reason。已有 OfferNotes ID 时先备份并删除本人线上对应记录、读回确认不存在，再提供 deleted_offernotes_id（须与原ID一致）。默认拒绝有申请日志或日程的岗位；本人明确要求连同当前记录移除时，须先归档历史，提供 archive_history:true、expected_log_ids 和 expected_event_ids，两个列表必须与当前历史 ID 完全一致。本地事务备份全部表后，删除该岗位、关联日志、日程及同步队列，备份保留供恢复。删除投递记录不代表撤回网申，也不抹除曾投递的事实。
- `log.add`：job_id + log_id（可省略自动生成）+ record。由未投变 Submitted 时，必须同计划追加 Submitted 日志，含 submission_evidence / confirmation_url / confirmation_text 至少一项，并有真实投递证据；不把登记当投递。填写 application_date 为实际投递日。
- `event.add` / `event.patch`：job_id + event_id（新增可自动生成）+ record；date、event_type 必填，time 未知可空。阶段事件可填 stage、stage_status。普通日程 stage 留空，不猜招聘阶段。不用日程文字覆盖当前实际招聘阶段。
- `event.delete`：job_id + event_id，只删除本地日程。删除日程不等于撤回申请或清除线上已经发生的招聘阶段；线上有冲突交由同步流程核实。
- 共享测评保留一个 event_id；`related_job_ids` 为 JSON 字符串数组，列出主 job_id 以外的关联岗位，例如 `"[\"job_other\"]"`。只按已核实的共享规则关联同公司已有岗位，不凭同公司自动扩散。关联不得重复或悬空；写入、完成、删除均将涉及岗位加入同步队列。岗位详情与 sync-export 同时读取主关联和附加关联，首页仍只计一次。完成登记原子更新该日程及仍为 Submitted 的关联岗位摘要，不回退已结束岗位；原安排和完成凭据留存。解除关联不自动删除线上历史阶段。
- `sync.ack`：job_id + change_id + offernotes_id；线上读回验证成功后调用。失败用 error 描述原因，队列保留。同步较旧版本的回执不能清除更新后的队列。
- `table.upsert`：仅允许 automation_rules、resume_rules、blocker_queue；传 table、match（唯一定位字段对象）、record（修改字段）。多条匹配时拒绝，不按行号覆盖。

## 字段与关联

job_pool 保留公司、岗位、城市、job_url、application_date、source、status、next_action、resume_variant、role_family、match_grade（S/A/B/C 展示等级）、match_estimate（证据匹配度区间，非录用率）、deadline、application_limit（原多岗位额度说明）、preference_order（只有明确证据才填）、notes、job_description、research_file、matching_file、cohort_match_status、offernotes_id。新研究岗位登记时优先从已验证 pipeline 的 human-summary.json 复制 match_grade/match_estimate；这两个展示字段不替代 readiness 登记许可。

原 Excel 全部15列精确保存在 legacy_record JSON 字段，legacy_row 用于迁移核对，不再作为更新定位依据。原状态空白不推断为待投；原日期未明确发现日期，不冒充 date_found。志愿顺序原先在备注内，继续完整保留；不凭备注顺序猜结构化 preference_order。

application_log.log_id、follow_up.event_id 固定；两表都以 job_id 关联岗位，不能仅按公司取最新一条。完整 JD 可以后续从已落盘官方资料补齐，历史迁移缺失时留空，不伪造。

岗位以 job_id 区分，不再强制“公司＋岗位名”唯一；同名岗位可能属于不同官方编号、部门或批次。snapshot、validate、preview、apply 的 warnings 和看板会提示同公司同名候选，登记前核实官方证据并保留在研究材料或备注中，不因城市或链接不同就拆成多个申请。不自动合并记录、日志或日程。重复 job_id 或多个本地岗位绑定同一非空 offernotes_id 仍拒绝写入。

| status | 意义 |
|---|---|
| Pending | 已选定待投 |
| Deferred | 明确延后（例如等B版） |
| Needs user | 状态未知/待确认 |
| Blocked | 操作卡点 |
| Submitted | 确认已提交，仍在招聘流程中 |
| Ended | 流程结束，但结果未明确 |
| Skipped | 放弃或排除 |
| Rejected | 明确被拒 |
| Offer | 明确获得Offer，不表示仅通过一轮面试 |

cohort_match_status 只表示官网当届开放核实情况，与本人是否延后/是否投递分开。不要根据 status 推断官网开放。

follow_up.stage：0投递、1笔试/测评、2一面、3二面、4三面、5Offer。stage_status：1待办、6完成待通知、4通过、5被拒、3放弃、2仅无后续反馈的已办。日期按该环节真实日期，时间未知不要编造。

## OfferNotes

### 网页待办与完成登记

首页按已知时间排列未完成事项，未知时间放在最后；截止时间不代表开考时间。编辑安排时选择时间口径，保存为 notes 中的 `[时间口径：准确截止|估算截止|时间未知|固定安排]` 标记（实际只写所选一项）。估算日期不得改称官方截止，邀请收到日期不得冒充截止。

“登记完成”经 `/api/calendar/complete` 调用同一事务写入逻辑，携带 expected_revision，只更新原 event_id：date/time 改为实际完成时间，status=Completed，stage_status 为 6等待结果、4本环节通过或2无需后续反馈，保留原 deadline、安排与来源，并追加凭据或本人确认说明。时间未知可留空；没有完成证据不登记完成。通过一环节不会自动记为获得 Offer。

共享测评沿用已有的一条日程，通过 related_job_ids 明确关联其他岗位，不因多个岗位重复新增，也不据同公司名称自动传播结果。单岗和共享事项登记完成时，在同一事务内更新关联的 Submitted 岗位摘要和完成凭据；已记录更后续环节时保留其摘要，普通提醒不推断招聘阶段，已结束岗位不改写。剩余待办仍保留在下一步提示中。已完成事项移入历史，业务变更进入同步队列。凭据支持文字及本地文件路径，不上传附件。

线上同步先核对阶段冲突：本次拟写入的拒绝、放弃或 Offer 结果，以及线上已有的阶段通过／拒绝／放弃结果，不被同阶段旧待办或等待结果事件覆盖。相互矛盾的明确结果、或终局结果之后仍有更后续阶段的情况，报告错误并保留待处理；对已有线上记录，冲突检查在写入详情和阶段之前完成。

同步备注使用带 job_id 与内容校验值的 `[CareerWorkbench:v1:…]` 管理区，本地 notes、简历版本、匹配信息和完整链接只替换该区，不再反复追加整段。管理区外的旧历史和人工备注逐字保留；旧备注恰好等于本次本地内容时可直接纳入管理区，否则首次保留原文。已存在的历史重复不自动清理。若人工修改管理区内容或破坏标记，停止该条同步并核实，不能覆盖人工修改；人工新增信息写在管理区外。本地历次版本仍由事务备份留存。

关联优先使用 offernotes_id，其次使用线上管理区的 job_id；标记与已有绑定不符时拒绝写入。仅未标记、未被其他本地岗位绑定的旧记录可按公司／岗位名和官方链接辅助匹配。遇到同名本地岗位，旧记录须明确核实并填写各自 offernotes_id 后同步。新记录创建时同时写入 job_id 标记，响应丢失后的重试可重新定位。sync-export 附带全量 identity_index（包含已同步岗位），分批时只切分 entries，保留完整索引，避免把未在本批中的岗位误认成当前岗位。

每次岗位、日志或日程变化都会原子写入 sync_queue，默认 state=pending。队列不是“同步成功”的证明：按 offernotes-sync 查询本人线上记录、合并已有阶段、写后验证，然后确认 change_id。浏览器登录不可用时保留 error/pending，向用户说明；不保存认证 token 到文件。没有创建订阅或后台无人值守任务。

若 OfferNotes 的 PATCH 返回空或非 JSON 的 2xx 响应，适配器只追加一次 GET 读回：全部请求字段逐字相同才接受；不相同则保留同步错误，不重复不确定写入。2026-10-03 实测四条超过 2,000 字的详情返回空响应且未保存，其他详情正常。处理时去除网页导航、公司介绍、其他职位推荐，逐条校对全部要求和分类依据引文仍在岗位正文中，再按主表事务更新展示正文并重新同步；完整原始快照及匹配输入仍保留。禁止为了绕过长度问题静默截断职责或要求。真正超过服务容量的完整 JD 须显式说明线上展示范围，不能把线上摘要作为完整匹配输入。

网页变更立即保存本地并显示待同步数；在线同步由有登录态的 AI 会话执行，不能承诺网页独立操作会立即改 OfferNotes。以后询问投递进度或继续投递时先处理待同步项。

导出队列：`node dashboard/tracker-cli.js sync-export <绝对路径payload.json>`。**同步通道跟随本次投递通道（2026-09-22 本人要求）**：投递走①插件或②内置浏览器时，优先在同一通道已登录的 offernotes.cn 页面内执行 `offernotes-reconcile.js` 中的函数，不另启专用 CDP 实例；该通道不可用或未登录 OfferNotes 时保留 `pending/error` 并向本人说明，确有必要才降级到③B 专用 CDP 通道。先用payload的dryRun=true预览，检查错误与可能重复的新建，再以dryRun=false分批执行。脚本与payload只在函数闭包中求值；认证在页面内部使用，不返回凭据。将完整 `{dryRun:false,results:[...]}` 保存到私有文件，执行 `node dashboard/tracker-cli.js sync-ack <绝对路径results.json>` 后读回队列。阶段链接列最多200字符，脚本会尝试解码URL中的中文以保留完整链接，仍超限时报告错误而不截断。

## 维护边界

campus-recruitment 继续负责全量目录、完整JD、matching.json校验与选岗；job-application-form-filling 负责代填；offernotes-sync 负责线上投递视图。调研占用表只管理研究认领，不是第二份申请状态表。Excel只作历史备份/按需导出，不再回写。

campus-recruitment 按任务选择四个入口：新公司全量研究、已有公司增量复核、已选岗位补档、进度维护／查询。新推荐仍须完整 JD、覆盖范围与 matching 校验；补档和状态维护不默认重抓全量目录，也不据此宣称研究缺口已补齐。所有入口的业务写入仍遵循本协议，并完成 OfferNotes 同步；具体读取范围与升级条件以该 skill 为准。

### 投递栏日期口径（2026-09-13澄清）
Pending/Deferred没有实际提交日期，OfferNotes投递阶段的stage_date为空；历史登记/同步时刻不能当作投递日期。同步会清除未投递阶段的旧日期，后续阶段有真实安排则保留。计划投递时间另作普通日程，不填进实际投递日期。已提交记录仍保留原有实际日期，未知不编造。

## 行动摘要与规则派生

`brief [--limit=8]` 复用主表原子快照和同一 revision，只返回临期、待补救、未知时间、待投冲突与队列计数。输出不等于实际投递许可，也不等于线上已同步。保留事实，任何状态变更仍经本人确认与事务协议。

私有 `data/private/policy-review.json` 是「选岗规则」段的带哈希派生检查，不是第二份事实源。段落变更后返回 stale，需人工核对并更新派生规则和哈希，不能自动把新文本套入旧条件。当前只核对 Pending 的 C 档冲突；未命中不表示其余资格、地域、岗位开放状态已经核实。

`rules` 动态返回「选岗规则」「经历与表述边界」，不缓存旧副本，不返回联系方式或完整公司历史。其他字段继续按需读取原始母表。
