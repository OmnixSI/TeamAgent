import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { env, req, qq, msg, worker } from './support.mjs';

const out = `.wrangler/f8-vision-openai-${process.pid}.mjs`;
await build({ entryPoints: ['src/vision.ts'], bundle: true, format: 'esm', platform: 'browser', outfile: out });
const v = await import('../' + out);
const bytes = Uint8Array.from(Buffer.from(v.SELFTEST_PNG, 'base64'));
const signal = () => new AbortController().signal;
const answer = (desc = '真实画面') => ({ desc, text: 'TEST', tags: [], meme: false, confidence: 'high' });
const completion = note => Response.json({ choices: [{ message: { content: JSON.stringify(note) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 80 } });
async function setting(e, key, value) { await e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(key, String(value)).run(); }
async function fixture(mode = 'auto') {
  const e = env(); e.OPENAI_API_KEY = 'fake-test-only';
  // F8-0 owns this migration; local fixture mirrors only the ledger needed here.
  await e.DB.prepare('CREATE TABLE IF NOT EXISTS openai_usage(id TEXT PRIMARY KEY,purpose TEXT,model TEXT,group_id TEXT,sender_id TEXT,status TEXT,error_kind TEXT,latency_ms INTEGER,est_cost_micro_usd INTEGER,created_at INTEGER)').run();
  await setting(e, 'vision:provider', mode);
  return e;
}
async function offline(fetcher, run) {
  const old = globalThis.fetch; globalThis.fetch = fetcher;
  try { return await run(); } finally { globalThis.fetch = old; }
}
const describe = e => v.describeBytes(e, bytes, 'image/png', 'Authorization: secret-token', signal(), 'v1', () => {});
const binding = (e, run = async () => ({ response: JSON.stringify(answer('Workers 图注')) })) => { let n = 0; e.AI = { run(...args) { n++; return run(...args); } }; return () => n; };
const pick = (id = 'm') => ({ messageId: id, idx: 0, hint: '', media: { kind: 'image', url: 'https://gchat.qpic.cn/' + id } });

test('V4 OpenAI uses shared channel, data URL, model override and vision ledger', async () => {
  const e = await fixture('openai'); await setting(e, 'vision:openai_model', 'luna-configured');
  let call;
  const note = await offline(async (url, init) => { call = { url, body: JSON.parse(init.body) }; return completion(answer()); }, () => describe(e));
  assert.equal(note?.desc, '真实画面'); assert.equal(note.provider, 'openai'); assert.equal(note.model, 'luna-configured');
  assert.equal(call.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(call.body.model, 'luna-configured');
  assert.equal(call.body.messages[0].content[1].image_url.url, 'data:image/png;base64,' + v.SELFTEST_PNG);
  assert.doesNotMatch(JSON.stringify(call.body), /secret-token/);
  assert.match(JSON.stringify(call.body), /confidence|书法/);
  assert.equal((await e.DB.prepare('SELECT purpose FROM openai_usage').first()).purpose, 'vision');
});

test('V1 primary and fallback cache namespaces record actual provider and isolate models', async () => {
  const e = await fixture(); const calls = binding(e);
  const local = await offline(() => assert.fail('unexpected API'), () => describe(e));
  assert.equal(local?.provider, 'workers_ai'); assert.equal(calls(), 1);
  await setting(e, 'vision:provider', 'openai'); let n = 0;
  await offline(async () => { n++; return completion(answer('Luna 图注')); }, async () => {
    const first = await describe(e), second = await describe(e);
    assert.equal(first?.provider, 'openai'); assert.equal(second?.desc, 'Luna 图注'); assert.equal(n, 1);
    await setting(e, 'vision:openai_model', 'another-luna');
    assert.equal((await describe(e))?.model, 'another-luna'); assert.equal(n, 2);
  });
  const rows = (await e.DB.prepare('SELECT provider,model,sha FROM image_notes').all()).results;
  assert.equal(rows.length, 3); assert.equal(new Set(rows.map(r => r.sha)).size, 3);
});

test('V1 fallback result is only stored under actual provider; fallback cache avoids a second fallback call', async () => {
  const e = await fixture(); let workers = 0, api = 0;
  binding(e, async () => { workers++; throw { status: 403 }; });
  await offline(async () => { api++; return completion(answer('备用图注')); }, async () => {
    assert.equal((await describe(e))?.provider, 'openai');
    assert.equal((await describe(e))?.provider, 'openai');
  });
  const rows = (await e.DB.prepare('SELECT provider,model FROM image_notes').all()).results;
  assert.deepEqual(rows.map(r => r.provider), ['openai']); assert.equal(api, 1); assert.equal(workers, 2);
});

test('V1 existing links from another provider become cold and are replaced; material identifies source', async () => {
  const e = await fixture('workers_ai'); binding(e);
  await offline(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(e, [pick()], 1000));
  await setting(e, 'vision:provider', 'openai');
  assert.equal((await v.coldPicks(e, [pick()])).length, 1);
  await offline(async url => String(url).includes('api.openai.com') ? completion(answer('Luna 重新识图')) : new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(e, [pick()], 1000));
  assert.equal((await v.coldPicks(e, [pick()])).length, 0);
  const notes = await v.imageNotesFor(e, ['m']); assert.match(notes.get('m')[0], /Luna 重新识图.*openai.*gpt-5.6-luna/);
});

test('V2 primary timeout gets an independent fallback slice and late primary cannot poison cache', async t => {
  const e = await fixture(); await setting(e, 'vision:per_image_deadline_ms', 25);
  let finish, ready;
  const started = new Promise(resolve => { ready = resolve; });
  binding(e, () => new Promise(resolve => { finish = resolve; ready(); }));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const note = await offline(async () => completion(answer('及时回退')), async () => {
    const pending = describe(e);
    await started;
    t.mock.timers.tick(25);
    return pending;
  });
  assert.equal(note?.provider, 'openai'); finish({ response: JSON.stringify(answer('迟到主路')) });
  await new Promise(setImmediate);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 1);
});

test('V2 primary refusal falls back to Workers AI', async () => {
  const e = await fixture('openai'), calls = binding(e);
  const note = await offline(async () => Response.json({ error: { code: 'content_policy_violation' } }, { status: 400 }), () => describe(e));
  assert.equal(note?.provider, 'workers_ai'); assert.equal(calls(), 1);
  assert.deepEqual((await e.DB.prepare('SELECT provider FROM image_notes').all()).results.map(r => r.provider), ['workers_ai']);
});

test('V2 fallback timeout returns structured failure without inventing content', async () => {
  const e = await fixture(); binding(e, async () => { throw { status: 403 }; });
  await setting(e, 'vision:per_image_deadline_ms', 20);
  const outcomes = await offline(async url => String(url).includes('api.openai.com') ? new Promise(() => {}) : new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(e, [pick()], 500));
  assert.equal(outcomes[0].error_kind, 'timeout'); assert.ok(outcomes[0].next_action);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
});

test('V2 both providers refused return structured refusal and zero notes', async () => {
  const e = await fixture(); binding(e, async () => { throw { status: 403 }; });
  const outcomes = await offline(async url => String(url).includes('api.openai.com') ? Response.json({ error: { code: 'content_policy_violation' } }, { status: 400 }) : new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(e, [pick()], 1000));
  assert.equal(outcomes[0].ok, false); assert.equal(outcomes[0].error_kind, 'refused'); assert.ok(outcomes[0].next_action);
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
});

test('V2 three distinct images have independent deadlines; total deadline remains authoritative', async () => {
  const e = await fixture('openai'); await setting(e, 'vision:per_image_deadline_ms', 80); await setting(e, 'vision:turn_deadline_ms', 300);
  let calls = 0;
  const results = await offline(async url => {
    if (!String(url).includes('api.openai.com')) return new Response(new TextEncoder().encode(String(url)), { headers: { 'content-type': 'image/png' } });
    calls++; await new Promise(r => setTimeout(r, 30)); return completion(answer());
  }, () => v.annotateTurn(e, ['a','b','c'].map(pick)));
  assert.ok(results.every(r => r.status === 'ok')); assert.equal(calls, 3);
  const fresh = await fixture('openai'); await setting(fresh, 'vision:per_image_deadline_ms', 500); await setting(fresh, 'vision:turn_deadline_ms', 20);
  const failures = await offline(async url => String(url).includes('api.openai.com') ? new Promise(() => {}) : new Response(bytes, { headers: { 'content-type': 'image/png' } }), () => v.annotateTurn(fresh, [pick()]));
  assert.equal(failures[0].error_kind, 'timeout');
  assert.equal((await fresh.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
});

test('V3 low confidence marks desc/text and cached answering material', async () => {
  const e = await fixture('openai');
  const note = await offline(async () => completion({ ...answer('书法风格字幅'), text: '汝人（可能有误）', confidence: 'low' }), () => describe(e));
  assert.equal(note?.confidence, 'low'); assert.match(note.desc, /^识别结果可能有误：/); assert.match(note.text, /^识别结果可能有误：/);
  await e.DB.prepare('INSERT INTO message_images VALUES(?,?,?)').bind('low', 0, note.sha).run();
  const material = (await v.imageNotesFor(e, ['low'])).get('low')[0]; assert.match(material, /可能有误，不要当逐字真值/);
  const cached = await offline(() => assert.fail('cache must avoid API'), () => describe(e)); assert.equal(cached.confidence, 'low');
});

test('V3 styled or tiny text forces caution even when model claims high confidence', async () => {
  const e = await fixture('openai');
  const note = await offline(async () => completion({ ...answer('风格化艺术字'), text: '尼采', confidence: 'high' }), () => describe(e));
  assert.equal(note?.confidence, 'low'); assert.match(note.text, /可能有误/);
});

test('V4 missing key disables only OpenAI; no API request and existing provider still works', async () => {
  const e = await fixture('openai'); delete e.OPENAI_API_KEY; const calls = binding(e);
  const note = await offline(() => assert.fail('missing key must not send HTTP'), () => describe(e));
  assert.equal(note?.provider, 'workers_ai'); assert.equal(calls(), 1);
});

test('V4 shared daily cap stops both providers; fallback consumes only one vision budget', async () => {
  const e = await fixture(); await setting(e, 'vision:daily_cap', 1); let n = 0;
  binding(e, async () => { throw { status: 403 }; });
  await offline(async () => { n++; return completion(answer()); }, async () => {
    assert.equal((await describe(e))?.provider, 'openai');
    assert.equal(await v.describeBytes(e, new Uint8Array([8]), 'image/png', '', signal(), 'v1', () => {}), null);
  });
  assert.equal(n, 1); assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM openai_usage').first()).n, 1);
});

test('V1 concurrent requests with different primary providers cannot share in-flight results', async () => {
  const e = await fixture('workers_ai'); binding(e, async () => { await new Promise(r => setTimeout(r, 30)); return { response: JSON.stringify(answer('主路慢图注')) }; });
  const first = describe(e); await new Promise(r => setTimeout(r, 10)); await setting(e, 'vision:provider', 'openai');
  const [a,b] = await offline(async () => completion(answer('OpenAI 快图注')), () => Promise.all([first, describe(e)]));
  assert.equal(a?.provider, 'workers_ai'); assert.equal(b?.provider, 'openai');
});

test('V1 provider migration upgrades old rows and is safe to repeat and run on fresh schema', async () => {
  assert.match(readFileSync('scripts/migrate.mjs', 'utf8'), /import\.meta\.url.*process\.argv/);
  const migration = await import('../scripts/migrate.mjs');
  for (const fresh of [false, true]) {
    const db = new DatabaseSync(':memory:');
    if (fresh) db.exec(readFileSync('schema.sql', 'utf8'));
    else db.exec("CREATE TABLE image_notes(sha TEXT PRIMARY KEY,desc TEXT,tags TEXT,sticker_like INTEGER,text TEXT,created_at INTEGER); INSERT INTO image_notes VALUES('old:v1','旧图','[]',0,NULL,1)");
    const execute = sql => { const s = db.prepare(sql); return s.columns().length ? [{ results: s.all() }] : (s.run(), [{ success: true }]); };
    migration.ensureImageNotesProvider(execute); migration.ensureImageNotesProvider(execute);
    db.exec(readFileSync('migrations/0043_image_notes_provider.sql', 'utf8'));
    db.exec(readFileSync('migrations/0043_image_notes_provider.sql', 'utf8'));
    assert.ok(db.prepare('PRAGMA table_info(image_notes)').all().some(c => c.name === 'provider'));
    if (!fresh) assert.equal(db.prepare('SELECT provider FROM image_notes').get().provider, 'workers_ai');
    db.close();
  }
});


test('V2 real chat job honors settings deadline instead of overriding it with twelve seconds', async () => {
  const e = await fixture('workers_ai');
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  await setting(e, 'vision:turn_deadline_ms', 20);
  await setting(e, 'vision:per_image_deadline_ms', 500);
  binding(e, async () => { await new Promise(r => setTimeout(r, 80)); return { response: JSON.stringify(answer()) }; });
  await qq(e, { ...msg('deadline-live-path', '看这张图'), attachments: [{ content_type: 'image/png', url: 'https://gchat.qpic.cn/deadline.png', width: 64, height: 64 }] }, 'GROUP_AT_MESSAGE_CREATE');
  await offline(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }), () =>
    worker.queue({ messages: [{ body: { id: 'chat-deadline-live-path' }, ack() {} }] }, e));
  const job = await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-v-deadline-live-path'").first();
  const outcomes = JSON.parse(job.payload).imageOutcomes;
  assert.equal(outcomes[0].error_kind, 'timeout');
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n, 0);
});

test('V3 long low-confidence notes round-trip through cache without changing text', async () => {
  const e = await fixture('openai');
  await offline(async () => completion({ ...answer('图'.repeat(100)), text: '字'.repeat(300), confidence: 'low' }), async () => {
    const first = await describe(e), second = await describe(e);
    assert.equal(second.desc, first.desc); assert.equal(second.text, first.text);
  });
});
