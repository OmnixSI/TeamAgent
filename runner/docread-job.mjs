/** The local consumer of read_document jobs: download one group file, parse it with docread.py, report back.
 *  Nothing survives the job: the temp directory and its file are removed in every path. */
import fs from 'node:fs';
import https from 'node:https';
import {execFile} from 'node:child_process';
import {homedir} from 'node:os';
import {basename,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSafeLookup} from './fetcher.mjs';

const MAX_BYTES=20*1024*1024,LEASE_MS=180000,SCRIPT=fileURLToPath(new URL('./docread.py',import.meta.url));
const homes=()=>join(homedir(),'.inkboard-team');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const exists=path=>{try{return fs.statSync(path).isFile()}catch{return false}};

/** https only, no credentials, no non-443 port. DNS is checked again by createSafeLookup. */
export function docUrl(raw){
 try{
  const url=new URL(String(raw));
  return url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443')?url:null;
 }catch{return null}
}
/** Keep the extension but never a directory part or a control character. */
export function safeDocName(raw){
 const name=basename(String(raw||'').replace(/\\/g,'/')).replace(/[\x00-\x1f]/g,'').trim();
 return !name||name==='.'||name==='..'?'document.bin':name.slice(0,150);
}
export function pickPython(home=homes(),configured=''){
 const candidates=[join(home,'venv/bin/python'),configured,process.env.DOCREAD_PYTHON,
  '/usr/local/bin/python3.12','/opt/homebrew/bin/python3.12'];
 for(const candidate of candidates){if(!candidate)continue;if(!candidate.includes('/')||exists(candidate))return candidate;}
 return 'python3';
}

export function downloadDoc(raw,dest,{request=https.request,lookup=createSafeLookup(),timeoutMs=120000,maxBytes=MAX_BYTES,signal}={}){
 return new Promise((resolveResult,reject)=>{
  let settled=false,fd,timer;
  const finish=error=>{
   if(settled)return;
   settled=true;clearTimeout(timer);
   if(fd!==undefined){try{fs.closeSync(fd)}catch{}fd=undefined;}
   if(error){try{fs.rmSync(dest,{force:true})}catch{}reject(error instanceof Error?error:Error('download_failed'));}
   else resolveResult(dest);
  };
  timer=setTimeout(()=>finish(Error('timeout')),Math.max(1000,timeoutMs));
  const abort=()=>finish(Error('cancelled'));
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)return abort();
  const get=(target,hop)=>{
   const url=docUrl(target);if(!url)return finish(Error('invalid_url'));
   let written=0,redirected=false;
   const req=request({host:url.hostname,servername:url.hostname,path:url.pathname+url.search,method:'GET',
    headers:{'User-Agent':'TeamAgent/1','Accept':'application/octet-stream'},lookup,agent:false,timeout:20000},res=>{
    if(settled){res.destroy();return;}
    if(res.statusCode>=300&&res.statusCode<400){
     redirected=true;res.resume();const location=res.headers.location;
     if(!location||hop>=3)return finish(Error('download_failed'));
     try{get(new URL(location,url).href,hop+1)}catch{finish(Error('download_failed'))}
     return;
    }
    const length=Number(res.headers['content-length']);
    if(res.statusCode!==200||(Number.isFinite(length)&&length>maxBytes)){res.resume();return finish(Error('download_failed'));}
    try{fd=fs.openSync(dest,'wx',0o600)}catch{res.destroy();return finish(Error('download_failed'));}
    res.on('data',chunk=>{
     if(settled)return;written+=chunk.length;
     if(written>maxBytes){res.destroy();return finish(Error('too_large'));}
     try{fs.writeSync(fd,chunk)}catch{res.destroy();finish(Error('download_failed'))}
    });
    res.on('end',()=>finish(written?null:Error('download_failed')));
    res.on('error',()=>{if(!redirected)finish(Error('download_failed'))});res.on('aborted',()=>{if(!redirected)finish(Error('download_failed'))});
   });
   req.on('error',()=>{if(!redirected)finish(Error('download_failed'))});
   req.on('timeout',()=>{if(!redirected){req.destroy();finish(Error('timeout'))}});
   req.end();
  };
  get(raw,0);
 });
}

