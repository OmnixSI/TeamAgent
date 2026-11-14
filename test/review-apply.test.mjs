import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, rmSync, existsSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { env } from './support.mjs';

const output = `.wrangler/review-apply-${process.pid}.mjs`;
await build({
  stdin: { contents: "export * from './src/review/apply.ts'; export * from './src/review/publish.ts'; export * from './src/review/rules.ts';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', outfile: output,
});
const api = await import('../' + output);
rmSync(output);
const { applyJudgment, applyPromises, checkPromises, proposeTasks, renderDigest } = api;

const migration = readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
const now = Date.parse('2026-11-14T00:00:00Z');
const day = 86400000;
const group = 'g';
const runAt = (id = 'g:2026-11-14', at = now, gen = 1) => ({ id, group_id: group, gen, now: at });

// A tiny D1-shaped adapter for node:sqlite. It can inject a fault after N
// statements in a batch so the idempotency tests exercise partial writes.
function rawEnv(db, { failAfter = Infinity, batches = [], sqls = [] } = {}) {
  let executed = 0, seen = 0;
  const prepare = (sql) => {
    const make = (args = []) => ({
      sql,
      bind(...values) { return make(values.map(v => v instanceof ArrayBuffer ? new Uint8Array(v) : v)); },
      async first() { executed++; sqls.push(sql); const stmt = db.prepare(sql); const value = typeof stmt.bind === 'function' ? await stmt.bind(...args).get() : await stmt.get(...args); return value ?? null; },
      async all() { executed++; sqls.push(sql); const stmt = db.prepare(sql); const value = typeof stmt.bind === 'function' ? await stmt.bind(...args).all() : await stmt.all(...args); const rows = Array.isArray(value) ? value : Array.isArray(value?.results) ? value.results : []; return { results: rows }; },
      async run() { executed++; sqls.push(sql); const stmt = db.prepare(sql); return typeof stmt.bind === 'function' ? await stmt.bind(...args).run() : await stmt.run(...args); },
    });
    return make();
  };
  const database = {
    get executed() { return executed; },
    prepare,
    async batch(statements) {
      batches.push(statements.length);
      const results = [];
      for (const statement of statements) {
        if (seen++ >= failAfter) throw new Error('injected fault');
        results.push(await statement.run());
      }
      return results;
    },
  };
  return { DB: database };
}

function seedEnv(seedPath) {
  const db = new DatabaseSync(seedPath);
  return { e: rawEnv(db), db };
}

async function setup() {
  const e = env();
  for (const sql of migration.split(';').filter(s => s.trim())) await e.DB.prepare(sql).run();
  await e.DB.prepare("INSERT INTO members(id,name,token_hash) VALUES('bound','成员','fake')").run();
  return e;
}
const get = (e, sql, ...params) => e.DB.prepare(sql).bind(...params).first();
const all = (e, sql, ...params) => e.DB.prepare(sql).bind(...params).all().then(r => r.results);

async function message(e, id, body, { sender = 'bound', at = now, mentioned = 1, meta = null } = {}) {
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)')
    .bind(id, group, sender, body, new Date(at).toISOString(), mentioned).run();
  if (meta) await e.DB.prepare('INSERT INTO message_meta(id,json) VALUES(?,?)').bind(id, JSON.stringify(meta)).run();
}
async function outbox(e, id, body, { at = now } = {}) {
  await e.DB.prepare('INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)')
    .bind(id, group, null, body, 'sent', at).run();
}
async function addRun(e, { id = 'g:2026-11-14', date = '2026-11-14', gen = 1, stats = {} } = {}) {
  await e.DB.prepare(`INSERT OR REPLACE INTO review_runs(id,group_id,date,step,window_start,window_end,mode,stats,gen,updated_at)
    VALUES(?,?,?,'apply',?,?,'propose',?,?,?)`).bind(id, group, date, new Date(now - day).toISOString(), new Date(now).toISOString(), JSON.stringify(stats), gen, now).run();
}
async function addTrace(e, runId, id, { signals = [], state = 'pending' } = {}) {
  await e.DB.prepare(`INSERT INTO review_traces(id,run_id,group_id,kind,state,trace_json,created_at) VALUES(?,?,?,'inbound',?,?,?)`)
    .bind(id, runId, group, state, JSON.stringify({ id, signals }), now).run();
}
async function addJudgment(e, { id, runId = 'g:2026-11-14', gen = 1, role = 'primary', state = 'ok', raw, provider = 'deepseek', model = 'deepseek-flash', traceIds = [] }) {
  await e.DB.prepare(`INSERT INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,state,reserved,max_tokens,raw,created_at)
    VALUES(?,?,?,?,?,?,?,?,0,4096,?,?)`).bind(id, runId, gen, role, provider, model, JSON.stringify(traceIds), state, JSON.stringify(raw), now).run();
}
const dims = (over = {}) => ({ answered: 'UNSATISFIED', facts: 'SATISFIED', tool_choice: 'UNSATISFIED', memory: 'SATISFIED', expression: 'SATISFIED', boundary: 'SATISFIED', ...over });
const verdict = (trace_id, over = {}) => ({
  trace_id, reasoning: '有证据', dimensions: dims(), failure_type: 'reasoning.decision.tool_selection', severity: 'p1',
  fix_layer: 'tool_impl', gap_type: 'tool_missing', capability: 'scheduling', should_use_tool: 'none',
  evidence: [{ source: 'message', id: 'm1', quote: '我的日报呢', origin: 'direct' }],
  what_happened: '没有回答', expected: '给出可核对结果', root_cause: '没有调度能力', next_attempt_plan: '补调度',
  confidence: 0.8, kind: 'capability_gap', ...over,
});
const result = (verdicts, extra = {}) => ({
  schema: 'ta.review.result.v2', verdicts, requirements: [], memory_updates: [], promises: [], no_action: [], ...extra,
});
const sverdict = (trace_id, over = {}) => ({
  trace_id, verdict: 'issue', failure_type: 'reasoning.decision.tool_selection', gap_type: 'tool_missing', severity: 'p1',
  dimensions: dims(), evidence: [{ source: 'message', id: 'm1', quote: '我的日报呢' }], reason: '复核', confidence: 0.8, ...over,
});
const second = (verdicts) => ({ schema: 'ta.review.second.v1', verdicts });

