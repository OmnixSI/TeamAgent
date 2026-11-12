/** Native Chromium login; only a loopback CDP endpoint and a private profile. */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,chmod,readFile,writeFile,rename,unlink,lstat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';

export const X_ERRORS={browser_missing:'未找到 Edge 或 Chrome，请先安装浏览器',debug_unavailable:'浏览器调试端口不可用，请在打开的窗口登录后点击“我已登录”重试；若仍失败，请检查浏览器调试策略',not_logged_in:'未检测到 X 登录态，请在浏览器中完成登录后重试',window_closed:'登录窗口已关闭，请重新打开'};
export function nativeXArgs(profile,port){
 if(!Number.isInteger(port)||port<1||port>65535)throw Error(X_ERRORS.debug_unavailable);
 return [`--user-data-dir=${profile}`,'--remote-debugging-address=127.0.0.1',`--remote-debugging-port=${port}`,'https://x.com/login'];
}
async function freeLoopbackPort(){
 const server=createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
export function nativeXExecutable(exists=existsSync){
 for(const path of ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'])if(exists(path))return path;
 throw Error(X_ERRORS.browser_missing);
}
export async function xAuthTokenPresent(context){
 const cookies=await context.cookies(['https://x.com','https://twitter.com']);
 return cookies.some(c=>c.name==='auth_token'&&['x.com','.x.com','twitter.com','.twitter.com'].includes(c.domain));
}
export function xMetadata(title,http,hasAuth){
 const safeTitle=typeof title==='string'&&/^(?:X|Twitter|登录 X|登录 \/ X|Log in to X|Something went wrong|X \/ X)$/.test(title)?title:'其他页面（标题已隐藏）';
 return {title:safeTitle,http:Number.isInteger(http)&&http>=100&&http<=599?http:null,auth_token_present:typeof hasAuth==='boolean'?hasAuth:null};
}
export async function publishX(home,data){
 const file=resolve(home,'state/x-login.json');await mkdir(dirname(file),{recursive:true,mode:0o700});await chmod(dirname(file),0o700);
 const temp=file+'.tmp-'+randomUUID();await writeFile(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});await rename(temp,file);
}
export async function discoverX(profile,{read=readFile,fetcher=fetch,port:requestedPort}={}){
 const port=requestedPort??Number((await read(resolve(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);
 if(!Number.isInteger(port)||port<1||port>65535)throw Error(X_ERRORS.debug_unavailable);
 const response=await fetcher(`http://127.0.0.1:${port}/json/version`,{redirect:'error',signal:AbortSignal.timeout(1000)});
 if(!response.ok)throw Error(X_ERRORS.debug_unavailable);
 const value=await response.json(),endpoint=new URL(value.webSocketDebuggerUrl);
 if(endpoint.protocol!=='ws:'||endpoint.hostname!=='127.0.0.1'||Number(endpoint.port)!==port||endpoint.username||endpoint.password)throw Error(X_ERRORS.debug_unavailable);
 return endpoint.href;
}
export async function openNativeX(options){
 const {profile,chromium,headless=false}=options,home=options.home||resolve(profile,'../..');
 const run=options.spawn||spawn,sleep=options.sleep||(ms=>new Promise(r=>setTimeout(r,ms))),now=options.now||Date.now;
 const publish=options.publish||((data)=>publishX(home,data));
 const port=options.port||await freeLoopbackPort(),discover=options.discover||(()=>discoverX(profile,{port}));
 const started_at=now(),expires_at=Math.min(started_at+(headless?10000:300000),options.deadline??Infinity),confirm=resolve(home,'state/x-login-confirm');
 let executable;
 try{executable=nativeXExecutable(options.exists);}catch{
  await publish({phase:'failed',reason:'browser_missing',error:X_ERRORS.browser_missing,metadata:xMetadata('',null,null)});
  throw Error(X_ERRORS.browser_missing);
 }
 await mkdir(profile,{recursive:true,mode:0o700});
 if((await lstat(profile)).isSymbolicLink())throw Error(X_ERRORS.debug_unavailable);
 await chmod(profile,0o700);await unlink(resolve(profile,'DevToolsActivePort')).catch(()=>{});await unlink(confirm).catch(()=>{});
 await publish({phase:'starting',expires_at,metadata:xMetadata('',null,null)});
 const child=run(executable,nativeXArgs(profile,port),{stdio:'ignore'});let launchFailed=false,closed=false,browser;
 child.once('error',()=>{launchFailed=true;});
 const close=async()=>{if(closed)return;closed=true;await browser?.close().catch(()=>{});child.kill('SIGTERM');};
 let lastTry=0,unavailable=false;
 try{
  while(now()<expires_at&&!options.signal?.aborted){
   if(launchFailed)throw Error(X_ERRORS.browser_missing);
   if(child.exitCode!==null&&child.exitCode!==undefined)throw Error(X_ERRORS.window_closed);
   let retry=!unavailable;
   if(unavailable){try{await readFile(confirm);await unlink(confirm);retry=true;}catch{}}
   if(retry&&now()-lastTry>=250){
    lastTry=now();
    try{
     const endpoint=await discover();
     browser=await chromium.connectOverCDP(endpoint,{timeout:3000});
     const context=browser.contexts()[0];if(!context)throw Error(X_ERRORS.debug_unavailable);
     context.nativeX=true;context.publishX=publish;context.close=close;
     await publish({phase:'waiting',expires_at,error:X_ERRORS.not_logged_in,reason:'not_logged_in',metadata:xMetadata('',null,false)});
     return context;
    }catch{
     if(now()+1000>=expires_at||now()-started_at>=4000){
      unavailable=true;
      await publish({phase:'debug_unavailable',reason:'debug_unavailable',error:X_ERRORS.debug_unavailable,expires_at,metadata:xMetadata('',null,null)});
     }
    }
   }
   await sleep(250);
  }
  throw Error(options.signal?.aborted?X_ERRORS.window_closed:X_ERRORS.debug_unavailable);
 }catch(error){
  await publish({phase:'failed',reason:Object.keys(X_ERRORS).find(k=>X_ERRORS[k]===error.message)||'debug_unavailable',error:Object.values(X_ERRORS).includes(error.message)?error.message:X_ERRORS.debug_unavailable,metadata:xMetadata('',null,null)});
  await close();throw Error(Object.values(X_ERRORS).includes(error.message)?error.message:X_ERRORS.debug_unavailable);
 }
}
