// Offline tests for the five document skills: validation and Chinese errors, page-range parsing, bash syntax of every
// generated command, hostile strings (a `touch PWNED` canary must never appear), and real execution of whatever this
// machine can run: pymupdf for the PDF tools, LibreOffice and pandoc for doc-to-pdf, stand-in modules for pdf2docx,
// markitdown and ocrmypdf. Set TEST_PYTHON to a python with pymupdf, Pillow and python-docx.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import docToPdf from "../src/skills/doc-to-pdf.ts";
import pdfTools, { parseRanges } from "../src/skills/pdf-tools.ts";
import pdfToDocx from "../src/skills/pdf-to-docx.ts";
import pdfToMd from "../src/skills/pdf-to-markdown.ts";
import pdfOcr, { MAX_PAGES } from "../src/skills/pdf-ocr.ts";

const SKILLS = [docToPdf, pdfTools, pdfToDocx, pdfToMd, pdfOcr];
const f = (...names) => names.map(name => ({ name }));
const HOSTILE = `a'b "c" $(touch PWNED) \`touch PWNED\` ;touch PWNED; 奶蛙 \\ 空 格`;
const bashOk = cmds => { for (const c of cmds) { const r = spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + "\n" + c.slice(0, 300)); } };
const throwsCn = (fn, re) => assert.throws(fn, e => e instanceof Error && /[一-鿿]/.test(e.message) && (!re || re.test(e.message)));

const PY = process.env.TEST_PYTHON || "python3";
const probe = code => { try { return spawnSync(PY, ["-c", code], { stdio: "ignore" }).status === 0; } catch { return false; } };
const HAS_FITZ = probe("import fitz") || probe("import pymupdf");
const HAS_PIL = probe("import PIL");
const HAS_DOCX = probe("import docx");
const has = cmd => spawnSync("sh", ["-c", "command -v " + cmd], { stdio: "ignore" }).status === 0;
const HAS_SOFFICE = has("soffice") || has("libreoffice");
const HAS_PANDOC = has("pandoc");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skills-docs-"));
const here = path.dirname(new URL(import.meta.url).pathname);
const run = (cmds, cwd, env = {}) => cmds.map(c => spawnSync("bash", ["-c", "set -e -o pipefail\n" + c], { cwd, encoding: "utf8", env: { ...process.env, PYTHON: PY, ...env } }));
const stdoutOf = rs => rs.map(r => r.stdout);
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const noCanary = (...dirs) => { for (const d of dirs) if (d === process.cwd()) assert.ok(!fs.existsSync(path.join(d, "PWNED")), "canary in cwd"); else assert.deepEqual(walk(d).filter(p => path.basename(p) === "PWNED"), [], "canary file appeared in " + d); };

// A small PDF with Chinese text and a second landscape one, made with pymupdf.
function makePdfs(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const code = `
import fitz, sys
d = fitz.open()
for i in range(6):
    p = d.new_page()
    p.insert_text((72, 100), "Page %d hello world" % (i + 1), fontsize=14)
    p.insert_text((72, 140), "中文测试 第%d页" % (i + 1), fontname="china-s", fontsize=14)
d.set_metadata({"title": "测试文档"})
d.save(sys.argv[1] + "/six.pdf")
e = fitz.open()
for i in range(3):
    p = e.new_page(width=842, height=595)
    p.insert_text((72, 100), "B%d" % i, fontsize=20)
e.save(sys.argv[1] + "/land.pdf")
b = fitz.open()
b.new_page()
b.save(sys.argv[1] + "/blank.pdf")
`;
  assert.equal(spawnSync(PY, ["-c", code, dir], { encoding: "utf8" }).status, 0);
  return { six: path.join(dir, "six.pdf"), land: path.join(dir, "land.pdf"), blank: path.join(dir, "blank.pdf") };
}

/** Runs a skill in a fresh directory with the inputs copied to ./in under the given names. */
function exec(skill, args, inputs, env = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "in"));
  for (const [name, src] of Object.entries(inputs)) fs.copyFileSync(src, path.join(dir, "in", name));
  const cmds = skill.commands(args, f(...Object.keys(inputs)));
  const rs = run(cmds, dir, env);
  const last = rs[rs.length - 1];
  return { dir, rs, last, out: fs.existsSync(path.join(dir, "out")) ? fs.readdirSync(path.join(dir, "out")) : [], report: skill.report(stdoutOf(rs)), stderr: rs.map(r => r.stderr).join("\n") };
}
const pdfInfo = file => {
  const r = spawnSync(PY, ["-c", "import fitz,sys,json;d=fitz.open(sys.argv[1]);e=bool(d.needs_pass);print(json.dumps({'n':0 if e else len(d),'enc':e,'rot':[] if e else [p.rotation for p in d],'text':'' if e else d[0].get_text()}))", file], { encoding: "utf8" });
  return JSON.parse(r.stdout);
};

