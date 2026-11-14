// Offline tests for the four media skills: validation, quoting with hostile strings, bash syntax of every command,
// and (when Pillow / segno / ffmpeg exist on this machine) real execution in a temp directory.
// Set TEST_PYTHON to a python with Pillow and segno to run the QR execution test here.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import batch from "../src/skills/image-batch.ts";
import collage from "../src/skills/image-collage.ts";
import media from "../src/skills/media-convert.ts";
import qr from "../src/skills/qr-code.ts";

const f = (...names) => names.map(name => ({ name }));
const HOSTILE = `a'b "c" $(touch PWNED) \`touch PWNED\` ;touch PWNED; 奶蛙 \\ 空 格`;
const SHORT = "a'b $(id) `x` 奶蛙";
const bashOk = cmds => { for (const c of cmds) { const r = spawnSync("bash", ["-n", "-c", c], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + "\n" + c.slice(0, 300)); } };
const throwsCn = (fn, re) => assert.throws(fn, e => e instanceof Error && /[\u4e00-\u9fff]/.test(e.message) && (!re || re.test(e.message)));

const probe = (py, code) => { try { return spawnSync(py, ["-c", code], { stdio: "ignore" }).status === 0; } catch { return false; } };
const PY = process.env.TEST_PYTHON || "python3";
const HAS_PIL = probe(PY, "import PIL");
const HAS_SEGNO = HAS_PIL && probe(PY, "import segno");
// Real runs of programs that happen to be installed (ffmpeg, tesseract) only when asked for with SKILLS_REAL=1:
// another machine may carry an old build of them, and the normal check must not depend on that.
const HAS_FFMPEG = process.env.SKILLS_REAL === "1" && spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0 && spawnSync("ffprobe", ["-version"], { stdio: "ignore" }).status === 0;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "skills-media-"));
const run = (cmds, cwd, env = {}) => cmds.map(c => spawnSync("bash", ["-c", c], { cwd, encoding: "utf8", env: { ...process.env, PYTHON: PY, ...env } }));
const stdoutOf = rs => rs.map(r => r.stdout).join("\n").split("\n");
const png = (dir, name, w, h, rgb) => spawnSync(PY, ["-c", `from PIL import Image; Image.new("RGB",(${w},${h}),(${rgb.join(",")})).save(${JSON.stringify(path.join(dir, "in", name))})`]);

describe("shape of the skills", () => {
  for (const s of [batch, collage, media, qr]) {
    test(s.name + ": metadata", () => {
      assert.match(s.name, /^[a-z0-9-]+$/);
      assert.match(s.when, /[\u4e00-\u9fff]/);
      for (const [k, a] of Object.entries(s.args || {})) assert.match(a.description, /[\u4e00-\u9fff]/, k);
      for (const r of s.required || []) assert.ok(s.args[r], r);
      assert.equal(typeof s.report, "function");
    });
  }
});

describe("bash syntax", () => {
  test("image-batch", () => {
    bashOk(batch.commands({}, f("a.jpg")));
    bashOk(batch.commands({ format: "avif", watermark: SHORT, rename: HOSTILE.slice(0, 5), background: "#fff", max_width: 800, exact_width: 300, exact_height: 200, fit: "cover" }, f(HOSTILE + ".heic", "b.png")));
  });
  test("image-collage", () => {
    bashOk(collage.commands({}, f("a.jpg", "b.png")));
    bashOk(collage.commands({ mode: "strip", captions: [SHORT, "二"], background: "black" }, f(HOSTILE + ".jpg", "b.png")));
    bashOk(collage.commands({ mode: "split9" }, f(HOSTILE + ".jpg")));
  });
  test("qr-code", () => {
    bashOk(qr.commands({ text: HOSTILE }, []));
    bashOk(qr.commands({ text: HOSTILE, caption: SHORT, error_correction: "q" }, f(HOSTILE + ".png")));
  });
  test("media-convert, every op", () => {
    const one = f(HOSTILE + ".mp4");
    const cases = [["info", {}], ["to_mp4", { crf: 20, max_height: 720 }], ["to_gif", { start: "0:01", duration: 4, width: 320, fps: 10 }], ["to_mp3", {}], ["to_m4a", { bitrate_kbps: 128 }],
      ["trim", { start: "1:02", end: "01:03:04.5" }], ["trim", { start: 3, exact: false }], ["compress", { target_mb: 8 }], ["speed", { factor: 0.5 }], ["speed", { factor: 3 }], ["frames", { count: 8, width: 640 }]];
    for (const [op, a] of cases) bashOk(media.commands({ op, ...a }, one));
    bashOk(media.commands({ op: "concat" }, f(HOSTILE + ".mp4", "b b.mov", "c'.mkv")));
  });
});

