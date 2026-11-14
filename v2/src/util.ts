// Small pure helpers shared by the Worker and the local replay script.

export type Env = {
  HUB: any;
  DEEPSEEK_API_KEY: string;
  OPENAI_API_KEY?: string;
  QQ_APP_ID: string;
  QQ_APP_SECRET: string;
  ADMIN_TOKEN: string;
  GITHUB_TOKEN?: string;
  GITHUB_ORG?: string;
  IMAGE_MODEL?: string;
  CHAT_MODEL?: string;
  RELAY_URL?: string;
  RELAY_KEY?: string;
};

/** Bumped on every behaviour change; the Hub restarts itself when the Worker reports a newer build. */
export const BUILD = "2026-11-14.11";

export const BJ = "Asia/Shanghai";
export const SYD = "Australia/Sydney";

function parts(ts: number, tz: string) {
  const f = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short", hour12: false,
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(ts)) o[p.type] = p.value;
  if (o.hour === "24") o.hour = "00";
  return o;
}
export const fmtTime = (ts: number, tz = BJ) => { const p = parts(ts, tz); return p.hour + ":" + p.minute; };
export const fmtDate = (ts: number, tz = BJ) => { const p = parts(ts, tz); return p.year + "-" + p.month + "-" + p.day; };
const WEEK: Record<string, string> = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };
export const fmtFull = (ts: number, tz = BJ) => {
  const p = parts(ts, tz);
  return p.month + "-" + p.day + " " + WEEK[p.weekday] + " " + p.hour + ":" + p.minute;
};
/** Milliseconds the zone is ahead of UTC at `ts`. */
export function tzOffset(ts: number, tz: string) {
  const p = parts(ts, tz);
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return local - Math.floor(ts / 1000) * 1000;
}
/** UTC ms for a wall-clock date + time in a zone. */
export function zonedToUtc(date: string, time: string, tz: string) {
  const [y, m, d] = date.split("-").map(Number), [hh, mm] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm || 0);
  let ts = guess - tzOffset(guess, tz);
  ts = guess - tzOffset(ts, tz);
  return ts;
}
/** Next occurrence of HH:MM in a zone strictly after `after`; `days` are 0=Sunday. */
export function nextDaily(time: string, tz: string, after: number, days?: number[]) {
  for (let i = 0; i < 9; i++) {
    const day = fmtDate(after + i * 86400000, tz), ts = zonedToUtc(day, time, tz);
    if (ts <= after) continue;
    if (days?.length) {
      const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts(ts, tz).weekday);
      if (!days.includes(wd)) continue;
    }
    return ts;
  }
  return after + 86400000;
}

export function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function unb64(text: string) {
  const s = atob(text), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** QQ inline faces look like <faceType=1,faceId="5",ext="base64 json">; show them as [表情:流泪]. */
export function decodeFaces(text: string) {
  return text.replace(/<faceType=\d+,faceId="[^"]*",ext="([^"]*)">/g, (_all, ext) => {
    try {
      const name = JSON.parse(new TextDecoder().decode(unb64(ext))).text;
      return name ? "[表情:" + name + "]" : "[表情]";
    } catch { return "[表情]"; }
  });
}

/** QQ shows plain text, so Markdown decoration is noise. */
export function cleanReply(text: string) {
  return text
    .replace(/^\s*```[a-zA-Z0-9_-]*\s*$/gm, "")
    .replace(/\*\*([^*\n]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1$2")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2")
    .replace(/^\s*[-*]\s+/gm, "· ")
    .replace(/^\s*---+\s*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Banter goes out as separate short messages, the way people type; real answers stay whole. */
export function splitReply(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (t.length > 140 || lines.length > 3 || lines.some(l => l.length > 70 || /^(\d+[.、]|·)/.test(l))) return [t];
  return lines;
}

export const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
export const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
