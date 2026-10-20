## 决策一：用 `tsc` 而不是 slop-cleaner 做检查

slop-cleaner 的 TS 分析把类型导入判成未使用——`import type { Deps }` 里的标识符在它的 AST 走查里
不是 `identifier` 节点，于是 82 条里绝大多数是误报；同一份代码 `tsc --noUnusedLocals` 只报 1 条。

`tsc` 的优势是它就是编译器，类型引用的语义由它自己定义，不需要第三方重新解释。
代价是它只覆盖「本地声明未被读取」，不覆盖「导出的符号无人使用」——后者需要跨模块分析，
本轮不做，记在 tasks 的后续项里。

## 决策二：参数改名 `_deps` 而不是删掉参数

`createDeliverNode(deps)` 现在的实现确实不需要 `deps`。两种处理：

1. 删掉参数 → 调用点 `createDeliverNode(deps)` 也要改；八个节点工厂里只有 deliver 不接 Deps，
   读代码的人需要多记一条例外。
2. 改名 `_deps` → 签名保持一致，TS 对下划线前缀参数不作未使用检查，注释说明为什么留着。

选 2。理由是这个仓库的约定是「依赖通过 Deps 工厂注入」，保留参数位置比省一个参数更有价值；
如果将来日报要接推送通道，`deps` 就在原位。

## 决策三：把检查挂进 verify，而不是单独跑

单独一个 `npm run check:unused` 一定会被忘记跑。挂进 `npm run verify` 之后，
它和回放基线共享同一个入口，而 AGENTS.md 已经把 verify 定义成唯一的验收口径。

## 风险

`--noUnusedParameters` 会对每个未使用参数报错。如果将来有人写接口实现时不得不留空参数，
需要用 `_` 前缀，这可能被误当成风格问题。缓解办法是这条规定写进 AGENTS.md。
