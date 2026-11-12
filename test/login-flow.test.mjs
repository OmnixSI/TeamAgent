import {test} from 'node:test';
import assert from 'node:assert/strict';
import {env,req} from './support.mjs';
const url='https://passport.bilibili.com/h5-app/passport/login/scan?navhide=1&qrcode_key='+'a'.repeat(32)+'&from=';
const secrets=['FAKE-SESSION-PRIVATE','FAKE-CSRF-PRIVATE','FAKE-USER-PRIVATE','FAKE-BUVID-PRIVATE'];
const owner=(e,body,method)=>req(e,'/api/team/service-login',body,'owner-secret',method);
const runner=(e,path,body)=>req(e,'/api/runner/fetch/'+path,body,'runner-secret');
const start=async(e,service='bili')=>(await owner(e,{service})).json();
const claim=async e=>(await runner(e,'claim',{})).json();
const state=async e=>(await owner(e)).json();
const report=(e,login,phase,extra={})=>runner(e,'login-state',{id:login.id,service:login.service,phase,...extra});

test('login flow owner and runner auth reject members, missing tokens and unknown services',async()=>{
 const e=env();await req(e,'/api/admin/name-members',{members:['hongming','jinxiang','jinyi'].map(name=>({name,password:name}))});
 const {token}=await(await req(e,'/api/team/login-name',{password:'hongming'},'')).json();assert.equal(typeof token,'string');
 for(const method of ['GET','POST','DELETE'])assert.equal((await req(e,'/api/team/service-login',method==='GET'?undefined:{service:'bili'},token,method)).status,403);
 assert.equal((await req(e,'/api/team/service-login',undefined,'')).status,401);
 assert.equal((await req(e,'/api/runner/fetch/login-state',{service:'bili'},'')).status,401);
 assert.equal((await owner(e,{service:'bad'})).status,400);
});
test('one concurrent request per service, exactly one claim and no fetch job grabbed beside login',async()=>{
 const e=env(),responses=await Promise.all([owner(e,{service:'bili'}),owner(e,{service:'bili'})]);
 assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
 await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES('video','fetch','{}',?)").bind(Date.now()).run();
 const first=await claim(e);assert.ok(first.login);assert.equal(first.job,null);
 const next=await claim(e);assert.equal(next.login,null);assert.equal(next.job.id,'video');
 assert.equal((await e.DB.prepare("SELECT COUNT(*) AS n FROM jobs").first()).n,1);
});
test('waiting to scanned to ok, only display fields escape and terminal state erases qr',async()=>{
 const e=env();await start(e);const {login}=await claim(e);
 for(const phase of ['waiting','scanned']){
  assert.equal((await report(e,login,phase,{qr_url:url,cookie:secrets[0],SESSDATA:secrets[1]})).status,200);
  const s=await state(e);assert.equal(s.services.bili.flow.phase,phase);assert.equal(s.services.bili.flow.qr_url,url);
  assert.equal(s.online,true);assert.ok(!JSON.stringify(s).includes('cookie'));for(const x of secrets)assert.ok(!JSON.stringify(s).includes(x));
 }
 await runner(e,'auth-status',{service:'bili',state:'ok'});await report(e,login,'ok',{qr_url:url});
 const s=await state(e);assert.equal(s.services.bili.flow.phase,'ok');assert.equal(s.services.bili.auth.state,'ok');assert.equal(s.services.bili.flow.qr_url,undefined);
 assert.ok(!(await e.DB.prepare("SELECT value FROM settings WHERE key='login-flow:bili'").first()).value.includes('qr_url'));
 assert.equal((await report(e,login,'waiting',{qr_url:url})).status,409);
});
test('rejects unsafe QR URLs, credential query parameters and URLs on X flows',async()=>{
 const e=env();await start(e);const {login}=await claim(e);
 for(const qr_url of ['https://evil.com/scan','https://passport.bilibili.com.evil.test/scan','http://passport.bilibili.com/scan','https://u:p@passport.bilibili.com/scan','https://passport.bilibili.com:8443/scan','https://passport.bilibili.com/unrelated','https://passport.bilibili.com/h5-app/passport/login/scan?SESSDATA='+secrets[0],url+'&cookie='+secrets[0],url+'x'.repeat(500)])assert.equal((await report(e,login,'waiting',{qr_url})).status,400,qr_url);
 await start(e,'x');const x=(await claim(e)).login;assert.equal(x.service,'x');assert.equal((await report(e,x,'waiting',{qr_url:url})).status,400);
});
test('cancellation invalidates old reports and requests, removes QR and permits a fresh flow',async()=>{
 const e=env();await start(e);const {login}=await claim(e);await report(e,login,'waiting',{qr_url:url});
 assert.equal((await owner(e,{service:'bili',id:login.id},'DELETE')).status,200);
 assert.equal((await state(e)).services.bili.flow.phase,'cancelled');assert.equal((await report(e,login,'ok')).status,409);
 const fresh=await start(e);assert.notEqual(fresh.flow.id,login.id);
 assert.equal((await owner(e,{service:'bili',id:login.id},'DELETE')).status,409);
});
test('expired/failed statuses and five minute timeout clear QR; stale flow and offline heartbeat disappear',async()=>{
 const e=env();for(const phase of ['expired','failed']){
  await start(e);const {login}=await claim(e);await report(e,login,'waiting',{qr_url:url});await report(e,login,phase,{qr_url:url,reason:'risk',cookie:secrets[0]});
  const flow=(await state(e)).services.bili.flow;assert.equal(flow.phase,phase);assert.equal(flow.qr_url,undefined);
 }
 await start(e);const {login}=await claim(e);await report(e,login,'waiting',{qr_url:url});
 const originalNow=Date.now;const later=originalNow()+300001;
 try{Date.now=()=>later;const s=await state(e);assert.equal(s.services.bili.flow,null);assert.equal(s.online,false);assert.equal((await report(e,login,'ok')).status,409);assert.equal((await owner(e,{service:'bili'})).status,200);}finally{Date.now=originalNow;}
});
test('runner pause gate also prevents login claims; invocation statement counts remain within 48',async()=>{
 const e=env();await start(e);await e.DB.prepare("INSERT INTO settings VALUES('runner_pause_until',?)").bind(String(Date.now()+60000)).run();
 assert.equal((await claim(e)).login,undefined);
 await e.DB.prepare("DELETE FROM settings WHERE key='runner_pause_until'").run();
 const actions=[()=>claim(e),()=>state(e),()=>owner(e,{service:'x'})];
 for(const action of actions){const before=e.DB.executed;await action();assert.ok(e.DB.executed-before<=48);}
});
test('owner to fake local fetcher to saved credentials and auth status works end to end within budget',async t=>{
 const {mkdtemp,rm,readFile}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {runLoginFlow}=await import('../runner/qr-login.mjs'),{createBrowserAuth}=await import('../runner/browser-auth.mjs');
 const home=await mkdtemp(join(tmpdir(),'team-login-e2e-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const e=env();await start(e);const {login}=await claim(e);let i=0;
 const client={isPaused:()=>false,setSessionCookies(){},anonymousBuvid:async()=>secrets[3],biliPassport:async action=>action==='generate'?{body:{code:0,data:{url,qrcode_key:'a'.repeat(32)}}}:{body:{code:0,data:{code:[86101,86090,0][i++]}},headers:{'set-cookie':secrets.slice(0,3).map((s,j)=>['SESSDATA','bili_jct','DedeUserID'][j]+'='+s+'; Max-Age=3600')}}};
 const cloud=async(path,body)=>{const before=e.DB.executed,r=await runner(e,path,body);assert.ok(e.DB.executed-before<=48);if(!r.ok){const error=Error('conflict');error.status=r.status;throw error;}return r.json();};
 const auth=createBrowserAuth({home,client,notify:async()=>{},report:b=>cloud('auth-status',b)});
 assert.equal(await runLoginFlow(login,{home,client,auth,cloud,sleep:async()=>{}}),'ok');
 const view=await state(e);assert.equal(view.services.bili.auth.state,'ok');assert.equal(view.services.bili.flow.phase,'ok');
 for(const secret of secrets)assert.ok(!JSON.stringify(view).includes(secret));assert.ok(!JSON.stringify(view).includes('cookie'));
 assert.equal(JSON.parse(await readFile(join(home,'secrets/bili-cookie.json'),'utf8')).SESSDATA.value,secrets[0]);
});
test('QR login uses the local service lock so desktop/background login cannot overwrite it',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');
 const {runLoginFlow}=await import('../runner/qr-login.mjs'),{createBrowserAuth}=await import('../runner/browser-auth.mjs');
 const home=await mkdtemp(join(tmpdir(),'team-login-lock-'));t.after(()=>rm(home,{recursive:true,force:true}));
 let opened,release;const started=new Promise(r=>opened=r),blocked=new Promise(r=>release=r);
 const client={isPaused:()=>false,biliPassport:async action=>{if(action==='generate'){opened();await blocked;return {body:{code:0,data:{url,qrcode_key:'a'.repeat(32)}}};}return {body:{code:0,data:{code:86038}},headers:{}};}};
 const auth=createBrowserAuth({home,client,notify:async()=>{}});
 const task=runLoginFlow({id:'lock',service:'bili',expires_at:Date.now()+300000},{home,client,auth,cloud:async()=>({ok:true})});
 await started;
 try{assert.equal(await auth.check('bili'),null);}finally{release();await task;}
});