describe("shape of the skills", () => {
  for (const s of SKILLS) {
    test(s.name + ": metadata", () => {
      assert.match(s.name, /^[a-z0-9-]+$/);
      assert.match(s.title, /[一-鿿]/);
      assert.match(s.when, /[一-鿿]/);
      for (const [k, a] of Object.entries(s.args || {})) assert.match(a.description, /[一-鿿]/, k);
      for (const r of s.required || []) assert.ok(s.args[r], r);
      assert.equal(typeof s.report, "function");
      assert.ok(s.packs?.length, "declares its pack");
      assert.ok(s.files && s.files.min >= 1 && s.files.extensions?.length);
    });
  }
  test("packs are real names and the ocr one is separate", async () => {
    const { PACKS } = await import("../src/packs.ts");
    for (const s of SKILLS) for (const p of s.packs) assert.ok(PACKS[p], p);
    assert.deepEqual(pdfOcr.packs, ["ocr"]);
    assert.ok(pdfTools.packs.includes("office"));
  });
  test("the OCR page limit is stated and fits the time limit", () => {
    assert.ok(MAX_PAGES >= 20 && MAX_PAGES <= 120, String(MAX_PAGES));
    assert.match(pdfOcr.when, new RegExp(String(MAX_PAGES)));
    assert.ok(pdfOcr.timeoutSeconds <= 1700);
  });
});

describe("page ranges", () => {
  const ok = (s, want) => assert.deepEqual(parseRanges(s).map(r => [r.a, r.b]), want, s);
  test("good ones", () => {
    ok("1-3,7,10-", [[1, 3], [7, 7], [10, null]]);
    ok(" 2 ", [[2, 2]]);
    ok("1，3、5-6", [[1, 1], [3, 3], [5, 6]]);
    ok("第1-3页", [[1, 3]]);
    ok("1 - 3 , 7", [[1, 3], [7, 7]]);
    ok("３－５", [[3, 5]]);
    ok("4到6", [[4, 6]]);
    ok("5,1-2", [[5, 5], [1, 2]]);
    ok("8-end", [[8, null]]);
  });
  test("bad ones are refused in Chinese", () => {
    for (const s of ["", "  ", "0", "0-3", "3-1", "a", "1-b", "1--3", "-3", "1.5", "1;;;;;x", "1-2-3", "9999999", "$(touch PWNED)", "1\u0000", "1\n2x"]) {
      throwsCn(() => parseRanges(s), /页码/);
    }
    throwsCn(() => parseRanges(Array.from({ length: 201 }, (_, i) => i + 1).join(",")), /200/);
  });
});

