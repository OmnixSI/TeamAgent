import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import tasksFeature, { addTask, claimTask, updateTask, addTaskNote, getTask, hooks } from "../src/feat/tasks.ts";
import feature, { deps, teamStats, taskEvents, taskTimeline, cheerFacts, cheer, plainCheer, weekStart, span, pointsOf, streakOf, weeklyTask } from "../src/feat/teamwork.ts";

const G = "g:1", HOUR = 3600000, DAY = 86400000;
function mkHub(cfg = {}) {
  const db = new DatabaseSync(":memory:"); db.exec(tasksFeature.schema);
  const said = [], ran = [], kv = new Map(), waits = [];
  return {
    db, said, ran, waits,
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA)/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    say: async (conv, text) => { said.push(text); return true; }, runTask: async (conv, task) => { ran.push({ conv, task }); },
    ctx: { waitUntil: p => waits.push(p) }, edit: { cfg: (_c, k) => cfg[k] ?? "on" },
    get: k => kv.get(k) ?? null, set: (k, v) => kv.set(k, String(v)), env: {},
  };
}
/** Moves a task's recorded times, so durations and dates can be tested without waiting. */
const at = (hub, id, f) => hub.db.prepare("UPDATE task SET " + Object.keys(f).map(k => k + "=?").join(",") + " WHERE id=?").run(...Object.values(f), id);
const NOW = Date.parse("2026-11-18T15:00:00+08:00");   // a Wednesday

test("time helpers", () => {
  assert.equal(new Date(weekStart(NOW) + 8 * HOUR).toISOString().slice(0, 16), "2026-11-16T00:00");
  assert.equal(weekStart(Date.parse("2026-11-22T23:59:00+08:00")), weekStart(NOW), "Sunday night is still this week");
  assert.equal(span(40 * 60000), "40 分钟"); assert.equal(span(3 * HOUR), "3 小时"); assert.equal(span(2.5 * DAY), "2 天半"); assert.equal(span(0), "");
});

test("a task's path is recorded: who took it and when, how long it waited and took", () => {
  const hub = mkHub(), t = addTask(hub, G, { title: "改完登录页", owner: "小明", by: "小红" }, true);
  claimTask(hub, G, t.id, "小明的本地 AI", true);
  addTaskNote(hub, G, t.id, "小明的本地 AI", "表单写好了");
  updateTask(hub, G, t.id, { status: "done", result: "已上线" }, "小明的本地 AI", true);
  at(hub, t.id, { created: NOW - 10 * HOUR, claimed_at: NOW - 4 * HOUR, done_at: NOW - HOUR });
  const tl = taskTimeline(hub, G, t.id, NOW);
  assert.equal(tl.waited_ms, 6 * HOUR); assert.equal(tl.worked_ms, 3 * HOUR);
  assert.deepEqual(tl.steps.map(s => s.kind), ["add", "claim", "progress", "progress", "done"]);
  assert.equal(getTask(hub, G, t.id).done_by, "小明", "a local AI's work is credited to its person");
  const ev = taskEvents(hub, G, { kinds: ["claim", "done"] });
  assert.deepEqual(ev.map(e => e.kind).sort(), ["claim", "done"]); assert.equal(ev[0].title, "改完登录页");
  assert.equal(taskTimeline(hub, "g:2", t.id), null, "another group cannot see it");
});

test("points, streaks, badges and the week's star come from the records", () => {
  const hub = mkHub();
  const mk = (title, who, size, doneAt, extra = {}) => { const t = addTask(hub, G, { title, owner: who, size, ...extra }, true); claimTask(hub, G, t.id, who, true); updateTask(hub, G, t.id, { status: "done" }, who, true); at(hub, t.id, { claimed_at: doneAt - HOUR, done_at: doneAt }); return t; };
  mk("小事一件", "小明", "small", NOW - 2 * DAY);                                   // Monday
  mk("普通一件", "小明", "normal", NOW - DAY, { due: "2026-11-20" });               // Tuesday, on time: 10 + 5
  mk("大活一件", "小明", "big", NOW - HOUR);                                        // today
  mk("上周的事", "小红", "normal", NOW - 6 * DAY);                                  // last week
  const doing = addTask(hub, G, { title: "还在做的", owner: "小红", due: "2026-11-10" }, true); claimTask(hub, G, doing.id, "小红", true);
  addTask(hub, G, { title: "bot 的事", owner: "bot" }, true);
  const s = teamStats(hub, G, NOW);
  assert.deepEqual(s.people.map(p => p.name), ["小明", "小红"], "the bot is not a player");
  const [m, r] = s.people;
  assert.equal(m.done_week, 3); assert.equal(m.points_week, 5 + 15 + 30); assert.equal(m.streak, 3); assert.equal(s.mvp, "小明");
  assert.deepEqual(m.badges.filter(b => b.earned).map(b => b.key).sort(), ["boss", "first", "flash", "streak3"]);
  assert.equal(r.done_week, 0); assert.equal(r.done_total, 1); assert.equal(r.doing.length, 1); assert.equal(r.doing[0].overdue, true);
  assert.equal(s.totals.overdue, 1); assert.equal(s.week.done, 3); assert.deepEqual(s.week.by_day.slice(0, 3), [1, 1, 1]);
  assert.equal(pointsOf(getTask(hub, G, doing.id)), 0);
  assert.equal(streakOf([], NOW), 0);
});

