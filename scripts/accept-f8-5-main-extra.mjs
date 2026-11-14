// F8-5 main-only checks: duplicate turn, group cap, global budget, failure paths,
// audit rows and off:image_gen visibility.
// Local SQLite + injected fake image output. Real OpenAI is only used by a-live.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
import {DatabaseSync} from "node:sqlite";
import {build} from "esbuild";

const root = new URL("../", import.meta.url);
const tmp = "/tmp/f8-main-extra";
const schema = readFileSync(new URL("schema.sql", root), "utf8");

function openDb() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  const statement = (sql, args = []) => {
    const execute = () => {
      const s = raw.prepare(sql);
      if (/^\s*(SELECT|WITH)\b|\bRETURNING\b/i.test(sql)) return { results: s.all(...args), meta: { changes: 0 } };
      const r = s.run(...args);
      return { results: [], meta: { changes: Number(r.changes) } };
    };
    return {
      sql,
      bind: (...values) => statement(sql, values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))),
      execute,
      async first() { return execute().results[0] ?? null; },
      async all() { return execute(); },
      async run() { return execute(); },
    };
  };
  const DB = {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => s.execute());
        raw.exec("COMMIT");
        return out;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {raw, DB};
}

async function load(entry) {
  const out = await build({entryPoints: [new URL(entry, root).pathname], bundle: true, format: "esm", platform: "browser", write: false, logLevel: "silent"});
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const imagegen = await load("src/imagegen.ts");
const toolMod = await load("src/tools/generate-image.ts");
const toolkit = await load("src/toolkit.ts");
const quota = await load("src/quota.ts");
const card = await load("src/capability-card.ts");
const openai = await load("src/openai.ts");

const JPEG = Uint8Array.from([255, 216, 255, 224, 0, 4, 0, 0, 255, 192, 0, 17, 8, 4, 0, 4, 0, 3, 1, 17, 0, 2, 17, 0, 3, 17, 0, 255, 217]);
const ctx = (id, group = "GROUP-D", sender = "u1", tainted = false) => ({
  context: {latest: {id, group_id: group, sender}},
  source: {id, group_id: group, sender, body: "帮我生成一张图"},
  isTainted: () => tainted,
});
const out = {b: {}, c: {}, d: {}, e: {}, qq_real_sends: 0, production_d1_writes: 0, network_openai_calls: 0};

const okImage = () => ({ok: true, jpeg: JPEG, bytes: JPEG.length, width: 1024, height: 1024, model: "fake-image", est_cost_micro_usd: 1000, latency_ms: 1});

// ---- b) duplicate turn: one generation, one outbox, one audit row ----
{
  const {raw, DB} = openDb();
  const e = {DB};
  const calls = {images: 0};
  const tool = toolMod.makeGenerateImageTool({
    async generateImage() { calls.images++; return okImage(); },
    enqueueGeneratedImage: (ee, o) => imagegen.enqueueGeneratedImage(ee, o),
  });
  const first = await tool.run(e, {prompt: "一只戴草帽的橘猫"}, ctx("dup-1"));
  const second = await tool.run(e, {prompt: "一只戴草帽的橘猫"}, ctx("dup-1"));
  const one = (sql) => raw.prepare(sql).get();
  out.b.duplicate = {
    first: first.ok, first_status: first.status,
    second: second.ok, second_status: second.status,
    generate_calls: calls.images,
    generated_images: one("SELECT COUNT(*) n FROM generated_images").n,
    outbox: one("SELECT COUNT(*) n FROM outbox").n,
    outbox_body: one("SELECT body FROM outbox").body,
    outbox_meta: one("SELECT COUNT(*) n FROM outbox_meta").n,
    outbox_meta_json: one("SELECT json FROM outbox_meta").json,
    image_gen_log: one("SELECT COUNT(*) n FROM image_gen_log").n,
    log_row: one("SELECT status,error_kind,bytes,est_cost_micro_usd,outbox_id,model FROM image_gen_log"),
    user_reservations: one("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_user'").n,
    group_reservations: one("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_group'").n,
    tool_calls_rows: one("SELECT COUNT(*) n FROM tool_calls").n,
  };
  assert.equal(first.ok, true);
  assert.equal(second.status, "queued");
  assert.equal(calls.images, 1);
  assert.equal(out.b.duplicate.generated_images, 1);
  assert.equal(out.b.duplicate.outbox, 1);
  assert.equal(out.b.duplicate.outbox_body, "[图片]");
  assert.equal(out.b.duplicate.image_gen_log, 1);
  assert.equal(out.b.duplicate.user_reservations, 1);
  assert.equal(out.b.duplicate.group_reservations, 1);
  out.b.duplicate.pass = true;
  // Concurrent duplicate: the partial unique index claims the turn once.
  const slowTool = toolMod.makeGenerateImageTool({
    async generateImage() { calls.images++; await new Promise((r) => setTimeout(r, 20)); return okImage(); },
    enqueueGeneratedImage: (ee, o) => imagegen.enqueueGeneratedImage(ee, o),
  });
  const [p1, p2] = await Promise.all([
    slowTool.run(e, {prompt: "并发一"}, ctx("dup-par")),
    slowTool.run(e, {prompt: "并发一"}, ctx("dup-par")),
  ]);
  out.b.concurrent = {
    results: [p1, p2].map((r) => ({ok: r.ok, status: r.status})),
    generate_calls_total: calls.images,
    generated_images_for_turn: one("SELECT COUNT(*) n FROM generated_images WHERE id='dup-par'").n,
    outbox_for_turn: one("SELECT COUNT(*) n FROM outbox WHERE id='dup-par~g'").n,
    log_for_turn: one("SELECT COUNT(*) n FROM image_gen_log WHERE turn_id='dup-par'").n,
  };
  assert.equal(out.b.concurrent.generate_calls_total, 2, "one sequential + one concurrent generation");
  assert.equal(out.b.concurrent.generated_images_for_turn, 1);
  assert.equal(out.b.concurrent.outbox_for_turn, 1);
  assert.equal(out.b.concurrent.log_for_turn, 1);
  out.b.concurrent.pass = true;
  raw.close();
}

// ---- c1) group cap: two senders fill the group, third refused without generating ----
{
  const {raw, DB} = openDb();
  const e = {DB};
  const set = (k, v) => raw.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
  set("imagegen:group_daily", "2");
  set("imagegen:user_daily", "99");
  const calls = {images: 0};
  const tool = toolMod.makeGenerateImageTool({
    async generateImage() { calls.images++; return okImage(); },
    async enqueueGeneratedImage(_e, o) { return {outbox_id: o.id + "~g"}; },
  });
  const a = await tool.run(e, {prompt: "图一"}, ctx("cap-1", "GROUP-CAP", "u1"));
  const b = await tool.run(e, {prompt: "图二"}, ctx("cap-2", "GROUP-CAP", "u2"));
  const c = await tool.run(e, {prompt: "图三"}, ctx("cap-3", "GROUP-CAP", "u3"));
  out.c.group_cap = {
    first: a.ok, second: b.ok,
    third: {ok: c.ok, error_kind: c.error_kind, reason_text: c.reason_text},
    generate_calls: calls.images,
    group_reservations: raw.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_group'").get().n,
  };
  assert.equal(a.ok, true); assert.equal(b.ok, true);
  assert.equal(c.ok, false); assert.equal(c.error_kind, "quota");
  assert.equal(calls.images, 2);
  out.c.group_cap.pass = true;
  raw.close();
}

// ---- c2) global daily budget: refused before any network call, no double charge ----
{
  const {raw, DB} = openDb();
  const e = {DB, OPENAI_API_KEY: "sk-budget-test-not-real"};
  raw.prepare("INSERT INTO settings VALUES('openai:daily_cap_micro_usd','1000')").run();
  raw.prepare("INSERT INTO openai_usage(id,purpose,model,status,latency_ms,est_cost_micro_usd,created_at) VALUES('seed','image_gen','seed','ok',1,1000,?)").run(Date.now());
  let network = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { network++; throw Error("network must not be called"); };
  const result = await imagegen.generateImage(e, {prompt: "预算到顶", quality: "low", group: "GROUP-B", sender: "u1"});
  globalThis.fetch = original;
  const usage = raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(est_cost_micro_usd),0) total FROM openai_usage").get();
  out.c.global_budget = {
    ok: result.ok, error_kind: result.error_kind, retryable: result.retryable,
    network_calls: network, usage_rows: usage.n, usage_total_micro_usd: usage.total,
    last_row: raw.prepare("SELECT status,error_kind,est_cost_micro_usd FROM openai_usage ORDER BY created_at DESC, rowid DESC LIMIT 1").get(),
  };
  assert.equal(result.ok, false); assert.equal(result.error_kind, "budget");
  assert.equal(network, 0);
  assert.equal(usage.total, 1000);
  out.c.global_budget.pass = true;
  raw.close();
}

