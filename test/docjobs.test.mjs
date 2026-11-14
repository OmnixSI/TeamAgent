import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

async function module(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const doc = await module("src/docjobs.ts");
const toolkit = await module("src/toolkit.ts");
const tool = toolkit.findExtraTool("read_document");

function env() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  const DB = {
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) { return statement(values); },
        async first() { return raw.prepare(sql).get(...args) || null; },
        async all() { return { results: raw.prepare(sql).all(...args) }; },
        async run() { return raw.prepare(sql).run(...args); },
      });
      return statement();
    },
    async batch(statements) { return Promise.all(statements.map(s => s.all ? s.all() : s.run())); },
  };
  return { DB, raw };
}

function seed(e, { id = "m1", group = "GROUP1", attachments = [{ url: "https://multimedia.nt.qq.com.cn/download?fileid=1", filename: "report.pdf", content_type: "application/pdf", size: 2048 }] } = {}) {
  e.raw.prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?,0)")
    .run(id, group, "member-1", "看下这份文件", "2026-11-14T00:00:00Z", 1);
  e.raw.prepare("INSERT OR REPLACE INTO message_meta VALUES(?,?)")
    .run(id, JSON.stringify({ attachments }));
  e.raw.prepare("INSERT OR IGNORE INTO settings VALUES('docread:enabled','1')").run();
}
const ctx = () => ({ context: { latest: { id: "m1", group_id: "GROUP1" } }, source: { id: "m1", group_id: "GROUP1" }, messages: [], isTainted: () => false });
const note = (e, key) => e.raw.prepare("SELECT body,created_at FROM media_notes WHERE id=?").get(key);
const jobRow = (e, id) => e.raw.prepare("SELECT * FROM jobs WHERE id=?").get(id);

const parsed = {
  ok: true, kind: "pdf", filename: "report.pdf", bytes: 2048,
  text: "===== 第 3 页 =====\n本页合计金额：12,345.67 元", pages: [{ page: 3, chars: 21 }],
  sheets: [], meta: {}, warnings: [], hits: [{ page: 3, label: "第 3 页", text: "本页合计金额：12,345.67 元" }],
  truncated: false,
};

test("tool queues a docread job that one runner claims under a lease", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "第3页的金额" }, ctx());
  assert.equal(first.error_kind, "pending");
  const claimed = await doc.claimDoc(e);
  assert.ok(claimed, "a pending docread job must be claimable");
  assert.equal(claimed.kind, "docread");
  assert.equal(claimed.status, "running");
  assert.match(claimed.payload.lease, /^[0-9a-f-]{36}$/);
  assert.equal(claimed.payload.filename, "report.pdf");
  assert.equal(claimed.payload.question, "第3页的金额");
  assert.equal(await doc.claimDoc(e), null, "an active lease must not be claimed twice");
  assert.equal(jobRow(e, first.job_id).status, "running");
});

test("heartbeat renews a live docread lease and refuses a stale one", async () => {
  const e = env(); seed(e);
  await tool.run(e, { question: "金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const claimedAt = jobRow(e, claimed.id).lease_until - 180000;
  assert.equal(await doc.heartbeatDoc(e, claimed.id, claimed.payload.lease, claimedAt), true);
  assert.equal(jobRow(e, claimed.id).lease_until, claimedAt + 180000);
  assert.equal(await doc.heartbeatDoc(e, claimed.id, "00000000-0000-4000-8000-000000000000", claimedAt), false);
});

test("a reported extraction is stored once and the second tool call returns the text", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "第3页的金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const report = { id: claimed.id, lease: claimed.payload.lease, success: true, result: parsed };
  assert.equal((await doc.reportDoc(e, report)).status, 200);
  const row = jobRow(e, first.job_id);
  assert.equal(row.status, "done");
  assert.equal(row.error, null);
  const stored = note(e, claimed.payload.key);
  assert.ok(stored, "the extraction must land under the tool's media_notes key");
  assert.equal(JSON.parse(stored.body).kind, "pdf");

  const second = await tool.run(e, { question: "第3页的金额" }, ctx());
  assert.equal(second.ok, true);
  assert.equal(second.source, "docread");
  assert.match(second.text, /12,345\.67/);
  assert.equal(second.hits[0].page, 3);
});

test("a repeated report is idempotent and a stale lease cannot overwrite evidence", async () => {
  const e = env(); seed(e);
  await tool.run(e, { question: "金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const ok = { id: claimed.id, lease: claimed.payload.lease, success: true, result: parsed };
  assert.equal((await doc.reportDoc(e, ok)).status, 200);
  assert.equal((await doc.reportDoc(e, ok)).status, 200);
  const stale = { ...ok, lease: "00000000-0000-4000-8000-000000000000" };
  assert.equal((await doc.reportDoc(e, stale)).status, 409);
  assert.match(JSON.parse(note(e, claimed.payload.key).body).text, /12,345\.67/);
});

const payloadOf = (e, id) => JSON.parse(jobRow(e, id).payload);

test("a parser failure is not cached and the same question retries after the cooldown", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const failed = { ok: false, error_kind: "missing_library", error: "缺 pypdf，无法读 PDF", retryable: false };
  assert.equal((await doc.reportDoc(e, { id: claimed.id, lease: claimed.payload.lease, success: true, result: failed })).status, 200);
  assert.equal(jobRow(e, first.job_id).status, "failed");
  assert.equal(jobRow(e, first.job_id).error, "missing_library");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM media_notes").get().n, 0, "a failure is not content");
  assert.ok(payloadOf(e, first.job_id).failed_at > 0);

  const second = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(second.ok, false);
  assert.equal(second.error_kind, "missing_library");
  assert.match(second.next_action, /10|分钟|不要猜/);
  assert.equal(jobRow(e, first.job_id).status, "failed", "an immediate retry must not requeue");

  // Simulate the 10-minute cooldown passing, then the library getting fixed.
  e.raw.prepare("UPDATE jobs SET payload=json_set(payload,'$.failed_at',?) WHERE id=?")
    .run(Date.now() - 11 * 60 * 1000, first.job_id);
  const retry = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(retry.error_kind, "pending");
  assert.equal(jobRow(e, first.job_id).status, "pending");
  assert.equal(jobRow(e, first.job_id).attempts, 0);
  const again = await doc.claimDoc(e);
  assert.ok(again, "the retried job must be claimable again");
  assert.equal((await doc.reportDoc(e, { id: again.id, lease: again.payload.lease, success: true, result: parsed })).status, 200);
  const done = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(done.ok, true);
  assert.match(done.text, /12,345\.67/);
});

test("a scanned PDF is recorded as no_text, not cached as a fake read", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "第1页写了什么" }, ctx());
  const claimed = await doc.claimDoc(e);
  const scanned = {
    ...parsed, text: "===== 第 1 页 =====\n(空)", pages: [{ page: 1, chars: 0 }], hits: [],
    warnings: ["没有可提取的文字层，可能是扫描件；需要渲染成图片交给视觉模型"],
  };
  assert.equal((await doc.reportDoc(e, { id: claimed.id, lease: claimed.payload.lease, success: true, result: scanned })).status, 200);
  assert.equal(jobRow(e, first.job_id).status, "failed");
  assert.equal(jobRow(e, first.job_id).error, "no_text");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM media_notes").get().n, 0);
  const second = await tool.run(e, { question: "第1页写了什么" }, ctx());
  assert.equal(second.ok, false);
  assert.equal(second.error_kind, "no_text");
  assert.match(second.next_action, /扫描件|OCR|10|分钟/);
  assert.doesNotMatch(JSON.stringify(second), /\(空\)/);
});

