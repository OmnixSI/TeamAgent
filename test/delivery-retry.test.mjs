import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { env, req } from "./support.mjs";
import { deliverFiles, nextRetryAt, RETRY_WINDOW_MS, RETRY_DEADLINE_MS } from "../runner/delivery.mjs";

const out = `.wrangler/delivery-retry-${process.pid}.mjs`;
await build({
  stdin: { contents: 'export * from "./src/delivery-retry";', resolveDir: process.cwd(), loader: "ts" },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: out,
});
const policy = await import("../" + out);

const GROUP = "GROUP000001";
// Verbatim production shapes (read-only export, 2026-11-11 16:37-16:40).
const MSG34 = {
  id: "ROBOT1.0_msg34",
  body: "接入验收小活：请把这些示例数据整理成 UTF-8 CSV 文件发回群里，不改任何仓库：大肥鱼，进行中，3；面试软件，待验收，2；陪玩店，待整理，1。列名：项目、状态、任务数。",
  ts: "2026-11-11T16:37:34+08:00",
};
const OUTBOX19 = "任务已完成，表格文件已生成。\n\n**做了什么**\n- 在当前工作目录的 `outputs/` 下创建了 CSV 文件。\n已生成文件（发送结果以群内附件为准）：项目状态示例数据.csv";

function memoryDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(fs.readFileSync("schema.sql", "utf8"));
  const database = {
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) { return statement(values); },
        async first() { return d.prepare(sql).get(...args) || null; },
        async all() { return { results: d.prepare(sql).all(...args) }; },
        async run() { return d.prepare(sql).run(...args); },
      });
      return statement();
    },
    async batch(ss) {
      return Promise.all(ss.map((s) => (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run())));
    },
  };
  return database;
}

function deliveryEnv() {
  const e = { DB: memoryDb() };
  return e;
}

async function seedDelivery(e) {
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,0,1)",
  ).bind(MSG34.id, GROUP, "owner", MSG34.body, MSG34.ts).run();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(
    "file-1",
    "media",
    JSON.stringify({ message: MSG34.id, title: "项目状态示例数据 CSV", want_files: true }),
    "done",
    1,
    0,
    Date.now(),
  ).run();
  await e.DB.prepare(
    "INSERT INTO deliveries VALUES(?,?,?,'pending',?,0,?)",
  ).bind("delivery-file-1", "file-1", MSG34.id, JSON.stringify([{ name: "项目状态示例数据.csv", bytes: 100 }]), new Date().toISOString()).run();
}

function runnerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-delivery-retry-"));
  const root = path.join(dir, "utility");
  const outputs = path.join(root, "_deliveries", "b".repeat(32), "outputs");
  const queue = path.join(dir, "deliveries");
  fs.mkdirSync(outputs, { recursive: true });
  fs.mkdirSync(queue);
  const file = path.join(outputs, "项目状态示例数据.csv");
  fs.writeFileSync(file, "项目,状态,任务数\n大肥鱼,进行中,3\n");
  const manifest = path.join(queue, "one.json");
  fs.writeFileSync(manifest, JSON.stringify({ id: "delivery-file-1", message: MSG34.id, created_at: 1_764_000_000_000, files: [file] }));
  return {
    dir, root, queue, manifest, file,
    clean() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test("transient delivery failure waits 1 minute, then 5 minutes, before the third attempt", async () => {
  const f = runnerFixture();
  const base = 1_764_000_000_000;
  let targets = 0;
  const reports = [];
  const options = {
    dir: f.queue,
    root: f.root,
    target: async () => { targets++; throw Error("no target"); },
    sendFile: async () => assert.fail("no file may be sent"),
    report: async (receipt) => reports.push(receipt),
    now: base,
  };
  try {
    await deliverFiles(options);
    assert.equal(targets, 1);
    let receipt = JSON.parse(fs.readFileSync(f.manifest + ".failed"));
    assert.equal(receipt.attempts, 1);
    assert.equal(receipt.next_attempt, base + 60_000);

    await deliverFiles({ ...options, now: base + 59_999 });
    assert.equal(targets, 1, "must not retry before the one-minute backoff");
    await deliverFiles({ ...options, now: base + 60_000 });
    assert.equal(targets, 2);
    receipt = JSON.parse(fs.readFileSync(f.manifest + ".failed"));
    assert.equal(receipt.next_attempt, base + 60_000 + 300_000);

    await deliverFiles({ ...options, now: base + 359_999 });
    assert.equal(targets, 2, "must not retry before the five-minute backoff");
    await deliverFiles({ ...options, now: base + 360_000 });
    assert.equal(targets, 3);
    assert.equal(reports.length, 3, "two retry receipts plus one terminal receipt");
    const terminal = reports.at(-1);
    assert.equal(terminal.status, "failed");
    assert.equal(terminal.exhausted, true);
    assert.equal(terminal.attempts, 3);
    assert.equal(terminal.error, "target_unavailable");
    assert.equal(reports[0].exhausted, false);

    await deliverFiles({ ...options, now: base + 3_600_000 });
    assert.equal(targets, 3, "exhausted delivery is never retried");
    assert.deepEqual(fs.readdirSync(f.queue), []);
  } finally {
    f.clean();
  }
});

test("a retried failure that succeeds sends the file once and clears its stage", async () => {
  const f = runnerFixture();
  const base = 1_764_000_000_000;
  let targets = 0, sends = 0;
  const reports = [];
  const options = {
    dir: f.queue,
    root: f.root,
    target: async () => { if (++targets === 1) throw Error("gateway down"); return { group_id: GROUP }; },
    sendFile: async () => { sends++; },
    report: async (receipt) => reports.push(receipt),
    now: base,
  };
  try {
    await deliverFiles(options);
    assert.equal(sends, 0);
    assert.equal(reports.length, 1, "the first safe failure is recorded as a retry");
    assert.equal(reports[0].status, "failed");
    assert.equal(reports[0].exhausted, false);
    assert.equal(reports[0].attempts, 1);
    assert.equal(reports[0].next_attempt, base + 60_000);
    await deliverFiles({ ...options, now: base + 60_000 });
    assert.equal(sends, 1);
    assert.equal(reports.length, 2);
    assert.equal(reports[1].status, "sent");
    assert.equal(reports[1].attempts, 2);
    assert.deepEqual(fs.readdirSync(f.queue), []);
    assert.deepEqual(fs.readdirSync(f.root), []);
  } finally {
    f.clean();
  }
});

test("a safe failure stops retrying once it is older than fifteen minutes", async () => {
  const f = runnerFixture();
  const base = 1_764_000_000_000;
  let targets = 0;
  const reports = [];
  const options = {
    dir: f.queue,
    root: f.root,
    target: async () => { targets++; throw Error("no target"); },
    sendFile: async () => assert.fail("no file may be sent"),
    report: async (receipt) => reports.push(receipt),
    now: base,
  };
  try {
    await deliverFiles(options);
    assert.equal(targets, 1);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].exhausted, false);
    assert.equal(reports[0].retry_deadline, base + RETRY_DEADLINE_MS);
    await deliverFiles({ ...options, now: base + RETRY_WINDOW_MS + 1 });
    assert.equal(targets, 1, "must not retry a delivery older than the retry window");
    assert.equal(reports.length, 2);
    assert.equal(reports[1].status, "failed");
    assert.equal(reports[1].exhausted, true);
    assert.equal(reports[1].error, "expired");
    assert.deepEqual(fs.readdirSync(f.queue), []);
  } finally {
    f.clean();
  }
});

