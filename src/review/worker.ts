// Independent review entry: no daytime runtime or execution queues.
import { metered, left } from '../d1';
import { reviewRead, reviewWrite, reviewBatch, reviewRedact, applyMemoryCandidate, type ReviewStatement } from './db';
import { capabilitySnapshot } from './snapshot';
import { buildTraces } from './trace';
import { priorityOf } from './signals';
import { buildJudgeInput } from './prompt';
import { judgeModel, estimateReservation, type JudgeOptions, type JudgePrice } from './judge-model';
import { parseJudgeReply, validateResult } from './validate';
import { selectForSecond, secondJudge } from './second';
import { applyJudgment, checkPromises } from './apply';
import { proposeTasks, renderDigest } from './publish';
import { applyRequirements, advanceRules, approveRule, revokeRule } from './rules';
import { learningsPhase } from './learnings';
import { reportPhase } from './report';
import type { Trace, Snapshot, JudgeCall, JudgeResult } from './types';

type Env = { DB: any; [key: string]: any };
type Row = Record<string, any>;
// Test injection is an explicit JS argument, never a deployed variable or HTTP input.
export type TickOptions = { now?: () => number; fetch?: typeof fetch; sampleIds?: string[] };
const DAY = 86400000;
const MAX_NIGHT_TRACES = 60;
const parse = (s: any, fallback: any = {}) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? fallback; } catch { return fallback; } };
const changes = (r: any) => Number(r?.meta?.changes ?? r?.changes ?? 0);
const clean = (x: unknown) => reviewRedact(String(x));
const json = (x: any, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
const sha = async (s: string, algorithm = 'SHA-256') => Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(s))), n => n.toString(16).padStart(2, '0')).join('');

export function sydneyTime(now: number) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).map(x => [x.type, x.value]));
  const minute = Number(p.hour) * 60 + Number(p.minute);
  return { date: `${p.year}-${p.month}-${p.day}`, inWindow: minute >= 240 && minute < 450 };
}
function sampleKey(value: string) {
  let key = 2166136261;
  for (const ch of value) key = Math.imul(key ^ ch.codePointAt(0)!,16777619);
  return key >>> 0;
}
function sydneyStart(date: string) {
  const nominal = Date.parse(date); let at = nominal;
  for (let i=0;i<2;i++) {
    const offset = new Intl.DateTimeFormat('en',{timeZone:'Australia/Sydney',timeZoneName:'longOffset'}).formatToParts(at).find(p=>p.type==='timeZoneName')!.value;
    const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/)!;
    at = nominal - (match[1]==='+'?1:-1)*(Number(match[2])*60+Number(match[3]))*60000;
  }
  return at;
}
class LostLease extends Error {}
class TickBudget extends Error {}
const balanced = (c: any) => c && c.messages === c.inbound_traces + c.skipped_by_rule && c.outbox === c.outbox_paired + c.outbox_standalone && c.unaccounted === 0;

/** Enforce the four-statement reserve even inside dependency helpers. */
function bounded(env: Env) {
  const ctx = metered(env);
  const check = (n = 1) => { if (left(ctx) < Math.max(4, n + 3)) throw new TickBudget('tick_budget'); };
  const DB = { prepare(sql: string) {
    const wrap = (s: any): any => ({ sql, bind(...p: any[]) { return wrap(s.bind(...p)); },
      first(...p: any[]) { check(); return s.first(...p); }, all(...p: any[]) { check(); return s.all(...p); }, run(...p: any[]) { check(); return s.run(...p); }, __s: s });
    return wrap(ctx.DB.prepare(sql));
  }, batch(ss: any[]) { check(ss.length); return ctx.DB.batch(ss.map(s => s.__s)); } };
  return { ...ctx, DB };
}

/** Fence a whole atomic batch, including D-5b's INSERT SELECT/UPSERT writes.
 * The lease condition is part of each SQL statement, never a JS preflight. */
function fenceSQL(sql: string, run: Row): string {
  const guard = `EXISTS(SELECT 1 FROM review_runs WHERE id='${String(run.id).replace(/'/g, "''")}' AND step='${run.step}' AND gen=${Number(run.gen)})`;
  // Locate top-level clauses while ignoring quoted text and subqueries.
  const words: { word: string; at: number }[] = []; let depth = 0, quote = false;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "'") { if (quote && sql[i + 1] === "'") { i++; continue; } quote = !quote; continue; }
    if (quote) continue;
    if (sql[i] === '(') { depth++; continue; } if (sql[i] === ')') { depth--; continue; }
    if (!depth && /[a-z_]/i.test(sql[i]) && !/[a-z_0-9]/i.test(sql[i - 1] || '')) {
      const m = sql.slice(i).match(/^[a-z_0-9]+/i)!; words.push({ word: m[0].toUpperCase(), at: i }); i += m[0].length - 1;
    }
  }
  const values = words.find(w => w.word === 'VALUES');
  if (words[0]?.word === 'INSERT' && values) {
    const begin = sql.indexOf('(', values.at), end = (() => { let n = 0, q = false; for (let i = begin; i < sql.length; i++) { if (sql[i] === "'") { if (q && sql[i + 1] === "'") { i++; continue; } q = !q; } if (!q) { if (sql[i] === '(') n++; if (sql[i] === ')' && --n === 0) return i; } } return -1; })();
    if (end < 0 || sql.slice(end + 1).trim().startsWith(',')) throw Error('unsupported_plan_insert');
    return sql.slice(0, values.at) + 'SELECT ' + sql.slice(begin + 1, end) + ' WHERE ' + guard + sql.slice(end + 1);
  }
  const conflict = words.find((w, i) => w.word === 'ON' && words[i + 1]?.word === 'CONFLICT');
  const returning = words.find(w => w.word === 'RETURNING');
  const boundary = conflict?.at ?? returning?.at ?? sql.length;
  const where = words.some(w => w.word === 'WHERE' && w.at < boundary);
  return sql.slice(0, boundary) + (where ? ' AND ' : ' WHERE ') + guard + ' ' + sql.slice(boundary);
}
function fenced(e: Env, run: Row) {
  const DB = { prepare(sql: string) {
    const actual = /^\s*SELECT\b/i.test(sql) ? sql : fenceSQL(sql, run);
    const wrap = (s: any): any => ({ sql, __s: s, bind(...p: any[]) { return wrap(s.bind(...p)); }, first() { return s.first(); }, all() { return s.all(); }, run() { return s.run(); } });
    return wrap(e.DB.prepare(actual));
  }, batch(ss: any[]) { return e.DB.batch(ss.map(s => s.__s)); } };
  return { ...e, DB };
}
// Helpers can prepare their SQL without executing it; reads remain live and metered.
async function capture(e: Env, fn: (ctx: Env) => Promise<any>): Promise<ReviewStatement[]> {
  const plan: ReviewStatement[] = [];
  const DB = { prepare(sql: string) {
    const wrap = (params: any[] = []): any => ({ sql, bind(...p: any[]) { return wrap(p); },
      first() { return e.DB.prepare(sql).bind(...params).first(); }, all() { return e.DB.prepare(sql).bind(...params).all(); },
      async run() { plan.push({ sql, params }); return { meta: { changes: 1 } }; } });
    return wrap();
  }, async batch(ss: any[]) { return Promise.all(ss.map(s => s.run())); } };
  await fn({ ...e, DB }); return plan;
}
function allowedPlan(plan: ReviewStatement[], mode: string) {
  return plan.filter(s => {
    const table = s.sql.match(/^\s*(?:INSERT\s+(?:OR\s+IGNORE\s+)?INTO|UPDATE)\s+(\w+)/i)?.[1] || '';
    return mode === 'full' || (mode === 'propose' ? table !== 'behavior_rules' : table.startsWith('review_') && table !== 'review_memory_candidates');
  });
}
async function advance(e: Env, run: Row, stats: Row, step: string, now: number, extra: ReviewStatement[] = []) {
  const result = await reviewBatch(e, [...extra, { sql: 'UPDATE review_runs SET step=?,stats=?,error=NULL,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND step=? AND gen=?', params: [step, JSON.stringify({ ...stats, failures: 0 }), now, run.id, run.step, run.gen] }]);
  if (changes(result.at(-1)) !== 1) throw new LostLease();
}
async function planTick(e: Env, run: Row, stats: Row, now: number, prepare: () => Promise<ReviewStatement[]>, next: string) {
  if (!stats.plan) {
    const statements = allowedPlan(await prepare(), run.mode);
    // Small plans can commit alongside the CAS in this tick. A failed batch
    // rolls back both effects and progress; larger plans retain durable paging.
    if (statements.length <= Math.min(28, left(e) - 6)) {
      stats.phase = next;
      await advance(e, run, stats, run.step, now, statements); return;
    }
    stats.plan = { statements, offset: 0, next };
    await advance(e, run, stats, run.step, now); return;
  }
  const p = stats.plan, slice = p.statements.slice(p.offset, p.offset + Math.min(28, left(e) - 6));
  p.offset += slice.length;
  if (p.offset >= p.statements.length) { delete stats.plan; stats.phase = p.next; }
  await advance(e, run, stats, run.step, now, slice);
}

