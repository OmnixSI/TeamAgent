import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { worker, env, req, qq, msg } from './support.mjs';
await build({entryPoints:['src/fetchjobs.ts'],bundle:true,format:'esm',platform:'browser',outfile:`.wrangler/fetchjobs-${process.pid}.mjs`});
const f = await import(`../.wrangler/fetchjobs-${process.pid}.mjs`);
const BV='BV1xx411c7mD', group='GROUP000001', now=()=>Date.now();
const result={bvid:BV,title:'测试视频标题',desc:'视频简介',owner:'UP 主',tname:'科技',duration:60,pubdate:1,stat:{view:20,like:3,coin:1,favorite:2,reply:2},subtitle:'字幕正文',subtitle_lang:'zh-CN',comments:[{uname:'观众',message:'热评'}],tier:'light',fetched_at:new Date().toISOString()};
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const cron=async e=>{let p; await worker.scheduled({},e,{waitUntil(x){p=x;}}); await p;};
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(x=>x.results);
const insertJob=(e,id,kind,status='pending',attempts=0,lease=0)=>e.DB.prepare('INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,kind,'{}',status,attempts,lease,now()).run();
const runner=(e,path,b)=>req(e,'/api/runner/fetch/'+path,b,'runner-secret');
async function setup(){const e=env(); await req(e,'/api/admin/bind',{groupId:group}); return e;}
async function first(e,id='question'){await qq(e,msg(id,'视频讲了啥 https://www.bilibili.com/video/'+BV),'GROUP_AT_MESSAGE_CREATE'); await queue(e,'chat-'+id); return (await rows(e,'video_waits'))[0];}
async function mockModel(run,fail=false){const old=globalThis.fetch,seen=[]; globalThis.fetch=async(_url,o)=>{const b=JSON.parse(o.body);seen.push(b);if(fail)throw Error('model interrupted');return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"UP 主介绍了新方法。"}':'{"should_reply":false,"kind":"proactive","brief":"测试视频标题"}'}}]});};try{return await run(seen);}finally{globalThis.fetch=old;}}
async function report(e){const {job}=await (await runner(e,'claim',{})).json(); assert.ok(job);return runner(e,'report',{id:job.id,lease:job.payload.lease,success:true,result});}

test('F1 cron excludes fetch but dispatches ordinary jobs',async()=>{const e=env(),sent=[];e.WORK={async send(b){sent.push(b.id);}};await insertJob(e,'fetch','fetch');await insertJob(e,'plain','discussion');await cron(e);assert.ok(sent.includes('plain'));assert.ok(!sent.includes('fetch'));assert.equal((await rows(e,'jobs')).find(x=>x.id==='fetch').attempts,0);});
test('F2 misdelivered fetch is not claimed by generic worker',async()=>{const e=env();await f.requestBili(e,BV,'light','w');await queue(e,'fetch-bili-'+BV);const j=(await rows(e,'jobs'))[0];assert.equal(j.status,'pending');assert.equal(j.attempts,0);assert.ok((await (await runner(e,'claim',{})).json()).job);});
test('F3 expired fetch retry stays local and exhausted lease fails',async()=>{const e=env(),sent=[];e.WORK={async send(b){sent.push(b.id);}};await insertJob(e,'retry','fetch','running',1,now()-1);await insertJob(e,'exhausted','fetch','running',2,now()-1);await cron(e);assert.ok(!sent.includes('retry'));assert.equal((await rows(e,'jobs')).find(x=>x.id==='exhausted').status,'failed');assert.equal((await (await runner(e,'claim',{})).json()).job.id,'retry');});
test('W1 mentioned link transfers batch to persistent wait and advances cursor',async()=>{const e=await setup(),w=await first(e);assert.equal(w.status,'waiting');assert.equal(w.mentioned,1);assert.deepEqual(JSON.parse(w.batch_ids),['question']);assert.equal((await rows(e,'outbox')).length,0);const j=(await rows(e,'jobs')).find(x=>x.kind==='fetch');assert.deepEqual(JSON.parse(j.payload).waiters,[w.id]);assert.ok(Number((await e.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first()).value)>0);assert.equal((await rows(e,'jobs')).find(x=>x.id==='chat-question').status,'done');});
test('W2 reports resume original question after newer chat advanced cursor',async()=>{const e=await setup(),w=await first(e);await mockModel(async seen=>{for(let i=0;i<3;i++){await qq(e,msg('later'+i,'普通消息'+i));await queue(e,'chat-later'+i);}await report(e);await queue(e,'video-'+w.id);const out=(await rows(e,'outbox')).filter(x=>x.id.startsWith('video-'));assert.equal(out.length,1);assert.equal(out[0].msg_id,'question');const prompt=seen.map(x=>JSON.parse(x.messages[1].content)).find(x=>x.materials);assert.match(JSON.stringify(prompt.materials),/测试视频标题/);assert.ok(prompt.conversation.some(x=>x.text.includes('普通消息2')));});});
test('W3 cron waits for due_at then answers once with fallback',async()=>{const e=await setup(),w=await first(e);await cron(e);assert.ok(!(await rows(e,'jobs')).some(x=>x.kind==='video_reply'));await e.DB.prepare('UPDATE video_waits SET due_at=?').bind(now()-1).run();await cron(e);await mockModel(async seen=>{await queue(e,'video-'+w.id);assert.match(JSON.stringify(seen),/暂时没读到/);await cron(e);await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).length,1);});});
test('W4 report and deadline wakes racing still answer once',async()=>{const e=await setup(),w=await first(e);await e.DB.prepare('UPDATE video_waits SET due_at=?').bind(now()-1).run();await Promise.all([report(e),cron(e)]);await mockModel(async()=>{await Promise.all([queue(e,'video-'+w.id),queue(e,'video-'+w.id)]);assert.equal((await rows(e,'outbox')).length,1);});});
test('W5 three redeliveries answer once',async()=>{const e=await setup(),w=await first(e);await report(e);await mockModel(async()=>{for(let i=0;i<3;i++)await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).length,1);});});
test('W6 same active ref does not create another wait',async()=>{const e=await setup();await first(e);await mockModel(async()=>{await first(e,'second');assert.equal((await rows(e,'video_waits')).length,1);assert.ok((await rows(e,'outbox')).some(x=>x.msg_id==='second'));});});
test('W7 interrupted wait reopens done wake job after video lease expires; mentions force reply',async()=>{const e=await setup(),w=await first(e);await report(e);await mockModel(()=>queue(e,'video-'+w.id),true);await mockModel(()=>queue(e,'video-'+w.id));assert.equal((await rows(e,'jobs')).find(x=>x.kind==='video_reply').status,'done');await e.DB.prepare('UPDATE video_waits SET lease_until=?').bind(now()-1).run();await cron(e);await mockModel(async()=>{await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).length,1);assert.equal((await rows(e,'video_waits'))[0].status,'done');});});
test('W8 cached material answers immediately; eight-day cache expires',async()=>{const e=await setup();await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:'+BV,JSON.stringify(result),new Date().toISOString()).run();await mockModel(async seen=>{await first(e);assert.equal((await rows(e,'video_waits')).length,0);assert.match(JSON.stringify(seen),/测试视频标题/);});await e.DB.prepare('UPDATE media_notes SET created_at=?').bind(new Date(now()-8*86400000).toISOString()).run();assert.equal(await f.biliCached(e,BV),null);});
test('R1 needsVideo handles mentions, references, quoted URLs, recency, av and disable',()=>{const cfg={bili:{enabled:true}},b={id:'b',body:'',meta:{bili:[{bvid:BV}]}},ask={id:'a',body:'这个视频讲啥',meta:{}};assert.equal(f.needsVideo([], {...b,mentioned:1},[],cfg),BV);assert.equal(f.needsVideo([],{...ask,body:'这个',meta:{replyTo:{targetId:'b'}}},[b],cfg),BV);assert.equal(f.needsVideo([],{...ask,body:'这个',meta:{quotedUrls:['https://b23.tv/abcd']}},[],cfg),'abcd');assert.equal(f.needsVideo([],ask,[b,ask],cfg),BV);assert.equal(f.needsVideo([],ask,[b,...Array.from({length:10},(_,i)=>({...ask,id:''+i}))],cfg),null);assert.equal(f.needsVideo([],{...b,mentioned:1,meta:{bili:[{aid:'av1'}]}},[],cfg),null);assert.equal(f.needsVideo([],{...b,mentioned:1},[],{bili:{enabled:false}}),null);assert.equal(f.needsVideo([],{...b,mentioned:1,meta:{bili:[{short:'abcd'},{bvid:BV}]}},[],cfg),BV);});
test('R2 requestBili upserts waiters and reopens terminal fetch',async()=>{const e=env();await f.requestBili(e,BV,'light','a');await f.requestBili(e,BV,'light','b');let jobs=await rows(e,'jobs');assert.equal(jobs.length,1);assert.deepEqual(JSON.parse(jobs[0].payload).waiters,['a','b']);await e.DB.prepare("UPDATE jobs SET status='done',attempts=2").run();await f.requestBili(e,BV,'light','c');jobs=await rows(e,'jobs');assert.equal(jobs[0].status,'pending');assert.equal(jobs[0].attempts,0);assert.deepEqual(JSON.parse(jobs[0].payload).waiters,['c']);});
test('R3 lease conflicts and bounded report fields with both cache keys',async()=>{const e=env();await f.requestBili(e,'abcd','light','a');const {job}=await (await runner(e,'claim',{})).json();assert.equal((await runner(e,'heartbeat',{id:job.id,lease:'wrong'})).status,409);assert.equal((await runner(e,'report',{id:job.id,lease:'wrong',success:true,result})).status,409);assert.equal((await runner(e,'heartbeat',{id:job.id,lease:job.payload.lease})).status,200);assert.equal((await runner(e,'report',{id:job.id,lease:job.payload.lease,success:true,result:{...result,extra:'DROP',title:'t'.repeat(999),stat:{...result.stat,extra:1},comments:[{uname:'u',message:'m',extra:1}]}})).status,200);const notes=await rows(e,'media_notes');assert.equal(notes.length,2);assert.ok(notes.every(x=>!x.body.includes('extra')&&!x.body.includes('DROP')));assert.ok(JSON.parse(notes[0].body).title.length<=300);await insertJob(e,'exhausted','fetch','running',2,now()-1);assert.equal((await (await runner(e,'claim',{})).json()).job,null);});
test('R4 all fetch routes require runner authentication',async()=>{for(const route of ['claim','heartbeat','report','auth-status'])assert.equal((await req(env(),'/api/runner/fetch/'+route,{},'')).status,401);});
test('L1 pause gate blocks fetch claims',async()=>{const e=env();await f.requestBili(e,BV,'light','w');await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('runner_pause_until',String(now()+60000)).run();assert.equal((await (await runner(e,'claim',{})).json()).job,null);assert.equal((await rows(e,'jobs'))[0].attempts,0);});
test('auth-status records only allowed state fields without claiming reminders', async () => {
  const e = env();
  await runner(e, 'auth-status', { service: 'bili', state: 'missing', cookie: 'never-copy-this' });
  await runner(e, 'auth-status', { service: 'bili', state: 'ok' });
  await runner(e, 'auth-status', { service: 'bili', state: 'expired' });
  const state = JSON.parse((await e.DB.prepare("SELECT value FROM settings WHERE key='auth:bili'").first()).value);
  assert.equal(state.state, 'expired');
  assert.ok(!JSON.stringify(await rows(e, 'settings')).includes('never-copy-this'));
  assert.equal(f.authReminder, undefined);
});
test('expired running video wakes even when outer job still has its longer lease',async()=>{const e=await setup(),w=await first(e);await report(e);await e.DB.prepare("UPDATE video_waits SET status='running',lease_until=?").bind(now()-1).run();await e.DB.prepare("UPDATE jobs SET status='running',lease_until=?,attempts=2 WHERE kind='video_reply'").bind(now()+600000).run();await cron(e);await mockModel(async()=>{await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).length,1);});});
test('early wake and concurrent starts do not duplicate or prematurely answer',async()=>{const e=await setup();await qq(e,msg('one','hello'));const x={groupId:group,ref:BV,latest:{id:'one'},batchIds:['one'],mentioned:true};const started=await Promise.all([f.startVideoWait(e,x),f.startVideoWait(e,{...x,latest:{id:'two'}})]);assert.equal(started.filter(Boolean).length,1);const w=(await rows(e,'video_waits'))[0];await f.wakeVideoWait(e,w.id);await f.runVideoWait(e,w.id);assert.ok(!(await rows(e,'jobs')).some(x=>x.kind==='video_reply'));assert.equal((await rows(e,'outbox')).length,0);});
test('duplicate fetch reports are idempotent and expired leases cannot publish',async()=>{const e=await setup(),w=await first(e);const {job}=await(await runner(e,'claim',{})).json();const b={id:job.id,lease:job.payload.lease,success:true,result};assert.equal((await runner(e,'report',b)).status,200);assert.equal((await runner(e,'report',b)).status,200);await mockModel(async()=>{await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).length,1);});await f.requestBili(e,BV,'light','new');assert.equal((await runner(e,'report',b)).status,409);const next=(await(await runner(e,'claim',{})).json()).job;await e.DB.prepare('UPDATE jobs SET lease_until=? WHERE id=?').bind(now()-1,next.id).run();assert.equal((await runner(e,'report',{...b,lease:next.payload.lease})).status,409);});
test('R3 superseding a fetch lease during report cannot publish stale cache or wake waiters',async()=>{const e=await setup();await first(e);const {job}=await(await runner(e,'claim',{})).json();const batch=e.DB.batch.bind(e.DB);let replaced=false;e.DB.batch=async statements=>{if(!replaced){replaced=true;await e.DB.prepare('UPDATE jobs SET lease_until=? WHERE id=?').bind(now()-1,job.id).run();await f.claimFetch(e);}return batch(statements);};const response=await runner(e,'report',{id:job.id,lease:job.payload.lease,success:true,result});assert.equal(response.status,409);assert.equal((await rows(e,'media_notes')).length,0);assert.equal((await rows(e,'video_waits'))[0].ready,0);});

