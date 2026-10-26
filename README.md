# AI 资讯流水线（LangGraph.js + Redis 版）

用 LangGraph.js 和 Redis 重做 AI 资讯流水线的核心一段：抓取、语义去重、向量检索。
抓三个源（Hacker News、OpenAI Blog、量子位），做两级去重，产出中文日报，并把结果存进
Redis 供自然语言检索。

这是同一套资讯流水线的第二实现。第一版跑在 Dify 工作流加 Python 调度脚本上，职责是每天
产一条日报；这一版把状态、去重和检索拆成可测试的代码，用来做两件第一版做不到的事：
跨语言语义去重，以及按时间范围的自然语言查询。

## 解决什么问题

**· 重复报道占了版面**

同一条资讯在多个源反复出现。URL 完全相同的部分用归一化解决，同一事件不同链接的部分
（英文原文与中文报道、HN 讨论页与官方博客）需要向量相似度。

**· 抓取量与真正新增量差两个数量级**

OpenAI Blog 的 RSS 是全量归档，一次返回约 1255 条；加上 HN 的 30 条和量子位的 10 条，
单次抓取约 1295 条，其中当天真正新增的通常只有十几条。这条流水线把过滤放在摘要之前，
进入模型调用的条目数量因此从 1295 降到 15。

**· 检索要能按时间问**

「过去一周 Agent 有哪些进展」这类问题同时要求时间过滤和语义相似度，两者都要在
Redis 的同一次查询里完成。

## 架构

摄入图的节点顺序：

```
fetch → normalize → rank → summarize → embed → dedupe → deliver → store
```

三个顺序上的决定。

**· normalize 排在 summarize 之前**

normalize 做 URL 归一化、批内去重和历史过滤，不花钱。放到模型调用之后，等于每天为
上千条马上要丢弃的内容付摘要费用。

**· rank 排在 summarize 之前**

排序后先给每个源留出保底名额，再按总量上限截断。只按权重排的话，产量大的源会把其他源
整块挤掉。

**· store 挂在 deliver 之后**

只有送达成功才写历史，这条边用条件边表达。历史一旦写脏，那些没推出去的内容会被当成
已处理，第二天再也出不来。

查询图的节点顺序：

```
embedQuestion → search → compose
```

search 在 Redis 里做混合检索：时间范围过滤加 KNN 向量检索，过滤条件写在 KNN 之前。

节点顺序的完整理由见 [docs/architecture.md](docs/architecture.md)。

## 快速开始

**· 起 Redis**

```bash
docker compose up -d
```

镜像用 `redis/redis-stack-server`。普通 `redis:6` 或 `redis:7` 没有 RediSearch，
建不了向量索引，连上也会在第一步报错。装完可以用 `redis-cli FT._LIST` 确认。

**· 装依赖**

```bash
npm install
```

**· 配环境变量**

```bash
cp .env.example .env
```

默认的 `EMBEDDING_PROVIDER=mock` 与 `LLM_PROVIDER=mock` 会让整条链路在离线状态下跑通，
适合先看流程。真实使用需要改成 `openai` 并填接口地址、密钥和模型名。

**· 建索引并跑一次**

```bash
npm run redis:init
npm run ingest
```

日报写到 `outbox/<日期>.md`。

**· 检索**

```bash
npm run query -- "过去一周 Agent 有哪些进展"
```

**· 多轮对话**

```bash
npm run chat -- --thread=demo --user=demo "过去一周 Agent 有哪些进展"
npm run chat -- --thread=demo --user=demo "展开说说第二条"
```

同一个 `--thread` 会接着上次的对话；同一个 `--user` 跨线程共享偏好。加
`--explain-context` 可以看到这一轮的预算、摘要版本和长期记忆。

**· 标定阈值**

```bash
npm run calibrate
```

## 目录结构