test("retry waits are bounded by both the count and the one-hour deadline", () => {
  const base = 1_764_000_000_000;
  assert.equal(RETRY_DEADLINE_MS, 60 * 60 * 1000);
  assert.equal(RETRY_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(nextRetryAt(base, 1, base), base + 60_000);
  assert.equal(nextRetryAt(base, 2, base + 60_000), base + 360_000);
  assert.equal(nextRetryAt(base, 1, base + 14 * 60_000), base + 15 * 60_000, "the boundary is allowed");
  assert.equal(nextRetryAt(base, 1, base + 14 * 60_000 + 1), null, "a one-minute wait would cross fifteen minutes");
  assert.equal(nextRetryAt(base, 3, base), null, "three attempts is the absolute count bound");
});

test("failure reason codes name a cause and the next step without host paths", () => {
  assert.deepEqual(policy.DELIVERY_RETRY_DELAYS_MS, [60_000, 300_000]);
  assert.match(policy.deliveryFailureReason("target_unavailable"), /QQ|云端/);
  assert.match(policy.deliveryFailureReason("file_denied"), /文件/);
  assert.match(policy.deliveryFailureReason("anything-else"), /发送失败/);
  assert.match(policy.deliveryFailureReason("/Users/owner/private/secret.txt"), /发送失败/);
  assert.doesNotMatch(policy.deliveryFailureReason("/Users/owner/private/secret.txt"), /\/Users\//);
  const text = policy.deliveryAttentionText({ title: "项目状态示例数据 CSV", attempts: 3, error: "target_unavailable" });
  assert.match(text, /没发出去/);
  assert.match(text, /3 次/);
  assert.match(text, /QQ|云端/);
  assert.match(text, /重新交办|需要核对/);
});

test("a zero-file result never claims a file was generated", () => {
  const missing = policy.utilityStatusText({ files: 0, wantFiles: true });
  assert.doesNotMatch(missing, /已生成|生成好|文件已发送/);
  assert.match(missing, /没有生成任何文件/);
  assert.match(missing, /不要声称/);
  const plain = policy.utilityStatusText({ files: 0, wantFiles: false });
  assert.doesNotMatch(plain, /已生成/);
  const present = policy.utilityStatusText({ files: 2, wantFiles: true });
  assert.match(present, /2 个文件/);
  assert.match(present, /交付状态/);
  const evidence = "任务已完成，表格文件已生成。\n已生成文件（发送结果以群内附件为准）：项目状态示例数据.csv";
  const cleaned = policy.utilityResultText(evidence, 0);
  assert.doesNotMatch(cleaned, /已生成文件|文件已生成/);
  assert.match(cleaned, /未生成可交付文件/);
  assert.equal(policy.utilityResultText(evidence, 1), evidence);
});

test("exhausted failure marks the delivery failed and explains once", async () => {
  const e = deliveryEnv();
  await seedDelivery(e);
  const receipt = {
    id: "delivery-file-1",
    status: "failed",
    sent_count: 0,
    attempts: 3,
    exhausted: true,
    error: "target_unavailable",
  };
  const first = await policy.recordDeliveryFailure(e, receipt, { now: Date.now() });
  assert.equal(first.recorded, true);
  assert.equal(first.status, "failed");
  const delivery = await e.DB.prepare("SELECT * FROM deliveries WHERE id=?").bind("delivery-file-1").first();
  assert.equal(delivery.status, "failed");
  const job = await e.DB.prepare("SELECT payload FROM jobs WHERE id=?").bind("file-1").first();
  assert.equal(JSON.parse(job.payload).needs_attention, true);
  const retry = await e.DB.prepare("SELECT * FROM delivery_retries WHERE delivery_id=?").bind("delivery-file-1").first();
  assert.equal(retry.attempts, 3);
  assert.equal(retry.last_error, "target_unavailable");
  const notices = (await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results;
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /项目状态示例数据 CSV/);
  assert.match(notices[0].body, /没发出去/);
  assert.match(notices[0].body, /3 次/);
  assert.match(notices[0].body, /重新交办/);
  assert.equal(notices[0].msg_id, MSG34.id);

  const again = await policy.recordDeliveryFailure(e, receipt, { now: Date.now() });
  assert.equal(again.recorded, false, "the same terminal receipt is idempotent");
  assert.equal((await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results.length, 1);
  assert.equal((await e.DB.prepare("SELECT * FROM delivery_retries").all()).results.length, 1);
});

test("the runner receipt route stores failed and posts one group explanation", async () => {
  const e = env();
  await seedDelivery(e);
  const body = {
    id: "delivery-file-1",
    status: "failed",
    sent_count: 0,
    attempts: 3,
    exhausted: true,
    error: "target_unavailable",
  };
  assert.equal((await req(e, "/api/runner/delivery/report", body, "runner-secret")).status, 200);
  assert.equal((await req(e, "/api/runner/delivery/report", body, "runner-secret")).status, 200);
  const delivery = await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first();
  assert.equal(delivery.status, "failed");
  const notices = (await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results;
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /没发出去/);
  assert.match(notices[0].body, /3 次/);
  assert.equal((await e.DB.prepare("SELECT * FROM jobs WHERE kind='voice_notice' AND id LIKE 'delivery-notice-%'").all()).results.length, 0);
});

test("a new delivery records its first safe failure and stays retryable", async () => {
  const e = env();
  await seedDelivery(e);
  const first = {
    id: "delivery-file-1", status: "failed", sent_count: 0,
    attempts: 1, exhausted: false, error: "target_unavailable",
    next_attempt: Date.now() + 60_000,
  };
  assert.equal((await req(e, "/api/runner/delivery/report", first, "runner-secret")).status, 200);
  const delivery = await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first();
  assert.equal(delivery.status, "pending", "a retryable failure must not terminate the delivery");
  let retry = await e.DB.prepare("SELECT * FROM delivery_retries WHERE delivery_id=?").bind("delivery-file-1").first();
  assert.equal(retry.attempts, 1);
  assert.equal(retry.last_error, "target_unavailable");
  assert.equal(retry.needs_attention, 0);
  assert.equal((await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results.length, 0);
  assert.equal((await req(e, "/api/runner/delivery/report", {
    id: "delivery-file-1", status: "sent", sent_count: 1, attempts: 2,
  }, "runner-secret")).status, 200);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first()).status, "sent");
  retry = await e.DB.prepare("SELECT * FROM delivery_retries WHERE delivery_id=?").bind("delivery-file-1").first();
  assert.equal(retry.needs_attention, 0);
  assert.equal((await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results.length, 0);
});

test("a retry that finally exhausts reports failed once even after progress receipts", async () => {
  const e = env();
  await seedDelivery(e);
  assert.equal((await req(e, "/api/runner/delivery/report", {
    id: "delivery-file-1", status: "failed", sent_count: 0,
    attempts: 1, exhausted: false, error: "target_unavailable",
  }, "runner-secret")).status, 200);
  const body = {
    id: "delivery-file-1", status: "failed", sent_count: 0,
    attempts: 3, exhausted: true, error: "target_unavailable",
  };
  assert.equal((await req(e, "/api/runner/delivery/report", body, "runner-secret")).status, 200);
  assert.equal((await req(e, "/api/runner/delivery/report", body, "runner-secret")).status, 200);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first()).status, "failed");
  const retry = await e.DB.prepare("SELECT * FROM delivery_retries WHERE delivery_id=?").bind("delivery-file-1").first();
  assert.equal(retry.attempts, 3);
  assert.equal(retry.needs_attention, 1);
  assert.equal((await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results.length, 1);
});

test("a retry receipt older than one hour is failed and explained without waiting for attempt three", async () => {
  const e = env();
  await seedDelivery(e);
  await e.DB.prepare("UPDATE deliveries SET updated_at=? WHERE id=?")
    .bind(new Date(Date.now() - 61 * 60_000).toISOString(), "delivery-file-1").run();
  assert.equal((await req(e, "/api/runner/delivery/report", {
    id: "delivery-file-1", status: "failed", sent_count: 0,
    attempts: 1, exhausted: false, error: "target_unavailable",
  }, "runner-secret")).status, 200);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first()).status, "failed");
  const notices = (await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results;
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /1 小时|超时|停止/);
});

