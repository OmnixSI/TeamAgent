import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { env, worker } from "./support.mjs";

// F6-6：定时日推/提醒/闭嘴。先红后绿；回放用线上真实消息原文，只写本地假 D1。
const replay = JSON.parse(
  readFileSync(new URL("./fixtures/f6-schedules-replay.json", import.meta.url), "utf8"),
);
const GROUP = replay.group_id;
const at = (s) => Date.parse(s);

const outfile = `.wrangler/schedules-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/schedules";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);

const semFile = `.wrangler/schedules-sem-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export { agentAnswer } from "./src/semantic";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: semFile,
});
const sem = await import("../" + semFile);

const call = (name, args) => ({
  id: "call-" + name,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content = '{"action":"reply","kind":"direct","brief":"好。"}') => ({
  role: "assistant",
  content,
});

/** DeepSeek stub: digest, final voice and agent turns are separated by system prompt. */
function stub(steps = [], { failDigest = false } = {}) {
  const old = globalThis.fetch;
  const seen = [];
  const queue = [...steps];
  let foreign = 0;
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) {
      foreign++;
      return Response.json({});
    }
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("只写群里发布的日报正文")) {
      if (failDigest) return new Response("upstream down", { status: 500 });
      return Response.json({
        choices: [
          {
            message: {
              content:
                "• 讨论把模型能力转化为产品\n• 不卖 API，先自己搭软件\n• 结论：溢价低，方向待定",
            },
            finish_reason: "stop",
          },
        ],
      });
    }
    if (system.includes("最后的嘴替模块"))
      return Response.json({
        choices: [{ message: { content: '{"mode":"banter","text":"好。"}' }, finish_reason: "stop" }],
      });
    const raw = queue.shift() || reply();
    const next = raw?.function ? { role: "assistant", tool_calls: [raw] } : raw;
    return Response.json({ choices: [{ message: next, finish_reason: "stop" }] });
  };
  return {
    seen,
    get foreign() { return foreign; },
    restore() { globalThis.fetch = old; },
  };
}

async function contextFor(e, { id, body, ts = new Date().toISOString(), mentioned = 0, sender = "U1" }) {
  await e.DB.prepare(
    "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  )
    .bind(id, GROUP, sender, body, ts, mentioned)
    .run();
  const row = { id, group_id: GROUP, sender, body, ts, mentioned, meta: { direct: true, media: [] } };
  return {
    latest: row,
    batch: [row],
    recent: [row],
    names: new Map(),
    refs: new Map(),
    mentioned: !!mentioned,
  };
}

async function seedYesterday(e) {
  for (const m of replay.messages.filter((x) => x.rowid >= 344 && x.rowid <= 347))
    await e.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
    )
      .bind("msg-" + m.rowid, GROUP, "U" + m.rowid, m.body, m.ts, m.mentioned)
      .run();
}

const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

