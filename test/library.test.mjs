// Offline tests for the library feature: real SQLite (node:sqlite) behind a fake hub, fake tools, fake model.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const lib = await import("../src/feat/library.ts");
const feature = lib.default;
const DAY = 86400000;

let fetchCalls = 0;
globalThis.fetch = async () => {
  fetchCalls++;
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"title":"整理后的标题","summary":"这篇讲了一件事。"}' } }], usage: {} }), { status: 200 });
};

function makeHub({ fts = true, tools = {} } = {}) {
  const db = new DatabaseSync(":memory:");
  const hub = {
    env: { PUBLIC_URL: "https://teamagent.example.workers.dev", DEEPSEEK_API_KEY: "x" },
    sql: {
      exec(q, ...b) {
        if (!fts && /CREATE VIRTUAL TABLE/i.test(q)) throw new Error("no such module: fts5");
        const rows = db.prepare(q).all(...b);
        return { toArray: () => rows };
      },
    },
    get: k => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? r.v : null; },
    set: (k, v) => { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); },
    edit: { cfg: (_c, k) => (k === "library_daily" ? hub.cap : 0) },
    cap: 40,
    shadow: () => "",
    ctx: { waitUntil: p => { hub.pending.push(p); } },
    pending: [],
    store: { fileRef: async () => null },
    calls: [],
    tools: () => Object.entries(tools).map(([name, fn]) => ({ name, run: async a => { hub.calls.push([name, a]); return fn(a); } })),
    db,
  };
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT NOT NULL, role TEXT NOT NULL, sender TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, mentioned INTEGER DEFAULT 0, meta TEXT)");
  db.exec("CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, src TEXT, size INTEGER)");
  db.exec(feature.schema);
  return hub;
}
let n = 0;
const say = (hub, conv, text, { name = "小明", meta, ts = Date.now(), role = "user" } = {}) =>
  hub.db.prepare("INSERT INTO msg(id,conv,role,sender,name,text,ts,meta) VALUES(?,?,?,?,?,?,?,?)").run("m" + ++n, conv, role, "q1", name, text, ts, meta ? JSON.stringify(meta) : null);
const docs = hub => hub.db.prepare("SELECT * FROM doc ORDER BY id").all();
const article = { read_url: a => ({ title: "原始标题 - 某站", content: "这是一篇很长的文章，讲的是向量数据库的取舍。".repeat(10) + " " + a.url }) };

describe("extraction", () => {
  test("plain links, share cards, files; trailing punctuation and Chinese text are cut", () => {
    const f = lib.extract("看这个https://a.com/x?id=1，还有 [分享卡片 好文章 / 副标题 https://b.com/p/2] 和(https://en.wikipedia.org/wiki/Foo_(bar))。", { files: [{ url: "https://qq.example/f?rkey=1", name: "报告.pdf" }, { url: "https://qq.example/i", name: "a.png" }] });
    assert.deepEqual(f.map(x => [x.kind, x.url]), [
      ["link", "https://a.com/x?id=1"], ["link", "https://b.com/p/2"], ["link", "https://en.wikipedia.org/wiki/Foo_(bar)"], ["file", "https://qq.example/f?rkey=1"],
    ]);
    assert.equal(f[1].title, "好文章 / 副标题");
    assert.equal(f[3].title, "报告.pdf");
  });
  test("a link ending in .pdf is read as a document", () => {
    assert.equal(lib.extract("https://a.com/paper.pdf", null)[0].kind, "file");
  });
});