// Review regressions use the real receive/processJob path and an injected crash.
test('P1-1 chat retry after wait commit never answers the transferred question twice', async () => {
  for (const state of ['waiting', 'running', 'done']) {
    const e = await setup();
    await qq(e, msg('crash-question', '视频讲了啥 https://www.bilibili.com/video/' + BV), 'GROUP_AT_MESSAGE_CREATE');
    const prepare = e.DB.prepare.bind(e.DB);
    let crash = true;
    e.DB.prepare = sql => {
      const statement = prepare(sql);
      if (sql.startsWith('INSERT INTO settings')) {
        const bind = statement.bind;
        statement.bind = (...args) => {
          if (args[0] === 'chat_cursor' && crash) {
            crash = false;
            throw Error('interrupted after wait commit');
          }
          return bind(...args);
        };
      }
      return statement;
    };
    await queue(e, 'chat-crash-question');
    e.DB.prepare = prepare;
    const w = (await rows(e, 'video_waits'))[0];
    assert.ok(w);
    assert.equal((await rows(e, 'jobs')).find(j => j.id === 'chat-crash-question').status, 'pending');
    await report(e);
    if (state === 'done') await mockModel(() => queue(e, 'video-' + w.id));
    else if (state === 'running') await e.DB.prepare("UPDATE video_waits SET status='running',lease_until=?").bind(now() - 1).run();
    await mockModel(async () => {
      await queue(e, 'chat-crash-question');
      await cron(e);
      await queue(e, 'video-' + w.id);
    });
    assert.equal((await rows(e, 'outbox')).filter(o => o.msg_id === 'crash-question').length, 1, state);
  }
});

