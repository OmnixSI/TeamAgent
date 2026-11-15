import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import feature, { listTasks, getTask, addTask, updateTask, claimTask, addTaskNote, taskNotes, sameTask, normDue, extractDay, nightlyConvs, remind, deps } from "../src/feat/tasks.ts";

function mkHub(cfg = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(feature.schema);
  db.exec("CREATE TABLE msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, conv TEXT, role TEXT, sender TEXT, name TEXT, text TEXT, ts INTEGER, mentioned INTEGER DEFAULT 0, meta TEXT)");
  const kv = new Map(), said = [], waits = [];
  const defaults = Object.fromEntries(Object.entries(feature.tunables).map(([k, t]) => [k, t.default]));
  return {
    db, kv, said, waits, env: {},
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*SELECT/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => kv.set(k, String(v)),
    edit: { cfg: (conv, key) => cfg[conv + ":" + key] ?? cfg[key] ?? defaults[key] },
    ctx: { waitUntil: p => waits.push(p) },
    say: async (conv, text) => { said.push({ conv, text }); return true; },
  };
}
const G = "g:1";
const tool = (hub, askers = []) => feature.tools({ hub, conv: G, askers, host: {} })[0];
const DAY = "2026-11-14", at = (hh, mm = 0) => Date.parse(DAY + "T00:00:00+08:00") + (hh * 60 + mm) * 60000;
function say(hub, conv, name, text, ts) { hub.db.prepare("INSERT INTO msg(conv,role,sender,name,text,ts) VALUES(?,?,?,?,?,?)").run(conv, name === "Bot" ? "bot" : "user", name === "Bot" ? "" : "u" + name, name, text, ts); }
const fake = answer => { const calls = []; deps.model = async (hub, system, user) => { calls.push({ system, user }); return { text: typeof answer === "string" ? answer : JSON.stringify(answer), usage: { prompt_tokens: 9000, completion_tokens: 700 } }; }; return calls; };

test("add, get, list with filters, and the order (doing, open, done, dropped)", () => {
  const hub = mkHub();
  assert.equal(addTask(hub, G, { title: "  " }), null);
  const a = addTask(hub, G, { title: "改完登录页", owner: "小明", due: "2026-11-16", source: "我明天把登录页改完", by: "小明" });
  assert.equal(a.status, "open"); assert.equal(a.by, "小明"); assert.equal(a.due, "2026-11-16"); assert.equal(a.claimed_by, "");
  const b = addTask(hub, G, { title: "交报告", owner: "小红", due: "不知道" });
  assert.equal(b.due, "");
  addTask(hub, "g:2", { title: "别的群的事" });
  assert.equal(listTasks(hub, G).length, 2);
  assert.equal(getTask(hub, "g:2", a.id), null, "tasks are scoped by conversation");
  claimTask(hub, G, b.id, "小红");
  assert.deepEqual(listTasks(hub, G).map(t => t.title), ["交报告", "改完登录页"]);
  assert.deepEqual(listTasks(hub, G, { status: ["open"] }).map(t => t.id), [a.id]);
  assert.deepEqual(listTasks(hub, G, { owner: "小明" }).map(t => t.id), [a.id]);
  assert.equal(listTasks(hub, G, { limit: 1 }).length, 1);
  assert.match(taskNotes(hub, G, a.id)[0].text, /记下了这件事：“我明天把登录页改完”/);
});

test("updateTask records a note per change, skips no-ops, and returns null for missing tasks", () => {
  const hub = mkHub(), t = addTask(hub, G, { title: "写周报", by: "小明" });
  assert.equal(updateTask(hub, G, 999, { title: "x" }), null);
  const u = updateTask(hub, G, t.id, { owner: "小红", due: "11-20", status: "doing", title: "写周报" }, "小明");
  assert.equal(u.owner, "小红"); assert.equal(u.status, "doing"); assert.match(u.due, /^\d{4}-11-20$/);
  const notes = taskNotes(hub, G, t.id);
  assert.equal(notes.length, 4);
  assert.ok(notes.slice(1).every(n => n.who === "小明"));
  assert.ok(notes.some(n => n.text === "状态：没开始 → 在做"));
  updateTask(hub, G, t.id, { owner: "小红" }, "小明");
  assert.equal(taskNotes(hub, G, t.id).length, 4, "an unchanged field writes no note");
  updateTask(hub, G, t.id, { status: "nonsense" }, "x");
  assert.equal(getTask(hub, G, t.id).status, "doing");
});

