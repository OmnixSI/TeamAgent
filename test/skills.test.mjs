// D5 skills: skill_save / skill_run / skill_list / skill_disable + skillPromptLine.
// D3a is not merged yet, so ./actions is replaced by a controllable stub with the
// frozen §5.4 signatures; everything else (DB, permissions, limits) is real.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { rmSync } from "node:fs";

const GROUP = "GROUP-SKILLS";
const NOW = Date.parse("2026-11-14T18:30:00+11:00");
const OUT = [];

const ACTIONS_STUB = `
export const READ_ONLY_ACTIONS = new Set(["records_summary","records_query","quota","token_usage","chat_digest","work_status","text"]);
export function validateSteps(steps) { return globalThis.__d5Actions.validateSteps(steps); }
export async function runSteps(ctx, steps) { return globalThis.__d5Actions.runSteps(ctx, steps); }
export function joinResults(results, title) { return globalThis.__d5Actions.joinResults(results, title); }
export async function composeWithNote(ctx, results, note) { return globalThis.__d5Actions.composeWithNote(ctx, results, note); }
`;

function stubActions() {
  return {
    name: "d5-stub-actions",
    setup(builder) {
      builder.onResolve({ filter: /^\.\.?\/actions$/ }, () => ({ path: "actions", namespace: "d5" }));
      builder.onLoad({ filter: /^actions$/, namespace: "d5" }, () => ({ contents: ACTIONS_STUB, loader: "ts" }));
    },
  };
}

