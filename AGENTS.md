# AGENTS.md

给在这个仓库里干活的 agent 看的。只写规则，不写项目介绍，介绍在 [README.md](README.md)。

## 一条命令

```bash
npm run verify     # = typecheck + check:unused + vitest（含回放基线）+ harness
```

绿了才算改完。不要用「我读了一遍，逻辑没问题」代替它。

> 本机 PowerShell 执行策略是 `Restricted`，`npm` 可能被拦；这时用 `npm.cmd`。

## 什么会悄悄坏

`tsc` 报不了的那类问题都在下面。这几处改错，编译照样过，后果是某天日报少三条，
或者把昨天推过的内容再推一遍：

- 节点顺序（`normalize` 在 `summarize` 之前，`rank` 在 `summarize` 之前）
- 每源保底 `MIN_PER_SOURCE`
- 总量上限 `TOP_N`
- 两级阈值的方向与同源加严 `SAME_SOURCE_MARGIN`
- `deliver` 之后才写历史（`afterDeliver` 条件边）
- COSINE 距离到相似度的换算

这些行为由回放基线守着：`harness/fixtures/news-baseline.v1.json` + `harness/replay.test.ts`。
它把一份冻结的三源输入灌进整条图，比对漏斗数字、10 条行为用例、编码器指纹。

未使用的导入、局部变量与参数是另一类：它们由 `npm run check:unused`
（`tsc --noUnusedLocals --noUnusedParameters`）兜住。为了保持节点工厂签名而故意留的参数，
名字用 `_` 前缀（见 `src/nodes/deliver.ts` 的 `_deps`），TS 对这类参数放行。

## 项目地图

```
src/graph/ingestion.ts   图的连线与唯一一条条件边（deliver → store | END）
src/graph/state.ts       状态定义；除 articles 外都是累加型 reducer
src/graph/chat.ts        对话图：记忆 → 检索 → 证据卡 → 压历史 → 回答 → 写记忆
src/memory/              checkpointer（线程内）与 Store（跨线程）
src/context/             token 估算、证据装包、历史切分
src/retrieval/           混合召回、RRF 融合、证据卡
src/nodes/fetch.ts       三源抓取，单源失败只记警告
src/nodes/normalize.ts   URL 归一化 + 批内去重 + 历史过滤（不花钱，所以排在模型之前）
src/nodes/rank.ts        权重排序 + 每源保底 + 总量截断
src/nodes/summarize.ts   逐条结构化摘要，整批失败时逐条降级
src/nodes/embed.ts       对「中文标题 + 中文摘要」编码（跨语言去重靠这一步）
src/nodes/dedupe.ts      历史 KNN + 批内余弦，两级阈值
src/nodes/deliver.ts     代码分档拼日报并落盘（不让模型决定版面）
src/lib/report.ts        版面的唯一来源：三档配额、正文精选、链接汇总覆盖全部条目
src/nodes/store.ts       写回跨天状态，只在送达成功时执行
src/redis/schema.ts      两类键（article: 带向量 / seen: 只记 URL）与查询
src/lib/url.ts           URL 归一化规则，必须与第一版 Python 实现保持一致
harness/                 回放回归台，见 harness/README.md
```

依赖通过 `Deps` 工厂注入，不塞进 state（state 会进 checkpoint，连接对象不可序列化）。
新增节点时沿用这个约定：`createXxxNode(deps)` 返回节点函数。

## 不要动的东西

1. **`afterDeliver` 的语义**：没送达就不写历史。写早了，没推出去的内容会被当成已处理，永远消失。
2. **`normalize` 的位置**：它不花钱。放到模型调用之后，等于每天为上千条马上要丢掉的内容付摘要费。
3. **`rank` 的保底名额**：三个源产量差两个数量级，只按分数排会把日报变成单源播报。
4. **阈值方向**：`score >= DUP_THRESHOLD + 同源加严` 判重丢弃，`>= GRAY_LOW` 只标疑似。
   把这两段反过来、或者删掉同源加严，回放里的 `same-source-margin-suspect` 会红。
5. **`1 - 距离` 的换算**：COSINE 返回距离不是相似度，漏了换算，阈值含义正好反了。
6. **URL 归一化规则**：与第一版 Python 实现共用一套，`TRACKING_PARAMS` 少一条就会出现重复推送。
7. **日报必须覆盖送达集合**：正文三档是精选（容量 13，其中 4–5 分只占 7 个位置），
   没进正文的条目必须出现在链接汇总里。`renderReport` 的 `listed` 恒等于 `delivered`；
   破坏了 `npm test` 与回放的 `report.coversDelivered` 会同时红。

## 改了行为怎么办

1. 先跑 `npm run harness`，看 FAIL 行定位到哪条规则。
2. 判断是「规则本就该变」还是「规则坏了」。只有前者才 `npm run harness -- --update`。
3. `--update` 前把表格逐行核一遍：基线是断言，不是快照。只想让它变绿，这条用例就没有意义了。
4. commit message 写清「改了哪条规则、为什么、怎么证明没坏」。

## 提交

- 验证绿了再 commit，一次 commit 说清一件事。
- 不要提交 `outbox/`、`harness/.artifacts/`、`.env`（已在 `.gitignore`）。
- 新增 fixture 用例时，`description` 写「这条守的是哪条规则」，不要写「测试行为正常」。

## 已知缺陷与盲区

见 [harness/README.md](harness/README.md) 的「它没覆盖什么」与 README 的「已知限制」。

日报丢条那个缺陷已经修了，但这次的形状值得记住：「正文分档」的容量（恒为 13，4–5 分只有 7 个位置）
和「写回历史」的集合（`state.articles` 全量）各走各的，中间那段差额就是永久丢失。
以后凡是加「只让读者看一部分」的逻辑，先回答一句：另一部分去哪了。
`renderReport` 现在返回 `{ markdown, placed, listed }`，`listed` 必须等于 `delivered`，
`deliver` 里不等会直接记 error + warning。
