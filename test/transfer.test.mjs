// Offline tests for the R2 transfer routes and the cloud computer's cache decisions (src/feat/transfer.ts).
// The Hub's SQLite is a real in-memory node:sqlite database; the bucket is a Map.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const T = await import("../src/feat/transfer.ts");
const feature = T.default;

function fakeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  db.exec(feature.schema);
  const objects = new Map();
  const used = new Map();
  const read = async body => {
    if (body instanceof Uint8Array) return body;
    const chunks = [];
    for await (const c of body) chunks.push(c);
    return new Uint8Array(Buffer.concat(chunks));
  };
  const hub = {
    sql: { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },   // runs at once, like the real one
    get: k => db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? null,
    set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    plan: {
      used: n => used.get(n) || 0,
      fits: (n, a = 0) => (used.get(n) || 0) + a <= 1000,
      add: (n, a) => used.set(n, (used.get(n) || 0) + a),
    },
    env: {
      PUBLIC_URL: "https://bot.example/",
      FILES: {
        objects,
        async put(key, body) { const b = await read(body); objects.set(key, b); return { size: b.length }; },
        async get(key) { const b = objects.get(key); return b ? { body: new Blob([b]).stream(), size: b.length } : null; },
        async delete(key) { objects.delete(key); },
      },
    },
  };
  return hub;
}

const bytes = (s) => new TextEncoder().encode(s);
const req = (method, path, body, headers = {}) => {
  const h = new Headers(headers);
  const b = body === undefined ? null : body;
  return { method, url: "https://bot.example" + path, headers: { get: k => (k.toLowerCase() === "content-length" && b && !h.has(k) ? String(b.length) : h.get(k)) }, body: b && new Blob([b]).stream() };
};
const call = (hub, r) => feature.open(hub, r, new URL(r.url));

describe("tokens", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });

  test("a token is random, single-direction and confined to its prefix and name", () => {
    const a = T.newToken(), b = T.newToken();
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.notEqual(a, b);
    const t = T.issue(hub, { mode: "put", prefix: "computer/ws/", name: "job.tar.zst" });
    const g = T.grant(hub, t);
    assert.equal(T.allowed(g, "put", "job.tar.zst"), "computer/ws/job.tar.zst");
    assert.equal(T.allowed(g, "get", "job.tar.zst"), null, "a put token cannot read");
    assert.equal(T.allowed(g, "put", "other.tar.zst"), null, "an exact-name token cannot write another name");
    const open = { mode: "get", prefix: "computer/cache/", exp: Date.now() + 1000 };
    assert.equal(T.allowed(open, "get", "env-1.tar.zst"), "computer/cache/env-1.tar.zst");
    for (const bad of ["../x", "a/b", "..", "", ".hidden", "a\\b", "x".repeat(200)]) assert.equal(T.allowed(open, "get", bad), null, bad);
    assert.equal(T.grant(hub, "nothex"), null);
    assert.equal(T.grant(hub, T.newToken()), null, "unknown token");
  });

  test("tokens expire", () => {
    const g = { mode: "get", prefix: "p/", exp: 5000 };
    assert.equal(T.allowed(g, "get", "a", 4999), "p/a");
    assert.equal(T.allowed(g, "get", "a", 5000), null);
    const t = T.issue(hub, { mode: "get", prefix: "p/" }, 60);
    const exp = T.grant(hub, t).exp;
    assert.ok(exp > Date.now() + 59000 && exp <= Date.now() + 60000);
  });

  test("nothing is reachable without a valid token", async () => {
    const t = T.issue(hub, { mode: "put", prefix: "computer/ws/", name: "a" });
    assert.equal((await call(hub, req("PUT", "/x/put/" + T.newToken() + "/a", bytes("x")))).status, 404);
    assert.equal((await call(hub, req("PUT", "/x/put/" + t + "/b", bytes("x")))).status, 404);
    assert.equal((await call(hub, req("GET", "/x/get/" + t + "/a"))).status, 404, "a put token cannot read");
    assert.equal((await call(hub, req("PUT", "/x/get/" + t + "/a", bytes("x")))).status, 405);
    assert.equal((await call(hub, req("PUT", "/x/put/" + t + "/..%2Fescape", bytes("x")))).status, 404);
    assert.equal(await call(hub, req("GET", "/x/other/abc")), null, "foreign paths fall through");
    assert.equal(hub.env.FILES.objects.size, 0);
  });

  test("the link carries token and name", () => {
    assert.equal(T.link(hub, "get", "ab", "env-1.tar.zst"), "https://bot.example/x/get/ab/env-1.tar.zst");
  });

  test("sweep drops expired tokens and stalled uploads", async () => {
    const live = T.issue(hub, { mode: "get", prefix: "p/" });
    hub.set("xfer:tok:" + "0".repeat(32), JSON.stringify({ mode: "get", prefix: "p/", exp: 1 }));
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES('p/old',5,1,0,1)");
    hub.env.FILES.objects.set("p/old.part0000", bytes("hello"));
    await T.sweep(hub, Date.now());
    assert.equal(T.grant(hub, "0".repeat(32)), null);
    assert.ok(T.grant(hub, live));
    assert.equal(T.row(hub, "p/old"), null);
    assert.equal(hub.env.FILES.objects.size, 0);
  });
});

