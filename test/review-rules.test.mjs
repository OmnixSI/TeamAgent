import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';
import { env } from './support.mjs';
const output = `.wrangler/review-rules-${process.pid}.mjs`;
await build({ stdin: { contents: `export * from './src/review/db.ts'; export * from './src/review/rules.ts'; export {metered} from './src/d1.ts';`, resolveDir: process.cwd() }, bundle: true, format: 'esm', platform: 'browser', outfile: output });
const api = await import('../' + output);
rmSync(output);
const { reviewWrite, reviewRead, reviewBatch, metered, applyRequirements, advanceRules, revokeRule, activeRulesFor, approveRule, applyMemoryCandidate, reviewWriteAdmin } = api;
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
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,1)').bind(id, group, sender, body, new Date(at).toISOString()).run();
}
const req = (rule = '先给结论', scene = '回答', evidence = [{ source: 'message', id: 'original', quote: '以后先给结论', origin: 'direct' }], ttl_days = 30) => ({ kind: 'free', params: {}, rule, scene, evidence, ttl_days });
const ruleRow = async (e, id) => get(e, 'SELECT * FROM behavior_rules WHERE id=?', id);
async function seed(e, id, status = 'canary', patch = {}) {
  const v = { group: 'g', rule: '先给结论', scene: '回答', until: status === 'active' ? now : now + 3 * day, expires: now + 30 * day, hits: 0, corrections: 0, ...patch };
  await e.DB.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,status,canary_until,expires_at,hits,corrections,created_at,updated_at) VALUES(?,?,?,?,'[]','member:bound',?,?,?,?,?,?,?)`).bind(id,v.group,v.rule,v.scene,status,v.until,v.expires,v.hits,v.corrections,now,now).run();
  for(let i=0;i<v.hits;i++) await e.DB.prepare("INSERT INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('rule_hit',?,?,?,?)").bind(id,'seed'+i,'seed',now).run();
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
  await e.DB.prepare("INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,status,fingerprint,reviewed_by,reviewed_at,created_at) SELECT 'f-duplicate','night3','tr-duplicate',failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,status,fingerprint,reviewed_by,reviewed_at,created_at FROM review_findings WHERE id='f1'").run();
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
    assert.deepEqual(await applyRequirements(e,run(),[req('先给结论','回答',[{source:'message',id,quote:'以后先给结论',origin:'direct'}])]),[]);
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

const direct = (id='original',quote='以后先给结论') => [{source:'message',id,quote,origin:'direct'}];
const typed = (kind='burst_max',params={max:1},evidence=direct(),ttl_days=7) => ({kind,params,rule:'模型自由发挥不要用这句',scene:'回答',evidence,ttl_days});
async function agreement(e,state='agree',runId='night1',evidence=direct()) {
  await e.DB.prepare(`INSERT INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,created_at) VALUES(?,?,?,'reasoning.output.format','p1','prompt','{}',?,'发生','期望','根因','计划',0.9,?,?)`).bind('agree-'+runId,runId,'trace-'+runId,JSON.stringify(evidence),state,now).run();
}

test('VD-R1-G13 typed burst rule renders template, enters trial with agreement, supersedes predecessor',async()=>{
  const e=await setup(); await agreement(e); await seed(e,'prior','active');
  const [id]=await applyRequirements(e,run(),[typed()]); const r=await ruleRow(e,id);
  assert.equal(r.kind,'burst_max'); assert.deepEqual(JSON.parse(r.params),{max:1}); assert.equal(r.rule,'每次连续回复最多1条。'); assert.equal(r.status,'canary');
  assert.equal(r.canary_until,now+3*day); assert.equal(r.expires_at,now+7*day); assert.equal(r.supersedes_id,'prior'); assert.equal((await ruleRow(e,'prior')).status,'frozen');
  await applyRequirements(e,run('later',now+day),[typed()]); assert.equal((await all(e,"SELECT * FROM behavior_rules WHERE kind='burst_max'")).length,1);
});
for(const [kind,params,ttl,expected] of [
 ['reply_max_chars',{max:80},30,'回复最多80字。'],['reply_max_chars',{max:2000},30,'回复最多2000字。'],
 ['burst_max',{max:4},30,'每次连续回复最多4条。'],['mention_only_window',{minutes:30},1,'未来30分钟仅在被点名时回复。'],
 ['mention_only_window',{minutes:120},1,'未来120分钟仅在被点名时回复。'],['language',{language:'zh'},30,'使用中文回复。'],
 ['language',{language:'en'},30,'使用英文回复。'],['format_pref',{format:'plain'},30,'优先使用普通段落回复。'],['format_pref',{format:'list'},30,'优先使用列表回复。'],['format_pref',{format:'table'},30,'优先使用表格回复。'],
]) test('VD-R1 typed boundary '+kind+' '+JSON.stringify(params),async()=>{
  const e=await setup(); await agreement(e); const [id]=await applyRequirements(e,run(),[typed(kind,params,direct(),ttl)]);
  const row=await ruleRow(e,id); assert.equal(row.status,'canary'); assert.equal(row.rule,expected);
});
for(const [kind,params,ttl] of [
 ['reply_max_chars',{max:79},30],['reply_max_chars',{max:2001},30],['reply_max_chars',{max:'80'},30],['burst_max',{max:0},30],['burst_max',{max:5},30],['burst_max',{max:1.5},30],
 ['burst_max',{max:1,extra:'关闭主动参与'},30],['mention_only_window',{minutes:29},1],['mention_only_window',{minutes:121},1],['mention_only_window',{minutes:30},2],
 ['language',{language:'fr'},30],['format_pref',{format:'html'},30],['participation_off',{},1],
]) test('VD-R1 rejects parameter escape '+kind+' '+JSON.stringify(params),async()=>{
  const e=await setup(); await agreement(e); assert.deepEqual(await applyRequirements(e,run(),[typed(kind,params,direct(),ttl)]),[]);
});
for(const state of ['single','pending','disagree']) test('VD-R1 agreement '+state+' cannot auto promote',async()=>{
  const e=await setup(); await agreement(e,state); const ids=await applyRequirements(e,run(),[typed()]);
  if(state==='disagree') assert.deepEqual(ids,[]); else assert.equal((await ruleRow(e,ids[0])).status,'candidate');
});
test('VD-R1 agreement on unrelated evidence cannot authorize promotion',async()=>{
  const e=await setup(); await agreement(e,'agree','night1',direct('absent','请简短回复')); const [id]=await applyRequirements(e,run(),[typed()]); assert.equal((await ruleRow(e,id)).status,'candidate');
});
test('VD-R1-FREE candidate needs explicit admin approval; approval and expiry are idempotent',async()=>{
  const e=await setup(); await agreement(e); const [id]=await applyRequirements(e,run(),[req()]); assert.equal((await ruleRow(e,id)).status,'candidate');
  assert.equal(typeof approveRule,'function'); assert.equal(await approveRule(e,id,'admin:owner'),true);
  const first=await ruleRow(e,id); assert.equal(first.status,'canary'); assert.equal(first.approved_by,'admin:owner');
  assert.equal(await approveRule(e,id,'other-admin'),true); assert.equal((await ruleRow(e,id)).canary_until,first.canary_until); assert.equal((await ruleRow(e,id)).approved_by,'admin:owner');
});
for(const sample of ['quoted','forwarded','code','image','unbound','revoked','other','statement','fake-origin']) test('VD-R1-PROV rejects '+sample,async()=>{
  const e=await setup(); let body='以后请简短回复',sender='bound',meta={},origin='direct',mentioned=1;
  if(sample==='quoted') body='有人说“以后请简短回复”';
  if(sample==='forwarded') meta={forwarded:[{content:body}]};
  if(sample==='code') body='```以后请简短回复```';
  if(sample==='image') {body='图片';origin='image_text';}
  if(sample==='unbound') sender='stranger';
  if(sample==='revoked') await e.DB.prepare("UPDATE members SET revoked=1").run();
  if(sample==='other') mentioned=0;
  if(sample==='statement') body='他昨天回复很简短';
  if(sample==='fake-origin') origin='quoted';
  await message(e,'p',body,sender); await e.DB.prepare('UPDATE messages SET mentioned=? WHERE id=?').bind(mentioned,'p').run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind('p',JSON.stringify(meta)).run();
  const evidence=direct('p','以后请简短回复'); if(sample==='statement') evidence[0].quote=body; evidence[0].origin=origin;
  await agreement(e,'agree','night1',evidence); assert.deepEqual(await applyRequirements(e,run(),[typed('reply_max_chars',{max:100},evidence)]),[]);
});
test('VD-R1 qq-prefixed live binding and explicit bot reply pass admission',async()=>{
  const e=await setup(); await e.DB.prepare("UPDATE members SET id='qq:bound'").run(); await e.DB.prepare('UPDATE messages SET mentioned=0').run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind('original',JSON.stringify({replyTo:{kind:'bot'}})).run();
  await agreement(e); const [id]=await applyRequirements(e,run(),[typed()]); assert.equal((await ruleRow(e,id)).status,'canary');
});
test('VD-R4-IDEM counters are counts of unique ledger events and do not trust stale counters',async()=>{
  const e=await setup(); await seed(e,'r','active'); await e.DB.prepare('UPDATE behavior_rules SET hits=999,corrections=999').run();
  await e.DB.prepare("INSERT INTO review_consumed VALUES('rule_hit','r','event','night1',?)").bind(now).run();
  await correction(e,'c1','night2'); await advanceRules(e,run('night2',now+day)); await advanceRules(e,run('night2',now+day));
  const r=await ruleRow(e,'r'); assert.equal(r.hits,1); assert.equal(r.corrections,1); assert.equal(r.status,'active');
  assert.equal((await get(e,"SELECT count(*) AS n FROM review_consumed WHERE kind='rule_correction' AND subject='r'")).n,1);
});

async function memory(e,id='mc-add',patch={}) {
  const v={op:'ADD',repo:'team',subject:'成员',predicate:'偏好',value:'先给结论',target_fact_id:null,target_version:null,source_msg_id:'original',evidence_json:JSON.stringify(direct()),...patch};
  await e.DB.prepare(`INSERT INTO review_memory_candidates(id,run_id,group_id,op,repo,subject,predicate,value,target_fact_id,target_version,source_msg_id,evidence_json,created_at) VALUES(?,'night1','g',?,?,?,?,?,?,?,?,?,?)`).bind(id,v.op,v.repo,v.subject,v.predicate,v.value,v.target_fact_id,v.target_version,v.source_msg_id,v.evidence_json,now).run();
}
const candidate=(e,id)=>get(e,'SELECT * FROM review_memory_candidates WHERE id=?',id);
async function oldFact(e,id='old',value='旧偏好') { await e.DB.prepare("INSERT INTO facts VALUES(?,'team','成员','偏好',?,'原话','old-msg','confirmed','v1',NULL)").bind(id,value).run(); }

test('VD-R2-MEM memory isolation and explicit admin application replay return one original fact id',async()=>{
  const e=await setup(); await memory(e); assert.equal((await all(e,'SELECT * FROM facts')).length,0);
  assert.equal(typeof applyMemoryCandidate,'function'); assert.equal(reviewWriteAdmin.applyMemoryCandidate,applyMemoryCandidate);
  const id=await applyMemoryCandidate(e,'mc-add','admin:owner'); assert.ok(id); assert.equal(await applyMemoryCandidate(e,'mc-add','admin:other'),id);
  assert.equal((await candidate(e,'mc-add')).status,'applied'); const rows=await all(e,'SELECT * FROM facts'); assert.equal(rows.length,1); assert.equal(rows[0].id,id); assert.equal(rows[0].status,'confirmed');
});
test('VD-R2-MEM tombstone for any evidence source blocks writing facts',async()=>{
  const e=await setup(); await memory(e); await e.DB.prepare("INSERT INTO memory_blocks VALUES('original','其他','其他')").run();
  assert.equal(await applyMemoryCandidate(e,'mc-add','admin'),null); assert.equal((await candidate(e,'mc-add')).status,'blocked'); assert.equal((await all(e,'SELECT * FROM facts')).length,0);
});
test('VD-R2-MEM duplicate fact supersedes candidate without adding a row',async()=>{
  const e=await setup(); await oldFact(e,'existing','先给结论'); await memory(e);
  await applyMemoryCandidate(e,'mc-add','admin'); assert.equal((await candidate(e,'mc-add')).status,'superseded'); assert.equal((await all(e,'SELECT * FROM facts')).length,1);
});
for(const op of ['UPDATE','DELETE']) test('VD-R2-MEM '+op+' stale version conflicts and preserves active fact',async()=>{
  const e=await setup(); await oldFact(e); await memory(e,'mc-op',{op,target_fact_id:'old',target_version:'v0'});
  assert.equal(await applyMemoryCandidate(e,'mc-op','admin'),null); assert.equal((await candidate(e,'mc-op')).status,'conflict'); assert.equal((await get(e,"SELECT * FROM facts WHERE id='old'")).valid_to,null);
});
for(const op of ['UPDATE','DELETE']) test('VD-R2-MEM '+op+' explicitly approved is versioned and replay-safe',async()=>{
  const e=await setup(); await oldFact(e); await memory(e,'mc-op',{op,target_fact_id:'old',target_version:'v1'});
  const id=await applyMemoryCandidate(e,'mc-op','admin'); assert.ok(id); assert.ok((await get(e,"SELECT * FROM facts WHERE id='old'")).valid_to);
  assert.equal(await applyMemoryCandidate(e,'mc-op','admin'),id);
  assert.equal((await all(e,'SELECT * FROM facts WHERE valid_to IS NULL')).length,op==='UPDATE'?1:0);
  if(op==='DELETE') assert.ok(await get(e,"SELECT * FROM memory_blocks WHERE source_id='old-msg'"));
});
for(const patch of [ {value:'sk-Abcdef123456'}, {evidence_json:JSON.stringify([{source:'image',id:'original',quote:'以后先给结论'}])}, {source_msg_id:'missing'}, {evidence_json:JSON.stringify(direct('original','不在原话'))} ]) test('VD-R2-MEM invalid or sensitive candidate blocked '+JSON.stringify(patch),async()=>{
  const e=await setup(); await memory(e,'bad',patch); assert.equal(await applyMemoryCandidate(e,'bad','admin'),null); assert.equal((await candidate(e,'bad')).status,'blocked'); assert.equal((await all(e,'SELECT * FROM facts')).length,0);
});
test('VD-R2-MEM admin surface exposes no arbitrary SQL writer and worker surface rejects protected tables',async()=>{
  assert.equal(typeof reviewWriteAdmin,'object'); assert.deepEqual(Object.keys(reviewWriteAdmin),['applyMemoryCandidate']);
  const e=await setup(); for(const sql of ["UPDATE facts SET value='x'","INSERT INTO memory_blocks VALUES('x','s','p')","INSERT INTO turn_offers(turn_id) VALUES('x')","UPDATE turn_offers SET names='[]'"]) await assert.rejects(()=>reviewWrite(e,sql));
});
test('VD-R2-MEM review v2 tables are writable but turn_offers stays readable only',async()=>{
  const e=await setup();
  await reviewBatch(e,[
    {sql:"INSERT INTO review_budget(day_utc,provider,unit,cap,updated_at) VALUES('2026-11-14','openai','usd_micros',100,0)"},
    {sql:"INSERT INTO review_cursors(group_id,stream,updated_at) VALUES('g','messages',0)"},
    {sql:"INSERT INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,reserved,max_tokens,created_at) VALUES('j','r',1,'primary','deepseek','m','[]',1,10,0)"},
    {sql:"INSERT INTO review_consumed VALUES('rule_hit','r','event','night1',0)"},
  ]); assert.deepEqual(await reviewRead(e,'SELECT * FROM turn_offers'),[]);
});

test('VD-R1 bounded mention-only window expires after its minutes instead of resetting on each prompt',async()=>{
  const e=await setup(); await agreement(e); const [id]=await applyRequirements(e,run(),[typed('mention_only_window',{minutes:30},direct(),1)]);
  assert.equal((await ruleRow(e,id)).expires_at,now+30*60000); assert.equal((await activeRulesFor(e,'g',now+30*60000)).length,0);
});
test('VD-R4 task proposals support INSERT OR IGNORE replay without changing an existing proposal',async()=>{
  const e=await setup(); const sql="INSERT OR IGNORE INTO tasks(id,repo,title,detail,status,source_id,created_at,updated_at) VALUES('rv-f','team','[复盘] test',?,'proposal','review:f','','')";
  await reviewWrite(e,sql,['first']); await reviewWrite(e,sql,['second']); assert.equal((await get(e,"SELECT detail FROM tasks WHERE id='rv-f'")).detail,'first');
});
test('VD-R1 approved candidate cannot race a member revocation',async()=>{
  const e=await setup(); const [id]=await applyRequirements(e,run(),[req()]);
  const batch=e.DB.batch.bind(e.DB); let revoke=true;
  e.DB.batch=async list=>{ if(revoke) {revoke=false; await e.DB.prepare('UPDATE members SET revoked=1').run();} return batch(list); };
  assert.equal(await approveRule(e,id,'admin'),false); assert.equal((await ruleRow(e,id)).status,'candidate');
});
test('VD-R1 automatic admission cannot race a member revocation',async()=>{
  const e=await setup(); await agreement(e); const batch=e.DB.batch.bind(e.DB);
  e.DB.batch=async list=>{ await e.DB.prepare('UPDATE members SET revoked=1').run(); return batch(list); };
  await applyRequirements(e,run(),[typed()]); assert.equal((await all(e,"SELECT * FROM behavior_rules WHERE status='canary'")).length,0);
});
test('VD-R2-MEM incomplete code fence is never direct memory evidence',async()=>{
  const e=await setup(); await e.DB.prepare("UPDATE messages SET body='```以后先给结论' WHERE id='original'").run(); await memory(e);
  assert.equal(await applyMemoryCandidate(e,'mc-add','admin'),null); assert.equal((await candidate(e,'mc-add')).status,'blocked');
});
test('VD-R1 freeze policy uses ledger hits instead of stale hit counters',async()=>{
  const e=await setup(); for(let i=0;i<6;i++) await seed(e,'r'+i,'active',{scene:'s'+i,hits:i});
  await e.DB.prepare("UPDATE behavior_rules SET hits=999 WHERE id='r0'").run(); await applyRequirements(e,run(),[req()]);
  assert.equal((await ruleRow(e,'r0')).status,'frozen');
});

