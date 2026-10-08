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
  lib/                    工具：URL、HTTP、RSS、编码、摘要、回答、报告、标定
  fixtures/               标定用例
tests/                    25 个用例，6 个文件
docs/                     架构、Redis 设计、阈值标定说明
```

## 命令

**· `npm run ingest`**

跑一次摄入图，打印各阶段计数、丢弃分布和警告，日报落到 `outbox/`。

**· `npm run query -- "问题"`**

跑查询图，输出回答和引用条目。默认检索最近 30 天，用 `--days=7` 改范围。

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
