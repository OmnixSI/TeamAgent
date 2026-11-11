import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createFetchClient,createSafeLookup,isPublic,wbiSign,sanitize,runJob} from './fetcher.mjs';
const BV='BV1xx411c7mD';
function fixture(handler=()=>({body:{code:0,data:{}}}),extra={}){
 let t=10000; const calls=[],logs=[],times=[]; let destroys=0;
 const request=(o,cb)=>{const req=new EventEmitter();req.end=()=>{o.lookup(o.host,{},(err)=>{if(err){req.emit('error',err);return;}calls.push(o);times.push(t);const r=handler(o,calls.length);const res=new EventEmitter();res.statusCode=r.status||200;res.headers=r.headers||{};cb(res);queueMicrotask(()=>{for(const chunk of r.chunks||[Buffer.from(JSON.stringify(r.body||{}))])res.emit('data',chunk);res.emit('end');});});};req.destroy=(err)=>{destroys++;req.emit('error',err||Error('destroyed'));};return req;};
 const client=createFetchClient({request,lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),now:()=>t,sleep:async ms=>{t+=ms;},random:()=>0,log:x=>logs.push(x),...extra});
 return {client,calls,logs,times,get destroys(){return destroys;},get time(){return t;}};
}
test('N1 WBI public fixed-key example matches published digest',()=>{ // https://github.com/SocialSisterYi/bilibili-API-collect/blob/e99f64c9b5c2bbd156e95ca254620378a22697f7/docs/misc/sign/wbi.md (algorithm example, zab parameter)
const q=wbiSign({foo:'114',bar:'514',zab:1919810},'7cd084941338484aae1ad9425b84077c','4932caff0ff746eab6f01bf08b70ac45',1702204169);assert.equal(new URLSearchParams(q).get('w_rid'),'8f6f2b5b3d485fe1886cec6a0be8c5d4');assert.equal(new URLSearchParams(wbiSign({foo:"!'()*a b",w_rid:'old',wts:1},'a'.repeat(32),'b'.repeat(32),123)).get('foo'),'a b');});
test('N2 light fetch joins metadata, preferred subtitles, hot comments; missing sections degrade',async()=>{for(const empty of [false,true]){const f=fixture(o=>{const p=o.path.split('?')[0];if(p.endsWith('/spi'))return {body:{code:0,data:{b_3:'anon'}}};if(p.endsWith('/nav'))return {body:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+'b'.repeat(32)+'.png'}}}};if(p.endsWith('/view'))return {body:{code:0,data:{bvid:BV,title:'T',desc:'D',owner:{name:'UP'},tname:'科技',duration:60,pubdate:1,stat:{view:2},aid:123,pages:[{cid:456}]}}};if(p.endsWith('/v2'))return {body:{code:0,data:{subtitle:{subtitles:empty?[]:[{lan:'en',subtitle_url:'//a.hdslb.com/en'},{lan:'zh-CN',subtitle_url:'//a.hdslb.com/zh'}]}}}};if(p==='/zh')return {body:{body:[{content:'中文'},{content:'字幕'}]}};return {body:empty?{code:-404}:{code:0,data:{replies:[{like:1,member:{uname:'A'},content:{message:'低'}},{like:8,member:{uname:'B'},content:{message:'高'}}]}}};});const r=await f.client.biliLight(BV);assert.equal(r.owner,'UP');assert.equal(r.tier,'light');assert.equal(r.bvid,BV);assert.equal(r.subtitle,empty?null:'中文 字幕');assert.equal(r.subtitle_status,empty?'none':'ok');assert.deepEqual(r.comments,empty?[]:[{uname:'B',message:'高'},{uname:'A',message:'低'}]);}});
test('N3 rate limit serializes five concurrent requests and pauses after two risk responses',async()=>{const f=fixture();await Promise.all(Array.from({length:5},()=>f.client.biliApi('/x')));assert.equal(f.calls.length,5);assert.ok(f.time>=14800);assert.ok(f.times.slice(1).every((t,i)=>t-f.times[i]>=1000),JSON.stringify(f.times));assert.ok(f.calls.every(o=>o.agent===false));const risk=fixture(()=>({status:412}));await assert.rejects(risk.client.biliApi('/x'));await assert.rejects(risk.client.biliApi('/x'));await assert.rejects(risk.client.biliApi('/x'),/风控/);assert.equal(risk.calls.length,2);const code=fixture(()=>({body:{code:-352}}));await assert.rejects(code.client.biliApi('/x'));await assert.rejects(code.client.biliApi('/x'));await assert.rejects(code.client.biliApi('/x'),/风控/);assert.equal(code.calls.length,2);});
test('N4 strict per-request URL boundaries',async()=>{const f=fixture();for(const url of ['https://api.bilibili.com.evil.com/a','https://evilbilibili.com/a','https://xhdslb.com/a','https://hdslb.com.evil.com/a','http://api.bilibili.com/a','https://api.bilibili.com:8443/a','https://u:p@api.bilibili.com/a'])await assert.rejects(f.client.biliSubtitle(url));assert.equal(f.calls.length,0);});
test('N5 cookies go only to API, never subtitles or short redirects',async()=>{const f=fixture(o=>o.host==='b23.tv'?{status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}:{body:{code:0}},{cookies:{SESSDATA:'sample-private-session',buvid3:'sample-buvid'}});await f.client.biliApi('/x');await f.client.biliSubtitle('https://a.hdslb.com/a');assert.equal(await f.client.resolveShort('abcd'),BV);assert.equal(f.calls[0].headers['User-Agent'],'curl/8.7.1');assert.match(f.calls[0].headers.Cookie,/SESSDATA=sample-private-session/);assert.equal(f.calls[1].headers.Cookie,undefined);assert.equal(f.calls[2].headers.Cookie,undefined);await assert.rejects(f.client.biliSubtitle('https://api.bilibili.com/sub'));assert.equal(f.calls.length,3);});
test('N6 redirects are manual and short chains bounded',async()=>{let f=fixture(()=>({status:302,headers:{location:'https://evil.com/'}}));await assert.rejects(f.client.biliApi('/x'));assert.equal(f.calls.length,1);await assert.rejects(f.client.resolveShort('abcd'));f=fixture(()=>({status:302,headers:{location:'https://www.bilibili.com/video/'+BV}}));assert.equal(await f.client.resolveShort('abcd'),BV);assert.equal(f.calls.length,1);f=fixture((_o,n)=>({status:302,headers:{location:'https://b23.tv/hop'+n}}));await assert.rejects(f.client.resolveShort('abcd'));assert.equal(f.calls.length,3);});
test('N7 DNS rejects all unsafe answers, pins one lookup per connection, handles mapped IPv6',async()=>{for(const ip of ['::ffff:127.0.0.1','::ffff:7f00:1','::ffff:10.0.0.1','fe80::1','100.64.0.1','0.0.0.0','::','::1','fc00::1','ff00::1','64:ff9b::0808:0808','2001:db8::1','192.0.2.1','198.18.0.1','224.0.0.1'])assert.equal(isPublic(ip),false,ip);assert.equal(isPublic('2606:4700:4700::1111'),true);const lookup=createSafeLookup((_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}]));await assert.rejects(new Promise((resolve,reject)=>lookup('api.bilibili.com',{},(e,a)=>e?reject(e):resolve(a))));let n=0;const f=fixture(undefined,{lookup:(_h,_o,cb)=>cb(null,[{address:++n===1?'8.8.8.8':'127.0.0.1',family:4}])});await f.client.biliApi('/x');await assert.rejects(f.client.biliApi('/x'));assert.equal(n,2);});
test('N8 streaming body limit destroys request',async()=>{const f=fixture(()=>({chunks:[Buffer.alloc(1_500_000),Buffer.alloc(600_000)]}));await assert.rejects(f.client.biliSubtitle('https://a.hdslb.com/a'));assert.ok(f.destroys>0);});
test('N9 reports and logs exclude exact cookie values and untrusted payload fields',async()=>{const cookies={SESSDATA:'session-secret-value',buvid3:'buvid-secret-value'}, reports=[],logs=[];const client={biliLight:async()=>({title:'session-secret-value',desc:'buvid-secret-value'}),sanitize:x=>sanitize(x,Object.values(cookies))};await runJob({id:'j',payload:{type:'bili',ref:BV,tier:'light',lease:'l',url:'https://evil.com',cookie:'session-secret-value'}},client,async(path,b)=>reports.push([path,b]),x=>logs.push(x));assert.ok(!JSON.stringify([reports,logs]).includes('session-secret-value'));assert.ok(!JSON.stringify([reports,logs]).includes('buvid-secret-value'));await runJob({id:'j',payload:{type:'x',ref:BV,tier:'light',lease:'l'}},client,async(path,b)=>reports.push([path,b]),x=>logs.push(x));assert.equal(reports.at(-1)[1].success,false);});


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
