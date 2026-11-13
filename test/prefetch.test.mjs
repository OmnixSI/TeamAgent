import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worker, env, req, qq, msg } from './support.mjs';

const group = 'GROUP000001', short = 'AbCd1234', BV = 'BV1xx411c7mD';
const rows = (e, table) => e.DB.prepare('SELECT * FROM ' + table).all().then(x => x.results);
const queue = (e, id) => worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
const bind = e => req(e, '/api/admin/bind', { groupId: group });
async function silentModel(run) {
  const old = globalThis.fetch, seen = [];
  globalThis.fetch = async (_url, o) => {
    seen.push(JSON.parse(o.body));
    return Response.json({ choices: [{ message: { content: '{"should_reply":false,"kind":"proactive","brief":"链接"}' } }] });
  };
  try { return await run(seen); } finally { globalThis.fetch = old; }
}

test('P1 plain b23 link starts one silent light fetch, no wait and no reply', async () => {
  const e = env(); await bind(e);
  await silentModel(async () => {
    await qq(e, msg('plain', 'https://b23.tv/' + short));
    await queue(e, 'chat-plain');
  });
  const fetchJobs = (await rows(e, 'jobs')).filter(j => j.kind === 'fetch');
  assert.equal(fetchJobs.length, 1);
  assert.equal(fetchJobs[0].id, 'fetch-bili-' + short);
  assert.deepEqual(JSON.parse(fetchJobs[0].payload).waiters, []);
  assert.equal(fetchJobs[0].status, 'pending');
  assert.equal((await rows(e, 'video_waits')).length, 0);
  assert.equal((await rows(e, 'outbox')).length, 0);
});

test('P2 a fresh note or an existing job is never reopened', async () => {
  const e = env(); await bind(e);
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)')
    .bind('bili:' + short, JSON.stringify({ bvid: BV, title: '已有缓存', fetched_at: new Date().toISOString() }), new Date().toISOString()).run();
  await silentModel(async () => {
    await qq(e, msg('cached', 'https://b23.tv/' + short));
    await queue(e, 'chat-cached');
  });
  assert.equal((await rows(e, 'jobs')).filter(j => j.kind === 'fetch').length, 0);

  const e2 = env(); await bind(e2);
  await e2.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES(?, 'fetch', ?, ?)")
    .bind('fetch-bili-' + short, JSON.stringify({ type: 'bili', tier: 'light', ref: short, waiters: ['vw-other'] }), Date.now()).run();
  await silentModel(async () => {
    await qq(e2, msg('existing', 'https://b23.tv/' + short));
    await queue(e2, 'chat-existing');
  });
  const job = (await rows(e2, 'jobs')).find(j => j.id === 'fetch-bili-' + short);
  assert.deepEqual(JSON.parse(job.payload).waiters, ['vw-other']);
});

test('P3 an @ message keeps the wait path and never prefetches', async () => {
  const e = env(); await bind(e);
  await silentModel(async () => {
    await qq(e, msg('at', 'https://b23.tv/' + short), 'GROUP_AT_MESSAGE_CREATE');
    await queue(e, 'chat-at');
  });
  const waits = await rows(e, 'video_waits');
  assert.equal(waits.length, 1);
  const job = (await rows(e, 'jobs')).find(j => j.kind === 'fetch');
  assert.deepEqual(JSON.parse(job.payload).waiters, [waits[0].id]);
});

test('P4 a bare BV link and a bili2233 short link prefetch as well', async () => {
  const e = env(); await bind(e);
  await silentModel(async () => {
    await qq(e, msg('bv', 'https://www.bilibili.com/video/' + BV));
    await queue(e, 'chat-bv');
    await qq(e, msg('alias', 'https://bili2233.cn/' + short));
    await queue(e, 'chat-alias');
  });
  const ids = (await rows(e, 'jobs')).filter(j => j.kind === 'fetch').map(j => j.id).sort();
  assert.deepEqual(ids, ['fetch-bili-AbCd1234', 'fetch-bili-BV1xx411c7mD']);
});
