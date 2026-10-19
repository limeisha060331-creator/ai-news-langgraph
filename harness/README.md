# harness —— 回放回归台

## 为什么要有它

这条流水线很少编译不过。它坏起来是行为悄悄挪了一点：日志照常，日报照发。建这个台子的当天就撞上三回：

1. **假 Redis 把 Buffer 当成数组解码**，KNN 查询维度从 256 变成 1024，匹配不到任何历史文档。
   语义去重就这样静默失效。没有异常，没有警告，只是那天多推了几条重复。
   要不是 `--explain` 把每条的最高相似度打出来，这个错会一直躺着。
2. **同源两条兄弟稿件的相似度正好是 0.900**。默认阈值 0.90 判重、同源再加严 0.03 才拦住误杀。
   这 0.03 是全系统最脆的一个数：删掉 `SAME_SOURCE_MARGIN`，独家新闻就会在没人注意的时候被吃掉。
3. **日报分档之外的行会静默消失**。三个分档合计最多 13 条，而 4 至 5 分的条目共享前两档的 7 个位置，
   多出来的既不进正文也不进链接汇总，却被写回历史。第二天不会再出现，表头还写着「共 15 条」。
   实测 13 条送达只列 10 条，15 条全高分只列 7 条。
   这条已经修掉：现在链接汇总覆盖送达的每一条，`listed === delivered` 是硬不变量，
   由 `tests/report.test.ts`（单位层）和回放里的 `report.coversDelivered`（集成层）同时守。
   修完把旧行为注回去做过一次变异测试，两个 `listed` 断言和回放基线都会红。

三件事的共同点是当时全都跑得很正常。所以「跑通了」不算验收，得有个东西在行为挪动时变红。

## 四层断言

| 层 | 断言什么 | 变了说明什么 |
| --- | --- | --- |
| 漏斗 | 42 抓取 → 38 去重后 → 15 入选 → 13 送达 | 某个阶段的过滤/截断规则变了 |
| 用例 | 10 条形为用例各自落在哪条规则上 | 具体是哪条规则变了（含 `history` / `batch` 两条路径） |
| 覆盖 | 正文 10 条 + 汇总 13 条，且 `listed === delivered` | 版面把内容吃掉了一部分（这条曾经是红的） |
| 指纹 | 日报 sha256 + 标定 10 对相似度 | 版面或编码器变了（分词、维度、模型） |

漏斗数字对不上、用例挂在 `duplicate-url-history`、`coversDelivered` 掉下来、或者指纹小数点后第三位变了，
四种信号分别指向四个地方。不用翻 diff 猜。

## 文件

| 文件 | 作用 |
| --- | --- |
| `fixture.ts` | fixture 的 zod 结构与加载；结构不合法时报出精确路径 |
| `wire.ts` | 把 fixture 的条目字段渲染成 HN JSON / RSS 2.0，并顶掉 `global fetch` |
| `fake-redis.ts` | 内存版 Redis：`exists` / `set` / `json.set` / `ft.search`（含 KNN 与时间过滤） |
| `run.ts` | 核心：组装 deps、跑图、比对、生成报告；`--update` 也在这里 |
| `replay.ts` | CLI，给人看的表格：`npm run harness` |
| `replay.test.ts` | 同一套断言进 vitest，所以 `npm test` / `npm run verify` 已经包含它 |
| `fixtures/news-baseline.v1.json` | 冻结的三源输入 + 历史状态 + 行为用例 + 基线 |

生产代码一行没改。`fetch` 节点走 `global fetch`，打桩就能整条回放；`Deps` 本来就允许注入
Redis client、编码器、摘要器，这也是当初把它做成依赖注入的用处。

## 常用命令

```bash
npm run harness               # 跑基线，人读的表格
npm run harness -- --explain  # 追加每条入选条目与批内/历史的最高相似度
npm run harness -- --update   # 确认新行为正确后，重写 fixture 里的 expect 块
npm run harness -- --fixture=harness/fixtures/other.json
```

`--update` 只改 `expect`，不动 `sources` / `history` / `cases`：用例是人工写的断言，
机器不该替人决定「这条应该被拦下」。

## 怎么加一条用例

1. 在 `sources` 里加条目（或改已有条目的措辞），让它能触发你要守的规则。
2. 在 `cases` 里加一条，`description` 写清**守的是哪条规则、破坏了会怎样**。
3. `npm run harness` 先看实际结果：如果和预期不同，是代码有问题，还是你设计的用例本来就不成立。
4. 确认无误后 `npm run harness -- --update`，再 `npm run verify` 全绿。

## 它没覆盖什么

写清楚，免得「回放绿了」被当成「没问题」：

- **编码器与摘要器都是 mock**。词法编码器判不出跨语言同事件（`cross-language-kept` 这条用例就是把边界钉住），
  摘要永远是降级版，`importance` 因此恒等于来源权重，分档分布不真实。
  所以 `report.items`（正文精选几条）是 mock 下的产物，换成真模型会变，那时候它变红是有意义的。
  `report.listed` 不受影响，它恒等于 `delivered`。
- **假 Redis 是暴力全扫描，真实现是 HNSW 近似**。k 很小时的近邻集合可能不同；流水线只用它比阈值，
  暴力扫描只会更准，不会掩盖失败。
- **只回放摄入图**。查询图（`embedQuestion → search → compose`）没有回放。
- **wire 层渲染的 feed 比真实响应简单**：没有 CDATA、没有多余命名空间、没有缺字段的条目，
  所以 `parseFeed` 的容错分支（拿到网页、解析失败）没有被覆盖。
- **不覆盖真实 Redis 的静默索引失败**（把日期字符串声明成 NUMERIC 那种）。那类问题靠
  `npm run redis:init` 的 `indexHealth` 提示，靠回放是发现不了的。
- **`missing-url` 分支进不来**：`parseFeed` 会丢掉没有 link 的条目，HN 会用 `objectID` 拼讨论页地址，
  所以两条来源都产生不出空 URL。这条分支现在是死代码，用例里故意没有它。
