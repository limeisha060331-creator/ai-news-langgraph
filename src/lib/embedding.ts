import { createHash } from "node:crypto";

import type { Config } from "../config.js";
import { HttpError, requestJson, type HttpOptions } from "./http.js";

export interface EmbeddingProvider {
  readonly name: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** 余弦相似度。两个向量都已归一化时等价于点积，但这里不假设归一化。 */
export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function normalize(vector: number[]): number[] {
  let squares = 0;
  for (const value of vector) squares += value * value;
  if (squares <= 0) return vector;
  const norm = Math.sqrt(squares);
  return vector.map((value) => value / norm);
}

// --------------------------------------------------------------------------- mock

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "and", "or", "to", "in", "on", "at", "by",
  "with", "from", "is", "are", "was", "were", "be", "it", "its", "this",
  "that", "as", "new", "how", "why", "what", "your", "you", "we",
  "的", "了", "是", "在", "和", "与", "对", "就", "都", "而", "及",
]);

/**
 * 本地词法编码器：切词后哈希到固定维度，L2 归一化。
 *
 * 它和第一版 Python 节点用的是同一套思路，因此有一个必须说清楚的边界：
 * 同语言的近重复能抓到，跨语言（英文原文 vs 中文报道）抓不到。
 * 它的存在意义是让整条链路在没有 API key、没有网络时也能跑通和测试，
 * 真实语义去重必须把 EMBEDDING_PROVIDER 换成 openai 并重新标定阈值。
 */
export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = "mock-lexical";

  constructor(readonly dim: number = 256) {}

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dim).fill(0);
    const counts = new Map<string, number>();
    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
    for (const [token, count] of counts) {
      const digest = createHash("sha256").update(token).digest();
      const index = digest.readUInt32BE(0) % this.dim;
      const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
      const weight = (1 + Math.log(count)) * sign;
      vector[index] = (vector[index] ?? 0) + weight;
    }
    return normalize(vector);
  }
}

function tokenize(text: string): string[] {
  const lower = (text ?? "").toLowerCase();
  const tokens: string[] = [];
  for (const word of lower.match(/[a-z0-9]+(?:[._\-/][a-z0-9]+)*/g) ?? []) {
    if (word.length >= 2 && !STOPWORDS.has(word)) tokens.push(word);
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (const char of run) if (!STOPWORDS.has(char)) tokens.push(char);
    for (let index = 0; index < run.length - 1; index += 1) {
      tokens.push(run.slice(index, index + 2));
    }
  }
  return tokens;
}

// ------------------------------------------------------------------------- openai

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;

  constructor(
    private readonly config: Config,
    private readonly httpOptions: HttpOptions,
  ) {
    this.name = `openai:${config.EMBEDDING_MODEL}`;
  }

  get dim(): number {
    return this.config.EMBEDDING_DIM;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result: number[][] = [];
    for (let start = 0; start < texts.length; start += this.config.EMBEDDING_BATCH) {
      const batch = texts.slice(start, start + this.config.EMBEDDING_BATCH);
      result.push(...(await this.embedBatch(batch)));
    }
    return result;
  }

  private async embedBatch(batch: string[]): Promise<number[][]> {
    try {
      const payload = await requestJson<{ data: Array<{ embedding: number[] }> }>(
        `${this.config.EMBEDDING_BASE_URL.replace(/\/$/, "")}/embeddings`,
        this.httpOptions,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.config.EMBEDDING_API_KEY}`,
          },
          body: JSON.stringify({ model: this.config.EMBEDDING_MODEL, input: batch }),
        },
      );
      const vectors = payload.data.map((row) => row.embedding);
      for (const vector of vectors) {
        if (vector.length !== this.config.EMBEDDING_DIM) {
          throw new Error(
            `模型返回 ${vector.length} 维，但 EMBEDDING_DIM 配的是 ${this.config.EMBEDDING_DIM}。` +
              "维度不一致时 Redis 索引写入会直接失败，先把这两处对齐。",
          );
        }
      }
      return vectors;
    } catch (error) {
      if (error instanceof HttpError) {
        throw new Error(`embedding 接口返回 ${error.status}：${error.bodySnippet}`);
      }
      throw error;
    }
  }
}

export function createEmbeddingProvider(config: Config, httpOptions: HttpOptions): EmbeddingProvider {
  if (config.EMBEDDING_PROVIDER === "openai") {
    return new OpenAiEmbeddingProvider(config, httpOptions);
  }
  // mock 固定 256 维，省得为了跑通链路去配一个真实模型
  return new MockEmbeddingProvider(256);
}
