import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createReachAdapter} from '../runner/reach-adapter.mjs';

const request={id:'job',lease:'lease',version:1,channel:'x',action:'thread',target:'https://x.com/alice/status/123',backend:'local',deadline_ms:2000};
const command=(code,resource='browser',extra={})=>({access:'read',resource,requires_login:true,content_scope:'post_text',argv:()=>[process.execPath,'-e',code],...extra});
const success='console.log(JSON.stringify({ok:true,items:[{text:"已读推文正文",author:"alice"}]}))';
async function setup(t,commands){const stateDir=await mkdtemp(join(tmpdir(),'f9-2-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));return {stateDir,adapter:createReachAdapter({commands,stateDir})};}
test('fixed read command succeeds; command injection and write actions cannot be constructed',async t=>{
 const {adapter,stateDir}=await setup(t,{'x:thread:local':command(success),'x:post:local':command(success,'api',{access:'write'})});
 assert.equal((await adapter.run(request)).ok,true);
 const write=createReachAdapter({stateDir,commands:{'x:thread:local':command(success,'browser',{access:'write'})}});
 const denied=await write.run(request);assert.equal(denied.ok,false);assert.equal(denied.error.error_kind,'unsupported');
 for(const patch of [{channel:'evil'},{action:'post'},{action:'setup'},{backend:'sh'},{access:'write'},{argv:['sh']},{target:'$(touch /tmp/f9-owned)'},{target:'https://x.com/a/status/123%3bwhoami'},{target:'https://x.com.evil/a/status/123'},{version:2}]){
  const r=await adapter.run({...request,...patch});assert.equal(r.ok,false);assert.equal(r.error.error_kind,'unsupported');
 }
});
test('trial §4 query never installs missing components or sends private pages to public providers',async t=>{
 const {adapter}=await setup(t,{'x:thread:public-web':command(success)});
 assert.equal((await adapter.run(request)).error.error_kind,'tool_not_ready');
 assert.equal((await adapter.run({...request,backend:'public-web'})).error.error_kind,'unsupported');
});
test('malformed requests fail with a sanitized envelope instead of throwing or echoing arbitrary metadata',async t=>{
 const {adapter}=await setup(t,{});
 for(const input of [null,undefined,{}, {...request,channel:'Cookie: FAKE_SECRET'}]){
  const r=await adapter.run(input);assert.equal(r.error.error_kind,'unsupported');assert.doesNotMatch(JSON.stringify(r),/cookie|FAKE_SECRET/i);
 }
});
test('hard deadline and cancellation kill the entire process group, including TERM-resistant descendants',async t=>{
 const marker='f9-2-descendant-'+crypto.randomUUID();
 const code=`const {spawn}=require('node:child_process');spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",${JSON.stringify(marker)}],{stdio:'inherit'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
 const {adapter}=await setup(t,{'x:thread:local':command(code)});
 const started=Date.now();assert.equal((await adapter.run({...request,deadline_ms:300})).error.error_kind,'timeout');assert.ok(Date.now()-started<2500);
 assert.equal(spawnSync('pgrep',['-f',marker]).status,1,'no descendant remains');
 const controller=new AbortController();const pending=adapter.run(request,{signal:controller.signal});setTimeout(()=>controller.abort(),100);
 assert.equal((await pending).error.error_kind,'timeout');assert.equal(spawnSync('pgrep',['-f',marker]).status,1);
});
test('stdout and stderr share a 1 MiB limit; output is discarded and explicitly marked',async t=>{
 const {adapter}=await setup(t,{'x:thread:local':command('process.stdout.write("a".repeat(700000));process.stderr.write("b".repeat(700000));setInterval(()=>{},1000)')});
 const r=await adapter.run(request);assert.equal(r.ok,false);assert.equal(r.meta.output_truncated,true);assert.ok(JSON.stringify(r).length<3000);
});
test('browser capacity is global across adapter instances and each site has only one reader',async t=>{
 const commands={'x:thread:local':command('setTimeout(()=>{'+success+'},250)'),'weibo:search:local':command(success,'browser',{content_scope:'search_results'})};
 const {adapter,stateDir}=await setup(t,commands);const other=createReachAdapter({commands,stateDir});
 const pending=adapter.run(request);
 assert.equal((await other.run({...request,channel:'weibo',action:'search',target:'AI'})).error.error_kind,'busy');
 await pending;assert.equal((await other.run(request)).ok,true);
});
test('ordinary API global capacity is two while per-site browser limit remains one',async t=>{
 const slow=command('setTimeout(()=>{'+success+'},200)','api',{requires_login:false,content_scope:'search_results'});
 const {adapter}=await setup(t,{'x:search:local':slow,'weibo:search:local':slow,'zhihu:search:local':slow});
 const a=adapter.run({...request,action:'search',target:'AI'}),b=adapter.run({...request,channel:'weibo',action:'search',target:'AI'});
 assert.equal((await adapter.run({...request,channel:'zhihu',action:'search',target:'AI'})).error.error_kind,'busy');await Promise.all([a,b]);
});
test('platform block and RATE_LIMITED survive adapter restart and prevent new process execution',async t=>{
 const {adapter,stateDir}=await setup(t,{'x:thread:local':command('console.log(JSON.stringify({ok:false,error:{code:"SECURITY_BLOCK"}}))')});
 assert.equal((await adapter.run(request)).error.error_kind,'platform_blocked');
 const after=createReachAdapter({stateDir,commands:{'x:thread:local':command(success)}});
 const r=await after.run(request);assert.equal(r.error.error_kind,'platform_blocked');assert.ok(r.error.retry_after>1700);
 assert.doesNotMatch(await readFile(join(stateDir,'cooldowns.json'),'utf8'),/x\.com|cookie|lease/i);
 const rate=await setup(t,{'x:thread:local':command('console.log(JSON.stringify({ok:false,error:{code:"RATE_LIMITED",retry_after:3600}}))')});
 await rate.adapter.run(request);assert.equal((await createReachAdapter({stateDir:rate.stateDir,commands:{'x:thread:local':command(success)}}).run(request)).error.error_kind,'rate_limited');
});
test('nonzero backend exits preserve structured risk codes instead of losing them as upstream errors',async t=>{
 const {adapter}=await setup(t,{'x:thread:local':command('console.log(JSON.stringify({ok:false,error:{code:"SECURITY_BLOCK"}}));process.exitCode=1')});
 assert.equal((await adapter.run(request)).error.error_kind,'platform_blocked');
});
test('runner SIGTERM cancellation reaps its detached command group before the runner exits',async t=>{
 const stateDir=await mkdtemp(join(tmpdir(),'f9-2-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const marker='f9-2-shutdown-'+crypto.randomUUID();
 const entry=new URL('../runner/reach-job.mjs',import.meta.url).href,adapterPath=new URL('../runner/reach-adapter.mjs',import.meta.url).href;
 const code=`import {runReachJob} from ${JSON.stringify(entry)};import {createReachAdapter} from ${JSON.stringify(adapterPath)};
 const adapter=createReachAdapter({stateDir:${JSON.stringify(stateDir)},commands:{'x:thread:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:()=>[process.execPath,'-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",${JSON.stringify(marker)}]}}});
 setTimeout(()=>console.log('READY'),150);await runReachJob({id:'job',payload:${JSON.stringify(request)}},async()=>{}, {adapter});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{try{child.kill('SIGKILL');}catch{}const p=spawnSync('pgrep',['-f',marker]);for(const pid of String(p.stdout||'').trim().split(/\s+/).filter(Boolean))try{process.kill(Number(pid),'SIGKILL');}catch{}});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 child.kill('SIGTERM');await exited;
 assert.equal(spawnSync('pgrep',['-f',marker]).status,1,'shutdown left a detached command');
});
