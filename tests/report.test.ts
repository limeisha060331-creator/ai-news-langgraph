import { describe, expect, it } from "vitest";

import { renderReport } from "../src/lib/report.js";
import type { Article } from "../src/types.js";

function article(overrides: Partial<Article>): Article {
  return {
    urlKey: "https://example.com/a",
    url: "https://example.com/a",
    title: "Original title",
    source: "HN",
    weight: 3,
    score: 0,
    published: "",
    raw: "",
    ...overrides,
  };
}

describe("renderReport", () => {
  const articles = [
    article({
      urlKey: "https://openai.com/index/gpt-5",
      url: "https://openai.com/index/gpt-5",
      titleZh: "OpenAI 发布 GPT-5",
      summary: "OpenAI 今天发布 GPT-5。",
      importance: 5,
      source: "OpenAI Blog",
    }),
    article({
      urlKey: "https://example.com/small",
      url: "https://example.com/small",
      titleZh: "一个边缘项目",
      summary: "了解即可。",
      importance: 1,
    }),
  ];

  it("按评分分档，且每条只出现一次", () => {
    const markdown = renderReport(articles, "2026-10-08");
    expect(markdown).toContain("# AI 日报 · 2026-10-08");
    expect(markdown).toContain("## 今日头条");
    expect(markdown).toContain("## 值得关注");
    expect(markdown.match(/OpenAI 发布 GPT-5/g)).toHaveLength(2); // 正文一次 + 链接汇总一次
  });

  it("空的分档写「今日无」，不删标题", () => {
    const markdown = renderReport([articles[1]!], "2026-10-08");
    expect(markdown).toContain("## 今日头条");
    expect(markdown).toContain("今日无");
  });

  it("保留原文链接原样输出", () => {
    const markdown = renderReport(articles, "2026-10-08");
    expect(markdown).toContain("(https://openai.com/index/gpt-5)");
  });
});
