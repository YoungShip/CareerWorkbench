# 本机配置

这里记录本机的路径、端口、浏览器 profile 和提醒通道等配置，规则正文见根目录 `AGENTS.md`。配置变了只改这份文件；规则本身变了才改 `AGENTS.md`。

## 工作区布局

工作区根是 `resume/`，本机路径为 `D:/AppData/Documents/resume`。`AGENTS.md` 和各技能里的相对路径都以这里为起点。

| 内容 | 位置 |
|---|---|
| 本项目 | `resume/CareerWorkbench`（origin = YoungShip/CareerWorkbench） |
| 简历与母表仓库 | `resume/lapis-cv`（origin = YoungShip/lapis-cv，私有） |
| 投递主数据（八份 CSV） | `resume/CareerWorkbench/dashboard/` |
| 选岗规则、经历边界、公司去重索引 | `resume/lapis-cv/秋招/求职档案.md` |
| 个人资料（网申母表） | `resume/lapis-cv/秋招/网申档案.json` |
| 两个完整技能 | 运行位置 `resume/.agents/skills/`，版本源 `CareerWorkbench/skills/`（campus-recruitment、job-application-form-filling），两处用 `npm run skills:check` 核对 |
| 私有业务数据 | `resume/CareerWorkbench/data/private/`（不进公开仓库；证据部分每天镜像到私有 `lapis-cv/private-evidence/`） |
| MCP 注册 | `resume/.mcp.json`，见 [mcp-server.md](mcp-server.md) |

三份 `AGENTS.md`：`resume/AGENTS.md` 不在任何仓库内，以 `CareerWorkbench/AGENTS.md` 为同步源；`lapis-cv/AGENTS.md` 随 lapis-cv 仓库提交。

## 远程操控（RDC）

使用规则见 `AGENTS.md` 第 14 条。工作区所在的设备用 Remote Desktop Commander 的 `list_devices` 查询，选有 `D:/AppData/Documents/resume` 目录的那台。RDC 默认 shell 是 PowerShell；每次调用最多等 3 秒，长命令要反复读取输出，或者把输出重定向到文件再读。云端会话的 git 代理不允许删除远程分支（返回 403），删分支要经 RDC 在本机执行 `git push origin --delete <分支>`。本机 git 没有配置代理，直连 GitHub 不稳定（小的拉取通常能成功，大推送常常连接超时）；本机开着系统代理 `127.0.0.1:7890`，推送失败时临时加 `git -c http.proxy=http://127.0.0.1:7890 push ...`，不改全局配置。

## 浏览器通道

选用顺序与边界见 `AGENTS.md` 第 0、7、8 条。第 3 级两条通道都使用专用的非默认 Chrome profile：

| 通道 | profile | 默认调试端口 | 说明 |
|---|---|---|---|
| ③A Playwright 网申通道 | `CareerWorkbench/data/private/playwright-application/chrome-profile` | 9333 | 本机运行时锁定 `playwright-core` |

两个 profile 都可以持续保存登录会话。

## 到期提醒

规则见 `AGENTS.md` 第 9 条，这里是三重提醒的具体配置。

**① 会话自动检查**：`node CareerWorkbench/dashboard/tracker-cli.js brief`；失败时退回 `node CareerWorkbench/scripts/remind.js --json`。

**② 桌面通知**：`CareerWorkbench/scripts/register-reminders.ps1` 注册了 3 个 Windows 计划任务：
- 每晚 20:00 汇总；
- 每小时门槛检查：跨过 24h、2h 门槛或刚过期时各提醒一次，同一门槛不重复；
- 登录时检查。

脚本只读 `follow_up.csv` 的日程，以及 `job_pool.csv` 里待投、暂缓、受阻岗位 `deadline` 字段开头的日期（当作“网申截止”事项，同日已有日程的不重复），不写主表。门槛去重状态在 `CareerWorkbench/tmp/remind-state.json`。