test("a job whose runner lease expired is requeued instead of looking permanently pending", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "金额" }, ctx());
  e.raw.prepare("UPDATE jobs SET status='failed',error='expired',lease_until=0 WHERE id=?").run(first.job_id);
  const out = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "pending");
  assert.equal(out.job_id, first.job_id);
  const row = e.raw.prepare("SELECT status,attempts,error FROM jobs WHERE id=?").get(first.job_id);
  assert.deepEqual({ ...row }, { status: "pending", attempts: 0, error: null });
});

test("with the switch off nothing is claimed or queued", async () => {
  const e = env();
  e.raw.prepare("DELETE FROM settings WHERE key='docread:enabled'").run();
  seed(e);
  e.raw.prepare("DELETE FROM settings WHERE key='docread:enabled'").run();
  const out = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(out.error_kind, "unavailable");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
  assert.equal(await doc.claimDoc(e), null);
});

test("a runner download failure is recorded and surfaced, never left running", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const report = { id: claimed.id, lease: claimed.payload.lease, success: false, reason: "download_failed" };
  assert.equal((await doc.reportDoc(e, report)).status, 200);
  assert.equal(jobRow(e, first.job_id).status, "failed");
  assert.equal(jobRow(e, first.job_id).error, "download_failed");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM media_notes").get().n, 0);
  assert.equal((await doc.reportDoc(e, report)).status, 200, "a repeated failure report is idempotent");
  assert.equal((await doc.reportDoc(e, { ...report, lease: "00000000-0000-4000-8000-000000000000" })).status, 409);
  const second = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(second.ok, false);
  assert.equal(second.error_kind, "download_failed");
  assert.match(second.next_action, /稍后|重发|不要猜/);
});

test("a done job whose extraction is missing is requeued instead of pending forever", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "金额" }, ctx());
  e.raw.prepare("UPDATE jobs SET status='done',error=NULL WHERE id=?").run(first.job_id);
  const out = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(out.error_kind, "pending");
  const row = jobRow(e, first.job_id);
  assert.equal(row.status, "pending");
  assert.equal(row.attempts, 0);
});

test("a failed question stops requeueing after three retries", async () => {
  const e = env(); seed(e);
  const first = await tool.run(e, { question: "金额" }, ctx());
  const claimed = await doc.claimDoc(e);
  const failed = { id: claimed.id, lease: claimed.payload.lease, success: false, reason: "download_failed" };
  assert.equal((await doc.reportDoc(e, failed)).status, 200);
  e.raw.prepare("UPDATE jobs SET payload=json_set(json_set(payload,'$.failed_at',?),'$.retries',3) WHERE id=?")
    .run(Date.now() - 11 * 60 * 1000, first.job_id);
  const out = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "download_failed");
  assert.equal(out.retryable, false);
  assert.match(out.next_action, /重新发/);
  assert.equal(jobRow(e, first.job_id).status, "failed");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 1);
});
