#!/usr/bin/env node
/**
 * Verify the V-D replay seed against the read-only export and the golden set.
 *
 * Usage:
 *   node scripts/review-verify.mjs --db <local.sqlite> \
 *     --golden <golden.jsonl> --negatives <negatives.jsonl> \
 *     --export <export dir> --sim-nights <sim-nights.json>
 *
 * Read-only: opens SQLite with { readOnly: true } and never writes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function jsonl(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}
function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}
function one(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

const dbPath = resolve(arg("db"));
const goldenPath = resolve(arg("golden"));
const negativesPath = resolve(arg("negatives"));
const exportDir = resolve(arg("export"));
const nightsPath = resolve(arg("sim-nights"));
const maxRowid = Number(arg("max-rowid", "0")) || 0;
const failures = [];
const lines = [];

if (!existsSync(dbPath)) throw new Error(`missing database: ${dbPath}`);
const db = new DatabaseSync(dbPath, { readOnly: true });

const counts = {
  messages: one(db, "SELECT COUNT(*) AS n FROM messages").n,
  outbox: one(db, "SELECT COUNT(*) AS n FROM outbox").n,
  chat_decisions: one(db, "SELECT COUNT(*) AS n FROM chat_decisions").n,
};
lines.push(
  `counts messages=${counts.messages} outbox=${counts.outbox} chat_decisions=${counts.chat_decisions}`,
);

// 1. Golden + negatives rowids must resolve to non-empty source rows.
const golden = jsonl(goldenPath);
const negatives = jsonl(negativesPath);
lines.push(`golden=${golden.length} negatives=${negatives.length}`);
for (const item of golden) {
  const missing = [];
  for (const rowid of item.inbound_rowids) {
    // Empty body is legitimate for a bare @ (messages 432); the id is the原文 key.
    const row = one(db, "SELECT id FROM messages WHERE rowid = ?", [rowid]);
    if (!row || !row.id) missing.push(`messages:${rowid}`);
  }
  for (const rowid of item.outbox_rowids) {
    const row = one(db, "SELECT id, body FROM outbox WHERE rowid = ?", [rowid]);
    if (!row || !row.body) missing.push(`outbox:${rowid}`);
  }
  const ok = missing.length === 0;
  if (!ok) failures.push(`case ${item.case}: missing ${missing.join(", ")}`);
  lines.push(`case ${String(item.case).padStart(2)} ${ok ? "PASS" : "FAIL"} in=${item.inbound_rowids.join(",")} out=${item.outbox_rowids.join(",")}`);
}
for (const item of negatives) {
  const missing = [];
  for (const rowid of item.inbound_rowids || []) {
    if (!one(db, "SELECT 1 AS x FROM messages WHERE rowid = ?", [rowid])) missing.push(`messages:${rowid}`);
  }
  for (const rowid of item.outbox_rowids || []) {
    if (!one(db, "SELECT 1 AS x FROM outbox WHERE rowid = ?", [rowid])) missing.push(`outbox:${rowid}`);
  }
  if (item.outbox_rowid && !one(db, "SELECT 1 AS x FROM outbox WHERE rowid = ?", [item.outbox_rowid])) {
    missing.push(`outbox:${item.outbox_rowid}`);
  }
  const ok = missing.length === 0;
  if (!ok) failures.push(`${item.case}: missing ${missing.join(", ")}`);
  lines.push(`${item.case} ${ok ? "PASS" : "FAIL"}`);
}

// 2. Export audit: no writes, counts agree, no credential markers.
if (existsSync(exportDir)) {
  const log = readFileSync(join(exportDir, "export.log"), "utf8");
  if (log.split("\n")[0].trim() !== "线上 D1 写入 0 行") failures.push("export.log first line is wrong");
  const writeLines = log.split("\n").filter((line) => line.includes("rows_written="));
  for (const line of writeLines) {
    if (!line.includes("rows_written=0")) failures.push(`export wrote rows: ${line}`);
  }
  const online = JSON.parse(readFileSync(join(exportDir, "online-counts.json"), "utf8"));
  let expected = online;
  if (maxRowid) {
    const messages = JSON.parse(readFileSync(join(exportDir, "messages.json"), "utf8"));
    const decisions = JSON.parse(readFileSync(join(exportDir, "chat_decisions.json"), "utf8"));
    const kept = messages.filter((row) => Number(row.rid) <= maxRowid);
    const cutoff = Math.max(...kept.map((row) => Date.parse(row.ts)));
    expected = {
      messages: kept.length,
      outbox: online.outbox,
      chat_decisions: decisions.filter((row) => Number(row.created_at) <= cutoff).length,
    };
    lines.push(
      `snapshot rowid<=${maxRowid} expected=${expected.messages}/${expected.outbox}/${expected.chat_decisions} ` +
        `onlineNow=${online.messages}/${online.outbox}/${online.chat_decisions}`,
    );
  }
  for (const key of ["messages", "outbox", "chat_decisions"]) {
    if (counts[key] !== expected[key]) failures.push(`count mismatch ${key}: local ${counts[key]} expected ${expected[key]}`);
  }
  const pattern = /sk-|ghp_|Bearer|token=|cookie/;
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (pattern.test(readFileSync(path, "utf8"))) hits.push(path);
    }
  };
  walk(exportDir);
  if (hits.length) failures.push(`secret-pattern hits: ${hits.join(", ")}`);
  lines.push(
    `export writes=${writeLines.every((line) => line.includes("rows_written=0")) ? 0 : "NONZERO"} ` +
      `counts=${online.messages}/${online.outbox}/${online.chat_decisions} secretHits=${hits.length}`,
  );
}

// 3. Simulated clock must have three 05:00 Sydney nights.
if (existsSync(nightsPath)) {
  const sim = JSON.parse(readFileSync(nightsPath, "utf8"));
  if (sim.timezone !== "Australia/Sydney") failures.push("sim-nights timezone");
  if (sim.nights.length !== 3) failures.push("sim-nights count");
  for (const night of sim.nights) {
    if (!night.at.endsWith("T05:00:00+11:00")) failures.push(`sim-nights clock ${night.at}`);
  }
  lines.push(`sim-nights ${sim.nights.map((night) => night.at).join(" | ")}`);
}

// 4. The explicit rowid from the order must exist even if production grew.
const row437 = one(db, "SELECT rowid FROM messages WHERE rowid = 437");
lines.push(`rowid437=${row437 ? "present" : "MISSING"} rowid243=${one(db, "SELECT 1 AS x FROM outbox WHERE rowid = 243") ? "present" : "MISSING"}`);
if (!row437) failures.push("messages rowid 437 missing");
if (!one(db, "SELECT 1 AS x FROM outbox WHERE rowid = 243")) failures.push("outbox rowid 243 missing");

db.close();
for (const line of lines) console.log(line);
if (failures.length) {
  for (const failure of failures) console.error("FAIL", failure);
  console.log(`VERIFY FAILED (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log("VERIFY OK");
}