// ---- d1) auth failure: honest error, zero network, one zero-cost audit row per attempt ----
{
  const {raw, DB} = openDb();
  const e = {DB};
  let network = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { network++; throw Error("network must not be called"); };
  const r1 = await imagegen.generateImage(e, {prompt: "无密钥", quality: "low", group: "GROUP-D", sender: "u1"});
  const r2 = await imagegen.generateImage(e, {prompt: "无密钥", quality: "low", group: "GROUP-D", sender: "u1"});
  globalThis.fetch = original;
  const usage = raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(est_cost_micro_usd),0) total FROM openai_usage").get();
  out.d.auth = {
    first: {ok: r1.ok, error_kind: r1.error_kind, retryable: r1.retryable, reason_text: r1.reason_text},
    second: {ok: r2.ok, error_kind: r2.error_kind},
    network_calls: network, usage_rows: usage.n, usage_total_micro_usd: usage.total,
    rows: raw.prepare("SELECT purpose,status,error_kind,est_cost_micro_usd FROM openai_usage ORDER BY created_at").all(),
  };
  assert.equal(r1.ok, false); assert.equal(r1.error_kind, "auth");
  assert.equal(r2.error_kind, "auth");
  assert.equal(network, 0);
  assert.equal(usage.n, 2); assert.equal(usage.total, 0);
  out.d.auth.pass = true;
  raw.close();
}