describe("validation", () => {
  test("image-batch", () => {
    throwsCn(() => batch.commands({}, []), /1 到 40/);
    throwsCn(() => batch.commands({}, f(...Array.from({ length: 41 }, (_, i) => i + ".jpg"))), /1 到 40/);
    throwsCn(() => batch.commands({}, f("a.pdf")), /不支持/);
    throwsCn(() => batch.commands({ format: "bmp" }, f("a.jpg")), /输出格式/);
    throwsCn(() => batch.commands({ quality: 0 }, f("a.jpg")), /质量/);
    throwsCn(() => batch.commands({ quality: "高" }, f("a.jpg")), /质量/);
    throwsCn(() => batch.commands({ max_width: -5 }, f("a.jpg")), /最大宽度/);
    throwsCn(() => batch.commands({ rename: "../x" }, f("a.jpg")), /改名/);
    throwsCn(() => batch.commands({ rename: "a/b" }, f("a.jpg")), /改名/);
    throwsCn(() => batch.commands({ watermark: "x".repeat(41) }, f("a.jpg")), /水印/);
    throwsCn(() => batch.commands({ watermark_position: "middle" }, f("a.jpg")), /水印位置/);
    throwsCn(() => batch.commands({ watermark_opacity: 3 }, f("a.jpg")), /不透明度/);
    throwsCn(() => batch.commands({ background: "red; rm -rf /" }, f("a.jpg")), /背景色/);
    throwsCn(() => batch.commands({ fit: "zoom" }, f("a.jpg")), /补边/);
  });
  test("image-collage", () => {
    throwsCn(() => collage.commands({}, f("a.jpg")), /2 到 16/);
    throwsCn(() => collage.commands({}, f(...Array.from({ length: 17 }, (_, i) => i + ".jpg"))), /2 到 16/);
    throwsCn(() => collage.commands({ mode: "split9" }, f("a.jpg", "b.jpg")), /1 张/);
    throwsCn(() => collage.commands({ mode: "wall" }, f("a.jpg", "b.jpg")), /拼法/);
    throwsCn(() => collage.commands({ rows: 1, cols: 2 }, f("a.jpg", "b.jpg", "c.jpg")), /放不下/);
    throwsCn(() => collage.commands({ captions: ["一", "二", "三"] }, f("a.jpg", "b.jpg")), /比图片数/);
    throwsCn(() => collage.commands({ captions: "一" }, f("a.jpg", "b.jpg")), /列表/);
    throwsCn(() => collage.commands({ captions: ["x".repeat(31)] }, f("a.jpg", "b.jpg")), /30/);
    throwsCn(() => collage.commands({ gap: 500 }, f("a.jpg", "b.jpg")), /间隙/);
    throwsCn(() => collage.commands({ background: "$(id)" }, f("a.jpg", "b.jpg")), /底色/);
    throwsCn(() => collage.commands({ format: "gif" }, f("a.jpg", "b.jpg")), /输出格式/);
  });
  test("qr-code", () => {
    throwsCn(() => qr.commands({}, []), /内容/);
    throwsCn(() => qr.commands({ text: "   " }, []), /内容/);
    throwsCn(() => qr.commands({ text: "x".repeat(1501) }, []), /1500/);
    throwsCn(() => qr.commands({ text: "a", size: 50 }, []), /尺寸/);
    throwsCn(() => qr.commands({ text: "a", error_correction: "Z" }, []), /纠错/);
    throwsCn(() => qr.commands({ text: "a", caption: "x".repeat(41) }, []), /说明文字/);
    throwsCn(() => qr.commands({ text: "a", color: "red" }, []), /颜色/);
    throwsCn(() => qr.commands({ text: "a", color: "#000", background: "#000000" }, []), /不能一样/);
    throwsCn(() => qr.commands({ text: "a" }, f("a.png", "b.png")), /1 张/);
    throwsCn(() => qr.commands({ text: "a" }, f("a.pdf")), /logo/);
  });
  test("media-convert", () => {
    throwsCn(() => media.commands({ op: "burn" }, f("a.mp4")), /op 只能/);
    throwsCn(() => media.commands({ op: "info" }, f("a.docx")), /不支持/);
    throwsCn(() => media.commands({ op: "info" }, f("a.mp4", "b.mp4")), /一次只处理 1 个/);
    throwsCn(() => media.commands({ op: "concat" }, f("a.mp4")), /2 到 4/);
    throwsCn(() => media.commands({ op: "concat" }, f("a.mp4", "b.mp4", "c.mp4", "d.mp4", "e.mp4")), /2 到 4/);
    throwsCn(() => media.commands({ op: "trim" }, f("a.mp4")), /开始时间或结束时间/);
    throwsCn(() => media.commands({ op: "trim", start: 10, end: 5 }, f("a.mp4")), /更晚|晚/);
    throwsCn(() => media.commands({ op: "trim", start: "abc" }, f("a.mp4")), /开始时间/);
    throwsCn(() => media.commands({ op: "trim", start: -1, end: 5 }, f("a.mp4")), /开始时间/);
    throwsCn(() => media.commands({ op: "trim", start: 0, end: 4 * 3600 }, f("a.mp4")), /3 小时/);
    throwsCn(() => media.commands({ op: "to_gif", duration: 16 }, f("a.mp4")), /截取秒数/);
    throwsCn(() => media.commands({ op: "to_gif", fps: 60 }, f("a.mp4")), /帧率/);
    throwsCn(() => media.commands({ op: "to_gif", width: 4000 }, f("a.mp4")), /宽度/);
    throwsCn(() => media.commands({ op: "compress" }, f("a.mp4")), /target_mb/);
    throwsCn(() => media.commands({ op: "compress", target_mb: 0 }, f("a.mp4")), /target_mb/);
    throwsCn(() => media.commands({ op: "speed" }, f("a.mp4")), /factor/);
    throwsCn(() => media.commands({ op: "speed", factor: 5 }, f("a.mp4")), /factor/);
    throwsCn(() => media.commands({ op: "to_mp4", crf: 5 }, f("a.mp4")), /crf/);
    throwsCn(() => media.commands({ op: "to_mp3", bitrate_kbps: 9999 }, f("a.mp4")), /码率/);
    throwsCn(() => media.commands({ op: "frames", count: 99 }, f("a.mp4")), /张数/);
    throwsCn(() => media.commands({ op: "to_mp4", max_height: 4320 }, f("a.mp4")), /最大高度/);
  });
});

