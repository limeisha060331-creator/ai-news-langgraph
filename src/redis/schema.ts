import type { RedisClient } from "./client.js";
import { urlToId } from "../lib/url.js";

export interface StoredArticle {
  urlKey: string;
  url: string;
  title: string;
  titleZh?: string;
  summary?: string;
  source: string;
  weight: number;
  importance?: number;
  published: string;
  pushedAt: number;
  embedding: number[];
}

export interface Neighbor {
  urlKey: string;
  title: string;
  source: string;
  /** 余弦相似度，已从 Redis 返回的距离换算过来 */
  similarity: number;
}

/**
 * 两类键，分工不同：
 *   article:{hash}  完整文档，带向量，供 KNN 检索用（索引前缀就是它）
 *   seen:{hash}     只记「这个 URL 处理过」，不要求有向量
 *
 * 为什么不合成一个：编码服务挂掉时条目没有向量，如果只靠带向量的文档记录历史，
 * 这些条目第二天会被当成全新的再推一遍。分开之后，URL 级去重永远有效，
 * 向量检索则只覆盖真正编码成功的条目。
 */
export function articleKey(urlKey: string): string {
  return `article:${urlToId(urlKey)}`;
}

export function seenKey(urlKey: string): string {
  return `seen:${urlToId(urlKey)}`;
}

