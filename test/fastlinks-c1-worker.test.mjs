import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,writeFileSync,unlinkSync} from 'node:fs';
import {env,worker,req,qq,msg} from './support.mjs';
import {runJob} from '../runner/fetcher.mjs';
import {twoPages} from './fixtures/bili-pages.mjs';
const out=`.wrangler/c1-worker-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/fetchjobs"; export {readUrl,jinaOk} from "./src/semantic"; export {titleMissMaterial} from "./src/bilititle";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile:out});
const api=await import('../'+out);
const legacyPath=`runner/.legacy-c1-${process.pid}.mjs`;
let old;
try{writeFileSync(legacyPath,readFileSync('test/fixtures/legacy/fetcher-0f67b28.mjs'));old=await import('../'+legacyPath);}finally{unlinkSync(legacyPath);}
const BV='BV1xx411c7mD',titleRef='t-0123456789abcdef';
const resource=(page=1)=>'resource:v1:bili:'+BV+':p:'+page;
const note=async(e,key)=>{const row=await e.DB.prepare('SELECT body FROM media_notes WHERE id=?').bind(key).first();return row?JSON.parse(row.body):null;};
const allNotes=async e=>(await e.DB.prepare('SELECT * FROM media_notes').all()).results;
const sample={bvid:BV,title:'第一页标题',subtitle:'第一页字幕',page:1,pages:2,aid:170001};
async function seed(e,{kind='bv',base=BV,page=1}={}){
  const ref=base+(page>1?'~p'+page:''),id='c1-'+crypto.randomUUID(),payload={v:2,type:'bili',tier:'light',ref,kind,base,page,lease:crypto.randomUUID(),waiters:[],...(kind==='title'?{title:'第一页标题'}:{})};
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,lease_until,created_at) VALUES(?,'fetch',?,'running',?,?)").bind(id,JSON.stringify(payload),Date.now()+120000,Date.now()).run();return {id,payload};
}
async function submit(e,job,body){return api.reportFetch(e,{id:job.id,lease:job.payload.lease,...body});}
const jobError=async(e,id)=>(await e.DB.prepare('SELECT error FROM jobs WHERE id=?').bind(id).first()).error;

test('C1-L5 claim negotiates v2, page two caches separately and a wrong page is invalid',async()=>{
  const e=env();await api.requestBili(e,BV+'~p2','light','w');
  const claimed=await (await api.fetchRoute(e,'/api/runner/fetch/claim',{})).json();assert.equal(claimed.proto,2);
  assert.equal(claimed.job.payload.page,2);
  await runJob(claimed.job,twoPages().client,async(_p,b)=>assert.equal((await api.reportFetch(e,b)).status,200),()=>{},async()=>{},claimed.proto);
  assert.equal((await note(e,resource(2))).subtitle,'第二页字幕');assert.equal(await note(e,resource()),null);
  const bad=await seed(e,{page:2});assert.equal((await submit(e,bad,{proto:2,success:true,result:sample})).status,200);
  assert.equal(await jobError(e,bad.id),'invalid');
  assert.equal((await note(e,resource(2))).subtitle,'第二页字幕');assert.equal(await note(e,resource()),null);
});

test('C1-L6 actual old runner success on aid returns runner_outdated and no resource',async()=>{
  const e=env(),job=await seed(e,{kind:'aid',base:'av170001'}),f=twoPages({clientFactory:old.createFetchClient});let report;
  await old.runJob(job,f.client,async(_p,b)=>{report=b;assert.equal((await api.reportFetch(e,b)).status,200);});
  assert.equal(report.success,true);assert.equal(report.proto,undefined);assert.equal(report.result.page,undefined);
  assert.equal(await jobError(e,job.id),'runner_outdated');assert.equal((await allNotes(e)).length,0);
});
test('C1-L7 actual old runner failure on page two becomes runner_outdated',async()=>{
  const e=env(),job=await seed(e,{page:2});let report;
  await old.runJob(job,twoPages({clientFactory:old.createFetchClient}).client,async(_p,b)=>{report=b;assert.equal((await api.reportFetch(e,b)).status,200);});
  assert.equal(report.reason,'视频内容未读到');assert.equal(await jobError(e,job.id),'runner_outdated');assert.equal((await allNotes(e)).length,0);
});
test('C1-L8 actual old runner BV/title success is accepted; title miss is a failure with original material',async()=>{
  for(const [kind,base,searchMiss] of [['bv',BV,false],['title',titleRef,false],['title',titleRef,true]]){
    const e=env(),job=await seed(e,{kind,base});
    await old.runJob(job,twoPages({searchMiss,clientFactory:old.createFetchClient}).client,async(_p,b)=>assert.equal((await api.reportFetch(e,b)).status,200));
    if(searchMiss){
      assert.equal(await jobError(e,job.id),'not_found');assert.equal((await note(e,'failure:v1:bili:'+base)).miss,'none');
      const cached=await api.biliCached(e,base);assert.equal(cached.miss,'none');
      assert.equal(api.videoMaterial(cached,base).material,api.titleMissMaterial(cached,4000));
    }else {assert.equal(await jobError(e,job.id),null);assert.equal((await note(e,resource())).page,1);assert.deepEqual(await note(e,'alias:v1:bili:'+base),{bvid:BV,page:1});}
    assert.equal((await allNotes(e)).some(n=>n.id.startsWith('bili:')),false);
  }
});
test('C1-L8 incompatible old failures include short and risk overrides runner_outdated',async()=>{
  for(const [reason,want] of [['视频内容未读到','runner_outdated'],['风控','risk']]){
    const e=env(),job=await seed(e,{kind:'short',base:'AbCd12',page:0});
    assert.equal((await submit(e,job,{success:false,reason})).status,200);assert.equal(await jobError(e,job.id),want);
    if(want==='risk')assert.ok((await note(e,'failure:v1:bili:AbCd12')).until>Date.now()+590000);
  }
});
test('C1-L10 old BV cache is first-page only and a page-two request creates its own job',async()=>{
  const e=env();await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:'+BV,JSON.stringify(sample),new Date().toISOString()).run();
  assert.equal((await api.biliCached(e,BV)).subtitle,'第一页字幕');assert.equal(await api.biliCached(e,BV+'~p2'),null);
  await api.requestBili(e,BV+'~p2','light','w');
  assert.equal(JSON.parse((await e.DB.prepare('SELECT payload FROM jobs').first()).payload).page,2);
});
test('C1 targetIn preserves aid, explicit page, source and unresolved short page',async()=>{
  for(const [b,ref,kind,page] of [[{aid:'av170001'},'av170001','aid',1],[{bvid:BV,page:3},BV+'~p3','bv',3],[{short:'AbCd12',page:0},'AbCd12','short',0]]){
    const target=api.videoTarget([],{id:'source',mentioned:1,meta:{bili:[b]}},[],{bili:{enabled:true}});
    assert.equal(target?.ref,ref);assert.equal(target?.target.kind,kind);assert.equal(target?.target.page,page);assert.equal(target?.target.sourceId,'source');
  }
  const e=env();await assert.rejects(api.requestBili(e,titleRef+'~p2','light','w'));
  for(const ref of ['av1',BV+'~p3']){await api.requestBili(e,ref,'light','w');const payload=JSON.parse((await e.DB.prepare('SELECT payload FROM jobs WHERE id=?').bind('fetch-bili-'+ref).first()).payload);assert.equal(payload.v,2);assert.equal(payload.ref,ref);assert.equal(payload.page,ref==='av1'?1:3);}
});
test('C1 resource cache and short aliases bypass fetch creation in real Worker turns',async()=>{
  for(const url of ['https://www.bilibili.com/video/'+BV+'?p=2','https://b23.tv/AbCd12']){
    const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
    await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind(resource(2),JSON.stringify({...sample,page:2,subtitle:'第二页字幕'}),new Date().toISOString()).run();
    await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('alias:v1:bili:AbCd12',JSON.stringify({bvid:BV,page:2}),new Date().toISOString()).run();
    const saved=globalThis.fetch;globalThis.fetch=async()=>Response.json({choices:[{message:{content:'{"mode":"work","text":"第二页内容。"}'}}]});
    try{await qq(e,msg('cache','总结 '+url),'GROUP_AT_MESSAGE_CREATE');await worker.queue({messages:[{body:{id:'chat-cache'},ack(){}}]},e);}finally{globalThis.fetch=saved;}
    assert.equal((await e.DB.prepare("SELECT * FROM jobs WHERE kind='fetch'").all()).results.length,0);
    assert.ok((await allNotes(e)).find(n=>n.id==='msgref:v1:cache'));
  }
});
test('C1 short legacy cache is ignored and alias/resource TTL is enforced',async()=>{
  const e=env();await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:AbCd12',JSON.stringify(sample),new Date().toISOString()).run();
  assert.equal(await api.biliCached(e,'AbCd12'),null);
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind(resource(2),JSON.stringify({...sample,page:2}),new Date().toISOString()).run();
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('alias:v1:bili:AbCd12',JSON.stringify({bvid:BV,page:2}),new Date().toISOString()).run();
  assert.equal((await api.biliCached(e,'AbCd12')).page,2);
  await e.DB.prepare('UPDATE media_notes SET created_at=? WHERE id=?').bind(new Date(Date.now()-8*86400000).toISOString(),resource(2)).run();
  assert.equal(await api.biliCached(e,'AbCd12'),null);
  await e.DB.prepare('UPDATE media_notes SET body=? WHERE id=?').bind('broken','alias:v1:bili:AbCd12').run();
  assert.equal(await api.biliCached(e,'AbCd12'),null);
});
test('C1 v2 failure reasons are strict, ambiguity caches and invalid page metadata never writes a resource',async()=>{
  for(const [body,want] of [[{success:false,reason:'unsupported'},'invalid'],[{success:false,reason:'风控'},'invalid'],[{success:false,reason:'ambiguous'},'ambiguous'],[{success:true,result:{...sample,page:0}},'invalid'],[{success:true,result:{...sample,page:3}},'invalid']]){
    const e=env(),job=await seed(e);assert.equal((await submit(e,job,{proto:2,...body})).status,200);assert.equal(await jobError(e,job.id),want);
    assert.equal(await note(e,resource()),null);
    if(want==='ambiguous')assert.ok((await note(e,'failure:v1:bili:'+BV)).until>Date.now()+590000);
  }
});
for(const title of ['Sign in to GitHub · GitHub','Sign in · GitHub','登录 - Example','Page not found · GitHub'])test('C1 private GitHub and login pages never become successful material: '+title,async()=>{
  const save=globalThis.fetch;globalThis.fetch=async url=>String(url).includes('raw.githubusercontent.com')?new Response('',{status:404}):new Response('Title: '+title+'\nMarkdown Content:\n'+('Sign in\nUsername or email address\nPassword\nForgot password?\n'.repeat(40)));
  try {const r=await api.readUrl(env(),'https://github.com/example/private',{purpose:'inline',deadline:Date.now()+3000});assert.equal(r.ok,false);assert.ok(['not_found','login_required','needs_login'].includes(r.reason));}finally{globalThis.fetch=save;}
});
test('C1 private/login pages remain failures through the research fallback',async()=>{
  const login='# Sign in to GitHub\nUsername or email address\nPassword\nForgot password?\n'+'Footer navigation\n'.repeat(100);
  const save=globalThis.fetch;globalThis.fetch=async url=>String(url).includes('raw.githubusercontent.com')?new Response('',{status:404}):String(url).includes('r.jina.ai')?new Response('Title: Sign in to GitHub · GitHub\nMarkdown Content:\n'+login):Response.json({content:login});
  try {const r=await api.readUrl({DEEPSEEK_API_KEY:'fixture'},'https://github.com/example/private',{purpose:'research',deadline:Date.now()+15000});assert.equal(r.ok,false);assert.equal(r.reason,'login_required');}finally{globalThis.fetch=save;}
});
test('C1 legacy title miss cache keeps its original one-day TTL',async()=>{
  const e=env(),fetched_at=new Date().toISOString();
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('bili:'+titleRef,JSON.stringify({miss:'none',fetched_at}),new Date(Date.now()-23*3600000).toISOString()).run();
  assert.equal((await api.biliCached(e,titleRef)).miss,'none');
  await e.DB.prepare('UPDATE media_notes SET created_at=?').bind(new Date(Date.now()-25*3600000).toISOString()).run();assert.equal(await api.biliCached(e,titleRef),null);
});
test('C1 title and BV reports with proto2 cannot alias an unrelated page or video',async()=>{
  for(const [target,result] of [[{kind:'title',base:titleRef},{...sample,page:2}],[{}, {...sample,bvid:'BV1234567890'}]]){
    const e=env(),job=await seed(e,target);assert.equal((await submit(e,job,{proto:2,success:true,result})).status,200);
    assert.equal(await jobError(e,job.id),'invalid');assert.equal((await allNotes(e)).length,0);
  }
});
test('C1 reports without handshake always normalize to first-page legacy semantics',async()=>{
  for(const target of [{},{kind:'title',base:titleRef}]){
    const e=env(),job=await seed(e,target);
    assert.equal((await submit(e,job,{success:true,result:{...sample,page:2}})).status,200);
    assert.equal((await note(e,resource()))?.page,1);assert.equal(await note(e,resource(2)),null);
  }
});
