import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {sendFixture,mockQQ} from './send-sql-support.mjs';
mkdirSync('.agent',{recursive:true});
const outfile=`.wrangler/send-pipeline-unit-${process.pid}.mjs`;
await build({stdin:{contents:'export {sendOutbox,pruneEventLayer,optionalCron,default as worker} from "./src/worker"; export {metered,COST} from "./src/d1";export * from "./src/send/enqueue"; export {recoverSendingSQL} from "./src/send/lane";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const {sendOutbox,pruneEventLayer,optionalCron,worker,metered,COST,enqueueText,enqueueStatements,recoverSendingSQL}=await import('../'+outfile);
const now=Date.now(),budgetCounts={};
const ok=()=>Response.json({id:'sent',ext_info:{ref_idx:crypto.randomUUID()}});
for(const status of ['pending','retry'])test(`M1-S ${status} locks, claims and records success`,async()=>{
 const f=sendFixture();f.out('a',status);f.source();
 await mockQQ(ok,async sends=>{const e=metered(f.e);await sendOutbox(e);assert.equal(sends.length,1);assert.equal(f.row().status,'sent');assert.equal(sends[0].msg_seq,1);assert.equal(sends[0].msg_id,'src');assert.ok(e.meter.used<=15);});
});
test('M1-S enqueue emits pending root and held tails, replay is idempotent',async()=>{
 const f=sendFixture();const options={id:'parts',group:'g',msgId:'src',body:'段落。'.repeat(1500)};
 await enqueueText(f.e,options);await enqueueText(f.e,options);
 assert.deepEqual(f.sqlite.prepare('SELECT id,status FROM outbox ORDER BY id').all().map(x=>({...x})),[{id:'parts',status:'pending'},{id:'parts~1',status:'held'},{id:'parts~2',status:'held'}]);assert.equal(f.e.enqueued,true);
});
test('M1-S guarded enqueue preserves guard and remains one truncated statement',async()=>{
 const f=sendFixture();const o={id:'guard',group:'g',msgId:null,body:'长'.repeat(9000),from:{sql:'FROM settings WHERE key=? AND value=?',args:['guard','yes']}};
 assert.equal(enqueueStatements(f.e,o).length,1);await f.e.DB.batch(enqueueStatements(f.e,o));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbox').get().n,0);
 f.setting('guard','yes');await f.e.DB.batch(enqueueStatements(f.e,o));await f.e.DB.batch(enqueueStatements(f.e,o));assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);assert.ok(f.row('guard').body.length<=1800);assert.match(f.row('guard').body,/…$/);
});
test('M1-S reference failure clears pair and retries without reference within remaining budget',async()=>{
 const f=sendFixture();f.out();f.source();f.sqlite.prepare('INSERT INTO outbox_meta VALUES(?,?)').run('a','{"reference":"REF"}');
 await mockQQ(b=>b.message_reference?Response.json({code:123},{status:400}):ok(),async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,2);assert.equal(sends[1].message_reference,undefined);assert.equal(sends[1].msg_seq,2);assert.equal(f.row().status,'sent');assert.equal(f.sqlite.prepare("SELECT value FROM settings WHERE key='quote_fail'").get().value,'1');});
});
test('M1-S three 429 attempts retain one pair and fail at the retry limit',async()=>{
 const f=sendFixture();f.out();f.source();
 await mockQQ(()=>Response.json({code:9},{status:429}),async sends=>{for(let i=0;i<3;i++){await sendOutbox(metered(f.e));f.sqlite.prepare('UPDATE outbox_send SET not_before=0').run();}assert.equal(sends.length,3);assert.deepEqual(sends.map(x=>[x.msg_id,x.msg_seq]),[['src',1],['src',1],['src',1]]);assert.equal(f.row().status,'failed');assert.equal(f.sqlite.prepare('SELECT used FROM passive_claims').get().used,1);});
});
for(const resend of [false,true])test(`M1-S ambiguous response is unknown; resend=${resend} uses the same pair once`,async()=>{
 const f=sendFixture();f.out();f.source();if(resend)f.setting('off:unknown_resend','0');
 await mockQQ(()=>Response.json({code:9},{status:503}),async sends=>{for(let i=0;i<3;i++)await sendOutbox(metered(f.e));assert.equal(f.row().status,'unknown');assert.equal(sends.length,resend?2:1);if(resend)assert.deepEqual(sends[0],sends[1]);});
});
test('M1-S unknown predecessor keeps held tails out of LIMIT and causes no self-wake',async()=>{
 const f=sendFixture();f.source();f.out('root','unknown');f.out('root~1','held');f.out('root~2','held');f.out('fresh');
 await mockQQ(ok,async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,1);assert.equal(f.row('fresh').status,'sent');assert.equal(f.row('root~1').status,'held');assert.equal(f.e.WORK.sent.length,0);});
});
test('M1-S failed predecessor skips its tail with a durable reason',async()=>{
 const f=sendFixture();f.out('root','failed');f.out('root~1','held');
 await mockQQ(ok,async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,0);assert.equal(f.row('root~1').status,'skipped');assert.equal(f.row('root~1').reason,'prev_failed');assert.equal(f.e.WORK.sent.length,0);});
});
test('M1-S no passive quota and rejected active sending is terminal no_passive',async()=>{
 const f=sendFixture();f.out();f.setting('qq:active_rejected','1');
 await mockQQ(ok,async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,0);assert.equal(f.row().status,'skipped');assert.equal(f.row().reason,'no_passive');});
});
for(const remaining of [48,31,19,18,3])test(`M1-S budget left=${remaining} reserves the tail and defers instead of exceeding 48`,async()=>{
 const f=sendFixture();f.source();for(let i=0;i<4;i++)f.out('a'+i);f.e.enqueued=true;
 await mockQQ(ok,async sends=>{const e=metered(f.e);e.meter.used=48-remaining;await sendOutbox(e);assert.ok(e.meter.used<=46);assert.equal(COST.send_row,15);budgetCounts[remaining]={statements:f.e.DB.executed,rows:sends.length,totalUsed:e.meter.used,wakes:f.e.WORK.sent.length};writeFileSync('.agent/m1-s-budget.json',JSON.stringify(budgetCounts,null,2));if(remaining>=19)assert.ok(sends.length>=1);else {assert.equal(sends.length,0);assert.equal(f.e.DB.executed,0);assert.equal(f.e.WORK.sent.length,1);}if(remaining===19)assert.equal(sends.length,1);});
});
test('M1-S contended lane consumes seven claims plus one release and does not self-wake',async()=>{
 const f=sendFixture();f.out();f.source();f.sqlite.prepare('INSERT INTO send_lanes VALUES(?,?,?)').run('g','other',now+900000);
 await mockQQ(ok,async sends=>{const e=metered(f.e);await sendOutbox(e);assert.equal(e.meter.used,2+8);assert.equal(sends.length,0);assert.equal(f.e.WORK.sent.length,0);});
});
test('M1-S rollback SQL twice closes six v2 remnants and revives only untouched tails',()=>{
 const f=sendFixture();for(const [id,status] of [['retry','retry'],['sent','sent'],['sent~1','held'],['untouched','pending'],['untouched~1','held'],['unknown','unknown'],['issued','sending'],['unissued','sending']])f.out(id,status);
 for(const [id,seq] of [['retry',1],['unknown',1],['issued',1],['unissued',null]])f.sqlite.prepare('INSERT INTO outbox_send(id,msg_seq,lock_tok,claimed_at) VALUES(?,?,?,?)').run(id,seq,'tok',now-121000);
 const sql=readFileSync('scripts/rollback-event-v2.sql','utf8');f.sqlite.exec(sql);f.sqlite.exec(sql);
 assert.equal(f.row('retry').status,'skipped');assert.equal(f.row('sent~1').status,'skipped');assert.equal(f.row('untouched~1').status,'pending');assert.equal(f.row('unknown').status,'unknown');assert.equal(f.row('issued').status,'unknown');assert.equal(f.row('unissued').status,'unknown');
 assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE status IN ('retry','held')").get().n,0);
});

