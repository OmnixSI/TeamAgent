// Offline tests for the toolbox page (src/feat/toolbox.ts, src/feat/toolbox-page.ts). The browser-side
// logic is tested by evaluating the exact script text the routes serve, in a DOM-less VM context.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const M = await import("../src/feat/toolbox.ts");
const feature = M.default;
const files = M.files();
const J = x => JSON.parse(JSON.stringify(x));   // values from the VM realm, made comparable

const ctx = { TextEncoder, TextDecoder, crypto, btoa, atob, URL };
ctx.self = ctx;
vm.createContext(ctx);
for (const k of ["app.js", "text.js", "rx.js", "image.js", "pdf.js", "qr.js"]) vm.runInContext(files[k].body, ctx, { filename: k });
const L = ctx.TB.lib;

const req = (p, init) => new Request("https://bot.example" + p, init);
const get = (p, init) => M.serve(req(p, init), new URL("https://bot.example" + p));

describe("routes", () => {
  test("page has strict headers and revalidates", async () => {
    for (const p of ["/x/toolbox", "/x/toolbox/"]) {
      const r = get(p);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get("content-type"), "text/html; charset=utf-8");
      assert.equal(r.headers.get("cache-control"), "no-cache");
      assert.match(r.headers.get("etag"), /^"[0-9a-z]+"$/);
      const csp = r.headers.get("content-security-policy");
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /script-src 'self' https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf-lib\/1\.17\.1\/pdf-lib\.min\.js(;|$)/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|\*/);
      assert.equal(r.headers.get("x-content-type-options"), "nosniff");
      assert.match(await r.text(), /^<!doctype html>/);
    }
  });
  test("every linked file exists, is versioned and cached for good", async () => {
    const html = files[""].body;
    const conf = JSON.parse(/const CONF = (\{[\s\S]*?\});\nTB\.conf/.exec(files["app.js"].body)[1]);
    const links = [...html.matchAll(/(?:src|href)="(\/x\/toolbox\/[^"]+)"/g)].map(m => m[1]).concat(Object.values(conf.parts), conf.rx);
    assert.equal(links.length, 7);
    for (const l of links) {
      const r = get(l);
      assert.equal(r.status, 200, l);
      assert.equal(r.headers.get("cache-control"), "public, max-age=31536000, immutable", l);
      assert.match(r.headers.get("content-type"), /^text\/(javascript|css); charset=utf-8$/);
    }
    assert.deepEqual(Object.keys(conf.index).sort(), [...M.TOOL_IDS].sort());
    assert.equal(conf.pdflib.src, M.PDFLIB.src);
    assert.match(conf.pdflib.sri, /^sha512-[A-Za-z0-9+/]{86}==$/);
  });
  test("an old version tag still works but is cached briefly", () => {
    const r = get("/x/toolbox/text.js?v=old");
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("cache-control"), "public, max-age=300");
  });
  test("conditional and HEAD requests", async () => {
    const etag = get("/x/toolbox").headers.get("etag");
    const r = get("/x/toolbox", { headers: { "If-None-Match": "W/" + etag } });
    assert.equal(r.status, 304);
    assert.equal(r.headers.get("etag"), etag);
    const h = get("/x/toolbox/app.css", { method: "HEAD" });
    assert.equal(h.status, 200);
    assert.equal(await h.text(), "");
    assert.equal(get("/x/toolbox", { method: "POST", body: "x" }).status, 405);
  });
  test("unknown paths are 404 inside the toolbox and not ours outside it", async () => {
    for (const p of ["/x/toolbox/nope.js", "/x/toolbox/app.js/x", "/x/toolbox/..%2Fadmin", "/x/toolbox/index.html"]) {
      const r = get(p);
      assert.equal(r.status, 404, p);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
    assert.equal(get("/x/toolboxes"), null);
    assert.equal(get("/x/drop/abc"), null);
    assert.equal(feature.open({}, req("/p/abc/"), new URL("https://bot.example/p/abc/")), null);
    assert.equal((await feature.open({}, req("/x/toolbox"), new URL("https://bot.example/x/toolbox"))).status, 200);
  });
  test("example notes are shown but not copied", () => {
    assert.deepEqual(M.exampleParts("这篇讲了什么 （贴上链接）"), ["这篇讲了什么", "贴上链接"]);
    assert.deepEqual(M.exampleParts("做个举牌表情，写“周五不加班”"), ["做个举牌表情，写“周五不加班”", ""]);
    assert.ok(files[""].body.includes('<q>这篇讲了什么 <small>贴上链接</small></q><button type="button" class="sm" data-copy="这篇讲了什么"'));
  });
  test("the page has no inline code, no bot calls and nothing private", () => {
    const html = files[""].body;
    assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/);
    assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i);
    const all = Object.values(files).map(f => f.body).join("\n");
    assert.doesNotMatch(all, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|\/admin|localStorage/);
    assert.doesNotMatch(all, /OmnixSI|TeamAgent|peiwan|WhalePartner|NextThought|inkboard/i);
    assert.doesNotMatch(all, /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, "no emoji");
    for (const f of Object.values(files)) assert.ok(Buffer.byteLength(f.body) < 64 * 1024, "each part stays small");
  });
  test("every tool id has an implementation in the part it loads", () => {
    for (const g of M.GROUPS) for (const it of g.items) {
      const src = it.parts.map(p => files[p + ".js"].body).join("\n");
      assert.ok(src.includes('T["' + it.id + '"]') || src.includes("T." + it.id + " =") || src.includes('"' + it.id + '": {'), it.id);
    }
  });
  test("the catalogue only names chat tools that exist and shows each example with a copy button", () => {
    const dir = new URL("../src/", import.meta.url);
    const src = [fs.readFileSync(new URL("tools.ts", dir), "utf8")].concat(fs.readdirSync(new URL("feat/", dir)).filter(f => f.endsWith(".ts")).map(f => fs.readFileSync(new URL("feat/" + f, dir), "utf8"))).join("\n");
    const html = files[""].body;
    for (const a of M.ABILITIES) {
      for (const t of a.tools) assert.ok(src.includes('name: "' + t + '"'), "tool " + t);
      for (const e of a.examples) { const say = M.exampleParts(e)[0]; assert.ok(say && !/（|）/.test(say) && html.includes('data-copy="' + say.replace(/&/g, "&amp;").replace(/"/g, "&quot;") + '"'), e); }
    }
  });
});

describe("chat tool", () => {
  const hub = { env: { PUBLIC_URL: "https://bot.example/" } };
  const tool = feature.tools({ hub }).find(t => t.name === "toolbox");
  test("links to the page or one tool", async () => {
    assert.deepEqual((await tool.run({})).link, "https://bot.example/x/toolbox");
    const r = await tool.run({ tool: "pdf-merge" });
    assert.equal(r.link, "https://bot.example/x/toolbox#pdf-merge");
    assert.equal(r.tool, "合并");
    assert.equal((await tool.run({ tool: "nope" })).ok, false);
    assert.deepEqual(tool.parameters.properties.tool.enum, M.TOOL_IDS);
    assert.ok(tool.description.includes("pdf-merge") && tool.description.includes("不要"));
  });
});

describe("zip", () => {
  test("crc32 check value", () => assert.equal(L.zip.crc32(new TextEncoder().encode("123456789")), 0xCBF43926));
  test("unzip reads what we write", (t) => {
    const enc = new TextEncoder(), when = new Date(2026, 10, 15, 14, 30, 42);
    const big = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
    const parts = L.zip.store([{ name: "照片 1.jpg", data: enc.encode("一"), date: when }, { name: "照片 1.jpg", data: enc.encode("two"), date: when }, { name: "a/b:c.txt", data: new Uint8Array(0), date: when }, { name: "big.bin", data: big, date: when }]);
    const zip = Buffer.concat(parts.map(p => Buffer.from(p)));
    // End record and central directory by hand.
    const eocd = zip.length - 22;
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    assert.equal(zip.readUInt16LE(eocd + 10), 4);
    let p = zip.readUInt32LE(eocd + 16);
    const names = [];
    for (let i = 0; i < 4; i++) {
      assert.equal(zip.readUInt32LE(p), 0x02014b50);
      assert.equal(zip.readUInt16LE(p + 8) & 0x0800, 0x0800, "UTF-8 flag");
      const n = zip.readUInt16LE(p + 28), off = zip.readUInt32LE(p + 42);
      names.push(zip.subarray(p + 46, p + 46 + n).toString("utf8"));
      assert.equal(zip.readUInt32LE(off), 0x04034b50);
      p += 46 + n;
    }
    assert.deepEqual(names, ["照片 1.jpg", "照片 1 (2).jpg", "a_b_c.txt", "big.bin"]);
    let unzip = "";
    try { unzip = execFileSync("which", ["unzip"]).toString().trim(); } catch {}
    if (!unzip) return t.skip("no unzip here");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tbzip-")), f = path.join(dir, "t.zip");
    try {
      fs.writeFileSync(f, zip);
      assert.match(execFileSync(unzip, ["-t", f]).toString(), /No errors detected/);
      const list = execFileSync(unzip, ["-l", f]).toString();
      assert.match(list, /70000\s+11-15-2026 14:30\s+big\.bin/);
      assert.equal(execFileSync(unzip, ["-p", f, "big.bin"]).equals(Buffer.from(big)), true);
      // macOS's bundled unzip cannot write UTF-8 names; Python's zipfile reads them through the UTF-8 flag.
      let py = "";
      try { py = execFileSync("which", ["python3"]).toString().trim(); } catch {}
      if (py) {
        const got = JSON.parse(execFileSync(py, ["-I", "-c", "import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);print(json.dumps([z.testzip(),[[i.filename,z.read(i).decode('utf-8','replace')[:5],i.flag_bits&0x800] for i in z.infolist()]]))", f]).toString());
        assert.deepEqual(got, [null, [["照片 1.jpg", "一", 2048], ["照片 1 (2).jpg", "two", 2048], ["a_b_c.txt", "", 2048], ["big.bin", "\u0000\u001f>]|", 2048]]]);
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("qr", () => {
  const Q = L.qr;
  test("format and version information match the standard tables", () => {
    const bits = (lv, mask) => Q.formatBits({ L: 0, M: 1, Q: 2, H: 3 }[lv], mask).toString(2).padStart(15, "0");
    assert.equal(bits("L", 0), "111011111000100");
    assert.equal(bits("M", 0), "101010000010010");
    assert.equal(bits("Q", 0), "011010101011111");
    assert.equal(bits("H", 0), "001011010001001");
    assert.equal(bits("M", 5), "100000011001110");
    assert.equal(Q.versionBits(7), 0x07C94);
    assert.equal(Q.versionBits(40), 0x28C69);
  });
  test("capacities and alignment positions", () => {
    const data = (v, e) => Q.dataCodewords(v, { L: 0, M: 1, Q: 2, H: 3 }[e]);
    assert.deepEqual([data(1, "L"), data(1, "H"), data(5, "Q"), data(10, "M"), data(20, "H"), data(40, "L"), data(40, "H")], [19, 9, 62, 216, 385, 2956, 1276]);
    assert.deepEqual(J(Q.alignPos(2)), [6, 18]);
    assert.deepEqual(J(Q.alignPos(7)), [6, 22, 38]);
    assert.deepEqual(J(Q.alignPos(32)), [6, 34, 60, 86, 112, 138]);
    assert.deepEqual(J(Q.alignPos(40)), [6, 30, 58, 86, 114, 142, 170]);
  });
  test("HELLO WORLD 1-M codewords (worked example)", () => {
    const c = Q.codewords(Q.segment("HELLO WORLD"), 1, 1);
    assert.deepEqual(J(c.data), [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
    assert.deepEqual(J(c.out.slice(16)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });
  test("matrices match an independent encoder (macOS CoreImage) bit for bit", () => {
    for (const f of FIXTURES) {
      const rows = f.rows.map(h => [...h].map(c => parseInt(c, 16).toString(2).padStart(4, "0")).join("").slice(0, f.size));
      // CoreImage chooses its own mask; read it from its format bits and use the same one.
      let fb = 0;
      const pos = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
      pos.forEach(([x, y], i) => { fb |= +rows[y][x] << i; });
      const q = Q.encode(f.text, f.level, { mask: ((fb ^ 0x5412) >> 10) & 7 });
      assert.equal(q.size, f.size, f.text);
      assert.deepEqual(J(q.modules.map(r => Array.from(r).join(""))), rows, f.level + " " + f.text.slice(0, 20));
    }
  });
  test("mode choice, automatic mask and limits", () => {
    assert.equal(Q.encode("0123456789", "M").mode, 1);
    assert.equal(Q.encode("HTTPS://A.B/C", "M").mode, 2);
    assert.equal(Q.encode("https://a.b/c", "M").mode, 4);
    const q = Q.encode("工具箱", "H");
    assert.ok(q.mask >= 0 && q.mask < 8 && q.version === 2);
    assert.equal(Q.encode("x".repeat(2953), "L").version, 40);
    assert.equal(Q.encode("x".repeat(2954), "L"), null);
    assert.match(Q.toSvg(q, 4), /^<svg [^>]*viewBox="0 0 33 33"/);
    const big = Q.encode("x".repeat(500), "M"), svg = Q.toSvg(big, 4);
    let dark = 0; big.modules.forEach(r => r.forEach(v => { dark += v; }));
    assert.ok((svg.match(/M/g) || []).length < dark * 0.6, "horizontal runs are merged");
  });
});

describe("text tools", () => {
  test("json keeps long numbers and points at errors", () => {
    const r = L.json.format('{"id":12345678901234567890,"a":[1,{"b":null}],"e":{},"s":"x,\\"y"}', "2");
    assert.equal(r.out, '{\n  "id": 12345678901234567890,\n  "a": [\n    1,\n    {\n      "b": null\n    }\n  ],\n  "e": {},\n  "s": "x,\\"y"\n}');
    assert.equal(L.json.format('{"a": [1, 2]}', 0).out, '{"a":[1,2]}');
    const bad = L.json.format('{\n  "a": 1,\n  "b": 2,\n}', "2");
    assert.equal(bad.ok, false);
    assert.equal(bad.line, 4);
    assert.match(bad.error, /多了逗号/);
    assert.equal(L.json.format('{"b":1,"a":12345678901234567890}', "2", true).lossy, true);
  });
  test("base64 and url helpers", () => {
    const C = L.codec, b = C.utf8("你好, world?>>");
    assert.equal(C.b64encode(b), "5L2g5aW9LCB3b3JsZD8+Pg==");
    assert.equal(C.b64encode(b, true), "5L2g5aW9LCB3b3JsZD8-Pg");
    assert.equal(C.fromUtf8(C.b64decode("5L2g5aW9LCB3b3JsZD8-Pg")), "你好, world?>>");
    assert.equal(C.fromUtf8(C.b64decode(" 5L2g\n5aW9 ")), "你好");
    assert.throws(() => C.b64decode("abc*"), /不属于/);
    assert.throws(() => C.b64decode("abcde"), /长度/);
    assert.deepEqual(J(C.sniff(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))), ["image/png", "png"]);
    assert.deepEqual(J(C.urlParams("https://a.example/p?q=%E4%BD%A0&x=1#h").params), [["q", "你"], ["x", "1"]]);
  });
  test("timestamps and zones", () => {
    const T = L.time;
    const r = T.parseTime("1731650000", "UTC");
    assert.equal(r.ms, 1731650000000);
    assert.equal(T.fmt(r.ms, "Asia/Shanghai"), "2024-11-15 13:53:20");
    assert.equal(T.fmt(r.ms, "Australia/Sydney"), "2024-11-15 16:53:20");
    assert.equal(T.offLabel(T.offsetMin(r.ms, "Australia/Sydney")), "UTC+11");
    assert.equal(T.parseTime("1731650000123", "UTC").kind, "毫秒级时间戳");
    assert.equal(T.parseTime("1731650000123456", "UTC").ms, 1731650000123);
    assert.equal(T.parseTime("1731650000123456789", "UTC").ms, 1731650000123);
    assert.equal(new Date(T.parseTime("2026-11-15 14:30", "Asia/Shanghai").ms).toISOString(), "2026-11-15T06:30:00.000Z");
    assert.equal(new Date(T.parseTime("2026年11月15日 14点30分", "Asia/Shanghai").ms).toISOString(), "2026-11-15T06:30:00.000Z");
    assert.equal(new Date(T.parseTime("2026/7/1 09:00:05.5", "Australia/Sydney").ms).toISOString(), "2026-06-30T23:00:05.500Z");
    assert.equal(new Date(T.parseTime("2026-11-15T06:30:00+0800", "UTC").ms).toISOString(), "2026-11-14T22:30:00.000Z");
    const now = Date.UTC(2026, 10, 15, 2, 0);
    assert.equal(new Date(T.parseTime("14:30", "Australia/Sydney", now).ms).toISOString(), "2026-11-15T03:30:00.000Z");
    assert.match(T.parseTime("2026-02-30", "UTC").error, /2 月没有 30 号/);
    assert.ok(T.parseTime("明天", "UTC").error);
    assert.equal(T.rel(now - 3 * 3600e3, now), "3 小时前");
  });
  test("Beijing/Sydney table and daylight saving change", () => {
    const T = L.time, rows = T.tzTable("2026-11-15", T.ZONES);
    assert.equal(rows.length, 24);
    assert.deepEqual(J(rows[0].cells), [{ hm: "00:00", day: 0 }, { hm: "03:00", day: 0 }, { hm: "16:00", day: -1 }]);
    assert.deepEqual(J(rows[22].cells[1]), { hm: "01:00", day: 1 });
    const s = T.nextShift(Date.UTC(2026, 10, 15), "Australia/Sydney", 370);
    assert.equal(new Date(s.ms).toISOString(), "2027-04-03T16:00:00.000Z");
    assert.deepEqual([s.before, s.after], [660, 600]);
    assert.equal(T.nextShift(Date.UTC(2026, 10, 15), "Asia/Shanghai", 370), null);
    assert.equal(T.tzTable("2026-06-15", T.ZONES)[0].cells[1].hm, "02:00");
  });
  test("counting Chinese and English", () => {
    const c = L.count("你好，世界！Hello world, it's 2026.\n\n第二段");
    assert.equal(c.han, 7);
    assert.equal(c.words, 4);
    assert.equal(c.total, 11);
    assert.equal(c.lines, 3);
    assert.equal(c.paras, 2);
    assert.equal(c.punct, 5);
    assert.equal(c.bytes, Buffer.byteLength("你好，世界！Hello world, it's 2026.\n\n第二段"));
    assert.equal(L.count("👨‍👩‍👧 a").chars, 3);
    assert.equal(L.count("").lines, 0);
  });
  test("diff is a valid and minimal edit script", () => {
    let seed = 7;
    const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    for (let round = 0; round < 200; round++) {
      const a = Array.from({ length: rnd(12) }, () => rnd(4)), b = Array.from({ length: rnd(12) }, () => rnd(4));
      const ops = L.diff.seq(a, b);
      assert.deepEqual(J(ops.filter(o => o[0] !== "+").map(o => a[o[1]])), a);
      assert.deepEqual(J(ops.filter(o => o[0] !== "-").map(o => b[o[2]])), b);
      for (const o of ops) if (o[0] === "=") assert.equal(a[o[1]], b[o[2]]);
      const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      assert.equal(ops.filter(o => o[0] === "=").length, lcs[0][0]);
    }
    const r = L.diff.lines("a\nhello world\nc", "a\nhello there world\nc\nd");
    assert.deepEqual([r.added, r.removed], [2, 1]);
    assert.deepEqual(J(r.rows[2].parts), [["hello ", false], ["there ", true], ["world", false]]);
    assert.equal(L.diff.lines("x  y", "x y", true).added, 0);
    assert.equal(L.diff.seq([1, 2, 3], [4, 5, 6], 2), null);
  });
  test("regex runner", () => {
    const r = L.rx("(?<y>\\d{4})-(\\d{2})", "g", "2026-11 and 2027-01", "$<y>/$2");
    assert.equal(r.matches.length, 2);
    assert.deepEqual(J(r.matches[1]), { i: 12, t: "2027-01", g: ["2027", "01"], n: { y: "2027" } });
    assert.equal(r.replaced, "2026/11 and 2027/01");
    assert.equal(L.rx("x*", "gu", "a😀b", null).matches.length, 4);
    assert.match(L.rx("(", "", "x", null).error, /写错/);
    assert.equal(L.rx("a", "", "aaaa", "b").replaced, "baaa");
  });
  test("random values", () => {
    const R = L.rand;
    const u4 = R.uuidFrom(new Uint8Array(16).fill(255), 4, 0), u7 = R.uuidFrom(new Uint8Array(16), 7, 0x0192_3456_789a);
    assert.equal(u4, "ffffffff-ffff-4fff-bfff-ffffffffffff");
    assert.equal(u7, "01923456-789a-7000-8000-000000000000");
    let i = 0;
    const seq = [0xFFFFFFFF, 5];   // the first is above the unbiased limit for n=10 and must be thrown away
    assert.equal(R.randInt(10, () => seq[i++]), 5);
    const p = R.password(24, { lower: true, upper: true, digits: true, symbols: false }, true);
    assert.equal(p.value.length, 24);
    assert.match(p.value, /^[a-zA-Z2-9]+$/);
    assert.doesNotMatch(p.value, /[Il1O0o]/);
    assert.ok(/[a-z]/.test(p.value) && /[A-Z]/.test(p.value) && /\d/.test(p.value));
    assert.throws(() => R.password(8, {}, false), /至少/);
  });
  test("sha-256", async () => {
    const d = await L.hash("SHA-256", new TextEncoder().encode("abc"));
    assert.equal(d.hex, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  test("colour maths", () => {
    const C = L.color;
    assert.deepEqual(J(C.parseColor("#2d6a5a")), { r: 45, g: 106, b: 90 });
    assert.deepEqual(J(C.parseColor("f0a")), { r: 255, g: 0, b: 170 });
    assert.deepEqual(J(C.parseColor("rgb(10 20 30 / 50%)")), { r: 10, g: 20, b: 30 });
    assert.deepEqual(J(C.parseColor("10, 20, 30")), { r: 10, g: 20, b: 30 });
    assert.deepEqual(J(C.parseColor("hsl(120, 100%, 25%)")), { r: 0, g: 128, b: 0 });
    assert.equal(C.parseColor("blue-ish"), null);
    const h = C.rgbToHsl({ r: 45, g: 106, b: 90 });
    assert.deepEqual(J(C.hslToRgb(h.h, h.s, h.l)), { r: 45, g: 106, b: 90 });
    assert.equal(C.contrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);
    assert.equal(C.contrast(C.parseColor("#777"), C.parseColor("#fff")).toFixed(2), "4.48");
    assert.equal(C.hex({ r: 1, g: 171, b: 255 }), "#01abff");
  });
});

describe("pdf and image helpers", () => {
  test("page ranges", () => {
    const P = L.pdf;
    assert.deepEqual(J(P.parseRanges("1-3, 5, 8-", 10)), [[1, 3], [5, 5], [8, 10]]);
    assert.deepEqual(J(P.parseRanges("1到3，5；-2", 10)), [[1, 3], [5, 5], [1, 2]]);
    assert.deepEqual(J(P.parseRanges("5-3", 10).map(P.expand)), [[5, 4, 3]]);
    assert.throws(() => P.parseRanges("", 10), /先写/);
    assert.throws(() => P.parseRanges("0-2", 10), /从 1 开始/);
    assert.throws(() => P.parseRanges("9-11", 10), /只有 10 页/);
    assert.throws(() => P.parseRanges("2,x", 10), /看不懂“x”/);
    assert.throws(() => P.parseRanges("-", 10), /看不懂/);
  });
  test("image placement on PDF pages", () => {
    const P = L.pdf, a = P.placeImage(4000, 3000, "a4auto", 10);
    assert.deepEqual([a.pw, a.ph], [841.89, 595.28]);
    assert.ok(Math.abs(a.x - (841.89 - a.w) / 2) < 1e-9 && a.w <= 841.89 - 2 * 10 * 72 / 25.4 + 1e-9);
    assert.deepEqual([P.placeImage(4000, 3000, "a4", 0).pw, P.placeImage(800, 600, "image", 0).pw], [595.28, 600]);
  });
  test("crop and resize plan", () => {
    const I = L.img;
    assert.deepEqual(J(I.plan(4000, 3000, { ratio: [1, 1], maxSide: 1080 })), { sx: 500, sy: 0, sw: 3000, sh: 3000, dw: 1080, dh: 1080, capped: false });
    assert.deepEqual(J(I.plan(3000, 4000, { ratio: [16, 9], anchor: "start" })).sy, 0);
    assert.equal(I.plan(3000, 4000, { ratio: [16, 9], anchor: "end" }).sy, 4000 - 1688);
    assert.deepEqual(J(I.plan(800, 600, { maxSide: 1920 })), { sx: 0, sy: 0, sw: 800, sh: 600, dw: 800, dh: 600, capped: false });
    const big = I.plan(8000, 6000, { maxSide: 0 });
    assert.ok(big.dw * big.dh <= 16e6 && big.capped);
    assert.equal(I.outType("image/heic", "keep"), "image/jpeg");
    assert.equal(I.outType("image/png", "keep"), "image/png");
  });
  test("exif orientation and gps detection", () => {
    const jpeg = (le, withGps) => {
      const t = [];
      const u16 = v => le ? [v & 255, v >> 8] : [v >> 8, v & 255], u32 = v => le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
      t.push(...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(8));
      const n = withGps ? 2 : 1;
      t.push(...u16(n), ...u16(0x0112), ...u16(3), ...u32(1), ...u16(6), 0, 0);
      if (withGps) t.push(...u16(0x8825), ...u16(4), ...u32(1), ...u32(8 + 2 + n * 12 + 4));
      t.push(...u32(0));
      if (withGps) t.push(...u16(1), ...u16(2), ...u16(5), ...u32(3), ...u32(0), ...u32(0));
      const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...t], len = app1.length + 2;
      return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xE1, len >> 8, len & 255, ...app1, 0xFF, 0xDA, 0, 2, 1, 2, 0xFF, 0xD9]);
    };
    assert.deepEqual(J(L.img.exifInfo(jpeg(false, true))), { exif: true, orientation: 6, gps: true });
    assert.deepEqual(J(L.img.exifInfo(jpeg(true, true))), { exif: true, orientation: 6, gps: true });
    assert.deepEqual(J(L.img.exifInfo(jpeg(true, false))), { exif: true, orientation: 6, gps: false });
    assert.equal(L.img.exifInfo(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), null);
    assert.deepEqual(J(L.img.exifInfo(jpeg(true, true).subarray(0, 30))), { exif: true, orientation: 1, gps: false });
  });
});

// Module matrices from macOS CoreImage (CIQRCodeGenerator), one hex string per row.
const FIXTURES = [{"level":"M","text":"HELLO WORLD","size":21,"rows":["fe2bf8","82e208","ba2ae8","ba2ae8","babae8","827208","feabf8","000000","aa4890","789088","1fd2c0","f59d70","4f53a8","00a228","fe0960","826340","bacbf8","ba3510","baf748","821c58","fed708"]},{"level":"L","text":"12345678901234567890","size":21,"rows":["fe5bf8","82d208","bacae8","ba52e8","ba8ae8","829a08","feabf8","00f800","d363b0","642608","73acd0","94f180","3b8e18","0090c0","fea000","821c40","ba3768","baf058","ba48e8","82a650","fed8e0"]},{"level":"Q","text":"https://teamagent.example/x/toolbox#pdf-merge","size":33,"rows":["fe1ea13f8","826290208","baa3e72e8","ba3341ae8","baf3e12e8","82f696208","feaaaabf8","0028fc000","4aa05eda0","4c1ac1470","6bbc25e40","b40b87e10","129a0fac8","34afe1d40","97d805630","c17b55600","3eca37ad0","cc2301070","af5a49f50","a8774f100","0786342c0","b929c5510","22f409dd0","019dce8d0","f7703ff80","00b3868b0","fe4c44ad0","827cbc880","ba910efd8","ba7d01bd0","ba75ec3a0","82f68f800","fe00edc48"]},{"level":"H","text":"工具箱测试","size":29,"rows":["fee80bf8","823afa08","ba674ae8","baf1dae8","ba02fae8","8207a208","feaaabf8","00170800","2ea08c48","71b41ca8","37dcbe40","348aaae0","bba25d78","54594f98","0ae133c0","f8757070","fbfda380","693a5118","8f1c67f0","615db348","b28a0fb0","0092c898","fe439af0","829d78a8","bab23f80","ba593f30","bac49008","824f5230","fe6031b8"]},{"level":"L","text":"一严乊乯五亹仞伃伨位佲侗侼信倆倫偐偵傚傿僤儉儮兓典冝凂凧刌刱剖剻加勅勪匏匴卙卾厣又叭吒吷呜咁咦哋哰唕唺啟善喩嗎丣么乭互亷仜企伦佋佰侕侺俟倄倩偎偳傘傽僢儇儬兑其军净凥刊刯剔剹办勃勨匍匲南卼厡叆叫吐吵呚呿咤哉哮唓唸啝喂喧嗌両乆乫亐亵仚仿伤佉佮侓侸保倂倧偌偱傖傻僠儅優兏兴写冾凣刈刭剒剷劜勁勦匋匰单卺原叄叩后吳员命咢哇哬唑唶啛喀喥嗊丟乄乩于亳付份伢佇佬侑侶俛倀倥偊偯傔傹僞儃儨免兲冗冼凡分别剐創劚势勤匉匮卓卸厝参叧同吱呖呻咠哅哪唏唴啙啾喣嗈丝乂乧二亱他任传佅佪侏侴俙俾倣偈偭傒傷僜儁儦克兰冕冺凟刄利剎剳劘劽勢匇匬卑卶厛叀句吊启呔呹咞哃哨唍唲啗啼喡嗆丛乀乥亊亯仔仹伞佃佨侍侲俗俼倡偆偫傐債僚僿儤光兮冓冸凝刂刧剌剱劖劻勠包匪协却厙厾口合吭呒呷咜品哦唋唰啕啺喟嗄丙举乣予亭","size":105,"rows":["fe4210d241767e8bf28067363f8","8293d53d230a24230aada28a208","ba08787873be58f1be58f1df2e8","baefd0491620820c1039196cae8","ba2695fe1270f90658fdc831ae8","82dbce8c67968de7878de79d208","feaaaaaaaaaaaaaaaaaaaaaabf8","0055ab88d28c88d2ec88b2aa000","fb9852fb45f8f874d0fe0d71550","41716e791cbc0534682b4100de8","7640d7b4ebc7a4ebc7b4e3df4b8","8d4e2989e08bf98089d9868cb10","c284ce5fe0706657f0476ce0558","8549554ec2712708f167f431520","ca607bf82b8e79b38f78bb8ebe8","a0307eaae6b82ae4bcaae4dd318","73cb285b1f67cd0c74d799ee478","19a064489ab4021e785698f28d8","b63b56b8668e31e68f29678f9e8","cd4ddb9cd3dd78d3fbded3f8640","d6f5f4ab5d7c802466ff14f5290","d8671c292de87d05761369fade8","7ad947aceb0ba4f28bb4fa0b5b8","659be799a1ff99e1bfb9e7bf310","cffb8efff408fe4d38ff6440fd8","68af158ed8618f08098fe4318e8","daf8a3a82b87a8b38fa93b96af8","e8cd3f8ae6e98ae6cd8ae48c880","efb923fe9c9efd8d61f91c4afb0","30eff6d71c57e19d25c2dde85e8","93581ac0e2c7a163dee06257b78","f8a58d7ad5897cd18d7eb18f988","824695ac1a752884e7af9674238","5d31b4d80a70ccc0f7d20df2a10","5bb0c9ccf30a84628b95ea0b5e8","f1b98f22c5ff28a1bf3883bfc98","e3c78b1e8c11fe07697f0c58610","f096cf069c58df1270f38619bf0","5efdf5c87f9f416f96b06f877a8","51da76038289a2c2a9b4c2cd3d0","861765def4815f1d6d7f2447f10","e4558127b45603053d676de8ae8","5ff431a0fbdee0f25f00e357578","05f084f3e588edc58de7a18ff88","36c0a73e3ee33f6461becef3e30","fd4ca407213477caf0471673a00","da0a98e1320e803b0ec0aa8edc8","78106176e3df76e5f96ae7bd090","dfa461fc8df5fe1eaffb1d18fd0","c88d068bdcd9889a728a1f188e0","eadde5a9e70fa96686a8661faa8","c890da8cb38a8e93ef8ad3c98d0","5fa5cdf8254efb1465f94cb6f90","5032633f01e4392d19bd15b6268","4e7e9c64fa8244f20274e30bff8","35c2ee01a7cf41858fa1c1ef808","5ebe9e663b30ff60497ece781b0","541c30b3305d2fda35af0819398","921ba0403b8651bb8e412b979a8","55b795d4e6aad6e4cbdae0e9d08","a3a621bc1f39a11a03b399e97a0","4c926c1ddb141b19c0199d2a658","1ef0b74163576862d7406246268","2045d602b78d48938abed58fd00","465856316576b35675312cf79f8","7dac0a1f00f5b92c30bd16f6230","979a54646a0a45e30a657b0be58","791cdc80a5bfc0e7df20c3ff898","23f0167b5668fe6c587f4600380","e905cbaf4070af1c5d2f7229300","121a904a7f9e506f8e41ef87c48","9032ca46c2ecd6e2aadae289dd0","ffa708f91d29ff3c05fc7deef90","e8bf928d1d0f8b39d4895d398e8","aabd32a872d7a8f3c6a8fb46af8","98e0aa8a018989c78d8fe58b898","6fd958fb0c72f8a8f0fbfa72fb8","a84fa9a7fbf131393735dcf26f0","faa0f458aa0a182b0b18330afe8","15b1f34ae3be64e1dfbce7ffb18","2e79ccb61e08ea9c3ac18e07cc8","b4df7431183733dc7b371a0d180","7352c8d8668a78661238661ba48","d9814ee0d3eec6b3eee493cef50","4b306b237563414c2f237c1d490","e81b5d7b4c4bff1025797c68de8","e2440b8cfb522ceb422cf2c3b78","c99eecc9818f51878e41a58e818","c300eac71231d6b8109fff315f8","b443c9bfec313b32713fd814480","1fb5ce892bde89abd7e9abc6ba8","a48c365ae28d4ce48cd6e08b110","baf965c89802839bb6d41895ba8","8ccf55be1df738db153b1fd13a0","e3cf780866466866c649e6dfaa8","2d47e6c0d38ad8b388ca9388ed0","1b1917fb73f3f948f7fa3f65f90","00cad98b6b738f37f5891831880","fe8e47acef0bacf70bace68aae8","826d7189e3be89e3bf89c3df8d0","baeaedff7838fe8600ffb531f90","bad7e887ae394b4069c38c04ea0","bacf0d30af8628af8ea0b78e380","82f0166be2ac5de28c1de28bf40","fe89cffc1c15573daf9c8c9da10"]}];