describe("argument validation (Chinese errors)", () => {
  const T = (skill, args, files, re) => throwsCn(() => skill.commands(args, files), re);
  test("pdf-tools", () => {
    T(pdfTools, {}, f("a.pdf"), /op/);
    T(pdfTools, { op: "shred" }, f("a.pdf"), /op/);
    T(pdfTools, { op: "merge" }, f("a.pdf"), /2 个以上/);
    T(pdfTools, { op: "merge" }, f("a.pdf", "b.png"), /只收 PDF/);
    T(pdfTools, { op: "info" }, f("a.pdf", "b.pdf"), /1 个 PDF/);
    T(pdfTools, { op: "info" }, f("a.png"), /PDF/);
    T(pdfTools, { op: "from_images" }, f("a.pdf"), /图片/);
    T(pdfTools, { op: "split" }, f("a.pdf"), /选且只选一种/);
    T(pdfTools, { op: "split", pages: "1-2", every: 3 }, f("a.pdf"), /选且只选一种/);
    T(pdfTools, { op: "split", every: 0 }, f("a.pdf"), /1 到 1000/);
    T(pdfTools, { op: "extract" }, f("a.pdf"), /pages/);
    T(pdfTools, { op: "delete", pages: "3-1" }, f("a.pdf"), /页码/);
    T(pdfTools, { op: "rotate" }, f("a.pdf"), /angle/);
    T(pdfTools, { op: "rotate", angle: 45 }, f("a.pdf"), /90/);
    T(pdfTools, { op: "compress", level: "tiny" }, f("a.pdf"), /screen/);
    T(pdfTools, { op: "to_images", dpi: 5 }, f("a.pdf"), /36/);
    T(pdfTools, { op: "to_images", dpi: 1200 }, f("a.pdf"), /600/);
    T(pdfTools, { op: "to_images", image_format: "bmp" }, f("a.pdf"), /png/);
    T(pdfTools, { op: "encrypt" }, f("a.pdf"), /password/);
    T(pdfTools, { op: "encrypt", password: "x\ny" }, f("a.pdf"), /控制字符/);
    T(pdfTools, { op: "decrypt" }, f("a.pdf"), /password/);
    T(pdfTools, { op: "watermark" }, f("a.pdf"), /text/);
    T(pdfTools, { op: "watermark", text: "字".repeat(41) }, f("a.pdf"), /40/);
    T(pdfTools, { op: "page_numbers", number_style: "第页" }, f("a.pdf"), /\{n\}/);
    T(pdfTools, { op: "page_numbers", position: "middle" }, f("a.pdf"), /位置/);
    T(pdfTools, { op: "page_numbers", font_size: 99 }, f("a.pdf"), /字号/);
    T(pdfTools, { op: "from_images", margin_mm: 99 }, f("a.png"), /页边距/);
    T(pdfTools, { op: "from_images", page_size: "letter" }, f("a.png"), /a4/);
  });
  test("doc-to-pdf", () => {
    T(docToPdf, {}, f("a.zip"), /不是能转的格式/);
    T(docToPdf, {}, f("a.pdf"), /不是能转的格式/);
    T(docToPdf, { page_size: "huge" }, f("a.png"), /a4/);
    T(docToPdf, { margin_mm: -1 }, f("a.png"), /页边距/);
    T(docToPdf, { margin_mm: 2.5 }, f("a.png"), /页边距/);
  });
  test("pdf-to-docx", () => {
    T(pdfToDocx, {}, f("a.pdf", "b.pdf"), /1 个/);
    T(pdfToDocx, {}, f("a.docx"), /PDF/);
    T(pdfToDocx, { pages: "x" }, f("a.pdf"), /页码/);
    T(pdfToDocx, { password: "a\nb" }, f("a.pdf"), /控制字符/);
  });
  test("pdf-to-markdown", () => {
    T(pdfToMd, {}, f("a.png"), /不是能转的格式/);
    T(pdfToMd, {}, f("a.doc"), /doc-to-pdf/);
    T(pdfToMd, { pages: "1" }, f("a.docx"), /只对 PDF/);
    T(pdfToMd, { pages: "0" }, f("a.pdf"), /页码/);
    T(pdfToMd, { password: "x" }, f("a.docx"), /只对 PDF/);
  });
  test("pdf-ocr", () => {
    T(pdfOcr, {}, f("a.pdf", "b.pdf"), /1 个 PDF/);
    T(pdfOcr, {}, f("a.pdf", "b.png"), /分开/);
    T(pdfOcr, {}, f("a.docx"), /不是能识别/);
    T(pdfOcr, { lang: "chi_sim eng" }, f("a.pdf"), /语言/);
    T(pdfOcr, { lang: "eng;rm -rf" }, f("a.pdf"), /语言/);
    T(pdfOcr, { lang: "a+b+c+d+e+f" }, f("a.pdf"), /语言/);
    T(pdfOcr, { pages: "1-2" }, f("a.png"), /只对 PDF/);
    T(pdfOcr, { pages: "2-1" }, f("a.pdf"), /页码/);
  });
});

