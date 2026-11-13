import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { env, worker } from './support.mjs';

const outfile = `.wrangler/scheduled-delivery-sweep-${process.pid}.mjs`;
await build({ stdin: { contents: 'export { sweepStuckDeliveries } from "./src/delivery-retry"; export { metered } from "./src/d1";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', outfile });
const { sweepStuckDeliveries, metered } = await import('../' + outfile);

async function seed(e, at, id = 'stuck', age = 2 * 3600000) {
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,'media',?,'done',?)")
    .bind('job-' + id, JSON.stringify({ title: '文件整理' }), at - age).run();
  // A missing source message exercises the fallback group lookup (the most expensive terminal path).
  await e.DB.prepare("INSERT INTO deliveries VALUES(?,?,?,'pending','[]',0,?)")
    .bind(id, 'job-' + id, 'missing-' + id, new Date(at - age).toISOString()).run();
}

async function tick(e, at, fakeQQ) {
  const NativeDate = globalThis.Date, nativeFetch = globalThis.fetch;
  class Clock extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [at])); }
    static now() { return at; }
  }
  globalThis.Date = Clock;
  globalThis.fetch = fakeQQ || (async () => assert.fail('replay must not access the network'));
  const before = e.DB.executed;
  try {
    let task;
    await worker.scheduled({}, e, { waitUntil(p) { task = p; } });
    await task;
    const used = e.DB.executed - before;
    assert.ok(used <= 200, `cron used ${used} SQL statements`);
    return used;
  } finally { globalThis.Date = NativeDate; globalThis.fetch = nativeFetch; }
}

for (const utc of ['2026-11-13T15:55:00Z', '2026-11-14T00:00:00Z', '2026-11-13T17:10:00Z']) {
  test(`scheduled closes stuck deliveries within 200 queries at ${utc}`, async (t) => {
    const e = env(), at = Date.parse(utc);
    await seed(e, at);
    await e.DB.prepare("INSERT INTO settings VALUES('group_id','GROUP000001')").run();
    const prepare = e.DB.prepare.bind(e.DB);
    let scans = 0;
    e.DB.prepare = sql => { if (/FROM deliveries WHERE status='pending' AND updated_at/.test(sql)) scans++; return prepare(sql); };
    if (utc.includes('T00:00:')) {
      await e.DB.prepare("INSERT INTO repo_commits VALUES('owner/repo',?,?,'author','old','','[]','',0)").bind('a'.repeat(40), at - 91 * 86400000).run();
    }
    t.diagnostic(`cron SQL: ${await tick(e, at)}/200`);
    assert.equal(scans, 1, 'the scheduled entry must execute the candidate SELECT');
    assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id='stuck'").first()).status, 'failed');
    assert.equal((await e.DB.prepare("SELECT needs_attention FROM delivery_retries WHERE delivery_id='stuck'").first()).needs_attention, 1);
    assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id='delivery-attention-stuck'").first()).n, 1);
    if (utc.includes('T00:00:')) assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM repo_commits').first()).n, 0, 'daily repo prune must still run');
    await tick(e, at + 60000);
    assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id='delivery-attention-stuck'").first()).n, 1, 'a later tick must not duplicate the notice');
  });
}

test('sweep reads candidates cheaply and defers a terminal row that cannot fit', async () => {
  const base = env(), at = Date.parse('2026-11-13T15:55:00Z');
  await seed(base, at);
  const e = metered(base, 9), before = base.DB.executed;
  await sweepStuckDeliveries(e, at, 1);
  assert.equal(base.DB.executed - before, 1, 'only the candidate SELECT fits');
  assert.equal((await base.DB.prepare("SELECT status FROM deliveries WHERE id='stuck'").first()).status, 'pending');
});

test('sweep stops between rows before exceeding its remaining query budget', async () => {
  const base = env(), at = Date.parse('2026-11-13T15:55:00Z');
  await base.DB.prepare("INSERT INTO settings VALUES('group_id','GROUP000001')").run();
  await seed(base, at, 'first', 3 * 3600000);
  await seed(base, at, 'second');
  const e = metered(base, 10), before = base.DB.executed;
  await sweepStuckDeliveries(e, at, 2);
  assert.equal(base.DB.executed - before, 10, 'one scan plus one worst-case terminal row');
  assert.deepEqual((await base.DB.prepare('SELECT id,status FROM deliveries ORDER BY id').all()).results.map(r => [r.id, r.status]), [['first', 'failed'], ['second', 'pending']]);
});

test('sweep can record a retry using four remaining statements', async () => {
  const base = env(), at = Date.parse('2026-11-13T15:55:00Z');
  await seed(base, at, 'young', 20 * 60000);
  const e = metered(base, 4), before = base.DB.executed;
  await sweepStuckDeliveries(e, at, 1);
  assert.equal(base.DB.executed - before, 4);
  assert.equal((await base.DB.prepare("SELECT needs_attention FROM delivery_retries WHERE delivery_id='young'").first()).needs_attention, 0);
  const exhausted = metered(base, 0), used = base.DB.executed;
  await sweepStuckDeliveries(exhausted, at, 1);
  assert.equal(base.DB.executed, used, 'zero remaining budget must issue no SQL');
});

test('scheduled sends a due digest and closes a stuck delivery in one background tick', async (t) => {
  const e = env(), at = Date.parse('2026-11-13T15:55:00Z');
  await e.DB.prepare("INSERT INTO settings VALUES('budget_cleanup_day','2026-11-14')").run();
  e.QQ_APP_ID = 'test-app';
  await seed(e, at);
  await e.DB.prepare("INSERT INTO settings VALUES('group_id','GROUP000001')").run();
  await e.DB.prepare("INSERT INTO schedules(id,group_id,owner,kind,spec,next_run_at,created_at) VALUES('daily','GROUP000001','owner','digest_daily',?,?,?)")
    .bind('{"time":"02:55"}', at, at - 86400000).run();
  let sends = 0, scans = 0;
  const prepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = sql => { if (/FROM deliveries WHERE status='pending' AND updated_at/.test(sql)) scans++; return prepare(sql); };
  const fakeQQ = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.bot.qq.com');
    if (String(url).endsWith('/getAppAccessToken')) return Response.json({ access_token: 'fake', expires_in: 300 });
    const body = JSON.parse(options.body);
    assert.match(body.content, /昨天群里没有新消息/);
    sends++;
    return Response.json({ id: 'fake-sent' });
  };
  t.diagnostic(`digest cron SQL: ${await tick(e, at, fakeQQ)}/200`);
  assert.equal(scans, 1, 'delivery discovery must run even during a due digest');
  assert.equal(sends, 1, 'the digest must be sent in its due tick');
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id='stuck'").first()).status, 'failed', 'the background budget closes the delivery in the same tick');
  assert.equal((await e.DB.prepare("SELECT status FROM schedule_runs WHERE schedule_id='daily'").first()).status, 'ok');
  await tick(e, at + 60000, fakeQQ);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id='stuck'").first()).status, 'failed');
  assert.equal(sends, 1, 'the completed digest must not be sent again');
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id='delivery-attention-stuck'").first()).n, 1);
});
