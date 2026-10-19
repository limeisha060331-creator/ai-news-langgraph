import type { FixtureItem } from "./fixture.js";

/**
 * 把 fixture 里的条目字段渲染成源站的线上格式。
 *
 * 这一层存在的理由：fetch 节点解析的是「HN Algolia 的 JSON」和「RSS 2.0 的 XML」，
 * 如果 fixture 直接存这些格式，改一条用例就得在转义字符串里翻。
 * 代价是这里渲染得跟真实响应不完全一样（顺序、命名空间、可选字段），
 * 所以它只覆盖 fetch + parse 真正会读到的字段；真实响应体的形状差异由
 * `npm run harness -- --capture` 之外的冒烟脚本负责，不在回放的范围里。
 */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** HN：Algolia 的 front_page 响应。url 为空时按 text post 处理——url 置 null，让代码去拼讨论页。 */
export function renderHnBody(items: FixtureItem[]): string {
  const hits = items.map((item, index) => ({
    objectID: item.id ?? String(40000000 + index),
    title: item.title,
    url: item.url.trim() === "" ? null : item.url,
    points: item.score,
    created_at: item.published || "2026-10-08T00:00:00Z",
    story_text: item.raw || null,
  }));
  return JSON.stringify({ hits, nbHits: hits.length, page: 0 });
}

/** RSS 2.0。parseFeed 只读 title / link / description / pubDate 四个元素。 */
export function renderRssBody(items: FixtureItem[]): string {
  const rows = items
    .map((item) => {
      const parts = [
        `      <title>${escapeXml(item.title)}</title>`,
        `      <link>${escapeXml(item.url)}</link>`,
        `      <description>${escapeXml(item.raw)}</description>`,
      ];
      if (item.published) parts.push(`      <pubDate>${escapeXml(item.published)}</pubDate>`);
      return `    <item>\n${parts.join("\n")}\n    </item>`;
    })
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>fixture</title>",
    rows,
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

/** 三个源在 fetch 节点里写死的地址；路由按这些片段匹配，源站换域名时只改这里。 */
export const SOURCE_URL_PARTS = {
  hn: "hn.algolia.com",
  openai: "openai.com/news/rss",
  qbitai: "qbitai.com/feed",
} as const;

export interface StubbedResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

/**
 * 用 fixture 顶掉 global fetch。fetch 节点走 requestText → global fetch，
 * 所以这里不需要改生产代码就能整条回放。
 */
export function createFixtureFetcher(
  bodies: Record<keyof typeof SOURCE_URL_PARTS, string>,
): (url: string) => Promise<StubbedResponse> {
  return async (url: string) => {
    for (const [key, part] of Object.entries(SOURCE_URL_PARTS) as Array<
      [keyof typeof SOURCE_URL_PARTS, string]
    >) {
      if (url.includes(part)) {
        return { ok: true, status: 200, text: async () => bodies[key] };
      }
    }
    // 没被 fixture 覆盖的地址必须显式失败：悄悄返回空体会把「少了一个源」变成沉默的 0 条
    throw new Error(`回放未覆盖的地址：${url}（在 harness/fixtures 里补这个源，或改用 --capture）`);
  };
}
