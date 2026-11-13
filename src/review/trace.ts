// D-3: turn one night of chat into redacted, signal-tagged traces. Read-only, no model.
// Never reads messages.processed or settings.chat_cursor; the cursor is (ts,id), never rowid.
import { redact } from "../runtime";
import { signalsOf, type NeighborMessage, type Neighbors } from "./signals";
import type { SignalKey, Trace } from "./types";

export type TraceCursor = { ts: string; id: string };
export type TraceRun = {
  group_id: string;
  window_start?: string;      // inclusive ISO timestamp
  window_end?: string;        // exclusive ISO timestamp
  cursor?: TraceCursor | null;
  page_size?: number;         // capped at 80 inbound messages per page
};
export type TracePage = { traces: Trace[]; cursor: TraceCursor };

const DAY = 86_400_000;
const cut = (s: unknown, n: number) => {
  const text = String(s ?? "");
  return text.length > n ? text.slice(0, n) : text;
};
const around = (s: unknown) => redact(String(s ?? ""));

// review_traces.trace_json is capped at 6000 characters by migration 0008.
function fitTrace(trace: Trace): Trace {
  let json = JSON.stringify(trace);
  while (json.length > 6000) {
    const bodies = [trace.inbound, ...trace.context_before, ...trace.after, ...trace.replies]
      .filter((item) => item.body.length > 0)
      .sort((a, b) => b.body.length - a.body.length);
    if (!bodies.length) break;
    const target = bodies[0];
    const next = Math.min(target.body.length - 1, Math.floor(target.body.length * 0.7));
    if (next < 0 || next === target.body.length) break;
    target.body = target.body.slice(0, next);
    json = JSON.stringify(trace);
  }
  return trace;
}

// One pairing query: messages ⟕ outbox ⟕ chat_decisions ⟕ jobs, with stage_timings
// and deliveries probed as correlated subqueries. LIMIT applies to inbound rows,
// so a multi-segment reply cannot split a page.
const PAGE_SQL = `
WITH seq AS (
  SELECT m.rowid AS rowid, m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned,
         ROW_NUMBER() OVER (PARTITION BY m.group_id ORDER BY julianday(m.ts), m.id) AS rn
  FROM messages m
  WHERE m.group_id = ?1 AND julianday(m.ts) >= julianday(?2) AND julianday(m.ts) < julianday(?3)
),
reply AS (
  SELECT DISTINCT src.rn
  FROM outbox o
  JOIN seq src ON src.id = o.msg_id AND src.group_id = o.group_id
  WHERE o.group_id = ?1
),
rel AS (
  SELECT s.* FROM seq s
  WHERE s.mentioned = 1
     OR EXISTS (SELECT 1 FROM chat_decisions d WHERE d.latest_id = s.id AND d.group_id = s.group_id)
     OR EXISTS (SELECT 1 FROM chat_decisions b
                WHERE b.group_id = s.group_id AND json_valid(b.batch_ids)
                  AND EXISTS (SELECT 1 FROM json_each(b.batch_ids) j WHERE j.value = s.id))
     OR EXISTS (SELECT 1 FROM reply r WHERE abs(r.rn - s.rn) <= 2)
),
page AS (
  SELECT * FROM rel
  WHERE (?4 IS NULL OR julianday(ts) > julianday(?4) OR (julianday(ts) = julianday(?4) AND id > ?5))
  ORDER BY julianday(ts), id
  LIMIT ?6
)
SELECT p.rowid, p.id, p.group_id, p.sender, p.body, p.ts, p.mentioned, p.rn,
       o.id AS outbox_id, o.body AS outbox_body, o.status AS outbox_status, o.created_at AS outbox_at,
       d.id AS decision_id, d.action, d.gate, d.spoken_kind, d.reason, d.model_ms, d.created_at AS decision_at,
       j.id AS job_id, j.kind AS job_kind, j.status AS job_status, j.error AS job_error,
       (SELECT COUNT(*) FROM deliveries dl
          WHERE dl.job_id = j.id
            AND CASE WHEN json_valid(dl.files) THEN json_array_length(dl.files) ELSE 0 END > 0) AS delivered_files,
       (SELECT MAX(t.at) FROM stage_timings t
          WHERE t.turn_id = p.id AND t.stage IN ('outbox', 'sent')) AS staged_at
FROM page p
LEFT JOIN outbox o ON o.msg_id = p.id AND o.group_id = p.group_id
LEFT JOIN chat_decisions d ON d.latest_id = p.id AND d.group_id = p.group_id
LEFT JOIN jobs j ON j.id = CASE WHEN instr(o.id, '~') > 0
                                THEN substr(o.id, 1, instr(o.id, '~') - 1)
                                ELSE o.id END
ORDER BY julianday(p.ts), p.id, o.created_at, o.id`;

