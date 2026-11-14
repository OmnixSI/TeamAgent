// Offline tests for the budget steward: fake hub with in-memory kv, real Plan meters, controllable clock.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Plan, PLAN, DAILY } from "../src/budget.ts";
import feature, { cycleInfo, computePlan, burnRate, classify, classifyDaily, switches, allowed, advice, ensurePlan, loadPlan, history, SWITCHES } from "../src/feat/steward.ts";

const DAY = 86_400_000;
const at = (s) => Date.parse(s);
const realNow = Date.now;
let clock, kv, said, hub;

const setClock = (s) => { clock = at(s); };
function makeHub() {
  kv = new Map(); said = [];
  const h = { get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)), say: async (c, t) => void said.push({ conv: c, text: t }) };
  h.plan = new Plan(h);
  h.set("main", "g:main");
  return h;
}
const use = (name, n) => hub.plan.add(name, n);
// Stored plan with chosen states, for switch tables
const planWith = (states, yesterday = 0) => ({
  day: "2026-11-20", at: clock, cycle: { start: "2026-11-13", end: "2026-12-13", days_total: 30, days_left: 23, elapsed_share: 0.2 },
  meters: Object.fromEntries(Object.keys(PLAN).map(n => [n, { used: 0, stop: PLAN[n].stop, days_left: 23, pace: 0, allowance: 0, day_start_used: 0, burn7: 0, days_at_burn: null, state: states[n] || "ok" }])),
  daily: { ai_neurons: { used_today: 0, yesterday, stop: DAILY.ai_neurons.stop, state: "ok" } },
});
const store = p => hub.set("steward:plan", JSON.stringify(p));
function burnHistory(meter, perDay) {
  const snaps = JSON.parse(hub.get("steward:hist") || '{"snaps":{}}').snaps;
  for (let i = 7; i >= 0; i--) { const d = new Date(clock - i * DAY).toISOString().slice(0, 10); snaps[d] = { ...(snaps[d] || {}), [meter]: (7 - i) * perDay }; }
  hub.set("steward:hist", JSON.stringify({ snaps }));
}

beforeEach(() => { setClock("2026-11-20T00:00:20Z"); Date.now = () => clock; hub = makeHub(); });
afterEach(() => { Date.now = realNow; });

describe("cycle arithmetic", () => {
  test("mid cycle, month length", () => {
    const c = cycleInfo(at("2026-11-20T12:00:00Z"));
    assert.equal(new Date(c.start).toISOString(), "2026-11-13T00:00:00.000Z");
    assert.equal(new Date(c.end).toISOString(), "2026-12-13T00:00:00.000Z");
    assert.equal(c.total, 30);
    assert.equal(c.left, 23);
    assert.ok(Math.abs(c.share - 7.5 / 30) < 1e-9);
  });
  test("first and last day, the 13th itself starts a cycle", () => {
    assert.equal(cycleInfo(at("2026-11-13T00:00:00Z")).left, 30);
    assert.equal(cycleInfo(at("2026-11-13T00:00:00Z")).share, 0);
    assert.equal(cycleInfo(at("2026-12-12T23:59:59Z")).left, 1);
    assert.equal(cycleInfo(at("2026-12-13T00:00:01Z")).left, 31);
  });
  test("before the 13th belongs to the previous month's cycle", () => {
    const c = cycleInfo(at("2026-11-05T10:00:00Z"));
    assert.equal(new Date(c.start).toISOString().slice(0, 10), "2026-10-13");
    assert.equal(c.total, 31);
    assert.equal(c.left, 8);
  });
  test("year boundary", () => {
    const a = cycleInfo(at("2027-01-05T00:00:00Z"));
    assert.equal(new Date(a.start).toISOString().slice(0, 10), "2026-12-13");
    assert.equal(new Date(a.end).toISOString().slice(0, 10), "2027-01-13");
    assert.equal(a.left, 8);
    const b = cycleInfo(at("2026-12-20T00:00:00Z"));
    assert.equal(new Date(b.end).toISOString().slice(0, 10), "2027-01-13");
    assert.equal(b.left, 24);
  });
  test("cycle lengths around February", () => {
    assert.equal(cycleInfo(at("2027-01-20T00:00:00Z")).total, 31);
    assert.equal(cycleInfo(at("2027-02-20T00:00:00Z")).total, 28);
  });
});

