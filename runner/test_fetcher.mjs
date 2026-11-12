import {test} from 'node:test';
import './test_browser_auth.mjs';
import './test_qr_login.mjs';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import https from 'node:https';
import {createBrowserAuth,writeBiliCookies} from './browser-auth.mjs';
import {createFetchClient,createSafeLookup,isPublic,wbiSign,sanitize,runJob} from './fetcher.mjs';
const BV='BV1xx411c7mD';
const titleModule=()=>import('./bili-title.mjs');
test('N-T1 title matching preserves punctuation/case and checks every candidate after the fifth',async()=>{
 const {normTitle,pickByTitle}=await titleModule(),vectors=JSON.parse(await readFile('test/fixtures/bili-title-vectors.json','utf8'));
 for(const [input,expected] of vectors)assert.equal(normTitle(input),expected);
 const candidate=(bvid,title)=>({type:'video',bvid,title,author:'合成UP'});
 assert.equal(pickByTitle([candidate(BV,'<em class="keyword">Ａ</em> &amp; B')],'A & B').bvid,BV);
 assert.equal(pickByTitle([candidate(BV,'<em>A</em> &#x26; B')],'A & B').bvid,BV);
 for(const title of ['a & B','A&B','A & B!'])assert.equal(pickByTitle([candidate(BV,title)],'A & B').miss,'near');
 const list=Array.from({length:5},(_,i)=>candidate('BV123456789'+i,'其它标题'));
 assert.equal(pickByTitle([...list,candidate(BV,'标题')],'标题').bvid,BV);
 assert.equal(pickByTitle([...list,candidate(BV,'标题'),candidate('BV1234567899','标题')],'标题').miss,'multiple');
 assert.equal(pickByTitle([candidate(BV,'标题'),candidate(BV,'标题')],'标题').bvid,BV);
 assert.equal(pickByTitle([],'标题').miss,'none');
});
test('N-T2 title search signs all parameters, is anonymous, then preserves logged-in light reads',async()=>{
 const {biliByTitle}=await titleModule();
 const f=fixture(o=>{
  if(o.path.includes('/spi'))return {body:{code:0,data:{b_3:'anon-device'}}};
  if(o.path.includes('/nav'))return {body:{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(o.path.includes('/search/type'))return {body:{code:0,data:{result:[{type:'video',bvid:BV,title:'标题'}]}}};
  if(o.path.includes('/view'))return {body:{code:0,data:{title:'标题',aid:1,cid:1,owner:{name:'合成UP'}}}};
  return {body:{code:0,data:{}}};
 },{cookies:{SESSDATA:'private-session',buvid3:'anon-device'}});
 assert.equal((await biliByTitle(f.client,'标题')).bvid,BV);
 const search=f.calls.find(o=>o.path.includes('/search/type')),q=new URL('https://api.bilibili.com'+search.path).searchParams;
 assert.equal(q.get('search_type'),'video');assert.equal(q.get('keyword'),'标题');assert.equal(q.get('page'),'1');assert.equal(q.get('order'),'totalrank');
 assert.equal(search.path.split('?')[1],wbiSign({search_type:'video',keyword:'标题',page:1,order:'totalrank'},'a'.repeat(32),'b'.repeat(32),Number(q.get('wts'))));
 assert.ok(!search.headers.Cookie.includes('SESSDATA'));assert.ok(search.headers.Cookie.includes('buvid3='));
 assert.ok(f.calls.find(o=>o.path.includes('/view')).headers.Cookie.includes('SESSDATA=private-session'));
 assert.ok(f.times.slice(1).every((value,i)=>value-f.times[i]>=1000));
});
test('N-T3 vouchers cool down search only while HTTP 412 and risk codes keep the global pause',async()=>{
 const {biliByTitle}=await titleModule();let calls=0,searchPaused=false,globalPauses=0;
 const client={isPaused:()=>false,isSearchPaused:()=>searchPaused,prepare:async()=>['a'.repeat(32),'b'.repeat(32)],biliApi:async()=>{calls++;return {code:0,data:{v_voucher:'redacted-challenge'}};},pauseForRisk:()=>globalPauses++,pauseSearch:ms=>{assert.equal(ms,6*3600000);searchPaused=true;},biliLight:async()=>{throw Error('must not read a video');}};
 await assert.rejects(biliByTitle(client,'标题'),/风控/);assert.equal(calls,1);assert.equal(globalPauses,0);assert.equal(searchPaused,true);
 await assert.rejects(biliByTitle(client,'标题'),/风控/);assert.equal(calls,1);
 for(const code of [412,-352,-412]){
  const f=fixture(o=>o.path.includes('/search/type')?(code===412?{status:412}:{body:{code}}):o.path.includes('/nav')?{body:{data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}}:{body:{code:0,data:{b_3:'anon'}}});
  await assert.rejects(biliByTitle(f.client,'标题'));await assert.rejects(biliByTitle(f.client,'标题'));
  assert.equal(f.client.isPaused(),true);assert.equal(f.client.isSearchPaused(),false);const n=f.calls.length;
  await assert.rejects(biliByTitle(f.client,'标题'));assert.equal(f.calls.length,n);
 }
});
test('N-T4 title injection stays in the fixed signed query and never in headers or logs',async()=>{
 const {biliByTitle}=await titleModule(),title='标题\r\n; Cookie:evil ../ $(x)';
 const f=fixture(o=>o.path.includes('/search/type')?{body:{code:0,data:{result:[]}}}:o.path.includes('/nav')?{body:{data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}}:{body:{code:0,data:{b_3:'anon'}}});
 assert.equal((await biliByTitle(f.client,title)).miss,'none');const search=f.calls.find(o=>o.path.includes('/search/type'));
 assert.equal(new URL('https://api.bilibili.com'+search.path).pathname,'/x/web-interface/wbi/search/type');
 assert.ok(search.path.includes('%0D%0A'));assert.ok(!JSON.stringify(f.calls.map(o=>o.headers)).includes('Cookie:evil'));assert.ok(!JSON.stringify(f.logs).includes('Cookie:evil'));
});
test('N-T5 title jobs reject invalid titles and direct short jobs expand before light video reads',async()=>{
 const reports=[],cloud=async(_path,body)=>reports.push(body),client={sanitize:x=>x,biliLight:async()=>{throw Error('must not fetch');}};
 for(const title of [undefined,'x'.repeat(101),'a\nb'])await runJob({id:'invalid',payload:{type:'bili',tier:'light',ref:'t-0123456789abcdef',title}},client,cloud);
 assert.ok(reports.every(r=>r.success===false));
 const f=fixture(o=>o.host==='b23.tv'?{status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}:o.path.includes('/spi')?{body:{data:{b_3:'anon'}}}:o.path.includes('/nav')?{body:{data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}}:o.path.includes('/view')?{body:{code:0,data:{title:'标题',aid:1,cid:1,owner:{name:'合成UP'}}}}:{body:{code:0,data:{}}});
 await runJob({id:'short',payload:{type:'bili',tier:'light',ref:'AbCd12'}},f.client,cloud);
 assert.equal(reports.at(-1).success,true);assert.equal(reports.at(-1).result.bvid,BV);assert.equal(reports.at(-1).result.subtitle_status,'none');assert.equal(f.calls[0].host,'b23.tv');
});
test('N-T6 valid title jobs search exactly once and report matches or misses without title logs',async()=>{
 for(const matches of [[],[{type:'video',bvid:BV,title:'标题'}]]){
  let searches=0,lights=0;const reports=[],logs=[];
  const client={isPaused:()=>false,isSearchPaused:()=>false,prepare:async()=>['a'.repeat(32),'b'.repeat(32)],biliApi:async()=>{searches++;return {code:0,data:{result:matches}};},biliLight:async bvid=>{lights++;return {bvid};},sanitize:x=>x};
  await runJob({id:'title-task',payload:{type:'bili',tier:'light',ref:'t-0123456789abcdef',title:'标题'}},client,async(_path,body)=>reports.push(body),s=>logs.push(s));
  assert.equal(searches,1);assert.equal(lights,matches.length);assert.equal(reports[0].success,true);assert.ok(!JSON.stringify(logs).includes('标题'));
 }
});
test('N-T7 voucher leaves BV reads running, blocks all title requests for six hours and then retries once',async()=>{
 const f=fixture(o=>o.path.includes('/search/type')?{body:{code:0,data:{v_voucher:'synthetic-challenge'}}}:o.path.includes('/spi')?{body:{code:0,data:{b_3:'anon'}}}:o.path.includes('/nav')?{body:{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}}:o.path.includes('/view')?{body:{code:0,data:{title:'标题',aid:1,cid:1,owner:{name:'合成UP'}}}}:{body:{code:0,data:{}}});
 const reports=[],cloud=async(_path,body)=>reports.push(body),task=title=>({id:'search-task',payload:{type:'bili',tier:'light',ref:'t-0123456789abcdef',title}});
 await runJob(task('标题'),f.client,cloud);const challengedAt=f.time;
 assert.equal(reports.at(-1).success,false);assert.equal(f.client.isPaused(),false);assert.equal(f.client.isSearchPaused(),true);
 assert.equal((await f.client.biliLight(BV)).bvid,BV);assert.ok(f.calls.some(o=>o.path.startsWith('/x/web-interface/view?')));
 const count=f.calls.length,searches=()=>f.calls.filter(o=>o.path.includes('/search/type')).length;
 assert.equal(searches(),1);
 for(const title of ['标题','另一个标题']){await runJob(task(title),f.client,cloud);assert.equal(reports.at(-1).success,false);assert.equal(reports.at(-1).reason,'risk');assert.equal(reports.at(-1).retryAfter,3600);}
 assert.equal(f.calls.length,count);
 f.setTime(challengedAt+6*3600000-1);await runJob(task('标题'),f.client,cloud);assert.equal(f.calls.length,count);
 f.setTime(challengedAt+6*3600000);assert.equal(f.client.isSearchPaused(),false);
 await runJob(task('标题'),f.client,cloud);assert.equal(searches(),2);assert.equal(f.calls.length,count+1);assert.equal(f.client.isPaused(),false);
});
function fixture(handler=()=>({body:{code:0,data:{}}}),extra={}){
 let t=10000; const calls=[],logs=[],times=[]; let destroys=0;
 const request=(o,cb)=>{const req=new EventEmitter();req.end=()=>{o.lookup(o.host,{},(err)=>{if(err){req.emit('error',err);return;}calls.push(o);times.push(t);const r=handler(o,calls.length);const res=new EventEmitter();res.statusCode=r.status||200;res.headers=r.headers||{};cb(res);queueMicrotask(()=>{for(const chunk of r.chunks||[Buffer.from(JSON.stringify(r.body||{}))])res.emit('data',chunk);res.emit('end');});});};req.destroy=(err)=>{destroys++;req.emit('error',err||Error('destroyed'));};return req;};
 const client=createFetchClient({request,lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),now:()=>t,sleep:async ms=>{t+=ms;},random:()=>0,log:x=>logs.push(x),...extra});
 return {client,calls,logs,times,get destroys(){return destroys;},get time(){return t;},setTime(v){t=v;}};
}
test('L13 a paused fetch client suppresses auth probes and preserves the last local status',async t=>{
 t.mock.method(https,'request',()=>{throw Error('unexpected separate client transport');});
 const home=await mkdtemp(join(tmpdir(),'team-shared-auth-'));t.after(()=>rm(home,{recursive:true,force:true}));
 await writeBiliCookies(home,[{name:'SESSDATA',value:'private-session',expires:2000000000}]);
 const f=fixture(()=>({status:412})),reports=[];
 const auth=createBrowserAuth({home,client:f.client,report:async b=>reports.push(b),notify:async()=>{}});
 await auth.record('bili','ok');
 await assert.rejects(f.client.biliApi('/x'));await assert.rejects(f.client.biliApi('/x'));
 assert.equal(await auth.check('bili'),'ok');assert.equal(f.calls.length,2);assert.equal(reports.length,1);
});
test('L14 login nav shares the fetch limiter and stops on its first risk response',async t=>{
 t.mock.method(https,'request',()=>{throw Error('unexpected separate client transport');});
 const home=await mkdtemp(join(tmpdir(),'team-shared-auth-'));t.after(()=>rm(home,{recursive:true,force:true}));
 let mode='ok',closed=0;
 const f=fixture(()=>mode==='ok'?{body:{code:0}}:{body:{code:-352}});
 await f.client.biliApi('/x');mode='risk';
 const page={goto:async()=>{}},context={pages:()=>[page],route:async()=>{},cookies:async()=>[{name:'SESSDATA',value:'private-session',expires:2000000000}],close:async()=>closed++};
 const auth=createBrowserAuth({home,client:f.client,now:()=>f.time,sleep:async ms=>f.setTime(f.time+ms),launch:async()=>context,notify:async()=>{}});
 assert.equal(await auth.login('bili'),'risk');assert.equal(f.calls.length,2);assert.equal(closed,1);
 assert.ok(f.times[1]-f.times[0]>=1000);assert.equal(f.client.isPaused(),true);
 assert.equal(await auth.check('bili'),'risk');assert.equal(f.calls.length,2);
 await assert.rejects(readFile(join(home,'secrets/bili-cookie.json')));
});
test('N1 WBI public fixed-key example matches published digest',()=>{ // https://github.com/SocialSisterYi/bilibili-API-collect/blob/e99f64c9b5c2bbd156e95ca254620378a22697f7/docs/misc/sign/wbi.md (algorithm example, zab parameter)
const q=wbiSign({foo:'114',bar:'514',zab:1919810},'7cd084941338484aae1ad9425b84077c','4932caff0ff746eab6f01bf08b70ac45',1702204169);assert.equal(new URLSearchParams(q).get('w_rid'),'8f6f2b5b3d485fe1886cec6a0be8c5d4');assert.equal(new URLSearchParams(wbiSign({foo:"!'()*a b",w_rid:'old',wts:1},'a'.repeat(32),'b'.repeat(32),123)).get('foo'),'a b');});
test('N2 light fetch joins metadata, preferred subtitles, hot comments; missing sections degrade',async()=>{for(const empty of [false,true]){const f=fixture(o=>{const p=o.path.split('?')[0];if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'anon'}}};if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};if(p.endsWith('/view'))return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};if(p.endsWith('/v2'))return {body:{code:0,data:{subtitle:{subtitles:empty?[]:[{lan:'en',subtitle_url:'//a.hdslb.com/en'},{lan:'zh-CN',subtitle_url:'//a.hdslb.com/zh'}]}}}};if(p==='/zh')return {body:{body:[{content:'中文'},{content:'字幕'}]}};return {body:empty?{code:-404}:{code:0,data:{replies:[{like:1,member:{uname:'A'},content:{message:'低'}},{like:8,member:{uname:'B'},content:{message:'高'}}]}}};});const r=await f.client.biliLight(BV);assert.equal(r.owner,'UP');assert.equal(r.tier,'light');assert.equal(r.bvid,BV);assert.equal(r.subtitle,empty?null:'中文 字幕');assert.equal(r.subtitle_status,empty?'none':'ok');assert.deepEqual(r.comments,empty?[]:[{uname:'B',message:'高'},{uname:'A',message:'低'}]);}});
test('N3 rate limit serializes five concurrent requests and pauses after two risk responses',async()=>{const f=fixture();await Promise.all(Array.from({length:5},()=>f.client.biliApi('/x')));assert.equal(f.calls.length,5);assert.ok(f.time>=14800);assert.ok(f.times.slice(1).every((t,i)=>t-f.times[i]>=1000),JSON.stringify(f.times));assert.ok(f.calls.every(o=>o.agent===false));const risk=fixture(()=>({status:412}));await assert.rejects(risk.client.biliApi('/x'));await assert.rejects(risk.client.biliApi('/x'));await assert.rejects(risk.client.biliApi('/x'),/风控/);assert.equal(risk.calls.length,2);const code=fixture(()=>({body:{code:-352}}));await assert.rejects(code.client.biliApi('/x'));await assert.rejects(code.client.biliApi('/x'));await assert.rejects(code.client.biliApi('/x'),/风控/);assert.equal(code.calls.length,2);});
test('N4 strict per-request URL boundaries',async()=>{const f=fixture();for(const url of ['https://api.bilibili.com.evil.com/a','https://evilbilibili.com/a','https://xhdslb.com/a','https://hdslb.com.evil.com/a','http://api.bilibili.com/a','https://api.bilibili.com:8443/a','https://u:p@api.bilibili.com/a'])await assert.rejects(f.client.biliSubtitle(url));assert.equal(f.calls.length,0);});
test('N5 cookies go only to API, never subtitles or short redirects',async()=>{const f=fixture(o=>o.host==='b23.tv'?{status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}:{body:{code:0}},{cookies:{SESSDATA:'sample-private-session',buvid3:'sample-buvid'}});await f.client.biliApi('/x');await f.client.biliSubtitle('https://a.hdslb.com/a');assert.equal(await f.client.resolveShort('abcd'),BV);assert.equal(f.calls[0].headers['User-Agent'],'curl/8.7.1');assert.match(f.calls[0].headers.Cookie,/SESSDATA=sample-private-session/);assert.equal(f.calls[1].headers.Cookie,undefined);assert.equal(f.calls[2].headers.Cookie,undefined);await assert.rejects(f.client.biliSubtitle('https://api.bilibili.com/sub'));assert.equal(f.calls.length,3);});
test('login cookie refresh preserves anonymous buvid and redacts the real client logger',async()=>{
 const f=fixture(undefined,{cookies:{buvid3:'anonymous-buvid'}});
 f.client.setSessionCookies({SESSDATA:'session-private-value'});await f.client.biliApi('/session-private-value');
 assert.ok(!JSON.stringify(f.logs).includes('session-private-value'));assert.match(f.calls[0].headers.Cookie,/SESSDATA=session-private-value/);
 f.client.setSessionCookies({});await f.client.biliApi('/x');assert.equal(f.calls[1].headers.Cookie,'buvid3=anonymous-buvid');assert.equal(f.client.sanitize('session-private-value'),'***');
});
test('N6 redirects are manual and short chains bounded',async()=>{let f=fixture(()=>({status:302,headers:{location:'https://evil.com/'}}));await assert.rejects(f.client.biliApi('/x'));assert.equal(f.calls.length,1);await assert.rejects(f.client.resolveShort('abcd'));f=fixture(()=>({status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}));assert.equal(await f.client.resolveShort('abcd'),BV);assert.equal(f.calls.length,1);f=fixture((_o,n)=>({status:302,headers:{location:'https://b23.tv/hop'+n}}));await assert.rejects(f.client.resolveShort('abcd'));assert.equal(f.calls.length,3);});

