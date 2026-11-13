import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0022_profiles.sql", import.meta.url), "utf8");
const migrateRunner = readFileSync(new URL("../scripts/migrate.mjs", import.meta.url), "utf8");

async function load(entry) {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
let modules;
async function api() {
  if (!modules) modules = { profiles: await load("src/profiles.ts"), tools: await load("src/tools/profile.ts") };
  return modules;
}
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
      return Promise.all(statements.map((s) => /^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(s.sql) ? s.all() : s.run()));
    },
    raw: d,
  };
  return database;
}
const env = () => ({ DB: database(), DEEPSEEK_API_KEY: "fake" });
const set = (e, key, value) => e.DB.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(key, value).run();
const get = async (e, key) => (await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value;
const all = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;
const G = "GROUP-A", G2 = "GROUP-B";
const NIGHT = (day = 14, hour = 4) => new Date(`2026-11-${day}T${String(hour).padStart(2, "0")}:00:00+11:00`);
const TS = (day = 13, hour = 20, minute = 0) => new Date(`2026-11-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+08:00`).toISOString();
function seed(e, rows) {
  for (const r of rows) {
    e.DB.prepare("INSERT INTO messages(id,group_id,sender,body,ts,mentioned,processed) VALUES(?,?,?,?,?,?,0)")
      .bind(r.id, r.group_id || G, r.sender, r.body, r.ts || TS(), r.mentioned ? 1 : 0).run();
  }
}
function name(e, id, value) {
  e.DB.prepare("INSERT OR REPLACE INTO member_names VALUES(?,?,'test',?)").bind(id, JSON.stringify(value), new Date().toISOString()).run();
}
const baseMessages = (groupId = G) => [
  { id: "m1", group_id: groupId, sender: "u1", body: "我平时喜欢用 DeepSeek 写后端脚本", ts: TS(13, 20) },
  { id: "m2", group_id: groupId, sender: "u1", body: "我平时喜欢吸猫，周末也写点脚本", ts: TS(13, 20, 5) },
  { id: "m3", group_id: groupId, sender: "u1", body: "今天这个接口又挂了", ts: TS(13, 20, 10) },
  { id: "m4", group_id: groupId, sender: "u2", body: "我也在看后端", ts: TS(13, 20, 20) },
  { id: "m5", group_id: groupId, sender: "u2", body: "测试怎么跑", ts: TS(13, 20, 30) },
];
const ctx = (sender = "u1", body = "我的画像是什么", groupId = G, tainted = false) => ({
  context: { names: new Map() },
  source: { id: "call-1", sender, body, group_id: groupId },
  messages: [],
  isTainted: () => tainted,
});

test("migration 0022 creates profiles, is replayable and registered", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migration);
    db.exec(migration);
    const cols = db.prepare("PRAGMA table_info(profiles)").all().map((c) => c.name);
    assert.deepEqual(cols, ["group_id", "user_id", "summary", "updated_at", "source_ids"]);
    db.prepare("INSERT INTO profiles VALUES(?,?,?,?,?)").run(G, "u1", '{"address":[]}', 1, "[]");
    assert.equal(db.prepare("SELECT user_id FROM profiles").get().user_id, "u1");
    assert.match(migrateRunner, /migrations\/0022_profiles\.sql/);
    const fresh = new DatabaseSync(":memory:");
    fresh.exec(schema);
    fresh.prepare("INSERT INTO profiles VALUES(?,?,?,?,?)").run(G2, "u2", '{"address":[]}', 2, "[]");
    assert.equal(fresh.prepare("SELECT user_id FROM profiles").get().user_id, "u2");
    fresh.close();
  } finally { db.close(); }
});

test("nightly job is disabled by default and only runs inside the night window", async () => {
  const { profiles } = await api();
  const e = env();
  seed(e, baseMessages());
  let called = 0;
  const extract = async () => { called++; return {}; };
  const off = await profiles.runProfilesNightly(e, { now: NIGHT(), timeZone: "Australia/Sydney", extract });
  assert.equal(off.ran, false);
  assert.equal(off.reason, "disabled");
  await set(e, "profiles_enabled", "1");
  const day = await profiles.runProfilesNightly(e, { now: new Date("2026-11-13T12:00:00+11:00"), timeZone: "Australia/Sydney", extract });
  assert.equal(day.ran, false);
  assert.equal(day.reason, "outside_window");
  assert.equal(called, 0);
  assert.equal((await all(e, "SELECT * FROM profiles")).length, 0);
});

