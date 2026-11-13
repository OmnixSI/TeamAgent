import {build} from 'esbuild';
import {env,worker} from './support.mjs';
const outfile=`.wrangler/tool-failure-${process.pid}.mjs`;
await build({stdin:{contents:'export {agentAnswer} from "./src/semantic"; export {ingestRepoIndex} from "./src/repo"; export {runCloudRepoTool} from "./src/github"; export {applyImageOutcomes} from "./src/vision";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
export const api=await import('../'+outfile);
export {env,worker};
export const call=(name,args={},id=name)=>({id,type:'function',function:{name,arguments:JSON.stringify(args)}});
export async function context(e,body='帮我核对一下',extra={}) {
  const row={id:'current',group_id:'GROUP000001',sender:'U1',body,ts:new Date().toISOString(),mentioned:1,meta:{direct:true,media:[]},...extra};
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,row.body,row.ts,row.mentioned).run();
  return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true,background:true,switches:{}};
}
export const rows=(e,table)=>e.DB.prepare('SELECT * FROM '+table).all().then(r=>r.results);
export const toolResults=seen=>seen.flatMap(b=>b.messages||[]).filter(m=>m.role==='tool').map(m=>JSON.parse(m.content.replace(/^【外部资料[^\n]*\n/,'').replace(/\n【外部资料结束】$/,'')));
// Only the external model/HTTP boundary is replaced; agent loop, tools and SQLite are real.
export async function models(steps,run,{network=()=>new Response('unavailable',{status:503}),voice,summary}={}) {
  const old=globalThis.fetch,seen=[],http=[];let i=0;
  globalThis.fetch=async(url,opt={})=>{
    if(!String(url).includes('/chat/completions')) {http.push(String(url));return network(url,opt);}
    const b=JSON.parse(opt.body);seen.push(b);
    if(b.messages?.[0]?.content?.includes('最后的嘴替模块')) {
      const brief=JSON.parse(b.messages[1].content).brief;
      return Response.json({choices:[{message:{content:JSON.stringify({mode:'work',text:voice??(typeof brief.facts==='string'?brief.facts:JSON.stringify(brief.facts))})}}]});
    }
    const next=steps[i++];
    return Response.json({choices:[{message:next?{role:'assistant',tool_calls:Array.isArray(next)?next:[next]}:{content:JSON.stringify({action:'reply',kind:'direct',brief:summary?summary(b):'没拿到'})}}]});
  };
  try{return await run({seen,http});}finally{globalThis.fetch=old;}
}
