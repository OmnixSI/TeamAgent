/**
 * 本机 X 登录会话只读读取器：thread / profile / tweets / search。
 *
 * 一次请求一个短命 Edge 进程（独立 profile ~/.inkboard-team/browser/x，由
 * browser-auth 的登录流程创建），通过 127.0.0.1 CDP 连接，页面内 fetch
 * GraphQL，读完立即关闭自己启动的进程。Cookie 只在页面内使用：csrf 从
 * document.cookie 读出后只放在同一次同源请求头里，不回传、不打印；auth_token
 * 从不读取。输出只有固定 JSON envelope。
 *
 * 来源与改动见 x-graphql.mjs 文件头和仓库根 NOTICE。
 */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readlink,unlink} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validTarget} from './reach-contract.mjs';
import {normalizeReachResult} from './reach-result.mjs';
import {X_ERRORS,discoverX,nativeXExecutable} from './native-x-browser.mjs';
import {
 X_BEARER_TOKEN,buildSearchTimelineRequest,buildTweetDetailRequest,buildUserByScreenNameRequest,
 buildUserTweetsRequest,classifyGraphqlStatus,classifyXPage,fitItems,formatTweetText,normalizeHandle,
 parseSearchTimeline,parseStatusId,parseTweetDetail,parseUserProfile,parseUserTweets,
} from './x-graphql.mjs';

const LIMITS=Object.freeze({thread:20,tweets:20,search:10});
const BUDGET_MS=38000;
const sleep=ms=>new Promise(done=>setTimeout(done,ms));
let emitted=false,live=null,closing=null;

/** Production installs the SDK flat next to this file; a worktree replay falls back to ~/.inkboard-team. */
export function playwrightModule(){
 const require=createRequire(import.meta.url);
 for(const dir of [resolve(dirname(fileURLToPath(import.meta.url)),'sdk/node_modules/playwright'),resolve(homedir(),'.inkboard-team/sdk/node_modules/playwright')]){
  try{return require(dir);}catch{}
 }
 throw Error('TOOL_NOT_READY');
}

let flushed=Promise.resolve();
function emit(envelope){
 if(emitted)return;
 emitted=true;
 const line=JSON.stringify(envelope)+'\n';
 flushed=new Promise(done=>process.stdout.write(line,done));
}
const fail=code=>({ok:false,error:{code}});
export const xEnvelope=(request,raw)=>normalizeReachResult(request,raw);

/** Runs in the page; returns fixed state fields only (no cookie values). */
export function pageProbe(){
 const path=location.pathname;
 return {
  path,
  challenge:!!document.querySelector('[data-testid="captcha"], iframe[src*="captcha"], iframe[src*="arkoselabs"]'),
  login:!!document.querySelector('input[autocomplete="username"], [data-testid="LoginForm_Login_Button"]'),
  account:!!document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]'),
  http:(performance.getEntriesByType('navigation')[0]||{}).responseStatus||null,
  title:typeof document.title==='string'?document.title.slice(0,120):'',
 };
}

/** Runs in the page; csrf stays inside this function and is never returned. */
export async function pageGraphql(page,request){
 return page.evaluate(async r=>{
  const match=document.cookie.match(/(?:^|; )ct0=([^;]*)/);
  if(!match)return {status:401,no_csrf:true,text:'{"errors":[{"message":"no csrf"}]}'};
  let csrf=match[1];
  try{csrf=decodeURIComponent(csrf);}catch{}
  const headers={
   authorization:'Bearer '+r.bearer,
   'x-csrf-token':csrf,
   'x-twitter-auth-type':'OAuth2Session',
   'x-twitter-active-user':'yes',
  };
  if(r.method==='POST')headers['content-type']='application/json';
  const response=await fetch(r.url,{method:r.method||'GET',headers,body:r.body,credentials:'include'});
  const text=await response.text();
  return {status:response.status,text:text.length>4*1024*1024?text.slice(0,4*1024*1024):text};
 },request);
}

function parseResponse(result){
 const text=typeof result?.body==='string'?result.body:(typeof result?.text==='string'?result.text:'');
 if(!text)return {payload:null,status:Number(result?.status)||0};
 try{return {payload:JSON.parse(text),status:Number(result?.status)||0};}catch{return {payload:null,status:Number(result?.status)||0};}
}

async function graphql(page,request,bearer,deadline){
 if(Date.now()>=deadline)return {kind:'TIMEOUT'};
 let result;
 try{result=await pageGraphql(page,{...request,bearer});}
 catch{return {kind:Date.now()>=deadline?'TIMEOUT':'UPSTREAM_BROKEN'};}
 const {payload,status}=parseResponse(result);
 const kind=classifyGraphqlStatus(status,payload);
 return kind?{kind}:{payload};
}

function profileText(user){
 const stats=`关注 ${user.following} · 粉丝 ${user.followers} · 推文 ${user.tweets}`;
 return [user.bio,stats].filter(text=>text&&text.trim()).join('\n');
}

