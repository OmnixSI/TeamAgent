/** Fixed command descriptors are application code; request payloads never supply executable/argv/env. */
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,renameSync,rmSync} from 'node:fs';
import {join,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {validTarget,scopeFor} from '../src/reach-contract.mjs';
import {normalizeReachResult} from './reach-result.mjs';

// F9 platform packages add read-only descriptors here; missing components fail closed, never setup.
const xReader=fileURLToPath(new URL('./x-reader.mjs',import.meta.url));
const xCommand=action=>target=>[process.execPath,xReader,action,target];
const PUBLIC_READER=fileURLToPath(new URL('./reach-public.mjs',import.meta.url));
const publicReader=(channel,action)=>target=>[process.execPath,PUBLIC_READER,channel,action,target];
export const REACH_COMMANDS={
 // X needs the writer's own logged-in Edge profile; queries never install or open a login window.
 'x:thread:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:xCommand('thread')},
 'x:profile:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:xCommand('profile')},
 'x:tweets:local':{access:'read',resource:'browser',requires_login:true,content_scope:'post_text',argv:xCommand('tweets')},
 'x:search:local':{access:'read',resource:'browser',requires_login:true,content_scope:'search_results',argv:xCommand('search')},
 'weibo:hot:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('hot'),argv:publicReader('weibo','hot')},
 'weibo:search:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('search'),argv:publicReader('weibo','search')},
 'weibo:profile:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('profile'),argv:publicReader('weibo','profile')},
 'zhihu:hot:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('hot'),argv:publicReader('zhihu','hot')},
 'zhihu:search:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('search'),argv:publicReader('zhihu','search')},
 'zhihu:read:local':{access:'read',resource:'api',requires_login:false,content_scope:scopeFor('read'),argv:publicReader('zhihu','read')},
};
const MAX_BYTES=1024*1024;
const keys=new Set(['id','lease','version','channel','action','target','backend','deadline_ms','cooldown_ms']);
function readState(path){try{return JSON.parse(readFileSync(path,'utf8'));}catch{return {};}}
function live(pid){try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}}
function lock(dir){
 try{mkdirSync(dir,{mode:0o700});writeFileSync(join(dir,'owner'),String(process.pid),{mode:0o600});return ()=>rmSync(dir,{recursive:true,force:true});}
 catch(e){if(e.code!=='EEXIST')return null;const pid=Number((()=>{try{return readFileSync(join(dir,'owner'),'utf8');}catch{return '';}})());
  if(pid&&!live(pid)){rmSync(dir,{recursive:true,force:true});return lock(dir);}return null;}
}
function runProcess(argv,{deadline,signal}){
 return new Promise(resolve=>{
  let child,reason=null,bytes=0,chunks=[],done=false,killTimer,deadlineTimer,cleanupPromise=null;
  const kill=sig=>{if(child?.pid)try{process.kill(-child.pid,sig);}catch{}};
  const cleanup=()=>cleanupPromise??=new Promise(finish=>{kill('SIGTERM');killTimer=setTimeout(()=>{kill('SIGKILL');finish();},120);});
  const stop=kind=>{reason??=kind;void cleanup();};
  const abort=()=>stop('timeout');
  const finish=async()=>{if(done)return;done=true;clearTimeout(deadlineTimer);signal?.removeEventListener('abort',abort);await cleanup();clearTimeout(killTimer);
   resolve({reason,output:reason&&reason!=='upstream_unavailable'?'':Buffer.concat(chunks).toString('utf8'),truncated:reason==='output_limit'});};
  // A minimal environment avoids passing cloud credentials or arbitrary browser configuration to backends.
  try{child=spawn(argv[0],argv.slice(1),{detached:true,shell:false,stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin',LANG:'en_US.UTF-8',HOME:homedir()}});}catch{resolve({reason:'tool_not_ready'});return;}
  const receive=(chunk,keep)=>{bytes+=chunk.length;if(bytes>MAX_BYTES){chunks=[];stop('output_limit');}else if(keep&&!reason)chunks.push(chunk);};
  child.stdout.on('data',chunk=>receive(chunk,true));child.stderr.on('data',chunk=>receive(chunk,false));
  child.on('error',()=>{reason='tool_not_ready';void finish();});
  child.on('exit',code=>{if(code&&!reason)reason='upstream_unavailable';void cleanup();});
  child.on('close',()=>void finish());
  deadlineTimer=setTimeout(()=>stop('timeout'),Math.max(1,deadline-Date.now()));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 });
}
export function createReachAdapter({commands=REACH_COMMANDS,stateDir=join(homedir(),'.inkboard-team/state/reach'),now=Date.now}={}){
 return {async run(req,{signal}={}){
  const fail=(kind,extra={},opts={})=>normalizeReachResult(req,{ok:false,error:{error_kind:kind,...extra}},opts);
  if(!req||Object.keys(req).some(k=>!keys.has(k))||req.version!==1||typeof req.id!=='string'||typeof req.lease!=='string'||!validTarget(req.channel,req.action,req.target)||!['local','opencli','native','public-web'].includes(req.backend))return fail('unsupported');
  const entry=commands[`${req.channel}:${req.action}:${req.backend}`];
  if(!entry)return fail('tool_not_ready');
  if(entry.access!=='read'||!['browser','api'].includes(entry.resource)||entry.content_scope!==scopeFor(req.action)||typeof entry.argv!=='function'||entry.requires_login&&(['public-web','jina','exa'].includes(req.backend)||entry.resource!=='browser'))return fail('unsupported');
  let argv;try{argv=entry.argv(req.target);if(!Array.isArray(argv)||!argv.length||!argv.every(x=>typeof x==='string')||!isAbsolute(argv[0]))return fail('tool_not_ready');}catch{return fail('tool_not_ready');}
  mkdirSync(stateDir,{recursive:true,mode:0o700});const path=join(stateDir,'cooldowns.json');
  const state=readState(path),rateKey=req.channel+':'+req.backend,blocked=[state[req.channel],state[rateKey]].find(s=>s?.until>now());
  if(blocked?.until>now())return fail(blocked.kind,{retry_after:Math.ceil((blocked.until-now())/1000)});
  const releases=[];
  if(entry.resource==='browser'){
   const global=lock(join(stateDir,'browser'));if(!global)return fail('busy');releases.push(global);
   const site=lock(join(stateDir,'site-'+req.channel));if(!site){global();return fail('busy');}releases.push(site);
  }else{const slot=lock(join(stateDir,'api-0'))||lock(join(stateDir,'api-1'));if(!slot)return fail('busy');releases.push(slot);}
  try{
   const budget=Math.min(45000,Number.isFinite(req.deadline_ms)?Math.max(1,req.deadline_ms):45000);
   const child=await runProcess(argv,{deadline:Date.now()+budget,signal});let result;
   if(child.reason&&child.reason!=='upstream_unavailable')result=fail(child.reason==='output_limit'?'insufficient_content':child.reason,{}, {output_truncated:child.truncated});
   else{let raw;try{raw=JSON.parse(child.output);}catch{raw={ok:false};}result=normalizeReachResult(req,raw);}
   const kind=result.error?.error_kind;
   if(['platform_blocked','rate_limited'].includes(kind)){
    const cooldown=kind==='platform_blocked'?Math.min(86400000,Math.max(60000,Number(req.cooldown_ms)||1800000)):(result.error.retry_after||3600)*1000;
    const next=readState(path);next[kind==='platform_blocked'?req.channel:rateKey]={kind,until:now()+cooldown};
    const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(next),{mode:0o600});renameSync(temp,path);result.error.retry_after=Math.ceil(cooldown/1000);
   }
   return result;
  }finally{for(const release of releases.reverse())release();}
 }};
}
