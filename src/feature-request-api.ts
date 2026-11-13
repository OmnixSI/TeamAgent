/**
 * F11 FR-3：工作室接口、CAS 状态转移、回复入队、超时扫描。
 * 所有回复与 shipped/failed 的状态更新在同一个 D1 batch 里：先 CAS UPDATE，
 * 再按 reply_outbox_id 条件 INSERT OR IGNORE，保证「状态没转成功就不回复」。
 */
import {
  FR_REPLY_PREFIX,
  FR_TRANSITIONS,
  type FrPublic,
  type FrReplyKind,
  type FrStatus,
} from "./feature-request-types";
import { clip, loadFrConfig, sanitizeReply, sydneyDay } from "./feature-request-core";
import { left } from "./d1";

const BASE = "/api/team/feature-requests";
const json = (value: any, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
const bodyOf = async (r: Request): Promise<any | null> => {
  try {
    const value = await r.json();
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
};
const changesOf = (result: any) =>
  Number(result?.meta?.changes ?? result?.changes ?? 0);

async function rowOf(e: any, id: string) {
  return e.DB.prepare("SELECT * FROM feature_request WHERE id=?")
    .bind(id)
    .first();
}

async function outboxStatusOf(e: any, id: string | null) {
  if (!id) return null;
  const row = await e.DB.prepare("SELECT status FROM outbox WHERE id=?")
    .bind(id)
    .first();
  return row?.status || null;
}

export function toPublic(row: any, outboxStatus: string | null = null): FrPublic {
  let tags: any = [];
  try {
    tags = JSON.parse(row.risk_tags || "[]");
  } catch {}
  return {
    id: row.id,
    status: row.status,
    mode: row.mode,
    auto: !!row.auto,
    risk_tags: Array.isArray(tags) ? tags : [],
    sender_name: row.sender_name,
    quote: row.quote,
    title: row.title,
    detail: row.detail,
    untrusted: true,
    attempts: row.attempts,
    lease_until: row.lease_until,
    created_at: row.created_at,
    updated_at: row.updated_at,
    release: row.release,
    rollback_point: row.rollback_point,
    proposal_note: row.proposal_note,
    reply: row.reply_kind
      ? { kind: row.reply_kind, text: row.reply_text || "", outbox_status: outboxStatus }
      : null,
  };
}

type Raw = { __raw: string };
const raw = (sql: string): Raw => ({ __raw: sql });

/** One CAS statement for every transition: id + current status + current version. */
function transition(
  e: any,
  row: any,
  to: FrStatus,
  patch: Record<string, any> = {},
  now = Date.now(),
  guard?: { sql: string; params: any[] },
) {
  const from = row.status as FrStatus;
  if (to !== from && !(FR_TRANSITIONS[from] || []).includes(to)) return null;
  const sets = ["status=?", "version=version+1", "updated_at=?"];
  const values: any[] = [to, now];
  for (const column of Object.keys(patch)) {
    const value = patch[column];
    if (value && typeof value === "object" && typeof value.__raw === "string")
      sets.push(column + "=" + value.__raw);
    else {
      sets.push(column + "=?");
      values.push(value);
    }
  }
  return e.DB.prepare(
    `UPDATE feature_request SET ${sets.join(",")} WHERE id=? AND status=? AND version=? ${guard?.sql || ""}`,
  ).bind(...values, row.id, from, row.version, ...(guard?.params || []));
}

function replyPrefix(quote: any) {
  const chars = Array.from(String(quote ?? "").trim());
  return "回复「" + clip(quote, 12) + (chars.length > 12 ? "…" : "") + "」：";
}

/** Shared batch: CAS to `to`, then insert the reply only if that transition really won. */
async function enqueueReply(
  e: any,
  row: any,
  to: FrStatus,
  kind: FrReplyKind,
  text: string,
  extra: Record<string, any>,
  now: number,
) {
  const outboxId = FR_REPLY_PREFIX + row.id;
  const ref = await e.DB.prepare(
    "SELECT ref_idx FROM message_refs WHERE kind='member' AND target_id=? AND group_id=? LIMIT 1",
  )
    .bind(row.msg_id, row.group_id)
    .first();
  const refIdx = typeof ref?.ref_idx === "string" ? ref.ref_idx : null;
  const body = refIdx ? text : replyPrefix(row.quote) + text;
  const statement = transition(
    e,
    row,
    to,
    {
      ...extra,
      reply_kind: kind,
      reply_text: text,
      reply_outbox_id: outboxId,
      reply_enqueued_at: now,
    },
    now,
  );
  if (!statement) return null;
  const statements = [
    statement,
    e.DB.prepare(
      "INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at) SELECT ?,?,?,?,'pending',? WHERE EXISTS (SELECT 1 FROM feature_request WHERE id=? AND status=? AND reply_outbox_id=?)",
    ).bind(outboxId, row.group_id, row.msg_id, body, now, row.id, to, outboxId),
  ];
  if (refIdx)
    statements.push(
      e.DB.prepare(
        "INSERT OR IGNORE INTO outbox_meta(id,json) SELECT ?,? WHERE EXISTS (SELECT 1 FROM outbox WHERE id=?)",
      ).bind(outboxId, JSON.stringify({ reference: refIdx }), outboxId),
    );
  const results = await e.DB.batch(statements);
  if (changesOf(results?.[0]) !== 1) return null;
  return { row: await rowOf(e, row.id), outboxStatus: await outboxStatusOf(e, outboxId) };
}

async function capsOf(e: any, now: number) {
  const cfg = loadFrConfig();
  const counts: any = await e.DB.prepare(
    "SELECT SUM(CASE WHEN status='developing' AND lease_until>? THEN 1 ELSE 0 END) AS developing, " +
      "SUM(CASE WHEN auto=1 AND day=? THEN 1 ELSE 0 END) AS auto_today FROM feature_request",
  )
    .bind(now, sydneyDay(now))
    .first();
  return {
    developing: Number(counts?.developing || 0),
    max_developing: cfg.max_developing,
    auto_today: Number(counts?.auto_today || 0),
    daily_auto_cap: cfg.daily_auto_cap,
  };
}

async function list(e: any, r: Request, now: number) {
  const u = new URL(r.url);
  const rawStatus = (u.searchParams.get("status") || "").trim();
  const statuses = rawStatus
    .split(",")
    .map((value) => value.trim())
    .filter((value) => Object.prototype.hasOwnProperty.call(FR_TRANSITIONS, value)) as FrStatus[];
  const asked = Math.trunc(Number(u.searchParams.get("limit") || 20)) || 20;
  const limit = Math.min(100, Math.max(1, asked));
  let rows: any[] = [];
  if (!rawStatus || statuses.length) {
    if (statuses.length)
      rows = (
        await e.DB.prepare(
          `SELECT * FROM feature_request WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at,id LIMIT ?`,
        )
          .bind(...statuses, limit)
          .all()
      ).results;
    else
      rows = (
        await e.DB.prepare(
          "SELECT * FROM feature_request ORDER BY created_at,id LIMIT ?",
        )
          .bind(limit)
          .all()
      ).results;
  }
  const ids = rows.map((row) => row.reply_outbox_id).filter((id) => typeof id === "string");
  const states = new Map<string, string>();
  if (ids.length) {
    const found = (
      await e.DB.prepare(
        `SELECT id,status FROM outbox WHERE id IN (${ids.map(() => "?").join(",")})`,
      )
        .bind(...ids)
        .all()
    ).results;
    for (const row of found) states.set(row.id, row.status);
  }
  return json({
    items: rows.map((row) => toPublic(row, row.reply_outbox_id ? states.get(row.reply_outbox_id) || null : null)),
    caps: await capsOf(e, now),
  });
}

async function claim(e: any, body: any, now: number) {
  const worker = clip(body?.worker, 40);
  if (!worker) return json({ error: "worker_required" }, 400);
  const cfg = loadFrConfig();
  const developing: any = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM feature_request WHERE status='developing' AND lease_until>?",
  )
    .bind(now)
    .first();
  if (Number(developing?.n || 0) >= cfg.max_developing)
    return json({ error: "max_developing" }, 409);
  let row: any;
  if (body?.id) row = await rowOf(e, String(body.id));
  else
    row = await e.DB.prepare(
      "SELECT * FROM feature_request WHERE status='queued' AND mode='build' AND auto=1 ORDER BY created_at,id LIMIT 1",
    ).first();
  if (!row) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  if (row.status !== "queued") return json({ error: "illegal_transition" }, 409);
  if (row.mode !== "build") return json({ error: "not_buildable" }, 409);
  const statement = transition(
    e,
    row,
    "developing",
    {
      claimed_by: worker,
      lease_until: now + cfg.lease_hours * 3600000,
      attempts: raw("attempts+1"),
    },
    now,
    {
      sql: "AND (SELECT COUNT(*) FROM feature_request WHERE status='developing' AND lease_until>?)<?",
      params: [now, cfg.max_developing],
    },
  );
  if (!statement) return json({ error: "illegal_transition" }, 409);
  const result = await statement.run();
  if (changesOf(result) !== 1) {
    const fresh = await rowOf(e, row.id);
    return json({ error: fresh?.status === "queued" ? "max_developing" : "conflict" }, 409);
  }
  return json({ item: toPublic(await rowOf(e, row.id), null) });
}

async function heartbeat(e: any, id: string, body: any, now: number) {
  const row = await rowOf(e, id);
  if (!row) return json({ error: "not_found" }, 404);
  if (row.status !== "developing") return json({ error: "illegal_transition" }, 409);
  const worker = clip(body?.worker, 40);
  if (worker && row.claimed_by !== worker) return json({ error: "not_claimed_by_worker" }, 409);
  const statement = transition(
    e,
    row,
    "developing",
    { lease_until: now + loadFrConfig().lease_hours * 3600000 },
    now,
  );
  const result = await statement!.run();
  if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
  return json({ item: toPublic(await rowOf(e, id), await outboxStatusOf(e, row.reply_outbox_id)) });
}

async function report(e: any, id: string, body: any, now: number) {
  const row = await rowOf(e, id);
  if (!row) return json({ error: "not_found" }, 404);
  const outcome = String(body?.outcome || "");

  if (outcome === "shipped") {
    if (row.status === "shipped" && row.reply_outbox_id)
      return json({ item: toPublic(row, await outboxStatusOf(e, row.reply_outbox_id)) });
    if (row.status !== "developing") return json({ error: "illegal_transition" }, 409);
    const release = String(body?.release ?? "");
    if (!/^[0-9a-f]{7,40}$/.test(release) || !String(e.RELEASE || "").startsWith(release))
      return json({ error: "release_mismatch" }, 409);
    const rollback = clip(body?.rollback_point, 60);
    if (!rollback) return json({ error: "reply_invalid", why: "缺少回滚点" }, 422);
    if (body?.smoke_verified !== true)
      return json({ error: "reply_invalid", why: "没有通过冒烟验证" }, 422);
    const clean = sanitizeReply(String(body?.reply_text ?? ""));
    if (!clean.ok) return json({ error: "reply_invalid", why: clean.why }, 422);
    const queued = await enqueueReply(
      e,
      row,
      "shipped",
      "shipped",
      clean.text,
      { release, rollback_point: rollback, smoke_verified: 1 },
      now,
    );
    if (!queued) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(queued.row, queued.outboxStatus) });
  }

  if (outcome === "failed") {
    if (row.status === "failed" && row.reply_outbox_id)
      return json({ item: toPublic(row, await outboxStatusOf(e, row.reply_outbox_id)) });
    if (row.status !== "queued" && row.status !== "developing")
      return json({ error: "illegal_transition" }, 409);
    const clean = sanitizeReply(String(body?.reason ?? ""), 150);
    if (!clean.ok) return json({ error: "reply_invalid", why: clean.why }, 422);
    const text = "这个我这次没做成：" + clean.text + "，已转人工。";
    const queued = await enqueueReply(e, row, "failed", "failed", text, {
      status_reason: clip(body?.reason, 200),
    }, now);
    if (!queued) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(queued.row, queued.outboxStatus) });
  }

  if (outcome === "needs_human") {
    if (row.status !== "queued" && row.status !== "developing")
      return json({ error: "illegal_transition" }, 409);
    const statement = transition(e, row, "needs_human", { status_reason: clip(body?.reason, 200) }, now);
    const result = await statement!.run();
    if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(await rowOf(e, id), null) });
  }

  if (outcome === "proposal") {
    if (row.mode !== "proposal") return json({ error: "proposal_only" }, 409);
    const statement = transition(e, row, row.status, { proposal_note: clip(body?.note, 2000) }, now);
    const result = await statement!.run();
    if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(await rowOf(e, id), null) });
  }

  if (outcome === "release") {
    if (row.status !== "developing") return json({ error: "illegal_transition" }, 409);
    const statement = transition(e, row, "queued", { claimed_by: null, lease_until: null }, now);
    const result = await statement!.run();
    if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(await rowOf(e, id), null) });
  }

  return json({ error: "unknown_outcome" }, 400);
}

