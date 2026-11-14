// B-l6 确认/取消/撤销：授权矩阵每一格一条断言；写入与回执同一 batch 的最终状态可重放。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { env, req, qq, msg } from './support.mjs';

async function bundle(name) {
  const outfile = `.wrangler/b-l6-${name}-${process.pid}.mjs`;
  await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: 'esm', platform: 'browser', outfile });
  return import('../' + outfile);
}
const { parseAnswer, handleLearningReply } = await bundle('learning-confirm');

const G = 'GROUP000001';
const REPORT = 'reflection-report:2026-11-14';
const REVIEW_SQL = readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
const rows = (e, table) => e.DB.prepare('SELECT * FROM ' + table).all().then((x) => x.results);
const one = (e, sql, ...params) => e.DB.prepare(sql).bind(...params).first();
async function reviewSchema(e) {
  for (const statement of REVIEW_SQL.split(';').map((s) => s.trim()).filter(Boolean))
    await e.DB.prepare(statement).run();
}

function learning(over = {}) {
  return {
    id: 'ln-1', group_id: G, kind: 'rule', subkind: 'avoid_phrase',
    params: JSON.stringify({ phrase: '绝了' }), plain: '别再说「绝了」', requester: 'U1',
    source_msg_id: 'm0', quote: '别老说绝了', run_id: 'run-1', agreement: 'agree',
    status: 'asked', ask_count: 1, answered_by: null, answer_msg_id: null, applied_ref: null,
    note: null, created_at: 1000, updated_at: 1000, ...over,
  };
}

async function fixture(items, learnings = [learning()], extra = {}) {
  const e = env();
  await reviewSchema(e);
  for (const row of learnings)
    await e.DB.prepare(
      'INSERT INTO review_learnings(id,group_id,kind,subkind,params,plain,requester,source_msg_id,quote,run_id,agreement,status,ask_count,answered_by,answer_msg_id,applied_ref,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(row.id, row.group_id, row.kind, row.subkind, row.params, row.plain, row.requester, row.source_msg_id,
      row.quote, row.run_id, row.agreement, row.status, row.ask_count, row.answered_by, row.answer_msg_id,
      row.applied_ref, row.note, row.created_at, row.updated_at).run();
  await e.DB.prepare(
    "INSERT INTO review_reports(id,group_id,date,run_id,mode,body,items,state,created_at) VALUES(?,?,?,?,?,?,?,'queued',?)",
  ).bind(extra.reportId || REPORT, G, '2026-11-14', 'run-1', 'propose', '晨报', JSON.stringify(items), 1000).run();
  return e;
}

const replyTo = (id = REPORT) => ({ kind: 'bot', targetId: id });
const reply = (e, text, over = {}) => handleLearningReply(e, {
  groupId: G, messageId: 'a1', sender: 'U1', text, mentioned: false, replyTo: replyTo(), ...over,
});

function schedule(e, id, owner = 'U1', outboxId = null) {
  const due = Date.now() + 3600000;
  return (async () => {
    await e.DB.prepare(
      "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,'{\"time\":\"08:00\"}','active',?,0,?,'m0')",
    ).bind(id, G, owner, 'digest_daily', 'Australia/Sydney', due, 1000).run();
    if (outboxId)
      await e.DB.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?,?,?,?,?)")
        .bind('run-' + id, id, due, 'ok', outboxId).run();
    return outboxId || id;
  })();
}

// ---- parseAnswer 纯函数表 ----

