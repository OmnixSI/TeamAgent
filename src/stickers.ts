import { TEAM } from './config';
import { fetchImage, describeBytes, sha256, IMAGE_MIME, b64 } from './vision';
import { budget } from './budget';
import { activity } from './runtime';
import { queueFor } from './lanes';
import { left } from './d1';
import {sendOutcome} from './send/codes';

const cfg = TEAM.stickers;
export const stickerSendOn = (sw: Record<string,string|undefined>, now: number) =>
  cfg?.send === true && sw['off:sticker_send'] !== '1' && !(Number(sw.sticker_paused_until || 0) > now);

async function enqueue(e: any, id: string, kind: string, payload: any) {
  await e.DB.prepare('INSERT OR IGNORE INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)')
    .bind(id,kind,JSON.stringify(payload),Date.now()).run();
  await queueFor(e,kind)?.send({id});
}
async function prune(e: any) {
  await e.DB.prepare("DELETE FROM stickers WHERE state=0 AND json_array_length(senders)=1 AND created_at<? AND (SELECT COUNT(*) FROM stickers)>=?")
    .bind(Date.now()-30*86400000,cfg.max_rows).run();
}
/** The INSERT checks capacity atomically, including simultaneous new hashes. */
export async function collectSticker(e: any, p: any) {
  const fetched=await fetchImage(p.url,AbortSignal.timeout(8000),cfg.max_bytes);
  if(!fetched)return;
  const sha=await sha256(fetched.bytes);
  await prune(e);
  const row=await e.DB.prepare(`INSERT INTO stickers(sha,mime,bytes,data,senders,source_message,created_at)
    SELECT ?1,?2,?3,?4,json_array(?5),?6,?7
    WHERE EXISTS(SELECT 1 FROM stickers WHERE sha=?1) OR (SELECT COUNT(*) FROM stickers)<?8
    ON CONFLICT(sha) DO UPDATE SET seen=stickers.seen+1,
      senders=CASE WHEN EXISTS(SELECT 1 FROM json_each(stickers.senders) WHERE value=?5) OR json_array_length(stickers.senders)>=5
        THEN stickers.senders ELSE json_insert(stickers.senders,'$[#]',?5) END RETURNING sha`)
    .bind(sha,fetched.mime,fetched.bytes.length,fetched.bytes.buffer.slice(fetched.bytes.byteOffset,fetched.bytes.byteOffset+fetched.bytes.byteLength),p.sender,p.message,Date.now(),cfg.max_rows).first();
  if(!row){await activity(e,'sticker.full','stickers','Bot','表情库已满，本次图片未收集');return;}
  const promoted=await e.DB.prepare('UPDATE stickers SET state=1 WHERE sha=? AND state=0 AND json_array_length(senders)>=? RETURNING sha')
    .bind(sha,cfg.min_senders).first();
  if(promoted)await enqueue(e,'sticker-tag-'+sha,'sticker-tag',{sha});
}
export async function tagSticker(e: any, p: {sha:string}) {
  const row=await e.DB.prepare('SELECT * FROM stickers WHERE sha=? AND state=1').bind(p.sha).first();
  if(!row||!(await budget(e,'sticker_tag',cfg.caps.tag)))return;
  const note=await describeBytes(e,new Uint8Array(row.data),row.mime,'这是群聊里大家发过的表情包。描述它表达的情绪、语气和适合接在什么话后面。',AbortSignal.timeout(10000));
  if(!note)return;
  await e.DB.prepare('UPDATE stickers SET state=?,desc=?,tags=?,tagged_at=? WHERE sha=? AND state=1')
    .bind(note.meme?2:3,note.desc,JSON.stringify(note.tags||[]),Date.now(),p.sha).run();
}
export async function retryStickerTags(e: any) {
  const now=new Date(Date.now());
  if(!cfg.enabled||now.getUTCMinutes()!==7||left(e)<2)return;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:TEAM.memory.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  const rows=(await e.DB.prepare('SELECT sha FROM stickers WHERE state=1 ORDER BY created_at,sha LIMIT 10').all()).results;
  for(const r of rows){if(left(e)<2)break;await enqueue(e,'sticker-tag-'+r.sha+'-'+date,'sticker-tag',{sha:r.sha});}
}
export async function importSticker(e: any, b: any): Promise<Response> {
  if(!IMAGE_MIME.has(b.mime)||typeof b.data_base64!=='string'||!b.data_base64||b.data_base64.length>4*Math.ceil(cfg.max_bytes/3))return Response.json({error:'invalid image'}, {status:400});
  let data:Uint8Array;
  try{data=Uint8Array.from(atob(b.data_base64),c=>c.charCodeAt(0));}catch{return Response.json({error:'invalid image'},{status:400});}
  if(!data.length||data.length>cfg.max_bytes)return Response.json({error:'invalid image'},{status:400});
  const sha=await sha256(data);await prune(e);
  const row=await e.DB.prepare(`INSERT INTO stickers(sha,mime,bytes,data,state,senders,created_at)
    SELECT ?1,?2,?3,?4,1,'[]',?5 WHERE EXISTS(SELECT 1 FROM stickers WHERE sha=?1) OR (SELECT COUNT(*) FROM stickers)<?6
    ON CONFLICT(sha) DO UPDATE SET state=1 RETURNING sha,state`)
    .bind(sha,b.mime,data.length,data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength),Date.now(),cfg.max_rows).first();
  if(!row)return Response.json({error:'sticker storage full'},{status:409});
  await enqueue(e,'sticker-tag-'+sha,'sticker-tag',{sha});return Response.json(row);
}

