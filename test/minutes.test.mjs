// Offline tests for src/feat/minutes.ts: arguments, the chunk plan and its cost, the generated bash (syntax,
// hostile links, and a real run with the local ffmpeg when there is one), transcripts, merging and rendering,
// and whole tool runs against a fake hub (node:sqlite), fake cloud computer, fake Workers AI and fake DeepSeek.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const M = await import("../src/feat/minutes.ts");
const { Plan } = await import("../src/budget.ts");
const library = (await import("../src/feat/library.ts")).default;
const search = (await import("../src/feat/search.ts")).default;
const feature = M.default;
const { WHISPER_MODEL } = await import("../src/feat/search.ts");

const bashOk = cmd => spawnSync("bash", ["-n", "-c", cmd]).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;

describe("arguments", () => {
  test("sources: file box, kept file, link; anything else is refused in plain words", () => {
    assert.deepEqual(M.parseArgs({ file: "X12" }).source, { kind: "box", ref: "x12" });
    assert.deepEqual(M.parseArgs({ file: "f7" }).source, { kind: "file", ref: "f7" });
    assert.deepEqual(M.parseArgs({ file: "[文件 https://a.b/c.mp3]" }).source, { kind: "url", ref: "https://a.b/c.mp3" });
    assert.match(M.parseArgs({}).error, /要给录音/);
    assert.match(M.parseArgs({ file: "会议.mp3" }).error, /认不出/);
    assert.match(M.parseArgs({ file: "https://a.b/x y.mp3" }).error, /认不出/, "a link with a space is not taken");
    assert.match(M.parseArgs({ file: "ftp://a.b/c" }).error, /认不出/);
  });
  test("language: Chinese by default, names and codes map, auto means detect, unknown is an error", () => {
    assert.equal(M.parseArgs({ file: "x1" }).language, "zh");
    assert.equal(M.parseArgs({ file: "x1", language: "英语" }).language, "en");
    assert.equal(M.parseArgs({ file: "x1", language: "JA" }).language, "ja");
    assert.equal(M.parseArgs({ file: "x1", language: "自动" }).language, "");
    assert.match(M.parseArgs({ file: "x1", language: "火星语" }).error, /不认识这个语言/);
  });
  test("focus and title are trimmed and bounded", () => {
    const p = M.parseArgs({ file: "x1", focus: "  预算 ", title: "周会".repeat(50) });
    assert.equal(p.focus, "预算");
    assert.ok(p.title.length <= 61);
  });
});

describe("chunk plan and cost", () => {
  test("5 minutes: one chunk, one bundle", () => {
    const p = M.chunkPlan(300);
    assert.equal(p.count, 1);
    assert.deepEqual(p.chunks[0], { index: 0, start: 0, seconds: 300, bytes: 1_200_000 });
    assert.equal(p.bundles, 1);
  });
  test("47 minutes: four full chunks and a 7-minute one, 11.3 MB in one bundle", () => {
    const p = M.chunkPlan(47 * 60);
    assert.deepEqual(p.chunks.map(c => c.seconds), [600, 600, 600, 600, 420]);
    assert.deepEqual(p.chunks.map(c => c.start), [0, 600, 1200, 1800, 2400]);
    assert.equal(p.bytes, 11_280_000);
    assert.equal(p.bundles, 1);
  });
  test("2 hours: twelve 2.4 MB chunks in two bundles, well inside one collect call", () => {
    const p = M.chunkPlan(7200);
    assert.equal(p.count, 12);
    assert.ok(p.chunks.every(c => c.seconds === 600 && c.bytes === 2_400_000));
    assert.equal(p.bundles, 2);
    assert.ok(p.chunks.every(c => c.bytes < 25 * 1024 * 1024));
  });
  test("neurons: a call per chunk at 46.63 a minute with the meter's margin, plus indexing", () => {
    assert.equal(M.callNeurons(600), 490.62);
    assert.equal(M.estimateNeurons(3600), 3004);
    assert.equal(M.estimateNeurons(300), Math.ceil(M.callNeurons(300) + 60));
    assert.ok(M.estimateNeurons(7200) > 5800 && M.estimateNeurons(7200) < 6100);
  });
  test("affordable minutes never promise more than the refusal check accepts", () => {
    for (let left = 0; left <= 8000; left += 37) {
      const can = M.affordableMinutes(left);
      if (can >= 1) assert.equal(M.refusal(can * 60, left, 999), null, "left=" + left + " can=" + can);
      assert.notEqual(M.refusal((can + 2) * 60, left, 999), null, "left=" + left);
    }
  });
  test("refusals say how long it is, what it needs and what today still covers", () => {
    assert.equal(M.refusal(3600, 8000, 120), null);
    const r = M.refusal(3600, 2000, 120);
    assert.match(r, /1 小时/);
    assert.match(r, /约 3004 neurons/);
    assert.match(r, /只够转约 3\d 分钟/);
    assert.match(M.refusal(3600, 300, 120), /已经不够转了/);
    assert.match(M.refusal(130 * 60, 8000, 120), /超过了一次最多 120 分钟/);
  });
});

