# 秋招工作区说明

## 项目身份

现行项目为 CareerWorkbench（求职工作台），由本人先建立的三个 Skill 工作流发展而来。当前介绍与归属先读 CareerWorkbench/references/project-origin.md；按独立设计、AI 辅助实现、第三方复用分别说明，不把历史目录名推导成整个工作流的来源。简历正文仍由本人指定的简历助手修改。

2026-09-13 本人批准迁移：`D:/AppData/Documents/resume/CareerWorkbench/dashboard/` 的 CSV 为唯一投递主数据。原 Excel 仅保留历史备份，不再回写；OfferNotes 为同步视图。

## 0. 硬触发：涉及浏览器或网页时，先读技能再动任何东西

触发范围：OfferNotes、网申站点、任何要打开或操作网页的任务。第一步固定为读 `D:/AppData/Documents/resume/.agents/skills/offernotes-sync/SKILL.md` 及其 `references/sync-knowledge.md`，**先于**探测端口、启动进程或宣称能力边界。

接手这类任务的第一条命令固定为只读预检：`node CareerWorkbench/scripts/trae-preflight.js [客户端名]`（省略客户端名则自动探测）。它检查技能接线、主数据和本地第 3 级工具链，不启动 agent、不写业务数据。若某客户端 Junction 在当前文件访问层不可穿透，以 `.agents/skills` 真身绝对路径读取技能，不据此判定该客户端整体失败。

浏览器通道按 ①用户日常 Chrome 的已授权插件连接 → ②内置浏览器 → ③A Playwright 专用持久化 profile → ③B Raw CDP 专用通道 依次选择；前一级能可靠完成并读回时不升级。①/② 属当前 AI 运行时能力，预检脚本无法代替工具清单判断。

第 3 级分成两条独立实现：
- **③A Playwright 网申通道**：专用非默认 Chrome profile 位于 `CareerWorkbench/data/private/playwright-application/chrome-profile`，本机运行时锁定 `playwright-core`；默认调试端口 9333。允许用于官网读取、登录后网申页面、简历上传、解析纠错、字段填写和完整读回，提交边界见第 8 条。
- **③B Raw CDP 同步通道**：OfferNotes 专用 profile 位于 `CareerWorkbench/data/private/offernotes-cdp/chrome-profile`，默认端口 9222。**仅当①/②无法完成 OfferNotes 同步时兜底**，并用于 API 级精确操作和只读诊断；不作为普通 ATS 填表首选。

端口未监听只表示对应专用 Chrome 未启动，不等于登录失效或 profile 损坏。禁止对用户日常 Chrome 默认 profile 开启 remote debugging。agent-browser 对 OfferNotes 的独立 profile 既有 403 结论不变，不再作为候选通道。

1. 公司调研、选岗、核额度和投递记录维护必须使用 campus-recruitment：保留求职档案、全量目录、完整JD、matching.json及verify校验。
2. 主表读写必须先读取 [主表协议](D:/AppData/Documents/resume/CareerWorkbench/references/local-tracker.md)。本机 `query` 是 `snapshot` 的精简投影，内部仍校验完整状态并返回同一整体 revision，不改变 Skill 的事务边界。
   - **会话先看行动摘要**：`node D:/AppData/Documents/resume/CareerWorkbench/dashboard/tracker-cli.js brief` 只读汇总临期、待补救、时间未知、待投规则冲突及同步队列数量；默认每类最多 8 条，需全清单时 `--limit=100`。摘要不是投递授权或写入计划。
   - **未研究线索用 discovery 精简视图**：`node D:/AppData/Documents/resume/CareerWorkbench/discovery/cli.js next` 查看临近截止候选、断点与待研究队列；按公司/状态补读用 query，全量审计才用 snapshot。文本提取的截止只作待确认信号，必须回官方来源核实。
   - **常规查询默认 query**：进度、待办、排期和单岗维护先运行 `node D:/AppData/Documents/resume/CareerWorkbench/dashboard/tracker-cli.js query`，已知岗位/公司时用 `--job_id=<id>` / `--company=<名称>` 过滤，按需用 `--fields=job_id,company,job_title,status,next_action,notes` 取字段；需要完整 JD 或事件备注时用 `--include_description`。不先把八表和全部 JD 灌入上下文。
   - **完整审计仍用 snapshot**：全量审计、同步队列核查、异常恢复和 apply 前的完整状态审计用 `snapshot`。`query` 不含 sync_queue，不能据此宣称已经同步；未返回字段不等于空值，缺少事实时补读，不猜测或清空。
   - 写入按稳定 `job_id`，带最新整体 `expected_revision`，保持 `preview → apply → 读回`。定向读回须显式包含本次改动字段及关联事件；跨表或无法定向验证时用 `snapshot`。冲突后重读、重预览，不自动覆盖，不直接改 CSV，不运行旧 Excel 导入脚本。
   - CLI JSON 需要落盘时使用 --out=<绝对路径>，由程序严格 UTF-8 原子写入；不要用旧 Windows PowerShell 文本管道保存中文 JSON。
