import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";
import { upsertMany, type StoredArticle } from "../redis/schema.js";

/**
 * 写回跨天状态。这一步在图上挂的是 deliver 的下游，且只在送达成功后才走到——
 * 推送失败却写了历史，那些内容第二天会被当成「已经推过」而永远消失。
 */
export function createStoreNode(deps: Deps) {
  return async function storeNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const pushedAt = Math.floor(deps.now().getTime() / 1000);
    const rows: StoredArticle[] = state.articles.map((article) => ({
      urlKey: article.urlKey,
      url: article.url,
      title: article.title,
      titleZh: article.titleZh,
      summary: article.summary,
      source: article.source,
      weight: article.weight,
      importance: article.importance,
      published: article.published,
      pushedAt,
      embedding: article.embedding ?? [],
    }));

    try {
      const written = await upsertMany(deps.redis, rows);
      log.info("历史写回完成", { written, withVector: rows.filter((row) => row.embedding.length > 0).length });
      return { stats: { stored: written } };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error("历史写回失败", { reason });
      return { warnings: [`历史写回失败：${reason}`] };
    }
  };
}