test("finishing a task outside the chat is praised with true numbers; in the chat only the facts are handed over", async () => {
  const hub = mkHub();
  const first = addTask(hub, G, { title: "搭测试环境", owner: "小明" }, true); claimTask(hub, G, first.id, "小明", true);
  const seen = []; const old = deps.line;
  deps.line = async (_h, sys, user) => { seen.push(JSON.parse(user)); return "「测试环境说搭就搭，这周头一件就这么利索。」"; };
  try {
    updateTask(hub, G, first.id, { status: "done", result: "跑通了" }, "小明");
    await Promise.all(hub.waits);
    assert.equal(hub.said.length, 1);
    assert.match(hub.said[0], /^【任务】#\d+「搭测试环境」 做完了。测试环境说搭就搭，这周头一件就这么利索。（小明 \+10 分，新称号：开张）$/);
    assert.equal(seen[0].week_count, 1); assert.equal(seen[0].who, "小明"); assert.ok(seen[0].new_badges.some(b => b.startsWith("开张")));
    // the model down: a plain, true line
    deps.line = async () => { throw new Error("down"); };
    const second = addTask(hub, G, { title: "写周报", owner: "小明" }, true); claimTask(hub, G, second.id, "小明", true);
    updateTask(hub, G, second.id, { status: "done" }, "小明"); await Promise.all(hub.waits);
    assert.match(hub.said[1], /做完了，小明 拿下：.*\+10 分，这周第 2 件/);
    // in the chat: nothing is said by the hook, the facts go to the model
    const third = addTask(hub, G, { title: "修按钮", owner: "小红" }, true);
    const fin = updateTask(hub, G, third.id, { status: "done" }, "小红", true); await Promise.all(hub.waits);
    assert.equal(hub.said.length, 2);
    assert.equal(hooks.facts(hub, G, fin).who, "小红");
    // nobody to credit (the bot's own chore): a plain notice, no model call
    const chore = addTask(hub, G, { title: "bot 自己的事", owner: "bot" }, true);
    updateTask(hub, G, chore.id, { status: "done" }, "bot"); await Promise.all(hub.waits);
    assert.match(hub.said[2], /「bot 自己的事」 做完了$/);
  } finally { deps.line = old; }
  assert.equal(cheerFacts(hub, G, addTask(hub, G, { title: "没做完的" }, true)), null);
  const off = mkHub({ team_praise: "off" }), t = addTask(off, G, { title: "关掉夸奖", owner: "小明" }, true);
  updateTask(off, G, t.id, { status: "done", result: "好了" }, "小明"); await Promise.all(off.waits);
  assert.deepEqual(off.said, ["【任务】#1「关掉夸奖」 做完了：好了"]);
});

test("the weekly report runs once on Sunday night, for real groups with something to say", async () => {
  const hub = mkHub(), t = addTask(hub, G, { title: "交报告", owner: "小明" }, true);
  updateTask(hub, G, t.id, { status: "done" }, "小明", true);
  addTask(hub, "t:room", { title: "测试房间的事" }, true);
  const sunday = Date.parse("2026-11-22T21:31:00+08:00");
  at(hub, t.id, { done_at: sunday - DAY });
  feature.tick(hub, Date.parse("2026-11-21T22:00:00+08:00")); feature.tick(hub, Date.parse("2026-11-22T21:00:00+08:00"));
  assert.equal(hub.waits.length, 0, "not on Saturday, not before 21:30");
  feature.tick(hub, sunday); feature.tick(hub, sunday + 60000); await Promise.all(hub.waits);
  assert.equal(hub.ran.length, 1); assert.equal(hub.ran[0].conv, G);
  assert.match(hub.ran[0].task, /"本周做完":1/); assert.match(hub.ran[0].task, /"本周之星":"小明"/); assert.match(hub.ran[0].task, /meme/);
  assert.doesNotMatch(weeklyTask(teamStats(mkHub(), G, sunday), []), /meme/, "nobody scored: no picture for a star");
});

test("the chat tool answers who is doing what and how a task went", async () => {
  const hub = mkHub(), tool = feature.tools({ hub, conv: G, askers: [{ id: "u1", name: "小明" }], host: {} })[0];
  const t = addTask(hub, G, { title: "改完登录页", owner: "小明" }, true); claimTask(hub, G, t.id, "小明", true);
  const st = await tool.run({ op: "status", mine: true });
  assert.equal(st.people.length, 1); assert.match(st.people[0].doing[0], /^#1 改完登录页（.*前接的）$/);
  assert.match((await tool.run({ op: "status", who: "不存在的人" })).note, /还没有记录/);
  const tl = await tool.run({ op: "timeline", id: t.id });
  assert.equal(tl.ok, true); assert.equal(tl.steps.length, 2);
  assert.equal((await tool.run({ op: "timeline", id: 99 })).ok, false);
  assert.ok((await tool.run({ op: "recent" })).events.length >= 2);
});
