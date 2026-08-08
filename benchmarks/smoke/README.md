# W3 Smoke Suite

这 6 个任务按“单行修复 → 边界行为 → 跨文件 → 异步状态”递增。每个
`workspace/` 都是只读母本；Smoke Runner 会复制到临时 Git 仓库后再交给
Agent，成功和失败都写入独立的 `runs/<runId>/`。

`script.json` 只用于离线、确定性的 Harness 验收。真实模型运行不读取它。
`verifier.mjs` 位于 Agent 工作区之外，由 Host 在模型停止后独立执行。
Runner 会把母本提交为确定性的干净 Git HEAD；`task.json` 的 `baseSha`
必须与这个实测 HEAD 一致，否则 Run 在冻结配置前即被拒绝。