test("stuck deliveries enter retry and stale ones fail with one notice", async () => {
  const e = deliveryEnv();
  await seedDelivery(e);
  const now = Date.now();
  await e.DB.prepare("UPDATE deliveries SET updated_at=? WHERE id=?")
    .bind(new Date(now - 20 * 60_000).toISOString(), "delivery-file-1").run();
  assert.equal(await policy.sweepStuckDeliveries(e, now), 1);
  let retry = await e.DB.prepare("SELECT * FROM delivery_retries WHERE delivery_id=?").bind("delivery-file-1").first();
  assert.equal(retry.last_error, "no_progress");
  assert.equal(retry.needs_attention, 0);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first()).status, "pending");
  await e.DB.prepare("UPDATE deliveries SET updated_at=? WHERE id=?")
    .bind(new Date(now - 61 * 60_000).toISOString(), "delivery-file-1").run();
  assert.equal(await policy.sweepStuckDeliveries(e, now), 1);
  assert.equal((await e.DB.prepare("SELECT status FROM deliveries WHERE id=?").bind("delivery-file-1").first()).status, "failed");
  assert.equal((await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'delivery-attention-%'").all()).results.length, 1);
});

test("outbox resend is a dry run unless the owner confirms", async () => {
  const e = env();
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
    .bind("media-result-msg34", GROUP, MSG34.id, OUTBOX19, "failed", 1794386441467).run();
  const dry = await req(e, "/api/team/outbox/resend", { id: "media-result-msg34" });
  assert.equal(dry.status, 200);
  const plan = await dry.json();
  assert.equal(plan.dry_run, true);
  assert.equal(plan.status, "failed");
  assert.equal(plan.stale, true);
  assert.equal(plan.expected, "1 条群文本消息；无附件");
  assert.match(plan.body, /项目状态示例数据\.csv/);
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id=?").bind("media-result-msg34").first()).status, "failed");
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox_attempts").first()).n, 0);
  assert.equal((await req(e, "/api/team/outbox/resend", { id: "media-result-msg34" }, "not-owner")).status, 401);
  const confirmed = await req(e, "/api/team/outbox/resend", { id: "media-result-msg34", confirm: true });
  assert.equal(confirmed.status, 200);
  assert.equal((await confirmed.json()).queued, true);
  assert.equal((await e.DB.prepare("SELECT status FROM outbox WHERE id=?").bind("media-result-msg34").first()).status, "pending");
  assert.equal((await req(e, "/api/team/outbox/resend", { id: "media-result-msg34", confirm: true })).status, 409);
});

