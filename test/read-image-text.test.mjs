import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
let modulePromise;
let registryPromise;

async function load() {
  modulePromise ||= build({
    entryPoints: ["src/tools/read-image-text.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  }).then((out) => import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")));
  return modulePromise;
}

async function registry() {
  registryPromise ||= build({
    entryPoints: ["src/toolkit.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  }).then((out) => import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64")));
  return registryPromise;
}

function env() {
  const raw = new DatabaseSync(":memory:");
  raw.exec(schema);
  const DB = {
    prepare(sql) {
      const statement = (args = []) => ({
        sql,
        bind(...values) { return statement(values); },
        async first() { return raw.prepare(sql).get(...args) || null; },
        async all() { return { results: raw.prepare(sql).all(...args) }; },
        async run() { return raw.prepare(sql).run(...args); },
      });
      return statement();
    },
    async batch(statements) { return Promise.all(statements.map((s) => (s.all ? s.all() : s.run()))); },
  };
  return { DB, raw };
}

function seed(e, { id = "m1", group = "GROUP1", attachments = [] } = {}) {
  e.raw.prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?,0)")
    .run(id, group, "member-1", "图里写了什么", "2026-11-14T00:00:00Z", 1);
  e.raw.prepare("INSERT OR REPLACE INTO message_meta VALUES(?,?)")
    .run(id, JSON.stringify({ attachments }));
}

const IMAGE = { url: "https://multimedia.nt.qq.com.cn/download?fileid=1", filename: "shot.jpg", content_type: "image/jpeg", size: 2048 };
const SECOND = { url: "https://gchat.qpic.cn/gchatpic_new/2/3-4", filename: "second.png", content_type: "image/png", size: 2048 };

function ctx({ id = "m1", group = "GROUP1", sender = "member-1" } = {}) {
  return { context: { latest: { id, group_id: group, sender } }, source: { id, group_id: group, sender }, messages: [], isTainted: () => false };
}

function okOcr(text, { pages, finish = "stop" } = {}) {
  const list = pages || [{ index: 0, text, finish_reason: finish }];
  return { ok: true, status: 200, latency_ms: 1234, data: { object: "ocr.result", page_count: list.length, pages: list } };
}

function deps(over = {}) {
  const calls = { ocr: [], guard: [], fetch: [], vision: [] };
  const api = {
    callDs: async (_e, o) => { calls.ocr.push(o); return over.ocr ? over.ocr(o, calls) : okOcr("合同金额 12,345.67 元"); },
    guard: async (_e, o) => { calls.guard.push(o); return over.guard ? over.guard(o, calls) : { ok: true, release: async () => { calls.released = (calls.released || 0) + 1; } }; },
    fetchImage: async (url, _signal, _max, _report) => { calls.fetch.push(url); return over.fetchImage ? over.fetchImage(url, calls) : { bytes: new Uint8Array([1, 2, 3]), mime: "image/jpeg" }; },
    describeBytes: async (_e, _bytes, _mime, hint, _signal) => { calls.vision.push(hint); return over.describeBytes ? over.describeBytes(hint, calls) : { sha: "x", desc: "图", text: "THE FIRST STEP", tags: [], meme: false }; },
    now: () => Date.parse("2026-11-14T02:00:00Z"),
    ...(over.deps || {}),
  };
  return { api, calls };
}

async function make(over = {}) {
  const k = await load();
  const { api, calls } = deps(over);
  return { k, tool: k.createReadImageTextTool(api), calls };
}

test("registers one untrusted read_image_text tool with the agreed switch", async () => {
  const k = await registry();
  const tool = k.findExtraTool("read_image_text");
  assert.ok(tool, "read_image_text must be registered in EXTRA_TOOLS");
  assert.equal(tool.name, "read_image_text");
  assert.equal(tool.def.type, "function");
  assert.equal(tool.def.function.name, "read_image_text");
  assert.equal(tool.untrusted, true);
  assert.equal(tool.switch, "read_image_text");
  assert.ok(k.extraToolDefs().map((d) => d.function.name).includes("read_image_text"));
  assert.ok(k.extraUntrustedNames().includes("read_image_text"));
  const props = tool.def.function.parameters.properties;
  assert.deepEqual(Object.keys(props).sort(), ["index", "message_id"]);
  assert.match(tool.def.function.description, /截图|扫描/);
  assert.match(tool.def.function.description, /人像|表情/);
});

