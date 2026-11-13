// Shared read access to group chat history for F7 tools (search_history, summarize_chat, profiles...).
// Always scoped to one group_id. Never returns rows from another group. Bodies are redacted and clipped here, once.
import { redact } from "./runtime";

export interface HistoryRow { id: string; sender: string; body: string; ts: string; mentioned: number }
export interface HistoryQuery {
  groupId: string;
  /** ISO timestamp bounds (messages.ts is ISO text) */
  afterTs?: string; beforeTs?: string;
  sender?: string;
  /** every term must appear in body (LIKE %term% AND ...). Works for 1-2 char CJK too. */
  terms?: string[];
  /** newest first when true (default), else oldest first */
  newestFirst?: boolean;
  limit?: number; // clamp 1..200, default 50
  clip?: number; // per-body char clip, default 400
}
const like = (s: string) => "%" + s.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
export async function listMessages(e: any, q: HistoryQuery): Promise<HistoryRow[]> {
  if (!q.groupId) throw Error("groupId required");
  const where = ["group_id=?"], args: any[] = [q.groupId];
  if (q.afterTs) { where.push("ts>?"); args.push(q.afterTs); }
  if (q.beforeTs) { where.push("ts<?"); args.push(q.beforeTs); }
  if (q.sender) { where.push("sender=?"); args.push(q.sender); }
  for (const t of (q.terms || []).slice(0, 6)) { if (!t) continue; where.push("body LIKE ? ESCAPE '\\'"); args.push(like(t.slice(0, 40))); }
  const limit = Math.min(200, Math.max(1, q.limit || 50));
  const rows = (await e.DB.prepare(
    "SELECT id,sender,body,ts,mentioned FROM messages WHERE " + where.join(" AND ") + " ORDER BY ts " + (q.newestFirst === false ? "ASC" : "DESC") + " LIMIT ?",
  ).bind(...args, limit).all()).results as HistoryRow[];
  const clip = q.clip || 400;
  return rows.map((r) => ({ ...r, body: redact(String(r.body)).slice(0, clip) }));
}
