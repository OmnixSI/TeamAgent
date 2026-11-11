// Synthetic P1 acceptance. No QQ, remote D1, real group data or credential files.
import { build } from 'esbuild';
import { readFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
let runtimePromise;
export function loadTimingRuntime(){
  return runtimePromise??=(async()=>{
    const outfile=resolve(root,`.wrangler/timing-eval-${process.pid}.mjs`);
    await build({absWorkingDir:root,stdin:{contents:[
      'export {participationMessages} from "./src/engagement";',
      'export {parseDecision,hardRuleHit,allowWait} from "./src/rhythm";',
      'export {buildViews} from "./src/context";',
      'export {buildConversation,botView,toPrompt} from "./src/view";',
      'export {model} from "./src/runtime";',
    ].join('\n'),resolveDir:root,loader:'ts'},bundle:true,format:'esm',platform:'node',outfile});
    return import(pathToFileURL(outfile));
  })();
}

// Use the production views and request builder, in the production field order.
// Labels and future observations never enter model input.
export function timingInput(runtime,snapshot,scene){
  const names=new Map([['m1','小岚'],['m2','小禾']]),refs=new Map();
  const batch=scene.messages.filter(m=>scene.batchIds.includes(m.id)),latest=batch.at(-1);
  const recentBot=scene.recentBot??[];
  for(const row of scene.messages)refs.set(row.id,{id:row.id,from:names.get(row.sender),fromId:row.sender,text:row.body});
  for(const row of recentBot)refs.set('b:'+row.id,{id:'b:'+row.id,from:'你',fromId:'bot',text:row.body});
  const context={batch,latest,recent:scene.messages.slice(-24),names,refs,imageNotes:new Map(),imagePicks:new Set()};
  const views=runtime.buildViews(context,recentBot);
  return {
    selfNote:snapshot.selfNote,
    learnedExpressions:snapshot.learnedExpressions,
    today:latest.ts,
    projects:snapshot.projects,
    facts:snapshot.facts,
    materials:undefined,
    reflection:snapshot.reflection,
    conversation:runtime.buildConversation(views.recentViews,recentBot.map(runtime.botView)).map(runtime.toPrompt),
    recentBot,
    alreadyReportedCI:snapshot.alreadyReportedCI,
    context:{latest:runtime.toPrompt(views.latestView),batch:views.batchViews.map(runtime.toPrompt),mentioned:batch.some(m=>m.mentioned),intent:undefined},
  };
}
function forced(scene){
  const batch=scene.messages.filter(m=>scene.batchIds.includes(m.id)),latest=batch.at(-1);
  return !!batch.some(m=>m.mentioned)||!!scene.videoWaited||latest?.meta?.replyTo?.kind==='bot'||
    !!latest?.meta?.forwarded?.some(q=>(scene.recentBot??[]).some(r=>r.body.trim()===String(q.content??'').trim()));
}
export async function timingDecision({runtime,scene,messages,complete}){
  if(!forced(scene)&&runtime.hardRuleHit(scene.previousDecision,scene.now))return {action:'stop',gate:'hard_unanswered',modelCalls:0};
  const raw=await complete(messages,scene);
  const oldest=scene.messages.find(m=>scene.batchIds.includes(m.id));
  const canWait=runtime.allowWait({waited:!!scene.waited,oldestPendingAt:Date.parse(oldest.ts),now:scene.now,off:false});
  return {...runtime.parseDecision(raw,{forced:forced(scene),allowWait:canWait}),gate:'model',modelCalls:1};
}
async function ruleAssertions(runtime){
  const rules=[];
  const add=(name,ok)=>rules.push({name,ok});
  const actions=['reply','wait','stop'];
  add('被@必reply',actions.every(action=>runtime.parseDecision(JSON.stringify({action}),{forced:true,allowWait:true}).action==='reply'));
  add('forced从不stop或wait',[...actions.map(action=>JSON.stringify({action})),'invalid JSON','{}'].every(raw=>{
    const d=runtime.parseDecision(raw,{forced:true,allowWait:true});return d.action==='reply'&&d.kind==='direct';
  }));
  const once=runtime.parseDecision('{"action":"wait","wait_seconds":15}',{forced:false,allowWait:true});
  const mayWaitAgain=runtime.allowWait({waited:true,oldestPendingAt:0,now:15000,off:false});
  add('同批不能wait两次',once.action==='wait'&&!mayWaitAgain&&runtime.parseDecision('{"action":"wait"}',{forced:false,allowWait:mayWaitAgain}).action==='stop');
  let calls=0;
  const hard=await timingDecision({runtime,scene:{messages:[{id:'m',body:'继续',ts:new Date(1000).toISOString(),meta:{}}],batchIds:['m'],now:1000,previousDecision:{spoken_kind:'proactive',created_at:0,outbox_id:'bot',last_base:'bot',n:2,addressed:0}},messages:[],complete:async()=>{calls++;return '{"action":"reply"}';}});
  add('硬规则命中不调模型',hard.gate==='hard_unanswered'&&hard.action==='stop'&&calls===0);
  return {pass:rules.filter(r=>r.ok).length,total:rules.length,rate:rules.filter(r=>r.ok).length/rules.length,results:rules};
}
export async function runTimingEvaluation({fixture,runtime,complete,onResult=()=>{}}){
  const rules=await ruleAssertions(runtime);
  if(!complete)return {passed:false,synthetic:{status:'not_run',pass:null,total:fixture.cases.length,rate:null},rules};
  const results=[];
  // Deliberately serial: one decision request at a time, matching CHAT concurrency.
  for(const scene of fixture.cases){
    const started=Date.now();
    const d=await timingDecision({runtime,scene,messages:runtime.participationMessages(timingInput(runtime,fixture.snapshot,scene)),complete});
    const row={id:scene.id,category:scene.category,acceptable:scene.acceptable,action:d.action,gate:d.gate,ok:scene.acceptable.includes(d.action),modelCalls:d.modelCalls,ms:Date.now()-started};
    results.push(row);onResult(row);
  }
  const pass=results.filter(r=>r.ok).length,rate=pass/results.length;
  return {passed:rate>=0.9&&rules.pass===rules.total,synthetic:{status:'completed',pass,total:results.length,rate,modelCalls:results.reduce((n,r)=>n+r.modelCalls,0),results},rules};
}

async function main(){
  const args=process.argv.slice(2),rulesOnly=args.includes('--rules-only');
  const index=args.indexOf('--output');
  const output=resolve(index<0?resolve(homedir(),'.inkboard-team/eval/timing-synthetic-result.json'):args[index+1]);
  if(!rulesOnly&&!process.env.DEEPSEEK_API_KEY)throw Error('当前进程没有 DEEPSEEK_API_KEY；请在已配置环境运行。不会读取凭据文件。');
  const fixture=JSON.parse(readFileSync(resolve(root,'test/fixtures/timing-synthetic.json'),'utf8'));
  const runtime=await loadTimingRuntime();
  const report=await runTimingEvaluation({fixture,runtime,complete:rulesOnly?undefined:async messages=>{
    const data=await runtime.model({DEEPSEEK_API_KEY:process.env.DEEPSEEK_API_KEY},'participation','high',{max_tokens:8192,messages});
    return data.choices[0].message.content;
  },onResult:row=>console.log(JSON.stringify(row))});
  mkdirSync(dirname(output),{recursive:true,mode:0o700});
  writeFileSync(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});chmodSync(output,0o600);
  console.log(JSON.stringify({output,passed:report.passed,synthetic:{...report.synthetic,results:undefined},rules:{...report.rules,results:undefined}}));
  if(rulesOnly?report.rules.pass!==report.rules.total:!report.passed)process.exitCode=1;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{
  console.error('插话评测未完成；请核对环境配置和模型状态。未输出凭据或原始异常。');process.exitCode=1;
});
