import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { worker, env, req } from "./support.mjs";

// FR-1's 0070 migration and real core are not merged yet: this package keeps a local
// copy for the tests (removed from the commit). The test file itself only depends on
// the frozen paths, so it will run unchanged once FR-1 lands.
let migration;
try {
  migration = readFileSync(new URL("../migrations/0070_feature_requests.sql", import.meta.url), "utf8");
} catch {
  throw new Error("feature-request-api.test.mjs requires FR-1's migrations/0070_feature_requests.sql (merge FR-1 into this branch first)");
}
const apiPath = `.wrangler/test-feature-request-api-${process.pid}.mjs`;
await build({ entryPoints: ["src/feature-request-api.ts"], bundle: true, format: "esm", platform: "browser", outfile: apiPath });
const { sweepFeatureRequests } = await import("../" + apiPath);

const GROUP = "GROUP-FR";
const DAY = "2026-11-14";
const OWNER = "owner-secret";
const call = (e, path, body, key = OWNER) => req(e, path, body, key, body === undefined ? "GET" : "POST");

async function newEnv() {
  const e = env();
  for (const sql of migration.replace(/^--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean))
    await e.DB.prepare(sql).run();
  return e;
}

let seq = 0;
async function insertFr(e, patch = {}) {
  const n = ++seq;
  const now = patch.created_at ?? Date.now();
  const row = {
    id: patch.id ?? `fr-t${n}`,
    group_id: patch.group_id ?? GROUP,
    msg_id: patch.msg_id ?? `m-t${n}`,
    sender: patch.sender ?? "SENDER-RAW-OPENID",
    sender_name: patch.sender_name ?? "杨鸿明",
    quote: patch.quote ?? "你应该加个查天气的功能",
    title: patch.title ?? "加查天气",
    detail: patch.detail ?? "希望支持天气查询",
    mode: patch.mode ?? "build",
    risk_tags: JSON.stringify(patch.risk_tags ?? []),
    auto: patch.auto ?? 1,
    status: patch.status ?? "queued",
    status_reason: patch.status_reason ?? "",
    version: patch.version ?? 0,
    day: patch.day ?? DAY,
    attempts: patch.attempts ?? 0,
    claimed_by: patch.claimed_by ?? null,
    lease_until: patch.lease_until ?? null,
    release: patch.release ?? null,
    rollback_point: patch.rollback_point ?? null,
    smoke_verified: patch.smoke_verified ?? 0,
    proposal_note: patch.proposal_note ?? null,
    reply_kind: patch.reply_kind ?? null,
    reply_text: patch.reply_text ?? null,
    reply_outbox_id: patch.reply_outbox_id ?? null,
    reply_enqueued_at: patch.reply_enqueued_at ?? null,
    approved_by: patch.approved_by ?? null,
    created_at: now,
    updated_at: patch.updated_at ?? now,
  };
  await e.DB.prepare(`INSERT INTO feature_request(${Object.keys(row).join(",")}) VALUES(${Object.keys(row).map(() => "?").join(",")})`)
    .bind(...Object.values(row)).run();
  return row;
}

const getFr = (e, id) => e.DB.prepare("SELECT * FROM feature_request WHERE id=?").bind(id).first();
const outbox = async (e) => (await e.DB.prepare("SELECT * FROM outbox ORDER BY created_at,id").all()).results;
async function claimed(e, patch = {}) {
  return insertFr(e, { status: "developing", claimed_by: "bini", lease_until: Date.now() + 6 * 3600000, version: 1, attempts: 1, ...patch });
}
async function memberKeys(e, names) {
  assert.equal((await req(e, "/api/admin/name-members", { members: names.map((name) => ({ name, password: name })) })).status, 200);
  const out = {};
  for (const name of names) {
    const r = await req(e, "/api/team/login-name", { password: " " + name.toUpperCase() + " " }, "");
    assert.equal(r.status, 200);
    out[name] = (await r.json()).token;
  }
  return out;
}

test("S7 领单并发：max_developing=2，三个同时 claim 只有两个 200，developing 永不超过 2", async () => {
  const e = await newEnv();
  const base = Date.now();
  for (let i = 0; i < 3; i++) await insertFr(e, { id: `fr-c${i}`, msg_id: `m-c${i}`, created_at: base + i });
  const res = await Promise.all([1, 2, 3].map((n) => call(e, "/api/team/feature-requests/claim", { worker: "w" + n })));
  assert.deepEqual(res.map((r) => r.status).sort(), [200, 200, 409]);
  const dev = (await e.DB.prepare("SELECT * FROM feature_request WHERE status='developing'").all()).results;
  assert.equal(dev.length, 2);
  for (const row of dev) {
    assert.equal(row.attempts, 1);
    assert.ok(row.lease_until > base);
    assert.match(row.claimed_by, /^w[123]$/);
  }
});

