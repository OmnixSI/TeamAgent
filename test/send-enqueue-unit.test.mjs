import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker,req,qq,msg} from './support.mjs';
import {sendFixture} from './send-sql-support.mjs';
const outfile=`.wrangler/send-enqueue-unit-${process.pid}.mjs`;
await build({stdin:{contents:'export {enqueueVoice,fragments} from "./src/voice";export {understandLinks,agentAnswer} from "./src/semantic";export {observeChecks,triageCI} from "./src/ci";export {sweepVideoWaits} from "./src/fetchjobs";export {metered} from "./src/d1";export {recordDecision,unansweredProactive} from "./src/rhythm";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const api=await import('../'+outfile);
const rows=e=>e.DB.prepare('SELECT id,status,body FROM outbox ORDER BY created_at,id').all().then(x=>x.results);
const bound=async()=>{const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});return e;};
const job=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const states=rs=>rs.map(r=>r.status);

test('M1-S enqueue site 1: command acknowledgement is a stable pending root',async()=>{
 const e=await bound();await qq(e,msg('ack-v2','/方案 WhalePartner 核对发送流程'));await qq(e,msg('ack-v2','/方案 WhalePartner 核对发送流程'));
 const out=(await rows(e)).filter(r=>r.id==='ack-ack-v2');assert.equal(out.length,1);assert.equal(out[0].status,'pending');assert.match(out[0].body,/收到/);
});
test('M1-S enqueue site 2: plan completion produces one ready root on replay',async()=>{
 const e=await bound();await qq(e,msg('ready-v2','/方案 WhalePartner 核对发送流程'));
 const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'## 实施步骤\n核对方案与测试。'}}]});
 try{await job(e,'plan-qq-ready-v2-v1');await job(e,'plan-qq-ready-v2-v1');}finally{globalThis.fetch=old;}
 const out=(await rows(e)).filter(r=>r.id==='ready-qq-ready-v2');assert.equal(out.length,1);assert.equal(out[0].status,'pending');assert.match(out[0].body,/方案已整理/);
});
test('M1-S enqueue site 3: setup announcement is one idempotent pending root',async()=>{
 const e=await bound();for(let i=0;i<2;i++)assert.equal((await req(e,'/api/admin/announce',{})).status,200);
 const out=await rows(e);assert.equal(out.length,1);assert.equal(out[0].id,'setup-welcome');assert.equal(out[0].status,'pending');
});
test('M1-S enqueue site 4: voice fragments preserve exact content and hold the second segment',async()=>{
 const f=sendFixture(),raw=JSON.stringify({mode:'banter',text:'先确认实际内容。\n\n再核对发送结果。'});let id;
 for(let i=0;i<1000;i++)if(api.fragments(raw,'voice-v2-'+i).length===2){id='voice-v2-'+i;break;}assert.ok(id);
 await api.enqueueVoice(f.e,id,'g',null,raw);await api.enqueueVoice(f.e,id,'g',null,raw);
 const out=await rows(f.e);assert.deepEqual(states(out),['pending','held']);assert.deepEqual(out.map(x=>x.body),api.fragments(raw,id));assert.equal(f.e.enqueued,true);
});
test('M1-S enqueue site 5: links job splits a long answer into pending/held within 48 operations',async()=>{
 const e=await bound();await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('links-v2','GROUP000001','member','分享链接',new Date().toISOString(),0,0).run();
 await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('links-v2-job','links',JSON.stringify({message:'links-v2',urls:[]}),Date.now()).run();
 const old=globalThis.fetch;e.QQ_APP_ID=undefined;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'资料段落。'.repeat(900)}}]});
 const measured=api.metered(e),before=e.DB.executed;try{await job(measured,'links-v2-job');}finally{globalThis.fetch=old;}
 assert.equal(measured.meter.used,e.DB.executed-before);assert.ok(measured.meter.used<=48);assert.equal((await e.DB.prepare("SELECT status FROM jobs WHERE id='links-v2-job'").first()).status,'done');
 const out=await rows(e);assert.deepEqual(states(out),['pending','held','held']);assert.equal(out[0].id,'links-links-v2');assert.ok(out.every(x=>x.body.length<=1800));
});
const check=(conclusion,id=1)=>({id,name:'check',head_sha:String(id).padStart(40,'a'),conclusion,html_url:'https://github.com/OmnixSI/TeamAgent/actions/runs/'+id,evidence:{}});
async function incident(f){f.setting('group_id','g');f.setting('ci_notifications_v2','1');await api.observeChecks(f.e,'OmnixSI/TeamAgent',[check('failure')],{},'g',async()=>{});return f.sqlite.prepare('SELECT * FROM ci_incidents').get();}
test('M1-S enqueue site 6: recovered CI preserves its all-observations-success guard and cycle',async()=>{
 const f=sendFixture(),i=await incident(f);await api.triageCI(f.e,{incident_key:i.id,cycle:i.cycle},{});
 const original=f.e.DB.batch.bind(f.e.DB);f.e.DB.batch=ss=>{if(ss.some(x=>x.sql.startsWith('INSERT OR IGNORE INTO outbox')))f.sqlite.prepare("UPDATE ci_observations SET conclusion='failure'").run();return original(ss);};
 await api.observeChecks(f.e,'OmnixSI/TeamAgent',[check('success',2)],{},'g',async()=>{});assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM outbox WHERE id LIKE 'ci2-recovered-%'").get().n,0);
 f.e.DB.batch=original;for(let n=0;n<2;n++)await api.observeChecks(f.e,'OmnixSI/TeamAgent',[check('success',2)],{},'g',async()=>{});
 const out=f.sqlite.prepare("SELECT * FROM outbox WHERE id LIKE 'ci2-recovered-%'").all();assert.equal(out.length,1);assert.equal(out[0].status,'pending');assert.equal(f.sqlite.prepare('SELECT state FROM ci_incidents').get().state,'resolved');
});
test('M1-S enqueue site 7: CI triage cannot publish for a changed cycle, and valid replay is idempotent',async()=>{
 const f=sendFixture(),i=await incident(f),original=f.e.DB.batch.bind(f.e.DB);
 f.e.DB.batch=ss=>{f.sqlite.prepare('UPDATE ci_incidents SET cycle=2').run();return original(ss);};
 await api.triageCI(f.e,{incident_key:i.id,cycle:1},{});assert.equal((await rows(f.e)).length,0);
 f.e.DB.batch=original;for(let n=0;n<2;n++)await api.triageCI(f.e,{incident_key:i.id,cycle:2},{});
 const out=await rows(f.e);assert.equal(out.length,1);assert.equal(out[0].id,'ci2-'+i.id+'-c2');assert.equal(out[0].status,'pending');assert.equal(f.sqlite.prepare('SELECT notified_cycle FROM ci_incidents').get().notified_cycle,2);
});
test('M1-S enqueue site 8: video failure and its terminal state share the original lease guard',async()=>{
 const f=sendFixture();f.sqlite.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,status,lease_until,created_at,attempts) VALUES(?,?,?,?,?,0,0,?,0,?,3)').run('wait-v2','g','BV-test','src','["src"]','running',Date.now());
 const original=f.e.DB.batch.bind(f.e.DB);f.e.DB.batch=ss=>{f.sqlite.prepare('UPDATE video_waits SET lease_until=?').run(Date.now()+90000);return original(ss);};
 await api.sweepVideoWaits(f.e);assert.equal((await rows(f.e)).length,0);assert.equal(f.sqlite.prepare('SELECT status FROM video_waits').get().status,'running');
 f.e.DB.batch=original;f.sqlite.prepare('UPDATE video_waits SET lease_until=0').run();for(let n=0;n<2;n++)await api.sweepVideoWaits(f.e);
 const out=await rows(f.e);assert.equal(out.length,1);assert.equal(out[0].id,'video-wait-v2');assert.equal(out[0].status,'pending');assert.equal(f.sqlite.prepare('SELECT status FROM video_waits').get().status,'failed');
});

