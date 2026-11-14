import { queueFor } from './lanes';
import type { Decision } from './rhythm';

export const RECOVERY_MAX_AGE_MS = 15 * 60 * 1000;

// 「我的日报呢」「怎么还没发」是在追已经答应过的东西，等于对 bot 说话；
// 不把它算 addressed，hard_unanswered 闸会把这条追问埋掉（RC-03）。
const CHASE_RE = /我的.{0,4}(日报|周报|总结|推送|提醒|余额|账本|清单).{0,4}(呢|怎么|还没)|怎么(还)?没发/;
export function chasingDeliverable(body: unknown): boolean {
  return CHASE_RE.test(String(body || ''));
}
// 「机器人可以每天…吗」是在问 bot 本人，不是群友互相聊天（RC-07）。
const TO_BOT_RE = /^(?:机器人|助手|bot)[，,：:\s]*(?:你)?(?:可以|能不能|能|会|帮|给我|在)/i;
export function addressedMessages(context: any): any[] {
  const rows = [...(context.batch || []), ...(context.latest ? [context.latest] : [])];
  const explicit = rows.filter(
    (m: any) =>
      m.mentioned ||
      m.meta?.replyTo?.kind === 'bot' ||
      chasingDeliverable(m.body) ||
      TO_BOT_RE.test(String(m.body || '').trim()),
  );
  if (!explicit.length && context.mentioned && context.latest) explicit.push(context.latest);
  return [...new Map<string, any>(explicit.map((m: any) => [m.id, m])).values()];
}
export function guardMentionDecision(decision: Decision, context: any): Decision {
  return context.mentioned || addressedMessages(context).length ? { ...decision, action: 'reply', kind: 'direct', waitSeconds: undefined } : decision;
}
async function wake(e: any, id: string): Promise<void> {
  try { const lane = queueFor(e, 'chat'); if (lane) await lane.send({id}); }
  catch { /* Persisted jobs are rediscovered by scheduled() when the queue recovers. */ }
}
// A completed batched reply also covers the addressed source, even if msg_id points to its tail.
const noOutbox = `NOT EXISTS (SELECT 1 FROM outbox o WHERE o.group_id=m.group_id AND
  (o.msg_id=m.id OR o.id IN (SELECT d.outbox_id FROM chat_decisions d
    WHERE d.group_id=m.group_id AND (d.latest_id=m.id OR EXISTS (SELECT 1 FROM json_each(d.batch_ids) b WHERE b.value=m.id)))))`;
const noTerminal = `NOT EXISTS (SELECT 1 FROM chat_decisions d WHERE d.group_id=m.group_id
  AND d.action IN ('reply','dup') AND (d.latest_id=m.id OR EXISTS (SELECT 1 FROM json_each(d.batch_ids) b WHERE b.value=m.id)))`;
const addressed = `(m.mentioned=1 OR json_extract(mm.json,'$.replyTo.kind')='bot')`;

/** Durable outbox id is the receipt claim: insertion, metadata and sender wakeup are atomic. */
export async function mentionReceipt(e: any, source: any, now = Date.now()): Promise<void> {
  const id = 'mention-receipt:' + source.id;
  const task = String(source.body || '这条消息').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 60) || '这条消息';
  const result = await e.DB.batch([
    e.DB.prepare(`INSERT OR IGNORE INTO outbox(id,group_id,msg_id,body,status,created_at)
      SELECT ?,m.group_id,m.id,?,'pending',? FROM messages m WHERE m.id=? AND ${noOutbox} AND ${noTerminal} RETURNING id`)
      .bind(id, '在做：' + task, now, source.id),
    e.DB.prepare(`INSERT OR IGNORE INTO outbox_meta(id,json) SELECT ?,? WHERE EXISTS (SELECT 1 FROM outbox WHERE id=?)`)
      .bind(id, JSON.stringify({kind:'mention_receipt',source_id:source.id}), id),
    e.DB.prepare(`INSERT OR IGNORE INTO jobs(id,kind,payload,created_at)
      SELECT ?,'mention_receipt',?,? WHERE EXISTS (SELECT 1 FROM outbox WHERE id=? AND status='pending')`)
      .bind(id, JSON.stringify({message:source.id}), now, id),
  ]);
  if (result[0].results?.length) {
    // Own queue invocation sends the receipt even while the original model call is blocked.
    await wake(e, id);
  }
}

/** Model/tool latency must not hold the first response hostage. Always clean up the timer. */
export async function withMentionReceipt<T>(e: any, context: any, run: () => Promise<T>): Promise<T> {
  const sources = addressedMessages(context);
  if (!sources.length) return run();
  let receipt: Promise<void> | undefined;
  const startedAt = Math.min(...sources.map(m => Date.parse(m.ts) || Date.now()));
  const timer = setTimeout(() => {
    receipt = (async () => { for (const source of sources) await mentionReceipt(e, source); })()
      .catch(() => { /* The durable scheduled watchdog is the independent recovery route. */ });
  }, Math.max(0, 45000 - (Date.now() - startedAt)));
  try { return await run(); }
  finally { clearTimeout(timer); if (receipt) await receipt; }
}

