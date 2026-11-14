// V-D-learning acceptance replay: VL-1 .. VL-20 on real exported rows.
//
// Safety: every outbound network call is counted and must go to the model API;
// no Cloudflare API is reachable (tokens are deleted) and no QQ send path is
// called. All stores are in-memory SQLite. The last log line always states
// "QQ 真实发送 0 次、线上 D1 写入 0 行".
//
// Run: node --test test/learning-accept.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as backfillScan } from "../scripts/backfill-schedule-requests.mjs";

const FIX = new URL("../replay/fixtures/", import.meta.url);
const OUT = new URL("../replay/out/", import.meta.url);
const BUILD_PATH = new URL(`../.wrangler/learning-accept-${process.pid}.mjs`, import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), "utf8"));
const sha256 = (name) => createHash("sha256").update(readFileSync(new URL(name, FIX))).digest("hex");

// The replay must not be able to reach Cloudflare even by accident.
for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN"]) delete process.env[key];

const allowedHosts = new Set(["api.deepseek.com", "api.openai.com"]);
const network = [];
const stats = {
  started_at: new Date().toISOString(),
  qq_real_sends: 0,
  online_d1_rows_written: 0,
  network_calls: 0,
  qq_network_calls: 0,
  cloudflare_network_calls: 0,
};
function counted(fn) {
  return async (url, init) => {
    const href = String(url);
    network.push(href);
    stats.network_calls++;
    let host = "";
    try { host = new URL(href).host; } catch {}
    if (host.includes("qq.com")) stats.qq_network_calls++;
    if (host.includes("cloudflare.com")) stats.cloudflare_network_calls++;
    if (!allowedHosts.has(host)) throw Error("replay network disabled: " + href);
    return fn(href, init);
  };
}
const defaultFetch = counted(async (url) => {
  throw Error("replay network disabled: " + url);
});
globalThis.fetch = defaultFetch;
function installFetch(fn) {
  const wrapped = counted(fn);
  globalThis.fetch = wrapped;
  return { restore() { globalThis.fetch = defaultFetch; }, fetch: wrapped };
}
const json = (data) => Response.json({ choices: [{ message: { content: JSON.stringify(data) }, finish_reason: "stop" }] });
const voice = (text) => json({ mode: "work", text });
const textResponse = (text) => Response.json({ choices: [{ message: { content: text }, finish_reason: "stop" }] });

const too = fixture("too-daily-request.json");
const signals = fixture("learning-signals-7d.json");
const cao = fixture("outbox-cao-18.json");
const p1 = fixture("review-p1-case.json");
const quiet = fixture("quiet-night.json");
const daytime = fixture("daytime-batch.json");
const drain = fixture("chat-drain-350.json");
const address = fixture("address-request.json");
const audit = fixture("export-audit.json");
const recorded = fixture("deepseek-recorded.json");
const index = fixture("index.json");

const DAY = 86400000;
const G = too.request.group_id;
const TOO_SENDER = too.request.sender;
const SOUV = "0FC1E8A8BD28981E86866125AC3FCEFF";
const B391 = "B391F15DDBE3390FCC35C5B7C0A2CC8D";
const TOO_QUOTE = "每天早上8点在群里推送一下昨日聊天内容总结";
const NOW15 = Date.parse("2026-11-15T05:00:00+11:00");
const NOW14 = Date.parse("2026-11-14T05:00:00+11:00");