async function seedOne(e, { p0 = false } = {}) {
  await message(e, 'm1', '你妈的，我的日报呢？');
  await addRun(e);
  await addTrace(e, 'g:2026-11-14', 't1');
  await addJudgment(e, {
    id: 'j1', traceIds: ['t1'],
    raw: result([verdict('t1', { severity: p0 ? 'p0' : 'p1', dimensions: dims(p0 ? { facts: 'UNSATISFIED' } : {}) })]),
  });
}

test('rerunning apply and publish is idempotent for findings, gaps, tasks and hits', async () => {
  const e = await setup();
  await seedOne(e, { p0: true });
  await e.DB.prepare("INSERT INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,status,expires_at,created_at,updated_at) VALUES('r1',?, '回复最多200字。','回答','[]','review:x','active',?,?,?)").bind(group, now + day, now, now).run();
  await e.DB.prepare("INSERT INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('rule_hit','r1','hit1','old',?)").bind(now).run();
  const first = await applyJudgment(e, runAt(), 'j1');
  assert.equal(first.consumed, true);
  assert.equal(first.findings, 1);
  const tasks1 = await all(e, 'SELECT * FROM tasks');
  const gaps1 = await all(e, 'SELECT * FROM capability_gaps');
  assert.equal(tasks1.length, 1);
  assert.equal(gaps1.length, 1);
  assert.equal(gaps1[0].occurrences, 1);
  assert.match(tasks1[0].id, /^rv-[0-9a-f]{16}$/);
  assert.equal(tasks1[0].source_id, 'review:' + gaps1[0].fingerprint);
  assert.match(tasks1[0].title, /^\[复盘\]/);
  assert.match(tasks1[0].detail, /「我的日报呢」/);
  assert.match(tasks1[0].detail, /messages\.rowid=1/);
  assert.equal((await get(e, "SELECT state FROM review_traces WHERE id='t1'")).state, 'judged');

  const again = await applyJudgment(e, runAt(), 'j1');
  assert.equal(again.consumed, false);
  assert.equal(again.findings, 0);
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 1);
  assert.equal((await get(e, 'SELECT occurrences FROM capability_gaps')).occurrences, 1);
  assert.equal((await get(e, "SELECT hits FROM behavior_rules WHERE id='r1'")).hits, 1);
  await proposeTasks(e, runAt());
  await proposeTasks(e, runAt());
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 1);
});

