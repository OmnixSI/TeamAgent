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