describe("quoting", () => {
  test("hostile strings never appear unquoted", () => {
    const cmds = [
      ...batch.commands({ watermark: SHORT, rename: "x'; touch PWNED; '" }, f(HOSTILE + ".png")),
      ...collage.commands({ captions: ["$(touch PWNED)"] }, f(HOSTILE + ".png", "b.png")),
      ...qr.commands({ text: HOSTILE, caption: "`touch PWNED`" }, f(HOSTILE + ".png")),
      ...media.commands({ op: "to_mp4" }, f(HOSTILE + ".mp4")),
      ...media.commands({ op: "concat" }, f(HOSTILE + ".mp4", "x.mp4")),
    ];
    // Every place the dangerous text occurs must sit inside a single-quoted word or a quoted heredoc.
    for (const c of cmds) {
      const heredoc = c.includes("<<'PYEOF'");
      const stripped = heredoc ? c.replace(/<<'PYEOF'\n[\s\S]*?\nPYEOF/, "") : c;
      const re = /'(?:[^']|'\\'')*'/g;
      const noQuoted = stripped.replace(re, "''");
      assert.ok(!/touch PWNED/.test(noQuoted), "unquoted: " + noQuoted.slice(0, 200));
    }
  });
});

describe("report()", () => {
  test("image-batch", () => {
    const r = batch.report(["OK a.jpg -> a.webp | 3.2 MB -> 210 KB | 4000x3000 -> 1600x1200", "FAIL b.heic | 打不开", "TOTAL 1 张 | 3.2 MB -> 210 KB | 体积变为 7%"]);
    assert.equal(r.成功, 1); assert.deepEqual(r.失败, ["b.heic | 打不开"]); assert.match(r.总计, /7%/);
  });
  test("media-convert", () => {
    const r = media.report(['INFO {"时长秒": 10}', "OK a.mp4 | 1 MB | x", "用时 12 秒"]);
    assert.equal(r.信息.时长秒, 10); assert.equal(r.用时, "12 秒"); assert.equal(r.成品.length, 1);
    assert.match(media.report(["错误：这个文件里没有声音"]).错误, /没有声音/);
  });
  test("qr-code and collage", () => {
    assert.match(qr.report(["OK qrcode.png + qrcode.svg | 800x880 | 纠错等级 H | 41 格 | 含 logo"]).文件, /qrcode.png/);
    assert.equal(collage.report(["FAIL 太小"]).失败, "太小");
    assert.equal(collage.report(["OK collage.jpg | 2x2 网格 | 4 张 | 1000x800 | 90 KB"]).图片数, "4 张");
  });
});

