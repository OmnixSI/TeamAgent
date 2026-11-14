// Offline tests for the subtitle feature: SRT/ASS formatting and timing arithmetic, line breaking for Chinese
// and English, chunk offsets, cue building and settling, translation batches with a fake model (including
// wrong-count answers), the generated bash (syntax, hostile names, and a real run of the audio cutting when
// ffmpeg and python3 exist here), estimates, and the tool's refusals and delivery with a fake hub and machine.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import S from "../src/feat/subtitle.ts";
import * as M from "../src/feat/subtitle.ts";
import { Plan, DAILY } from "../src/budget.ts";

const HOSTILE = `a'b "c" $(touch PWNED) \`touch PWNED\` ;touch PWNED; 奶蛙 \\ 空 格`;
const bashOk = c => { const r = spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + "\n" + c.slice(0, 400)); };
// Real runs of programs that happen to be installed (ffmpeg, tesseract) only when asked for with SKILLS_REAL=1:
// another machine may carry an old build of them, and the normal check must not depend on that.
const HAS_FF = process.env.SKILLS_REAL === "1" && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;
const HAS_PY = spawnSync("python3", ["-c", "1"], { stdio: "ignore" }).status === 0;
const sh = M.shape;

// Word timings as whisper gives them: English words carry a leading space, Chinese ones none.
const enWords = (text, t0 = 0, per = 0.3, pauseAfter = {}) => {
  let t = t0; const out = [];
  for (const [i, w] of text.split(" ").entries()) { out.push({ text: " " + w, start: t, end: t + per - 0.05 }); t += per + (pauseAfter[i] || 0); }
  return out;
};
const zhWords = (text, t0 = 0, per = 0.25) => { let t = t0; return [...text].map(c => { const w = { text: c, start: t, end: t + per - 0.03 }; t += per; return w; }); };

const checkCues = (cues, min = 1) => {
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    assert.ok(c.end > c.start, "end after start " + JSON.stringify(c));
    assert.ok(c.end - c.start >= min - 0.06, "shown at least about a second " + JSON.stringify(c));
    if (i) assert.ok(c.start >= cues[i - 1].end, "no overlap " + JSON.stringify([cues[i - 1], c]));
  }
};

describe("time formats", () => {
  test("srtTime", () => {
    assert.equal(M.srtTime(0), "00:00:00,000");
    assert.equal(M.srtTime(3725.4), "01:02:05,400");
    assert.equal(M.srtTime(59.9996), "00:01:00,000", "rounding carries into the next minute");
    assert.equal(M.srtTime(0.0004), "00:00:00,000");
    assert.equal(M.srtTime(36000 + 1.001), "10:00:01,001");
    assert.equal(M.srtTime(-3), "00:00:00,000");
  });
  test("assTime counts centiseconds", () => {
    assert.equal(M.assTime(3725.4), "1:02:05.40");
    assert.equal(M.assTime(59.996), "0:01:00.00");
    assert.equal(M.assTime(0.123), "0:00:00.12");
  });
  test("toSrt numbers cues from 1 with blank lines between", () => {
    const srt = M.toSrt([{ start: 0.5, end: 2, text: "Hello there." }, { start: 2.5, end: 4.25, text: "第二句", tr: "Second" }], "bilingual");
    assert.equal(srt, "1\n00:00:00,500 --> 00:00:02,000\nHello there.\n\n2\n00:00:02,500 --> 00:00:04,250\n第二句\nSecond\n");
    assert.equal(M.toSrt([{ start: 0, end: 1, text: "a", tr: "甲" }], "translated"), "1\n00:00:00,000 --> 00:00:01,000\n甲\n");
    assert.equal(M.toSrt([{ start: 0, end: 1, text: "a" }], "translated"), "1\n00:00:00,000 --> 00:00:01,000\na\n", "no translation falls back to the original");
    assert.ok(!M.toSrt([{ start: 0, end: 1, text: M.tidy("a --> b") }]).includes("a -->"), "an arrow in the text cannot break the format");
  });
});