const legacyOut=`.wrangler/send-legacy-unit-${process.pid}.mjs`;
await build({entryPoints:['test/legacy/send-68ef1c3.mjs'],bundle:true,format:'esm',platform:'browser',outfile:legacyOut});
const legacy=await import('../'+legacyOut);
test('M1-S the frozen 68ef1c3 sender cannot send five touched remnants after two rollbacks',async()=>{
 const f=sendFixture();for(const [id,status] of [['retry','retry'],['sent','sent'],['sent~1','held'],['root','pending'],['root~1','held'],['unknown','unknown'],['issued','sending'],['unissued','sending']])f.out(id,status);
 for(const [id,seq] of [['retry',1],['unknown',1],['issued',1],['unissued',null]])f.sqlite.prepare('INSERT INTO outbox_send(id,msg_seq,lock_tok,claimed_at) VALUES(?,?,?,?)').run(id,seq,'tok',now-121000);
 const sql=readFileSync('scripts/rollback-event-v2.sql','utf8');f.sqlite.exec(sql);f.sqlite.exec(sql);
 await mockQQ(ok,async sends=>{await legacy.sendOutbox(f.e);await legacy.recover(f.e,now+121000);assert.equal(sends.length,2);assert.deepEqual(f.sqlite.prepare("SELECT id FROM outbox WHERE status='sent' ORDER BY id").all().map(r=>r.id),['root','root~1','sent']);assert.equal(f.row('issued').status,'unknown');assert.equal(f.row('unissued').status,'unknown');});
});
test('M1-S untouched legacy code also ignores retry and held before rollback SQL',async()=>{
 const f=sendFixture();f.out('a','retry');f.out('a~1','held');
 await mockQQ(ok,async sends=>{await legacy.sendOutbox(f.e);await legacy.recover(f.e,now+121000);assert.equal(sends.length,0);assert.equal(f.row().status,'retry');assert.equal(f.row('a~1').status,'held');});
});
for(let k=1;k<=6;k++)test(`M1-S HTTP interruption ${k}: failed atomic batch sends nothing, next invocation sends once`,async()=>{
 const f=sendFixture();f.out();f.source();f.e.DB.failAfter=k;
 await mockQQ(ok,async sends=>{await assert.rejects(()=>sendOutbox(metered(f.e)),/injected/);assert.equal(sends.length,0);await sendOutbox(metered(f.e));assert.equal(sends.length,1);assert.equal(f.row().status,'sent');});
});
for(const [name,code,status] of [['duplicate',40054005,'sent'],['blocked',40034006,'failed'],['muted',40054002,'failed']])test(`M1-S verified ${name} receipt is ${status} and never causes a reference retry`,async()=>{
 const f=sendFixture();f.out();f.source();f.sqlite.prepare('INSERT INTO outbox_meta VALUES(?,?)').run('a','{"reference":"REF"}');
 await mockQQ(()=>Response.json({code},{status:400}),async sends=>{await sendOutbox(metered(f.e));assert.equal(f.row().status,status);assert.equal(sends.length,1);if(name==='muted'){assert.ok(Number(f.sqlite.prepare("SELECT value FROM settings WHERE key='qq:muted_until'").get().value)>Date.now());f.out('b');await sendOutbox(metered(f.e));assert.equal(sends.length,1);}});
});
test('M1-S passive expiry exhausts that ledger entry, borrows once and succeeds',async()=>{
 const f=sendFixture();f.out();f.source();f.source('other',0,Date.now()+1);
 await mockQQ((_b,n)=>n===1?Response.json({code:40034128},{status:400}):ok(),async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,2);assert.equal(sends[1].msg_id,'other');assert.equal(f.row().status,'sent');assert.equal(f.sqlite.prepare("SELECT used FROM passive_claims WHERE msg_id='src'").get().used,5);});
});
test('M1-S a second passive-expiry result fails instead of borrowing indefinitely',async()=>{
 const f=sendFixture();f.out();f.source();f.source('other',0,Date.now()+1);
 await mockQQ(()=>Response.json({code:40034128},{status:400}),async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,2);assert.equal(f.row().status,'failed');});
});
test('M1-S all-reference-failure budget 48 processes two distinct rows without exceeding the cap',async()=>{
 const f=sendFixture();f.source();for(let i=0;i<4;i++){f.out('a'+i);f.sqlite.prepare('INSERT INTO outbox_meta VALUES(?,?)').run('a'+i,'{"reference":"REF"}');}
 await mockQQ(()=>Response.json({code:123},{status:400}),async sends=>{const e=metered(f.e);await sendOutbox(e);assert.equal(f.sqlite.prepare('SELECT COUNT(*) n FROM outbox_send').get().n,2);assert.ok(e.meter.used<=46);assert.equal(f.e.WORK.sent.length,1);});
});