describe("real execution of image skills", { skip: !HAS_PIL && "no python3 with Pillow on this machine" }, () => {
  test("image-batch: resize, convert, rename, watermark, hostile names", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    const names = ["奶蛙 'x' $(touch PWNED).png", "b.png"];
    png(d, names[0], 800, 600, [200, 30, 30]);
    png(d, names[1], 300, 200, [30, 30, 200]);
    const cmds = batch.commands({ max_width: 400, format: "jpg", quality: 70, rename: "旅行_{n}", watermark: "奶蛙 © 2026", watermark_opacity: 0.8 }, f(...names));
    const rs = run(cmds, d);
    for (const r of rs) assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!fs.existsSync(path.join(d, "PWNED")));
    assert.deepEqual(fs.readdirSync(path.join(d, "out")).sort(), ["旅行_1.jpg", "旅行_2.jpg"]);
    const out = stdoutOf(rs).join("\n");
    assert.match(out, /OK .* -> 旅行_1\.jpg \| .* \| 800x600 -> 400x300/);
    assert.match(out, /300x200 -> 300x200/);
    assert.match(out, /TOTAL 2 张/);
    const size = spawnSync(PY, ["-c", `from PIL import Image; im=Image.open(${JSON.stringify(path.join(d, "out", "旅行_1.jpg"))}); print(im.format, im.size)`], { encoding: "utf8" }).stdout;
    assert.match(size, /JPEG \(400, 300\)/);
    assert.equal(batch.report(stdoutOf(rs)).成功, 2);
  });
  test("image-batch: exact size with each fit, name collisions, bad file", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    png(d, "a.png", 400, 200, [10, 200, 10]);
    png(d, "b.png", 200, 400, [10, 10, 10]);
    fs.writeFileSync(path.join(d, "in", "bad.png"), "not a picture");
    for (const fit of ["contain", "cover", "stretch"]) {
      fs.rmSync(path.join(d, "out"), { recursive: true, force: true });
      const rs = run(batch.commands({ exact_width: 100, exact_height: 100, fit, rename: "same", format: "webp" }, f("a.png", "b.png", "bad.png")), d);
      assert.equal(rs[1].status, 0, rs[1].stderr + rs[1].stdout);
      assert.deepEqual(fs.readdirSync(path.join(d, "out")).sort(), ["same.webp", "same_2.webp"]);
      assert.match(rs[1].stdout, /100x100/);
      assert.match(rs[1].stdout, /FAIL bad\.png \| 打不开/);
    }
  });
  test("image-batch: one dimension keeps the ratio and never upscales", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    png(d, "a.png", 400, 200, [10, 200, 10]);
    let rs = run(batch.commands({ exact_height: 50 }, f("a.png")), d);
    assert.match(rs[1].stdout, /400x200 -> 100x50/);
    rs = run(batch.commands({ max_width: 5000, max_height: 5000 }, f("a.png")), d);
    assert.match(rs[1].stdout, /400x200 -> 400x200/);
  });
  test("image-batch: all files unreadable exits non-zero", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    fs.writeFileSync(path.join(d, "in", "bad.png"), "x");
    const rs = run(batch.commands({}, f("bad.png")), d);
    assert.notEqual(rs[1].status, 0);
  });
  test("image-collage: grid, strip with captions, split9", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    const cols = [[200, 30, 30], [30, 200, 30], [30, 30, 200], [200, 200, 30], [90, 90, 90]];
    cols.forEach((c, i) => png(d, `p${i}.png`, 640 + i * 20, 480, c));
    const five = f("p0.png", "p1.png", "p2.png", "p3.png", "p4.png");
    let rs = run(collage.commands({ gap: 10, captions: ["一", "二", "三", "四", "第五张 'x' $(touch PWNED)"], background: "#f5efe6" }, five), d);
    for (const r of rs) assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(rs[1].stdout, /OK collage\.jpg \| 2x3 网格 \| 5 张/);
    fs.rmSync(path.join(d, "out"), { recursive: true });
    rs = run(collage.commands({ mode: "strip", strip_width: 500, captions: ["a", "b"], format: "png" }, f("p0.png", "p1.png")), d);
    assert.equal(rs[1].status, 0, rs[1].stderr + rs[1].stdout);
    assert.match(rs[1].stdout, /collage\.png \| 竖长图 \| 2 张 \| 524x/);
    fs.rmSync(path.join(d, "out"), { recursive: true });
    rs = run(collage.commands({ max_side: 800, rows: 1, cols: 5 }, five), d);
    const m = /(\d+)x(\d+) \|/.exec(rs[1].stdout);
    assert.ok(m && Math.max(+m[1], +m[2]) <= 800, rs[1].stdout);
    fs.rmSync(path.join(d, "out"), { recursive: true });
    rs = run(collage.commands({ mode: "split9" }, f("p0.png")), d);
    assert.equal(rs[1].status, 0, rs[1].stderr + rs[1].stdout);
    assert.deepEqual(fs.readdirSync(path.join(d, "out")).sort(), Array.from({ length: 9 }, (_, i) => `tile_${i + 1}.jpg`));
    assert.match(rs[1].stdout, /每块 160x160/);
    assert.ok(!fs.existsSync(path.join(d, "PWNED")));
  });
});