describe("multipart upload and download", () => {
  let hub, put, get;
  beforeEach(() => {
    hub = fakeHub();
    put = T.issue(hub, { mode: "put", prefix: "computer/ws/", name: "big.tar.zst" });
    get = T.issue(hub, { mode: "get", prefix: "computer/ws/", name: "big.tar.zst" });
  });

  test("part names sort in order and part counts round up", () => {
    assert.equal(T.partKey("k", 0), "k.part0000");
    assert.equal(T.partKey("k", 12), "k.part0012");
    assert.ok(T.partKey("k", 2) < T.partKey("k", 10));
    assert.equal(T.partCount(0), 1);
    assert.equal(T.partCount(T.PART), 1);
    assert.equal(T.partCount(2 * T.PART + 1), 3);
    assert.ok(T.PART < 100 * 1024 * 1024 && T.PART_MAX < 100 * 1024 * 1024, "below Cloudflare's body limit");
  });

  test("parts upload in order and download as one body", async () => {
    const parts = ["alpha-", "beta-", "gamma"];
    const url = i => "/x/put/" + put + "/big.tar.zst?part=" + i + "&last=" + (i === 2 ? 1 : 0);
    assert.equal((await call(hub, req("PUT", url(0), bytes(parts[0])))).status, 200);
    assert.equal((await call(hub, req("GET", "/x/get/" + get + "/big.tar.zst"))).status, 404, "unfinished uploads are not served");
    assert.equal((await call(hub, req("PUT", url(2), bytes(parts[2])))).status, 409, "a part cannot skip ahead");
    assert.equal((await call(hub, req("PUT", url(1), bytes(parts[1])))).status, 200);
    assert.equal((await call(hub, req("PUT", url(2), bytes(parts[2])))).status, 200);
    assert.deepEqual([...hub.env.FILES.objects.keys()].sort(), ["computer/ws/big.tar.zst.part0000", "computer/ws/big.tar.zst.part0001", "computer/ws/big.tar.zst.part0002"]);
    const r = await call(hub, req("GET", "/x/get/" + get + "/big.tar.zst"));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-length"), "16");
    assert.equal(await r.text(), "alpha-beta-gamma");
    assert.equal(hub.plan.used("r2_writes"), 3);
    assert.equal(hub.plan.used("r2_reads"), 3);
    assert.deepEqual(T.row(hub, "computer/ws/big.tar.zst"), { key: "computer/ws/big.tar.zst", size: 16, parts: 3, done: 1, at: T.row(hub, "computer/ws/big.tar.zst").at });
  });

  test("a new part 0 replaces the old version and its parts", async () => {
    for (const [i, s] of [[0, "aaaa"], [1, "bbbb"]]) await call(hub, req("PUT", "/x/put/" + put + "/big.tar.zst?part=" + i + "&last=" + i, bytes(s)));
    assert.equal(T.stored(hub), 8);
    await call(hub, req("PUT", "/x/put/" + put + "/big.tar.zst", bytes("new")));
    assert.equal(T.stored(hub), 3);
    assert.deepEqual([...hub.env.FILES.objects.keys()], ["computer/ws/big.tar.zst.part0000"]);
    assert.equal(await (await call(hub, req("GET", "/x/get/" + get + "/big.tar.zst"))).text(), "new");
  });

  test("Content-Length is required and parts are size-capped", async () => {
    const noLen = { method: "PUT", url: "https://bot.example/x/put/" + put + "/big.tar.zst", headers: { get: () => null }, body: new Blob([bytes("x")]).stream() };
    assert.equal((await call(hub, noLen)).status, 411);
    const huge = req("PUT", "/x/put/" + put + "/big.tar.zst", bytes("x"), { "content-length": String(T.PART_MAX + 1) });
    assert.equal((await call(hub, huge)).status, 413);
  });

  test("keysUnder lists one prefix only", () => {
    for (const k of ["computer/cache/env-a.tar.zst", "computer/cache/env-b.tar.zst", "computer/cachex/y", "computer/ws/w.tar.zst"]) hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,1,1,1,1)", k);
    assert.deepEqual(T.keysUnder(hub, "computer/cache/").sort(), ["computer/cache/env-a.tar.zst", "computer/cache/env-b.tar.zst"]);
    assert.deepEqual(T.keysUnder(hub, "computer/ws/"), ["computer/ws/w.tar.zst"]);
  });
});

