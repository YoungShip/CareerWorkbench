# 新公司发现与定时运行

执行器可以是 Codex 或已完成适配验收的本机 Trae / ZCode 会话；本文规定可恢复的发现流程。不是独立模型服务，也不是自动投递程序。Codex 定时任务负责其自身唤起；其他执行器的启动、工具验收与首晚预算见 [Trae 夜间入口](trae-night-run.md) 或 [ZCode 夜间入口](zcode-night-run.md)，不能假设会自动继承 Codex 定时能力。

## 每轮入口

1. 使用 campus-recruitment。会话先读 `tracker-cli brief` 与 `tracker-cli rules`；已知岗位按 `query` 补读。只有全量审计、写入前检查或异常恢复才读取 tracker snapshot。岗位状态以 CareerWorkbench 为准；旧文件提到 Excel 主源时忽略该过期指向。
2. 日常先运行 `node discovery/cli.js next` 查看运行断点、临近截止候选和待研究队列；按公司或状态补读用 `query`。完整审计才使用 `snapshot`。三者返回同一 revision；`--out=<绝对路径>` 可由 CLI 原子写出严格 UTF-8 JSON。唯一主文件仍为 `data/company-discovery/leads.json`；它是研究线索池，不是第二份投递表，不保存申请状态、个人资料或认证。
3. 本轮最多新增10条公司线索、深入研究2家公司；单一入口连续失败2次后记录原因并转其他入口或公司。达到工作量上限保存断点，下一轮续接，不能为凑数量降低校验要求。

## 发现与去重

从高校就业网、校招汇总发现线索，回公司官网定位官方招聘入口。轮换覆盖江浙沪软件、测试、AI应用、智驾工具，以及央国企/研究所；不只搜索热门公司。

检查公司主体、简称、品牌和招聘项目。先与求职档案、主表、占用表及已有研究报告交叉核对，不能仅凭名称精确不匹配就认定新公司。CLI 命中已有线索后，将原公司名及已有别名一起用于去重；再次发现 researched/researching/excluded 线索时保留原记录，返回已有状态的跳过回执，不新增、不降级，也不让整轮因此报错。已研究公司复用报告，仅有明确新岗位或开放变化才增量复核；进行中认领跳过，过期认领也不擅自接手。

线索必须含来源URL、发现时间、事实与待核点。已知截止可增加结构化 `deadline`、`deadline_source_url`、`deadline_confidence`（official/cross_source/third_party/unknown）和说明；缺少结构化值时，`next` 只把文本日期作为待确认候选，不将其冒充官方截止。搜索摘要只能定位来源；高校公告不代替官方全量岗位目录。只发现公司而未完成研究时，不给S/A等级、不报为已验证推荐、不写入主表。

## 研究与登记

挑选最有价值且未占用的公司，按 campus-recruitment 认领、获取完整目录、读取范围内JD、核实额度和机器人延后规则、生成 matching.json 并 verify。研究中的认领由公司调研占用表和 run.checkpoint 留存，不通过 lead.upsert 写 researching；卡点按可支持状态记录。通过校验后用 research.complete 记 researched 并链接报告和校验结果。

本人选定后才通过主表 snapshot → preview → apply → 读回登记待投。无人值守发现任务不填写网申、不上传简历、不提交、不对外发消息。

## 线索存储与运行记录

leads.json v2 格式：schema_version、updated_at、leads数组、runs数组、active_run_id。原 v1 线索在首次写入时保留并升级，每次写入前备份。每条线索包含 lead_id、company、aliases、source_urls、official_url（未定位为空）、discovered_at、last_checked_at、state、evidence_summary、open_questions、research_file、matching_file；可选截止字段见上文。state只用 discovered/researching/researched/blocked/excluded，含义均为研究进度。`lead.upsert` 只维护 discovered/blocked/excluded；完成研究通过专用 `research.complete` 写入 researched，不放宽普通发现接口。研究进行中仍以占用表认领为准，目前 CLI 无 researching 写入动作。

### 已研究但未入池：显式补登记

正常发现仍先 lead.upsert 再研究；若指名研究或历史报告早于入池，使用 `research.register`，不能为避开 known_company 删除索引或放松普通发现去重。

