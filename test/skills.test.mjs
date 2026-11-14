// Offline tests for the skill runner. Fake skills, a fake host, and a stand-in for runComputer that runs the
// commands for real with bash in a temp directory (with /work mapped there), so the wrapper, the input
// placement, the listing, the zip and the cleanup are all proven on this machine.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const S = await import("../src/feat/skills.ts");
const sh = s => "'" + String(s).replace(/'/g, "'\\''") + "'";
const CAP = 25 * 1024 * 1024;

// ---------- fake skills ----------
const hello = {
  name: "hello-note", title: "写一张便条", when: "测试用：不要文件，把一句话写进 note.txt，用来检查整个流程从准备目录到取回结果能不能走通",
  args: { text: { type: "string", description: "要写的话" }, times: { type: "integer", description: "重复几次" } }, required: ["text"],
  commands: a => ["for i in $(seq 1 " + (a.times || 1) + "); do echo " + sh(a.text) + "; done > out/便条.txt", "echo pages=3"],
  report: outs => ({ pages: Number((outs.join("\n").match(/pages=(\d+)/) || [])[1]) }),
};
const shrink = {
  name: "pdf-shrink", title: "压缩 PDF", when: "测试用：把 PDF 原样复制到 out，名字前面加 small-",
  args: { level: { type: "string", description: "压缩程度", enum: ["low", "high"] } },
  files: { min: 1, max: 3, extensions: ["pdf"], what: "PDF 文件" },
  commands: (a, files) => files.map(f => "cp in/" + sh(f.name) + " out/small-" + sh(f.name)),
};
const picky = {
  name: "picky-frames", title: "挑帧", when: "测试用：参数不对就报错；可以产出很多文件或带文件夹的结果",
  args: { count: { type: "number", description: "帧数" }, nested: { type: "boolean", description: "放进子文件夹" }, big: { type: "boolean", description: "做一个大文件" }, video: { type: "boolean", description: "做一个 mp4" }, fail: { type: "boolean", description: "故意失败" } },
  files: { min: 0, max: 2, extensions: ["JPG", "png"] },
  commands: a => {
    if (a.count !== undefined && a.count > 20) throw new Error("帧数最多 20");
    if (a.fail) return ["echo 开始", "echo 'line one' >&2; echo '找不到输入的视频流' >&2; exit 3", "echo never"];
    const c = [];
    if (a.count) c.push(a.nested ? "mkdir -p out/frames && for i in $(seq 1 " + a.count + "); do echo $i > out/frames/f$i.png; done" : "for i in $(seq 1 " + a.count + "); do echo $i > out/f$i.png; done");
    if (a.big) c.push("head -c " + (CAP + 10) + " /dev/zero > out/big.bin");
    if (a.video) c.push("echo mp4 > out/clip.mp4");
    if (!c.length) c.push("true");
    return c;
  },
};
const SKILLS = [hello, shrink, picky];

// ---------- fakes ----------
function machine() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-")), work = path.join(tmp, "work"), box = path.join(tmp, "box");
  fs.mkdirSync(work); fs.mkdirSync(box);
  const calls = [];
  const local = s => s.replaceAll("/work/", work + "/").replaceAll("'/work'", sh(work));
  const runComputer = async (_hub, req) => {
    calls.push(req);
    const out = { ok: false, steps: [], files: [], seconds: 1 };
    for (const f of req.files || []) fs.writeFileSync(path.join(work, f.name), f.bytes);
    for (const command of req.commands) {
      const r = spawnSync("bash", ["-c", local(command)], { cwd: work, encoding: "utf8" });
      out.steps.push({ command, exit: r.status, stdout: r.stdout, stderr: r.stderr, seconds: 0 });
      if (r.status !== 0) break;
    }
    for (const pat of req.collect || []) {
      const d = path.join(work, path.dirname(pat));
      if (!fs.existsSync(d)) continue;
      for (const n of fs.readdirSync(d).sort()) {
        const p = path.join(d, n), size = fs.statSync(p).size;
        if (size > CAP) (out.skipped ||= []).push(n + "（超过 25 MB）");
        else if (out.files.length < 6) out.files.push({ name: path.dirname(pat) + "/" + n, bytes: fs.readFileSync(p) });
      }
    }
    out.ok = out.steps.length === req.commands.length && out.steps.every(s => s.exit === 0);
    return out;
  };
  const deps = (over = {}) => ({
    skills: SKILLS, runComputer, id: () => "abc123",
    boxFile: (_h, _c, ref) => (ref === "x12" ? { ref, name: "大视频 原片.PDF", size: 9e7, mime: "application/pdf", ts: 0, expires: 0, by: "" } : null),
    boxDownloadCommand: (_h, _c, ref, dest) => "printf 'from-box' > " + sh(dest),
    boxUpload: (_h, _c, p, name) => ({ command: "cp " + sh(p) + " " + sh(box + "/" + name), claim: async () => (fs.existsSync(box + "/" + name) ? { ref: "x77", name, size: fs.statSync(box + "/" + name).size, link: "https://example.test/x/get/t/" + name } : null) }),
    ...over,
  });
  return { tmp, work, box, calls, deps, runDir: path.join(work, "skill/abc123") };
}

