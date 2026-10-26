import { estimateTokens } from "../context/tokens.js";
import type { Neighbor } from "../redis/schema.js";
import type { EvidenceCard } from "../types.js";

function truncate(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 1)}…`;
}

/**
 * 把检索命中压成证据卡。
 *
 * 同一 urlKey 只保留一条；排序按融合分，分数相同再按相似度。
 * 摘要截到 240 字，避免一条长摘要吃掉整个证据预算。
 */
export function toEvidenceCards(neighbors: Neighbor[], limit: number): EvidenceCard[] {
  const seen = new Set<string>();
  const rows = [...neighbors]
    .filter((row) => row.urlKey && !seen.has(row.urlKey) && seen.add(row.urlKey))
    .sort(
      (left, right) =>
        (right.fusedScore ?? right.similarity) - (left.fusedScore ?? left.similarity),
    )
    .slice(0, limit);

  return rows.map((row, index) => {
    const summary = truncate(row.summary ?? "", 240);
    const card: EvidenceCard = {
      id: `E${index + 1}`,
      title: row.title || "（无标题）",
      summary,
      url: row.url ?? "",
      source: row.source || "未知来源",
      published: row.published ?? "",
      importance: row.importance ?? 0,
      similarity: row.similarity,
      score: row.fusedScore ?? row.similarity,
      tokens: 0,
    };
    card.tokens = estimateTokens(
      `${card.id} ${card.title} ${card.source} ${card.published} ${card.summary} ${card.url}`,
    );
    return card;
  });
}
