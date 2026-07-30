# RepoCircuit W2 Fixture

这是 W2 安全工具链的最小 Fixture Repository。

- `src/greeting.ts` 是 `read → apply_patch → diff` 的修改目标。
- `scripts/check.mjs` 是受控 `exec` 的测试目标。
- 测试必须先把本目录复制到临时目录，不能直接修改 committed fixture。

初始代码故意保留 `courseWeek = 1`。标准集成测试会用带修改前 Hash 的
Unified Diff 把它改为 `courseWeek = 2`，随后运行检查脚本。
