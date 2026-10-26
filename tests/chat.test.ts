import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { buildChatGraph } from "../src/graph/chat.js";
import { MockEmbeddingProvider } from "../src/lib/embedding.js";
import { MockSummarizer } from "../src/lib/llm.js";
import type { ConversationSummarizer } from "../src/lib/conversation.js";
import { rememberProfile } from "../src/memory/repository.js";
import type { MemoryRuntime } from "../src/memory/runtime.js";
import type { Deps } from "../src/nodes/deps.js";
import type { StoredArticle } from "../src/redis/schema.js";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    REDIS_URL: "redis://localhost:6379",
    REDIS_INDEX: "idx:test",
    USER_AGENT: "test-agent",
    FETCH_TIMEOUT_MS: 1000,
    FETCH_RETRIES: 0,
    MIN_PER_SOURCE: 1,
    TOP_N: 3,
    HISTORY_DAYS: 30,
    EMBEDDING_PROVIDER: "mock",
    EMBEDDING_BASE_URL: "",
    EMBEDDING_API_KEY: "",
    EMBEDDING_MODEL: "mock",
    EMBEDDING_DIM: 8,
    EMBEDDING_BATCH: 8,
    LLM_PROVIDER: "mock",
    LLM_BASE_URL: "",
    LLM_API_KEY: "",
    LLM_MODEL: "mock",
    LLM_TIMEOUT_MS: 1000,
    DUP_THRESHOLD: 0.9,
    GRAY_LOW: 0.8,
    SAME_SOURCE_MARGIN: 0.03,
    KNN_TOP_K: 5,
    RETRIEVAL_TOP_K: 20,
    EVIDENCE_TOP_K: 6,
    CONTEXT_BUDGET: 32000,
    MEMORY_PROVIDER: "memory",
    CHECKPOINT_TTL_DAYS: 30,
    MEMORY_TOP_K: 5,
    CHAT_HISTORY_BUDGET: 6000,
    CHAT_KEEP_RECENT: 4,
    ...overrides,
  };
}

const DOC: StoredArticle = {
  urlKey: "https://example.com/agent",
  url: "https://example.com/agent",
  title: "Agent 进展",
  titleZh: "Agent 进展",
  summary: "过去一周出现了新的 Agent 工具链。",
  source: "测试源",
  weight: 5,
  importance: 4,
  published: "2026-10-24T00:00:00Z",
  pushedAt: Math.floor(Date.now() / 1000),
  embedding: [1, 0, 0, 0, 0, 0, 0, 0],
};

function fakeRedis(): Deps["redis"] {
  return {
    ft: {
      search: async () => ({
        documents: [
          {
            id: "article:https://example.com/agent",
            value: {
              urlKey: DOC.urlKey,
              title: DOC.title,
              source: DOC.source,
              vectorScore: 0.2,
            },
          },
        ],
      }),
    },
    json: {
      get: async () => DOC,
    },
  } as unknown as Deps["redis"];
}

function fakeDeps(config: Config): Deps {
  return {
    config,
    redis: fakeRedis(),
    embedder: new MockEmbeddingProvider(config.EMBEDDING_DIM),
    summarizer: new MockSummarizer(),
    httpOptions: { userAgent: "test-agent", timeoutMs: 1000, retries: 0 },
    now: () => new Date("2026-10-26T00:00:00Z"),
  };
}

function memoryRuntime(): MemoryRuntime {
  return {
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
    close: async () => {},
  };
}

const runConfig = (threadId: string, userId = "u1") => ({
  configurable: { thread_id: threadId },
  context: { userId },
});

