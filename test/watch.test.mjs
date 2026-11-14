// Offline tests for the page-watch feature: real SQLite (node:sqlite), fake read_url, fake model, fake clock.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { deps, normalise, diffLines, parseVerdict, checkWatch, LIMITS } from "../src/feat/watch.ts";

const REL = "Releases\nv1.4.2 Latest\nFixed a crash when starting the tool on Windows and macOS machines\n";
let hub, pages, said, modelCalls, modelReply, readCalls, pending;

function makeHub(cfg = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  const kv = new Map();
  const h = {
    sql: { exec: (q, ...b) => { const r = db.prepare(q).all(...b); return { toArray: () => r }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)),
    edit: { cfg: (c, k) => (k in cfg ? cfg[k] : feature.tunables[k].default) },
    plan: { fits: () => true },
    ctx: { waitUntil: p => void pending.push(p) },
    say: async (conv, text) => void said.push({ conv, text }),
    tools: () => [{ name: "read_url", run: async ({ url }) => { readCalls.push(url); const p = pages[url]; if (p instanceof Error) throw p; return { title: "t", content: p }; } }],
    db,
  };
  h.set("main", "g:main");
  return h;
}
const tool = (conv = "t:a") => feature.tools({ hub, conv, askers: [{ name: "小明" }], host: {} })[0];
const run = (a, conv) => tool(conv).run(a);
const row = id => hub.db.prepare("SELECT * FROM watch WHERE id=?").get(id);
const settle = async () => { while (pending.length) await pending.shift(); };
const URL1 = "https://github.com/o/r/releases";

beforeEach(() => {
  pages = { [URL1]: REL }; said = []; modelCalls = []; readCalls = []; pending = [];
  modelReply = JSON.stringify({ changed: true, state: "最新版本 v1.5.0", say: "出了 v1.5.0。" });
  deps.model = async (_h, system, user) => { modelCalls.push({ system, user }); return typeof modelReply === "function" ? modelReply(system, user) : modelReply; };
  hub = makeHub();
});

const add = (extra = {}) => run({ op: "add", url: URL1, what: "有没有新版本", ...extra });
const setBaseline = async () => { modelReply = "最新版本 v1.4.2"; const r = await add(); modelCalls.length = 0; readCalls.length = 0; return r; };

describe("add / list / remove", () => {
  test("add reads once and stores a baseline", async () => {
    modelReply = "最新版本 v1.4.2\n多余的第二行";
    const r = await add();
    assert.equal(r.ok, true);
    assert.equal(r.baseline, "最新版本 v1.4.2");
    assert.equal(readCalls.length, 1);
    const w = row(r.id);
    assert.equal(w.state, "最新版本 v1.4.2");
    assert.equal(w.snapshot, normalise(REL));
    assert.equal(w.every_min, 180);
    assert.equal(w.active, 1);
    assert.equal(w.by, "小明");
  });
  test("interval bounds", async () => {
    modelReply = "x";
    assert.equal(row((await add({ every: 5 })).id).every_min, 30);
    assert.equal(row((await add({ every: 99999 })).id).every_min, 10080);
    assert.equal(row((await add({ every: 90 })).id).every_min, 90);
    hub = makeHub({ watch_min_interval: 120 });
    assert.equal(row((await add({ every: 60 })).id).every_min, 120);
  });
  test("rejects bad input and unreadable pages without storing", async () => {
    assert.equal((await run({ op: "add", url: "ftp://x", what: "a" })).ok, false);
    assert.equal((await run({ op: "add", url: URL1, what: " " })).ok, false);
    pages[URL1] = new Error("nope");
    assert.equal((await add()).ok, false);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM watch").get().n, 0);
  });
  test("list and remove are per conversation", async () => {
    modelReply = "v1";
    const r = await add();
    const l = await run({ op: "list" });
    assert.equal(l.count, 1);
    assert.equal(l.watches[0].id, r.id);
    assert.equal(l.watches[0].state, "v1");
    assert.equal((await run({ op: "list" }, "t:other")).count, 0);
    assert.equal((await run({ op: "remove", id: r.id }, "t:other")).ok, false);
    assert.equal((await run({ op: "remove", id: r.id })).ok, true);
    assert.equal((await run({ op: "list" })).count, 0);
  });
  test("at most 15 active watches per conversation", async () => {
    modelReply = "v";
    for (let i = 0; i < LIMITS.perConv; i++) assert.equal((await add()).ok, true);
    assert.equal((await add()).ok, false);
    assert.equal((await run({ op: "add", url: URL1, what: "x" }, "t:b")).ok, true);
  });
});