export function toFloat32Buffer(vector: number[]): Buffer {
  const array = new Float32Array(vector);
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

/**
 * COSINE 距离返回的是「距离」不是「相似度」：完全相同的向量得分是 0。
 * 这里统一换算成相似度，否则 0.85 这个阈值会被理解成完全相反的意思。
 */
export function similarityFromScore(score: number): number {
  return 1 - score;
}

/**
 * 建索引。字段用 AS 起别名，查询和返回都用别名。
 * embedding 的维度必须和 embedding 模型输出一致，改模型要删索引重建。
 *
 * HNSW 后面跟的 6 是「接下来有 6 个参数」，即 TYPE FLOAT32 DIM n DISTANCE_METRIC COSINE。
 */
export async function ensureIndex(
  client: RedisClient,
  indexName: string,
  dim: number,
): Promise<"created" | "exists"> {
  const existing = await client.ft._list();
  if (existing.includes(indexName)) return "exists";

  await client.ft.create(
    indexName,
    {
      "$.urlKey": { type: "TAG", AS: "urlKey" },
      // title 必须显式声明才能被 RETURN 取回。查询只按 urlKey / pushedAt 过滤，
      // 这里建索引纯粹是为了让检索结果能带上标题——少了它，命中列表就只有来源没有标题。
      "$.title": { type: "TEXT", AS: "title" },
      "$.source": { type: "TAG", AS: "source" },
      // published 是 RSS 给的 RFC-822 日期字符串（"Fri, 02 Oct 2026 00:00:00 GMT"），
      // 不是数字。声明成 NUMERIC 会让**每一条文档**索引失败，索引里一条都看不见——
      // 而且失败只体现在 FT.INFO 的 indexing failures 里，查询时只是静默返回空。
      // 时间范围过滤走 pushedAt（epoch 秒），这个字段只作展示，用 TAG 存即可。
      "$.published": { type: "TAG", AS: "published" },
      "$.pushedAt": { type: "NUMERIC", AS: "pushedAt", SORTABLE: true },
      "$.importance": { type: "NUMERIC", AS: "importance" },
      "$.embedding": {
        type: "VECTOR",
        AS: "embedding",
        ALGORITHM: "HNSW",
        TYPE: "FLOAT32",
        DIM: dim,
        DISTANCE_METRIC: "COSINE",
      },
    },
    { ON: "JSON", PREFIX: "article:" },
  );
  return "created";
}

export async function upsertArticle(client: RedisClient, article: StoredArticle): Promise<void> {
  if (article.embedding.length > 0) {
    // JSON.SET 的第三个参数是 RedisJSON 品牌类型，普通对象要显式断言过去
    await client.json.set(
      articleKey(article.urlKey),
      "$",
      article as unknown as Parameters<typeof client.json.set>[2],
    );
  }
  await client.set(seenKey(article.urlKey), article.urlKey);
}

/**
 * 只写入库的条目才进历史。这个函数被 store 节点调用，
 * 而 store 只在送达成功后才执行——写早了会把没送出去的条目当成已处理，
 * 第二天就再也推不出来了。
 */
export async function upsertMany(client: RedisClient, articles: StoredArticle[]): Promise<number> {
  if (articles.length === 0) return 0;
  let written = 0;
  for (const article of articles) {
    await upsertArticle(client, article);
    written += 1;
  }
  return written;
}

/**
 * 批量判断哪些 URL 已经在历史里，返回命中的 urlKey 集合。
 *
 * 用 EXISTS 而不是 JSON.GET / MGET：EXISTS 对任何键类型都成立，
 * 而我们只关心「在不在」，不需要把整份文档取回来。
 */
export async function existingUrlKeys(
  client: RedisClient,
  urlKeys: string[],
): Promise<Set<string>> {
  if (urlKeys.length === 0) return new Set();
  const found = new Set<string>();
  const chunkSize = 500;
  for (let start = 0; start < urlKeys.length; start += chunkSize) {
    const chunk = urlKeys.slice(start, start + chunkSize);
    const hits = await Promise.all(chunk.map((urlKey) => client.exists(seenKey(urlKey))));
    hits.forEach((hit, index) => {
      if (hit > 0) found.add(chunk[index]!);
    });
  }
  return found;
}

export interface KnnOptions {
  k: number;
  /** 只在这个时间点之后推送过的条目里找邻居，0 表示不限 */
  sinceEpochSeconds?: number;
}

/**
 * 在历史里找最相似的 k 条。
 *
 * 查询串分两段：`(@pushedAt:[start +inf])` 是预过滤，`=> [KNN ...]` 才是向量检索。
 * 预过滤要 DIALECT 2 才支持，用默认的 DIALECT 1 会变成「先取 KNN 再过滤」，
 * 限定时间范围后经常返回不满 k 条，这是混合检索最容易踩的坑。
 */
export async function knnSearch(
  client: RedisClient,
  indexName: string,
  vector: number[],
  options: KnnOptions,
): Promise<Neighbor[]> {
  const filter = options.sinceEpochSeconds
    ? `(@pushedAt:[${options.sinceEpochSeconds} +inf])`
    : "(*)";
  const query = `${filter}=> [KNN ${options.k} @embedding $vec AS vectorScore]`;

  const result = await client.ft.search(indexName, query, {
    PARAMS: { vec: toFloat32Buffer(vector) },
    SORTBY: { BY: "vectorScore", DIRECTION: "ASC" },
    DIALECT: 2,
    RETURN: ["urlKey", "title", "source", "vectorScore"],
    LIMIT: { from: 0, size: options.k },
  });

  return result.documents.map((document) => {
    const value = document.value as Record<string, unknown>;
    return {
      urlKey: String(value.urlKey ?? ""),
      title: String(value.title ?? ""),
      source: String(value.source ?? ""),
      similarity: similarityFromScore(Number(value.vectorScore ?? 1)),
    };
  });
}

/** 按时间范围取条目，供查询图在没有向量命中时兜底，也用于人工核对。 */
export async function listSince(
  client: RedisClient,
  indexName: string,
  sinceEpochSeconds: number,
  limit = 20,
): Promise<Neighbor[]> {
  const result = await client.ft.search(indexName, `(@pushedAt:[${sinceEpochSeconds} +inf])`, {
    SORTBY: { BY: "pushedAt", DIRECTION: "DESC" },
    RETURN: ["urlKey", "title", "source"],
    LIMIT: { from: 0, size: limit },
  });
  return result.documents.map((document) => {
    const value = document.value as Record<string, unknown>;
    return {
      urlKey: String(value.urlKey ?? ""),
      title: String(value.title ?? ""),
      source: String(value.source ?? ""),
      similarity: 0,
    };
  });
}

export function daysAgoEpochSeconds(days: number): number {
  // 除以 1000 这一步不能省：Date.now() 是毫秒，文档里的 pushedAt 是秒。
  // 少了它过滤条件会变成「某个未来的时间点」，把历史全过滤掉，
  // 而且不报错——查询只是安静地返回空。
  return Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);
}

export interface IndexHealth {
  numDocs: number;
  indexingFailures: number;
  lastError: string | null;
}

/**
 * 索引健康度。
 *
 * 加这个函数是因为踩过一次静默故障：字段类型声明错了（把日期字符串声明成 NUMERIC），
 * 结果是每一条文档索引失败，但写入和查询都不报错——FT.SEARCH 就是安静地返回空。
 * 只有 FT.INFO 里的 indexing failures 能看出来，所以把它显式暴露出来。
 */
export async function indexHealth(client: RedisClient, indexName: string): Promise<IndexHealth> {
  const raw = (await client.ft.info(indexName)) as unknown;
  const map = new Map<string, unknown>();

  if (Array.isArray(raw)) {
    for (let index = 0; index + 1 < raw.length; index += 2) {
      map.set(String(raw[index]), raw[index + 1]);
    }
  } else if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      map.set(key, value);
    }
  }

  const lastError = map.get("last indexing error");
  return {
    numDocs: Number(map.get("num_docs") ?? 0),
    indexingFailures: Number(map.get("hash_indexing_failures") ?? 0),
    lastError: typeof lastError === "string" && lastError.length > 0 ? lastError : null,
  };
}
