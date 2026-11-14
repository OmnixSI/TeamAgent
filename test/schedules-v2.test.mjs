import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// D3b：日程 v2。依赖 D0 的表、D2 的解析、D3a 的动作层——三个包都可能还没合，
// 所以这里用 esbuild 插件把 ./schedule-parse 与 ./actions 换成受本测试控制的 stub
// （签名照 design §5.4/§5.5）。被测代码本身只认真模块的接口。
const GROUP = "GROUP000001";
const at = (s) => Date.parse(s);

const ACTIONS_STUB = `
export function validateSteps(steps) { return globalThis.__d3bActions.validateSteps(steps); }
export async function runSteps(ctx, steps) { return globalThis.__d3bActions.runSteps(ctx, steps); }
export function joinResults(results, title) { return globalThis.__d3bActions.joinResults(results, title); }
export async function composeWithNote(ctx, results, note) { return globalThis.__d3bActions.composeWithNote(ctx, results, note); }
`;

const PARSE_STUB = `
export function parseWhen(text, now, defaultTz) { return globalThis.__d3bParse.parseWhen(text, now, defaultTz); }
export function parseContent(text) { return globalThis.__d3bParse.parseContent(text); }
export function describeWhen(when, now) { return globalThis.__d3bParse.describeWhen(when, now); }
`;

function aliasDeps(stubs) {
  return {
    name: "d3b-stub-deps",
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?\/actions$/ }, () => ({ path: "actions", namespace: "d3b" }));
      builder.onResolve({ filter: /^\.\.?\/schedule-parse$/ }, () => ({ path: "schedule-parse", namespace: "d3b" }));
      builder.onLoad({ filter: /^actions$/, namespace: "d3b" }, () => ({ contents: ACTIONS_STUB, loader: "ts" }));
      builder.onLoad({ filter: /^schedule-parse$/, namespace: "d3b" }, () => ({ contents: PARSE_STUB, loader: "ts" }));
    },
  };
}

const built = new Map();
async function bundle(entry, extra = "") {
  const key = entry + extra;
  if (!built.has(key)) {
    const outfile = `.wrangler/d3b-${entry.replace(/\W/g, "-")}-${process.pid}${extra ? "-" + extra : ""}.mjs`;
    await build({
      stdin: { contents: `export * from "./src/${entry}";`, resolveDir: process.cwd(), loader: "ts" },
      bundle: true,
      platform: "browser",
      format: "esm",
      outfile,
      plugins: [aliasDeps()],
    });
    built.set(key, await import("../" + outfile));
  }
  return built.get(key);
}

// ---------- 假 D1：schema.sql + D0 目标形态的 schedules/pending_actions ----------
function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  d.exec(`
DROP TABLE IF EXISTS schedules;
CREATE TABLE schedules(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute','agent_task')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled','paused')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX schedules_due ON schedules(status,next_run_at);
CREATE INDEX schedules_group ON schedules(group_id,status);
CREATE TABLE IF NOT EXISTS pending_actions(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender TEXT NOT NULL,
  tool TEXT NOT NULL, draft TEXT NOT NULL, missing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions(group_id,sender,status,expires_at);
`);
  const database = {
    executed: 0,
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) {
          return statement(values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)));
        },
        async first() {
          database.executed++;
          return d.prepare(sql).get(...args) || null;
        },
        async all() {
          database.executed++;
          return { results: d.prepare(sql).all(...args) };
        },
        async run() {
          database.executed++;
          return d.prepare(sql).run(...args);
        },
      });
      return statement();
    },
    async batch(ss) {
      return Promise.all(ss.map((s) => (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run())));
    },
    raw: d,
  };
  return database;
}

function env() {
  return { DB: db(), MODEL: "deepseek-flash", WORK: { sent: [], async send() {} } };
}

const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

function owner(e, sender = "U1") {
  e.DB.raw.prepare("INSERT OR IGNORE INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,'owner',0)").run(
    "qq:" + sender,
    "Owner",
    "hash-" + sender,
  );
}

// stub：D3a 动作层。默认每步都成功，成文就是标题；测试可按需改。
const actionCalls = [];
function resetDeps() {
  actionCalls.length = 0;
  globalThis.__d3bActions = {
    validateSteps: (steps) =>
      Array.isArray(steps) && steps.length && steps.length <= 6
        ? { ok: true, steps }
        : { ok: false, reason: "步骤必须 1–6 步" },
    runSteps: async (ctx, steps) => {
      actionCalls.push({ ctx, steps });
      return steps.map((s) => ({ action: s.action, ok: true, text: `${s.action} 结果` }));
    },
    joinResults: (results, title) => `${title || "定时任务"}：` + results.map((r) => r.text).join(" / "),
    composeWithNote: async (_ctx, results, note) => `${note}（${results.length} 段）`,
  };
  globalThis.__d3bParse = {
    parseWhen: () => null,
    parseContent: () => [],
    describeWhen: (when) => `每天 ${when.time}（${when.tz}）`,
  };
}
resetDeps();