此操作沿用 research.complete 的 run_id、lead_id、research_file、matching_file、expected_hashes、evidence_summary、open_questions，另要求 `registration_reason` 和 `lead`（lead_id、company、aliases、source_urls、official_url）。通过 research-inspect 获取三份材料哈希后，按 snapshot → preview → apply → snapshot 执行。必须重跑可信 matching 校验器，保留 known_company 命中证据；验证成功才原子登记 researched，计入本轮最多2家研究数，不计新发现数。已有 ID 拒绝注册，应转 research.complete；别名撞到其他 ID 或已排除记录时拒绝，不自动合并或重开。此入口不写投递主表，不替代语义审核，不将未来训练写成已完成。

### 研究完成回写

先按 campus-recruitment 完成研究、verify、比较报告及索引。已有线索按固定 lead_id 回写，即使公司已进入去重索引也不会被当作新公司跳过。不存在的线索或 excluded 线索拒绝写入；重新研究已完成线索可更新证据。保留未解决问题，researched 不等于所有招聘事实已确认，更不等于已选岗或已投递。

1. `snapshot` 取得当前 revision 和运行断点；有运行先确认归属，没有则在计划中 `run.start`。
2. 准备 JSON，含报告绝对路径 `research_file` 和 matching 绝对路径 `matching_file`。运行 `node discovery/cli.js research-inspect <files.json>`，得到三份文件（报告、matching、原始目录）的 `expected_hashes`。
3. 计划中的操作：`{ "type":"research.complete", "run_id":"当前运行ID", "lead_id":"已有固定ID", "research_file":"绝对路径", "matching_file":"绝对路径", "expected_hashes":{...}, "evidence_summary":"研究结论及范围", "open_questions":["仍未核实的事实"] }`。
4. 按 `preview → apply → snapshot` 执行，同批可用 `run.finish` 保存下一步。接口检查公司名称/已登记别名，重新运行可信 campus-recruitment 校验器，并保存计数、警告、文件哈希和验证结果；不信任旧 passed 文件。预览在临时副本上校验，不覆盖原 matching 或原验证文件。材料变化或版本冲突时重新读取，不强行覆盖。
5. 每轮最多回写2家，同一轮同一线索重试不重复计数。完整研究的每岗引文、语义判断和报告一致性仍由 campus-recruitment 负责，自动校验不能代替阅读JD。

校验器从工作区的 `.agents/skills/campus-recruitment/scripts/verify-matching.py` 读取；Python 依次取 `JOBHUNT_PYTHON`、Codex 本机运行时（存在时）、PATH 上的 python3/python。校验器/解释器缺失时拒绝完成回写。`research_evidence` 保存该次实际验证输出，不产生投递主表或 OfferNotes 写入。

所有线索及运行状态写入通过 `discovery/cli.js snapshot → preview <plan.json> → apply <plan.json> → snapshot`，plan 包含 expected_revision 和 operations，不直接覆盖 JSON。只读命令另提供 `query` 与 `next`；所有 JSON 命令可用 `--out=<绝对路径>` 避免 Windows shell 重定向破坏中文。短写入锁阻止并发写，版本冲突拒绝覆盖；单文件原子替换同时保存线索和断点，备份放私有目录 backups/。来源引用和去重命中的文件位置留存，不把个人档案原文复制到运行记录。

run记录与线索保存在同一权威文件的 runs 数组，包含起止时间、sources、decisions、checkpoint 和 next_steps。`node discovery/cli.js run-export <绝对路径receipt.json>` 将最近运行导出到 `data/company-discovery/runs/`，仅供查阅；导出文件不是第二主源，丢失时可重建。

### 执行器命令与断点

从 CareerWorkbench 目录执行；其他工作目录使用 CLI 绝对路径。计划操作如下：