// ---- isolated local database -------------------------------------------
function browserDb() {
  const raw = new DatabaseSync(":memory:");
  for (const file of [
    "schema.sql", "migrations/0002_plan_authority.sql", "migrations/0003_stage_timings.sql",
    "migrations/0004_repo_index.sql", "migrations/0008_review.sql",
  ]) raw.exec(readFileSync(new URL("../" + file, import.meta.url), "utf8"));
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
        const results = [];
        for (const statement of statements) {
          const sql = String(statement.sql || "");
          results.push(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql) ? await statement.all() : await statement.run());
        }
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { DB, raw, calls };
}
function makeEnv() {
  const { DB, raw, calls } = browserDb();
  const e = {
    DB, ADMIN_TOKEN: "owner-secret", RUNNER_TOKEN: "runner-secret", QQ_APP_SECRET: "test-only-secret",
    MODEL: "deepseek-flash", DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_API_KEY: "sk-fakeDEEPSEEK123456", DEEPSEEK_INPUT_USD_MICROS: "0.01", DEEPSEEK_OUTPUT_USD_MICROS: "0.1",
    DEEPSEEK_DAY_CAP_USD_MICROS: "100000",
    OPENAI_MODEL: "fake-second", OPENAI_API_KEY: "sk-fakeOPENAIKEY123456",
    OPENAI_INPUT_USD_MICROS: "0.01", OPENAI_OUTPUT_USD_MICROS: "0.1",
    WORK: { sent: [], async send(body, opts) { this.sent.push({ body, opts }); } },
  };
  return { e, raw, calls };
}
const rows = (e, sql, ...args) => e.DB.raw.prepare(sql).all(...args);
const one = (e, sql, ...args) => e.DB.raw.prepare(sql).get(...args) ?? null;
function message(raw, row) {
  raw.prepare("INSERT OR IGNORE INTO messages(rowid,id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,?,?)")
    .run(row.rid ?? null, row.id, row.group_id || G, row.sender, row.body, row.ts, row.mentioned ?? 1, row.processed ?? 1);
}
function outboxRow(raw, row) {
  raw.prepare("INSERT OR IGNORE INTO outbox(rowid,id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(row.rid ?? null, row.id, row.group_id || G, row.msg_id ?? null, row.body, row.status || "sent", row.created_at);
}
function member(raw, id, name, role = "member") {
  raw.prepare("INSERT OR IGNORE INTO members(id,name,token_hash,role) VALUES(?,?,?,?)")
    .run(id.startsWith("qq:") ? id : "qq:" + id, name, "h-" + id, role);
}
function runRow(raw, patch = {}) {
  const row = {
    id: G + ":2026-11-15", date: "2026-11-15", step: "publish", mode: "shadow",
    window_start: new Date(NOW15 - 3 * DAY).toISOString(), window_end: new Date(NOW15).toISOString(), ...patch,
  };
  raw.prepare(`INSERT OR REPLACE INTO review_runs(id,group_id,date,step,window_start,window_end,mode,stats,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, G, row.date, row.step, row.window_start, row.window_end, row.mode,
    JSON.stringify(row.stats || {}), NOW15);
  return { ...row, group_id: G };
}
function judgment(raw, data, { id = "j1", runId = G + ":2026-11-15", state = "ok", traceIds = [] } = {}) {
  raw.prepare(`INSERT OR REPLACE INTO review_judgments(id,run_id,gen,role,provider,model,trace_ids,state,reserved,max_tokens,raw,created_at)
    VALUES(?,?,0,'primary','deepseek','deepseek-flash',?,?,0,4096,?,?)`)
    .run(id, runId, JSON.stringify(traceIds), state, JSON.stringify(data), NOW15);
}
function trace(raw, id, { runId = G + ":2026-11-15", state = "judged", kind = "inbound" } = {}) {
  raw.prepare(`INSERT OR REPLACE INTO review_traces(id,run_id,group_id,kind,inbound_id,signals,priority,has_image,state,attempts,trace_json,created_at)
    VALUES(?,?,?,?,?,'[]',0,0,?,1,'{}',?)`)
    .run(id, runId, G, kind, kind === "inbound" ? id : null, state, NOW15);
}
function finding(raw, id, { runId = G + ":2026-11-15", patch = {} } = {}) {
  const row = {
    id, run_id: runId, trace_id: "tr-in-1", failure_type: "reasoning.decision.tool_selection",
    severity: "p1", fix_layer: "prompt", gap_type: null, capability: null, should_use_tool: null,
    dimensions: "{}", evidence_json: JSON.stringify([{ source: "message", id: p1.messages[0].id, quote: p1.messages[0].body.slice(0, 20) }]),
    what_happened: "没有查到改动", expected: "查询后给出提交", root_cause: "没有核对仓库",
    next_attempt_plan: "回放查询", confidence: 0.9, agreement: "agree", status: "open",
    fingerprint: id, created_at: NOW15, ...patch,
  };
  raw.prepare(`INSERT OR REPLACE INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,fingerprint,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.run_id, row.trace_id, row.failure_type,
    row.severity, row.fix_layer, row.gap_type, row.capability, row.should_use_tool, row.dimensions, row.evidence_json,
    row.what_happened, row.expected, row.root_cause, row.next_attempt_plan, row.confidence, row.agreement,
    row.status, row.fingerprint, row.created_at);
  return row;
}
function learningRow(raw, patch = {}) {
  const row = {
    id: "ln-test1", group_id: G, kind: "rule", subkind: "avoid_phrase", params: JSON.stringify({ phrase: "草" }),
    plain: "别再说「草」", requester: SOUV, source_msg_id: cao.ban_message.id, quote: cao.ban_message.body,
    run_id: G + ":2026-11-15", agreement: "single", status: "proposed", ask_count: 0,
    answered_by: null, answer_msg_id: null, applied_ref: null, note: null,
    created_at: NOW15 - 1000, updated_at: NOW15 - 1000, ...patch,
  };
  raw.prepare(`INSERT OR REPLACE INTO review_learnings(id,group_id,kind,subkind,params,plain,requester,source_msg_id,quote,run_id,agreement,status,ask_count,answered_by,answer_msg_id,applied_ref,note,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.group_id, row.kind, row.subkind, row.params,
    row.plain, row.requester, row.source_msg_id, row.quote, row.run_id, row.agreement, row.status, row.ask_count,
    row.answered_by, row.answer_msg_id, row.applied_ref, row.note, row.created_at, row.updated_at);
  return row;
}
function reportRow(raw, items, patch = {}) {
  const row = {
    id: "reflection-report:2026-11-15", group_id: G, date: "2026-11-15", run_id: G + ":2026-11-15",
    mode: "shadow", body: "晨报", items: JSON.stringify(items), state: "queued", reason: null,
    created_at: NOW15, queued_at: null, ...patch,
  };
  raw.prepare(`INSERT OR REPLACE INTO review_reports(id,group_id,date,run_id,mode,body,items,state,reason,created_at,queued_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(row.id, row.group_id, row.date, row.run_id, row.mode, row.body,
    row.items, row.state, row.reason, row.created_at, row.queued_at);
  return row;
}
function scheduleRow(raw, { id, owner = TOO_SENDER, kind = "digest_daily", spec = { time: "08:00", topic: "昨日聊天内容总结" }, status = "active", next = NOW15 + DAY, source = too.request.id, group = G } = {}) {
  const row = { id, group_id: group, owner, kind, tz: "Australia/Sydney", spec: JSON.stringify(spec), status, next_run_at: next, fail_count: 0, created_at: NOW15, source_msg_id: source };
  raw.prepare(`INSERT OR REPLACE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id)
    VALUES(?,?,?,?,?,?,?,?,0,?,?)`).run(row.id, group, owner, kind, row.tz, row.spec, status, next, NOW15, source);
  return row;
}
function seedRule(raw, { id, kind = "avoid_phrase", params = { phrase: "草" }, rule = "不要再说「草」。", status = "canary", group = G, updated = NOW15, expires = NOW15 + 30 * DAY } = {}) {
  raw.prepare(`INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,canary_until,expires_at,hits,corrections,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'[]','member:${SOUV}','${status}',?,?,0,0,?,?)`).run(id, group, rule, "群聊", kind, JSON.stringify(params), NOW15 + 3 * DAY, expires, NOW15, updated);
}

// Build the acceptance bundle once.
await build({
  stdin: {
    contents: `export * from "./src/learning-types";
      export * from "./src/learning-confirm";
      export * from "./src/learning-backfill";
      export * from "./src/review/learnings";
      export * from "./src/review/report";
      export * from "./src/review/publish";
      export * from "./src/review/db";
      export * from "./src/review/rules";
      export { signalsOf } from "./src/review/signals";
      export * from "./src/rules-inject";
      export * from "./src/reply-finalize";
      export * from "./src/schedules";
      export * from "./src/review-report";
      export * from "./src/timing";
      export { metered } from "./src/d1";
      export { agentAnswer } from "./src/semantic";`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: BUILD_PATH.pathname,
  logLevel: "silent",
});
const api = await import(BUILD_PATH.href + `?${Date.now()}`);

// ---- provenance --------------------------------------------------------
test("fixture provenance: every read-only export query wrote zero rows", () => {
  assert.equal(audit.all_rows_written_zero, true);
  assert.equal(audit.all_changes_zero, true);
  for (const query of audit.queries) {
    assert.equal(query.rows_written, 0, query.query);
    assert.equal(query.changes, 0, query.query);
  }
  assert.deepEqual(audit.counts, { messages: 466, outbox: 264, chat_decisions: 133 });
});

test("fixture index hashes match the files on disk", () => {
  for (const [name, hash] of Object.entries(index.files)) assert.equal(sha256(name), hash, name);
  assert.equal(Object.keys(index.files).length, 10);
  assert.ok(index.files["too-daily-request.json"]);
});

test("real rows load into the local DB unchanged", () => {
  const { e, raw } = makeEnv();
  message(raw, too.request);
  message(raw, too.weekly_request);
  message(raw, cao.ban_message);
  for (const row of signals.matches) message(raw, row);
  for (const row of p1.messages) message(raw, row);
  outboxRow(raw, drain.row);
  for (const row of cao.rows) outboxRow(raw, row);
  assert.equal(one(e, "SELECT body FROM messages WHERE id=?", too.request.id).body, too.request.body);
  assert.equal(one(e, "SELECT ts FROM messages WHERE id=?", too.request.id).ts, "2026-11-13T01:11:39+08:00");
  assert.equal(one(e, "SELECT body FROM outbox WHERE id='chat-drain-350'").body, drain.row.body);
  assert.match(one(e, "SELECT body FROM outbox WHERE id='chat-drain-350'").body, /明早 8:00 出第一份日推/);
  assert.equal(rows(e, "SELECT * FROM messages WHERE rowid BETWEEN 428 AND 432").length, 5);
});

test("18 real 草 replies: 10 standalone and 8 protected", () => {
  assert.equal(cao.count, 18);
  assert.equal(cao.standalone_count, 10);
  assert.equal(cao.protected_count, 8);
  assert.equal(cao.rows.filter((row) => row.standalone.length).length, 10);
  assert.equal(cao.rows.filter((row) => row.classification !== "standalone").length, 8);
});

test("7-day real signals: 8 rows and 别再 has zero real hits", () => {
  assert.equal(signals.count, 8);
  assert.deepEqual(signals.zero_hit_keywords, ["别再"]);
  assert.ok(signals.matches.some((row) => row.rid === 134 && row.body === "把你说草的这个口头禅给我改了"));
  assert.ok(signals.matches.some((row) => row.rid === 351 && row.keywords.includes("每天")));
});

test("quiet night is a real zero-message window", () => {
  assert.equal(quiet.count, 0);
  assert.equal(quiet.messages.length, 0);
});

test("L0 report ids and deny list are usable", async () => {
  assert.equal(api.reportOutboxId("2026-11-15", G, 1), "reflection-report:2026-11-15");
  assert.ok(api.REPORT_DENY.includes("trace"));
  const a = await api.learningId(G, "rule", "avoid_phrase", "草");
  const b = await api.learningId(G, "rule", "avoid_phrase", "草");
  assert.equal(a, b);
});

// ---- helpers for report / learnings ------------------------------------
function reportEnv(now = NOW15) {
  const { e, raw } = makeEnv();
  member(raw, TOO_SENDER, "t.o.o.", "admin");
  member(raw, SOUV, "Souvereign");
  const run = runRow(raw, { window_start: new Date(now - 3 * DAY).toISOString(), window_end: new Date(now).toISOString() });
  trace(raw, "tr-in-1", { runId: run.id });
  trace(raw, "tr-in-2", { runId: run.id });
  return { e, raw, run };
}
function rewriteFetch(lines) {
  return installFetch(async (url, init) => {
    const wire = JSON.parse(init.body);
    assert.match(String(url), /api\.deepseek\.com/);
    assert.equal(wire.max_tokens, 400);
    return json({ lines });
  });
}
async function seedCaoLearning(e, raw) {
  const found = api.signalsOf({
    id: "tr-cao", kind: "inbound",
    inbound: { body: cao.ban_message.body, ts: cao.ban_message.ts, mentioned: 1, addressed: "bot" },
    replies: [], decision: null, tools: [], job: null,
  });
  assert.ok(found.includes("S11"), "L3 S11 must hit the real 草 message: " + JSON.stringify(found));
  member(raw, SOUV, "Souvereign");
  message(raw, cao.ban_message);
  for (const row of cao.rows) outboxRow(raw, row);
  const run = runRow(raw, { window_start: new Date(NOW15 - 3 * DAY).toISOString(), window_end: new Date(NOW15).toISOString() });
  judgment(raw, {
    schema: "ta.review.result.v2", verdicts: [], memory_updates: [], promises: [], no_action: [],
    requirements: [{
      kind: "avoid_phrase", params: { phrase: "草" }, rule: "不要再说「草」。", scene: "群聊", ttl_days: 30,
      evidence: [{ source: "message", id: cao.ban_message.id, quote: cao.ban_message.body, origin: "direct" }],
    }],
  }, { runId: run.id });
  const phase = { phase: "learnings" };
  await api.learningsPhase(e, run, phase, NOW15, async (extra) => { if (extra.length) await api.reviewBatch(e, extra); });
  const learning = one(e, "SELECT * FROM review_learnings");
  assert.ok(learning, "L3/L4 must propose the real 草 rule");
  return { run, learning };
}
function reportItems(learningId) {
  return [{ no: 1, learning_id: learningId, applied: false }];
}

// ---- VL-1 .. VL-20 -----------------------------------------------------
test("VL-1 08:40 report delivered once, <=12 lines, no deny words, 10 ticks stay 1", async () => {
  const { e, raw, run } = reportEnv();
  for (const row of p1.messages) message(raw, row);
  outboxRow(raw, p1.outbox[0]);
  finding(raw, "f-p1-1", { runId: run.id });
  const rewrite = rewriteFetch(["没接住那句问仓库改动的话"]);
  try {
    const out = await api.reportPhase(e, run, { phase: "report" }, NOW15, { fetch: rewrite.fetch });
    await api.reviewBatch(e, out.statements);
  } finally { rewrite.restore(); }
  const report = one(e, "SELECT * FROM review_reports");
  assert.equal(report.state, "ready");
  assert.ok(report.body.split("\n").length <= 12);
  for (const word of api.REPORT_DENY) assert.ok(!report.body.toLowerCase().includes(String(word).toLowerCase()), word);
  assert.match(report.body, /我发现/);

  const at = Date.parse("2026-11-15T08:40:00+11:00");
  await api.reviewReportJob.run(e, new Date(at));
  let delivered = await rows(e, "SELECT * FROM outbox WHERE id='reflection-report:2026-11-15'");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].msg_id, null);
  assert.equal(one(e, "SELECT state FROM review_reports").state, "queued");
  for (let i = 0; i < 10; i++) await api.reviewReportJob.run(e, new Date(at + (i + 1) * 60000));
  delivered = await rows(e, "SELECT * FROM outbox WHERE id='reflection-report:2026-11-15'");
  assert.equal(delivered.length, 1, "same-day ticks must not duplicate");
});

test("VL-2 empty night writes skipped(nothing_to_say) and zero outbox", async () => {
  const { e, raw, run } = reportEnv();
  assert.equal(quiet.count, 0);
  const out = await api.reportPhase(e, run, { phase: "report" }, NOW15, { fetch: defaultFetch });
  await api.reviewBatch(e, out.statements);
  const report = one(e, "SELECT * FROM review_reports");
  assert.equal(report.state, "skipped");
  assert.equal(report.reason, "nothing_to_say");
  assert.equal(report.body, "");
  assert.equal(rows(e, "SELECT * FROM outbox").length, 0);
});

test("VL-3 shadow wording says 我发现/我打算记住 and never claims a change", () => {
  const got = api.composeReport({
    date: "2026-11-15", mode: "shadow", dialogues: 5,
    findings: ["回答里漏了提交号"],
    learnings: [{ id: "ln-a", plain: "别再说「草」", requester_name: "Souvereign" }],
    applied: [], promise: null, violation: { phrase: "草", count: 3 },
  });
  assert.match(got.body, /我发现/);
  assert.match(got.body, /我打算记住/);
  for (const word of ["已经改", "已修复", "已经记住"]) assert.ok(!got.body.includes(word), word);
  assert.ok(got.body.split("\n").length <= 12);
  for (const word of api.REPORT_DENY) assert.ok(!got.body.toLowerCase().includes(String(word).toLowerCase()), word);
});

test("VL-4 owner confirms the real 草 rule; non-owner only gets a hint", async () => {
  {
    const { e, raw } = makeEnv();
    const { run, learning } = await seedCaoLearning(e, raw);
    assert.equal(learning.requester, SOUV);
    assert.equal(learning.status, "proposed");
    assert.deepEqual(JSON.parse(learning.params), { phrase: "草" });
    const out = await api.reportPhase(e, run, { phase: "report", learn_mode: "ask" }, NOW15, { fetch: defaultFetch });
    await api.reviewBatch(e, out.statements);
    const report = one(e, "SELECT * FROM review_reports");
    assert.match(report.body, /Souvereign 说别再说「草」/);
    assert.equal(one(e, "SELECT status FROM review_learnings").status, "asked");
    const ok = await api.handleLearningReply(e, {
      groupId: G, messageId: "ans-owner", sender: SOUV, text: "1 可以", mentioned: false,
      replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
    });
    assert.equal(ok, true);
    const rule = one(e, "SELECT * FROM behavior_rules");
    assert.ok(rule);
    assert.equal(rule.status, "canary");
    assert.match(rule.rule, /不要再说「草」/);
    assert.equal(one(e, "SELECT status FROM review_learnings").status, "applied");
    const ack = one(e, "SELECT * FROM outbox WHERE id='learn-ack:ans-owner'");
    assert.ok(ack.body.includes("好，记下了："));
    assert.ok(ack.body.includes("不对就回这条说「不对」"));
  }
  {
    const { e, raw } = makeEnv();
    const { run, learning } = await seedCaoLearning(e, raw);
    const out = await api.reportPhase(e, run, { phase: "report", learn_mode: "ask" }, NOW15, { fetch: defaultFetch });
    await api.reviewBatch(e, out.statements);
    const ok = await api.handleLearningReply(e, {
      groupId: G, messageId: "ans-other", sender: B391, text: "1 可以", mentioned: false,
      replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
    });
    assert.equal(ok, true);
    assert.equal(rows(e, "SELECT * FROM behavior_rules").length, 0);
    assert.equal(one(e, "SELECT status FROM review_learnings WHERE id=?", learning.id).status, "asked");
    assert.match(one(e, "SELECT body FROM outbox WHERE id='learn-ack:ans-other'").body, /本人说一声才算/);
  }
});

test("VL-5 non-owner says 1 不要 -> disputed, no rule", async () => {
  const { e, raw } = makeEnv();
  const { run, learning } = await seedCaoLearning(e, raw);
  const out = await api.reportPhase(e, run, { phase: "report", learn_mode: "ask" }, NOW15, { fetch: defaultFetch });
  await api.reviewBatch(e, out.statements);
  const ok = await api.handleLearningReply(e, {
    groupId: G, messageId: "ans-no", sender: B391, text: "1 不要", mentioned: false,
    replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
  });
  assert.equal(ok, true);
  assert.equal(one(e, "SELECT status FROM review_learnings WHERE id=?", learning.id).status, "disputed");
  assert.equal(rows(e, "SELECT * FROM behavior_rules").length, 0);
  assert.match(one(e, "SELECT body FROM outbox WHERE id='learn-ack:ans-no'").body, /有人觉得不合适/);
});

test("VL-6 rule is injected and all 10 standalone 草 are removed, 8 drafts kept", async () => {
  const { e, raw } = makeEnv();
  seedRule(raw, { id: "rule-cao" });
  const rules = await api.loadGroupRules(e, G, NOW15);
  assert.equal(rules.length, 1);
  const block = api.rulesBlock(rules, [SOUV]);
  assert.match(block.text, /不要再说「草」。/);
  assert.deepEqual(block.avoid, ["草"]);
  let changed = 0, violations = 0;
  const rewritten = [];
  for (const row of cao.rows) {
    const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text: row.body }), {
      avoid: ["草"], onViolation: (phrase, count) => { violations += count; },
    });
    const text = JSON.parse(out).text;
    const shouldChange = row.standalone.length > 0;
    if (text !== row.body) {
      if (shouldChange) changed++;
      else rewritten.push({ rid: row.rid, before: row.body.slice(-90), after: text.slice(-90) });
    }
  }
  assert.equal(changed, 10);
  assert.equal(violations, 0, "a one-character phrase is removed but not counted as a violation");
  assert.deepEqual(rewritten, [], "protected replies rewritten by finalize: " + JSON.stringify(rewritten));
});