describe("line breaking", () => {
  test("English wraps at spaces into balanced lines of at most 42", () => {
    const t = "Good subtitles are short, they stay on screen long enough to read, and they never overlap.";
    const lines = M.wrap(t, 42);
    assert.equal(lines.join(" "), t);
    assert.ok(lines.every(l => l.length <= 42), JSON.stringify(lines));
    assert.ok(lines.length === 3 && Math.abs(lines[0].length - lines[1].length) < 20, JSON.stringify(lines));
    assert.deepEqual(M.wrap("short line", 42), ["short line"]);
    assert.ok(M.wrap("x".repeat(100), 42).every(l => l.length <= 42), "a word longer than a line is cut");
  });
  test("Chinese wraps at most 16 a line, prefers punctuation, never starts a line with it", () => {
    const t = "今天我们来聊一聊字幕，好的字幕要短而且要清楚";
    const lines = M.wrap(t, 16);
    assert.equal(lines.join(""), t);
    assert.ok(lines.every(l => [...l].length <= 16), JSON.stringify(lines));
    assert.ok(lines.every(l => !/^[，。！？、]/.test(l)), JSON.stringify(lines));
    assert.ok(lines[0].endsWith("，"), "breaks after a comma near the middle: " + JSON.stringify(lines));
  });
  test("tidy makes Chinese punctuation full width and drops the trailing comma or stop", () => {
    assert.equal(M.tidy("大家好,今天我们来聊一聊字幕,"), "大家好，今天我们来聊一聊字幕");
    assert.equal(M.tidy("真的吗?"), "真的吗？");
    assert.equal(M.tidy("版本 3.5 发布了."), "版本 3.5 发布了");
    assert.equal(M.tidy("  Hello,   world.  "), "Hello, world.");
  });
});

describe("whisper answers and offsets", () => {
  // Shape measured on the binding (2026-11-15).
  const answer = {
    text: "Hello everyone, today we will talk.", transcription_info: { language: "en", duration: 17.05 },
    segments: [
      { start: 0, end: 2.1, text: " Hello everyone, today", avg_logprob: -0.04, no_speech_prob: 0, words: [{ word: " Hello", start: 0, end: 0.24 }, { word: " everyone,", start: 0.24, end: 0.72 }, { word: " today", start: 1.22, end: 1.44 }] },
      { start: 3, end: 5, text: " we will talk.", avg_logprob: -0.1, no_speech_prob: 0 },
      { start: 6, end: 9, text: "字幕由Amara.org社区提供", avg_logprob: -0.2, no_speech_prob: 0.2 },
      { start: 10, end: 12, text: " mm", avg_logprob: -1.2, no_speech_prob: 0.9, words: [{ word: " mm", start: 10, end: 11 }] },
    ],
  };
  test("each piece's words move by its start time", () => {
    const w = M.wordsFrom(answer, 600.52);
    assert.equal(w[0].start, 600.52);
    assert.ok(Math.abs(w[2].end - 601.96) < 1e-9);
    assert.equal(w.find(x => /mm/.test(x.text)), undefined, "probable silence dropped");
    assert.equal(w.find(x => /Amara/.test(x.text)), undefined, "known invention dropped");
  });
  test("a segment without word timings is spread over its span", () => {
    const w = M.wordsFrom(answer, 100).filter(x => x.start >= 103);
    assert.equal(w.map(x => x.text).join(""), " we will talk.");
    assert.equal(w[0].start, 103);
    assert.ok(Math.abs(w[w.length - 1].end - 105) < 1e-9);
    for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].end - 1e-9);
  });
  test("plain text with a duration and nothing else still gives one timed piece", () => {
    assert.deepEqual(M.wordsFrom({ text: "你好", transcription_info: { duration: 2 } }, 5), [{ text: "你好", start: 5, end: 7 }]);
    assert.deepEqual(M.wordsFrom({}, 0), []);
  });
  test("cues across two pieces keep absolute times", () => {
    const a = { segments: [{ start: 0, end: 3, text: "x", words: enWords("First piece ends here.", 597, 0.5).map(w => ({ word: w.text, start: w.start - 0, end: w.end })) }] };
    const b = { segments: [{ start: 0, end: 3, text: "y", words: [{ word: " Second", start: 0.1, end: 0.5 }, { word: " piece.", start: 0.5, end: 1.2 }] }] };
    const words = [...M.wordsFrom(a, 0), ...M.wordsFrom(b, 599.8)];
    const cues = M.buildCues(words, sh(false, false));
    assert.equal(cues.length, 2);
    assert.equal(cues[1].text, "Second piece.");
    assert.ok(Math.abs(cues[1].start - 599.9) < 0.01 || cues[1].start >= cues[0].end, JSON.stringify(cues));
    assert.match(M.toSrt(cues), /00:09:59,9\d\d --> /);
  });
});

