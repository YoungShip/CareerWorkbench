# 空白主表模板

本目录的八份 CSV 从 dashboard/store.js 的 HEADERS 字段定义生成，只包含表头，没有个人数据或示例申请。

新实例通过 createStore.initialize 建立数据，后续写入均走主表事务协议。不要将这些空模板复制覆盖已有工作区的 CSV。

Excel 历史备份与 Agent 标注表属于不同用途，不由这里的模板替换。
