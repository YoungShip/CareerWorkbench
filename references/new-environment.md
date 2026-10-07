# 新环境与新 AI 工具接入

给第一次接手这套秋招工作流的 AI 工具或新电脑看。先读根目录 `AGENTS.md`，再按这里搭环境。

## 仓库与目录

三个仓库都在 YoungShip 账号下，克隆到同一个工作区根目录 `resume/` 里：

| 仓库 | 可见性 | 放在 | 内容 |
|---|---|---|---|
| `YoungShip/CareerWorkbench` | 公开 | `resume/CareerWorkbench` | 工作流代码、规则、三个技能的版本源 `skills/` |
| `YoungShip/lapis-cv` | 私有 | `resume/lapis-cv` | 简历、网申母表、求职档案、公司调研、主表每日备份 `tracker-backup/` |
| `YoungShip/job-application-workflow-skills` | 公开 | 不需要克隆 | 技能的独立发布版 |

```sh
mkdir resume && cd resume
git clone https://github.com/YoungShip/CareerWorkbench.git
git clone https://github.com/YoungShip/lapis-cv.git
cp CareerWorkbench/AGENTS.md AGENTS.md          # 工作区根的规则副本
cd CareerWorkbench
npm ci
npm run skills:install                          # 把 skills/ 装到 resume/.agents/skills
cd agent && uv sync --frozen && cd ..
npm test                                        # 应全部通过
```

`.agents/skills` 是各 AI 客户端加载技能的位置；仓库里的 `skills/` 是版本源，两处用 `npm run skills:check` 核对。

## 恢复投递主表

主表（`CareerWorkbench/dashboard/` 下八份 CSV）只在作者电脑上维护，不进 CareerWorkbench。新环境需要时从 lapis-cv 的每日备份恢复：

```sh
cp ../lapis-cv/tracker-backup/*.csv dashboard/
node dashboard/tracker-cli.js validate
node dashboard/tracker-cli.js brief
```

备份里测评专属链接的参数、测评账号和身份证号已打码（显示为 `REDACTED`），需要时从原始邮件取回。作者电脑上的主表仍是唯一主数据：两边同时写入会产生分叉，新环境只用于查看或在作者电脑不可用时接替。

## 在不同环境能做什么

| 事情 | 只连 GitHub 的云端 AI | 作者电脑（或经 RDC 操作作者电脑） |
|---|---|---|
| 读规则、选岗规则、母表、简历、历史调研 | 能 | 能 |
| 公司调研、逐岗匹配、改简历措辞、改代码 | 能 | 能 |
| 查看投递进度 | 能，读 `tracker-backup/`（最多晚一天） | 能，读实时主表 |
| 写入主表（登记投递、更新阶段） | 不建议，会和作者电脑分叉 | 能 |
| 网申填写与提交、OfferNotes 同步 | 不能：登录态在作者电脑的专用浏览器 profile 里 | 能，按 AGENTS.md 第 0、7、8 条 |
| 到期提醒、主表备份、tmp 清理 | 不能：依赖 Windows 计划任务 | 自动运行 |

云端会话通过 Remote Desktop Commander 操作作者电脑的规则见 AGENTS.md 第 14 条，本机路径、端口和设备见 [local-setup.md](local-setup.md)。
