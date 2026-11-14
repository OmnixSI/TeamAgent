import {normalizeReachResult} from '../runner/reach-result.mjs';
import {publicSourceUrl,validTarget} from './reach-contract.mjs';
import {queueFor} from './lanes';

type ReachTarget={channel:string;action:string;target:string};
const enabled=(v:any)=>v!=null&&!['','0','false'].includes(String(v));
export async function reachSettings(e:any,channel:string){
 const rows=(await e.DB.prepare("SELECT key,value FROM settings WHERE key IN ('reach:mode','off:reach',?,'reach:cooldown_ms',?)")
  .bind('off:reach:'+channel,'reach:cooldown:'+channel).all()).results;
 const s=Object.fromEntries(rows.map((r:any)=>[r.key,r.value]));
 return {on:s['reach:mode']==='on'&&!enabled(s['off:reach'])&&!enabled(s['off:reach:'+channel]),
  cooldown_ms:Math.min(86400000,Math.max(60000,Number(s['reach:cooldown_ms'])||1800000)),
  circuit:(()=>{try{return JSON.parse(s['reach:cooldown:'+channel]||'null');}catch{return null;}})()};
}
export async function reachKey(group:string,r:ReachTarget){
 const identity=/^https:/.test(r.target)?publicSourceUrl(r.target):r.target.trim();
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([group,r.channel,r.action,identity])));
 return 'reach:v1:'+Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function requestReach(e:any,r:ReachTarget,group:string,message:string){
 if(!validTarget(r.channel,r.action,r.target))throw Error('unsupported reach target');
 const settings=await reachSettings(e,r.channel);
 if(!settings.on)return {ok:false,error_kind:'tool_not_ready',next_action:'该平台读取尚未开启，不能声称读过正文。'};
 if(settings.circuit?.until>Date.now())return {ok:false,error_kind:settings.circuit.kind,retry_after:Math.ceil((settings.circuit.until-Date.now())/1000),next_action:'该站点正在冷却，停止请求并等待冷却结束。'};
 const key=await reachKey(group,r),jobId='fetch-'+key,now=Date.now();
 // Handle-based X actions have no URL target; keep a stable profile source for the envelope.
 const sourceUrl=publicSourceUrl(r.target)||(r.channel==='x'&&['profile','tweets'].includes(r.action)?`https://x.com/${r.target.trim()}`:'');
 const cached=await e.DB.prepare('SELECT body,created_at FROM media_notes WHERE id=?').bind(key).first();
 if(cached&&Date.parse(cached.created_at)>now-300000){
  try{const result=normalizeReachResult({...r,backend:'local',source_url:sourceUrl},JSON.parse(cached.body));if(result.ok)return result;}catch{}
 }
 const payload={source:'reach',version:1,...r,source_url:sourceUrl,backend:'local',deadline_ms:45000,cooldown_ms:settings.cooldown_ms,key,waiters:[{group,message}]};
 // Every waiter is explicit and group-scoped. The running command's signed URL is immutable until it finishes.
 await e.DB.prepare(`INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,'fetch',?,?)
  ON CONFLICT(id) DO UPDATE SET
   payload=CASE WHEN jobs.status IN ('pending','running') THEN
    CASE WHEN EXISTS(SELECT 1 FROM json_each(jobs.payload,'$.waiters') WHERE json_extract(value,'$.message')=?) THEN jobs.payload
     ELSE json_insert(jobs.payload,'$.waiters[#]',json(?)) END ELSE excluded.payload END,
   status=CASE WHEN jobs.status IN ('pending','running') THEN jobs.status ELSE 'pending' END,
   attempts=CASE WHEN jobs.status IN ('pending','running') THEN jobs.attempts ELSE 0 END,
   lease_until=CASE WHEN jobs.status IN ('pending','running') THEN jobs.lease_until ELSE 0 END,error=NULL`)
  .bind(jobId,JSON.stringify(payload),now,message,JSON.stringify({group,message})).run();
 return {ok:false,status:'queued',job_id:jobId,next_action:'已排入本机只读队列，结果就绪后回复原消息；现在不要编造内容。'};
}
export async function reportReach(e:any,b:any):Promise<Response>{
 const now=Date.now();
 const row=await e.DB.prepare("SELECT * FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.source')='reach' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status IN ('done','failed'))")
  .bind(b.id,b.lease,now).first();
 if(!row)return Response.json({error:'lease conflict'},{status:409});
 const p=JSON.parse(row.payload),result=normalizeReachResult({channel:p.channel,action:p.action,backend:p.backend,source_url:p.source_url},row.status==='running'?b.result:p.result),status=result.ok?'done':'failed';
 if(row.status!=='running'&&row.status!==status)return Response.json({error:'lease conflict'},{status:409});
 const guard="id=? AND kind='fetch' AND json_extract(payload,'$.source')='reach' AND json_extract(payload,'$.lease')=? AND ((status='running' AND lease_until>?) OR status=?)";
 const args=[b.id,b.lease,now,status],writes=[];
 if(result.ok)writes.push(e.DB.prepare('INSERT OR REPLACE INTO media_notes SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE '+guard+')').bind(p.key,JSON.stringify(result),new Date(now).toISOString(),...args));
 const kind=result.error?.error_kind;
 if(row.status==='running'&&result.error&&(kind==='platform_blocked'||kind==='rate_limited')){
  const ms=kind==='platform_blocked'?p.cooldown_ms:(result.error.retry_after||3600)*1000;
  result.error.retry_after=Math.ceil(ms/1000);
  writes.push(e.DB.prepare("INSERT INTO settings(key,value) SELECT ?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE "+guard+") ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE COALESCE(json_extract(settings.value,'$.until'),0)<json_extract(excluded.value,'$.until')")
   .bind('reach:cooldown:'+p.channel,JSON.stringify({kind,until:now+ms}),...args));
 }
 // Drop execution-only signatures and store a bounded sanitized result for retry-safe reply recovery.
 writes.push(e.DB.prepare("UPDATE jobs SET status=?,error=?,payload=json_set(json_remove(payload,'$.target'),'$.result',json(?)) WHERE "+guard)
  .bind(status,kind||null,JSON.stringify(result),...args));
 await e.DB.batch(writes);
 const committed=await e.DB.prepare("SELECT payload FROM jobs WHERE id=? AND kind='fetch' AND json_extract(payload,'$.lease')=? AND status=?").bind(b.id,b.lease,status).first();
 if(!committed)return Response.json({error:'lease conflict'},{status:409});
 // Wake only from committed payload, never from the untrusted report. Deterministic job IDs prevent duplicate replies.
 const done=JSON.parse(committed.payload);
 for(const waiter of (done.waiters||[]).slice(0,10)){
  const id='reach-reply-'+b.id+'-'+waiter.message;
  await e.DB.prepare("INSERT OR IGNORE INTO jobs(id,kind,payload,created_at) SELECT ?,'reach_reply',?,? WHERE EXISTS(SELECT 1 FROM jobs WHERE "+guard+")")
   .bind(id,JSON.stringify({fetchId:b.id,group:waiter.group,message:waiter.message}),now,...args).run();
  await queueFor(e,'reach_reply')?.send({id});
 }
 return Response.json({ok:true});
}