```
src/
  index.ts                命令行入口：ingest / query / calibrate / redis-init
  config.ts               环境变量解析与校验
  types.ts                条目、统计、丢弃记录的类型
  bootstrap.ts            组装依赖（Redis、编码器、摘要器）
  graph/
    state.ts              摄入图的状态与 reducer
    ingestion.ts          摄入图：节点与边的连线
    query.ts              查询图
    chat.ts               对话图：记忆、检索、压缩、回答、写回
  nodes/
    fetch.ts              抓三个源，单源失败只记警告
    normalize.ts          URL 归一化、批内去重、历史过滤
    rank.ts               排序、每源保底、总量截断
    summarize.ts          逐条结构化摘要
    embed.ts              对中文摘要编码
    dedupe.ts             两级阈值语义去重
    deliver.ts            用代码组装日报并落盘
    store.ts              送达后写回 Redis
  redis/
    client.ts             连接与向量能力探测
    schema.ts             索引定义、KNN 查询、写入
  context/                token 估算、证据装包、对话历史切分
  memory/                 线程内 checkpoint 与跨线程 Store
  retrieval/              混合召回、RRF 融合、证据卡
  lib/                    工具：URL、HTTP、RSS、编码、摘要、回答、报告、标定
  fixtures/               标定用例
tests/                    42 个用例，9 个文件
docs/                     架构、Redis 设计、阈值标定说明
```

## 命令

**· `npm run ingest`**

跑一次摄入图，打印各阶段计数、丢弃分布和警告，日报落到 `outbox/`。

**· `npm run query -- "问题"`**

跑查询图，输出回答和引用条目。默认检索最近 30 天，用 `--days=7` 改范围。

**· `npm run chat -- --thread=ID --user=ID "问题"`**

跑对话图。`thread` 决定线程内的对话记忆，`user` 决定跨线程的偏好和结论。
默认存储是 Redis，30 天没活动的 checkpoint 会过期；测试和本地演示可以设
`MEMORY_PROVIDER=memory`。

**· `npm run calibrate`**

用标注样本量出同一事件与不同事件的相似度分布，给出阈值建议。返回码 0 表示可分，
返回码 1 表示当前编码器分不开。

**· `npm run redis:init`**

按当前编码器的维度建向量索引。换编码器或换模型之后必须删掉旧索引重建，
维度不一致时写入会直接失败。

**· `npm run typecheck` 与 `npm test`**

类型检查与单元测试。测试里的 `--pool=threads` 是为了避开默认子进程池在受限环境下的
权限问题。

## 去重阈值

两级阈值的初值：`DUP_THRESHOLD=0.9`、`GRAY_LOW=0.8`、`SAME_SOURCE_MARGIN=0.03`、
`KNN_TOP_K=5`。相似度达到 `DUP_THRESHOLD` 判重丢弃，落在 `GRAY_LOW` 与阈值之间的
保留但标记为疑似，同源条目阈值再加严 `SAME_SOURCE_MARGIN`。

这三个数是在本地词法编码器上标出来的，**换 embedding 模型之后必须重跑
`npm run calibrate`**：同一个数字在不同编码器上对应的含义完全不同。第一版用词法编码器
实测的结果是，同语言近重复 0.837、跨语言同事件 0.073 至 0.296、不同事件同源 0.667，
单一阈值无法区分，所以标定脚本会如实报告「不可分」而不是硬给一个数。

## 记忆与上下文

对话图按笔记里的四个动作分工：

```
loadMemory → retrieve → buildEvidence → compressHistory → compose → writeMemory
```

| 动作 | 在这个项目里是什么 | 写在哪 |
| --- | --- | --- |
| Write | 只写偏好和每轮结论，不写新闻原文 | `memory/repository.ts` |
| Select | 向量加标题关键词两路召回，融合后取前 `EVIDENCE_TOP_K` 条 | `retrieval/hybrid.ts` |
| Compress | 先压成证据卡，再把超预算的旧对话压成四行摘要 | `context/budget.ts`、`context/history.ts` |
| Isolate | 线程消息进 checkpointer，跨线程记忆进 Store，回答层只看证据卡 | `graph/chat.ts`、`memory/runtime.ts` |

预算分四块：证据占 `CONTEXT_BUDGET` 的 40%，摘要占 15%，长期记忆占 10%，
最近对话单独受 `CHAT_HISTORY_BUDGET` 限制。历史没超过预算就不调用摘要器，
避免每轮都花一次模型调用。摘要失败时保留原文，本轮照常回答。

证据编号从 `E1` 开始，回答里的 `[E1]` 能直接对上本轮证据卡。检索追问时，
短问题会拼上一条用户问题再检索，解决「展开第二条」这类指代。

方法与数据见 [docs/thresholds.md](docs/thresholds.md)。

## Redis 设计

**· 两类键**

`article:{hash}` 存完整文档（带向量），供 KNN 检索；`seen:{hash}` 只记这个 URL 处理过。
分成两类是为了让 URL 级去重在编码失败时依然有效：如果没有向量就查不到历史，
第二天会把同一批内容再推一遍。

**· 索引**

