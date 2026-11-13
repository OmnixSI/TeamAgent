import {test} from 'node:test';
import assert from 'node:assert/strict';
import {worker,env,req,qq,msg} from './support.mjs';
import {build} from 'esbuild';
const guardPath=`.wrangler/test-mention-guard-${process.pid}.mjs`;
await build({entryPoints:['src/mention-guard.ts'],bundle:true,format:'esm',platform:'browser',outfile:guardPath});
const {sweepMentions,addressedMessages,guardMentionDecision,mentionReceipt,withMentionReceipt}=await import('../'+guardPath);

const group='GROUP000001', queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const rows=async(e,table)=>(await e.DB.prepare('SELECT * FROM '+table).all()).results;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function scheduled(e){const tasks=[];await worker.scheduled({},e,{waitUntil:p=>tasks.push(p)});await Promise.all(tasks);}
async function fixture(id,body,{age=0,mentioned=1,meta={}}={}){
  const e=env();await req(e,'/api/admin/bind',{groupId:group});
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind(id,group,'member1',body,new Date(Date.now()-age).toISOString(),mentioned).run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind(id,JSON.stringify(meta)).run();
  return e;
}
async function models(run,action='stop'){
  const old=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://api.deepseek.com/chat/completions','本地回放禁止真实 QQ/外网请求');
    const b=JSON.parse(options.body);
    return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')
      ?'{"mode":"work","text":"我在，正在看这条消息。"}':JSON.stringify({action,brief:'用户叫到了机器人'})}}]});
  };
  try{return await run();}finally{globalThis.fetch=old;}
}

test('MG1 merged bot quote cannot stop or wait even when the latest message is ordinary',async()=>{
  for(const action of ['stop','wait']){
    const e=await fixture('quoted-'+action,'你人呢',{mentioned:0,meta:{replyTo:{kind:'bot',targetId:'bot-old'}}});
    await qq(e,msg('tail-'+action,'补充一句'));
    await models(()=>queue(e,'chat-tail-'+action),action);
    assert.equal((await rows(e,'chat_decisions')).at(-1).action,'reply');
    assert.equal((await rows(e,'outbox')).length,1);
  }
});

test('MG2 msg#428 shape missed beyond cursor gets a durable reply and recovery job at 90 seconds',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const e=await fixture('msg-428','说话',{age:90000});
  await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('chat_cursor:'+group,'999').run();
  const before=e.DB.executed;await scheduled(e);
  assert.ok(e.DB.executed-before<=48,'watchdog plus mandatory cron maintenance stays within D1 budget');
  console.log('watchdog + scheduled D1 statements:',e.DB.executed-before);
  const output=await rows(e,'outbox');assert.equal(output.length,1);assert.equal(output[0].msg_id,'msg-428');
  assert.ok(output[0].created_at-Date.parse((await rows(e,'messages'))[0].ts)<=90000);
  const recovery=(await rows(e,'jobs')).find(j=>j.id.startsWith('mention-recovery:'));assert.ok(recovery);
  await models(()=>queue(e,recovery.id));
  assert.ok((await rows(e,'chat_decisions')).some(d=>d.latest_id==='msg-428'&&d.action==='reply'));
  assert.equal((await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('chat_cursor:'+group).first()).value,'999');
  assert.ok((await rows(e,'activity')).some(a=>a.kind==='mention.recovered'));
  console.log('msg#428 本地独立 SQLite 回放：90 秒内 reply；QQ 真实发送 0 次、线上 D1 写入 0 行');
});

test('MG3 msg#424 quote shape active task gets one receipt at 45 seconds and no receipt after completion',async()=>{
  const e=await fixture('msg-424','你人呢',{age:45000,mentioned:0,meta:{replyTo:{kind:'bot',targetId:'bot-old'}}});
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,?,?,?,?)')
    .bind('research-424','research',JSON.stringify({latestId:'msg-424'}),'running',Date.now()-45000).run();
  await scheduled(e);await scheduled(e);
  const out=await rows(e,'outbox');assert.equal(out.length,1);assert.match(out[0].body,/^在做：/);assert.equal(out[0].msg_id,'msg-424');
  assert.ok((await rows(e,'outbox_meta')).some(m=>JSON.parse(m.json).kind==='mention_receipt'));
  console.log('msg#424 形态本地独立 SQLite 回放：45 秒 reply；QQ 真实发送 0 次、线上 D1 写入 0 行');
  const done=await fixture('done','看完了吗',{age:45000});
  await done.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('answer',group,'done','做完了','sent',Date.now()).run();
  await scheduled(done);assert.equal((await rows(done,'outbox')).length,1);
});

