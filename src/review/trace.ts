// V-D v2 / P1-3/P1-1/P1-7: build inbound and standalone-outbound traces from
// one window. Read-only, no model, no chat_cursor / processed, no rowid cursor.
import { redact } from "../runtime";
import { addressedOf, segmentsOf, senderTag } from "./provenance";
import { signalsOf, type NeighborMessage, type Neighbors } from "./signals";
import type { SignalKey, Trace, TraceMsg } from "./types";

export type TraceCursor = { ts: string; id: string };
export type OutboxCursor = { at: number; id: string };
export type Coverage = {
  messages: number;
  outbox: number;
  inbound_traces: number;
  outbound_traces: number;
  outbox_paired: number;
  outbox_standalone: number;
  skipped_by_rule: number;
  unaccounted: number;
};
export type TraceRun = {
  group_id: string;
  window_start?: string;        // inclusive ISO timestamp
  window_end?: string;          // exclusive ISO timestamp
  cursor?: TraceCursor | null;  // messages built cursor, exclusive
  outbox_cursor?: OutboxCursor | null; // outbox built cursor, exclusive
  page_size?: number;           // retained for callers; the v2 builder scans one window per call
};
export type TracePage = { traces: Trace[]; cursor: TraceCursor; outbox_cursor: OutboxCursor; coverage: Coverage };

const DAY = 86_400_000;
const cut = (s: unknown, n: number) => {
  const text = String(s ?? "");
  return text.length > n ? text.slice(0, n) : text;
};
const around = (s: unknown) => redact(String(s ?? ""));
const parseJson = (s: unknown, fallback: any) => {
  try { return typeof s === "string" ? JSON.parse(s) : (s ?? fallback); } catch { return fallback; }
};
const baseId = (id: string) => id.includes("~") ? id.slice(0, id.indexOf("~")) : id;
type Link = "reply_to" | "decision" | "batch" | "none";
type Decision = { id: string; latest_id: string; batch_ids: string[]; outbox_id: string | null;
  action: string; gate: string; spoken_kind: string | null; reason: string | null; model_ms: number | null; created_at: number };

const MESSAGES_SQL = `
SELECT m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned,
       mm.json AS meta,
       (SELECT mem.id FROM members mem
         WHERE mem.revoked = 0 AND (mem.id = m.sender OR mem.id = 'qq:' || m.sender
           OR (m.sender LIKE 'qq:%' AND mem.id = substr(m.sender, 4)))
         LIMIT 1) AS bound_member,
       COALESCE((SELECT json_group_array(json_object(
           'idx', mi.idx, 'sha', mi.sha, 'desc', note.desc, 'text', note.text, 'url_ok', NULL))
         FROM message_images mi
         LEFT JOIN image_notes note ON note.sha = mi.sha
         WHERE mi.message_id = m.id), '[]') AS images_json
FROM messages m
LEFT JOIN message_meta mm ON mm.id = m.id
WHERE m.group_id = ?1
  AND julianday(m.ts) >= julianday(?2) AND julianday(m.ts) < julianday(?3)
  AND (?4 IS NULL OR julianday(m.ts) > julianday(?4) OR (julianday(m.ts) = julianday(?4) AND m.id > ?5))
ORDER BY julianday(m.ts), m.id`;

const DECISIONS_SQL = `
SELECT id,latest_id,batch_ids,outbox_id,action,gate,spoken_kind,reason,model_ms,created_at
FROM chat_decisions
WHERE group_id = ?1 AND created_at >= ?2 AND created_at < ?3
ORDER BY created_at, id`;