test("S7 同一张单被两个 worker 争抢：只有一个 CAS 成功，另一个 409 且 attempts 只加一次", async () => {
  const e = await newEnv();
  await insertFr(e, { id: "fr-race", msg_id: "m-race" });
  const res = await Promise.all([1, 2].map((n) => call(e, "/api/team/feature-requests/claim", { id: "fr-race", worker: "w" + n })));
  assert.equal(res.filter((r) => r.status === 200).length, 1);
  assert.equal(res.filter((r) => r.status === 409).length, 1);
  const row = await getFr(e, "fr-race");
  assert.equal(row.status, "developing");
  assert.equal(row.attempts, 1);
  assert.equal(row.version, 1);
});

test("S7 不带 id 领最老的 queued+build+auto；没有可领时 204；needs_human 永远领不到", async () => {
  const e = await newEnv();
  const old = Date.now() - 5000;
  await insertFr(e, { id: "fr-noauto", msg_id: "m-noauto", auto: 0, created_at: old });
  await insertFr(e, { id: "fr-human", msg_id: "m-human", status: "needs_human", created_at: old + 1 });
  await insertFr(e, { id: "fr-pick", msg_id: "m-pick", created_at: old + 2 });
  await insertFr(e, { id: "fr-later", msg_id: "m-later", created_at: old + 3 });
  const first = await call(e, "/api/team/feature-requests/claim", { worker: "bini" });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).item.id, "fr-pick");
  const second = await call(e, "/api/team/feature-requests/claim", { worker: "bini" });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).item.id, "fr-later");
  const third = await call(e, "/api/team/feature-requests/claim", { worker: "bini" });
  assert.equal(third.status, 409, "先查 max_developing，达到上限就 409");
  assert.equal((await third.json()).error, "max_developing");

  const empty = await newEnv();
  assert.equal((await call(empty, "/api/team/feature-requests/claim", { worker: "bini" })).status, 204);
  await insertFr(empty, { id: "fr-only-human", msg_id: "m-only-human", status: "needs_human" });
  assert.equal((await call(empty, "/api/team/feature-requests/claim", { id: "fr-only-human", worker: "bini" })).status, 409);
  assert.equal((await call(empty, "/api/team/feature-requests/claim", { worker: "bini" })).status, 204);
});

