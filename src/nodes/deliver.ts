import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";
import { renderReport } from "../lib/report.js";

/**
 * 产出日报并落盘。
 *
 * 日报是用代码从结构化条目拼出来的，不是让模型写完整篇 Markdown——
 * 分档、顺序、链接格式都由代码保证，模型只负责单条的标题和摘要。
 * 第一版把分档规则写在提示词里，模型不照做就只能靠事后兜底。
 *
 * 送达是 store 的前置条件（图里用条件边表达）：没有送达就不写历史。
 * 反过来也有一条硬约束：日报必须覆盖本次送达的每一条（见 renderReport 的契约），
 * 否则「写回历史」会把读者没见过的内容标记成已推送。
 *
 * 参数名是 `_deps`：版面渲染迁到 lib/report.ts 之后这里确实用不到 deps，但保留参数位置，
 * 让八个节点工厂的签名保持一致（依赖一律从 Deps 注入）。TS 对 `_` 前缀的未使用参数不作检查。
 */
export function createDeliverNode(_deps: Deps) {
  return async function deliverNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const articles = state.articles;
    if (articles.length === 0) {
      log.warn("没有可推送的条目，本次不产出日报，也不写历史");
      return { report: "", delivered: false, stats: { delivered: 0, listed: 0 } };
    }

    const rendered = renderReport(articles, state.runDate);
    const path = resolve(process.cwd(), "outbox", `${state.runDate}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${rendered.markdown}\n`, "utf8");
    log.info("日报已落盘", {
      path,
      count: articles.length,
      inBody: rendered.placed.length,
      inSummary: rendered.listed.length,
    });

    // listed 与 delivered 应当恒等。不相等说明日报漏了内容，而下一步就要把这些内容写进历史——
    // 这里显式叫出来，别让它变成「第二天这些内容再也不出现」的谜。
    if (rendered.listed.length !== articles.length) {
      log.error("日报覆盖不全，和送达条数对不上", {
        delivered: articles.length,
        listed: rendered.listed.length,
      });
    }

    return {
      report: rendered.markdown,
      delivered: true,
      stats: { delivered: articles.length, listed: rendered.listed.length },
      ...(rendered.listed.length === articles.length
        ? {}
        : {
            warnings: [
              `日报覆盖不全：送达 ${articles.length} 条，汇总只列了 ${rendered.listed.length} 条`,
            ],
          }),
    };
  };
}
