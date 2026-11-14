// Moves large files between the cloud computer and R2 through the Worker's public URL. The container
// has no R2 binding, so the Hub hands it short-lived tokens, each good for one direction and one R2 key
// prefix (often one exact name), and streams bodies straight between the request and the bucket.
// Cloudflare caps a request body at 100 MB, so uploads arrive as numbered parts that a download joins
// back together. Everything stored here is counted and stops at 1.5 GB.
import type { Hub } from "../hub.ts";
import type { Feature } from "./types.ts";
import { R2_STORAGE_STOP } from "../budget.ts";

/** Upload part size used by the container scripts; the route refuses anything above PART_MAX. */
export const PART = 80 * 1024 * 1024;
export const PART_MAX = 95 * 1024 * 1024;
const MAX_PARTS = 64;
/** Everything kept through this path: the file box (up to 3 GB) plus caches and workspaces. */
export const CAP = 4.5 * 1024 ** 3;
const TTL = 30 * 60;
const STALE = 24 * 3600 * 1000;

export type Grant = { mode: "put" | "get"; prefix: string; name?: string; exp: number };
export type Row = { key: string; size: number; parts: number; done: number; at: number };

/** Where this feature's objects live in the bucket. A lab Worker sets TRANSFER_ROOT to its own prefix. */
export const root = (hub: Hub) => String((hub.env as any).TRANSFER_ROOT || "computer/");
const NAME = /^[\w\-][\w.\-]{0,119}$/;

export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}

/** The R2 key a request may touch, or null. Names are a single path segment, so a grant never reaches outside its prefix. */
export function allowed(g: Grant | null, mode: "put" | "get", name: string, now = Date.now()): string | null {
  if (!g || g.mode !== mode || !(g.exp > now)) return null;
  if (!NAME.test(name) || name.includes("..")) return null;
  if (g.name !== undefined && g.name !== name) return null;
  return g.prefix + name;
}

export const partKey = (key: string, i: number) => key + ".part" + String(i).padStart(4, "0");
export const partCount = (size: number) => Math.max(1, Math.ceil(size / PART));

/** Whether storing `add` more bytes for `key` stays under the cap; a new upload of `key` replaces its old bytes. */
export function fitsCap(total: number, old: number, add: number, cap = CAP) { return total - old + add <= cap; }

/** sha256 hex of a string (the install recipe), used in the cache key so a changed recipe misses the old cache. */
export async function sha(text: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, "0")).join("");
}
export async function cacheName(recipe: string) { return "env-" + (await sha(recipe)).slice(0, 16) + ".tar.zst"; }

/** What a wake-up does: nothing when the tools are there, restore when a finished cache exists, else install. */
export function bootPlan(ready: boolean, cached: boolean): "none" | "restore" | "install" {
  return ready ? "none" : cached ? "restore" : "install";
}
/** After a restore attempt: a failed one (missing, corrupt, cut off) falls back to the full install. */
export const afterRestore = (ok: boolean): "done" | "install" => (ok ? "done" : "install");
/** A fresh cache is saved only after the full install ran and a write token was handed over. */
export const shouldSave = (installed: boolean, put?: string) => installed && !!put;

/** A persistent workspace is /work/<name>; the name is a plain word so it is safe in paths and keys. */
export const workspaceName = (name: string) => (/^[\w\-]{1,40}$/.test(name) ? name : null);

// ---------- state ----------

const tokKey = (t: string) => "xfer:tok:" + t;

export function issue(hub: Hub, g: Omit<Grant, "exp">, ttl = TTL) {
  const t = newToken();
  hub.set(tokKey(t), JSON.stringify({ ...g, exp: Date.now() + ttl * 1000 }));
  return t;
}
export function grant(hub: Hub, t: string): Grant | null {
  if (!/^[0-9a-f]{32}$/.test(t)) return null;
  try { return JSON.parse(hub.get(tokKey(t)) || "null"); } catch { return null; }
}
/** Public URL the container uses with a token. */
export function link(hub: Hub, mode: "put" | "get", t: string, name: string) {
  return String(hub.env.PUBLIC_URL || "").replace(/\/$/, "") + "/x/" + mode + "/" + t + "/" + encodeURIComponent(name);
}

const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
export function row(hub: Hub, key: string): Row | null {
  const r = rows(hub, "SELECT key, size, parts, done, at FROM xfer WHERE key=?", key)[0];
  return r ? { key: String(r.key), size: Number(r.size), parts: Number(r.parts), done: Number(r.done), at: Number(r.at) } : null;
}
export const complete = (hub: Hub, key: string) => !!row(hub, key)?.done;
export const keysUnder = (hub: Hub, prefix: string) => rows(hub, "SELECT key FROM xfer WHERE substr(key, 1, ?) = ?", prefix.length, prefix).map(r => String(r.key));
export const stored = (hub: Hub) => Number(rows(hub, "SELECT COALESCE(SUM(size),0) n FROM xfer")[0].n);

export async function remove(hub: Hub, key: string) {
  const r = row(hub, key);
  if (!r) return;
  for (let i = 0; i < r.parts; i++) await hub.env.FILES?.delete(partKey(key, i)).catch(() => {});
  hub.sql.exec("DELETE FROM xfer WHERE key=?", key);
}

const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
const fixed = (len: number): TransformStream => { const F = (globalThis as any).FixedLengthStream; return F ? new F(len) : new TransformStream(); };

