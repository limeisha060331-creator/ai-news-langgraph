import { createClient } from "redis";

/**
 * 连接 Redis。需要的是带 RediSearch 的 Redis Stack / Redis 8，
 * 普通 redis:6 镜像没有向量检索能力，连上也没法建索引。
 */
export async function connectRedis(url: string) {
  const client = createClient({ url });
  client.on("error", (error: unknown) => {
    process.stderr.write(
      `${JSON.stringify({ level: "error", message: "redis 连接出错", detail: String(error) })}\n`,
    );
  });
  await client.connect();
  return client;
}

/**
 * 从 connectRedis 的返回值反推类型，而不是手写 RedisClientType 的泛型。
 * 手写时很容易把 RespVersions 之类的参数填成默认值，赋值就对不上；
 * 反过来若为了绕过错误把泛型放宽到 any，命令签名会整体塌成 never，更难查。
 */
export type RedisClient = Awaited<ReturnType<typeof connectRedis>>;

/** 确认服务端真的带向量检索模块，给出可执行的排查提示。 */
export async function assertVectorSupport(client: RedisClient): Promise<void> {
  try {
    await client.ft._list();
  } catch (error) {
    throw new Error(
      "这个 Redis 没有 RediSearch 模块（FT._LIST 调用失败）。" +
        "普通 redis:6/7 镜像不带向量检索，换成 redis/redis-stack-server 或 Redis 8 社区版。" +
        `原始错误：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
