// F8-2 generate_image: intent lives in the tool description; quota, audit and the
// outbox hand-off live here. F8-0 (reserveQuota/releaseQuota) and F8-1
// (generateImage/enqueueGeneratedImage) are injected through the factory so this
// package can be built and tested while those land in parallel.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0042_image_gen_log.sql", import.meta.url), "utf8");
const migrateRunner = readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");

async function load(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const mod = await load("src/tools/generate-image.ts");
const toolkit = await load("src/toolkit.ts");
const tools = await load("src/tools/index.ts");

function database() {
  const d = new DatabaseSync(":memory:");
  d.exec(schema);
  const database = {
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) { return statement(values); },
        async first() { return d.prepare(sql).get(...args) || null; },
        async all() { return { results: d.prepare(sql).all(...args) }; },
        async run() { return d.prepare(sql).run(...args); },
      });
      return statement();
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run())));
    },
    raw: d,
  };
  return database;
}
const env = () => ({ DB: database() });
const set = (e, key, value) =>
  e.DB.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
const all = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;

const GOOD_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
function okImage(o = {}) {
  return {
    ok: true,
    jpeg: GOOD_JPEG,
    bytes: GOOD_JPEG.length,
    width: 1024,
    height: 1024,
    model: "gpt-image-1",
    est_cost_micro_usd: 2500,
    latency_ms: 1234,
    ...o,
  };
}

/** In-memory stand-ins for F8-0/F8-1. `quota` maps kind+key to used count. */
function fakeDeps(opts = {}) {
  const calls = { images: [], enqueued: [], reserved: [], released: [] };
  const used = opts.used || new Map();
  const deps = {
    async generateImage(_e, o) {
      calls.images.push(o);
      if (opts.generate) return opts.generate(o, calls);
      return okImage();
    },
    async enqueueGeneratedImage(_e, o) {
      calls.enqueued.push(o);
      if (opts.enqueue) return opts.enqueue(o, calls);
      return { outbox_id: o.id + "~g" };
    },
    async reserveQuota(_e, o) {
      calls.reserved.push(o);
      if (opts.reserve) return opts.reserve(o, calls);
      const key = o.kind + ":" + o.key;
      const n = Number(used.get(key) || 0);
      if (n >= o.limit) return { ok: false, used: n, limit: o.limit, reservation_id: null };
      used.set(key, n + 1);
      return { ok: true, used: n + 1, limit: o.limit, reservation_id: "r" + calls.reserved.length };
    },
    async releaseQuota(_e, id) {
      calls.released.push(id);
    },
  };
  return { deps, calls, used };
}

function ctx({ id = "turn-1", group = "GROUP-A", sender = "u1", tainted = false } = {}) {
  return {
    context: { latest: { id, group_id: group, sender } },
    source: { id, group_id: group, sender, body: "帮我生成一张戴草帽的橘猫" },
    messages: [],
    isTainted: () => tainted,
  };
}
const run = (tool, e, args, c = ctx()) => tool.run(e, args, c);

test("T1 工具定义：名字、必填 prompt、size 枚举、description 带正例与反例", () => {
  const t = mod.generateImageTool;
  assert.equal(t.name, "generate_image");
  assert.equal(t.def.function.name, "generate_image");
  assert.equal(t.untrusted, false);
  const d = t.def.function.description;
  for (const word of ["画", "生成", "海报", "头像", "插画", "壁纸"]) assert.ok(d.includes(word), "missing " + word);
  for (const word of ["画饼", "画重点", "create_file_task", "search_emoji", "search_web"]) assert.ok(d.includes(word), "missing " + word);
  assert.match(d, /反问/);
  assert.match(d, /一次只生成一张/);
  const p = t.def.function.parameters;
  assert.equal(p.type, "object");
  assert.deepEqual(p.required, ["prompt"]);
  assert.equal(p.properties.prompt.type, "string");
  assert.deepEqual(p.properties.size.enum, ["square", "portrait", "landscape"]);
  assert.ok(tools.EXTRA_TOOLS.some((x) => x.name === "generate_image"), "not registered in tools/index.ts");
});

