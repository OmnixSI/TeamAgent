// One stop line for the whole bucket: kept media, transfer files, sites and backups are added up, and a
// writer is refused when the sum would pass it, even if its own share is small.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../src/store.ts";
import { R2_STORAGE_STOP } from "../src/budget.ts";

function mkHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT);
    CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, data BLOB);`);
  const kv = k => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; };
  const puts = [];
  const hub = {
    sql: { exec(q, ...b) { b = b.map(x => x instanceof ArrayBuffer ? new Uint8Array(x) : x); if (b.length === 0 && /;\s*\S/.test(q)) { db.exec(q); return { toArray: () => [] }; } const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA|WITH)/i.test(q) || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    env: { FILES: { put: async (k, v) => { puts.push(k); }, get: async () => null, delete: async () => {} } },
    plan: { take: () => true, fits: () => true, add() {} },
    get: kv, set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    db, puts,
  };
  hub.store = new Store(hub);
  return hub;
}

test("the total counts media, transfer files, sites and backups; missing tables count as empty", () => {
  const hub = mkHub();
  assert.equal(hub.store.r2All(), 0);
  hub.db.exec("CREATE TABLE xfer(key TEXT PRIMARY KEY, size INTEGER, parts INTEGER, done INTEGER, at INTEGER); CREATE TABLE site(id TEXT PRIMARY KEY, bytes INTEGER)");
  hub.db.exec("INSERT INTO xfer VALUES('box/a/1', 3000, 1, 1, 1), ('computer/cache/x', 500, 1, 1, 1); INSERT INTO site VALUES('s1', 70), ('s2', 30)");
  hub.set("backup:bytes", "1000");
  hub.db.exec("INSERT INTO blob(conv, name, r2, size) VALUES('g:1', 'big.zip', 'blob/1', 20000)");
  assert.equal(hub.store.r2Bytes(), 20000);
  assert.equal(hub.store.r2All(), 20000 + 3500 + 100 + 1000);
});

test("a large file is not kept once the bucket as a whole is at the stop line", async () => {
  const hub = mkHub();
  hub.db.exec("CREATE TABLE xfer(key TEXT PRIMARY KEY, size INTEGER, parts INTEGER, done INTEGER, at INTEGER)");
  const big = new Uint8Array(2 * 1024 * 1024);   // over the in-database size, so it has to go to the bucket
  assert.ok(await hub.store.putFile("g:1", "a.bin", big), "room left: kept");
  assert.equal(hub.puts.length, 1);
  hub.db.prepare("INSERT INTO xfer VALUES('box/a/huge', ?, 1, 1, 1)").run(R2_STORAGE_STOP - 1024 * 1024);
  const before = hub.puts.length;
  await hub.store.putFile("g:1", "b.bin", big);
  assert.equal(hub.puts.length, before, "the file box already fills the bucket: nothing more is written");
});
