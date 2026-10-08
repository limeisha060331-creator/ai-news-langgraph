import type { EmbeddingProvider } from "./embedding.js";
import { cosineSimilarity } from "./embedding.js";
import type { CalibrationPair } from "../fixtures/calibration-pairs.js";

export interface CalibrationReport {
  provider: string;
  sameEventScores: number[];
  differentEventScores: number[];
  sameEventMin: number;
  differentEventMax: number;
  separable: boolean;
  suggestedDupThreshold: number | null;
  suggestedGrayLow: number | null;
  rows: Array<{ a: string; b: string; sameEvent: boolean; score: number; crossLanguage: boolean }>;
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * 用标注好的一批正负样本，量出同一事件与不同事件的相似度分布，
 * 再给出阈值建议。阈值不能拍：同一个数字在词法编码器和真 embedding 模型上
 * 对应的含义完全不同，换模型必须重跑这一步。
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
  const separable = sameEventScores.length > 0 && sameEventMin > differentEventMax;

  return {
    provider: provider.name,
    sameEventScores,
    differentEventScores,
    sameEventMin: round(sameEventMin),
    differentEventMax: round(differentEventMax),
    separable,
    suggestedDupThreshold: separable ? round(Math.max(0, sameEventMin - 0.02)) : null,
    suggestedGrayLow: separable ? round(Math.min(1, differentEventMax + 0.02)) : null,
    rows,
  };
}

export function formatReport(report: CalibrationReport): string {
  const lines: string[] = [
    `== 阈值标定（编码器：${report.provider}）==`,
    "",
  ];
  for (const row of report.rows) {
    const mark = row.sameEvent === row.score >= (report.suggestedDupThreshold ?? 0.9) ? "OK" : "  ";
    lines.push(
      `${mark} ${row.score.toFixed(3)}  同一事件=${row.sameEvent ? "是" : "否"}` +
        `  跨语言=${row.crossLanguage ? "是" : "否"}  ${row.a.slice(0, 34)}`,
    );
  }
  lines.push("");
  lines.push(`同一事件组：${report.sameEventScores.map((s) => s.toFixed(3)).join(", ")}`);
  lines.push(`不同事件组：${report.differentEventScores.map((s) => s.toFixed(3)).join(", ")}`);
  lines.push("");
  if (report.separable) {
    lines.push(
      `可分：不同事件最高 ${report.differentEventMax.toFixed(3)} < 同一事件最低 ${report.sameEventMin.toFixed(3)}`,
    );
    lines.push(
      `建议 DUP_THRESHOLD=${report.suggestedDupThreshold}  GRAY_LOW=${report.suggestedGrayLow}`,
    );
  } else {
    lines.push(
      `不可分：不同事件最高 ${report.differentEventMax.toFixed(3)} >= 同一事件最低 ${report.sameEventMin.toFixed(3)}`,
    );
    lines.push(
      "说明这个编码器不足以区分样本。跨语言那一类用词法编码器必然分不开，" +
        "换成真实 embedding 模型后重跑。",
    );
  }
  return lines.join("\n");
}
