// L4：复盘归纳（review_learnings）+ 晨报（review_reports）。
// 真实原话来自 replay/fixtures（L9 线上只读导出）：TOO 11-13 04:11、Souvereign 11-11 21:09。
// 模型调用全部用录制/确定性桩，不真调；本文件不连线上 D1、不往 QQ 发任何消息。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import {
  setup as workerSetup, seed as workerSeed, finish as workerFinish, fakeFetch, night as workerNight,
} from './review-worker-fixture.mjs';

const OUT = '.wrangler/test-review-report-' + process.pid + '.mjs';
await build({
  stdin: {
    contents: `export * from './src/review/learnings.ts';
      export * from './src/review/report.ts';
      export * from './src/review/worker.ts';
      export * from './src/review/publish.ts';
      export { reviewBatch, reviewRead } from './src/review/db.ts';
      export { learningId, REPORT_DENY } from './src/learning-types.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', platform: 'browser', outfile: OUT, logLevel: 'silent',
});
const api = await import('../' + OUT);
after(() => rmSync(OUT, { force: true }));

const DAY = 86400000;
const GROUP = '9968A083EE07797A987010E64CD421B9';
const TOO = JSON.parse(readFileSync(new URL('../replay/fixtures/too-daily-request.json', import.meta.url), 'utf8'));
const CAO = JSON.parse(readFileSync(new URL('../replay/fixtures/outbox-cao-18.json', import.meta.url), 'utf8'));
const TOO_MSG = TOO.request;
const TOO_QUOTE = '每天早上8点在群里推送一下昨日聊天内容总结';
const CAO_MSG = CAO.ban_message;
// 悉尼 2026-11-14 05:00（review 窗口内），复盘 11-13 的聊天。
const NOW = Date.parse('2026-11-14T05:00:00+11:00');
const DATE = '2026-11-14';
const RUN_ID = GROUP + ':' + DATE;
const SENDER = TOO_MSG.sender;

function database() {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  raw.exec(readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8'));
  const calls = [];
  const DB = {
    raw, calls,
    prepare(sql) {
      const stmt = (args = []) => ({
        sql, args,
        bind(...next) { return stmt(next); },
        async all() { calls.push(sql); return { results: raw.prepare(sql).all(...args) }; },
        async first() { calls.push(sql); return raw.prepare(sql).get(...args) || null; },
        async run() { calls.push(sql); return raw.prepare(sql).run(...args); },
      });
      return stmt();
    },
    async batch(ss) {
      raw.exec('BEGIN');
      try {
        const out = [];
        for (const s of ss) out.push(await (s.all ? s.all() : s.run()));
        raw.exec('COMMIT');
        return out;
      } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
  };
  return { db: DB, raw };
}
function env() {
  const { db, raw } = database();
  return {
    e: {
      DB: db, DEEPSEEK_MODEL: 'fake-first', DEEPSEEK_API_KEY: 'sk-fakeDEEPSEEK123456',
      DEEPSEEK_INPUT_USD_MICROS: '0.01', DEEPSEEK_OUTPUT_USD_MICROS: '0.1',
    },
    db: raw,
  };
}
const at = (ms) => new Date(ms).toISOString();
function member(db, id, name, role = 'member') {
  db.prepare('INSERT OR IGNORE INTO members(id,name,token_hash,role) VALUES(?,?,?,?)')
    .run('qq:' + id, name, 'h-' + id, role);
}
function message(db, m) {
  db.prepare('INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)')
    .run(m.id, m.group_id || GROUP, m.sender, m.body, m.ts || at(NOW - 3600000), m.mentioned ?? 1);
}
function outbox(db, id, body, createdAt = NOW - 60000) {
  db.prepare("INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,'sent',?)")
    .run(id, GROUP, null, body, createdAt);
}
function runRow(db, patch = {}) {
  const row = {
    id: RUN_ID, group_id: GROUP, date: DATE, step: 'publish', mode: 'shadow',
    window_start: at(NOW - 3 * DAY), window_end: at(NOW), ...patch,
  };
  db.prepare(`INSERT OR REPLACE INTO review_runs(id,group_id,date,step,window_start,window_end,mode,stats,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, row.group_id, row.date, row.step, row.window_start, row.window_end,
    row.mode, JSON.stringify(row.stats || {}), NOW);
  return row;
}
function judgment(db, raw, { id = 'j1', runId = RUN_ID, state = 'ok', traceIds = [] } = {}) {
  db.prepare(`INSERT OR REPLACE INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,state,reserved,max_tokens,raw,created_at)
    VALUES(?,?,0,'primary','deepseek','fake-first',?,?,0,4096,?,?)`)
    .run(id, runId, JSON.stringify(traceIds), state, JSON.stringify(raw), NOW);
}
function trace(db, id, { runId = RUN_ID, state = 'judged', kind = 'inbound' } = {}) {
  db.prepare(`INSERT OR REPLACE INTO review_traces(id,run_id,group_id,kind,inbound_id,signals,priority,has_image,state,attempts,trace_json,created_at)
    VALUES(?,?,?,?,?,'[]',0,0,?,1,'{}',?)`).run(id, runId, GROUP, kind, kind === 'inbound' ? id : null, state, NOW);
}
function finding(db, id, patch = {}) {
  const row = {
    id, run_id: RUN_ID, trace_id: 'tr-in-1', failure_type: 'reasoning.decision.tool_selection',
    severity: 'p1', fix_layer: 'prompt', gap_type: null, capability: null, should_use_tool: null,
    dimensions: '{}', evidence_json: '[]', what_happened: '没有查到改动', expected: '查询后给出提交',
    root_cause: '没有核对仓库', next_attempt_plan: '回放查询', confidence: 0.9,
    agreement: 'agree', status: 'open', fingerprint: id, created_at: NOW, ...patch,
  };
  db.prepare(`INSERT OR REPLACE INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,fingerprint,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.run_id, row.trace_id, row.failure_type,
    row.severity, row.fix_layer, row.gap_type, row.capability, row.should_use_tool, row.dimensions,
    row.evidence_json, row.what_happened, row.expected, row.root_cause, row.next_attempt_plan,
    row.confidence, row.agreement, row.status, row.fingerprint, row.created_at);
  return row;
}
function learning(db, patch = {}) {
  const row = {
    id: 'ln-test1', group_id: GROUP, kind: 'rule', subkind: 'avoid_phrase', params: '{"phrase":"草"}',
    plain: '别再说「草」', requester: SENDER, source_msg_id: CAO_MSG.id, quote: CAO_MSG.body,
    run_id: RUN_ID, agreement: 'single', status: 'proposed', ask_count: 0, created_at: NOW - 1000,
    updated_at: NOW - 1000, ...patch,
  };
  db.prepare(`INSERT OR REPLACE INTO review_learnings(id,group_id,kind,subkind,params,plain,requester,source_msg_id,quote,run_id,agreement,status,ask_count,answered_by,answer_msg_id,applied_ref,note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.group_id, row.kind, row.subkind, row.params,
    row.plain, row.requester, row.source_msg_id, row.quote, row.run_id, row.agreement, row.status,
    row.ask_count, row.answered_by ?? null, row.answer_msg_id ?? null, row.applied_ref ?? null,
    row.note ?? null, row.created_at, row.updated_at);
  return row;
}
function schedule(db, { id = 'sched-1', status = 'active', spec = { time: '08:00', topic: '昨日聊天内容总结' }, kind = 'digest_daily' } = {}) {
  db.prepare(`INSERT OR REPLACE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id)
    VALUES(?,?,?,?,'Australia/Sydney',?,?,?,0,?,?)`)
    .run(id, GROUP, 'qq:' + SENDER, kind, JSON.stringify(spec), status, NOW + DAY, NOW, TOO_MSG.id);
}
// 依次把 learnings 阶段跑到 report；commit 只落 review_* 语句。
async function runLearnings(e, run, stats = { phase: 'learnings' }, now = NOW) {
  for (let i = 0; i < 40; i++) {
    await api.learningsPhase(e, run, stats, now, async (extra) => { if (extra.length) await api.reviewBatch(e, extra); });
    if (stats.phase === 'report') return stats;
  }
  throw Error('learnings did not finish: ' + JSON.stringify(stats));
}
const ruleReq = (patch = {}) => ({ kind: 'avoid_phrase', params: { phrase: '草' }, rule: '', scene: '群聊',
  evidence: [{ source: 'message', id: CAO_MSG.id, quote: CAO_MSG.body, origin: 'direct' }], ttl_days: 30, ...patch });
const scheduleReq = (patch = {}) => ({ evidence: [{ source: 'message', id: TOO_MSG.id, quote: TOO_QUOTE }],
  cadence: 'daily', time: '08:00', topic: '昨日聊天内容总结', ...patch });
const result = (extra = {}) => ({ schema: 'ta.review.result.v2', verdicts: [], requirements: [],
  memory_updates: [], promises: [], no_action: [], ...extra });
// 录制式 DeepSeek 响应：找到 system 里的「晨报」标记就当改写调用，否则交给 L3 的判官桩。
function routedFetch(seen = [], lines = ['没接住那句问仓库改动的话', '查仓库时没有先看提交记录']) {
  const judge = fakeFetch(seen, { issue: true, requirements: true });
  return async (url, init) => {
    const wire = JSON.parse(init.body);
    if (String(wire.messages[0].content).includes('晨报')) {
      seen.push({ url: String(url), method: init.method });
      assert.match(String(url), /api\.deepseek\.com/);
      assert.equal(wire.max_tokens, 400);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ lines }) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 20 } });
    }
    return judge(url, init);
  };
}