describe("cues", () => {
  test("English: sentence ends close a cue, long sentences split at commas, limits hold", () => {
    const words = enWords("Hello everyone. Today we will talk about subtitles, which are harder than they look, because good subtitles are short, they stay on screen long enough to read, and they never overlap with each other at all. Next.", 0, 0.32);
    const cues = M.buildCues(words, sh(false, false));
    assert.equal(cues[0].text, "Hello everyone.");
    assert.ok(cues.every(c => c.text.length <= 84), JSON.stringify(cues.map(c => c.text)));
    assert.ok(cues.every(c => c.end - c.start <= 7 + 1.5 + 1e-9));
    assert.ok(cues.slice(1, -1).some(c => /,$/.test(c.text)), "split at a comma: " + JSON.stringify(cues.map(c => c.text)));
    assert.equal(cues.map(c => c.text).join(" ").replace(/\s+/g, " "), words.map(w => w.text).join("").trim());
    checkCues(cues);
  });
  test("Chinese: at most 32 characters a cue (18 when a translation goes under), punctuation tidied", () => {
    const text = "大家好,今天我们来聊一聊字幕,好的字幕要短,要在屏幕上停留足够长的时间,而且不能互相重叠,停顿一下,我们继续。";
    for (const bi of [false, true]) {
      const cues = M.buildCues(zhWords(text), sh(true, bi));
      assert.ok(cues.every(c => [...c.text].length <= (bi ? 18 : 32) + 1), bi + JSON.stringify(cues.map(c => c.text)));
      assert.ok(cues.every(c => !/[,，。]$/.test(c.text)));
      assert.ok(cues.every(c => !/[一-鿿],/.test(c.text)), "half-width commas converted");
      checkCues(cues);
    }
  });
  test("a long pause starts a new cue", () => {
    const words = enWords("one two three four five six", 0, 0.3, { 2: 2 });
    const cues = M.buildCues(words, sh(false, false));
    assert.deepEqual(cues.map(c => c.text), ["one two three", "four five six"]);
  });
  test("short and crowded cues are lengthened or merged; never overlapping", () => {
    const sh0 = sh(false, false);
    const cues = M.settle([
      { start: 0, end: 0.2, text: "Hi." }, { start: 0.3, end: 0.5, text: "Yes." }, { start: 5, end: 5.3, text: "Okay." },
      { start: 5.2, end: 7, text: "Overlapping start." }, { start: 7.05, end: 7.2, text: "No." }, { start: 7.3, end: 9, text: "Then a longer final line." },
    ], sh0);
    checkCues(cues);
    assert.ok(cues.some(c => /Hi\. Yes\./.test(c.text)), JSON.stringify(cues));
    const lone = M.settle([{ start: 10, end: 10.2, text: "Okay." }], sh0);
    assert.ok(lone[0].end - lone[0].start >= 1, "extended into the silence after it");
    const read = M.settle([{ start: 0, end: 1.2, text: "这是一句需要多读一会儿的比较长的中文字幕内容" }, { start: 10, end: 11, text: "下一句" }], sh(true, false));
    assert.ok(read[0].end > 1.2 && read[0].end <= 2.7 + 1e-9, "longer text stays longer, at most 1.5 s past the speech: " + read[0].end);
  });
  test("cueLines for each mode", () => {
    const c = { start: 0, end: 2, text: "This is the original line of the subtitle, which is long enough to wrap.", tr: "这是字幕的原文，长到需要换行才能放得下的一句中文" };
    assert.equal(M.cueLines(c, "original").length, 2);
    assert.ok(M.cueLines(c, "translated").every(l => [...l].length <= 16));
    assert.equal(M.cueLines(c, "bilingual").length, 4);
  });
});

