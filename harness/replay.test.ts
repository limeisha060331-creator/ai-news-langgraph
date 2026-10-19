import { describe, expect, it } from "vitest";

import { DEFAULT_FIXTURE, formatReplay, runReplay } from "./run.js";

/**
 * 回放基线进测试套件，而不是留在 `npm run harness` 里等人记得跑。
 *
 * 理由很直接：漏跑一次的代价就是一次静默的行为变化——某天日报少三条，
 * 或者同一批内容被推两遍。这类故障不会让 tsc 报错，也不会让别的用例失败。
 */
describe("回放基线（三源摄入）", () => {
  it("漏斗、行为用例与阈值指纹与基线一致", async () => {
    const result = await runReplay({ fixturePath: DEFAULT_FIXTURE });
    if (result.failed > 0) {
      // 测试里没地方看 CLI 的表格，失败时把同一份打印出来
      process.stdout.write(formatReplay(result));
    }
    expect(result.failed, "行为与基线不一致，见上面的 FAIL 行").toBe(0);
  }, 120_000);
});