function tweetItem(tweet){
 return {
  title:tweet.name||'',text:formatTweetText(tweet),author:tweet.author,
  source_url:tweet.url,published_at:tweet.created_at,
 };
}

async function collect({page,deadline,build,parse,limit}){
 const items=[],seen=new Set();let cursor=null,pages=0;
 while(items.length<limit&&pages<4){
  const result=await graphql(page,build(cursor),X_BEARER_TOKEN,deadline);
  if(result.kind)return fail(result.kind);
  const pageData=parse(result.payload,seen);
  if(pageData.tombstone&&!items.length&&!pageData.tweets.length)return fail('NOT_FOUND');
  for(const tweet of pageData.tweets){
   if(items.length>=limit)break;
   const item=tweetItem(tweet);
   if(item.text.trim())items.push(item);
  }
  pages++;
  if(!pageData.nextCursor||pageData.nextCursor===cursor||pageData.tweets.length===0)break;
  cursor=pageData.nextCursor;
 }
 return {ok:true,items:fitItems(items)};
}

/**
 * Pure page-level reader: the page is a Playwright page in production and a
 * fixture object in tests. `page.evaluate(probe)` must be the first call.
 */
export async function readX(page,{action,target,limit,deadline}={}){
 const probe=await page.evaluate(pageProbe);
 const state=classifyXPage(probe);
 if(state)return fail(state);
 const end=Number.isFinite(deadline)?deadline:Date.now()+BUDGET_MS-4000;
 if(action==='profile'){
  const handle=normalizeHandle(target);
  if(!handle)return fail('BAD_INPUT');
  const result=await graphql(page,buildUserByScreenNameRequest(handle),X_BEARER_TOKEN,end);
  if(result.kind)return fail(result.kind);
  const user=parseUserProfile(result.payload);
  if(!user)return fail('NOT_FOUND');
  if(user.protected)return fail('UNSUPPORTED');
  return {ok:true,items:[{title:user.name||('@'+user.handle),text:profileText(user),author:user.handle,source_url:`https://x.com/${user.handle}`,published_at:null}]};
 }
 if(action==='tweets'){
  const handle=normalizeHandle(target);
  if(!handle)return fail('BAD_INPUT');
  const who=await graphql(page,buildUserByScreenNameRequest(handle),X_BEARER_TOKEN,end);
  if(who.kind)return fail(who.kind);
  const user=parseUserProfile(who.payload);
  if(!user)return fail('NOT_FOUND');
  if(user.protected)return fail('UNSUPPORTED');
  const cap=Math.min(LIMITS.tweets,Number(limit)||LIMITS.tweets);
  return collect({page,deadline:end,build:cursor=>buildUserTweetsRequest(user.id,Math.min(100,cap+10),cursor),parse:parseUserTweets,limit:cap});
 }
 if(action==='search'){
  const query=typeof target==='string'?target.trim():'';
  if(!query||query.length>200)return fail('BAD_INPUT');
  const cap=Math.min(LIMITS.search,Number(limit)||LIMITS.search);
  return collect({page,deadline:end,build:cursor=>buildSearchTimelineRequest(query,Math.min(100,cap+10),cursor),parse:parseSearchTimeline,limit:cap});
 }
 if(action==='thread'){
  const id=parseStatusId(target);
  if(!id)return fail('BAD_INPUT');
  const cap=Math.min(LIMITS.thread,Number(limit)||LIMITS.thread);
  return collect({page,deadline:end,build:cursor=>buildTweetDetailRequest(id,cursor),parse:parseTweetDetail,limit:cap});
 }
 return fail('BAD_INPUT');
}

function freePort(){
 return new Promise((ok,failed)=>{
  const server=createServer();
  server.once('error',failed);
  server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>ok(port));});
 });
}

/** A killed Edge can leave SingletonLock behind; only remove it when its owner pid is gone. */
export async function clearStaleLock(profile){
 const lock=join(profile,'SingletonLock');let held=false;
 try{const pid=Number(String(await readlink(lock)).split('-').pop());held=Number.isFinite(pid)&&pid>0&&alive(pid);}catch{}
 if(!held)for(const name of ['SingletonLock','SingletonSocket','SingletonCookie'])await unlink(join(profile,name)).catch(()=>{});
 await unlink(join(profile,'DevToolsActivePort')).catch(()=>{});
}
function alive(pid){try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}

/**
 * Edge must stay in the reader's process group. The adapter reaps that whole
 * group when a read times out and the reader is SIGKILLed; a detached browser
 * would survive as an orphan and keep the profile locked.
 */
export const EDGE_SPAWN_OPTIONS=Object.freeze({stdio:'ignore'});
export function spawnBrowser(executable,args){return spawn(executable,args,EDGE_SPAWN_OPTIONS);}

