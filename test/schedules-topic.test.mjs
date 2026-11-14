import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { env } from "./support.mjs";

// L1：日程通用化。topic/dedup/origin/request_quote、上限、dedup 出站 id、TOPIC_PROMPT、parseScheduleRequest。
// 全部只写本地内存 SQLite，模型是确定性 stub；QQ 与线上 D1 都不碰。
const GROUP = "GROUP-Topic-1";
const OTHER = "GROUP-Topic-2";
const at = (s) => Date.parse(s);
const NOW = at("2026-11-13T00:00:00+11:00");

const outfile = `.wrangler/schedules-topic-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/schedules";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);

const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

/** Digest/Topic 两种提示词都识别；别的请求原样回一句。 */
function stub(lines = "• 要点一\n• 要点二\n• 最该推进：验收") {
  const old = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) throw Error("unexpected network: " + url);
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("只写群里发布的日报正文") || system.includes("你在为群聊写"))
      return Response.json({ choices: [{ message: { content: lines }, finish_reason: "stop" }] });
    return Response.json({ choices: [{ message: { content: "好" }, finish_reason: "stop" }] });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = old;
    },
  };
}

async function seedYesterday(e, group = GROUP) {
  for (const [id, body, ts] of [
    ["m-1", "把模型能力转化为产品能力", "2026-11-12T10:00:00+11:00"],
    ["m-2", "不卖 API，先自己搭软件", "2026-11-12T11:00:00+11:00"],
  ])
    await e.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,0)",
    )
      .bind(id, group, "U1", body, ts)
      .run();
}

test("T1 parseScheduleRequest reads daily forms with Chinese and numeric clocks", () => {
  const cases = [
    ["每天 08:00（悉尼）发礼物日早报", "daily", "08:00", undefined, "礼物日早报"],
    ["每天早上 8 点发礼物日早报", "daily", "08:00", undefined, "礼物日早报"],
    ["每晚 9 点半发今日提醒", "daily", "21:30", undefined, "今日提醒"],
    ["每天8点30分推一下昨天的 PR 进展", "daily", "08:30", undefined, "昨天的 PR 进展"],
    ["每天晚上八点发日报", "daily", "20:00", undefined, "日报"],
    [
      "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。",
      "daily",
      "08:00",
      undefined,
      "昨日聊天内容总结",
    ],
    ["每天中午 12 点发午饭提醒", "daily", "12:00", undefined, "午饭提醒"],
  ];
  for (const [text, cadence, time, weekdays, topic] of cases) {
    const got = api.parseScheduleRequest(text);
    assert.ok(got, "parse failed: " + text);
    assert.equal(got.cadence, cadence, text);
    assert.equal(got.time, time, text);
    assert.deepEqual(got.weekdays, weekdays, text);
    assert.equal(got.topic, topic, text);
  }
});

test("T2 parseScheduleRequest reads weekly forms and maps the weekday", () => {
  const cases = [
    ["每周五下午五点发周报", "17:00", [5], "周报"],
    ["每周日 08:00 推送上周总结", "08:00", [0], "上周总结"],
    ["每周一早上 7 点 15 分发出晨会提醒", "07:15", [1], "晨会提醒"],
    ["每星期六上午十点发本周回顾", "10:00", [6], "本周回顾"],
  ];
  for (const [text, time, weekdays, topic] of cases) {
    const got = api.parseScheduleRequest(text);
    assert.ok(got, "parse failed: " + text);
    assert.equal(got.cadence, "weekly", text);
    assert.equal(got.time, time, text);
    assert.deepEqual(got.weekdays, weekdays, text);
    assert.equal(got.topic, topic, text);
  }
});

test("T3 parseScheduleRequest returns null instead of guessing", () => {
  for (const text of [
    "明早 8 点发一份",
    "每天",
    "别每天 8 点发了",
    "取消每天 8 点的日报",
    "每天 25:00 发日报",
    "每天 8 点",
    "每天 08:00 发",
    "这个项目每天都很忙",
    "每周 8 点发周报",
    "",
    null,
  ]) {
    assert.equal(api.parseScheduleRequest(text), null, "must be null: " + text);
  }
});

test("T4 planSchedule normalises topic/dedup/origin and truncates request_quote", () => {
  const base = {
    group_id: GROUP,
    owner: "U1",
    kind: "digest_daily",
    spec: { time: "08:00", topic: "  礼物日早报  ", dedup: "gift-report", origin: "chat" },
    source_msg_id: "msg-t4",
  };
  const plan = api.planSchedule(base, NOW);
  assert.equal(plan.spec.topic, "礼物日早报");
  assert.equal(plan.spec.dedup, "gift-report");
  assert.equal(plan.spec.origin, "chat");
  assert.equal(plan.spec.request_quote, undefined, "absent quote must not be invented");

  // 原话 ≤200 字截断（设计 §礼物日早报）
  const long = "精简".repeat(200);
  const quote = api.planSchedule({ ...base, spec: { time: "08:00", request_quote: long } }, NOW);
  assert.equal(quote.spec.request_quote.length, 200);

  // topic 上限 40；dedup 只收小写字母数字连字符；origin 只收三值
  assert.throws(() => api.planSchedule({ ...base, spec: { time: "08:00", topic: "题".repeat(41) } }, NOW), /1[–-]?40/);
  for (const dedup of ["Gift", "a", "ab", "a b", "a_b", "x".repeat(32)])
    assert.throws(
      () => api.planSchedule({ ...base, spec: { time: "08:00", dedup } }, NOW),
      /去重键/,
      "bad dedup accepted: " + dedup,
    );
  assert.throws(() => api.planSchedule({ ...base, spec: { time: "08:00", origin: "manual" } }, NOW), /origin/);
});

test("T5 describeSchedule names the topic when there is one", () => {
  const daily = api.describeSchedule({
    kind: "digest_daily",
    spec: JSON.stringify({ time: "08:00", topic: "礼物日早报" }),
  });
  assert.equal(daily, "每天 08:00（悉尼）发礼物日早报");
  const weekly = api.describeSchedule({
    kind: "digest_weekly",
    spec: JSON.stringify({ time: "08:00", weekdays: [5], topic: "周报" }),
  });
  assert.equal(weekly, "每周五 08:00（悉尼）发周报");
  // 无 topic 时保持原样（回归）
  assert.equal(
    api.describeSchedule({ kind: "digest_daily", spec: JSON.stringify({ time: "08:00" }) }),
    "每天 08:00（悉尼）昨日总结",
  );
  assert.equal(
    api.describeSchedule({ kind: "digest_weekly", spec: JSON.stringify({ time: "08:00", weekdays: [0] }) }),
    "每周日 08:00（悉尼）周报",
  );
});

test("T6 createSchedule rejects a dedup already active in another group and frees it when cancelled", async () => {
  const e = env();
  const a = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00", dedup: "gift-report" }, source_msg_id: "d-1" },
    NOW,
  );
  await assert.rejects(
    api.createSchedule(
      e,
      { group_id: OTHER, owner: "U2", kind: "digest_daily", spec: { time: "08:00", dedup: "gift-report" }, source_msg_id: "d-2" },
      NOW,
    ),
    /去重键/,
  );
  // 另一个 dedup 照样能建
  const ok = await api.createSchedule(
    e,
    { group_id: OTHER, owner: "U2", kind: "digest_daily", spec: { time: "09:00", dedup: "other-report" }, source_msg_id: "d-3" },
    NOW,
  );
  assert.ok(ok.id);
  // 取消后 dedup 释放
  await api.cancelSchedule(e, GROUP, a.id);
  const again = await api.createSchedule(
    e,
    { group_id: OTHER, owner: "U2", kind: "digest_daily", spec: { time: "08:00", dedup: "gift-report" }, source_msg_id: "d-4" },
    NOW,
  );
  assert.ok(again.id);
  // 同一 id 重建仍然幂等，不报上限也不报 dedup 冲突
  const same = await api.createSchedule(
    e,
    { group_id: OTHER, owner: "U2", kind: "digest_daily", spec: { time: "08:00", dedup: "gift-report" }, source_msg_id: "d-4" },
    NOW,
  );
  assert.equal(same.id, again.id);
  assert.equal((await rows(e, "SELECT * FROM schedules WHERE id=?", again.id)).length, 1);
});

test("T7 createSchedule caps active schedules per group and ignores mute", async () => {
  const e = env();
  const make = (name, extra = {}) =>
    api.createSchedule(
      e,
      { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: name, ...extra },
      NOW,
    );
  for (const name of ["c-1", "c-2", "c-3", "c-4"]) await make(name);
  await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "mute", spec: { minutes: 10 }, source_msg_id: "c-mute" },
    NOW,
  );
  // 5 行 active 里有 1 行 mute：非 mute 只有 4，第 5 个仍然能建
  const fifth = await make("c-5");
  assert.ok(fifth.id);
  await assert.rejects(make("c-6"), /本群定时已满 5 个，先取消一个/);
  // 取消一个后又能建
  await api.cancelSchedule(e, GROUP, fifth.id);
  assert.ok((await make("c-7")).id);
});

test("T8 dedup outbox id is <dedup>:<Sydney date>; without dedup the old id is kept", async () => {
  const e = env();
  await seedYesterday(e);
  const deduped = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00", dedup: "gift-report" }, source_msg_id: "o-1" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const plain = await api.createSchedule(
    e,
    { group_id: OTHER, owner: "U2", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "o-2" },
    at("2026-11-13T07:59:00+11:00"),
  );
  await seedYesterday(e, OTHER);
  let s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox ORDER BY id");
  assert.equal(out.length, 2, JSON.stringify(out));
  assert.ok(out.some((x) => x.id === "gift-report:2026-11-13"), JSON.stringify(out.map((x) => x.id)));
  assert.ok(
    out.some((x) => x.id === `sched-${plain.id}-${at("2026-11-13T08:00:00+11:00")}`),
    JSON.stringify(out.map((x) => x.id)),
  );
  // 次日同一个 dedup 换日期，不撞 id
  s = stub();
  try {
    await api.runSchedules(e, at("2026-11-14T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const nextDay = (await rows(e, "SELECT id FROM outbox")).map((x) => x.id);
  assert.ok(nextDay.includes("gift-report:2026-11-14"), JSON.stringify(nextDay));
  assert.equal((await row(e, "SELECT status FROM schedules WHERE id=?", deduped.id)).status, "active");
});

test("T9 topic digest uses TOPIC_PROMPT, appends the member's quote and 精简 caps five lines", async () => {
  const e = env();
  await seedYesterday(e);
  await api.createSchedule(
    e,
    {
      group_id: GROUP,
      owner: "U1",
      kind: "digest_daily",
      spec: {
        time: "08:00",
        topic: "礼物日早报",
        request_quote: "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。",
      },
      source_msg_id: "t-1",
    },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub("1\n2\n3\n4\n5\n6\n7\n8\n9");
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const system = String(s.seen[0]?.messages?.[0]?.content || "");
  assert.match(system, /你在为群聊写『礼物日早报』/);
  assert.match(system, /今天没有可报的礼物日早报内容/);
  assert.match(system, /最多 5 行/);
  assert.match(system, /成员原话要求：然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。；照这个口径写/);
  assert.doesNotMatch(system, /只写群里发布的日报正文/, "topic push must not fall back to the daily prompt");
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1);
  assert.equal(out[0].body.split("\n").length, 5);
});

test("T10 daily digest without topic keeps DIGEST_PROMPT (regression)", async () => {
  const e = env();
  await seedYesterday(e);
  await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "t-2" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub("1\n2\n3\n4\n5\n6\n7\n8\n9");
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const system = String(s.seen[0]?.messages?.[0]?.content || "");
  assert.match(system, /只写群里发布的日报正文/);
  assert.doesNotMatch(system, /你在为群聊写『/);
  assert.equal((await rows(e, "SELECT * FROM outbox"))[0].body.split("\n").length, 8);
});

/** 今天的已发记录挂在一批已取消的日程上，用来预置当日发送量。 */
async function seedSends(e, { group, n, dayStart = "2026-11-13T06:00:00+11:00", from = 0 }) {
  for (let i = from; i < from + n; i++) {
    const id = `old-${group}-${i}`;
    await e.DB.prepare(
      "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'cancelled',NULL,0,?,NULL)",
    )
      .bind(id, group, "U9", "reminder", "Australia/Sydney", JSON.stringify({ text: "旧提醒" }), NOW)
      .run();
    await e.DB.prepare(
      "INSERT OR IGNORE INTO schedule_runs(id,schedule_id,due_at,finished_at,status,outbox_id) VALUES(?,?,?,?,'ok',?)",
    )
      .bind(`run-${id}`, id, at(dayStart) + i * 1000, at(dayStart), `out-${id}`)
      .run();
  }
}

test("T11 runSchedules skips with error=cap when the group already sent six times today", async () => {
  const e = env();
  await seedYesterday(e);
  await seedSends(e, { group: GROUP, n: 6 });
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "cap-1" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  assert.equal(s.seen.length, 0, "capped run must not spend a model call");
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0, "capped run must not write outbox");
  const run = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id=?", created.id);
  assert.equal(run.status, "skipped");
  assert.equal(run.error, "cap");
  const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(after.next_run_at, at("2026-11-14T08:00:00+11:00"));
  assert.equal(after.last_error, "cap");
  assert.equal(after.status, "active");
  // 明天配额重新计算，照常发
  const tomorrow = stub();
  try {
    await api.runSchedules(e, at("2026-11-14T08:00:10+11:00"));
  } finally {
    tomorrow.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1);
});

test("T12 runSchedules skips with error=cap when the day's global sends reach twenty", async () => {
  const e = env();
  await seedYesterday(e);
  for (let i = 0; i < 20; i++) await seedSends(e, { group: `G-${i}`, n: 1, from: 0 });
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "cap-2" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  assert.equal(s.seen.length, 0);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0);
  const run = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id=?", created.id);
  assert.equal(run.status, "skipped");
  assert.equal(run.error, "cap");
});

test("T13 mute runs do not eat the send quota", async () => {
  const e = env();
  await seedYesterday(e);
  // 本群今天 6 次 ok 里 3 次是 mute（没有出站），不该占发送额度
  for (let i = 0; i < 3; i++) {
    const id = `mute-${i}`;
    await e.DB.prepare(
      "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'cancelled',NULL,0,?,NULL)",
    )
      .bind(id, GROUP, "U9", "mute", "Australia/Sydney", JSON.stringify({ run_at: NOW }), NOW)
      .run();
    await e.DB.prepare(
      "INSERT OR IGNORE INTO schedule_runs(id,schedule_id,due_at,finished_at,status,outbox_id) VALUES(?,?,?,?,'ok',NULL)",
    )
      .bind(`run-${id}`, id, at("2026-11-13T06:00:00+11:00") + i * 1000, at("2026-11-13T06:00:00+11:00"))
      .run();
  }
  await seedSends(e, { group: GROUP, n: 5, from: 10 });
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "cap-3" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1, "five real sends are below the six cap");
  const run = await row(e, "SELECT * FROM schedule_runs WHERE schedule_id=?", created.id);
  assert.equal(run.status, "ok");
  assert.equal(run.error, null);
});