function seedSchedule(e, fields) {
  const spec = fields.spec || {};
  e.DB.raw
    .prepare(
      "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      fields.id,
      fields.group_id || GROUP,
      fields.owner || "U1",
      fields.kind || "agent_task",
      fields.tz || "Australia/Sydney",
      JSON.stringify(spec),
      fields.status || "active",
      fields.next_run_at ?? null,
      fields.fail_count ?? 0,
      fields.created_at ?? at("2026-11-01T00:00:00+11:00"),
      fields.source_msg_id ?? null,
    );
  return fields.id;
}

function toolCtx(body = "", sender = "U1", id = "msg-1") {
  return {
    context: { latest: { group_id: GROUP, sender, id, body } },
    source: { id, sender, body },
    messages: [],
    isTainted: () => false,
  };
}

// ---------- A. nextRun：monthly / every / once / DST ----------
test("A1 monthly: next 1st 09:00 across the year", async () => {
  const api = await bundle("schedules");
  const spec = { time: "09:00", cadence: "monthly", month_days: [1] };
  assert.equal(
    api.nextRun(spec, at("2026-11-15T12:00:00+11:00"), "Australia/Sydney"),
    at("2026-12-01T09:00:00+11:00"),
  );
  // 当天 09:00 之前，就是当天
  assert.equal(
    api.nextRun(spec, at("2026-12-01T08:00:00+11:00"), "Australia/Sydney"),
    at("2026-12-01T09:00:00+11:00"),
  );
});

test("A2 monthly: -1 means the last day", async () => {
  const api = await bundle("schedules");
  const spec = { time: "09:00", cadence: "monthly", month_days: [-1] };
  assert.equal(
    api.nextRun(spec, at("2026-11-15T12:00:00+11:00"), "Australia/Sydney"),
    at("2026-11-30T09:00:00+11:00"),
  );
  assert.equal(
    api.nextRun(spec, at("2027-02-01T00:00:00+11:00"), "Australia/Sydney"),
    at("2027-02-28T09:00:00+11:00"),
  );
});

test("A3 monthly: a date that does not exist is skipped, not rolled over", async () => {
  const api = await bundle("schedules");
  const spec = { time: "09:00", cadence: "monthly", month_days: [31] };
  assert.equal(
    api.nextRun(spec, at("2026-04-01T00:00:00+10:00"), "Australia/Sydney"),
    at("2026-05-31T09:00:00+10:00"),
  );
  const feb = { time: "09:00", cadence: "monthly", month_days: [30] };
  assert.equal(
    api.nextRun(feb, at("2027-01-31T12:00:00+11:00"), "Australia/Sydney"),
    at("2027-03-30T09:00:00+11:00"),
  );
});

test("A4 monthly: every matching day in the same month picks the earliest", async () => {
  const api = await bundle("schedules");
  const spec = { time: "08:30", cadence: "monthly", month_days: [15, 1] };
  assert.equal(
    api.nextRun(spec, at("2026-11-01T09:00:00+11:00"), "Australia/Sydney"),
    at("2026-11-15T08:30:00+11:00"),
  );
});

test("A5 every: without a window it is now + minutes", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-15T10:00:00+11:00");
  assert.equal(api.nextRun({ cadence: "every", every_minutes: 30 }, now, "Australia/Sydney"), now + 30 * 60000);
  // 小于 5 分钟按 5 分钟收口
  assert.equal(api.nextRun({ cadence: "every", every_minutes: 1 }, now, "Australia/Sydney"), now + 5 * 60000);
});

test("A6 every: slots align to the window, and roll to tomorrow after it", async () => {
  const api = await bundle("schedules");
  const spec = { cadence: "every", every_minutes: 30, window: ["09:00", "22:00"] };
  assert.equal(
    api.nextRun(spec, at("2026-11-15T08:10:00+11:00"), "Australia/Sydney"),
    at("2026-11-15T09:00:00+11:00"),
  );
  assert.equal(
    api.nextRun(spec, at("2026-11-15T09:10:00+11:00"), "Australia/Sydney"),
    at("2026-11-15T09:30:00+11:00"),
  );
  assert.equal(
    api.nextRun(spec, at("2026-11-15T21:50:00+11:00"), "Australia/Sydney"),
    at("2026-11-16T09:00:00+11:00"),
  );
});

