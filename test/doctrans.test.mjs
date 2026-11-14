// Offline tests for document translation. The translation engine runs against a fake model; the Office and
// PDF path runs the real machine-side script with a local Python (python-docx, python-pptx, openpyxl,
// PyMuPDF; set DOCTRANS_PY to pick one) through a stand-in for runComputer that executes the generated bash
// in a temp directory with /work mapped there. Without those libraries the round-trip tests are skipped.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const D = await import("../src/feat/doctrans.ts");
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);
const sh = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

const PY = process.env.DOCTRANS_PY || "python3";
const hasPy = spawnSync(PY, ["-c", "import docx, pptx, openpyxl, lxml\ntry:\n import pymupdf\nexcept ImportError:\n import fitz"]).status === 0;
const PATH = path.dirname(PY.includes("/") ? PY : "/usr/bin/x") + ":" + process.env.PATH;

// ---------- fakes ----------

/** A model that "translates" by tagging every value, with knobs for dropping ids, garbage and failures. */
function fakeModel({ drop = () => false, garbage = () => false, fail = () => false, delay = 0 } = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const ask = async (messages, maxTokens) => {
    const n = calls.length;
    const input = JSON.parse(messages[1].content);
    calls.push({ input, maxTokens, system: messages[0].content });
    active++; peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, delay));
    active--;
    if (fail(n, input)) throw new Error("model http 500");
    if (garbage(n, input)) return "抱歉，我不能";
    const out = {};
    for (const [k, v] of Object.entries(input)) if (!drop(n, k, v)) out[k] = "EN<" + v + ">";
    return "```json\n" + JSON.stringify(out) + "\n```";
  };
  return { ask, calls, peak: () => peak };
}

function machine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "doctrans-test-")), work = path.join(tmp, "work"), box = path.join(tmp, "box");
  fs.mkdirSync(work); fs.mkdirSync(box);
  const calls = [];
  const local = s => s.replaceAll("/work/", work + "/").replaceAll("'/work'", sh(work));
  const runComputer = async (_hub, req) => {
    calls.push(req);
    const out = { ok: false, steps: [], files: [], seconds: 1 };
    for (const f of req.files || []) fs.writeFileSync(path.join(work, f.name), f.bytes);
    for (const command of req.commands) {
      const r = spawnSync("bash", ["-c", local(command)], { cwd: work, encoding: "utf8", env: { ...process.env, PATH } });
      out.steps.push({ command, exit: r.status, stdout: r.stdout, stderr: r.stderr, seconds: 0 });
      if (r.status !== 0) break;
    }
    for (const p of req.collect || []) {
      const full = path.join(work, p);
      if (fs.existsSync(full)) out.files.push({ name: p, bytes: fs.readFileSync(full) });
    }
    out.ok = out.steps.length === req.commands.length && out.steps.every(s => s.exit === 0);
    return out;
  };
  return { tmp, work, box, calls, runComputer };
}

function fakeHost(over = {}) {
  const log = [], scratch = new Map();
  let n = 0;
  return {
    log, sent: [],
    fileRef: async ref => (over.files || {})[ref] || null,
    sendFile: async function (name, bytes) { log.push(["file", name]); this.sent.push({ name, bytes }); return { ok: true }; },
    keepFile: async name => { log.push(["keep", name]); return "f" + ++n; },
    say: async text => { log.push(["say", text]); return true; },
    quota: async (kind, limit) => { log.push(["quota", kind, limit]); return over.quota ?? true; },
    cfg: key => (over.cfg || {})[key] ?? (key === "doctrans_daily" ? 20 : key === "doctrans_max_chars" ? 150000 : 0),
    scratch: (k, v) => { if (v === undefined) return scratch.get(k) ?? null; if (v === null) scratch.delete(k); else scratch.set(k, v); return v; },
  };
}
const hub = { plan: { fits: () => true }, env: {} };
const ctxOf = host => ({ hub, conv: "t:ag-trans", askers: [], host });
function depsOf(m, model, over = {}) {
  return {
    runComputer: m?.runComputer || (async () => { throw new Error("no machine in this test"); }),
    ask: () => model.ask, id: () => "abc123",
    boxFile: (_h, _c, ref) => (ref === "x12" ? { ref, name: "大报告.pptx", size: 100 } : ref === "x13" ? { ref, name: "notes.md", size: 10 } : null),
    boxDownloadCommand: (_h, _c, ref, dest) => "cp " + sh(m.tmp + "/boxed-" + ref) + " " + sh(dest),
    boxUpload: (_h, _c, p, name) => ({ command: "cp " + sh(p) + " " + sh(m.box + "/" + name), claim: async () => ({ ref: "x77", name, size: fs.statSync(m.box + "/" + name).size, link: "https://example.test/x/box/t/" + name }) }),
    ...over,
  };
}

// ---------- small pieces ----------