test('P1 NO 优先于 YES，编号 1–3 / 一二三，都=all', () => {
  assert.deepEqual(parseAnswer('1 可以', [1, 2, 3]), { kind: 'yes', nos: [1], all: false });
  assert.deepEqual(parseAnswer('２ 好的', [1, 2, 3]), { kind: 'yes', nos: [2], all: false });
  assert.deepEqual(parseAnswer('一、三 要', [1, 2, 3]), { kind: 'yes', nos: [1, 3], all: false });
  assert.deepEqual(parseAnswer('都行', [1, 2, 3]), { kind: 'yes', nos: [1, 2, 3], all: true });
  assert.deepEqual(parseAnswer('全部不用', [1, 2, 3]), { kind: 'no', nos: [1, 2, 3], all: true });
  assert.deepEqual(parseAnswer('不对', [1]), { kind: 'no', nos: [1], all: false });
  assert.deepEqual(parseAnswer('1 不要', [1, 2]), { kind: 'no', nos: [1], all: false });
});
test('P2 无编号单项=那一项；多项=ambiguous；>30 字=none；@/表情/全角剥离', () => {
  assert.deepEqual(parseAnswer('好', [2]), { kind: 'yes', nos: [2], all: false });
  assert.deepEqual(parseAnswer('好', [1, 2]), { kind: 'ambiguous', nos: [], all: false });
  assert.deepEqual(parseAnswer('1 2', [1, 2, 3]), { kind: 'ambiguous', nos: [1, 2], all: false });
  assert.deepEqual(parseAnswer('这'.repeat(31) + '可以', [1]), { kind: 'none', nos: [], all: false });
  assert.deepEqual(parseAnswer('@小王 １可以 👍🏻', [1, 2]), { kind: 'yes', nos: [1], all: false });
  assert.deepEqual(parseAnswer('随便吧', [1]), { kind: 'none', nos: [], all: false });
});

// ---- 快速放行 ----

test('P3 不满足 A/B 时 0 次 D1 且 return false', async () => {
  const e = env();
  assert.equal(await reply(e, '今天天气不错', { replyTo: undefined }), false);
  assert.equal(await reply(e, '这个视频讲了啥', { replyTo: { kind: 'bot', targetId: 'other:1' } }), false);
  assert.equal(await reply(e, '随便说说', { mentioned: true, replyTo: undefined }), false);
  assert.equal(e.DB.executed, 0);
});

// ---- 学习开关 ----

test('P4 learn:mode=off 时 A/B 不拦截，推送取消 A 仍生效', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await e.DB.prepare("INSERT INTO settings VALUES('learn:mode','off')").run();
  assert.equal(await reply(e, '1 可以'), false);
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'asked');
  const out = await schedule(e, 'sched-digest_daily-m0', 'U1', 'sched-digest_daily-m0-1');
  assert.equal(await reply(e, '不用发了', { messageId: 'a2', replyTo: replyTo(out) }), true);
  assert.equal((await one(e, 'SELECT status FROM schedules WHERE id=?', 'sched-digest_daily-m0')).status, 'cancelled');
});

// ---- 分派表 ----

test('P5 本人确认 avoid_phrase → canary 规则 + expressions 关闭 + 回执', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await e.DB.prepare("INSERT INTO expressions VALUES('绝了','表示离谱','群聊','[]','[]',3,2,2,'2026-11-14')").run();
  assert.equal(await reply(e, '1 可以'), true);
  const rule = (await rows(e, 'behavior_rules'))[0];
  assert.equal(rule.status, 'canary');
  assert.ok(rule.rule && rule.rule.includes('绝了'));
  assert.equal(rule.source, 'member:U1');
  assert.equal(rule.approved_by, 'member:U1');
  assert.ok(rule.canary_until > Date.now() + 2 * 86400000);
  assert.ok(rule.expires_at > Date.now() + 29 * 86400000);
  assert.equal((await one(e, "SELECT enabled FROM expressions WHERE phrase='绝了'")).enabled, 0);
  assert.equal((await one(e, "SELECT status,applied_ref FROM review_learnings WHERE id='ln-1'")).status, 'applied');
  const ack = await one(e, "SELECT * FROM outbox WHERE id='learn-ack:a1'");
  assert.ok(ack && ack.body.includes('好，记下了：别再说「绝了」'));
  assert.ok(ack.body.includes('不对就回这条说「不对」'));
});

