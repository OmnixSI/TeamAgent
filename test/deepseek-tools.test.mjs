import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

// F9DS DS-0: the shared DeepSeek tools channel. No real network, no real key.
const outfile = ".wrangler/ds-tools-tests-" + process.pid + ".mjs";
await build({
  stdin: {
    contents: 'export * from "./src/deepseek-tools";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);
const runner = await import("../runner/deepseek-client.mjs");

const KEY = "sk-ds-SECRET-do-not-log-7c21";
const TEXT = "语音自检不要泄露这段原文";
const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = readFileSync(
  new URL("../migrations/0060_ds_usage.sql", import.meta.url),
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
  return { e: { DB: db, DEEPSEEK_API_KEY: KEY, ...extra }, db };
}
function usageRows(db) {
  return db.raw.prepare("SELECT * FROM ds_usage ORDER BY rowid").all();
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
const bytesResponse = (bytes, type = "audio/wav") =>
  new Response(bytes, { status: 200, headers: { "content-type": type } });
const searchJson = { results: [{ title: "ping", url: "https://api.deepseek.com/" }] };
const searchRequest = (over = {}) => ({
  purpose: "search",
  json: { query: "ping", count: 1 },
  timeoutMs: 2000,
  group: "G1",
  sender: "U1",
  ...over,
});
const ttsRequest = (over = {}) => ({
  purpose: "tts",
  json: { text: TEXT, voice_id: "stella", format: "wav" },
  expect: "bytes",
  timeoutMs: 2000,
  group: "G1",
  sender: "U1",
  ...over,
});
const settings = (db, key, value) =>
  db.raw.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key, value);
const quotaRows = (db) =>
  db.raw.prepare("SELECT * FROM quota_reservations").all();

test("D0 migration 0060 creates ds_usage idempotently and is registered", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(migration);
  d.exec(migration);
  const names = d
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(names.includes("ds_usage"));
  const cols = d.prepare("PRAGMA table_info(ds_usage)").all().map((r) => r.name);
  assert.deepEqual(cols, [
    "id",
    "purpose",
    "group_id",
    "sender_id",
    "status",
    "error_kind",
    "latency_ms",
    "units",
    "est_cost_micro_usd",
    "created_at",
  ]);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS ds_usage/);
  assert.match(
    readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf8"),
    /migrations\/0060_ds_usage\.sql/,
  );
  d.close();
});

test("D1 every purpose uses its fixed path on api.deepseek.com and ignores caller host/path", async () => {
  const { e } = env();
  const f = spyFetch((url) =>
    String(url).endsWith("/v1/tools/tts")
      ? bytesResponse(new Uint8Array([1, 2, 3]))
      : jsonResponse(searchJson),
  );
  try {
    const cases = [
      ["asr", new FormData(), "json"],
      ["tts", undefined, "bytes"],
      ["ocr", new FormData(), "json"],
      ["search", { query: "ping", count: 1 }, "json"],
      ["fetch", { url: "https://api-docs.deepseek.com" }, "json"],
    ];
    for (const [purpose, body, expect] of cases) {
      const call = {
        purpose,
        timeoutMs: 2000,
        expect,
        ...(purpose === "tts"
          ? { json: { text: TEXT, format: "wav" } }
          : body instanceof FormData
            ? { form: body }
            : { json: body }),
        // A caller must not be able to redirect the request.
        host: "https://evil.test",
        path: "/v1/evil",
      };
      const r = await api.callDsTool(e, call);
      assert.equal(r.ok, true, purpose + " should succeed");
    }
    assert.deepEqual(
      f.calls.map((c) => c.url),
      [
        "https://api.deepseek.com/v1/tools/asr",
        "https://api.deepseek.com/v1/tools/tts",
        "https://api.deepseek.com/v1/tools/ocr",
        "https://api.deepseek.com/v1/tools/search",
        "https://api.deepseek.com/v1/tools/fetch",
      ],
    );
    for (const call of f.calls) {
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.redirect, "error");
      assert.equal(call.init.headers.Authorization, "Bearer " + KEY);
    }
    const bad = await api.callDsTool(e, {
      ...searchRequest(),
      purpose: "image",
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error_kind, "denied");
    assert.equal(f.calls.length, 5, "unknown purpose must not send");
  } finally {
    f.restore();
  }
});

test("D2 real error shapes map to the agreed kinds", async () => {
  const cases = [
    [
      "400 unsupported audio format",
      "asr",
      { error: { message: "Unsupported audio format: expected 16-bit PCM WAV or Ogg Opus, mono or stereo (request_id: r1)", type: "invalid_request_error", code: "invalid_request_error" } },
      400,
      "unsupported",
      false,
    ],
    [
      "413 too large",
      "asr",
      { error: { message: "Request body exceeds 8388608 bytes (request_id: r2)", type: "payload_too_large_error" } },
      413,
      "too_large",
      false,
    ],
    [
      "401 missing key",
      "search",
      { error: { message: "Authentication Fails (missing key) (request_id: r3)", type: "authentication_error" } },
      401,
      "auth",
      false,
    ],
    [
      "200 body error for .txt OCR",
      "ocr",
      { error: { message: "Failed to recognize the file: the file format is not supported", type: "invalid_request_error" } },
      200,
      "unsupported",
      false,
    ],
    [
      "403 URL access denied",
      "fetch",
      { error: { message: "URL access denied (request_id: r4)", type: "permission_error" } },
      403,
      "denied",
      false,
    ],
    [
      "400 content risk",
      "tts",
      { error: { message: "Content Exists Risk", type: "invalid_request_error" } },
      400,
      "refused",
      false,
    ],
    [
      "429 balance",
      "search",
      { error: { message: "Insufficient Balance", type: "insufficient_quota" } },
      429,
      "quota",
      true,
    ],
    [
      "503 upstream",
      "search",
      { error: { message: "RAW_UPSTREAM_DETAIL service unavailable" } },
      503,
      "upstream",
      true,
    ],
  ];
  for (const [name, purpose, body, status, kind, retryable] of cases) {
    const { e, db } = env();
    const f = spyFetch(() => jsonResponse(body, status));
    try {
      const call =
        purpose === "tts"
          ? { purpose, json: { text: TEXT, format: "wav" }, timeoutMs: 2000 }
          : purpose === "fetch"
            ? { purpose, json: { url: "https://example.com/private" }, timeoutMs: 2000 }
            : purpose === "asr" || purpose === "ocr"
              ? { purpose, form: new FormData(), timeoutMs: 2000 }
              : searchRequest({ purpose });
      const r = await api.callDsTool(e, call);
      assert.equal(r.ok, false, name);
      assert.equal(r.error_kind, kind, name);
      assert.equal(r.retryable, retryable, name);
      if (status === 200) assert.equal(r.status, 200, name);
      assert.ok(r.reason_text.length > 0, name);
      assert.ok(r.next_action.length > 0, name);
      assert.ok(!/request_id|RAW_UPSTREAM_DETAIL/.test(r.reason_text), name);
      assert.ok(!r.reason_text.includes(KEY), name);
      const rows = usageRows(db);
      assert.equal(rows.length, 1, name);
      assert.equal(rows[0].status, "failed", name);
      assert.equal(rows[0].error_kind, kind, name);
    } finally {
      f.restore();
    }
  }

  const { e } = env();
  const original = globalThis.fetch;
  globalThis.fetch = () => Promise.reject(new TypeError("network down"));
  try {
    const r = await api.callDsTool(e, searchRequest());
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "upstream");
    assert.equal(r.retryable, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("D3 a hanging request aborts at timeoutMs and reports timeout", async () => {
  const { e, db } = env();
  const original = globalThis.fetch;
  globalThis.fetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
      );
    });
  const started = Date.now();
  try {
    const r = await api.callDsTool(e, searchRequest({ timeoutMs: 50 }));
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "timeout");
    assert.equal(r.retryable, true);
    assert.ok(Date.now() - started < 1500);
    assert.equal(usageRows(db)[0].error_kind, "timeout");
  } finally {
    globalThis.fetch = original;
  }
});