test("nightly extracts stable entries with sources and merges incrementally", async () => {
  const { profiles } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  await set(e, "group_id", G);
  seed(e, baseMessages());
  name(e, "u1", "老王");
  const seen = [];
  const extract = async (input) => {
    seen.push(input);
    if (seen.length === 1)
      return {
        address: [{ text: "大家叫他老王", source_ids: ["m1"] }],
        preferences: [{ text: "偏好用 DeepSeek 写后端", quote: "喜欢吸猫" }],
        topics: [{ text: "后端脚本", source_ids: ["m2"] }],
      };
    return { preferences: [{ text: "周末也写脚本", quote: "周末也写点脚本" }] };
  };
  const first = await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, maxUsersPerNight: 1 });
  assert.equal(first.updated, 1);
  const row = (await all(e, "SELECT * FROM profiles WHERE group_id=? AND user_id=?", G, "u1"))[0];
  assert.ok(row);
  const summary = JSON.parse(row.summary);
  assert.equal(summary.address[0].text, "大家叫他老王");
  assert.deepEqual(summary.address[0].source_ids, ["m1"]);
  assert.deepEqual(summary.preferences[0].source_ids, ["m2"], "quote is resolved to a real message id");
  assert.equal(summary.topics[0].text, "后端脚本");
  assert.equal(summary.preferences[0].updated_at, NIGHT(14).getTime());
  assert.equal(JSON.parse(row.source_ids).includes("m1"), true);
  assert.equal(JSON.parse(row.source_ids).includes("m2"), true);
  assert.equal(seen[0].groupId, G);
  assert.equal(seen[0].userId, "u1");
  assert.equal(seen[0].name, "老王");
  assert.ok(seen[0].messages.every((m) => m.id.startsWith("m") && !m.body.includes("u2")));

  seed(e, [
    { id: "m6", sender: "u1", body: "周末也写点脚本，顺便看猫", ts: TS(14, 20) },
    { id: "m7", sender: "u1", body: "脚本写完了", ts: TS(14, 20, 5) },
  ]);
  const second = await profiles.runProfilesNightly(e, { now: NIGHT(15), timeZone: "Australia/Sydney", extract, minMessages: 2, maxUsersPerNight: 1 });
  assert.equal(second.updated, 1);
  const merged = JSON.parse((await all(e, "SELECT summary FROM profiles WHERE group_id=? AND user_id=?", G, "u1"))[0].summary);
  assert.deepEqual(merged.preferences.map((x) => x.text), ["偏好用 DeepSeek 写后端", "周末也写脚本"]);
  assert.equal(seen[1].existing.preferences[0].text, "偏好用 DeepSeek 写后端");
  assert.deepEqual(merged.preferences[1].source_ids, ["m6"]);
});

test("sensitive entries and verbatim copies never reach storage", async () => {
  const { profiles } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  await set(e, "group_id", G);
  seed(e, [
    ...baseMessages(),
    { id: "m8", sender: "u3", body: "我手机 13800138000，身份证 110101199001011234，家住北京市朝阳区某路1号，密码是 abc123", ts: TS(13, 20, 40) },
    { id: "m9", sender: "u3", body: "别记这些", ts: TS(13, 20, 45) },
    { id: "m10", sender: "u4", body: "这是一段很长很长的原话，我只是把今天发生的所有事情从头到尾详细讲了一遍，没有什么可以提炼的稳定偏好。", ts: TS(13, 21) },
    { id: "m11", sender: "u4", body: "确实", ts: TS(13, 21, 5) },
  ]);
  const extract = async (input) => {
    if (input.userId === "u1")
      return {
        preferences: [
          { text: "手机号 13800138000", source_ids: ["m1"] },
          { text: "身份证 110101199001011234", source_ids: ["m1"] },
          { text: "住址：北京市朝阳区某路1号", source_ids: ["m2"] },
          { text: "密码是 abc123", source_ids: ["m2"] },
          { text: "喜欢猫", source_ids: ["m2"] },
        ],
      };
    if (input.userId === "u3") return { preferences: [{ text: "手机 13800138000", source_ids: ["m8"] }] };
    return { preferences: [{ text: input.messages[0].body, source_ids: ["m10"] }] };
  };
  const result = await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, maxUsersPerRun: 10 });
  assert.ok(result.sensitive >= 4);
  const u1 = JSON.parse((await all(e, "SELECT summary FROM profiles WHERE user_id='u1'"))[0].summary);
  assert.deepEqual(u1.preferences.map((x) => x.text), ["喜欢猫"]);
  assert.equal((await all(e, "SELECT * FROM profiles WHERE user_id='u3'")).length, 0);
  assert.equal((await all(e, "SELECT * FROM profiles WHERE user_id='u4'")).length, 0, "a copied message is not a profile");
});

