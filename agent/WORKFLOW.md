# 日常研究流程接入

campus-recruitment 在已经配置本项目的工作区，默认把 A/B 入口中的逐项证据匹配交给 jobmatch research。纯进度维护和历史补档仍按原任务执行。公共 Skill 契约位于 campus-recruitment/references/agent-adapter.md。

## 职责

| 阶段 | 执行方 | 产物 |
|---|---|---|
| 官方目录、JD、批次与账号条件 | 执行研究任务的助手及 campus-recruitment | 官方快照、稳定岗位 ID、范围、来源观察 |
| 逐项证据匹配、受限纠错 | 本项目 Agent | 逐岗原始结果、引文与证据、缺口、trace |
| 公司级组装与结构校验 | 本项目调用原校验流水线 | assembled-matching.json、verification、human-summary.json |
| 语义和现行规则复核、呈现选项 | 执行研究任务的助手及 campus-recruitment | 研究报告及待核事实 |
| 选岗、登记、填写和提交 | 用户选择后按既有工作流 | 原事务及授权边界下的记录 |

## 调用与输入

在 agent 目录：

    uv run jobmatch research --request "<私有目录>/research-request.json"

默认使用已配置 provider 和 full 模式，也可显式指定 --provider cpa、--variant hybrid。不会自动选择模型账号或要求再次提供已存密钥。

输入最小形状（哈希占位值必须替换为实际文件字节 SHA-256）：

    {
      "schema_version": 1,
      "company": "公司完整主体",
      "scope": "本次明确的研究范围",
      "coverage": {
        "capture_status": "partial",
        "note": "仅获取本次明确范围，尚未确认全量"
      },
      "raw_catalog": {
        "file": "catalog.json",
        "sha256": "<64位文件哈希>",
        "format": "json",
        "records_path": "/records",
        "id_path": "/id",
        "total_positions": 1
      },
      "catalog_index": [
        {"id": "role-a", "title": "岗位名称", "city": "城市", "in_scope": true}
      ],
      "jd_sources": [
        {
          "position_id": "role-a",
          "file": "jd-a.txt",
          "sha256": "<64位文件哈希>",
          "url": "https://example.invalid/jobs/role-a",
          "read_at": "2026-09-29T10:00:00+08:00"
        }
      ]
    }

catalog.json 示例为 {"records":[{"id":"role-a"}]}。真实使用须保存官网原始响应和显式 ID 提取规则，不能以此示例构造“官网原始目录”。

全部原始目录 ID 都进入 catalog_index。范围外条目写 in_scope=false 和 exclusion，说明为什么不在本次范围；不把未研究写成不匹配。本次范围内每岗恰有一份 JD，单批 1–20 岗。

可选 observations 记录官方条件观察，每项含 topic、position_ids、text、source 和 quote。source 具有 file、sha256、url、read_at。topic 可取 cohort/employment_type/city/open_status/application_limit/preference_order/change_or_withdraw/deadline/interview_format。未提供的主题保持 unknown；引文与快照相符也不等于适用于当前用户账号。

## 读回与失败

结果目录含：

- research-request.json、inputs/：请求及冻结的目录、JD、观察快照。
- current-rules.json：本次动态读取的规则，读取成功不代表已经完成规则审阅。
- jobs/job-NNN/attempt-NNN/：独立单岗运行，保留每次成功、失败和中断。
- company-matching-raw.json、pipeline/：公司原始记录与原校验器生成的最终记录。
- workflow-result.json、research-report.md：状态、已核实范围、等级/证据区间、引用、缺口及交回清单。

目录身份、哈希或引文错误发生在模型调用前。模型或校验失败的岗位继续列在 job-results.json 中；公司级校验会显式发现范围内缺失岗位，禁止静默删岗或将失败改成不适合。

coverage 原样保留。即使所有提供的岗位都匹配成功，也不会自动变成 complete 或 human_attested。抓取时间与处理时间分开保存，避免给旧快照“刷新日期”。

中断后使用 jobmatch resume --run-dir 原目录。恢复仍使用开始时冻结的规则、JD和候选证据，不重新读取母表；真正选岗前另核对现行条件。再次生成的匹配记录/报告使用新编号，workflow-result.json指向当前版本；不能硬编码总是读取第一个pipeline目录。详见 [恢复说明](RECOVERY.md)。

公司记录省略 selected_position_id；流程完成和机械通过均不等于用户选择或可投递。用户已明确选择后，才在新版本中传入稳定岗位 ID，重跑正式校验并沿用 tracker 的 preview → apply → read-back 及 OfferNotes 同步。

## 验证范围

隔离测试覆盖全目录身份传递、完整声明保留但不自动选岗、部分覆盖不升级、JD 改动、观察引文不实、模型失败阻断和正式流水线产物。

真实联调采用当次官方快照、当前个人证据和现行规则，结果保存在私有目录。联调成功不表示全部公司都兼容，也不取代后续语义复核、官网账号条件与最终投递授权。