describe("normalisation and skip rules", () => {
  test("tracking parameters, fragments, trailing slash, parameter order", () => {
    assert.equal(lib.normalizeUrl("https://A.com/x/?utm_source=a&b=2&a=1&spm=3#top"), "https://a.com/x?a=1&b=2");
    assert.equal(lib.normalizeUrl("https://a.com/?fbclid=1"), "https://a.com/");
    assert.equal(lib.normalizeUrl("ftp://a.com"), null);
    assert.equal(lib.normalizeUrl("nonsense"), null);
  });
  test("the same article shared twice in different forms is one entry", () => {
    const a = lib.extract("https://a.com/x?utm_medium=1#c https://a.com/x/", null);
    assert.equal(a.length, 1);
  });
  test("videos, images, QQ internals, own pages, private hosts are skipped", () => {
    const skip = ["https://www.bilibili.com/video/BV1", "https://b23.tv/abc", "https://v.douyin.com/x", "https://youtu.be/x", "https://www.youtube.com/watch?v=1",
      "https://a.com/pic.PNG", "https://gchat.qpic.cn/a", "https://multimedia.nt.qq.com.cn/x", "https://teamagent.example.workers.dev/p/abc", "http://localhost:8787/x", "http://192.168.1.2/a"];
    for (const u of skip) assert.deepEqual(lib.extract(u, null, ["teamagent.example.workers.dev"]), [], u);
    assert.equal(lib.extract("https://mp.weixin.qq.com/s?__biz=1&mid=2&chksm=zz", null).length, 1);
  });
});

describe("scan, cursor, test rooms", () => {
  let hub;
  beforeEach(() => { hub = makeHub({ tools: article }); });

  test("queues new links once and advances the cursor", () => {
    say(hub, "g1", "看 https://a.com/1");
    say(hub, "g1", "没链接");
    say(hub, "g1", "bot https://a.com/bot", { role: "bot" });
    assert.deepEqual(lib.scan(hub, "g1"), { scanned: 2, queued: 1 });
    assert.equal(hub.get("library:cursor:g1"), "3");
    assert.deepEqual(lib.scan(hub, "g1"), { scanned: 0, queued: 0 });
    say(hub, "g1", "又一个 https://a.com/1?utm_source=x https://a.com/2");
    assert.deepEqual(lib.scan(hub, "g1"), { scanned: 1, queued: 1 });
    assert.deepEqual(docs(hub).map(d => [d.url, d.status, d.by]), [["https://a.com/1", "pending", "小明"], ["https://a.com/2", "pending", "小明"]]);
  });

  test("a real conversation starts 30 days back, not at the beginning of time", () => {
    say(hub, "g1", "旧 https://a.com/old", { ts: Date.now() - 90 * DAY });
    say(hub, "g1", "新 https://a.com/new", { ts: Date.now() - DAY });
    lib.scan(hub, "g1");
    assert.deepEqual(docs(hub).map(d => d.url), ["https://a.com/new"]);
  });

  test("test rooms are ignored unless library:test names them", async () => {
    say(hub, "t:ag-lib", "https://a.com/1");
    say(hub, "g1", "https://a.com/2");
    hub.ctx.waitUntil = p => hub.pending.push(p);
    feature.tick(hub, Date.now());
    await Promise.all(hub.pending);
    assert.deepEqual(docs(hub).map(d => d.conv), ["g1"]);
    hub.set("library:test", "ag-lib");
    assert.equal(lib.eligible(hub, "t:ag-lib"), true);
    assert.equal(lib.eligible(hub, "t:other"), false);
    feature.tick(hub, Date.now());
    await Promise.all(hub.pending);
    assert.deepEqual(docs(hub).map(d => [d.conv, d.status]).sort(), [["g1", "ok"], ["t:ag-lib", "ok"]]);
  });
});