describe("byte accounting", () => {
  test("stored bytes add up and the 1.5 GB cap holds", async () => {
    const hub = fakeHub();
    assert.equal(T.CAP, 1.5 * 1024 ** 3);
    assert.equal(T.fitsCap(T.CAP - 10, 0, 10), true);
    assert.equal(T.fitsCap(T.CAP - 10, 0, 11), false);
    assert.equal(T.fitsCap(T.CAP, 100, 100), true, "replacing an object frees its old bytes");
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES('computer/cache/env-a.tar.zst',?,1,1,1)", T.CAP - 10);
    assert.equal(T.stored(hub), T.CAP - 10);
    const t = T.issue(hub, { mode: "put", prefix: "computer/ws/", name: "w.tar.zst" });
    assert.equal((await call(hub, req("PUT", "/x/put/" + t + "/w.tar.zst", bytes("x".repeat(11))))).status, 507);
    assert.equal(hub.env.FILES.objects.size, 0, "a refused upload writes nothing");
    assert.equal((await call(hub, req("PUT", "/x/put/" + t + "/w.tar.zst", bytes("x".repeat(10))))).status, 200);
    assert.equal(T.stored(hub), T.CAP);
    await T.remove(hub, "computer/ws/w.tar.zst");
    assert.equal(T.stored(hub), T.CAP - 10);
  });

  test("uploads stop when the R2 write allowance is used up", async () => {
    const hub = fakeHub();
    hub.plan.add("r2_writes", 1000);
    const t = T.issue(hub, { mode: "put", prefix: "p/", name: "a" });
    assert.equal((await call(hub, req("PUT", "/x/put/" + t + "/a", bytes("x")))).status, 503);
  });
});

describe("cache decisions", () => {
  test("the cache name follows the install recipe", async () => {
    const a = await T.cacheName("apt-get install git\n");
    assert.match(a, /^env-[0-9a-f]{16}\.tar\.zst$/);
    assert.equal(await T.cacheName("apt-get install git\n"), a, "same recipe, same key");
    assert.notEqual(await T.cacheName("apt-get install git curl\n"), a, "a changed recipe misses the old cache");
  });

  test("restore when cached, install otherwise, install again when the restore fails", () => {
    assert.equal(T.bootPlan(true, true), "none");
    assert.equal(T.bootPlan(true, false), "none");
    assert.equal(T.bootPlan(false, true), "restore");
    assert.equal(T.bootPlan(false, false), "install");
    assert.equal(T.afterRestore(true), "done");
    assert.equal(T.afterRestore(false), "install");
    assert.equal(T.shouldSave(true, "https://x/put"), true);
    assert.equal(T.shouldSave(true, undefined), false, "no token, no save (cap reached or allowance used)");
    assert.equal(T.shouldSave(false, "https://x/put"), false, "a restored machine is not saved again");
  });

  test("workspace names", () => {
    assert.equal(T.workspaceName("report-2026"), "report-2026");
    for (const bad of ["", "../x", "a/b", "a b", "x".repeat(41)]) assert.equal(T.workspaceName(bad), null, bad);
  });
});
