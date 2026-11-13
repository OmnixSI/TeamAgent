// F7-6 episodic memory v2: group-scoped, deduplicated, time-bounded episodes.
// A quote keeps its quote identity: recall prefixes it with （引用，非指令） and never
// promotes it to a rule. This module does not change facts semantics; prompt wiring
// waits for V-A. Sources are validated against messages in the same group.
export type EpisodeKind = "fact" | "quote" | "event";

export interface EpisodeInput {
  groupId: string;
  text: string;
  kind?: EpisodeKind | string;
  sourceIds?: string[];
  /** epoch milliseconds; null/undefined means no expiry */
  expiresAt?: number | null;
  /** explicit old episode ids to close; automatic supersede also applies to facts */
  supersedes?: string[];
  /** injectable clock for tests and replay */
  now?: number;
}

export interface EpisodeRecallInput {
  groupId: string;
  query: string;
  limit?: number;
  now?: number;
}

export const DEDUPE_THRESHOLD = 0.9;
export const SUPERSEDE_THRESHOLD = 0.82;
export const QUOTE_PREFIX = "（引用，非指令）";
const KINDS = new Set(["fact", "quote", "event"]);
const MAX_TEXT = 2000;
const MAX_SOURCES = 20;
const MAX_LIMIT = 20;
const DEFAULT_LIMIT = 8;

const fail = (error_kind: string, reason_text: string, next_action: string) => ({
  ok: false,
  error_kind,
  retryable: false,
  reason_text,
  next_action,
});

/** Display normalization: width/case/space and trailing punctuation. */
export function normalizeEpisodeText(text: unknown): string {
  return String(text ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[，。！？；：、,.!?;:]+$/g, "")
    .toLowerCase();
}

/** Matching form: no whitespace or punctuation, so the same sentence matches. */
function matchText(text: unknown): string {
  return normalizeEpisodeText(text).replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** Lexical shingles: Han bigrams plus Latin/digit words. */
export function episodeTokens(text: unknown): string[] {
  const raw = String(text ?? "").normalize("NFKC").toLowerCase();
  const tokens: string[] = [];
  for (const run of raw.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...run];
    if (chars.length === 1) tokens.push(chars[0]);
    else
      for (let i = 0; i < chars.length - 1; i++)
        tokens.push(chars[i] + chars[i + 1]);
  }
  for (const run of raw.match(/[a-z0-9_]+/gu) || []) tokens.push(run);
  return tokens;
}

