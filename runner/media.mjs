/** Short-lived, single-stream audio worker. No video acquisition or model downloads. */
import fs from 'node:fs';
import https from 'node:https';
import {homedir} from 'node:os';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createFetchClient,createSafeLookup,sanitize,classifyMedia} from './fetcher.mjs';
import {loadBiliCookies} from './browser-auth.mjs';
import {runCommand,expandHome,fault} from './asr.mjs';
import {transcribeAudio} from './cloud-asr.mjs';
const DAY=86400000,MAX_TMP=2048*1024**2,BV=/^BV[0-9A-Za-z]{10}$/;
const DEFAULT={enabled:false,max_minutes:90,rtf:0.05,deadline_cap_minutes:40,mem_cap_mb:1300,tmp_cap_mb:2048};
const DEFAULT_MODEL=join(homedir(),'Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03');
const homes=()=>join(homedir(),'.inkboard-team');
const names=dir=>{try{return fs.readdirSync(dir)}catch{return []}};
const exists=p=>fs.existsSync(p);
const size=p=>{try{const stat=fs.lstatSync(p);return stat.isDirectory()?names(p).reduce((n,s)=>n+size(join(p,s)),0):stat.size}catch{return 0}};
const privateDir=p=>{fs.mkdirSync(p,{recursive:true,mode:0o700});fs.chmodSync(p,0o700)};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function audioUrl(raw){try{const u=new URL(raw);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['.bilivideo.com','.bilivideo.cn','.akamaized.net'].some(s=>u.hostname.endsWith(s))?u:null}catch{return null}}
export function pickAudio(audio){
 for(const item of [...(Array.isArray(audio)?audio:audio?.audio||[])].sort((a,b)=>(a.bandwidth||0)-(b.bandwidth||0))){
  const urls=[item.baseUrl??item.base_url,...(item.backupUrl??item.backup_url??[])].filter(s=>typeof s==='string'&&audioUrl(s));
  if(urls.length)return [...new Set(urls)];
 }
 throw fault('audio_unavailable');
}
export function redactUrl(value){return String(value).replace(/https?:\/\/[^\s"'<>]+/g,raw=>{try{const u=new URL(raw);return u.origin+u.pathname}catch{return '[url]'}})}
export function downloadAudio(raw,dest,options={}){
 return new Promise((resolveResult,reject)=>{
  const signal=options.signal,lookup=createSafeLookup(options.lookup),maxBytes=options.maxBytes??200*1024**2;
  let req,fd,done=false,written=0,expectedBytes;const initialTmp=options.tmpRoot?size(options.tmpRoot):0;
  const close=()=>{if(fd!==undefined){fs.closeSync(fd);fd=undefined}};
  const finish=reason=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);close();if(reason){req?.destroy();reject(fault(reason))}else resolveResult(dest)};
  const abort=()=>finish(signal.reason?.reason||'cancelled');
  const timer=setTimeout(()=>finish('download_failed'),options.timeoutMs??900000);
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted){abort();return;}
  function get(url,hop){
   const u=audioUrl(url);if(!u){finish('download_failed');return;}
   try{
    options.log?.(u.hostname);
    req=(options.request||https.request)({host:u.hostname,servername:u.hostname,path:u.pathname+u.search,method:'GET',headers:{Referer:'https://www.bilibili.com/','User-Agent':'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',Range:'bytes=0-'},lookup,agent:false,timeout:30000},response=>{
     if(done){response.destroy();return;}
     response.on('error',()=>finish('download_failed'));
     if(response.statusCode>=300&&response.statusCode<400){response.resume();if(hop>=3){finish('download_failed');return;}try{get(new URL(response.headers.location,u).href,hop+1)}catch{finish('download_failed')}return;}
     // Request the entire audio stream as a range, as the Bili player CDN expects.
     // A 206 must cover byte zero through EOF; a truncated prefix is not a complete audio file.
     if(response.statusCode===206){const range=String(response.headers['content-range']||'').match(/^bytes 0-(\d+)\/(\d+)$/);if(!range||Number(range[1])+1!==Number(range[2])){response.resume();finish('download_failed');return;}expectedBytes=Number(range[2]);}
     else expectedBytes=Number(response.headers['content-length'])||undefined;
     if(![200,206].includes(response.statusCode)||expectedBytes>maxBytes||Number(response.headers['content-length'])>maxBytes){response.resume();finish('download_failed');return;}
     try{fd=fs.openSync(dest,'wx',0o600)}catch{response.destroy();finish('download_failed');return;}
     response.on('error',()=>finish('download_failed'));response.on('aborted',()=>finish('download_failed'));
     response.on('data',buffer=>{
      if(done)return;written+=buffer.length;
      if(written>maxBytes){finish('download_failed');response.destroy();return;}
      if(initialTmp+written>(options.tmpCapBytes??MAX_TMP)){finish('local_busy');response.destroy();return;}
      try{fs.writeSync(fd,buffer)}catch{finish('download_failed');response.destroy()}
     });response.on('end',()=>finish(written&&(!expectedBytes||written===expectedBytes)?null:'download_failed'));
    });req.on('error',()=>finish('download_failed'));req.on('timeout',()=>finish('download_failed'));req.end();
   }catch{finish('download_failed')}
  }
  get(raw,0);
 });
}
export const ffmpegArgs=(src,dst,maxMin=90)=>['-nostdin','-hide_banner','-loglevel','error','-i',src,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-t',String(maxMin*60),'-y',dst];
export async function ffmpegAudio(src,dst,{maxMinutes=90,signal,onChild}={},deps={}){
 const r=await runCommand('ffmpeg',ffmpegArgs(src,dst,maxMinutes),{timeoutMs:120000,timeoutReason:'download_failed',signal,onChild},deps);
 if(r.code!==0)throw fault('download_failed');return r;
}
export async function makeClient(home,deps={}){
 const saved=await (deps.loadBiliCookies||loadBiliCookies)(home),cookies={};
 for(const [k,c]of Object.entries(saved))if(c.expires<0||c.expires>Date.now()/1000)cookies[k]=c.value;
 return (deps.createFetchClient||createFetchClient)({cookies,riskPath:join(home,'bili-risk.json'),log:deps.log||(()=>{})});
}
export function acquireLock(home,now=Date.now()){
 privateDir(home);const path=join(home,'media.lock');
 try{fs.mkdirSync(path,{mode:0o700})}catch(error){
  if(error.code!=='EEXIST')throw error;
  if(now-fs.statSync(path).mtimeMs<3600000)return null;
  fs.rmSync(path,{recursive:true,force:true});try{fs.mkdirSync(path,{mode:0o700})}catch{return null}
 }
 return ()=>fs.rmSync(path,{recursive:true,force:true});
}
export async function sweepLocal(home,now=Date.now(),deps={}){
 const pidFile=join(home,'media-child.pid');
 if(exists(pidFile)){
  try{
   const pid=Number(fs.readFileSync(pidFile,'utf8'));
   if(Number.isInteger(pid)&&pid>1){
    const command=(deps.command||((p)=>execFileSync('ps',['-o','command=','-p',String(p)],{encoding:'utf8',timeout:2000})))(pid);
    if(/xasr_transcribe|ffmpeg/.test(command))(deps.kill||process.kill)(-pid,'SIGKILL');
   }
  }catch{deps.log?.('子进程清理未完成，保留 PID 待下次重试');return false;}
  fs.rmSync(pidFile,{force:true});
 }
 const tmp=join(home,'media-tmp');privateDir(tmp);for(const file of names(tmp))fs.rmSync(join(tmp,file),{recursive:true,force:true});
 for(const file of names(join(home,'media-reports')))if(file.endsWith('.json')){const path=join(home,'media-reports',file);if(now-fs.lstatSync(path).mtimeMs>DAY)fs.rmSync(path,{force:true});}
 // Approved cleanup patch: metadata only, no marker and no log-content reads. Oversized logs are cleared.
 for(const file of ['media.log','media-error.log']){
  const path=join(home,file);if(!exists(path))continue;const stat=fs.lstatSync(path);if(!stat.isFile()||stat.size<=1024**2)continue;
  fs.truncateSync(path,0);
 }
 return true;
}
export function startupGate(home,deps={}){
 let level=100;try{level=(deps.memory||(()=>Number(execFileSync('sysctl',['-n','kern.memorystatus_level'],{encoding:'utf8',timeout:2000}))))()}catch{}
 const available=(deps.free||(()=>{const s=fs.statfsSync(home);return Number(s.bavail)*Number(s.bsize)}))();
 const used=(deps.tmp||(()=>size(join(home,'media-tmp'))))();
 return {ok:level>=25&&available>=3*1024**3&&used<MAX_TMP,reason:'local_busy'};
}
const timestamp=s=>{s=Math.max(0,Math.floor(s));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')};
function cleanReport(report,client){
 const scrub=value=>{
  if(typeof value==='string')return redactUrl(value).replace(/https?:\/\/[^\s"'<>]+/g,s=>{try{return '['+new URL(s).hostname+']'}catch{return '[url]'}});
  if(Array.isArray(value))return value.map(scrub);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,scrub(v)]));return value;
 };
 return scrub(client?.sanitize?client.sanitize(report):sanitize(report,[]));
}
export async function runMediaJob(job,deps={}){
 const home=deps.home||homes(),cfg={...DEFAULT,...deps.settings},controller=new AbortController(),payload=job.payload||{},bvid=payload.bvid;
 if(!BV.test(bvid)||job.kind!=='bili_media'||job.id!=='bmedia-'+bvid)throw fault('not_found');
 const dir=join(home,'media-tmp',job.id),pidFile=join(home,'media-child.pid'),m4a=join(dir,'a.m4a'),wav=join(dir,'a.wav');
 privateDir(dir);const files=new Set(),started=Date.now();let report,untilTimer,heartbeat,busy=false,conflict=false,stage='download_failed',asrResult;
 const observe=()=>{for(const file of names(dir)){files.add(file);deps.onFile?.(file,fs.lstatSync(join(dir,file)).size)}};
 const stop=reason=>{if(!controller.signal.aborted)controller.abort(fault(reason))};
 const onAbort=()=>stop('cancelled'),onTerm=()=>stop('media_timeout');deps.signal?.addEventListener('abort',onAbort,{once:true});process.once('SIGTERM',onTerm);
 const onChild=(pid,nice)=>{fs.writeFileSync(pidFile,String(pid),{mode:0o600});deps.onChild?.(pid,nice)};
 const beat=async()=>{
  if(busy||controller.signal.aborted)return;busy=true;
  try{
   if(Date.now()>payload.until){stop('media_timeout');return;}
   const lock=join(home,'media.lock');if(exists(lock))fs.utimesSync(lock,new Date(),new Date());
   const r=await deps.cloud?.('heartbeat',{id:job.id,lease:payload.lease,progress:deps.progress||'处理中'});
   if(r?.status===409){conflict=true;stop('cancelled');}
  }catch{}finally{busy=false}
 };
 try{
  untilTimer=setTimeout(()=>stop('media_timeout'),Math.max(0,Math.min(2147483647,payload.until-Date.now())));heartbeat=(deps.setInterval||setInterval)(beat,30000);
  if(deps.signal?.aborted)onAbort();if(Date.now()>=payload.until)throw fault('media_timeout');
  const client=deps.client||await makeClient(home,deps);if(client.isPaused())throw fault('risk');
  const info=await client.biliAudio(bvid);if(controller.signal.aborted)throw controller.signal.reason;
  const candidates=pickAudio(info.urls);const duration=Number(payload.duration||info.duration),covered=Math.min(duration,Math.min(90,cfg.max_minutes)*60);
  for(let i=0;i<candidates.length;i++){
   try{
    await (deps.download||downloadAudio)(candidates[i],m4a,{signal:controller.signal,tmpRoot:join(home,'media-tmp'),tmpCapBytes:Math.min(2048,cfg.tmp_cap_mb)*1024**2});break;
   }catch(error){
    if(controller.signal.aborted||error.reason!=='download_failed'||i===candidates.length-1)throw error;
    fs.rmSync(m4a,{force:true});
   }
  }
  observe();
  await (deps.ffmpeg||ffmpegAudio)(m4a,wav,{maxMinutes:Math.min(90,cfg.max_minutes),signal:controller.signal,onChild});observe();fs.rmSync(m4a,{force:true});
  stage='asr_failed';
  const asrConfig=deps.asrConfig||{python:join(home,'xasr-venv/bin/python'),model_dir:DEFAULT_MODEL};
  asrResult=await transcribeAudio(wav,{settings:{...cfg,...payload.settings},keyFile:deps.deepseekConfig?.key_file,python:expandHome(asrConfig.python),modelDir:expandHome(asrConfig.model_dir),memCapMb:Math.min(1300,cfg.mem_cap_mb),timeoutMs:Math.min(60000+covered*cfg.rtf*4000,payload.until-Date.now()),signal:controller.signal,onChild,onProgress:p=>{deps.progress='转写 '+p.done+'/'+p.total}},{local:deps.asr,callDs:deps.callDs,fetch:deps.fetch});
  fs.rmSync(wav,{force:true});if(controller.signal.aborted)throw controller.signal.reason;
  const text=asrResult.segments.map(s=>'['+timestamp(s.start)+'] '+s.text).join('\n');
  report={id:job.id,lease:payload.lease,success:true,result:{bvid,text,covered:Math.min(covered,asrResult.audio_s),duration,partial:duration>Math.min(covered,asrResult.audio_s),chunks:asrResult.chunks,provider:asrResult.provider,cloud_chunks:asrResult.cloud_chunks,local_chunks:asrResult.local_chunks,units:asrResult.units,...(asrResult.meta?{meta:asrResult.meta}:{})}};
 }catch(error){
  const reason=controller.signal.aborted?controller.signal.reason?.reason:error.reason||(['风控'].includes(error.message)||[403,412].includes(error.status)||[-352,-412].includes(error.code)?'risk':stage);
  report=conflict?null:{id:job.id,lease:payload.lease,success:false,reason:reason==='cancelled'?'media_timeout':reason};
 }finally{
  clearTimeout(untilTimer);if(heartbeat)(deps.clearInterval||clearInterval)(heartbeat);deps.signal?.removeEventListener('abort',onAbort);process.removeListener('SIGTERM',onTerm);
  observe();try{fs.rmSync(dir,{recursive:true,force:true})}catch{}try{fs.rmSync(pidFile,{force:true})}catch{}
 }
 const cleanup={residue:exists(dir)?Math.max(1,names(dir).length):0,paths:exists(dir)?names(dir).slice(0,5):[]};if(report)report=cleanReport({...report,cleanup},deps.client);
 deps.log?.('已清理，残留 '+cleanup.residue);
 return {report,cleanup,files_seen:[...files],max_rss_mb:asrResult?.max_rss_mb||0,nice:asrResult?.nice??0,wall_s:Math.round((Date.now()-started)/100)/10};
}
function reportPath(home,id){if(!/^bmedia-BV[0-9A-Za-z]{10}$/.test(id))throw fault('asr_failed');return join(home,'media-reports',id+'.json')}
export async function sendReport(report,deps){
 const home=deps.home||homes(),path=reportPath(home,report.id),safe=cleanReport(report,deps.client);let delivered=false;
 for(let i=0;i<3;i++){
  try{const r=await deps.cloud('report',safe);if(r.status>=400&&r.status<500||r.status>=200&&r.status<300){delivered=true;break;}}catch{}
  if(i<2)await (deps.sleep||wait)(2000*2**i);
 }
 if(delivered){fs.rmSync(path,{force:true});return true;}
 privateDir(join(home,'media-reports'));const tmp=path+'.tmp';try{fs.writeFileSync(tmp,JSON.stringify(safe),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,path)}finally{fs.rmSync(tmp,{force:true})}return false;
}
export async function flushReports(deps){
 const home=deps.home||homes();for(const file of names(join(home,'media-reports'))){if(!/^bmedia-BV[0-9A-Za-z]{10}\.json$/.test(file))continue;const path=join(home,'media-reports',file);if(Date.now()-fs.statSync(path).mtimeMs>DAY){fs.rmSync(path);continue;}try{await sendReport(JSON.parse(fs.readFileSync(path,'utf8')),deps)}catch{}}
}
export async function runCycle(deps){
 const home=deps.home||homes(),release=acquireLock(home);if(!release)return;
 try{
  if(!await sweepLocal(home,Date.now(),deps))return;await flushReports(deps);
  for(let count=0;count<3;count++){
   if(deps.signal?.aborted||!(deps.gate||(()=>startupGate(home)) )().ok)return;
   const job=deps.claim?await deps.claim():(await deps.cloud('claim',{})).data?.job;
   if(!job||job.kind!=='bili_media')return;
   const path=reportPath(home,job.id);
   if(exists(path)){const report=JSON.parse(fs.readFileSync(path,'utf8'));await sendReport({...report,id:job.id,lease:job.payload.lease},deps);continue;}
   const result=await runMediaJob(job,deps);if(result.report)await sendReport(result.report,deps);
  }
 }finally{release()}
}
function settings(home){
 const repo=fileURLToPath(new URL('../config/team.json',import.meta.url)),path=exists(repo)?repo:join(home,'agent-settings.json');const config=JSON.parse(fs.readFileSync(path,'utf8'));return {...DEFAULT,...config.settings,...config.bili?.media};
}
export async function main(argv=process.argv.slice(2)){
 const home=homes(),cfg=settings(home),client=await makeClient(home);
 if(argv[0]==='once'){
  const bvid=argv[1];if(!BV.test(bvid||'')){console.log(JSON.stringify({error:'not_found',cleanup:{residue:0,paths:[]}}));return 1;}
  const release=acquireLock(home);if(!release){console.log(JSON.stringify({bvid,error:'local_busy',cleanup:{residue:0,paths:[]}}));return 1;}
  try{
   if(!await sweepLocal(home)||!startupGate(home).ok){console.log(JSON.stringify({bvid,error:'local_busy',cleanup:{residue:0,paths:[]}}));return 1;}
   const light=await client.biliLight(bvid);if(light.subtitle_status==='ok'){console.log(JSON.stringify({error:'has_subtitle'}));return 7;}
   const job={id:'bmedia-'+bvid,kind:'bili_media',payload:{bvid,duration:light.duration,lease:'local-only',until:Date.now()+cfg.deadline_cap_minutes*60000}};
   const result=await runMediaJob(job,{home,client,settings:cfg});
   if(!result.report?.success){console.log(JSON.stringify({bvid,error:result.report?.reason||'media_timeout',cleanup:result.cleanup}));return 1;}
   const r=result.report.result;console.log(JSON.stringify({bvid,subtitle_status:light.subtitle_status,duration:r.duration,covered:r.covered,partial:r.partial,chunks:r.chunks,chars:r.text.length,head:r.text.slice(0,300),files_seen:result.files_seen,max_rss_mb:result.max_rss_mb,nice:result.nice,wall_s:result.wall_s,cleanup:result.cleanup}));return 0;
  }catch(error){console.log(JSON.stringify({bvid,error:error.reason||'download_failed',cleanup:{residue:0,paths:[]}}));return 1;}finally{release()}
 }
 if(!cfg.enabled)return 0;
 const config=JSON.parse(fs.readFileSync(join(home,'config.json'),'utf8')),url=new URL(config.url);if(url.protocol!=='https:'||url.username||url.password)throw fault('asr_unavailable');
 const cloud=async(path,body)=>{const r=await fetch(new URL('/api/runner/fetch/media/'+path,url),{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.runnerToken,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});return {status:r.status,data:await r.json().catch(()=>({}))}};
 const controller=new AbortController(),stop=()=>controller.abort(fault('media_timeout'));process.once('SIGTERM',stop);
 try{await runCycle({home,client,settings:{...cfg,...config.settings,...(config.asr?.provider?{'asr:provider':config.asr.provider}:{})},asrConfig:config.asr,deepseekConfig:config.deepseek,cloud,signal:controller.signal,log:s=>console.error(s)});}finally{process.removeListener('SIGTERM',stop)}return 0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().then(code=>{process.exitCode=code}).catch(()=>{console.error('media worker unavailable');process.exitCode=1});
