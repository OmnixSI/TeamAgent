import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {env,worker,req,qq,msg} from './support.mjs';
const outfile=`.wrangler/fastlinks-budget-${process.pid}.mjs`;
await build({stdin:{contents:'export {metered,left,COST} from "./src/d1"; export {stage,flushTail} from "./src/timing"; export {fragments} from "./src/voice"; export {fetcherSeen} from "./src/login-flow";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const {metered,left,COST,stage,flushTail,fragments,fetcherSeen}=await import('../'+outfile);
const counts={};function save(){mkdirSync('.agent',{recursive:true});writeFileSync('.agent/fastlinks-counts.json',JSON.stringify(counts,null,2));}
async function measured(base,label,run){const e=metered(base),before=base.DB.executed;await run(e);const used=e.meter.used;assert.equal(used,base.DB.executed-before,label);assert.ok(used<=48,label+' '+used);counts[label]=used;save();return used;}
const queue=(e,id)=>worker.queue({messages:[{body:{id},ack(){}}]},e);
const stages=e=>e.DB.prepare('SELECT * FROM stage_timings ORDER BY at').all().then(x=>x.results);
test('P0a stage is memory-only and five points flush as one SQL execution',async()=>{
 const base=env(),e=metered(base),before=base.DB.executed;for(let i=0;i<5;i++)stage(e,'t','model_start',{kind:'chat'});
 assert.equal(base.DB.executed,before);await flushTail(e);assert.equal(e.meter.used,1);assert.equal((await stages(base)).length,5);assert.equal(e.tail.timing.length,0);
});
test('P0a tail is shared through shallow environments and gives cache the final query',async()=>{
 const base=env(),e=metered(base);assert.equal({...e}.tail,e.tail);assert.equal(COST.prefetch,1);
 e.tail.cache.push(['msgref:v1:source',JSON.stringify({ref:'BV1xx411c7mD',match:'id'}),new Date().toISOString()]);stage({...e},'source','outbox');e.meter.used=47;
 const before=base.DB.executed;await flushTail({...e});assert.equal(e.meter.used,48);assert.equal(base.DB.executed-before,1);assert.equal((await stages(base)).length,0);assert.ok(await base.DB.prepare("SELECT id FROM media_notes WHERE id='msgref:v1:source'").first());
});
test('R8-4 P0a zero tail budget drops msgref without a query or error',async()=>{
 const base=env(),e=metered(base);e.meter.used=48;e.tail.cache.push(['msgref:v1:no-budget','{}',new Date().toISOString()]);stage(e,'t','sent');const before=base.DB.executed;
 await flushTail(e);assert.equal(base.DB.executed,before);assert.equal(e.tail.cache.length,0);assert.equal(e.tail.timing.length,0);
});
test('P0a tail bounds timing binds to ninety and cache binds to twenty-four',async()=>{
 const base=env(),e=metered(base),prepare=e.DB.prepare.bind(e.DB);const bindings=[];
 e.DB.prepare=sql=>{const s=prepare(sql),bind=s.bind;s.bind=(...args)=>{bindings.push(args.length);assert.ok(args.length<=90);return bind(...args);};return s;};
 for(let i=0;i<40;i++){stage(e,'t','model_start');e.tail.cache.push(['resource:v1:x:status:'+i,'{}',new Date().toISOString()]);}for(let i=0;i<3;i++)e.tail.cache.push(['msgref:v1:'+i,'{}',new Date().toISOString()]);await flushTail(e);assert.deepEqual(bindings,[24,88]);assert.equal((await stages(base)).length,22);assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM media_notes WHERE id LIKE 'resource:%'").first()).n,5);assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM media_notes WHERE id LIKE 'msgref:%'").first()).n,3);
});
test('P0a failed timing writes cannot fail a reply or retain buffers',async()=>{
 const base=env(),e=metered(base);stage(e,'t','sent');e.DB.prepare=()=>{throw Error('synthetic timing failure');};await assert.doesNotReject(()=>flushTail(e));assert.equal(e.tail.timing.length,0);
});
test('P0a schema and registered migration are idempotent',()=>{
 const d=new DatabaseSync(':memory:');for(let i=0;i<2;i++){d.exec(readFileSync('schema.sql','utf8'));d.exec(readFileSync('migrations/0003_stage_timings.sql','utf8'));}assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='stage_timings_turn'").get());assert.ok(readFileSync('scripts/migrate.mjs','utf8').includes('migrations/0003_stage_timings.sql'));
});
const voice=JSON.stringify({mode:'banter',text:'先看画面中的标志。\n\n再核对原消息的语境。'});
async function imageFixture(){const e=env();e.QQ_APP_ID='fastlinks-budget';await req(e,'/api/admin/bind',{groupId:'GROUP000001'});await qq(e,{...msg('reference','引用问题'),message_scene:{ext:['msg_idx=FAST-REF']}});
 let id;for(let i=0;i<100;i++)if(fragments(voice,'chat-v-fast-image-'+i).length===2){id='fast-image-'+i;break;}assert.ok(id);
 await qq(e,{...msg(id,'纠正负责人是小王'),message_scene:{ext:['msg_idx=FAST-IMAGE','ref_msg_idx=FAST-REF']},attachments:[0,1,2].map(i=>({content_type:'image/png',url:'https://multimedia.nt.qq.com.cn/fast-'+i+'.png',width:64,height:64}))},'GROUP_AT_MESSAGE_CREATE');return {e,id};}
