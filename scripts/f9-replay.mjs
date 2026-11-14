#!/usr/bin/env node
/**
 * F9 read-only replay: drives the real runner adapters with real network reads.
 *
 * It never talks to QQ, never writes production D1 and never sends a message.
 * Reach cases go through runner/reach-adapter.mjs (spawn + contract + locks);
 * Bilibili cases go through the unchanged runner/fetcher.mjs with a stub cloud.
 *
 *   node scripts/f9-replay.mjs --cases cases.json [--state DIR] [--out FILE]
 *
 * cases: [{label, kind:"reach", channel, action, target} | {label, kind:"bili", ref}]
 */
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {createReachAdapter} from '../runner/reach-adapter.mjs';
import {createFetchClient,runJob} from '../runner/fetcher.mjs';

const argv=process.argv.slice(2);
const arg=name=>{const i=argv.indexOf('--'+name);return i>=0?argv[i+1]:undefined;};
const casesPath=arg('cases');
if(!casesPath){console.error('usage: node scripts/f9-replay.mjs --cases cases.json [--state DIR] [--out FILE]');process.exit(2);}
const stateDir=arg('state')||join(homedir(),'.inkboard-team/state/reach');
const outPath=arg('out');
const cases=JSON.parse(await readFile(casesPath,'utf8'));
if(!Array.isArray(cases)||!cases.length){console.error('cases must be a non-empty array');process.exit(2);}

const adapter=createReachAdapter({stateDir});
async function load(entry){
 const out=await build({entryPoints:[entry],bundle:true,format:'esm',platform:'neutral',write:false});
 return import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
}
let quoteModules=null;
async function quoteCase(c){
 quoteModules??={social:await load('src/tools/read-social.ts'),stock:await load('src/tools/stock-quote.ts')};
 const symbol=quoteModules.social.xueqiuSymbol(c.target);
 if(!symbol)throw Error('not a quote url');
 const q=await quoteModules.stock.stockQuoteTool.run(null,{symbol},{});
 return quoteModules.social.quoteEnvelope(symbol,c.target,q);
}
const rows=[];
for(const [i,c] of cases.entries()){
 const started=Date.now();
 let row={label:c.label||('case-'+(i+1)),kind:c.kind||'reach',channel:c.channel,action:c.action,target:c.kind==='bili'?('b23.tv/'+c.ref):c.target};
 try{
  if((c.kind||'reach')==='quote'){
   const r=await quoteCase(c);
   row={...row,ok:r.ok,error_kind:r.error?.error_kind||null,next_action:r.error?.next_action||null,
    content_scope:r.content_scope,items:r.items.length,first:r.items[0]?{author:r.items[0].author,text:r.items[0].text.slice(0,160),source_url:r.items[0].source_url}:null};
  }else if((c.kind||'reach')==='bili'){
   const client=createFetchClient({log:()=>{},riskPath:join(stateDir,'bili-risk.json')});
   let report=null;
   await runJob({id:'replay-bili-'+i,payload:{type:'bili',tier:'light',ref:c.ref,lease:'replay',waiters:[]}},client,async(_p,b)=>{report=b;});
   row={...row,ok:!!report?.success,error_kind:report?.success?null:(report?.reason||'failed'),
    title:report?.result?.title||null,subtitle:!!report?.result?.subtitle,items:report?.success?1:0};
  }else{
   const r=await adapter.run({id:'replay-'+i,lease:'replay',version:1,channel:c.channel,action:c.action,target:c.target,backend:'local'},{signal:AbortSignal.timeout(60000)});
   row={...row,ok:r.ok,error_kind:r.error?.error_kind||null,next_action:r.error?.next_action||null,
    content_scope:r.content_scope,items:r.items.length,first:r.items[0]?{author:r.items[0].author,text:r.items[0].text.slice(0,160),source_url:r.items[0].source_url}:null};
  }
 }catch(error){row={...row,ok:false,error_kind:'replay_exception',detail:String(error?.message||error).slice(0,200)};}
 row.ms=Date.now()-started;
 rows.push(row);
 console.log(JSON.stringify(row));
}
const ok=rows.filter(r=>r.ok).length;
console.log(`\nF9 回放：${rows.length} 例，成功 ${ok}，失败 ${rows.length-ok}；QQ 发送 0 次、线上 D1 写入 0 行`);
if(outPath)await writeFile(outPath,JSON.stringify({ran_at:new Date().toISOString(),rows},null,1));
