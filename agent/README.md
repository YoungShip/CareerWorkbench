# 岗位匹配 Agent

campus-recruitment 研究公司时调用的逐项证据匹配程序。使用者提出匹配与申请管理的业务需求，框架设计、检索、实现与测试主要由 AI 完成，不把实现归为使用者已掌握的研发能力。

它只负责证据匹配：拿到官方 JD 和候选人证据，逐条判定要求是否有证据支持，再交给原有 matching 校验流水线。公司全量目录、额度与志愿、最终选岗、网申和主表登记仍由整体工作流处理。日常入口见 [使用指南](USAGE.md)，研究请求契约见 [研究流程接入](WORKFLOW.md)。

## 安装和本地配置

在本目录执行 `uv sync --frozen`，然后 `uv run jobmatch doctor`。Python 3.12，依赖由 uv.lock 锁定。

- 正式校验器来自同工作区的 `.agents/skills/campus-recruitment/scripts`，`JOBHUNT_SKILLS_DIR` 可覆盖路径。
- 模型配置在上级 `data/private/secrets/llm.json`（active + providers 结构；provider 可选 deepseek / qwen / cpa，各填 base_url、model、api_key）。环境变量 `DEEPSEEK_API_KEY` / `DASHSCOPE_API_KEY` / `CPA_API_KEY` 优先。密钥不进入输出或版本库。`max_output_tokens` 默认 8192，截断即判失败。
- JD 正文和白名单经历证据会发给配置的模型服务商；电话、邮箱、证件号先脱敏，联系方式、家庭和薪资字段不进入语料。trace、快照和结果只放在被忽略的 `data/private`。
- 本地向量模型 BAAI/bge-small-zh-v1.5 通过 fastembed 运行，缓存于 `data/private/models`；`HF_ENDPOINT` 未设置时用 hf-mirror.com。

## 命令

在 agent 目录执行：

- `uv run jobmatch check-materials`：只读核对母表项目、简历文字和生成资料；`--matching-file` 检查旧结果的冻结证据是否仍适用。
- `uv run jobmatch doctor`：检查模型配置和资料一致性，不输出密钥；未就绪返回非零。
- `uv run jobmatch research --request 私有研究请求.json`：campus-recruitment 日常入口，逐岗匹配后生成公司 matching v2、展示层和报告。
- `uv run jobmatch match --jd-file JD.txt --company 公司 --title 岗位`，或 `--job-id 已有岗位ID`：单岗匹配。
- `uv run jobmatch compare --run-dir 岗位A目录 岗位B目录`：同公司多岗只读对照，不调用模型。
- `uv run jobmatch corpus`：从最新母表生成带版本的私有证据库。
- `uv run jobmatch run-status --run-dir 目录` / `resume --run-dir 目录`：查看或恢复中断的研究批次；`--retry-failed` 才重试已失败岗位。恢复要求代码、环境、模型配置和冻结输入一致。

`--variant` 可选 full / bm25 / dense / hybrid，默认 full（小型证据库下保留全部证据、开销最低）。

## 流程与边界

LangGraph 节点：prepare → extract → retrieve → judge ↔ search_tools → decide → verify → repair → decide / 结束。

- 模型拆要求和逐条判定；最终 decision 由确定性规则推导。
- JD 只能引用合法行号，证据 ID 必须真实存在；每一行要么被引用，要么明确列为背景，遗漏会触发纠错。复合要求的未核实部分记在 `unverified_aspects`，存在时不能判 satisfied。
- 最多两次追加检索、两轮业务纠错、每岗最多 16 次模型调用；截断结果丢弃。
- 输出先保留 raw，再调用 run-matching-pipeline.py 组装、校验并生成 human-summary.json。`mechanical_passed` 只表示结构、引文和决策一致，不代表语义正确，报告需要人工复核。
- research 通过 `tracker rules` 冻结当前选岗规则；结果不自动登记、投递或同步。
- 正式简历项目先进母表、生成资料并通过 [资料链路检查](../references/materials-consistency.md)。

## 产物

每岗目录含 jd-original.txt、jd.txt（脱敏输入）、jd-preprocessing.json、candidate-evidence.txt、corpus.json、attempt-N-raw.json、trace.jsonl、matching-raw.json、pipeline/ 和 result.json。正式阅读入口是 `pipeline/` 下的 assembled-matching.json 与 human-summary.json。

## 验证

`uv run --frozen python -X utf8 -m pytest -q` 使用虚构数据和假模型，不读私有档案、API Key，也不下载向量模型。上级 `npm test` 运行 Node 测试；GitHub Actions 的 test.yml 两套都跑。