const execFileResult=(file,args,options)=>new Promise(resolve=>{
 execFile(file,args,{...options,encoding:'utf8'},(error,stdout,stderr)=>
  resolve({code:error?.code??0,killed:error?.killed===true,stdout:stdout||'',stderr:stderr||''}));
});

/** One job. Always resolves with a report: parser failures are data, not exceptions. */
export async function runDocJob(job,{home=homes(),python,download=downloadDoc,exec=execFileResult,signal,log=()=>{}}={}){
 const p=job?.payload||{},url=docUrl(p.url),base={id:String(job?.id||''),lease:String(p.lease||'')};
 const fail=reason=>({report:{...base,success:false,reason},cleanup:{residue:0,paths:[]}});
 if(!job||typeof job.id!=='string'||!job.id.startsWith('docread-')||!url||typeof p.key!=='string'||!p.key.startsWith('doc:')||!p.lease)
  return fail('invalid_job');
 const root=join(home,'doc-tmp');fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
 const dir=fs.mkdtempSync(join(root,'docread-')),file=join(dir,safeDocName(p.filename));
 let report,cleanup={residue:0,paths:[]};
 try{
  await download(url.href,file,{signal});
  const args=[SCRIPT,'--path',file,'--root',dir,'--json'];
  if(typeof p.question==='string'&&p.question)args.push('--question',p.question.slice(0,200));
  const out=await exec(python||pickPython(home),args,{timeout:90000,maxBuffer:2*1024*1024,signal});
  if(out.killed)report={...base,success:false,reason:'timeout'};
  else if(typeof out.code==='string')report={...base,success:false,reason:'python_missing'};
  else{
   let value=null;try{value=JSON.parse(out.stdout)}catch{}
   report=value&&typeof value==='object'&&typeof value.ok==='boolean'
    ?{...base,success:true,result:value}
    :{...base,success:false,reason:'invalid_result'};
  }
 }catch(error){
  const reason=['invalid_url','too_large','timeout','cancelled'].includes(error?.message)?error.message:'download_failed';
  report={...base,success:false,reason};
 }finally{
  try{fs.rmSync(dir,{recursive:true,force:true})}catch{}
  if(fs.existsSync(dir))cleanup={residue:1,paths:[basename(dir)]};
  log('docread '+(report.reason||'done'));
 }
 return {report,cleanup};
}

/** Claim up to max jobs; each one is reported before the next is claimed. */
export async function runDocCycle({cloud,home,python,download,exec,signal,log=()=>{},max=3}={}){
 let count=0;
 for(let i=0;i<max&&!signal?.aborted;i++){
  const {job}=await cloud('claim',{});
  if(!job)break;
  const beat=setInterval(()=>cloud('heartbeat',{id:job.id,lease:job.payload?.lease}).catch(()=>{}),30000);
  try{
   const {report}=await runDocJob(job,{home,python,download,exec,signal,log});
   await cloud('report',report);count++;
  }finally{clearInterval(beat)}
 }
 return count;
}

/** Idle every 10 s, fast for a minute after any job, like the fetch lane. */
export async function runDocLoop({cloud,home,python,download,exec,signal,log=()=>{},wait=sleep}){
 let fastUntil=0;
 while(!signal?.aborted){
  try{const count=await runDocCycle({cloud,home,python,download,exec,signal,log});if(count)fastUntil=Date.now()+60000;}
  catch{log('doc cycle incomplete')}
  const delay=Date.now()<fastUntil?2000:10000;
  await new Promise(resolve=>{
   let settled=false;
   const done=()=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',done);resolve()};
   const timer=setTimeout(done,delay);
   signal?.addEventListener('abort',done,{once:true});
   wait(delay).then(done,done);
  });
 }
}
