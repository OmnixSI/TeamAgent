// Offline tests for clickable preview links: cookie routing, reserved paths, token expiry, serving through the
// preview proxy, the one-link rule, budget refusals, keep-alive charging and shutdown after a restart.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";

registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    if (spec === "@cloudflare/puppeteer") return { url: "data:text/javascript,export default {}", shortCircuit: true };
    return next(spec, ctx);
  },
  // Until preview.ts exports gh (one word, asked of the lead), add the export when loading it for the test.
  load(url, ctx, next) {
    const r = next(url, ctx);
    if (url.endsWith("/src/feat/preview.ts")) {
      const src = String(r.source);
      if (!/export async function gh\(/.test(src)) return { ...r, source: src.replace("async function gh(", "export async function gh(") };
    }
    return r;
  },
});
const L = await import("../src/feat/previewlink.ts");
const P = await import("../src/feat/preview.ts");

const T = "0123456789abcdef0123456789abcdef";
const page = (body, headers = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html", ...headers } });

function fakeHub(opts = {}) {
  const m = opts.kv || new Map(), said = [], waits = [], proxied = [], ran = [], used = opts.used || {};
  const stop = { container_seconds: 72000, container_cpu_seconds: 18000 };
  const box = {
    async proxy(port, req) {
      proxied.push({ port, url: req.url, method: req.method, headers: Object.fromEntries(req.headers), body: req.body ? await req.text() : "" });
      if (opts.down) throw new Error("container is not running");
      return opts.app ? opts.app(req) : page("<script type=module src=/assets/app.js></script>");
    },
    async wake() { return { woke: false, bootstrap_seconds: 0 }; },
    async run(command) { ran.push(command); const bad = opts.failStart && command.includes("setsid"); return { command, exit: bad ? 1 : 0, stdout: bad ? "server did not answer" : "", stderr: "", seconds: 1 }; },
    async saveEnvironment() { return 0; },
    async meter() { return { boot: "b", cpu: 1 }; },
  };
  return {
    m, said, waits, proxied, ran, used,
    get: k => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    sql: { exec: (q, k) => { if (/^DELETE FROM kv WHERE k=\?/.test(q)) m.delete(k); return { toArray: () => [] }; } },
    plan: { fits: (n, a = 0) => (used[n] || 0) + a <= (stop[n] ?? Infinity), add: (n, a) => { used[n] = (used[n] || 0) + a; }, used: n => used[n] || 0 },
    ctx: { waitUntil: p => waits.push(p) },
    say: async (conv, text) => { said.push([conv, text]); return true; },
    env: { PUBLIC_URL: "https://bot.example.workers.dev", COMPUTER: { idFromName: () => "id", get: () => box } },
  };
}
/** A hub with an open link on port 4174 that expires at `exp`. */
function withLink(hub, now, exp, extra = {}) {
  hub.set("preview:tok:" + T, JSON.stringify({ port: 4174, exp }));
  hub.set("previewlink:open", JSON.stringify({ token: T, conv: "t:x", repo: "NextThought-Website", what: "分支 main", port: 4174, state: "open", started: now - 30000, opened: now, exp, minutes: 10, idle: 5, lastPing: now, ...extra }));
  return hub;
}
const req = (path, init = {}) => new Request("https://bot.example.workers.dev" + path, init);
const serve = (hub, path, init, now) => { const r = req(path, init); return L.serve(hub, r, new URL(r.url), now); };

describe("which requests a preview cookie captures", () => {
  const ck = "a=1; " + L.COOKIE + "=" + T + "; b=2";
  const at = p => L.liveTarget(new URL("https://bot.example.workers.dev" + p), ck);
  test("the app's own absolute paths go to the preview, query kept", () => {
    for (const p of ["/", "/assets/app.js", "/_next/static/chunks/main.js", "/@vite/client", "/node_modules/.vite/deps/vue.js", "/src/main.ts", "/client.html", "/administrator", "/xyz", "/px", "/healthz"])
      assert.equal(at(p), "/x/lv/" + T + p, p);
    assert.equal(at("/api/shop/orders?page=2"), "/x/lv/" + T + "/api/shop/orders?page=2");
  });
  test("the bot's own routes are never captured", () => {
    for (const p of ["/health", "/tick", "/event", "/admin", "/admin/", "/admin/status", "/p/abc/index.html", "/x/live/" + T, "/x/get/t/f", "/x/drop/t", "/x/preview/" + T + "/", "/qq/events", "/x", "/p", "/qq"])
      assert.equal(at(p), null, p);
  });
  test("dot segments are resolved before the check", () => {
    assert.equal(at("/assets/../admin/status"), null);
    assert.equal(at("/foo/%2e%2e/admin/x"), null);
  });
  test("no cookie, someone else's cookie or a malformed token: handled as usual", () => {
    const u = new URL("https://bot.example.workers.dev/assets/a.js");
    assert.equal(L.liveTarget(u, null), null);
    assert.equal(L.liveTarget(u, "tapv=" + T), null);
    assert.equal(L.liveTarget(u, L.COOKIE + "=" + T.toUpperCase()), null);
    assert.equal(L.liveTarget(u, L.COOKIE + "=" + T + "00"), null);
    assert.equal(L.liveTarget(u, L.COOKIE + "=x;" + "app=" + T), null);
  });
  test("our cookie is taken out of what the app sees", () => {
    assert.equal(L.stripCookie(ck), "a=1; b=2");
    assert.equal(L.stripCookie(L.COOKIE + "=" + T), "");
  });
});

describe("link paths", () => {
  test("parse", () => {
    assert.deepEqual(L.parseLive("/x/live/" + T), { kind: "enter", token: T, path: "/" });
    assert.deepEqual(L.parseLive("/x/live/" + T + "/client.html"), { kind: "enter", token: T, path: "/client.html" });
    assert.deepEqual(L.parseLive("/x/lv/" + T + "/assets/a.js"), { kind: "pass", token: T, path: "/assets/a.js" });
    assert.equal(L.parseLive("/x/live/short"), null);
    assert.equal(L.parseLive("/x/preview/" + T + "/"), null);
  });
  test("landing never leaves the site", () => {
    assert.equal(L.landing("//evil.com/x"), "/evil.com/x");
    assert.equal(L.landing("/\\evil.com"), "/evil.com");
    assert.equal(L.landing("/client.html"), "/client.html");
    assert.equal(L.landing(""), "/");
  });
  test("cookie attributes: host-only, whole site, script cannot read it", () => {
    const c = L.setCookie(T, 599.7);
    assert.match(c, /^__Host-tapv=[a-f0-9]{32}; Path=\/; Max-Age=599; HttpOnly; Secure; SameSite=Lax$/);
    assert.ok(!/Domain=/i.test(c));
    assert.match(L.clearCookie(), /Max-Age=0/);
  });
  test("response headers: our cookie, service-worker scope and site wiping are dropped", () => {
    const h = new Headers({ "content-type": "text/html", "service-worker-allowed": "/", "clear-site-data": "\"cookies\"" });
    h.append("set-cookie", "sid=1; Path=/");
    h.append("set-cookie", L.COOKIE + "=" + "f".repeat(32) + "; Path=/; Secure");
    h.append("set-cookie", "theme=dark; Path=/");
    const out = L.cleanHeaders(h);
    assert.deepEqual(out.getSetCookie(), ["sid=1; Path=/", "theme=dark; Path=/"]);
    assert.equal(out.get("service-worker-allowed"), null);
    assert.equal(out.get("clear-site-data"), null);
    assert.equal(out.get("content-type"), "text/html");
  });
});

describe("serving", () => {
  const now = Date.now();   // preview_app's proxy checks tokens against the real clock
  test("the link sets the cookie for the rest of the window and lands on the page asked for", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    const r = await serve(hub, "/x/live/" + T + "/client.html", {}, now + 60000);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/client.html");
    assert.match(r.headers.get("set-cookie"), /Max-Age=540;/);
    assert.equal(r.headers.get("referrer-policy"), "no-referrer");
    assert.equal(JSON.parse(hub.get("previewlink:open")).entries, 1);
    assert.equal(hub.proxied.length, 0, "the entry does not touch the machine");
    const s = await serve(hub, "/x/live/" + T + "//evil.com", {}, now);
    assert.equal(s.headers.get("location"), "/evil.com");
  });
  test("forwarded requests reach the app's port with path, query, method, body and the app's own cookies only", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    const r = await serve(hub, "/x/lv/" + T + "/api/login?x=1", { method: "POST", body: "{\"a\":1}", headers: { cookie: "sid=9; " + L.COOKIE + "=" + T, "content-type": "application/json" } }, now);
    assert.equal(r.status, 200);
    const p = hub.proxied[0];
    assert.equal(p.port, 4174);
    assert.equal(p.url, "http://localhost:4174/api/login?x=1");
    assert.equal(p.method, "POST");
    assert.equal(p.body, "{\"a\":1}");
    assert.equal(p.headers.cookie, "sid=9");
  });
  test("an app cannot plant our cookie or a service worker; its redirects to localhost stay on the site", async () => {
    const hub = withLink(fakeHub({ app: () => new Response(null, { status: 302, headers: [["location", "http://localhost:4174/login"], ["set-cookie", L.COOKIE + "=" + "e".repeat(32) + "; Path=/"], ["set-cookie", "sid=2"], ["service-worker-allowed", "/"]] }) }), now, now + 600000);
    const r = await serve(hub, "/x/lv/" + T + "/", {}, now);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/login");
    assert.deepEqual(r.headers.getSetCookie(), ["sid=2"]);
    assert.equal(r.headers.get("service-worker-allowed"), null);
    const sw = await serve(hub, "/x/lv/" + T + "/sw.js", { headers: { "service-worker": "script" } }, now);
    assert.equal(sw.status, 403);
  });
  test("WebSocket upgrades are refused without touching the machine", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    const r = await serve(hub, "/x/lv/" + T + "/", { headers: { upgrade: "websocket", connection: "Upgrade" } }, now);
    assert.equal(r.status, 501);
    assert.equal(hub.proxied.length, 0);
  });
  test("after expiry nothing reaches the machine, even before the tick closed the link, and the cookie is cleared", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    for (const p of ["/x/lv/" + T + "/assets/a.js", "/x/live/" + T]) {
      const r = await serve(hub, p, { headers: { cookie: L.COOKIE + "=" + T } }, now + 600000);
      assert.equal(r.status, 410);
      assert.match(r.headers.get("set-cookie"), /Max-Age=0/);
    }
    const old = await serve(hub, "/x/live/" + "c".repeat(32), { headers: { cookie: L.COOKIE + "=" + T } }, now);
    assert.equal(old.status, 410);
    assert.equal(old.headers.get("set-cookie"), null, "an old link does not drop the cookie of the open one");
    assert.equal(hub.proxied.length, 0);
  });
  test("an unknown token or a token of another kind is refused", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    assert.equal((await serve(hub, "/x/lv/" + "a".repeat(32) + "/", {}, now)).status, 410);
    // a plain preview_app token (screenshots) is not a live link
    P.issueToken(hub, 4173, now, 60000);
    const other = [...hub.m.keys()].find(k => k.startsWith("preview:tok:") && !k.endsWith(T)).slice(12);
    assert.equal((await serve(hub, "/x/lv/" + other + "/", {}, now)).status, 410);
    assert.equal(hub.proxied.length, 0);
    assert.equal(await serve(hub, "/x/drop/abc", {}, now), null, "other /x/ paths are not ours");
  });
});

