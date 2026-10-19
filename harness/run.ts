import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../src/config.js";
import { CALIBRATION_PAIRS } from "../src/fixtures/calibration-pairs.js";
import { buildIngestionGraph } from "../src/graph/ingestion.js";
import { finalizeStats, type IngestionStateType } from "../src/graph/state.js";
import { calibrate } from "../src/lib/calibrate.js";
import { cosineSimilarity, MockEmbeddingProvider } from "../src/lib/embedding.js";
import { MockSummarizer } from "../src/lib/llm.js";
import type { Deps } from "../src/nodes/deps.js";
import type { Stats } from "../src/types.js";
import { createFakeRedis, type FakeRedisSeed } from "./fake-redis.js";
import {
  DropReasonSchema,
  loadFixture,
  type Fixture,
  type FixtureCase,
} from "./fixture.js";
import { createFixtureFetcher, renderHnBody, renderRssBody } from "./wire.js";

/**
 * 回放回归台的核心。
 *
 * 这条流水线的正确性不在类型里，在行为里：节点顺序、每源保底、总量上限、
 * 两级阈值的方向、送达才写历史。这些改动都不会让 tsc 报错，只会让某天的日报
 * 少三条，或者把昨天推过的内容再推一遍。
 *
 * 所以这里做三件事：
 *   1. 用冻结的输入把整条图重跑一遍，比对漏斗数字——数量对不上就是行为变了；
 *   2. 逐条核对「设计出来的用例」落在哪条规则上——这一层能指出是哪条规则变了；
 *   3. 重跑阈值标定，把编码器指纹和基线比——换分词器、换维度、换模型，这里必须红。
 *
 * 不连 Redis、不联网、不要密钥，输出确定。
 *
 * 拆成 run.ts + replay.ts + replay.test.ts 的原因：CLI 那层用 tsx 跑，
 * 而测试要走 vitest。核心逻辑只写一份，两边都调它。
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = join(HERE, "fixtures", "news-baseline.v1.json");

export interface Check {
  label: string;
  expected: string;
  actual: string;
  ok: boolean;
  note?: string;
}

export interface CaseRow {
  id: string;
  description: string;
  expected: string;
  actual: string;
  ok: boolean;
}

export interface ReplayResult {
  fixture: Fixture;
  fixtureLabel: string;
  stats: Stats;
  droppedByReason: Record<string, number>;
  bySourceSelected: Record<string, number>;
  report: string;
  warnings: string[];
  sections: {
    stats: Check[];
    drops: Check[];
    quota: Check[];
    report: Check[];
    calibration: Check[];
  };
  cases: CaseRow[];
  explainLines: string[];
  calibration: Awaited<ReturnType<typeof calibrate>>;
  failed: number;
  total: number;
}

class Checker {
  private rows: Check[] = [];

  check(label: string, expected: unknown, actual: unknown, note?: string): void {
    this.rows.push({
      label,
      expected: String(expected),
      actual: String(actual),
      ok: String(expected) === String(actual),
      ...(note ? { note } : {}),
    });
  }

  /** 标定分数受浮点存储影响，允许 1e-6 的差，不允许语义上的差。 */
  checkClose(label: string, expected: number, actual: number, tolerance = 1e-6): void {
    const ok = Math.abs(expected - actual) <= tolerance;
    this.rows.push({
      label,
      expected: expected.toFixed(6),
      actual: actual.toFixed(6),
      ok,
      ...(ok ? {} : { note: `超出容差 ${tolerance}` }),
    });
  }

  take(): Check[] {
    const rows = this.rows;
    this.rows = [];
    return rows;
  }
}

