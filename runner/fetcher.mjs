/** Low-frequency read-only Bilibili fetcher. No browser or login required. */
import https from 'node:https';
import dns from 'node:dns';
import {BlockList,isIP} from 'node:net';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MIXIN=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const BV=/^BV[0-9A-Za-z]{10}$/;
const SHORT=/^[0-9A-Za-z]{4,12}$/;
const blocked=new BlockList();
for(const [ip,bits] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(ip,bits,'ipv4');
for(const [ip,bits] of [['::',128],['::1',128],['fc00::',7],['fe80::',10],['ff00::',8],['64:ff9b::',96],['2001:db8::',32]])blocked.addSubnet(ip,bits,'ipv6');
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
   return text;
 }
 if(Array.isArray(value))return value.map(x=>sanitize(x,secrets));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,sanitize(v,secrets)]));
 return value;
}
function allowed(raw,kind){
 const u=new URL(raw);
 if(u.protocol!=='https:'||(u.port&&u.port!=='443')||u.username||u.password)throw Error('blocked URL');
 const ok=kind==='api'?u.hostname==='api.bilibili.com':kind==='subtitle'?u.hostname.endsWith('.hdslb.com'):kind==='short'&&u.hostname==='b23.tv';
 if(!ok)throw Error('blocked host');return u;
}
export function createFetchClient(options={}){
 const request=options.request||https.request,lookup=createSafeLookup(options.lookup||dns.lookup),now=options.now||Date.now,sleep=options.sleep||(ms=>new Promise(r=>setTimeout(r,ms))),random=options.random||Math.random;
 const cookies={...(options.cookies||{})};let nextAt=0,serial=Promise.resolve(),riskCount=0,pausedUntil=0,buvidAt=cookies.buvid3?now():-Infinity,wbi=null,wbiAt=-Infinity;
 const knownSecrets=new Set(Object.values(cookies).filter(x=>typeof x==='string'&&x));
 const secrets=()=>[...knownSecrets];
 const safe=x=>sanitize(x,secrets());
 const rate=()=>{const slot=serial.then(async()=>{if(now()<pausedUntil)throw Error('风控');const delay=Math.max(0,nextAt-now());if(delay)await sleep(delay);if(now()<pausedUntil)throw Error('风控');nextAt=now()+1000+200+Math.floor(random()*601);});serial=slot.catch(()=>{});return slot;};
 function risk(hit){riskCount=hit?riskCount+1:0;if(riskCount>=2)pausedUntil=now()+600000;}
 async function get(raw,kind){
   const u=allowed(raw,kind);await rate();
   // Fresh headers per request: never reuse the API Cookie for a subtitle/short URL.
   const headers={'User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36','Referer':'https://www.bilibili.com/','Accept':'application/json','Accept-Encoding':'identity'};
   if(kind==='api'){const values=['buvid3','SESSDATA'].filter(k=>typeof cookies[k]==='string'&&cookies[k]);if(values.length)headers.Cookie=values.map(k=>k+'='+cookies[k]).join('; ');}
   return new Promise((resolveResult,reject)=>{
     let settled=false,timer;
     const fail=()=>{if(!settled){settled=true;clearTimeout(timer);reject(Error(now()<pausedUntil?'风控':'抓取失败'));}};
     const req=request({host:u.hostname,servername:u.hostname,path:u.pathname+u.search,method:'GET',headers,lookup,agent:false,timeout:8000},res=>{
       const chunks=[];let size=0;
       res.on('error',fail);res.on('aborted',fail);
       res.on('data',chunk=>{if(settled)return;size+=chunk.length;if(size>2_000_000){fail();req.destroy();}else chunks.push(chunk);});
       res.on('end',()=>{
         if(settled)return;
         const status=res.statusCode;
         let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{}
         const hit=status===412||[-352,-412].includes(data?.code);risk(hit);
         if(hit||(!(status>=200&&status<300)&&!(kind==='short'&&status>=300&&status<400))){fail();return;}
         settled=true;clearTimeout(timer);resolveResult({status,headers:res.headers,data});
       });
     });
     req.on('error',fail);req.on('timeout',()=>{fail();req.destroy();});timer=setTimeout(()=>{fail();req.destroy();},8000);req.end();
   });
 }
 async function biliApi(path,params={}){
   if(typeof path!=='string'||!path.startsWith('/')||path.startsWith('//'))throw Error('blocked API path');
   const query=typeof params==='string'?params:new URLSearchParams(Object.entries(params).map(([k,v])=>[k,String(v)])).toString();
   const r=await get('https://api.bilibili.com'+path+(query?'?'+query:''),'api');
   if(!r.data)throw Error('无效接口响应');return r.data;
 }
 async function biliSubtitle(url){const r=await get(url,'subtitle');if(!r.data)throw Error('无效字幕响应');return r.data;}
 async function resolveShort(code){
   if(!SHORT.test(code))throw Error('短链无效');let u=new URL('https://b23.tv/'+code);
   for(let hop=0;hop<3;hop++){
     const r=await get(u.href,'short');
     if(!(r.status>=300&&r.status<400)||!r.headers.location)throw Error('短链无效');
     const target=new URL(r.headers.location,u);
     if(target.protocol!=='https:'||(target.port&&target.port!=='443')||target.username||target.password)throw Error('短链无效');
     if(['www.bilibili.com','m.bilibili.com'].includes(target.hostname)){
       const bv=target.pathname.match(/\bBV[0-9A-Za-z]{10}\b/)?.[0];if(bv)return bv;throw Error('短链无效');
     }
     if(target.hostname!=='b23.tv')throw Error('短链无效');u=target;
   }throw Error('短链无效');
 }
 async function biliLight(ref){
   if(!BV.test(ref)&&!SHORT.test(ref))throw Error('无效视频编号');
   const bvid=BV.test(ref)?ref:await resolveShort(ref);
   if(now()-buvidAt>=86400000){const spi=await biliApi('/x/frontend/finger/spi');if(typeof spi.data?.b_3==='string'){cookies.buvid3=spi.data.b_3;knownSecrets.add(spi.data.b_3);buvidAt=now();}}
   if(!wbi||now()-wbiAt>=43200000){const nav=await biliApi('/x/web-interface/nav');const keys=nav.data?.wbi_img;if(keys){wbi=[keys.img_url,keys.sub_url].map(x=>new URL(x).pathname.split('/').at(-1).split('.')[0]);wbiAt=now();}}
   const view=await biliApi('/x/web-interface/view',{bvid});if(view.code!==0||!view.data)throw Error('视频信息未读到');
   const v=view.data,cid=v.pages?.[0]?.cid||v.cid;
   let subtitle=null,subtitle_lang=null;
   if(wbi&&cid){
     try{
       const player=await biliApi('/x/player/wbi/v2',wbiSign({bvid,cid},...wbi,Math.floor(now()/1000)));
       if(player.code===0){
         const list=player.data?.subtitle?.subtitles||[];
         const selected=list.find(s=>['zh-CN','zh-Hans','ai-zh'].includes(s.lan))||list[0];
         if(selected?.subtitle_url){const url=selected.subtitle_url.startsWith('//')?'https:'+selected.subtitle_url:selected.subtitle_url;const sub=await biliSubtitle(url);subtitle=(sub.body||[]).map(x=>String(x.content||'')).join(' ').slice(0,6000)||null;subtitle_lang=selected.lan||null;}
       }
     }catch(error){if(now()<pausedUntil)throw error;}
   }
   let comments=[];
   try{const reply=await biliApi('/x/v2/reply',{type:1,oid:v.aid,sort:1,ps:20});if(reply.code===0){const list=[...(reply.data?.hots||[]),...(reply.data?.replies||[])];const unique=[...new Map(list.map(x=>[x.rpid??(x.member?.uname+'\0'+x.content?.message),x])).values()];comments=unique.sort((a,b)=>(b.like||0)-(a.like||0)).slice(0,8).map(c=>({uname:String(c.member?.uname||'').slice(0,100),message:String(c.content?.message||'').slice(0,120)}));}}catch(error){if(now()<pausedUntil)throw error;}
   return safe({bvid,title:String(v.title||'').slice(0,300),desc:String(v.desc||'').slice(0,1500),owner:String(v.owner?.name||'').slice(0,100),tname:String(v.tname||'').slice(0,100),duration:v.duration||0,pubdate:v.pubdate||0,stat:Object.fromEntries(['view','like','coin','favorite','reply'].map(k=>[k,v.stat?.[k]||0])),subtitle,subtitle_lang,comments,tier:'light',fetched_at:new Date(now()).toISOString()});
 }
 return {biliApi,biliSubtitle,resolveShort,biliLight,sanitize:safe};
}
export async function runJob(job,client,cloud,log=()=>{}){
 const p=job.payload||{};
 let report={id:job.id,lease:p.lease,success:false};
 try{
   if(p.type!=='bili'||p.tier!=='light'||typeof p.ref!=='string'||(!BV.test(p.ref)&&!SHORT.test(p.ref)))throw Error('无效任务');
   report={...report,success:true,result:await client.biliLight(p.ref)};
 }catch(error){report.reason=error.message==='风控'?'风控':'视频内容未读到';log(client.sanitize('fetch '+report.reason));}
 await cloud('report',client.sanitize(report));
}
async function main(){
 const home=resolve(homedir(),'.inkboard-team');
 const config=JSON.parse(await readFile(resolve(home,'config.json'),'utf8'));
 const base=new URL(config.url);if(base.protocol!=='https:'||base.username||base.password)throw Error('invalid cloud URL');
 let cookies={};try{cookies=JSON.parse(await readFile(resolve(home,'secrets/bili-cookie.json'),'utf8'));}catch{}
 const client=createFetchClient({cookies}),log=x=>console.log(client.sanitize(x));
 log('fetcher start '+createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex').slice(0,12));
 const cloud=async(path,body)=>{
   const r=await fetch(new URL('/api/runner/fetch/'+path,base),{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.runnerToken},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
   if(!r.ok)throw Error('cloud request failed');return r.json();
 };
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 for(;;){
   try{
     const {job}=await cloud('claim',{});
     if(!job){await sleep(10000);continue;}
     const heartbeat=setInterval(()=>cloud('heartbeat',{id:job.id,lease:job.payload.lease}).catch(()=>{}),30000);
     try{await runJob(job,client,cloud,log);}finally{clearInterval(heartbeat);}
   }catch{log('fetch cycle incomplete');await sleep(10000);}
 }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('fetcher startup failed');process.exitCode=1;});
