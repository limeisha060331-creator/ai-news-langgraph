import { config as loadDotenv } from "dotenv";
import { z } from "zod";

loadDotenv();

const EnvSchema = z.object({
  REDIS_URL: z.string().default("redis://localhost:6379"),
  REDIS_INDEX: z.string().default("idx:article"),

  USER_AGENT: z.string().default(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  ),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  FETCH_RETRIES: z.coerce.number().int().min(0).default(3),
  MIN_PER_SOURCE: z.coerce.number().int().min(0).default(3),
  TOP_N: z.coerce.number().int().positive().default(15),
  HISTORY_DAYS: z.coerce.number().int().positive().default(30),

  EMBEDDING_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  EMBEDDING_BASE_URL: z.string().default("https://api.openai.com/v1"),
  EMBEDDING_API_KEY: z.string().default(""),
  EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),
  EMBEDDING_BATCH: z.coerce.number().int().positive().default(64),

  LLM_PROVIDER: z.enum(["openai", "mock"]).default("mock"),
  LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_API_KEY: z.string().default(""),
  LLM_MODEL: z.string().default("deepseek-chat"),
  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),

  DUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.9),
  GRAY_LOW: z.coerce.number().min(0).max(1).default(0.8),
  SAME_SOURCE_MARGIN: z.coerce.number().min(0).max(1).default(0.03),
  KNN_TOP_K: z.coerce.number().int().positive().default(5),
});

export type Config = z.infer<typeof EnvSchema>;

/** 解析并校验环境变量。缺什么、写错什么在这里一次性报清楚，不要留到运行时才炸。 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`环境变量不合法：\n${detail}\n对照 .env.example 检查一遍。`);
  }
  const config = parsed.data;
  if (config.EMBEDDING_PROVIDER === "openai" && !config.EMBEDDING_API_KEY) {
    throw new Error("EMBEDDING_PROVIDER=openai 时必须填 EMBEDDING_API_KEY。");
  }
  if (config.LLM_PROVIDER === "openai" && !config.LLM_API_KEY) {
    throw new Error("LLM_PROVIDER=openai 时必须填 LLM_API_KEY。");
  }
  if (config.GRAY_LOW > config.DUP_THRESHOLD) {
    throw new Error(
      `GRAY_LOW(${config.GRAY_LOW}) 不能大于 DUP_THRESHOLD(${config.DUP_THRESHOLD})，` +
        "否则疑似区间是空的。",
    );
  }
  return config;
}
