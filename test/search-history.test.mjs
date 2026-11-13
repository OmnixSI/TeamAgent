import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

async function load(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const { searchHistoryTool } = await load("src/tools/search-history.ts");
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
function add(d, group, id, sender, body, i = 1, mentioned = 0) {
  d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
    id,
    group,
    sender,
    body,
    at(i),
    mentioned,
    0,
  );
}
function ctxFor(group, names = []) {
  return {
    context: { latest: { id: "x", group_id: group }, batch: [], recent: [], names: new Map(names) },
    messages: [],
    isTainted: () => false,
  };
}
function seedGroup(d, group, count, sender = "u1", prefix = "m") {
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const id = prefix + String(i).padStart(3, "0");
    add(d, group, id, sender, "第" + i + "条普通消息", i);
    ids.push(id);
  }
  return ids;
}

test("keyword search finds the first of 120 messages with id, time, sender and text", async () => {
  const { d, e } = makeDb();
  seedGroup(d, "GROUP-A", 120);
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("第一条暗号是蓝鲸", "m001");
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("这里有一个测试消息", "m002");

  const r = await searchHistoryTool.run(e, { query: "蓝鲸" }, ctxFor("GROUP-A", [["u1", "阿明"]]));
  assert.equal(r.ok, true);
  assert.equal(r.truncated, false);
  assert.equal(r.items.length, 1);
  assert.deepEqual(Object.keys(r.items[0]).sort(), ["id", "sender", "text", "time"]);
  assert.equal(r.items[0].id, "m001");
  assert.equal(r.items[0].sender, "阿明");
  assert.equal(r.items[0].time, at(1));
  assert.match(r.items[0].text, /蓝鲸/);
});

test("sender filter accepts member id and display name", async () => {
  const { d, e } = makeDb();
  seedGroup(d, "GROUP-A", 12);
  d.prepare("UPDATE messages SET sender=? WHERE id IN ('m010','m011')").run("u2");
  d.prepare("INSERT INTO member_names VALUES(?,?,?,?)").run("u2", "小周", "qq", at(20));

  const byId = await searchHistoryTool.run(e, { sender: "u2" }, ctxFor("GROUP-A", [["u2", "小周"]]));
  assert.deepEqual(byId.items.map((x) => x.id), ["m011", "m010"]);
  assert.deepEqual(byId.items.map((x) => x.sender), ["小周", "小周"]);

  const byName = await searchHistoryTool.run(e, { sender: "小周" }, ctxFor("GROUP-A"));
  assert.deepEqual(byName.items.map((x) => x.id), ["m011", "m010"]);
});

test("sender accepts the 6-char fromId suffix shown to the model", async () => {
  const { d, e } = makeDb();
  seedGroup(d, "GROUP-A", 12);
  d.prepare("UPDATE messages SET sender=? WHERE id IN ('m010','m011')").run("openid-abcdef123456");
  d.prepare("INSERT INTO member_names VALUES(?,?,?,?)").run("openid-abcdef123456", "老周", "qq", at(20));
  const r = await searchHistoryTool.run(e, { sender: "123456" }, ctxFor("GROUP-A"));
  assert.deepEqual(r.items.map((x) => x.id), ["m011", "m010"]);
});

test("2-char Chinese keyword works through the LIKE fallback", async () => {
  const { d, e } = makeDb();
  seedGroup(d, "GROUP-A", 120);
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("这里有一个测试消息", "m002");
  const r = await searchHistoryTool.run(e, { query: "测试" }, ctxFor("GROUP-A"));
  assert.deepEqual(r.items.map((x) => x.id), ["m002"]);
});

test("A group cannot read B group data, even with a forged group_id argument", async () => {
  const { d, e } = makeDb();
  seedGroup(d, "GROUP-A", 10, "u1", "a");
  seedGroup(d, "GROUP-B", 10, "u2", "b");
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("A群第一条是蓝鲸", "a001");
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("B群机密火星计划", "b001");
  d.prepare("UPDATE messages SET body=? WHERE id=?").run("B群也有蓝鲸", "b002");

  const miss = await searchHistoryTool.run(e, { query: "火星" }, ctxFor("GROUP-A"));
  assert.equal(miss.ok, true);
  assert.deepEqual(miss.items, []);
  assert.equal(miss.hint, "当前群没有");

  const forged = await searchHistoryTool.run(
    e,
    { query: "蓝鲸", group_id: "GROUP-B", groupId: "GROUP-B" },
    ctxFor("GROUP-A"),
  );
  assert.deepEqual(forged.items.map((x) => x.id), ["a001"]);

  const other = await searchHistoryTool.run(e, { query: "蓝鲸" }, ctxFor("GROUP-B"));
  assert.deepEqual(other.items.map((x) => x.id), ["b002"]);
});

