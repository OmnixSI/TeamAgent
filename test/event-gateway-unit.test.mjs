import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {recoverDeliveries,deliverFiles} from '../runner/delivery.mjs';

// Execute the real gateway entrypoint with synthetic configuration and an SDK boundary stub.
// Never import its installed runtime or read a real config, session or secret file.
const original=fs.readFileSync(new URL('../runner/qq-gateway.mjs',import.meta.url),'utf8');
const source=original.replace(/^import .* from .*;\r?\n/gm,'')
 .replace(/const sdk = await import\([\s\S]*?\n\);/,'const sdk = __sdk;');
assert.doesNotMatch(source,/^\s*import\s/m);assert.ok(source.includes('const sdk = __sdk;'));
const AsyncFunction=Object.getPrototypeOf(async()=>{}).constructor;
const run=new AsyncFunction('fs','os','path','crypto','__sdk','recoverDeliveries','deliverFiles','fetch','setInterval','setTimeout','process','console','Date',source);

async function gateway({root=fs.mkdtempSync('/tmp/event-v2-gateway-'),offline=false,uploadFailure=false}={}){
 const home=path.join(root,'.inkboard-team'),handlers=new Map(),timers=[],posts=[],sdkCalls=[],uploads=[],sent=[],clock={now:Date.now()};
 let sdkOptions;
 const state={offline,uploadFailure};
 const fixtureFs={...fs,readFileSync(file,...args){
  if(file===path.join(home,'config.json'))return Buffer.from(JSON.stringify({url:'https://synthetic.invalid',runnerToken:'synthetic-runner'}));
  if(file===path.join(home,'worker-secrets.json'))return Buffer.from(JSON.stringify({QQ_APP_ID:'synthetic-app',QQ_APP_SECRET:'synthetic-not-a-credential'}));
  return fs.readFileSync(file,...args);
 }};
 class QQBot{
  constructor(options){sdkOptions=options;}
  on(type,handler){handlers.set(type,handler);return this;}
  async start(){}
  async sendFile(target,options){
   sdkCalls.push({target,options});
   // Model the pinned SDK's >=5 MiB chunked-upload boundary; no upload logic is added to delivery.
   const size=fs.statSync(options.localPath).size;
   uploads.push({stage:'prepare',size});
   if(state.uploadFailure)throw Object.assign(Error('synthetic SDK upload failure'),{stage:'upload'});
   const fd=fs.openSync(options.localPath,'r'),buffer=Buffer.alloc(1024*1024);
   try{
    let offset=0;
    while(offset<size){const bytes=fs.readSync(fd,buffer,0,Math.min(buffer.length,size-offset),offset);assert.ok(bytes>0);uploads.push({stage:'part',bytes});offset+=bytes;}
   }finally{fs.closeSync(fd);}
   uploads.push({stage:'finish'});sent.push(target);return {id:'synthetic-native-file'};
  }
 }
 const request=async(url,init)=>{
  const body=JSON.parse(init.body);posts.push({url:String(url),body});
  if(String(url).endsWith('/api/qq/events'))return Response.json({op:12},{status:state.offline?503:200});
  if(String(url).endsWith('/delivery-target'))return Response.json({group_id:'G'});
  return Response.json({ok:true});
 };
 const fixtureCrypto={...crypto,createPrivateKey:()=>({synthetic:true}),sign:()=>Buffer.from([0])};
 const fixtureProcess={on(){},exit(code){assert.fail('unexpected gateway exit '+code);}};
 class Clock extends Date{static now(){return clock.now;}}
 await run(fixtureFs,{homedir:()=>root},path,fixtureCrypto,{QQBot},recoverDeliveries,options=>deliverFiles({...options,now:clock.now}),request,
  (fn,ms)=>{timers.push({fn,ms});return {};},()=>({unref(){}}),fixtureProcess,{log(){}},Clock);
 return {root,home,handlers,timers,posts,sdkCalls,uploads,sent,state,clock,sdkOptions,
  emit:async(type,data)=>{const handler=handlers.get('rawEvent');assert.equal(typeof handler,'function','gateway must subscribe to SDK rawEvent');await handler({eventType:type,data});},
  flush:()=>timers[0].fn(),deliver:()=>timers[1].fn(),clean:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const notices=['GROUP_ADD_ROBOT','GROUP_DEL_ROBOT','GROUP_MSG_REJECT','GROUP_MSG_RECEIVE'];
const packets=g=>g.posts.filter(p=>p.url.endsWith('/api/qq/events')).map(p=>p.body);

test('P7 SDK rawEvent relays all four notices without manufacturing an actor',async()=>{
 const g=await gateway();try{
  for(const [i,type] of notices.entries()){
   const data={group_openid:'G',timestamp:'2026-11-13T00:00:0'+i+'Z'};
   await g.emit(type,data);assert.deepEqual(packets(g).at(-1),{op:0,t:type,d:data});
  }
  assert.equal(packets(g).length,4);
 }finally{g.clean();}
});
test('P7 SDK message events and other raw types are not relayed twice',async()=>{
 const g=await gateway();try{
  for(const type of ['GROUP_MESSAGE_CREATE','GROUP_AT_MESSAGE_CREATE','C2C_MESSAGE_CREATE','UNKNOWN'])await g.emit(type,{group_openid:'G',id:'m'});
  assert.equal(packets(g).length,0);
  await g.handlers.get('message')({message:{kind:'group',messageId:'m',rawEventType:'GROUP_MESSAGE_CREATE',raw:{id:'m',group_openid:'G'}}});
  await g.handlers.get('message')({message:{kind:'private',messageId:'p',rawEventType:'C2C_MESSAGE_CREATE',raw:{id:'p'}}});
  assert.equal(packets(g).length,1);
 }finally{g.clean();}
});
test('P7 notice spool key uses type, group and timestamp or event ID, never messageId',async()=>{
 const g=await gateway({offline:true});try{
  const a={group_openid:'G',timestamp:123},b={group_openid:'G',id:'notice-id'};
  await g.emit(notices[0],a);await g.emit(notices[0],a);await g.emit(notices[1],a);await g.emit(notices[2],b);
  const names=fs.readdirSync(path.join(g.home,'qq-spool')).sort();
  const keys=[notices[0]+':G:123',notices[1]+':G:123',notices[2]+':G:notice-id'];
  assert.deepEqual(names,keys.map(key=>crypto.createHash('sha256').update(key).digest('hex')+'.json').sort());
 }finally{g.clean();}
});
test('P7 an offline notice survives gateway restart and is replayed from durable spool',async()=>{
 const first=await gateway({offline:true});try{
  const data={group_openid:'G',id:'notice-replay'};await first.emit(notices[3],data);
  assert.equal(fs.readdirSync(path.join(first.home,'qq-spool')).length,1);
  const second=await gateway({root:first.root});await second.flush();
  assert.deepEqual(packets(second),[{op:0,t:notices[3],d:data}]);assert.deepEqual(fs.readdirSync(path.join(first.home,'qq-spool')),[]);
 }finally{first.clean();}
});
test('P7 group binding is deliberately enforced by Worker receive, not guessed by the gateway',async()=>{
 const g=await gateway();try{
  await g.emit(notices[0],{group_openid:'G',id:'one'});await g.emit(notices[0],{group_openid:'OTHER',id:'two'});
  assert.deepEqual(packets(g).map(p=>p.d.group_openid),['G','OTHER']);
  await g.emit(notices[0],{id:'missing-group'});assert.equal(packets(g).length,2);
 }finally{g.clean();}
});
function stagedFile(g,bytes=10*1024*1024){
 const root=path.join(g.home,'utility'),outputs=path.join(root,'_deliveries','a'.repeat(32),'outputs'),dir=path.join(g.home,'file-deliveries');
 fs.mkdirSync(outputs,{recursive:true});fs.mkdirSync(dir,{recursive:true});
 const file=path.join(outputs,'大文件.bin'),fd=fs.openSync(file,'w');try{fs.ftruncateSync(fd,bytes);}finally{fs.closeSync(fd);}
 const manifest=path.join(dir,'large.json');fs.writeFileSync(manifest,JSON.stringify({id:'delivery-large',message:'source',files:[file]}));
 return {root,dir,file,manifest,realFile:fs.realpathSync(file)};
}
test('P7 a 10 MiB native file reaches the SDK chunked boundary intact and is cleaned only after confirmation',async()=>{
 const g=await gateway();try{
  const f=stagedFile(g);await g.deliver();
  assert.equal(g.sdkCalls.length,1);assert.deepEqual(g.sdkCalls[0],{target:{scope:'group',targetId:'G'},options:{localPath:f.realFile}});
  const parts=g.uploads.filter(u=>u.stage==='part');assert.equal(parts.length,10);assert.equal(parts.reduce((n,p)=>n+p.bytes,0),10*1024*1024);
  assert.equal(g.sent.length,1);assert.deepEqual(g.posts.filter(p=>p.url.endsWith('/delivery/report')).map(p=>p.body.status),['sent']);
  assert.equal(fs.existsSync(f.file),false);assert.deepEqual(fs.readdirSync(f.dir),[]);
 }finally{g.clean();}
});
test('P7 SDK upload failure stays unknown, never resends, notifies once at the maintenance limit and retains artifacts until expiry',async()=>{
 const g=await gateway({uploadFailure:true});try{
  const f=stagedFile(g);await g.deliver();
  assert.equal(JSON.parse(fs.readFileSync(f.manifest+'.unknown')).status,'unknown');assert.ok(fs.existsSync(f.file));
  assert.equal(g.posts.filter(p=>p.url.endsWith('/delivery/report')).length,0);assert.equal(g.sent.length,0);
  await g.deliver();await g.deliver();await g.deliver();
  const reports=g.posts.filter(p=>p.url.endsWith('/delivery/report')).map(p=>p.body);
  assert.equal(g.sdkCalls.length,1);assert.equal(reports.length,1);assert.equal(reports[0].status,'unknown');assert.equal(reports[0].sent_count,0);
  assert.equal(reports[0].attempts,3);assert.equal(reports[0].exhausted,true);assert.deepEqual(reports[0].unconfirmed_files,['大文件.bin']);
  assert.ok(fs.existsSync(f.file));g.clock.now=reports[0].retain_until+1;await g.deliver();
  assert.equal(g.sdkCalls.length,1);assert.equal(g.posts.filter(p=>p.url.endsWith('/delivery/report')).length,1);
  assert.equal(fs.existsSync(f.file),false);assert.deepEqual(fs.readdirSync(f.dir),[]);
 }finally{g.clean();}
});