test("A7 every: until caps the series", async () => {
  const api = await bundle("schedules");
  const spec = {
    cadence: "every",
    every_minutes: 30,
    window: ["09:00", "22:00"],
    until: at("2026-11-15T10:00:00+11:00"),
  };
  assert.equal(
    api.nextRun(spec, at("2026-11-15T09:20:00+11:00"), "Australia/Sydney"),
    at("2026-11-15T09:30:00+11:00"),
  );
  assert.equal(api.nextRun(spec, at("2026-11-15T10:00:00+11:00"), "Australia/Sydney"), null);
});

test("A8 once: run_at in the future, null once it passed", async () => {
  const api = await bundle("schedules");
  const spec = { cadence: "once", run_at: at("2026-11-16T15:00:00+11:00") };
  assert.equal(
    api.nextRun(spec, at("2026-11-15T12:00:00+11:00"), "Australia/Sydney"),
    at("2026-11-16T15:00:00+11:00"),
  );
  assert.equal(api.nextRun(spec, at("2026-11-16T15:00:01+11:00"), "Australia/Sydney"), null);
});

test("A9 DST: 08:00 stays 08:00 on both sides of the change", async () => {
  const api = await bundle("schedules");
  const spec = { time: "08:00" };
  assert.equal(
    api.nextRun(spec, at("2026-11-14T12:00:00+11:00"), "Australia/Sydney"),
    at("2026-11-15T08:00:00+11:00"),
  );
  assert.equal(
    api.nextRun(spec, at("2027-05-14T12:00:00+10:00"), "Australia/Sydney"),
    at("2027-05-15T08:00:00+10:00"),
  );
  assert.equal(
    api.nextRun({ time: "00:00", tz: "Asia/Shanghai" }, at("2026-11-14T12:00:00+11:00"), "Asia/Shanghai"),
    at("2026-11-15T00:00:00+08:00"),
  );
});

test("A10 old rows keep their behaviour without cadence", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-15T12:00:00+11:00");
  assert.equal(api.nextRun({ time: "08:00" }, now, "Australia/Sydney"), at("2026-11-16T08:00:00+11:00"));
  assert.equal(
    api.nextRun({ time: "08:00", weekdays: [1] }, now, "Australia/Sydney"),
    at("2026-11-16T08:00:00+11:00"),
  );
  assert.equal(
    api.nextRun({ run_at: at("2026-11-15T18:00:00+11:00") }, now, "Australia/Sydney"),
    at("2026-11-15T18:00:00+11:00"),
  );
});

// ---------- B. planSchedule：新老类型的校验 ----------
test("B1 agent_task monthly plan records steps and the monthly next run", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-15T12:00:00+11:00");
  const plan = api.planSchedule(
    {
      group_id: GROUP,
      owner: "U1",
      kind: "agent_task",
      spec: {
        cadence: "monthly",
        month_days: [1],
        time: "09:00",
        title: "上月报销",
        steps: [{ action: "records_summary", type: "报销额度", period: "last_month" }],
      },
    },
    now,
  );
  assert.equal(plan.kind, "agent_task");
  assert.equal(plan.spec.cadence, "monthly");
  assert.deepEqual(plan.spec.month_days, [1]);
  assert.equal(plan.next_run_at, at("2026-12-01T09:00:00+11:00"));
});

test("B2 agent_task rejects steps the action layer refuses (non read-only)", async () => {
  const api = await bundle("schedules");
  const before = globalThis.__d3bActions.validateSteps;
  globalThis.__d3bActions.validateSteps = () => ({ ok: false, reason: "非只读动作：delete_records" });
  try {
    assert.throws(
      () =>
        api.planSchedule(
          { group_id: GROUP, owner: "U1", kind: "agent_task", spec: { time: "09:00", steps: [{ action: "delete_records" }] } },
          at("2026-11-15T12:00:00+11:00"),
        ),
      /非只读动作/,
    );
  } finally {
    globalThis.__d3bActions.validateSteps = before;
  }
});

test("B3 agent_task note is capped at 600 chars; title at 40", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-15T12:00:00+11:00");
  assert.throws(
    () =>
      api.planSchedule(
        { group_id: GROUP, owner: "U1", kind: "agent_task", spec: { time: "09:00", steps: [{ action: "quota" }], note: "字".repeat(601) } },
        now,
      ),
    /600/,
  );
  assert.throws(
    () =>
      api.planSchedule(
        { group_id: GROUP, owner: "U1", kind: "agent_task", spec: { time: "09:00", steps: [{ action: "quota" }], title: "标".repeat(41) } },
        now,
      ),
    /40/,
  );
});

