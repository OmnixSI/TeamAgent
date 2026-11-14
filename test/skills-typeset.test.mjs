// Offline tests for the three typesetting skills: validation, quoting, the Markdown -> Typst converter and the slide
// splitter (both Python, run locally when python3 is there), and the whole command list in a real bash with a fake typst.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import report, { MD2TYP_PY, putFile } from "../src/skills/md-to-report.ts";
import slides, { MD2PPTX_PY } from "../src/skills/md-to-slides.ts";
import resume, { parseResumeMd, normalizeResume, resumeTypst, inl } from "../src/skills/resume.ts";

const has = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const HAVE_PY = has("python3", ["--version"]);
const HAVE_PPTX = HAVE_PY && has("python3", ["-c", "import pptx"]);
// The interpreter itself, not a version manager's shim: run() below changes HOME, and a shim (asdf on the
// build machine) then no longer knows which Python to start.
const REAL_PY = HAVE_PY ? (spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout || "").trim() : "";
const throwsZh = (fn, re) => assert.throws(fn, (e) => e instanceof Error && /[\u4e00-\u9fff]/.test(e.message) && (!re || re.test(e.message)));

const tmp = (p = "ts-") => fs.mkdtempSync(path.join(os.tmpdir(), p));
const shimDir = () => {
  const d = tmp("shim-");
  // fake typst: "compile" writes a tiny PDF with the right number of /Type /Page objects (pages = 1 unless INPUT says otherwise)
  fs.writeFileSync(path.join(d, "typst"), `#!/bin/sh\nout=""; for a in "$@"; do out="$a"; done\nprintf '%%PDF-1.4\\n<< /Type /Pages >>\\n<< /Type /Page >>\\n' > "$out"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(d, "soffice"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  if (REAL_PY && fs.existsSync(REAL_PY)) fs.symlinkSync(REAL_PY, path.join(d, "python3"));
  return d;
};
/** Runs the skill's commands in a real bash inside a fresh run directory; returns { dir, stdout[] }. */
function run(skill, args, files = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "in"));
  fs.mkdirSync(path.join(dir, "out"));
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, "in", n), b);
  const cmds = skill.commands(args, Object.keys(files).map((name) => ({ name })));
  const out = [];
  for (const c of cmds) {
    const r = spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: shimDir() + ":" + process.env.PATH, HOME: dir } });
    out.push(r.stdout);
    if (r.status !== 0) throw new Error("command failed: " + c.slice(0, 120) + "\n" + r.stderr);
  }
  return { dir, stdout: out, cmds };
}
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

describe("shape and validation", () => {
  test("every skill has Chinese when/args and the right file rules", () => {
    for (const s of [report, slides, resume]) {
      assert.match(s.when, /[\u4e00-\u9fff]/);
      assert.match(s.title, /[\u4e00-\u9fff]/);
      for (const [k, a] of Object.entries(s.args)) assert.match(a.description, /[\u4e00-\u9fff]/, `${s.name}.${k}`);
      assert.ok(s.files.max >= 1);
    }
    assert.deepEqual(slides.packs, ["office"]);
  });

  test("md-to-report validation", () => {
    throwsZh(() => report.commands({}, []), /markdown/);
    throwsZh(() => report.commands({ markdown: "   " }, []), /markdown/);
    throwsZh(() => report.commands({ markdown: "# a", style: "fancy" }, []), /style/);
    throwsZh(() => report.commands({ markdown: "# a", columns: 3 }, []), /columns/);
    throwsZh(() => report.commands({ markdown: "x".repeat(200_000) }, []), /太长/);
    throwsZh(() => report.commands({ markdown: "# a", title: "t".repeat(300) }, []), /title/);
    assert.doesNotThrow(() => report.commands({}, [{ name: "a.md" }]));
  });

  test("md-to-slides validation", () => {
    throwsZh(() => slides.commands({}, []), /markdown/);
    throwsZh(() => slides.commands({ markdown: "# a", scheme: "neon" }, []), /scheme/);
    throwsZh(() => slides.commands({ markdown: "# a", scheme: "brand", accent: "red" }, []), /accent/);
    throwsZh(() => slides.commands({ markdown: "# a", accent: "#12345" }, []), /accent/);
    throwsZh(() => slides.commands({ markdown: "# a", max_lines: 2 }, []), /max_lines/);
    throwsZh(() => slides.commands({ markdown: "# a", max_lines: 30 }, []), /max_lines/);
    assert.doesNotThrow(() => slides.commands({ markdown: "# a", accent: "E4572E", scheme: "brand" }, []));
  });

  test("resume validation", () => {
    throwsZh(() => resume.commands({}, []), /简历内容/);
    throwsZh(() => resume.commands({ data: "{bad json" }, []), /JSON/);
    throwsZh(() => resume.commands({ data: "[]" }, []), /JSON 对象/);
    throwsZh(() => resume.commands({ data: "{}" }, []), /name/);
    throwsZh(() => resume.commands({ data: '{"name":"A"}' }, []), /内容太少/);
    throwsZh(() => resume.commands({ data: '{"name":"A","skills":["x"]}', style: "x" }, []), /style/);
    throwsZh(() => resume.commands({ data: '{"name":"A","skills":["x"]}', pages: 3 }, []), /pages/);
    throwsZh(() => resume.commands({ data: '{"name":"A","skills":["x"]}', photo: "nope.jpg" }, []), /照片/);
    throwsZh(() => resume.commands({ data: '{"name":"A","experience":[{"role":"x"}]}' }, []), /名称/);
    assert.doesNotThrow(() => resume.commands({ data: { name: "A", skills: ["x"] } }, []));
  });
});

const HOSTILE = ["it's \"quoted\" $(touch PWNED) `touch PWNED` ; touch PWNED #", "多行\n标题 && touch PWNED", "\\' ' \\\\ $HOME ${IFS}"];

describe("quoting and bash syntax", () => {
  test("bash -n accepts every command, including hostile arguments", () => {
    const md = "# 标题\n\n正文 $x^2$ 和 `code` 'quote' \"dq\" $(x) \\\n";
    const all = [];
    for (const h of HOSTILE) {
      all.push(...report.commands({ markdown: md + h, title: h, subtitle: h, author: h, date: h, short_title: h, name: h, toc: true, style: "paper", columns: 2 }, []));
      all.push(...slides.commands({ markdown: md + h, title: h, subtitle: h, author: h, date: h, font: h, name: h, scheme: "brand", accent: "#aabbcc" }, []));
      all.push(...resume.commands({ data: JSON.stringify({ name: h, title: h, contacts: [h], summary: h, experience: [{ company: h, role: h, period: h, bullets: [h] }], skills: [h] }), name: h, style: "modern" }, []));
    }
    for (const c of all) {
      const r = spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr + "\n" + c.slice(0, 200));
    }
  });

  test("putFile round-trips awkward text exactly", () => {
    const text = "a'b\"c\n$(x) `y` \\ \\n 中文 #\n\n" + "长".repeat(30000);
    const dir = tmp();
    for (const c of putFile("deep/dir/f.txt", text)) assert.equal(spawnSync("bash", ["-c", c], { cwd: dir }).status, 0);
    assert.equal(fs.readFileSync(path.join(dir, "deep/dir/f.txt"), "utf8"), text);
    assert.ok(!fs.existsSync(path.join(dir, "deep/dir/f.txt.b64")));
  });

  test("hostile strings reach the files literally and nothing is executed (report)", { skip: !HAVE_PY }, () => {
    const title = HOSTILE[0];
    const { dir, stdout } = run(report, { markdown: "# 原标题\n\n正文 " + HOSTILE[1] + "\n", title, author: HOSTILE[2], name: "a b/../c" });
    assert.ok(!fs.existsSync(path.join(dir, "PWNED")));
    assert.ok(fs.existsSync(path.join(dir, "out/a-b-c.pdf")), "name is sanitised");
    const typ = fs.readFileSync(path.join(dir, "out/a-b-c.typ"), "utf8");
    assert.ok(typ.includes(title.replace(/\\/g, "\\\\").replace(/"/g, '\\"')), "title lands in the document metadata as a Typst string");
    assert.equal(report.report(stdout).pages, 1);
  });
});

/** Runs the converter on Markdown text and returns the .typ source and the printed notes. */
function toTyp(md, opts = [], files = {}) {
  const dir = tmp("conv-");
  fs.mkdirSync(path.join(dir, "in"));
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dir, "in", n), b);
  fs.writeFileSync(path.join(dir, "md2typ.py"), MD2TYP_PY);
  fs.writeFileSync(path.join(dir, "in.md"), md);
  const r = spawnSync("python3", ["-I", "md2typ.py", "in.md", "out.typ", "--root", ".", ...opts], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return { typ: fs.readFileSync(path.join(dir, "out.typ"), "utf8"), out: r.stdout };
}
const body = (typ) => typ.split("// body\n")[1];

describe("Markdown -> Typst converter", { skip: !HAVE_PY }, () => {
  test("title block, heading levels and numbering", () => {
    const { typ, out } = toTyp("# 年度报告\n\n*副标题行*\n\n## 一\n\n正文\n\n### 二\n", ["--author", "张三", "--date", "2026年1月1日"]);
    assert.match(out, /TITLE 年度报告/);
    assert.match(typ, /title: "年度报告"/);
    assert.match(typ, /#heading\(level: 1\)\[一\]/);
    assert.match(typ, /#heading\(level: 2\)\[二\]/);
    assert.match(typ, /2026年1月1日/);
    assert.match(typ, /张三/);
    assert.match(typ, /lang: "zh"/);
  });

  test("headings that already carry numbers switch automatic numbering off", () => {
    const { typ, out } = toTyp("# T\n\n## 一、背景\n\n## 二、方案\n");
    assert.match(typ, /#set heading\(numbering: none\)/);
    assert.match(out, /没有再自动编号/);
    assert.match(toTyp("# T\n\n## Background\n").typ, /numbering: "1\.1"/);
  });

  test("inline: emphasis, code, links, escapes and the separator after function calls", () => {
    const b = body(toTyp("**粗**和*斜*和`a#b`和[链接](https://x.y/z_w)和~~删~~，100% #标签 a_b_c 2*3*4 @x\n\n**粗**(括号)\n").typ);
    assert.match(b, /#strong\[粗\];和#emph\[斜\];/);
    assert.match(b, /#raw\("a#b"\);/);
    assert.match(b, /#link\("https:\/\/x\.y\/z_w"\)\[链接\];/);
    assert.match(b, /#strike\[删\];/);
    assert.match(b, /\\#标签/);
    assert.match(b, /a\\_b\\_c/);
    assert.match(b, /\\@x/);
    assert.match(b, /#strong\[粗\];\(括号\)/, "a semicolon keeps '(' from being read as call arguments");
  });

  test("maths: LaTeX becomes Typst math, currency stays text", () => {
    const b = body(toTyp("行内 $\\frac{a}{b} + x_{ij}^2 \\le \\alpha$，花了 $5 和 $6。\n\n$$\n\\sum_{i=1}^{n} \\sqrt{x_i} = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}\n$$\n").typ);
    assert.match(b, /\$frac\(a, b\) \+ x_i j\^2 lt\.eq alpha\$|\$frac\(a, b\) \+ x_\(i j\)\^2 lt\.eq alpha\$/);
    assert.match(b, /\n\$ sum_\(i = 1\)\^n sqrt\(x_i\) = mat\(delim: "\(", 1, 2; 3, 4\) \$\n/);
    assert.match(b, /花了 \\\$5 和 \\\$6/);
  });

  test("unknown LaTeX is shown as text and reported, --plain-math skips conversion", () => {
    const r = toTyp("$\\foo{x} + y$\n");
    assert.match(r.typ, /"\\\\foo"/);
    assert.match(r.out, /\\foo/);
    const p = toTyp("$x^2$\n\n$$y$$\n", ["--plain-math"]);
    assert.match(body(p.typ), /#raw\("\$x\^2\$"\);/);
    assert.ok(!/\$ y \$/.test(p.typ));
  });

  test("tables, code, quotes, nested and task lists, footnotes, rules", () => {
    const md = "| 名称 | 值 |\n|:--|--:|\n| a \\| b | `x\\|y` |\n| 二 | 3.5 |\n\n```python\nprint('#1')\n```\n\n> 引用\n> 第二行\n\n1. 一\n   - 嵌套甲\n   - 嵌套乙\n2. 二\n\n- [x] 完成\n- [ ] 待办\n\n---\n\n正文[^n]\n\n[^n]: 脚注内容\n";
    const b = body(toTyp(md).typ);
    assert.match(b, /#table\(\n  columns: \(auto, auto\),\n  align: \(left, right\),/);
    assert.match(b, /table\.header\(\[#strong\[名称\]\], \[#strong\[值\]\]\)/);
    assert.match(b, /\[a \| b\], \[#raw\("x\|y"\);\]/);
    assert.match(b, /#raw\(block: true, lang: "python", "print\('#1'\)"\)/);
    assert.match(b, /#bq\[\n引用第二行\n\]/);
    assert.match(b, /#enum\(start: 1, \[一\n\n#list\(\[嵌套甲\], \[嵌套乙\]\)\], \[二\]\)/);
    assert.match(b, /#list\(\[☑ 完成\], \[☐ 待办\]\)/);
    assert.match(b, /#line\(length: 100%/);
    assert.match(b, /#footnote\[脚注内容\];/);
  });

  test("images: inputs resolve case-insensitively, missing and remote ones degrade", () => {
    const r = toTyp("![架构图](Arch.PNG)\n\n![](gone.png)\n\n![r](https://x.y/a.png)\n\n行内 ![i](Arch.PNG) 图\n", [], { "arch.png": PNG });
    const b = body(r.typ);
    assert.match(b, /#figure\(fig\("\/in\/arch\.png"\), caption: \[架构图\]\);/i);
    assert.match(b, /\[图：gone\.png\]/);
    assert.match(b, /\[图：r\]/);
    assert.match(b, /#box\(image\("\/in\/arch\.png", height: 1\.2em\)\);/i);
    assert.match(r.out, /NOTE 图片 gone\.png/);
  });

  test("styles, paper abstract/references, columns, toc", () => {
    const md = "---\ntitle: A Study\nauthor: Li\nkeywords: x, y\n---\n\n## Abstract\n\nWe study things.\n\n## Method\n\nText.\n\n## References\n\n1. Smith. Book. 2020.\n2. Jones. Paper. 2021.\n";
    const p = toTyp(md, ["--style", "paper", "--columns", "2", "--toc"]).typ;
    assert.match(p, /"Libertinus Serif"/);
    assert.match(p, /#strong\[Abstract\]/);
    assert.match(p, /We study things\./);
    assert.match(p, /Keywords: /);
    assert.match(p, /#show: rest => columns\(2/);
    assert.match(p, /#outline\(title: "Contents"/);
    assert.match(p, /#par\(hanging-indent: 2\.2em, first-line-indent: 0pt\)\[\\\[1\\\]#h\(0\.5em\)Smith\. Book\. 2020\./);
    assert.match(p, /\\\[2\\\]#h\(0\.5em\)Jones/);
    assert.match(p, /lang: "en"/);
    assert.ok(!/#heading\(level: 1\)\[Abstract\]/.test(p));
    assert.match(toTyp("# T\n\ntext\n", ["--style", "note"]).typ, /accent = rgb\("#2f7d6d"\)/);
    assert.match(toTyp("# T\n\ntext\n").typ, /rgb\("#1f4e79"\)/);
  });

  test("garbage input never crashes the converter", () => {
    for (const md of ["", "\n\n", "**", "$$", "```", "| a |\n|---|", "[^1]", "![](", "- \n- ", "> > >", "<", "\\", "$\\left( \\begin{matrix}", "# \n## "]) {
      assert.doesNotThrow(() => toTyp(md), JSON.stringify(md));
    }
  });
});

const plan = (md, extra = []) => {
  const dir = tmp("plan-");
  fs.writeFileSync(path.join(dir, "p.py"), MD2PPTX_PY);
  fs.writeFileSync(path.join(dir, "in.md"), md);
  const r = spawnSync("python3", ["-I", "p.py", "in.md", "--dump", ...extra], { cwd: dir, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

describe("slide plan and splitter", { skip: !HAVE_PY }, () => {
  const bullets = (n, pre = "要点") => Array.from({ length: n }, (_, i) => `- ${pre}${i + 1}`).join("\n");

  test("title slide, slide titles, levels, numbered lists, notes", () => {
    const p = plan("# 总标题\n\n副标题\n作者\n\n> note: 开场白\n\n## 第一页\n\n- 甲\n  - 甲一\n    - 太深的层级\n1. 编号\n\n> 备注：讲稿一\n> 接着说\n\n### 小标题\n正文句子\n");
    assert.equal(p.title, "总标题");
    assert.equal(p.subtitle, "副标题");
    assert.deepEqual(p.meta, ["作者"]);
    assert.equal(p.slides.length, 1);
    const s = p.slides[0];
    assert.equal(s.title, "第一页");
    assert.deepEqual(s.blocks[0].kinds, ["b0", "b1", "b1", "n0", "h0", "p0"]);
    assert.deepEqual(s.notes, ["讲稿一", "接着说"]);
  });

  test("short slides stay whole, long ones split with a continuation title", () => {
    assert.equal(plan(`# T\n\n## 页\n\n${bullets(5)}\n`).slides.length, 1);
    const p = plan(`# T\n\n## 页\n\n${bullets(20)}\n`);
    assert.ok(p.slides.length >= 3, "20 one-line bullets need at least 3 slides at 11 lines");
    assert.deepEqual(p.slides.map((s) => s.cont), p.slides.map((_, i) => i > 0));
    assert.equal(p.slides.flatMap((s) => s.blocks.flatMap((b) => b.lines)).length, 20, "nothing is lost");
    const per = p.slides.map((s) => s.blocks[0].lines.length);
    assert.ok(Math.max(...per) <= 9, `at most 9 one-line bullets per slide, got ${per}`);
    assert.equal(plan(`# T\n\n## 页\n\n${bullets(8)}\n`, ["--max-lines", "16"]).slides.length, 1, "max_lines raises the limit");
    assert.ok(plan(`# T\n\n## 页\n\n${bullets(8)}\n`, ["--max-lines", "6"]).slides.length >= 2);
  });

  test("a long wrapped bullet counts as several lines; children stay with their parent", () => {
    const long = "很长的一句话".repeat(12);
    const p = plan(`# T\n\n## 页\n\n- ${long}\n- ${long}\n- ${long}\n- ${long}\n- ${long}\n`);
    assert.ok(p.slides.length >= 2);
    const q = plan(`# T\n\n## 页\n\n${bullets(6)}\n- 父\n  - 子一\n  - 子二\n`, ["--max-lines", "8"]);
    assert.ok(q.slides.at(-1).blocks[0].kinds.join().includes("b0,b1,b1"), "the parent is not separated from its sub-items");
  });

  test("tables split by rows and repeat nothing but the header; code splits by lines", () => {
    const rows = Array.from({ length: 20 }, (_, i) => `| 行${i} | ${i} |`).join("\n");
    const p = plan(`# T\n\n## 表\n\n| 名 | 值 |\n|---|---|\n${rows}\n`);
    const t = p.slides.flatMap((s) => s.blocks.filter((b) => b.k === "table"));
    assert.ok(t.length >= 2);
    assert.equal(t.reduce((n, b) => n + b.rows, 0), 20);
    assert.ok(t.every((b) => b.cols === 2 && b.rows <= 8));
    const code = Array.from({ length: 40 }, (_, i) => `line_${i} = ${i}`).join("\n");
    const c = plan(`# T\n\n## 码\n\n\`\`\`py\n${code}\n\`\`\`\n`);
    assert.ok(c.slides.length >= 2);
    assert.equal(c.slides.flatMap((s) => s.blocks).reduce((n, b) => n + b.lines, 0), 40);
  });

  test("image under text, image alone, section slides, empty slide", () => {
    const p = plan("# T\n\n## 图文\n\n- 说明\n\n![a](x.png)\n\n## 只有图\n\n![b](y.png)\n\n![c](z.png)\n\n# 第二章\n\n## 空页\n");
    assert.deepEqual(p.slides.map((s) => s.type + ":" + s.title + ":" + s.cont), [
      "content:图文:false", "content:只有图:false", "content:只有图:true", "section:第二章:false", "content:空页:false",
    ]);
    assert.deepEqual(p.slides[0].blocks.map((b) => b.k), ["text", "image"]);
  });

  test("a rule starts a continuation slide", () => {
    const p = plan("# T\n\n## 页\n\n- 一\n\n---\n\n- 二\n");
    assert.equal(p.slides.length, 2);
    assert.equal(p.slides[1].cont, true);
  });
});

describe("whole command lists in a real bash", { skip: !HAVE_PY }, () => {
  test("md-to-report writes pdf and typ and reports pages", () => {
    const { dir, stdout } = run(report, { markdown: "# 周报\n\n## 进展\n\n完成 $x^2$。\n", style: "note" });
    assert.ok(fs.existsSync(path.join(dir, "out/report.pdf")));
    assert.match(fs.readFileSync(path.join(dir, "out/report.typ"), "utf8"), /#heading\(level: 1\)\[进展\]/);
    assert.deepEqual(report.report(stdout), { pages: 1 });
  });

  test("md-to-report falls back to plain maths when the first compile fails", () => {
    const d = shimDir();
    // typst shim that fails when the source contains real Typst math
    fs.writeFileSync(path.join(d, "typst"), `#!/bin/sh\nfor a in "$@"; do last="$a"; done\ngrep -q 'frac(' out/*.typ && { echo err >&2; exit 1; }\nprintf '/Type /Page\\n' > "$last"\n`, { mode: 0o755 });
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "in"));
    fs.mkdirSync(path.join(dir, "out"));
    const outs = [];
    for (const c of report.commands({ markdown: "# T\n\n$\\frac{a}{b}$\n" }, [])) {
      const r = spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: d + ":" + process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      outs.push(r.stdout);
    }
    const rep = report.report(outs);
    assert.equal(rep.pages, 1);
    assert.match(rep.notes[0], /公式/);
    assert.ok(!/frac\(/.test(fs.readFileSync(path.join(dir, "out/report.typ"), "utf8")));
  });

  test("resume compiles and shrinks until it fits", () => {
    const d = shimDir();
    // pages = 3 until the scale input drops to 0.9
    fs.writeFileSync(path.join(d, "typst"), `#!/bin/sh\nfor a in "$@"; do last="$a"; done\ncase " $* " in *" k=0.9 "*|*" k=0.85 "*) n=1;; *) n=3;; esac\ni=0; : > "$last"; while [ $i -lt $n ]; do echo '/Type /Page' >> "$last"; i=$((i+1)); done\n`, { mode: 0o755 });
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "in"));
    fs.mkdirSync(path.join(dir, "out"));
    const outs = [];
    for (const c of resume.commands({ data: '{"name":"王五","skills":["Go"]}', pages: 1 }, [])) {
      const r = spawnSync("bash", ["-c", c], { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: d + ":" + process.env.PATH } });
      assert.equal(r.status, 0, r.stderr);
      outs.push(r.stdout);
    }
    assert.deepEqual(resume.report(outs), { pages: 1, shrunk: 0.9 });
    assert.ok(fs.existsSync(path.join(dir, "out/resume.typ")));
  });
});

describe("pptx output", { skip: !HAVE_PPTX }, () => {
  test("builds a deck with explicit CJK fonts, notes, native table, slide numbers; preview is skipped quietly", () => {
    const md = "# 复盘\n\n副标题\n\n> note: 开场\n\n## 数据\n\n| 指标 | 值 |\n|---|--:|\n| 满意度 | 92% |\n\n## 要点\n\n- **加粗**与`代码`\n  - 子项\n\n```js\nlet a = 1\n```\n\n![](p.png)\n";
    const { dir, stdout } = run(slides, { markdown: md, scheme: "brand", accent: "#E4572E", author: "张三" }, { "p.png": PNG });
    assert.deepEqual(slides.report(stdout), { slides: 4, preview: false });
    const py = `
import sys, zipfile, re
from pptx import Presentation
p = Presentation(sys.argv[1])
print(len(p.slides), p.slide_width, p.slide_height)
x = zipfile.ZipFile(sys.argv[1])
s = "".join(x.read(n).decode() for n in x.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml"))
runs = re.findall(r"<a:rPr[^>]*>.*?</a:rPr>", s)
print(len(runs), sum('<a:ea typeface="Microsoft YaHei"' in r or '<a:ea typeface="Noto Sans Mono CJK SC"' in r for r in runs), s.count("<a:tbl>"), s.count('type="slidenum"'))
print(p.slides[0].notes_slide.notes_text_frame.text)
print(len(p.slides[1].shapes), [sh.shape_type for sh in p.slides[1].shapes if sh.has_table if hasattr(sh, "has_table")])
`;
    const r = spawnSync("python3", ["-c", py, path.join(dir, "out/slides.pptx")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines[0], `4 ${Math.round(13.333 * 914400)} ${Math.round(7.5 * 914400)}`);
    const [runs, withEa, tables, nums] = lines[1].split(" ").map(Number);
    assert.ok(runs > 8 && withEa === runs, `every run carries an east-asian font (${withEa}/${runs})`);
    assert.equal(tables, 1);
    assert.equal(nums, 3, "slide numbers on the three content slides (not on the brand title slide)");
    assert.equal(lines[2], "开场");
    assert.ok(fs.existsSync(path.join(dir, ".skill/slides-preview.pptx")));
    assert.ok(!fs.existsSync(path.join(dir, "out/slides-preview.pdf")));
  });
});

describe("résumé", () => {
  const MD = "# 林晓雨\n> 后端工程师 | xy@example.com | 138 0000 1111 | 上海\n\n## 个人简介\n七年后端经验。\n\n## 工作经历\n### 星海科技 | 技术负责人 | 2022.03 – 至今\n- 重构订单系统，QPS 提升 6 倍\n- 带 8 人团队\n\n## 项目经历\n### 数据平台 | 负责人 | 2023\n- 统一指标口径\n\n## 教育背景\n### 华东理工大学 | 本科 计算机 | 2014 – 2018\n\n## 专业技能\n- 语言：Go、Python\n\n## 证书\n- ACP 认证\n";

  test("Markdown convention parses into the same shape as the JSON", () => {
    const r = normalizeResume(parseResumeMd(MD));
    assert.equal(r.name, "林晓雨");
    assert.equal(r.title, "后端工程师");
    assert.deepEqual(r.contacts, ["xy@example.com", "138 0000 1111", "上海"]);
    assert.equal(r.summary, "七年后端经验。");
    assert.deepEqual(r.experience[0], { title: "星海科技", sub: "技术负责人", period: "2022.03 – 至今", place: "", bullets: ["重构订单系统，QPS 提升 6 倍", "带 8 人团队"] });
    assert.equal(r.projects[0].title, "数据平台");
    assert.equal(r.education[0].sub, "本科 计算机");
    assert.deepEqual(r.skills, ["语言：Go、Python"]);
    assert.deepEqual(r.extra, [{ title: "证书", items: ["ACP 认证"] }]);
  });

  test("JSON variants: contacts object, skills object, flexible keys", () => {
    const r = normalizeResume({ name: "A", contacts: { email: "a@b.c", phone: "1" }, skills: { 语言: ["Go", "SQL"] }, education: [{ school: "S", degree: "BSc", major: "CS", gpa: "3.9" }] });
    assert.deepEqual(r.contacts, ["a@b.c", "1"]);
    assert.deepEqual(r.skills, ["语言：Go、SQL"]);
    assert.deepEqual(r.education[0].bullets, ["GPA 3.9"]);
    assert.equal(r.education[0].sub, "BSc · CS");
  });

  test("Typst source: styles, language, photo, escaping, scale input", () => {
    const r = normalizeResume(parseResumeMd(MD));
    for (const st of ["classic", "modern", "compact"]) {
      const t = resumeTypst(r, st, "zh", "/in/me.png");
      assert.match(t, /sys\.inputs\.at\("k"/);
      assert.match(t, /工作经历/);
      assert.match(t, /image\("\/in\/me\.png"/);
      assert.match(t, /#entry\(\[#strong\[星海科技\]/);
    }
    assert.match(resumeTypst(r, "classic", "en"), /Experience/);
    const hostile = normalizeResume({ name: "A#B $x *c* _d_", summary: "**粗** [链接](https://a.b/c) #1 <y> @z \\", skills: ["k: v"] });
    const t = resumeTypst(hostile, "modern", "zh");
    assert.match(t, /A\\#B \\\$x \\\*c\\\* \\_d\\_/);
    assert.match(t, /#strong\[粗\];/);
    assert.match(t, /#link\("https:\/\/a\.b\/c"\)\[链接\];/);
    assert.match(t, /\\#1 \\<y\\> \\@z \\\\/);
    assert.equal(inl("100.5"), "100\\.5");
  });

  test("language detection and photo selection in commands", () => {
    const cmds = resume.commands({ data: JSON.stringify({ name: "Ann Lee", experience: [{ company: "Acme", role: "Dev", bullets: ["Built things"] }] }) }, [{ name: "me.JPG" }]);
    const typCmd = cmds.filter((c) => c.startsWith("printf")).join("");
    const typ = Buffer.from(typCmd.split("printf %s '").slice(1).map((s) => s.slice(0, s.indexOf("'"))).join(""), "base64").toString("utf8");
    assert.match(typ, /Experience/);
    assert.match(typ, /\/in\/me\.JPG/);
    assert.match(cmds.at(-1), /for K in 1 0\.95/);
    assert.match(cmds.at(-1), /-le 2 \]/);
  });
});
