# CareerWorkbench 迁移说明

迁移日期：2026-09-29。现行目录是 D:/AppData/Documents/resume/CareerWorkbench，仓库是 YoungShip/CareerWorkbench，迁移时仓库为私有，现已公开（简历中的项目链接指向它）。

## 当前入口

- 看板：http://localhost:8420/dashboard.html，沿用原端口。
- Windows 登录任务：CareerWorkbench Dashboard。
- 三个秋招提醒任务保留原名称、时间、通知方式和配额状态，执行路径更新到新目录。
- Claude 工作区 .mcp.json 使用 career-workbench，指向当前 mcp/server.js。新会话读取更新后的 CLAUDE.md、AGENTS.md 和三个 Skill。
- jobmatch、主表 CLI 和 discovery 的命令名称保持稳定。

## 材料与历史

8 份投递 CSV、个人简历、JD、候选证据、人工标注及原始评测结果未因更名改写。旧目录整体搬到新目录，没有新建另一套主表。

主表中少量历史材料路径仍保留原文字。Node 的 lib/artifact-paths.js 和 Python 的 resolve_artifact_path 只在旧文件不存在、路径确实位于原项目的同级目录、且新位置存在时映射到当前材料；不映射任意同名目录，不覆盖仍存在的旧文件。

冻结的 Agent 检查点仍遵守原有实现/环境/目录约束。迁移时检查到的真实检查点已完成；新任务使用当前实现和新目录，不改写旧检查点以伪装兼容。

## 来源

独立设计、重写范围、AI辅助实现与第三方复用分别见 project-origin.md 和根目录 THIRD_PARTY_NOTICES.md。旧名称在历史证据、必要许可证与迁移兼容测试中保留，不作为现行产品名称。

本机迁移前文件、任务定义与核验材料位于 resume/_archive/2026-09-29-career-workbench-migration。该目录不入项目仓库。
