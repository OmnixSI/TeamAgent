import {test} from 'node:test';
import assert from 'node:assert/strict';
import {env} from './support.mjs';

test('B0 batch preserves SELECT and INSERT RETURNING result rows; statements are counted', async () => {
  const e = env(), before = e.DB.executed;
  const result = await e.DB.batch([
    e.DB.prepare('SELECT ? AS value').bind('select'),
    e.DB.prepare('INSERT INTO settings VALUES(?,?) RETURNING key,value').bind('batch-row', 'insert'),
  ]);
  assert.deepEqual(result[0].results.map(r => r.value), ['select']);
  assert.deepEqual(result[1].results.map(r => [r.key, r.value]), [['batch-row', 'insert']]);
  assert.equal(e.DB.executed - before, 2);
  await e.DB.prepare('SELECT key FROM settings').all();
  await e.DB.prepare('SELECT key FROM settings WHERE key=?').bind('batch-row').first();
  await e.DB.prepare('DELETE FROM settings WHERE key=?').bind('batch-row').run();
  assert.equal(e.DB.executed - before, 5);
});

const {build} = await import('esbuild');
const {readFileSync} = await import('node:fs');
const {DatabaseSync} = await import('node:sqlite');
const out = `.wrangler/rhythm-${process.pid}.mjs`;
await build({entryPoints:['src/rhythm.ts'],bundle:true,format:'esm',platform:'browser',outfile:out});
const rhythm = await import('../'+out);