test("claimTask: open moves to doing; same claimant again is fine; others and finished tasks are refused", () => {
  const hub = mkHub(), t = addTask(hub, G, { title: "搭测试环境" });
  assert.equal(claimTask(hub, G, 999, "小明"), null);
  assert.equal(claimTask(hub, G, t.id, ""), null);
  const c = claimTask(hub, G, t.id, "小明");
  assert.equal(c.claimed_by, "小明"); assert.equal(c.status, "doing");
  assert.ok(claimTask(hub, G, t.id, "小明"));
  assert.equal(claimTask(hub, G, t.id, "本地 AI"), null);
  assert.equal(getTask(hub, G, t.id).claimed_by, "小明");
  const d = addTask(hub, G, { title: "另一件" });
  updateTask(hub, G, d.id, { status: "done" });
  assert.equal(claimTask(hub, G, d.id, "小明"), null);
  const e = addTask(hub, G, { title: "第三件" });
  updateTask(hub, G, e.id, { status: "dropped" });
  assert.equal(claimTask(hub, G, e.id, "小明"), null);
});

test("addTaskNote and taskNotes", () => {
  const hub = mkHub(), t = addTask(hub, G, { title: "整理照片" });
  assert.equal(addTaskNote(hub, G, t.id, "小明", "整理了一半"), true);
  assert.equal(addTaskNote(hub, G, t.id, "小明", "   "), false);
  assert.equal(addTaskNote(hub, G, 999, "小明", "x"), false);
  assert.equal(addTaskNote(hub, "g:2", t.id, "小明", "x"), false);
  const n = taskNotes(hub, G, t.id);
  assert.deepEqual(n.map(x => x.text).slice(-1), ["整理了一半"]);
  assert.equal(typeof n[0].ts, "number");
});

test("due dates and title matching", () => {
  const now = Date.parse("2026-11-15T10:00:00+08:00");
  assert.equal(normDue("明天", now), "2026-11-16");
  assert.equal(normDue("2026/11/20", now), "2026-11-20");
  assert.equal(normDue("11月20日", now), "2026-11-20");
  assert.equal(normDue("1-5", now), "2027-01-05");
  assert.equal(normDue("2026-02-30", now), "");
  assert.equal(normDue("周五", now), "");
  assert.ok(sameTask("改完登录页", "把登录页改完！"));
  assert.ok(sameTask("交报告", "交报告。"));
  assert.ok(sameTask("周五前交季度报告", "交季度报告"));
  assert.ok(!sameTask("改完登录页", "交季度报告"));
});

test("the tool: add de-duplicates, list filters, update/done/drop/note/claim/show, without any permission", async () => {
  const hub = mkHub(), t = tool(hub, [{ id: "u1", name: "小明" }]), anon = tool(hub);
  const a = await t.run({ op: "add", title: "改完登录页", owner: "小明", due: "2026-11-16", source: "我明天把登录页改完" });
  assert.equal(a.ok, true);
  const id = a.added.id;
  const dup = await anon.run({ op: "add", title: "把登录页改完" });
  assert.equal(dup.duplicate, true); assert.equal(dup.task.id, id);
  assert.equal(listTasks(hub, G).length, 1);
  assert.equal((await anon.run({ op: "add", title: "周五前交报告" })).ok, true);
  assert.equal(getTask(hub, G, id + 1).by, "bot");
  assert.equal((await t.run({ op: "list" })).count, 2);
  assert.equal((await t.run({ op: "list", mine: true })).count, 1);
  assert.equal((await anon.run({ op: "list", mine: true })).ok, false);
  assert.equal((await anon.run({ op: "list", owner: "小明" })).count, 1);
  assert.equal((await anon.run({ op: "update", id, due: "周八" })).ok, false);
  assert.equal((await anon.run({ op: "update", id, status: "later" })).ok, false);
  assert.equal((await anon.run({ op: "update", id, detail: "手机版也要" })).ok, true);
  assert.equal((await anon.run({ op: "note", id, text: "改了一半" })).ok, true);
  const claimed = await tool(hub, [{ id: "u2", name: "小红" }]).run({ op: "claim", id: id + 1 });
  assert.equal(claimed.task.claimed_by, "小红");
  const refused = await t.run({ op: "claim", id: id + 1 });
  assert.equal(refused.ok, false); assert.match(refused.error, /小红/);
  const done = await anon.run({ op: "done", id, result: "已上线 https://x.example" });
  assert.equal(done.task.status, "做完了");
  assert.equal((await t.run({ op: "list" })).count, 1);
  assert.equal((await t.run({ op: "list", status: "done" })).count, 1);
  const dropped = await anon.run({ op: "drop", id: id + 1, reason: "老师说不用交了" });
  assert.equal(dropped.task.status, "不做了");
  const show = await anon.run({ op: "show", id: id + 1 });
  assert.ok(show.history.some(h => h.what === "不做的原因：老师说不用交了"));
  assert.equal((await anon.run({ op: "show", id: 77 })).ok, false);
  assert.equal((await anon.run({ op: "show" })).ok, false);
  const s = (await anon.run({ op: "show", id })).history.map(h => h.what);
  assert.ok(s.includes("补充说明：手机版也要") && s.includes("改了一半") && s.some(x => x.startsWith("结果：已上线")));
});

