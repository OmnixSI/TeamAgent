import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker} from './support.mjs';
const out=`.wrangler/resend-video-entry-${process.pid}.mjs`;
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,platform:'browser',format:'esm',outfile:out});
const {wakeVideoWait,runVideoWait}=await import('../'+out);
const DAY=86400000,GROUP='GROUP000001';
const jobKinds=['voice_notice','chat','research','scout','video_reply','mention_receipt','semantic_reply','links','claim_notice','ci_triage'];
async function source(e,id,at){await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,1,0)').bind(id,GROUP,'member1','历史交办',new Date(at).toISOString()).run();}
async function outgoing(e,id,at,msgId='source'){await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind(id,GROUP,msgId,'待发送的消息','pending',at).run();}
async function consume(e,id){await worker.queue({messages:id?[{body:{id},ack(){}}]:[]},e);}
async function cron(e){const tasks=[];await worker.scheduled({},e,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);}
async function simulated(e,run,{token}={}){
  e.QQ_APP_ID='recovery-'+crypto.randomUUID();
  const old=globalThis.fetch,seen={models:0,sends:0,requests:0};
  globalThis.fetch=async(url,options)=>{
    seen.requests++;
    if(String(url).includes('getAppAccessToken')){await token?.();return Response.json({access_token:'offline',expires_in:300});}
    if(String(url).startsWith('https://api.bot.qq.com/v2/groups/')){seen.sends++;return Response.json({id:'offline'});}
    assert.equal(String(url),'https://api.deepseek.com/chat/completions','禁止真实网络请求');
    seen.models++;return Response.json({choices:[{message:{content:'{"mode":"work","text":"本地模拟完成。"}'}}]});
  };
  try{await run(seen);}finally{globalThis.fetch=old;}
}

test('P1-1 three-day ordinary and scheduled pending outbox are skipped by queue and cron recovery',async()=>{
  for(const entry of [consume,cron]){
    const e=env(),now=Date.now();await source(e,'source',now-3*DAY);
    for(const id of ['chat-old','video-old','notification-old','schedule-run-old'])await outgoing(e,id,now-3*DAY);
    await simulated(e,async seen=>{
      await entry(e);
      assert.equal(seen.requests,0,'expired backlog must not even request a QQ token');
      assert.equal(seen.sends,0);
    });
    const rows=(await e.DB.prepare('SELECT * FROM outbox').all()).results;
    assert.equal(rows.length,4);assert.ok(rows.every(r=>r.status==='skipped'));
  }
});

test('P1-1 schedule expiry uses the original due time even if the outbox was just generated',async()=>{
  const e=env(),now=Date.now();await source(e,'source',now-3*DAY);
  await outgoing(e,'sched-job',now);
  await e.DB.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES('run','schedule',?,'ok','sched-job')").bind(now-2*3600000-1).run();
  await simulated(e,async seen=>{await consume(e);assert.equal(seen.requests,0);});
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='sched-job'").first()).status,'skipped');
});

test('P1-1 new output from an old source and recent source with old output both stay sendable',async()=>{
  for(const fresh of ['output','source']){
    const e=env(),now=Date.now();await source(e,'source',now-(fresh==='source'?100000:3*DAY));
    await outgoing(e,'ordinary',now-(fresh==='output'?0:3*DAY));
    await simulated(e,async seen=>{await consume(e);assert.equal(seen.sends,1);});
  }
});

test('P1-1 explicit long-work results retain their delivery semantics',async()=>{
  for(const id of ['ready-task','media-result-task','delivery-notice-task','delivery-attention-task','long-plan']){
    const e=env(),now=Date.now();await source(e,'source',now-3*DAY);await outgoing(e,id,now-3*DAY);
    if(id==='long-plan')await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,'plan','{}','done',?)").bind(id,now-3*DAY).run();
    await simulated(e,async seen=>{await consume(e);assert.equal(seen.sends,1,id);});
  }
});

test('P1-1 expiry is rechecked at send lock after a slow token request',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const e=env();await source(e,'source',now-DAY+1);await outgoing(e,'chat-boundary',now-DAY+1);
  await simulated(e,async seen=>{await consume(e);assert.equal(seen.sends,0);},{token:()=>t.mock.timers.tick(2)});
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='chat-boundary'").first()).status,'skipped');
});

test('P1-2 old reply job delivered directly before cron expires without model, outbox or QQ',async()=>{
  for(const kind of jobKinds){
    const e=env(),now=Date.now();await source(e,'source',now-3*DAY);
    await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('old-'+kind,kind,JSON.stringify({message:'source'}),now-3*DAY).run();
    await simulated(e,async seen=>{await consume(e,'old-'+kind);assert.equal(seen.models,0,kind);assert.equal(seen.sends,0,kind);});
    const row=await e.DB.prepare('SELECT * FROM jobs WHERE id=?').bind('old-'+kind).first();
    assert.equal(row.status,'failed',kind);assert.equal(row.error,'expired',kind);assert.equal(row.attempts,0,kind);
    assert.equal((await e.DB.prepare('SELECT * FROM outbox').all()).results.length,0);
  }
});

