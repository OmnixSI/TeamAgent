import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as adapter from './cloud-asr.mjs';
import {runMediaJob} from './media.mjs';

function fixture(seconds=220){
 const dir=fs.mkdtempSync(join(tmpdir(),'f9ds-1b-test-')),wav=join(dir,'a.wav');
 const pcm=Buffer.alloc(seconds*32000),h=Buffer.alloc(44);
 h.write('RIFF');h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
 fs.writeFileSync(wav,Buffer.concat([h,pcm]));return {dir,wav,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
const local=async(wav)=>({audio_s:(fs.statSync(wav).size-44)/32000,segments:[{start:0,end:(fs.statSync(wav).size-44)/32000,text:'本机 API 转写结果超过十个字符。'}],max_rss_mb:300,nice:15});
const ok=text=>({ok:true,data:{text},status:200,latency_ms:1});

test('normalized PCM is split at 100 seconds with one-second overlap, bounded uploads and ordered timestamps',async()=>{
 const t=fixture();try{
  assert.equal(typeof adapter.transcribeAudio,'function');
  let active=0,peak=0,n=0;const progress=[];
  const r=await adapter.transcribeAudio(t.wav,{timeoutMs:1000,onProgress:p=>progress.push(p.done)},{local,callDs:async(p,o)=>{
   assert.equal(p,'asr');const bytes=Buffer.from(await o.form.get('file').arrayBuffer());
   assert.equal(bytes.readUInt32LE(24),16000);assert.equal(bytes.readUInt16LE(22),1);assert.ok(bytes.length<=8*1024**2);
   assert.ok((bytes.length-44)/32000<=100);const id=n++;active++;peak=Math.max(peak,active);
   await new Promise(r=>setTimeout(r,(3-id)*3));active--;return ok(['今天详细介绍 API 和 X-ASR。','X-ASR。云端速度更快而且不用本机内存。','不用本机内存。最后验证完成。'][id]);
  }});
  assert.equal(peak,3);assert.equal(r.audio_s,220);assert.equal(r.provider,'cloud');assert.equal(r.cloud_chunks,3);assert.equal(r.local_chunks,0);assert.equal(r.units,222);assert.deepEqual(progress,[1,2,3]);
  assert.deepEqual(r.segments.map(x=>x.start),[0,100,199]);assert.deepEqual(r.segments.map(x=>x.text),['今天详细介绍 API 和 X-ASR。','云端速度更快而且不用本机内存。','最后验证完成。']);assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);
 }finally{t.clean()}
});
test('parallel requests are capped at four regardless of configuration',async()=>{
 const t=fixture(600);try{let active=0,peak=0;await adapter.transcribeAudio(t.wav,{concurrency:99},{local,callDs:async()=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,3));active--;return ok('每个音频片段都有正常的中文和 English。')}});assert.equal(peak,4);}finally{t.clean()}
});
test('one failed chunk falls back locally and reports only cloud seconds for accounting',async()=>{
 const t=fixture();try{let n=0;const r=await adapter.transcribeAudio(t.wav,{}, {local,callDs:async()=>++n===2?{ok:false,error_kind:'quota'}:ok('正常云端转写超过十个字的结果。')});
  assert.equal(r.provider,'mixed');assert.equal(r.cloud_chunks,2);assert.equal(r.local_chunks,1);assert.equal(r.units,122);assert.equal(r.meta.reason,'asr_cloud_failed_fallback');assert.deepEqual(r.meta.error_kinds,['quota']);assert.equal(r.segments[1].start,100);assert.match(r.segments[1].text,/本机/);assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);
 }finally{t.clean()}
});
test('timeout, budget, upstream and auth all keep the local fallback usable',async()=>{
 const t=fixture(22);try{for(const error_kind of ['timeout','budget','upstream','auth']){const r=await adapter.transcribeAudio(t.wav,{}, {local,callDs:async()=>({ok:false,error_kind})});assert.equal(r.provider,'local');assert.deepEqual(r.meta.error_kinds,[error_kind]);}}finally{t.clean()}
});
test('local fallback is serial even when all but one cloud chunk fail',async()=>{
 const t=fixture(400);try{let n=0,active=0,peak=0;const r=await adapter.transcribeAudio(t.wav,{}, {callDs:async()=>++n===1?ok('第一片云端识别包含足够多的文字供正常语音检测。'):{ok:false,error_kind:'quota'},local:async w=>{peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,3));active--;const r=await local(w);r.segments[0].text='本机顺序转写识别这一段完整的音频内容，每一段都有足够多的正常文字作为语音证据。';return r}});assert.equal(r.local_chunks,4);assert.equal(peak,1);assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);}finally{t.clean()}
});
test('all cloud chunks failing runs one whole-file X-ASR fallback',async()=>{
 const t=fixture();try{const inputs=[];const r=await adapter.transcribeAudio(t.wav,{}, {local:async(w,o)=>{inputs.push(w);return local(w,o)},callDs:async()=>({ok:false,error_kind:'upstream'})});assert.deepEqual(inputs,[t.wav]);assert.equal(r.provider,'local');assert.equal(r.local_chunks,1);assert.equal(r.units,0);assert.equal(r.chunks,3);assert.equal(r.cloud_chunks,0);}finally{t.clean()}
});
test('local selection and auto off/budget/quota gates never upload',async()=>{
 const t=fixture();try{for(const settings of [{'asr:provider':'local'},{'off:ds_asr':'1'},{'off:dstools':'1'},{'ds:asr:user_daily':0},{'ds:asr:group_daily':2,'ds:asr:group_used':2},{'ds:daily_cap_micro_usd':0}]){
  const r=await adapter.transcribeAudio(t.wav,{settings},{local,callDs:()=>assert.fail('gated request uploaded')});assert.equal(r.provider,'local');assert.equal(r.units,0);
 }}finally{t.clean()}
});
test('aborting a fetch cancels in-flight uploads, skips fallback and removes slices',async()=>{
 const t=fixture();try{const controller=new AbortController();let signals=[];
  const pending=adapter.transcribeAudio(t.wav,{signal:controller.signal,timeoutMs:500},{local:()=>assert.fail('cancelled ASR started local'),callDs:async(_p,o)=>{await o.fetch('https://api.deepseek.com/v1/tools/asr',{signal:new AbortController().signal});return ok('unreachable')},fetch:async(_u,o)=>{signals.push(o.signal);return new Promise((_,reject)=>o.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});
  setTimeout(()=>controller.abort(),5);await assert.rejects(pending,e=>e.reason==='cancelled');assert.ok(signals.length>0);assert.ok(signals.every(s=>s.aborted));assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);
 }finally{t.clean()}
});
test('hard deadline bounds hanging cloud calls and cleans slices',async()=>{
 const t=fixture();try{await assert.rejects(adapter.transcribeAudio(t.wav,{timeoutMs:5},{local,callDs:()=>new Promise(()=>{})}),e=>e.reason==='media_timeout');assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);}finally{t.clean()}
});
test('per-request deadline also bounds stalled body parsing and falls back before the job deadline',async()=>{
 const t=fixture(22);try{const r=await adapter.transcribeAudio(t.wav,{timeoutMs:200,cloudTimeoutMs:5},{local,callDs:()=>new Promise(()=>{})});assert.equal(r.provider,'local');assert.deepEqual(r.meta.error_kinds,['timeout']);assert.deepEqual(fs.readdirSync(t.dir),['a.wav']);}finally{t.clean()}
});
test('invalid cloud text is a failed chunk; silence or malformed WAV never produces invented success',async()=>{
 const t=fixture();try{const r=await adapter.transcribeAudio(t.wav,{}, {local,callDs:async()=>ok('')});assert.equal(r.provider,'local');fs.writeFileSync(t.wav,'invalid');await assert.rejects(adapter.transcribeAudio(t.wav,{}, {local,callDs:()=>assert.fail('invalid audio uploaded')}),e=>e.reason==='asr_failed');}finally{t.clean()}
});
test('media pipeline uses job settings and attaches provider/counts/seconds without changing timed text',async()=>{
 const t=fixture(22);try{
  const bvid='BV1irWP6PExT',j={id:'bmedia-'+bvid,kind:'bili_media',payload:{bvid,duration:22,until:Date.now()+1000,lease:'test',settings:{'asr:provider':'cloud'}}};
  const r=await runMediaJob(j,{home:t.dir,client:{isPaused:()=>false,sanitize:x=>x,biliAudio:async()=>({duration:22,urls:[{baseUrl:'https://audio.bilivideo.com/a.m4a'}]})},download:async(_u,p)=>fs.writeFileSync(p,'a'),ffmpeg:async(_u,p)=>fs.copyFileSync(t.wav,p),callDs:async()=>ok('这个 API 的 TTS 延迟大概两秒，比本机 X-ASR 慢一点，但不用占 500MB 内存。'),asr:()=>assert.fail('cloud job used local')});
  assert.equal(r.report.success,true);assert.equal(r.report.result.provider,'cloud');assert.equal(r.report.result.cloud_chunks,1);assert.equal(r.report.result.units,22);assert.match(r.report.result.text,/^\[00:00\] 这个 API/);assert.equal(r.cleanup.residue,0);
 }finally{t.clean()}
});