test("B4 old kinds keep their validation and next run", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-13T07:59:00+11:00");
  const plan = api.planSchedule(
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    now,
  );
  assert.equal(plan.kind, "digest_daily");
  assert.equal(plan.next_run_at, at("2026-11-13T08:00:00+11:00"));
  assert.throws(
    () => api.planSchedule({ group_id: GROUP, owner: "U1", kind: "reminder", spec: { text: "交周报" } }, now),
    /未来的时间/,
  );
});

test("B5 once agent_task uses run_at and rejects the past", async () => {
  const api = await bundle("schedules");
  const now = at("2026-11-15T12:00:00+11:00");
  const plan = api.planSchedule(
    {
      group_id: GROUP,
      owner: "U1",
      kind: "agent_task",
      tz: "Asia/Shanghai",
      spec: { cadence: "once", run_at: at("2026-11-16T09:00:00+11:00"), steps: [{ action: "quota" }] },
    },
    now,
  );
  assert.equal(plan.next_run_at, at("2026-11-16T09:00:00+11:00"));
  assert.equal(plan.tz, "Asia/Shanghai");
  assert.throws(
    () =>
      api.planSchedule(
        { group_id: GROUP, owner: "U1", kind: "agent_task", spec: { cadence: "once", run_at: now - 1000, steps: [{ action: "quota" }] } },
        now,
      ),
    /过去/,
  );
});

// ---------- C. runSchedules：agent_task、限流、失败暂停、开关 ----------
function seedRun(e, { schedule_id, due_at, status = "ok", started_at = due_at, outbox_id = null, error = null }) {
  e.DB.raw
    .prepare(
      "INSERT OR IGNORE INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,outbox_id,error) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(`run-${schedule_id}-${due_at}`, schedule_id, due_at, started_at, status === "running" ? null : started_at, status, outbox_id, error);
}

test("C1 agent_task runs steps, composes the note, writes one outbox row and advances", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "sched-agent-1",
    spec: { time: "09:00", cadence: "daily", note: "余额日报", steps: [{ action: "quota" }, { action: "token_usage" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].body, "余额日报（2 段）");
  assert.equal(actionCalls.length, 1);
  assert.equal(actionCalls[0].ctx.purpose, "schedule");
  assert.equal(actionCalls[0].ctx.viewer.sender, "U1");
  assert.equal(actionCalls[0].ctx.groupId, GROUP);
  const after = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-1'");
  assert.equal(after.next_run_at, at("2026-11-16T09:00:00+11:00"));
  assert.equal(after.status, "active");
  assert.equal((await rows(e, "SELECT * FROM schedule_runs"))[0].status, "ok");
});

test("C2 without a note the body is the deterministic join, titled", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "sched-agent-2",
    spec: { time: "09:00", title: "每日账本", steps: [{ action: "quota" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1);
  assert.match(out[0].body, /每日账本/);
  assert.match(out[0].body, /quota 结果/);
});

test("C3 at most two model-needing tasks per tick; the third stays due for next minute", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  for (let i = 1; i <= 3; i++)
    seedSchedule(e, {
      id: `sched-agent-3-${i}`,
      spec: { time: "09:00", note: `第${i}份`, steps: [{ action: "quota" }] },
      next_run_at: due,
    });
  await api.runSchedules(e, due + 10_000);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 2);
  const deferred = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id='sched-agent-3-3'");
  assert.equal(deferred.status, "pending");
  assert.equal(deferred.started_at, null);
  const s3 = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-3-3'");
  assert.equal(s3.next_run_at, due, "顺延时不能推进 next_run_at");
  // 下一分钟只剩一个需要模型的，跑完
  await api.runSchedules(e, due + 70_000);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 3);
});

