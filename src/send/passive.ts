/** Numbered parameters shared by each statement: id, group, token, start. */
export const claimStamp = "EXISTS(SELECT 1 FROM outbox_send WHERE id=?1 AND lock_tok=?3 AND claimed_at=?4)";

/** Behavior reference: Mai-with-u/MaiBot@03347c9
 * src/plugins/built_in/qq_official_adapter/plugin.py::_claim_passive_fields (MIT).
 * Reimplementation of the v2 plan's D1-backed five-use passive ledger.
 * These statements must run inside the same batch as the lane lease and lock.
 */
export function passiveStatements(e: any, row: {id:string;group_id:string;msg_id?:string|null},
  claim: {tok:string;now:number;borrow:boolean;activeSeq:number|null}) {
  const args = [row.id,row.group_id,claim.tok,claim.now];
  return [
    e.DB.prepare(`INSERT INTO outbox_send(id,passive_msg_id,msg_seq)
      SELECT ?1,msg_id,used+1 FROM passive_claims
      WHERE msg_id=(SELECT msg_id FROM passive_claims
        WHERE group_id=?2 AND used<5 AND source_ts>?4-280000 AND (msg_id=?5 OR ?6=1)
        ORDER BY (msg_id=?5) DESC,source_ts DESC LIMIT 1) AND ${claimStamp}
      ON CONFLICT(id) DO UPDATE SET passive_msg_id=excluded.passive_msg_id,msg_seq=excluded.msg_seq
      WHERE outbox_send.msg_seq IS NULL`).bind(...args,row.msg_id??null,claim.borrow?1:0),
    e.DB.prepare(`UPDATE passive_claims SET used=used+1
      WHERE msg_id=(SELECT passive_msg_id FROM outbox_send WHERE id=?1)
      AND used+1=(SELECT msg_seq FROM outbox_send WHERE id=?1) AND ${claimStamp}`).bind(...args),
    e.DB.prepare(`UPDATE outbox_send SET msg_seq=?5,passive_msg_id=NULL
      WHERE id=?1 AND msg_seq IS NULL AND ?5 IS NOT NULL AND ${claimStamp}`).bind(...args,claim.activeSeq),
  ];
}
