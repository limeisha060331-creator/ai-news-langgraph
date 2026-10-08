import { createHash } from "node:crypto";

/**
 * 去重时忽略的参数。与第一版 Python 实现保持一致，
 * 少一条就会出现「同一条内容因为跟踪参数不同被推两遍」。
 */
export const TRACKING_PARAMS = new Set([
  "ref",
  "fbclid",
  "gclid",
  "spm",
  "from",
  "source",
  "share_token",
]);

/**
 * URL 归一化：补协议头、小写主机、折叠 www、剔除跟踪参数、去尾斜杠与锚点。
 *
 * 与第一版的一处有意的差异：这里的查询参数会排序。
 * 那个版本沿用原顺序，`?a=1&b=2` 和 `?b=2&a=1` 会被当成两条，
 * 排序后才是正确的去重语义。
 */
export function normalizeUrl(raw: string): string {
  if (typeof raw !== "string") return "";
  let text = raw.trim();
  if (!text) return "";

  // 裸域名补协议头：HN 抓到的链接不带协议，不补的话取不到主机名，
  // 归一化会整个退化成原样返回，跨天去重就失效了
  const head = text.split("?", 1)[0] ?? "";
  if (!head.includes("//")) {
    text = `https://${text}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return text.toLowerCase().replace(/\/+$/, "");
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return text.toLowerCase().replace(/\/+$/, "");

  const params: Array<[string, string]> = [];
  for (const [key, value] of parsed.searchParams.entries()) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_") || TRACKING_PARAMS.has(lower)) continue;
    params.push([key, value]);
  }
  params.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));

  const search = new URLSearchParams(params).toString();
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  const port = parsed.port ? `:${parsed.port}` : "";
  return `https://${host}${port}${path}${search ? `?${search}` : ""}`;
}

/** Redis 的 key 用短哈希，避免超长 URL 撑爆 key；原 URL 存在文档里。 */
export function urlToId(urlKey: string): string {
  return createHash("sha1").update(urlKey).digest("hex").slice(0, 16);
}
