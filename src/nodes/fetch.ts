import type { Article } from "../types.js";
import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";
import { requestJson, requestText } from "../lib/http.js";
import { parseFeed } from "../lib/rss.js";

const HN_URL = "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=30";
const OPENAI_URL = "https://openai.com/news/rss.xml";
const QBITAI_URL = "https://www.qbitai.com/feed";

/** 来源权重：官方博客 > 中文媒体 > 社区热帖。用于排序与截断，不代表内容质量。 */
const WEIGHTS: Record<string, number> = {
  "OpenAI Blog": 5,
  量子位: 4,
  HN: 3,
};

interface HnHit {
  objectID?: string;
  title?: string;
  url?: string | null;
  points?: number;
  created_at?: string;
  story_text?: string | null;
}

function baseArticle(input: {
  url: string;
  title: string;
  source: string;
  score?: number;
  published?: string;
  raw?: string;
}): Article {
  return {
    urlKey: "",
    url: input.url,
    title: input.title,
    source: input.source,
    weight: WEIGHTS[input.source] ?? 3,
    score: input.score ?? 0,
    published: input.published ?? "",
    raw: (input.raw ?? "").slice(0, 400),
  };
}

async function fetchHackerNews(deps: Deps): Promise<Article[]> {
  const payload = await requestJson<{ hits?: HnHit[] }>(HN_URL, deps.httpOptions);
  return (payload.hits ?? [])
    .filter((hit) => (hit.title ?? "").trim().length > 0)
    .map((hit) =>
      baseArticle({
        // 文本贴没有外链，指向讨论页本身
        url: hit.url ?? `https://news.ycombinator.com/item?id=${hit.objectID ?? ""}`,
        title: hit.title ?? "",
        source: "HN",
        score: hit.points ?? 0,
        published: hit.created_at ?? "",
        raw: hit.story_text ?? "",
      }),
    );
}

async function fetchFeed(url: string, source: string, deps: Deps): Promise<Article[]> {
  const body = await requestText(url, deps.httpOptions);
  return parseFeed(body).map((item) =>
    baseArticle({
      url: item.link,
      title: item.title,
      source,
      published: item.pubDate,
      raw: item.description,
    }),
  );
}

/**
 * 抓三个源。单源失败只记一条警告，其余源照常产出——
 * 「今天少一个源」和「今天没有日报」是严重程度完全不同的两件事。
 *
 * 依赖用工厂注入而不是塞进 state：state 会进 checkpoint，
 * 把 Redis client 写进去既不能序列化，也会让恢复时拿到一个过期连接。
 */
export function createFetchNode(deps: Deps) {
  return async function fetchNode(_state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const tasks: Array<{ source: string; run: () => Promise<Article[]> }> = [
      { source: "HN", run: () => fetchHackerNews(deps) },
      { source: "OpenAI Blog", run: () => fetchFeed(OPENAI_URL, "OpenAI Blog", deps) },
      { source: "量子位", run: () => fetchFeed(QBITAI_URL, "量子位", deps) },
    ];

    const articles: Article[] = [];
    const warnings: string[] = [];
    const bySource: Record<string, number> = {};

    for (const task of tasks) {
      try {
        const rows = await task.run();
        bySource[task.source] = rows.length;
        articles.push(...rows);
        log.info("抓取完成", { source: task.source, count: rows.length });
      } catch (error) {
        bySource[task.source] = 0;
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`源 ${task.source} 抓取失败：${reason}`);
        log.warn("抓取失败", { source: task.source, reason });
      }
    }

    return {
      articles,
      warnings,
      stats: { fetched: articles.length, bySource },
    };
  };
}
