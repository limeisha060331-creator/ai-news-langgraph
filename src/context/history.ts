import type { BaseMessage } from "@langchain/core/messages";

import { messageTextOf } from "../lib/conversation.js";
import { estimateTokens } from "./tokens.js";

export interface HistorySplitOptions {
  budget: number;
  keepRecent: number;
}

export interface HistorySplit {
  /** 需要交给摘要器的旧消息 */
  overflow: BaseMessage[];
  /** 原样保留的最近消息 */
  recent: BaseMessage[];
  historyTokens: number;
}

/** 消息本身之外还有角色标记和分隔符，按 4 个 token 计。 */
export function messageTokens(message: BaseMessage): number {
  return estimateTokens(messageTextOf(message)) + 4;
}

export function historyTokensOf(messages: BaseMessage[]): number {
  return messages.reduce((sum, message) => sum + messageTokens(message), 0);
}

/**
 * 超预算时切出「旧消息 / 最近消息」。
 *
 * 最近消息优先保留：它承载当前追问的指代关系，比旧摘要更值钱。
 * 如果最近窗口自己也超预算，从最旧的一条开始丢，但至少留两条
 * （一问一答），否则模型看不到任何上下文。
 */
export function splitHistory(
  messages: BaseMessage[],
  options: HistorySplitOptions,
): HistorySplit {
  const historyTokens = historyTokensOf(messages);
  if (historyTokens <= options.budget) {
    return { overflow: [], recent: messages, historyTokens };
  }

  let recent = messages.slice(-Math.max(2, options.keepRecent));
  while (recent.length > 2 && historyTokensOf(recent) > options.budget) {
    recent = recent.slice(1);
  }

  return {
    overflow: messages.slice(0, messages.length - recent.length),
    recent,
    historyTokens,
  };
}

/** 把最近的问答压成一段纯文本，作为回答层的「最近对话」。 */
export function renderHistory(messages: BaseMessage[], maxTokens: number): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = messageTextOf(message);
    if (!text) continue;
    lines.push(`${message.getType()}：${text}`);
  }

  const transcript = lines.join("\n");
  if (estimateTokens(transcript) <= maxTokens) return transcript;

  // 从最新一条往前装，保证最近的话一定在上下文里。
  const kept: string[] = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    const tokens = estimateTokens(line) + 1;
    if (used + tokens > maxTokens) break;
    kept.unshift(line);
    used += tokens;
  }
  return kept.join("\n");
}
