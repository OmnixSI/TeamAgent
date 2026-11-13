import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker,req,qq,msg} from './support.mjs';

const outfile = `.wrangler/prefetch-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export {videoTarget,needsVideo,requestPrefetch} from "./src/fetchjobs"; export {prefetchTurn,retryFailedBili,complaintIntent,bareMention} from "./src/prefetch"; export {metered} from "./src/d1";',
    resolveDir: process.cwd(), loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'browser', outfile,
});
const api = await import('../' + outfile);
const SHORT = 'F1DkQFC';
const REF = SHORT;
const FAIL = 'failure:v1:bili:';
const group = 'GROUP000001';
const body417 = '【余承东：给大家变个小魔术！-哔哩哔哩】 https://b23.tv/F1DkQFC\n余承东在这干啥呢，不好好卖车怎么还变魔术';
const body419 = '你真是个废物 b 站短链接都读不了';

const queue = (e, id) => (e.testWorker || worker).queue({messages: [{body: {id}, ack() {}}]}, e);
const rows = (e, table) => e.DB.prepare('SELECT * FROM ' + table).all().then(x => x.results);
const runner = (e, path, b) => req(e, '/api/runner/fetch/' + path, b, 'runner-secret');
const iso = at => new Date(at).toISOString();
async function mockModel(run) {
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, opt) => {
    const body = JSON.parse(opt.body || '{}');
    const content = body.messages?.[0]?.content?.includes('最后的嘴替模块')
      ? '{"mode":"work","text":"收到。"}'
      : '{"action":"reply","kind":"direct","brief":"按实际资料回复"}';
    return Response.json({choices: [{message: {content}}]});
  };
  try { return await run(); } finally { globalThis.fetch = old; }
}
async function setup() { const e = env(); await req(e, '/api/admin/bind', {groupId: group}); return e; }
const atMsg = (id, body) => ({...msg(id, body), mentions: [{member_openid: 'bot', is_you: true}]});
const fetchJobs = async e => (await rows(e, 'jobs')).filter(j => j.kind === 'fetch');

test('P1 msg417 real shape: a non-@ short link with weak intent creates one light fetch and no reply wait', async () => {
  const e = await setup();
  await qq(e, msg('417', body417));
  await mockModel(() => queue(e, 'chat-417'));
  const jobs = await fetchJobs(e);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'fetch-bili-' + REF);
  const p = JSON.parse(jobs[0].payload);
  assert.equal(p.v, 2);
  assert.equal(p.type, 'bili');
  assert.equal(p.tier, 'light');
  assert.equal(p.ref, REF);
  assert.equal(p.kind, 'short');
  assert.equal(p.base, SHORT);
  assert.deepEqual(p.waiters, []);
  assert.equal((await rows(e, 'video_waits')).length, 0, 'prefetch must stay silent');
});

test('P2 empty @ targets the recent short link from message 417 and joins the same fetch', async () => {
  const e = await setup();
  await qq(e, msg('417', body417));
  await mockModel(() => queue(e, 'chat-417'));
  await qq(e, atMsg('418', ''), 'GROUP_AT_MESSAGE_CREATE');
  await mockModel(() => queue(e, 'chat-418'));
  const waits = await rows(e, 'video_waits');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].latest_id, '418');
  assert.equal(waits[0].ref, REF);
  assert.equal(waits[0].mentioned, 1);
  assert.equal((await fetchJobs(e)).length, 1, 'must reuse the 417 fetch instead of creating another');
  assert.ok(JSON.parse((await fetchJobs(e))[0].payload).waiters.includes('vw-418'));
});

test('P3 complaint rebuilds a failed short link once, and not again within ten minutes', async () => {
  const e = await setup();
  await qq(e, msg('417', body417));
  await mockModel(() => queue(e, 'chat-417'));
  const {job} = await (await runner(e, 'claim', {})).json();
  assert.equal((await runner(e, 'report', {id: job.id, lease: job.payload.lease, proto: 2, success: false, reason: 'risk', retryAfter: 600})).status, 200);
  const failure = (await rows(e, 'media_notes')).find(n => n.id === FAIL + REF);
  assert.ok(failure, 'failed read must leave a failure note');

  await qq(e, msg('419', body419));
  await mockModel(() => queue(e, 'chat-419'));
  assert.equal((await rows(e, 'media_notes')).find(n => n.id === FAIL + REF), undefined, 'failure cache is cleared for the retry');
  const marker = (await rows(e, 'media_notes')).find(n => n.id.startsWith('prefetch-retry:v1:'));
  assert.ok(marker && marker.id.endsWith(REF));
  const reopened = (await rows(e, 'jobs')).find(j => j.id === 'fetch-bili-' + REF);
  assert.equal(reopened.status, 'pending', 'the failed fetch is rebuilt');
  assert.equal(reopened.attempts, 0);
  const waits = (await rows(e, 'video_waits')).filter(w => w.latest_id === '419');
  assert.equal(waits.length, 1);
  assert.equal(waits[0].ref, REF);

  // Same ref failed again right away: the ten-minute fuse keeps the failure note and job terminal.
  await e.DB.prepare("UPDATE jobs SET status='failed',attempts=2 WHERE id=?").bind('fetch-bili-' + REF).run();
  await e.DB.prepare('INSERT OR REPLACE INTO media_notes VALUES(?,?,?)').bind(FAIL + REF, JSON.stringify({reason: 'risk', until: Date.now() + 600000}), iso(Date.now())).run();
  const markerAt = marker.created_at;
  await qq(e, msg('419b', body419));
  await mockModel(() => queue(e, 'chat-419b'));
  const kept = (await rows(e, 'media_notes')).find(n => n.id === FAIL + REF);
  assert.ok(kept, 'a second complaint inside ten minutes must not clear the failure');
  assert.equal((await rows(e, 'media_notes')).find(n => n.id.startsWith('prefetch-retry:v1:')).created_at, markerAt);
  assert.equal((await rows(e, 'jobs')).find(j => j.id === 'fetch-bili-' + REF).status, 'failed');
  assert.equal((await rows(e, 'video_waits')).filter(w => w.latest_id === '419b').length, 0);
});

test('P4 ordinary links and plain non-@ chatter do not create fetches', async () => {
  const e = await setup();
  await qq(e, msg('plain-link', '看看这个 https://example.com/doc'));
  await mockModel(() => queue(e, 'chat-plain-link'));
  await qq(e, msg('plain-talk', '今天天气不错'));
  await mockModel(() => queue(e, 'chat-plain-talk'));
  assert.equal((await fetchJobs(e)).length, 0);
  assert.equal((await rows(e, 'video_waits')).length, 0);
});

test('P5 recent links never cross groups', async () => {
  const e = await setup();
  await req(e, '/api/admin/bind', {groupId: 'GROUP000002'});
  await qq(e, msg('a-link', '看这个 https://b23.tv/' + SHORT, 'GROUP000001'));
  await mockModel(() => queue(e, 'chat-a-link'));
  await qq(e, atMsg('b-empty', ''), 'GROUP_AT_MESSAGE_CREATE');
  await mockModel(() => queue(e, 'chat-b-empty'));
  assert.equal((await rows(e, 'video_waits')).filter(w => w.latest_id === 'b-empty').length, 0);

  const cfg = {bili: {enabled: true}}, empty = {id: 'empty', group_id: 'A', body: '', mentioned: 1};
  assert.equal(api.videoTarget([], empty, [{id: 'b', group_id: 'B', body: 'x', meta: {bili: [{short: SHORT}]}}], cfg), null);
  assert.equal(api.videoTarget([], empty, [{id: 'a', group_id: 'A', body: 'x', meta: {bili: [{short: SHORT}]}}], cfg).ref, REF);
});

test('P6 a short link already read within 24h is not fetched again', async () => {
  const e = await setup();
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:' + REF, JSON.stringify({bvid: 'BV1xx411c7mD', page: 1}), iso(Date.now() - 3600000)).run();
  await qq(e, msg('417', body417));
  await mockModel(() => queue(e, 'chat-417'));
  assert.equal((await fetchJobs(e)).length, 0);

  const stale = await setup();
  await stale.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:' + REF, JSON.stringify({bvid: 'BV1xx411c7mD', page: 1}), iso(Date.now() - 25 * 3600000)).run();
  await qq(stale, msg('417', body417));
  await mockModel(() => queue(stale, 'chat-417'));
  assert.equal((await fetchJobs(stale)).length, 1, 'a 25h old note is stale');
});

test('P7 prefetch, empty-@ and complaint paths stay within the 48-statement budget', async () => {
  const counts = {};
  async function measured(base, label, run) {
    const e = api.metered(base), before = base.DB.executed;
    await run(e);
    const used = e.meter.used;
    assert.equal(used, base.DB.executed - before, label);
    assert.ok(used <= 48, label + ' ' + used);
    counts[label] = used;
  }
  const base = await setup();
  await qq(base, msg('417', body417));
  await mockModel(() => measured(base, 'C4b-prefetch-link', e => queue(e, 'chat-417')));
  await qq(base, atMsg('418', ''), 'GROUP_AT_MESSAGE_CREATE');
  await mockModel(() => measured(base, 'C4b-empty-at', e => queue(e, 'chat-418')));
  const {job} = await (await runner(base, 'claim', {})).json();
  await runner(base, 'report', {id: job.id, lease: job.payload.lease, proto: 2, success: false, reason: 'risk', retryAfter: 600});
  await qq(base, msg('419', body419));
  await mockModel(() => measured(base, 'C4b-complaint-retry', e => queue(e, 'chat-419')));
  assert.ok(counts['C4b-prefetch-link'] > 0);
});