- `run.start`：传新的 run_id。有未完成运行时拒绝开启第二轮；先检查已有断点和所属任务。
- `lead.upsert`：传 run_id、lead（上述线索字段）。按固定ID与显式别名合并，已有来源合并保留。CLI 每次加载主表、档案、占用表、优先池和研究文件名；命中已知公司则记 known_company 并跳过新增。名称命中只是去重提示，主体／品牌共享关系仍需人工核实；不自动推断母子公司同一主体。英文缩写按词边界匹配。
- `research.complete`：用于已有线索的完成登记；传 run_id、lead_id、research_file、matching_file（均绝对路径）、evidence_summary、open_questions 和 expected_hashes。先以含两文件路径的 JSON 运行 `research-inspect <文件>` 获取材料哈希；将返回 expected_hashes 放入事务操作，preview → apply → snapshot。接口检查公司身份、材料哈希、原始快照，并在隔离副本重跑 matching 校验；报告与 matching 需含相同公司及日期。每轮最多完成2家公司；此操作只记录研究，不登记待投。
- `source.record`：传 run_id、url、outcome（ok/error）、summary，记录实际读取结果。先记录失败再决定下一次访问；同URL连续两次失败后本轮不再反复重试，改用其他入口或保存卡点。CLI 不自行发网络请求，搜索与浏览器由当前实际执行会话提供。
- `run.checkpoint` / `run.pause`：传 run_id、summary、next_steps；后者保存为 paused。每完成一个来源或一个公司的处理即保存，不等到整轮结束。
- `run.resume`：检查已有 paused 断点后传同一 run_id，继续本轮。进程中断但状态仍 running 时，读取断点，以同一 run_id 继续 checkpoint；不重开新轮，不自动接手其他会话。
- `run.finish`：传 run_id、summary、next_steps，结束本轮，释放 active_run_id。没有匹配校验的线索不得在总结中写成推荐完成。

每轮新增10条上限由代码核验；开始深入研究前由会话核对本轮最多2家；research.complete 同时限制本轮完成计数，CLI 不代替实际研究。重复别名更新不占新增额度。snapshot/preview 不修改线索；备份、运行记录和计划均位于 Git 忽略的私有目录。

## 本轮结果交付

`run.finish` 只结束运行，不代表所有线索已研究或所有待核事项已解决。面向用户的完成回复说明新增／完成研究／受阻数量、校验计数、报告入口及实际登记／同步情况；存在推荐时执行 campus-recruitment 第 9 步的投递规则摘要要求，让本人能据此选岗，不能只报岗位名或让本人另开报告才能知道额度和限制。受阻线索说明卡点与续接事项，不给未经验证的推荐等级。最多研究2家是上限，实际完成几家如实报告。

## 定时行为与通知

本地回归验收命令：`node --test discovery/store.test.js discovery/research.test.js discovery/acceptance.test.js`。acceptance 使用隔离工作区、合成材料和真实 CLI 子进程/校验器，覆盖暂停重启、来源失败上限、校验失败后修复、解释器不可用、已提交计划重放、别名去重，以及写入替换前强制终止后的恢复。此测试不验证真实招聘网站、浏览器登录或定时唤起，后者不能据本地测试宣称已验收。

使用当前任务的定时跟进保留上下文；每次读本文件和最新档案，不只依赖聊天记忆。使用当前真实本地目录，个人CSV被Git忽略，不能假设新worktree会带有它们。

先检查上轮是否仍在运行，避免重叠。首次自动执行应验证本地文件、搜索和所需浏览器工具实际可用。登录或浏览器失效时保存进度，不反复登录、不声称完成同步。

仅在出现已验证合适岗位、重要截止变化、完成结果或需要处理的失败时通知；无变化保持安静。同一未变化阻塞不重复通知。未研究线索保存在本地，不能冒充推荐推送。

计划频率由用户指定；不自行增加任务或频率。每轮工作量上限不是硬性token计费上限；实际用量受账户额度约束。定时任务运行还需电脑和应用可用，不承诺关机运行。

## 数据目录维护

2026-09-13 起研究业务数据固定放在 data/company-discovery/，私人材料放在 data/private/，均与编辑器无关且被 Git 忽略。不要当缓存删除。预检会检查 leads.json 是否存在；缺失时先调查备份和留存报告，不能将返回空池当作正常验收。恢复历史报告需经 research.register 重新校验，注明重建时间，不伪造原始运行历史。
