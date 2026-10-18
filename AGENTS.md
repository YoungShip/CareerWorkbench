# 秋招工作区说明

本文件是给 AI 的现行规则。路径相对工作区根 `resume/`。

- **本机配置**：路径、端口、浏览器 profile 和自动备份都在 `CareerWorkbench/references/local-setup.md`。用到这些之前先读它。
- **新环境接入**：仓库布局、初始化、主表恢复，以及不同环境能做什么，见 `CareerWorkbench/references/new-environment.md`。
- **三份同步**：本文件与 `resume/AGENTS.md`、`lapis-cv/AGENTS.md` 保持相同，同步方式见第 13 条。

## 项目身份

CareerWorkbench（求职工作台）源于本人提出的找岗位、填网申和投递记录需求；Skill 文本和 Agent 技术方案主要由 AI 生成。2026-10-18 本人确认并不掌握底层 Agent/RAG 实现，不以源码存在证明独立研发。简历正文由本人指定的简历助手修改。

## 现行口径

- **工作流冻结**（2026-10-09 本人决定，专心投递；2026-10-18 按本人要求精简过一次）：除非流程出 bug 或挡住投递，不再改 CareerWorkbench 和 lapis-cv 的工作流、规则和工具；改进想法记进 `CareerWorkbench/references/project-backlog.md`，秋招结束后再评估。修 bug 只做最小改动。
- **投递主数据**：私有仓库 yxp-cv（本机文件夹 lapis-cv）`tracker/` 下的八份 CSV 是唯一投递主数据，云端和本机都可读写。只通过 tracker-cli 或本地看板读写：它们在专用 worktree `CareerWorkbench/data/private/tracker-worktree` 里读前拉取、写后提交并推送 main；推送冲突时本次写入撤回，按最新主表重新 preview → apply。不要直接改 `lapis-cv/tracker/`。旧 Excel 内容在 job_pool 的 `legacy_record` 字段。
- **唯一简历**（2026-10-18 本人确认）：所有新申请统一用母表 `附件.简历_唯一` 指向的 lapis-cv 根目录 PDF，源稿 `lapis-cv/简历.md`。原 A/B/C 等版本全部停用，不按岗位方向或企业性质换 PDF。已投递的文件名、附件快照和申请日志是历史事实，不改。
- **资料更新闭环**：新增或修改简历项目，必须同步母表的结构化项目及对应网申文本组，运行 `lapis-cv/scripts/generate_application_materials.py`，再通过 `jobmatch check-materials`；不能只改 PDF 或自我介绍。资料未同步时，匹配要停下并提示修复。旧匹配结果按冻结时的证据版本复核。
- **OfferNotes 已停用**：主表即最终记录，`sync_queue` 表和 `offernotes_id` 列只是历史数据。不再打开、登录或修改 OfferNotes。

## 0. 硬触发：涉及浏览器或网页时，先读技能

网申站点或任何要打开、操作网页的任务，第一步固定读 `.agents/skills/job-application-form-filling/SKILL.md`，**先于**探测端口、启动进程或宣称能力边界。浏览器通道按第 7 条选择，提交边界见第 8 条。

## 1–6. 基本规则

1. 公司调研、选岗、核额度和投递记录维护使用 campus-recruitment：保留求职档案、全量目录、完整 JD、matching.json 及 verify 校验。
2. 主表读写前先读 [主表协议](references/local-tracker.md)，命令和参数以协议为准。要点：
   - **会话先看行动摘要** `brief`，未研究的线索看 `discovery/cli.js next`。摘要不是投递授权；文本里提取的截止时间只是待确认信号，必须回官方来源核实。
   - **常规查询用 `query`**，按 `job_id`、公司和字段过滤，不要把八张表和全部 JD 灌进上下文。未返回的字段不等于空值，缺事实时补读，不猜测、不清空。
   - **全量审计、异常恢复和 apply 前审计用 `snapshot`。**
   - **写入**按稳定的 `job_id`，带最新整体 `expected_revision`，保持 `preview → apply → 读回`，读回要显式包含本次改动的字段和关联事件。冲突就重读、重新预览，不自动覆盖，不直接改 CSV。
