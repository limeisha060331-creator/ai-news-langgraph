import type { BaseStore } from "@langchain/langgraph";

export interface EpisodeMemory {
  text: string;
  updatedAt: string;
  threadId: string;
}

function profileNamespace(userId: string): string[] {
  return ["user", userId, "profile"];
}

function episodeNamespace(userId: string): string[] {
  return ["user", userId, "episodes"];
}

function valueText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const value = (item as { value?: unknown }).value;
  if (!value || typeof value !== "object") return "";
  const text = (value as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function updatedAtMs(item: unknown): number {
  if (!item || typeof item !== "object") return 0;
  const row = item as { updated_at?: unknown; value?: unknown };
  if (row.updated_at instanceof Date) return row.updated_at.getTime();
  // RedisStore 的 updated_at 是纳秒时间戳；InMemoryStore 用 Date。
  if (typeof row.updated_at === "number") return row.updated_at / 1e6;
  const text = (row.value as { updatedAt?: unknown } | undefined)?.updatedAt;
  return typeof text === "string" ? Date.parse(text) || 0 : 0;
}

/**
 * 读长期记忆。
 *
 * profile 是稳定偏好，episodes 是过去线程的结论。两者都只取短文本，
 * 不把 Store 里的原始对话整段带进上下文。
 */
export async function readMemory(
  store: BaseStore,
  userId: string,
  limit: number,
  excludeThreadId?: string,
  query?: string,
): Promise<string> {
  const recentLimit = excludeThreadId ? limit + 1 : limit;
  const [profile, recent] = await Promise.all([
    store.get(profileNamespace(userId), "default"),
    store.search(episodeNamespace(userId), { limit: recentLimit }),
  ]);

  // 先按语义取和历史结论，再用最近结论补足。Store 没配向量时
  // `query` 会被忽略，结果自然退化成「最近 N 条」。
  const semantic =
    query && query.trim()
      ? await store
          .search(episodeNamespace(userId), { query, limit: recentLimit })
          .catch(() => [])
      : [];
  const seen = new Set(semantic.map((item) => item.key));
  const episodes = [
    ...semantic,
    ...recent.filter((item) => !seen.has(item.key)),
  ].slice(0, recentLimit);

  const profileText = valueText(profile);
  const episodeRows = episodes
    .map((item) => ({
      text: valueText(item),
      threadId: (item.value as { threadId?: unknown } | undefined)?.threadId,
      updatedAt: updatedAtMs(item),
    }))
    .filter((row) => row.text)
    // 当前线程的上一轮已经在最近的对话里，不必再从长期记忆读一遍。
    .filter((row) => !excludeThreadId || row.threadId !== excludeThreadId)
    .sort((left, right) => right.updatedAt - left.updatedAt);

  const blocks: string[] = [];
  if (profileText) blocks.push(`用户偏好：\n${profileText}`);
  if (episodeRows.length > 0) {
    blocks.push(
      `历史结论：\n${episodeRows
        .slice(0, limit)
        .map((row) => `- ${row.text}`)
        .join("\n")}`,
    );
  }
  return blocks.join("\n\n");
}

/** 每轮结束后写一条情节记忆；只保留问答摘要，不保留检索候选。 */
export async function writeEpisode(
  store: BaseStore,
  userId: string,
  threadId: string,
  question: string,
  answer: string,
): Promise<void> {
  const text = `Q: ${question.slice(0, 240)}\nA: ${answer.slice(0, 600)}`;
  const value: EpisodeMemory = {
    text,
    threadId,
    updatedAt: new Date().toISOString(),
  };
  await store.put(episodeNamespace(userId), threadId, value);
}

/** 显式偏好直接写入；相同内容不重复追加。 */
export async function rememberProfile(
  store: BaseStore,
  userId: string,
  text: string,
): Promise<void> {
  const current = await store.get(profileNamespace(userId), "default");
  const existing = valueText(current);
  if (existing.includes(text)) return;
  const merged = [existing, text].filter(Boolean).join("\n").slice(-1200);
  await store.put(profileNamespace(userId), "default", {
    text: merged,
    updatedAt: new Date().toISOString(),
  });
}

/** 是否值得写入长期偏好。先只认显式表达，避免把普通新闻句误记成偏好。 */
export function explicitPreference(text: string): string | null {
  const match = text.match(
    /(?:请?记住|我的偏好是|我关注|以后都|以后只)[：:，,\s]*(.{2,120})/,
  );
  return match?.[1]?.trim() ?? null;
}
