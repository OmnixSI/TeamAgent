// D3a 动作层：只读白名单、顺序执行、群发私有隔离、额度/用量/摘要/工作状态、
// 确定性成文与带说明的一次模型成文。假 D1（node:sqlite）+ 假 quota/schedules，
// records 用真实实现，确保 private 行真的不会进群发文本。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";

const OUTFILE = `.wrangler/actions-test-${process.pid}.mjs`;

const QUOTA_STUB = `
export async function renderQuota(e, options) {
  const state = globalThis.__quota;
  state.calls.push(options);
  return state.result;
}
`;
const SCHEDULES_STUB = `
export async function digestText(e, schedule, spec, now) {
  const state = globalThis.__digest;
  state.calls.push({ schedule, spec, now });
  if (state.error) throw state.error;
  return state.result;
}
`;

await build({
  stdin: {
    contents: 'export * from "./src/actions";',
    resolveDir: process.cwd(),
    loader: "ts",
    sourcefile: "actions-test-entry.ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: OUTFILE,
  logLevel: "silent",
  plugins: [
    {
      name: "d3a-stub-deps",
      setup(builder) {
        builder.onResolve({ filter: /^\.\/quota$/ }, () => ({ path: "quota", namespace: "d3a" }));
        builder.onResolve({ filter: /^\.\/schedules$/ }, () => ({ path: "schedules", namespace: "d3a" }));
        builder.onLoad({ filter: /^quota$/, namespace: "d3a" }, () => ({ contents: QUOTA_STUB, loader: "ts" }));
        builder.onLoad({ filter: /^schedules$/, namespace: "d3a" }, () => ({ contents: SCHEDULES_STUB, loader: "ts" }));
      },
    },
  ],
});
const api = await import(new URL(`../${OUTFILE}`, import.meta.url).href + `?${Date.now()}`);
after(() => rmSync(OUTFILE, { force: true }));

const NOW = Date.parse("2026-11-14T01:00:00+11:00"); // Sydney 11-14 01:00 = Shanghai 11-13 22:00
const G = "G-ACTIONS";
const OWNER = "S-OWNER";

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const calls = [];
  const DB = {
    raw,
    calls,
    prepare(sql) {
      const stmt = (args = []) => ({
        sql,
        args,
        bind(...next) {
          return stmt(next);
        },
        async all() {
          calls.push(sql);
          return { results: raw.prepare(sql).all(...args) };
        },
        async first() {
          calls.push(sql);
          return raw.prepare(sql).get(...args) ?? null;
        },
        async run() {
          calls.push(sql);
          const result = raw.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
        },
      });
      return stmt();
    },
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) {
          out.push(/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? await s.all() : await s.run());
        }
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const e = {
    DB,
    DEEPSEEK_API_KEY: "sk-fakeDEEPSEEK123456",
    DEEPSEEK_MODEL: "deepseek-flash",
    MODEL: "deepseek-flash",
  };
  return { e, raw };
}

const SCHEMA = JSON.stringify({
  fields: [
    { key: "person", label: "人员", type: "person", required: true },
    { key: "amount", label: "金额", type: "money", required: true },
    { key: "title", label: "说明", type: "text" },
    { key: "occurred_at", label: "时间", type: "date" },
  ],
  summary: { group_by: "person", sum: "amount_cents" },
});

