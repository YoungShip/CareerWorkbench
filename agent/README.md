# 岗位匹配 Agent

在已有求职工作流中加入独立的岗位匹配执行流程。设计与验收由使用者主导，代码以 AI 辅助实现；项目既有看板的来源和许可见上级 README。

本目录实现单岗证据匹配，以及基于多个单岗结果的公司内只读对照。full 模式提供当前抽取的全部候选人证据，不代表读取整个工作区、全部聊天或一次匹配所有岗位。公司全量目录获取、额度与志愿核实、最终选岗、网申和进度同步仍由整体工作流处理；子模块测试通过不代表所有求职任务已完成。日常入口见 [使用指南](USAGE.md)。

## 安装和本地配置

先看无需个人资料和API Key的 [离线完整演示](DEMO.md)。需要真实匹配时再配置下述工作区和模型。

在本目录执行 uv sync --frozen，然后 uv run jobmatch doctor。

Python 3.12，依赖版本由 uv.lock 锁定。正式校验器由同工作区的 .agents/skills/campus-recruitment/scripts 提供；CI 检出固定版本的公共技能仓库。JOBHUNT_SKILLS_DIR 可覆盖路径。

模型配置使用上级 data/private/secrets/llm.json；沿用 active 和 providers 结构。provider 可选 deepseek/qwen/cpa，各自填写 base_url、model、api_key。环境变量 DEEPSEEK_API_KEY / DASHSCOPE_API_KEY / CPA_API_KEY 优先。CPA 默认本地兼容入口，但必须显式填写实际模型 ID，不能从别名推断后端。密钥不进入输出或版本库。型号由用户填写；示例默认值不是当前型号或价格推荐。价格字段可选，未配置时成本为 null。max_output_tokens 默认 8192；截断结果明确判失败。

程序通过 Python OpenAI SDK 直接调用 CPA 的 Chat Completions 兼容接口；messages、工具执行和纠错由本项目的 LangGraph 流程管理。它不继承桌面 harness 的会话历史或客户端设置。max_output_tokens 限制回答长度，不是输入上下文容量；输入窗口由 CPA 路由与上游模型决定，当前代码未设置 1M 专用开关，也未设置“一万 token 输入上限”。每岗独立组织请求，不携带上一岗的聊天历史。

JD 正文和白名单经历证据会发送给配置的模型服务商；电话、邮箱、证件号先脱敏。完整档案的联系方式、家庭和薪资字段不进入语料。trace、快照、标注和结果只放在被忽略的 data/private。

本地向量模型 BAAI/bge-small-zh-v1.5 通过 fastembed 运行，缓存于 data/private/models。首次缺少文件时需要下载，HF_ENDPOINT 未设置时使用 hf-mirror.com；设置该环境变量可换回所选源。

## 命令

以下命令均在 agent 目录执行：

- uv run jobmatch doctor：配置与标注数量检查，只返回是否配置，不输出密钥。
- uv run jobmatch corpus：读取最新母表，生成带版本的私有证据库。
- uv run jobmatch match --jd-file JD.txt --company 测试公司 --title Python开发 --city 苏州 --variant hybrid：单岗匹配。
- uv run jobmatch match --job-id 已有岗位ID --variant bm25：只读主表里该岗的 JD。
- uv run jobmatch eval-labels：读回已有人工标注。
- uv run jobmatch eval-run --set blind --limit 3 --variant hybrid：三岗真实调用检查。
- uv run jobmatch eval-run --set blind --limit 50 --variant hybrid：同一盲标样本的完整运行。
- uv run jobmatch eval-report --run-dir 私有运行目录：与人工标注比较，不调用模型。
- uv run jobmatch semantic-check --provider cpa：调用配置的模型运行公开合成边界案例，最多十个；自有案例用 --cases 指定，必须注明来源和预期依据。
- uv run jobmatch compare --run-dir 岗位A运行目录 岗位B运行目录：重新核验输入一致性并生成公司内逐项证据对照；不调用模型。
- uv run jobmatch research --request 私有研究请求.json：供 campus-recruitment 日常调用，保留原始目录身份和覆盖声明，逐岗匹配后生成公司 matching v2、正式展示层及可阅读报告。请求契约见 [研究流程接入](WORKFLOW.md)。
- uv run jobmatch demo：用合成资料和模拟模型运行完整程序，无真实API调用。
- uv run jobmatch run-status --run-dir 运行目录：只读查看检查点。
- uv run jobmatch resume --run-dir 运行目录：恢复同版本冻结批次，复用已封存岗位；显式 --retry-failed 才重试已完成失败。
- uv run jobmatch semantic-check --suite quality --provider cpa：运行5组10例成对语义基准。
- uv run jobmatch semantic-compare --before 旧目录 --after 新目录：检查同集回归、改善及变化因素，不调用模型。

