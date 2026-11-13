import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { worker, env, req, qq, msg } from './support.mjs';

// F7-4w: wire the pure gate into the chat claim path, behind settings gate:mode.
const GROUP = 'GROUP000001';
const GROUP_B = 'GROUP000002';
const queue = (e, id) => worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
const bind = async e => { await req(e, '/api/admin/bind', { groupId: GROUP }); return e; };
const put = (e, k, v) => e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(k, v).run();
const rows = (e, sql, ...args) => e.DB.prepare(sql).bind(...args).all().then(x => x.results);
const HOUR = 3600000;

// Bundle the wire module directly so gateCheck can be exercised without the worker.
const outfile = `.wrangler/gate-wire-${process.pid}.mjs`;
await build({ entryPoints: ['src/gate-wire.ts'], bundle: true, format: 'esm', platform: 'browser', outfile });
const { gateCheck } = await import('../' + outfile);

async function withAnswer(run, kind = 'proactive') {
  const old = globalThis.fetch;
  globalThis.fetch = async (_url, options) => {
    const b = JSON.parse(options.body);
    const system = String(b.messages?.[0]?.content || '');
    const content = system.includes('最后的嘴替模块')
      ? JSON.stringify({ mode: 'work', text: '按当前问题回复。' })
      : JSON.stringify({ action: 'reply', kind, brief: '有效问题' });
    return Response.json({ choices: [{ message: { content } }] });
  };
  try { return await run(); } finally { globalThis.fetch = old; }
}

async function send(e, id, text = '你好', type = 'GROUP_MESSAGE_CREATE') {
  await qq(e, msg(id, text), type);
  await withAnswer(() => queue(e, 'chat-' + id));
}

