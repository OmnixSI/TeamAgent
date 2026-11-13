// One paid request, no QQ calls and no production database access.
// OPENAI_API_KEY_FILE is supplied by the caller; never print its value or contents.
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const root=new URL('../',import.meta.url),tmp=mkdtempSync('/tmp/f8-live-');
const db=new DatabaseSync(':memory:');
const originalFetch=globalThis.fetch;
let calls=0,usage,apiError,elapsed=0;
function statement(sql,args=[]){
 const execute=()=>{
  const s=db.prepare(sql);
  if(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql))return {results:s.all(...args),meta:{changes:0}};
  const r=s.run(...args);return {results:[],meta:{changes:Number(r.changes)}};
 };
 return {bind:(...values)=>statement(sql,values.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v)),execute,async first(){return execute().results[0]??null;},async all(){return execute();},async run(){return execute();}};
}
try{
 assert.ok(process.env.OPENAI_API_KEY_FILE,'credential file is required');
 db.exec(readFileSync(new URL('schema.sql',root),'utf8'));
 const DB={prepare:statement,async batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>s.execute());db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}};
 const apiKey=readFileSync(process.env.OPENAI_API_KEY_FILE,'utf8').trim();assert.ok(apiKey);
 globalThis.fetch=async(url,init)=>{
  assert.equal(String(url),'https://api.openai.com/v1/images/generations','only the generation endpoint is allowed');
  assert.ok(++calls<=1,'one request maximum');
  const body=JSON.parse(init.body);assert.equal(body.quality,'low');assert.equal(body.n,1);assert.equal(body.size,'1024x1024');
  const response=await originalFetch(url,init);
  const json=await response.clone().json();usage=json.usage;
  if(json.error){
   const identifier=v=>typeof v==='string'&&/^[a-zA-Z0-9_.-]{1,80}$/.test(v)?v:null;
   const text=String(json.error.message||'');
   apiError={code:identifier(json.error.code),type:identifier(json.error.type),param:identifier(json.error.param),category:/verif/i.test(text)?'verification_required':/unknown parameter|unsupported parameter/i.test(text)?'unsupported_parameter':/model/i.test(text)?'model_error':/billing|credit|quota/i.test(text)?'billing_error':'other'};
  }
  return response;
 };
 const modulePath=tmp+'/imagegen.mjs';
 await build({entryPoints:[new URL('src/imagegen.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:modulePath,logLevel:'silent'});
 const {generateImage}=await import(pathToFileURL(modulePath).href);
 const started=performance.now(),result=await generateImage({DB,OPENAI_API_KEY:apiKey},{prompt:'一只戴草帽的橘猫在海边看日落，水彩风格',quality:'low',group:'f8-live-local',sender:'f8-live-test'});
 elapsed=Math.round(performance.now()-started);
 if(!result.ok){console.log(JSON.stringify({ok:false,error_kind:result.error_kind,status:result.status??null,api_error:apiError,elapsed_ms:elapsed,calls,qq_real_sends:0,production_d1_writes:0}));process.exitCode=1;}
 else{
  assert.equal(result.jpeg[0],255);assert.equal(result.jpeg[1],216);assert.equal(result.width,1024);assert.equal(result.height,1024);assert.equal(result.bytes,result.jpeg.byteLength);assert.ok(result.bytes>0&&result.bytes<=1500000);assert.ok(result.est_cost_micro_usd<=300000);
  const file=tmp+'/image.jpg';writeFileSync(file,result.jpeg,{mode:0o600});const saved=readFileSync(file);assert.equal(saved.length,result.bytes);
  console.log(JSON.stringify({ok:true,model:result.model,elapsed_ms:elapsed,api_latency_ms:result.latency_ms,bytes:result.bytes,width:result.width,height:result.height,sha256:createHash('sha256').update(saved).digest('hex'),est_cost_micro_usd:result.est_cost_micro_usd,est_cost_total_usd:result.est_cost_micro_usd/1e6,usage:usage?{input_tokens:usage.input_tokens,output_tokens:usage.output_tokens,total_tokens:usage.total_tokens}:null,calls,qq_real_sends:0,production_d1_writes:0}));
 }
}catch{console.log(JSON.stringify({ok:false,reason:'实测未通过；未记录任何密钥、提示词或原始异常',elapsed_ms:elapsed,calls,qq_real_sends:0,production_d1_writes:0}));process.exitCode=1;}
finally{globalThis.fetch=originalFetch;db.close();rmSync(tmp,{recursive:true,force:true});}