test('P0a three images, a reference and both segments send before the timing tail',async()=>{
 const {e,id}=await imageFixture(),old=globalThis.fetch,sent=[];let active;globalThis.fetch=async(target,opt)=>{
 const u=String(target);if(u.endsWith('.png'))return new Response(new TextEncoder().encode(u),{headers:{'content-type':'image/png'}});if(u.includes('getAppAccessToken'))return Response.json({access_token:'fake',expires_in:300});
 const b=JSON.parse(opt.body);if(!b.messages){sent.push(b);assert.equal(active.tail.timing.filter(r=>r.turn===id&&r.stage==='sent').length,sent.length-1,'tail is still in memory while sending');return Response.json({id:'ok',ext_info:{ref_idx:'FAST-BOT-'+sent.length}});}
 return Response.json({choices:[{message:{content:b.reasoning_effort==='none'?'{"desc":"图片资料","text":"","tags":[],"meme":false}':b.messages[0].content.includes('最后的嘴替模块')?voice:JSON.stringify({action:'reply',kind:'direct',target:'reference',brief:'按实际资料回复'})}}]});};
 try{await measured(e,'P0a-B3-image',x=>{active=x;return queue(x,'chat-'+id);});await measured(e,'P0a-B3-answer',x=>{active=x;return queue(x,'chat-v-'+id);});assert.equal(sent.length,2);assert.ok(sent[0].message_reference);const points=(await stages(e)).filter(r=>r.turn_id===id);for(const name of ['chat_claimed','model_start','model_end','outbox','sent'])assert.ok(points.some(r=>r.stage===name),name);assert.equal(points.filter(r=>r.stage==='sent').length,2);}finally{globalThis.fetch=old;}
});

test('P0a unserializable optional timing is dropped without throwing',async()=>{
 const e=metered(env()),extra={};extra.self=extra;stage(e,'t','model_start',extra);await assert.doesNotReject(()=>flushTail(e));assert.equal(e.tail.timing.length,0);
});

