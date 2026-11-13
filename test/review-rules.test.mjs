import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { env } from './support.mjs';
const output = `.wrangler/review-rules-${process.pid}.mjs`;
await build({ stdin: { contents: `export * from './src/review/db.ts'; export * from './src/review/rules.ts'; export {metered} from './src/d1.ts';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', outfile: output });
const api = await import('../' + output);
rmSync(output);
const { reviewWrite, reviewRead, reviewBatch, metered, applyRequirements, advanceRules, revokeRule, activeRulesFor } = api;
const now = Date.parse('2026-11-14T00:00:00Z'), day = 86400000;
const run = (id = 'night1', at = now, group_id = 'g') => ({ id, group_id, now: at });
const get = (e, sql, ...params) => e.DB.prepare(sql).bind(...params).first();
const all = (e, sql, ...params) => e.DB.prepare(sql).bind(...params).all().then(r => r.results);
async function setup() {
  const e = env();
  const migration = readFileSync(new URL('../migrations/0008_review.sql', import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
  for (const sql of migration.split(';').filter(s => s.trim())) await e.DB.prepare(sql).run();
  await e.DB.prepare("INSERT INTO members(id,name,token_hash) VALUES('bound','成员','fake')").run();
  await message(e, 'original', '以后先给结论');
  return e;
}
async function message(e, id, body, sender = 'bound', group = 'g', at = now) {
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)').bind(id, group, sender, body, new Date(at).toISOString()).run();
}
const req = (rule = '先给结论', scene = '回答', evidence = [{ source: 'message', id: 'original', quote: '以后先给结论' }], ttl_days = 30) => ({ rule, scene, evidence, ttl_days });
const ruleRow = async (e, id) => get(e, 'SELECT * FROM behavior_rules WHERE id=?', id);
async function seed(e, id, status = 'canary', patch = {}) {
  const v = { group: 'g', rule: '先给结论', scene: '回答', until: status === 'active' ? now : now + 3 * day, expires: now + 30 * day, hits: 0, corrections: 0, ...patch };
  await e.DB.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,status,canary_until,expires_at,hits,corrections,created_at,updated_at) VALUES(?,?,?,?,'[]','member:bound',?,?,?,?,?,?,?)`).bind(id,v.group,v.rule,v.scene,status,v.until,v.expires,v.hits,v.corrections,now,now).run();
}
async function correction(e, finding, runId, quote = '纠正：不要再遵循「先给结论」', options = {}) {
  const mid = 'm-' + finding;
  await message(e, mid, quote, options.sender || 'bound', options.group || 'g', options.at || now + day);
  await e.DB.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,created_at) VALUES(?,?,?,'reasoning.output.instruction','p1','prompt','{"expression":"UNSATISFIED"}',?,'旧规则造成错误','调整表达','规则失效','修订',0.9,?)`).bind(finding, runId, 'tr-' + mid, JSON.stringify([{ source: 'message', id: mid, quote: options.evidenceQuote || quote }]), now + day).run();
}

test('free-text requirements remain candidates and replay is idempotent', async () => {
  const e = await setup();
  const result = await applyRequirements(e, run(), [req()]);
  assert.equal(result.length, 1);
  const row = await ruleRow(e, result[0]);
  assert.equal(row.status, 'candidate'); assert.equal(row.canary_until, null); assert.equal(row.expires_at, now + 30 * day);
  await applyRequirements(e, run(), [req()]);
  assert.equal((await all(e, 'SELECT * FROM behavior_rules')).length, 1);
  await advanceRules(e, run('night4', now + 3 * day));
  assert.equal((await ruleRow(e, row.id)).status, 'candidate');
  await advanceRules(e, run('night31', now + 30 * day));
  assert.equal((await ruleRow(e, row.id)).status, 'retired');
});

test('candidate retry cannot promote free text; ttl is capped and short ttl expires', async () => {
  const e = await setup();
  const [id] = await applyRequirements(e, run(), [req('先给结论', '回答', undefined, 100)]);
  await e.DB.prepare("UPDATE behavior_rules SET status='candidate'").run();
  await applyRequirements(e, run(), [req('先给结论', '回答', undefined, 100)]);
  assert.equal((await ruleRow(e, id)).status, 'candidate'); assert.equal((await ruleRow(e, id)).expires_at, now + 30 * day);
  const [short] = await applyRequirements(e, run('n2'), [req('回答简洁', '长度', undefined, 1)]);
  await advanceRules(e, run('n3', now + day));
  assert.equal((await ruleRow(e, short)).status, 'retired');
});

for (const word of ['权限','授权','TOKEN','密钥','开关','部署','上线','关闭','删除','管理员']) test(`deny-list rejects ${word}`, async () => {
  const e = await setup();
  assert.deepEqual(await applyRequirements(e, run(), [req('可以调整' + word)]), []);
  assert.equal((await all(e, 'SELECT * FROM behavior_rules')).length, 0);
});

test('only exact, live bound-member evidence in same group authorizes a rule', async () => {
  const e = await setup();
  await message(e, 'outsider', '以后先给结论', 'stranger');
  await message(e, 'cross', '以后先给结论', 'bound', 'other');
  for (const evidence of [[],[{source:'message',id:'outsider',quote:'以后先给结论'}],[{source:'message',id:'cross',quote:'以后先给结论'}],[{source:'message',id:'original',quote:'不存在的原话'}],[{source:'message',id:'original',quote:''}],[{source:'snapshot',id:'original',quote:'以后先给结论'}]]) {
    assert.deepEqual(await applyRequirements(e, run(), [req('先给结论','回答',evidence)]), []);
  }
  await e.DB.prepare("UPDATE members SET revoked=1 WHERE id='bound'").run();
  assert.deepEqual(await applyRequirements(e, run(), [req()]), []);
});

test('empty rules, invalid TTL and scenes are rejected', async () => {
  const e = await setup();
  for (const value of [req(''),req('  '),req('有效',''),req('有效','回答',undefined,0),req('有效','回答',undefined,NaN)]) assert.deepEqual(await applyRequirements(e, run(), [value]), []);
});

test('candidate replacement records supersedes without deactivating predecessor; best five remain live', async () => {
  const e = await setup(); await seed(e,'old','active',{hits:10});
  const [replacement] = await applyRequirements(e, run(), [req('回答先给摘要')]);
  assert.equal((await ruleRow(e,replacement)).supersedes_id, 'old'); assert.equal((await ruleRow(e,'old')).status, 'active');
  for(let i=0;i<5;i++) await seed(e,'top'+i,'active',{scene:'s'+i,hits:i+1});
  await applyRequirements(e, run('next'), [req('表达简洁','长度')]);
  await advanceRules(e,run('next'));
  const live=await all(e,"SELECT * FROM behavior_rules WHERE status IN ('active','canary')");
  assert.equal(live.length,5); assert.ok(live.some(r=>r.id==='old')); assert.equal((await ruleRow(e,'top0')).status,'frozen');
});

test('canary correction rolls back once; repeated advancement cannot double count', async () => {
  const e = await setup(); await seed(e,'r'); await correction(e,'f1','night2');
  await advanceRules(e, run('night2',now+day)); await advanceRules(e, run('night2',now+day));
  const row=await ruleRow(e,'r'); assert.equal(row.status,'retired'); assert.equal(row.corrections,1); assert.ok(row.rollback_reason);
});

test('two distinct active corrections retire rule; same finding and overlapping nights count once', async () => {
  const e = await setup(); await seed(e,'r','active'); await correction(e,'f1','night2');
  await advanceRules(e, run('night2',now+day)); await advanceRules(e, run('night2',now+day));
  assert.equal((await ruleRow(e,'r')).corrections,1); assert.equal((await ruleRow(e,'r')).status,'active');
  // A second finding about the same message is not a second member correction.
  await e.DB.prepare("INSERT INTO review_findings SELECT 'f-duplicate','night3','tr-duplicate',failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,status,fingerprint,reviewed_by,reviewed_at,created_at FROM review_findings WHERE id='f1'").run();
  await advanceRules(e,run('night3',now+2*day)); assert.equal((await ruleRow(e,'r')).corrections,1);
  await correction(e,'f2','night3'); await advanceRules(e,run('night3',now+2*day));
  assert.equal((await ruleRow(e,'r')).status,'retired'); assert.equal((await ruleRow(e,'r')).corrections,2);
});

test('outsider, forged, other-group, unrelated and pre-rule correction evidence cannot retire rule', async () => {
  const e = await setup(); await seed(e,'r');
  await correction(e,'outsider','night2',undefined,{sender:'outsider'});
  await correction(e,'cross','night2',undefined,{group:'other'});
  await correction(e,'forged','night2',undefined,{evidenceQuote:'纠正：先给结论错了'});
  await correction(e,'unrelated','night2','纠正：换一个话题');
  await correction(e,'past','night2',undefined,{at:now-day});
  await advanceRules(e,run('night2',now+day)); assert.equal((await ruleRow(e,'r')).corrections,0);
});

test('manual revoke is atomic, audited, group safe and idempotent', async () => {
  const e=await setup(); await seed(e,'r','active');
  await revokeRule(e,'r','member:bound','成员撤销'); await revokeRule(e,'r','member:bound','再次撤销');
  assert.equal((await ruleRow(e,'r')).status,'retired'); assert.equal((await ruleRow(e,'r')).rollback_reason,'成员撤销');
  assert.equal((await all(e,"SELECT * FROM activity WHERE entity='r'")).length,1);
  assert.equal(await revokeRule(e,'missing','member:bound','撤销'),false);
});

test('prompt rules filter group/status/expiry, order by recency, and cap Unicode characters', async () => {
  const e=await setup();
  for(let i=0;i<7;i++) { await seed(e,'r'+i,i%2?'active':'canary',{rule:'😀'.repeat(100),scene:'s'+i}); await e.DB.prepare('UPDATE behavior_rules SET updated_at=? WHERE id=?').bind(now+i,'r'+i).run(); }
  await seed(e,'frozen','frozen'); await seed(e,'retired','retired'); await seed(e,'expired','active',{expires:now}); await seed(e,'other','active',{group:'other'});
  const rows=await activeRulesFor(e,'g',now); assert.deepEqual(rows.map(r=>r.id),['r6','r5','r4','r3','r2']);
  assert.equal(rows.flatMap(r=>Array.from(r.rule)).length,400); assert.ok(rows.every(r=>Array.from(r.rule).length===80));
});

const allowed = [
  ["INSERT INTO review_rejects(id,run_id,reason,raw,created_at) VALUES('a','n','bad','{}',0)"],
  ["UPDATE review_rejects SET reason='new' WHERE id='a'"],
  ["INSERT INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,expires_at,created_at,updated_at) VALUES('b','g','r','s','[]','x',100,0,0)"],
  ["UPDATE behavior_rules SET hits=hits+1"],
  ["INSERT INTO promises(id,group_id,outbox_id,quote,what,created_at) VALUES('p','g','x','q','w',0)"],
  ["UPDATE promises SET status='kept'"],
  ["INSERT INTO capability_gaps(fingerprint,gap_type,capability,first_seen,last_seen,evidence_json,proposed_action,owner) VALUES('f','tool_missing','x',0,0,'[]','act','dev')"],
  ["UPDATE capability_gaps SET occurrences=occurrences+1"],
  ["INSERT INTO tasks(id,repo,title,detail,status,source_id,created_at,updated_at) VALUES('t','team','[复盘] test','','proposal',?,?,?)",['review:f','date','date']],
  [" \n/* harmless */ iNsErT INTO activity(id,kind,entity,actor,summary,created_at) VALUES('log','review','r','review','semi; --literal','date'); -- trailing"],
  ["INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) VALUES('log','review','r','review','ignore','date')"],
];
test('allowlisted writes execute against real SQLite and reads return rows',async()=>{
  const e=await setup(); for(const [sql,params] of allowed) await reviewWrite(e,sql,params);
  assert.equal((await get(e,"SELECT status FROM tasks WHERE id='t'")).status,'proposal');
  assert.equal((await get(e,"SELECT occurrences FROM capability_gaps WHERE fingerprint='f'")).occurrences,2);
  assert.equal((await reviewRead(e,'SELECT id FROM tasks'))[0].id,'t');
  await reviewWrite(e,"INSERT INTO tasks(id,repo,title,detail,status,source_id,created_at,updated_at) VALUES('t2','t','[复盘]','','proposal','review:literal','',''),('t3','t','[复盘]','','proposal','review:other','','')");
  assert.equal((await reviewRead(e,'SELECT * FROM tasks')).length,3);
});
const denied = [
  "INSERT INTO facts(id,status) VALUES('x','proposal')",
  'UPDATE tasks SET status=\'open\'', 'DELETE FROM tasks', 'delete /*x*/ from behavior_rules', 'INSERT INTO jobs VALUES(1)',
  'INSERT INTO outbox VALUES(1)', 'INSERT INTO messages VALUES(1)', 'UPDATE settings SET value=1',
  "INSERT INTO tasks(id,status,source_id) VALUES('x','open','review:f')",
  "INSERT INTO tasks(id,status,source_id) VALUES('x',?,'review:f')",
  "INSERT INTO tasks(id,status,source_id) VALUES('x','proposal','member:f')",
  "INSERT INTO tasks(id,status,source_id) VALUES('x','proposal',?)",
  "INSERT INTO tasks(id,status,source_id) VALUES('x','proposal','review:f'),('y','open','review:g')",
  "INSERT INTO tasks(id,status,status,source_id) VALUES('x','proposal','open','review:f')",
  "INSERT INTO tasks(id,status,source_id) SELECT 'x','proposal','review:f'",
  "INSERT INTO tasks(id,status,source_id) VALUES('x','proposal','review:f') ON CONFLICT(id) DO UPDATE SET status='open'",
  "INSERT OR REPLACE INTO tasks(id,status,source_id) VALUES('x','proposal','review:f')",
  "INSERT INTO facts(id,status) VALUES('x','active')", "INSERT INTO facts(id,status) VALUES('x',?)",
  "INSERT INTO activity(id) VALUES('x'); DELETE FROM tasks", "INSERT INTO activity(id) VALUES('x'); SELECT 1",
  "/* INSERT INTO activity */ UPDATE tasks SET status='open'", "INSERT/*x*/INTO jobs VALUES(1)",
  "WITH x AS (SELECT 1) INSERT INTO jobs SELECT * FROM x", "WITH x AS (SELECT 1) UPDATE tasks SET status='open'",
  'PRAGMA writable_schema=1', 'CREATE TABLE review_fake(id)', "INSERT INTO main.tasks(status) VALUES('proposal')",
  "INSERT INTO 'activity'(id) VALUES('x')", 'UPDATE reviewX SET x=1', 'UPDATE review_ SET x=1',
  'INSERT INTO activity VALUES(1) /* unterminated', "INSERT INTO activity VALUES('unterminated)",
];
for(const sql of denied) test('write boundary rejects '+sql.slice(0,85),async()=>{
  const e=await setup(), executed=e.DB.executed;
  await assert.rejects(()=>reviewWrite(e,sql,['open']),/review|SQL|proposal|source|write/i);
  assert.equal(e.DB.executed,executed,'rejection must precede database execution');
});

test('batch validates every member before any mutation and meter enforces 48 executions',async()=>{
  const e=metered(await setup());
  await assert.rejects(()=>reviewBatch(e,[{sql:allowed[0][0]},{sql:'DELETE FROM tasks'}]));
  assert.equal((await get(e,'SELECT count(*) AS n FROM review_rejects')).n,0);
  await reviewBatch(e,[{sql:allowed[0][0]},{sql:allowed[1][0]}]); assert.equal(e.meter.used,3);
  e.meter.used=47; await reviewRead(e,'SELECT 1'); assert.equal(e.meter.left(),0);
  await assert.rejects(()=>reviewWrite(e,allowed[1][0]),/资源/);
  await assert.rejects(()=>reviewRead(e,'SELECT 1'),/资源/);
  await assert.rejects(()=>reviewBatch(e,[{sql:allowed[1][0]}]),/资源/);
});
for(const sql of ['UPDATE behavior_rules SET hits=2','WITH x AS (SELECT 1) SELECT * FROM x','SELECT 1; DELETE FROM tasks', 'PRAGMA table_info(tasks)']) test('read boundary rejects '+sql,async()=>{
  const e=await setup(); await assert.rejects(()=>reviewRead(e,sql));
});

// These catch premature promotion and untrusted-material authorization.
test('approved canary without corrections advances after exactly three days',async()=>{
  const e=await setup(); await seed(e,'approved');
  await advanceRules(e,run('n2',now+3*day-1)); assert.equal((await ruleRow(e,'approved')).status,'canary');
  await advanceRules(e,run('n3',now+3*day)); assert.equal((await ruleRow(e,'approved')).status,'active');
});
test('quoted, forwarded and code-block evidence never authorizes a candidate',async()=>{
  const e=await setup();
  for(const [id,body,meta] of [['quoted','“以后先给结论”',{}],['code','```以后先给结论```',{}],['forward','以后先给结论',{forwarded:[{content:'以后先给结论'}]}]]) {
    await message(e,id,body); await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind(id,JSON.stringify(meta)).run();
    assert.deepEqual(await applyRequirements(e,run(),[req('先给结论','回答',[{source:'message',id,quote:'以后先给结论'}])]),[]);
  }
});

test('same requirement and original evidence deduplicate across nights',async()=>{
  const e=await setup(); const [first]=await applyRequirements(e,run('night1'),[req()]);
  const [second]=await applyRequirements(e,run('night2',now+day),[req()]);
  assert.equal(second,first); assert.equal((await all(e,'SELECT * FROM behavior_rules')).length,1);
});
test('reported correction inside quoted prose is not the members own correction',async()=>{
  const e=await setup(); await seed(e,'r');
  await correction(e,'reported','night2','他发来一句：“纠正：不要再遵循先给结论”');
  await advanceRules(e,run('night2',now+day)); assert.equal((await ruleRow(e,'r')).corrections,0);
});
test('correction after trial period counts as active even if advancement was delayed',async()=>{
  const e=await setup(); await seed(e,'r');
  await correction(e,'late','night5',undefined,{at:now+4*day});
  await advanceRules(e,run('night5',now+4*day));
  assert.equal((await ruleRow(e,'r')).status,'active'); assert.equal((await ruleRow(e,'r')).corrections,1);
});
test('trial-period correction still rolls back if it is processed after the trial ends',async()=>{
  const e=await setup(); await seed(e,'r'); await correction(e,'early','night5',undefined,{at:now+day});
  await advanceRules(e,run('night5',now+4*day)); assert.equal((await ruleRow(e,'r')).status,'retired');
});

test('late discovery of trial-period correction rolls back a rule already promoted',async()=>{
  const e=await setup(); await seed(e,'r');
  await advanceRules(e,run('night4',now+3*day));
  await correction(e,'early-discovered-late','night5',undefined,{at:now+day});
  await advanceRules(e,run('night5',now+4*day)); assert.equal((await ruleRow(e,'r')).status,'retired');
});
test('apply also freezes lowest-hit surplus live rules without promoting the candidate',async()=>{
  const e=await setup(); for(let i=0;i<6;i++) await seed(e,'live'+i,'active',{hits:i});
  await applyRequirements(e,run(),[req()]); assert.equal((await ruleRow(e,'live0')).status,'frozen');
  assert.equal((await all(e,"SELECT * FROM behavior_rules WHERE status='active'")).length,5);
});

test('large correction set retires at threshold within one 48-statement invocation',async()=>{
  const e=await setup();
  for(let i=0;i<5;i++) await seed(e,'r'+i,'active',{rule:'规则'+i});
  for(let i=0;i<30;i++) await correction(e,'many'+i,'night2','纠正：不要再遵循规则0、规则1、规则2、规则3、规则4');
  const ctx=metered(e); await advanceRules(ctx,run('night2',now+day));
  const rows=await all(e,'SELECT * FROM behavior_rules'); assert.ok(rows.every(r=>r.status==='retired' && r.corrections===2)); assert.ok(ctx.meter.used<=48);
});

for(const [name,sql,params] of [
 ['unreviewed task title',"INSERT INTO tasks(id,status,source_id,title) VALUES('x','proposal','review:x','执行计划')",[]],
 ['empty task source',"INSERT INTO tasks(id,status,source_id,title) VALUES('x','proposal','review:','[复盘] test')",[]],
 ['bound source is validated',"INSERT INTO tasks(id,status,source_id,title) VALUES('x','proposal',?,'[复盘] test')",['member:x']],
]) test(name,async()=>{ const e=await setup(), before=e.DB.executed; await assert.rejects(()=>reviewWrite(e,sql,params)); assert.equal(e.DB.executed,before); });