describe("generated bash", () => {
  const W = mkdtempSync(join(tmpdir(), "minutes-"));
  const local = cmd => cmd.replaceAll("/work/", W + "/");
  test("the convert script and the fetch steps parse", () => {
    assert.ok(bashOk(M.convertScript("minutes-abc", 7200)));
    assert.ok(bashOk(M.fetchUrlCommand("minutes-abc", "https://example.com/a.mp3")));
    assert.ok(bashOk(M.moveCommand("minutes-abc", "minutes-abc.in")));
  });
  test("a hostile link reaches curl as one intact argument and nothing else runs", () => {
    const bin = join(W, "bin"); mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "curl"), '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done > "$CURL_LOG"\n');
    chmodSync(join(bin, "curl"), 0o755);
    const evil = "https://e.com/a.mp3?x=$(touch${IFS}PWNED)&y=`id`';touch${IFS}PWNED2;'\"$HOME\"";
    assert.ok(M.parseArgs({ file: evil }).source, "the parser takes it as a link");
    const log = join(W, "curl.log");
    execFileSync("bash", ["-c", local(M.fetchUrlCommand("minutes-h", evil))], { cwd: W, env: { ...process.env, PATH: bin + ":" + process.env.PATH, CURL_LOG: log } });
    const args = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(args[args.length - 1], evil);
    assert.ok(args.includes("--max-filesize"));
    assert.ok(!readdirSync(W).some(f => f.startsWith("PWNED")));
  });
  test("a failed download says so in Chinese", () => {
    const r = spawnSync("bash", ["-c", local(M.fetchUrlCommand("minutes-f", "http://127.0.0.1:9/none.mp3"))], { cwd: W, encoding: "utf8" });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /录音链接下载失败/);
  });
  test("real ffmpeg: chunks, bundles, byte offsets and durations line up", { skip: !hasFfmpeg && "no local ffmpeg" }, () => {
    const dir = "minutes-real"; mkdirSync(join(W, dir), { recursive: true });
    // 130 s: a tone over noise, as AAC in MP4 (a typical phone recording container)
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=130", "-f", "lavfi", "-i", "anoisesrc=d=130:a=0.05",
      "-filter_complex", "amix=inputs=2", "-ac", "2", "-ar", "44100", "-c:a", "aac", "-b:a", "96k", "-f", "mp4", join(W, dir, "in.media")]);
    const run = limit => spawnSync("bash", ["-c", local(M.convertScript(dir, limit, 30, 32, 300_000))], { cwd: W, encoding: "utf8" });
    const r = run(200);
    assert.equal(r.status, 0, r.stderr);
    const m = M.parseManifest(r.stdout);
    assert.equal(m.duration, 130);
    assert.equal(m.chunks.length, 5);
    assert.deepEqual(m.chunks.map(c => c.bundle), [0, 0, 1, 1, 1], "two 120 KB chunks (and the 40 KB tail) fit a 300 KB bundle");
    assert.ok(Math.abs(m.chunks.reduce((n, c) => n + c.seconds, 0) - 130) < 1);
    assert.ok(Math.abs(m.chunks[4].start - 120) < 0.5);
    const bundles = new Map(readdirSync(join(W, dir)).filter(f => f.endsWith(".bin")).map(f => [f, new Uint8Array(readFileSync(join(W, dir, f)))]));
    assert.deepEqual([...bundles.keys()].sort(), ["b0.bin", "b1.bin"]);
    assert.ok(!readdirSync(join(W, dir)).includes("in.media"), "the input is deleted after conversion");
    for (const c of m.chunks) {
      const bytes = M.sliceChunk(c, bundles);
      assert.ok(bytes && bytes.length === c.size);
      const f = join(W, "slice.mp3"); writeFileSync(f, bytes);
      const d = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }));
      assert.ok(Math.abs(d - c.seconds) < 0.6, "slice " + c.index + " decodes as " + d + " s");
    }
    // too long: refused before converting
    rmSync(join(W, dir), { recursive: true }); mkdirSync(join(W, dir));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=duration=130", "-c:a", "aac", "-f", "mp4", join(W, dir, "in.media")]);
    const t = M.parseManifest(run(100).stdout);
    assert.equal(t.tooLong, 130);
    assert.equal(t.chunks.length, 0);
    // not audio at all
    writeFileSync(join(W, dir, "in.media"), "just text, no sound");
    assert.equal(M.parseManifest(run(100).stdout).noAudio, true);
  });
  test("manifest parsing skips junk and keeps running offsets", () => {
    const m = M.parseManifest("DURATION 1250\nCHUNK 0 0 2400000 600.02\nwarning: x\nCHUNK 0 2400000 2400000 599.98\nCHUNK 1 0 200000 50.0\nCHUNK a b c d\n");
    assert.deepEqual(m.chunks.map(c => [c.bundle, c.offset, c.start]), [[0, 0, 0], [0, 2400000, 600.02], [1, 0, 1200]]);
    assert.equal(M.parseManifest("DURATION ?\nCHUNK 0 0 5 1").duration, null);
    assert.equal(M.sliceChunk({ bundle: 3, offset: 0, size: 5 }, new Map()), null);
    assert.equal(M.sliceChunk({ bundle: 0, offset: 4, size: 5 }, new Map([["b0.bin", new Uint8Array(8)]])), null, "a short bundle is caught");
  });
});