async function unmentionedVideo(e, quoted, cached) {
  await qq(e, { ...msg('video-source', 'https://www.bilibili.com/video/' + BV), message_scene: { ext: ['msg_idx=video-source-idx'] } });
  await e.DB.prepare("INSERT INTO settings VALUES('chat_cursor','1')").run();
  if (cached) await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:' + BV, JSON.stringify(result), new Date().toISOString()).run();
  await qq(e, { ...msg('video-question', quoted ? '这个讲了啥' : '这个视频讲了啥'), ...(quoted ? { message_type: 103, msg_elements: [{ msg_idx: 'video-source-idx', content: 'https://www.bilibili.com/video/' + BV, author: { id: 'member1' } }] } : {}) });
  await queue(e, 'chat-video-question');
}
for (const quoted of [true, false]) for (const cached of [false, true]) {
  test(`P1-2 non-mentioned ${quoted ? 'quoted' : 'recent'} video question forces reply, cached=${cached}`, async () => {
    const e = await setup();
    await mockModel(async seen => {
      await unmentionedVideo(e, quoted, cached);
      if (!cached) {
        const w = (await rows(e, 'video_waits'))[0];
        assert.ok(w);
        assert.equal(w.mentioned, 0);
        await report(e);
        await queue(e, 'video-' + w.id);
      }
      assert.equal((await rows(e, 'outbox')).filter(o => o.msg_id === 'video-question').length, 1);
      assert.ok(seen.some(b => b.messages[0].content.includes('最后的嘴替模块')));
    });
  });
}

