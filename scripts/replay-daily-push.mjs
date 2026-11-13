// F6P-3 离线回放：真实 01:11 请求 + 真实群消息，独立临时 SQLite，假时钟。
// 不写线上 D1、不发 QQ、不请求真实模型；只验证 runSchedules 的到期/去重/DST/错过上界。
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const temp = mkdtempSync(join(tmpdir(), "teamagent-daily-push-"));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
let modelCalls = 0;
let db;
let envNo = 0;

function adapter(database) {
  const statement = (sql, args = []) => ({
    sql,
    bind(...xs) {
      return statement(sql, xs);
    },
    async first() {
      return database.prepare(sql).get(...args) || null;
    },
    async all() {
      return { results: database.prepare(sql).all(...args) };
    },
    async run() {
      return database.prepare(sql).run(...args);
    },
  });
  return {
    prepare: statement,
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const s of statements)
          results.push(
            await (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run()),
          );
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function makeEnv() {
  const database = new DatabaseSync(join(temp, `replay-${++envNo}.sqlite`));
  database.exec(readFileSync(join(root, "schema.sql"), "utf8"));
  return {
    db: database,
    e: {
      DB: adapter(database),
      DEEPSEEK_API_KEY: "offline-only",
      MODEL: "deepseek-flash",
    },
  };
}

const at = (s) => Date.parse(s);
const count = (database, sql, ...args) => database.prepare(sql).get(...args)?.n ?? 0;
const row = (database, sql, ...args) => database.prepare(sql).get(...args) || null;

try {
  const bundle = join(temp, "replay.mjs");
  await build({
    absWorkingDir: root,
    stdin: {
      contents: 'export * from "./src/schedules";',
      resolveDir: root,
      loader: "ts",
    },
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: bundle,
  });
  const api = await import(pathToFileURL(bundle).href);
  const fixture = JSON.parse(
    readFileSync(join(root, "test/fixtures/daily-push-real.json"), "utf8"),
  );
  const GROUP = fixture.request.group_id;
  const INPUT = {
    group_id: GROUP,
    owner: fixture.request.sender,
    kind: "digest_daily",
    spec: { time: "08:00" },
    source_msg_id: fixture.request.id,
  };
  const digestPrompts = [];

  // 确定性离线模型：只接受日报 system prompt；其它网络一律记为违规。
  globalThis.fetch = async (url, opt) => {
    if (String(url) !== "https://api.deepseek.com/chat/completions") {
      networkCalls++;
      throw Error("Replay forbids network: " + url);
    }
    const body = JSON.parse(opt.body || "{}");
    const system = String(body.messages?.[0]?.content || "");
    if (!system.includes("只写群里发布的日报正文")) {
      networkCalls++;
      throw Error("Unexpected model call in replay");
    }
    modelCalls++;
    digestPrompts.push(body.messages.find((m) => m.role === "user")?.content || "");
    return Response.json({
      choices: [
        {
          message: {
            content: "• 昨日要点一\n• 昨日要点二\n• 最该推进：验收日推",
          },
          finish_reason: "stop",
        },
      ],
    });
  };

  const main = makeEnv();
  db = main.db;
  const insert = db.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  );
  for (const m of fixture.messages)
    insert.run(m.id, m.group_id, m.sender, m.body, m.ts, m.mentioned);

  const created = await api.createSchedule(main.e, INPUT, at(fixture.request.ts));
  assert.equal(created.next_run_at, at("2026-11-13T08:00:00+11:00"));
  console.log(
    `请求 ${fixture.request.ts}（Sydney 04:11）| 建 ${created.kind} ${JSON.parse(created.spec).time} ${created.tz} | 首次 ${api.sydneyText(created.next_run_at)}`,
  );
  console.log(
    `outbox#${fixture.outbox_206.rowid} @ ${fixture.outbox_206.created_at_sydney} 承认「定时任务没真落地」；本回放补上 schedules=1`,
  );

  // 第一次到期：11-13 08:00，昨日 = 11-12。
  await api.runSchedules(main.e, at("2026-11-13T08:00:10+11:00"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM outbox"), 1);
  assert.equal(count(db, "SELECT COUNT(*) n FROM schedule_runs"), 1);
  assert.equal(row(db, "SELECT status FROM schedule_runs").status, "ok");
  assert.match(digestPrompts[0], /模型能力转化为产品能力/);
  assert.doesNotMatch(digestPrompts[0], /把今天群里的对话和讨论的内容给我总结一个日报/);
  assert.equal(
    row(db, "SELECT next_run_at FROM schedules WHERE id=?", created.id).next_run_at,
    at("2026-11-14T08:00:00+11:00"),
  );
  const firstBody = row(db, "SELECT body FROM outbox").body;
  assert.ok(firstBody.split("\n").length <= 8);
  console.log(
    `2026-11-13 08:00 到期 | outbox 1 条（${firstBody.split("\n").length} 行，昨日 11-12 真实消息）| next ${api.sydneyText(row(db, "SELECT next_run_at FROM schedules WHERE id=?", created.id).next_run_at)}`,
  );

  // 同一天再跑：不能重复。
  await api.runSchedules(main.e, at("2026-11-13T08:01:00+11:00"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM outbox"), 1);
  assert.equal(modelCalls, 1);
  console.log("2026-11-13 08:01 同日再跑 | outbox 新增 0，模型调用 0");

  // 第二次到期：11-14 08:00，昨日 = 11-13。
  await api.runSchedules(main.e, at("2026-11-14T08:00:10+11:00"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM outbox"), 2);
  assert.match(digestPrompts[1], /把今天群里的对话和讨论的内容给我总结一个日报/);
  assert.doesNotMatch(digestPrompts[1], /模型能力转化为产品能力/);
  assert.equal(
    row(db, "SELECT next_run_at FROM schedules WHERE id=?", created.id).next_run_at,
    at("2026-11-15T08:00:00+11:00"),
  );
  console.log(
    `2026-11-14 08:00 到期 | outbox 累计 2 条（昨日 11-13 真实消息）| next ${api.sydneyText(row(db, "SELECT next_run_at FROM schedules WHERE id=?", created.id).next_run_at)}`,
  );

  // 错过 >15 分钟：不补、不调用模型；周期任务推进到 11-16。
  await api.runSchedules(main.e, at("2026-11-15T08:16:00+11:00"));
  assert.equal(count(db, "SELECT COUNT(*) n FROM outbox"), 2);
  assert.equal(modelCalls, 2);
  const skipped = row(db, "SELECT * FROM schedule_runs WHERE status='skipped'");
  assert.ok(skipped, "missing skipped run");
  assert.equal(skipped.error, "expired");
  const afterSkip = row(db, "SELECT * FROM schedules WHERE id=?", created.id);
  assert.equal(afterSkip.next_run_at, at("2026-11-16T08:00:00+11:00"));
  assert.equal(afterSkip.last_error, "expired");
  console.log(
    `2026-11-15 08:16 到期（晚 16 分钟）| schedule_runs skipped/expired，outbox 新增 0，next ${api.sydneyText(afterSkip.next_run_at)}`,
  );

  // 夏令时切换日：2026-04-05（AEDT→AEST）与 2026-10-04（AEST→AEDT）。
  const dstCases = [
    {
      start: "2026-04-04T07:59:00+11:00",
      days: [
        "2026-04-04T08:00:10+11:00",
        "2026-04-05T08:00:10+10:00",
        "2026-04-06T08:00:10+10:00",
      ],
      next: "2026-04-07T08:00:00+10:00",
      label: "2026-04-05 回拨",
    },
    {
      start: "2026-10-03T07:59:00+10:00",
      days: [
        "2026-10-03T08:00:10+10:00",
        "2026-10-04T08:00:10+11:00",
        "2026-10-05T08:00:10+11:00",
      ],
      next: "2026-10-06T08:00:00+11:00",
      label: "2026-10-04 前拨",
    },
  ];
  for (const c of dstCases) {
    const dst = makeEnv();
    const s = await api.createSchedule(
      dst.e,
      { ...INPUT, source_msg_id: "dst-" + c.start },
      at(c.start),
    );
    for (const day of c.days) {
      await api.runSchedules(dst.e, at(day));
      await api.runSchedules(dst.e, at(day) + 60000);
    }
    assert.equal(count(dst.db, "SELECT COUNT(*) n FROM outbox"), c.days.length);
    assert.equal(
      count(dst.db, "SELECT COUNT(*) n FROM schedule_runs WHERE status='skipped'"),
      0,
    );
    assert.equal(
      row(dst.db, "SELECT next_run_at FROM schedules WHERE id=?", s.id).next_run_at,
      at(c.next),
    );
    console.log(
      `${c.label} | 3 天各 1 条、无重复无漏发 | next ${api.sydneyText(row(dst.db, "SELECT next_run_at FROM schedules WHERE id=?", s.id).next_run_at)}`,
    );
    dst.db.close();
  }

  assert.equal(networkCalls, 0);
  console.log(
    `QQ 真实发送 0 次、线上 D1 写入 0 行、真实网络请求 0 次；离线模型调用 ${modelCalls} 次（仅两个真实日报日）`,
  );
} finally {
  globalThis.fetch = originalFetch;
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  rmSync(temp, { recursive: true, force: true });
}
