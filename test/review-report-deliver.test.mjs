// B · L5 晨报投递：窗口、幂等、开关、禁词、跨日与当日上限。
// 只用本地内存库；不触碰线上 D1，不发任何群消息。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const out = `.wrangler/review-report-deliver-${process.pid}.mjs`;
await build({
  entryPoints: ['src/review-report.ts'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: out,
});
const api = await import('../' + out);
after(() => rmSync(out, { force: true }));

const SCHEMA = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const BODY = '昨晚我发现自己接话太快了。\n今天先听完再说。';
const DAY = '2026-11-14';

/** 悉尼 2026-11-14（AEDT，UTC+11）的本地时刻 → UTC 毫秒。 */
const sydney = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return Date.UTC(2026, 10, 14, h - 11, m);
};

function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  let prepares = 0;
  const stmt = (sql, args = []) => ({
    sql,
    args,
    bind(...values) {
      return stmt(sql, values);
    },
    async run() {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
    async first() {
      return db.prepare(sql).get(...args) ?? null;
    },
    async all() {
      return { results: db.prepare(sql).all(...args) };
    },
  });
  const e = {
    DB: {
      prepare(sql) {
        prepares++;
        return stmt(sql);
      },
      async batch(list) {
        const results = [];
        for (const statement of list) results.push(await statement.run());
        return results;
      },
    },
    db,
    get prepares() {
      return prepares;
    },
  };
  return e;
}

let seq = 0;
function seedReport(db, patch = {}) {
  const row = {
    id: 'rr-' + ++seq,
    group_id: 'group-aaaa',
    date: DAY,
    body: BODY,
    state: 'ready',
    reason: null,
    created_at: 1,
    ...patch,
  };
  db.prepare(
    'INSERT INTO review_reports(id,group_id,date,run_id,mode,body,items,state,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
  ).run(row.id, row.group_id, row.date, 'run-1', 'shadow', row.body, '[]', row.state, row.reason, row.created_at);
  return row;
}

const run = (e, ms) => api.reviewReportJob.run(e, new Date(ms));

test('job is registered as review-report', () => {
  assert.equal(api.reviewReportJob.name, 'review-report');
  assert.equal(typeof api.reviewReportJob.run, 'function');
});

test('outside 08:40–10:00 Sydney makes zero D1 calls', async () => {
  for (const at of [sydney('08:39'), sydney('10:01'), sydney('03:00')]) {
    let calls = 0;
    const e = {
      DB: {
        prepare() {
          calls++;
          throw new Error('outside the report window the job must not touch D1');
        },
      },
      db: null,
    };
    await run(e, at);
    assert.equal(calls, 0, new Date(at).toISOString());
  }
});

test('window includes both edges', async () => {
  for (const at of [sydney('08:40'), sydney('10:00')]) {
    const e = makeEnv();
    seedReport(e.db);
    await run(e, at);
    assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1, new Date(at).toISOString());
  }
});

test('one ready report queues exactly one outbox row and ten ticks stay one', async () => {
  const e = makeEnv();
  seedReport(e.db);
  const first = sydney('08:40');
  for (let i = 0; i < 10; i++) await run(e, first + i * 60000);

  const rows = e.db.prepare('SELECT * FROM outbox').all();
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, {
    id: 'reflection-report:' + DAY,
    group_id: 'group-aaaa',
    msg_id: null,
    body: BODY,
    status: 'pending',
    created_at: first,
  });
  const report = e.db.prepare('SELECT state,queued_at FROM review_reports').get();
  assert.deepEqual({ ...report }, { state: 'queued', queued_at: first });
});

test('two groups on the same day get distinct suffixed ids', async () => {
  const e = makeEnv();
  seedReport(e.db, { group_id: 'group-aaaa' });
  seedReport(e.db, { group_id: 'group-bbbb' });
  await run(e, sydney('08:40'));
  const ids = e.db.prepare('SELECT id FROM outbox ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, [
    'reflection-report:' + DAY + ':group-aa',
    'reflection-report:' + DAY + ':group-bb',
  ]);
  assert.equal(e.db.prepare("SELECT COUNT(*) AS n FROM review_reports WHERE state='queued'").get().n, 2);
});

test('off:review_report and learn:mode=off both stop delivery and mark skipped', async () => {
  for (const [key, value] of [['off:review_report', '1'], ['learn:mode', 'off']]) {
    const e = makeEnv();
    seedReport(e.db);
    e.db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key, value);
    await run(e, sydney('08:40'));
    assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0, key);
    assert.deepEqual(
      { ...e.db.prepare('SELECT state,reason FROM review_reports').get() },
      { state: 'skipped', reason: 'off' },
      key,
    );
  }
});

