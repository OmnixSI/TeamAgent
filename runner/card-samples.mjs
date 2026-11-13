// Passive QQ card sampling for Bilibili card shapes. Off unless config.card_sample_until is in the future.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const CARD_SAMPLE_DIR = "/tmp/inkboard-card-samples";
export const CARD_SAMPLE_LIMIT = 10;
const PRIVATE_KEYS = new Set(["uin", "nickname", "username", "member_openid", "union_openid", "user_openid", "avatar"]);

function parseMillis(raw) {
  if (raw == null || raw === "" || raw === false) return null;
  let value;
  if (typeof raw === "number") value = raw;
  else {
    const text = String(raw).trim();
    value = /^\d+(?:\.\d+)?$/.test(text) ? Number(text) : Date.parse(text);
  }
  if (!Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}
export function cardSampleUntil(config, now = Date.now()) {
  const until = parseMillis(config?.card_sample_until);
  return until != null && until > now ? until : null;
}
export function sweepCardSamples(config, { dir = CARD_SAMPLE_DIR, now = Date.now() } = {}) {
  const until = parseMillis(config?.card_sample_until);
  if (until == null || until > now) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}
export function sanitizeCardEvent(value, depth = 0) {
  if (depth > 32 || value == null) return value;
  if (Array.isArray(value)) return value.map(entry => sanitizeCardEvent(entry, depth + 1)).filter(entry => entry !== undefined);
  if (typeof value === "object") {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      if (PRIVATE_KEYS.has(key.toLowerCase())) continue;
      const clean = sanitizeCardEvent(entry, depth + 1);
      if (clean !== undefined) out[key] = clean;
    }
    return depth > 0 && Object.keys(out).length === 0 ? undefined : out;
  }
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") return JSON.stringify(sanitizeCardEvent(parsed, depth + 1));
    } catch {}
  }
  return value;
}
function hasCard(value, depth = 0) {
  if (depth > 32 || value == null) return false;
  if (typeof value === "string") {
    if (/^\s*[\[{]/.test(value)) {
      try { return hasCard(JSON.parse(value), depth + 1); } catch {}
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(entry => hasCard(entry, depth + 1));
  if (typeof value !== "object") return false;
  if (value.ark_data != null) return true;
  return Object.values(value).some(entry => hasCard(entry, depth + 1));
}
function hasBiliMarker(value, depth = 0) {
  if (depth > 32 || value == null) return false;
  if (typeof value === "string") {
    let text = value.replace(/\\u002f/gi, "/");
    for (let i = 0; i < 2; i++) {
      try {
        const next = decodeURIComponent(text);
        if (next === text) break;
        text = next;
      } catch { break; }
    }
    if (/b23\.tv|bili2233\.cn|bilibili\.com|hdslb\.com|哔哩|bilibili|B站/i.test(text)) return true;
    if (/^\s*[\[{]/.test(text)) {
      try { return hasBiliMarker(JSON.parse(text), depth + 1); } catch {}
    }
    return false;
  }
  if (Array.isArray(value)) return value.some(entry => hasBiliMarker(entry, depth + 1));
  if (typeof value !== "object") return false;
  return Object.values(value).some(entry => hasBiliMarker(entry, depth + 1));
}
export function isBiliCardEvent(event) {
  return hasCard(event) && hasBiliMarker(event);
}
export function sampleCardEvent(event, { config = {}, dir = CARD_SAMPLE_DIR, now = Date.now() } = {}) {
  const until = parseMillis(config?.card_sample_until);
  if (until != null && until <= now) {
    fs.rmSync(dir, { recursive: true, force: true });
    return { sampled: false, reason: "expired" };
  }
  if (until == null) return { sampled: false, reason: "off" };
  if (!hasCard(event)) return { sampled: false, reason: "not_card" };
  if (!hasBiliMarker(event)) return { sampled: false, reason: "not_bili" };
  let count = 0;
  try { count = fs.readdirSync(dir).filter(name => name.endsWith(".json")).length; } catch {}
  if (count >= CARD_SAMPLE_LIMIT) return { sampled: false, reason: "full" };
  const body = JSON.stringify(sanitizeCardEvent(event), null, 2);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 20; attempt++) {
    const file = path.join(dir, `card-${now}-${crypto.randomBytes(4).toString("hex")}.json`);
    try {
      fs.writeFileSync(file, body, { mode: 0o600, flag: "wx" });
      return { sampled: true, file };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return { sampled: false, reason: "error" };
}