describe("real execution of qr-code", { skip: !HAS_SEGNO && "needs segno (set TEST_PYTHON)" }, () => {
  test("png + svg, Chinese caption, logo, hostile text", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    png(d, "logo.png", 120, 120, [220, 20, 60]);
    const cmds = qr.commands({ text: HOSTILE + " https://example.com/?a=1&b=2", caption: "扫一扫，加入奶蛙群", size: 600, error_correction: "L" }, f("logo.png"));
    const rs = run(cmds, d, { PATH: process.env.PATH });
    for (const r of rs) assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(!fs.existsSync(path.join(d, "PWNED")));
    assert.deepEqual(fs.readdirSync(path.join(d, "out")).sort(), ["qrcode.png", "qrcode.svg"]);
    assert.match(rs[1].stdout, /纠错等级 H.*含 logo.*含说明文字/);
    const dims = spawnSync(PY, ["-c", `from PIL import Image; print(Image.open(${JSON.stringify(path.join(d, "out", "qrcode.png"))}).size)`], { encoding: "utf8" }).stdout;
    assert.match(dims, /\(600, 6\d\d\)/);
    const svg = fs.readFileSync(path.join(d, "out", "qrcode.svg"), "utf8");
    assert.match(svg, /<svg[^>]+width="600"/);
    assert.match(svg, /扫一扫，加入奶蛙群/);
    assert.match(svg, /data:image\/png;base64,/);
    assert.equal(qr.report(rs[1].stdout.split("\n")).纠错, "纠错等级 H");
  });
  test("module pattern equals the encoder's matrix; overflow is a clean failure", () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, "in"));
    const rs = run(qr.commands({ text: "https://example.com/奶蛙", size: 500, svg: false, error_correction: "Q" }, []), d);
    assert.equal(rs[1].status, 0, rs[1].stderr + rs[1].stdout);
    assert.deepEqual(fs.readdirSync(path.join(d, "out")), ["qrcode.png"]);
    const check = spawnSync(PY, ["-c", `
import segno, sys
from PIL import Image
qr = segno.make("https://example.com/奶蛙", error="q", micro=False, encoding="utf-8", boost_error=False)
n = len(qr.matrix); mods = n + 8; mp = 500 // mods; off = (500 - mp * mods) // 2
im = Image.open(${JSON.stringify(path.join(d, "out", "qrcode.png"))}).convert("L")
bad = 0
for r, row in enumerate(qr.matrix):
    for c, v in enumerate(row):
        px = im.getpixel((off + (c + 4) * mp + mp // 2, off + (r + 4) * mp + mp // 2))
        if (px < 128) != bool(v): bad += 1
print("bad", bad)
`], { encoding: "utf8" });
    assert.match(check.stdout, /bad 0/, check.stderr);
    const big = run(qr.commands({ text: "字".repeat(1500), error_correction: "H" }, []), d);
    assert.notEqual(big[1].status, 0);
    assert.match(big[1].stdout, /FAIL 内容太长/);
  });
});