const OUTBOX_SQL = `
SELECT o.id, o.group_id, o.msg_id, o.body, o.status, o.created_at,
       om.json AS meta,
       j.id AS job_id, j.kind AS job_kind, j.status AS job_status, j.error AS job_error,
       (SELECT COUNT(*) FROM deliveries dl
          WHERE dl.job_id = j.id
            AND CASE WHEN json_valid(dl.files) THEN json_array_length(dl.files) ELSE 0 END > 0) AS delivered_files
FROM outbox o
LEFT JOIN outbox_meta om ON om.id = CASE WHEN instr(o.id, '~') > 0
                                         THEN substr(o.id, 1, instr(o.id, '~') - 1) ELSE o.id END
LEFT JOIN jobs j ON j.id = CASE WHEN instr(o.id, '~') > 0
                                THEN substr(o.id, 1, instr(o.id, '~') - 1) ELSE o.id END
WHERE o.group_id = ?1 AND o.created_at >= ?2 AND o.created_at < ?3
  AND (?4 IS NULL OR o.created_at > ?4 OR (o.created_at = ?4 AND o.id > ?5))
ORDER BY o.created_at, o.id`;

const metaReference = (meta: any): string | null => {
  if (!meta) return null;
  const value = meta.reply_to ?? meta.replyTo ?? meta.reference;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return value.id || value.message_id || value.targetId || null;
  return null;
};

/** review_traces.trace_json is capped at 6000 characters by migration 0008. */
function fitTrace(trace: Trace): Trace {
  let json = JSON.stringify(trace);
  const texts: { body: string; segs?: { text: string }[] }[] = [];
  if (trace.inbound) texts.push(trace.inbound);
  texts.push(...trace.context_before, ...trace.after);
  while (json.length > 6000) {
    const candidates: { get: () => string; set: (value: string) => void }[] = [];
    for (const item of texts) {
      if (item.body) candidates.push({ get: () => item.body, set: (v) => { item.body = v; } });
      for (const seg of item.segs || []) {
        if (seg.text) candidates.push({ get: () => seg.text, set: (v) => { seg.text = v; } });
      }
      for (const image of (item as any).images || []) {
        if (image.desc) candidates.push({ get: () => image.desc, set: (v) => { image.desc = v; } });
      }
    }
    for (const reply of trace.replies) {
      if (reply.body) candidates.push({ get: () => reply.body, set: (v) => { reply.body = v; } });
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => b.get().length - a.get().length);
    const target = candidates[0];
    const current = target.get();
    const next = Math.min(current.length - 1, Math.floor(current.length * 0.7));
    if (next < 0) break;
    target.set(current.slice(0, next));
    json = JSON.stringify(trace);
  }
  return trace;
}