test("limit defaults to 10, caps at 30, and reports truncation", async () => {
  const { d, e } = makeDb();
  for (let i = 1; i <= 40; i++) add(d, "GROUP-L", "L" + String(i).padStart(3, "0"), "u1", "重复提醒", i);
  const def = await searchHistoryTool.run(e, {}, ctxFor("GROUP-L"));
  assert.equal(def.items.length, 10);
  assert.equal(def.truncated, true);
  const three = await searchHistoryTool.run(e, { limit: 3 }, ctxFor("GROUP-L"));
  assert.equal(three.items.length, 3);
  assert.equal(three.truncated, true);
  const capped = await searchHistoryTool.run(e, { limit: 999 }, ctxFor("GROUP-L"));
  assert.equal(capped.items.length, 30);
  assert.equal(capped.truncated, true);
  const zero = await searchHistoryTool.run(e, { limit: 0 }, ctxFor("GROUP-L"));
  assert.equal(zero.items.length, 10);
});

test("before_id pages strictly older inside the same group", async () => {
  const { d, e } = makeDb();
  for (let i = 1; i <= 40; i++)
    add(d, "GROUP-P", "p" + String(i).padStart(3, "0"), "u1", "翻页消息", i);
  const r = await searchHistoryTool.run(
    e,
    { query: "翻页", before_id: "p030", limit: 5 },
    ctxFor("GROUP-P"),
  );
  assert.deepEqual(r.items.map((x) => x.id), ["p029", "p028", "p027", "p026", "p025"]);
  const bad = await searchHistoryTool.run(
    e,
    { query: "翻页", before_id: "not-in-this-group" },
    ctxFor("GROUP-P"),
  );
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, "unknown_cursor");
});

test("since_hours limits by timestamp and combines with keyword", async () => {
  const { d, e } = makeDb();
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  const now = new Date(Date.now() - 60_000).toISOString();
  d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("s1", "GROUP-S", "u1", "旧暗号", old, 0, 0);
  d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run("s2", "GROUP-S", "u1", "新暗号", now, 0, 0);
  const all = await searchHistoryTool.run(e, { query: "暗号" }, ctxFor("GROUP-S"));
  assert.deepEqual(all.items.map((x) => x.id), ["s2", "s1"]);
  const recent = await searchHistoryTool.run(e, { query: "暗号", since_hours: 1 }, ctxFor("GROUP-S"));
  assert.deepEqual(recent.items.map((x) => x.id), ["s2"]);
});

test("history text is redacted before it reaches the model", async () => {
  const { d, e } = makeDb();
  add(d, "GROUP-R", "r1", "u1", "密钥 sk-abcdefghijklmnopqrstuvwxyz", 1);
  const r = await searchHistoryTool.run(e, { query: "密钥" }, ctxFor("GROUP-R"));
  assert.equal(r.items[0].text.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.match(r.items[0].text, /\[密钥已隐藏\]/);
});

test("missing group context fails closed", async () => {
  const { e } = makeDb();
  const r = await searchHistoryTool.run(e, { query: "任何" }, {
    context: { batch: [], recent: [] },
    messages: [],
    isTainted: () => false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "no_context");
});

test("search_history is registered as an untrusted tool with no group_id argument", () => {
  const tool = EXTRA_TOOLS.find((t) => t.name === "search_history");
  assert.ok(tool, "search_history must be in EXTRA_TOOLS");
  assert.equal(tool.def.function.name, tool.name);
  assert.equal(tool.untrusted, true);
  assert.equal(tool.def.function.parameters.properties.group_id, undefined);
  assert.equal(tool.def.function.parameters.properties.groupId, undefined);
  assert.equal(tool.def.function.parameters.required, undefined);
  assert.ok(tool.def.function.description.includes("当前群"));
});

test("toolkit dispatch reaches search_history and honors the admin kill switch", async () => {
  const { d, e } = makeDb();
  add(d, "GROUP-K", "k1", "u1", "扩展点能查到的暗号", 1);
  const ctx = ctxFor("GROUP-K");
  const hit = await toolkit.runExtraTool(e, "search_history", { query: "暗号" }, ctx);
  assert.equal(hit.ok, true);
  assert.deepEqual(hit.items.map((x) => x.id), ["k1"]);

  d.prepare("INSERT INTO settings VALUES(?,?)").run("off:search_history", "1");
  const denied = await toolkit.runExtraTool(e, "search_history", { query: "暗号" }, ctx);
  assert.equal(denied.unavailable, true);
  assert.equal(denied.error_kind, "denied");
});
