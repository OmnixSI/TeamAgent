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
    assert.equal(imageEnv.meter.used,base.DB.executed-before);
    assert.equal(visionCalls,1);assert.equal(decisions,0);
    assert.equal(await base.DB.prepare("SELECT value FROM settings WHERE key='chat_cursor'").first(),null);
    assert.equal((await base.DB.prepare('SELECT COUNT(*) n FROM chat_decisions').first()).n,0);
    assert.ok(await base.DB.prepare("SELECT id FROM jobs WHERE id='chat-v-image-turn' AND status='pending'").first());
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
const quoteOut=`.wrangler/quote-p1-${process.pid}.mjs`;
await build({entryPoints:['src/quote.ts'],bundle:true,format:'esm',platform:'browser',outfile:quoteOut});
const quotes=await import('../'+quoteOut);
const voiceOut=`.wrangler/voice-p1-${process.pid}.mjs`;
await build({entryPoints:['src/voice.ts'],bundle:true,format:'esm',platform:'browser',outfile:voiceOut});
const {enqueueVoice,messageSequence}=await import('../'+voiceOut);
test('Q1 quote target honors batch membership, latest position and speaker count',()=>{
  const a={id:'a',sender:'u',mentioned:1},b={id:'b',sender:'u',mentioned:0},base={latestId:'b',batch:[a,b],mentioned:false,groupNewestId:'b'};
  assert.equal(quotes.decideQuote({...base,target:'b'}),null);assert.equal(quotes.decideQuote({...base,target:'a'}),'a');
  assert.equal(quotes.decideQuote({...base,target:'b',batch:[a,{...b,sender:'v'}]}),'b');
  assert.equal(quotes.decideQuote({...base,target:'outside',mentioned:true}),'a');assert.equal(quotes.decideQuote(base),null);
});
test('Q2f status classification only permits reference fallback for JSON 400/422',()=>{
  const cases=[[200,{id:'ok'},'ok'],[400,{code:1},'maybe_ref'],[422,{},'maybe_ref'],[400,undefined,'other'],[403,{},'other'],[429,{},'other'],[503,{},'other'],[0,undefined,'other']];
  for(const [status,body,expected] of cases)assert.equal(quotes.quoteOutcome(status,body),expected,status);
});
let quoteFixture=0;
async function outgoing(count=1,reference=true){
  const e=env();e.QQ_APP_ID='quote-test-'+(++quoteFixture);
  await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('source','GROUP000001','U1','原始问题',new Date().toISOString(),1,0).run();
  for(let i=0;i<count;i++)await enqueueVoice(e,'out-'+i,'GROUP000001','source','{"mode":"work","text":"可核验的回复。"}',reference?{reference:'REF'}:undefined);
  return e;
}
async function deliver(e,reply){
  const old=globalThis.fetch,bodies=[];
  globalThis.fetch=async(url,options)=>{
    if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake-qq-token',expires_in:300});
    const body=JSON.parse(options.body);bodies.push(body);return reply(body,bodies.length);
  };
  try{await queue(e,'nonexistent-job');return bodies;}finally{globalThis.fetch=old;}
}
const setting=(e,key)=>e.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first().then(r=>r?.value);
test('Q2 rejected reference retries once without it and increments sequence and failure counter',async()=>{
  const e=await outgoing(),bodies=await deliver(e,(_b,n)=>n===1?Response.json({code:123},{status:400}):Response.json({id:'sent'}));
  assert.equal(bodies.length,2);assert.deepEqual(bodies[0].message_reference,{message_id:'REF'});assert.equal(bodies[1].message_reference,undefined);
  assert.equal(bodies[1].msg_seq,bodies[0].msg_seq+1);assert.equal(await setting(e,'quote_fail'),'1');
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='out-0'").first()).status,'sent');
});
test('Q2b three confirmed reference failures disable subsequent references in the same send',async()=>{
  const e=await outgoing(4),bodies=await deliver(e,b=>b.message_reference?Response.json({code:123},{status:400}):Response.json({id:'sent'}));
  assert.equal(bodies.length,7);assert.equal(bodies[6].message_reference,undefined);assert.equal(await setting(e,'off:quote'),'1');assert.equal(await setting(e,'quote_fail'),'3');
  assert.ok((await e.DB.prepare("SELECT * FROM activity WHERE kind='quote.disabled'").all()).results.length);
});
test('Q2c successful reference resets the consecutive failure counter',async()=>{
  const e=await outgoing();await e.DB.prepare("INSERT INTO settings VALUES('quote_fail','2')").run();
  const bodies=await deliver(e,()=>Response.json({id:'sent',ext_info:{ref_idx:'new-bot-ref'}}));
  assert.equal(bodies.length,1);assert.equal(await setting(e,'quote_fail'),'0');
  assert.ok(await e.DB.prepare("SELECT * FROM message_refs WHERE ref_idx='new-bot-ref'").first());
});
test('Q2d non-reference errors and malformed responses never trigger another QQ message',async()=>{
  for(const mode of [429,500,401,403,'network','bad-json']){
    const e=await outgoing();await e.DB.prepare("INSERT INTO settings VALUES('quote_fail','2')").run();
    const bodies=await deliver(e,()=>{if(mode==='network')throw Error('offline');return mode==='bad-json'?new Response('not-json',{status:400}):Response.json({code:123},{status:mode});});
    assert.equal(bodies.length,1,String(mode));assert.equal(await setting(e,'quote_fail'),'2');
    const state=(await e.DB.prepare("SELECT status FROM outbox WHERE id='out-0'").first()).status;
    assert.equal(state,[500,'network','bad-json'].includes(mode)?'unknown':'failed',String(mode));
  }
});
test('Q2e failure after dropping the reference does not count as a reference fault',async()=>{
  const e=await outgoing();await e.DB.prepare("INSERT INTO settings VALUES('quote_fail','2')").run();
  const bodies=await deliver(e,()=>Response.json({code:123},{status:400}));
  assert.equal(bodies.length,2);assert.equal(await setting(e,'quote_fail'),'2');
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id='out-0'").first()).status,'failed');
});
test('Q3 runtime quote switch and absent reference mappings avoid reference metadata',async()=>{
  const e=env(),context={latest:{id:'b',group_id:'g'},batch:[{id:'a',sender:'u',mentioned:1},{id:'b',sender:'v'}],groupNewestId:'b'};
  let before=e.DB.executed;assert.equal(await quotes.quoteRef(e,{target:'a'},context,{'off:quote':'1'}),undefined);assert.equal(e.DB.executed-before,0);
  assert.equal(await quotes.quoteRef(e,{target:'a'},context,{}),undefined);
  await e.DB.prepare('INSERT INTO message_refs VALUES(?,?,?,?,?)').bind('member-ref','member','a','g',Date.now()).run();
  assert.equal(await quotes.quoteRef(e,{target:'a'},context,{}),'member-ref');
  const out=await outgoing();await out.DB.prepare("INSERT INTO settings VALUES('off:quote','1')").run();
  const bodies=await deliver(out,()=>Response.json({id:'ok'}));assert.equal(bodies[0].message_reference,undefined);
});
test('Q4 ordinary message fields and the passive 240-second boundary stay unchanged',async()=>{
  const e=await outgoing(1,false),bodies=await deliver(e,()=>Response.json({id:'ok'}));
  assert.deepEqual(bodies[0],{content:'可核验的回复。',msg_type:0,msg_id:'source',msg_seq:messageSequence('out-0')});
  const old=await outgoing(1,false);await old.DB.prepare('UPDATE messages SET ts=?').bind(new Date(Date.now()-241000).toISOString()).run();
  const older=await deliver(old,()=>Response.json({id:'ok'}));assert.equal(older[0].msg_id,undefined);
});
test('quote metadata is wired from a model-selected member message in the real chat path',async()=>{
  const e=await bound();
  await qq(e,{...msg('earlier','前面的具体问题'),message_scene:{ext:['msg_idx=EARLIER-REF']}});
  await qq(e,{...msg('current','回答上面那条'),author:{id:'member2'}},'GROUP_AT_MESSAGE_CREATE');
  await decide({action:'reply',kind:'direct',target:'earlier',brief:'回复前面的具体问题'},()=>queue(e,'chat-current'));
  const row=await e.DB.prepare("SELECT json FROM outbox_meta WHERE id='chat-current'").first();
  assert.deepEqual(JSON.parse(row.json),{reference:'EARLIER-REF'});
});

