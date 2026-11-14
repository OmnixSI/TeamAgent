// B-l9 acceptance skeleton: real-data replay on a local-only SQLite database,
// every outbound network call mocked and counted.  No production D1 write and
// no QQ send is possible from this file: fetch is replaced before any test and
// the process runs without Cloudflare credentials.
//
// Run: node --test test/learning-accept.mjs
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";

const FIX = new URL("../replay/fixtures/", import.meta.url);
const OUT = new URL("../replay/out/", import.meta.url);
const DB_PATH = new URL(`../.wrangler/learning-accept-${process.pid}.sqlite`, import.meta.url);
const BUILD_PATH = new URL(`../.wrangler/learning-accept-${process.pid}.mjs`, import.meta.url);

const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIX), "utf8"));
const sha256 = (name) => createHash("sha256").update(readFileSync(new URL(name, FIX))).digest("hex");

// The replay must not be able to reach Cloudflare even by accident.
for (const key of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_KEY", "CF_API_TOKEN"]) delete process.env[key];

const network = [];
globalThis.fetch = async (url) => {
  network.push(String(url));
  throw new Error("replay network disabled: " + url);
};

const stats = {
  started_at: new Date().toISOString(),
  qq_real_sends: 0,
  online_d1_rows_written: 0,
  network_calls: 0,
  skipped_stages: 0,
  fixture_rows: {},
};

let skipped = 0;
function skipStage(name) {
  skipped++;
  test.skip(name, () => {});
}

// ---- local-only database -------------------------------------------------
if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
mkdirSync(new URL("../.wrangler/", import.meta.url), { recursive: true });
mkdirSync(new URL("../replay/out/", import.meta.url), { recursive: true });
const db = new DatabaseSync(DB_PATH.pathname);
db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));

function insertMessages(rows) {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO messages(rowid,id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (const row of rows) stmt.run(row.rid, row.id, row.group_id, row.sender, row.body, row.ts, row.mentioned ?? 0, row.processed ?? 1);
}
function insertOutbox(rows) {
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO outbox(rowid,id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?,?)",
  );
  for (const row of rows) stmt.run(row.rid, row.id, row.group_id, row.msg_id ?? null, row.body, row.status ?? "sent", row.created_at);
}

const too = fixture("too-daily-request.json");
const signals = fixture("learning-signals-7d.json");
const cao = fixture("outbox-cao-18.json");
const p1 = fixture("review-p1-case.json");
const quiet = fixture("quiet-night.json");
const daytime = fixture("daytime-batch.json");
const drain = fixture("chat-drain-350.json");
const audit = fixture("export-audit.json");
const recorded = fixture("deepseek-recorded.json");
const index = fixture("index.json");

insertMessages([too.request, too.weekly_request, cao.ban_message, ...signals.matches, ...p1.messages, ...daytime.messages]);
insertOutbox([...too.bot_replies, ...cao.rows, ...p1.outbox, ...daytime.outbox_context, drain.row]);

const localCounts = {
  messages: db.prepare("SELECT COUNT(*) AS n FROM messages").get().n,
  outbox: db.prepare("SELECT COUNT(*) AS n FROM outbox").get().n,
};
stats.fixture_rows = localCounts;

// ---- L0 frozen interfaces (already available on pkg/B-l0) ----------------
await build({
  stdin: { contents: 'export * from "./src/learning-types";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: BUILD_PATH.pathname,
  logLevel: "silent",
});
const learning = await import(BUILD_PATH.href + `?${Date.now()}`);

// ---- tests that can run before L1–L8 ------------------------------------
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
  for (const [name, hash] of Object.entries(index.files)) {
    assert.equal(sha256(name), hash, name);
  }
  assert.ok(index.files["too-daily-request.json"]);
  assert.ok(index.files["outbox-cao-18.json"]);
});

