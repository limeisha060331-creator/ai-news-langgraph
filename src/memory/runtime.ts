import { InMemoryStore, MemorySaver, type BaseCheckpointSaver, type BaseStore } from "@langchain/langgraph";
import { RedisSaver } from "@langchain/langgraph-checkpoint-redis";
import { RedisStore } from "@langchain/langgraph-checkpoint-redis/store";

import type { Config } from "../config.js";
import type { EmbeddingProvider } from "../lib/embedding.js";

export interface MemoryRuntime {
  checkpointer: BaseCheckpointSaver;
  store: BaseStore;
  close: () => Promise<void>;
}

/**
 * 记忆运行时：checkpointer 管线程内，store 管跨线程。
 *
 * 默认 memory 只用于测试和本地演示；redis 才会在进程重启后保留。
 * RedisStore 的 `index.embed` 需要 `embedDocuments` 形状，这里把项目已有的
 * EmbeddingProvider 包一层，避免再造一个 embedding 实现。
 */
export async function createMemoryRuntime(
  config: Config,
  embedder: EmbeddingProvider,
): Promise<MemoryRuntime> {
  if (config.MEMORY_PROVIDER === "memory") {
    return {
      checkpointer: new MemorySaver(),
      store: new InMemoryStore(),
      close: async () => {},
    };
  }

  const checkpointer = await RedisSaver.fromUrl(config.REDIS_URL, {
    defaultTTL: config.CHECKPOINT_TTL_DAYS * 24 * 60 * 60,
  });
  const redisStore = await RedisStore.fromConnString(config.REDIS_URL, {
    index: {
      dims: config.EMBEDDING_DIM,
      embed: {
        embedDocuments: (texts: string[]) => embedder.embed(texts),
        embedQuery: async (text: string) => (await embedder.embed([text]))[0] ?? [],
      },
      fields: ["text"],
    },
  });
  await redisStore.setup();

  return {
    // RedisStore 的 put 签名比 BaseStore 窄，运行时行为一致；这里只做类型适配。
    store: redisStore as unknown as BaseStore,
    checkpointer,
    close: async () => {
      await redisStore.close();
      await checkpointer.end();
    },
  };
}
