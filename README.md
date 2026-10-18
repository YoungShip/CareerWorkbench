# CareerWorkbench · 求职工作台

[![test](https://github.com/YoungShip/CareerWorkbench/actions/workflows/test.yml/badge.svg)](https://github.com/YoungShip/CareerWorkbench/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

个人秋招用的本地工作台：公司研究与选岗、网申填写、投递主表和看板放在同一套流程里。

需求、范围和使用验证由使用者负责；Skill 文本、Agent 架构和代码主要由 AI 生成或辅助改造，不等同于使用者独立的 Agent/RAG 研发能力。第三方与历史组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 组成

| 模块 | 职责 |
|---|---|
| `dashboard/` | 投递主表 CLI（`tracker-cli.js`）、事务存储、本地看板、截止提醒 |
| `discovery/` | 公司线索、研究状态与恢复断点 |
| `agent/` | `jobmatch`：研究时的逐项证据匹配，以及简历资料一致性检查 `check-materials`，见 [agent/README.md](agent/README.md) |
| `skills/` | 两个 Skill 的版本源：campus-recruitment（研究与选岗）、job-application-form-filling（网申填写） |
| `scripts/` | 每日备份、技能同步、站点经验状态、公开仓库安全检查 |
| `references/` | 主表协议、填报手册、资料一致性、本机配置等现行说明 |
| `templates/` | 由现行字段定义生成的空白主表模板 |

## 日常使用

在 resume 工作区打开 AI 会话，直接提研究公司、比较岗位、准备网申或更新进度的需求。规则在 [AGENTS.md](AGENTS.md)。

会话只读入口：

    node dashboard/tracker-cli.js brief
    node dashboard/tracker-cli.js rules
    node dashboard/tracker-cli.js query
    node discovery/cli.js next

投递主数据是私有仓库 yxp-cv `tracker/` 下的八份 CSV。只通过 tracker-cli 或看板按 `snapshot → preview → apply → read-back` 写入，不直接改 CSV，见 [主表协议](references/local-tracker.md)。

本地看板：http://localhost:8420/dashboard.html （只监听 127.0.0.1）。登录自启任务为 CareerWorkbench Dashboard；手动打开 `dashboard/start-dashboard-silent.bat`，查看状态 `node dashboard/serve.js status`，停止 `node dashboard/serve.js stop`。

简历或项目改动后：同步母表 → 运行资料生成器 → 在 `agent/` 执行 `uv run --frozen jobmatch check-materials`，见 [资料一致性](references/materials-consistency.md)。

## 测试

需要 Node.js 20+、Python 3.12 和 [uv](https://docs.astral.sh/uv/)。在仓库根目录：

```sh
npm ci
npm test            # pretest 会把 skills/ 复制到 ../.agents/skills（已有校验器时不改动）
cd agent && uv sync --frozen && uv run --frozen python -X utf8 -m pytest -q
```

校验器使用的 Python 依次取 `JOBHUNT_PYTHON`、作者本机的 Codex 运行时（存在时）、PATH 上的 `python3`（Windows 为 `python`）。CI 同时运行 Node、Agent 和技能脚本测试，以及公开仓库安全检查。

## 数据边界

个人资料、凭据、模型缓存、浏览器配置和真实运行数据都在被忽略的 `data/private` 等目录，不进入本仓库。主表每次写入在私有仓库提交推送，另有每日快照备份，见 [本机配置](references/local-setup.md)。

## 许可

MIT，见 LICENSE；历史声明、第三方依赖与校验器来源见 THIRD_PARTY_NOTICES.md。
