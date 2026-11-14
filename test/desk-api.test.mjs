// D8 工作台只读接口：形状、私有过滤、CSV、技能、日程。
// 全部走本地假 D1（schema.sql 内存库）+ owner 会话，不碰线上。
import { test } from "node:test";
import assert from "node:assert/strict";
import { env, req } from "./support.mjs";

const G = "GROUP000001";
const NOW = Date.parse("2026-11-14T18:00:00+11:00");
const run = (e, sql, ...args) => e.DB.prepare(sql).bind(...args).run();

const ledgerSchema = JSON.stringify({
  fields: [
    { key: "person", label: "人名", type: "person" },
    { key: "amount", label: "金额", type: "money" },
    { key: "title", label: "事项", type: "text" },
    { key: "occurred_at", label: "时间", type: "date" },
    { key: "cat", label: "类别", type: "text" },
    { key: "note", label: "备注", type: "text" },
    { key: "tag", label: "标签", type: "text" },
    { key: "memo", label: "说明", type: "text" },
  ],
  summary: { group_by: "person", sum: "amount_cents" },
});

async function seed(e) {
  await req(e, "/api/admin/bind", { groupId: G });
  await run(e, "INSERT INTO member_names VALUES(?,?,?,?)", "u1", "小明", "qq", new Date(NOW).toISOString());
  await run(e, "INSERT INTO member_names VALUES(?,?,?,?)", "u2", "小红", "qq", new Date(NOW).toISOString());
  const type = (id, name, kind, schema, status, owner, at) =>
    run(e,
      "INSERT INTO record_types(id,group_id,name,kind,schema,visibility_default,owner,status,created_at,updated_at) VALUES(?,?,?,?,?,'group',?,?,?,?)",
      id, G, name, kind, schema || "{}", owner, status, at, at);
  await type("rt-ledger", "报销额度", "ledger", ledgerSchema, "active", "u1", NOW - 3000);
  await type("rt-list", "购物清单", "list", "{}", "active", "u2", NOW - 2000);
  await type("rt-log", "体重", "log", "{}", "active", "u1", NOW - 1000);
  await type("rt-arch", "旧账本", "ledger", "{}", "archived", "u1", NOW - 500);
  const record = (id, typeId, creator, visibility, data, at) =>
    run(e,
      "INSERT INTO records(id,type_id,group_id,creator,visibility,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      id, typeId, G, creator, visibility, JSON.stringify(data), at, at);
  await record("r-000001", "rt-ledger", "u1", "group",
    { person: "小明", amount_cents: 36000, title: "打车", occurred_at: NOW - 60000, cat: "交通", note: "从公司回家" }, NOW - 60000);
  await record("r-000002", "rt-ledger", "u2", "group",
    { person: "小红", amount_cents: -1000, title: "退款", occurred_at: NOW - 120000 }, NOW - 120000);
  await record("r-000003", "rt-ledger", "u1", "private",
    { person: "小明", amount_cents: 5000, title: "私房钱", occurred_at: NOW - 180000 }, NOW - 180000);
  await record("r-000004", "rt-list", "u1", "group",
    { title: "牛奶", status: "todo", person: "小明" }, NOW - 240000);
  await record("r-000005", "rt-list", "u2", "group",
    { title: "面包", status: "done", person: "小红" }, NOW - 300000);
  await record("r-000006", "rt-log", "u1", "group",
    { title: "晨重", occurred_at: NOW - 360000, amount: 68.5 }, NOW - 360000);
  return e;
}

test("D8 接口未登录一律 401", async () => {
  const e = env();
  for (const path of [
    "/api/records/types",
    "/api/records?type=rt-ledger",
    "/api/records/export?type=rt-ledger",
    "/api/skills",
    "/api/schedules",
  ]) {
    const r = await req(e, path, undefined, "");
    assert.equal(r.status, 401, path);
    assert.equal((await r.json()).error, "请登录");
  }
});

test("D8 类型列表带本人可见条数与建本人名", async () => {
  const e = await seed(env());
  const r = await req(e, "/api/records/types");
  assert.equal(r.status, 200);
  const { types } = await r.json();
  assert.equal(types.length, 4);
  const byId = Object.fromEntries(types.map((t) => [t.id, t]));
  assert.equal(byId["rt-ledger"].name, "报销额度");
  assert.equal(byId["rt-ledger"].kind, "ledger");
  assert.equal(byId["rt-ledger"].status, "active");
  assert.equal(byId["rt-ledger"].visibility_default, "group");
  assert.equal(byId["rt-ledger"].owner_name, "小明");
  assert.equal(byId["rt-ledger"].count, 2, "私有行不计入本人可见条数");
  assert.equal(byId["rt-list"].count, 2);
  assert.equal(byId["rt-log"].count, 1);
  assert.equal(byId["rt-arch"].status, "archived");
  assert.equal(typeof byId["rt-ledger"].created_at, "number");
  assert.equal(typeof byId["rt-ledger"].updated_at, "number");
});

test("D8 账本行形状、筛选、汇总与私有计数", async () => {
  const e = await seed(env());
  let r = await req(e, "/api/records?type=rt-ledger");
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.type.id, "rt-ledger");
  assert.equal(body.schema.fields.length, 8);
  assert.equal(body.rows.length, 2);
  assert.equal(body.hiddenPrivate, 1, "另一人的私有行只计数");
  assert.equal(body.mine_private, 0, "工作台账号不对应 QQ 号，私有明细一律不下发");
  const row = body.rows.find((x) => x.id === "r-000001");
  assert.equal(row.short, "#000001");
  assert.equal(row.person, "小明");
  assert.equal(row.title, "打车");
  assert.equal(row.amount, "¥360.00");
  assert.equal(row.amount_cents, 36000);
  assert.equal(row.creator_name, "小明");
  assert.equal(row.visibility, "group");
  assert.equal(row.extra["类别"], "交通");
  assert.equal(row.extra["备注"], "从公司回家");
  assert.ok("标签" in row.extra);
  assert.equal(typeof row.created_at, "number");
  assert.equal(body.summary.count, 2);
  assert.equal(body.summary.total_cents, 35000);
  assert.equal(body.summary.groups.length, 2);
  assert.equal(body.status_counts, undefined);

  r = await req(e, "/api/records?type=rt-ledger&person=" + encodeURIComponent("小红"));
  body = await r.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].id, "r-000002");
  assert.ok(body.rows[0].amount_cents < 0);

  r = await req(e, "/api/records?type=rt-ledger&text=" + encodeURIComponent("打车"));
  body = await r.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].id, "r-000001");

  r = await req(e, "/api/records?type=rt-list&status=todo");
  body = await r.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].title, "牛奶");
  assert.deepEqual(body.status_counts, { todo: 1, done: 1 });

  r = await req(e, "/api/records?type=rt-ledger&cursor=1");
  body = await r.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.next, undefined);
});