describe("pace and allowance", () => {
  test("numbers for a mid-cycle day", () => {
    use("container_cpu_seconds", 3000);
    const p = computePlan(hub, clock).meters.container_cpu_seconds;
    const share = (clock - at("2026-11-13")) / (30 * DAY);
    assert.equal(p.stop, 18000);
    assert.equal(p.days_left, 23);
    assert.ok(Math.abs(p.pace - 18000 * share) < 0.1);
    assert.equal(p.allowance, Math.round((15000 / 23) * 10) / 10);
    assert.equal(p.used, 3000);
  });
  test("first day: a sixth of the month's CPU is far over pace", () => {
    setClock("2026-11-13T00:00:20Z");
    use("container_cpu_seconds", 3000);
    assert.equal(computePlan(hub, clock).meters.container_cpu_seconds.state, "tight");
  });
  test("nothing used on day one is ok, not rich or tight", () => {
    setClock("2026-11-13T00:00:20Z");
    assert.equal(computePlan(hub, clock).meters.browser_seconds.state, "ok");
  });
});

describe("state thresholds", () => {
  const base = { stop: 1000, pace: 400, burn7: 0 };
  test("rich only when more than 25% under pace", () => {
    assert.equal(classify({ ...base, used: 299 }), "rich");
    assert.equal(classify({ ...base, used: 300 }), "ok");
    assert.equal(classify({ ...base, used: 400 }), "ok");
    assert.equal(classify({ ...base, used: 401 }), "tight");
  });
  test("critical: under 3 average days left at the 7-day burn", () => {
    assert.equal(classify({ stop: 1000, pace: 400, used: 100, burn7: 301 }), "critical"); // 900/301 = 2.99
    assert.equal(classify({ stop: 1000, pace: 400, used: 100, burn7: 300 }), "rich");      // exactly 3 days
    assert.equal(classify({ stop: 1000, pace: 400, used: 500, burn7: 100 }), "tight");
    assert.equal(classify({ stop: 1000, pace: 1000, used: 1000, burn7: 5 }), "critical");  // empty
  });
  test("daily meter from yesterday and today", () => {
    const s = 8000;
    assert.equal(classifyDaily(3999, 3999, s), "rich");
    assert.equal(classifyDaily(4000, 100, s), "ok");
    assert.equal(classifyDaily(100, 4000, s), "ok");
    assert.equal(classifyDaily(6401, 0, s), "tight");
    assert.equal(classifyDaily(0, 6401, s), "tight");
    assert.equal(classifyDaily(0, 8000, s), "critical");
  });
  test("daily state is read from kv, yesterday included", () => {
    hub.set("plan:day:2026-11-19:ai_neurons", "7000");
    use("ai_neurons", 100);
    const d = computePlan(hub, clock).daily.ai_neurons;
    assert.equal(d.yesterday, 7000);
    assert.equal(d.used_today, 100);
    assert.equal(d.state, "tight");
  });
});