test("S8 shipped 正路径：CAS+入队一次、引用原消息、重复 report 不新增、sendOutbox 带 message_reference", async () => {
  const e = await newEnv();
  e.RELEASE = "abcdef1234567";
  e.QQ_APP_ID = "fr-s8-app-" + Date.now();
  e.QQ_APP_SECRET = "local-secret";
  await insertFr(e, { id: "fr-s8", msg_id: "m-s8", quote: "你应该加个能先回一句的功能" });
  await e.DB.prepare("INSERT INTO message_refs VALUES(?,?,?,?,?)").bind("REF-S8", "member", "m-s8", GROUP, Date.now()).run();
  assert.equal((await call(e, "/api/team/feature-requests/claim", { id: "fr-s8", worker: "bini" })).status, 200);
  const hb = await call(e, "/api/team/feature-requests/fr-s8/heartbeat", { worker: "bini" });
  assert.equal(hb.status, 200);
  const hbItem = (await hb.json()).item;
  assert.ok(hbItem.lease_until > Date.now());
  const beforeVersion = (await getFr(e, "fr-s8")).version;
  assert.equal(beforeVersion, 2);

  const text = "现在我可以在耗时任务开始时先回你一句「在处理了」";
  const report = await call(e, "/api/team/feature-requests/fr-s8/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true, reply_text: text,
  });
  assert.equal(report.status, 200);
  const row = await getFr(e, "fr-s8");
  assert.equal(row.status, "shipped");
  assert.equal(row.release, "abcdef1");
  assert.equal(row.rollback_point, "1234567");
  assert.equal(row.smoke_verified, 1);
  assert.equal(row.reply_kind, "shipped");
  assert.equal(row.reply_text, text);
  assert.equal(row.reply_outbox_id, "frr-fr-s8");
  assert.ok(row.reply_enqueued_at > 0);
  let out = await outbox(e);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "frr-fr-s8");
  assert.equal(out[0].group_id, GROUP);
  assert.equal(out[0].msg_id, "m-s8");
  assert.equal(out[0].status, "pending");
  assert.equal(out[0].body, text);
  const meta = await e.DB.prepare("SELECT json FROM outbox_meta WHERE id='frr-fr-s8'").first();
  assert.deepEqual(JSON.parse(meta.json), { reference: "REF-S8" });

  const again = await call(e, "/api/team/feature-requests/fr-s8/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true, reply_text: text,
  });
  assert.equal(again.status, 200);
  assert.equal((await outbox(e)).length, 1, "重复 report 不得再入队");

  const one = await call(e, "/api/team/feature-requests/fr-s8");
  assert.equal(one.status, 200);
  const item = (await one.json()).item;
  assert.equal(item.untrusted, true);
  assert.deepEqual(item.reply, { kind: "shipped", text, outbox_status: "pending" });
  assert.ok(!("group_id" in item) && !("sender" in item) && !("msg_id" in item));

  const old = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("getAppAccessToken")) return Response.json({ access_token: "local-qq-token", expires_in: 300 });
    if (u.startsWith("https://api.bot.qq.com/v2/groups/")) {
      sent.push(JSON.parse(init.body));
      return Response.json({ id: "local-sent-" + sent.length });
    }
    throw new Error("unexpected network call: " + u);
  };
  try {
    await worker.queue({ messages: [{ body: { id: "no-such-job" }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = old;
  }
  assert.equal(sent.length, 1, "只应发送这一条");
  assert.deepEqual(sent[0].message_reference, { message_id: "REF-S8" });
  assert.match(sent[0].content, /在处理了/);
  assert.equal((await outbox(e))[0].status, "sent");
});

test("S9 shipped 守门：release 不符 409；冒烟/回滚点/坏文案 422，状态与 outbox 不变", async () => {
  const e = await newEnv();
  e.RELEASE = "abcdef1234567";
  await insertFr(e, { id: "fr-gate", msg_id: "m-gate", status: "developing", claimed_by: "bini", lease_until: Date.now() + 3600000, version: 1, attempts: 1 });
  const shipped = (patch = {}) => call(e, "/api/team/feature-requests/fr-gate/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true,
    reply_text: "现在我可以在耗时任务开始时先回你一句", ...patch,
  });

  const mismatch = await shipped({ release: "deadbee" });
  assert.equal(mismatch.status, 409);
  assert.equal((await mismatch.json()).error, "release_mismatch");
  const badFormat = await shipped({ release: "ABC12345" });
  assert.equal(badFormat.status, 409);

  for (const patch of [
    { smoke_verified: false },
    { rollback_point: "" },
    { reply_text: "" },
    { reply_text: "好".repeat(121) },
    { reply_text: "看这个 https://example.com/a" },
    { reply_text: "```code```" },
    { reply_text: "版本是 a1b2c3d" },
    { reply_text: "改的是 src/worker.ts" },
    { reply_text: "这次在 Worker 里修好了" },
    { reply_text: "谢谢 @全体成员" },
    { reply_text: "第一行\n第二行\n第三行" },
  ]) {
    const r = await shipped(patch);
    assert.equal(r.status, 422, JSON.stringify(patch));
    const body = await r.json();
    assert.equal(body.error, "reply_invalid");
    assert.equal(typeof body.why, "string");
    assert.ok(body.why.length > 0);
  }
  const row = await getFr(e, "fr-gate");
  assert.equal(row.status, "developing");
  assert.equal(row.reply_outbox_id, null);
  assert.equal((await outbox(e)).length, 0);
});

test("S10 failed 闭环：固定模板 + 引用，重复 report 不重复", async () => {
  const e = await newEnv();
  await claim_failed_fixture(e);
  async function claim_failed_fixture(env) {
    await insertFr(env, { id: "fr-fail", msg_id: "m-fail" });
    await env.DB.prepare("INSERT INTO message_refs VALUES(?,?,?,?,?)").bind("REF-FAIL", "member", "m-fail", GROUP, Date.now()).run();
    assert.equal((await call(env, "/api/team/feature-requests/claim", { id: "fr-fail", worker: "bini" })).status, 200);
  }
  const body = { outcome: "failed", reason: "现在接口限额不够，没法接上语音" };
  const bad = await call(e, "/api/team/feature-requests/fr-fail/report", { outcome: "failed", reason: "看 https://example.com/x" });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json()).error, "reply_invalid");
  assert.equal((await getFr(e, "fr-fail")).status, "developing");
  assert.equal((await outbox(e)).length, 0);
  const r = await call(e, "/api/team/feature-requests/fr-fail/report", body);
  assert.equal(r.status, 200);
  const row = await getFr(e, "fr-fail");
  assert.equal(row.status, "failed");
  assert.equal(row.reply_kind, "failed");
  assert.equal(row.status_reason, "现在接口限额不够，没法接上语音");
  let out = await outbox(e);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "frr-fr-fail");
  assert.equal(out[0].body, "这个我这次没做成：现在接口限额不够，没法接上语音，已转人工。");
  assert.equal((await call(e, "/api/team/feature-requests/fr-fail/report", body)).status, 200);
  assert.equal((await outbox(e)).length, 1);
});

