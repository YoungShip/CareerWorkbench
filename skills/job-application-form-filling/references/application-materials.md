# Application materials and retention

本文件描述材料管理，不保存任何候选人的实际资料。

## Select materials by JD

先读官方完整 JD，再从候选人已证实的教育、实习、项目和技能中选择与岗位相关的组合。通常突出少量最相关经历，但表单要求完整履历时必须完整填写。每次申请记录经历、对应 JD 要求、事实来源和不能扩大的表述边界。

## Private application snapshot

每个申请以稳定 `job_id` 建立私有目录，例如：

```text
private/applications/<job_id>/<run-id>/
├── materials.json
├── official-jd.txt
├── answers.txt
├── field-audit.json
└── submission-evidence.json
```

真实路径必须被版本控制排除。准备稿标记 `draft/pending`; 最终读回字段标记 `filled`; 成功页面、账号记录、确认邮件或用户明确确认才标记 `submitted`。

保留实际上传文件名、版本和 SHA-256；自定义问题保存真实填写原文。官方 JD 保存 URL、获取时间、版本和完整正文。拿不到原文时明确缺失，不用相邻岗位替代。

## What never goes into a snapshot

不保存密码、验证码、cookie、认证 token、完整浏览器会话或不必要的证件号码。敏感字段审计只保存字段名和匹配结果。私人材料不写入通用站点知识库，也不发送到在线进度视图。

## Post-submission handoff

成功提交后，由投递主表适配器追加申请日志：简历版本、材料快照引用、实际选用经历、官方 JD、实际提交日期和至少一项真实凭据。补档必须标记为“补档/核对，非再次投递”，不能制造新的提交事实。


## 简历修改后的材料一致性

使用候选人当前母表的结构化项目清单选择表单经历；简历里出现的新项目必须同时存在于母表及可用分栏材料，不能只更新自我介绍。项目标题可简写，但应通过明确名称/别名或稳定 ID 对应，缺项先补齐资料再填写。

已配置 CareerWorkbench 的工作区可运行 jobmatch check-materials，检查简历、母表、生成回答和附件是否同期；未配置时按这些关系手工核对。未知日期、团队人数等按未提供处理，不为通过检查填造事实。
