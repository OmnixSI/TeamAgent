import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { env, req } from './support.mjs';

const outfile = `.wrangler/f6-vision-binding-${process.pid}.mjs`;
await build({ entryPoints: ['src/vision.ts'], bundle: true, format: 'esm', platform: 'browser', outfile });
const v = await import('../' + outfile);
const bytes = Uint8Array.from(Buffer.from(v.SELFTEST_PNG, 'base64'));
const signal = () => new AbortController().signal;
// F6P 默认链路改为 DeepSeek；这组用例只覆盖 Workers AI 绑定，显式固定 provider。
async function workersEnv() {
  const e = env();
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('vision:provider','workers')").run();
  return e;
}
const answer = { desc: '红色测试图', text: 'TEST', tags: ['测试'], meme: false };
function binding(e, run = async () => ({ response: JSON.stringify(answer), usage: { prompt_tokens: 12, completion_tokens: 8 } })) {
  const calls = [];
  e.AI = { async run(model, input) { calls.push({ model, input }); return run(model, input); } };
  return calls;
}
async function offline(fetcher, run) {
  const old = globalThis.fetch;
  globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = old; }
}

test('F6-V1 image reaches AI binding, never DeepSeek; prompt redacted and model usage retained', async () => {
  const e = await workersEnv(), calls = binding(e);
  const note = await offline(() => assert.fail('no HTTP model request'), () =>
    v.describeBytes(e, bytes, 'image/png', 'Authorization: secret-token', signal()));
  assert.equal(note?.desc, answer.desc);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, '@cf/meta/llama-3.2-11b-vision-instruct');
  assert.equal(calls[0].input.image, 'data:image/png;base64,' + v.SELFTEST_PNG);
  assert.doesNotMatch(calls[0].input.prompt, /secret-token/);
  const metrics = await e.DB.prepare("SELECT * FROM model_runs WHERE kind='vision'").all();
  assert.equal(metrics.results.length, 1);
  assert.equal(metrics.results[0].status, 'ok');
});

test('F6-V2 concurrent identical image shares budget/model and persists one cache note', async () => {
  const e = await workersEnv(), calls = binding(e, async () => {
    await new Promise(resolve => setTimeout(resolve, 20));
    return { response: JSON.stringify(answer) };
  });
  const notes = await offline(() => assert.fail('no HTTP'), () => Promise.all(
    Array.from({ length: 4 }, () => v.describeBytes(e, bytes, 'image/png', '', signal()))));
  assert.ok(notes.every(n => n?.desc === answer.desc));
  assert.equal(calls.length, 1);
  assert.equal((await e.DB.prepare("SELECT value FROM settings WHERE key LIKE 'budget:vision:%'").first()).value, '1');
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 1);
  await v.describeBytes(e, bytes, 'image/png', '', signal());
  assert.equal(calls.length, 1);
});

test('F6-V7 concurrent failed descriptions preserve quota reason for every image and allow retry', async () => {
  const e = await workersEnv();
  binding(e, async () => {
    await new Promise(r => setTimeout(r, 30));
    throw Object.assign(Error('quota'), { status: 429 });
  });
  const picks = ['one', 'two'].map(messageId => ({ messageId, idx: 0, hint: '', media: { kind: 'image', url: 'https://gchat.qpic.cn/' + messageId } }));
  const failed = await offline(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(e, picks, 2000));
  assert.deepEqual(failed.map(f => f.error_kind), ['budget', 'budget']);
  const calls = binding(e);
  assert.equal((await v.describeBytes(e, bytes, 'image/png', '', signal()))?.desc, answer.desc);
  assert.equal(calls.length, 1);
});

