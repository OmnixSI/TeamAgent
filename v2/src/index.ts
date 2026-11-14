// Worker entry: a health page, the admin surface, an optional QQ webhook, and a cron that keeps the Hub awake.
import { buildOf } from "./util.ts";
import type { Env } from "./util.ts";
export { Hub } from "./hub.ts";
export { Computer } from "./computer.ts";

const hub = (env: Env) => env.HUB.get(env.HUB.idFromName("main"));
const json = (v: any, status = 200) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });

async function qqKey(secret: string) {
  let seed = secret;
  while (seed.length < 32) seed += seed;
  const der = new Uint8Array(48);
  der.set([0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20]);
  der.set(new TextEncoder().encode(seed.slice(0, 32)), 16);
  return crypto.subtle.importKey("pkcs8", der, { name: "Ed25519" }, true, ["sign"]);
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");

/** QQ webhook delivery. Usable once the Worker has a domain QQ's servers can reach. */
async function webhook(req: Request, env: Env) {
  const raw = await req.text();
  let p: any;
  try { p = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
  const key = await qqKey(env.QQ_APP_SECRET);
  if (p.op === 13) {
    const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(String(p.d.event_ts) + String(p.d.plain_token)));
    return json({ plain_token: p.d.plain_token, signature: hex(sig) });
  }
  const ts = req.headers.get("x-signature-timestamp") || "", sig = req.headers.get("x-signature-ed25519") || "";
  if (!/^[0-9a-f]{128}$/i.test(sig) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return json({ error: "invalid signature" }, 401);
  const jwk: any = await crypto.subtle.exportKey("jwk", key);
  delete jwk.d; jwk.key_ops = ["verify"];
  const pub = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("Ed25519", pub, Uint8Array.from(sig.match(/../g)!.map(x => parseInt(x, 16))), new TextEncoder().encode(ts + raw));
  if (!ok) return json({ error: "invalid signature" }, 401);
  if (p.op === 0) await hub(env).fetch("https://hub/event", { method: "POST", body: JSON.stringify({ t: p.t, d: p.d }) });
  return json({ op: 12, d: 0 });
}

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    if (url.pathname === "/health") return json({ ok: true, service: "teamagent", build: buildOf(env).slice(0, 8), deployed: env.VERSION?.timestamp || "" });
    if (url.pathname === "/qq/events" && req.method === "POST") return webhook(req, env);
    if (url.pathname.startsWith("/admin/")) {
      const given = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const a = new TextEncoder().encode(given), b = new TextEncoder().encode(env.ADMIN_TOKEN || "");
      if (!env.ADMIN_TOKEN || a.length !== b.length || !crypto.subtle.timingSafeEqual(a, b)) return json({ error: "unauthorized" }, 401);
      return hub(env).fetch(new Request("https://hub" + url.pathname + url.search, { method: req.method, body: req.method === "POST" ? await req.text() : undefined }));
    }
    return new Response("teamagent", { status: 200 });
  },
  async scheduled(_c: any, env: Env) {
    await hub(env).fetch("https://hub/tick?build=" + encodeURIComponent(buildOf(env))).catch(() => {});
  },
};
