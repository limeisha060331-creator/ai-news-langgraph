import { cosineSimilarity } from "../src/lib/embedding.js";
import type { RedisClient } from "../src/redis/client.js";
import { articleKey, seenKey, type StoredArticle } from "../src/redis/schema.js";

/**
 * 内存版 Redis：只实现整条流水线真正用到的几个命令。
 *
 * 为什么不用真的 Redis：回放要能在 CI、在别人的机器上、在没有 Docker 的情况下跑完，
 * 并且必须是确定性的。假 Redis 只负责三件事——「这个 URL 见过没有」「这两个向量多像」
 * 「历史文档长什么样」，没有一样需要真的服务端。
 *
 * 与真实现的差异必须写明，否则回放通过会给人虚假的安全感：
 *   - KNN 是暴力全扫描，不是 HNSW。近邻集合在 k 很小时可能不同（HNSW 是近似算法），
 *     但流水线只用它判阈值，暴力扫描只会更准，不会造成误判为通过。
 *   - 时间过滤先于 KNN（等价于真实现的 DIALECT 2 语义），少了 DIALECT 1 的陷阱。
 *   - 不做持久化、TTL、事务。store 节点写进去就只在内存里活到进程结束。
 *   - 浮点按 Float32 存取，和 HNSW 的 FLOAT32 字段对齐，避免「同一份数据回放在
 *     float64 下相似度略高一点点」这种跨环境漂移。
 */

export interface FakeRedisSeed {
  article: StoredArticle;
}

export interface FakeRedisHandle {
  client: RedisClient;
  /** 回放结束后用来核对「写了几条、写了哪些」 */
  snapshot: () => { docs: StoredArticle[]; seenKeys: string[] };
}

interface FtSearchOptions {
  PARAMS?: Record<string, unknown>;
  SORTBY?: { BY: string; DIRECTION: "ASC" | "DESC" };
  DIALECT?: number;
  RETURN?: string[];
  LIMIT?: { from: number; size: number };
}

function asFloat32(values: number[]): Float32Array {
  return new Float32Array(values);
}

/**
 * 把 KNN 查询里的向量参数解出来。
 *
 * 踩过的坑：`new Float32Array(buffer)` 不会把 Buffer 当字节视图，而是当数组来用，
 * 得到的是「一个长度等于字节数的 Float32Array，每个元素是一个字节」——
 * 维度从 256 变成 1024，匹配不到任何文档，KNN 静默返回空。真 Redis 不会这样，
 * 所以这个错误只会在回放里出现，而且表现为「语义去重不生效」而不是报错。
 */
function decodeVector(raw: unknown): number[] {
  if (raw instanceof Float32Array) return Array.from(raw);
  if (Buffer.isBuffer(raw)) {
    const view = new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
    return Array.from(view);
  }
  throw new Error("KNN 查询没带向量参数 vec，或者传的不是 Buffer");
}

function toStored(values: number[]): number[] {
  return Array.from(asFloat32(values));
}

export function createFakeRedis(seed: FakeRedisSeed[] = []): FakeRedisHandle {
  const docs = new Map<string, StoredArticle>();
  const strings = new Map<string, string>();
  const indexes = new Map<string, Set<string>>();

  for (const row of seed) {
    const stored: StoredArticle = { ...row.article, embedding: toStored(row.article.embedding) };
    docs.set(articleKey(stored.urlKey), stored);
    strings.set(seenKey(stored.urlKey), stored.urlKey);
  }

  function searchKnn(indexName: string, query: string, options: FtSearchOptions) {
    if (!indexes.has(indexName)) {
      // 真实现里索引不存在会直接报错；这里也报，省得「忘了建索引」变成静默空结果
      throw new Error(`索引 ${indexName} 不存在（回放里由 seed 自动建，检查 REDIS_INDEX 配置）`);
    }
    const k = Number(/\[KNN\s+(\d+)\s+@embedding\s+\$vec/.exec(query)?.[1] ?? options.LIMIT?.size ?? 0);
    const since = Number(/@pushedAt:\[(\d+)\s+\+inf\]/.exec(query)?.[1] ?? 0);
    const rawVector = options.PARAMS?.vec;
    const queryVector = decodeVector(rawVector);

    const scored = [...docs.values()]
      .filter((doc) => doc.embedding.length === queryVector.length)
      .filter((doc) => (since > 0 ? doc.pushedAt >= since : true))
      .map((doc) => {
        const cosine = cosineSimilarity(queryVector, doc.embedding);
        return { doc, vectorScore: 1 - cosine };
      })
      .sort((left, right) => left.vectorScore - right.vectorScore)
      .slice(0, Math.max(k, 0));

    return {
      total: scored.length,
      documents: scored.map((row) => ({
        id: articleKey(row.doc.urlKey),
        value: {
          urlKey: row.doc.urlKey,
          title: row.doc.title,
          source: row.doc.source,
          vectorScore: row.vectorScore,
        },
      })),
    };
  }

  function searchAll(indexName: string, query: string, options: FtSearchOptions) {
    if (!indexes.has(indexName)) throw new Error(`索引 ${indexName} 不存在`);
    const since = Number(/@pushedAt:\[(\d+)\s+\+inf\]/.exec(query)?.[1] ?? 0);
    const size = options.LIMIT?.size ?? 20;
    const rows = [...docs.values()]
      .filter((doc) => (since > 0 ? doc.pushedAt >= since : true))
      .sort((left, right) =>
        options.SORTBY?.DIRECTION === "ASC"
          ? left.pushedAt - right.pushedAt
          : right.pushedAt - left.pushedAt,
      )
      .slice(0, size);
    return {
      total: rows.length,
      documents: rows.map((doc) => ({
        id: articleKey(doc.urlKey),
        value: { urlKey: doc.urlKey, title: doc.title, source: doc.source },
      })),
    };
  }

  const client = {
    async exists(key: string): Promise<number> {
      if (strings.has(key)) return 1;
      if (docs.has(key)) return 1;
      return 0;
    },
    async set(key: string, value: string): Promise<string> {
      strings.set(key, value);
      return "OK";
    },
    async get(key: string): Promise<string | null> {
      return strings.get(key) ?? null;
    },
    json: {
      async set(key: string, _path: string, value: StoredArticle): Promise<string> {
        docs.set(key, { ...value, embedding: toStored(value.embedding ?? []) });
        return "OK";
      },
      async get(key: string): Promise<StoredArticle | null> {
        return docs.get(key) ?? null;
      },
    },
    ft: {
      async _list(): Promise<string[]> {
        return [...indexes.keys()];
      },
      async create(name: string): Promise<string> {
        if (!indexes.has(name)) indexes.set(name, new Set());
        return "OK";
      },
      async search(indexName: string, query: string, options: FtSearchOptions = {}) {
        return query.includes("@embedding")
          ? searchKnn(indexName, query, options)
          : searchAll(indexName, query, options);
      },
      async info(name: string) {
        return ["num_docs", docs.size, "hash_indexing_failures", 0, "index_name", name];
      },
    },
    async quit(): Promise<string> {
      return "OK";
    },
  };

  // 索引在 seed 之后就存在，等价于「上一个运行日已经建过索引」
  indexes.set("idx:article", new Set());

  return {
    client: client as unknown as RedisClient,
    snapshot: () => ({
      docs: [...docs.values()],
      seenKeys: [...strings.keys()].filter((key) => key.startsWith("seen:")),
    }),
  };
}