describe("checking", () => {
  test("unchanged page: no model call, no message", async () => {
    const { id } = await setBaseline();
    const r = await run({ op: "check", id });
    assert.equal(r.ok, true);
    assert.equal(r.changed, false);
    assert.equal(modelCalls.length, 0);
    assert.equal(said.length, 0);
    assert.ok(row(id).last > 0);
  });
  test("changed but not relevant: no message, snapshot updated", async () => {
    const { id } = await setBaseline();
    pages[URL1] = REL + "Sponsored: buy our stuff, now with a longer line\n";
    modelReply = JSON.stringify({ changed: false, state: "最新版本 v1.4.2", say: "" });
    const r = await run({ op: "check", id });
    assert.equal(r.changed, false);
    assert.equal(modelCalls.length, 1);
    assert.match(modelCalls[0].user, /Sponsored/);
    assert.match(modelCalls[0].user, /有没有新版本/);
    assert.equal(said.length, 0);
    assert.match(row(id).snapshot, /Sponsored/);
    assert.equal(row(id).hits, 0);
  });
  test("relevant change: one message with the link, hits incremented", async () => {
    const { id } = await setBaseline();
    pages[URL1] = REL.replace("v1.4.2", "v1.5.0");
    modelReply = JSON.stringify({ changed: true, state: "最新版本 v1.5.0", say: "出了 v1.5.0。" });
    const r = await run({ op: "check", id });
    assert.equal(r.changed, true);
    assert.equal(said.length, 1);
    assert.equal(said[0].conv, "t:a");
    assert.match(said[0].text, /v1\.5\.0/);
    assert.ok(said[0].text.includes(URL1));
    const w = row(id);
    assert.equal(w.hits, 1);
    assert.equal(w.state, "最新版本 v1.5.0");
    assert.equal(w.snapshot, normalise(pages[URL1]));
    assert.match(modelCalls[0].user, /最新版本 v1\.4\.2/);
    // the same page again is not announced twice
    await run({ op: "check", id });
    assert.equal(said.length, 1);
  });
  test("malformed model output is no change and no crash", async () => {
    const { id } = await setBaseline();
    pages[URL1] = REL.replace("v1.4.2", "v1.5.0");
    for (const bad of ["好的，我觉得变了", "{changed: yes}", '{"changed":"true","say":"x"}', "{", ""]) {
      modelReply = bad;
      const r = await run({ op: "check", id });
      assert.equal(r.ok, true);
      assert.equal(r.changed, false);
    }
    deps.model = async () => { throw new Error("model down"); };
    assert.equal((await run({ op: "check", id })).changed, false);
    assert.equal(said.length, 0);
    assert.equal(row(id).hits, 0);
    assert.match(row(id).snapshot, /v1\.4\.2/, "old snapshot kept so the next check looks again");
  });
  test("three failed reads pause the watch and announce once", async () => {
    const { id } = await setBaseline();
    pages[URL1] = new Error("down");
    for (let i = 0; i < 2; i++) { assert.equal((await run({ op: "check", id })).ok, false); assert.equal(said.length, 0); }
    const r = await run({ op: "check", id });
    assert.equal(r.paused, true);
    assert.equal(said.length, 1);
    assert.ok(said[0].text.includes(URL1));
    assert.equal(row(id).active, 0);
    feature.tick(hub, Date.now() + 1e9); await settle();
    assert.equal(said.length, 1, "a paused watch is not checked or announced again");
  });
  test("a good read resets the failure count", async () => {
    const { id } = await setBaseline();
    pages[URL1] = new Error("down");
    await run({ op: "check", id }); await run({ op: "check", id });
    pages[URL1] = REL;
    await run({ op: "check", id });
    assert.equal(row(id).fails, 0);
  });
});

describe("normalise", () => {
  test("volatile lines are dropped, whitespace collapsed", () => {
    const t = normalise("  v1.4.2   released \n\n3 分钟前\n阅读 1.2万\n12,345 views\nUpdated 5 minutes ago\n<input name=csrf_token value=abc>\nAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n价格\t199 元");
    assert.equal(t, "v1.4.2 released\n价格 199 元");
  });
  test("only volatile lines moving does not count as a change", async () => {
    const { id } = await setBaseline();
    pages[URL1] = REL + "刚刚更新\n浏览 9999\n";
    assert.equal((await run({ op: "check", id })).changed, false);
    assert.equal(modelCalls.length, 0);
  });
  test("diffLines and parseVerdict", () => {
    assert.deepEqual(diffLines("a\nb\nc", "a\nc\nd"), { added: ["d"], removed: ["b"] });
    assert.deepEqual(parseVerdict('结果：{"changed":true,"state":" s ","say":"嗯"} 完毕'), { changed: true, state: "s", say: "嗯" });
    assert.equal(parseVerdict('{"changed":1}'), null);
  });
  test("snapshot is clipped to 20,000 characters", () => {
    assert.ok(normalise(("长长的一行内容\n").repeat(5000)).length <= LIMITS.snapshot);
  });
});

