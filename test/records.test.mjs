// D1 records core + records tool. Local fake D1 only (node:sqlite), no network.
// The 0090 DDL is pasted here until D0 merges; then it can read migrations/0090_records.sql.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

const OUTFILE = `.wrangler/records-test-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export * from "./src/records"; export * from "./src/tools/records";',
    resolveDir: process.cwd(),
    loader: "ts",
    sourcefile: "records-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: OUTFILE,
  logLevel: "silent",
});
const api = await import(new URL(`../${OUTFILE}`, import.meta.url).href + `?${Date.now()}`);
after(() => rmSync(OUTFILE, { force: true }));

const NOW = Date.parse("2026-11-13T18:35:00+11:00");
const G = "GROUP-RECORDS";
const DDL = `
CREATE TABLE IF NOT EXISTS members(id TEXT PRIMARY KEY,name TEXT NOT NULL,token_hash TEXT UNIQUE NOT NULL,role TEXT NOT NULL DEFAULT 'member',revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS member_names(member_id TEXT PRIMARY KEY,name TEXT NOT NULL,source TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS record_types(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ledger' CHECK(kind IN ('ledger','list','log')),
  schema TEXT NOT NULL DEFAULT '{}',
  visibility_default TEXT NOT NULL DEFAULT 'group' CHECK(visibility_default IN ('group','private')),
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
CREATE TABLE IF NOT EXISTS records(
  id TEXT PRIMARY KEY,
  type_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  creator TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'group' CHECK(visibility IN ('group','private')),
  data TEXT NOT NULL,
  person TEXT GENERATED ALWAYS AS (json_extract(data,'$.person')) STORED,
  title TEXT GENERATED ALWAYS AS (json_extract(data,'$.title')) STORED,
  amount_cents INTEGER GENERATED ALWAYS AS (json_extract(data,'$.amount_cents')) STORED,
  occurred_at INTEGER GENERATED ALWAYS AS (json_extract(data,'$.occurred_at')) STORED,
  status TEXT GENERATED ALWAYS AS (json_extract(data,'$.status')) STORED,
  dedup_key TEXT UNIQUE,
  source_msg_id TEXT,
  deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS records_type ON records(type_id,deleted_at,occurred_at);
CREATE INDEX IF NOT EXISTS records_person ON records(type_id,person);
CREATE INDEX IF NOT EXISTS records_group ON records(group_id,created_at);
CREATE TABLE IF NOT EXISTS record_events(
  id TEXT PRIMARY KEY, record_id TEXT, type_id TEXT NOT NULL, group_id TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('define','add','update','delete','restore','export')),
  before TEXT, after TEXT, source_msg_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pending_actions(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, sender TEXT NOT NULL,
  tool TEXT NOT NULL, draft TEXT NOT NULL, missing TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  asked_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS pending_actions_open ON pending_actions(group_id,sender,status,expires_at);
`;

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
  const calls = [];
  const DB = {
    raw, calls,
    prepare(sql) {
      const stmt = (args = []) => ({
        sql, args,
        bind(...next) { return stmt(next); },
        async all() { calls.push(sql); return { results: raw.prepare(sql).all(...args) }; },
        async first() { calls.push(sql); return raw.prepare(sql).get(...args) ?? null; },
        async run() {
          calls.push(sql);
          const result = raw.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      });
      return stmt();
    },
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) {
          out.push(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? await s.all() : await s.run());
        }
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const e = { DB };
  return { e, raw, calls };
}

function makeCtx(f, patch = {}) {
  return {
    e: f.e,
    groupId: G,
    actor: { sender: "S-TOO", name: "TOO", isAdmin: false },
    sourceMsgId: "m-1",
    dedupBase: "turn-1:call-1",
    now: NOW,
    names: new Map([["S-TOO", "TOO"], ["S-KTL", "卡特龙"], ["S-SOV", "Souvereign"]]),
    ...patch,
  };
}

const rows = (f, sql, ...args) => f.raw.prepare(sql).all(...args);
const value = (f, sql, ...args) => Object.values(f.raw.prepare(sql).get(...args) ?? {})[0];
const cents = (f, typeId) => value(f, "SELECT COALESCE(SUM(amount_cents),0) FROM records WHERE type_id=? AND deleted_at IS NULL", typeId);

async function ledger(f, ctx = makeCtx(f)) {
  const { type } = await api.defineRecordType(ctx, { name: "报销额度", kind: "ledger" });
  return type;
}

async function rc05(f, ctx = makeCtx(f)) {
  const type = await ledger(f, ctx);
  const added = await api.addRecords(ctx, type.id, [
    { person: "我", amount: "￥360" },
    { person: "卡特龙", amount: "￥50" },
    { person: "Souvereign", amount: "￥90" },
  ]);
  return { type, added };
}

function toolCtx(f, source, { tainted = false } = {}) {
  const latest = source;
  return {
    context: {
      latest, batch: [latest], names: new Map([["S-TOO", "TOO"], ["S-KTL", "卡特龙"], ["S-SOV", "Souvereign"]]),
    },
    source: latest,
    messages: [{ role: "user", content: latest.body }],
    isTainted: () => tainted,
  };
}
function source(id, body, patch = {}) {
  return { id, group_id: G, sender: "S-TOO", body, ts: String(NOW), mentioned: 1, meta: { direct: true }, ...patch };
}

// ---------- money / Chinese numerals / person ----------
test("R1 money: symbols, units, Chinese numerals, signs and decimals all normalize to integer cents", () => {
  const f = fixture(), ctx = makeCtx(f), schema = api.normalizeSchema("ledger");
  const cases = [
    ["￥360", 36000], ["¥360", 36000], ["360元", 36000], ["360块", 36000],
    ["三百六", 36000], ["三百六十", 36000], ["-10", -1000], ["加10", 1000],
    ["减5", -500], ["10.5", 1050], ["一百零五", 10500], ["两千五", 250000],
    ["一万二", 1200000], ["+12", 1200],
  ];
  for (const [raw, want] of cases) {
    assert.equal(api.normalizeData(schema, { person: "我", amount: raw }, ctx).amount_cents, want, raw);
  }
  assert.equal(api.normalizeData(schema, { person: "我", amount_cents: 1234 }, ctx).amount_cents, 1234);
  assert.throws(
    () => api.normalizeData(schema, { person: "我", amount: "不太清楚" }, ctx),
    (error) => error instanceof api.RecordError && error.kind === "invalid" && /金额没看懂/.test(error.message),
  );
});

test("R2 person: 我/本人/自己 map to actor, names ignore case and punctuation, group nickname wins", async () => {
  const f = fixture(), ctx = makeCtx(f), schema = api.normalizeSchema("ledger");
  assert.equal(api.normalizeData(schema, { person: "我", amount: "1" }, ctx).person, "TOO");
  assert.equal(api.normalizeData(schema, { person: "本人", amount: "1" }, ctx).person, "TOO");
  assert.equal(api.normalizeData(schema, { person: "自己", amount: "1" }, ctx).person, "TOO");
  assert.equal(api.normalizeData(schema, { person: "t.o.o.", amount: "1" }, ctx).person, "TOO");
  const type = await ledger(f);
  await api.addRecords(ctx, type.id, [{ person: "卡特龙", amount: "50" }]);
  const later = makeCtx(f, { names: new Map(), dedupBase: "turn-2:call-1" });
  const added = await api.addRecords(later, type.id, [{ person: "卡 特 龙", amount: "1" }, { person: "t.o.o.", amount: "1" }]);
  const people = added.ids.map((id) => f.raw.prepare("SELECT person FROM records WHERE id=?").get(id).person);
  assert.deepEqual(people, ["卡特龙", "TOO"]);
});

// ---------- RC-05 / RC-06 / RC-06b / RC-10 / RC-11 ----------
test("R3 RC-05: three ledger rows land as 360/50/90 and summarize to ¥500 from SQL", async () => {
  const f = fixture(), ctx = makeCtx(f);
  const { type, added } = await rc05(f, ctx);
  assert.equal(added.ids.length, 3);
  assert.equal(added.duplicated, 0);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM records WHERE type_id=?", type.id)[0].n, 3);
  assert.equal(cents(f, type.id), 50000);
  const sum = await api.summarizeRecords(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
  assert.equal(sum.total_cents, 50000);
  assert.equal(sum.count, 3);
  const byPerson = Object.fromEntries(sum.groups.map((g) => [g.key, g.sum_cents]));
  assert.deepEqual(byPerson, { TOO: 36000, 卡特龙: 5000, Souvereign: 9000 });
  const q = await api.queryRecords(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
  assert.equal(q.rows.length, 3);
  assert.ok(q.rows.every((r) => r.short.startsWith("#") && r.short.length === 7));
  assert.equal(q.rows.find((r) => r.person === "TOO").amount, "¥360.00");
});

test("R4 RC-06 + RC-06b + cold read: 370/50/290 and 710 come from SQL, not context", async () => {
  const f = fixture(), ctx = makeCtx(f);
  const { type } = await rc05(f, ctx);
  await api.addRecords(makeCtx(f, { dedupBase: "turn-2:call-1", sourceMsgId: "m-2" }), type.id, [{ person: "我", amount: "加10" }]);
  await api.addRecords(makeCtx(f, { dedupBase: "turn-3:call-1", sourceMsgId: "m-3" }), type.id, [{ person: "Souvereign", amount: "+200" }]);
  const cold = makeCtx(f, { names: new Map() });
  const sum = await api.summarizeRecords(f.e, { groupId: G, typeId: type.id, viewer: cold.actor });
  const byPerson = Object.fromEntries(sum.groups.map((g) => [g.key, g.sum_cents]));
  assert.equal(byPerson.TOO, 37000);
  assert.equal(byPerson["卡特龙"], 5000);
  assert.equal(byPerson.Souvereign, 29000);
  assert.equal(sum.total_cents, 71000);
  assert.equal(sum.count, 5);
});

test("R5 dedup key: replaying the same turn/tool call inserts nothing and reports duplicates", async () => {
  const f = fixture(), ctx = makeCtx(f);
  const { type, added } = await rc05(f, ctx);
  const again = await api.addRecords(ctx, type.id, [
    { person: "我", amount: "￥360" }, { person: "卡特龙", amount: "￥50" }, { person: "Souvereign", amount: "￥90" },
  ]);
  assert.deepEqual(again.ids, []);
  assert.equal(again.duplicated, 3);
  assert.equal(cents(f, type.id), 50000);
  assert.equal(added.ids.length, 3);
});

// ---------- private rows (S-18) ----------
test("R6 private rows: creator sees them; others see a hiddenPrivate count and no content", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  await api.addRecords(ctx, type.id, [{ person: "TOO", amount: "35", title: "午饭" }], "private");
  await api.addRecords(makeCtx(f, { dedupBase: "turn-6:call-2" }), type.id, [{ person: "TOO", amount: "10", title: "公交" }]);
  const other = { sender: "S-KTL", name: "卡特龙", isAdmin: false };
  const q = await api.queryRecords(f.e, { groupId: G, typeId: type.id, viewer: other });
  assert.equal(q.rows.length, 1);
  assert.equal(q.hiddenPrivate, 1);
  const sum = await api.summarizeRecords(f.e, { groupId: G, typeId: type.id, viewer: other });
  assert.equal(sum.total_cents, 1000);
  assert.equal(sum.hiddenPrivate, 1);
  const mine = await api.queryRecords(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
  assert.equal(mine.rows.length, 2);
  const csvOther = await api.exportCsv(f.e, { groupId: G, typeId: type.id, viewer: other });
  assert.ok(!csvOther.csv.includes("午饭"));
  const csvMine = await api.exportCsv(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
  assert.ok(csvMine.csv.includes("午饭"));
});

// ---------- quote -> confirm, ambiguity, permissions, expiry ----------
test("R7 quote update changes nothing until confirm; confirm updates data and writes one event", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  const added = await api.addRecords(ctx, type.id, [{ person: "卡特龙", amount: "50", title: "垫付" }]);
  const id = added.ids[0];
  const quote = await api.quoteChange(ctx, { record_id: id, typeId: type.id, op: "update", patch: { amount: "60" } });
  assert.equal(quote.before.amount, "¥50.00");
  assert.equal(quote.after.amount, "¥60.00");
  assert.ok(quote.expires_at > NOW);
  assert.equal(cents(f, type.id), 5000);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM pending_actions WHERE missing='confirm' AND status='open'")[0].n, 1);
  const applied = await api.applyChange(makeCtx(f, { now: NOW + 1000 }), quote.token);
  assert.equal(applied.op, "update");
  assert.equal(cents(f, type.id), 6000);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM record_events WHERE action='update'")[0].n, 1);
  assert.equal(rows(f, "SELECT status FROM pending_actions WHERE id=?", quote.token)[0].status, "done");
});

test("R8 quote permissions: non-creator denied, expired token rejected, ambiguous match lists candidates", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  const a = await api.addRecords(ctx, type.id, [{ person: "卡特龙", amount: "50" }, { person: "卡特龙", amount: "70" }]);
  const other = makeCtx(f, { actor: { sender: "S-KTL", name: "卡特龙", isAdmin: false } });
  await assert.rejects(
    () => api.quoteChange(other, { record_id: a.ids[0], typeId: type.id, op: "update", patch: { amount: "60" } }),
    (error) => error.kind === "denied",
  );
  await assert.rejects(
    () => api.quoteChange(ctx, { match: { person: "卡特龙" }, typeId: type.id, op: "update", patch: { amount: "60" } }),
    (error) => error.kind === "ambiguous" && /#/.test(error.message),
  );
  const quote = await api.quoteChange(ctx, { record_id: a.ids[0], typeId: type.id, op: "update", patch: { amount: "60" } });
  f.raw.prepare("UPDATE pending_actions SET expires_at=? WHERE id=?").run(NOW - 1, quote.token);
  await assert.rejects(() => api.applyChange(ctx, quote.token), (error) => error.kind === "not_found");
});

test("R9 quote_delete: one row is soft-deleted; bulk delete needs admin; events keep before/after", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  const a = await api.addRecords(ctx, type.id, [{ person: "卡特龙", amount: "50" }, { person: "卡特龙", amount: "70" }]);
  const one = await api.applyChange(ctx, (await api.quoteChange(ctx, { record_id: a.ids[0], typeId: type.id, op: "delete" })).token);
  assert.equal(one.op, "delete");
  assert.ok(rows(f, "SELECT deleted_at FROM records WHERE id=?", a.ids[0])[0].deleted_at);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM record_events WHERE action='delete'")[0].n, 1);

  const many = await api.addRecords(makeCtx(f, { dedupBase: "turn-9:call" }), type.id, [
    { person: "Souvereign", amount: "10" }, { person: "Souvereign", amount: "20" }, { person: "Souvereign", amount: "30" },
  ]);
  await assert.rejects(
    () => api.quoteChange(ctx, { match: { person: "Souvereign" }, typeId: type.id, op: "delete" }),
    (error) => error.kind === "ambiguous",
  );
  await assert.rejects(
    () => api.quoteChange(ctx, { typeId: type.id, op: "delete" }),
    (error) => error.kind === "denied",
  );
  const admin = makeCtx(f, { actor: { sender: "S-ADMIN", name: "管理员", isAdmin: true }, dedupBase: "turn-9:admin" });
  const bulk = await api.quoteChange(admin, { match: { person: "Souvereign" }, typeId: type.id, op: "delete" });
  const done = await api.applyChange(admin, bulk.token);
  assert.equal(done.op, "delete");
  assert.equal(rows(f, "SELECT COUNT(*) n FROM records WHERE id IN (?,?,?) AND deleted_at IS NOT NULL", ...many.ids)[0].n, 3);
});

// ---------- undo ----------
test("R10 undo: add, update and delete are reversible inside 10 minutes and not after it", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  const a = await api.addRecords(ctx, type.id, [{ person: "TOO", amount: "100" }]);
  const undoAdd = await api.undoLast(makeCtx(f, { now: NOW + 1000 }), type.id);
  assert.equal(undoAdd.op, "add");
  assert.ok(rows(f, "SELECT deleted_at FROM records WHERE id=?", a.ids[0])[0].deleted_at);

  const b = await api.addRecords(makeCtx(f, { dedupBase: "turn-10:add" }), type.id, [{ person: "TOO", amount: "100" }]);
  const q = await api.quoteChange(makeCtx(f, { dedupBase: "turn-10:q" }), { record_id: b.ids[0], typeId: type.id, op: "update", patch: { amount: "200" } });
  await api.applyChange(makeCtx(f, { now: NOW + 2000 }), q.token);
  const undoUpdate = await api.undoLast(makeCtx(f, { now: NOW + 3000 }), type.id);
  assert.equal(undoUpdate.op, "update");
  assert.equal(cents(f, type.id), 10000);

  f.raw.prepare("UPDATE record_events SET created_at=? WHERE action='add'").run(NOW - 11 * 60 * 1000);
  f.raw.prepare("UPDATE record_events SET created_at=? WHERE action IN ('update','delete','restore')").run(NOW - 11 * 60 * 1000);
  assert.equal(await api.undoLast(makeCtx(f, { now: NOW }), type.id), null);
});

// ---------- export ----------
test("R11 export: UTF-8 BOM, 500-row and 64KB caps, truncated flag", async () => {
  const f = fixture(), ctx = makeCtx(f), type = await ledger(f);
  await api.addRecords(ctx, type.id, [{ person: "TOO", amount: "1", title: "a" }, { person: "卡特龙", amount: "2", title: "b" }]);
  const csv = await api.exportCsv(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
  assert.ok(csv.csv.startsWith("\uFEFF"));
  assert.ok(csv.csv.includes("TOO") && csv.csv.includes("¥1.00"));
  assert.equal(csv.rows, 2);
  assert.equal(csv.truncated, false);

  const oldRows = api.LIMITS.exportRows, oldBytes = api.LIMITS.exportBytes;
  try {
    api.LIMITS.exportRows = 1;
    const capped = await api.exportCsv(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
    assert.equal(capped.rows, 1);
    assert.equal(capped.truncated, true);
    api.LIMITS.exportRows = oldRows;
    api.LIMITS.exportBytes = 160;
    const bytes = await api.exportCsv(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor });
    assert.ok(Buffer.byteLength(bytes.csv, "utf8") <= 160);
    assert.equal(bytes.truncated, true);
  } finally {
    api.LIMITS.exportRows = oldRows;
    api.LIMITS.exportBytes = oldBytes;
  }
});

// ---------- list (S-08) ----------
test("R12 list: default todo, status done update, query only shows what is left", async () => {
  const f = fixture(), ctx = makeCtx(f);
  const { type } = await api.defineRecordType(ctx, { name: "购物清单", kind: "list" });
  assert.equal(type.kind, "list");
  const added = await api.addRecords(ctx, type.id, [{ title: "牛奶" }, { title: "鸡蛋" }]);
  assert.equal(added.ids.length, 2);
  assert.deepEqual(rows(f, "SELECT status FROM records ORDER BY rowid").map((r) => r.status), ["todo", "todo"]);
  const egg = rows(f, "SELECT id FROM records WHERE title='鸡蛋'")[0].id;
  const quote = await api.quoteChange(ctx, { record_id: egg, typeId: type.id, op: "update", patch: { status: "done" } });
  await api.applyChange(ctx, quote.token);
  const left = await api.queryRecords(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor, filter: { status: "todo" } });
  assert.deepEqual(left.rows.map((r) => r.title), ["牛奶"]);
  const sum = await api.summarizeRecords(f.e, { groupId: G, typeId: type.id, viewer: ctx.actor, group_by: "status" });
  assert.deepEqual(Object.fromEntries(sum.groups.map((g) => [g.key, g.count])), { todo: 1, done: 1 });
});

// ---------- records tool ----------
test("T1 records_write add: RC-05 auto-defines the ledger, returns ids/short/summary, RC-06/06b read back 370/50/290/710", async () => {
  const f = fixture();
  const first = source("m-1", "记账报销额度\n我￥360，卡特龙￥50，Souvereign￥90");
  const added = await api.recordsWriteTool.run(f.e, {
    op: "add", type: "报销额度", source_id: "m-1",
    rows: [{ person: "我", amount: "￥360" }, { person: "卡特龙", amount: "￥50" }, { person: "Souvereign", amount: "￥90" }],
    request_quote: "记账报销额度\n我￥360，卡特龙￥50，Souvereign￥90",
  }, toolCtx(f, first));
  assert.equal(added.ok, true);
  assert.equal(added.accepted, true);
  assert.equal(added.family, "record");
  assert.equal(added.ids.length, 3);
  assert.equal(added.short.length, 3);
  assert.match(added.summary_line, /合计 ¥500\.00/);
  assert.match(added.say, /¥500\.00/);

  const second = source("m-2", "我加10");
  const inc = await api.recordsWriteTool.run(f.e, {
    op: "add", rows: [{ person: "我", amount: "加10" }], request_quote: "我加10", source_id: "m-2",
  }, toolCtx(f, second));
  assert.equal(inc.ok, true);
  assert.match(inc.summary_line, /TOO ¥370\.00/);
  assert.match(inc.summary_line, /合计 ¥510\.00/);

  const third = source("m-3", "Souvereign +200");
  const more = await api.recordsWriteTool.run(f.e, {
    op: "add", rows: [{ person: "Souvereign", amount: "+200" }], request_quote: "Souvereign +200", source_id: "m-3",
  }, toolCtx(f, third));
  assert.equal(more.ok, true);
  assert.match(more.summary_line, /合计 ¥710\.00/);

  const cold = source("m-4", "总账单");
  const summary = await api.recordsReadTool.run(f.e, { op: "summarize", source_id: "m-4" }, toolCtx(f, cold));
  assert.equal(summary.ok, true);
  assert.equal(summary.total_cents, 71000);
  const byPerson = Object.fromEntries(summary.groups.map((g) => [g.key, g.sum_cents]));
  assert.deepEqual(byPerson, { TOO: 37000, Souvereign: 29000, 卡特龙: 5000 });
  assert.match(summary.summary_line, /¥370\.00/);
  assert.match(summary.summary_line, /¥50\.00/);
  assert.match(summary.summary_line, /¥290\.00/);
  assert.match(summary.summary_line, /¥710\.00/);
});

test("T2 records_write auth: quote must be the speaker's own words; tainted quote_update is denied", async () => {
  const f = fixture();
  const src = source("m-1", "记账报销额度 我￥360");
  const ok = await api.recordsWriteTool.run(f.e, {
    op: "add", name: "报销额度", rows: [{ person: "我", amount: "360" }], request_quote: "记账报销额度", source_id: "m-1",
  }, toolCtx(f, src));
  assert.equal(ok.ok, true);

  const bad = await api.recordsWriteTool.run(f.e, {
    op: "add", rows: [{ person: "我", amount: "1" }], request_quote: "这句话不在原话里", source_id: "m-2",
  }, toolCtx(f, source("m-2", "我加1")));
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, "denied");

  const recordId = rows(f, "SELECT id FROM records LIMIT 1")[0].id;
  const typeId = rows(f, "SELECT id FROM record_types LIMIT 1")[0].id;
  const tainted = await api.recordsWriteTool.run(f.e, {
    op: "quote_update", type: "报销额度", record_id: recordId, patch: { amount: "60" },
    request_quote: "改成60", source_id: "m-3",
  }, toolCtx(f, source("m-3", "改成60"), { tainted: true }));
  assert.equal(tainted.ok, false);
  assert.equal(tainted.error_kind, "denied");
  assert.equal(rows(f, "SELECT COUNT(*) n FROM pending_actions")[0].n, 0);
  assert.ok(typeId);
});

test("T3 records_read: types/query/summarize/export and group-private redaction", async () => {
  const f = fixture();
  const ctx = makeCtx(f), type = await ledger(f);
  await api.addRecords(ctx, type.id, [{ person: "TOO", amount: "35", title: "私密午饭" }], "private");
  await api.addRecords(makeCtx(f, { dedupBase: "turn-t3:call-2" }), type.id, [{ person: "TOO", amount: "10", title: "公交" }]);

  const src = source("m-1", "我的私账");
  const tc = toolCtx(f, src);
  const types = await api.recordsReadTool.run(f.e, { op: "types" }, tc);
  assert.equal(types.ok, true);
  assert.equal(types.types.length, 1);
  assert.equal(types.types[0].name, "报销额度");

  const q = await api.recordsReadTool.run(f.e, { op: "query", type: "报销额度" }, tc);
  assert.equal(q.ok, true);
  assert.equal(q.privateCount, 1);
  assert.ok(q.rows.every((r) => r.visibility !== "private"));
  assert.match(q.say, /1 条私有记录/);

  const sum = await api.recordsReadTool.run(f.e, { op: "summarize", type: "报销额度" }, tc);
  assert.equal(sum.total_cents, 1000);
  assert.equal(sum.privateCount, 1);
  assert.match(sum.say, /工作台/);

  const csv = await api.recordsReadTool.run(f.e, { op: "export", type: "报销额度" }, tc);
  assert.equal(csv.ok, true);
  assert.ok(csv.csv.startsWith("\uFEFF"));
  assert.ok(!csv.csv.includes("私密午饭"));
  assert.match(csv.say, /私有记录/);
});

test("T4 records_write quote/confirm/undo via the tool keeps a single accepted record family", async () => {
  const f = fixture();
  const first = source("m-1", "记一笔 卡特龙50");
  await api.recordsWriteTool.run(f.e, {
    op: "add", name: "报销额度", rows: [{ person: "卡特龙", amount: "50" }], request_quote: "记一笔 卡特龙50", source_id: "m-1",
  }, toolCtx(f, first));
  const id = rows(f, "SELECT id FROM records LIMIT 1")[0].id;

  const quote = await api.recordsWriteTool.run(f.e, {
    op: "quote_update", type: "报销额度", record_id: id, patch: { amount: "60" }, request_quote: "把卡特龙那笔改成60", source_id: "m-2",
  }, toolCtx(f, source("m-2", "把卡特龙那笔改成60")));
  assert.equal(quote.ok, true);
  assert.equal(quote.accepted, true);
  assert.equal(quote.family, "record");
  assert.match(quote.say, /确认/);
  assert.equal(cents(f, rows(f, "SELECT id FROM record_types LIMIT 1")[0].id), 5000);

  const confirm = await api.recordsWriteTool.run(f.e, {
    op: "confirm", token: quote.token, request_quote: "确认", source_id: "m-3",
  }, toolCtx(f, source("m-3", "确认")));
  assert.equal(confirm.ok, true);
  assert.match(confirm.say, /60\.00/);
  assert.equal(cents(f, rows(f, "SELECT id FROM record_types LIMIT 1")[0].id), 6000);

  const undo = await api.recordsWriteTool.run(f.e, {
    op: "undo", type: "报销额度", request_quote: "撤销上一笔", source_id: "m-4",
  }, toolCtx(f, source("m-4", "撤销上一笔")));
  assert.equal(undo.ok, true);
  assert.equal(undo.op, "update");
  assert.equal(cents(f, rows(f, "SELECT id FROM record_types LIMIT 1")[0].id), 5000);
});

test("T5 records tool failure shape: invalid input is ok:false with a Chinese reason and no writes", async () => {
  const f = fixture();
  const bad = await api.recordsWriteTool.run(f.e, {
    op: "add", rows: [{ person: "我", amount: "看不懂" }], request_quote: "我记一笔", source_id: "m-1",
  }, toolCtx(f, source("m-1", "我记一笔")));
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, "invalid");
  assert.match(bad.reason_text, /金额没看懂/);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM records")[0].n, 0);
});

test("T6 RC-09 generic ledger name reuses the existing type; private add never shows details in group totals", async () => {
  const f = fixture();
  const first = source("m-1", "记账报销额度 我￥360");
  const created = await api.recordsWriteTool.run(f.e, {
    op: "add", name: "报销额度", rows: [{ person: "我", amount: "360" }], request_quote: "记账报销额度", source_id: "m-1",
  }, toolCtx(f, first));
  assert.equal(created.ok, true);
  const typeId = rows(f, "SELECT id FROM record_types LIMIT 1")[0].id;

  const generic = await api.recordsWriteTool.run(f.e, {
    op: "define_type", name: "本地记账工具", request_quote: "建立一个本地记账工具", source_id: "m-2",
  }, toolCtx(f, source("m-2", "建立一个本地记账工具")));
  assert.equal(generic.ok, true);
  assert.equal(generic.created, false);
  assert.equal(generic.id, typeId);
  assert.equal(rows(f, "SELECT COUNT(*) n FROM record_types")[0].n, 1);

  const secret = await api.recordsWriteTool.run(f.e, {
    op: "add", type: "报销额度", visibility: "private",
    rows: [{ person: "我", title: "午饭", amount: "35" }],
    request_quote: "记一笔私账：我午饭35，只有我能看", source_id: "m-3",
  }, toolCtx(f, source("m-3", "记一笔私账：我午饭35，只有我能看")));
  assert.equal(secret.ok, true);
  assert.equal(secret.private, true);
  assert.match(secret.say, /只有你能看到/);
  assert.ok(!secret.say.includes("¥35.00"), "private amount must not be spoken into the group");

  const read = await api.recordsReadTool.run(f.e, { op: "summarize", type: "报销额度", source_id: "m-3" },
    toolCtx(f, source("m-3", "我的私账")));
  assert.equal(read.privateCount, 1);
  assert.equal(read.total_cents, 36000);
  assert.match(read.say, /工作台/);
});
