# 本机配置

这里记录本机的路径、端口、浏览器 profile 和自动备份等配置，规则正文见根目录 `AGENTS.md`。配置变了只改这份文件；规则本身变了才改 `AGENTS.md`。

## 工作区布局

工作区根是 `resume/`，本机路径为 `D:/AppData/Documents/resume`。`AGENTS.md` 和各技能里的相对路径都以这里为起点。

| 内容 | 位置 |
|---|---|
| 本项目 | `resume/CareerWorkbench`（origin = YoungShip/CareerWorkbench） |
| 简历与母表仓库 | `resume/lapis-cv`（origin = YoungShip/yxp-cv，私有；2026-10-09 由 lapis-cv 改名，本机文件夹名不变） |
| 投递主数据（八份 CSV） | 私有仓库 `lapis-cv/tracker/`；工具在 `CareerWorkbench/data/private/tracker-worktree/tracker/` 读写并推送（2026-10-09 起，见 [local-tracker.md](local-tracker.md)） |
| 选岗规则、经历边界、公司去重索引 | `resume/lapis-cv/秋招/求职档案.md` |
| 个人资料（网申母表） | `resume/lapis-cv/秋招/网申档案.json` |
| 两个完整技能 | 运行位置 `resume/.agents/skills/`，版本源 `CareerWorkbench/skills/`（campus-recruitment、job-application-form-filling），两处用 `npm run skills:check` 核对 |
| 私有业务数据 | `resume/CareerWorkbench/data/private/`（不进公开仓库；证据部分每天镜像到私有 `lapis-cv/private-evidence/`） |

三份 `AGENTS.md`：`resume/AGENTS.md` 不在任何仓库内，以 `CareerWorkbench/AGENTS.md` 为同步源；`lapis-cv/AGENTS.md` 随 lapis-cv 仓库提交。

## 远程操控（RDC）

使用规则见 `AGENTS.md` 第 14 条。工作区所在的设备用 Remote Desktop Commander 的 `list_devices` 查询，选有 `D:/AppData/Documents/resume` 目录的那台。RDC 默认 shell 是 PowerShell；每次调用最多等 3 秒，长命令要反复读取输出，或者把输出重定向到文件再读。云端会话的 git 代理不允许删除远程分支（返回 403），删分支要经 RDC 在本机执行 `git push origin --delete <分支>`。本机 git 没有配置代理，直连 GitHub 不稳定（小的拉取通常能成功，大推送常常连接超时）；本机开着系统代理 `127.0.0.1:7890`，推送失败时临时加 `git -c http.proxy=http://127.0.0.1:7890 push ...`，不改全局配置。

## 浏览器通道

选用顺序与边界见 `AGENTS.md` 第 0、7、8 条。第 3 级两条通道都使用专用的非默认 Chrome profile：

| 通道 | profile | 默认调试端口 | 说明 |
|---|---|---|---|
| ③A Playwright 网申通道 | `CareerWorkbench/data/private/playwright-application/chrome-profile` | 9333 | 本机运行时锁定 `playwright-core` |

两个 profile 都可以持续保存登录会话。

## 会话摘要与自动备份

2026-10-13 本人确认取消 Windows 桌面通知；Server酱服务已由本人关闭。2026-10-20 本人授权启用本机 ClawBot Gateway 微信提醒，提醒由 Muse、Hark 和 ClawBot 协作；不配置其他外部通道。

**ClawBot Gateway**：本机运行目录为 `%LOCALAPPDATA%\ClawBotGateway\runtime`，管理端口为 `127.0.0.1:6798`，微信账号绑定和通知 Token 保存在该目录对应的本机私有数据库中。发送器为 `CareerWorkbench/scripts/send-clawbot-notification.ps1`；只发送岗位、步骤和待办，不发送手机号、验证码、密码、Cookie 或 Token。发送接口的瞬时失败自动最多重试 3 次并退避；最终失败不应阻断网申流程。

**会话摘要**：`node CareerWorkbench/dashboard/tracker-cli.js brief`，只读主表，不发送通知；失败时排查 tracker-cli，不恢复旧提醒程序。

**独立自动备份**：PowerShell 7 执行 `CareerWorkbench/scripts/register-backup.ps1`，注册一个“秋招备份”任务，包含每日 20:00 和用户登录两个触发器。静默启动器 `scripts/run-backup-silent.vbs` 只执行 `backup-tracker.js --push`，保留退出码。任务禁止并发，运行上限 30 分钟，结果见 `logs/backup.log` 和计划任务最后结果。旧的三个“秋招提醒-*”任务已退役，不再注册。

**tmp 清理**：不再自动运行（2026-10-08 停用：tmp 里有主表和调研报告引用的证据，按修改时间删除会丢证据）。需要时手动预览 `node CareerWorkbench/scripts/clean-tmp.js`，确认没有被引用的文件后才加 `--apply`。需要长期保留的东西不要放在 `tmp/`，应放进 `data/private/`。

**主表同步**：主表在私有仓库 `tracker/` 里，每次写入都会提交并推送，git 历史就是异地备份。主表只读命令先拉取；失败时返回警告，不能把缓存当成远端最新状态。推送和拉取直连失败时改走 `127.0.0.1:7890`（`JOBHUNT_GIT_PROXY` 可改，设为空则不走代理）。

**每日快照**：独立备份任务在每晚 20:00 和登录时运行 `node CareerWorkbench/scripts/backup-tracker.js --push`，把八份 CSV 原样写入 `lapis-cv/tracker-backup/`（2026-10-09 起不打码；设 `JOBHUNT_BACKUP_REDACT=1` 恢复打码和打码后复查）。同一次提交把 `data/private` 里的证据原样镜像到 `lapis-cv/private-evidence/`（不镜像 `playwright-application`、`secrets`、`models`、`agent-runs`、`eval`（旧评测数据）、`publication-*`、`backup-worktree`、`tracker-worktree`、缓存目录、超过 50 MB 或相对路径超过 150 字符的文件；`JOBHUNT_EVIDENCE_DIR` 可改源目录）。同时把只在本机的工作资料原样镜像到 `lapis-cv/local-backup/`：`discovery/`（`data/company-discovery`）、`lapis-cv-tmp/`（主表 matching_file/research_file 引用到的 `lapis-cv/tmp` 条目）、`workspace-root/`（resume 根目录的散文件，不含 . 开头的配置）。只提交这三个目录，然后推送；直连失败时自动改走 `127.0.0.1:7890` 代理（环境变量 `JOBHUNT_BACKUP_PROXY` 可改，设为空则不走代理）。提交和推送都在独立的 git worktree `CareerWorkbench/data/private/backup-worktree` 里进行（`JOBHUNT_BACKUP_WORKTREE` 可改），基于远程最新版本生成快照，不暂存、不合并、不改写本人的 lapis-cv 工作目录；本人那份 lapis-cv 要 `git pull` 才能看到新快照。推送被拒（别的会话刚推过）时取最新远程重新生成一次。结果记在 `CareerWorkbench/logs/backup.log`。手动运行不加 `--push` 只在独立工作目录里提交、不推送。