async function decide(e: any, id: string, body: any, who: any, now: number) {
  if (who.role !== "owner") return json({ error: "owner_only" }, 403);
  const row = await rowOf(e, id);
  if (!row) return json({ error: "not_found" }, 404);
  if (row.status !== "needs_human") return json({ error: "illegal_transition" }, 409);
  const approvedBy = who.name || who.id;
  const decision = String(body?.decision || "");
  if (decision === "approve") {
    if (row.mode === "proposal") return json({ error: "proposal_only" }, 409);
    const statement = transition(e, row, "queued", { approved_by: approvedBy, auto: 1 }, now);
    const result = await statement!.run();
    if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(await rowOf(e, id), null) });
  }
  if (decision === "reject") {
    const statement = transition(e, row, "rejected", { approved_by: approvedBy }, now);
    const result = await statement!.run();
    if (changesOf(result) !== 1) return json({ error: "conflict" }, 409);
    return json({ item: toPublic(await rowOf(e, id), null) });
  }
  return json({ error: "invalid_decision" }, 400);
}

export async function featureRequestRoute(
  r: Request,
  e: any,
  who: any,
  path: string,
  method: string,
): Promise<Response | null> {
  if (!path.startsWith(BASE)) return null;
  if (path !== BASE && !path.startsWith(BASE + "/")) return null;
  if (!who || (who.role !== "owner" && who.role !== "admin"))
    return json({ error: "owner or admin only" }, 403);
  const rest = path.slice(BASE.length);
  const parts = rest.split("/").filter(Boolean);
  const now = Date.now();
  if (!parts.length) {
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    return list(e, r, now);
  }
  if (parts[0] === "claim" && parts.length === 1) {
    if (method !== "POST") return json({ error: "method not allowed" }, 405);
    return claim(e, await bodyOf(r), now);
  }
  const id = decodeURIComponent(parts[0]);
  if (parts.length === 1) {
    if (method !== "GET") return json({ error: "method not allowed" }, 405);
    const row = await rowOf(e, id);
    if (!row) return json({ error: "not_found" }, 404);
    return json({ item: toPublic(row, await outboxStatusOf(e, row.reply_outbox_id)) });
  }
  if (parts.length !== 2) return json({ error: "not_found" }, 404);
  if (method !== "POST") return json({ error: "method not allowed" }, 405);
  if (parts[1] === "heartbeat") return heartbeat(e, id, await bodyOf(r), now);
  if (parts[1] === "report") return report(e, id, await bodyOf(r), now);
  if (parts[1] === "decision") return decide(e, id, await bodyOf(r), who, now);
  return json({ error: "not_found" }, 404);
}

