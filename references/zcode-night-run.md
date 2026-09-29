# ZCode 接入与夜间研究

2026-09-13：用户确认技能已经接入；本地预检已通过，三个项目技能 Junction 均指向 `.agents/skills` 原件。搜索、动态网页、完整研究和自动续跑仍须在 ZCode 实测，不能把本地预检当作运行验收。

本次准备检查见 [本地准备记录](../data/private/zcode-runs/setup-20260913/readiness.md)。首次使用先执行本文“首次验收”提示词，返回 acceptance.md 后再决定是否启动首晚。

## 环境与权威来源

在 ZCode 打开整个 D:/AppData/Documents/resume，刷新三个项目技能。resume/.zcode/skills 下同名目录为 Junction，直接使用 resume/.agents/skills 的原件；用户级三个求职技能入口已移除。其他用户技能不变。客户端刷新是否加载成功仍需实际确认，不重新导入独立副本。

先读工作区 AGENTS.md。发现和完整研究按 [公司发现协议](company-discovery.md) 及 campus-recruitment 执行。三个执行器共用真实目录，不能同时认领或维护同一研究；不另建 worktree 或复制个人主表。检查 active_run_id 和认领归属，不清除别的会话。

只读预检命令：

```text
node D:/AppData/Documents/resume/CareerWorkbench/scripts/zcode-preflight.js
```

检查技能、档案、Python、主表校验和发现快照。Python 默认位于本机 Codex runtime 缓存，可用 JOBHUNT_PYTHON 指定已安装 Python；无需启动 Codex。预检不证明 ZCode 的搜索、浏览器和自动续跑可用。实际 shell 以会话为准，不把 PowerShell 语法直接发送到 CMD/Git Bash。

工具选择、有效结果判定、经验复用和失败切换统一读取 [通用数据获取规则](../../.agents/skills/campus-recruitment/references/data-acquisition.md)，本入口不规定 ZCode 专属研究方法。先验证当前会话的搜索、官方网页和动态目录读取。OfferNotes 的页面脚本执行能力须在同步任务中单独验收，不能推断 Browser Use 一定支持；研究不制造同步变更。

## 单公司验收

用户发送下方单公司提示词后才开始。预检通过后，实际搜索一次、打开一个官方页面并读取动态目录，记录工具名、URL、时间和结果。缺少工具则保存阻塞，不宣称通过。

读最新档案、优先池、认领和两个 CLI snapshot。选择一家未研究且未占用公司，完整完成认领、官方全量目录、范围内所有 JD、matching、verify、报告、索引及 research.complete。不要重复中兴等已完成研究凑验收。按发现协议每个来源/公司保存断点，结束 run.finish、run-export。

产物保存到 CareerWorkbench/data/private/zcode-runs/<唯一验收ID>/acceptance.md，附预检、实际技能路径、工具证据、run_id、研究文件、校验计数、主表是否变化和剩余阻塞。实际工具检查和完整研究全部通过才写单公司验收通过。此次结束后不自动进入夜间任务。

## 首晚：用户另行启动

先核对本机 ZCode 单公司验收证据。每晚最多尝试三家公司，受阻也占一次；每个 discovery run 最多研究一家。保存本夜 night-session.json，包含 started_at、stop_at（启动后的下一个 Asia/Shanghai 07:00，带 +08:00）、max_attempts:3、attempts、run_ids、status。清单位于同一个 data/private/zcode-runs/<本夜ID>/；恢复使用原清单，不重置次数或时间。公司状态仍只由 discovery CLI 维护。

开始每家公司前先记录尝试，在每个来源操作间检查时间。到三家上限、07:00、额度不足、全局工具故障或需人工登录时，保存断点和 morning-report.md 后结束目标；这属于按边界收尾，不能把未完成研究写成成功。07:00 是会话检查边界，不能强制打断挂起工具。单个来源失败两次换入口，公司受阻就保存证据并转下一家；无合适公司时记录搜索范围后收尾，不能无限空转。

每家完成更新晨报，列出尝试/完成/受阻数量、推荐及额度限制、证据路径、待核事项。只有通过原 verify 和 research.complete 才记完成。未经用户选定不登记待投，不填表、上传、提交、发送消息或创建订阅。本入口不自动创建定时任务。

使用 /goal 自动续轮；把“达到预算或阻塞后保存汇总并结束”作为目标验收的一部分，避免为凑三家成功无限继续。电脑保持开机、联网、不休眠，ZCode 保持运行。应用退出或用量耗尽仍可能停止；恢复后先核对原清单和运行归属。不要承诺整夜稳定或硬性计费封顶。

## 可复制的启动提示词

首次验收：

```text
读取 D:/AppData/Documents/resume/AGENTS.md 和 D:/AppData/Documents/resume/CareerWorkbench/references/zcode-night-run.md，执行“单公司验收”。先运行预检和真实工具检查，通过后选择一家未研究且未占用公司完整研究、校验、保存回执。只做一家；遇到必需工具阻塞则记录后停止。不要启动夜间任务。最后给我 acceptance.md 路径和实际通过/未通过项。
```

验收通过后，睡前在 ZCode 输入（不在计划模式）：

```text
/goal 按 D:/AppData/Documents/resume/CareerWorkbench/references/zcode-night-run.md 执行首晚研究。先核实 ZCode 单公司验收已通过并建立本夜清单；最多尝试三家公司，最晚下一个北京时间07:00收尾。共用原技能和 CareerWorkbench，通过原校验才记研究完成。每家公司保存断点和晨报；达到时间/次数边界、需登录或额度/全局工具受阻时，保存实际结果并结束目标即满足本轮收尾条件，不继续凑成功数。不登记待投、不网申、不上传、不提交、不对外发消息。
```

## 官方依据与验证边界

- 技能路径、刷新和导入：https://zcode.z.ai/cn/docs/skill
- 本地命令与浏览器：https://zcode.z.ai/cn/docs/agents
- Goal 持续推进、暂停和用量上限：https://zcode.z.ai/cn/docs/goal

以上文档于2026-09-13核对；本机客户端版本、工具权限和实际续跑需在 ZCode 验收。