test("D4 success records units, cost and never the text or key", async () => {
  const { e, db } = env();
  const f = spyFetch((url) => {
    const u = String(url);
    if (u.endsWith("/asr"))
      return jsonResponse({ text: "你好", duration_ms: 21269 });
    if (u.endsWith("/tts")) return bytesResponse(new Uint8Array([9, 8, 7]));
    if (u.endsWith("/ocr"))
      return jsonResponse({ page_count: 2, pages: [{ index: 0 }] });
    return jsonResponse(searchJson);
  });
  try {
    const asr = await api.callDsTool(e, {
      purpose: "asr",
      form: new FormData(),
      timeoutMs: 2000,
      group: "G1",
      sender: "U1",
    });
    assert.equal(asr.ok, true);
    const tts = await api.callDsTool(
      e,
      ttsRequest({ json: { text: "语音自检", voice_id: "stella", format: "wav" } }),
    );
    assert.equal(tts.ok, true);
    assert.deepEqual([...tts.bytes], [9, 8, 7]);
    const ocr = await api.callDsTool(e, {
      purpose: "ocr",
      form: new FormData(),
      timeoutMs: 2000,
      group: "G1",
      sender: "U1",
    });
    assert.equal(ocr.ok, true);
    const search = await api.callDsTool(e, searchRequest());
    assert.equal(search.ok, true);
    const fetchCall = await api.callDsTool(e, {
      purpose: "fetch",
      json: { url: "https://api-docs.deepseek.com" },
      timeoutMs: 2000,
      group: "G1",
      sender: "U1",
    });
    assert.equal(fetchCall.ok, true);

    const rows = usageRows(db);
    assert.equal(rows.length, 5);
    assert.deepEqual(
      rows.map((r) => [r.purpose, r.units, r.est_cost_micro_usd, r.status]),
      [
        ["asr", 21269, 343, "ok"],
        // 4 Han chars count double: 8 billed characters * 22.5 µ$/char.
        ["tts", 8, 180, "ok"],
        ["ocr", 2, 450, "ok"],
        ["search", 1, 750, "ok"],
        ["fetch", 1, 750, "ok"],
      ],
    );
    for (const row of rows) {
      assert.equal(row.group_id, "G1");
      assert.equal(row.sender_id, "U1");
      assert.ok(row.latency_ms >= 0);
      assert.ok(!JSON.stringify(row).includes(KEY));
      assert.ok(!JSON.stringify(row).includes(TEXT));
    }
  } finally {
    f.restore();
  }
});

