import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {build} from 'esbuild';
import {env} from './support.mjs';
import {createFetchClient,runJob,runFetchLoop} from '../runner/fetcher.mjs';

// Bundle the exact legacy source while resolving its unchanged imports in src/.
const output=`.wrangler/c1-legacy-${process.pid}.mjs`;
await build({entryPoints:['test/fixtures/legacy/fetchjobs-0f67b28.ts'],bundle:true,format:'esm',platform:'browser',outfile:output,
  plugins:[{name:'legacy-imports',setup(b){b.onResolve({filter:/^\.\//},args=>args.importer.endsWith('fetchjobs-0f67b28.ts')?{path:new URL('../src/'+args.path.slice(2)+'.ts',import.meta.url).pathname}:undefined);}}]});
const legacy=await import('../'+output);
const BV='BV1xx411c7mD';

function twoPages({fallback=false,searchMiss=false}={}){
  let time=10000;const calls=[];
  const request=(options,callback)=>{
    const req=new EventEmitter();
    req.end=()=>{
      calls.push(options);
      const url=new URL('https://'+options.host+options.path);
      let status=200,headers={},body={code:0,data:{}};
      if(options.host==='b23.tv'){status=fallback&&options.method==='HEAD'?405:302;headers.location='https://www.bilibili.com/video/'+BV+'?p=2';}
      else if(url.pathname.endsWith('/spi'))body={code:0,data:{b_3:'fixture-device'}};
      else if(url.pathname.endsWith('/nav'))body={code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+ 'b'.repeat(32)+'.png'}}};
      else if(url.pathname.endsWith('/search/type'))body={code:0,data:{result:searchMiss?[]:[{type:'video',bvid:BV,title:'第一页标题'}]}};
      else if(url.pathname.endsWith('/view'))body={code:0,data:{bvid:BV,aid:170001,title:'第一页标题',cid:202,pages:[{cid:101,part:'第一页标题'},{cid:202,part:'第二页标题'}]}};
      else if(url.pathname.endsWith('/v2'))body={code:0,data:{subtitle:{subtitles:[{lan:'zh-CN',subtitle_url:'https://a.hdslb.com/sub-'+url.searchParams.get('cid')}]}}};
      else if(options.host==='a.hdslb.com')body={body:[{content:url.pathname==='/sub-101'?'第一页字幕':'第二页字幕'}]};
      const res=new EventEmitter();res.statusCode=status;res.headers=headers;callback(res);
      queueMicrotask(()=>{res.emit('data',Buffer.from(JSON.stringify(body)));res.emit('end');});
    };
    req.destroy=()=>{};return req;
  };
  return {calls,client:createFetchClient({request,lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),now:()=>time,sleep:async ms=>{time+=ms;},random:()=>0})};
}

test('C1-L1 new runner and actual old Worker cache page one after a short redirect to p=2',async()=>{
  const e=env(),f=twoPages(),payload={type:'bili',tier:'light',ref:'AbCd12',lease:'fixture-lease',waiters:[]};
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,lease_until,created_at) VALUES(?,'fetch',?,'running',?,?)")
    .bind('c1-L1',JSON.stringify(payload),Date.now()+120000,Date.now()).run();
  await runJob({id:'c1-L1',payload},f.client,async(path,report)=>{
    assert.equal(path,'report');assert.equal(report.success,true);assert.equal(report.proto,undefined);
    assert.equal((await legacy.reportFetch(e,report)).status,200);
  });
  const cached=JSON.parse((await e.DB.prepare('SELECT body FROM media_notes WHERE id=?').bind('bili:'+BV).first()).body);
  assert.equal(cached.title,'第一页标题');assert.equal(cached.subtitle,'第一页字幕');
  const player=f.calls.find(c=>c.path.startsWith('/x/player/wbi/v2?'));
  assert.equal(new URL('https://api.bilibili.com'+player.path).searchParams.get('cid'),'101');
});

const oldJob=async(e,ref)=>{
  const payload={type:'bili',tier:'light',ref,lease:crypto.randomUUID(),waiters:[],...(ref.startsWith('t-')?{title:'第一页标题'}:{})};
  const id='c1-'+payload.lease;
  await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,lease_until,created_at) VALUES(?,'fetch',?,'running',?,?)").bind(id,JSON.stringify(payload),Date.now()+120000,Date.now()).run();
  return {id,payload};
};
for(const [label,ref,searchMiss] of [['L2',BV,false],['L3','t-0123456789abcdef',false],['L4','t-0123456789abcdef',true]])test('C1-'+label+' new runner reports to the actual old Worker',async()=>{
  const e=env(),f=twoPages({searchMiss}),job=await oldJob(e,ref);
  await runJob(job,f.client,async(_path,b)=>{assert.equal(b.proto,undefined);assert.equal((await legacy.reportFetch(e,b)).status,200);});
  const notes=(await e.DB.prepare('SELECT * FROM media_notes').all()).results;
  const cached=JSON.parse(notes.find(n=>n.id==='bili:'+ref).body);
  if(searchMiss){assert.equal(cached.miss,'none');assert.equal(notes.length,1);}
  else {assert.equal(cached.subtitle,'第一页字幕');assert.ok(notes.find(n=>n.id==='bili:'+BV));}
});
test('C1-L5 runner negotiates page two and reports actual page metadata',async()=>{
  const f=twoPages(),reports=[];
  await runJob({id:'L5',payload:{v:2,type:'bili',tier:'light',ref:BV+'~p2',kind:'bv',base:BV,page:2}},f.client,async(_p,b)=>reports.push(b),()=>{},async()=>{},2);
  assert.equal(reports[0].success,true);assert.equal(reports[0].proto,2);
  assert.equal(reports[0].result.page,2);assert.equal(reports[0].result.pages,2);assert.equal(reports[0].result.aid,170001);
  assert.equal(reports[0].result.subtitle,'第二页字幕');
});
test('C1-L9 rollback refuses a v2 paged ref without handshake and writes no BV cache',async()=>{
  const e=env(),f=twoPages(),job=await oldJob(e,BV+'~p2');
  job.payload={...job.payload,v:2,kind:'bv',base:BV,page:2};
  await e.DB.prepare('UPDATE jobs SET payload=? WHERE id=?').bind(JSON.stringify(job.payload),job.id).run();
  await runJob(job,f.client,async(_p,b)=>{assert.equal(b.success,false);assert.equal(b.reason,'invalid');assert.equal(b.proto,undefined);assert.equal((await legacy.reportFetch(e,b)).status,200);});
  assert.equal(f.calls.length,0);assert.equal((await e.DB.prepare('SELECT * FROM media_notes').all()).results.length,0);
});
test('C1 short HEAD falls back once on 405 and preserves redirect page after handshake',async()=>{
  const f=twoPages({fallback:true}),reports=[];
  await runJob({id:'short-v2',payload:{v:2,type:'bili',tier:'light',ref:'AbCd12',kind:'short',base:'AbCd12',page:0}},f.client,async(_p,b)=>reports.push(b),()=>{},async()=>{},2);
  assert.deepEqual(f.calls.filter(c=>c.host==='b23.tv').map(c=>c.method),['HEAD','GET']);
  assert.equal(reports[0].result.page,2);assert.equal(reports[0].result.subtitle,'第二页字幕');
});
test('C1 aid resolves through view and out of range page reports not_found',async()=>{
  for(const page of [2,3]){
    const f=twoPages(),reports=[];
    await runJob({id:'aid',payload:{v:2,type:'bili',tier:'light',ref:'av170001'+(page>1?'~p'+page:''),kind:'aid',base:'av170001',page}},f.client,async(_p,b)=>reports.push(b),()=>{},async()=>{},2);
    if(page===2){assert.equal(reports[0].success,true);assert.equal(reports[0].result.page,2);assert.ok(f.calls.some(c=>c.path.includes('aid=170001')));}
    else {assert.equal(reports[0].reason,'not_found');assert.ok(!f.calls.some(c=>c.path.startsWith('/x/player/wbi/v2?')));}
  }
});

test('C1 handshake is forwarded per claim and never retained after rollback',async()=>{
  const controller=new AbortController(),seen=[];let count=0;
  await runFetchLoop({signal:controller.signal,claim:async()=>++count===1?{job:{id:'new'},proto:2}:{job:{id:'old'}},
    work:async(job,proto)=>{seen.push([job.id,proto]);if(seen.length===2)controller.abort();},login:()=>{},wait:async()=>false});
  assert.deepEqual(seen,[['new',2],['old',undefined]]);
});
