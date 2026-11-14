import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { loadReviewSubset } from "./fixtures/review/load.mjs";
import { review } from "./fixtures/review/build.mjs";

const { buildTraces, signalsOf, priorityOf, capabilitySnapshot, healthAt,
  ownClauses, segmentsOf, addressedOf, explicitWriteRequest } = await review();
const GROUP = "fx-group";
const W0 = "2026-11-11T00:00:00+08:00";
const W1 = "2026-11-14T00:00:00+08:00";

function wrap(raw) {
  const log = [];
  let executed = 0;
  const DB = {
    get executed() { return executed; },
    prepare(sql) {
      log.push(sql);
      const make = (args = []) => ({
        sql,
        bind(...values) { return make(values); },
        async first() { executed++; return raw.prepare(sql).get(...args) ?? null; },
        async all() { executed++; return { results: raw.prepare(sql).all(...args) }; },
        async run() { executed++; return raw.prepare(sql).run(...args); },
      });
      return make();
    },
    async batch(statements) {
      executed += statements.length;
      return Promise.all(statements.map((statement) => statement.run()));
    },
  };
  return { DB, raw, log };
}

function fixture({ tools = true, offers = true } = {}) {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync("schema.sql", "utf8"));
  raw.exec(readFileSync("migrations/0008_review.sql", "utf8"));
  loadReviewSubset(raw);
  if (!tools) raw.exec("DROP TABLE turn_tools");
  if (!offers) raw.exec("DROP TABLE turn_offers");
  return wrap(raw);
}

const build = (e, opts = {}) => buildTraces(e, { group_id: GROUP, window_start: W0, window_end: W1, ...opts });
const find = (page, id) => page.traces.find((trace) => trace.id === id);
const findMsg = (page, id) => page.traces.flatMap((trace) => [trace.inbound, ...trace.context_before, ...trace.after])
  .find((message) => message?.id === id);
const addMessage = (e, { id, body = "", ts, mentioned = 0, sender = "fx-sender-owner" }) =>
  e.raw.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,0)")
    .run(id, GROUP, sender, body, ts, mentioned);
const addOutbox = (e, { id, msgId = null, body = "收到", status = "sent", at }) =>
  e.raw.prepare("INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)")
    .run(id, GROUP, msgId, body, status, at);