describe("bash syntax, hostile strings in every field", () => {
  test("pdf-tools, every op", () => {
    const base = f(HOSTILE + ".pdf");
    for (const a of [
      { op: "info" }, { op: "merge", output_name: HOSTILE }, { op: "split", pages: "1-3,7,10-" }, { op: "split", every: 4 }, { op: "split", each_page: true },
      { op: "extract", pages: "2,1" }, { op: "delete", pages: "2" }, { op: "rotate", angle: 90, pages: "1" }, { op: "compress", level: "screen" },
      { op: "to_images", dpi: 200, image_format: "jpg", pages: "1-2" }, { op: "encrypt", password: HOSTILE }, { op: "decrypt", password: HOSTILE },
      { op: "watermark", text: HOSTILE.slice(0, 40), pages: "1-2" }, { op: "page_numbers", number_style: "第 {n} 页 '$(id)' `x`", position: "top_right" },
    ]) {
      const files = a.op === "merge" ? f(HOSTILE + ".pdf", "b.pdf") : base;
      bashOk(pdfTools.commands(a, files));
    }
    bashOk(pdfTools.commands({ op: "from_images", output_name: HOSTILE }, f(HOSTILE + ".png", "b.jpg")));
  });
  test("doc-to-pdf", () => {
    bashOk(docToPdf.commands({}, f(HOSTILE + ".docx")));
    bashOk(docToPdf.commands({ merge: true, output_name: HOSTILE, page_size: "fit", margin_mm: 0, separate_images: true, fit_width: false }, f(HOSTILE + ".xlsx", "b.md", "c.png", "d.txt", "e.html")));
  });
  test("pdf-to-docx, pdf-to-markdown, pdf-ocr", () => {
    bashOk(pdfToDocx.commands({ pages: "1-2", password: HOSTILE }, f(HOSTILE + ".pdf")));
    bashOk(pdfToMd.commands({ pages: "1-2", also_text: true, password: HOSTILE }, f(HOSTILE + ".pdf")));
    bashOk(pdfToMd.commands({}, f(HOSTILE + ".pptx")));
    bashOk(pdfOcr.commands({ lang: "chi_sim+eng", deskew: true, force: true, pages: "1,3-4" }, f(HOSTILE + ".pdf")));
    bashOk(pdfOcr.commands({}, f(HOSTILE + ".png", "b.jpg")));
  });
  test("a hostile string reaches the script only as JSON inside one quoted word", () => {
    const cmds = pdfTools.commands({ op: "watermark", text: "x'$(touch PWNED)'`touch PWNED`" }, f("a.pdf"));
    assert.ok(cmds.length >= 4 && cmds.every(c => new TextEncoder().encode(c).length < 16000), "script is split into small commands");
    const c = cmds[cmds.length - 1];
    const m = c.match(/\nPYTHONUTF8=1 "\$PY" \.skill_pdf_tools\.py (.*)$/s);
    assert.ok(m);
    const word = spawnSync("bash", ["-c", "printf '%s' " + m[1]], { encoding: "utf8" }).stdout;
    assert.equal(JSON.parse(word).text, "x'$(touch PWNED)'`touch PWNED`");
  });
});