3. 选岗规则、经历边界和公司去重索引的唯一来源是 `lapis-cv/秋招/求职档案.md`；个人资料以 `网申档案.json` 为准。公司研究先用 `node CareerWorkbench/dashboard/tracker-cli.js rules` 提取当前规则，再按公司或岗位读索引和证据。缺个人字段时按需读母表。
4. 新研究的岗位经本人选定才登记为待投；实际提交、对外消息和订阅按本人的明确指令执行。已授权过的同一动作不必重复确认。
5. 本地写入读回验证即完成登记。
6. CareerWorkbench 是允许维护的项目；其他项目的源码只在核对经历证据时查阅，不在这里改动。

## 7. 浏览器通道优先级

依次使用：① 用户日常 Chrome 中已授权的插件连接；② 当前客户端的内置浏览器；③ **Playwright + 专用持久化 Chrome profile**（网申、登录后页面、简历上传、解析纠错、字段填写和完整读回）。

- 前一级能可靠完成并读回时，不启用后一级。
- ③ 用非默认 profile；不复制用户默认 Chrome，禁止对它开 remote debugging，也不用 Raw CDP 直连作为网申通道。
- 端口没在监听只说明专用 Chrome 没启动，不代表登录失效。登录态是否有效必须打开目标页面实际核验。
- agent-browser 没有登录态，不作为需要登录的网申通道。
- **①/② 控件可达性必须实测**：无障碍树不暴露的自定义控件（如北森 zhiye 的"立即投递"DIV）拿不到 ref。已知这类站点直接用 ③。

## 8. 网申边界

- **常规阅读确认自动处理**：已授权的公司网申中，普通的"我已阅读"、简历维护须知以及同一求职目的的隐私声明，由 AI 阅读后直接确认。实际投递仍按对应岗位的提交授权；未知的个人事实不编造。
- **③ 的操作方式**：Playwright 拒绝点击被固定页头或页脚遮挡的元素时，改用精确的语义元素或组件级方法，禁止盲目坐标连点。任何强制或脚本事件操作之后都必须读回。
- **登录/注册**：新站点注册、短信验证码、微信扫码、滑块、CAPTCHA、Cloudflare、账号选择等由本人处理，完成后 AI 从当前页继续；不索要密码、验证码或 Cookie。
- **失败接管**：单个控件最多三层策略：语义 locator 或真实选项 → 组件特定方法或键盘 → 状态可恢复时一次安全重入。仍失败就标记 `needs-human` 交给本人。刷新或重入前，先判断内容是否已在服务端保存。
- **最终提交授权与浏览器通道分开**：
  - 默认 `review`：填完并全量审计后，停在最终按钮前。
  - `preauthorized`：本人事先明确批准了具体岗位或一批岗位，审计无错误，岗位、简历、额度和高影响答案都已核实，才可直接提交。
  - `autonomous`：只有本人另外明确给出范围、筛选规则和提交授权才启用。
  - 任何模式下遇到验证码、未知的高影响问题、额度或志愿冲突、不可逆弹窗，都交本人。
- **成功判定**：点击最终按钮不等于 Submitted，只有成功页、账号应聘记录、确认邮件或本人确认才算。拿到证据后：
  1. 先落盘私有材料快照（materials / field-audit / submission-evidence / official-jd），直接执行，不必询问。
  2. 再按主表协议登记 Submitted，追加申请日志并读回。
  3. 主动向本人交付**全字段提交内容清单**（敏感信息打码，写明未填项原因和偏差修正）。本人指出偏差时，修正回写到工作流的信息层。

## 9. 会话摘要与自动备份

- 每个新会话先运行 `node CareerWorkbench/dashboard/tracker-cli.js brief`；有已过期或 72 小时内到期的事项时主动列出。摘要只读，不发通知。
- 提醒交由 Muse 和 Hark（2026-10-13 本人决定）。不重建 Server酱推送、桌面弹窗或其他外部提醒。
- Windows 备份任务每日 20:00 和登录时运行 `scripts/backup-tracker.js --push`，配置见 `references/local-setup.md`。
- 本人确认"没做"的过期事项，按主表协议登记事实，不登记为完成。
- 凭据不得提交到版本库，不得出现在对外消息或截图中。

## 10–12. 规则分层、站点经验与面试