test('P6 日程确认 → createSchedule(origin review)，回执带第一次时间', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }], [learning({
    kind: 'schedule', subkind: 'daily', params: JSON.stringify({ time: '08:00', topic: '礼物日早报' }), plain: '每天早上8点发礼物日早报',
  })]);
  assert.equal(await reply(e, '1 可以'), true);
  const s = (await rows(e, 'schedules'))[0];
  assert.equal(s.kind, 'digest_daily');
  assert.equal(s.owner, 'U1');
  const spec = JSON.parse(s.spec);
  assert.equal(spec.time, '08:00');
  assert.equal(spec.topic, '礼物日早报');
  assert.equal(spec.origin, 'review');
  assert.equal((await one(e, "SELECT applied_ref FROM review_learnings WHERE id='ln-1'")).applied_ref, s.id);
  const ack = await one(e, "SELECT body FROM outbox WHERE id='learn-ack:a1'");
  assert.ok(/，(今天|明天) 08:00 第一次/.test(ack.body), ack.body);
});

test('P7 非本人非管理员确认 → 只回提示、不写规则', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await e.DB.prepare("INSERT INTO member_names VALUES('U1','小王','qq','2026-11-14')").run();
  assert.equal(await reply(e, '1 可以', { sender: 'U2', messageId: 'a2' }), true);
  assert.equal((await rows(e, 'behavior_rules')).length, 0);
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'asked');
  assert.equal((await one(e, "SELECT body FROM outbox WHERE id='learn-ack:a2'")).body, '这条要小王本人说一声才算。');
});

test('P8 本人 no → declined；他人 no → disputed，都不写规则', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  assert.equal(await reply(e, '1 不用'), true);
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'declined');
  assert.equal((await one(e, "SELECT body FROM outbox WHERE id='learn-ack:a1'")).body, '好，这条先不记。');
  const other = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  assert.equal(await reply(other, '1 不用', { sender: 'U2', messageId: 'a2' }), true);
  assert.equal((await one(other, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'disputed');
  assert.ok((await one(other, "SELECT body FROM outbox WHERE id='learn-ack:a2'")).body.includes('有人觉得不合适'));
  assert.equal((await rows(other, 'behavior_rules')).length, 0);
});

test('P9 ambiguous → 问回数字，不写任何东西', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }, { no: 2, learning_id: 'ln-2' }], [
    learning(), learning({ id: 'ln-2', subkind: 'address_as', params: JSON.stringify({ member: 'U1', name: '小明' }), plain: '叫我小明' }),
  ]);
  assert.equal(await reply(e, '好'), true);
  assert.ok((await one(e, "SELECT body FROM outbox WHERE id='learn-ack:a1'")).body.includes('要记哪几条？'));
  assert.equal((await rows(e, 'behavior_rules')).length, 0);
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'asked');
});

test('P10 推送回复「不用发了」→ 取消；非 owner 只提示；管理员可取消', async () => {
  const e = await fixture([], []);
  const out = await schedule(e, 'sched-digest_daily-m0', 'U1', 'sched-digest_daily-m0-1');
  assert.equal(await reply(e, '不用发了', { replyTo: replyTo(out) }), true);
  assert.equal((await one(e, 'SELECT status FROM schedules WHERE id=?', 'sched-digest_daily-m0')).status, 'cancelled');
  const ack = await one(e, "SELECT body FROM outbox WHERE id='sched-cancel:a1'");
  assert.ok(ack.body.includes('停了') && ack.body.includes('每天 08:00'));

  const e2 = await fixture([], []);
  const out2 = await schedule(e2, 'sched-digest_daily-m2', 'U1', 'sched-digest_daily-m2-1');
  assert.equal(await reply(e2, '不用发了', { sender: 'U2', messageId: 'a2', replyTo: replyTo(out2) }), true);
  assert.equal((await one(e2, 'SELECT status FROM schedules WHERE id=?', 'sched-digest_daily-m2')).status, 'active');
  assert.ok((await one(e2, "SELECT body FROM outbox WHERE id='sched-cancel:a2'")).body.includes('只有建立它的人或管理员'));

  const e3 = await fixture([], []);
  const out3 = await schedule(e3, 'sched-digest_daily-m3', 'U1', 'sched-digest_daily-m3-1');
  await e3.DB.prepare("INSERT INTO members VALUES('U2','管理员','h2','admin',0)").run();
  assert.equal(await reply(e3, '不用发了', { sender: 'U2', messageId: 'a3', replyTo: replyTo(out3) }), true);
  assert.equal((await one(e3, 'SELECT status FROM schedules WHERE id=?', 'sched-digest_daily-m3')).status, 'cancelled');
});

