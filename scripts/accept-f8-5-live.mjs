// F8-5 IMG-a: real OpenAI calls through src/imagegen.ts generateImage (no curl).
// OPENAI_API_KEY_FILE is supplied by the caller; the value is never printed or written to the repo.
// Images go to a temporary directory chosen by the caller and are deleted after the PIL check.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {build} from 'esbuild';

const root=new URL('../',import.meta.url),out=process.env.F8_OUT_DIR||'/tmp/f8-accept';
const prompts=[
 {id:'cat',prompt:'一只戴草帽的橘猫在海边看日落，水彩风格',quality:'low',size:'1024x1024'},
 {id:'poster',prompt:'做一张海报，大标题写“周五聚餐”，下面小字“19:00 老地方”，复古红黄配色',quality:'medium',size:'1024x1536'},
 {id:'refusal',prompt:'血腥恐怖的凶杀现场，尸体被刀刺穿，满地鲜血，写实照片',quality:'low',size:'1024x1024'},
];
const db=new DatabaseSync(':memory:');
db.exec(readFileSync(new URL('schema.sql',root),'utf8'));
function statement(sql,args=[]){
 const execute=()=>{
  const s=db.prepare(sql);
  if(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql))return {results:s.all(...args),meta:{changes:0}};
  const r=s.run(...args);return {results:[],meta:{changes:Number(r.changes)}};
 };
 return {bind:(...values)=>statement(sql,values.map(v=>v instanceof ArrayBuffer?new Uint8Array(v):v)),execute,async first(){return execute().results[0]??null;},async all(){return execute();},async run(){return execute();}};
}
const DB={prepare:statement,async batch(statements){db.exec('BEGIN');try{const r=statements.map(s=>s.execute());db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}};
mkdirSync(out,{recursive:true});
const report={prompts:[],vision:null,cost_micro_usd:0,qq_real_sends:0,production_d1_writes:0,network_hosts:new Set()};
try{
 assert.ok(process.env.OPENAI_API_KEY_FILE,'credential file is required');
 const apiKey=readFileSync(process.env.OPENAI_API_KEY_FILE,'utf8').trim();assert.ok(apiKey);
 const tmp=out+'/mods';mkdirSync(tmp,{recursive:true});
 await build({entryPoints:[new URL('src/imagegen.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:tmp+'/imagegen.mjs',logLevel:'silent'});
 await build({entryPoints:[new URL('src/openai.ts',root).pathname],bundle:true,format:'esm',platform:'browser',outfile:tmp+'/openai.mjs',logLevel:'silent'});
 const {generateImage}=await import(pathToFileURL(tmp+'/imagegen.mjs').href);
 const {callOpenAi}=await import(pathToFileURL(tmp+'/openai.mjs').href);
 const originalFetch=globalThis.fetch;let imagesCalls=0;
 globalThis.fetch=async(url,init)=>{
  const host=new URL(String(url)).host;report.network_hosts.add(host);
  if(host==='api.openai.com'&&String(url).endsWith('/v1/images/generations')){
   assert.ok(++imagesCalls<=4,'at most four image requests');
   const body=JSON.parse(init.body);
   assert.equal(body.n,1);assert.equal(body.output_format,'jpeg');
   const response=await originalFetch(url,init);
   let error=null;try{error=(await response.clone().json()).error;}catch{}
   if(error)report.last_api_error={code:typeof error.code==='string'?error.code.slice(0,40):null,type:typeof error.type==='string'?error.type.slice(0,40):null,status:response.status};
   return response;
  }
  return originalFetch(url,init);
 };
 try{
  for(const p of prompts){
   const started=Date.now();
   const result=await generateImage({DB,OPENAI_API_KEY:apiKey},{prompt:p.prompt,quality:p.quality,size:p.size,group:'f8-accept-local',sender:'f8-accept'});
   const row={id:p.id,quality:p.quality,size:p.size,ok:result.ok,elapsed_ms:Date.now()-started};
   if(result.ok){
    assert.equal(result.jpeg[0],255);assert.equal(result.jpeg[1],216);assert.ok(result.bytes>0&&result.bytes<=1500000);
    assert.equal(result.bytes,result.jpeg.byteLength);
    const expected=p.size.split('x').map(Number);assert.equal(result.width,expected[0]);assert.equal(result.height,expected[1]);
    const file=out+'/'+p.id+'.jpg';writeFileSync(file,Buffer.from(result.jpeg),{mode:0o600});
    Object.assign(row,{bytes:result.bytes,width:result.width,height:result.height,model:result.model,latency_ms:result.latency_ms,sha256:createHash('sha256').update(result.jpeg).digest('hex'),est_cost_micro_usd:result.est_cost_micro_usd,file});
   }else{
    Object.assign(row,{error_kind:result.error_kind,status:result.status??null,retryable:result.retryable,reason_text:result.reason_text,next_action:result.next_action,est_cost_micro_usd:0});
   }
   report.cost_micro_usd+=Number(row.est_cost_micro_usd)||0;
   report.prompts.push(row);
  }
  const poster=report.prompts.find(p=>p.id==='poster');
  if(poster?.ok){
   const b64=readFileSync(poster.file).toString('base64');
   const vision=await callOpenAi({DB,OPENAI_API_KEY:apiKey},{purpose:'vision',path:'/v1/chat/completions',model:'gpt-5.6-luna',timeoutMs:120000,estCostMicroUsd:8000,body:{model:'gpt-5.6-luna',max_completion_tokens:2000,messages:[{role:'user',content:[{type:'text',text:'把这张海报上的所有文字逐字写出来，按从上到下、从左到右的顺序。只输出你实际看到的文字，不要解释，不要猜。'},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+b64}}]}]}});
   if(vision.ok){
    const text=String(vision.json?.choices?.[0]?.message?.content??'');
    report.vision={ok:true,model:'gpt-5.6-luna',text,has_title:text.includes('周五聚餐'),has_time:text.includes('19:00')&&text.includes('老地方'),latency_ms:vision.latency_ms,usage:vision.json?.usage??null};
   }else report.vision={ok:false,error_kind:vision.error_kind,status:vision.status??null,reason_text:vision.reason_text};
  }
 }finally{globalThis.fetch=originalFetch;}
 report.usage_rows=await (async()=>{const r=db.prepare('SELECT purpose,model,status,error_kind,est_cost_micro_usd FROM openai_usage ORDER BY created_at').all();return r;})();
}catch(error){
 report.fatal={name:error?.name||'Error',message:String(error?.message||error).slice(0,300)};
 process.exitCode=1;
}finally{
 db.close();
}
report.network_hosts=[...report.network_hosts];
console.log(JSON.stringify(report,null,2));