describe("kinds, languages, ranges", () => {
  test("file kinds by extension", () => {
    assert.equal(D.kindOf("报告.DOCX"), "docx");
    assert.equal(D.kindOf("deck.pptm"), "pptx");
    assert.equal(D.kindOf("a.b.xlsx"), "xlsx");
    assert.equal(D.kindOf("x.pdf"), "pdf");
    assert.equal(D.kindOf("README.md"), "md");
    assert.equal(D.kindOf("sub.srt"), "srt");
    assert.equal(D.kindOf("sub.vtt"), "srt");
    assert.equal(D.kindOf("old.doc"), null);
    assert.equal(D.kindOf("noext"), null);
  });
  test("language names and tags", () => {
    assert.deepEqual(D.language("en"), { name: "英文", tag: "EN" });
    assert.deepEqual(D.language("中文"), { name: "简体中文", tag: "中文" });
    assert.deepEqual(D.language("繁體中文"), { name: "繁体中文", tag: "繁中" });
    assert.deepEqual(D.language("日语"), { name: "日文", tag: "日文" });
    assert.equal(D.language("Português").name, "Português");
    assert.equal(D.language("'; rm -rf /").name, "rm -rf");
    assert.equal(D.language("").name, "英文");
  });
  test("page ranges", () => {
    assert.deepEqual(D.parseRange("1-3, 7，9"), [1, 2, 3, 7, 9]);
    assert.deepEqual(D.parseRange("5到6"), [5, 6]);
    assert.equal(D.parseRange(""), null);
    assert.equal(D.parseRange(undefined), null);
    assert.match(D.parseRange("abc"), /1-5/);
    assert.match(D.parseRange("5-2"), /不对/);
  });
  test("output names keep the base, add the language, drop path tricks", () => {
    assert.equal(D.outName("季度报告.docx", "EN", "docx"), "季度报告_EN.docx");
    assert.equal(D.outName("../../a:b.pdf", "中文", "md"), "a_b_中文.md");
    assert.equal(D.outName(".pptx", "EN", "pptx"), "文档_EN.pptx");
  });
  test("what already is in the target language is skipped", () => {
    const zh = [{ id: "1", text: "这是一份中文报告" }, { id: "2", text: "GitHub Actions" }, { id: "3", text: "使用 API 的方法" }];
    assert.equal(D.mostlyCjk(zh), true);
    assert.deepEqual(zh.filter(s => D.needsWork(s, "英文", true)).map(s => s.id), ["1", "3"]);
    const en = [{ id: "1", text: "A long English sentence here" }, { id: "2", text: "中文名" }];
    assert.equal(D.mostlyCjk(en), false);
    assert.deepEqual(en.filter(s => D.needsWork(s, "简体中文", false)).map(s => s.id), ["1"]);
    assert.equal(D.needsWork({ id: "1", text: "Bonjour" }, "英文", false), true);
  });
});

describe("protecting code and links", () => {
  test("inline code, link targets, autolinks, tags and bare links become placeholders", () => {
    const p = D.protect("Run `npm i` then see [docs](https://a.b/c \"t\") or <https://x.y> and <b>bold</b>, also https://q.r/s?x=1.");
    assert.equal(p.text, "Run ⟦1⟧ then see [docs⟦2⟧ or ⟦3⟧ and ⟦4⟧bold⟦5⟧, also ⟦6⟧");
    assert.equal(D.restore(p.text, p.ph), "Run `npm i` then see [docs](https://a.b/c \"t\") or <https://x.y> and <b>bold</b>, also https://q.r/s?x=1.");
  });
  test("a translation must keep each placeholder once and the table bars", () => {
    const s = { id: "1", text: "a ⟦1⟧ b ⟦2⟧", ph: ["`x`", "`y`"] };
    assert.equal(D.keeps(s, "甲 ⟦2⟧ 乙 ⟦1⟧"), true);
    assert.equal(D.keeps(s, "甲 ⟦1⟧ 乙"), false);
    assert.equal(D.keeps(s, "甲 ⟦1⟧ ⟦1⟧ ⟦2⟧"), false);
    assert.equal(D.keeps(s, "甲 ⟦1⟧ ⟦2⟧ ⟦3⟧"), false);
    assert.equal(D.keeps({ id: "r", text: "| a | b |", pipes: 3 }, "| 甲 | 乙 |"), true);
    assert.equal(D.keeps({ id: "r", text: "| a | b |", pipes: 3 }, "| 甲乙 |"), false);
    assert.equal(D.keeps({ id: "x", text: "a" }, "  "), false);
  });
});

