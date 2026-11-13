import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
const native=()=>import('../runner/native-x-browser.mjs');

test('native X login never uses Playwright launch or unsafe browser switches',async()=>{
 const source=await readFile('runner/browser-auth.mjs','utf8');
 assert.doesNotMatch(source,/disable-blink-features|ignoreDefaultArgs/);
 const n=await native(),args=n.nativeXArgs('/private/test/browser/x',12345);
 assert.deepEqual(args,['--user-data-dir=/private/test/browser/x','--remote-debugging-address=127.0.0.1','--remote-debugging-port=12345','https://x.com/login']);
 assert.throws(()=>n.nativeXArgs('/private/test/browser/x',0),/调试端口不可用/);
 assert.doesNotMatch(args.join(' '),/no-sandbox|enable-automation|disable-blink-features|headless/);
 assert.match(source,/openNativeX/);
});
test('real Edge is preferred and missing Edge falls back to real Chrome',async()=>{
 const n=await native();
 assert.match(n.nativeXExecutable(()=>true),/Microsoft Edge$/);
 assert.match(n.nativeXExecutable(path=>path.includes('Google Chrome')),/Google Chrome$/);
 assert.throws(()=>n.nativeXExecutable(()=>false),/未找到 Edge 或 Chrome/);
});
test('CDP discovery checks json/version and rejects non-loopback or mismatched endpoints',async()=>{
 const n=await native();let requested;
 const read=async()=> '12345\n/devtools/browser/synthetic\n';
 const fetcher=async(url)=>{requested=url;return Response.json({webSocketDebuggerUrl:'ws://127.0.0.1:12345/devtools/browser/synthetic'});};
 assert.match(await n.discoverX('/private/test',{read,fetcher}),/^ws:\/\/127\.0\.0\.1:12345\//);
 assert.equal(requested,'http://127.0.0.1:12345/json/version');
 for(const endpoint of ['ws://example.com:12345/a','ws://127.0.0.1:23456/a','wss://127.0.0.1:12345/a'])
  await assert.rejects(n.discoverX('/private/test',{read,fetcher:async()=>Response.json({webSocketDebuggerUrl:endpoint})}),/调试端口不可用/);
});
test('X detection reads only cookie name/domain and no value, diagnostics hide arbitrary title data',async()=>{
 const n=await native(),secret='synthetic-cookie-must-never-be-read';let urls;
 const cookie={name:'auth_token',domain:'.x.com',get value(){throw Error(secret);}};
 const ctx={cookies:async scope=>{urls=scope;return[cookie];}};
 assert.equal(await n.xAuthTokenPresent(ctx),true);
 assert.deepEqual(urls,['https://x.com']);
 assert.equal(await n.xAuthTokenPresent({cookies:async()=>[{...Object.getOwnPropertyDescriptors(cookie).name,value:'irrelevant',name:'auth_token',domain:'evil.com'}]}),false);
 assert.equal(await n.xAuthTokenPresent({cookies:async()=>[]}),false);
 assert.equal(n.xMetadata(secret+' user@example.com',200,true).title,'其他页面（标题已隐藏）');
 assert.doesNotMatch(JSON.stringify(n.xMetadata(secret,200,true)),new RegExp(secret));
});
test('CDP unavailable offers confirmation, then attaches and closes only its own private instance',async()=>{
 const n=await native(),home=await mkdtemp(join(tmpdir(),'native-x-')),profile=join(home,'browser/x'),states=[],commands=[];
 let now=1000,confirmed=false,closed=0,killed=0;
 const child=new EventEmitter();child.exitCode=null;child.kill=()=>{killed++;};
 const browser={contexts:()=>[{}],close:async()=>{closed++;}};
 try{
  const context=await n.openNativeX({home,profile,port:12345,now:()=>now,exists:()=>true,spawn:(exe,args,opts)=>{commands.push({exe,args,opts});return child;},publish:async data=>{states.push(data);await n.publishX(home,data);},
   sleep:async ms=>{now+=ms;if(!confirmed&&states.some(s=>s.phase==='debug_unavailable')){await writeFile(join(home,'state/x-login-confirm'),'retry');confirmed=true;}},
   discover:async()=>{if(!confirmed)throw Error('synthetic-private-endpoint');return 'ws://127.0.0.1:12345/devtools/browser/test';},
   chromium:{connectOverCDP:async()=>browser}});
  assert.equal(Object.hasOwn(states.find(s=>s.phase==='waiting'),'error'),false);
  assert.equal(confirmed,true);assert.ok(states.some(s=>s.phase==='debug_unavailable'&&s.error.includes('我已登录')));
  assert.equal((await stat(profile)).mode&0o777,0o700);
  assert.equal(commands[0].opts.stdio,'ignore');assert.doesNotMatch(commands[0].args.join(' '),/no-sandbox|enable-automation|disable-blink/);
  await context.close();await context.close();assert.equal(closed,1);assert.equal(killed,1);
  assert.doesNotMatch(JSON.stringify(states),/synthetic-private-endpoint|ws:\/\//);
 }finally{await rm(home,{recursive:true,force:true});}
});
for(const [label,domain,path,expected,form=false,marker=true] of [
 ['x token and home','.x.com','/home','ok'],
 ['x token on login','.x.com','/login','waiting'],
 ['x token in login flow','.x.com','/i/flow/login','waiting'],
 ['twitter token on home','.twitter.com','/home','waiting'],
 ['no token on home',null,'/home','waiting'],
 ['onboarding login','.x.com','/i/jf/onboarding/web?mode=login','waiting'],
 ['flow without trailing slash','.x.com','/i/flow','waiting'],
 ['encoded login','.x.com','/%6Cogin','waiting'],
 ['login trailing slash','.x.com','/login/','waiting'],
 ['logout trailing slash','.x.com','/logout/','waiting'],
 ['logout','.x.com','/logout','waiting'],
 ['unknown /i page is a signed-in page','.x.com','/i/unknown-guide','ok'],
 ['home login overlay with old account marker','.x.com','/home','waiting',true],
 ['home without authenticated marker','.x.com','/home','waiting',false,false],
 ['malformed encoded path','.x.com','/%ZZ','waiting'],
])test('native X login requires current x.com session: '+label,async()=>{
 const {createBrowserAuth}=await import('../runner/browser-auth.mjs');
 const home=await mkdtemp(join(tmpdir(),'native-x-auth-')),states=[],reports=[],logs=[];let now=Date.now(),closed=0;
 const page={url:()=> 'https://x.com'+path,title:async()=> 'X',evaluate:async fn=>fn.toString().includes('hasFocus')?true:200,
  locator:selector=>({first(){return this;},isVisible:async()=>selector.includes('SideNav_AccountSwitcher_Button')?marker:selector.includes('autocomplete')?form:false}),
  goto(){throw Error('native window must navigate itself');}};
 const cookie={name:'auth_token',domain,get value(){throw Error('synthetic-secret-must-not-be-read');}};
 const context={nativeX:true,pages:()=>[page],cookies:async()=>domain?[cookie]:[],publishX:async data=>states.push(data),close:async()=>{closed++;}};
 try{
  const auth=createBrowserAuth({home,now:()=>now,sleep:async ms=>{now+=ms;},launch:async()=>context,report:async data=>reports.push(data),log:text=>logs.push(text),notify:async()=>{}});
  assert.equal(await auth.login('x',{deadline:now+10}),expected==='ok'?'ok':'timeout');
  assert.equal(states[0].phase,expected);
  assert.equal(closed,1);assert.equal(reports.length,expected==='ok'?1:0);
  assert.equal(states[0].metadata.auth_token_present,domain==='.x.com');
  if(expected==='waiting'){
   assert.equal(states[0].reason,'not_logged_in');
   assert.equal(Object.hasOwn(states[0],'error'),false);
  }
  assert.doesNotMatch(JSON.stringify({states,reports,logs}),/synthetic-secret|cookie.*value/i);
 }finally{await rm(home,{recursive:true,force:true});}
});
for(const mode of ['active login','no identifiable active page','login tab focused then browser unfocused'])test('native X login ignores background old home: '+mode,async()=>{
 const {createBrowserAuth}=await import('../runner/browser-auth.mjs');
 const home=await mkdtemp(join(tmpdir(),'native-x-tabs-')),states=[],reports=[];let now=Date.now(),focusChecks=0;
 const oldPage={url:()=> 'https://x.com/home',title:async()=> 'X',evaluate:async fn=>fn.toString().includes('hasFocus')?false:200,
  locator(){throw Error('background old home must not be inspected for login markers');}};
 const activePage={url:()=> 'https://x.com/login',title:async()=> '登录 X',evaluate:async fn=>fn.toString().includes('hasFocus')?(mode==='active login'||(mode.includes('then')&&focusChecks++===0)):200,
  locator:()=>({first(){return this;},isVisible:async()=>false})};
 const cookie={name:'auth_token',domain:'.x.com',get value(){throw Error('synthetic-cookie-value-must-not-be-read');}};
 const context={nativeX:true,pages:()=>[oldPage,activePage],cookies:async()=>[cookie],publishX:async data=>states.push(data),close:async()=>{}};
 try{
  const auth=createBrowserAuth({home,now:()=>now,sleep:async ms=>{now+=ms;},launch:async()=>context,report:async data=>reports.push(data),notify:async()=>{}});
  assert.equal(await auth.login('x',{deadline:now+3000}),'timeout');
  assert.ok(states.filter(s=>s.phase==='waiting').length>=2);
  assert.equal(states.some(s=>s.phase==='ok'),false);assert.deepEqual(reports,[]);
  assert.doesNotMatch(JSON.stringify({states,reports}),/synthetic-cookie-value/);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('native startup cancellation and request deadlines close the owned process promptly',async()=>{
 const n=await native();
 for(const mode of ['abort','deadline']){
  const home=await mkdtemp(join(tmpdir(),'native-x-stop-'));let now=1000,killed=0;
  const controller=new AbortController(),child=new EventEmitter();child.exitCode=null;child.kill=()=>killed++;
  try{
   await assert.rejects(n.openNativeX({home,profile:join(home,'browser/x'),port:12345,now:()=>now,deadline:2000,signal:controller.signal,exists:()=>true,spawn:()=>child,publish:async()=>{},discover:async()=>{throw Error('not ready');},sleep:async ms=>{now+=ms;if(mode==='abort')controller.abort();},chromium:{}}));
   assert.ok(now<=2000,'startup must honor cancellation/deadline');assert.equal(killed,1);
  }finally{await rm(home,{recursive:true,force:true});}
 }
});
