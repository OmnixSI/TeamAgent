import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { env } from "./support.mjs";

// B-l2：定时工具接线 + 回执/口头承诺保底。回放只用本地假 D1，QQ 发送 0、线上 D1 写入 0。
const replay = JSON.parse(
  readFileSync(new URL("./fixtures/daily-push-real.json", import.meta.url), "utf8"),
);
const GROUP = replay.request.group_id;
const TOO = replay.request.body;
// outbox.rid=203 chat-drain-350 的真实原文（acceptance-notes.md §输入溯源）。
const PROMISE =
  "收到，不跟你掰扯那句。口径定这样：悉尼每天 8:00（北京 5:00）推昨日总结，3–5 条要点；周报按周日起算，这周日先出第一份，明早 8:00 出第一份日推。要改直接说。存档文件你没点头，我不动";
const at = (s) => Date.parse(s);

const outfile = `.wrangler/reply-finalize-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export * from "./src/reply-finalize"; export * from "./src/schedules";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);

const semFile = `.wrangler/reply-finalize-sem-${process.pid}.mjs`;
await build({
  stdin: {
    contents: 'export { agentAnswer } from "./src/semantic";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: semFile,
});
const sem = await import("../" + semFile);

const call = (name, args) => ({
  id: "call-" + name,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content = '{"action":"reply","kind":"direct","brief":"好。"}') => ({
  role: "assistant",
  content,
});

function stub(steps = [], voice = '{"mode":"work","text":"已经登记好了。"}') {
  const old = globalThis.fetch;
  const seen = [];
  const queue = [...steps];
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) return Response.json({});
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    const system = String(body.messages?.[0]?.content || "");
    if (system.includes("最后的嘴替模块"))
      return Response.json({ choices: [{ message: { content: voice }, finish_reason: "stop" }] });
    const raw = queue.shift() || reply();
    const next = raw?.function ? { role: "assistant", tool_calls: [raw] } : raw;
    return Response.json({ choices: [{ message: next, finish_reason: "stop" }] });
  };
  return {
    seen,
    restore() {
      globalThis.fetch = old;
    },
  };
}

async function contextFor(e, { id, body, ts = new Date().toISOString(), mentioned = 1, sender = "U1" }) {
  await e.DB.prepare(
    "INSERT OR IGNORE INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  )
    .bind(id, GROUP, sender, body, ts, mentioned)
    .run();
  const row = { id, group_id: GROUP, sender, body, ts, mentioned, meta: { direct: true, media: [] } };
  return { latest: row, batch: [row], recent: [row], names: new Map(), refs: new Map(), mentioned: !!mentioned };
}

const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

test("F1 accepted schedule_create with say prepends the ack once", async () => {
  const say =
    "记下了，每天 08:00（悉尼）发礼物日早报，第一次是 2026-11-15 08:00（悉尼）。不想要了回那条推送说「不用再发了」。";
  const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text: "好的。" }), {
    acceptedActions: [{ tool: "schedule_create", accepted: true, say }],
    avoid: [],
  });
  const v = JSON.parse(out);
  assert.equal(v.mode, "work");
  assert.equal(v.text, say + "好的。");

  const same = JSON.stringify({ mode: "work", text: "记下了，就按你说的办。" });
  assert.equal(
    await api.finalizeSpoken(same, { acceptedActions: [{ tool: "schedule_create", say }], avoid: [] }),
    same,
    "an existing 记下了 must not be duplicated",
  );

  let created = 0;
  const promised = JSON.stringify({ mode: "work", text: "每天 8:00 发总结。" });
  const out2 = await api.finalizeSpoken(promised, {
    acceptedActions: [{ tool: "schedule_create", accepted: true, say }],
    avoid: [],
    userText: TOO,
    groupId: GROUP,
    owner: "U1",
    sourceMsgId: "msg-351",
    createSchedule: async () => {
      created++;
      return null;
    },
    findDuplicate: async () => null,
  });
  assert.equal(created, 0, "an accepted schedule_create must suppress promiseGuard");
  assert.ok(JSON.parse(out2).text.includes("每天 8:00 发总结。"));
});

test("F2 no actions and no avoid is byte-identical (JSON and plain text)", async () => {
  const json = JSON.stringify({ mode: "care", text: "早点睡。", voice: true });
  assert.equal(await api.finalizeSpoken(json, { acceptedActions: [], avoid: [] }), json);
  assert.equal(await api.finalizeSpoken("纯文本回复，没有 JSON。", { acceptedActions: [], avoid: [] }), "纯文本回复，没有 JSON。");
  assert.deepEqual(api.scrubAvoided("草，这个不行。", ["草"]), { text: "这个不行。", count: 0 });
});

test("F3 [[SILENT]] is untouched in raw and JSON form", async () => {
  assert.equal(await api.finalizeSpoken("[[SILENT]]", { acceptedActions: [], avoid: [] }), "[[SILENT]]");
  const silent = JSON.stringify({ mode: "banter", text: "[[SILENT]]" });
  assert.equal(await api.finalizeSpoken(silent, { acceptedActions: [], avoid: [] }), silent);
});

test("F4 slug keeps ascii topics and hashes the full qq id for other topics", () => {
  assert.equal(api.slug("PR Progress", "anything"), "pr-progress");
  // QQ 群消息 id 全以 ROBOT1.0_ 开头，取前 6 位会恒为 rpt-robot1。
  const one = "ROBOT1.0_OyB7TgbASj-VgfcoKvzFbkS08eu4PfP";
  const two = "ROBOT1.0_uMj7bSoGmOazRMZniWJ8kZ0mY7pQx3vN";
  const a = api.slug("礼物日早报", one);
  const b = api.slug("礼物日早报", two);
  assert.notEqual(a, b, "two qq messages with one topic must not share a dedup key");
  assert.match(a, /^rpt-[a-z0-9]{6,8}$/);
  assert.match(b, /^rpt-[a-z0-9]{6,8}$/);
  assert.equal(api.slug("礼物日早报", one), a, "same id must stay stable");
  assert.equal(api.slug("礼物日早报"), "rpt-000000");
});

test("F5 promiseGuard registers the real empty promise and prefixes 记下了", async () => {
  const now = at("2026-11-14T14:30:00+11:00");
  const made = {
    id: "sched-digest_daily-msg-351",
    group_id: GROUP,
    owner: "U1",
    kind: "digest_daily",
    tz: "Australia/Sydney",
    spec: { time: "08:00", topic: "昨日聊天内容总结", origin: "chat" },
    next_run_at: at("2026-11-15T08:00:00+11:00"),
    created_at: now,
    source_msg_id: "msg-351",
  };
  let created = null;
  const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text: PROMISE }), {
    acceptedActions: [],
    avoid: [],
    userText: TOO,
    owner: "U1",
    groupId: GROUP,
    sourceMsgId: "msg-351",
    now,
    createSchedule: async (input) => {
      created = input;
      return made;
    },
    findDuplicate: async () => null,
  });
  const v = JSON.parse(out);
  assert.ok(v.text.startsWith("记下了，每天 08:00（悉尼）发昨日聊天内容总结，第一次是 2026-11-15 08:00（悉尼）。"));
  assert.ok(v.text.includes(PROMISE), "the original reply is kept after the ack");
  assert.equal(created.kind, "digest_daily");
  assert.equal(created.owner, "U1");
  assert.equal(created.group_id, GROUP);
  assert.equal(created.source_msg_id, "msg-351");
  assert.equal(created.spec.time, "08:00");
  assert.equal(created.spec.topic, "昨日聊天内容总结");
  assert.equal(created.spec.origin, "chat");
  assert.ok(created.spec.request_quote.startsWith("然后悉尼时间每天早上8点"));
  assert.ok(created.spec.request_quote.length <= 200);
  assert.equal(created.spec.dedup, api.slug("昨日聊天内容总结", "msg-351"));
});

test("F6 promiseGuard rewrites the promise when the member's words do not parse", async () => {
  let called = 0;
  const text = "好，每天 8:00 发总结，明早先出一份。";
  const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text }), {
    acceptedActions: [],
    avoid: [],
    userText: "怎么还不回答 你以后去做耗时任务的时候能不能先回答一下",
    owner: "U1",
    groupId: GROUP,
    sourceMsgId: "msg-141",
    createSchedule: async () => {
      called++;
      return null;
    },
    findDuplicate: async () => null,
  });
  const v = JSON.parse(out);
  assert.equal(called, 0);
  assert.equal(v.text, "这个我还没登记上，你说一下每天几点、发什么，我马上建。");
});

test("F6b promiseGuard still catches promises whose question words sit in a later clause", async () => {
  const cases = [
    "以后每天早上 9 点给你推一份汇总，列出当天是否有新 PR。",
    "我会每天 8 点发日报，看看进展如何。",
    "记下了：每天 8 点发日报…可以吗？",
    "好的，以后每天 8 点推日报，不管怎么样都推。",
    "好，每天 9 点给你推汇总，顺便看看是不是有新 PR。",
    "收到，每天早上 8 点发你日报，内容怎么排我来定。",
    "行，每天 8 点发日报，看看进展如何。",
    "没问题，每天 8:00 推昨日总结，顺便说说大家聊得怎么样。",
  ];
  const now = at("2026-11-14T14:30:00+11:00");
  for (const [i, text] of cases.entries()) {
    const created = [];
    const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text }), {
      acceptedActions: [],
      avoid: [],
      userText: TOO,
      owner: "U1",
      groupId: GROUP,
      sourceMsgId: `msg-promise-${i}`,
      now,
      createSchedule: async (input) => {
        created.push(input);
        return {
          id: `sched-${i}`,
          group_id: GROUP,
          owner: "U1",
          kind: input.kind,
          tz: "Australia/Sydney",
          spec: input.spec,
          next_run_at: at("2026-11-15T08:00:00+11:00"),
          created_at: now,
          source_msg_id: input.source_msg_id,
        };
      },
      findDuplicate: async () => null,
    });
    assert.equal(created.length, 1, `case ${i + 1} must be registered: ${text}`);
    assert.ok(JSON.parse(out).text.startsWith("记下了，"), `case ${i + 1} must get the ack`);
  }
});

test("F6c VL-6 original sentence is still treated as asking for consent", async () => {
  for (const text of ["每天早 8 点推送，要吗？", "要我记下每天 8 点给你发日报吗？"]) {
    let created = 0;
    const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text }), {
      acceptedActions: [],
      avoid: [],
      userText: TOO,
      owner: "U1",
      groupId: GROUP,
      sourceMsgId: "msg-vl6",
      createSchedule: async () => {
        created++;
        return null;
      },
      findDuplicate: async () => null,
    });
    assert.equal(created, 0, `a consent question must not register a schedule: ${text}`);
    assert.equal(out, JSON.stringify({ mode: "work", text }));
  }
});

test("F7 an active schedule within ten minutes is reused, not recreated", async () => {
  let called = 0;
  const dup = {
    id: "sched-digest_daily-old",
    kind: "digest_daily",
    tz: "Australia/Sydney",
    spec: { time: "08:00", topic: "昨日聊天内容总结", origin: "chat" },
    next_run_at: at("2026-11-15T08:00:00+11:00"),
  };
  const out = await api.finalizeSpoken(JSON.stringify({ mode: "work", text: PROMISE }), {
    acceptedActions: [],
    avoid: [],
    userText: TOO,
    owner: "U1",
    groupId: GROUP,
    sourceMsgId: "msg-351",
    now: at("2026-11-14T14:30:00+11:00"),
    createSchedule: async () => {
      called++;
      return null;
    },
    findDuplicate: async (kind, nextRunAt) => {
      assert.equal(kind, "digest_daily");
      assert.equal(nextRunAt, at("2026-11-15T08:00:00+11:00"));
      return dup;
    },
  });
  const v = JSON.parse(out);
  assert.equal(called, 0);
  assert.ok(v.text.startsWith("已经在发了，每天 08:00（悉尼）发昨日聊天内容总结"));
});

test("F8 schedule_create passes topic/origin/quote and returns say; no-topic stays compatible", async () => {
  const e = env();
  let s = stub([call("schedule_create", { kind: "digest_daily", time: "08:00", topic: "礼物日早报" })]);
  let answer;
  try {
    answer = await sem.agentAnswer(e, await contextFor(e, { id: "msg-351", body: TOO }));
  } finally {
    s.restore();
  }
  const created = await row(e, "SELECT * FROM schedules WHERE kind='digest_daily'");
  const spec = JSON.parse(created.spec);
  assert.equal(spec.topic, "礼物日早报");
  assert.equal(spec.origin, "chat");
  assert.ok(spec.request_quote.startsWith("然后悉尼时间每天早上8点"));
  assert.equal(created.source_msg_id, "msg-351");
  assert.match(spec.dedup, /^rpt-[a-z0-9]{3,6}$/);

  const results = s.seen
    .flatMap((b) => b.messages || [])
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content));
  const result = results.find((r) => r.say);
  assert.ok(result, "schedule_create result missing say");
  assert.match(
    result.say,
    /^记下了，每天 08:00（悉尼）发礼物日早报，第一次是 .+（悉尼）。不想要了回那条推送说「不用再发了」。$/,
  );
  assert.ok(JSON.parse(answer).text.includes("记下了"), "final reply must carry the code ack");

  const names = s.seen[0].tools.map((t) => t.function.name);
  assert.equal(new Set(names).size, names.length, "tool names must stay unique");
  const createTool = s.seen[0].tools.find((t) => t.function.name === "schedule_create");
  assert.ok(createTool.function.description.includes("没调用成功前，不要说『明早 X 点会发』"));
  assert.ok(createTool.function.description.includes("用现有消息就能写出来的定时推送直接登记，不要提功能需求"));
  assert.ok(createTool.function.parameters.properties.topic, "topic is an exposed parameter");
  assert.equal(createTool.function.parameters.properties.dedup, undefined, "dedup must not be exposed");

  const e2 = env();
  s = stub([call("schedule_create", { kind: "digest_daily", time: "09:00" })]);
  try {
    await sem.agentAnswer(e2, await contextFor(e2, { id: "msg-old", body: "帮我定个每天九点的日报" }));
  } finally {
    s.restore();
  }
  const old = await row(e2, "SELECT * FROM schedules WHERE kind='digest_daily'");
  const oldSpec = JSON.parse(old.spec);
  assert.equal(oldSpec.time, "09:00");
  assert.equal(oldSpec.topic, undefined);
  assert.equal(old.source_msg_id, "msg-old");
});

test("F9 schedule_cancel can cancel by unique topic and asks when several match", async () => {
  const now = Date.now();
  const seed = async (e, id, time, topic, dedup) =>
    api.createSchedule(
      e,
      { group_id: GROUP, owner: "U1", kind: "digest_daily", spec: { time, topic, dedup }, source_msg_id: id },
      now,
    );

  // 唯一命中：只给主题。
  const e1 = env();
  await seed(e1, "m1", "08:00", "礼物日早报", "gift-daily");
  await seed(e1, "m2", "09:00", "周报", "weekly-report");
  let s = stub([call("schedule_cancel", { topic: "礼物" })]);
  try {
    await sem.agentAnswer(e1, await contextFor(e1, { id: "msg-cancel-1", body: "把礼物早报那个停了" }));
  } finally {
    s.restore();
  }
  assert.equal((await row(e1, "SELECT * FROM schedules WHERE id=?", "sched-digest_daily-m1")).status, "cancelled");
  assert.equal((await row(e1, "SELECT * FROM schedules WHERE id=?", "sched-digest_daily-m2")).status, "active");

  // 多个命中：返回列表让模型问，两个都不取消。
  const e2 = env();
  await seed(e2, "m3", "08:00", "礼物日早报", "gift-daily2");
  await seed(e2, "m4", "09:00", "周报", "weekly-report2");
  s = stub([call("schedule_cancel", { topic: "报" })]);
  try {
    await sem.agentAnswer(e2, await contextFor(e2, { id: "msg-cancel-2", body: "把报停一下" }));
  } finally {
    s.restore();
  }
  const ambiguous = s.seen
    .flatMap((b) => b.messages || [])
    .filter((m) => m.role === "tool")
    .map((m) => JSON.parse(m.content))
    .find((r) => r.error_kind === "ambiguous");
  assert.ok(ambiguous, "several topic matches must be returned to the model");
  assert.equal(ambiguous.candidates.length, 2);
  assert.equal((await rows(e2, "SELECT * FROM schedules WHERE status='active'")).length, 2);

  // 老行为：按 id 取消。
  const e3 = env();
  await seed(e3, "m5", "08:00", "周报", "weekly-report3");
  s = stub([call("schedule_cancel", { id: "sched-digest_daily-m5" })]);
  try {
    await sem.agentAnswer(e3, await contextFor(e3, { id: "msg-cancel-3", body: "取消周报" }));
  } finally {
    s.restore();
  }
  assert.equal((await row(e3, "SELECT * FROM schedules WHERE id=?", "sched-digest_daily-m5")).status, "cancelled");
});

test("F10 the non-tool reply path is also finalised (real promise, no tool call)", async () => {
  const e = env();
  const s = stub(
    [reply('{"action":"reply","kind":"direct","brief":"答应他持续推。"}')],
    JSON.stringify({ mode: "work", text: PROMISE }),
  );
  let answer;
  try {
    answer = await sem.agentAnswer(e, await contextFor(e, { id: "msg-351", body: TOO }));
  } finally {
    s.restore();
  }
  const created = await rows(e, "SELECT * FROM schedules WHERE kind='digest_daily'");
  assert.equal(created.length, 1, "promiseGuard must register exactly one schedule");
  assert.ok(JSON.parse(answer).text.startsWith("记下了，"));
  console.log("B-l2 回放：QQ 真实发送 0 次（本地假 D1，未调用 sendOutbox），线上 D1 写入 0 行");
});