describe("对话图：线程记忆", () => {
  it("同一 thread 的上一轮问答会留在状态里，不同 thread 不串", async () => {
    const config = testConfig();
    const memory = memoryRuntime();
    const graph = buildChatGraph({ deps: fakeDeps(config), memory });

    const first = await graph.invoke(
      { messages: [new HumanMessage("过去一周 Agent 有哪些进展")] },
      runConfig("thread-a"),
    );
    const second = await graph.invoke(
      { messages: [new HumanMessage("展开说说第二条")] },
      runConfig("thread-a"),
    );
    const other = await graph.invoke(
      { messages: [new HumanMessage("过去一周 Agent 有哪些进展")] },
      runConfig("thread-b"),
    );

    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(4);
    expect(second.messages[0]?.content).toBe("过去一周 Agent 有哪些进展");
    expect(other.messages).toHaveLength(2);
    expect(second.answer).toContain("[E1]");
  });

  it("同一 user 跨 thread 能读到偏好，其他 user 读不到", async () => {
    const config = testConfig();
    const memory = memoryRuntime();
    await rememberProfile(memory.store, "u1", "关注 Agent 安全");
    const graph = buildChatGraph({ deps: fakeDeps(config), memory });

    const mine = await graph.invoke(
      { messages: [new HumanMessage("最近有什么进展")] },
      runConfig("thread-c", "u1"),
    );
    const other = await graph.invoke(
      { messages: [new HumanMessage("最近有什么进展")] },
      runConfig("thread-d", "u2"),
    );

    expect(mine.memory).toContain("关注 Agent 安全");
    expect(other.memory).toBe("");
  });

  it("明确说「记住」时写入长期偏好", async () => {
    const config = testConfig();
    const memory = memoryRuntime();
    const graph = buildChatGraph({ deps: fakeDeps(config), memory });

    await graph.invoke(
      { messages: [new HumanMessage("记住：我只看开源模型")] },
      runConfig("thread-e", "u3"),
    );
    const next = await graph.invoke(
      { messages: [new HumanMessage("继续")] },
      runConfig("thread-f", "u3"),
    );

    expect(next.memory).toContain("我只看开源模型");
  });
});

describe("对话图：历史压缩", () => {
  it("超过预算后摘要旧消息，只保留最近窗口", async () => {
    const config = testConfig({ CHAT_HISTORY_BUDGET: 40, CHAT_KEEP_RECENT: 2 });
    const memory = memoryRuntime();
    const graph = buildChatGraph({ deps: fakeDeps(config), memory });

    const result = await graph.invoke(
      {
        messages: [
          new HumanMessage("第一轮问题，".repeat(20)),
          new AIMessage("第一轮回答，".repeat(20)),
          new HumanMessage("第二轮问题，".repeat(20)),
          new AIMessage("第二轮回答，".repeat(20)),
          new HumanMessage("现在总结一下"),
        ],
      },
      runConfig("thread-long"),
    );

    expect(result.summaryVersion).toBe(1);
    expect(result.summary.length).toBeGreaterThan(0);
    expect(result.messages).toHaveLength(3); // 最近两轮 + 本轮回答
    expect(result.contextReport?.historyTokens).toBeGreaterThan(0);
    expect(result.contextReport?.summaryTokens).toBeGreaterThan(0);
    expect(result.contextReport?.summaryVersion).toBe(1);
  });

  it("摘要失败时保留最近对话，整轮照常回答", async () => {
    const config = testConfig({ CHAT_HISTORY_BUDGET: 40, CHAT_KEEP_RECENT: 2 });
    const memory = memoryRuntime();
    const broken: ConversationSummarizer = {
      name: "broken",
      summarize: async () => {
        throw new Error("模型超时");
      },
    };
    const graph = buildChatGraph({
      deps: fakeDeps(config),
      memory,
      summarizer: broken,
    });

    const result = await graph.invoke(
      {
        messages: [
          new HumanMessage("旧问题，".repeat(30)),
          new AIMessage("旧回答，".repeat(30)),
          new AIMessage("继续的上下文，".repeat(30)),
          new HumanMessage("现在回答我"),
        ],
      },
      runConfig("thread-broken"),
    );

    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.warnings.some((line) => line.includes("摘要失败"))).toBe(true);
    expect(result.messages).toHaveLength(5); // 原文没有被裁掉
  });
});
