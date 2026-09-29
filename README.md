# CareerWorkbench · 求职工作台

把公司研究、岗位选择、申请准备和进度管理放进同一套可核验的工作流。

本项目源于使用者自行设计的三个 Skill。使用者主导目标、规则、架构与验收，代码由 AI 辅助实现。项目形成过程和各部分归属见 [项目来源](references/project-origin.md)，第三方及历史组件说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 日常使用

在 resume 工作区打开助手会话，直接提出研究公司、比较岗位、准备网申、更新进度或同步记录的需求。三个 Skill 分别负责公司研究、表单填写和 OfferNotes 同步；所有提交遵循用户明确授权。

本地看板：http://localhost:8420/dashboard.html 。新界面包含总览、岗位与投递、日程与待办、同步记录，支持搜索与筛选、查看完整JD和申请历史、编辑备注、管理日程及登记已确认结果。深浅主题和窄屏布局均可用。

Windows 手动打开：dashboard/start-dashboard-silent.bat。登录自启任务为 CareerWorkbench Dashboard。查看状态：node dashboard/serve.js status；停止：node dashboard/serve.js stop。服务只监听 127.0.0.1。

## 模块

| 模块 | 职责 |
|---|---|
| dashboard | CSV 主表、事务存储、CLI、当前看板界面 |
| discovery | 公司线索、研究状态与恢复断点 |
| mcp | 6 个只读工具、事务预览与令牌绑定提交 |
| agent | LangGraph 证据匹配、检索、校验纠错、评测与批次恢复 |
| scripts | 提醒、只读预检、站点经验与工程检查 |
| references | 工作流协议和使用说明 |
| templates | 由现行字段定义生成的空白数据模板 |

## 数据与写入

八份 dashboard CSV 是唯一投递主数据，旧 Excel 保留历史用途；OfferNotes 为同步视图。不要用表格软件直接修改 CSV。

按稳定 job_id 与整体版本执行 snapshot → preview → apply → read-back。本地保存后处理同步队列，在线读回成功才记同步完成。研究结论、用户选岗、实际提交是不同事实。完整规则见 [主表协议](references/local-tracker.md)。

会话只读入口：

    node dashboard/tracker-cli.js brief
    node dashboard/tracker-cli.js rules
    node dashboard/tracker-cli.js query
    node discovery/cli.js next

CLI 落盘使用 --out=<绝对路径>，严格 UTF-8 原子保存。

## Agent 与 MCP

真实研究入口、配置方式和边界见 [Agent 使用指南](agent/USAGE.md)。可先运行 [离线演示](agent/DEMO.md)，观察受限工具补查、纠错、报告和恢复；演示模型响应为模拟数据。

在 agent 目录执行 uv sync --frozen 和 uv run jobmatch doctor。真实模型通过私有配置接入；full 是小型候选证据库的默认方式，也支持 BM25、向量及混合检索。历史评测有明确版本，不等于总体判断准确率。

MCP 使用 npm ci 安装依赖，工作区 .mcp.json 指向 mcp/server.js。MCP 与 CLI 共用同一事务层；预览令牌绑定计划和版本，不代替用户授权。见 [MCP 说明](references/mcp-server.md)。

## 检查与维护

    npm test
    node dashboard/tracker-cli.js validate

在 agent 目录运行 uv run --frozen python -X utf8 -m pytest -q。CI 同时执行 Node、Python 以及隔离 wheel 演示。

主表事务备份在 dashboard/.store/backups。个人资料、凭据、模型、浏览器配置、真实运行和评测数据位于忽略目录，不进入 Git；Git 不能代替这些数据的备份。

当前工作流维护允许修改本项目。个人简历正文和排版按用户指定由简历助手处理。

## 来源与许可

当前看板与启动器在 2026-09-29 重新实现；业务工作流的形成过程与代码来源分别记录，不用旧目录名推断整个项目的开发关系。MIT 许可见 LICENSE；必要历史声明、第三方依赖与校验器来源见 THIRD_PARTY_NOTICES.md。