describe("pdf-tools, executed", { skip: !HAS_FITZ && "no pymupdf" }, () => {
  const dir = tmp();
  const pdfs = makePdfs(dir);
  const X = (args, inputs = { "a.pdf": pdfs.six }) => exec(pdfTools, args, inputs);

  test("info: pages, size, title, text layer", () => {
    const r = X({ op: "info" });
    assert.equal(r.last.status, 0, r.stderr);
    assert.equal(r.report.信息.页数, 6);
    assert.equal(r.report.信息.标题, "测试文档");
    assert.match(r.report.信息.页面尺寸, /A4/);
    assert.match(r.report.信息.文字层, /^有/);
    const b = X({ op: "info" }, { "b.pdf": pdfs.blank });
    assert.match(b.report.信息.文字层, /^没有/);
    assert.match(b.report.信息.文字层, /pdf-ocr/);
  });
  test("merge keeps the given order", () => {
    const r = X({ op: "merge", output_name: "合 并" }, { "land.pdf": pdfs.land, "six.pdf": pdfs.six });
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out, ["合_并.pdf"]);
    const info = pdfInfo(path.join(r.dir, "out", r.out[0]));
    assert.equal(info.n, 9);
    assert.match(info.text, /B0/);
    assert.match(r.report.说明[0], /land\.pdf.*→.*six\.pdf/);
  });
  test("split by ranges, by N, per page", () => {
    const a = X({ op: "split", pages: "1-3,6,5-" });
    assert.equal(a.last.status, 0, a.stderr);
    assert.deepEqual(a.out.sort(), ["a_第1-3页.pdf", "a_第5-6页.pdf", "a_第6页.pdf"]);
    const b = X({ op: "split", every: 4 });
    assert.deepEqual(b.out.map(n => pdfInfo(path.join(b.dir, "out", n)).n).sort(), [2, 4]);
    const c = X({ op: "split", each_page: true }, { "l.pdf": pdfs.land });
    assert.equal(c.out.length, 3);
  });
  test("extract follows the written order; delete removes; both refuse bad pages", () => {
    const e = X({ op: "extract", pages: "5,1-2" });
    assert.equal(e.last.status, 0, e.stderr);
    const info = pdfInfo(path.join(e.dir, "out", e.out[0]));
    assert.equal(info.n, 3);
    assert.match(info.text, /Page 5/);
    const d = X({ op: "delete", pages: "2-5" });
    assert.equal(pdfInfo(path.join(d.dir, "out", d.out[0])).n, 2);
    const all = X({ op: "delete", pages: "1-" });
    assert.equal(all.last.status, 1);
    assert.match(all.last.stderr, /错误：.*全删光/);
    const far = X({ op: "extract", pages: "7" });
    assert.match(far.last.stderr, /错误：这份 PDF 只有 6 页/);
    assert.deepEqual(far.out, []);
  });
  test("rotate", () => {
    const r = X({ op: "rotate", angle: -90, pages: "1,3" });
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(pdfInfo(path.join(r.dir, "out", r.out[0])).rot, [270, 0, 270, 0, 0, 0]);
  });
  test("compress reports before and after, or says it could not shrink", () => {
    const r = X({ op: "compress", level: "screen" });
    assert.equal(r.last.status, 0, r.stderr);
    const txt = JSON.stringify(r.report);
    assert.match(txt, /原来.*(现在|最小)/);
  });
  test("to_images: dpi, format, page range", () => {
    const r = X({ op: "to_images", dpi: 50, image_format: "jpg", pages: "2-3" });
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out, ["a_第2页.jpg", "a_第3页.jpg"]);
    assert.equal(fs.readFileSync(path.join(r.dir, "out", r.out[0])).subarray(0, 2).toString("hex"), "ffd8");
    const p = X({ op: "to_images", dpi: 36 }, { "l.pdf": pdfs.land });
    assert.equal(p.out.length, 3);
    assert.equal(fs.readFileSync(path.join(p.dir, "out", p.out[0])).subarray(1, 4).toString(), "PNG");
  });
  test("encrypt and decrypt round trip with a hostile password; the password is never echoed", () => {
    const pw = "p'w\"$(touch PWNED)`touch PWNED`;é中";
    const e = X({ op: "encrypt", password: pw });
    assert.equal(e.last.status, 0, e.stderr);
    const enc = path.join(e.dir, "out", e.out[0]);
    assert.equal(pdfInfo(enc).enc, true);
    assert.ok(!e.rs.map(r => r.stdout + r.stderr).join("").includes(pw));
    const wrong = exec(pdfTools, { op: "decrypt", password: "wrong" + pw }, { "e.pdf": enc });
    assert.equal(wrong.last.status, 1);
    assert.match(wrong.last.stderr, /密码不对/);
    assert.ok(!wrong.rs.map(r => r.stdout + r.stderr).join("").includes(pw));
    const none = exec(pdfTools, { op: "extract", pages: "1" }, { "e.pdf": enc });
    assert.match(none.last.stderr, /有打开密码/);
    const good = exec(pdfTools, { op: "decrypt", password: pw }, { "e.pdf": enc });
    assert.equal(good.last.status, 0, good.stderr);
    const dec = pdfInfo(path.join(good.dir, "out", good.out[0]));
    assert.equal(dec.enc, false);
    assert.equal(dec.n, 6);
    const viaOther = exec(pdfTools, { op: "rotate", angle: 90, password: pw }, { "e.pdf": enc });
    assert.equal(viaOther.last.status, 0, viaOther.stderr);
    assert.equal(pdfInfo(path.join(viaOther.dir, "out", viaOther.out[0])).enc, false);
    noCanary(e.dir, wrong.dir, good.dir, process.cwd());
  });
  test("a PDF that is not a PDF is refused in Chinese", () => {
    const junk = path.join(dir, "junk.pdf");
    fs.writeFileSync(junk, "not a pdf");
    const r = X({ op: "info" }, { "j.pdf": junk });
    assert.equal(r.last.status, 1);
    assert.match(r.last.stderr, /错误：打不开/);
  });
  test("hostile file names do not run anything", () => {
    const r = X({ op: "watermark", text: "x'$(touch PWNED)'`touch PWNED`" }, { [HOSTILE + ".pdf"]: pdfs.six });
    assert.equal(r.last.status, 0, r.stderr);
    noCanary(r.dir, process.cwd());
    assert.equal(r.out.length, 1);
  });
  test("watermark and page numbers are drawn (Chinese works) and keep the page count", { skip: !HAS_PIL && "no Pillow" }, () => {
    const w = X({ op: "watermark", text: "内部资料", pages: "1-2" });
    assert.equal(w.last.status, 0, w.stderr);
    const out = path.join(w.dir, "out", w.out[0]);
    const imgs = spawnSync(PY, ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);print([len(p.get_images()) for p in d])", out], { encoding: "utf8" }).stdout.trim();
    assert.equal(imgs, "[1, 1, 0, 0, 0, 0]");
    const n = exec(pdfTools, { op: "page_numbers", number_style: "第 {n} 页，共 {total} 页", position: "bottom_right", start: 1 }, { "w.pdf": out });
    assert.equal(n.last.status, 0, n.stderr);
    assert.equal(pdfInfo(path.join(n.dir, "out", n.out[0])).n, 6);
    const rot = exec(pdfTools, { op: "rotate", angle: 90 }, { "w.pdf": out });
    const rn = exec(pdfTools, { op: "page_numbers" }, { "r.pdf": path.join(rot.dir, "out", rot.out[0]) });
    assert.equal(rn.last.status, 0, rn.stderr);
  });
  test("from_images: several pictures become one PDF, A4 or fit", { skip: !HAS_PIL && "no Pillow" }, () => {
    const imgDir = tmp();
    spawnSync(PY, ["-c", "from PIL import Image;import sys;d=sys.argv[1];Image.new('RGB',(1200,800),(200,220,255)).save(d+'/a.png');Image.new('RGBA',(400,900),(255,0,0,128)).save(d+'/b.png');Image.new('RGB',(900,600),(1,2,3)).save(d+'/c.jpg')", imgDir]);
    const inputs = { "1.png": path.join(imgDir, "a.png"), "2.png": path.join(imgDir, "b.png"), "3.jpg": path.join(imgDir, "c.jpg") };
    const a = exec(pdfTools, { op: "from_images", output_name: "相册" }, inputs);
    assert.equal(a.last.status, 0, a.stderr);
    assert.deepEqual(a.out, ["相册.pdf"]);
    assert.equal(pdfInfo(path.join(a.dir, "out", "相册.pdf")).n, 3);
    const sizes = spawnSync(PY, ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);print([(round(p.rect.width),round(p.rect.height)) for p in d])", path.join(a.dir, "out", "相册.pdf")], { encoding: "utf8" }).stdout.trim();
    assert.equal(sizes, "[(842, 595), (595, 842), (842, 595)]");
    const b = exec(pdfTools, { op: "from_images", page_size: "fit" }, { "1.png": path.join(imgDir, "a.png") });
    assert.equal(b.last.status, 0, b.stderr);
  });
});

