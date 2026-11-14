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
async function models(e,run,{meme=true,oversize=false,failImage=false}={}){
 const old=globalThis.fetch,state={images:0,vision:0};
 e.AI={async run(){state.vision++;return {response:JSON.stringify({desc:'无语凝视',tags:['无语','凝视'],meme})};}};
 globalThis.fetch=async(url,init)=>{
  if(String(url).startsWith('https://multimedia.nt.qq.com.cn/')){state.images++;return failImage?new Response('fail',{status:404}):new Response(oversize?new Uint8Array(400001):bytes,{headers:{'Content-Type':'image/gif'}});}
  state.vision++;return Response.json({choices:[{message:{content:JSON.stringify({desc:'无语凝视',tags:['无语','凝视'],meme})}}]});
 };
 try{return await run(state);}finally{globalThis.fetch=old;}
}
const collect=(e,sender,message=sender)=>stickers().then(s=>s.collectSticker(e,{url:'https://multimedia.nt.qq.com.cn/sticker.gif',sender,message,idx:0}));
async function seed(e,id=sha,{state=1,created=Date.now(),senders=['a','b']}={}){
 await e.DB.prepare('INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,'image/gif',bytes.length,bytes.buffer,state,JSON.stringify(senders),created).run();
}
test('S1 byte descriptions share the original image cache and exact return value',async()=>{
 const e=env();
 await models(e,async state=>{
  const first=await vision.describeBytes(e,bytes,'image/gif','表情图片',AbortSignal.timeout(1000));
  const second=await vision.describeImage(e,{kind:'image',url:'https://multimedia.nt.qq.com.cn/sticker.gif'},'表情图片',AbortSignal.timeout(1000));
  assert.deepEqual(second,first);assert.ok(first.sha.startsWith(sha+':'));assert.match(first.sha,/:v1$/);assert.equal(state.vision,1);assert.equal(state.images,1);
 });
});
test('S2/S3 same sender stays a candidate; second sender queues exactly one tag job, including races',async()=>{
 const e=env();await models(e,async()=>{
  await collect(e,'a','one');await collect(e,'a','two');let r=await row(e);assert.equal(r.seen,2);assert.deepEqual(JSON.parse(r.senders),['a']);assert.equal(r.state,0);
  await Promise.all([collect(e,'b','three'),collect(e,'c','four')]);r=await row(e);assert.equal(r.seen,4);assert.equal(r.state,1);assert.deepEqual(new Set(JSON.parse(r.senders)),new Set(['a','b','c']));
  assert.equal((await all(e,'jobs')).filter(j=>j.kind==='sticker-tag').length,1);
  for(const sender of ['d','e','f'])await collect(e,sender);assert.equal(JSON.parse((await row(e)).senders).length,5);
 });
});
test('receive queues at most two candidates on WORK without fetching images; off collect takes effect',async()=>{
 const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});const images=[0,1,2].map(i=>({content_type:'image/gif',url:'https://multimedia.nt.qq.com.cn/'+i+'.gif',width:100,height:100}));
 await qq(e,{...msg('collection-in',''),attachments:images});
 const jobs=(await all(e,'jobs')).filter(j=>j.kind==='sticker');assert.equal(jobs.length,2);assert.ok(jobs.every(j=>e.WORK.sent.some(x=>x.body.id===j.id)));
 await put(e,'off:sticker_collect','1');await qq(e,{...msg('collection-off',''),attachments:images});assert.equal((await all(e,'jobs')).filter(j=>j.kind==='sticker').length,2);
 await models(e,async()=>{await queue(e,jobs[0].id);assert.equal((await row(e)).state,0);});
});
test('S4 tagging accepts memes, rejects ordinary images and defers when daily tag budget is exhausted',async()=>{
 for(const mode of ['accept','reject','cap']){
  const e=env();await seed(e);if(mode==='cap'){
   const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());await put(e,'budget:sticker_tag:'+day,'40');
  }
  await models(e,async state=>{await(await stickers()).tagSticker(e,{sha});assert.equal((await row(e)).state,{accept:2,reject:3,cap:1}[mode]);assert.equal(state.vision,mode==='cap'?0:1);},{meme:mode!=='reject'});
 }
});
test('S5 download failure and oversized image never create rows and the worker finishes the task',async()=>{
 for(const options of [{failImage:true},{oversize:true}]){
  const e=env();await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('oversize','sticker',JSON.stringify({url:'https://multimedia.nt.qq.com.cn/x.gif',sender:'a',message:'m'}),Date.now()).run();
  await models(e,async()=>{await queue(e,'oversize');assert.equal((await all(e,'stickers')).length,0);assert.equal((await all(e,'jobs'))[0].status,'done');},options);
 }
});
test('S6 full storage prunes only old singleton candidates and otherwise records full at 5,000 rows',async()=>{
 const cap=JSON.parse(readFileSync(new URL('../config/team.json',import.meta.url),'utf8')).stickers.max_rows;assert.equal(cap,5000);
 for(const removable of [false,true]){
  const e=env();
  await e.DB.prepare("INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) SELECT 'full-'||value,'image/gif',1,?1,0,'[\"one\"]',?2 FROM json_each(?3)").bind(bytes.buffer,removable?Date.now()-31*86400000:Date.now(),JSON.stringify(Array.from({length:cap},(_,i)=>i))).run();
  await models(e,()=>collect(e,'new'));const r=await row(e);assert.equal(!!r,removable);assert.ok((await all(e,'stickers')).length<=cap);
  assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.full').length,removable?0:1);
 }
});
test('S7 sticker bytes stay inside the self-imposed 2 GB library budget',async()=>{
 const {STICKER_STORE_MAX_BYTES,collectSticker}=await stickers();assert.equal(STICKER_STORE_MAX_BYTES,2_000_000_000);
 const e=env();
 await e.DB.prepare("INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at) VALUES('budget-seed','image/gif',?,?,2,'[\"a\",\"b\"]',?)")
  .bind(STICKER_STORE_MAX_BYTES-10,bytes.buffer,Date.now()).run();
 const old=globalThis.fetch;
 globalThis.fetch=async url=>{const extra=String(url).includes('budget-two')?1:0;return new Response(Uint8Array.from([...bytes,...Array(extra).fill(1)]),{headers:{'Content-Type':'image/gif'}});};
 try{
  await collectSticker(e,{url:'https://multimedia.nt.qq.com.cn/budget-one.gif',sender:'a',message:'budget-one'});
  let r=await e.DB.prepare("SELECT SUM(bytes) AS n FROM stickers").first();assert.equal(r.n,STICKER_STORE_MAX_BYTES-1);
  await collectSticker(e,{url:'https://multimedia.nt.qq.com.cn/budget-two.gif',sender:'b',message:'budget-two'});
  r=await e.DB.prepare("SELECT SUM(bytes) AS n FROM stickers").first();assert.equal(r.n,STICKER_STORE_MAX_BYTES-1,'over-budget image is refused without changing bytes');
  assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.full').length,1);
 }finally{globalThis.fetch=old;}
});
test('hourly minute seven queues at most ten durable tag retries and respects per-invocation budget',async()=>{
 const e=env();for(let i=0;i<12;i++)await seed(e,'retry-'+i);
 const real=Date.now;try{Date.now=()=>Date.parse('2026-11-12T01:07:00Z');await cron(e);await cron(e);}finally{Date.now=real;}
 const jobs=(await all(e,'jobs')).filter(j=>j.kind==='sticker-tag');assert.equal(jobs.length,10);assert.equal(new Set(jobs.map(j=>j.id)).size,10);
});
test('S8 a five-message WORK batch processes every sticker job and acknowledges each message',async()=>{
 const e=env();const ids=[];
 for(let i=0;i<5;i++){const id='batch-'+i;ids.push(id);await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind(id,'sticker',JSON.stringify({url:'https://multimedia.nt.qq.com.cn/batch-'+i+'.gif',sender:'a',message:id}),Date.now()).run();}
 const old=globalThis.fetch;globalThis.fetch=async url=>new Response(Uint8Array.from([...bytes,Number(String(url).match(/batch-(\d)/)[1])]),{headers:{'Content-Type':'image/gif'}});
 const acks=[],retries=[];
 try{await worker.queue({queue:'inkboard-team',messages:ids.map((id,i)=>({body:{id},ack(){acks.push(i)},retry(){retries.push(i)}}))},e);}finally{globalThis.fetch=old;}
 assert.deepEqual(acks,[0,1,2,3,4]);assert.deepEqual(retries,[]);
 assert.equal((await all(e,'stickers')).length,5);
 assert.ok((await all(e,'jobs')).every(j=>j.status==='done'),'all five jobs finish');
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
 await measure('receive',e=>qq(e,{...msg('meter-sticker',''),attachments:[{content_type:'image/gif',url:'https://multimedia.nt.qq.com.cn/a.gif'}]}));
 await models(base,async()=>{
  await measure('collect',e=>queue(e,'sticker-meter-sticker-0'));
  await collect(base,'second');await measure('tag',e=>queue(e,'sticker-tag-'+sha));
 });
 const real=Date.now;try{Date.now=()=>Date.parse('2026-11-12T01:07:00Z');await measure('retry',e=>cron(e));}finally{Date.now=real;}
 const {writeFileSync,mkdirSync}=await import('node:fs');mkdirSync('.agent',{recursive:true});writeFileSync('.agent/p2-collect-counts.json',JSON.stringify(counts,null,2));
});
test('sticker configuration preserves a literal false default and enforces sender/storage/daily caps',async()=>{
 const {validateTeamConfig}=await import('../config/validate.mjs'),team=JSON.parse(readFileSync(new URL('../config/team.json',import.meta.url),'utf8'));
 assert.equal(team.stickers.send,false);assert.equal(team.stickers.min_senders,2);assert.equal(team.stickers.caps.tag,40);assert.equal(team.stickers.caps.send,20);
 for(const [key,value] of [['min_senders',1],['max_bytes',400001],['max_rows',5001]]){const bad=structuredClone(team);bad.stickers[key]=value;assert.ok(validateTeamConfig(bad).includes('stickers.'+key));}
});