test("S11 超时不沉默：73h 未领转 failed+stale；租约过期 attempts<3 回 queued；attempts≥3 转 failed；各只回一次", async () => {
  const e = await newEnv();
  const now = Date.now();
  await insertFr(e, { id: "fr-stale", msg_id: "m-stale", created_at: now - 73 * 3600000 });
  await insertFr(e, { id: "fr-lease1", msg_id: "m-lease1", status: "developing", claimed_by: "w", lease_until: now - 1000, attempts: 1, created_at: now - 3600000 });
  await insertFr(e, { id: "fr-lease3", msg_id: "m-lease3", status: "developing", claimed_by: "w", lease_until: now - 1000, attempts: 3, created_at: now - 3600000 });
  await insertFr(e, { id: "fr-waiting", msg_id: "m-waiting", status: "needs_human", created_at: now - 100 * 3600000 });
  const first = await sweepFeatureRequests(e, now);
  assert.deepEqual(first, { requeued: 1, failed: 2 });
  const requeued = await getFr(e, "fr-lease1");
  assert.equal(requeued.status, "queued");
  assert.equal(requeued.claimed_by, null);
  assert.equal(requeued.lease_until, null);
  assert.equal((await getFr(e, "fr-stale")).status, "failed");
  assert.equal((await getFr(e, "fr-stale")).reply_kind, "stale");
  assert.equal((await getFr(e, "fr-lease3")).reply_kind, "stale");
  assert.equal((await getFr(e, "fr-waiting")).status, "needs_human");
  let out = await outbox(e);
  assert.equal(out.length, 2);
  for (const row of out) assert.match(row.body, /这个我这次没做成：排太久没落地，已转人工。$/);
  const second = await sweepFeatureRequests(e, now);
  assert.deepEqual(second, { requeued: 0, failed: 0 });
  assert.equal((await outbox(e)).length, 2);
});

test("S12 没有 ref_idx：回复带原话前缀与省略号，不写 outbox_meta，仍只入队一次", async () => {
  const e = await newEnv();
  e.RELEASE = "abcdef1234567";
  const quote = "你应该加个每天报天气的功能";
  await claimed(e, { id: "fr-noref", msg_id: "m-noref", quote });
  const text = "我加好了每日天气";
  const r = await call(e, "/api/team/feature-requests/fr-noref/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true, reply_text: text,
  });
  assert.equal(r.status, 200);
  const out = await outbox(e);
  assert.equal(out.length, 1);
  assert.equal(out[0].body, "回复「" + Array.from(quote).slice(0, 12).join("") + "…」：" + text);
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox_meta").first()).n, 0);
  await call(e, "/api/team/feature-requests/fr-noref/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true, reply_text: text,
  });
  assert.equal((await outbox(e)).length, 1);
});