const bigrams = (text: string) => {
  const chars=Array.from(text.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu,''));
  return new Set(chars.slice(1).map((c,i)=>chars[i]+c));
};
export async function pickSticker(e: any, keyword: string): Promise<string|null> {
  const wanted=bigrams(keyword);if(!wanted.size)return null;
  const rows=(await e.DB.prepare("SELECT sha,desc,tags FROM stickers WHERE state=2 AND (used_at IS NULL OR used_at<?) AND (? OR mime!='image/gif') ORDER BY uses,created_at,sha LIMIT 200")
    .bind(Date.now()-86400000,cfg.send_gif?1:0).all()).results;
  let best:string|null=null,score=0.2;
  for(const row of rows){
    let tags:any=[];try{tags=JSON.parse(row.tags||'[]');}catch{}
    const found=bigrams(String(row.desc||'')+' '+(Array.isArray(tags)?tags.join(' '):''));
    const n=[...wanted].filter(x=>found.has(x)).length,similarity=n/(wanted.size+found.size-n||1);
    if(similarity>=score && (best===null||similarity>score)){best=row.sha;score=similarity;}
  }
  return best;
}
/** Fence all three writes by the unused image, in the same D1 transaction. */
export async function enqueueSticker(e: any, x:{id:string;group:string;message:string|null;sha:string;createdAt:number}) {
  const now=Date.now(),old=now-86400000,id=x.id+'~s';
  await e.DB.batch([
    e.DB.prepare(`INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at)
      SELECT ?,?,?,'[表情]','pending',? WHERE EXISTS(SELECT 1 FROM stickers WHERE sha=? AND state=2 AND (used_at IS NULL OR used_at<?))`)
      .bind(id,x.group,x.message,x.createdAt,x.sha,old),
    e.DB.prepare('INSERT OR IGNORE INTO outbox_meta(id,json) SELECT ?,? WHERE EXISTS(SELECT 1 FROM outbox WHERE id=?)')
      .bind(id,JSON.stringify({sticker:x.sha}),id),
    e.DB.prepare('UPDATE stickers SET used_at=?,uses=uses+1 WHERE sha=? AND (used_at IS NULL OR used_at<?) AND EXISTS(SELECT 1 FROM outbox WHERE id=?)')
      .bind(now,x.sha,old,id),
  ]);
}
/** The caller owns the lane, passive pair and fenced outbox receipt. */
export async function sendSticker(e:any,o:any,token:string,msgId:string|null,sw:Record<string,string|undefined>,sequence:number,claim:{tok:string;now:number}):Promise<{http:number|null;result:any;skipped?:boolean}> {
  if(!stickerSendOn(sw,Date.now()))return {http:null,result:undefined,skipped:true};
  const stamp="EXISTS(SELECT 1 FROM outbox_send WHERE id=? AND lock_tok=? AND claimed_at=?)";
  const fence=[o.id,claim.tok,claim.now];
  let http:number|null=null,result:any;
  try{
    const meta=JSON.parse(o.meta||'{}'),row=await e.DB.prepare('SELECT * FROM stickers WHERE sha=? AND state=2').bind(meta.sticker).first();
    if(!row)return {http:null,result:undefined,skipped:true};
    let fileInfo=row.file_info_expires>Date.now()+60000?row.file_info:null;
    const post=async(path:string,body:any)=>{
      http=null;result=undefined;
      const r=await fetch('https://api.bot.qq.com/v2/groups/'+encodeURIComponent(o.group_id)+path,{method:'POST',headers:{Authorization:'QQBot '+token,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(20000),redirect:'manual'});
      http=r.status;result=undefined;try{result=await r.json();}catch{}
      return r;
    };
    if(!fileInfo){
      const r=await post('/files',{file_type:1,file_data:b64(new Uint8Array(row.data)),srv_send_msg:false});
      if(!r.ok||typeof result?.file_info!=='string'||!result.file_info||(result.code!==undefined&&result.code!==0))throw Error('upload not accepted');
      fileInfo=result.file_info;
      const ttl=Number(result.ttl)>0&&Number.isFinite(Number(result.ttl))?Number(result.ttl):3600;
      await e.DB.prepare('UPDATE stickers SET file_info=?,file_info_expires=? WHERE sha=? AND '+stamp).bind(fileInfo,Date.now()+ttl*1000,row.sha,...fence).run();
    }
    await post('/messages',{msg_type:7,media:{file_info:fileInfo},...(msgId?{msg_id:msgId}:{}),msg_seq:sequence});
  }catch{}
  const ok=sendOutcome(http??0,result,false)==='sent';
  const counted=await e.DB.batch([ok
    ?e.DB.prepare("UPDATE settings SET value='0' WHERE key='sticker_fail' AND "+stamp).bind(...fence)
    :e.DB.prepare("INSERT INTO settings SELECT 'sticker_fail','1' WHERE "+stamp+" ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value").bind(...fence)]);
  if(!ok&&Number(counted[0]?.results?.[0]?.value)>=3){
    const until=String(Date.now()+86400000);
    await e.DB.batch([
      e.DB.prepare("INSERT INTO settings SELECT 'sticker_paused_until',? WHERE "+stamp+" ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(until,...fence),
      e.DB.prepare("UPDATE settings SET value='0' WHERE key='sticker_fail' AND "+stamp).bind(...fence),
      e.DB.prepare("INSERT INTO activity SELECT ?,'sticker.paused','stickers','Bot',?,? WHERE "+stamp).bind(crypto.randomUUID(),'表情连续发送失败，已暂停一天',new Date().toISOString(),...fence),
    ]);
    sw.sticker_paused_until=until;
  }
  return {http,result};
}
