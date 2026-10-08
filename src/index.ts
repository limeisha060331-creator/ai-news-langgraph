import { createRuntime } from "./bootstrap.js";
import { CALIBRATION_PAIRS } from "./fixtures/calibration-pairs.js";
import { calibrate, formatReport } from "./lib/calibrate.js";
import { log } from "./lib/logger.js";
import { buildIngestionGraph } from "./graph/ingestion.js";
import { buildQueryGraph } from "./graph/query.js";
import { finalizeStats, type IngestionStateType } from "./graph/state.js";
import type { QueryStateType } from "./graph/query.js";
import { ensureIndex, indexHealth } from "./redis/schema.js";

function usage(): void {
  process.stdout.write(
    [
      "用法：",
      "  npm run ingest                       跑一次摄入图（抓取 → 去重 → 摘要 → 编码 → 语义去重 → 出日报 → 写回）",
      '  npm run query -- "过去一周 Agent 有哪些进展"   跑查询图',
      "  npm run calibrate                    用标注样本标定去重阈值",
      "  npm run redis:init                   建向量索引",
      "",
    ].join("\n"),
  );
}

async function ingest(): Promise<number> {
  const runtime = await createRuntime();
  try {
    const graph = buildIngestionGraph(runtime.deps);
    const started = Date.now();
    const result = (await graph.invoke({})) as IngestionStateType;
    const stats = finalizeStats(result.stats);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    log.info("摄入完成", {
      seconds: Number(seconds),
      report: result.report ? `${result.report.split("\n")[0]}` : "(无)",
      stats,
      warnings: result.warnings,
    });

    const droppedByReason = result.dropped.reduce<Record<string, number>>((accumulator, row) => {
      accumulator[row.reason] = (accumulator[row.reason] ?? 0) + 1;
      return accumulator;
    }, {});

    process.stdout.write(
      [
        "",
        "=== 本次运行 ===",
        `耗时 ${seconds}s`,
        `抓取 ${stats.fetched} 条 → URL 去重后 ${stats.afterUrlDedup} 条 → 候选 ${stats.selected} 条`,
        `摘要 ${stats.summarized} 条（降级 ${stats.summaryDegraded} 条）→ 编码 ${stats.embedded} 条`,
        `语义判重 ${stats.semanticDropped} 条 · 疑似 ${stats.semanticSuspect} 条`,
        `推送 ${stats.delivered} 条 · 写回 ${stats.stored} 条`,
        `丢弃分布：${JSON.stringify(droppedByReason)}`,
        result.warnings.length ? `警告：\n  ${result.warnings.join("\n  ")}` : "警告：无",
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    await runtime.close();
  }
}

async function query(args: string[]): Promise<number> {
  const question = args.filter((arg) => !arg.startsWith("--")).join(" ").trim();
  if (!question) {
    process.stderr.write("要带一个问题，例如：npm run query -- \"过去一周 Agent 有哪些进展\"\n");
    return 1;
  }
  const daysFlag = args.find((arg) => arg.startsWith("--days="));
  const sinceDays = daysFlag ? Number(daysFlag.split("=")[1]) : 30;

  const runtime = await createRuntime();
  try {
    const graph = buildQueryGraph(runtime.deps);
    const result = (await graph.invoke({ question, sinceDays })) as QueryStateType;

    process.stdout.write(["\n=== 回答 ===", result.answer, "", "=== 引用 ==="].join("\n"));
    for (const [index, row] of result.neighbors.entries()) {
      process.stdout.write(
        `[${index + 1}] ${row.title} — ${row.source}（相似度 ${row.similarity.toFixed(3)}）\n`,
      );
    }
    process.stdout.write("\n");
    return 0;
  } finally {
    await runtime.close();
  }
}

async function calibrateCommand(): Promise<number> {
  const runtime = await createRuntime();
  try {
    const report = await calibrate(runtime.deps.embedder, CALIBRATION_PAIRS);
    process.stdout.write(`\n${formatReport(report)}\n\n`);
    // 退出码表示建议阈值能不能直接用：只要没有把不同事件判重（误杀为 0）
    // 就算可用。单阈值分不开是常态，两级阈值就是为这种情况设计的。
    return report.expected.falseDrops === 0 ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

async function redisInit(): Promise<number> {
  const runtime = await createRuntime();
  try {
    const result = await ensureIndex(
      runtime.deps.redis,
      runtime.config.REDIS_INDEX,
      runtime.deps.embedder.dim,
    );
    process.stdout.write(
      `索引 ${runtime.config.REDIS_INDEX}：${result === "created" ? "已创建" : "已存在"}` +
        `（维度 ${runtime.deps.embedder.dim}，编码器 ${runtime.deps.embedder.name}）\n`,
    );
    const health = await indexHealth(runtime.deps.redis, runtime.config.REDIS_INDEX);
    process.stdout.write(
      `当前文档数 ${health.numDocs}，索引失败 ${health.indexingFailures}` +
        `${health.lastError ? `（最近错误：${health.lastError}）` : ""}\n`,
    );
    if (health.indexingFailures > 0) {
      process.stdout.write(
        "索引失败不为 0：字段类型和文档里的实际类型对不上，逐条核对 SCHEMA 里的声明。\n",
      );
      return 1;
    }
    return 0;
  } finally {
    await runtime.close();
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "ingest":
      return ingest();
    case "query":
      return query(rest);
    case "calibrate":
      return calibrateCommand();
    case "redis-init":
      return redisInit();
    default:
      usage();
      return command ? 1 : 0;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    log.error("运行失败", { reason: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
