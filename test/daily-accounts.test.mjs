import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Accounts } from "../src/accounts.ts";
import feature, { dailyAccountsDay, dailyAccountsStatus, dailyAccountsTask, ensureDailyAccountsSchedule, publishDailyAccounts } from "../src/feat/daily-accounts.ts";
import { BJ, SYD, nextDaily } from "../src/util.ts";

const ROOM = "g:sample";
const TEST_ROOM = "t:accounting";
const YESTERDAY = "2026-11-14";
const MIDNIGHT = Date.parse("2026-11-15T00:00:00+08:00");
const NOW = MIDNIGHT + 60000;

function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE ledger(conv TEXT, name TEXT, balance REAL, PRIMARY KEY(conv,name));
    CREATE TABLE snap(day TEXT PRIMARY KEY, cny REAL, ts INTEGER);
    CREATE TABLE spend(day TEXT, provider TEXT, item TEXT, unit TEXT, calls INTEGER, in_tok INTEGER,
      cached_tok INTEGER, out_tok INTEGER, units REAL, usd REAL, PRIMARY KEY(day,provider,item));
    CREATE TABLE sched(id INTEGER PRIMARY KEY, conv TEXT, spec TEXT, task TEXT, next INTEGER, active INTEGER DEFAULT 1, last INTEGER);
    CREATE TABLE msg(conv TEXT, role TEXT, text TEXT);
    CREATE TABLE pending(conv TEXT, kind TEXT, body TEXT);
  `);
  const hub = {
    env: { DEEPSEEK_API_KEY: "offline-test" },
    sql: { exec(query, ...args) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...args) : (stmt.run(...args), []);
      return { toArray: () => rows };
    } },
    ctx: { storage: { transactionSync(fn) {
      db.exec("BEGIN");
      try { fn(); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    } } },
    addSchedule(conv, spec, task) {
      return db.prepare("INSERT INTO sched(conv,spec,task,next) VALUES(?,?,?,?)").run(conv, JSON.stringify(spec), task, nextDaily(spec.time, spec.tz, NOW));
    },
    async say(conv, text) { db.prepare("INSERT INTO msg VALUES(?,'bot',?)").run(conv, text); return true; },
    plan: { report: () => ({}) }, store: { r2All: () => 0 },
  };
  hub.accounts = new Accounts(hub);
  return { db, hub };
}

function balanceResponse(t, total) {
  t.mock.method(globalThis, "fetch", async () => Response.json({ balance_infos: [{ currency: "USD", total_balance: "30.10" }, { currency: "CNY", total_balance: total }] }));
}

test("reports room ledger and the previous Beijing day's API-reported tokens", async t => {
  const { db, hub } = setup(t);
  balanceResponse(t, "12.30");
  let clock = MIDNIGHT - 1000;
  t.mock.method(Date, "now", () => clock);
  db.prepare("INSERT INTO ledger VALUES(?,?,?)").run(ROOM, "甲", 0.1);
  db.prepare("INSERT INTO ledger VALUES(?,?,?)").run(ROOM, "乙", 0.2);
  db.prepare("INSERT INTO ledger VALUES(?,?,?)").run("g:another", "别群", 999);
  hub.accounts.record({ provider: "deepseek", item: "聊天", inTok: 1200, cachedTok: 1000, outTok: 100, usd: 0.01 });
  hub.accounts.record({ provider: "deepseek", item: "联网搜索", units: 3, unit: "次", usd: 0.001 });
  hub.accounts.record({ provider: "openai", item: "画图", inTok: 400, outTok: 300, usd: 0.02 });
  clock = MIDNIGHT;
  hub.accounts.record({ provider: "deepseek", item: "聊天", inTok: 111, outTok: 22, usd: 0.01 });

  const report = await feature.tools({ hub, conv: ROOM })[0].run({});
  assert.equal(report.date, YESTERDAY);
  assert.equal(report.tokens.input_tokens, 1600);
  assert.equal(report.tokens.output_tokens, 400);
  assert.equal(report.tokens.total_tokens, 2000);
  assert.deepEqual(report.tokens.providers.map(r => [r.provider, r.total_tokens]), [["deepseek", 1300], ["openai", 700]]);
  assert.equal(report.ledger.total_cents, 30);
  assert.doesNotMatch(report.text, /别群/);
  assert.match(report.text, /已记录 token 总数 2,000/);
  assert.match(report.text, /DeepSeek 余额 ¥12\.30（接口实读）/);
  const usage = await hub.accounts.usage(2);
  assert.deepEqual(usage.days.map(d => [d.date, d.total_tokens]), [["2026-11-15", 133], [YESTERDAY, 2000]]);
  assert.equal(usage.total.total_tokens, 2133);
});

test("labels a stale balance and absent token data without inventing a zero balance", async t => {
  const { db, hub } = setup(t);
  balanceResponse(t, null);
  assert.equal(await hub.accounts.balance(), null);
  const missing = await hub.accounts.dailyReport(ROOM, YESTERDAY);
  assert.equal(missing.deepseek_balance, null);
  assert.match(missing.text, /余额暂不可查/);
  assert.match(missing.text, /暂无带 token 数据/);
  db.prepare("INSERT INTO snap VALUES(?,?,?)").run(YESTERDAY, 98.23, MIDNIGHT - 86400000);
  const fallback = await hub.accounts.dailyReport(ROOM, YESTERDAY);
  assert.equal(fallback.deepseek_balance.source, "snapshot");
  assert.match(fallback.text, /¥98\.23（即时读取失败，最近快照/);
  await assert.rejects(feature.tools({ hub, conv: ROOM })[0].run({ date: "2026-02-30" }), /已结束/);
});

test("upgrades the previous midnight schedule in place and respects cancellation", t => {
  const { db, hub } = setup(t);
  const old = JSON.stringify({ type: "daily", time: "03:00", tz: SYD });
  const insert = db.prepare("INSERT INTO sched(conv,spec,task,next,last) VALUES(?,?,?,?,?)");
  insert.run(ROOM, old, "发群账本、DeepSeek 余额和使用量", MIDNIGHT + 86400000, MIDNIGHT);
  insert.run(ROOM, old, "群聊天日报", MIDNIGHT + 86400000, null);
  insert.run(ROOM, old, "发 ledger 和 DeepSeek token 日报", MIDNIGHT + 86400000, null);
  insert.run("g:another", old, "发群账本和 API 余额", MIDNIGHT + 86400000, null);
  ensureDailyAccountsSchedule(hub, ROOM, NOW);
  ensureDailyAccountsSchedule(hub, ROOM, NOW);
  assert.deepEqual(dailyAccountsStatus(hub, ROOM), { id: 1, active: true, timezone: BJ, time: "00:00", source: "upgraded", next_beijing: "2026-11-16 00:00", last_started_beijing: "2026-11-15 00:00" });
  const preserved = db.prepare("SELECT active FROM sched ORDER BY id").all().map(r => r.active);
  assert.deepEqual(preserved, [1, 1, 0, 1]);
  const saved = JSON.parse(db.prepare("SELECT spec FROM sched WHERE id=1").get().spec);
  assert.equal(nextDaily(saved.time, saved.tz, Date.parse("2027-07-01T06:00:00+08:00")), Date.parse("2027-07-02T00:00:00+08:00"));
  assert.equal(dailyAccountsDay(dailyAccountsTask(saved, MIDNIGHT, "legacy")), YESTERDAY);
  assert.equal(dailyAccountsTask({ type: "daily" }, MIDNIGHT, "普通提醒"), "普通提醒");
  db.exec("UPDATE sched SET active=0 WHERE id=1");
  ensureDailyAccountsSchedule(hub, ROOM, NOW);
  assert.equal(dailyAccountsStatus(hub, ROOM).active, false);
});

test("sets up one schedule on an empty installation and keeps retries from posting twice", async t => {
  const { db, hub } = setup(t);
  balanceResponse(t, "0.00");
  assert.equal(await hub.accounts.balance(), 0);
  ensureDailyAccountsSchedule(hub, TEST_ROOM, NOW);
  assert.equal(dailyAccountsStatus(hub, TEST_ROOM), null);
  ensureDailyAccountsSchedule(hub, ROOM, NOW);
  ensureDailyAccountsSchedule(hub, ROOM, NOW);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sched").get().n, 1);
  assert.equal(dailyAccountsStatus(hub, ROOM).source, "created");
  assert.equal(await publishDailyAccounts(hub, TEST_ROOM, YESTERDAY, () => true), false);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM msg").get().n, 0);
  assert.equal(await publishDailyAccounts(hub, TEST_ROOM, YESTERDAY, () => false), true);
  assert.equal(await publishDailyAccounts(hub, TEST_ROOM, YESTERDAY, () => false), true);
  const first = db.prepare("SELECT * FROM msg").all();
  assert.equal(first.length, 1);
  assert.equal(first[0].conv, TEST_ROOM);
  assert.match(first[0].text, /DeepSeek 余额 ¥0\.00/);
  db.prepare("INSERT INTO pending VALUES(?,'text',?)").run(ROOM, first[0].text);
  assert.equal(await publishDailyAccounts(hub, ROOM, YESTERDAY, () => false), true);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM msg").get().n, 1);
});
