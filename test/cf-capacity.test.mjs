import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { env, worker } from './support.mjs';
import { validateTeamConfig } from '../config/validate.mjs';

const settings = JSON.parse(readFileSync(new URL('../config/team.json', import.meta.url), 'utf8'));
const capacityOut = `.wrangler/cf-capacity-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export * from "./src/memory-budget"; export {stage,flushTail} from "./src/timing"; export * from "./src/kb";',
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: capacityOut,
});
const { fitMemoryMessages, MEMORY_BATCH_CHAR_BUDGET, stage, flushTail, KB_MAX_CHUNKS_PER_DOC, KB_MAX_CHUNKS_PER_GROUP } =
  await import('../' + capacityOut);

const bindingOut = `.wrangler/cf-d1-binding-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export {metered,left} from "./src/d1";', resolveDir: process.cwd(), loader: 'ts' },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: bindingOut,
});
const { metered, left } = await import('../' + bindingOut);

test('CF-6 capacity settings: 5,000 sticker rows, unchanged KB document and group ceilings', () => {
  assert.deepEqual(validateTeamConfig(settings), []);
  assert.equal(settings.stickers.max_rows, 5000);
  assert.equal(settings.memory.messages_per_batch, 120);
  assert.equal(settings.memory.batches_per_night, 8);
  assert.equal(KB_MAX_CHUNKS_PER_DOC, 1600);
  assert.equal(KB_MAX_CHUNKS_PER_GROUP, 50000);

  const tooManyRows = structuredClone(settings);
  tooManyRows.stickers.max_rows = 5001;
  assert.ok(validateTeamConfig(tooManyRows).includes('stickers.max_rows'));

  const tooManyMessages = structuredClone(settings);
  tooManyMessages.memory.messages_per_batch = 121;
  assert.ok(validateTeamConfig(tooManyMessages).some((x) => x.startsWith('memory.messages_per_batch')));
});

test('CF-6 storage stays inside the self-imposed 5 GB account ceiling and the 2 GB sticker budget', () => {
  const stickers = readFileSync(new URL('../src/stickers.ts', import.meta.url), 'utf8');
  assert.match(stickers, /D1_STORE_MAX_BYTES\s*=\s*5_000_000_000/);
  assert.match(stickers, /STICKER_STORE_MAX_BYTES\s*=\s*2_000_000_000/);
  const docs = readFileSync(new URL('../docs/maintenance.md', import.meta.url), 'utf8');
  assert.match(docs, /5\s?GB/);
  assert.match(docs, /5000\s?行/);
});

test('CF-7 sixty stage events flush in chunks below D1\'s 100-bound-parameter limit', async () => {
  const base = env();
  const e = metered(base);
  const bindings = [];
  const prepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql) => {
    const s = prepare(sql);
    const bind = s.bind.bind(s);
    s.bind = (...args) => { bindings.push(args.length); assert.ok(args.length <= 100, sql + ' ' + args.length); return bind(...args); };
    return s;
  };
  for (let i = 0; i < 60; i++) stage(e, 'turn-' + i, 'model_start', { kind: 'chat', i });
  await flushTail(e);
  const rows = await base.DB.prepare('SELECT * FROM stage_timings').all();
  assert.equal(rows.results.length, 60);
  assert.deepEqual(bindings, [96, 96, 48]);
  assert.equal(e.tail.timing.length, 0);
});

test('CF-7 a 120-message batch is trimmed to the memory input budget from the oldest end', () => {
  assert.equal(MEMORY_BATCH_CHAR_BUDGET, 40000);
  const rows = Array.from({ length: 120 }, (_, i) => ({ id: 'm' + i, body: 'x'.repeat(3000) }));
  const kept = fitMemoryMessages(rows);
  const total = kept.reduce((n, row) => n + row.body.length, 0);
  assert.ok(total <= MEMORY_BATCH_CHAR_BUDGET, String(total));
  assert.equal(total, MEMORY_BATCH_CHAR_BUDGET);
  assert.equal(kept[0].id, 'm106');
  assert.equal(kept[0].body.length, 1000, 'the oldest kept message is cut, not the newest');
  assert.equal(kept.at(-1).id, 'm119');
  assert.equal(kept.length, 14);

  const short = Array.from({ length: 120 }, (_, i) => ({ id: 's' + i, body: '短消息' }));
  assert.equal(fitMemoryMessages(short).length, 120);
  assert.deepEqual(fitMemoryMessages([{ id: 'empty', body: '' }]).map((x) => x.id), ['empty']);
});

