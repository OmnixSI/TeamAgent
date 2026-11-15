import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import tasksFeature, { addTask, claimTask, updateTask } from "../src/feat/tasks.ts";
import feature, { teamStats, honorWall, weekStart, weeklyTask } from "../src/feat/teamwork.ts";
import * as contrib from "../src/feat/contrib.ts";

const G = "g:1", HOUR = 3600000, DAY = 86400000;
const bj = s => Date.parse(s + "+08:00"), iso = ts => new Date(ts).toISOString();
const SINCE = bj("2026-11-15T21:56:00"), NOW = bj("2026-11-18T15:00:00");   // a Wednesday; the week began on the 16th
function mkHub(owner = "") {
  const db = new DatabaseSync(":memory:"); db.exec(tasksFeature.schema); db.exec(feature.schema);
  const kv = new Map(), said = [], waits = [];
  return {
    db, said, waits, env: {},
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = st.columns().length ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    say: async (conv, text) => { said.push(text); return true; }, runTask: async () => {},
    ctx: { waitUntil: p => waits.push(p) }, edit: { cfg: () => "on", rank: (_c, askers) => (askers?.some(a => a.name === owner) ? "owner" : "member") },
    get: k => kv.get(k) ?? null, set: (k, v) => kv.set(k, String(v)),
  };
}
const at = (hub, id, f) => hub.db.prepare("UPDATE task SET " + Object.keys(f).map(k => k + "=?").join(",") + " WHERE id=?").run(...Object.values(f), id);
const tool = (hub, name) => feature.tools({ hub, conv: G, askers: name ? [{ id: "u" + name, name }] : [], host: {} })[0];

/** A pretend GitHub with one repository. */
function fakeGitHub(o) {
  const calls = [];
  contrib.deps.gh = async (_hub, path) => {
    calls.push(path);
    if (path.startsWith("/orgs/")) return [{ name: "shop", pushed_at: iso(NOW), updated_at: iso(NOW) }, { name: "old", archived: true }];
    let m;
    if (/\/pulls\?/.test(path)) return o.pulls || [];
    if ((m = /\/pulls\/(\d+)\/commits/.exec(path))) return (o.prCommits || {})[m[1]] || [];
    if ((m = /\/pulls\/(\d+)\/reviews/.exec(path))) return (o.reviews || {})[m[1]] || [];
    if ((m = /\/pulls\/(\d+)$/.exec(path))) return (o.pulls || []).find(p => p.number === Number(m[1])) || null;
    if (/\/issues\?/.test(path)) return o.issues || [];
    if (/\/commits\?/.test(path)) return o.commits || [];
    throw new Error("unexpected " + path);
  };
  return calls;
}
const user = login => ({ login, type: "User" });
const pr = (n, login, o = {}) => ({ number: n, title: "PR " + n, html_url: "https://github.test/shop/pull/" + n, user: user(login), head: { ref: o.ref || "feat/x" }, created_at: iso(o.created ?? NOW - HOUR), updated_at: iso(o.updated ?? NOW - HOUR), merged_at: o.merged ? iso(o.merged) : null, merged_by: o.by ? user(o.by) : null });