describe("tick", () => {
  const seed = async n => { modelReply = "v"; const ids = []; for (let i = 0; i < n; i++) ids.push((await add()).id); modelCalls.length = 0; readCalls.length = 0; return ids; };
  const due = () => hub.db.prepare("UPDATE watch SET next=1").run();

  test("takes at most two due watches per tick, and not again while they run", async () => {
    await seed(5); due();
    let release; const gate = new Promise(r => (release = r));
    hub.tools = () => [{ name: "read_url", run: async ({ url }) => { readCalls.push(url); await gate; return { content: REL }; } }];
    const now = Date.now();
    feature.tick(hub, now);
    assert.equal(pending.length, 2);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM watch WHERE next<=?").get(now).n, 3, "the two claimed ones are no longer due");
    feature.tick(hub, now + 20000);
    assert.equal(pending.length, 4, "second tick takes two other watches");
    feature.tick(hub, now + 40000);
    assert.equal(pending.length, 5);
    release(); await settle();
    assert.equal(readCalls.length, 5, "each watch was read exactly once");
    for (const w of hub.db.prepare("SELECT * FROM watch").all()) assert.ok(w.next > now + 179 * 60000 && w.next < now + 200 * 60000, "rescheduled by about the interval");
  });
  test("a due watch is not started twice while its check is slow", async () => {
    const [id] = await seed(1); due();
    let release; const gate = new Promise(r => (release = r)); let reads = 0;
    hub.tools = () => [{ name: "read_url", run: async () => { reads++; await gate; return { content: REL }; } }];
    feature.tick(hub, Date.now()); feature.tick(hub, Date.now() + 20000); feature.tick(hub, Date.now() + 60000);
    assert.equal(pending.length, 1);
    release(); await settle();
    assert.equal(reads, 1);
    assert.ok(row(id).next > Date.now());
  });
  test("tick announces a relevant change", async () => {
    const [id] = await seed(1); due();
    pages[URL1] = REL.replace("v1.4.2", "v1.5.0");
    modelReply = JSON.stringify({ changed: true, state: "最新版本 v1.5.0", say: "出了 v1.5.0。" });
    feature.tick(hub, Date.now()); await settle();
    assert.equal(said.length, 1);
    assert.equal(row(id).hits, 1);
  });
  test("daily cap stops checks across all watches", async () => {
    hub = makeHub({ watch_daily: 3 });
    modelReply = "v"; // the add itself counts as one read
    await add(); await add();
    assert.equal(hub.get("watch:checks:" + new Date().toISOString().slice(0, 10)), "2");
    due(); readCalls.length = 0;
    feature.tick(hub, Date.now()); await settle();
    assert.equal(readCalls.length, 1, "only one check was left in today's allowance");
    feature.tick(hub, Date.now()); await settle();
    assert.equal(readCalls.length, 1);
    assert.equal((await add()).ok, false);
    assert.equal((await run({ op: "check", id: 1 })).ok, false);
  });
  test("browser watches have their own daily limit and honour the plan", async () => {
    const browsed = []; deps.browse = async (_h, url) => { browsed.push(url); return { content: REL }; };
    modelReply = "v";
    for (let i = 0; i < LIMITS.browserDaily; i++) assert.equal((await run({ op: "add", url: URL1, what: "x", use_browser: true }, "t:c" + i)).ok, true);
    assert.equal((await run({ op: "add", url: URL1, what: "x", use_browser: true }, "t:z")).ok, false);
    assert.equal(browsed.length, LIMITS.browserDaily);
    hub = makeHub(); hub.plan.fits = () => false;
    assert.equal((await add({ use_browser: true })).ok, false);
    assert.equal((await add()).ok, true, "plain reads do not need the browser allowance");
  });
});

describe("admin", () => {
  test("GET lists everything with today's counts, POST forces a check", async () => {
    modelReply = "v";
    const { id } = await add();
    const get = await feature.admin(hub, { method: "GET" }, new URL("http://x/admin/watch"), {});
    const j = await get.json();
    assert.equal(j.watches.length, 1);
    assert.equal(j.today.checks, 1);
    assert.equal(j.today.cap, 200);
    pages[URL1] = REL.replace("v1.4.2", "v1.5.0");
    modelReply = JSON.stringify({ changed: true, state: "s", say: "变了。" });
    const post = await feature.admin(hub, { method: "POST" }, new URL("http://x/admin/watch"), { check: id });
    assert.equal((await post.json()).changed, true);
    assert.equal(said.length, 1);
    assert.equal(await feature.admin(hub, { method: "GET" }, new URL("http://x/admin/other"), {}), null);
  });
});