// ---------- composeReport（纯函数） ----------

test('composeReport sends nothing when every material is empty', () => {
  const got = api.composeReport({ date: DATE, mode: 'shadow', dialogues: 8, findings: [], learnings: [], applied: [], promise: null, violation: null });
  assert.equal(got.skipped, 'nothing_to_say');
  assert.equal(got.body, '');
  assert.deepEqual(got.items, []);
});

test('composeReport numbers the asks 1..3 and keeps the fixed structure', () => {
  const got = api.composeReport({ date: DATE, mode: 'shadow', dialogues: 12,
    findings: ['没接住那句问仓库改动的话'], learnings: [
      { id: 'ln-a', plain: '别再说「草」', requester_name: 'Souvereign' },
      { id: 'ln-b', plain: '每天早上08:00发昨日聊天内容总结', requester_name: 't.o.o.' }],
    applied: [], promise: null, violation: null });
  assert.equal(got.skipped, null);
  assert.match(got.body, /^早上好，我把昨天的聊天复盘了一遍（看了 12 段对话）。/);
  assert.match(got.body, /· 我发现：没接住那句问仓库改动的话/);
  assert.match(got.body, /1）Souvereign 说别再说「草」/);
  assert.match(got.body, /2）t\.o\.o\. 说每天早上08:00发昨日聊天内容总结/);
  assert.deepEqual(got.items, [{ no: 1, learning_id: 'ln-a', applied: false }, { no: 2, learning_id: 'ln-b', applied: false }]);
  assert.ok(got.body.split('\n').length <= 12);
  assert.ok(Array.from(got.body).length <= 500);
});