async function launch(deadline){
 let executable;
 try{executable=nativeXExecutable();}catch{throw Error('TOOL_NOT_READY');}
 const profile=join(homedir(),'.inkboard-team/browser/x');
 if(!existsSync(profile))throw Error('NEED_LOGIN');
 await mkdir(profile,{recursive:true,mode:0o700});
 const port=await freePort();
 await clearStaleLock(profile);
 // Load the CDP client before starting a browser: the require is synchronous,
 // and a signal arriving during it must not leave a live Edge behind.
 const {chromium}=playwrightModule();
 const child=spawnBrowser(executable,[
  `--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,
  // X returns HTTP 403 to HeadlessChrome; a short-lived visible Edge window keeps the real session.
  '--window-size=960,720','--no-first-run','--no-default-browser-check','https://x.com/home',
 ]);
 live={browser:null,child};
 try{
  let exited=false;child.once('exit',()=>{exited=true;});
  let endpoint=null;
  while(Date.now()<deadline-9000&&!exited){
   try{endpoint=await discoverX(profile,{port});break;}catch{}
   await sleep(200);
  }
  if(!endpoint)throw Error(exited?'BUSY':'TIMEOUT');
  const browser=await chromium.connectOverCDP(endpoint,{timeout:5000});
  live={browser,child};
  return {browser,child};
 }catch(error){
  await close(live.browser,live.child);
  live=null;
  throw error;
 }
}

async function close(browser,child){
 if(browser)await Promise.race([browser.close().catch(()=>{}),sleep(2000)]);
 if(child&&child.exitCode===null&&child.signalCode===null){
  // Edge shares this reader's process group, so signal the child directly.
  const kill=sig=>{try{child.kill(sig);}catch{}};
  await new Promise(done=>{
   const timer=setTimeout(()=>{kill('SIGKILL');done();},2500);
   child.once('exit',()=>{clearTimeout(timer);done();});
   kill('SIGTERM');
  });
 }
}

/** Graceful exit: close what we started, then exit instead of waiting on a socket or child handle. */
async function shutdown(code){
 if(closing)return closing;
 closing=(async()=>{const current=live;live=null;if(current)await close(current.browser,current.child);await flushed;process.exit(code);})();
 return closing;
}

/** Timeout/signal exit: the adapter is waiting, so kill our own browser and leave. */
async function fastShutdown(code){
 if(closing)return closing;
 closing=(async()=>{
  const current=live;live=null;
  // Edge is in this process group; the adapter SIGKILLs the group if we cannot
  // finish here, so never detach it and never signal the group from inside it.
  if(current?.child){try{current.child.kill('SIGKILL');}catch{}}
  await flushed;process.exit(code);
 })();
 return closing;
}

function thrownCode(error){
 const message=String(error?.message||'');
 if(message==='TOOL_NOT_READY'||/未找到 Edge 或 Chrome/.test(message))return 'TOOL_NOT_READY';
 if(message==='NEED_LOGIN')return 'NEED_LOGIN';
 if(message==='TIMEOUT')return 'TIMEOUT';
 if(message==='BUSY'||/SingletonLock|ProcessSingleton|profile.*(?:in use|locked)/i.test(message))return 'BUSY';
 if(/timed? ?out/i.test(message))return 'TIMEOUT';
 return 'UPSTREAM_BROKEN';
}

export async function main(argv=process.argv.slice(2)){
 const [action,target]=argv;
 const request={channel:'x',action,target};
 const handle=normalizeHandle(target);
 if(handle&&(action==='profile'||action==='tweets'))request.source_url=`https://x.com/${handle}`;
 const started=Date.now();
 const watchdog=setTimeout(()=>{
  emit(xEnvelope(request,fail('TIMEOUT')));
  void fastShutdown(0);
 },BUDGET_MS);
 for(const [name,code] of [['SIGINT',1],['SIGTERM',1]])process.once(name,()=>{void fastShutdown(code);});
 let browser=null,child=null;
 try{
  if(!['thread','profile','tweets','search'].includes(action)||!validTarget('x',action,target))throw Error('BAD_INPUT');
  const launched=await launch(started+BUDGET_MS);
  browser=launched.browser;child=launched.child;
  const context=browser.contexts()[0];
  if(!context)throw Error('UPSTREAM_BROKEN');
  let page=context.pages().find(item=>/^https:\/\/x\.com\//.test(item.url()))||context.pages()[0];
  if(!page)page=await context.newPage();
  page.setDefaultTimeout(8000);
  if(!/^https:\/\/x\.com\/home/.test(page.url())){
   await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:20000}).catch(()=>null);
  }
  await page.waitForTimeout(700).catch(()=>{});
  const raw=await readX(page,{...request,limit:LIMITS[action],deadline:started+BUDGET_MS-4000});
  emit(xEnvelope(request,raw));
 }catch(error){
  const code=['BAD_INPUT','TOOL_NOT_READY','NEED_LOGIN','TIMEOUT','BUSY'].includes(String(error?.message))?String(error.message):thrownCode(error);
  emit(xEnvelope(request,fail(code)));
 }finally{
  clearTimeout(watchdog);
  live=live||{browser,child};
  await shutdown(0);
 }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)void main();