3. 选岗规则、经历边界、公司去重索引的唯一来源是 `D:/AppData/Documents/resume/lapis-cv/秋招/求职档案.md`；个人资料仍以网申档案.json为准。公司研究先用 `tracker-cli.js rules` 提取当前选岗规则和经历边界，再按公司/岗位读索引与证据；进度维护不重复加载全量背景与历史公司表。缺少个人字段时按需读母表，不用旧全景档案覆盖最新事实。
4. 新研究岗位经本人选定才登记待投；实际提交、对外消息、订阅遵从本人明确指令。已经授权的同一动作无需重复确认。
5. 本地写入验证后按 offernotes-sync 同步。sync_queue的pending/error必须处理；离线时明确保留待同步，不声称线上已完成。公司调研占用表只负责研究认领。
6. CareerWorkbench为允许维护的项目；其他项目源码只在核对经历证据时查阅，不在此改动。

维护：本文件与 resume/AGENTS.md、lapis-cv/AGENTS.md保持相同规则。
7. **浏览器通道优先级（2026-09-22 本人调整：Chrome 插件优先）**：涉及网页操作依次使用：
   1) 用户日常 Chrome 的已授权插件连接；
   2) 当前客户端内置浏览器；
   3A) **Playwright + 专用持久化 Chrome profile**，用于网申和需要可靠 UI 交互/读回的页面；
   3B) **Raw CDP + 专用 Chrome profile**，仅在①/②无法完成 OfferNotes 同步时兜底，并用于 API 级精确操作和只读诊断。
   前一级能完成任务时不启用后一级。③A/③B 都使用非默认 profile，不复制、不 remote-debug 用户真实默认 Chrome。专用 profile 可持续保存已登录会话；登录态是否仍有效必须打开目标页面实际核验，不能从端口或 tab inventory 猜测。
   **①/②控件可达性必须实测（2026-09-23 本人确认增补）**：插件已连接不等于①能完成任务——无障碍树不暴露的自定义控件（如北森 zhiye 的“立即投递”DIV）在①/②都拿不到 ref，只有打开页面才能发现；已知此类站点（北森 zhiye）直接③A，不浪费轮次重试。
   **OfferNotes 同步通道跟随投递通道（2026-09-22 本人要求）**：本次投递走①插件或②内置浏览器时，同步优先走同一通道——该通道已登录 offernotes.cn 时，直接在该页面内用页面内认证完成 reconcile，不另启③B 专用实例；该通道不可用或未登录 OfferNotes 时，保留 `pending/error` 并向本人说明，确有必要才降级③B。投递走③A 时，同步按①→②→③B 选择。

8. **第 3 级网申边界与远程接管**：
   - **③A Playwright 已通过 2026-09-21 小米真实 ATS 实测，可用于常规网申填写。** 实测覆盖：持久化手机号登录、岗位页→申请页、PDF 上传、简历解析、解析错误修正、文本框、role=option 下拉、树形城市、年月控件、自我评价及全字段读回。Playwright 对被固定页头/页脚遮挡的点击会主动拒绝；这类失败优先改用精确语义元素或组件级方法，禁止退化为盲目坐标连点。任何强制/脚本事件操作后仍必须读回。
   - **③B Raw CDP 仍不作为普通 ATS 填表/提交通道。** 2026-09-17 携程事故中出现下拉假开、坐标误点、保存未落库和离页丢值；Raw CDP 保留给 OfferNotes/诊断。2026-09-19 智驾新程 9 岗是历史一次性 Raw CDP 例外，不推广；以后同类网申优先③A。
   - **登录/注册接管**：新站点首次注册、短信验证码、微信扫码、滑块、CAPTCHA、Cloudflare、账号选择等由本人处理。本人不在电脑旁时，可通过 UU 等已授权远程桌面短暂接管专用 Chrome；完成后 AI 从当前页继续，不要求提供密码、验证码或 Cookie。
   - **失败接管**：单个控件最多采用三层策略：语义 locator/真实选项 → 组件特定方法/键盘 → 在状态可恢复时一次安全重入。仍失败即标记 `needs-human` 并交本人，不无限重试、不随机 selector、不盲点坐标。刷新/重入前先判断页面内容是否已服务端保存；“页面显示过”不等于已保存。
   - **最终提交授权与浏览器通道分离**：默认 `review`——填完并全量审计后停在最终按钮前；`preauthorized`——本人事先明确批准具体岗位或一批岗位后，审计无错误、岗位/简历/额度/高影响答案均已核实时可直接最终提交；`autonomous` 仅在本人另外明确给出范围、筛选规则和提交授权后启用，当前不因一般“自动投递”意愿自动开启。验证码、未知高影响问题、额度/志愿冲突、不可逆弹窗仍强制接管。
   - **成功判定**：点击最终按钮不等于 Submitted。只有成功页、账号应聘记录、确认邮件或本人明确确认等真实证据，才能先落盘私有材料快照（materials / field-audit / submission-evidence / official-jd，技能第6步硬性收尾，直接执行不询问），再按主表事务协议登记 Submitted、追加申请日志并同步 OfferNotes。登记后主动向本人交付**全字段提交内容清单**（敏感打码、含未填项原因与偏差修正记录）供事后复核，不等待索要；本人指出偏差即回灌工作流信息层。

   **历史一次性 Raw CDP 例外**：2026-09-19 智驾新程（neueHCT）9 个匹配岗曾在本人逐步明确授权下用 Raw CDP 连续提交且未触及额度上限。该记录只作为历史证据与故障对照，不构成其他公司使用 Raw CDP 的先例；2026-09-21 起普通网申优先使用③A Playwright。
