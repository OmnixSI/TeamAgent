import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { env, req } from "./support.mjs";

// F6P-3：01:11+08（04:11 Sydney）的真实请求 + outbox#206 的承诺。
// 回放只写本地内存 SQLite；模型是确定性 stub；QQ/线上 D1 都不碰。
const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/daily-push-real.json", import.meta.url), "utf8"),
);
const GROUP = fixture.request.group_id;
const at = (s) => Date.parse(s);

const outfile = `.wrangler/daily-push-${process.pid}.mjs`;
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

function stubDigest(lines = "• 要点一\n• 要点二\n• 最该推进：验收") {
  const old = globalThis.fetch;
  const seen = [];
  let foreign = 0;
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) {
      foreign++;
      throw Error("unexpected network: " + url);
    }
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("只写群里发布的日报正文"))
      return Response.json({
        choices: [{ message: { content: lines }, finish_reason: "stop" }],
      });
    return Response.json({
      choices: [{ message: { content: "好" }, finish_reason: "stop" }],
    });
  };
  return {
    seen,
    get foreign() {
      return foreign;
    },
    restore() {
      globalThis.fetch = old;
    },
  };
}

async function seed(e, messages = fixture.messages) {
  for (const m of messages)
    await e.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
    )
      .bind(m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned)
      .run();
}

const INPUT = {
  group_id: GROUP,
  owner: fixture.request.sender,
  kind: "digest_daily",
  spec: { time: "08:00" },
  source_msg_id: fixture.request.id,
};

test("D1 planSchedule is pure and returns exactly the row createSchedule writes", async () => {
  const e = env();
  const now = at("2026-11-13T04:11:39+11:00");
  const plan = api.planSchedule(INPUT, now);
  assert.equal(plan.id, "sched-digest_daily-" + fixture.request.id);
  assert.equal(plan.group_id, GROUP);
  assert.equal(plan.owner, fixture.request.sender);
  assert.equal(plan.kind, "digest_daily");
  assert.equal(plan.tz, "Australia/Sydney");
  assert.equal(plan.spec.time, "08:00");
  assert.equal(plan.next_run_at, at("2026-11-13T08:00:00+11:00"));
  assert.equal(plan.source_msg_id, fixture.request.id);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 0, "dry-run must not write");
  const created = await api.createSchedule(e, INPUT, now);
  assert.equal(created.id, plan.id);
  assert.equal(created.next_run_at, plan.next_run_at);
  assert.equal(created.spec, JSON.stringify(plan.spec));
  assert.equal(created.created_at, plan.created_at);
});

test("D2 real 01:11 request creates 08:00 daily; 08:00 triggers one local outbox; same day never repeats", async () => {
  const e = env();
  await seed(e);
  const created = await api.createSchedule(e, INPUT, at("2026-11-13T04:11:39+11:00"));
  assert.equal(created.next_run_at, at("2026-11-13T08:00:00+11:00"));
  let s = stubDigest();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const first = await rows(e, "SELECT * FROM outbox");
  assert.equal(first.length, 1, JSON.stringify(first));
  assert.equal(first[0].group_id, GROUP);
  assert.ok(first[0].body.split("\n").length <= 8);
  const prompt = s.seen[0]?.messages?.find((m) => m.role === "user")?.content || "";
  assert.match(prompt, /模型能力转化为产品能力/);
  assert.doesNotMatch(
    prompt,
    /把今天群里的对话和讨论的内容给我总结一个日报/,
    "08:00 on 11-13 must summarize 11-12, not 11-13",
  );
  const run = await rows(e, "SELECT * FROM schedule_runs");
  assert.equal(run.length, 1);
  assert.equal(run[0].status, "ok");
  assert.equal(run[0].outbox_id, first[0].id);
  const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(after.next_run_at, at("2026-11-14T08:00:00+11:00"));
  assert.equal(after.status, "active");
  s = stubDigest();
  try {
    await api.runSchedules(e, at("2026-11-13T08:01:00+11:00"));
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1, "same day must not repeat");
  assert.equal((await rows(e, "SELECT * FROM schedule_runs")).length, 1);
  assert.equal(s.seen.length, 0, "no duplicate model call");
});