**③ 微信推送（Server酱）**：
- 凭据在 `CareerWorkbench/data/private/secrets/serverchan.json`，说明见同目录 `README.md`。
- 免费版每天上限 5 条，超出时返回 `code=40001`。本地每天最多发 5 条，以保护预算；实际限制以服务端响应为准。
- 各档上限：紧急（2h 内）5 条，重要（24h 内）4 条，补救（已过期但有 next_action）4 条，例行（汇总、登录检查）3 条。同一档的多个事项合并成一条。
- 发送互斥串行，服务端确认成功才记账。dry-run 不发送、不记已提醒、不读密钥。
- Server酱是国内服务，先直连；连接都没建立（如本机代理没开导致 `ECONNREFUSED`）时才按环境代理重试一次，成功时日志注明“经代理”。
- 另有内容去重、服务端 40001 兜底和跳过记录，用 `node CareerWorkbench/scripts/remind.js --quota` 查看。

运行记录在 `CareerWorkbench/logs/remind.log`，只记结果和计数，不记凭据；出错和“另一次提醒正在发送”也记在这里。最近一次运行、最近一次微信推送成功和最近一次错误另存 `logs/reminder-health.json`，行动摘要的 `reminder_health` 读取它，超过 24 小时没有推送成功会在 `next_steps` 提示。

只有日期、没写具体时间的截止按当天 23:59 计算；截止当天 09:00 起另发一次“今天截止”提醒（代替 24 小时提醒），因为很多网站中午或 17:00 就关闭。

**tmp 清理**：不再自动运行（2026-10-08 停用：tmp 里有主表和调研报告引用的证据，按修改时间删除会丢证据）。需要时手动预览 `node CareerWorkbench/scripts/clean-tmp.js`，确认没有被引用的文件后才加 `--apply`。需要长期保留的东西不要放在 `tmp/`，应放进 `data/private/`。

**主表异地备份**：每晚汇总和登录检查会在后台运行 `node CareerWorkbench/scripts/backup-tracker.js --push`，把八份 CSV 原样写入 `lapis-cv/tracker-backup/`（2026-10-09 起不打码；设 `JOBHUNT_BACKUP_REDACT=1` 恢复打码和打码后复查）。同一次提交把 `data/private` 里的证据原样镜像到 `lapis-cv/private-evidence/`（不镜像 `playwright-application`、`secrets`、`models`、`agent-runs`、`eval`、`publication-*`、`backup-worktree`、缓存目录、超过 50 MB 或相对路径超过 150 字符的文件；`JOBHUNT_EVIDENCE_DIR` 可改源目录）。同时把只在本机的工作资料原样镜像到 `lapis-cv/local-backup/`：`discovery/`（`data/company-discovery`）、`lapis-cv-tmp/`（主表 matching_file/research_file 引用到的 `lapis-cv/tmp` 条目）、`workspace-root/`（resume 根目录的散文件，不含 . 开头的配置）。只提交这三个目录，然后推送；直连失败时自动改走 `127.0.0.1:7890` 代理（环境变量 `JOBHUNT_BACKUP_PROXY` 可改，设为空则不走代理）。提交和推送都在独立的 git worktree `CareerWorkbench/data/private/backup-worktree` 里进行（`JOBHUNT_BACKUP_WORKTREE` 可改），基于远程最新版本生成快照，不暂存、不合并、不改写本人的 lapis-cv 工作目录；本人那份 lapis-cv 要 `git pull` 才能看到新快照。推送被拒（别的会话刚推过）时取最新远程重新生成一次。结果记在 `CareerWorkbench/logs/backup.log`。手动运行不加 `--push` 只在独立工作目录里提交、不推送。

## 客户端接入

各 AI 客户端的接入和夜间运行说明：[trae-night-run.md](trae-night-run.md)、[zcode-night-run.md](zcode-night-run.md)、[skill-maintenance.md](skill-maintenance.md)。