// ---- d2) timeout: one attempt, one zero-cost timeout row ----
{
  const {raw, DB} = openDb();
  const e = {DB, OPENAI_API_KEY: "sk-timeout-test-not-real"};
  let network = 0;
  const original = globalThis.fetch;
  globalThis.fetch = () => { network++; return new Promise(() => {}); };
  // generateImage hardcodes 100 s; call the same shared channel with a short deadline.
  const result = await openai.callOpenAi(e, {purpose: "image_gen", path: "/v1/images/generations", body: {model: "gpt-image-2.5-flare", prompt: "超时"}, timeoutMs: 30, model: "gpt-image-2.5-flare", estCostMicroUsd: 11000});
  globalThis.fetch = original;
  const usage = raw.prepare("SELECT COUNT(*) n, COALESCE(SUM(est_cost_micro_usd),0) total FROM openai_usage").get();
  out.d.timeout = {
    ok: result.ok, error_kind: result.error_kind, retryable: result.retryable,
    network_calls: network, usage_rows: usage.n, usage_total_micro_usd: usage.total,
    last_row: raw.prepare("SELECT status,error_kind,est_cost_micro_usd FROM openai_usage ORDER BY created_at DESC, rowid DESC LIMIT 1").get(),
  };
  assert.equal(result.ok, false); assert.equal(result.error_kind, "timeout");
  assert.equal(network, 1);
  assert.equal(usage.n, 1); assert.equal(usage.total, 0);
  out.d.timeout.pass = true;
  raw.close();
}