export async function reviewTick(env: Env, options: TickOptions = {}) {
  const now = (options.now ?? Date.now)(), time = sydneyTime(now);
  if (!time.inWindow) return { status: 'outside_window', used: 0 };
  const e = bounded(env);
  const settings = Object.fromEntries((await reviewRead(e, "SELECT key,value FROM settings WHERE key IN ('off:review','review:mode')")).map((r: any) => [r.key, r.value]));
  if (settings['off:review'] === '1') return { status: 'off', used: e.meter.used };
  const mode = settings['review:mode'] ?? env.REVIEW_MODE ?? 'shadow';
  if (!['shadow', 'propose', 'full'].includes(mode)) return { status: 'invalid_mode', used: e.meter.used };
  const end = new Date(now).toISOString(), start = new Date(now - 3 * DAY).toISOString();
  // An unfinished run owns its original window and journal across nights.
  // Prefer it to creating today's run, so judgments and counters are not replayed.
  const [unfinished] = await reviewRead(e, "SELECT id,group_id FROM review_runs WHERE date<=? AND step NOT IN ('done','failed','skipped') ORDER BY date,updated_at,id LIMIT 1", [time.date]);
  let id: string;
  if (unfinished) id = unfinished.id;
  else {
    const [group] = await reviewRead(e, `SELECT g.group_id FROM (
      SELECT DISTINCT group_id FROM messages WHERE julianday(ts)>=julianday(?) AND julianday(ts)<julianday(?)
      UNION SELECT DISTINCT group_id FROM outbox WHERE created_at>=? AND created_at<?
      UNION SELECT group_id FROM review_traces WHERE state='pending'
      UNION SELECT group_id FROM review_runs WHERE date=?
    ) g LEFT JOIN review_runs r ON r.group_id=g.group_id AND r.date=?
    WHERE r.id IS NULL OR r.step NOT IN ('done','failed','skipped') ORDER BY COALESCE(r.updated_at,0),g.group_id LIMIT 1`, [start, end, now - 3 * DAY, now, time.date, time.date]);
    if (!group) return { status: 'idle', used: e.meter.used };
    id = `${group.group_id}:${time.date}`;
    await reviewWrite(e, `INSERT OR IGNORE INTO review_runs(id,group_id,date,step,window_start,window_end,mode,updated_at) VALUES(?,?,?,'snapshot',?,?,?,?)`, [id, group.group_id, time.date, start, end, mode, now]);
  }
  const owner = crypto.randomUUID();
  const claim = await reviewWrite(e, 'UPDATE review_runs SET lease_owner=?,lease_until=?,gen=gen+1 WHERE id=? AND step NOT IN (\'done\',\'failed\',\'skipped\') AND (lease_until IS NULL OR lease_until<?)', [owner, now + 300000, id, now]);
  if (changes(claim) !== 1) return { status: 'leased', used: e.meter.used };
  const [run] = await reviewRead(e, 'SELECT * FROM review_runs WHERE id=?', [id]);
  const ctx = fenced(e, run), stats = parse(run.stats);
  try {
    if (run.step !== 'snapshot' && run.step !== 'trace' && !balanced(stats.coverage)) {
      await fail(ctx, run, stats, 'coverage_unbalanced', now, true); return { status: 'failed', used: e.meter.used };
    }
    const thirdNight = Date.parse(time.date) - Date.parse(run.date) >= 2 * DAY;
    if (thirdNight && ['judge','second','apply','publish'].includes(run.step)) {
      stats.forced_publish = true;
      if (run.step === 'judge' || run.step === 'second') {
        // Apply all already validated judgments; no new vote or paid call.
        // Missing second votes retain D-5a's single/disputed promotion guards.
        stats.primary_retry = null; stats.second_retry = null;
        await advance(ctx, run, stats, 'apply', now);
        return { status: 'progress', used: e.meter.used };
      }
    }
    if (run.step === 'snapshot') {
      const snapshot = await capabilitySnapshot(ctx); snapshot.at = now;
      await advance(ctx, run, stats, 'trace', now, [{ sql: 'INSERT OR IGNORE INTO review_snapshots(run_id,json,created_at) VALUES(?,?,?)', params: [id, JSON.stringify(snapshot), now] }]);
    } else if (run.step === 'trace') {
      const page = await buildTraces(ctx, { group_id: run.group_id, window_start: run.window_start, window_end: run.window_end });
      if (!balanced(page.coverage)) { await fail(ctx, run, stats, 'coverage_unbalanced', now, true); return { status: 'failed', used: e.meter.used }; }
      if (!stats.review_selection) {
        const oldTraces = await reviewRead(ctx, 'SELECT id,state,trace_json,created_at FROM review_traces WHERE group_id=?', [run.group_id]);
        const known = new Map(oldTraces.map(t => [t.id,t]));
        const unseen = (t: Trace) => !known.has(t.id) || known.get(t.id)!.state === 'pending';
        const samples = page.traces.filter(t => !t.signals.length && t.inbound?.mentioned === 1 && unseen(t))
          .map(t => ({ t, key: sampleKey(run.id + '|' + t.id) })).sort((a,b) => a.key - b.key || a.t.id.localeCompare(b.t.id)).slice(0,2).map(x => x.t.id);
        // Test-only JS injection (never a deployed variable): force-sample named traces.
        for (const t of page.traces) if (options.sampleIds?.includes(t.id) && unseen(t) && !samples.includes(t.id)) samples.push(t.id);
        stats.sampled_ids = samples;
        const pool = new Map<string,Trace>(oldTraces.filter(t => t.state === 'pending' && t.created_at >= now - 3*DAY).map(t => [t.id,parse(t.trace_json)]));
        for (const t of page.traces) if (unseen(t)) pool.set(t.id,t);
        stats.review_targets = [...pool.values()].filter(t => t.signals.length || samples.includes(t.id))
          .sort((a,b) => Number(samples.includes(b.id)) - Number(samples.includes(a.id)) || priorityOf(b.signals) - priorityOf(a.signals) || a.id.localeCompare(b.id)).slice(0,MAX_NIGHT_TRACES).map(t => t.id);
        stats.review_selection = true;
      }
      const eligible = (t: Trace) => t.signals.length > 0 || stats.sampled_ids.includes(t.id);
      const skipped = page.traces.filter(t => !eligible(t) && t.kind === 'inbound').length;
      stats.coverage = { ...page.coverage, inbound_traces: page.coverage.inbound_traces - skipped,
        skipped_by_rule: page.coverage.skipped_by_rule + skipped,
        skipped_outbound: page.traces.filter(t => !eligible(t) && t.kind === 'outbound').length };
      const offset = stats.trace_offset ?? 0, portion = page.traces.slice(offset, offset + 200).map(t => ({ ...t, priority: priorityOf(t.signals), review_state: eligible(t) ? 'pending' : 'skipped' }));
      const statements: ReviewStatement[] = [];
      for (let i = 0; i < portion.length; i += 20) statements.push({ sql: `INSERT OR IGNORE INTO review_traces(id,run_id,group_id,kind,inbound_id,outbound_id,signals,priority,has_image,state,trace_json,created_at)
        SELECT json_extract(value,'$.id'),?,?,json_extract(value,'$.kind'),json_extract(value,'$.inbound.id'),CASE WHEN json_extract(value,'$.kind')='outbound' THEN json_extract(value,'$.replies[0].outbox_id') ELSE NULL END,json_extract(value,'$.signals'),COALESCE(json_extract(value,'$.priority'),0),json_extract(value,'$.has_image'),json_extract(value,'$.review_state'),value,? FROM json_each(?)`, params: [id, run.group_id, now, JSON.stringify(portion.slice(i, i + 20))] });
      stats.trace_offset = offset + portion.length;
      const done = stats.trace_offset >= page.traces.length;
      if (done) statements.push({ sql: "UPDATE review_traces SET state='skipped' WHERE group_id=? AND state='pending' AND json_array_length(signals)=0 AND id NOT IN(SELECT value FROM json_each(?))", params: [run.group_id, JSON.stringify(stats.sampled_ids)] });
      if (done) statements.push({ sql: "UPDATE review_traces SET state='expired' WHERE group_id=? AND state='pending' AND created_at<?", params: [run.group_id, now - 3 * DAY] });
      if (done) for (const [stream, at, cursorId] of [['messages', page.cursor.ts, page.cursor.id], ['outbox', String(page.outbox_cursor.at), page.outbox_cursor.id]]) statements.push({ sql: `INSERT INTO review_cursors(group_id,stream,built_at,built_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(group_id,stream) DO UPDATE SET built_at=excluded.built_at,built_id=excluded.built_id,updated_at=excluded.updated_at`, params: [run.group_id, stream, at, cursorId, now] });
      await advance(ctx, run, stats, done ? 'judge' : 'trace', now, statements);
    } else if (run.step === 'judge' || run.step === 'second') {
      await judgeTick(ctx, e, run, stats, now, options);
    } else if (run.step === 'apply') {
      if (stats.plan) { await planTick(ctx, run, stats, now, async () => [], ''); }
      else {
        const [j] = await reviewRead(ctx, "SELECT id FROM review_judgments WHERE run_id=? AND role='primary' AND state='ok' AND consumed_at IS NULL ORDER BY created_at,id LIMIT 1", [run.id]);
        if (j) await planTick(ctx, run, stats, now, async () => {
          const result = await applyJudgment(ctx, { id: run.id, group_id: run.group_id, gen: run.gen, now }, j.id, { prepareOnly: true });
          const [row] = await reviewRead(ctx, 'SELECT trace_ids FROM review_judgments WHERE id=?', [j.id]);
          // All validated verdicts and no-action traces complete; judge-side failures stay separate.
          return [...(result.plan ?? []), { sql: "UPDATE review_traces SET state='judged',judged_run_id=? WHERE id IN (SELECT value FROM json_each(?)) AND state='pending'", params: [run.id, row.trace_ids] }];
        }, 'applied');
        else { stats.phase = 'requirements'; stats.requirement_offset = 0; await advance(ctx, run, stats, 'publish', now); }
      }
    } else if (run.step === 'publish') {
      await publishTick(ctx, run, stats, now, options);
    } else throw Error('unknown_step');
    return { status: 'progress', used: e.meter.used };
  } catch (error) {
    if (!(error instanceof LostLease)) await fail(ctx, run, stats, error instanceof TickBudget ? 'tick_budget' : 'step_failed', now);
    return { status: error instanceof LostLease ? 'stale' : 'retry', used: e.meter.used };
  }
}
async function fail(e: Env, run: Row, stats: Row, error: string, now: number, fatal = false) {
  const failures = (stats.failures ?? 0) + 1;
  await reviewWrite(e, 'UPDATE review_runs SET step=?,stats=?,error=?,lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND step=? AND gen=?', [fatal || failures >= 3 ? 'failed' : run.step, JSON.stringify({ ...stats, failures }), error, now, run.id, run.step, run.gen]);
}

