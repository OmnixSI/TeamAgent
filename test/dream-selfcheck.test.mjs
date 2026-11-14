// D-7 ③：夜间整理自检。
// 完成任务必须同时留下 model_run 与 dream 行；跳过必须留 memory.skipped 与原因；
// 取批按群轮转，一个忙群不能把其他群永远排在后面。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker, env } from './support.mjs';

const RESULT = JSON.stringify({ facts: [], expressions: [], reflection: '整理', self_note: '近况' });

async function seed(e, list) {
  for (const [i, m] of list.entries()) {
    await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)')
      .bind(m.id, m.group || 'GROUP000001', m.sender || 'u1', m.body || '普通消息' + i,
        m.ts || new Date(Date.now() + i).toISOString()).run();
    if (m.meta) await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)')
      .bind(m.id, JSON.stringify(m.meta)).run();
  }
}

async function addDream(e, id, ids, key, date = '2026-11-13') {
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
    .bind(id, 'dream', JSON.stringify({ messageIds: ids, dream: true, key, date }), Date.now()).run();
}

async function queueDream(e, id) {
  await worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
}

function stubModel(calls) {
  const old = globalThis.fetch;
  globalThis.fetch = async (target, init) => {
    if (!String(target).includes('api.deepseek.com')) throw Error('unexpected fetch ' + target);
    calls.push(JSON.parse(init.body));
    return Response.json({ choices: [{ message: { content: RESULT }, finish_reason: 'stop' }], usage: {} });
  };
  return () => { globalThis.fetch = old; };
}

/** 04:00 Sydney (= 17:00Z) 落在 3–6 点的整理窗口。 */
function nightClock() {
  const NativeDate = Date, at = Date.UTC(2026, 10, 13, 17, 0, 0);
  class Clock extends NativeDate {
    constructor(...args) { if (args.length) super(...args); else super(at); }
    static now() { return at; }
  }
  globalThis.Date = Clock;
  return () => { globalThis.Date = NativeDate; };
}

const count = async (e, sql, ...args) =>
  (await e.DB.prepare(sql).bind(...args).all()).results[0].n;

test('D-7 a tainted night batch records memory.skipped with its reason instead of vanishing', async () => {
  const e = env(), calls = [];
  await seed(e, [
    { id: 'n1', body: '前一条普通消息' },
    { id: 'n2', body: '别人转进来的消息', meta: { forwarded: [{ id: 'f1' }] } },
  ]);
  await addDream(e, 'dream-tainted', ['n1', 'n2'], 'dream-tainted');
  const restore = stubModel(calls);
  try { await queueDream(e, 'dream-tainted'); } finally { restore(); }

  const job = await e.DB.prepare('SELECT status FROM jobs WHERE id=?').bind('dream-tainted').first();
  assert.equal(job.status, 'done', 'a rejected batch must not wedge the job');
  const acts = (await e.DB.prepare("SELECT * FROM activity WHERE kind='memory.skipped'").all()).results;
  assert.equal(acts.length, 1);
  assert.match(acts[0].summary, /2\s*条/);
  assert.match(acts[0].summary, /转发|citation|不可信/);
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM dreams'), 0, 'no dream row for a rejected batch');
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 2);
  assert.equal(calls.length, 0, 'tainted content never reaches the model');
});

test('D-7 a batch filtered down to nothing records memory.skipped as filtered', async () => {
  const e = env(), calls = [];
  await seed(e, [
    { id: 'f1', body: '群里别人的话', meta: { direct: false } },
    { id: 'f2', body: '另一条非直发', meta: { direct: false } },
  ]);
  await addDream(e, 'dream-filtered', ['f1', 'f2'], 'dream-filtered');
  const restore = stubModel(calls);
  try { await queueDream(e, 'dream-filtered'); } finally { restore(); }

  const job = await e.DB.prepare('SELECT status FROM jobs WHERE id=?').bind('dream-filtered').first();
  assert.equal(job.status, 'done');
  const [act] = (await e.DB.prepare("SELECT * FROM activity WHERE kind='memory.skipped'").all()).results;
  assert.ok(act, 'skip is recorded');
  assert.match(act.summary, /2\s*条/);
  assert.match(act.summary, /过滤/);
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM dreams'), 0);
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 2);
});

