// Offline tests for availability monitoring: real SQLite (node:sqlite), scripted fetch, fake clock.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { deps, LIMITS, probe, checkTarget, prune, uptimePct, span } from "../src/feat/uptime.ts";

const H = 3600000, MIN = 60000, D = 86400000;
const T0 = Date.parse("2026-11-15T00:00:00Z");
let hub, said, pending, script, calls, active, maxActive;

function makeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  const kv = new Map();
  return {
    sql: { exec: (q, ...b) => { const r = db.prepare(q).all(...b); return { toArray: () => r }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)),
    ctx: { waitUntil: p => void pending.push(p) },
    say: async (conv, text) => void said.push({ conv, text }),
    db,
  };
}
// script: url -> array of steps (last repeats) or function; a step is { status, body, delay, throw }.
function fakeFetch() {
  deps.fetch = async (url, init) => {
    calls.push({ url, init });
    active++; maxActive = Math.max(maxActive, active);
    try {
      let s = script[url];
      if (typeof s === "function") s = s(calls.filter(c => c.url === url).length);
      else if (Array.isArray(s)) s = s[Math.min(calls.filter(c => c.url === url).length - 1, s.length - 1)];
      s = s || { status: 200, body: "ok" };
      if (s.delay) await new Promise((res, rej) => { const t = setTimeout(res, s.delay); init.signal?.addEventListener("abort", () => { clearTimeout(t); rej(Object.assign(new Error("aborted"), { name: "AbortError" })); }); });
      if (s.throw) throw new Error(s.throw);
      const st = s.status ?? 200;
      return new Response([204, 304].includes(st) ? null : (s.body ?? ""), { status: st });
    } finally { active--; }
  };
}
const tool = (conv = "t:a") => feature.tools({ hub, conv, askers: [{ name: "小明" }], host: {} })[0];
const run = (a, conv) => tool(conv).run(a);
const row = id => hub.db.prepare("SELECT * FROM uptime WHERE id=?").get(id);
const settle = async () => { while (pending.length) await pending.shift(); };
const U = "https://site.test/";
const addRow = (extra = {}) => {
  const o = { conv: "t:a", name: "站", url: U, method: "GET", expect_status: null, expect_text: null, every_min: 5, timeout_ms: 1000, ...extra };
  return Number(hub.db.prepare("INSERT INTO uptime(conv,name,url,method,expect_status,expect_text,every_min,timeout_ms,state,since,fails,oks,created,next,active,slow_n) VALUES(?,?,?,?,?,?,?,?,?,?,0,0,?,?,1,0) RETURNING id")
    .get(o.conv, o.name, o.url, o.method, o.expect_status, o.expect_text, o.every_min, o.timeout_ms, o.state ?? "up", T0, o.created ?? T0, o.next ?? T0).id);
};
const check = (id, now) => checkTarget(hub, row(id), now);
const lines = () => said.map(s => s.text);

beforeEach(() => {
  said = []; pending = []; script = {}; calls = []; active = 0; maxActive = 0;
  hub = makeHub(); fakeFetch();
  LIMITS.slowFloorMs = 200;
});

describe("success rules", () => {
  test("default accepts 2xx and 3xx, rejects 4xx and 5xx", async () => {
    for (const [status, ok] of [[200, true], [204, true], [301, true], [404, false], [500, false], [503, false]]) {
      script[U] = { status };
      assert.equal((await probe({ url: U, method: "GET", expect_status: null, expect_text: null, timeout_ms: 500 })).ok, ok, String(status));
    }
  });
  test("expect_status is exact", async () => {
    script[U] = { status: 401 };
    assert.equal((await probe({ url: U, method: "GET", expect_status: 401, expect_text: null, timeout_ms: 500 })).ok, true);
    script[U] = { status: 200 };
    const r = await probe({ url: U, method: "GET", expect_status: 401, expect_text: null, timeout_ms: 500 });
    assert.equal(r.ok, false);
    assert.match(r.error, /200/);
  });
  test("expect_text must appear in the body, status alone is not enough", async () => {
    const t = { url: U, method: "GET", expect_status: null, expect_text: '"ok":true', timeout_ms: 500 };
    script[U] = { body: '{"ok":true}' };
    assert.equal((await probe(t)).ok, true);
    script[U] = { body: '{"ok":false}' };
    const r = await probe(t);
    assert.equal(r.ok, false);
    assert.match(r.error, /约定的文字/);
  });
  test("only the first 200 KB of the body is searched", async () => {
    const t = { url: U, method: "GET", expect_status: null, expect_text: "NEEDLE", timeout_ms: 500 };
    script[U] = { body: "a".repeat(LIMITS.bodyBytes + 5000) + "NEEDLE" };
    assert.equal((await probe(t)).ok, false);
    script[U] = { body: "a".repeat(1000) + "NEEDLE" };
    assert.equal((await probe(t)).ok, true);
  });
  test("follows redirects, sends GET by default and HEAD on request (GET when text is expected)", async () => {
    await probe({ url: U, method: "GET", expect_status: null, expect_text: null, timeout_ms: 500 });
    await probe({ url: U, method: "HEAD", expect_status: null, expect_text: null, timeout_ms: 500 });
    await probe({ url: U, method: "HEAD", expect_status: null, expect_text: "x", timeout_ms: 500 });
    assert.deepEqual(calls.map(c => c.init.method), ["GET", "HEAD", "GET"]);
    assert.ok(calls.every(c => c.init.redirect === "follow"));
  });
});