test("starting over: tasks finished and points spent before the moment score nothing; the list and past stars stay", () => {
  const hub = mkHub();
  contrib.RULES.claim.points = 0;
  const old = addTask(hub, G, { title: "旧活", owner: "小明", size: "big" }, true), fresh = addTask(hub, G, { title: "新活", owner: "小明" }, true);
  for (const t of [old, fresh]) updateTask(hub, G, t.id, { status: "done" }, "小明", true);
  at(hub, old.id, { done_at: SINCE - HOUR, claimed_at: SINCE - 2 * HOUR }); at(hub, fresh.id, { done_at: NOW - HOUR, claimed_at: NOW - 2 * HOUR });
  hub.db.prepare("INSERT INTO team_spend(conv, who, item, name, cost, ts, state) VALUES(?,?,?,?,?,?,?)").run(G, "小明", "meme", "表情包", 5, SINCE - 30 * 60000, "done");
  hub.db.prepare("INSERT INTO team_star(conv, week, who, points, done) VALUES(?,?,?,?,?)").run(G, weekStart(SINCE), "小明", 55, 5);
  let me = teamStats(hub, G, NOW).people.find(p => p.name === "小明");
  assert.deepEqual([me.points_total, me.spent, me.balance, me.done_total, me.stars], [30 + 10 + 20, 5, 55, 2, 1], "before any restart everything counts");
  assert.equal(contrib.restart(hub, G, SINCE, "群主"), SINCE);
  const stats = teamStats(hub, G, NOW); me = stats.people.find(p => p.name === "小明");
  assert.equal(stats.since, SINCE);
  assert.deepEqual([me.points_total, me.spent, me.balance, me.done_total, me.stars], [10, 0, 10, 1, 0]);
  assert.equal(me.title, "本周之星", "the reigning star still wears the title");
  const wall = honorWall(hub, G, NOW);
  assert.equal(wall.stars.length, 1, "past stars stay on the wall"); assert.equal(wall.bosses.length, 0, "the old boss fight is history");
  assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM task").get().n, 2, "nothing is deleted");
  // a star named after the restart keeps its bonus
  hub.db.prepare("INSERT INTO team_star(conv, week, who, points, done) VALUES(?,?,?,?,?)").run(G, weekStart(NOW), "小明", 10, 1);
  assert.equal(teamStats(hub, G, NOW + 7 * DAY).people.find(p => p.name === "小明").points_total, 30);
  contrib.RULES.claim.points = 1;
});

test("accounts, issue worth, and a Beijing time", () => {
  const hub = mkHub();
  assert.equal(contrib.linkLogin(hub, G, "@Jinyi5077", "t.o.o."), true); assert.equal(contrib.linkLogin(hub, G, "spdore", "卡特龙"), true);
  assert.equal(contrib.linkLogin(hub, G, "not a login!", "x"), false); assert.equal(contrib.linkLogin(hub, G, "ok", ""), false);
  contrib.linkLogin(hub, G, "spdore", "卡特龙本人");
  assert.deepEqual(contrib.logins(hub, G), [{ login: "jinyi5077", who: "t.o.o." }, { login: "spdore", who: "卡特龙本人" }]);
  assert.equal(contrib.unlinkLogin(hub, G, "SPDORE"), true); assert.equal(contrib.unlinkLogin(hub, G, "spdore"), false);
  assert.equal(contrib.issuePoints(""), 0); assert.equal(contrib.issuePoints("坏了"), 0);
  assert.equal(contrib.issuePoints("登录页在手机上点提交没有反应，控制台有一条报错，复现三次都一样。"), 1);
  assert.equal(contrib.issuePoints("## 现象\n" + "手机上点提交没有反应。".repeat(8) + "\n\n## 位置\nsrc/login.ts 第 40 行的判断写反了，导致空密码也会通过校验。\n\n## 修法\n" + "把判断改回来并补一个测试。".repeat(6)), 2);
  assert.equal(contrib.parseWhen("2026-11-15 21:56"), SINCE); assert.equal(contrib.parseWhen("昨天"), 0);
});