test("VL-7 address_as only enters the prompt for that member; member mismatch returns null", async () => {
  const { e, raw } = makeEnv();
  member(raw, B391, "卡特龙");
  seedRule(raw, {
    id: "rule-addr", kind: "address_as", params: { member: B391, name: "马哥" },
    rule: `称呼${B391}为「马哥」。`, status: "active",
  });
  const rules = await api.loadGroupRules(e, G, NOW15);
  assert.ok(api.rulesBlock(rules, [B391]).text.includes(`称呼${B391}为「马哥」。`));
  assert.ok(!api.rulesBlock(rules, [SOUV]).text.includes("马哥"));
  assert.equal(api.renderRule("address_as", { member: SOUV, name: "马哥" }, "", 30, B391), null);

  // real shape: L4 collapses params.member to the original sender, so L6's strict compare passes.
  const ok = learningRow(raw, {
    id: "ln-addr-ok", subkind: "address_as", params: JSON.stringify({ member: B391, name: "马哥" }),
    plain: "以后叫我「马哥」", requester: B391, status: "asked", source_msg_id: address.request.id, quote: address.request.body,
  });
  assert.ok(await api.applyLearning(e, ok, B391));
  // a hand-written mixed prefix would be rejected; this is the only shape that fails.
  const bad = learningRow(raw, {
    id: "ln-addr-bad", subkind: "address_as", params: JSON.stringify({ member: "qq:" + B391, name: "马哥" }),
    plain: "以后叫我「马哥」", requester: B391, status: "asked", source_msg_id: address.request.id, quote: address.request.body,
  });
  assert.equal(await api.applyLearning(e, bad, B391), null);
});

