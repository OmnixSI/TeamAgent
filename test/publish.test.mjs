// Offline tests for src/feat/publish.ts: a real SQLite (node:sqlite) behind a fake hub, and an in-memory bucket.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const mod = await import("../src/feat/publish.ts");
const feature = mod.default, { normPath, newId, contentType, LIMITS } = mod;
const BASE = "https://example.test";

function mkHub(opts = {}) {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q, ...b) {
      if (!b.length && q.includes(";")) { db.exec(q); return { toArray: () => [] }; }
      const st = db.prepare(q), rows = /^\s*(SELECT|WITH)/i.test(q) || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []);   // runs now, like the Hub's exec
      return { toArray: () => rows };
    },
  };
  const files = new Map(), ops = { put: 0, get: 0, del: 0 };
  const FILES = {
    files, ops,
    async put(k, v) { ops.put++; files.set(k, new Uint8Array(v)); },
    async get(k, o) {
      ops.get++;
      const v = files.get(k); if (!v) return null;
      const r = o?.range ? v.slice(o.range.offset, o.range.offset + o.range.length) : v;
      return { size: r.length, arrayBuffer: async () => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength) };
    },
    async delete(ks) { for (const k of [].concat(ks)) { ops.del++; files.delete(k); } },
    async list({ prefix }) { return { objects: [...files.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
  };
  const used = {};
  const hub = {
    sql, env: { FILES: opts.noBucket ? undefined : FILES, PUBLIC_URL: BASE + "/" },
    used, limits: {},
    plan: {
      take(n, x) { if ((used[n] || 0) + x > (hub.limits[n] ?? Infinity)) return false; used[n] = (used[n] || 0) + x; return true; },
      fits(n, x) { return (used[n] || 0) + x <= (hub.limits[n] ?? Infinity); },
    },
    shadow: c => (c.startsWith("t:") ? "g:main" : ""),
    images: new Map(),   // number -> { conv, mime, bytes }
    store: { async imageRef(conv, ref) { const i = hub.images.get(Number(ref.slice(1))); return i ? { label: ref, bytes: i.bytes, mime: i.mime } : null; } },
  };
  sql.exec(feature.schema);
  sql.exec("CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT, src TEXT)");
  hub.addImage = (conv, mime, bytes, note = "n", extra = {}) => {
    const id = Number(sql.exec("INSERT INTO img(conv,ts,mime,note,name,src) VALUES(?,?,?,?,?,?) RETURNING id", conv, Date.now(), mime, note, extra.name || null, extra.src || null).toArray()[0].id);
    hub.images.set(id, { conv, mime, bytes }); return id;
  };
  return hub;
}
const ctxOf = (hub, conv = "t:room", cfg = {}) => {
  let quota = cfg.quota ?? 1000;
  return {
    hub, conv, askers: [{ id: "1", name: "小明" }],
    host: {
      cfg: k => (k === "publish_daily" ? cfg.daily ?? 20 : 0),
      quota: async (kind, limit) => (quota-- > 0 && limit > 0),
      imageRef: async ref => { const m = /^g(\d+)$/.exec(ref); const i = m && hub.images.get(Number(m[1])); return i ? { label: ref, bytes: i.bytes, mime: i.mime } : null; },
    },
  };
};
const tool = ctx => feature.tools(ctx)[0];
const call = (hub, path, init = {}) => feature.open(hub, new Request(BASE + path, init), new URL(BASE + path));
const text = async r => await r.text();
const bytes = s => new TextEncoder().encode(s);
const idOf = r => r.id;

describe("pure helpers", () => {
  test("id format", () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) { const id = newId(); assert.match(id, /^[a-z0-9]{12}$/); seen.add(id); }
    assert.equal(seen.size, 200);
  });
  test("path normalisation", () => {
    assert.equal(normPath("index.html"), "index.html");
    assert.equal(normPath("./js//game.js"), "js/game.js");
    assert.equal(normPath("  a/b/c.png "), "a/b/c.png");
    assert.equal(normPath("页面/图.png"), "页面/图.png");
  });
  test("rejects traversal, absolute paths, backslashes and odd names", () => {
    for (const p of ["../x.html", "a/../../x.html", "a/..", "/etc/passwd.txt", "a\\b.html", "..\\x.html", "a/.hidden.js", ".env.txt", "", "   ", "a/", "noext", "a.exe", "a b?.html", "x%2e.html", "_api/x.json", "_img/1.png", "a\u0000.html", "a".repeat(130) + ".html", "a/b/c/d/e/f/g.html", null, 5])
      assert.equal(normPath(p), null, String(p));
  });
  test("content types", () => {
    const want = { html: "text/html", css: "text/css", js: "text/javascript", json: "application/json", png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp3: "audio/mpeg", mp4: "video/mp4", wasm: "application/wasm", txt: "text/plain", pdf: "application/pdf" };
    for (const [e, t] of Object.entries(want)) assert.ok(contentType("a." + e).startsWith(t), e);
    assert.ok(contentType("A.HTML").startsWith("text/html"));
    assert.equal(contentType("a.exe"), "");
  });
});