describe("transcripts", () => {
  test("stamps switch to hours from an hour on", () => {
    assert.equal(M.stamp(0), "00:00");
    assert.equal(M.stamp(754), "12:34");
    assert.equal(M.stamp(3725), "1:02:05");
    assert.equal(M.stamp(754, true), "0:12:34");
  });
  test("segments become minute lines stamped in recording time", () => {
    const lines = M.toLines(1200, "x", [{ start: 0, text: "开始" }, { start: 30, text: "继续" }, { start: 61, text: "下一分钟" }, { start: 70, text: "  " }]);
    assert.deepEqual(lines, [[1200, "开始 继续"], [1261, "下一分钟"]]);
    assert.deepEqual(M.toLines(600, " 只有文字 "), [[600, "只有文字"]]);
    assert.deepEqual(M.toLines(0, ""), []);
  });
  test("whisper's loops on silence are squeezed", () => {
    assert.equal(M.squeezeRepeats("好的。谢谢观看。谢谢观看。谢谢观看。谢谢观看。下面开始。"), "好的。谢谢观看。谢谢观看。下面开始。");
  });
  test("transcript marks failed chunks; groups stay under the limit", () => {
    const chunks = [{ start: 0, seconds: 600, lines: [[0, "甲".repeat(50)], [60, "乙".repeat(50)]] }, { start: 600, seconds: 600, failed: true }, { start: 1200, seconds: 600, lines: [[1210, "丙"]] }];
    const t = M.transcriptText(chunks, false);
    assert.match(t, /^\[00:00\] 甲+\n\[01:00\] 乙+\n\[10:00\] （这一段没转出来）\n\[20:10\] 丙$/);
    const g = M.groupLines(chunks, false, 70);
    assert.ok(g.length >= 3 && g.every(x => x.length <= 70));
    assert.equal(g.join("\n").split("\n").length, t.split("\n").length, "no line lost between groups");
    assert.equal(M.groupLines(chunks, false).length, 1);
  });
});

