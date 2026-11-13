import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {env} from './support.mjs';
const output=`.wrangler/imagegen-${process.pid}.mjs`;
await build({entryPoints:['src/imagegen.ts'],bundle:true,format:'esm',platform:'browser',outfile:output,plugins:[{name:'openai-boundary',setup(b){b.onResolve({filter:/^\.\/openai$/},()=>({path:'openai',namespace:'boundary'}));b.onLoad({filter:/.*/,namespace:'boundary'},()=>({contents:'export const callOpenAi=(e,o)=>e.testCallOpenAi(o);'}));}}]});
const mod=await import('../'+output);
// SOI, APP0, SOF0 with 3 components and 1024x1024 dimensions, EOI.
const jpeg=Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,17,8,4,0,4,0,3,1,17,0,2,17,0,3,17,0,255,217]);
const options={prompt:'一只戴草帽的橘猫',group:'A',sender:'member'};
const generation=e=>{const calls=[];e.testCallOpenAi=async o=>{calls.push(o);return {ok:true,json:{data:[{b64_json:Buffer.from(jpeg).toString('base64')}]},latency_ms:123,status:200};};return calls;};
const all=(e,t)=>e.DB.prepare('SELECT * FROM '+t).all().then(r=>r.results);
const enqueue=(e,id='turn',patch={})=>mod.enqueueGeneratedImage(e,{id,group:'A',message:'source',jpeg,prompt:options.prompt,sender:'member',...patch});

