import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

// These are local-only replay artifacts (`.agent/` is not committed).  In CI the
// directory does not exist, so the checks skip instead of failing.
const replayDir = (
  process.env.V_D_REPLAY_DIR ||
  fileURLToPath(new URL("../../../.agent/releases/V-D-reflection-loop/replay/", import.meta.url))
).replace(/\/?$/, "/");
const jsonl = (name) =>
  readFileSync(new URL(name, `file://${replayDir}`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

test("v2 golden adds kind, root-cause keys, disputed labels and M4", { skip: !existsSync(replayDir) }, () => {
  const golden = jsonl("golden.jsonl");
  const numbered = golden.filter((row) => typeof row.case === "number");
  assert.equal(numbered.length, 20);
  assert.ok(golden.some((row) => row.case === "M4"), "M4 missing");
  for (const row of golden) {
    assert.ok(["response_fault", "capability_gap", "system_fault", "none"].includes(row.expect_kind));
    assert.ok(Array.isArray(row.expect_root_cause_keys) && row.expect_root_cause_keys.length > 0);
    assert.equal(typeof row.disputed_label, "boolean");
  }
  const g13 = golden.find((row) => row.case === 13);
  assert.deepEqual(g13.expect_rule, { kind: "burst_max", params: { max: 1 }, ttl_days_max: 7 });
  const m4 = golden.find((row) => row.case === "M4");
  assert.deepEqual(m4.inbound_rowids, [213, 219]);
  assert.deepEqual(m4.outbox_rowids, [145, 149]);
  assert.ok(m4.expect_points.some((point) => point.includes("149") && point.includes("不得")));
});

test("24 standalone outbox rows include rid 233 with no msg_id", { skip: !existsSync(replayDir) }, () => {
  const rows = jsonl("standalone-outbox.jsonl");
  assert.equal(rows.length, 24);
  assert.ok(rows.some((row) => row.rid === 233 && row.msg_id === null));
  assert.ok(rows.every((row) => row.msg_id === null && row.why));
});

test("provenance covers five blocked origins plus one control", { skip: !existsSync(replayDir) }, () => {
  const rows = jsonl("provenance.jsonl");
  const categories = new Set(rows.map((row) => row.category));
  for (const wanted of ["quoted", "card", "image_text", "unbound", "revoked"]) {
    assert.ok(categories.has(wanted), `${wanted} missing`);
  }
  for (const row of rows.filter((item) => item.category !== "control")) {
    assert.equal(row.expected.requirement_candidates, 0);
    assert.equal(row.expected.memory_candidates, 0);
  }
  assert.equal(rows.find((row) => row.category === "control").expected.requirement_candidates, 1);
});

const seedPath = fileURLToPath(new URL("seed-437.sqlite", `file://${replayDir}`));
test("seed carries v2 image/meta tables and clamped cursor", { skip: !existsSync(seedPath) }, () => {
  const db = new DatabaseSync(seedPath, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 437);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n, 243);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_decisions").get().n, 106);
    for (const table of ["outbox_meta", "image_notes", "message_images"]) {
      assert.doesNotThrow(() => db.prepare(`SELECT COUNT(*) FROM ${table}`).get());
    }
    assert.equal(db.prepare("SELECT value FROM settings WHERE key='chat_cursor'").get().value, "437");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM members WHERE revoked=1").get().n, 0);
  } finally {
    db.close();
  }
});