async function modelFixture(run,toolCalls){
 const old=globalThis.fetch,state={sent:[],models:0,tools:[]};
 globalThis.fetch=async(target,opt)=>{
  const u=String(target);if(u.includes('getAppAccessToken'))return Response.json({access_token:'test-token',expires_in:300});
  const b=JSON.parse(opt.body);if(u.includes('api.bot.qq.com/')){state.sent.push(b);return Response.json({id:'sent-'+state.sent.length});}
  assert.ok(u.endsWith('/chat/completions'),u);
  if(b.messages[0].content.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:voice}}]});
  for(const m of b.messages)if(m.role==='tool')state.tools.push(JSON.parse(m.content));
  const calls=toolCalls?.(++state.models);return Response.json({choices:[{message:calls?{role:'assistant',tool_calls:calls}:{content:'{"action":"reply","kind":"direct","brief":"按实际资料回答"}'}}]});
 };
 try{return await run(state);}finally{globalThis.fetch=old;}
}
const videoResult={bvid:'BV1xx411c7mD',title:'真实视频',desc:'简介',owner:'UP主',tname:'科技',duration:10,pubdate:1,stat:{},subtitle:'字幕资料',subtitle_lang:'zh-CN',subtitle_status:'ok',comments:[],tier:'light',fetched_at:new Date().toISOString()};
function splitId(prefix){for(let i=0;i<100;i++){const id='fast-bili-'+i;if(fragments(voice,prefix+id).length===2)return id;}throw Error('no split fixture');}
test('P0a video wait, claim, report, reply and cached follow-up have correlated timing within budget',async()=>{
 const base=env(),id=splitId('video-vw-');base.QQ_APP_ID='fast-bili-lifecycle';await req(base,'/api/admin/bind',{groupId:'GROUP000001'});
 await qq(base,msg(id,'这个视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'),'GROUP_AT_MESSAGE_CREATE');
 await measured(base,'P0a-bili-wait',e=>queue(e,'chat-'+id));
 assert.ok((await stages(base)).some(r=>r.turn_id===id&&r.stage==='bili_wait_start'));
 let job;await measured(base,'P0a-fetch-claim',async e=>{const r=await req(e,'/api/runner/fetch/claim',{},'runner-secret');assert.equal(r.status,200);job=(await r.json()).job;assert.ok(job);});
 await measured(base,'P0a-fetch-report',async e=>{const r=await req(e,'/api/runner/fetch/report',{id:job.id,lease:job.payload.lease,success:true,result:videoResult},'runner-secret');assert.equal(r.status,200);});
 const points=await stages(base);for(const name of ['fetch_claimed','fetch_reported','wait_woken'])assert.ok(points.some(r=>r.turn_id===id&&r.stage===name),name);
 await modelFixture(async state=>{await measured(base,'P0a-video-reply',e=>queue(e,'video-vw-'+id));assert.equal(state.sent.length,2);});
 const cached=splitId('chat-');await qq(base,msg(cached,'再看这个 https://www.bilibili.com/video/BV1xx411c7mD'),'GROUP_AT_MESSAGE_CREATE');
 await modelFixture(async state=>{await measured(base,'P0a-bili-cache-hit',e=>queue(e,'chat-'+cached));assert.equal(state.sent.length,2);});
 assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='fetch'").first()).n,1);
 assert.ok(!(await stages(base)).some(r=>r.turn_id===cached&&r.stage==='fetch_claimed'));
});
test('P0a a rejected fetch lease never publishes a reported stage',async()=>{
 const base=env(),before=(await stages(base)).length;
 await measured(base,'P0a-fetch-lease-rejected',async e=>{const r=await req(e,'/api/runner/fetch/report',{id:'missing',lease:'stale',success:true,result:videoResult},'runner-secret');assert.equal(r.status,409);});
 assert.equal((await stages(base)).length,before);
});
test('R8-4 P0a dropped msgref leaves the existing get_work_status media query usable',async()=>{
 const base=env(),drop=metered(base);drop.meter.used=48;drop.tail.cache.push(['msgref:v1:status-source','{}',new Date().toISOString()]);await flushTail(drop);
 await req(base,'/api/admin/bind',{groupId:'GROUP000001'});await qq(base,msg('status-source','查看真实工作状态'));
 await base.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('fast-status','research',JSON.stringify({latestId:'status-source',batchIds:['status-source'],mentioned:true,background:true}),Date.now()).run();
 await modelFixture(async state=>{await measured(base,'P0a-research-work-status',e=>queue(e,'fast-status'));assert.ok(state.tools.some(t=>Array.isArray(t.tasks)&&Array.isArray(t.materials)));},n=>n===1?[{id:'status',type:'function',function:{name:'get_work_status',arguments:JSON.stringify({source_id:'status-source'})}}]:null);
});
test('P0a thrown processJob failure does not flush or acknowledge',async()=>{
 const base=env(),e=metered(base),prepare=e.DB.prepare.bind(e.DB);let acked=0;stage(e,'failed','chat_claimed');
 e.DB.prepare=sql=>{if(sql.startsWith("UPDATE jobs SET status=") && sql.includes("RETURNING *"))throw Error('synthetic claim failure');return prepare(sql);};
 await assert.rejects(()=>worker.queue({messages:[{body:{id:'fail'},ack(){acked++;}}]},e),/synthetic claim failure/);assert.equal(acked,0);assert.equal(e.tail.timing.length,1);assert.equal((await stages(base)).length,0);
});
test('P0a fetcherSeen still counts one query but only updates after thirty seconds',async()=>{
 const base=env(),old=Date.now;let now=1800000000000;Date.now=()=>now;
 try{await measured(base,'P0a-heartbeat-insert',e=>fetcherSeen(e));now+=29000;await measured(base,'P0a-heartbeat-no-write',e=>fetcherSeen(e));assert.equal((await base.DB.prepare("SELECT value FROM settings WHERE key='fetcher:last-seen'").first()).value,'1800000000000');now+=1001;await measured(base,'P0a-heartbeat-write',e=>fetcherSeen(e));assert.equal((await base.DB.prepare("SELECT value FROM settings WHERE key='fetcher:last-seen'").first()).value,String(now));}finally{Date.now=old;}
});
test('P0a cron removes seven-day-old timing only on minute zero',async()=>{
 const NativeDate=Date,base=env();let at=Date.UTC(2026,10,12,3,1);class Clock extends NativeDate{constructor(...args){super(args.length?args[0]:at);}static now(){return at;}}
 await base.DB.prepare('INSERT INTO stage_timings VALUES(?,?,?,?)').bind('old','sent',at-8*86400000,null).run();await base.DB.prepare('INSERT INTO stage_timings VALUES(?,?,?,?)').bind('new','sent',at,null).run();
 globalThis.Date=Clock;
 try{let pending;await measured(base,'P0a-cron-minute-one',async e=>{await worker.scheduled({},e,{waitUntil(p){pending=p;}});await pending;});assert.equal((await stages(base)).length,2);at-=60000;await measured(base,'P0a-cron-minute-zero',async e=>{await worker.scheduled({},e,{waitUntil(p){pending=p;}});await pending;});assert.deepEqual((await stages(base)).map(r=>r.turn_id),['new']);}finally{globalThis.Date=NativeDate;}
});
test('P0a research handoff stays durable and records its source turn',async()=>{
 const base=env(),id=splitId('chat-');base.QQ_APP_ID='fast-handoff';await req(base,'/api/admin/bind',{groupId:'GROUP000001'});await qq(base,msg(id,'请读这个 https://example.com/doc'),'GROUP_AT_MESSAGE_CREATE');
 await modelFixture(async state=>{await measured(base,'P0a-research-handoff',e=>queue(e,'chat-'+id));assert.equal(state.sent.length,2);},n=>n===1?[{id:'read',type:'function',function:{name:'read_web',arguments:'{"url":"https://example.com/doc"}'}}]:null);
 assert.ok(await base.DB.prepare('SELECT id FROM jobs WHERE id=?').bind('research-'+id).first());assert.ok((await stages(base)).some(r=>r.turn_id===id&&r.stage==='research_queued'));assert.ok(!(await stages(base)).some(r=>r.stage==='inline_read'));
});
test('P0a a multi-message delivery flushes each source buffer without losing earlier stages',async()=>{
 const base=env();await req(base,'/api/admin/bind',{groupId:'GROUP000001'});
 for(const id of ['notice-one','notice-two']){await qq(base,msg(id,'实际状态'));await base.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind(id,'voice_notice',JSON.stringify({message:id,status:'只说实际结果'}),Date.now()).run();}
 const prepare=base.DB.prepare.bind(base.DB),events=[];base.DB.prepare=sql=>{if(sql.startsWith("UPDATE jobs SET status=") && sql.includes("RETURNING *"))events.push('claim');if(sql.startsWith('INSERT INTO stage_timings'))events.push('tail');return prepare(sql);};
 await modelFixture(()=>worker.queue({messages:['notice-one','notice-two'].map(id=>({body:{id},ack(){events.push('ack');}}))},base));
 assert.deepEqual(events,['claim','tail','ack','claim','ack','tail']);const points=await stages(base);
 for(const id of ['notice-one','notice-two'])for(const name of ['model_start','model_end','outbox'])assert.ok(points.some(r=>r.turn_id===id&&r.stage===name),id+' '+name);
});