test('G1 generates JPEG directly with one image, low quality and exact dimensions',async()=>{
 const e=env(),calls=generation(e),r=await mod.generateImage(e,options);
 assert.equal(r.ok,true);assert.deepEqual(r.jpeg,jpeg);assert.equal(r.bytes,29);assert.equal(r.width,1024);assert.equal(r.height,1024);assert.equal(r.latency_ms,123);
 assert.deepEqual(calls[0].body,{model:'gpt-image-2.5-flare',prompt:options.prompt,size:'1024x1024',quality:'low',n:1,output_format:'jpeg',output_compression:80});
 assert.equal(calls[0].path,'/v1/images/generations');assert.equal(calls[0].purpose,'image_gen');assert.equal(calls[0].timeoutMs,100000);assert.equal(calls[0].group,'A');assert.equal(calls[0].sender,'member');
 assert.ok(r.est_cost_micro_usd>=11000);assert.equal(calls[0].estCostMicroUsd,r.est_cost_micro_usd);
});
test('G1 settings model and explicit size/quality pass through; SOF2 dimensions are decoded',async()=>{
 const e=env(),calls=generation(e);await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('imagegen:model','configured-image-model').run();
 const progressive=jpeg.slice();progressive[9]=194;progressive[13]=6;
 e.testCallOpenAi=async o=>{calls.push(o);return {ok:true,json:{data:[{b64_json:Buffer.from(progressive).toString('base64')}]},latency_ms:2,status:200};};
 const r=await mod.generateImage(e,{...options,size:'1024x1536',quality:'medium'});
 assert.equal(r.ok,true);assert.equal(r.height,1536);assert.equal(r.width,1024);assert.equal(r.model,'configured-image-model');assert.equal(calls[0].body.quality,'medium');assert.equal(calls[0].body.size,'1024x1536');
});
test('G2 OpenAI refusal, timeout and upstream failures preserve the complete typed result',async()=>{
 for(const kind of ['refused','timeout','upstream','auth','quota','budget','denied','unsupported']){
  const e=env(),failure={ok:false,error_kind:kind,retryable:false,status:400,reason_text:'简要原因',next_action:'下一步'};
  e.testCallOpenAi=async()=>failure;assert.deepEqual(await mod.generateImage(e,options),failure);
 }
});
test('G3 oversized output and malformed JPEG/base64 are rejected before storage or retry',async()=>{
 for(const payload of [Buffer.alloc(1500001).toString('base64'),'!!!',Buffer.from([255,216,255,217]).toString('base64'),null]){
  const e=env();let calls=0;e.testCallOpenAi=async()=>{calls++;return {ok:true,json:{data:[{b64_json:payload}]},latency_ms:1,status:200};};
  const r=await mod.generateImage(e,options);assert.equal(r.ok,false);assert.equal(r.error_kind,'upstream');assert.equal(r.retryable,false);assert.equal(calls,1);assert.equal((await all(e,'generated_images')).length,0);
 }
});
test('G3 direct enqueue also refuses oversize or invalid JPEG before a DB batch',async()=>{
 const e=env();let batches=0;const orig=e.DB.batch;e.DB.batch=(ss)=>{batches++;return orig(ss);};
 for(const b of [new Uint8Array(1500001),new Uint8Array([1,2,3])])await assert.rejects(enqueue(e,'bad',{jpeg:b}));
 assert.equal(batches,0);
});
test('G4 enqueues image, outbox and meta once in one D1 batch; retry cannot overwrite data or group',async()=>{
 const e=env();let batches=0;const orig=e.DB.batch;e.DB.batch=ss=>{batches++;assert.equal(ss.length,3);return orig(ss);};
 assert.deepEqual(await enqueue(e),{outbox_id:'turn~g'});assert.equal(batches,1);
 const image=(await all(e,'generated_images'))[0],outbox=(await all(e,'outbox'))[0],meta=(await all(e,'outbox_meta'))[0];
 assert.equal(image.id,'turn');assert.equal(image.group_id,'A');assert.equal(image.sender_id,'member');assert.equal(image.mime,'image/jpeg');assert.equal(image.bytes,29);assert.equal(image.width,1024);assert.equal(image.height,1024);
 assert.deepEqual(new Uint8Array(image.data),jpeg);assert.match(image.prompt_hash,/^[a-f0-9]{64}$/);assert.equal(image.expires_at-image.created_at,7*86400000);assert.equal(outbox.body,'[图片]');assert.equal(outbox.status,'pending');assert.equal(outbox.group_id,'A');assert.equal(outbox.msg_id,'source');assert.deepEqual(JSON.parse(meta.json),{gen_image:'turn'});
 await enqueue(e);await enqueue(e,'turn',{group:'B',prompt:'other',sender:'other'});
 assert.equal((await all(e,'generated_images')).length,1);assert.equal((await all(e,'outbox')).length,1);assert.equal((await all(e,'outbox_meta')).length,1);assert.equal((await all(e,'outbox'))[0].group_id,'A');assert.equal((await all(e,'generated_images'))[0].prompt_hash,image.prompt_hash);
});
test('generated image migration is additive/idempotent; cron deletes only expired image data',async()=>{
 const db=new DatabaseSync(':memory:');try{const sql=readFileSync('migrations/0041_generated_images.sql','utf8');db.exec(sql);db.exec(sql);assert.equal(db.prepare('SELECT COUNT(*) n FROM generated_images').get().n,0);}finally{db.close();}
 const e=env();await enqueue(e,'old');await enqueue(e,'current');await e.DB.prepare('UPDATE generated_images SET expires_at=? WHERE id=?').bind(Date.now()-1,'old').run();
 await mod.generatedImagesCleanupJob.run(e,new Date());assert.deepEqual((await all(e,'generated_images')).map(r=>r.id),['current']);assert.equal((await all(e,'outbox')).length,2);
});
test('configured output estimate is included in the shared-channel budget reservation',async()=>{
 const e=env(),calls=generation(e);await e.DB.prepare('INSERT INTO settings VALUES(?,?)').bind('imagegen:est_cost_micro_usd:low:1024x1024','80000').run();
 const r=await mod.generateImage(e,options);assert.equal(r.ok,true);assert.equal(r.est_cost_micro_usd,80120);assert.equal(calls[0].estCostMicroUsd,80120);
});
