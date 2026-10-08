import { describe, expect, it } from "vitest";

import { MockEmbeddingProvider, cosineSimilarity } from "../src/lib/embedding.js";

describe("cosineSimilarity", () => {
  it("相同方向为 1，正交为 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("零向量返回 0 而不是 NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it("维度不一致返回 0", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("MockEmbeddingProvider", () => {
  const provider = new MockEmbeddingProvider(256);

  it("是确定性的：同一段文本两次得到同一个向量", async () => {
    const [first] = await provider.embed(["OpenAI releases GPT-5"]);
    const [second] = await provider.embed(["OpenAI releases GPT-5"]);
    expect(first).toEqual(second);
  });

  it("同语言近重复的相似度明显高于不相关内容", async () => {
    const [a, b, c] = await provider.embed([
      "OpenAI 发布 GPT-5 模型，推理能力提升",
      "OpenAI 正式发布 GPT-5，推理能力提升明显",
      "Rust 1.90 发布，改进了借用检查器",
    ]);
    expect(cosineSimilarity(a!, b!)).toBeGreaterThan(cosineSimilarity(a!, c!));
  });

  it("跨语言同事件抓不到，这是词法编码器的已知边界", async () => {
    // 这条用例是把「已知限制」写成测试，而不是假装它能用。
    // 换真实 embedding 模型后，这个断言会失败，那时应当删掉它并重新标定阈值。
    const [english, chinese] = await provider.embed([
      "OpenAI releases GPT-5 to all users",
      "OpenAI 正式发布 GPT-5",
    ]);
    expect(cosineSimilarity(english!, chinese!)).toBeLessThan(0.5);
  });
});
