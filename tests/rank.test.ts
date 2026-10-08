import { describe, expect, it } from "vitest";

import { createRankNode } from "../src/nodes/rank.js";
import type { Deps } from "../src/nodes/deps.js";
import type { Article, DroppedItem } from "../src/types.js";
import type { IngestionStateType } from "../src/graph/state.js";

function article(source: string, weight: number, score: number, index: number): Article {
  return {
    urlKey: `https://example.com/${source}/${index}`,
    url: `https://example.com/${source}/${index}`,
    title: `${source} ${index}`,
    source,
    weight,
    score,
    published: "",
    raw: "",
  };
}

function fakeDeps(minPerSource: number, topN: number): Deps {
  return { config: { MIN_PER_SOURCE: minPerSource, TOP_N: topN } } as unknown as Deps;
}

function stateOf(articles: Article[]): IngestionStateType {
  return { articles } as unknown as IngestionStateType;
}

describe("rank 节点", () => {
  it("产量大的源不能挤掉其他源", async () => {
    // 这正是线上遇到的情况：OpenAI 的归档 feed 一次给一千多条，另外两个源只有几十条。
    // 只按权重排的话，HN 和量子位会被整块挤掉。
    const articles = [
      ...Array.from({ length: 40 }, (_, index) => article("OpenAI Blog", 5, 0, index)),
      ...Array.from({ length: 5 }, (_, index) => article("HN", 3, 300 - index, index)),
    ];
    const node = createRankNode(fakeDeps(3, 15));
    const result = await node(stateOf(articles));
    const selected = result.articles as Article[];
    const sources = new Set(selected.map((row) => row.source));
    expect(sources.has("HN")).toBe(true);
    expect(selected).toHaveLength(15);
  });

  it("高权重优先，同权重按热度排", async () => {
    const articles = [
      article("HN", 3, 500, 1),
      article("OpenAI Blog", 5, 0, 2),
      article("HN", 3, 10, 3),
    ];
    const node = createRankNode(fakeDeps(1, 15));
    const result = await node(stateOf(articles));
    expect((result.articles as Article[]).map((row) => row.urlKey)).toEqual([
      "https://example.com/OpenAI Blog/2",
      "https://example.com/HN/1",
      "https://example.com/HN/3",
    ]);
  });

  it("超出上限的条目记成 overflow，不是静默丢掉", async () => {
    const articles = Array.from({ length: 20 }, (_, index) => article("HN", 3, index, index));
    const node = createRankNode(fakeDeps(1, 5));
    const result = await node(stateOf(articles));
    expect(result.articles as Article[]).toHaveLength(5);
    expect(
      (result.dropped as DroppedItem[]).filter((row) => row.reason === "overflow"),
    ).toHaveLength(15);
  });
});
