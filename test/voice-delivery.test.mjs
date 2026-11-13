import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {env,req} from './support.mjs';
const group='GROUP000001';
async function fixture(mode='ok') {
 const calls=[];const server=http.createServer(async(r,s)=>{
  let raw='';for await(const c of r)raw+=c;const body=JSON.parse(raw);calls.push({path:r.url,body,auth:r.headers.authorization});
  s.setHeader('Content-Type','application/json');
  if(r.url.endsWith('/files')){if(mode==='upload-fail'){s.writeHead(400);s.end('{"code":400}');}else s.end('{"file_info":"silk-file"}');}
  else if(mode==='unknown'&&body.msg_type===7)r.socket.destroy();
  else s.end('{"id":"sent-once"}');
 });server.listen(0,'127.0.0.1');await once(server,'listening');return {calls,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(r=>server.close(r))};
}
test('real outbox -> runner -> mock QQ SILK upload/send -> report; replay sends nothing twice',async()=>{
 const {processVoiceOutbox}=await import('../runner/voice-delivery.mjs');
 for(const mode of ['ok','tts-fail','upload-fail','unknown','report-lost','expires-during-upload']){
  const f=await fixture(mode),e=env();try{
   await e.DB.prepare(`CREATE TABLE IF NOT EXISTS ds_usage(id TEXT PRIMARY KEY,purpose TEXT,group_id TEXT,sender_id TEXT,status TEXT,error_kind TEXT,latency_ms INTEGER,units INTEGER,est_cost_micro_usd INTEGER,created_at INTEGER)`).run();
   await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind('m',group,'u','语音',new Date().toISOString(),1).run();
   await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('v',group,'m','测试通过了。','voice',Date.now()).run();
   await e.DB.prepare('INSERT INTO outbox_meta VALUES(?,?)').bind('v',JSON.stringify({sender:'u',cfg:{enabled:true}})).run();
   const cloud=async(path,b)=>{if(mode==='report-lost'&&path==='voice/report')throw Error('lost report');const r=await req(e,'/api/runner/'+path,b,'runner-secret');assert.equal(r.status,200);return r.json();};
   const {voiceReply}=await import('../runner/tts.mjs');
   let clock=Date.now();
   const deps={voiceReply,now:()=>clock,fetch:async(url,options)=>{const response=await fetch(url,options);if(mode==='expires-during-upload'&&url.endsWith('/files'))clock+=300000;return response;},token:'mock-token',qqBaseUrl:f.url,synthesize:async()=>mode==='tts-fail'?null:{path:'/fake.wav',provider:'edge'},wavToSilk:async()=>({ok:true,data:Buffer.from('\x02#!SILK_V3\0test'),duration_ms:1000})};
   await processVoiceOutbox({cloud,bot:{},deps});await processVoiceOutbox({cloud,bot:{},deps});
   const messages=f.calls.filter(c=>c.path.endsWith('/messages'));if(mode==='expires-during-upload'){assert.equal(messages.length,0);assert.equal((await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind('v').first()).status,'failed');continue;}
   assert.equal(messages.length,1,mode);
   const status=(await e.DB.prepare('SELECT status FROM outbox WHERE id=?').bind('v').first()).status;
   assert.equal(status,mode==='unknown'?'unknown':mode==='report-lost'?'voice_sending':'sent',mode);
   assert.equal(messages[0].body.msg_id,'m');assert.ok(messages[0].body.msg_seq>0);
   if(['ok','unknown','report-lost','expires-during-upload'].includes(mode)){
    assert.equal(messages[0].body.msg_type,7);assert.deepEqual(messages[0].body.media,{file_info:'silk-file'});
    const upload=f.calls[0];assert.equal(upload.body.file_type,3);assert.equal(upload.body.srv_send_msg,false);assert.equal(upload.auth,'QQBot mock-token');assert.equal(Buffer.from(upload.body.file_data,'base64').subarray(1,10).toString(),'#!SILK_V3');
   }else{assert.equal(messages[0].body.msg_type,0);assert.equal(messages[0].body.content,'测试通过了。');}
  }finally{await f.close();}
 }
});
