// Offline tests for the daily backup: real SQLite (node:sqlite) behind a Durable-Object-shaped sql, a fake R2 bucket.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

const { default: feature, runBackup, retain, tables, LIMITS } = await import("../src/feat/backup.ts");

function fakeBucket() {
  const m = new Map(), ops = { put: 0, mp: 0 };
  const bytesOf = v => typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v);
  const obj = k => { const b = m.get(k); return { key: k, size: b.length, uploaded: new Date(), body: new Response(b).body, text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.buffer }; };
  return {
    m, ops,
    async put(k, v) { ops.put++; m.set(k, bytesOf(v).slice()); },
    async get(k) { return m.has(k) ? obj(k) : null; },
    async delete(ks) { for (const k of [].concat(ks)) m.delete(k); },
    async list({ prefix = "", cursor } = {}) {
      const all = [...m.keys()].filter(k => k.startsWith(prefix)).sort(), at = Number(cursor || 0), page = all.slice(at, at + 3);
      return { objects: page.map(k => ({ key: k, size: m.get(k).length, uploaded: new Date() })), truncated: at + 3 < all.length, cursor: String(at + 3) };
    },
    async createMultipartUpload(key) {
      ops.mp++; const parts = [];
      return {
        async uploadPart(n, data) { parts[n - 1] = bytesOf(data).slice(); return { partNumber: n, etag: "e" + n }; },
        async complete(ps) { const out = Buffer.concat(ps.map(p => parts[p.partNumber - 1])); m.set(key, new Uint8Array(out)); },
        async abort() {},
      };
    },
  };
}

function fakeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE msg(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, conv TEXT, text TEXT);
    CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE ledger(conv TEXT, name TEXT, balance REAL NOT NULL DEFAULT 0, PRIMARY KEY(conv, name));
    CREATE TABLE sched(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, spec TEXT);
    CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT, r2 TEXT, size INTEGER, src TEXT, made TEXT);
    CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, name TEXT, data BLOB);
  `);
  const kvs = new Map(), waits = [], used = {};
  const hub = {
    sql: { exec(q, ...b) { const st = db.prepare(q); const rows = /^\s*(SELECT|PRAGMA|WITH)/i.test(q) || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []); return { toArray: () => rows.map(r => ({ ...r })) }; } },
    env: { FILES: fakeBucket(), VERSION: { id: "v-test" } },
    ctx: { waitUntil: p => waits.push(p), storage: { transactionSync(f) { db.exec("BEGIN"); try { f(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; } } } },
    plan: { used, fits: (n, a = 0) => (used[n] || 0) + a <= (hub.cap ?? 1e9), take(n, a) { if (!this.fits(n, a)) return false; used[n] = (used[n] || 0) + a; return true; }, add(n, a) { used[n] = (used[n] || 0) + a; } },
    get: k => { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    build: () => "v-test", db, waits, kvs,
    async settle() { while (waits.length) await waits.shift(); },
  };
  return hub;
}
const lines = async (bucket, key) => gunzipSync(bucket.m.get(key)).toString().split("\n").filter(Boolean).map(l => JSON.parse(l));
const gunzipStream = async bytes => { const s = new Response(bytes).body.pipeThrough(new DecompressionStream("gzip")); return await new Response(s).text(); };
const NOON = Date.UTC(2026, 10, 15, 6, 0); // Sun 2026-11-15 14:00 Beijing
const MON = Date.UTC(2026, 10, 16, 6, 0);  // Mon 2026-11-16

function seed(hub, n = 0) {
  const d = hub.db;
  d.prepare("INSERT INTO msg(id,conv,text) VALUES(?,?,?)");
  for (let i = 0; i < n; i++) d.prepare("INSERT INTO msg(id,conv,text) VALUES(?,?,?)").run("m" + i, "g:1", "你好 " + i);
  for (const [k, v] of [["memory:g:1", "长期记忆"], ["flag:x", "1"], ["cookie:bilibili", "SECRET"], ["quota:img:2026-11-15", "3"], ["plan:2026-11-13:r2_writes", "9"], ["scratch:a", "t"], ["setting:g:1:foo", "1"]]) d.prepare("INSERT INTO kv VALUES(?,?)").run(k, v);
  d.prepare("INSERT INTO ledger VALUES('g:1','小明',12.5),('g:1','小红',-3)").run();
  d.prepare("INSERT INTO sched(conv,spec) VALUES('g:1','每天 8:00')").run();
  d.prepare("INSERT INTO img(conv,ts,mime,data,note,name) VALUES('g:1',1,'image/png',?,'角色','阿狸'),('g:1',2,'image/png',?,'表情包','sticker:笑')").run(new Uint8Array([1, 2, 3]), new Uint8Array([4, 5]));
  d.prepare("INSERT INTO img(conv,ts,mime,data,note,name,r2,size) VALUES('g:1',3,'image/png',NULL,'大图','大角色','img/9',5000000)").run();
  d.prepare("INSERT INTO img(conv,ts,mime,data,note) VALUES('g:1',4,'image/png',?,'群友发的图')").run(new Uint8Array([9]));
  d.prepare("INSERT INTO blob(conv,name,data) VALUES('g:1','a.txt',?)").run(new Uint8Array([7]));
}

describe("backup", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); seed(hub, 5); LIMITS.page = 2000; LIMITS.part = 5 * 1024 * 1024; LIMITS.mediaRaw = 60 * 1024 * 1024; });

  test("core round trip: counts match the manifest, binary columns and secrets are left out", async () => {
    const m = await runBackup(hub, MON);
    const b = hub.env.FILES;
    const rows = await lines(b, "backup/2026-11-16/core.jsonl.gz");
    const per = {};
    for (const r of rows) per[r.t] = (per[r.t] || 0) + 1;
    assert.deepEqual(per, m.tables);
    assert.equal(m.tables.msg, 5);
    assert.equal(m.tables.img, 4);
    assert.equal(m.tables.blob, 1);
    assert.deepEqual(m.omitted_binary_columns, { img: ["data"], blob: ["data"] });
    assert.ok(rows.filter(r => r.t === "img").every(r => !("data" in r.r)));
    const text = Buffer.from(b.m.get("backup/2026-11-16/core.jsonl.gz")).length;
    assert.equal(m.files.core.bytes, text);
    assert.equal(await gunzipStream(b.m.get("backup/2026-11-16/core.jsonl.gz")).then(s => s.split("\n").filter(Boolean).length), rows.length);
    const man = JSON.parse(new TextDecoder().decode(b.m.get("backup/2026-11-16/manifest.json")));
    assert.equal(man.version, "v-test");
    assert.equal(man.total_backup_bytes, Number(hub.get("backup:bytes")));
    assert.ok(!("media" in man.files), "Monday has no media file");
  });

  test("cookie, quota, plan, scratch keys are not copied", async () => {
    const m = await runBackup(hub, MON);
    const keys = (await lines(hub.env.FILES, "backup/2026-11-16/core.jsonl.gz")).filter(r => r.t === "kv").map(r => r.r.k);
    assert.ok(keys.includes("memory:g:1") && keys.includes("setting:g:1:foo"));
    for (const k of keys) assert.ok(!/^(cookie|quota|plan|scratch):/.test(k), k);
    assert.equal(m.skipped.kv_keys["cookie:*"], 1);
    assert.ok(!new TextDecoder().decode(hub.env.FILES.m.get("backup/2026-11-16/manifest.json")).includes("SECRET"));
  });

  test("paging: more rows than one page, nothing lost or doubled", async () => {
    for (let i = 5; i < 23; i++) hub.db.prepare("INSERT INTO msg(id,conv,text) VALUES(?,?,?)").run("m" + i, "g:1", "x" + i);
    LIMITS.page = 4;
    const m = await runBackup(hub, MON);
    const ids = (await lines(hub.env.FILES, "backup/2026-11-16/core.jsonl.gz")).filter(r => r.t === "msg").map(r => r.r.seq);
    assert.equal(m.tables.msg, 23);
    assert.deepEqual(ids, Array.from({ length: 23 }, (_, i) => i + 1));
  });

  test("large output goes through multipart and still decompresses", async () => {
    // incompressible text so the gzip is bigger than a part
    const rnd = () => Buffer.from(Array.from({ length: 6000 }, () => Math.floor(Math.random() * 256))).toString("base64");
    for (let i = 0; i < 400; i++) hub.db.prepare("INSERT INTO msg(id,conv,text) VALUES(?,?,?)").run("big" + i, "g:1", rnd());
    LIMITS.part = 256 * 1024; LIMITS.chunk = 64 * 1024;
    const m = await runBackup(hub, MON);
    assert.ok(hub.env.FILES.ops.mp >= 1, "multipart used");
    assert.ok(m.files.core.bytes > 2 * LIMITS.part);
    assert.equal((await lines(hub.env.FILES, "backup/2026-11-16/core.jsonl.gz")).filter(r => r.t === "msg").length, 405);
    LIMITS.chunk = 256 * 1024;
  });

  test("Sunday adds media: named inline pictures only, base64, r2 rows reported not copied", async () => {
    const m = await runBackup(hub, NOON);
    const rows = await lines(hub.env.FILES, "backup/2026-11-15/media.jsonl.gz");
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map(r => r.r.name), ["阿狸", "sticker:笑"]);
    assert.deepEqual([...Buffer.from(rows[0].data, "base64")], [1, 2, 3]);
    assert.equal(m.files.media.pictures, 2);
    assert.equal(m.media_skipped.already_in_r2, 1);
  });

  test("media cap skips what does not fit and says so", async () => {
    LIMITS.mediaRaw = 4;
    const m = await runBackup(hub, NOON);
    assert.equal(m.files.media.pictures, 1);
    assert.deepEqual(m.media_skipped.over_size_cap.map(x => x.name), ["sticker:笑"]);
  });

  test("retention keeps the newest 30 days plus the first backup of each of the last 12 months", () => {
    const dates = [];
    for (let d = new Date(Date.UTC(2025, 0, 5)); d <= new Date(Date.UTC(2026, 10, 15)); d = new Date(+d + 86400000)) dates.push(d.toISOString().slice(0, 10));
    const { keep, drop } = retain(dates, "2026-11-15");
    const daily = dates.slice(-30);
    for (const d of daily) assert.ok(keep.includes(d));
    // first of each month Dec 2025 .. Nov 2026 (12 months); Jan 5 2025 was the first of its month but is older than 12 months
    const monthly = ["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01", "2026-10-01", "2026-11-01"];
    for (const d of monthly) assert.ok(keep.includes(d), d);
    assert.equal(keep.length, new Set([...daily, ...monthly]).size);
    assert.ok(drop.includes("2025-11-01") && drop.includes("2025-01-05") && drop.includes("2026-11-01") === false);
    assert.ok(drop.includes("2026-10-15") && drop.includes("2026-02-14"));
  });

  test("retention deletes old backups in R2 and keeps a month's first", async () => {
    const days = [];
    for (let d = new Date(Date.UTC(2026, 8, 1)); d <= new Date(Date.UTC(2026, 9, 5)); d = new Date(+d + 86400000)) days.push(d.toISOString().slice(0, 10));
    for (const d of days) for (const f of ["core.jsonl.gz", "manifest.json"]) hub.env.FILES.m.set(`backup/${d}/${f}`, new Uint8Array(10));
    const m = await runBackup(hub, MON);
    const dirs = [...new Set([...hub.env.FILES.m.keys()].map(k => k.split("/")[1]))].sort();
    assert.equal(days.length, 35);
    assert.deepEqual(m.retention.deleted_dates, ["2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05", "2026-09-06"]);
    assert.equal(dirs.length, 36 - 5);
    assert.ok(dirs.includes("2026-09-01") && !dirs.includes("2026-09-02") && dirs.includes("2026-09-07") && dirs.includes("2026-11-16"));
  });

  test("daily mark: one run per Beijing day, only after 03:10", async () => {
    const early = Date.UTC(2026, 10, 15, 18, 55);  // 02:55 Beijing on the 16th
    await feature.tick(hub, early); await hub.settle();
    assert.equal(hub.env.FILES.m.size, 0, "before 03:10 nothing runs");
    const t1 = Date.UTC(2026, 10, 15, 19, 11);       // 03:11 Beijing on the 16th
    await feature.tick(hub, t1); await hub.settle();
    const n = hub.env.FILES.m.size;
    assert.ok(n >= 2);
    assert.equal(hub.get("backup:day"), "2026-11-16");
    const puts = hub.env.FILES.ops.put;
    await feature.tick(hub, t1 + 20000); await feature.tick(hub, t1 + 3600000); await hub.settle();
    assert.equal(hub.env.FILES.ops.put, puts, "no second run the same day");
    await feature.tick(hub, t1 + 86400000); await hub.settle();
    assert.ok(hub.env.FILES.ops.put > puts, "next day runs again");
    assert.ok(JSON.parse(hub.get("backup:last")).ok);
  });

  test("allowance gone: refuses politely, writes nothing, waits for tomorrow", async () => {
    hub.cap = 3; hub.plan.used.r2_writes = 3;
    const t1 = Date.UTC(2026, 10, 15, 19, 11);
    await feature.tick(hub, t1); await hub.settle();
    assert.equal(hub.env.FILES.m.size, 0);
    assert.equal(hub.get("backup:day"), "2026-11-16");
    const last = JSON.parse(hub.get("backup:last"));
    assert.equal(last.ok, false); assert.match(last.error, /额度/);
  });

  test("other failures retry later, at most three times a day", async () => {
    hub.env.FILES.put = async () => { throw new Error("boom"); };
    let t = Date.UTC(2026, 10, 15, 19, 11);
    for (let i = 0; i < 5; i++) { await feature.tick(hub, t); await hub.settle(); t += 31 * 60000; }
    assert.equal(hub.get("backup:tries"), "2026-11-16|3");
    assert.equal(hub.get("backup:day"), "2026-11-16");
  });

  test("restore dry run reports counts and writes nothing", async () => {
    await runBackup(hub, NOON);
    hub.db.exec("DELETE FROM ledger; INSERT INTO ledger VALUES('g:1','小明',99)");
    const before = hub.db.prepare("SELECT * FROM ledger").all();
    const r = await feature.admin(hub, { method: "POST" }, new URL("http://x/admin/backup"), { restore: "2026-11-15", tables: ["ledger"], dry: true });
    const j = await r.json();
    assert.equal(j.ok, true);
    assert.deepEqual(j.result.ledger, { current_rows: 1, backup_rows: 2 });
    assert.deepEqual(hub.db.prepare("SELECT * FROM ledger").all(), before);
    assert.equal(tables(hub).some(t => t.name.startsWith("_bk_")), false);
  });

  test("restore replaces only the named tables and needs confirm", async () => {
    await runBackup(hub, NOON);
    hub.db.exec("UPDATE ledger SET balance=0; DELETE FROM sched; INSERT INTO msg(id,conv,text) VALUES('late','g:1','后来的消息')");
    const call = async body => feature.admin(hub, { method: "POST" }, new URL("http://x/admin/backup"), body);
    let r = await call({ restore: "2026-11-15", tables: ["ledger", "sched"], confirm: "2026-11-14" });
    assert.equal(r.status, 400);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM sched").get().n, 0, "unconfirmed restore changes nothing");
    r = await call({ restore: "2026-11-15", tables: ["ledger", "sched"], confirm: "2026-11-15" });
    const j = await r.json();
    assert.equal(r.status, 200, JSON.stringify(j));
    assert.deepEqual(hub.db.prepare("SELECT balance FROM ledger ORDER BY name").all().map(x => x.balance), [12.5, -3]);
    assert.equal(hub.db.prepare("SELECT spec FROM sched").get().spec, "每天 8:00");
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM msg WHERE id='late'").get().n, 1, "msg was not named, so not touched");
    assert.equal(tables(hub).some(t => t.name.startsWith("_bk_")), false);
  });

  test("restoring kv keeps cookies, quota and the backup's own marks", async () => {
    await runBackup(hub, NOON);
    hub.db.exec("UPDATE kv SET v='坏了' WHERE k='memory:g:1'; DELETE FROM kv WHERE k='flag:x'; INSERT INTO kv VALUES('cookie:new','C2')");
    const r = await feature.admin(hub, { method: "POST" }, new URL("http://x/admin/backup"), { restore: "2026-11-15", tables: ["kv"], confirm: "2026-11-15" });
    assert.equal(r.status, 200);
    assert.equal(hub.get("memory:g:1"), "长期记忆");
    assert.equal(hub.get("flag:x"), "1");
    assert.equal(hub.get("cookie:new"), "C2");
    assert.equal(hub.get("cookie:bilibili"), "SECRET");
    assert.ok(hub.get("backup:bytes"));
  });

  test("tables with picture bytes are refused (would wipe them); media restore brings pictures back", async () => {
    await runBackup(hub, NOON);
    const call = async body => feature.admin(hub, { method: "POST" }, new URL("http://x/admin/backup"), body);
    let r = await call({ restore: "2026-11-15", tables: ["img", "ledger"], confirm: "2026-11-15" });
    assert.equal(r.status, 400);
    assert.match((await r.json()).refused.img, /media/);
    hub.db.exec("DELETE FROM img WHERE name IS NOT NULL AND r2 IS NULL");
    r = await call({ restore: "2026-11-15", tables: ["media"], confirm: "2026-11-15" });
    const j = await r.json();
    assert.equal(j.result.media.restored, 2);
    assert.deepEqual([...hub.db.prepare("SELECT data FROM img WHERE name='阿狸'").get().data], [1, 2, 3]);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM img").get().n, 4, "unnamed picture untouched");
  });

  test("admin: list, run, and the chat tool", async () => {
    const run = await feature.admin(hub, { method: "POST" }, new URL("http://x/admin/backup"), { run: true });
    const m = await run.json();
    assert.equal(m.tables.msg, 5);
    const l = await (await feature.admin(hub, { method: "GET" }, new URL("http://x/admin/backup"), null)).json();
    assert.equal(l.backups.length, 1);
    assert.equal(l.last.ok, true);
    assert.equal(await feature.admin(hub, { method: "GET" }, new URL("http://x/admin/other"), null), null);
    const tool = feature.tools({ hub }).find(t => t.name === "backups");
    const out = await tool.run({ op: "list" });
    assert.equal(out.ok, true);
    assert.equal(out.count, 1);
    assert.equal(out.last_run.结果, "成功");
  });
});