test('composeReport shadow wording never claims an unconfirmed change', () => {
  const got = api.composeReport({ date: DATE, mode: 'shadow', dialogues: 5,
    findings: ['回答里漏了提交号'], learnings: [{ id: 'ln-a', plain: '别再说「草」', requester_name: '成员' }],
    applied: [], promise: null, violation: { phrase: '草', count: 3 } });
  assert.ok(got.body.includes('我发现'));
  assert.ok(got.body.includes('我打算记住'));
  for (const word of ['已经改', '已修复', '已经记住']) assert.ok(!got.body.includes(word), word);
});

test('composeReport only prints 已经记住 for confirmed/applied rows', () => {
  const got = api.composeReport({ date: DATE, mode: 'shadow', dialogues: 5, findings: [],
    learnings: [], applied: [{ plain: '别再说「草」' }], promise: null, violation: null });
  assert.match(got.body, /· 已经记住：别再说「草」（不对就回这条说「不对」）/);
});

test('composeReport template itself passes REPORT_DENY and the twelve-line budget', () => {
  const full = api.composeReport({ date: DATE, mode: 'propose', dialogues: 99,
    findings: ['第一条发现', '第二条发现'],
    learnings: [{ id: 'ln-a', plain: '别再说「草」', requester_name: '甲' },
      { id: 'ln-b', plain: '每天早上08:00发昨日总结', requester_name: '乙' },
      { id: 'ln-c', plain: '以后回复最多200字', requester_name: '丙' }],
    applied: [{ plain: '以后回复最多200字' }, { plain: '别再说「草」' }],
    promise: '每天08:00的晨报', violation: { phrase: '草', count: 4 } });
  const lower = full.body.toLowerCase();
  for (const word of api.REPORT_DENY) assert.ok(!lower.includes(String(word).toLowerCase()), word);
  assert.ok(full.body.split('\n').length <= 12, full.body);
  assert.ok(Array.from(full.body).length <= 500, String(Array.from(full.body).length));
  assert.ok(full.body.includes('想记住这几条'));
});

