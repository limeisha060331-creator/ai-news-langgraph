import type { Article, DroppedItem } from "../types.js";
import type { IngestionStateType, IngestionUpdate } from "../graph/state.js";
import type { Deps } from "./deps.js";
import { log } from "../lib/logger.js";
import { normalizeUrl } from "../lib/url.js";
import { existingUrlKeys } from "../redis/schema.js";

/**
 * 归一化 + 去重，顺序很关键：
 *
 *   1. URL 归一化。补协议头、折叠 www、剔除跟踪参数，否则同一条会被当成两条。
 *   2. 批内去重。同一次抓取里三个源可能给出同一个链接。
 *   3. 历史过滤。查 Redis 里的已推送记录，这一步是最大的一刀：
 *      OpenAI 那个 feed 是全量归档，一次返回一千多条，其中当天真正新增的只有十几条。
 *
 * 为什么必须排在 summarize 前面：它不花钱。放在模型调用之后，
 * 等于每天为上千条马上要丢掉的内容付摘要费用。
 */
export function createNormalizeNode(deps: Deps) {
  return async function normalizeNode(
    state: IngestionStateType,
  ): Promise<Partial<IngestionUpdate>> {
    const dropped: DroppedItem[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    const candidates: Article[] = [];

    for (const article of state.articles) {
      const urlKey = normalizeUrl(article.url);
      if (!urlKey) {
        dropped.push({
          urlKey: "",
          title: article.title,
          source: article.source,
          reason: "missing-url",
        });
        continue;
      }
      if (seen.has(urlKey)) {
        dropped.push({
          urlKey,
          title: article.title,
          source: article.source,
          reason: "duplicate-url-batch",
        });
        continue;
      }
      seen.add(urlKey);
      candidates.push({ ...article, urlKey, url: urlKey });
    }

    // Redis 不可用时不拦条目：宁可今天多推两条重复，也不要因为存储故障把日报清空
    let historyHits = new Set<string>();
    try {
      historyHits = await existingUrlKeys(
        deps.redis,
        candidates.map((article) => article.urlKey),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      warnings.push(`历史去重跳过（Redis 查询失败）：${reason}`);
      log.warn("历史去重跳过", { reason });
    }

    const fresh: Article[] = [];
    for (const article of candidates) {
      if (historyHits.has(article.urlKey)) {
        dropped.push({
          urlKey: article.urlKey,
          title: article.title,
          source: article.source,
          reason: "duplicate-url-history",
        });
        continue;
      }
      fresh.push(article);
    }

    log.info("归一化与 URL 去重完成", {
      before: state.articles.length,
      after: fresh.length,
      batchDuplicates: dropped.filter((row) => row.reason === "duplicate-url-batch").length,
      historyDuplicates: dropped.filter((row) => row.reason === "duplicate-url-history").length,
    });

    return {
      articles: fresh,
      dropped,
      warnings,
      stats: { afterUrlDedup: fresh.length, droppedByUrl: dropped.length },
    };
  };
}
