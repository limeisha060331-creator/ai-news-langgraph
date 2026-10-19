import type { Article } from "../types.js";

export interface ReportSection {
  title: string;
  matches: (importance: number) => boolean;
  limit: number;
}

/**
 * 版面配额。
 *
 * 「今日头条」的匹配条件（>= 4）是「重要进展」（4 | 5）的子集，两档依次从同一个池子里取，
 * 所以 4 至 5 分的条目能进正文的总容量是 2 + 5 = 7，不是三档 limit 之和 13。
 * 这个数字以前是散在代码里的隐性约束，导出来之后测试可以直接读到「正文最多几条」。
 */
export const SECTIONS: ReportSection[] = [
  { title: "今日头条", matches: (value) => value >= 4, limit: 2 },
  { title: "重要进展", matches: (value) => value === 4 || value === 5, limit: 5 },
  { title: "值得关注", matches: (value) => value >= 1 && value <= 3, limit: 6 },
];

export interface RenderReportResult {
  markdown: string;
  /** 进正文的 urlKey，按出现顺序 */
  placed: string[];
  /** 进链接汇总的 urlKey。不变量：长度恒等于入参条数 */
  listed: string[];
}

function importanceOf(article: Article): number {
  return article.importance ?? Math.min(5, Math.max(1, article.weight));
}

/**
 * 用代码按评分分档，不依赖模型自觉。
 * 第一版把分档规则写在提示词里，模型完全可以不照做；改成代码分档后这类偏差整类消失。
 *
 * 交付契约（改这里之前先读）：
 *
 *   1. 正文是「精选」，有条数上限，版面才不会被淹；
 *   2. 链接汇总必须覆盖本次送达的每一条——正文挑剩下的也在这里；
 *   3. 表头同时写总数与正文数，读者能看出汇总里还有东西。
 *
 * 第 2 条曾经是缺的：汇总只列「已排进正文」的行，而分档容量恒为 13（4–5 分的能力只有 7），
 * 送达 15 条时最多有 8 条既不进正文也不进汇总，却被 store 当成已推送写回历史，
 * 第二天不会再出现，读者永远看不到——静默丢内容。现在 `listed.length === articles.length`
 * 是一条硬不变量，tests/report.test.ts 与回放基线都在守它。
 */
export function renderReport(articles: Article[], runDate: string): RenderReportResult {
  const rows = [...articles].sort((left, right) => {
    const byImportance = importanceOf(right) - importanceOf(left);
    if (byImportance !== 0) return byImportance;
    return right.weight - left.weight;
  });

  const sources = [...new Set(rows.map((row) => row.source))].join(" / ");

  // 分档阶段只记「已进正文」，与「已进入日报」分开：汇总要用的是后者
  const placedKeys = new Set<string>();
  const placed: string[] = [];
  const body: string[] = [];
  let counter = 0;

  for (const section of SECTIONS) {
    body.push(`## ${section.title}`, "");
    const picked = rows
      .filter((row) => !placedKeys.has(row.urlKey) && section.matches(importanceOf(row)))
      .slice(0, section.limit);
    if (picked.length === 0) {
      body.push("今日无", "");
      continue;
    }
    for (const row of picked) {
      placedKeys.add(row.urlKey);
      placed.push(row.urlKey);
      counter += 1;
      body.push(
        `### ${counter}. ${row.titleZh ?? row.title} · 重要性 ${importanceOf(row)}/5`,
        row.summary ?? "（摘要缺失，仅保留标题与链接）",
        `来源：${row.source} · [原文](${row.url})`,
        "",
      );
    }
  }

  // 汇总列全部条目：已进正文的排前面（保持原来的阅读顺序），没排进档位的接在后面
  const ordered = [
    ...rows.filter((row) => placedKeys.has(row.urlKey)),
    ...rows.filter((row) => !placedKeys.has(row.urlKey)),
  ];
  body.push("## 链接汇总", "");
  for (const row of ordered) {
    body.push(`- [${row.titleZh ?? row.title}](${row.url}) — ${row.source} · ${importanceOf(row)}/5`);
  }

  const lines = [
    `# AI 日报 · ${runDate}`,
    "",
    `> 共 ${rows.length} 条 · 正文精选 ${placed.length} 条 · 来源：${sources || "无"}`,
    "",
    ...body,
  ];

  return {
    markdown: lines.join("\n").trim(),
    placed,
    listed: ordered.map((row) => row.urlKey),
  };
}