test("OCR success returns text, via=ocr, pages and no download URL", async () => {
  const { tool, calls } = await make();
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.via, "ocr");
  assert.equal(out.pages, 1);
  assert.equal(out.truncated, false);
  assert.match(out.text, /12,345\.67/);
  assert.equal(calls.guard.length, 1);
  assert.equal(calls.guard[0].purpose, "ocr");
  assert.deepEqual(calls.guard[0].group, "GROUP1");
  assert.equal(calls.fetch[0], IMAGE.url);
  const call = calls.ocr[0];
  assert.equal(call.purpose, "ocr");
  assert.equal(call.expect, "json");
  assert.equal(call.group, "GROUP1");
  assert.equal(call.sender, "member-1");
  assert.ok(call.form instanceof FormData);
  assert.equal(call.form.get("purpose"), "text_recognition");
  const file = call.form.get("file");
  assert.ok(file && typeof file === "object");
  assert.equal(file.type, "image/jpeg");
  assert.equal(file.size, 3);
  assert.equal(calls.released, 1);
  assert.doesNotMatch(JSON.stringify(out), /multimedia\.nt\.qq\.com\.cn/);
});

test("index selects the requested image from one message", async () => {
  const { tool, calls } = await make();
  const e = env();
  seed(e, { attachments: [IMAGE, SECOND] });
  const out = await tool.run(e, { index: 1 }, ctx());
  assert.equal(out.ok, true);
  assert.equal(calls.fetch.length, 1);
  assert.equal(calls.fetch[0], SECOND.url);
});