describe("archiving", () => {
  test("reads, titles through the model, stores text clipped to 60000", async () => {
    const hub = makeHub({ tools: { read_url: () => ({ title: "t", content: "字".repeat(70000) }) } });
    say(hub, "g1", "https://a.com/long");
    lib.scan(hub, "g1");
    const r = await lib.processPending(hub, "g1");
    assert.equal(r.done, 1);
    const d = docs(hub)[0];
    assert.equal(d.status, "ok");
    assert.equal(d.title, "整理后的标题");
    assert.equal(d.summary, "这篇讲了一件事。");
    assert.equal(d.text.length, 60000);
    assert.equal(d.chars, 70000);
  });

  test("files go through read_attachment; files over 15 MB are not read", async () => {
    const hub = makeHub({ tools: { read_attachment: () => ({ content: "文档内容".repeat(30), pages: 2 }), read_url: article.read_url } });
    hub.db.prepare("INSERT INTO blob(conv,ts,name,src,size) VALUES('g1',1,'大.pdf','https://qq/big',?)").run(16 * 1024 * 1024);
    say(hub, "g1", "", { meta: { files: [{ url: "https://qq/small", name: "小.pdf" }, { url: "https://qq/big", name: "大.pdf" }] } });
    lib.scan(hub, "g1");
    await lib.processPending(hub, "g1", 5);
    const by = Object.fromEntries(docs(hub).map(d => [d.url, d]));
    assert.equal(by["https://qq/small"].status, "ok");
    assert.equal(by["https://qq/small"].kind, "file");
    assert.match(by["https://qq/big"].status, /15MB/);
    assert.equal(by["https://qq/big"].retry_at, 0, "too large is final");
    assert.deepEqual(hub.calls.map(c => c[0]), ["read_attachment"]);
  });

  test("a failure is stored with its reason and retried at most twice, a day apart", async () => {
    let up = false;
    const hub = makeHub({ tools: { read_url: a => { if (!up) throw new Error("读不了"); return article.read_url(a); } } });
    say(hub, "g1", "https://a.com/x");
    lib.scan(hub, "g1");
    const t0 = Date.now();
    await lib.processPending(hub, "g1", 3, t0);
    let d = docs(hub)[0];
    assert.equal(d.status, "读不了");
    assert.equal(d.tries, 1);
    assert.equal(d.retry_at, t0 + DAY);
    assert.equal((await lib.processPending(hub, "g1", 3, t0 + 3600000)).items.length, 0, "not before a day");
    await lib.processPending(hub, "g1", 3, t0 + DAY + 1);
    d = docs(hub)[0];
    assert.equal(d.tries, 2);
    assert.equal(d.retry_at, t0 + DAY + 1 + DAY);
    await lib.processPending(hub, "g1", 3, t0 + 2 * DAY + 5);
    d = docs(hub)[0];
    assert.equal(d.tries, 3);
    assert.equal(d.retry_at, 0);
    assert.equal((await lib.processPending(hub, "g1", 3, t0 + 9 * DAY)).items.length, 0, "never again");
    assert.equal(hub.calls.length, 3);
  });

  test("daily cap stops further reading, including in tick", async () => {
    const hub = makeHub({ tools: article });
    hub.cap = 2;
    for (let i = 0; i < 5; i++) say(hub, "g1", "https://a.com/" + i);
    lib.scan(hub, "g1");
    const r = await lib.processPending(hub, "g1", 5);
    assert.equal(r.done, 2);
    assert.equal(r.capped, true);
    assert.equal(docs(hub).filter(d => d.status === "pending").length, 3);
    feature.tick(hub, Date.now());
    assert.equal(hub.pending.length, 0, "tick starts nothing once the cap is used");
    hub.cap = 3;
    feature.tick(hub, Date.now());
    await Promise.all(hub.pending);
    assert.equal(docs(hub).filter(d => d.status === "ok").length, 3);
  });

  test("tick reads at most three per tick, newest first", async () => {
    const hub = makeHub({ tools: article });
    for (let i = 0; i < 5; i++) say(hub, "g1", "https://a.com/" + i, { ts: Date.now() - (5 - i) * 1000 });
    feature.tick(hub, Date.now());
    await Promise.all(hub.pending);
    assert.deepEqual(docs(hub).filter(d => d.status === "ok").map(d => d.url), ["https://a.com/2", "https://a.com/3", "https://a.com/4"]);
  });
});

