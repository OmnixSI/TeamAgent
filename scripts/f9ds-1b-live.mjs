/** Read-only, one-audio-file live comparison. No Worker, D1 or QQ requests. */
import fs from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {makeClient,pickAudio,downloadAudio,ffmpegAudio} from '../runner/media.mjs';
import {runAsr,runCommand} from '../runner/asr.mjs';
import {transcribeAudio} from '../runner/cloud-asr.mjs';

const dir=fs.mkdtempSync(join(tmpdir(),'f9ds-1b-live-'));
const source=join(dir,'audio.m4a'),wav=join(dir,'audio.wav'),long=join(dir,'long.wav');
const options={python:join(homedir(),'.inkboard-team/xasr-venv/bin/python'),modelDir:join(homedir(),'Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03'),timeoutMs:120000,signal:AbortSignal.timeout(180000)};
let cost=0;
function reserve(amount){if(cost+amount>0.05)throw Error('budget');cost+=amount;}
const summarize=(r,ms)=>({ms,provider:r.provider,chunks:r.chunks,cloud_chunks:r.cloud_chunks,local_chunks:r.local_chunks,units:r.units,chars:r.segments.map(x=>x.text).join('').length,head:r.segments.map(x=>x.text).join('').slice(0,100),timestamps:r.segments.map(x=>x.start),max_rss_mb:r.max_rss_mb});
try{
 const {callDs}=await import(process.env.F9DS_CLIENT_MODULE?pathToFileURL(process.env.F9DS_CLIENT_MODULE).href:new URL('../runner/deepseek-client.mjs',import.meta.url).href);
 const billedCall=async(p,o)=>{
  const bytes=Buffer.from(await o.form.get('file').arrayBuffer());
  const seconds=(bytes.length-44)/32000;reserve(seconds*0.058/3600);
  if(bytes.length>8*1024**2||seconds>100)throw Error('too_large');
  return callDs(p,o);
 };
 const client=await makeClient(join(homedir(),'.inkboard-team'));
 const info=await client.biliAudio('BV1irWP6PExT');if(!info.duration||info.duration>120)throw Error('sample_too_long');
 await downloadAudio(pickAudio(info.urls)[0],source,{signal:options.signal,timeoutMs:60000,maxBytes:8*1024**2});
 const sourceBytes=fs.statSync(source).size,sourceSha256=createHash('sha256').update(fs.readFileSync(source)).digest('hex');
 await ffmpegAudio(source,wav,{maxMinutes:2,signal:options.signal});fs.rmSync(source);
 const rows={bvid:'BV1irWP6PExT',source_bytes:sourceBytes,source_sha256:sourceSha256,downloaded_audio_files:1,qq_real_sends:0,online_d1_rows_written:0};
 for(const provider of ['cloud','local']){
  const start=Date.now(),r=await transcribeAudio(wav,{...options,provider},{callDs:billedCall});
  rows[provider]=summarize(r,Date.now()-start);
  if(r.provider!==provider)throw Error('unexpected_'+r.provider+'_fallback');
 }
 const loop=await runCommand('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-stream_loop','5','-i',wav,'-vn','-ac','1','-ar','16000','-c:a','pcm_s16le','-t','119','-y',long],{timeoutMs:30000,signal:options.signal});if(loop.code)throw Error('ffmpeg_failed');
 const start=Date.now(),r=await transcribeAudio(long,{...options,provider:'cloud'},{callDs:billedCall});rows.long=summarize(r,Date.now()-start);
 if(r.audio_s<=100||r.cloud_chunks<2||r.local_chunks)throw Error('long_chunk_validation_failed');
 const sentence='这个 API 的 TTS 延迟大概两秒，比本机 X-ASR 慢一点，但不用占 500MB 内存。';
 reserve([...sentence].length*2*0.225/10000);
 const tts=await callDs('tts',{json:{text:sentence,voice_id:'stella',format:'wav',filter_markdown:true},expect:'bytes',timeoutMs:30000});
 if(!tts.ok)throw Error(tts.error_kind);const mixedSource=join(dir,'mixed-source.wav'),mixed=join(dir,'mixed.wav');fs.writeFileSync(mixedSource,tts.bytes,{mode:0o600});await ffmpegAudio(mixedSource,mixed,{maxMinutes:1,signal:options.signal});
 const mixedStarted=Date.now(),mixedResult=await transcribeAudio(mixed,{...options,provider:'cloud'},{callDs:billedCall});rows.mixed={reference:sentence,...summarize(mixedResult,Date.now()-mixedStarted)};
 rows.estimated_usd=Number(cost.toFixed(6));fs.rmSync(dir,{recursive:true,force:true});rows.cleanup_residue=Number(fs.existsSync(dir));
 console.log(JSON.stringify(rows,null,2));
}catch(error){console.error(JSON.stringify({error_kind:error.reason||(['budget','too_large'].includes(error.message)?error.message:'live_failed'),estimated_usd:Number(cost.toFixed(6)),qq_real_sends:0,online_d1_rows_written:0}));process.exitCode=1;}
finally{fs.rmSync(dir,{recursive:true,force:true});}