describe("real execution of media-convert", { skip: !HAS_FFMPEG && "no ffmpeg on this machine" }, () => {
  // The cloud box has GNU stat; this machine does not, so give the commands a stand-in.
  const shim = tmp();
  fs.writeFileSync(path.join(shim, "stat"), '#!/bin/bash\n[ "$1" = "-c" ] && [ "$2" = "%s" ] && { wc -c < "$3" | tr -d " "; exit 0; }\nexec /usr/bin/stat "$@"\n', { mode: 0o755 });
  const env = { PATH: shim + ":" + process.env.PATH };
  const d = tmp();
  fs.mkdirSync(path.join(d, "in"));
  const mk = (name, size, secs, extra = []) => spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=${size}:rate=25`, "-f", "lavfi", "-i", "sine=frequency=440", "-t", String(secs), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", ...extra, path.join(d, "in", name)]);
  mk("my clip's (1).mp4", "320x180", 4);
  mk("other.mp4", "160x120", 2);
  spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=300", "-t", "3", path.join(d, "in", "a.mp3")]);
  const go = (a, ...names) => { fs.rmSync(path.join(d, "out"), { recursive: true, force: true }); const rs = run(media.commands(a, f(...names)), d, env); return { rs, out: rs.map(r => r.stdout).join("\n"), files: fs.existsSync(path.join(d, "out")) ? fs.readdirSync(path.join(d, "out")).sort() : [] }; };
  const clip = "my clip's (1).mp4";

  test("info prints JSON", () => {
    const r = go({ op: "info" }, clip);
    assert.equal(r.rs[0].status, 0, r.rs[0].stderr);
    const info = media.report(r.out.split("\n")).信息;
    assert.equal(info.视频[0].宽, 320); assert.ok(Math.abs(info.时长秒 - 4) < 0.3);
  });
  test("to_mp4, to_mp3, frames, speed, trim", () => {
    let r = go({ op: "to_mp4", max_height: 144 }, clip);
    assert.deepEqual(r.files, ["my clip's (1).mp4"]); assert.match(r.out, /用时 \d+ 秒/);
    r = go({ op: "to_mp3" }, clip); assert.deepEqual(r.files, ["my clip's (1).mp3"]);
    r = go({ op: "frames", count: 3 }, clip); assert.equal(r.files.length, 3);
    r = go({ op: "speed", factor: 2 }, clip); assert.match(r.out, /OK .*_x2\.mp4/);
    r = go({ op: "trim", start: 1, end: 3 }, clip); assert.match(r.out, /共 2\.000 秒/);
    r = go({ op: "trim", start: 1, end: 2, exact: false }, "a.mp3"); assert.match(r.out, /不重新编码/);
  });
  test("refusals are readable", () => {
    assert.match(go({ op: "to_mp4" }, "a.mp3").out, /错误：这个文件里没有画面/);
    assert.match(go({ op: "to_mp3" }, clip).out, /OK/);
    assert.match(go({ op: "trim", start: 50 }, clip).out, /已经超过文件长度/);
    assert.match(go({ op: "concat" }, clip, "a.mp3").out, /不能把音频和视频拼在一起/);
  });
  test("gif, compress, concat both paths", () => {
    let r = go({ op: "to_gif", duration: 2, width: 160 }, clip);
    assert.match(r.out, /宽 160 像素/);
    r = go({ op: "compress", target_mb: 0.1 }, clip); // 4 s of 180p fits
    assert.match(r.out, /实际/);
    const bytes = fs.statSync(path.join(d, "out", fs.readdirSync(path.join(d, "out"))[0])).size;
    assert.ok(bytes <= 0.1 * 1048576, String(bytes));
    assert.match(go({ op: "compress", target_mb: 0.1 }, "a.mp3").out, /OK .*m4a/);
    assert.match(go({ op: "concat" }, clip, clip).out, /直接首尾相接/);
    r = go({ op: "concat" }, clip, "other.mp4");
    assert.match(r.out, /重新编码为 MP4/); assert.deepEqual(r.files, ["my clip's (1)_concat.mp4"]);
  });
});
