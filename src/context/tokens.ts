/**
 * 粗略 token 估算，只用于预算和日志，不用于计费。
 *
 * 中文按字计，英文按词计并乘 1.3，通常比真实 tokenizer 略保守。
 * 真实用量以模型返回的 usage 为准；后续应把两者差值记进 contextReport。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[a-z0-9]+/gi) ?? []).length;
  return Math.ceil(cjk + latin * 1.3);
}

/**
 * 按估算 token 截断文本。
 *
 * 预算判断和实际截断都用同一个估算函数，避免「报告说没超，模型却超了」
 * 这种两套口径。二分查找按字符切，中文和英文都能覆盖。
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;

  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (estimateTokens(text.slice(0, middle)) <= maxTokens) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${text.slice(0, low).trimEnd()}…`;
}
