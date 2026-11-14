import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// F8-0 O1–O11: the shared OpenAI channel. No real network, no real key.
const outfile = ".wrangler/openai-tests-" + process.pid + ".mjs";
await build({
  stdin: {
    contents: 'export * from "./src/openai";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);

const KEY = "sk-test-SECRET-do-not-log-9f3a";
const PROMPT = "一只穿宇航服的柴犬在月球上骑自行车，背景是升起的地球";
const PATH = "/v1/images/generations";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0040_openai.sql", import.meta.url),
  "utf8",
);

// Mirrors test/support.mjs: D1-compatible prepare/bind/first/all/run over node:sqlite.
function makeDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(schema);
  const statements = [];
  const database = {
    raw: d,
    statements,
    prepare(sql) {
      statements.push(sql);
      const statement = (args = []) => ({
        sql,
        bind(...values) {
          return statement(
            values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          );
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
    async batch(ss) {
      return Promise.all(
        ss.map((s) =>
          /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run(),
        ),
      );
    },
  };
  return database;
}

function env(extra = {}) {
  const db = makeDb();
  return { e: { DB: db, ...extra }, db };
}
function usageRows(db) {
  return db.raw.prepare("SELECT * FROM openai_usage ORDER BY rowid").all();
}
function spyFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = original;
    },
  };
}
const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const request = (over = {}) => ({
  purpose: "image_gen",
  path: PATH,
  body: { model: "gpt-image-1", prompt: PROMPT },
  timeoutMs: 2000,
  model: "gpt-image-1",
  group: "G1",
  sender: "U1",
  ...over,
});

test("O0 migration 0040 creates both tables idempotently and is registered", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(migration);
  d.exec(migration);
  const names = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes("openai_usage"));
  assert.ok(names.includes("quota_reservations"));
  assert.match(schema, /CREATE TABLE IF NOT EXISTS openai_usage/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS quota_reservations/);
  assert.match(
    readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
    /migrations\/0040_openai\.sql/,
  );
  d.close();
});

test("O1 only api.openai.com is reachable; host-bearing paths are denied before any request", async () => {
  const { e } = env({ OPENAI_API_KEY: KEY });
  const f = spyFetch(() => jsonResponse({ data: [{ b64_json: "AAA" }] }));
  try {
    const r = await api.callOpenAi(e, request());
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.json.data[0].b64_json, "AAA");
    assert.ok(r.latency_ms >= 0);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].url, "https://api.openai.com/v1/images/generations");
    assert.equal(f.calls[0].init.method, "POST");
    assert.equal(f.calls[0].init.headers.Authorization, "Bearer " + KEY);
    // workerd rejects redirect:"error"; manual keeps the no-follow intent.
    assert.equal(f.calls[0].init.redirect, "manual");
    assert.notEqual(f.calls[0].init.redirect, "error");
    assert.equal(JSON.parse(f.calls[0].init.body).prompt, PROMPT);

    for (const path of [
      "https://evil.test/x",
      "//evil.test/x",
      "/v1/https://evil.test/x",
    ]) {
      const bad = await api.callOpenAi(e, request({ path }));
      assert.equal(bad.ok, false);
      assert.equal(bad.error_kind, "denied");
      assert.equal(bad.retryable, false);
    }
    assert.equal(f.calls.length, 1, "denied paths must not send");
  } finally {
    f.restore();
  }
});

test("O1b redirects are never followed: manual fetch, every 3xx fails, 200 still works", async () => {
  const { e } = env({ OPENAI_API_KEY: KEY });
  for (const status of [301, 302, 303, 307, 308]) {
    const f = spyFetch(
      () =>
        new Response(null, {
          status,
          headers: { location: "https://evil.test/redirected" },
        }),
    );
    try {
      const r = await api.callOpenAi(e, request());
      assert.equal(r.ok, false, status + " must be a failure");
      assert.equal(r.error_kind, "upstream", status + " kind");
      assert.equal(r.status, status);
      assert.equal(f.calls.length, 1, status + " is not followed");
      assert.equal(f.calls[0].url, "https://api.openai.com/v1/images/generations");
      assert.equal(f.calls[0].init.redirect, "manual");
      assert.notEqual(f.calls[0].init.redirect, "error");
    } finally {
      f.restore();
    }
  }
  const ok = spyFetch(() => jsonResponse({ data: [{ b64_json: "AAA" }] }));
  try {
    const r = await api.callOpenAi(e, request());
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(ok.calls[0].init.redirect, "manual");
    assert.notEqual(ok.calls[0].init.redirect, "error");
  } finally {
    ok.restore();
  }
});

