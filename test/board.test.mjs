// Offline tests for the team board (src/feat/board.ts, board-page.ts): routes, headers, every API section
// against seeded tables, conversation isolation, cross-site refusal, and task changes going through the
// task contract (stood in for by a fake, since tasks.ts is written separately).
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import M, { serve, taskApi, files, CSP } from "../src/feat/board.ts";
import { APP_JS } from "../src/feat/board-page.ts";
import access, { issueAccess } from "../src/feat/access.ts";
import filebox from "../src/feat/filebox.ts";
import transfer from "../src/feat/transfer.ts";
import publish from "../src/feat/publish.ts";
import staticsite from "../src/feat/staticsite.ts";
import uptime from "../src/feat/uptime.ts";
import feeds from "../src/feat/feeds.ts";
import watch from "../src/feat/watch.ts";
import repocheck from "../src/feat/repocheck.ts";
import { Plan } from "../src/budget.ts";
import { Store } from "../src/store.ts";
import { Accounts } from "../src/accounts.ts";

const HUB_SQL = `CREATE TABLE IF NOT EXISTS msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT NOT NULL, role TEXT NOT NULL, sender TEXT, name TEXT, text TEXT NOT NULL, ts INTEGER NOT NULL, mentioned INTEGER DEFAULT 0, meta TEXT);
CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS note(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, text TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS day(conv TEXT, date TEXT, summary TEXT, PRIMARY KEY(conv, date));
CREATE TABLE IF NOT EXISTS img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT);
CREATE TABLE IF NOT EXISTS spend(day TEXT, provider TEXT, item TEXT, unit TEXT, calls INTEGER DEFAULT 0, in_tok INTEGER DEFAULT 0, cached_tok INTEGER DEFAULT 0, out_tok INTEGER DEFAULT 0, units REAL DEFAULT 0, usd REAL DEFAULT 0, PRIMARY KEY(day, provider, item));
CREATE TABLE IF NOT EXISTS snap(day TEXT PRIMARY KEY, cny REAL, ts INTEGER);
CREATE TABLE IF NOT EXISTS blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, data BLOB);`;

function mkHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(HUB_SQL);
  for (const f of [access, filebox, transfer, publish, staticsite, uptime, feeds, watch, repocheck]) if (f.schema) db.exec(f.schema);
  const fix = v => v instanceof ArrayBuffer ? new Uint8Array(v) : v;   // Node's SQLite refuses a bare ArrayBuffer
  const r2 = new Map(), reads = { n: 0 };
  const hub = {
    db, r2, reads,
    env: { PUBLIC_URL: "https://bot.example", FILES: { async get(k) { reads.n++; const b = r2.get(k); return b ? { body: b, size: b.byteLength } : null; }, async put(k, v) { r2.set(k, new Uint8Array(v)); }, async delete() {} } },
    ctx: { waitUntil() {} },
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)|RETURNING/i.test(q) ? st.all(...b.map(fix)) : (st.run(...b.map(fix)), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    get(k) { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set(k, v) { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); },
    shadow: () => "",
    memoryOf(c) { return this.get("memory:" + c) || ""; },
    edit: { cfg: () => undefined },
  };
  hub.sql.exec = hub.sql.exec.bind(hub.sql);
  hub.plan = new Plan(hub);
  hub.store = new Store(hub);
  hub.accounts = new Accounts(hub);
  return hub;
}

