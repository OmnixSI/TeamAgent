// F8-5 IMG-c/IMG-d: local fake QQ HTTP server + real quota/tool/send code.
// No real QQ request: global fetch only accepts 127.0.0.1. No production D1.
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const root=new URL('../',import.meta.url),tmp='/tmp/f8-accept-send';
const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('schema.sql',root),'utf8'));
function statement(sql,args=[]){
 const execute=()=>{
  const s=db.prepare(sql);
  if(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql))return {results:s.all(...args),meta:{changes:0}};
  const r=s.run(...args);return {results:[],meta:{changes:Number(r.changes)}};
 };
 return {bind:(...values)=>statement(sql,values.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v)),execute,async first(){return execute().results[0]??null;},async all(){return execute();},async run(){return execute();}};
}
const DB={prepare:statement,async batch(ss){db.exec('BEGIN');try{const r=ss.map(s=>s.execute());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}};
const all=sql=>db.prepare(sql).all();
const set=(key,value)=>db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,value);
const jpeg=Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,17,8,4,0,4,0,3,1,17,0,2,17,0,3,17,0,255,217]);
await build({entryPoints:[new URL('src/imagegen.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:tmp+'-imagegen.mjs',logLevel:'silent'});
await build({entryPoints:[new URL('src/tools/generate-image.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:tmp+'-tool.mjs',logLevel:'silent'});
await build({entryPoints:[new URL('src/toolkit.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:tmp+'-toolkit.mjs',logLevel:'silent'});
const imagegen=await import(pathToFileURL(tmp+'-imagegen.mjs').href);
const toolMod=await import(pathToFileURL(tmp+'-tool.mjs').href);
const toolkit=await import(pathToFileURL(tmp+'-toolkit.mjs').href);

const out={c:{},d:{},requests:[],qq_real_sends:0,production_d1_writes:0,unexpected_hosts:[]};
let server, port;
const requests=[];
function startServer(){
 return new Promise(resolve=>{
  server=http.createServer((req,res)=>{
   let body='';req.on('data',c=>body+=c);req.on('end',()=>{
    requests.push({method:req.method,url:req.url,headers:{authorization:req.headers.authorization,'content-type':req.headers['content-type']},body:body?JSON.parse(body):null});
    res.setHeader('content-type','application/json');
    if(req.url.endsWith('/files'))res.end(JSON.stringify({file_info:'FILEINFO-1',ttl:3600,code:0}));
    else if(req.url.endsWith('/messages'))res.end(JSON.stringify({id:'qq-msg-1',code:0}));
    else {res.statusCode=404;res.end('{}');}
   });
  }).listen(0,'127.0.0.1',()=>{port=server.address().port;resolve();});
 });
}
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,init)=>{
 const u=new URL(String(url));
 if(u.hostname!=='127.0.0.1'&&u.hostname!=='api.bot.qq.com'){out.unexpected_hosts.push(u.hostname);throw Error('network blocked');}
 return originalFetch('http://127.0.0.1:'+port+u.pathname+u.search,init);
};

try{
 await startServer();
 set('imagegen:user_daily','5');set('imagegen:group_daily','20');
 // ---------- IMG-c send path ----------
 const enq=await imagegen.enqueueGeneratedImage({DB},{id:'turn-c1',group:'GROUP-C',message:'turn-c1',jpeg,prompt:'一只戴草帽的橘猫',sender:'u1'});
 assert.equal(enq.outbox_id,'turn-c1~g');
 const row=db.prepare('SELECT o.*,m.json AS meta FROM outbox o LEFT JOIN outbox_meta m ON m.id=o.id WHERE o.id=?').get('turn-c1~g');
 const httpStatus=await imagegen.sendGeneratedImage({DB},row,'TOKEN-C',{ts:new Date().toISOString()},1);
 out.c.http= httpStatus;
 assert.equal(httpStatus,200);
 assert.equal(requests.length,2,'one upload + one message');
 const [upload,message]=requests;
 assert.equal(upload.url,'/v2/groups/GROUP-C/files');
 assert.equal(upload.headers.authorization,'QQBot TOKEN-C');
 assert.equal(upload.body.file_type,1);
 assert.equal(upload.body.srv_send_msg,false);
 assert.ok(Buffer.from(upload.body.file_data,'base64').equals(Buffer.from(jpeg)));
 assert.equal(message.url,'/v2/groups/GROUP-C/messages');
 assert.equal(message.body.msg_type,7);
 assert.deepEqual(message.body.media,{file_info:'FILEINFO-1'});
 assert.equal(message.body.msg_id,'turn-c1');
 assert.equal(message.body.msg_seq,1);
 assert.equal(requests.filter(r=>r.url.endsWith('/messages')).length,1);
 assert.equal(db.prepare("SELECT status FROM outbox WHERE id='turn-c1~g'").get().status,'sent');
 assert.equal(db.prepare("SELECT http_status FROM outbox_attempts WHERE id='turn-c1~g'").get().http_status,200);
 out.c.upload_fields=Object.keys(upload.body).sort();
 out.c.message_fields=Object.keys(message.body).sort();
 out.c.outbox_status='sent';out.c.request_count=requests.length;

 // A second call cannot send the same outbox row again.
 const again=await imagegen.sendGeneratedImage({DB},row,'TOKEN-C',{ts:new Date().toISOString()},2);
 assert.equal(again,null);assert.equal(requests.length,2,'no second send');
 out.c.retry_sends=0;

 // Outside the 240s passive window: zero HTTP requests.
 const enqOld=await imagegen.enqueueGeneratedImage({DB},{id:'turn-c2',group:'GROUP-C',message:'turn-c2',jpeg,prompt:'旧消息',sender:'u1'});
 const oldRow=db.prepare('SELECT o.*,m.json AS meta FROM outbox o LEFT JOIN outbox_meta m ON m.id=o.id WHERE o.id=?').get(enqOld.outbox_id);
 const before=requests.length;
 const oldStatus=await imagegen.sendGeneratedImage({DB},oldRow,'TOKEN-C',{ts:new Date(Date.now()-241000).toISOString()},1);
 out.c.expired={http:oldStatus,new_requests:requests.length-before,status:db.prepare('SELECT status FROM outbox WHERE id=?').get(enqOld.outbox_id).status};
 assert.equal(requests.length,before,'no request outside passive window');
 assert.equal(out.c.expired.status,'skipped');

 // ---------- IMG-d safety ----------
 const calls={images:[]};
 const fakeDeps={
  async generateImage(_e,o){calls.images.push(o);return {ok:true,jpeg,bytes:jpeg.length,width:1024,height:1024,model:'fake-image',est_cost_micro_usd:1000,latency_ms:1};},
  async enqueueGeneratedImage(_e,o){return {outbox_id:o.id+'~g'};},
 };
 const tool=toolMod.makeGenerateImageTool(fakeDeps);
 const ctx=(id,group='GROUP-D',sender='u1',tainted=false)=>({context:{latest:{id,group_id:group,sender}},source:{id,group_id:group,sender,body:'帮我生成一张图'},isTainted:()=>tainted});
 const run=(id,group,sender,tainted)=>tool.run({DB},{prompt:'帮我生成一张海报，写“周五聚餐”'},ctx(id,group,sender,tainted));

 for(let i=1;i<=5;i++){const r=await run('d-t'+i,'GROUP-D','u1',false);assert.equal(r.ok,true,'run '+i);}
 out.d.quota_after_5={images:calls.images.length,user:db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_user' AND key='GROUP-D:u1'").get().n};
 const sixth=await run('d-t6','GROUP-D','u1',false);
 out.d.sixth={ok:sixth.ok,error_kind:sixth.error_kind,images_after:calls.images.length,reason_text:sixth.reason_text};
 assert.equal(sixth.ok,false);assert.equal(sixth.error_kind,'quota');assert.equal(calls.images.length,5,'sixth never calls generateImage');

 const otherGroup=await run('d-b1','GROUP-B','u1',false);
 out.d.group_isolation={ok:otherGroup.ok,images:calls.images.length};
 assert.equal(otherGroup.ok,true);assert.equal(calls.images.length,6);

 const tainted=await run('d-taint','GROUP-B','u1',true);
 out.d.tainted={ok:tainted.ok,error_kind:tainted.error_kind,images:calls.images.length,reservations:db.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_user' AND key='GROUP-B:u1'").get().n};
 assert.equal(tainted.ok,false);assert.equal(tainted.error_kind,'denied');assert.equal(calls.images.length,6);
 assert.equal(out.d.tainted.reservations,1,'tainted turn reserves nothing');

 set('off:generate_image','1');
 const offResult=await toolkit.runExtraTool({DB},'generate_image',{prompt:'帮我生成一张图'},ctx('d-off','GROUP-B','u2'));
 out.d.off={ok:offResult.ok,unavailable:offResult.unavailable,error_kind:offResult.error_kind,images:calls.images.length};
 assert.equal(offResult.ok,false);assert.equal(offResult.error_kind,'denied');assert.equal(calls.images.length,6);
 assert.equal(out.d.off.unavailable,true);
}catch(error){
 out.fatal={name:error?.name||'Error',message:String(error?.message||error).slice(0,300)};
 process.exitCode=1;
}finally{
 globalThis.fetch=originalFetch;
 if(server)await new Promise(r=>server.close(r));
 db.close();
 out.requests=requests;
}
console.log(JSON.stringify(out,null,2));
