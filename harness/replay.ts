import { DEFAULT_FIXTURE, formatReplay, runReplay, updateBaseline } from "./run.js";

/**
 * 回放回归台的 CLI。
 *
 *   npm run harness                    跑基线，人和机器都读这一份输出
 *   npm run harness -- --explain       追加逐条相似度，用来核对阈值是否被踩到
 *   npm run harness -- --update        改完规则、确认新行为是对的之后更新基线
 *   npm run harness -- --fixture=path  换一份 fixture（比如换成一个真实抓取的快照）
 *
 * 同一份断言也在 harness/replay.test.ts 里跑，所以 `npm test` 已经包含它；
 * 这个 CLI 的价值是可读输出和 --update，不是另一套判定。
 */

interface Args {
  fixture: string;
  update: boolean;
  explain: boolean;
}

function parseArgs(argv: string[]): Args {
  const fixtureArg = argv.find((arg) => arg.startsWith("--fixture="));
  return {
    fixture: fixtureArg ? fixtureArg.slice("--fixture=".length) : DEFAULT_FIXTURE,
    update: argv.includes("--update"),
    explain: argv.includes("--explain"),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const result = await runReplay({ fixturePath: args.fixture, explain: args.explain });
  process.stdout.write(formatReplay(result));

  if (args.update) {
    updateBaseline(args.fixture, result);
    process.stdout.write(`基线已写入 ${args.fixture}\n`);
    process.stdout.write(
      "写之前先确认上面每一条「本来就该是这样」：基线是断言，不是快照。\n" +
        "如果只是想让它变绿，那这条用例就没有存在的意义了。\n\n",
    );
    return 0;
  }

  return result.failed === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(
      `回放失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
