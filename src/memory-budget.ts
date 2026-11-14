// Nightly memory batches are bounded by characters, not message count. A paid-tier
// batch of 120 messages must still fit the model input, so keep the newest messages
// whole and cut only the oldest tail of the batch.
export const MEMORY_BATCH_CHAR_BUDGET = 40000;

/** Keep the newest rows that fit; trim the body of the oldest kept row to end exactly at budget. */
export function fitMemoryMessages<T extends { body?: string }>(rows: T[], budget = MEMORY_BATCH_CHAR_BUDGET): T[] {
  const out: T[] = [];
  let used = 0;
  for (let at = rows.length - 1; at >= 0; at--) {
    const body = String(rows[at].body || "");
    const room = budget - used;
    if (room <= 0) break;
    if (body.length <= room) {
      out.unshift(rows[at]);
      used += body.length;
      continue;
    }
    out.unshift({ ...rows[at], body: body.slice(0, room) });
    break;
  }
  return out;
}
