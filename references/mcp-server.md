# MCP Server

`mcp/server.js` 把本机主表与 discovery 暴露为 MCP 工具（stdio），供 Claude Code、Codex 等支持 MCP 的客户端直接调用。它与 `tracker-cli.js` 共用 `lib/tracker-service.js` 和 `dashboard/store.js`，**不是第二套业务逻辑**：事务、校验、登记许可与同步队列规则全部沿用 [主表协议](local-tracker.md)。CLI 仍是规则与 Skill 的正式入口，MCP 是等价的可选入口。

## 安装与接入

```powershell
cd D:/AppData/Documents/resume/CareerWorkbench
npm install          # 安装 @modelcontextprotocol/sdk 与 zod
npm test             # 含 mcp/server.test.js
```

Claude Code 通过工作区根目录 `D:/AppData/Documents/resume/.mcp.json` 注册（项目级，首次使用时客户端会请本人批准）。其他客户端按各自配置指向 `node D:/AppData/Documents/resume/CareerWorkbench/mcp/server.js`。数据目录沿用 CLI 的环境变量：`JOBHUNT_DATA_DIR`、`JOBHUNT_DISCOVERY_DIR`。

## 工具

| 工具 | 类型 | 对应 CLI |
|---|---|---|
| `tracker_brief` | 只读 | `tracker-cli brief` |
| `tracker_rules` | 只读 | `tracker-cli rules` |
| `tracker_query` | 只读 | `tracker-cli query` |
| `tracker_validate` | 只读 | `tracker-cli validate` |
| `discovery_next` | 只读 | `discovery/cli.js next` |
| `discovery_query` | 只读 | `discovery/cli.js query` |
| `tracker_preview` | 只读（预览） | `tracker-cli preview` |
| `tracker_apply` | 写入 | `tracker-cli apply` |

只读工具标注 `readOnlyHint`，`tracker_apply` 标注 `destructiveHint`，客户端据此决定是否弹窗请本人确认。

**刻意不暴露**：
- 全量 `snapshot`（约 1 MB，会挤占模型上下文）→ 用 `tracker_query` 过滤投影，或 `tracker_validate` 做轻量审计；apply 前的完整审计仍走 CLI。
- `sync-export` / `sync-ack` 与计划中的 `sync.ack`：回执必须来自 OfferNotes 写后读回，走 offernotes-sync。
- `job.delete` 与 `initialize`：须本人明确要求，走 CLI。

## 写入护栏：预览令牌

CLI 约定是 `preview → apply → 读回`，但约定只靠提示词维持，模型可以跳过预览。MCP 把它下沉为工具层强制：

1. `tracker_preview` 对计划做与 apply 相同的完整校验（不落盘），返回 `preview_token = 签发时间 + HMAC-SHA256(进程密钥, 签发时间 + 规范化计划)`。
2. `tracker_apply` 必须带回**同一份计划**和令牌。计划按键排序规范化后比对，字段顺序不同不影响，内容任何改动都会拒绝。
3. 令牌 10 分钟过期；密钥每次启动随机生成，重启后旧令牌全部失效。
4. 计划内含 `expected_revision`，所以令牌间接绑定了预览时的主表版本；预览后若有其他写入，store 的乐观锁会返回 `Revision conflict`，需重新读取、重新预览。同一令牌重放也会因此被拒。
5. apply 成功后自动按 `changed_jobs` 定向读回本次改动字段，并提示改动已进入 `sync_queue`（pending），不代表线上已同步。

计划根对象为严格模式，`runtime` 等额外字段直接拒绝（store 本身也拒绝计划携带 runtime）。

## 边界

- MCP 不改变任何业务授权：新研究岗位登记仍须本人选定并通过 matching 校验；由未投变 Submitted 仍须真实投递证据。
- stdout 只承载 JSON-RPC；诊断写 stderr。服务只在本机经 stdio 运行，不监听端口。
