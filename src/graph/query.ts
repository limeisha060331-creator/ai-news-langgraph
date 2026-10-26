import { Annotation, END, START, StateGraph } from "@langchain/langgraph";

import type { Deps } from "../nodes/deps.js";
import type { Neighbor } from "../redis/schema.js";
import { createAnswerer, type Answerer } from "../lib/answer.js";
import { daysAgoEpochSeconds } from "../redis/schema.js";
import { hybridSearch } from "../retrieval/hybrid.js";
import { toEvidenceCards } from "../retrieval/evidence.js";
import { packEvidence, type ContextReport } from "../context/budget.js";
import type { EvidenceCard } from "../types.js";

export const QueryState = Annotation.Root({
  question: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
  sinceDays: Annotation<number>({ reducer: (_current, update) => update, default: () => 30 }),
  embedding: Annotation<number[]>({ reducer: (_current, update) => update, default: () => [] }),
  neighbors: Annotation<Neighbor[]>({ reducer: (_current, update) => update, default: () => [] }),
  evidence: Annotation<EvidenceCard[]>({ reducer: (_current, update) => update, default: () => [] }),
  contextReport: Annotation<ContextReport | null>({
    reducer: (_current, update) => update,
    default: () => null,
  }),
  answer: Annotation<string>({ reducer: (_current, update) => update, default: () => "" }),
});

export type QueryStateType = typeof QueryState.State;
export type QueryUpdate = typeof QueryState.Update;

/**
 * 查询图：问题 → 编码 → 混合检索 → 证据卡 → 生成带引用的回答。
 *
 * 回答层不再直接看文章，只看证据卡。这样上下文有明确上限，
 * 也避免模型拿到一堆没有摘要、没有链接的标题后自由发挥。
 */
export function buildQueryGraph(deps: Deps) {
  const answerer: Answerer = createAnswerer(deps.config, deps.httpOptions);

  async function embedQuestion(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    const [vector] = await deps.embedder.embed([state.question]);
    return { embedding: vector ?? [] };
  }

  async function search(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    const since = daysAgoEpochSeconds(state.sinceDays);
    const neighbors = await hybridSearch(
      deps.redis,
      deps.config.REDIS_INDEX,
      state.embedding,
      state.question,
      { k: deps.config.RETRIEVAL_TOP_K, sinceEpochSeconds: since },
    );
    return { neighbors };
  }

  async function buildEvidence(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    const cards = toEvidenceCards(state.neighbors, deps.config.EVIDENCE_TOP_K);
    const packed = packEvidence(cards, deps.config.CONTEXT_BUDGET);
    return { evidence: packed.cards, contextReport: packed.report };
  }

  async function compose(state: QueryStateType): Promise<Partial<QueryUpdate>> {
    return { answer: await answerer.answer(state.question, state.evidence) };
  }

  return new StateGraph(QueryState)
    .addNode("embedQuestion", embedQuestion)
    .addNode("search", search)
    .addNode("buildEvidence", buildEvidence)
    .addNode("compose", compose)
    .addEdge(START, "embedQuestion")
    .addEdge("embedQuestion", "search")
    .addEdge("search", "buildEvidence")
    .addEdge("buildEvidence", "compose")
    .addEdge("compose", END)
    .compile();
}
