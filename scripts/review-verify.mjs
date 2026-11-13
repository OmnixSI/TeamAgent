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
import { dirname, join, resolve } from "node:path";
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
const standalonePath = resolve(arg("standalone", join(dirname(goldenPath), "standalone-outbox.jsonl")));
const provenancePath = resolve(arg("provenance", join(dirname(goldenPath), "provenance.jsonl")));
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

// 1b. v2 golden schema: expect_kind / root-cause keys / disputed labels / #13 rule.
const kinds = new Set(["response_fault", "capability_gap", "system_fault", "none"]);
const numbered = golden.filter((item) => typeof item.case === "number");
const m4 = golden.find((item) => item.case === "M4");
if (numbered.length !== 20) failures.push(`golden numbered cases=${numbered.length}, expected 20`);
if (!m4) failures.push("golden M4 missing");
for (const item of golden) {
  if (!kinds.has(item.expect_kind)) failures.push(`case ${item.case}: bad expect_kind`);
  if (!Array.isArray(item.expect_root_cause_keys) || !item.expect_root_cause_keys.length) {
    failures.push(`case ${item.case}: empty expect_root_cause_keys`);
  }
  if (typeof item.disputed_label !== "boolean") failures.push(`case ${item.case}: disputed_label not bool`);
}
const g13 = golden.find((item) => item.case === 13);
if (!g13?.expect_rule || g13.expect_rule.kind !== "burst_max" || g13.expect_rule.params?.max !== 1) {
  failures.push("#13 expect_rule is not burst_max max=1");
}
if (m4 && !m4.expect_points.some((point) => String(point).includes("149") && String(point).includes("不得"))) {
  failures.push("M4 does not state 149 must not be penalized");
}
lines.push(
  `golden v2 records=${golden.length} numbered=${numbered.length} disputed=${golden.filter((item) => item.disputed_label).length} m4=${m4 ? "present" : "MISSING"} g13=burst_max/1`,
);

// 1c. Standalone outbox list: every row must be msg_id NULL in the seed.
if (!existsSync(standalonePath)) {
  failures.push(`missing ${standalonePath}`);
} else {
  const standalone = jsonl(standalonePath);
  if (standalone.length !== 24) failures.push(`standalone=${standalone.length}, expected 24`);
  if (!standalone.some((row) => row.rid === 233 && row.msg_id === null)) failures.push("standalone rid 233 missing");
  for (const row of standalone) {
    const source = one(db, "SELECT msg_id, created_at FROM outbox WHERE rowid = ?", [row.rid]);
    if (!source) failures.push(`standalone outbox ${row.rid} missing from seed`);
    else if (source.msg_id !== null) failures.push(`standalone outbox ${row.rid} has msg_id`);
    else if (Number(source.created_at) !== Number(row.created_at)) {
      failures.push(`standalone outbox ${row.rid} created_at mismatch`);
    }
  }
  lines.push(`standalone=${standalone.length} rid233=${standalone.some((row) => row.rid === 233) ? "present" : "MISSING"}`);
}

// 1d. Provenance fixture: five blocked origins plus one bound-direct control.
if (!existsSync(provenancePath)) {
  failures.push(`missing ${provenancePath}`);
} else {
  const provenance = jsonl(provenancePath);
  const categories = new Set(provenance.map((row) => row.category));
  for (const wanted of ["quoted", "card", "image_text", "unbound", "revoked"]) {
    if (!categories.has(wanted)) failures.push(`provenance category ${wanted} missing`);
  }
  const blocked = provenance.filter((row) => row.category !== "control");
  for (const row of blocked) {
    if (row.expected?.requirement_candidates !== 0 || row.expected?.memory_candidates !== 0) {
      failures.push(`provenance ${row.case}: expected no candidates`);
    }
  }
  const control = provenance.find((row) => row.category === "control");
  if (!control || control.expected?.requirement_candidates !== 1) failures.push("provenance control missing or not 1 candidate");
  for (const row of provenance.filter((item) => item.input?.message?.rowid)) {
    const source = one(db, "SELECT id FROM messages WHERE rowid = ?", [row.input.message.rowid]);
    if (!source) failures.push(`provenance ${row.case}: message rowid missing`);
  }
  lines.push(`provenance=${provenance.length} categories=${[...categories].sort().join(",")} control=${control ? "ok" : "MISSING"}`);
}

// 1e. v2 seed tables must be present and match the export.
const extraTables = [
  ["outbox_meta", "outbox_meta"],
  ["image_notes", "image_notes"],
  ["message_images", "message_images"],
];
for (const [table, file] of extraTables) {
  const exportPath = join(exportDir, `${file}.json`);
  if (!existsSync(exportPath)) continue;
  const exported = JSON.parse(readFileSync(exportPath, "utf8")).length;
  let local = null;
  try {
    local = one(db, `SELECT COUNT(*) AS n FROM ${table}`).n;
  } catch {
    failures.push(`seed table ${table} missing`);
    continue;
  }
  if (local !== exported) failures.push(`seed ${table}=${local}, export=${exported}`);
  lines.push(`seed ${table}=${local}/${exported}`);
}
const memberRows = JSON.parse(readFileSync(join(exportDir, "members.json"), "utf8"));
const revoked = memberRows.filter((row) => Number(row.revoked) === 1).length;
if (one(db, "SELECT COUNT(*) AS n FROM members WHERE revoked=1").n !== revoked) failures.push("member revoked mismatch");
lines.push(`members revoked=${revoked}`);

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
