import { UNTRUSTED_RULE } from "./untrusted";
import settings from "../config/participation.json";
/** Group participation is decided before the separate voice module. */
export const PARTICIPATION = settings.text + "\n" + UNTRUSTED_RULE;
export function participation(raw: string, forced = false) {
  try {
    const p = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (typeof p.should_reply === "boolean") return p;
  } catch {}
  return {
    should_reply: forced,
    kind: forced ? "direct" : "proactive",
    brief: forced ? raw : "",
  };
}
export async function maySpeak(
  e: any,
  p: any,
  forced: boolean,
  accepted: boolean,
) {
  return accepted || forced || p.should_reply === true;
}
export function alreadySaid(text: string, recent: any[]) {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, "");
  const normalized = normalize(text);
  return (
    !!normalized &&
    recent.some(
      (message) => normalize(String(message.body || "")) === normalized,
    )
  );
}
export async function recordProactive(e: any) {
  const row = await e.DB.prepare(
    "SELECT value FROM settings WHERE key='proactive_history'",
  ).first();
  let history: number[] = [];
  try {
    history = JSON.parse(row?.value || "[]");
  } catch {}
  history = history.filter((t) => Date.now() - t < 600000);
  history.push(Date.now());
  await e.DB.prepare(
    "INSERT INTO settings VALUES('proactive_history',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(JSON.stringify(history))
    .run();
}