describe("burn rate from history", () => {
  const c = { start: at("2026-11-13"), share: 0.3 };
  test("average of completed days in the last 7", () => {
    const snaps = { "2026-11-16": { m: 0 }, "2026-11-17": { m: 100 }, "2026-11-18": { m: 400 }, "2026-11-19": { m: 700 }, "2026-11-20": { m: 1000 } };
    assert.equal(burnRate(snaps, "m", at("2026-11-20T06:00:00Z"), 1050, c), 1000 / 4);
  });
  test("days older than a week are ignored", () => {
    const snaps = { "2026-11-05": { m: 0 }, "2026-11-06": { m: 5000 }, "2026-11-19": { m: 5000 }, "2026-11-20": { m: 5070 } };
    assert.equal(burnRate(snaps, "m", at("2026-11-20T06:00:00Z"), 5080, c), 70);
  });
  test("gaps count by their length, a cycle reset pair is skipped", () => {
    const snaps = { "2026-11-11": { m: 9000 }, "2026-11-12": { m: 9500 }, "2026-11-13": { m: 5 }, "2026-11-16": { m: 305 } };
    assert.equal(burnRate(snaps, "m", at("2026-11-16T06:00:00Z"), 320, c), (500 + 300) / (1 + 3));
  });
  test("no completed day yet falls back to the cycle average", () => {
    assert.equal(burnRate({ "2026-11-20": { m: 700 } }, "m", at("2026-11-20T12:00:00Z"), 700, { start: at("2026-11-13"), share: 0.25 }), 700 / 7.5);
  });
  test("computePlan marks critical from stored history", () => {
    burnHistory("browser_seconds", 3000);
    use("browser_seconds", 24000); // 21000 at day start, 6600 left, burn 3000/day
    const m = computePlan(hub, clock).meters.browser_seconds;
    assert.equal(m.burn7, 3000);
    assert.equal(m.days_at_burn, 2.2);
    assert.equal(m.state, "critical");
  });
  test("day-start snapshot is not moved by a later recompute", () => {
    use("r2_reads", 10);
    computePlan(hub, clock);
    use("r2_reads", 90);
    const p = computePlan(hub, clock + 3600_000);
    assert.equal(p.meters.r2_reads.day_start_used, 10);
    assert.equal(p.meters.r2_reads.used, 100);
  });
});

describe("switches", () => {
  const S = ["rich", "ok", "tight", "critical"];
  const bad = x => x === "tight" || x === "critical";
  test("repo_builds and repo_full only when CPU is rich", () => {
    for (const s of S) {
      store(planWith({ container_cpu_seconds: s }));
      assert.equal(allowed(hub, "repo_builds"), s === "rich", s);
      assert.equal(allowed(hub, "repo_full"), s === "rich", s);
    }
  });
  test("preview_auto needs cpu, container time and browser all not tight", () => {
    for (const a of S) for (const b of S) for (const c of S) {
      store(planWith({ container_cpu_seconds: a, container_seconds: b, browser_seconds: c }));
      assert.equal(allowed(hub, "preview_auto"), !bad(a) && !bad(b) && !bad(c), [a, b, c].join());
    }
  });
  test("media_heavy follows CPU, browser_heavy follows browser, independent of each other", () => {
    for (const s of S) {
      store(planWith({ container_cpu_seconds: s, browser_seconds: "rich" }));
      assert.equal(allowed(hub, "media_heavy"), !bad(s));
      assert.equal(allowed(hub, "browser_heavy"), true);
      store(planWith({ container_cpu_seconds: "rich", browser_seconds: s }));
      assert.equal(allowed(hub, "browser_heavy"), !bad(s));
      assert.equal(allowed(hub, "media_heavy"), true);
    }
  });
  test("index_boost when yesterday stayed under half the stop line", () => {
    store(planWith({}, 3999)); assert.equal(allowed(hub, "index_boost"), true);
    store(planWith({}, 4000)); assert.equal(allowed(hub, "index_boost"), false);
    store(planWith({}, 0)); assert.equal(allowed(hub, "index_boost"), true);
  });
  test("every switch carries a reason", () => {
    for (const p of [null, planWith({ container_cpu_seconds: "tight" }), planWith({ container_cpu_seconds: "rich" })])
      for (const k of SWITCHES) assert.ok(switches(p)[k].why.length > 3);
  });
  test("unknown activity is refused", () => { store(planWith({})); assert.equal(allowed(hub, "nope"), false); });
});

describe("safe defaults", () => {
  test("no plan: cheap and requested things on, heavy optional extras off", () => {
    assert.equal(loadPlan(hub), null);
    assert.deepEqual(Object.fromEntries(SWITCHES.map(k => [k, allowed(hub, k)])),
      { repo_builds: false, repo_full: false, preview_auto: true, index_boost: false, media_heavy: true, browser_heavy: true });
    assert.equal(advice(hub, "container_cpu_seconds", 1e9), null);
  });
  test("a plan older than two days counts as no plan", () => {
    store(planWith({ container_cpu_seconds: "rich" }));
    assert.equal(allowed(hub, "repo_builds"), true);
    clock += 2 * DAY + 1;
    assert.equal(allowed(hub, "repo_builds"), false);
  });
  test("corrupt plan is ignored", () => { hub.set("steward:plan", "{oops"); assert.equal(allowed(hub, "repo_builds"), false); assert.equal(allowed(hub, "media_heavy"), true); });
});

