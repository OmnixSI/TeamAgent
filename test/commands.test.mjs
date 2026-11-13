import {test} from 'node:test';
import assert from 'node:assert/strict';
import {worker, env, req, qq, msg} from './support.mjs';

const group = 'GROUP000001';
const other = 'GROUP000002';
const bind = async e => { await req(e, '/api/admin/bind', {groupId: group}); return e; };
const value = async (e, key) => (await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;
const put = (e, key, val) => e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(key, val).run();
const rows = (e, table) => e.DB.prepare('SELECT * FROM ' + table).all().then(x => x.results);
const outbox = e => e.DB.prepare('SELECT * FROM outbox ORDER BY id').all().then(x => x.results);
const putMessage = (e, id, body, groupId = group) =>
  e.DB.prepare('INSERT OR IGNORE INTO messages VALUES(?,?,?,?,?,?,0)')
    .bind(id, groupId, 'member1', body, new Date().toISOString(), 1).run();
const putJob = (e, id, kind, payload, status = 'pending', created = Date.now()) =>
  e.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,status,attempts,lease_until,error,created_at) VALUES(?,?,?,?,0,0,NULL,?)')
    .bind(id, kind, JSON.stringify(payload), status, created).run();

async function withoutNetwork(run) {
  const old = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('network disabled in command test'); };
  try { return { result: await run(), calls }; }
  finally { globalThis.fetch = old; }
}

test('help is deterministic, short, and answers slash plus aliases', async () => {
  const e = await bind(env());
  const { calls } = await withoutNetwork(async () => {
    await qq(e, msg('h1', '/help'));
    await qq(e, msg('h2', '帮助'));
    await qq(e, msg('h3', '<@!bot1> help'),);
  });
  const out = await outbox(e);
  assert.equal(calls, 0, 'commands must not call a model or QQ token endpoint');
  assert.equal(out.length, 3);
  for (const row of out) {
    assert.match(row.body, /\/help/);
    assert.match(row.body, /\/status/);
    assert.match(row.body, /\/stop/);
    assert.match(row.body, /\/方案/);
    assert.match(row.body, /\/开工/);
    assert.ok(row.body.split('\n').length <= 12, 'help must stay within 12 lines');
  }
  assert.match(out[0].body, /撤回/);
});

test('status reports live facts and degrades when optional tables are absent', async () => {
  const e = await bind(env());
  for (const t of ['schedules', 'turn_tools']) await e.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run(); // F6-6/F6-3 schema now ship these; simulate absent
  e.RELEASE = 'c1a6c9d';
  e.GITHUB_TOKEN = 'present-but-never-read';
  await put(e, 'runner_seen', new Date(Date.now() - 3 * 60000).toISOString());
  await e.DB.prepare('INSERT INTO repo_cache VALUES(?,?,?)')
    .bind('OmnixSI/TeamAgent', '{}', Date.now() - 2 * 60000).run();
  await putJob(e, 'job-media', 'media', {title: '转写视频', message: 'm1'}, 'pending', Date.now() - 8 * 60000);
  await put(e, 'off:repo_tools', '1');
  await put(e, 'ci_notifications_v2', '0');
  const { calls } = await withoutNetwork(() => qq(e, msg('s1', '/status')));
  assert.equal(calls, 0);
  const out = await outbox(e);
  assert.equal(out.length, 1);
  const body = out[0].body;
  assert.match(body, /版本 c1a6c9d/);
  assert.match(body, /repo_tools 关/);
  assert.match(body, /CI 通知 关/);
  assert.match(body, /GITHUB_TOKEN 有/);
  assert.match(body, /Runner：3 分钟前/);
  assert.match(body, /TeamAgent 2 分钟前/);
  assert.match(body, /未索引（本机没同步）/);
  assert.match(body, /1 个进行中/);
  assert.match(body, /最久「转写视频」8 分钟/);
  assert.doesNotMatch(body, /定时：/);
  assert.doesNotMatch(body, /工具：/);
});

test('status includes schedules and recent tool failure when those tables exist', async () => {
  const e = await bind(env());
  for (const t of ['schedules', 'turn_tools']) await e.DB.prepare(`DROP TABLE IF EXISTS ${t}`).run(); // use this test's own table shapes
  await e.DB.prepare(`CREATE TABLE schedules(id TEXT PRIMARY KEY,group_id TEXT,owner TEXT,kind TEXT,tz TEXT,spec TEXT,status TEXT,
    next_run_at INTEGER,last_run_at INTEGER,fail_count INTEGER DEFAULT 0,last_error TEXT,source_msg_id TEXT,created_at INTEGER)`).run();
  await e.DB.prepare(`CREATE TABLE turn_tools(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,group_id TEXT,name TEXT NOT NULL,args TEXT NOT NULL DEFAULT '{}',
    ok INTEGER NOT NULL,error_kind TEXT,ms INTEGER NOT NULL,offered INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL)`).run();
  await e.DB.prepare('INSERT INTO schedules VALUES(?,?,?,?,?,?,?,?,?,0,NULL,NULL,?)')
    .bind('sch1', group, 'owner', 'digest_daily', 'Australia/Sydney', '{}', 'active', Date.now() + 3600000, Date.now()).run();
  await e.DB.prepare('INSERT INTO turn_tools VALUES(?,?,?,?,?,?,?,?,?,?)')
    .bind('tt1', 'turn1', group, 'search_web', '{}', 0, 'network', 120, 1, Date.now() - 12 * 60000).run();
  await qq(e, msg('s2', '状态'));
  const body = (await outbox(e))[0].body;
  assert.match(body, /定时：.*（每日总结）/);
  assert.match(body, /工具：最近失败 search_web（network，12 分钟前）/);
});