10. **现行规则优先**：`brief.policy.status` 不是 current 时，先按求职档案核对规则并更新私有的派生筛查配置；不能把失效配置下的空清单说成"没有冲突"。旧 Pending 命中新规则时只提请本人复核，不自动取消、改评级或提交；已投的事实不回滚。
11. **站点经验**：操作表单前先读通用 Skill，再读 `CareerWorkbench/references/site-knowledge-overlay.md` 并运行 `node CareerWorkbench/scripts/site-knowledge-status.js`。
    - 只有 `fresh + verified` 的条目能直接用；`stale`、`candidate`、`historical` 要现场复核。
    - 新观察先记为 candidate，拿到页面读回或服务端证据后才升为 verified。
    - 限定于租户、批次或账号的经验不推广成整个 ATS 家族的规则；只有去除个人信息、在多个独立站点验证过的控件级规律才进公共 Skill。
12. **面试准备**：先读具体岗位、`lapis-cv/秋招/` 下的面试口径备忘和 `CareerWorkbench/references/interview-proof-checklist.md`。围绕已证实的项目练习讲解和排错；不为迎合 JD 新增成果，不把 AI 辅助写的代码说成独立手写。

## 13. 仓库同步

- **开工同步**：每次会话开始（在本机，或经 RDC 操作本机时），对 CareerWorkbench 和 lapis-cv 各执行 `git fetch origin main` 和 `git status -sb`：
  - 没有未提交的改动、也没有未推送的提交时，执行 `git pull --ff-only origin main`。
  - 有未提交的改动、有未推送的提交，或者快进失败时，不拉取、不合并、不覆盖，只向本人报告是哪个仓库、哪些文件。
  - 然后在 CareerWorkbench 运行 `npm run skills:check`，技能或三份 AGENTS.md 不一致时先报告。
- **及时提交**：经本人确认的工作流改动，在当次会话结束前 `git add <具体文件> → commit → push origin main`。
- **红线**：
  - gitignore 排除的私有数据（`data/*`、`dashboard/*.csv`、`.store`、`tmp`、`logs`、`私密信息.json` 等）永不提交到 CareerWorkbench。主表由 tracker-cli 在 yxp-cv 里自动提交，不手工提交 `tracker/`。
  - 每日备份把八份 CSV 快照到私有 `lapis-cv/tracker-backup/`，把 `data/private` 的证据镜像到 `lapis-cv/private-evidence/`，把只在本机的工作资料镜像到 `lapis-cv/local-backup/`（细节见本机配置）。这些目录只能留在私有仓库。
  - 推送前扫描 diff，确认不含证件号、测评专属链接和凭据。
  - lapis-cv 里的简历 PDF、求职档案等个人材料是否入库，由本人逐项决定。
- **技能两处一致**：在 `.agents/skills` 改了技能，当次会话内 `npm run skills:capture` 收回 `CareerWorkbench/skills/` 并提交。CareerWorkbench 是**公开仓库**，提交前按第 11 条检查，个人信息和租户/批次/账号限定的经验只留在本地覆盖层。
- **三份 AGENTS.md**：以 CareerWorkbench 仓库这份为同步源，改动三处同步。`npm run skills:check` 会报出不一致的副本。
- **合并授权**：AI 判断可以合并时直接推送 `main`：小改动本地检查通过后（`npm run format:check`、`npm test`，涉及 agent/ 时加 pytest）直接推；改动大或有本地跑不到的 CI 环节时走分支 + PR，CI 通过后自行合并。强推、改写历史、删除分支或数据、涉及提交授权和对外消息的规则改动、个人材料入库，仍须先问本人。

## 14. 远程操控本机（RDC）

云端会话可以通过 Remote Desktop Commander 操作本机，设备见本机配置。代码和工作流改动在云端完成和测试；RDC 负责快进拉取、同步仓库外的文件（如 `resume/AGENTS.md`）、安装锁定依赖、本机测试和只读检查，以及只在本机出现的问题。

- RDC 只是通道，不扩大授权：经 RDC 读写投递数据或执行网申时，照样遵守第 0–9 条。
- 本机仓库有未提交的改动或未推送的提交时，不覆盖、不推送，先向本人说明。