describe("opening", () => {
  const recipe = P.RECIPES["NextThought-Website"];
  const resolve = async () => ({ full: "OmnixSI/NextThought-Website", target: { label: "main", slot: "live", refspec: "refs/heads/main" }, what: "分支 main", recipe, ghToken: "" });
  const args = { conv: "t:x", repo: "NextThought-Website", pr: 0, ref: "", minutes: 10, idle: 5, page: "#/orders" };
  test("starts the app, issues an expiring token and answers with a link", async () => {
    const hub = fakeHub(), now = 50_000_000;
    const r = await L.openLink(hub, args, { resolve, now: () => now });
    assert.equal(r.ok, true, JSON.stringify(r));
    const m = /^https:\/\/bot\.example\.workers\.dev\/x\/live\/([a-f0-9]{32})\/#\/orders$/.exec(r.url);
    assert.ok(m, r.url);
    assert.equal(P.checkToken(hub, m[1], now + 599000), 4174);
    assert.equal(P.checkToken(hub, m[1], now + 600000), 0, "the token dies with the window");
    const l = L.load(hub);
    assert.equal(l.state, "open"); assert.equal(l.exp, now + 600000); assert.equal(l.token, m[1]);
    assert.ok(hub.ran.some(c => c.includes("http.server 4174")), "used preview_app's recipe and commands");
    assert.equal(hub.get("preview:busy"), String(now));
    assert.match(L.linkRefusal(hub, 60, now + 1000), /一次只能开一个/);
  });
  test("refuses when the window does not fit this month's machine allowance, before starting anything", async () => {
    const hub = fakeHub({ used: { container_seconds: 72000 - 500 } });
    const r = await L.openLink(hub, args, { resolve });
    assert.equal(r.ok, false);
    assert.match(r.error, /额度/);
    assert.equal(hub.ran.length, 0);
    assert.equal(L.load(hub), null);
    // after start-up time is known: a recipe with an install needs more
    const hub2 = fakeHub({ used: { container_seconds: 72000 - 900 } });
    const r2 = await L.openLink(hub2, args, { resolve: async () => ({ ...(await resolve()), recipe: { ...recipe, install: "npm ci" } }) });
    assert.equal(r2.ok, false); assert.match(r2.error, /额度/); assert.equal(hub2.ran.length, 0);
    assert.equal(hub2.get("preview:busy"), "0");
  });
  test("refuses while preview_app is running", () => {
    const hub = fakeHub(), now = 5_000_000;
    hub.set("preview:busy", String(now - 60000));
    assert.match(L.linkRefusal(hub, 600, now), /正在跑一个预览/);
    hub.set("preview:busy", "0");
    assert.equal(L.linkRefusal(hub, 600, now), "");
  });
  test("a failed start cleans up and frees the lock", async () => {
    const hub = fakeHub({ failStart: true });
    const r = await L.openLink(hub, args, { resolve });
    assert.equal(r.ok, false);
    assert.match(r.output, /server did not answer/);
    assert.equal(L.load(hub), null);
    assert.equal(hub.get("preview:busy"), "0");
    assert.ok(hub.ran.at(-1).includes("rm -rf /work/preview"), "stopped what was started");
  });
  test("repositories that cannot run are refused without the machine", async () => {
    const hub = fakeHub();
    const r = await L.openLink(hub, args, { resolve: async () => ({ ...(await resolve()), recipe: P.RECIPES.NextThought }) });
    assert.equal(r.ok, false); assert.equal(hub.ran.length, 0); assert.equal(L.load(hub), null);
  });
});

