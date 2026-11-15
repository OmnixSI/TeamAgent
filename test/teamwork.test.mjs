import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import tasksFeature, { addTask, claimTask, updateTask, addTaskNote, getTask, hooks } from "../src/feat/tasks.ts";
import feature, { deps, teamStats, taskEvents, taskTimeline, cheerFacts, cheer, plainCheer, weekStart, span, pointsOf, streakOf, weeklyTask } from "../src/feat/teamwork.ts";
import { RULES as CONTRIB_RULES } from "../src/feat/contrib.ts";
CONTRIB_RULES.claim.points = 0;   // these tests are about task scoring alone; picking a task up is scored in contrib.test.mjs

const G = "g:1", HOUR = 3600000, DAY = 86400000;
function mkHub(cfg = {}) {
  const db = new DatabaseSync(":memory:"); db.exec(tasksFeature.schema); db.exec(feature.schema);
  const said = [], ran = [], kv = new Map(), waits = [];
  return {
    db, said, ran, waits,
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = st.columns().length ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
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
    assert.match(hub.said[0], /^【任务】#\d+「搭测试环境」 做完了。测试环境说搭就搭，这周头一件就这么利索。（小明 \+10 分，新称号：开张(、闪电)?）$/);   // 闪电 too when the claim and the finish fall in different milliseconds
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

// ---- points for perks, and the wall ----
import { shop, redeem, settle, balanceOf, spends, titleOf, setItem, dropItem, honorWall, recordStar, SHOP_SCHEMA } from "../src/feat/teamwork.ts";
const earn = (hub, who, size = "normal") => { const t = addTask(hub, G, { title: who + " 的活 " + Math.random().toString(36).slice(2, 6), owner: who, size }, true); claimTask(hub, G, t.id, who, true); updateTask(hub, G, t.id, { status: "done" }, who, true); return t; };

test("points are spent, not minted: redeeming checks the balance, records the spend, and says what to do", async () => {
  const hub = mkHub(); hub.db.exec(SHOP_SCHEMA);
  earn(hub, "小明", "big");                                   // 30
  assert.deepEqual(balanceOf(hub, G, "小明"), { earned: 30, spent: 0, balance: 30 });
  assert.match(redeem(hub, G, "小明", "战报封面人物").error, /有 30 分.*要 50 分.*还差 20 分/);
  assert.match(redeem(hub, G, "小明", "不存在的").error, /没有这一项/);
  assert.match(redeem(hub, G, "小明", "专属头衔一周", "").error, /12 个字以内/);
  assert.equal(redeem(hub, G, "bot", "甩锅券").ok, false);
  const r = redeem(hub, G, "小明", "甩锅券", "昨晚把测试库删了");
  assert.equal(r.ok, true); assert.equal(r.balance, 15); assert.equal(r.spend.state, "pending");
  assert.equal(r.spend.settled_at, 0); assert.equal(r.spend.balance_after, 15);
  assert.match(r.do, /甩锅券.*昨晚把测试库删了.*认下来/);
  assert.equal(hub.ran.length, 0, "in the chat the bot does it in its own reply");
  assert.equal(teamStats(hub, G).people[0].balance, 15);
  assert.equal(redeem(hub, G, "小明", "点一张图").ok, false, "15 left, 20 needed");
  const t = redeem(hub, G, "小明", "定制表情包", "奶蛙举牌", "board");
  assert.equal(t.ok, true); await Promise.all(hub.waits);
  assert.equal(hub.ran.length, 1); assert.match(hub.ran[0].task, /小明 用积分换了一个定制表情包.*看板上兑换.*花了 5 分，还剩 10 分/);
  const paidBack = settle(hub, G, t.spend.id, "refunded", NOW, "群主");
  assert.equal(paidBack.state, "refunded"); assert.equal(paidBack.settled_at, NOW); assert.equal(paidBack.settled_by, "群主");
  assert.equal(settle(hub, G, t.spend.id, "refunded", NOW + HOUR).settled_at, NOW, "refund retry keeps original receipt");
  assert.equal(settle(hub, G, t.spend.id, "done"), null, "refunding is final");
  assert.equal(balanceOf(hub, G, "小明").balance, 15, "refunded points come back");
  assert.equal(settle(hub, G, 999, "done"), null);
});

test("a bought title lasts a week and shows on the person; custom perks wait for a person to honour them", () => {
  const hub = mkHub(); hub.db.exec(SHOP_SCHEMA);
  earn(hub, "小红", "big"); earn(hub, "小红", "big");          // 60
  const now = Date.parse("2026-11-18T12:00:00+08:00");
  const r = redeem(hub, G, "小红", "专属头衔一周", "首席救火官", "chat", now);
  assert.equal(r.ok, true); assert.match(r.do, /remember/);
  assert.equal(titleOf(hub, G, "小红", now + 6 * DAY), "首席救火官"); assert.equal(titleOf(hub, G, "小红", now + 8 * DAY), "");
  assert.equal(teamStats(hub, G, now).people[0].title, "首席救火官");
  assert.match(setItem(hub, G, "", 10, "", "群主"), /名字/); assert.match(setItem(hub, G, "奶茶", 0, "", "群主"), /1 到 1000/); assert.match(setItem(hub, G, "甩锅券", 5, "", "群主"), /已经有/);
  const it = setItem(hub, G, "奶茶一杯", 30, "群主请", "群主");
  assert.equal(it.kind, "manual"); assert.ok(shop(hub, G).some(i => i.name === "奶茶一杯" && i.custom));
  const tea = redeem(hub, G, "小红", "奶茶一杯", "", "chat", now);
  assert.equal(tea.spend.state, "pending"); assert.match(tea.do, /请群主兑现/);
  assert.equal(spends(hub, G, { state: "pending" }).length, 1);
  assert.equal(settle(hub, G, tea.spend.id, "done", now + HOUR, "群主").state, "done");
  assert.equal(settle(hub, G, tea.spend.id, "refunded"), null, "fulfilled promises cannot be refunded");
  assert.equal(dropItem(hub, G, "奶茶一杯"), true); assert.equal(dropItem(hub, G, "甩锅券"), false);
  assert.equal(shop(hub, "g:2").some(i => i.custom), false);
});

test("legacy redemption rows keep their timestamps and migrate when the owner settles them", () => {
  const hub = mkHub();
  for (const column of ["balance_after", "settled_by", "weekly_at", "request_id"]) hub.db.exec("ALTER TABLE team_spend DROP COLUMN " + column);
  hub.db.prepare("INSERT INTO team_spend(conv,who,item,name,cost,ts) VALUES(?,?,?,?,?,?)").run(G, "小明", "mint", "薄荷糖", 5, NOW);
  const old = spends(hub, G)[0];
  assert.equal(old.balance_after, null);
  const entry = settle(hub, G, old.id, "done", NOW + HOUR, "群主");
  assert.equal(entry.ts, NOW);
  assert.equal(entry.settled_at, NOW + HOUR);
  assert.equal(entry.settled_by, "群主");
  assert.equal(entry.balance_after, null);
});

test("the wall: weekly stars, bosses brought down, who holds which badge, records, titles", () => {
  const hub = mkHub(); hub.db.exec(SHOP_SCHEMA);
  const boss = earn(hub, "小明", "big"), other = earn(hub, "小红");
  at(hub, boss.id, { claimed_at: NOW - 5 * HOUR, done_at: NOW - 2 * HOUR });
  at(hub, other.id, { claimed_at: NOW - 8 * HOUR, done_at: NOW - 4 * HOUR });
  const stats = teamStats(hub, G, NOW);
  recordStar(hub, G, stats); recordStar(hub, G, stats);
  redeem(hub, G, "小明", "专属头衔一周", "屠龙勇士", "chat", NOW);
  const w = honorWall(hub, G, NOW);
  assert.deepEqual(w.stars.map(s => s.who), ["小明"]); assert.equal(w.stars[0].points, 30);
  assert.equal(w.bosses.length, 1); assert.equal(w.bosses[0].who, "小明"); assert.equal(w.bosses[0].took_ms, 3 * HOUR);
  assert.deepEqual(w.badges.find(b => b.key === "boss").holders.map(h => h.who), ["小明"]);
  assert.deepEqual(w.badges.find(b => b.key === "first").holders.map(h => h.who).sort(), ["小明", "小红"].sort());
  assert.ok(w.records.some(r => r.what === "最快做完" && r.who === "小明" && r.value === "3 小时"));
  assert.ok(w.records.some(r => r.what === "单周最高分" && r.value === "30 分"));
  assert.deepEqual(w.titles.map(t => t.who + t.title), ["小明屠龙勇士"]);
  assert.equal(honorWall(mkHub(), G, NOW).stars.length, 0, "tables not there yet: an empty wall, not an error");
});

test("the chat tool: shop, redeem for the asker only, wall, and owner-only settling", async () => {
  const hub = mkHub(); hub.db.exec(SHOP_SCHEMA); hub.edit.rank = (_c, askers) => askers[0]?.name === "群主" ? "owner" : "member";
  earn(hub, "小明", "big");
  const as = name => feature.tools({ hub, conv: G, askers: [{ id: name, name }], host: {} })[0];
  const s = await as("小明").run({ op: "shop" });
  assert.equal(s.balance, 30); assert.ok(s.items.length >= 7);
  const r = await as("小明").run({ op: "redeem", item: "点一张图", note: "奶蛙爬山" });
  assert.equal(r.ok, true); assert.equal(r.balance_left, 10); assert.match(r.do, /generate_image/);
  assert.equal((await as("小红").run({ op: "redeem", item: "定制表情包" })).ok, false, "no points of her own");
  assert.equal((await as("小明").run({ op: "refund", id: r.record })).ok, false);
  const batched = feature.tools({ hub, conv: G, askers: [{ id: "群主", name: "群主" }, { id: "小明", name: "小明" }], host: {} })[0];
  assert.equal((await batched.run({ op: "refund", id: r.record })).ok, false);
  assert.equal((await as("群主").run({ op: "refund", id: r.record })).ok, true);
  assert.equal((await as("小明").run({ op: "add_item", name: "奶茶", cost: 30 })).ok, false);
  assert.equal((await as("群主").run({ op: "add_item", name: "奶茶一杯", cost: 30, what: "群主请" })).ok, true);
  const w = await as("小红").run({ op: "wall" });
  assert.ok(w.bosses.length === 1 && w.badges.some(b => b.startsWith("屠龙")));
  assert.equal((await as("小明").run({ op: "status", mine: true })).people[0].balance, 30);
});

// ---- the star's certificate and ceremony ----
import { certificateHtml, awardCertificate, weekly } from "../src/feat/teamwork.ts";
test("an offered weekly cover stays pending without being offered twice", async () => {
  const hub = mkHub();
  for (const day of [1, 2]) at(hub, earn(hub, "小明", "big").id, { claimed_at: NOW - day * DAY - HOUR, done_at: NOW - day * DAY });
  const buy = redeem(hub, G, "小明", "cover", "", "chat", NOW);
  assert.equal(buy.spend.state, "pending");
  await weekly(hub, NOW + DAY, G);
  assert.match(hub.ran[0].task, /小明 用积分换了这一期的封面/);
  assert.equal(spends(hub, G)[0].state, "pending");
  assert.equal(spends(hub, G)[0].weekly_at, NOW + DAY);
  await weekly(hub, NOW + 2 * DAY, G);
  assert.doesNotMatch(hub.ran[1].task, /小明 用积分换了这一期的封面/);
});
test("the certificate names the person and their deeds, and nothing in it can break the page", () => {
  const html = certificateHtml({ who: "小<明>", title: "首席&救火官", group: "做 AI 高手", from: Date.parse("2026-11-09T00:00:00+08:00"), to: Date.parse("2026-11-15T23:59:00+08:00"), done: 3, points: 45, deeds: ["改完<b>登录页</b>", "二", "三", "四", "五"], streak: 3, issued: Date.parse("2026-11-15T21:30:00+08:00"), no: "第 2026-46 号", times: 2 });
  assert.match(html, /<h1>奖状<\/h1>/); assert.match(html, /小&lt;明&gt;<\/b> 同志/); assert.match(html, /首席&amp;救火官/);
  assert.match(html, /11 月 9 日至 11 月 15 日/); assert.match(html, /做成 <em>3<\/em> 件事，拿下 <em>45<\/em> 分，连续 <em>3<\/em> 天/);
  assert.match(html, /改完&lt;b&gt;登录页&lt;\/b&gt;/); assert.doesNotMatch(html, /<li>五<\/li>/, "four deeds at most");
  assert.match(html, /本周之星/); assert.match(html, /第 2 次获此荣誉/); assert.match(html, /2026 年 11 月 15 日/);
  assert.doesNotMatch(html, /https?:\/\//, "nothing is fetched from outside");
});

test("Sunday: the star is recorded, gets a certificate in the group, a bonus and the title; the report hosts the ceremony", async () => {
  const hub = mkHub(), sent = [];
  hub.sendImage = async (conv, bytes, note) => { sent.push({ conv, n: bytes.length, note }); return { ok: true, id: "g77" }; };
  hub.store = { imageRef: async () => null };
  const a = earn(hub, "小明", "big"), b = earn(hub, "小红");
  const sunday = Date.parse("2026-11-22T21:31:00+08:00");
  at(hub, a.id, { done_at: sunday - DAY }); at(hub, b.id, { done_at: sunday - 2 * DAY });
  const pages = []; const old = deps.render;
  deps.render = async (_h, html, w, h) => { pages.push({ html, w, h }); return new Uint8Array([1, 2, 3]); };
  try {
    await weekly(hub, sunday, G);
    assert.equal(pages.length, 1); assert.equal(pages[0].w, 1400); assert.match(pages[0].html, /小明<\/b> 同志/); assert.match(pages[0].html, /拿下 <em>30<\/em> 分/);
    assert.deepEqual(sent, [{ conv: G, n: 3, note: "本周之星奖状：小明（11 月 16 日那一周）" }]);
    assert.equal(honorWall(hub, G, sunday).stars[0].cert, "g77");
    const me = teamStats(hub, G, sunday).people.find(p => p.name === "小明");
    assert.equal(me.points_total, 30 + 20, "the star's bonus"); assert.equal(me.balance, 50); assert.equal(me.title, "本周之星"); assert.equal(me.stars, 1);
    assert.equal(teamStats(hub, G, sunday).people.find(p => p.name === "小红").title, "");
    assert.match(hub.ran[0].task, /颁奖仪式/); assert.match(hub.ran[0].task, /图 g77/); assert.match(hub.ran[0].task, /speak/); assert.match(hub.ran[0].task, /20 分奖金/);
    // the printer down: the report still goes out, with the plain picture instead
    deps.render = async () => { throw new Error("browser allowance used up"); };
    const c = earn(hub, "小红"); at(hub, c.id, { done_at: sunday + 6 * DAY });
    await weekly(hub, sunday + 7 * DAY, G);
    assert.equal(sent.length, 1); assert.equal(hub.ran.length, 2);
  } finally { deps.render = old; }
});

test("while task news is gathered, an ordinary finished task is a plain line in that message, not a praise of its own", async () => {
  const { flushNotices } = await import("../src/feat/tasks.ts");
  const hub = mkHub({ tasks_announce: "digest" });
  const t = addTask(hub, G, { title: "修首页图片加载慢", owner: "小明", by: "小红" }, true);
  claimTask(hub, G, t.id, "小明", true);
  updateTask(hub, G, t.id, { status: "done", result: "换成了懒加载" }, "小明");
  await Promise.all(hub.waits);
  assert.equal(hub.said.length, 0, "nothing on the spot");
  await flushNotices(hub, Date.now(), true);
  assert.equal(hub.said.length, 1);
  assert.match(hub.said[0], /^【任务】#\d+「修首页图片加载慢」 做完了，小明 拿下：.*\+10 分，这周第 1 件/);
});
