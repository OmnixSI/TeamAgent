import { test } from 'node:test';
import assert from 'node:assert/strict';
import { env, req, qq, msg, worker } from './support.mjs';
const group = 'GROUP000001';
const consume = (e, id) => worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
const rows = async (e, table) => (await e.DB.prepare('SELECT * FROM '+table).all()).results;
const resumeId = id => 'mention-recovery:voice:'+id;
const cursor = async e => Number((await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('chat_cursor:'+group).first())?.value || 0);
async function setup(id, type='voice') {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: group });
  await qq(e, { ...msg(id, ''), attachments: [{ content_type: type, url: 'https://multimedia.nt.qq.com.cn/a.'+(type==='voice'?'silk':'ogg') }] }, 'GROUP_AT_MESSAGE_CREATE');
  return e;
}
async function runner(e) { return (await (await req(e, '/api/runner/voice/claim', {}, 'runner-secret')).json()).job; }
const report = (e, job, extra={}) => req(e, '/api/runner/voice/report', { id: job.id, lease: job.payload.lease, success: true, text: '帮我总结昨天的聊天内容。', ...extra }, 'runner-secret');
async function withModels(run) {
  const old = globalThis.fetch, prompts=[];
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://multimedia.nt.qq.com.cn/')) return new Response('OggSdata', { headers:{'content-type':'audio/ogg'} });
    if (String(url)==='https://api.deepseek.com/v1/tools/asr') return Response.json({text:'帮我总结昨天的聊天内容。',duration_ms:2000});
    assert.equal(String(url), 'https://api.deepseek.com/chat/completions', '禁止真实外发');
    const body=JSON.parse(options.body); prompts.push(body);
    return Response.json({choices:[{message:{content:body.messages[0].content.includes('最后的嘴替模块') ? '{"mode":"work","text":"昨天的聊天总结好了。"}' : '{"action":"reply","brief":"总结昨天聊天"}'}}]});
  };
  try { await run(prompts); } finally { globalThis.fetch=old; }
}
async function finish(e, id) {
  await consume(e, 'mention-recovery:voice:'+id);
  await consume(e, 'chat-'+id);
  await consume(e, 'mention-recovery:voice:'+id);
}
for (const type of ['voice','audio/ogg']) test('chat 先消费，'+type+' 晚到后原正文只回复一次', async () => {
  const id=type==='voice'?'late-runner':'late-cloud', e=await setup(id,type);
  await withModels(async prompts => {
    await consume(e, 'chat-'+id);
    assert.equal(prompts.length,0,'转写前不能用空语音调用模型');
    assert.equal(await cursor(e),0,'等待态不能前移游标');
    const waiting = (await rows(e,'jobs')).find(j=>j.id===resumeId(id));
    assert.equal(waiting.status,'pending');
    assert.ok(JSON.parse(waiting.payload).notBefore > Date.now());
    const before = e.WORK.sent.length;
    if(type==='voice') assert.equal((await report(e,await runner(e))).status,200);
    else await consume(e,'voice-'+id+'-0');
    assert.ok(e.WORK.sent.slice(before).some(w=>w.body.id===resumeId(id) && !w.opts?.delaySeconds),'结果必须实际解除等待并立即唤醒');
    const used=e.DB.executed;
    await finish(e,id);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
    assert.equal((await rows(e,'outbox')).length,1);
    assert.equal(await cursor(e),1);
    assert.ok(e.DB.executed-used<=48,'语音续接不超过48条SQL');
  });
});
test('转写失败明确没听清，重复失败报告不新增回复', async () => {
  const id='failed', e=await setup(id), job=await runner(e);
  await withModels(async () => {
    await consume(e,'chat-'+id);
    const failure={success:false,error_kind:'no_speech'};
    assert.equal((await report(e,job,failure)).status,200);
    await report(e,job,failure);
    await finish(e,id);
    const out=await rows(e,'outbox'); assert.equal(out.length,1); assert.match(out[0].body,/没听清/);
  });
});
test('runner 离线等待超时收口，晚到成功也不能再回复', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const id='timeout', e=await setup(id), job=await runner(e);
  await withModels(async () => {
    await consume(e,'chat-'+id);
    t.mock.timers.tick(181000);
    await finish(e,id);
    assert.equal((await rows(e,'outbox')).length,1);
    assert.match((await rows(e,'outbox'))[0].body,/没听清/);
    await report(e,job); await finish(e,id);
    assert.equal((await rows(e,'outbox')).length,1);
  });
});
test('成功重复上报与重复唤醒只产生一次回答', async () => {
  const id='duplicate', e=await setup(id), job=await runner(e);
  await withModels(async prompts => {
    await consume(e,'chat-'+id);
    await Promise.all([report(e,job),report(e,job)]);
    await finish(e,id);
    const count=prompts.length;
    await report(e,job); await finish(e,id);
    assert.equal(prompts.length,count); assert.equal((await rows(e,'outbox')).length,1);
  });
});
test('游标已越过且旧 chat done 时仍续接，保持单调游标', async () => {
  const id='past-cursor', e=await setup(id), job=await runner(e);
  await e.DB.prepare("UPDATE jobs SET status='done' WHERE id=?").bind('chat-'+id).run();
  await e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind('chat_cursor:'+group,'1').run();
  await withModels(async prompts => {
    await report(e,job); await finish(e,id);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
    assert.equal((await rows(e,'outbox')).length,1); assert.equal(await cursor(e),1);
  });
});
test('原消息超过15分钟，完成回填也不补发', async t => {
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const id='expired', e=await setup(id), job=await runner(e);
  await withModels(async prompts => {
    await consume(e,'chat-'+id); t.mock.timers.tick(901000);
    await report(e,job); await finish(e,id);
    assert.equal(prompts.length,0); assert.equal((await rows(e,'outbox')).length,0);
    assert.equal((await rows(e,'jobs')).find(j=>j.id==='mention-recovery:voice:'+id)?.status,'done');
  });
});

