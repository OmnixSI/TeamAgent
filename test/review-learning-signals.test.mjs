// L3：复盘看得见群友的长期要求。S11 信号、两种新规则 kind、schedule_requests 校验。
// 真实原话来自 .agent/releases/V-D-learning/gift-report-findings.md（TOO 11-13 04:11、
// Souvereign 11-11 21:09），不是编造样本。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { build } from 'esbuild';
import { env } from './support.mjs';
import { setup as workerSetup, seed as workerSeed, finish as workerFinish, fakeFetch, night } from './review-worker-fixture.mjs';

const OUT = '.wrangler/test-learning-signals-' + process.pid + '.mjs';
await build({
  stdin: {
    contents: `export * from './src/review/signals.ts';
      export * from './src/review/types.ts';
      export { SIGNAL_DEFAULTS as SIGNAL_CONSTANTS } from './src/review/constants.ts';
      export * from './src/review/rules.ts';
      export * from './src/review/validate.ts';
      export * from './src/review/prompt.ts';
      export * from './src/review/db.ts';
      export { metered } from './src/d1.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: 'esm', platform: 'browser', outfile: OUT, logLevel: 'silent',
});
const api = await import('../' + OUT);
after(() => rmSync(OUT, { force: true }));

const AT = Date.parse('2026-11-13T04:11:39+11:00');
const TOO = '然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。';
const TOO_QUOTE = '每天早上8点在群里推送一下昨日聊天内容总结';
const CONDIMENT = '把你说草的这个口头禅给我改了';
const now = Date.parse('2026-11-14T00:00:00Z'), day = 86400000;

function inboundTrace(body, { mentioned = 1, addressed = 'bot', sender = 'qq:10001',
  bound = 'qq:10001', origin = 'direct', id = 'm1', ts = new Date(AT).toISOString() } = {}) {
  const msg = { id, sender, ts, body, segs: [{ origin, text: body }], bound_member: bound, addressed, images: [] };
  return { id: 'tr-in-' + id, group_id: 'g', kind: 'inbound', inbound: { ...msg, mentioned },
    context_before: [], replies: [], after: [], tools: 'unrecorded', tools_offered: 'unknown',
    snapshot_ref: null, has_image: false, signals: [] };
}
const ctxFor = (traces) => ({ traces, snapshot: {}, same_family: 0, memberIds: ['qq:10001'] });
const result = (schedule_requests, extra = {}) => ({
  schema: 'ta.review.result.v2', verdicts: [], requirements: [], memory_updates: [], promises: [],
  no_action: [], ...(schedule_requests === undefined ? {} : { schedule_requests }), ...extra,
});
const request = (patch = {}) => ({
  evidence: [{ source: 'message', id: 'm1', quote: TOO_QUOTE }],
  cadence: 'daily', time: '08:00', topic: '昨日聊天内容总结', ...patch,
});
const only = (schedules, trace = inboundTrace(TOO)) => api.validateResult(result(schedules), ctxFor([trace]));

// ---------- S11 ----------

test('S11 words match the design list and priority is level 3 like S1', () => {
  assert.deepEqual(api.SIGNAL_CONSTANTS.s11.words, ['以后', '每天', '每周', '每早', '每晚', '定时', '别再',
    '不要再', '别老', '不许', '叫我', '称呼', '口头禅', '记住', '日报', '早报', '晨报', '周报']);
  assert.deepEqual(api.SIGNAL_DEFAULTS.s11_phrases, api.SIGNAL_CONSTANTS.s11.words);
  assert.equal(api.priorityOf(['S11']), 3);
  assert.equal(api.priorityOf(['S11']), api.priorityOf(['S1']));
  assert.ok(api.SIGNALS.S11);
});

test('S11 hits a group member who addresses the bot with any requirement word', () => {
  assert.ok(api.signalsOf(inboundTrace(TOO)).includes('S11'));
  assert.ok(api.signalsOf(inboundTrace(CONDIMENT)).includes('S11'));
  // 回复 bot（未 @）也算 addressed。
  assert.ok(api.signalsOf(inboundTrace('以后每天发早报', { mentioned: 0, addressed: 'bot' })).includes('S11'));
  for (const word of api.SIGNAL_CONSTANTS.s11.words) {
    assert.ok(api.signalsOf(inboundTrace(`请你${word}这件事`)).includes('S11'), `word ${word}`);
  }
});

test('S11 does not hit unaddressed chatter or the bot own message', () => {
  assert.ok(!api.signalsOf(inboundTrace(TOO, { mentioned: 0, addressed: 'none' })).includes('S11'));
  const own = { ...inboundTrace(TOO), kind: 'outbound', inbound: null,
    replies: [{ outbox_id: 'o1', body: TOO, status: 'sent', at: AT, link: 'decision' }] };
  assert.ok(!api.signalsOf(own).includes('S11'));
});

test('S11 signals still respect the sixty-trace nightly cap', async () => {
  // 90 条真实句式（含「以后」）+ 同一句回复，既有 S10 也有 S11。
  const { e, db } = workerSetup();
  workerSeed(db, 90);
  try {
    await workerFinish(e, night, { fetch: fakeFetch([], { issue: false }) }, 200);
    assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='judged'").get().n, 60);
    assert.equal(db.prepare("SELECT count(*) n FROM review_traces WHERE state='pending'").get().n, 30);
    assert.ok(db.prepare("SELECT signals FROM review_traces WHERE signals LIKE '%S11%'").all().length > 0);
  } finally { db.close(); }
});

// ---------- schedule_requests ----------

test('a real TOO request validates and keeps only the frozen ScheduleRequest fields', () => {
  const got = only([request({ extra: 'drop-me', evidence: [{ source: 'message', id: 'm1', quote: TOO_QUOTE, origin: 'direct', note: 'drop' }] })]);
  assert.equal(got.schedule_requests.length, 1);
  assert.deepEqual(got.schedule_requests[0], {
    evidence: [{ source: 'message', id: 'm1', quote: TOO_QUOTE }],
    cadence: 'daily', time: '08:00', topic: '昨日聊天内容总结',
  });
  assert.deepEqual(Object.keys(got.schedule_requests[0]).sort(), ['cadence', 'evidence', 'time', 'topic']);
  assert.deepEqual(Object.keys(got.schedule_requests[0].evidence[0]).sort(), ['id', 'quote', 'source']);
});

test('schedule_requests drop quoted evidence, messages not addressed to the bot and non-requests', () => {
  assert.equal(only([request()], inboundTrace(TOO, { origin: 'quoted' })).schedule_requests.length, 0);
  assert.equal(only([request()], inboundTrace(TOO, { mentioned: 0, addressed: 'none' })).schedule_requests.length, 0);
  const chatter = inboundTrace('我觉得这个挺好的');
  const got = only([request({ evidence: [{ source: 'message', id: 'm1', quote: '我觉得这个挺好的' }], topic: '闲聊' })], chatter);
  assert.equal(got.schedule_requests.length, 0);
  assert.equal(got.rejects[0].reason, 'not_explicit_request');
});

test('schedule_requests drop an unparseable time, a bad topic and a weekly without weekdays', () => {
  for (const time of ['早上8点', '25:00', '08:60', '', null]) assert.equal(only([request({ time })]).schedule_requests.length, 0, String(time));
  for (const topic of ['', '主'.repeat(41), '权限说明', '密钥日报']) assert.equal(only([request({ topic })]).schedule_requests.length, 0, topic);
  assert.equal(only([request({ cadence: 'weekly' })]).schedule_requests.length, 0);
  const weekly = only([request({ cadence: 'weekly', weekdays: [0, 3, 3] })]);
  assert.equal(weekly.schedule_requests.length, 1);
  assert.deepEqual(weekly.schedule_requests[0].weekdays, [0, 3]);
  assert.equal(only([request({ cadence: 'weekly', weekdays: [7] })]).schedule_requests.length, 0);
});

test('schedule_requests truncate at three and unknown top-level fields are still dropped', () => {
  const many = Array.from({ length: 5 }, () => request());
  const raw = result(many, { mystery: { anything: true } });
  const got = api.validateResult(raw, ctxFor([inboundTrace(TOO)]));
  assert.equal(got.schedule_requests.length, 3);
  assert.ok(!('mystery' in got));
  assert.deepEqual(api.validateResult(result(), ctxFor([inboundTrace(TOO)])).schedule_requests, []);
});

// ---------- requested() ----------

async function ruleEnv(body) {
  const e = env();
  const migration = readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
  for (const sql of migration.split(';').filter((s) => s.trim())) await e.DB.prepare(sql).run();
  await e.DB.prepare("INSERT INTO members(id,name,token_hash) VALUES('bound','成员','fake')").run();
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,1)')
    .bind('m1', 'g', 'bound', body, new Date(now).toISOString()).run();
  return e;
}
const run = { id: 'night1', group_id: 'g', now };
const freeAsk = (rule, quote) => ({ kind: 'free', params: {}, rule, scene: '群聊',
  evidence: [{ source: 'message', id: 'm1', quote, origin: 'direct' }], ttl_days: 30 });

test('requested() admits 每天/每周/每早/每晚/定时/按时 opening sentences', async () => {
  for (const clause of ['每天早上八点发晨报', '每周日发周报', '每早八点提醒', '每晚十点总结',
    '定时发日报', '按时推送']) {
    const e = await ruleEnv(clause);
    const ids = await api.applyRequirements(e, run, [freeAsk(clause, clause)]);
    assert.equal(ids.length, 1, clause);
  }
});

// ---------- avoid_phrase / address_as ----------

async function phraseEnv(outbox = [{ id: 'o1', group: 'g', body: '草，这个我懂', at: now - 1000 }]) {
  const e = await ruleEnv('以后别再说草了');
  for (const row of outbox) await e.DB.prepare('INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)')
    .bind(row.id, row.group || 'g', null, row.body, 'sent', row.at).run();
  return e;
}
const avoidAsk = (phrase) => ({ kind: 'avoid_phrase', params: { phrase }, rule: '', scene: '群聊',
  evidence: [{ source: 'message', id: 'm1', quote: '以后别再说草了', origin: 'direct' }], ttl_days: 30 });
const addressAsk = (member, name) => ({ kind: 'address_as', params: { member, name }, rule: '', scene: '群聊',
  evidence: [{ source: 'message', id: 'm1', quote: '以后叫我马哥', origin: 'direct' }], ttl_days: 30 });
const ruleRow = async (e, id) => (await e.DB.prepare('SELECT * FROM behavior_rules WHERE id=?').bind(id).first());

test('RULE_KINDS appends the two frozen kinds and renderRule owns their templates', () => {
  assert.deepEqual([...api.RULE_KINDS].slice(-2), ['avoid_phrase', 'address_as']);
  assert.equal(api.renderRule('avoid_phrase', { phrase: '草' }, '', 30), '不要再说「草」。');
  assert.equal(api.renderRule('avoid_phrase', { phrase: '主'.repeat(13) }, '', 30), null);
  assert.equal(api.renderRule('avoid_phrase', { phrase: '草', extra: 1 }, '', 30), null);
  assert.equal(api.renderRule('address_as', { member: 'qq:10001', name: '马哥' }, '', 30, 'qq:10001'),
    '称呼qq:10001为「马哥」。');
  // 两键例外之外仍只许一个键。
  assert.equal(api.renderRule('address_as', { member: 'qq:10001', name: '马哥', extra: 1 }, '', 30), null);
  assert.equal(api.renderRule('address_as', { member: 'qq:10001', name: '主'.repeat(11) }, '', 30), null);
  // member 必须等于原话发送者（qq: 前缀归一后比较）。
  assert.equal(api.renderRule('address_as', { member: 'qq:10001', name: '马哥' }, '', 30, 'qq:99999'), null);
  assert.equal(api.renderRule('address_as', { member: '10001', name: '马哥' }, '', 30, 'qq:10001'), '称呼10001为「马哥」。');
});

test('avoid_phrase only enters when the phrase appeared verbatim in the last seven days of bot outbox', async () => {
  const e = await phraseEnv();
  const ids = await api.applyRequirements(e, run, [avoidAsk('草')]);
  assert.equal(ids.length, 1);
  const row = await ruleRow(e, ids[0]);
  assert.equal(row.kind, 'avoid_phrase');
  assert.equal(row.rule, '不要再说「草」。');
  assert.deepEqual(JSON.parse(row.params), { phrase: '草' });

  for (const outbox of [[], [{ id: 'old', body: '草', at: now - 8 * day }],
    [{ id: 'other', group: 'other', body: '草', at: now - 1000 }]]) {
    const fresh = await phraseEnv(outbox);
    assert.deepEqual(await api.applyRequirements(fresh, run, [avoidAsk('草')]), [], JSON.stringify(outbox));
  }
  // instr 是逐字包含：outbox 里只有「草稿」时，禁止短语「草」仍准入；「草稿」本身才是没出现过的词。
  const draft = await phraseEnv([{ id: 'o1', body: '草稿写完了', at: now - 1000 }]);
  assert.equal((await api.applyRequirements(draft, run, [avoidAsk('草')])).length, 1);
  const missing = await phraseEnv([{ id: 'o1', body: '草稿写完了', at: now - 1000 }]);
  assert.deepEqual(await api.applyRequirements(missing, run, [avoidAsk('草稿稿')]), []);
});

test('address_as requires two keys and the member to be the original speaker', async () => {
  const e = await ruleEnv('以后叫我马哥');
  const ids = await api.applyRequirements(e, run, [addressAsk('qq:bound', '马哥')]);
  assert.equal(ids.length, 1);
  const row = await ruleRow(e, ids[0]);
  assert.equal(row.kind, 'address_as');
  assert.equal(row.rule, '称呼qq:bound为「马哥」。');
  assert.deepEqual(JSON.parse(row.params), { member: 'qq:bound', name: '马哥' });

  const other = await ruleEnv('以后叫我马哥');
  assert.deepEqual(await api.applyRequirements(other, run, [addressAsk('qq:someone', '马哥')]), []);
});

test('validate keeps address_as only when member equals the evidence sender', () => {
  const trace = inboundTrace('以后叫我马哥');
  const req = (member) => ({ kind: 'address_as', params: { member, name: '马哥' }, rule: '', scene: '群聊',
    evidence: [{ source: 'message', id: 'm1', quote: '以后叫我马哥' }], ttl_days: 45 });
  const raw = (member) => result(undefined, { requirements: [req(member)] });
  const ok = api.validateResult(raw('qq:10001'), ctxFor([trace]));
  assert.equal(ok.requirements.length, 1);
  assert.equal(ok.requirements[0].rule, '称呼qq:10001为「马哥」。');
  assert.equal(ok.requirements[0].ttl_days, 30);
  const bad = api.validateResult(raw('qq:99999'), ctxFor([trace]));
  assert.equal(bad.requirements.length, 0);
  assert.equal(bad.rejects[0].reason, 'address_sender_mismatch');
});

test('validate keeps avoid_phrase with its frozen one-key params', () => {
  const trace = inboundTrace('以后别再说草了');
  const raw = result(undefined, { requirements: [{ kind: 'avoid_phrase', params: { phrase: '草' }, rule: '',
    scene: '群聊', evidence: [{ source: 'message', id: 'm1', quote: '以后别再说草了' }], ttl_days: 30 }] });
  const got = api.validateResult(raw, ctxFor([trace]));
  assert.equal(got.requirements.length, 1);
  assert.equal(got.requirements[0].rule, '不要再说「草」。');
  assert.deepEqual(got.requirements[0].params, { phrase: '草' });
});

// ---------- prompt ----------

test('judge prompt explains the new kinds and schedule_requests with one good and one bad example', () => {
  const prompt = api.PRIMARY_FORMAT;
  for (const token of ['avoid_phrase', 'address_as', 'schedule_requests', 'weekdays', '正例', '反例', '每天']) {
    assert.ok(prompt.includes(token), `missing ${token}`);
  }
});