async function put(hub: Hub, req: Request, url: URL, key: string) {
  const len = Number(req.headers.get("content-length"));
  if (!req.headers.get("content-length") || !Number.isFinite(len) || len < 0 || !req.body && len > 0) return json({ error: "Content-Length required" }, 411);
  if (len > PART_MAX) return json({ error: "part too large, split it into " + PART / 1048576 + " MB parts" }, 413);
  const part = Number(url.searchParams.get("part") || 0), last = url.searchParams.get("last") !== "0";
  if (!Number.isInteger(part) || part < 0 || part >= MAX_PARTS) return json({ error: "bad part" }, 400);
  const old = row(hub, key);
  // Parts come in order: part 0 starts a new version (the old one is dropped), each later part must follow the last.
  if (part > 0 && (!old || old.done || old.parts !== part)) return json({ error: "parts must be uploaded in order starting at 0" }, 409);
  const keep = part === 0 ? 0 : old!.size;
  if (!fitsCap(stored(hub), old?.size || 0, keep + len)) return json({ error: "storage cap reached" }, 507);
  // The bucket as a whole (kept media, sites and backups included) has one stop line below what the plan includes.
  if (((hub as any).store?.r2All?.() ?? 0) - (old?.size || 0) + keep + len > R2_STORAGE_STOP) return json({ error: "storage cap reached" }, 507);
  if (!hub.plan.fits("r2_writes", 1)) return json({ error: "R2 write allowance used up" }, 503);
  if (part === 0) {
    await remove(hub, key);
    hub.sql.exec("INSERT INTO xfer(key, size, parts, done, at) VALUES(?, 0, 0, 0, ?)", key, Date.now());
  }
  const body = req.body ? req.body.pipeThrough(fixed(len)) : new Uint8Array();
  hub.plan.add("r2_writes", 1);
  const obj = await hub.env.FILES.put(partKey(key, part), body);
  if (!obj || obj.size !== len) return json({ error: "short upload" }, 400);
  hub.sql.exec("UPDATE xfer SET size=size+?, parts=?, done=?, at=? WHERE key=?", len, part + 1, last ? 1 : 0, Date.now(), key);
  return json({ ok: true, part, bytes: len, done: last });
}

/** Streams the parts of a finished object one after another as one body. */
async function get(hub: Hub, key: string, planOnly = false) {
  const r = row(hub, key);
  if (!r || !r.done) return json({ error: "not found" }, 404);
  if (!hub.plan.fits("r2_reads", r.parts)) return json({ error: "R2 read allowance used up" }, 503);
  // The Worker in front asks for the list of parts and streams them from R2 itself, so hundreds of
  // megabytes do not pass through the Hub (which is busy being the bot).
  if (planOnly) {
    hub.plan.add("r2_reads", r.parts);
    return json({ size: r.size, keys: Array.from({ length: r.parts }, (_x, i) => partKey(key, i)) });
  }
  const { readable, writable } = fixed(r.size);
  const pump = (async () => {
    for (let i = 0; i < r.parts; i++) {
      hub.plan.add("r2_reads", 1);
      const o = await hub.env.FILES.get(partKey(key, i));
      if (!o) throw new Error("missing part " + i);
      await o.body.pipeTo(writable, { preventClose: true });
    }
    await writable.close();
  })().catch(e => writable.abort(e).catch(() => {}));
  (hub as any).ctx?.waitUntil?.(pump);
  return new Response(readable, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(r.size) } });
}

export async function route(hub: Hub, req: Request, url: URL): Promise<Response | null> {
  const m = url.pathname.match(/^\/x\/(put|get)\/([^/]+)\/([^/]+)$/);
  if (!m) return null;
  const mode = m[1] as "put" | "get";
  if ((mode === "put") !== (req.method === "PUT") || (mode === "get" && req.method !== "GET")) return json({ error: "method" }, 405);
  let name = "";
  try { name = decodeURIComponent(m[3]); } catch { return json({ error: "not found" }, 404); }
  const g = grant(hub, m[2]), key = allowed(g, mode, name);
  if (!key) return json({ error: "not found" }, 404);
  if (!hub.env.FILES) return json({ error: "no bucket" }, 503);
  return mode === "put" ? put(hub, req, url, key) : get(hub, key, url.searchParams.get("plan") === "1");
}

/** Drops expired tokens and uploads that stopped halfway, at most once an hour. */
export async function sweep(hub: Hub, now = Date.now()) {
  if (now - Number(hub.get("xfer:swept") || 0) < 3600000) return;
  hub.set("xfer:swept", String(now));
  for (const r of rows(hub, "SELECT k, v FROM kv WHERE k LIKE 'xfer:tok:%'")) {
    let exp = 0;
    try { exp = Number(JSON.parse(String(r.v)).exp); } catch {}
    if (!(exp > now)) hub.sql.exec("DELETE FROM kv WHERE k=?", r.k);
  }
  for (const r of rows(hub, "SELECT key FROM xfer WHERE done=0 AND at<?", now - STALE)) await remove(hub, String(r.key));
}

const feature: Feature = {
  name: "transfer",
  schema: "CREATE TABLE IF NOT EXISTS xfer(key TEXT PRIMARY KEY, size INTEGER NOT NULL DEFAULT 0, parts INTEGER NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0, at INTEGER NOT NULL DEFAULT 0)",
  open: (hub, req, url) => route(hub, req, url),
  tick: hub => sweep(hub),
  admin(hub, _req, url) {
    if (url.pathname !== "/admin/transfer") return null;
    return json({ stored_bytes: stored(hub), cap_bytes: CAP, objects: rows(hub, "SELECT key, size, parts, done, at FROM xfer ORDER BY key") });
  },
};
export default feature;
