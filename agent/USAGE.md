# 日常使用：从完整 JD 到选岗对照

本模块负责整理可核对的证据，帮助本人和助手讨论选岗。简历正文、最终投递和主表登记仍按各自已有流程处理。

日常可直接让助手研究公司；已配置本项目的 campus-recruitment 会调用研究入口，无需本人手动拆命令。官方快照到公司报告的输入输出见 [研究流程接入](WORKFLOW.md)。下面的单岗与对照命令用于单独使用或诊断。

## 1. 准备输入

在 agent 目录运行以下命令，先确认模型配置可用：

    uv run jobmatch doctor

把完整岗位正文保存为本地文本。保留招聘批次、学历、毕业窗口、专业、岗位性质和补充说明；不要只复制搜索摘要或带省略号的列表卡片。标题与正文不一致时原样保留，标为待核对。

默认使用母表的最新事实和求职档案的经历边界，不从代码存在推断本人已经掌握。额外能力需要本人确认后更新事实来源；不要为了提高匹配结论临时增写经历。

## 2. 分别运行岗位匹配

以下路径与 ID 均为占位示例，替换为已核对的输入：

    uv run jobmatch match --jd-file "岗位A.txt" --company "公司完整主体名称" --title "岗位A" --position-id "官方岗位ID-A" --url "https://example.invalid/jobs/A" --provider cpa

    uv run jobmatch match --jd-file "岗位B.txt" --company "公司完整主体名称" --title "岗位B" --position-id "官方岗位ID-B" --url "https://example.invalid/jobs/B" --provider cpa

每次返回独立运行目录。默认 full，每岗是新会话；不需要塞入全部历史聊天。密钥只填本地私有配置，勿粘进命令或报告。

已有主表岗位也可用：

    uv run jobmatch match --job-id "主表稳定job_id" --provider cpa

主表 JD 为空时会停止；需要先从官方来源补全，不从同名岗位猜测。这里的单岗 matching 文件中 selected_position_id 仅标识本次分析对象，不表示本人已批准登记或投递。

## 3. 阅读单岗结果

- result.json：是否执行完成、是否通过机械校验；失败时没有可用 decision。
- pipeline/human-summary.json：原工作流格式的逐条结果。
- pipeline/assembled-matching.json：JD 引文、候选证据、每条判断和依据。
- jd-original.txt、jd.txt、jd-preprocessing.json：原文、模型输入及转换对应。
- extraction-audit.json：模型怎样划分要求和背景，尤其检查被排除的行。
- unverified_aspects：一条要求里仍缺证据的部分；这些部分未核实时不能把整条判满足。对照报告也会列出被模型当作背景的原文，方便检查是否误排除了要求。

“待核对”表示资料或资格口径尚未确认。“存在明确不满足项”应检查对应原文和证据。任何结论都不等同于招聘方一定录用或拒绝。

## 4. 比较同公司多个岗位

    uv run jobmatch compare --run-dir "岗位A运行目录" "岗位B运行目录"

打开新生成的 comparison.md 阅读表格和逐条证据。它不额外调用模型，按输入顺序展示。

比较器会拒绝不同公司主体、不同候选证据版本、不同实现/模型、重复岗位 ID、失败运行，以及原文无法追溯的旧结果。发现此类输入时先核对来源并统一运行条件，不为了凑齐结果改写旧报告。

公司全量目录、当前开放状态、投递额度、志愿顺序及现行选岗规则仍须核查。对照中未知项不能当成“无限额”或“当前开放”；本人选定后再执行主表事务与线上同步。

## 5. 复现与诊断

没有个人资料和Key时，先运行公开 [离线演示](DEMO.md)。它的模型响应是预制的，报告不会冒充真实模型成绩。

不调用模型的工程检查：

    uv run --frozen python -X utf8 -m pytest -q

真实模型边界检查（公开合成案例，最多十个）：

    uv run jobmatch semantic-check --provider cpa

成对判断质量检查：

    uv run jobmatch semantic-check --suite quality --provider cpa

批次中断后可用 run-status 查看、resume 继续。恢复和失败重试边界见 [RECOVERY.md](RECOVERY.md)；同集质量比较见 [QUALITY.md](QUALITY.md)。

失败会保留在私有报告中。先区分接口/截断、格式/引文、提取遗漏、语义偏差，再决定修复或小范围回归；不通过重复重跑挑成功结果。

历史 50 岗比较见 EVAL.md，对应固定旧版本。新评测池用 eval-pool 创建独立目录，后续命令用同一 --data-dir 指定；不重建已填写的表格，不将兴趣标签当能力标准答案。