describe("error classification", () => {
  const t = { url: U, method: "GET", expect_status: null, expect_text: null, timeout_ms: 60 };
  test("timeout", async () => {
    script[U] = { delay: 500 };
    const r = await probe(t);
    assert.equal(r.ok, false);
    assert.match(r.error, /超时/);
    assert.ok(r.ms < 400);
  });
  test("dns, tls, other", async () => {
    script[U] = { throw: "getaddrinfo ENOTFOUND site.test" };
    assert.match((await probe(t)).error, /域名解析|DNS/);
    script[U] = { throw: "TLS handshake failed: certificate has expired" };
    assert.match((await probe(t)).error, /TLS|证书/);
    script[U] = { throw: "Network connection lost." };
    assert.match((await probe(t)).error, /断开/);
    script[U] = { status: 502 };
    assert.match((await probe(t)).error, /502/);
  });
});

describe("state machine", () => {
  test("a single failure or two do not declare DOWN and re-check after 30 s", async () => {
    const id = addRow();
    script[U] = [{ status: 500 }];
    await check(id, T0);
    assert.equal(row(id).state, "up");
    assert.equal(row(id).fails, 1);
    assert.equal(row(id).next, T0 + LIMITS.recheckMs);
    await check(id, T0 + 30000);
    assert.equal(row(id).fails, 2);
    assert.equal(row(id).next, T0 + 60000);
    assert.deepEqual(lines(), []);
  });
  test("a success in between resets the failure count", async () => {
    const id = addRow();
    script[U] = [{ status: 500 }, { status: 500 }, { status: 200 }, { status: 500 }, { status: 500 }];
    for (let i = 0; i < 5; i++) await check(id, T0 + i * 30000);
    assert.equal(row(id).state, "up");
    assert.equal(row(id).fails, 2);
    assert.deepEqual(lines(), []);
  });
  test("three failures: DOWN, one message with name, since and reason; next check back at the normal interval", async () => {
    const id = addRow({ name: "官网" });
    script[U] = { status: 503 };
    for (let i = 0; i < 3; i++) await check(id, T0 + i * 30000);
    assert.equal(row(id).state, "down");
    assert.equal(lines().length, 1);
    assert.match(lines()[0], /官网/);
    assert.match(lines()[0], /打不开了/);
    assert.match(lines()[0], /503/);
    assert.match(lines()[0], /2026-11-15|11-15|11月15/);
    assert.equal(said[0].conv, "t:a");
    const inc = hub.db.prepare("SELECT * FROM uptimeinc").all();
    assert.equal(inc.length, 1);
    assert.equal(inc[0].start, T0);
    assert.equal(inc[0].end, null);
    await check(id, T0 + 5 * MIN);
    assert.equal(lines().length, 1);
    assert.equal(row(id).next, T0 + 10 * MIN);
  });
  test("recovery needs two successes, then exactly one UP line with the downtime", async () => {
    const id = addRow({ name: "官网" });
    script[U] = [{ status: 500 }, { status: 500 }, { status: 500 }, { status: 200 }, { status: 500 }, { status: 200 }, { status: 200 }];
    for (let i = 0; i < 3; i++) await check(id, T0 + i * 30000);
    await check(id, T0 + 10 * MIN);                      // one success
    assert.equal(row(id).state, "down");
    assert.equal(row(id).next, T0 + 10 * MIN + LIMITS.recheckMs);
    await check(id, T0 + 20 * MIN);                      // failure resets the success count
    assert.equal(row(id).oks, 0);
    await check(id, T0 + 25 * MIN);
    assert.equal(row(id).state, "down");
    await check(id, T0 + 25 * MIN + 30000);
    assert.equal(row(id).state, "up");
    assert.equal(lines().length, 2);
    assert.match(lines()[1], /恢复/);
    assert.match(lines()[1], /25 分钟|26 分钟/);
    const inc = hub.db.prepare("SELECT * FROM uptimeinc").all();
    assert.equal(inc[0].end, T0 + 25 * MIN + 30000);
    await check(id, T0 + 40 * MIN);
    assert.equal(lines().length, 2);
  });
  test("a new target that fails three times from the start also goes DOWN once", async () => {
    const id = addRow({ state: "new" });
    script[U] = { throw: "getaddrinfo ENOTFOUND" };
    for (let i = 0; i < 4; i++) await check(id, T0 + i * 30000);
    assert.equal(lines().length, 1);
    assert.match(lines()[0], /域名解析/);
  });
  test("two incidents produce two DOWN and two UP lines, nothing else", async () => {
    const id = addRow();
    let t = T0;
    for (const status of [500, 500, 500, 200, 200, 200, 500, 500, 500, 500, 200, 200]) { script[U] = { status }; await check(id, t); t += 30000; }
    assert.equal(lines().filter(l => /起连着/.test(l)).length, 2);
    assert.equal(lines().filter(l => /恢复/.test(l)).length, 2);
    assert.equal(lines().length, 4);
  });
  test("reminder at most every 6 hours while it stays down", async () => {
    const id = addRow();
    script[U] = { status: 500 };
    for (let i = 0; i < 3; i++) await check(id, T0 + i * 30000);
    for (let h = 1; h <= 5; h++) await check(id, T0 + 60000 + h * H);          // inside 6 h of the DOWN notice
    assert.equal(lines().length, 1);
    await check(id, T0 + 60000 + 6 * H + 1000);
    assert.equal(lines().length, 2);
    assert.match(lines()[1], /还是打不开/);
    assert.match(lines()[1], /6 小时/);
    await check(id, T0 + 60000 + 7 * H);
    assert.equal(lines().length, 2);
    await check(id, T0 + 60000 + 12 * H + 5000);
    assert.equal(lines().length, 3);
  });
});