test('同一语音多附件分批完成，必须等全部结果且并发消费只回答一次', async () => {
  const id='multi', e=env(); await req(e,'/api/admin/bind',{groupId:group});
  await qq(e,{...msg(id,''),attachments:[0,1].map(i=>({content_type:'voice',url:'https://multimedia.nt.qq.com.cn/'+i+'.silk'}))},'GROUP_AT_MESSAGE_CREATE');
  await withModels(async prompts=>{
    await consume(e,'chat-'+id);
    const one=await runner(e),two=await runner(e);
    await report(e,one,{text:'帮我总结昨天的聊天内容。'});
    await consume(e,resumeId(id));
    assert.equal(prompts.length,0); assert.equal(await cursor(e),0);
    await report(e,two,{text:'重点列出没有做完的事情。'});
    await Promise.all([consume(e,resumeId(id)),consume(e,resumeId(id))]);
    const saved=JSON.parse((await rows(e,"message_meta"))[0].json);
    assert.equal(saved.media[1].asr,"重点列出没有做完的事情。");
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
    assert.equal((await rows(e,'outbox')).length,1);
  });
});
test('后续文字不能越过待转写语音；两个语音倒序完成各回复一次',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const e=await setup('first'),first=await runner(e);
  await qq(e,{...msg('second',''),attachments:[{content_type:'voice',url:'https://multimedia.nt.qq.com.cn/2.silk'}]},'GROUP_AT_MESSAGE_CREATE');
  const second=await runner(e); await qq(e,msg('tail','补充一句'));
  await withModels(async prompts=>{
    await consume(e,'chat-tail'); assert.equal(await cursor(e),0); assert.equal(prompts.length,0);
    await report(e,second,{text:'第二条语音请记录重点。'}); await consume(e,resumeId('second'));
    assert.equal(prompts.length,0); assert.equal(await cursor(e),0);
    await report(e,first); await consume(e,resumeId('first'));
    assert.equal(await cursor(e),1);
    t.mock.timers.tick(5001); await consume(e,resumeId('second'));
    assert.equal(await cursor(e),2); assert.equal((await rows(e,'outbox')).length,2);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/第二条语音请记录重点/);
  });
});