function fakeHost(over = {}) {
  const log = [], files = over.files || {};
  let n = 0, quotaLeft = over.quota ?? 99;
  return {
    log,
    fileRef: async ref => files[ref] || null,
    sendImage: async (bytes, note, mime, silent) => { log.push(["image", note, mime, !!silent]); return { ok: true, id: "g" + ++n }; },
    sendFile: async name => { log.push(["file", name]); return { ok: true }; },
    sendVideo: async name => { log.push(["video", name]); return { ok: true }; },
    keepFile: async name => { log.push(["keep", name]); return "f" + ++n; },
    quota: async (kind, limit) => { log.push(["quota", kind, limit]); return quotaLeft-- > 0; },
    cfg: key => (key === "skill_daily" ? 60 : 0),
  };
}
const ctxOf = host => ({ hub: { tools: () => [] }, conv: "t:ag-skills", askers: [], host });
const enc = s => new TextEncoder().encode(s);

// ---------- naming ----------
describe("file names", () => {
  test("Chinese survives, unsafe characters go, extension stays", () => {
    assert.equal(S.safeName("季度 报告（终稿）.PDF"), "季度_报告（终稿）.PDF");
    assert.equal(S.safeName("a'b$(rm -rf).docx"), "a_b_rm_-rf_.docx");
    assert.equal(S.safeName("../../etc/passwd"), "passwd");
    assert.equal(S.safeName("-rf.txt"), "_rf.txt");
    assert.equal(S.safeName(".bashrc"), "_bashrc");
    assert.equal(S.safeName(""), "file");
    assert.equal(S.safeName("照片.JPEG"), "照片.JPEG");
    assert.ok(S.safeName("长".repeat(200) + ".pdf").length <= 64);
  });
  test("collisions are numbered, case-insensitively, keeping the extension", () => {
    assert.deepEqual(S.uniqueNames(["报告.pdf", "报告.pdf", "报告.PDF", "a b.pdf", "a_b.pdf"]), ["报告.pdf", "报告-2.pdf", "报告-3.PDF", "a_b.pdf", "a_b-2.pdf"]);
  });
  test("safe names are one shell word", () => {
    for (const n of S.uniqueNames(["a b;c.pdf", "x`y`.png", "$HOME.txt", "引号\"'.md"])) {
      assert.equal(execFileSync("bash", ["-c", 'printf %s "$(echo ' + n + ')"']).toString(), n);
    }
  });
});

