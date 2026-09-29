# 公开离线演示

这个演示使用合成JD、合成候选事实和预制模型响应，驱动真实的LangGraph流程、工具检索、校验器、公司报告与恢复机制。

**它验证程序路径，不展示真实模型准确率。** 运行时不读取个人档案、不需要API Key、不调用网络。

## 开始

在 agent 目录，首次安装锁定依赖（这一步需要可用的依赖缓存或网络）：

    uv sync --frozen

运行：

    uv run --frozen --offline jobmatch demo

打开 demo-output/demo-report.md。输出还包含模拟标识、逐岗trace、原始/纠错结果、检查点和正式校验产物。已有目录不会覆盖；重做演示请换 --out 指定新目录。

流程里有两个岗位：

1. Python接口岗：一次工具补查，首次故意给出不存在的证据ID，真实校验器拒绝后进入一次纠错。
2. Redis岗：只有课程基础，保留部署与排障缺口，整条待核对。

MCP写入、网申和线上同步不会被调用。

## 展示中断与恢复

    uv run --frozen --offline jobmatch demo --out demo-output --stop-after 1
    uv run --frozen --offline jobmatch resume --run-dir demo-output
    uv run --frozen --offline jobmatch demo --out demo-output --resume

依次发生4次、2次、0次模拟响应调用；真实API调用始终为0。第一次已经完成的岗位不会重跑。

## 为什么不需要第二个仓库

演示附带原公共Skill校验器的固定发布副本，来源commit、文本哈希和MIT许可保存在包内 _vendor/matching。每次启动核对哈希，CI额外核对它与规范Skill一致。没有另写一套“为了演示容易通过”的规则。

生产匹配仍使用工作区配置的Skill。演示副本不能作为修改生产规则的入口。

CI从构建出的wheel导入程序，在不存在个人目录/技能安装/模型密钥的隔离目录执行，并拦截网络连接。它验证报告生成、受控停止、恢复和完成后零重复调用。

真实模型回归另运行：

    uv run jobmatch semantic-check --suite quality --provider cpa

该命令需要真实模型配置，会产生模型用量，结果不能和模拟演示混用。
