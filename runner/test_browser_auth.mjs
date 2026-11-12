import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,stat,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createBrowserAuth,allowedBrowserUrl,browserOptions,writeBiliCookies,loadBiliCookies,safeLogText} from './browser-auth.mjs';
import {createFetchClient,runJob} from './fetcher.mjs';

const values={SESSDATA:'fixture-session-private',bili_jct:'fixture-csrf-private',DedeUserID:'fixture-user-private',buvid3:'fixture-buvid-private'};
const cookies=()=>[...Object.entries(values).map(([name,value])=>({name,value,expires:2000000000})),{name:'unrelated',value:'never-export',expires:2000000000}];
async function temp(t){const home=await mkdtemp(join(tmpdir(),'team-auth-'));t.after(()=>rm(home,{recursive:true,force:true}));return home;}
function fixture(home,extra={}){
 let time=new Date(2026,10,12,8,59,58).getTime(),closed=0,probes=0,cookieReads=0;
 const reports=[],notices=[],launches=[];
 const page={goto:async()=>{},url:()=> 'https://x.com/home',locator:selector=>({first(){return this;},isVisible:async()=>selector.includes('SideNav_AccountSwitcher_Button')})};
 const ctx={pages:()=>[page],route:async(_pattern,handler)=>{ctx.handler=handler;},routeWebSocket:async()=>{},cookies:async()=>{cookieReads++;return cookies();},close:async()=>{closed++;}};
 const auth=createBrowserAuth({home,now:()=>time,sleep:async ms=>{time+=ms;},launch:async(service,options)=>{launches.push([service,options]);return ctx;},probeBili:async()=>{probes++;return 'ok';},report:async b=>reports.push(b),notify:async text=>notices.push(text),...extra});
 return {auth,reports,notices,launches,ctx,page,get time(){return time;},setTime(t){time=t;},get closed(){return closed;},get probes(){return probes;},get cookieReads(){return cookieReads;}};
}
test('L1 Bili login closes browser and exports only four expiring cookies with private permissions',async t=>{
 const home=await temp(t),f=fixture(home);assert.equal(await f.auth.login('bili'),'ok');assert.equal(f.closed,1);
 const file=join(home,'secrets/bili-cookie.json'),saved=JSON.parse(await readFile(file,'utf8'));
 assert.deepEqual(Object.keys(saved).sort(),Object.keys(values).sort());assert.equal(saved.SESSDATA.value,values.SESSDATA);assert.equal(saved.SESSDATA.expires,2000000000);
 assert.equal((await stat(file)).mode&0o777,0o600);
 for(const p of ['secrets','browser','browser/bili'])assert.equal((await stat(join(home,p))).mode&0o777,0o700);
 assert.equal(f.reports.at(-1).state,'ok');assert.match(f.notices[0],/B 站已登录/);
 for(const secret of Object.values(values))assert.ok(!JSON.stringify([f.reports,f.notices]).includes(secret));
});
test('L2 login polls every two seconds and closes at five-minute timeout without exporting',async t=>{
 const home=await temp(t),f=fixture(home,{probeBili:async()=> 'expired'}),start=f.time;
 assert.equal(await f.auth.login('bili'),'timeout');assert.equal(f.closed,1);assert.equal(f.time-start,300000);
 await assert.rejects(readFile(join(home,'secrets/bili-cookie.json')));assert.equal(f.reports.length,0);
});
test('L3 X login and headless check never export or read cookies',async t=>{
 const home=await temp(t),f=fixture(home);f.ctx.cookies=async()=>{throw Error('X cookies must stay inside browser');};
 assert.equal(await f.auth.login('x'),'ok');assert.equal(await f.auth.check('x'),'ok');assert.equal(f.closed,2);
 assert.equal(f.launches[0][1].headless,false);assert.equal(f.launches[1][1].headless,true);
 await assert.rejects(readFile(join(home,'secrets/bili-cookie.json')));
});
test('L4 browser routing confines exact service hosts and denies third-party, local and credential URLs',async t=>{
 for(const url of ['https://x.com/home','https://twitter.com/login','https://abs.twimg.com/a','https://pbs.twimg.com/a'])assert.equal(allowedBrowserUrl('x',url),true);
 for(const url of ['https://x.com.evil.test/a','https://evilx.com/a','https://api.bilibili.com/x','http://x.com','https://x.com:8443','file:///etc/passwd','https://u:p@x.com','https://127.0.0.1/a'])assert.equal(allowedBrowserUrl('x',url),false,url);
 assert.equal(allowedBrowserUrl('bili','https://passport.bilibili.com/login'),true);assert.equal(allowedBrowserUrl('bili','https://a.hdslb.com/a'),true);assert.equal(allowedBrowserUrl('bili','https://x.com'),false);
 const f=fixture(await temp(t));await f.auth.login('x');let aborted=0,continued=0;
 await f.ctx.handler({request:()=>({url:()=> 'https://evil.test'}),abort:async()=>aborted++,continue:async()=>continued++});assert.equal(aborted,1);assert.equal(continued,0);
});
test('L5 browser selection prefers system Chrome, then cached Chromium, then gives an actionable error',async()=>{
 const chromium={executablePath:()=>'/cache/chromium/chrome'};
 assert.equal((await browserOptions(chromium,{exists:p=>p.includes('Google Chrome.app'),cacheEntries:async()=>[]})).channel,'chrome');
 assert.equal((await browserOptions(chromium,{exists:p=>p==='/cache/chromium/chrome',cacheEntries:async()=>[]})).executablePath,'/cache/chromium/chrome');
 await assert.rejects(browserOptions(chromium,{exists:()=>false,cacheEntries:async()=>[]}),/需要装一次/);
});
test('L6 local status persists ok-to-expired/risk transitions, no missing reminders, no secrets in reports',async t=>{
 const home=await temp(t);let state='ok';const f=fixture(home,{probeBili:async()=>state});await f.auth.login('bili');state='expired';await f.auth.check('bili');await f.auth.check('bili');
 assert.equal(f.notices.filter(x=>x.includes('过期')).length,1);
 state='ok';await f.auth.check('bili');state='risk';await f.auth.check('bili');assert.equal(f.reports.at(-1).state,'risk');
 const missing=fixture(await temp(t));assert.equal(await missing.auth.check('bili'),'missing');assert.equal(missing.notices.length,0);
 for(const secret of Object.values(values))assert.ok(!JSON.stringify([f.reports,f.notices]).includes(secret));
 assert.deepEqual(Object.keys(f.reports[0]).sort(),['checked_at','service','state']);
});
test('L7 daily checks run once after local 09:00 and again the next day',async t=>{
 const f=fixture(await temp(t));await f.auth.login('bili');await f.auth.daily();assert.equal(f.reports.length,1);
 f.setTime(new Date(2026,10,12,9,0,0).getTime());await f.auth.daily();const n=f.reports.length;assert.equal(n,3);await f.auth.daily();assert.equal(f.reports.length,n);
 f.setTime(new Date(2026,10,13,9,0,0).getTime());await f.auth.daily();assert.equal(f.reports.length,n+2);
});
test('L8 pre-use check removes expired session and preserves anonymous fetch fallback',async t=>{
 const home=await temp(t);await writeBiliCookies(home,cookies());let current='ok';const f=fixture(home,{probeBili:async()=>current});let prepared;
 const client={setSessionCookies:c=>{prepared=c;},isPaused:()=>false};await f.auth.prepareBili(client);assert.equal(prepared.SESSDATA,values.SESSDATA);
 current='expired';await f.auth.prepareBili(client);assert.equal(prepared.SESSDATA,undefined);
 const reports=[];let before=0;await runJob({id:'j',payload:{type:'bili',ref:'BV1xx411c7mD',tier:'light',lease:'l'}},{biliLight:async()=>({title:'anonymous'}),sanitize:x=>x},async(_p,b)=>reports.push(b),()=>{},async()=>{before++;});assert.equal(before,1);assert.equal(reports[0].success,true);
});
test('L9 expired cookies are detected before probing and exact values are scrubbed before logging',async t=>{
 const home=await temp(t);await writeBiliCookies(home,cookies().map(c=>({...c,expires:1})));let probes=0;const f=fixture(home,{probeBili:async()=>{probes++;return 'ok';}});
 assert.equal(await f.auth.check('bili'),'expired');assert.equal(probes,0);
 const flat=await loadBiliCookies(home);assert.equal(flat.SESSDATA.value,values.SESSDATA);
 const text=safeLogText('sample '+values.SESSDATA+' sk-abcdefghijklmnopqr',Object.values(values));assert.ok(!text.includes(values.SESSDATA));assert.ok(!text.includes('sk-abcdefghijklmnopqr'));
});
test('L10 browser launch failures surface only a fixed message and do not export cookie files',async t=>{
 const f=fixture(await temp(t),{launch:async()=>{throw Error(values.SESSDATA);}});
 await assert.rejects(f.auth.login('bili'),error=>!error.message.includes(values.SESSDATA));assert.equal(f.reports.length,0);
});
test('L11 background checks do not overwrite status while the user is logging in',async t=>{
 const home=await temp(t),f=fixture(home);let release,started;
 const opened=new Promise(r=>{started=r;});f.page.goto=async()=>{started();await new Promise(r=>{release=r;});};
 const pending=f.auth.login('bili');await opened;
 const background=fixture(home);
 try{assert.equal(await background.auth.check('bili'),null);assert.equal(background.reports.length,0);}
 finally{release();await pending;}
 assert.equal(await background.auth.check('bili'),'ok');
});
test('L12 deadline closing the browser during a probe still returns a clean timeout',async t=>{
 const f=fixture(await temp(t),{probeBili:async()=>{f.setTime(f.time+300000);throw Error('browser closed at deadline');}});
 assert.equal(await f.auth.login('bili'),'timeout');assert.equal(f.closed,1);assert.equal(f.reports.length,0);
});
test('L15 X service errors, empty pages and navigation failures preserve the prior status without notices',async t=>{
 for(const mode of ['503','empty','timeout']){
  const home=await temp(t),f=fixture(home);await f.auth.record('x','ok');
  const before=await readFile(join(home,'state/auth-x.json'),'utf8');
  f.page.locator=()=>({first(){return this;},isVisible:async()=>false});
  f.page.goto=async()=>{if(mode==='timeout')throw Error('navigation timeout');return {status:()=>mode==='503'?503:200};};
  assert.equal(await f.auth.check('x'),null,mode);
  assert.equal(await readFile(join(home,'state/auth-x.json'),'utf8'),before,mode);
  assert.equal(f.notices.length,0);assert.equal(f.reports.length,1);assert.equal(f.closed,1);
 }
});
test('L16 X explicit login redirect or visible login form expires the session once',async t=>{
 for(const mode of ['redirect','form']){
  const f=fixture(await temp(t));await f.auth.record('x','ok');
  f.page.goto=async()=>({status:()=>200});
  f.page.url=()=>mode==='redirect'?'https://x.com/i/flow/login':'https://x.com/home';
  f.page.locator=selector=>({first(){return this;},isVisible:async()=>mode==='form'&&selector.includes('input[autocomplete="username"]')});
  assert.equal(await f.auth.check('x'),'expired',mode);await f.auth.check('x');
  assert.equal(f.notices.length,1);assert.equal(f.reports.at(-1).state,'expired');
 }
});
test('L17 owner cancellation closes X during navigation and cannot overwrite auth state',async t=>{
 const controller=new AbortController(),f=fixture(await temp(t));
 f.page.goto=async()=>{controller.abort();throw Error('navigation cancelled');};
 assert.equal(await f.auth.login('x',{signal:controller.signal}),'cancelled');assert.ok(f.closed>=1);assert.equal(f.reports.length,0);
});
test('L18 X request deadline closes the window and does not report successful login after expiry',async t=>{
 const f=fixture(await temp(t));f.page.goto=async()=>{f.setTime(f.time+5000);};
 assert.equal(await f.auth.login('x',{deadline:f.time+1000}),'timeout');assert.equal(f.closed,1);assert.equal(f.reports.length,0);
});