// D1 batch is transactional; exercise the SQL against SQLite with the same contract.
function atomic(e) {
  const db=e.DB; let tail=Promise.resolve();
  db.batch=list=>{
    const result=tail.then(async()=>{
      await db.prepare('BEGIN IMMEDIATE').run();
      try { const results=[]; for(const s of list) results.push(await s.run()); await db.prepare('COMMIT').run(); return results; }
      catch(error) { await db.prepare('ROLLBACK').run(); throw error; }
    });
    tail=result.catch(()=>{}); return result;
  };
  return e;
}
test('VD-R2-MEM concurrent approvals of one candidate return the same fact and one audit event',async()=>{
  const e=atomic(await setup()); await memory(e);
  const ids=await Promise.all([applyMemoryCandidate(e,'mc-add','a'),applyMemoryCandidate(e,'mc-add','b')]);
  assert.ok(ids[0]); assert.equal(ids[0],ids[1]); assert.equal((await all(e,'SELECT * FROM facts')).length,1);
  assert.equal((await all(e,"SELECT * FROM activity WHERE kind='review_memory_applied'")).length,1);
});
test('VD-R2-MEM competing edits detect target_version inside transaction',async()=>{
  const e=atomic(await setup()); await oldFact(e); await memory(e,'edit1',{op:'UPDATE',value:'新偏好甲',target_fact_id:'old',target_version:'v1'});
  await memory(e,'edit2',{op:'UPDATE',value:'新偏好乙',target_fact_id:'old',target_version:'v1'});
  await Promise.all([applyMemoryCandidate(e,'edit1','a'),applyMemoryCandidate(e,'edit2','b')]);
  const rows=await all(e,"SELECT * FROM facts WHERE valid_to IS NULL"); assert.equal(rows.length,1);
  assert.deepEqual((await all(e,'SELECT status FROM review_memory_candidates ORDER BY status')).map(r=>r.status),['applied','conflict']);
});
test('VD-R2-MEM failed facts insert rolls back old-version expiration and candidate approval',async()=>{
  const e=atomic(await setup()); await oldFact(e); await memory(e,'edit',{op:'UPDATE',target_fact_id:'old',target_version:'v1'});
  await e.DB.prepare("CREATE TRIGGER reject_new_fact BEFORE INSERT ON facts BEGIN SELECT RAISE(ABORT,'test refusal'); END").run();
  await assert.rejects(()=>applyMemoryCandidate(e,'edit','a'),/test refusal/);
  assert.equal((await get(e,"SELECT valid_to FROM facts WHERE id='old'")).valid_to,null); assert.equal((await candidate(e,'edit')).status,'candidate');
});
test('VD-R2-MEM tombstone arriving after preflight is checked in the write transaction',async()=>{
  const e=atomic(await setup()); await memory(e); const batch=e.DB.batch.bind(e.DB);
  e.DB.batch=async list=>{ await e.DB.prepare("INSERT INTO memory_blocks VALUES('original','成员','偏好')").run(); return batch(list); };
  assert.equal(await applyMemoryCandidate(e,'mc-add','a'),null); assert.equal((await candidate(e,'mc-add')).status,'blocked'); assert.equal((await all(e,'SELECT * FROM facts')).length,0);
});
test('VD-R4-IDEM simultaneous advancement consumes each correction once',async()=>{
  const e=atomic(await setup()); await seed(e,'r','active'); await correction(e,'once','night2');
  await Promise.all([advanceRules(e,run('night2',now+day)),advanceRules(e,run('night2',now+day))]);
  assert.equal((await ruleRow(e,'r')).corrections,1); assert.equal((await ruleRow(e,'r')).status,'active');
  assert.equal((await get(e,"SELECT count(*) AS n FROM review_consumed WHERE kind='rule_correction'")).n,1);
});
test('VD-R1 ownClauses helper stays equivalent to authz on quoted/code fixtures',async()=>{
  for(const [body,expected] of [
    ['以后请简短回复',['以后请简短回复']], ['他说“不要回”，请少发一点',['他说','请少发一点']],
    ['```以后不要回```\n@Bot 以后用列表',['','以后用列表']], ["'请不要回复'，以后先给结论",['','以后先给结论']],
  ]) assert.deepEqual(api.reviewOwnClauses(body),expected);
});
test('VD-R2-MEM ordinary review write parameters redact short OpenAI keys',async()=>{
  const e=await setup(); await reviewWrite(e,'INSERT INTO activity VALUES(?,?,?,?,?,?)',['secret-log','review','x','review','sk-Abcdef123456','date']);
  const row=await get(e,"SELECT summary FROM activity WHERE id='secret-log'"); assert.equal(row.summary,'[密钥已隐藏]');
});

test('VD-R1 disagree prevents free-text candidates as well as typed trial rules',async()=>{
  const e=await setup(); await agreement(e,'disagree'); assert.deepEqual(await applyRequirements(e,run(),[req()]),[]);
});
test('VD-R1 empty finding quotation cannot supply dual agreement',async()=>{
  const e=await setup(); await agreement(e,'agree','night1',direct('original','')); const [id]=await applyRequirements(e,run(),[typed()]);
  assert.equal((await ruleRow(e,id)).status,'candidate');
});
test('VD-R1 admission race does not return a phantom candidate id',async()=>{
  const e=await setup(); await agreement(e); const batch=e.DB.batch.bind(e.DB);
  e.DB.batch=async list=>{ await e.DB.prepare('UPDATE members SET revoked=1').run(); return batch(list); };
  assert.deepEqual(await applyRequirements(e,run(),[typed()]),[]);
});