test("S13 鉴权：401/403/200；decision 仅 owner；返回体不含 group_id/sender/msg_id", async () => {
  const e = await newEnv();
  await insertFr(e, { id: "fr-auth", msg_id: "m-auth" });
  const path = "/api/team/feature-requests";
  assert.equal((await req(e, path, undefined, "", "GET")).status, 401);
  assert.equal((await req(e, path, undefined, "random-token", "GET")).status, 401);
  const keys = await memberKeys(e, ["hongming", "jinxiang", "jinyi"]);
  assert.equal((await req(e, path, undefined, keys.hongming, "GET")).status, 403, "普通成员 403");
  await e.DB.prepare("UPDATE members SET role='admin' WHERE name='jinxiang'").run();
  assert.equal((await req(e, path, undefined, keys.jinxiang, "GET")).status, 200, "admin 可读");
  const decision = await call(e, "/api/team/feature-requests/fr-auth/decision", { decision: "approve" }, keys.jinxiang);
  assert.equal(decision.status, 403, "admin 不能 decision");
  const ai = await (await req(e, "/api/team/ai-tokens", { label: "FR 验收" }, OWNER)).json();
  assert.ok(ai.token.startsWith("teamai_"));
  assert.equal((await req(e, path, undefined, ai.token, "GET")).status, 403, "AI 成员令牌 403");
  const owner = await req(e, path, undefined, OWNER, "GET");
  assert.equal(owner.status, 200);
  const body = await owner.json();
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].untrusted, true);
  assert.ok(!("group_id" in body.items[0]) && !("sender" in body.items[0]) && !("msg_id" in body.items[0]));
  assert.ok(!JSON.stringify(body).includes(GROUP));
  assert.ok(!JSON.stringify(body).includes("SENDER-RAW-OPENID"));
  assert.deepEqual(Object.keys(body.caps).sort(), ["auto_today", "daily_auto_cap", "developing", "max_developing"]);
});

test("S14 状态机非法转移与乐观锁：终态不可领、needs_human 不可领、并发 report 只入队一次", async () => {
  const e = await newEnv();
  e.RELEASE = "abcdef1234567";
  await insertFr(e, { id: "fr-done", msg_id: "m-done", status: "shipped", version: 3, reply_outbox_id: null });
  assert.equal((await call(e, "/api/team/feature-requests/claim", { id: "fr-done", worker: "w" })).status, 409);
  const dead = await call(e, "/api/team/feature-requests/fr-done/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true, reply_text: "做完了",
  });
  assert.equal(dead.status, 409);
  await insertFr(e, { id: "fr-needs", msg_id: "m-needs", status: "needs_human" });
  assert.equal((await call(e, "/api/team/feature-requests/claim", { id: "fr-needs", worker: "w" })).status, 409);
  const rel = await call(e, "/api/team/feature-requests/fr-needs/report", { outcome: "release" });
  assert.equal(rel.status, 409, "needs_human 不能 release");
  const prop = await call(e, "/api/team/feature-requests/fr-needs/report", { outcome: "proposal", note: "提案" });
  assert.equal(prop.status, 409, "build 单不能写 proposal");

  await claimed(e, { id: "fr-twice", msg_id: "m-twice", quote: "你应该加个能先回一句的功能" });
  const payload = {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true,
    reply_text: "现在我可以在耗时任务开始时先回你一句",
  };
  const both = await Promise.all([
    call(e, "/api/team/feature-requests/fr-twice/report", payload),
    call(e, "/api/team/feature-requests/fr-twice/report", payload),
  ]);
  assert.ok(both.some((r) => r.status === 200));
  assert.ok(both.every((r) => r.status === 200 || r.status === 409));
  assert.equal((await outbox(e)).length, 1);
  const row = await getFr(e, "fr-twice");
  assert.equal(row.status, "shipped");
  assert.equal(row.version, 2, "只允许一次 CAS 成功");
});

test("S13b 16KB 请求体上限", async () => {
  const e = await newEnv();
  const r = await call(e, "/api/team/feature-requests/fr-x/report", { outcome: "failed", reason: "x".repeat(17000) });
  assert.equal(r.status, 413);
});

test("S11b 单次 sweep 最多处理 20 条，剩下的下一轮继续", async () => {
  const e = await newEnv();
  const now = Date.now();
  for (let i = 0; i < 21; i++)
    await insertFr(e, { id: `fr-cap${i}`, msg_id: `m-cap${i}`, created_at: now - 73 * 3600000 + i });
  const first = await sweepFeatureRequests(e, now);
  assert.deepEqual(first, { requeued: 0, failed: 20 });
  assert.equal(Number((await e.DB.prepare("SELECT COUNT(*) n FROM feature_request WHERE status='queued'").first()).n), 1);
  assert.deepEqual(await sweepFeatureRequests(e, now), { requeued: 0, failed: 1 });
});

