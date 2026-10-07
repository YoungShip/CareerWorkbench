# ATS family knowledge

跨站点复用的重点是组件和数据流，不是把某个公司的选择器复制到另一个站点。旧观察按其记录范围使用，改版后必须重新验证。

## Identification

结合域名、页面 footer、DOM 类名、上传组件、网络请求路径和表单结构判断家族：

- `*.jobs.feishu.cn` 或相似自定义域名：飞书招聘；
- `app.mokahr.com/campus-recruitment/...`：Moka/SugarDesign；
- `*.zhiye.com`：Zhiye/Phoenix；
- `nowcoder.com` 或企业自定义牛客域名：Nowcoder；
- 其他域名：按公司自研表单处理，不能强行套家族选择器。

## Canonical data model

无论站点如何命名，表单最终映射到一套候选人资料：

```text
basic: name, gender, birthdate, city, nativePlace, phone, email, expectedGraduation
education[]: school, start, end, major, degree, fullTime, lab, research
work[]: company, start, end, title, description
projects[]: name, start, end, role, description, link
language[]: type, proficiency
attachments: resumeA, resumeC, other approved versions
preferences: city, salary, interview, availability
```

真实值来自本地档案；这个模型不应被当作公共个人资料库。

## Reusable family notes

### Feishu-style forms

- 登录常见手机号、滑块和短信验证码；验证码/滑块由用户处理。
- 常见自定义表单项（例如 `ud__`、`.ud-formily-item`）和月粒度日期控件；教育年份、项目日期、角色和描述容易在简历解析后错位。
- 解析后优先检查所有 textarea、教育时间和项目链接，不要只看首屏。
- 同一账号的后续岗位是否复用资料必须按当前站点实测；不要默认复用或默认清空。

### Moka/SugarDesign

- 常见字段容器带 `sd-`、`apply-field`/`apply-block` 特征，字段类型可能包含字符串、select、日期、地点和多记录区块；下拉显示值可能在展示 span 中，input.value 为空。
- 受控文本组件有时需要真实 focus、全选和输入事件，单纯改 DOM value 可能不落库。
- 教育/实习/项目日期常为年/月下拉；出生日期可能是只读输入+日历弹层，必要时交给用户手点。
- 籍贯/地区 tag-input、内层滚动容器和 React 按钮是常见坑位；必须以视觉/DOM 读回为准。
- 未提交前的跨岗位资料复用不能假定成立。

### Zhiye/Phoenix-style forms

- 常见四步：基本信息、履历、附件、预览/提交；路由可能经过 `ResumeImport` → `ResumeItem`，教育、实习和项目可能在弹窗中逐条添加。
- 原生 select、jQuery/自定义弹窗并存；修改后需触发页面的 change/blur 校验。
- 手机号、邮箱等字段可能被异步脚本清空，写入后应立即读回。
- 提交前真实性声明、验证码和最终按钮属于外部副作用边界。

### Company-built forms

先建立字段标签→元素映射，再判断控件类型。优先使用语义选择器和可见文本，不把一个站点的索引顺序移植到另一个站点。

## Update rule

新站点先记实际观察和验证范围；跨站点或多次独立验证后，才把共性提炼到本文件。站点特有选择器留在 `site-knowledge.md`。