// ---------- learnings ----------

function learnEnv() {
  const { e, db } = env();
  member(db, SENDER, 't.o.o.', 'admin');
  member(db, CAO_MSG.sender, 'Souvereign');
  message(db, { ...TOO_MSG, group_id: GROUP });
  message(db, { ...CAO_MSG, group_id: GROUP });
  return { e, db };
}
const learningRows = (db) => db.prepare('SELECT * FROM review_learnings ORDER BY id').all();

test('TOO’s real 08:00 request becomes a schedule candidate from the L9 fixture', async () => {
  const { e, db } = learnEnv();
  const run = runRow(db);
  judgment(db, result({ schedule_requests: [scheduleReq()] }));
  await runLearnings(e, run);
  const rows = learningRows(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'schedule');
  assert.equal(rows[0].subkind, 'daily');
  assert.equal(JSON.parse(rows[0].params).time, '08:00');
  assert.equal(JSON.parse(rows[0].params).topic, '昨日聊天内容总结');
  assert.equal(rows[0].plain, '每天08:00发昨日聊天内容总结');
  assert.equal(rows[0].requester, SENDER);
  assert.equal(rows[0].source_msg_id, TOO_MSG.id);
  assert.equal(rows[0].status, 'proposed');
  assert.equal(rows[0].run_id, RUN_ID);
  assert.equal(await api.learningId(GROUP, 'schedule', 'daily', 'daily|08:00||昨日聊天内容总结'), rows[0].id);
});

test('Souvereign’s real 「别再说草」 becomes avoid_phrase only when 草 is in the bot outbox', async () => {
  for (const [body, expected] of [['草，这个我懂', 1], ['草稿写完了，别催', 1], ['我没有说过这个字', 0]]) {
    const { e, db } = learnEnv();
    if (body) outbox(db, 'o-cao', body);
    const run = runRow(db);
    judgment(db, result({ requirements: [ruleReq()] }));
    await runLearnings(e, run);
    assert.equal(learningRows(db).length, expected, body);
    if (expected) {
      const row = learningRows(db)[0];
      assert.equal(row.subkind, 'avoid_phrase');
      assert.deepEqual(JSON.parse(row.params), { phrase: '草' });
      assert.equal(row.plain, '别再说「草」');
    }
  }
});