test("C4 a group is capped at 24 agent_task runs per day", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "filler",
    spec: { steps: [{ action: "quota" }] },
    next_run_at: at("2026-11-16T09:00:00+11:00"),
  });
  for (let i = 0; i < 24; i++) {
    const t = at("2026-11-15T08:00:00+11:00") + i * 60_000;
    seedRun(e, { schedule_id: "filler", due_at: t, started_at: t });
  }
  seedSchedule(e, {
    id: "sched-agent-4",
    spec: { time: "09:00", steps: [{ action: "quota" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  assert.equal(actionCalls.length, 0);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0);
  const run = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id='sched-agent-4'");
  assert.equal(run.status, "skipped");
  assert.match(String(run.error), /agent_daily_cap/);
  const after = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-4'");
  assert.equal(after.next_run_at, at("2026-11-16T09:00:00+11:00"));
});

test("C5 nine consecutive failures pause the task and notify exactly once", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  globalThis.__d3bActions.runSteps = async () => {
    throw Error("上游 500");
  };
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "sched-agent-5",
    fail_count: 8,
    spec: { time: "09:00", steps: [{ action: "quota" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  const after = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-5'");
  assert.equal(after.fail_count, 9);
  assert.equal(after.status, "paused");
  assert.equal(after.next_run_at, null);
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.equal(out[0].id, "sched-paused:sched-agent-5");
  assert.match(out[0].body, /暂停/);
  // 暂停后不再被 cron 捞起来
  await api.runSchedules(e, due + 20 * 60_000);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs")).length, 1);
});

test("C6 non read-only steps are refused and recorded as denied", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  globalThis.__d3bActions.validateSteps = () => ({ ok: false, reason: "删除所有记录 不是只读动作" });
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "sched-agent-6",
    spec: { time: "09:00", note: "照着 note 删库", steps: [{ action: "delete_records" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  assert.equal(actionCalls.length, 0, "被拒的步骤不能执行");
  const run = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id='sched-agent-6'");
  assert.equal(run.status, "failed");
  assert.match(String(run.error), /denied/);
  assert.match(String(run.error), /删除所有记录/);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0);
  const after = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-6'");
  assert.equal(after.fail_count, 1);
  assert.equal(after.status, "active");
});

test("C7 off:schedules_cron stops the whole cron pass", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, { id: "sched-agent-7", spec: { time: "09:00", steps: [{ action: "quota" }] }, next_run_at: due });
  await e.DB.raw.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('off:schedules_cron','1')").run();
  await api.runSchedules(e, due + 10_000);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs")).length, 0);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0);
  assert.equal(
    (await row(e, "SELECT * FROM schedules WHERE id='sched-agent-7'")).next_run_at,
    due,
  );
  // 0 视为开
  await e.DB.raw.prepare("UPDATE settings SET value='0' WHERE key='off:schedules_cron'").run();
  await api.runSchedules(e, due + 10_000);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs")).length, 1);
});

test("C8 a once agent_task finishes and becomes done", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  seedSchedule(e, {
    id: "sched-agent-8",
    spec: { cadence: "once", run_at: due, steps: [{ action: "quota" }] },
    next_run_at: due,
  });
  await api.runSchedules(e, due + 10_000);
  const after = await row(e, "SELECT * FROM schedules WHERE id='sched-agent-8'");
  assert.equal(after.status, "done");
  assert.equal(after.next_run_at, null);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1);
});

test("C9 chat_digest steps count against the two-model-calls budget", async () => {
  const api = await bundle("schedules");
  resetDeps();
  const e = env();
  const due = at("2026-11-15T09:00:00+11:00");
  for (let i = 1; i <= 3; i++)
    seedSchedule(e, {
      id: `sched-agent-9-${i}`,
      spec: { time: "09:00", steps: [{ action: "chat_digest", days: 1 }] },
      next_run_at: due,
    });
  await api.runSchedules(e, due + 10_000);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 2);
  assert.equal(actionCalls.length, 2);
});

// ---------- D. 四个工具（schedule_create/update/list/cancel） ----------
const tools = await bundle("tools/schedule-tools");

const BJ = "Asia/Shanghai";
const daily = (time, tz = "Australia/Sydney", extra = {}) => ({ cadence: "daily", time, tz, ...extra });

function parseStub({ when = {}, content = {}, describe } = {}) {
  globalThis.__d3bParse = {
    parseWhen: (text) => (Object.prototype.hasOwnProperty.call(when, text) ? when[text] : null),
    parseContent: (text) => (Object.prototype.hasOwnProperty.call(content, text) ? content[text] : []),
    describeWhen:
      describe ||
      ((w) => (w.cadence === "daily" ? `每天 ${w.time}（${w.tz === BJ ? "北京时间" : "悉尼"}）` : `${w.cadence} ${w.time || ""}`)),
  };
}

