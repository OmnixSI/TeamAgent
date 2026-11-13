import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

function fakeDB() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(schema);
  const db = {
    executed: 0,
    prepare(sql) {
      const make = (args) => ({
        sql,
        args,
        async first() {
          db.executed++;
          return sqlite.prepare(sql).get(...args) || null;
        },
        async all() {
          db.executed++;
          return { results: sqlite.prepare(sql).all(...args) };
        },
        async run() {
          db.executed++;
          return sqlite.prepare(sql).run(...args);
        },
      });
      const statement = make([]);
      return {
        ...statement,
        sql,
        bind(...args) {
          return make(args);
        },
      };
    },
    async batch(statements) {
      const out = [];
      for (const statement of statements) {
        db.executed++;
        const prepared = sqlite.prepare(statement.sql);
        out.push(
          /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(statement.sql)
            ? { results: prepared.all(...(statement.args || [])) }
            : prepared.run(...(statement.args || [])),
        );
      }
      return out;
    },
  };
  return { sqlite, db };
}

function seed(sqlite, group, count, base = Date.parse("2026-11-13T00:00:00Z")) {
  const insert = sqlite.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,0,0)",
  );
  for (let i = 0; i < count; i++)
    insert.run(
      group + "-" + i,
      group,
      "u" + (i % 4),
      "第" + i + "条：讨论发布计划、接口和待办 https://example.com/" + i,
      new Date(base + i * 60_000).toISOString(),
    );
}

function modelStub(log) {
  return async (prompt) => {
    log.push(prompt);
    if (prompt.includes("压缩成")) {
      const refs = [...new Set([...prompt.matchAll(/"ref":"(m[0-9a-z]+)"/g)].map((m) => m[1]))];
      return JSON.stringify({
        points: refs.slice(0, 3).map((ref, i) => ({ text: "要点 " + i + " 的内容", ids: [ref] })),
      });
    }
    const refs = [
      ...new Set(
        [...prompt.matchAll(/"ids":\[([^\]]*)\]/g)].flatMap((m) =>
          [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]),
        ),
      ),
    ].filter((ref) => /^m\d+$/.test(ref));
    const pick = (i) => refs[Math.min(i, refs.length - 1)];
    return JSON.stringify({
      conclusion: [{ text: "发布计划已经确定", ids: [pick(0)] }],
      decisions: [{ text: "周五上线", ids: [pick(1)] }],
      todos: [{ text: "补齐接口文档", ids: [pick(2)] }],
      questions: [{ text: "监控由谁负责还没定", ids: [pick(3)] }],
      links: [{ text: "https://example.com/1", ids: [pick(4)] }],
    });
  };
}

let cachedModule;
async function mod() {
  if (cachedModule) return cachedModule;
  const out = await build({
    entryPoints: ["src/summary.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  cachedModule = await import(
    "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
  );
  return cachedModule;
}

test("200 条消息 → 2 次 map + 1 次 reduce，五段且每条要点带可回溯引用", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 200);
  const log = [];
  const summary = await mod();
  const result = await summary.summarizeChat(
    { DB: db },
    { groupId: "G1", now: new Date("2026-11-13T12:00:00Z") },
    modelStub(log),
  );

  assert.equal(result.ok, true);
  assert.equal(result.cached, false);
  assert.equal(result.message_count, 200);
  assert.equal(log.length, 3);
  assert.deepEqual(
    log.slice(0, 2).map((p) => [...p.matchAll(/"ref":"/g)].length),
    [100, 100],
  );

  for (const label of ["结论", "决定", "待办", "未决问题", "链接"])
    assert.ok(result.body.includes(label), "missing section " + label);
  assert.ok([...result.body].length <= 2000, "summary over 2000 chars");

  const bullets = result.body.split("\n").filter((line) => line.startsWith("- ") && line !== "- 无");
  assert.ok(bullets.length >= 5, result.body);
  for (const line of bullets) {
    const match = line.match(/\[(m\d+)\]/);
    assert.ok(match, "bullet without ref: " + line);
    const citation = result.citations.find((c) => c.ref === match[1]);
    assert.ok(citation, "ref not in citations: " + match[1]);
    const byRowid = sqlite
      .prepare("SELECT id,group_id FROM messages WHERE rowid=?")
      .get(Number(match[1].slice(1)));
    assert.equal(byRowid.id, citation.message_id);
    assert.equal(byRowid.group_id, "G1");
  }
  for (const citation of result.citations) {
    const row = sqlite.prepare("SELECT group_id FROM messages WHERE id=?").get(citation.message_id);
    assert.equal(row.group_id, "G1");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM facts").get().n, 0);
});

test("同一 last_rowid 第二次调用命中缓存且不再调 model", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 120);
  const log = [];
  const summary = await mod();
  const first = await summary.summarizeChat(
    { DB: db },
    { groupId: "G1", now: new Date("2026-11-13T12:00:00Z") },
    modelStub(log),
  );
  const calls = log.length;
  const second = await summary.summarizeChat(
    { DB: db },
    { groupId: "G1", now: new Date("2026-11-13T12:00:00Z") },
    modelStub(log),
  );
  assert.equal(second.cached, true);
  assert.equal(log.length, calls);
  assert.equal(second.body, first.body);
});

test("硬上限 500 条，count 再大也不越过", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G2", 550);
  const log = [];
  const result = await (await mod()).summarizeChat(
    { DB: db },
    { groupId: "G2", count: 1000, now: new Date("2026-11-13T12:00:00Z") },
    modelStub(log),
  );
  assert.equal(result.message_count, 500);
  assert.equal(log.filter((p) => p.includes("压缩成")).length, 5);
  for (const prompt of log.filter((p) => p.includes("压缩成")))
    assert.ok([...prompt.matchAll(/"ref":"/g)].length <= 100);
});

test("群隔离：A 群总结取不到 B 群消息", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "GROUP_A", 6, Date.parse("2026-11-13T00:00:00Z"));
  seed(sqlite, "GROUP_B", 6, Date.parse("2026-11-13T00:00:00Z"));
  const log = [];
  const result = await (await mod()).summarizeChat(
    { DB: db },
    { groupId: "GROUP_A", now: new Date("2026-11-13T12:00:00Z") },
    modelStub(log),
  );
  assert.ok(result.message_count === 6);
  for (const citation of result.citations)
    assert.ok(citation.message_id.startsWith("GROUP_A-"), citation.message_id);
  assert.ok(!JSON.stringify(result).includes("GROUP_B-"));
  for (const prompt of log) assert.ok(!prompt.includes("GROUP_B-"));
});

test("自动总结默认关：零 setting 时一条读语句就返回，不写 summaries/outbox", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 220);
  const log = [];
  const actions = await (await mod()).autoSummary(
    { DB: db },
    new Date("2026-11-13T22:00:00Z"),
    modelStub(log),
  );
  assert.deepEqual(actions, []);
  assert.equal(log.length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM summaries").get().n, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 0);
  assert.ok(db.executed <= 2, "idle auto summary used " + db.executed + " statements");
});

test("自动总结打开后 ≥200 条只发一次，重复 tick 不刷屏", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 200, Date.parse("2026-11-13T20:00:00Z"));
  sqlite.prepare("INSERT INTO settings VALUES(?,?)").run("summary_auto:G1", "1");
  const log = [];
  const summary = await mod();
  const actions = await summary.autoSummary(
    { DB: db },
    new Date("2026-11-13T22:30:00Z"),
    modelStub(log),
  );
  assert.equal(actions.length, 1);
  const outbox = sqlite.prepare("SELECT * FROM outbox").all();
  assert.equal(outbox.length, 1);
  assert.ok(outbox[0].body.startsWith("【群聊总结】"));
  assert.ok(outbox[0].body.includes("结论"));
  const before = log.length;
  const again = await summary.autoSummary(
    { DB: db },
    new Date("2026-11-13T22:31:00Z"),
    modelStub(log),
  );
  assert.deepEqual(again, []);
  assert.equal(log.length, before);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM outbox").get().n, 1);
});