describe("ASS for burning", () => {
  const cues = [{ start: 1, end: 3, text: "Hello {there}\\n", tr: "你好" }, { start: 3.5, end: 5, text: "第二句" }];
  test("header sized to the picture and escaped text", () => {
    const a = M.toAss(cues, "bilingual", 1280, 720);
    assert.match(a, /PlayResX: 1280\nPlayResY: 720/);
    assert.match(a, /Dialogue: 0,0:00:01\.00,0:00:03\.00,Default,,0,0,0,,\{\\fs\d+\}Hello （there）＼n\\N\{\\fs\d+\}你好/);
    assert.match(a, /Dialogue: 0,0:00:03\.50,0:00:05\.00,Default,,0,0,0,,第二句$/m);
    assert.match(a, /Style: Default,Noto Sans CJK SC,/);
  });
  test("portrait videos get a font small enough for 16 characters across", () => {
    const fs = a => Number(a.match(/Style: Default,Noto Sans CJK SC,(\d+)/)[1]);
    const wide = [{ start: 0, end: 2, text: "一二三四五六七八九十一二三四五六" }];
    const land = fs(M.toAss(wide, "original", 1920, 1080)), port = fs(M.toAss(wide, "original", 1080, 1920));
    assert.ok(port * 16 <= 1080 * 0.95, "fits across: " + port);
    assert.ok(land * 16 <= 1920 * 0.95 && land <= 1080 * 0.06, String(land));
    const narrow = fs(M.toAss([{ start: 0, end: 2, text: "Short" }], "original", 1280, 720));
    assert.ok(narrow >= 30 && narrow <= 720 * 0.06, "short lines keep a normal size: " + narrow);
  });
});

describe("translation batches", () => {
  const texts = Array.from({ length: 95 }, (_, i) => "line " + (i + 1));
  const good = (env, messages) => Promise.resolve(messages[1].content.split("\n").map(l => { const [n, t] = l.split("|"); return n + "|译" + t; }).join("\n"));
  test("parseNumbered wants exactly the numbers asked for", () => {
    assert.deepEqual([...M.parseNumbered("1|一\n2｜二\n", [1, 2]).entries()], [[1, "一"], [2, "二"]]);
    assert.equal(M.parseNumbered("1|一", [1, 2]), null, "one short");
    assert.equal(M.parseNumbered("1|一\n2|二\n3|三", [1, 2]), null, "an extra number");
    assert.equal(M.parseNumbered("1|一\n1|又一\n2|二", [1, 2]), null, "a repeat");
    assert.equal(M.parseNumbered("1|\n2|二", [1, 2]), null, "an empty line");
    assert.ok(M.parseNumbered("好的，译文如下：\n1|一\n2|二", [1, 2]), "chatter without a number is ignored");
  });
  test("batches of 40 keep their numbering and order", async () => {
    let calls = 0;
    const r = await M.translateAll({}, texts, "中文", "t", (e, m, n) => { calls++; assert.ok(n > 300 && n <= 8000); return good(e, m); });
    assert.equal(calls, 3);
    assert.equal(r.missing, 0);
    assert.equal(r.out[0], "译line 1");
    assert.equal(r.out[94], "译line 95");
    assert.ok(r.out.every((x, i) => x === "译line " + (i + 1)));
  });
  test("a wrong-count answer is asked again once", async () => {
    const seen = new Map();
    const r = await M.translateAll({}, texts, "中文", "", async (e, m) => {
      const first = m[1].content.split("\n")[0], n = (seen.get(first) || 0) + 1; seen.set(first, n);
      if (first.startsWith("41|") && n === 1) return (await good(e, m)).split("\n").slice(0, -1).join("\n");   // one line lost
      return good(e, m);
    });
    assert.equal(r.calls, 4);
    assert.equal(r.missing, 0);
    assert.equal(r.out[79], "译line 80");
  });
  test("two wrong answers leave that batch untranslated, others fine", async () => {
    const r = await M.translateAll({}, texts, "中文", "", async (e, m) => m[1].content.startsWith("81|") ? "81|只有一行" : good(e, m));
    assert.equal(r.missing, 15);
    assert.equal(r.out[80], null);
    assert.equal(r.out[79], "译line 80");
    const thrown = await M.translateAll({}, ["a"], "中文", "", async () => { throw new Error("down"); });
    assert.deepEqual(thrown, { out: [null], missing: 1, calls: 2 });
  });
  test("langCode", () => {
    assert.equal(M.langCode("中文"), "zh"); assert.equal(M.langCode("简体中文"), "zh"); assert.equal(M.langCode("英文"), "en");
    assert.equal(M.langCode("English"), "en"); assert.equal(M.langCode("日语"), "ja"); assert.equal(M.langCode("pt"), "pt"); assert.equal(M.langCode("火星文"), "");
  });
});

