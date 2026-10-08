import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../lib/embedding.js";
import type { SummaryResult, Summarizer } from "../lib/llm.js";
import type { HttpOptions } from "../lib/http.js";
import type { RedisClient } from "../redis/client.js";

export interface Deps {
  config: Config;
  redis: RedisClient;
  embedder: EmbeddingProvider;
  summarizer: Summarizer;
  httpOptions: HttpOptions;
  /** 便于测试注入固定时间 */
  now: () => Date;
}

export type { SummaryResult, Summarizer };
