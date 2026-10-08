import { afterEach, describe, expect, it, vi } from "vitest";

import { buildIngestionGraph } from "../src/graph/ingestion.js";
import type { IngestionStateType } from "../src/graph/state.js";
import type { Deps } from "../src/nodes/deps.js";
import { MockEmbeddingProvider } from "../src/lib/embedding.js";
import { MockSummarizer } from "../src/lib/llm.js";
import type { Config } from "../src/config.js";

const HN_BODY = JSON.stringify({
  hits: [
    {
      objectID: "1",
      title: "OpenAI ships something",
      url: "https://openai.com/index/something/?utm_source=hn",
      points: 120,
      created_at: "2026-10-08T00:00:00Z",
    },
    {
      // 与上一条归一化之后是同一个链接，必须被批内去重拦掉
      objectID: "2",
      title: "OpenAI ships something (dup)",
      url: "https://www.openai.com/index/something/",
      points: 80,
      created_at: "2026-10-08T01:00:00Z",
    },
  ],
});

function rssBody(prefix: string, count: number): string {
  const items = Array.from({ length: count }, (_, index) => {
    return (
      `<item><title>${prefix} ${index}</title>` +
      `<link>https://example.com/${prefix}/${index}</link>` +
      `<description>关于 ${prefix} 的第 ${index} 条</description>` +
      "<pubDate>Wed, 08 Oct 2026 00:00:00 GMT</pubDate></item>"
    );
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel>${items}</channel></rss>`;
}

function fakeConfig(): Config {
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
    EMBEDDING_DIM: 64,
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
  };
}

/**
 * 假的 Redis：只实现节点实际用到的几个命令。
 * 历史始终为空，所以这条用例验证的是「抓取 → 归一化 → 截断 → 摘要 → 编码 → 去重 → 出日报 → 写回」
 * 这条链路本身跑不跑得通，而不是召回质量。
 */
function fakeRedis(): Deps["redis"] {
  return {
    exists: async () => 0,
    set: async () => "OK",
    json: { set: async () => "OK" },
    ft: { search: async () => ({ documents: [] }) },
  } as unknown as Deps["redis"];
}

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  const config = fakeConfig();
  return {
    config,
    redis: fakeRedis(),
    embedder: new MockEmbeddingProvider(config.EMBEDDING_DIM),
    summarizer: new MockSummarizer(),
    httpOptions: { userAgent: "test-agent", timeoutMs: 1000, retries: 0 },
    now: () => new Date("2026-10-08T09:00:00Z"),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("摄入图端到端", () => {
  it("跑完整条链路并落盘日报", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.includes("hn.algolia.com")
          ? HN_BODY
          : url.includes("qbitai")
            ? rssBody("qbitai", 1)
            : rssBody("openai", 2);
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
      }),
    );

    const graph = buildIngestionGraph(fakeDeps());
    const result = (await graph.invoke({ runDate: "2026-10-08" })) as IngestionStateType;

    expect(result.stats.fetched).toBe(5); // HN 2 + OpenAI 2 + 量子位 1
    expect(result.stats.afterUrlDedup).toBe(4); // HN 两条经归一化后是同一条
    expect(result.stats.selected).toBe(3); // 受 TOP_N 限制
    expect(result.stats.summarized).toBe(3);
    expect(result.stats.embedded).toBe(3);
    expect(result.stats.delivered).toBe(3);
    expect(result.stats.stored).toBe(3);
    expect(result.delivered).toBe(true);
    expect(result.report).toContain("# AI 日报 · 2026-10-08");
    expect(result.report).toContain("## 链接汇总");
    expect(result.report).toContain("(https://openai.com/index/something)");
  });

  it("单源失败不影响其他源", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("qbitai")) {
          return { ok: false, status: 403, text: async () => "" } as unknown as Response;
        }
        const body = url.includes("hn.algolia.com") ? HN_BODY : rssBody("openai", 2);
        return { ok: true, status: 200, text: async () => body } as unknown as Response;
      }),
    );

    const graph = buildIngestionGraph(fakeDeps());
    const result = (await graph.invoke({ runDate: "2026-10-08" })) as IngestionStateType;

    expect(result.stats.bySource?.["量子位"]).toBe(0);
    expect(result.stats.fetched).toBeGreaterThan(0);
    expect(result.warnings.some((line) => line.includes("量子位"))).toBe(true);
    expect(result.delivered).toBe(true);
  });

  it("没有新条目时不出日报，也不写历史", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, text: async () => rssBody("empty", 0) }) as unknown as Response),
    );

    const graph = buildIngestionGraph(fakeDeps());
    const result = (await graph.invoke({ runDate: "2026-10-08" })) as IngestionStateType;

    expect(result.stats.fetched).toBe(0);
    expect(result.delivered).toBe(false);
    expect(result.stats.stored).toBe(0);
  });
});