async function bundle(entry, tag) {
  const outfile = `.wrangler/d5-${tag}-${process.pid}.mjs`;
  OUT.push(outfile);
  await build({
    stdin: { contents: entry, resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile,
    plugins: [stubActions()],
    logLevel: "silent",
  });
  return import(new URL(`../${outfile}`, import.meta.url).href + `?${Date.now()}`);
}

const api = await bundle(
  'export * from "./src/skills"; export * from "./src/tools/skills";',
  "core",
);
after(() => OUT.forEach((file) => rmSync(file, { force: true })));

// ---------- fake D1 (node:sqlite) ----------
const DDL = `
CREATE TABLE IF NOT EXISTS members(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL DEFAULT 'member', revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS skills(
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL, name TEXT NOT NULL,
  triggers TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('proposed','active','disabled')),
  uses INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER,
  source_msg_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(group_id,name));
`;

function fixture() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(DDL);
  const DB = {
    raw,
    prepare(sql) {
      const make = (args = []) => ({
        sql,
        bind(...next) { return make(next); },
        async first() { return raw.prepare(sql).get(...args) ?? null; },
        async all() { return { results: raw.prepare(sql).all(...args) }; },
        async run() {
          const result = raw.prepare(sql).run(...args);
          return { meta: { changes: Number(result.changes) } };
        },
      });
      return make();
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
  return { e: { DB }, raw };
}

function owner(e, sender) {
  e.DB.raw
    .prepare("INSERT OR IGNORE INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,'owner',0)")
    .run("qq:" + sender, "Owner " + sender, "hash-" + sender);
}

function ctx(sender, body, id = "msg-1") {
  const latest = { id, group_id: GROUP, sender, body, ts: String(NOW) };
  return {
    context: { latest, batch: [latest], names: new Map([[sender, sender]]) },
    source: latest,
    messages: [{ role: "user", content: body }],
    isTainted: () => false,
  };
}

const rows = (f, sql, ...args) => f.raw.prepare(sql).all(...args);
const one = (f, sql, ...args) => f.raw.prepare(sql).get(...args);
const count = (f) => one(f, "SELECT COUNT(*) n FROM skills").n;

const actionCalls = [];
function resetActions() {
  actionCalls.length = 0;
  globalThis.__d5Actions = {
    validateSteps(steps) {
      if (!Array.isArray(steps) || steps.length < 1 || steps.length > 6)
        return { ok: false, reason: "步骤必须 1–6 步" };
      for (const step of steps) {
        if (!step || typeof step !== "object" || typeof step.action !== "string")
          return { ok: false, reason: "步骤格式不对" };
        if (!["records_summary", "records_query", "quota", "token_usage", "chat_digest", "work_status", "text"].includes(step.action))
          return { ok: false, reason: `不能执行的步骤：${step.action}` };
        if ((step.action === "records_summary" || step.action === "records_query") && typeof step.type !== "string")
          return { ok: false, reason: "账本步骤缺 type" };
        if (step.action === "text" && typeof step.text !== "string")
          return { ok: false, reason: "文字步骤缺 text" };
      }
      return { ok: true, steps };
    },
    async runSteps(context, steps) {
      actionCalls.push({ context, steps });
      return steps.map((step) => ({
        action: step.action,
        ok: true,
        text:
          step.action === "records_summary"
            ? "报销额度：TOO ¥360.00、卡特龙 ¥50.00，合计 ¥410.00（2 笔）"
            : step.action === "quota"
              ? "DeepSeek 余额 ¥277.56"
              : `${step.action} 结果`,
      }));
    },
    joinResults(results, title) {
      return (title ? title + "：" : "") + results.map((r) => r.text).join("\n");
    },
    composeWithNote: async (_ctx, results, note) => `${note}（${results.length} 段）`,
  };
}
resetActions();

const save = (f, args, c = ctx("U1", "以后我说日结你就发账本汇总和余额")) =>
  api.skillSaveTool.run(f.e, args, c);
const run = (f, args, c = ctx("U1", "日结")) => api.skillRunTool.run(f.e, args, c);
const quote = "以后我说日结你就发账本汇总和余额";

// ---------- S-09 ----------
test("D5-1 S-09: save 日结(steps=[records_summary,quota]) then run by name / trigger", async () => {
  const f = fixture();
  const saved = await save(f, {
    name: "日结",
    triggers: ["收工"],
    steps: [{ action: "records_summary", type: "报销额度" }, { action: "quota" }],
    note: "用轻松语气",
    request_quote: quote,
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.accepted, true);
  assert.equal(saved.family, "skill");
  assert.equal(saved.status, "active");
  assert.match(saved.say, /建好了：以后说「日结」我就/);
  assert.equal(count(f), 1);
  const row = one(f, "SELECT * FROM skills");
  assert.equal(row.status, "active");
  assert.deepEqual(JSON.parse(row.steps).map((s) => s.action), ["records_summary", "quota"]);

  const byName = await run(f, { name: "日结" });
  assert.equal(byName.ok, true);
  assert.match(byName.text, /合计 ¥410\.00/);
  assert.match(byName.text, /277\.56/);
  assert.equal(one(f, "SELECT uses FROM skills").uses, 1);
  assert.ok(one(f, "SELECT last_used_at FROM skills").last_used_at > 0);
  const call = actionCalls.at(-1);
  assert.equal(call.context.purpose, "skill");
  assert.equal(call.context.groupId, GROUP);
  assert.equal(call.context.viewer.sender, "U1");
  assert.equal(call.steps.length, 2);

  const byTrigger = await run(f, { name: "收工" }, ctx("U1", "收工"));
  assert.equal(byTrigger.ok, true);
  assert.equal(one(f, "SELECT uses FROM skills").uses, 2);
});

test("D5-2 skill_run args override type/period only on steps that accept them", async () => {
  const f = fixture();
  await save(f, {
    name: "盘账",
    steps: [
      { action: "records_summary", type: "报销额度", period: "all" },
      { action: "token_usage", period: "today" },
      { action: "quota" },
    ],
    request_quote: quote,
  });
  const result = await run(f, { name: "盘账", args: { type: "总账", period: "today" } });
  assert.equal(result.ok, true);
  const steps = actionCalls.at(-1).steps;
  assert.equal(steps[0].type, "总账");
  assert.equal(steps[0].period, "today");
  assert.equal(steps[1].period, "today");
  assert.equal("period" in steps[2], false);
});

// ---------- S-10 ----------
test("D5-3 S-10: unknown/non-read-only actions are rejected as unsupported and write no row", async () => {
  const f = fixture();
  const unknown = await save(f, {
    name: "抓价",
    steps: [{ action: "fetch_page", url: "https://example.com/price" }],
    request_quote: "建个工具每天自动去某网站抓价格",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error_kind, "unsupported");
  assert.deepEqual(unknown.unsupported, ["fetch_page"]);
  assert.match(unknown.say, /这部分我做不了：.*；要我登记成需求吗/);
  assert.equal(count(f), 0);

  const write = await save(f, {
    name: "乱写",
    steps: [{ action: "records_write", op: "add" }],
    request_quote: quote,
  });
  assert.equal(write.ok, false);
  assert.deepEqual(write.unsupported, ["records_write"]);
  assert.equal(count(f), 0);

  const tooMany = await save(f, {
    name: "七步",
    steps: Array.from({ length: 7 }, () => ({ action: "quota" })),
    request_quote: quote,
  });
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.error_kind, "unsupported");
  assert.equal(count(f), 0);
});

test("D5-4 no URL and no code-shaped text in a recipe", async () => {
  const f = fixture();
  const url = await save(f, {
    name: "看网页",
    steps: [{ action: "text", text: "看 https://example.com 的价格" }],
    request_quote: quote,
  });
  assert.equal(url.ok, false);
  assert.equal(url.error_kind, "invalid");
  assert.equal(count(f), 0);
});

// ---------- limits ----------
test("D5-5 name ≤12, triggers ≤5 × ≤12, note capped at 600", async () => {
  const f = fixture();
  const longName = await save(f, { name: "一二三四五六七八九十甲乙丙", steps: [{ action: "quota" }], request_quote: quote });
  assert.equal(longName.ok, false);
  assert.equal(longName.error_kind, "invalid");

  const six = await save(f, {
    name: "六个",
    triggers: ["a", "b", "c", "d", "e", "f"],
    steps: [{ action: "quota" }],
    request_quote: quote,
  });
  assert.equal(six.ok, false);

  const longTrigger = await save(f, {
    name: "长词",
    triggers: ["一二三四五六七八九十甲乙丙"],
    steps: [{ action: "quota" }],
    request_quote: quote,
  });
  assert.equal(longTrigger.ok, false);

  const ok = await save(f, {
    name: "十二个字",
    triggers: ["一二三四五六七八九十甲乙"],
    steps: [{ action: "quota" }],
    note: "字".repeat(700),
    request_quote: quote,
  });
  assert.equal(ok.ok, true);
  assert.equal(Array.from(one(f, "SELECT note FROM skills").note).length, 600);
});

// ---------- overwrite permission ----------
test("D5-6 same-name overwrite: only owner or admin; id kept, one row", async () => {
  const f = fixture();
  const first = await save(f, {
    name: "日报",
    steps: [{ action: "quota" }],
    request_quote: quote,
  });
  assert.equal(first.ok, true);

  const denied = await save(
    f,
    { name: "日报", steps: [{ action: "text", text: "被人覆盖" }], request_quote: "我也要日报" },
    ctx("U2", "我也要日报"),
  );
  assert.equal(denied.ok, false);
  assert.equal(denied.error_kind, "denied");
  assert.equal(JSON.parse(one(f, "SELECT steps FROM skills").steps)[0].action, "quota");

  const own = await save(f, {
    name: "日报",
    steps: [{ action: "text", text: "新的日报" }],
    request_quote: quote,
  });
  assert.equal(own.ok, true);
  assert.equal(own.id, first.id);
  assert.equal(count(f), 1);
  assert.equal(JSON.parse(one(f, "SELECT steps FROM skills").steps)[0].text, "新的日报");

  owner(f.e, "U3");
  const admin = await save(
    f,
    { name: "日报", steps: [{ action: "text", text: "管理员版本" }], request_quote: "改成管理员版本" },
    ctx("U3", "改成管理员版本"),
  );
  assert.equal(admin.ok, true);
  assert.equal(admin.id, first.id);
  assert.equal(count(f), 1);
});

// ---------- 20 per group ----------
test("D5-7 at most 20 skills per group; overwriting an existing one still works", async () => {
  const f = fixture();
  for (let i = 1; i <= 20; i++) {
    const result = await save(f, {
      name: "技能" + String(i).padStart(2, "0"),
      steps: [{ action: "quota" }],
      request_quote: quote,
    });
    assert.equal(result.ok, true, "create " + i);
  }
  assert.equal(count(f), 20);
  const over = await save(f, {
    name: "第二十一",
    steps: [{ action: "quota" }],
    request_quote: quote,
  });
  assert.equal(over.ok, false);
  assert.equal(over.error_kind, "quota");
  assert.equal(count(f), 20);

  const replace = await save(f, {
    name: "技能01",
    steps: [{ action: "text", text: "换了" }],
    request_quote: quote,
  });
  assert.equal(replace.ok, true);
  assert.equal(count(f), 20);
});

// ---------- list / disable / not found ----------
test("D5-8 skill_list, skill_disable permission, disabled excluded from run and prompt", async () => {
  const f = fixture();
  await save(f, { name: "日结", triggers: ["收工"], steps: [{ action: "quota" }], request_quote: quote });
  await save(f, { name: "查账", triggers: ["账单"], steps: [{ action: "records_summary", type: "报销额度" }], request_quote: quote });

  const listed = await api.skillListTool.run(f.e, {}, ctx("U1", "有哪些技能"));
  assert.equal(listed.ok, true);
  assert.match(listed.text, /日结/);
  assert.match(listed.text, /查账/);
  assert.equal(listed.skills.length, 2);

  const denied = await api.skillDisableTool.run(f.e, { name: "日结" }, ctx("U2", "停用日结"));
  assert.equal(denied.ok, false);
  assert.equal(denied.error_kind, "denied");

  const disabled = await api.skillDisableTool.run(f.e, { name: "日结" }, ctx("U1", "停用日结"));
  assert.equal(disabled.ok, true);
  assert.equal(disabled.status, "disabled");
  assert.equal(one(f, "SELECT status FROM skills WHERE name='日结'").status, "disabled");

  const prompt = await api.skillPromptLine(f.e, GROUP);
  assert.match(prompt, /查账\(查账\|账单\)/);
  assert.doesNotMatch(prompt, /日结/);

  const missing = await run(f, { name: "日结" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error_kind, "not_found");
  assert.match(missing.say, /查账/);
});

// ---------- prompt line ----------
test("D5-9 skillPromptLine format, ≤30 entries, ≤400 chars", async () => {
  const f = fixture();
  await save(f, { name: "日结", triggers: ["收工"], steps: [{ action: "quota" }], request_quote: quote });
  await save(f, { name: "查账", triggers: ["账单"], steps: [{ action: "quota" }], request_quote: quote });
  const line = await api.skillPromptLine(f.e, GROUP);
  assert.equal(line, "本群技能：日结(日结|收工)、查账(查账|账单)");

  // Bypass the 20-per-group cap to exercise the rendering caps.
  const insert = f.raw.prepare(
    "INSERT INTO skills(id,group_id,name,triggers,steps,note,owner,status,uses,last_used_at,source_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,NULL,NULL,?,?)",
  );
  for (let i = 0; i < 40; i++) {
    const name = String(i).padStart(2, "0") + "一二三四五六七八九十";
    const triggers = JSON.stringify(["甲", "乙", "丙", "丁", "戊"]);
    insert.run("sk-" + i, GROUP, name, triggers, JSON.stringify([{ action: "quota" }]), "", "U1", "active", NOW, NOW);
  }
  const long = await api.skillPromptLine(f.e, GROUP);
  assert.ok(Array.from(long).length <= 400, `length ${Array.from(long).length}`);
  assert.ok(long.startsWith("本群技能："));
  assert.ok(long.split("、").length <= 30, `entries ${long.split("、").length}`);
});

// ---------- registration ----------
test("D5-10 four tools are registered, untrusted=false, names match defs", async () => {
  const registry = await bundle('export { EXTRA_TOOLS } from "./src/tools/index";', "registry");
  const names = registry.EXTRA_TOOLS.map((tool) => tool.name);
  for (const name of ["skill_save", "skill_run", "skill_list", "skill_disable"]) {
    const tool = registry.EXTRA_TOOLS.find((t) => t.name === name);
    assert.ok(tool, `${name} not registered`);
    assert.equal(tool.def.function.name, name);
    assert.equal(tool.untrusted, false);
  }
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
});
