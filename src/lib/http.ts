export interface HttpOptions {
  userAgent: string;
  timeoutMs: number;
  retries: number;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly bodySnippet: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function backoffMs(attempt: number): number {
  // 指数退避 + 抖动，避免多个源同时重试打出尖峰
  const base = Math.min(2 ** attempt * 500, 8000);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 带超时与重试的请求。三个源都要走这里：
 *   - 请求头固定带浏览器 UA，量子位的 CDN 对默认 UA 直接返 403 空响应
 *   - 单源失败只影响自己，抛错由调用方兜住，不打断整条流水线
 */
export async function requestText(
  url: string,
  options: HttpOptions,
  init: RequestInit = {},
): Promise<string> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          "user-agent": options.userAgent,
          accept: "application/json, text/xml, application/xml, text/html;q=0.9,*/*;q=0.8",
          ...(init.headers ?? {}),
        },
      });
      const body = await response.text();
      if (!response.ok) {
        if (RETRYABLE_STATUS.has(response.status) && attempt < options.retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new HttpError(
          `请求 ${url} 失败：HTTP ${response.status}`,
          response.status,
          body.slice(0, 200),
        );
      }
      return body;
    } catch (error) {
      lastError = error;
      if (error instanceof HttpError) throw error;
      if (attempt >= options.retries) break;
      await sleep(backoffMs(attempt));
    } finally {
      clearTimeout(timer);
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`请求 ${url} 重试 ${options.retries} 次后仍失败：${reason}`);
}

export async function requestJson<T>(
  url: string,
  options: HttpOptions,
  init: RequestInit = {},
): Promise<T> {
  const body = await requestText(url, options, init);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`请求 ${url} 的响应不是合法 JSON：${body.slice(0, 200)}`);
  }
}
