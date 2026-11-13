import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { readFileSync } from "node:fs";

async function load() {
  const out = await build({
    entryPoints: ["src/toolkit.ts"],
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const schema = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

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
    async batch(statements) { return Promise.all(statements.map(s => s.all ? s.all() : s.run())); },
  };
  return { DB, raw };
}

function seed(e, { id = "m1", group = "GROUP1", attachments = [] } = {}) {
  e.raw.prepare("INSERT OR REPLACE INTO messages VALUES(?,?,?,?,?,?,0)")
    .run(id, group, "member-1", "看下这份文件", "2026-11-14T00:00:00Z", 1);
  e.raw.prepare("INSERT OR REPLACE INTO message_meta VALUES(?,?)")
    .run(id, JSON.stringify({ attachments }));
}

function ctx({ id = "m1", group = "GROUP1" } = {}) {
  return { context: { latest: { id, group_id: group } }, source: { id, group_id: group }, messages: [], isTainted: () => false };
}

const pdf = { url: "https://multimedia.nt.qq.com.cn/download?fileid=1", filename: "report.pdf", content_type: "application/pdf", size: 2048 };

test("registers one untrusted read_document tool with a group-scoped schema", async () => {
  const k = await load();
  const tool = k.findExtraTool("read_document");
  assert.ok(tool, "read_document must be registered in EXTRA_TOOLS");
  assert.equal(tool.name, "read_document");
  assert.equal(tool.def.type, "function");
  assert.equal(tool.def.function.name, "read_document");
  assert.equal(tool.untrusted, true);
  assert.equal(tool.switch, "docread");
  assert.deepEqual(k.extraToolDefs().map(d => d.function.name).filter(n => n === "read_document"), ["read_document"]);
  assert.ok(k.extraUntrustedNames().includes("read_document"));
  const props = tool.def.function.parameters.properties;
  assert.deepEqual(Object.keys(props).sort(), ["filename", "message_id", "question"]);
});

test("returns a cached extraction for the same message and question", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [pdf] });
  const tool = k.findExtraTool("read_document");
  const cached = {
    ok: true, kind: "pdf", text: "===== 第 3 页 =====\n本页合计金额：12,345.67 元",
    pages: [{ page: 1, chars: 10 }, { page: 2, chars: 11 }], sheets: [], meta: {}, warnings: [],
    hits: [{ page: 3, label: "第 3 页", text: "本页合计金额：12,345.67 元", lines: ["本页合计金额：12,345.67 元"], score: 1, explicit: true }],
    truncated: false,
  };
  const { documentNoteKey } = await toolModule();
  e.raw.prepare("INSERT INTO media_notes VALUES(?,?,?)")
    .run(documentNoteKey("m1", 0, "第3页的金额"), JSON.stringify(cached), "2026-11-14T00:00:00Z");
  const out = await tool.run(e, { question: "第3页的金额" }, ctx());
  assert.equal(out.ok, true);
  assert.equal(out.kind, "pdf");
  assert.equal(out.hits[0].page, 3);
  assert.match(out.text, /12,345\.67/);
  assert.equal(out.pages.length, 2);
});

async function toolModule() {
  const out = await build({ entryPoints: ["src/tools/read-document.ts"], bundle: true, format: "esm", platform: "neutral", write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

test("another group's message is not readable", async () => {
  const k = await load();
  const e = env();
  seed(e, { id: "other", group: "GROUP2", attachments: [pdf] });
  const out = await k.findExtraTool("read_document").run(e, { message_id: "other", question: "金额" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "not_found");
});

test("a message without a document says so instead of inventing content", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [{ url: "https://x/photo.jpg", filename: "photo.jpg", content_type: "image/jpeg" }] });
  const out = await k.findExtraTool("read_document").run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "no_document");
  assert.match(out.next_action, /重新上传|没有/);
});

test("unsupported and non-https attachments are ignored", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [
    { url: "https://x/run.exe", filename: "run.exe", content_type: "application/octet-stream" },
    { url: "file:///etc/passwd", filename: "passwd.pdf", content_type: "application/pdf" },
  ] });
  const out = await k.findExtraTool("read_document").run(e, {}, ctx());
  assert.equal(out.error_kind, "no_document");
});

test("filename selects among several attachments and changes the cache key", async () => {
  const k = await load();
  const e = env();
  const docx = { url: "https://x/b.docx", filename: "b.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 10 };
  seed(e, { attachments: [pdf, docx] });
  const tool = k.findExtraTool("read_document");
  const out = await tool.run(e, { filename: "b.docx", question: "金额" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "unavailable");
  assert.equal(out.filename, "b.docx");
  const { documentNoteKey } = await toolModule();
  assert.notEqual(documentNoteKey("m1", 0, "金额"), documentNoteKey("m1", 1, "金额"));
  assert.equal(documentNoteKey("m1", 1, " 金额 "), documentNoteKey("m1", 1, "金额"));
});

test("oversized files are refused before any reading", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [{ ...pdf, size: 30 * 1024 * 1024 }] });
  const out = await k.findExtraTool("read_document").run(e, {}, ctx());
  assert.equal(out.error_kind, "too_large");
  assert.equal(out.retryable, false);
});

test("without the local reader wiring the tool is unavailable and writes no job", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [pdf] });
  const out = await k.findExtraTool("read_document").run(e, { question: "金额" }, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "unavailable");
  assert.equal(e.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get().n, 0);
});

test("with the reader switch on it queues one idempotent docread job", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [pdf] });
  e.raw.prepare("INSERT INTO settings VALUES('docread:enabled','1')").run();
  const tool = k.findExtraTool("read_document");
  const first = await tool.run(e, { question: "金额" }, ctx());
  const second = await tool.run(e, { question: "金额" }, ctx());
  assert.equal(first.error_kind, "pending");
  assert.equal(first.retryable, true);
  assert.equal(second.job_id, first.job_id);
  const jobs = e.raw.prepare("SELECT * FROM jobs").all();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, "docread");
  const payload = JSON.parse(jobs[0].payload);
  assert.equal(payload.message_id, "m1");
  assert.equal(payload.filename, "report.pdf");
  assert.equal(payload.question, "金额");
  assert.equal(payload.group_id, "GROUP1");
  assert.match(payload.url, /^https:\/\//);
});

test("a corrupted cache row is reported, not guessed", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [pdf] });
  const { documentNoteKey } = await toolModule();
  e.raw.prepare("INSERT INTO media_notes VALUES(?,?,?)").run(documentNoteKey("m1", 0, ""), "{not json", "2026-11-14T00:00:00Z");
  const out = await k.findExtraTool("read_document").run(e, {}, ctx());
  assert.equal(out.ok, false);
  assert.equal(out.error_kind, "corrupt");
});

test("the tool never exposes the QQ download URL to the model", async () => {
  const k = await load();
  const e = env();
  seed(e, { attachments: [pdf] });
  e.raw.prepare("INSERT INTO settings VALUES('docread:enabled','1')").run();
  const out = await k.findExtraTool("read_document").run(e, {}, ctx());
  assert.doesNotMatch(JSON.stringify(out), /multimedia\.nt\.qq\.com/);
});