test("profiles are isolated by group and forget only removes one group", async () => {
  const { profiles } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  seed(e, [...baseMessages(G).filter((m) => m.sender === "u1"), { id: "b1", group_id: G2, sender: "u1", body: "B 群聊前端", ts: TS(13, 20) }, { id: "b2", group_id: G2, sender: "u1", body: "B 群聊样式", ts: TS(13, 20, 5) }]);
  const extract = async (input) => ({ topics: [{ text: input.groupId === G ? "后端" : "前端", source_ids: [input.messages[0].id] }] });
  const result = await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G, G2] });
  assert.equal(result.updated, 2);
  const a = await profiles.readProfile(e, G, "u1"), b = await profiles.readProfile(e, G2, "u1");
  assert.equal(a.topics[0].text, "后端");
  assert.equal(b.topics[0].text, "前端");
  const forgotten = await profiles.forgetProfile(e, { groupId: G, userId: "u1", actorId: "u1" });
  assert.equal(forgotten.ok, true);
  assert.equal(forgotten.deleted, true);
  assert.equal(await profiles.readProfile(e, G, "u1"), null);
  assert.equal((await profiles.readProfile(e, G2, "u1")).topics[0].text, "前端");
  assert.equal(await profiles.isProfileOff(e, G, "u1"), true);
  const blocked = await profiles.runProfilesNightly(e, { now: NIGHT(15), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  assert.equal(blocked.updated, 0, "forget leaves an opt-out so history cannot rebuild it next night");
  await profiles.setProfileOff(e, G, "u1", false);
  seed(e, [{ id: "m12", sender: "u1", body: "重新开始", ts: TS(15, 20) }, { id: "m13", sender: "u1", body: "后端还在", ts: TS(15, 20, 5) }]);
  await profiles.runProfilesNightly(e, { now: NIGHT(16), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  assert.ok(await profiles.readProfile(e, G, "u1"));
});

test("only the member or an admin can forget; admin delete does not opt the member out", async () => {
  const { profiles } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  seed(e, baseMessages());
  const extract = async (input) => ({ topics: [{ text: "后端", source_ids: [input.messages[0].id] }] });
  await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  const denied = await profiles.forgetProfile(e, { groupId: G, userId: "u1", actorId: "u2" });
  assert.equal(denied.ok, false);
  assert.equal(denied.deleted, false);
  assert.ok(await profiles.readProfile(e, G, "u1"));
  await set(e, "profile_admin:" + G, "admin1");
  assert.equal(await profiles.isProfileAdmin(e, G, "admin1"), true);
  assert.equal(await profiles.isProfileAdmin(e, G, "u2"), false);
  const done = await profiles.forgetProfile(e, { groupId: G, userId: "u1", actorId: "admin1" });
  assert.equal(done.ok, true);
  assert.equal(done.deleted, true);
  assert.equal(await profiles.isProfileOff(e, G, "u1"), false);
});

test("nightly budget is per night and re-runs do not repeat users", async () => {
  const { profiles } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  const rows = [];
  for (const user of ["a", "b", "c"]) for (let i = 0; i < (user === "a" ? 3 : 2); i++) rows.push({ id: user + i, sender: user, body: `我是${user}，喜欢后端 ${i}`, ts: TS(13, 20, i) });
  seed(e, rows);
  const called = [];
  const extract = async (input) => { called.push(input.userId); return { preferences: [{ text: `用户 ${input.userId} 喜欢后端`, source_ids: [input.messages[0].id] }] }; };
  const first = await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G], maxUsersPerNight: 2 });
  assert.equal(first.updated, 2);
  assert.equal(new Set(called).size, 2, "budget stops after two members");
  const firstTwo = [...called].sort();
  const second = await profiles.runProfilesNightly(e, { now: NIGHT(14, 5), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G], maxUsersPerNight: 2 });
  assert.equal(second.updated, 0);
  assert.deepEqual([...called].sort(), firstTwo, "same night does not call the model again");
  const missing = ["a", "b", "c"].find((user) => !called.includes(user));
  seed(e, [{ id: missing + "-new1", sender: missing, body: `我是${missing}，还在写后端`, ts: TS(14, 20) }, { id: missing + "-new2", sender: missing, body: "后端新消息", ts: TS(14, 20, 5) }]);
  const next = await profiles.runProfilesNightly(e, { now: NIGHT(15), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G], maxUsersPerNight: 2 });
  assert.equal(next.updated, 1, "next night processes the remaining member");
  assert.deepEqual([...new Set(called)].sort(), ["a", "b", "c"]);
});

