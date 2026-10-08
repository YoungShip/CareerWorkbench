# 三个求职工作流 Skill

> 原独立仓库 [job-application-workflow-skills](https://github.com/YoungShip/job-application-workflow-skills) 已于 2026-10-07 并入这里并归档；历史版本仍可在原仓库查看。

一套可迁移的求职工作流 Skill：

`公司研究与岗位匹配 → 本地投递表登记 → 网申表单填写与审计 → 按授权模式提交 → 凭据登记 → 在线进度同步 → 写后核验`

本目录及配套材料只包含通用流程、控件经验、数据契约和校验脚本，不包含任何候选人的简历、联系方式、真实投递记录、账号信息、浏览器配置或认证凭据。

## 包含内容

路径相对 CareerWorkbench 仓库根目录：

```text
skills/
├── campus-recruitment/              公司研究、全量岗位获取、JD 匹配、选岗与投递表登记
└── job-application-form-filling/    ATS/网申表单填写、上传、读回审计与站点经验
docs/skills/
├── workflow.md                      跨 Skill 的端到端工作流
├── privacy.md                       脱敏、权限与凭据边界
├── migration.md                     旧 matching 记录与调用方迁移说明
├── model-routing.md                 可选的模型分工建议
└── test-plan.md                     发布前测试计划
schemas/                             脱敏示例、matching v2 schema 与接口形状
examples/vla-evidence/               VLA 训练/推理语义边界的虚构匹配示例
scripts/
├── public-safety-check.py           发布前个人信息/凭据痕迹扫描
├── validate-skill-structure.py      Skill frontmatter 与本地引用校验
└── skills-sync.js                   与本机运行位置 .agents/skills 的检查、收回与安装
```

## 安装为本地 Skills

将 `skills/` 下的三个目录复制到目标 Codex 的 skills 目录即可。三者建议一起安装，因为它们分别负责研究、填表和同步；单独使用时仍应保留相应的本地适配器和档案路径配置。

Windows 示例（把目标路径替换为实际 Codex skills 目录）：

```powershell
Copy-Item -Recurse -Force skills/campus-recruitment <skills-root>/campus-recruitment
Copy-Item -Recurse -Force skills/job-application-form-filling <skills-root>/job-application-form-filling
```

只复制 `skills/` 下的两个目录；`docs/skills/`、`schemas/` 和 `examples/` 是维护与验证材料，不是候选人资料。迁移现有旧记录前请先看 [docs/skills/migration.md](../docs/skills/migration.md)。在 CareerWorkbench 工作区内可直接用 `npm run skills:install` 安装到 `../.agents/skills`。

每次使用时只读取当前任务需要的参考资料：

- 公司研究/选岗：`campus-recruitment`
- 网申填写：`job-application-form-filling`

## 工作流边界

- 研究结论不能替代官方完整 JD；只看岗位标题不能算匹配完成。
- “已登记待投”不等于“已提交申请”。
- 最终提交与浏览器通道分离：默认 `review` 停在提交前；只有用户明确预授权具体岗位/批次，或另行定义受限的 `autonomous` 范围时，才可在完整审计后自动提交。
- 任何真实个人字段只从用户本地档案读取，不写入本目录。
- 主表通过 `snapshot → preview → apply → read-back` 事务接口更新，不直接编辑 CSV。
- Playwright + 非默认持久化 profile 可用于可靠的网申 UI 填写与读回。任何通道都不得用来绕过登录验证、验证码或既定提交授权。

## 发布前检查

CareerWorkbench 是公开仓库，`skills/` 的每次提交都公开可见。CI 每次都会运行下面的检查；手动运行时在仓库根目录执行：

```sh
for d in skills docs/skills schemas examples; do python3 -X utf8 scripts/public-safety-check.py "$d"; done
python3 -X utf8 scripts/validate-skill-structure.py .
python3 -X utf8 skills/campus-recruitment/scripts/verify-matching.py examples/vla-evidence/matching.json
```

检查通过只说明没有命中常见个人信息/凭据模式，且结构与离线交接契约成立，不代表人工审查或真实线上读回可以省略。可运行的虚构证据示例见 [examples/vla-evidence/matching.json](../examples/vla-evidence/matching.json)，完整说明见 [docs/skills/test-plan.md](../docs/skills/test-plan.md)。

## 许可

除非另有声明，流程文字和示例按仓库根目录的 MIT License 发布。使用者必须自行遵守目标招聘网站、浏览器工具和当地隐私/数据保护要求。