test("D4b price constants can be overridden by settings", async () => {
  const { e, db } = env();
  settings(db, "ds:price:tts_micro_usd_per_10k_chars", "450000");
  const f = spyFetch(() => bytesResponse(Uint8Array.from([1])));
  try {
    const r = await api.callDsTool(
      e,
      ttsRequest({ json: { text: "语音自检", voice_id: "stella", format: "wav" } }),
    );
    assert.equal(r.ok, true);
    const row = usageRows(db)[0];
    assert.equal(row.units, 8);
    // 8 billed characters at $0.45 / 10k instead of $0.225 / 10k.
    assert.equal(row.est_cost_micro_usd, 360);
  } finally {
    f.restore();
  }
});

test("D5 DB is optional: no accounting still returns the payload", async () => {
  const e = { DEEPSEEK_API_KEY: KEY };
  const f = spyFetch(() => jsonResponse(searchJson));
  try {
    const r = await api.callDsTool(e, searchRequest());
    assert.equal(r.ok, true);
    assert.equal(r.status, 200);
    assert.equal(r.data.results.length, 1);
  } finally {
    f.restore();
  }
  const guard = await api.dsGuard(
    { DEEPSEEK_API_KEY: KEY },
    { purpose: "search", group: "G1", sender: "U1" },
  );
  assert.equal(guard.ok, true);
  await guard.release();
});

test("D6 bytes responses stay bytes; a 200 JSON error is still a failure", async () => {
  const { e } = env();
  const f = spyFetch((url) =>
    String(url).includes("fail")
      ? jsonResponse({ error: { message: "the file format is not supported" } }, 200)
      : bytesResponse(Uint8Array.from([4, 5, 6])),
  );
  try {
    const ok = await api.callDsTool(e, ttsRequest({ json: { text: TEXT, format: "wav" } }));
    assert.equal(ok.ok, true);
    assert.deepEqual([...ok.bytes], [4, 5, 6]);
    assert.equal(ok.data, null);
  } finally {
    f.restore();
  }
  const g = spyFetch(() =>
    jsonResponse(
      { error: { message: "file format is not supported" } },
      200,
    ),
  );
  try {
    const bad = await api.callDsTool(
      e,
      ttsRequest({ json: { text: TEXT, format: "mp3" } }),
    );
    assert.equal(bad.ok, false);
    assert.equal(bad.error_kind, "unsupported");
    assert.equal(bad.status, 200);
  } finally {
    g.restore();
  }
});