test('N6b short codes with -/_ and av final pages resolve or stay explicitly unsupported',async()=>{
 let f=fixture(()=>({status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}));
 assert.equal(await f.client.resolveShort('Ab-Cd_12'),BV);
 f=fixture(o=>o.host==='b23.tv'?{status:302,headers:{location:'https://www.bilibili.com/video/av123'}}:o.path.includes('/view')?{body:{code:0,data:{bvid:BV}}}:{body:{code:0,data:{}}});
 assert.equal(await f.client.resolveShort('AbCd12'),BV);
 f=fixture(()=>({status:302,headers:{location:'https://www.bilibili.com/bangumi/play/ep1'}}));
 await assert.rejects(f.client.resolveShort('AbCd12'),e=>e.reason==='unsupported');
});

test('N7 DNS rejects all unsafe answers, pins one lookup per connection, handles mapped IPv6',async()=>{for(const ip of ['::ffff:127.0.0.1','::ffff:7f00:1','::ffff:10.0.0.1','fe80::1','100.64.0.1','0.0.0.0','::','::1','fc00::1','ff00::1','64:ff9b::0808:0808','2001:db8::1','192.0.2.1','198.18.0.1','224.0.0.1'])assert.equal(isPublic(ip),false,ip);assert.equal(isPublic('2606:4700:4700::1111'),true);const lookup=createSafeLookup((_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));await assert.rejects(new Promise((resolve,reject)=>lookup('api.bilibili.com',{},(e,a)=>e?reject(e):resolve(a))));let n=0;const f=fixture(undefined,{lookup:(_h,_o,cb)=>cb(null,[{address:++n===1?'8.8.8.8':'127.0.0.1',family:4}])});await f.client.biliApi('/x');await assert.rejects(f.client.biliApi('/x'));assert.equal(n,2);});
test('N8 streaming body limit destroys request',async()=>{const f=fixture(()=>({chunks:[Buffer.alloc(1_500_000),Buffer.alloc(600_000)]}));await assert.rejects(f.client.biliSubtitle('https://a.hdslb.com/a'));assert.ok(f.destroys>0);});
test('N9 reports and logs exclude exact cookie values and untrusted payload fields',async()=>{const cookies={SESSDATA:'session-secret-value',buvid3:'buvid-secret-value'}, reports=[],logs=[];const client={biliLight:async()=>({title:'session-secret-value',desc:'buvid-secret-value'}),sanitize:x=>sanitize(x,Object.values(cookies))};await runJob({id:'j',payload:{type:'bili',ref:BV,tier:'light',lease:'l',url:'https://evil.com',cookie:'session-secret-value'}},client,async(path,b)=>reports.push([path,b]),x=>logs.push(x));assert.ok(!JSON.stringify([reports,logs]).includes('session-secret-value'));assert.ok(!JSON.stringify([reports,logs]).includes('buvid-secret-value'));await runJob({id:'j',payload:{type:'x',ref:BV,tier:'light',lease:'l'}},client,async(path,b)=>reports.push([path,b]),x=>logs.push(x));assert.equal(reports.at(-1)[1].success,false);});
test('N10 rejects 6to4 and Teredo tunnels while keeping ordinary public IPv6',()=>{
  assert.deepEqual(
    ['2002:c0a8:0101::1','2001:0:4136:e378::1','2606:4700::1111'].map(isPublic),
    [false,false,true],
  );
});