// ---------- validation ----------
describe("validation", () => {
  const run = async (name, files, args, host = fakeHost()) => { const m = machine(); const r = await S.runSkill(ctxOf(host), name, files, args, true, m.deps()); return { r, m }; };
  test("unknown skill lists close matches", async () => {
    let { r, m } = await run("pdf-shrnk", [], {});
    assert.equal(r.ok, false); assert.match(r.error, /没有叫「pdf-shrnk」的技能。是不是：pdf-shrink/);
    ({ r } = await run("totally-else", [], {}));
    assert.match(r.error, /现有的：hello-note、pdf-shrink、picky-frames/);
    assert.equal(m.calls.length, 0);
  });
  test("required, types, enums, unknown args", async () => {
    assert.match((await run("hello-note", [], {})).r.error, /缺少参数 text（要写的话）/);
    assert.match((await run("hello-note", [], { text: "x", times: 1.5 })).r.error, /参数 times 要是整数/);
    assert.match((await run("hello-note", [], { text: "x", times: "abc" })).r.error, /参数 times 要是整数/);
    assert.match((await run("hello-note", [], { text: "x", color: "red" })).r.error, /没有参数 color，能填的是：text、times/);
    assert.match((await run("pdf-shrink", ["f1"], { level: "max" })).r.error, /参数 level 只能是 low \/ high/);
    assert.match((await run("picky-frames", [], { nested: "yes" })).r.error, /参数 nested 要是true 或 false/);
    assert.deepEqual(S.checkArgs(picky, { count: "3", nested: "true" }), { ok: true, args: { count: 3, nested: true } });
  });
  test("file count and extensions (case-insensitive, jpeg = jpg)", async () => {
    const host = fakeHost({ files: { f1: { name: "a.pdf", bytes: enc("1") }, f2: { name: "b.docx", bytes: enc("2") }, g1: { name: "image-g1.jpeg", bytes: enc("3") } } });
    assert.match((await run("pdf-shrink", [], {}, host)).r.error, /要 至少 1 个文件（PDF 文件），现在给了 0 个/);
    assert.match((await run("pdf-shrink", ["f1", "f1", "f1", "f1"], {}, host)).r.error, /最多 3 个文件/);
    assert.match((await run("pdf-shrink", ["f1", "f2"], {}, host)).r.error, /只收 pdf 文件，b.docx 不行/);
    assert.match((await run("hello-note", ["f1"], { text: "x" }, host)).r.error, /不需要输入文件/);
    assert.match((await run("pdf-shrink", ["f9"], {}, host)).r.error, /取不到文件 f9/);
    assert.equal(S.checkFiles(picky, 1, ["image-g1.jpeg"]), null);
    assert.equal(S.checkFiles(picky, 1, ["PIC.PNG"]), null);
  });
  test("an error thrown by the skill comes back as is, before any machine time", async () => {
    const { r, m } = await run("picky-frames", [], { count: 99 });
    assert.deepEqual(r, { ok: false, error: "帧数最多 20" });
    assert.equal(m.calls.length, 0);
  });
  test("a file over 25 MB from the chat is turned away", async () => {
    const host = fakeHost({ files: { f1: { name: "huge.pdf", bytes: new Uint8Array(CAP + 1) } } });
    assert.match((await run("pdf-shrink", ["f1"], {}, host)).r.error, /超过 25 MB.*文件箱/);
  });
});

// ---------- commands ----------
describe("commands", () => {
  test("every generated command parses with bash -n", () => {
    const cmds = [
      S.wrap("/work/skill/abc", "echo hi | tr a-z A-Z > out/x.txt"),
      S.prepareCommand("/work/skill/abc", [{ from: "/work/skill-abc-0", to: "季度_报告.pdf" }], ["curl -s 'https://e.test/x' -o ./in/v.mp4"]),
      S.finishCommand("/work/skill/abc", "hello-结果.zip"),
      ...hello.commands({ text: "it's $HOME `x`" }, []),
    ];
    for (const c of cmds) execFileSync("bash", ["-n", "-c", c]);
  });
  test("the wrapper stops at a failure inside a pipe and runs in the run directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skills-wrap-"));
    const ok = spawnSync("bash", ["-c", S.wrap(tmp, "pwd -P; false | true; echo after")], { encoding: "utf8" });
    assert.notEqual(ok.status, 0, "pipefail stops it");
    assert.equal(ok.stdout.trim(), fs.realpathSync(tmp));
    const r2 = spawnSync("bash", ["-c", S.wrap(tmp, "false\necho after")], { encoding: "utf8" });
    assert.notEqual(r2.status, 0); assert.doesNotMatch(r2.stdout, /after/);
    const r3 = spawnSync("bash", ["-c", S.wrap(tmp + "/missing", "echo hi")], { encoding: "utf8" });
    assert.equal(r3.status, 1); assert.doesNotMatch(r3.stdout, /hi/);
  });
});