function seedDay(hub, conv = G) {
  say(hub, conv, "小明", "我明天把登录页改完", at(10));
  say(hub, conv, "小红", "周五前要交季度报告，我来写", at(11));
  say(hub, conv, "小刚", "要是能去滑雪就好了", at(12));
  say(hub, conv, "小明", "接口文档我已经写好了，放群文件了", at(14));
  say(hub, conv, "小红", "海报那个先不做了", at(15));
  say(hub, conv, "Bot", "好的", at(15, 1));
  say(hub, conv, "小明", "哈哈哈", at(23, 59));
  say(hub, conv, "小明", "第二天的话：我去把服务器续费", at(24, 1));
}

test("extraction applies adds, finishes and drops from the model answer, grounded in real quotes", async () => {
  const hub = mkHub();
  seedDay(hub);
  const doc = addTask(hub, G, { title: "写接口文档", owner: "小明" });
  const poster = addTask(hub, G, { title: "做海报", owner: "小红" });
  const login = addTask(hub, G, { title: "改完登录页", owner: "小明" });
  hub.said.length = 0;   // the setup above speaks; the extraction below must not
  const calls = fake({
    new: [
      { title: "写季度报告", owner: "小红", due: "2026-11-20", quote: "周五前要交季度报告" },
      { title: "把登录页改完", owner: "小明", quote: "我明天把登录页改完" },                   // already on the list
      { title: "去滑雪", owner: "小刚", quote: "我们周末一起去滑雪吧" },                        // not said
      { title: "续费服务器", owner: "小明", quote: "我去把服务器续费" },                        // said the next day
      { title: "写季度报告。", owner: "小红", quote: "我来写" },                                // repeated in the same night (and too short to ground anyway)
    ],
    done: [{ id: doc.id, result: "放在群文件", quote: "接口文档我已经写好了" }, { id: 999, quote: "接口文档我已经写好了" }],
    dropped: [{ id: poster.id, quote: "海报那个先不做了" }, { id: login.id, quote: "登录页不做了" }],
  });
  const dry = await extractDay(hub, G, DAY, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].user, /#\d+ 写接口文档（小明）/);
  assert.match(calls[0].user, /\[10:00\] 小明：我明天把登录页改完/);
  assert.ok(!calls[0].user.includes("服务器续费"), "only that Beijing day is read");
  assert.deepEqual(dry.added.map(a => a.title), ["写季度报告"]);
  assert.deepEqual(dry.finished.map(f => f.id), [doc.id]);
  assert.deepEqual(dry.dropped.map(f => f.id), [poster.id]);
  assert.ok(dry.skipped.some(s => s.what === "去滑雪" && /原话/.test(s.why)));
  assert.ok(dry.skipped.some(s => s.what === "把登录页改完" && /已有/.test(s.why)));
  assert.equal(dry.tokens.input, 9000);
  assert.equal(listTasks(hub, G).length, 3, "a dry run changes nothing");
  assert.equal(getTask(hub, G, doc.id).status, "open");

  const real = await extractDay(hub, G, DAY, false);
  const report = listTasks(hub, G).find(t => t.title === "写季度报告");
  assert.equal(report.by, "夜间整理"); assert.equal(report.source, "周五前要交季度报告"); assert.equal(report.due, "2026-11-20"); assert.equal(report.owner, "小红");
  assert.equal(real.added[0].id, report.id);
  assert.equal(getTask(hub, G, doc.id).status, "done"); assert.equal(getTask(hub, G, doc.id).result, "放在群文件");
  assert.equal(getTask(hub, G, poster.id).status, "dropped");
  assert.equal(getTask(hub, G, login.id).status, "open");
  assert.ok(taskNotes(hub, G, doc.id).some(n => n.who === "夜间整理" && n.text.includes("接口文档我已经写好了")));
  assert.equal(JSON.parse(hub.get("tasks:extract:last:" + G)).added, 1);
  assert.equal(hub.said.length, 0, "nothing is announced in the group");
});

