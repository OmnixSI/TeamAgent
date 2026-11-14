// F8-5 IMG-b intent replay through the real agentAnswer tool loop.
// Image generation is mocked at the module boundary (no cost, no QQ, no D1).
// MODE=deepseek uses the production DeepSeek request path; MODE=openai is a
// supplementary real-model run and is labelled as such; MODE=mock only checks wiring.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {env} from '../test/support.mjs';

const RUNS=Number(process.env.F8_B_RUNS||3);
const mode=process.env.F8_B_MODE||(process.env.DEEPSEEK_API_KEY_FILE?'deepseek':process.env.OPENAI_API_KEY_FILE&&process.env.F8_B_ALLOW_OPENAI==='1'?'openai':'mock');
const sentences=[
 {id:'T1',expect:true,source:'构造（F8-2 笔记）',text:'帮我生成一张戴草帽的橘猫在海边看日落的水彩画'},
 {id:'T2',expect:true,source:'构造（F8-2 笔记）',text:'做一张海报，上面写「周五晚上八点开黑」，蓝紫色赛博朋克风'},
 {id:'T3',expect:true,source:'构造（F8-2 笔记）',text:'Draw me a cozy reading nook with a sleeping cat, warm afternoon light'},
 {id:'T4',expect:true,source:'构造（用户原话“帮我生成一张…图”改写）',text:'帮我生成一张赛博朋克风格的城市夜景图'},
 {id:'N1',expect:false,source:'构造（F8-2 笔记）',text:'别画饼了，说点实际的'},
 {id:'N2',expect:false,source:'构造（F8-2 笔记）',text:'你画得真好'},
 {id:'N3',expect:false,source:'构造（F8-2 笔记）',text:'画个表格总结一下这周的讨论'},
];
const fakeImageModule=`
export const IMAGE_MODEL='fake-image';
export const MAX_GENERATED_IMAGE_BYTES=1500000;
export const generateImage=async(e,o)=>{ (globalThis.__f8img ??= []).push(o); return {ok:true,jpeg:Uint8Array.from([255,216,255,224,0,4,0,0,255,192,0,17,8,4,0,4,0,3,1,17,0,2,17,0,3,17,0,255,217]),bytes:29,width:1024,height:1024,model:'fake-image',est_cost_micro_usd:1000,latency_ms:1}; };
export const enqueueGeneratedImage=async(e,o)=>({outbox_id:o.id+'~g'});
export const sendGeneratedImage=async()=>null;
export const generatedImagesCleanupJob={name:'fake-cleanup',async run(){}};
`;
const outfile='/tmp/f8-accept-intent-semantic.mjs';
await build({entryPoints:['src/semantic.ts'],bundle:true,format:'esm',platform:'browser',outfile,logLevel:'silent',plugins:[{name:'fake-imagegen',setup(b){
 b.onResolve({filter:/^\.\.\/imagegen$/},()=>({path:'imagegen',namespace:'fake-imagegen'}));
 b.onLoad({filter:/.*/,namespace:'fake-imagegen'},()=>({contents:fakeImageModule,loader:'js'}));
}}]});
const contextOut='/tmp/f8-accept-intent-context.mjs';
await build({entryPoints:['src/context.ts'],bundle:true,format:'esm',platform:'browser',outfile:contextOut,logLevel:'silent'});
const {agentAnswer}=await import(pathToFileURL(outfile).href);
const contextMod=await import(pathToFileURL(contextOut).href);

const deepseekKey=process.env.DEEPSEEK_API_KEY_FILE?readFileSync(process.env.DEEPSEEK_API_KEY_FILE,'utf8').trim():null;
const openaiKey=process.env.OPENAI_API_KEY_FILE?readFileSync(process.env.OPENAI_API_KEY_FILE,'utf8').trim():null;
if(mode==='deepseek')assert.ok(deepseekKey,'DEEPSEEK_API_KEY_FILE');
if(mode==='openai')assert.ok(openaiKey,'OPENAI_API_KEY_FILE');