// An in-memory stand-in for tasks.ts. getTask deliberately ignores `conv`, so the board's own check is what is tested.
function fakeTasks() {
  const list = [], notes = [], calls = [];
  const T = {
    listTasks: (hub, conv, f = {}) => { calls.push(["list", conv, f]); return list.filter(t => t.conv === conv && (!f.status || f.status.includes(t.status))).slice(0, f.limit || 999); },
    getTask: (hub, conv, id) => list.find(t => t.id === id) || null,
    addTask: (hub, conv, t) => { calls.push(["add", conv, t]); const x = { id: list.length + 1, conv, title: t.title, detail: t.detail || "", status: "open", owner: t.owner || "", due: t.due || "", source: t.source || "", by: t.by || "", claimed_by: "", result: "", created: Date.now(), updated: Date.now() }; list.push(x); return x; },
    updateTask: (hub, conv, id, patch, who) => { calls.push(["update", conv, id, patch, who]); const t = list.find(t => t.id === id && t.conv === conv); if (!t) return null; Object.assign(t, patch); return t; },
    claimTask: (hub, conv, id, who) => { calls.push(["claim", conv, id, who]); const t = list.find(t => t.id === id && t.conv === conv); if (!t || t.claimed_by || t.status !== "open") return null; t.claimed_by = who; t.status = "doing"; return t; },
    addTaskNote: (hub, conv, id, who, text) => { calls.push(["note", conv, id, who, text]); notes.push({ id, ts: Date.now(), who, text }); return true; },
    taskNotes: (hub, conv, id) => notes.filter(n => n.id === id).map(({ ts, who, text }) => ({ ts, who, text })),
  };
  Object.assign(taskApi, T);
  return { list, calls };
}

const H = "https://bot.example";
let hub, A, B, tk;
const call = (path, o = {}) => {
  const headers = { ...(o.token ? { cookie: "tabd=" + o.token } : {}), ...(o.headers || {}) };
  if (o.json !== undefined) { headers["content-type"] ??= "application/json"; if (!o.noOrigin) headers.origin ??= H; }
  const req = new Request(H + path, { method: o.method || (o.json !== undefined ? "POST" : "GET"), headers, body: o.json !== undefined ? (typeof o.json === "string" ? o.json : JSON.stringify(o.json)) : undefined });
  return serve(hub, req, new URL(H + path));
};
const get = async (path, token = A) => { const r = await call(path, { token }); return { r, j: await r.json() }; };
const post = async (path, json, o = {}) => { const r = await call(path, { token: A, json, ...o }); return { r, j: await r.json() }; };

beforeEach(async () => {
  hub = mkHub();
  A = await issueAccess(hub, "g:a", { id: "u1", name: "小明" });
  B = await issueAccess(hub, "g:b", { id: "u9", name: "外人" });
  tk = fakeTasks();
});

