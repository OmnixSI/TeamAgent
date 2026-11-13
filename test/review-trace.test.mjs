import { test } from "node:test";
import assert from "node:assert/strict";
import { seedReviewDb, t, GROUP } from "./fixtures/review/seed.mjs";
import { review } from "./fixtures/review/build.mjs";

const { buildTraces, signalsOf, priorityOf, capabilitySnapshot, healthAt } = await review();
const WINDOW = { window_start: t("00:00:00"), window_end: t("23:59:59") };
const build = (e, opts = {}) => buildTraces(e, { group_id: GROUP, ...WINDOW, ...opts });
const byId = (traces, id) => traces.find((x) => x.inbound.id === id);

function makeTrace(over = {}) {
  return {
    id: "tr-x", group_id: GROUP,
    inbound: { id: "x", ts: t("10:00:00"), sender: "member1", body: "@小助手 在吗", mentioned: 1 },
    context_before: [], after: [], replies: [], tools: "unrecorded", tools_offered: "unknown",
    snapshot_ref: null, signals: [],
    ...over,
  };
}

test("D3 #17 messages 428-432 all carry S1", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  for (const id of ["428", "429", "430", "431", "432"]) {
    const tr = byId(traces, id);
    assert.ok(tr, `trace ${id} missing`);
    assert.ok(tr.signals.includes("S1"), `${id} signals=${tr.signals}`);
    assert.equal(tr.decision.action, "reply", `${id} inherits the batch decision`);
    if (id !== "432") assert.equal(tr.replies.length, 0);
  }
});

test("D3 #13 message 95 carries S7 (four bot segments in 3 minutes)", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  const tr = byId(traces, "95");
  assert.ok(tr);
  assert.ok(tr.signals.includes("S7"), `signals=${tr.signals}`);
  assert.equal(tr.replies.length, 4);
});

test("D3 #2 message 434 carries S8 (capability self-description)", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  const tr = byId(traces, "434");
  assert.ok(tr);
  assert.ok(tr.signals.includes("S8"), `signals=${tr.signals}`);
});

test("D3 #20 outbox 233 carries S9 (proactive long text after corrections)", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  const tr = byId(traces, "233");
  assert.ok(tr);
  assert.equal(tr.decision.spoken_kind, "proactive");
  assert.ok(tr.signals.includes("S9"), `signals=${tr.signals}`);
});

test("D3 #3 messages 338/339 second question carries S10", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  assert.ok(!byId(traces, "338").signals.includes("S10"), "first answer has no prior duplicate");
  assert.ok(byId(traces, "339").signals.includes("S10"), `signals=${byId(traces, "339").signals}`);
});

test("D3 outbox 145 and 149 carry S10", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  assert.ok(byId(traces, "145").signals.includes("S10"));
  assert.ok(byId(traces, "149").signals.includes("S10"));
});

test("D3 cursor pagination covers two or more pages without gaps or duplicates", async () => {
  const e = seedReviewDb();
  const all = (await build(e, { page_size: 80 })).traces.map((x) => x.inbound.id);
  const pages = [];
  let cursor = null;
  for (let i = 0; i < 10; i++) {
    const page = await build(e, { page_size: 7, cursor });
    pages.push(page.traces.map((x) => x.inbound.id));
    if (!page.traces.length) break;
    cursor = page.cursor;
  }
  assert.ok(pages.filter((p) => p.length).length >= 2, "expected at least two non-empty pages");
  assert.deepEqual(pages.flat(), all);
  assert.equal(new Set(pages.flat()).size, all.length);
});

test("D3 a second call from the cursor returns only newer messages", async () => {
  const e = seedReviewDb();
  const first = await build(e, { page_size: 80 });
  assert.equal(first.traces.length > 0, true);
  e.addMessage({ id: "440", at: "22:00:00", body: "@小助手 新问题", mentioned: 1 });
  const next = await build(e, { page_size: 80, cursor: first.cursor });
  assert.deepEqual(next.traces.map((x) => x.inbound.id), ["440"]);
});

