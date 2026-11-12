/** Login credentials remain on this computer; only fixed status fields leave it. */
import {mkdir,chmod,readFile,writeFile,rename,readdir,open as openFile,unlink,stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';

const COOKIE_NAMES=['SESSDATA','bili_jct','DedeUserID','buvid3'];
const LABELS={bili:'B 站',x:'X'};
const LOGIN={bili:'https://passport.bilibili.com/login',x:'https://x.com/login'};
const BROWSER_MISSING='需要装一次浏览器（Chromium），请联系维护者安装后再登录。';
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function privateDir(path){await mkdir(path,{recursive:true,mode:0o700});await chmod(path,0o700);}
async function readJSON(path){try{return JSON.parse(await readFile(path,'utf8'));}catch{return {};}}
async function writeJSON(path,value){
 await privateDir(dirname(path));
 const temp=path+'.tmp-'+randomUUID();
 await writeFile(temp,JSON.stringify(value),{mode:0o600,flag:'wx'});
 await chmod(temp,0o600);await rename(temp,path);
}
export function safeLogText(value,secrets=[]){
 let text=String(value);
 for(const secret of secrets)if(typeof secret==='string'&&secret)text=text.split(secret).join('***');
 return text.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g,'[密钥已隐藏]')
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,'[凭据已隐藏]')
  .replace(/((?:API[_ -]?KEY|Authorization|密码|验证码|access_token|clientSecret)\s*[=:：]\s*)["']?[^\s,"'\n}]+/gi,'$1[已隐藏]');
}
export async function writeBiliCookies(home,cookies){
 const selected={};
 for(const name of COOKIE_NAMES){
  const c=cookies.find(c=>c.name===name);
  if(c&&typeof c.value==='string')selected[name]={value:c.value,expires:Number.isFinite(c.expires)?c.expires:-1};
 }
 await writeJSON(resolve(home,'secrets/bili-cookie.json'),selected);
}
export async function loadBiliCookies(home){
 const saved=await readJSON(resolve(home,'secrets/bili-cookie.json')),selected={};
 for(const name of COOKIE_NAMES){const c=saved[name];if(c&&typeof c.value==='string'&&Number.isFinite(c.expires))selected[name]={value:c.value,expires:c.expires};}
 return selected;
}
const flatCookies=cookies=>Object.fromEntries(Object.entries(cookies).map(([k,c])=>[k,c.value]));
export function allowedBrowserUrl(service,raw){
 try{
  const u=new URL(raw);
  if(u.protocol!=='https:'||(u.port&&u.port!=='443')||u.username||u.password)return false;
  if(service==='x')return ['x.com','twitter.com','abs.twimg.com'].includes(u.hostname)||u.hostname.endsWith('.twimg.com');
  return service==='bili'&&(['www.bilibili.com','api.bilibili.com','passport.bilibili.com','comment.bilibili.com','b23.tv'].includes(u.hostname)||u.hostname.endsWith('.hdslb.com'));
 }catch{return false;}
}
export async function browserOptions(chromium,options={}){
 const exists=options.exists||existsSync;
 if(exists('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'))return {channel:'msedge'};
 if(exists('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'))return {channel:'chrome'};
 const expected=chromium.executablePath();
 if(exists(expected))return {executablePath:expected};
 const cache=resolve(homedir(),process.platform==='darwin'?'Library/Caches/ms-playwright':'.cache/ms-playwright');
 let entries=[];try{entries=await (options.cacheEntries||readdir)(cache);}catch{}
 for(const name of entries.sort().reverse().filter(name=>/^chromium-\d+$/.test(name))){
  for(const suffix of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing','chrome-mac/Chromium.app/Contents/MacOS/Chromium','chrome-linux64/chrome','chrome-linux/chrome']){
   const path=join(cache,name,suffix);if(exists(path))return {executablePath:path};
  }
 }
 throw Error(BROWSER_MISSING);
}
export function browserLaunchOptions(browser,headless){return {...browser,headless,acceptDownloads:false,serviceWorkers:'block',timeout:20000,chromiumSandbox:true,ignoreDefaultArgs:['--enable-automation'],args:['--disable-blink-features=AutomationControlled']};}
async function launchBrowser(_service,options){
 const require=createRequire(import.meta.url);
 const {chromium}=require(resolve(dirname(fileURLToPath(import.meta.url)),'sdk/node_modules/playwright'));
 const browser=await browserOptions(chromium);
 return chromium.launchPersistentContext(options.profile,browserLaunchOptions(browser,options.headless));
}
export async function macNotification(text){
 if(process.platform!=='darwin')return;
 await new Promise(resolve=>execFile('osascript',['-e','display notification '+JSON.stringify(text)+' with title "TeamAgent"'],{timeout:5000},()=>resolve()));
}
async function defaultBiliProbe(client,cookies){
 try{
  client.setSessionCookies(cookies);
  const nav=await client.biliApi('/x/web-interface/nav');
  if([-352,-412].includes(nav.code))return 'risk';
  if(nav.data?.isLogin===true)return 'ok';
  if(nav.code===-101||nav.data?.isLogin===false)return 'expired';
 }catch(error){if(error.status===412||[-352,-412].includes(error.code)||error.message==='风控')return 'risk';}
 return null; // A network failure is not evidence that the login expired.
}
async function xState(page){
 if(await page.locator('[data-testid="captcha"], iframe[src*="captcha"], iframe[src*="arkoselabs"]').first().isVisible())return 'risk';
 if(await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible())return 'ok';
 if(/^\/(?:login|i\/flow\/login)(?:\/|$)/.test(new URL(page.url()).pathname))return 'expired';
 if(await page.locator('input[autocomplete="username"], input[name="password"], [data-testid="LoginForm_Login_Button"]').first().isVisible())return 'expired';
 return null; // An empty/error page does not establish that the session expired.
}
export function createBrowserAuth(options={}){
 const home=options.home||resolve(homedir(),'.inkboard-team'),now=options.now||Date.now,sleep=options.sleep||wait;
 const launch=options.launch||launchBrowser,report=options.report||asyncNoop,notify=options.notify||macNotification;
 let biliClient=options.client;
 async function client(){
  if(!biliClient){const {createFetchClient}=await import('./fetcher.mjs');biliClient=createFetchClient({now,sleep,log:options.log,riskPath:resolve(home,'state/bili-risk.json')});}
  return biliClient;
 }
 const probeBili=options.probeBili||(async cookies=>defaultBiliProbe(await client(),cookies));
 const statePath=service=>resolve(home,'state/auth-'+service+'.json'),known=new Set();
 async function locked(service,work,busy=null){
  const path=resolve(home,'state/login-'+service+'.lock');await privateDir(dirname(path));
  let lock;
  try{lock=await openFile(path,'wx',0o600);}catch(error){
   if(error.code!=='EEXIST')throw Error('本机登录目录不可写。');
   // A crashed five-minute login must not leave the profile locked forever.
   const old=await stat(path).catch(()=>null);
   if(old&&Date.now()-old.mtimeMs>360000){await unlink(path).catch(()=>{});try{lock=await openFile(path,'wx',0o600);}catch{}}
   if(!lock){if(busy)throw Error(busy);return null;}
  }
  try{return await work();}finally{await lock.close();await unlink(path).catch(()=>{});}
 }
 async function rememberCookies(cookies){for(const c of Object.values(cookies))if(c.value)known.add(c.value);return cookies;}
 async function record(service,state){
  const old=await readJSON(statePath(service));
  const checked_at=new Date(now()).toISOString();
  await writeJSON(statePath(service),{state,checked_at,had_ok:state==='ok'||old.had_ok===true});
  if(old.state==='ok'&&['expired','risk'].includes(state))await notify(LABELS[service]+' 登录过期或需要验证，双击桌面「TeamAgent-登录」重新登录。');
  try{await report({service,state,checked_at});}catch{options.log?.('登录状态暂未上报，将在下次检查时重试。');}
  return state;
 }
 async function open(service,headless,work){
  await privateDir(resolve(home,'browser'));const profile=resolve(home,'browser',service);await privateDir(profile);
  let context;
  try{
   context=await launch(service,{profile,headless});
   await context.route('**/*',route=>allowedBrowserUrl(service,route.request().url())?route.continue():route.abort());
   // Login does not use WebSockets. Block this separate network channel as well.
   if(context.routeWebSocket)await context.routeWebSocket('**/*',socket=>socket.close());
   const page=context.pages()[0]||await context.newPage();
   return await work(context,page);
  }catch(error){throw Error(error.message===BROWSER_MISSING?BROWSER_MISSING:'登录窗口未能完成，请关闭同服务的登录窗口后重试。');}
  finally{if(context)await context.close().catch(()=>{});}
 }
 async function login(service,control={}){
  if(!LOGIN[service])throw Error('请选择 bili 或 x。');
  return locked(service,async()=>{
  if(service==='bili'&&(await client()).isPaused())return 'risk';
  const state=await open(service,false,async(context,page)=>{
   const deadline=Math.min(now()+300000,control.deadline??Infinity);
   const close=()=>context.close().catch(()=>{});
   const timer=setTimeout(close,Math.max(0,deadline-now()));
   control.signal?.addEventListener('abort',close,{once:true});
   try{
    if(control.signal?.aborted)return 'cancelled';
    if(now()>=deadline)return 'timeout';
    await control.onOpened?.();
    await page.goto(LOGIN[service],{waitUntil:'domcontentloaded',timeout:15000});
    while(now()<deadline){
     if(control.signal?.aborted)return 'cancelled';
     let state=null,exported;
     if(service==='bili'){
      const cookies=await context.cookies('https://api.bilibili.com');
      exported=Object.fromEntries(cookies.filter(c=>COOKIE_NAMES.includes(c.name)).map(c=>[c.name,c]));
      await rememberCookies(exported);
      state=await probeBili(Object.fromEntries(Object.entries(exported).map(([k,c])=>[k,c.value])));
     }else state=await xState(page);
     if(control.signal?.aborted)return 'cancelled';
     if(state==='risk'){if(service==='bili')(await client()).pauseForRisk();return 'risk';}
     if(state==='ok'&&now()<deadline){if(service==='bili')await writeBiliCookies(home,Object.values(exported));return 'ok';}
     await sleep(Math.min(2000,Math.max(0,deadline-now())));
    }
    return 'timeout';
   }catch(error){if(control.signal?.aborted)return 'cancelled';if(now()>=deadline)return 'timeout';throw error;}
   finally{clearTimeout(timer);control.signal?.removeEventListener('abort',close);}
  });
  if(state==='ok'){await record(service,'ok');await notify(LABELS[service]+'已登录');}
  else if(state==='risk')await record(service,'risk');
  return state;
  },'登录窗口正在使用，请完成或关闭已有窗口后重试。');
 }
 async function check(service){
  if(!LOGIN[service])throw Error('unknown service');
  return locked(service,async()=>{
  let state;
  if(service==='bili'){
   if((await client()).isPaused())return (await readJSON(statePath('bili'))).state||null;
   const cookies=await rememberCookies(await loadBiliCookies(home));
   const session=cookies.SESSDATA;
   if(!session?.value)state='missing';
   else if(session.expires>0&&session.expires*1000<=now())state='expired';
   else state=await probeBili(flatCookies(cookies));
  }else{
   const old=await readJSON(statePath('x'));
   if(!old?.had_ok&&!existsSync(resolve(home,'browser/x/Default')))state='missing';
   else state=await open('x',true,async(_context,page)=>{
    const response=await page.goto('https://x.com/home',{waitUntil:'domcontentloaded',timeout:15000});
    if(response?.status()>=400)return null;
    if(!/\/(?:login|i\/flow\/login)/.test(new URL(page.url()).pathname))await page.waitForSelector?.('[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="captcha"], iframe[src*="captcha"]',{timeout:8000}).catch(()=>{});
    return xState(page);
   }).catch(()=>null);
  }
  return state?record(service,state):null;
  });
 }
 async function prepareBili(client){
  if(!biliClient)biliClient=client;
  const state=await check('bili');
  const cookies=state==='ok'?flatCookies(await rememberCookies(await loadBiliCookies(home))):{};
  client.setSessionCookies(cookies);
 }
 async function daily(){
  const date=new Date(now());if(date.getHours()<9)return;
  const day=[date.getFullYear(),date.getMonth()+1,date.getDate()].join('-');
  const path=resolve(home,'state/auth-daily.json'),all=await readJSON(path);if(all.day===day)return;
  for(const service of ['bili','x'])try{if(await check(service)===null)return;}catch{options.log?.('登录探活暂未完成，下次重试。');return;}
  await writeJSON(path,{day});
 }
 return {login,check,prepareBili,daily,record,withLoginLock:locked,sanitize:text=>safeLogText(text,[...known])};
}
async function asyncNoop(){}