test('N10 view 412 refreshes anonymous buvid3 once and retries',async()=>{
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'fresh-b3'}}};
  if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(p.endsWith('/view')){
   const cookie=String(o.headers.Cookie||'');
   if(cookie.includes('stale-b3'))return {status:412,body:{code:-412}};
   return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};
  }
  if(p.endsWith('/v2'))return {body:{code:0,data:{subtitle:{subtitles:[]}}}};
  return {body:{code:0,data:{replies:[]}}};
 },{cookies:{buvid3:'stale-b3'}});
 const r=await f.client.biliLight(BV);
 assert.equal(r.bvid,BV);
 const views=f.calls.filter(o=>o.path.includes('/web-interface/view'));
 assert.equal(views.length,2);
 assert.match(views[1].headers.Cookie,/buvid3=fresh-b3/);
 assert.equal(views[1].headers['User-Agent'],'curl/8.7.1');
 assert.ok(f.logs.some(x=>x.includes('/x/web-interface/view')&&x.includes('status=412')));
 assert.ok(f.logs.some(x=>x.includes('/x/web-interface/view')&&x.includes('status=200')));
});
test('N11 refresh still 412 fails after one retry, never loops',async()=>{
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'fresh-b3'}}};
  if(p.endsWith('/view'))return {status:412,body:{code:-412}};
  return {body:{code:0,data:{}}};
 },{cookies:{buvid3:'stale-b3'}});
 await assert.rejects(f.client.biliLight(BV));
 assert.equal(f.calls.filter(o=>o.path.includes('/web-interface/view')).length,2);
});
test('N12 need_login_subtitle is surfaced explicitly',async()=>{
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'b3'}}};
  if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(p.endsWith('/view'))return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};
  if(p.endsWith('/v2'))return {body:{code:0,data:{need_login_subtitle:true,subtitle:{subtitles:[]}}}};
  return {body:{code:0,data:{replies:[]}}};
 });
 const r=await f.client.biliLight(BV);
 assert.equal(r.subtitle,null);
 assert.equal(r.subtitle_status,'login_required');
});


