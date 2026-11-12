/** QR transport runs locally. Only validated display URLs and fixed status fields reach the Worker. */
import {writeBiliCookies,loadBiliCookies} from './browser-auth.mjs';
import {validLoginQr} from './login-url.mjs';
const NAMES=['SESSDATA','bili_jct','DedeUserID','buvid3'];
const risk=error=>error?.status===412||[-352,-412].includes(error?.code)||error?.message==='风控';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
class Cancelled extends Error{}
function parseCookies(headers,now){
 const raw=headers['set-cookie'],all=Array.isArray(raw)?raw:typeof raw==='string'?[raw]:[];
 return all.flatMap(line=>{
  const [first,...attrs]=line.split(';'),idx=first.indexOf('='),name=first.slice(0,idx).trim();
  if(idx<1||!NAMES.includes(name))return [];
  const value=first.slice(idx+1).trim();let expires=-1;
  for(const attr of attrs){const split=attr.indexOf('='),key=attr.slice(0,split).trim().toLowerCase(),v=attr.slice(split+1).trim();
   if(key==='expires'&&Number.isFinite(Date.parse(v)))expires=Date.parse(v)/1000;
  }
  const maxAge=attrs.find(a=>/^\s*max-age=/i.test(a));if(maxAge&&Number.isFinite(Number(maxAge.split('=')[1])))expires=Math.floor(now/1000)+Number(maxAge.split('=')[1]);
  return [{name,value,expires}];
 });
}
export async function runLoginFlow(login,options){
 if(login?.service==='bili'){
  try{return await options.auth.withLoginLock('bili',()=>executeLoginFlow(login,options),'本机正在登录，请完成已有窗口后重试。');}
  catch{try{await options.cloud('login-state',{id:login.id,service:'bili',phase:'failed'});}catch{}return 'failed';}
 }
 return executeLoginFlow(login,options);
}
async function executeLoginFlow(login,options){
 const {client,auth,cloud,home}=options,now=options.now||Date.now,wait=options.sleep||sleep;
 if(!login||!['bili','x'].includes(login.service)||typeof login.id!=='string'||!Number.isFinite(login.expires_at))return 'failed';
 const deadline=Math.min(login.expires_at,now()+300000);let qr,heartbeat,heartbeatBusy=false,heartbeatError;
 const controller=new AbortController();
 async function publish(phase,extra={}){
  try{await cloud('login-state',{id:login.id,service:login.service,phase,...extra});}
  catch(error){if(error.status===409)throw new Cancelled();throw error;}
 }
 try{
  if(now()>=deadline)return 'expired';
  if(login.service==='x'){
   // Heartbeat also observes owner cancellation while Playwright is navigating.
   const tick=async()=>{
    if(heartbeatBusy)return;heartbeatBusy=true;
    try{await publish('waiting');}catch(error){heartbeatError=error;controller.abort();}finally{heartbeatBusy=false;}
   };
   const state=await auth.login('x',{signal:controller.signal,deadline,onOpened:async()=>{
    await tick();if(heartbeatError)throw heartbeatError;heartbeat=setInterval(()=>void tick(),2000);
   }});
   clearInterval(heartbeat);if(heartbeatError)throw heartbeatError;
   const phase=state==='ok'?'ok':state==='timeout'?'expired':state==='cancelled'?'cancelled':'failed';
   await publish(phase);return phase;
  }
  if(client.isPaused()){await publish('failed',{reason:'risk'});return 'failed';}
  const generated=await client.biliPassport('generate');
  const data=generated.body?.data;
  if(generated.body.code!==0||!validLoginQr(data?.url)||!/^[a-f0-9]{32}$/.test(data?.qrcode_key))throw Error('invalid QR response');
  qr=data.url;await publish('waiting',{qr_url:qr});
  while(now()<deadline){
   const result=await client.biliPassport('poll',data.qrcode_key);
   if(now()>=deadline)break;
   if(result.body.code!==0)throw Error('invalid QR response');
   const code=result.body.data?.code;
   if(code===86038){await publish('expired');return 'expired';}
   if(code===0){
    // Verify the request is still active before accepting the login locally.
    await publish('scanned',{qr_url:qr});
    const parsed=parseCookies(result.headers,now());
    if(!NAMES.slice(0,3).every(name=>parsed.some(c=>c.name===name&&c.value)))throw Error('incomplete cookies');
    const old=await loadBiliCookies(home),device=parsed.find(c=>c.name==='buvid3');
    if(!device)parsed.push({name:'buvid3',value:old.buvid3?.value||'',expires:old.buvid3?.expires??-1});
    client.setSessionCookies(Object.fromEntries(parsed.map(c=>[c.name,c.value])));
    // Save the session before optional anonymous fingerprint retrieval.
    await writeBiliCookies(home,parsed);
    if(!parsed.find(c=>c.name==='buvid3').value&&!client.isPaused()){
     try{
      const value=await client.anonymousBuvid();parsed.find(c=>c.name==='buvid3').value=value;
      await writeBiliCookies(home,parsed);client.setSessionCookies(Object.fromEntries(parsed.map(c=>[c.name,c.value])));
     }catch(error){if(risk(error))client.pauseForRisk();}
    }
    await auth.record('bili','ok');await publish('ok');return 'ok';
   }
   if(![86101,86090].includes(code))throw Error('invalid QR state');
   await publish(code===86090?'scanned':'waiting',{qr_url:qr});
   await wait(Math.min(2000,Math.max(0,deadline-now())));
  }
  await publish('expired');return 'expired';
 }catch(error){
  if(error instanceof Cancelled)return 'cancelled';
  if(risk(error)){client.pauseForRisk();await auth.record('bili','risk');}
  try{await publish('failed',risk(error)?{reason:'risk'}:{});}catch{}
  return 'failed';
 }finally{clearInterval(heartbeat);controller.abort();}
}