describe("doc-to-pdf, executed", { skip: !(HAS_FITZ && HAS_SOFFICE && HAS_DOCX && HAS_PIL) && "needs pymupdf, Pillow, python-docx and LibreOffice" }, () => {
  const dir = tmp();
  const prof = path.join(dir, "lo-profile");
  const env = { LO_PROFILE: prof };
  const make = (name, body) => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p; };
  const docx = path.join(dir, "cn.docx");
  spawnSync(PY, ["-c", "from docx import Document;import sys;d=Document();d.add_heading('季度报告',1);d.add_paragraph('这是一份中文文档，检查汉字显示。');d.save(sys.argv[1])", docx]);
  const gbk = path.join(dir, "gbk.txt");
  fs.writeFileSync(gbk, Buffer.from("d6d0cec4b2e2cad4", "hex"));   // 中文测试 in GB18030
  const html = make("p.html", "<html><body><h1>标题</h1><p>段落中文</p></body></html>");
  const png = path.join(dir, "i.png");
  spawnSync(PY, ["-c", "from PIL import Image;import sys;Image.new('RGB',(600,400),(10,200,100)).save(sys.argv[1])", png]);
  const text = p => spawnSync(PY, ["-c", "import fitz,sys;d=fitz.open(sys.argv[1]);print(''.join(x.get_text() for x in d))", p], { encoding: "utf8" }).stdout;

  test("Word, GBK text and HTML each become their own PDF with Chinese text", () => {
    const r = exec(docToPdf, {}, { "cn.docx": docx, "gbk.txt": gbk, "p.html": html }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out.sort(), ["cn.pdf", "gbk.pdf", "p.pdf"]);
    assert.match(text(path.join(r.dir, "out", "cn.pdf")), /季度报告/);
    assert.match(text(path.join(r.dir, "out", "gbk.pdf")), /中文测试/);
    assert.match(text(path.join(r.dir, "out", "p.pdf")), /段落中文/);
    assert.equal(r.report.成品.length, 3);
  });
  test("merge: given order, images in the middle, one file", () => {
    const r = exec(docToPdf, { merge: true, output_name: "全 部" }, { "cn.docx": docx, "i.png": png, "gbk.txt": gbk }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out, ["全_部.pdf"]);
    const t = text(path.join(r.dir, "out", "全_部.pdf"));
    assert.ok(t.indexOf("季度报告") >= 0 && t.indexOf("季度报告") < t.indexOf("中文测试"));
    assert.equal(pdfInfo(path.join(r.dir, "out", "全_部.pdf")).n, 3);
  });
  test("a file LibreOffice cannot open fails that file only", () => {
    const junk = make("bad.docx", Buffer.concat([Buffer.from("PK\u0003\u0004"), Buffer.alloc(300, 7)]));
    const r = exec(docToPdf, {}, { "bad.docx": junk, "i.png": png }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out, ["i.pdf"]);
    assert.match(JSON.stringify(r.report.说明), /没转成：bad\.docx/);
    const none = exec(docToPdf, {}, { "bad.docx": junk }, env);
    assert.equal(none.last.status, 1);
    assert.match(none.last.stderr, /没有一个文件转成功/);
  });
  test("Markdown: through pandoc", { skip: !HAS_PANDOC && "no pandoc" }, () => {
    const md = make("n.md", "# 项目说明\n\n这是**加粗**。\n\n| 列一 | 列二 |\n|---|---|\n| 甲 | 乙 |\n");
    const r = exec(docToPdf, {}, { "n.md": md }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.match(text(path.join(r.dir, "out", "n.pdf")), /项目说明/);
  });
  test("hostile names and output name run nothing", () => {
    const r = exec(docToPdf, { merge: true, output_name: HOSTILE }, { [HOSTILE + ".png"]: png, "b.png": png }, env);
    assert.equal(r.last.status, 0, r.stderr);
    noCanary(r.dir, process.cwd());
    assert.equal(r.out.length, 1);
  });
  test("a wide xlsx gets one page width unless told not to", () => {
    const x = path.join(dir, "wide.xlsx");
    const code = `
import zipfile, sys
cols = lambda n: "".join(chr(65 + n // 26 - 1) if n >= 26 else "") + chr(65 + n % 26)
rows = "".join('<row r="%d">%s</row>' % (r, "".join('<c r="%s%d" t="inlineStr"><is><t>数据%d_%d</t></is></c>' % (cols(c), r, r, c) for c in range(40))) for r in range(1, 30))
sheet = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:AN29"/><sheetData>' + rows + '</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>'
z = zipfile.ZipFile(sys.argv[1], "w")
z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
z.writestr("xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="表" sheetId="1" r:id="rId1"/></sheets></workbook>')
z.writestr("xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>')
z.writestr("xl/worksheets/sheet1.xml", sheet)
z.close()
`;
    assert.equal(spawnSync(PY, ["-c", code, x]).status, 0);
    const fit = exec(docToPdf, {}, { "wide.xlsx": x }, env);
    assert.equal(fit.last.status, 0, fit.stderr);
    const plain = exec(docToPdf, { fit_width: false }, { "wide.xlsx": x }, env);
    assert.equal(plain.last.status, 0, plain.stderr);
    const nFit = pdfInfo(path.join(fit.dir, "out", "wide.pdf")).n, nPlain = pdfInfo(path.join(plain.dir, "out", "wide.pdf")).n;
    assert.ok(nFit < nPlain, nFit + " vs " + nPlain);
    assert.match(fit.report.成品[0], /一整宽/);
  });
});