describe("translation engine", () => {
  const segs = n => Array.from({ length: n }, (_, i) => ({ id: "s" + i, text: "第" + i + "段文字。".repeat(10) }));
  test("batches respect size and count, in order", () => {
    const b = D.batches(segs(100), 500, 40);
    assert.ok(b.every(x => x.length <= 40 && (x.length === 1 || x.reduce((s, y) => s + y.text.length, 0) <= 500)));
    assert.deepEqual(b.flat().map(s => s.id), segs(100).map(s => s.id));
    assert.equal(D.batches([{ text: "x".repeat(9000) }], 2500).length, 1);
  });
  test("replies with fences or chatter around the JSON are read", () => {
    assert.deepEqual(D.parseReply("```json\n{\"1\":\"a\"}\n```"), { 1: "a" });
    assert.deepEqual(D.parseReply("好的：{\"1\":\"a\",\"2\":\"b\"} 完成"), { 1: "a", 2: "b" });
    assert.equal(D.parseReply("[1,2]"), null);
    assert.equal(D.parseReply("nothing"), null);
  });
  test("every id comes back, with short keys sent to the model and a glossary in the prompt", async () => {
    const m = fakeModel();
    const r = await D.translate(segs(5), { to: "英文", glossary: "段=paragraph" }, m.ask);
    assert.equal(Object.keys(r.map).length, 5);
    assert.equal(r.map.s3, "EN<" + segs(5)[3].text + ">");
    assert.deepEqual(Object.keys(m.calls[0].input), ["1", "2", "3", "4", "5"]);
    assert.match(m.calls[0].system, /术语表（必须照用）：\n段=paragraph/);
    assert.match(m.calls[0].system, /翻译成英文/);
    assert.deepEqual(r.failed, []);
  });
  test("identical texts are asked once", async () => {
    const m = fakeModel();
    const r = await D.translate([{ id: "a", text: "同一句" }, { id: "b", text: "同一句" }, { id: "c", text: "另一句" }], { to: "英文" }, m.ask);
    assert.equal(m.calls.length, 1);
    assert.equal(Object.keys(m.calls[0].input).length, 2);
    assert.equal(r.map.a, r.map.b);
  });
  test("missing ids are retried once in two halves; what still fails keeps the original", async () => {
    // The first call drops keys 2 and 4; the retry of the first half succeeds, the second half keeps dropping "4"'s text.
    const m = fakeModel({ drop: (n, k, v) => (n === 0 && (k === "2" || k === "4")) || v.startsWith("第3段") });
    const r = await D.translate(segs(5), { to: "英文" }, m.ask);
    assert.equal(m.calls.length, 3);
    assert.deepEqual(r.failed, ["s3"]);
    assert.equal(r.map.s1, "EN<" + segs(5)[1].text + ">");
    assert.equal(r.map.s3, undefined);
  });
  test("a request that throws or answers garbage is tried again", async () => {
    let m = fakeModel({ fail: n => n === 0 });
    let r = await D.translate(segs(4), { to: "英文" }, m.ask);
    assert.equal(Object.keys(r.map).length, 4); assert.equal(m.calls.length, 3);
    m = fakeModel({ garbage: () => true });
    r = await D.translate(segs(1), { to: "英文" }, m.ask);
    assert.deepEqual(r.failed, ["s0"]); assert.equal(m.calls.length, 2);
  });
  test("a translation that loses a placeholder counts as failed", async () => {
    const seg = { id: "m", text: "看 ⟦1⟧ 这里", ph: ["`x`"] };
    const r = await D.translate([seg], { to: "英文" }, async () => "{\"1\":\"look here\"}");
    assert.deepEqual(r.failed, ["m"]);
  });
  test("a few requests run at once, not more", async () => {
    const m = fakeModel({ delay: 15 });
    const r = await D.translate(segs(60), { to: "英文", batchChars: 100 }, m.ask);
    assert.equal(Object.keys(r.map).length, 60);
    assert.ok(m.calls.length >= 10);
    assert.equal(m.peak(), 3);
  });
  test("known translations from an interrupted run are reused", async () => {
    const m = fakeModel();
    const r = await D.translate(segs(3), { to: "英文", known: { s0: "done0", s1: "done1" } }, m.ask);
    assert.equal(r.map.s0, "done0");
    assert.equal(m.calls.length, 1);
    assert.deepEqual(Object.keys(m.calls[0].input), ["1"]);
  });
  test("token budget grows with the text and is capped", () => {
    assert.ok(D.maxTokensFor([{ text: "x".repeat(100) }]) < D.maxTokensFor([{ text: "x".repeat(2000) }]));
    assert.equal(D.maxTokensFor([{ text: "x".repeat(50000) }]), 8000);
  });
});

// ---------- text formats ----------

const tagAll = pieces => Object.fromEntries(D.segsOf(pieces).map(s => [s.id, "EN<" + s.text + ">"]));

