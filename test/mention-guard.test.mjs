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

test('MG12 three-day-old addressed messages never enter recovery',async()=>{
  const e=await fixture('ancient','旧请求',{age:3*86400000});
  await sweepMentions(e);
  assert.equal((await rows(e,'jobs')).length,0);
  assert.equal((await rows(e,'outbox')).length,0);
});

test('MG13 mixed +08:00/Z timestamps are eligible and ordered by instant',async()=>{
  const now=Date.parse('2026-11-13T14:52:14Z');
  const e=await fixture('offset','说话');
  await e.DB.prepare('UPDATE messages SET ts=? WHERE id=?').bind('2026-11-13T22:50:34+08:00','offset').run();
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('utc-newer',group,'member1','补充','2026-11-13T14:50:40Z',1).run();
  await sweepMentions(e,now);
  assert.equal((await rows(e,'outbox'))[0]?.msg_id,'offset');
  const fresh=await fixture('too-fresh','说话');
  await fresh.DB.prepare('UPDATE messages SET ts=?').bind('2026-11-13T22:51:48+08:00').run();
  await sweepMentions(fresh,now);
  assert.equal((await rows(fresh,'jobs')).length,0);
});

test('MG14 off:mention_recovery=1 disables the sweep',async()=>{
  const e=await fixture('paused','说话',{age:100000});
  await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('off:mention_recovery','1').run();
  await sweepMentions(e);
  assert.equal((await rows(e,'jobs')).length,0);
  assert.equal((await rows(e,'outbox')).length,0);
});

test('MG15 recovery includes 15 minutes exactly and rejects one millisecond older',async t=>{
  const now=Date.now();t.mock.timers.enable({apis:['Date'],now});
  for(const age of [900000,900001]){
    const e=await fixture('boundary-'+age,'说话',{age});
    await sweepMentions(e,now);
    assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='chat').length,age===900000?1:0);
  }
});

test('MG16 merged reply durably marks each source and watchdog does not replay either',async()=>{
  const e=await fixture('batch-first','说话',{age:100000});
  await qq(e,msg('batch-tail','补充一句'));
  await models(()=>queue(e,'chat-batch-tail'),'reply');
  const decision=(await rows(e,'chat_decisions')).at(-1);
  assert.deepEqual(JSON.parse(decision.batch_ids),['batch-first','batch-tail']);
  for(const id of ['batch-first','batch-tail']){
    const mark=await e.DB.prepare('SELECT outbox_id FROM chat_decisions d WHERE EXISTS(SELECT 1 FROM json_each(d.batch_ids) b WHERE b.value=?)').bind(id).first();
    assert.equal(mark?.outbox_id,decision.outbox_id);
  }
  const n=(await rows(e,'jobs')).length;
  await sweepMentions(e);
  assert.equal((await rows(e,'jobs')).length,n);
});

test('MG17 sender skips stale, missing, invalid and already-answered recovery/receipt without network',async()=>{
  for(const kind of ['mention-recovery','mention-receipt'])for(const reason of ['old','missing','invalid','answered','batch-answered']){
    const source=kind+'-'+reason,id=kind+':'+source+(kind==='mention-recovery'?':1':'');
    const e=await fixture(source,'说话',{age:reason==='old'?3*86400000:100000});
    if(reason==='missing')await e.DB.prepare('DELETE FROM messages').run();
    if(reason==='invalid')await e.DB.prepare("UPDATE messages SET ts='bad-time'").run();
    if(reason==='answered')await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('normal-answer',group,source,'回复','sent',Date.now()).run();
    if(reason==='batch-answered')await e.DB.prepare(`INSERT INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,created_at) VALUES(?,?,?, ?,1,1,0,'model','reply',?)`).bind('normal-decision',group,'tail',JSON.stringify([source,'tail']),Date.now()).run();
    await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind(id,group,source,'待发送','pending',Date.now()).run();
    e.QQ_APP_ID='gate-'+source;
    const old=globalThis.fetch;let requests=0;
    globalThis.fetch=async()=>{requests++;return Response.json({access_token:'fake',expires_in:300,id:'fake'});};
    try{await worker.queue({messages:[]},e);}finally{globalThis.fetch=old;}
    assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind(id).first()).status,'skipped',source);
    assert.equal(requests,0,source);
  }
});

