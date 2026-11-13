#!/usr/bin/env node
/**
 * Seed an isolated local D1 database from a review-export directory.
 *
 * Everything happens under --persist (a throwaway directory owned by the
 * caller). The script never talks to Cloudflare and never touches the
 * repository database.
 *
 * Usage:
 *   node scripts/review-seed.mjs --export "$TMPDIR/teamagent-review-export-..." \
 *     --persist "$TMPDIR/teamagent-review-seed-..."
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const DB_NAME = "inkboard-team";
// Parent-first order so migrations that read other tables see the data.
const TABLES = [
  "members",
  "settings",
  "messages",
  "message_meta",
  "outbox",
  "outbox_meta",
  "chat_decisions",
  "jobs",
  "stage_timings",
  "health_samples",
  "deliveries",
  "facts",
  "tasks",
  "dreams",
  "model_runs",
  "repo_state",
  "repo_cache",
];
const NO_ROWID = new Set([]);

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const exportDir = resolve(arg("export"));
const persist = resolve(arg("persist"));
const keepSql = process.argv.includes("--keep-sql");
const maxRowid = Number(arg("max-rowid", "0")) || 0;

if (!existsSync(join(exportDir, "messages.json"))) {
  throw new Error(`missing export directory: ${exportDir}`);
}
if (existsSync(join(persist, "v3"))) {
  throw new Error(`refusing to reuse non-empty D1 state: ${persist}`);
}
mkdirSync(persist, { recursive: true, mode: 0o700 });
const sqlDir = join(persist, ".seed-sql");
mkdirSync(sqlDir, { mode: 0o700 });
const logDir = join(persist, ".wrangler-logs");
mkdirSync(logDir, { mode: 0o700 });

function wranglerFile(file, label) {
  try {
    const output = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        DB_NAME,
        "--local",
        "--persist-to",
        persist,
        "--file",
        file,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, WRANGLER_LOG_PATH: logDir, WRANGLER_SEND_METRICS: "false" } },
    );
    process.stdout.write(`  ${label}: ${output.split("\n").filter(Boolean).slice(-3).join(" | ")}\n`);
  } catch (error) {
    process.stderr.write(`  ${label}: FAILED\n${error.stderr || error.message}\n`);
    throw error;
  }
}

function quote(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return "'" + String(value).replaceAll("'", "''") + "'";
}

function insertSql(table, rows) {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const hasRowid = Object.hasOwn(rows[0], "rid") && !NO_ROWID.has(table);
  const allColumns = hasRowid ? ["rowid", ...columns.filter((c) => c !== "rid")] : columns;
  const statements = rows.map((row) => {
    const values = allColumns.map((column) =>
      column === "rowid" ? String(row.rid) : quote(row[column]),
    );
    return `INSERT OR REPLACE INTO ${table}(${allColumns.join(",")}) VALUES(${values.join(",")});`;
  });
  return statements.join("\n") + "\n";
}

// 1. Schema + migrations, all local.
console.log("apply schema");
wranglerFile(resolve("schema.sql"), "schema.sql");
for (const name of readdirSync(resolve("migrations")).filter((n) => n.endsWith(".sql")).sort()) {
  wranglerFile(resolve("migrations", name), name);
}

// 2. Data, preserving rowids.
let report = {};
let keptMessageIds = null;
let cutoffMs = 0;
for (const table of TABLES) {
  const path = join(exportDir, `${table}.json`);
  if (!existsSync(path)) {
    console.log(`${table}: no export, skipped`);
    continue;
  }
  let rows = JSON.parse(readFileSync(path, "utf8"));
  if (table === "members") {
    // token_hash is deliberately absent from the export; local fixture value only.
    rows = rows.map((row) => ({ ...row, token_hash: `local-fixture-${row.id}` }));
  }
  if (table === "repo_cache") {
    // D-1 exports only repo + updated_at; schema still requires a JSON blob.
    rows = rows.map((row) => ({ ...row, json: "{}" }));
  }
  if (maxRowid && table === "messages") {
    rows = rows.filter((row) => Number(row.rid) <= maxRowid);
    keptMessageIds = new Set(rows.map((row) => row.id));
    cutoffMs = Math.max(...rows.map((row) => Date.parse(row.ts)));
    console.log(`snapshot: messages rowid <= ${maxRowid}, decision cutoff ${new Date(cutoffMs).toISOString()}`);
  }
  if (maxRowid && table === "message_meta" && keptMessageIds) {
    rows = rows.filter((row) => keptMessageIds.has(row.id));
  }
  if (maxRowid && table === "chat_decisions") {
    rows = rows.filter((row) => Number(row.created_at) <= cutoffMs);
  }
  if (!rows.length) {
    console.log(`${table}: 0 rows`);
    report[table] = 0;
    continue;
  }
  // Parent rows first inside a table is unnecessary; rowid inserts are explicit.
  const file = join(sqlDir, `${table}.sql`);
  writeFileSync(file, insertSql(table, rows), { mode: 0o600 });
  console.log(`${table}: ${rows.length} rows`);
  wranglerFile(file, table);
  report[table] = rows.length;
}

// 3. Verify against the actual local SQLite file.
const sqliteFiles = readdirSync(persist, { recursive: true })
  .filter((name) => String(name).includes("miniflare-D1DatabaseObject"))
  .filter((name) => String(name).endsWith(".sqlite") && !String(name).endsWith("metadata.sqlite"))
  .map((name) => join(persist, String(name)));
if (sqliteFiles.length !== 1) {
  throw new Error(`expected one local D1 file, found ${sqliteFiles.length}: ${sqliteFiles.join(", ")}`);
}
const database = new DatabaseSync(sqliteFiles[0], { readOnly: true });
const counts = {};
for (const [table, sql] of Object.entries({
  messages: "SELECT COUNT(*) AS n FROM messages",
  outbox: "SELECT COUNT(*) AS n FROM outbox",
  chat_decisions: "SELECT COUNT(*) AS n FROM chat_decisions",
  jobs: "SELECT COUNT(*) AS n FROM jobs",
  stage_timings: "SELECT COUNT(*) AS n FROM stage_timings",
  health_samples: "SELECT COUNT(*) AS n FROM health_samples",
})) {
  counts[table] = database.prepare(sql).get().n;
}
database.close();
const verdict =
  counts.messages === report.messages &&
  counts.outbox === report.outbox &&
  counts.chat_decisions === report.chat_decisions;
const result = { persist, sqlite: sqliteFiles[0], maxRowid, exported: report, counts, local: verdict };
writeFileSync(join(persist, "seed-report.json"), JSON.stringify(result, null, 2));
console.log("COUNTS", JSON.stringify(counts));
console.log("SQLITE", sqliteFiles[0]);
console.log(verdict ? "SEED OK" : "SEED MISMATCH");
if (!keepSql) rmSync(sqlDir, { recursive: true, force: true });
if (!verdict) process.exitCode = 1;