test('N13 two view 412s pause and later short-link work sends no request',async()=>{
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'fresh-b3'}}};
  if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(p.endsWith('/view'))return {status:412,body:{code:-412}};
  return {body:{code:0,data:{}}};
 },{cookies:{buvid3:'stale-b3'}});
 await assert.rejects(f.client.biliLight(BV),/风控/);
 assert.equal(f.calls.filter(o=>o.path.includes('/web-interface/view')).length,2);
 const before=f.calls.length;
 await assert.rejects(f.client.biliLight('abcd'),/风控/);
 assert.equal(f.calls.length,before);
});
test('N14 player code -403 marks subtitle unavailable, not none',async()=>{
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'b3'}}};
  if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(p.endsWith('/view'))return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};
  if(p.endsWith('/v2'))return {body:{code:-403}};
  return {body:{code:0,data:{replies:[]}}};
 });
 const r=await f.client.biliLight(BV);
 assert.equal(r.subtitle,null);
 assert.equal(r.subtitle_status,'unavailable');
});


/*
  risk/pause state transitions (checked before adding N15):
  states: N normal(0,0), R risk1(1,0), P paused(>=2,future), E expired(past)
  event        N     R          P            E (next request first resets to N)
  view 412     R     P          no request   R
  view 200     N     N          no request   N
  short 302    N     R (keep)   no request   N
  SPI ok       N     R (keep)   no request   N
  pause expiry P -> E; only a new view 412 from R may set P again.
*/
test('N15 pause expiry: short 302 does not extend; view 200 clears the risk count',async()=>{
 let views=0,mode='412';
 const f=fixture(o=>{
  const p=o.path.split('?')[0];
  if(p==='/abcd')return {status:302,headers:{location:'https://www.bilibili.com/video/'+BV}};
  if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'fresh-b3'}}};
  if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};
  if(p.endsWith('/view')){
   views++;
   if(mode==='412')return {status:412,body:{code:-412}};
   return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};
  }
  if(p.endsWith('/v2'))return {body:{code:0,data:{subtitle:{subtitles:[]}}}};
  return {body:{code:0,data:{replies:[]}}};
 },{cookies:{buvid3:'stale-b3'}});
 await assert.rejects(f.client.biliLight(BV),/风控/);
 assert.equal(views,2);
 const beforeShort=f.calls.length;
 f.setTime(f.time+600001);
 assert.equal(await f.client.resolveShort('abcd'),BV);
 assert.equal(f.calls.length,beforeShort+1);
 mode='200';
 const ok=await f.client.biliApi('/x/web-interface/view',{bvid:BV});
 assert.equal(ok.code,0);
 assert.equal(f.calls.length,beforeShort+2);
 // After a successful view the counter is zero: one 412 is not enough, two pause.
 mode='412';
 await assert.rejects(f.client.biliApi('/x/web-interface/view',{bvid:BV}),/抓取失败/);
 const beforePause=f.calls.length;
 await assert.rejects(f.client.biliApi('/x/web-interface/view',{bvid:BV}),/风控/);
 assert.equal(f.calls.length,beforePause+1);
 const afterPause=f.calls.length;
 await assert.rejects(f.client.biliApi('/x/web-interface/view',{bvid:BV}),/风控/);
 assert.equal(f.calls.length,afterPause);
});


