// 群知识库：按群隔离的文档切块与稀疏检索（FTS5 trigram + 2 字 LIKE 兜底）。
// 思路参考 AstrBot core/knowledge_base/chunking/recursive.py（AGPL-3.0）的递归切块与 500/100 参数；
// 本文件为自行实现，未复制其代码。向量检索留到后续版本，本包只做稀疏检索。

export const KB_CHUNK_SIZE = 500;
export const KB_CHUNK_OVERLAP = 100;
export const KB_MAX_CHUNKS_PER_GROUP = 20000;
export const KB_MAX_CHUNKS_PER_DOC = 400;
// 160k chars is ~400 chunks of 400 net chars each, matching KB_MAX_CHUNKS_PER_DOC.
export const KB_MAX_DOC_CHARS = 160000;
export const KB_SEPARATORS = ["\n\n", "\n", "。", "，", ". ", ", ", " "];

export type KbErrorKind = "invalid_args" | "denied" | "limit" | "too_large" | "not_found" | "unavailable";
export type KbFailure = { ok: false; error_kind: KbErrorKind; retryable: boolean; next_action: string; message?: string };
export type KbAddResult = { ok: true; doc_id: string; group_id: string; chunks: number } | KbFailure;
export type KbRemoveResult = { ok: true; doc_id: string; removed_chunks: number } | KbFailure;
export type KbSearchHit = {
  text: string;
  doc: string;
  doc_title: string;
  doc_id: string;
  chunk: number;
  chunk_id: string;
  score: number;
  truncated?: boolean;
};
export type KbSearchResult =
  | { ok: true; query: string; mode: "fts" | "like"; total: number; results: KbSearchHit[] }
  | KbFailure;

export interface ChunkOptions { size?: number; overlap?: number; separators?: string[] }
export interface AddDocOptions {
  /** Injected authorization decision. Only true for the owner or an admin; /kb wiring must pass it. */
  admin?: boolean;
  id?: string;
  now?: number;
  maxChunksPerGroup?: number;
  maxChunksPerDoc?: number;
  maxDocChars?: number;
}
export interface RemoveDocOptions { admin?: boolean }
export interface SearchOptions { topK?: number; clip?: number }