describe("Markdown", () => {
  const src = [
    "---", "title: 标题", "tags: [a]", "---", "# 介绍 `cli` {#intro}", "",
    "这是第一段，包含[链接](https://example.com/a)和", "第二行。", "",
    "```bash", "echo 你好", "```", "",
    "- 第一项", "  继续第一项", "- [ ] 待办", "1. 编号", "> 引用的话", "",
    "| 名称 | 说明 |", "|---|---|", "| 苹果 | `红色` |", "",
    "    缩进的代码", "",
    "![图](img/a.png)", "[ref]: https://example.com", "---", "$$", "E = mc^2", "$$", "",
  ].join("\n");
  const pieces = D.splitMarkdown(src);
  const out = D.joinPieces(pieces, tagAll(pieces), false);
  test("front matter, code, math, images, link definitions and indented code stay as they were", () => {
    assert.ok(out.startsWith("---\ntitle: 标题\ntags: [a]\n---\n"));
    assert.ok(out.includes("```bash\necho 你好\n```"));
    assert.ok(out.includes("$$\nE = mc^2\n$$"));
    assert.ok(out.includes("\n    缩进的代码\n"));
    assert.ok(out.includes("\n![图](img/a.png)\n[ref]: https://example.com\n---\n"));
    assert.ok(out.includes("|---|---|"));
  });
  test("headings, paragraphs, list items, quotes and rows are translated with markers and links intact", () => {
    assert.ok(out.includes("# EN<介绍 `cli` {#intro}>"));
    assert.ok(out.includes("EN<这是第一段，包含[链接](https://example.com/a)和第二行。>"));
    assert.ok(out.includes("- EN<第一项继续第一项>"));
    assert.ok(out.includes("- [ ] EN<待办>"));
    assert.ok(out.includes("1. EN<编号>"));
    assert.ok(out.includes("> EN<引用的话>"));
    assert.ok(out.includes("EN<| 苹果 | `红色` |>"));
    const seg = D.segsOf(pieces).find(s => s.text.includes("苹果"));
    assert.equal(seg.pipes, 3);
    assert.deepEqual(seg.ph, ["`红色`"]);
  });
  test("untranslated pieces keep their original lines; bilingual keeps both", () => {
    assert.equal(D.joinPieces(pieces, {}, false), src);
    const bi = D.joinPieces(pieces, tagAll(pieces), true);
    assert.ok(bi.includes("# 介绍 `cli` {#intro} / EN<介绍 `cli` {#intro}>"));
    assert.ok(bi.includes("这是第一段，包含[链接](https://example.com/a)和\n第二行。\n\nEN<"));
    assert.ok(bi.includes("- 第一项\n  继续第一项  \n  EN<第一项继续第一项>"));
    assert.ok(bi.includes("> 引用的话  \n> EN<引用的话>"));
  });
});

describe("subtitles and plain text", () => {
  test("SRT keeps numbering and times; tags are protected; bilingual stacks the lines", () => {
    const src = "1\n00:00:01,000 --> 00:00:02,000\n你好\n世界\n\n2\n00:00:03,000 --> 00:00:04,000\n<i>再见</i>\n\n3\n00:00:05,000 --> 00:00:06,000\n♪♪\n";
    const p = D.splitSrt(src);
    assert.equal(D.segsOf(p).length, 2);
    assert.deepEqual(D.segsOf(p)[1].ph, ["<i>", "</i>"]);
    const out = D.joinPieces(p, tagAll(p), false, "");
    assert.equal(out, "1\n00:00:01,000 --> 00:00:02,000\nEN<你好\n世界>\n\n2\n00:00:03,000 --> 00:00:04,000\nEN<<i>再见</i>>\n\n3\n00:00:05,000 --> 00:00:06,000\n♪♪\n");
    assert.equal(D.joinPieces(p, {}, false, ""), src);
    assert.ok(D.joinPieces(p, tagAll(p), true, "").startsWith("1\n00:00:01,000 --> 00:00:02,000\n你好\n世界\nEN<你好\n世界>\n\n2"));
  });
  test("WebVTT header stays", () => {
    const p = D.splitSrt("WEBVTT\n\n00:01.000 --> 00:02.000\nHello there\n");
    assert.equal(D.joinPieces(p, tagAll(p), false, ""), "WEBVTT\n\n00:01.000 --> 00:02.000\nEN<Hello there>\n");
  });
  test("text paragraphs and blank lines survive; long paragraphs are cut at line ends", () => {
    const src = "第一段\n第二行\n\n\n  缩进的段\n\n12345\n";
    const p = D.splitText(src);
    assert.equal(D.joinPieces(p, tagAll(p), false, ""), "EN<第一段\n第二行>\n\n\n  EN<缩进的段>\n\n12345\n");
    assert.equal(D.joinPieces(p, {}, false, ""), src);
    const long = Array.from({ length: 200 }, (_, i) => "这是很长的一行文字，编号 " + i).join("\n");
    const lp = D.splitText(long);
    assert.ok(D.segsOf(lp).length > 1 && D.segsOf(lp).every(s => s.text.length <= 3100));
    assert.equal(D.joinPieces(lp, {}, false, ""), long);
  });
  test("encodings: BOM, CRLF and GBK", () => {
    const d = D.decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("a\r\nb")]));
    assert.deepEqual([d.text, d.bom, d.crlf], ["a\nb", true, true]);
    assert.deepEqual([...D.encodeText("x\ny", d)], [0xef, 0xbb, 0xbf, ...enc("x\r\ny")]);
    const gbk = D.decodeText(new Uint8Array([0xc4, 0xe3, 0xba, 0xc3]));
    assert.equal(gbk.text, "你好"); assert.match(gbk.note, /GBK/);
  });
});

// ---------- generated shell ----------

