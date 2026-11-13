/** The cron scanner and the actual queue consumer must apply the same age policy. */
export const AUTO_REPLY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const AUTO_REPLY_KINDS_SQL = "('chat','research','voice_notice','scout','video_reply','mention_receipt','semantic_reply','links','claim_notice','ci_triage')";

/** SQL expression shared by outbox selection and the atomic send claim.
 * ?1 is the current time. Allow 60s clock skew (enqueueVoice orders fragments with now+i);
 * timestamps further in the future cannot renew old rows.
 * Explicit long-work results retain their existing delivery semantics. */
export function outboxExpirySql(alias: string): string {
  const id = `${alias}.id`, created = `${alias}.created_at`;
  const sourceAt = `ROUND((julianday(m.ts)-2440587.5)*86400000)`;
  const source = `COALESCE((SELECT CASE WHEN ${sourceAt} BETWEEN 0 AND (?1+60000) THEN ${sourceAt} ELSE 0 END
    FROM messages m WHERE m.id=${alias}.msg_id AND m.group_id=${alias}.group_id),0)`;
  const reasonableCreated = `CASE WHEN ${created} BETWEEN 0 AND (?1+60000) THEN ${created} ELSE 0 END`;
  const due = `(SELECT r.due_at FROM schedule_runs r WHERE r.outbox_id=${id} LIMIT 1)`;
  return `CASE
    WHEN ${id} LIKE 'ready-%' OR ${id} LIKE 'media-result-%'
      OR ${id} LIKE 'delivery-notice-%' OR ${id} LIKE 'delivery-attention-%'
      OR EXISTS(SELECT 1 FROM jobs j WHERE j.id=${id} AND j.kind IN ('plan','media','dream')) THEN NULL
    WHEN ${id} LIKE 'sched-%' OR ${id} LIKE 'schedule-%' OR ${due} IS NOT NULL
      THEN COALESCE(${due},CASE WHEN length(${id})>13 AND substr(${id},-13) NOT GLOB '*[^0-9]*'
        THEN CAST(substr(${id},-13) AS INTEGER) END,${reasonableCreated})+7200000
    ELSE MAX(${reasonableCreated},${source})+${AUTO_REPLY_MAX_AGE_MS} END`;
}