test("VL-8 real 08:00 request -> schedule_create(topic) -> 记下了 -> next-day push", async () => {
  const { e, raw } = makeEnv();
  member(raw, TOO_SENDER, "t.o.o.");
  for (const row of daytime.messages) message(raw, row);
  const context = {
    latest: { id: too.request.id, group_id: G, sender: TOO_SENDER, body: too.request.body, ts: too.request.ts, mentioned: 1, meta: { direct: true, media: [] } },
    batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
  };
  context.batch = [context.latest]; context.recent = [context.latest];
  message(raw, too.request);
  const stub = installFetch(async (url, init) => {
    const wire = JSON.parse(init.body);
    const system = String(wire.messages?.[0]?.content || "");
    if (system.includes("最后的嘴替模块")) return voice("已经登记好了。");
    if (system.includes("只写群里发布的日报正文") || system.includes("你在为群聊写")) return textResponse("1\n2\n3\n4\n5\n6\n7\n8\n9");
    return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "schedule_create", arguments: JSON.stringify({ kind: "digest_daily", time: "08:00", topic: "昨日聊天内容总结" }) } }] }, finish_reason: "stop" }] });
  });
  const realNow = Date.now;
  let answer;
  try {
    Date.now = () => Date.parse("2026-11-13T14:30:00+11:00");
    answer = await api.agentAnswer(e, context);
    Date.now = realNow;
    const created = one(e, "SELECT * FROM schedules");
    const spec = JSON.parse(created.spec);
    assert.equal(spec.time, "08:00");
    assert.equal(spec.topic, "昨日聊天内容总结");
    assert.equal(spec.origin, "chat");
    assert.match(spec.request_quote, /然后悉尼时间每天早上8点/);
    assert.match(spec.dedup, /^rpt-[a-z0-9]{3,6}$/);
    assert.equal(created.next_run_at, Date.parse("2026-11-14T08:00:00+11:00"));
    const parsed = JSON.parse(answer);
    assert.match(parsed.text, /^记下了，每天 08:00（悉尼）发昨日聊天内容总结，第一次是 /);
    assert.match(parsed.text, /记下了/);
    await api.runSchedules(e, Date.parse("2026-11-14T08:00:10+11:00"));
    const pushed = rows(e, "SELECT * FROM outbox");
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].id, `${spec.dedup}:2026-11-14`);
    assert.equal(pushed[0].body.split("\n").length, 5);
  } finally { Date.now = realNow; stub.restore(); }
});

