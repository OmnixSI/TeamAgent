import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,readdirSync} from 'node:fs';
import {sendFixture,mockQQ} from './send-sql-support.mjs';

const outfile=`.wrangler/send-pipeline-fixtures-${process.pid}.mjs`;
const config=JSON.parse(readFileSync('config/team.json','utf8'));
config.stickers={...config.stickers,send:true};
await build({stdin:{contents:'export {sendOutbox} from "./src/worker";export {metered,COST} from "./src/d1";export * from "./src/send/enqueue";export {recoverSendingSQL} from "./src/send/lane";export {quoteRef} from "./src/quote";export {unansweredProactive,RHYTHM} from "./src/rhythm";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile,
 plugins:[{name:'sticker-send-fixture',setup(builder){builder.onLoad({filter:/config\/team\.json$/},()=>({contents:JSON.stringify(config),loader:'json'}));}}]});
const api=await import('../'+outfile);
const legacyOut=`.wrangler/send-pipeline-legacy-${process.pid}.mjs`;
await build({entryPoints:['test/legacy/send-68ef1c3.mjs'],bundle:true,platform:'browser',format:'esm',outfile:legacyOut});
const legacy=await import('../'+legacyOut);

const dir='test/fixtures/qq-send';
const files=readdirSync(dir).filter(name=>name.endsWith('.json')).sort();
const fixtures=files.flatMap(name=>{
 const value=JSON.parse(readFileSync(dir+'/'+name,'utf8'));
 return (Array.isArray(value)?value:[value]).map(item=>({file:name,item}));
});
const byGroup=Object.fromEntries([...new Set(fixtures.map(f=>f.item.group))].sort().map(g=>[g,fixtures.filter(f=>f.item.group===g).length]));

const ok=()=>Response.json({id:'sent',ext_info:{ref_idx:'REFIDX_SYNTH_0001'}});
const responseOf=r=>Response.json(r.body??{},r.status?{status:r.status}:undefined);
const setting=(f,key,value)=>f.sqlite.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(key,String(value));
const count=(f,sql,...args)=>f.sqlite.prepare(sql).get(...args)?.n;

function seed(f,setup={}){
 for(const o of setup.outbox||[])f.out(o.id,o.status,o.group||'g',o.msg_id??'src',o.body||'测试文本',o.created_at??Date.now());
 for(const s of setup.passive||[])f.source(s.msg_id,s.used??0,s.at??Date.now(),s.group||'g');
 for(const m of setup.meta||[])f.sqlite.prepare('INSERT OR REPLACE INTO outbox_meta VALUES(?,?)').run(m.id,JSON.stringify(m.json));
 for(const s of setup.outbox_send||[])f.sqlite.prepare('INSERT INTO outbox_send(id,passive_msg_id,msg_seq,not_before,tries,reason,lock_tok,claimed_at) VALUES(?,?,?,?,?,?,?,?)').run(s.id,s.passive_msg_id??null,s.msg_seq??null,s.not_before??0,s.tries??1,s.reason??null,s.lock_tok??null,s.claimed_at??null);
 for(const [key,value] of Object.entries(setup.settings||{}))setting(f,key,value);
 for(const s of setup.sql||[])f.sqlite.exec(s);
 return f;
}

async function receipt(item){
 const f=seed(sendFixture(),item.setup),responses=item.responses||[],sent=[];
 await mockQQ((body,n)=>{sent.push([body.msg_id,body.msg_seq]);return responses.length?responseOf(responses[Math.min(n-1,responses.length-1)]):ok();},async()=>{
  for(let call=0;call<(item.calls??responses.length??1);call++){
   if(call)f.sqlite.prepare('UPDATE outbox_send SET not_before=0').run();
   await api.sendOutbox(api.metered(f.e));
  }
 });
 const row=f.row(item.setup.outbox[0].id);
 assert.equal(row.status,item.expect.status,item.id+' status');
 if(item.expect.reason!==undefined)assert.equal(row.reason,item.expect.reason,item.id+' reason');
 assert.equal(sent.length,item.expect.sends??1,item.id+' sends');
 if(item.expect.pairs)assert.deepEqual(sent,item.expect.pairs,item.id+' pairs');
 if(item.expect.passiveUsed!==undefined){
  const used=f.sqlite.prepare('SELECT used FROM passive_claims WHERE msg_id=?').get(item.expect.passiveUsedOf||'src')?.used;
  assert.equal(used,item.expect.passiveUsed,item.id+' passive used');
 }
 if(item.expect.quoteFail!==undefined){
  const value=f.sqlite.prepare("SELECT value FROM settings WHERE key='quote_fail'").get()?.value??'0';
  assert.equal(Number(value),item.expect.quoteFail,item.id+' quote_fail');
 }
 if(item.expect.muted){
  const value=Number(f.sqlite.prepare("SELECT value FROM settings WHERE key='qq:muted_until'").get()?.value||0);
  assert.ok(value>Date.now(),item.id+' muted_until');
 }
 if(item.expect.afterMutedCalls){
  const before=sent.length;
  await mockQQ(ok,async()=>api.sendOutbox(api.metered(f.e)));
  assert.equal(sent.length,before,item.id+' muted入口直接返回');
 }
}

async function pairs(item){
 const f=seed(sendFixture(),item.setup),bodies=[],responses=item.responses||[];
 await mockQQ((body,n)=>{bodies.push([body.msg_id,body.msg_seq]);return responses.length?responseOf(responses[Math.min(n-1,responses.length-1)]):ok();},async()=>{
  for(let call=0;call<(item.calls??6);call++){
   if(call)f.sqlite.prepare('UPDATE outbox_send SET not_before=0').run();
   const before=bodies.length;
   await api.sendOutbox(api.metered(f.e));
   if(item.stopWhenSettled&&f.sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE status IN ('pending','retry')").get().n===0)break;
   if(call&&bodies.length===before)break;
  }
 });
 assert.deepEqual(bodies.map(([id])=>id),item.expect.msgIds,item.id+' msg ids');
 if(item.expect.seqs)assert.deepEqual(bodies.map(([,seq])=>seq),item.expect.seqs,item.id+' seqs');
 if(item.expect.stable)assert.equal(new Set(bodies.map(x=>x.join(':'))).size,1,item.id+' stable pair');
}

async function enqueue(item){
 const f=sendFixture();
 await api.enqueueText(f.e,item.enqueue);
 const rows=f.sqlite.prepare('SELECT id,status,length(body) len,body FROM outbox ORDER BY id').all();
 assert.deepEqual(rows.map(r=>r.id),item.expect.parts.map(p=>p.id),item.id+' part ids');
 assert.deepEqual(rows.map(r=>r.status),item.expect.parts.map(p=>p.status),item.id+' part status');
 for(const [i,p] of item.expect.parts.entries()){
  assert.ok(rows[i].len<=1800,item.id+' part length');
  if(p.max!==undefined)assert.ok(rows[i].len<=p.max,item.id+' declared max');
  if(p.endsWith)assert.ok(rows[i].body.endsWith(p.endsWith),item.id+' suffix');
  if(p.startsWith)assert.ok(rows[i].body.startsWith(p.startsWith),item.id+' prefix');
  if(p.fence)assert.equal((rows[i].body.match(/```/g)||[]).length,2,item.id+' fenced part');
 }
}

function quoteRefFixture(item){
 const f=seed(sendFixture(),item.setup);
 return api.quoteRef(f.e,item.decision,{latest:{id:'a',group_id:'g'},batch:[{id:'a',sender:'u1',mentioned:false}],mentioned:false,groupNewestId:'b'},item.switches||{}).then(result=>{
  assert.equal(result??null,item.expect.ref,item.id+' ref');
 });
}

async function state(item){
 const f=seed(sendFixture(),item.setup);
 await mockQQ(ok,async()=>api.sendOutbox(api.metered(f.e)));
 for(const [id,status] of Object.entries(item.expect.statuses||{}))assert.equal(f.row(id).status,status,`${item.id} ${id}`);
 if(item.expect.reason){const row=f.row(item.expect.reason.id);assert.equal(row.reason,item.expect.reason.reason,item.id+' reason');}
 if(item.expect.wakes!==undefined)assert.equal(f.e.WORK.sent.length,item.expect.wakes,item.id+' wakes');
 if(item.expect.freshSent){const row=f.row(item.expect.freshSent);assert.equal(row.status,'sent',item.id+' fresh');}
}

async function recent(item){
 const f=seed(sendFixture(),item.setup);
 const probe=async id=>{
  f.sqlite.prepare("UPDATE chat_decisions SET outbox_id=?").run(id);
  return api.unansweredProactive(f.e,'g',Date.now(),api.RHYTHM);
 };
 assert.equal(await probe(item.expect.probe.miss),false,item.id+' must not hit on older base');
 assert.equal(await probe(item.expect.probe.hit),true,item.id+' must hit on the newest visible base');
}

async function rollback(item){
 const f=seed(sendFixture(),item.setup);
 const sql=readFileSync('scripts/rollback-event-v2.sql','utf8');
 f.sqlite.exec(sql);f.sqlite.exec(sql);
 const bodies=[];
 await mockQQ(body=>{bodies.push(body.msg_id);return ok();},async()=>{
  await legacy.sendOutbox(f.e);
  await legacy.recover(f.e,Date.now()+121000);
 });
 for(const [id,status] of Object.entries(item.expect.statuses||{}))assert.equal(f.row(id).status,status,`${item.id} ${id}`);
 assert.equal(bodies.length,item.expect.sends??0,item.id+' legacy sends');
 assert.equal(count(f,"SELECT COUNT(*) n FROM outbox WHERE status IN ('retry','held')"),0,item.id+' no retry/held');
}

const runners={receipt,pairs,enqueue,quoteRef:quoteRefFixture,state,recent,rollback};

test('send fixture manifest matches the acceptance table (33 receipts/states)',()=>{
 assert.equal(fixtures.length,33);
 assert.deepEqual(byGroup,{G3:4,G12:4,G18:8,G19:5,G20:5,G24:7});
});
for(const {item} of fixtures){
 test(`${item.id} ${item.note}`,async()=>{
  assert.ok(runners[item.scenario],`unknown scenario ${item.scenario}`);
  await runners[item.scenario](item);
 });
}