test("the nightly cap, bad answers, and quiet days", async () => {
  const hub = mkHub({ tasks_nightly_max: 2 });
  for (let i = 0; i < 5; i++) say(hub, G, "小明", "我来做第" + i + "号功能模块的页面", at(9, i));
  fake({ new: [0, 1, 2, 3, 4].map(i => ({ title: "做第" + i + "号功能模块页面", quote: "我来做第" + i + "号功能模块的页面" })) });
  const r = await extractDay(hub, G, DAY);
  assert.equal(r.added.length, 2); assert.equal(listTasks(hub, G).length, 2);
  assert.equal(r.skipped.filter(s => /最多/.test(s.why)).length, 3);
  fake("```json\n{\"new\":[],\"done\":[],\"dropped\":[]}\n```");
  assert.equal((await extractDay(hub, G, DAY)).error, undefined);
  fake("我觉得今天没有任务");
  assert.match((await extractDay(hub, G, DAY)).error, /JSON/);
  const calls = fake({ new: [] });
  assert.ok((await extractDay(hub, "g:quiet", DAY)).skipped.length);
  assert.equal(calls.length, 0, "a quiet day costs no model call");
  assert.match((await extractDay(hub, G, "11/14")).error, /日期/);
});

test("tick runs once a Beijing night for real groups only, then the admin routes", async () => {
  const hub = mkHub({ "g:off:tasks_nightly": "off" });
  seedDay(hub, G); seedDay(hub, "t:ag-tasks"); seedDay(hub, "g:off");
  assert.deepEqual(nightlyConvs(hub, DAY), [G]);
  const calls = fake({ new: [{ title: "写季度报告", owner: "小红", quote: "周五前要交季度报告" }] });
  const early = Date.parse("2026-11-15T02:00:00+08:00"), late = Date.parse("2026-11-15T02:31:00+08:00");
  feature.tick(hub, early);
  await Promise.all(hub.waits);
  assert.equal(calls.length, 0, "not before 02:30");
  feature.tick(hub, late);
  await Promise.all(hub.waits);
  feature.tick(hub, late + 20000);
  await Promise.all(hub.waits);
  assert.equal(calls.length, 1, "one call per group per night");
  assert.equal(hub.get("tasks:extract:day"), "2026-11-15");
  assert.equal(listTasks(hub, G).length, 1);
  assert.equal(listTasks(hub, "t:ag-tasks").length, 0, "test rooms are skipped");

  const get = await feature.admin(hub, new Request("https://x/admin/tasks?conv=" + G), new URL("https://x/admin/tasks?conv=" + G), {});
  const g = await get.json();
  assert.equal(g.tasks.length, 1); assert.equal(g.last_extract.added, 1);
  const url = new URL("https://x/admin/tasks");
  const dry = await (await feature.admin(hub, new Request(url, { method: "POST" }), url, { extract: "t:ag-tasks", day: DAY, dry: true })).json();
  assert.equal(dry.added.length, 1); assert.equal(listTasks(hub, "t:ag-tasks").length, 0);
  await feature.admin(hub, new Request(url, { method: "POST" }), url, { extract: "t:ag-tasks", day: DAY, dry: false });
  assert.equal(listTasks(hub, "t:ag-tasks").length, 1);
  assert.equal(await feature.admin(hub, new Request("https://x/admin/other"), new URL("https://x/admin/other"), {}), null);
});