test('a fault after every write statement leaves no duplicate after retry', async () => {
  // Count the statements a clean run executes, then inject a fault after each prefix.
  const probeBase = await setup();
  await seedOne(probeBase, { p0: true });
  const batches = [];
  const probe = rawEnv(probeBase.DB, { batches });
  await applyJudgment(probe, runAt(), 'j1');
  const total = batches.reduce((n, size) => n + size, 0);
  assert.ok(total > 0);
  for (let cut = 0; cut < total; cut++) {
    const fresh = await setup();
    await seedOne(fresh, { p0: true });
    const faulty = rawEnv(fresh.DB, { failAfter: cut });
    await assert.rejects(() => applyJudgment(faulty, runAt(), 'j1'));
    await applyJudgment(fresh, runAt(), 'j1');
    assert.equal((await all(fresh, 'SELECT * FROM review_findings')).length, 1, `cut ${cut}`);
    assert.equal((await all(fresh, 'SELECT * FROM tasks')).length, 1, `cut ${cut}`);
    assert.equal((await get(fresh, 'SELECT occurrences FROM capability_gaps')).occurrences, 1, `cut ${cut}`);
  }
});

test('more than 48 statements paginate and resume from the last committed page', async () => {
  const buildLarge = async () => {
    const e = await setup();
    await message(e, 'm1', '你妈的，我的日报呢？');
    await addRun(e);
    const verdicts = [];
    for (let i = 0; i < 12; i++) {
      await addTrace(e, 'g:2026-11-14', `t${i}`);
      verdicts.push(verdict(`t${i}`, { capability: `other:c${i}`, severity: 'p1' }));
    }
    await addJudgment(e, { id: 'j1', traceIds: verdicts.map(v => v.trace_id), raw: result(verdicts) });
    return e;
  };

  const clean = await buildLarge();
  const r = await applyJudgment(clean, runAt(), 'j1');
  assert.equal(r.consumed, true);
  assert.equal(r.findings, 12);
  assert.equal((await all(clean, 'SELECT * FROM review_findings')).length, 12);
  assert.equal((await all(clean, "SELECT * FROM review_consumed WHERE kind='apply_page'")).length, 2);

  // Let page 0 commit (48 statements including its marker), then fail at the
  // first statement of page 1. The retry must skip page 0 and finish the rest.
  const broken = await buildLarge();
  const faulty = rawEnv(broken.DB, { failAfter: 48 });
  await assert.rejects(() => applyJudgment(faulty, runAt(), 'j1'));
  assert.equal((await all(broken, 'SELECT * FROM review_findings')).length, 12);
  assert.equal((await all(broken, 'SELECT * FROM review_judgments')).length, 1);
  assert.equal((await get(broken, 'SELECT consumed_at FROM review_judgments')).consumed_at, null);
  const retry = await applyJudgment(broken, runAt(), 'j1');
  assert.equal(retry.consumed, true);
  assert.equal(retry.findings, 0);
  assert.equal((await all(broken, 'SELECT * FROM review_findings')).length, 12);
  assert.equal((await all(broken, 'SELECT * FROM capability_gaps')).length, 12);
});

