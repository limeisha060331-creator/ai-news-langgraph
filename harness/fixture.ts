import { readFileSync } from "node:fs";

import { z } from "zod";

/**
 * 回放 fixture 的形状。
 *
 * 这里存的是「源站返回了什么」，不是「渲染好的字符串」：HN 存 JSON 命中的字段，
 * 两个 RSS 存条目字段，由 wire 层渲染成线上格式。
 *
 * 为什么不直接存原始响应体：真实响应体是几十 KB 的转义 XML，
 * 改一条标题要在里面找半天，diff 也没人看得懂。
 * 存成字段之后，「哪一条用例改动了」在 diff 里一眼可见。
 */

/** 与 types.ts 的 DroppedItem.reason 一一对应。 */
export const DropReasonSchema = z.enum([
  "duplicate-url-batch",
  "duplicate-url-history",
  "missing-url",
  "semantic-duplicate",
  "overflow",
]);

export type DropReason = z.infer<typeof DropReasonSchema>;

/** 用例期望：要么保留（可能被标疑似），要么被某一条具体规则拦下。 */
export const CaseExpectationSchema = z.union([
  z.literal("kept"),
  z.literal("suspect"),
  z
    .string()
    .regex(
      /^dropped:(duplicate-url-batch|duplicate-url-history|missing-url|semantic-duplicate|overflow)$/,
      "期望值只能是 kept、suspect 或 dropped:<reason>",
    ),
]);

const SourceItemSchema = z.object({
  title: z.string(),
  /** 空字符串或纯空白 → 触发 missing-url；HN 文本贴传空串，wire 层会补讨论页地址 */
  url: z.string(),
  raw: z.string().default(""),
  published: z.string().default(""),
  score: z.number().int().nonnegative().default(0),
  /** 仅 HN：Algolia 的 objectID；不填则按数组下标生成。文本贴靠它拼讨论页链接 */
  id: z.string().optional(),
});

const HistoryItemSchema = z.object({
  /** 归一化之后的地址，必须和 normalizeUrl 的输出一致，否则这条历史永远命中不了 */
  urlKey: z.string(),
  title: z.string(),
  source: z.string(),
  /** 当时写回 Redis 的向量原文（中文标题 + 中文摘要），用来复现跨天语义去重 */
  text: z.string(),
  pushedDaysAgo: z.number().positive(),
});

const CaseSchema = z.object({
  id: z.string(),
  /** 写给人看的一句话，解释这条用例守的是哪条规则 */
  description: z.string(),
  source: z.enum(["HN", "OpenAI Blog", "量子位"]),
  /** 用来源 + 标题定位，不依赖 URL 归一化的细节 */
  title: z.string(),
  expect: CaseExpectationSchema,
  /**
   * 只有语义判重需要区分是哪一路命中：历史 KNN 和批内余弦是两条不同的代码路径，
   * 只断言「被判重」的话，KNN 挂掉走批内也能通过。
   */
  expectScope: z.enum(["history", "batch"]).optional(),
});

const StatsSchema = z.object({
  fetched: z.number().int(),
  afterUrlDedup: z.number().int(),
  droppedByUrl: z.number().int(),
  selected: z.number().int(),
  embedded: z.number().int(),
  semanticDropped: z.number().int(),
  semanticSuspect: z.number().int(),
  delivered: z.number().int(),
  listed: z.number().int(),
  stored: z.number().int(),
});

const ExpectSchema = z.object({
  stats: StatsSchema,
  /** 入选条目按来源的配额分布，守的是「产量大的源不能挤掉别的源」 */
  bySourceSelected: z.record(z.string(), z.number().int()),
  droppedByReason: z.record(DropReasonSchema, z.number().int()),
  warnings: z.number().int(),
  report: z.object({
    sha256: z.string(),
    /** 正文（### 标题）条数：受三档配额限制，是精选结果 */
    items: z.number().int(),
    /** 链接汇总条数：必须等于 delivered，否则日报漏了内容却照样写进了历史 */
    listed: z.number().int(),
  }),
  /** 编码器指纹：换分词器、换维度、换模型，这些数字必然变 */
  calibration: z.object({
    sameEventMin: z.number(),
    differentEventMax: z.number(),
    suggestedDupThreshold: z.number(),
    suggestedGrayLow: z.number(),
    falseDrops: z.number().int(),
    /** 10 对标定样本的逐对分数，比汇总值更敏感 */
    scores: z.array(z.number()),
  }),
});

export const FixtureSchema = z.object({
  version: z.literal(1),
  name: z.string(),
  note: z.string().default(""),
  runDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** 写死在 fixture 里，避免代码默认值被改掉之后回放结论跟着漂 */
  env: z.record(z.string(), z.string()),
  sources: z.object({
    hn: z.array(SourceItemSchema),
    openai: z.array(SourceItemSchema),
    qbitai: z.array(SourceItemSchema),
  }),
  history: z.array(HistoryItemSchema).default([]),
  cases: z.array(CaseSchema),
  expect: ExpectSchema,
});

export type Fixture = z.infer<typeof FixtureSchema>;
export type FixtureItem = z.infer<typeof SourceItemSchema>;
export type FixtureCase = z.infer<typeof CaseSchema>;
export type FixtureHistoryItem = z.infer<typeof HistoryItemSchema>;

/** 读取并校验。校验失败时把 zod 的路径原样抛出来，不要吞掉。 */
export function loadFixture(path: string): { fixture: Fixture; raw: Record<string, unknown> } {
  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`fixture 不是合法 JSON：${path}（${error instanceof Error ? error.message : ""}）`);
  }
  const result = FixtureSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`fixture 结构不合法：${path}\n${detail}`);
  }
  return { fixture: result.data, raw: parsed as Record<string, unknown> };
}
