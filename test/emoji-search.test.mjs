// F7-13 emoji-semantic search: read-only, group-scoped, no sending and no model calls.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

async function load(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const { emojiSearchTool } = await load("src/tools/emoji-search.ts");
const { EXTRA_TOOLS } = await load("src/tools/index.ts");
const toolkit = await load("src/toolkit.ts");

function makeDb() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const database = {
    prepare(sql) {
      const statement = (args = []) => ({
        bind(...values) {
          return statement(values);
        },
        async first() {
          return d.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: d.prepare(sql).all(...args) };
        },
      });
      return statement();
    },
  };
  return { d, e: { DB: database } };
}

const base = Date.parse("2026-11-13T00:00:00.000Z");
const at = (i) => new Date(base + i * 1000).toISOString();
function addMessage(d, group, id, i = 1) {
  d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(id, group, "u1", "普通消息 " + id, at(i), 0, 0);
}
function addSticker(d, sha, { source = null, desc = "", tags = [], state = 2, uses = 0, created = 0 } = {}) {
  d.prepare(
    "INSERT INTO stickers(sha,mime,bytes,data,desc,tags,state,senders,source_message,created_at,uses) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
  ).run(sha, "image/gif", 1, new Uint8Array([1]).buffer, desc, JSON.stringify(tags), state, "[]", source, created, uses);
}
function ctxFor(group) {
  return {
    context: { latest: { id: "x", group_id: group }, batch: [], recent: [] },
    messages: [],
    isTainted: () => false,
  };
}
function count(d, table) {
  return Number(d.prepare("SELECT COUNT(*) AS n FROM " + table).get().n);
}

test("同义词：『无语』命中标签为沉默/无奈的表情", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "m1");
  addSticker(d, "sha-silent", { source: "m1", desc: "沉默地看着屏幕，一句话也说不出来", tags: ["沉默", "无奈"] });
  const r = await emojiSearchTool.run(e, { mood: "无语" }, ctxFor("GROUP-A"));
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].sticker, "sha-silent");
  assert.ok(r.items[0].score >= 0.6, "score " + r.items[0].score);
  assert.ok(r.items[0].matched.some((x) => ["沉默", "无奈"].includes(x)), JSON.stringify(r.items[0].matched));
});

test("关键词：mood 直接命中标签，query 命中描述里的字面词", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "m1");
  addMessage(d, "GROUP-A", "m2");
  addSticker(d, "sha-happy", { source: "m1", desc: "笑得很开心", tags: ["开心", "笑"] });
  addSticker(d, "sha-cat", { source: "m2", desc: "一只橘猫在纸箱里", tags: ["猫猫", "可爱"] });
  const byMood = await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-A"));
  assert.equal(byMood.items[0].sticker, "sha-happy");
  const byQuery = await emojiSearchTool.run(e, { query: "猫猫" }, ctxFor("GROUP-A"));
  assert.equal(byQuery.items.length, 1);
  assert.equal(byQuery.items[0].sticker, "sha-cat");
});

test("无命中返回空数组，不编造贴纸", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "m1");
  addSticker(d, "sha-happy", { source: "m1", desc: "笑得很开心", tags: ["开心"] });
  const r = await emojiSearchTool.run(e, { query: "火箭发射升空" }, ctxFor("GROUP-A"));
  assert.equal(r.ok, true);
  assert.deepEqual(r.items, []);
  assert.equal(typeof r.hint, "string");
});

test("群隔离：A 群贴纸在 B 群查不到，B 群也读不到 A 群", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "ma");
  addMessage(d, "GROUP-B", "mb");
  addSticker(d, "sha-a", { source: "ma", desc: "开心到起飞", tags: ["开心"] });
  addSticker(d, "sha-b", { source: "mb", desc: "开心地转圈", tags: ["开心"] });
  const fromA = await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-A"));
  const fromB = await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-B"));
  assert.deepEqual(fromA.items.map((x) => x.sticker), ["sha-a"]);
  assert.deepEqual(fromB.items.map((x) => x.sticker), ["sha-b"]);
});

test("只返回已打标 meme（state=2）；未打标、被拒和导入无来源的都不出现", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "m1");
  addSticker(d, "sha-ok", { source: "m1", desc: "开心", tags: ["开心"], state: 2 });
  addSticker(d, "sha-untagged", { source: "m1", desc: "开心", tags: ["开心"], state: 1 });
  addSticker(d, "sha-rejected", { source: "m1", desc: "开心", tags: ["开心"], state: 3 });
  addSticker(d, "sha-imported", { source: null, desc: "开心", tags: ["开心"], state: 2 });
  const r = await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-A"));
  assert.deepEqual(r.items.map((x) => x.sticker), ["sha-ok"]);
});

test("只读：查询不写 outbox/jobs/activity，也不改 stickers", async () => {
  const { d, e } = makeDb();
  addMessage(d, "GROUP-A", "m1");
  addSticker(d, "sha-happy", { source: "m1", desc: "开心", tags: ["开心"], uses: 3 });
  const before = ["outbox", "jobs", "activity", "stickers"].map((t) => [t, count(d, t)]);
  const snapshot = d.prepare("SELECT sha,uses,desc,tags FROM stickers").all();
  await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-A"));
  assert.deepEqual(["outbox", "jobs", "activity", "stickers"].map((t) => [t, count(d, t)]), before);
  assert.deepEqual(d.prepare("SELECT sha,uses,desc,tags FROM stickers").all(), snapshot);
});

test("没有群上下文时结构化失败，不跨群兜底", async () => {
  const { e } = makeDb();
  const r = await emojiSearchTool.run(e, { mood: "开心" }, { context: {}, messages: [], isTainted: () => false });
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "no_context");
  assert.equal(r.retryable, false);
});

test("mood 和 query 都为空时 bad_args", async () => {
  const { e } = makeDb();
  const r = await emojiSearchTool.run(e, {}, ctxFor("GROUP-A"));
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "bad_args");
});

test("最多返回 3 个候选，分数高的在前", async () => {
  const { d, e } = makeDb();
  for (let i = 1; i <= 5; i++) addMessage(d, "GROUP-A", "m" + i, i);
  addSticker(d, "sha-weak", { source: "m1", desc: "今天心情还行", tags: ["平静"], created: 1 });
  for (let i = 2; i <= 5; i++) addSticker(d, "sha-" + i, { source: "m" + i, desc: "开心", tags: ["开心"], created: i });
  const r = await emojiSearchTool.run(e, { mood: "开心" }, ctxFor("GROUP-A"));
  assert.equal(r.items.length, 3);
  assert.ok(r.items.every((x) => x.sticker !== "sha-weak"));
  for (let i = 1; i < r.items.length; i++) assert.ok(r.items[i - 1].score >= r.items[i].score);
  assert.ok(r.truncated);
});

test("注册进 EXTRA_TOOLS：名字一致、untrusted；管理员开关关闭后返回 denied", async () => {
  assert.ok(EXTRA_TOOLS.some((t) => t.name === "search_emoji"));
  assert.equal(toolkit.findExtraTool("search_emoji")?.name, "search_emoji");
  assert.equal(toolkit.findExtraTool("search_emoji")?.untrusted, true);
  assert.equal(toolkit.findExtraTool("search_emoji")?.def.function.name, "search_emoji");
  const { d, e } = makeDb();
  d.prepare("INSERT INTO settings VALUES(?,?)").run("off:search_emoji", "1");
  const r = await toolkit.runExtraTool(e, "search_emoji", { mood: "开心" }, ctxFor("GROUP-A"));
  assert.equal(r.unavailable, true);
  assert.equal(r.error_kind, "denied");
});