test("VL-9 DST switch keeps 08:00 Sydney at the right UTC instant", () => {
  const spec = { time: "08:00" };
  assert.equal(new Date(api.nextRun(spec, Date.parse("2027-04-03T12:00:00Z"), "Australia/Sydney")).toISOString(), "2027-04-03T22:00:00.000Z");
  assert.equal(new Date(api.nextRun(spec, Date.parse("2027-10-02T12:00:00Z"), "Australia/Sydney")).toISOString(), "2027-10-02T21:00:00.000Z");
});

test("VL-10 reply to the push stops it for the owner; others only get a hint", async () => {
  {
    const { e, raw } = makeEnv();
    const schedule = scheduleRow(raw, { id: "sched-digest_daily-" + too.request.id, spec: { time: "08:00", dedup: "morning-report" } });
    raw.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?,?,?,'ok',?)")
      .run("run-1", schedule.id, NOW15, "morning-report:2026-11-15");
    const ok = await api.handleLearningReply(e, {
      groupId: G, messageId: "stop-1", sender: TOO_SENDER, text: "不用再发了", mentioned: false,
      replyTo: { kind: "bot", targetId: "morning-report:2026-11-15" },
    });
    assert.equal(ok, true);
    assert.equal(one(e, "SELECT status FROM schedules WHERE id=?", schedule.id).status, "cancelled");
    assert.match(one(e, "SELECT body FROM outbox WHERE id='sched-cancel:stop-1'").body, /停了/);
  }
  {
    const { e, raw } = makeEnv();
    const schedule = scheduleRow(raw, { id: "sched-digest_daily-other", spec: { time: "08:00", dedup: "morning-report" } });
    raw.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,status,outbox_id) VALUES(?,?,?,'ok',?)")
      .run("run-2", schedule.id, NOW15, "morning-report:2026-11-15");
    const ok = await api.handleLearningReply(e, {
      groupId: G, messageId: "stop-2", sender: B391, text: "不用再发了", mentioned: false,
      replyTo: { kind: "bot", targetId: "morning-report:2026-11-15" },
    });
    assert.equal(ok, true);
    assert.equal(one(e, "SELECT status FROM schedules WHERE id=?", schedule.id).status, "active");
    assert.match(one(e, "SELECT body FROM outbox WHERE id='sched-cancel:stop-2'").body, /只有建立它的人或管理员/);
  }
});

test("VL-11 不对 on the ack retires the rule / cancels the schedule", async () => {
  {
    const { e, raw } = makeEnv();
    learningRow(raw, { status: "asked", ask_count: 1 });
    reportRow(raw, reportItems("ln-test1"));
    await api.handleLearningReply(e, {
      groupId: G, messageId: "ack-1", sender: SOUV, text: "1 可以", mentioned: false,
      replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
    });
    assert.equal(one(e, "SELECT status FROM behavior_rules").status, "canary");
    await api.handleLearningReply(e, {
      groupId: G, messageId: "undo-1", sender: SOUV, text: "不对", mentioned: false,
      replyTo: { kind: "bot", targetId: "learn-ack:ack-1" },
    });
    assert.equal(one(e, "SELECT status FROM behavior_rules").status, "retired");
    assert.match(one(e, "SELECT body FROM outbox WHERE id='learn-undo:undo-1'").body, /好，撤回了：/);
  }
  {
    const { e, raw } = makeEnv();
    learningRow(raw, {
      kind: "schedule", subkind: "daily", params: JSON.stringify({ time: "08:00", topic: "礼物日早报" }),
      plain: "每天08:00发礼物日早报", status: "asked", ask_count: 1,
    });
    reportRow(raw, reportItems("ln-test1"));
    await api.handleLearningReply(e, {
      groupId: G, messageId: "ack-2", sender: SOUV, text: "1 可以", mentioned: false,
      replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
    });
    assert.equal(one(e, "SELECT status FROM schedules").status, "active");
    await api.handleLearningReply(e, {
      groupId: G, messageId: "undo-2", sender: SOUV, text: "不对", mentioned: false,
      replyTo: { kind: "bot", targetId: "learn-ack:ack-2" },
    });
    assert.equal(one(e, "SELECT status FROM schedules").status, "cancelled");
  }
});

