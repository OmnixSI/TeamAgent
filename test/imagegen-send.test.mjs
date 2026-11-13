import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,worker} from './support.mjs';
const output=`.wrangler/imagegen-send-${process.pid}.mjs`;
await build({entryPoints:['src/imagegen.ts'],bundle:true,format:'esm',platform:'browser',outfile:output});
const {enqueueGeneratedImage,sendGeneratedImage}=await import('../'+output);
const jpeg=Uint8Array.from([255,216,255,192,0,17,8,4,0,4,0,3,1,17,0,2,17,0,3,17,0,255,217]);
const all=(e,t)=>e.DB.prepare('SELECT * FROM '+t).all().then(r=>r.results);
const row=e=>e.DB.prepare('SELECT o.*,m.json meta FROM outbox o JOIN outbox_meta m ON o.id=m.id').first();
const enqueue=(e,id='turn')=>enqueueGeneratedImage(e,{id,group:'A',message:'source',jpeg,prompt:'cat',sender:'member'});
async function fixture(){const e=env();await enqueue(e);return e;}
async function qqMock(run,{upload,send}={}){
 const old=globalThis.fetch,calls=[];
 globalThis.fetch=async(url,init)=>{
  assert.ok(String(url).startsWith('https://api.bot.qq.com/'));calls.push({url:String(url),body:JSON.parse(init.body),init});
  if(String(url).includes('getAppAccessToken'))return Response.json({access_token:'mock-token',expires_in:300});
  return String(url).endsWith('/files')?(upload?upload():Response.json({file_info:'file-A',ttl:7200})):(send?send():Response.json({id:'accepted'}));
 };
 try{return {result:await run(),calls};}finally{globalThis.fetch=old;}
}
const source=()=>({ts:new Date().toISOString(),group_id:'A'});
const send=(e,o,src=source())=>sendGeneratedImage(e,o,'token',src,23);

test('G5 uploads base64 JPEG then sends exact QQ rich media shape and records accepted result',async()=>{
 const e=await fixture(),o=await row(e),{calls,result}=await qqMock(()=>send(e,o));assert.equal(result,200);
 assert.equal(calls[0].url,'https://api.bot.qq.com/v2/groups/A/files');assert.deepEqual(calls[0].body,{file_type:1,file_data:Buffer.from(jpeg).toString('base64'),srv_send_msg:false});
 assert.equal(calls[1].url,'https://api.bot.qq.com/v2/groups/A/messages');assert.deepEqual(calls[1].body,{msg_type:7,media:{file_info:'file-A'},msg_id:'source',msg_seq:23});
 assert.ok(calls.every(c=>c.init.headers.Authorization==='QQBot token'&&c.init.redirect==='manual'));assert.equal((await row(e)).status,'sent');assert.equal((await all(e,'outbox_attempts'))[0].http_status,200);
});
test('G6 expired/missing/invalid passive source or missing msg_id is skipped without any request',async()=>{
 for(const mode of ['expired','boundary','missing','invalid','id']){
  const e=await fixture(),o=await row(e);let s=source();if(mode==='expired')s.ts=new Date(Date.now()-241000).toISOString();if(mode==='boundary')s.ts=new Date(Date.now()-240000).toISOString();if(mode==='missing')s=null;if(mode==='invalid')s.ts='invalid';if(mode==='id')o.msg_id=null;
  const {calls}=await qqMock(()=>send(e,o,s));assert.equal(calls.length,0,mode);assert.equal((await row(e)).status,'skipped',mode);
 }
});
test('G6 window expiring during upload prevents media send',async()=>{
 const e=await fixture(),o=await row(e),s=source(),real=Date.now;let now=real();Date.now=()=>now;
 try{const {calls}=await qqMock(()=>send(e,o,s),{upload:()=>{now+=241000;return Response.json({file_info:'uploaded',ttl:7200});}});assert.equal(calls.length,1);assert.equal((await row(e)).status,'skipped');}finally{Date.now=real;}
});
test('G7 upload failure, rejection, redirect and network uncertainty are terminal and never retry',async()=>{
 for(const mode of ['http','not-accepted','redirect','network','message-http','message-code','message-network','message-conflict']){
  const e=await fixture(),o=await row(e);
  const upload=()=>{if(mode==='http')return Response.json({code:123},{status:400});if(mode==='not-accepted')return Response.json({code:123,file_info:'bad'});if(mode==='redirect')return new Response(null,{status:302,headers:{location:'https://elsewhere.test'}});if(mode==='network')throw Error('uncertain');return Response.json({file_info:'file-A',ttl:7200});};
  const response=()=>{if(mode==='message-network')throw Error('uncertain');if(mode==='message-code')return Response.json({code:123});if(mode==='message-conflict')return Response.json({id:'bad',code:123});return Response.json({code:123},{status:400});};
  const {calls}=await qqMock(async()=>{await send(e,o);await send(e,o);},{upload,send:response});
  assert.equal((await row(e)).status,'failed',mode);assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,1,mode);assert.equal(calls.filter(c=>c.url.endsWith('/messages')).length,mode.startsWith('message-')?1:0,mode);
 }
});
test('G7 concurrent senders claim one attempt',async()=>{
 const e=await fixture(),o=await row(e),{calls}=await qqMock(()=>Promise.all([send(e,o),send(e,o)]));assert.equal(calls.length,2);assert.equal((await row(e)).status,'sent');assert.equal((await all(e,'outbox_attempts')).length,1);
});
test('G8 cached file_info is reused until one-minute safety margin, then reuploaded',async()=>{
 for(const stale of [false,true]){
  const e=await fixture();await e.DB.prepare('UPDATE generated_images SET file_info=?,file_info_expires=?').bind('cached',Date.now()+(stale?59000:120000)).run();
  const o=await row(e),{calls}=await qqMock(()=>send(e,o));assert.equal(calls.filter(c=>c.url.endsWith('/files')).length,stale?1:0);assert.equal(calls.at(-1).body.media.file_info,stale?'file-A':'cached');
 }
});
test('G8 missing/zero TTL defaults to one hour',async()=>{
 for(const ttl of [undefined,0]){const e=await fixture(),o=await row(e);await qqMock(()=>send(e,o),{upload:()=>Response.json({file_info:'fresh',ttl})});const image=(await all(e,'generated_images'))[0];assert.ok(image.file_info_expires>=Date.now()+3599000);assert.ok(image.file_info_expires<=Date.now()+3601000);}
});
test('G9 cross-group image reference and expired data are refused without contacting QQ',async()=>{
 for(const mode of ['group','expired','missing']){
  const e=await fixture(),o=await row(e);if(mode==='group')o.group_id='B';if(mode==='expired')await e.DB.prepare('UPDATE generated_images SET expires_at=0').run();if(mode==='missing')o.meta=JSON.stringify({gen_image:'absent'});
  const {calls}=await qqMock(()=>send(e,o));assert.equal(calls.length,0);assert.equal((await row(e)).status,'failed');
 }
});
test('worker outbox routes generated image meta to rich media, never plain placeholder text',async()=>{
 const e=await fixture();e.QQ_APP_ID='generated-test-app';await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)').bind('source','A','member','帮我生成一张猫',new Date().toISOString(),1,0).run();
 const {calls}=await qqMock(()=>worker.queue({messages:[{body:{id:'absent-job'},ack(){}}]},e));assert.equal(calls.filter(c=>c.body.msg_type===7).length,1);assert.equal(calls.filter(c=>c.body.msg_type===0).length,0);assert.equal((await row(e)).status,'sent');
});