const originalFetch=globalThis.fetch;
let modelCalls=0,openaiCalls=0;
function mockResponse(url,init){
 const body=JSON.parse(init.body);
 const messages=body.messages||[];
 const last=messages[messages.length-1]||{};
 const sys=String(messages[0]?.content||'');
 modelCalls++;
 const sentence=globalThis.__f8sentence||'';
 if(sys.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"收到。"}'}}]});
 if(last.role==='tool')return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"按真实结果回复"}'}}]});
 const shouldTrigger=(globalThis.__f8expect===true);
 if(shouldTrigger&&body.tools?.some(t=>t.function?.name==='generate_image')){
  return Response.json({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'call-gen',type:'function',function:{name:'generate_image',arguments:JSON.stringify({prompt:sentence})}}]}}]});
 }
 return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"按真实结果回复"}'}}]});
}
globalThis.fetch=async(url,init)=>{
 const u=String(url);
 if(mode==='mock'&&u.includes('api.deepseek.com'))return mockResponse(u,init);
 if(mode==='openai'&&u.includes('api.deepseek.com')){
  const body=JSON.parse(init.body);
  const {thinking,reasoning_effort,max_tokens,...rest}=body;
  openaiCalls++;
  const r=await originalFetch('https://api.openai.com/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+openaiKey,'Content-Type':'application/json'},body:JSON.stringify({...rest,model:'gpt-5.6-luna',reasoning_effort:'none',max_completion_tokens:max_tokens??4096})});
  if(!r.ok){let text='';try{text=(await r.clone().text()).slice(0,300);}catch{}
   (globalThis.__f8modelErrors??=[]).push({status:r.status,text});}
  else{try{const j=await r.clone().json();const u=j.usage||{};(globalThis.__f8usage??=[]).push({prompt:Number(u.prompt_tokens)||0,completion:Number(u.completion_tokens)||0});}catch{}}
  return r;
 }
 return originalFetch(url,init);
};

const results=[];
try{
 for(const sentence of sentences){
  for(let run=1;run<=RUNS;run++){
   const e=env();e.DEEPSEEK_API_KEY=mode==='deepseek'?deepseekKey:'';
   globalThis.__f8img=[];globalThis.__f8sentence=sentence.text;globalThis.__f8expect=sentence.expect;
   const id='intent-'+sentence.id+'-'+run;
   const row={id,group_id:'GROUP000001',sender:'member1',body:sentence.text,ts:new Date().toISOString(),mentioned:1,meta:{direct:true,media:[]}};
   await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,row.body,row.ts,1).run();
   await e.DB.prepare('INSERT INTO message_meta VALUES(?,?)').bind(row.id,JSON.stringify(row.meta)).run();
   const context={latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true};
   const record={sentence:sentence.id,expect:sentence.expect,run,triggered:false,tool_calls:[],prompt:null,prompt_keeps_text:null,executed:false,imagegen_calls:0,job:false,error:null};
   try{
    await agentAnswer(e,context);
    const jobs=await e.DB.prepare("SELECT id,kind,payload FROM jobs WHERE kind='research' ORDER BY created_at").all();
    const job=jobs.results.find(j=>String(j.payload).includes('generate_image'));
    if(job){
     record.job=true;
     const p=JSON.parse(job.payload);
     const calls=p?.resume?.pending?.tool_calls||[];
     record.tool_calls=calls.map(c=>({name:c.function?.name,arguments:c.function?.arguments}));
     const gen=calls.find(c=>c.function?.name==='generate_image');
     if(gen){
      record.triggered=true;
      const args=JSON.parse(gen.function.arguments||'{}');
      record.prompt=typeof args.prompt==='string'?args.prompt:null;
      record.prompt_keeps_text=!!record.prompt&&record.prompt.replace(/\s+/g,'').includes(sentence.text.replace(/\s+/g,''));
      const loaded=await contextMod.loadChatContext(e,{groupId:row.group_id,latestId:p.latestId,batchIds:p.batchIds});
      Object.assign(p,loaded);p.background=true;
      await agentAnswer(e,p);
      record.imagegen_calls=(globalThis.__f8img||[]).length;
      record.executed=record.imagegen_calls>0;
     }
    }
   }catch(error){record.error=String(error?.message||error).slice(0,200);}
   results.push(record);
  }
 }
}finally{globalThis.fetch=originalFetch;}

const summary={};
for(const id of sentences.map(s=>s.id)){
 const rows=results.filter(r=>r.sentence===id);
 const pass=rows.filter(r=>r.expect?r.triggered:!r.triggered).length;
 summary[id]={expect:sentences.find(s=>s.id===id).expect,runs:rows.length,pass,rate:pass+'/'+rows.length,prompts:rows.map(r=>r.prompt),executed:rows.filter(r=>r.executed).length};
}
console.log(JSON.stringify({mode,model:mode==='deepseek'?'deepseek-flash (production path)':mode==='openai'?'gpt-5.6-luna (supplementary, not the ordered model)':'mock (wiring only)',model_calls:modelCalls,openai_calls:openaiCalls,model_errors:globalThis.__f8modelErrors??[],usage:globalThis.__f8usage??[],cost_estimate_usd:((globalThis.__f8usage??[]).reduce((a,u)=>a+u.prompt,0)*0.2+(globalThis.__f8usage??[]).reduce((a,u)=>a+u.completion,0)*1.2)/1e6,summary,results,qq_real_sends:0,production_d1_writes:0},null,2));
