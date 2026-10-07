---
name: offernotes-sync
description: 将本地投递主表的已核实变更安全同步到 OfferNotes 或类似在线进度视图，并处理身份匹配、阶段合并、写后读回和失败队列。用户要求同步投递表、查看进度或处理 sync queue 时使用。
metadata:
  short-description: 本地投递主表到在线进度视图同步
---

# Online progress synchronization

负责“已核实本地变更 → 在线进度视图”的同步，不负责公司研究、网申填写或最终投递提交。在线视图是派生视图；本地主表和真实提交证据是权威来源。

## Hard boundaries

1. 同步前必须读取最新本地 snapshot、验证 revision 和待同步队列；没有队列不重复写入。
2. 不把导出成功、dry-run 成功、浏览器启动或 HTTP 200 当作线上同步成功。
3. 每条写入必须按岗位 ID/线上 ID 核对本人归属，写后读回详情和阶段，再确认 `change_id`/revision。
4. 管理区外的人工备注逐字保留；管理区被人工修改、标记损坏或出现同名歧义时停止该条，不强行覆盖。
5. 不猜单位性质、城市、招聘阶段、日期或结果；未知值保持未知。
6. 本 Skill 不提交网申、不发送消息、不创建订阅；删除线上记录只在用户明确要求且完成归属校验时执行。
7. 认证只在已登录页面内部使用，不打印、复制或持久化 token、cookie、localStorage 或完整浏览器会话。

## Channel selection

按当前运行时实际可用能力选择，并**与本次投递通道保持一致**：

1. 用户日常浏览器的已授权插件连接；
2. 已登录的内置/会话浏览器；
3. 专用非默认 profile 的 CDP，仅当 1/2 无法完成同步时兜底，并用于只读诊断。

**同步通道跟随投递通道**：本次投递走①插件或②内置浏览器时，同步优先走同一通道——该通道已登录 offernotes.cn 就直接在页面内用页面内认证完成 reconcile，不另启专用 CDP 实例；该通道不可用或未登录 OfferNotes 时保留 `pending/error` 并向用户说明，确有必要才降级到第 3 级。投递走③A Playwright 时，同步按①→②→③ 选择。

不要因为一次 tab inventory 为空就推断没有登录态，必须打开/读取当前页面实际核验。第 3 级不能用于网申填写或提交，也不能对用户真实浏览器默认 profile 启用 remote debugging。连接失败时保留 `pending/error`。

## Synchronization workflow

1. **Snapshot**：读取本地岗位、日志、日程、队列和当前 revision；确认本轮范围。
2. **Export**：生成本批 payload。分批时只切分 entries，保留完整 identity index，避免同名岗位错配。
3. **Dry-run**：在已登录页面内预览 action、重复候选、阶段冲突和字段差异。
4. **Execute**：无 error 后执行创建/更新；新记录使用已验证的私有可见配置，不猜平台默认值。
5. **Read-back**：逐条读取线上详情、管理区全文和全部相关阶段；确认写入字段、归属和保留内容。
6. **Ack**：将成功条目的当前 `change_id`/revision 写回本地队列；失败条目保留 error。
7. **Final snapshot**：再次读取队列，报告成功、剩余 pending/error 和具体原因。

推荐的适配器命令形状：

```text
tracker snapshot
tracker validate
tracker sync-export <payload.json>
online-reconcile <payload.json> --dry-run
online-reconcile <payload.json> --execute
tracker sync-ack <results.json>
tracker snapshot
```

## Identity and field mapping

优先级：固定线上记录 ID → 管理区中的稳定 `job_id` → 未绑定旧记录的公司/岗位/官方链接辅助匹配。公司名不是唯一键；同名岗位必须分别核实。不同本地岗位不得共用一个非空线上 ID。

典型映射：

```text
job_id / online_record_id       → online record identity
company                         → company
job_title                       → department or role
location                        → city
job_description                 → job_description
notes, resume, match, job_url   → managed note block
follow_up.stage/status/date     → progress stages
job_url                         → application-stage todo link
```

详情字段为空时保留线上已有内容，不用 URL 代替 JD；城市和阶段日期只依据本地真实证据。

## Notes and stages

管理区使用带岗位 ID 和内容校验值的版本标记，例如 `[Workflow:v1:<job_id>:<hash>] ... [/Workflow:v1]`。同步只替换自己的管理区，保留外部历史与人工备注。完整读取备注后再判断管理区是否存在，不能使用截断摘要。

阶段编号和状态应由适配器配置；常见约定是 `0 application, 1 assessment, 2 first interview, 3 second interview, 4 later interview, 5 offer`。待办、已完成待结果、通过、拒绝、放弃和无需后续反馈必须区分。某轮通过不等于获得 Offer；普通提醒不自动创建招聘阶段。

若目标服务采用数字阶段状态，可按事实映射而不是按本地文字猜测：

| 已核实事实 | 常见线上状态 |
|---|---|
| 已选定待投或收到安排但尚未完成 | 待办 |
| 投递/测评/面试已完成，等待结果 | 待通知 |
| 明确通过本环节 | 通过 |
| 明确被拒 | 被拒 |
| 本人明确放弃 | 放弃 |
| 已完成且无需后续反馈 | 已办 |

服务若使用不同编码，保留其官方/适配器映射；不要把“已提交”直接改写成“已通过”。

## Failure and closeout

- 登录失效或浏览器不可用：停止写入并保留 pending/error；
- 线上已存在明确结果：先做冲突检查，不被旧待办覆盖；
- 备注超限或服务端空响应：重新读回；不自动截断、不把 200 当成功；
- 部分写入失败：先读线上现状，再针对失败条目重试；
- revision 已变化：重新 snapshot，旧 ack 不得清除新变更；
- 结束时明确本地保存、线上读回、队列剩余和未处理原因。

## References

- 可复用故障和安全经验：[sync-knowledge.md](references/sync-knowledge.md)
- 适配器输入输出：[online-adapter.md](references/online-adapter.md)