describe("slow responses", () => {
  const seed = (id, n, ms) => { for (let i = 0; i < n; i++) hub.db.prepare("INSERT INTO uptimelog(target,ts,ok,status,ms) VALUES(?,?,1,200,?)").run(id, T0 - (i + 1) * H, ms); };
  test("3 slow checks in a row give one notice, then at most one per day", async () => {
    LIMITS.slowFloorMs = 0;
    const id = addRow();
    seed(id, 20, 2);
    script[U] = { delay: 40 };                         // far above 5 x 2 ms
    await check(id, T0); await check(id, T0 + MIN);
    assert.equal(lines().length, 0);
    await check(id, T0 + 2 * MIN);
    assert.equal(lines().length, 1);
    assert.match(lines()[0], /变慢/);
    await check(id, T0 + 3 * MIN); await check(id, T0 + 4 * MIN);
    assert.equal(lines().length, 1);
    await check(id, T0 + D + 3 * H);                    // next day
    assert.equal(lines().length, 2);
  });
  test("a fast check in between resets the run; too few samples never alarm", async () => {
    LIMITS.slowFloorMs = 0;
    const id = addRow();
    seed(id, 20, 30);
    script[U] = [{ delay: 400 }, { delay: 400 }, {}, { delay: 400 }, { delay: 400 }];
    for (let i = 0; i < 5; i++) await check(id, T0 + i * MIN);
    assert.equal(lines().length, 0);
    const id2 = addRow({ url: "https://other.test/" });
    seed(id2, 3, 2);
    script["https://other.test/"] = { delay: 30 };
    for (let i = 0; i < 4; i++) await check(id2, T0 + i * MIN);
    assert.equal(lines().length, 0);
  });
});