test("real TOO request, weekly request and chat-drain-350 load into the local DB", () => {
  const request = db.prepare("SELECT * FROM messages WHERE id=?").get(too.request.id);
  assert.ok(request);
  assert.equal(request.body, "然后悉尼时间每天早上8点在群里推送一下昨日聊天内容总结，一定要精简。<@204AE67DE34A4448CEE8EA52208A2BB0>");
  assert.equal(request.ts, "2026-11-13T01:11:39+08:00");
  assert.equal(request.mentioned, 1);

  const weekly = db.prepare("SELECT * FROM messages WHERE id=?").get(too.weekly_request.id);
  assert.equal(weekly.body, "按周吧，每个星期日是一周的开始<@204AE67DE34A4448CEE8EA52208A2BB0>");

  const reply = db.prepare("SELECT * FROM outbox WHERE id='chat-drain-350'").get();
  assert.ok(reply);
  assert.equal(reply.body, drain.row.body);
  assert.match(reply.body, /明早 8:00 出第一份日推/);
  assert.equal(reply.created_at, 1794503523753);

  const later = db.prepare("SELECT * FROM outbox WHERE id=?").get("chat-drain-357");
  assert.match(later.body, /定时推送这次真落地/);
});

test("18 real 草 replies: 10 standalone and 8 protected draft/quote", () => {
  assert.equal(cao.count, 18);
  assert.equal(cao.standalone_count, 10);
  assert.equal(cao.protected_count, 8);
  const rows = db.prepare("SELECT id, body FROM outbox WHERE body LIKE '%草%' ORDER BY created_at").all();
  assert.equal(rows.length, 18);
  const scratch = /(^|[，。！？!?,；;：:\s])草[！!。.~～…，,]*(?=$|[，。！？!?,；;：:\s])/;
  let standalone = 0;
  for (const row of rows) {
    const match = [...row.body.matchAll(new RegExp(scratch.source, "g"))];
    if (match.length) standalone++;
  }
  assert.equal(standalone, 10);
  const draft = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE body LIKE '%草稿%' OR body LIKE '%草案%'").get().n;
  assert.ok(draft >= 6);
});

test("7-day real signal messages: 8 rows, 别再 has zero real hits", () => {
  assert.equal(signals.count, 8);
  assert.deepEqual(signals.zero_hit_keywords, ["别再"]);
  assert.equal(signals.matches.length, 8);
  for (const row of signals.matches) {
    const hits = signals.keywords.filter((word) => row.body.includes(word));
    assert.deepEqual(row.keywords, hits);
    const loaded = db.prepare("SELECT body FROM messages WHERE id=?").get(row.id);
    assert.equal(loaded.body, row.body);
  }
  assert.ok(signals.matches.some((row) => row.rid === 134 && row.body === "把你说草的这个口头禅给我改了"));
  assert.ok(signals.matches.some((row) => row.rid === 351 && row.keywords.includes("每天")));
});

test("quiet night is a real zero-message window and p1 case is real", () => {
  assert.equal(quiet.count, 0);
  assert.equal(quiet.messages.length, 0);
  assert.equal(p1.messages.length, 5);
  assert.deepEqual(p1.messages.map((row) => row.rid), [428, 429, 430, 431, 432]);
  assert.equal(p1.outbox[0].rid, 239);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE rowid BETWEEN 428 AND 432").get().n, 5);
});

test("local DB is the only store; outbound network is zero", () => {
  assert.equal(network.length, 0);
  assert.equal(stats.qq_real_sends, 0);
  assert.equal(stats.online_d1_rows_written, 0);
  assert.equal(localCounts.messages > 0, true);
  assert.equal(localCounts.outbox > 0, true);
  assert.equal(existsSync(DB_PATH), true);
});

