import { dsGuard, billedChars, DS_PRICES, DS_PRICE_KEYS } from './deepseek-tools';
import { messageSequence } from './voice';
const response = (body:any,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
export async function voiceAvailable(e:any):Promise<boolean> {
  return !!await e.DB.prepare("SELECT 1 FROM outbox WHERE status IN ('voice','voice_sending') LIMIT 1").first();
}
export async function pullVoiceOutbox(e:any) {
  // A lost runner or lost report is uncertain, never a reason to send again.
  await e.DB.prepare("UPDATE outbox SET status='unknown' WHERE status='voice_sending' AND id IN (SELECT id FROM outbox_attempts WHERE started_at<?)").bind(Date.now()-240000).run();
  const rows = (await e.DB.prepare(`SELECT o.*,om.json,m.ts FROM outbox o
    LEFT JOIN outbox_meta om ON om.id=o.id LEFT JOIN messages m ON m.id=o.msg_id AND m.group_id=o.group_id
    WHERE o.status='voice' ORDER BY o.created_at LIMIT 2`).all()).results;
  const items:any[]=[];
  for (const o of rows) {
    if (o.msg_id && (!o.ts || !(Date.now()-Date.parse(o.ts)<240000))) {
      await e.DB.prepare("UPDATE outbox SET status='skipped' WHERE id=? AND status='voice'").bind(o.id).run();continue;
    }
    // Persist the attempt before the claim, so a crash never leaves a claim
    // without a timestamp for recovery. Only the CAS winner receives the item.
    await e.DB.prepare("INSERT OR IGNORE INTO outbox_attempts(id,started_at) VALUES(?,?)").bind(o.id,Date.now()).run();
    const claim = await e.DB.prepare("UPDATE outbox SET status='voice_sending' WHERE id=? AND status='voice' RETURNING id").bind(o.id).first();
    if (!claim) continue;
    let meta:any;try {meta=JSON.parse(o.json||'{}');}catch {meta={};}
    const guard = await dsGuard(e,{purpose:'tts',group:o.group_id,sender:String(meta.sender||'')});
    if (!guard.ok) {
      await e.DB.batch([
        e.DB.prepare("UPDATE outbox SET status='pending' WHERE id=? AND status='voice_sending'").bind(o.id),
        e.DB.prepare("UPDATE outbox_attempts SET code=? WHERE id=?").bind('voice:'+('error_kind' in guard?guard.error_kind:'quota'),o.id),
      ]);continue;
    }
    items.push({id:o.id,group_id:o.group_id,text:o.body,msg_id:o.msg_id,msg_seq:messageSequence(o.id),expires_at:o.msg_id?Date.parse(o.ts)+240000:undefined,cfg:{...meta.cfg,enabled:true}});
  }
  return {items};
}
export async function reportVoice(e:any,b:any):Promise<Response> {
  if (!b || typeof b.id!=='string' || !['sent','failed','unknown'].includes(b.status)) return response({error:'invalid voice report'},400);
  const row = await e.DB.prepare(`SELECT o.group_id,o.body,om.json,
    (SELECT value FROM settings WHERE key=?) AS price FROM outbox o LEFT JOIN outbox_meta om ON om.id=o.id
    WHERE o.id=? AND o.status='voice_sending'`).bind(DS_PRICE_KEYS.tts_micro_usd_per_10k_chars,b.id).first();
  if (!row) return response({ok:true,updated:false});
  let meta:any;try {meta=JSON.parse(row.json||'{}');}catch {meta={};}
  const units = b.provider === 'deepseek' && b.cached !== true ? billedChars(row.body) : 0;
  const rawPrice = Number(row.price);
  const price = row.price != null && Number.isFinite(rawPrice) && rawPrice >= 0 ? rawPrice : DS_PRICES.tts_micro_usd_per_10k_chars;
  const latency = Math.max(0,Math.min(240000,Math.round(Number(b.latency_ms)||0)));
  const ttsOk = b.status === 'sent' && b.via === 'voice';
  const errorKind = ttsOk ? null : ['quota','auth','timeout','unsupported','too_large','refused','denied'].includes(b.reason) ? b.reason : 'upstream';
  const via = b.via==='voice'?'voice':b.via==='text'?'text':'unknown';
  const active = "EXISTS(SELECT 1 FROM outbox WHERE id=? AND status='voice_sending')";
  // D1 batch is transactional. Audit, billing and terminal state either all
  // commit, or the claim remains recoverable; concurrent reports have one winner.
  const results = await e.DB.batch([
    e.DB.prepare("INSERT OR IGNORE INTO ds_usage(id,purpose,group_id,sender_id,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) SELECT ?, 'tts', ?, ?, ?, ?, ?, ?, ?, ? WHERE " + active)
      .bind('voice:'+b.id,row.group_id,String(meta.sender||''),ttsOk?'ok':'failed',errorKind,latency,units,Math.ceil(units*price/10000),Date.now(),b.id),
    e.DB.prepare("INSERT INTO tool_calls(group_id,turn_id,name,args_hash,status,error_kind,latency_ms,created_at) SELECT ?,?,'tts_reply','',?,?,?,? WHERE " + active)
      .bind(row.group_id,b.id,ttsOk?'ok':'failed',errorKind,latency,Date.now(),b.id),
    e.DB.prepare("UPDATE outbox_attempts SET code=? WHERE id=? AND " + active).bind('voice:'+b.status+':'+via,b.id,b.id),
    e.DB.prepare("UPDATE outbox SET status=? WHERE id=? AND status='voice_sending' RETURNING id").bind(b.status,b.id),
  ]);
  return response({ok:true,updated:!!results.at(-1)?.results?.length});
}
