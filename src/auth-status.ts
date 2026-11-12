import {left} from './d1';

const services=['bili','x'] as const;
const labels={bili:'B 站',x:'X'};
type Service=typeof services[number];
function parse(value?: string){try{return JSON.parse(value||'{}');}catch{return {};}}
export async function recordAuthStatus(e:any,b:any):Promise<Response>{
 if(!services.includes(b.service)||!['ok','expired','risk','missing'].includes(b.state))return Response.json({error:'invalid auth state'},{status:400});
 const key='auth:'+b.service,old=await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
 const previous=parse(old?.value),checked=typeof b.checked_at==='string'?Date.parse(b.checked_at):NaN;
 const state={state:b.state,checked_at:new Date(Number.isFinite(checked)?checked:Date.now()).toISOString(),had_ok:b.state==='ok'||previous.had_ok===true};
 const writes=[e.DB.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,JSON.stringify(state))];
 if(b.state==='ok')writes.push(e.DB.prepare('DELETE FROM settings WHERE key=?').bind('auth-reminded:'+b.service));
 await e.DB.batch(writes);return Response.json({ok:true});
}
async function claim(e:any,service:Service,state:any,outboxId?:string):Promise<string|null>{
 if(state.had_ok!==true||!['expired','risk'].includes(state.state)||left(e)<1)return null;
 const now=Date.now();
 const reserved=await e.DB.prepare(`INSERT INTO settings(key,value)
  SELECT ?,? WHERE EXISTS(SELECT 1 FROM settings WHERE key=? AND json_extract(value,'$.had_ok')=1 AND json_extract(value,'$.state') IN ('expired','risk'))
  AND NOT EXISTS(SELECT 1 FROM outbox WHERE id=?)
  ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(settings.value AS INTEGER)<=? RETURNING value`)
  .bind('auth-reminded:'+service,String(now),'auth:'+service,outboxId||'',now-86400000).first();
 return reserved?'（顺便：我的 '+labels[service]+' 登录过期了，有空在 Mac 上双击桌面「TeamAgent-登录」重新登一下）':null;
}
export async function authReminder(e:any,service:Service):Promise<string|null>{
 if(!services.includes(service)||left(e)<2)return null;
 const row=await e.DB.prepare('SELECT value FROM settings WHERE key=?').bind('auth:'+service).first();
 return claim(e,service,parse(row?.value));
}
export async function replyAuthReminders(e:any,outboxId:string):Promise<string[]>{
 // One read + at most two atomic reservations; the caller reserves its tail.
 if(left(e)<3)return [];
 const snapshot:Record<string,string>=e.authStates ?? Object.fromEntries((await e.DB.prepare("SELECT key,value FROM settings WHERE key IN ('auth:bili','auth:x')").all()).results.map((r:any)=>[r.key,r.value]));
 const states=new Map<string,any>(Object.entries(snapshot).map(([key,value])=>[key,parse(value)]));
 const lines:string[]=[];
 for(const service of services){const line=await claim(e,service,states.get('auth:'+service)||{},outboxId);if(line)lines.push(line);}
 return lines;
}