function countBy<T extends string>(values: T[]): Record<string, number> {
  return values.reduce<Record<string, number>>((accumulator, value) => {
    accumulator[value] = (accumulator[value] ?? 0) + 1;
    return accumulator;
  }, {});
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 回放结果里，某条用例最终落在哪条规则上。 */
function outcomeOf(
  testCase: FixtureCase,
  dropped: IngestionStateType["dropped"],
  kept: IngestionStateType["articles"],
): { outcome: string; scope?: "history" | "batch" } {
  const hit = dropped.find((row) => row.source === testCase.source && row.title === testCase.title);
  if (hit) return { outcome: `dropped:${hit.reason}`, ...(hit.scope ? { scope: hit.scope } : {}) };
  const article = kept.find((row) => row.source === testCase.source && row.title === testCase.title);
  if (article?.semantic) return { outcome: "suspect", scope: article.semantic.scope };
  return { outcome: "kept" };
}

export interface RunOptions {
  fixturePath?: string;
  /** 打印每条入选条目与批内/历史最高相似度，用来核对阈值，不参与断言 */
  explain?: boolean;
}

export async function runReplay(options: RunOptions = {}): Promise<ReplayResult> {
  const fixturePath = options.fixturePath ?? DEFAULT_FIXTURE;
  const { fixture } = loadFixture(fixturePath);
  const checker = new Checker();

  const config = loadConfig(fixture.env as NodeJS.ProcessEnv);
  const embedder = new MockEmbeddingProvider(config.EMBEDDING_DIM);

  // 历史条目的向量按「当时写回 Redis 的文本」重算，不存死向量：
  // 换了编码器之后历史相似度也该跟着变，而不是继续拿旧向量假装没事。
  const historyVectors = await embedder.embed(fixture.history.map((row) => row.text));
  const nowSec = Math.floor(Date.now() / 1000);
  const seed: FakeRedisSeed[] = fixture.history.map((row, index) => ({
    article: {
      urlKey: row.urlKey,
      url: row.urlKey,
      title: row.title,
      source: row.source,
      weight: 3,
      published: "",
      pushedAt: nowSec - Math.round(row.pushedDaysAgo * 86400),
      embedding: historyVectors[index] ?? [],
    },
  }));

  const { client } = createFakeRedis(seed);
  const deps: Deps = {
    config,
    redis: client,
    embedder,
    summarizer: new MockSummarizer(),
    httpOptions: { userAgent: config.USER_AGENT, timeoutMs: config.FETCH_TIMEOUT_MS, retries: 0 },
    now: () => new Date(),
  };

  // fetch 节点走 global fetch，在这里顶掉就能整条回放，生产代码一行不用改。
  const fetcher = createFixtureFetcher({
    hn: renderHnBody(fixture.sources.hn),
    openai: renderRssBody(fixture.sources.openai),
    qbitai: renderRssBody(fixture.sources.qbitai),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => fetcher(String(input))) as typeof fetch;

  let result: IngestionStateType;
  try {
    result = (await buildIngestionGraph(deps).invoke({
      runDate: fixture.runDate,
    })) as IngestionStateType;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const stats = finalizeStats(result.stats);
  const droppedByReason = countBy(result.dropped.map((row) => row.reason));
  const bySourceSelected = countBy(result.articles.map((row) => row.source));
  const reportItems = (result.report.match(/^### /gm) ?? []).length;
  const reportListed = (result.report.match(/^- \[/gm) ?? []).length;
  const reportHash = sha256(result.report);

  type ExpectStats = Fixture["expect"]["stats"];
  for (const key of Object.keys(fixture.expect.stats) as Array<keyof ExpectStats>) {
    checker.check(key, fixture.expect.stats[key], stats[key]);
  }
  const statsChecks = checker.take();

  for (const reason of DropReasonSchema.options) {
    checker.check(reason, fixture.expect.droppedByReason[reason] ?? 0, droppedByReason[reason] ?? 0);
  }
  const dropChecks = checker.take();

  for (const [source, expected] of Object.entries(fixture.expect.bySourceSelected)) {
    checker.check(source, expected, bySourceSelected[source] ?? 0);
  }
  const quotaChecks = checker.take();

  checker.check("report.items", fixture.expect.report.items, reportItems);
  checker.check("report.listed", fixture.expect.report.listed, reportListed);
  checker.check(
    "report.coversDelivered",
    stats.delivered,
    reportListed,
    "日报的链接汇总必须覆盖送达的每一条：少列的那些会被写进历史，读者再也看不到",
  );
  checker.check("report.sha256", fixture.expect.report.sha256, reportHash);
  checker.check("warnings", fixture.expect.warnings, result.warnings.length);
  const reportChecks = checker.take();

  const calibration = await calibrate(embedder, CALIBRATION_PAIRS);
  const expectedCalibration = fixture.expect.calibration;
  checker.checkClose("sameEventMin", expectedCalibration.sameEventMin, calibration.sameEventMin);
  checker.checkClose(
    "differentEventMax",
    expectedCalibration.differentEventMax,
    calibration.differentEventMax,
  );
  checker.checkClose(
    "suggestedDupThreshold",
    expectedCalibration.suggestedDupThreshold,
    calibration.suggestedDupThreshold,
  );
  checker.checkClose(
    "suggestedGrayLow",
    expectedCalibration.suggestedGrayLow,
    calibration.suggestedGrayLow,
  );
  checker.check("falseDrops", 0, calibration.expected.falseDrops);
  checker.check("pairCount", expectedCalibration.scores.length, calibration.rows.length);
  calibration.rows.forEach((row, index) => {
    const expected = expectedCalibration.scores[index];
    if (expected !== undefined) checker.checkClose(`score[${index}]`, expected, row.score);
  });
  const calibrationChecks = checker.take();

  const cases: CaseRow[] = fixture.cases.map((testCase) => {
    const actual = outcomeOf(testCase, result.dropped, result.articles);
    const label = actual.scope ? `${actual.outcome}(${actual.scope})` : actual.outcome;
    const scopeOk = testCase.expectScope ? actual.scope === testCase.expectScope : true;
    return {
      id: testCase.id,
      description: testCase.description,
      expected: `${testCase.expect}${testCase.expectScope ? `(${testCase.expectScope})` : ""}`,
      actual: label,
      ok: actual.outcome === testCase.expect && scopeOk,
    };
  });

  const explainLines: string[] = [];
  if (options.explain) {
    const history = fixture.history.map((row, index) => ({
      title: row.title,
      vector: historyVectors[index] ?? [],
    }));
    for (const article of result.articles) {
      const batchBest = result.articles
        .filter((other) => other.urlKey !== article.urlKey && other.embedding)
        .map((other) => ({
          score: cosineSimilarity(article.embedding ?? [], other.embedding ?? []),
        }))
        .sort((left, right) => right.score - left.score)[0];
      const historyBest = history
        .map((row) => ({ score: cosineSimilarity(article.embedding ?? [], row.vector) }))
        .sort((left, right) => right.score - left.score)[0];
      explainLines.push(
        `  ${pad(article.source, 12)} batch ${(batchBest?.score ?? 0).toFixed(3)}` +
          ` history ${(historyBest?.score ?? 0).toFixed(3)}  ${article.title.slice(0, 46)}`,
      );
    }
  }

  const sections = {
    stats: statsChecks,
    drops: dropChecks,
    quota: quotaChecks,
    report: reportChecks,
    calibration: calibrationChecks,
  };
  const failed =
    Object.values(sections).reduce((sum, rows) => sum + rows.filter((row) => !row.ok).length, 0) +
    cases.filter((row) => !row.ok).length;
  const total =
    Object.values(sections).reduce((sum, rows) => sum + rows.length, 0) + cases.length;

  // 落盘给人看：这一版日报长什么样。放 .artifacts（已 gitignore），不进版本库。
  const artifactDir = join(HERE, ".artifacts");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "last-report.md"), `${result.report}\n`, "utf8");
  writeFileSync(
    join(artifactDir, "last-run.json"),
    `${JSON.stringify(
      {
        stats,
        droppedByReason,
        bySourceSelected,
        reportHash,
        cases: cases.map((row) => ({ id: row.id, expected: row.expected, actual: row.actual })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    fixture,
    fixtureLabel: relative(process.cwd(), fixturePath) || fixturePath,
    stats,
    droppedByReason,
    bySourceSelected,
    report: result.report,
    warnings: result.warnings,
    sections,
    cases,
    explainLines,
    calibration,
    failed,
    total,
  };
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}

function renderChecks(title: string, rows: Check[]): string[] {
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 18);
  return [
    `\n${title}`,
    ...rows.map(
      (row) =>
        `  ${row.ok ? "OK  " : "FAIL"} ${pad(row.label, labelWidth)}  期望 ${pad(row.expected, 16)} 实际 ${row.actual}` +
        `${row.ok || !row.note ? "" : `   ← ${row.note}`}`,
    ),
  ];
}

/** 把一次回放渲染成人能读的表格。CLI 直接打印；测试失败时也打印同一份，省得两套输出。 */
export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [];
  lines.push(`\n=== 回放 ${result.fixture.name} ===`);
  lines.push(`fixture  ${result.fixtureLabel}`);
  lines.push(`runDate  ${result.fixture.runDate}`);
  if (result.fixture.note) lines.push(`说明     ${result.fixture.note}`);

  const input = `${result.fixture.sources.hn.length} + ${result.fixture.sources.openai.length} + ${result.fixture.sources.qbitai.length}`;
  lines.push(...renderChecks(`漏斗（输入 ${input} 条）`, result.sections.stats));
  lines.push(...renderChecks("丢弃分布", result.sections.drops));
  lines.push(...renderChecks("入选来源配额", result.sections.quota));

  lines.push("\n行为用例");
  const caseWidth = Math.max(...result.cases.map((row) => row.id.length), 10);
  for (const row of result.cases) {
    const detail = row.ok ? row.description : `← 期望 ${row.expected}，实际 ${row.actual}`;
    lines.push(`  ${row.ok ? "OK  " : "FAIL"} ${pad(row.id, caseWidth)}  ${detail}`);
  }

  lines.push(...renderChecks("报告指纹", result.sections.report));
  lines.push(...renderChecks("阈值标定指纹（编码器 mock-lexical）", result.sections.calibration));

  if (result.warnings.length > 0) {
    lines.push("\n运行期警告");
    for (const warning of result.warnings) lines.push(`  - ${warning}`);
  }
  if (result.explainLines.length > 0) {
    lines.push("\n逐条入选明细（诊断用，不参与断言）");
    lines.push(...result.explainLines);
  }

  lines.push("");
  if (result.failed === 0) {
    lines.push(`结果：${result.total}/${result.total} 通过。行为与基线一致。`);
  } else {
    lines.push(`结果：${result.total - result.failed}/${result.total} 通过，${result.failed} 条不一致。`);
    lines.push(
      "如果这次改动本来就要改变行为：先说明改了哪条规则、为什么，再更新基线（npm run harness -- --update）。",
    );
    lines.push("如果不是有意的改动：按上面的 FAIL 行定位到具体规则。");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 用这次回放的结果覆盖 fixture 里的 expect 块。
 *
 * 不动 sources / cases / history：基线只重写「观测值」，用例是人工写的断言，
 * 机器不该替人决定「这条应该被拦下」。
 */
export function updateBaseline(fixturePath: string, result: ReplayResult): void {
  const { fixture } = result;
  // 直接改盘上的原始 JSON，不走 zod 解析后的对象：那样会把默认值全部展开，
  // 一次 --update 会顺手重写整个文件，真正的改动就淹没在格式噪音里了。
  const raw = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
  raw.expect = {
    stats: Object.fromEntries(
      Object.keys(fixture.expect.stats).map((key) => [key, result.stats[key as keyof Stats]]),
    ),
    bySourceSelected: result.bySourceSelected,
    droppedByReason: Object.fromEntries(
      DropReasonSchema.options.map((reason) => [reason, result.droppedByReason[reason] ?? 0]),
    ),
    warnings: result.warnings.length,
    report: {
      sha256: sha256(result.report),
      items: (result.report.match(/^### /gm) ?? []).length,
      listed: (result.report.match(/^- \[/gm) ?? []).length,
    },
    calibration: {
      sameEventMin: result.calibration.sameEventMin,
      differentEventMax: result.calibration.differentEventMax,
      suggestedDupThreshold: result.calibration.suggestedDupThreshold,
      suggestedGrayLow: result.calibration.suggestedGrayLow,
      falseDrops: result.calibration.expected.falseDrops,
      scores: result.calibration.rows.map((row) => row.score),
    },
  };
  writeFileSync(fixturePath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}