describe("daily recompute", () => {
  test("tick computes once per UTC day", async () => {
    use("browser_seconds", 100);
    await feature.tick(hub, clock);
    const first = hub.get("steward:plan");
    assert.ok(first);
    use("browser_seconds", 500);
    await feature.tick(hub, clock + 3600_000);
    assert.equal(hub.get("steward:plan"), first);
    await feature.tick(hub, clock + DAY);
    assert.notEqual(hub.get("steward:plan"), first);
    assert.equal(JSON.parse(hub.get("steward:plan")).day, "2026-11-21");
  });
  test("admin recompute forces it", async () => {
    await feature.tick(hub, clock);
    use("browser_seconds", 500);
    const u = "http://x/admin/steward";
    const r = await feature.admin(hub, new Request(u, { method: "POST" }), new URL(u), { recompute: true });
    const j = await r.json();
    assert.equal(j.plan.meters.browser_seconds.used, 500);
    assert.ok(j.switches.repo_builds && Array.isArray(j.history));
    const g = await (await feature.admin(hub, new Request(u), new URL(u), null)).json();
    assert.equal(g.ok, true);
    assert.equal(await feature.admin(hub, new Request("http://x/admin/other"), new URL("http://x/admin/other"), null), null);
  });
});

describe("announcements", () => {
  test("critical meter is announced once per cycle, with what stops and the reset", async () => {
    burnHistory("container_seconds", 9000);
    use("container_seconds", 69000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 1);
    assert.equal(said[0].conv, "g:main");
    assert.match(said[0].text, /云电脑时间/);
    assert.match(said[0].text, /还剩 50 分钟/);
    assert.match(said[0].text, /13 号重置/);
    assert.match(said[0].text, /12 月 13 日/);
    await ensurePlan(hub, clock + 3600_000, true);
    await ensurePlan(hub, clock + DAY, true);
    assert.equal(said.filter(s => /云电脑时间/.test(s.text)).length, 1);
  });
  test("each meter has its own announcement, and a new cycle announces again", async () => {
    burnHistory("container_seconds", 9000);
    burnHistory("browser_seconds", 9000);
    use("container_seconds", 69000);
    use("browser_seconds", 27000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 2);
    setClock("2026-12-20T00:00:20Z");
    hub.set("steward:hist", '{"snaps":{}}');
    burnHistory("container_seconds", 9000);
    use("container_seconds", 69000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.filter(s => /云电脑时间/.test(s.text)).length, 2);
  });
  test("no main group, no message and no mark", async () => {
    kv.delete("main");
    burnHistory("container_seconds", 9000); use("container_seconds", 69000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 0);
    hub.set("main", "g:main");
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 1);
  });
  test("end-of-cycle notice: last 5 days, rich, more than 40% unused", async () => {
    setClock("2026-12-08T00:00:20Z");
    assert.equal(cycleInfo(clock).left, 5);
    use("container_seconds", 20000);
    use("browser_seconds", 26000); use("container_cpu_seconds", 15500); // over pace, so it stays out of the notice
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 1);
    assert.doesNotMatch(said[0].text, /浏览器/);
    assert.match(said[0].text, /云电脑还剩 14\.4 小时没用/);
    assert.match(said[0].text, /尽管叫我/);
    await ensurePlan(hub, clock + DAY, true);
    assert.equal(said.length, 1);
  });
  test("not with 6 days left, not when merely ok, not at exactly 40% unused", async () => {
    setClock("2026-12-07T00:00:20Z");
    assert.equal(cycleInfo(clock).left, 6);
    use("container_seconds", 20000);
    use("browser_seconds", 26000); use("container_cpu_seconds", 15500);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 0);
    setClock("2026-12-08T00:00:20Z");
    hub = makeHub();
    use("browser_seconds", 26000); use("container_cpu_seconds", 15500);
    use("container_seconds", 50000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 0);
    hub = makeHub();
    use("browser_seconds", 26000); use("container_cpu_seconds", 15500);
    use("container_seconds", 43200);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 0);
  });
  test("computer and browser parts share one line", async () => {
    setClock("2026-12-10T00:00:20Z");
    use("container_seconds", 1000);
    use("browser_seconds", 1000);
    await ensurePlan(hub, clock, true);
    assert.equal(said.length, 1);
    assert.equal(said[0].text.split("\n").length, 1);
    assert.match(said[0].text, /云电脑还剩.*浏览器还剩/);
  });
});