describe("sources and commands", () => {
  test("parseSource", () => {
    assert.deepEqual(M.parseSource("[视频 123]"), { kind: "seq", seq: 123 });
    assert.deepEqual(M.parseSource("123"), { kind: "seq", seq: 123 });
    assert.deepEqual(M.parseSource("X12"), { kind: "box", ref: "x12" });
    assert.deepEqual(M.parseSource("f3"), { kind: "file", ref: "f3" });
    assert.equal(M.parseSource("https://a.com/v.MP4?x=1").direct, true);
    assert.equal(M.parseSource("https://www.youtube.com/watch?v=abc").direct, false);
    assert.equal(M.parseSource("https://a.com/x'$(id)"), null);
    assert.equal(M.parseSource("随便"), null);
  });
  test("every generated command parses, hostile names stay quoted", () => {
    const dir = "/work/sub-ab12cd34";
    for (const limit of [0, 3600]) {
      bashOk(M.fetchCommand({ kind: "curl", url: "https://a.com/" + encodeURI(HOSTILE) + ".mp4" }, dir, limit));
      bashOk(M.fetchCommand({ kind: "page", url: "https://b.com/v?x=" + HOSTILE }, dir, limit));
      bashOk(M.fetchCommand({ kind: "moved", path: "/work/" + HOSTILE + ".mp4", pre: "( d='/work/x'; true )" }, dir, limit));
    }
    bashOk(M.prepCommand(dir, 3600, true));
    bashOk(M.prepCommand(dir, 600, false));
    bashOk(M.burnCommand(dir, "/work/sub-ab12cd34.ass", "veryfast", 900, "( f='" + "x" + "'; echo up )"));
    bashOk(M.burnCommand(dir, "/work/" + HOSTILE, "superfast'; rm -rf /", 900, "true"));
    assert.ok(!M.burnCommand(dir, "a", "superfast'; rm -rf /", 900, "true").includes("rm -rf /"), "preset is one of two words");
  });
  test("a hostile file name is moved into place literally", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub-"));
    const src = path.join(tmp, HOSTILE + ".mp4");
    fs.writeFileSync(src, "x");
    const r = spawnSync("bash", ["-c", M.fetchCommand({ kind: "moved", path: src }, path.join(tmp, "run"), 0)], { cwd: tmp, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.existsSync(path.join(tmp, "run", "in.bin")));
    assert.ok(!fs.existsSync(path.join(tmp, "PWNED")) && !fs.existsSync(path.join(tmp, "run", "PWNED")));
  });
  test("parsePrep reads length, size, rotation and pieces", () => {
    const p = M.parsePrep("TITLE 一个 视频\nDURATION 1300.52\nPROBE width=1920\nPROBE height=1080\nPROBE rotation=-90\nCHUNK c00.mp3,0.000000,433.9\nCHUNK c01.mp3,433.9,867.02\nnoise");
    assert.deepEqual(p, { duration: 1300.52, title: "一个 视频", width: 1080, height: 1920, tooLong: false, noAudio: false, chunks: [{ file: "c00.mp3", start: 0, end: 433.9 }, { file: "c01.mp3", start: 433.9, end: 867.02 }] });
    assert.equal(M.parsePrep("DURATION 9000\nTOO_LONG").tooLong, true);
    assert.equal(M.parsePrep("NOAUDIO").noAudio, true);
  });
  test("real run: sound cut at pauses into pieces that cover the whole length", { skip: !(HAS_FF && HAS_PY) && "needs ffmpeg and python3" }, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sub-"));
    const src = path.join(tmp, "src.mp3");
    // 1300 s of tone, silent for the last 2 s of every 7.
    const mk = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=f=300:d=1300", "-af", "volume='if(lt(mod(t,7),5),1,0)':eval=frame", "-ac", "1", "-ar", "16000", "-b:a", "24k", src]);
    assert.equal(mk.status, 0, String(mk.stderr));
    const dir = path.join(tmp, "run");
    const run = limit => { const copy = path.join(tmp, "copy.mp3"); fs.copyFileSync(src, copy); return spawnSync("bash", ["-c", "set -o pipefail\n" + M.fetchCommand({ kind: "moved", path: copy }, dir, 0) + "\n" + M.prepCommand(dir, limit, false)], { encoding: "utf8", env: { ...process.env, PY: "python3" } }); };
    const short = run(600);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(M.parsePrep(short.stdout).tooLong, true);
    const r = run(3600);
    assert.equal(r.status, 0, r.stderr);
    const p = M.parsePrep(r.stdout);
    assert.ok(Math.abs(p.duration - 1300) < 1, r.stdout);
    assert.equal(p.chunks.length, 3, r.stdout);
    assert.equal(p.chunks[0].start, 0);
    for (let i = 1; i < 3; i++) {
      assert.ok(Math.abs(p.chunks[i].start - p.chunks[i - 1].end) < 0.05, "pieces are contiguous");
      const ideal = 1300 * i / 3, cut = p.chunks[i].start;
      assert.ok(Math.abs(cut - ideal) <= 45, "cut near " + ideal + ": " + cut);
      assert.ok(cut % 7 > 5 - 0.1, "cut lands in a pause: " + cut);
    }
    assert.ok(Math.abs(p.chunks[2].end - 1300) < 1);
    for (const c of p.chunks) assert.ok(fs.statSync(path.join(dir, c.file)).size > 1000);
    assert.ok(!fs.existsSync(path.join(dir, "a.wav")) && !fs.readdirSync(dir).some(f => f.startsWith("in.")), "wav and video removed when not burning");
  });
});

