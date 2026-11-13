import {splitForQQ} from './split';
type Column={col:string};
type Enqueue={id:string;body:string;group:string|Column;msgId:string|null|Column;parts?:string[];from?:{sql:string;args:any[]}};
/** Return statements so guarded callers retain their original transaction. */
export function enqueueStatements(e:any,o:Enqueue):any[]{
 const now=Date.now();
 const parts=o.from ? [o.body.length>1800?o.body.slice(0,1799)+'…':o.body] : o.parts??splitForQQ(o.body,{max:1800,parts:3});
 return parts.map((body,i)=>{
  const args:any[]=[o.id+(i?'~'+i:'')];
  const value=(v:string|null|Column)=>typeof v==='object'&&v!==null?v.col:(args.push(v),'?');
  const group=value(o.group),msg=value(o.msgId);args.push(body,i?'held':'pending',now+i,...o.from?.args??[]);
  return e.DB.prepare(`INSERT OR IGNORE INTO outbox SELECT ?,${group},${msg},?,?,? ${o.from?.sql??'WHERE 1'}`).bind(...args);
 });
}
export async function enqueueText(e:any,o:Enqueue):Promise<void>{
 const statements=enqueueStatements(e,o);if(!statements.length)return;
 await e.DB.batch(statements);e.enqueued=true;
}
