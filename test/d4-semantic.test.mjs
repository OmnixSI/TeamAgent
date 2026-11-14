// D4 阶段 2：semantic 接线（LOCAL_TOOLS / 收件箱任务 / 账本直写 / pending 注入）+
// RC-07 真实解析器补时。全部本地假 D1，不发 QQ、不写线上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { env } from "./support.mjs";

const outfile = `.wrangler/d4-semantic-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export { agentAnswer, LOCAL_TOOLS } from "./src/semantic";' +
      'export { scheduleCreateTool } from "./src/tools/schedule-tools";' +
      'export { BOARD_INBOX, createBoardTask } from "./src/tasks";' +
      'export { defineRecordType, addRecords } from "./src/records";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile,
});
const api = await import("../" + outfile);
const GROUP = "GROUP000001";

const call = (name, args) => ({
  id: "call-" + name + "-" + Math.random().toString(36).slice(2, 7),
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const reply = (content = '{"action":"reply","kind":"direct","brief":"好。"}') => ({
  role: "assistant",
  content,
});

function stub(steps = [], voice = '{"mode":"work","text":"好。"}', extract = null) {
  const old = globalThis.fetch;
  const seen = [];
  const queue = [...steps];
  globalThis.fetch = async (url, opt) => {
    if (!/api\.deepseek\.com/.test(String(url))) return Response.json({});
    const body = JSON.parse(opt.body || "{}");
    seen.push(body);
    if (body.response_format?.type === "json_object")
      return Response.json({ choices: [{ message: { content: JSON.stringify(extract || {}) }, finish_reason: "stop" }] });
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
  return {
    latest: row,
    batch: [row],
    recent: [row],
    names: new Map(),
    refs: new Map(),
    mentioned: !!mentioned,
  };
}

const row = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).first();
const rows = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

/** D1 的账本表（migrations/0090_records.sql）在 schema.sql 之外，测试里按文件建。 */
function recordsSchema(e) {
  for (const statement of readFileSync("migrations/0090_records.sql", "utf8").split(";")) {
    const sql = statement
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (sql) e.DB.prepare(sql).run();
  }
}

test("D4-1 LOCAL_TOOLS covers every local write tool so none falls into research", () => {
  for (const name of [
    "records_read", "records_write",
    "schedule_create", "schedule_update", "schedule_list", "schedule_cancel",
    "skill_save", "skill_run", "skill_list", "skill_disable",
    "run_steps", "run_task",
  ])
    assert.ok(api.LOCAL_TOOLS.has(name), name);
});

test("D4-2 prepare_project_task accepts an omitted repo and the inbox task is created (RC-04)", async () => {
  const e = env();
  const s = stub([reply()]);
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-schema", body: "你好" }));
  } finally {
    s.restore();
  }
  const def = s.seen[0].tools.find((t) => t.function.name === "prepare_project_task");
  assert.ok(def, "prepare_project_task must stay offered");
  assert.equal(def.function.parameters.properties.repo.enum, undefined, "repo is no longer a 6-way enum");
  assert.deepEqual(def.function.parameters.required, ["title", "detail", "request_quote", "complexity"]);

  const id = await api.createBoardTask(
    e,
    { repo: api.BOARD_INBOX, title: "工作台 UI 修改指导", detail: "整理成工作台任务" },
    { name: "U1" },
  );
  const created = await row(e, "SELECT * FROM tasks WHERE id=?", id);
  assert.equal(created.repo, "inbox");
  assert.equal(created.status, "proposal");
});

test("D4-3 records_write runs in-turn (no research job) and its claim is kept", async () => {
  const e = env();
  recordsSchema(e);
  const s = stub(
    [
      call("records_write", {
        op: "add",
        kind: "ledger",
        name: "账本",
        rows: [{ person: "我", amount_cents: 36000 }],
        request_quote: "记账：我￥360",
        source_id: "msg-ledger",
      }),
    ],
    '{"mode":"work","text":"记好了，我 360。"}',
  );
  let answer;
  try {
    answer = await api.agentAnswer(e, await contextFor(e, { id: "msg-ledger", body: "记账：我￥360" }));
  } finally {
    s.restore();
  }
  assert.equal((await rows(e, "SELECT * FROM jobs WHERE kind='research'")).length, 0, "must not defer to research");
  assert.equal((await rows(e, "SELECT * FROM records")).length, 1, "ledger row missing");
  const text = JSON.parse(answer).text;
  assert.ok(text.includes("记好了"), text);
  assert.ok(!text.includes("没记上"), text);
});

test("D4-4 an open pending is injected into the turn payload, and only for time-like messages", async () => {
  const e = env();
  const now = Date.now();
  await e.DB.prepare(
    "INSERT INTO pending_actions(id,group_id,sender,tool,draft,missing,status,asked_at,expires_at) VALUES(?,?,?,?,?,?,'open',?,?)",
  )
    .bind("pa-rc07", GROUP, "U1", "schedule_create", JSON.stringify({ when_text: "每天固定时间发余额", content_text: "发余额" }), "time", now, now + 600000)
    .run();
  let s = stub([reply()]);
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-pending", body: "北京时间0点" }));
  } finally {
    s.restore();
  }
  const payload = s.seen[0]?.messages?.[1]?.content || "";
  assert.ok(payload.includes("pa-rc07"), "pending id must reach the model");
  assert.ok(payload.includes("每天固定时间发余额"), "pending draft must reach the model");

  s = stub([reply()]);
  try {
    await api.agentAnswer(e, await contextFor(e, { id: "msg-plain", body: "辛苦了，多谢" }));
  } finally {
    s.restore();
  }
  assert.ok(!String(s.seen[0]?.messages?.[1]?.content || "").includes("pa-rc07"), "a plain chat message must not pay for the pending query");
});

test("D4-5 RC-07: 北京时间0点 completes the pending created by 每天固定时间 (real parser)", async () => {
  const e = env();
  const ctx = (body, id) => ({
    context: { latest: { group_id: "G1", sender: "U1", id, body } },
    source: { group_id: "G1", sender: "U1", id, body },
    messages: [],
    isTainted: () => false,
  });
  const first = await api.scheduleCreateTool.run(
    e,
    {},
    ctx("每天固定时间发一下每天的余额和 token 用量", "m-482"),
  );
  assert.equal(first.need, "time");
  const pending = await row(e, "SELECT * FROM pending_actions WHERE id=?", first.pending_id);
  const draft = JSON.parse(pending.draft);
  assert.ok(draft.when_text.includes("每天固定时间"), "pending must store when_text");

  const second = await api.scheduleCreateTool.run(e, { pending_id: first.pending_id }, ctx("北京时间0点", "m-484"));
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.kind, "agent_task");
  const spec = JSON.parse((await row(e, "SELECT * FROM schedules WHERE id=?", second.id)).spec);
  assert.equal(spec.time, "00:00");
  assert.equal(spec.cadence, "daily");
  assert.equal((await row(e, "SELECT * FROM schedules WHERE id=?", second.id)).tz, "Asia/Shanghai");
  assert.equal((await row(e, "SELECT * FROM pending_actions WHERE id=?", first.pending_id)).status, "done");
});

test("D4-6 a ledger claim with no tool call is landed through the JSON fallback", async () => {
  const e = env();
  recordsSchema(e);
  const write = {
    e, groupId: GROUP, actor: { sender: "U1", name: "U1", isAdmin: true },
    sourceMsgId: "seed", dedupBase: "seed", now: Date.now(), names: new Map(),
  };
  const { type } = await api.defineRecordType(write, { name: "报销额度", kind: "ledger" });
  await api.addRecords(write, type.id, [
    { person: "TOO", amount: "360" },
    { person: "卡特龙", amount: "50" },
    { person: "Souvereign", amount: "90" },
  ]);
  const s = stub(
    [reply('{"action":"reply","kind":"direct","brief":"按原话记账。"}')],
    '{"mode":"work","text":"记好了，TOO 加 10。"}',
    { op: "add", type: "报销额度", person: "TOO", amount: "10" },
  );
  let answer;
  try {
    answer = await api.agentAnswer(e, await contextFor(e, { id: "msg-land", body: "我加10" }));
  } finally {
    s.restore();
  }
  const records = await rows(e, "SELECT person,amount_cents FROM records WHERE deleted_at IS NULL");
  assert.equal(records.length, 4, JSON.stringify(records));
  assert.equal(records.filter((r) => r.person === "TOO").reduce((n, r) => n + Number(r.amount_cents), 0), 37000);
  const text = JSON.parse(answer).text;
  assert.match(text, /370/);
  assert.match(text, /510/);
  assert.ok(!text.includes("没记上"), text);
});
