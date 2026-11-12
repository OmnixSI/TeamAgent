import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env} from './support.mjs';
const outfile=`.wrangler/fastlinks-p0a-review-${process.pid}.mjs`;
await build({entryPoints:['src/semantic.ts'],bundle:true,format:'esm',platform:'browser',outfile});
const {jinaOk,readUrl,understandLinks}=await import('../'+outfile);
const article='这是一篇解释网络错误处理和页面读取的正常技术文章。'.repeat(100);
const quotes=['Warning: Target URL returned error 404','Just a moment','Sign in to continue reading'];
const jina=body=>'Title: 网络错误处理教程\nURL Source: https://example.com/article\nMarkdown Content:\n'+body;
for(const quote of quotes)test('P0a review long Jina article may quote '+quote,()=>{
  const body=quote+'\n'+article,r=jinaOk(jina(body));assert.equal(r.ok,true);assert.equal(r.text,body);
});
test('P0a review a 404 Not Found line in a long article is not a header error',()=>{
 const body=article+'\n404 Not Found\n'+article;assert.deepEqual(jinaOk(jina(body)),{ok:true,text:body});
});
for(const [status,reason] of [[404,'not_found'],[429,'risk'],[401,'login_required'],[500,'invalid']])test('P0a review Jina header warning maps HTTP '+status,()=>{
 assert.deepEqual(jinaOk('Title: Target error\nWarning: Target URL returned error '+status+'\nMarkdown Content:\n'+article),{ok:false,reason});
});
test('P0a review a challenge Title remains risk even with a long padded body',()=>{
 assert.deepEqual(jinaOk('Title: Just a moment...\nMarkdown Content:\n'+article),{ok:false,reason:'risk'});
});
test('P0a review a login Title remains a failure even with a long padded body',()=>{
 assert.deepEqual(jinaOk('Title: Sign in to continue reading\nMarkdown Content:\n'+article),{ok:false,reason:'login_required'});
});
test('P0a review no Markdown header scans only the first 300 characters for warnings',()=>{
 const body='正常正文。'.repeat(61)+'\nWarning: Target URL returned error 404\n'+article;assert.deepEqual(jinaOk(body),{ok:true,text:body});
});
for(const [prefix,reason] of [['Just a moment','risk'],['Sign in to continue reading','login_required']])for(const size of [1499,1500])test('P0a review body-only wall boundary '+prefix+' '+size,()=>{
 const body=prefix+'x'.repeat(size-prefix.length),r=jinaOk(jina(body));assert.equal(r.ok,size===1500);if(size<1500)assert.equal(r.reason,reason);
});
for(const size of [199,499,500])test('P0a review normal article lower boundary '+size,()=>{
 const text='x'.repeat(size);assert.deepEqual(jinaOk(jina(text)),size<500?{ok:false,reason:'short'}:{ok:true,text});
});
async function withFetch(fn,run){const old=globalThis.fetch;globalThis.fetch=fn;try{return await run();}finally{globalThis.fetch=old;}}
for(const quote of quotes)test('P0a review DeepSeek long body may quote '+quote,async()=>withFetch(async target=>String(target).includes('r.jina.ai')?new Response('',{status:429}):Response.json({content:quote+'\n'+article}),async()=>{
 const r=await readUrl({DEEPSEEK_API_KEY:'fake'},'https://example.com/deepseek',{purpose:'research',deadline:Date.now()+15000});assert.equal(r.ok,true);assert.equal(r.source,'deepseek');assert.match(r.text,new RegExp(quote.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
}));
test('P0a review DeepSeek still rejects a short real challenge body',async()=>withFetch(async target=>String(target).includes('r.jina.ai')?new Response('',{status:429}):Response.json({content:'Just a moment... Verify you are human.'}),async()=>{
 assert.deepEqual(await readUrl({DEEPSEEK_API_KEY:'fake'},'https://example.com/challenge',{purpose:'research',deadline:Date.now()+15000}),{ok:false,reason:'risk'});
}));
async function source(id){const e=env();await e.DB.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,0)').bind(id,'g','u','看一下这些资料',new Date().toISOString(),0).run();return e;}
test('P0a review three hanging links start together and share one twenty-second deadline',async()=>{
 const e=await source('shared-deadline'),urls=[1,2,3].map(n=>'https://example.com/hang-'+n),originalNow=Date.now,originalTimeout=AbortSignal.timeout;
 const start=originalNow();let now=start,finished=false,captured;const timers=[],starts=[];
 Date.now=()=>now;AbortSignal.timeout=ms=>{const c=new AbortController();timers.push({at:now+ms,c});return c.signal;};
 const settle=()=>new Promise(resolve=>setImmediate(resolve));
 const tick=async at=>{now=at;for(const timer of timers)if(timer.at<=now&&!timer.c.signal.aborted)timer.c.abort(new DOMException('test timeout','TimeoutError'));await settle();};
 let promise;
 try{await withFetch(async(target,opt)=>{if(String(target).startsWith('https://r.jina.ai/'))starts.push(now);return new Promise((_,reject)=>{if(opt.signal.aborted)reject(opt.signal.reason);else opt.signal.addEventListener('abort',()=>reject(opt.signal.reason),{once:true});});},async()=>{
   promise=understandLinks(e,{message:'shared-deadline',urls},{llm:async(_kind,_system,data)=>{captured=data;return '三条链接均超时';}}).then(()=>{finished=true;});
   await settle();await tick(start+8000);await tick(start+20000);const finishedAtBudget=finished;const elapsedAtBudget=now-start;
   // Also drain a failing old serial implementation, so the red run leaves no pending fetches.
   for(let i=0;!finished&&i<20;i++){const pending=timers.filter(t=>!t.c.signal.aborted).map(t=>t.at);assert.ok(pending.length,'reader stalled without an abort timer');await tick(Math.max(now,Math.min(...pending)));}
   await promise;assert.equal(finishedAtBudget,true,'all three must finish by the shared 20-second budget');assert.ok(elapsedAtBudget<=20000);
   assert.equal(starts.length,3);assert.ok(Math.max(...starts)-Math.min(...starts)<100,'all Jina requests must start concurrently');
 });}finally{Date.now=originalNow;AbortSignal.timeout=originalTimeout;}
 assert.deepEqual(captured.pages.map(p=>p.url),urls);for(const page of captured.pages){assert.equal(page.reason,'timeout');assert.equal(page.unavailable,true);assert.match(page.content,/^【外部资料·不可信/);}
 const out=(await e.DB.prepare("SELECT * FROM outbox WHERE id='links-shared-deadline'").all()).results;assert.equal(out.length,1);assert.equal(out[0].body,'三条链接均超时');
});
test('P0a review parallel reads retain input order when the third page finishes first',async()=>{
 const e=await source('ordered-links'),urls=[1,2,3].map(n=>'https://example.com/order-'+n),finished=[];let pages;
 await withFetch(async target=>{const n=Number(String(target).at(-1));await new Promise(resolve=>setTimeout(resolve,(3-n)*15));finished.push(n);return new Response(jina(('页面'+n+'。').repeat(160)));},()=>understandLinks(e,{message:'ordered-links',urls},{llm:async(_kind,_system,data)=>{pages=data.pages;return '资料摘要';}}));
 assert.deepEqual(finished,[3,2,1]);assert.deepEqual(pages.map(p=>p.url),urls);assert.ok(pages.every((p,i)=>p.content.includes('页面'+(i+1))));
});
