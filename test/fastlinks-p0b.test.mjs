import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {env,worker,req,qq,msg} from './support.mjs';
const outfile=`.wrangler/fastlinks-p0b-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/linkfail"; export * from "./src/fetchjobs"; export {readUrl,readTweet,understandLinks,agentAnswer} from "./src/semantic"; export {TITLE_FALLBACK} from "./src/bilititle";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile});
const api=await import('../'+outfile);
const forbidden=/cookie|sessdata|bili_jct|jina|deepseek|fetcher|runner|http|token|error|\d{3}/i;
test('B14 all failure text excludes credentials and internal names',()=>{
 assert.equal(api.READ_REASONS.length,10);
 for(const reason of api.READ_REASONS)for(const title of [false,true]){
  for(const text of [api.biliFailReply(reason,{title}),api.biliFailMaterial(reason,{title,titleFallback:api.TITLE_FALLBACK}),api.webFailText(reason)])assert.doesNotMatch(text,forbidden);
 }
});
test('W7 every reason has nonempty Chinese text',()=>{
 for(const reason of api.READ_REASONS){assert.ok(api.webFailText(reason).trim());assert.ok(api.biliFailReply(reason,{title:false}).trim());}
});

const BV='BV1xx411c7mD',group='GROUP000001';
const result={bvid:BV,title:'测试视频标题',desc:'简介',owner:'UP主',tname:'科技',duration:60,pubdate:1,stat:{},subtitle:null,subtitle_status:'none',comments:[],tier:'light',fetched_at:new Date().toISOString()};
const queue=(e,id)=>(e.testWorker||worker).queue({messages:[{body:{id},ack(){}}]},e);
const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(r=>r.results);
const runner=(e,path,b)=>req(e,'/api/runner/fetch/'+path,b,'runner-secret');
async function setup(){const e=env();await req(e,'/api/admin/bind',{groupId:group});return e;}
async function first(e,id='question',mentioned=true,title=false){
 const event=title?{...msg(id,'这个视频讲了啥'),ark_data:{fields:{source:'哔哩哔哩',title:'测试卡片标题'}}}:msg(id,'这个视频讲了啥 https://www.bilibili.com/video/'+BV);
 await qq(e,event,mentioned?'GROUP_AT_MESSAGE_CREATE':'GROUP_MESSAGE_CREATE');await queue(e,'chat-'+id);return (await rows(e,'video_waits')).find(w=>w.latest_id===id);
}
async function mockModel(run){
 const old=globalThis.fetch,seen=[];globalThis.fetch=async(_url,o)=>{const b=JSON.parse(o.body);seen.push(b);return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"只依据现有资料回答。"}':'{"action":"reply","kind":"direct","brief":"只依据现有资料回答"}'}}]});};
 try{return await run(seen);}finally{globalThis.fetch=old;}
}
async function claim(e){const r=await runner(e,'claim',{});assert.equal(r.status,200);const {job}=await r.json();assert.ok(job);return job;}
async function fail(e,reason,retryAfter,extra={}){const job=await claim(e);const r=await runner(e,'report',{id:job.id,lease:job.payload.lease,proto:2,success:false,reason,retryAfter,...extra});assert.equal(r.status,200);return job;}
const failureNote=async(e,ref=BV)=>(await rows(e,'media_notes')).find(r=>r.id===api.FAILURE_PREFIX+ref);
function near(actual,expected){assert.ok(Math.abs(actual-expected)<5000,`${actual} versus ${expected}`);}
async function terminal(e,w,reason,seen,title=false){await queue(e,'video-'+w.id);assert.equal((await rows(e,'outbox')).find(o=>o.id==='video-'+w.id)?.body,api.biliFailReply(reason,{title}));assert.equal((await rows(e,'video_waits')).find(x=>x.id===w.id).status,'done');assert.equal(seen.length,0);}
const seenAt=(e,at)=>e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('fetcher:last-seen',?)").bind(String(at)).run();
async function due(e,w){await e.DB.prepare('UPDATE video_waits SET due_at=? WHERE id=?').bind(Date.now()-1,w.id).run();await api.wakeVideoWait(e,w.id);}

test('B1 mentioned risk persists enum and guarded cache then replies without a model',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'risk',600);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').error,'risk');const n=JSON.parse((await failureNote(e)).body);assert.equal(n.reason,'risk');near(n.until,Date.now()+600000);await terminal(e,w,'risk',seen);});
});
test('B2 cached risk replies immediately without a new wait or resetting fetch',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'risk',600);await terminal(e,w,'risk',seen);await first(e,'again');assert.equal((await rows(e,'video_waits')).length,1);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').status,'failed');assert.equal((await rows(e,'outbox')).find(o=>o.id==='chat-again').body,api.biliFailReply('risk',{title:false}));assert.ok((await rows(e,'chat_decisions')).some(d=>d.gate==='video_fail'&&d.reason==='risk'));assert.equal(seen.length,0);});
});
test('B3 stable not_found failures cache for one hour',async()=>{
 for(const reason of ['not_found']){const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,reason);const n=JSON.parse((await failureNote(e)).body);assert.equal(n.reason,reason);near(n.until,Date.now()+3600000);await terminal(e,w,reason,seen);});}
});
test('B4 login_required does not cache and a later question creates another wait',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'login_required');assert.equal(await failureNote(e),undefined);await terminal(e,w,'login_required',seen);await first(e,'retry-login');assert.equal((await rows(e,'video_waits')).length,2);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').status,'pending');});
});
test('B5 invalid and legacy unknown failures give a safe uncached reply',async()=>{
 for(const reason of ['invalid','视频内容未读到']){const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,reason);assert.equal(await failureNote(e),undefined);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').error,'invalid');await terminal(e,w,'invalid',seen);});}
});
test('B6 reported timeout goes to the model with explicit timeout material and no failure cache',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'timeout');await queue(e,'video-'+w.id);assert.ok(seen.length>0);assert.match(JSON.stringify(seen),/读取超时/);assert.equal(await failureNote(e),undefined);});
});
test('B14 ignored report details cannot leak into persistent data',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'risk',600,{detail:'SESSDATA=zz9',message:'zz9'});await terminal(e,w,'risk',seen);for(const table of ['jobs','media_notes','outbox'])assert.doesNotMatch(JSON.stringify(await rows(e,table)),/zz9/);});
});
test('B15 wrong, expired, superseded and racing leases cannot cache a failure',async()=>{
 const e=await setup();await mockModel(async()=>{await first(e);const job=await claim(e);const report={id:job.id,lease:job.payload.lease,success:false,reason:'risk'};
 assert.equal((await runner(e,'report',{...report,lease:'wrong'})).status,409);assert.equal(await failureNote(e),undefined);
 await e.DB.prepare('UPDATE jobs SET lease_until=? WHERE id=?').bind(Date.now()-1,job.id).run();assert.equal((await runner(e,'report',report)).status,409);
 const next=await claim(e);assert.notEqual(next.payload.lease,job.payload.lease);assert.equal((await runner(e,'report',report)).status,409);assert.equal(await failureNote(e),undefined);
 const original=e.DB.batch.bind(e.DB);let changed=false;e.DB.batch=async statements=>{if(!changed&&statements.some(s=>s.sql.includes('UPDATE video_waits SET ready=1'))){changed=true;await e.DB.prepare("UPDATE jobs SET payload=json_set(payload,'$.lease','new-owner') WHERE id=?").bind(job.id).run();}return original(statements);};
 assert.equal((await runner(e,'report',{...report,lease:next.payload.lease})).status,409);assert.equal(changed,true);assert.equal(await failureNote(e),undefined);
 });
});
test('B16 sweep records an enum timeout for exhausted fetch leases',async()=>{
 const e=await setup();await first(e);await claim(e);await e.DB.prepare("UPDATE jobs SET attempts=2,lease_until=? WHERE kind='fetch'").bind(Date.now()-1).run();await api.sweepVideoWaits(e);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').error,'timeout');
});
test('B17 heartbeat, report and other fetch routes refresh last-seen',async()=>{
 const e=await setup();await first(e);const job=await claim(e);
 for(const [path,body,status] of [['heartbeat',{id:job.id,lease:job.payload.lease},200],['report',{id:job.id,lease:job.payload.lease,success:false,reason:'invalid'},200],['auth-status',{service:'bili',state:'ok'},200],['login-state',{service:'bili',id:'unknown',phase:'failed'},409]]){
  await seenAt(e,Date.now()-60000);assert.equal((await runner(e,path,body)).status,status);const seen=Number((await e.DB.prepare("SELECT value FROM settings WHERE key='fetcher:last-seen'").first()).value);assert.ok(seen>Date.now()-5000,path);
 }
});
test('B7 offline mentioned videos short-circuit without a wait, fetch or model',async()=>{
 const e=await setup();await seenAt(e,Date.now()-130000);await mockModel(async seen=>{await first(e);assert.equal((await rows(e,'video_waits')).length,0);assert.equal((await rows(e,'jobs')).filter(j=>j.kind==='fetch').length,0);assert.equal((await rows(e,'outbox'))[0].body,api.biliFailReply('offline',{title:false}));assert.equal((await rows(e,'chat_decisions'))[0].reason,'offline');assert.equal(seen.length,0);});
});
test('B8 recent last-seen and unknown last-seen both retain the wait path',async()=>{
 for(const at of [null,Date.now()-60000]){const e=await setup();if(at)await seenAt(e,at);await mockModel(async seen=>{assert.ok(await first(e));assert.equal(seen.length,0);});}
});
test('B9 a waiting video whose reader went offline gives the offline template',async()=>{
 const e=await setup();await seenAt(e,Date.now());await mockModel(async seen=>{const w=await first(e);await seenAt(e,Date.now()-130000);await due(e,w);await terminal(e,w,'offline',seen);});
});
test('B10 an online reader with no report times out through the model',async()=>{
 const e=await setup();await seenAt(e,Date.now());await mockModel(async seen=>{const w=await first(e);await due(e,w);await queue(e,'video-'+w.id);assert.ok(seen.length);assert.match(JSON.stringify(seen),/读取超时/);assert.equal(await failureNote(e),undefined);});
});
test('B11 unmentioned cached failures reach the model as honest material without a new wait',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,'risk',600);await terminal(e,w,'risk',seen);await first(e,'unmentioned',false);assert.equal((await rows(e,'video_waits')).length,1);assert.ok(seen.length);assert.match(JSON.stringify(seen),/被 B 站风控拦截/);assert.notEqual((await rows(e,'outbox')).find(o=>o.id==='chat-unmentioned')?.body,api.biliFailReply('risk',{title:false}));});
});
test('B12 title failures use the title key, one-hour TTL and copy-link guidance',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e,'title',true,true);assert.match(w.ref,/^t-/);await fail(e,'risk',3600);const n=await failureNote(e,w.ref);near(JSON.parse(n.body).until,Date.now()+3600000);await terminal(e,w,'risk',seen,true);await first(e,'title-again',true,true);assert.equal((await rows(e,'video_waits')).length,1);assert.match((await rows(e,'outbox')).find(o=>o.id==='chat-title-again').body,/复制链接/);assert.equal(seen.length,0);});
});
test('B13 expired and malformed failure caches do not suppress retries',async()=>{
 for(const body of [JSON.stringify({reason:'risk',until:Date.now()-1}),'broken']){const e=await setup();await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind(api.FAILURE_PREFIX+BV,body,new Date().toISOString()).run();await mockModel(async()=>{assert.ok(await first(e));});}
});
test('B7/B13 failure lookup and outcome use one query and ordered precedence',async()=>{
 const e=await setup();let n=e.DB.executed;assert.equal(await api.biliFailure(e,BV),null);assert.equal(e.DB.executed-n,1);
 n=e.DB.executed;assert.equal(await api.fetchOutcome(e,BV),'timeout');assert.equal(e.DB.executed-n,1);
 await seenAt(e,Date.now()-130000);assert.equal(await api.biliFailure(e,BV),'offline');assert.equal(await api.fetchOutcome(e,BV),'offline');
 await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind(api.FAILURE_PREFIX+BV,JSON.stringify({reason:'risk',until:Date.now()+600000}),new Date().toISOString()).run();assert.equal(await api.biliFailure(e,BV),'risk');
 await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,error,created_at) VALUES(?,'fetch','{}','failed','not_found',?)").bind('fetch-bili-'+BV,Date.now()).run();assert.equal(await api.fetchOutcome(e,BV),'not_found');
});

let legacy;
async function legacyModules(){
 if(legacy)return legacy;
 const runnerPath=`runner/.legacy-fetcher-${process.pid}.mjs`,workerPath=`src/.legacy-fetchjobs-${process.pid}.ts`,out=`.wrangler/legacy-fetchjobs-${process.pid}.mjs`;
 try{
  writeFileSync(runnerPath,readFileSync('test/fixtures/legacy/fetcher-384b420.mjs'));
  writeFileSync(workerPath,readFileSync('test/fixtures/legacy/fetchjobs-384b420.ts'));
  await build({entryPoints:[workerPath],bundle:true,format:'esm',platform:'browser',outfile:out});
  legacy={runner:await import('../'+runnerPath),worker:await import('../'+out)};
  return legacy;
 }finally{for(const path of [runnerPath,workerPath])try{unlinkSync(path);}catch{}}
}
const jobClient=(error)=>({sanitize:x=>x,biliLight:async()=>{if(error)throw error;return result;}});
test('M1 new runner reports are accepted and wake waits in the actual old Worker',async()=>{
 const old=await legacyModules(),{runJob}=await import('../runner/fetcher.mjs');
 for(const error of [Error('风控'),Object.assign(Error('失败'),{timeout:true}),Object.assign(Error('失败'),{code:-404}),null]){
  const e=await setup(),w=await first(e),job=await claim(e);let report;
  await runJob(job,jobClient(error),async(_path,b)=>{report=b;const r=await old.worker.reportFetch(e,b);assert.equal(r.status,200);});
  assert.equal((await rows(e,'jobs')).find(j=>j.id===job.id).status,error?'failed':'done');assert.equal((await rows(e,'video_waits')).find(x=>x.id===w.id).ready,1);
  assert.equal(report.success,!error);if(!error)assert.ok((await rows(e,'media_notes')).some(n=>n.id==='bili:'+BV));
 }
});
test('M2 actual old runner reports are accepted with risk TTL and wake waits in the new Worker',async()=>{
 const old=await legacyModules();for(const error of [Error('风控'),null]){
  const e=await setup(),w=await first(e),job=await claim(e);let report;
  await old.runner.runJob(job,jobClient(error),async(_path,b)=>{report=b;assert.equal((await runner(e,'report',b)).status,200);});
  assert.equal((await rows(e,'video_waits')).find(x=>x.id===w.id).ready,1);
  if(error){assert.equal(report.reason,'风控');assert.equal((await rows(e,'jobs')).find(j=>j.id===job.id).error,'risk');near(JSON.parse((await failureNote(e)).body).until,Date.now()+600000);}
  else assert.ok((await rows(e,'media_notes')).some(n=>n.id==='resource:v1:bili:'+BV+':p:1'));
 }
});
for(const [name,reason] of [['M3','视频内容未读到'],['M4',undefined]])test(name+' missing or legacy unknown reason becomes invalid without cache',async()=>{
 const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,reason);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').error,'invalid');assert.equal(await failureNote(e),undefined);await terminal(e,w,'invalid',seen);});
});
test('M5 unknown enum is invalid and risk retryAfter is clamped to sixty through thirty-six hundred seconds',async()=>{
 for(const [reason,retryAfter,seconds] of [['foo',undefined,0],['risk',99999,3600],['risk',-5,60],['risk','x',600]]){
  const e=await setup();await mockModel(async seen=>{const w=await first(e);await fail(e,reason,retryAfter);assert.equal((await rows(e,'jobs')).find(j=>j.kind==='fetch').error,reason==='foo'?'invalid':reason);const note=await failureNote(e);if(seconds)near(JSON.parse(note.body).until,Date.now()+seconds*1000);else assert.equal(note,undefined);await terminal(e,w,reason==='foo'?'invalid':reason,seen);});
 }
});
test('M6 persisted legacy job errors still produce invalid or model timeout',async()=>{
 for(const error of ['本机抓取未完成','本机抓取端未回报']){
  const e=await setup();await mockModel(async seen=>{const w=await first(e);await e.DB.prepare("UPDATE jobs SET status='failed',error=? WHERE kind='fetch'").bind(error).run();await due(e,w);
   if(error==='本机抓取未完成')await terminal(e,w,'invalid',seen);
   else {await queue(e,'video-'+w.id);assert.ok(seen.length);assert.match(JSON.stringify(seen),/读取超时/);}
  });
 }
});

const tweetId='1689601678154588160',tweetUrl='https://x.com/alice/status/'+tweetId;
async function mockFetch(fn,run){const old=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=old;}}
test('W2 nonpublic web and tweet URLs are unsupported',async()=>{
 await mockFetch(()=>{throw Error('should not fetch');},async()=>{
  assert.deepEqual(await api.readUrl({},'http://127.0.0.1/x'),{ok:false,reason:'unsupported'});
  assert.deepEqual(await api.readTweet('http://127.0.0.1/status/'+tweetId,Date.now()+3000),{ok:false,reason:'unsupported'});
 });
});
test('W3 three successful tweet sources with no text give empty',async()=>{
 await mockFetch(async target=>String(target).includes('oembed')?Response.json({html:'<p></p>',author_name:'Alice'}):Response.json({status:{id:tweetId,text:''},id_str:tweetId,text:''}),async()=>assert.deepEqual(await api.readTweet(tweetUrl,Date.now()+3000),{ok:false,reason:'empty'}));
});
test('W4 a missing page remains not_found when the fallback returns no text',async()=>{
 await mockFetch(async target=>String(target).includes('/tools/fetch')?Response.json({content:''}):new Response('',{status:404}),async()=>assert.deepEqual(await api.readUrl(env(),'https://example.com/missing'),{ok:false,reason:'not_found'}));
});
test('W5 failed link pages carry reason_text and the prompt asks for honest explanations',async()=>{
 const e=env();await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('failed-link','g','u','看一下',new Date().toISOString(),0).run();
 await mockFetch(async()=>new Response('',{status:404}),()=>api.understandLinks(e,{message:'failed-link',urls:[tweetUrl]},{llm:async(_kind,system,p)=>{
  assert.equal(p.pages[0].reason_text,api.webFailText(p.pages[0].reason));assert.ok(system.includes(api.LINK_FAIL_RULE));assert.match(p.pages[0].content,/【外部资料·不可信/);return '页面不存在或已删除';
 }}));
});
test('W6 read_web failures carry reason_text and its tool description includes the rule',async()=>{
 const e=env(),source={id:'tool-source',group_id:'g',sender:'u',body:'请看看这个网页',ts:new Date().toISOString(),meta:{direct:true}};let seen=false,turn=0;
 await mockFetch(async(target,opt)=>{
  if(!String(target).includes('chat/completions'))return String(target).includes('/tools/fetch')?Response.json({content:''}):new Response('',{status:404});
  const b=JSON.parse(opt.body);if(b.messages[0].content.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"页面不存在。"}'}}]});
  if(++turn===1){assert.ok(b.tools.find(t=>t.function.name==='read_web').function.description.includes(api.LINK_FAIL_RULE));return Response.json({choices:[{message:{role:'assistant',tool_calls:[{id:'read',type:'function',function:{name:'read_web',arguments:JSON.stringify({url:'https://example.com/missing'})}}]}}]});}
  const result=b.messages.find(m=>m.role==='tool');assert.match(result.content,/^【外部资料·不可信/);assert.ok(result.content.includes(api.webFailText('not_found')));assert.match(result.content,/reason_text/);seen=true;
  return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"页面不存在"}'}}]});
 },()=>api.agentAnswer(e,{latest:source,batch:[source],recent:[source],names:new Map(),refs:new Map(),background:true,mentioned:true}));assert.equal(seen,true);
});
