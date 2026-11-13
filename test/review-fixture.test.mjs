import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadReviewSubset } from "./fixtures/review/load.mjs";

const root = new URL("../", import.meta.url);

function fixtureDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("schema.sql", root), "utf8"));
  loadReviewSubset(db);
  return db;
}

test("review fixture keeps the real rowids D-3 addresses", () => {
  const db = fixtureDb();
  try {
    for (const rowid of [95, 338, 339, 428, 429, 430, 431, 432, 434, 437]) {
      const row = db.prepare("SELECT rowid, id FROM messages WHERE rowid = ?").get(rowid);
      assert.ok(row, `messages rowid ${rowid} missing`);
      assert.equal(row.id, `fx-m-${rowid}`);
    }
    for (const rowid of [145, 149, 233, 239, 241, 243]) {
      const row = db.prepare("SELECT rowid, status FROM outbox WHERE rowid = ?").get(rowid);
      assert.ok(row, `outbox rowid ${rowid} missing`);
      assert.equal(row.status, "sent");
    }
  } finally {
    db.close();
  }
});

test("review fixture carries the signals D-3 needs", () => {
  const db = fixtureDb();
  try {
    const burst = db
      .prepare(
        "SELECT rowid, sender, ts FROM messages WHERE rowid BETWEEN 93 AND 96 ORDER BY rowid",
      )
      .all();
    assert.deepEqual(
      burst.map((row) => row.rowid),
      [93, 94, 95, 96],
    );
    assert.equal(new Set(burst.map((row) => row.sender)).size, 1);
    const silent = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE rowid BETWEEN 428 AND 432 AND mentioned = 1",
      )
      .get();
    assert.equal(silent.n, 2);
    const unrelated = db
      .prepare("SELECT body FROM outbox WHERE rowid = 233")
      .get();
    assert.match(unrelated.body, /Cloudflare Queues/);
  } finally {
    db.close();
  }
});

test("review fixture contains no production credential markers", () => {
  const dir = fileURLToPath(new URL("test/fixtures/review/", root));
  const pattern = /sk-|ghp_|Bearer|token=|cookie/;
  for (const name of readdirSync(dir)) {
    if (!/\.(sql|json|mjs|md)$/.test(name)) continue;
    const text = readFileSync(new URL(`test/fixtures/review/${name}`, root), "utf8");
    assert.doesNotMatch(text, pattern, `${name} contains a credential marker`);
  }
});
