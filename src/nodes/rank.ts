import type { Article, DroppedItem } from "../types.js";
import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";

/**
 * 排序与截断：先按来源权重、再按热度，然后给每个源留出保底名额，最后卡总量上限。
 *
 * 配额不能省。三个源的产量差两个数量级（HN 30 条、OpenAI 归档 feed 一千多条），
 * 只按分数排的话，产量大的源会把其他源整块挤掉，日报就变成单源播报。
 */
export function createRankNode(deps: Deps) {
  return async function rankNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const { MIN_PER_SOURCE: minPerSource, TOP_N: topN } = deps.config;
    const sorted = [...state.articles].sort(
      (left, right) => right.weight - left.weight || right.score - left.score,
    );

    const picked: Article[] = [];
    const overflow: Article[] = [];
    const perSource = new Map<string, number>();

    for (const article of sorted) {
      const used = perSource.get(article.source) ?? 0;
      if (used < minPerSource) {
        picked.push(article);
        perSource.set(article.source, used + 1);
      } else {
        overflow.push(article);
      }
    }

    const room = Math.max(0, topN - picked.length);
    picked.push(...overflow.slice(0, room));
    const selected = picked.slice(0, topN);
    const selectedKeys = new Set(selected.map((article) => article.urlKey));
    const dropped: DroppedItem[] = overflow
      .filter((article) => !selectedKeys.has(article.urlKey))
      .map((article) => ({
        urlKey: article.urlKey,
        title: article.title,
        source: article.source,
        reason: "overflow" as const,
      }));

    log.info("排序与截断完成", {
      before: sorted.length,
      selected: selected.length,
      overflow: dropped.length,
      bySource: selected.reduce<Record<string, number>>((accumulator, article) => {
        accumulator[article.source] = (accumulator[article.source] ?? 0) + 1;
        return accumulator;
      }, {}),
    });

    return { articles: selected, dropped, stats: { selected: selected.length } };
  };
}