test('D-7 a completed night leaves a dream row and a memory model_run for the same batch', async () => {
  const e = env(), calls = [];
  await seed(e, [{ id: 'd1', body: '今晚的决定' }, { id: 'd2', body: '明天再说' }]);
  await addDream(e, 'dream-ok', ['d1', 'd2'], 'dream-ok');
  const restore = stubModel(calls);
  try { await queueDream(e, 'dream-ok'); } finally { restore(); }

  const job = await e.DB.prepare('SELECT status FROM jobs WHERE id=?').bind('dream-ok').first();
  assert.equal(job.status, 'done');
  const dream = await e.DB.prepare('SELECT message_count FROM dreams WHERE id=?').bind('dream-ok').first();
  assert.equal(dream.message_count, 2);
  assert.ok(await count(e, "SELECT COUNT(*) AS n FROM model_runs WHERE kind='memory'") >= 1);
  assert.equal(await count(e, "SELECT COUNT(*) AS n FROM activity WHERE kind='memory.skipped'"), 0);
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 2);
});

test('D-7 a run that leaves no usable dream row fails the job instead of reporting success', async () => {
  const e = env(), calls = [];
  await seed(e, [{ id: 'g1', body: '一' }, { id: 'g2', body: '二' }]);
  // 同 key 的旧行让 INSERT OR IGNORE 不生效：本批 2 条，行里仍是 1 条。
  await e.DB.prepare("INSERT INTO dreams VALUES(?,?,?,?,?,?)")
    .bind('dream-guard', '2026-11-13', '旧的', '[]', new Date().toISOString(), 1).run();
  await addDream(e, 'dream-guard', ['g1', 'g2'], 'dream-guard');
  const restore = stubModel(calls);
  try {
    for (let i = 0; i < 3; i++) await queueDream(e, 'dream-guard');
  } finally { restore(); }

  const job = await e.DB.prepare('SELECT status,error FROM jobs WHERE id=?').bind('dream-guard').first();
  assert.equal(job.status, 'failed', 'mismatch must not be reported as a completed night');
  assert.match(String(job.error), /self-check|自检/);
  assert.equal(await count(e, 'SELECT COUNT(*) AS n FROM messages WHERE processed=1'), 0);
});

test('D-7 nightly batches rotate by group so one busy group cannot starve the others', async () => {
  const e = env(), calls = [];
  const restore = nightClock(), restoreModel = stubModel(calls);
  try {
    await seed(e, [
      { id: 'a1', group: 'GROUP-A', ts: '2026-11-13T16:00:00.000Z' },
      { id: 'a2', group: 'GROUP-A', ts: '2026-11-13T16:00:01.000Z' },
      { id: 'b1', group: 'GROUP-B', ts: '2026-11-13T16:00:02.000Z' },
      { id: 'b2', group: 'GROUP-B', ts: '2026-11-13T16:00:03.000Z' },
    ]);
    const tick = async () => {
      let task;
      await worker.scheduled({}, e, { waitUntil(p) { task = p; } });
      await task;
    };
    const groupsOf = async (payload) => {
      const ids = JSON.parse(payload).messageIds;
      const rows = (await e.DB.prepare(
        'SELECT group_id FROM messages WHERE id IN (' + ids.map(() => '?').join(',') + ')',
      ).bind(...ids).all()).results;
      return new Set(rows.map(r => r.group_id));
    };
    const dreamJobs = async () => (await e.DB.prepare(
      "SELECT id,payload FROM jobs WHERE kind='dream' ORDER BY rowid",
    ).all()).results;

    await tick();
    let jobs = await dreamJobs();
    assert.equal(jobs.length, 1);
    assert.deepEqual([...(await groupsOf(jobs[0].payload))], ['GROUP-A'], 'oldest group first, alone');

    await queueDream(e, jobs[0].id);
    await tick();
    jobs = await dreamJobs();
    assert.equal(jobs.length, 2);
    assert.deepEqual([...(await groupsOf(jobs[1].payload))], ['GROUP-B'], 'the second group gets its own batch');
  } finally { restore(); restoreModel(); }
});