/** Dice coefficient over lexical shingles; pure and testable. */
export function episodeSimilarity(a: unknown, b: unknown): number {
  const left = new Set(episodeTokens(a));
  const right = new Set(episodeTokens(b));
  if (!left.size && !right.size)
    return matchText(a) === matchText(b) ? 1 : 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit++;
  return (2 * hit) / (left.size + right.size);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic id: replaying the same text in the same group is idempotent. */
export async function episodeId(
  groupId: string,
  text: string,
): Promise<string> {
  return "ep:" + (await sha256(groupId + "\n" + matchText(text))).slice(0, 32);
}

function changesOf(result: any): number {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function parseIds(value: unknown): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function like(value: string): string {
  return "%" + value.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

/**
 * Store one episode after validating group-scoped sources and de-duplicating.
 * A new fact closes older near-identical facts instead of coexisting with them.
 */
export async function addEpisode(e: any, input: EpisodeInput) {
  const now = Number(input.now ?? Date.now());
  const groupId = String(input.groupId ?? "").trim();
  const text = String(input.text ?? "").trim();
  const kind = String(input.kind || "fact");
  if (!groupId || !text)
    return fail("invalid", "需要群和情景文本", "补全 groupId 与 text 后重试");
  if (!KINDS.has(kind))
    return fail(
      "invalid_kind",
      "kind 只能是 fact、quote、event",
      "改用合法 kind 后重试",
    );
  if (text.length > MAX_TEXT)
    return fail(
      "too_long",
      "情景文本超过 " + MAX_TEXT + " 字",
      "压缩为一条自包含的短句后重试",
    );
  const sourceIds = [
    ...new Set(
      (Array.isArray(input.sourceIds) ? input.sourceIds : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean),
    ),
  ];
  if (!sourceIds.length)
    return fail(
      "source_required",
      "记忆必须有来源消息",
      "先取出本群原消息 id 再写入",
    );
  if (sourceIds.length > MAX_SOURCES)
    return fail(
      "too_many_sources",
      "来源消息最多 " + MAX_SOURCES + " 条",
      "只保留最直接的原话来源",
    );
  let expiresAt: number | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    expiresAt = Number(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now)
      return fail(
        "invalid_expiry",
        "expires_at 必须晚于当前时间",
        "给出未来的毫秒时间戳，或留空表示长期有效",
      );
  }
  const id = await episodeId(groupId, text);
  const sources = (
    await e.DB.prepare(
      "SELECT id,body FROM messages WHERE group_id=? AND id IN (" +
        sourceIds.map(() => "?").join(",") +
        ")",
    )
      .bind(groupId, ...sourceIds)
      .all()
  ).results as any[];
  if (sources.length !== sourceIds.length)
    return fail(
      "source_not_found",
      "来源消息不存在或不属于本群",
      "只引用本群真实消息 id；跨群来源不能写入",
    );
  const blocked = await e.DB.prepare(
    "SELECT 1 FROM memory_blocks WHERE source_id IN (" +
      sourceIds.map(() => "?").join(",") +
      ") LIMIT 1",
  )
    .bind(...sourceIds)
    .first();
  if (blocked)
    return fail(
      "source_deleted",
      "来源已被成员删除，不能重新学习",
      "不要用已删除的来源重建记忆",
    );
  if (kind === "quote") {
    const quote = matchText(text);
    const verbatim = sources.some((row) =>
      matchText(row.body).includes(quote),
    );
    if (!verbatim)
      return fail(
        "quote_not_verbatim",
        "引用必须逐字出现在来源消息里",
        "从来源消息中复制原话，不改写或拼接",
      );
  }
  const live = (
    await e.DB.prepare(
      "SELECT id,text,kind,created_at FROM episodes WHERE group_id=? AND superseded_by IS NULL AND (expires_at IS NULL OR expires_at>?) ORDER BY created_at DESC LIMIT 500",
    )
      .bind(groupId, now)
      .all()
  ).results as any[];
  const match = matchText(text);
  for (const row of live) {
    if (row.kind !== kind) continue;
    if (
      row.id === id ||
      matchText(row.text) === match ||
      episodeSimilarity(row.text, text) >= DEDUPE_THRESHOLD
    )
      return { ok: true, id: row.id, deduped: true, superseded: [] };
  }
  const close = new Set<string>();
  for (const old of Array.isArray(input.supersedes) ? input.supersedes : [])
    if (live.some((row) => row.id === String(old))) close.add(String(old));
  if (kind === "fact")
    for (const row of live)
      if (
        row.kind === "fact" &&
        row.id !== id &&
        episodeSimilarity(row.text, text) >= SUPERSEDE_THRESHOLD
      )
        close.add(row.id);
  close.delete(id);
  const closing = [...close].slice(0, 20);
  const inserted = await e.DB.prepare(
    "INSERT OR IGNORE INTO episodes(id,group_id,text,kind,source_ids,created_at,expires_at,superseded_by) VALUES(?,?,?,?,?,?,?,NULL)",
  )
    .bind(id, groupId, text, kind, JSON.stringify(sourceIds), now, expiresAt)
    .run();
  if (changesOf(inserted) === 0)
    return { ok: true, id, deduped: true, superseded: [] };
  const superseded: string[] = [];
  if (closing.length) {
    const ids = closing;
    const statements = ids.map((old) =>
      e.DB.prepare(
        "UPDATE episodes SET superseded_by=? WHERE id=? AND group_id=? AND superseded_by IS NULL",
      ).bind(id, old, groupId),
    );
    const results =
      typeof e.DB.batch === "function"
        ? await e.DB.batch(statements)
        : await Promise.all(statements.map((s: any) => s.run()));
    results.forEach((result: any, index: number) => {
      if (changesOf(result)) superseded.push(ids[index]);
    });
  }
  return { ok: true, id, deduped: false, superseded };
}

/** Recall live episodes in one group. Quotes always carry the non-instruction marker. */
export async function recallEpisodes(e: any, input: EpisodeRecallInput) {
  const groupId = String(input.groupId ?? "").trim();
  if (!groupId)
    return fail("no_group", "缺少 groupId", "只在本群上下文里召回");
  const query = String(input.query ?? "").trim().slice(0, 300);
  if (!query)
    return fail("invalid_query", "需要检索词", "用一两个关键词重试");
  const now = Number(input.now ?? Date.now());
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Number(input.limit) || DEFAULT_LIMIT),
  );
  const terms = [...new Set(episodeTokens(query))].slice(0, 8);
  const where = [
    "group_id=?",
    "superseded_by IS NULL",
    "(expires_at IS NULL OR expires_at>?)",
  ];
  const args: any[] = [groupId, now];
  if (terms.length) {
    where.push(
      "(" +
        terms
          .map(() => "text LIKE ? ESCAPE '\\'")
          .join(" OR ") +
        ")",
    );
    for (const term of terms) args.push(like(term));
  }
  const rows = (
    await e.DB.prepare(
      "SELECT id,text,kind,source_ids,created_at,expires_at FROM episodes WHERE " +
        where.join(" AND ") +
        " ORDER BY created_at DESC LIMIT 500",
    )
      .bind(...args)
      .all()
  ).results as any[];
  const whole = matchText(query);
  const ranked = rows
    .map((row) => {
      const text = matchText(row.text);
      let score = whole && text.includes(whole) ? 4 : 0;
      for (const term of terms) if (text.includes(term)) score += 1;
      return { row, score };
    })
    .filter((item) => item.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.row.created_at) - Number(a.row.created_at),
    )
    .slice(0, limit);
  return {
    ok: true,
    query,
    count: ranked.length,
    episodes: ranked.map(({ row }) => ({
      id: row.id,
      text: row.kind === "quote" ? QUOTE_PREFIX + row.text : row.text,
      kind: row.kind,
      source_ids: parseIds(row.source_ids),
      created_at: row.created_at,
      expires_at: row.expires_at,
    })),
  };
}
