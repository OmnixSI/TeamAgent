import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import fs,{readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runJob} from '../runner/fetcher.mjs';
import {runMediaJob} from '../runner/media.mjs';
import {twoPages} from './fixtures/bili-pages.mjs';
import {env} from './support.mjs';

const out=`.wrangler/c1b-media-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/mediajobs";export * as fetchjobs from "./src/fetchjobs";export {TEAM} from "./src/config";',resolveDir:process.cwd(),loader:'ts'},bundle:true,format:'esm',platform:'browser',outfile:out});
const media=await import('../'+out),{planVideo}=media;
const BV='BV1xx411c7mD';
const fixture=JSON.parse(readFileSync('test/fixtures/bili-asr-no-transcript-7cc3d8d.json','utf8')).cases[0].result;

test('C1b page two without subtitles never reads the first-page legacy ASR cache',async()=>{
  const e=env(),now=Date.now(),firstPageText='FIRST_PAGE_ONLY_TRANSCRIPT';
  await e.DB.prepare('INSERT INTO media_notes VALUES(?,?,?)').bind('asr:'+BV,JSON.stringify({bvid:BV,text:firstPageText,covered:60,duration:60,partial:false,chunks:1}),new Date(now).toISOString()).run();
  const plan=await planVideo(e,{...fixture,bvid:BV,page:2,pages:2,title:'第二 P',subtitle_status:'none',duration:60},BV+'~p2','light',now);
  const read_cached_first_page_transcript=plan.materials.some(text=>text.includes(firstPageText));
  console.log(JSON.stringify({requested_page:2,read_cached_first_page_transcript,material_count:plan.materials.length,QQ_real_sends:0,production_D1_rows_written:0}));
  assert.equal(read_cached_first_page_transcript,false);
});

const cache=async(e,id,value)=>e.DB.prepare('INSERT OR REPLACE INTO media_notes VALUES(?,?,?)').bind(id,JSON.stringify(value),new Date().toISOString()).run();
const note=async(e,id)=>{const row=await e.DB.prepare('SELECT body FROM media_notes WHERE id=?').bind(id).first();return row?JSON.parse(row.body):null;};
const light=page=>({...fixture,bvid:BV,page,pages:2,cid:page===1?101:202,subtitle_status:'none',duration:60});
const asr=(page,text)=>({bvid:BV,page,cid:page===1?101:202,text,covered:60,duration:60,partial:false,chunks:1});
const jobId=page=>'bmedia-'+BV+(page>1?'-p'+page:'');
async function seedJob(e,page=1,legacy=false){
 const id=jobId(page),lease='lease-'+page;
 await e.DB.prepare("INSERT INTO jobs(id,kind,payload,status,lease_until,created_at) VALUES(?,'bili_media',?,'running',?,?)").bind(id,JSON.stringify({bvid:BV,...(legacy?{}:{v:2,page,cid:page===1?101:202}),waiters:[],lease}),Date.now()+180000,Date.now()).run();
 return {id,lease};
}

test('C1b page two uses only its own ASR while page one and legacy light still use the old key',async()=>{
 const e=env();await cache(e,'asr:'+BV,asr(1,'FIRST_PAGE'));await cache(e,'asr:'+BV+':p:2',asr(2,'SECOND_PAGE'));
 for(const page of [1,2]){const plan=await planVideo(e,light(page),BV+(page>1?'~p2':''),'light',Date.now());assert.match(plan.materials.join(''),page===1?/FIRST_PAGE/:/SECOND_PAGE/);assert.doesNotMatch(plan.materials.join(''),page===1?/SECOND_PAGE/:/FIRST_PAGE/);}
 const {page,cid,...legacyLight}=light(1);const plan=await planVideo(e,legacyLight,BV,'light',Date.now());assert.match(plan.materials.join(''),/FIRST_PAGE/);
});
test('C1b legacy ASR without page or cid remains usable by first-page requests',async()=>{
 const e=env(),{page,cid,...legacy}=asr(1,'LEGACY_TRANSCRIPT');await cache(e,'asr:'+BV,legacy);
 for(const target of [light(1),{...light(1),page:undefined,cid:undefined}])assert.match((await planVideo(e,target,BV,'light',Date.now())).materials.join(''),/LEGACY_TRANSCRIPT/);
});
test('C1b ASR for the wrong page or cid cannot become page-two evidence',async()=>{
 for(const wrong of [asr(1,'WRONG'),{...asr(2,'WRONG'),cid:101}]){const e=env();await cache(e,'asr:'+BV+':p:2',wrong);assert.doesNotMatch((await planVideo(e,light(2),BV+'~p2','light',Date.now())).materials.join(''),/WRONG/);}
});

test('C1b switch creates separate per-page jobs and joins only matching-page waiters',async()=>{
 const e=env();for(const [id,page] of [['wait-p1',1],['wait-p2',2],['wait-p2-other',2]]){
 await e.DB.prepare("INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,ready,status,lease_until,created_at,phase) VALUES(?,'GROUP000001',?,'source','[]',0,?,0,'running',?,?, 'light')").bind(id,BV+(page>1?'~p2':''),Date.now()+30000,12345,Date.now()).run();
 const w=await e.DB.prepare('SELECT * FROM video_waits WHERE id=?').bind(id).first();assert.equal(await media.switchToMedia(e,w,light(page)),true);
 }
 const jobs=(await e.DB.prepare("SELECT * FROM jobs WHERE kind='bili_media' ORDER BY id").all()).results;assert.equal(jobs.length,2);
 for(const page of [1,2]){const payload=JSON.parse(jobs.find(j=>j.id===jobId(page)).payload);assert.equal(payload.page,page);assert.equal(payload.cid,page===1?101:202);assert.deepEqual(payload.waiters,page===1?['wait-p1']:['wait-p2','wait-p2-other']);}
});

test('C1b first-page failures and job state cannot release or fail a page-two wait',async()=>{
 const e=env();media.TEAM.bili.media.enabled=true;
 await e.DB.prepare("INSERT INTO settings VALUES('media:last-seen',?)").bind(String(Date.now())).run();
 await cache(e,'asrfail:'+BV,{reason:'paid',until:Date.now()+86400000});await seedJob(e,1);await e.DB.prepare("UPDATE jobs SET status='failed',error='no_speech'").run();
 assert.equal((await planVideo(e,light(2),BV+'~p2','light',Date.now())).media,'start');
 assert.equal((await planVideo(e,light(1),BV,'light',Date.now())).reason,'paid');
 await cache(e,'asrfail:'+BV+':p:2',{reason:'no_speech',until:Date.now()+86400000});assert.equal((await planVideo(e,light(2),BV+'~p2','light',Date.now())).reason,'no_speech');
});

test('C1b media claim advertises proto2 and keeps page/cid in the claimed job',async()=>{
 const e=env();await seedJob(e,2);await e.DB.prepare("UPDATE jobs SET status='pending'").run();const body=await (await media.dispatchMedia(e,'/api/runner/fetch/media/claim',{proto:2})).json();assert.equal(body.proto,2);assert.equal(body.job.payload.page,2);assert.equal(body.job.payload.cid,202);
});
test('C1b proto2 page-two report is repeatable and writes only its own transcript key',async()=>{
 const e=env(),j=await seedJob(e,2);await cache(e,'asr:'+BV,asr(1,'FIRST_PAGE'));
 for(let i=0;i<2;i++)assert.equal((await media.reportMedia(e,{...j,proto:2,success:true,result:asr(2,'SECOND_PAGE')})).status,200);
 assert.equal((await note(e,'asr:'+BV+':p:2')).text,'SECOND_PAGE');assert.equal((await note(e,'asr:'+BV+':p:2')).cid,202);assert.equal((await note(e,'asr:'+BV)).text,'FIRST_PAGE');
});
test('C1b actual legacy-shaped first-page reports still write the old ASR key',async()=>{
 const e=env(),j=await seedJob(e,1,true),{page,cid,...result}=asr(1,'LEGACY_REPORT');assert.equal((await media.reportMedia(e,{...j,success:true,result})).status,200);assert.equal((await note(e,'asr:'+BV)).text,'LEGACY_REPORT');assert.equal(await note(e,'asr:'+BV+':p:1'),null);
});
test('C1b old runner success and failure on page two become runner_outdated without caching',async()=>{
 for(const success of [true,false]){const e=env(),j=await seedJob(e,2),{page,cid,...result}=asr(1,'FIRST_PAGE');
 for(let i=0;i<2;i++)assert.equal((await media.reportMedia(e,{...j,success,...(success?{result}:{reason:'no_speech'})})).status,200);
 const row=await e.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(j.id).first();assert.equal(row.status,'failed');assert.equal(row.error,'runner_outdated');assert.equal((await e.DB.prepare('SELECT * FROM media_notes').all()).results.length,0);
 const plan=await planVideo(e,light(2),BV+'~p2','media',Date.now());assert.equal(plan.reason,'runner_outdated');
 }
});
test('C1b proto2 reports reject mismatched or missing page/cid before writing evidence',async()=>{
 for(const result of [asr(1,'WRONG'),{...asr(2,'WRONG'),cid:101},{...asr(2,'WRONG'),cid:undefined},{...asr(2,'WRONG'),page:undefined},{...asr(2,'WRONG'),page:2.5}]){const e=env(),j=await seedJob(e,2);assert.equal((await media.reportMedia(e,{...j,proto:2,success:true,result})).status,400);assert.equal((await e.DB.prepare('SELECT * FROM media_notes').all()).results.length,0);}
});
test('C1b page-two negative reports cache their failure separately from first-page evidence',async()=>{
 const e=env(),j=await seedJob(e,2);await cache(e,'asr:'+BV,asr(1,'FIRST_PAGE'));assert.equal((await media.reportMedia(e,{...j,proto:2,success:false,reason:'no_speech'})).status,200);assert.equal((await note(e,'asrfail:'+BV+':p:2')).reason,'no_speech');assert.equal(await note(e,'asrfail:'+BV),null);assert.equal((await note(e,'asr:'+BV)).text,'FIRST_PAGE');
});

test('C1b an old media runner claim fails page two as runner_outdated without delivering an incompatible job',async()=>{
 const e=env();await seedJob(e,2);await e.DB.prepare("UPDATE jobs SET status='pending'").run();
 const body=await (await media.dispatchMedia(e,'/api/runner/fetch/media/claim',{})).json();assert.equal(body.job,null);
 const row=await e.DB.prepare('SELECT status,error FROM jobs WHERE id=?').bind(jobId(2)).first();assert.equal(row.status,'failed');assert.equal(row.error,'runner_outdated');assert.equal((await e.DB.prepare('SELECT * FROM media_notes').all()).results.length,0);
});


test('C1b full no-subtitle page-two fetch to audio to report preserves cid and never alters first-page ASR',async()=>{
 const e=env(),f=media.fetchjobs,home=fs.mkdtempSync(path.join(os.tmpdir(),'c1b-e2e-'));
 try{
  await cache(e,'asr:'+BV,asr(1,'FIRST_PAGE'));
  await f.requestBili(e,BV+'~p2','light','none');
  const claimed=await (await f.fetchRoute(e,'/api/runner/fetch/claim',{})).json(),fixture=twoPages({media:true});
  await runJob(claimed.job,fixture.client,async(_p,body)=>assert.equal((await f.reportFetch(e,body)).status,200),()=>{},async()=>{},claimed.proto);
  const light=await f.biliCached(e,BV+'~p2');assert.equal(light.page,2);assert.equal(light.cid,202);assert.equal(light.duration,60);assert.equal(light.subtitle_status,'none');
  await e.DB.prepare("INSERT INTO video_waits(id,group_id,ref,latest_id,batch_ids,mentioned,due_at,ready,status,lease_until,created_at,phase) VALUES('e2e','GROUP000001',?,'source','[]',0,?,0,'running',12345,?,'light')").bind(BV+'~p2',Date.now()+30000,Date.now()).run();
  const wait=await e.DB.prepare("SELECT * FROM video_waits WHERE id='e2e'").first();assert.equal(await media.switchToMedia(e,wait,light),true);
  const claim=await (await media.dispatchMedia(e,'/api/runner/fetch/media/claim',{proto:2})).json();
  const value=await runMediaJob(claim.job,{home,proto:claim.proto,client:fixture.client,asrConfig:{python:'/fixture',model_dir:'/fixture'},download:async(_u,d)=>fs.writeFileSync(d,'fixture-audio'),ffmpeg:async(_s,d)=>fs.writeFileSync(d,'fixture-pcm'),asr:async()=>({segments:[{start:0,end:60,text:'SECOND_PAGE_AUDIO'}],audio_s:60})});
  assert.equal(value.report.success,true);assert.equal(value.cleanup.residue,0);assert.equal((await media.reportMedia(e,value.report)).status,200);
  const plan=await planVideo(e,light,BV+'~p2','media',Date.now());assert.match(plan.materials.join(''),/SECOND_PAGE_AUDIO/);assert.doesNotMatch(plan.materials.join(''),/FIRST_PAGE/);
  assert.equal((await note(e,'asr:'+BV)).text,'FIRST_PAGE');assert.equal((await note(e,'asr:'+BV+':p:2')).cid,202);
  assert.equal(new URL('https://api.bilibili.com'+fixture.calls.find(o=>o.path.includes('/playurl')).path).searchParams.get('cid'),'202');
  assert.equal((await e.DB.prepare("SELECT ready FROM video_waits WHERE id='e2e'").first()).ready,1);
 }finally{fs.rmSync(home,{recursive:true,force:true});}
});