test('R1 debounce prioritizes mentions, bare images, active chat and idle chat',()=>{
  const base={mentioned:false,bareImage:false,humansLast2m:0};
  assert.deepEqual([{...base,mentioned:true},{...base,bareImage:true},{...base,humansLast2m:3},base,{...base,mentioned:true,bareImage:true}].map(x=>rhythm.debounceSeconds(x)),[1,4,3,2,1]);
});
test('R2 processing keeps the newest message, mentions and the eight-second cap',()=>{
  const base={isNewest:false,mentioned:false,oldestPendingAt:0,now:3000};
  assert.deepEqual([{...base,isNewest:true},base,{...base,now:9000},{...base,mentioned:true}].map(x=>rhythm.shouldProcessNow(x)),[true,false,true,true]);
});
test('R3 wait is limited by previous wait, horizon and runtime switch',()=>{
  const base={waited:false,oldestPendingAt:0,now:1000,off:false};
  assert.deepEqual([{...base,waited:true},{...base,now:130000},{...base,off:true},base].map(x=>rhythm.allowWait(x)),[false,false,false,true]);
});
test('R4 parseDecision implements all clamps, forced behavior, legacy and malformed contracts',()=>{
  const parse=(x,o={forced:false,allowWait:true})=>rhythm.parseDecision(typeof x==='string'?x:JSON.stringify(x),o);
  for(const [seconds,expected] of [[100,45],[1,5],[undefined,15],['abc',15]]){
    const d=parse({action:'wait',wait_seconds:seconds});assert.equal(d.action,'wait');assert.equal(d.waitSeconds,expected);
  }
  for(const action of ['stop','wait']){const d=parse({action},{forced:true,allowWait:true});assert.equal(d.action,'reply');assert.equal(d.kind,'direct');}
  assert.equal(parse({action:'wait'},{forced:false,allowWait:false}).action,'stop');
  const legacy=parse({should_reply:true,kind:'proactive'});assert.equal(legacy.action,'reply');assert.equal(legacy.kind,'proactive');
  assert.equal(parse('not json').action,'stop');assert.equal(parse('not json',{forced:true,allowWait:true}).brief,'not json');
  assert.equal(parse('```json\n{"action":"reply"}\n```').action,'reply');assert.equal(parse({action:'maybe'}).action,'stop');
  const d=parse({action:'reply',target:'m',reason:'r'.repeat(100)});assert.equal(d.target,'m');assert.equal(d.reason.length,80);
});
test('G4 hard rule requires an unanswered recent proactive outbox',()=>{
  const r={spoken_kind:'proactive',created_at:100,outbox_id:'o',last_base:'o',n:2,addressed:0};
  for(const row of [null,{...r,spoken_kind:'direct'},{...r,created_at:-1800001},{...r,last_base:'other'},{...r,n:6},{...r,addressed:1}])assert.equal(rhythm.hardRuleHit(row,101),false);
  assert.equal(rhythm.hardRuleHit(r,101),true);
  assert.equal(rhythm.mayBeForced({meta:{replyTo:{kind:'bot'}}},false,false),true);
  assert.equal(rhythm.mayBeForced({meta:{forwarded:[{}]}},false,false),true);
  assert.equal(rhythm.mayBeForced({},false,true),true);
});
test('M1 schema replays without changing positional legacy messages and outbox rows',()=>{
  const db=new DatabaseSync(':memory:');
  try {
    const schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');db.exec(schema);
    db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').run('old','g','u','原话','2026-01-01',0,0);
    db.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').run('old-out','g','old','回复','pending',1);
    db.exec(schema);db.exec(schema);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM messages').get().n,1);assert.equal(db.prepare('SELECT COUNT(*) n FROM outbox').get().n,1);
    for(const name of ['chat_decisions','outbox_meta'])assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
  }finally{db.close();}
});
test('G5 unanswered query ignores sticker segments, uses base text id and reads once',async()=>{
  const e=env();
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('m','g','u','问题',new Date().toISOString(),0,0).run();
  await rhythm.recordDecision(e,{id:'o',group_id:'g',latest_id:'m',batch_ids:['m'],gate:'model',action:'reply',spoken_kind:'proactive',outbox_id:'o',created_at:Date.now()});
  await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('o','g','m','主动发言','sent',Date.now()).run();
  await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('o~s','g','m','[表情]','sent',Date.now()+1).run();
  const before=e.DB.executed;assert.equal(await rhythm.unansweredProactive(e,'g'),true);assert.equal(e.DB.executed-before,1);
  await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('off:wait','1').run();
  const sw=await rhythm.loadSwitches(e);assert.equal(rhythm.isOn(sw,'wait'),false);assert.equal(rhythm.isOn(sw,'quote'),true);
});
const engagementOut=`.wrangler/engagement-p1-${process.pid}.mjs`;
await build({entryPoints:['src/engagement.ts'],bundle:true,format:'esm',platform:'browser',outfile:engagementOut});
const engagement=await import('../'+engagementOut);
test('R5 participation wrapper preserves the legacy boolean interface for three-state decisions',async()=>{
  assert.deepEqual(engagement.participation('{"action":"reply","kind":"proactive","brief":"b"}'),{should_reply:true,kind:'proactive',brief:'b'});
  assert.equal(engagement.participation('{"action":"wait"}').should_reply,false);
  assert.equal(engagement.participation('{"should_reply":true,"kind":"direct"}').should_reply,true);
  assert.equal(engagement.participation('{"action":"stop"}',true).should_reply,true);
  assert.equal(await engagement.maySpeak(env(),{action:'reply'},false,false),true);
});
test('participationMessages preserves the original production request JSON byte for byte',()=>{
  const x={selfNote:'自述',learnedExpressions:[],today:'2026-11-12',projects:[],facts:[],materials:undefined,reflection:'反思',conversation:[{id:'m',text:'hi'}],recentBot:[],alreadyReportedCI:[],context:{latest:{id:'m'},batch:[],mentioned:false,intent:undefined}};
  const old=[{role:'system',content:engagement.PARTICIPATION},{role:'user',content:JSON.stringify(x)}];
  assert.equal(JSON.stringify(engagement.participationMessages(x)),JSON.stringify(old));
  assert.equal(engagement.participationMessages({...x,system:'fixed-old-policy'})[0].content,'fixed-old-policy');
});
const {worker,req,qq,msg,setupWith}=await import('./support.mjs');
const queue=(e,id)=>(e.testWorker||worker).queue({messages:[{body:{id},ack(){}}]},e);
const cron=async e=>{let pending;await(e.testWorker||worker).scheduled({},e,{waitUntil(p){pending=p;}});await pending;};
async function bound(e=env()){await req(e,'/api/admin/bind',{groupId:'GROUP000001'});return e;}
async function withAnswer(run){
  const old=globalThis.fetch,seen=[];
  globalThis.fetch=async(_url,options)=>{
    const b=JSON.parse(options.body);seen.push(b);
    return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"按当前问题回复。"}':'{"should_reply":true,"kind":"direct","brief":"有效问题"}'}}]});
  };
  try{return await run(seen);}finally{globalThis.fetch=old;}
}
test('I1 receive persists notBefore and queue delay; early delivery cannot claim',async()=>{
  const e=await bound(await setupWith({rhythm:{idle:3}}));
  const before=Date.now();await qq(e,msg('delay','正常问题'));
  const j=await e.DB.prepare("SELECT * FROM jobs WHERE id='chat-delay'").first(),payload=JSON.parse(j.payload);
  const sent=e.WORK.sent.find(x=>x.body.id===j.id);assert.deepEqual(sent.opts,{delaySeconds:3});
  assert.ok(payload.notBefore>=before+3000&&payload.notBefore<=Date.now()+3000);
  await queue(e,j.id);
  let state=await e.DB.prepare('SELECT status,attempts FROM jobs WHERE id=?').bind(j.id).first();assert.equal(state.status,'pending');assert.equal(state.attempts,0);
  const real=Date.now;try{Date.now=()=>payload.notBefore+1;await withAnswer(()=>queue(e,j.id));}finally{Date.now=real;}
  state=await e.DB.prepare('SELECT status,attempts FROM jobs WHERE id=?').bind(j.id).first();assert.equal(state.status,'done');assert.equal(state.attempts,1);
});
test('I2 cron excludes future notBefore work and redispatches when due',async()=>{
  const e=env(),due=Date.now()+30000;
  await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('future','discussion',JSON.stringify({notBefore:due}),Date.now()).run();
  await cron(e);assert.ok(!e.WORK.sent.some(x=>x.body.id==='future'));
  const real=Date.now;try{Date.now=()=>due+1;await cron(e);}finally{Date.now=real;}
  assert.ok(e.WORK.sent.some(x=>x.body.id==='future'));
});
test('I3 receive uses mention/idle delays and ignores timestamps that cannot be parsed',async()=>{
  for(const [type,expected] of [['GROUP_AT_MESSAGE_CREATE',1],['GROUP_MESSAGE_CREATE',2]]){
    const e=await bound(await setupWith({rhythm:{mention:1,idle:2,busy:3,image:4}}));
    for(let i=0;i<3;i++)await qq(e,{...msg('old'+i,'旧消息'),timestamp:'not-a-date'});
    await qq(e,msg('new','正常问题'),type);
    assert.equal(e.WORK.sent.find(x=>x.body.id==='chat-new').opts.delaySeconds,expected);
  }
});
test('I4 three fresh messages coalesce to one participation decision',async()=>{
  const e=await bound();for(const id of ['A','B','C'])await qq(e,msg(id,'问题'+id));
  await withAnswer(async seen=>{
    await queue(e,'chat-A');await queue(e,'chat-B');assert.equal(seen.length,0);
    await queue(e,'chat-C');const decisions=seen.filter(b=>!b.messages[0].content.includes('最后的嘴替模块'));assert.equal(decisions.length,1);
    const conversation=JSON.parse(decisions[0].messages[1].content).conversation;
    assert.deepEqual(conversation.map(v=>v.id),['A','B','C']);
  });
});
test('I5 an oldest pending message beyond the cap permits a non-newest job',async()=>{
  const e=await bound();await qq(e,{...msg('A','前半句'),timestamp:new Date(Date.now()-9000).toISOString()});
  await qq(e,msg('B','接着说'));await qq(e,msg('C','最后一句'));
  await withAnswer(async seen=>{await queue(e,'chat-B');assert.equal(seen.filter(b=>!b.messages[0].content.includes('最后的嘴替模块')).length,1);});
  assert.equal((await e.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first()).value,'3');
});
const d1Out=`.wrangler/meter-p1-${process.pid}.mjs`;
await build({entryPoints:['src/d1.ts'],bundle:true,format:'esm',platform:'browser',outfile:d1Out});
const {metered,left,COST}=await import('../'+d1Out);
test('B1/B9 meter counts executions and batch statements exactly; plain env has no limit',async()=>{
  const base=env(),e=metered(base),before=base.DB.executed;
  await e.DB.prepare('SELECT ? AS v').bind('a').first();
  await e.DB.prepare('SELECT 1').all();
  await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('meter','1').run();
  await e.DB.batch([e.DB.prepare('SELECT 1'),e.DB.prepare('SELECT 2'),e.DB.prepare('SELECT 3')]);
  assert.equal(e.meter.used,6);assert.equal(base.DB.executed-before,6);assert.equal(left(e),42);
  assert.equal(left(base),Infinity);
  assert.equal(metered(e),e);
  for(const [key,min] of Object.entries({image:6,turn:2,tool:8,send_row:7,sticker:5,tail:16}))assert.ok(COST[key]>=min,key);
});