// B2: fixed snapshot measured by the reviewer on f16c96d, not an old-code execution.
const BASELINE_F16C96D = 45;
const {writeFileSync,mkdirSync}=await import('node:fs');
const {fragments}=await import('../'+voiceOut);
const splitVoice=JSON.stringify({mode:'banter',text:'先看画面中的标志。\n\n再核对原消息的语境。'});
function traceDB(e){
  const prepare=e.DB.prepare.bind(e.DB),trace=[];
  e.DB.prepare=sql=>{
    const wrap=s=>({sql,bind(...a){return wrap(s.bind(...a));},...Object.fromEntries(['first','all','run'].map(k=>[k,async(...a)=>{trace.push(sql);return s[k](...a);}]))});
    return wrap(prepare(sql));
  };
  return trace;
}
async function measured(base,label,run){
  const trace=traceDB(base),before=base.DB.executed,e=metered(base);
  try{await run(e);}finally{
    mkdirSync('.agent',{recursive:true});writeFileSync('.agent/'+label+'.json',JSON.stringify({used:e.meter.used,executed:base.DB.executed-before,sql:trace},null,2));
  }
  assert.equal(e.meter.used,base.DB.executed-before,label+' meter agrees with the database');
  return e.meter.used;
}
async function imageBudgetFixture(){
  const base=await bound();base.QQ_APP_ID='budget-'+(++quoteFixture);
  await qq(base,{...msg('budget-reference','引用的问题'),message_scene:{ext:['msg_idx=BUDGET-REF']}});
  let id;for(let i=0;i<100;i++)if(fragments(splitVoice,'chat-v-budget-image-'+i).length===2){id='budget-image-'+i;break;}
  assert.ok(id);await qq(base,{...msg(id,'纠正负责人是小王'),author:{id:'member2'},message_scene:{ext:['msg_idx=BUDGET-IMAGE','ref_msg_idx=BUDGET-REF']},attachments:[0,1,2].map(i=>({content_type:'image/png',url:'https://example.com/budget-'+i+'.png',width:64,height:64}))},'GROUP_AT_MESSAGE_CREATE');
  return {base,id};
}
async function budgetModel(run,{calls,voice=splitVoice}={}){
  const old=globalThis.fetch,state={vision:0,decisions:0,requests:[],sent:[]};
  globalThis.fetch=async(url,init)=>{
    if(String(url).endsWith('.png'))return new Response(new TextEncoder().encode(String(url)),{headers:{'content-type':'image/png'}});
    if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake-budget-token',expires_in:300});
    const b=JSON.parse(init.body);
    if(!b.messages){state.sent.push(b);return Response.json({id:'qq-'+state.sent.length,ext_info:{ref_idx:'BOT-'+state.sent.length}});}
    let message;
    if(b.reasoning_effort==='none'){state.vision++;message={content:'{"desc":"图像资料","text":"","tags":[],"meme":false}'};}
    else if(b.messages[0].content.includes('最后的嘴替模块'))message={content:voice};
    else{state.decisions++;state.requests.push(structuredClone(b));message=calls?calls(state.decisions,b):{content:'{"action":"reply","kind":"direct","target":"budget-reference","brief":"具体问题"}'};}
    return Response.json({choices:[{message}]});
  };
  try{return await run(state);}finally{globalThis.fetch=old;}
}
test('B3 three cold images, a reference and two sent segments fit both phases',async()=>{
  assert.equal(BASELINE_F16C96D,45);
  const {base,id}=await imageBudgetFixture();
  await budgetModel(async state=>{
    const image=await measured(base,'p1-B3-image',e=>queue(e,'chat-'+id));
    const answer=await measured(base,'p1-B3-answer',e=>queue(e,'chat-v-'+id));
    assert.equal(state.vision,3);assert.equal(state.decisions,1);assert.equal(state.sent.length,2);
    assert.ok(state.sent[0].message_reference);assert.ok(image<=30,'image '+image);assert.ok(answer<=44,'answer '+answer);
  });
});
function correctionCalls(source){return [0,1,2].map(i=>({id:'remember-'+i,type:'function',function:{name:'remember_correction',arguments:JSON.stringify({repo:'team',subject:'budget-'+i,predicate:'owner',value:'小王',source_id:source,quote:'纠正负责人是小王',supersedes_ids:Array.from({length:8},(_,j)=>'old-'+j)})}}));}
test('B4 heavy tools in the image reply cannot exhaust the D1 invocation',async()=>{
  const {base,id}=await imageBudgetFixture();
  // P2 is excluded. A pending ~s segment exercises the same outbox-row budget.
  await budgetModel(async state=>{
    assert.ok(await measured(base,'p1-B4-image',e=>queue(e,'chat-'+id))<=30);
    await base.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('previous~s','GROUP000001',id,'表情段占位','pending',Date.now()).run();
    const answer=await measured(base,'p1-B4-answer',e=>queue(e,'chat-v-'+id));
    assert.ok(answer<=48,'answer '+answer);
    const results=state.requests.flatMap(b=>b.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)));
    assert.ok(results.some(r=>r.unavailable&&r.reason==='本轮资源已用完，请再发一条消息继续'));
    assert.ok((await base.DB.prepare("SELECT COUNT(*) n FROM facts WHERE id LIKE 'correction:%'").first()).n<3);
  },{calls:n=>n===1?{tool_calls:correctionCalls(id)}:{content:'{"action":"reply","kind":"direct","target":"budget-reference","brief":"依据已完成部分作答"}'}});
});
test('B5 research with three tools per round withholds tools on the last model request',async()=>{
  const base=await bound();await qq(base,msg('budget-research','查看团队工作状态'));
  await base.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('budget-research-job','research',JSON.stringify({latestId:'budget-research',batchIds:['budget-research'],mentioned:true,background:true}),Date.now()).run();
  await budgetModel(async state=>{
    const count=await measured(base,'p1-B5-research',e=>queue(e,'budget-research-job'));
    assert.equal(state.requests.length,3);assert.equal(state.requests.at(-1).tools,undefined);assert.ok(count<=48,'research '+count);
  },{calls:n=>n<3?{tool_calls:[0,1,2].map(i=>({id:'status-'+n+'-'+i,type:'function',function:{name:'get_work_status',arguments:'{}'}}))}:{content:'{"action":"reply","kind":"direct","brief":"当前状态"}'},voice:'{"mode":"work","text":"当前工作状态。"}'});
});
test('B7 scheduled bounds an expired/ready backlog and leaves durable work for later calls',async()=>{
  const base=await outgoing(5,false);
  for(const status of ['running','waiting'])for(let i=0;i<20;i++)await base.DB.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,status,due_at,ready,lease_until,created_at,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(status+i,'GROUP000001','BV1xx411c7mD','source','["source"]',0,status,Date.now()-1,1,Date.now()-1,Date.now(),status==='running'?3:0).run();
  const counts=[];
  await budgetModel(async()=>{
    for(let i=0;i<4;i++){
      counts.push(await measured(base,'p1-B7-cron-'+i,e=>cron(e)));
      if(i===0){
        assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE status='running'").first()).n,15);
        assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='video_reply'").first()).n,5);
      }
      // Consume the durable wakes as their separate queue invocations would.
      const jobs=(await base.DB.prepare("SELECT id FROM jobs WHERE kind='video_reply' AND status='pending'").all()).results;
      for(const j of jobs)assert.ok(await measured(base,'p1-B7-wake-'+i+'-'+j.id,e=>queue(e,j.id))<=48);
    }
  });
  assert.ok(counts.every(n=>n<=48),'cron '+counts.join(','));
  assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE status='running'").first()).n,0);
  assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='video_reply'").first()).n,20);
  assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM outbox WHERE id LIKE 'out-%' AND status='sent'").first()).n,5);
});
test('B6 fetch report and each of three original video questioners stay below budget',async()=>{
  const base=await bound();base.QQ_APP_ID='budget-video-'+(++quoteFixture);
  for(let i=0;i<3;i++){
    await qq(base,{...msg('budget-video-'+i,'视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'),author:{id:'video-user-'+i}},'GROUP_AT_MESSAGE_CREATE');
    assert.ok(await measured(base,'p1-B6-handoff-'+i,e=>queue(e,'chat-budget-video-'+i))<=48);
  }
  const claimed=await(await req(base,'/api/runner/fetch/claim',{},'runner-secret')).json();assert.ok(claimed.job);
  const result={bvid:'BV1xx411c7mD',title:'预算测试视频',desc:'简介',owner:'UP',tname:'科技',duration:60,pubdate:1,stat:{},subtitle:null,comments:[],fetched_at:new Date().toISOString()};
  const report=await measured(base,'p1-B6-report',async e=>assert.equal((await req(e,'/api/runner/fetch/report',{id:claimed.job.id,lease:claimed.job.payload.lease,success:true,result},'runner-secret')).status,200));
  assert.ok(report<=48);
  await budgetModel(async state=>{
    for(let i=0;i<3;i++)assert.ok(await measured(base,'p1-B6-reply-'+i,e=>queue(e,'video-vw-budget-video-'+i))<=48);
    assert.equal(state.sent.length,3);
  },{voice:'{"mode":"work","text":"只依据视频简介作答，未读到字幕。"}'});
  assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE status='done'").first()).n,3);
});
test('B8 newer unmentioned message between image and answer coalesces without a second decision',async()=>{
  const base=await bound();await qq(base,{...msg('budget-old-image','图片是什么'),attachments:[{content_type:'image/png',url:'https://example.com/phase.png',width:64,height:64}]});
  await budgetModel(async state=>{
    await queue(base,'chat-budget-old-image');assert.equal(state.vision,1);assert.equal(state.decisions,0);
    await qq(base,msg('budget-new-message','再看看这个问题'));
    await queue(base,'chat-v-budget-old-image');assert.equal(state.decisions,0);
    await queue(base,'chat-budget-new-message');assert.equal(state.decisions,1);assert.equal(state.vision,1);
    await queue(base,'chat-v-budget-old-image');assert.equal(state.decisions,1);
  },{voice:'{"mode":"work","text":"合并后的回答。"}'});
});
test('budget guards leave a low-budget send and sweep durable; reference fuse costs ten including switches',async()=>{
  const sendBase=await outgoing(),low=metered(sendBase,10);
  const bodies=await deliver(low,()=>Response.json({id:'sent'}));
  assert.equal(bodies.length,0);assert.equal(low.meter.used,2);
  assert.equal((await sendBase.DB.prepare("SELECT status FROM outbox WHERE id='out-0'").first()).status,'pending');
  const fuseBase=await outgoing();await fuseBase.DB.prepare("INSERT INTO settings VALUES('quote_fail','2')").run();
  let before=fuseBase.DB.executed;const fuse=metered(fuseBase);
  await deliver(fuse,b=>b.message_reference?Response.json({code:1},{status:422}):Response.json({id:'sent',ext_info:{ref_idx:'FUSE-BOT'}}));
  assert.equal(fuse.meter.used,fuseBase.DB.executed-before);assert.equal(fuse.meter.used-2,10);assert.equal(COST.send_row,10);
  assert.equal(await setting(fuseBase,'off:quote'),'1');
  const out=`.wrangler/sweep-budget-${process.pid}.mjs`;
  await build({entryPoints:['src/fetchjobs.ts'],bundle:true,format:'esm',platform:'browser',outfile:out});
  const {sweepVideoWaits}=await import('../'+out),base=env();
  for(let i=0;i<8;i++)await base.DB.prepare('INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,status,due_at,ready,lease_until,created_at,attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind('limited'+i,'g','BV1xx411c7mD','m','["m"]',0,'running',0,1,0,0,3).run();
  const sweep=metered(base);sweep.meter.used=38;await sweepVideoWaits(sweep);assert.equal(sweep.meter.used,47);
  assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM video_waits WHERE status='failed'").first()).n,3);
});

test('synthetic timing corpus uses production views and hides acceptable actions from model input',async()=>{
  const {loadTimingRuntime,timingInput,runTimingEvaluation}=await import('../scripts/evaluate-timing.mjs');
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/timing-synthetic.json',import.meta.url),'utf8')),runtime=await loadTimingRuntime();
  assert.equal(fixture.cases.length,60);
  const counts=Object.fromEntries([...new Set(fixture.cases.map(x=>x.category))].map(c=>[c,fixture.cases.filter(x=>x.category===c).length]));
  assert.deepEqual(counts,{mention:10,member_chat:10,laughter:8,unfinished:8,open_question:8,unanswered:6,quote_bot:4,ended:6});
  let called=0;
  const report=await runTimingEvaluation({fixture,runtime,complete:async(messages,scene)=>{
    called++;const input=timingInput(runtime,fixture.snapshot,scene);
    assert.deepEqual(messages,runtime.participationMessages(input));
    const data=JSON.parse(messages[1].content);
    for(const key of ['acceptable','category','previousDecision'])assert.equal(data[key],undefined);
    assert.ok(data.conversation.length);assert.equal(data.context.latest.id,scene.messages.at(-1).id);
    return JSON.stringify({action:scene.acceptable[0],kind:'direct',brief:'虚构测试输出',wait_seconds:15});
  }});
  assert.equal(called,54);assert.equal(report.synthetic.total,60);assert.equal(report.synthetic.pass,60);assert.equal(report.rules.pass,report.rules.total);assert.ok(report.passed);
});
test('synthetic timing gate fails on a wrong action and rules-only never claims model acceptance',async()=>{
  const {loadTimingRuntime,runTimingEvaluation}=await import('../scripts/evaluate-timing.mjs');
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/timing-synthetic.json',import.meta.url),'utf8')),runtime=await loadTimingRuntime();
  const bad=await runTimingEvaluation({fixture,runtime,complete:async()=>'not json'});
  assert.ok(!bad.passed);assert.ok(bad.synthetic.pass<54);assert.equal(bad.rules.pass,bad.rules.total);
  const rules=await runTimingEvaluation({fixture,runtime});
  assert.equal(rules.synthetic.status,'not_run');assert.equal(rules.synthetic.pass,null);assert.ok(!rules.passed);
});
test('P1 policy keeps its existing paragraphs and replaces only the two output-contract sentences',()=>{
  const policy=JSON.parse(readFileSync(new URL('../config/participation.json',import.meta.url),'utf8')).text;
  assert.ok(policy.includes('action:"reply"|"wait"|"stop"'));assert.ok(policy.includes('wait_seconds:15'));
  assert.ok(policy.includes('拿不准就选stop'));assert.ok(policy.includes('被@或被引用时只能reply'));
  assert.ok(!policy.includes('输出JSON {should_reply:'));
});
test('timing CLI is offline in rules-only mode, writes private results and fails without an injected key',async()=>{
  const {spawnSync}=await import('node:child_process'),{statSync,existsSync}=await import('node:fs');
  const output=`.agent/p1-cli-rules-${process.pid}.json`,missing=`.agent/p1-cli-no-key-${process.pid}.json`;
  const cli=args=>spawnSync(process.execPath,['scripts/evaluate-timing.mjs',...args],{cwd:process.cwd(),env:{PATH:process.env.PATH},encoding:'utf8'});
  const rules=cli(['--rules-only','--output',output]);assert.equal(rules.status,0,rules.stderr);
  const result=JSON.parse(readFileSync(output,'utf8'));assert.equal(result.rules.pass,4);assert.equal(result.passed,false);assert.equal(result.synthetic.status,'not_run');
  assert.equal(statSync(output).mode&0o777,0o600);
  const absent=cli(['--output',missing]);assert.equal(absent.status,1);assert.equal(existsSync(missing),false);
  assert.ok(!absent.stderr.includes('Bearer'));assert.ok(!absent.stderr.includes('sk-'));
});
test('P2-1 unparseable oldest timestamp cannot starve an older queued message',async()=>{
  const e=await bound();
  await qq(e,{...msg('invalid-oldest','问题的开头'),timestamp:'not-a-date'});
  await qq(e,msg('invalid-middle','还有一个补充'));await qq(e,msg('invalid-newest','最后一句'));
  await withAnswer(async seen=>{
    await queue(e,'chat-invalid-middle');
    const decisions=seen.filter(b=>!b.messages[0].content.includes('最后的嘴替模块'));
    assert.equal(decisions.length,1);
    assert.deepEqual(JSON.parse(decisions[0].messages[1].content).conversation.map(v=>v.id),['invalid-oldest','invalid-middle','invalid-newest']);
  });
  assert.equal(await setting(e,'chat_cursor'),'3');
});

test('Codex P1 unmentioned explicit assignment survives the unanswered-proactive gate',async()=>{
  const e=await seedHard();await qq(e,msg('unmentioned-assignment','帮我整理成文档'));
  await decide(n=>n===1?{tool_calls:[{id:'file',type:'function',function:{name:'create_file_task',arguments:JSON.stringify({source_id:'unmentioned-assignment',request_quote:'帮我整理成文档',title:'整理文档',instructions:'把当前原话整理成文档'})}}]}:{content:'{"action":"reply","kind":"direct","brief":"已创建文件整理任务"}'},async state=>{
    const route=metered(e),beforeRoute=e.DB.executed;
    await queue(route,'chat-unmentioned-assignment');
    assert.equal(route.meter.used,e.DB.executed-beforeRoute);assert.ok(route.meter.used<=48);
    const research=await e.DB.prepare("SELECT id FROM jobs WHERE id='research-unmentioned-assignment'").first();assert.ok(research,'explicit assignment must reach the existing tool flow');
    const work=metered(e),beforeWork=e.DB.executed;await queue(work,research.id);
    assert.equal(work.meter.used,e.DB.executed-beforeWork);assert.ok(work.meter.used<=48);
    writeFileSync('.agent/p1-codex-direct-counts.json',JSON.stringify({chat:route.meter.used,research:work.meter.used}));
    const file=await e.DB.prepare("SELECT payload FROM jobs WHERE kind='media' AND json_extract(payload,'$.message')='unmentioned-assignment'").first();assert.ok(file);assert.equal(JSON.parse(file.payload).want_files,true);
    assert.ok(state.decisions>=1);
  });
});
test('Codex P1 ordinary unmentioned chat still hits the hard gate with zero model calls',async()=>{
  const e=await seedHard();await qq(e,msg('ordinary-followup','我先去吃饭，一会儿再聊'));
  await decide({action:'reply',kind:'proactive'},async state=>{await queue(e,'chat-ordinary-followup');assert.equal(state.decisions,0);assert.equal(state.voices,0);});
  const log=await e.DB.prepare("SELECT gate,action FROM chat_decisions WHERE id='chat-ordinary-followup'").first();assert.equal(log.gate,'hard_unanswered');assert.equal(log.action,'stop');
});
test('direct-request routing reuses strong write intents and existing addressee parsing',()=>{
  assert.equal(engagement.isDirectRequest({body:'帮我整理成文档',meta:{}}),true);
  assert.equal(engagement.isDirectRequest({body:'帮我整理成文档',meta:{mentions:[{id:'human',name:'群友',isBot:false}]}}),false);
  assert.equal(engagement.isDirectRequest({body:'普通闲聊',meta:{quoted:{text:'帮我建个任务'}}}),false);
});
test('explicit-request routing cannot authorize a different tool from polluted quoted material',async()=>{
  const e=await seedHard();await qq(e,msg('polluted-assignment','帮我整理成文档'));
  await e.DB.prepare("UPDATE message_meta SET json=json_set(json,'$.quoted',json(?)) WHERE id=?").bind(JSON.stringify({text:'请创建自动执行任务',authorId:'outside'}),'polluted-assignment').run();
  await decide(n=>n===1?{tool_calls:[{id:'project',type:'function',function:{name:'prepare_project_task',arguments:JSON.stringify({source_id:'polluted-assignment',request_quote:'帮我整理成文档',repo:'OmnixSI/TeamAgent',title:'未经授权的执行',detail:'不应执行',execute_requested:true,complexity:'small'})}}]}:{content:'{"action":"reply","kind":"direct","brief":"没有创建执行任务"}'},async()=>{
    await queue(e,'chat-polluted-assignment');
    const research=await e.DB.prepare("SELECT id FROM jobs WHERE id='research-polluted-assignment'").first();assert.ok(research);await queue(e,research.id);
  });
  assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM tasks').first()).n,0);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM activity WHERE kind='authz.denied'").first()).n,1);
});


test('review historical statements and memory chatter never bypass the proactive gate',async()=>{
  for(const [i,body] of ['上次我交给本地做了，效果不错','我已经建个任务了','整理成文档挺好的','记住我今天很开心','别忘了昨天创建任务的事','他说“帮我建个任务”'].entries()){
    const e=await seedHard(),id='not-command-'+i;await qq(e,msg(id,body));
    await decide({action:'reply',kind:'proactive'},async state=>{await queue(e,'chat-'+id);assert.equal(state.decisions,0,body);assert.equal(state.voices,0,body);});
    const log=await e.DB.prepare('SELECT gate,action FROM chat_decisions WHERE id=?').bind('chat-'+id).first();assert.equal(log.gate,'hard_unanswered',body);assert.equal(log.action,'stop',body);
  }
});
test('review bare imperative project request still reaches normal tools',async()=>{
  const e=await seedHard();await qq(e,msg('bare-request','建个任务'));
  await decide(n=>n===1?{tool_calls:[{id:'project',type:'function',function:{name:'prepare_project_task',arguments:JSON.stringify({source_id:'bare-request',request_quote:'建个任务',repo:'OmnixSI/TeamAgent',title:'明确交办',detail:'只处理现在的请求',execute_requested:true,complexity:'small'})}}]}:{content:'{"action":"reply","kind":"direct","brief":"已建任务"}'},async state=>{
    await queue(e,'chat-bare-request');
    const research=await e.DB.prepare("SELECT id FROM jobs WHERE id='research-bare-request'").first();assert.ok(research);await queue(e,research.id);assert.ok(state.decisions>=1);
  });
  assert.equal((await e.DB.prepare("SELECT status FROM tasks WHERE source_id='bare-request'").first()).status,'queued');
});


test('Codex unmentioned clean development request reaches tools after proactive speech',async()=>{
  const e=await seedHard(),body='帮我修复 WhalePartner 的登录错误';await qq(e,msg('development-request',body));
  await decide(n=>n===1?{tool_calls:[{id:'dev',type:'function',function:{name:'prepare_project_task',arguments:JSON.stringify({source_id:'development-request',request_quote:body,repo:'OmnixSI/WhalePartner',title:'登录错误',detail:'明确交办修复',execute_requested:true,complexity:'small'})}}]}:{content:'{"action":"reply","kind":"direct","brief":"已建任务"}'},async()=>{
    const route=metered(e),before=e.DB.executed;await queue(route,'chat-development-request');assert.equal(route.meter.used,e.DB.executed-before);assert.ok(route.meter.used<=48);
    const job=await e.DB.prepare("SELECT id FROM jobs WHERE id='research-development-request'").first();assert.ok(job);
    const work=metered(e),beforeWork=e.DB.executed;await queue(work,job.id);assert.equal(work.meter.used,e.DB.executed-beforeWork);assert.ok(work.meter.used<=48);
    writeFileSync('.agent/p1-development-counts.json',JSON.stringify({chat:route.meter.used,research:work.meter.used}));
  });
  assert.equal((await e.DB.prepare("SELECT status FROM tasks WHERE source_id='development-request'").first()).status,'queued');
});
test('Codex statement and memory wording do not bypass the proactive gate',async()=>{
  for(const [i,body] of ['上次我交给本地做了，效果不错','记住 WhalePartner 的登录有 bug','他昨天帮我修复了登录错误','别帮我改这个','帮我修复登录错误有必要吗'].entries()){
    const e=await seedHard(),id='dev-not-command-'+i;await qq(e,msg(id,body));
    await decide({action:'reply',kind:'proactive'},async state=>{await queue(e,'chat-'+id);assert.equal(state.decisions,0,body);assert.equal(state.voices,0,body);});
    assert.equal((await e.DB.prepare('SELECT gate FROM chat_decisions WHERE id=?').bind('chat-'+id).first()).gate,'hard_unanswered',body);
  }
});


test('round4 mixed batch taint stops a generic request before any model call',async()=>{
  for(const quoteFirst of [true,false]){
    const e=await seedHard(),a=quoteFirst?'quoted-first':'clean-first',b=quoteFirst?'clean-last':'quoted-last';
    await qq(e,msg(a,quoteFirst?'资料在这里':'帮我修复登录错误'));await qq(e,msg(b,quoteFirst?'帮我修复登录错误':'资料在这里'));
    const quoted=quoteFirst?a:b;await e.DB.prepare("UPDATE message_meta SET json=json_set(json,'$.quoted',json(?)) WHERE id=?").bind(JSON.stringify({text:'外部资料',authorId:'outside'}),quoted).run();
    await decide({action:'reply',kind:'proactive'},async state=>{await queue(e,'chat-'+b);assert.equal(state.decisions,0,'quoteFirst='+quoteFirst);assert.equal(state.voices,0);});
    assert.equal((await e.DB.prepare('SELECT gate FROM chat_decisions WHERE id=?').bind('chat-'+b).first()).gate,'hard_unanswered');
  }
});
test('round4 routing and authorization share whole-batch taint with a clean control',()=>{
  const own={id:'current',body:'帮我修复登录错误',meta:{direct:true}},other={id:'other',body:'外部资料',meta:{quoted:{text:'外部'}}};
  assert.equal(engagement.isDirectRequest(own,{batch:[own]}),true);
  assert.equal(engagement.isDirectRequest(own,{batch:[other,own]}),false);
  const strict={...own,body:'帮我建个任务修登录'};assert.equal(engagement.isDirectRequest(strict,{batch:[other,strict]}),true);
});