test('two ticks consuming the same judgment do not duplicate rows', async () => {
  const e = await setup();
  await seedOne(e, { p0: true });
  const results = await Promise.allSettled([applyJudgment(e, runAt(), 'j1'), applyJudgment(e, runAt(), 'j1')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal((await all(e, 'SELECT * FROM review_findings')).length, 1);
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 1);
  assert.equal((await get(e, 'SELECT occurrences FROM capability_gaps')).occurrences, 1);
  assert.equal((await get(e, 'SELECT consumed_at FROM review_judgments WHERE id=?', 'j1')).consumed_at != null, true);
});

test('a late judgment from an older generation is consumed once', async () => {
  const e = await setup();
  await seedOne(e, { p0: true });
  const r = await applyJudgment(e, runAt('g:2026-11-14', now, 99), 'j1');
  assert.equal(r.consumed, true);
  assert.equal(r.findings, 1);
  assert.equal((await get(e, 'SELECT occurrences FROM capability_gaps')).occurrences, 1);
});

test('disputed findings do not create tasks, rules or memory candidates', async () => {
  const e = await setup();
  await message(e, 'm1', '你妈的，我的日报呢？');
  await addRun(e);
  await addTrace(e, 'g:2026-11-14', 't1');
  await addJudgment(e, { id: 'j1', traceIds: ['t1'], raw: result([verdict('t1', { severity: 'p0' })], { memory_updates: [{ op: 'ADD', repo: 'OmnixSI/TeamAgent', subject: 'TeamAgent', predicate: 'style', value: '简短', evidence: [{ source: 'message', id: 'm1', quote: '我的日报呢', origin: 'direct' }] }] }) });
  await addJudgment(e, {
    id: 'j2', role: 'second', provider: 'openai', model: 'luna', traceIds: ['t1'],
    raw: second([sverdict('t1', { verdict: 'pass', failure_type: null, gap_type: null })]),
  });
  await applyJudgment(e, runAt(), 'j1');
  await applyJudgment(e, runAt(), 'j2');
  const finding = await get(e, 'SELECT * FROM review_findings');
  assert.equal(finding.status, 'disputed');
  assert.equal(finding.agreement, 'disagree');
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 0);
  assert.equal((await all(e, 'SELECT * FROM behavior_rules')).length, 0);
  assert.equal((await all(e, 'SELECT * FROM review_memory_candidates')).length, 0);
});

test('single agreement creates only p0 tasks, never p1', async () => {
  const e = await setup();
  await message(e, 'm1', '你妈的，我的日报呢？');
  await addRun(e);
  await addTrace(e, 'g:2026-11-14', 't1');
  await addTrace(e, 'g:2026-11-14', 't2');
  await addJudgment(e, {
    id: 'j1', traceIds: ['t1', 't2'],
    raw: result([
      verdict('t1', { severity: 'p0', dimensions: dims({ facts: 'UNSATISFIED' }) }),
      verdict('t2', { severity: 'p1', evidence: [{ source: 'message', id: 'm1', quote: '我的日报呢', origin: 'direct' }] }),
    ]),
  });
  await applyJudgment(e, runAt(), 'j1');
  const tasks = await all(e, 'SELECT * FROM tasks');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title.includes('scheduling'), true);
  const gaps = await all(e, 'SELECT * FROM capability_gaps');
  assert.equal(gaps[0].occurrences, 2);
  await proposeTasks(e, runAt());
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 1);
});

test('a night never creates more than three proposal tasks', async () => {
  const e = await setup();
  await message(e, 'm1', '你妈的，我的日报呢？');
  await addRun(e);
  const verdicts = [];
  for (let i = 0; i < 4; i++) {
    await addTrace(e, 'g:2026-11-14', `t${i}`);
    verdicts.push(verdict(`t${i}`, { capability: `other:p${i}`, severity: 'p0', dimensions: dims({ facts: 'UNSATISFIED' }) }));
  }
  await addJudgment(e, { id: 'j1', traceIds: verdicts.map(v => v.trace_id), raw: result(verdicts) });
  await applyJudgment(e, runAt(), 'j1');
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 3);
  await proposeTasks(e, runAt());
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 3);
});

