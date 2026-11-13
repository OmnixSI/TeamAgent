// V-B · B-1t：D-1..D-26 先写红。
// 规格：.agent/releases/V-B-capability/design.md「包 B-1t」「接口与数据结构」；
// 场景逐字照 ref/plan-bot-capability-v1.md:1222-1251，D-23 用 design 调整后的表。
// 跑法：node --test test/subagent.test.mjs
//
// 现在 src/subagent.ts 不存在，src/semantic.ts 也还没有 inlineable/createProjectTask。
// 每条测试先动态加载模块并检查导出名，所以现在 26 条全红，第一条失败原因都是
// 「未实现：...」，不是语法错误。B-1/B-3/B-4w 交付后同一条测试转绿。
//
// 说明：D 系列只断言 error_kind / next_action 的行为；capabilities.ts 的 C2 文案断言
// 属于 B-2 自己的测试，这里不 import，避免 C3 测试被 C2 的交付顺序卡住。
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { build } from "esbuild";
import { worker } from "./support.mjs";

const GROUP = "GROUP000001";
const REPO = "OmnixSI/TeamAgent";
const TOTAL = 10 * 60_000;
const MIN_RUN = 330_000;
const LEASE = 60_000;
const GRACE = 30_000;
const HEX40 = "b".repeat(40);

// ---------------------------------------------------------------- module loading

const built = new Map();
const outfiles = [];

async function source(name) {
  if (built.has(name)) return built.get(name);
  const outfile = `.wrangler/subagent-test-${process.pid}-${name}.mjs`;
  outfiles.push(outfile);
  try {
    await build({
      entryPoints: [`src/${name}.ts`],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile,
    });
  } catch (err) {
    throw new Error(
      `未实现：src/${name}.ts 不存在或无法构建（${String(err.message).split("\n")[0]}）`,
    );
  }
  const mod = await import("../" + outfile);
  built.set(name, mod);
  return mod;
}

async function need(name, exports) {
  const mod = await source(name);
  for (const key of exports)
    if (!(key in mod))
      throw new Error(`未实现：src/${name}.ts 未导出 ${key}`);
  return mod;
}

const subagent = () =>
  need("subagent", [
    "delegateTool",
    "SIDE_EFFECT_FOREGROUND",
    "runDelegate",
    "cancelByOwner",
    "subagentRoute",
    "expireSubagents",
    "deliverSubagent",
  ]);

const semantic = () => need("semantic", ["agentAnswer"]);

after(() => {
  for (const file of outfiles) {
    try {
      rmSync(file, { force: true });
    } catch {}
  }
});

// ---------------------------------------------------------------- SQLite / env

const SUBAGENT_DDL = `
CREATE TABLE IF NOT EXISTS subagent_runs(
  id TEXT PRIMARY KEY, role TEXT NOT NULL, repo TEXT NOT NULL, ref TEXT NOT NULL, question TEXT NOT NULL,
  tainted INTEGER NOT NULL DEFAULT 0, requester TEXT NOT NULL, group_id TEXT NOT NULL, source_msg TEXT NOT NULL,
  status TEXT NOT NULL, lease TEXT, lease_until INTEGER, progress TEXT, result TEXT, error_kind TEXT,
  resolved_sha TEXT,
  created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, deadline INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS subagent_runs_status ON subagent_runs(status, created_at);
CREATE INDEX IF NOT EXISTS subagent_runs_requester ON subagent_runs(requester, created_at);
`;

function makeEnv() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  d.exec(SUBAGENT_DDL);
  const database = {
    executed: 0,
    batches: 0,
    batchSizes: [],
    writes: 0,
    failBatchAt: 0,
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        args,
        bind(...values) {
          return statement(
            values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v)),
          );
        },
        async first() {
          database.executed++;
          return d.prepare(sql).get(...args) ?? null;
        },
        async all() {
          database.executed++;
          return { results: d.prepare(sql).all(...args) };
        },
        async run() {
          database.executed++;
          database.writes++;
          const r = d.prepare(sql).run(...args);
          return {
            success: true,
            meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
          };
        },
      });
      return statement();
    },
    async batch(statements) {
      database.batches++;
      database.batchSizes.push(statements.length);
      d.exec("BEGIN");
      const out = [];
      try {
        for (let i = 0; i < statements.length; i++) {
          if (database.failBatchAt === i + 1)
            throw new Error(`注入失败：第 ${i + 1} 条语句`);
          const s = statements[i];
          const args = s.args || [];
          database.executed++;
          const read = /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql);
          if (read) {
            out.push({ results: d.prepare(s.sql).all(...args) });
          } else {
            database.writes++;
            const r = d.prepare(s.sql).run(...args);
            out.push({
              success: true,
              meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) },
            });
          }
        }
        d.exec("COMMIT");
      } catch (err) {
        d.exec("ROLLBACK");
        throw err;
      }
      return out;
    },
  };
  return {
    DB: database,
    ADMIN_TOKEN: "owner-secret",
    RUNNER_TOKEN: "runner-secret",
    QQ_APP_SECRET: "test-only-secret",
    DEEPSEEK_API_KEY: "fake",
    WORK: {
      sent: [],
      async send(body, opts) {
        this.sent.push({ body, opts });
      },
    },
  };
}

function reset(e) {
  e.DB.executed = 0;
  e.DB.batches = 0;
  e.DB.batchSizes = [];
}

