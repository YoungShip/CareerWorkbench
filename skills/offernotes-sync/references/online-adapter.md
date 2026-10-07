# Online progress adapter contract

此接口描述供本地 tracker 与 OfferNotes/类似在线服务之间使用。它不是认证实现，也不应把凭据写入仓库。

## Payload

```json
{
  "dryRun": true,
  "entries": [
    {
      "job_id": "job-example-001",
      "online_record_id": null,
      "company": "Example Company",
      "job_title": "Example Role",
      "location": "Example City",
      "job_description": "Official JD text or empty when absent",
      "job_url": "https://example.invalid/jobs/example-role",
      "notes": "Candidate-specific notes are supplied only at runtime.",
      "follow_up": []
    }
  ],
  "identity_index": [
    {"job_id": "job-example-001", "online_record_id": null}
  ]
}
```

示例值是虚构的；真实 payload 必须存于私有运行目录并被版本控制排除。

## Result

每个 entry 返回：

```json
{
  "job_id": "job-example-001",
  "action": "create|update|noop|error",
  "online_record_id": "runtime-only-id",
  "verified": true,
  "change_id": "runtime-only-revision",
  "error": null
}
```

真实结果文件不得提交到公共仓库；`online_record_id` 和 `change_id` 仅在本地 ack 时使用。

## Required adapter behavior

1. 查询范围限定当前登录用户；
2. 按固定 ID 和管理区 job ID 匹配，名称只作辅助；
3. 先做冲突检查，再写详情和阶段；
4. 创建时设置服务当前确认的私有可见性；
5. 每次写入后读取详情和阶段并比较期望字段；
6. 错误条目不生成成功 ack；
7. 处理完成后关闭专用浏览器实例，不杀进程、不清理 profile；
8. 不实现默认删除，不接受未授权的批量范围扩张。