// ---- e) off:image_gen visibility and dispatch, on/off ----
{
  const {raw, DB} = openDb();
  const e = {DB};
  const set = (k, v) => raw.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);
  const calls = {images: 0};
  const tool = toolMod.makeGenerateImageTool({
    async generateImage() { calls.images++; return okImage(); },
    async enqueueGeneratedImage(_e, o) { return {outbox_id: o.id + "~g"}; },
  });
  const names = (defs) => defs.map((d) => d.function?.name);
  set("off:image_gen", "1");
  const defsOff = await toolkit.extraToolDefs(e, ctx("vis-1"));
  const quotaOff = await quota.quotaSnapshot(e, {group: "GROUP-D", sender: "u1"});
  const textOff = quota.quotaText(quotaOff);
  const runOff = await tool.run(e, {prompt: "关闭时"}, ctx("vis-1"));
  set("off:image_gen", "0");
  const defsOn = await toolkit.extraToolDefs(e, ctx("vis-2"));
  const quotaOn = await quota.quotaSnapshot(e, {group: "GROUP-D", sender: "u1"});
  const textOn = quota.quotaText(quotaOn);
  const runOn = await tool.run(e, {prompt: "开启时"}, ctx("vis-2"));
  set("off:generate_image", "1");
  const runLegacy = await toolkit.runExtraTool(e, "generate_image", {prompt: "旧开关"}, ctx("vis-3"));
  out.e = {
    off: {
      tool_def_visible: names(defsOff).includes("generate_image"),
      card_marks_closed: card.toolDisabled("generate_image", {"off:image_gen": "1"}),
      quota_imageGenOn: quotaOff.imageGenOn,
      quota_text_has_image_line: textOff.includes("生图："),
      run: {ok: runOff.ok, error_kind: runOff.error_kind, unavailable: runOff.unavailable},
    },
    on: {
      tool_def_visible: names(defsOn).includes("generate_image"),
      quota_imageGenOn: quotaOn.imageGenOn,
      quota_text_has_image_line: textOn.includes("生图："),
      run: {ok: runOn.ok, status: runOn.status},
    },
    legacy_switch: {key: "off:generate_image=1", run: {ok: runLegacy.ok, error_kind: runLegacy.error_kind, unavailable: runLegacy.unavailable}},
    generate_calls: calls.images,
  };
  assert.equal(out.e.off.run.ok, false);
  assert.equal(out.e.off.run.error_kind, "denied");
  assert.equal(out.e.off.quota_imageGenOn, false);
  assert.equal(out.e.off.quota_text_has_image_line, false);
  assert.equal(out.e.on.run.ok, true);
  assert.equal(out.e.on.quota_imageGenOn, true);
  assert.equal(out.e.on.quota_text_has_image_line, true);
  assert.equal(out.e.legacy_switch.run.ok, false);
  assert.equal(calls.images, 1, "only the enabled run generates");
  raw.close();
}

// ---- d3) tool failure paths: refusal/timeout return honestly and release quota ----
{
  const {raw, DB} = openDb();
  const e = {DB};
  const failures = {
    refused: {ok: false, error_kind: "refused", retryable: false, status: 400, reason_text: "图片内容安全系统拒绝了这个提示词", next_action: "换一个描述再试"},
    timeout: {ok: false, error_kind: "timeout", retryable: true, reason_text: "OpenAI 请求超时", next_action: "稍后重试"},
  };
  out.d.tool_failures = {};
  for (const [kind, failure] of Object.entries(failures)) {
    const calls = {images: 0};
    const tool = toolMod.makeGenerateImageTool({
      async generateImage() { calls.images++; return failure; },
      async enqueueGeneratedImage() { throw Error("must not enqueue a failure"); },
    });
    const r = await tool.run(e, {prompt: "失败路径 " + kind}, ctx("fail-" + kind, "GROUP-F"));
    const log = raw.prepare("SELECT COUNT(*) n FROM image_gen_log WHERE turn_id=?").get("fail-" + kind);
    out.d.tool_failures[kind] = {
      ok: r.ok, error_kind: r.error_kind, retryable: r.retryable, reason_text: r.reason_text,
      generate_calls: calls.images,
      user_reservations: raw.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_user' AND key='GROUP-F:u1'").get().n,
      group_reservations: raw.prepare("SELECT COUNT(*) n FROM quota_reservations WHERE kind='imagegen_group' AND key='GROUP-F'").get().n,
      outbox: raw.prepare("SELECT COUNT(*) n FROM outbox").get().n,
      log_rows: log.n,
      log_row: raw.prepare("SELECT status,error_kind,est_cost_micro_usd FROM image_gen_log WHERE turn_id=?").get("fail-" + kind),
    };
    assert.equal(r.ok, false); assert.equal(r.error_kind, kind);
    assert.equal(calls.images, 1);
    assert.equal(out.d.tool_failures[kind].user_reservations, 0);
    assert.equal(out.d.tool_failures[kind].group_reservations, 0);
    assert.equal(out.d.tool_failures[kind].outbox, 0);
    assert.equal(log.n, 1);
    assert.equal(out.d.tool_failures[kind].log_row.status, "failed");
    assert.equal(out.d.tool_failures[kind].log_row.est_cost_micro_usd, 0);
  }
  out.d.tool_failures.pass = true;
  raw.close();
}

console.log(JSON.stringify(out, null, 2));