describe("keeping alive and closing", () => {
  const now = Date.now();
  test("each tick pings the app, charges machine time up to the sleep line and holds the preview lock", async () => {
    const hub = withLink(fakeHub(), now, now + 600000);
    hub.set("computer:billed_until", String(now + 90000));   // the start-up run charged up to here
    await L.tick(hub, now + 20000);
    assert.equal(hub.proxied.length, 1);
    assert.equal(hub.proxied[0].url, "http://localhost:4174/");
    assert.equal(hub.used.container_seconds, 20);
    assert.equal(hub.get("computer:billed_until"), String(now + 110000));
    await L.tick(hub, now + 40000);
    assert.equal(hub.used.container_seconds, 40, "no double counting");
    assert.equal(hub.get("preview:busy"), String(now + 40000));
    assert.equal(L.load(hub).lastPing, now + 40000);
  });
  test("closes at expiry after a restart: token gone, app stopped, group told", async () => {
    const kv = new Map();
    withLink(fakeHub({ kv }), now, now + 600000);
    const hub = fakeHub({ kv });                               // a fresh object over the same storage
    hub.set("previewlink:open", JSON.stringify({ ...L.load(hub), lastPing: now + 590000 }));
    await L.tick(hub, now + 600000);
    assert.equal(L.load(hub), null);
    assert.equal(hub.get("preview:tok:" + T), null);
    assert.equal(hub.get("preview:busy"), "0");
    assert.equal(hub.proxied.length, 0, "no ping after expiry");
    await Promise.all(hub.waits);
    assert.ok(hub.ran.some(c => c.includes("rm -rf /work/preview")));
    assert.match(hub.said[0][1], /预览链接关了（到时间了）/);
    assert.equal((await serve(hub, "/x/lv/" + T + "/", {}, now + 1000)).status, 410);
  });
  test("a machine that went to sleep is not woken just to stop the app", async () => {
    const hub = withLink(fakeHub(), now, now + 600000, { lastPing: now - 300000, lastVisit: now });
    await L.tick(hub, now + 600000);
    await Promise.all(hub.waits);
    assert.equal(hub.ran.length, 0);
    assert.equal(L.load(hub), null);
  });
  test("closes early when nobody uses it", async () => {
    const hub = withLink(fakeHub(), now, now + 1200000);
    await L.tick(hub, now + 4 * 60000);
    assert.ok(L.load(hub), "still open after 4 minutes");
    await serve(hub, "/x/live/" + T, {}, now + 4 * 60000);
    await L.tick(hub, now + 8 * 60000);
    assert.ok(L.load(hub), "a visit restarts the count");
    await L.tick(hub, now + 9 * 60000 + 1000);
    assert.equal(L.load(hub), null);
    assert.match(hub.said[0][1], /5 分钟没人用/);
  });
  test("closes when the app stops answering twice", async () => {
    const hub = withLink(fakeHub({ down: true }), now, now + 600000);
    await L.tick(hub, now + 20000);
    assert.ok(L.load(hub));
    assert.equal(hub.used.container_seconds, undefined, "no charge when the machine did not answer");
    await L.tick(hub, now + 40000);
    assert.equal(L.load(hub), null);
    assert.match(hub.said[0][1], /网页服务停了/);
  });
  test("closes when the month's allowance reaches the stop line", async () => {
    const hub = withLink(fakeHub({ used: { container_seconds: 71950 } }), now, now + 600000);
    await L.tick(hub, now + 20000);
    assert.equal(L.load(hub), null);
  });
  test("a start cut off by a restart is cleared without touching the machine", async () => {
    const hub = fakeHub();
    hub.set("previewlink:open", JSON.stringify({ token: T, conv: "t:x", repo: "r", what: "", port: 0, state: "starting", started: now, minutes: 10, idle: 5 }));
    hub.set("preview:busy", String(now));
    await L.tick(hub, now + 60000);
    assert.ok(L.load(hub), "a normal start is left alone");
    await L.tick(hub, now + 800000);
    assert.equal(L.load(hub), null);
    assert.equal(hub.get("preview:busy"), "0");
    assert.equal(hub.proxied.length + hub.ran.length, 0);
  });
});