test("S1 nextRun handles Sydney DST both ways, Sunday-start weeks and once reminders", () => {
  const daily = { time: "08:00" };
  // 2026-04-05 03:00 AEDT → 02:00 AEST；前后各一天 08:00 仍是 08:00。
  assert.equal(api.nextRun(daily, at("2026-04-04T07:59:00+11:00")), at("2026-04-04T08:00:00+11:00"));
  assert.equal(api.nextRun(daily, at("2026-04-04T12:00:00+11:00")), at("2026-04-05T08:00:00+10:00"));
  assert.equal(api.nextRun(daily, at("2026-04-05T09:00:00+10:00")), at("2026-04-06T08:00:00+10:00"));
  // 2026-10-04 02:00 AEST → 03:00 AEDT；前后各一天 08:00 仍是 08:00。
  assert.equal(api.nextRun(daily, at("2026-10-03T12:00:00+10:00")), at("2026-10-04T08:00:00+11:00"));
  assert.equal(api.nextRun(daily, at("2026-10-04T09:00:00+11:00")), at("2026-10-05T08:00:00+11:00"));
  // 跨夏令时的间隔分别是 21h / 19h，证明按悉尼墙上时间算而不是按 UTC 加 24h。
  assert.equal(at("2026-04-05T08:00:00+10:00") - at("2026-04-04T12:00:00+11:00"), 21 * 3600000);
  assert.equal(at("2026-10-04T08:00:00+11:00") - at("2026-10-03T12:00:00+10:00"), 19 * 3600000);
  // 周报周日起算：周五中午 → 周日 08:00；周一 → 下周一。
  assert.equal(
    api.nextRun({ time: "08:00", weekdays: [0] }, at("2026-11-13T12:00:00+11:00")),
    at("2026-11-15T08:00:00+11:00"),
  );
  assert.equal(
    api.nextRun({ time: "08:00", weekdays: [1] }, at("2026-11-15T12:00:00+11:00")),
    at("2026-11-16T08:00:00+11:00"),
  );
  // 一次性提醒：未来给时间，过期给 null。
  assert.equal(api.nextRun({ run_at: at("2026-11-14T09:00:00+11:00") }, at("2026-11-14T08:00:00+11:00")), at("2026-11-14T09:00:00+11:00"));
  assert.equal(api.nextRun({ run_at: at("2026-11-14T08:00:00+11:00") }, at("2026-11-14T09:00:00+11:00")), null);
  assert.match(api.sydneyText(at("2026-04-05T08:00:00+10:00")), /08:00（悉尼）/);
});

test("S2 daily 08:00 digest writes one outbox row and advances to tomorrow", async () => {
  const e = env();
  await seedYesterday(e);
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  assert.equal(created.next_run_at, at("2026-11-13T08:00:00+11:00"));
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].body, /模型能力/);
  assert.equal(out[0].group_id, GROUP);
  assert.ok(out[0].body.split("\n").length <= 8);
  const runs = await rows(e, "SELECT * FROM schedule_runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "ok");
  assert.equal(runs[0].outbox_id, out[0].id);
  const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(after.next_run_at, at("2026-11-14T08:00:00+11:00"));
  assert.equal(after.last_run_at, at("2026-11-13T08:00:10+11:00"));
  assert.equal(after.fail_count, 0);
  assert.equal(after.status, "active");
});

test("S3 concurrent runSchedules claims each due time once", async () => {
  const e = env();
  await seedYesterday(e);
  await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await Promise.all([
      api.runSchedules(e, at("2026-11-13T08:00:10+11:00")),
      api.runSchedules(e, at("2026-11-13T08:00:10+11:00")),
    ]);
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs")).length, 1);
});

test("S4 late digest is still delivered and says how late", async () => {
  const e = env();
  await seedYesterday(e);
  await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:07:00+11:00"));
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1);
  assert.match(out[0].body, /^（晚了 7 分钟）/);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs"))[0].status, "late");
});

test("S5 three failures retry every five minutes then fail visibly and stay active", async () => {
  const e = env();
  await seedYesterday(e);
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub([], { failDigest: true });
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
    let row1 = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
    assert.equal(row1.fail_count, 1);
    assert.equal(row1.next_run_at, at("2026-11-13T08:05:10+11:00"));
    assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0, "no visible failure before the third try");
    await api.runSchedules(e, at("2026-11-13T08:05:10+11:00"));
    await api.runSchedules(e, at("2026-11-13T08:10:10+11:00"));
  } finally {
    s.restore();
  }
  const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(after.fail_count, 3);
  assert.equal(after.status, "active");
  assert.equal(after.next_run_at, at("2026-11-14T08:00:00+11:00"));
  assert.ok(after.last_error);
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].body, /3 次/);
  assert.match(out[0].body, /失败/);
  assert.equal((await rows(e, "SELECT * FROM schedule_runs WHERE status='failed'")).length, 3);
});

