# 新环境与新 AI 工具接入

给第一次接手这套秋招工作流的 AI 工具或新电脑看。先读根目录 `AGENTS.md`，再按这里搭环境。

## 仓库与目录

三个仓库都在 YoungShip 账号下，克隆到同一个工作区根目录 `resume/` 里：

| 仓库 | 可见性 | 放在 | 内容 |
|---|---|---|---|
| `YoungShip/CareerWorkbench` | 公开 | `resume/CareerWorkbench` | 工作流代码、规则、三个技能的版本源 `skills/` |
| `YoungShip/yxp-cv`（原 lapis-cv，2026-10-09 改名） | 私有 | `resume/lapis-cv` | 简历、网申母表、求职档案、公司调研、主表每日备份 `tracker-backup/` |
| `YoungShip/job-application-workflow-skills` | 公开，已归档 | 不需要克隆 | 旧的技能独立仓库，2026-10-07 并入 CareerWorkbench |

```sh
mkdir resume && cd resume
git clone https://github.com/YoungShip/CareerWorkbench.git
git clone https://github.com/YoungShip/yxp-cv.git lapis-cv
cp CareerWorkbench/AGENTS.md AGENTS.md          # 工作区根的规则副本
cd CareerWorkbench
npm ci
npm run skills:install                          # 把 skills/ 装到 resume/.agents/skills
cd agent && uv sync --frozen && cd ..
npm test                                        # 应全部通过
```

`.agents/skills` 是各 AI 客户端加载技能的位置；仓库里的 `skills/` 是版本源，两处用 `npm run skills:check` 核对。

## 恢复投递主表

主表（`CareerWorkbench/dashboard/` 下八份 CSV）只在作者电脑上维护，不进 CareerWorkbench。新环境需要时从 lapis-cv 的每日备份恢复：

```sh
cp ../lapis-cv/tracker-backup/*.csv dashboard/
node dashboard/tracker-cli.js validate
node dashboard/tracker-cli.js brief
```

备份里测评/笔试/面试链接、密码和验证码、考试账号与简历/申请编号、手机号、个人邮箱和身份证号已打码（显示为 `REDACTED` 或 `***`），需要时从原始邮件或招聘系统取回。作者电脑上的主表仍是唯一主数据：两边同时写入会产生分叉，新环境只用于查看或在作者电脑不可用时接替。

## 在不同环境能做什么

| 事情 | 只连 GitHub 的云端 AI | 作者电脑（或经 RDC 操作作者电脑） |
|---|---|---|
| 读规则、选岗规则、母表、简历、历史调研 | 能 | 能 |
| 公司调研、逐岗匹配、改简历措辞、改代码 | 能 | 能 |
| 查看投递进度 | 能，读 `tracker-backup/`（最多晚一天） | 能，读实时主表 |
| 写入主表（登记投递、更新阶段） | 不建议，会和作者电脑分叉 | 能 |
| 网申填写与提交 | 不能：登录态在作者电脑的专用浏览器 profile 里 | 能，按 AGENTS.md 第 0、7、8 条 |
| 到期提醒、主表备份 | 不能：依赖 Windows 计划任务 | 自动运行 |

云端会话通过 Remote Desktop Commander 操作作者电脑的规则见 AGENTS.md 第 14 条，本机路径、端口和设备见 [local-setup.md](local-setup.md)。

## 只连 GitHub 的云端会话

**先确认能读私有仓库。** 工具的 GitHub 授权必须包含 `YoungShip/yxp-cv`（原 lapis-cv）：GitHub App 安装时选中这个仓库，或者 OAuth 授权允许访问私有仓库。只能读公开仓库的工具只能改 CareerWorkbench 的代码，做不了秋招业务。有的工具会把访问 GitHub 的请求一律改走它自己的授权，给它个人访问令牌也没用（2026-10 试过 Hark）。这类工具只安排公开仓库的事，不要为了它把 lapis-cv 改成公开：仓库里有家人信息、住址和未用的测评链接，公开后收不回来。Claude Code 云端会话里，lapis-cv 要么事先加进环境的仓库来源，要么由本人在对话中要求添加并批准；由定时任务或自动通知发起的会话没有本人确认，添加私有仓库会被拒绝，这时不要换别的办法绕过，停下来说明需要本人授权。

