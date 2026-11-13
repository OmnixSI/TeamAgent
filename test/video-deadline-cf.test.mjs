import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { worker, env, req, qq, msg } from './support.mjs';
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/fetchjobs-deadline-cf-${process.pid}.mjs`});
const f = await import(`../.wrangler/fetchjobs-deadline-cf-${process.pid}.mjs`);
const BV='BV1xx411c7mD', group='GROUP000001';
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);
const cron=async(e,c)=>{const tasks=[];await worker.scheduled({cron:c},e,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);};
async function setup(){const e=env();await req(e,'/api/admin/bind',{groupId:group});return e;}
async function first(e,id='question'){await qq(e,msg(id,'视频讲了啥 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');await queue(e,'chat-'+id);return (await rows(e,'video_waits')).find(w=>w.latest_id===id);}
async function deliver(e,waitId){await e.DB.prepare("UPDATE jobs SET payload=json_set(payload,'$.notBefore',0) WHERE id=?").bind('vdl-'+waitId).run();await queue(e,'vdl-'+waitId);}

test('CF3-1 a deadline beyond twenty-four hours stays with the cron sweep',async()=>{
  const e=env(),start=Date.now();
  await f.scheduleVideoDeadline(e,'vw-far',start+25*3600*1000);
  assert.equal(e.WORK.sent.length,0,'no delayed message beyond the platform limit');
  assert.equal((await rows(e,'jobs')).length,0,'no unusable deadline row');
});

test('CF3-1b a due or past deadline is clamped to one second',async()=>{
  const e=env();
  await f.scheduleVideoDeadline(e,'vw-past',Date.now()-5000);
  assert.equal(e.WORK.sent.length,1);
  assert.equal(e.WORK.sent[0].opts.delaySeconds,1);
});

test('CF3-2 a repeated deadline delivery wakes exactly once',async()=>{
  const e=await setup(),w=await first(e);
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();
  await deliver(e,w.id);
  const once=(await rows(e,'jobs')).filter(j=>j.kind==='video_reply');
  assert.equal(once.length,1,'one reply job');
  const deadline=JSON.stringify((await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id));
  await queue(e,'vdl-'+w.id);
  const after=await rows(e,'jobs');
  assert.equal(after.filter(j=>j.kind==='video_reply').length,1,'no duplicate wake on redelivery');
  assert.equal(JSON.stringify(after.find(j=>j.id==='vdl-'+w.id)),deadline,'deadline stays done');
  assert.equal((await rows(e,'outbox')).length,0,'no extra reply');
});

test('CF3-2b the same wait is not enqueued twice',async()=>{
  const e=env();
  const x={groupId:group,ref:BV,latest:{id:'same'},batchIds:['same'],mentioned:true};
  assert.equal(await f.startVideoWait(e,x),true);
  assert.equal(e.WORK.sent.filter(s=>String(s.body.id).startsWith('vdl-')).length,1);
  assert.equal(await f.startVideoWait(e,{...x,batchIds:['same','later']}),true,'existing wait is authoritative');
  assert.equal(e.WORK.sent.filter(s=>String(s.body.id).startsWith('vdl-')).length,1,'no second delayed message');
  await f.scheduleVideoDeadline(e,'vw-same',Date.now()+30000);
  assert.equal(e.WORK.sent.filter(s=>String(s.body.id).startsWith('vdl-')).length,1,'an existing deadline row is not re-sent');
});

test('CF3-3 the daily cap stops delayed sends and leaves the cron fallback',async()=>{
  const e=env(),start=Date.now();
  await f.scheduleVideoDeadline(e,'vw-capped-1',start+30000);
  assert.equal(e.WORK.sent.length,1);
  const key=(await rows(e,'settings')).find(r=>r.key.startsWith('budget:video_deadline_queue:')).key;
  await e.DB.prepare('UPDATE settings SET value=? WHERE key=?').bind('5000',key).run();
  await f.scheduleVideoDeadline(e,'vw-capped-2',start+30000);
  assert.equal(e.WORK.sent.length,1,'over cap: no delayed message');
  assert.ok((await rows(e,'jobs')).find(j=>j.id==='vdl-vw-capped-2'),'deadline row remains for cron');
});

test('CF3-4 a lost deadline message is recovered by the five-minute video cron',async()=>{
  const e=await setup(),w=await first(e);
  e.WORK.sent=e.WORK.sent.filter(s=>s.body.id!=='vdl-'+w.id);
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();
  await cron(e,'*/5 * * * *');
  assert.ok((await rows(e,'jobs')).some(j=>j.id==='video-'+w.id),'video cron wakes the waiting video');
  assert.ok(e.WORK.sent.some(s=>s.body.id==='video-'+w.id),'reply is queued');
});

test('CF3-4b the video cron never wakes a finished or skipped wait',async()=>{
  const e=await setup(),w=await first(e);
  await e.DB.prepare("UPDATE video_waits SET status='done' WHERE id=?").bind(w.id).run();
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();
  await cron(e,'*/5 * * * *');
  assert.ok(!(await rows(e,'jobs')).some(j=>j.id==='video-'+w.id),'video_waits is authoritative');
});

test('CF3-5 twenty simulated thirty-second waits wake at P95 under forty-five seconds',async()=>{
  const NativeDate=Date,base=Date.UTC(2026,10,14,0,0,0);
  let at=base;
  class Clock extends NativeDate{constructor(...a){if(a.length)super(...a);else super(at);}static now(){return at;}}
  globalThis.Date=Clock;
  try{
    const e=env(),waits=[],alphabet='0123456789ABCDEFGHIJ';
    for(let i=0;i<20;i++){
      at=base+i*137;
      const ref='BV1xx411c7m'+alphabet[i],id='p95-'+i;
      assert.equal(await f.startVideoWait(e,{groupId:'P95GROUP'+i,ref,latest:{id},batchIds:[id],mentioned:true}),true);
      waits.push((await rows(e,'video_waits')).find(w=>w.id==='vw-'+id));
    }
    const lat=[];
    for(const w of waits){
      const dl=(await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id);
      assert.ok(dl,'deadline row for '+w.id);
      const notBefore=JSON.parse(dl.payload).notBefore;
      at=notBefore+400; // simulated queue delivery allowance
      await queue(e,'vdl-'+w.id);
      lat.push(at-Number(w.created_at));
      assert.ok((await rows(e,'jobs')).some(j=>j.id==='video-'+w.id),'woke '+w.id);
    }
    lat.sort((a,b)=>a-b);
    const p95=lat[Math.ceil(lat.length*0.95)-1];
    assert.ok(lat.every(x=>x>=30000),'never wakes before the thirty-second wait');
    assert.ok(p95<=45000,`P95 ${p95}ms`);
  }finally{globalThis.Date=NativeDate;}
});

test('CF3-6 the video cron path makes no QQ or network call',async()=>{
  const e=await setup(),w=await first(e),old=globalThis.fetch;let called=0;
  globalThis.fetch=async()=>{called++;throw Error('offline test');};
  try{
    e.WORK.sent=e.WORK.sent.filter(s=>s.body.id!=='vdl-'+w.id);
    await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();
    await cron(e,'*/5 * * * *');
  }finally{globalThis.fetch=old;}
  assert.equal(called,0,'no outbound request');
});

test('CF3-7 a deadline goes to WORK while the reply stays on CHAT',async()=>{
  const e=env();
  e.CHAT={sent:[],async send(body,opts){this.sent.push({body,opts});}};
  await f.scheduleVideoDeadline(e,'vw-lane',Date.now()+30000);
  assert.equal(e.WORK.sent.length,1,'deadline on the work lane');
  assert.equal(e.CHAT.sent.length,0,'deadline does not block the chat lane');
  await e.DB.prepare("INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,created_at) VALUES('vw-lane','g','"+BV+"','lane', '[]',1,0,?,?)").bind(Date.now()-1,Date.now()).run();
  await f.wakeVideoWait(e,'vw-lane');
  assert.ok(e.CHAT.sent.some(x=>x.body.id==='video-vw-lane'),'reply on the chat lane');
});
