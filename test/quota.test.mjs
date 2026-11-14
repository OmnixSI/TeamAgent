import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";

const outfile = `.wrangler/ds-balance-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export * from "./src/quota";' +
      'export { getQuotaTool } from "./src/tools/quota";' +
      'export { EXTRA_TOOLS } from "./src/tools/index";' +
      'export { TOOLS_CATALOG } from "./src/review/catalog";' +
      'export { toolSwitchedOff } from "./src/toolkit";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
});
const api = await import("../" + outfile);
rmSync(outfile);

const NOW = Date.parse("2026-11-14T13:40:00+11:00");
const MINUTE = 60000;
const SECRET = "sk-test-secret-do-not-print-123456";

function db() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  return {
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) {
          return statement(values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)));
        },
        async first() {
          return d.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: d.prepare(sql).all(...args) };
        },
        async run() {
          return d.prepare(sql).run(...args);
        },
      });
      return statement();
    },
    async batch(statements) {
      return statements.map((s) => d.prepare(s.sql).run(...s.args));
    },
  };
}

async function set(e, key, value) {
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(key, String(value))
    .run();
}

async function get(e, key) {
  return (await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value ?? null;
}

async function snapshotRows(e) {
  return (
    await e.DB.prepare(
      "SELECT scope,currency,total_balance,granted_balance,topped_up_balance,created_at FROM ds_balance_snapshots ORDER BY currency",
    ).all()
  ).results;
}

function stubFetch(payload = null, { fail = null, status = 200 } = {}) {
  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    if (fail) throw fail;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return {
    calls,
    restore() {
      globalThis.fetch = old;
    },
  };
}

function balancePayload(
  total = "8.88",
  { granted = "2.00", toppedUp = "6.88", currency = "CNY", available = true } = {},
) {
  return {
    is_available: available,
    balance_infos: [
      {
        currency,
        total_balance: total,
        granted_balance: granted,
        topped_up_balance: toppedUp,
      },
    ],
  };
}

async function seedSnapshot(e, { at = NOW - MINUTE, total = "10.00", granted = "2.00", toppedUp = "8.00", currency = "CNY" } = {}) {
  await e.DB.prepare(
    "INSERT INTO ds_balance_snapshots(scope,currency,total_balance,granted_balance,topped_up_balance,created_at) VALUES('global',?,?,?,?,?)",
  )
    .bind(currency, total, granted, toppedUp, at)
    .run();
}

test("get_quota is registered as a read-only tool with the ds_balance switch", async () => {
  assert.equal(api.getQuotaTool.name, "get_quota");
  assert.equal(api.getQuotaTool.switch, "ds_balance");
  assert.equal(api.getQuotaTool.untrusted, false);
  assert.equal(api.getQuotaTool.def.function.name, "get_quota");
  assert.ok(api.EXTRA_TOOLS.some((tool) => tool.name === "get_quota"));
  assert.deepEqual(
    api.TOOLS_CATALOG.find((tool) => tool.name === "get_quota"),
    { name: "get_quota", readonly: true, needs: [] },
  );
  const e = { DB: db() };
  assert.equal(await api.toolSwitchedOff(e, api.getQuotaTool), false);
  await set(e, "off:ds_balance", "1");
  assert.equal(await api.toolSwitchedOff(e, api.getQuotaTool), true);
});

test("the first recorded query answers the balance and says this is the first record", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.equal(result.ok, true);
    assert.match(result.text, /DeepSeek 里还有 ¥8\.88/);
    assert.match(result.text, /赠送 ¥2\.00/);
    assert.match(result.text, /充值 ¥6\.88/);
    assert.match(result.text, /这是第一次记录/);
    assert.equal(result.text.includes(SECRET), false);

    const rows = await snapshotRows(e);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].scope, "global");
    assert.equal(rows[0].currency, "CNY");
    assert.equal(rows[0].total_balance, "8.88");
    assert.equal(rows[0].granted_balance, "2.00");
    assert.equal(rows[0].topped_up_balance, "6.88");
    assert.equal(rows[0].created_at, NOW);
    assert.equal(JSON.stringify(rows).includes(SECRET), false);
    assert.equal(JSON.stringify(rows).includes("g1"), false);
  } finally {
    stub.restore();
  }
});

test("a lower balance reports exactly how much less than last time", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "10.00", granted: "2.00", toppedUp: "8.00" });
  const stub = stubFetch(balancePayload("8.77", { granted: "2.00", toppedUp: "6.77" }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /DeepSeek 里还有 ¥8\.77/);
    assert.match(result.text, /比上次（\d{2}:\d{2}）总共少了 ¥1\.23。/);
    assert.equal(result.text.includes("充值部分"), false);
    const rows = await snapshotRows(e);
    assert.equal(rows[0].total_balance, "8.77");
    assert.equal(rows[0].created_at, NOW);
  } finally {
    stub.restore();
  }
});

test("a top-up reports exactly how much more than last time", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "5.00", granted: "0.00", toppedUp: "5.00" });
  const stub = stubFetch(balancePayload("10.00", { granted: "0.00", toppedUp: "10.00" }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /比上次（\d{2}:\d{2}）总共多了 ¥5\.00。/);
  } finally {
    stub.restore();
  }
});

test("a granted-balance change is reported even when the total did not move", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "8.88", granted: "2.00", toppedUp: "6.88" });
  const stub = stubFetch(balancePayload("8.88", { granted: "1.50", toppedUp: "7.38" }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /总共没变，赠送部分少了 ¥0\.50，充值部分多了 ¥0\.50。/);
  } finally {
    stub.restore();
  }
});

test("a granted change that differs from the total move is spelled out", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "10.00", granted: "4.00", toppedUp: "6.00" });
  const stub = stubFetch(balancePayload("9.00", { granted: "3.50", toppedUp: "5.50" }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /总共少了 ¥1\.00，赠送部分少了 ¥0\.50，充值部分少了 ¥0\.50。/);
  } finally {
    stub.restore();
  }
});

test("an unchanged balance says there was no change and does not add noise", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "8.88", granted: "2.00", toppedUp: "6.88" });
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /跟上次（\d{2}:\d{2}）比没有变化。/);
  } finally {
    stub.restore();
  }
});

test("balance is cached for ten minutes and a cache hit never advances the snapshot", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload("8.88"));
  try {
    await api.renderQuota(e, { owner: true, now: NOW });
    const second = await api.renderQuota(e, { owner: true, now: NOW + MINUTE });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, api.DEEPSEEK_BALANCE_URL);
    assert.equal(stub.calls[0].init.headers.Authorization, "Bearer " + SECRET);
    assert.match(second.text, /没有变化/);
    const cached = JSON.parse(await get(e, api.DEEPSEEK_BALANCE_CACHE_KEY));
    assert.equal(cached.ok, true);
    assert.equal(cached.total, 8.88);
    const rows = await snapshotRows(e);
    assert.equal(rows[0].created_at, NOW);
  } finally {
    stub.restore();
  }
});

test("401 is reported honestly, hides the key and stores no snapshot", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch({ error: {} }, { status: 401 });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.equal(result.ok, true);
    assert.match(result.text, /这次查不到 DeepSeek 余额/);
    assert.match(result.text, /查询权限/);
    assert.equal(result.text.includes(SECRET), false);
    assert.equal((await snapshotRows(e)).length, 0);
  } finally {
    stub.restore();
  }
});

test("a timeout is reported honestly and stores no snapshot", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(null, { fail: Object.assign(new Error("aborted"), { name: "AbortError" }) });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /查询超时/);
    assert.match(result.text, /过一会儿再问我/);
    assert.equal((await snapshotRows(e)).length, 0);
  } finally {
    stub.restore();
  }
});

test("a failure is cached too, so the same outage is not hammered every minute", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(null, { fail: new Error("upstream boom") });
  try {
    await api.renderQuota(e, { owner: true, now: NOW });
    await api.renderQuota(e, { owner: true, now: NOW + MINUTE });
    assert.equal(stub.calls.length, 1);
    assert.equal((await snapshotRows(e)).length, 0);
  } finally {
    stub.restore();
  }
});

test("a failed first query still lets the next success be the first record", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const failed = stubFetch({ error: {} }, { status: 401 });
  try {
    await api.renderQuota(e, { owner: true, now: NOW });
  } finally {
    failed.restore();
  }
  const ok = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW + 11 * MINUTE });
    assert.match(result.text, /这是第一次记录/);
    assert.equal((await snapshotRows(e)).length, 1);
  } finally {
    ok.restore();
  }
});

test("a missing key says so without calling out", async () => {
  const e = { DB: db() };
  const stub = stubFetch(balancePayload());
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /还没配好查询权限/);
    assert.equal(stub.calls.length, 0);
    assert.equal((await snapshotRows(e)).length, 0);
  } finally {
    stub.restore();
  }
});

test("an unreadable balance body is reported, never guessed", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch({ is_available: true, balance_infos: [{ currency: "CNY" }] });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /这次查到的余额我看不懂/);
    assert.equal((await snapshotRows(e)).length, 0);
  } finally {
    stub.restore();
  }
});

test("USD-only and unknown-currency balances keep their own unit", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const usd = stubFetch(balancePayload("5.00", { granted: "0.00", toppedUp: "5.00", currency: "USD" }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /DeepSeek 里还有 \$5\.00/);
    assert.equal(result.text.includes("¥5.00"), false);
    const rows = await snapshotRows(e);
    assert.equal(rows[0].currency, "USD");
    assert.equal(rows[0].total_balance, "5.00");
  } finally {
    usd.restore();
  }

  const e2 = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const unknown = stubFetch({
    is_available: true,
    balance_infos: [{ total_balance: "5.00", granted_balance: "0", topped_up_balance: "5.00" }],
  });
  try {
    const result = await api.renderQuota(e2, { owner: true, now: NOW });
    assert.match(result.text, /5\.00（币种未知）/);
    assert.equal(result.text.includes("¥5.00"), false);
  } finally {
    unknown.restore();
  }
});

test("an unavailable account is said plainly, not turned into a number", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload("8.88", { available: false }));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /账户现在显示不可用/);
    assert.match(result.text, /赠送 ¥2\.00/);
  } finally {
    stub.restore();
  }
});

test("the tool gives exact numbers only to an owner who directly asked", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedSnapshot(e, { total: "10.00", granted: "2.00", toppedUp: "8.00" });
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const owner = await api.getQuotaTool.run(
      e,
      {},
      {
        context: {
          mentioned: true,
          latest: { group_id: "g1", sender: "u1", meta: { memberRole: "owner", direct: true } },
        },
        messages: [],
        isTainted: () => false,
      },
    );
    assert.match(owner.text, /DeepSeek 里还有 ¥8\.88/);
    assert.match(owner.text, /总共少了 ¥1\.12/);

    const quotedOwner = await api.getQuotaTool.run(
      e,
      {},
      {
        context: {
          mentioned: false,
          latest: { group_id: "g1", sender: "u1", meta: { memberRole: "owner", direct: false } },
        },
        messages: [],
        isTainted: () => false,
      },
    );
    assert.equal(quotedOwner.text, "额度：快没了。");

    const member = await api.getQuotaTool.run(
      e,
      {},
      {
        context: {
          mentioned: true,
          latest: { group_id: "g1", sender: "u2", meta: { memberRole: "member", direct: true } },
        },
        messages: [],
        isTainted: () => false,
      },
    );
    assert.equal(member.text, "额度：快没了。");
    assert.equal(/[0-9¥$]/.test(member.text), false);
  } finally {
    stub.restore();
  }
});

test("a non-owner gets only the A-quota band, never a number or a delta", async () => {
  for (const [total, expected] of [
    ["88.00", "额度：够用。"],
    ["8.88", "额度：快没了。"],
  ]) {
    const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
    const stub = stubFetch(balancePayload(total, { granted: "0.00", toppedUp: total }));
    try {
      const result = await api.renderQuota(e, { owner: false, now: NOW });
      assert.equal(result.text, expected);
      assert.equal(/[0-9¥$]/.test(result.text), false);
      assert.equal(result.text.includes("第一次记录"), false);
      assert.equal(result.text.includes("比上次"), false);
      // The snapshot is still recorded so the owner's next answer can compare.
      assert.equal((await snapshotRows(e)).length, 1);
    } finally {
      stub.restore();
    }
  }
});

test("a non-owner never sees the failure reason or a number", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch({ error: {} }, { status: 401 });
  try {
    const result = await api.renderQuota(e, { owner: false, now: NOW });
    assert.equal(result.text, "额度：暂时查不到。");
    assert.equal(result.text.includes("权限"), false);
    assert.equal(/[0-9¥$]/.test(result.text), false);
  } finally {
    stub.restore();
  }
});

test("inbound message metadata keeps the QQ member role for the owner check", async () => {
  const { env, qq, msg } = await import("./support.mjs");
  const e = env();
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('group_id','GROUP000001')").run();
  await qq(e, msg("quota-role-1", "你还有多少额度"));
  const row = await e.DB.prepare("SELECT json FROM message_meta WHERE id='quota-role-1'").first();
  assert.equal(JSON.parse(row.json).memberRole, "owner");
});

test("the capability list carries one plain-line quota entry with the ds_balance switch", () => {
  const manifest = JSON.parse(readFileSync(new URL("../config/self-manifest.json", import.meta.url), "utf8"));
  const quota = manifest.capabilities.find((cap) => cap.id === "quota");
  assert.ok(quota, "self-manifest 里没有 quota 能力");
  assert.equal(quota.title, "额度自知（DeepSeek 余额）");
  assert.deepEqual(quota.tools, ["get_quota"]);
  assert.deepEqual(quota.switches, ["ds_balance"]);
  assert.match(quota.how, /ds_balance_snapshots/);
  assert.match(quota.how, /第一次记录/);
  assert.ok(quota.aliases.includes("DeepSeek 余额"));
});

test("migration 0061 creates the snapshot table with the required fields", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../migrations/0061_ds_balance.sql", import.meta.url), "utf8"));
  const columns = d
    .prepare("PRAGMA table_info(ds_balance_snapshots)")
    .all()
    .map((column) => column.name)
    .sort();
  assert.deepEqual(columns, [
    "created_at",
    "currency",
    "granted_balance",
    "scope",
    "topped_up_balance",
    "total_balance",
  ]);
  d.prepare(
    "INSERT INTO ds_balance_snapshots(scope,currency,total_balance,granted_balance,topped_up_balance,created_at) VALUES('global','CNY','8.88','2.00','6.88',1)",
  ).run();
  d.prepare(
    "INSERT INTO ds_balance_snapshots(scope,currency,total_balance,granted_balance,topped_up_balance,created_at) VALUES('global','CNY','7.77','1.00','6.77',2) ON CONFLICT(scope,currency) DO UPDATE SET total_balance=excluded.total_balance,created_at=excluded.created_at",
  ).run();
  const row = d.prepare("SELECT total_balance,created_at FROM ds_balance_snapshots").get();
  assert.equal(row.total_balance, "7.77");
  assert.equal(row.created_at, 2);
});