test("自动总结每天 09:00（悉尼）跑一次，其它小时不跑", async () => {
  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 3, Date.parse("2026-11-13T20:00:00Z"));
  sqlite.prepare("INSERT INTO settings VALUES(?,?)").run("summary_auto:G1", "1");
  const summary = await mod();
  const tooEarly = await summary.autoSummary(
    { DB: db },
    new Date("2026-11-13T21:00:00Z"), // 08:00 Sydney
    modelStub([]),
  );
  assert.deepEqual(tooEarly, []);
  const nine = await summary.autoSummary(
    { DB: db },
    new Date("2026-11-13T22:00:00Z"), // 09:00 Sydney
    modelStub([]),
  );
  assert.equal(nine.length, 1);
  const again = await summary.autoSummary(
    { DB: db },
    new Date("2026-11-13T22:01:00Z"),
    modelStub([]),
  );
  assert.deepEqual(again, []);
});

test("/summary 命令解析与执行", async () => {
  const summary = await mod();
  assert.deepEqual(summary.parseSummaryCommand("/summary"), { hours: undefined, count: undefined });
  assert.deepEqual(summary.parseSummaryCommand("/summary 24h"), { hours: 24 });
  assert.deepEqual(summary.parseSummaryCommand("/summary 100"), { count: 100 });
  assert.equal(summary.parseSummaryCommand("/summary 0"), null);
  assert.equal(summary.parseSummaryCommand("/summary 999"), null);
  assert.equal(summary.parseSummaryCommand("summary 100"), null);

  const { sqlite, db } = fakeDB();
  seed(sqlite, "G1", 8);
  const result = await summary.runSummaryCommand(
    { DB: db },
    { groupId: "G1", text: "/summary 5", msgId: "cmd-msg-1", now: new Date("2026-11-13T12:00:00Z") },
    modelStub([]),
  );
  assert.equal(result.handled, true);
  const outbox = sqlite.prepare("SELECT * FROM outbox").all();
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].group_id, "G1");
  assert.equal(outbox[0].msg_id, "cmd-msg-1");
});

test("工具注册：summarize_chat 是 untrusted，无群上下文返回结构化错误", async () => {
  const out = await build({
    entryPoints: ["src/tools/index.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  const tools = await import(
    "data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")
  );
  const tool = tools.EXTRA_TOOLS.find((t) => t.name === "summarize_chat");
  assert.ok(tool);
  assert.equal(tool.untrusted, true);
  assert.equal(tool.def.function.name, "summarize_chat");
  const result = await tool.run(
    { DB: {} },
    {},
    { context: {}, source: undefined, messages: [], isTainted: () => false },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error_kind, "unavailable");
  assert.equal(typeof result.next_action, "string");
});