test('P11 回执回「不对」24 小时内撤销规则；超时不撤', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await reply(e, '1 可以');
  assert.equal(await reply(e, '不对', { messageId: 'u1', replyTo: replyTo('learn-ack:a1') }), true);
  const rule = (await rows(e, 'behavior_rules'))[0];
  assert.equal(rule.status, 'retired');
  assert.equal(rule.rollback_reason, 'member_undo');
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'declined');
  assert.ok((await one(e, "SELECT body FROM outbox WHERE id='learn-undo:u1'")).body.includes('好，撤回了：'));

  const late = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await reply(late, '1 可以');
  await late.DB.prepare("UPDATE learning_acks SET created_at=? WHERE outbox_id='learn-ack:a1'").bind(Date.now() - 25 * 3600000).run();
  assert.equal(await reply(late, '不对', { messageId: 'u2', replyTo: replyTo('learn-ack:a1') }), false);
  assert.equal((await one(late, 'SELECT status FROM behavior_rules')).status, 'canary');
});

test('P12 同一条回复重放两次：规则/日程/回执最终状态一致', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await reply(e, '1 可以');
  await reply(e, '1 可以');
  assert.equal((await rows(e, 'behavior_rules')).length, 1);
  assert.equal((await rows(e, 'outbox')).filter((o) => o.id === 'learn-ack:a1').length, 1);
  assert.equal((await rows(e, 'learning_acks')).length, 1);
  const s = await fixture([{ no: 1, learning_id: 'ln-1' }], [learning({ kind: 'schedule', subkind: 'daily', params: JSON.stringify({ time: '08:00', topic: '早报' }), plain: '每天8点发早报' })]);
  await reply(s, '1 可以');
  await reply(s, '1 可以');
  assert.equal((await rows(s, 'schedules')).length, 1);
});

// ---- worker 入站钩子 ----

test('P13 被处理的消息照常入库，但不进聊天 job', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }], [learning({ requester: 'member1' })]);
  await req(e, '/api/admin/bind', { groupId: G });
  await e.DB.prepare("INSERT INTO message_refs VALUES('REF1','bot',?,?,0)").bind(REPORT, G).run();
  await qq(e, { ...msg('ans1', '1 可以'), message_scene: { ext: ['ref_msg_idx=REF1'] } });
  assert.ok(await one(e, "SELECT id FROM messages WHERE id='ans1'"));
  assert.equal((await rows(e, 'jobs')).filter((j) => j.id === 'chat-ans1').length, 0);
  assert.ok(await one(e, "SELECT id FROM outbox WHERE id='learn-ack:ans1'"));
  assert.equal((await rows(e, 'behavior_rules'))[0].status, 'canary');
});

test('P14 管理员可代确认/代拒绝他人条目', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await e.DB.prepare("INSERT INTO members VALUES('U2','管理员','h2','admin',0)").run();
  assert.equal(await reply(e, '1 可以', { sender: 'U2', messageId: 'a2' }), true);
  assert.equal((await one(e, 'SELECT approved_by FROM behavior_rules')).approved_by, 'member:U2');
  const no = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await no.DB.prepare("INSERT INTO members VALUES('U2','管理员','h2','admin',0)").run();
  assert.equal(await reply(no, '1 不用', { sender: 'U2', messageId: 'a3' }), true);
  assert.equal((await one(no, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'declined');
});

test('P15 晨报里已生效的编号项回「不用」→ 撤销', async () => {
  const e = await fixture([{ no: 1, learning_id: 'ln-1' }]);
  await reply(e, '1 可以');
  assert.equal(await reply(e, '1 不用', { messageId: 'a2' }), true);
  assert.equal((await one(e, 'SELECT status FROM behavior_rules')).status, 'retired');
  assert.equal((await one(e, "SELECT status FROM review_learnings WHERE id='ln-1'")).status, 'declined');
  assert.ok((await one(e, "SELECT body FROM outbox WHERE id='learn-undo:a2'")).body.includes('好，撤回了：'));
});
