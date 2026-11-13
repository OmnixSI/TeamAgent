/** Bounded cloud ASR for ffmpeg's 16 kHz mono PCM WAV; never downloads media. */
import fs from 'node:fs';
import {dirname,join} from 'node:path';
import {runAsr,fault,speechChars} from './asr.mjs';

const RATE=32000,MAX_BYTES=8*1024**2;
const enabled=v=>v===true||v===1||v==='1'||v==='true';
function cloudAllowed(settings,provider){
 if(provider==='local'||enabled(settings['off:ds_asr'])||enabled(settings['off:dstools']))return false;
 for(const [cap,used,fallback] of [['ds:asr:user_daily','ds:asr:user_used',200],['ds:asr:group_daily','ds:asr:group_used',1000],['ds:daily_cap_micro_usd','ds:daily_used_micro_usd',2000000]]){
  if(Number(settings[used]??0)>=Number(settings[cap]??fallback))return false;
 }
 return true;
}
function readExactly(fd,length,position){
 const bytes=Buffer.alloc(length);let n=0;
 while(n<length){const got=fs.readSync(fd,bytes,n,length-n,position+n);if(!got)throw fault('asr_failed');n+=got;}
 return bytes;
}
/** Read only WAV headers; a 90-minute source must not be buffered in memory. */
function wavInfo(fd){
 const size=fs.fstatSync(fd).size,h=readExactly(fd,12,0);
 if(h.toString('ascii',0,4)!=='RIFF'||h.toString('ascii',8,12)!=='WAVE')throw fault('asr_failed');
 let normalized=false;
 for(let offset=12;offset+8<=size;){
  const chunk=readExactly(fd,8,offset),length=chunk.readUInt32LE(4),tag=chunk.toString('ascii',0,4);offset+=8;
  if(offset+length>size)throw fault('asr_failed');
  if(tag==='fmt '){if(length<16)throw fault('asr_failed');const f=readExactly(fd,16,offset);normalized=f.readUInt16LE(0)===1&&f.readUInt16LE(2)===1&&f.readUInt32LE(4)===16000&&f.readUInt32LE(8)===RATE&&f.readUInt16LE(12)===2&&f.readUInt16LE(14)===16;}
  if(tag==='data'){if(!normalized||!length||length%2)throw fault('asr_failed');return {offset,bytes:length,duration:length/RATE};}
  offset+=length+(length%2);
 }
 throw fault('asr_failed');
}
function waveHeader(length){
 const h=Buffer.alloc(44);h.write('RIFF');h.writeUInt32LE(36+length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(RATE,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(length,40);return h;
}
/** Deduplicate literal overlap, ignoring spacing and punctuation, preserving new text. */
function trimOverlap(previous,text){
 const chars=[...text],tokens=[];let offset=0;
 for(const c of chars){offset+=c.length;if(/[\p{L}\p{N}]/u.test(c))tokens.push({c:c.toLowerCase(),end:offset});}
 const tail=previous.replace(/[^\p{L}\p{N}]/gu,'').toLowerCase().slice(-200),head=tokens.map(x=>x.c).join('');
 for(let n=Math.min(16,tail.length,head.length);n>=2;n--){if(tail.endsWith(head.slice(0,n)))return text.slice(tokens[n-1].end).replace(/^[\p{P}\p{Z}\s]+/u,'');}
 return text;
}
function checkSpeech(result){
 const chars=speechChars(result.segments.map(x=>x.text).join(''));
 if(chars<10||chars/(result.audio_s/60)<8)throw fault('no_speech');return result;
}
function localMetadata(result,chunks=1,meta){return {...result,provider:'local',chunks,cloud_chunks:0,local_chunks:1,units:0,...(meta?{meta}:{})};}

export async function transcribeAudio(wav,options={},deps={}){
 const settings=options.settings||{},provider=settings['asr:provider']??options.provider??'auto',local=deps.local||runAsr;
 if(!cloudAllowed(settings,provider))return localMetadata(await local(wav,options));
 const controller=new AbortController(),signal=controller.signal;
 const abort=()=>controller.abort(fault(options.signal?.reason?.reason||'cancelled'));
 options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
 const timer=setTimeout(()=>controller.abort(fault('media_timeout')),Math.max(1,options.timeoutMs??120000));
 let fd,dir;
 const check=()=>{if(signal.aborted)throw signal.reason;};
 // DS-0 supports a timeout but owns its signal. Merge cancellation at the fetch boundary.
 const doFetch=(url,init={})=>(deps.fetch||globalThis.fetch)(url,{...init,signal:init.signal?AbortSignal.any([signal,init.signal]):signal});
 const bounded=async fn=>{
  check();let rejectAbort;const cancelled=new Promise((_,reject)=>{rejectAbort=()=>reject(signal.reason);signal.addEventListener('abort',rejectAbort,{once:true});});
  try{return await Promise.race([Promise.resolve().then(fn),cancelled]);}finally{signal.removeEventListener('abort',rejectAbort);}
 };
 try{
  check();fd=fs.openSync(wav,'r');const info=wavInfo(fd),chunks=[];
  for(let start=0;start<info.duration;start+=99){chunks.push({start,end:Math.min(start+100,info.duration)});if(start+100>=info.duration)break;}
  dir=fs.mkdtempSync(join(dirname(wav),'asr-'));fs.chmodSync(dir,0o700);
  let callDs=deps.callDs;
  if(!callDs){try{({callDs}=await import('./deepseek-client.mjs'));}catch{
   const meta={reason:'asr_cloud_failed_fallback',error_kinds:['auth']};
   return localMetadata(await bounded(()=>local(wav,{...options,signal})),chunks.length,meta);
  }}
  let cursor=0,completed=0;
  const results=new Array(chunks.length);
  const workers=Array.from({length:Math.min(4,Math.max(1,Math.floor(options.concurrency||4)),chunks.length)},async()=>{
   while(cursor<chunks.length){check();const i=cursor++,chunk=chunks[i],length=Math.round((chunk.end-chunk.start)*RATE),file=join(dir,i+'.wav');
    const bytes=Buffer.concat([waveHeader(length),readExactly(fd,length,info.offset+Math.round(chunk.start*RATE))]);
    if(bytes.length>MAX_BYTES||chunk.end-chunk.start>100)throw fault('asr_failed');
    fs.writeFileSync(file,bytes,{mode:0o600});
    const form=new FormData();form.append('file',new Blob([bytes],{type:'audio/wav'}),'audio.wav');
    let response,requestTimer;
    const requestController=new AbortController(),requestMs=Math.max(1,Math.min(60000,options.cloudTimeoutMs??60000));
    const requestDeadline=new Promise((_,reject)=>{requestTimer=setTimeout(()=>{requestController.abort();reject(fault('cloud_timeout'));},requestMs);});
    const requestFetch=(url,init={})=>doFetch(url,{...init,signal:init.signal?AbortSignal.any([requestController.signal,init.signal]):requestController.signal});
    try{response=await bounded(()=>Promise.race([callDs('asr',{form,timeoutMs:requestMs,keyFile:options.keyFile,fetch:requestFetch}),requestDeadline]));}
    catch(error){check();response={ok:false,error_kind:error.reason==='cloud_timeout'?'timeout':'upstream'};}
    finally{clearTimeout(requestTimer);requestController.abort();}
    check();const text=typeof response?.data?.text==='string'?response.data.text.trim():'';
    if(response?.ok&&text&&!response.data.error){results[i]={text,cloud:true};fs.rmSync(file,{force:true});}
    else results[i]={file,cloud:false,error_kind:response?.error_kind||'upstream'};
    options.onProgress?.({done:++completed,total:chunks.length});
   }
  });
  // All workers settle before cleanup: none can create a slice after finally removes it.
  const settled=await Promise.allSettled(workers);check();const rejected=settled.find(x=>x.status==='rejected');if(rejected)throw rejected.reason;
  const failures=results.filter(r=>!r.cloud),meta=failures.length?{reason:'asr_cloud_failed_fallback',error_kinds:[...new Set(failures.map(r=>r.error_kind))]}:undefined;
  if(failures.length===chunks.length)return localMetadata(await bounded(()=>local(wav,{...options,signal})),chunks.length,meta);
  let max_rss_mb=0,nice=15;
  // Serialize local fallback to keep at most one X-ASR model resident at a time.
  for(let i=0;i<results.length;i++)if(!results[i].cloud){
   const r=await bounded(()=>local(results[i].file,{...options,signal}));check();
   max_rss_mb=Math.max(max_rss_mb,r.max_rss_mb||0);nice=r.nice??nice;
   results[i].segments=r.segments;fs.rmSync(results[i].file,{force:true});
  }
  const segments=[];let previous='';
  for(let i=0;i<results.length;i++){
   const chunk=chunks[i],start=i?chunk.start+1:0;
   const rows=results[i].cloud?[{start:0,end:chunk.end-chunk.start,text:results[i].text}]:results[i].segments;
   let first=true;
   for(const row of rows){const text=first&&i?trimOverlap(previous,row.text):row.text;first=false;if(!text)continue;
    const end=Math.min(chunk.end,chunk.start+row.end),begin=Math.max(start,chunk.start+row.start,segments.at(-1)?.end||0);
    if(end>begin){segments.push({start:begin,end,text});previous=(previous+text).slice(-400);}
   }
  }
  return checkSpeech({segments,audio_s:info.duration,max_rss_mb,nice,provider:failures.length?'mixed':'cloud',chunks:chunks.length,cloud_chunks:chunks.length-failures.length,local_chunks:failures.length,units:chunks.reduce((n,c,i)=>n+(results[i].cloud?c.end-c.start:0),0),...(meta?{meta}:{})});
 }finally{
  clearTimeout(timer);options.signal?.removeEventListener('abort',abort);if(fd!==undefined)fs.closeSync(fd);if(dir)fs.rmSync(dir,{recursive:true,force:true});
 }
}