describe("the clock", () => {
  test("at most 5 due targets per tick, started together, and not picked again while running", async () => {
    for (let i = 0; i < 8; i++) { const id = addRow({ url: `https://s${i}.test/` }); script[`https://s${i}.test/`] = { delay: 60 }; assert.ok(id); }
    feature.tick(hub, T0 + 1000);
    assert.equal(pending.length, 5);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(active, 5);
    feature.tick(hub, T0 + 2000);                        // the five are in flight and claimed: the other three go now
    assert.equal(pending.length, 8);
    await settle();
    assert.equal(maxActive, 8);
    assert.equal(calls.length, 8);
    feature.tick(hub, T0 + 3000);
    assert.equal(pending.length, 0);                    // none due again: next = +5 min
  });
  test("targets not due are left alone; inactive ones too", async () => {
    addRow({ next: T0 + 10 * MIN });
    const off = addRow({ url: "https://off.test/" });
    hub.db.prepare("UPDATE uptime SET active=0 WHERE id=?").run(off);
    feature.tick(hub, T0);
    assert.equal(pending.length, 0);
  });
  test("a probe that throws inside the tick does not break it", async () => {
    addRow();
    hub.say = async () => { throw new Error("qq down"); };
    script[U] = { status: 500 };
    feature.tick(hub, T0);
    await settle();
    assert.equal(calls.length, 1);
  });
});

describe("tool", () => {
  test("add checks immediately and reports status and latency; defaults and interval bounds", async () => {
    const r = await run({ op: "add", url: U, name: "官网" });
    assert.equal(r.ok, true);
    assert.equal(r.reachable, true);
    assert.equal(r.http_status, 200);
    assert.equal(typeof r.latency_ms, "number");
    assert.equal(calls.length, 1);
    const w = row(r.id);
    assert.equal(w.every_min, 5);
    assert.equal(w.state, "up");
    assert.equal(w.timeout_ms, 10000);
    assert.equal(w.method, "GET");
    assert.equal(w.by, "小明");
    assert.equal(row((await run({ op: "add", url: "https://a.test/", every: 1 })).id).every_min, 2);
    assert.equal(row((await run({ op: "add", url: "https://b.test/", every: 99999 })).id).every_min, 1440);
    assert.equal(row((await run({ op: "add", url: "https://c.test/", every: 15 })).id).every_min, 15);
    assert.equal(row((await run({ op: "add", url: "https://d.test/", method: "head" })).id).method, "HEAD");
  });
  test("add on a failing site reports it without announcing DOWN", async () => {
    script[U] = { status: 500 };
    const r = await run({ op: "add", url: U });
    assert.equal(r.ok, true);
    assert.equal(r.reachable, false);
    assert.match(r.error, /500/);
    assert.deepEqual(lines(), []);
  });
  test("rejects bad urls and duplicates", async () => {
    assert.equal((await run({ op: "add", url: "ftp://x" })).ok, false);
    assert.equal((await run({ op: "add", url: "not a url" })).ok, false);
    await run({ op: "add", url: U });
    assert.equal((await run({ op: "add", url: U })).ok, false);
  });
  test("at most 20 per conversation, counted per conversation", async () => {
    for (let i = 0; i < LIMITS.perConv; i++) assert.equal((await run({ op: "add", url: `https://n${i}.test/` })).ok, true);
    const r = await run({ op: "add", url: "https://extra.test/" });
    assert.equal(r.ok, false);
    assert.match(r.error, /20/);
    assert.equal((await run({ op: "add", url: "https://extra.test/" }, "t:other")).ok, true);
  });
  test("list shows state, last latency and uptime percentages; remove and check are per conversation", async () => {
    const a = (await run({ op: "add", url: U })).id;
    const l = await run({ op: "list" });
    assert.equal(l.count, 1);
    assert.equal(l.targets[0].state, "正常");
    assert.equal(l.targets[0].uptime_24h, "100%");
    assert.equal((await run({ op: "list" }, "t:other")).count, 0);
    assert.equal((await run({ op: "remove", id: a }, "t:other")).ok, false);
    assert.equal((await run({ op: "check", id: a }, "t:other")).ok, false);
    assert.equal((await run({ op: "remove", id: a })).ok, true);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM uptimelog").get().n, 0);
    assert.equal((await run({ op: "list" })).count, 0);
  });
  test("check without id runs all targets of the conversation", async () => {
    await run({ op: "add", url: "https://a.test/" }); await run({ op: "add", url: "https://b.test/" }); await run({ op: "add", url: "https://c.test/" }, "t:other");
    calls.length = 0;
    const r = await run({ op: "check" });
    assert.equal(r.results.length, 2);
    assert.equal(calls.length, 2);
  });
  test("history lists incidents with durations and the first error", async () => {
    const id = addRow();
    let t = T0;
    for (const status of [503, 500, 500, 200, 200]) { script[U] = { status }; await check(id, t); t += 10 * MIN; }
    const h = await run({ op: "history", id });
    assert.equal(h.incidents.length, 1);
    assert.match(h.incidents[0].first_error, /503/);
    assert.match(h.incidents[0].lasted, /40 分钟/);
  });
});