JSON 文档加 RediSearch 索引，向量字段用 HNSW、FLOAT32、COSINE 距离。
维度必须与编码器输出一致。

**· 距离与相似度**

COSINE 距离返回的是距离，完全相同的向量得分是 0。代码里统一用 `1 - 距离` 换算成
相似度，否则 0.85 这个阈值会被理解成完全相反的意思。

**· 混合检索**

过滤条件写在 KNN 前面，需要 DIALECT 2。默认的 DIALECT 1 是取完 KNN 再过滤，
限定时间范围后经常返回不满 k 条。

**· 持久化**

去重记忆是跨天状态的唯一来源，`docker-compose.yml` 里开了 AOF 并挂载数据卷。
去重记录不设短 TTL，TTL 短于回溯窗口会导致去重从某天起静默失效。

详细说明与查询示例见 [docs/redis.md](docs/redis.md)。

## 与第一版的对比

**· 第一版：Dify 工作流加 Python 调度脚本**

优点是有可视化画布，改提示词和调节点不需要写代码，单机定时任务一条命令装完，
每天产出日报直接在微信里读。

代价是状态和逻辑混在一起，节点里跑不了测试，跨语言去重受限于纯标准库环境，
摘要不可用时只能整篇降级。

**· 这一版：LangGraph.js 加 Redis**

优点是可测试（25 个用例覆盖归一化、截断配额、阈值标定、报告组装和端到端串联）、
可版本化、能作为服务嵌进别的系统，检索能力是第一版没有的。

代价是多了一个 Redis 要运维，以及失去了画布：改提示词要改代码再部署。

两版共用同一套业务规则：URL 归一化规则、每源保底 3 条、总量上限 15 条、
跨天窗口 30 天、推送成功才写历史。规则一致，实现不同。

## 验证

一条命令：

```bash
npm run verify   # typecheck + 单元测试 + 回放基线
```

回放基线（`harness/replay.test.ts`，也在 `npm test` 里）用一份冻结的三源输入把整条图重跑一遍，
比对漏斗数字、10 条行为用例和编码器指纹。不联网、不连 Redis、不要密钥，输出确定。

```bash
npm run harness               # 人读的表格：漏斗 / 丢弃分布 / 行为用例 / 指纹
npm run harness -- --explain  # 追加每条入选条目的最高相似度，核对阈值有没有被踩到
npm run harness -- --update   # 确认新行为是对的之后更新基线
```

为什么需要它、它守住了什么、哪些地方它其实没覆盖，见 [harness/README.md](harness/README.md)。

## 日报的版面

正文分三档，配额写死在 [`src/lib/report.ts`](src/lib/report.ts)：今日头条 2 条、重要进展 5 条、
值得关注 6 条。今日头条（重要性 ≥ 4）是重要进展（4 或 5）的子集，两档从同一个池子里依次取，
所以 4 至 5 分的条目进正文最多 7 个位置，另外 6 个留给 1 至 3 分的条目。这个上限由分数分布决定，
跟送达多少条无关：15 条全是 5 分时，正文只放得下 7 条。

超出的条目不会消失：**链接汇总必须覆盖本次送达的每一条**，先列已进正文的，再列只进汇总的。
表头因此写两个数：

```
> 共 13 条 · 正文精选 10 条 · 来源：OpenAI Blog / 量子位 / HN
```

这是硬不变量：`renderReport` 返回的 `listed` 必须等于 `delivered`，`deliver` 发现不等就记
`error` 并追加警告。守它有两层，`tests/report.test.ts` 的单位用例和回放里的
`report.coversDelivered`。漏掉的代价也不轻：那些条目已经写进 `seen:` / `article:`，
第二天算已推送，读者再也看不到。

## 已知限制

**· mock 编码器抓不到跨语言重复**

`EMBEDDING_PROVIDER=mock` 是词法编码器，同语言近重复能判，跨语言同事件判不了。
这条限制写进了测试用例，换成真实模型后那个断言会失败，届时应当删掉它并重新标定。

**· 摘要质量取决于模型**

摘要器只约束「依据输入写作、不编造」，没有做事实核验。摘要可用率目前只统计
非空、未截断、带链接这三项，覆盖要点仍然需要抽样人工评估。

**· 送达环节是可插拔的**

当前 deliver 节点把日报写成本地文件。要接到微信或飞书，替换 deliver 节点的实现即可，
但必须保留「拿到业务返回码再决定是否写历史」这个约束。
修法是让分档之外的行落进链接汇总、并让表头数等于正文数；改完这条断言会变红，那是有意的红。