test('memory updates only become candidates and need direct bound evidence', async () => {
  const e = await setup();
  await message(e, 'm1', '这你别管 你目前正式上线的能力都有哪些了 读一下自己仓库', { mentioned: 0, meta: { direct: true } });
  await message(e, 'm2', '以后先给结论', { meta: { direct: true, forwarded: [{ id: 'x' }] } });
  await e.DB.prepare("INSERT INTO facts(id,repo,subject,predicate,value,evidence,source_id,status,valid_from,valid_to) VALUES('f1','OmnixSI/TeamAgent','TeamAgent','repo_visibility','old','e','src','confirmed','2026-01-01T00:00:00Z',NULL)").run();
  const factsBefore = (await all(e, 'SELECT * FROM facts')).length;
  await addRun(e);
  await addTrace(e, 'g:2026-11-14', 't1');
  await addJudgment(e, {
    id: 'j1', traceIds: ['t1'],
    raw: result([verdict('t1')], {
      memory_updates: [
        { op: 'ADD', repo: 'OmnixSI/TeamAgent', subject: 'TeamAgent', predicate: 'repo_visibility', value: '可读取仓库', evidence: [{ source: 'message', id: 'm1', quote: '读一下自己仓库', origin: 'direct' }] },
        { op: 'UPDATE', repo: 'OmnixSI/TeamAgent', subject: 'TeamAgent', predicate: 'repo_visibility', value: '新值', evidence: [{ source: 'message', id: 'm1', quote: '读一下自己仓库', origin: 'direct' }] },
        { op: 'ADD', repo: 'OmnixSI/TeamAgent', subject: 'TeamAgent', predicate: 'style', value: '短', evidence: [{ source: 'message', id: 'm2', quote: '以后先给结论', origin: 'direct' }] },
      ],
    }),
  });
  await applyJudgment(e, runAt(), 'j1');
  assert.equal((await all(e, 'SELECT * FROM facts')).length, factsBefore);
  const candidates = await all(e, 'SELECT * FROM review_memory_candidates ORDER BY op');
  assert.equal(candidates.length, 2);
  assert.equal(candidates.every(c => c.status === 'candidate'), true);
  const update = candidates.find(c => c.op === 'UPDATE');
  assert.equal(update.target_fact_id, 'f1');
  assert.equal(update.target_version, '2026-01-01T00:00:00Z');
});

test('a capability already covered by an external order does not get a new task', async () => {
  const e = await setup();
  await seedOne(e, { p0: true });
  await e.DB.prepare("INSERT INTO capability_gaps(fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,external_ref) VALUES('f5','tool_missing','scheduling',1,?,?,'[]','x','y','open','F5')").bind(now, now).run();
  await applyJudgment(e, runAt(), 'j1');
  await proposeTasks(e, runAt());
  assert.equal((await all(e, 'SELECT * FROM tasks')).length, 0);
});

test('promises are checked on the reviewed day and produce a scheduling gap', async () => {
  const e = await setup();
  await outbox(e, 'o1', '每天 8:00 推送我会做成真正的定时安排', { at: now - 1000 });
  await message(e, 'm1', '你妈的，我的日报呢？');
  const run = runAt('g:2026-11-14', Date.parse('2026-11-13T18:00:00Z'));
  await addRun(e, { id: run.id, date: '2026-11-14' });
  const inserted = await applyPromises(e, run, [{ outbox_id: 'o1', quote: '每天 8:00 推送我会做成真正的定时安排', what: '每天 8 点推送日报', due: null, recurring: 'daily 08:00' }]);
  assert.equal(inserted, 1);
  await e.DB.prepare('UPDATE promises SET created_at=?').bind(run.now - 2 * day).run();
  const checked = await checkPromises(e, run);
  assert.equal(checked.cannot, 1);
  assert.equal((await get(e, 'SELECT status FROM promises')).status, 'cannot');
  const gap = await get(e, "SELECT * FROM capability_gaps WHERE capability='scheduling'");
  assert.equal(gap.gap_type, 'tool_missing');
  assert.equal(gap.occurrences >= 1, true);
  await checkPromises(e, run);
  assert.equal((await all(e, 'SELECT * FROM promises')).length, 1);
});