describe("generated commands", () => {
  const dir = D.runDir("abc123");
  const all = [
    D.prepareCommand(dir, "src.docx", [{ from: "/work/doctrans-abc123-in", to: "src.docx" }], null),
    D.prepareCommand(dir, "src.pptx", [], "( d='src.pptx'; curl -fsS -o \"$d\" 'https://e.test/x' )"),
    D.prepareCommand(dir, null, [{ from: "/work/t", to: "tr.json" }], null),
    ...["docx", "pptx", "xlsx", "pdf"].flatMap(kind => [
      D.scriptCommand(dir, { mode: "extract", kind, src: "src." + kind, out: "seg.json", range: [1, 2] }),
      D.scriptCommand(dir, { mode: "write", kind, src: "src." + kind, tr: "tr.json", dst: "out/result." + kind, bilingual: true, range: null }),
    ]),
    D.finishCommand(dir, "out/result.docx", "curl -fsS -T out/result.docx 'https://e.test/put'"),
  ];
  test("every command parses with bash -n", () => {
    for (const c of all) {
      const r = spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr + "\n" + c.slice(0, 300));
    }
  });
  test("user text never reaches the code: arguments are one quoted JSON word, the script is a quoted heredoc", () => {
    const evil = "x'; touch /tmp/pwned; echo '$(id)`";
    const c = D.scriptCommand(dir, { mode: "extract", kind: "docx", src: evil, out: "seg.json" });
    assert.ok(c.includes("cat > dt.py <<'DT_PY_EOF'\n"));
    const r = spawnSync("bash", ["-c", "set -- $(true); f() { printf '%s' \"$1\"; }; " + "f " + c.split("\n").pop().replace(/^"\$PY" -I dt\.py /, "")], { encoding: "utf8" });
    assert.equal(JSON.parse(r.stdout).src, evil);
    assert.equal(c.split("\n").filter(l => l === "DT_PY_EOF").length, 1);
  });
  test("PyMuPDF is installed only for reading PDFs", () => {
    assert.ok(all.find(c => c.includes('"kind":"pdf","src"') && c.includes('"mode":"extract"')).includes("uv pip install -q --python \"$PY\" pymupdf"));
    assert.ok(!all.find(c => c.includes('"mode":"extract","kind":"docx"')).includes("uv pip install"));
  });
  test("a result over 25 MB goes to the file box", () => {
    const m = machine();
    fs.mkdirSync(path.join(m.work, "out"));
    fs.writeFileSync(path.join(m.work, "out/big.docx"), Buffer.alloc(25 * 1024 * 1024 + 10));
    fs.writeFileSync(path.join(m.work, "out/small.docx"), "x");
    const big = spawnSync("bash", ["-c", D.finishCommand(m.work, "out/big.docx", "cp out/big.docx " + sh(m.box + "/b"))], { encoding: "utf8" });
    assert.match(big.stdout, /@@size 26214410\n@@boxed/);
    assert.ok(fs.existsSync(m.box + "/b"));
    const small = spawnSync("bash", ["-c", D.finishCommand(m.work, "out/small.docx", "false")], { encoding: "utf8" });
    assert.equal(small.stdout.trim(), "@@size 1");
    const failed = spawnSync("bash", ["-c", D.finishCommand(m.work, "out/big.docx", "false")], { encoding: "utf8" });
    assert.match(failed.stdout, /@@boxfail/);
  });
});

// ---------- the tool, text formats ----------

describe("translate_doc on text files", () => {
  test("Markdown comes back as a file with code untouched, the language chosen from the text", async () => {
    const host = fakeHost({ files: { f1: { name: "说明.md", bytes: enc("# 标题\n\n正文 `code`。\n\n```\n不翻\n```\n") } } });
    const m = fakeModel();
    const r = await D.translateDoc(ctxOf(host), { file: "f1" }, depsOf(null, m));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.file, "说明_EN.md");
    assert.equal(r.to, "英文");
    assert.equal(dec(host.sent[0].bytes), "# EN<标题>\n\nEN<正文 `code`。>\n\n```\n不翻\n```\n");
    assert.equal(r.ref, "f1");
    assert.deepEqual(host.log.find(l => l[0] === "quota"), ["quota", "doctrans", 20]);
  });
  test("chat links are resolved, SRT bilingual keeps CRLF and the BOM", async () => {
    const link = "https://multimedia.nt.qq.com.cn/download?id=1";
    const host = fakeHost({ files: { [link]: { name: "ep1.srt", bytes: enc("\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\n") } } });
    const r = await D.translateDoc(ctxOf(host), { file: "[文件 ep1.srt " + link + "]", bilingual: true, to: "中文" }, depsOf(null, fakeModel()));
    assert.equal(r.file, "ep1_双语_中文.srt");
    assert.equal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(host.sent[0].bytes), "\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nHello\r\nEN<Hello>\r\n");
  });
  test("refusals: no file, old formats, unknown types, box text files, size cap, quota", async () => {
    const host = fakeHost({ files: { f1: { name: "a.doc", bytes: enc("x") }, f2: { name: "a.zip", bytes: enc("x") }, f3: { name: "b.txt", bytes: enc("字".repeat(6000)) } }, cfg: { doctrans_max_chars: 5000 } });
    const run = (a, h = host) => D.translateDoc(ctxOf(h), a, depsOf(null, fakeModel()));
    assert.match((await run({})).error, /要给文件/);
    assert.match((await run({ file: "f1" })).error, /老的 \.doc 格式，先用 Office 或 WPS 另存为 \.docx/);
    assert.match((await run({ file: "f2" })).error, /这种文件翻不了/);
    assert.match((await run({ file: "f9" })).error, /取不到文件 f9/);
    assert.match((await run({ file: "x13" })).error, /文件箱里的这类文件翻不了/);
    assert.match((await run({ file: "x99" })).error, /文件箱里找不到 x99/);
    assert.match((await run({ file: "f3" })).error, /6000 字，超过一次的上限 5000 字/);
    assert.match((await run({ file: "f3", pages: "z" })).error, /1-5/);
    assert.match((await run({ file: "f3" }, fakeHost({ files: { f3: { name: "b.txt", bytes: enc("字") } }, quota: false }))).error, /次数用完了/);
  });
  test("a big job says how long it will take before starting", async () => {
    const text = Array.from({ length: 40 }, (_, i) => "第" + i + "段。" + "内容".repeat(150)).join("\n\n");
    const host = fakeHost({ files: { f1: { name: "长文.txt", bytes: enc(text) } } });
    const r = await D.translateDoc(ctxOf(host), { file: "f1" }, depsOf(null, fakeModel()));
    assert.equal(r.ok, true);
    const said = host.log.find(l => l[0] === "say");
    assert.match(said[1], /开始翻《长文\.txt》：要翻大约 \d+ 字，估计 \d+ 分钟左右/);
    assert.equal(host.scratch("doctrans"), null);
  });
  test("failures are reported, original text kept", async () => {
    const host = fakeHost({ files: { f1: { name: "a.txt", bytes: enc("你好\n\n再见") } } });
    const r = await D.translateDoc(ctxOf(host), { file: "f1" }, depsOf(null, fakeModel({ drop: (n, k, v) => v === "再见" })));
    assert.equal(r.kept_original, 1);
    assert.match(r.kept_note, /有 1 段翻译没成功，保留了原文/);
    assert.equal(dec(host.sent[0].bytes), "EN<你好>\n\n再见");
  });
});

