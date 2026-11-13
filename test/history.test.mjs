import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

async function load() {
  const out = await build({
    entryPoints: ["src/history.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const history = await load();

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

function add(d, id, group, sender, body, ts, mentioned = 0) {
  d.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
    id,
    group,
    sender,
    body,
    ts,
    mentioned,
    0,
  );
}

test("listMessages only returns the requested group, newest first", async () => {
  const { d, e } = makeDb();
  add(d, "a1", "GROUP-A", "u1", "甲群第一条", "2026-11-13T00:00:01.000Z");
  add(d, "a2", "GROUP-A", "u1", "甲群第二条", "2026-11-13T00:00:02.000Z");
  add(d, "b1", "GROUP-B", "u2", "乙群秘密", "2026-11-13T00:00:03.000Z");
  const rows = await history.listMessages(e, { groupId: "GROUP-A" });
  assert.deepEqual(rows.map((r) => r.id), ["a2", "a1"]);
  assert.ok(rows.every((r) => r.body !== "乙群秘密"));
});

test("newestFirst:false returns oldest first", async () => {
  const { d, e } = makeDb();
  add(d, "a1", "G", "u1", "一", "2026-11-13T00:00:01.000Z");
  add(d, "a2", "G", "u1", "二", "2026-11-13T00:00:02.000Z");
  const rows = await history.listMessages(e, { groupId: "G", newestFirst: false });
  assert.deepEqual(rows.map((r) => r.id), ["a1", "a2"]);
});

test("sender and exact timestamp bounds filter inside the group", async () => {
  const { d, e } = makeDb();
  add(d, "m1", "G", "u1", "一", "2026-11-13T00:00:01.000Z");
  add(d, "m2", "G", "u2", "二", "2026-11-13T00:00:02.000Z");
  add(d, "m3", "G", "u2", "三", "2026-11-13T00:00:03.000Z");
  add(d, "m4", "G", "u2", "四", "2026-11-13T00:00:04.000Z");

  const bySender = await history.listMessages(e, { groupId: "G", sender: "u2" });
  assert.deepEqual(bySender.map((r) => r.id), ["m4", "m3", "m2"]);

  const bounded = await history.listMessages(e, {
    groupId: "G",
    afterTs: "2026-11-13T00:00:02.000Z",
    beforeTs: "2026-11-13T00:00:04.000Z",
  });
  assert.deepEqual(bounded.map((r) => r.id), ["m3"]);
});

test("terms match every word, including 2-char Chinese, and wildcards stay literal", async () => {
  const { d, e } = makeDb();
  add(d, "m1", "G", "u1", "今天测试一下检索", "2026-11-13T00:00:01.000Z");
  add(d, "m2", "G", "u1", "测试 另一个 关键词", "2026-11-13T00:00:02.000Z");
  add(d, "m3", "G", "u1", "进度 100%完成", "2026-11-13T00:00:03.000Z");
  add(d, "m4", "G", "u1", "进度 100完成", "2026-11-13T00:00:04.000Z");

  const twoChars = await history.listMessages(e, { groupId: "G", terms: ["测试"] });
  assert.deepEqual(twoChars.map((r) => r.id), ["m2", "m1"]);

  const everyTerm = await history.listMessages(e, { groupId: "G", terms: ["测试", "关键词"] });
  assert.deepEqual(everyTerm.map((r) => r.id), ["m2"]);

  const literalPercent = await history.listMessages(e, { groupId: "G", terms: ["100%完成"] });
  assert.deepEqual(literalPercent.map((r) => r.id), ["m3"]);
});

test("limit is clamped to 1..200 without changing the caller's object", async () => {
  const { d, e } = makeDb();
  for (let i = 1; i <= 205; i++)
    add(d, "m" + i, "G", "u1", "消息" + i, new Date(Date.UTC(2026, 10, 13, 0, 0, i)).toISOString());
  const q = { groupId: "G", limit: -10 };
  assert.equal((await history.listMessages(e, q)).length, 1);
  assert.equal(q.limit, -10);
  assert.equal((await history.listMessages(e, { groupId: "G", limit: 0 })).length, 1);
  assert.equal((await history.listMessages(e, { groupId: "G", limit: 999 })).length, 200);
});

test("bodies are redacted and clipped before leaving history", async () => {
  const { d, e } = makeDb();
  add(
    d,
    "m1",
    "G",
    "u1",
    "token sk-abcdefghijklmnopqrstuvwxyz 结束",
    "2026-11-13T00:00:01.000Z",
  );
  add(d, "m2", "G", "u1", "0123456789", "2026-11-13T00:00:02.000Z");
  const [secret] = await history.listMessages(e, { groupId: "G", terms: ["token"] });
  assert.equal(secret.body.includes("sk-abcdefghijklmnopqrstuvwxyz"), false);
  assert.ok(secret.body.includes("[密钥已隐藏]"));
  const [clipped] = await history.listMessages(e, { groupId: "G", terms: ["0123456789"], clip: 4 });
  assert.equal(clipped.body, "0123");
});