test('MG4 running model emits a receipt at 45 seconds and clears the timer when it finishes',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const e=await fixture('slow','查最新进展');
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('chat-slow','chat',JSON.stringify({message:'slow'}),Date.now()).run();
  e.QQ_APP_ID='local-mention-sender';
  const old=globalThis.fetch;let finish,started,simulatedSends=0;
  const ready=new Promise(r=>{started=r;});
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake',expires_in:300});
    if(String(url).startsWith('https://api.bot.qq.com/v2/groups/')){simulatedSends++;return Response.json({id:'local-only-'+simulatedSends});}
    assert.equal(String(url),'https://api.deepseek.com/chat/completions');
    const b=JSON.parse(options.body);
    if(b.messages[0].content.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"结果在这里。"}'}}]});
    started();return new Promise(r=>{finish=()=>r(Response.json({choices:[{message:{content:'{"action":"reply","brief":"结果"}'}}]}));});
  };
  try{
    const running=queue(e,'chat-slow');await ready;
    t.mock.timers.tick(44999);await tick();assert.equal((await rows(e,'outbox')).length,0);
    t.mock.timers.tick(1);await tick();assert.equal((await rows(e,'outbox')).length,1);
    const wake=e.WORK.sent.find(x=>x.body.id==='mention-receipt:slow');assert.ok(wake);
    await queue(e,wake.body.id);assert.equal(simulatedSends,1,'receipt sender runs while original model is blocked');
    finish();await running;t.mock.timers.tick(90000);await tick();assert.equal((await rows(e,'outbox')).length,2);assert.equal(simulatedSends,2);
  }finally{globalThis.fetch=old;t.mock.timers.reset();}
});

test('MG5 voice silence cannot discard an explicit mention after decision guard passed',async()=>{
  const e=await fixture('silent-voice','说话');
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('chat-silent-voice','chat',JSON.stringify({message:'silent-voice'}),Date.now()).run();
  const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"mode":"work","text":"[[SILENT]]"}'}}]});
  try{await queue(e,'chat-silent-voice');assert.equal((await rows(e,'outbox')).length,1);}finally{globalThis.fetch=old;}
});

test('MG6 a lost queue wakeup keeps the durable recovery and still gives a receipt',async()=>{
  const e=await fixture('queue-down','你人呢',{age:91000});
  e.WORK.send=async()=>{throw Error('queue unavailable');};
  await assert.doesNotReject(()=>sweepMentions(e));
  assert.equal((await rows(e,'outbox')).length,1);
  assert.ok((await rows(e,'jobs')).some(j=>j.id.startsWith('mention-recovery:')));
});

test('MG7 batch mention receipt belongs to the source, without adding the ordinary tail',()=>{
  const source={id:'source',mentioned:1},latest={id:'tail',mentioned:0};
  assert.deepEqual(addressedMessages({mentioned:true,batch:[source,latest],latest}).map(m=>m.id),['source']);
  for(const action of ['stop','wait'])assert.equal(guardMentionDecision({action,kind:'proactive',brief:''},{latest:source}).action,'reply');
  assert.equal(guardMentionDecision({action:'stop',kind:'proactive',brief:''},{latest}).action,'stop');
  assert.equal(guardMentionDecision({action:'stop',kind:'proactive',brief:''},{mentioned:1}).action,'reply');
});

test('MG8 concurrent watchdog claims and receipts are idempotent and capped at two attempts',async()=>{
  const e=await fixture('retry','说话',{age:100000}),now=Date.now();
  await Promise.all([sweepMentions(e,now),sweepMentions(e,now)]);
  assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='chat').length,1);
  assert.equal((await rows(e,'outbox')).length,1);
  await Promise.all([mentionReceipt(e,{id:'retry'}),mentionReceipt(e,{id:'retry'})]);
  assert.equal((await rows(e,'outbox')).length,1);
  // Simulate a lost local receipt only; real replay never deletes production rows.
  await e.DB.prepare('DELETE FROM outbox WHERE msg_id=?').bind('retry').run();
  await sweepMentions(e,now+89999);assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='chat').length,1);
  await sweepMentions(e,now+90000);assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='chat').length,2);
  await e.DB.prepare('DELETE FROM outbox WHERE msg_id=?').bind('retry').run();
  await sweepMentions(e,now+180000);assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='chat').length,2);
  assert.equal(JSON.parse((await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('mention-recovery:retry').first()).value).attempts,2);
});

test('MG9 ordinary chat, terminal decisions, and completed batch replies never get watchdog receipts',async()=>{
  for(const kind of ['ordinary','terminal','batch']){
    const e=await fixture(kind,'内容',{age:100000,mentioned:kind==='ordinary'?0:1});
    if(kind!=='ordinary')await e.DB.prepare(`INSERT INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,outbox_id,created_at)
      VALUES(?,?,?,?,1,1,0,'model',?,?,?)`).bind('decision',group,kind==='batch'?'tail':kind,JSON.stringify([kind]),kind==='terminal'?'reply':'tool',kind==='batch'?'batch-answer':null,Date.now()).run();
    if(kind==='batch')await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('batch-answer',group,'tail','结果','sent',Date.now()).run();
    await sweepMentions(e);assert.equal((await rows(e,'jobs')).length,0);assert.equal((await rows(e,'outbox')).length,kind==='batch'?1:0);
  }
});

test('MG10 a newer idle mention must not hide an older overdue mention from the watchdog',async()=>{
  const e=await fixture('overdue','说话',{age:100000});
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('newer',group,'member1','补充',new Date(Date.now()-50000).toISOString(),1).run();
  await sweepMentions(e);
  assert.equal((await rows(e,'outbox'))[0]?.msg_id,'overdue');
});

test('MG11 successful and rejected work both cancel pending receipt timers',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:Date.now()});
  const e=await fixture('timer-cleanup','看一下');
  const latest=(await rows(e,'messages'))[0];
  assert.equal(await withMentionReceipt(e,{latest},async()=>42),42);
  await assert.rejects(()=>withMentionReceipt(e,{latest},async()=>{throw Error('model unavailable');}),/model unavailable/);
  t.mock.timers.tick(90000);await tick();assert.equal((await rows(e,'outbox')).length,0);
});
