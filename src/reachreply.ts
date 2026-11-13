import {safeReachText} from "./reach-contract.mjs";
import {untrusted} from "./untrusted";
import {loadChatContext} from "./context";
import {agentAnswer} from "./semantic";
import {enqueueVoice,decodeVoice} from "./voice";
import {normalizeReachResult} from "../runner/reach-result.mjs";
function cleanContext(value:any):any{
 if(typeof value==='string')return safeReachText(value);
 if(value instanceof Map)return new Map([...value].map(([k,v])=>[k,cleanContext(v)]));
 if(Array.isArray(value))return value.map(cleanContext);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,cleanContext(v)]));
 return value;
}
export async function runReachReply(e:any,p:any,id:string){
 const row=await e.DB.prepare("SELECT payload FROM jobs WHERE id=? AND kind='fetch' AND status IN ('done','failed') AND json_extract(payload,'$.source')='reach'").bind(p.fetchId).first();
 if(!row)return;
 const done=JSON.parse(row.payload);
 if(!done.waiters?.some((w:any)=>w.group===p.group&&w.message===p.message))return;
 const loaded=await loadChatContext(e,{groupId:p.group,latestId:p.message,batchIds:[p.message]});
 const context=cleanContext(loaded);
 if(!context.latest)return;
 // No retained execution URL, cookies or backend exceptions enter the model. Material remains explicitly untrusted.
 const result=normalizeReachResult({channel:done.channel,action:done.action,backend:done.backend,source_url:done.source_url},done.result);
 const answer=await agentAnswer(e,{...context,background:true,mentioned:true,materials:[untrusted('social-reader',JSON.stringify(result),result.fetched_at)],
  rules:['仅根据这次读取结果回答原消息；范围以 content_scope 为准，不能把搜索摘要或已加载评论说成全文。失败时说明 error_kind 与 next_action，不重复调用读取工具。']});
 if(decodeVoice(answer).text!=='[[SILENT]]')await enqueueVoice(e,id,p.group,p.message,answer);
}