9. **到期提醒（本人于 2026-09-20 要求"密一点提醒"）**：笔试、测评、面试等有截止时间的事项按三重提醒执行，避免遗忘：
   ① **会话自动检查**——每次新会话开始，先跑 `node CareerWorkbench/dashboard/tracker-cli.js brief`（失败时退回 `node CareerWorkbench/scripts/remind.js --json`）；若有已过期或 72 小时内到期的事项，在第一条回复中主动列出，不必等本人询问。
   ② **桌面通知**——`CareerWorkbench/scripts/register-reminders.ps1` 已注册 3 个 Windows 计划任务：每晚 20:00 汇总、每小时门槛检查（跨过 24h / 2h 门槛或刚过期时各提醒一次，同一门槛不重复）、登录时检查。脚本只读 `follow_up.csv`，不写主表；门槛去重状态在 `CareerWorkbench/tmp/remind-state.json`。
   ③ **微信推送**——本人于 2026-09-20 提供 Server酱 SendKey 并明确授权，**已接通实测成功**。凭据在 `CareerWorkbench/data/private/secrets/serverchan.json`（含密钥，不得提交版本库、不得出现在对外消息或截图中），说明见同目录 `README.md`。**免费版每天上限 5 条**（超出返回 `code=40001`），因此按"这条推送能改变什么"分档分配，不平铺：**紧急(2h 内)上限 5 条、重要(24h 内)4 条、补救(已过期但有 next_action)4 条、例行(汇总/登录检查)3 条**；同档多事项合并；本地每天最多 5 条为保护预算，实际服务端限制以响应为准。发送互斥串行，只有服务端确认成功才记账；dry-run 不发送、不记已提醒、不读密钥。**已过期且无 next_action 的不单独推送**（推了也改变不了结果），只在汇总里列出。另有内容去重、服务端 40001 兜底、跳过记录（`node CareerWorkbench/scripts/remind.js --quota` 可查）。推送内容仅限秋招到期提醒，**不得**用于其他用途，也不得新增其他对外通道。
   运行记录：`CareerWorkbench/logs/remind.log`（只记结果与计数，不记凭据）。
   登记口径：本人确认"未做"的过期事项按协议登记**事实**，不登记为完成。

10. **现行规则与历史记录分层**：`brief.policy.status` 非 current 时，先按母表/求职档案核对规则并更新私有派生筛查配置；不得把失效配置下的空清单说成没有冲突。旧 Pending 命中新规则只提请本人复核，不自动取消、删除、改评级或实际提交；已投事实不回滚。派生规则绑定当前「选岗规则」段的哈希，历史公司表更新不引起误失效。
11. **站点经验分层与自进化**：表单操作先读通用 Skill，再读 `CareerWorkbench/references/site-knowledge-overlay.md` 定位本地观察，并运行 `node CareerWorkbench/scripts/site-knowledge-status.js`。只有 `fresh + verified` 可作为当前操作提示；`stale/candidate/historical` 必须现场复核后才能使用。真实失败或新控件只先沉淀为 candidate，取得页面读回/服务端证据后才晋级 verified；verified 超过 `stale_after_days` 自动视为 stale。租户/批次/账号限定的额度、材料继承与推荐码行为不得推广为整个 ATS 家族规则；只有去除个人信息且跨独立站点重复验证的控件级规律才允许晋级公共 Skill。
12. **面试准备**：先读具体岗位与 `CareerWorkbench/references/interview-proof-checklist.md`；围绕已证实项目练习讲解、定位代码和排错，不为迎合 JD 新增成果或把 AI 辅助代码说成完全独立手写。
13. **仓库同步（2026-09-23 本人要求：仓库保持最新最优工作流）**：CareerWorkbench（origin=YoungShip/CareerWorkbench）与 lapis-cv（origin=xiepeng-yang_nioer/lapis-cv）均为 git 仓库，工作流文件（AGENTS.md、references/、scripts/、dashboard/ 适配器、discovery/、templates/ 等）凡经本人确认的修改，应在当次会话结束前 `git add <具体文件> → commit → push origin main`，不积压未提交漂移；commit message 简短说明动机。会话开始处理投递任务时顺带 `git status -sb` 检查漂移，发现未提交改动先向本人说明再提交。红线：gitignore 已排除的私有数据（data/*、dashboard/*.csv、.store、tmp、logs、私密信息.json 等）永不提交；推送前扫描 diff 不含证件号、测评专属链接、凭据。lapis-cv 的简历 PDF、求职档案等个人材料是否入库由本人逐项决定，不默认提交。resume/ 根目录的 AGENTS.md 不在仓库内，以 CareerWorkbench 仓库副本为同步源；三份 AGENTS.md 改动须三处同步更新。