describe("notes", () => {
  const part = (o) => M.cleanNotes({ points: [], decisions: [], actions: [], questions: [], timeline: [], ...o });
  test("model output is cleaned: strings or objects, empty items dropped", () => {
    const n = M.cleanNotes({ decisions: ["推迟发布", { text: "", at: "1:00" }], actions: [{ text: "发预算表", who: "小王", due: "周三" }], timeline: [{ at: "00:00", text: "开场" }], extra: 1 });
    assert.deepEqual(n.decisions, [{ text: "推迟发布" }]);
    assert.deepEqual(n.actions, [{ task: "发预算表", who: "小王", due: "周三", at: undefined }]);
    assert.equal(M.parseJson("```json\n{\"a\":1}\n```").a, 1);
    assert.equal(M.parseJson("没有 JSON"), null);
  });
  test("mechanical merge keeps everything in order and drops exact repeats", () => {
    const u = M.mergeNotes([
      part({ points: ["预算"], decisions: [{ text: "推迟发布。", at: "05:00" }], actions: [{ task: "发预算表" }], timeline: [{ at: "00:00", text: "开场" }] }),
      part({ points: ["预算", "迁移"], decisions: [{ text: "推迟发布", at: "15:00" }, { text: "换供应商" }], questions: ["迁移方案"], timeline: [{ at: "10:00", text: "迁移" }] }),
    ]);
    assert.deepEqual(u.points, ["预算", "迁移"]);
    assert.deepEqual(u.decisions.map(d => d.text), ["推迟发布。", "换供应商"]);
    assert.equal(u.actions.length, 1);
    assert.equal(u.timeline.length, 2);
    assert.equal(u.summary, "预算；迁移");
  });
  test("rendering: sections only when there is something, stamps checked, the speaker note once and only when it matters", () => {
    const n = part({ summary: "讨论了三件事。", decisions: [{ text: "发布推迟到 12 月 1 日", at: "12:30" }], actions: [{ task: "发预算表", who: "小王", due: "下周三", at: "99:99" }, { task: "整理迁移方案" }], questions: ["迁移方案"], timeline: [{ at: "00:00", text: "开场" }, { at: "3:00:00", text: "不存在的时间" }] });
    const text = M.renderMinutes(n, { title: "周会", seconds: 1800 });
    assert.match(text, /^《周会》纪要 · 录音 30 分钟/);
    assert.match(text, /1\. 发布推迟到 12 月 1 日（12:30）/);
    assert.match(text, /1\. 发预算表，负责：小王，截止：下周三\n2\. 整理迁移方案\n/);
    assert.match(text, /【时间线】\n00:00 开场\n/);
    assert.ok(!text.includes("不存在的时间"));
    assert.equal(text.split(M.SPEAKER_NOTE).length, 2);
    const plain = M.renderMinutes(part({ summary: "一场讲座。", timeline: [{ at: "01:00", text: "引言" }] }), { title: "讲座", seconds: 4000 });
    assert.ok(!plain.includes(M.SPEAKER_NOTE));
    assert.match(plain, /0:01:00 引言/);
    assert.match(M.renderMinutes(part({ summary: "x" }), { title: "t", seconds: 1300, missing: 1 }), /有 1 段/);
  });
});