function judgeOptions(e: Env, role: string, now: number, options: TickOptions): JudgeOptions {
  const prefix = role === 'primary' ? 'DEEPSEEK' : 'OPENAI';
  return { price: { unit: 'usd_micros', input: Number(e[prefix + '_INPUT_USD_MICROS']), output: Number(e[prefix + '_OUTPUT_USD_MICROS']) }, now: () => now, fetch: options.fetch, dayCap: Number(e[prefix + '_DAY_CAP_USD_MICROS'] ?? (role === 'primary' ? 100000 : 500000)) };
}
async function judgeTick(ctx: Env, unguarded: Env, run: Row, stats: Row, now: number, options: TickOptions) {
  const primary = run.step === 'judge', role = primary ? 'primary' : 'second';
  const [snap] = await reviewRead(ctx, 'SELECT json FROM review_snapshots WHERE run_id=?', [run.id]);
  const snapshot: Snapshot = parse(snap.json);
  const rows = await reviewRead(ctx, `SELECT t.* FROM review_traces t WHERE t.group_id=? AND t.state='pending'
    AND (? IS NULL OR t.id IN(SELECT value FROM json_each(?)))
    AND NOT EXISTS(SELECT 1 FROM review_judgments j,json_each(j.trace_ids) x WHERE j.run_id=? AND j.role=? AND j.state='ok' AND x.value=t.id)
    ORDER BY t.priority DESC,t.attempts,t.created_at,t.id LIMIT 8`, [run.group_id, stats.review_targets ? JSON.stringify(stats.review_targets) : null, stats.review_targets ? JSON.stringify(stats.review_targets) : null, run.id, role]);
  let traces: Trace[] = rows.map((r: any) => parse(r.trace_json));
  if (!primary) {
    const judgments = await reviewRead(ctx, "SELECT raw FROM review_judgments WHERE run_id=? AND role='primary' AND state='ok'", [run.id]);
    const all: JudgeResult = { schema: 'ta.review.result.v2', verdicts: [], requirements: [], memory_updates: [], promises: [], no_action: [] };
    for (const j of judgments) { const r = parse(j.raw); for (const key of ['verdicts', 'requirements', 'memory_updates', 'promises', 'no_action']) (all as any)[key].push(...(r[key] ?? [])); }
    // Selection is per night, not per batch. A deterministic sample survives retries.
    const allRows = await reviewRead(ctx, `SELECT trace_json FROM review_traces WHERE group_id=? AND id IN(SELECT x.value FROM review_judgments j,json_each(j.trace_ids) x WHERE j.run_id=? AND j.role='primary' AND j.state='ok') ORDER BY id`, [run.group_id, run.id]);
    const selected = new Set(selectForSecond(allRows.map(r => parse(r.trace_json)), all, { random: () => 0.5, taskTraceIds: all.verdicts.filter(v => v.gap_type).map(v => v.trace_id) }).map(t => t.id));
    const done = new Set((await reviewRead(ctx, "SELECT x.value AS id FROM review_judgments j,json_each(j.trace_ids) x WHERE j.run_id=? AND j.role='second' AND (j.state='ok' OR j.state IN ('error','timeout','invalid'))", [run.id])).map(r => r.id));
    traces = allRows.map(r => parse(r.trace_json)).filter(t => selected.has(t.id) && !done.has(t.id));
  }
  if (primary && traces.length) {
    const date = sydneyTime(now).date, nextDate = new Date(Date.parse(date) + DAY).toISOString().slice(0,10);
    const attempted = new Set((await reviewRead(ctx, "SELECT DISTINCT x.value AS id FROM review_judgments j,json_each(j.trace_ids) x WHERE role='primary' AND reserved>0 AND created_at>=? AND created_at<?", [sydneyStart(date),sydneyStart(nextDate)])).map(r => r.id));
    let remaining = Math.max(0,MAX_NIGHT_TRACES - attempted.size);
    traces = traces.filter(t => attempted.has(t.id) || remaining-- > 0);
    if (!traces.length) stats.quota_deferred = true;
  }
  if (!traces.length) { await advance(ctx, run, stats, primary ? 'second' : 'apply', now); return; }
  // One provider call per tick, including bounded split retries on following ticks.
  const max = primary ? 4096 : 2048, retries: Row = stats[role + '_retry'] ?? {};
  if (retries.queue?.length) {
    const wanted = retries.queue.shift(); const byId = new Map(traces.map(t => [t.id, t]));
    const extra = await reviewRead(ctx, 'SELECT trace_json FROM review_traces WHERE id IN(SELECT value FROM json_each(?))', [JSON.stringify(wanted)]);
    for (const row of extra) { const t = parse(row.trace_json); byId.set(t.id, t); }
    traces = wanted.map((id: string) => byId.get(id)).filter(Boolean);
  } else traces = traces.slice(0, 2);
  const messages = buildJudgeInput(traces, snapshot, snapshot.tools_catalog, [], [], [], { role, max_tokens: max });
  const included = new Set<string>(parse(messages[1].content).traces.map((t: any) => t.id)); traces = traces.filter(t => included.has(t.id));
  const ids = traces.map(t => t.id), provider = primary ? 'deepseek' : 'openai';
  const model = primary ? ctx.DEEPSEEK_MODEL ?? 'deepseek-flash' : ctx.OPENAI_MODEL ?? '';
  const call: JudgeCall = { provider, model, system: messages[0].content, user: messages[1].content, max_tokens: max, timeout_ms: 90000 };
  const opts = judgeOptions(ctx, role, now, options), memberIds = (await reviewRead(ctx, 'SELECT id FROM members WHERE revoked=0')).map(r => r.id);
  const jid = `${run.id}:${role}:${(await sha(ids.slice().sort().join('|'), 'SHA-1')).slice(0, 12)}:${run.gen}`;
  let reserved = 0; try { reserved = estimateReservation(call, opts.price as JudgePrice); } catch { /* adapter fails closed when price unavailable */ }
  const judgmentInsert = (amount: number): ReviewStatement => ({ sql: `INSERT OR IGNORE INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,state,reserved,max_tokens,created_at) SELECT ?,?,?,?,?,?,?,'reserved',?,?,? WHERE changes()=1`, params: [jid, run.id, run.gen, role, provider, model, JSON.stringify(ids), amount, max, now] });
  // The adapter's reservation UPDATE and journal INSERT commit atomically before
  // the request leaves. Settlement is allowed after a lease changes generations.
  const callEnv = { ...unguarded, DB: { ...unguarded.DB, prepare(sql: string) {
    if (!/^UPDATE review_budget SET reserved=reserved\+/.test(sql)) return unguarded.DB.prepare(sql);
    const wrap = (params: any[] = []): any => ({ sql, bind(...p: any[]) { return wrap(p); }, async run() {
      reserved = Number(params[0]);
      const results = await reviewBatch(ctx, [{ sql: sql + ' AND NOT EXISTS(SELECT 1 FROM review_judgments WHERE id=?)', params: [...params, jid] }, judgmentInsert(reserved)]);
      return results[0];
    } }); return wrap();
  } } };

  // The model adapter's budget transaction remains independent of the lease: a
  // late response must settle its reserved cost and persist its own judgment.
  const answer = primary ? { reply: await judgeModel(callEnv, call, opts), result: null as any } : await secondJudge(callEnv, traces, snapshot, { ...opts, model, max_tokens: max, context: { memberIds }, imageSources: await imageSources(ctx, traces) });
  const parsed = parseJudgeReply(answer.reply, primary ? 'ta.review.result.v2' : 'ta.review.second.v1');
  let state: string = parsed.state, raw: any = null;
  if (parsed.state === 'ok') {
    if (primary) {
      const validated = validateResult(parsed.json, { traces, snapshot, same_family: 0, memberIds });
      const good = new Set(validated.verdicts.map(v => v.trace_id));
      const no_action = (parsed.json.no_action ?? []).filter((v: any) => included.has(v.trace_id) && !good.has(v.trace_id) && typeof v.why === 'string');
      if (new Set([...good, ...no_action.map((v: any) => v.trace_id)]).size !== ids.length) state = 'invalid';
      raw = { schema: 'ta.review.result.v2', ...validated, no_action };
    } else {
      raw = { schema: 'ta.review.second.v1', ...answer.result };
      if (new Set(answer.result?.verdicts.map((v: any) => v.trace_id)).size !== ids.length) state = 'invalid';
    }
  }
  // Preflight failures (missing prices, exhausted budget, invalid config) never
  // reached the reservation transaction; still journal the failed attempt.
  await reviewWrite(ctx, `INSERT OR IGNORE INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,state,reserved,max_tokens,created_at) VALUES(?,?,?,?,?,?,?,'error',0,?,?)`, [jid, run.id, run.gen, role, provider, model, JSON.stringify(ids), max, now]);
  const usage = answer.reply.usage;
  const used = usage?.usd_micros ?? (answer.reply.error_kind === 'budget' || answer.reply.error_kind === 'price_unavailable' || answer.reply.error_kind === 'provider_unavailable' || answer.reply.error_kind === 'invalid_call' ? 0 : reserved);
  await reviewWrite(unguarded, 'UPDATE review_judgments SET state=?,raw=?,used=?,usage_json=?,finish_reason=? WHERE id=? AND gen=?', [state, raw ? JSON.stringify(raw) : null, used, JSON.stringify(usage), answer.reply.finish_reason, jid, run.gen]);
  // The only permitted late writes above touch this call's judgment and budget.
  const [current] = await reviewRead(ctx, 'SELECT gen,step FROM review_runs WHERE id=?', [run.id]);
  if (current.gen !== run.gen || current.step !== run.step) throw new LostLease();
    if (state === 'truncated' && ids.length > 1) {
    const half = Math.ceil(ids.length / 2); retries.queue = [ids.slice(0, half), ids.slice(half), ...(retries.queue ?? [])];
  }
  stats[role + '_retry'] = retries.queue?.length ? retries : null;
  if (answer.reply.error_kind === 'budget') {
    stats[role + '_budget_deferred'] = true;
    await advance(ctx, run, stats, primary ? 'second' : 'apply', now); return;
  }
  const writes: ReviewStatement[] = [{ sql: 'UPDATE review_runs SET judge_calls=judge_calls+1,model=COALESCE(model,?),second_model=CASE WHEN ?=\'second\' THEN ? ELSE second_model END WHERE id=? AND step=? AND gen=?', params: [primary ? model : null, role, model, run.id, run.step, run.gen] }];
  const rejected = raw?.rejects ?? [];
  if (rejected.length) writes.push({ sql: `INSERT OR IGNORE INTO review_rejects(id,run_id,reason,raw,created_at) SELECT ?||':'||key,?,json_extract(value,'$.reason'),value,? FROM json_each(?)`, params: [jid, run.id, now, JSON.stringify(rejected)] });
  if (primary) {
    const attempt = Math.max(...rows.filter(r => ids.includes(r.id)).map(r => Number(r.attempts))) + 1;
    writes.push({ sql: `UPDATE review_traces SET attempts=attempts+1,state=CASE WHEN ?!='ok' AND attempts>=1 THEN 'judge_failed' ELSE state END WHERE id IN (SELECT value FROM json_each(?)) AND state='pending'`, params: [state, JSON.stringify(ids)] });

  } else if (state === 'truncated') {
    // Single-trace truncation is a second-judge failure, not a bot finding.
    if (ids.length === 1) writes.push({ sql: "UPDATE review_judgments SET state='error' WHERE id=?", params: [jid] });
  }
  await advance(ctx, run, stats, run.step, now, writes);
}
async function imageSources(e: Env, traces: Trace[]) {
  const ids = [...new Set(traces.flatMap(t => [...(t.inbound ? [t.inbound] : []), ...t.context_before, ...t.after].filter(m => m.images?.length).map(m => m.id)))];
  if (!ids.length) return [];
  const rows = await reviewRead(e, 'SELECT id,json FROM message_meta WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]);
  return rows.flatMap(row => (parse(row.json).attachments ?? []).map((a: any, idx: number) => ({ message_id: row.id, idx, url: a.url }))).filter(a => typeof a.url === 'string');
}
const PUBLISH_PHASES = ['requirements', 'promises', 'tasks', 'rules', 'learnings', 'report'];
async function publishTick(e: Env, run: Row, stats: Row, now: number, options: TickOptions = {}) {
  if (stats.plan) { await planTick(e, run, stats, now, async () => [], ''); return; }
  // 旧 run（或未来版本写的未知子阶段）不再跑新阶段，直接收尾到 done；不拿新规则改写历史。
  if (stats.phase && !PUBLISH_PHASES.includes(stats.phase)) stats.phase = undefined;
  if (stats.phase === 'requirements') {
    const judgments = await reviewRead(e, "SELECT raw FROM review_judgments WHERE run_id=? AND role='primary' AND state='ok' ORDER BY created_at,id", [run.id]);
    const reqs = judgments.flatMap(j => parse(j.raw).requirements ?? []), offset = stats.requirement_offset ?? 0;
    if (run.mode === 'full' && offset < reqs.length) {
      stats.requirement_offset = offset + 1;
      await planTick(e, run, stats, now, () => capture(e, ctx => applyRequirements(ctx, { id: run.id, group_id: run.group_id, now }, [reqs[offset]])), 'requirements'); return;
    }
    stats.phase = 'promises'; await advance(e, run, stats, 'publish', now);
  } else if (stats.phase === 'promises') {
    await planTick(e, run, stats, now, () => run.mode === 'shadow' ? Promise.resolve([]) : capture(e, ctx => checkPromises(ctx, { id: run.id, group_id: run.group_id, gen: run.gen, now })), 'tasks');
  } else if (stats.phase === 'tasks') {
    await planTick(e, run, stats, now, () => run.mode === 'shadow' ? Promise.resolve([]) : capture(e, ctx => proposeTasks(ctx, { id: run.id, group_id: run.group_id, gen: run.gen, now })), 'rules');
  } else if (stats.phase === 'rules') {
    await planTick(e, run, stats, now, () => run.mode === 'full' ? capture(e, ctx => advanceRules(ctx, { id: run.id, group_id: run.group_id, now })) : Promise.resolve([]), 'learnings');
  } else if (stats.phase === 'learnings') {
    await learningsPhase(e, run, stats, now, extra => advance(e, run, stats, run.step, now, extra));
  } else if (stats.phase === 'report') {
    const report = await reportPhase(e, run, stats, now, options);
    stats.report = report.skipped ? { state: 'skipped', reason: report.skipped } : { state: 'ready', id: report.id, items: report.items.length };
    await finishRun(e, run, stats, now, report.statements);
  } else await finishRun(e, run, stats, now);
}
async function finishRun(e: Env, run: Row, stats: Row, now: number, extra: ReviewStatement[] = []) {
  const [unfinished] = await reviewRead(e, "SELECT COUNT(*) AS n FROM review_traces WHERE state='pending' AND (run_id=? OR id IN(SELECT value FROM json_each(?)))", [run.id,JSON.stringify(stats.review_targets ?? [])]);
  stats.unreviewed = Number(unfinished.n);
  const spend = await reviewRead(e, 'SELECT provider,SUM(used) AS used FROM review_judgments WHERE run_id=? GROUP BY provider', [run.id]);
  const spendJson = Object.fromEntries(spend.map(r => [r.provider, r.used ?? 0]));
  await advance(e, run, stats, 'done', now, [...extra, { sql: 'UPDATE review_runs SET spend_json=? WHERE id=? AND step=? AND gen=?', params: [JSON.stringify(spendJson), run.id, run.step, run.gen] }, { sql: `UPDATE review_cursors SET judged_at=built_at,judged_id=built_id,updated_at=? WHERE group_id=? AND NOT EXISTS(SELECT 1 FROM review_traces WHERE group_id=? AND state NOT IN ('judged','skipped','expired'))`, params: [now, run.group_id, run.group_id] }]);
}

async function identity(r: Request, e: Env) {
  const token = r.headers.get('Authorization')?.replace(/^Bearer /, '') || '';
  if (!token) return null;
  const hash = await sha(token), now = Date.now();
  if (e.ADMIN_TOKEN && hash === await sha(e.ADMIN_TOKEN)) return { id: 'owner', role: 'owner' };
  // src/accounts.ts aiIdentity SELECT only: reads must never update last_used.
  if (token.startsWith('teamai_')) return e.DB.prepare("SELECT m.id,m.name,'member' AS role FROM ai_tokens a JOIN members m ON m.id=a.member_id WHERE a.token_hash=? AND a.revoked=0 AND a.expires>? AND m.revoked=0 AND EXISTS(SELECT 1 FROM member_passwords p WHERE p.member_id=m.id)").bind(hash, now).first();
  const session = await e.DB.prepare("SELECT m.id,m.name,m.role FROM member_sessions s JOIN members m ON m.id=s.member_id WHERE s.token_hash=? AND s.expires>? AND m.revoked=0 AND (NOT EXISTS(SELECT 1 FROM settings WHERE key='auth_mode' AND value='names') OR EXISTS(SELECT 1 FROM member_passwords p WHERE p.member_id=m.id))").bind(hash, now).first();
  return session || e.DB.prepare("SELECT id,name,role FROM members WHERE token_hash=? AND revoked=0 AND NOT EXISTS(SELECT 1 FROM settings WHERE key='auth_mode' AND value='names')").bind(hash).first();
}
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
async function gapsFor(e: Env) {
  return reviewRead(e, 'SELECT g.*,t.title AS task_title FROM capability_gaps g LEFT JOIN tasks t ON t.id=g.task_id ORDER BY g.last_seen DESC,g.fingerprint LIMIT 100');
}
async function boardDigest(e: Env, dates: string[]) {
  const runs = await reviewRead(e, 'SELECT * FROM review_runs WHERE date IN (SELECT value FROM json_each(?)) ORDER BY date DESC,group_id', [JSON.stringify(dates)]);
  const ids = JSON.stringify(runs.map(r => r.id));
  const findings = await reviewRead(e, `SELECT f.*,t.trace_json,m.rowid AS inbound_rowid,m.ts AS inbound_ts,m.sender,m.body,mem.name AS sender_name
    FROM review_findings f LEFT JOIN review_traces t ON t.id=f.trace_id LEFT JOIN messages m ON m.id=t.inbound_id LEFT JOIN members mem ON mem.id=m.sender OR mem.id='qq:'||m.sender
    WHERE f.run_id IN (SELECT value FROM json_each(?)) ORDER BY f.created_at DESC,f.id`, [ids]);
  const evidenceIds = JSON.stringify([...new Set(findings.flatMap(f => parse(f.evidence_json, []).filter((v: any) => ['message', 'outbox'].includes(v.source)).map((v: any) => v.id)))]);
  const sources = await reviewRead(e, "SELECT 'message' AS source,id,rowid FROM messages WHERE id IN (SELECT value FROM json_each(?)) UNION ALL SELECT 'outbox' AS source,id,rowid FROM outbox WHERE id IN (SELECT value FROM json_each(?))", [evidenceIds, evidenceIds]);
  const rowids = new Map(sources.map(r => [r.source + ':' + r.id, r.rowid]));
  const rejects = await reviewRead(e, 'SELECT run_id,COUNT(*) AS n FROM review_rejects WHERE run_id IN (SELECT value FROM json_each(?)) GROUP BY run_id', [ids]);
  const failed = await reviewRead(e, "SELECT run_id,COUNT(*) AS n FROM review_traces WHERE run_id IN(SELECT value FROM json_each(?)) AND state='judge_failed' GROUP BY run_id", [ids]);
  const budget = await reviewRead(e, 'SELECT * FROM review_budget WHERE day_utc>=? ORDER BY day_utc DESC,provider', [dates.at(-1) ?? sydneyTime(Date.now()).date]);
  const gaps = await gapsFor(e), rules = await reviewRead(e, "SELECT * FROM behavior_rules WHERE status!='retired' OR updated_at>=? ORDER BY updated_at DESC,id", [Date.now() - 30 * DAY]);
  const memories = await reviewRead(e, 'SELECT * FROM review_memory_candidates WHERE run_id IN(SELECT value FROM json_each(?)) ORDER BY created_at,id', [ids]);
  const traces = await reviewRead(e, 'SELECT id,run_id,signals FROM review_traces WHERE run_id IN(SELECT value FROM json_each(?))', [ids]);
  const promises = await reviewRead(e, "SELECT * FROM promises WHERE group_id IN(SELECT group_id FROM review_runs WHERE id IN(SELECT value FROM json_each(?))) AND status IN ('broken','cannot','expired')", [ids]);
  const monthly = await reviewRead(e, "SELECT COALESCE(SUM(used),0) AS used FROM review_budget WHERE unit='usd_micros' AND substr(day_utc,1,7)=?", [(dates[0] ?? sydneyTime(Date.now()).date).slice(0,7)]);
  const days = dates.filter(date => runs.some(r => r.date === date)).map(date => {
    const dailyRuns = runs.filter(r => r.date === date), runIds = new Set(dailyRuns.map(r => r.id));
    const list = findings.filter(f => runIds.has(f.run_id)).map(f => {
      const { trace_json, inbound_rowid, inbound_ts, sender, body, sender_name, evidence_json, ...rest } = f;
      const inbound = parse(trace_json).inbound;
      return { ...rest, dimensions: parse(f.dimensions), evidence: parse(evidence_json, []).map((v: any) => ({ ...v, rowid: rowids.get(v.source + ':' + v.id) ?? null })),
        inbound: inbound ? { id: inbound.id, rowid: inbound_rowid ?? null, ts: inbound_ts ?? inbound.ts, sender_name: clean(sender_name ?? sender ?? inbound.sender), body_excerpt: clean(body ?? inbound.body).slice(0, 120) } : null };
    });
    const agreement = { agree: 0, disagree: 0, single: 0, pending: 0, rate: null as number | null };
    for (const f of list) if (f.agreement in agreement) (agreement as any)[f.agreement]++;
    if (agreement.agree + agreement.disagree) agreement.rate = agreement.agree / (agreement.agree + agreement.disagree);
    const cover = dailyRuns.map(r => ({ run_id: r.id, group_id: r.group_id, ...parse(r.stats).coverage }));
    const dailyMemory = memories.filter(m => runIds.has(m.run_id));
    const memoryCandidates = dailyMemory.map(m => ({
      id: m.id, op: m.op, repo: clean(m.repo), subject: clean(m.subject), predicate: clean(m.predicate), value: clean(m.value),
      state: m.status, status: m.status, target_version: m.target_version, created_at: m.created_at,
      evidence: parse(m.evidence_json, []).map((v: any) => ({
        source: v.source, id: v.id, quote: clean(v.quote), ...(v.origin ? { origin: v.origin } : {}),
        ...(v.image ? { image: { message_id: v.image.message_id, idx: v.image.idx, sha: v.image.sha } } : {}),
      })),
    }));
    const dailyRules = rules.filter(r => sydneyTime(r.created_at).date === date);
    const unanswered = traces.filter(t => runIds.has(t.run_id) && parse(t.signals, []).includes('S1'));
    const dailyPromises = promises.filter(p => sydneyTime(p.checked_at ?? p.created_at).date === date);
    const first = dailyRuns[0], errors = rejects.filter(r => runIds.has(r.run_id)).reduce((a, r) => a + r.n, 0);
    return { date, group_id: first.group_id, group_label: first.group_id, groups: dailyRuns.map(r => ({ group_id: r.group_id, run_id: r.id, step: r.step, mode: r.mode })),
      run: { step: first.step, mode: first.mode, model: first.model, second_model: first.second_model, same_family: first.same_family, judge_calls: first.judge_calls, unreviewed: Number(parse(first.stats).unreviewed ?? 0), completion_note: parse(first.stats).unreviewed ? `未评完 ${parse(first.stats).unreviewed} 条` : '', error: first.error, updated_at: first.updated_at, spend: parse(first.spend_json) },
      answers: { failures: list.map(f => f.what_happened).join('；').slice(0, 120), requirements: dailyRules.map(r => r.rule).join('；').slice(0,120), memory: dailyMemory.map(m => (m.op === 'DELETE' ? '不再记住：' : '待记住：') + m.subject + m.value).join('；').slice(0,120), unanswered: [unanswered.length ? `${unanswered.length} 条待回答` : '', parse(first.stats).unreviewed ? `未评完 ${parse(first.stats).unreviewed} 条` : ''].filter(Boolean).join('；'), changes: gaps.map(g => g.proposed_action).join('；').slice(0, 120) },
      precision: { accepted: list.filter(f => f.status === 'accepted').length, rejected: list.filter(f => f.status === 'rejected').length, open: list.filter(f => ['open','disputed'].includes(f.status)).length, rejects: errors },
      findings: list, memory_candidates: memoryCandidates, new_gaps: gaps.filter(g => sydneyTime(g.first_seen).date === date).length, promises_broken: dailyPromises,
      coverage: { balanced: cover.every(balanced), runs: cover, unaccounted: cover.reduce((sum, c) => sum + Number(c.unaccounted ?? 0), 0) }, budget: { providers: budget.filter(b => b.day_utc <= date && b.day_utc >= new Date(Date.parse(date) - DAY).toISOString().slice(0,10)), monthly_usd_micros: monthly[0]?.used ?? 0, month_cap_usd_micros: Number(e.REVIEW_MONTH_CAP_USD_MICROS ?? 10000000) }, agreement,
      judge_failed: failed.filter(r => runIds.has(r.run_id)).reduce((sum, r) => sum + r.n, 0), disputed: list.filter(f => f.status === 'disputed').length };
  });
  return { days, gaps, rules };
}
async function fetchReview(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('Origin'), allowed = env.REVIEW_BOARD_ORIGIN ?? 'https://inkboard-team.inkboard-server.workers.dev';
  let response: Response;
  if (origin && origin !== allowed) return json({ error: 'origin_forbidden' }, 403);
  if (request.method === 'OPTIONS') response = new Response(null, { status: 204 });
  else {
    const e = bounded(env);
    try {
      const who = await identity(request, e);
      if (!who) response = json({ error: 'unauthorized' }, 401);
      else {
        const url = new URL(request.url), path = url.pathname;
        if (request.method === 'GET' && path === '/review/health') {
          const tables = await reviewRead(e, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('turn_tools','turn_offers','review_runs','review_cursors','review_snapshots','review_traces','review_judgments','review_budget','review_findings','review_rejects','review_consumed','capability_gaps','behavior_rules','review_memory_candidates','promises','review_probes')");
          const [last] = await reviewRead(e, 'SELECT date,step,updated_at FROM review_runs ORDER BY updated_at DESC LIMIT 1');
          const settings = Object.fromEntries((await reviewRead(e, "SELECT key,value FROM settings WHERE key IN ('off:review','review:mode')")).map(r => [r.key, r.value]));
          response = json({ ok: tables.length === 16, release: env.RELEASE ?? 'development', migration: tables.length === 16 ? '0008' : null, last_run: last ?? null,
            mode: settings['review:mode'] ?? env.REVIEW_MODE ?? 'shadow', off: settings['off:review'] === '1' }, tables.length === 16 ? 200 : 503);
        } else if (request.method === 'GET' && (path === '/review/digest' || path === '/review/backlog.md')) {
          const date = url.searchParams.get('date') ?? sydneyTime(Date.now()).date, days = url.searchParams.get('days');
          if (!validDate(date) || (days !== null && (!/^[1-7]$/.test(days)))) response = json({ error: 'invalid_date_or_days' }, 400);
          else if (path.endsWith('.md')) {
            const tasks = await reviewRead(e, "SELECT t.detail FROM tasks t JOIN capability_gaps g ON g.task_id=t.id WHERE t.source_id LIKE 'review:%' AND EXISTS(SELECT 1 FROM review_runs r WHERE r.date=? AND r.step='done') ORDER BY g.last_seen DESC LIMIT 100", [date]);
            response = new Response(tasks.length ? tasks.map(t => clean(t.detail)).join('\n\n---\n\n') : '# 能力缺口提案（gap:v1）\n\n暂无提案。\n', { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
          } else {
            const dates = days ? (await reviewRead(e, 'SELECT DISTINCT date FROM review_runs WHERE date<=? ORDER BY date DESC LIMIT ?', [date, Number(days)])).map(r => r.date) : [date];
            const board = await boardDigest(e, dates);
            // Preserve D-5a's detailed single-day digest and add the board fields.
            if (!days) {
              const detail = await renderDigest(e, date), memoryCandidates = board.days[0]?.memory_candidates ?? [];
              response = json({ ...detail, ...board.days[0], gaps: board.gaps, rules: board.rules, date, findings: board.days[0]?.findings ?? [],
                memory_candidates: memoryCandidates, questions: { ...detail.questions, memory: { ...detail.questions.memory, candidates: memoryCandidates } } });
            }
            else response = json(board);
          }
        } else if (request.method === 'PATCH' && /^\/review\/(finding|rule|memory)\/[^/]+$/.test(path)) {
          if (!['admin', 'owner'].includes(who.role)) response = json({ error: 'admin_required' }, 403);
          else {
            const [, , kind, encoded] = path.split('/'), id = decodeURIComponent(encoded);
            if (Number(request.headers.get('Content-Length') ?? 0) > 4096) return json({ error: 'body_too_large' }, 413);
            const bodyText = await request.text(); if (bodyText.length > 4096) return json({ error: 'body_too_large' }, 413);
            const body = parse(bodyText, null), table = { finding: 'review_findings', rule: 'behavior_rules', memory: 'review_memory_candidates' }[kind]!;
            const [row] = await reviewRead(e, `SELECT * FROM ${table} WHERE id=?`, [id]);
            if (!row) response = json({ error: 'not_found' }, 404);
            else if (!body || typeof body.status !== 'string') response = json({ error: 'invalid_status' }, 400);
            else if (kind === 'finding' && ['accepted', 'rejected', 'open'].includes(body.status)) {
              const result = await reviewWrite(e, "UPDATE review_findings SET status=?,reviewed_by=?,reviewed_at=? WHERE id=? AND status IN ('open','disputed','accepted','rejected')", [body.status, who.id, Date.now(), id]);
              response = json({ ok: changes(result) === 1 }, changes(result) === 1 ? 200 : 409);
            } else if (kind === 'rule' && body.status === 'canary') {
              const ok = await approveRule(e, id, who.id); response = json({ ok }, ok ? 200 : 409);
            } else if (kind === 'rule' && body.status === 'retired' && typeof body.reason === 'string' && body.reason.trim().length >= 1 && body.reason.length <= 200) {
              response = json({ ok: await revokeRule(e, id, who.id, body.reason.trim()) });
            } else if (kind === 'memory' && ['approved', 'rejected'].includes(body.status)) {
              const scope = await reviewRead(e, 'SELECT id FROM review_runs WHERE id=? AND group_id=?', [row.run_id, row.group_id]);
              if (!scope.length) return json({ error: 'invalid_group_scope' }, 409);
              if (body.status === 'approved') {
                const fact_id = await applyMemoryCandidate(e, id, who.id); response = json({ ok: !!fact_id, fact_id }, fact_id ? 200 : 409);
              } else {
                const result = await reviewWrite(e, "UPDATE review_memory_candidates SET status='rejected',reviewed_by=?,reviewed_at=? WHERE id=? AND status IN ('candidate','approved')", [who.id, Date.now(), id]);
                response = json({ ok: changes(result) === 1 }, changes(result) === 1 ? 200 : 409);
              }
            } else response = json({ error: 'invalid_status' }, 400);
          }
        } else response = json({ error: 'not_found' }, 404);
      }
    } catch { response = json({ error: 'review_request_failed' }, 500); }
  }
  if (origin === allowed) {
    response.headers.set('Access-Control-Allow-Origin', allowed); response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS'); response.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  }
  return response;
}
export default {
  async scheduled(controller: { scheduledTime?: number }, e: Env) {
    // No environment-based clock override, even in a local deployment.
    return reviewTick(e, { now: () => controller.scheduledTime ?? Date.now() });
  }, fetch: fetchReview,
};
