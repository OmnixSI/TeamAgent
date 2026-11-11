import { TEAM } from './config';
import { fetchImage, describeBytes, sha256, IMAGE_MIME } from './vision';
import { budget } from './budget';
import { activity } from './runtime';
import { queueFor } from './lanes';
import { left } from './d1';

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