for(const point of ['no_sequence','before_fetch','after_fetch'])test(`M1-S committed claim interrupted at ${point} is recovered without duplicate HTTP`,async()=>{
 const f=sendFixture();f.out();if(point==='no_sequence')f.setting('qq:active_rejected','1');else f.source();
 const originalBatch=f.e.DB.batch.bind(f.e.DB),clock=Date.now;
 f.e.DB.batch=async statements=>{
  if(statements.length===7){const rows=await originalBatch(statements);if(point==='before_fetch')throw Error('crash before fetch');return rows;}
  throw Error('crash before receipt');
 };
 try{
  await mockQQ(ok,async sends=>{
   await assert.rejects(()=>sendOutbox(metered(f.e)),/crash/);
   assert.equal(f.row().status,'sending');assert.equal(sends.length,point==='after_fetch'?1:0);
   const advanced=clock()+121000;Date.now=()=>advanced;f.e.DB.batch=originalBatch;
   await f.e.DB.prepare(recoverSendingSQL).bind(advanced-120000).run();
   assert.equal(f.row().status,point==='no_sequence'?'retry':'unknown');
   if(point==='no_sequence')f.source('src',0,advanced);
   await sendOutbox(metered(f.e));assert.equal(sends.length,point==='before_fetch'?0:1);
   assert.equal(f.row().status,point==='no_sequence'?'sent':'unknown');
  });
 }finally{Date.now=clock;f.e.DB.batch=originalBatch;}
});
test('M1-S recovering an unissued root releases its held tail on the following invocation',async()=>{
 const f=sendFixture();f.out();f.out('a~1','held');f.setting('qq:active_rejected','1');
 const originalBatch=f.e.DB.batch.bind(f.e.DB),clock=Date.now;
 f.e.DB.batch=statements=>statements.length===7?originalBatch(statements):Promise.reject(Error('receipt crash'));
 try{
  await mockQQ(ok,async sends=>{
   await assert.rejects(()=>sendOutbox(metered(f.e)),/receipt crash/);assert.equal(sends.length,0);
   const advanced=clock()+121000;Date.now=()=>advanced;f.e.DB.batch=originalBatch;
   await f.e.DB.prepare(recoverSendingSQL).bind(advanced-120000).run();f.source('src',0,advanced);
   await sendOutbox(metered(f.e));assert.equal(f.row().status,'sent');assert.equal(f.row('a~1').status,'held');assert.equal(sends.length,1);
   await sendOutbox(metered(f.e));assert.equal(f.row('a~1').status,'sent');assert.equal(sends.length,2);assert.deepEqual(sends.map(x=>x.msg_seq),[1,2]);
  });
 }finally{Date.now=clock;f.e.DB.batch=originalBatch;}
});
test('M1-S two live callers share the same lane while an HTTP request is in flight',async()=>{
 const f=sendFixture();f.out('a');f.out('b');f.source();let release,started;const wait=new Promise(resolve=>{release=resolve;}),inFlight=new Promise(resolve=>{started=resolve;});
 await mockQQ(async(_body,n)=>{assert.ok(f.sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE status='sending'").get().n<=1);if(n===1){started();await wait;}return ok();},async sends=>{
  const first=sendOutbox(metered(f.e));await inFlight;
  const second=metered(f.e);await sendOutbox(second);assert.equal(second.meter.used,10);assert.equal(sends.length,1);assert.equal(f.e.WORK.sent.length,0);
  release();await first;assert.equal(sends.length,2);assert.equal(f.row('a').status,'sent');assert.equal(f.row('b').status,'sent');assert.equal(f.sqlite.prepare('SELECT used FROM passive_claims').get().used,2);
 });
});

test('M1-S a dedicated send wake skips processJob and retains a full invocation budget',async()=>{
 const f=sendFixture();f.out();f.source();const prepare=f.e.DB.prepare.bind(f.e.DB),sql=[];
 f.e.DB.prepare=query=>{sql.push(query);return prepare(query);};
 await mockQQ(ok,async sends=>{const e=metered(f.e);await worker.queue({messages:[{body:{send:1},ack(){}}]},e);assert.equal(sends.length,1);assert.ok(e.meter.used<=48);assert.ok(sql.every(query=>!query.includes('FROM jobs')&&!query.startsWith('UPDATE jobs')));});
});
test('M1-S event retention costs three statements and optional cleanup respects its reserve',async()=>{
 const f=sendFixture(),at=Date.now();f.source('old',0,at-3600001);f.source('new',0,at);
 f.out('old','sent','g','old','旧',at-8*86400000);f.out('new','sent','g','new','新',at);
 for(const id of ['old','new'])f.sqlite.prepare('INSERT INTO outbox_send(id) VALUES(?)').run(id);
 f.sqlite.prepare("INSERT INTO message_refs VALUES(?,'bot',?,?,?)").run('old-ref','old','g',at-31*86400000);f.sqlite.prepare("INSERT INTO message_refs VALUES(?,'bot',?,?,?)").run('new-ref','new','g',at);
 const low=metered(f.e);low.meter.used=30;await optionalCron(low,()=>pruneEventLayer(low),3);assert.equal(low.meter.used,30);
 const e=metered(f.e);await pruneEventLayer(e);assert.equal(e.meter.used,3);assert.deepEqual(f.sqlite.prepare('SELECT msg_id FROM passive_claims').all().map(x=>x.msg_id),['new']);assert.deepEqual(f.sqlite.prepare('SELECT id FROM outbox_send').all().map(x=>x.id),['new']);assert.deepEqual(f.sqlite.prepare('SELECT ref_idx FROM message_refs').all().map(x=>x.ref_idx),['new-ref']);
});

for(const [name,http,code,reason] of [['429',429,9,'rate_limited'],['passive expiry',400,40034128,'passive_invalid']])test(`M1-S ${name} uses ledger attempt metadata instead of a stale ready-row snapshot`,async()=>{
 const f=sendFixture();f.out('a','retry');f.source();f.sqlite.prepare('INSERT INTO outbox_send(id) VALUES(?)').run('a');
 const prepare=f.e.DB.prepare.bind(f.e.DB);
 f.e.DB.prepare=sql=>{
  const statement=prepare(sql);if(!sql.startsWith('SELECT o.*,om.json AS meta'))return statement;
  const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),all=bound.all.bind(bound);bound.all=async()=>{const snapshot=await all();f.sqlite.prepare('UPDATE outbox_send SET tries=2,reason=?').run(reason);return snapshot;};return bound;};return statement;
 };
 await mockQQ(()=>Response.json({code},{status:http}),async sends=>{await sendOutbox(metered(f.e));assert.equal(sends.length,1);assert.equal(f.row().tries,3);assert.equal(f.row().status,'failed');});
});

test('M1-S a held segment is delivered by the existing cron fallback after its root succeeds',async()=>{
 const f=sendFixture();f.source();f.out();f.out('a~1','held');f.setting('last_message',new Date().toISOString());
 await mockQQ(ok,async sends=>{
  await sendOutbox(metered(f.e));assert.equal(sends.length,1);assert.equal(f.row('a~1').status,'held');
  let pending;const e=metered(f.e);await worker.scheduled({},e,{waitUntil(p){pending=p;}});await pending;
  assert.ok(e.meter.used<=48);assert.equal(f.row('a~1').status,'sent');assert.equal(sends.length,2);
 });
});