test("D3 without turn_tools every trace reports unrecorded", async () => {
  const e = seedReviewDb();
  const { traces } = await build(e);
  assert.ok(traces.length > 0);
  for (const tr of traces) {
    assert.equal(tr.tools, "unrecorded");
    assert.equal(tr.tools_offered, "unknown");
  }
});

test("D3 with turn_tools records calls and offered tools", async () => {
  const e = seedReviewDb({ review: true });
  e.raw.prepare("INSERT INTO turn_tools(id,turn_id,group_id,name,args,ok,error_kind,ms,offered,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("tt-1", "95", GROUP, "repo_changes", "{}", 0, "timeout", 1200, 1, Date.parse(t("09:02:31")));
  const { traces } = await build(e);
  const tr = byId(traces, "95");
  assert.deepEqual(tr.tools, [{ name: "repo_changes", ok: false, error_kind: "timeout", ms: 1200 }]);
  assert.deepEqual(tr.tools_offered, ["repo_changes"]);
  assert.ok(tr.signals.includes("S5"), "failed tool must raise S5");
});

test("D3 redacts inbound and reply bodies before they enter the trace", async () => {
  const e = seedReviewDb();
  e.addMessage({ id: "450", at: "14:00:00", body: "@小助手 这是 sk-abcdefghijklmnopqrstuvwxyz 密钥", mentioned: 1 });
  const { traces } = await build(e);
  const tr = byId(traces, "450");
  assert.ok(tr);
  assert.ok(!JSON.stringify(tr).includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(tr.inbound.body.includes("[密钥已隐藏]"));
});

test("D3 compares ISO timestamps by instant, not by raw string", async () => {
  const e = seedReviewDb();
  e.addMessage({ id: "TZ1", ts: "2026-11-13T21:00:00+08:00", body: "@小助手 时区测试", mentioned: 1 });
  const { traces } = await build(e, {
    window_start: "2026-11-13T12:00:00Z",
    window_end: "2026-11-13T14:00:00Z",
  });
  assert.ok(byId(traces, "TZ1"), "21:00+08:00 is 13:00Z and must fall inside the window");
});

test("D3 every trace_json stays within 6000 characters", async () => {
  const e = seedReviewDb();
  e.addMessage({ id: "460", at: "22:30:00", body: "@小助手 " + "很长的消息".repeat(500), mentioned: 1 });
  for (let i = 0; i < 4; i++) {
    e.addOutbox({ id: i ? `chat-460~${i}` : "chat-460", msgId: "460", body: "很长的回复".repeat(500), at: `22:30:${10 + i}` });
  }
  const { traces } = await build(e);
  for (const tr of traces) assert.ok(JSON.stringify(tr).length <= 6000, `${tr.inbound.id}: ${JSON.stringify(tr).length}`);
});

test("D3 buildTraces stays under 12 statements and never touches processed/chat_cursor", async () => {
  const e = seedReviewDb();
  const before = e.DB.executed;
  await build(e, { page_size: 80 });
  assert.ok(e.DB.executed - before <= 12, `executed=${e.DB.executed - before}`);
  for (const sql of e.log) {
    assert.ok(!/processed|chat_cursor/i.test(sql), `forbidden column in: ${sql}`);
  }
});

test("D3 signal rules S2-S6 and S10 are deterministic", () => {
  const at = Date.parse(t("10:00:00"));
  const base = { inbound: { ...makeTrace().inbound, id: "z", ts: t("10:00:00") } };

  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "这个我做不了。", status: "sent", at: at + 1000 }] }), {}).includes("S2"));
  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "好的。", status: "sent", at: at + 1000 }] }), { after: [{ body: "不对，你错了" }] }).includes("S3"));
  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "文件发你了。", status: "failed", at: at + 1000 }] }), {}).includes("S4"));
  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "文件发你了。", status: "sent", at: at + 1000 }] }), { deliveries: 0 }).includes("S4"));
  assert.ok(signalsOf(makeTrace({ job: { id: "j", kind: "chat", status: "failed", error: "x" } }), {}).includes("S5"));
  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "明天再给你。", status: "sent", at: at + 1000 }] }), {}).includes("S6"));
  assert.ok(signalsOf(makeTrace({ replies: [{ outbox_id: "o", body: "同一句话。", status: "sent", at: at + 1000 }] }), { bot_before: [{ body: "同一句话。", at: at - 60000 }] }).includes("S10"));
  const burst = makeTrace({ replies: [0, 1, 2, 3].map((i) => ({ outbox_id: `o${i}`, body: "同一句话。", status: "sent", at: at + i * 1000 })) });
  assert.ok(signalsOf(burst, {}).includes("S7"));
  assert.ok(!signalsOf(burst, { after: [{ body: "等等", ts: t("10:00:02") }] }).includes("S7"), "a user message breaks the run");
  assert.ok(signalsOf(
    makeTrace({ replies: [{ outbox_id: "o", body: "这次 remember_correction 保存成功了，记忆写入可用。", status: "sent", at: at + 1000 }] }),
    { bot_before: [{ body: "这轮记忆写入工具返回不可用，这条边界没写进长期记忆。", at: at - 4 * 60000 }] },
  ).includes("S10"), "memory_write contradiction");
  assert.equal(priorityOf(["S1", "S2"]), 5);
  assert.equal(priorityOf(["S6", "S7"]), 2);
  assert.equal(priorityOf(["S4", "S10"]), 6);
});

