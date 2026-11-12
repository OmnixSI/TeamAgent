import { left } from "./d1";

export type Stage = "chat_claimed" | "bili_wait_start" | "fetch_claimed" | "fetch_reported" |
  "wait_woken" | "research_queued" | "inline_read" | "prefetch_start" | "prefetch_end" |
  "model_start" | "model_end" | "outbox" | "sent";
export type Tail = {
  timing: { turn: string; stage: Stage; at: number; extra?: any }[];
  cache: [string, string, string][];
};

/** Stages never execute SQL; the metered invocation owns the shared buffer. */
export function stage(e: any, turn: string | null | undefined, name: Stage, extra?: any, at = Date.now()) {
  if (turn && e.tail) e.tail.timing.push({ turn, stage: name, at, extra });
}

/** Optional writes come after sending. A lost metric must never fail a reply. */
export async function flushTail(e: any): Promise<void> {
  if (!e.tail) return;
  const tail: Tail = e.tail;
  let resources = 0, references = 0;
  const cache = tail.cache.splice(0).filter(row => row[0].startsWith("msgref:") ? ++references <= 3 : ++resources <= 5);
  const timing = tail.timing.splice(0).slice(0, 22);
  for (const kind of ["cache", "timing"] as const) {
    if (!(kind === "cache" ? cache.length : timing.length)) continue;
    if (left(e) < 1) { console.log("tail dropped", kind); continue; }
    try {
      const rows = kind === "cache" ? cache : timing.map(p => [p.turn, p.stage, p.at, p.extra === undefined ? null : JSON.stringify(p.extra)]);
      const width = kind === "cache" ? 3 : 4;
      const sql = kind === "cache" ? "INSERT OR REPLACE INTO media_notes(id,body,created_at) VALUES " : "INSERT INTO stage_timings(turn_id,stage,at,extra) VALUES ";
      await e.DB.prepare(sql + rows.map(() => "(" + Array(width).fill("?").join(",") + ")").join(","))
        .bind(...rows.flat()).run();
    } catch { console.log("tail dropped", kind); }
  }
}
