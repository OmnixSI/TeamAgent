import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn,execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {Readable} from 'node:stream';
import {validateTeamConfig} from '../config/validate.mjs';
import {pickAudio,downloadAudio,ffmpegArgs,ffmpegAudio,runMediaJob,redactUrl,startupGate,sweepLocal,acquireLock,sendReport,flushReports,runCycle,makeClient} from './media.mjs';
import {classifyMedia,createFetchClient} from './fetcher.mjs';
const BV='BV1GN4p6pEEP',cdn='https://audio.bilivideo.com/a?upsig=hidden&mid=123';
const temporary=()=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'media-test-'));return {home,clean:()=>fs.rmSync(home,{recursive:true,force:true})}};
const job=()=>({id:'bmedia-'+BV,kind:'bili_media',payload:{bvid:BV,duration:120,until:Date.now()+60000,lease:'synthetic-lease'}});
function stages(home,extra={}){
 return {home,asrConfig:{python:'/python',model_dir:'/models'},client:{isPaused:()=>false,sanitize:x=>x,biliAudio:async()=>({duration:120,cid:1,urls:[{bandwidth:1,baseUrl:cdn,backupUrl:[]}]})},download:async(_u,dest)=>fs.writeFileSync(dest,'audio'),ffmpeg:async(_s,d)=>fs.writeFileSync(d,'wave'),asr:async()=>({segments:[{start:0,end:120,text:'这是超过十个字的一段中文转写文本。'}],audio_s:120,max_rss_mb:200,nice:15}),cloud:async()=>({status:200}),...extra};
}
function network(replies,lookupAddress='8.8.8.8'){
 const calls=[];return {calls,lookup:(_host,_opts,cb)=>cb(null,[{address:lookupAddress,family:4}]),request(options,cb){const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>options.lookup(options.host,{},err=>{if(err){req.emit('error',err);return;}calls.push(options);const r=replies(calls.length);const res=Readable.from(r.body||[Buffer.from('audio')]);res.statusCode=r.status||200;res.headers=r.headers||{};cb(res)}));return req}};
}
test('R1 select the lowest audio bandwidth, validate backups, never select a video stream',()=>{
 const audio=[{bandwidth:9,baseUrl:'https://evil.example/audio',backupUrl:['https://safe.bilivideo.cn/audio']},{bandwidth:1,baseUrl:'https://a.bilivideo.com:4483/bad',backupUrl:[cdn]}];
 assert.deepEqual(pickAudio(audio),[cdn]);assert.deepEqual(pickAudio({audio,get video(){throw Error('video accessed')}}),[cdn]);assert.throws(()=>pickAudio([{baseUrl:'https://evil.example/a'}]),e=>e.reason==='audio_unavailable');
});
test('R2 bounded audio downloads carry Referer but never Cookie and redact failures',async()=>{
 const t=temporary();try{
  const d=network(()=>({body:[Buffer.alloc(8)]}));await downloadAudio(cdn,path.join(t.home,'a.m4a'),{...d,maxBytes:8});assert.equal(d.calls[0].headers.Referer,'https://www.bilibili.com/');assert.equal(d.calls[0].headers.Cookie,undefined);assert.equal(d.calls[0].headers.Range,'bytes=0-');
  await assert.rejects(downloadAudio(cdn,path.join(t.home,'big'),{...network(()=>({body:[Buffer.alloc(9)]})),maxBytes:8}),e=>e.reason==='download_failed'&&!/upsig|hidden|mid=/.test(String(e)));
 }finally{t.clean()}
});
test('R2 an entire ranged audio response is accepted; partial and truncated responses are rejected',async()=>{
 const t=temporary();try{
  await downloadAudio(cdn,path.join(t.home,'full'),{...network(()=>({status:206,headers:{'content-range':'bytes 0-7/8'},body:[Buffer.alloc(8)]})),maxBytes:8});
  for(const [label,range,body]of [['partial','bytes 0-3/8',4],['offset','bytes 4-7/8',4],['truncated','bytes 0-7/8',4]])await assert.rejects(downloadAudio(cdn,path.join(t.home,label),network(()=>({status:206,headers:{'content-range':range},body:[Buffer.alloc(body)]}))),e=>e.reason==='download_failed');
 }finally{t.clean()}
});
test('R2 CDN regression: full-stream Range and browser UA must be sent together without Cookie',async()=>{
 const t=temporary();try{
  // The real CDN rejected curl + an open-ended range, but returned the entire
  // 206 audio object for the same request with a browser user agent.
  const d=network(()=>{
   const headers=d.calls.at(-1).headers;
   return /^Mozilla\/5\.0 /.test(headers['User-Agent'])&&headers.Range==='bytes=0-'
    ?{status:206,headers:{'content-range':'bytes 0-7/8','content-length':'8'},body:[Buffer.from('audio123')]}
    :{status:403,body:[]};
  });
  const dest=path.join(t.home,'a.m4a');await downloadAudio(cdn,dest,d);
  assert.equal(fs.readFileSync(dest,'utf8'),'audio123');assert.equal(d.calls.length,1);
  assert.equal(d.calls[0].headers.Cookie,undefined);assert.equal(d.calls[0].headers.Referer,'https://www.bilibili.com/');
 }finally{t.clean()}
});
test('R3 media API return codes distinguish login, missing and paid playback',()=>{
 for(const [code,reason] of [[-101,'login_required'],[-404,'not_found'],[62002,'not_found'],[-10403,'paid'],[87007,'paid'],[87008,'paid']])assert.equal(classifyMedia(code),reason);
});
test('R4 ffmpeg uses array arguments, audio-only PCM and a minimal low-priority child environment',async()=>{
 const args=ffmpegArgs('/tmp/task/a.m4a','/tmp/task/a.wav',90);assert.ok(args.includes('-vn'));assert.deepEqual(args.slice(args.indexOf('-ac'),args.indexOf('-ac')+6),['-ac','1','-ar','16000','-c:a','pcm_s16le']);assert.equal(args[args.indexOf('-t')+1],'5400');
 let call,priority;await ffmpegAudio('/tmp/task/a.m4a','/tmp/task/a.wav',{maxMinutes:90,signal:new AbortController().signal},{spawn:(command,argv,options)=>{call={command,argv,options};const c=new EventEmitter();c.pid=43121;c.stdout=new EventEmitter();c.stderr=new EventEmitter();queueMicrotask(()=>c.emit('close',0));return c},setPriority:(...v)=>priority=v,getPriority:()=>15});
 assert.deepEqual(call.argv,args);assert.deepEqual(Object.keys(call.options.env).sort(),['HOME','LANG','PATH']);assert.equal(call.options.detached,true);assert.deepEqual(priority,[43121,15]);
});
test('R6/R7 normal and partial jobs return timed text and clean every artifact before reporting',async()=>{
 for(const duration of [120,7200]){const t=temporary();try{
  const j=job();j.payload.duration=duration;const d=stages(t.home,{client:{isPaused:()=>false,sanitize:x=>x,biliAudio:async()=>({duration,cid:1,urls:[{baseUrl:cdn}]})},asr:async()=>({segments:[{start:0,end:Math.min(duration,5400),text:'这是超过十个字的一段中文转写文本。'}],audio_s:Math.min(duration,5400),max_rss_mb:300,nice:15})});
  const value=await runMediaJob(j,d);assert.equal(value.report.success,true);assert.match(value.report.result.text,/\[00:00\]/);assert.equal(value.report.result.covered,Math.min(duration,5400));assert.equal(value.report.result.partial,duration>5400);assert.equal(value.cleanup.residue,0);assert.deepEqual(fs.readdirSync(path.join(t.home,'media-tmp')),[]);
 }finally{t.clean()}}
});
test('R6 failure also cleans and R8 scrubber removes signed URL query/fragment without leaking Cookie values',async()=>{
 const t=temporary();try{const r=await runMediaJob(job(),stages(t.home,{asr:async()=>{throw Object.assign(Error('bad'),{reason:'asr_failed'})}}));assert.equal(r.report.reason,'asr_failed');assert.equal(r.cleanup.residue,0);assert.deepEqual(fs.readdirSync(path.join(t.home,'media-tmp')),[]);}finally{t.clean()}
 assert.equal(redactUrl('see '+cdn+'#fragment'),'see https://audio.bilivideo.com/a');
});
test('R14 heartbeat is independent of progress; 409 aborts any stage and does not report',async()=>{
 for(const stage of ['download','ffmpeg','asr']){const t=temporary();try{
  let tick;const controller=new AbortController();const d=stages(t.home,{signal:controller.signal,setInterval:fn=>{tick=fn;return 1},clearInterval(){},cloud:async()=>({status:409})});
  d[stage]=async(...args)=>{await tick();throw Object.assign(Error('aborted'),{reason:'cancelled'})};
  const result=await runMediaJob(job(),d);assert.equal(result.report,null);assert.equal(result.cleanup.residue,0);
 }finally{t.clean()}}
});
test('R15 report spooling retries three times, stays private, replays and drops stale leases',async()=>{
 const t=temporary();try{
  let attempts=0;const report={id:'bmedia-'+BV,lease:'old',success:true,result:{bvid:BV,text:'transcript',covered:1,duration:1,partial:false,chunks:1},cleanup:{residue:0,paths:[]}};
  await sendReport(report,{home:t.home,cloud:async()=>{attempts++;throw Error('offline')},sleep:async()=>{}});assert.equal(attempts,3);
  const p=path.join(t.home,'media-reports',report.id+'.json');assert.equal(fs.statSync(p).mode&0o777,0o600);assert.doesNotMatch(fs.readFileSync(p,'utf8'),/http/);
  await flushReports({home:t.home,cloud:async()=>({status:409}),sleep:async()=>{}});assert.equal(fs.existsSync(p),false);
 }finally{t.clean()}
});
test('R15 replayed bvid uses its new lease without repeating audio or recognition',async()=>{
 const t=temporary();try{
  const j=job();await sendReport({id:j.id,lease:'old',success:false,reason:'asr_failed',cleanup:{residue:0,paths:[]}},{home:t.home,cloud:async()=>{throw Error('offline')},sleep:async()=>{}});
  let claimed=0,downloaded=0,latest;const d=stages(t.home,{gate:()=>({ok:true}),claim:async()=>claimed++?null:j,cloud:async(_p,b)=>{latest=b;return {status:200}},download:async()=>{downloaded++},sleep:async()=>{}});
  // Keep the pending receipt through initial flush; the fresh claim must replace its lease.
  d.cloud=async(p,b)=>{if(b.lease==='old')throw Error('offline');latest=b;return {status:200}};
  await runCycle(d);assert.equal(downloaded,0);assert.equal(latest.lease,j.payload.lease);
 }finally{t.clean()}
});
test('R16 deadlines stop a job with media_timeout and leave no directory',async()=>{
 const t=temporary();try{const j=job();j.payload.until=1;const r=await runMediaJob(j,stages(t.home));assert.equal(r.report.reason,'media_timeout');assert.equal(r.cleanup.residue,0);}finally{t.clean()}
});
test('R17 every redirect is checked for scheme, port, DNS and hop count before download',async()=>{
 const t=temporary();try{
  for(const target of ['https://evil.example/a','http://a.bilivideo.com/a','https://a.bilivideo.com:8080/a','https://127.0.0.1/a']){
   const d=network(()=>({status:302,headers:{location:target}}));await assert.rejects(downloadAudio(cdn,path.join(t.home,'a'),d),e=>e.reason==='download_failed');assert.equal(d.calls.length,1);
  }
  const d=network(n=>({status:302,headers:{location:'https://a.bilivideo.com/'+n}}));await assert.rejects(downloadAudio(cdn,path.join(t.home,'a'),d));assert.equal(d.calls.length,4);
  const privateDns=network(()=>({}),'10.0.0.1');await assert.rejects(downloadAudio(cdn,path.join(t.home,'a'),privateDns));assert.equal(privateDns.calls.length,0);
 }finally{t.clean()}
});
test('R18/R19 read-only cookie loading feeds API headers only, and paused clients make no request',async()=>{
 const t=temporary();try{
  fs.mkdirSync(path.join(t.home,'secrets'));fs.writeFileSync(path.join(t.home,'secrets/bili-cookie.json'),JSON.stringify({SESSDATA:{value:'synthetic-cookie-value',expires:4102444800}}));
  const calls=[];const client=await makeClient(t.home,{createFetchClient:options=>{calls.push(options);return {}}});assert.equal(calls[0].cookies.SESSDATA,'synthetic-cookie-value');
  const r=await runMediaJob(job(),stages(t.home,{client:{isPaused:()=>true}}));assert.equal(r.report.reason,'risk');
 }finally{t.clean()}
});
test('R21 runtime sources never acquire models and requirements pins the installed ASR runtime',()=>{
 const forbidden=new RegExp(['whis'+'per','hugging'+'face','hf_'+'hub','model'+'scope','from_'+'pretrained'].join('|'),'i');
 for(const file of fs.readdirSync(new URL('./',import.meta.url)))if(/\.(mjs|py)$/.test(file)&&!file.startsWith('test_'))assert.doesNotMatch(fs.readFileSync(new URL(file,import.meta.url),'utf8'),forbidden,file);
 assert.equal(fs.readFileSync(new URL('requirements-xasr.txt',import.meta.url),'utf8').trim(),'sherpa-onnx==1.13.8');
});
test('R22 lock exclusion, stale recovery and orphan directory cleanup leave no marker',async()=>{
 const t=temporary();try{
  const release=acquireLock(t.home);assert.ok(release);assert.equal(acquireLock(t.home),null);release();
  fs.mkdirSync(path.join(t.home,'media.lock'));fs.utimesSync(path.join(t.home,'media.lock'),new Date(0),new Date(0));const next=acquireLock(t.home);assert.ok(next);next();
  fs.mkdirSync(path.join(t.home,'media-tmp/orphan'),{recursive:true});fs.writeFileSync(path.join(t.home,'media-tmp/orphan/a.m4a'),'audio');
  fs.mkdirSync(path.join(t.home,'media-reports'));const old=path.join(t.home,'media-reports/old.json');fs.writeFileSync(old,'{}');fs.utimesSync(old,new Date(0),new Date(0));
  fs.writeFileSync(path.join(t.home,'media.log'),Buffer.alloc(2*1024*1024));await sweepLocal(t.home);assert.deepEqual(fs.readdirSync(path.join(t.home,'media-tmp')),[]);assert.equal(fs.existsSync(old),false);assert.equal(fs.statSync(path.join(t.home,'media.log')).size,0);
 }finally{t.clean()}
});
test('R22 resource gate rejects pressure before claiming and each cycle processes at most 3 jobs',async()=>{
 const t=temporary();try{
  for(const deps of [{memory:()=>10,free:()=>4e9,tmp:()=>0},{memory:()=>50,free:()=>1e9,tmp:()=>0},{memory:()=>50,free:()=>4e9,tmp:()=>2*1024**3}])assert.equal(startupGate(t.home,deps).ok,false);
  let claims=0;await runCycle(stages(t.home,{gate:()=>({ok:true}),claim:async()=>{claims++;return job()}}));assert.equal(claims,3);
 }finally{t.clean()}
});
test('R22 m4a is removed before ASR and wav is removed before report',async()=>{
 const t=temporary();try{await runMediaJob(job(),stages(t.home,{asr:async wav=>{assert.equal(fs.existsSync(path.join(path.dirname(wav),'a.m4a')),false);return {segments:[{start:0,end:1,text:'这是超过十个字的合成转写结果。'}],audio_s:1,max_rss_mb:200,nice:15}}}));assert.deepEqual(fs.readdirSync(path.join(t.home,'media-tmp')),[]);}finally{t.clean()}
});


