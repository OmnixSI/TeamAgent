import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync, rmSync } from "node:fs";
import { env } from "./support.mjs";

// B-l7：规则注入 + 口头禅 scrub。全部在本机假 D1 上跑：QQ 真实发送 0 次、线上 D1 写入 0 行。
const outfile = `.wrangler/rules-inject-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export * from "./src/rules-inject.ts"; export * from "./src/reply-finalize.ts"; export * from "./src/timing.ts"; export { metered } from "./src/d1.ts"; export { agentAnswer } from "./src/semantic.ts";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);
rmSync(outfile);

const GROUP = "GROUP000001";
const now = Date.parse("2026-11-14T00:00:00Z");
const day = 86400000;
const migration = readFileSync(
  new URL("../migrations/0008_review.sql", import.meta.url),
  "utf8",
).replace(/--[^\n]*/g, "");

async function setup() {
  const e = env();
  for (const sql of migration.split(";").filter((s) => s.trim()))
    await e.DB.prepare(sql).run();
  return e;
}

async function seedRule(
  e,
  {
    id,
    kind = "free",
    params = {},
    rule,
    status = "canary",
    group = GROUP,
    updated = now,
    expires = now + 30 * day,
  },
) {
  await e.DB.prepare(
    `INSERT INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,canary_until,expires_at,hits,corrections,created_at,updated_at)
     VALUES(?,?,?,?,?,?,'[]','member:U1',?,?,?,0,0,?,?)`,
  )
    .bind(id, group, rule, "群聊", kind, JSON.stringify(params), status, now + 3 * day, expires, now, updated)
    .run();
}

const all = async (e, sql, ...args) =>
  (await e.DB.prepare(sql).bind(...args).all()).results;

async function contextFor(e, { id, body, ts = new Date().toISOString(), sender = "U1", mentioned = 1 }) {
  await e.DB.prepare(
    "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  )
    .bind(id, GROUP, sender, body, ts, mentioned)
    .run();
  const row = { id, group_id: GROUP, sender, body, ts, mentioned, meta: { direct: true, media: [] } };
  return {
    latest: row,
    batch: [row],
    recent: [row],
    names: new Map(),
    refs: new Map(),
    mentioned: !!mentioned,
  };
}

function stub(voice = '{"mode":"work","text":"好。"}') {
  const old = globalThis.fetch, seen = [];
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) return Response.json({});
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    const system = String(body.messages?.[0]?.content || "");
    const content = system.includes("最后的嘴替模块")
      ? voice
      : '{"action":"reply","kind":"direct","brief":"好。"}';
    return Response.json({ choices: [{ message: { content }, finish_reason: "stop" }] });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = old;
    },
  };
}

const userPrompt = (seen) =>
  String(seen[0].messages.find((m) => m.role === "user").content);

test("rulesBlock caps address rules by this batch's senders and other rules at five", () => {
  const rows = [
    { id: "a1", kind: "address_as", params: JSON.stringify({ member: "qq:U1", name: "马哥" }), rule: "称呼qq:U1为「马哥」。" },
    { id: "a2", kind: "address_as", params: JSON.stringify({ member: "U2", name: "姐" }), rule: "称呼U2为「姐」。" },
    { id: "a3", kind: "address_as", params: JSON.stringify({ member: "U9", name: "叔" }), rule: "称呼U9为「叔」。" },
    { id: "a4", kind: "address_as", params: JSON.stringify({ member: "U1", name: "哥" }), rule: "称呼U1为「哥」。" },
    { id: "v1", kind: "avoid_phrase", params: JSON.stringify({ phrase: "草" }), rule: "不要再说「草」。" },
    { id: "f1", kind: "free", params: "{}", rule: "先给结论。" },
    { id: "f2", kind: "free", params: "{}", rule: "回答短一点。" },
    { id: "f3", kind: "free", params: "{}", rule: "别用表格。" },
    { id: "f4", kind: "free", params: "{}", rule: "少用感叹号。" },
    { id: "f5", kind: "free", params: "{}", rule: "不要复读。" },
    { id: "v2", kind: "avoid_phrase", params: JSON.stringify({ phrase: "绝了" }), rule: "不要再说「绝了」。" },
  ];
  const out = api.rulesBlock(rows, ["U1", "qq:U2"]);
  assert.ok(out.text.startsWith("群里大家提过的要求（照做）：\n"));
  assert.ok(out.text.includes("称呼qq:U1为「马哥」。"));
  assert.ok(out.text.includes("称呼U2为「姐」。"), "qq: prefix normalisation works both ways");
  assert.ok(out.text.includes("称呼U1为「哥」。"), "third address rule is allowed");
  assert.ok(!out.text.includes("称呼U9为「叔」。"), "a rule for a member outside this batch is not injected");
  assert.equal(out.text.split("称呼").length - 1, 3, "address rules are capped at three");
  assert.ok(out.text.includes("不要再说「草」。"), "avoid_phrase is rendered as a requirement");
  assert.ok(out.text.includes("少用感叹号。"));
  assert.ok(!out.text.includes("不要复读。"), "other rules are capped at five");
  assert.deepEqual(out.avoid, ["草", "绝了"], "every avoid phrase is scrubbed even when its line is capped out");
});

test("rulesBlock clips each rule to 80 characters and the block to 400", () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: "r" + i,
    kind: "free",
    params: "{}",
    rule: "字".repeat(200),
  }));
  const out = api.rulesBlock(rows, []);
  assert.ok(Array.from(out.text).length <= 400);
  const lines = out.text.split("\n").slice(1);
  assert.ok(lines.length >= 1 && lines.length <= 5);
  for (const line of lines) assert.ok(Array.from(line).length <= 80);
});

test("zero rules produce an empty block so the prompt has nothing to add", () => {
  assert.deepEqual(api.rulesBlock([], ["U1"]), { text: "", avoid: [] });
});

test("loadGroupRules reads fresh canary/active rules newest first in one query", async () => {
  const e = await setup();
  await seedRule(e, { id: "r1", status: "active", rule: "旧规则。", updated: now + 1 });
  await seedRule(e, { id: "r2", status: "canary", rule: "新规则。", updated: now + 2 });
  await seedRule(e, { id: "r3", status: "candidate", rule: "候选。", updated: now + 3 });
  await seedRule(e, { id: "r4", status: "retired", rule: "退休。", updated: now + 4 });
  await seedRule(e, { id: "r5", status: "active", rule: "过期。", updated: now + 5, expires: now });
  await seedRule(e, { id: "r6", status: "active", rule: "别群。", updated: now + 6, group: "other" });
  let hits = 0;
  const orig = e.DB.prepare;
  e.DB.prepare = (sql) => {
    if (/FROM behavior_rules/.test(sql)) hits++;
    return orig.call(e.DB, sql);
  };
  const rows = await api.loadGroupRules(e, GROUP, now);
  assert.deepEqual(rows.map((r) => r.id), ["r2", "r1"]);
  assert.equal(hits, 1, "one D1 read per turn");
});

test("scrub deletes standalone phrases and keeps embedded words and draft words", () => {
  // 真实 outbox（线上只读导出）：rid 99「草，我的问题…」、rid 110「work：草，被骂得不冤…」
  assert.deepEqual(api.scrubAvoided("草，我的问题，光顾着扒链接没先吱一声。", ["草"]), {
    text: "我的问题，光顾着扒链接没先吱一声。",
    count: 0,
  });
  assert.deepEqual(api.scrubAvoided("work：草，被骂得不冤。我看了下，最该动的是这五处：", ["草"]), {
    text: "work：被骂得不冤。我看了下，最该动的是这五处：",
    count: 0,
  });
  for (const text of [
    "口头禅「草」和反复道歉，都写进规则。", // rid 113/115 的引用形态（逐字节选）
    "草稿和草案先放着，别急着发。", // rid 96/149 的 draft 形态
    "把“草”写进规则，不靠提示词。",
  ])
    assert.deepEqual(api.scrubAvoided(text, ["草"]), { text, count: 0 }, text);
});

test("phrases shorter than three characters are scrubbed but never counted", () => {
  assert.deepEqual(api.scrubAvoided("草，这个不行。", ["草"]), { text: "这个不行。", count: 0 });
  assert.deepEqual(api.scrubAvoided("他妈的，这个不行。", ["他妈的"]), { text: "这个不行。", count: 1 });
  assert.deepEqual(api.scrubAvoided("他妈的，这也不行。他妈的，那也不行。", ["他妈的"]), {
    text: "这也不行。那也不行。",
    count: 2,
  });
});

test("an all-phrase reply falls back to the original text but still counts", () => {
  assert.deepEqual(api.scrubAvoided("他妈的。", ["他妈的"]), { text: "他妈的。", count: 1 });
  assert.deepEqual(api.scrubAvoided("草。", ["草"]), { text: "草。", count: 0 });
});

test("finalizeSpoken reports each deleted phrase to the injected callback", async () => {
  const seen = [];
  const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text: "他妈的，这个不行。" }), {
    avoid: ["他妈的"],
    onViolation: (phrase, count) => seen.push([phrase, count]),
  });
  assert.equal(JSON.parse(out).text, "这个不行。");
  assert.deepEqual(seen, [["他妈的", 1]]);
});

test("daytime prompt carries the rules block once and drops the old team_reflection field", async () => {
  const e = await setup();
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('team_reflection',?)")
    .bind("旧反思不该出现在白天 prompt")
    .run();
  await seedRule(e, { id: "rule-cao", kind: "avoid_phrase", params: { phrase: "草" }, rule: "不要再说「草」。" });
  await seedRule(e, { id: "rule-addr", kind: "address_as", params: { member: "U1", name: "马哥" }, rule: "称呼U1为「马哥」。" });
  let hits = 0;
  const orig = e.DB.prepare;
  e.DB.prepare = (sql) => {
    if (/FROM behavior_rules/.test(sql)) hits++;
    return orig.call(e.DB, sql);
  };
  const s = stub();
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-l7-1", body: "早上好", sender: "U1" }));
  } finally {
    s.restore();
  }
  const content = userPrompt(s.seen);
  assert.ok(content.includes("群里大家提过的要求（照做）："));
  assert.ok(content.includes("不要再说「草」。"));
  assert.ok(content.includes("称呼U1为「马哥」。"), "address_as for this batch's sender is injected");
  assert.ok(!content.includes("旧反思不该出现在白天 prompt"), "team_reflection is no longer a daytime prompt field");
  assert.equal(hits, 1, "activeRulesFor is called exactly once");
});

test("zero rules leave the daytime prompt byte-identical (no groupRules field)", async () => {
  const e = await setup();
  const first = stub();
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-l7-2", body: "早上好", ts: "2026-11-14T14:40:00+11:00" }));
  } finally {
    first.restore();
  }
  const baseline = userPrompt(first.seen);
  const data = JSON.parse(baseline);
  assert.ok(!("groupRules" in data), "an empty block must not add a prompt field");
  assert.ok(!("reflection" in data), "the retired reflection field must be gone");
  assert.equal(JSON.stringify(data), baseline);

  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('off:review_rules','1')").run();
  const off = stub();
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-l7-2", body: "早上好", ts: "2026-11-14T14:40:00+11:00" }));
  } finally {
    off.restore();
  }
  const strip = (s) => s.replace(/"today":"[^"]*"/, '"today":"<same>"');
  assert.equal(strip(userPrompt(off.seen)), strip(baseline), "zero rules and the kill switch must produce the same prompt");
});

test("off:review_rules=1 skips the D1 read and injects nothing", async () => {
  const e = await setup();
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('off:review_rules','1')").run();
  await seedRule(e, { id: "rule-cao", kind: "avoid_phrase", params: { phrase: "草" }, rule: "不要再说「草」。" });
  let hits = 0;
  const orig = e.DB.prepare;
  e.DB.prepare = (sql) => {
    if (/FROM behavior_rules/.test(sql)) hits++;
    return orig.call(e.DB, sql);
  };
  const s = stub();
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-l7-4", body: "早上好" }));
  } finally {
    s.restore();
  }
  assert.ok(!userPrompt(s.seen).includes("群里大家提过的要求"));
  assert.equal(hits, 0, "the kill switch must not spend a D1 read");
});

test("a violation is queued on e.tail and written once as activity rule.violation", async () => {
  const e = await setup();
  await seedRule(e, { id: "rule-tmd", kind: "avoid_phrase", params: { phrase: "他妈的" }, rule: "不要再说「他妈的」。" });
  const m = api.metered(e);
  const s = stub('{"mode":"work","text":"他妈的，这个不行。"}');
  let answer;
  try {
    answer = await api.agentAnswer(m, await contextFor(m, { id: "msg-l7-5", body: "说说看" }));
  } finally {
    s.restore();
  }
  assert.equal(JSON.parse(answer).text, "这个不行。");
  assert.equal((await all(m, "SELECT * FROM activity WHERE kind='rule.violation'")).length, 0, "written after sending, not on the reply path");
  await api.flushTail(m);
  const rows = await all(m, "SELECT * FROM activity WHERE kind='rule.violation'");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entity, "rule-tmd");
  assert.equal(rows[0].id, "rule-violation:rule-tmd:msg-l7-5");
  await api.flushTail(m);
  assert.equal((await all(m, "SELECT * FROM activity WHERE kind='rule.violation'")).length, 1, "the flush is idempotent");
  console.log("B-l7 回放：QQ 真实发送 0 次（本地假 D1，未调用 sendOutbox），线上 D1 写入 0 行");
});