test("HTTP 200 with a body error is a failure, never text", async () => {
  const { tool, calls } = await make({
    ocr: () => ({ ok: true, status: 200, latency_ms: 10, data: { error: { message: "Failed to recognize the file: the file format is not supported", type: "invalid_request_error" } } }),
    describeBytes: () => null,
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "unsupported");
  assert.equal(out.retryable, false);
  assert.ok(calls.vision.length >= 1);
});

test("#183-style 19,116-char DO ONE loop falls back to vision, never returns the garbage", async () => {
  const loop = Array.from({ length: 2735 }, () => "DO ONE").join("\n");
  assert.ok(loop.length > 19000);
  const { tool, calls } = await make({
    ocr: () => okOcr(loop, { pages: [{ index: 0, text: loop, finish_reason: "length" }] }),
    describeBytes: () => ({ sha: "x", desc: "人像", text: "THE FIRST STEP", tags: [], meme: true }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.via, "vision_fallback");
  assert.equal(out.pages, 1);
  assert.match(out.text, /THE FIRST STEP/);
  assert.match(out.text, /可能有误/);
  assert.doesNotMatch(out.text, /DO ONE DO ONE/);
  assert.ok(out.text.length < 500);
  assert.match(calls.vision[0], /只提取.*文字/);
});

test("a long repeat is caught even when the service says finish_reason=stop", async () => {
  const loop = Array.from({ length: 900 }, () => "DO ONE").join("\n");
  const { tool } = await make({
    ocr: () => okOcr(loop, { pages: [{ index: 0, text: loop, finish_reason: "stop" }] }),
    describeBytes: () => ({ sha: "x", desc: "人像", text: "印花文字", tags: [], meme: true }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.via, "vision_fallback");
});

test("looksLikeLoop does not flag short laughs, lyrics or ordinary tables", async () => {
  const { looksLikeLoop } = await load();
  assert.equal(looksLikeLoop("哈哈哈哈哈哈").loop, false);
  const chorus = "我们越过山丘 看见海和星光\n";
  const lyrics = "第一段歌词写在这里\n" + chorus.repeat(4) + "第二段歌词写在这里\n" + "尾声落下\n".repeat(3);
  assert.equal(looksLikeLoop(lyrics).loop, false);
  let table = "| 项目 | 金额 | 数量 |\n|---|---|---|\n";
  for (let i = 0; i < 40; i++) table += `| 合同 ${i + 1} | ${1000 + i * 7} | ${i + 1} |\n`;
  assert.equal(looksLikeLoop(table).loop, false);
  assert.equal(looksLikeLoop(Array.from({ length: 2735 }, () => "DO ONE").join("\n")).loop, true);
  assert.equal(looksLikeLoop(Array.from({ length: 900 }, () => "DO ONE").join("\n")).loop, true);
  assert.equal(looksLikeLoop("\u0000\u0001".repeat(500)).loop, true);
});

test("punctuation-only OCR is empty, not a successful answer", async () => {
  const { tool } = await make({
    ocr: () => okOcr("## 1"),
    describeBytes: () => ({ sha: "x", desc: "纯图案", text: "", tags: [], meme: false }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "empty");
});

test("empty OCR output falls back and an empty fallback is an honest empty result", async () => {
  const { tool } = await make({
    ocr: () => okOcr(""),
    describeBytes: () => ({ sha: "x", desc: "一张纯色图案", text: "", tags: [], meme: false }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "empty");
  assert.match(out.next_action, /重发|贴/);
  assert.equal(out.text, undefined);
});

test("a timeout falls back to vision and says the text may be wrong", async () => {
  const { tool } = await make({
    ocr: () => ({ ok: false, error_kind: "timeout", retryable: true, reason_text: "识别超时", next_action: "稍后重试" }),
    describeBytes: () => ({ sha: "x", desc: "截图", text: "第一行\n第二行", tags: [], meme: false }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.via, "vision_fallback");
  assert.match(out.text, /第一行/);
  assert.match(out.text, /可能有误/);
});

test("a spent daily OCR quota returns the guard failure and never calls OCR", async () => {
  const { tool, calls } = await make({
    guard: () => ({ ok: false, error_kind: "quota", retryable: true, reason_text: "今日文字识别次数已用完", next_action: "明天再试或让成员贴文字" }),
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "quota");
  assert.equal(calls.ocr.length, 0);
  assert.equal(calls.vision.length, 0);
});

test("missing message, no image and an expired link each say what to do", async () => {
  const { tool, calls } = await make({ fetchImage: () => null });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const missing = await tool.run(e, { message_id: "nope" }, ctx());
  assert.equal(missing.error_kind, "not_found");
  assert.match(missing.next_action, /重新发|过期/);

  seed(e, { id: "m2", attachments: [{ url: "https://x/a.pdf", filename: "a.pdf", content_type: "application/pdf" }] });
  const noImage = await tool.run(e, { message_id: "m2" }, ctx());
  assert.equal(noImage.error_kind, "no_image");

  const expired = await tool.run(e, {}, ctx());
  assert.equal(expired.ok, false);
  assert.equal(expired.error_kind, "not_found");
  assert.match(expired.next_action, /图片链接已过期.*重发/);
  assert.equal(calls.ocr.length, 0);
});

test("another group's message is not readable", async () => {
  const { tool } = await make();
  const e = env();
  seed(e, { id: "other", group: "GROUP2", attachments: [IMAGE] });
  const out = await tool.run(e, { message_id: "other" }, ctx());
  assert.equal(out.error_kind, "not_found");
});

test("long normal text truncates at 3000 characters and is marked truncated", async () => {
  const long = Array.from({ length: 140 }, (_, i) => `第${i + 1}条：金额 ${1000 + i} 元，负责人甲乙丙丁，备注无。`).join("\n");
  assert.ok(long.length > 3000 && long.length < 8000);
  const { tool } = await make({ ocr: () => okOcr(long) });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.truncated, true);
  assert.equal(out.text.length, 3000);
});

test("a vision failure does not turn into a made-up answer", async () => {
  const { tool } = await make({
    ocr: () => ({ ok: false, error_kind: "upstream", retryable: true, reason_text: "识别服务暂时不可用", next_action: "稍后重试" }),
    describeBytes: () => null,
  });
  const e = env();
  seed(e, { attachments: [IMAGE] });
  const out = await tool.run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "upstream");
  assert.equal(out.text, undefined);
  assert.match(out.next_action, /重发|贴|稍后/);
});