test("get_profile is untrusted, self-or-admin, and forget_profile needs an explicit untainted request", async () => {
  const { profiles, tools } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  seed(e, baseMessages());
  name(e, "u2", "小明");
  const extract = async (input) => ({ preferences: [{ text: "喜欢后端", source_ids: [input.messages[0].id] }] });
  await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  assert.equal(tools.getProfileTool.untrusted, true);
  const own = await tools.getProfileTool.run(e, {}, ctx("u1"));
  assert.equal(own.ok, true);
  assert.equal(own.profile.preferences[0].text, "喜欢后端");
  assert.ok(own.profile.preferences[0].source_ids.length);
  const other = await tools.getProfileTool.run(e, { user: "u2" }, ctx("u1"));
  assert.equal(other.ok, false);
  assert.equal(other.error_kind, "denied");
  await set(e, "profile_admin:" + G, "u1");
  const byName = await tools.getProfileTool.run(e, { user: "小明" }, ctx("u1"));
  assert.equal(byName.ok, true);
  assert.equal(byName.user_id, "u2");
  await set(e, "profile_admin:" + G, "");
  const tainted = await tools.forgetProfileTool.run(e, {}, ctx("u1", "忘记我", G, true));
  assert.equal(tainted.ok, false);
  const unclear = await tools.forgetProfileTool.run(e, {}, ctx("u1", "今天天气不错"));
  assert.equal(unclear.ok, false);
  const done = await tools.forgetProfileTool.run(e, {}, ctx("u1", "忘记我的画像"));
  assert.equal(done.ok, true);
  assert.equal(done.deleted, true);
  assert.equal(await profiles.readProfile(e, G, "u1"), null);
  assert.equal(await profiles.isProfileOff(e, G, "u1"), true);
  const off = await tools.getProfileTool.run(e, {}, ctx("u1"));
  assert.equal(off.off, true);
  assert.equal(off.profile, null);
  assert.equal((await all(e, "SELECT * FROM profiles WHERE user_id='u1'")).length, 0);
});

test("member opt-out is honored and a missing profile is never created by reading", async () => {
  const { profiles, tools } = await api();
  const e = env();
  await set(e, "profiles_enabled", "1");
  seed(e, baseMessages());
  const empty = await tools.getProfileTool.run(e, {}, ctx("u1"));
  assert.equal(empty.ok, true);
  assert.equal(empty.profile, null);
  assert.equal((await all(e, "SELECT * FROM profiles")).length, 0);
  const extract = async (input) => ({ topics: [{ text: "后端", source_ids: [input.messages[0].id] }] });
  await profiles.runProfilesNightly(e, { now: NIGHT(14), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  const before = await profiles.readProfile(e, G, "u1");
  assert.ok(before);
  await profiles.setProfileOff(e, G, "u1", true);
  seed(e, [{ id: "m20", sender: "u1", body: "新一轮后端", ts: TS(14, 20) }, { id: "m21", sender: "u1", body: "还是后端", ts: TS(14, 20, 5) }]);
  const skipped = await profiles.runProfilesNightly(e, { now: NIGHT(15), timeZone: "Australia/Sydney", extract, minMessages: 2, groupIds: [G] });
  assert.equal(skipped.updated, 0);
  assert.deepEqual(await profiles.readProfile(e, G, "u1"), before, "opted-out profile is not updated");
  const off = await tools.getProfileTool.run(e, {}, ctx("u1"));
  assert.equal(off.off, true);
});

test("wiring: both tools are registered and the nightly job is in CRON_JOBS", async () => {
  const registry = await load("src/tools/index.ts");
  const cron = await load("src/tools/cron-jobs.ts");
  const { profiles } = await api();
  assert.deepEqual(registry.EXTRA_TOOLS.map((tool) => tool.name).sort(), ["forget_profile", "get_profile"]);
  assert.equal(registry.EXTRA_TOOLS.find((tool) => tool.name === "get_profile").untrusted, true);
  assert.equal(registry.EXTRA_TOOLS.find((tool) => tool.name === "forget_profile").untrusted, false);
  assert.ok(cron.CRON_JOBS.some((job) => job.name === "profiles"));
  assert.equal(profiles.isSensitiveProfileText("喜欢猫和后端"), false);
  assert.equal(profiles.isSensitiveProfileText("手机号 13800138000"), true);
  assert.equal(profiles.isSensitiveProfileText("身份证 110101199001011234"), true);
});
