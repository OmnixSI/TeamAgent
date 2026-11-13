/** Read-only local X-ASR adapter. Every invocation owns a killable process group. */
import {spawn as spawnChild,execFile} from 'node:child_process';
import {setPriority,getPriority,homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
export const SCRIPT=fileURLToPath(new URL('./xasr_transcribe.py',import.meta.url));
export const expandHome=(p,home=homedir())=>typeof p==='string'&&p.startsWith('~/')?join(home,p.slice(2)):p;
export const childEnv=(env=process.env)=>({PATH:env.PATH||'/usr/bin:/bin',HOME:env.HOME||homedir(),LANG:env.LANG||'en_US.UTF-8'});
export const fault=reason=>Object.assign(Error(reason),{reason});
const rss=pid=>new Promise(resolve=>execFile('ps',['-o','rss=','-p',String(pid)],{timeout:2000},(e,out)=>resolve(e?0:Number(out.trim())/1024)));
export function parseAsrOutput(lines){
 try{
  const rows=String(lines).trim().split('\n').filter(Boolean),last=JSON.parse(rows.at(-1));
  if(last.type!=='result'||!Array.isArray(last.segments)||!Number.isFinite(last.audio_s)||last.audio_s<0||!Number.isFinite(last.max_rss_mb))throw Error();
  let end=0;for(const s of last.segments){if(!Number.isFinite(s.start)||!Number.isFinite(s.end)||s.start<end||s.end<s.start||s.end>last.audio_s+0.01||typeof s.text!=='string')throw Error();end=s.end;}
  return last;
 }catch{throw fault('asr_failed')}
}
/** Shared audio-only child execution; callers never pass a shell or a secret env. */
export function runCommand(command,args,options={},deps={}){
 return new Promise((resolve,reject)=>{
  if(options.signal?.aborted){reject(fault('cancelled'));return;}
  let child,done=false,stdout='',stderr='',nice=15,peak=0,timer,watch,pending='';
  const outputDecoder=new StringDecoder('utf8'),errorDecoder=new StringDecoder('utf8');
  const kill=()=>{if(child?.pid)try{(deps.kill||process.kill)(-child.pid,'SIGKILL')}catch{}};
  const finish=(reason,code)=>{
   if(done)return;done=true;clearTimeout(timer);if(watch)(deps.clearInterval||clearInterval)(watch);options.signal?.removeEventListener('abort',abort);
   if(reason){kill();reject(fault(reason));}else {stdout+=outputDecoder.end();stderr=(stderr+errorDecoder.end()).slice(-2048);resolve({stdout,stderr,code,nice,max_rss_mb:peak});}
  };
  const abort=()=>finish(options.signal?.reason?.reason||'cancelled');
  try{
   child=(deps.spawn||spawnChild)(command,args,{env:childEnv(),detached:true,stdio:['ignore','pipe','pipe']});
   child.on('error',error=>finish(error.code==='ENOENT'?'asr_unavailable':'asr_failed'));
   child.on('close',code=>finish(null,code));
   if(child.pid){(deps.setPriority||setPriority)(child.pid,15);nice=(deps.getPriority||getPriority)(child.pid);options.onChild?.(child.pid,nice);}
   child.stdout.on('data',buffer=>{
    const chunk=outputDecoder.write(buffer);stdout+=chunk;if(stdout.length>1_000_000){finish('asr_failed');return;}
    pending+=chunk;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);try{const item=JSON.parse(line);if(item.type==='progress')options.onProgress?.(item)}catch{}}
   });
   child.stderr.on('data',buffer=>{stderr=(stderr+errorDecoder.write(buffer)).slice(-2048)});
   options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted){abort();return;}
   timer=setTimeout(()=>finish(options.timeoutReason||'asr_failed'),options.timeoutMs??120000);
   if(options.memCapMb)watch=(deps.setInterval||setInterval)(async()=>{
    if(done)return;
    try{const value=await (deps.rss||rss)(child.pid);peak=Math.max(peak,value);if(value>options.memCapMb)finish('mem_limit')}catch{}
   },5000);
  }catch(error){finish(error.code==='ENOENT'?'asr_unavailable':'asr_failed')}
 });
}
export async function runAsr(wav,{python,modelDir,memCapMb=1300,timeoutMs=120000,signal,onProgress,onChild}={},deps={}){
 const child=await runCommand(expandHome(python),['-u',SCRIPT,wav,'--model-dir',expandHome(modelDir),'--max-rss-mb',String(memCapMb)],{memCapMb,timeoutMs,signal,onProgress,onChild},deps);
 if(child.code!==0)throw fault([2,5].includes(child.code)?'asr_unavailable':child.code===6?'mem_limit':'asr_failed');
 const result=parseAsrOutput(child.stdout);if(result.segments.map(s=>s.text).join('').trim().length<10)throw fault('no_speech');
 return {...result,max_rss_mb:Math.max(result.max_rss_mb,child.max_rss_mb),nice:child.nice};
}
