import TEAM from "../config/team.json";
const defaults = { mention: 1, image: 4, busy: 3, idle: 2, cap_ms: 8000, wait_min: 5, wait_max: 45, wait_horizon_ms: 120000, hard_window_ms: 1800000, hard_humans: 6 };
export const RHYTHM = { ...defaults, ...(TEAM as any).rhythm };
export function debounceSeconds(x: { mentioned: boolean; bareImage: boolean; humansLast2m: number }, r = RHYTHM): number {
  return x.mentioned ? r.mention : x.bareImage ? r.image : x.humansLast2m >= 3 ? r.busy : r.idle;
}
export function shouldProcessNow(x: { isNewest: boolean; mentioned: boolean; oldestPendingAt: number; now: number }, r = RHYTHM): boolean {
  return x.mentioned || x.isNewest || x.now - x.oldestPendingAt >= r.cap_ms;
}
export function allowWait(x: { waited: boolean; oldestPendingAt: number; now: number; off: boolean }, r = RHYTHM): boolean {
  return !x.off && !x.waited && x.now - x.oldestPendingAt < r.wait_horizon_ms;
}
export type Decision = { action: "reply" | "wait" | "stop"; waitSeconds?: number; kind: "direct" | "proactive"; brief: any; target?: string; reason?: string };
export function parseDecision(raw: string, o: { forced: boolean; allowWait: boolean }, r = RHYTHM): Decision {
  let p: any;
  try { p = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")) || {}; }
  catch { return o.forced ? { action: "reply", kind: "direct", brief: raw } : { action: "stop", kind: "proactive", brief: "" }; }
  let action: Decision["action"] = ["reply", "wait", "stop"].includes(p.action) ? p.action
    : typeof p.should_reply === "boolean" ? p.should_reply ? "reply" : "stop" : o.forced ? "reply" : "stop";
  if (o.forced && action !== "reply") action = "reply";
  if (action === "wait" && !o.allowWait) action = "stop";
  return { action, kind: o.forced ? "direct" : p.kind === "direct" ? "direct" : "proactive", brief: p.brief ?? "",
    waitSeconds: action === "wait" ? Math.max(r.wait_min, Math.min(r.wait_max, Math.round(Number(p.wait_seconds) || 15))) : undefined,
    target: typeof p.target === "string" && p.target ? p.target : undefined, reason: String(p.reason ?? "").slice(0, 80) };
}
export function mayBeForced(latest: any, mentioned: boolean, videoRef: boolean): boolean {
  return mentioned || videoRef || latest?.meta?.replyTo?.kind === "bot" || !!latest?.meta?.forwarded?.length;
}
export function hardRuleHit(row: any, now: number, r = RHYTHM): boolean {
  if (!row || row.spoken_kind !== "proactive" || now - row.created_at > r.hard_window_ms) return false;
  return row.last_base === row.outbox_id && row.n < r.hard_humans && row.addressed === 0;
}
export async function unansweredProactive(e: any, groupId: string, now = Date.now(), r = RHYTHM): Promise<boolean> {
  const row = await e.DB.prepare(`WITH last AS (
    SELECT outbox_id,spoken_kind,created_at,latest_id FROM chat_decisions
    WHERE group_id=?1 AND outbox_id IS NOT NULL ORDER BY created_at DESC LIMIT 1),
  lastout AS (
    SELECT CASE WHEN instr(id,'~')>0 THEN substr(id,1,instr(id,'~')-1) ELSE id END AS base
    FROM outbox WHERE group_id=?1 AND status IN ('pending','sent') AND id NOT LIKE '%~s'
    ORDER BY created_at DESC LIMIT 1),
  after AS (
    SELECT m.mentioned,json_extract(mm.json,'$.replyTo.kind') AS rk
    FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id
    WHERE m.group_id=?1 AND m.rowid>(SELECT COALESCE(MAX(rowid),0) FROM messages WHERE id=(SELECT latest_id FROM last))
    ORDER BY m.rowid LIMIT ?2)
  SELECT last.spoken_kind,last.created_at,last.outbox_id,(SELECT base FROM lastout) AS last_base,
    (SELECT COUNT(*) FROM after) AS n,(SELECT COUNT(*) FROM after WHERE mentioned=1 OR rk='bot') AS addressed FROM last`)
    .bind(groupId, r.hard_humans).first();
  return hardRuleHit(row, now, r);
}
export async function recordDecision(e: any, row: any): Promise<void> {
  await e.DB.prepare(`INSERT OR REPLACE INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,spoken_kind,target_id,wait_seconds,reason,outbox_id,policy,model_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(row.id, row.group_id, row.latest_id, Array.isArray(row.batch_ids) ? JSON.stringify(row.batch_ids.slice(0, 60)) : row.batch_ids || "[]",
      row.mentioned ? 1 : 0, row.forced ? 1 : 0, row.waited ? 1 : 0, row.gate || "model", row.action || "stop", row.spoken_kind || null,
      row.target_id || null, row.wait_seconds ?? null, row.reason || null, row.outbox_id || null, row.policy || "live", row.model_ms ?? null, row.created_at ?? Date.now()).run();
}
export const SWITCH_KEYS = ["off:wait", "off:quote", "off:sticker_send", "off:sticker_collect", "sticker_paused_until", "self_note", "team_reflection", "auth:bili", "auth:x", "off:repo_tools", "gate:mode", "gate:config"] as const;
export async function loadSwitches(e: any): Promise<Record<string, string | undefined>> {
  const rows = (await e.DB.prepare("SELECT key,value FROM settings WHERE key IN (" + SWITCH_KEYS.map(() => "?").join(",") + ")").bind(...SWITCH_KEYS).all()).results;
  e.authStates = Object.fromEntries(rows.filter((r:any)=>r.key.startsWith('auth:')).map((r:any)=>[r.key,r.value]));
  return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
}
export const isOn = (sw: Record<string, string | undefined>, name: string) => sw["off:" + name] !== "1";