test("S6 mute keeps the bot quiet except for @ until it expires", async () => {
  const e = env();
  const now = Date.now();
  const mute = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "mute", spec: { minutes: 10 }, source_msg_id: "msg-286" },
    now,
  );
  assert.equal(mute.next_run_at, now + 10 * 60000);
  assert.equal(await api.muted(e, GROUP, "msg-later", now + 60000), true);
  assert.equal(await api.muted(e, GROUP, "msg-286", now + 60000), false, "the message that created the mute still gets its confirmation");
  assert.equal(await api.muted(e, GROUP, "msg-later", now + 10 * 60000), false);

  const quiet = stub();
  try {
    const c1 = await contextFor(e, { id: "msg-after-mute", body: "随便说一句", ts: new Date(now + 60000).toISOString() });
    assert.equal(await sem.agentAnswer(e, c1), JSON.stringify({ mode: "banter", text: "[[SILENT]]" }));
    assert.equal(quiet.seen.length, 0, "muted non-@ message must not reach the model");
    const c2 = await contextFor(e, { id: "msg-at-mute", body: "@bot 帮我看看", ts: new Date(now + 120000).toISOString(), mentioned: 1 });
    assert.notEqual(await sem.agentAnswer(e, c2), JSON.stringify({ mode: "banter", text: "[[SILENT]]" }));
    assert.ok(quiet.seen.length > 0, "@ message must reach the model during mute");
  } finally {
    quiet.restore();
  }
  await api.runSchedules(e, now + 10 * 60000);
  assert.equal((await row(e, "SELECT status FROM schedules WHERE id=?", mute.id)).status, "done");
  assert.equal(await api.muted(e, GROUP, "msg-later", now + 10 * 60000), false);
});

test("S7 real replay: 351 creates 08:00 daily, 355 lists it, 286 mutes 10 minutes", async () => {
  const e = env();
  const msg351 = replay.messages.find((m) => m.rowid === 351);
  const msg355 = replay.messages.find((m) => m.rowid === 355);
  const msg286 = replay.messages.find((m) => m.rowid === 286);
  const msg348 = replay.messages.find((m) => m.rowid === 348);

  // msg#348 只是要一份手动日报，不能顺手建定时任务。
  let s = stub([], {});
  try {
    await sem.agentAnswer(e, await contextFor(e, { id: "msg-348", body: msg348.body, ts: msg348.ts, mentioned: msg348.mentioned }));
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 0);

  const now = Date.now();
  s = stub([call("schedule_create", { kind: "digest_daily", time: "08:00" })]);
  try {
    await sem.agentAnswer(e, await contextFor(e, { id: "msg-351", body: msg351.body, ts: new Date(now).toISOString(), mentioned: msg351.mentioned }));
  } finally {
    s.restore();
  }
  const created = await rows(e, "SELECT * FROM schedules WHERE kind='digest_daily'");
  assert.equal(created.length, 1);
  assert.equal(created[0].source_msg_id, "msg-351");
  assert.equal(JSON.parse(created[0].spec).time, "08:00");
  assert.match(api.sydneyText(created[0].next_run_at), /08:00（悉尼）/);

  // msg#355「我的日报呢？」→ schedule_list 能看到刚建的任务与下次时间。
  s = stub([call("schedule_list", {})]);
  try {
    await sem.agentAnswer(e, await contextFor(e, { id: "msg-355", body: msg355.body, ts: new Date(now + 5 * 3600000).toISOString(), mentioned: msg355.mentioned }));
  } finally {
    s.restore();
  }
  const listed = s.seen
    .flatMap((b) => b.messages || [])
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content))
    .find((r) => Array.isArray(r.schedules));
  assert.ok(listed, "schedule_list tool result missing");
  assert.equal(listed.schedules[0].id, created[0].id);
  assert.match(listed.schedules[0].next_run_text, /08:00（悉尼）/);

  // msg#286「闭嘴10分钟」→ mute 10 分钟。
  s = stub([call("schedule_create", { kind: "mute", minutes: 10 })]);
  try {
    await sem.agentAnswer(e, await contextFor(e, { id: "msg-286", body: msg286.body, ts: new Date(now).toISOString(), mentioned: msg286.mentioned }));
  } finally {
    s.restore();
  }
  const mute = await rows(e, "SELECT * FROM schedules WHERE kind='mute'");
  assert.equal(mute.length, 1);
  const due = JSON.parse(mute[0].spec).run_at;
  assert.ok(Math.abs(due - (now + 10 * 60000)) < 5000, "mute should end ten minutes after the request");

  console.log("S7 回放：QQ 真实发送 0 次（本地假 D1 + 未调用 sendOutbox），线上 D1 写入 0 行");
});