export async function buildTraces(e: any, run: TraceRun): Promise<TracePage> {
  const group = run.group_id;
  const end = run.window_end || new Date().toISOString();
  const start = run.window_start || new Date(Date.now() - 3 * DAY).toISOString();
  const endMs = Date.parse(end);
  const startMs = Date.parse(start);
  const cursor = run.cursor || null;
  const outboxCursor = run.outbox_cursor || null;

  const rawMessages: any[] = (await e.DB.prepare(MESSAGES_SQL)
    .bind(group, start, end, cursor?.ts ?? null, cursor?.id ?? "").all()).results;
  const messages = rawMessages.map((row, index) => ({
    ...row,
    sender: String(row.sender || ""),
    body: String(row.body || ""),
    ts: String(row.ts),
    mentioned: Number(row.mentioned) ? 1 : 0,
    meta: row.meta ?? null,
    bound_member: row.bound_member ?? null,
    images: parseJson(row.images_json, []).map((img: any) => ({
      idx: Number(img.idx), sha: String(img.sha), desc: img.desc ?? null,
      text: img.text ?? null, url_ok: img.url_ok === null || img.url_ok === undefined ? null : Boolean(img.url_ok),
    })),
    index,
  }));
  const msgById = new Map(messages.map((m) => [m.id, m]));

  const rawDecisions: any[] = (await e.DB.prepare(DECISIONS_SQL)
    .bind(group, startMs - 300_000, endMs + 300_000).all()).results;
  const decisions: Decision[] = rawDecisions.map((row) => ({
    id: String(row.id),
    latest_id: String(row.latest_id),
    batch_ids: parseJson(row.batch_ids, []).map(String),
    outbox_id: row.outbox_id ?? null,
    action: String(row.action),
    gate: String(row.gate),
    spoken_kind: row.spoken_kind ?? null,
    reason: row.reason ?? null,
    model_ms: row.model_ms ?? null,
    created_at: Number(row.created_at),
  }));
  const decisionByLatest = new Map<string, Decision>();
  const decisionByOutbox = new Map<string, Decision>();
  const decisionByMessage = new Map<string, Decision>();
  for (const d of decisions) {
    decisionByLatest.set(d.latest_id, d);
    if (d.outbox_id) decisionByOutbox.set(d.outbox_id, d);
    for (const id of d.batch_ids) decisionByMessage.set(id, d);
    if (!decisionByMessage.has(d.latest_id)) decisionByMessage.set(d.latest_id, d);
  }

  const rawOutbox: any[] = (await e.DB.prepare(OUTBOX_SQL)
    .bind(group, startMs, endMs, outboxCursor?.at ?? null, outboxCursor?.id ?? "").all()).results;
  const outbox = rawOutbox.map((row) => ({
    ...row,
    id: String(row.id),
    msg_id: row.msg_id ?? null,
    body: String(row.body || ""),
    status: String(row.status || ""),
    created_at: Number(row.created_at),
    meta: row.meta ?? null,
    delivered_files: Number(row.delivered_files || 0),
  }));

  const samples: any[] = (await e.DB.prepare(
    "SELECT at,gateway_ok,runner_ok FROM health_samples WHERE at <= ? ORDER BY at DESC LIMIT 2000",
  ).bind(endMs).all()).results.reverse();

  const hasToolTable = Boolean(await e.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='turn_tools'",
  ).first());
  const hasOfferTable = Boolean(await e.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='turn_offers'",
  ).first());
  const toolRows: any[] = hasToolTable
    ? (await e.DB.prepare(
        `SELECT id,turn_id,name,ok,error_kind,ms,offered,created_at FROM turn_tools
         WHERE (group_id = ?1 OR group_id IS NULL) AND created_at >= ?2 AND created_at < ?3
         ORDER BY created_at, id`).bind(group, startMs, endMs + 300_000).all()).results
    : [];
  const offerRows: any[] = hasOfferTable
    ? (await e.DB.prepare(
        `SELECT turn_id,inbound_id,names,catalog_version,switches,runner_ok,created_at FROM turn_offers
         WHERE (group_id = ?1 OR group_id IS NULL) AND created_at >= ?2 AND created_at < ?3
         ORDER BY created_at, turn_id`).bind(group, startMs, endMs + 300_000).all()).results
    : [];
  const toolsByTurn = new Map<string, any[]>();
  for (const row of toolRows) {
    const list = toolsByTurn.get(row.turn_id) || [];
    list.push(row);
    toolsByTurn.set(row.turn_id, list);
  }
  const offerByInbound = new Map<string, any>();
  const offerByTurn = new Map<string, any>();
  for (const row of offerRows) {
    if (row.inbound_id) offerByInbound.set(String(row.inbound_id), row);
    offerByTurn.set(String(row.turn_id), row);
  }

  // Pairing order: msg_id -> decision.outbox_id/batch_ids -> outbox_meta.reply_to -> independent.
  const targetsByOutbox = new Map<string, { id: string; link: Link }[]>();
  const decisionForOutbox = (o: any): Decision | null => {
    const exact = decisionByOutbox.get(o.id) || (o.id.includes("~") ? decisionByOutbox.get(baseId(o.id)) : null);
    if (exact) return exact;
    const base = baseId(o.id);
    return decisions.filter((d) => (d.outbox_id === null || d.outbox_id === base) && base.endsWith("-" + d.latest_id)).at(-1) || null;
  };
  for (const o of outbox) {
    const targets: { id: string; link: Link }[] = [];
    if (o.msg_id && msgById.has(o.msg_id)) targets.push({ id: o.msg_id, link: "reply_to" });
    const decision = decisionForOutbox(o);
    if (decision) {
      for (const id of decision.batch_ids) {
        if (!msgById.has(id) || targets.some((t) => t.id === id)) continue;
        targets.push({ id, link: id === decision.latest_id ? "decision" : "batch" });
      }
      if (!targets.length && msgById.has(decision.latest_id)) targets.push({ id: decision.latest_id, link: "decision" });
    }
    if (!targets.length) {
      const reference = metaReference(parseJson(o.meta, {}));
      if (reference && msgById.has(reference)) targets.push({ id: reference, link: "reply_to" });
    }
    targetsByOutbox.set(o.id, targets);
  }

  const included = new Set<string>();
  for (const m of messages) {
    if (m.mentioned || decisionByMessage.has(m.id)) included.add(m.id);
  }
  for (const targets of targetsByOutbox.values()) {
    for (const target of targets) {
      const index = msgById.get(target.id)?.index;
      if (index === undefined) continue;
      for (let i = Math.max(0, index - 2); i <= Math.min(messages.length - 1, index + 2); i++) included.add(messages[i].id);
    }
  }

  const paired = new Set<string>();
  for (const o of outbox) {
    if ((targetsByOutbox.get(o.id) || []).some((target) => included.has(target.id))) paired.add(o.id);
  }
  const repliesBy = new Map<string, { outbox: any; link: Link }[]>();
  for (const o of outbox) {
    if (!paired.has(o.id)) continue;
    for (const target of targetsByOutbox.get(o.id) || []) {
      if (!included.has(target.id)) continue;
      const list = repliesBy.get(target.id) || [];
      list.push({ outbox: o, link: target.link });
      repliesBy.set(target.id, list);
    }
  }
  for (const list of repliesBy.values()) list.sort((a, b) => a.outbox.created_at - b.outbox.created_at || a.outbox.id.localeCompare(b.outbox.id));

  const healthAt = (at: number) => {
    let found: any = null;
    for (const sample of samples) {
      if (sample.at <= at) found = sample;
      else break;
    }
    return found ? { health_at: found.at, gateway_ok: (found.gateway_ok ? 1 : 0) as 0 | 1, runner_ok: (found.runner_ok ? 1 : 0) as 0 | 1 } : null;
  };

  const traceMsg = (m: any, limit: number): TraceMsg => ({
    id: m.id,
    sender: senderTag(m.sender),
    ts: m.ts,
    body: cut(around(m.body), limit),
    segs: segmentsOf(m.body, m.meta, m.images || []).map((seg) => ({
      origin: seg.origin, text: cut(around(seg.text), limit),
    })),
    bound_member: m.bound_member || null,
    addressed: addressedOf(m.body, m.mentioned, m.meta),
    images: (m.images || []).map((img: any) => ({
      idx: img.idx, sha: img.sha,
      desc: img.desc === null || img.desc === undefined ? null : cut(around(img.desc), 300),
      url_ok: img.url_ok ?? null,
    })),
  });

  const toolList = (turnId: string | null): Trace["tools"] => {
    if (!hasToolTable) return "unrecorded";
    if (!turnId) return [];
    return (toolsByTurn.get(turnId) || []).map((row) => ({
      id: String(row.id), name: String(row.name), ok: Boolean(row.ok),
      error_kind: String(row.error_kind || "none"), ms: Number(row.ms || 0),
    }));
  };
  const offers = (inboundId: string | null, turnId: string | null): Trace["tools_offered"] => {
    if (!hasOfferTable) return "unknown";
    const row = (inboundId && offerByInbound.get(inboundId)) || (turnId && offerByTurn.get(turnId)) || null;
    if (!row) return "unknown";
    return {
      names: parseJson(row.names, []).map(String),
      catalog_version: String(row.catalog_version || ""),
      switches: Object.fromEntries(Object.entries(parseJson(row.switches, {})).map(([k, v]: [string, any]) => {
        if (v === "on" || v === "off") return [k, v];
        const enabled = v === "1" || v === 1 || v === true;
        return [k, k.startsWith("off:") ? (enabled ? "on" : "off") : (enabled ? "on" : "off")];
      })),
      runner_ok: row.runner_ok === null || row.runner_ok === undefined ? null : (row.runner_ok ? 1 : 0),
      turn_id: String(row.turn_id),
    };
  };

  const batchInfo = (id: string) => {
    const decision = decisionByMessage.get(id);
    if (!decision) return null;
    const present = decision.batch_ids.filter((member) => msgById.has(member));
    if (!present.length) return null;
    const startedAt = Math.min(...present.map((member) => Date.parse(msgById.get(member)!.ts)));
    const reply = outbox.find((o) => o.id === decision.outbox_id) ||
      outbox.find((o) => present.includes(o.msg_id));
    return {
      decision,
      startedAt,
      repliedAt: reply ? reply.created_at : null,
      trigger: present.some((member) => addressedOf(msgById.get(member)!.body, msgById.get(member)!.mentioned, msgById.get(member)!.meta) === "bot"),
    };
  };

  const traces: Trace[] = [];
  for (const m of messages) {
    if (!included.has(m.id)) continue;
    const batch = batchInfo(m.id);
    const own = decisionByLatest.get(m.id) || batch?.decision || null;
    const replyRows = repliesBy.get(m.id) || [];
    const allReplies = replyRows.map(({ outbox: o, link }) => ({
      outbox_id: o.id, body: cut(around(o.body), 800), status: o.status, at: o.created_at, link,
    }));
    const lastReplyAt = allReplies.length ? Math.max(...allReplies.map((r) => r.at)) : Date.parse(m.ts);
    const contextBefore = messages.filter((row) => row.index < m.index).slice(-6).map((row) => traceMsg(row, 300));
    const next = messages.filter((row) => Date.parse(row.ts) > lastReplyAt).slice(0, 3).map((row) => traceMsg(row, 300));
    const previous = messages.filter((row, index) => index < m.index && index >= m.index - 50)
      .map((row) => ({ id: row.id, body: around(row.body), ts: row.ts, at: Date.parse(row.ts) }));
    const botBefore = outbox.filter((o) => o.created_at < Date.parse(m.ts) && Date.parse(m.ts) - o.created_at <= 30 * 60_000)
      .map((o) => ({ outbox_id: o.id, body: around(o.body), at: o.created_at }));
    const offer = offerByInbound.get(m.id) ||
      (batch ? offerByInbound.get(batch.decision.latest_id) : null) || null;
    const turnId = offer ? String(offer.turn_id) : (batch?.decision.latest_id || m.id);
    const firstReply = replyRows[0]?.outbox || null;
    const base: Trace = {
      id: `tr-in-${m.id}`,
      group_id: m.group_id,
      kind: "inbound",
      inbound: { ...traceMsg(m, 1200), mentioned: m.mentioned },
      context_before: contextBefore,
      decision: own ? { action: own.action, gate: own.gate, spoken_kind: own.spoken_kind ?? undefined,
        reason: own.reason ?? undefined, model_ms: own.model_ms ?? undefined } : undefined,
      replies: allReplies,
      after: next,
      job: firstReply?.job_id ? { id: firstReply.job_id, kind: firstReply.job_kind, status: firstReply.job_status, error: firstReply.job_error ?? undefined } : undefined,
      tools: toolList(turnId),
      tools_offered: offers(m.id, turnId),
      snapshot_ref: healthAt(Date.parse(m.ts)),
      has_image: [m, ...contextBefore, ...next].some((row) => ((row as any).images || []).length > 0),
      signals: [],
    };
    const batchNeighbors = batch ? {
      batch_started_at: batch.startedAt,
      batch_replied_at: batch.repliedAt,
      batch_trigger: batch.trigger,
    } : {};
    const neighbors: Neighbors = {
      after: next,
      user_before: previous,
      bot_before: botBefore,
      deliveries: replyRows.reduce((sum, { outbox: o }) => sum + o.delivered_files, 0),
      ...batchNeighbors,
    };
    base.signals = signalsOf(base, neighbors) as SignalKey[];
    base.replies = allReplies.slice(0, 4);
    traces.push(fitTrace(base));
  }

  for (const o of outbox) {
    if (paired.has(o.id)) continue;
    const index = messages.findIndex((row) => Date.parse(row.ts) > o.created_at);
    const split = index < 0 ? messages.length : index;
    const previous = messages.slice(Math.max(0, split - 6), split).map((row) => traceMsg(row, 300));
    const next = messages.slice(split, split + 3).map((row) => traceMsg(row, 300));
    const decision = decisionForOutbox(o) || (o.msg_id ? decisionByLatest.get(o.msg_id) : null) || null;
    const self = { outbox_id: o.id, body: cut(around(o.body), 800), status: o.status, at: o.created_at, link: "none" as Link };
    const offer = (o.msg_id && offerByInbound.get(o.msg_id)) ||
      (decision && offerByInbound.get(decision.latest_id)) || offerByTurn.get(o.id) || null;
    const turnId = offer ? String(offer.turn_id) : (decision?.latest_id || o.msg_id || o.id);
    const base: Trace = {
      id: `tr-out-${o.id}`,
      group_id: o.group_id,
      kind: "outbound",
      inbound: null,
      context_before: previous,
      decision: decision ? { action: decision.action, gate: decision.gate, spoken_kind: decision.spoken_kind ?? undefined,
        reason: decision.reason ?? undefined, model_ms: decision.model_ms ?? undefined } : undefined,
      replies: [self],
      after: next,
      job: o.job_id ? { id: o.job_id, kind: o.job_kind, status: o.job_status, error: o.job_error ?? undefined } : undefined,
      tools: toolList(turnId),
      tools_offered: offers(o.msg_id || null, turnId),
      snapshot_ref: healthAt(o.created_at),
      has_image: [...previous, ...next].some((row) => (row.images || []).length > 0),
      signals: [],
    };
    const neighbors: Neighbors = {
      after: next,
      user_before: messages.filter((row) => Date.parse(row.ts) <= o.created_at).slice(-50)
        .map((row) => ({ id: row.id, body: around(row.body), ts: row.ts, at: Date.parse(row.ts) })),
      bot_before: outbox.filter((other) => other.id !== o.id && other.created_at < o.created_at && o.created_at - other.created_at <= 30 * 60_000)
        .map((other) => ({ outbox_id: other.id, body: around(other.body), at: other.created_at })),
      deliveries: o.delivered_files,
    };
    base.signals = signalsOf(base, neighbors) as SignalKey[];
    traces.push(fitTrace(base));
  }

  const inboundTraces = traces.filter((trace) => trace.kind === "inbound").length;
  const outboundTraces = traces.filter((trace) => trace.kind === "outbound").length;
  const outboxPaired = paired.size;
  const outboxStandalone = outbox.length - outboxPaired;
  const skipped = messages.length - inboundTraces;
  const inboundIds = new Set(traces.filter((trace) => trace.kind === "inbound").map((trace) => trace.inbound!.id));
  const repliedOutbox = new Set(traces.flatMap((trace) => trace.replies.map((reply) => reply.outbox_id)));
  const outboundIds = new Set(traces.filter((trace) => trace.kind === "outbound").map((trace) => trace.replies[0]?.outbox_id));
  const missingInbound = [...included].filter((id) => !inboundIds.has(id)).length;
  const missingOutbox = outbox.filter((row) => !paired.has(row.id) && !outboundIds.has(row.id)).length;
  const missingPaired = [...paired].filter((id) => !repliedOutbox.has(id)).length;
  const coverage: Coverage = {
    messages: messages.length,
    outbox: outbox.length,
    inbound_traces: inboundTraces,
    outbound_traces: outboundTraces,
    outbox_paired: outboxPaired,
    outbox_standalone: outboxStandalone,
    skipped_by_rule: skipped,
    unaccounted: missingInbound + missingOutbox + missingPaired,
  };
  const lastMessage = messages[messages.length - 1];
  const lastOutbox = outbox[outbox.length - 1];
  return {
    traces,
    cursor: lastMessage ? { ts: lastMessage.ts, id: lastMessage.id } : (cursor || { ts: end, id: "" }),
    outbox_cursor: lastOutbox ? { at: lastOutbox.created_at, id: lastOutbox.id } : (outboxCursor || { at: endMs, id: "" }),
    coverage,
  };
}