test('renderDigest carries the five answers, promises, gaps, rules, budget, coverage and judge failures', async () => {
  const e = await setup();
  await message(e, 'm1', '你妈的，我的日报呢？');
  await addRun(e, { id: 'g:2026-11-14', date: '2026-11-14', stats: { coverage: { messages: 3, inbound_traces: 3, outbox: 1, outbound_traces: 0, outbox_paired: 1, outbox_standalone: 0, skipped_by_rule: 0, unaccounted: 0 } } });
  await addTrace(e, 'g:2026-11-14', 't1', { signals: ['S1'] });
  await addTrace(e, 'g:2026-11-14', 't2', { state: 'judge_failed' });
  await addJudgment(e, { id: 'j1', traceIds: ['t1'], raw: result([verdict('t1', { severity: 'p1' })]) });
  await applyJudgment(e, runAt(), 'j1');
  await e.DB.prepare("INSERT INTO promises(id,group_id,outbox_id,quote,what,due_at,recurring,status,created_at,checked_at) VALUES('p1',?, 'o1','每天 8:00 推送','日报',NULL,'daily 08:00','broken',?,?)").bind(group, now, now).run();
  await e.DB.prepare("INSERT INTO review_budget(day_utc,provider,unit,cap,reserved,used,calls,updated_at) VALUES('2026-11-13','deepseek','usd_micros',100000,1000,5000,3,?)").bind(now).run();
  await e.DB.prepare("INSERT INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,status,expires_at,created_at,updated_at) VALUES('r1',?, '回复最多200字。','回答','[]','review:x','active',?,?,?)").bind(group, now + day, now, now).run();
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('quota:morning',?)").bind(JSON.stringify({ day: '2026-11-14', at: now, line: 'DeepSeek 余额 ¥8.88，低于 ¥10 警戒线。' })).run();
  const digest = await renderDigest(e, '2026-11-14');
  for (const key of ['date', 'groups', 'questions', 'promises', 'gaps', 'rules', 'budget', 'coverage', 'judge_failed', 'disputed', 'agreement', 'tasks', 'findings']) assert.ok(key in digest, key);
  assert.equal(digest.quota?.line, 'DeepSeek 余额 ¥8.88，低于 ¥10 警戒线。');
  assert.equal(digest.judge_failed, 1);
  assert.equal(digest.coverage.balanced, true);
  assert.equal(digest.questions.unanswered.count, 1);
  assert.equal(digest.promises.unfulfilled.length, 1);
  assert.equal(digest.budget.providers[0].provider, 'deepseek');
  assert.equal(digest.agreement.single, 1);
  assert.equal(digest.rules.active, 1);
});

test('apply source contains no task update, job, outbox or facts write', async () => {
  const src = readFileSync(new URL('../src/review/apply.ts', import.meta.url), 'utf8') + readFileSync(new URL('../src/review/publish.ts', import.meta.url), 'utf8');
  for (const pattern of [/UPDATE\s+tasks/i, /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+jobs/i, /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+outbox/i, /UPDATE\s+outbox/i, /INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+facts/i, /occurrences\s*\+\s*1/i, /hits\s*\+\s*1/i, /corrections\s*\+\s*1/i]) {
    assert.equal(pattern.test(src), false, String(pattern));
  }
});

// The replay artifacts live outside the worktree (`.agent/` is not committed).
// Set V_D_REPLAY_DIR to the release replay folder when running this suite.
const replayDir = process.env.V_D_REPLAY_DIR || fileURLToPath(new URL('../../TeamAgent-p4b-login/.agent/releases/V-D-reflection-loop/replay/', import.meta.url));
const seedPath = join(replayDir, 'seed-437.sqlite');
const simNights = existsSync(join(replayDir, 'sim-nights.json')) ? JSON.parse(readFileSync(join(replayDir, 'sim-nights.json'), 'utf8')).nights : [];