test('N16 shared risk file makes pauseForRisk block another client and corrupt state pauses conservatively',async t=>{
 const {mkdtemp,rm,readFile,writeFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');
 const {join}=await import('node:path');
 const home=await mkdtemp(join(tmpdir(),'team-risk-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const risk=join(home,'state/bili-risk.json');
 const f=fixture(()=>({body:{code:0,data:{}}}),{riskPath:risk});
 f.client.pauseForRisk();
 const saved=JSON.parse(await readFile(risk,'utf8'));
 assert.ok(saved.paused_until>f.time);
 const g=fixture(()=>({body:{code:0,data:{}}}),{riskPath:risk});
 await assert.rejects(g.client.biliApi('/x'),/风控/);
 assert.equal(g.calls.length,0);
 await writeFile(risk,'{broken');
 const h=fixture(()=>({body:{code:0,data:{}}}),{riskPath:risk});
 await assert.rejects(h.client.biliApi('/x'),/风控/);
 assert.equal(h.calls.length,0);
});


test('N17 shared pause written during rate sleep is checked before the next request',async t=>{
 const {mkdir,mkdtemp,rm,writeFile}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os'),{join}=await import('node:path');
 const home=await mkdtemp(join(tmpdir(),'team-risk-sleep-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const risk=join(home,'state/bili-risk.json');
 await mkdir(join(home,'state'),{recursive:true});
 let slept=0;
 const f=fixture(()=>({body:{code:0,data:{}}}),{riskPath:risk,sleep:async()=>{slept++;await writeFile(risk,JSON.stringify({paused_until:9999999999999}));}});
 await f.client.biliApi('/x1');
 assert.equal(f.calls.length,1);
 await assert.rejects(f.client.biliApi('/x2'),/风控/);
 assert.equal(f.calls.length,1);
 assert.equal(slept,1);
});

test('R2 timeout request event carries a timeout attribute without waiting',async()=>{
 const request=()=>{const req=new EventEmitter();req.end=()=>queueMicrotask(()=>req.emit('timeout'));req.destroy=()=>{};return req;};
 const client=createFetchClient({request});
 await assert.rejects(client.biliLight(BV),e=>e.timeout===true&&e.message==='抓取失败');
 const reports=[];await runJob({id:'timeout',payload:{type:'bili',tier:'light',ref:BV}},client,async(_p,b)=>reports.push(b));
 assert.equal(reports[0].reason,'timeout');
});
test('R3 view failure preserves its code and reports not_found',async()=>{
 const f=fixture(o=>o.path.includes('/view')?{body:{code:-404}}:{body:{code:0,data:{}}});
 await assert.rejects(f.client.biliLight(BV),e=>e.code===-404&&e.message==='视频信息未读到');
 const reports=[];await runJob({id:'deleted',payload:{type:'bili',tier:'light',ref:BV}},f.client,async(_p,b)=>reports.push(b));assert.equal(reports[0].reason,'not_found');
});
test('R4 short link targets distinguish unsupported and missing',async()=>{
 for(const [response,reason] of [[{status:302,headers:{location:'https://live.bilibili.com/1'}},'unsupported'],[{status:302,headers:{location:'https://www.bilibili.com/read/cv1'}},'unsupported'],[{status:200},'not_found']]){
  const f=fixture(()=>response);await assert.rejects(f.client.resolveShort('AbCd12'),e=>e.reason===reason&&e.message==='短链无效');
  const reports=[];await runJob({id:'short',payload:{type:'bili',tier:'light',ref:'AbCd12'}},f.client,async(_p,b)=>reports.push(b));assert.equal(reports[0].reason,reason);
 }
});
test('R1 classify follows the ordered failure mapping',async()=>{
 const {classify}=await import('./fetcher.mjs');
 for(const [error,reason,retryAfter] of [[{message:'风控'},'risk',600],[{status:412},'risk',600],[{status:403},'risk',600],[{code:-352},'risk',600],[{code:-412},'risk',600],[{message:'风控',scope:'search'},'risk',3600],[{timeout:true},'timeout'],[{code:'ETIMEDOUT'},'timeout'],[{reason:'unsupported'},'unsupported'],[{reason:'not_found'},'not_found'],[{status:404},'not_found'],...[-404,62002,62004,62012].map(code=>[{code},'not_found']),[{code:-101},'login_required'],[{code:-403},'login_required'],[{status:401},'login_required'],[Error('无效任务'),'invalid'],[undefined,'invalid']])assert.deepEqual(classify(error),{reason,...(retryAfter?{retryAfter}:{})});
});
test('R5 two risk responses report a bounded retryAfter',async()=>{
 const f=fixture(o=>o.path.includes('/view')?{status:412}:{body:{code:0,data:{}}}),reports=[];
 await runJob({id:'risk',payload:{type:'bili',tier:'light',ref:BV}},f.client,async(_p,b)=>reports.push(b));
 assert.deepEqual(reports[0],{id:'risk',lease:undefined,success:false,reason:'risk',retryAfter:600});
});
test('R6 search challenge reports risk for one hour while preserving six-hour search pause',async()=>{
 const {biliByTitle}=await titleModule();let paused=false;
 const client={isPaused:()=>false,isSearchPaused:()=>paused,pauseSearch:ms=>{assert.equal(ms,6*3600000);paused=true;},prepare:async()=>['a'.repeat(32),'b'.repeat(32)],biliApi:async()=>({code:0,data:{v_voucher:'challenge'}}),sanitize:x=>x};
 const reports=[];for(let i=0;i<2;i++)await runJob({id:'search',payload:{type:'bili',tier:'light',ref:'t-0123456789abcdef',title:'标题'}},client,async(_p,b)=>reports.push(b));
 assert.equal(paused,true);for(const report of reports)assert.deepEqual(report,{id:'search',lease:undefined,success:false,reason:'risk',retryAfter:3600});
});
test('R7 arbitrary exception text and session values never enter reports or logs',async()=>{
 const f=fixture(()=>({body:{}}),{cookies:{SESSDATA:'sess-secret-1'}}),reports=[],logs=[];
 f.client.biliLight=async()=>{throw Error('SESSDATA=sess-secret-1 https://private.example');};
 await runJob({id:'private',payload:{type:'bili',tier:'light',ref:BV,lease:'lease'}},f.client,async(_p,b)=>reports.push(b),s=>logs.push(s));
 assert.equal(reports[0].reason,'invalid');assert.ok(Object.keys(reports[0]).every(k=>['id','lease','success','reason','retryAfter'].includes(k)));
 assert.doesNotMatch(JSON.stringify({reports,logs}),/sess-secret-1|private\.example|SESSDATA/);assert.deepEqual(logs,['fetch invalid']);
});
test('R8 successful reports retain exactly the original shape and values',async()=>{
 const result={bvid:BV,title:'标题'},reports=[];await runJob({id:'ok',payload:{type:'bili',tier:'light',ref:BV,lease:'lease'}},{sanitize:x=>x,biliLight:async()=>result},async(_p,b)=>reports.push(b));
 assert.deepEqual(reports,[{id:'ok',lease:'lease',success:true,result}]);assert.deepEqual(Object.keys(reports[0]).sort(),['id','lease','result','success']);
});