test("T2 正常：入队 1 条、日志 1 行 ok、用户与群额度各 +1", async () => {
  const e = env();
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const r = await run(tool, e, { prompt: "一只戴草帽的橘猫在海边看日落，水彩风格" });
  assert.equal(r.ok, true);
  assert.equal(r.status, "queued");
  assert.match(r.note, /单独发出/);
  assert.match(r.note, /不要描述图里有什么|看不到/);
  assert.equal(calls.images.length, 1);
  assert.equal(calls.images[0].prompt, "一只戴草帽的橘猫在海边看日落，水彩风格");
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.enqueued[0].jpeg, GOOD_JPEG);
  assert.equal(calls.reserved.length, 2);
  assert.equal(calls.reserved[0].kind, "imagegen_user");
  assert.equal(calls.reserved[0].key, "GROUP-A:u1");
  assert.equal(calls.reserved[0].limit, 5);
  assert.equal(calls.reserved[1].kind, "imagegen_group");
  assert.equal(calls.reserved[1].key, "GROUP-A");
  assert.equal(calls.reserved[1].limit, 20);
  assert.equal(calls.released.length, 0);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "ok");
  assert.equal(log[0].error_kind, null);
  assert.equal(log[0].outbox_id, "turn-1~g");
  assert.equal(log[0].bytes, GOOD_JPEG.length);
  assert.equal(log[0].est_cost_micro_usd, 2500);
  assert.equal(log[0].latency_ms, 1234);
  assert.equal(log[0].model, "gpt-image-1");
  assert.equal(log[0].group_id, "GROUP-A");
  assert.equal(log[0].sender_id, "u1");
  assert.equal(log[0].turn_id, "turn-1");
});

test("T2b 成功日志只存截断 500 字，调用参数保留完整提示词", async () => {
  const e = env();
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const long = "风".repeat(600);
  const r = await run(tool, e, { prompt: long });
  assert.equal(r.ok, true);
  assert.equal(calls.images[0].prompt.length, 600);
  const log = await all(e, "SELECT prompt FROM image_gen_log");
  assert.equal(Array.from(log[0].prompt).length, 500);
});

for (const kind of ["refused", "timeout", "upstream"]) {
  test(`T3/T4 生成失败 ${kind}：不入队、额度退回、返回 error_kind 与 next_action、日志带 error_kind`, async () => {
    const e = env();
    const { deps, calls } = fakeDeps({
      generate: () => ({
        ok: false,
        error_kind: kind,
        retryable: kind !== "refused",
        reason_text: kind === "refused" ? "图片内容安全系统拒绝了这个提示词" : "这次没有拿到图片",
        next_action: "如实告诉成员",
      }),
    });
    const tool = mod.makeGenerateImageTool(deps);
    const r = await run(tool, e, { prompt: "一只猫" });
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, kind);
    assert.ok(r.reason_text.length > 0);
    assert.ok(r.next_action.length > 0);
    assert.equal(calls.enqueued.length, 0);
    assert.equal(calls.released.length, 2, "both reservations must be released");
    const log = await all(e, "SELECT * FROM image_gen_log");
    assert.equal(log.length, 1);
    assert.equal(log[0].status, "failed");
    assert.equal(log[0].error_kind, kind);
    assert.equal(log[0].outbox_id, null);
  });
}

test("T4b 入队失败：图示已生成但不发出，额度退回，日志 failed/upstream", async () => {
  const e = env();
  const { deps, calls } = fakeDeps({
    enqueue: () => {
      throw new Error("outbox down");
    },
  });
  const tool = mod.makeGenerateImageTool(deps);
  const r = await run(tool, e, { prompt: "一只猫" });
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "upstream");
  assert.match(r.reason_text, /没有发出|没能排进发送队列/);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.released.length, 2);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "failed");
  assert.equal(log[0].error_kind, "upstream");
});

test("T5 个人额度用尽：quota，不调 generateImage，日志 1 行 quota", async () => {
  const e = env();
  const { deps, calls } = fakeDeps({
    reserve: (o) => (o.kind === "imagegen_user" ? { ok: false, used: 5, limit: 5 } : { ok: true, used: 1, limit: 20, reservation_id: "r" }),
  });
  const tool = mod.makeGenerateImageTool(deps);
  const r = await run(tool, e, { prompt: "一只猫" });
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "quota");
  assert.match(r.reason_text, /5\/5/);
  assert.match(r.reason_text, /0 张/);
  assert.match(r.reason_text, /24 小时滚动/);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.enqueued.length, 0);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "failed");
  assert.equal(log[0].error_kind, "quota");
});

test("T6 污染 turn：denied，不扣额度、不生成、不写 outbox", async () => {
  const e = env();
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const r = await run(tool, e, { prompt: "一只猫" }, ctx({ tainted: true }));
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "denied");
  assert.match(r.reason_text, /外部资料/);
  assert.equal(r.next_action, "让成员重述");
  assert.equal(calls.reserved.length, 0);
  assert.equal(calls.images.length, 0);
  assert.equal(calls.enqueued.length, 0);
  const outbox = await all(e, "SELECT * FROM outbox");
  assert.equal(outbox.length, 0);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "failed");
  assert.equal(log[0].error_kind, "denied");
});

test("T7 off:generate_image=1 走真 toolkit.runExtraTool → 统一 denied，不生成不记账", async () => {
  const e = env();
  set(e, "off:generate_image", "1");
  const r = await toolkit.runExtraTool(e, "generate_image", { prompt: "一只猫" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "denied");
  assert.equal(r.unavailable, true);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 0);
});

