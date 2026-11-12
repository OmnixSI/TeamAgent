import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {env,req} from './support.mjs';
const script=readFileSync('web/app.js','utf8');
function ui(local=true,options={}){
 const ids=new Map(),requests=[],events=[],storage=new Map(),intervals=new Map();
 let now=options.now||Date.now(),timerId=0;
 class Clock extends Date{static now(){return now;}}
 if(options.session)storage.set('local-session',options.session);
 class Node{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.attrs={};this.hidden=false;this.isConnected=true;this.textContent='';}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}replaceChildren(...nodes){this.children.forEach(node=>node.parent=null);this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(node=>node!==this);this.parent=null;}
  setAttribute(k,v){this.attrs[k]=v;}focus(){}get value(){return this._value||'';}set value(v){this._value=v;}
 }
 const context=vm.createContext({document:{hidden:false,getElementById:id=>ids.get(id)||ids.set(id,new Node()).get(id),createElement:tag=>new Node(tag),createElementNS:(_ns,tag)=>new Node(tag)},sessionStorage:{getItem:key=>storage.get(key)||'',setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{hostname:options.startup?'127.0.0.1':'example.test',origin:options.startup?'http://127.0.0.1:3391':'https://team.example',hash:options.hash||''},history:{replaceState:(_state,_title,url)=>{events.push(['replace',url]);context.location.hash='';}},setInterval:(fn,ms)=>{const id=++timerId;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout:()=>1,clearTimeout:()=>{},TextEncoder,URL,Date:Clock,AbortSignal,console,
  fetch:async(path,opts)=>{requests.push({path,opts});events.push(['fetch',path]);if(options.fetch)return options.fetch(path,opts);return Response.json(path==='/api/local/session'?{session:'s'.repeat(43),expires_at:Date.now()+43200000}:path.startsWith('/api/local/')?(context.localResponse||{}):(context.response||{}),{status:context.responseStatus||200});},container:new Node()});
 vm.runInContext(script,context);context.location.origin=local?'http://127.0.0.1:3391':'https://team.example';return {context,requests,events,storage,ids,intervals,now:()=>now,advance:ms=>now+=ms,tick:async(ms=1000)=>{now+=ms;for(const timer of [...intervals.values()])if(timer.ms===1000)await timer.fn();}};
}
const text=n=>[n.textContent,...n.children.map(text)].join(' ');
const all=n=>[n,...n.children.flatMap(all)];
test('historical Bili risk permits retry while actual active-flow and countdown guards still work',async()=>{
 const f=await countdownUi();f.context.response.services.bili.auth={state:'risk'};
 await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
 let start=all(f.panel).find(n=>n.textContent==='登录 B 站');assert.equal(start.disabled,true);
 await start.onclick();assert.equal(f.requests.filter(r=>r.opts.method==='POST').length,0);
 await f.tick(180000);
 assert.match(text(f.panel),/B 站暂时限制，请稍后再试/);
 start=all(f.panel).find(n=>n.tagName==='button'&&/登录 B 站|重新获取二维码/.test(n.textContent));assert.equal(start.disabled,false);
 f.context.response.services.bili={auth:{state:'missing'},flow:{id:'flow',phase:'failed',reason:'risk',expires_at:f.now()+60000}};
 await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
 start=all(f.panel).find(n=>n.textContent==='登录 B 站');assert.equal(start.disabled,false);
 delete f.context.response.services.bili.flow.reason;
 await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
 assert.equal(all(f.panel).find(n=>n.textContent==='登录 B 站').disabled,false);
});
async function riskUi(t){
 const [{mkdtemp,rm,readFile},{join},{tmpdir},{EventEmitter},{createFetchClient},{createBrowserAuth},{runLoginFlow}]=await Promise.all([
  import('node:fs/promises'),import('node:path'),import('node:os'),import('node:events'),import('../runner/fetcher.mjs'),import('../runner/browser-auth.mjs'),import('../runner/qr-login.mjs')]);
 const home=await mkdtemp(join(tmpdir(),'team-risk-retry-')),e=env(),calls=[],tasks=[];
 let f,auth,mode='risk',runningId,ready,release;
 t.after(async()=>{try{if(release){await owner({service:'bili',id:runningId},'DELETE');release();await Promise.all(tasks);}}finally{await rm(home,{recursive:true,force:true});}});
 const call=async(path,body,key='owner-secret',method)=>{
  const before=e.DB.executed,response=await req(e,path,body,key,method);assert.ok(e.DB.executed-before<=48);return response;
 };
 const owner=(body,method)=>call('/api/team/service-login',body,'owner-secret',method);
 const cloud=async(path,body)=>{const r=await call('/api/runner/fetch/'+path,body,'runner-secret');if(!r.ok){const error=Error('flow conflict');error.status=r.status;throw error;}return r.json();};
 const execute=async()=>{
  const {login}=await cloud('claim',{});assert.ok(login);runningId=login.id;
  if(mode==='waiting'){
   const shown=new Promise(resolve=>ready=resolve),pending=new Promise(resolve=>release=resolve);
   const task=runLoginFlow(login,{home,client,auth,cloud,now:f.now,sleep:async()=>{ready();await pending;}});tasks.push(task);
   await Promise.race([shown,task]);
  }else return runLoginFlow(login,{home,client,auth,cloud,now:f.now});
 };
 f=ui(true,{now:new Date(2026,10,12,9,5).getTime(),session:'s'.repeat(43),fetch:async(path,options)=>{
  if(path.startsWith('/api/local/')){
   const id=new URL(path,'http://127.0.0.1:3391').searchParams.get('id');
   try{return Response.json(JSON.parse(await readFile(join(home,'state/login-qr/bili-'+id+'.json'),'utf8')));}catch{return Response.json({error:'二维码暂未就绪'},{status:404});}
  }
  const method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;
  if(method==='GET')await e.DB.prepare("INSERT INTO settings VALUES('fetcher:last-seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(f.now())).run();
  const response=await call(path,body,'owner-secret',method);
  if(method==='POST'&&response.ok)await execute();
  return response;
 }});
 t.mock.method(Date,'now',f.now);
 const client=createFetchClient({now:f.now,sleep:async ms=>f.advance(ms),random:()=>0,lookup:(_h,_o,cb)=>cb(null,[{address:'8.8.8.8',family:4}]),request:(options,callback)=>{
  const request=new EventEmitter();request.destroy=()=>{};request.end=()=>{
   calls.push(options);const response=new EventEmitter();response.statusCode=mode==='risk'?412:200;response.headers={};
   const data=options.path.includes('/generate')?{url:'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key='+'a'.repeat(32),qrcode_key:'a'.repeat(32)}:{code:86101};
   callback(response);queueMicrotask(()=>{response.emit('data',Buffer.from(JSON.stringify({code:0,data})));response.emit('end');});
  };return request;
 }});
 auth=createBrowserAuth({home,client,now:f.now,launch:async()=>{throw Error('must not open a browser');},notify:async()=>{},report:body=>cloud('auth-status',body)});
 await auth.daily();
 assert.equal((JSON.parse(await readFile(join(home,'state/auth-daily.json'),'utf8'))).day,'2026-11-12');
 await owner({service:'bili'});assert.equal(await execute(),'failed');assert.equal(client.isPaused(),true);assert.equal(calls.length,1);
 vm.runInContext("state={who:{role:'owner'}};view='system'",f.context);
 await vm.runInContext('renderServiceLogins(container)',f.context);
 const panel=f.context.container.children[0];f.ids.set('service-logins',panel);
 return {...f,client,auth,calls,owner,execute,panel,waitForQr:()=>{mode='waiting';},start:()=>all(panel).find(n=>n.textContent==='登录 B 站')};
}
test('real shared runner gate rejects a newly claimed login during pause with zero Bili requests',async t=>{
 const f=await riskUi(t),before=f.calls.length;
 assert.equal((await f.owner({service:'bili'})).status,200,'Worker accepts the queue request; the local runner enforces the pause');
 assert.equal(await f.execute(),'failed');assert.equal(f.calls.length,before);
 const snapshot=await(await f.owner()).json();assert.equal(snapshot.services.bili.flow.phase,'failed');assert.equal(snapshot.services.bili.flow.reason,'risk');
 assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,0);
});
test('risk retry is clickable, shows runner rejection without QR, and recovers after pause despite stale daily auth',async t=>{
 const f=await riskUi(t),before=f.calls.length;
 assert.equal(f.start().disabled,false);await f.start().onclick();
 assert.match(text(f.panel),/B 站暂时限制，请稍后再试/);assert.equal(f.calls.length,before);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,0);
 await f.tick(600001);assert.equal(f.client.isPaused(),false);
 await f.auth.daily();assert.equal(f.calls.length,before);
 assert.equal((await(await f.owner()).json()).services.bili.auth.state,'risk','daily is already done; do not manually clear the persisted status');
 assert.equal(f.start().disabled,false);f.waitForQr();await f.start().onclick();
 assert.ok(f.calls.length>before);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,1);assert.match(text(f.panel),/等待扫码/);
});
test('logged-in X offers an enabled relogin action for both auth and completed-flow state',async()=>{
 for(const entry of [{auth:{state:'ok'},flow:null},{auth:{state:'missing'},flow:{id:'x',phase:'ok',expires_at:Date.now()+300000}}]){
  const f=ui();vm.runInContext("state={who:{role:'owner'}}",f.context);
  f.context.response={online:true,services:{bili:{auth:null,flow:null},x:entry}};
  await vm.runInContext('renderServiceLogins(container)',f.context);
  const start=all(f.context.container).find(n=>n.textContent==='重新登录 X');assert.ok(start);assert.equal(start.disabled,false);
  await start.onclick();assert.deepEqual(JSON.parse(f.requests.find(r=>r.opts.method==='POST').opts.body),{service:'x'});
 }
});
test('existing navigation keeps every label keyboard-reachable and the new-task action in the page shell',()=>{
 const f=ui(),nav=f.ids.get('tabs'),labels=['任务与方案','资料与发现','项目动态','记忆与成长','操作记录','运行状态'];
 assert.deepEqual(nav.children.map(n=>n.textContent),labels);assert.equal(nav.attrs.role,'tablist');
 for(const tab of nav.children){f.ids.set(tab.id,tab);assert.equal(tab.attrs.role,'tab');}
 vm.runInContext('render=()=>{};load=()=>{}',f.context);
 for(let i=1;i<labels.length;i++){
  nav.onkeydown({key:'ArrowRight',preventDefault(){}});
  assert.equal(nav.children[i].attrs['aria-selected'],'true');
 }
 const html=readFileSync('web/index.html','utf8');
 assert.match(html,/<nav id="tabs" class="tabs" aria-label="工作台页面"><\/nav>/);
 assert.match(html,/<button id="new" class="primary">＋ 新任务<\/button>/);
 assert.equal(typeof f.ids.get('new').onclick,'function');
});
async function retryUi(t){
 const e=env(),qrs=new Map(),controls={},statuses=[],qrReads=[];
 let f,qrSequence=0;
 const call=async(path,body,key='owner-secret',method)=>{
  const before=e.DB.executed,response=await req(e,path,body,key,method);
  assert.ok(e.DB.executed-before<=48);return response;
 };
 const owner=(body,method)=>call('/api/team/service-login',body,'owner-secret',method);
 const publish=async()=>{
  const {login}=await(await call('/api/runner/fetch/claim',{},'runner-secret')).json();assert.ok(login);
  assert.equal((await call('/api/runner/fetch/login-state',{id:login.id,service:'bili',phase:'waiting'},'runner-secret')).status,200);
  qrs.set(login.id,{id:login.id,qr_url:'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key='+String(++qrSequence).repeat(32),expires_at:login.expires_at});
 };
 f=ui(true,{session:'s'.repeat(43),fetch:async(path,options)=>{
  if(path.startsWith('/api/local/service-login/qr')){
   const id=new URL(path,'http://127.0.0.1:3391').searchParams.get('id');qrReads.push(id);
   return qrs.has(id)?Response.json(qrs.get(id)):Response.json({error:'二维码暂未就绪'},{status:404});
  }
  const method=options.method||'GET',body=options.body?JSON.parse(options.body):undefined;
  if(method==='DELETE'&&controls.cancel){const response=await controls.cancel(body);if(response)return response;}
  // Simulate the fetcher's heartbeat while using the real Worker and isolated SQLite.
  if(method==='GET')await e.DB.prepare("INSERT INTO settings VALUES('fetcher:last-seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(f.now())).run();
  const response=await call(path,body,'owner-secret',method);statuses.push({method,status:response.status});
  if(method==='DELETE'&&response.ok)qrs.delete(body.id);
  if(method==='POST'&&response.ok)await publish();
  return response;
 }});
 t.mock.method(Date,'now',()=>f.now());
 const {flow}=await(await owner({service:'bili'})).json();await publish();
 vm.runInContext("state={who:{role:'owner'}};view='system'",f.context);
 await vm.runInContext('renderServiceLogins(container)',f.context);
 f.panel=f.context.container.children[0];f.ids.set('service-logins',f.panel);
 const oldQr=all(f.panel).find(n=>n.tagName==='path').attrs.d;
 await f.tick(180000);
 assert.match(text(f.panel),/已过期/);
 return {...f,e,owner,publish,controls,statuses,qrReads,oldFlow:flow,oldQr,retry:()=>all(f.panel).find(n=>n.textContent==='重新获取二维码'),newPosts:()=>f.requests.filter(r=>r.opts.method==='POST')};
}
test('expired QR retry cancels the still-active five-minute Worker flow before getting a fresh QR',async t=>{
 const f=await retryUi(t);
 assert.equal((await f.owner({service:'bili'})).status,409,'reproduce the old direct-POST conflict at 180 seconds');
 await f.retry().onclick();
 assert.deepEqual(f.statuses.filter(r=>r.method!=='GET').map(r=>[r.method,r.status]),[['DELETE',200],['POST',200]]);
 const current=(await(await f.owner()).json()).services.bili.flow;
 assert.notEqual(current.id,f.oldFlow.id);assert.equal(f.newPosts().length,1);assert.equal(f.qrReads.at(-1),current.id);
 assert.notEqual(all(f.panel).find(n=>n.tagName==='path')?.attrs.d,f.oldQr);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,1);
 assert.ok(f.requests.every(r=>r.opts.headers['X-TeamAgent-Session']==='s'.repeat(43)));
});
test('failed cancellation reports a clear error, leaves retry usable and creates no login',async t=>{
 const f=await retryUi(t);f.controls.cancel=async()=>Response.json({error:'synthetic failure'},{status:503});
 await f.retry().onclick();
 assert.match(f.ids.get('error').textContent,/取消.*失败.*未.*登录/);assert.equal(f.newPosts().length,0);
 assert.equal((await(await f.owner()).json()).services.bili.flow.id,f.oldFlow.id);assert.equal(f.retry().disabled,false);
});
test('retry handles an already-finished cancellation conflict but never replaces another active flow',async t=>{
 const f=await retryUi(t);
 f.controls.cancel=async()=>{
  await f.owner({service:'bili',id:f.oldFlow.id},'DELETE');
  return Response.json({error:'登录请求已变化，请刷新'},{status:409});
 };
 await f.retry().onclick();assert.equal(f.newPosts().length,1);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,1);
 // A separate client creates a replacement while our old retry button is stale.
 await f.tick(180000);const stale=(await(await f.owner()).json()).services.bili.flow;
 let replacement;
 f.controls.cancel=async()=>{
  await f.owner({service:'bili',id:stale.id},'DELETE');replacement=(await(await f.owner({service:'bili'})).json()).flow;await f.publish();
  return Response.json({error:'登录请求已变化，请刷新'},{status:409});
 };
 await f.retry().onclick();assert.equal(f.newPosts().length,1);
 assert.equal((await(await f.owner()).json()).services.bili.flow.id,replacement.id);
 assert.match(f.ids.get('error').textContent,/登录.*变化.*未.*登录/);
});
test('concurrent retry clicks across a heartbeat redraw cancel and create only once',async t=>{
 const f=await retryUi(t);let entered,release;
 const started=new Promise(resolve=>entered=resolve),pending=new Promise(resolve=>release=resolve);
 f.controls.cancel=async()=>{entered();await pending;};
 const first=f.retry().onclick();
 try{
  await started;await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
  const second=f.retry().onclick();release();await Promise.all([first,second]);
 }finally{release();}
 assert.equal(f.requests.filter(r=>r.opts.method==='DELETE').length,1);assert.equal(f.newPosts().length,1);
 const current=(await(await f.owner()).json()).services.bili.flow;
 assert.notEqual(current.id,f.oldFlow.id);assert.equal(f.qrReads.at(-1),current.id);
});
async function countdownUi(ttl=300000){
 const f=ui(),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 vm.runInContext("state={who:{role:'owner'}};view='system'",f.context);
 f.context.response={online:true,services:{bili:{auth:null,flow:{id:'flow',phase:'waiting',expires_at:f.now()+ttl}},x:{auth:null,flow:null}}};
 f.context.localResponse={id:'flow',qr_url:fixture.text,expires_at:f.now()+ttl};
 await vm.runInContext('renderServiceLogins(container)',f.context);
 f.panel=f.context.container.children[0];f.ids.set('service-logins',f.panel);
 f.countdown=()=>all(f.panel).find(node=>node.attrs.role==='timer');
 return f;
}
test('QR countdown advances once per second and refresh or scanned phase never extends its deadline',async()=>{
 const f=await countdownUi();
 assert.match(f.countdown()?.textContent||'',/180 秒/);
 await f.tick();assert.match(f.countdown().textContent,/179 秒/);
 f.context.response.services.bili.flow.phase='scanned';
 await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
 assert.match(f.countdown().textContent,/179 秒/);
 await f.tick(2000);assert.match(f.countdown().textContent,/177 秒/);
 f.context.container.replaceChildren();await vm.runInContext('renderServiceLogins(container)',f.context);
 f.panel=f.context.container.children[0];f.ids.set('service-logins',f.panel);
 assert.match(f.countdown().textContent,/177 秒/);
});
test('QR countdown respects earlier expiry and zero removes QR, enables retry and cannot revive from stale waiting',async()=>{
 const f=await countdownUi(2500);
 assert.match(f.countdown()?.textContent||'',/3 秒/);
 await f.tick();assert.match(f.countdown().textContent,/2 秒/);
 await f.tick(1500);
 assert.match(text(f.panel),/已过期/);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,0);
 const retry=all(f.panel).find(n=>n.tagName==='button'&&n.textContent==='重新获取二维码');assert.ok(retry);assert.equal(retry.disabled,false);
 assert.ok(!all(f.panel).some(n=>n.textContent==='取消登录'));
 await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
 assert.match(text(f.panel),/已过期/);assert.equal(all(f.panel).filter(n=>n.tagName==='svg').length,0);
 const capped=await countdownUi();await capped.tick(180000);await vm.runInContext('refreshServiceLogins(container.children[0])',capped.context);
 assert.match(text(capped.panel),/已过期/);assert.equal(all(capped.panel).filter(n=>n.tagName==='svg').length,0);
});
test('cancel, terminal, failed refresh and detached panels stop countdown without adding timers',async()=>{
 for(const phase of ['cancelled','ok','expired','failed','error','detached']){
  const f=await countdownUi(),clock=f.countdown(),timerCount=f.intervals.size;
  assert.ok(clock);
  if(phase==='detached')f.panel.isConnected=false;
  else{
   if(phase==='error'){f.context.responseStatus=503;f.context.response={error:'暂不可用'};}
   else f.context.response.services.bili.flow.phase=phase;
   if(phase==='cancelled')await all(f.panel).find(n=>n.textContent==='取消登录').onclick();
   else await vm.runInContext('refreshServiceLogins(container.children[0])',f.context);
  }
  const previous=clock.textContent;await f.tick();assert.equal(clock.textContent,previous);
  assert.equal(f.panel.loginCountdown,null);assert.equal(f.intervals.size,timerCount);
 }
 const f=await countdownUi(),timerCount=f.intervals.size;
 for(let i=0;i<5;i++)await vm.runInContext('renderServiceLogins(container)',f.context);
 assert.equal(f.intervals.size,timerCount);
});
test('X login guidance names the local Chrome window, real x.com and never asks for a web password',async()=>{
 const f=await countdownUi(),card=all(f.panel).find(n=>n.tagName==='article'&&n.children[0].textContent==='X');
 assert.match(text(card),/这台 Mac.*Chrome 窗口/);assert.match(text(card),/弹出的 Chrome.*真实.*x\.com.*登录/);
 assert.match(text(card),/不要在本网页.*输入密码/);assert.match(text(card),/本网页不会也不需要你的密码/);
 assert.ok(!all(card).some(n=>n.tagName==='input'));
});
test('browser QR matrix matches independent reference for fixed version 10-L mask 0',()=>{
 const {context}=ui(),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 context.qrText=fixture.text;const matrix=vm.runInContext('loginQrMatrix(qrText)',context);
 assert.equal(matrix.length,57);assert.ok(matrix.every(row=>row.length===57));
 const bits=matrix.flat().map(Boolean).map(x=>x?'1':'0').join('');
 assert.equal(createHash('sha256').update(bits).digest('hex'),fixture.matrix_sha256);
});
test('service login UI is owner only and shows offline truth without credential inputs',async()=>{
 const {context,requests}=ui();context.response={online:false,services:{bili:{auth:null,flow:null},x:{auth:null,flow:null}}};
 vm.runInContext("state={who:{role:'member'}}",context);await vm.runInContext('renderServiceLogins(container)',context);assert.equal(requests.length,0);
 vm.runInContext("state={who:{role:'owner'}}",context);await vm.runInContext('renderServiceLogins(container)',context);
 assert.match(text(context.container),/本机服务没有运行.*双击桌面.*TeamAgent-登录.*重启 Mac.*TeamAgent 服务/);assert.match(text(context.container),/登录 B 站/);assert.match(text(context.container),/登录 X/);
 assert.ok(!all(context.container).some(n=>['input','iframe','img'].includes(n.tagName)));
});
test('waiting/scanned QR is rendered locally, final and risk states remove it, X reports local window',async()=>{
 const {context,requests}=ui(),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 vm.runInContext("state={who:{role:'owner'}}",context);
 for(const phase of ['waiting','scanned','ok','failed']){
  context.container.replaceChildren();context.response={online:true,services:{bili:{auth:{state:'ok'},flow:{id:'flow',service:'bili',phase,reason:phase==='failed'?'risk':undefined,expires_at:Date.now()+300000}},x:{auth:null,flow:{id:'x',service:'x',phase:'waiting',started:true,expires_at:Date.now()+300000}}}};
  context.localResponse={id:'flow',qr_url:fixture.text,expires_at:Date.now()+300000};
  await vm.runInContext('renderServiceLogins(container)',context);
  assert.equal(all(context.container).filter(n=>n.tagName==='svg').length,['waiting','scanned'].includes(phase)?1:0);
  assert.match(text(context.container),/已在你的电脑上打开登录窗口/);
  if(phase==='failed')assert.match(text(context.container),/B 站暂时限制，请稍后再试/);
 }
 assert.ok(requests.every(x=>x.path==='/api/team/service-login'||x.path==='/api/local/service-login/qr?id=flow'));
 assert.ok(requests.some(x=>x.path.startsWith('/api/local/')&&x.opts.headers['X-TeamAgent-Local']==='1'));
 assert.ok(!JSON.stringify(requests).includes(fixture.text));
});
test('remote owner never obtains QR from Worker data and links to loopback instead',async()=>{
 const {context,requests}=ui(false),fixture=JSON.parse(readFileSync('test/fixtures/login-qr.json'));
 vm.runInContext("state={who:{role:'owner'}}",context);
 context.response={online:true,services:{bili:{auth:null,flow:{id:'flow',service:'bili',phase:'waiting',qr_url:fixture.text,expires_at:Date.now()+300000}},x:{auth:null,flow:null}}};
 await vm.runInContext('renderServiceLogins(container)',context);
 assert.equal(all(context.container).filter(n=>n.tagName==='svg').length,0);
 assert.ok(!requests.some(r=>r.path.startsWith('/api/local/')));
 assert.match(text(context.container),/本机开发台扫码/);
});
test('U10 unlock bootstrap clears fragment before exchange, stores local session and loads once',async()=>{
 const f=ui(true,{startup:true,hash:'#unlock=X'});
 vm.runInContext('load=async()=>{globalThis.loadCalls=(globalThis.loadCalls||0)+1}',f.context);
 await new Promise(resolve=>setImmediate(resolve));
 const request=f.requests.find(r=>r.path==='/api/local/session');assert.ok(request);
 assert.deepEqual(JSON.parse(request.opts.body),{code:'X'});
 assert.equal(f.events[0][0],'replace');assert.equal(f.events[0][1],'/');
 assert.equal(f.events[1][0],'fetch');assert.equal(f.storage.get('local-session'),'s'.repeat(43));
 assert.equal(f.context.loadCalls,1);assert.equal(f.context.location.hash,'');
 assert.equal(vm.runInContext('view',f.context),'system');
});
test('U10 fresh locked local page does not request state and shows clear desktop unlock guidance',()=>{
 const f=ui(true,{startup:true});
 assert.ok(!f.requests.some(r=>r.path.startsWith('/api/team/state')));
 assert.match(f.ids.get('logincode').textContent,/本机开发台未解锁.*双击桌面/);
 assert.equal(f.ids.get('app').hidden,true);assert.equal(f.ids.get('nameform').hidden,true);
 assert.equal(f.ids.get('error').textContent,'');
});
test('U10 expired local API and QR sessions clear stored identity and show unlock guidance',async()=>{
 const f=ui();f.context.responseStatus=401;f.context.response={error:'本机开发台未解锁'};f.context.localResponse={error:'本机开发台未解锁'};
 for(const expression of ["api('/api/team/state')","localServiceQr('flow')"]){
  vm.runInContext("localSession='s'.repeat(43);sessionStorage.setItem('local-session',localSession)",f.context);
  await assert.rejects(vm.runInContext(expression,f.context));
  assert.equal(f.storage.has('local-session'),false);assert.match(f.ids.get('logincode').textContent,/本机开发台未解锁/);
 }
});
test('U10 session header stays local; dedicated console link has fixed href without weakening link',async()=>{
 const f=ui();vm.runInContext("localSession='s'.repeat(43)",f.context);
 await vm.runInContext("api('/api/team/service-login')",f.context);await vm.runInContext("localServiceQr('flow')",f.context);
 assert.ok(f.requests.every(r=>r.opts.headers['X-TeamAgent-Session']==='s'.repeat(43)));
 f.context.location.origin='https://team.example';await vm.runInContext("api('/api/team/service-login')",f.context);
 assert.equal(f.requests.at(-1).opts.headers['X-TeamAgent-Session'],undefined);
 const anchor=vm.runInContext("localConsoleLink('打开')",f.context);assert.equal(anchor.href,'http://127.0.0.1:3391/');assert.equal(anchor.target,'_blank');assert.equal(anchor.rel,'noreferrer');
 assert.equal(vm.runInContext("link('x','http://evil.test')",f.context).href,undefined);
});
test('login and cancel buttons use the owner API, disabling duplicate starts for an active service',async()=>{
 const {context,requests}=ui();vm.runInContext("state={who:{role:'owner'}}",context);
 context.response={online:true,services:{bili:{auth:null,flow:null},x:{auth:null,flow:null}}};await vm.runInContext('renderServiceLogins(container)',context);
 const start=all(context.container).find(n=>n.tagName==='button'&&n.textContent==='登录 B 站');await start.onclick();
 const posted=requests.find(x=>x.opts.method==='POST');assert.deepEqual(JSON.parse(posted.opts.body),{service:'bili'});
 context.container.replaceChildren();context.response.services.bili.flow={id:'flow',phase:'waiting',expires_at:Date.now()+300000};
 await vm.runInContext('renderServiceLogins(container)',context);
 assert.equal(all(context.container).find(n=>n.tagName==='button'&&n.textContent==='登录 B 站').disabled,true);
 await all(context.container).find(n=>n.tagName==='button'&&n.textContent==='取消登录').onclick();
 assert.deepEqual(JSON.parse(requests.find(x=>x.opts.method==='DELETE').opts.body),{service:'bili',id:'flow'});
});