test('MG18 sender permits fresh recovery own decision and receipt does not block its answer',async()=>{
  const e=await fixture('fresh-send','说话',{age:100000});
  await sweepMentions(e);
  const recovery=(await rows(e,'jobs')).find(j=>j.kind==='chat');
  await models(()=>queue(e,recovery.id),'reply');
  e.QQ_APP_ID='positive-recovery';
  const old=globalThis.fetch;let sends=0;
  globalThis.fetch=async url=>String(url).includes('getAppAccessToken')?Response.json({access_token:'fake',expires_in:300}):(sends++,Response.json({id:'fake'}));
  try{await worker.queue({messages:[]},e);}finally{globalThis.fetch=old;}
  assert.equal(sends,1);
  assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind(recovery.id).first()).status,'sent');
  assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind('mention-receipt:fresh-send').first()).status,'skipped');
});


test('MG19 reply marker includes all sources and latest even when batch input omits the tail',async()=>{
  const file=`.wrangler/reply-marker-${process.pid}.mjs`;
  await build({entryPoints:['src/rhythm.ts'],bundle:true,platform:'browser',format:'esm',outfile:file});
  const {recordDecision}=await import('../'+file);
  const e=await fixture('source','说话',{age:100000});
  await recordDecision(e,{id:'batch',group_id:group,latest_id:'tail',batch_ids:['source','source'],action:'reply',outbox_id:'batch-answer'});
  const d=(await rows(e,'chat_decisions'))[0];
  assert.deepEqual(JSON.parse(d.batch_ids),['source','tail']);
  await sweepMentions(e);
  assert.equal((await rows(e,'jobs')).length,0);
});

test('MG20 fresh multipart recovery sends all its segments and skips the obsolete receipt',async()=>{
  const e=await fixture('multipart','说话',{age:100000});
  for(const suffix of ['', '~1'])await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('mention-recovery:multipart:1'+suffix,group,'multipart','回答片段','pending',Date.now()).run();
  await e.DB.prepare(`INSERT INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,outbox_id,created_at) VALUES(?,?,?,'["multipart"]',1,1,0,'model','reply',?,?)`).bind('mention-recovery:multipart:1',group,'multipart','mention-recovery:multipart:1',Date.now()).run();
  await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('mention-receipt:multipart',group,'multipart','在做','pending',Date.now()).run();
  e.QQ_APP_ID='multipart-positive';let sends=0;const old=globalThis.fetch;
  globalThis.fetch=async url=>String(url).includes('getAppAccessToken')?Response.json({access_token:'fake',expires_in:300}):(sends++,Response.json({id:'fake'}));
  try{await worker.queue({messages:[]},e);}finally{globalThis.fetch=old;}
  assert.equal(sends,2);
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='mention-receipt:multipart'").first()).status,'skipped');
});

test('MG21 sender rechecks reply status after token acquisition',async()=>{
  const e=await fixture('token-race','说话',{age:100000}),id='mention-recovery:token-race:1';
  await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind(id,group,'token-race','补偿','pending',Date.now()).run();
  e.QQ_APP_ID='token-race';const old=globalThis.fetch;let sends=0;
  globalThis.fetch=async url=>{
    if(String(url).includes('getAppAccessToken')){
      await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('normal-race-answer',group,'token-race','正常回答','sent',Date.now()).run();
      return Response.json({access_token:'fake',expires_in:300});
    }
    sends++;return Response.json({id:'fake'});
  };
  try{await worker.queue({messages:[]},e);}finally{globalThis.fetch=old;}
  assert.equal(sends,0);
  assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind(id).first()).status,'skipped');
});
