import {claimStamp,passiveStatements} from './passive';

export function prevId(id:string):string|null {
  const part=/~([12])$/.exec(id);
  return part ? id.slice(0,-2)+(part[1]==='1'?'':'~1') : null;
}

/** One indivisible D1 batch: lease, stamp, lock, passive pair, quota, fallback, read. */
export function claimStatements(e:any,row:{id:string;group_id:string;msg_id?:string|null},
  claim:{tok:string;now:number;borrow:boolean;activeSeq:number|null;unknownResend:boolean}) {
  const states=claim.unknownResend?"'pending','retry','held','unknown'":"'pending','retry','held'";
  const args=[row.id,row.group_id,claim.tok,claim.now];
  return [
    e.DB.prepare(`INSERT INTO send_lanes VALUES(?1,?2,?3+90000)
      ON CONFLICT(group_id) DO UPDATE SET holder=excluded.holder,lease_until=excluded.lease_until
      WHERE send_lanes.lease_until<?3 OR send_lanes.holder=?2`).bind(row.group_id,claim.tok,claim.now),
    e.DB.prepare(`INSERT INTO outbox_send(id,lock_tok,claimed_at) SELECT ?1,?3,?4
      WHERE EXISTS(SELECT 1 FROM send_lanes WHERE group_id=?2 AND holder=?3)
      AND EXISTS(SELECT 1 FROM outbox o LEFT JOIN outbox_send s ON s.id=o.id
        WHERE o.id=?1 AND COALESCE(s.not_before,0)<=?4
        AND (o.status IN ('pending','retry','held')${claim.unknownResend?" OR (o.status='unknown' AND s.msg_seq IS NOT NULL AND s.tries<2)":''}))
      AND (?5 IS NULL OR EXISTS(SELECT 1 FROM outbox WHERE id=?5 AND status='sent'))
      AND NOT EXISTS(SELECT 1 FROM outbox WHERE group_id=?2 AND status='sending' AND id!=?1)
      ON CONFLICT(id) DO UPDATE SET lock_tok=excluded.lock_tok,claimed_at=excluded.claimed_at`).bind(...args,prevId(row.id)),
    e.DB.prepare(`UPDATE outbox SET status='sending' WHERE id=?1 AND status IN (${states}) AND ${claimStamp} RETURNING id`).bind(...args),
    ...passiveStatements(e,row,claim),
    e.DB.prepare(`SELECT passive_msg_id,msg_seq,tries,reason FROM outbox_send WHERE id=?1 AND ${claimStamp}`).bind(...args),
  ];
}

export function releaseStatement(e:any,group:string,tok:string) {
  return e.DB.prepare('UPDATE send_lanes SET lease_until=0 WHERE group_id=? AND holder=?').bind(group,tok);
}

export const recoverSendingSQL = `UPDATE outbox SET status=CASE
  WHEN EXISTS(SELECT 1 FROM outbox_send s WHERE s.id=outbox.id AND s.claimed_at IS NOT NULL AND s.msg_seq IS NULL)
  THEN 'retry' ELSE 'unknown' END
  WHERE status='sending' AND (id IN (SELECT id FROM outbox_send WHERE claimed_at<?1)
  OR (id NOT IN (SELECT id FROM outbox_send WHERE claimed_at IS NOT NULL)
  AND id IN (SELECT id FROM outbox_attempts WHERE started_at<?1)))`;

/** Every receipt mutation is fenced by the exact claim, including late replies. */
export function resultStatements(e:any,row:{id:string;group_id:string},claim:{tok:string;now:number},
 r:{status:string;reason:string|null;http:number|null;code:string;notBefore:number;clearPair?:boolean;refIdx?:string;reference?:boolean;passiveInvalid?:string|null;mutedUntil?:number}):any[]{
 const args=[row.id,row.group_id,claim.tok,claim.now];
 const p=(sql:string,...values:any[])=>e.DB.prepare(sql).bind(...args,...values);
 const ss=[
  p(`UPDATE outbox SET status=?5 WHERE id=?1 AND status IN ('sending','unknown') AND ${claimStamp}`,r.status),
  p(`INSERT OR REPLACE INTO outbox_attempts(id,started_at,http_status,code) SELECT ?1,?4,?5,?6 WHERE ${claimStamp}`,r.http,r.code),
  p(`UPDATE outbox_send SET tries=tries+1,reason=?5,not_before=?6${r.clearPair?',msg_seq=NULL,passive_msg_id=NULL':''} WHERE id=?1 AND ${claimStamp}`,r.reason,r.notBefore),
 ];
 if(r.status==='sent'&&r.refIdx)ss.push(p(`INSERT OR IGNORE INTO message_refs SELECT ?5,'bot',?1,?2,?4 WHERE ${claimStamp}`,r.refIdx));
 else if(r.passiveInvalid)ss.push(p(`UPDATE passive_claims SET used=5 WHERE msg_id=?5 AND ${claimStamp}`,r.passiveInvalid));
 if(r.reference&&(r.status==='sent'||r.reason==='ref_invalid')){
  ss.push(r.reason==='ref_invalid'
   ?p(`INSERT INTO settings SELECT 'quote_fail','1' WHERE ${claimStamp} ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value`)
   :p(`UPDATE settings SET value='0' WHERE key='quote_fail' AND value!='0' AND ${claimStamp}`));
 }
 if(r.mutedUntil)ss.push(p(`INSERT INTO settings SELECT 'qq:muted_until',CAST(?5 AS TEXT) WHERE ${claimStamp} ON CONFLICT(key) DO UPDATE SET value=excluded.value`,r.mutedUntil));
 ss.push(p(`UPDATE send_lanes SET lease_until=0 WHERE group_id=?2 AND holder=?3 AND ${claimStamp}`));
 return ss;
}

const predecessor=`CASE WHEN o.id LIKE '%~1' THEN substr(o.id,1,length(o.id)-2) ELSE substr(o.id,1,length(o.id)-1)||(CAST(substr(o.id,length(o.id)) AS INTEGER)-1) END`;
export function readyRowsSQL(unknownResend:boolean):string{
 return `SELECT o.*,om.json AS meta,s.passive_msg_id,s.msg_seq,s.tries,s.reason,m.ts AS src_ts,
  (SELECT p.status FROM outbox p WHERE p.id=${predecessor}) AS prev_status
  FROM outbox o LEFT JOIN outbox_meta om ON om.id=o.id
  LEFT JOIN outbox_send s ON s.id=o.id LEFT JOIN messages m ON m.id=o.msg_id
  WHERE (o.status IN ('pending','retry','held') AND COALESCE(s.not_before,0)<=?1
  AND (o.status!='held' OR EXISTS(SELECT 1 FROM outbox p WHERE p.id=${predecessor} AND p.status IN ('sent','failed','skipped')))
  ${unknownResend?"OR (o.status='unknown' AND s.msg_seq IS NOT NULL AND s.tries<2)":''})
  ORDER BY o.created_at,o.id LIMIT 4`;
}
