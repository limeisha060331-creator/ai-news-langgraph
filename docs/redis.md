# Redis 设计

## 为什么用 Redis

这一版要同时解决三件事：跨天去重需要持久状态，语义去重需要向量检索，查询需要按时间
范围过滤后做相似度检索。Redis 一个实例同时提供向量索引、数值范围过滤和普通键值，
不用同时维护一个向量库和一个关系库。

代价是多一个要运维的服务，以及它的持久化需要显式配置。单机跑日报的场景里，
第一版用的 SQLite 单文件反而更省事，这也是两版并存的原因。

## 镜像选择

需要 `redis/redis-stack-server` 或者内置了检索模块的 Redis 8 社区版。
普通 `redis:6`、`redis:7` 镜像不带 RediSearch，`FT._LIST` 会直接报错。
代码在连接后的第一步就调用 `FT._LIST` 做能力探测，报错信息里直接给出换镜像的提示，
避免把问题拖到建索引时才暴露。

`docker-compose.yml` 里指定了 `--appendonly yes --appendfsync everysec` 并挂载数据卷。
去重记忆是跨天状态的唯一来源，丢了会导致第二天把归档 feed 里的内容全量重推一遍。

## 键的设计

**· `article:{hash}`**

完整文档，用 RedisJSON 存。字段包括 `urlKey`、`url`、`title`、`titleZh`、`summary`、
`source`、`weight`、`importance`、`published`、`pushedAt` 和 `embedding`。
只有编码成功的条目才写这个键，它同时是向量索引的数据源。

**· `seen:{hash}`**

字符串键，值就是 `urlKey`。只要条目被推送过就写，不要求有向量。

分成两类键的原因是容错。如果历史记录只靠带向量的文档，编码服务故障那天写进去的条目
没有向量，也就没有历史记录，第二天会被当成全新内容再推一遍。`seen:` 键让 URL 级去重
永远有效，向量检索只覆盖编码成功的部分。

键名里的 hash 是 `urlKey` 的 SHA-1 前 16 位，避免超长 URL 撑爆键名。原始 URL 存在
文档字段里，排查问题不受影响。

## 索引定义

```
FT.CREATE idx:article ON JSON PREFIX 1 article: SCHEMA
  $.urlKey    AS urlKey    TAG
  $.source    AS source    TAG
  $.published AS published NUMERIC SORTABLE
  $.pushedAt  AS pushedAt  NUMERIC SORTABLE
  $.importance AS importance NUMERIC
  $.embedding AS embedding VECTOR HNSW 6 TYPE FLOAT32 DIM 1536 DISTANCE_METRIC COSINE
```

`HNSW` 后面的 6 表示接下来有 6 个参数。`DIM` 必须与编码器输出一致，
代码在写入前会检查维度，不一致时抛出带解释的错误，而不是让 Redis 返回一句
难懂的索引写入失败。

`pushedAt` 存 epoch 秒，用于时间范围过滤。`published` 也建了数值索引，
但过滤用的是 `pushedAt`：读者关心的是「这条什么时候推给我的」，不是原始发布时间。

## 查询

**· 单条去重查询**

```
FT.SEARCH idx:article
  "(@pushedAt:[1759276800 +inf]) => [KNN 5 @embedding $vec AS vectorScore]"
  PARAMS 2 vec <float32 blob>
  SORTBY vectorScore
  DIALECT 2
  RETURN 3 urlKey title source vectorScore
  LIMIT 0 5
```

两点容易踩错。

第一，`COSINE` 距离返回的是距离，完全相同的向量得分是 0，相似度需要换算成
`1 - 距离`。直接用返回值当相似度，判断方向会整个反过来。

第二，`DIALECT 2` 不能省。过滤条件写在 KNN 前面属于预过滤，DIALECT 1 会变成
先取 KNN 再过滤，限定时间范围之后经常返回不满 k 条。

**· 按时间列条目**

```
FT.SEARCH idx:article "(@pushedAt:[1759276800 +inf])"
  SORTBY pushedAt DESC
  LIMIT 0 20
```

查询图在向量检索没有命中时用这条兜底。

**· 批量判断 URL 是否已处理**

```
EXISTS seen:<hash1> seen:<hash2> ...
```

代码里按 500 个一批并发调用。用 EXISTS 而不是取回文档内容，一是它对任何键类型都成立，
二是我们只关心「在不在」。

## 阈值与距离无关

阈值作用在换算后的相似度上，与索引的距离度量无关。换距离度量（例如从 COSINE 换成
L2）时，换算关系要跟着改，阈值也要重新标定。