test('M1-S recentBot reads only this group including retry/held/sending and excludes sticker rows',async()=>{
 const e=env(),latest={id:'view-v2',group_id:'g',sender:'member',body:'说说近况',ts:new Date().toISOString(),mentioned:0,meta:{direct:true}};
 await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind(latest.id,'g','member',latest.body,latest.ts,0,0).run();
 for(const [id,status,group] of [['sent','sent','g'],['pending','pending','g'],['sending','sending','g'],['retry','retry','g'],['held','held','g'],['sticker~s','sent','g'],['other','sent','other'],['unknown','unknown','g']])await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind(id,group,latest.id,id,status,Date.now()).run();
 const original=e.DB.prepare.bind(e.DB);let seen;
 e.DB.prepare=sql=>{const statement=original(sql);if(!sql.startsWith('SELECT id,body,created_at,msg_id FROM outbox'))return statement;const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args),all=bound.all.bind(bound);bound.all=async()=>{const result=await all();seen=result.results.map(x=>x.id);return result;};return bound;};return statement;};
 const fetch=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"action":"stop","reason":"无需重复发言"}'}}]});
 try{await api.agentAnswer(e,{latest,batch:[latest],recent:[latest],names:new Map(),refs:new Map(),mentioned:false});}finally{globalThis.fetch=fetch;}
 assert.deepEqual(seen.sort(),['held','pending','retry','sending','sent']);
});
for(const status of ['sent','pending','sending','retry','held'])test(`M1-S lastout includes ${status} but ignores newer sticker, unknown and other-group rows`,async()=>{
 const f=sendFixture();f.source();
 await api.recordDecision(f.e,{id:'decision',group_id:'g',latest_id:'src',batch_ids:['src'],gate:'model',action:'reply',spoken_kind:'proactive',outbox_id:'o',created_at:Date.now()});
 f.out('o',status,'g','src','回复',Date.now());f.out('o~s','sent','g','src','表情',Date.now()+1);f.out('other','sent','other','src','别群',Date.now()+2);f.out('unknown','unknown','g','src','未知',Date.now()+3);
 const before=f.e.DB.executed;assert.equal(await api.unansweredProactive(f.e,'g'),true);assert.equal(f.e.DB.executed-before,1);
});

test('M1-S long work voice uses the shared splitter before passing explicit fragments to enqueue',async()=>{
 const f=sendFixture(),raw=JSON.stringify({mode:'work',text:'核对实际代码与测试。'.repeat(700)}),parts=api.fragments(raw,'work-long-v2');
 assert.equal(parts.length,3);assert.ok(parts.every(x=>x.length<=1800));assert.match(parts[2],/已截断/);
 await api.enqueueVoice(f.e,'work-long-v2','g',null,raw);const out=await rows(f.e);assert.deepEqual(states(out),['pending','held','held']);assert.deepEqual(out.map(x=>x.body),parts);
});
