# Matching Agent adapter

适用于工作区已经配置独立岗位匹配 Agent 的情况。Agent 处理逐项证据匹配，Skill 负责官方来源、范围、选岗规则和业务授权。不以 Agent 存在为理由扩大本次公司/岗位范围。

## 启用与降级

若当前工作区含 CareerWorkbench/agent/pyproject.toml，使用该工作区的 jobmatch research 入口；首次使用先运行 jobmatch doctor，确认母表、校验器和模型已配置。模型 Key 只从私有配置加载。

其他适配器采用等价的输入输出契约即可。未配置适配器时沿用本 Skill 原逐项匹配流程，无需安装新工具、修改账号或要求用户提供已有凭据。接口失败或输出不合法时保留运行目录和错误；有限重试耗尽后报告该岗待处理，其他可独立核实的事实继续完成。不得把失败改成“不适合”，或用旧成功结果冒充当前运行。

## 准备一次请求

先完成本 Skill 的来源与范围核查，再把原始目录、完整 JD、规则观察保存到同一个私有研究目录。JSON 使用严格 UTF-8；所有岗位使用官方稳定 ID，不能靠岗位名匹配。

CareerWorkbench 请求 schema_version=1，字段如下：

| 字段 | 内容 |
|---|---|
| company、scope | 本次精确招聘主体及研究范围；集团不同主体分开 |
| coverage | 沿用真实抓取声明，不因模型跑完就升级为 complete 或 human_attested |
| raw_catalog | file、sha256、format、显式 ID 提取规则、total_positions |
| catalog_index | 原始目录完整 ID 索引；id、title、city、in_scope；范围外须给 exclusion |
| jd_sources | 每个范围内岗位一份：position_id、file、sha256、url、带时区的 read_at |
| observations | 可选的官方条件观察：topic、position_ids、text、source、quote |

相对路径以请求文件所在目录为基准。sha256 为文件实际字节的 SHA-256；从 HTML/API 提取 JD 时同时保留原始响应，记录提取方法和绑定的岗位 ID。read_at 是来源获取时间，不是模型运行时间。

raw_catalog 的 format 支持 json/csv/tsv。JSON 显式给 records_path 和 id_path（JSON Pointer）；CSV/TSV 给 id_column。目录索引必须与原始快照的 ID 集合及数量一致。范围内 JD 数量每次 1–20 份，超过时按清晰范围分批，保留各批及总范围的覆盖缺口，不把分批成功拼成未经核查的全量声明。

observations.topic 可为 cohort、employment_type、city、open_status、application_limit、preference_order、change_or_withdraw、deadline、interview_format。source 包含 file/sha256/url/read_at，quote 须能在快照中定位。引文存在只证明与所提供快照一致，不证明该事实适用于当前账号或所有子公司；未提供观察的主题保持 unknown。

尤其注意：

- “校园招聘”频道或标题“可实习”不单独证明合同性质，按完整 JD 和规则核对。
- 未登录公共列表中的个人状态字段不能当作用户申请记录；额度仍以本地规则规定的登录后当前账号页面为准。
- B 入口可保留完整目录身份，仅对本次明确的岗位设置 in_scope=true；其他岗位是本次未研究，不能被写成不匹配。
- 现行求职规则由适配器读取并存档；程序读取成功不等于规则已完成语义核查。

## 调用

在已配置的 CareerWorkbench/agent 目录运行：

    uv run jobmatch research --request "<私有研究目录>/research-request.json" --provider cpa

provider 使用当前工作区已选配置，可省略。默认 full；是否改用检索方式按实际证据规模和评测决定。Agent 不继承桌面会话历史或其上下文设置。

适配器先检查目录身份、JD 哈希和观察引文，再调用模型。保留逐岗独立结果，生成统一的公司 matching v2，并运行本 Skill 的正式校验流水线。公司记录不设置 selected_position_id。

## 必须读回

1. workflow-result.json：execution_status、mechanical_passed、readiness、每岗成功/失败、gate_checks、规则版本。
2. pipeline/assembled-matching.json 与 human-summary.json：逐项判断、等级、证据区间、缺口和可登记岗位 ID。
3. research-report.md：用于向用户展示的报告；证据匹配度不是录用率。
4. current-rules.json、研究原始快照和逐岗 extraction-audit.json：核查规则适用、被当作背景的 JD 行和必要部分缺口。

CLI 退出 0 或 execution_status=completed 不证明全量目录、语义准确或可登记。必须分别检查：

- 失败岗位仍保留缺口，不能称已完成全量研究；
- coverage 与 read_at 使用来源声明，不能拿新处理时间给旧快照“刷新”；
- 多项能力要求的必要部分是否全部有证据；unverified_aspects 非空时不能判整条满足；
- 当前规则、岗位性质、地域、共享额度、志愿和历史申请是否仍待核实；
- S/A/B/C 与区间来自正式展示层，不由主调用模型另造百分比。

Agent 提供的语义判断可以复核，不能为了获得更好等级删除缺口或重复重跑挑结果。发现错误时保留原输出、记录具体引文和原因，再走原始记录→正式组装→校验流程形成新版本。

## 交回选岗与登记

先按主 Skill 输出当前范围的已核实结果、未核实条件和选项，等用户选定岗位。匹配结果不是投递授权。

用户已明确选择后，才把稳定 ID 带入新一轮匹配复核，检查该 ID 位于 registerable_position_ids 且 can_register_selected_position=true。其后的 snapshot → preview → apply → read-back 完全沿用原协议。pending、范围不完整或来源不足时保持相应阻断；已有投递事实不回滚。

## 资料更新后的同步检查

已配置 CareerWorkbench 时，简历或母表更新后先运行 jobmatch check-materials；doctor 也返回资料核查状态。新增简历项目要有母表结构化项目、对应分栏文本与当前模型证据，不能仅有 PDF 或自我介绍。错误时先同步母表并运行其资料生成器，再核验；不得把资料错误判成岗位不匹配。

旧匹配用于新选岗前，可用 check-materials --matching-file 核对冻结事实版本。stale 或 unknown 要按当前事实复核，原结果和历史投递保留。未配置该工具的工作区按相同原则手工核对，不要求安装。
