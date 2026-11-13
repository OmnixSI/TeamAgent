import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';

const outfile=`.wrangler/send-state-unit-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/send/lane";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const {claimStatements,releaseStatement,recoverSendingSQL,resultStatements,readyRowsSQL}=await import('../'+outfile);
const now=Date.now();
function fixture(){
  const d=new DatabaseSync(':memory:');d.exec(readFileSync('schema.sql','utf8'));
  const db={prepare(sql){const make=(args=[])=>({sql,args,bind(...values){return make(values);}});return make();}};
  const e={DB:db};
  function batch(ss,failAfter=0){
    d.exec('BEGIN');try{const rows=ss.map((s,i)=>{const p=d.prepare(s.sql),r=p.columns().length?{results:p.all(...s.args)}:{results:[],meta:p.run(...s.args)};if(i+1===failAfter)throw Error('injected interruption');return r;});d.exec('COMMIT');return rows;}catch(error){d.exec('ROLLBACK');throw error;}
  }
  const out=(id='a',status='pending',group='g')=>d.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run(id,group,'src','测试',status,now);
  const source=(id='src',used=0,at=now)=>d.prepare('INSERT INTO passive_claims VALUES(?,?,?,?)').run(id,'g',at,used);
  const claim=(id='a',tok='A',time=now,extra={})=>claimStatements(e,{id,group_id:'g',msg_id:'src'},{tok,now:time,borrow:true,activeSeq:91,unknownResend:false,...extra});
  return {d,e,batch,out,source,claim};
}
test('M1-S schema and registered migration can both be replayed',()=>{
  const d=new DatabaseSync(':memory:');
  for(let i=0;i<2;i++){d.exec(readFileSync('schema.sql','utf8'));d.exec(readFileSync('migrations/0005_event_layer.sql','utf8'));}
  for(const table of ['passive_claims','outbox_send','send_lanes'])assert.ok(d.prepare('SELECT name FROM sqlite_master WHERE name=?').get(table));
  assert.match(readFileSync('scripts/migrate.mjs','utf8'),/migrations\/0005_event_layer.sql/);
});
test('M1-S the seven statements claim one stable passive pair, including batch replay',()=>{
  const f=fixture();f.out();f.source();const ss=f.claim();assert.equal(ss.length,7);
  let rows=f.batch(ss);assert.equal(rows[2].results.length,1);assert.deepEqual({...rows[6].results[0]},{passive_msg_id:'src',msg_seq:1,tries:0,reason:null});
  f.batch(ss);assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,1);
  assert.equal(f.d.prepare('SELECT status FROM outbox').get().status,'sending');
});
for(let k=1;k<=6;k++)test(`M1-S atomic interruption after statement ${k} rolls back lease, stamp and quota`,()=>{
  const f=fixture();f.out();f.source();assert.throws(()=>f.batch(f.claim(),k),/injected/);
  assert.equal(f.d.prepare('SELECT status FROM outbox').get().status,'pending');
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM outbox_send').get().n,0);
  assert.equal(f.d.prepare('SELECT COUNT(*) n FROM send_lanes').get().n,0);
  assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,0);
  assert.equal(f.batch(f.claim())[6].results[0].msg_seq,1);
});
test('M1-S another token cannot spend passive quota or stamp while the lane is held',()=>{
  const f=fixture();f.out('a');f.out('b');f.source();f.batch(f.claim('a','A'));
  const rows=f.batch(f.claim('b','B'));assert.equal(rows[2].results.length,0);assert.equal(rows[6].results.length,0);
  assert.equal(f.d.prepare("SELECT COUNT(*) n FROM outbox_send WHERE id='b'").get().n,0);
  f.batch([releaseStatement(f.e,'g','B')]);assert.equal(f.d.prepare('SELECT holder FROM send_lanes').get().holder,'A');
  assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,1);
});
test('M1-S an expired lease cannot bypass an existing sending row, and the new lease is released',()=>{
  const f=fixture();f.out('a');f.out('b');f.source();f.batch(f.claim('a','A'));
  assert.equal(f.batch(f.claim('b','B',now+91000))[2].results.length,0);
  f.batch([releaseStatement(f.e,'g','B')]);assert.equal(f.d.prepare('SELECT lease_until FROM send_lanes').get().lease_until,0);
  assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,1);
});
test('M1-S legacy sending rows block v2 before quota is consumed',()=>{
  const f=fixture();f.out('legacy','sending');f.out('b');f.source();
  assert.equal(f.batch(f.claim('b'))[2].results.length,0);
  assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,0);
});
test('M1-S held tails require a sent predecessor inside the atomic batch',()=>{
  const f=fixture();f.out();f.out('a~1','held');f.source();
  assert.equal(f.batch(f.claim('a~1'))[2].results.length,0);
  f.d.prepare("UPDATE outbox SET status='sent' WHERE id='a'").run();
  assert.equal(f.batch(f.claim('a~1','A',now+1))[2].results.length,1);
});
test('M1-S the sixth claim borrows the newest eligible message; disabled borrowing uses active fallback',()=>{
  for(const borrow of [true,false]){
    const f=fixture();f.out();f.source('src',5);f.source('newer',0,now+1);
    const row=f.batch(f.claim('a','A',now,{borrow}))[6].results[0];
    assert.deepEqual({...row},borrow?{passive_msg_id:'newer',msg_seq:1,tries:0,reason:null}:{passive_msg_id:null,msg_seq:91,tries:0,reason:null});
  }
});
test('M1-S rejected active sends with no quota retain a stamp without a sequence',()=>{
  const f=fixture();f.out();f.source('src',5);
  assert.equal(f.batch(f.claim('a','A',now,{activeSeq:null}))[6].results[0].msg_seq,null);
});
test('M1-S recovery distinguishes unissued v2, ambiguous v2 and legacy attempts',()=>{
  const f=fixture();for(const id of ['unissued','issued','legacy'])f.out(id,'sending');
  f.d.prepare('INSERT INTO outbox_send(id,lock_tok,claimed_at,msg_seq) VALUES(?,?,?,?)').run('unissued','A',now-121000,null);
  f.d.prepare('INSERT INTO outbox_send(id,lock_tok,claimed_at,msg_seq) VALUES(?,?,?,?)').run('issued','B',now-121000,1);
  f.d.prepare('INSERT INTO outbox_attempts(id,started_at) VALUES(?,?)').run('legacy',now-121000);
  f.d.prepare(recoverSendingSQL).run(now-120000);
  assert.deepEqual(f.d.prepare('SELECT id,status FROM outbox ORDER BY id').all().map(x=>({...x})),[{id:'issued',status:'unknown'},{id:'legacy',status:'unknown'},{id:'unissued',status:'retry'}]);
});

const success={status:'sent',reason:null,http:200,code:'0',notBefore:0,reference:true,refIdx:'new-ref'};
for(const order of [['Ac','Bc','Ar','Br'],['Ac','Ar','Bc','Br'],['Ac','Bc','Br','Ar'],['Bc','Ac','Br','Ar'],['Bc','Br','Ac','Ar'],['Bc','Ac','Ar','Br']])test('M1-S transaction interleaving '+order.join(' → '),()=>{
 const f=fixture();f.out('a');f.out('b');f.source();const locked={A:false,B:false};
 for(const op of order){const tok=op[0],id=tok==='A'?'a':'b';if(op[1]==='c'){const rows=f.batch(f.claim(id,tok));locked[tok]=!!rows[2].results.length;if(!locked[tok])f.batch([releaseStatement(f.e,'g',tok)]);}else if(locked[tok])f.batch(resultStatements(f.e,{id,group_id:'g'},{tok,now},{...success,refIdx:'ref-'+tok}));
 assert.ok(f.d.prepare("SELECT COUNT(*) n FROM outbox WHERE group_id='g' AND status='sending'").get().n<=1);
 }
 assert.equal(f.d.prepare('SELECT used FROM passive_claims').get().used,Number(locked.A)+Number(locked.B));
});
test('M1-S a late response cannot alter a reclaimed row, counters, attempts, refs or lane',()=>{
 const f=fixture();f.out();f.source();f.batch(f.claim('a','A'));
 f.d.prepare("UPDATE outbox SET status='unknown'").run();f.batch(f.claim('a','B',now+121000,{unknownResend:true}));
 const before=f.d.prepare('SELECT * FROM outbox_send').get();f.batch(resultStatements(f.e,{id:'a',group_id:'g'},{tok:'A',now},success));
 assert.equal(f.d.prepare('SELECT status FROM outbox').get().status,'sending');assert.deepEqual(f.d.prepare('SELECT * FROM outbox_send').get(),before);
 assert.equal(f.d.prepare('SELECT COUNT(*) n FROM outbox_attempts').get().n,0);assert.equal(f.d.prepare('SELECT COUNT(*) n FROM message_refs').get().n,0);assert.equal(f.d.prepare("SELECT COUNT(*) n FROM settings WHERE key='quote_fail'").get().n,0);assert.equal(f.d.prepare('SELECT holder FROM send_lanes').get().holder,'B');assert.ok(f.d.prepare('SELECT lease_until FROM send_lanes').get().lease_until>0);
});
test('M1-S a late real receipt may correct the same fenced claim after recovery to unknown',()=>{
 const f=fixture();f.out();f.source();f.batch(f.claim('a','A'));f.d.prepare("UPDATE outbox SET status='unknown'").run();
 f.batch(resultStatements(f.e,{id:'a',group_id:'g'},{tok:'A',now},success));assert.equal(f.d.prepare('SELECT status FROM outbox').get().status,'sent');
});
test('M1-S stamp rechecks unknown resend eligibility after another caller exhausted its retry',()=>{
 const f=fixture();f.out('a','unknown');f.source();f.d.prepare('INSERT INTO outbox_send(id,msg_seq,tries,not_before) VALUES(?,1,1,0)').run('a');
 assert.equal(f.d.prepare(readyRowsSQL(true)).all(now).length,1);
 f.d.prepare('UPDATE outbox_send SET tries=2').run();
 assert.equal(f.batch(f.claim('a','stale',now,{unknownResend:true}))[2].results.length,0);
});
test('M1-S stamp rechecks a 429 deadline after an earlier ready-row read became stale',()=>{
 const f=fixture();f.out('a','retry');f.source();f.d.prepare('INSERT INTO outbox_send(id,msg_seq,tries,not_before) VALUES(?,1,1,0)').run('a');
 assert.equal(f.d.prepare(readyRowsSQL(false)).all(now).length,1);
 f.d.prepare('UPDATE outbox_send SET not_before=?').run(now+30000);
 assert.equal(f.batch(f.claim('a','stale'))[2].results.length,0);
});

test('M1-S the real local D1 runtime executes the exact seven statements and rolls back failed batches',async()=>{
 const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("synthetic");}}',compatibilityDate:'2026-11-12',d1Databases:{DB:'event-v2-send-test'},port:0}));
 try{
  const DB=await mf.getD1Database('DB'),e={DB};
  const schema=readFileSync('schema.sql','utf8').split(';').filter(sql=>/CREATE TABLE IF NOT EXISTS (?:outbox|outbox_send|passive_claims|send_lanes|settings|message_refs|outbox_attempts)\b/.test(sql));
  await DB.batch(schema.map(sql=>DB.prepare(sql)));
  await DB.batch([DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('a','g','src','合成消息','pending',now),DB.prepare('INSERT INTO passive_claims VALUES(?,?,?,0)').bind('src','g',now)]);
  const claim={tok:'local-d1',now,borrow:true,activeSeq:123,unknownResend:false},row={id:'a',group_id:'g',msg_id:'src'};
  const ss=claimStatements(e,row,claim);assert.equal(ss.length,7);const result=await DB.batch(ss);assert.equal(result[2].results.length,1);assert.equal(result[6].results[0].msg_seq,1);assert.equal((await DB.prepare('SELECT used FROM passive_claims').first()).used,1);
  await DB.batch(ss);assert.equal((await DB.prepare('SELECT used FROM passive_claims').first()).used,1);
  await assert.rejects(()=>DB.batch([DB.prepare("INSERT INTO settings VALUES('rollback-proof','yes')"),DB.prepare('INSERT INTO _missing_synthetic_table_ VALUES(1)')]));assert.equal(await DB.prepare("SELECT value FROM settings WHERE key='rollback-proof'").first(),null);
  const receipt=resultStatements(e,row,claim,{...success,refIdx:'local-ref'});assert.ok(receipt.length<=6);await DB.batch(receipt);assert.equal((await DB.prepare("SELECT status FROM outbox WHERE id='a'").first()).status,'sent');
 }finally{await mf.dispose();}
});
