// D6：执行入口 run_steps / run_task、S-07 导出投递、S-12/S-13 权限与
// job-start / job-progress / job-stale 回执。D3a 未合，测试用 esbuild alias
// 把 ../actions 换成可控 stub（真实动作层由 src/actions.ts 提供）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { env, req } from "./support.mjs";

const STUB = `
export const calls = (globalThis.__runCalls ||= { validate: [], run: [], join: [] });
const OK = new Set(["records_summary","records_query","quota","token_usage","chat_digest","work_status","text"]);
export function validateSteps(steps) {
  calls.validate.push(steps);
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6)
    return { ok: false, reason: "步骤数量要在 1-6 之间" };
  if (steps.some(s => !s || !OK.has(s.action)))
    return { ok: false, reason: "不支持的动作：" + steps.map(s => s && s.action).join(",") };
  return { ok: true, steps };
}
export async function runSteps(ctx, steps) {
  calls.run.push({ ctx, steps });
  return steps.map(s => ({ action: s.action, ok: true, text: "结果：" + (s.text || s.action) }));
}
export function joinResults(results, title) {
  calls.join.push(results);
  return (title ? title + "\\n" : "") + results.map(r => r.text).join("\\n");
}
`;

// The stub captures this object at module evaluation, so it must exist before import.
globalThis.__runCalls = { validate: [], run: [], join: [] };
const out = `.wrangler/run-task-${process.pid}.mjs`;
await build({
  stdin: {
    contents:
      'export * from "./src/tools/run";' +
      'export { default as worker } from "./src/worker";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: out,
  plugins: [
    {
      name: "actions-stub",
      setup(builder) {
        builder.onLoad({ filter: /src[\\/]actions\.ts$/ }, () => ({
          contents: STUB,
          loader: "ts",
        }));
      },
    },
  ],
});
const m = await import("../" + out);
rmSync(out);

const G = "GROUP000001";
const BODY = "帮我跑一下：统计 runner/ 目录下 py 文件行数，发群里";
const QUOTE = "统计 runner/ 目录下 py 文件行数";
function clearCalls() {
  const calls = globalThis.__runCalls;
  calls.validate.length = 0;
  calls.run.length = 0;
  calls.join.length = 0;
}

function fresh() {
  const e = env();
  e.testWorker = m.worker;
  return e;
}
function rows(e, table) {
  return e.DB.prepare("SELECT * FROM " + table).all().then(x => x.results);
}
async function count(e, table) {
  return (await e.DB.prepare("SELECT COUNT(*) AS n FROM " + table).first()).n;
}
async function member(e, id = "owner1", role = "owner") {
  await e.DB.prepare(
    "INSERT INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,0)",
  )
    .bind("qq:" + id, "测试成员", "hash-" + id, role)
    .run();
}
async function message(e, id = "m1") {
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)",
  )
    .bind(id, G, "owner1", BODY, new Date().toISOString())
    .run();
}
function ctx({
  sender = "owner1",
  direct = true,
  tainted = false,
  quote = QUOTE,
  body = BODY,
  id = "m1",
} = {}) {
  const latest = {
    id,
    group_id: G,
    sender,
    body,
    meta: { direct },
  };
  return {
    context: { latest, batch: [latest], names: new Map([["owner1", "老板"]]) },
    source: latest,
    messages: [],
    isTainted: () => tainted,
  };
}
function args(over = {}) {
  return {
    title: "统计行数",
    instructions: "统计 runner/ 目录下 py 文件行数，把结果发群里",
    request_quote: QUOTE,
    ...over,
  };
}
async function tick(e) {
  let work;
  await m.worker.scheduled({}, e, { waitUntil(p) { work = p; } });
  if (work) await work;
}

