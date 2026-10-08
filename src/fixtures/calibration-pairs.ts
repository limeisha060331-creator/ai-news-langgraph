export interface CalibrationPair {
  a: string;
  b: string;
  /** 人工标注：这两条讲的是不是同一件事 */
  sameEvent: boolean;
}

/**
 * 阈值标定用例。这 10 对是从第一版 Python 节点直接搬过来的，
 * 当时用词法编码器跑出来的结果是：同语言同事件能分开，跨语言同事件全部落在 0.07 至 0.30，
 * 不同事件同源最高 0.667。换成真 embedding 模型后重跑这份用例，才能定 dup_threshold。
 */
export const CALIBRATION_PAIRS: CalibrationPair[] = [
  {
    a: "OpenAI releases GPT-5 to all users。GPT-5 is now available in ChatGPT.",
    b: "OpenAI 正式发布 GPT-5。GPT-5 今天起在 ChatGPT 全量开放。",
    sameEvent: true,
  },
  {
    a: "Anthropic raises $4B at $180B valuation",
    b: "Anthropic 完成 40 亿美元融资，估值 1800 亿",
    sameEvent: true,
  },
  {
    a: "Google DeepMind open-sources a new protein model。Faster structure prediction.",
    b: "DeepMind 开源新一代蛋白质结构模型。推理速度比上一代快 3 倍。",
    sameEvent: true,
  },
  {
    a: "Meta open-sources Llama 4",
    b: "Llama 4 权重已开源",
    sameEvent: true,
  },
  {
    a: "机器之心：国产大模型发布新版本。参数规模 700 亿。",
    b: "国产大模型发布新版本，参数 700 亿",
    sameEvent: true,
  },
  {
    a: "Show HN: I built a tiny workflow engine。A weekend project, single binary.",
    b: "Show HN: my workflow engine, now with retries。Added retry support.",
    sameEvent: false,
  },
  {
    a: "OpenAI releases GPT-5 to all users",
    b: "OpenAI 扩大 ChatGPT 广告投放",
    sameEvent: false,
  },
  {
    a: "Rust 1.90 released",
    b: "Rust 1.91 released",
    sameEvent: false,
  },
  {
    a: "Anthropic raises $4B at $180B valuation",
    b: "Anthropic 发布 Claude 新版本",
    sameEvent: false,
  },
  {
    a: "Google DeepMind open-sources a new protein model",
    b: "Google 发布新一代 TPU",
    sameEvent: false,
  },
];