test('address_as is only learned from the speaker naming themselves', async () => {
  const { e, db } = learnEnv();
  const body = '以后叫我马哥';
  message(db, { id: 'm-address', sender: SENDER, body, ts: at(NOW - 1000), mentioned: 1 });
  const run = runRow(db);
  judgment(db, result({ requirements: [ruleReq({ kind: 'address_as', params: { member: 'qq:99999', name: '马哥' },
    evidence: [{ source: 'message', id: 'm-address', quote: body, origin: 'direct' }] })] }));
  await runLearnings(e, run);
  assert.equal(learningRows(db).length, 0);
  const ok = learnEnv();
  message(ok.db, { id: 'm-address', sender: SENDER, body, ts: at(NOW - 1000), mentioned: 1 });
  const run2 = runRow(ok.db);
  judgment(ok.db, result({ requirements: [ruleReq({ kind: 'address_as', params: { member: 'qq:' + SENDER, name: '马哥' },
    evidence: [{ source: 'message', id: 'm-address', quote: body, origin: 'direct' }] })] }), { id: 'j2' });
  await runLearnings(ok.e, run2);
  assert.equal(learningRows(ok.db).length, 1);
  assert.equal(learningRows(ok.db)[0].plain, '以后叫我「马哥」');
  // L6 写入前用严格相等比对 requester；L4 必须把 member 收敛成原话发送者。
  assert.deepEqual(JSON.parse(learningRows(ok.db)[0].params), { member: SENDER, name: '马哥' });
});

test('covered by an existing rule or a matching active schedule is not proposed', async () => {
  {
    const { e, db } = learnEnv();
    outbox(db, 'o-cao', '草，这个我懂');
    db.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,expires_at,created_at,updated_at)
      VALUES('rule-old',?,'不要再说「草」。','群聊','avoid_phrase','{"phrase":"草"}','[]','member:x','active',?,?,?)`)
      .run(GROUP, NOW + DAY, NOW, NOW);
    const run = runRow(db);
    judgment(db, result({ requirements: [ruleReq()] }));
    await runLearnings(e, run);
    assert.equal(learningRows(db).length, 0);
  }
  {
    const { e, db } = learnEnv();
    schedule(db, { spec: { time: '08:05', topic: '昨日聊天内容总结' } });
    const run = runRow(db);
    judgment(db, result({ schedule_requests: [scheduleReq()] }));
    await runLearnings(e, run);
    assert.equal(learningRows(db).length, 0);
  }
  {
    const { e, db } = learnEnv();
    schedule(db, { spec: { time: '09:30', topic: '别的事' } });
    const run = runRow(db);
    judgment(db, result({ schedule_requests: [scheduleReq()] }));
    await runLearnings(e, run);
    assert.equal(learningRows(db).length, 1);
  }
  {
    // 已有每天 08:00 → 每周日 08:00 的请求已被覆盖；反过来不成立。
    const daily = learnEnv();
    schedule(daily.db, { spec: { time: '08:00', topic: '别的事' } });
    const run1 = runRow(daily.db);
    judgment(daily.db, result({ schedule_requests: [scheduleReq({ cadence: 'weekly', weekdays: [0] })] }));
    await runLearnings(daily.e, run1);
    assert.equal(learningRows(daily.db).length, 0);
    const weekly = learnEnv();
    schedule(weekly.db, { kind: 'digest_weekly', spec: { time: '08:00', weekdays: [0], topic: '别的事' } });
    const run2 = runRow(weekly.db);
    judgment(weekly.db, result({ schedule_requests: [scheduleReq()] }), { id: 'j2' });
    await runLearnings(weekly.e, run2);
    assert.equal(learningRows(weekly.db).length, 1);
  }
});

test('full mode treats a rule already applied for the same source message as covered', async () => {
  const { e, db } = learnEnv();
  outbox(db, 'o-cao', '草，这个我懂');
  const run = runRow(db, { mode: 'full' });
  db.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,expires_at,created_at,updated_at)
    VALUES('rule-applied',?,'不要再说「草」。','群聊','avoid_phrase','{"phrase":"草"}',?,'review:'||?,'candidate',?,?,?)`)
    .run(GROUP, JSON.stringify([{ source: 'message', id: CAO_MSG.id, quote: CAO_MSG.body, origin: 'direct' }]),
      RUN_ID, NOW + DAY, NOW, NOW);
  judgment(db, result({ requirements: [ruleReq()] }));
  await runLearnings(e, run);
  assert.equal(learningRows(db).length, 0);
});

