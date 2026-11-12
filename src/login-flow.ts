const SERVICES=['bili','x'];
const ACTIVE=['waiting','scanned'];
const PHASES=[...ACTIVE,'ok','expired','failed','cancelled'];
const TTL=300000,OFFLINE=120000;
const read=(raw?:string)=>{try{return JSON.parse(raw||'null');}catch{return null;}};
const json=(body:any,status=200)=>Response.json(body,{status,headers:{'Cache-Control':'no-store'}});
function display(s:any,now:number){
 if(!s||s.expires_at<=now)return null;
 return {id:s.id,service:s.service,phase:s.phase,claimed:!!s.claimed_at,started:s.started===true,updated_at:s.updated_at,expires_at:s.expires_at,
  ...(s.reason==='risk'?{reason:'risk'}:{})};
}
export async function loginState(e:any):Promise<Response>{
 // Remove display credentials retained by the old implementation, without reading them back.
 await e.DB.prepare("UPDATE settings SET value=json_remove(value,'$.qr_url') WHERE key IN ('login-flow:bili','login-flow:x') AND json_type(value,'$.qr_url') IS NOT NULL").run();
 const rows=(await e.DB.prepare("SELECT key,value FROM settings WHERE key IN ('login-flow:bili','login-flow:x','auth:bili','auth:x','fetcher:last-seen')").all()).results;
 const values=new Map<string,string>(rows.map((r:any)=>[r.key,r.value]));const now=Date.now();
 const services=Object.fromEntries(SERVICES.map(service=>{
  const old=read(values.get('auth:'+service)),auth=old&&['ok','missing','expired','risk'].includes(old.state)?{state:old.state,checked_at:old.checked_at}:null;
  return [service,{auth,flow:display(read(values.get('login-flow:'+service)),now)}];
 }));
 const seen=Number(values.get('fetcher:last-seen'))||0;
 return json({services,online:seen>0&&now-seen<OFFLINE,last_seen:seen?new Date(seen).toISOString():null});
}
export async function requestLogin(e:any,b:any):Promise<Response>{
 if(!SERVICES.includes(b?.service))return json({error:'invalid service'},400);
 const now=Date.now(),flow={id:crypto.randomUUID(),service:b.service,phase:'waiting',created_at:now,updated_at:new Date(now).toISOString(),expires_at:now+TTL};
 const row=await e.DB.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
  WHERE json_extract(settings.value,'$.expires_at')<=? OR json_extract(settings.value,'$.phase') NOT IN ('waiting','scanned') RETURNING value`)
  .bind('login-flow:'+b.service,JSON.stringify(flow),now).first();
 return row?json({flow:display(flow,now)}):json({error:'该服务正在登录，请完成或取消已有登录'},409);
}
export async function cancelLogin(e:any,b:any):Promise<Response>{
 if(!SERVICES.includes(b?.service)||typeof b.id!=='string')return json({error:'invalid request'},400);
 const now=Date.now();
 const row=await e.DB.prepare(`UPDATE settings SET value=json_remove(json_set(value,'$.phase','cancelled','$.updated_at',?),'$.qr_url')
  WHERE key=? AND json_extract(value,'$.id')=? AND json_extract(value,'$.expires_at')>? AND json_extract(value,'$.phase') IN ('waiting','scanned') RETURNING value`)
  .bind(new Date(now).toISOString(),'login-flow:'+b.service,b.id,now).first();
 return row?json({flow:display(read(row.value),now)}):json({error:'登录请求已变化，请刷新'},409);
}
export async function fetcherSeen(e:any):Promise<void>{
 await e.DB.prepare("INSERT INTO settings VALUES('fetcher:last-seen',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(String(Date.now())).run();
}
export async function claimLogin(e:any):Promise<any>{
 const now=Date.now();
 const row=await e.DB.prepare(`UPDATE settings SET value=json_set(value,'$.claimed_at',?) WHERE key=(
  SELECT key FROM settings WHERE key IN ('login-flow:bili','login-flow:x') AND json_extract(value,'$.phase')='waiting'
  AND json_extract(value,'$.expires_at')>? AND json_extract(value,'$.claimed_at') IS NULL ORDER BY json_extract(value,'$.created_at') LIMIT 1) RETURNING value`)
  .bind(now,now).first();
 if(!row)return null;const s=read(row.value);return {id:s.id,service:s.service,expires_at:s.expires_at};
}
export async function reportLogin(e:any,b:any):Promise<Response>{
 if(!SERVICES.includes(b?.service)||typeof b.id!=='string'||!PHASES.includes(b.phase))return json({error:'invalid login state'},400);
 if(Object.keys(b).some(k=>!['id','service','phase','reason'].includes(k)))return json({error:'only login progress is accepted'},400);
 const now=Date.now();
 // Fixed fields only. Neither unknown keys nor arbitrary error messages enter D1 or a response.
 const row=await e.DB.prepare(`UPDATE settings SET value=json_patch(json_remove(value,'$.qr_url','$.reason'),?)
  WHERE key=? AND json_extract(value,'$.id')=? AND json_extract(value,'$.claimed_at') IS NOT NULL
  AND json_extract(value,'$.expires_at')>? AND json_extract(value,'$.phase') IN ('waiting','scanned') RETURNING value`)
  .bind(JSON.stringify({phase:b.phase,started:true,updated_at:new Date(now).toISOString(),...(b.phase==='failed'&&b.reason==='risk'?{reason:'risk'}:{})}),
   'login-flow:'+b.service,b.id,now).first();
 if(!row)return json({error:'登录已取消或过期'},409);
 await fetcherSeen(e);return json({ok:true});
}
