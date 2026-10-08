import type { Article } from "../types.js";
import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";

function fallback(article: Article): Article {
  return {
    ...article,
    titleZh: article.title,
    summary: article.raw ? article.raw.slice(0, 120) : "（摘要缺失，仅保留标题与链接）",
    importance: Math.min(5, Math.max(1, article.weight)),
    summaryDegraded: true,
  };
}

/**
 * 逐条结构化摘要。这是第一版最大的结构差异：
 * 那边是让模型一次写完整篇 Markdown，摘要就成了日报的副产品，
 * 既没法统计「摘要可用率」，模型跑偏也没有地方拦住。
 * 拆成「逐条 JSON → 代码组装日报」之后，摘要字段本身可测，格式也不靠模型自觉。
 */
export function createSummarizeNode(deps: Deps) {
  return async function summarizeNode(
    state: IngestionStateType,
  ): Promise<Partial<IngestionUpdate>> {
    const items = state.articles;
    if (items.length === 0) {
      return { articles: items, stats: { summarized: 0, summaryDegraded: 0 } };
    }

    try {
      const results = await deps.summarizer.summarize(items);
      const byKey = new Map(results.map((row) => [row.urlKey, row]));
      const articles = items.map((article) => {
        const row = byKey.get(article.urlKey);
        if (!row) return fallback(article);
        return {
          ...article,
          titleZh: row.titleZh,
          summary: row.summary,
          importance: row.importance,
          summaryDegraded: row.degraded,
        };
      });
      const degraded = articles.filter((article) => article.summaryDegraded).length;
      log.info("摘要完成", { count: articles.length, degraded, model: deps.summarizer.name });
      return { articles, stats: { summarized: articles.length, summaryDegraded: degraded } };
    } catch (error) {
      // 整批摘要失败时逐条降级，保住标题和链接，不要把当天的日报整个丢掉
      const reason = error instanceof Error ? error.message : String(error);
      log.warn("摘要失败，整批降级为标题加链接", { reason });
      return {
        articles: items.map(fallback),
        warnings: [`摘要失败：${reason}`],
        stats: { summarized: items.length, summaryDegraded: items.length },
      };
    }
  };
}
