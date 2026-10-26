import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Annotation, END, START, StateGraph, type Runtime } from "@langchain/langgraph";

import { applyChatUsage, packEvidence, type ContextReport } from "../context/budget.js";
import { historyTokensOf, renderHistory, splitHistory } from "../context/history.js";
import { estimateTokens, truncateToTokens } from "../context/tokens.js";
import { createAnswerer, type Answerer } from "../lib/answer.js";
import {
  createConversationSummarizer,
  messageTextOf,
  type ConversationSummarizer,
} from "../lib/conversation.js";
import type { MemoryRuntime } from "../memory/runtime.js";
import {
  explicitPreference,
  readMemory,
  rememberProfile,
  writeEpisode,
} from "../memory/repository.js";
import type { Deps } from "../nodes/deps.js";
import { daysAgoEpochSeconds, type Neighbor } from "../redis/schema.js";
import { toEvidenceCards } from "../retrieval/evidence.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import type { EvidenceCard } from "../types.js";

export const ChatContext = Annotation.Root({
  userId: Annotation<string>({ reducer: (_current, update) => update, default: () => "default" }),
});

type ChatContextType = typeof ChatContext.State;

/** 压缩时允许改写 messages：数组表示追加，`replace` 表示换成裁剪后的窗口。 */
type MessagesUpdate = BaseMessage[] | { replace: BaseMessage[] };

export const ChatState = Annotation.Root({
  messages: Annotation<BaseMessage[], MessagesUpdate>({
    reducer: (current, update) =>
      Array.isArray(update) ? current.concat(update) : update.replace,
    default: () => [],
  }),
  summary: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  summaryVersion: Annotation<number>({
    reducer: (_current, update) => update,
    default: () => 0,
  }),
  question: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  memory: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  neighbors: Annotation<Neighbor[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  evidence: Annotation<EvidenceCard[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  contextReport: Annotation<ContextReport | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  answer: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  warnings: Annotation<string[]>({
    // 每轮由 loadMemory 重置，后面的节点读当前值再追加，避免旧警告跨轮残留。
    reducer: (_current, update) => update,
    default: () => [],
  }),
  sinceDays: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 }),
});

export type ChatStateType = typeof ChatState.State;
type ChatUpdate = typeof ChatState.Update;

export interface ChatGraphOptions {
  deps: Deps;
  memory: MemoryRuntime;
  answerer?: Answerer;
  summarizer?: ConversationSummarizer;
}

function lastHuman(messages: BaseMessage[]): BaseMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.getType() === "human") return messages[index];
  }
  return undefined;
}

/**
 * 追问经常只有「展开第二条」几个字，单靠它检索不到东西。
 * 短问题把上一条用户问题拼进来；长问题保持原样，避免污染检索。
 */
export function retrievalQueryOf(question: string, messages: BaseMessage[]): string {
  if (question.length > 24) return question;
  const lastIndex = messages.length - 1;
  for (let index = lastIndex - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.getType() !== "human") continue;
    const previous = messageTextOf(message);
    if (previous && previous !== question) {
      return `${previous} ${question}`.slice(0, 300);
    }
    break;
  }
  return question;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 对话图：记忆 → 检索 → 证据卡 → 压历史 → 回答 → 写记忆。
 *
 * 记忆分两层：
 *   checkpointer 保留线程内的消息和摘要，靠 thread_id 隔离；
 *   store 保留跨线程的偏好和结论，靠 userId 共享。
 * 回答层只拿「记忆 + 摘要 + 最近对话 + 证据卡」，不拿整段历史。
 */