test("S-12 管理员 direct 入队 exec job，回执带短号", async () => {
  const e = fresh();
  await member(e);
  const r = await m.runTaskTool.run(e, args(), ctx());
  assert.equal(r.ok, true);
  assert.equal(r.accepted, true);
  assert.equal(r.family, "job");
  assert.equal(r.id, "exec-m1");
  assert.equal(r.say, "已排队 #xec-m1，开始和结束我都会在群里说");
  const jobs = await rows(e, "jobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "exec-m1");
  assert.equal(jobs[0].kind, "media");
  const p = JSON.parse(jobs[0].payload);
  assert.equal(p.mode, "exec");
  assert.equal(p.message, "m1");
  assert.equal(p.title, "统计行数");
  assert.match(p.instructions, /统计 runner/);
  assert.equal(p.want_files, false);
  assert.equal(p.effort, "high");
  assert.equal(p.lane, "quick");
  assert.equal(p.request_quote, QUOTE);
});

test("S-13 普通成员、非 direct、被污染、引用不在原话各拒一例且 jobs 不增", async () => {
  const noProof = () => {
    const c = ctx();
    delete c.isTainted;
    return c;
  };
  const cases = [
    ["普通成员", async (e) => member(e, "owner1", "member"), ctx()],
    ["非 direct", async () => {}, ctx({ direct: false })],
    ["被污染", async () => {}, ctx({ tainted: true })],
    ["引用不在原话", async () => {}, ctx({ quote: "统计 Java 文件行数" })],
    ["无法证明本轮干净", async () => {}, noProof()],
  ];
  for (const [label, setup, c] of cases) {
    const e = fresh();
    await setup(e);
    const r = await m.runTaskTool.run(e, args(), c);
    assert.equal(r.ok, false, label);
    assert.equal(r.error_kind, "denied", label);
    assert.equal(
      r.say,
      "本机执行只有管理员能派；你可以让我现在出账本/余额/总结这类即时结果",
      label,
    );
    assert.equal(await count(e, "jobs"), 0, label);
  }
});

test("显式 source_id 找不到时不退回最新一条", async () => {
  const e = fresh();
  await member(e);
  const r = await m.runTaskTool.run(
    e,
    args({ request_quote: BODY, source_id: "not-in-batch" }),
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "denied");
  assert.equal(await count(e, "jobs"), 0);
});

test("run_steps 走 validateSteps→runSteps(purpose=chat)→joinResults，jobs 不增", async () => {
  const e = fresh();
  await member(e);
  clearCalls();
  const r = await m.runStepsTool.run(
    e,
    { steps: [{ action: "quota" }, { action: "text", text: "余额 100" }] },
    ctx(),
  );
  assert.equal(r.ok, true);
  assert.match(r.text, /结果：quota/);
  assert.match(r.text, /结果：余额 100/);
  const run = globalThis.__runCalls.run.at(-1);
  assert.equal(run.ctx.purpose, "chat");
  assert.equal(run.ctx.groupId, G);
  assert.equal(run.ctx.viewer.isAdmin, true);
  assert.equal(run.ctx.viewer.name, "老板");
  assert.equal(run.ctx.tz, "Australia/Sydney");
  assert.equal(await count(e, "jobs"), 0);
});

test("run_steps 拒绝不在白名单的动作，不跑动作层", async () => {
  const e = fresh();
  clearCalls();
  const r = await m.runStepsTool.run(
    e,
    { steps: [{ action: "run_sql", text: "drop table jobs" }] },
    ctx(),
  );
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "invalid");
  assert.match(r.reason_text, /不支持的动作/);
  assert.equal(globalThis.__runCalls.run.length, 0);
});

test("S-12 claim 后写 job-start 回执，重复 claim 只留一行", async () => {
  const e = fresh();
  await message(e);
  const payload = {
    message: "m1",
    title: "统计行数",
    instructions: "统计行数",
    mode: "exec",
    want_files: false,
    effort: "high",
    lane: "quick",
  };
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,0,0,?)",
  )
    .bind("exec-m1", "media", JSON.stringify(payload), "pending", Date.now())
    .run();
  const first = await (
    await req(e, "/api/runner/media/claim", { mode: "quick" }, "runner-secret")
  ).json();
  assert.equal(first.job.id, "exec-m1");
  const outbox = await rows(e, "outbox");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, "job-start:exec-m1");
  assert.equal(outbox[0].group_id, G);
  assert.equal(outbox[0].msg_id, "m1");
  assert.equal(outbox[0].body, "开始执行 #xec-m1：统计行数");
  // 同一个 job 再次被 claim 时不追加第二条开始回执。
  await e.DB.prepare(
    "UPDATE jobs SET status='pending',lease_until=0,attempts=1 WHERE id='exec-m1'",
  ).run();
  await req(e, "/api/runner/media/claim", { mode: "quick" }, "runner-secret");
  assert.equal(await count(e, "outbox"), 1);
});

test("S-12 cron 第 5–15 分钟发一次 job-progress:5，重跑不重复", async () => {
  const e = fresh();
  await message(e);
  const at = Date.now();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,1,?,?)",
  )
    .bind(
      "exec-m1",
      "media",
      JSON.stringify({ message: "m1", title: "统计行数", mode: "exec" }),
      "running",
      at + 600000,
      at - 6 * 60000,
    )
    .run();
  await e.DB.prepare(
    "INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind("job-start:exec-m1", G, "m1", "开始执行 #xec-m1", "pending", at - 6 * 60000)
    .run();
  await tick(e);
  await tick(e);
  const progress = (await rows(e, "outbox")).filter((x) => x.id.startsWith("job-progress:"));
  assert.equal(progress.length, 1);
  assert.equal(progress[0].id, "job-progress:exec-m1:5");
  assert.match(progress[0].body, /^还在跑，已 \d+ 分钟$/);
  assert.ok(Number(progress[0].body.match(/已 (\d+) 分钟/)[1]) >= 5);
});