test('REPORT_DENY holds only the offending group and logs activity', async () => {
  const e = makeEnv();
  seedReport(e.db, { group_id: 'group-aaaa', body: '昨晚我只发现了一次 trace 问题。' });
  seedReport(e.db, { group_id: 'group-bbbb', body: '昨晚我发现自己说话太急。' });
  await run(e, sydney('08:40'));

  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  const queued = e.db.prepare('SELECT id,group_id,body FROM outbox').get();
  assert.equal(queued.group_id, 'group-bbbb');
  assert.equal(queued.id, 'reflection-report:' + DAY + ':group-bb');
  assert.deepEqual(
    { ...e.db.prepare("SELECT state,reason FROM review_reports WHERE group_id='group-aaaa'").get() },
    { state: 'held', reason: 'deny' },
  );
  const activity = e.db.prepare("SELECT * FROM activity WHERE kind='review_report_held'").all();
  assert.equal(activity.length, 1);
  assert.equal(activity[0].entity, 'group-aaaa');
  assert.ok(!activity[0].summary.includes('trace'), 'activity must not repeat the deny word');
});

test('no ready report means no outbox and only the report lookup', async () => {
  const e = makeEnv();
  seedReport(e.db, { state: 'skipped', reason: 'nothing_to_say' });
  await run(e, sydney('08:40'));
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 0);
  assert.equal(e.prepares, 1);
});

test('the next Sydney day uses a new date key', async () => {
  const e = makeEnv();
  seedReport(e.db, { date: '2026-11-14' });
  await run(e, sydney('08:40'));
  seedReport(e.db, { date: '2026-11-15', id: 'rr-next-day' });
  await run(e, Date.parse('2026-11-14T21:40:00Z')); // 2026-11-15 08:40 Sydney
  const ids = e.db.prepare('SELECT id FROM outbox ORDER BY id').all().map((r) => r.id);
  assert.deepEqual(ids, ['reflection-report:2026-11-14', 'reflection-report:2026-11-15']);
});

test('global max_sends_day cap counts scheduled pushes and earlier reports', async () => {
  const e = makeEnv();
  const start = Date.parse('2026-11-13T13:00:00Z'); // 2026-11-14 00:00 Sydney
  const due = start + 8 * 3600000; // 08:00 Sydney
  e.db.prepare(
    "INSERT INTO schedules(id,group_id,owner,kind,spec,status,created_at) VALUES('s1','group-cccc','u1','digest_daily','{}','active',?)",
  ).run(start);
  e.db.prepare(
    "INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES('run-s1','s1',?,'ok','sched-s1')",
  ).run(due);
  for (let i = 0; i < 19; i++) {
    e.db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run(
      `reflection-report:${DAY}:old-${i}`,
      'group-cccc',
      null,
      '旧晨报',
      'sent',
      due + i,
    );
  }
  seedReport(e.db);
  await run(e, sydney('08:40'));
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 19);
  assert.deepEqual(
    { ...e.db.prepare('SELECT state,reason FROM review_reports').get() },
    { state: 'skipped', reason: 'cap' },
  );
});

test("yesterday's pushes do not count against today's cap", async () => {
  const e = makeEnv();
  const yesterday = Date.parse('2026-11-12T22:00:00Z'); // 2026-11-13 09:00 Sydney
  e.db.prepare(
    "INSERT INTO schedules(id,group_id,owner,kind,spec,status,created_at) VALUES('s1','group-cccc','u1','digest_daily','{}','active',?)",
  ).run(yesterday);
  for (let i = 0; i < 20; i++) {
    e.db.prepare(
      "INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?, 's1', ?, 'ok', ?)",
    ).run('run-y-' + i, yesterday + i * 1000, 'sched-y-' + i);
  }
  seedReport(e.db);
  await run(e, sydney('08:40'));
  assert.equal(e.db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n, 1);
  assert.equal(e.db.prepare('SELECT state FROM review_reports').get().state, 'queued');
});

test('Sydney day boundaries hold across the DST transition', async () => {
  const e = makeEnv();
  const early = Date.parse('2026-10-03T14:30:00Z'); // 2026-10-04 00:30 Sydney (+10)
  const late = Date.parse('2026-10-04T12:30:00Z'); // 2026-10-04 23:30 Sydney (+11)
  e.db.prepare(
    "INSERT INTO schedules(id,group_id,owner,kind,spec,status,created_at) VALUES('s1','group-cccc','u1','digest_daily','{}','active',?)",
  ).run(early);
  for (let i = 0; i < 10; i++) {
    e.db.prepare(
      "INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?, 's1', ?, 'ok', ?)",
    ).run('run-e-' + i, early + i * 1000, 'sched-e-' + i);
    e.db.prepare(
      "INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?, 's1', ?, 'ok', ?)",
    ).run('run-l-' + i, late + i * 1000, 'sched-l-' + i);
  }
  seedReport(e.db, { date: '2026-10-04' });
  await run(e, Date.parse('2026-10-03T21:40:00Z')); // 2026-10-04 08:40 Sydney (+11)
  assert.deepEqual(
    { ...e.db.prepare('SELECT state,reason FROM review_reports').get() },
    { state: 'skipped', reason: 'cap' },
  );
});
