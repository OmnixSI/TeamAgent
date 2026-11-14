// Offline tests for finding pictures: real SQLite (node:sqlite) behind a fake hub, fake index and search, fake picture loader.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const fi = await import("../src/feat/findimage.ts");
const search = (await import("../src/feat/search.ts")).default;
const feature = fi.default;
const DAY = 86400000, MIN = 60000;
const NOW = Date.parse("2026-11-15T04:00:00Z");

let indexCalls, indexResult, perCall;
function makeHub() {
  const db = new DatabaseSync(":memory:");
  const hub = {
    env: { AI: {} },
    sql: { exec(q, ...b) { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },
    get: k => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? r.v : null; },
    set: (k, v) => { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); },
    shadow: c => (c.startsWith("t:") ? hub.get("main") || "" : ""),
    ctx: { waitUntil: p => { hub.pending.push(p); } },
    pending: [],
    neurons: 0,
    plan: { used: () => hub.neurons, left: () => 8000 - hub.neurons },
    db,
  };
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT NOT NULL, role TEXT NOT NULL, sender TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, mentioned INTEGER DEFAULT 0, meta TEXT)");
  db.exec("CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT, r2 TEXT, size INTEGER, src TEXT, made TEXT)");
  db.exec(search.schema);
  return hub;
}

let hub, n = 0;
const MAIN = "g:main";
const msg = (conv, text, { name = "小明", role = "user", ts = NOW - DAY, caption, images } = {}) => {
  const meta = images ?? (caption !== undefined ? [{ url: "u", caption }] : null);
  return Number(hub.db.prepare("INSERT INTO msg(id,conv,role,sender,name,text,ts,meta) VALUES(?,?,?,?,?,?,?,?) RETURNING seq")
    .get("m" + ++n, conv, role, "q1", role === "bot" ? null : name, text, ts, meta ? JSON.stringify({ images: meta }) : null).seq);
};
const chatPic = (conv, text, o = {}) => {
  const seq = msg(conv, text, o);
  const id = Number(hub.db.prepare("INSERT INTO img(conv,ts,mime,note,src) VALUES(?,?,?,?,?) RETURNING id").get(conv, o.ts ?? NOW - DAY, "image/png", "群友发的图", "chat:" + seq + "-0").id);
  return { seq, id, ref: seq + "-0" };
};
const mine = (conv, note, { made, name, ts = NOW - DAY } = {}) =>
  "g" + Number(hub.db.prepare("INSERT INTO img(conv,ts,mime,note,name,made) VALUES(?,?,?,?,?,?) RETURNING id").get(conv, ts, "image/jpeg", note, name || null, made ? JSON.stringify(made) : null).id);
const passages = () => hub.db.prepare("SELECT conv, ref, text FROM passage WHERE kind='image' ORDER BY id").all();

beforeEach(() => {
  hub = makeHub(); n = 0; indexCalls = []; indexResult = 1; perCall = 1;
  fi.setSearch({
    index: async (h, conv, kind, ref, title, text) => {
      indexCalls.push({ conv, kind, ref, title, text });
      if (indexResult === null) return null;
      h.neurons += perCall;
      h.db.prepare("DELETE FROM passage WHERE conv=? AND kind=? AND ref=?").run(conv, kind, ref);
      h.db.prepare("INSERT INTO passage(conv,kind,ref,title,ts,end_ts,text) VALUES(?,?,?,?,?,?,?)").run(conv, kind, ref, title, NOW, NOW, text);
      return 1;
    },
    // Fake meaning search: every indexed picture whose text shares a character with the query, scored by overlap.
    search: async (h, conv, query, kind) => {
      if (hub.noSearch) return null;
      const rows = h.db.prepare("SELECT conv, kind, ref, title, text FROM passage WHERE conv=? AND kind=?").all(conv, kind);
      return rows.map(r => ({ ...r, score: [...new Set(query)].filter(ch => r.text.includes(ch)).length / 10 })).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
    },
  });
});