test("S-12 超过 15 分钟发 job-progress:15，不再补 :5", async () => {
  const e = fresh();
  await message(e);
  const at = Date.now();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,attempts,lease_until,created_at) VALUES(?,?,?,?,1,?,?)",
  )
    .bind(
      "exec-m1",
      "media",
      JSON.stringify({ message: "m1", title: "统计行数", mode: "exec" }),
      "running",
      at + 600000,
      at - 16 * 60000,
    )
    .run();
  await e.DB.prepare(
    "INSERT INTO outbox(id,group_id,msg_id,body,status,created_at) VALUES(?,?,?,?,?,?)",
  )
    .bind("job-start:exec-m1", G, "m1", "开始执行 #xec-m1", "pending", at - 16 * 60000)
    .run();
  await tick(e);
  const ids = (await rows(e, "outbox")).map((x) => x.id);
  assert.ok(ids.includes("job-progress:exec-m1:15"));
  assert.ok(!ids.includes("job-progress:exec-m1:5"));
});

test("排队超过 10 分钟发一次 job-stale，非 exec 任务不发", async () => {
  const e = fresh();
  await message(e);
  const at = Date.now();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      "exec-m2",
      "media",
      JSON.stringify({ message: "m1", title: "统计行数", mode: "exec" }),
      "pending",
      at - 11 * 60000,
    )
    .run();
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      "media-old",
      "media",
      JSON.stringify({ message: "m1", effort: "high", lane: "quick" }),
      "pending",
      at - 20 * 60000,
    )
    .run();
  await tick(e);
  await tick(e);
  const outbox = await rows(e, "outbox");
  assert.equal(outbox.filter((x) => x.id === "job-stale:exec-m2").length, 1);
  assert.equal(
    outbox.find((x) => x.id === "job-stale:exec-m2").body,
    "执行端不在线，任务还在排队 #xec-m2",
  );
  assert.ok(!outbox.some((x) => x.id.startsWith("job-stale:media-old")));
  assert.ok(!outbox.some((x) => x.id.startsWith("job-progress:media-old")));
});

test("S-07 runner 在线入队 mode=file，CSV 原样 base64", async () => {
  const e = fresh();
  await e.DB.prepare("INSERT INTO settings VALUES(?,?)")
    .bind("runner_seen", new Date().toISOString())
    .run();
  const csv = "\ufeff项目,金额\n餐费,10\n";
  const r = await m.enqueueExportFile(e, {
    groupId: G,
    sourceId: "m9",
    filename: "报销.csv",
    csv,
  });
  assert.equal(r.online, true);
  assert.equal(r.id, "export-m9");
  const jobs = await rows(e, "jobs");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, "export-m9");
  const p = JSON.parse(jobs[0].payload);
  assert.equal(p.mode, "file");
  assert.equal(p.message, "m9");
  assert.equal(p.want_files, true);
  assert.equal(p.effort, "high");
  assert.equal(p.lane, "quick");
  assert.equal(p.file.name, "报销.csv");
  assert.equal(Buffer.from(p.file.content_b64, "base64").toString("utf8"), csv);
});

test("S-07 runner 离线只回 online:false，不入队；重复导出只一行", async () => {
  const e = fresh();
  await e.DB.prepare("INSERT INTO settings VALUES(?,?)")
    .bind("runner_seen", new Date(Date.now() - 11 * 60000).toISOString())
    .run();
  const offline = await m.enqueueExportFile(e, {
    groupId: G,
    sourceId: "m9",
    filename: "报销.csv",
    csv: "a,b\n1,2\n",
  });
  assert.deepEqual(offline, { online: false });
  assert.equal(await count(e, "jobs"), 0);
  await e.DB.prepare("UPDATE settings SET value=? WHERE key='runner_seen'")
    .bind(new Date().toISOString())
    .run();
  await m.enqueueExportFile(e, { groupId: G, sourceId: "m9", filename: "a.csv", csv: "a\n1\n" });
  await m.enqueueExportFile(e, { groupId: G, sourceId: "m9", filename: "a.csv", csv: "a\n1\n" });
  assert.equal(await count(e, "jobs"), 1);
});