test("reading the repositories: each thing once, the bot's and robots' work left out, commits that came through a pull request not counted twice", async () => {
  const hub = mkHub();
  contrib.restart(hub, G, SINCE);
  for (const [l, w] of [["spdore", "卡特龙"], ["Jinyi5077", "t.o.o."], ["ooooooomygosh", "群主"]]) contrib.linkLogin(hub, G, l, w);
  const day = bj("2026-11-17T10:00:00");
  const calls = fakeGitHub({
    pulls: [
      pr(7, "Jinyi5077", { created: day, merged: day + HOUR, by: "ooooooomygosh" }),          // merged by someone else
      pr(8, "spdore", { created: day + 2 * HOUR }),                                              // open
      pr(9, "ooooooomygosh", { created: day, merged: day + HOUR, ref: "bot/fix-typo-20261117" }), // the group bot's own
      pr(6, "spdore", { created: SINCE - DAY, merged: SINCE - HOUR, updated: day }),              // before the season
      { ...pr(5, "dependabot[bot]", { created: day }), user: { login: "dependabot[bot]", type: "Bot" } },
    ],
    prCommits: { 7: [{ sha: "aaa1", author: user("Jinyi5077") }, { sha: "aaa2", author: user("Jinyi5077") }] },
    reviews: { 7: [{ user: user("spdore"), state: "APPROVED", submitted_at: iso(day + 30 * 60000) }, { user: user("Jinyi5077"), state: "COMMENTED", submitted_at: iso(day + 31 * 60000) }, { user: user("spdore"), state: "COMMENTED", submitted_at: iso(day + 40 * 60000) }] },
    issues: [
      { number: 20, title: "提交没反应", body: "登录页在手机上点提交没有反应，控制台有一条报错，复现三次都一样。", html_url: "u", user: user("spdore"), created_at: iso(day) },
      { number: 21, title: "只有标题", body: "", html_url: "u", user: user("spdore"), created_at: iso(day) },
      { number: 7, title: "PR 7", body: "x".repeat(300), pull_request: {}, user: user("Jinyi5077"), created_at: iso(day) },
    ],
    commits: [
      { sha: "aaa1", parents: [{}], author: user("Jinyi5077"), html_url: "u", commit: { message: "part of PR 7", author: { date: iso(day) } } },
      { sha: "mmm1", parents: [{}, {}], author: user("ooooooomygosh"), html_url: "u", commit: { message: "Merge pull request #7", author: { date: iso(day + HOUR) } } },
      { sha: "sss1", parents: [{}], author: user("spdore"), html_url: "u", commit: { message: "Fix the footer (#4)", author: { date: iso(day) } } },
      { sha: "ddd1", parents: [{}], author: user("spdore"), html_url: "u", commit: { message: "Fix a typo on main", author: { date: iso(day + HOUR) } } },
      { sha: "ccc1", parents: [{}], author: user("codex"), html_url: "u", commit: { message: "Direct push by a tool account", author: { date: iso(day) } } },
    ],
  });
  const first = await contrib.syncRepos(hub, G, NOW);
  assert.deepEqual([first.repos, first.errors], [2, []]);
  const ev = contrib.events(hub, G, NOW).map(e => [e.who, e.kind, e.repo + (e.num ? "#" + e.num : ""), e.points]);
  assert.deepEqual(ev.sort(), [
    ["t.o.o.", "pr_merged", "shop#7", 10], ["t.o.o.", "pr_opened", "shop#7", 2],
    ["卡特龙", "commit", "shop#ddd1", 0.5], ["卡特龙", "issue", "shop#20", 1], ["卡特龙", "pr_opened", "shop#8", 2], ["卡特龙", "review", "shop#7", 2],
    ["群主", "merge", "shop#7", 1],
  ].sort());
  assert.deepEqual(contrib.strangers(hub, G), [{ login: "codex", events: 1 }], "work by an account nobody was matched to is listed, not scored");
  assert.ok(!calls.some(c => c.includes("/repos/OmnixSI/old/")), "an archived repository is not read");
  assert.equal((await contrib.syncRepos(hub, G, NOW + HOUR)).added, 0, "a second look adds nothing");
  const stats = teamStats(hub, G, NOW), by = Object.fromEntries(stats.people.map(p => [p.name, p]));
  assert.deepEqual([by["t.o.o."].points_week, by["卡特龙"].points_week, by["群主"].points_week], [12, 5.5, 1]);
  assert.deepEqual(by["卡特龙"].activity.kinds, { issue: { n: 1, points: 1 }, review: { n: 1, points: 2 }, pr_opened: { n: 1, points: 2 }, commit: { n: 1, points: 0.5 } });
  assert.equal(stats.mvp, "t.o.o."); assert.equal(stats.week.points, 18.5);
  assert.match(weeklyTask(stats, []), /其中仓库和接活得分":12[\s\S]*PR 合并 1 次/);
  // matching the stray account afterwards moves its work to that person without reading GitHub again
  contrib.linkLogin(hub, G, "codex", "t.o.o.");
  assert.equal(teamStats(hub, G, NOW).people.find(p => p.name === "t.o.o.").points_week, 12.5);
});

test("daily limits: per kind and 20 a day in all; what is over is kept apart; picking tasks up counts once and not when put back", async () => {
  const hub = mkHub();
  contrib.restart(hub, G, SINCE); contrib.linkLogin(hub, G, "spdore", "卡特龙");
  const day = bj("2026-11-17T09:00:00");
  fakeGitHub({
    pulls: [...Array(5)].map((_, i) => pr(30 + i, "spdore", { created: day + i * 60000 })).concat([pr(40, "spdore", { created: day, merged: day + HOUR, by: "spdore" }), pr(41, "spdore", { created: day, merged: day + 2 * HOUR, by: "spdore" })]),
    issues: [...Array(12)].map((_, i) => ({ number: 100 + i, title: "问题 " + i, body: "登录页在手机上点提交没有反应，控制台有一条报错，复现三次都一样。", html_url: "u", user: user("spdore"), created_at: iso(day + i * 60000) })),
  });
  await contrib.syncRepos(hub, G, NOW);
  const a = contrib.activity(hub, G, weekStart(NOW), NOW).get("卡特龙");
  // opened 7 × 2 = 14 → 6; issues 12 → 8; merged 2 × 10 = 20; no merge points for merging one's own: 34 → 20 for the day
  assert.deepEqual([a.week, a.total, a.over_week, a.kinds.pr_opened.n, a.kinds.issue.n, a.kinds.pr_merged.n], [20, 20, 26, 7, 12, 2]);
  const p = teamStats(hub, G, NOW).people.find(x => x.name === "卡特龙");
  assert.equal(p.points_total, 20); assert.equal(p.balance, 20); assert.equal(p.activity.over_total, 26);
  // claims
  const t1 = addTask(hub, G, { title: "接一件", by: "x" }, true), t2 = addTask(hub, G, { title: "接了又放下", by: "x" }, true), t3 = addTask(hub, G, { title: "本地 AI 接的", by: "x" }, true);
  claimTask(hub, G, t1.id, "小红", true); claimTask(hub, G, t2.id, "小红", true); updateTask(hub, G, t2.id, { status: "open" }, "小红", true); claimTask(hub, G, t3.id, "小红的本地 AI", true);
  const mine = contrib.events(hub, G, Date.now()).filter(e => e.kind === "claim").map(e => [e.who, e.num]);
  assert.deepEqual(mine.sort(), [["小红", String(t1.id)], ["小红", String(t3.id)]].sort());
  assert.equal(teamStats(hub, G, Date.now()).people.find(x => x.name === "小红").activity.total, 2);
});

test("the chat tool: only the owner starts over, accounts are matched by the owner or a trusted member, activity lists what was counted", async () => {
  const hub = mkHub("群主");
  hub.edit.rank = (_c, askers) => (askers?.some(a => a.name === "群主") ? "owner" : "member");
  assert.match((await tool(hub, "小明").run({ op: "restart" })).error, /只有群主/);
  assert.match((await tool(hub, "群主").run({ op: "restart", at: "明天" })).error, /看不懂/);
  const when = new Date(Date.now() - 3 * HOUR + 8 * HOUR).toISOString().slice(0, 16).replace("T", " ");   // three hours ago, as a Beijing time
  const r = await tool(hub, "群主").run({ op: "restart", at: when });
  assert.equal(r.counting_from, when + "（北京时间）"); assert.equal(contrib.sinceOf(hub, G), contrib.parseWhen(when));
  assert.match((await tool(hub, "小明").run({ op: "link_github", login: "spdore", who: "卡特龙" })).error, /群主或被授权/);
  assert.deepEqual((await tool(hub, "群主").run({ op: "link_github", login: "spdore", who: "卡特龙" })).accounts, ["spdore = 卡特龙"]);
  fakeGitHub({ pulls: [pr(3, "spdore", { created: Date.now() - HOUR, merged: Date.now() - 30 * 60000, by: "spdore" })] });
  const a = await tool(hub, "小明").run({ op: "activity", refresh: true });
  assert.equal(a.refreshed.new_events, 2); assert.deepEqual(a.people, [{ name: "卡特龙", points_this_week: 12, points_total: 12 }]);
  assert.match(a.events[0], /卡特龙 PR 合并 \+10 shop#3 PR 3$/);
  const s = await tool(hub, "小明").run({ op: "status" });
  assert.ok(s.counting_from.startsWith(when)); assert.equal(s.people[0].repo_and_claims.points_total, 12);
  // the timer reads the main group's repositories at most every half hour, and only once accounts are matched
  hub.set("main", G); hub.waits.length = 0;
  contrib.tick(hub, Date.now() + 5 * 60000); assert.equal(hub.waits.length, 0);
  contrib.tick(hub, Date.now() + 40 * 60000); assert.equal(hub.waits.length, 1); await Promise.all(hub.waits);
});