test("D1 schedule_create: when_text + steps become an agent_task in Asia/Shanghai", async () => {
  const e = env();
  parseStub({
    when: { "每天北京时间0点": { ok: true, when: { cadence: "daily", time: "00:00", tz: BJ }, tzSaid: true, matched: "北京时间0点" } },
    content: { "在群里发DeepSeek余额": [{ action: "quota" }] },
  });
  const result = await tools.scheduleCreateTool.run(
    e,
    { when_text: "每天北京时间0点", content_text: "在群里发DeepSeek余额", title: "余额日报" },
    toolCtx("每天北京时间0点在群里发DeepSeek余额即可"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.accepted, true);
  assert.equal(result.family, "schedule");
  assert.equal(result.kind, "agent_task");
  assert.equal(result.tz, BJ);
  assert.match(result.next_run_text, /北京/);
  assert.match(result.next_run_text, /悉尼/);
  assert.match(result.say, /记下了/);
  assert.match(result.say, /北京/);
  const rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", result.id);
  const spec = JSON.parse(rowdb.spec);
  assert.equal(spec.time, "00:00");
  assert.deepEqual(spec.steps, [{ action: "quota" }]);
  assert.equal(rowdb.tz, BJ);
  const hour = new Intl.DateTimeFormat("en-CA", {
    timeZone: BJ,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(result.next_run_at));
  assert.equal(hour, "00:00");
});

test("D2 when_text wins over the model's time/tz and records an override", async () => {
  const e = env();
  parseStub({
    when: { "每天北京时间0点": { ok: true, when: { cadence: "daily", time: "00:00", tz: BJ }, tzSaid: true, matched: "0点" } },
    content: { 发余额: [{ action: "quota" }] },
  });
  const hookSeen = [];
  tools.setScheduleViolationHook(async (v) => {
    hookSeen.push(v);
  });
  try {
    const result = await tools.scheduleCreateTool.run(
      e,
      { when_text: "每天北京时间0点", content_text: "发余额", time: "09:00", tz: "Australia/Sydney" },
      toolCtx("每天北京时间0点发余额"),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.tz, BJ);
    const rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", result.id);
    assert.equal(JSON.parse(rowdb.spec).time, "00:00");
    assert.deepEqual(result.overrides?.length, 2);
    assert.deepEqual(hookSeen.map((v) => v.field).sort(), ["time", "tz"]);
    assert.equal(hookSeen[0].parsed, "00:00");
  } finally {
    tools.setScheduleViolationHook(null);
  }
});

test("D3 schedule_create without a time asks once and stores a 30-minute pending", async () => {
  const e = env();
  parseStub({
    when: { "每天固定时间发一下每天的余额和 token 用量": { ok: false, missing: "time" } },
    content: { "每天固定时间发一下每天的余额和 token 用量": [{ action: "quota" }, { action: "token_usage" }] },
  });
  const started = Date.now();
  const result = await tools.scheduleCreateTool.run(
    e,
    {},
    toolCtx("每天固定时间发一下每天的余额和 token 用量"),
  );
  assert.equal(result.ok, false);
  assert.equal(result.need, "time");
  assert.ok(result.pending_id);
  assert.match(result.say, /几点发/);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 0);
  const pending = await row(e, "SELECT * FROM pending_actions WHERE id=?", result.pending_id);
  assert.equal(pending.status, "open");
  assert.equal(pending.missing, "time");
  assert.equal(pending.expires_at - pending.asked_at, 30 * 60 * 1000);
  assert.ok(pending.asked_at >= started);
  assert.deepEqual(JSON.parse(pending.draft).steps, [{ action: "quota" }, { action: "token_usage" }]);
});

test("D4 the next message with a time completes the pending schedule (RC-07)", async () => {
  const e = env();
  parseStub({
    when: {
      "每天固定时间发一下每天的余额和 token 用量": { ok: false, missing: "time" },
      "北京时间0点": { ok: true, when: { cadence: "daily", time: "00:00", tz: BJ }, tzSaid: true, matched: "北京时间0点" },
    },
    content: { "每天固定时间发一下每天的余额和 token 用量": [{ action: "quota" }, { action: "token_usage" }] },
  });
  const first = await tools.scheduleCreateTool.run(e, {}, toolCtx("每天固定时间发一下每天的余额和 token 用量", "U1", "msg-482"));
  assert.equal(first.need, "time");
  const second = await tools.scheduleCreateTool.run(e, { pending_id: first.pending_id }, toolCtx("北京时间0点", "U1", "msg-484"));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.kind, "agent_task");
  const rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", second.id);
  const spec = JSON.parse(rowdb.spec);
  assert.deepEqual(spec.steps, [{ action: "quota" }, { action: "token_usage" }]);
  assert.equal((await row(e, "SELECT * FROM pending_actions WHERE id=?", first.pending_id)).status, "done");
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 1);
});

test("D5 an expired pending is not reused", async () => {
  const e = env();
  parseStub({
    when: {
      "每天固定时间发余额": { ok: false, missing: "time" },
      "每天北京时间0点发余额": { ok: true, when: { cadence: "daily", time: "00:00", tz: BJ }, tzSaid: true, matched: "0点" },
    },
    content: {
      "每天固定时间发余额": [{ action: "quota" }],
      "每天北京时间0点发余额": [{ action: "quota" }],
    },
  });
  const first = await tools.scheduleCreateTool.run(e, {}, toolCtx("每天固定时间发余额", "U1", "msg-1"));
  e.DB.raw.prepare("UPDATE pending_actions SET expires_at=? WHERE id=?").run(Date.now() - 1000, first.pending_id);
  const second = await tools.scheduleCreateTool.run(e, {}, toolCtx("每天北京时间0点发余额", "U1", "msg-2"));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal((await row(e, "SELECT * FROM pending_actions WHERE id=?", first.pending_id)).status, "expired");
});

