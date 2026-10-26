import type { Config } from "../config.js";
import type { HttpOptions } from "./http.js";
import { requestJson } from "./http.js";
import { renderEvidenceCards } from "../context/budget.js";
import type { EvidenceCard } from "../types.js";

export interface Answerer {
  readonly name: string;
  answer(question: string, evidence: EvidenceCard[]): Promise<string>;
}

const SYSTEM = [
  "你是资讯助手。只能依据给定的证据卡回答问题，不要补充外部知识，不要编造事实。",
  "答案用中文，3 到 6 句。每提到一条资讯，后面用 [E1] 这种证据编号标出来源。",
  "证据卡里没有链接或摘要时，不要假装有；不足以回答就直接说「检索到的条目里没有相关内容」。",
].join("\n");

export class OpenAiAnswerer implements Answerer {
  readonly name: string;

  constructor(
    private readonly config: Config,
    private readonly httpOptions: HttpOptions,
  ) {
    this.name = `openai:${config.LLM_MODEL}`;
  }

  async answer(question: string, evidence: EvidenceCard[]): Promise<string> {
    const context = renderEvidenceCards(evidence);
    const response = await requestJson<{ choices: Array<{ message: { content: string } }> }>(
      `${this.config.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`,
      { ...this.httpOptions, timeoutMs: this.config.LLM_TIMEOUT_MS },
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: this.config.LLM_MODEL,
          temperature: 0.2,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `问题：${question}\n\n证据卡：\n${context || "（空）"}` },
          ],
        }),
      },
    );
    return response.choices[0]?.message?.content?.trim() ?? "";
  }
}

/** 离线回答器：把检索结果原样列出来，用于验证检索链路本身。 */
export class MockAnswerer implements Answerer {
  readonly name = "mock";

  async answer(question: string, evidence: EvidenceCard[]): Promise<string> {
    if (evidence.length === 0) {
      return `问题「${question}」：检索到的条目里没有相关内容。`;
    }
    const lines = evidence.map(
      (row) =>
        `[${row.id}] ${row.title} — ${row.source}（相似度 ${row.similarity.toFixed(3)}）`,
    );
    return `（mock 回答，仅回声证据卡）\n${lines.join("\n")}`;
  }
}

export function createAnswerer(config: Config, httpOptions: HttpOptions): Answerer {
  if (config.LLM_PROVIDER === "openai") {
    return new OpenAiAnswerer(config, httpOptions);
  }
  return new MockAnswerer();
}
