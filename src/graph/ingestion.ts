import { END, START, StateGraph } from "@langchain/langgraph";

import type { Deps } from "../nodes/deps.js";
import { IngestionState, type IngestionStateType } from "./state.js";
import { createFetchNode } from "../nodes/fetch.js";
import { createNormalizeNode } from "../nodes/normalize.js";
import { createRankNode } from "../nodes/rank.js";
import { createSummarizeNode } from "../nodes/summarize.js";
import { createEmbedNode } from "../nodes/embed.js";
import { createDedupeNode } from "../nodes/dedupe.js";
import { createDeliverNode } from "../nodes/deliver.js";
import { createStoreNode } from "../nodes/store.js";

/**
 * 摄入图：fetch → normalize → rank → summarize → embed → dedupe → deliver → store。
 *
 * 三个顺序上的决定，都是实际踩过之后才这么排的。
 *
 * 一、normalize（含历史过滤）排在 summarize 之前。
 * 抓取一次有一千多条，其中当天真正新增的只有十几条；先过滤再摘要，
 * 模型调用量差两个数量级。
 *
 * 二、rank 排在 summarize 之前。
 * 先给每个源留保底名额再截断，避免产量大的源独占候选。
 *
 * 三、store 挂在 deliver 之后，且只在送达成功时执行。
 * Dify 那版的教训：只看 HTTP 状态码会把业务失败当成成功，
 * 历史一旦写脏，第二天这些内容就再也推不出来了。
 */
export function buildIngestionGraph(deps: Deps) {
  return new StateGraph(IngestionState)
    .addNode("fetch", createFetchNode(deps))
    .addNode("normalize", createNormalizeNode(deps))
    .addNode("rank", createRankNode(deps))
    .addNode("summarize", createSummarizeNode(deps))
    .addNode("embed", createEmbedNode(deps))
    .addNode("dedupe", createDedupeNode(deps))
    .addNode("deliver", createDeliverNode(deps))
    .addNode("store", createStoreNode(deps))
    .addEdge(START, "fetch")
    .addEdge("fetch", "normalize")
    .addEdge("normalize", "rank")
    .addEdge("rank", "summarize")
    .addEdge("summarize", "embed")
    .addEdge("embed", "dedupe")
    .addEdge("dedupe", "deliver")
    .addConditionalEdges("deliver", afterDeliver, { store: "store", end: END })
    .addEdge("store", END)
    .compile();
}

/**
 * 没送达就不写历史。这条边是整个流水线里最重要的一条：
 * 写早了，那些没推出去的内容就会被当成已处理，永远消失。
 */
function afterDeliver(state: IngestionStateType): "store" | "end" {
  return state.delivered ? "store" : "end";
}