const all = async (e, sql, ...args) =>
  (await e.DB.prepare(sql).bind(...args).all()).results;
const one = async (e, sql, ...args) =>
  (await e.DB.prepare(sql).bind(...args).first()) ?? null;
const count = async (e, table, where = "1=1", ...args) =>
  Number((await one(e, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...args)).n);

async function seedRun(e, x = {}) {
  const createdAt = x.created_at ?? Date.now();
  const id = x.id ?? "sub-seed-1";
  await e.DB.prepare(
    `INSERT INTO subagent_runs(
       id,role,repo,ref,question,tainted,requester,group_id,source_msg,status,lease,lease_until,
       progress,result,error_kind,resolved_sha,created_at,started_at,finished_at,deadline
     ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      x.role ?? "code_reader",
      x.repo ?? REPO,
      x.ref ?? "main",
      x.question ?? "登录流程在哪",
      x.tainted ?? 0,
      x.requester ?? "U1",
      x.group_id ?? GROUP,
      x.source_msg ?? "source-1",
      x.status ?? "queued",
      x.lease ?? null,
      x.lease_until ?? null,
      x.progress ?? null,
      x.result ?? null,
      x.error_kind ?? null,
      x.resolved_sha ?? null,
      createdAt,
      x.started_at ?? null,
      x.finished_at ?? null,
      x.deadline ?? createdAt + TOTAL,
    )
    .run();
  return id;
}

// ---------------------------------------------------------------- request / context

function context(id = "current", extra = {}, body = "请读一下登录流程") {
  const latest = {
    id,
    group_id: GROUP,
    sender: "U1",
    body,
    ts: new Date().toISOString(),
    mentioned: 1,
    meta: { direct: true },
  };
  return {
    latest,
    batch: [latest],
    recent: [latest],
    names: new Map(),
    refs: new Map(),
    mentioned: true,
    decisionOut: { kind: "direct" },
    switches: {},
    background: false,
    ...extra,
  };
}

const toolCall = (name, args = {}) => ({
  id: "call-" + name,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

async function route(api, e, name, payload) {
  const path = "/api/runner/subagent/" + name;
  const res = await api.subagentRoute(
    e,
    new Request("https://team.example" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
    path,
  );
  assert.ok(res, "subagentRoute 没有处理 " + name);
  return res;
}

const claimOf = (body) => body?.run ?? (body?.id ? body : null);

async function postWorker(e, path, payload, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return worker.fetch(
    new Request("https://team.example" + path, {
      method: "POST",
      headers,
      body: JSON.stringify(payload ?? {}),
    }),
    e,
  );
}

function failure(r, kind) {
  assert.equal(r?.ok, false, "应为 ToolFailure：" + JSON.stringify(r));
  assert.equal(r.error_kind, kind);
  assert.equal(typeof r.next_action, "string", "ToolFailure 必须带 next_action");
  assert.equal(
    r.retryable,
    ["budget", "timeout", "runner_offline", "upstream"].includes(kind),
    "retryable 只对 budget/timeout/runner_offline/upstream 为 true",
  );
}

async function withNow(ms, fn) {
  const real = Date.now;
  Date.now = () => ms;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

const voice = (text = "结果已回来。") =>
  Response.json({
    choices: [
      { message: { content: JSON.stringify({ mode: "work", text }) } },
    ],
  });

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

async function runAgent(e, steps, ctx) {
  const api = await semantic();
  const seen = { requests: [], toolResults: [], briefs: [] };
  let index = 0;
  await withFetch(
    async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      seen.requests.push(body);
      const system = String(body.messages?.[0]?.content || "");
      if (system.includes("最后的嘴替模块")) {
        seen.briefs.push(JSON.parse(body.messages[1].content));
        return voice();
      }
      for (const m of body.messages || [])
        if (m.role === "tool") seen.toolResults.push(m.content);
      const step = steps[index++];
      const message = step
        ? { role: "assistant", tool_calls: Array.isArray(step) ? step : [step] }
        : {
            content:
              '{"should_reply":true,"kind":"direct","brief":"按工具结果回答"}',
          };
      return Response.json({ choices: [{ message }] });
    },
    () => api.agentAnswer(e, ctx),
  );
  return seen;
}

function deniedIn(toolResults) {
  for (const raw of toolResults) {
    try {
      const value = JSON.parse(raw);
      if (value?.error_kind === "denied") return value;
    } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- D-1 .. D-26

test("D-1 前台被 @ 时 delegate start 写一行 queued、回复确认、不建 research job、2 条语句", async () => {
  const api = await subagent();
  assert.equal(api.delegateTool.function.name, "delegate");
  assert.ok(api.SIDE_EFFECT_FOREGROUND.has("delegate"));
  const e = makeEnv();
  const ctx = context("current-1");
  reset(e);
  const r = await api.runDelegate(
    e,
    {
      op: "start",
      role: "code_reader",
      repo: REPO,
      ref: "main",
      question: "登录流程在哪",
    },
    ctx,
    [],
  );
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.match(String(r.id), /^sub-current-1-[0-9a-f]{8}$/);
  assert.match(
    String(r.eta || r.message || ""),
    /分钟|已派|收到/,
    "回复里要有确认语",
  );
  const row = await one(e, "SELECT * FROM subagent_runs WHERE id=?", r.id);
  assert.equal(row.status, "queued");
  assert.equal(row.requester, "U1");
  assert.equal(row.source_msg, "current-1");
  assert.equal(row.tainted, 0);
  assert.equal(
    await count(e, "jobs", "kind='research'"),
    0,
    "delegate 不能建 research job",
  );
  assert.equal(e.DB.executed, 2, "start 应正好 2 条语句，实际 " + e.DB.executed);
});

test("D-2 主动插话的回合（没被 @、也不是 direct）返回 unauthorized，不写入", async () => {
  const api = await subagent();
  const e = makeEnv();
  const ctx = context("current-2", {
    mentioned: false,
    decisionOut: { kind: "participation" },
  });
  const r = await api.runDelegate(
    e,
    { op: "start", role: "code_reader", repo: REPO, question: "登录流程在哪" },
    ctx,
    [],
  );
  failure(r, "unauthorized");
  assert.equal(await count(e, "subagent_runs"), 0);
});

test("D-3 同一成员 1 小时内第 4 次 / 全群当天第 31 次返回 budget", async () => {
  const api = await subagent();
  {
    const e = makeEnv();
    const base = Date.now();
    for (let i = 0; i < 3; i++)
      await seedRun(e, {
        id: "sub-m-" + i,
        requester: "U1",
        source_msg: "s-" + i,
        created_at: base - i * 1000,
      });
    const r = await api.runDelegate(
      e,
      {
        op: "start",
        role: "code_reader",
        repo: REPO,
        question: "第四个不同的问题",
      },
      context("current-3"),
      [],
    );
    failure(r, "budget");
    assert.equal(await count(e, "subagent_runs"), 3, "budget 时不能写入第 4 行");
  }
  {
    const e = makeEnv();
    const base = Date.now();
    for (let i = 0; i < 30; i++)
      await seedRun(e, {
        id: "sub-g-" + i,
        requester: "R" + i,
        source_msg: "g-" + i,
        created_at: base - i * 1000,
      });
    const r = await api.runDelegate(
      e,
      {
        op: "start",
        role: "code_reader",
        repo: REPO,
        question: "全群第 31 个",
      },
      context("current-3b"),
      [],
    );
    failure(r, "budget");
    assert.equal(await count(e, "subagent_runs"), 30);
  }
});

test("D-4 已有 2 个 running 时 claim 返回 null，且只用 1 条语句", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, {
    id: "sub-r1",
    status: "running",
    lease: "l1",
    lease_until: base + LEASE,
    deadline: base + 500_000,
    started_at: base,
  });
  await seedRun(e, {
    id: "sub-r2",
    status: "running",
    lease: "l2",
    lease_until: base + LEASE,
    deadline: base + 500_000,
    started_at: base,
  });
  await seedRun(e, { id: "sub-q1", deadline: base + TOTAL });
  reset(e);
  const res = await route(api, e, "claim", {});
  assert.equal(res.status, 200);
  assert.equal(claimOf(await res.json()), null);
  assert.equal(e.DB.executed, 1, "claim 应只用 1 条 UPDATE…RETURNING");
});

test("D-5 cancelled 心跳/report、expired report、别的 lease 报 done 都 409，subrep 只有一个", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, {
    id: "sub-cancel",
    status: "cancelled",
    lease: "lc",
    lease_until: base + LEASE,
    deadline: base + TOTAL,
    finished_at: base,
  });
  await seedRun(e, {
    id: "sub-exp",
    status: "expired",
    lease: "le",
    deadline: base + TOTAL,
    error_kind: "runner_offline",
    finished_at: base,
  });
  await seedRun(e, {
    id: "sub-done",
    status: "done",
    lease: "ld",
    deadline: base + TOTAL,
    result: JSON.stringify({ answer: "完", citations: [] }),
    finished_at: base,
  });
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind("subrep-sub-done", "subagent_reply", JSON.stringify({ id: "sub-done" }), base)
    .run();

  assert.equal(
    (await route(api, e, "heartbeat", { id: "sub-cancel", lease: "lc" })).status,
    409,
  );
  assert.equal(
    (
      await route(api, e, "report", {
        id: "sub-cancel",
        lease: "lc",
        status: "done",
        answer: "x",
        sha: HEX40,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await route(api, e, "report", {
        id: "sub-exp",
        lease: "le",
        status: "done",
        answer: "x",
        sha: HEX40,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await route(api, e, "report", {
        id: "sub-done",
        lease: "other-lease",
        status: "done",
        answer: "x",
        sha: HEX40,
      })
    ).status,
    409,
  );
  assert.equal(await count(e, "jobs", "id='subrep-sub-done'"), 1);
  assert.equal(await count(e, "jobs", "id IN ('subrep-sub-cancel','subrep-sub-exp')"), 0);
});

test("D-6 cron 过期：queued→expired、running 超时→failed，各一条 subrep，再跑不重复", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, { id: "sub-q", status: "queued", deadline: base + 300_000 });
  await seedRun(e, {
    id: "sub-d",
    status: "running",
    lease: "l1",
    lease_until: base + 100_000,
    deadline: base - 31_000,
    started_at: base - 400_000,
  });
  await seedRun(e, {
    id: "sub-l",
    status: "running",
    lease: "l2",
    lease_until: base - 121_000,
    deadline: base + 100_000,
    started_at: base - 200_000,
  });
  await api.expireSubagents(e, base);
  assert.equal((await one(e, "SELECT status,error_kind FROM subagent_runs WHERE id='sub-q'")).status, "expired");
  assert.equal((await one(e, "SELECT error_kind FROM subagent_runs WHERE id='sub-q'")).error_kind, "runner_offline");
  for (const id of ["sub-d", "sub-l"]) {
    const row = await one(e, "SELECT status,error_kind FROM subagent_runs WHERE id=?", id);
    assert.equal(row.status, "failed", id);
    assert.equal(row.error_kind, "timeout", id);
  }
  for (const id of ["sub-q", "sub-d", "sub-l"])
    assert.equal(await count(e, "jobs", "id=?", "subrep-" + id), 1, id);
  await api.expireSubagents(e, base + 1);
  for (const id of ["sub-q", "sub-d", "sub-l"])
    assert.equal(await count(e, "jobs", "id=?", "subrep-" + id), 1, "第二次 cron 不能重复：" + id);
});

test("D-7 群里取消（带 id / 不带 id 取最近一个）→ cancelled 且回「已停」，之后心跳 409", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, { id: "sub-old", created_at: base - 10_000, deadline: base + TOTAL });
  await seedRun(e, { id: "sub-new", created_at: base - 1_000, deadline: base + TOTAL });
  const ctx = context("current-7");
  const withId = await api.runDelegate(e, { op: "cancel", id: "sub-old" }, ctx, []);
  assert.notEqual(withId.ok, false, JSON.stringify(withId));
  assert.match(JSON.stringify(withId), /已停|cancelled/, "群里取消要回「已停」");
  assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-old'")).status, "cancelled");
  assert.equal(
    (await route(api, e, "heartbeat", { id: "sub-old", lease: "x" })).status,
    409,
  );
  const latest = await api.runDelegate(e, { op: "cancel" }, ctx, []);
  assert.match(JSON.stringify(latest), /已停|cancelled/, "不带 id 取消也要回「已停」");
  assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-new'")).status, "cancelled");
});

test("D-8 report 入队一次、引用 source_msg、4000 字截到 3500、服务端再脱敏", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  const secret = "AKIA" + "B".repeat(16);
  await seedRun(e, {
    id: "sub-rep",
    status: "running",
    lease: "lrep",
    lease_until: base + LEASE,
    started_at: base,
    source_msg: "source-8",
  });
  const res = await route(api, e, "report", {
    id: "sub-rep",
    lease: "lrep",
    status: "done",
    answer: secret + "答案".repeat(2000),
    citations: ["README.md:1"],
    workspaceCitations: [],
    unverifiedCitations: [],
    sha: HEX40,
  });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(await count(e, "jobs", "id='subrep-sub-rep'"), 1);
  const row = await one(e, "SELECT result,source_msg,resolved_sha FROM subagent_runs WHERE id='sub-rep'");
  assert.equal(row.source_msg, "source-8");
  assert.equal(row.resolved_sha, HEX40);
  const result = JSON.parse(row.result);
  assert.equal(result.answer.length, 3500, "answer 应截到 3500");
  assert.ok(!result.answer.includes(secret), "服务端要再脱敏一次");

  const briefs = [];
  await withFetch(
    async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      if (String(body.messages?.[0]?.content || "").includes("最后的嘴替模块")) {
        briefs.push(JSON.parse(body.messages[1].content));
        return voice();
      }
      throw new Error("unexpected fetch " + url);
    },
    () => api.deliverSubagent(e, "sub-rep"),
  );
  assert.ok(briefs.length >= 1, "deliver 要经过嘴替");
  const out = await all(e, "SELECT id,msg_id FROM outbox");
  assert.ok(out.some((o) => o.msg_id === "source-8"), "回复要引用 source_msg");
  const meta = await one(e, "SELECT json FROM outbox_meta WHERE id=?", out[0].id);
  assert.equal(JSON.parse(meta.json).reference, "source-8");
});

test("D-9 收到两次 progress，群里只发一条", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, {
    id: "sub-prog",
    status: "running",
    lease: "lp",
    lease_until: base + LEASE,
    started_at: base - 121_000,
    deadline: base + 300_000,
  });
  const sent = async () => (await count(e, "outbox")) + e.WORK.sent.length;
  const before = await sent();
  assert.ok((await route(api, e, "progress", { id: "sub-prog", lease: "lp", files: 2 })).status < 300);
  const once = await sent();
  assert.ok(once > before, "第一次 progress 要发一条");
  await route(api, e, "progress", { id: "sub-prog", lease: "lp", files: 3 });
  assert.equal(await sent(), once, "第二次 progress 不能再发");
});

test("D-10 runner 路由不带 token 返回 401；带 token 时路由已接线", async () => {
  await subagent();
  const e = makeEnv();
  const noToken = await postWorker(e, "/api/runner/subagent/claim", {});
  assert.equal(noToken.status, 401);
  const authed = await postWorker(e, "/api/runner/subagent/claim", {}, "runner-secret");
  assert.notEqual(authed.status, 404, "B-3 要把 subagentRoute 接进 worker");
  assert.equal(authed.status, 200);
});

test("D-11 计量：start=2、claim=1、heartbeat=1、report=3、expire=4；deliver 记 counts", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  const ctx = context("current-11");
  const counts = {};

  reset(e);
  await api.runDelegate(
    e,
    { op: "start", role: "code_reader", repo: REPO, question: "计量 start" },
    ctx,
    [],
  );
  counts.start = e.DB.executed;
  assert.equal(counts.start, 2);

  const id = (await one(e, "SELECT id FROM subagent_runs")).id;
  reset(e);
  await route(api, e, "claim", {});
  counts.claim = e.DB.executed;
  assert.equal(counts.claim, 1);

  const run = await one(e, "SELECT lease FROM subagent_runs WHERE id=?", id);
  reset(e);
  assert.equal((await route(api, e, "heartbeat", { id, lease: run.lease })).status, 200);
  counts.heartbeat = e.DB.executed;
  assert.equal(counts.heartbeat, 1);

  reset(e);
  assert.equal(
    (
      await route(api, e, "report", {
        id,
        lease: run.lease,
        status: "done",
        answer: "完",
        citations: [],
        sha: HEX40,
      })
    ).status,
    200,
  );
  counts.report = e.DB.executed;
  assert.equal(counts.report, 3, "report 是 3 条语句");

  await seedRun(e, { id: "sub-e1", status: "queued", deadline: base + 300_000 });
  await seedRun(e, {
    id: "sub-e2",
    status: "running",
    lease: "le",
    lease_until: base + LEASE,
    deadline: base - 31_000,
    started_at: base - 100_000,
  });
  reset(e);
  await api.expireSubagents(e, base);
  counts.expire = e.DB.executed;
  assert.equal(counts.expire, 4, "expireSubagents 是 4 条语句");

  reset(e);
  await withFetch(
    async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      if (String(body.messages?.[0]?.content || "").includes("最后的嘴替模块"))
        return voice();
      throw new Error("unexpected fetch " + url);
    },
    () => api.deliverSubagent(e, id),
  );
  counts.deliver = e.DB.executed;
  assert.ok(counts.deliver > 0);
  const turn = counts.start + counts.claim + counts.heartbeat + counts.report + counts.deliver;
  assert.ok(turn <= 48, `delegate 回合合计 ${turn} 条，超过 48`);
  console.log("D-11 counts", JSON.stringify(counts));
});

test("D-12 role:'code_exec'（C3 阶段）返回 invalid_args", async () => {
  const api = await subagent();
  const e = makeEnv();
  const r = await api.runDelegate(
    e,
    { op: "start", role: "code_exec", repo: REPO, question: "改一下登录" },
    context("current-12"),
    [],
  );
  failure(r, "invalid_args");
  assert.equal(await count(e, "subagent_runs"), 0);
});

test("D-13 tainted 的回合 start 允许，但写入 tainted=1", async () => {
  const api = await subagent();
  const e = makeEnv();
  const ctx = context("current-13", { materials: ["video"] });
  const r = await api.runDelegate(
    e,
    { op: "start", role: "code_reader", repo: REPO, question: "视频里提到的登录流程" },
    ctx,
    [],
  );
  assert.equal(r.accepted, true, JSON.stringify(r));
  assert.equal((await one(e, "SELECT tainted FROM subagent_runs WHERE id=?", r.id)).tainted, 1);
  // runner 提示词里的外部内容提示由 runner 测试断言（B-5 的 runner/subagent 测试）。
});

test("D-14 claim 成功响应带服务端生成的 lease、lease_until、deadline", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  const deadline = base + TOTAL;
  await withNow(base, async () => {
    await seedRun(e, { id: "sub-claim", deadline });
    const res = await route(api, e, "claim", { lease: "runner-chosen" });
    assert.equal(res.status, 200);
    const run = claimOf(await res.json());
    assert.ok(run, "claim 应有 run");
    assert.match(run.lease, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.notEqual(run.lease, "runner-chosen", "lease 必须服务端生成");
    assert.equal(run.deadline, deadline);
    assert.ok(Math.abs(run.lease_until - (base + LEASE)) < 5000, "lease_until≈now+60s");
  });
});

test("D-15 deadline−now=300s 的 queued 不被 claim；过 deadline+31s 的 report 409 且状态不变", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  const deadline = base + 300_000;
  await withNow(base, async () => {
    await seedRun(e, { id: "sub-skip", deadline });
    const res = await route(api, e, "claim", {});
    assert.equal(claimOf(await res.json()), null, "剩余不足 MIN_RUN 不能 claim");
  });
  await seedRun(e, {
    id: "sub-late",
    status: "running",
    lease: "ll",
    lease_until: base + LEASE,
    started_at: base,
    deadline,
  });
  await withNow(deadline + 31_000, async () => {
    const res = await route(api, e, "report", {
      id: "sub-late",
      lease: "ll",
      status: "done",
      answer: "超时后",
      sha: HEX40,
    });
    assert.equal(res.status, 409);
  });
  assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-late'")).status, "running");
  assert.equal(await count(e, "jobs", "id='subrep-sub-late'"), 0);
});

test("D-16 同 lease 重发 200；删掉 subrep 再发补出一条；report 是一个 batch 且第 2 条失败会回滚", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, {
    id: "sub-idem",
    status: "running",
    lease: "li",
    lease_until: base + LEASE,
    started_at: base,
  });
  const body = {
    id: "sub-idem",
    lease: "li",
    status: "done",
    answer: "幂等",
    citations: [],
    sha: HEX40,
  };
  reset(e);
  assert.equal((await route(api, e, "report", body)).status, 200);
  assert.equal(e.DB.batches, 1, "report 必须是一个 batch");
  assert.deepEqual(e.DB.batchSizes, [3], "report batch 是 3 条语句");
  assert.equal((await route(api, e, "report", body)).status, 200);
  assert.equal(await count(e, "jobs", "id='subrep-sub-idem'"), 1);
  await e.DB.prepare("DELETE FROM jobs WHERE id='subrep-sub-idem'").run();
  assert.equal((await route(api, e, "report", body)).status, 200);
  assert.equal(await count(e, "jobs", "id='subrep-sub-idem'"), 1, "补回复任务且只有一个");

  const e2 = makeEnv();
  await seedRun(e2, {
    id: "sub-roll",
    status: "running",
    lease: "lr",
    lease_until: Date.now() + LEASE,
    started_at: Date.now(),
  });
  e2.DB.failBatchAt = 2;
  try {
    await route(api, e2, "report", { ...body, id: "sub-roll", lease: "lr" });
  } catch {}
  assert.equal((await one(e2, "SELECT status FROM subagent_runs WHERE id='sub-roll'")).status, "running", "第 2 条失败时第 1 条要回滚");
  assert.equal(await count(e2, "jobs", "id='subrep-sub-roll'"), 0);
});

test("D-17 并发 start：同成员已有 2 次、3 并发只建 1 个；全群 29→3 并发只建 1 个", async () => {
  const api = await subagent();
  {
    const e = makeEnv();
    const base = Date.now();
    for (let i = 0; i < 2; i++)
      await seedRun(e, { id: "sub-m" + i, requester: "U1", source_msg: "m" + i, created_at: base - i });
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        api.runDelegate(
          e,
          { op: "start", role: "code_reader", repo: REPO, question: "并发问题 " + n },
          context("current-17-" + n),
          [],
        ),
      ),
    );
    assert.equal(results.filter((r) => r.accepted).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.error_kind === "budget").length, 2, JSON.stringify(results));
    assert.equal(await count(e, "subagent_runs"), 3, "2 个已有 + 1 个新建");
  }
  {
    const e = makeEnv();
    const base = Date.now();
    for (let i = 0; i < 29; i++)
      await seedRun(e, { id: "sub-g" + i, requester: "R" + i, source_msg: "g" + i, created_at: base - i });
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        api.runDelegate(
          e,
          { op: "start", role: "code_reader", repo: REPO, question: "全群并发 " + n },
          context("current-17b-" + n, {
            latest: {
              id: "current-17b-" + n,
              group_id: GROUP,
              sender: "N" + n,
              body: "并发",
              ts: new Date().toISOString(),
              mentioned: 1,
              meta: { direct: true },
            },
          }),
          [],
        ),
      ),
    );
    assert.equal(results.filter((r) => r.accepted).length, 1, JSON.stringify(results));
    assert.equal(results.filter((r) => r.error_kind === "budget").length, 2, JSON.stringify(results));
    assert.equal(await count(e, "subagent_runs"), 30);
  }
});

test("D-18 同一消息同一 repo/ref/问题重放 → duplicate、同 id、不新建、不扣配额", async () => {
  const api = await subagent();
  const e = makeEnv();
  const args = { op: "start", role: "code_reader", repo: REPO, ref: "main", question: "同一个问题" };
  const first = await api.runDelegate(e, args, context("current-18"), []);
  assert.equal(first.accepted, true);
  const second = await api.runDelegate(e, args, context("current-18"), []);
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true, JSON.stringify(second));
  assert.equal(second.id, first.id);
  assert.equal(await count(e, "subagent_runs"), 1);
  const base = Date.now();
  for (let i = 0; i < 2; i++)
    await seedRun(e, { id: "sub-q" + i, requester: "U1", source_msg: "q" + i, created_at: base - i });
  const replay = await api.runDelegate(e, args, context("current-18"), []);
  assert.equal(replay.duplicate, true, "配额满了重放仍应识别 duplicate，而不是 budget");
  assert.equal(replay.id, first.id);
  assert.equal(await count(e, "subagent_runs"), 3);
});

test("D-19 有 1 个 running 时 idle=busy；quiesce 后 claim 返回暂停响应、run 仍 queued；idle 1 条语句", async () => {
  await subagent();
  {
    const e = makeEnv();
    await seedRun(e, {
      id: "sub-busy",
      status: "running",
      lease: "lb",
      lease_until: Date.now() + LEASE,
      started_at: Date.now(),
    });
    reset(e);
    const res = await postWorker(e, "/api/runner/idle", {}, "runner-secret");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).idle, false, "running 子代理要算 busy");
    assert.equal(e.DB.executed, 1, "idle 仍应是 1 条语句");
  }
  {
    const e = makeEnv();
    await seedRun(e, { id: "sub-queued", status: "queued", deadline: Date.now() + TOTAL });
    assert.equal((await postWorker(e, "/api/runner/idle", { quiesce: true }, "runner-secret")).status, 200);
    const res = await postWorker(e, "/api/runner/subagent/claim", {}, "runner-secret");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { task: null, job: null });
    assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-queued'")).status, "queued");
  }
});

test("D-20 第三人/伪造 requester 取消都是 not_found；owner 路由成功；非 owner 403", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  await seedRun(e, { id: "sub-own", requester: "U1", created_at: base, deadline: base + TOTAL });
  const other = context("current-20");
  other.latest.sender = "U2";
  const third = await api.runDelegate(e, { op: "cancel", id: "sub-own" }, other, []);
  failure(third, "not_found");
  const forged = await api.runDelegate(
    e,
    { op: "cancel", id: "sub-own", requester: "U1" },
    other,
    [],
  );
  failure(forged, "not_found");
  assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-own'")).status, "queued");

  const token = "member-token";
  await e.DB.prepare("INSERT INTO members(id,name,token_hash) VALUES(?,?,?)")
    .bind("m1", "普通成员", createHash("sha256").update(token).digest("hex"))
    .run();
  const denied = await postWorker(e, "/api/team/subagent/cancel", { id: "sub-own" }, token);
  assert.equal(denied.status, 403);
  const ok = await postWorker(e, "/api/team/subagent/cancel", { id: "sub-own" }, "owner-secret");
  assert.equal(ok.status, 200);
  assert.equal((await one(e, "SELECT status FROM subagent_runs WHERE id='sub-own'")).status, "cancelled");
});

test("D-21 delegate+read_web 是 handoff；重放只建 1 个 run", async () => {
  const sem = await need("semantic", ["inlineable"]);
  const mixed = {
    tool_calls: [toolCall("delegate", {}), toolCall("read_web", { url: "https://example.com" })],
  };
  assert.equal(sem.inlineable(mixed, { mentioned: true, background: false }, { inlineUsed: 0 }), "handoff");

  const api = await subagent();
  const e = makeEnv();
  const args = { op: "start", role: "code_reader", repo: REPO, question: "混批只有一个 run" };
  const ctx = context("current-21");
  await api.runDelegate(e, args, ctx, []);
  const replay = await api.runDelegate(e, args, ctx, []);
  assert.equal(replay.duplicate, true);
  assert.equal(await count(e, "subagent_runs"), 1, "后台回放命中 duplicate，不建第二个");
});

test("D-22 pending 里 delegate 在执行前关 off:delegate → denied 不写；工具表也不再出现", async () => {
  await subagent();
  {
    const e = makeEnv();
    const ctx = context("current-22");
    const seen = await runAgent(e, [], ctx);
    const names = (seen.requests[0]?.tools || []).map((t) => t.function.name);
    assert.ok(names.includes("delegate"), "开关开着时工具表要有 delegate");
  }
  {
    const e = makeEnv();
    const ctx = context("current-22b", { switches: { "off:delegate": "1" } });
    const seen = await runAgent(e, [], ctx);
    const names = (seen.requests[0]?.tools || []).map((t) => t.function.name);
    assert.ok(!names.includes("delegate"), "开关关着时工具表不能有 delegate");
  }
  {
    const e = makeEnv();
    await e.DB.prepare("INSERT INTO settings VALUES('off:delegate','1')").run();
    const api = await subagent();
    const ctx = context("current-22c");
    delete ctx.switches;
    const r = await api.runDelegate(
      e,
      { op: "start", role: "code_reader", repo: REPO, question: "执行前被关" },
      ctx,
      [],
    );
    failure(r, "denied");
    assert.equal(await count(e, "subagent_runs"), 0);
  }
  {
    const e = makeEnv();
    await e.DB.prepare("INSERT INTO settings VALUES('off:delegate','1')").run();
    const api = await semantic();
    const ctx = context("current-22d", {
      background: true,
      resume: {
        messages: [],
        pending: { role: "assistant", tool_calls: [toolCall("delegate", { op: "start", role: "code_reader", repo: REPO, question: "pending 旧调用" })] },
        turn: 0,
      },
    });
    delete ctx.switches;
    const seen = await runAgent(e, [], ctx);
    assert.ok(deniedIn(seen.toolResults), "pending 里的 delegate 也要 denied");
    assert.equal(await count(e, "subagent_runs"), 0);
  }
});

test("D-23 inlineable 5 行表 + background 一律 local", async () => {
  const sem = await need("semantic", ["inlineable"]);
  const m = (...names) => ({ tool_calls: names.map((n) => toolCall(n, {})) });
  const call = (names, context = { mentioned: true, background: false }) =>
    sem.inlineable(m(...names), context, { inlineUsed: 0 });
  assert.equal(call(["remember_correction", "repo_changes"]), "local", "只有 LOCAL_TOOLS");
  assert.equal(call(["delegate"]), "local", "单独 delegate");
  assert.equal(call(["delegate", "remember_correction"]), "local", "delegate + LOCAL_TOOLS");
  assert.equal(call(["delegate", "read_web"]), "handoff", "delegate + 其他");
  assert.equal(call(["read_web"]), "handoff", "单独 read_web（V-B，V-C 才变 inline）");
  for (const names of [["read_web"], ["read_x"], ["delegate"], ["delegate", "search_web"]])
    assert.equal(call(names, { background: true }), "local", "background 一律 local：" + names.join(","));
});

test("D-24 origin:'subagent' 直接发 delegate（含 resume.pending）→ denied、未提供的工具、零新行", async () => {
  await subagent();
  for (const resumed of [false, true]) {
    const e = makeEnv();
    const pending = {
      role: "assistant",
      tool_calls: [toolCall("delegate", { op: "start", role: "code_reader", repo: REPO, question: "子代理再派" })],
    };
    const ctx = context("current-24" + (resumed ? "r" : ""), {
      origin: "subagent",
      background: true,
      ...(resumed ? { resume: { messages: [], pending, turn: 0 } } : {}),
    });
    const seen = await runAgent(e, resumed ? [] : [pending.tool_calls], ctx);
    const denied = deniedIn(seen.toolResults);
    assert.ok(denied, "应得到 denied 工具结果：" + JSON.stringify(seen.toolResults));
    assert.equal(denied.detail, "未提供的工具");
    assert.equal(await count(e, "subagent_runs"), 0);
    assert.equal(await count(e, "jobs"), 0, "不能建新 job");
  }
});

test("D-25 绕过工具表直接调 runDelegate/createProjectTask，origin=subagent 三例都 denied；普通 context 不被拦", async () => {
  const api = await subagent();
  const sem = await need("semantic", ["createProjectTask"]);
  for (const role of ["code_reader", "code_exec"]) {
    const e = makeEnv();
    const r = await api.runDelegate(
      e,
      { op: "start", role, repo: REPO, question: "绕过工具表" },
      context("current-25", { origin: "subagent" }),
      [],
    );
    failure(r, "denied");
    assert.equal(await count(e, "subagent_runs"), 0);
  }
  const args = {
    source_id: "current",
    request_quote: "帮我建个任务修登录",
    repo: REPO,
    title: "修登录",
    detail: "按原话处理",
    execute_requested: true,
    complexity: "small",
  };
  {
    const e = makeEnv();
    const r = await sem.createProjectTask(
      e,
      args,
      context("current", { origin: "subagent" }, "帮我建个任务修登录"),
      [],
    );
    failure(r, "denied");
    assert.equal(await count(e, "tasks"), 0);
  }
  {
    const e = makeEnv();
    const r = await api.runDelegate(
      e,
      { op: "start", role: "code_reader", repo: REPO, question: "普通 context" },
      context("current-25n"),
      [],
    );
    assert.notEqual(r?.error_kind, "denied", "普通 context 不能被子代理闸误伤");
  }
  {
    const e = makeEnv();
    let normal;
    try {
      normal = await sem.createProjectTask(
        e,
        args,
        context("current", {}, "帮我建个任务修登录"),
        [],
      );
    } catch (err) {
      normal = { threw: String(err) };
    }
    assert.notEqual(normal?.error_kind, "denied", "普通 context 的 createProjectTask 不能被子代理闸误伤");
  }
});

test("D-26 report 的 sha 用 runner 实测 B，不用投递时的 head；done 的坏 sha 400、failed 的坏 sha 照常入库", async () => {
  const api = await subagent();
  const e = makeEnv();
  const base = Date.now();
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  await e.DB.prepare("INSERT INTO repo_cache(repo,json,updated_at) VALUES(?,?,?)")
    .bind(REPO, JSON.stringify({ head: A }), base)
    .run();
  await seedRun(e, {
    id: "sub-sha",
    status: "running",
    lease: "ls",
    lease_until: base + LEASE,
    started_at: base,
    deadline: base + 500_000,
  });
  assert.equal(
    (
      await route(api, e, "report", {
        id: "sub-sha",
        lease: "ls",
        status: "done",
        answer: "按 B 回答",
        citations: [],
        sha: B,
      })
    ).status,
    200,
  );
  const row = await one(e, "SELECT resolved_sha FROM subagent_runs WHERE id='sub-sha'");
  assert.equal(row.resolved_sha, B);
  await e.DB.prepare("UPDATE repo_cache SET json=?, updated_at=? WHERE repo=?")
    .bind(JSON.stringify({ head: C }), base + 1, REPO)
    .run();
  const briefs = [];
  await withFetch(
    async (url, options = {}) => {
      const body = JSON.parse(options.body || "{}");
      if (String(body.messages?.[0]?.content || "").includes("最后的嘴替模块")) {
        briefs.push(JSON.parse(body.messages[1].content));
        return voice();
      }
      throw new Error("unexpected fetch " + url);
    },
    () => api.deliverSubagent(e, "sub-sha"),
  );
  assert.equal(briefs[0].brief.facts.sha7, B.slice(0, 7), "facts 用 B 的前 7 位");
  assert.ok(!JSON.stringify(briefs[0]).includes(A.slice(0, 7)), "不能用 start 时的 head A");
  assert.ok(!JSON.stringify(briefs[0]).includes(C.slice(0, 7)), "不能用投递时的 head C");

  for (const bad of ["HEAD", "abc1234"]) {
    await seedRun(e, {
      id: "sub-bad-" + bad,
      status: "running",
      lease: "lbad",
      lease_until: base + LEASE,
      started_at: base,
      deadline: base + 500_000,
    });
    const res = await route(api, e, "report", {
      id: "sub-bad-" + bad,
      lease: "lbad",
      status: "done",
      answer: "坏 sha",
      sha: bad,
    });
    assert.equal(res.status, 400, bad);
    const badRow = await one(e, "SELECT status,resolved_sha FROM subagent_runs WHERE id=?", "sub-bad-" + bad);
    assert.equal(badRow.status, "running", "坏 sha 的 done report 不能改行");
    assert.equal(badRow.resolved_sha, null);
  }
  await seedRun(e, {
    id: "sub-fail-sha",
    status: "running",
    lease: "lf",
    lease_until: base + LEASE,
    started_at: base,
    deadline: base + 500_000,
  });
  assert.equal(
    (
      await route(api, e, "report", {
        id: "sub-fail-sha",
        lease: "lf",
        status: "failed",
        error_kind: "runner_offline",
        answer: "",
        sha: "HEAD",
      })
    ).status,
    200,
  );
  const failed = await one(e, "SELECT status,resolved_sha FROM subagent_runs WHERE id='sub-fail-sha'");
  assert.equal(failed.status, "failed");
  assert.equal(failed.resolved_sha, null);
  assert.equal(await count(e, "jobs", "id='subrep-sub-fail-sha'"), 1);
});
