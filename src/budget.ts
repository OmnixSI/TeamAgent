import { TEAM } from "./config";

function sydneyDay(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TEAM.memory.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function budgetKey(name: string, at: number) {
  return "budget:" + name + ":" + sydneyDay(at);
}

/**
 * Held-units counters (reserve/refund/adjust) back provider quotas that reset at
 * 00:00 UTC (Workers AI neurons), so they key on the UTC day. A Sydney-day key
 * would allow two caps inside one UTC day.
 */
function utcBudgetKey(name: string, at: number) {
  return "budget:" + name + ":utc:" + new Date(at).toISOString().slice(0, 10);
}

/** Atomic daily counter; the RETURNING value is the post-increment count. */
export async function budget(
  e: any,
  name: string,
  cap: number,
  at = Date.now(),
) {
  const row = await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?, '1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1 RETURNING value",
  )
    .bind(budgetKey(name, at))
    .first();
  return Number(row?.value) <= cap;
}

/**
 * Atomic daily hold of `units`. Returns false without charging when the hold
 * would exceed `cap`, so a rejected call never inflates the counter.
 */
export async function reserve(
  e: any,
  name: string,
  units: number,
  cap: number,
  at = Date.now(),
) {
  const n = Math.ceil(units);
  if (!Number.isFinite(n) || n <= 0 || n > cap) return false;
  const row = await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+? WHERE CAST(value AS INTEGER)+? <= ? RETURNING value",
  )
    .bind(utcBudgetKey(name, at), String(n), n, n, cap)
    .first();
  return !!row;
}

/** Give a hold back after a failed call; never goes below zero. */
export async function refund(
  e: any,
  name: string,
  units: number,
  at = Date.now(),
) {
  const n = Math.ceil(units);
  if (!Number.isFinite(n) || n <= 0) return;
  await e.DB.prepare(
    "UPDATE settings SET value=MAX(0,CAST(value AS INTEGER)-?) WHERE key=?",
  )
    .bind(n, utcBudgetKey(name, at))
    .run();
}

/** Correct a hold by `delta` (positive charges, negative gives back). */
export async function adjust(
  e: any,
  name: string,
  delta: number,
  at = Date.now(),
) {
  const d = Math.ceil(delta);
  if (!Number.isFinite(d) || d === 0) return;
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=MAX(0,CAST(value AS INTEGER)+?)",
  )
    .bind(utcBudgetKey(name, at), String(Math.max(0, d)), d)
    .run();
}

export async function cleanupBudget(e: any, at = Date.now()) {
  const cutoff = sydneyDay(at - 3 * 86400000);
  await e.DB.prepare(
    "DELETE FROM settings WHERE key LIKE 'budget:%' AND substr(key,-10) < ?",
  )
    .bind(cutoff)
    .run();
}