function seed() {
  const f = fixture();
  const { raw } = f;
  raw
    .prepare(
      "INSERT INTO record_types(id,group_id,name,kind,schema,visibility_default,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run("rt-ledger", G, "家用账本", "ledger", SCHEMA, "group", OWNER, "active", NOW - 1000, NOW - 1000);
  raw
    .prepare(
      "INSERT INTO records(id,type_id,group_id,creator,visibility,data,source_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run("rec-group-1", "rt-ledger", G, OWNER, "group", JSON.stringify({ person: "张三", amount_cents: 10000, title: "午饭", occurred_at: NOW }), null, NOW - 500, NOW - 500);
  raw
    .prepare(
      "INSERT INTO records(id,type_id,group_id,creator,visibility,data,source_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run("rec-private-1", "rt-ledger", G, OWNER, "private", JSON.stringify({ person: "李四", amount_cents: 99900, title: "私账", occurred_at: NOW }), null, NOW - 400, NOW - 400);
  raw.prepare("INSERT INTO member_names(member_id,name,source,updated_at) VALUES(?,?,?,?)").run(OWNER, "老板", "test", "2026-11-14");
  return f;
}

function ctx(f, purpose = "chat", patch = {}) {
  return {
    e: f.e,
    groupId: G,
    viewer: { sender: OWNER, name: "老板", isAdmin: true },
    tz: "Australia/Sydney",
    now: NOW,
    purpose,
    ...patch,
  };
}

const rows = (f, sql, ...args) => f.raw.prepare(sql).all(...args);

// ---------- validateSteps ----------
test("validateSteps 只放行只读动作，拒绝写入类、超 6 步、超长文字和 limit>20", () => {
  const good = api.validateSteps([
    { action: "quota" },
    { action: "text", text: "大家好" },
    { action: "records_query", type: "家用账本", limit: 20 },
  ]);
  assert.equal(good.ok, true);
  assert.equal(good.steps.length, 3);

  const write = api.validateSteps([{ action: "records_write", type: "家用账本" }]);
  assert.equal(write.ok, false);
  assert.match(write.reason, /不支持|只读/);

  const seven = api.validateSteps(Array.from({ length: 7 }, () => ({ action: "quota" })));
  assert.equal(seven.ok, false);
  assert.match(seven.reason, /1.?6|6/);

  assert.equal(api.validateSteps([{ action: "text", text: "字".repeat(301) }]).ok, false);
  assert.equal(api.validateSteps([{ action: "records_query", type: "x", limit: 21 }]).ok, false);
  assert.equal(api.validateSteps([{ action: "records_summary" }]).ok, false);
  assert.equal(api.validateSteps("not-an-array").ok, false);
});

// ---------- records_summary / records_query ----------
test("records_summary 按 tz 汇总；群发场景 private 行一律不出现", async () => {
  const f = seed();
  const schedule = await api.runSteps(ctx(f, "schedule"), [
    { action: "records_summary", type: "家用账本", period: "today" },
  ]);
  assert.equal(schedule[0].ok, true);
  assert.match(schedule[0].text, /¥100\.00/);
  assert.match(schedule[0].text, /张三/);
  assert.doesNotMatch(schedule[0].text, /李四|999|私账|私有/);

  const chat = await api.runSteps(ctx(f, "chat"), [
    { action: "records_summary", type: "家用账本", period: "all" },
  ]);
  assert.equal(chat[0].ok, true);
  assert.match(chat[0].text, /¥100\.00/);
  assert.doesNotMatch(chat[0].text, /999|李四|私账/);
  assert.match(chat[0].text, /1 条私有记录/);
  assert.match(chat[0].text, /工作台/);
});

test("records_query 只回可见行；群发场景不显示私有条数", async () => {
  const f = seed();
  const schedule = await api.runSteps(ctx(f, "schedule"), [
    { action: "records_query", type: "家用账本", filter: { person: "张三" }, limit: 20 },
  ]);
  assert.equal(schedule[0].ok, true);
  assert.match(schedule[0].text, /#roup1|午饭|张三/);
  assert.doesNotMatch(schedule[0].text, /私账|999|私有/);

  const chat = await api.runSteps(ctx(f, "chat"), [{ action: "records_query", type: "家用账本" }]);
  assert.equal(chat[0].ok, true);
  assert.doesNotMatch(chat[0].text, /999|李四|私账/);
  assert.match(chat[0].text, /私有记录/);
});

test("records 类型找不到时单步失败，不中断后续", async () => {
  const f = seed();
  const results = await api.runSteps(ctx(f), [
    { action: "records_summary", type: "不存在的账本" },
    { action: "text", text: "后面的步骤照常" },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error_kind, "not_found");
  assert.equal(results[1].ok, true);
  assert.equal(results[1].text, "后面的步骤照常");
});

// ---------- quota ----------
test("quota 使用 renderQuota 的 text，失败用 reason_text 且标 error_kind", async () => {
  const f = seed();
  globalThis.__quota = {
    calls: [],
    result: { ok: true, text: "DeepSeek：￥12.00", band: "healthy" },
  };
  const ok = await api.runSteps(ctx(f), [{ action: "quota" }]);
  assert.equal(ok[0].ok, true);
  assert.equal(ok[0].text, "DeepSeek：￥12.00");
  assert.deepEqual(globalThis.__quota.calls[0], { group: G, sender: OWNER, now: NOW });

  globalThis.__quota.result = {
    ok: false,
    error_kind: "unavailable",
    reason_text: "暂时查不到额度，这次不猜数字",
  };
  const bad = await api.runSteps(ctx(f), [{ action: "quota" }]);
  assert.equal(bad[0].ok, false);
  assert.equal(bad[0].text, "暂时查不到额度，这次不猜数字");
  assert.equal(bad[0].error_kind, "unavailable");
});

// ---------- token_usage ----------
test("token_usage 按 ctx.tz 的自然日求和，悉尼与上海昨天边界不同", async () => {
  const f = seed();
  const insert = f.raw.prepare(
    "INSERT INTO model_usage(hour,kind,effort,status,n,input_tokens,output_tokens,duration_ms) VALUES(?,?,?,?,?,?,?,?)",
  );
  // 悉尼 11-13 12:00（=11-13 01:00 UTC）：悉尼的昨天，上海的昨天（11-12）不含。
  insert.run(Date.parse("2026-11-13T12:00:00+11:00"), "chat", "high", "ok", 3, 120, 80, 900);
  // 悉尼 11-12 12:00（=11-12 01:00 UTC）：悉尼的昨天不含，上海的昨天含。
  insert.run(Date.parse("2026-11-12T12:00:00+11:00"), "chat", "high", "ok", 5, 500, 300, 1200);

  const sydney = await api.runSteps(ctx(f, "chat", { tz: "Australia/Sydney" }), [
    { action: "token_usage", period: "yesterday" },
  ]);
  assert.equal(sydney[0].ok, true);
  assert.match(sydney[0].text, /昨日 token：输入 120 \/ 输出 80，共 3 次调用/);

  const shanghai = await api.runSteps(ctx(f, "chat", { tz: "Asia/Shanghai" }), [
    { action: "token_usage", period: "yesterday" },
  ]);
  assert.equal(shanghai[0].ok, true);
  assert.match(shanghai[0].text, /昨日 token：输入 500 \/ 输出 300，共 5 次调用/);

  const today = await api.runSteps(ctx(f, "chat", { tz: "Australia/Sydney" }), [
    { action: "token_usage", period: "today" },
  ]);
  assert.match(today[0].text, /今日 token：输入 0 \/ 输出 0，共 0 次调用/);
});

// ---------- chat_digest ----------
test("chat_digest 复用 digestText 的 tz/群/天数/主题", async () => {
  const f = seed();
  globalThis.__digest = { calls: [], result: "上周群里定了 D 版方案。" };
  const results = await api.runSteps(ctx(f, "schedule", { tz: "Asia/Shanghai" }), [
    { action: "chat_digest", days: 7, topic: "发布" },
  ]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].text, "上周群里定了 D 版方案。");
  const call = globalThis.__digest.calls[0];
  assert.equal(call.schedule.kind, "digest_weekly");
  assert.equal(call.schedule.group_id, G);
  assert.equal(call.schedule.tz, "Asia/Shanghai");
  assert.equal(call.spec.topic, "发布");
  assert.equal(call.now, NOW);
});

// ---------- work_status ----------
test("work_status 列最近任务与 jobs，各最多 5 条", async () => {
  const f = seed();
  const task = f.raw.prepare(
    "INSERT INTO tasks(id,repo,title,detail,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 6; i++)
    task.run(`t${i}`, "OmnixSI/TeamAgent", `任务${i}`, "d", i % 2 ? "done" : "proposal", `2026-11-14T0${i}:00:00Z`, `2026-11-14T0${i}:00:00Z`);
  const job = f.raw.prepare("INSERT INTO jobs(id,kind,payload,status,created_at) VALUES(?,?,?,?,?)");
  job.run("j1", "media", "{}", "pending", NOW - 1000);
  job.run("j2", "research", "{}", "done", NOW - 500);

  const results = await api.runSteps(ctx(f), [{ action: "work_status" }]);
  assert.equal(results[0].ok, true);
  assert.match(results[0].text, /任务5/);
  assert.doesNotMatch(results[0].text, /任务0/);
  assert.match(results[0].text, /media/);
  assert.match(results[0].text, /research/);
});

// ---------- joinResults ----------
test("joinResults 带标题分段，超长截到 1800 字", () => {
  const small = api.joinResults(
    [
      { action: "records_summary", ok: true, text: "账本合计 ¥100.00" },
      { action: "quota", ok: true, text: "余额 ￥12.00" },
    ],
    "日结",
  );
  assert.match(small, /日结/);
  assert.match(small, /账本合计 ¥100\.00/);
  assert.match(small, /余额 ￥12\.00/);

  const big = api.joinResults(
    Array.from({ length: 6 }, (_, i) => ({ action: "text", ok: true, text: `${i}` + "长".repeat(799) })),
  );
  assert.ok(big.length <= 1800, `expected <=1800, got ${big.length}`);
});

// ---------- composeWithNote ----------
test("composeWithNote 只调一次模型、max_tokens=1200、资料用不可信标记包裹；失败回退 joinResults", async () => {
  const f = seed();
  const results = [{ action: "records_summary", ok: true, text: "账本合计 ¥100.00" }];
  const note = "写成日结，先报总数";
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { choices: [{ message: { content: "日结：账本合计 ¥100.00。" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
      },
    };
  };
  try {
    const text = await api.composeWithNote(ctx(f), results, note);
    assert.equal(text, "日结：账本合计 ¥100.00。");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.max_tokens, 1200);
    assert.equal(calls[0].body.tools, undefined);
    const joined = calls[0].body.messages.map((m) => m.content).join("\n");
    assert.match(joined, /外部资料·不可信/);
    assert.match(joined, /账本合计 ¥100\.00/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  globalThis.fetch = async () => {
    throw Error("network down");
  };
  try {
    const fallback = await api.composeWithNote(ctx(f), results, note);
    assert.equal(fallback, api.joinResults(results));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("runSteps 把单步异常变成 ok:false，不抛给调用方", async () => {
  const f = seed();
  globalThis.__digest = { calls: [], error: Error("digest down") };
  const results = await api.runSteps(ctx(f), [
    { action: "chat_digest" },
    { action: "text", text: "仍然继续" },
  ]);
  assert.equal(results[0].ok, false);
  assert.equal(results[0].error_kind, "error");
  assert.equal(results[1].ok, true);
  assert.equal(results.length, 2);
});