test('three simulated nights on the 437 seed produce three digests and <=9 evidenced tasks', { skip: !existsSync(seedPath) }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teamagent-test-review-d5a-'));
  const target = join(dir, 'seed.sqlite');
  copyFileSync(seedPath, target);
  const db = new DatabaseSync(target);
  const e = rawEnv(db);
  try {
    assert.equal(simNights.length, 3);
    const groupId = db.prepare('SELECT group_id FROM messages LIMIT 1').get().group_id;
    const jobsBefore = db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n;
    const msg = (rid) => db.prepare('SELECT id,sender,body,ts FROM messages WHERE rowid=?').get(rid);
    const out = (rid) => db.prepare('SELECT id,body,created_at FROM outbox WHERE rowid=?').get(rid);
    const m355 = msg(355), m434 = msg(434), m95 = msg(95), m419 = msg(419), o206 = out(206), o207 = out(207);
    assert.ok(m355 && m434 && m95 && m419 && o206 && o207);

    const requirementMessage = 'sim-req';
    db.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)')
      .run(requirementMessage, groupId, '0FC1E8A8BD28981E86866125AC3FCEFF', '以后回复先给结论，别啰嗦', '2026-11-11T18:00:00.000Z', 1);
    db.prepare('INSERT INTO message_meta(id,json) VALUES(?,?)')
      .run(requirementMessage, JSON.stringify({ direct: true, attachments: [], forwarded: [], card: null }));

    const coverage = (messages) => ({ messages, inbound_traces: messages, outbox: 1, outbound_traces: 0, outbox_paired: 1, outbox_standalone: 0, skipped_by_rule: 0, unaccounted: 0 });
    const evidence = (source, row, quote) => ({ source, id: row.id, quote, origin: source === 'message' ? 'direct' : 'bot' });
    const v = (trace_id, over = {}) => verdict(trace_id, over);
    const s = (trace_id, over = {}) => sverdict(trace_id, over);
    const nights = [];
    const digests = [];

    async function night(date, at, spec) {
      const runId = `${groupId}:${date}`;
      await addRun(e, { id: runId, date, stats: { coverage: coverage(spec.traces.length) } });
      for (const trace of spec.traces) await addTrace(e, runId, trace.id, { signals: trace.signals ?? [] });
      await addJudgment(e, {
        id: `j-${date}`, runId,
        raw: result(spec.verdicts, {
          requirements: spec.requirements ?? [], memory_updates: spec.memory ?? [], promises: spec.promises ?? [],
        }),
      });
      if (spec.seconds) {
        await addJudgment(e, { id: `js-${date}`, runId, role: 'second', provider: 'openai', model: 'luna', raw: second(spec.seconds) });
      }
      const run = { id: runId, group_id: groupId, gen: 1, now: at };
      await applyJudgment(e, run, `j-${date}`);
      if (spec.seconds) await applyJudgment(e, run, `js-${date}`);
      await checkPromises(e, run);
      await proposeTasks(e, run);
      const digest = await renderDigest(e, date);
      nights.push(runId);
      digests.push(digest);
    }

    const dims = () => ({ answered: 'UNSATISFIED', facts: 'SATISFIED', tool_choice: 'UNSATISFIED', memory: 'SATISFIED', expression: 'SATISFIED', boundary: 'SATISFIED' });

    // Night 1: scheduling (p1), repo visibility (p0), expression (p2, disputed).
    await night(simNights[0].night, Date.parse(simNights[0].utc), {
      traces: [{ id: 't1' }, { id: 't2' }, { id: 't3', signals: ['S1'] }],
      verdicts: [
        v('t1', { severity: 'p1', failure_type: 'planning.task.goal_deviation', evidence: [evidence('message', m355, '我的日报呢')] }),
        v('t2', { severity: 'p0', dimensions: dims({ facts: 'UNSATISFIED' }), fix_layer: 'tool_impl', failure_type: 'reasoning.decision.tool_selection', gap_type: 'tool_not_selected', capability: 'repo_visibility', evidence: [evidence('message', m434, '读一下自己仓库')] }),
        v('t3', { severity: 'p2', failure_type: 'reasoning.output.format', gap_type: null, capability: 'persona_tone', evidence: [evidence('message', m95, '你能不能收敛一点')] }),
      ],
      seconds: [
        s('t1', { failure_type: 'planning.task.goal_deviation', gap_type: 'tool_missing', severity: 'p1', evidence: [evidence('message', m355, '我的日报呢')] }),
        s('t2', { failure_type: 'reasoning.decision.tool_selection', gap_type: 'tool_not_selected', severity: 'p0', evidence: [evidence('message', m434, '读一下自己仓库')] }),
        s('t3', { verdict: 'pass', failure_type: null, gap_type: null, evidence: [evidence('message', m95, '你能不能收敛一点')] }),
      ],
      requirements: [{ kind: 'reply_max_chars', params: { max: 200 }, rule: '', scene: '回答', ttl_days: 7, evidence: [evidence('message', { id: requirementMessage }, '以后回复先给结论')] }],
      memory: [{ op: 'ADD', repo: 'OmnixSI/TeamAgent', subject: 'TeamAgent', predicate: 'repo_visibility', value: '可读取仓库', evidence: [evidence('message', m434, '读一下自己仓库')] }],
    });

    // Night 2: the same scheduling gap occurs again; the bot makes the daily 08:00 promise.
    await night(simNights[1].night, Date.parse(simNights[1].utc), {
      traces: [{ id: 't4' }],
      verdicts: [v('t4', { severity: 'p1', failure_type: 'planning.task.goal_deviation', evidence: [evidence('outbox', o207, '定时推送这次真落地，不再只嘴上说')] })],
      seconds: [s('t4', { failure_type: 'planning.task.goal_deviation', evidence: [evidence('outbox', o207, '定时推送这次真落地，不再只嘴上说')] })],
      promises: [{ outbox_id: o206.id, quote: '每天 8:00 推送我会做成真正的定时安排', what: '每天 8 点推送日报', due: null, recurring: 'daily 08:00' }],
    });

    // Night 3: the promise is checked (misses the 08:00 window) and b23 short links fail.
    await night(simNights[2].night, Date.parse(simNights[2].utc), {
      traces: [{ id: 't5' }, { id: 't6' }],
      verdicts: [
        v('t5', { severity: 'p1', failure_type: 'planning.task.goal_deviation', evidence: [evidence('outbox', o206, '每天 8:00 推送我会做成真正的定时安排')] }),
        v('t6', { severity: 'p0', dimensions: dims({ facts: 'UNSATISFIED' }), failure_type: 'system.api.service', gap_type: 'tool_failed', capability: 'bili_shortlink', fix_layer: 'tool_impl', evidence: [evidence('message', m419, 'b 站短链接都读不了')] }),
      ],
      seconds: [
        s('t5', { failure_type: 'planning.task.goal_deviation', evidence: [evidence('outbox', o206, '每天 8:00 推送我会做成真正的定时安排')] }),
        s('t6', { verdict: 'issue', failure_type: 'system.api', gap_type: 'tool_failed', severity: 'p0', evidence: [evidence('message', m419, 'b 站短链接都读不了')] }),
      ],
    });

    assert.equal(digests.length, 3);
    for (const digest of digests) {
      for (const key of ['date', 'questions', 'promises', 'gaps', 'rules', 'budget', 'coverage', 'judge_failed', 'disputed', 'agreement', 'tasks', 'findings']) assert.ok(key in digest, key);
      assert.equal(digest.coverage.balanced, true);
      for (const question of ['what_went_wrong', 'requirements', 'memory', 'unanswered', 'to_change']) assert.ok(question in digest.questions, question);
    }

    const tasks = db.prepare("SELECT * FROM tasks WHERE source_id LIKE 'review:%' ORDER BY created_at,id").all();
    assert.ok(tasks.length > 0 && tasks.length <= 9, `tasks=${tasks.length}`);
    for (const task of tasks) {
      const quotes = [...task.detail.matchAll(/「([^」]+)」/g)].map(match => match[1]);
      assert.ok(quotes.length > 0, task.id);
      assert.match(task.detail, /(?:messages|outbox)\.rowid=\d+/, task.id);
      for (const quote of quotes) {
        const found = db.prepare("SELECT 1 AS ok FROM messages WHERE body LIKE '%'||?||'%' UNION ALL SELECT 1 AS ok FROM outbox WHERE body LIKE '%'||?||'%' LIMIT 1").get(quote, quote);
        assert.ok(found, `${task.id}: ${quote}`);
      }
    }

    const promises = db.prepare('SELECT * FROM promises').all();
    assert.equal(promises.length, 1);
    assert.equal(['broken', 'cannot'].includes(promises[0].status), true, String(promises[0].status));
    const scheduling = db.prepare("SELECT * FROM capability_gaps WHERE capability='scheduling' AND gap_type='tool_missing'").get();
    assert.ok(scheduling);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM facts').get().n, 47);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n, 3);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_judgments WHERE consumed_at IS NULL').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, jobsBefore);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