describe("create, serve, list, delete", () => {
  let hub, ctx, t;
  beforeEach(() => { hub = mkHub(); ctx = ctxOf(hub); t = tool(ctx); });

  test("create with html, serve index with headers, views once per GET", async () => {
    const r = await t.run({ op: "create", title: "测试", html: "<h1>你好</h1>" });
    assert.equal(r.ok, true);
    assert.match(r.id, /^[a-z0-9]{12}$/);
    assert.equal(r.url, BASE + "/p/" + r.id + "/");
    assert.equal(hub.used.r2_writes, 1);
    const res = await call(hub, "/p/" + r.id + "/");
    assert.equal(res.status, 200);
    assert.equal(await text(res), "<h1>你好</h1>");
    assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/);
    assert.equal(res.headers.get("cache-control"), "public, max-age=300");
    assert.ok(res.headers.get("etag"));
    assert.equal(hub.used.r2_reads, 1);
    await call(hub, "/p/" + r.id + "/index.html");
    await call(hub, "/p/" + r.id + "/", { method: "HEAD" });
    assert.equal(siteRow(hub, r.id).views, 2);
  });
  const siteRow = (h, id) => h.sql.exec("SELECT * FROM site WHERE id=?", id).toArray()[0];

  test("multi-file site: nested files, content types, HEAD, no-slash redirect, directory index", async () => {
    const r = await t.run({ op: "create", title: "多文件", files: [
      { path: "index.html", content: "<script src=js/a.js></script>" }, { path: "js/a.js", content: "alert(1)" },
      { path: "data.json", content: "{}" }, { path: "docs/index.html", content: "docs" } ] });
    assert.equal(r.ok, true); assert.equal(r.files, 4);
    const js = await call(hub, `/p/${r.id}/js/a.js`);
    assert.equal(js.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(await text(js), "alert(1)");
    assert.equal((await call(hub, `/p/${r.id}/data.json`)).headers.get("content-type"), "application/json; charset=utf-8");
    const reads = hub.used.r2_reads;
    const head = await call(hub, `/p/${r.id}/js/a.js`, { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(head.headers.get("content-length"), "8"); assert.equal(await text(head), "");
    assert.equal(hub.used.r2_reads, reads, "HEAD does not read R2");
    const bare = await call(hub, `/p/${r.id}`);
    assert.equal(bare.status, 301); assert.equal(bare.headers.get("location"), `/p/${r.id}/`);
    assert.equal(await text(await call(hub, `/p/${r.id}/docs/`)), "docs");
    assert.equal((await call(hub, `/p/${r.id}/docs`)).status, 301);
  });

  test("404s: unknown site, unknown file, traversal, wrong method, not ours", async () => {
    const r = await t.run({ op: "create", title: "x", html: "<p>x</p>" });
    for (const p of ["/p/aaaaaaaaaaaa/", `/p/${r.id}/nope.html`, `/p/${r.id}/..%2fsecret.txt`, `/p/${r.id}/a%5cb.html`, `/p/${r.id}/%zz`]) {
      const res = await call(hub, p);
      assert.equal(res.status, 404, p);
      assert.match(await text(res), /找不到/);
      assert.equal(res.headers.get("x-robots-tag"), "noindex, nofollow");
    }
    assert.equal((await call(hub, `/p/${r.id}/`, { method: "DELETE" })).status, 405);
    assert.equal(call(hub, "/p/short/"), null);
    assert.equal(call(hub, `/p/${r.id}/%2e%2e/x.html`), null, "the URL parser already resolved it out of the site");
    assert.equal(feature.open(hub, new Request(BASE + "/x/abc"), new URL(BASE + "/x/abc")), null);
  });

  test("ETag and 304 without touching R2", async () => {
    const r = await t.run({ op: "create", title: "e", html: "hello" });
    const first = await call(hub, `/p/${r.id}/`);
    const etag = first.headers.get("etag"), reads = hub.used.r2_reads;
    const second = await call(hub, `/p/${r.id}/`, { headers: { "If-None-Match": etag } });
    assert.equal(second.status, 304);
    assert.equal(hub.used.r2_reads, reads);
    assert.equal((await call(hub, `/p/${r.id}/`, { headers: { "If-None-Match": 'W/' + etag + ', "zzz"' } })).status, 304);
    assert.equal((await call(hub, `/p/${r.id}/`, { headers: { "If-None-Match": '"other"' } })).status, 200);
    await t.run({ op: "update", id: r.id, html: "changed" });
    const third = await call(hub, `/p/${r.id}/`, { headers: { "If-None-Match": etag } });
    assert.equal(third.status, 200, "update changes the ETag");
    assert.equal(await text(third), "changed");
  });

  test("range requests", async () => {
    const r = await t.run({ op: "create", title: "v", files: [{ path: "index.html", content: "x" }, { path: "a.txt", content: "0123456789" }] });
    const g = (h) => call(hub, `/p/${r.id}/a.txt`, { headers: { Range: h } });
    let res = await g("bytes=2-4"); assert.equal(res.status, 206); assert.equal(await text(res), "234"); assert.equal(res.headers.get("content-range"), "bytes 2-4/10");
    res = await g("bytes=7-"); assert.equal(await text(res), "789");
    res = await g("bytes=-3"); assert.equal(await text(res), "789");
    assert.equal((await g("bytes=50-")).status, 416);
  });

  test("R2 read allowance exhausted gives a Chinese 503", async () => {
    const r = await t.run({ op: "create", title: "x", html: "x" });
    hub.limits.r2_reads = 0;
    const res = await call(hub, `/p/${r.id}/`);
    assert.equal(res.status, 503); assert.match(await text(res), /额度/);
  });

  test("caps: size, file count, missing index, paths", async () => {
    let r = await t.run({ op: "create", title: "big", html: "a".repeat(LIMITS.siteBytes + 1) });
    assert.equal(r.ok, false); assert.match(r.error, /8\.0 MB|最多/);
    r = await t.run({ op: "create", title: "many", files: Array.from({ length: 61 }, (_, i) => ({ path: `f${i}.txt`, content: "x" })) });
    assert.equal(r.ok, false); assert.match(r.error, /60/);
    r = await t.run({ op: "create", title: "ok60", files: [{ path: "index.html", content: "x" }, ...Array.from({ length: 59 }, (_, i) => ({ path: `f${i}.txt`, content: "x" }))] });
    assert.equal(r.ok, true); assert.equal(r.files, 60);
    r = await t.run({ op: "create", title: "noindex", files: [{ path: "a.html", content: "x" }] });
    assert.equal(r.ok, false); assert.match(r.error, /index\.html/);
    for (const p of ["../a.html", "/a.html", "a\\b.html", "x.exe"]) {
      r = await t.run({ op: "create", title: "bad", files: [{ path: "index.html", content: "x" }, { path: p, content: "x" }] });
      assert.equal(r.ok, false, p); assert.match(r.error, /路径/);
    }
    r = await t.run({ op: "create", title: "empty" });
    assert.equal(r.ok, false);
    assert.equal(hub.env.FILES.files.size, 60, "nothing was written by the refused calls");
  });

  test("whole-store caps: 200 sites refused, old unviewed sites removed, 300 MB", async () => {
    const now = Date.now();
    for (let i = 0; i < 200; i++) hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,?,?,?)', "s" + String(i).padStart(11, "0"), "g:x", "t", now, now, "", 1, 10, 3);
    let r = await t.run({ op: "create", title: "n", html: "x" });
    assert.equal(r.ok, false); assert.match(r.error, /200/);
    // one year-old site nobody opened can go; one that was viewed cannot
    hub.sql.exec("UPDATE site SET created=?, views=0 WHERE id=?", now - LIMITS.oldMs - 1000, "s00000000007");
    hub.sql.exec("UPDATE site SET created=?, views=5 WHERE id=?", now - LIMITS.oldMs - 2000, "s00000000008");
    r = await t.run({ op: "create", title: "n", html: "x" });
    assert.equal(r.ok, true);
    assert.equal(hub.sql.exec("SELECT COUNT(*) c FROM site WHERE id=?", "s00000000007").toArray()[0].c, 0);
    assert.equal(hub.sql.exec("SELECT COUNT(*) c FROM site WHERE id=?", "s00000000008").toArray()[0].c, 1);
    // total bytes
    hub.sql.exec("UPDATE site SET bytes=? WHERE id=?", LIMITS.totalBytes - 5, "s00000000001");
    hub.sql.exec("DELETE FROM site WHERE id IN (?,?)", "s00000000002", "s00000000003");
    r = await t.run({ op: "create", title: "n2", html: "x".repeat(100) });
    assert.equal(r.ok, false); assert.match(r.error, /300 MB/);
  });

  test("daily quota and R2 write allowance", async () => {
    let r = await tool(ctxOf(hub, "t:q", { quota: 1 })).run({ op: "create", title: "a", html: "x" });
    assert.equal(r.ok, true);
    r = await tool(ctxOf(hub, "t:q", { quota: 0 })).run({ op: "create", title: "b", html: "x" });
    assert.equal(r.ok, false); assert.match(r.error, /今天/);
    hub.limits.r2_writes = hub.used.r2_writes;
    r = await t.run({ op: "create", title: "c", html: "x" });
    assert.equal(r.ok, false); assert.match(r.error, /R2/);
    assert.equal(hub.sql.exec("SELECT COUNT(*) c FROM site").toArray()[0].c, 1, "no row left behind");
  });

  test("img: replacement copies the picture into the site, relative to each file", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const g = hub.addImage("t:room", "image/png", png);
    const shared = hub.addImage("g:main", "image/jpeg", new Uint8Array([255, 216, 1]));
    const other = hub.addImage("g:other", "image/png", png);
    const r = await t.run({ op: "create", title: "pics", files: [
      { path: "index.html", content: `<img src="img:g${g}"><img src='img:g${shared}'><img src="img:g${other}"><style>a.img:hover{}</style><div style="background:url(img:g${g})"></div>` },
      { path: "sub/p.html", content: `<img src="img:g${g}">` },
    ] });
    assert.equal(r.ok, true);
    const idx = await text(await call(hub, `/p/${r.id}/`));
    assert.ok(idx.includes(`src="img/g${g}.png"`));
    assert.ok(idx.includes(`src='img/g${shared}.jpg'`), "the main group's picture is allowed in a test room");
    assert.ok(idx.includes(`src="img:g${other}"`), "another conversation's picture stays unresolved");
    assert.ok(idx.includes("a.img:hover") && idx.includes(`url(img/g${g}.png)`));
    assert.deepEqual(r.missing_images, ["g" + other]);
    assert.equal(await text(await call(hub, `/p/${r.id}/sub/p.html`)), `<img src="../img/g${g}.png">`);
    const res = await call(hub, `/p/${r.id}/img/g${g}.png`);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png);
    assert.equal(r.files, 4, "index, sub/p.html and two copied pictures");
  });

  test("update replaces and adds files, removes files, keeps index; other conversations cannot touch it", async () => {
    const r = await t.run({ op: "create", title: "u", files: [{ path: "index.html", content: "one" }, { path: "a.css", content: "a{}" }] });
    let u = await t.run({ op: "update", id: r.id, html: "two", files: [{ path: "b.js", content: "1" }], remove: ["a.css"], title: "新名字" });
    assert.equal(u.ok, true); assert.equal(u.files, 2); assert.match(u.url, /\?v=/);
    assert.equal(await text(await call(hub, `/p/${r.id}/`)), "two");
    assert.equal((await call(hub, `/p/${r.id}/a.css`)).status, 404);
    assert.equal(await text(await call(hub, `/p/${r.id}/b.js`)), "1");
    assert.equal(hub.env.FILES.files.has(`site/${r.id}/a.css`), false);
    u = await t.run({ op: "update", id: r.id, remove: ["index.html"] });
    assert.equal(u.ok, false);
    u = await t.run({ op: "update", id: r.id });
    assert.equal(u.ok, false);
    u = await tool(ctxOf(hub, "g:other")).run({ op: "update", id: r.id, html: "hijack" });
    assert.equal(u.ok, false);
    assert.equal(await text(await call(hub, `/p/${r.id}/`)), "two");
    const row = hub.sql.exec("SELECT title,files,bytes FROM site WHERE id=?", r.id).toArray()[0];
    assert.deepEqual({ ...row }, { title: "新名字", files: 2, bytes: 4 });
    // per-site cap applies to the result of an update too
    u = await t.run({ op: "update", id: r.id, files: [{ path: "big.txt", content: "x".repeat(LIMITS.siteBytes) }] });
    assert.equal(u.ok, false);
  });

  test("list shows only this conversation's sites; delete removes everything", async () => {
    const a = await t.run({ op: "create", title: "甲", html: "a" });
    await tool(ctxOf(hub, "g:other")).run({ op: "create", title: "乙", html: "b" });
    await call(hub, `/p/${a.id}/`);
    const l = await t.run({ op: "list" });
    assert.equal(l.sites.length, 1);
    assert.deepEqual({ title: l.sites[0].title, views: l.sites[0].views, url: l.sites[0].url, files: l.sites[0].files }, { title: "甲", views: 1, url: BASE + "/p/" + a.id + "/", files: 1 });
    assert.match(l.sites[0].size, /KB/);
    assert.equal((await tool(ctxOf(hub, "g:other")).run({ op: "delete", id: a.id })).ok, false);
    await call(hub, `/p/${a.id}/_api/state`, { method: "PUT", body: "{}" });
    await call(hub, `/p/${a.id}/_api/append`, { method: "POST", body: "1" });
    assert.equal((await t.run({ op: "delete", id: a.id })).ok, true);
    assert.equal((await call(hub, `/p/${a.id}/`)).status, 404);
    for (const tb of ["site", "site_file", "site_state", "site_item"]) assert.equal(hub.sql.exec(`SELECT COUNT(*) c FROM ${tb} WHERE id=?`, a.id).toArray()[0].c, 0, tb);
    assert.equal([...hub.env.FILES.files.keys()].some(k => k.includes(a.id)), false);
    assert.equal((await t.run({ op: "list" })).sites.length, 0);
    assert.equal((await t.run({ op: "nope" })).ok, false);
  });
});