describe("page and static parts", () => {
  test("without a person: one sentence, 401, no data", async () => {
    const r = await call("/x/board");
    assert.equal(r.status, 401);
    assert.match(await r.text(), /给我看板链接/);
    for (const p of ["/x/board/api/me", "/x/board/api/tasks", "/x/board/api/images", "/x/board/img/1", "/x/board/file/1", "/x/board/box/1"]) {
      assert.equal((await call(p)).status, 401, p);
      assert.equal((await call(p, { token: "0".repeat(40) })).status, 401, p);
    }
    assert.equal((await call("/x/board/api/tasks", { json: { title: "x" } })).status, 401);
  });
  test("page headers, CSP, ETag, no token in the HTML", async () => {
    const r = await call("/x/board", { token: A });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(r.headers.get("cache-control"), "private, no-cache");
    assert.equal(r.headers.get("content-security-policy"), CSP);
    assert.doesNotMatch(CSP, /unsafe|\*|https?:/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    const html = await r.text();
    assert.ok(!html.includes(A));
    assert.doesNotMatch(html, /https?:\/\//);
    const etag = r.headers.get("etag");
    assert.equal((await call("/x/board", { token: A, headers: { "if-none-match": etag } })).status, 304);
    const links = [...html.matchAll(/(?:src|href)="(\/x\/board\/[^"]+)"/g)].map(m => m[1]);
    assert.equal(links.length, 2);
    for (const l of links) {
      const s = await call(l);                                    // static parts need no login
      assert.equal(s.status, 200, l);
      assert.equal(s.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.match(s.headers.get("content-type"), /^text\/(css|javascript); charset=utf-8$/);
    }
    assert.equal((await call("/x/board/app.js?v=old")).headers.get("cache-control"), "public, max-age=300");
    assert.equal((await call("/x/board/nope.js", { token: A })).status, 404);
    assert.equal(await call("/x/boardx"), null);
    assert.equal(await call("/x/board/k/" + A), null);       // access.ts handles links
    assert.equal(await M.open(hub, new Request(H + "/p/x/"), new URL(H + "/p/x/")), null);
  });
  test("browser code parses and avoids absolute URLs and raw HTML", () => {
    new Function(APP_JS);
    assert.doesNotMatch(APP_JS, /innerHTML|insertAdjacentHTML|document\.write|eval\(/);
    assert.doesNotMatch(APP_JS, /https?:\/\//);
    assert.ok(files()["app.js"].body === APP_JS);
  });
});

describe("api sections", () => {
  test("me, days with paging", async () => {
    for (let i = 1; i <= 9; i++) hub.sql.exec("INSERT INTO day(conv,date,summary) VALUES(?,?,?)", "g:a", "2026-11-0" + i, "第 " + i + " 天");
    hub.sql.exec("INSERT INTO day(conv,date,summary) VALUES(?,?,?)", "g:b", "2026-11-10", "别的群");
    assert.deepEqual((await get("/x/board/api/me")).j, { ok: true, name: "小明", people: ["小明"] });
    let { j } = await get("/x/board/api/days");
    assert.equal(j.days.length, 7); assert.equal(j.days[0].date, "2026-11-09"); assert.equal(j.more, true);
    ({ j } = await get("/x/board/api/days?before=2026-11-03&n=7"));
    assert.deepEqual(j.days.map(d => d.date), ["2026-11-02", "2026-11-01"]); assert.equal(j.more, false);
  });
  test("memory and notes", async () => {
    hub.set("memory:g:a", "【群友】\n· 小明爱喝咖啡（11-14）"); hub.set("memory:g:b", "秘密");
    hub.sql.exec("INSERT INTO note(conv,text,ts) VALUES('g:a','周五聚餐',1),('g:b','别的群的事',2)");
    const { j } = await get("/x/board/api/memory");
    assert.match(j.memory, /咖啡/); assert.deepEqual(j.notes.map(n => n.text), ["周五聚餐"]);
  });
  test("repos, monitors, plan, tools", async () => {
    hub.sql.exec("INSERT INTO repocheck(repo,ts,sha,ok,summary) VALUES(?,?,?,?,?)", "TeamAgent", Date.now(), "abc1234", 1,
      JSON.stringify({ v: 1, repo: "TeamAgent", sha: "abc1234def", src: "table", builds: false, steps: [{ id: "root:test", k: "test", s: "pass", t: 12, c: { n: 10, p: 10, f: 0, s: 0, runner: "node" } }], c24: { n: 3, files: 4, ins: 10, del: 2, au: [] } }));
    let { j } = await get("/x/board/api/repos");
    const ta = j.repos.find(r => r.repo === "TeamAgent");
    assert.equal(ta.result, "通过"); assert.equal(ta.steps[0].result, "通过"); assert.equal(ta.commits_24h.count, 3);
    assert.ok(j.repos.some(r => r.result === "还没检查过"));

    const now = Date.now();
    hub.sql.exec("INSERT INTO uptime(conv,name,url,state,since,last,latency_ms,active,created,every_min) VALUES('g:a','官网','https://a.example','up',?,?,120,1,?,5)", now - 1000, now, now - 86400000);
    hub.sql.exec("INSERT INTO uptime(conv,name,url,state,active,created) VALUES('g:b','别人','https://b.example','down',1,?)", now);
    hub.sql.exec("INSERT INTO feed(conv,url,title,kind,last,fails,active) VALUES('g:a','https://f.example/rss','博客','rss',?,0,1)", now);
    hub.sql.exec("INSERT INTO feeditem(feed,guid,title,link,published,seen) VALUES(1,'1','新文章','https://f.example/1',?,?)", now, now);
    hub.sql.exec("INSERT INTO watch(conv,url,what,last,state,active,hits,fails,every_min) VALUES('g:a','https://w.example','价格',?,'99 元',1,2,0,180)", now);
    ({ j } = await get("/x/board/api/monitors"));
    assert.equal(j.uptime.length, 1); assert.equal(j.uptime[0].uptime_7d, 100); assert.equal(j.uptime[0].ms, 120);
    assert.equal(j.feeds[0].latest.title, "新文章"); assert.equal(j.watches[0].state, "99 元");

    hub.plan.add("r2_reads", 5);
    ({ j } = await get("/x/board/api/plan"));
    assert.ok(j.plan.items.some(i => /R2 读取/.test(i.what) && i.used === 5));
    assert.equal(typeof j.spend.today, "number"); assert.ok(Array.isArray(j.spend.items));

    ({ j } = await get("/x/board/api/tools"));
    assert.equal(j.link, "/x/toolbox"); assert.ok(j.abilities.length > 10); assert.ok(j.abilities.every(a => a.examples.every(e => !/（/.test(e))));
  });
  test("sites and the file box", async () => {
    hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,?,?,?)', "aaaaaaaaaaaa", "g:a", "投票", 1, 2, "小明", 1, 10, 5);
    hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,?,?,?)', "bbbbbbbbbbbb", "g:a", "", 1, 3, "", 1, 10, 0);
    hub.sql.exec('INSERT INTO deploy(conv,name,id,source,ver,spa,files,bytes,at,"by",note) VALUES(?,?,?,?,?,?,?,?,?,?,?)', "g:a", "docs", "bbbbbbbbbbbb", JSON.stringify({ kind: "repo", repo: "TeamAgent", dir: "." }), "1", 0, 1, 10, 3, "", "abc");
    hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,?,?,?)', "cccccccccccc", "g:b", "别人的", 1, 2, "", 1, 10, 0);
    let { j } = await get("/x/board/api/sites");
    assert.deepEqual(j.sites.map(s => [s.name, s.url, s.source]), [["docs", "/p/bbbbbbbbbbbb/", "仓库 TeamAgent"]]);
    assert.deepEqual(j.pages.map(p => p.url), ["/p/aaaaaaaaaaaa/"]);

    const exp = Date.now() + 86400000;
    hub.sql.exec('INSERT INTO boxfile(conv,name,size,mime,key,ts,expires,"by",note) VALUES(?,?,?,?,?,?,?,?,?)', "g:a", "录屏.mp4", 5000000, "video/mp4", "box/g_a/1-a.mp4", 1, exp, "小明", "");
    hub.sql.exec('INSERT INTO boxfile(conv,name,size,mime,key,ts,expires,"by",note) VALUES(?,?,?,?,?,?,?,?,?)', "g:b", "别人的.zip", 10, "application/zip", "box/g_b/2-b.zip", 1, exp, "", "");
    ({ j } = await get("/x/board/api/box"));
    assert.deepEqual(j.files.map(f => f.ref), ["x1"]); assert.equal(j.files[0].url, "/x/board/box/1");
    const r = await call("/x/board/box/1", { token: A });
    assert.equal(r.status, 302); assert.match(r.headers.get("location"), /^\/x\/box\/[0-9a-f]{32}\//);
    assert.equal((await call("/x/board/box/2", { token: A })).status, 404);

    ({ j } = await post("/x/board/api/box/upload", {}));
    assert.equal(j.ok, true); assert.match(j.url, /^\/x\/drop\/[0-9a-f]{32}$/);
    assert.equal(JSON.parse(hub.get("box:drop:" + j.url.slice(8))).conv, "g:a");
  });
});

describe("pictures and files", () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  test("listing, paging, kinds, bytes with private caching, R2 reads counted", async () => {
    for (let i = 0; i < 35; i++) await hub.store.putImage("g:a", png, "image/png", "图 " + i, i === 0 ? { src: "chat:5-0" } : { made: { request: "画只猫 " + i } });
    const other = await hub.store.putImage("g:b", png, "image/png", "别的群的图");
    let { j } = await get("/x/board/api/images");
    assert.equal(j.images.length, 30); assert.equal(j.more, true); assert.equal(j.images[0].how, "画只猫 34"); assert.equal(j.images[0].kind, "made");
    assert.ok(j.images.every(p => !("data" in p)));
    ({ j } = await get("/x/board/api/images?before=" + j.images[29].id));
    assert.equal(j.images.length, 5); assert.equal(j.more, false); assert.equal(j.images[4].kind, "chat");
    ({ j } = await get("/x/board/api/images?kind=chat"));
    assert.equal(j.images.length, 1);

    const r = await call("/x/board/img/1", { token: A });
    assert.equal(r.status, 200); assert.equal(r.headers.get("content-type"), "image/png");
    assert.equal(r.headers.get("cache-control"), "private, max-age=86400");
    assert.deepEqual(new Uint8Array(await r.arrayBuffer()), png);
    assert.equal((await call("/x/board/img/1", { token: A, headers: { "if-none-match": r.headers.get("etag") } })).status, 304);
    assert.equal((await call("/x/board/img/" + other, { token: A })).status, 404);
    assert.equal((await call("/x/board/img/" + other, { token: B })).status, 200);

    hub.r2.set("img/900", png);
    hub.sql.exec("INSERT INTO img(id,conv,ts,mime,note,r2,size) VALUES(900,'g:a',1,'image/svg+xml','svg','img/900',7)");
    const before = hub.plan.used("r2_reads");
    const s = await call("/x/board/img/900", { token: A });
    assert.equal(s.status, 200); assert.equal(s.headers.get("content-type"), "application/octet-stream");   // SVG never renders here
    assert.equal(hub.plan.used("r2_reads"), before + 1); assert.equal(hub.reads.n, 1);
  });
  test("files download as attachments and stay in their conversation", async () => {
    const a = await hub.store.putFile("g:a", "报告.pdf", new Uint8Array([1, 2, 3]));
    const b = await hub.store.putFile("g:b", "别人的.txt", new Uint8Array([4]), "https://x.example/f");
    let { j } = await get("/x/board/api/files");
    assert.deepEqual(j.files.map(f => [f.ref, f.name, f.received]), [["f" + a, "报告.pdf", false]]);
    const r = await call("/x/board/file/" + a, { token: A });
    assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /^attachment;/);
    assert.equal(r.headers.get("content-type"), "application/pdf");
    assert.equal(r.headers.get("cache-control"), "private, max-age=86400");
    assert.equal((await call("/x/board/file/" + b, { token: A })).status, 404);
    ({ j } = await get("/x/board/api/files", B));
    assert.deepEqual(j.files.map(f => f.received), [true]);
  });
});

describe("tasks", () => {
  test("add, list, edit, claim, note: through the contract, under the visitor's name", async () => {
    let { r, j } = await post("/x/board/api/tasks", { title: "  写周报 ", detail: "按模板", owner: "小红", due: "2026-11-20" });
    assert.equal(r.status, 200); assert.equal(j.task.title, "写周报");
    assert.deepEqual(tk.calls.at(-1), ["add", "g:a", { title: "写周报", detail: "按模板", owner: "小红", due: "2026-11-20", source: "看板", by: "小明" }]);
    ({ j } = await get("/x/board/api/tasks"));
    assert.equal(j.tasks.length, 1); assert.deepEqual(tk.calls.at(-1)[2].status, ["open", "doing"]);
    ({ j } = await get("/x/board/api/tasks/1"));
    assert.equal(j.prompt, "用 teamagent 的 claim_task 领取任务 #1，做完用 complete_task 交付");
    ({ j } = await post("/x/board/api/tasks/1/claim", {}));
    assert.equal(j.task.status, "doing"); assert.equal(j.task.claimed_by, "小明");
    assert.equal((await post("/x/board/api/tasks/1/claim", {})).r.status, 409);
    ({ j } = await post("/x/board/api/tasks/1/note", { text: "写了一半" }));
    assert.deepEqual(j.notes.map(n => [n.who, n.text]), [["小明", "写了一半"]]);
    ({ j } = await post("/x/board/api/tasks/1", { status: "done", result: "发群里了" }));
    assert.equal(j.task.status, "done");
    assert.deepEqual(tk.calls.at(-1), ["update", "g:a", 1, { result: "发群里了", status: "done" }, "小明"]);
    ({ j } = await get("/x/board/api/tasks?status=done,dropped"));
    assert.equal(j.tasks.length, 1);
  });
  test("bad input is refused", async () => {
    await post("/x/board/api/tasks", { title: "x" });
    for (const [p, b] of [["/x/board/api/tasks", { title: "" }], ["/x/board/api/tasks/1", { due: "下周" }], ["/x/board/api/tasks/1", { status: "gone" }], ["/x/board/api/tasks/1", {}], ["/x/board/api/tasks/1/note", { text: " " }], ["/x/board/api/tasks", [1]]])
      assert.equal((await post(p, b)).r.status, 400, p + " " + JSON.stringify(b));
    assert.equal((await post("/x/board/api/tasks", "{bad")).r.status, 400);
    assert.equal((await post("/x/board/api/nope", {})).r.status, 404);
  });
  test("another conversation's task cannot be read or changed by guessing its id", async () => {
    await post("/x/board/api/tasks", { title: "秘密任务" });
    const n = tk.calls.length;
    assert.equal((await get("/x/board/api/tasks/1", B)).r.status, 404);
    for (const [p, b] of [["/x/board/api/tasks/1", { status: "dropped" }], ["/x/board/api/tasks/1/note", { text: "hi" }], ["/x/board/api/tasks/1/claim", {}]])
      assert.equal((await post(p, b, { token: B })).r.status, 404, p);
    assert.equal(tk.calls.length, n);
    assert.equal((await get("/x/board/api/tasks", B)).j.tasks.length, 0);
    assert.equal(tk.list[0].status, "open");
  });
});

describe("changes are guarded", () => {
  test("cross-site, wrong type, too big, wrong method", async () => {
    const before = tk.calls.length;
    assert.equal((await post("/x/board/api/tasks", { title: "x" }, { headers: { origin: "https://evil.example" } })).r.status, 403);
    assert.equal((await post("/x/board/api/tasks", { title: "x" }, { headers: { origin: "null" } })).r.status, 403);
    assert.equal((await post("/x/board/api/tasks", { title: "x" }, { headers: { "content-type": "text/plain" } })).r.status, 415);
    assert.equal((await post("/x/board/api/tasks", { title: "x", detail: "长".repeat(110 * 1024) })).r.status, 413);
    assert.equal((await post("/x/board/api/logout", {}, { headers: { origin: "https://evil.example" } })).r.status, 403);
    assert.equal(tk.calls.length, before);
    // The mirror's address is accepted; so is a request without Origin (same-origin GET-style clients).
    hub.env.PUBLIC_URL_CN = "https://mirror.example";
    assert.equal((await post("/x/board/api/tasks", { title: "镜像" }, { headers: { origin: "https://mirror.example" } })).r.status, 200);
    assert.equal((await post("/x/board/api/tasks", { title: "没有 Origin" }, { noOrigin: true })).r.status, 200);
    assert.equal((await call("/x/board/api/tasks", { token: A, method: "PUT" })).status, 405);
    assert.equal((await call("/x/board", { token: A, method: "POST" })).status, 405);
  });
  test("the MCP line only on request, logout clears the cookie", async () => {
    let { j } = await post("/x/board/api/mcp", {});
    assert.deepEqual(j.lines, ["claude mcp add --scope user --transport http teamagent https://bot.example/x/mcp/" + A]);
    assert.equal((await call("/x/board/api/mcp", { token: A })).status, 404);   // not readable with a GET
    const r = await call("/x/board/api/logout", { token: A, json: {} });
    assert.match(r.headers.get("set-cookie"), /^tabd=; Path=\/x\/; Max-Age=0/);
  });
});