test("L0 report ids and deny list are usable by L4/L5", async () => {
  assert.equal(learning.reportOutboxId("2026-11-15", "GROUP000001", 1), "reflection-report:2026-11-15");
  assert.equal(learning.reportOutboxId("2026-11-15", "GROUP000001", 2), "reflection-report:2026-11-15:GROUP000");
  assert.ok(learning.REPORT_DENY.includes("trace"));
  assert.ok(learning.REPORT_DENY.includes("模型"));
  const a = await learning.learningId("g", "rule", "avoid_phrase", "草");
  const b = await learning.learningId("g", "rule", "avoid_phrase", "草");
  const c = await learning.learningId("g", "rule", "avoid_phrase", "草稿");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

// ---- stages that wait for L1–L8 -----------------------------------------
skipStage("[depends L4+L5] VL-1 晨报 08:40 入 outbox 1 条且同日重跑不重复");
skipStage("[depends L4] VL-2 无素材时 review_reports skipped(nothing_to_say)");
skipStage("[depends L4] VL-3 shadow 措辞不含「已经改/已修复/已经记住」");
skipStage("[depends L3+L4+L6] VL-4 本人回「1 可以」写入 canary 规则，非本人只提示");
skipStage("[depends L6] VL-5 非本人回「1 不要」→ disputed，不写规则");
skipStage("[depends L2+L7] VL-6 18 条真实含草回复过 finalize：10 条单独成句删除，8 条草稿/引用不动");
skipStage("[depends L3+L6+L7] VL-7 address_as 只在该成员出现时进入 prompt，member≠发送者 renderRule null");
skipStage("[depends L1+L2] VL-8 TOO 08:00 原话 → schedule_create(topic) → 回执含「记下了」");
skipStage("[depends L1] VL-9 2027-04-04 / 2027-10-03 夏令时切换的 nextRun 正确");
skipStage("[depends L6] VL-10 回复推送「不用再发了」→ 日程 owner 取消，非 owner 只提示");
skipStage("[depends L6] VL-11 回复 learn-ack「不对」→ 规则 retired / 日程 cancelled");
skipStage("[depends L1+L5] VL-12 停机 2 小时不补发，同日 dedup 重跑 0 新增");
skipStage("[depends L1] VL-13 第 6 个定时 invalid_args，第 7 条到点 skipped(cap)");
skipStage("[depends L8+L1] VL-14 daily-push-real 回填 dry-run/apply，08:00 出 morning-report 1 条");
skipStage("[depends L3+L4] VL-15 漏记的「每天发 XX」次日晨报 asks 段补问，covered 不问");
skipStage("[depends L4] VL-16 renderDigest.schedules 列出昨日 ok/late/skipped/failed");
skipStage("[depends L9 全流程] VL-17 全程 QQ 真实发送 0、线上 D1 写入 0（当前夹具阶段已断言 0，全流程跑通后启用）");
skipStage("[depends L5+L6+L7] VL-18 off:review_report / learn:mode=off / off:review_rules 三个开关");
skipStage("[depends L2] VL-19 promiseGuard 把 chat-drain-350 的口头承诺补建成 08:00 日程");
skipStage("[depends L7] VL-20 canary 规则进入聊天 prompt；0 条规则时与 41db2b5 逐字相同");
skipStage("[pending recording] VL-4/L4 真实 DeepSeek 录制响应（deepseek-recorded.json status=pending）");

// ---- evidence ------------------------------------------------------------
after(() => {
  stats.network_calls = network.length;
  stats.skipped_stages = skipped;
  stats.finished_at = new Date().toISOString();
  stats.qq_real_sends = 0;
  stats.online_d1_rows_written = 0;
  stats.fixture_files = Object.keys(index.files);
  stats.recorded_model_status = recorded.status;
  mkdirSync(OUT, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const log = [
    `B-l9 acceptance skeleton ${stats.started_at} → ${stats.finished_at}`,
    `fixtures: messages=${localCounts.messages} outbox=${localCounts.outbox} signals=${signals.count} cao=${cao.count}`,
    `stages skipped: ${skipped}`,
    `network calls: ${network.length}`,
    `QQ 真实发送 0 次、线上 D1 写入 0 行`,
    `recorded model: ${recorded.status}`,
  ].join("\n");
  writeFileSync(new URL(`learning-accept-${stamp}.log`, OUT), log + "\n");
  writeFileSync(new URL("latest.json", OUT), JSON.stringify(stats, null, 2) + "\n");
  writeFileSync(new URL(`learning-accept-${stamp}.json`, OUT), JSON.stringify(stats, null, 2) + "\n");
  console.log(log);
  if (existsSync(DB_PATH)) unlinkSync(DB_PATH);
  if (existsSync(BUILD_PATH)) unlinkSync(BUILD_PATH);
});
