import { describe, expect, it } from "vitest";

import { renderReport, SECTIONS } from "../src/lib/report.js";
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

/** 造 n 条同分条目，用来把某一档灌满。 */
function many(count: number, importance: number, prefix = ""): Article[] {
  return Array.from({ length: count }, (_, index) =>
    article({
      urlKey: `https://example.com/${prefix}${index}`,
      url: `https://example.com/${prefix}${index}`,
      titleZh: `${prefix}${index} 号条目`,
      summary: "摘要",
      importance,
    }),
  );
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
    const { markdown } = renderReport(articles, "2026-10-08");
    expect(markdown).toContain("# AI 日报 · 2026-10-08");
    expect(markdown).toContain("## 今日头条");
    expect(markdown).toContain("## 值得关注");
    expect(markdown.match(/OpenAI 发布 GPT-5/g)).toHaveLength(2); // 正文一次 + 链接汇总一次
  });

  it("空的分档写「今日无」，不删标题", () => {
    const { markdown } = renderReport([articles[1]!], "2026-10-08");
    expect(markdown).toContain("## 今日头条");
    expect(markdown).toContain("今日无");
  });

  it("保留原文链接原样输出", () => {
    const { markdown } = renderReport(articles, "2026-10-08");
    expect(markdown).toContain("(https://openai.com/index/gpt-5)");
  });

  /**
   * 下面三条守的是「日报必须覆盖送达集合」这个不变量。
   *
   * 之前这里有过一个静默丢内容的问题：三个分档的 limit 之和是 13，而「今日头条」
   * 是「重要进展」的子集，4 至 5 分条目进正文的容量只有 7；送达 15 条时最多 8 条
   * 既不进正文也不进汇总，却照样被 store 写回历史，第二天不再出现。
   */
  it("正文有条数上限，超出的全部进链接汇总", () => {
    const rows = many(15, 5, "高分");
    const { markdown, placed, listed } = renderReport(rows, "2026-10-08");

    const bodyCapacity = SECTIONS[0]!.limit + SECTIONS[1]!.limit; // 今日头条与重要进展从同一池子取
    expect(placed).toHaveLength(bodyCapacity);
    expect(placed).toHaveLength(7);
    expect(listed).toHaveLength(15);
    expect(markdown).toContain("> 共 15 条 · 正文精选 7 条");
    expect(markdown.match(/^- \[/gm)).toHaveLength(15);
  });

  it("混合分布下也不丢条（曾经的丢条现场：13 条送达只列 10 条）", () => {
    const rows = [...many(7, 5, "a"), ...many(3, 4, "b"), ...many(3, 3, "c")];
    const { markdown, placed, listed } = renderReport(rows, "2026-10-08");

    expect(rows).toHaveLength(13);
    expect(placed).toHaveLength(10); // 2 条头条 + 5 条重要进展 + 3 条值得关注
    expect(listed).toHaveLength(13);
    expect(new Set(listed).size).toBe(13);
    expect(markdown.match(/^- \[/gm)).toHaveLength(13);
  });

  it("链接汇总先列正文里的，再列只在汇总里的", () => {
    const rows = many(15, 5, "d");
    const { placed, listed } = renderReport(rows, "2026-10-08");
    expect(listed.slice(0, placed.length)).toEqual(placed);
    expect(listed.length).toBeGreaterThan(placed.length);
  });
});