describe("estimates", () => {
  test("neurons and the length today's allowance covers", () => {
    assert.equal(M.neuronEstimate(60), Math.ceil(46.63 * 1.05 + 2));
    assert.ok(M.neuronEstimate(3600, 6) > 2900 && M.neuronEstimate(3600, 6) < 3000);
    assert.equal(M.secondsCovered(0), 0);
    const s = M.secondsCovered(8000);
    assert.ok(M.neuronEstimate(s, 6) <= 8000 + 2 && s > 9000, String(s));
  });
  test("burn plan: preset by length, refuses past the encode limit and says what fits", () => {
    assert.equal(M.burnPlan(300, 1280, 720).preset, "veryfast");
    const forty = M.burnPlan(2400, 1280, 720);
    assert.equal(forty.preset, "superfast"); assert.equal(forty.fits, true);
    const hour = M.burnPlan(3600, 1280, 720);
    assert.equal(hour.fits, false);
    assert.equal(hour.maxMinutes, Math.floor(1480 / 0.45 / 60));
    assert.ok(M.burnPlan(2400, 1920, 1080).encode > forty.encode, "bigger pictures take longer");
    assert.ok(M.burnPlan(2400, 1280, 720, { veryfast: 2, superfast: 1.5 }).fits === false, "measured slow rates are used");
  });
});

// ---------- the tool with a fake hub, host and machine ----------