export function buildChatGraph(options: ChatGraphOptions) {
  const { deps, memory } = options;
  const answerer = options.answerer ?? createAnswerer(deps.config, deps.httpOptions);
  const summarizer =
    options.summarizer ?? createConversationSummarizer(deps.config, deps.httpOptions);

  const memoryBudget = Math.floor(deps.config.CONTEXT_BUDGET * 0.1);
  const summaryBudget = Math.floor(deps.config.CONTEXT_BUDGET * 0.15);

  async function loadMemory(
    state: ChatStateType,
    runtime: Runtime<ChatContextType>,
  ): Promise<Partial<ChatUpdate>> {
    const questionMessage = lastHuman(state.messages);
    const question = questionMessage ? messageTextOf(questionMessage) : "";
    const userId = runtime.context?.userId ?? "default";
    const store = runtime.store ?? memory.store;

    try {
      const loaded = await readMemory(
        store,
        userId,
        deps.config.MEMORY_TOP_K,
        runtime.executionInfo?.threadId,
        question,
      );
      return {
        question,
        memory: truncateToTokens(loaded, memoryBudget),
        warnings: [],
      };
    } catch (error: unknown) {
      return {
        question,
        memory: "",
        warnings: [`长期记忆读取失败：${reasonOf(error)}`],
      };
    }
  }

  async function retrieve(state: ChatStateType): Promise<Partial<ChatUpdate>> {
    const query = retrievalQueryOf(state.question, state.messages);
    const [vector] = await deps.embedder.embed([query]);
    const sinceDays = state.sinceDays > 0 ? state.sinceDays : deps.config.HISTORY_DAYS;
    const neighbors = await hybridSearch(
      deps.redis,
      deps.config.REDIS_INDEX,
      vector ?? [],
      query,
      { k: deps.config.RETRIEVAL_TOP_K, sinceEpochSeconds: daysAgoEpochSeconds(sinceDays) },
    );
    return { neighbors };
  }

  async function buildEvidence(state: ChatStateType): Promise<Partial<ChatUpdate>> {
    const cards = toEvidenceCards(state.neighbors ?? [], deps.config.EVIDENCE_TOP_K);
    const packed = packEvidence(cards, deps.config.CONTEXT_BUDGET);
    return { evidence: packed.cards, contextReport: packed.report };
  }

  /**
   * 只有历史超过 CHAT_HISTORY_BUDGET 才压缩，避免每轮都花一次摘要调用。
   * 摘要失败时保留原消息，整轮照常回答，只在 warnings 里记一笔。
   */
  async function compressHistory(state: ChatStateType): Promise<Partial<ChatUpdate>> {
    const split = splitHistory(state.messages, {
      budget: deps.config.CHAT_HISTORY_BUDGET,
      keepRecent: deps.config.CHAT_KEEP_RECENT,
    });
    const usage = {
      historyTokens: split.historyTokens,
      summaryTokens: estimateTokens(state.summary),
      memoryTokens: estimateTokens(state.memory),
      summaryVersion: state.summaryVersion,
    };

    if (split.overflow.length === 0) {
      return {
        contextReport: state.contextReport
          ? applyChatUsage(state.contextReport, usage)
          : null,
      };
    }

    try {
      const summary = truncateToTokens(
        await summarizer.summarize(split.overflow, state.summary),
        summaryBudget,
      );
      if (!summary) throw new Error("摘要返回为空");

      return {
        messages: { replace: split.recent },
        summary,
        summaryVersion: state.summaryVersion + 1,
        contextReport: state.contextReport
          ? applyChatUsage(state.contextReport, {
              historyTokens: historyTokensOf(split.recent),
              summaryTokens: estimateTokens(summary),
              memoryTokens: usage.memoryTokens,
              summaryVersion: state.summaryVersion + 1,
            })
          : null,
      };
    } catch (error: unknown) {
      return {
        warnings: [...state.warnings, `对话摘要失败，保留原文：${reasonOf(error)}`],
      };
    }
  }

  async function compose(state: ChatStateType): Promise<Partial<ChatUpdate>> {
    const previous = state.messages.slice(0, -1);
    const history = renderHistory(previous, deps.config.CHAT_HISTORY_BUDGET);
    const answer = await answerer.answer(state.question, state.evidence, {
      memory: state.memory,
      summary: state.summary,
      history,
    });
    return { answer };
  }

  async function writeMemory(
    state: ChatStateType,
    runtime: Runtime<ChatContextType>,
  ): Promise<Partial<ChatUpdate>> {
    const userId = runtime.context?.userId ?? "default";
    const threadId = runtime.executionInfo?.threadId ?? "unknown";
    const store = runtime.store ?? memory.store;
    const warnings = [...state.warnings];

    if (state.answer) {
      const writes: Array<Promise<void>> = [
        writeEpisode(store, userId, threadId, state.question, state.answer),
      ];
      const preference = explicitPreference(state.question);
      if (preference) writes.push(rememberProfile(store, userId, preference));

      const results = await Promise.allSettled(writes);
      for (const result of results) {
        if (result.status === "rejected") {
          warnings.push(`长期记忆写入失败：${reasonOf(result.reason)}`);
        }
      }
    }

    return {
      warnings,
      ...(state.answer ? { messages: [new AIMessage(state.answer)] } : {}),
    };
  }

  return new StateGraph(ChatState, ChatContext)
    .addNode("loadMemory", loadMemory)
    .addNode("retrieve", retrieve)
    .addNode("buildEvidence", buildEvidence)
    .addNode("compressHistory", compressHistory)
    .addNode("compose", compose)
    .addNode("writeMemory", writeMemory)
    .addEdge(START, "loadMemory")
    .addEdge("loadMemory", "retrieve")
    .addEdge("retrieve", "buildEvidence")
    .addEdge("buildEvidence", "compressHistory")
    .addEdge("compressHistory", "compose")
    .addEdge("compose", "writeMemory")
    .addEdge("writeMemory", END)
    .compile({ checkpointer: memory.checkpointer, store: memory.store });
}