/** Called first in scheduled(), before maintenance can consume the D1 statement budget. */
export async function sweepMentions(e: any, now = Date.now()): Promise<void> {
  if ((await e.DB.prepare("SELECT value FROM settings WHERE key='off:mention_recovery'").first())?.value === '1') return;
  const rows = (await e.DB.prepare(`WITH candidates AS (SELECT m.*,
    EXISTS (SELECT 1 FROM jobs j WHERE j.status IN ('pending','running') AND
      (json_extract(j.payload,'$.message')=m.id OR json_extract(j.payload,'$.latestId')=m.id
        OR json_extract(j.payload,'$.source_id')=m.id)) AS active
    FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id
    WHERE ${addressed} AND julianday(m.ts)>=julianday(?) AND julianday(m.ts)<=julianday(?) AND ${noOutbox} AND ${noTerminal}
      AND COALESCE((SELECT CAST(json_extract(value,'$.attempts') AS INTEGER) FROM settings WHERE key='mention-recovery:'||m.id),0)<2
      AND COALESCE((SELECT CAST(json_extract(value,'$.at') AS INTEGER) FROM settings WHERE key='mention-recovery:'||m.id),0)<=?
    ) SELECT * FROM candidates WHERE julianday(ts)<=julianday(?) OR active ORDER BY julianday(ts),id LIMIT 1`)
    .bind(new Date(now-RECOVERY_MAX_AGE_MS).toISOString(), new Date(now-45000).toISOString(), now-90000, new Date(now-90000).toISOString()).all()).results;
  for (const source of rows) {
    if (now - Date.parse(source.ts) >= 90000) {
      const key = 'mention-recovery:' + source.id;
      // D1 batch is transactional. The unique job and count advance together; concurrent sweeps cannot double-claim.
      const claim = await e.DB.batch([
        e.DB.prepare(`INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)`).bind(key, '{"attempts":0,"at":0}'),
        e.DB.prepare(`INSERT OR IGNORE INTO jobs(id,kind,payload,created_at)
          SELECT ?||':'||(json_extract(value,'$.attempts')+1),'chat',?,? FROM settings
          WHERE key=? AND json_extract(value,'$.attempts')<2 AND json_extract(value,'$.at')<=?
          AND EXISTS (SELECT 1 FROM messages m WHERE m.id=? AND ${noOutbox} AND ${noTerminal}) RETURNING id`)
          .bind(key, JSON.stringify({message:source.id,mentionRecovery:true}), now, key, now-90000, source.id),
        e.DB.prepare(`UPDATE settings SET value=json_object('attempts',json_extract(value,'$.attempts')+1,'at',?)
          WHERE key=? AND json_extract(value,'$.attempts')<2 AND json_extract(value,'$.at')<=?
          AND EXISTS (SELECT 1 FROM jobs WHERE id=?||':'||(json_extract(settings.value,'$.attempts')+1))`)
          .bind(now, key, now-90000, key),
      ]);
      const id = claim[1].results?.[0]?.id;
      if (id) {
        await e.DB.prepare('INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?)')
          .bind(id, 'mention.recovered', source.id, 'Bot', '发现被叫到的消息漏回，已重新处理', new Date(now).toISOString()).run();
        await wake(e, id);
      }
      await mentionReceipt(e, source, now);
    } else if (source.active) await mentionReceipt(e, source, now);
  }
}

/** The sender checks again: queued recoveries can age out or lose a race to a normal reply.
 * Ignore this recovery's own decision and receipts; neither is a competing answer. */
export async function mentionSendAllowed(e: any, outbox: any, now = Date.now()): Promise<boolean> {
  const source = await e.DB.prepare(`SELECT m.ts FROM messages m WHERE m.id=?1 AND m.group_id=?2
    AND NOT EXISTS (SELECT 1 FROM chat_decisions d WHERE d.group_id=m.group_id
      AND d.action IN ('reply','dup') AND d.id<>?3 AND COALESCE(d.outbox_id,'')<>?3
      AND (d.latest_id=m.id OR EXISTS (SELECT 1 FROM json_each(d.batch_ids) b WHERE b.value=m.id)))
    AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.group_id=m.group_id AND o.id<>?3
      AND substr(o.id,1,length(?3)+1)<>?3||'~'
      AND o.id NOT LIKE 'mention-receipt:%' AND o.status IN ('pending','sending','sent','unknown')
      AND (o.msg_id=m.id OR o.id IN (SELECT d.outbox_id FROM chat_decisions d WHERE d.group_id=m.group_id
        AND (d.latest_id=m.id OR EXISTS (SELECT 1 FROM json_each(d.batch_ids) b WHERE b.value=m.id)))))`)
    .bind(outbox.msg_id ?? null, outbox.group_id, outbox.id.replace(/~(?:[0-9]+|s)$/, '')).first();
  const age = now - Date.parse(source?.ts);
  return age >= 0 && age <= RECOVERY_MAX_AGE_MS;
}
