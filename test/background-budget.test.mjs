// CF-1/CF-2: after Workers Paid, chat stays at 48 statements while cron and the
// background queues get 200. These tests replay a backlog against a disposable
// SQLite: no QQ send, no production D1 write.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { env, worker } from './support.mjs';

const outfile = `.wrangler/background-budget-${process.pid}.mjs`;
await build({ stdin: { contents: 'export {D1_BUDGET,queueLimit} from "./src/d1";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'browser', format: 'esm', outfile });
const { D1_BUDGET, queueLimit } = await import('../' + outfile);

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
    assert.ok(used <= D1_BUDGET.background, `cron used ${used} SQL statements`);
    return used;
  } finally { globalThis.Date = NativeDate; globalThis.fetch = nativeFetch; }
}

const count = (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first().then(r => r.n);

test('chat keeps 64 statements while background queues and cron get 200', () => {
  assert.equal(D1_BUDGET.chat, 64);
  assert.equal(D1_BUDGET.background, 200);
  assert.equal(queueLimit('inkboard-team-chat'), 64);
  assert.equal(queueLimit('inkboard-team'), 200);
  assert.equal(queueLimit('team-agent-tools'), 200);
  assert.equal(queueLimit(undefined), 64, 'an unknown lane keeps the conservative budget');
});

test('fifty queued notices drain in five ticks without duplicates', async (t) => {
  const e = env(), at = Date.parse('2026-11-13T15:55:00Z'), sent = [];
  e.QQ_APP_ID = 'cf-background-budget';
  const fakeQQ = async (url, options) => {
    assert.equal(new URL(url).hostname, 'api.bot.qq.com');
    if (String(url).endsWith('/getAppAccessToken')) return Response.json({ access_token: 'fake', expires_in: 300 });
    sent.push(JSON.parse(options.body).content);
    return Response.json({ id: 'qq-' + sent.length });
  };
  for (let i = 0; i < 50; i++)
    await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,'pending',?)")
      .bind('cf-out-' + String(i).padStart(2, '0'), 'GROUP000001', null, '积压通知 ' + i, at).run();

  const counts = [];
  for (let n = 0; n < 5; n++) {
    counts.push(await tick(e, at + n * 60000, fakeQQ));
    if (n === 0) {
      assert.equal(sent.length, 10, 'one background tick may send at most ten');
      assert.ok(counts[0] > D1_BUDGET.chat, 'the backlog tick needs more than the chat budget');
    }
  }
  t.diagnostic('backlog cron SQL: ' + counts.join(','));
  assert.deepEqual(sent.slice().sort(), Array.from({ length: 50 }, (_, i) => '积压通知 ' + i).sort(), 'every notice sent exactly once');
  assert.equal(await count(e, "SELECT COUNT(*) n FROM outbox WHERE status='sent'"), 50);
});

test('thirty waiting videos are all woken within three ticks and never twice', async (t) => {
  const e = env(), at = Date.parse('2026-11-13T15:55:00Z');
  for (let i = 0; i < 30; i++)
    await e.DB.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,ready,status,lease_until,created_at,attempts,phase) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind('vw-' + i, 'GROUP000001', 'BV1xx411c7mD', 'src-' + i, JSON.stringify(['src-' + i]), 1, at - 1, 1, 'waiting', null, at - 1000, 0, 'light').run();

  // Consume each durable wake the way the video_reply job does: the wait leaves
  // the candidate set until its reply finishes.
  const claim = () => e.DB.prepare("UPDATE video_waits SET status='running',lease_until=? WHERE status='waiting' AND id IN (SELECT substr(id,7) FROM jobs WHERE kind='video_reply')").bind(at + 600000).run();

  await tick(e, at);
  assert.equal(await count(e, "SELECT COUNT(*) n FROM jobs WHERE kind='video_reply'"), 15, 'one tick wakes at most fifteen');
  await claim();
  await tick(e, at + 60000);
  assert.equal(await count(e, "SELECT COUNT(*) n FROM jobs WHERE kind='video_reply'"), 30);
  await claim();
  const used = await tick(e, at + 120000);
  t.diagnostic('video cron SQL (third tick): ' + used);
  assert.equal(await count(e, "SELECT COUNT(*) n FROM jobs WHERE kind='video_reply'"), 30, 'a third tick must not duplicate wakes');
  assert.ok(used <= D1_BUDGET.background);
});
