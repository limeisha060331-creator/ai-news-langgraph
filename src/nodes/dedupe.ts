import type { Article, DroppedItem } from "../types.js";
import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";
import { cosineSimilarity } from "../lib/embedding.js";
import { daysAgoEpochSeconds, knnSearch } from "../redis/schema.js";

interface BestMatch {
  score: number;
  urlKey: string;
  source: string;
  scope: "history" | "batch";
}

/**
 * 语义去重：和「历史已推送」以及「本批已保留」比余弦相似度。
 *
 * 阈值分两段而不是一刀切：
 *   score >= dupThreshold  判重丢弃
 *   score >= grayLow       保留但标记，交给日报阶段裁决
 * 同源条目阈值再加严一点，因为同一家媒体的连载（Rust 1.90 / 1.91）用词天然接近。
 *
 * 默认 0.90 / 0.80 是在本地词法编码器上标出来的。换 embedding 模型之后这两个数
 * 对应的含义完全变了，必须跑 `npm run calibrate` 重新量。
 */
export function createDedupeNode(deps: Deps) {
  return async function dedupeNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const { DUP_THRESHOLD, GRAY_LOW, SAME_SOURCE_MARGIN, KNN_TOP_K, HISTORY_DAYS, REDIS_INDEX } =
      deps.config;
    const since = daysAgoEpochSeconds(HISTORY_DAYS);

    const kept: Article[] = [];
    const dropped: DroppedItem[] = [];
    const warnings: string[] = [];
    let suspects = 0;
    let knnFailures = 0;

    for (const article of state.articles) {
      // 没有向量就不判重：宁可漏判一条重复，也不要因为编码缺失误杀一条独家
      if (!article.embedding) {
        kept.push(article);
        continue;
      }

      let best: BestMatch = { score: 0, urlKey: "", source: "", scope: "history" };

      try {
        const neighbors = await knnSearch(deps.redis, REDIS_INDEX, article.embedding, {
          k: KNN_TOP_K,
          sinceEpochSeconds: since,
        });
        for (const neighbor of neighbors) {
          if (neighbor.urlKey === article.urlKey) continue;
          if (neighbor.similarity > best.score) {
            best = {
              score: neighbor.similarity,
              urlKey: neighbor.urlKey,
              source: neighbor.source,
              scope: "history",
            };
          }
        }
      } catch (error) {
        knnFailures += 1;
        if (knnFailures === 1) {
          const reason = error instanceof Error ? error.message : String(error);
          warnings.push(`语义去重部分跳过（KNN 查询失败）：${reason}`);
        }
      }

      for (const other of kept) {
        if (!other.embedding) continue;
        const score = cosineSimilarity(article.embedding, other.embedding);
        if (score > best.score) {
          best = { score, urlKey: other.urlKey, source: other.source, scope: "batch" };
        }
      }

      const sameSource = best.source !== "" && best.source === article.source;
      const threshold = DUP_THRESHOLD + (sameSource ? SAME_SOURCE_MARGIN : 0);

      if (best.urlKey && best.score >= threshold) {
        dropped.push({
          urlKey: article.urlKey,
          title: article.title,
          source: article.source,
          reason: "semantic-duplicate",
          score: Math.round(best.score * 10000) / 10000,
          matchedUrl: best.urlKey,
          scope: best.scope,
        });
        continue;
      }

      if (best.urlKey && best.score >= GRAY_LOW) {
        suspects += 1;
        kept.push({
          ...article,
          semantic: {
            score: Math.round(best.score * 10000) / 10000,
            similarTo: best.urlKey,
            scope: best.scope,
            action: "suspect",
          },
        });
        continue;
      }

      kept.push(article);
    }

    const semanticDropped = dropped.filter((row) => row.reason === "semantic-duplicate").length;
    log.info("语义去重完成", {
      before: state.articles.length,
      after: kept.length,
      dropped: semanticDropped,
      suspects,
      dupThreshold: DUP_THRESHOLD,
      grayLow: GRAY_LOW,
    });

    return {
      articles: kept,
      dropped,
      warnings,
      stats: { semanticDropped, semanticSuspect: suspects },
    };
  };
}
