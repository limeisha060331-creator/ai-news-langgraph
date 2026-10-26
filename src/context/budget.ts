import { estimateTokens } from "./tokens.js";
import type { EvidenceCard } from "../types.js";

export interface ContextReport {
  level: "L0" | "L1" | "L2" | "L3";
  budget: number;
  used: number;
  evidenceBudget: number;
  keptEvidence: number;
  droppedEvidence: number;
  /** 对话历史估算 token；查询图没有这个字段 */
  historyTokens?: number;
  /** 摘要估算 token */
  summaryTokens?: number;
  /** 长期记忆估算 token */
  memoryTokens?: number;
  summaryVersion?: number;
  estimated: true;
}

export interface PackedEvidence {
  cards: EvidenceCard[];
  report: ContextReport;
}

export interface ChatUsage {
  historyTokens: number;
  summaryTokens: number;
  memoryTokens: number;
  summaryVersion: number;
}

function levelOf(used: number, budget: number): ContextReport["level"] {
  const ratio = budget > 0 ? used / budget : 0;
  return ratio < 0.4 ? "L0" : ratio < 0.65 ? "L1" : ratio < 0.85 ? "L2" : "L3";
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

  return {
    cards: kept,
    report: {
      level: levelOf(used, totalBudget),
      budget: totalBudget,
      used,
      evidenceBudget,
      keptEvidence: kept.length,
      droppedEvidence: dropped,
      estimated: true,
    },
  };
}

/**
 * 把历史、摘要和记忆的用量补进同一份报告。
 *
 * `used` 改成正文字段总和，档位也随之重算。这样 `--explain-context`
 * 看到的是一个总账，而不是「证据 3k，实际上下文 20k」的两套数字。
 */
export function applyChatUsage(report: ContextReport, usage: ChatUsage): ContextReport {
  const used =
    report.used + usage.historyTokens + usage.summaryTokens + usage.memoryTokens;
  return {
    ...report,
    ...usage,
    used,
    level: levelOf(used, report.budget),
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
