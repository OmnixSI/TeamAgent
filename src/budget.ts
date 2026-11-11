import { TEAM } from "./config";

function sydneyDay(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM.memory.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** Atomic daily counter; the RETURNING value is the post-increment count. */
export async function budget(
  e: any,
  name: string,
  cap: number,
  at = Date.now(),
) {
  const key = "budget:" + name + ":" + sydneyDay(at);
  const row = await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value",
  )
    .bind(key)
    .first();
  return Number(row?.value) <= cap;
}

export async function cleanupBudget(e: any, at = Date.now()) {
  const cutoff = sydneyDay(at - 3 * 86400000);
  await e.DB.prepare(
    "DELETE FROM settings WHERE key LIKE 'budget:%' AND substr(key,-10) < ?",
  )
    .bind(cutoff)
    .run();
}
