---
name: career-workbench
description: "A reusable job application workflow for Codex and other AI agents. Use when a user wants to set up or run an AI-assisted job search system: collecting a candidate profile, creating an application dashboard, defining screening and resume-routing rules, finding and ranking job leads, applying to jobs within explicit safety boundaries, recording outcomes, triaging blockers, or iterating a job application workflow."
---

# CareerWorkbench（本机配置）

本工作副本的投递主源已经切换为 CSV。所有读写先读 [本地主表协议](references/local-tracker.md)：会话先用 `tracker-cli brief` 查看主表行动摘要，再用 `discovery/cli.js next` 查看尚未研究的临期线索；研究先用 `rules` 读取当前规则，按需 `query`。写入前获取完整原子快照并执行带版本校验的计划；需要落盘 JSON 时优先使用 CLI `--out`，不要依赖 shell 重定向或旧 Excel 导入脚本。

- 公司研究与选岗调用 campus-recruitment。discovery 的文本截止只作待确认提示，必须回官方来源核实；研究报告先经 `research-inspect` 核对精确公司、日期与材料哈希，再进入 preview/apply。完整目录、逐岗 JD 与 matching.json 校验仍不可省略。
- 个人事实来自 lapis-cv/秋招/网申档案.json；本项目五份资料为派生参考，不覆盖母表最新口径。
- 新增简历项目必须同步到母表的结构化项目记录与对应网申文本组；运行资料生成器后用 `jobmatch check-materials` 核验。候选索引、经历库、回答库和申请规则由母表及当前规则生成，不另存事实副本。
- 网申代填调用 job-application-form-filling，复用站点知识，按既有授权操作；执行时参考 `references/application-playbook.md` 的批量填写与集中核验规则，联动控件和最终提交边界不放宽。
- 每次申请按 job-application-form-filling 的 申请材料协议（`.agents/skills/job-application-form-filling/references/application-materials.md`，位于工作区根） 选择与 JD 对应的经历，留存实际简历、问答、完整JD及凭据；确认的新事实回写网申母表。私人材料留在 data/private，申请日志只按现有字段关联，准备稿与实际提交分开。
- 新登记Pending；实际投递成功凭证据更新Submitted并记日志。Offer只表示获得Offer，面试通过记录在阶段。
- 写入读回即完成登记。Excel仅历史备份，不回写。
- 日程、日志均用固定job_id关联，不按公司串用。
- 只调整材料表达与排序，不编造经历；岗位新鲜度按当届官方开放状态，不按24/48小时硬筛。

现行 ATS 填报手册在 references/application-playbook.md；旧初始化文档与资料模板已移除。本机资料更新执行生成与核验流程，不重新初始化或覆盖投递 CSV。
