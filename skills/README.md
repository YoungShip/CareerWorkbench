# Skills

两个求职工作流 Skill 的版本源，运行位置是工作区根的 `.agents/skills/`：

- `campus-recruitment/`：公司研究、全量岗位获取、JD 匹配、选岗与投递表登记。
- `job-application-form-filling/`：网申表单填写、上传、读回审计与站点经验。

这里只放通用流程、控件经验、数据契约和校验脚本，不放候选人简历、联系方式、真实投递记录、账号或凭据。本仓库公开，每次提交都可见。

## 同步

在 CareerWorkbench 根目录：

- `npm run skills:check`：核对两处是否一致（也会检查三份 AGENTS.md）。
- `npm run skills:capture`：把 `.agents/skills` 里的改动收回这里。
- `npm run skills:install`：把这里的版本装到 `.agents/skills`。

## 提交前检查

CI 每次都会跑；手动运行在仓库根目录执行：

```sh
for d in skills schemas; do python3 -X utf8 scripts/public-safety-check.py "$d"; done
python3 -X utf8 scripts/validate-skill-structure.py .
```

通过只说明没有命中常见个人信息或凭据模式、结构引用完整，不代替人工检查。

> 原独立仓库 job-application-workflow-skills 已于 2026-10-07 并入这里并归档。
