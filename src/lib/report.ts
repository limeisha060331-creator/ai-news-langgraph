import type { Article } from "../types.js";

const SECTIONS: Array<{ title: string; matches: (importance: number) => boolean; limit: number }> = [
  { title: "今日头条", matches: (value) => value >= 4, limit: 2 },
  { title: "重要进展", matches: (value) => value === 4 || value === 5, limit: 5 },
  { title: "值得关注", matches: (value) => value >= 1 && value <= 3, limit: 6 },
];

function importanceOf(article: Article): number {
  return article.importance ?? Math.min(5, Math.max(1, article.weight));
}

/**
 * 用代码按评分分档，不依赖模型自觉。
 * 第一版把分档规则写在提示词里，模型完全可以不照做；改成代码分档后这类偏差整类消失。
 */
export function renderReport(articles: Article[], runDate: string): string {
  const rows = [...articles].sort((left, right) => {
    const byImportance = importanceOf(right) - importanceOf(left);
    if (byImportance !== 0) return byImportance;
    return right.weight - left.weight;
  });

  const sources = [...new Set(rows.map((row) => row.source))].join(" / ");
  const lines: string[] = [
    `# AI 日报 · ${runDate}`,
    "",
    `> 共 ${rows.length} 条 · 来源：${sources || "无"}`,
    "",
  ];

  const used = new Set<string>();
  let counter = 0;
  for (const section of SECTIONS) {
    lines.push(`## ${section.title}`, "");
    const picked = rows
      .filter((row) => !used.has(row.urlKey) && section.matches(importanceOf(row)))
      .slice(0, section.limit);
    if (picked.length === 0) {
      lines.push("今日无", "");
      continue;
    }
    for (const row of picked) {
      used.add(row.urlKey);
      counter += 1;
      lines.push(
        `### ${counter}. ${row.titleZh ?? row.title} · 重要性 ${importanceOf(row)}/5`,
        row.summary ?? "（摘要缺失，仅保留标题与链接）",
        `来源：${row.source} · [原文](${row.url})`,
        "",
      );
    }
  }

  lines.push("## 链接汇总", "");
  for (const row of rows) {
    if (!used.has(row.urlKey)) continue;
    lines.push(`- [${row.titleZh ?? row.title}](${row.url}) — ${row.source} · ${importanceOf(row)}/5`);
  }
  return lines.join("\n").trim();
}