describe("text for the index", () => {
  test("chat picture: caption, who, when, its message and the one before", () => {
    msg(MAIN, "报价怎么样", { name: "老王", ts: NOW - DAY - MIN });
    const p = chatPic(MAIN, "这是昨天的 [图片 5-0] 报价单", { name: "小明", caption: "一张手机上的报价截图，总价 3800 元" });
    const d = fi.describe(hub, hub.db.prepare("SELECT * FROM img WHERE id=?").get(p.id), NOW);
    assert.equal(d.ref, p.ref);
    assert.equal(d.kind, "chat");
    assert.equal(d.who, "小明");
    assert.match(d.text, /^一张手机上的报价截图，总价 3800 元\n小明 2026-11-14 .*发的/);
    assert.match(d.text, /这条消息：这是昨天的 报价单/);
    assert.match(d.text, /上一条（老王）：报价怎么样/);
    assert.doesNotMatch(d.text, /\[图片/);
  });
  test("a long neighbouring message is clipped", () => {
    msg(MAIN, "字".repeat(500));
    const p = chatPic(MAIN, "", { caption: "一只猫" });
    const d = fi.describe(hub, hub.db.prepare("SELECT * FROM img WHERE id=?").get(p.id), NOW);
    assert.ok(d.text.length <= 560);
    assert.match(d.text, /字…/);
  });
  test("a picture the bot made: note plus request and idea", () => {
    const ref = mine(MAIN, "奶蛙在敲代码", { made: { request: "画一下奶蛙敲代码", idea: "蛙坐在显示器前", prompt: "a frog typing" } });
    const d = fi.describe(hub, hub.db.prepare("SELECT * FROM img WHERE id=?").get(Number(ref.slice(1))), NOW);
    assert.equal(d.ref, ref);
    assert.equal(d.kind, "mine");
    assert.equal(d.text, "奶蛙在敲代码\n要求：画一下奶蛙敲代码\n想法：蛙坐在显示器前");
    assert.doesNotMatch(d.text, /a frog/);
  });
  test("a named picture: the name; stickers lose their prefix; a nameless noteless row is nothing", () => {
    const a = mine(MAIN, "", { name: "奶蛙" }), b = mine(MAIN, "开心", { name: "sticker:大笑" }), c = mine(MAIN, "");
    const get = r => fi.describe(hub, hub.db.prepare("SELECT * FROM img WHERE id=?").get(Number(r.slice(1))), NOW);
    assert.equal(get(a).text, "奶蛙");
    assert.equal(get(b).text, "表情包 大笑\n开心");
    assert.equal(get(c), null);
  });
  test("a fresh chat picture with no caption yet waits; an old one is skipped", () => {
    const fresh = chatPic(MAIN, "看", { ts: NOW - MIN, images: [{ url: "u" }] });
    const old = chatPic(MAIN, "看", { ts: NOW - DAY, images: [{ url: "u" }] });
    const row = id => hub.db.prepare("SELECT * FROM img WHERE id=?").get(id);
    assert.equal(fi.describe(hub, row(fresh.id), NOW), "wait");
    assert.equal(fi.describe(hub, row(old.id), NOW), null);
  });
});

describe("indexing run", () => {
  test("cursor: existing pictures are backfilled, new ones go first, nothing is done twice", async () => {
    for (let i = 0; i < 5; i++) chatPic(MAIN, "旧图" + i, { caption: "旧的图" + i });
    let r = await fi.step(hub, NOW);                       // first run: all 5 are "old"; 2 per tick from the back
    assert.equal(r.indexed, 2);
    assert.equal(hub.get("findimage:fwd:" + MAIN), "5");
    assert.equal(hub.get("findimage:back:" + MAIN), "3");
    const fresh = chatPic(MAIN, "新图", { caption: "新的图" });
    r = await fi.step(hub, NOW);                           // the new one first (forward), then 2 more old ones
    assert.equal(r.indexed, 3);
    assert.equal(indexCalls[2].ref, fresh.ref);
    assert.equal(hub.get("findimage:fwd:" + MAIN), String(fresh.id));
    r = await fi.step(hub, NOW);                           // one old picture left
    assert.equal(r.indexed, 1);
    r = await fi.step(hub, NOW);
    assert.equal(r.indexed, 0);
    assert.equal(new Set(indexCalls.map(c => c.ref)).size, 6);
    assert.equal(hub.get("findimage:back:" + MAIN), "0");
  });
  test("pictures with neither caption nor note are passed over without a call", async () => {
    mine(MAIN, "");
    chatPic(MAIN, "x", { ts: NOW - DAY, images: [{ url: "u" }] });
    mine(MAIN, "有说明的图");
    const r = await fi.step(hub, NOW, { back: 10 });
    assert.equal(r.indexed, 1);
    assert.equal(r.skipped, 2);
  });
  test("a fresh uncaptioned picture holds the forward cursor", async () => {
    await fi.step(hub, NOW, { convs: [MAIN] });           // initialise cursors on an empty store
    const p = chatPic(MAIN, "刚发", { ts: NOW - MIN, images: [{ url: "u" }] });
    chatPic(MAIN, "后发", { ts: NOW - MIN, caption: "后面的图" });
    let r = await fi.step(hub, NOW, { convs: [MAIN] });
    assert.equal(r.indexed, 0);
    hub.db.prepare("UPDATE msg SET meta=? WHERE seq=?").run(JSON.stringify({ images: [{ url: "u", caption: "刚发的图" }] }), p.seq);
    r = await fi.step(hub, NOW, { convs: [MAIN] });
    assert.equal(r.indexed, 2);
  });
  test("daily budget of 500 neurons: stops for the day, resumes the next UTC day", async () => {
    await fi.step(hub, NOW, { convs: [MAIN] });
    perCall = 100;
    for (let i = 0; i < 8; i++) chatPic(MAIN, "图" + i, { caption: "图的描述" + i });
    let total = 0;
    for (let i = 0; i < 6; i++) { const r = await fi.step(hub, NOW, { fwd: 3, convs: [MAIN] }); total += r.indexed; if (r.stopped) assert.equal(r.stopped, "额度"); }
    assert.equal(total, 5);
    assert.equal(Number(hub.get("findimage:day:2026-11-15")), 500);
    const r = await fi.step(hub, NOW + DAY, { fwd: 3, convs: [MAIN] });
    assert.equal(r.indexed, 3);
  });
  test("stops when the whole day's allowance is nearly gone", async () => {
    chatPic(MAIN, "图", { caption: "有描述" });
    hub.neurons = 8000 - 10;
    const r = await fi.step(hub, NOW, { back: 5 });
    assert.equal(r.indexed, 0);
    assert.equal(r.stopped, "额度");
    assert.equal(indexCalls.length, 0);
  });
  test("null from the index stops the run and leaves the cursor on that picture", async () => {
    for (let i = 0; i < 4; i++) chatPic(MAIN, "图" + i, { caption: "描述" + i });
    indexResult = null;
    let r = await fi.step(hub, NOW, { back: 4 });
    assert.equal(r.indexed, 0);
    assert.equal(r.stopped, "模型没成功");
    assert.equal(indexCalls.length, 1);
    assert.equal(hub.get("findimage:back:" + MAIN), "4");
    indexResult = 1;
    r = await fi.step(hub, NOW, { back: 4 });
    assert.equal(r.indexed, 4);
  });
  test("test rooms are skipped unless the flag names them", async () => {
    const T = "t:ag-findimg";
    mine(T, "测试房间里的图");
    mine(MAIN, "主群的图");
    await fi.step(hub, NOW, { back: 5 });
    assert.deepEqual(indexCalls.map(c => c.conv), [MAIN]);
    hub.set("findimage:test", "ag-findimg");
    await fi.step(hub, NOW, { back: 5 });
    assert.ok(indexCalls.some(c => c.conv === T));
    hub.set("findimage:test", "other");
    assert.equal(fi.eligible(hub, T), false);
    assert.equal(fi.eligible(hub, "t:other"), true);
  });
  test("tick runs the step in the background once at a time and sweeps once a day", async () => {
    mine(MAIN, "一张图");
    feature.tick(hub, NOW);
    feature.tick(hub, NOW);
    assert.equal(hub.pending.length, 1);
    await Promise.all(hub.pending);
    assert.equal(indexCalls.length, 1);
    assert.equal(hub.get("findimage:sweep"), "2026-11-15");
  });
});

describe("searching", () => {
  async function seeded() {
    const a = chatPic(MAIN, "看这个", { name: "小明", ts: NOW - 2 * DAY, caption: "一只戴墨镜的小黄鸡" });
    const b = chatPic(MAIN, "报价", { name: "老王", ts: NOW - 20 * DAY, caption: "手机上的报价截图" });
    const c = mine(MAIN, "奶蛙在敲代码", { ts: NOW - 5 * DAY, made: { request: "画奶蛙敲代码", idea: "蛙在键盘前" } });
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    return { a, b, c };
  }
  test("meaning search returns reference, when, who, description and score", async () => {
    const { a } = await seeded();
    const r = await fi.find(hub, MAIN, { query: "戴墨镜的小黄鸡" }, NOW);
    assert.equal(r.mode, "意思");
    assert.equal(r.items[0].ref, a.ref);
    assert.equal(r.items[0].who, "小明");
    assert.equal(r.items[0].what, "一只戴墨镜的小黄鸡");
    assert.ok(r.items[0].score > 0);
  });
  test("filters: who, days, only", async () => {
    const { a, b, c } = await seeded();
    const q = "报价截图戴墨镜的小黄鸡奶蛙敲代码";
    const refs = async o => (await fi.find(hub, MAIN, { query: q, ...o }, NOW)).items.map(i => i.ref).sort();
    assert.deepEqual(await refs({}), [a.ref, b.ref, c].sort());
    assert.deepEqual(await refs({ who: "老王" }), [b.ref]);
    assert.deepEqual(await refs({ days: 7 }), [a.ref, c].sort());
    assert.deepEqual(await refs({ only: "mine" }), [c]);
    assert.deepEqual(await refs({ only: "chat" }), [a.ref, b.ref].sort());
  });
  test("expired pictures are dropped from the results and from the index", async () => {
    const { a, b } = await seeded();
    hub.db.prepare("DELETE FROM img WHERE conv=? AND src=?").run(MAIN, "chat:" + b.ref);
    const r = await fi.find(hub, MAIN, { query: "报价截图" }, NOW);
    assert.ok(!r.items.some(i => i.ref === b.ref));
    assert.ok(!passages().some(p => p.ref === b.ref));
    assert.ok(passages().some(p => p.ref === a.ref));
  });
  test("the daily sweep drops pictures that are gone", async () => {
    const { a, c } = await seeded();
    hub.db.prepare("DELETE FROM img WHERE id=?").run(a.id);
    hub.db.prepare("DELETE FROM img WHERE id=?").run(Number(c.slice(1)));
    assert.equal(fi.sweep(hub), 2);
    assert.equal(passages().length, 1);
  });
  test("keyword fallback when the meaning search is unavailable: says so and ranks by matching words", async () => {
    await seeded();
    mine(MAIN, "一只黄色的鸡在海边");
    hub.noSearch = true;
    const r = await fi.find(hub, MAIN, { query: "戴墨镜的小黄鸡" }, NOW);
    assert.equal(r.mode, "关键词");
    assert.match(r.note, /用不了/);
    assert.equal(r.items[0].what, "一只戴墨镜的小黄鸡");
    assert.ok(r.items[0].score > r.items[r.items.length - 1].score || r.items.length === 1);
    const filtered = await fi.find(hub, MAIN, { query: "报价 截图", who: "老王" }, NOW);
    assert.deepEqual(filtered.items.map(i => i.what), ["手机上的报价截图"]);
  });
  test("keyword fallback also covers pictures not indexed yet, and finds nothing for nonsense", async () => {
    mine(MAIN, "奶蛙敲代码", { made: { request: "画奶蛙" } });
    const r = await fi.find(hub, MAIN, { query: "奶蛙 敲代码" }, NOW);
    assert.equal(r.mode, "关键词");
    assert.equal(r.items.length, 1);
    assert.equal((await fi.find(hub, MAIN, { query: "量子纠缠" }, NOW)).items.length, 0);
  });
  test("terms: Chinese runs split at filler words into whole words and pairs", () => {
    const t = fi.terms("戴墨镜的小黄鸡");
    assert.equal(t.get("戴墨镜"), 2);
    assert.equal(t.get("小黄鸡"), 2);
    assert.equal(t.get("墨镜"), 1);
    assert.ok(!t.has("镜小"));
  });
});

describe("tool find_image", () => {
  const pngs = new Map();
  function ctx(extra = {}) {
    const sent = [];
    const host = {
      now: () => NOW,
      imageRef: async ref => pngs.get(ref) || null,
      sendImage: async (bytes, note, mime) => { sent.push({ bytes, note, mime }); return { ok: true, id: "g99" }; },
      ...extra,
    };
    return { ctx: { hub, conv: MAIN, askers: [], host }, sent };
  }
  const tool = c => feature.tools(c).find(t => t.name === "find_image");
  beforeEach(() => pngs.clear());

  test("returns matches and shows at most 4 pictures as data URLs", async () => {
    for (let i = 0; i < 6; i++) { const p = chatPic(MAIN, "图" + i, { caption: "小黄鸡的照片" + i }); pngs.set(p.ref, { bytes: new Uint8Array([1, 2, 3, i]), mime: "image/png" }); }
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    const { ctx: c } = ctx();
    const r = await tool(c).run({ query: "小黄鸡" });
    assert.equal(r.ok, true);
    assert.equal(r.matches.length, 6);
    assert.ok(r.matches.every(m => m.ref && m.when && m.who && m.what && typeof m.score === "number"));
    assert.equal(r._images.length, 4);
    assert.match(r._images[0], /^data:image\/png;base64,/);
    assert.equal(r.sent, undefined);
  });
  test("pictures that cannot be loaded are left out of _images but stay in the list", async () => {
    const a = chatPic(MAIN, "a", { caption: "小黄鸡甲" }), b = chatPic(MAIN, "b", { caption: "小黄鸡乙" });
    pngs.set(b.ref, { bytes: new Uint8Array([9]), mime: "image/jpeg" });
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    const r = await tool(ctx().ctx).run({ query: "小黄鸡" });
    assert.equal(r.matches.length, 2);
    assert.equal(r._images.length, 1);
    assert.ok(a.ref);
  });
  test("send posts the best match to the chat", async () => {
    const a = chatPic(MAIN, "a", { caption: "戴墨镜的小黄鸡" }), b = chatPic(MAIN, "b", { caption: "一只猫" });
    pngs.set(a.ref, { bytes: new Uint8Array([7, 7]), mime: "image/png" });
    pngs.set(b.ref, { bytes: new Uint8Array([8]), mime: "image/png" });
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    const { ctx: c, sent } = ctx();
    const r = await tool(c).run({ query: "戴墨镜的小黄鸡", send: true });
    assert.equal(r.sent, true);
    assert.equal(r.sent_ref, a.ref);
    assert.equal(sent.length, 1);
    assert.deepEqual([...sent[0].bytes], [7, 7]);
    assert.equal(sent[0].note, "戴墨镜的小黄鸡");
  });
  test("without send nothing is posted", async () => {
    const a = chatPic(MAIN, "a", { caption: "戴墨镜的小黄鸡" });
    pngs.set(a.ref, { bytes: new Uint8Array([1]), mime: "image/png" });
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    const { ctx: c, sent } = ctx();
    await tool(c).run({ query: "戴墨镜的小黄鸡" });
    assert.equal(sent.length, 0);
  });
  test("fallback is reported to the model; empty query and no match are plain answers", async () => {
    const a = chatPic(MAIN, "a", { caption: "戴墨镜的小黄鸡" });
    pngs.set(a.ref, { bytes: new Uint8Array([1]), mime: "image/png" });
    hub.noSearch = true;
    const t = tool(ctx().ctx);
    const r = await t.run({ query: "小黄鸡" });
    assert.equal(r.mode, "关键词");
    assert.match(r.note, /用不了/);
    assert.equal(r.matches.length, 1);
    assert.equal((await t.run({ query: " " })).ok, false);
    const none = await t.run({ query: "量子纠缠" });
    assert.equal(none.matches.length, 0);
    assert.match(none.note, /没有找到/);
  });
  test("a test room also sees the main group's pictures, loaded through the store", async () => {
    hub.set("main", MAIN);
    const a = chatPic(MAIN, "a", { caption: "戴墨镜的小黄鸡" });
    await fi.step(hub, NOW, { back: 10, convs: [MAIN] });
    hub.store = { imageRef: async (conv, ref) => (conv === MAIN && ref === a.ref ? { bytes: new Uint8Array([5]), mime: "image/png" } : null) };
    const T = "t:ag-findimg";
    const r = await tool({ hub, conv: T, askers: [], host: { now: () => NOW, imageRef: async () => null, sendImage: async () => ({ ok: true }) } }).run({ query: "小黄鸡" });
    assert.equal(r.matches.length, 1);
    assert.equal(r._images.length, 1);
  });
});

describe("admin route", () => {
  const call = (method, qs, body) => feature.admin(hub, new Request("https://x/admin/findimage" + qs, { method }), new URL("https://x/admin/findimage" + qs), body);
  test("not its path", async () => {
    assert.equal(await feature.admin(hub, new Request("https://x/admin/other"), new URL("https://x/admin/other"), null), null);
  });
  test("POST backfill indexes N old pictures; GET shows matches, index size and today's neurons", async () => {
    hub.set("main", MAIN);
    for (let i = 0; i < 5; i++) chatPic(MAIN, "图", { caption: "戴墨镜的小黄鸡" + i });
    const post = await (await call("POST", "", { backfill: 3, conv: MAIN })).json();
    assert.equal(post.run.indexed, 3);
    assert.equal(post.index.pictures, 3);
    const get = await (await call("GET", "?q=" + encodeURIComponent("小黄鸡") + "&conv=" + encodeURIComponent(MAIN))).json();
    assert.equal(get.mode, "意思");
    assert.equal(get.matches.length, 3);
    assert.ok(get.matches[0].text.includes("小黄鸡"));
    assert.equal(get.index.pictures_in_store, 5);
    assert.equal(get.neurons_today.limit, 500);
    assert.equal(get.neurons_today.findimage, 3);
  });
  test("POST for a test room needs the flag", async () => {
    mine("t:ag-findimg", "测试图");
    const res = await call("POST", "", { backfill: 3, conv: "t:ag-findimg" });
    assert.equal(res.status, 400);
    hub.set("findimage:test", "ag-findimg");
    const ok = await (await call("POST", "", { backfill: 3, conv: "t:ag-findimg" })).json();
    assert.equal(ok.run.indexed, 1);
  });
});