test("VL-12 missed 08:00 is expired, not backfilled; same-day dedup stays one row", async () => {
  {
    const { e, raw } = makeEnv();
    for (const row of daytime.messages) message(raw, row);
    scheduleRow(raw, { id: "sched-expired", spec: { time: "08:00", dedup: "morning-report" }, next: Date.parse("2026-11-14T08:00:00+11:00") });
    const stub = installFetch(async () => { throw Error("expired schedule must not call the model"); });
    try { await api.runSchedules(e, Date.parse("2026-11-14T10:05:00+11:00")); } finally { stub.restore(); }
    const run = one(e, "SELECT * FROM schedule_runs");
    assert.equal(run.status, "skipped");
    assert.equal(run.error, "expired");
    assert.equal(rows(e, "SELECT * FROM outbox").length, 0);
  }
  {
    const { e, raw } = makeEnv();
    for (const row of daytime.messages) message(raw, row);
    scheduleRow(raw, { id: "sched-dedup", spec: { time: "08:00", dedup: "morning-report" }, next: Date.parse("2026-11-14T08:00:00+11:00") });
    const stub = installFetch(async () => voice("1\n2\n3\n4\n5\n6\n7\n8"));
    try {
      await api.runSchedules(e, Date.parse("2026-11-14T08:00:10+11:00"));
      await api.runSchedules(e, Date.parse("2026-11-14T08:01:10+11:00"));
    } finally { stub.restore(); }
    const out = rows(e, "SELECT * FROM outbox");
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "morning-report:2026-11-14");
  }
});

test("VL-13 sixth schedule is invalid_args; the capped run is skipped(cap)", async () => {
  {
    const { e, raw } = makeEnv();
    for (let i = 0; i < 5; i++) {
      await api.createSchedule(e, { group_id: G, owner: TOO_SENDER, kind: "digest_daily", spec: { time: `0${i}:00` }, source_msg_id: "s-" + i }, NOW15);
    }
    const context = {
      latest: { id: "msg-six", group_id: G, sender: TOO_SENDER, body: "再加一个每天10点的日报", ts: new Date(NOW15).toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    message(raw, { id: "msg-six", group_id: G, sender: TOO_SENDER, body: "再加一个每天10点的日报", ts: new Date(NOW15).toISOString(), mentioned: 1 });
    const seen = [];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      seen.push(wire);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice("好的。");
      return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-6", type: "function", function: { name: "schedule_create", arguments: JSON.stringify({ kind: "digest_daily", time: "10:00", topic: "日报" }) } }] }, finish_reason: "stop" }] });
    });
    try {
      await api.agentAnswer(e, context);
      const results = seen.flatMap((body) => body.messages || []).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
      const rejected = results.find((r) => r.error_kind === "invalid_args");
      assert.ok(rejected, "the sixth schedule_create must return invalid_args: " + JSON.stringify(results));
      await assert.rejects(
        api.createSchedule(e, { group_id: G, owner: TOO_SENDER, kind: "digest_daily", spec: { time: "10:00" }, source_msg_id: "s-six" }, NOW15),
        /本群定时已满 5 个/,
      );
      assert.equal(rows(e, "SELECT * FROM schedules").length, 5);
    } finally { stub.restore(); }
  }
  {
    const { e, raw } = makeEnv();
    for (const row of daytime.messages) message(raw, row);
    for (let i = 0; i < 6; i++) {
      raw.prepare("INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'cancelled',NULL,0,?,NULL)")
        .run("old-" + i, G, TOO_SENDER, "reminder", "Australia/Sydney", JSON.stringify({ text: "旧提醒" }), NOW15);
      raw.prepare("INSERT INTO schedule_runs(id,schedule_id,due_at,finished_at,status,outbox_id) VALUES(?,?,?,?,'ok',?)")
        .run("run-old-" + i, "old-" + i, Date.parse("2026-11-14T06:00:00+11:00") + i * 1000, Date.parse("2026-11-14T06:00:00+11:00"), "out-old-" + i);
    }
    scheduleRow(raw, { id: "sched-cap", spec: { time: "08:00" }, next: Date.parse("2026-11-14T08:00:00+11:00") });
    const stub = installFetch(async () => { throw Error("capped run must not call the model"); });
    try { await api.runSchedules(e, Date.parse("2026-11-14T08:00:10+11:00")); } finally { stub.restore(); }
    const run = one(e, "SELECT * FROM schedule_runs WHERE schedule_id='sched-cap'");
    assert.equal(run.status, "skipped");
    assert.equal(run.error, "cap");
    assert.equal(rows(e, "SELECT * FROM outbox").length, 0);
  }
});