test("D3 next day 08:00 summarizes 11-13 and advances; both days exactly one push", async () => {
  const e = env();
  await seed(e);
  await api.createSchedule(e, INPUT, at("2026-11-13T04:11:39+11:00"));
  let s = stubDigest();
  try {
    await api.runSchedules(e, at("2026-11-13T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  s = stubDigest();
  try {
    await api.runSchedules(e, at("2026-11-14T08:00:10+11:00"));
  } finally {
    s.restore();
  }
  const out = await rows(e, "SELECT * FROM outbox ORDER BY created_at");
  assert.equal(out.length, 2);
  const prompt = s.seen[0]?.messages?.find((m) => m.role === "user")?.content || "";
  assert.match(prompt, /把今天群里的对话和讨论的内容给我总结一个日报/);
  assert.doesNotMatch(prompt, /模型能力转化为产品能力/, "11-14 push must not include 11-12 messages");
  assert.equal(
    (await row(e, "SELECT next_run_at FROM schedules WHERE kind='digest_daily'")).next_run_at,
    at("2026-11-15T08:00:00+11:00"),
  );
});

test("D4 exactly 15 minutes late still sends with a late note; 15 minutes + 1 ms is skipped without model/outbox", async () => {
  for (const [lateMs, expectOutbox, expectStatus] of [
    [15 * 60000, 1, "late"],
    [15 * 60000 + 1, 0, "skipped"],
  ]) {
    const e = env();
    await seed(e);
    const created = await api.createSchedule(e, INPUT, at("2026-11-13T04:11:39+11:00"));
    const s = stubDigest();
    try {
      await api.runSchedules(e, created.next_run_at + lateMs);
    } finally {
      s.restore();
    }
    const out = await rows(e, "SELECT * FROM outbox");
    assert.equal(out.length, expectOutbox, `lateMs=${lateMs}`);
    if (expectOutbox) assert.match(out[0].body, /^（晚了 15 分钟）/);
    const run = (await rows(e, "SELECT * FROM schedule_runs"))[0];
    assert.equal(run.status, expectStatus, `lateMs=${lateMs}`);
    if (!expectOutbox) {
      assert.equal(s.seen.length, 0, "skipped run must not call the model");
      assert.equal(run.error, "expired");
      const after = await row(e, "SELECT * FROM schedules WHERE id=?", created.id);
      assert.equal(after.next_run_at, at("2026-11-14T08:00:00+11:00"));
      assert.equal(after.last_error, "expired");
    }
  }
});

test("D5 Sydney DST fall-back and spring-forward days each push exactly once and never skip", async () => {
  // 2026-04-05 03:00 AEDT -> 02:00 AEST (fall back); 2026-10-04 02:00 AEST -> 03:00 AEDT (spring forward).
  const cases = [
    {
      start: "2026-04-04T07:59:00+11:00",
      days: [
        "2026-04-04T08:00:10+11:00",
        "2026-04-05T08:00:10+10:00",
        "2026-04-06T08:00:10+10:00",
      ],
      next: "2026-04-07T08:00:00+10:00",
    },
    {
      start: "2026-10-03T07:59:00+10:00",
      days: [
        "2026-10-03T08:00:10+10:00",
        "2026-10-04T08:00:10+11:00",
        "2026-10-05T08:00:10+11:00",
      ],
      next: "2026-10-06T08:00:00+11:00",
    },
  ];
  for (const c of cases) {
    const e = env();
    const created = await api.createSchedule(
      e,
      { ...INPUT, source_msg_id: "dst-" + c.start },
      at(c.start),
    );
    assert.equal(created.next_run_at, at(c.days[0]) - 10000);
    let total = 0;
    for (const day of c.days) {
      const s = stubDigest();
      try {
        await api.runSchedules(e, at(day));
        await api.runSchedules(e, at(day) + 60000);
      } finally {
        s.restore();
      }
      total++;
      const out = await rows(e, "SELECT * FROM outbox");
      assert.equal(out.length, total, `${day} should add exactly one`);
    }
    assert.equal(
      (await row(e, "SELECT next_run_at FROM schedules WHERE id=?", created.id)).next_run_at,
      at(c.next),
    );
    assert.equal((await rows(e, "SELECT * FROM schedule_runs WHERE status='ok'")).length, 3);
    assert.equal((await rows(e, "SELECT * FROM schedule_runs WHERE status='skipped'")).length, 0);
  }
});

test("D6 admin daily-push is owner-only, dry-run writes nothing, confirm is idempotent", async () => {
  const e = env();
  await seed(e);
  const body = { source_msg_id: fixture.request.id, time: "08:00", dry_run: true };
  const dry = await req(e, "/api/admin/daily-push", body);
  assert.equal(dry.status, 200);
  const dj = await dry.json();
  assert.equal(dj.ok, true);
  assert.equal(dj.dry_run, true);
  assert.equal(dj.would_write, true);
  assert.equal(dj.schedule.id, "sched-digest_daily-" + fixture.request.id);
  assert.match(dj.schedule.next_run_text, /08:00（悉尼）/);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 0, "dry-run wrote a row");

  const denied = await req(e, "/api/admin/daily-push", body, "wrong-token");
  assert.ok([401, 403].includes(denied.status), "non-owner token must be denied: " + denied.status);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 0);

  const ok = await req(e, "/api/admin/daily-push", { ...body, dry_run: false });
  assert.equal(ok.status, 200);
  const oj = await ok.json();
  assert.equal(oj.ok, true);
  assert.equal(oj.dry_run, false);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 1);
  const again = await req(e, "/api/admin/daily-push", { ...body, dry_run: false });
  assert.equal(again.status, 200);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 1, "must be idempotent");
});