test('the same requirement across nights keeps one id and its ask_count', async () => {
  const { e, db } = learnEnv();
  outbox(db, 'o-cao', '草，这个我懂');
  const run1 = runRow(db);
  judgment(db, result({ requirements: [ruleReq()] }), { id: 'j1' });
  await runLearnings(e, run1);
  const first = learningRows(db)[0];
  const asked = await api.reportPhase(e, run1, { phase: 'report', learn_mode: 'ask' }, NOW, { fetch: routedFetch() });
  await api.reviewBatch(e, asked.statements);
  assert.equal(learningRows(db)[0].status, 'asked');
  assert.equal(learningRows(db)[0].ask_count, 1);
  // 第二晚同一要求：新 run、同一 id；不新增，也不把 ask_count 归零。
  const run2 = runRow(db, { id: GROUP + ':2026-11-15', date: '2026-11-15' });
  judgment(db, result({ requirements: [ruleReq()] }), { id: 'j2', runId: run2.id });
  await runLearnings(e, run2, { phase: 'learnings' }, NOW + DAY);
  assert.equal(learningRows(db).length, 1);
  assert.equal(learningRows(db)[0].id, first.id);
  assert.equal(learningRows(db)[0].ask_count, 1);
});

test('at most three new candidates per group per night across judge batches', async () => {
  const { e, db } = learnEnv();
  const reqs = [];
  for (let i = 0; i < 5; i++) {
    const id = 'm-cap-' + i, body = '以后回复最多' + (100 + i * 20) + '字';
    message(db, { id, sender: SENDER, body, ts: at(NOW - 1000 - i), mentioned: 1 });
    reqs.push({ kind: 'reply_max_chars', params: { max: 100 + i * 20 }, rule: '', scene: '群聊',
      evidence: [{ source: 'message', id, quote: body, origin: 'direct' }], ttl_days: 30 });
  }
  judgment(db, result({ requirements: reqs.slice(0, 2) }), { id: 'j1' });
  judgment(db, result({ requirements: reqs.slice(2) }), { id: 'j2' });
  const run = runRow(db);
  await runLearnings(e, run);
  assert.equal(learningRows(db).length, 3);
});

// ---------- report ----------

function reportEnv() {
  const { e, db } = env();
  member(db, SENDER, 't.o.o.', 'admin');
  const run = runRow(db);
  trace(db, 'tr-in-1');
  trace(db, 'tr-in-2');
  return { e, db, run };
}

test('a run with nothing to say writes a skipped row and no body', async () => {
  const { e, db, run } = reportEnv();
  const out = await api.reportPhase(e, run, { phase: 'report' }, NOW, { fetch: routedFetch() });
  await api.reviewBatch(e, out.statements);
  const row = db.prepare('SELECT * FROM review_reports').get();
  assert.equal(row.state, 'skipped');
  assert.equal(row.reason, 'nothing_to_say');
  assert.equal(row.body, '');
  assert.equal(row.id, 'reflection-report:2026-11-14');
});

test('a failed run or a judge_failed majority is skipped', async () => {
  {
    const { e, db } = reportEnv();
    const run = runRow(db, { step: 'failed', stats: { failures: 3 } });
    const out = await api.reportPhase(e, run, {}, NOW, { fetch: routedFetch() });
    await api.reviewBatch(e, out.statements);
    assert.equal(db.prepare('SELECT reason FROM review_reports').get().reason, 'run_failed');
  }
  {
    const { e, db } = reportEnv();
    const run = runRow(db);
    db.prepare("UPDATE review_traces SET state='judge_failed'").run();
    judgment(db, result(), { id: 'j-failed', traceIds: ['tr-in-1', 'tr-in-2'] });
    const out = await api.reportPhase(e, run, {}, NOW, { fetch: routedFetch() });
    await api.reviewBatch(e, out.statements);
    assert.equal(db.prepare('SELECT reason FROM review_reports').get().reason, 'judge_failed');
  }
});

