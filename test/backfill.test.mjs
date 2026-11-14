// B-l8 回填提案接口与扫描脚本。
// 真实夹具：test/fixtures/daily-push-real.json（t.o.o. 11-13 04:11:39 Sydney 原话）。
// 所有写入只进本地内存 SQLite；不调线上、不发 QQ、不请求真实模型。
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env, req } from "./support.mjs";
import { main } from "../scripts/backfill-schedule-requests.mjs";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/daily-push-real.json", import.meta.url), "utf8"),
);
const GROUP = fixture.request.group_id;
const SOURCE = fixture.request.id;
const OWNER = fixture.request.sender;
const ACK =
  "t.o.o.，你 13 号说的每天早上 8 点推昨日总结，我当时没真建上，现在建好了，明天 08:00 第一份，会写精简。不想要了回那条说「不用再发了」。";

const outfile = `.wrangler/backfill-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/schedules";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);

const rows = async (e, table) =>
  (await e.DB.prepare(/^\s*SELECT/i.test(table) ? table : "SELECT * FROM " + table).all()).results;
const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();

async function seed(e) {
  for (const m of fixture.messages)
    await e.DB.prepare(
      "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
    )
      .bind(m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned)
      .run();
}

function replayDb(dir) {
  const file = join(dir, "replay.sqlite");
  const db = new DatabaseSync(file);
  db.exec(
    "CREATE TABLE messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,sender TEXT NOT NULL,body TEXT NOT NULL,ts TEXT NOT NULL,mentioned INTEGER NOT NULL DEFAULT 0)",
  );
  const insert = db.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  );
  for (const m of fixture.messages) insert.run(m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned);
  db.close();
  return file;
}

test("B1 dry-run with dedup/request_quote/ack writes nothing and keeps the plan shape", async () => {
  const e = env();
  await seed(e);
  const body = {
    source_msg_id: SOURCE,
    time: "08:00",
    dedup: "morning-report",
    request_quote: fixture.request.body.slice(0, 200),
    ack: ACK,
    dry_run: true,
  };
  const res = await req(e, "/api/admin/daily-push", body);
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.ok, true);
  assert.equal(j.dry_run, true);
  assert.equal(j.would_write, true);
  assert.equal(j.schedule.id, "sched-digest_daily-" + SOURCE);
  assert.equal(j.ack, "sched-ack:" + j.schedule.id);
  const spec = JSON.parse(j.schedule.spec);
  assert.equal(spec.time, "08:00");
  assert.equal(spec.dedup, "morning-report");
  assert.equal(spec.origin, "backfill");
  assert.match(spec.request_quote, /精简/);
  for (const table of ["schedules", "outbox", "learning_acks"])
    assert.equal((await rows(e, table)).length, 0, table + " written by dry-run");
});

test("B2 apply forwards the fields; ack outbox and learning_acks share one batch and replay idempotently", async () => {
  const e = env();
  await seed(e);
  let batches = 0;
  const original = e.DB.batch.bind(e.DB);
  e.DB.batch = (statements) => {
    batches++;
    return original(statements);
  };
  const body = {
    source_msg_id: SOURCE,
    time: "08:00",
    dedup: "morning-report",
    request_quote: fixture.request.body.slice(0, 200),
    ack: ACK,
    dry_run: false,
  };
  const res = await req(e, "/api/admin/daily-push", body);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(batches, 1, "schedule + ack + learning_acks must share one batch");

  const schedules = await rows(e, "SELECT * FROM schedules");
  assert.equal(schedules.length, 1);
  const spec = JSON.parse(schedules[0].spec);
  assert.equal(spec.dedup, "morning-report");
  assert.equal(spec.origin, "backfill");
  assert.match(spec.request_quote, /精简/);
  const outbox = await rows(e, "SELECT * FROM outbox");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, "sched-ack:" + schedules[0].id);
  assert.equal(outbox[0].group_id, GROUP);
  assert.equal(outbox[0].msg_id, SOURCE);
  assert.equal(outbox[0].body, ACK);
  assert.equal(outbox[0].status, "pending");
  const acks = await rows(e, "SELECT * FROM learning_acks");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].outbox_id, outbox[0].id);
  assert.equal(acks[0].group_id, GROUP);
  assert.deepEqual(JSON.parse(acks[0].refs), [{ type: "schedule", id: schedules[0].id }]);

  // 重放：不新增日程、回执或 ack 行。
  assert.equal((await req(e, "/api/admin/daily-push", body)).status, 200);
  assert.equal(batches, 2);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 1);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 1);
  assert.equal((await rows(e, "SELECT * FROM learning_acks")).length, 1);
});

test("B3 learning-backfill dry-run writes nothing; apply proposes once and replays to the same id", async () => {
  const e = env();
  await seed(e);
  const body = {
    source_msg_id: SOURCE,
    kind: "rule",
    subkind: "avoid_phrase",
    params: { phrase: "草" },
    plain: "不要再说「草」。",
    dry_run: true,
  };
  const dry = await req(e, "/api/admin/learning-backfill", body);
  assert.equal(dry.status, 200);
  const dj = await dry.json();
  assert.equal(dj.ok, true);
  assert.equal(dj.dry_run, true);
  assert.equal(dj.would_write, true);
  assert.match(dj.learning.id, /^ln-[0-9a-f]{12}$/);
  assert.equal((await rows(e, "SELECT * FROM review_learnings")).length, 0, "dry-run wrote a row");

  const applied = await req(e, "/api/admin/learning-backfill", { ...body, dry_run: false });
  assert.equal(applied.status, 200);
  const aj = await applied.json();
  assert.equal(aj.ok, true);
  assert.equal(aj.learning.id, dj.learning.id);
  const learnings = await rows(e, "SELECT * FROM review_learnings");
  assert.equal(learnings.length, 1);
  const saved = learnings[0];
  assert.equal(saved.id, dj.learning.id);
  assert.equal(saved.group_id, GROUP);
  assert.equal(saved.kind, "rule");
  assert.equal(saved.subkind, "avoid_phrase");
  assert.equal(saved.requester, OWNER, "requester must be the original sender");
  assert.equal(saved.source_msg_id, SOURCE);
  assert.equal(saved.quote, fixture.request.body);
  assert.equal(saved.run_id, "backfill");
  assert.equal(saved.status, "proposed");
  assert.equal(saved.plain, "不要再说「草」。");
  assert.deepEqual(JSON.parse(saved.params), { phrase: "草" });

  const again = await req(e, "/api/admin/learning-backfill", { ...body, dry_run: false });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).learning.id, dj.learning.id);
  assert.equal((await rows(e, "SELECT * FROM review_learnings")).length, 1, "replay must not duplicate");
});

test("B4 learning-backfill accepts schedule proposals and validates params with L1/L3", async () => {
  const e = env();
  await seed(e);
  // 周报：原话没给时间，08:00 是设计给的默认值；计划由 L1 的 planSchedule 校验。
  const weekly = {
    source_msg_id: SOURCE,
    kind: "schedule",
    subkind: "weekly",
    params: { time: "08:00", weekdays: [0], topic: "上周总结" },
    plain: "每周日 08:00（悉尼）发上周总结",
    dry_run: false,
  };
  const res = await req(e, "/api/admin/learning-backfill", weekly);
  assert.equal(res.status, 200);
  const saved = await row(e, "SELECT * FROM review_learnings WHERE id=?", (await res.json()).learning.id);
  assert.equal(saved.kind, "schedule");
  assert.equal(saved.subkind, "weekly");
  assert.deepEqual(JSON.parse(saved.params), { time: "08:00", weekdays: [0], topic: "上周总结" });

  const badTime = await req(e, "/api/admin/learning-backfill", { ...weekly, params: { time: "25:00" }, plain: "每天 25:00" });
  assert.equal(badTime.status, 400);
  const badAddress = await req(e, "/api/admin/learning-backfill", {
    ...weekly,
    kind: "rule",
    subkind: "address_as",
    params: { member: "SOMEONE-ELSE", name: "马哥" },
    plain: "叫我马哥",
  });
  assert.equal(badAddress.status, 400, "address_as may only name its own requester");
  assert.equal((await rows(e, "SELECT * FROM review_learnings")).length, 1);
});

test("B5 both admin routes are owner-only and reject a forged source_msg_id", async () => {
  const e = env();
  await seed(e);
  const learning = {
    source_msg_id: SOURCE,
    kind: "rule",
    subkind: "avoid_phrase",
    params: { phrase: "草" },
    plain: "不要再说「草」。",
    dry_run: true,
  };
  const denied = await req(e, "/api/admin/learning-backfill", learning, "wrong-token");
  assert.equal(denied.status, 401, "unknown token is not signed in");
  const memberToken = "member-token";
  await e.DB.prepare("INSERT INTO members(id,name,token_hash,role,revoked) VALUES('m1','member',?,'member',0)")
    .bind(createHash("sha256").update(memberToken).digest("hex"))
    .run();
  const nonOwner = await req(e, "/api/admin/learning-backfill", learning, memberToken);
  assert.equal(nonOwner.status, 403, "signed-in non-owner must be owner-only");
  const forged = await req(e, "/api/admin/learning-backfill", { ...learning, source_msg_id: "not-a-real-message" });
  assert.equal(forged.status, 404);
  const forgedDaily = await req(e, "/api/admin/daily-push", {
    source_msg_id: "not-a-real-message",
    time: "08:00",
    dry_run: true,
  });
  assert.equal(forgedDaily.status, 404);
  const deniedDaily = await req(e, "/api/admin/daily-push", {
    source_msg_id: SOURCE,
    time: "08:00",
    dry_run: true,
  }, "wrong-token");
  assert.equal(deniedDaily.status, 401);
  const nonOwnerDaily = await req(e, "/api/admin/daily-push", {
    source_msg_id: SOURCE,
    time: "08:00",
    dry_run: true,
  }, memberToken);
  assert.equal(nonOwnerDaily.status, 403, "signed-in non-owner must be owner-only");
});

test("B6 script without flags only lists candidates locally: 0 API calls, 0 D1 writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teamagent-backfill-"));
  try {
    const dbFile = replayDb(dir);
    const out = join(dir, "candidates.json");
    let calls = 0;
    const logs = [];
    const result = await main([], {
      dbPath: dbFile,
      outPath: out,
      fetchImpl: async () => {
        calls++;
        throw Error("script must not call the network without --propose/--apply");
      },
      log: (line) => logs.push(line),
    });
    assert.equal(calls, 0);
    assert.equal(result.ok, true);
    assert.equal(result.writes, 0);
    assert.equal(existsSync(out), true);
    const doc = JSON.parse(readFileSync(out, "utf8"));
    const daily = doc.candidates.find((c) => c.source_msg_id === SOURCE);
    assert.ok(daily, "the real 04:11 request must be listed");
    assert.equal(daily.mentioned, 1);
    assert.equal(daily.suggestion.kind, "schedule");
    assert.equal(daily.suggestion.subkind, "daily");
    assert.equal(daily.suggestion.params.time, "08:00");
    assert.equal(daily.suggestion.params.topic, undefined, "昨日总结 is the default digest, not a topic");
    assert.ok(doc.proposals.some((p) => p.subkind === "weekly"), "the weekly proposal is curated from its real words");
    const reopened = new DatabaseSync(dbFile, { readOnly: true });
    assert.equal(reopened.prepare("SELECT COUNT(*) AS n FROM messages").get().n, fixture.messages.length);
    reopened.close();
    assert.equal(logs.join("\n").includes("token"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B7 script --propose defaults to dry-run and sends the owner token without printing it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teamagent-backfill-"));
  const old = process.env.TEAM_ADMIN_TOKEN;
  process.env.TEAM_ADMIN_TOKEN = "owner-secret";
  try {
    const dbFile = replayDb(dir);
    const out = join(dir, "candidates.json");
    const calls = [];
    const logs = [];
    const result = await main(["--propose", "--url", "https://team.example"], {
      dbPath: dbFile,
      outPath: out,
      fetchImpl: async (url, opt) => {
        calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.Authorization });
        return Response.json({ ok: true, dry_run: true, would_write: true, learning: { id: "ln-000000000000" } });
      },
      log: (line) => logs.push(line),
    });
    assert.equal(result.ok, true);
    assert.ok(calls.length >= 1);
    for (const call of calls) {
      assert.equal(call.url, "https://team.example/api/admin/learning-backfill");
      assert.equal(call.body.dry_run, true, "propose defaults to dry_run");
      assert.equal(call.auth, "Bearer owner-secret");
      assert.equal(call.body.source_msg_id.length > 0, true);
    }
    assert.equal(calls[0].body.kind, "schedule");
    assert.deepEqual(calls[0].body.params.weekdays, [0]);
    assert.equal(logs.join("\n").includes("owner-secret"), false, "the token must never be logged");
  } finally {
    if (old == null) delete process.env.TEAM_ADMIN_TOKEN;
    else process.env.TEAM_ADMIN_TOKEN = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("B8 backfillSchedule is idempotent without ack and keeps the existing createSchedule result", async () => {
  const e = env();
  await seed(e);
  const input = {
    group_id: GROUP,
    owner: OWNER,
    kind: "digest_daily",
    spec: { time: "08:00" },
    source_msg_id: SOURCE,
  };
  const now = Date.parse("2026-11-13T04:11:39+11:00");
  const planned = api.planSchedule(input, now);
  const first = await api.backfillSchedule(e, input, { now });
  assert.equal(first.row.id, planned.id);
  const second = await api.backfillSchedule(e, input, { now });
  assert.equal(second.row.id, planned.id);
  assert.equal((await rows(e, "SELECT * FROM schedules")).length, 1);
  assert.equal((await rows(e, "SELECT * FROM outbox")).length, 0, "no ack means no receipt");
  assert.equal((await rows(e, "SELECT * FROM learning_acks")).length, 0);
});

test("B9 script --apply targets exactly one candidate and forwards dedup/request_quote/ack as dry-run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "teamagent-backfill-"));
  const old = process.env.TEAM_ADMIN_TOKEN;
  process.env.TEAM_ADMIN_TOKEN = "owner-secret";
  try {
    const dbFile = replayDb(dir);
    const calls = [];
    const result = await main(
      [
        "--apply", "--only", SOURCE, "--dedup", "morning-report",
        "--ack", ACK, "--url", "https://team.example",
      ],
      {
        dbPath: dbFile,
        outPath: join(dir, "candidates.json"),
        fetchImpl: async (url, opt) => {
          calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.Authorization });
          return Response.json({
            ok: true,
            dry_run: true,
            would_write: true,
            schedule: { id: "sched-digest_daily-" + SOURCE },
            ack: "sched-ack:sched-digest_daily-" + SOURCE,
          });
        },
        log: () => {},
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.writes, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://team.example/api/admin/daily-push");
    assert.equal(calls[0].auth, "Bearer owner-secret");
    assert.equal(calls[0].body.source_msg_id, SOURCE);
    assert.equal(calls[0].body.time, "08:00");
    assert.equal(calls[0].body.dedup, "morning-report");
    assert.match(calls[0].body.request_quote, /精简/);
    assert.equal(calls[0].body.ack, ACK);
    assert.equal(calls[0].body.dry_run, true);
  } finally {
    if (old == null) delete process.env.TEAM_ADMIN_TOKEN;
    else process.env.TEAM_ADMIN_TOKEN = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