variant 为 full / bm25 / dense / hybrid，CLI 默认 full。当前小型证据库的同样本比较中，full 保留完整证据且运行开销最低；这是当前规模的默认选择，不表示已证明语义质量优于所有检索方式。新任务使用新运行目录，中断任务用resume继续原目录。默认顺序执行，可用 --workers 2 至 4 开启受限并发，每岗独立模型会话，每次完成就保存结果，失败保留。评测默认只跑三岗，正式比较需分别显式运行四种 variant；报告与稳定 ID 对齐，不依赖完成顺序。

eval-run、research、semantic-check均支持岗位/案例级恢复。代码、运行环境、模型配置及冻结输入需一致；中断尝试留存，新开attempt重跑。并发中断取消排队任务，在途请求可能等待响应或超时。报告保留旧失败与已知用量，中断用量不足时不估总费用。恢复范围及限制见 [RECOVERY.md](RECOVERY.md)。

eval-pool 每次创建独立的私有数据集目录（也可用 --data-dir 指定尚不存在的目录），不会覆盖旧池、样本或标注。后续 eval-sheet / eval-labels / eval-run / eval-report 用同一个 --data-dir 选择数据集；省略时仍读取最初的数据集。v2 ID 与旧 ID 不互换，不能自动迁移人工标签。研究快照数量不等于去重后的真实岗位数量。

v2 身份关联只规范化公司字符和排版，保留地名、研究所编号、子公司限定；同名或相似正文不作为关联证据。主表须绑定同一 matching_file 并有精确岗位 ID 才允许用其补 JD；多义或无绑定时不采用“最新一份”。历史 AI 结论仍只是 baseline，不是人工标准答案或当前官网认证。identity-audit.json 记录未关联与短 JD 跳过情况。

## 流程与边界

LangGraph 节点：prepare → extract → retrieve → judge ↔ search_tools → decide → verify → repair → decide / 结束。

- 模型拆要求和逐条判定；最终 decision 由确定性规则推导。
- 复合要求用 unverified_aspects 记录未核实的必要部分；存在此类缺口时结构校验拒绝 satisfied。项目存在不自动证明本人能口头讲解或现场独立改代码；单个项目未完成也不能推成本人全部经历不满足。这个约束仍依赖模型正确识别缺口，报告需要人工复核。
- JD 只引用合法行号，程序回填原文；证据 ID 必须真实存在。每一行须被要求引用或明确列为背景/非要求，遗漏会触发格式纠错；这仍不证明被排除的行在语义上正确。
- 检索模式记录实际展示给模型的证据 ID；只有初次提供或工具补查返回的证据能进入引用集合。库中存在但尚未展示的 ID 不会被自动补成有效引用，保留原始判断并由正式校验器拒绝。全量模式提供全部证据。
- 最多两次追加检索、两轮业务纠错、每岗最多 16 次模型逻辑调用。格式重试最多两次；单次 API 的临时网络错误最多四次尝试，不对认证失败反复重试。
- 输出截断时丢弃不完整结果，最多再请求一次简短完整输出；仍截断即失败。私有 trace 保留截断记录；不增加输出上限、也不将重试成功算作第一次 API 成功。
- 所有 variant 都包含同一组经历边界。full 使用全部上下文并禁用补查，其他方式比较证据召回。
- 输出先保留 raw，再调用原有 run-matching-pipeline.py 组装汇总、校验并生成 human-summary.json。
- 单岗固定 coverage=partial；mechanical_passed 与岗位 verified 只表示结构、引文和决策一致性通过。该工具没有官网全量目录核验，不自动登记、投递或同步。
- 多岗对照要求公司主体一致、候选证据一致、运行实现和模型一致；重新检查快照哈希与原校验器，拒绝失败运行、重复岗位或旧版无追溯记录的输入。按输入顺序展示，不打综合分或预测录用概率。所有额度、志愿和开放状态保持未知，selected_position_id=null。
- 该 Agent 负责证据匹配阶段。当前选岗规则、地域偏好、额度、志愿和岗位开放状态仍由原 campus-recruitment 流程核查；pending 表示待确认，不等于本人不应尝试投递。
- --job-id 通过现有 tracker query 读取完整状态校验后的指定岗位，保存整体 revision；查询失败不回退到可能陈旧的 CSV。离线历史评测池仍冻结原始 CSV 快照，不参与主表写入。
- research 通过 tracker rules 冻结当前选岗规则，规则审阅仍交回 Skill。原始目录、每岗 JD 和观察引文先查 ID 与哈希再调用模型；保留抓取时间与模型处理时间，失败岗不会被写成 excluded。公司记录省略 selected_position_id，研究结果不自动登记。
- 测试和代码存在不等于本人已经熟练掌握。面试需要用真实案例解释设计、定位代码并完成小修改。