test('report writes ready with items, asks the learnings and expires the twice-asked', async () => {
  const { e, db, run } = reportEnv();
  finding(db, 'f1');
  const l1 = learning(db, { id: 'ln-a', plain: '别再说「草」', status: 'proposed', ask_count: 0 });
  const l2 = learning(db, { id: 'ln-b', plain: '每天早上08:00发昨日总结', kind: 'schedule', subkind: 'daily',
    params: '{"time":"08:00","topic":"昨日总结"}', status: 'asked', ask_count: 1 });
  const l3 = learning(db, { id: 'ln-c', plain: '以后回复最多200字', subkind: 'reply_max_chars', params: '{"max":200}', status: 'proposed', ask_count: 2 });
  const out = await api.reportPhase(e, run, { phase: 'report' }, NOW, { fetch: routedFetch([], ['没接住那句问仓库改动的话']) });
  await api.reviewBatch(e, out.statements);
  const row = db.prepare('SELECT * FROM review_reports').get();
  assert.equal(row.state, 'ready');
  assert.equal(row.reason, null);
  assert.equal(row.id, 'reflection-report:2026-11-14');
  assert.match(row.body, /没接住那句问仓库改动的话/);
  assert.ok(row.body.split('\n').length <= 12);
  assert.deepEqual(JSON.parse(row.items), [{ no: 1, learning_id: l1.id, applied: false }, { no: 2, learning_id: l2.id, applied: false }]);
  const asked1 = db.prepare("SELECT status,ask_count FROM review_learnings WHERE id=?").get(l1.id);
  assert.equal(asked1.status, 'asked'); assert.equal(asked1.ask_count, 1);
  const asked2 = db.prepare("SELECT status,ask_count FROM review_learnings WHERE id=?").get(l2.id);
  assert.equal(asked2.status, 'asked'); assert.equal(asked2.ask_count, 2);
  assert.equal(db.prepare("SELECT status FROM review_learnings WHERE id=?").get(l3.id).status, 'expired');
});

test('a failed rewrite drops only the findings section', async () => {
  const { e, db, run } = reportEnv();
  finding(db, 'f1');
  learning(db, { id: 'ln-a', plain: '别再说「草」' });
  for (const lines of [[], ['a', 'b'], ['第3次漏了'], ['这条里出现了模型两个字'], ['这条太长了'.repeat(12)]]) {
    db.prepare('DELETE FROM review_reports').run();
    db.prepare('DELETE FROM activity WHERE id LIKE ?').run('report-rewrite:%');
    db.prepare("UPDATE review_learnings SET status='proposed',ask_count=0").run();
    const out = await api.reportPhase(e, run, { phase: 'report' }, NOW, { fetch: routedFetch([], lines) });
    await api.reviewBatch(e, out.statements);
    const body = db.prepare('SELECT body FROM review_reports').get().body;
    assert.ok(!body.includes('没接住那句问仓库改动的话'), JSON.stringify(lines));
    assert.match(body, /· 我打算记住/);
  }
});

test('the findings rewrite is called at most once per group per day', async () => {
  const { e, db, run } = reportEnv();
  finding(db, 'f1');
  let calls = 0;
  const fetch = (...args) => { calls++; return routedFetch()(...args); };
  const first = await api.reportPhase(e, run, { phase: 'report' }, NOW, { fetch });
  await api.reviewBatch(e, first.statements);
  db.prepare("UPDATE review_runs SET step='publish',stats='{}'").run();
  const again = await api.reportPhase(e, run, {}, NOW, { fetch });
  await api.reviewBatch(e, again.statements);
  assert.equal(calls, 1);
  assert.equal(db.prepare('SELECT body FROM review_reports').get().body, first.body);
});

test('learn:mode=off produces neither learnings nor a report', async () => {
  const { e, db } = learnEnv();
  outbox(db, 'o-cao', '草，这个我懂');
  db.prepare("INSERT OR REPLACE INTO settings VALUES('learn:mode','off')").run();
  const run = runRow(db);
  judgment(db, result({ requirements: [ruleReq()] }));
  await runLearnings(e, run);
  assert.equal(learningRows(db).length, 0);
  const out = await api.reportPhase(e, run, { phase: 'report' }, NOW, { fetch: routedFetch() });
  await api.reviewBatch(e, out.statements);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_reports').get().n, 0);
});