test('P0b batch statements count individually, including a no-op update',async()=>{
 const base=env();await measured(base,'P0b-batch-probe',async e=>{
  const before=e.meter.used;await e.DB.batch([
   e.DB.prepare("INSERT INTO settings VALUES('budget:a','1')"),
   e.DB.prepare("INSERT INTO settings VALUES('budget:b','2')"),
   e.DB.prepare("UPDATE settings SET value='unused' WHERE key='missing'"),
  ]);assert.equal(e.meter.used-before,3);
 });
});
test('P0b failure report, fixed video reply and cached repeat stay within budget without model calls',async()=>{
 const base=env();await req(base,'/api/admin/bind',{groupId:'GROUP000001'});
 await qq(base,msg('fail-budget','这个视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'),'GROUP_AT_MESSAGE_CREATE');
 await queue(base,'chat-fail-budget');const {job}=await(await req(base,'/api/runner/fetch/claim',{},'runner-secret')).json();
 await measured(base,'P0b-failure-report',async e=>{assert.equal((await req(e,'/api/runner/fetch/report',{id:job.id,lease:job.payload.lease,proto:2,success:false,reason:'risk',retryAfter:600},'runner-secret')).status,200);});
 await modelFixture(async state=>{
  await measured(base,'P0b-failed-video-reply',e=>queue(e,'video-vw-fail-budget'));assert.equal(state.models,0);
  await qq(base,msg('cached-failure','这个视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'),'GROUP_AT_MESSAGE_CREATE');
  await measured(base,'P0b-fail-cache-reply',e=>queue(e,'chat-cached-failure'));assert.equal(state.models,0);
 });
 assert.equal((await base.DB.prepare('SELECT COUNT(*) n FROM video_waits').first()).n,1);
 assert.equal((await base.DB.prepare("SELECT status FROM jobs WHERE id='fetch-bili-BV1xx411c7mD'").first()).status,'failed');
 const out=(await base.DB.prepare('SELECT body FROM outbox').all()).results;assert.equal(out.length,2);for(const row of out)assert.match(row.body,/B 站这次拦住了读取/);
});
test('P0b offline short-circuit stays within budget with no wait, fetch or model',async()=>{
 const base=env();await req(base,'/api/admin/bind',{groupId:'GROUP000001'});
 await base.DB.prepare("INSERT INTO settings VALUES('fetcher:last-seen',?)").bind(String(Date.now()-130000)).run();
 await qq(base,msg('offline-budget','这个视频讲了啥 https://www.bilibili.com/video/BV1xx411c7mD'),'GROUP_AT_MESSAGE_CREATE');
 await modelFixture(async state=>{await measured(base,'P0b-offline-reply',e=>queue(e,'chat-offline-budget'));assert.equal(state.models,0);});
 assert.equal((await base.DB.prepare('SELECT COUNT(*) n FROM video_waits').first()).n,0);
 assert.equal((await base.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='fetch'").first()).n,0);
 assert.match((await base.DB.prepare('SELECT body FROM outbox').first()).body,/读取端暂时离线/);
});
