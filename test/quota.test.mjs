import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { buildMorningReport } from "../scripts/review-pull.mjs";

const outfile = `.wrangler/quota-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export * from "./src/quota";' +
      'export { getQuotaTool } from "./src/tools/quota";' +
      'export { EXTRA_TOOLS } from "./src/tools/index";' +
      'export { TOOLS_CATALOG } from "./src/review/catalog";',
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
const DAY = 86400000;
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
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .bind(key, String(value))
    .run();
}

async function get(e, key) {
  return (await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value ?? null;
}

async function seedUsage(e, { now = NOW } = {}) {
  const rows = [
    ["ds-1", "search", "ok", 600000, now - 3600000],
    ["ds-2", "tts", "ok", 600000, now - 7200000],
    ["ds-3", "ocr", "ok", 1200000, now - 3 * DAY],
    ["ds-old", "search", "ok", 900000, now - 20 * DAY],
  ];
  for (const [id, purpose, status, cost, at] of rows) {
    await e.DB.prepare("INSERT INTO ds_usage(id,purpose,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,NULL,100,1,?,?)")
      .bind(id, purpose, status, cost, at)
      .run();
  }
  const oa = [
    ["oa-1", 300000, now - 3600000],
    ["oa-2", 200000, now - 7200000],
  ];
  for (const [id, cost, at] of oa) {
    await e.DB.prepare("INSERT INTO openai_usage(id,purpose,model,status,latency_ms,est_cost_micro_usd,created_at) VALUES(?,'vision','m','ok',100,?,?)")
      .bind(id, cost, at)
      .run();
  }
  for (const [id, kind, key, at] of [
    ["img-1", "imagegen_group", "g1", now - 3600000],
    ["img-2", "imagegen_group", "g1", now - 7200000],
    ["img-3", "imagegen_user", "g1:u1", now - 3600000],
    ["img-old", "imagegen_group", "g1", now - 25 * 3600000],
  ]) {
    await e.DB.prepare("INSERT INTO quota_reservations(id,kind,key,created_at) VALUES(?,?,?,?)")
      .bind(id, kind, key, at)
      .run();
  }
  const utcDay = new Date(now).toISOString().slice(0, 10);
  await set(e, `budget:workers_ai_neurons:utc:${utcDay}`, 1200);
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

function bal(currency, total, available = true) {
  return { ok: true, at: NOW, available, currency, total, granted: 0, toppedUp: 0 };
}

function balancePayload(total = "8.88") {
  return {
    is_available: true,
    balance_infos: [
      {
        currency: "CNY",
        total_balance: total,
        granted_balance: "2.00",
        topped_up_balance: "6.88",
      },
    ],
  };
}

test("get_quota is registered as a read-only tool in the catalog", () => {
  assert.equal(api.getQuotaTool.name, "get_quota");
  assert.equal(api.getQuotaTool.untrusted, false);
  assert.equal(api.getQuotaTool.def.function.name, "get_quota");
  assert.ok(api.EXTRA_TOOLS.some((tool) => tool.name === "get_quota"));
  assert.deepEqual(
    api.TOOLS_CATALOG.find((tool) => tool.name === "get_quota"),
    { name: "get_quota", readonly: true, needs: [] },
  );
});

test("owner sees exact balance, usage, OpenAI, image and neuron numbers", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const stub = stubFetch(balancePayload());
  try {
    const result = await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
    assert.equal(result.ok, true);
    const text = result.text;
    assert.match(text, /DeepSeek 余额：¥8\.88/);
    assert.match(text, /DeepSeek 用量：今天 2 次 \/ \$1\.20/);
    assert.match(text, /本月 3 次 \/ \$2\.40/);
    assert.match(text, /OpenAI：今天 2 次 \/ \$0\.50，上限 \$3\.00，剩 \$2\.50/);
    assert.match(text, /生图：近 24 小时本群 2 \/ 20 张，你 1 \/ 5 张/);
    assert.match(text, /Workers AI：今天 1200 \/ 8000 neurons/);
    assert.match(text, /Cloudflare 账户级额度没有公开接口/);
    assert.equal(text.includes(SECRET), false);
    assert.equal(/sk-[a-z0-9-]{8,}/i.test(text), false);
  } finally {
    stub.restore();
  }
});

test("the tool grants exact numbers only to an owner who directly asked", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const owner = await api.getQuotaTool.run(
      e,
      {},
      { context: { mentioned: true, latest: { group_id: "g1", sender: "u1", meta: { memberRole: "owner", direct: true } } }, messages: [], isTainted: () => false },
    );
    assert.match(owner.text, /DeepSeek 余额：¥8\.88/);
    const quotedOwner = await api.getQuotaTool.run(
      e,
      {},
      { context: { mentioned: false, latest: { group_id: "g1", sender: "u1", meta: { memberRole: "owner", direct: false } } }, messages: [], isTainted: () => false },
    );
    assert.match(quotedOwner.text, /^额度：快没了。$/);
    const member = await api.getQuotaTool.run(
      e,
      {},
      { context: { mentioned: true, latest: { group_id: "g1", sender: "u2", meta: { memberRole: "member", direct: true } } }, messages: [], isTainted: () => false },
    );
    assert.match(member.text, /^额度：快没了。$/);
  } finally {
    stub.restore();
  }
});

test("non-owner gets only one coarse band word, never numbers", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: false, group: "g1", sender: "u1", now: NOW });
    assert.equal(result.ok, true);
    assert.equal(result.text, "额度：快没了。");
    assert.equal(/[0-9¥$]/.test(result.text), false);
    assert.equal(result.text.includes(SECRET), false);
  } finally {
    stub.restore();
  }
});

test("an unavailable account and an omitted is_available are reported without inventing availability", async () => {
  const body = { balance_infos: [{ currency: "CNY", total_balance: "5.00", granted_balance: "0", topped_up_balance: "5.00" }] };
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const off = stubFetch({ ...body, is_available: false });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /DeepSeek 余额：账户当前不可用/);
    assert.equal(result.band, "critical");
  } finally {
    off.restore();
  }
  const e2 = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const unknown = stubFetch(body);
  try {
    const result = await api.renderQuota(e2, { owner: true, now: NOW });
    assert.match(result.text, /官方未返回可用状态/);
    assert.equal(result.text.includes("（可用；"), false);
  } finally {
    unknown.restore();
  }
});

test("USD-only balance uses its own threshold and is never compared to ¥10", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const stub = stubFetch({
    is_available: true,
    balance_infos: [{ currency: "USD", total_balance: "5.00", granted_balance: "0.00", topped_up_balance: "5.00" }],
  });
  try {
    const result = await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
    assert.match(result.text, /DeepSeek 余额：\$5\.00/);
    assert.equal(result.text.includes("¥5.00"), false);
    assert.equal(await api.morningQuotaLine(e, NOW), "");
  } finally {
    stub.restore();
  }
});

test("balance is cached for ten minutes and a second question does not call out", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload());
  try {
    await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
    await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW + 60000 });
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].url, api.DEEPSEEK_BALANCE_URL);
    assert.equal(stub.calls[0].init.headers.Authorization, "Bearer " + SECRET);
    const cached = JSON.parse(await get(e, api.DEEPSEEK_BALANCE_CACHE_KEY));
    assert.equal(cached.ok, true);
    assert.equal(cached.total, 8.88);
  } finally {
    stub.restore();
  }
});

test("the first recorded query says so and stores a numeric snapshot", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload("10.00"));
  try {
    const result = await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
    assert.match(result.text, /较上次：这是第一次记录/);
    const snapshot = JSON.parse(await get(e, api.QUOTA_LAST_KEY));
    assert.equal(snapshot.at, NOW);
    assert.equal(snapshot.deepseek.CNY, "10.00");
    assert.equal(snapshot.dsCalls, 0);
    assert.equal(snapshot.aiUsed, 0);
    assert.equal(JSON.stringify(snapshot).includes(SECRET), false);
    assert.equal(JSON.stringify(snapshot).includes("g1"), false);
    assert.equal(JSON.stringify(snapshot).includes("u1"), false);
  } finally {
    stub.restore();
  }
});

test("a second real read reports balance, calls and neurons deltas with signs", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const first = stubFetch(balancePayload("10.00"));
  try {
    await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
  } finally {
    first.restore();
  }
  for (const id of ["delta-1", "delta-2"]) {
    await e.DB.prepare("INSERT INTO ds_usage(id,purpose,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,NULL,10,1,0,?)")
      .bind(id, "search", "ok", NOW - 1800000)
      .run();
  }
  const utcDay = new Date(NOW + 11 * 60000).toISOString().slice(0, 10);
  await set(e, `budget:workers_ai_neurons:utc:${utcDay}`, 320);
  const second = stubFetch(balancePayload("8.77"));
  try {
    const result = await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW + 11 * 60000 });
    assert.match(result.text, /较上次（\d{2}:\d{2}）：DeepSeek 余额 −1\.23 元 \/ 今日调用 \+2 次 \/ neurons \+320/);
  } finally {
    second.restore();
  }
});

test("a top-up shows a positive balance delta", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await set(e, api.QUOTA_LAST_KEY, JSON.stringify({
    at: NOW - 60000, deepseek: { CNY: "5.00" }, dsCalls: 0, dsMicroUsd: 0,
    openaiCalls: 0, openaiMicroUsd: 0, aiUsed: 0, band: "critical",
  }));
  const stub = stubFetch(balancePayload("10.00"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /DeepSeek 余额 \+5\.00 元/);
  } finally {
    stub.restore();
  }
});

test("an unchanged snapshot says no change", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await set(e, api.QUOTA_LAST_KEY, JSON.stringify({
    at: NOW - 60000, deepseek: { CNY: "8.88" }, dsCalls: 0, dsMicroUsd: 0,
    openaiCalls: 0, openaiMicroUsd: 0, aiUsed: 0, band: "critical",
  }));
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /较上次（\d{2}:\d{2}）：没变化/);
  } finally {
    stub.restore();
  }
});

test("a previous snapshot missing fields only compares the fields it has", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await set(e, api.QUOTA_LAST_KEY, JSON.stringify({
    at: NOW - 60000, deepseek: {}, dsCalls: 0, aiUsed: 0,
  }));
  for (const id of ["missing-1", "missing-2"]) {
    await e.DB.prepare("INSERT INTO ds_usage(id,purpose,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,NULL,10,1,0,?)")
      .bind(id, "search", "ok", NOW - 60000)
      .run();
  }
  const utcDay = new Date(NOW).toISOString().slice(0, 10);
  await set(e, `budget:workers_ai_neurons:utc:${utcDay}`, 320);
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    const delta = result.text.split("\n").pop();
    assert.match(delta, /今日调用 \+2 次/);
    assert.match(delta, /neurons \+320/);
    assert.equal(delta.includes("DeepSeek 余额"), false);
    assert.equal(delta.includes("OpenAI 今日花费"), false);
  } finally {
    stub.restore();
  }
});

test("a cache hit never overwrites the previous real snapshot", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(balancePayload("10.00"));
  try {
    await api.renderQuota(e, { owner: true, now: NOW });
    await e.DB.prepare("INSERT INTO ds_usage(id,purpose,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,NULL,10,1,0,?)")
      .bind("cache-1", "search", "ok", NOW - 60000)
      .run();
    const result = await api.renderQuota(e, { owner: true, now: NOW + 60000 });
    assert.match(result.text, /今日调用 \+1 次/);
    assert.equal(stub.calls.length, 1);
    const snapshot = JSON.parse(await get(e, api.QUOTA_LAST_KEY));
    assert.equal(snapshot.at, NOW);
    assert.equal(snapshot.dsCalls, 0);
  } finally {
    stub.restore();
  }
});

test("non-owner gets the band and one-notch move, never a number", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await set(e, api.QUOTA_LAST_KEY, JSON.stringify({
    at: NOW - 60000, deepseek: { CNY: "100.00" }, dsCalls: 0, dsMicroUsd: 0,
    openaiCalls: 0, openaiMicroUsd: 0, aiUsed: 0, band: "ok",
  }));
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const result = await api.renderQuota(e, { owner: false, now: NOW });
    assert.equal(result.text, "额度：快没了（比上次低了一档）。");
    assert.equal(/[0-9¥$]/.test(result.text), false);
  } finally {
    stub.restore();
  }
});

test("a failed balance lookup says so honestly, hides the key and is not retried inside ten minutes", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const stub = stubFetch(null, { fail: new Error("upstream boom") });
  try {
    const first = await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW });
    assert.equal(first.ok, true);
    assert.match(first.text, /DeepSeek 余额：暂时查不到/);
    assert.equal(first.text.includes(SECRET), false);
    assert.equal(first.text.includes("boom"), false);
    await api.renderQuota(e, { owner: true, group: "g1", sender: "u1", now: NOW + 60000 });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("thresholds follow the order: under ¥10 or under three days of spend", () => {
  const base = { avg7MicroUsd: 400000, openaiUsedMicroUsd: 0, openaiCapMicroUsd: 3000000, aiUsed: 0, aiCap: 8000 };
  assert.equal(api.DEEPSEEK_LOW_BALANCE_CNY, 10);
  assert.equal(api.DEEPSEEK_LOW_DAYS, 3);
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 9.99) }), "critical");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 10.01) }), "ok");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 10.01), avg7MicroUsd: 1000000 }), "critical");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 20), avg7MicroUsd: 1000000 }), "low");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 30), avg7MicroUsd: 1000000 }), "ok");
  assert.equal(api.quotaBand({ ...base, balance: { ok: false, at: NOW, kind: "timeout" } }), "unknown");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 100, false) }), "critical");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 100), openaiUsedMicroUsd: 2700000 }), "critical");
  assert.equal(api.quotaBand({ ...base, balance: bal("CNY", 100), aiUsed: 7000 }), "low");
  // USD has its own constant; a USD 5.00 balance must not be compared to 10.
  assert.equal(api.DEEPSEEK_LOW_BALANCE_USD.toFixed(2), "1.39");
  assert.equal(api.quotaBand({ ...base, balance: bal("USD", 5), avg7MicroUsd: 2000000 }), "low");
  assert.equal(api.quotaBand({ ...base, balance: bal("USD", 2) }), "ok");
  assert.equal(api.quotaBand({ ...base, balance: bal("USD", 1) }), "critical");
});

test("missing optional balance fields are tolerated without crashing", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.00" }] });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /¥12\.00/);
    assert.match(result.text, /赠送 ¥0\.00 \/ 充值 ¥0\.00/);
  } finally {
    stub.restore();
  }
  const e2 = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const empty = stubFetch({ is_available: true, balance_infos: [{ currency: "CNY" }] });
  try {
    const result = await api.renderQuota(e2, { owner: true, now: NOW });
    assert.match(result.text, /暂时查不到（返回内容无法识别/);
    assert.match(result.text, /请看 DeepSeek 后台/);
  } finally {
    empty.restore();
  }
});

test("a missing currency is never turned into an invented CNY amount", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch({ is_available: true, balance_infos: [{ total_balance: "5.00" }] });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /5\.00（币种未知）/);
    assert.equal(result.text.includes("¥5.00"), false);
    assert.equal(result.band, "unknown");
  } finally {
    stub.restore();
  }
});

test("401, 402 and 429 degrade to a plain console-check answer, never a throw", async () => {
  for (const [status, phrase] of [[401, "密钥或权限"], [402, "欠费"], [429, "太频繁"]]) {
    const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
    const stub = stubFetch({ error: {} }, { status });
    try {
      const result = await api.renderQuota(e, { owner: true, now: NOW });
      assert.equal(result.ok, true);
      assert.match(result.text, new RegExp(phrase));
      assert.match(result.text, /请看 DeepSeek 后台/);
      assert.equal(result.text.includes(SECRET), false);
    } finally {
      stub.restore();
    }
  }
});

test("a timeout is reported as a timeout and cached for ten minutes", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  const stub = stubFetch(null, { fail: Object.assign(new Error("aborted"), { name: "AbortError" }) });
  try {
    const result = await api.renderQuota(e, { owner: true, now: NOW });
    assert.match(result.text, /暂时查不到（查询超时/);
    assert.match(result.text, /请看 DeepSeek 后台/);
    await api.renderQuota(e, { owner: true, now: NOW + 60000 });
    assert.equal(stub.calls.length, 1);
  } finally {
    stub.restore();
  }
});

test("morning job writes one low-balance line for the developer-room report", async () => {
  const e = { DB: db(), DEEPSEEK_API_KEY: SECRET };
  await seedUsage(e);
  const at = Date.parse("2026-11-14T08:05:00+11:00");
  const stub = stubFetch(balancePayload("8.88"));
  try {
    const line = await api.morningQuotaLine(e, at);
    assert.match(line, /DeepSeek 余额 ¥8\.88/);
    assert.match(line, /低于 ¥10 警戒线/);
    await api.quotaMorningJob.run(e, new Date(at));
    const stored = JSON.parse(await get(e, api.QUOTA_MORNING_KEY));
    assert.equal(stored.day, "2026-11-14");
    assert.match(stored.line, /DeepSeek 余额 ¥8\.88/);
    assert.equal(stub.calls.length, 1);
    await api.quotaMorningJob.run(e, new Date(at + 60000));
    assert.equal(stub.calls.length, 1);
    const healthy = { DB: db(), DEEPSEEK_API_KEY: SECRET };
    await seedUsage(healthy);
    const healthyStub = stubFetch(balancePayload("88.00"));
    try {
      assert.equal(await api.morningQuotaLine(healthy, at), "");
    } finally {
      healthyStub.restore();
    }
  } finally {
    stub.restore();
  }
});

test("review morning report prints the quota line when the digest carries one", () => {
  const report = buildMorningReport({
    date: "2026-11-14",
    digest: {
      date: "2026-11-14",
      quota: { at: Date.now(), line: "DeepSeek 余额 ¥8.88，低于 ¥10 警戒线。" },
    },
    gaps: [],
    safety: { qq_sent: 0, d1_rows_written: 0 },
  });
  assert.match(report, /^额度：DeepSeek 余额 ¥8\.88，低于 ¥10 警戒线。$/m);
  assert.ok(report.split("\n").length <= 15);
});

test("inbound message metadata keeps the QQ member role for the owner check", async () => {
  const { env, qq, msg } = await import("./support.mjs");
  const e = env();
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('group_id','GROUP000001')").run();
  await qq(e, msg("quota-role-1", "你还有多少额度"));
  const row = await e.DB.prepare("SELECT json FROM message_meta WHERE id='quota-role-1'").first();
  assert.equal(JSON.parse(row.json).memberRole, "owner");
});
