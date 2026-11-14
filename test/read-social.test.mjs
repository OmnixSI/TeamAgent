import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env,req,worker} from './support.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createReachAdapter} from '../runner/reach-adapter.mjs';
import {runJob} from '../runner/fetcher.mjs';
await build({entryPoints:['src/reachjobs.ts','src/tools/read-social.ts','src/toolkit.ts'],bundle:true,format:'esm',platform:'browser',outdir:'.wrangler/f9-'+process.pid});
const jobs=await import('../.wrangler/f9-'+process.pid+'/reachjobs.js');
const {readSocialTool,resolveSocialTarget,REACH_BOUNDARY_TEXT}=await import('../.wrangler/f9-'+process.pid+'/tools/read-social.js');
const toolkit=await import('../.wrangler/f9-'+process.pid+'/toolkit.js');
const url='https://www.xiaohongshu.com/explore/abc?xsec_token=SIGNED_VALUE';
const ctx={context:{latest:{id:'m1',group_id:'g1',body:'帮我读这个 '+url},mentioned:true},messages:[],isTainted:()=>false};
const setting=(e,key,value)=>e.DB.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').bind(key,value).run();
async function ready(){const e=env();await setting(e,'reach:mode','on');await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)').bind('m1','g1','hongming',ctx.context.latest.body,new Date().toISOString()).run();return e;}
const call=(e,args={url})=>readSocialTool.run(e,args,ctx);
const runner=(e,path,b={})=>req(e,'/api/runner/fetch/'+path,b,'runner-secret');
test('registered untrusted read_social is off by default, global and channel switches apply before queueing',async()=>{
 assert.ok(toolkit.findExtraTool('read_social').untrusted);assert.match(REACH_BOUNDARY_TEXT,/风险/);
 const e=env();assert.equal((await call(e)).error_kind,'tool_not_ready');
 await setting(e,'reach:mode','on');for(const key of ['off:reach','off:reach:xiaohongshu']){await setting(e,key,'1');assert.equal((await call(e)).error_kind,'tool_not_ready');await setting(e,key,'0');}
 assert.equal((await e.DB.prepare("SELECT count(*) n FROM jobs").first()).n,0);
});
test('trial §4 dedicated URL actions precede generic read and signed short links are preserved only for execution',async()=>{
 assert.deepEqual(await resolveSocialTarget({url:'https://x.com/alice/status/123'}),{channel:'x',action:'thread',target:'https://x.com/alice/status/123'});
 assert.deepEqual(await resolveSocialTarget({url:'https://x.com/CBSNews/status/2054921950263116053/photo/1'}),{channel:'x',action:'thread',target:'https://x.com/CBSNews/status/2054921950263116053'});
 assert.deepEqual(await resolveSocialTarget({url:'https://x.com/i/web/status/2103288108360069344'}),{channel:'x',action:'thread',target:'https://x.com/i/web/status/2103288108360069344'});
 assert.deepEqual(await resolveSocialTarget({url:'https://x.com/elonmusk'}),{channel:'x',action:'profile',target:'elonmusk'});
 await assert.rejects(resolveSocialTarget({url:'https://x.com/home'}));
 assert.equal((await resolveSocialTarget({url:'https://xueqiu.com/S/SH600519'})).action,'quote');
 const original=globalThis.fetch;let count=0;globalThis.fetch=async(u,o)=>{count++;assert.equal(o.redirect,'manual');return new Response('',{status:302,headers:{location:url}});};
 try{const r=await resolveSocialTarget({url:'https://xhslink.com/a/abc'});assert.equal(r.target,url);assert.equal(count,1);}finally{globalThis.fetch=original;}
 await assert.rejects(resolveSocialTarget({url:'https://xueqiu.com/123/456'}));
 await assert.rejects(resolveSocialTarget({url:'https://b23.tv/abc'}));
});
test('xiaohongshu short links must expand to a signed note URL, not a bare id',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response('',{status:302,headers:{location:'https://www.xiaohongshu.com/explore/6371c72a000000001501476b'}});
 try{await assert.rejects(resolveSocialTarget({url:'https://xhslink.com/a/abc'}));}finally{globalThis.fetch=original;}
});
test('reject arbitrary action/backend/command, SSRF redirects and non-requested background crawling',async()=>{
 const e=await ready();
 for(const args of [{url,action:'post'},{url,backend:'sh'},{url,argv:['sh']},{channel:'x',action:'setup',target:'x'},{url:'https://127.0.0.1'},{channel:'x',action:'search',target:'AI;whoami'}])assert.equal((await call(e,args)).error_kind,'unsupported');
 assert.equal((await readSocialTool.run(e,{url},{...ctx,context:{latest:{...ctx.context.latest,body:'随便聊聊'} }})).error_kind,'unsupported');
 const original=globalThis.fetch;globalThis.fetch=async()=>new Response('',{status:302,headers:{location:'http://127.0.0.1/private'}});
 try{await assert.rejects(resolveSocialTarget({url:'https://xhslink.com/a/abc'}));}finally{globalThis.fetch=original;}
});
test('queue is nonblocking, group scoped and signatures never enter result or cache identity',async()=>{
 const e=await ready();const first=await call(e);assert.equal(first.status,'queued');assert.doesNotMatch(JSON.stringify(first),/SIGNED_VALUE|xsec_token/);
 const changed=url.replace('SIGNED_VALUE','NEW_SIGNATURE');const repeat=await readSocialTool.run(e,{url:changed},{...ctx,context:{latest:{...ctx.context.latest,body:'读 '+changed}}});assert.equal(first.job_id,repeat.job_id);
 const another={...ctx,context:{latest:{...ctx.context.latest,id:'m2',group_id:'g2'}}};
 assert.notEqual((await readSocialTool.run(e,{url},another)).job_id,first.job_id);
 const p=JSON.parse((await e.DB.prepare('SELECT payload FROM jobs WHERE id=?').bind(first.job_id).first()).payload);assert.equal(p.source,'reach');assert.equal(p.target,url);
});
test('fake command executes claim → spawn → report → local reply, repeated report is idempotent',async t=>{
 const e=await ready(),queued=await call(e);const {job}=await(await runner(e,'claim')).json();assert.equal(job.id,queued.job_id);
 const stateDir=await mkdtemp(join(tmpdir(),'f9-2-'));t.after(()=>rm(stateDir,{recursive:true,force:true}));
 const adapter=createReachAdapter({stateDir,commands:{'xiaohongshu:read:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:()=>[process.execPath,'-e','console.log(JSON.stringify({ok:true,items:[{title:"标题",text:"真实的正文证据",author:"作者",cookie:"FAKE_SECRET"}]}))']}}});
 let sent;await runJob(job,{},async(path,b)=>{sent=b;const r=await runner(e,path,b);assert.equal(r.status,200);return r.json();},()=>{},async()=>{throw Error('must not use Bili auth');},undefined,{adapter});
 assert.equal((await runner(e,'report',sent)).status,200);
 const cached=await call(e);assert.equal(cached.ok,true);assert.equal(cached.items[0].text,'真实的正文证据');assert.doesNotMatch(JSON.stringify(cached),/cookie|FAKE_SECRET|SIGNED_VALUE/i);
 const raw=JSON.stringify((await e.DB.prepare('SELECT payload FROM jobs WHERE id=?').bind(job.id).first()).payload);assert.doesNotMatch(raw,/SIGNED_VALUE|xsec_token/);
 const replies=(await e.DB.prepare("SELECT * FROM jobs WHERE kind='reach_reply'").all()).results;assert.equal(replies.length,1);
 const seen=[];const original=globalThis.fetch;globalThis.fetch=async(_u,o)=>{seen.push(JSON.parse(o.body));return Response.json({choices:[{message:{content:'{"mode":"work","text":"已读到正文证据。"}'}}]});};
 try{await worker.queue({messages:[{body:{id:replies[0].id},ack(){}}]},e);}finally{globalThis.fetch=original;}
 const replyJob=await e.DB.prepare('SELECT status,error FROM jobs WHERE id=?').bind(replies[0].id).first();assert.equal(replyJob.status,'done',JSON.stringify(replyJob));assert.match(JSON.stringify(seen),/真实的正文证据/);assert.doesNotMatch(JSON.stringify(seen),/SIGNED_VALUE|xsec_token/);const out=await e.DB.prepare('SELECT body FROM outbox WHERE id=?').bind(replies[0].id).first();assert.ok(out,JSON.stringify(replyJob));assert.equal(out.body,'已读到正文证据。');
});
test('expired or superseded leases cannot cache results, wake replies or overwrite current job',async()=>{
 const e=await ready();await call(e);const old=(await(await runner(e,'claim')).json()).job;
 await e.DB.prepare('UPDATE jobs SET lease_until=0 WHERE id=?').bind(old.id).run();const newer=(await(await runner(e,'claim')).json()).job;
 const body={source:'reach',id:old.id,lease:old.payload.lease,result:{ok:true,items:[{text:'旧结果',author:'a'}]}};
 assert.equal((await runner(e,'report',body)).status,409);assert.equal((await runner(e,'heartbeat',{id:old.id,lease:old.payload.lease})).status,409);
 assert.equal((await e.DB.prepare('SELECT count(*) n FROM media_notes').first()).n,0);
 assert.equal((await runner(e,'report',{...body,lease:newer.payload.lease})).status,200);
 assert.equal((await runner(e,'report',body)).status,409);
});
test('worker persists circuit and rate deadlines, blocked reports cannot enter content cache',async()=>{
 const e=await ready();await setting(e,'reach:cooldown_ms','60000');await call(e);const {job}=await(await runner(e,'claim')).json();
 assert.equal((await runner(e,'report',{source:'reach',id:job.id,lease:job.payload.lease,result:{ok:false,error:{code:'SECURITY_BLOCK'}}})).status,200);
 const r=await readSocialTool.run(e,{channel:'xiaohongshu',action:'search',target:'AI'},{...ctx,context:{latest:{...ctx.context.latest,body:'搜小红书 AI'}}});assert.equal(r.error_kind,'platform_blocked');assert.ok(r.retry_after>0&&r.retry_after<=60);
 assert.equal((await e.DB.prepare('SELECT count(*) n FROM media_notes').first()).n,0);
});
test('turning reach off never disables the existing Bili claim/report contract',async()=>{
 const e=env();await setting(e,'off:reach','1');await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('bili','fetch',JSON.stringify({type:'bili',tier:'light',ref:'BV1xx411c7mD'}),Date.now()).run();
 const {job}=await(await runner(e,'claim')).json();assert.equal(job.payload.type,'bili');
});
test('switches stop queued reach jobs at claim time and prevent even short-link network requests',async()=>{
 const e=await ready();await call(e);await setting(e,'off:reach','1');
 assert.equal((await(await runner(e,'claim')).json()).job,null);
 const original=globalThis.fetch;globalThis.fetch=async()=>{assert.fail('disabled reader must not contact short links');};
 try{const short='https://xhslink.com/a/abc';const r=await readSocialTool.run(e,{url:short},{...ctx,context:{latest:{...ctx.context.latest,body:'读 '+short}}});assert.equal(r.error_kind,'tool_not_ready');}finally{globalThis.fetch=original;}
});
test('reach jobs cannot accept Bili reports and same-lease retries cannot change committed material',async()=>{
 const e=await ready();await call(e);const {job}=await(await runner(e,'claim')).json();
 assert.equal((await runner(e,'report',{id:job.id,lease:job.payload.lease,success:false})).status,409);
 const b={source:'reach',id:job.id,lease:job.payload.lease,result:{ok:true,items:[{author:'a',text:'原始正文'}]}};
 assert.equal((await runner(e,'report',b)).status,200);
 assert.equal((await runner(e,'report',{...b,result:{ok:true,items:[{author:'a',text:'重复回报改写正文'}]}})).status,200);
 assert.equal((await call(e)).items[0].text,'原始正文');
});
test('query article identities stay separate while signature changes reuse the same cache key',async()=>{
 const base={channel:'weixin',action:'read',target:'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=SIGNATURE'};
 const first=await jobs.reachKey('g1',base);
 assert.notEqual(await jobs.reachKey('g1',{...base,target:base.target.replace('mid=123','mid=456')}),first);
 assert.equal(await jobs.reachKey('g1',{...base,target:base.target.replace('SIGNATURE','OTHER')}),first);
});

test('x profile/tweets use the same lease-report path and report the honest loaded count',async()=>{
 const e=await ready();
 const xctx={...ctx,context:{latest:{id:'m1',group_id:'g1',body:'看下 @elonmusk 的最近推文'}}};
 const queued=await readSocialTool.run(e,{channel:'x',action:'tweets',target:'elonmusk'},xctx);
 assert.equal(queued.status,'queued');
 const {job}=await(await runner(e,'claim')).json();
 assert.equal(job.payload.channel,'x');assert.equal(job.payload.action,'tweets');assert.equal(job.payload.backend,'local');assert.equal(job.payload.source_url,'https://x.com/elonmusk');
 const result={ok:true,items:[{title:'Elon Musk',text:'最近一条推文',author:'elonmusk',source_url:'https://x.com/elonmusk/status/1',published_at:'2025-11-12T10:00:00.000Z'}]};
 assert.equal((await runner(e,'report',{source:'reach',id:job.id,lease:job.payload.lease,result})).status,200);
 const cached=await readSocialTool.run(e,{channel:'x',action:'tweets',target:'elonmusk'},xctx);
 assert.equal(cached.ok,true);assert.equal(cached.content_scope,'post_text');assert.equal(cached.meta.loaded,1);assert.equal(cached.source_url,'https://x.com/elonmusk');
 assert.equal(cached.items[0].author,'elonmusk');
});

test('F9-5 platform URLs route only to the registered read-only actions',async()=>{
 assert.deepEqual(await resolveSocialTarget({url:'https://weibo.com/u/1642591402'}),{channel:'weibo',action:'profile',target:'1642591402'});
 assert.deepEqual(await resolveSocialTarget({url:'https://www.zhihu.com/question/301/answer/401'}),{channel:'zhihu',action:'read',target:'https://www.zhihu.com/question/301/answer/401'});
 assert.deepEqual(await resolveSocialTarget({url:'https://www.douyin.com/video/7298145681699622182'}),{channel:'douyin',action:'read',target:'https://www.douyin.com/video/7298145681699622182'});
 assert.deepEqual(await resolveSocialTarget({url:'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=x'}),{channel:'weixin',action:'read',target:'https://mp.weixin.qq.com/s?__biz=abc&mid=123&idx=1&sn=x'});
});