test("D7 logs hold purpose/status/latency only, never the key or text", async () => {
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
  const { e, db } = env();
  const f = spyFetch(() => bytesResponse(Uint8Array.from([1])));
  try {
    const ok = await api.callDsTool(e, ttsRequest());
    assert.equal(ok.ok, true);
    db.raw.prepare("INSERT INTO settings(key,value) VALUES('off:ds_tts','1')").run();
    const guard = await api.dsGuard(e, {
      purpose: "tts",
      group: "G1",
      sender: "U1",
    });
    assert.equal(guard.ok, false);
    assert.equal(guard.error_kind, "denied");
    assert.ok(logs.length >= 1);
    for (const line of logs) {
      assert.ok(!line.includes(KEY), "key leaked to console");
      assert.ok(!line.includes(TEXT), "text leaked to console");
      assert.match(line, /deepseek/);
      const parsed = JSON.parse(line.slice(line.indexOf("{")));
      assert.deepEqual(Object.keys(parsed).sort(), [
        "latency_ms",
        "purpose",
        "status",
      ]);
    }
    assert.ok(!JSON.stringify(usageRows(db)).includes(KEY));
    assert.ok(!JSON.stringify(usageRows(db)).includes(TEXT));
  } finally {
    f.restore();
    for (const name of names) console[name] = saved[name];
  }
});

test("D8 guard: off switches, user/group daily limits, budget and release", async () => {
  const { e, db } = env();
  settings(db, "off:dstools", "1");
  let g = await api.dsGuard(e, { purpose: "search", group: "G1", sender: "U1" });
  assert.equal(g.ok, false);
  assert.equal(g.error_kind, "denied");
  db.raw.prepare("DELETE FROM settings WHERE key='off:dstools'").run();

  settings(db, "off:ds_search", "1");
  g = await api.dsGuard(e, { purpose: "search", group: "G1", sender: "U1" });
  assert.equal(g.ok, false);
  assert.equal(g.error_kind, "denied");
  const allowed = await api.dsGuard(e, {
    purpose: "tts",
    group: "G1",
    sender: "U1",
  });
  assert.equal(allowed.ok, true);
  await allowed.release();
  db.raw.prepare("DELETE FROM settings WHERE key='off:ds_search'").run();

  settings(db, "ds:tts:user_daily", "1");
  const first = await api.dsGuard(e, {
    purpose: "tts",
    group: "G1",
    sender: "U1",
  });
  assert.equal(first.ok, true);
  const second = await api.dsGuard(e, {
    purpose: "tts",
    group: "G1",
    sender: "U1",
  });
  assert.equal(second.ok, false);
  assert.equal(second.error_kind, "quota");
  assert.match(second.reason_text, /次数|限额/);
  assert.equal(quotaRows(db).length, 2);
  await first.release();
  assert.equal(quotaRows(db).length, 0);
  db.raw.prepare("DELETE FROM settings WHERE key='ds:tts:user_daily'").run();

  settings(db, "ds:tts:group_daily", "1");
  const a = await api.dsGuard(e, {
    purpose: "tts",
    group: "G1",
    sender: "U1",
  });
  assert.equal(a.ok, true);
  const b = await api.dsGuard(e, {
    purpose: "tts",
    group: "G1",
    sender: "U2",
  });
  assert.equal(b.ok, false);
  assert.equal(b.error_kind, "quota");
  assert.equal(quotaRows(db).length, 2, "failed group reservation releases the user slot");
  await a.release();
  db.raw.prepare("DELETE FROM settings WHERE key='ds:tts:group_daily'").run();

  settings(db, "ds:daily_cap_micro_usd", "1000");
  db.raw
    .prepare(
      "INSERT INTO ds_usage(id,purpose,group_id,sender_id,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES('spent','search','G1','U1','ok',NULL,10,1,1000,?)",
    )
    .run(Date.now());
  const capped = await api.dsGuard(e, {
    purpose: "search",
    group: "G1",
    sender: "U1",
  });
  assert.equal(capped.ok, false);
  assert.equal(capped.error_kind, "budget");
  assert.match(capped.reason_text, /预算/);
});

test("D9 selftest: search + tts, no D1 writes, at most twice an hour", async () => {
  api._resetDsSelfTest();
  const { e, db } = env();
  const f = spyFetch((url) =>
    String(url).endsWith("/tts")
      ? bytesResponse(Uint8Array.from(Array(64).fill(1)))
      : jsonResponse(searchJson),
  );
  try {
    const before = usageRows(db).length;
    const first = await api.dsSelfTest(e);
    assert.equal(first.status, 200);
    assert.equal(first.body.ok, true);
    assert.equal(first.body.search.ok, true);
    assert.equal(first.body.search.bytes > 0, true);
    assert.equal(first.body.search.results, 1);
    assert.equal(first.body.tts.ok, true);
    assert.equal(first.body.tts.bytes, 64);
    assert.ok(first.body.search.latency_ms >= 0);
    assert.ok(first.body.tts.latency_ms >= 0);
    assert.equal(usageRows(db).length, before, "selftest must not write D1");
    assert.equal(f.calls.length, 2);
    assert.equal(first.body.ms >= 0, true);
    assert.ok(!JSON.stringify(first.body).includes(TEXT));

    const second = await api.dsSelfTest(e);
    assert.equal(second.status, 200);
    const third = await api.dsSelfTest(e);
    assert.equal(third.status, 429);
    assert.equal(third.body.ok, false);
    assert.equal(f.calls.length, 4, "the throttled call must not hit the API");
  } finally {
    f.restore();
  }
});

