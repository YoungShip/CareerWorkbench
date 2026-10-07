# 本机配置

这里记录本机的路径、端口、浏览器 profile 和提醒通道等配置，规则正文见根目录 `AGENTS.md`。配置变了只改这份文件；规则本身变了才改 `AGENTS.md`。

## 工作区布局

工作区根是 `resume/`，本机路径为 `D:/AppData/Documents/resume`。`AGENTS.md` 和各技能里的相对路径都以这里为起点。

| 内容 | 位置 |
|---|---|
| 本项目 | `resume/CareerWorkbench`（origin = YoungShip/CareerWorkbench） |
| 简历与母表仓库 | `resume/lapis-cv`（origin = xiepeng-yang_nioer/lapis-cv） |
| 投递主数据（八份 CSV） | `resume/CareerWorkbench/dashboard/` |
| 选岗规则、经历边界、公司去重索引 | `resume/lapis-cv/秋招/求职档案.md` |
| 个人资料（网申母表） | `resume/lapis-cv/秋招/网申档案.json` |
| 三个完整技能 | `resume/.agents/skills/`（campus-recruitment、job-application-form-filling、offernotes-sync） |
| 私有业务数据（不入库） | `resume/CareerWorkbench/data/private/` |
| MCP 注册 | `resume/.mcp.json`，见 [mcp-server.md](mcp-server.md) |

三份 `AGENTS.md`：`resume/AGENTS.md` 不在任何仓库内，以 `CareerWorkbench/AGENTS.md` 为同步源；`lapis-cv/AGENTS.md` 随 lapis-cv 仓库提交。

## 远程操控（RDC）

使用规则见 `AGENTS.md` 第 14 条。本机工作区所在的设备是 `DESKTOP-BHF0SGG`，设备 ID 用 Remote Desktop Commander 的 `list_devices` 查询。账号下另一台设备 `DESKTOP-O8OB0VG` 上没有工作区。RDC 默认 shell 是 PowerShell；每次调用最多等 3 秒，长命令要反复读取输出，或者把输出重定向到文件再读。

## 浏览器通道

选用顺序与边界见 `AGENTS.md` 第 0、7、8 条。第 3 级两条通道都使用专用的非默认 Chrome profile：

| 通道 | profile | 默认调试端口 | 说明 |
|---|---|---|---|
| ③A Playwright 网申通道 | `CareerWorkbench/data/private/playwright-application/chrome-profile` | 9333 | 本机运行时锁定 `playwright-core` |
| ③B Raw CDP 同步通道 | `CareerWorkbench/data/private/offernotes-cdp/chrome-profile` | 9222 | 只用于 OfferNotes 兜底、API 级精确操作和只读诊断 |

两个 profile 都可以持续保存登录会话。

## 到期提醒

规则见 `AGENTS.md` 第 9 条，这里是三重提醒的具体配置。

**① 会话自动检查**：`node CareerWorkbench/dashboard/tracker-cli.js brief`；失败时退回 `node CareerWorkbench/scripts/remind.js --json`。

**② 桌面通知**：`CareerWorkbench/scripts/register-reminders.ps1` 注册了 3 个 Windows 计划任务：
- 每晚 20:00 汇总；
- 每小时门槛检查：跨过 24h、2h 门槛或刚过期时各提醒一次，同一门槛不重复；
- 登录时检查。

脚本只读 `follow_up.csv`，不写主表。门槛去重状态在 `CareerWorkbench/tmp/remind-state.json`。

**③ 微信推送（Server酱）**：
- 凭据在 `CareerWorkbench/data/private/secrets/serverchan.json`，说明见同目录 `README.md`。
- 免费版每天上限 5 条，超出时返回 `code=40001`。本地每天最多发 5 条，以保护预算；实际限制以服务端响应为准。
- 各档上限：紧急（2h 内）5 条，重要（24h 内）4 条，补救（已过期但有 next_action）4 条，例行（汇总、登录检查）3 条。同一档的多个事项合并成一条。
- 发送互斥串行，服务端确认成功才记账。dry-run 不发送、不记已提醒、不读密钥。
- 另有内容去重、服务端 40001 兜底和跳过记录，用 `node CareerWorkbench/scripts/remind.js --quota` 查看。

运行记录在 `CareerWorkbench/logs/remind.log`，只记结果和计数，不记凭据。

**tmp 清理**：每晚汇总和登录检查（`remind.js --all`）会顺带删除 `CareerWorkbench/tmp` 里超过 14 天的文件，提醒的三个状态文件不删，删除数量记在 `remind.log`。手动预览用 `node CareerWorkbench/scripts/clean-tmp.js`，加 `--apply` 才实际删除。需要长期保留的东西不要放在 `tmp/`，应放进 `data/private/`。

## 客户端接入

各 AI 客户端的接入和夜间运行说明：[trae-night-run.md](trae-night-run.md)、[zcode-night-run.md](zcode-night-run.md)、[skill-maintenance.md](skill-maintenance.md)。
