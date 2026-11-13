import {test} from 'node:test';
import assert from 'node:assert/strict';
import {worker, env, req, qq, msg} from './support.mjs';

const group='GROUP000001';
const queue=(e,id)=>(e.testWorker||worker).queue({messages:[{body:{id},ack(){}}]},e);
const bind=async e=>{await req(e,'/api/admin/bind',{groupId:group});return e;};
const value=async(e,key)=>(await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first())?.value;
const put=(e,key,val)=>e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(key,val).run();
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);

async function withAnswer(run){
  const old=globalThis.fetch,seen=[];
  globalThis.fetch=async(_url,options)=>{
    const b=JSON.parse(options.body);seen.push(b);
    return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')
      ?'{"mode":"work","text":"按当前问题回复。"}'
      :'{"should_reply":true,"kind":"direct","brief":"有效问题"}'}}]});
  };
  try{return await run(seen);}finally{globalThis.fetch=old;}
}

test('C1 per-group key written',async()=>{
  const e=await bind(env());
  await qq(e,msg('c1','你好'));
  await withAnswer(()=>queue(e,'chat-c1'));
  assert.equal(await value(e,'chat_cursor:'+group),'1');
  assert.equal(await value(e,'chat_cursor'),undefined,'legacy global key must no longer be written');
  assert.equal((await rows(e,'chat_decisions')).length,1);
});

test('C2 inflated cursor of other group does not block real group',async()=>{
  const e=await bind(env());
  await qq(e,msg('c2-a','先说一句'));
  await qq(e,msg('c2-b','再说一句'));
  // Outage state: the shared legacy key is stuck at the replay's 432 while the
  // real group already has its own committed cursor. A replay group also has its key.
  await put(e,'chat_cursor:'+group,'2');
  await put(e,'chat_cursor:REPLAY-GROUP-v1-x','432');
  await put(e,'chat_cursor','432');
  await qq(e,msg('c2','现在轮到你'),'GROUP_AT_MESSAGE_CREATE');
  await withAnswer(()=>queue(e,'chat-c2'));
  const decisions=await rows(e,'chat_decisions');
  assert.ok(decisions.some(d=>d.latest_id==='c2'),'rowid 3 must be processed despite the inflated legacy cursor');
  assert.equal(JSON.parse(decisions[0].batch_ids).includes('c2-a'),false,'already consumed rows stay consumed');
  assert.equal(await value(e,'chat_cursor:'+group),'3');
  assert.equal(await value(e,'chat_cursor'),'432','the legacy key stays untouched');
});

test('C3 legacy global key migrates once',async()=>{
  const e=await bind(env());
  for(const id of ['c3-1','c3-2','c3-3'])await qq(e,msg(id,'消息'+id));
  await put(e,'chat_cursor','2');
  await qq(e,msg('c3-4','最后一句'),'GROUP_AT_MESSAGE_CREATE');
  await withAnswer(()=>queue(e,'chat-c3-4'));
  assert.ok(Number(await value(e,'chat_cursor:'+group))>=2);
  assert.equal(await value(e,'chat_cursor:'+group),'4');
  const d=(await rows(e,'chat_decisions'))[0];
  assert.deepEqual(JSON.parse(d.batch_ids),['c3-3','c3-4'],'rows 1-2 are not replayed; 3-4 are processed');
  assert.equal((await rows(e,'outbox')).length,1);
  // Once persisted, a later legacy write cannot move the group.
  await put(e,'chat_cursor','99');
  await qq(e,msg('c3-5','还有一句'),'GROUP_AT_MESSAGE_CREATE');
  await withAnswer(()=>queue(e,'chat-c3-5'));
  assert.equal((await rows(e,'chat_decisions')).length,2);
  assert.equal(await value(e,'chat_cursor:'+group),'5');
});

test('C4 legacy exceeding max rowid is clamped',async()=>{
  const e=await bind(env());
  for(const id of ['c4-1','c4-2','c4-3'])await qq(e,msg(id,'消息'+id));
  await put(e,'chat_cursor','432');
  await qq(e,msg('c4-4','最后一句'),'GROUP_AT_MESSAGE_CREATE');
  await withAnswer(async seen=>{
    await queue(e,'chat-c4-4');
    assert.equal(seen.length,0,'a clamped cursor that covers the row must not call the model');
  });
  assert.equal(await value(e,'chat_cursor:'+group),'4','migration value is min(legacy, max(rowid))');
  assert.equal((await rows(e,'chat_decisions')).length,0);
});

test('C5 new group not poisoned by legacy',async()=>{
  const e=await bind(env());
  for(const id of ['c5-1','c5-2','c5-3','c5-4'])await qq(e,msg(id,'消息'+id));
  await put(e,'chat_cursor','2');
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('c5-b','GROUP000002','member1','新群消息',new Date().toISOString(),1).run();
  await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind('c5-b','{}').run();
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('chat-c5-b','chat',JSON.stringify({message:'c5-b'}),Date.now()).run();
  await withAnswer(()=>queue(e,'chat-c5-b'));
  assert.equal(await value(e,'chat_cursor:GROUP000002'),'5','the new group starts from its own clamped cursor');
  assert.ok((await rows(e,'chat_decisions')).some(d=>d.latest_id==='c5-b'),'rowid 5 must be processed');
});