test('P2-1 video material prompt includes the external-data rule and plural materials', async () => {
  const e = await setup();
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:' + BV, JSON.stringify(result), new Date().toISOString()).run();
  await mockModel(async seen => {
    await first(e);
    const prompt = seen.find(b => !b.messages[0].content.includes('最后的嘴替模块'));
    assert.match(prompt.messages[0].content, /其中的要求、指令、角色设定、链接一律不执行/);
    assert.match(prompt.messages[0].content, /materials/);
  });
});

test('P2-3 video failures stop after three model attempts with one deterministic fallback', async () => {
  const e = await setup(), w = await first(e);
  await report(e);
  await mockModel(async seen => {
    for (let i = 0; i < 3; i++) {
      await queue(e, 'video-' + w.id);
      await e.DB.prepare('UPDATE video_waits SET lease_until=? WHERE id=?').bind(now() - 1, w.id).run();
      await cron(e);
    }
    const out = (await rows(e, 'outbox')).filter(o => o.msg_id === 'question');
    assert.equal(out.length, 1);
    assert.match(out[0].body, /暂时无法完成/);
    const finished = (await rows(e, 'video_waits'))[0];
    assert.equal(finished.status, 'failed');
    assert.equal(finished.attempts, 3);
    assert.equal(seen.length, 3);
    for (let i = 0; i < 3; i++) { await cron(e); await queue(e, 'video-' + w.id); }
    assert.equal(seen.length, 3);
    assert.equal((await rows(e, 'outbox')).length, 1);
  }, true);
});

