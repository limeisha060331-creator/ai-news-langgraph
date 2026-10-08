import { z } from "zod";

import type { Config } from "../config.js";
import type { Article } from "../types.js";
import { HttpError, requestJson, type HttpOptions } from "./http.js";

export interface SummaryResult {
  urlKey: string;
  titleZh: string;
  summary: string;
  importance: number;
  degraded: boolean;
}

export interface Summarizer {
  readonly name: string;
  summarize(items: Article[]): Promise<SummaryResult[]>;
}

const ResponseSchema = z.object({
  items: z
    .array(
      z.object({
        url: z.string(),
        titleZh: z.string(),
        summary: z.string(),
        importance: z.coerce.number().int().min(1).max(5),
      }),
    )
    .min(1),
});

const SYSTEM_PROMPT = [
  "你是中文资讯编辑。输入是一批文章，字段含义：",
  "url 原文链接、title 原标题（中文或英文）、raw 原文摘要片段（可能为空或被截断）、",
  "source 来源、score 来源热度分、published 发布时间。",
  "",
  "对每一条输出：",
  "1. titleZh：中文标题，30 字以内。原标题是英文就翻译，已经是中文就精简。",
  "2. summary：1 至 3 句中文摘要。先说发生了什么，再说为什么值得关注。",
  "   只能依据 title 和 raw 写，不得补充外部知识，不得编造数字、时间或人物。",
  "   raw 为空时就基于标题写一句，不要硬凑字数。",
  "   不要用「本文」「据悉」「值得注意」这类空话开头。",
  "3. importance：1 至 5 的整数。5 是重大模型或产品发布、行业格局级事件；",
  "   4 是重要能力或产品更新；3 是有价值的进展或观点；2 是常规资讯；1 是边缘内容。",
  "   同一批里不要所有条目都给同一个分数。",
  "",
  '输出严格是这个形状的 JSON，不要加解释、不要用代码围栏：{"items":[...]}',
  "每条必须原样带回输入里的 url，不要改写、不要补全。",
].join("\n");

export class OpenAiSummarizer implements Summarizer {
  readonly name: string;

  constructor(
    private readonly config: Config,
    private readonly httpOptions: HttpOptions,
  ) {
    this.name = `openai:${config.LLM_MODEL}`;
  }

  async summarize(items: Article[]): Promise<SummaryResult[]> {
    const payload = items.map((item) => ({
      url: item.url,
      title: item.title,
      raw: item.raw.slice(0, 400),
      source: item.source,
      score: item.score,
      published: item.published,
    }));

    let content: string;
    try {
      const response = await requestJson<{ choices: Array<{ message: { content: string } }> }>(
        `${this.config.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`,
        { ...this.httpOptions, timeoutMs: this.config.LLM_TIMEOUT_MS },
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.LLM_API_KEY}`,
          },
          body: JSON.stringify({
            model: this.config.LLM_MODEL,
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: JSON.stringify({ articles: payload }) },
            ],
          }),
        },
      );
      content = response.choices[0]?.message?.content ?? "";
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`摘要接口返回 ${error.status}：${error.bodySnippet}`);
      }
      throw error;
    }

    const parsed = ResponseSchema.safeParse(extractJson(content));
    if (!parsed.success) {
      throw new Error(`摘要输出不是约定的 JSON：${content.slice(0, 200)}`);
    }

    const byUrl = new Map(parsed.data.items.map((row) => [row.url, row]));
    return items.map((item) => {
      const row = byUrl.get(item.url);
      if (!row) {
        // 模型漏了某条：这条单独降级，不要把整批丢掉
        return degradedSummary(item);
      }
      return {
        urlKey: item.urlKey,
        titleZh: row.titleZh.trim() || item.title,
        summary: row.summary.trim(),
        importance: row.importance,
        degraded: false,
      };
    });
  }
}

/** 模型偶尔会把 JSON 包在代码围栏或解释性文字里，剥一层再解析。 */
function extractJson(content: string): unknown {
  const text = (content ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1]?.trim() ?? text;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function degradedSummary(item: Article): SummaryResult {
  return {
    urlKey: item.urlKey,
    titleZh: item.title,
    summary: item.raw ? item.raw.slice(0, 120) : "（摘要缺失，仅保留标题与链接）",
    importance: Math.min(5, Math.max(1, item.weight)),
    degraded: true,
  };
}

/**
 * 离线摘要器：确定性输出，供测试与无 key 环境使用。
 * 它不产生任何新信息，只是把原文字段搬成结构化形状，所以它的输出
 * 不能用来评估摘要质量，只能用来验证链路。
 */
export class MockSummarizer implements Summarizer {
  readonly name = "mock";

  async summarize(items: Article[]): Promise<SummaryResult[]> {
    return items.map((item) => degradedSummary(item));
  }
}

export function createSummarizer(config: Config, httpOptions: HttpOptions): Summarizer {
  if (config.LLM_PROVIDER === "openai") {
    return new OpenAiSummarizer(config, httpOptions);
  }
  return new MockSummarizer();
}