当前执行器、检索方式、引用可见性与并发缓存的受控比较见 [OPTIMALITY.md](OPTIMALITY.md)。语料抽取同时保留正式专利排序与母表的实际分工说明；母表未收录的已确认项目可通过本机 extra-evidence.md 补充，并保留来源。

## 产物

每岗的目录含 jd-original.txt（调用方原样文本，仅私有存档）、jd.txt（脱敏模型输入）、jd-preprocessing.json（哈希、变换和源行对应）、candidate-evidence.txt、corpus.json、catalog.json、attempt-N-raw.json、attempt-N.json、verification、trace.jsonl、matching-raw.json、pipeline/ 和 result.json。源行指调用方提供的文本，不代表官网当前内容或最初 HTTP 字节。旧流水线产物未附带这份审计时不能反推其原始 JD。

extraction-audit.json 记录要求与非要求行的划分。result.json 记录当前源码内容指纹（包括未提交源码），不能只用 Git HEAD 代表本次实现。公司对照输出 comparison.md 与 comparison.json，保留来源、断言及待核对项。

JD 保留招聘批次、性质、日期、地点及带链接的业务要求；去掉明确抓取字段和导航，模型输入另隐去链接中的常见凭据参数。候选经历仅按相同文本去重，不能将“参与”与“独立”、单路与多路等近似事实合并。

学历条目保留母表原有“学位说明”“日期状态”和授予时间（有值时）；档案登记的学位名称不冒充已取得学位。整个“经历与表述边界”段保留，含“填写”“署名”等字样也不自动删条，以免遗漏尚未授权等限制。

pipeline/ 中的 assembled-matching.json 与 human-summary.json 是正式阅读入口。运行异常或超过纠错次数时 result.json 不提供可用 decision。流程完成和校验通过分开记录。

评测目录保存带代码哈希的 manifest、原样私有 samples、results.jsonl、report.json。人工标签和旧 baseline 都不送入模型。没有人工标签时状态为 no_manual_labels，不产生一致率；失败样本留在分母。labels-metadata.json 保留标注含义；按兴趣或关键词选投的标注只能报告意向一致性，不能称能力标准答案。本人判断一致率不是录用率，已投只能作为弱标签。价格未知时不报零成本。

## 验证

uv run --frozen python -X utf8 -m pytest -q 使用虚构数据和假模型，不使用私有档案、API Key 或下载向量模型。测试包含正式匹配流水线、工具与纠错上限、引文、未知证据 ID、隐私白名单、缓存和指标分母。

上级 npm test 运行原有 Node 测试。GitHub Actions test.yml 运行两套检查，不能仅凭本地成功宣称远端 CI 通过。

语义回归单独记录 provenance=synthetic / assistant_reviewed / user_confirmed。公开案例均为虚构数据；真实来源和候选事实仅存私有目录。预期断言和历史 AI 结论不发送给模型。断言通过只说明指定边界通过，不是总体准确率或人工完整审核。

成对基准进一步检查“或/且”、学历门槛、证据强度、加分项和不可信指令。案例名称和可能暗示答案的来源文件名不送入模型；报告区分误判、漏提取、引用问题和未被断言覆盖的要求。评测方法见 [QUALITY.md](QUALITY.md)。

接口参考：[LangGraph Graph API](https://docs.langchain.com/oss/python/langgraph/graph-api)、[FastEmbed](https://github.com/qdrant/fastembed)。实际调用已对照本地安装版本核对。