test("D8 私有记录不出现在 CSV，BOM 与 500 行上限正确", async () => {
  const e = await seed(env());
  let r = await req(e, "/api/records/export?type=rt-ledger");
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.match(body.filename, /报销额度-.*\.csv$/);
  assert.ok(body.csv.startsWith("\uFEFF"));
  assert.equal(body.rows, 2);
  assert.equal(body.truncated, false);
  assert.match(body.csv, /打车/);
  assert.doesNotMatch(body.csv, /私房钱/);
  assert.match(body.csv, /可见性/, "CSV 表头保留可见性列");

  for (let i = 0; i < 505; i++) {
    await run(e,
      "INSERT INTO records(id,type_id,group_id,creator,visibility,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
      "r-bulk-" + String(i).padStart(4, "0"), "rt-ledger", G, "u1", "group",
      JSON.stringify({ person: "小明", amount_cents: 100 + i, title: "批量" + i, occurred_at: NOW - 400000 - i }), NOW - 400000 - i, NOW - 400000 - i);
  }
  r = await req(e, "/api/records/export?type=rt-ledger");
  body = await r.json();
  assert.equal(body.rows, 500);
  assert.equal(body.truncated, true);
  assert.ok(body.csv.startsWith("\uFEFF"));
});

test("D8 技能列表形状与排序", async () => {
  const e = await seed(env());
  const steps = JSON.stringify([{ action: "records_summary", type: "报销额度", group_by: "person", period: "this_month" }]);
  await run(e,
    "INSERT INTO skills(id,group_id,name,triggers,steps,note,owner,status,uses,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    "sk-1", G, "日结", JSON.stringify(["日报", "结算"]), steps, "第一行\n第二行", "u1", "active", 3, NOW - 1000, NOW - 9000, NOW - 1000);
  await run(e,
    "INSERT INTO skills(id,group_id,name,triggers,steps,note,owner,status,uses,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    "sk-2", G, "旧例", "[]", steps, "", "u2", "disabled", 0, null, NOW - 8000, NOW - 2000);
  await run(e,
    "INSERT INTO skills(id,group_id,name,triggers,steps,note,owner,status,uses,last_used_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    "sk-3", G, "待确认", "[]", steps, "", "u1", "proposed", 5, null, NOW - 7000, NOW - 3000);
  const r = await req(e, "/api/skills");
  assert.equal(r.status, 200);
  const { skills } = await r.json();
  assert.equal(skills.length, 3);
  assert.deepEqual(skills.map((s) => s.status), ["active", "proposed", "disabled"]);
  assert.equal(skills[0].name, "日结");
  assert.deepEqual(skills[0].triggers, ["日报", "结算"]);
  assert.equal(skills[0].steps[0].action, "records_summary");
  assert.equal(skills[0].note, "第一行\n第二行");
  assert.equal(skills[0].owner_name, "小明");
  assert.equal(skills[0].uses, 3);
  assert.equal(skills[0].last_used_at, NOW - 1000);
  assert.equal(skills[2].last_used_at, null);
});

test("D8 日程列表带 spec、双时区字段、最近一次与暂停原因", async () => {
  const e = await seed(env());
  const schedule = (id, kind, tz, spec, status, next, fail, error, created) =>
    run(e,
      "INSERT INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,last_run_at,fail_count,last_error,source_msg_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      id, G, "u1", kind, tz, JSON.stringify(spec), status, next, null, fail, error, null, created);
  await schedule("s-1", "agent_task", "Asia/Shanghai",
    { cadence: "daily", time: "00:00", title: "每日余额", steps: [{ action: "quota" }] }, "active", NOW + 3600000, 0, null, NOW - 3000);
  await schedule("s-2", "agent_task", "Australia/Sydney",
    { cadence: "monthly", time: "09:00", month_days: [1], title: "月度账本" }, "paused", null, 9, "连续失败", NOW - 2000);
  await schedule("s-3", "reminder", "Australia/Sydney",
    { cadence: "once", run_at: NOW - 9999, text: "交报告" }, "done", null, 0, null, NOW - 1000);
  await run(e,
    "INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,outbox_id,error) VALUES(?,?,?,?,?,?,?,?)",
    "run-1", "s-1", NOW - 86400000, NOW - 86400000, NOW - 86400000 + 1000, "ok", "o1", null);
  await run(e,
    "INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,outbox_id,error) VALUES(?,?,?,?,?,?,?,?)",
    "run-2", "s-1", NOW - 3600000, NOW - 3600000, NOW - 3600000 + 1000, "late", "o2", null);
  await run(e,
    "INSERT INTO schedule_runs(id,schedule_id,due_at,started_at,finished_at,status,outbox_id,error) VALUES(?,?,?,?,?,?,?,?)",
    "run-3", "s-2", NOW - 7200000, NOW - 7200000, NOW - 7200000 + 1000, "failed", null, "发送失败");
  const r = await req(e, "/api/schedules");
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.limit, 10);
  assert.equal(body.schedules.length, 3);
  const byId = Object.fromEntries(body.schedules.map((s) => [s.id, s]));
  assert.equal(byId["s-1"].tz, "Asia/Shanghai");
  assert.equal(byId["s-1"].spec.cadence, "daily");
  assert.equal(byId["s-1"].spec.steps[0].action, "quota");
  assert.equal(byId["s-1"].owner_name, "小明");
  assert.equal(byId["s-1"].fail_count, 0);
  assert.equal(byId["s-1"].last_run.status, "sent");
  assert.equal(byId["s-1"].last_run.at, NOW - 3600000 + 1000);
  assert.equal(byId["s-2"].status, "paused");
  assert.equal(byId["s-2"].last_error, "连续失败");
  assert.equal(byId["s-2"].last_run.status, "failed");
  assert.equal(byId["s-2"].last_run.error, "发送失败");
  assert.equal(byId["s-3"].status, "done");
  assert.equal(byId["s-3"].last_run, null);
  assert.equal(typeof byId["s-3"].created_at, "number");
});

test("D8 缺表时返回空列表而不是 500", async () => {
  const e = await seed(env());
  await run(e, "DROP TABLE record_types");
  await run(e, "DROP TABLE skills");
  await run(e, "DROP TABLE schedules");
  let r = await req(e, "/api/records/types");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { types: [] });
  r = await req(e, "/api/skills");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { skills: [] });
  r = await req(e, "/api/schedules");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { schedules: [], limit: 10 });
});
