// D0：0090 迁移 / schedules 原子重建 / STORED 生成列 / AUDITED 审计白名单。
// 全部用本地内存 SQLite 模拟 D1，不连线上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { MIGRATIONS, migrateAll } from "../scripts/migrate.mjs";
import { ensureSchedulesV2 } from "../scripts/migrate-schedules.mjs";

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");

/** 模拟 wrangler d1 execute：SELECT/PRAGMA 返回 results，其余按一个原子批次执行并回滚。 */
function sqliteExecute(db) {
  return (sql) => {
    const text = String(sql);
    if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)) {
      return [{ success: true, results: db.prepare(text).all() }];
    }
    try {
      db.exec("BEGIN");
      db.exec(text);
      db.exec("COMMIT");
      return [{ success: true, results: [] }];
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch {}
      throw err;
    }
  };
}

const OLD_SCHEDULES = `CREATE TABLE schedules(
  id TEXT PRIMARY KEY, group_id TEXT NOT NULL, owner TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('digest_daily','digest_weekly','reminder','mute')),
  tz TEXT NOT NULL DEFAULT 'Australia/Sydney', spec TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','cancelled')),
  next_run_at INTEGER, last_run_at INTEGER, fail_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX schedules_due ON schedules(status,next_run_at);
CREATE INDEX schedules_group ON schedules(group_id,status);`;

const SCHEDULE_ROWS = [
  ["s1", "g1", "o1", "digest_daily", "Australia/Sydney", "{}", "active", 100, 10, 0, null, "m1", 1],
  ["s2", "g1", "o2", "reminder", "Australia/Sydney", '{"text":"hi"}', "done", 200, 20, 1, "boom", "m2", 2],
  ["s3", "g2", "o3", "mute", "Australia/Sydney", "{}", "active", 300, 30, 0, null, "m3", 3],
];

function oldSchedulesDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(OLD_SCHEDULES);
  const insert = db.prepare(
    "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const row of SCHEDULE_ROWS) insert.run(...row);
  return db;
}

const columns = (db, table) => db.prepare(`PRAGMA table_xinfo(${table})`).all().map((c) => c.name);

test("① 空库跑两遍整套迁移无错，0090 与 v2 schedules 都幂等", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const execute = sqliteExecute(db);
    migrateAll(execute);
    migrateAll(execute);

    for (const table of ["record_types", "records", "record_events", "skills", "pending_actions"]) {
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table), table);
    }
    assert.ok(MIGRATIONS.includes("migrations/0090_records.sql"));
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schedules_v2'").get(), undefined);
    assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name='schedules'").get().sql, /agent_task/);

    db.prepare(
      "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("fresh", "g", "o", "agent_task", "Australia/Sydney", "{}", "paused", null, null, 0, null, null, 1);
  } finally {
    db.close();
  }
});

test("② 旧 schedules 3 行走 ensureSchedulesV2 两遍：字段不变，可写 agent_task/paused", () => {
  const db = oldSchedulesDb();
  try {
    const execute = sqliteExecute(db);
    const before = db.prepare("SELECT * FROM schedules ORDER BY id").all();
    ensureSchedulesV2(execute);
    ensureSchedulesV2(execute);

    assert.deepEqual(db.prepare("SELECT * FROM schedules ORDER BY id").all(), before);
    assert.equal(before.length, 3);
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'").get().sql;
    assert.match(sql, /'agent_task'/);
    assert.match(sql, /'paused'/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schedules_v2'").get(), undefined);

    db.prepare(
      "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run("s4", "g1", "o4", "agent_task", "Australia/Sydney", '{"steps":[]}', "paused", null, null, 0, null, "m4", 4);
    const row = db.prepare("SELECT kind,status FROM schedules WHERE id='s4'").get();
    assert.equal(row.kind, "agent_task");
    assert.equal(row.status, "paused");
  } finally {
    db.close();
  }
});

test("②b 重建批次中途失败整批回滚，旧表与 3 行仍在", () => {
  const db = oldSchedulesDb();
  try {
    assert.throws(
      () => sqliteExecute(db)(
        "CREATE TABLE schedules_v2(id TEXT PRIMARY KEY); INSERT INTO schedules_v2(id) SELECT group_idx FROM schedules; DROP TABLE schedules;",
      ),
      /group_idx/,
    );
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='schedules_v2'").get(), undefined);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM schedules").get().n, 3);
  } finally {
    db.close();
  }
});

test("③ 0090 的 STORED 生成列：插入 data 后 person/amount_cents 可查且随 data 更新", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const sql = read("migrations/0090_records.sql");
    db.exec(sql);
    db.exec(sql);
    db.prepare(
      "INSERT INTO records(id,type_id,group_id,creator,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "r1", "t1", "g1", "s1",
      '{"person":"TOO","amount_cents":36000,"title":"x","occurred_at":1,"status":"todo"}',
      1, 1,
    );
    assert.deepEqual(
      { ...db.prepare("SELECT person,amount_cents,title,occurred_at,status FROM records WHERE id='r1'").get() },
      { person: "TOO", amount_cents: 36000, title: "x", occurred_at: 1, status: "todo" },
    );
    assert.ok(columns(db, "records").includes("amount_cents"));
    db.prepare("UPDATE records SET data=json_set(data,'$.person','BOB') WHERE id='r1'").run();
    assert.equal(db.prepare("SELECT person FROM records WHERE id='r1'").get().person, "BOB");
  } finally {
    db.close();
  }
});

test("④ AUDITED 六个新写工具会写 tool_calls，普通工具不写", async () => {
  // 用可变桩注册表证明条件分支：records_write 命中 AUDITED，records_read 不命中。
  const stub = {
    name: "audited-registry",
    setup(b) {
      b.onResolve({ filter: /^\.\/tools\/index$/ }, () => ({ path: "stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        contents: "export const EXTRA_TOOLS = (globalThis.__D0_EXTRA_TOOLS = []);",
        loader: "js",
      }));
    },
  };
  const out = await build({
    stdin: {
      contents: 'export * from "./src/toolkit";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
    plugins: [stub],
  });
  const k = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

  assert.deepEqual(
    [...k.AUDITED].sort(),
    ["records_write", "run_task", "schedule_cancel", "schedule_create", "schedule_update", "skill_save"],
  );

  const tool = (name) => ({
    name,
    def: { type: "function", function: { name, description: "", parameters: { type: "object" } } },
    untrusted: false,
    run: async () => ({ ok: true }),
  });
  globalThis.__D0_EXTRA_TOOLS.push(tool("records_write"), tool("records_read"));

  const inserts = [];
  const db = {
    prepare(sql) {
      if (sql.includes("SELECT value FROM settings")) return { bind: () => ({ first: async () => null }) };
      if (sql.includes("INSERT INTO tool_calls")) {
        return { bind: (...args) => ({ run: async () => { inserts.push(args); } }) };
      }
      throw Error("unexpected SQL: " + sql);
    },
  };
  const ctx = { context: { latest: { id: "turn1", group_id: "g1" } }, messages: [], isTainted: () => false };

  assert.deepEqual(await k.runExtraTool({ DB: db }, "records_read", { q: 1 }, ctx), { ok: true });
  assert.equal(inserts.length, 0);
  assert.deepEqual(await k.runExtraTool({ DB: db }, "records_write", { op: "add" }, ctx), { ok: true });
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0][2], "records_write");
  assert.equal(inserts[0][4], "ok");
});