test("D6 schedule_update is owner/admin only (S-16)", async () => {
  const e = env();
  owner(e, "U1");
  parseStub({ when: { "每天9点": { ok: true, when: { cadence: "daily", time: "09:00", tz: "Australia/Sydney" }, tzSaid: false, matched: "9点" } } });
  const id = seedSchedule(e, {
    id: "sched-upd-1",
    owner: "U1",
    kind: "digest_daily",
    spec: { time: "08:00" },
    next_run_at: at("2026-11-16T08:00:00+11:00"),
  });
  const denied = await tools.scheduleUpdateTool.run(e, { id, when_text: "每天9点" }, toolCtx("把日报改到9点", "U2"));
  assert.equal(denied.ok, false);
  assert.equal(denied.error_kind, "denied");
  assert.equal((await row(e, "SELECT * FROM schedules WHERE id=?", id)).spec, JSON.stringify({ time: "08:00" }));
  const ok = await tools.scheduleUpdateTool.run(e, { id, when_text: "每天9点" }, toolCtx("把日报改到9点", "U1"));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(JSON.parse((await row(e, "SELECT * FROM schedules WHERE id=?", id)).spec).time, "09:00");
});

test("D7 schedule_update pauses and resumes", async () => {
  const e = env();
  owner(e, "U1");
  parseStub();
  const id = seedSchedule(e, {
    id: "sched-upd-2",
    owner: "U1",
    kind: "digest_daily",
    spec: { time: "08:00" },
    next_run_at: at("2026-11-16T08:00:00+11:00"),
  });
  const paused = await tools.scheduleUpdateTool.run(e, { id, status: "paused" }, toolCtx("先停一下", "U1"));
  assert.equal(paused.ok, true, JSON.stringify(paused));
  let rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", id);
  assert.equal(rowdb.status, "paused");
  assert.equal(rowdb.next_run_at, null);
  const resumed = await tools.scheduleUpdateTool.run(e, { id, status: "active" }, toolCtx("恢复", "U1"));
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", id);
  assert.equal(rowdb.status, "active");
  assert.ok(rowdb.next_run_at > Date.now());
});

test("D8 schedule_cancel: owner ok, other denied, own mute allowed", async () => {
  const e = env();
  owner(e, "U1");
  parseStub();
  const id = seedSchedule(e, { id: "sched-can-1", owner: "U1", kind: "digest_daily", spec: { time: "08:00" } });
  const denied = await tools.scheduleCancelTool.run(e, { id }, toolCtx("取消", "U2"));
  assert.equal(denied.ok, false);
  assert.equal(denied.error_kind, "denied");
  assert.equal((await row(e, "SELECT * FROM schedules WHERE id=?", id)).status, "active");
  const ok = await tools.scheduleCancelTool.run(e, { id }, toolCtx("取消", "U1"));
  assert.equal(ok.ok, true);
  assert.equal((await row(e, "SELECT * FROM schedules WHERE id=?", id)).status, "cancelled");
  const mute = seedSchedule(e, { id: "sched-mute-1", owner: "U9", kind: "mute", spec: { run_at: Date.now() + 3600_000 } });
  const own = await tools.scheduleCancelTool.run(e, { id: mute }, toolCtx("别说了", "U9"));
  assert.equal(own.ok, true);
  assert.equal((await row(e, "SELECT * FROM schedules WHERE id=?", mute)).status, "cancelled");
});

test("D9 schedule_list shows the last run status, failures and pause state", async () => {
  const e = env();
  parseStub();
  const good = seedSchedule(e, {
    id: "sched-list-1",
    kind: "digest_daily",
    spec: { time: "08:00", title: "每日账本" },
    next_run_at: at("2026-11-16T08:00:00+11:00"),
  });
  const bad = seedSchedule(e, {
    id: "sched-list-2",
    kind: "agent_task",
    status: "paused",
    fail_count: 9,
    spec: { time: "09:00", steps: [{ action: "quota" }] },
  });
  seedRun(e, { schedule_id: good, due_at: at("2026-11-15T08:00:00+11:00"), status: "ok" });
  seedRun(e, { schedule_id: bad, due_at: at("2026-11-15T09:00:00+11:00"), status: "failed" });
  const result = await tools.scheduleListTool.run(e, { include_done: true }, toolCtx("我的日报呢"));
  assert.equal(result.ok, true, JSON.stringify(result));
  const rowsOut = result.schedules;
  const first = rowsOut.find((s) => s.id === good);
  assert.ok(first, JSON.stringify(result));
  assert.equal(first.last_run_status, "sent");
  assert.equal(first.fail_count, 0);
  assert.match(first.title, /每日账本/);
  const second = rowsOut.find((s) => s.id === bad);
  assert.equal(second.last_run_status, "failed");
  assert.equal(second.status, "paused");
  assert.equal(second.fail_count, 9);
  assert.match(result.say, /已暂停/);
});