test('等待过期后不能永久挡住后来的聊天',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const e=await setup('old-wait');
  await withModels(async prompts=>{
    await consume(e,'chat-old-wait'); t.mock.timers.tick(901000);
    await consume(e,resumeId('old-wait'));
    await qq(e,msg('new-question','现在请帮我整理任务'),'GROUP_AT_MESSAGE_CREATE');
    await consume(e,'chat-new-question');
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/现在请帮我整理任务/);
    assert.equal(await cursor(e),2); assert.equal((await rows(e,'outbox')).length,1);
  });
});
test('转写先完成再消费原 chat，也只由续接任务回答',async()=>{
  const e=await setup('early'),job=await runner(e);
  await withModels(async prompts=>{
    await report(e,job); await consume(e,'chat-early');
    assert.equal(prompts.length,0);
    await finish(e,'early'); assert.equal((await rows(e,'outbox')).length,1);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
  });
});
test('回调恰在等待任务重新停放前到达，不丢唤醒',async()=>{
  const id='park-race',e=await setup(id),job=await runner(e);
  await withModels(async prompts=>{
    await consume(e,'chat-'+id);
    await e.DB.prepare("UPDATE jobs SET payload=json_set(payload,'$.notBefore',0) WHERE id=?").bind(resumeId(id)).run();
    const prepare=e.DB.prepare; let injected=false;
    function wrap(statement){return {...statement,bind(...args){return wrap(statement.bind(...args));},async all(){
      const result=await statement.all();
      if(!injected && /LEFT JOIN message_meta.*m\.rowid>/.test(statement.sql)){
        injected=true; await report(e,job);
      }
      return result;
    }};}
    e.DB.prepare=sql=>wrap(prepare(sql));
    await consume(e,resumeId(id)); e.DB.prepare=prepare;
    assert.ok(injected); assert.equal(prompts.length,0);
    const waiting=(await rows(e,'jobs')).find(j=>j.id===resumeId(id));
    assert.equal(JSON.parse(waiting.payload).notBefore,0,'写入结果与重新停放竞争后仍须立即就绪');
    await finish(e,id);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
    assert.equal((await rows(e,'outbox')).length,1);
  });
});
test('成功结果与超时写入竞争时，以数据库获胜的正文续接',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const id='timeout-race',e=await setup(id),job=await runner(e);
  await withModels(async prompts=>{
    await consume(e,'chat-'+id); t.mock.timers.tick(181000);
    const prepare=e.DB.prepare; let injected=false;
    function wrap(statement){return {...statement,bind(...args){return wrap(statement.bind(...args));},async run(){
      if(!injected && statement.sql.startsWith('UPDATE message_meta SET json=json_set')){
        injected=true; await report(e,job);
      }
      return statement.run();
    }};}
    e.DB.prepare=sql=>wrap(prepare(sql));
    await consume(e,resumeId(id)); e.DB.prepare=prepare;
    assert.ok(injected);
    assert.match(JSON.stringify(prompts.map(p=>p.messages)),/帮我总结昨天的聊天内容/);
    assert.equal((await rows(e,'outbox')).length,1);
    assert.doesNotMatch((await rows(e,'outbox'))[0].body,/没听清/);
  });
});
test('回答排队后超过15分钟，发送前复核会静默跳过',async t=>{
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const id='send-expired',e=await setup(id),job=await runner(e);
  await e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind('voice:mode','off').run();
  await withModels(async()=>{
    await consume(e,'chat-'+id); await report(e,job); await finish(e,id);
    assert.equal((await rows(e,'outbox'))[0].status,'pending');
    t.mock.timers.tick(901000); e.QQ_APP_ID='test-qq';
    await consume(e,'missing-job');
    assert.equal((await rows(e,'outbox'))[0].status,'skipped');
  });
});