test('P1-2 valid running lease survives expiry, and stale lease becomes expired',async()=>{
  for(const live of [true,false]){
    const e=env(),now=Date.now();
    await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,lease_until,created_at) VALUES('leased','voice_notice','{}','running',?,?)").bind(now+(live?60000:-1),now-3*DAY).run();
    await simulated(e,async seen=>{await consume(e,'leased');assert.equal(seen.requests,0);});
    const row=await e.DB.prepare("SELECT status,error FROM jobs WHERE id='leased'").first();
    assert.equal(row.status,live?'running':'failed');assert.equal(row.error,live?null:'expired');
  }
});

test('P1-2 fresh notice created for an old source still processes and sends once',async()=>{
  const e=env(),now=Date.now();await source(e,'source',now-3*DAY);
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES('fresh-notice','voice_notice',?,?)").bind(JSON.stringify({message:'source',status:'长期工作刚完成',result:'已有结果'}),now).run();
  await simulated(e,async seen=>{await consume(e,'fresh-notice');assert.equal(seen.models,1);assert.equal(seen.sends,1);});
  assert.equal((await e.DB.prepare("SELECT status FROM jobs WHERE id='fresh-notice'").first()).status,'done');
});

test('P1-2 video report wake and direct execution cannot resurrect an expired wait',async()=>{
  for(const entry of [wakeVideoWait,runVideoWait]){
    const e=env(),now=Date.now();
    await e.DB.prepare(`INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,ready,due_at,created_at)
      VALUES('vw-old',?,'BV1xx411c7mD','source','["source"]',1,1,?,?)`).bind(GROUP,now-3*DAY,now-3*DAY).run();
    await simulated(e,async seen=>{await entry(e,'vw-old');assert.equal(seen.requests,0);});
    assert.equal(e.WORK.sent.length,0);
    assert.equal((await e.DB.prepare('SELECT * FROM jobs').all()).results.length,0);
    assert.equal((await e.DB.prepare('SELECT * FROM outbox').all()).results.length,0);
  }
});


test('P1-2 old pending job expires even if deferred into the future or already at attempt limit',async()=>{
  const e=env(),now=Date.now();
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,attempts,created_at) VALUES('deferred','voice_notice',?,'pending',3,?)")
    .bind(JSON.stringify({notBefore:now+DAY}),now-3*DAY).run();
  await simulated(e,async seen=>{await consume(e,'deferred');assert.equal(seen.requests,0);});
  const row=await e.DB.prepare("SELECT status,error,attempts FROM jobs WHERE id='deferred'").first();
  assert.equal(row.status,'failed');assert.equal(row.error,'expired');assert.equal(row.attempts,3);
});

test('P1-1 stale source cannot renew an outbox with future or invalid source timestamp',async()=>{
  for(const stamp of ['invalid',new Date(Date.now()+DAY).toISOString()]){
    const e=env(),now=Date.now();await source(e,'source',now-3*DAY);
    await e.DB.prepare('UPDATE messages SET ts=?').bind(stamp).run();await outgoing(e,'old-invalid',now-3*DAY);
    await simulated(e,async seen=>{await consume(e);assert.equal(seen.requests,0);});
    assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='old-invalid'").first()).status,'skipped');
  }
});

test('P1-1 legacy schedule id retains its original due time without a schedule_runs row',async()=>{
  const e=env(),now=Date.now();await source(e,'source',now);
  const id='sched-legacy-'+(now-3*3600000);await outgoing(e,id,now);
  await simulated(e,async seen=>{await consume(e);assert.equal(seen.requests,0);});
  assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind(id).first()).status,'skipped');
});

test('P1-1 send claim re-reads changed source and outbox timestamps after token acquisition',async()=>{
  const e=env(),now=Date.now();await source(e,'source',now);await outgoing(e,'changed',now);
  await simulated(e,async seen=>{await consume(e);assert.equal(seen.sends,0);},{token:async()=>{
    await e.DB.prepare('UPDATE messages SET ts=?').bind(new Date(now-3*DAY).toISOString()).run();
    await e.DB.prepare('UPDATE outbox SET created_at=?').bind(now-3*DAY).run();
  }});
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='changed'").first()).status,'skipped');
});

test('P1-2 direct job consumption includes 24h exactly and expires one millisecond later',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  for(const age of [DAY,DAY+1]){
    const e=env();await source(e,'source',now-age);
    await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES('boundary','voice_notice',?,?)").bind(JSON.stringify({message:'source',status:'结果'}),now-age).run();
    await simulated(e,async seen=>{await consume(e,'boundary');assert.equal(seen.models,age===DAY?1:0);assert.equal(seen.sends,age===DAY?1:0);});
    assert.equal((await e.DB.prepare("SELECT status FROM jobs WHERE id='boundary'").first()).status,age===DAY?'done':'failed');
  }
});

test('P1-1 newly generated fragments with millisecond ordering survive an old source',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  const e=env();await source(e,'source',now-3*DAY);
  await outgoing(e,'fresh-fragments',now);await outgoing(e,'fresh-fragments~1',now+1);
  await simulated(e,async seen=>{await consume(e);assert.equal(seen.sends,2);});
});