for (const [name, setup, fetcher, kind, reason] of [
  ['download denied', e => binding(e), () => new Response('denied', { status: 403 }), 'denied', /下载被拒/],
  ['binding missing', () => {}, null, 'runner_unsupported', /模型不支持|未绑定/],
  ['model unsupported', e => binding(e, async () => { throw Object.assign(Error('model not supported secret=private'), { status: 404 }); }), null, 'runner_unsupported', /模型不支持/],
  ['provider quota', e => binding(e, async () => { throw Object.assign(Error('private-key'), { status: 429 }); }), null, 'budget', /超额|额度/],
  ['Workers AI quota code', e => binding(e, async () => { throw Error('AiError: 3036: You have used up your daily free allocation of 10,000 neurons'); }), null, 'budget', /超额|额度/],
  ['Workers AI model code', e => binding(e, async () => { throw Error('AiError: 5007: No such model'); }), null, 'runner_unsupported', /模型不支持/],
  ['Workers AI timeout code', e => binding(e, async () => { throw Error('AiError: 3007: Request timeout'); }), null, 'timeout', /超时/],
  ['daily cap', async e => { binding(e); const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date()); await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('budget:vision:' + day, '300').run(); }, null, 'budget', /预算/],
]) test('F6-V3 structured failure: ' + name, async () => {
  const e = await workersEnv(); await setup(e);
  const outcomes = await offline(fetcher || (() => new Response(bytes, { headers: { 'content-type': 'image/png' } })), () =>
    v.annotateTurn(e, [{ messageId: 'failure', idx: 0, media: { kind: 'image', url: 'https://gchat.qpic.cn/test.png' }, hint: '' }], 500));
  assert.equal(outcomes[0].ok, false);
  assert.equal(outcomes[0].error_kind, kind);
  assert.ok(outcomes[0].next_action);
  assert.match(outcomes[0].toolFailure.detail, reason);
  const notes = new Map(); v.applyImageOutcomes(notes, outcomes);
  assert.match(notes.get('failure')[0], /error_kind.*next_action/);
  assert.doesNotMatch(JSON.stringify(outcomes), /private-key|secret=private/);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
});

test('F6-V4 deadline returns timeout; late binding result cannot populate cache; retry works', async () => {
  const e = await workersEnv(); let resolve;
  binding(e, () => new Promise(r => { resolve = r; }));
  const outcomes = await offline(() => new Response(bytes, { headers: { 'content-type': 'image/png' } }), () =>
    v.annotateTurn(e, [{ messageId: 'slow', idx: 0, media: { kind: 'image', url: 'https://gchat.qpic.cn/slow.png' }, hint: '' }], 500));
  assert.equal(outcomes[0].error_kind, 'timeout');
  assert.equal(typeof resolve, 'function'); resolve({ response: JSON.stringify(answer) });
  await new Promise(r => setTimeout(r, 5));
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
  binding(e);
  assert.equal((await v.describeBytes(e, bytes, 'image/png', '', signal()))?.desc, answer.desc);
});

test('F6-V6 owner smoke endpoint calls real provider path without D1 writes and returns safe failure', async () => {
  const e = await workersEnv(); binding(e);
  const before = (await e.DB.prepare('SELECT COUNT(*) n FROM model_runs').first()).n;
  const result = await (await req(e, '/api/team/vision/selftest')).json();
  assert.equal(result.ok, true);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM model_runs').first()).n, before);
  binding(e, async () => { throw Error('Authorization: hidden-smoke-secret'); });
  const failed = await (await req(e, '/api/team/vision/selftest')).json();
  assert.equal(failed.ok, false);
  assert.ok(failed.error_kind && failed.next_action);
  assert.doesNotMatch(JSON.stringify(failed), /hidden-smoke-secret/);
});

test('F6-V5 real msg305/383/384 metadata replay: expired download then test data URL → linked descriptions', async () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/f6-vision-history.json', import.meta.url)));
  const rows = fixture.rows, e = await workersEnv(), calls = binding(e);
  const first = v.pickImages(rows.slice(0, 2), rows.find(r => r.ordinal === 305), new Map());
  assert.deepEqual(first.map(p => p.messageId), ['history-304']);
  const second = v.pickImages(rows.slice(2), rows.find(r => r.ordinal === 386), new Map([['history-383', rows.find(r => r.ordinal === 383)]]));
  assert.deepEqual(second.map(p => p.messageId), ['history-383']);
  const picks = [...first, ...second];
  const failures = await offline(() => new Response('expired', { status: 400 }), () => v.annotateTurn(e, picks));
  assert.ok(failures.every(f => f.ok === false && f.stage === 'fetch'));
  assert.equal(calls.length, 0);
  const dataUrl = 'data:image/png;base64,' + v.SELFTEST_PNG;
  // Keep the production QQ allowlist: the offline CDN response is loaded from the test data URL.
  const data = await fetch(dataUrl);
  const result = await offline(() => data.clone(), () => v.annotateTurn(e, picks));
  assert.ok(result.every(r => r.status === 'ok'));
  assert.equal(calls.length, 1);
  const notes = await v.imageNotesFor(e, picks.map(p => p.messageId));
  assert.match(notes.get('history-304')[0], /红色测试图.*TEST/s);
  assert.match(notes.get('history-383')[0], /红色测试图.*TEST/s);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM message_images').first()).n, 2);
  console.log('msg#305/383/384 本地回放：已过期 URL 用 data URL 测试图替代；AI binding 为假；QQ 真实发送 0 次、线上 D1 写入 0 行');
});