describe("percentages and retention", () => {
  test("uptime percentage is time-weighted over the window and includes an open incident", async () => {
    const id = addRow({ created: T0 - 10 * D });
    const t = row(id);
    hub.db.prepare("INSERT INTO uptimeinc(target,start,end,error) VALUES(?,?,?,?)").run(id, T0 - 3 * H, T0 - 2 * H, "x");
    hub.db.prepare("INSERT INTO uptimeinc(target,start,end,error) VALUES(?,?,NULL,?)").run(id, T0 - 1 * H, "y");
    assert.equal(uptimePct(hub, t, T0, D), Math.round((1 - 2 / 24) * 10000) / 100);
    assert.equal(uptimePct(hub, t, T0, 7 * D), Math.round((1 - 2 / 168) * 10000) / 100);
    const fresh = addRow({ url: "https://new.test/", created: T0 - H });
    assert.equal(uptimePct(hub, row(fresh), T0, D), 100);
  });
  test("an incident older than the window does not count", () => {
    const id = addRow({ created: T0 - 30 * D });
    hub.db.prepare("INSERT INTO uptimeinc(target,start,end,error) VALUES(?,?,?,?)").run(id, T0 - 3 * D, T0 - 3 * D + H, "x");
    assert.equal(uptimePct(hub, row(id), T0, D), 100);
    assert.ok(uptimePct(hub, row(id), T0, 7 * D) < 100);
  });
  test("prune keeps 7 days of checks and 90 days of incidents", () => {
    const id = addRow();
    const ins = hub.db.prepare("INSERT INTO uptimelog(target,ts,ok,status,ms) VALUES(?,?,1,200,5)");
    ins.run(id, T0 - 8 * D); ins.run(id, T0 - 6 * D); ins.run(id, T0 - 1 * H);
    const inc = hub.db.prepare("INSERT INTO uptimeinc(target,start,end,error) VALUES(?,?,?,?)");
    inc.run(id, T0 - 95 * D, T0 - 94 * D, "old"); inc.run(id, T0 - 80 * D, T0 - 79 * D, "recent"); inc.run(id, T0 - 100 * D, null, "still open");
    prune(hub, T0);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM uptimelog").get().n, 2);
    assert.deepEqual(hub.db.prepare("SELECT error FROM uptimeinc ORDER BY id").all().map(r => r.error), ["recent", "still open"]);
  });
  test("tick prunes at most once an hour", () => {
    const id = addRow({ next: T0 + D });
    hub.db.prepare("INSERT INTO uptimelog(target,ts,ok,status,ms) VALUES(?,?,1,200,5)").run(id, T0 - 8 * D);
    feature.tick(hub, T0);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM uptimelog").get().n, 0);
    hub.db.prepare("INSERT INTO uptimelog(target,ts,ok,status,ms) VALUES(?,?,1,200,5)").run(id, T0 - 8 * D);
    feature.tick(hub, T0 + 10 * MIN);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM uptimelog").get().n, 1);
  });
});

describe("admin and text", () => {
  test("GET lists targets, POST forces a check through the state machine", async () => {
    const id = addRow({ name: "官网" });
    script[U] = { status: 500 };
    const post = async () => (await feature.admin(hub, new Request("http://x/admin/uptime", { method: "POST" }), new URL("http://x/admin/uptime"), { check: id })).json();
    await post(); await post();
    assert.equal(lines().length, 0);
    const r = await post();
    assert.equal(r.state, "已判定打不开");
    assert.equal(lines().length, 1);
    const g = await (await feature.admin(hub, new Request("http://x/admin/uptime"), new URL("http://x/admin/uptime"), null)).json();
    assert.equal(g.targets[0].state, "down");
    assert.equal(g.open_incidents.length, 1);
    assert.equal(await feature.admin(hub, new Request("http://x/admin/other"), new URL("http://x/admin/other"), null), null);
  });
  test("span and about", () => {
    assert.equal(span(90 * MIN), "1 小时 30 分钟");
    assert.equal(span(26 * H), "1 天 2 小时");
    assert.ok(feature.about.some(l => /证书/.test(l)));
  });
});