test('R8 reports redact synthetic Cookie values and remove signed URL queries before spooling',async()=>{
 const t=temporary();try{
  const client=createFetchClient({cookies:{SESSDATA:'synthetic-secret-cookie'}});
  await sendReport({id:'bmedia-'+BV,lease:'L',success:true,result:{text:'synthetic-secret-cookie '+cdn},cleanup:{residue:0,paths:[]}},{home:t.home,client,cloud:async()=>{throw Error('offline')},sleep:async()=>{}});
  const text=fs.readFileSync(path.join(t.home,'media-reports','bmedia-'+BV+'.json'),'utf8');assert.match(text,/\*\*\*/);assert.doesNotMatch(text,/synthetic-secret-cookie|upsig|mid=|http/);
 }finally{t.clean()}
});
test('R13 flat copied adapter resolves its adjacent Python entrypoint from an unrelated cwd',()=>{
 const t=temporary();try{
  fs.copyFileSync(new URL('./asr.mjs',import.meta.url),path.join(t.home,'asr.mjs'));
  const source=pathToFileURL(path.join(t.home,'asr.mjs')).href;
  const actual=execFileSync(process.execPath,['--input-type=module','-e',`import {SCRIPT} from ${JSON.stringify(source)};process.stdout.write(SCRIPT)`],{cwd:os.tmpdir(),encoding:'utf8'});
  assert.equal(actual,path.join(fs.realpathSync(t.home),'xasr_transcribe.py'));
 }finally{t.clean()}
});
test('R18 audio API is two read requests, never prepares authentication, and never returns video',async()=>{
 const calls=[];const client=createFetchClient({cookies:{SESSDATA:'synthetic-session'},sleep:async()=>{},request(options,cb){
  calls.push(options);const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
   const data=options.path.startsWith('/x/web-interface/view')?{code:0,data:{cid:1,duration:120,pic:'cover'}}:{code:0,data:{dash:{audio:[{bandwidth:12,baseUrl:cdn}],video:[{baseUrl:'https://video.bilivideo.com/video.mp4'}]}}};
   const response=Readable.from([Buffer.from(JSON.stringify(data))]);response.statusCode=200;response.headers={};cb(response);
  });return req;}});
 const info=await client.biliAudio(BV);assert.equal(calls.length,2);assert.ok(calls.every(c=>c.host==='api.bilibili.com'&&c.headers.Cookie.includes('synthetic-session')));assert.ok(calls[1].path.includes('fnval=16'));assert.deepEqual(info.urls,[{bandwidth:12,baseUrl:cdn}]);
 assert.ok(calls.every(c=>!/nav|finger|passport/.test(c.path)));
});
test('R22 startup kills a real detached orphan process and preserves unrelated runtime files',async()=>{
 const t=temporary();let child;try{
  fs.writeFileSync(path.join(t.home,'unrelated'),'keep');child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','xasr_transcribe-fixture'],{detached:true,stdio:'ignore'});await new Promise(r=>child.once('spawn',r));
  const exited=new Promise(resolve=>child.once('exit',(_code,signal)=>resolve(signal)));fs.writeFileSync(path.join(t.home,'media-child.pid'),String(child.pid));
  await sweepLocal(t.home);assert.equal(await exited,'SIGKILL');assert.equal(fs.existsSync(path.join(t.home,'media-child.pid')),false);assert.equal(fs.readFileSync(path.join(t.home,'unrelated'),'utf8'),'keep');
 }finally{if(child?.pid)try{process.kill(-child.pid,'SIGKILL')}catch{}t.clean()}
});
test('R14/R22 a lease conflict kills an active child group and SIGTERM still clears outputs',async()=>{
 for(const mode of ['conflict','term']){const t=temporary();try{
  let tick;const kills=[];const d=stages(t.home,{setInterval:fn=>{tick=fn;return 1},clearInterval(){},cloud:async()=>({status:409})});
  d.ffmpeg=(src,dst,options)=>ffmpegAudio(src,dst,options,{spawn(){const c=new EventEmitter();c.pid=43132;c.stdout=new EventEmitter();c.stderr=new EventEmitter();queueMicrotask(()=>{if(mode==='term')process.emit('SIGTERM');else tick()});return c},setPriority(){},getPriority:()=>15,kill:(...args)=>kills.push(args)});
  const value=await runMediaJob(job(),d);assert.deepEqual(kills,[[-43132,'SIGKILL']]);assert.equal(value.cleanup.residue,0);assert.equal(fs.existsSync(path.join(t.home,'media-child.pid')),false);assert.deepEqual(fs.readdirSync(path.join(t.home,'media-tmp')),[]);
  if(mode==='conflict')assert.equal(value.report,null);else assert.equal(value.report.reason,'media_timeout');
 }finally{t.clean()}}
});

test('PR-A configuration defaults off and validates all resource caps',()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../config/team.json',import.meta.url),'utf8'));assert.equal(config.bili.media.enabled,false);assert.equal(config.bili.media.mem_cap_mb,1300);assert.equal(validateTeamConfig(config).length,0);
 for(const key of ['max_minutes','rtf','deadline_cap_minutes','mem_cap_mb','tmp_cap_mb']){const c=structuredClone(config);c.bili.media[key]=0;assert.ok(validateTeamConfig(c).includes('bili.media.'+key));}
 const c=structuredClone(config);c.bili.media.enabled=1;assert.ok(validateTeamConfig(c).includes('bili.media.enabled'));
});
