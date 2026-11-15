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
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = st.columns().length ? st.all(...b.map(fix)) : (st.run(...b.map(fix)), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
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
  const list = [], notes = [], calls = [], refs = [], state = { busy: 0 };
  const live = t => t.status === "open" || t.status === "doing";
  const blockers = (hub, conv, t) => (t.after || []).map(id => list.find(x => x.id === id && x.conv === conv)).filter(x => x && live(x));
  const T = {
    listTasks: (hub, conv, f = {}) => { calls.push(["list", conv, f]); return list.filter(t => t.conv === conv && (!f.status || f.status.includes(t.status))).slice(0, f.limit || 999); },
    getTask: (hub, conv, id) => list.find(t => t.id === id) || null,
    addTask: (hub, conv, t) => { calls.push(["add", conv, t]); const x = { id: list.length + 1, conv, title: t.title, detail: t.detail || "", status: "open", owner: t.owner || "", due: t.due || "", source: t.source || "", by: t.by || "", claimed_by: "", result: "", created: Date.now(), updated: Date.now(), priority: t.priority || 2, after: t.after || [], parent: t.parent || 0 }; list.push(x); return x; },
    updateTask: (hub, conv, id, patch, who) => { calls.push(["update", conv, id, patch, who]); const t = list.find(t => t.id === id && t.conv === conv); if (!t) return null; Object.assign(t, patch); return t; },
    claimTask: (hub, conv, id, who) => { calls.push(["claim", conv, id, who]); const t = list.find(t => t.id === id && t.conv === conv); if (!t || t.claimed_by || t.status !== "open") return null; t.claimed_by = who; t.status = "doing"; return t; },
    addTaskNote: (hub, conv, id, who, text) => { calls.push(["note", conv, id, who, text]); notes.push({ id, ts: Date.now(), who, text }); return true; },
    taskNotes: (hub, conv, id) => notes.filter(n => n.id === id).map(({ ts, who, text }) => ({ ts, who, text })),
    blockers,
    workOrder: (hub, conv) => { calls.push(["order", conv]); const k = t => [blockers(hub, conv, t).length ? 1 : 0, t.status === "doing" ? 0 : 1, t.priority || 2, t.id];
      return list.filter(t => t.conv === conv && live(t)).sort((a, b) => { const x = k(a), y = k(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }).map(task => ({ task, blocked_by: blockers(hub, conv, task).map(b => b.id) })); },
    checkAfter: (hub, conv, self, ids) => {
      calls.push(["checkAfter", conv, self, ids]);
      for (const id of ids) { const seen = new Set(), st = [id]; while (st.length) { const x = st.pop(); if (x === self) return { ids: [], error: "#" + id + " 自己就在等 #" + self + " 做完" }; if (seen.has(x)) continue; seen.add(x); st.push(...(list.find(t => t.id === x)?.after || [])); } }
      return { ids };
    },
    botBusy: (hub, conv) => state.busy && list.find(t => t.id === state.busy && t.conv === conv) ? state.busy : 0,
    taskRefs: (hub, conv, id) => refs.filter(r => r.task === id && r.conv === conv).map(({ conv, ...r }) => r),
    addTaskRef: (hub, conv, id, r) => { calls.push(["ref", conv, id, r]); if (refs.length >= 3) return null; const x = { id: refs.length + 1, task: id, conv, ts: Date.now(), who: r.who || "", kind: r.kind, title: r.title || "", ref: r.ref || "", text: r.text || "" }; refs.push(x); const { conv: _c, ...o } = x; return o; },
    removeTaskRef: (hub, conv, id, rid, who) => { calls.push(["unref", conv, id, rid, who]); const i = refs.findIndex(r => r.id === rid && r.task === id && r.conv === conv); if (i < 0) return false; refs.splice(i, 1); return true; },
    handoff: (hub, conv, id) => {
      const t = list.find(x => x.id === id && x.conv === conv); if (!t) return null;
      const par = list.find(x => x.id === t.parent && x.conv === conv);
      return { task: t, materials: T.taskRefs(hub, conv, id).concat(par ? T.taskRefs(hub, conv, par.id).map(r => ({ ...r, from: par.id })) : []),
        waits_for: (t.after || []).map(x => list.find(y => y.id === x)).filter(Boolean).map(x => ({ id: x.id, title: x.title, status: x.status, owner: x.claimed_by || x.owner, result: x.result })),
        blocked_by: blockers(hub, conv, t).map(b => b.id), parent: par ? { id: par.id, title: par.title, status: par.status, result: par.result } : null,
        children: list.filter(x => x.parent === id && x.conv === conv).map(x => ({ id: x.id, title: x.title, status: x.status, owner: x.claimed_by || x.owner })), notes: [] };
    },
  };
  Object.assign(taskApi, T);
  return { list, calls, refs, state };
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
    assert.deepEqual(tk.calls.findLast(c => c[0] === "add"), ["add", "g:a", { title: "写周报", detail: "按模板", owner: "小红", due: "2026-11-20", source: "看板", by: "小明" }]);
    ({ j } = await get("/x/board/api/tasks"));
    assert.equal(j.tasks.length, 1); assert.ok(tk.calls.some(c => c[0] === "order" && c[1] === "g:a"));
    ({ j } = await get("/x/board/api/tasks/1"));
    assert.equal(j.prompt, "用 teamagent 的 get_task 读任务 #1 的全部交接材料（原话、报告、前置任务的结果），再用 claim_task 领取；做的过程中用 report_progress 记进展，产出的报告和链接用 attach_material 挂到任务上，做完用 complete_task 交付；自己做不了的部分用 add_task（parent 填 1）拆出来并写清原因");
    ({ j } = await post("/x/board/api/tasks/1/claim", {}));
    assert.equal(j.task.status, "doing"); assert.equal(j.task.claimed_by, "小明");
    assert.equal((await post("/x/board/api/tasks/1/claim", {})).r.status, 409);
    ({ j } = await post("/x/board/api/tasks/1/note", { text: "写了一半" }));
    assert.deepEqual(j.notes.map(n => [n.who, n.text]), [["小明", "写了一半"]]);
    ({ j } = await post("/x/board/api/tasks/1", { status: "done", result: "发群里了" }));
    assert.equal(j.task.status, "done");
    assert.deepEqual(tk.calls.findLast(c => c[0] === "update"), ["update", "g:a", 1, { result: "发群里了", status: "done" }, "小明"]);
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

describe("work order, priority, prerequisites and hand-off materials", () => {
  const seed = async () => {
    await post("/x/board/api/tasks", { title: "调研竞品" });                         // 1
    await post("/x/board/api/tasks", { title: "写方案", after: [1] });               // 2, waits for 1
    await post("/x/board/api/tasks", { title: "订会议室", priority: "high" });       // 3, urgent
    await post("/x/board/api/tasks", { title: "整理桌面", priority: 3 });            // 4, can wait
    Object.assign(tk.list[0], { status: "doing", claimed_by: "bot" }); tk.state.busy = 1;
    tk.list.push({ id: 5, conv: "g:a", title: "找人问价格", detail: "", status: "open", owner: "小红", due: "", source: "", by: "bot", claimed_by: "", result: "", created: 1, updated: 1, priority: 2, after: [], parent: 1 });
  };
  test("creating with priority and prerequisites goes through the contract; bad ones are refused", async () => {
    let { r, j } = await post("/x/board/api/tasks", { title: "a", priority: "high", after: "" });
    assert.equal(r.status, 200); assert.equal(j.task.priority, 1);
    assert.deepEqual(tk.calls.findLast(c => c[0] === "add")[2], { title: "a", detail: "", owner: "", due: "", source: "看板", by: "小明", priority: 1 });
    ({ j } = await post("/x/board/api/tasks", { title: "b", after: [1] }));
    assert.deepEqual(j.task.after, [1]); assert.deepEqual(j.task.blocked_by, [{ id: 1, title: "a", status: "open", who: "" }]);
    assert.deepEqual(tk.calls.findLast(c => c[0] === "add")[2].after, [1]);
    for (const b of [{ title: "c", priority: "very" }, { title: "c", after: { x: 1 } }, { title: "c", after: [99] }]) {
      ({ r, j } = await post("/x/board/api/tasks", b));
      assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(j.error);
    }
    assert.match((await post("/x/board/api/tasks", { title: "c", after: [99] })).j.error, /没有编号 99 的任务/);
    assert.equal(tk.list.length, 2);
  });
  test("the list comes in work order with the new fields; the bot's own task is marked", async () => {
    await seed();
    const { j } = await get("/x/board/api/tasks");
    assert.deepEqual(j.tasks.map(t => t.id), [1, 3, 5, 4, 2]);
    assert.deepEqual(j.tasks.map(t => t.rank), [1, 2, 3, 4, 5]);
    assert.equal(j.bot_busy, 1);
    const by = id => j.tasks.find(t => t.id === id);
    assert.equal(by(1).bot_working, true); assert.equal(by(3).bot_working, false);
    assert.equal(by(3).priority, 1); assert.equal(by(4).priority, 3);
    assert.deepEqual(by(2).after, [1]); assert.deepEqual(by(2).blocked_by, [{ id: 1, title: "调研竞品", status: "doing", who: "bot" }]);
    assert.equal(by(5).parent, 1); assert.equal(by(1).child_count, 1); assert.equal(by(1).material_count, 0);
    const ov = (await get("/x/board/api/overview")).j;
    assert.deepEqual(ov.tasks.list.map(t => t.id), [1, 3, 5, 4, 2]); assert.equal(ov.tasks.bot_busy, 1);
    tk.list[0].status = "done";
    const after = (await get("/x/board/api/tasks?status=open,doing,done")).j.tasks;
    assert.deepEqual(after.map(t => t.id), [3, 2, 5, 4, 1]); assert.deepEqual(after.find(t => t.id === 2).blocked_by, []);
  });
  test("detail carries the whole hand-off package", async () => {
    await seed();
    tk.refs.push({ id: 1, task: 1, conv: "g:a", ts: 5, who: "bot", kind: "quote", title: "群里的原话", ref: "", text: "[11-16 10:00] 小明：帮我调研一下竞品\n<b>不是标签</b>" });
    tk.refs.push({ id: 2, task: 1, conv: "g:a", ts: 6, who: "bot", kind: "report", title: "竞品报告", ref: "", text: "一、价格\n二、功能" });
    tk.refs.push({ id: 3, task: 5, conv: "g:a", ts: 7, who: "bot", kind: "file", title: "价目表", ref: "x12", text: "" });
    let { j } = await get("/x/board/api/tasks/5");
    assert.deepEqual(j.handoff.materials.map(m => [m.id, m.kind, m.from, m.url]), [[3, "file", 0, "/x/board/box/12"], [1, "quote", 1, ""], [2, "report", 1, ""]]);
    assert.equal(j.handoff.materials[1].text, "[11-16 10:00] 小明：帮我调研一下竞品\n<b>不是标签</b>");
    assert.equal(j.handoff.materials[1].label, "原话");
    assert.deepEqual(j.handoff.parent, { id: 1, title: "调研竞品", status: "doing", result: "" });
    assert.match(j.prompt, /get_task 读任务 #5 .*parent 填 5/);
    ({ j } = await get("/x/board/api/tasks/1"));
    assert.deepEqual(j.handoff.children, [{ id: 5, title: "找人问价格", status: "open", owner: "小红" }]);
    assert.equal(j.task.material_count, 2); assert.equal(j.task.bot_working, true);
    ({ j } = await get("/x/board/api/tasks/2"));
    assert.deepEqual(j.handoff.waits_for, [{ id: 1, title: "调研竞品", status: "doing", owner: "bot", result: "" }]); assert.deepEqual(j.handoff.blocked_by, [1]);
  });
  test("priority and prerequisites change; a loop is refused with the sentence from checkAfter", async () => {
    await seed();
    let { r, j } = await post("/x/board/api/tasks/4", { priority: "high" });
    assert.equal(r.status, 200); assert.equal(j.task.priority, 1);
    assert.deepEqual(tk.calls.findLast(c => c[0] === "update"), ["update", "g:a", 4, { priority: 1 }, "小明"]);
    ({ j } = await post("/x/board/api/tasks/4", { after: [3, 2] }));
    assert.deepEqual(j.task.after, [3, 2]); assert.deepEqual(j.task.blocked_by.map(b => b.id), [3, 2]);
    ({ j } = await post("/x/board/api/tasks/4", { after: [] }));
    assert.deepEqual(j.task.after, []); assert.deepEqual(j.task.blocked_by, []);
    const n = tk.calls.filter(c => c[0] === "update").length;
    ({ r, j } = await post("/x/board/api/tasks/1", { after: [2] }));   // 2 already waits for 1
    assert.equal(r.status, 400); assert.equal(j.error, "#2 自己就在等 #1 做完");
    assert.equal((await post("/x/board/api/tasks/1", { after: [42] })).r.status, 400);
    assert.equal((await post("/x/board/api/tasks/1", { priority: 0 })).r.status, 400);
    assert.equal(tk.calls.filter(c => c[0] === "update").length, n);
    assert.deepEqual(tk.list[0].after, []);
  });
  test("materials: a link, a file number, a pasted report; bad ones refused; removing, but never the original words", async () => {
    await seed();
    let { r, j } = await post("/x/board/api/tasks/1/material", { ref: "https://example.com/a?b=1", title: "参考" });
    assert.equal(r.status, 200); assert.deepEqual([j.material.kind, j.material.url, j.material.who], ["link", "https://example.com/a?b=1", "小明"]);
    ({ j } = await post("/x/board/api/tasks/1/material", { ref: "G300" }));
    assert.deepEqual([j.material.kind, j.material.ref, j.material.url], ["file", "g300", "/x/board/img/300"]);
    const long = "第一段\n" + "报".repeat(39000);
    ({ r, j } = await post("/x/board/api/tasks/1/material", { kind: "report", title: "调研报告", text: long }));
    assert.equal(r.status, 200); assert.equal(j.material.text, long); assert.equal(j.materials.length, 3);
    assert.deepEqual(tk.calls.findLast(c => c[0] === "ref"), ["ref", "g:a", 1, { kind: "report", title: "调研报告", ref: "", text: long, who: "小明" }]);
    assert.equal((await post("/x/board/api/tasks/1/material", { ref: "https://x.example" })).r.status, 409);   // the stand-in holds three
    for (const b of [{ ref: "javascript:alert(1)" }, { ref: "" }, { kind: "report", text: "  " }, { kind: "quote", text: "假原话" }, { ref: "ftp://x" }])
      assert.equal((await post("/x/board/api/tasks/1/material", b)).r.status, 400, JSON.stringify(b));
    ({ r, j } = await post("/x/board/api/tasks/1/material/1/remove", {}));
    assert.equal(r.status, 200); assert.deepEqual(j.materials.map(m => m.id), [2, 3]);
    assert.deepEqual(tk.calls.findLast(c => c[0] === "unref"), ["unref", "g:a", 1, 1, "小明"]);
    assert.equal((await post("/x/board/api/tasks/1/material/1/remove", {})).r.status, 404);
    tk.refs.push({ id: 9, task: 1, conv: "g:a", ts: 5, who: "bot", kind: "quote", title: "群里的原话", ref: "", text: "原话" });
    ({ r, j } = await post("/x/board/api/tasks/1/material/9/remove", {}));
    assert.equal(r.status, 400); assert.match(j.error, /原话/); assert.ok(tk.refs.some(x => x.id === 9));
    assert.equal((await post("/x/board/api/tasks/1/material", { text: "长".repeat(210 * 1024) })).r.status, 413);
  });
  test("another conversation can neither read nor change any of it", async () => {
    await seed();
    tk.refs.push({ id: 1, task: 1, conv: "g:a", ts: 5, who: "bot", kind: "report", title: "竞品报告", ref: "", text: "机密" });
    const mark = tk.calls.length;
    assert.equal((await get("/x/board/api/tasks/1", B)).r.status, 404);
    for (const [p, b] of [["/x/board/api/tasks/1", { priority: 1 }], ["/x/board/api/tasks/2", { after: [] }], ["/x/board/api/tasks/1/material", { ref: "https://x.example" }], ["/x/board/api/tasks/1/material/1/remove", {}]])
      assert.equal((await post(p, b, { token: B })).r.status, 404, p);
    assert.equal(tk.calls.filter((c, i) => i >= mark && ["update", "ref", "unref", "checkAfter"].includes(c[0])).length, 0);
    // A's task numbers cannot be used as prerequisites over there either
    await post("/x/board/api/tasks", { title: "B 的事" }, { token: B });
    let { r, j } = await post("/x/board/api/tasks", { title: "B 的第二件", after: [1] }, { token: B });
    assert.equal(r.status, 400); assert.match(j.error, /没有编号 1/);
    ({ r } = await post("/x/board/api/tasks/6", { after: [2] }, { token: B }));
    assert.equal(r.status, 400);
    ({ j } = await get("/x/board/api/tasks", B));
    assert.deepEqual(j.tasks.map(t => t.title), ["B 的事"]); assert.equal(j.bot_busy, 0); assert.equal(j.tasks[0].bot_working, false);
    assert.equal(tk.refs.length, 1); assert.deepEqual(tk.list[1].after, [1]); assert.equal(tk.list[0].priority, 2);
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
    assert.deepEqual(j.tools.map(t => t.name), ["Claude Code", "Codex"]);
    assert.deepEqual(j.tools[1].lines, ["codex mcp add teamagent --url https://bot.example/x/mcp/" + A]);
    assert.equal((await call("/x/board/api/mcp", { token: A })).status, 404);   // not readable with a GET
    const r = await call("/x/board/api/logout", { token: A, json: {} });
    assert.match(r.headers.get("set-cookie"), /^tabd=; Path=\/x\/; Max-Age=0/);
  });
});

describe("overview, teamwork and visual history (added with the page redesign)", () => {
  test("overview gathers the sections for the visitor's conversation only", async () => {
    hub.sql.exec("INSERT INTO day(conv,date,summary) VALUES('g:a','2026-11-14','昨天的事'),('g:a','2026-11-13','前天'),('g:a','2026-11-12','更早'),('g:b','2026-11-14','别的群')");
    await post("/x/board/api/tasks", { title: "我的事", owner: "小明", due: "2000-01-01" });
    await post("/x/board/api/tasks", { title: "别人的事", owner: "小红" });
    await post("/x/board/api/tasks", { title: "别的群" }, { token: B });
    await hub.store.putImage("g:a", new Uint8Array([1]), "image/png", "图");
    await hub.store.putImage("g:b", new Uint8Array([1]), "image/png", "别人的图");
    const { r, j } = await get("/x/board/api/overview");
    assert.equal(r.status, 200);
    assert.deepEqual(j.days.map(d => d.date), ["2026-11-14", "2026-11-13"]);
    assert.deepEqual(j.tasks.list.map(t => t.title), ["我的事", "别人的事"]);
    assert.equal(j.tasks.counts.open, 2); assert.equal(j.tasks.counts.mine, 1); assert.equal(j.tasks.counts.overdue, 1);
    assert.deepEqual(j.images.map(i => i.note), ["图"]); assert.equal(j.images[0].mime, "image/png");
    assert.ok(Array.isArray(j.repos) && Array.isArray(j.uptime));
    assert.ok(j.plan.items.length > 3);
    assert.equal((await call("/x/board/api/overview")).status, 401);
  });
  test("repository history and monitor days are extra fields; old fields stay", async () => {
    const D = 86400000, now = Date.now();
    const sum = ok => JSON.stringify({ v: 1, repo: "TeamAgent", sha: "abc1234def", src: "table", builds: false, steps: [{ id: "root:test", k: "test", s: ok ? "pass" : "fail", t: 1 }] });
    for (const [ago, ok] of [[4, 1], [3, 1], [2, 0], [1, 0]]) hub.sql.exec("INSERT INTO repocheck(repo,ts,sha,ok,summary) VALUES(?,?,?,?,?)", "TeamAgent", now - ago * D, "abc", ok, sum(ok));
    const { j } = await get("/x/board/api/repos");
    const ta = j.repos.find(r => r.repo === "TeamAgent");
    assert.equal(ta.result, "没通过"); assert.ok(ta.steps && ta.checked);
    assert.equal(ta.ok, 0); assert.equal(ta.failing_since, now - 2 * D); assert.equal(ta.last_pass, now - 3 * D);
    assert.deepEqual(ta.history.map(x => x.ok), [1, 1, 0, 0]);
    hub.sql.exec("INSERT INTO uptime(conv,name,url,state,active,created) VALUES('g:a','官网','https://a.example','down',1,?)", now - 10 * D);
    hub.sql.exec("INSERT INTO uptimeinc(target,start,end,error) VALUES(1,?,NULL,'超时')", now - 3600000);
    const m = (await get("/x/board/api/monitors")).j.uptime[0];
    assert.equal(m.days.length, 7); assert.ok(m.days[6].pct < 100); assert.equal(m.days[0].pct, 100);
    assert.ok("uptime_7d" in m && "ms" in m);
  });
});

describe("teamwork endpoints over the real task module", () => {
  beforeEach(async () => {   // the outer beforeEach puts the fake back for every other test
    const T = await import("../src/feat/tasks.ts");
    hub.db.exec(T.default.schema);
    hub.db.exec((await import("../src/feat/teamwork.ts")).SHOP_SCHEMA);
    hub.say = () => {};
    hub.tasksRun = []; hub.runTask = (conv, text) => { hub.tasksRun.push([conv, text]); return Promise.resolve(); };
    for (const k of Object.keys(taskApi)) taskApi[k] = T[k];
  });
  test("size, claim and finish show up in tasks, team, events and the timeline", async () => {
    let { j } = await post("/x/board/api/tasks", { title: "大事", size: "big" });
    assert.equal(j.task.size, "big");
    assert.equal((await post("/x/board/api/tasks/1", { size: "huge" })).r.status, 400);
    await post("/x/board/api/tasks/1/claim", {});
    ({ j } = await post("/x/board/api/tasks/1", { status: "done" }));
    assert.equal(j.task.done_by, "小明"); assert.equal(j.task.points, 30); assert.ok(j.task.done_at > 0 && j.task.claimed_at > 0);
    ({ j } = await get("/x/board/api/team"));
    assert.equal(j.name, "小明"); assert.equal(j.mvp, "小明"); assert.equal(j.week.points, 30);
    assert.equal(j.people[0].badges.find(b => b.key === "boss").earned, true);
    ({ j } = await get("/x/board/api/events"));
    assert.deepEqual(j.events.map(e => e.kind).slice(0, 2), ["done", "claim"]); assert.equal(j.more, false);
    ({ j } = await get("/x/board/api/events?n=1"));
    assert.equal(j.events.length, 1); assert.equal(j.more, true);
    ({ j } = await get("/x/board/api/tasks/1/timeline"));
    assert.equal(j.points, 30); assert.equal(j.done_by, "小明"); assert.ok(j.steps.some(s => s.kind === "done"));
    ({ j } = await get("/x/board/api/overview"));
    assert.equal(j.team.mvp, "小明");
  });
  test("the real module: work order, a refused loop, inherited materials, the bot at work", async () => {
    await post("/x/board/api/tasks", { title: "调研竞品" });
    await post("/x/board/api/tasks", { title: "写方案", after: "1" });
    await post("/x/board/api/tasks", { title: "订会议室", priority: "high" });
    let { r, j } = await post("/x/board/api/tasks/1", { after: [2] });
    assert.equal(r.status, 400); assert.equal(j.error, "#2 自己就在等 #1 做完，这样排两件事会互相等");
    assert.equal((await post("/x/board/api/tasks/3", { after: [3] })).j.error, "任务不能排在自己后面");
    const T = await import("../src/feat/tasks.ts");
    T.claimTask(hub, "g:a", 1, "bot", true); hub.set("tasks:bot:running:g:a", "1");
    T.addTaskRef(hub, "g:a", 1, { kind: "quote", text: "[10:00] 小明：查一下竞品\n<script>x</script>", who: "bot" });
    T.addTask(hub, "g:a", { title: "找人问价格", owner: "小红", parent: 1, by: "bot" }, true);
    ({ j } = await post("/x/board/api/tasks/1/material", { kind: "report", title: "竞品报告", text: "一、价格" }));
    assert.equal(j.material.who, "小明");
    ({ j } = await get("/x/board/api/tasks"));
    assert.deepEqual(j.tasks.map(t => t.title), ["调研竞品", "订会议室", "找人问价格", "写方案"]);
    assert.equal(j.bot_busy, 1); assert.equal(j.tasks[0].bot_working, true); assert.equal(j.tasks[0].child_count, 1); assert.equal(j.tasks[0].material_count, 2);
    assert.deepEqual(j.tasks[3].blocked_by, [{ id: 1, title: "调研竞品", status: "doing", who: "bot" }]);
    ({ j } = await get("/x/board/api/tasks/4"));
    assert.deepEqual(j.handoff.materials.map(m => [m.kind, m.from]), [["quote", 1], ["report", 1]]);
    assert.equal(j.handoff.materials[0].text, "[10:00] 小明：查一下竞品\n<script>x</script>");
    assert.equal(j.handoff.parent.title, "调研竞品"); assert.equal(j.task.parent, 1);
    ({ j } = await post("/x/board/api/tasks/4", { priority: "low", after: [3] }));
    assert.equal(j.task.priority, 3); assert.deepEqual(j.task.after, [3]);
    assert.ok(T.taskNotes(hub, "g:a", 4).some(n => n.who === "小明" && /排在 #3 之后/.test(n.text)));
    ({ j } = await get("/x/board/api/tasks/1", B));
    assert.equal(j.ok, false);
    assert.equal((await post("/x/board/api/tasks/1/material", { ref: "https://x.example" }, { token: B })).r.status, 404);
    assert.equal(T.taskRefs(hub, "g:a", 1).length, 2);
  });
  test("another conversation sees none of it", async () => {
    await post("/x/board/api/tasks", { title: "秘密" });
    await post("/x/board/api/tasks/1/claim", {});
    assert.equal((await get("/x/board/api/tasks/1/timeline", B)).r.status, 404);
    let { j } = await get("/x/board/api/team", B);
    assert.equal(j.people.length, 0); assert.equal(j.totals.doing, 0);
    ({ j } = await get("/x/board/api/events", B));
    assert.equal(j.events.length, 0);
    assert.equal((await call("/x/board/api/team")).status, 401);
  });
  test("redemptions expose receipts and let only the owner settle within the same conversation", async () => {
    let { j } = await post("/x/board/api/tasks", { title: "攒兑换积分", size: "big" });
    await post("/x/board/api/tasks/" + j.task.id + "/claim", {});
    await post("/x/board/api/tasks/" + j.task.id, { status: "done" });
    const request = { item: "draw", note: "画只猫", request_id: crypto.randomUUID() };
    ({ j } = await post("/x/board/api/shop/redeem", request));
    const id = j.spend.id;
    assert.equal(j.spend.state, "pending");
    const retry = await post("/x/board/api/shop/redeem", request);
    assert.equal(retry.j.spend.id, id);
    assert.equal(retry.j.balance, 10);
    assert.equal(hub.tasksRun.length, 1);
    assert.equal((await post("/x/board/api/shop/redeem", { ...request, note: "改画只狗" })).r.status, 400);
    ({ j } = await get("/x/board/api/redemptions?state=pending"));
    assert.equal(j.can_settle, false);
    assert.deepEqual(j.records.map(x => [x.id, x.who, x.balance_after, x.balance]), [[id, "小明", 10, 10]]);
    assert.equal((await post("/x/board/api/redemptions/settle", { id, state: "refunded", by: "群主" })).r.status, 403);
    hub.edit.rank = conv => conv === "g:a" ? "owner" : "trusted";
    assert.equal((await post("/x/board/api/redemptions/settle", { id, state: "refunded" }, { token: B })).r.status, 403);
    ({ j } = await post("/x/board/api/redemptions/settle", { id, state: "refunded" }));
    assert.equal(j.entry.settled_by, "小明");
    assert.ok(j.entry.settled_at > 0);
    assert.equal(j.balance, 30);
    assert.equal((await post("/x/board/api/shop/redeem", request)).j.spend.state, "refunded");
    assert.equal((await post("/x/board/api/redemptions/settle", { id, state: "done" })).r.status, 409);
    ({ j } = await get("/x/board/api/redemptions?state=refunded"));
    assert.equal(j.records[0].balance_after, 10);
    assert.equal(j.records[0].balance, 30);
    assert.deepEqual((await get("/x/board/api/redemptions", B)).j.records, []);
    assert.equal((await call("/x/board/api/redemptions")).status, 401);
  });
  test("wall and shop: points are spent only from the visitor's own balance", async () => {
    await post("/x/board/api/tasks", { title: "屠龙", size: "big" });
    await post("/x/board/api/tasks/1/claim", {});
    await post("/x/board/api/tasks/1", { status: "done" });
    let { r, j } = await get("/x/board/api/shop");
    assert.equal(j.me.balance, 30); assert.ok(j.items.some(i => i.key === "title" && i.needs)); assert.deepEqual(j.mine, []);
    ({ r, j } = await post("/x/board/api/shop/redeem", { item: "title", note: "屠龙勇士", who: "小红", by: "小红" }));
    assert.equal(r.status, 200); assert.equal(j.spend.who, "小明"); assert.equal(j.spend.note, "屠龙勇士"); assert.equal(j.balance, 5); assert.ok(!("do" in j));
    assert.equal(hub.tasksRun.length, 1); assert.equal(hub.tasksRun[0][0], "g:a");
    ({ j } = await get("/x/board/api/shop"));
    assert.equal(j.me.spent, 25); assert.deepEqual(j.mine.map(x => x.item), ["title"]); assert.equal(j.recent.length, 1);
    ({ r, j } = await post("/x/board/api/shop/redeem", { item: "draw", note: "画只猫" }));
    assert.equal(r.status, 400); assert.match(j.error, /还差 15 分/);
    assert.equal((await post("/x/board/api/shop/redeem", { item: "title", note: "这个头衔实在是太长了超过十二个字" })).r.status, 400);
    assert.equal((await post("/x/board/api/shop/redeem", { item: "nope" })).r.status, 400);
    assert.equal((await post("/x/board/api/shop/redeem", {})).r.status, 400);
    assert.equal((await post("/x/board/api/shop/redeem", { item: "meme" }, { headers: { origin: "https://evil.example" } })).r.status, 403);
    assert.equal((await post("/x/board/api/shop/redeem", { item: "meme" }, { headers: { "content-type": "text/plain" } })).r.status, 415);
    assert.equal(hub.tasksRun.length, 1);
    ({ j } = await get("/x/board/api/team"));
    assert.equal(j.people.find(x => x.name === "小明").title, "屠龙勇士");
    ({ j } = await get("/x/board/api/wall"));
    assert.equal(j.current.who, "小明"); assert.deepEqual(j.bosses.map(b => b.title), ["屠龙"]); assert.equal(typeof j.bosses[0].took, "string");
    assert.equal(j.titles[0].title, "屠龙勇士"); assert.ok(j.badges.find(b => b.key === "boss").holders.some(x => x.who === "小明"));
    ({ j } = await get("/x/board/api/overview"));
    assert.equal(j.me.balance, 5); assert.equal(j.latest.kind, "boss"); assert.equal(j.team.people[0].title, "屠龙勇士");
    // another group sees none of it and spends nothing of ours
    ({ j } = await get("/x/board/api/shop", B));
    assert.equal(j.me.balance, 0); assert.deepEqual(j.recent, []);
    ({ r, j } = await post("/x/board/api/shop/redeem", { item: "meme", who: "小明" }, { token: B }));
    assert.equal(r.status, 400);
    ({ j } = await get("/x/board/api/wall", B));
    assert.deepEqual(j.bosses, []); assert.equal(j.current, null); assert.deepEqual(j.titles, []);
    assert.equal((await call("/x/board/api/shop/redeem", { json: { item: "meme" } })).status, 401);
    assert.equal((await call("/x/board/api/wall")).status, 401);
  });
});
