## 1. 清理现有残留

- [x] 1.1 `src/nodes/deliver.ts`：把 `createDeliverNode(deps: Deps)` 的参数改名为 `_deps`，并补一句注释说明为什么保留参数位置
- [x] 1.2 跑 `npx tsc --noEmit --noUnusedLocals --noUnusedParameters`，确认输出为空

## 2. 让检查可持续

- [x] 2.1 `package.json` 增加 `"check:unused": "tsc --noEmit --noUnusedLocals --noUnusedParameters"`
- [x] 2.2 `verify` 脚本改为 `npm run typecheck && npm run check:unused && npm test && npm run harness`
- [x] 2.3 `AGENTS.md` 在「什么会悄悄坏」补一条：未使用符号由 `check:unused` 兜住

## 3. 验证

- [x] 3.1 `npm run verify` 全绿（31 个测试通过）
- [x] 3.2 回放基线的 `report.sha256` 未变（`git status` 里 harness 无改动）
- [x] 3.3 `openspec validate remove-unused-code` 通过，然后归档

## 4. 后续（不在本次范围）

- [ ] 4.1 跨模块的「导出符号无人使用」检测：`tsc` 不覆盖，需要单独工具或脚本
- [ ] 4.2 在 CI 里对 `check:unused` 单独出一个摘要，而不是让它只以整条 verify 失败的形式出现
