# W3 Smoke Suite

这 6 个任务按“单行修复 → 边界行为 → 跨文件 → 异步状态”递增。每个
`workspace/` 都是只读母本；Smoke Runner 会复制到临时 Git 仓库后再交给
Agent，成功和失败都写入独立的 `sessions/<runId>.jsonl`。

`script.json` 只用于离线、确定性的 Agent loop 验收，真实模型运行不读取它。
Smoke Runner 会把母本复制到临时 Git 仓库；本套任务不包含隐藏评测，也不会
把任何评测结果回填给模型。