// ---------- the tool, Office and PDF through the real script ----------

const BUILD = String.raw`
import sys, datetime
from docx import Document
from docx.oxml.ns import qn
from docx.oxml import OxmlElement
from pptx import Presentation
from pptx.util import Inches, Pt
from openpyxl import Workbook
try:
    import pymupdf as fitz
except ImportError:
    import fitz
out = sys.argv[1]
d = Document()
d.add_heading('季度报告', 1)
r = d.add_paragraph().add_run('这一段全部加粗。'); r.bold = True
p = d.add_paragraph('普通文字，然后'); r = p.add_run('加粗词'); r.bold = True; p.add_run('，最后是普通文字。')
d.add_paragraph('第一项要点', style='List Bullet')
t = d.add_table(rows=2, cols=2)
t.cell(0, 0).text = '名称'; t.cell(0, 1).text = '数量'; t.cell(1, 0).text = '苹果'; t.cell(1, 1).text = '42'
d.sections[0].header.paragraphs[0].text = '内部资料'
fp = d.sections[0].footer.paragraphs[0]
fp.add_run('第 ')
r = fp.add_run()
for typ, txt in (('begin', None), (None, ' PAGE '), ('separate', None), ('t', '1'), ('end', None)):
    if typ in ('begin', 'separate', 'end'):
        e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), typ)
    elif typ == 't':
        e = OxmlElement('w:t'); e.text = txt
    else:
        e = OxmlElement('w:instrText'); e.text = txt
    r._r.append(e)
fp.add_run(' 页')
d.save(out + '/sample.docx')
pr = Presentation()
s = pr.slides.add_slide(pr.slide_layouts[0])
s.shapes.title.text = '产品发布会'
s.placeholders[1].text = '二〇二六年十一月'
s = pr.slides.add_slide(pr.slide_layouts[1])
s.shapes.title.text = '三个重点'
tf = s.placeholders[1].text_frame
tf.text = '速度更快'
tf.add_paragraph().text = '价格更低'
s.notes_slide.notes_text_frame.text = '这里讲一下背景。'
tb = s.shapes.add_textbox(Inches(1), Inches(5), Inches(3), Inches(1)).text_frame
tb.text = '小字说明'
tb.paragraphs[0].runs[0].font.size = Pt(20)
tb.paragraphs[0].runs[0].font.bold = True
s = pr.slides.add_slide(pr.slide_layouts[5])
s.shapes.title.text = '数据表'
tbl = s.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(6), Inches(1.5)).table
tbl.cell(0, 0).text = '城市'; tbl.cell(0, 1).text = '人口'; tbl.cell(1, 0).text = '上海'; tbl.cell(1, 1).text = '2487'
pr.save(out + '/sample.pptx')
wb = Workbook()
ws = wb.active
ws.title = '销售'
ws['A1'] = '产品'; ws['B1'] = '数量'; ws['C1'] = '日期'
ws['A2'] = '苹果'; ws['B2'] = 10; ws['C2'] = datetime.date(2026, 1, 2)
ws['A3'] = '香蕉'; ws['B3'] = 5
ws['B4'] = '=SUM(B2:B3)'
ws['A5'] = '2026-01-02'
ws['A1'].font = ws['A1'].font.copy(bold=True)
wb.save(out + '/sample.xlsx')
doc = fitz.open()
for n in range(3):
    pg = doc.new_page()
    pg.insert_text((72, 72), 'Chapter %d' % (n + 1), fontsize=20)
    pg.insert_text((72, 120), 'This is the first line of a paragraph that goes on', fontsize=11)
    pg.insert_text((72, 134), 'and continues on the next line of page %d.' % (n + 1), fontsize=11)
    pg.insert_text((72, 300), 'A second paragraph lives further down.', fontsize=11)
doc.save(out + '/sample.pdf')
doc = fitz.open()
pg = doc.new_page()
pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 50, 50), False)
pix.clear_with(200)
pg.insert_image(fitz.Rect(0, 0, 500, 700), pixmap=pix)
doc.save(out + '/scan.pdf')
`;