describe("pdf-to-docx, pdf-to-markdown, pdf-ocr: control flow with stand-in tools", { skip: !(HAS_FITZ && HAS_DOCX) && "needs pymupdf and python-docx" }, () => {
  const dir = tmp();
  const pdfs = makePdfs(dir);
  const stubs = path.join(dir, "stubs");
  fs.mkdirSync(stubs);
  fs.writeFileSync(path.join(stubs, "pdf2docx.py"), `import fitz
from docx import Document
class Converter:
    def __init__(self, p, password=None): self.d = fitz.open(p)
    def convert(self, out, start=0, end=None, pages=None):
        doc = Document()
        for i in (pages if pages is not None else range(len(self.d))): doc.add_paragraph(self.d[i].get_text())
        doc.save(out)
    def close(self): pass
`);
  fs.writeFileSync(path.join(stubs, "markitdown.py"), `class R:
    def __init__(s, t): s.text_content = t
class MarkItDown:
    def __init__(self, **k): pass
    def convert(self, p):
        if p.endswith(".pdf"): return R("")
        from docx import Document
        return R("\\n\\n".join("# " + x.text for x in Document(p).paragraphs))
`);
  fs.writeFileSync(path.join(stubs, "ocrmypdf"), `#!/usr/bin/env python3
import sys, shutil
a = sys.argv[1:]
open(a[a.index("--sidecar") + 1], "w").write("Hello 你 好\\f第二页 text\\f")
open("ocr-args.txt", "w").write(" ".join(a))
shutil.copyfile(a[-2], a[-1])
`, { mode: 0o755 });
  const env = { PYTHONPATH: stubs, PATH: stubs + path.delimiter + process.env.PATH };
  const langStub = has("tesseract");

  test("pdf-to-docx: page range, report, and no-text-layer warning", () => {
    const r = exec(pdfToDocx, { pages: "2-3" }, { "a.pdf": pdfs.six }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out, ["a.docx"]);
    assert.match(r.report.成品, /转了 2 页（共 6 页）/);
    const blank = exec(pdfToDocx, {}, { "b.pdf": pdfs.blank }, env);
    assert.equal(blank.last.status, 0, blank.stderr);
    assert.equal(blank.report.没有文字层, true);
    assert.match(JSON.stringify(blank.report.说明), /pdf-ocr/);
    const far = exec(pdfToDocx, { pages: "9" }, { "a.pdf": pdfs.six }, env);
    assert.match(far.last.stderr, /错误：这份 PDF 只有 6 页/);
  });
  test("pdf-to-markdown: pymupdf fallback when markitdown is empty, plain text, char count", () => {
    const r = exec(pdfToMd, { also_text: true, pages: "1-2" }, { "a.pdf": pdfs.six }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out.sort(), ["a.md", "a.txt"]);
    assert.ok(r.report.字符数 > 20);
    assert.match(r.report.成品[0], /pymupdf/);
    const md = fs.readFileSync(path.join(r.dir, "out", "a.md"), "utf8");
    assert.match(md, /中文测试/);
    assert.ok(!/Page 3/.test(md), "only the chosen pages");
    const blank = exec(pdfToMd, {}, { "b.pdf": pdfs.blank }, env);
    assert.equal(blank.last.status, 1);
    assert.match(blank.last.stderr, /pdf-ocr/);
  });
  test("pdf-ocr: skips refused page counts, passes the options through, cleans the text", { skip: !langStub && "no tesseract" }, () => {
    const r = exec(pdfOcr, { lang: "eng", deskew: true, pages: "2-3" }, { "a.pdf": pdfs.six }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.deepEqual(r.out.sort(), ["a_可搜索.pdf", "a_识别文字.txt"]);
    const args = fs.readFileSync(path.join(r.dir, "ocr-args.txt"), "utf8");
    assert.match(args, /-l eng --skip-text --output-type pdf --jobs 1 --optimize 0 --sidecar \S+ --deskew --pages 2,3 /);
    assert.equal(fs.readFileSync(path.join(r.dir, "out", "a_识别文字.txt"), "utf8"), "Hello 你好\n\n第二页 text\n");
    const missing = exec(pdfOcr, { lang: "chi_sim+eng" }, { "a.pdf": pdfs.six }, env);
    if (!probeLang("chi_sim")) assert.match(missing.last.stderr, /没有语言包 chi_sim/);
  });
  test("pdf-ocr: refuses more pages than fit in the time limit, and says the limit", { skip: !langStub && "no tesseract" }, () => {
    const big = path.join(dir, "big.pdf");
    assert.equal(spawnSync(PY, ["-c", "import fitz,sys;d=fitz.open();[d.new_page() for _ in range(int(sys.argv[2]))];d.save(sys.argv[1])", big, String(MAX_PAGES + 5)]).status, 0);
    const r = exec(pdfOcr, { lang: "eng" }, { "big.pdf": big }, env);
    assert.equal(r.last.status, 1);
    assert.match(r.last.stderr, new RegExp("错误：要识别 " + (MAX_PAGES + 5) + " 页，这个技能单次限时 15 分钟"));
    assert.match(r.last.stderr, new RegExp("最多识别约 " + MAX_PAGES + " 页"));
    assert.deepEqual(r.out, []);
    const part = exec(pdfOcr, { lang: "eng", pages: "1-3" }, { "big.pdf": big }, env);
    assert.equal(part.last.status, 0, part.stderr);
  });
  test("pdf-ocr: pictures become one PDF first", { skip: !(langStub && HAS_PIL) && "no tesseract or Pillow" }, () => {
    const png = path.join(dir, "i.png");
    spawnSync(PY, ["-c", "from PIL import Image;import sys;Image.new('RGB',(600,400),(250,250,250)).save(sys.argv[1])", png]);
    const r = exec(pdfOcr, { lang: "eng" }, { "1.png": png, "2.png": png }, env);
    assert.equal(r.last.status, 0, r.stderr);
    assert.ok(r.out.includes("1等2张_可搜索.pdf"), r.out.join(","));
    assert.match(r.report.成品[0], /2 页/);
  });
});
function probeLang(l) { const r = spawnSync("tesseract", ["--list-langs"], { encoding: "utf8" }); return new RegExp("^" + l + "$", "m").test((r.stdout || "") + (r.stderr || "")); }

describe("report()", () => {
  test("pdf-tools", () => {
    const r = pdfTools.report(["OK a.pdf | 3 页 | 5 KB\nNOTE 说明一\nINFO {\"页数\":3}\n用时 2 秒"]);
    assert.deepEqual(r, { 成品: ["a.pdf | 3 页 | 5 KB"], 说明: ["说明一"], 信息: { 页数: 3 }, 用时: "2 秒" });
    assert.deepEqual(pdfTools.report(["错误：x"]), {});
  });
  test("pdf-to-markdown counts characters", () => {
    assert.equal(pdfToMd.report(["OK a.md | 1 KB | 1234 个字符（不含空白），其中汉字 5 | 方法：markitdown"]).字符数, 1234);
  });
});
