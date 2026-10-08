import { loadConfig, type Config } from "./config.js";
import { createEmbeddingProvider, type EmbeddingProvider } from "./lib/embedding.js";
import { createSummarizer, type Summarizer } from "./lib/llm.js";
import type { HttpOptions } from "./lib/http.js";
import { assertVectorSupport, connectRedis, type RedisClient } from "./redis/client.js";
import type { Deps } from "./nodes/deps.js";

export interface Runtime {
  config: Config;
  deps: Deps;
  close: () => Promise<void>;
}

export function httpOptionsOf(config: Config): HttpOptions {
  return {
    userAgent: config.USER_AGENT,
    timeoutMs: config.FETCH_TIMEOUT_MS,
    retries: config.FETCH_RETRIES,
  };
}

/** 组装运行时依赖。连不上 Redis 就直接失败，不要带着半截状态往下跑。 */
export async function createRuntime(): Promise<Runtime> {
  const config = loadConfig();
  const httpOptions = httpOptionsOf(config);
  const redis: RedisClient = await connectRedis(config.REDIS_URL);
  await assertVectorSupport(redis);

  const embedder: EmbeddingProvider = createEmbeddingProvider(config, httpOptions);
  const summarizer: Summarizer = createSummarizer(config, httpOptions);

  const deps: Deps = {
    config,
    redis,
    embedder,
    summarizer,
    httpOptions,
    now: () => new Date(),
  };

  return {
    config,
    deps,
    close: async () => {
      await redis.quit();
    },
  };
}