function rig(o = {}) {
  const kv = new Map();
  const hub = { get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => kv.set(k, String(v)), env: { AI: null } };
  hub.plan = new Plan(hub);
  if (o.neuronsUsed) hub.plan.add("ai_neurons", o.neuronsUsed);
  const sent = [], said = [], calls = [], ai = [];
  hub.env.AI = { run: async (model, input) => {
    ai.push({ model, input });
    const i = ai.length - 1;
    return { text: "x", transcription_info: { language: o.lang || "en" }, usage: { neurons: 10 },
      segments: [{ start: 0, end: 4, text: "y", words: [{ word: " Hello", start: 0.2, end: 0.6 }, { word: " piece", start: 0.6, end: 1 }, { word: " " + (i + 1) + ".", start: 1, end: 1.5 }] }] };
  } };
  const duration = o.duration || 1300;
  const host = {
    cfg: k => ({ subtitle_max_minutes: 60, subtitle_daily: 6, ...(o.cfg || {}) })[k],
    quota: async () => o.quota !== false,
    videoUrl: n => (n === 7 ? "https://qq.example/v.mp4" : ""),
    boxIn: ref => (ref === "x3" ? { name: "big talk.mp4", command: "( d='/work/big talk.mp4'; true )" } : null),
    boxOut: (p, name) => ({ command: "UPLOAD " + p, claim: async () => ({ ref: "x9", name, size: 40 * 1048576, link: "https://box/x9" }) }),
    fileRef: async () => null,
    advice: (m, n) => (o.advice && m === "ai_neurons" ? "今天额度紧" : null),
    say: async t => { said.push(t); return true; },
    sendFile: async (name, bytes) => { sent.push({ kind: "file", name, bytes }); return { ok: true }; },
    sendVideo: async (name, bytes) => { sent.push({ kind: "video", name, bytes }); return { ok: true }; },
    keepFile: async () => "f42",
    computer: async req => {
      calls.push(req);
      if (calls.length === 1) {
        if (o.tooLong) return { ok: true, steps: [{ exit: 0, stdout: "DURATION " + duration + "\nTOO_LONG", stderr: "" }], files: [], seconds: 3 };
        const n = Math.min(6, Math.ceil(duration / 600)), cuts = Array.from({ length: n + 1 }, (_, i) => duration * i / n);
        const chunks = cuts.slice(0, -1).map((a, i) => "CHUNK c0" + i + ".mp3," + a.toFixed(6) + "," + cuts[i + 1].toFixed(6)).join("\n");
        return { ok: true, steps: [{ exit: 0, stdout: "DURATION " + duration + "\nPROBE width=1280\nPROBE height=720\n" + chunks, stderr: "" }], files: cuts.slice(0, -1).map((_, i) => ({ name: req.collect[0].replace("c*.mp3", "c0" + i + ".mp3"), bytes: new Uint8Array(5000) })), seconds: 20 };
      }
      const big = o.bigOut;
      return { ok: true, steps: [{ exit: 0, stdout: "", stderr: "" }, { exit: 0, stdout: "ENCODE 300\nOUTSIZE " + (big ? 40 * 1048576 : 5000000), stderr: "" }], files: big ? [] : [{ name: "sub-x/out.mp4", bytes: new Uint8Array(10) }, { name: "sub-x/shot.jpg", bytes: new Uint8Array([255, 216]) }], seconds: 400 };
    },
  };
  const ctx = { hub, conv: "t:ag-sub", askers: [], host };
  return { hub, host, ctx, sent, said, calls, ai, tool: S.tools(ctx)[0] };
}

