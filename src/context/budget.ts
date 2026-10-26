import { estimateTokens } from "./tokens.js";
import type { EvidenceCard } from "../types.js";

export interface ContextReport {
  level: "L0" | "L1" | "L2" | "L3";
  budget: number;
  used: number;
  evidenceBudget: number;
  keptEvidence: number;
  droppedEvidence: number;
  estimated: true;
}

export interface PackedEvidence {
  cards: EvidenceCard[];
  report: ContextReport;
}

/**
 * 证据预算。
 *
 * 第一版只做「证据卡装包」：按分数从高到低放，放不下就跳过。
 * 这一步先保证回答上下文有上限，旧对话摘要和记忆预算在后面接。
 */
export function packEvidence(
  cards: EvidenceCard[],
  totalBudget = 32_000,
): PackedEvidence {
  const evidenceBudget = Math.floor(totalBudget * 0.4);
  let used = 0;
  const kept: EvidenceCard[] = [];
  let dropped = 0;

  for (const card of cards) {
    if (used + card.tokens > evidenceBudget) {
      dropped += 1;
      continue;
    }
    kept.push(card);
    used += card.tokens;
  }

  const ratio = totalBudget > 0 ? used / totalBudget : 0;
  const level: ContextReport["level"] =
    ratio < 0.4 ? "L0" : ratio < 0.65 ? "L1" : ratio < 0.85 ? "L2" : "L3";

  return {
    cards: kept,
    report: {
      level,
      budget: totalBudget,
      used,
      evidenceBudget,
      keptEvidence: kept.length,
      droppedEvidence: dropped,
      estimated: true,
    },
  };
}

export function renderEvidenceCard(card: EvidenceCard): string {
  return [
    `[${card.id}] ${card.title}`,
    `来源：${card.source}${card.published ? ` · ${card.published}` : ""}`,
    `摘要：${card.summary || "（无摘要）"}`,
    `链接：${card.url}`,
  ].join("\n");
}

export function renderEvidenceCards(cards: EvidenceCard[]): string {
  return cards.map(renderEvidenceCard).join("\n\n");
}

export { estimateTokens };
