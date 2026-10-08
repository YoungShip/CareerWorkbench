# Data acquisition: capability-first routing

目录获取的目标是“官方范围内的全量岗位 + 可复现快照”，不是得到几个看起来相关的标题。工具选择按当前可用能力和站点特征决定，不按产品名称硬编码。

## Valid result

只有同时满足以下条件，才可把目录称为全量：

- 官方显示总数与收集条数一致；
- 已翻到最后一页或 API 分页已穷尽；
- 原始 HTML/JSON/API 响应已落盘；
- 每个岗位有稳定 ID、标题、地点、详情 URL 或明确缺失标记；
- 记录了届别、校招性质和过滤范围；
- 若使用关键词，报告明确标为“非全量”。

写入 schema v2 时，`raw_catalog` 必须显式声明 `format` 和岗位 ID 提取方式：JSON 使用 `records_path` + `id_path`，CSV/TSV 使用 `id_column`。提取不到稳定 ID 就标记覆盖待核验，不退回到标题模糊匹配。

## Acquisition layers

### Layer 1: public API or embedded data

适用于 SPA 或目录数据已由前端请求取得的站点。

1. 保存入口 HTML 和相关 JavaScript 产物。
2. 从网络请求或代码中确认列表、详情、规则和字典端点。
3. 先尝试公开参数变体（例如招聘类型、批次、语言或分页参数），不要把一次空响应当作“没有数据”。
4. 拉取所有页并保存原始响应；详情中有二级岗位方向时逐个展开。
5. 对照分页元数据和实际唯一 ID 数量。

不猜接口参数的含义；每个参数的作用以响应结构或页面证据确认。

### Layer 1.5: known ATS template

Moka、飞书招聘、Zhiye 等模板可以复用端点形状和字段解析，但仍要确认当前组织、批次和字段名称。模板经验不能替代当次快照。

CareerWorkbench 自带两个模板的只读抓取工具，输出可直接作为 matching v2 的 `raw_catalog`：

```bash
node discovery/fetch-catalog.js zhiye <org>.zhiye.com <研究目录> [--category 2]
node discovery/fetch-catalog.js feishu https://<org>.jobs.feishu.cn/<路径>/ <研究目录>
```

- 生成 `raw/page-NNN.json`（逐页原文）、`raw/api-catalog.json`（`records_path=/items`，`id_path` 北森为 `/JobAdId`、飞书为 `/id`）、`jd/<岗位ID>.txt`（JD 文本快照）和 `catalog-summary.json`（不含 JD 正文的岗位清单，用于划定研究范围）。
- 收集数与接口总数不一致或岗位 ID 重复时直接报错，不写文件。
- 北森 `Category` 的含义因组织而异（常见 2=校招），以返回岗位的届别字样核对；飞书要在页面内调用接口（带会话签名），需要 Playwright：优先 `playwright`/`playwright-core` 模块，其次本地 `data/private/playwright-application/runtime`；浏览器取 `JOBHUNT_CHROMIUM`，否则用系统 Chrome。
- Moka 的列表接口返回加密数据，工具不支持，改走 Layer 2/3。

### Layer 2: rendered page automation

适用于 API 难以复用、页面有动态分页或需要真实交互的站点。逐页收集岗位链接和可见信息，等待页面完成渲染，记录失败页而不是静默跳过。页面登录墙出现时区分“目录公开不可读”和“账号专属信息需登录”。

### Layer 3: authenticated in-session browser

用于确认届别横幅、规则、个别详情或交叉核对。先读取当前浏览器工具文档，使用可用的页面级 API；AX/DOM 文本比截图更适合结构化记录。需要登录、短信、验证码或用户账户操作时交给用户。

### Layer 4: search engine fallback

只用于定位官方入口或发现可能漏掉的品牌入口。找到入口后必须回到官方页面/API核实 JD 和规则。

## Evidence quality

- 动态岗位详情不只读取 body.innerText。JD 若位于可见的只读 input/textarea 中，读取对应业务字段的实际 value，并保留原页面、字段定位和提取方式；职位描述标题、公司介绍或加载占位内容不能当完整 JD。正文非空后核对岗位稳定 ID 与标题，不用另一岗位的已加载字段值补齐。

- 官方页面、官方 API 和官方附件是第一证据。
- 第三方转载可帮助发现入口或确认公告存在，但不能冒充官方原文；日期、额度和硬门槛必须回到官方核对。
- 相互矛盾的官方文字保留两条原文并标记待核，不擅自取其一。
- 页面只有月粒度时，不将其扩写成日级日期。

## Failure handling

按站点和 URL 记录工具、时间、实际 URL、错误类型、重试次数和切换理由。连续失败达到预设上限后切换到下一层；没有有效来源时停止该范围，报告已读范围和缺口，不宣称全量。

## Snapshot layout

每次研究建立独立目录，放在不会被自动清理的私有位置（如私有资料仓库里的 `<公司>-<招聘批次>-<日期>/`），不要放在项目的 `tmp/` 下：登记时会拒绝 `tmp/` 里的 matching 文件。目录内建议结构：

```text
research/<company-key>-<run-id>/
├── official-entry.html
├── api-catalog.json
├── api-rules.json
├── position-details/
├── matching.json
└── verification.json
```

目录名和文件内容不得包含候选人敏感字段；真实快照放在私有目录并由版本控制排除。

`coverage.capture_status` 区分 `complete`/`partial`/`unknown`；即使 ID 和数量与快照一致，也只能证明与该快照一致，不能自动证明官网已经抓全。完整声明需要官方总数、最后一页/API 穷尽证据和人工确认。
