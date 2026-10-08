import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";

/**
 * 对「中文标题 + 中文摘要」编码，而不是对英文原文编码。
 *
 * 这是跨语言去重能成立的原因：中英文两条讲同一件事的资讯，
 * 在摘要这一步已经被拉进同一个语言空间，向量距离才有意义。
 * 英文原文直接编码时，这两条的相似度只有 0.07 至 0.30，判不出来。
 */
export function createEmbedNode(deps: Deps) {
  return async function embedNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const items = state.articles;
    if (items.length === 0) {
      return { articles: items, stats: { embedded: 0 } };
    }

    const texts = items.map((article) =>
      `${article.titleZh ?? article.title} ${article.summary ?? article.raw}`.trim(),
    );

    try {
      const vectors = await deps.embedder.embed(texts);
      const articles = items.map((article, index) => ({
        ...article,
        embedding: vectors[index],
      }));
      const embedded = articles.filter((article) => article.embedding).length;
      log.info("编码完成", { count: embedded, provider: deps.embedder.name });
      return { articles, stats: { embedded } };
    } catch (error) {
      // 没有向量时 dedupe 会整体放行，宁可多推几条也不要因为编码服务故障丢内容
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("编码失败，跳过语义去重", { reason });
      return {
        articles: items.map((article) => ({ ...article, embedding: undefined })),
        warnings: [`语义去重跳过（编码失败）：${reason}`],
        stats: { embedded: 0 },
      };
    }
  };
}