const addDecision = (e, { id, latestId, batchIds = null, outboxId = null, action = "reply", gate = "model", spokenKind = "direct", reason = null, at }) =>
  e.raw.prepare("INSERT INTO chat_decisions(id,group_id,latest_id,batch_ids,mentioned,forced,waited,gate,action,spoken_kind,target_id,wait_seconds,reason,outbox_id,policy,model_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, GROUP, latestId, JSON.stringify(batchIds || [latestId]), 1, 0, 0, gate, action, spokenKind, null, null, reason, outboxId, "live", 100, at);

test("D3 v2 coverage balances across messages and outbox", async () => {
  const e = fixture();
  const page = await build(e);
  const messageCount = e.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE group_id=?").get(GROUP).n;
  const outboxCount = e.raw.prepare("SELECT COUNT(*) AS n FROM outbox WHERE group_id=?").get(GROUP).n;
  const c = page.coverage;
  assert.equal(c.messages, messageCount);
  assert.equal(c.outbox, outboxCount);
  assert.equal(c.inbound_traces + c.skipped_by_rule, c.messages);
  assert.equal(c.outbox_paired + c.outbox_standalone, c.outbox);
  assert.equal(c.outbound_traces, c.outbox_standalone);
  assert.equal(c.unaccounted, 0);
  assert.equal(page.traces.length, c.inbound_traces + c.outbound_traces);
  assert.ok(e.DB.executed <= 12, `statements=${e.DB.executed}`);
  assert.ok(page.traces.every((trace) => trace.id.startsWith("tr-in-") || trace.id.startsWith("tr-out-")));
  for (const sql of e.log) assert.ok(!/processed|chat_cursor/i.test(sql), `forbidden column: ${sql}`);

  addMessage(e, { id: "fx-m-fill1", ts: "2026-11-13T22:40:00+08:00", body: "普通闲聊一" });
  addMessage(e, { id: "fx-m-fill2", ts: "2026-11-13T22:45:00+08:00", body: "普通闲聊二" });
  addMessage(e, { id: "fx-m-skip", ts: "2026-11-13T22:50:00+08:00", body: "普通闲聊" });
  const skipped = await build(e);
  assert.equal(skipped.coverage.skipped_by_rule, 1);
  assert.equal(find(skipped, "tr-in-fx-m-skip"), undefined);
  assert.equal(skipped.coverage.unaccounted, 0);
});

test("D3 v2 rid 233 is a standalone outbound trace", async () => {
  const e = fixture();
  const page = await build(e);
  const trace = find(page, "tr-out-fx-o-233");
  assert.ok(trace, "outbound 233 missing");
  assert.equal(trace.kind, "outbound");
  assert.equal(trace.inbound, null);
  assert.equal(trace.replies.length, 1);
  assert.equal(trace.replies[0].outbox_id, "fx-o-233");
  assert.equal(trace.replies[0].link, "none");
  assert.ok(trace.context_before.some((message) => message.id === "fx-m-419"));
  assert.equal(trace.tools_offered, "unknown");
  assert.equal(find(page, "tr-in-fx-m-233"), undefined);
  assert.equal("rowid" in find(page, "tr-in-fx-m-432").inbound, false);
});

test("D3 v2 pairing follows msg_id, decision, batch and outbox_meta", async () => {
  const e = fixture();
  let page = await build(e);
  const direct = find(page, "tr-in-fx-m-432");
  assert.equal(direct.replies.find((reply) => reply.outbox_id === "fx-o-239").link, "reply_to");
  for (const id of ["fx-m-428", "fx-m-429", "fx-m-430", "fx-m-431"]) {
    const trace = find(page, `tr-in-${id}`);
    assert.equal(trace.replies.find((reply) => reply.outbox_id === "fx-o-239").link, "batch", id);
  }

  addMessage(e, { id: "fx-m-pair-decision", ts: "2026-11-13T22:00:00+08:00", body: "这条走 decision 配对", mentioned: 1 });
  addOutbox(e, { id: "fx-o-pair-decision", at: Date.parse("2026-11-13T22:00:30+08:00") });
  addDecision(e, { id: "d-pair-decision", latestId: "fx-m-pair-decision", outboxId: "fx-o-pair-decision", at: Date.parse("2026-11-13T22:00:20+08:00") });

  addMessage(e, { id: "fx-m-pair-meta", ts: "2026-11-13T22:02:00+08:00", body: "这条走 outbox_meta 配对", mentioned: 1 });
  addOutbox(e, { id: "fx-o-pair-meta", at: Date.parse("2026-11-13T22:02:30+08:00") });
  e.raw.prepare("INSERT INTO outbox_meta(id,json) VALUES(?,?)").run("fx-o-pair-meta", JSON.stringify({ reference: "fx-m-pair-meta" }));

  page = await build(e);
  assert.equal(find(page, "tr-in-fx-m-pair-decision").replies[0].link, "decision");
  assert.equal(find(page, "tr-in-fx-m-pair-meta").replies[0].link, "reply_to");
});

test("D3 v2 provenance keeps source boundaries and real senders", async () => {
  const e = fixture();
  const page = await build(e);

  const m415 = findMsg(page, "fx-m-415");
  assert.equal(m415.sender, "qq:fx-sender-owner");
  assert.equal(m415.bound_member, "fx-sender-owner");
  assert.equal(m415.addressed, "bot");
  assert.deepEqual(m415.segs.map((seg) => seg.origin), ["direct", "forwarded"]);

  assert.equal(findMsg(page, "fx-m-434").addressed, "none");
  assert.equal(findMsg(page, "fx-m-252").addressed, "other");
  assert.deepEqual(findMsg(page, "fx-m-426").segs.map((seg) => seg.origin), ["card"]);
  assert.deepEqual(segmentsOf("我是机器人", { isBot: true }).map((seg) => seg.origin), ["bot"]);
  assert.deepEqual(segmentsOf("看附件", { attachments: [{ name: "a.pdf", analysed: "附件内容" }] }).map((seg) => seg.origin),
    ["direct", "attachment_text"]);

  addMessage(e, { id: "fx-m-prov", ts: "2026-11-13T22:10:00+08:00", body: "前文「引用内容」后文", mentioned: 1 });
  e.raw.prepare("INSERT INTO message_meta(id,json) VALUES(?,?)")
    .run("fx-m-prov", JSON.stringify({ quoted: { text: "引用内容" }, isBot: false }));
  addMessage(e, { id: "fx-m-code", ts: "2026-11-13T22:10:30+08:00", body: "看看```secret code```后面", mentioned: 1 });

  addMessage(e, { id: "fx-m-revoked", ts: "2026-11-13T22:11:00+08:00", body: "我被吊销了", mentioned: 1, sender: "fx-sender-revoked" });
  e.raw.prepare("INSERT INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,1)")
    .run("fx-sender-revoked", "已吊销", "hash-revoked", "member");

  addMessage(e, { id: "fx-m-q", ts: "2026-11-13T22:11:30+08:00", body: "qq 前缀成员", mentioned: 1, sender: "fx-sender-q" });
  e.raw.prepare("INSERT INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,0)")
    .run("qq:fx-sender-q", "Q 成员", "hash-q", "member");

  const next = await build(e);
  const prov = find(next, "tr-in-fx-m-prov").inbound;
  assert.deepEqual(prov.segs.map((seg) => seg.origin), ["direct", "quoted", "direct"]);
  assert.deepEqual(prov.segs.map((seg) => seg.text), ["前文", "「引用内容」", "后文"]);
  assert.equal(find(next, "tr-in-fx-m-revoked").inbound.bound_member, null);
  assert.equal(find(next, "tr-in-fx-m-q").inbound.bound_member, "qq:fx-sender-q");

  assert.deepEqual(ownClauses("请把「这段」删掉，然后```code```记住：以后别发长文"),
    ["请把删掉", "然后记住：以后别发长文"]);
  assert.equal(explicitWriteRequest("remember_correction", { id: "x", body: "纠正一下：不是每天发" }, new Map(), true), true);
  assert.equal(explicitWriteRequest("remember_correction", { id: "x", body: "他说「纠正一下：不是每天发」" }, new Map(), true), false);
  assert.deepEqual(segmentsOf("前文「引用内容」后文", { quoted: { text: "引用内容" } }).map((seg) => seg.origin),
    ["direct", "quoted", "direct"]);
  assert.equal(addressedOf("Bot，你看这个", 0, {}), "bot");
});

test("D3 v2 tools_offered is unknown without turn_offers and stays historical when present", async () => {
  const e = fixture();
  let page = await build(e);
  for (const trace of page.traces) {
    assert.equal(trace.tools_offered, "unknown");
    assert.deepEqual(trace.tools, []);
  }

  addMessage(e, { id: "fx-m-tools", ts: "2026-11-13T22:20:00+08:00", body: "调工具", mentioned: 1 });
  e.raw.prepare("INSERT INTO turn_offers(turn_id,group_id,inbound_id,names,catalog_version,switches,runner_ok,release,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("turn-x", GROUP, "fx-m-tools", JSON.stringify(["repo_changes", "repo_commit"]), "cat-v2",
      JSON.stringify({ "off:repo_tools": "1" }), 1, "r-test", Date.parse("2026-11-13T22:20:00+08:00"));
  e.raw.prepare("INSERT INTO turn_tools(id,turn_id,group_id,name,args,ok,error_kind,ms,offered,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("tt-1", "turn-x", GROUP, "repo_changes", "{}", 0, "timeout", 1200, 1, Date.parse("2026-11-13T22:20:01+08:00"));

  page = await build(e);
  const trace = find(page, "tr-in-fx-m-tools");
  assert.deepEqual(trace.tools_offered.names, ["repo_changes", "repo_commit"]);
  assert.equal(trace.tools_offered.catalog_version, "cat-v2");
  assert.deepEqual(trace.tools_offered.switches, { "off:repo_tools": "on" });
  assert.equal(trace.tools_offered.runner_ok, 1);
  assert.equal(trace.tools_offered.turn_id, "turn-x");
  assert.deepEqual(trace.tools, [{ id: "tt-1", name: "repo_changes", ok: false, error_kind: "timeout", ms: 1200 }]);
  assert.ok(trace.signals.includes("S5"));

  // A batch decision's turn_offers row belongs to the latest inbound; every batch member sees it.
  e.raw.prepare("INSERT INTO turn_offers(turn_id,group_id,inbound_id,names,catalog_version,switches,runner_ok,release,created_at) VALUES(?,?,?,?,?,?,?,?,?)")
    .run("turn-batch", GROUP, "fx-m-432", JSON.stringify(["repo_changes"]), "cat-v2", "{}", 1, "r-test", Date.parse("2026-11-13T21:11:00+08:00"));
  page = await build(e);
  assert.equal(find(page, "tr-in-fx-m-428").tools_offered.turn_id, "turn-batch");
  assert.deepEqual(find(page, "tr-in-fx-m-428").tools_offered.names, ["repo_changes"]);

  const missing = fixture({ tools: false, offers: false });
  const missingPage = await build(missing);
  assert.ok(missingPage.traces.every((item) => item.tools === "unrecorded" && item.tools_offered === "unknown"));
});

test("D3 v2 has_image and images[] come from message_images/image_notes", async () => {
  const e = fixture();
  e.raw.prepare("INSERT INTO image_notes(sha,desc,tags,sticker_like,text,created_at) VALUES(?,?,?,?,?,?)")
    .run("sha-test", "一张报错截图", "[]", 0, "Traceback", Date.parse("2026-11-13T22:30:00+08:00"));
  addMessage(e, { id: "fx-m-img", ts: "2026-11-13T22:30:00+08:00", body: "你看这张图", mentioned: 1 });
  e.raw.prepare("INSERT INTO message_images(message_id,idx,sha) VALUES(?,?,?)").run("fx-m-img", 0, "sha-test");

  const page = await build(e);
  const trace = find(page, "tr-in-fx-m-img");
  assert.equal(trace.has_image, true);
  assert.equal(trace.inbound.images[0].desc, "一张报错截图");
  assert.equal(trace.inbound.images[0].sha, "sha-test");
  assert.ok(trace.inbound.segs.some((seg) => seg.origin === "image_text" && seg.text === "Traceback"));
});

test("D3 v2 trace_json stays within 6000 characters", async () => {
  const e = fixture();
  addMessage(e, { id: "fx-m-long", ts: "2026-11-13T22:40:00+08:00", body: "@小助手 " + "很长的消息".repeat(800), mentioned: 1 });
  for (let i = 0; i < 4; i++) {
    addOutbox(e, { id: i ? `fx-o-long~${i}` : "fx-o-long", msgId: "fx-m-long", body: "很长的回复".repeat(800), at: Date.parse("2026-11-13T22:40:10+08:00") + i });
  }
  const page = await build(e);
  for (const trace of page.traces) assert.ok(JSON.stringify(trace).length <= 6000, `${trace.id}: ${JSON.stringify(trace).length}`);
  const long = find(page, "tr-in-fx-m-long");
  assert.ok(long.replies.length <= 4);
  assert.ok(long.replies.every((reply) => reply.body.length <= 800));
});

test("D3 v2 real-data signals: batch S1 works, known deviations are not forced", async () => {
  const e = fixture();
  const page = await build(e);
  for (const id of ["fx-m-428", "fx-m-429", "fx-m-430", "fx-m-431", "fx-m-432"]) {
    assert.ok(find(page, `tr-in-${id}`).signals.includes("S1"), id);
  }
  // D-1 README expects S7 on 95, but the real row has one reply; the 4-message
  // burst is inbound (93-96), not outbound. Keep the real data; do not force S7.
  assert.ok(!find(page, "tr-in-fx-m-95").signals.includes("S7"));
  // 434 has no reply; 241 is linked to 435 and lacks an S8 word. Do not rewrite it.
  assert.ok(!find(page, "tr-in-fx-m-434").signals.includes("S8"));
  // 190/191 are different answers (3-gram Jaccard 0.17), so S10 is not forced.
  assert.ok(!find(page, "tr-in-fx-m-339").signals.includes("S10"));
  // 233 is visible as outbound, but has no decision/spoken_kind, so S9 is unknown.
  assert.ok(!find(page, "tr-out-fx-o-233").signals.includes("S9"));
  // The real memory-write self-correction (145 vs 149) does carry S10.
  assert.ok(find(page, "tr-in-fx-m-219").signals.includes("S10"));
  assert.equal(priorityOf(["S1", "S2"]), 5);
});

test("D3 v2 both cursors resume without replaying rows", async () => {
  const e = fixture();
  const page = await build(e);
  const next = await build(e, { cursor: page.cursor, outbox_cursor: page.outbox_cursor });
  assert.equal(next.traces.length, 0);
  assert.equal(next.coverage.messages, 0);
  assert.equal(next.coverage.outbox, 0);
  assert.equal(next.coverage.unaccounted, 0);
});

test("D3 v2 snapshot uses the structured catalog and never reads auth values", async () => {
  const e = fixture();
  const put = (key, value) => e.raw.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(key, value);
  const now = Date.now();
  put("off:quote", "1");
  put("off:wait", "0");
  put("auth:bili", JSON.stringify({ state: "ok", token: "fake-auth-value" }));
  put("runner_seen", new Date(now - 30000).toISOString());
  e.raw.prepare("INSERT INTO repo_state(repo,json,fingerprint,updated_at,checked_at) VALUES(?,?,?,?,?)")
    .run("OmnixSI/TeamAgent", "{}", "fp", now - 100000, now - 50000);
  e.raw.prepare("INSERT INTO repo_commits(repo,sha,at,author,subject,files) VALUES(?,?,?,?,?,?)")
    .run("OmnixSI/TeamAgent", "sha1", now - 3600000, "a", "s", "[]");
  e.RELEASE = "r-test";

  const snapshot = await capabilitySnapshot(e);
  assert.equal(snapshot.catalog_version, "cat-v2");
  assert.equal(snapshot.switches["off:quote"], "on");
  assert.equal(snapshot.switches["off:wait"], "off");
  assert.equal(snapshot.switches["auth:bili"], "on");
  assert.ok(!JSON.stringify(snapshot).includes("fake-auth-value"));
  assert.ok(snapshot.tools_catalog.filter((tool) => tool.name.startsWith("repo_")).every((tool) => tool.readonly));
  assert.equal(snapshot.release, "r-test");
  const point = await healthAt(e, Date.parse("2026-11-13T21:00:00+08:00"));
  assert.ok(point && point.health_at > 0);
  for (const sql of e.log) if (sql.includes("auth:bili")) assert.ok(!/\bvalue\b/i.test(sql), sql);
});