describe("the tool", () => {
  const host = (over = {}) => ({ cfg: k => ({ previewlink_minutes: 10, previewlink_daily: 3, previewlink_idle_minutes: 5 })[k], quota: async () => true, ...over });
  const tool = (hub, h = host()) => L.default.tools({ hub, conv: "t:x", askers: [], host: h })[0];
  test("list and close", async () => {
    const now = Date.now(), hub = withLink(fakeHub(), now, now + 600000, { url: "https://u" });
    const list = await tool(hub).run({ op: "list" });
    assert.equal(list.links.length, 1); assert.equal(list.links[0].url, "https://u");
    const c = await tool(hub).run({ op: "close" });
    assert.equal(c.closed, true);
    assert.equal(L.load(hub), null);
    assert.deepEqual((await tool(hub).run({ op: "list" })).links, []);
    assert.equal((await tool(hub).run({ op: "close" })).closed, false);
  });
  test("argument checks, the daily count and repos that cannot run", async () => {
    const hub = fakeHub();
    assert.match((await tool(hub).run({ repo: "a b" })).error, /仓库名/);
    assert.match((await tool(hub).run({ repo: "x", pr: -1 })).error, /PR/);
    assert.match((await tool(hub).run({ repo: "TeamAgent" })).error, /没法预览/);
    assert.match((await tool(hub, host({ quota: async () => false })).run({ repo: "x" })).error, /次数用完/);
    assert.match((await tool(hub).run({ op: "nope" })).error, /op/);
  });
  test("tunables are bounded with a 20-minute ceiling", () => {
    const t = L.default.tunables;
    assert.equal(t.previewlink_minutes.default, 10); assert.equal(t.previewlink_minutes.max, 20);
    assert.equal(t.previewlink_daily.default, 3);
  });
});