// ---------- whole runs ----------
function makeHub() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT); CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, src TEXT, name TEXT, size INTEGER);");
  db.exec(library.schema); db.exec(search.schema);
  const sql = { exec(q, ...binds) {
    const rows = binds.length || !q.trim().includes(";") ? db.prepare(q).all(...binds) : (db.exec(q), []);
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const hub = { sql, db, env: { DEEPSEEK_API_KEY: "test" },
    get(k) { const r = db.prepare("SELECT v FROM kv WHERE k=?").get(k); return r ? String(r.v) : null; },
    set(k, v) { db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); },
  };
  hub.plan = new Plan(hub);
  return hub;
}
function fakeAI(hub, o = {}) {
  const ai = { calls: [], embeds: 0, async run(model, input) {
    if (model !== WHISPER_MODEL) { ai.embeds++; return { shape: [input.text.length, 1024], data: input.text.map(() => new Array(1024).fill(0.5)), meta: { neurons: 1 } }; }
    ai.calls.push({ model, input });
    if (o.fail) throw new Error("down");
    const n = ai.calls.length;
    const neurons = o.neurons ? o.neurons(n) : 40;
    return { text: "第" + n + "段。我们决定推迟发布。", segments: [{ start: 1, text: "第" + n + "段。" }, { start: 65, text: "我们决定推迟发布。" }], usage: { neurons } };
  } };
  hub.env.AI = ai;
  return ai;
}
/** A 25-minute recording as the convert script would report it, with fake MP3 bytes per chunk. */
function fakeMachine(seconds = [600, 600, 300], o = {}) {
  const calls = [];
  const sizes = seconds.map(s => s * 4000);
  const lines = ["DURATION " + Math.floor(seconds.reduce((a, b) => a + b, 0))], bundle = new Uint8Array(sizes.reduce((a, b) => a + b, 0));
  let off = 0;
  seconds.forEach((s, i) => { bundle.fill(i + 1, off, off + sizes[i]); lines.push("CHUNK 0 " + off + " " + sizes[i] + " " + s); off += sizes[i]; });
  const computer = async req => {
    calls.push(req);
    if (req.commands[0].startsWith("rm -rf")) return { ok: true, steps: [{ exit: 0, stdout: "", stderr: "" }], files: [], seconds: 0.2 };
    const dir = req.collect[0].split("/")[0];
    if (o.stdout) return { ok: true, steps: [{ exit: 0, stdout: "" }, { exit: 0, stdout: o.stdout, stderr: "" }], files: [], seconds: 30 };
    return { ok: true, steps: [{ exit: 0, stdout: "", stderr: "" }, { exit: 0, stdout: lines.join("\n"), stderr: "" }], files: [{ name: dir + "/b0.bin", bytes: bundle }], seconds: 42 };
  };
  return { calls, computer };
}
function fakeDeepSeek() {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body), sys = body.messages[0].content;
    seen.push({ sys, user: body.messages[1].content });
    const content = sys.includes("分段记笔记")
      ? { points: ["进度"], decisions: [{ text: "推迟发布", at: "01:05" }], actions: [], questions: [], timeline: [{ at: "00:01", text: "开场" }] }
      : { title: "产品周会", summary: "讨论了发布时间。", decisions: [{ text: "推迟发布", at: "01:05" }], actions: [{ task: "通知客户", who: "", due: "" }], questions: [], timeline: [{ at: "00:01", text: "开场" }], focus: "" };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage: {} }), { status: 200 });
  };
  return seen;
}
function setup(o = {}) {
  const hub = makeHub(), machine = fakeMachine(o.seconds, o), ai = fakeAI(hub, o.ai), kept = [], said = [], scratch = new Map();
  let quota = o.quota ?? true;
  const cfg = { minutes_max_minutes: 120, minutes_daily: 3, ...(o.cfg || {}) };
  const host = {
    now: () => Date.now(), cfg: k => cfg[k], say: async t => { said.push(t); return true; },
    quota: async () => quota, computer: machine.computer, advice: () => null,
    keepFile: async (name, bytes) => { kept.push({ name, text: new TextDecoder().decode(bytes) }); return "f" + kept.length; },
    fileRef: async ref => (ref === "f3" ? { name: "周会录音.m4a", bytes: new Uint8Array(1000) } : null),
    scratch: (k, v) => { if (v === undefined) return scratch.has(k) ? JSON.parse(scratch.get(k)) : null; if (v === null) scratch.delete(k); else scratch.set(k, JSON.stringify(v)); return v; },
  };
  const tool = feature.tools({ hub, conv: "t:ag-minutes", askers: [{ name: "小李" }], host })[0];
  return { hub, host, tool, ai, machine, kept, said, scratch, setQuota: v => { quota = v; } };
}

