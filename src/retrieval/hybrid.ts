import { log } from "../lib/logger.js";
import type { RedisClient } from "../redis/client.js";
import {
  enrichNeighbors,
  knnSearch,
  listSince,
  textSearch,
  type Neighbor,
} from "../redis/schema.js";
import { rrfFuse } from "./fusion.js";

export interface HybridSearchOptions {
  k: number;
  /** 0 表示不限时间 */
  sinceEpochSeconds: number;
}

/**
 * 两路召回：向量 + 标题关键词，再用 RRF 合并。
 *
 * 任何一路失败都不影响另一路；两路都空时退回按时间取最近条目。
 * 这样「Redis 文本查询语法不兼容」不会表现成「今天没有资讯」。
 */
export async function hybridSearch(
  client: RedisClient,
  indexName: string,
  vector: number[],
  question: string,
  options: HybridSearchOptions,
): Promise<Neighbor[]> {
  const keywordOptions = { k: options.k, sinceEpochSeconds: options.sinceEpochSeconds };

  const [vectorHits, keywordHits] = await Promise.all([
    vector.length > 0
      ? knnSearch(client, indexName, vector, keywordOptions).catch((error: unknown) => {
          log.warn("向量召回失败，继续走关键词通道", { reason: reasonOf(error) });
          return [] as Neighbor[];
        })
      : Promise.resolve([] as Neighbor[]),
    textSearch(client, indexName, question, keywordOptions).catch((error: unknown) => {
      log.warn("关键词召回失败，继续走向量通道", { reason: reasonOf(error) });
      return [] as Neighbor[];
    }),
  ]);

  let fused = rrfFuse([vectorHits, keywordHits], options.k);
  if (fused.length === 0) {
    fused = await listSince(client, indexName, options.sinceEpochSeconds, options.k);
  }

  return enrichNeighbors(client, fused);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
