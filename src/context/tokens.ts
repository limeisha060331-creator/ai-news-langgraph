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
