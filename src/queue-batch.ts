// CF-5: paid-tier queue consumers process up to five messages per invocation.
// Each message gets a fresh D1 meter (the background 200-statement budget), a
// failing message only retries itself, and the outbox is flushed once per batch.
import { metered, queueLimit, DLQ_QUEUES } from "./d1";
import { flushAuditedTail as flushTail } from "./tool-audit";

export { DLQ_QUEUES };

export type QueueMessage = { body?: any; ack(): void; retry(): void };
export type QueueBatch = { queue?: string; messages: QueueMessage[] };

export const isDlqQueue = (name: string | undefined): boolean =>
  !!name && String(name).endsWith("-dlq") && DLQ_QUEUES.includes(String(name));

/** Persist one counter line per dead-letter batch; the dev-room morning report reads these keys. */
export async function recordDlqBatch(e: any, name: string, count: number): Promise<void> {
  if (!count) return;
  const key = "dlq:" + name;
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=CAST(COALESCE(NULLIF(CAST(value AS INTEGER),0),0)+?2 AS TEXT)",
  )
    .bind(key + ":count", String(count))
    .run();
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(key + ":last", new Date().toISOString())
    .run();
}

/** One invocation: acknowledge or retry each message independently, then flush once. */
export async function runQueueBatch(
  batch: QueueBatch,
  base: any,
  process: (e: any, id: string) => Promise<void>,
  send: (e: any) => Promise<void>,
): Promise<{ ok: number; retried: number }> {
  const limit = queueLimit(batch?.queue);

  if (isDlqQueue(batch?.queue)) {
    const scoped = metered(base, limit);
    await recordDlqBatch(scoped, String(batch.queue), batch.messages.length);
    for (const message of batch.messages) message.ack();
    await flushTail(scoped);
    return { ok: batch.messages.length, retried: 0 };
  }

  let ok = 0;
  let retried = 0;
  let last = metered(base, limit);
  for (let at = 0; at < batch.messages.length; at++) {
    const message = batch.messages[at];
    last = metered(base, limit);
    try {
      await process(last, message.body?.id);
      if (at < batch.messages.length - 1) await flushTail(last);
      message.ack();
      ok++;
    } catch (error) {
      // A poison message must not take the rest of the batch down. The platform
      // retries it until max_retries, then routes it to the dead-letter queue.
      console.log("queue message retry: " + String((error as any)?.message || error).slice(0, 160));
      // Partial metrics from the failed attempt are not published; the retry
      // starts a fresh tail.
      if (last.tail) { last.tail.timing.length = 0; last.tail.cache.length = 0; }
      try {
        message.retry();
        retried++;
      } catch { /* A failed retry must not abort the remaining messages either. */ }
    }
  }
  // Reuse the last message's remaining meter so the whole invocation stays inside
  // the D1 per-invocation ceiling (5 x 200 statements).
  await send(last);
  await flushTail(last);
  return { ok, retried };
}
