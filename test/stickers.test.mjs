import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {worker,env,req,qq,msg,setupWith} from './support.mjs';
const load=async(entry,label)=>{const out=`.wrangler/${label}-${process.pid}.mjs`;await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',outfile:out});return import('../'+out);};
const vision=await load('src/vision.ts','sticker-vision');
let stickerPromise;
const stickers=()=>stickerPromise??=load('src/stickers.ts','stickers');
const bytes=new Uint8Array([71,73,70,56,57,97,1,2,3]),sha=createHash('sha256').update(bytes).digest('hex');
const queue=(e,id)=>(e.testWorker||worker).queue({messages:[{body:{id},ack(){}}]},e);
const cron=async e=>{let pending;await(e.testWorker||worker).scheduled({},e,{waitUntil(p){pending=p;}});await pending;};
const all=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(r=>r.results);
const row=(e)=>e.DB.prepare('SELECT * FROM stickers WHERE sha=?').bind(sha).first();
const put=(e,k,v)=>e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(k,v).run();
const shaOf=b=>createHash('sha256').update(b).digest('hex');
async function models(run,{meme=true,oversize=false,failImage=false}={}){
 const old=globalThis.fetch,state={images:0,vision:0};
 globalThis.fetch=async(url,init)=>{
  if(String(url).startsWith('https://example.com/')){state.images++;return failImage?new Response('fail',{status:404}):new Response(oversize?new Uint8Array(400001):bytes,{headers:{'Content-Type':'image/gif'}});}
  state.vision++;return Response.json({choices:[{message:{content:JSON.stringify({desc:'无语凝视',tags:['无语','凝视'],meme})}}]});
 };
 try{return await run(state);}finally{globalThis.fetch=old;}
}
const collect=(e,sender,message=sender)=>stickers().then(s=>s.collectSticker(e,{url:'https://example.com/sticker.gif',sender,message,idx:0}));
async function seed(e,id=sha,{state=1,created=Date.now(),senders=['a','b']}={}){
 await e.DB.prepare('INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,'image/gif',bytes.length,bytes.buffer,state,JSON.stringify(senders),created).run();
}
test('S1 byte descriptions share the original image cache and exact return value',async()=>{
 const e=env();
 await models(async state=>{
  const first=await vision.describeBytes(e,bytes,'image/gif','表情图片',AbortSignal.timeout(1000));
  const second=await vision.describeImage(e,{kind:'image',url:'https://example.com/sticker.gif'},'表情图片',AbortSignal.timeout(1000));
  assert.deepEqual(second,first);assert.equal(first.sha,sha+':'+vision.VISION_VERSION);assert.equal(state.vision,1);assert.equal(state.images,1);
 });
});
test('S2/S3 same sender stays a candidate; second sender queues exactly one tag job, including races',async()=>{
 const e=env();await models(async()=>{
  await collect(e,'a','one');await collect(e,'a','two');let r=await row(e);assert.equal(r.seen,2);assert.deepEqual(JSON.parse(r.senders),['a']);assert.equal(r.state,0);
  await Promise.all([collect(e,'b','three'),collect(e,'c','four')]);r=await row(e);assert.equal(r.seen,4);assert.equal(r.state,1);assert.deepEqual(new Set(JSON.parse(r.senders)),new Set(['a','b','c']));
  assert.equal((await all(e,'jobs')).filter(j=>j.kind==='sticker-tag').length,1);
  for(const sender of ['d','e','f'])await collect(e,sender);assert.equal(JSON.parse((await row(e)).senders).length,5);
 });
});
test('receive queues at most two candidates on WORK without fetching images; off collect takes effect',async()=>{
 const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});const images=[0,1,2].map(i=>({content_type:'image/gif',url:'https://example.com/'+i+'.gif',width:100,height:100}));
 await qq(e,{...msg('collection-in',''),attachments:images});
 const jobs=(await all(e,'jobs')).filter(j=>j.kind==='sticker');assert.equal(jobs.length,2);assert.ok(jobs.every(j=>e.WORK.sent.some(x=>x.body.id===j.id)));
 await put(e,'off:sticker_collect','1');await qq(e,{...msg('collection-off',''),attachments:images});assert.equal((await all(e,'jobs')).filter(j=>j.kind==='sticker').length,2);
 await models(async()=>{await queue(e,jobs[0].id);assert.equal((await row(e)).state,0);});
});
test('S4 tagging accepts memes, rejects ordinary images and defers when daily tag budget is exhausted',async()=>{
 for(const mode of ['accept','reject','cap']){
  const e=env();await seed(e);if(mode==='cap'){
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());await put(e,'budget:sticker_tag:'+day,'40');
  }
  await models(async state=>{await(await stickers()).tagSticker(e,{sha});assert.equal((await row(e)).state,{accept:2,reject:3,cap:1}[mode]);assert.equal(state.vision,mode==='cap'?0:1);},{meme:mode!=='reject'});
 }
});
test('S5 download failure and oversized image never create rows and the worker finishes the task',async()=>{
 for(const options of [{failImage:true},{oversize:true}]){
  const e=env();await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('oversize','sticker',JSON.stringify({url:'https://example.com/x.gif',sender:'a',message:'m'}),Date.now()).run();
  await models(async()=>{await queue(e,'oversize');assert.equal((await all(e,'stickers')).length,0);assert.equal((await all(e,'jobs'))[0].status,'done');},options);
 }
});
test('S6 full storage prunes only old singleton candidates and otherwise records full',async()=>{
 for(const removable of [false,true]){
  const e=env();
  await e.DB.prepare("INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) SELECT 'full-'||value,'image/gif',1,?1,0,'[\"one\"]',?2 FROM json_each(?3)").bind(bytes.buffer,removable?Date.now()-31*86400000:Date.now(),JSON.stringify(Array.from({length:1000},(_,i)=>i))).run();
  await models(()=>collect(e,'new'));const r=await row(e);assert.equal(!!r,removable);assert.ok((await all(e,'stickers')).length<=1000);
  assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.full').length,removable?0:1);
 }
});
test('hourly minute seven queues at most ten durable tag retries and respects per-invocation budget',async()=>{
 const e=env();for(let i=0;i<12;i++)await seed(e,'retry-'+i);
 const real=Date.now;try{Date.now=()=>Date.parse('2026-11-12T01:07:00Z');await cron(e);await cron(e);}finally{Date.now=real;}
 const jobs=(await all(e,'jobs')).filter(j=>j.kind==='sticker-tag');assert.equal(jobs.length,10);assert.equal(new Set(jobs.map(j=>j.id)).size,10);
});
test('S13 owner import handles binary data; members, unsupported MIME and decoded overflow are rejected',async()=>{
 const e=env(),memberToken='test-member-token';await e.DB.prepare('INSERT INTO members VALUES(?,?,?,?,0)').bind('member','Test Member',shaOf(memberToken),'member').run();
 const b={mime:'image/png',data_base64:Buffer.alloc(200000,7).toString('base64')};
 assert.equal((await req(e,'/api/team/stickers',b,memberToken)).status,403);
 const response=await req(e,'/api/team/stickers',b);assert.equal(response.status,200);const data=await response.json();assert.equal(data.state,1);
 const stored=await e.DB.prepare('SELECT * FROM stickers WHERE sha=?').bind(data.sha).first();assert.equal(stored.bytes,200000);assert.equal(new Uint8Array(stored.data)[199999],7);
 assert.equal((await req(e,'/api/team/stickers',{mime:'text/plain',data_base64:'eA=='})).status,400);
 assert.equal((await req(e,'/api/team/stickers',{mime:'image/png',data_base64:Buffer.alloc(400001).toString('base64')})).status,400);
});
test('import body caps cover length and streaming overflow without raising other API limits',async()=>{
 const e=env(),runtime=e.testWorker||worker;
 const post=async(path,body,withLength=false)=>runtime.fetch(new Request('https://team.example'+path,{method:'POST',headers:{Authorization:'Bearer owner-secret','Content-Type':'application/json',...(withLength?{'Content-Length':String(Buffer.byteLength(body))}:{})},body}),e);
 const valid=JSON.stringify({mime:'image/png',data_base64:Buffer.alloc(200000).toString('base64')});
 assert.equal((await post('/api/team/stickers',valid,true)).status,200);
 for(const length of [false,true]){
  assert.equal((await post('/api/team/stickers','x'.repeat(4*Math.ceil(400000/3)+1025),length)).status,413);
  assert.equal((await post('/api/team/tasks','x'.repeat(262145),length)).status,413);
 }
});
test('S14 sticker schema is additive and idempotent',()=>{
 const db=new DatabaseSync(':memory:'),schema=readFileSync(new URL('../schema.sql',import.meta.url),'utf8');
 try{db.exec(schema);db.prepare('INSERT INTO stickers(sha,mime,bytes,data,created_at) VALUES(?,?,?,?,?)').run(sha,'image/gif',bytes.length,bytes,1);db.exec(schema);db.exec(schema);assert.equal(db.prepare('SELECT COUNT(*) n FROM stickers').get().n,1);}finally{db.close();}
});
test('new import, receive, collection, tagging and retry invocations stay within 48 statements',async()=>{
 const {metered}=await load('src/d1.ts','sticker-meter'),base=env(),counts={};
 const measure=async(name,fn)=>{const e=metered(base),before=base.DB.executed;await fn(e);assert.equal(e.meter.used,base.DB.executed-before);assert.ok(e.meter.used<=48,name+': '+e.meter.used);counts[name]=e.meter.used;};
 await req(base,'/api/admin/bind',{groupId:'GROUP000001'});
 await measure('import',async e=>assert.equal((await req(e,'/api/team/stickers',{mime:'image/png',data_base64:Buffer.alloc(400000).toString('base64')})).status,200));
 await measure('receive',e=>qq(e,{...msg('meter-sticker',''),attachments:[{content_type:'image/gif',url:'https://example.com/a.gif'}]}));
 await models(async()=>{
  await measure('collect',e=>queue(e,'sticker-meter-sticker-0'));
  await collect(base,'second');await measure('tag',e=>queue(e,'sticker-tag-'+sha));
 });
 const real=Date.now;try{Date.now=()=>Date.parse('2026-11-12T01:07:00Z');await measure('retry',e=>cron(e));}finally{Date.now=real;}
 const {writeFileSync,mkdirSync}=await import('node:fs');mkdirSync('.agent',{recursive:true});writeFileSync('.agent/p2-collect-counts.json',JSON.stringify(counts,null,2));
});
test('sticker configuration preserves a literal false default and enforces sender/storage/daily caps',async()=>{
 const {validateTeamConfig}=await import('../config/validate.mjs'),team=JSON.parse(readFileSync(new URL('../config/team.json',import.meta.url),'utf8'));
 assert.equal(team.stickers.send,false);assert.equal(team.stickers.min_senders,2);assert.equal(team.stickers.caps.tag,40);assert.equal(team.stickers.caps.send,20);
 for(const [key,value] of [['min_senders',1],['max_bytes',400001],['max_rows',1001]]){const bad=structuredClone(team);bad.stickers[key]=value;assert.ok(validateTeamConfig(bad).includes('stickers.'+key));}
});