async function failStale(e: any, row: any, now: number) {
  const reason = "排太久没落地";
  const text = "这个我这次没做成：" + reason + "，已转人工。";
  const queued = await enqueueReply(e, row, "failed", "stale", text, { status_reason: reason }, now);
  return !!queued;
}

export async function sweepFeatureRequests(
  e: any,
  now = Date.now(),
): Promise<{ requeued: number; failed: number }> {
  const cfg = loadFrConfig();
  let requeued = 0;
  let failed = 0;
  let handled = 0;

  let expired: any[];
  try {
    expired = (
      await e.DB.prepare(
        "SELECT * FROM feature_request WHERE status='developing' AND lease_until<? ORDER BY lease_until,id LIMIT 20",
      )
        .bind(now)
        .all()
    ).results;
  } catch (error: any) {
    // A code-first deploy can land before FR-1's 0070 migration: keep the rest of
    // the cron tick alive instead of failing every maintenance step.
    if (/no such table: feature_request/i.test(String(error?.message || "")))
      return { requeued: 0, failed: 0 };
    throw error;
  }
  for (const row of expired) {
    if (handled >= 20) break;
    if (left(e) < 2) break;
    if (row.attempts < 3) {
      handled++;
      const statement = transition(e, row, "queued", { claimed_by: null, lease_until: null }, now);
      if (!statement) continue;
      if (changesOf(await statement.run()) === 1) requeued++;
      continue;
    }
    if (left(e) < 5) break;
    handled++;
    if (await failStale(e, row, now)) failed++;
  }

  const stale = (
    await e.DB.prepare(
      "SELECT * FROM feature_request WHERE status IN ('queued','developing') AND created_at<? ORDER BY created_at,id LIMIT 20",
    )
      .bind(now - cfg.stale_hours * 3600000)
      .all()
  ).results;
  for (const row of stale) {
    if (handled >= 20) break;
    if (left(e) < 5) break;
    handled++;
    if (await failStale(e, row, now)) failed++;
  }
  return { requeued, failed };
}