const patchedModules=new Map();
async function patched(entry,patch={send:true}){
 const key=entry+JSON.stringify(patch);if(patchedModules.has(key))return patchedModules.get(key);
 const promise=(async()=>{
  const config=JSON.parse(readFileSync(new URL('../config/team.json',import.meta.url),'utf8'));config.stickers={...config.stickers,...patch};
  const tag=shaOf(key).slice(0,12),out=`.wrangler/sticker-mode-${process.pid}-${tag}.mjs`;
  await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',outfile:out,plugins:[{name:'sticker-mode',setup(b){b.onLoad({filter:/config\/team\.json$/},()=>({contents:JSON.stringify(config),loader:'json'}));}}]});
  return import('../'+out);
 })();patchedModules.set(key,promise);return promise;
}
let appCounter=0;
async function sendingFixture(patch={send:true}){
 const e=await setupWith({stickers:patch});e.QQ_APP_ID='sticker-app-'+(++appCounter);
 await seed(e,sha,{state:2});await e.DB.prepare('UPDATE stickers SET desc=?,tags=? WHERE sha=?').bind('无语凝视','["无语","凝视"]',sha).run();
 await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('sticker-source','GROUP000001','m1','原始问题',new Date().toISOString(),1,0).run();return e;
}
async function mediaRow(e,id='reply',source='sticker-source'){
 await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind(id+'~s','GROUP000001',source,'[表情]','pending',Date.now()).run();
 await e.DB.prepare('INSERT INTO outbox_meta VALUES(?,?)').bind(id+'~s',JSON.stringify({sticker:sha})).run();
}
async function deliverSticker(e,{upload,send}={}){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url:String(url),body});
  if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake-sticker-token',expires_in:300});
  if(String(url).endsWith('/files'))return upload?upload(body):Response.json({file_info:'mock-file-info',ttl:7200});
  return send?send(body):Response.json({id:'sent-'+calls.length});
 };
 try{await queue(e,'no-sticker-job');return calls;}finally{globalThis.fetch=old;}
}
const voiceSticker=JSON.stringify({mode:'care',text:'这下确实有点无语。',sticker:'无语'});
test('S7 keyword matching, threshold, daily reuse and GIF policy select only eligible images',async()=>{
 const e=await sendingFixture(),s=await patched('src/stickers.ts');
 assert.equal(await s.pickSticker(e,'无语'),sha);assert.equal(await s.pickSticker(e,'开心欢呼'),null);
 await e.DB.prepare('UPDATE stickers SET used_at=?').bind(Date.now()).run();assert.equal(await s.pickSticker(e,'无语'),null);
 await e.DB.prepare('UPDATE stickers SET used_at=NULL').run();const noGif=await patched('src/stickers.ts',{send:true,send_gif:false});assert.equal(await noGif.pickSticker(e,'无语'),null);
});
test('S8 work voice and malformed sticker keywords never enqueue a picture',async()=>{
 const e=await sendingFixture(),v=await patched('src/voice.ts');
 assert.equal(v.decodeVoice(voiceSticker).sticker,'无语');
 for(const [i,raw] of [JSON.stringify({mode:'work',text:'可靠的结果。',sticker:'无语'}),JSON.stringify({mode:'care',text:'这句话照常。',sticker:'一'}),JSON.stringify({mode:'banter',text:'不会配太长的关键词。',sticker:'这是一个非常非常长的关键词'})].entries())await v.enqueueVoice(e,'work-'+i,'GROUP000001','sticker-source',raw);
 assert.ok((await all(e,'outbox')).every(o=>!o.id.endsWith('~s')));
});
test('S9 runtime switches, pause, daily cap and remaining D1 budget suppress only the picture',async()=>{
 for(const scenario of ['off','pause','daily','meter','nomatch']){
  const e=await sendingFixture(),v=await patched('src/voice.ts');
  if(scenario==='off')await put(e,'off:sticker_send','1');if(scenario==='pause')await put(e,'sticker_paused_until',String(Date.now()+10000));
  if(scenario==='daily')await put(e,'budget:sticker_send:'+new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),'20');
  const metered=await load('src/d1.ts','selection-meter');const target=scenario==='meter'?metered.metered(e):e;if(target.meter)target.meter.used=48;
  await v.enqueueVoice(target,'selection-'+scenario,'GROUP000001','sticker-source',scenario==='nomatch'?JSON.stringify({mode:'care',text:'照常说话。',sticker:'开心欢呼'}):voiceSticker);
  assert.equal((await all(e,'outbox')).length,1,scenario);assert.equal((await row(e)).uses,0,scenario);
  if(scenario==='nomatch')assert.equal((await all(e,'settings')).filter(r=>r.key.startsWith('budget:sticker_send:')).length,0);
 }
});
test('same-image concurrent selection reserves one sticker segment and increments usage once',async()=>{
 const e=await sendingFixture(),v=await patched('src/voice.ts');
 await Promise.all([v.enqueueVoice(e,'race-a','GROUP000001','sticker-source',voiceSticker),v.enqueueVoice(e,'race-b','GROUP000001','sticker-source',voiceSticker)]);
 assert.equal((await all(e,'outbox')).filter(o=>o.id.endsWith('~s')).length,1);assert.equal((await row(e)).uses,1);
});
test('S10 BLOB upload and rich message fields are exact, with reusable file_info cache',async()=>{
 const e=await sendingFixture();await mediaRow(e,'first');let calls=await deliverSticker(e);
 const upload=calls.find(c=>c.url.endsWith('/files'));assert.ok(upload);assert.deepEqual(upload.body,{file_type:1,file_data:Buffer.from(bytes).toString('base64'),srv_send_msg:false});
 const message=calls.find(c=>c.body.msg_type===7);const v=await patched('src/voice.ts');assert.deepEqual(message.body,{msg_type:7,media:{file_info:'mock-file-info'},msg_id:'sticker-source',msg_seq:v.messageSequence('first~s')});
 assert.equal((await row(e)).file_info,'mock-file-info');assert.ok((await row(e)).file_info_expires>Date.now()+3600000);
 await mediaRow(e,'second');calls=await deliverSticker(e);assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,0);assert.equal(calls.filter(c=>c.body.msg_type===7).length,1);
 assert.ok((await all(e,'outbox')).every(o=>o.status==='sent'));
});
test('S11 upload failure skips once while text succeeds; no duplicate delivery',async()=>{
 const e=await sendingFixture(),v=await patched('src/voice.ts');await v.enqueueVoice(e,'text','GROUP000001','sticker-source','{"mode":"work","text":"文字仍然送达。"}');await mediaRow(e);
 const calls=await deliverSticker(e,{upload:()=>Response.json({code:123},{status:400})});
 assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,1);assert.equal(calls.filter(c=>c.body.msg_type===7).length,0);
 assert.equal((await all(e,'outbox')).find(o=>o.id==='text').status,'sent');assert.equal((await all(e,'outbox')).find(o=>o.id==='reply~s').status,'skipped');
 assert.equal((await all(e,'settings')).find(r=>r.key==='sticker_fail').value,'1');
 assert.equal((await all(e,'outbox_attempts')).find(r=>r.id==='reply~s').http_status,400);
 assert.equal((await deliverSticker(e)).length,0);
});
test('S11b three failures pause for a day, and a successful sticker resets the counter',async()=>{
 const e=await sendingFixture();for(let i=0;i<3;i++)await mediaRow(e,'bad-'+i);
 await deliverSticker(e,{upload:()=>Response.json({code:123},{status:400})});
 const settings=Object.fromEntries((await all(e,'settings')).map(r=>[r.key,r.value]));assert.equal(settings.sticker_fail,'0');assert.ok(Number(settings.sticker_paused_until)>=Date.now()+86400000-1000);
 assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.paused').length,1);
 const good=await sendingFixture();await put(good,'sticker_fail','2');await mediaRow(good);await deliverSticker(good);assert.equal((await all(good,'settings')).find(r=>r.key==='sticker_fail').value,'0');
});
test('sticker failures start a new three-attempt cycle after the daily pause expires',async()=>{
 const real=Date.now;let now=real();Date.now=()=>now;
 try{
  const e=await sendingFixture(),failure={upload:()=>Response.json({code:123},{status:400})};
  for(let i=0;i<3;i++)await mediaRow(e,'first-cycle-'+i);
  const firstCalls=await deliverSticker(e,failure);
  assert.equal(firstCalls.filter(c=>c.url.endsWith('/files')).length,3);
  const settings=()=>all(e,'settings').then(rows=>Object.fromEntries(rows.map(r=>[r.key,r.value])));
  const paused=await settings(),until=Number(paused.sticker_paused_until);
  assert.equal(until,now+86400000);
  await mediaRow(e,'during-pause');assert.equal((await deliverSticker(e,failure)).length,0);
  now=until+1;
  await e.DB.prepare('UPDATE messages SET ts=?').bind(new Date(now).toISOString()).run();
  for(let i=1;i<=3;i++){
   await mediaRow(e,'next-cycle-'+i);
   const calls=await deliverSticker(e,failure),current=await settings();
   assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,1);
   if(i<3){
    assert.equal(current.sticker_fail,String(i),'expired pauses must not retain the previous failure streak');
    assert.equal(current.sticker_paused_until,String(until));
    assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.paused').length,1);
   }else{
    assert.equal(current.sticker_fail,'0');assert.equal(Number(current.sticker_paused_until),now+86400000);
    assert.equal((await all(e,'activity')).filter(a=>a.kind==='sticker.paused').length,2);
   }
  }
 }finally{Date.now=real;}
});
test('sticker 3xx redirect is a failure with code=redirect while 200 still sends',async()=>{
 const redirect=()=>new Response(null,{status:302,headers:{location:'https://redirected.example/next'}});
 for(const target of ['upload','message','ok']){
  const e=await sendingFixture();await mediaRow(e);
  const old=globalThis.fetch,calls=[];
  globalThis.fetch=async(url,init={})=>{
   calls.push({url:String(url),options:init});
   if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'fake-sticker-token',expires_in:300});
   if(String(url).endsWith('/files'))return target==='upload'?redirect():Response.json({file_info:'mock-file-info',ttl:7200});
   return target==='ok'?Response.json({id:'sent-redirect'}):redirect();
  };
  try{await queue(e,'no-sticker-job');}finally{globalThis.fetch=old;}
  const posts=calls.filter(c=>c.url.startsWith('https://api.bot.qq.com/')&&!c.url.includes('getAppAccessToken')),outbox=(await all(e,'outbox'))[0],attempt=(await all(e,'outbox_attempts'))[0];
  assert.ok(posts.length>=1,target);assert.ok(posts.every(c=>c.options.redirect==='manual'),target);
  assert.equal(posts.filter(c=>c.url.endsWith('/messages')).length,target==='upload'?0:1,target);
  if(target==='ok'){assert.equal(outbox.status,'sent');assert.equal(attempt.http_status,200);assert.equal(attempt.code,'');}
  else{assert.equal(outbox.status,'skipped');assert.equal(attempt.http_status,302);assert.equal(attempt.code,'redirect',target);}
 }
});
test('message rejection and network uncertainty never retry rich media',async()=>{
 for(const failure of ['rejected','network']){
  const e=await sendingFixture();await mediaRow(e);const calls=await deliverSticker(e,{send:()=>{if(failure==='network')throw Error('connection lost');return Response.json({code:777},{status:400});}});
  assert.equal(calls.filter(c=>c.body.msg_type===7).length,1);assert.equal((await all(e,'outbox'))[0].status,'skipped');assert.equal((await deliverSticker(e)).length,0);
 }
});
test('S12 expired or absent passive source is skipped before any QQ request',async()=>{
 for(const source of ['expired',null]){
  const e=await sendingFixture();await e.DB.prepare('UPDATE messages SET ts=?').bind(new Date(Date.now()-241000).toISOString()).run();await mediaRow(e,'expired',source===null?null:'sticker-source');
  assert.equal((await deliverSticker(e)).length,0);assert.equal((await all(e,'outbox'))[0].status,'skipped');
 }
});
test('S15/S15b queued sticker switch is checked before token, while same-batch text still sends',async()=>{
 for(const text of [false,true]){
  const e=await sendingFixture();await mediaRow(e);if(text)await(await patched('src/voice.ts')).enqueueVoice(e,'plain','GROUP000001','sticker-source','{"mode":"work","text":"文字。"}');await put(e,'off:sticker_send','1');
  const calls=await deliverSticker(e);assert.equal(calls.filter(c=>c.url.endsWith('/files')||c.body.msg_type===7).length,0);assert.equal(calls.length,text?2:0);assert.equal((await all(e,'outbox')).find(o=>o.id==='reply~s').status,'skipped');
 }
});
test('S16 first failure fuses the same invocation before a second queued sticker is uploaded',async()=>{
 const e=await sendingFixture();await put(e,'sticker_fail','2');await mediaRow(e,'a');await mediaRow(e,'b');
 const calls=await deliverSticker(e,{upload:()=>Response.json({code:9},{status:400})});assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,1);assert.ok((await all(e,'outbox')).every(o=>o.status==='skipped'));
});
test('S17 send missing or string true is closed both when queued and when sent',async()=>{
 for(const send of [undefined,'true',1,false,true]){
  const patch={send},e=await sendingFixture(patch),v=await patched('src/voice.ts',patch);await v.enqueueVoice(e,'strict','GROUP000001','sticker-source',voiceSticker);
  assert.equal((await all(e,'outbox')).some(o=>o.id==='strict~s'),send===true);
  if(send!==true)await mediaRow(e,'already');const calls=await deliverSticker(e);
  assert.equal(calls.some(c=>c.body.msg_type===7),send===true);
 }
});
test('S18 sent sticker is absent from recentBot, conversation and duplicate-answer context',async()=>{
 const e=await sendingFixture();delete e.QQ_APP_ID;await req(e,'/api/admin/bind',{groupId:'GROUP000001'});await mediaRow(e);await e.DB.prepare("UPDATE outbox SET status='sent'").run();
 await qq(e,msg('after-sticker','现在请回答我'),'GROUP_AT_MESSAGE_CREATE');
 const old=globalThis.fetch,seen=[];globalThis.fetch=async(_u,init)=>{const b=JSON.parse(init.body);seen.push(b);return Response.json({choices:[{message:{content:b.messages[0].content.includes('最后的嘴替模块')?'{"mode":"work","text":"收到。"}':'{"action":"reply","kind":"direct","brief":"回复当前问题"}'}}]});};
 try{await queue(e,'chat-after-sticker');}finally{globalThis.fetch=old;}
 const input=JSON.parse(seen[0].messages[1].content);assert.ok(!input.recentBot.some(r=>r.id.endsWith('~s')));assert.ok(!input.conversation.some(r=>r.text==='[表情]'));
});
test('sticker selection and the largest sender failure path count actual D1 statements',async()=>{
 const {metered}=await load('src/d1.ts','sticker-send-meter'),v=await patched('src/voice.ts'),base=await sendingFixture();
 let before=base.DB.executed,e=metered(base);await v.enqueueVoice(e,'meter-picked','GROUP000001','sticker-source',voiceSticker);
 assert.equal(e.meter.used,base.DB.executed-before);assert.equal(e.meter.used,7);assert.ok((await all(base,'outbox')).some(o=>o.id.endsWith('~s')));
 // Worst row: upload cache write, rejected message, failure counter and fuse activity.
 const fail=await sendingFixture();await put(fail,'sticker_fail','2');await mediaRow(fail);before=fail.DB.executed;e=metered(fail);
 await deliverSticker(e,{send:()=>Response.json({code:9},{status:400})});assert.equal(e.meter.used,fail.DB.executed-before);assert.ok(e.meter.used<=48);assert.equal(e.meter.used,14);
 const {writeFileSync}=await import('node:fs');writeFileSync('.agent/p2-send-counts.json',JSON.stringify({selectionIncludingText:7,largestFailureInvocation:e.meter.used},null,2));
});
test('closed sticker backlog can be skipped within four remaining statements and zero QQ calls',async()=>{
 const {metered}=await load('src/d1.ts','sticker-backlog-meter'),base=await sendingFixture();await put(base,'off:sticker_send','1');for(let i=0;i<5;i++)await mediaRow(base,'backlog-'+i);
 const e=metered(base);e.meter.used=44;const before=base.DB.executed;
 assert.equal((await deliverSticker(e)).length,0);assert.equal(e.meter.used,48);assert.equal(base.DB.executed-before,4);assert.ok((await all(base,'outbox')).every(o=>o.status==='skipped'));
});
test('low remaining send budget leaves rich media pending for a later invocation',async()=>{
 const {metered}=await load('src/d1.ts','sticker-defer-meter'),base=await sendingFixture();await mediaRow(base);const e=metered(base);e.meter.used=56;
 const calls=await deliverSticker(e);assert.equal(calls.filter(c=>c.url.endsWith('/files')||c.body.msg_type===7).length,0);assert.ok(e.meter.used<=64);assert.equal((await all(base,'outbox'))[0].status,'pending');
 await deliverSticker(base);assert.equal((await all(base,'outbox'))[0].status,'sent');
});
test('upload TTL missing or zero uses one hour and stale file_info is uploaded again',async()=>{
 for(const ttl of [undefined,0]){
  const e=await sendingFixture();await e.DB.prepare('UPDATE stickers SET file_info=?,file_info_expires=?').bind('expired',Date.now()+50000).run();await mediaRow(e);
  const before=Date.now(),calls=await deliverSticker(e,{upload:()=>Response.json({file_info:'renewed',...(ttl===undefined?{}:{ttl})})});
  assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,1);assert.equal((await row(e)).file_info,'renewed');assert.ok((await row(e)).file_info_expires>=before+3600000);
 }
});