test("S8 migration is idempotent, unique per due time and registered for deploy", () => {
  const d = new DatabaseSync(":memory:");
  const migration = readFileSync("migrations/0009_f6_schedules.sql", "utf8");
  for (let i = 0; i < 2; i++) {
    d.exec(readFileSync("schema.sql", "utf8"));
    d.exec(migration);
  }
  assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='schedules'").get());
  assert.ok(d.prepare("SELECT name FROM sqlite_master WHERE name='schedule_runs'").get());
  d.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status) VALUES('r1','s1',1,'pending')").run();
  assert.throws(() =>
    d.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status) VALUES('r2','s1',1,'pending')").run(),
  );
  assert.ok(readFileSync("scripts/migrate.mjs", "utf8").includes("migrations/0009_f6_schedules.sql"));
  d.close();
});

test("S9 one-off reminder fires once and can be cancelled", async () => {
  const e = env();
  const now = at("2026-11-13T07:00:00+11:00");
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "reminder", spec: { minutes: 10, text: "喝水" }, source_msg_id: "msg-remind" },
    now,
  );
  assert.equal(created.next_run_at, now + 10 * 60000);
  const s = stub();
  try {
    await api.runSchedules(e, now + 10 * 60000 + 30000);
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1);
  assert.equal(out[0].body, "喝水");
  const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(after.status, "done");
  assert.equal(after.next_run_at, null);

  const again = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "reminder", spec: { minutes: 20, text: "开会" }, source_msg_id: "msg-remind-2" },
    now,
  );
  assert.ok(await api.cancelSchedule(e, GROUP, again.id));
  assert.equal((await row(e, "SELECT status FROM schedules WHERE id=?", again.id)).status, "cancelled");
  assert.equal(await api.cancelSchedule(e, "OTHER-GROUP", again.id), null, "cannot cancel another group's schedule");
});

test("S10 empty group digest says so without calling the model", async () => {
  const e = env();
  await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1);
  assert.equal(out[0].body, "昨天群里没有新消息。");
  assert.equal(s.seen.length, 0, "empty day must not spend a model call");
});