test("D10 schedule_create merges model steps with parsed steps without duplicates", async () => {
  const e = env();
  parseStub({
    when: { "每天0点": { ok: true, when: { cadence: "daily", time: "00:00", tz: BJ }, tzSaid: true, matched: "0点" } },
    content: { "发余额和 token": [{ action: "quota" }, { action: "token_usage" }] },
  });
  const result = await tools.scheduleCreateTool.run(
    e,
    { when_text: "每天0点", content_text: "发余额和 token", steps: [{ action: "quota" }] },
    toolCtx("每天0点发余额和 token"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  const spec = JSON.parse((await row(e, "SELECT * FROM schedules WHERE id=?", result.id)).spec);
  assert.deepEqual(spec.steps, [{ action: "quota" }, { action: "token_usage" }]);
});

test("D11 a pure chat summary stays digest_daily, not agent_task (RC-02)", async () => {
  const e = env();
  parseStub({
    when: { "每天8点": { ok: true, when: { cadence: "daily", time: "08:00", tz: "Australia/Sydney" }, tzSaid: false, matched: "每天8点" } },
    content: { "推送昨日聊天内容总结": [{ action: "chat_digest", days: 1 }] },
  });
  const result = await tools.scheduleCreateTool.run(
    e,
    { when_text: "每天8点", content_text: "推送昨日聊天内容总结" },
    toolCtx("每天8点推送昨日聊天内容总结，一定要精简"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "digest_daily");
  assert.match(result.say, /记下了/);
  assert.match(result.say, /08:00/);
});

test("D12 S-01 monthly and S-04 every reach the schedule layer intact", async () => {
  const e = env();
  parseStub({
    when: {
      "每月1号早上9点": { ok: true, when: { cadence: "monthly", time: "09:00", month_days: [1], tz: "Australia/Sydney" }, tzSaid: false, matched: "每月1号早上9点" },
      "每30分钟": { ok: true, when: { cadence: "every", every_minutes: 30, until: at("2026-11-15T22:00:00+11:00"), tz: "Australia/Sydney" }, tzSaid: false, matched: "每30分钟" },
    },
    content: { "把上个月报销账单发群里": [{ action: "records_summary", type: "报销额度", period: "last_month" }], "提醒我喝水": [{ action: "text", text: "喝水" }] },
  });
  const monthly = await tools.scheduleCreateTool.run(
    e,
    { when_text: "每月1号早上9点", content_text: "把上个月报销账单发群里" },
    toolCtx("每月1号早上9点把上个月报销账单发群里", "U1", "msg-s01"),
  );
  assert.equal(monthly.ok, true, JSON.stringify(monthly));
  assert.equal(monthly.kind, "agent_task");
  let spec = JSON.parse((await row(e, "SELECT * FROM schedules WHERE id=?", monthly.id)).spec);
  assert.equal(spec.cadence, "monthly");
  assert.deepEqual(spec.month_days, [1]);
  assert.equal(spec.time, "09:00");

  const every = await tools.scheduleCreateTool.run(
    e,
    { when_text: "每30分钟", content_text: "提醒我喝水" },
    toolCtx("每30分钟提醒我喝水，到晚上10点为止", "U1", "msg-s04"),
  );
  assert.equal(every.ok, true, JSON.stringify(every));
  spec = JSON.parse((await row(e, "SELECT * FROM schedules WHERE id=?", every.id)).spec);
  assert.equal(spec.cadence, "every");
  assert.equal(spec.every_minutes, 30);
});

test("D13 S-02 once becomes a reminder with run_at", async () => {
  const e = env();
  const runAt = at("2026-11-16T15:00:00+11:00");
  parseStub({
    when: { "明天下午3点": { ok: true, when: { cadence: "once", run_at: runAt, tz: "Australia/Sydney" }, tzSaid: false, matched: "明天下午3点" } },
    content: { "提醒我交周报": [{ action: "text", text: "交周报" }] },
  });
  const result = await tools.scheduleCreateTool.run(
    e,
    { when_text: "明天下午3点", content_text: "提醒我交周报" },
    toolCtx("明天下午3点提醒我交周报"),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.kind, "reminder");
  const rowdb = await row(e, "SELECT * FROM schedules WHERE id=?", result.id);
  const spec = JSON.parse(rowdb.spec);
  assert.equal(spec.run_at, runAt);
  assert.equal(spec.text, "交周报");
  assert.equal(spec.steps, undefined);
});
