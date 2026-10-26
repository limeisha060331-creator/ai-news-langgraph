import type { BaseMessage } from "@langchain/core/messages";

import type { Config } from "../config.js";
import { requestJson, type HttpOptions } from "./http.js";

export interface ConversationSummarizer {
  readonly name: string;
  summarize(messages: BaseMessage[], previousSummary: string): Promise<string>;
}

const SYSTEM = [
  "你在压缩一段资讯研究对话。只保留后续还会用到的信息，不要写客套话。",
  "输出四行，固定格式：",
  "目标：<用户想解决什么>",
  "已确认：<带数字、日期、实体的事实，用分号分隔>",
  "未解决：<还没回答的问题>",
  "引用：<保留的 E 编号，用逗号分隔>",
  "不要编造对话里没有的事实；没有内容就写「无」。",
].join("\n");

function messageText(message: BaseMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

export function messageTextOf(message: BaseMessage): string {
  return messageText(message).replace(/\s+/g, " ").trim();
}

export class OpenAiConversationSummarizer implements ConversationSummarizer {
  readonly name: string;

  constructor(
    private readonly config: Config,
    private readonly httpOptions: HttpOptions,
  ) {
    this.name = `openai:${config.LLM_MODEL}`;
  }

  async summarize(messages: BaseMessage[], previousSummary: string): Promise<string> {
    const transcript = messages
      .map((message) => `${message.getType()}: ${messageTextOf(message).slice(0, 500)}`)
      .join("\n");
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
          temperature: 0.1,
          messages: [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content:
                `已有摘要：\n${previousSummary || "无"}\n\n` +
                `需要压缩的对话：\n${transcript || "（空）"}`,
            },
          ],
        }),
      },
    );
    return response.choices[0]?.message?.content?.trim() ?? "";
  }
}

/** 离线摘要器：确定性拼接，只验证压缩链路，不评估摘要质量。 */
export class MockConversationSummarizer implements ConversationSummarizer {
  readonly name = "mock";

  async summarize(messages: BaseMessage[], previousSummary: string): Promise<string> {
    const lines = messages
      .map((message) => `${message.getType()}：${messageTextOf(message).slice(0, 80)}`)
      .filter((line) => !line.endsWith("："));
    return [previousSummary, ...lines].filter(Boolean).join("\n").slice(0, 1500);
  }
}

export function createConversationSummarizer(
  config: Config,
  httpOptions: HttpOptions,
): ConversationSummarizer {
  if (config.LLM_PROVIDER === "openai") {
    return new OpenAiConversationSummarizer(config, httpOptions);
  }
  return new MockConversationSummarizer();
}
