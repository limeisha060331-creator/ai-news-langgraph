import { describe, expect, it } from "vitest";

import { CALIBRATION_PAIRS } from "../src/fixtures/calibration-pairs.js";
import { calibrate, formatReport } from "../src/lib/calibrate.js";
import { MockEmbeddingProvider } from "../src/lib/embedding.js";

describe("calibrate", () => {
  it("用词法编码器跑标注样本，会如实报告单阈值不可分", async () => {
    const report = await calibrate(new MockEmbeddingProvider(256), CALIBRATION_PAIRS);
    expect(report.rows).toHaveLength(CALIBRATION_PAIRS.length);
    // 词法编码器抓不到跨语言同事件，同一事件组的最低分低于不同事件组的最高分
    expect(report.singleThresholdSeparable).toBe(false);
    expect(report.suggestedDupThreshold).toBeGreaterThan(report.differentEventMax);
    expect(report.suggestedGrayLow).toBeLessThanOrEqual(report.sameEventMin);
  });

  it("按建议阈值取，误杀恒为 0", async () => {
    const report = await calibrate(new MockEmbeddingProvider(256), CALIBRATION_PAIRS);
    // DUP_THRESHOLD 取在所有反例之上，构造上就不可能出现把不同事件判重的情况
    expect(report.expected.falseDrops).toBe(0);
    expect(report.expected.hardDropped + report.expected.suspected + report.expected.kept).toBe(
      CALIBRATION_PAIRS.length,
    );
  });

  it("两组分得开时两个阈值会收敛", async () => {
    const text = formatReport({
      provider: "test",
      sameEventScores: [0.9],
      differentEventScores: [0.4],
      sameEventMin: 0.9,
      differentEventMax: 0.4,
      singleThresholdSeparable: true,
      suggestedDupThreshold: 0.42,
      suggestedGrayLow: 0.88,
      expected: {
        hardDropped: 1,
        suspected: 0,
        kept: 1,
        falseDrops: 0,
        trueSuspects: 0,
        falseSuspects: 0,
      },
      rows: [],
    });
    expect(text).toContain("单阈值可分");
    expect(text).toContain("DUP_THRESHOLD=0.42");
  });

  it("报告给出可直接写入 .env 的两个值", () => {
    const text = formatReport({
      provider: "test",
      sameEventScores: [0.936, 0.805],
      differentEventScores: [0.894, 0.516],
      sameEventMin: 0.805,
      differentEventMax: 0.894,
      singleThresholdSeparable: false,
      suggestedDupThreshold: 0.914,
      suggestedGrayLow: 0.785,
      expected: {
        hardDropped: 1,
        suspected: 3,
        kept: 1,
        falseDrops: 0,
        trueSuspects: 2,
        falseSuspects: 1,
      },
      rows: [],
    });
    expect(text).toContain("单阈值不可分");
    expect(text).toContain("DUP_THRESHOLD=0.914");
    expect(text).toContain("GRAY_LOW=0.785");
    expect(text).toContain("误杀 0 对");
  });
});