describe("tool runs", () => {
  test("a 25-minute recording from a link: converted, transcribed per chunk, written up, kept and stored", async () => {
    const seen = fakeDeepSeek();
    const s = setup();
    const r = await s.tool.run({ file: "https://example.com/rec/周会.mp3", focus: "发布时间" });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.title, "产品周会");
    assert.match(r.minutes, /【定下来的事】\n1\. 推迟发布（01:05）/);
    assert.match(r.minutes, /转写不区分说话人/);
    assert.equal(r.transcript_file, "f1");
    // the machine got the fetch step with the link quoted, then the convert script; then its directory removed
    const [main, clean] = s.machine.calls;
    assert.match(main.commands[0], /curl .*'https:\/\/example\.com\/rec\/周会\.mp3'/);
    assert.match(main.commands[1], /-segment_time 600/);
    assert.deepEqual(main.collect, [main.collect[0].split("/")[0] + "/b*.bin"]);
    assert.match(clean.commands[0], /^rm -rf '\/work\/minutes-[a-z0-9]+' /);
    // whisper: one call per chunk, Chinese with the simplified-characters prompt, the right bytes each time
    assert.equal(s.ai.calls.length, 3);
    for (const c of s.ai.calls) { assert.equal(c.input.language, "zh"); assert.match(c.input.initial_prompt, /简体中文/); assert.equal(c.input.vad_filter, true); }
    const firsts = await Promise.all(s.ai.calls.map(async c => new Uint8Array(await new Response(c.input.audio.body).arrayBuffer())));
    assert.deepEqual(firsts.map(b => [b.length, b[0]]).sort((a, b) => a[1] - b[1]), [[2400000, 1], [2400000, 2], [1200000, 3]]);
    assert.equal(s.hub.plan.used("ai_neurons") >= 120, true, "used neurons are counted");
    // transcript: stamps in recording time from each chunk's offset
    const txt = s.kept[0].text;
    assert.match(s.kept[0].name, /^产品周会-转写\.txt$/);
    assert.match(txt, /\[00:01\] 第\d段。\n\[01:05\] 我们决定推迟发布。/);
    assert.match(txt, /\[10:01\] /);
    assert.match(txt, /\[20:01\] /);
    // library row, findable by keyword, and passages for search by meaning
    const doc = s.hub.db.prepare("SELECT * FROM doc").get();
    assert.equal(doc.kind, "minutes");
    assert.equal(doc.url, "minutes:https://example.com/rec/周会.mp3");
    assert.match(doc.title, /录音纪要：产品周会/);
    assert.match(doc.text, /——完整转写——/);
    assert.equal(r.library_id, Number(doc.id));
    assert.equal(s.scratch.size, 0, "scratch cleared after success");
    assert.ok(s.ai.embeds >= 1 && s.hub.db.prepare("SELECT COUNT(*) n FROM passage WHERE kind='doc' AND ref=?").get(String(doc.id)).n >= 1, "indexed for search by meaning");
    assert.ok(seen.some(x => x.sys.includes("群友特别关心：发布时间")));
    assert.equal(s.said.length, 1);
  });
  test("a kept chat file goes in through files and is moved into the work directory", async () => {
    fakeDeepSeek();
    const s = setup();
    const r = await s.tool.run({ file: "f3" });
    assert.equal(r.ok, true, r.error);
    const main = s.machine.calls[0];
    assert.equal(main.files.length, 1);
    assert.match(main.files[0].name, /^minutes-[a-z0-9]+\.in$/);
    assert.match(main.commands[0], /mv -f '\/work\/minutes-[a-z0-9]+\.in' '\/work\/minutes-[a-z0-9]+\/in\.media'/);
    assert.match(s.machine.calls[1].commands[0], /\.in'$/);
  });
  test("refused before the machine starts when today's allowance is nearly gone", async () => {
    const s = setup();
    s.hub.plan.add("ai_neurons", 7700);
    const r = await s.tool.run({ file: "x5" });
    assert.equal(r.ok, false);
    assert.match(r.error, /今天的 AI 额度只剩 300/);
    assert.equal(s.machine.calls.length, 0);
  });
  test("too long for what is left today: the machine reports it and nothing is transcribed", async () => {
    const s = setup({ stdout: "DURATION 4000\nTOOLONG 4000\n" });
    s.hub.plan.add("ai_neurons", 6000);
    const r = await s.tool.run({ file: "https://e.com/a.mp4" });
    assert.equal(r.ok, false);
    assert.match(r.error, /1 小时 7 分钟.*只够转约 3\d 分钟/);
    assert.equal(s.ai.calls.length, 0);
    assert.match(s.machine.calls[0].commands[1], /-gt 1980 \]/, "the limit passed in is what today covers (33 minutes)");
  });
  test("over the length cap", async () => {
    const s = setup({ stdout: "DURATION 9000\nTOOLONG 9000\n", cfg: { minutes_max_minutes: 120 } });
    const r = await s.tool.run({ file: "https://e.com/a.mp4" });
    assert.match(r.error, /超过了一次最多 120 分钟/);
  });
  test("no sound, failed download, daily cap", async () => {
    let s = setup({ stdout: "NOAUDIO\n" });
    assert.match((await s.tool.run({ file: "https://e.com/a.txt" })).error, /没有声音/);
    s = setup();
    s.machine.computer = undefined;
    s.host.computer = async req => req.commands[0].startsWith("rm") ? { ok: true, steps: [], files: [], seconds: 0 } : { ok: false, steps: [{ exit: 1, stdout: "", stderr: "curl: (22)\n录音链接下载失败（打不开）" }], files: [], seconds: 3 };
    const t = feature.tools({ hub: s.hub, conv: "t:ag-minutes", askers: [], host: s.host })[0];
    assert.equal((await t.run({ file: "https://e.com/a.mp3" })).error, "录音链接下载失败（打不开）");
    s = setup({ quota: false });
    assert.match((await s.tool.run({ file: "https://e.com/a.mp3" })).error, /次数用完了/);
  });
  test("allowance runs out midway: progress kept; the next attempt only pays for what is missing", async () => {
    fakeDeepSeek();
    // the first call reports a huge use, so the fourth chunk no longer fits today
    const s = setup({ seconds: [600, 600, 600, 600], ai: { neurons: n => (n === 1 ? 7500 : 40) } });
    const r1 = await s.tool.run({ file: "https://e.com/long.mp3" });
    assert.equal(r1.ok, false);
    assert.match(r1.error, /3\/4 段已经转好/);
    assert.equal(s.ai.calls.length, 3);
    assert.equal(s.scratch.size, 1);
    // next day
    s.hub.db.exec("DELETE FROM kv WHERE k LIKE 'plan:day:%'");
    const r2 = await s.tool.run({ file: "https://e.com/long.mp3" });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(s.ai.calls.length, 4, "only the missing chunk was transcribed again");
    assert.equal(s.machine.calls.filter(c => !c.commands[0].startsWith("rm")).length, 2);
    assert.match(s.machine.calls[2].commands[1], /-gt 2402 \]/, "the resumed run is limited to the known length");
    assert.equal(s.said.length, 1, "no second 'starting' line");
  });
  test("a restart after transcription skips the machine entirely", async () => {
    fakeDeepSeek();
    const s = setup();
    const key = M.stateKey({ kind: "url", ref: "https://e.com/r.mp3" }, "zh");
    s.host.scratch(key, { v: 1, src: "https://e.com/r.mp3", lang: "zh", at: Date.now(), seconds: 700, name: "r.mp3", chunks: [{ start: 0, seconds: 600, lines: [[0, "大家好，我们决定推迟发布。"]] }, { start: 600, seconds: 100, lines: [[600, "散会。"]] }] });
    const r = await s.tool.run({ file: "https://e.com/r.mp3" });
    assert.equal(r.ok, true, r.error);
    assert.equal(s.machine.calls.length, 0);
    assert.equal(s.ai.calls.length, 0);
  });
  test("a service that is down stops after two chunks instead of eating the allowance", async () => {
    fakeDeepSeek();
    const s = setup({ seconds: [600, 600, 600, 600, 600, 600], ai: { fail: true } });
    const r = await s.tool.run({ file: "https://e.com/x.mp3" });
    assert.equal(r.ok, false);
    assert.match(r.error, /转写服务现在出错/);
    // own call + the plain gateway per chunk; the three in flight finish, one more may have started
    assert.ok(s.ai.calls.length <= 8, "calls: " + s.ai.calls.length);
  });
  test("long transcripts are taken in parts and merged", async () => {
    const seen = fakeDeepSeek();
    const s = setup({ seconds: new Array(9).fill(600) });
    const embed = s.hub.env.AI.run;
    s.hub.env.AI.run = async (model, input) => model !== WHISPER_MODEL ? embed(model, input) : ({ text: "很长".repeat(3000), segments: Array.from({ length: 10 }, (_, i) => ({ start: i * 60, text: "这一分钟讲了很多内容".repeat(60) })), usage: { neurons: 40 } });
    const r = await s.tool.run({ file: "https://e.com/big.mp3" });
    assert.equal(r.ok, true, r.error);
    const parts = seen.filter(x => x.sys.includes("分段记笔记")), merges = seen.filter(x => x.sys.includes("合并成一份纪要"));
    assert.ok(parts.length >= 4, "parts: " + parts.length);
    assert.equal(merges.length, 1);
    assert.ok(parts.every(p => p.user.length < M.GROUP_CHARS + 200));
    assert.match(r.minutes, /1:30:00|录音 1 小时 30 分钟/);
  });
});

describe("feature", () => {
  test("registers one long work tool, its tunables and about lines", () => {
    assert.equal(feature.name, "minutes");
    assert.deepEqual(Object.keys(feature.tunables), ["minutes_max_minutes", "minutes_daily"]);
    assert.equal(feature.tunables.minutes_max_minutes.default, 120);
    const t = setup().tool;
    assert.deepEqual([t.name, t.long, t.work, t.slow], ["minutes", true, true, true]);
    assert.deepEqual(t.parameters.required, ["file"]);
    assert.ok(feature.about.length >= 3);
  });
});