describe("tool subtitle", () => {
  M.deps.id = () => "ab12cd34";
  const chat = M.deps.chat;
  test("feature shape", () => {
    assert.equal(S.name, "subtitle");
    assert.equal(S.tunables.subtitle_max_minutes.default, 60);
    assert.ok(S.tunables.subtitle_daily);
    const t = rig().tool;
    assert.equal(t.name, "subtitle"); assert.equal(t.long, true); assert.equal(t.work, true);
    assert.match(t.description, /字幕/);
    assert.ok(S.about.every(l => /[一-鿿]/.test(l)));
  });
  test("bilingual: pieces transcribed with their offsets, translated, numbered SRT sent", async () => {
    M.deps.chat = async (env, m) => m[1].content.split("\n").map(l => l.replace("|", "|译")).join("\n");
    try {
      const r = rig({ advice: true });
      const out = await r.tool.run({ video: "[视频 7]", translate: "中文" });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.mode, "bilingual"); assert.equal(out.translated_to, "中文"); assert.equal(out.language, "en");
      assert.equal(r.ai.length, 3, "three pieces");
      assert.equal(r.ai[0].model, "@cf/openai/whisper-large-v3-turbo");
      assert.equal(out.neurons_used, 30, "counted what the model reported");
      assert.equal(r.hub.plan.used("ai_neurons"), 30);
      const srt = r.sent.find(s => s.kind === "file");
      assert.match(srt.name, /\.双语\.srt$/);
      const text = new TextDecoder().decode(srt.bytes);
      assert.match(text, /^1\n00:00:00,200 --> /);
      assert.match(text, /\n2\n00:07:13,5\d\d --> [^\n]+\nHello piece 2\.\n译Hello piece 2\./, text);
      assert.match(text, /\n3\n00:14:26,867 --> /);
      assert.equal(out.budget_note, "今天额度紧");
      assert.equal(r.calls.length, 1);
      assert.match(r.calls[0].commands[0], /curl .*'https:\/\/qq\.example\/v\.mp4'/);
      assert.ok(r.calls[0].commands[0].includes("/work/sub-ab12cd34"));
      assert.deepEqual(r.calls[0].collect, ["sub-ab12cd34/c*.mp3"]);
    } finally { M.deps.chat = chat; }
  });
  test("refusals before anything is spent", async () => {
    assert.match((await rig().tool.run({ video: "nonsense" })).error, /编号|链接/);
    assert.match((await rig().tool.run({ video: "8" })).error, /重发/);
    assert.match((await rig().tool.run({ video: "x99" })).error, /文件箱/);
    const q = rig({ quota: false });
    assert.match((await q.tool.run({ video: "7" })).error, /次数用完/);
    assert.equal(q.calls.length, 0);
    const n = rig({ neuronsUsed: DAILY.ai_neurons.stop - 20 });
    assert.match((await n.tool.run({ video: "7" })).error, /额度用完/);
    assert.equal(n.calls.length, 0);
  });
  test("too long: says the cap, or what today's allowance covers", async () => {
    const a = rig({ tooLong: true, duration: 4000 });
    const r1 = await a.tool.run({ video: "7" });
    assert.match(r1.error, /66\.7 分钟.*上限 60 分钟/);
    assert.match(a.calls[0].commands[0], /l=3600 /);
    const b = rig({ tooLong: true, duration: 2000, neuronsUsed: DAILY.ai_neurons.stop - 1000 });
    const r2 = await b.tool.run({ video: "7" });
    assert.match(r2.error, /只够约 20 分钟/);
    assert.equal(b.ai.length, 0);
  });
  test("burn: small result sent as a video with a preview frame", async () => {
    const r = rig({ duration: 300 });
    const out = await r.tool.run({ video: "x3", burn: true });
    assert.equal(out.burn.ok, true, JSON.stringify(out.burn));
    assert.equal(r.calls.length, 2);
    assert.ok(r.calls[0].commands[0].includes("mv -f -- '/work/big talk.mp4' in.bin"));
    assert.ok(r.calls[1].files.some(f => f.name === "sub-ab12cd34.ass" && /PlayResX: 1280/.test(new TextDecoder().decode(f.bytes))));
    assert.match(r.calls[1].commands[1], /-preset veryfast/);
    assert.ok(r.sent.some(s => s.kind === "video" && /-字幕\.mp4$/.test(s.name)));
    assert.equal(out._images.length, 1);
    assert.ok(Number(r.hub.get("subtitle:rate:veryfast")) > 0, "measured rate kept for the next estimate");
  });
  test("burn: big result goes to the file box", async () => {
    const r = rig({ duration: 1300, bigOut: true });
    const out = await r.tool.run({ video: "7", burn: true });
    assert.deepEqual([out.burn.ok, out.burn.ref, out.burn.link], [true, "x9", "https://box/x9"]);
    assert.match(r.calls[1].commands[1], /UPLOAD \/work\/sub-ab12cd34\/out\.mp4/);
  });
  test("burn refused for a video too long to encode, subtitles still delivered", async () => {
    const r = rig({ duration: 3500 });
    const out = await r.tool.run({ video: "7", burn: true });
    assert.equal(out.ok, true);
    assert.equal(out.burn.ok, false);
    assert.match(out.burn.error, /一次能烧约 54 分钟以内/);
    assert.equal(r.calls.length, 1);
    assert.ok(r.sent.some(s => s.kind === "file"));
  });
  test("same language as the target is not translated", async () => {
    let asked = 0;
    M.deps.chat = async () => { asked++; return ""; };
    try {
      const r = rig({ lang: "zh", duration: 100 });
      const out = await r.tool.run({ video: "7", translate: "中文" });
      assert.equal(out.mode, "original"); assert.equal(asked, 0);
      assert.match(out.notes.join(), /已经是中文/);
    } finally { M.deps.chat = chat; }
  });
});
