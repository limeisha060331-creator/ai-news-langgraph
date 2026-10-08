import type { EmbeddingProvider } from "./embedding.js";
import { cosineSimilarity } from "./embedding.js";
import type { CalibrationPair } from "../fixtures/calibration-pairs.js";

export interface CalibrationReport {
  provider: string;
  sameEventScores: number[];
  differentEventScores: number[];
  sameEventMin: number;
  differentEventMax: number;
  /** 单阈值能不能把两组分开。分不开是常态，不代表模型不能用。 */
  singleThresholdSeparable: boolean;
  suggestedDupThreshold: number;
  suggestedGrayLow: number;
  /** 按建议阈值在本批样本上的预期效果 */
  expected: {
    hardDropped: number;
    suspected: number;
    kept: number;
    /** 被硬判重里，其实是不同事件的数量（也就是误杀） */
    falseDrops: number;
    /** 落在疑似区间里，属于同一事件的数量（真正需要裁决的） */
    trueSuspects: number;
    /** 落在疑似区间里，其实不同事件的数量（裁决时要否掉的） */
    falseSuspects: number;
  };
  rows: Array<{ a: string; b: string; sameEvent: boolean; score: number; crossLanguage: boolean }>;
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, low = 0, high = 1): number {
  return Math.min(high, Math.max(low, value));
}

/**
 * 用标注好的一批正负样本，量出同一事件与不同事件的相似度分布，
 * 再给出阈值建议。阈值不能拍：同一个数字在词法编码器和真 embedding 模型上
 * 对应的含义完全不同，换模型必须重跑这一步。
 *
 * 两级阈值的取值原则是「宁漏勿误」：
 *   DUP_THRESHOLD 取所有反例之上，保证没有任何被标注为不同事件的样本会被硬判重；
 *   GRAY_LOW 取所有正例之下，保证没有任何同一事件会漏掉判定的机会。
 * 两者之间就是交给日报阶段裁决的疑似区间——宁可多裁决几条，也不要误杀一条独家。
 * 两组完全分得开时，两个值会收敛到一条线附近，此时中间区间是空的。
 */
export async function calibrate(
  provider: EmbeddingProvider,
  pairs: CalibrationPair[],
): Promise<CalibrationReport> {
  const texts = pairs.flatMap((pair) => [pair.a, pair.b]);
  const vectors = await provider.embed(texts);

  const rows: CalibrationReport["rows"] = [];
  for (let index = 0; index < pairs.length; index += 1) {
    const pair = pairs[index]!;
    const left = vectors[index * 2] ?? [];
    const right = vectors[index * 2 + 1] ?? [];
    rows.push({
      a: pair.a,
      b: pair.b,
      sameEvent: pair.sameEvent,
      score: round(cosineSimilarity(left, right)),
      crossLanguage: hasCjk(pair.a) !== hasCjk(pair.b),
    });
  }

  const sameEventScores = rows.filter((row) => row.sameEvent).map((row) => row.score);
  const differentEventScores = rows.filter((row) => !row.sameEvent).map((row) => row.score);
  const sameEventMin = sameEventScores.length ? Math.min(...sameEventScores) : 0;
  const differentEventMax = differentEventScores.length ? Math.max(...differentEventScores) : 0;
  const singleThresholdSeparable = sameEventScores.length > 0 && sameEventMin > differentEventMax;

  // 反例都在 DUP 之下，正例都在 GRAY 之上；两组分得开时二者会靠拢
  const suggestedDupThreshold = round(clamp(differentEventMax + 0.02));
  const suggestedGrayLow = round(clamp(sameEventMin - 0.02));

  let hardDropped = 0;
  let suspected = 0;
  let kept = 0;
  let falseDrops = 0;
  let trueSuspects = 0;
  let falseSuspects = 0;
  for (const row of rows) {
    if (row.score >= suggestedDupThreshold) {
      hardDropped += 1;
      if (!row.sameEvent) falseDrops += 1;
    } else if (row.score >= suggestedGrayLow) {
      suspected += 1;
      if (row.sameEvent) trueSuspects += 1;
      else falseSuspects += 1;
    } else {
      kept += 1;
    }
  }

  return {
    provider: provider.name,
    sameEventScores,
    differentEventScores,
    sameEventMin: round(sameEventMin),
    differentEventMax: round(differentEventMax),
    singleThresholdSeparable,
    suggestedDupThreshold,
    suggestedGrayLow,
    expected: { hardDropped, suspected, kept, falseDrops, trueSuspects, falseSuspects },
    rows,
  };
}

export function formatReport(report: CalibrationReport): string {
  const lines: string[] = [
    `== 阈值标定（编码器：${report.provider}）==`,
    "",
  ];
  for (const row of report.rows) {
    const verdict =
      row.score >= report.suggestedDupThreshold
        ? "判重"
        : row.score >= report.suggestedGrayLow
          ? "疑似"
          : "保留";
    // 打 OK 的标准是「判定结果和标注一致」：同一事件不该被判成保留，不同事件不该被判重
    const agree = row.sameEvent ? verdict !== "保留" : verdict !== "判重";
    const mark = agree ? "OK" : "  ";
    lines.push(
      `${mark} ${row.score.toFixed(3)} ${verdict}  同一事件=${row.sameEvent ? "是" : "否"}` +
        `  跨语言=${row.crossLanguage ? "是" : "否"}  ${row.a.slice(0, 34)}`,
    );
  }
  lines.push("");
  lines.push(
    `同一事件组：${report.sameEventScores.map((s) => s.toFixed(3)).join(", ")}` +
      `   最低 ${report.sameEventMin.toFixed(3)}`,
  );
  lines.push(
    `不同事件组：${report.differentEventScores.map((s) => s.toFixed(3)).join(", ")}` +
      `   最高 ${report.differentEventMax.toFixed(3)}`,
  );
  lines.push("");
  if (report.singleThresholdSeparable) {
    lines.push(
      `单阈值可分：不同事件最高 ${report.differentEventMax.toFixed(3)}` +
        ` < 同一事件最低 ${report.sameEventMin.toFixed(3)}`,
    );
  } else {
    lines.push(
      `单阈值不可分：不同事件最高 ${report.differentEventMax.toFixed(3)}` +
        ` >= 同一事件最低 ${report.sameEventMin.toFixed(3)}。` +
        "这很正常——相邻版本号、同一产品的续报本来就长得像，用两级阈值处理。",
    );
  }
  lines.push("");
  lines.push(`建议写入 .env：`);
  lines.push(`  DUP_THRESHOLD=${report.suggestedDupThreshold}`);
  lines.push(`  GRAY_LOW=${report.suggestedGrayLow}`);
  lines.push("");
  lines.push(
    `在本批 ${report.rows.length} 对样本上的效果：` +
      `直接判重 ${report.expected.hardDropped} 对（其中误杀 ${report.expected.falseDrops} 对）、` +
      `标为疑似 ${report.expected.suspected} 对` +
      `（其中真重复 ${report.expected.trueSuspects} 对、假警报 ${report.expected.falseSuspects} 对）、` +
      `直接保留 ${report.expected.kept} 对。`,
  );
  lines.push(
    "误杀为 0 说明这两个值可以直接用；误杀不为 0 时把 DUP_THRESHOLD 再往上调一档。",
  );
  return lines.join("\n");
}
