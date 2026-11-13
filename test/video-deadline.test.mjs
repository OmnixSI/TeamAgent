import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { worker, env, req, qq, msg } from './support.mjs';
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/fetchjobs-deadline-${process.pid}.mjs`});
const f = await import(`../.wrangler/fetchjobs-deadline-${process.pid}.mjs`);
const BV='BV1xx411c7mD', group='GROUP000001';
const result={bvid:BV,title:'测试视频标题',desc:'视频简介',owner:'UP 主',tname:'科技',duration:60,pubdate:1,stat:{view:20,like:3,coin:1,favorite:2,reply:2},subtitle:'字幕正文',subtitle_lang:'zh-CN',comments:[{uname:'观众',message:'热评'}],tier:'light',fetched_at:new Date().toISOString()};
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);
async function setup(){const e=env();await req(e,'/api/admin/bind',{groupId:group});return e;}
async function first(e,id='question'){await qq(e,msg(id,'视频讲了啥 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE');await queue(e,'chat-'+id);return (await rows(e,'video_waits')).find(w=>w.latest_id===id);}
async function deliver(e,waitId){await e.DB.prepare("UPDATE jobs SET payload=json_set(payload,'$.notBefore',0) WHERE id=?").bind('vdl-'+waitId).run();await queue(e,'vdl-'+waitId);}
async function mockModel(run){const old=globalThis.fetch,seen=[];globalThis.fetch=async(_url,o)=>{const b=JSON.parse(o.body);seen.push(b);return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"UP 主介绍了新方法。"}':'{"should_reply":false,"kind":"proactive","brief":"测试视频标题"}'}}]});};try{return await run(seen);}finally{globalThis.fetch=old;}}

test('R3-1 a due waiting video is woken by its deadline job and answers once',async()=>{
  const e=await setup(),w=await first(e);
  const deadline=(await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id);
  assert.ok(deadline,'startVideoWait must enqueue video_deadline');
  assert.equal(deadline.kind,'video_deadline');
  assert.deepEqual(JSON.parse(deadline.payload).wait,w.id);
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();
  await deliver(e,w.id);
  const reply=(await rows(e,'jobs')).find(j=>j.id==='video-'+w.id);
  assert.ok(reply,'a due wait wakes its reply job');
  assert.equal(reply.kind,'video_reply');
  await mockModel(async seen=>{
    await queue(e,'video-'+w.id);
    assert.match(JSON.stringify(seen),/读取超时/);
    const out=(await rows(e,'outbox')).filter(o=>o.msg_id==='question');
    assert.equal(out.length,1,'one answer');
    assert.ok(out[0].body.trim().length>0);
  });
  assert.equal((await rows(e,'video_waits')).find(x=>x.id===w.id).status,'done');
});

test('R3-2 a finished video wait is not woken by a late deadline',async()=>{
  const e=await setup(),w=await first(e);
  assert.ok((await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id),'deadline job exists');
  await e.DB.prepare("UPDATE video_waits SET status='done' WHERE id=?").bind(w.id).run();
  const before=(await rows(e,'outbox')).length;
  await deliver(e,w.id);
  assert.ok(!(await rows(e,'jobs')).some(j=>j.id==='video-'+w.id));
  assert.equal((await rows(e,'outbox')).length,before);
  assert.equal((await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id).status,'done');
});

test('R3-3 a ready video wait answers from cache when its deadline arrives',async()=>{
  const e=await setup(),w=await first(e);
  assert.ok((await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id),'deadline job exists');
  await e.DB.prepare('INSERT OR REPLACE INTO media_notes VALUES(?,?,?)').bind('bili:'+BV,JSON.stringify(result),new Date().toISOString()).run();
  await e.DB.prepare('UPDATE video_waits SET ready=1 WHERE id=?').bind(w.id).run();
  await deliver(e,w.id);
  assert.ok((await rows(e,'jobs')).some(j=>j.id==='video-'+w.id),'ready wait wakes even before due');
  await mockModel(async seen=>{
    await queue(e,'video-'+w.id);
    assert.match(JSON.stringify(seen),/测试视频标题/);
    assert.match(JSON.stringify(seen),/字幕正文/);
  });
  assert.equal((await rows(e,'outbox')).filter(o=>o.msg_id==='question').length,1);
});

test('R3-4 two waits sharing a due time schedule the second deadline under thirty seconds',async()=>{
  const e=env();
  const x={groupId:group,ref:BV,latest:{id:'one'},batchIds:['one'],mentioned:true};
  assert.equal(await f.startVideoWait(e,x),true);
  const one=(await rows(e,'video_waits')).find(w=>w.id==='vw-one');
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()+9000,one.id).run();
  const shared=(await rows(e,'video_waits')).find(w=>w.id==='vw-one');
  assert.equal(await f.startVideoWait(e,{...x,latest:{id:'two'},batchIds:['two']}),true);
  const two=(await rows(e,'video_waits')).find(w=>w.id==='vw-two');
  assert.equal(two.due_at,shared.due_at,'the second wait shares the first deadline');
  const dl=(await rows(e,'jobs')).find(j=>j.id==='vdl-vw-two');
  assert.ok(dl,'second wait gets its own deadline job');
  const delay=JSON.parse(dl.payload).notBefore-Date.now();
  assert.ok(delay<30000,`delay ${delay} stays under thirty seconds`);
  assert.ok(delay>1000,`delay ${delay} is not immediate`);
  const sent=e.WORK.sent.find(s=>s.body.id==='vdl-vw-two');
  assert.ok(sent,'deadline is sent to the chat lane');
  assert.ok(sent.opts.delaySeconds<30,`queue delay ${sent.opts.delaySeconds} stays under thirty seconds`);
});

test('R3-5 a deadline delivered before due wakes nothing',async()=>{
  const e=await setup(),w=await first(e);
  const dl=(await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id);
  assert.ok(dl,'deadline job exists');
  assert.ok(JSON.parse(dl.payload).notBefore>Date.now(),'deadline is not claimable before due');
  await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()+60000,w.id).run();
  await deliver(e,w.id);
  assert.ok(!(await rows(e,'jobs')).some(j=>j.id==='video-'+w.id),'early delivery must not wake');
  assert.equal((await rows(e,'video_waits')).find(x=>x.id===w.id).status,'waiting');
  assert.equal((await rows(e,'outbox')).length,0);
  assert.equal((await rows(e,'jobs')).find(j=>j.id==='vdl-'+w.id).status,'done');
});
