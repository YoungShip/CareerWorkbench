# 站点经验的本地覆盖层

阿里2027校招内置浏览器窄视口导航实测：`CareerWorkbench/data/private/site-knowledge/alibaba-iab-overlay-20261005.md`，仅验证招聘助手浮层收起和个人中心简历导航；不包含资料保存、解析落库、志愿创建或提交结论。

通用文件：`.agents/skills/job-application-form-filling/references/site-knowledge.md`。
浪潮 HCM Cloud 本地实测：`CareerWorkbench/data/private/site-knowledge/inspur-hcmcloud-20261001.md`，覆盖公开目录、完整 JD、共享简历逐段读回，以及 2027 校招选择制投递、站点选择和 A 版 PDF 解析的真实副作用。该站点的“确认投递”会直接生成志愿和投递记录；“上传并解析”会覆盖已填的共享资料，须先解析并完成全字段审计，再触发投递。具体额度、顺序和字段行为只适用于该账号及批次，每次仍按现场页面复核。
本地历史观察：`CareerWorkbench/data/private/site-knowledge/neuehct-atsx-20260919.md`；小米 Playwright 实测：`CareerWorkbench/data/private/site-knowledge/xiaomi-feishu-playwright-20260921.md`；国聘/中国联通实测：`CareerWorkbench/data/private/site-knowledge/iguopin-unicom-20260922.md`；哈啰/北森zhiye Playwright 实测（含 Phoenix 控件交互、验证码门、共享简历带入）：`CareerWorkbench/data/private/site-knowledge/hellobike-zhiye-20260923.md`；OPPO 校招本地观察（candidate）：`CareerWorkbench/data/private/site-knowledge/oppo-campus-20260922.md`；普源精电/飞书 ATS-X 只读目录抓取观察（candidate）：`CareerWorkbench/data/private/site-knowledge/rigol-feishu-atsx-20260923.md`；中广核/大易 hotjob 项目级一次投递模型与 DWR 分节保存观察（candidate）：`CareerWorkbench/data/private/site-knowledge/cgn-hotjob-20260923.md`。

先确认公司、门户、账号范围、招聘批次和当前页面特征，再决定该观察是否适用；不匹配时不加载为执行规则。账号、验证码与凭据不记录在经验文件。

本地观察中“9次成功”“只需填两项”等只属于当次验证。额度未知不等于无限，材料复用不等于每字段正确；逐岗位核验和用户授权边界始终保留。通用文件存控件识别/读回方法，个性经验保存在 private 层，不通过同步仓库覆盖它。

新增条目使用机器可读元数据：`knowledge_status: candidate|verified|historical`；verified 必须同时写 `last_verified: YYYY-MM-DD` 与正整数 `stale_after_days`。运行 `node CareerWorkbench/scripts/site-knowledge-status.js` 检查状态；`stale`、`candidate`、`historical` 只能作为排查线索，不能直接作为执行规则，必须在当前站点重新核验。

自进化闭环为：真实失败/新控件 → `candidate` → 当前页面成功读回或服务端证据验证 → `verified` → 到期自动降为 `stale` 等待复核。租户/批次/账号规则始终留在 private 层；只有去除个人信息后、跨独立站点重复验证的控件级规律才允许晋级公共 Skill。一次性坐标、猜测、仅 HTTP 200 或仅 UI 显示不得晋级。