const INSPECT = String.raw`
import sys, json, zipfile
from docx import Document
from pptx import Presentation
from openpyxl import load_workbook
f = sys.argv[1]
out = {}
if f.endswith('.docx'):
    d = Document(f)
    out['paras'] = [[p.style.name, [[r.text, r.bold] for r in p.runs if r.text]] for p in d.paragraphs]
    out['table'] = [[c.text for c in row.cells] for row in d.tables[0].rows] if d.tables else []
    s = d.sections[0]
    out['header'] = s.header.paragraphs[0].text
    out['footer'] = s.footer.paragraphs[0].text
    out['footer_field'] = 'PAGE' in s.footer._element.xml
elif f.endswith('.pptx'):
    pr = Presentation(f)
    out['slides'] = []
    for sl in pr.slides:
        shapes = []
        for sh in sl.shapes:
            if sh.has_text_frame:
                runs = [r for p in sh.text_frame.paragraphs for r in p.runs]
                shapes.append({'name': sh.name, 'text': sh.text_frame.text, 'sizes': [r.font.size.pt if r.font.size else None for r in runs], 'bold': [r.font.bold for r in runs], 'scale': sh.text_frame._txBody.bodyPr.xml.count('fontScale'), 'layout': sl.slide_layout.name})
            if sh.has_table:
                shapes.append({'table': [[c.text for c in row.cells] for row in sh.table.rows]})
        out['slides'].append({'shapes': shapes, 'notes': sl.notes_slide.notes_text_frame.text if sl.has_notes_slide else None})
elif f.endswith('.xlsx'):
    ws = load_workbook(f).active
    out['title'] = ws.title
    out['cells'] = {c.coordinate: [str(c.value), bool(c.font.b)] for row in ws.iter_rows() for c in row if c.value is not None}
print(json.dumps(out, ensure_ascii=False))
`;