test("VL-14 backfill dry-run/apply builds morning-report and the report asks the other two", async () => {
  {
    const dir = mkdtempSync(join(tmpdir(), "teamagent-vl14-"));
    try {
      const dbFile = join(dir, "replay.sqlite");
      const db = new DatabaseSync(dbFile);
      db.exec("CREATE TABLE messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,sender TEXT NOT NULL,body TEXT NOT NULL,ts TEXT NOT NULL,mentioned INTEGER NOT NULL DEFAULT 0)");
      const insert = db.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)");
      for (const row of [...new Map([too.request, too.weekly_request, cao.ban_message, ...signals.matches, ...p1.messages, ...daytime.messages].map((r) => [r.id, r])).values()]) insert.run(row.id, row.group_id, row.sender, row.body, row.ts, row.mentioned ?? 1);
      db.close();
      const out = join(dir, "candidates.json");
      const result = await backfillScan([], { dbPath: dbFile, outPath: out, fetchImpl: async () => { throw Error("no network"); }, log: () => {} });
      assert.equal(result.ok, true);
      const doc = JSON.parse(readFileSync(out, "utf8"));
      assert.ok(doc.candidates.some((c) => c.source_msg_id === too.request.id), "real 04:11 request must be listed");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  const { e, raw } = makeEnv();
  member(raw, TOO_SENDER, "t.o.o.");
  for (const row of [too.request, too.weekly_request, cao.ban_message]) message(raw, row);
  for (const row of daytime.messages) message(raw, row);
  const quote = too.request.body.slice(0, 200);
  const ack = `t.o.o.，你 13 号说的每天早上 8 点推昨日总结，我当时没真建上，现在建好了，明天 08:00 第一份，会写精简。不想要了回那条说「不用再发了」。`;
  const dry = await api.backfillSchedule(e, {
    group_id: G, owner: TOO_SENDER, kind: "digest_daily",
    spec: { time: "08:00", dedup: "morning-report", origin: "backfill", request_quote: quote },
    source_msg_id: too.request.id,
  }, { ack, dry_run: true, now: Date.parse("2026-11-13T09:00:00+11:00") });
  assert.equal(dry.row, null);
  assert.equal(rows(e, "SELECT * FROM schedules").length, 0);
  assert.equal(rows(e, "SELECT * FROM outbox").length, 0);
  const applied = await api.backfillSchedule(e, {
    group_id: G, owner: TOO_SENDER, kind: "digest_daily",
    spec: { time: "08:00", dedup: "morning-report", origin: "backfill", request_quote: quote },
    source_msg_id: too.request.id,
  }, { ack, now: Date.parse("2026-11-13T09:00:00+11:00") });
  assert.ok(applied.row);
  assert.equal(JSON.parse(applied.row.spec).dedup, "morning-report");
  assert.match(JSON.parse(applied.row.spec).request_quote, /精简/);
  assert.equal(rows(e, "SELECT * FROM outbox WHERE id=?", applied.ack_outbox_id).length, 1);
  const stub = installFetch(async () => voice("1\n2\n3\n4\n5\n6\n7\n8\n9"));
  try { await api.runSchedules(e, Date.parse("2026-11-14T08:00:10+11:00")); } finally { stub.restore(); }
  const pushed = one(e, "SELECT * FROM outbox WHERE id='morning-report:2026-11-14'");
  assert.ok(pushed);
  assert.ok(pushed.body.split("\n").length <= 5);

  const weekly = await api.proposeLearning(e, {
    source_msg_id: too.weekly_request.id, kind: "schedule", subkind: "weekly",
    params: { time: "08:00", weekdays: [0], topic: "上周总结" }, plain: "每周日 08:00（悉尼）发上周总结",
  }, Date.parse("2026-11-13T09:00:00+11:00"));
  const phrase = await api.proposeLearning(e, {
    source_msg_id: cao.ban_message.id, kind: "rule", subkind: "avoid_phrase",
    params: { phrase: "草" }, plain: "不要再说「草」。",
  }, Date.parse("2026-11-13T09:00:00+11:00"));
  assert.ok(weekly.learning?.id || weekly.id);
  assert.ok(phrase.learning?.id || phrase.id);
  const run = runRow(raw, { date: "2026-11-14", window_start: new Date(NOW14 - 3 * DAY).toISOString(), window_end: new Date(NOW14).toISOString() });
  const out = await api.reportPhase(e, run, { phase: "report", learn_mode: "ask" }, NOW14, { fetch: defaultFetch });
  await api.reviewBatch(e, out.statements);
  const report = one(e, "SELECT * FROM review_reports WHERE date='2026-11-14'");
  assert.match(report.body, /上周总结/);
  assert.match(report.body, /不要再说「草」/);
});

test("VL-15 a missing 每天 8 点 request is asked next morning; an existing schedule covers it", async () => {
  {
    const { e, raw } = makeEnv();
    member(raw, TOO_SENDER, "t.o.o.");
    message(raw, too.request);
    const run = runRow(raw);
    judgment(raw, { schema: "ta.review.result.v2", verdicts: [], requirements: [], memory_updates: [], promises: [], no_action: [],
      schedule_requests: [{ cadence: "daily", time: "08:00", topic: "昨日聊天内容总结", evidence: [{ source: "message", id: too.request.id, quote: TOO_QUOTE }] }],
    }, { runId: run.id });
    await api.learningsPhase(e, run, { phase: "learnings" }, NOW15, async (extra) => { if (extra.length) await api.reviewBatch(e, extra); });
    const learning = one(e, "SELECT * FROM review_learnings");
    assert.ok(learning);
    assert.equal(learning.kind, "schedule");
    const out = await api.reportPhase(e, run, { phase: "report", learn_mode: "ask" }, NOW15, { fetch: defaultFetch });
    await api.reviewBatch(e, out.statements);
    const report = one(e, "SELECT * FROM review_reports");
    assert.match(report.body, /每天08:00发昨日聊天内容总结/);
  }
  {
    const { e, raw } = makeEnv();
    member(raw, TOO_SENDER, "t.o.o.");
    message(raw, too.request);
    await api.createSchedule(e, { group_id: G, owner: TOO_SENDER, kind: "digest_daily", spec: { time: "08:00" }, source_msg_id: "covered" }, NOW15);
    const run = runRow(raw);
    judgment(raw, { schema: "ta.review.result.v2", verdicts: [], requirements: [], memory_updates: [], promises: [], no_action: [],
      schedule_requests: [{ cadence: "daily", time: "08:05", topic: "昨日聊天内容总结", evidence: [{ source: "message", id: too.request.id, quote: TOO_QUOTE }] }],
    }, { runId: run.id });
    await api.learningsPhase(e, run, { phase: "learnings" }, NOW15, async (extra) => { if (extra.length) await api.reviewBatch(e, extra); });
    assert.equal(rows(e, "SELECT * FROM review_learnings").length, 0);
  }
});

test("VL-16 digest lists ok/late/skipped/failed for yesterday", async () => {
  const { e, raw } = makeEnv();
  scheduleRow(raw, { id: "sched-digest", spec: { time: "08:00", topic: "礼物日早报" }, next: NOW15 + DAY });
  const statuses = ["ok", "late", "skipped", "failed"];
  statuses.forEach((status, index) => {
    raw.prepare(`INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,error,outbox_id)
      VALUES(?,?,?,?,?,?,?,?)`).run("r-" + status, "sched-digest",
      Date.parse("2026-11-14T08:00:00+11:00") + index * 1000, Date.parse("2026-11-14T08:00:05+11:00"),
      Date.parse("2026-11-14T08:00:09+11:00"), status, status === "skipped" ? "cap" : null, status === "ok" ? "morning-report:2026-11-14" : null);
  });
  const digest = await api.renderDigest(e, "2026-11-14");
  assert.equal(digest.schedules.counts.ok, 1);
  assert.equal(digest.schedules.counts.late, 1);
  assert.equal(digest.schedules.counts.skipped, 1);
  assert.equal(digest.schedules.counts.failed, 1);
  assert.deepEqual(digest.schedules.items.map((x) => x.status).sort(), statuses.slice().sort());
});

test("VL-17 the whole replay has zero QQ sends and zero online D1 writes", () => {
  assert.equal(stats.qq_real_sends, 0);
  assert.equal(stats.online_d1_rows_written, 0);
  assert.equal(stats.qq_network_calls, 0);
  assert.equal(stats.cloudflare_network_calls, 0);
  for (const href of network) {
    const host = new URL(href).host;
    assert.ok(allowedHosts.has(host), "unexpected network host: " + href);
  }
  assert.equal(process.env.CLOUDFLARE_API_TOKEN, undefined);
});

test("VL-18 off:review_report, learn:mode=off and off:review_rules all take effect", async () => {
  {
    const { e, raw } = makeEnv();
    reportRow(raw, [], { body: "晨报正文", state: "ready" });
    await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('off:review_report','1')").run();
    await api.reviewReportJob.run(e, new Date(Date.parse("2026-11-15T08:40:00+11:00")));
    assert.equal(one(e, "SELECT state FROM review_reports").state, "skipped");
    assert.equal(one(e, "SELECT reason FROM review_reports").reason, "off");
    assert.equal(rows(e, "SELECT * FROM outbox").length, 0);
  }
  {
    const { e, raw } = makeEnv();
    learningRow(raw, { status: "asked", ask_count: 1 });
    reportRow(raw, reportItems("ln-test1"));
    await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('learn:mode','off')").run();
    const handled = await api.handleLearningReply(e, {
      groupId: G, messageId: "off-1", sender: SOUV, text: "1 可以", mentioned: false,
      replyTo: { kind: "bot", targetId: "reflection-report:2026-11-15" },
    });
    assert.equal(handled, false);
    assert.equal(rows(e, "SELECT * FROM behavior_rules").length, 0);
    assert.equal(one(e, "SELECT status FROM review_learnings").status, "asked");
  }
  {
    const { e, raw } = makeEnv();
    seedRule(raw, { id: "rule-cao" });
    await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES('off:review_rules','1')").run();
    let hits = 0;
    const original = e.DB.prepare.bind(e.DB);
    e.DB.prepare = (sql) => { if (/FROM behavior_rules/.test(sql)) hits++; return original(sql); };
    const context = {
      latest: { id: "msg-off-rules", group_id: G, sender: SOUV, body: "早上好", ts: new Date(NOW15).toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    message(raw, { id: "msg-off-rules", group_id: G, sender: SOUV, body: "早上好", ts: new Date(NOW15).toISOString(), mentioned: 1 });
    const seen = [];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      seen.push(wire);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice("好。");
      return json({ action: "reply", kind: "direct", brief: "好。" });
    });
    try { await api.agentAnswer(e, context); } finally { stub.restore(); }
    const user = String(seen[0].messages.find((m) => m.role === "user").content);
    assert.ok(!user.includes("群里大家提过的要求"));
    assert.equal(hits, 0);
  }
});

test("VL-19 a spoken promise is registered; an unparseable one is rewritten", async () => {
  {
    const { e, raw } = makeEnv();
    member(raw, TOO_SENDER, "t.o.o.");
    message(raw, too.request);
    const context = {
      latest: { id: too.request.id, group_id: G, sender: TOO_SENDER, body: too.request.body, ts: too.request.ts, mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice(drain.row.body);
      return json({ action: "reply", kind: "direct", brief: "答应他持续推。" });
    });
    let answer;
    try { answer = await api.agentAnswer(e, context); } finally { stub.restore(); }
    const created = one(e, "SELECT * FROM schedules");
    assert.ok(created, "promiseGuard must register exactly one schedule");
    assert.equal(JSON.parse(created.spec).time, "08:00");
    assert.equal(created.owner, TOO_SENDER);
    assert.match(JSON.parse(answer).text, /^记下了，每天 08:00（悉尼）发昨日聊天内容总结/);
  }
  {
    const { e, raw } = makeEnv();
    member(raw, B391, "B391");
    const body = "怎么还不回答 你以后去做耗时任务的时候能不能先回答一下";
    message(raw, { id: "msg-unparse", group_id: G, sender: B391, body, ts: new Date(NOW15).toISOString(), mentioned: 1 });
    const context = {
      latest: { id: "msg-unparse", group_id: G, sender: B391, body, ts: new Date(NOW15).toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice("好，每天 8:00 发总结，明早先出一份。");
      return json({ action: "reply", kind: "direct", brief: "好。" });
    });
    let answer;
    try { answer = await api.agentAnswer(e, context); } finally { stub.restore(); }
    assert.equal(JSON.parse(answer).text, "这个我还没登记上，你说一下每天几点、发什么，我马上建。");
    assert.equal(rows(e, "SELECT * FROM schedules").length, 0);
  }
});

test("VL-20 a confirmed canary rule reaches the daytime prompt once; zero rules add nothing", async () => {
  {
    const { e, raw } = makeEnv();
    seedRule(raw, { id: "rule-cao" });
    let hits = 0;
    const original = e.DB.prepare.bind(e.DB);
    e.DB.prepare = (sql) => { if (/FROM behavior_rules/.test(sql)) hits++; return original(sql); };
    const context = {
      latest: { id: "msg-cao", group_id: G, sender: SOUV, body: "今天怎么样", ts: new Date(NOW15).toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    message(raw, { id: "msg-cao", group_id: G, sender: SOUV, body: "今天怎么样", ts: new Date(NOW15).toISOString(), mentioned: 1 });
    const seen = [];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      seen.push(wire);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice("草，这个我后面注意。");
      return json({ action: "reply", kind: "direct", brief: "好。" });
    });
    let answer;
    try { answer = await api.agentAnswer(e, context); } finally { stub.restore(); }
    const user = String(seen[0].messages.find((m) => m.role === "user").content);
    assert.ok(user.includes("群里大家提过的要求（照做）："));
    assert.ok(user.includes("不要再说「草」。"));
    assert.equal(hits, 1, "activeRulesFor is called once per turn");
    assert.ok(!JSON.parse(answer).text.includes("草"), JSON.parse(answer).text);
  }
  {
    const { e, raw } = makeEnv();
    const context = {
      latest: { id: "msg-clean", group_id: G, sender: SOUV, body: "早上好", ts: new Date(NOW15).toISOString(), mentioned: 1, meta: { direct: true, media: [] } },
      batch: [], recent: [], names: new Map(), refs: new Map(), mentioned: true,
    };
    context.batch = [context.latest]; context.recent = [context.latest];
    message(raw, { id: "msg-clean", group_id: G, sender: SOUV, body: "早上好", ts: new Date(NOW15).toISOString(), mentioned: 1 });
    const seen = [];
    const stub = installFetch(async (url, init) => {
      const wire = JSON.parse(init.body);
      seen.push(wire);
      const system = String(wire.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) return voice("好。");
      return json({ action: "reply", kind: "direct", brief: "好。" });
    });
    try { await api.agentAnswer(e, context); } finally { stub.restore(); }
    const user = String(seen[0].messages.find((m) => m.role === "user").content);
    const data = JSON.parse(user);
    assert.ok(!("groupRules" in data), "zero rules must not add a prompt field");
    assert.ok(!("reflection" in data));
    assert.equal(api.rulesBlock([], [SOUV]).text, "");
  }
});

// ---- evidence ----------------------------------------------------------
after(() => {
  stats.finished_at = new Date().toISOString();
  stats.qq_real_sends = 0;
  stats.online_d1_rows_written = 0;
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = [
    `V-D-learning acceptance ${stats.started_at} → ${stats.finished_at}`,
    `network calls: ${stats.network_calls} (qq=${stats.qq_network_calls}, cloudflare=${stats.cloudflare_network_calls})`,
    `QQ 真实发送 0 次、线上 D1 写入 0 行`,
    `recorded model: ${recorded.status}`,
  ].join("\n");
  writeFileSync(new URL(`learning-accept-${stamp}.log`, OUT), log + "\n");
  writeFileSync(new URL("latest.json", OUT), JSON.stringify(stats, null, 2) + "\n");
  writeFileSync(new URL(`learning-accept-${stamp}.json`, OUT), JSON.stringify(stats, null, 2) + "\n");
  console.log(log);
  if (existsSync(BUILD_PATH)) rmSync(BUILD_PATH, { force: true });
  const shell = new URL(`../.wrangler/test-worker-${process.pid}.mjs`, import.meta.url);
  if (existsSync(shell)) rmSync(shell, { force: true });
  rmSync(new URL("../.wrangler/accept-entry.ts", import.meta.url), { force: true });
  rmSync(new URL("../.wrangler/accept-api.mjs", import.meta.url), { force: true });
});
