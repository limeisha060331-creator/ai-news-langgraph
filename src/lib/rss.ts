import { XMLParser } from "fast-xml-parser";

export interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
}

/** feed 地址失效时常常返回一个网页，用它把这种情况和「正常的空 feed」区分开。 */
export function looksLikeHtml(body: string): boolean {
  const head = body.trim().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return text((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function stripTags(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** 解析 RSS 2.0 与 Atom 两种形状，取标题、链接、摘要、发布时间。 */
export function parseFeed(xml: string): FeedItem[] {
  if (looksLikeHtml(xml)) {
    throw new Error("拿到的是网页不是 feed，地址可能已经失效");
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    trimValues: true,
  });

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch (error) {
    throw new Error(`feed 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const rssItems = asArray<any>(doc?.rss?.channel?.item);
  const atomEntries = asArray<any>(doc?.feed?.entry);
  const raw = rssItems.length > 0 ? rssItems : atomEntries;

  const items: FeedItem[] = [];
  for (const node of raw) {
    const link = node?.link?.["@_href"] ?? node?.link ?? node?.guid ?? "";
    const item: FeedItem = {
      title: stripTags(text(node?.title)),
      link: text(link).trim(),
      description: stripTags(text(node?.description) || text(node?.summary) || text(node?.content)),
      pubDate: text(node?.pubDate) || text(node?.updated) || text(node?.published),
    };
    if (item.title && item.link) items.push(item);
  }
  return items;
}