test("T7b off:image_gen=1：purpose 级关闭直接 denied，不扣额度不生成", async () => {
  const e = env();
  set(e, "off:image_gen", "1");
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const r = await run(tool, e, { prompt: "一只猫" });
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "denied");
  assert.equal(r.unavailable, true);
  assert.equal(calls.reserved.length, 0);
  assert.equal(calls.images.length, 0);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].error_kind, "denied");
});

test("T8 群隔离：A 群额度满不影响 B 群同一成员", async () => {
  const e = env();
  const { deps } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const first = await run(tool, e, { prompt: "A 群第一张" }, ctx({ id: "a1", group: "GROUP-A" }));
  assert.equal(first.ok, true);
  // A 群同一成员再要一张：个人日限额 5，不是这里卡住；让 A 群群额度只剩 0 来解释隔离
  const used = new Map([["imagegen_group:GROUP-A", 20]]);
  const isolated = fakeDeps({ used });
  const t2 = mod.makeGenerateImageTool(isolated.deps);
  const blocked = await run(t2, e, { prompt: "A 群第二张" }, ctx({ id: "a2", group: "GROUP-A" }));
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error_kind, "quota");
  assert.equal(isolated.calls.images.length, 0);
  assert.equal(isolated.calls.released.length, 1, "group quota failure releases the member reservation");
  const other = await run(t2, e, { prompt: "B 群第一张" }, ctx({ id: "b1", group: "GROUP-B" }));
  assert.equal(other.ok, true);
  assert.equal(isolated.calls.images.length, 1);
  assert.equal(isolated.calls.images[0].group, "GROUP-B");
});

test("T9 同一 turn 重复触发：只生成一次、只入队一次、只留 1 行日志", async () => {
  const e = env();
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  const first = await run(tool, e, { prompt: "一只猫" });
  const second = await run(tool, e, { prompt: "一只猫" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.status, "queued");
  assert.equal(calls.images.length, 1);
  assert.equal(calls.enqueued.length, 1);
  assert.equal(calls.reserved.length, 2);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 1);
  assert.equal(log[0].status, "ok");
});

test("T10 size 映射：缺省/square/portrait/landscape → 像素尺寸", async () => {
  const cases = [
    [undefined, "1024x1024"],
    ["square", "1024x1024"],
    ["portrait", "1024x1536"],
    ["landscape", "1536x1024"],
  ];
  for (const [size, expected] of cases) {
    const e = env();
    const { deps, calls } = fakeDeps();
    const tool = mod.makeGenerateImageTool(deps);
    const args = { prompt: "一只猫" };
    if (size) args.size = size;
    const r = await run(tool, e, args, ctx({ id: "turn-" + String(size) }));
    assert.equal(r.ok, true, "size " + String(size));
    assert.equal(calls.images[0].size, expected);
  }
});

test("T11 空提示词 / 超 1000 字 / 未知 size → unsupported，不生成不扣额度", async () => {
  const e = env();
  const { deps, calls } = fakeDeps();
  const tool = mod.makeGenerateImageTool(deps);
  for (const args of [{ prompt: "   " }, { prompt: "长".repeat(1001) }, { prompt: "一只猫", size: "huge" }]) {
    const r = await run(tool, e, args);
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "unsupported");
  }
  assert.equal(calls.images.length, 0);
  assert.equal(calls.reserved.length, 0);
  const log = await all(e, "SELECT * FROM image_gen_log");
  assert.equal(log.length, 3);
  for (const row of log) {
    assert.equal(row.status, "failed");
    assert.equal(row.error_kind, "unsupported");
  }
});

test("T12 迁移 0042：可重复执行、列齐全、登记在 schema 与 migrate.mjs", () => {
  const d = new DatabaseSync(":memory:");
  d.exec(migration);
  d.exec(migration);
  const cols = d.prepare("PRAGMA table_info(image_gen_log)").all().map((c) => c.name);
  assert.deepEqual(cols, [
    "id", "group_id", "sender_id", "turn_id", "prompt", "size", "quality", "model",
    "status", "error_kind", "bytes", "latency_ms", "est_cost_micro_usd", "outbox_id", "created_at",
  ]);
  assert.match(migrateRunner, /migrations\/0042_image_gen_log\.sql/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS image_gen_log/);
  // 同一 turn 同时只允许一条 pending/ok 记录；失败后可以重试。
  const insert = "INSERT INTO image_gen_log(group_id,sender_id,turn_id,prompt,size,status,created_at) VALUES(?,?,?,?,?,?,?)";
  d.prepare(insert).run("G", "u", "t", "p", "square", "pending", 1);
  assert.throws(() => d.prepare(insert).run("G", "u", "t", "p", "square", "pending", 1));
  d.prepare("UPDATE image_gen_log SET status='failed' WHERE group_id='G' AND turn_id='t'").run();
  d.prepare(insert).run("G", "u", "t", "p", "square", "pending", 2);
  assert.equal(d.prepare("SELECT COUNT(*) AS n FROM image_gen_log").get().n, 2);
});
