/** Low-frequency Bilibili fetcher; optional local browser login. */
import {createBrowserAuth,safeLogText} from './browser-auth.mjs';
import {runLoginFlow} from './qr-login.mjs';
import {biliByTitle} from './bili-title.mjs';
import {createWakePort} from './fetch-wake.mjs';
import https from 'node:https';
import dns from 'node:dns';
import {BlockList,isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {readFileSync,writeFileSync,renameSync,mkdirSync,rmdirSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MIXIN=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const UA='curl/8.7.1';
const BV=/^BV[0-9A-Za-z]{10}$/;
const SHORT=/^[0-9A-Za-z_-]{4,32}$/;
const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['64:ff9b::',96],['2001:db8::',32],['2002::',16],['2001::',32]])blocked.addSubnet(ip,bits,'ipv6');
export function isPublic(ip){
 if(typeof ip!=='string'||ip.includes('%'))return false;
 // Canonicalize IPv4-mapped IPv6, including its two hexadecimal hextets.
 if(isIP(ip)===6){const normalized=new URL('https://['+ip+']/').hostname.slice(1,-1);const m=normalized.match(/^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/i);if(m){const n=Number.parseInt(m[1],16)*65536+Number.parseInt(m[2],16);ip=[n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.');}}
 const family=isIP(ip);return !!family&&!blocked.check(ip,family===4?'ipv4':'ipv6');
}
export function createSafeLookup(lookup=dns.lookup){
 return (host,options,callback)=>lookup(host,{all:true},(error,addresses)=>{
   if(error)return callback(error);
   if(!addresses?.length||addresses.some(x=>!isPublic(x.address)))return callback(Error('blocked address'));
   const first=addresses[0];
   // Recent Node versions request an array for automatic family selection.
   if(options?.all)callback(null,[first]);else callback(null,first.address,first.family);
 });
}
export function wbiSign(params,imgKey,subKey,wts=Math.floor(Date.now()/1000)){
 const raw=imgKey+subKey,key=MIXIN.map(i=>raw[i]).join('').slice(0,32);
 const clean={...params,wts};delete clean.w_rid;
 const query=Object.keys(clean).sort().map(k=>encodeURIComponent(k)+'='+encodeURIComponent(String(clean[k]).replace(/[!'()*]/g,''))).join('&');
 return query+'&w_rid='+createHash('md5').update(query+key).digest('hex');
}
export function sanitize(value,secrets){
 if(typeof value==='string'){
   let text=value;
   for(const secret of secrets)if(typeof secret==='string'&&secret)text=text.split(secret).join('***');
   return safeLogText(text);
 }
 if(Array.isArray(value))return value.map(x=>sanitize(x,secrets));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,secrets)]));
 return value;
}
function allowed(raw,kind){
 const u=new URL(raw);
 if(u.protocol!=='https:'||(u.port&&u.port!=='443')||u.username||u.password)throw Error('blocked URL');
 const ok=kind==='api'?u.hostname==='api.bilibili.com':kind==='fingerprint'?u.hostname==='api.bilibili.com'&&u.pathname==='/x/frontend/finger/spi':kind==='passport'?u.hostname==='passport.bilibili.com':kind==='subtitle'?u.hostname.endsWith('.hdslb.com'):kind==='short'&&u.hostname==='b23.tv';
 if(!ok)throw Error('blocked host');return u;
}
export function createFetchClient(options={}){
 const request=options.request||https.request,lookup=createSafeLookup(options.lookup||dns.lookup),now=options.now||Date.now,sleep=options.sleep||(ms=>new Promise(r=>setTimeout(r,ms))),random=options.random||Math.random,log=options.log||(()=>{}),riskPath=options.riskPath;
 const cookies={...(options.cookies||{})};let nextAt=0,serial=Promise.resolve(),riskCount=0,pausedUntil=0,searchPausedUntil=0,buvidAt=cookies.buvid3?now():-Infinity,wbi=null,wbiAt=-Infinity;
 const knownSecrets=new Set(Object.values(cookies).filter(x=>typeof x==='string'&&x));
 const secrets=()=>[...knownSecrets];
 const safe=x=>sanitize(x,secrets());
 const rate=()=>{const slot=serial.then(async()=>{refreshPause();if(pausedUntil&&now()>=pausedUntil){pausedUntil=0;riskCount=0;}if(now()<pausedUntil)throw Error('风控');const delay=Math.max(0,nextAt-now());if(delay)await sleep(delay);refreshPause();if(pausedUntil&&now()>=pausedUntil){pausedUntil=0;riskCount=0;}if(now()<pausedUntil)throw Error('风控');nextAt=now()+1000+200+Math.floor(random()*601);});serial=slot.catch(()=>{});return slot;};
 function persistPause(until){if(!riskPath)return;try{mkdirSync(dirname(riskPath),{recursive:true,mode:0o700});const lock=riskPath+'.lock';let held=false;for(let i=0;i<100;i++){try{mkdirSync(lock,{mode:0o700});held=true;break;}catch(error){if(error.code!=='EEXIST')break;try{if(Date.now()-statSync(lock).mtimeMs>30000){rmdirSync(lock);continue;}}catch{}Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}if(!held)return;try{let old=0;try{old=Number(JSON.parse(readFileSync(riskPath,'utf8'))?.paused_until)||0;}catch{}const value=Math.max(until,old);const tmp=riskPath+'.tmp-'+process.pid+'-'+Math.random().toString(36).slice(2);writeFileSync(tmp,JSON.stringify({paused_until:value}),{mode:0o600});renameSync(tmp,riskPath);}finally{if(held)try{rmdirSync(lock);}catch{}}}catch{}}
 function risk(hit,reset=true){const before=riskCount;riskCount=hit?riskCount+1:(reset?0:riskCount);if(hit&&before<2&&riskCount>=2){pausedUntil=now()+600000;persistPause(pausedUntil);}}
 async function get(raw,kind,anonymous=false,method='GET'){
   const u=allowed(raw,kind);await rate();
   // Fresh headers per request: never reuse the API Cookie for a subtitle/short URL.
   const headers={'User-Agent':UA,'Referer':'https://www.bilibili.com/','Accept':'application/json','Accept-Encoding':'identity'};
   if(kind==='api'){const values=(anonymous?['buvid3']:['buvid3','SESSDATA']).filter(k=>typeof cookies[k]==='string'&&cookies[k]);if(values.length)headers.Cookie=values.map(k=>k+'='+cookies[k]).join('; ');}
   return new Promise((resolveResult,reject)=>{
     let settled=false,timer;
     const fail=(error)=>{if(!settled){settled=true;clearTimeout(timer);reject(error instanceof Error?error:Error(now()<pausedUntil?'风控':'抓取失败'));}};
     const req=request({host:u.hostname,servername:u.hostname,path:u.pathname+u.search,method,headers,lookup,agent:false,timeout:8000},res=>{
       const chunks=[];let size=0;
       res.on('error',fail);res.on('aborted',fail);
       res.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>2_000_000){fail();req.destroy();}else chunks.push(chunk);});
       res.on('end',()=>{
         if(settled)return;
         const status=res.statusCode;
         let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
         log(safe('fetch '+kind+' '+u.pathname+' status='+status));
         const hit=status===412||[-352,-412].includes(data?.code);const keepRisk=kind==='short'||kind==='fingerprint'||(kind==='api'&&u.pathname==='/x/frontend/finger/spi');risk(hit,!keepRisk);
         if(hit||(!(status>=200&&status<300)&&!(kind==='short'&&(status>=300&&status<400||status===405&&method==='HEAD')))){const error=Error(now()<pausedUntil?'风控':'抓取失败');error.status=status;error.code=data?.code;fail(error);return;}
         settled=true;clearTimeout(timer);resolveResult({status,headers:res.headers,data});
       });
     });
     req.on('error',fail);req.on('timeout',()=>{fail(Object.assign(Error(now()<pausedUntil?'风控':'抓取失败'),{timeout:true}));req.destroy();});timer=setTimeout(()=>{fail(Object.assign(Error(now()<pausedUntil?'风控':'抓取失败'),{timeout:true}));req.destroy();},8000);req.end();
   });
 }
 async function biliApi(path,params={},options={}){
   if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))throw Error('blocked API path');
   const query=typeof params==='string'?params:new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString();
   const r=await get('https://api.bilibili.com'+path+(query?'?'+query:''),'api',options.anonymous===true);
   if(!r.data)throw Error('无效接口响应');return r.data;
 }
 async function biliSubtitle(url){const r=await get(url,'subtitle');if(!r.data)throw Error('无效字幕响应');return r.data;}
 async function biliPassport(action,key){
   if(!['generate','poll'].includes(action)||(action==='poll'&&!/^[a-f0-9]{32}$/.test(key)))throw Error('invalid passport action');
   const r=await get('https://passport.bilibili.com/x/passport-login/web/qrcode/'+action+(action==='poll'?'?qrcode_key='+key:''),'passport');
   if(!r.data)throw Error('无效登录响应');return {body:r.data,headers:r.headers};
 }
 async function anonymousBuvid(){
   const r=await get('https://api.bilibili.com/x/frontend/finger/spi','fingerprint');
   const value=r.data?.code===0&&r.data?.data?.b_3;
   if(typeof value!=='string'||!value)throw Error('无效设备响应');
   knownSecrets.add(value);return value;
 }
 async function resolveShort(code,paged=false){
   if(!SHORT.test(code))throw Error('短链无效');let u=new URL('https://b23.tv/'+code);
   for(let hop=0;hop<3;hop++){
     let r=await get(u.href,'short',false,'HEAD');
     if(r.status===405)r=await get(u.href,'short');
     if(!(r.status>=300&&r.status<400)||!r.headers.location)throw Object.assign(Error('短链无效'),{reason:'not_found'});
     const target=new URL(r.headers.location,u);
     if(target.protocol!=='https:'||(target.port&&target.port!=='443')||target.username||target.password)throw Error('短链无效');
     if(['bilibili.com','www.bilibili.com','m.bilibili.com'].includes(target.hostname)){
       const page=Number(target.searchParams.get('p')||1);
       if(paged&&(!Number.isInteger(page)||page<1||page>999))throw Object.assign(Error('短链无效'),{reason:'not_found'});
       const found=bvid=>paged?{bvid,page}:bvid;
       const bv=target.pathname.match(/\bBV[0-9A-Za-z]{10}\b/)?.[0];if(bv)return found(bv);
       const av=target.pathname.match(/\bav(\d+)\b/i)?.[1];
       if(av){
         // Keep transport/risk failures for classify(); a deleted or private aid is not "not a video".
         const view=await biliApi('/x/web-interface/view',{aid:Number(av)});
         if(view?.code!==0||!view.data)throw Object.assign(Error('视频信息未读到'),{code:view?.code});
         const bvid=view.data.bvid;
         if(typeof bvid==='string'&&BV.test(bvid))return found(bvid);
         throw Error('视频信息未读到');
       }
       throw Object.assign(Error('短链无效'),{reason:'unsupported'});
     }
     if(target.hostname!=='b23.tv')throw Object.assign(Error('短链无效'),{reason:'unsupported'});u=target;
   }throw Error('短链无效');
 }
 async function refreshBuvid(force=false,anonymous=false){
   if(!force&&cookies.buvid3&&now()-buvidAt<86400000)return;
   const spi=await biliApi('/x/frontend/finger/spi',{}, {anonymous});
   if(typeof spi.data?.b_3==='string'){cookies.buvid3=spi.data.b_3;knownSecrets.add(spi.data.b_3);buvidAt=now();}
 }
 async function prepare(anonymous=false){
   await refreshBuvid(false,anonymous);
   if(!wbi||now()-wbiAt>=43200000){const nav=await biliApi('/x/web-interface/nav',{}, {anonymous});const keys=nav.data?.wbi_img;if(keys){wbi=[keys.img_url,keys.sub_url].map(x=>new URL(x).pathname.split('/').at(-1).split('.')[0]);wbiAt=now();}}
   return wbi;
 }
 async function biliLight(ref,page=1){
   if(!BV.test(ref)&&!SHORT.test(ref))throw Error('无效视频编号');
   const bvid=BV.test(ref)?ref:await resolveShort(ref);
   await prepare();
   let view;
   try{view=await biliApi('/x/web-interface/view',{bvid});}
   catch(error){if(error.status!==412&&error.code!==-412)throw error;await refreshBuvid(true);view=await biliApi('/x/web-interface/view',{bvid});}
   if(view.code!==0||!view.data)throw Object.assign(Error('视频信息未读到'),{code:view.code});
   const v=view.data,pages=Array.isArray(v.pages)&&v.pages.length?v.pages:[{cid:v.cid}],selected=pages[page-1];
   if(!Number.isInteger(page)||page<1||!selected?.cid)throw Object.assign(Error('视频分P不存在'),{reason:'not_found'});
   const cid=selected.cid;
   let subtitle=null,subtitle_lang=null,subtitle_status='unavailable';
   if(wbi&&cid){
     subtitle_status='none';
     try{
       const player=await biliApi('/x/player/wbi/v2',wbiSign({bvid,cid},...wbi,Math.floor(now()/1000)));
       if(player.code===0){
         const list=player.data?.subtitle?.subtitles||[];
         const selected=list.find(s=>['zh-CN','zh-Hans','ai-zh'].includes(s.lan))||list[0];
         if(selected?.subtitle_url){const url=selected.subtitle_url.startsWith('//')?'https:'+selected.subtitle_url:selected.subtitle_url;const sub=await biliSubtitle(url);subtitle=(sub.body||[]).map(x=>String(x.content||'')).join(' ').slice(0,6000)||null;subtitle_lang=selected.lan||null;subtitle_status=subtitle?'ok':'none';}
         else if(player.data?.need_login_subtitle)subtitle_status='login_required';
       }else subtitle_status='unavailable';
     }catch(error){if(now()<pausedUntil)throw error;subtitle_status='unavailable';}
   }
   let comments=[];
   try{const reply=await biliApi('/x/v2/reply',{type:1,oid:v.aid,sort:1,ps:20});if(reply.code===0){const list=[...(reply.data?.hots||[]),...(reply.data?.replies||[])];const unique=[...new Map(list.map(x=>[x.rpid??(x.member?.uname+'\0'+x.content?.message),x])).values()];comments=unique.sort((a,b)=>(b.like||0)-(a.like||0)).slice(0,8).map(c=>({uname:String(c.member?.uname||'').slice(0,100),message:String(c.content?.message||'').slice(0,120)}));}}catch(error){if(now()<pausedUntil)throw error;}
   return safe({bvid,page,pages:pages.length,aid:v.aid||0,title:String(v.title||'').slice(0,300),desc:String(v.desc||'').slice(0,1500),owner:String(v.owner?.name||'').slice(0,100),tname:String(v.tname||'').slice(0,100),duration:v.duration||0,pubdate:v.pubdate||0,stat:Object.fromEntries(['view','like','coin','favorite','reply'].map(k=>[k,v.stat?.[k]||0])),subtitle,subtitle_lang,subtitle_status,comments,tier:'light',fetched_at:new Date(now()).toISOString()});
 }
 function setSessionCookies(next){
   for(const key of ['SESSDATA','bili_jct','DedeUserID'])delete cookies[key];
   for(const key of ['SESSDATA','bili_jct','DedeUserID','buvid3'])if(typeof next[key]==='string'&&next[key]){cookies[key]=next[key];knownSecrets.add(next[key]);}
   if(next.buvid3)buvidAt=now();
 }
 const refreshPause=()=>{if(riskPath){try{const p=Number(JSON.parse(readFileSync(riskPath,'utf8'))?.paused_until);if(Number.isFinite(p))pausedUntil=Math.max(pausedUntil,p);}catch(error){if(error.code!=='ENOENT')pausedUntil=Math.max(pausedUntil,now()+60000);}}return pausedUntil;};
 const isPaused=()=>now()<refreshPause();
 const pauseForRisk=()=>{riskCount=Math.max(2,riskCount);pausedUntil=Math.max(pausedUntil,now()+600000);persistPause(pausedUntil);};
 const isSearchPaused=()=>now()<searchPausedUntil;
 const pauseSearch=ms=>{searchPausedUntil=Math.max(searchPausedUntil,now()+ms);};
 // Audio-only reader: no fingerprint/login preparation and no video format access.
 async function biliAudio(bvid){
   if(!BV.test(bvid))throw Object.assign(Error('not_found'),{reason:'not_found'});
   if(isPaused())throw Object.assign(Error('risk'),{reason:'risk'});
   const view=await biliApi('/x/web-interface/view',{bvid});
   if(view.code!==0)throw Object.assign(Error(classifyMedia(view.code)),{reason:classifyMedia(view.code)});
   const cid=view.data?.pages?.[0]?.cid||view.data?.cid;
   if(!cid)throw Object.assign(Error('audio_unavailable'),{reason:'audio_unavailable'});
   const play=await biliApi('/x/player/playurl',{bvid,cid,fnval:16,fnver:0,qn:16});
   if(play.code!==0)throw Object.assign(Error(classifyMedia(play.code)),{reason:classifyMedia(play.code)});
   const audio=play.data?.dash?.audio;
   if(!Array.isArray(audio)||!audio.length)throw Object.assign(Error('audio_unavailable'),{reason:'audio_unavailable'});
   return {cid,duration:view.data.duration||0,pic:view.data.pic||'',urls:audio};
 }
 return {biliApi,biliSubtitle,biliPassport,anonymousBuvid,resolveShort,biliLight,biliAudio,prepare,setSessionCookies,isPaused,pauseForRisk,isSearchPaused,pauseSearch,sanitize:safe};
}
export function classify(error) {
 if(error?.message==='风控'||[412,403].includes(error?.status)||[-412,-352].includes(error?.code))return {reason:'risk',retryAfter:error?.scope==='search'?3600:600};
 if(error?.timeout===true||error?.code==='ETIMEDOUT')return {reason:'timeout'};
 if(['unsupported','not_found'].includes(error?.reason))return {reason:error.reason};
 if(error?.status===404||[-404,62002,62004,62012].includes(error?.code))return {reason:'not_found'};
 if(error?.status===401||[-101,-403].includes(error?.code))return {reason:'login_required'};
 return {reason:'invalid'};
}
export async function runJob(job,client,cloud,log=()=>{},beforeUse=async()=>{},proto){
 const p=job.payload||{};
 let report={id:job.id,lease:p.lease,success:false,...(proto===2?{proto:2}:{})};
 try{
   const titleRef=typeof p.ref==='string'&&/^t-[0-9a-f]{16}$/.test(p.ref),paged=proto===2&&p.v===2;
   if(p.type!=='bili'||p.tier!=='light'||typeof p.ref!=='string')throw Error('无效任务');
   if(titleRef&&(typeof p.title!=='string'||![...p.title].length||[...p.title].length>100||/[\p{Cc}\p{Cf}]/u.test(p.title)))throw Error('无效任务');
   if(paged){
     const valid=p.kind==='bv'?BV.test(p.base):p.kind==='aid'?/^av\d{1,12}$/.test(p.base):p.kind==='short'?SHORT.test(p.base):p.kind==='title'&&titleRef&&p.base===p.ref;
     if(!valid||!Number.isInteger(p.page)||(p.kind==='short'?p.page!==0:p.page<1||p.page>999)||p.kind==='title'&&p.page!==1||p.ref!==p.base+(p.page>1?'~p'+p.page:''))throw Error('无效任务');
   }else if(!BV.test(p.ref)&&!SHORT.test(p.ref)&&!titleRef)throw Error('无效任务');
   await beforeUse();
   let result;
   if(titleRef)result=await biliByTitle(client,p.title);
   else if(!paged)result=await client.biliLight(p.ref,1);
   else {
     let bvid=p.base,page=p.page;
     if(p.kind==='short')({bvid,page}=await client.resolveShort(p.base,true));
     if(p.kind==='aid'){
       const view=await client.biliApi('/x/web-interface/view',{aid:Number(p.base.slice(2))});
       if(view?.code!==0||!BV.test(view.data?.bvid))throw Object.assign(Error('视频信息未读到'),{code:view?.code});
       bvid=view.data.bvid;
     }
     result=await client.biliLight(bvid,page);
   }
   report={...report,success:true,result};
 }catch(error){const c=classify(error);report={...report,...c};log(client.sanitize('fetch '+c.reason));}
 await cloud('report',client.sanitize(report));
}
/** Claim loop: 10 s idle, 2 s for 60 s after a wake or a finished job, login runs off-loop. */
export async function runFetchLoop({claim,work,login,wait,wake,now=Date.now,signal,log=()=>{}}){
 let fastUntil=0;
 const fast=()=>{fastUntil=now()+60000;};
 while(!signal?.aborted){
  try{
   const {job,login:task,proto}=await claim();
   if(task){
    const started=login(task);
    // A login may be a long promise; never await it, only notice a busy refusal.
    Promise.resolve(started).catch(()=>{});
    if(started===false)await wait(1000);
    continue;
   }
   if(job){await work(job,proto);fast();continue;}
  }catch(error){log('fetch cycle incomplete');}
  if(wake?.check?.()){fast();continue;}
  const delay=now()<fastUntil?2000:10000;
  if(await wait(delay))fast();
 }
}
async function main(){
 const home=resolve(homedir(),'.inkboard-team');
 const config=JSON.parse(await readFile(resolve(home,'config.json'),'utf8'));
 const base=new URL(config.url);if(base.protocol!=='https:'||base.username||base.password)throw Error('invalid cloud URL');
 const log=x=>console.log(safeLogText(x));
 const client=createFetchClient({log,riskPath:resolve(home,'state/bili-risk.json')});
 log('fetcher start '+createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex').slice(0,12));
 const cloud=async(path,body)=>{
   const r=await fetch(new URL('/api/runner/fetch/'+path,base),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.runnerToken},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   if(!r.ok){const error=Error('cloud request failed');error.status=r.status;throw error;}return r.json();
 };
 const auth=createBrowserAuth({home,client,report:body=>cloud('auth-status',body),log});
 if(process.argv[2]==='login'){
   const state=await auth.login(process.argv[3]);
   log(state==='ok'?'登录已保存在本机。':state==='risk'?'登录受到限制，请稍后再试。':'五分钟内未完成登录，窗口已关闭。');
   if(state!=='ok')process.exitCode=1;
   return;
 }
 let loginTask=null;
 const startLogin=task=>{
   if(loginTask)return false;
   loginTask=runLoginFlow(task,{home,client,auth,cloud}).catch(()=>log('login incomplete')).finally(()=>{loginTask=null;});
   return true;
 };
 const work=async(job,proto)=>{
   const heartbeat=setInterval(()=>cloud('heartbeat',{id:job.id,lease:job.payload.lease}).catch(()=>{}),30000);
   try{await runJob(job,client,cloud,log,()=>auth.prepareBili(client),proto);}finally{clearInterval(heartbeat);}
 };
 const wake=createWakePort(resolve(home,'fetch-wake'));
 await runFetchLoop({claim:async()=>{await auth.daily();return cloud('claim',{});},work,login:startLogin,wait:ms=>wake.wait(ms),wake,log});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message==='需要装一次浏览器（Chromium），请联系维护者安装后再登录。'?error.message:'fetcher startup failed；登录未完成，请检查本机运行环境。');process.exitCode=1;});

export function classifyMedia(code){
 if(code===-101)return 'login_required';
 if([-404,62002,62004,62012].includes(code))return 'not_found';
 if([-10403,87007,87008].includes(code))return 'paid';
 if([-412,-352,403,412].includes(code))return 'risk';
 return 'audio_unavailable';
}