test("morning reminders: off by default, then one line per group, once", async () => {
  const hub = mkHub();
  const now = Date.parse("2026-11-15T09:05:00+08:00");
  addTask(hub, G, { title: "交报告", owner: "小红", due: "2026-11-15" });
  addTask(hub, G, { title: "明天的事", due: "2026-11-16" });
  const fin = addTask(hub, G, { title: "做完的", due: "2026-11-15" }); updateTask(hub, G, fin.id, { status: "done" });
  hub.said.length = 0;   // notices from the setup
  feature.tick(hub, now); await Promise.all(hub.waits);
  assert.equal(hub.said.length, 0, "off by default");
  const on = mkHub({ tasks_remind: "on" });
  addTask(on, G, { title: "交报告", owner: "小红", due: "2026-11-15" });
  addTask(on, G, { title: "订会议室", due: "2026-11-15" });
  addTask(on, G, { title: "做完的", due: "2026-11-15" }); updateTask(on, G, 3, { status: "done" });
  on.said.length = 0;
  feature.tick(on, Date.parse("2026-11-15T08:00:00+08:00")); await Promise.all(on.waits);
  assert.equal(on.said.length, 0, "not before 09:00");
  feature.tick(on, now); await Promise.all(on.waits);
  assert.equal(on.said.length, 1);
  assert.equal(on.said[0].text, "提醒一下，今天到期的：交报告（小红）；订会议室");
  on.kv.delete("tasks:remind:day");
  feature.tick(on, now + 60000); await Promise.all(on.waits);
  assert.deepEqual(await remind(on, now), []);
  assert.equal(on.said.length, 1, "each task is reminded once");
});

test("about lines and tunables are Chinese and bounded", () => {
  assert.ok(feature.about.length >= 3 && feature.about.every(l => /[一-鿿]/.test(l)));
  assert.equal(feature.tunables.tasks_nightly_max.default, 8);
  assert.equal(feature.tunables.tasks_remind.default, "off");
  assert.match(tool(mkHub()).description, /先 list/);
});

// ---- notices in the group ----
import { test as test2 } from "node:test";
import assert2 from "node:assert/strict";
import * as TK from "../src/feat/tasks.ts";
test2("work picked up or finished outside the chat is told to the group; chat changes and the switch stay quiet", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:"); db.exec(TK.default.schema);
  const said = []; let on = "on";
  const hub = {
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    say: async (conv, text) => { said.push(conv + "|" + text); return true; }, ctx: { waitUntil() {} }, edit: { cfg: () => on },
  };
  const t = TK.addTask(hub, "g:1", { title: "改完登录页", owner: "小明", by: "小红" });
  assert2.match(said.pop(), /^g:1\|【任务】小红 加了 #\d+「改完登录页」，交给 小明$/);
  TK.claimTask(hub, "g:1", t.id, "小明的本地 AI");
  assert2.match(said.pop(), /小明的本地 AI 接了 #\d+「改完登录页」，开干了/);
  TK.claimTask(hub, "g:1", t.id, "小明的本地 AI");
  assert2.equal(said.length, 0, "claiming again says nothing");
  TK.updateTask(hub, "g:1", t.id, { status: "open" }, "小明的本地 AI");
  assert2.match(said.pop(), /小明的本地 AI 放下了 #\d+/);
  TK.claimTask(hub, "g:1", t.id, "小红", true);
  TK.updateTask(hub, "g:1", t.id, { detail: "补充" }, "小红");
  assert2.equal(said.length, 0, "quiet claim and a plain edit say nothing");
  TK.updateTask(hub, "g:1", t.id, { status: "done", result: "已上线" }, "小红");
  assert2.match(said.pop(), /#\d+「改完登录页」 做完了（小红）：已上线/);
  on = "off";
  TK.addTask(hub, "g:1", { title: "另一件事", by: "小红" });
  assert2.equal(said.length, 0, "switched off");
});

test2("a task finished before finish times were kept gets its last change as the finish time", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:"); db.exec(TK.default.schema);
  db.prepare("INSERT INTO task(conv,title,status,owner,created,updated,done_at) VALUES('g:1','旧任务','done','小明',1000,5000,0)").run();
  const hub = { sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } } };
  assert2.equal(TK.listTasks(hub, "g:1", { status: ["done"] })[0].done_at, 5000);
});