// ---------- end to end on this machine ----------
describe("runs", () => {
  test("the no-file skill runs for real: wrapper, listing, delivery, report, cleanup", async () => {
    const m = machine(), host = fakeHost();
    const r = await S.runSkill(ctxOf(host), "hello-note", [], { text: "你好 it's $HOME", times: "2" }, true, m.deps());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.produced, [{ name: "便条.txt", size: Buffer.byteLength("你好 it's $HOME\n") * 2 + " 字节" }]);
    assert.deepEqual(r.files_sent, ["便条.txt → f1"]);
    assert.deepEqual(r.facts, { pages: 3 });
    assert.deepEqual(host.log.slice(0, 3), [["quota", "skill", 60], ["file", "便条.txt"], ["keep", "便条.txt"]]);
    assert.equal(m.calls.length, 2, "one run, one cleanup");
    assert.match(m.calls[1].commands.at(-1), /^rm -rf -- '\/work\/skill\/abc123'$/);
    assert.equal(fs.existsSync(m.runDir), false, "run directory removed");
    assert.deepEqual(m.calls[0].collect, ["skill/abc123/ship/*"]);
  });
  test("input files land in ./in under safe unique names, box files are downloaded", async () => {
    const m = machine(), host = fakeHost({ files: { f1: { name: "季度 报告.pdf", bytes: enc("one") }, "https://q.test/a": { name: "季度 报告.pdf", bytes: enc("two") } } });
    let seen;
    const skill = { ...shrink, commands: (a, files) => { seen = files; return shrink.commands(a, files); } };
    const r = await S.runSkill(ctxOf(host), "pdf-shrink", ["f1", "[文件 季度 报告.pdf https://q.test/a]", "x12"], {}, false, m.deps({ skills: [skill] }));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(seen, [{ name: "季度_报告.pdf" }, { name: "季度_报告-2.pdf" }, { name: "大视频_原片.PDF" }]);
    assert.deepEqual(m.calls[0].files.map(f => f.name), ["skill-abc123-0", "skill-abc123-1"], "box file is not uploaded from the Worker");
    assert.deepEqual(r.produced.map(f => f.name), ["small-大视频_原片.PDF", "small-季度_报告-2.pdf", "small-季度_报告.pdf"]);
    assert.deepEqual(r.kept_as_materials, ["small-大视频_原片.PDF → f1", "small-季度_报告-2.pdf → f2", "small-季度_报告.pdf → f3"]);
    assert.ok(!host.log.some(l => l[0] === "file"), "deliver:false sends nothing");
    assert.deepEqual(fs.readdirSync(m.work), ["skill"], "temporary input names are gone");
    assert.deepEqual(fs.readdirSync(path.join(m.work, "skill")), [], "and so is the run directory");
  });
  test("pictures as pictures, mp4 as video, deliver:false keeps pictures silently", async () => {
    const m = machine(), host = fakeHost();
    const r = await S.runSkill(ctxOf(host), "picky-frames", [], { count: 2, video: true }, true, m.deps());
    assert.deepEqual(r.files_sent, ["clip.mp4 → f1", "f1.png → g2", "f2.png → g3"]);
    assert.deepEqual(host.log.filter(l => l[0] !== "quota" && l[0] !== "keep").map(l => l.slice(0, 2)), [["video", "clip.mp4"], ["image", "f1.png"], ["image", "f2.png"]]);
    const h2 = fakeHost(), r2 = await S.runSkill(ctxOf(h2), "picky-frames", [], { count: 1 }, false, machine().deps());
    assert.deepEqual(r2.kept_as_materials, ["f1.png → g1"]);
    assert.equal(h2.log.find(l => l[0] === "image")[3], true, "silent");
  });
  test("more than six results come back as one zip", async () => {
    const m = machine(), host = fakeHost();
    const r = await S.runSkill(ctxOf(host), "picky-frames", [], { count: 7 }, true, m.deps());
    assert.equal(r.ok, true);
    assert.equal(r.produced.length, 7);
    assert.match(r.zipped, /7 个文件.*picky-frames-结果\.zip/);
    assert.deepEqual(r.files_sent, ["picky-frames-结果.zip → f1"]);
  });
  test("a folder tree comes back as one zip that keeps the folders", async () => {
    const m = machine();
    let zipBytes;
    const host = { ...fakeHost(), sendFile: async (name, bytes) => { zipBytes = bytes; return { ok: true }; } };
    const r = await S.runSkill(ctxOf(host), "picky-frames", [], { count: 2, nested: true }, true, m.deps());
    assert.match(r.zipped, /带文件夹/);
    const z = path.join(m.tmp, "r.zip"); fs.writeFileSync(z, zipBytes);
    const names = execFileSync("python3", ["-c", "import sys,zipfile;print('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", z]).toString().trim().split("\n");
    assert.deepEqual(names, ["frames/f1.png", "frames/f2.png"]);
  });
  test("a result over 25 MB goes to the box; without the box it is reported plainly", async () => {
    const m = machine(), host = fakeHost();
    const r = await S.runSkill(ctxOf(host), "picky-frames", [], { count: 1, big: true }, true, m.deps());
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.big_files, [{ name: "big.bin", size: "25.0 MB", ref: "x77", link: "https://example.test/x/get/t/big.bin" }]);
    assert.deepEqual(r.files_sent, ["f1.png → g1"]);
    assert.equal(fs.statSync(path.join(m.box, "big.bin")).size, CAP + 10);
    assert.match(m.calls[1].commands[0], /skill\/abc123\/ship\/big\.bin/);
    assert.equal(fs.existsSync(m.runDir), false);
    // The placeholder file box: its command is "false" and claim() gives null.
    const m2 = machine(), r2 = await S.runSkill(ctxOf(fakeHost()), "picky-frames", [], { big: true }, true, m2.deps({ boxUpload: () => ({ command: "false", claim: async () => null }) }));
    assert.equal(r2.ok, true);
    assert.deepEqual(r2.too_large, ["big.bin（25.0 MB）：超过 25 MB，发不了，文件箱现在也存不进去"]);
    assert.equal(fs.existsSync(m2.runDir), false, "cleanup still ran after the failed upload");
  });
  test("a failing command: short Chinese sentence, raw tail, directory removed", async () => {
    const m = machine();
    const r = await S.runSkill(ctxOf(fakeHost()), "picky-frames", [], { fail: true }, true, m.deps());
    assert.equal(r.ok, false);
    assert.equal(r.error, "「挑帧」第 2 条命令出错了（退出码 3）：找不到输入的视频流");
    assert.match(r.output_tail, /line one\n找不到输入的视频流/);
    assert.equal(m.calls.length, 2);
    assert.equal(fs.existsSync(m.runDir), false);
  });
  test("a machine that throws still gets the cleanup call", async () => {
    const m = machine(), seen = [];
    const deps = m.deps({ runComputer: async (h, req) => { seen.push(req.commands.length); if (seen.length === 1) throw new Error("这个月云电脑的额度用到停止线了"); return { ok: true, steps: [], files: [], seconds: 0 }; } });
    const r = await S.runSkill(ctxOf(fakeHost()), "hello-note", [], { text: "x" }, true, deps);
    assert.match(r.error, /额度用到停止线/);
    assert.deepEqual(seen, [4, 1]);
  });
  test("daily cap", async () => {
    const m = machine(), host = fakeHost({ quota: 0 });
    const r = await S.runSkill(ctxOf(host), "hello-note", [], { text: "x" }, true, m.deps());
    assert.deepEqual(r, { ok: false, error: "今天用技能的次数用完了，明天再来" });
    assert.equal(m.calls.length, 0);
  });
});

