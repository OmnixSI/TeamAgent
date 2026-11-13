import {left} from './d1';
export const RELEASE_NOTE={version:'V-A',text:'这次新加了：事件层升级，收发更稳、同一条消息不重复发；末尾提示可用 off:release_note 关闭'};
export async function replyReleaseNote(e:any,group:string):Promise<string|null>{
 // One read + one atomic reservation; the caller reserves its tail.
 if(left(e)<3)return null;
 const rows=(await e.DB.prepare("SELECT key,value FROM settings WHERE key IN ('off:release_note',?)").bind('release_seen:'+group).all()).results;
 const off=rows.find((r:any)=>r.key==='off:release_note')?.value,seen=rows.find((r:any)=>r.key==='release_seen:'+group)?.value;
 if(off==='1'||seen===RELEASE_NOTE.version)return null;
 const reserved:any=await e.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value').bind('release_seen:'+group,RELEASE_NOTE.version).run();
 return ((reserved?.meta?.changes??reserved?.changes)===1)?RELEASE_NOTE.text:null;
}
