import { describe, expect, it } from "vitest";

import type { Config } from "../src/config.js";
import { buildQueryGraph } from "../src/graph/query.js";
import { packEvidence } from "../src/context/budget.js";
import { MockEmbeddingProvider } from "../src/lib/embedding.js";
import { MockSummarizer } from "../src/lib/llm.js";
import type { Deps } from "../src/nodes/deps.js";
import type { Neighbor, StoredArticle } from "../src/redis/schema.js";
import { articleKey } from "../src/redis/schema.js";
import { toEvidenceCards } from "../src/retrieval/evidence.js";
import { rrfFuse } from "../src/retrieval/fusion.js";

function neighbor(overrides: Partial<Neighbor> = {}): Neighbor {
  return {
    urlKey: "https://example.com/a",
    title: "OpenAI 发布新模型",
    source: "OpenAI Blog",
    url: "https://example.com/a",
    summary: "OpenAI 发布了一个新模型，重点提升推理能力。",
    published: "2026-10-24T00:00:00Z",
    importance: 4,
    similarity: 0.8,
    ...overrides,
  };
}

function testConfig(): Config {
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
  };
}

describe("RRF 融合", () => {
  it("两路都命中的条目排在只命中一路的前面", () => {
    const both = neighbor({ urlKey: "both" });
    const onlyVector = neighbor({ urlKey: "vector", title: "只被向量召回" });
    const onlyKeyword = neighbor({ urlKey: "keyword", title: "只被关键词召回" });

    const fused = rrfFuse(
      [
        [onlyVector, both],
        [onlyKeyword, both],
      ],
      3,
    );

    expect(fused[0]?.urlKey).toBe("both");
    expect(fused).toHaveLength(3);
  });
});

describe("证据卡", () => {
  it("保留摘要、链接和日期，并给出 E 编号", () => {
    const cards = toEvidenceCards([neighbor()], 3);
    expect(cards[0]).toMatchObject({
      id: "E1",
      title: "OpenAI 发布新模型",
      url: "https://example.com/a",
      summary: "OpenAI 发布了一个新模型，重点提升推理能力。",
    });
    expect(cards[0]!.tokens).toBeGreaterThan(0);
  });

  it("同一 urlKey 只保留一条", () => {
    const cards = toEvidenceCards(
      [neighbor(), neighbor({ title: "重复标题" })],
      3,
    );
    expect(cards).toHaveLength(1);
  });
});

describe("证据预算", () => {
  it("超过预算的卡片被丢弃，报告里能看出来", () => {
    const cards = toEvidenceCards(
      [
        neighbor({ urlKey: "a", summary: "甲".repeat(400) }),
        neighbor({ urlKey: "b", summary: "乙".repeat(400) }),
      ],
      3,
    );
    const packed = packEvidence(cards, 100);
    expect(packed.cards.length).toBeLessThan(cards.length);
    expect(packed.report.droppedEvidence).toBeGreaterThan(0);
    expect(packed.report.estimated).toBe(true);
  });
});

function fakeRedis(docs: StoredArticle[]): Deps["redis"] {
  const byKey = new Map(docs.map((doc) => [articleKey(doc.urlKey), doc]));
  return {
    ft: {
      search: async (_index: string, query: string) => {
        const rows = query.includes("@embedding")
          ? docs
          : query.includes("@title")
            ? docs.slice(0, 1)
            : [];
        return {
          documents: rows.map((doc) => ({
            id: `article:${doc.urlKey}`,
            value: {
              urlKey: doc.urlKey,
              title: doc.title,
              source: doc.source,
              vectorScore: 0.2,
            },
          })),
        };
      },
    },
    json: {
      get: async (key: string) => {
        return byKey.get(key) ?? null;
      },
    },
  } as unknown as Deps["redis"];
}

describe("查询图", () => {
  it("从混合召回到证据卡再到带引用的 mock 回答", async () => {
    const config = testConfig();
    const docs: StoredArticle[] = [
      {
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
      },
    ];
    const deps: Deps = {
      config,
      redis: fakeRedis(docs),
      embedder: new MockEmbeddingProvider(config.EMBEDDING_DIM),
      summarizer: new MockSummarizer(),
      httpOptions: { userAgent: "test-agent", timeoutMs: 1000, retries: 0 },
      now: () => new Date("2026-10-26T00:00:00Z"),
    };

    const graph = buildQueryGraph(deps);
    const result = await graph.invoke({ question: "过去一周 Agent 有哪些进展", sinceDays: 7 });

    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.url).toBe("https://example.com/agent");
    expect(result.answer).toContain("[E1]");
    expect(result.contextReport).not.toBeNull();
  });
});
