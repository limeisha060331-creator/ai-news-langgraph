import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type { Deps } from "../nodes/deps.js";
import type { Neighbor } from "../redis/schema.js";
import { createAnswerer, type Answerer } from "../lib/answer.js";
import { log } from "../lib/logger.js";
import { daysAgoEpochSeconds, knnSearch, listSince } from "../redis/schema.js";

export const QueryState = Annotation.Root({
  question: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  sinceDays: Annotation<number>({ reducer: (_current, update) => update, default: () => 30 }),
  embedding: Annotation<number[]>({ reducer: (_current, update) => update, default: () => [] }),
  neighbors: Annotation<Neighbor[]>({ reducer: (_current, update) => update, default: () => [] }),
  answer: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
});

export type QueryStateType = typeof QueryState.State;
export type QueryUpdate = typeof QueryState.Update;

/**
 * 查询图：问题 → 编码 → 混合检索（时间过滤加 KNN）→ 生成带引用的回答。
 *
 * 时间过滤写在 KNN 前面（DIALECT 2 的预过滤），不是取完 KNN 再筛。
 * 后者在「过去一周 Agent 进展」这类问题上经常返回不满 k 条。
 */
export function buildQueryGraph(deps: Deps) {
  const answerer: Answerer = createAnswerer(deps.config, deps.httpOptions);

  async function embedQuestion(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    const [vector] = await deps.embedder.embed([state.question]);
    return { embedding: vector ?? [] };
  }

  async function search(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    if (state.embedding.length === 0) {
      return { neighbors: [] };
    }
    const since = daysAgoEpochSeconds(state.sinceDays);
    let neighbors: Neighbor[] = [];
    try {
      neighbors = await knnSearch(deps.redis, deps.config.REDIS_INDEX, state.embedding, {
        k: deps.config.KNN_TOP_K,
        sinceEpochSeconds: since,
      });
    } catch (error) {
      log.warn("向量检索失败，退回按时间取条目", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (neighbors.length === 0) {
      // 兜底：宁可给出「时间上最近的几条」，也不要空手而归
      neighbors = await listSince(deps.redis, deps.config.REDIS_INDEX, since, deps.config.KNN_TOP_K);
    }
    return { neighbors };
  }

  async function compose(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    return { answer: await answerer.answer(state.question, state.neighbors) };
  }

  return new StateGraph(QueryState)
    .addNode("embedQuestion", embedQuestion)
    .addNode("search", search)
    .addNode("compose", compose)
    .addEdge(START, "embedQuestion")
    .addEdge("embedQuestion", "search")
    .addEdge("search", "compose")
    .addEdge("compose", END)
    .compile();
}