test('CF-7 a real 120-message dream job keeps every D1 bind under 100, fits the prompt budget and marks all messages processed', async () => {
  const e = env();
  const ids = [];
  for (let i = 0; i < 120; i++) {
    const id = 'night-' + i;
    ids.push(id);
    await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)')
      .bind(id, 'GROUP000001', 's' + (i % 3), ('abcdefghi ' + (i % 10) + ' ').repeat(40), new Date(Date.now() + i).toISOString())
      .run();
  }
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
    .bind('dream-120', 'dream', JSON.stringify({ messageIds: ids, dream: true, key: 'dream-120', date: '2026-11-14' }), Date.now())
    .run();

  const bindings = [];
  const prepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql) => {
    const s = prepare(sql);
    const bind = s.bind.bind(s);
    s.bind = (...args) => { bindings.push(args.length); return bind(...args); };
    return s;
  };

  const old = globalThis.fetch;
  let prompt = null;
  globalThis.fetch = async (target, init) => {
    if (String(target).includes('api.deepseek.com')) {
      const body = JSON.parse(init.body);
      prompt = JSON.parse(body.messages[1].content);
      return Response.json({ choices: [{ message: { content: '{"facts":[],"expressions":[],"reflection":"","self_note":""}' }, finish_reason: 'stop' }], usage: {} });
    }
    throw Error('unexpected fetch ' + target);
  };
  try {
    await worker.queue({ queue: 'inkboard-team', messages: [{ body: { id: 'dream-120' }, ack() {}, retry() {} }] }, e);
  } finally {
    globalThis.fetch = old;
  }

  assert.ok(prompt, 'the nightly model was called');
  const total = prompt.newMessages.reduce((n, m) => n + String(m.body || '').length, 0);
  assert.ok(total <= MEMORY_BATCH_CHAR_BUDGET, String(total));
  assert.ok(prompt.newMessages.length >= 80 && prompt.newMessages.length < 120, String(prompt.newMessages.length));
  assert.ok(bindings.length > 0 && Math.max(...bindings) <= 100, 'largest bind ' + Math.max(...bindings));

  const dream = await e.DB.prepare("SELECT sources,message_count FROM dreams WHERE id='dream-120'").first();
  assert.equal(dream.message_count, 120);
  assert.equal(JSON.parse(dream.sources).length, 120);
  const processed = await e.DB.prepare('SELECT COUNT(*) AS n FROM messages WHERE group_id=? AND processed=1').bind('GROUP000001').first();
  assert.equal(processed.n, 120, 'messages trimmed out of the prompt are still marked processed');
  const job = await e.DB.prepare("SELECT status FROM jobs WHERE id='dream-120'").first();
  assert.equal(job.status, 'done');
});

test('CF-7 docs describe 120 per night batch, 60 stage events and the paid-tier ceilings', () => {
  const docs = readFileSync(new URL('../docs/maintenance.md', import.meta.url), 'utf8');
  assert.match(docs, /每批最多\s*120\s*条/);
  assert.match(docs, /60\s*条阶段事件/);
  assert.match(docs, /1600\s*块/);
  assert.match(docs, /50000\s*块/);
});

test('CF-6 schema still accepts 5,000 sticker rows with the capacity index', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const insert = d.prepare("INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) VALUES(?,?,?,?,0,'[\"a\"]',?)");
  for (let i = 0; i < 5000; i++) insert.run('sha-' + i, 'image/gif', 1, new Uint8Array([1]), Date.now());
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM stickers').get().n, 5000);
});
