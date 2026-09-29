# 第三方与历史组件说明

CareerWorkbench 的当前工作流以使用者自行设计的三个 Skill 为起点，主体模块及 2026-09-29 的看板重写见 [项目来源](references/project-origin.md)。

早期试用过 DanielPan12/JobHuntBot，并采用过其看板、启动器、CSV 模板及应用手册中的内容。原始 MIT 声明完整保存在 [legacy-components.txt](third_party/licenses/legacy-components.txt)，历史提交和归档保留真实来源。本轮重新实现了看板页面、前端交互、启动器和当前填报手册，CSV 空白模板从本项目当前字段定义生成。

独立实现的范围不包含第三方运行库。LangGraph、OpenAI SDK、FAISS、FastEmbed、BM25、MCP SDK 等依赖各自保留所属许可；锁文件记录实际依赖。离线演示中打包的 matching 校验器保留自身来源与 LICENSE。

不得把沿用组件、第三方框架或 AI 辅助实现描述为本人独立手写。历史软件来源与当前项目主体设计的归属分别按证据说明。