// ---------- tool, description, admin ----------
describe("feature", () => {
  const m = machine(), feat = S.makeFeature(m.deps());
  test("description carries a generated index and says when to prefer skills", () => {
    const d = S.toolDescription(SKILLS);
    assert.ok(d.includes("- hello-note — 写一张便条 — " + hello.when.slice(0, 40) + "…\n"));
    assert.match(d, /- pdf-shrink — 压缩 PDF — /);
    assert.match(d, /文件转换、PDF 处理、排版成文档、成批处理图片和音视频，先用这个/);
    assert.match(d, /computer/);
    assert.ok(d.length < 900, "compact: " + d.length);
  });
  test("tunable, about, list", async () => {
    assert.equal(feat.tunables.skill_daily.default, 60);
    assert.match(feat.about.join("\n"), /现在有 3 个技能/);
    assert.match(feat.about.join("\n"), /PR/);
    const tool = feat.tools(ctxOf(fakeHost()))[0];
    assert.equal(tool.name, "skill"); assert.ok(tool.work && tool.slow);
    const l = await tool.run({ op: "list" });
    assert.equal(l.count, 3);
    assert.deepEqual(l.skills[1].files, "1–3 个 pdf 文件（PDF 文件）");
    assert.deepEqual(l.skills[1].args.level.enum, ["low", "high"]);
    assert.equal(l.skills[0].args.text.required, true);
    assert.match((await tool.run({ op: "run" })).error, /要给技能名/);
  });
  test("real registry loads and every registered skill describes itself", () => {
    for (const s of S.default.tools(ctxOf(fakeHost()))) assert.equal(s.name, "skill");
  });
  test("admin GET and POST", async () => {
    const hub = { tools: conv => feat.tools(ctxOf(fakeHost())) };
    const get = await feat.admin(hub, new Request("https://x/admin/skills"), new URL("https://x/admin/skills"), null);
    assert.equal((await get.json()).count, 3);
    const post = await feat.admin(hub, new Request("https://x/admin/skills", { method: "POST" }), new URL("https://x/admin/skills"), { conv: "t:ag-skills", name: "hello-note", args: { text: "hi" } });
    const body = await post.json();
    assert.equal(body.result.ok, true, JSON.stringify(body));
    assert.equal((await (await feat.admin(hub, new Request("https://x/admin/skills", { method: "POST" }), new URL("https://x/admin/skills"), {})).json()).ok, false);
    assert.equal(await feat.admin(hub, new Request("https://x/admin/other"), new URL("https://x/admin/other"), null), null);
  });
});