test("D3 snapshot reports switches, health ratios, repos, jobs and never reads auth values", async () => {
  const e = seedReviewDb({ review: true });
  const put = (k, v) => e.raw.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(k, v);
  const now = Date.now();
  put("off:quote", "1");
  put("off:wait", "0");
  put("auth:bili", JSON.stringify({ state: "ok", token: "sk-super-secret-value" }));
  put("runner_seen", new Date(now - 30000).toISOString());
  e.raw.prepare("INSERT INTO repo_state(repo,json,fingerprint,updated_at,checked_at) VALUES(?,?,?,?,?)")
    .run("OmnixSI/TeamAgent", JSON.stringify({ head: { sha: "abc" } }), "fp", now - 100000, now - 50000);
  e.raw.prepare("INSERT INTO repo_commits(repo,sha,at,author,subject,files) VALUES(?,?,?,?,?,?)")
    .run("OmnixSI/TeamAgent", "sha1", now - 3600000, "a", "s", "[]");
  e.raw.prepare("INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,error,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .run("media-1", "media", "{}", "failed", 1, 0, "boom", now - 1000);
  e.RELEASE = "test-release";

  const s = await capabilitySnapshot(e);
  assert.ok(s.at > 0);
  assert.equal(s.switches["off:quote"], "off");
  assert.equal(s.switches["off:wait"], "on");
  assert.equal(s.switches["auth:bili"], "on");
  assert.ok(!JSON.stringify(s).includes("sk-super-secret-value"));
  assert.ok(s.runner.seen_age_s >= 25 && s.runner.seen_age_s <= 45, `seen=${s.runner.seen_age_s}`);
  assert.ok(Math.abs(s.runner.ok_ratio_24h - 5 / 6) < 1e-9);
  assert.ok(Math.abs(s.gateway.ok_ratio_24h - 5 / 6) < 1e-9);
  const repo = s.repo.find((r) => r.repo === "OmnixSI/TeamAgent");
  assert.ok(repo.state_age_s >= 45 && repo.state_age_s <= 70, `state=${repo.state_age_s}`);
  assert.ok(repo.cache_age_s >= 95 && repo.cache_age_s <= 120, `cache=${repo.cache_age_s}`);
  assert.equal(repo.commits, 1);
  assert.equal(s.jobs_24h.find((j) => j.kind === "media").failed, 1);
  assert.equal(s.release, "test-release");
  for (const sql of e.log) if (sql.includes("auth:bili")) assert.ok(!/\bvalue\b/i.test(sql), sql);
});

test("D3 healthAt picks the latest sample before the timestamp", async () => {
  const e = seedReviewDb();
  const h = await healthAt(e, Date.parse(t("09:30:00")));
  assert.equal(h.health_at, Date.parse(t("09:00:00")));
  assert.equal(h.gateway_ok, 1);
  assert.equal(h.runner_ok, 1);
  assert.equal(await healthAt(e, Date.parse(t("08:00:00"))), null);
});
