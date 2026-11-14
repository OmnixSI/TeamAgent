import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { env } from './support.mjs';

const outfile = `.wrangler/queue-batch-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/queue-batch";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile,
});
const { runQueueBatch, recordDlqBatch, isDlqQueue, DLQ_QUEUES } = await import('../' + outfile);

const wrangler = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
function consumer(name) {
  for (const raw of wrangler.split('[[queues.consumers]]').slice(1)) {
    const block = raw.split('[[')[0];
    if (new RegExp('^queue = "' + name + '"$', 'm').test(block)) return block;
  }
  return '';
}

test('CF-5 consumer config: WORK/TOOLS batch five at concurrency three, CHAT stays 1/1, both background lanes have a DLQ', () => {
  assert.deepEqual([...DLQ_QUEUES].sort(), ['inkboard-team-dlq', 'team-agent-tools-dlq']);
  for (const [queue, dlq] of [['inkboard-team', 'inkboard-team-dlq'], ['team-agent-tools', 'team-agent-tools-dlq']]) {
    const block = consumer(queue);
    assert.match(block, /max_batch_size = 5/, queue);
    assert.match(block, /max_concurrency = 3/, queue);
    assert.match(block, /max_retries = 2/, queue);
    assert.match(block, new RegExp('dead_letter_queue = "' + dlq + '"'), queue);
  }
  const chat = consumer('inkboard-team-chat');
  assert.match(chat, /max_batch_size = 1/);
  assert.match(chat, /max_concurrency = 1/);
  assert.doesNotMatch(chat, /dead_letter_queue/);
  for (const dlq of DLQ_QUEUES) assert.match(wrangler, new RegExp('queue = "' + dlq + '"'), 'DLQ consumer ' + dlq);
});

test('CF-5 five messages in one batch all run, each gets its own 200-statement meter and one shared outbox pass', async () => {
  const base = { DB: { prepare() { throw Error('no SQL expected'); } } };
  const seen = [], acks = [], retries = [], meters = new Set();
  let sends = 0, sendLimit = 0;
  const batch = {
    queue: 'inkboard-team',
    messages: [1, 2, 3, 4, 5].map((i) => ({ body: { id: 'm' + i }, ack() { acks.push(i); }, retry() { retries.push(i); } })),
  };
  const out = await runQueueBatch(
    batch,
    base,
    async (scope, id) => { seen.push(scope.meter.limit); meters.add(scope.meter); assert.equal(scope.meter.used, 0); },
    async (scope) => { sends++; sendLimit = scope.meter.limit; },
  );
  assert.deepEqual(out, { ok: 5, retried: 0 });
  assert.equal(seen.length, 5);
  assert.ok(seen.every((limit) => limit === 200), 'each message is metered independently at the background budget');
  assert.equal(meters.size, 5, 'five separate meters, not one shared batch meter');
  assert.deepEqual(acks, [1, 2, 3, 4, 5]);
  assert.deepEqual(retries, []);
  assert.equal(sends, 1, 'sendOutbox runs once per batch, not once per message');
  assert.equal(sendLimit, 200);
});

test('CF-5 one throwing message is retried without touching the other four', async () => {
  const base = { DB: { prepare() { throw Error('no SQL expected'); } } };
  const acks = [], retries = [], processed = [];
  let sends = 0;
  const batch = {
    queue: 'team-agent-tools',
    messages: [1, 2, 3, 4, 5].map((i) => ({ body: { id: 'm' + i }, ack() { acks.push(i); }, retry() { retries.push(i); } })),
  };
  const out = await runQueueBatch(
    batch,
    base,
    async (_scope, id) => { if (id === 'm3') throw Error('synthetic failure'); processed.push(id); },
    async () => { sends++; },
  );
  assert.deepEqual(out, { ok: 4, retried: 1 });
  assert.deepEqual(processed, ['m1', 'm2', 'm4', 'm5']);
  assert.deepEqual(acks, [1, 2, 4, 5]);
  assert.deepEqual(retries, [3]);
  assert.equal(sends, 1, 'the rest of the batch still flushes the outbox');
});

test('CF-5 retry twice then a DLQ delivery is counted and acknowledged without processing job ids', async () => {
  const base = { DB: { prepare() { throw Error('no SQL expected'); } } };
  const retries = [];
  const failing = { queue: 'inkboard-team', messages: [{ body: { id: 'poison' }, ack() {}, retry() { retries.push(1); } }] };
  for (let attempt = 0; attempt < 2; attempt++)
    await runQueueBatch(failing, base, async () => { throw Error('still failing'); }, async () => {});
  assert.equal(retries.length, 2, 'max_retries = 2 before the platform routes the message to the DLQ');

  const e = env();
  assert.equal(isDlqQueue('inkboard-team-dlq'), true);
  assert.equal(isDlqQueue('team-agent-tools-dlq'), true);
  assert.equal(isDlqQueue('inkboard-team'), false);
  const acks = [];
  let processed = 0;
  const dead = { queue: 'inkboard-team-dlq', messages: [1, 2, 3].map((i) => ({ body: { id: 'dead' + i }, ack() { acks.push(i); }, retry() {} })) };
  const out = await runQueueBatch(dead, e, async () => { processed++; }, async () => {});
  assert.deepEqual(out, { ok: 3, retried: 0 });
  assert.equal(processed, 0, 'DLQ downloads are counted, not executed as jobs');
  assert.deepEqual(acks, [1, 2, 3]);
  const count = (await e.DB.prepare("SELECT value FROM settings WHERE key='dlq:inkboard-team-dlq:count'").first()).value;
  const last = (await e.DB.prepare("SELECT value FROM settings WHERE key='dlq:inkboard-team-dlq:last'").first()).value;
  assert.equal(Number(count), 3);
  assert.ok(!Number.isNaN(Date.parse(last)));
});

test('CF-5 clearing a 100-message backlog takes twenty five-message invocations, not one hundred', async () => {
  const base = { DB: { prepare() { throw Error('no SQL expected'); } } };
  const done = [];
  let invocations = 0;
  const started = Date.now();
  for (let at = 0; at < 100; at += 5) {
    const batch = {
      queue: 'inkboard-team',
      messages: Array.from({ length: 5 }, (_, i) => ({ body: { id: at + i }, ack() { done.push(at + i); }, retry() {} })),
    };
    await runQueueBatch(batch, base, async (_scope, id) => { done.push(id); }, async () => {});
    invocations++;
  }
  assert.equal(invocations, 20);
  assert.equal(new Set(done).size, 100);
  assert.ok(Date.now() - started < 2000, 'a cheap 100-message drain stays well under two seconds');
});

test('CF-5 DLQ counters accumulate across batches and never throw on a malformed existing value', async () => {
  const e = env();
  await recordDlqBatch(e, 'team-agent-tools-dlq', 2);
  await recordDlqBatch(e, 'team-agent-tools-dlq', 1);
  const row = await e.DB.prepare("SELECT value FROM settings WHERE key='dlq:team-agent-tools-dlq:count'").first();
  assert.equal(Number(row.value), 3);
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('dlq:team-agent-tools-dlq:count','not-a-number')").run();
  await recordDlqBatch(e, 'team-agent-tools-dlq', 2);
  const fixed = await e.DB.prepare("SELECT value FROM settings WHERE key='dlq:team-agent-tools-dlq:count'").first();
  assert.equal(Number(fixed.value), 2);
});