describe("state API", () => {
  let hub, site;
  const put = (body, init = {}) => call(hub, `/p/${site}/_api/state`, { method: "PUT", body, ...init });
  const append = (body, init = {}) => call(hub, `/p/${site}/_api/append`, { method: "POST", body, ...init });
  beforeEach(async () => {
    hub = mkHub();
    site = (await tool(ctxOf(hub)).run({ op: "create", title: "g", html: "x" })).id;
  });

  test("get empty, put, get, replace", async () => {
    let r = await call(hub, `/p/${site}/_api/state`);
    assert.equal(r.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.deepEqual(await r.json(), {});
    assert.equal((await put('{"score": 3, "名": "甲"}')).status, 200);
    assert.deepEqual(await (await call(hub, `/p/${site}/_api/state`)).json(), { score: 3, 名: "甲" });
    await put("[1,2]");
    assert.deepEqual(await (await call(hub, `/p/${site}/_api/state`)).json(), [1, 2]);
  });
  test("put limits: invalid JSON, too large (64 KB), exact limit", async () => {
    assert.equal((await put("{nope")).status, 400);
    const big = JSON.stringify({ a: "x".repeat(LIMITS.state) });
    assert.equal((await put(big)).status, 413);
    const fits = JSON.stringify({ a: "x".repeat(LIMITS.state - 8) });
    assert.equal(new TextEncoder().encode(fits).length, LIMITS.state);
    assert.equal((await put(fits)).status, 200);
    assert.equal((await put(fits.replace("x", "字"))).status, 413, "bytes, not characters");
  });
  test("append: list, ≤2 KB, keeps last 500, after/limit", async () => {
    for (let i = 1; i <= 3; i++) assert.deepEqual(await (await append(JSON.stringify({ i }))).json(), { ok: true, n: i });
    let l = await (await call(hub, `/p/${site}/_api/list`)).json();
    assert.deepEqual(l, { ok: true, items: [{ i: 1 }, { i: 2 }, { i: 3 }], last: 3 });
    l = await (await call(hub, `/p/${site}/_api/list?after=2`)).json();
    assert.deepEqual(l.items, [{ i: 3 }]); assert.equal(l.last, 3);
    l = await (await call(hub, `/p/${site}/_api/list?limit=2`)).json();
    assert.deepEqual(l.items, [{ i: 2 }, { i: 3 }]);
    assert.equal((await append("nope")).status, 400);
    assert.equal((await append(JSON.stringify("x".repeat(LIMITS.item)))).status, 413);
    assert.equal((await append(JSON.stringify("x".repeat(LIMITS.item - 2)))).status, 200);
    hub.sql.exec("DELETE FROM site_item WHERE id=?", site);
    // fill to 520 without going through the rate limit
    for (let i = 1; i <= 520; i++) hub.sql.exec("INSERT INTO site_item(id,n,t,v) VALUES(?,?,?,?)", site, i, 0, String(i));
    assert.equal((await append("521")).status, 200);
    const left = hub.sql.exec("SELECT COUNT(*) c, MIN(n) lo, MAX(n) hi FROM site_item WHERE id=?", site).toArray()[0];
    assert.deepEqual({ ...left }, { c: 500, lo: 22, hi: 521 });
    const all = await (await call(hub, `/p/${site}/_api/list?limit=9999`)).json();
    assert.equal(all.items.length, 500); assert.equal(all.items.at(-1), 521);
  });
  test("rate limit per site per hour, other sites unaffected, resets next hour", async () => {
    for (let i = 0; i < LIMITS.writesPerHour; i++) assert.equal((await append("1")).status, 200, "write " + i);
    const r = await append("1");
    assert.equal(r.status, 429); assert.match((await r.json()).error, /频繁/);
    assert.equal((await put("{}")).status, 429);
    assert.equal((await call(hub, `/p/${site}/_api/state`)).status, 200, "reads are free");
    const other = (await tool(ctxOf(hub, "t:two")).run({ op: "create", title: "o", html: "x" })).id;
    assert.equal((await call(hub, `/p/${other}/_api/append`, { method: "POST", body: "1" })).status, 200);
    const real = Date.now; Date.now = () => real() + 3700000;
    try { assert.equal((await append("1")).status, 200); } finally { Date.now = real; }
  });
  test("refused writes do not count; cross-site writes refused; unknown routes and methods", async () => {
    for (let i = 0; i < 130; i++) await append("{bad");
    assert.equal((await append("1")).status, 200);
    assert.equal((await put("{}", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await put("{}", { headers: { "Sec-Fetch-Site": "same-origin" } })).status, 200);
    assert.equal((await call(hub, `/p/${site}/_api/state`, { method: "POST", body: "{}" })).status, 405);
    assert.equal((await call(hub, `/p/${site}/_api/append`, { method: "PUT", body: "1" })).status, 405);
    assert.equal((await call(hub, `/p/${site}/_api/other`)).status, 404);
    assert.equal((await call(hub, "/p/aaaaaaaaaaaa/_api/state")).status, 404);
    const r = await call(hub, `/p/${site}/_api/state`);
    assert.equal(r.headers.get("x-robots-tag"), "noindex, nofollow");
  });
  test("state is per site", async () => {
    const other = (await tool(ctxOf(hub, "t:two")).run({ op: "create", title: "o", html: "x" })).id;
    await put('{"mine":1}');
    assert.deepEqual(await (await call(hub, `/p/${other}/_api/state`)).json(), {});
  });
});

describe("gallery", () => {
  test("builds a page of this conversation's own pictures and refreshes the same site", async () => {
    const hub = mkHub(), ctx = ctxOf(hub, "g:room"), t = tool(ctx);
    assert.equal((await t.run({ op: "gallery" })).ok, false, "no pictures yet");
    const a = hub.addImage("g:room", "image/png", new Uint8Array([1, 2, 3]), "夕阳 <下>");
    hub.addImage("g:room", "image/png", new Uint8Array([9]), "角色", { name: "阿福" });
    hub.addImage("g:room", "image/png", new Uint8Array([9]), "群友的图", { src: "chat:1-0" });
    const b = hub.addImage("g:room", "image/jpeg", new Uint8Array([4, 5]), "海边");
    const r = await t.run({ op: "gallery" });
    assert.equal(r.ok, true); assert.equal(r.pictures, 2);
    const html = await text(await call(hub, `/p/${r.id}/`));
    assert.ok(html.indexOf(`_img/${b}`) < html.indexOf(`_img/${a}`), "newest first");
    assert.ok(html.includes("夕阳 &lt;下&gt;") && html.includes("海边"));
    assert.equal((html.match(/class="c"/g) || []).length, 2, "named and chat pictures are not listed");
    const img = await call(hub, `/p/${r.id}/_img/${a}`);
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/png");
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())], [1, 2, 3]);
    assert.equal((await call(hub, `/p/${r.id}/_img/${a}`, { headers: { "If-None-Match": img.headers.get("etag") } })).status, 304);
    // refresh keeps the id
    const c = hub.addImage("g:room", "image/png", new Uint8Array([7]), "新图");
    const r2 = await t.run({ op: "gallery" });
    assert.equal(r2.id, r.id); assert.equal(r2.pictures, 3);
    assert.ok((await text(await call(hub, `/p/${r.id}/`))).includes(`_img/${c}`));
    assert.equal(hub.sql.exec("SELECT COUNT(*) c FROM site").toArray()[0].c, 1);
    assert.equal(hub.sql.exec('SELECT title FROM site WHERE "by"=?', "gallery").toArray()[0].title, "图库");
  });
  test("the picture route refuses other conversations, named pictures, chat pictures, junk numbers", async () => {
    const hub = mkHub(), t = tool(ctxOf(hub, "g:room"));
    hub.addImage("g:room", "image/png", new Uint8Array([1]), "mine");
    const foreign = hub.addImage("g:other", "image/png", new Uint8Array([2]), "secret");
    const named = hub.addImage("g:room", "image/png", new Uint8Array([3]), "char", { name: "阿福" });
    const chat = hub.addImage("g:room", "image/png", new Uint8Array([4]), "chat", { src: "chat:1-0" });
    const r = await t.run({ op: "gallery" });
    for (const n of [foreign, named, chat, 9999, "abc", "1e3", "-1"]) assert.equal((await call(hub, `/p/${r.id}/_img/${n}`)).status, 404, String(n));
    assert.equal((await call(hub, `/p/${r.id}/_img/${foreign}`, { headers: { "If-None-Match": '"g' + foreign + '"' } })).status, 404, "no 304 for a foreign picture either");
    // a gallery in another conversation sees its own pictures only
    const r2 = await tool(ctxOf(hub, "g:other")).run({ op: "gallery" });
    assert.equal((await call(hub, `/p/${r2.id}/_img/${foreign}`)).status, 200);
  });
});

describe("feature shape", () => {
  test("tunable, schema, about", () => {
    assert.equal(feature.tunables.publish_daily.default, 20);
    assert.ok(feature.about.length >= 3 && feature.about.every(l => /[一-鿿]/.test(l)));
    const t = feature.tools({ hub: mkHub(), conv: "t:x", askers: [], host: {} })[0];
    assert.equal(t.name, "publish");
    assert.match(t.description, /API\+'append'/);
    assert.deepEqual(t.parameters.properties.op.enum, ["create", "update", "list", "delete", "gallery"]);
  });
  test("without a bucket publishing fails politely", async () => {
    const hub = mkHub({ noBucket: true });
    const r = await tool(ctxOf(hub)).run({ op: "create", title: "x", html: "x" });
    assert.equal(r.ok, false); assert.match(r.error, /存储/);
  });
});