describe("translate_doc on Office files and PDFs (real script, local Python)", { skip: !hasPy && "needs python-docx, python-pptx, openpyxl and PyMuPDF (set DOCTRANS_PY)" }, () => {
  const samples = fs.mkdtempSync(path.join(os.tmpdir(), "doctrans-samples-"));
  if (hasPy) {
    const b = spawnSync(PY, ["-W", "ignore", "-c", BUILD, samples], { encoding: "utf8" });
    if (b.status !== 0) throw new Error(b.stderr);
  }
  const inspect = (bytes, ext) => {
    const f = path.join(samples, "check-" + Math.random().toString(36).slice(2) + "." + ext);
    fs.writeFileSync(f, bytes);
    const r = spawnSync(PY, ["-W", "ignore", "-c", INSPECT, f], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout);
  };
  const run = async (name, args = {}, model = fakeModel(), over = {}) => {
    const m = machine(), host = fakeHost({ files: { f1: { name, bytes: fs.readFileSync(path.join(samples, over.sample || name)) } } });
    const r = await D.translateDoc(ctxOf(host), { file: "f1", ...args }, depsOf(m, model, over.deps || {}));
    return { r, m, host, model, out: host.sent[0]?.bytes };
  };

  test("Word: bold, list, table, header and footer field survive; numbers left alone", async () => {
    const { r, m, out } = await run("sample.docx");
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.file, "sample_EN.docx");
    const d = inspect(out, "docx");
    assert.deepEqual(d.paras[0], ["Heading 1", [["EN<季度报告>", null]]]);
    assert.deepEqual(d.paras[1], ["Normal", [["EN<这一段全部加粗。>", true]]]);
    assert.deepEqual(d.paras[2], ["Normal", [["EN<普通文字，然后加粗词，最后是普通文字。>", null]]]);
    assert.deepEqual(d.paras[3], ["List Bullet", [["EN<第一项要点>", null]]]);
    assert.deepEqual(d.table, [["EN<名称>", "EN<数量>"], ["EN<苹果>", "42"]]);
    assert.equal(d.header, "EN<内部资料>");
    assert.equal(d.footer, "EN<第  页>1");
    assert.equal(d.footer_field, true);
    // two machine runs and a cleanup, which leaves nothing behind
    assert.equal(m.calls.length, 3);
    assert.deepEqual(m.calls[2].commands, ["rm -rf -- '/work/doctrans/abc123'"]);
    assert.ok(!fs.existsSync(path.join(m.work, "doctrans/abc123")));
  });
  test("Word bilingual: each paragraph is followed by its translation in the same style", async () => {
    const d = inspect((await run("sample.docx", { bilingual: true })).out, "docx");
    assert.deepEqual(d.paras.slice(0, 4), [
      ["Heading 1", [["季度报告", null]]], ["Heading 1", [["EN<季度报告>", null]]],
      ["Normal", [["这一段全部加粗。", true]]], ["Normal", [["EN<这一段全部加粗。>", true]]],
    ]);
    assert.deepEqual(d.table[0], ["名称\nEN<名称>", "数量\nEN<数量>"]);
  });
  test("PowerPoint: titles, bullets, notes, table cells; layouts kept; long text shrinks within bounds", async () => {
    const long = { ask: async messages => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(messages[1].content)).map(([k, v]) => [k, "A much longer English rendering of " + v.length + " characters"]))) };
    const { r, out } = await run("sample.pptx", {}, long);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.slides_total, 3);
    assert.ok(r.notes.some(n => /个文本框因为译文变长缩小了字号/.test(n)));
    const p = inspect(out, "pptx");
    const [s1, s2, s3] = p.slides;
    assert.equal(s1.shapes[0].text, "A much longer English rendering of 5 characters");
    assert.equal(s1.shapes[0].layout, "Title Slide");
    assert.equal(s1.shapes[0].scale, 1);
    assert.deepEqual(s2.shapes[1].text.split("\n").length, 2);
    assert.equal(s2.notes, "A much longer English rendering of 8 characters");
    const box = s2.shapes[2];
    assert.deepEqual(box.bold, [true]);
    assert.ok(box.sizes[0] >= 14 && box.sizes[0] < 20, String(box.sizes));
    assert.deepEqual(s3.shapes[1].table[1][1], "2487");
    assert.match(s3.shapes[1].table[0][0], /^A much longer/);
  });
  test("PowerPoint slide range only touches those slides; bilingual adds a line", async () => {
    const { r, out } = await run("sample.pptx", { slides: "2", bilingual: true });
    assert.equal(r.ok, true, JSON.stringify(r));
    const p = inspect(out, "pptx");
    assert.equal(p.slides[0].shapes[0].text, "产品发布会");
    assert.equal(p.slides[1].shapes[0].text, "三个重点\u000bEN<三个重点>");
    assert.equal(p.slides[1].notes, "这里讲一下背景。\u000bEN<这里讲一下背景。>");
  });
  test("Excel: text cells translated, numbers, dates, formulas, bold and the sheet name untouched", async () => {
    const { r, out } = await run("sample.xlsx");
    assert.equal(r.ok, true, JSON.stringify(r));
    const x = inspect(out, "xlsx");
    assert.equal(x.title, "销售");
    assert.deepEqual(x.cells.A1, ["EN<产品>", true]);
    assert.deepEqual(x.cells.B2, ["10", false]);
    assert.deepEqual(x.cells.C2, ["2026-01-02 00:00:00", false]);
    assert.deepEqual(x.cells.B4, ["=SUM(B2:B3)", false]);
    assert.deepEqual(x.cells.A5, ["2026-01-02", false]);
  });
  test("PDF: pages become a Word file with page headings; a range limits the pages; Markdown on request", async () => {
    let { r, out } = await run("sample.pdf", { pages: "2-3", to: "中文" });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.file, "sample_中文.docx");
    assert.equal(r.pages_total, 3); assert.equal(r.pages_done, 2);
    const d = inspect(out, "docx");
    assert.deepEqual(d.paras.map(p => p[0]), ["Title", "Heading 2", "Heading 3", "Normal", "Normal", "Heading 2", "Heading 3", "Normal", "Normal"]);
    assert.equal(d.paras[1][1][0][0], "第 2 页");
    assert.equal(d.paras[3][1][0][0], "EN<This is the first line of a paragraph that goes on and continues on the next line of page 2.>");
    ({ r, out } = await run("sample.pdf", { format: "md", bilingual: true }));
    assert.equal(r.file, "sample_双语_中文.md");
    assert.ok(dec(out).includes("## 第 1 页\n\n> Chapter 1\n\n### EN<Chapter 1>\n"));
  });
  test("a scanned PDF stops with a clear message before any translation", async () => {
    const model = fakeModel();
    const { r, m } = await run("scan.pdf", {}, model);
    assert.equal(r.ok, false); assert.equal(r.scanned, true);
    assert.match(r.error, /扫描出来的图片，没有文字层/);
    assert.equal(model.calls.length, 0);
    assert.equal(m.calls.at(-1).commands[0], "rm -rf -- '/work/doctrans/abc123'");
  });
  test("a broken file is reported in plain words", async () => {
    const m = machine(), host = fakeHost({ files: { f1: { name: "坏.docx", bytes: enc("not a zip") } } });
    const r = await D.translateDoc(ctxOf(host), { file: "f1" }, depsOf(m, fakeModel()));
    assert.equal(r.ok, false);
    assert.match(r.error, /读取文件时出错了：文件打不开：不是有效的 Office 文件/);
  });
  test("a file-box file is downloaded inside the machine (once), and a big result would go back through the box", async () => {
    const m = machine();
    fs.copyFileSync(path.join(samples, "sample.pptx"), path.join(m.tmp, "boxed-x12"));
    const host = fakeHost();
    const r = await D.translateDoc(ctxOf(host), { file: "x12" }, depsOf(m, fakeModel()));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.file, "大报告_EN.pptx");
    assert.ok(m.calls[0].commands[0].includes("[ -s 'src.pptx' ] || cp "));
    assert.equal(m.calls[0].files.length, 0);
    assert.ok(m.calls[1].commands[2].includes("cp '/work/doctrans/abc123/out/result.pptx'"));
  });
});
