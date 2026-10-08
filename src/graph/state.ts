import { Annotation } from "@langchain/langgraph";

import { emptyStats, type Article, type DroppedItem, type Stats } from "../types.js";

/**
 * 各节点只汇报自己关心的那几个计数，最后用 finalizeStats 补全。
 * 要求每个节点都返回完整 Stats 会让「我只负责这一步」变得没法表达。
 */
export type StatsUpdate = Partial<Stats>;

function mergeStats(current: StatsUpdate, update: StatsUpdate): StatsUpdate {
  return {
    ...current,
    ...update,
    bySource: { ...current.bySource, ...(update.bySource ?? {}) },
  };
}

/**
 * 摄入图的状态。
 *
 * 除了 articles 是「整体替换」之外，其余字段都用累加型 reducer：
 * 被丢弃的条目和警告是沿途攒出来的，多个节点各写各的，谁都不该覆盖谁。
 */
export const IngestionState = Annotation.Root({
  runDate: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => new Date().toISOString().slice(0, 10),
  }),
  articles: Annotation<Article[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  dropped: Annotation<DroppedItem[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  warnings: Annotation<string[]>({
    reducer: (current, update) => [...current, ...update],
    default: () => [],
  }),
  stats: Annotation<StatsUpdate>({
    reducer: mergeStats,
    default: () => emptyStats(),
  }),
  report: Annotation<string>({
    reducer: (_current, update) => update,
    default: () => "",
  }),
  delivered: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
});

export type IngestionStateType = typeof IngestionState.State;
export type IngestionUpdate = typeof IngestionState.Update;

/** 把沿途攒起来的计数补成完整对象，缺失的一律按 0 处理。 */
export function finalizeStats(partial: StatsUpdate | undefined): Stats {
  return { ...emptyStats(), ...(partial ?? {}), bySource: { ...(partial?.bySource ?? {}) } };
}
