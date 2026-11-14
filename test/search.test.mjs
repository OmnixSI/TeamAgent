// Offline tests for src/feat/search.ts: passages, the Workers AI gate, the index cap, ranking and recall.
// The Hub's SQLite is played by node:sqlite; Workers AI by a fake that turns characters into a bag-of-characters vector.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const S = await import("../src/feat/search.ts");
const { Plan, DAILY } = await import("../src/budget.ts");
const feature = S.default;

const MIN = 60000, T0 = Date.UTC(2026, 10, 10, 2, 0);

function fakeAI() {
  const ai = { calls: [], fail: false, neurons: null,
    async run(model, input) {
      ai.calls.push({ model, input });
      if (ai.fail) throw new Error("boom");
      if (model === S.WHISPER_MODEL) return { text: " 你好世界 ", usage: { neurons: ai.neurons ?? 3.5 } };
      const data = input.text.map(t => { const v = new Array(1024).fill(0); for (const ch of t) v[ch.codePointAt(0) % 1024] += 1; return v; });
      const tokens = input.text.reduce((n, t) => n + t.length, 0);
      return { shape: [data.length, 1024], data, pooling: "cls", meta: { neurons: ai.neurons ?? tokens * 1075 / 1e6 } };
    } };
  return ai;
}
function makeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT NOT NULL, role TEXT NOT NULL, sender TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, mentioned INTEGER DEFAULT 0, meta TEXT);
    CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);`);
  db.exec(feature.schema);
  const sql = { exec(q, ...binds) {
    const rows = binds.length || !q.trim().includes(";") ? db.prepare(q).all(...binds) : (db.exec(q), []);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const hub = { sql, env: { AI: fakeAI() }, ctx: { waitUntil() {} },
    get(k) { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set(k, v) { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); },
    shadow: c => (c.startsWith("t:") ? "g:main" : ""),
  };
  hub.plan = new Plan(hub);
  let n = 0;
  hub.say = (conv, name, text, ts, role = "user") => Number(db.prepare("INSERT INTO msg(id,conv,role,name,text,ts) VALUES(?,?,?,?,?,?) RETURNING seq").get("m" + n++, conv, role, name, text, ts).seq);
  hub.db = db;
  return hub;
}
const rows = list => list.map(([seq, name, text, ts, role = "user"]) => ({ seq, name, text, ts, role }));

describe("splitPassages", () => {
  test("a pause over 20 minutes starts a new passage; speakers leave the bot out", () => {
    const p = S.splitPassages(rows([[1, "小王", "去海边吗", T0], [2, "小李", "好啊", T0 + MIN], [3, "Bot", "我也想去", T0 + 2 * MIN, "bot"], [4, "小王", "明天再说", T0 + 25 * MIN]]), T0 + 60 * MIN);
    assert.equal(p.length, 2);
    assert.deepEqual([p[0].from_seq, p[0].to_seq, p[1].from_seq], [1, 3, 4]);
    assert.deepEqual(p[0].speakers, ["小王", "小李"]);
    assert.equal(p[0].text, "小王：去海边吗\n小李：好啊\nBot：我也想去");
    assert.ok(p[0].closed && p[1].closed, "the last one is closed once 20 minutes have passed");
  });
  test("a passage closes after ~600 characters; the still-open last one is not closed", () => {
    const list = []; for (let i = 0; i < 13; i++) list.push([i + 1, "老张", "字".repeat(100), T0 + i * MIN]);
    const p = S.splitPassages(rows(list), T0 + 13 * MIN);
    assert.ok(p.length >= 2);
    assert.ok(p.slice(0, -1).every(x => x.closed && x.text.length >= 600 && x.text.length < 800));
    assert.equal(p[p.length - 1].closed, false);
  });
});

describe("Workers AI gate", () => {
  let hub;
  beforeEach(() => { hub = makeHub(); });
  test("refuses at the stop line without calling the model", async () => {
    hub.plan.add("ai_neurons", DAILY.ai_neurons.stop - 0.001);
    assert.equal(await S.aiEmbed(hub, ["一句话"]), null);
    assert.equal(await S.aiTranscribe(hub, new Uint8Array(4000), 10), null);
    assert.equal(hub.env.AI.calls.length, 0);
  });
  test("counts what the model reported, not the estimate", async () => {
    hub.env.AI.neurons = 0.25;
    const v = await S.aiEmbed(hub, ["你好", "世界"]);
    assert.equal(v.length, 2);
    assert.ok(Math.abs(S.dot(v[0], v[0]) - 1) < 1e-5, "unit length");
    assert.equal(hub.plan.used("ai_neurons"), 0.25);
    hub.env.AI.neurons = 7.75;
    assert.equal(await S.aiTranscribe(hub, new Uint8Array(4000), 10, "audio/wav"), "你好世界");
    assert.equal(hub.plan.used("ai_neurons"), 8);
    const call = hub.env.AI.calls[1].input.audio;
    assert.equal(call.contentType, "audio/wav");
  });
  test("fails closed when the binding throws or is missing; a failed call still counts its estimate", async () => {
    hub.env.AI.fail = true;
    assert.equal(await S.aiEmbed(hub, ["你好"]), null);
    assert.equal(await S.aiTranscribe(hub, new Uint8Array(4000), 60), null);
    assert.ok(hub.plan.used("ai_neurons") > 46);
    delete hub.env.AI;
    assert.equal(await S.aiEmbed(hub, ["你好"]), null);
  });
  test("transcription estimate fits or not by audio length; too long for one call is refused", async () => {
    hub.plan.add("ai_neurons", DAILY.ai_neurons.stop - 40);
    assert.equal(await S.aiTranscribe(hub, new Uint8Array(4000), 60), null, "a minute needs ~49 with margin");
    assert.equal(await S.aiTranscribe(hub, new Uint8Array(4000), 30), "你好世界");
    assert.equal(await S.aiTranscribe(makeHub(), new Uint8Array(4000), 21 * 60), null);
  });
  test("parallel calls reserve their estimates so together they stay under the stop line", async () => {
    hub.plan.add("ai_neurons", DAILY.ai_neurons.stop - 120);
    const got = await Promise.all([1, 2, 3].map(() => S.aiTranscribe(hub, new Uint8Array(4000), 60)));
    assert.equal(got.filter(x => x !== null).length, 2);
  });
  test("long lists go in batches of 100", async () => {
    const v = await S.aiEmbed(hub, Array.from({ length: 230 }, (_, i) => "第" + i + "条"));
    assert.equal(v.length, 230);
    assert.deepEqual(hub.env.AI.calls.map(c => c.input.text.length), [100, 100, 30]);
  });
});

function insertPassage(hub, conv, kind, ts, text = "x") {
  const v = new Float32Array(1024); v[0] = 1;
  hub.db.prepare("INSERT INTO passage(conv,kind,ref,title,from_seq,to_seq,ts,end_ts,speakers,text,vec) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(conv, kind, "r", "", 0, 0, ts, ts, "", text, new Uint8Array(v.buffer));
}

describe("index cap", () => {
  test("keeps CAP passages, dropping the oldest chat passages before any document", () => {
    const hub = makeHub();
    hub.db.exec("BEGIN");
    for (let i = 0; i < S.CAP - 2; i++) insertPassage(hub, "g:main", "chat", T0 + i * 1000);
    for (let i = 0; i < 5; i++) insertPassage(hub, "g:main", "doc", T0 - 1e9 + i);
    hub.db.exec("COMMIT");
    assert.equal(S.evict(hub), 3);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM passage").get().n, S.CAP);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM passage WHERE kind='doc'").get().n, 5, "documents kept");
    assert.equal(hub.db.prepare("SELECT MIN(ts) t FROM passage WHERE kind='chat'").get().t, T0 + 3000, "oldest three chat passages gone");
  });
});

describe("search", () => {
  test("cosine ranking, kinds and documents", async () => {
    const hub = makeHub();
    assert.equal(await S.indexText(hub, "g:main", "doc", "f1", "装修", "客厅刷成浅灰色，预算两万八。"), 1);
    assert.equal(await S.indexText(hub, "g:main", "doc", "f2", "旅行", "周六去海边烧烤，记得带防晒霜。"), 1);
    assert.equal(await S.indexText(hub, "g:other", "doc", "f3", "海边", "海边海边海边"), 1);
    const hits = await S.searchText(hub, "g:main", "去海边烧烤");
    assert.equal(hits[0].ref, "f2");
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits.every(h => h.conv === "g:main"));
    assert.equal((await S.searchText(hub, "g:main", "海边", "chat")).length, 0);
    assert.equal(await S.indexText(hub, "g:main", "doc", "f2", "旅行", "改成去爬山。"), 1, "re-indexing replaces");
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM passage WHERE ref='f2'").get().n, 1);
    hub.plan.add("ai_neurons", DAILY.ai_neurons.stop);
    assert.equal(await S.searchText(hub, "g:main", "海边"), null);
  });
  test("chunkText splits long documents with overlap", () => {
    const parts = S.chunkText(("这是一句话。").repeat(300));
    assert.ok(parts.length >= 3 && parts.every(p => p.length <= 600));
  });
});

async function chatHub() {
  const hub = makeHub();
  // Four conversations-worth of history, an hour apart, in the main group; one in a test room.
  hub.say("g:main", "小王", "周六去海边烧烤吧", T0);
  hub.say("g:main", "小李", "好啊我带烤架", T0 + MIN);
  hub.say("g:main", "老张", "装修预算大概28000", T0 + 60 * MIN);
  hub.say("g:main", "小王", "客厅想刷浅灰色", T0 + 61 * MIN);
  hub.say("g:main", "小李", "新电脑买了MacBook", T0 + 120 * MIN);
  hub.say("g:main", "老张", "海边那次烤糊了", T0 + 180 * MIN);
  hub.say("t:x", "测试", "海边测试", T0 + 180 * MIN);
  return hub;
}

describe("indexing", () => {
  test("backfills newest first, skips test rooms, then indexes new messages forward", async () => {
    const hub = await chatHub();
    const now = T0 + 200 * MIN;
    hub.say("g:main", "小李", "最新的一句还在聊", now - MIN);
    const r = await S.indexStep(hub, now);
    assert.ok(r.indexed >= 3);
    const got = hub.db.prepare("SELECT conv, from_seq, text FROM passage ORDER BY id").all();
    assert.ok(got.every(p => p.conv === "g:main"), "test room not indexed");
    const firsts = got.map(p => p.from_seq);
    assert.deepEqual(firsts, [...firsts].sort((a, b) => b - a), "newest first");
    assert.ok(!got.some(p => p.text.includes("最新的一句")), "open passage not indexed");
    while ((await S.indexStep(hub, now)).indexed) {}
    assert.equal(hub.db.prepare("SELECT done FROM passage_state WHERE conv='g:main'").get().done, 1);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM passage").get().n, 3, "the last settled passage joins the open one");
    // Later the open passage closes and is picked up going forward.
    await S.indexStep(hub, now + 30 * MIN);
    assert.ok(hub.db.prepare("SELECT COUNT(*) n FROM passage WHERE text LIKE '%最新的一句%'").get().n === 1);
  });
  test("indexing stops at its daily share", async () => {
    const hub = await chatHub();
    hub.set("search:idx:" + new Date(T0).toISOString().slice(0, 10), "3000");
    assert.equal((await S.indexStep(hub, T0 + 300 * MIN)).indexed, 0);
    assert.equal(hub.env.AI.calls.length, 0);
  });
});

describe("recall", () => {
  test("merges meaning with exact words, without duplicates; filters by days and person", async () => {
    const hub = await chatHub();
    const now = T0 + 300 * MIN;
    while ((await S.indexStep(hub, now)).indexed) {}
    // A message after indexing: found only by its exact words.
    hub.say("g:main", "小王", "MacBook 退货了", now);
    let r = await S.recall(hub, "g:main", { query: "去海边烧烤的那次" }, now + MIN);
    assert.equal(r.ok, true);
    assert.ok(r.passages.slice(0, 2).some(p => /海边烧烤/.test(p.text)));
    r = await S.recall(hub, "g:main", { query: "MacBook" }, now + MIN);
    const mac = r.passages.filter(p => /MacBook/.test(p.text));
    assert.equal(mac.length, 2);
    assert.ok(mac.some(p => p.how === "有原话" && /退货/.test(p.text)), "unindexed message found with its neighbours");
    assert.ok(mac.some(p => /也有原话/.test(p.how)), "indexed passage boosted, not repeated");
    const texts = r.passages.map(p => p.text);
    assert.equal(new Set(texts).size, texts.length);
    r = await S.recall(hub, "g:main", { query: "海边", who: "老张" }, now + MIN);
    assert.ok(r.passages.length && r.passages.every(p => p.speakers.includes("老张")));
    r = await S.recall(hub, "g:main", { query: "海边", days: 1 }, T0 + 3 * 86400000);
    assert.equal(r.passages.length, 0);
  });
  test("falls back to exact words when the allowance is used up", async () => {
    const hub = await chatHub();
    hub.plan.add("ai_neurons", DAILY.ai_neurons.stop);
    const r = await S.recall(hub, "g:main", { query: "28000" }, T0 + 300 * MIN);
    assert.ok(r.note);
    assert.match(r.passages[0].text, /28000/);
  });
  test("tool in a test room searches the main group", async () => {
    const hub = await chatHub();
    const tool = feature.tools({ hub, conv: "t:x" })[0];
    assert.equal(tool.name, "recall");
    const r = await tool.run({ query: "28000" });
    assert.match(r.passages[0].text, /28000/);
  });
});
