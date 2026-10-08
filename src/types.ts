/** 一条资讯在本流水线里的完整形态，字段随节点逐步补齐。 */
export interface Article {
  /** 归一化后的 URL，全局唯一键；同一条反复入库只会覆盖不会新增 */
  urlKey: string;
  /** 可点击的原始链接（已补协议头） */
  url: string;
  /** 原标题，可能是英文 */
  title: string;
  source: string;
  /** 来源权重，5 最高，用于排序与截断 */
  weight: number;
  /** 来源热度分（HN 点赞数等），非 HN 源为 0 */
  score: number;
  /** 发布时间，ISO 字符串，可能为空 */
  published: string;
  /** 原文摘要片段，最长 400 字，可能为空 */
  raw: string;

  // 以下由 summarize 节点补齐
  titleZh?: string;
  summary?: string;
  importance?: number;
  summaryDegraded?: boolean;

  // 以下由 embed 节点补齐
  embedding?: number[];

  // 以下由 dedupe 节点补齐：疑似重复的条目标记后交给日报阶段裁决
  semantic?: {
    score: number;
    similarTo: string;
    scope: "history" | "batch";
    action: "suspect";
  };
}

/** 被拦下的条目，记下来是为了能回答「今天为什么条数少」 */
export interface DroppedItem {
  urlKey: string;
  title: string;
  source: string;
  reason: "duplicate-url-batch" | "duplicate-url-history" | "missing-url" | "semantic-duplicate" | "overflow";
  score?: number;
  matchedUrl?: string;
  scope?: "history" | "batch";
}

/** 各阶段计数，直接落进运行日志，也是周报的数据源 */
export interface Stats {
  fetched: number;
  bySource: Record<string, number>;
  afterUrlDedup: number;
  droppedByUrl: number;
  selected: number;
  summarized: number;
  summaryDegraded: number;
  embedded: number;
  semanticDropped: number;
  semanticSuspect: number;
  delivered: number;
  stored: number;
}

export function emptyStats(): Stats {
  return {
    fetched: 0,
    bySource: {},
    afterUrlDedup: 0,
    droppedByUrl: 0,
    selected: 0,
    summarized: 0,
    summaryDegraded: 0,
    embedded: 0,
    semanticDropped: 0,
    semanticSuspect: 0,
    delivered: 0,
    stored: 0,
  };
}

/** 查询图的答案与引用 */
export interface Answer {
  question: string;
  answer: string;
  citations: Array<{ title: string; url: string; published: string; score: number }>;
}