describe("search", () => {
  async function seeded(opts) {
    const hub = makeHub(opts);
    const put = (title, summary, text, by, ageDays) => hub.db.prepare("INSERT INTO doc(conv,ts,seq,by,kind,url,title,summary,text,chars,status) VALUES('g1',?,1,?,'link',?,?,?,?,?, 'ok')")
      .run(Date.now() - ageDays * DAY, by, "https://x.com/" + Math.random(), title, summary, text, text.length);
    put("向量数据库选型", "比较几种向量库", "正文提到 Milvus 和 Qdrant", "小明", 10);
    put("随笔", "一篇杂谈", "里面有一段讲向量数据库的内容", "小红", 1);
    put("向量数据库入门", "讲向量库", "正文", "小红", 3);
    put("别的", "无关", "完全无关的菜谱", "小明", 2);
    // the table was filled behind the library's back: build the index the way first use does
    return hub;
  }

  for (const fts of [true, false]) {
    test((fts ? "FTS5" : "LIKE fallback") + ": all words must match, title/summary above body, newer above older", async () => {
      const hub = await seeded({ fts });
      const r = await lib.searchDocs(hub, "g1", { query: "向量数据库" });
      assert.deepEqual(r.map(x => x.title), ["向量数据库入门", "向量数据库选型", "随笔"]);
      assert.equal(r[2].excerpt.includes("向量数据库"), true);
      assert.equal((await lib.searchDocs(hub, "g1", { query: "向量数据库 Milvus" })).length, 1);
      assert.equal((await lib.searchDocs(hub, "g1", { query: "菜谱 Milvus" })).length, 2, "no full match: half the words is enough");
      assert.equal((await lib.searchDocs(hub, "g1", { query: "向量数据库", who: "小红" })).length, 2);
      assert.equal((await lib.searchDocs(hub, "g1", { query: "向量数据库", days: 2 })).length, 1);
      assert.equal((await lib.searchDocs(hub, "g1", { query: "菜谱" })).length, 1, "short term works in both paths");
      assert.equal((await lib.searchDocs(hub, "g1", { query: "100%_" })).length, 0);
    });
  }

  test("FTS creation failing is detected and search still works", async () => {
    const hub = await seeded({ fts: false });
    await lib.searchDocs(hub, "g1", { query: "向量数据库" });
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='doc_fts'").get().n, 0);
    assert.equal((await lib.searchDocs(hub, "g1", { query: "Milvus" })).length, 1);
  });

  test("FTS index follows stored and forgotten documents", async () => {
    const hub = makeHub({ tools: article });
    const ctx = { hub, conv: "g1", askers: [{ id: "1", name: "小明" }], host: { quota: async () => true } };
    const tool = feature.tools(ctx)[0];
    say(hub, "g1", "https://a.com/vec");
    lib.scan(hub, "g1");
    await lib.processPending(hub, "g1");
    assert.equal((await tool.run({ op: "search", query: "向量数据库" })).results.length, 1);
    const id = docs(hub)[0].id;
    assert.equal((await tool.run({ op: "forget", id })).ok, true);
    assert.equal((await tool.run({ op: "search", query: "向量数据库" })).results.length, 0);
    assert.equal(docs(hub).length, 0);
  });

  test("semantic hooks: index called when stored, search blended in when set", async () => {
    const hub = makeHub({ tools: article });
    const idx = [];
    say(hub, "g1", "https://a.com/1");
    lib.scan(hub, "g1");
    await lib.processPending(hub, "g1");
    assert.equal(idx.length, 0);
    lib.setSemantic({ index: async (...a) => { idx.push(a); } });
    say(hub, "g1", "https://a.com/2");
    lib.scan(hub, "g1");
    await lib.processPending(hub, "g1");
    const id2 = docs(hub)[1].id;
    assert.deepEqual(idx[0].slice(1, 5), ["g1", "doc", String(id2), "整理后的标题"]);
    assert.match(idx[0][5], /这篇讲了一件事/);
    const first = docs(hub)[0].id;
    let asked;
    lib.setSemantic({ search: async (...a) => { asked = a; return [{ ref: String(first), score: 0.9, text: "" }, { ref: "9999", score: 0.5, text: "" }]; } });
    const r = await lib.searchDocs(hub, "g1", { query: "一个意思相近但字面不同的问题" });
    assert.deepEqual(asked.slice(1), ["g1", "一个意思相近但字面不同的问题", "doc", 20]);
    assert.deepEqual(r.map(x => x.id), [first], "unknown refs dropped");
    lib.setSemantic({ search: async () => { throw new Error("down"); } });
    assert.equal((await lib.searchDocs(hub, "g1", { query: "向量数据库" })).length, 2, "a failing hook falls back to keywords");
    lib.setSemantic({});
  });
});