export async function buildTraces(e: any, run: TraceRun): Promise<TracePage> {
  const group = run.group_id;
  const end = run.window_end || new Date().toISOString();
  const start = run.window_start || new Date(Date.now() - 3 * DAY).toISOString();
  const pageSize = Math.min(Math.max(Math.trunc(run.page_size ?? 80), 1), 80);
  const cursor = run.cursor || null;

  const rows: any[] = (await e.DB.prepare(PAGE_SQL)
    .bind(group, start, end, cursor?.ts ?? null, cursor?.id ?? "", pageSize)
    .all()).results;
  if (!rows.length) return { traces: [], cursor: cursor || { ts: end, id: "" } };

  const heads = new Map<string, any>();
  const replies = new Map<string, any[]>();
  const decisions = new Map<string, any[]>();
  for (const row of rows) {
    if (!heads.has(row.id)) heads.set(row.id, row);
    if (row.outbox_id) {
      const list = replies.get(row.id) || [];
      if (!list.some((x) => x.id === row.outbox_id)) {
        list.push({ id: row.outbox_id, body: row.outbox_body, status: row.outbox_status, at: row.outbox_at });
        replies.set(row.id, list);
      }
    }
    if (row.decision_id) {
      const list = decisions.get(row.id) || [];
      if (!list.some((x) => x.id === row.decision_id)) {
        list.push({ id: row.decision_id, action: row.action, gate: row.gate, spoken_kind: row.spoken_kind,
          reason: row.reason, model_ms: row.model_ms, at: row.decision_at });
        decisions.set(row.id, list);
      }
    }
  }
  const ids = [...heads.keys()];
  const firstAt = Math.min(...ids.map((id) => Date.parse(heads.get(id).ts)));
  const lastAt = Math.max(...ids.map((id) => Date.parse(heads.get(id).ts)));

  // Neighbour window: 20 messages before (S9's corrections) and 3 after (S3).
  const marks = ids.map(() => "?").join(",");
  const nearby: any[] = (await e.DB.prepare(`
    WITH seq AS (
      SELECT m.rowid AS rowid, m.id, m.sender, m.body, m.ts, m.mentioned,
             ROW_NUMBER() OVER (PARTITION BY m.group_id ORDER BY julianday(m.ts), m.id) AS rn
      FROM messages m
      WHERE m.group_id = ?1 AND julianday(m.ts) >= julianday(?2) AND julianday(m.ts) < julianday(?3)
    ),
    picked AS (SELECT s.rn FROM seq s WHERE s.id IN (${marks}))
    SELECT s.rowid, s.id, s.sender, s.body, s.ts, s.mentioned, s.rn
    FROM seq s
    WHERE EXISTS (SELECT 1 FROM picked p WHERE s.rn >= p.rn - 50 AND s.rn <= p.rn + 3)
    ORDER BY s.rn`).bind(group, start, end, ...ids).all()).results;

  // Replies just before the page feed S9/S10 comparisons.
  const justBefore: any[] = (await e.DB.prepare(`
    SELECT o.id, o.msg_id, o.body, o.status, o.created_at
    FROM outbox o
    WHERE o.group_id = ?1 AND o.created_at >= ?2 AND o.created_at <= ?3
    ORDER BY o.created_at, o.id`)
    .bind(group, firstAt - 30 * 60_000, lastAt + 15 * 60_000).all()).results;

  // A decision covers a batch, so messages 428-431 inherit the wait of the batch's first message.
  const batchRows: any[] = (await e.DB.prepare(`
    SELECT latest_id,batch_ids,outbox_id,created_at,action,gate,spoken_kind,reason,model_ms
    FROM chat_decisions
    WHERE group_id = ?1 AND json_valid(batch_ids) AND EXISTS (
      SELECT 1 FROM json_each(chat_decisions.batch_ids) j WHERE j.value IN (${marks})
    )`).bind(group, ...ids).all()).results;
  const batchFor = new Map<string, {
    startedAt: number; repliedAt: number | null; trigger: boolean;
    decision: { action: string; gate: string; spoken_kind?: string; reason?: string; model_ms?: number };
  }>();
  for (const row of batchRows) {
    let members: string[] = [];
    try { members = JSON.parse(row.batch_ids); } catch { members = [row.latest_id]; }
    const present = members.filter((member) => heads.has(member));
    if (!present.length) continue;
    const startedAt = Math.min(...present.map((member) => Date.parse(heads.get(member).ts)));
    const reply = justBefore.find((o) => o.id === row.outbox_id) ||
      justBefore.find((o) => present.includes(o.msg_id));
    const trigger = present.some((member) => heads.get(member).mentioned === 1);
    const decision = {
      action: row.action, gate: row.gate, spoken_kind: row.spoken_kind ?? undefined,
      reason: row.reason ?? undefined, model_ms: row.model_ms ?? undefined,
    };
    for (const member of present) {
      if (!batchFor.has(member)) {
        batchFor.set(member, { startedAt, repliedAt: reply ? reply.created_at : null, trigger, decision });
      }
    }
  }

  const samples: any[] = (await e.DB.prepare(
    "SELECT at,gateway_ok,runner_ok FROM health_samples WHERE at <= ? ORDER BY at DESC LIMIT 2000",
  ).bind(lastAt).all()).results.reverse();

  const hasTurnTools = Boolean(await e.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='turn_tools'",
  ).first());
  const toolsByTurn = new Map<string, any[]>();
  if (hasTurnTools) {
    const toolRows: any[] = (await e.DB.prepare(
      `SELECT turn_id,name,ok,error_kind,ms,offered FROM turn_tools
       WHERE turn_id IN (${marks}) ORDER BY created_at, id`).bind(...ids).all()).results;
    for (const row of toolRows) {
      const list = toolsByTurn.get(row.turn_id) || [];
      list.push(row);
      toolsByTurn.set(row.turn_id, list);
    }
  }

  const traces: Trace[] = [];
  for (const id of ids) {
    const head = heads.get(id);
    const inboundAt = Date.parse(head.ts);
    const aroundRows = nearby.filter((m) => m.rn >= head.rn - 50 && m.rn <= head.rn + 3);
    const contextBefore = aroundRows.filter((m) => m.rn < head.rn).slice(-6)
      .map((m) => ({ id: m.id, sender: m.sender, body: cut(around(m.body), 300), ts: m.ts }));
    const after = aroundRows.filter((m) => m.rn > head.rn).slice(0, 3)
      .map((m) => ({ id: m.id, sender: m.sender, body: cut(around(m.body), 300), ts: m.ts }));
    const userBefore: NeighborMessage[] = aroundRows.filter((m) => m.rn < head.rn)
      .map((m) => ({ id: m.id, body: around(m.body), ts: m.ts, at: Date.parse(m.ts) }));
    const botBefore = justBefore
      .filter((o) => o.msg_id !== id && o.created_at < inboundAt && inboundAt - o.created_at <= 30 * 60_000)
      .map((o) => ({ outbox_id: o.id, body: around(o.body), at: o.created_at }));

    const batch = batchFor.get(id);
    const decision = (decisions.get(id) || []).sort((a, b) => (a.at || 0) - (b.at || 0)).at(-1) ||
      (batch ? { ...batch.decision, at: undefined } : undefined);
    const replyRows = (replies.get(id) || []).sort((a, b) => (a.at || 0) - (b.at || 0));
    const allReplies = replyRows.map((o) => ({ outbox_id: o.id, body: around(o.body), status: String(o.status ?? ""), at: Number(o.at) }));
    const turnTools = hasTurnTools ? (toolsByTurn.get(id) || []) : null;
    let tools: Trace["tools"] = "unrecorded";
    let toolsOffered: Trace["tools_offered"] = "unknown";
    if (turnTools) {
      tools = turnTools.map((t) => ({
        name: t.name, ok: Boolean(t.ok), error_kind: t.error_kind || "none", ms: Number(t.ms),
      }));
      toolsOffered = turnTools.length ? [...new Set(turnTools.filter((t) => t.offered).map((t) => t.name) as string[])] : "unknown";
    }

    let snapshotRef: Trace["snapshot_ref"] = null;
    for (const sample of samples) {
      if (sample.at <= inboundAt) {
        snapshotRef = { health_at: sample.at, gateway_ok: sample.gateway_ok ? 1 : 0, runner_ok: sample.runner_ok ? 1 : 0 };
      } else break;
    }

    const base: Trace = {
      id: `tr-${head.id}`,
      group_id: head.group_id,
      inbound: {
        id: head.id,
        rowid: Number(head.rowid),
        ts: head.ts,
        sender: head.sender,
        body: cut(around(head.body), 1200),
        mentioned: head.mentioned ? 1 : 0,
      },
      context_before: contextBefore,
      decision: decision
        ? { action: decision.action, gate: decision.gate, spoken_kind: decision.spoken_kind ?? undefined,
            reason: decision.reason ?? undefined, model_ms: decision.model_ms ?? undefined }
        : undefined,
      replies: allReplies,
      after,
      job: head.job_id
        ? { id: head.job_id, kind: head.job_kind, status: head.job_status, error: head.job_error ?? undefined }
        : undefined,
      tools,
      tools_offered: toolsOffered,
      snapshot_ref: snapshotRef,
      signals: [],
    };

    const neighbors: Neighbors = {
      after,
      user_before: userBefore,
      bot_before: botBefore,
      deliveries: Number(head.delivered_files || 0),
      batch_started_at: batch?.startedAt,
      batch_replied_at: batch?.repliedAt ?? undefined,
      batch_trigger: batch?.trigger,
    };
    base.signals = signalsOf(base, neighbors) as SignalKey[];
    base.replies = allReplies.slice(0, 4).map((r) => ({ ...r, body: cut(r.body, 800) }));
    traces.push(fitTrace(base));
  }

  const last = traces[traces.length - 1];
  return { traces, cursor: { ts: last.inbound.ts, id: last.inbound.id } };
}