async function seedDecision(e, { id, kind, at, mentioned = 0, forced = 0, outbox = null, latest = 'seed-old' }) {
  await e.DB.prepare(`INSERT OR REPLACE INTO chat_decisions
    (id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,spoken_kind,target_id,wait_seconds,reason,outbox_id,policy,model_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    id, GROUP, latest, '["seed-old"]', mentioned, forced, 0, 'model', 'reply', kind,
    null, null, null, outbox, 'live', null, at).run();
  if (outbox) await e.DB.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?,?,?,?)')
    .bind(outbox, GROUP, null, '历史发言', 'sent', at).run();
}

async function seedHuman(e, id, at, group = GROUP) {
  await e.DB.prepare('INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?,0)')
    .bind(id, group, 'member1', '历史消息', new Date(at).toISOString(), 0).run();
  await e.DB.prepare('INSERT OR REPLACE INTO message_meta VALUES(?,?)').bind(id, '{}').run();
}

test('W1 gate:mode=off adds no SQL and leaves behavior on the baseline', async () => {
  const run = async mode => {
    const e = await bind(env());
    if (mode) await put(e, 'gate:mode', mode);
    await qq(e, msg('w1-' + (mode || 'unset'), '你好'));
    const before = e.DB.executed;
    await withAnswer(() => queue(e, 'chat-w1-' + (mode || 'unset')));
    return {
      used: e.DB.executed - before,
      decisions: await rows(e, 'SELECT gate,action,spoken_kind,reason FROM chat_decisions'),
      outbox: await rows(e, 'SELECT body FROM outbox'),
    };
  };
  const baseline = await run(null), off = await run('off');
  assert.equal(off.used, baseline.used, 'mode off must not add a D1 statement');
  assert.deepEqual(off.decisions, baseline.decisions);
  assert.deepEqual(off.outbox, baseline.outbox);
});

test('W2 mentions, quoted bot messages and commands always speak in on mode', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'on');
  await put(e, 'gate:config', JSON.stringify({
    cooldownSeconds: 600, maxPerHour: 1, minHumanMessages: 0,
    quietHours: { start: '00:00', end: '23:59', utcOffsetMinutes: 0 },
  }));
  for (let i = 0; i < 4; i++) await seedDecision(e, { id: 'w2-p' + i, kind: 'proactive', at: Date.now() - 60000 * (20 - i), outbox: 'w2-o' + i });

  await qq(e, msg('w2-at', '@我 在吗'), 'GROUP_AT_MESSAGE_CREATE');
  await withAnswer(() => queue(e, 'chat-w2-at'));
  assert.ok((await rows(e, 'SELECT id FROM outbox')).some(r => r.id === 'chat-w2-at'), 'mention reply must be sent');

  await e.DB.prepare('INSERT OR REPLACE INTO message_refs VALUES(?,?,?,?,?)')
    .bind('W2-BOT-REF', 'bot', 'w2-bot-msg', GROUP, Date.now()).run();
  await qq(e, { ...msg('w2-quote', '你刚才说的'), message_scene: { ext: ['ref_msg_idx=W2-BOT-REF'] } });
  await withAnswer(() => queue(e, 'chat-w2-quote'));
  assert.ok((await rows(e, 'SELECT id FROM outbox')).some(r => r.id === 'chat-w2-quote'), 'quoted bot reply must be sent');

  await qq(e, msg('w2-cmd', '/开工 TeamAgent 门控测试'));
  assert.ok((await rows(e, 'SELECT id FROM outbox')).some(r => r.id === 'ack-w2-cmd'), 'command ack must be sent');

  // The wire must bypass before the gate even reads counts; gateCheck itself is also forced-safe.
  const direct = await gateCheck(env(), {
    groupId: GROUP, mentioned: true, forced: true, now: Date.now(),
    settings: { 'gate:mode': 'on', 'gate:config': JSON.stringify({ cooldownSeconds: 600, maxPerHour: 1, minHumanMessages: 99 }) },
  });
  assert.equal(direct.speak, true);
  assert.equal(direct.mode, 'on');
});

test('W3 on mode stops a proactive reply inside the cooldown and records gate:cooldown', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'on');
  await seedHuman(e, 'w3-h1', Date.now() - 60000);
  await seedHuman(e, 'w3-h2', Date.now() - 30000);
  await e.DB.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?,?,?,?)')
    .bind('w3-prior', GROUP, null, '上一条', 'sent', Date.now() - 30000).run();
  await qq(e, msg('w3-now', '继续'));
  await withAnswer(() => queue(e, 'chat-w3-now'));
  const d = (await rows(e, 'SELECT * FROM chat_decisions'))[0];
  assert.equal(d.gate, 'gate');
  assert.equal(d.action, 'stop');
  assert.ok(String(d.reason).startsWith('gate:cooldown'), d.reason);
  assert.ok(!(await rows(e, 'SELECT id FROM outbox')).some(r => r.id === 'chat-w3-now'), 'blocked turn must not enqueue');
});

test('W4a four direct replies in the hour do not spend the proactive budget', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'on');
  for (let i = 0; i < 4; i++) await seedDecision(e, {
    id: 'w4a-d' + i, kind: 'direct', at: Date.now() - 60000 * (50 - i * 10), mentioned: 1, forced: 1, outbox: 'w4a-o' + i,
  });
  await seedHuman(e, 'w4a-h1', Date.now() - 60000);
  await seedHuman(e, 'w4a-h2', Date.now() - 30000);
  await qq(e, msg('w4a-now', '你们聊什么呢'));
  await withAnswer(() => queue(e, 'chat-w4a-now'));
  const d = await rows(e, 'SELECT * FROM chat_decisions WHERE latest_id=?', 'w4a-now').then(r => r[0]);
  assert.equal(d.gate, 'model');
  assert.equal(d.action, 'reply');
  assert.equal(d.spoken_kind, 'proactive');
});

test('W4b the fifth proactive reply in the hour is blocked by hourly_cap', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'on');
  for (let i = 0; i < 4; i++) await seedDecision(e, {
    id: 'w4b-p' + i, kind: 'proactive', at: Date.now() - 60000 * (50 - i * 10), outbox: 'w4b-o' + i,
  });
  for (let i = 0; i < 6; i++) await seedHuman(e, 'w4b-h' + i, Date.now() - 60000 * (15 - i));
  await qq(e, msg('w4b-h7', '还在吗'));
  await qq(e, msg('w4b-now', '再聊一句'));
  await withAnswer(() => queue(e, 'chat-w4b-now'));
  const d = await rows(e, 'SELECT * FROM chat_decisions WHERE latest_id=?', 'w4b-now').then(r => r[0]);
  assert.equal(d.gate, 'gate');
  assert.equal(d.action, 'stop');
  assert.ok(String(d.reason).startsWith('gate:hourly_cap'), d.reason);
});

test('W5 shadow mode sends anyway and prefixes the decision reason', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'shadow');
  await seedHuman(e, 'w5-h1', Date.now() - 60000);
  await seedHuman(e, 'w5-h2', Date.now() - 30000);
  await e.DB.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?,?,?,?)')
    .bind('w5-prior', GROUP, null, '上一条', 'sent', Date.now() - 30000).run();
  await qq(e, msg('w5-now', '继续'));
  await withAnswer(() => queue(e, 'chat-w5-now'));
  const d = await rows(e, 'SELECT * FROM chat_decisions WHERE latest_id=?', 'w5-now').then(r => r[0]);
  assert.equal(d.gate, 'model');
  assert.equal(d.action, 'reply');
  assert.ok(String(d.reason).startsWith('gate_shadow:cooldown'), d.reason);
  assert.ok((await rows(e, 'SELECT id FROM outbox')).some(r => r.id === 'chat-w5-now'), 'shadow must still send');
});

test('W6 group A proactive history does not block group B', async () => {
  const e = await bind(env());
  await put(e, 'gate:mode', 'on');
  for (let i = 0; i < 4; i++) await seedDecision(e, {
    id: 'w6-a' + i, kind: 'proactive', at: Date.now() - 60000 * (50 - i * 10), outbox: 'w6-ao' + i,
  });
  for (const id of ['w6-b1', 'w6-b2']) await seedHuman(e, id, Date.now() - 60000, GROUP_B);
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
    .bind('chat-w6-b2', 'chat', JSON.stringify({ message: 'w6-b2' }), Date.now()).run();
  await withAnswer(() => queue(e, 'chat-w6-b2'));
  const d = await rows(e, 'SELECT * FROM chat_decisions WHERE group_id=? AND latest_id=?', GROUP_B, 'w6-b2').then(r => r[0]);
  assert.ok(d, 'group B must produce its own decision');
  assert.equal(d.gate, 'model');
  assert.equal(d.action, 'reply');
});

test('W7 on/shadow add at most four D1 statements per chat turn', async () => {
  const run = async mode => {
    const e = await bind(env());
    if (mode) await put(e, 'gate:mode', mode);
    await seedHuman(e, 'w7-h1', Date.now() - 60000);
    await seedHuman(e, 'w7-h2', Date.now() - 30000);
    await e.DB.prepare('INSERT OR REPLACE INTO outbox VALUES(?,?,?,?,?,?)')
      .bind('w7-prior', GROUP, null, '上一条', 'sent', Date.now() - 30000).run();
    await qq(e, msg('w7-' + (mode || 'unset'), '继续'));
    const before = e.DB.executed;
    await withAnswer(() => queue(e, 'chat-w7-' + (mode || 'unset')));
    return e.DB.executed - before;
  };
  const baseline = await run(null), shadow = await run('shadow'), on = await run('on');
  assert.ok(shadow - baseline <= 4, `shadow added ${shadow - baseline}`);
  assert.ok(on - baseline <= 4, `on added ${on - baseline}`);
});