function fail(error_kind: KbErrorKind, next_action: string, message?: string): KbFailure {
  return { ok: false, error_kind, retryable: error_kind === "invalid_args", next_action, ...(message ? { message } : {}) };
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function clip(value: unknown, max: number): string {
  const s = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim();
  return s.length > max ? s.slice(0, max) : s;
}

function newId(prefix: string): string {
  const c = (globalThis as any).crypto;
  if (c?.randomUUID) return prefix + String(c.randomUUID()).replace(/-/g, "");
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

function splitPieces(text: string, size: number, overlap: number, separators: string[]): string[] {
  if (text.length <= size) return [text];
  for (let i = 0; i < separators.length; i++) {
    const sep = separators[i];
    if (!sep || !text.includes(sep)) continue;
    const parts = text.split(sep);
    const out: string[] = [];
    for (let j = 0; j < parts.length; j++) {
      const piece = parts[j] + (j < parts.length - 1 ? sep : "");
      if (!piece) continue;
      if (piece.length > size) out.push(...splitPieces(piece, size, overlap, separators.slice(i + 1)));
      else out.push(piece);
    }
    return out;
  }
  // No separator works: hard slices narrower than `size` so packed neighbours still share `overlap`.
  const width = Math.max(1, size - overlap);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += width) out.push(text.slice(i, i + width));
  return out;
}

/** Recursive character chunking: 500 chars with 100 overlap, CJK-aware separators, never over `size`. */
export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const size = int(opts.size, KB_CHUNK_SIZE, 4, 4000);
  const overlap = int(opts.overlap, KB_CHUNK_OVERLAP, 0, Math.max(0, size - 1));
  const separators = Array.isArray(opts.separators) ? opts.separators : KB_SEPARATORS;
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!clean) return [];
  const pieces = splitPieces(clean, size, overlap, separators);
  const chunks: string[] = [];
  let buf = "";
  for (const raw of pieces) {
    const piece = raw.length > size ? raw.slice(0, size) : raw;
    if (!piece) continue;
    if (!buf) { buf = piece; continue; }
    if (buf.length + piece.length <= size) { buf += piece; continue; }
    chunks.push(buf);
    const room = size - piece.length;
    const tail = room > 0 ? buf.slice(-Math.min(overlap, room)) : "";
    buf = tail + piece;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// D1 allows at most 100 bound parameters per query; keep multi-row inserts under it so one
// 400-chunk document stays under the 50-query invocation budget (25 + 20 + 1 statements).
function insertStatements(e: any, table: string, columns: string[], rows: any[][], maxParams = 100): any[] {
  const per = Math.max(1, Math.floor(maxParams / columns.length));
  const statements: any[] = [];
  for (let i = 0; i < rows.length; i += per) {
    const part = rows.slice(i, i + per);
    const sql = `INSERT INTO ${table}(${columns.join(",")}) VALUES ` +
      part.map(() => "(" + columns.map(() => "?").join(",") + ")").join(",");
    statements.push(e.DB.prepare(sql).bind(...part.flat()));
  }
  return statements;
}

/** Admin/owner only. `opts.admin` is the injected authorization decision (no shared isAdmin exists yet). */
export async function addDoc(
  e: any,
  groupId: string,
  title: string,
  source: string,
  text: string,
  opts: AddDocOptions = {},
): Promise<KbAddResult> {
  const group = clip(groupId, 200);
  if (!group) return fail("invalid_args", "缺少群标识，不能入库");
  if (opts.admin !== true) return fail("denied", "只有管理员或 owner 能把资料入库；让成员找管理员维护知识库");
  const docTitle = clip(title, 200);
  const docSource = clip(source, 500);
  if (!docTitle) return fail("invalid_args", "文档标题不能为空");
  if (!docSource) return fail("invalid_args", "文档来源不能为空");

  const maxDocChars = int(opts.maxDocChars, KB_MAX_DOC_CHARS, 10, 5000000);
  const body = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").trim();
  if (!body) return fail("invalid_args", "文档正文为空，不能入库");
  if (body.length > maxDocChars) {
    return fail("too_large", `把文档拆成小于 ${maxDocChars} 字的多份再入库`, `正文 ${body.length} 字，超过单文档上限 ${maxDocChars}`);
  }

  const maxDocChunks = int(opts.maxChunksPerDoc, KB_MAX_CHUNKS_PER_DOC, 1, 10000);
  const chunks = chunkText(body);
  if (chunks.length > maxDocChunks) {
    return fail("limit", `把文档拆成多份，每份不超过 ${maxDocChunks} 块`, `切出 ${chunks.length} 块，超过单文档上限 ${maxDocChunks}`);
  }
  if (!chunks.length) return fail("invalid_args", "文档正文为空，不能入库");

  const maxGroupChunks = int(opts.maxChunksPerGroup, KB_MAX_CHUNKS_PER_GROUP, 1, 200000);
  const used = Number((await e.DB.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE group_id=?").bind(group).first())?.n || 0);
  if (used + chunks.length > maxGroupChunks) {
    return fail("limit", `先删除旧文档腾出空间（每群上限 ${maxGroupChunks} 块）`, `本群已有 ${used} 块，本次还要 ${chunks.length} 块`);
  }

  const docId = clip(opts.id, 120) || newId("kbd_");
  const exists = await e.DB.prepare("SELECT id FROM kb_docs WHERE id=?").bind(docId).first();
  if (exists) return fail("invalid_args", "换一个文档编号，或先删除旧文档", "文档编号已存在");
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const chunkRows = chunks.map((chunk, idx) => [docId + "#" + idx, docId, group, idx, chunk, now]);
  const ftsRows = chunks.map((chunk, idx) => [chunk, docTitle, docId + "#" + idx, docId, group]);

  const statements = [
    e.DB.prepare("INSERT INTO kb_docs(id,group_id,title,source,created_at) VALUES(?,?,?,?,?)").bind(docId, group, docTitle, docSource, now),
    ...insertStatements(e, "kb_chunks", ["id", "doc_id", "group_id", "idx", "text", "created_at"], chunkRows),
    ...insertStatements(e, "kb_chunks_fts", ["text", "title", "chunk_id", "doc_id", "group_id"], ftsRows),
  ];
  await e.DB.batch(statements);
  return { ok: true, doc_id: docId, group_id: group, chunks: chunks.length };
}

export async function removeDoc(e: any, groupId: string, docId: string, opts: RemoveDocOptions = {}): Promise<KbRemoveResult> {
  const group = clip(groupId, 200);
  const id = clip(docId, 120);
  if (!group || !id) return fail("invalid_args", "缺少群标识或文档编号");
  if (opts.admin !== true) return fail("denied", "只有管理员或 owner 能删除知识库文档");
  const doc = await e.DB.prepare("SELECT id FROM kb_docs WHERE id=? AND group_id=?").bind(id, group).first();
  if (!doc) return fail("not_found", "这个文档不在本群知识库里；先确认文档编号");
  const removed = Number((await e.DB.prepare("SELECT COUNT(*) AS n FROM kb_chunks WHERE doc_id=? AND group_id=?").bind(id, group).first())?.n || 0);
  await e.DB.batch([
    e.DB.prepare("DELETE FROM kb_chunks_fts WHERE doc_id=? AND group_id=?").bind(id, group),
    e.DB.prepare("DELETE FROM kb_chunks WHERE doc_id=? AND group_id=?").bind(id, group),
    e.DB.prepare("DELETE FROM kb_docs WHERE id=? AND group_id=?").bind(id, group),
  ]);
  return { ok: true, doc_id: id, removed_chunks: removed };
}

function normalizeQuery(query: unknown): string {
  return String(query ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => "\\" + c);

function hit(row: any, clipChars: number): KbSearchHit {
  const text = String(row.text ?? "");
  const truncated = text.length > clipChars;
  const title = String(row.doc_title ?? "");
  return {
    text: truncated ? text.slice(0, clipChars) : text,
    doc: title,
    doc_title: title,
    doc_id: String(row.doc_id ?? ""),
    chunk: Number(row.chunk ?? 0),
    chunk_id: String(row.chunk_id ?? ""),
    score: Number(row.score) || 0,
    ...(truncated ? { truncated: true } : {}),
  };
}

/** Group-scoped search. 3+ chars use FTS5 trigram; 2 chars (and zero-hit FTS) fall back to LIKE. */
export async function searchKb(e: any, groupId: string, query: string, opts: SearchOptions = {}): Promise<KbSearchResult> {
  const group = clip(groupId, 200);
  if (!group) return fail("invalid_args", "缺少群标识，不能检索知识库");
  const q = normalizeQuery(query);
  if ([...q].length < 2) return fail("invalid_args", "检索词至少 2 个字；中文两字词会用 LIKE 兜底");
  const topK = int(opts.topK, 5, 1, 20);
  const clipChars = int(opts.clip, 800, 100, 4000);

  if ([...q].length >= 3) {
    try {
      const phrase = '"' + q.replace(/"/g, '""') + '"';
      const rows = (await e.DB.prepare(
        "SELECT c.id AS chunk_id,c.doc_id,d.title AS doc_title,c.idx AS chunk,c.text AS text,bm25(kb_chunks_fts) AS score " +
        "FROM kb_chunks_fts JOIN kb_chunks c ON c.id=kb_chunks_fts.chunk_id AND c.group_id=? " +
        "JOIN kb_docs d ON d.id=c.doc_id AND d.group_id=? " +
        "WHERE kb_chunks_fts MATCH ? ORDER BY score LIMIT ?",
      ).bind(group, group, phrase, topK).all()).results as any[];
      if (rows.length) return { ok: true, query: q, mode: "fts", total: rows.length, results: rows.map((r) => hit(r, clipChars)) };
    } catch {
      // A malformed phrase or a missing FTS module must not lose the query: fall through to LIKE.
    }
  }

  const like = "%" + likeEscape(q) + "%";
  const rows = (await e.DB.prepare(
    "SELECT c.id AS chunk_id,c.doc_id,d.title AS doc_title,c.idx AS chunk,c.text AS text," +
    "((length(c.text)-length(replace(c.text,?,''))) * 1.0 / ?) + (CASE WHEN d.title LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) AS score " +
    "FROM kb_chunks c JOIN kb_docs d ON d.id=c.doc_id AND d.group_id=? " +
    "WHERE c.group_id=? AND (c.text LIKE ? ESCAPE '\\' OR d.title LIKE ? ESCAPE '\\') " +
    "ORDER BY score DESC, c.created_at DESC, c.idx ASC LIMIT ?",
  ).bind(q, Math.max(1, q.length), like, group, group, like, like, topK).all()).results as any[];
  const results = rows.map((r) => hit(r, clipChars));
  return { ok: true, query: q, mode: "like", total: results.length, results };
}
