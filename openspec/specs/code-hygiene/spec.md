# code-hygiene Specification

## Purpose
TBD - created by archiving change remove-unused-code. Update Purpose after archive.

## Requirements

### Requirement: 仓库不保留未使用的本地符号

代码库 SHALL 不包含未使用的导入、局部变量与函数参数。未使用的标识符 MUST 由自动化检查发现，
而不是依赖代码评审时的注意力。

#### Scenario: 新增未使用的导入使验证失败

- **WHEN** 有人新增一个 `import` 但没有任何地方引用它
- **THEN** `npm run check:unused` 以非零退出码结束，并指出文件与行号
- **AND** 因为它挂在 `npm run verify` 链上，提交前与 CI 里都会失败

#### Scenario: 故意保留的参数不触发检查

- **WHEN** 某个参数是为了保持工厂函数签名一致而必须留着的（例如 `createDeliverNode(_deps)`）
- **THEN** 参数名以 `_` 开头，`check:unused` 放行，不影响签名一致性

### Requirement: 清理不改变运行时行为

清理未使用符号的改动 SHALL NOT 改变流水线的行为。判定标准是回放基线与单元测试同时保持绿色。

#### Scenario: 清理后回放基线不变

- **WHEN** 删掉或改名一个未使用的符号后运行 `npm run verify`
- **THEN** 回放回归台的漏斗数字、行为用例、`report.sha256` 全部与基线一致
