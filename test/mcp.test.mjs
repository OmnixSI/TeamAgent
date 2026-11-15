import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { handleMcp, TOOLS, MODERN, LEGACY } from "../src/feat/mcp.ts";

const A = "a".repeat(40), B = "b".repeat(40), C = "c".repeat(40);
const PEOPLE = { [A]: { conv: "g:1", uid: "u1", name: "小明" }, [B]: { conv: "g:1", uid: "u2", name: "小红" }, [C]: { conv: "g:2", uid: "u3", name: "外人" } };

function mkHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE note(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, text TEXT, ts INTEGER);
    CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT, r2 TEXT, size INTEGER, src TEXT, made TEXT);
    CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, data BLOB, r2 TEXT, size INTEGER, src TEXT);
    CREATE TABLE toolrun(id INTEGER PRIMARY KEY AUTOINCREMENT, turn INTEGER, conv TEXT, ts INTEGER, name TEXT, ms INTEGER, ok INTEGER, args TEXT, error TEXT);`);
  const said = [], cfg = {}, calls = [];
  const hub = {
    db, said, cfg, calls, env: { PUBLIC_URL: "https://w.example", PUBLIC_URL_CN: "https://m.example" },
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    get(k) { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set(k, v) { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); },
    edit: { cfg: (conv, key) => cfg[key] ?? feature.tunables[key].default },
    memoryOf: conv => conv === "g:1" ? "小明在做 WhalePartner。" : "",
    notes: conv => conv === "g:1" ? ["周五聚餐"] : [],
    say: async (conv, text) => { said.push({ conv, text }); return true; },
    store: { bytes: async row => row?.data ? new Uint8Array(row.data) : null },
    tools: conv => [
      { name: "recall", run: async a => { calls.push(["recall", conv, a]); return { hits: [{ text: "上次说要做登录页" }] }; } },
      { name: "search_history", run: async a => { calls.push(["search_history", conv, a]); return { lines: ["小明：登录页"] }; } },
      { name: "repo_health", run: async a => { calls.push(["repo_health", conv, a]); return { repos: [{ name: "TeamAgent", tests: "pass" }] }; } },
    ],
  };
  return hub;
}

// A stand-in for tasks.ts that follows its contract.
function mkDeps() {
  const rows = [], notes = [];
  let n = 0;
  const find = (conv, id) => rows.find(t => t.conv === conv && t.id === id) || null;
  return {
    rows, notes,
    checkAccess: async (_hub, token) => PEOPLE[token] || null,
    listTasks: (_h, conv, f = {}) => rows.filter(t => t.conv === conv && (!f.status || f.status.includes(t.status)) && (!f.owner || t.owner === f.owner)).slice(0, f.limit || 50).map(t => ({ ...t })),
    getTask: (_h, conv, id) => { const t = find(conv, id); return t ? { ...t } : null; },
    addTask: (_h, conv, t) => { const r = { id: ++n, conv, title: t.title, detail: t.detail || "", status: "open", owner: t.owner || "", due: t.due || "", source: t.source || "", by: t.by || "", claimed_by: "", result: "", created: 1, updated: 1 }; rows.push(r); return { ...r }; },
    updateTask: (_h, conv, id, patch, who) => { const t = find(conv, id); if (!t) return null; Object.assign(t, patch); if (patch.status === "open") t.claimed_by = ""; notes.push({ id, who, text: "改了" }); return { ...t }; },
    claimTask: (_h, conv, id, who) => { const t = find(conv, id); if (!t || t.status === "done" || t.status === "dropped" || (t.claimed_by && t.claimed_by !== who)) return null; t.claimed_by = who; t.status = "doing"; return { ...t }; },
    addTaskNote: (_h, conv, id, who, text) => { if (!find(conv, id)) return false; notes.push({ id, who, text, ts: 2 }); return true; },
    taskNotes: (_h, conv, id) => find(conv, id) ? notes.filter(x => x.id === id).map(x => ({ ts: x.ts || 2, who: x.who, text: x.text })) : [],
  };
}

const modernHeaders = (m, name) => ({ "mcp-protocol-version": MODERN[0], "mcp-method": m, ...(name ? { "mcp-name": name } : {}) });
async function post(hub, d, body, { token = A, path, headers = {}, method = "POST" } = {}) {
  const url = "https://w.example" + (path ?? "/x/mcp/" + token);
  const req = new Request(url, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const res = await handleMcp(hub, req, new URL(url), d);
  const text = res ? await res.text() : "";
  return { res, status: res?.status, json: text ? JSON.parse(text) : null };
}
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
async function call(hub, d, name, args = {}, opt = {}) {
  const r = await post(hub, d, rpc("tools/call", { name, arguments: args }), opt);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const res = r.json.result, text = res.content[0].text;
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { isError: !!res.isError, data, text, content: res.content };
}

test("legacy lifecycle: initialize, initialized, tools/list, tools/call, ping", async () => {
  const hub = mkHub(), d = mkDeps();
  const init = await post(hub, d, rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } }));
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.json.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.json.result.serverInfo.name, "teamagent");
  assert.match(init.json.result.instructions, /claim_task/);
  assert.equal(init.res.headers.get("mcp-session-id"), null);
  assert.equal(init.res.headers.get("content-type"), "application/json");
  const note = await post(hub, d, { jsonrpc: "2.0", method: "notifications/initialized" }, { headers: { "mcp-protocol-version": "2025-06-18" } });
  assert.equal(note.status, 202); assert.equal(note.json, null);
  const list = await post(hub, d, rpc("tools/list", {}, 2), { headers: { "mcp-protocol-version": "2025-06-18" } });
  const names = list.json.result.tools.map(t => t.name);
  assert.deepEqual(names, ["list_tasks", "get_task", "claim_task", "report_progress", "complete_task", "release_task", "add_task", "search_chat", "get_memory", "list_files", "get_file", "repo_status", "notify_group"]);
  for (const t of list.json.result.tools) { assert.equal(t.inputSchema.type, "object"); assert.ok(t.description.length > 40); assert.equal(t.run, undefined); }
  assert.equal(list.json.result.resultType, undefined);
  assert.deepEqual((await post(hub, d, rpc("ping", undefined, 3))).json, { jsonrpc: "2.0", id: 3, result: {} });
  const r = await call(hub, d, "list_tasks");
  assert.equal(r.isError, false); assert.equal(r.data.count, 0);
});

test("version negotiation: legacy down to what we speak, modern per request", async () => {
  const hub = mkHub(), d = mkDeps();
  assert.equal((await post(hub, d, rpc("initialize", { protocolVersion: "2099-01-01" }))).json.result.protocolVersion, LEGACY[0]);
  assert.equal((await post(hub, d, rpc("initialize", { protocolVersion: "2024-11-05" }))).json.result.protocolVersion, LEGACY[0]);
  assert.equal((await post(hub, d, rpc("initialize", { protocolVersion: "2025-03-26" }))).json.result.protocolVersion, "2025-03-26");
  const meta = v => ({ _meta: { "io.modelcontextprotocol/protocolVersion": v, "io.modelcontextprotocol/clientInfo": { name: "x", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} } });
  const disc = await post(hub, d, rpc("server/discover", meta(MODERN[0])), { headers: modernHeaders("server/discover") });
  assert.equal(disc.status, 200);
  assert.equal(disc.json.result.resultType, "complete");
  assert.deepEqual(disc.json.result.supportedVersions, [...MODERN, ...LEGACY]);
  assert.equal(disc.json.result._meta["io.modelcontextprotocol/serverInfo"].name, "teamagent");
  const list = await post(hub, d, rpc("tools/list", meta(MODERN[0])), { headers: modernHeaders("tools/list") });
  assert.equal(list.json.result.resultType, "complete"); assert.equal(list.json.result.tools.length, TOOLS.length);
  const tc = await post(hub, d, rpc("tools/call", { name: "get_memory", arguments: {}, ...meta(MODERN[0]) }), { headers: modernHeaders("tools/call", "get_memory") });
  assert.equal(tc.json.result.resultType, "complete"); assert.match(tc.json.result.content[0].text, /WhalePartner/);
  // Base64 sentinel in Mcp-Name is decoded before comparing.
  const enc = await post(hub, d, rpc("tools/call", { name: "get_memory", arguments: {}, ...meta(MODERN[0]) }), { headers: modernHeaders("tools/call", "=?base64?" + btoa("get_memory") + "?=") });
  assert.equal(enc.status, 200);
  const unsup = await post(hub, d, rpc("tools/list", meta("2099-01-01")), { headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "2099-01-01" } });
  assert.equal(unsup.status, 400); assert.equal(unsup.json.error.code, -32022);
  assert.deepEqual(unsup.json.error.data, { supported: [...MODERN, ...LEGACY], requested: "2099-01-01" });
  const mismatch = await post(hub, d, rpc("tools/list", meta(MODERN[0])), { headers: { ...modernHeaders("tools/list"), "mcp-protocol-version": "2025-11-25" } });
  assert.equal(mismatch.status, 400); assert.equal(mismatch.json.error.code, -32020);
  const noMethod = await post(hub, d, rpc("tools/list", meta(MODERN[0])), { headers: { "mcp-protocol-version": MODERN[0] } });
  assert.equal(noMethod.status, 400); assert.equal(noMethod.json.error.code, -32020);
  const wrongName = await post(hub, d, rpc("tools/call", { name: "get_memory", ...meta(MODERN[0]) }), { headers: modernHeaders("tools/call", "list_tasks") });
  assert.equal(wrongName.json.error.code, -32020);
  const unknown = await post(hub, d, rpc("nope/nope", meta(MODERN[0])), { headers: modernHeaders("nope/nope") });
  assert.equal(unknown.status, 404); assert.equal(unknown.json.error.code, -32601);
  // A modern header without _meta, or an unknown version header on a legacy-style request.
  assert.equal((await post(hub, d, rpc("tools/list"), { headers: modernHeaders("tools/list") })).json.error.code, -32020);
  const odd = await post(hub, d, rpc("tools/list"), { headers: { "mcp-protocol-version": "2099-01-01" } });
  assert.equal(odd.status, 400); assert.equal(odd.json.error.code, -32022);
});

test("batches, notifications, malformed JSON, invalid requests, unknown method", async () => {
  const hub = mkHub(), d = mkDeps();
  const batch = await post(hub, d, [rpc("ping", undefined, 1), { jsonrpc: "2.0", method: "notifications/initialized" }, rpc("tools/list", {}, 2), rpc("bogus", {}, 3)]);
  assert.equal(batch.status, 200);
  assert.deepEqual(batch.json.map(x => x.id), [1, 2, 3]);
  assert.equal(batch.json[2].error.code, -32601);
  assert.equal((await post(hub, d, [{ jsonrpc: "2.0", method: "notifications/initialized" }])).status, 202);
  assert.equal((await post(hub, d, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).status, 202);
  assert.equal((await post(hub, d, { jsonrpc: "2.0", id: 9, result: {} })).status, 202);
  const bad = await post(hub, d, "{not json");
  assert.equal(bad.status, 400); assert.deepEqual(bad.json, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  assert.equal((await post(hub, d, [])).json.error.code, -32600);
  assert.equal((await post(hub, d, { id: 1, method: "ping" })).json.error.code, -32600);
  assert.equal((await post(hub, d, { jsonrpc: "2.0", id: 1, method: 5 })).json.error.code, -32600);
  assert.equal((await post(hub, d, { jsonrpc: "2.0", id: 1, method: "ping", params: "x" })).json.error.code, -32602);
  const unk = await post(hub, d, rpc("resources/list", {}, 4));
  assert.equal(unk.status, 200); assert.equal(unk.json.error.code, -32601);
  assert.equal((await post(hub, d, rpc("tools/call", { name: "rm_rf" }))).json.error.code, -32602);
  assert.equal((await post(hub, d, rpc("tools/call", { arguments: {} }))).json.error.code, -32602);
  assert.equal((await post(hub, d, rpc("tools/call", { name: "get_task", arguments: [1] }))).json.error.code, -32602);
  // Argument problems are tool errors the model can fix.
  const miss = await call(hub, d, "get_task", {});
  assert.equal(miss.isError, true); assert.match(miss.text, /缺少参数 id/);
  assert.match((await call(hub, d, "get_task", { id: "x" })).text, /整数/);
  assert.match((await call(hub, d, "list_tasks", { status: "later" })).text, /只能是/);
  assert.match((await call(hub, d, "list_tasks", { colour: 1 })).text, /不认识参数/);
});

test("tokens: path, bearer, unknown → 401; GET/DELETE → 405; foreign Origin → 403; other paths are not ours", async () => {
  const hub = mkHub(), d = mkDeps();
  const bad = await post(hub, d, rpc("ping"), { token: "f".repeat(40) });
  assert.equal(bad.status, 401); assert.equal(bad.json.jsonrpc, "2.0"); assert.equal(bad.json.id, null); assert.ok(bad.json.error.message);
  assert.match(bad.res.headers.get("www-authenticate"), /^Bearer/);
  assert.equal((await post(hub, d, rpc("ping"), { path: "/x/mcp" })).status, 401);
  assert.equal((await post(hub, d, rpc("ping"), { path: "/x/mcp", headers: { authorization: "Bearer " + A } })).status, 200);
  assert.equal((await post(hub, d, rpc("ping"), { path: "/x/mcp/", headers: { authorization: "Bearer " + B } })).status, 200);
  const r = await call(hub, d, "list_tasks", {}, { path: "/x/mcp", headers: { authorization: "Bearer " + B } });
  assert.equal(r.data.you_work_for, "小红");
  assert.equal((await post(hub, d, null, { method: "GET" })).status, 405);
  assert.equal((await post(hub, d, null, { method: "DELETE" })).status, 405);
  assert.equal((await post(hub, d, rpc("ping"), { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await post(hub, d, rpc("ping"), { headers: { origin: "https://m.example" } })).status, 200);
  assert.equal(await handleMcp(hub, new Request("https://w.example/x/board"), new URL("https://w.example/x/board"), d), null);
  assert.equal(await handleMcp(hub, new Request("https://w.example/x/mcpx"), new URL("https://w.example/x/mcpx"), d), null);
});

test("task tools: claim, conflicts, progress, complete, release, add", async () => {
  const hub = mkHub(), d = mkDeps();
  const added = await call(hub, d, "add_task", { title: "做登录页", detail: "用 OAuth", owner: "小明", due: "2026-11-20" });
  assert.equal(added.isError, false);
  assert.equal(d.rows[0].by, "小明的本地 AI"); assert.equal(d.rows[0].source, "本地 AI");
  assert.match((await call(hub, d, "add_task", { title: "x", due: "下周" })).text, /2026-11-20/);
  d.addTask(hub, "g:1", { title: "写周报", owner: "小红" });
  d.addTask(hub, "g:1", { title: "已经做完的" }); d.rows[2].status = "done";

  assert.equal((await call(hub, d, "list_tasks")).data.count, 2);
  assert.equal((await call(hub, d, "list_tasks", { status: "all" })).data.count, 3);
  assert.deepEqual((await call(hub, d, "list_tasks", { mine: true })).data.tasks.map(t => t.id), [1]);
  assert.deepEqual((await call(hub, d, "list_tasks", { owner: "小红" })).data.tasks.map(t => t.id), [2]);

  const claim = await call(hub, d, "claim_task", { id: 1 });
  assert.equal(claim.isError, false); assert.equal(claim.data.task.status, "doing"); assert.equal(claim.data.task.claimed_by, "小明的本地 AI");
  assert.equal((await call(hub, d, "claim_task", { id: 1 })).data.note, "这个任务本来就是你领的");
  const taken = await call(hub, d, "claim_task", { id: 1 }, { token: B });
  assert.equal(taken.isError, true); assert.match(taken.text, /已经被小明的本地 AI领了/);
  assert.match((await call(hub, d, "claim_task", { id: 3 })).text, /已经做完了/);
  assert.match((await call(hub, d, "claim_task", { id: 99 })).text, /没有 #99/);

  assert.equal((await call(hub, d, "report_progress", { id: 1, text: "页面搭好了" })).isError, false);
  assert.equal((await call(hub, d, "report_progress", { id: 1, text: "我看了一下" }, { token: B })).isError, false);
  assert.match((await call(hub, d, "report_progress", { id: 1, text: "长".repeat(2001) })).text, /2000/);
  const got = await call(hub, d, "get_task", { id: 1 });
  assert.deepEqual(got.data.notes.map(n => n.who), ["小明的本地 AI", "小红的本地 AI"]);
  assert.equal(got.data.detail, "用 OAuth");

  // Someone else's claimed task cannot be completed or released; unclaimed or own can.
  const other = await call(hub, d, "complete_task", { id: 1, result: "我做好了" }, { token: B });
  assert.equal(other.isError, true); assert.match(other.text, /只有他能交付/);
  assert.match((await call(hub, d, "release_task", { id: 1 }, { token: B })).text, /不是你的/);
  const done = await call(hub, d, "complete_task", { id: 1, result: "登录页做好了", links: ["https://github.com/x/pull/3"] });
  assert.equal(done.isError, false);
  assert.equal(d.rows[0].status, "done"); assert.equal(d.rows[0].result, "登录页做好了\nhttps://github.com/x/pull/3");
  assert.match((await call(hub, d, "complete_task", { id: 1, result: "again" })).text, /已经做完了/);
  const unclaimed = await call(hub, d, "complete_task", { id: 2, result: "周报写好了" }, { token: B });
  assert.equal(unclaimed.isError, false);

  const t4 = d.addTask(hub, "g:1", { title: "调研" });
  await call(hub, d, "claim_task", { id: t4.id }, { token: B });
  assert.match((await call(hub, d, "release_task", { id: t4.id })).text, /是小红的本地 AI领的/);
  const rel = await call(hub, d, "release_task", { id: t4.id, reason: "没时间" }, { token: B });
  assert.equal(rel.isError, false); assert.equal(rel.data.task.status, "open"); assert.equal(d.rows[3].claimed_by, "");
  assert.ok(d.notes.some(n => n.text === "退回：没时间"));
  assert.match((await call(hub, d, "release_task", { id: t4.id }, { token: B })).text, /没人领/);
  // Every call is in the tool log.
  assert.ok(hub.db.prepare("SELECT COUNT(*) n FROM toolrun WHERE name LIKE 'mcp:%'").get().n > 10);
});

test("conversation isolation: tasks, files, memory and searches stay in the token's group", async () => {
  const hub = mkHub(), d = mkDeps();
  d.addTask(hub, "g:1", { title: "群一的任务" });
  hub.db.prepare("INSERT INTO blob(conv,ts,name,data,size) VALUES(?,?,?,?,?)").run("g:1", 1, "notes.md", new Uint8Array(new TextEncoder().encode("# 计划\n第一步")), 13);
  hub.db.prepare("INSERT INTO img(conv,ts,mime,note,data,size) VALUES(?,?,?,?,?,?)").run("g:1", 2, "image/png", "登录页截图", new Uint8Array([137, 80, 78, 71]), 4);
  const out = { token: C };
  assert.equal((await call(hub, d, "list_tasks", { status: "all" }, out)).data.count, 0);
  assert.match((await call(hub, d, "get_task", { id: 1 }, out)).text, /没有 #1/);
  assert.match((await call(hub, d, "claim_task", { id: 1 }, out)).text, /没有 #1/);
  assert.equal((await call(hub, d, "list_files", {}, out)).data.count, 0);
  assert.match((await call(hub, d, "get_file", { ref: "f1" }, out)).text, /没有 f1/);
  assert.match((await call(hub, d, "get_file", { ref: "g1" }, out)).text, /没有 g1/);
  assert.equal((await call(hub, d, "get_memory", {}, out)).text, "这个群还没有长期记忆。");
  await call(hub, d, "search_chat", { query: "登录" }, out);
  assert.ok(hub.calls.every(c => c[1] === "g:2"));
  assert.equal(d.rows[0].claimed_by, "");
});

test("lookup tools: memory, files, search, repo status", async () => {
  const hub = mkHub(), d = mkDeps();
  hub.db.prepare("INSERT INTO blob(conv,ts,name,data,size) VALUES(?,?,?,?,?)").run("g:1", 1, "notes.md", new TextEncoder().encode("# 计划\n第一步"), 13);
  hub.db.prepare("INSERT INTO blob(conv,ts,name,r2,size) VALUES(?,?,?,?,?)").run("g:1", 3, "video.mp4", "blob/2", 30_000_000);
  hub.db.prepare("INSERT INTO img(conv,ts,mime,note,data,size) VALUES(?,?,?,?,?,?)").run("g:1", 2, "image/png", "登录页截图", new Uint8Array([137, 80, 78, 71]), 4);
  hub.db.prepare("INSERT INTO img(conv,ts,mime,note,name,data,size) VALUES(?,?,?,?,?,?,?)").run("g:1", 4, "image/png", "开心", "sticker:happy", new Uint8Array([1]), 1);
  const mem = await call(hub, d, "get_memory");
  assert.match(mem.text, /WhalePartner/); assert.match(mem.text, /周五聚餐/);
  const files = await call(hub, d, "list_files");
  assert.deepEqual(files.data.items.map(x => x.ref), ["f2", "g1", "f1"]);
  assert.deepEqual((await call(hub, d, "list_files", { kind: "images" })).data.items.map(x => x.ref), ["g1"]);
  assert.deepEqual((await call(hub, d, "list_files", { query: "截图" })).data.items.map(x => x.ref), ["g1"]);
  const md = await call(hub, d, "get_file", { ref: "f1" });
  assert.equal(md.data.content, "# 计划\n第一步");
  const big = await call(hub, d, "get_file", { ref: "f2" });
  assert.equal(big.data.content, undefined);
  assert.equal(big.data.download, "https://w.example/x/board/file/2");
  assert.ok(big.data.curl.includes("Authorization: Bearer " + A));
  const pic = await call(hub, d, "get_file", { ref: "g1" });
  assert.equal(pic.content[1].type, "image"); assert.equal(pic.content[1].mimeType, "image/png");
  assert.equal(JSON.parse(pic.content[0].text).download, "https://w.example/x/board/img/1");
  assert.match((await call(hub, d, "get_file", { ref: "12" })).text, /f12/);

  const s = await call(hub, d, "search_chat", { query: "登录页", days: 7 });
  assert.ok(s.data.by_meaning.hits && s.data.by_words.lines);
  assert.deepEqual(hub.calls.slice(0, 2).map(c => [c[0], c[2]]), [["recall", { query: "登录页", days: 7 }], ["search_history", { query: "登录页", days: 7 }]]);
  await call(hub, d, "search_chat", { query: "x", mode: "words" });
  assert.equal(hub.calls.at(-1)[0], "search_history");
  const repo = await call(hub, d, "repo_status", { repo: "TeamAgent" });
  assert.equal(repo.data.repos[0].tests, "pass");
  assert.deepEqual(hub.calls.at(-1), ["repo_health", "g:1", { op: "last", repo: "TeamAgent" }]);
});

test("notify_group: prefixed, 500 characters, rate limited per person", async () => {
  const hub = mkHub(), d = mkDeps();
  const r = await call(hub, d, "notify_group", { text: "任务 #12 做完了：登录页上线" });
  assert.equal(r.isError, false);
  assert.deepEqual(hub.said, [{ conv: "g:1", text: "【小明的本地 AI】任务 #12 做完了：登录页上线" }]);
  assert.match((await call(hub, d, "notify_group", { text: "长".repeat(501) })).text, /500/);
  assert.match((await call(hub, d, "notify_group", { text: "好了", task: 77 })).text, /没有 #77/);
  hub.cfg.mcp_notify_daily = 6;
  for (let i = 0; i < 5; i++) assert.equal((await call(hub, d, "notify_group", { text: "进展 " + i })).isError, false);
  const over = await call(hub, d, "notify_group", { text: "再来一条" });
  assert.equal(over.isError, true); assert.match(over.text, /6 条/);
  assert.equal(hub.said.length, 6);
  assert.equal((await call(hub, d, "notify_group", { text: "我的第一条" }, { token: B })).isError, false);   // per person
  hub.cfg.mcp_notify_daily = 0;
  assert.equal((await call(hub, d, "notify_group", { text: "x" }, { token: B })).isError, true);
});

test("daily call cap per person", async () => {
  const hub = mkHub(), d = mkDeps();
  hub.cfg.mcp_calls_daily = 3;
  for (let i = 0; i < 3; i++) assert.equal((await call(hub, d, "list_tasks")).isError, false);
  const over = await call(hub, d, "list_tasks");
  assert.equal(over.isError, true); assert.match(over.text, /上限/);
  assert.equal((await call(hub, d, "list_tasks", {}, { token: B })).isError, false);
  assert.equal((await post(hub, d, rpc("tools/list"))).status, 200);   // listing is not counted
});

test("body size limit", async () => {
  const hub = mkHub(), d = mkDeps();
  const big = JSON.stringify(rpc("tools/call", { name: "report_progress", arguments: { id: 1, text: "x".repeat(1024 * 1024) } }));
  const r = await post(hub, d, big);
  assert.equal(r.status, 413); assert.equal(r.json.error.code, -32600);
  // Without a content-length header the stream is cut off as well.
  const url = "https://w.example/x/mcp/" + A;
  const stream = new ReadableStream({ start(c) { for (let i = 0; i < 3; i++) c.enqueue(new Uint8Array(512 * 1024)); c.close(); } });
  const res = await handleMcp(hub, new Request(url, { method: "POST", body: stream, duplex: "half" }), new URL(url), d);
  assert.equal(res.status, 413);
});

test("feature shape", () => {
  assert.equal(feature.name, "mcp");
  assert.equal(feature.tunables.mcp_notify_daily.default, 30);
  assert.equal(feature.tunables.mcp_calls_daily.default, 500);
  assert.ok(feature.about.length >= 3);
  assert.equal(typeof feature.open, "function");
});