test("D10 owner selftest route: owner only, works without D1 writes", async () => {
  const { env, req } = await import("./support.mjs");
  const e = env();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) =>
    String(url).endsWith("/tts")
      ? bytesResponse(Uint8Array.from(Array(32).fill(2)))
      : jsonResponse(searchJson);
  try {
    const before = (
      await e.DB.prepare("SELECT COUNT(*) n FROM ds_usage").first()
    ).n;
    const ok = await req(e, "/api/team/dstools/selftest");
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.equal(body.ok, true);
    assert.equal(body.tts.bytes, 32);
    assert.equal(
      (await e.DB.prepare("SELECT COUNT(*) n FROM ds_usage").first()).n,
      before,
    );

    await req(e, "/api/admin/name-members", {
      members: ["hongming", "jinxiang", "jinyi"].map((name) => ({
        name,
        password: name,
      })),
    });
    const login = await req(e, "/api/team/login-name", {
      password: "hongming",
    });
    const token = (await login.json()).token;
    const denied = await req(e, "/api/team/dstools/selftest", undefined, token);
    assert.equal(denied.status, 403);
  } finally {
    globalThis.fetch = original;
  }
});

test("D11 runner client: same paths, key from file, same error mapping, no key in output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "f9ds-client-"));
  const keyFile = join(dir, "key.txt");
  writeFileSync(keyFile, "sk-file-SECRET-11a2\n", { mode: 0o600 });
  const saved = {
    file: process.env.DEEPSEEK_API_KEY_FILE,
    key: process.env.DEEPSEEK_API_KEY,
  };
  process.env.DEEPSEEK_API_KEY_FILE = keyFile;
  delete process.env.DEEPSEEK_API_KEY;
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("fail"))
      return jsonResponse({ error: { message: "Content Exists Risk" } }, 400);
    if (String(url).endsWith("/tts")) return bytesResponse(Uint8Array.from([3, 2, 1]));
    return jsonResponse(searchJson);
  };
  const logs = [];
  try {
    const ok = await runner.callDs("search", {
      json: { query: "ping", count: 1 },
      timeoutMs: 2000,
      fetch: fake,
      log: (line) => logs.push(line),
    });
    assert.equal(ok.ok, true);
    assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(calls[0].init.headers.Authorization, "Bearer sk-file-SECRET-11a2");

    const tts = await runner.callDs("tts", {
      json: { text: "语音自检", format: "wav" },
      expect: "bytes",
      timeoutMs: 2000,
      fetch: fake,
    });
    assert.equal(tts.ok, true);
    assert.deepEqual([...tts.bytes], [3, 2, 1]);

    const refused = await runner.callDs("tts", {
      json: { text: "fail", format: "wav" },
      timeoutMs: 2000,
      fetch: async () =>
        jsonResponse({ error: { message: "Content Exists Risk" } }, 400),
    });
    assert.equal(refused.ok, false);
    assert.equal(refused.error_kind, "refused");
    assert.ok(!JSON.stringify(refused).includes("sk-file-SECRET"));
    for (const line of logs) {
      assert.ok(!JSON.stringify(line).includes("sk-file-SECRET"));
      assert.deepEqual(Object.keys(line).sort(), [
        "latency_ms",
        "purpose",
        "status",
      ]);
    }

    delete process.env.DEEPSEEK_API_KEY_FILE;
    let sent = 0;
    const noKey = await runner.callDs("search", {
      json: { query: "ping", count: 1 },
      timeoutMs: 2000,
      fetch: async () => {
        sent++;
        return jsonResponse(searchJson);
      },
    });
    assert.equal(noKey.ok, false);
    assert.equal(noKey.error_kind, "auth");
    assert.equal(sent, 0);
  } finally {
    if (saved.file === undefined) delete process.env.DEEPSEEK_API_KEY_FILE;
    else process.env.DEEPSEEK_API_KEY_FILE = saved.file;
    if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = saved.key;
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(runner.billedChars("语音自检"), 8);
  assert.equal(runner.billedChars("The quick brown fox"), 19);
  assert.equal(
    runner.estimateCostMicroUsd("tts", 8),
    180,
  );
  assert.equal(runner.estimateCostMicroUsd("asr", 21269), 343);
});