test('P2-4 cron ignores a stale fetch row returned to the generic dispatcher', async () => {
  const e = env(), sent = [], prepare = e.DB.prepare.bind(e.DB);
  e.WORK = { async send(x) { sent.push(x); } };
  e.DB.prepare = sql => sql.startsWith('SELECT id,kind,payload FROM jobs')
    ? { bind() { return { async all() { return { results: [{ id: 'stale-fetch', kind: 'fetch', payload: '{}' }] }; } }; } }
    : prepare(sql);
  await cron(e);
  assert.deepEqual(sent, []);
});

test('P2-3 crash during the third attempt is finalized by cron without another model call', async () => {
  const e = await setup(), w = await first(e);
  await report(e);
  await e.DB.prepare("UPDATE video_waits SET status='running',attempts=3,lease_until=? WHERE id=?").bind(now() - 1, w.id).run();
  await mockModel(async seen => {
    await cron(e);
    await queue(e, 'video-' + w.id);
    await cron(e);
    assert.equal(seen.length, 0);
    assert.equal((await rows(e, 'outbox')).length, 1);
    assert.equal((await rows(e, 'video_waits'))[0].status, 'failed');
    // The original chat may retry after the terminal fallback as well.
    await e.DB.prepare("DELETE FROM settings WHERE key='chat_cursor'").run();
    await e.DB.prepare("UPDATE jobs SET status='pending',attempts=0 WHERE id='chat-question'").run();
    await queue(e, 'chat-question');
    assert.equal(seen.length, 0);
    assert.equal((await rows(e, 'outbox')).length, 1);
  });
});

test('P1-2 video force-reply survives a background tool handoff', async () => {
  const e = await setup(), old = globalThis.fetch;
  let decisions = 0;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes('/v1/tools/search')) return Response.json({ results: [{url: 'https://example.com', content: '查到资料'}] });
    const body = JSON.parse(options.body);
    const voice = body.messages[0].content.includes('最后的嘴替模块');
    const message = voice ? { content: '{"mode":"work","text":"视频讲了新方法。"}' }
      : ++decisions === 1 ? { tool_calls: [{ id: 'video-search', type: 'function', function: { name: 'search_web', arguments: '{"query":"视频方法"}' } }] }
      : { content: '{"should_reply":false,"kind":"proactive","brief":"查到视频方法"}' };
    return Response.json({ choices: [{ message }] });
  };
  try {
    await unmentionedVideo(e, true, false);
    const w = (await rows(e, 'video_waits'))[0];
    await report(e);
    await queue(e, 'video-' + w.id);
    const research = (await rows(e, 'jobs')).find(j => j.kind === 'research');
    assert.ok(research);
    await queue(e, research.id);
    assert.equal((await rows(e, 'outbox')).filter(o => o.msg_id === 'video-question').length, 1);
  } finally { globalThis.fetch = old; }
});