test('an old run at publish with an unknown phase falls back to done', async () => {
  const { e, db } = reportEnv();
  runRow(db, { stats: { phase: 'mystery', coverage: { messages: 2, inbound_traces: 2, skipped_by_rule: 0,
    outbox: 0, outbox_paired: 0, outbox_standalone: 0, unaccounted: 0 } } });
  await api.reviewTick(e, { now: () => NOW });
  assert.equal(db.prepare('SELECT step FROM review_runs').get().step, 'done');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM review_reports').get().n, 0);
});

// ---------- 接进 publish 阶段：全流程 0 写 behavior_rules / schedules ----------

test('a full shadow night runs learnings then report and writes no behavior_rules/schedules', async () => {
  const { e, db } = workerSetup('shadow');
  workerSeed(db, 3);
  const seen = [];
  try {
    await workerFinish(e, workerNight, { fetch: routedFetch(seen) }, 200);
    assert.equal(db.prepare('SELECT step FROM review_runs').get().step, 'done');
    assert.ok(db.prepare('SELECT COUNT(*) n FROM review_learnings').get().n >= 1);
    const report = db.prepare('SELECT * FROM review_reports').get();
    assert.equal(report.state, 'ready');
    assert.match(report.body, /我打算记住/);
    // phase 顺序：rules → learnings（留下 offset）→ report（留下 report 统计）→ done。
    const stats = JSON.parse(db.prepare('SELECT stats FROM review_runs').get().stats);
    assert.ok(Number(stats.learning_offset) >= 1);
    assert.equal(stats.report?.state, 'ready');
    const writes = e.DB.calls.filter((sql) => /^\s*(INSERT|UPDATE|DELETE)/i.test(sql));
    assert.deepEqual(writes.filter((sql) => /(?:^|\W)(behavior_rules|schedules)(?:\W|$)/i.test(sql)), []);
    // 全部 review 写都落在 review_*（activity 的改写缓存除外）。
    const other = writes.filter((sql) => !/review_[a-z_]+|activity/i.test(sql));
    assert.deepEqual(other, []);
  } finally { db.close(); }
});

// ---------- digest 两节 ----------

test('renderDigest exposes yesterday’s schedule runs and learnings', async () => {
  const { e, db } = env();
  member(db, SENDER, 't.o.o.');
  runRow(db);
  schedule(db, { id: 'sched-morning', spec: { time: '08:00', topic: '礼物日早报' } });
  db.prepare(`INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,outbox_id)
    VALUES('r1','sched-morning',?,?,?,'ok','morning-report:2026-11-14')`)
    .run(Date.parse('2026-11-14T08:00:00+11:00'), Date.parse('2026-11-14T08:00:05+11:00'), Date.parse('2026-11-14T08:00:09+11:00'));
  db.prepare(`INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,error)
    VALUES('r2','sched-morning',?,?,?,'skipped','cap')`)
    .run(Date.parse('2026-11-15T08:00:00+11:00'), Date.parse('2026-11-15T08:00:05+11:00'), Date.parse('2026-11-15T08:00:05+11:00'));
  learning(db, { id: 'ln-digest', plain: '别再说「草」', status: 'asked', ask_count: 1 });
  const digest = await api.renderDigest(e, DATE);
  assert.equal(digest.schedules.items.length, 1);
  assert.equal(digest.schedules.items[0].status, 'ok');
  assert.equal(digest.schedules.items[0].schedule_id, 'sched-morning');
  assert.match(digest.schedules.items[0].description, /礼物日早报/);
  assert.equal(digest.schedules.counts.ok, 1);
  assert.equal(digest.learnings.items.length, 1);
  assert.equal(digest.learnings.items[0].id, 'ln-digest');
  assert.equal(digest.learnings.items[0].status, 'asked');
  assert.equal(digest.learnings.asked, 1);
});