test("O2 missing or blank key is auth and sends nothing", async () => {
  for (const key of [undefined, "", "   "]) {
    const { e } = env(key === undefined ? {} : { OPENAI_API_KEY: key });
    let called = 0;
    const f = spyFetch(() => {
      called++;
      return jsonResponse({});
    });
    try {
      const r = await api.callOpenAi(e, request());
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "auth");
      assert.equal(r.retryable, false);
      assert.match(r.next_action, /OPENAI_API_KEY/);
      assert.equal(called, 0);
    } finally {
      f.restore();
    }
  }
});

test("O3 policy 400 is refused, not retryable, and does not echo the upstream body", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  const f = spyFetch(() =>
    jsonResponse(
      {
        error: {
          code: "content_policy_violation",
          type: "invalid_request_error",
          message: "RAW_UPSTREAM_DETAIL: rejected " + PROMPT,
        },
      },
      400,
    ),
  );
  try {
    const r = await api.callOpenAi(e, request());
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "refused");
    assert.equal(r.retryable, false);
    assert.equal(r.status, 400);
    assert.ok(!r.reason_text.includes("RAW_UPSTREAM_DETAIL"));
    assert.ok(!r.reason_text.includes("content_policy"));
    assert.ok(!r.reason_text.includes(PROMPT));
    const rows = usageRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "failed");
    assert.equal(rows[0].error_kind, "refused");
  } finally {
    f.restore();
  }
});

test("O4 429 maps to quota, insufficient_quota to budget", async () => {
  for (const [body, kind, retryable] of [
    [{ error: { code: "rate_limit_exceeded", type: "requests" } }, "quota", true],
    [
      { error: { code: "insufficient_quota", type: "insufficient_quota" } },
      "budget",
      false,
    ],
  ]) {
    const { e, db } = env({ OPENAI_API_KEY: KEY });
    const f = spyFetch(() => jsonResponse(body, 429));
    try {
      const r = await api.callOpenAi(e, request());
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, kind);
      assert.equal(r.retryable, retryable);
      assert.equal(f.calls.length, 1);
      assert.equal(usageRows(db)[0].error_kind, kind);
    } finally {
      f.restore();
    }
  }
});

test("O5 a hanging request aborts at timeoutMs and reports timeout", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  const started = Date.now();
  try {
    const r = await api.callOpenAi(e, request({ timeoutMs: 50 }));
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "timeout");
    assert.equal(r.retryable, true);
    assert.ok(Date.now() - started < 1000);
    assert.equal(usageRows(db)[0].error_kind, "timeout");
  } finally {
    globalThis.fetch = original;
  }
});

test("O6 5xx is upstream and retryable", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  const f = spyFetch(() =>
    jsonResponse({ error: { message: "RAW_UPSTREAM_DETAIL" } }, 503),
  );
  try {
    const r = await api.callOpenAi(e, request());
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "upstream");
    assert.equal(r.retryable, true);
    assert.equal(r.status, 503);
    assert.ok(!r.reason_text.includes("RAW_UPSTREAM_DETAIL"));
    assert.equal(usageRows(db)[0].error_kind, "upstream");
  } finally {
    f.restore();
  }
});

test("O7 success and failure each write one usage row without prompt or key", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  const f = spyFetch((url, init) =>
    init.body.includes("FAIL")
      ? jsonResponse({ error: { message: "boom" } }, 503)
      : jsonResponse({ data: [{ b64_json: "AAA" }] }),
  );
  try {
    const ok = await api.callOpenAi(e, request({ estCostMicroUsd: 1500 }));
    assert.equal(ok.ok, true);
    let rows = usageRows(db);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.status, "ok");
    assert.equal(row.purpose, "image_gen");
    assert.equal(row.model, "gpt-image-1");
    assert.equal(row.group_id, "G1");
    assert.equal(row.sender_id, "U1");
    assert.equal(row.error_kind, null);
    assert.equal(row.est_cost_micro_usd, 1500);
    assert.ok(row.latency_ms >= 0);
    assert.ok(!JSON.stringify(row).includes(PROMPT));
    assert.ok(!JSON.stringify(row).includes(KEY));

    const bad = await api.callOpenAi(
      e,
      request({ body: { model: "gpt-image-1", prompt: PROMPT + " FAIL" } }),
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error_kind, "upstream");
    rows = usageRows(db);
    assert.equal(rows.length, 2);
    assert.equal(rows[1].status, "failed");
    assert.equal(rows[1].error_kind, "upstream");
    assert.equal(rows[1].est_cost_micro_usd, 0);
  } finally {
    f.restore();
  }
});