**搭环境。** 两个仓库克隆到同一个父目录（相当于 `resume/`），按上面的命令安装。Python 测试在仓库根目录运行 `uv run --project agent pytest agent/tests`。要看投递进度时，按上一节从 `tracker-backup/` 恢复主表。

**本机路径换算。** `求职档案.md`、`tracker-cli.js rules` 的输出等处的链接写的是本机绝对路径。把开头的 `D:/AppData/Documents/resume/` 换成云端的工作区根即可，例如 `D:/AppData/Documents/resume/lapis-cv/秋招/X.md` 对应 `<工作区根>/lapis-cv/秋招/X.md`。指向 `CareerWorkbench/tmp/`、`data/private/` 的链接在云端不存在。

**AGENTS.md 规则在云端的适用范围：**

| 规则 | 云端 |
|---|---|
| 第 1、3、4、6、10、12 条 | 照常适用 |
| 第 2 条主表 | 只读：从备份恢复后只用 `brief`、`query`、`rules`、`validate`，不 `apply` |
| 第 5 条 | 公司调研占用表照常认领 |
| 第 9 条到期提醒 | 只做第 ① 项：用恢复的主表跑 `brief`，说明数据最多晚一天 |
| 第 11 条站点经验 | 本地观察在 `data/private/site-knowledge/`，不入库，云端读不到；只用技能里的通用 `site-knowledge.md`，抓目录时按现场页面核实 |
| 第 13 条仓库同步 | 适用；调研产物见下 |
| 第 0、7、8、14 条，`local-setup.md` | 不适用：依赖作者电脑的浏览器登录态或本机 |

**选公司前先测官网可达性。** 云端出站受环境网络策略限制，部分官网和招聘门户连不上（2026-10-08 试跑时交通银行、海康威视招聘站不可达）。选定公司前先 `curl -sS -o /dev/null -w "%{http_code}" -L <官网>` 确认能打开；连不上的换一家，或留给作者电脑处理，不用第三方转载代替官方 JD。

**云端浏览器抓取。** 容器里有无头 Chromium 和全局安装的 Playwright（`NODE_PATH=$(npm root -g)`，启动时传 `executablePath: '/opt/pw-browsers/chromium'`，不要运行 `playwright install`）。只用于读公开目录和 JD，不登录。接口带签名或 CSRF 的门户（如飞书招聘的 `_signature`、`x-csrf-token`），先打开列表页捕获前端发出的真实请求，再在同一页面里用 `fetch` 复用这些请求头翻页，不要猜参数。

**调研产物放哪里。** 报告沿用 `lapis-cv/秋招/<日期>-<公司>岗位比较.md`；原始目录、JD 快照、候选人证据、matching 和 pipeline 输出放在 `lapis-cv/秋招/<公司>-2027校招-<日期>/`。云端本地目录在会话结束后会消失，所以都要提交。提交到新分支并开 PR，经本人或 AI 审核后合并；同时更新 `公司调研占用表.md`。

**逐岗匹配没有模型密钥时。** `jobmatch research` 需要私有的模型配置，云端通常没有。这时由当前 AI 按 [matching-record.md](../skills/campus-recruitment/references/matching-record.md) 直接写 raw 记录，原样保存后运行 `python skills/campus-recruitment/scripts/run-matching-pipeline.py --raw <raw.json> --run-dir <目录>/pipeline`，结果同样以 `checks` 和 `readiness` 为准。`coverage.human_attested` 留给本人确认，流程见 matching-record.md 第 1 节。

**资料检查。** `jobmatch check-materials` 比较生成核验清单的哈希时不区分 CRLF 和 LF，云端检出不会被误报为过期。`lapis-cv/scripts/generate_application_materials.py` 在云端也能运行：缺少 `私密信息.json` 时改为按号码格式扫描输出里的身份证号。
