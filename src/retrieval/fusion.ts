import type { Neighbor } from "../redis/schema.js";

/**
 * Reciprocal Rank Fusion。
 *
 * 向量分和关键词分不在一个量纲上，直接相加会让某一路的分数主导结果。
 * RRF 只看名次，不看原始分数，适合先做「两路都召回」的稳定基线。
 */
export function rrfFuse(lists: Neighbor[][], limit: number, rankConstant = 60): Neighbor[] {
  const merged = new Map<string, Neighbor>();

  for (const list of lists) {
    list.forEach((row, index) => {
      if (!row.urlKey) return;
      const current = merged.get(row.urlKey);
      const increment = 1 / (rankConstant + index + 1);
      if (!current) {
        merged.set(row.urlKey, { ...row, fusedScore: increment });
        return;
      }
      merged.set(row.urlKey, {
        ...current,
        title: current.title || row.title,
        source: current.source || row.source,
        url: current.url ?? row.url,
        summary: current.summary ?? row.summary,
        published: current.published ?? row.published,
        importance: current.importance ?? row.importance,
        similarity: Math.max(current.similarity, row.similarity),
        keywordScore: Math.max(current.keywordScore ?? 0, row.keywordScore ?? 0),
        fusedScore: (current.fusedScore ?? 0) + increment,
      });
    });
  }

  return [...merged.values()]
    .sort((left, right) => (right.fusedScore ?? 0) - (left.fusedScore ?? 0))
    .slice(0, limit);
}
