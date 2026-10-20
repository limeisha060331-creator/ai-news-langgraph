## Why

`createDeliverNode` 的 `deps` 参数在日报渲染逻辑迁到 `src/lib/report.ts` 之后已经没人用了，但签名还留着。
这类残留不会被任何现有检查发现：`tsc` 默认不检查未使用符号，回放回归台只比对运行行为。
结果是节点工厂「都依赖 Deps」这条约定变成了一句假话，下一个人读代码会以为 deliver 还需要外部依赖。

用 slop-cleaner 对全仓扫了一遍，它报 82 条「未使用的 import」，但绝大多数是把 `import type { Deps }`
这类类型导入误判成未使用；同一份代码用 `tsc --noUnusedLocals` 只报 1 条，就是上面那个参数。
所以清理本身只需要一处改动，真正的缺口是**没有东西持续发现它**。

## What Changes

- 把 `createDeliverNode` 未使用的 `deps` 参数改名为 `_deps`（保持节点工厂签名一致，TS 对下划线前缀参数不作未使用检查）
- 新增 npm 脚本 `check:unused`，用 `tsc --noUnusedLocals --noUnusedParameters` 把未使用的本地符号与参数变成可失败检查
- 把 `check:unused` 接进 `npm run verify`，使它在提交前与 CI 里都会跑

## Capabilities

### New Capabilities

- `code-hygiene`：仓库不保留未使用的本地符号与导入；这类残留会让验证失败，而不是靠人读出来。

### Modified Capabilities

无。这一版没有既有 `openspec/specs/` 下的能力被修改。

## Impact

- 代码：`src/nodes/deliver.ts`（一个参数名）、`package.json`（两个脚本）
- 验证链：`npm run verify` 从「typecheck + test + harness」变成「…… + check:unused」，失败面变大但都是真实的未使用符号
- 无运行时行为变化；回放基线的 report 指纹不应变动