test("S14b CAS 没生效时 outbox 绝不入队", async () => {
  const e = await newEnv();
  e.RELEASE = "abcdef1234567";
  await claimed(e, { id: "fr-cas", msg_id: "m-cas" });
  const batch = e.DB.batch.bind(e.DB);
  let raced = false;
  e.DB.batch = async (statements) => {
    if (!raced) {
      raced = true;
      await e.DB.prepare(
        "UPDATE feature_request SET status='failed',version=version+1,reply_outbox_id='frr-other',updated_at=? WHERE id='fr-cas'",
      ).bind(Date.now()).run();
    }
    return batch(statements);
  };
  const r = await call(e, "/api/team/feature-requests/fr-cas/report", {
    outcome: "shipped", release: "abcdef1", rollback_point: "1234567", smoke_verified: true,
    reply_text: "现在我可以在耗时任务开始时先回你一句",
  });
  assert.equal(r.status, 409);
  const row = await getFr(e, "fr-cas");
  assert.equal(row.status, "failed");
  assert.equal(row.reply_outbox_id, "frr-other");
  assert.equal((await outbox(e)).length, 0, "状态 UPDATE 没生效就不得插入回复");
});

test("heartbeat 只给本人续租，不传 worker 时只要求 developing", async () => {
  const e = await newEnv();
  await claimed(e, { id: "fr-hb", msg_id: "m-hb", claimed_by: "bini" });
  const before = await getFr(e, "fr-hb");
  const other = await call(e, "/api/team/feature-requests/fr-hb/heartbeat", { worker: "other" });
  assert.equal(other.status, 409);
  assert.equal((await getFr(e, "fr-hb")).version, before.version);
  assert.equal((await call(e, "/api/team/feature-requests/fr-hb/heartbeat", {})).status, 200);
  assert.equal((await call(e, "/api/team/feature-requests/fr-hb/heartbeat", { worker: "bini" })).status, 200);
  assert.equal((await getFr(e, "fr-hb")).version, before.version + 2);
});

test("scheduled tick 真的调用 sweepFeatureRequests：stale 单转 failed 并入队一次", async () => {
  const e = await newEnv();
  await insertFr(e, { id: "fr-cron", msg_id: "m-cron", created_at: Date.now() - 73 * 3600000 });
  let pending;
  await worker.scheduled({}, e, { waitUntil(p) { pending = p; } });
  await pending;
  assert.equal((await getFr(e, "fr-cron")).status, "failed");
  assert.equal((await getFr(e, "fr-cron")).reply_kind, "stale");
  assert.equal((await outbox(e)).length, 1);
  let second;
  await worker.scheduled({}, e, { waitUntil(p) { second = p; } });
  await second;
  assert.equal((await outbox(e)).length, 1);
});

test("S3 proposal 单可写提案；owner approve 后 build 单才可领，reject 终态", async () => {
  const e = await newEnv();
  await insertFr(e, { id: "fr-prop", msg_id: "m-prop", mode: "proposal", status: "needs_human", auto: 0, risk_tags: ["permission"], created_at: Date.now() - 2 });
  const note = await call(e, "/api/team/feature-requests/fr-prop/report", { outcome: "proposal", note: "只出提案：需要管理员先定权限边界" });
  assert.equal(note.status, 200);
  assert.equal((await getFr(e, "fr-prop")).proposal_note, "只出提案：需要管理员先定权限边界");
  const approve = await call(e, "/api/team/feature-requests/fr-prop/decision", { decision: "approve" });
  assert.equal(approve.status, 409);
  assert.equal((await approve.json()).error, "proposal_only");

  await insertFr(e, { id: "fr-human", msg_id: "m-human2", status: "needs_human", auto: 0, created_at: Date.now() - 1 });
  const ok = await call(e, "/api/team/feature-requests/fr-human/decision", { decision: "approve" });
  assert.equal(ok.status, 200);
  const approved = await getFr(e, "fr-human");
  assert.equal(approved.status, "queued");
  assert.equal(approved.auto, 1, "owner 手动批准后可以领");
  assert.equal(approved.approved_by, "hongming");
  const claimedRow = await call(e, "/api/team/feature-requests/claim", { id: "fr-human", worker: "bini" });
  assert.equal(claimedRow.status, 200);

  await insertFr(e, { id: "fr-reject", msg_id: "m-reject", status: "needs_human" });
  assert.equal((await call(e, "/api/team/feature-requests/fr-reject/decision", { decision: "reject" })).status, 200);
  assert.equal((await getFr(e, "fr-reject")).status, "rejected");
  assert.equal((await getFr(e, "fr-reject")).approved_by, "hongming");
});