describe("tool and admin", () => {
  test("get pages through the text; recent lists newest first; save archives now", async () => {
    const hub = makeHub({ tools: { read_url: () => ({ title: "t", content: "甲".repeat(30000) }) } });
    let quota = 0;
    const ctx = { hub, conv: "g1", askers: [{ id: "1", name: "小红" }], host: { quota: async () => ++quota <= 1 } };
    const tool = feature.tools(ctx)[0];
    assert.match(tool.description, /之前|分享过/);
    const saved = await tool.run({ op: "save", url: "https://a.com/long?utm_source=q#x" });
    assert.equal(saved.ok, true);
    const row = docs(hub)[0];
    assert.equal(row.url, "https://a.com/long");
    assert.equal(row.by, "小红");
    const p1 = await tool.run({ op: "get", id: row.id });
    assert.equal(p1.text.length, 12000);
    assert.equal(p1.next_offset, 12000);
    const p3 = await tool.run({ op: "get", id: row.id, offset: 24000 });
    assert.equal(p3.text.length, 6000);
    assert.equal(p3.next_offset, null);
    assert.equal((await tool.run({ op: "get", id: 999 })).ok, false);
    assert.equal((await tool.run({ op: "save", url: "https://a.com/long" })).already, true);
    assert.match((await tool.run({ op: "save", url: "https://www.bilibili.com/video/BV1" })).error, /视频/);
    assert.equal((await tool.run({ op: "save", url: "https://a.com/other" })).ok, false, "manual quota");
    assert.equal((await tool.run({ op: "recent" })).results.length, 1);
  });

  test("admin GET reports counts and failures; POST scan processes now and respects the test flag", async () => {
    const hub = makeHub({ tools: { read_url: a => { if (a.url.endsWith("/bad")) throw new Error("打不开"); return article.read_url(a); } } });
    say(hub, "t:ag-lib", "https://a.com/good https://a.com/bad");
    const call = (method, path, body) => feature.admin(hub, new Request("https://x" + path, { method }), new URL("https://x" + path), body);
    let res = await call("POST", "/admin/library", { scan: true, conv: "t:ag-lib" });
    assert.equal(res.status, 400);
    hub.set("library:test", "ag-lib");
    res = await (await call("POST", "/admin/library", { scan: true, conv: "t:ag-lib" })).json();
    assert.deepEqual([res.scanned.queued, res.processed.done, res.processed.failed], [2, 1, 1]);
    const st = await (await call("GET", "/admin/library?conv=t:ag-lib", null)).json();
    assert.deepEqual([st.counts.ok, st.counts.failed, st.counts.retrying, st.today.used], [1, 1, 1, 2]);
    assert.equal(st.failures[0].reason, "打不开");
    assert.equal(await call("GET", "/admin/other", null), null);
  });

  test("tunable and about are declared", () => {
    assert.equal(feature.tunables.library_daily.default, 40);
    assert.ok(feature.about.length >= 3);
    assert.match(feature.schema, /UNIQUE INDEX[^;]*\(conv, url\)/);
  });
});