describe("advice", () => {
  const share = 18000 / 23; // day_start_used 0, 23 days left
  beforeEach(() => store(planWith({})));
  test("null when the amount fits today's remaining share", () => {
    assert.equal(advice(hub, "container_cpu_seconds", share), null);
    assert.equal(advice(hub, "container_cpu_seconds", 100), null);
  });
  test("a sentence when it does not, naming the monthly limit", () => {
    const s = advice(hub, "container_cpu_seconds", share + 1);
    assert.match(s, /云电脑算力/);
    assert.match(s, /份额/);
    assert.match(s, /按月/);
    assert.match(s, /12 月 13 日/);
  });
  test("what is already used today counts against the share", () => {
    use("container_cpu_seconds", 700);
    assert.equal(advice(hub, "container_cpu_seconds", share - 700), null);
    assert.ok(advice(hub, "container_cpu_seconds", share - 699));
    use("container_cpu_seconds", 5000);
    assert.match(advice(hub, "container_cpu_seconds", 1), /只剩约 0 秒/);
  });
  test("zero amount, unknown meter", () => {
    assert.equal(advice(hub, "container_cpu_seconds", 0), null);
    assert.equal(advice(hub, "bogus", 10), null);
  });
  test("daily meter speaks about the day, not the month", () => {
    use("ai_neurons", 7500);
    assert.equal(advice(hub, "ai_neurons", 500), null);
    const s = advice(hub, "ai_neurons", 501);
    assert.match(s, /按天/);
    assert.doesNotMatch(s, /按月/);
  });
});

describe("tool and history", () => {
  const tool = () => feature.tools({ hub, conv: "t:x", askers: [], host: {} })[0];
  test("description says when to use it", () => {
    assert.match(tool().description, /额度还够不够/);
    assert.match(tool().description, /今天还能用多少/);
    assert.match(tool().description, /为什么某件事被推迟/);
  });
  test("plan op returns Chinese numbers and every switch", async () => {
    use("container_cpu_seconds", 4000);
    const r = await tool().run({ op: "plan" });
    assert.equal(r.ok, true);
    const cpu = r.meters.find(m => m.what === "云电脑算力");
    assert.match(cpu.used, /67 分钟/);
    assert.match(cpu.today_share, /今天的份额/);
    assert.equal(r.optional.length, SWITCHES.length);
    assert.ok(r.optional.every(o => typeof o.on === "boolean" && o.why));
    assert.equal(r.optional.find(o => o.key === "repo_builds").on, false);
  });
  test("history op: daily use from snapshots, today live", async () => {
    hub.set("steward:hist", JSON.stringify({ snaps: { "2026-11-18": { browser_seconds: 0 }, "2026-11-19": { browser_seconds: 120 }, "2026-11-20": { browser_seconds: 300 } } }));
    hub.set("plan:day:2026-11-19:ai_neurons", "900");
    use("browser_seconds", 330);
    const rows = history(hub, 3);
    assert.deepEqual(rows.map(r => r.date), ["2026-11-18", "2026-11-19", "2026-11-20"]);
    assert.deepEqual(rows.map(r => r.browser_seconds), [120, 180, 30]);
    assert.equal(rows[1].ai_neurons, 900);
    const r = await tool().run({ op: "history", days: 2 });
    assert.equal(r.days.length, 2);
    assert.equal((await tool().run({ op: "x" })).ok, false);
  });
});