test("O8 the daily cap stops the call before fetch and only counts today's spend", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  db.raw
    .prepare(
      "INSERT INTO settings(key,value) VALUES('openai:daily_cap_micro_usd','5000')",
    )
    .run();
  db.raw
    .prepare(
      "INSERT INTO openai_usage(id,purpose,model,group_id,sender_id,status,error_kind,latency_ms,est_cost_micro_usd,created_at) VALUES('old','image_gen','m',NULL,NULL,'ok',NULL,10,5000,?)",
    )
    .run(Date.now() - 1000);
  const f = spyFetch(() => {
    throw new Error("must not fetch");
  });
  try {
    const r = await api.callOpenAi(e, request({ estCostMicroUsd: 100 }));
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "budget");
    assert.equal(r.retryable, false);
    assert.equal(f.calls.length, 0);
  } finally {
    f.restore();
  }

  const under = env({ OPENAI_API_KEY: KEY });
  under.db.raw
    .prepare(
      "INSERT INTO settings(key,value) VALUES('openai:daily_cap_micro_usd','5000')",
    )
    .run();
  under.db.raw
    .prepare(
      "INSERT INTO openai_usage(id,purpose,model,group_id,sender_id,status,error_kind,latency_ms,est_cost_micro_usd,created_at) VALUES('old','image_gen','m',NULL,NULL,'ok',NULL,10,1000,?)",
    )
    .run(Date.now() - 1000);
  const f2 = spyFetch(() => jsonResponse({ ok: true }));
  try {
    const r = await api.callOpenAi(under.e, request({ estCostMicroUsd: 1000 }));
    assert.equal(r.ok, true);
    assert.equal(f2.calls.length, 1);
  } finally {
    f2.restore();
  }
});

test("O9 settings off:openai=1 denies without a request", async () => {
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  db.raw.prepare("INSERT INTO settings(key,value) VALUES('off:openai','1')").run();
  const f = spyFetch(() => {
    throw new Error("must not fetch");
  });
  try {
    const r = await api.callOpenAi(e, request());
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "denied");
    assert.equal(r.retryable, false);
    assert.equal(f.calls.length, 0);
    assert.equal(usageRows(db)[0].error_kind, "denied");
  } finally {
    f.restore();
  }
});

test("O10 reserveQuota is one atomic insert; ten concurrent requests yield exactly three", async () => {
  const { e, db } = env();
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      api.reserveQuota(e, { kind: "image_user", key: "U1", limit: 3 }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
  const total = () =>
    db.raw.prepare("SELECT COUNT(*) AS n FROM quota_reservations").get().n;
  assert.equal(total(), 3);

  const inserts = db.statements.filter((s) =>
    s.startsWith("INSERT INTO quota_reservations"),
  );
  assert.equal(inserts.length, 10);
  for (const sql of inserts) {
    assert.match(
      sql,
      /^INSERT INTO quota_reservations\(id,kind,key,created_at\) SELECT \?,\?,\?,\? WHERE \(SELECT COUNT\(\*\) FROM quota_reservations WHERE kind=\? AND key=\? AND created_at>=\?\)<\?$/,
    );
  }
  const first = db.statements.indexOf(inserts[0]);
  assert.equal(
    db.statements.slice(0, first).filter((s) => /^\s*SELECT/i.test(s)).length,
    0,
    "no read-before-write",
  );

  const held = db.raw.prepare("SELECT id FROM quota_reservations LIMIT 1").get().id;
  await api.releaseQuota(e, held);
  assert.equal(total(), 2);
  const again = await api.reserveQuota(e, {
    kind: "image_user",
    key: "U1",
    limit: 3,
  });
  assert.equal(again.ok, true);
  assert.equal(again.used, 3);
  assert.ok(again.id);
  assert.equal(total(), 3);
});

test("O11 console output never contains the key or the prompt", async () => {
  const logs = [];
  const names = ["log", "info", "warn", "error", "debug"];
  const saved = {};
  for (const name of names) {
    saved[name] = console[name];
    console[name] = (...args) =>
      logs.push(
        args
          .map((arg) => {
            if (typeof arg === "string") return arg;
            try {
              return JSON.stringify(arg);
            } catch {
              return String(arg);
            }
          })
          .join(" "),
      );
  }
  const { e, db } = env({ OPENAI_API_KEY: KEY });
  const f = spyFetch(() => jsonResponse({ data: [{ b64_json: "AAA" }] }));
  try {
    const ok = await api.callOpenAi(e, request());
    assert.equal(ok.ok, true);
    db.raw
      .prepare("INSERT INTO settings(key,value) VALUES('off:openai','1')")
      .run();
    const denied = await api.callOpenAi(e, request());
    assert.equal(denied.error_kind, "denied");
    assert.ok(logs.length >= 2, "each call logs one structured line");
    for (const line of logs) {
      assert.ok(!line.includes(KEY), "key leaked to console");
      assert.ok(!line.includes(PROMPT), "prompt leaked to console");
    }
    assert.ok(!JSON.stringify(usageRows(db)).includes(KEY));
    assert.ok(!JSON.stringify(usageRows(db)).includes(PROMPT));
  } finally {
    f.restore();
    for (const name of names) console[name] = saved[name];
  }
});
