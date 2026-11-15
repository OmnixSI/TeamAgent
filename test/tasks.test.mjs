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

// ---------- order, priority, hand-off materials, splitting, the bot's own work ----------
const { workOrder, blockers, checkAfter, unblockedBy, addTaskRef, taskRefs, removeTaskRef, handoff, quoteOf, nextBotTask, botBrief, workOn, botBusy, parseIds, normPriority } = await import("../src/feat/tasks.ts");

test("priority and order: what to work on first, what waits, loops refused, the next one is named when its turn comes", () => {
  const hub = mkHub();
  const a = addTask(hub, G, { title: "搭后端接口", by: "小明" }, true), b = addTask(hub, G, { title: "接前端页面", by: "小明", after: [a.id, 999] }, true);
  const c = addTask(hub, G, { title: "修线上事故", by: "小明", priority: "high" }, true), d = addTask(hub, G, { title: "整理文档", by: "小明", priority: "low" }, true);
  assert.deepEqual(b.after, [a.id], "an id that does not exist is left out"); assert.equal(c.priority, 1); assert.equal(d.priority, 3); assert.equal(a.priority, 2);
  assert.deepEqual(parseIds("#3, 4 和 4"), [3, 4]); assert.equal(normPriority("急"), 1); assert.equal(normPriority("whatever"), 0);
  assert.deepEqual(workOrder(hub, G).map(r => [r.task.title, r.blocked_by]), [["修线上事故", []], ["搭后端接口", []], ["整理文档", []], ["接前端页面", [a.id]]]);
  claimTask(hub, G, d.id, "小红", true);
  assert.equal(workOrder(hub, G)[0].task.title, "整理文档", "what is under way comes first");
  assert.deepEqual(blockers(hub, G, getTask(hub, G, b.id)).map(t => t.id), [a.id]);
  assert.match(checkAfter(hub, G, a.id, [b.id]).error, /互相等/); assert.match(checkAfter(hub, G, a.id, [a.id]).error, /自己后面/); assert.match(checkAfter(hub, G, a.id, [77]).error, /没有编号 77/);
  assert.deepEqual(updateTask(hub, G, a.id, { after: [b.id] }, "小明", true).after, [], "a loop is not stored");
  assert.equal(updateTask(hub, G, c.id, { priority: "low", after: [a.id] }, "小明", true).priority, 3);
  assert.match(taskNotes(hub, G, c.id).map(n => n.text).join("|"), /优先级改成“不急”\|排在 #1 之后/);
  hub.said.length = 0;
  updateTask(hub, G, a.id, { status: "done" }, "小明");
  assert.deepEqual(unblockedBy(hub, G, a.id).map(t => t.id).sort(), [b.id, c.id]);
  assert.ok(hub.said.some(s => /#1 做完之后，.*接前端页面.*可以开始了/.test(s.text)), JSON.stringify(hub.said));
  assert.ok(taskNotes(hub, G, b.id).some(n => n.kind === "ready" && /#1 做完了，这件可以开始了/.test(n.text)));
  assert.deepEqual(workOrder(hub, G).find(r => r.task.id === b.id).blocked_by, []);
});

test("materials: original words, reports, links; no duplicates; a split-off task inherits its parent's; the hand-off package", () => {
  const hub = mkHub();
  const a = addTask(hub, G, { title: "写奖励方案", owner: "bot", by: "小明", source: "方案交给你了" }, true);
  const q = addTaskRef(hub, G, a.id, { kind: "quote", text: "[11-15 周日 21:40] 小明：方案再改改就开始执行，这个活交给你了", who: "小明" });
  assert.equal(q.title, "群里的原话");
  const r = addTaskRef(hub, G, a.id, { kind: "report", title: "调研报告", text: "第一章 现状\n第二章 方案", who: "bot" });
  assert.equal(addTaskRef(hub, G, a.id, { kind: "report", title: "调研报告", text: "第一章 现状\n第二章 方案" }).id, r.id, "the same piece twice is one piece");
  addTaskRef(hub, G, a.id, { kind: "link", title: "网页版", ref: "https://w.example/p/abc/", who: "bot" });
  assert.equal(addTaskRef(hub, G, a.id, { kind: "link" }), null); assert.equal(addTaskRef(hub, G, 999, { kind: "link", ref: "https://x" }), null); assert.equal(addTaskRef(hub, G, a.id, { kind: "nope", ref: "x" }), null);
  assert.deepEqual(taskRefs(hub, G, a.id).map(x => x.kind), ["quote", "report", "link"]);
  assert.ok(taskNotes(hub, G, a.id).some(n => n.kind === "attach" && /挂上了报告《调研报告》/.test(n.text)));
  assert.ok(!taskNotes(hub, G, a.id).some(n => /原话/.test(n.text) && n.kind === "attach"), "the original words are not announced as an attachment");
  const child = addTask(hub, G, { title: "拍板排行榜拆不拆", owner: "小明", by: "bot", parent: a.id }, true), pre = addTask(hub, G, { title: "先定预算", by: "小明" }, true);
  updateTask(hub, G, a.id, { after: [pre.id] }, "bot", true);
  const h = handoff(hub, G, child.id);
  assert.deepEqual(h.materials.map(m => [m.kind, m.from]), [["quote", a.id], ["report", a.id], ["link", a.id]]);
  assert.deepEqual(h.parent, { id: a.id, title: "写奖励方案", status: "open", result: "" });
  const top = handoff(hub, G, a.id);
  assert.deepEqual(top.children, [{ id: child.id, title: "拍板排行榜拆不拆", status: "open", owner: "小明" }]);
  assert.deepEqual(top.waits_for.map(w => w.id), [pre.id]); assert.deepEqual(top.blocked_by, [pre.id]); assert.ok(top.notes.length);
  assert.equal(handoff(hub, G, 999), null);
  assert.equal(removeTaskRef(hub, G, a.id, r.id, "小明"), true); assert.equal(removeTaskRef(hub, G, a.id, r.id), false);
  assert.deepEqual(taskRefs(hub, G, a.id).map(x => x.kind), ["quote", "link"]);
  assert.deepEqual(taskRefs(hub, "g:2", a.id), [], "another group cannot read them");
});

test("the tool: the asker's own words are stored verbatim; start, attach, split with a reason, order in list and show", async () => {
  const hub = mkHub(), now = Date.now();
  hub.recent = (conv, n) => hub.db.prepare("SELECT * FROM (SELECT * FROM msg WHERE conv=? ORDER BY seq DESC LIMIT ?) ORDER BY seq").all(conv, n);
  say(hub, G, "小红", "今天吃什么", now - 5 * 60000);
  say(hub, G, "小明", "这个兑换系统还可以怎么设计，多调研几轮", now - 4 * 60000);
  say(hub, G, "小明", "写个方案，这个活交给你了，能力不够的拆到任务里", now - 60000);
  say(hub, G, "小明", "很久以前说的话", now - 3 * 3600000);
  assert.equal(quoteOf(hub, G, []), "");
  const t = tool(hub, [{ id: "u小明", name: "小明" }]);
  const made = await t.run({ op: "add", title: "设计奖励与兑换方案", owner: "bot", priority: "high", source: "这个活交给你了" });
  assert.equal(made.added.priority, "急"); assert.match(made.next, /先 start/);
  const id = made.added.id, q = taskRefs(hub, G, id);
  assert.equal(q.length, 1); assert.equal(q[0].kind, "quote");
  assert.match(q[0].text, /小明：这个兑换系统还可以怎么设计，多调研几轮\n\[.*\] 小明：写个方案，这个活交给你了，能力不够的拆到任务里$/);
  assert.doesNotMatch(q[0].text, /今天吃什么|很久以前/);
  assert.equal((await t.run({ op: "add", title: "排在没有的任务后面", after: [404] })).ok, false);
  const started = await t.run({ op: "start", id });
  assert.equal(started.task.claimed_by, "bot"); assert.equal(started.task.status, "在做");
  const other = (await t.run({ op: "add", title: "给客户回电话", owner: "小红" })).added.id;
  claimTask(hub, G, other, "小红", true);
  assert.match((await t.run({ op: "start", id: other })).error, /小红 已经在做/);
  const att = await t.run({ op: "attach", id, kind: "report", title: "方案 v1", text: "一、积分怎么挣……" });
  assert.equal(att.attached.kind, "报告"); assert.equal((await t.run({ op: "attach", id })).ok, false);
  assert.equal((await t.run({ op: "attach", id, ref: "https://w.example/p/x/" })).attached.kind, "链接");
  assert.equal((await t.run({ op: "split", id, title: "拍板：排行榜拆不拆" })).ok, false, "a split needs its reason");
  const sp = await t.run({ op: "split", id, title: "拍板：排行榜拆不拆", owner: "小明", reason: "这是群规，得群主定", detail: "方案里两种都写了", blocks: true });
  assert.equal(sp.split.owner, "小明"); assert.equal(sp.split.split_from, id); assert.equal(sp.split.priority, "急", "a split-off part keeps its parent's priority");
  assert.deepEqual(sp.from.after, [sp.split.id]); assert.match(sp.note, /原任务会等/);
  assert.match(getTask(hub, G, sp.split.id).detail, /方案里两种都写了\n拆出来的原因：这是群规，得群主定/);
  assert.ok(taskNotes(hub, G, id).some(n => /拆出 #\d+「拍板：排行榜拆不拆」交给 小明：这是群规，得群主定/.test(n.text)));
  const shown = await t.run({ op: "show", id });
  assert.deepEqual(shown.materials.map(m => m.kind), ["原话", "报告", "链接"]); assert.equal(shown.split_into[0].who, "小明"); assert.equal(shown.waiting_for[0].id, sp.split.id);
  assert.equal((await t.run({ op: "show", id: sp.split.id })).materials[0].from_task, id);
  const list = await t.run({ op: "list" });
  assert.equal(list.tasks.at(-1).id, id, "what waits for another task is listed last"); assert.equal(list.tasks.at(-1).waiting_for[0].id, sp.split.id);
  assert.match((await t.run({ op: "start", id })).error, /要等 #\d+ 做完/);
  assert.equal((await t.run({ op: "update", id, priority: "soon" })).ok, false);
  assert.match((await t.run({ op: "update", id: sp.split.id, after: [id] })).error, /互相等/);
  const done = await t.run({ op: "done", id: sp.split.id, result: "拆" });
  assert.deepEqual(done.now_can_start.map(x => x.id), [id]);
  assert.equal(hub.said.length, 0, "what is said to the bot in the chat is not announced a second time");
});

test("the bot works on its own tasks: picks the next one, shows it as under way, runs it, and says what happened when it is not finished", async () => {
  const hub = mkHub({ tasks_bot_daily: 2, tasks_bot_auto: "on" });
  const runs = [];
  hub.jobs = new Map();
  hub.runTask = async (conv, brief) => { runs.push({ conv, brief }); hub.jobs.set(99, { conv }); try { hub.onRun?.(conv); } finally { hub.jobs.delete(99); } return true; };
  const old = Date.now() - 10 * 60000;
  const mine = addTask(hub, G, { title: "写奖励方案", owner: "bot", by: "小明", source: "交给你了", detail: "十章" }, true);
  const urgent = addTask(hub, G, { title: "修日报", owner: "Bot", by: "小明", priority: "high" }, true);
  const hers = addTask(hub, G, { title: "给客户回电话", owner: "小红", by: "小红", priority: "high" }, true);
  const waiting = addTask(hub, G, { title: "按拍板结果改方案", owner: "bot", by: "bot", after: [hers.id] }, true);
  assert.equal(nextBotTask(hub, G), null, "a task made a moment ago may be under way in the chat turn that made it");
  hub.db.prepare("UPDATE task SET created=?").run(old);
  assert.equal(nextBotTask(hub, G).id, urgent.id, "urgent first; other people's and waiting tasks are not the bot's to start");
  addTaskRef(hub, G, urgent.id, { kind: "quote", text: "[11-15 周日 21:40] 小明：日报又没发，修一下" });
  hub.onRun = conv => { assert.equal(botBusy(hub, conv), urgent.id); updateTask(hub, conv, urgent.id, { status: "done", result: "修好了" }, "bot", true); };
  assert.equal(await workOn(hub, G, urgent.id), true);
  assert.match(runs[0].brief, /^做任务 #2「修日报」/); assert.match(runs[0].brief, /小明：日报又没发，修一下/); assert.match(runs[0].brief, /op=split（id=2）/);
  assert.deepEqual(hub.said.map(s => s.text), ["【任务】Bot 接了 #2「修日报」，开干了，进展在看板上"]);
  assert.equal(getTask(hub, G, urgent.id).status, "done"); assert.equal(botBusy(hub, G), 0);
  // a run that ends without finishing: noted, retried later, and after three tries the group is asked for help
  hub.onRun = null; hub.said.length = 0;
  for (let i = 1; i <= 3; i++) {
    assert.equal(nextBotTask(hub, G, Date.now() + i * 31 * 60000)?.id, mine.id);
    await workOn(hub, G, mine.id, Date.now() + i * 31 * 60000);
    assert.equal(getTask(hub, G, mine.id).runs, i);
  }
  assert.equal(getTask(hub, G, mine.id).status, "doing"); assert.equal(getTask(hub, G, mine.id).claimed_by, "bot");
  assert.match(runs.at(-1).brief, /第 3 轮/);
  const log = taskNotes(hub, G, mine.id).map(n => n.text);
  assert.equal(log.filter(x => x === "这一轮没做完，过半小时接着做").length, 2); assert.ok(log.some(x => /试了 3 轮还没做完/.test(x)));
  assert.ok(hub.said.some(s => /#1「写奖励方案」 我自己试了 3 轮还没做完/.test(s.text)));
  assert.equal(nextBotTask(hub, G, Date.now() + 9 * 3600000), null, "it does not try a fourth time by itself");
  // a task that ends up waiting for a person is left alone until that person is done, then gets its tries back
  assert.equal(await workOn(hub, G, waiting.id), false);
  updateTask(hub, G, mine.id, { after: [hers.id] }, "bot", true);
  updateTask(hub, G, hers.id, { status: "done" }, "小红", true);
  assert.equal(getTask(hub, G, mine.id).runs, 0);
  assert.deepEqual(new Set([nextBotTask(hub, G, Date.now() + 9 * 3600000).id]), new Set([mine.id]), "what is under way comes before what has not started");
  // the tick: working hours only, real groups only, nothing while a job runs there, and within the day's allowance
  const day = "2026-11-16", at8 = Date.parse(day + "T09:00:00+08:00");
  hub.db.prepare("UPDATE task SET created=?, last_run=0, runs=0").run(at8 - 3600000);
  hub.kv.set("tasks:extract:day", day); hub.kv.set("tasks:remind:day", day);
  runs.length = 0; hub.waits.length = 0;
  feature.tick(hub, Date.parse(day + "T03:00:00+08:00")); assert.equal(hub.waits.length, 0, "not at night");
  hub.jobs.set(1, { conv: G }); feature.tick(hub, at8); assert.equal(hub.waits.length, 0, "one thing at a time");
  hub.jobs.clear(); feature.tick(hub, at8); await Promise.all(hub.waits); assert.equal(runs.length, 1);
  hub.db.prepare("UPDATE task SET last_run=0").run(); feature.tick(hub, at8 + 60000); await Promise.all(hub.waits); assert.equal(runs.length, 2);
  hub.db.prepare("UPDATE task SET last_run=0, runs=0").run(); feature.tick(hub, at8 + 120000); await Promise.all(hub.waits); assert.equal(runs.length, 2, "the day's allowance is used up");
  const off = mkHub({ tasks_bot_auto: "off" }); off.runTask = async () => { throw new Error("must not run"); };
  addTask(off, G, { title: "写方案", owner: "bot" }, true); addTask(off, "t:lab", { title: "写方案", owner: "bot" }, true);
  off.db.prepare("UPDATE task SET created=?").run(at8 - 3600000); off.kv.set("tasks:extract:day", day); off.kv.set("tasks:remind:day", day);
  feature.tick(off, at8); assert.equal(off.waits.length, 0);
});