test("a completed file task with zero files tells the reply writer not to claim one", async () => {
  const e = env();
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,0,1)",
  ).bind(MSG34.id, GROUP, "owner", MSG34.body, MSG34.ts).run();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,?,?,?)",
  ).bind(
    "file-1",
    "media",
    JSON.stringify({ message: MSG34.id, title: "项目状态示例数据 CSV", want_files: true, lease: "lease-1" }),
    "running",
    1,
    Date.now() + 60_000,
    Date.now(),
  ).run();
  const response = await req(e, "/api/runner/media/report", {
    id: "file-1",
    lease: "lease-1",
    success: true,
    result: OUTBOX19,
    files: [],
  }, "runner-secret");
  assert.equal(response.status, 200);
  assert.equal((await e.DB.prepare("SELECT * FROM deliveries").all()).results.length, 0);
  const notice = await e.DB.prepare("SELECT * FROM jobs WHERE kind='voice_notice' AND id=?").bind("media-result-" + MSG34.id).first();
  assert.ok(notice, "a zero-file completion still notifies the group");
  const payload = JSON.parse(notice.payload);
  assert.doesNotMatch(payload.status, /已生成/);
  assert.match(payload.status, /没有生成任何文件/);
  assert.doesNotMatch(payload.result, /已生成文件|文件已生成|生成好/);
  assert.match(payload.result, /未生成可交付文件/);
});