test('stop cancels only this group, lists work, and is idempotent', async () => {
  const e = await bind(env());
  await qq(e, msg('m1', '先帮我看看这个'));
  await putMessage(e, 'g2m', '别群的消息', other);
  await putMessage(e, 'm2', '第二个任务');
  await putJob(e, 'media-m1', 'media', {title: '转写视频', message: 'm1'}, 'pending', Date.now() - 9 * 60000);
  await putJob(e, 'video-vw-m1', 'video_reply', {wait: 'vw-m1'}, 'pending', Date.now() - 5 * 60000);
  await e.DB.prepare(`INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,status,lease_until,created_at,attempts,phase)
    VALUES(?,?,?,?,?,1,0,?,'waiting',0,?,0,'light')`)
    .bind('vw-m1', group, 'BV1xx411c7mD', 'm1', '[]', Date.now() + 60000, Date.now()).run();
  await e.DB.prepare(`INSERT INTO tasks(id,repo,title,detail,status,version,assignee,result,source_id,lease,lease_until,created_at,updated_at)
    VALUES(?,?,?,?,?,1,NULL,'',?,NULL,NULL,?,?)`)
    .bind('qq-m2', 'OmnixSI/TeamAgent', '补回归测试', '补回归测试', 'queued', 'm2', new Date().toISOString(), new Date().toISOString()).run();
  await putJob(e, 'plan-qq-m2-v1', 'plan', {task: 'qq-m2', version: 1}, 'pending', Date.now() - 3 * 60000);
  await putJob(e, 'media-g2', 'media', {title: '别群视频', message: 'g2m'}, 'pending', Date.now() - 1 * 60000);

  await qq(e, msg('stop1', '/stop'));
  const body = (await outbox(e)).at(-1).body;
  assert.match(body, /已停 4 个/);
  assert.match(body, /转写视频/);
  assert.match(body, /补回归测试/);
  assert.match(body, /B站视频/);
  const byId = Object.fromEntries((await rows(e, 'jobs')).map(j => [j.id, j]));
  for (const id of ['chat-m1', 'media-m1', 'video-vw-m1', 'plan-qq-m2-v1'])
    assert.equal(byId[id].status, 'cancelled', id + ' must be cancelled');
  assert.equal(byId['media-g2'].status, 'pending', 'other groups are untouched');
  assert.equal((await e.DB.prepare('SELECT status FROM video_waits WHERE id=?').bind('vw-m1').first()).status, 'cancelled');

  // The runner learns the cancel from a 409 heartbeat and stops its local work.
  await putJob(e, 'media-live', 'media', {message: 'm1', lease: 'lease-1'}, 'cancelled');
  const beat = await req(e, '/api/runner/media/heartbeat', {id: 'media-live', lease: 'lease-1'}, 'runner-secret');
  assert.equal(beat.status, 409);

  // Repeating the same delivery does not duplicate the reply.
  await qq(e, msg('stop1', '/stop'));
  assert.equal((await outbox(e)).filter(o => o.id === 'cmd-stop1-0').length, 1);
  // A new stop request says there is nothing left.
  await qq(e, msg('stop2', '停'));
  assert.equal((await outbox(e)).at(-1).body, '现在没有在跑的长任务。');
});

test('only the bound group and non-revoked members can use commands', async () => {
  const e = await bind(env());
  await qq(e, msg('p1', '/help', other));
  assert.equal((await outbox(e)).length, 0, 'messages from other groups are ignored');
  await e.DB.prepare('INSERT INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,1)')
    .bind('qq:member1', '被撤销的人', 'hash-not-used', 'member').run();
  await qq(e, msg('p2', '/help'));
  assert.equal((await outbox(e)).length, 0, 'revoked members are ignored');
});

test('recall intent explains the real API limit and sends a correction', async () => {
  const e = await bind(env());
  const { calls } = await withoutNetwork(async () => {
    await qq(e, msg('r1', '撤回你刚才那条'));
    await qq(e, msg('r2', '这个决定我撤回'));
  });
  assert.equal(calls, 0);
  const out = await outbox(e);
  assert.equal(out.length, 2);
  assert.equal(out[0].body, '这条我撤不回，QQ 机器人接口没有开放撤回；我可以发一条『更正』覆盖它');
  assert.match(out[1].body, /^更正：/);
  await qq(e, msg('r3', '停一下吧'));
  await qq(e, msg('r4', '谢谢你的帮助'));
  assert.equal((await outbox(e)).length, 2, 'ordinary chat is not turned into a command');
  await qq(e, msg('r5', '撤回'));
  assert.equal((await outbox(e)).length, 4, 'bare recall gets the same honest reply and correction');
});
