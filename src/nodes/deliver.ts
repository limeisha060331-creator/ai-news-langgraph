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
 */
export function createDeliverNode(deps: Deps) {
  return async function deliverNode(state: IngestionStateType): Promise<Partial<IngestionUpdate>> {
    const articles = state.articles;
    if (articles.length === 0) {
      log.warn("没有可推送的条目，本次不产出日报，也不写历史");
      return { report: "", delivered: false, stats: { delivered: 0 } };
    }

    const report = renderReport(articles, state.runDate);
    const path = resolve(process.cwd(), "outbox", `${state.runDate}.md`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${report}\n`, "utf8");
    log.info("日报已落盘", { path, count: articles.length });

    return { report, delivered: true, stats: { delivered: articles.length } };
  };
}
