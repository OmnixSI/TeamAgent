import { left } from "./d1";

export type Stage = "chat_claimed" | "bili_wait_start" | "fetch_claimed" | "fetch_reported" |
  "wait_woken" | "research_queued" | "inline_read" | "prefetch_start" | "prefetch_end" |
  "model_start" | "model_end" | "outbox" | "sent";
export type Tail = {
  timing: { turn: string; stage: Stage; at: number; extra?: any }[];
  cache: [string, string, string][];
  /** L7：口头禅命中/预算跳过，发送后统一写 activity；不占回复路径预算。 */
  ruleActivities?: { id: string; kind: string; entity: string; actor: string; summary: string; created_at: string }[];
};

/** Longest tool trajectory kept per turn. 60 events cover a full tool chain; the
 *  previous 22 cut long turns and left stage_timings incomplete. */
export const TIMING_EVENTS_PER_TURN = 60;
/** 4 bound parameters per row; 24 rows = 96, under D1's 100-parameter statement cap. */
const TIMING_ROWS_PER_STATEMENT = 24;

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
  const timing = tail.timing.splice(0).slice(0, TIMING_EVENTS_PER_TURN);
  // L7：规则 activity 与 cache/timing 一样在发送后写；INSERT OR IGNORE 保证重放不重复。
  // 留 3 句给后面的固定尾巴（stage_timings/cache），否则 48 句上限的最紧回合会被这 1 句挤掉发送。
  const ruleActivities = tail.ruleActivities?.splice(0, 6) || [];
  if (ruleActivities.length) {
    if (left(e) < 6) console.log("tail dropped", "rule-activity");
    else {
      try {
        await e.DB.prepare("INSERT OR IGNORE INTO activity VALUES " + ruleActivities.map(() => "(?,?,?,?,?,?)").join(","))
          .bind(...ruleActivities.flatMap(v => [v.id, v.kind, v.entity, v.actor, v.summary, v.created_at])).run();
      } catch { console.log("tail dropped", "rule-activity"); }
    }
  }
  if (cache.length) {
    if (left(e) < 1) console.log("tail dropped", "cache");
    else
      try {
        const rows = cache;
        const width = 3;
        const sql = "INSERT OR REPLACE INTO media_notes(id,body,created_at) VALUES ";
        await e.DB.prepare(sql + rows.map(() => "(" + Array(width).fill("?").join(",") + ")").join(","))
          .bind(...rows.flat()).run();
      } catch { console.log("tail dropped", "cache"); }
  }
  if (!timing.length) return;
  let rows: (string | number | null)[][];
  try {
    rows = timing.map(p => [p.turn, p.stage, p.at, p.extra === undefined ? null : JSON.stringify(p.extra)]);
  } catch { console.log("tail dropped", "timing"); return; }
  for (let at = 0; at < rows.length; at += TIMING_ROWS_PER_STATEMENT) {
    if (left(e) < 1) { console.log("tail dropped", "timing"); break; }
    const part = rows.slice(at, at + TIMING_ROWS_PER_STATEMENT);
    try {
      await e.DB.prepare("INSERT INTO stage_timings(turn_id,stage,at,extra) VALUES " + part.map(() => "(?,?,?,?)").join(","))
        .bind(...part.flat()).run();
    } catch { console.log("tail dropped", "timing"); break; }
  }
}