test('B8 cold images run in a separate invocation without advancing cursor or deciding',async()=>{
  const base=await bound();
  await qq(base,{...msg('image-turn','这是什么'),attachments:[{content_type:'image/png',url:'https://example.com/one.png',width:64,height:64}]},'GROUP_AT_MESSAGE_CREATE');
  const old=globalThis.fetch;let visionCalls=0,decisions=0;
  globalThis.fetch=async(url,options)=>{
    if(String(url).endsWith('.png'))return new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}});
    const b=JSON.parse(options.body),voice=b.messages[0].content.includes('最后的嘴替模块');
    let content;if(b.reasoning_effort==='none'){visionCalls++;content='{"desc":"图中有红圆","text":"","tags":[],"meme":false}';}
    else if(voice)content='{"mode":"work","text":"图中有红圆。"}';
    else{decisions++;content='{"should_reply":true,"kind":"direct","brief":"红圆"}';}
    return Response.json({choices:[{message:{content}}]});
  };
  try{
    const imageEnv=metered(base),before=base.DB.executed;await queue(imageEnv,'chat-image-turn');
    assert.equal(visionCalls,1);assert.equal(decisions,0);
    assert.equal(await base.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first(),null);
    assert.equal((await base.DB.prepare('SELECT COUNT(*) n FROM chat_decisions').first()).n,0);
    assert.ok(await base.DB.prepare("SELECT id FROM jobs WHERE id='chat-v-image-turn' AND status='pending'").first());
    assert.equal(imageEnv.meter.used,base.DB.executed-before-3);
    const replyEnv=metered(base);await queue(replyEnv,'chat-v-image-turn');
    assert.equal(visionCalls,1);assert.equal(decisions,1);
  }finally{globalThis.fetch=old;}
});
async function decide(action,run,options={}){
  const old=globalThis.fetch,state={decisions:0,vision:0,images:0,voices:0,seen:[]};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('.png')){state.images++;return new Response(new Uint8Array([3,2,1]),{headers:{'content-type':'image/png'}});}
    const b=JSON.parse(init.body);state.seen.push(b);let message;
    if(b.reasoning_effort==='none'){state.vision++;message={content:'{"desc":"图像资料","text":"","tags":[],"meme":false}'};}
    else if(b.messages[0].content.includes('最后的嘴替模块')){state.voices++;message={content:JSON.stringify({mode:'work',text:options.text||'这是当前问题的回答。'})};}
    else{state.decisions++;message=typeof action==='function'?action(state.decisions,b):{content:JSON.stringify(action)};}
    return Response.json({choices:[{message}]});
  };
  try{return await run(state);}finally{globalThis.fetch=old;}
}
async function seedHard(kind='proactive',age=1000){
  const e=await bound();await qq(e,msg('seed','话题开头'));
  await e.DB.prepare("INSERT INTO settings VALUES('chat_cursor','1')").run();
  await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('seed-bot','GROUP000001','seed','主动发言','sent',Date.now()-age).run();
  await rhythm.recordDecision(e,{id:'seed-bot',group_id:'GROUP000001',latest_id:'seed',batch_ids:['seed'],gate:'model',action:'reply',spoken_kind:kind,outbox_id:'seed-bot',created_at:Date.now()-age});
  return e;
}
const imageAttachments=[0,1].map(i=>({content_type:'image/png',url:'https://example.com/hard'+i+'.png',width:64,height:64}));
test('I9/G1 hard unanswered gate skips all models, even for two unseen images',async()=>{
  for(const images of [false,true]){
    const e=await seedHard();await qq(e,msg('one','接着聊'));await qq(e,{...msg('two','这是什么'),...(images?{attachments:imageAttachments}:{})});
    await decide({action:'reply',kind:'proactive'},async state=>{
      await queue(e,'chat-two');assert.equal(state.decisions,0);assert.equal(state.vision,0);assert.equal(state.images,0);
      const d=await e.DB.prepare("SELECT * FROM chat_decisions WHERE id='chat-two'").first();assert.equal(d.gate,'hard_unanswered');assert.equal(d.action,'stop');
      assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM image_notes').first()).n,0);
      assert.equal((await e.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first()).value,'3');
    });
  }
});
test('G2 a video request takes priority over the unanswered gate',async()=>{
  const e=await seedHard();await qq(e,msg('video','这个视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'));
  await decide({action:'stop'},async state=>{
    await queue(e,'chat-video');assert.equal(state.decisions,0);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM video_waits').first()).n,1);
    assert.equal((await e.DB.prepare("SELECT gate FROM chat_decisions WHERE id='chat-video'").first()).gate,'video');
  });
});
test('G3/I11 mentions bypass the gate, describe their image and force a reply',async()=>{
  const e=await seedHard();await qq(e,{...msg('mentioned','这是什么'),attachments:imageAttachments.slice(0,1)},'GROUP_AT_MESSAGE_CREATE');
  const {runChat}=await import('./support.mjs');
  await decide({action:'stop'},async state=>{
    await runChat(e,'chat-mentioned');assert.equal(state.vision,1);assert.equal(state.decisions,1);assert.equal(state.voices,1);
    const d=await e.DB.prepare("SELECT * FROM chat_decisions WHERE latest_id='mentioned'").first();assert.equal(d.action,'reply');assert.equal(d.forced,1);
  });
});
for(const variant of ['six-humans','bot-quote','expired','video-reply','direct'])test('I10 '+variant+' permits a new decision',async()=>{
  const e=await seedHard(variant==='direct'?'direct':'proactive',variant==='expired'?31*60000:1000);
  if(variant==='video-reply')await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('video-other','GROUP000001','seed','视频回复','sent',Date.now()).run();
  const n=variant==='six-humans'?6:2;
  for(let i=0;i<n;i++)await qq(e,msg('human'+i,'新消息'+i));
  if(variant==='bot-quote'){
    const m=JSON.parse((await e.DB.prepare('SELECT json FROM message_meta WHERE id=?').bind('human'+(n-1)).first()).json);m.replyTo={kind:'bot',targetId:'seed-bot'};
    await e.DB.prepare('UPDATE message_meta SET json=? WHERE id=?').bind(JSON.stringify(m),'human'+(n-1)).run();
  }
  await decide({action:'reply',kind:'proactive',brief:'新回应'},async state=>{await queue(e,'chat-human'+(n-1));assert.equal(state.decisions,1);assert.equal(state.voices,1);});
});
test('I6 wait defers without advancing cursor and a second wait becomes stop',async()=>{
  const e=await bound();await qq(e,msg('half','还没说完'));
  await decide({action:'wait',wait_seconds:10},async state=>{
    const before=Date.now();await queue(e,'chat-half');
    assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM outbox').first()).n,0);
    assert.equal(await e.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first(),null);
    const j=await e.DB.prepare("SELECT * FROM jobs WHERE id='chat-wait-half'").first();assert.ok(j);
    const payload=JSON.parse(j.payload);assert.ok(payload.notBefore>=before+10000);assert.equal(payload.waited,true);
    assert.equal((await e.DB.prepare("SELECT action FROM chat_decisions WHERE id='chat-half'").first()).action,'wait');
    const real=Date.now;try{Date.now=()=>payload.notBefore+1;await queue(e,j.id);}finally{Date.now=real;}
    const d=await e.DB.prepare('SELECT * FROM chat_decisions WHERE id=?').bind(j.id).first();assert.equal(d.action,'stop');assert.equal(d.waited,1);
    assert.equal((await e.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first()).value,'1');assert.equal(state.decisions,2);
  });
});
for(const mentioned of [false,true])test('I7/I8 new messages supersede old wait, mentioned='+mentioned,async()=>{
  const e=await bound();await qq(e,msg('half','还有半句'));
  await decide({action:'wait',wait_seconds:10},async()=>{await queue(e,'chat-half');});
  const waiting=await e.DB.prepare("SELECT payload FROM jobs WHERE id='chat-wait-half'").first();
  await qq(e,msg('newer','现在说完了'),mentioned?'GROUP_AT_MESSAGE_CREATE':'GROUP_MESSAGE_CREATE');
  await decide({action:'reply',kind:'direct',brief:'答复'},async state=>{
    await queue(e,'chat-newer');assert.equal(state.decisions,1);
    const real=Date.now;try{Date.now=()=>JSON.parse(waiting.payload).notBefore+1;await queue(e,'chat-wait-half');}finally{Date.now=real;}
    assert.equal(state.decisions,1);assert.equal((await e.DB.prepare("SELECT status FROM jobs WHERE id='chat-wait-half'").first()).status,'done');
  });
});
test('I14 tool handoff and duplicate voice are recorded as tool and dup',async()=>{
  const e=await bound();await qq(e,msg('tool-turn','查最新资料'),'GROUP_AT_MESSAGE_CREATE');
  await decide(()=>({tool_calls:[{id:'search',type:'function',function:{name:'search_web',arguments:'{"query":"资料"}'}}]}),async()=>{
    await queue(e,'chat-tool-turn');assert.equal((await e.DB.prepare("SELECT action FROM chat_decisions WHERE id='chat-tool-turn'").first()).action,'tool');
  });
  const duplicate=await bound();await qq(duplicate,msg('dup-turn','新话题'));
  await duplicate.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('prior','GROUP000001',null,'复读内容','sent',Date.now()).run();
  await decide({action:'reply',kind:'proactive',brief:'复读内容'},async()=>{
    await queue(duplicate,'chat-dup-turn');const d=await duplicate.DB.prepare("SELECT action,outbox_id FROM chat_decisions WHERE id='chat-dup-turn'").first();assert.equal(d.action,'dup');assert.equal(d.outbox_id,null);
  },{text:'复读内容'});
});

const semanticOut=`.wrangler/semantic-rhythm-${process.pid}.mjs`;
await build({entryPoints:['src/semantic.ts'],bundle:true,format:'esm',platform:'browser',outfile:semanticOut});
const {proactiveReply}=await import('../'+semanticOut);
test('I13 non-chat callers never create a repeated chat wait',async()=>{
  const e=await bound();await qq(e,msg('source','普通资料'));
  await decide({action:'wait',wait_seconds:10},async state=>{
    await proactiveReply(e,{source:'source',context:'读资料'},{});
    assert.equal(state.voices,0);
    assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE id LIKE 'chat-wait-%'").first()).n,0);
  });
});