test("S11 weekly digest covers the last seven Sydney days, Sunday to Sunday", async () => {
  const e = env();
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_weekly", spec: { time: "08:00", weekdays: [0] }, source_msg_id: "msg-weekly" },
    at("2026-11-14T12:00:00+11:00"),
  );
  assert.equal(created.next_run_at, at("2026-11-15T08:00:00+11:00"));
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,0)",
  )
    .bind("week-old", GROUP, "U1", "七天前的决定", "2026-11-09T10:00:00+11:00")
    .run();
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,0)",
  )
    .bind("too-old", GROUP, "U1", "九天前的旧事", "2026-11-06T10:00:00+11:00")
    .run();
  const s = stub();
  try {
    await api.runSchedules(e, at("2026-11-15T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const prompt = s.seen[0]?.messages?.find((m) => m.role === "user")?.content || "";
  assert.match(prompt, /七天前的决定/);
  assert.doesNotMatch(prompt, /九天前的旧事/);
  assert.match((await rows(e, "SELECT * FROM outbox"))[0].body, /模型能力/);
});

test("S12 a crashed claim is retried once and never duplicates the outbox row", async () => {
  const e = env();
  await seedYesterday(e);
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "msg-351" },
    at("2026-11-13T07:59:00+11:00"),
  );
  const due = created.next_run_at;
  const runId = `run-${created.id}-${due}`;
  // 模拟上一位执行者抢占后被杀，并且已经写入 outbox、没来得及推进日程。
  await e.DB.prepare(
    "INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,status) VALUES(?,?,?,?,'running')",
  )
    .bind(runId, created.id, due, due - 11 * 60000)
    .run();
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
    .bind(`sched-${created.id}-${due}`, GROUP, "msg-351", "旧的一份", "pending", due)
    .run();
  const s = stub();
  try {
    await api.runSchedules(e, due + 1000);
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1, "same due time must not create a second outbox row");
  assert.equal((await row(e, "SELECT status FROM schedule_runs WHERE id=?", runId)).status, "ok");
  assert.equal((await row(e, "SELECT next_run_at FROM schedules WHERE id=?", created.id)).next_run_at, at("2026-11-14T08:00:00+11:00"));
});

test("S13 the cron handler itself sends a due reminder into the outbox", async () => {
  const e = env();
  const now = Date.now();
  await e.DB.prepare(
    "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'active',?,0,?,?)",
  )
    .bind("sched-wiring", GROUP, "U1", "reminder", "Australia/Sydney", JSON.stringify({ run_at: now - 1000, text: "接线检查" }), now - 1000, now - 2000, "msg-reminder")
    .run();
  const s = stub();
  let pending;
  try {
    await worker.scheduled({}, e, { waitUntil: (p) => { pending = p; } });
    await pending;
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox");
  assert.equal(out.length, 1, JSON.stringify(out));
  assert.match(out[0].body, /接线检查/);
  assert.equal(s.foreign, 0, "no real QQ call from the cron handler in the fake env");
  assert.equal((await row(e, "SELECT status FROM schedules WHERE id='sched-wiring'")).status, "done");
});

test("S14 run_at without a timezone is read as Sydney wall time", async () => {
  const e = env();
  const created = await api.createSchedule(
    e,
    { group_id: GROUP, owner: "U1", kind: "reminder", spec: { run_at: "2026-11-14T09:00:00", text: "开会" }, source_msg_id: "msg-local" },
    at("2026-11-14T01:00:00+11:00"),
  );
  assert.equal(created.next_run_at, at("2026-11-14T09:00:00+11:00"));
  assert.equal(new Date(created.next_run_at).toISOString(), "2026-11-13T22:00:00.000Z");
});

test('S15 schedules missed by more than two hours are skipped without model or outbox and recurring advances',async()=>{
  for(const kind of ['digest_daily','digest_weekly','reminder']){
    const e=env(),now=at('2026-11-13T07:59:00+11:00');
    const s=await api.createSchedule(e,{group_id:GROUP,owner:'U1',kind,spec:kind==='reminder'?{minutes:1,text:'提醒'}:{time:'08:00',weekdays:[5]},source_msg_id:'old-'+kind},now);
    const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('no network');};
    try{await api.runSchedules(e,s.next_run_at+2*3600000+1);}finally{globalThis.fetch=old;}
    assert.equal((await rows(e,'SELECT * FROM outbox')).length,0,kind);
    assert.equal((await rows(e,'SELECT * FROM schedule_runs'))[0].status,'skipped',kind);
    const after=await row(e,'SELECT * FROM schedules WHERE id=?',s.id);
    assert.equal(after.status,kind==='reminder'?'done':'active');
    if(kind!=='reminder')assert.ok(after.next_run_at>s.next_run_at+2*3600000);
    assert.equal(calls,0);
  }
});
