import { describe, expect, it } from "vitest";

import { CALIBRATION_PAIRS } from "../src/fixtures/calibration-pairs.js";
import { calibrate, formatReport } from "../src/lib/calibrate.js";
import { MockEmbeddingProvider } from "../src/lib/embedding.js";

describe("calibrate", () => {
  it("用词法编码器跑标注样本，会明确报告不可分", async () => {
    const report = await calibrate(new MockEmbeddingProvider(256), CALIBRATION_PAIRS);
    expect(report.rows).toHaveLength(CALIBRATION_PAIRS.length);
    // 词法编码器抓不到跨语言同事件，同一事件组的最低分低于不同事件组的最高分，
    // 所以它必须如实报告「不可分」，而不是硬给一个阈值
    expect(report.separable).toBe(false);
    expect(report.suggestedDupThreshold).toBeNull();
  });

  it("报告里带上不可分的原因", () => {
    const text = formatReport({
      provider: "test",
      sameEventScores: [0.3],
      differentEventScores: [0.6],
      sameEventMin: 0.3,
      differentEventMax: 0.6,
      separable: false,
      suggestedDupThreshold: null,
      suggestedGrayLow: null,
      rows: [],
    });
    expect(text).toContain("不可分");
    expect(text).toContain("换");
  });
});
