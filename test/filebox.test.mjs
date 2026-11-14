// Offline tests for the file box (src/feat/filebox.ts). The Hub's SQLite is a real in-memory node:sqlite
// database, the bucket is a Map, and the shell commands run in a real local bash against a small HTTP
// server on an ephemeral port that serves the real transfer and file box routes.
import { test, describe, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const B = await import("../src/feat/filebox.ts");
const T = await import("../src/feat/transfer.ts");
const box = B.default, transfer = T.default;
const PART = T.PART;

function fakeHub(publicUrl = "https://bot.example") {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  db.exec("CREATE TABLE blob(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, name TEXT, data BLOB)");
  db.exec("CREATE TABLE img(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, ts INTEGER, mime TEXT, data BLOB, note TEXT, name TEXT)");
  db.exec(transfer.schema);
  db.exec(box.schema);
  const objects = new Map(), used = new Map(), said = [], cfg = { box_days: 7 };
  const read = async body => {
    if (body instanceof Uint8Array) return new Uint8Array(body);
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    const chunks = [];
    for await (const c of body) chunks.push(c);
    return new Uint8Array(Buffer.concat(chunks));
  };
  const hub = {
    sql: { exec: (q, ...b) => { const rows = db.prepare(q).all(...b); return { toArray: () => rows }; } },
    get: k => db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? null,
    set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    shadow: c => (c.startsWith("t:") ? "g:main" : ""),
    plan: {
      used: n => used.get(n) || 0,
      fits: (n, a = 0) => (used.get(n) || 0) + a <= 100000,
      add: (n, a) => used.set(n, (used.get(n) || 0) + a),
      take(n, a) { if (!this.fits(n, a)) return false; this.add(n, a); return true; },
    },
    edit: { cfg: (_c, k) => cfg[k] },
    store: { r2Bytes: () => 0 },
    ingest: m => { said.push(m); return said.length; },
    ctx: { waitUntil: p => p },
    said, cfg, db,
    env: {
      PUBLIC_URL: publicUrl,
      FILES: {
        objects,
        async put(key, body) { const b = await read(body); objects.set(key, b); return { size: b.length }; },
        async get(key, o) {
          let b = objects.get(key);
          if (!b) return null;
          if (o?.range) b = b.subarray(o.range.offset, o.range.offset + o.range.length);
          return { body: new Blob([b]).stream(), size: b.length };
        },
        async head(key) { const b = objects.get(key); return b ? { size: b.length } : null; },
        async delete(key) { for (const k of [key].flat()) objects.delete(k); },
      },
    },
  };
  return hub;
}

const enc = s => new TextEncoder().encode(s);
const sha = b => createHash("sha256").update(b).digest("hex");
const joined = (hub, key) => { const r = T.row(hub, key); return Buffer.concat(Array.from({ length: r.parts }, (_x, i) => hub.env.FILES.objects.get(T.partKey(key, i)))); };
const keyOf = (hub, ref) => hub.db.prepare("SELECT key FROM boxfile WHERE id=?").get(B.parseRef(ref)).key;
const tokenOf = link => /\/x\/(?:box|get|put|drop)\/([0-9a-f]{32})/.exec(link)[1];
const route = async (hub, req) => (await transfer.open(hub, req, new URL(req.url))) || (await box.open(hub, req, new URL(req.url)));
const get = (hub, path, headers = {}) => route(hub, new Request("https://bot.example" + path, { headers }));
const post = (hub, path, body, headers = {}) => route(hub, new Request("https://bot.example" + path, { method: "POST", body: JSON.stringify(body), headers }));
const putPart = (hub, path, bytes) => route(hub, new Request("https://bot.example" + path, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length) } }));
const bash = (cmd, env = {}) => new Promise(res => {
  const p = spawn("bash", ["-c", cmd], { env: { ...process.env, ...env } });
  let out = "", err = "";
  p.stdout.on("data", d => (out += d)); p.stderr.on("data", d => (err += d));
  p.on("close", code => res({ code, out, err }));
});
const syntax = cmd => execFileSync("bash", ["-n", "-c", cmd]);

describe("names and references", () => {
  test("x references parse; nothing else does", () => {
    assert.equal(B.parseRef("x12"), 12);
    assert.equal(B.parseRef(" X7 "), 7);
    assert.equal(B.parseRef("[x3]"), 3);
    for (const bad of ["x", "f12", "g3", "x12a", "12", "", null, "xx1", "x-1"]) assert.equal(B.parseRef(bad), 0, String(bad));
  });
  test("display names keep Chinese and lose paths and control characters", () => {
    assert.equal(B.cleanName("/work/a/会议录音 第1段.m4a"), "会议录音 第1段.m4a");
    assert.equal(B.cleanName("..\\..\\x\u0000y.txt"), "xy.txt");
    assert.equal(B.cleanName(""), "file");
    assert.equal(B.cleanName("a".repeat(300)).length, 120);
  });
  test("types come from the extension; unknown ones download", () => {
    assert.equal(B.mimeOf("a.MP4"), "video/mp4");
    assert.equal(B.mimeOf("录音.m4a"), "audio/mp4");
    assert.equal(B.mimeOf("x.weird", "application/x-thing"), "application/x-thing");
    assert.equal(B.mimeOf("x.weird", "bad type<>"), "application/octet-stream");
    assert.ok(B.showsInline("video/mp4") && B.showsInline("application/pdf"));
    assert.ok(!B.showsInline("text/html; charset=utf-8") && !B.showsInline("image/svg+xml"));
  });
  test("Content-Disposition carries Chinese names in RFC 5987 form with an ASCII fallback", () => {
    const d = B.disposition("会议 录音(1)'s.m4a", false);
    assert.match(d, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/);
    const star = d.split("filename*=UTF-8''")[1];
    assert.match(star, /^[A-Za-z0-9%._~!-]+$/);
    assert.equal(decodeURIComponent(star), "会议 录音(1)'s.m4a");
    assert.equal(d.split('"')[1], "_ _(1)'s.m4a");
    assert.match(B.disposition("a\"b;c.mp4", true), /^inline; filename="a_b_c.mp4"/);
  });
  test("each conversation has its own key prefix", () => {
    assert.match(B.prefixOf("g:abc"), /^box\/[0-9a-z]+\/$/);
    assert.notEqual(B.prefixOf("g:abc"), B.prefixOf("g:abd"));
    assert.equal(B.prefixOf("t:ag-box"), B.prefixOf("t:ag-box"));
  });
});

describe("Range arithmetic", () => {
  test("single ranges, suffixes, open ends and bad ones", () => {
    assert.deepEqual(B.parseRange("bytes=0-99", 1000), { start: 0, end: 99 });
    assert.deepEqual(B.parseRange("bytes=900-", 1000), { start: 900, end: 999 });
    assert.deepEqual(B.parseRange("bytes=-100", 1000), { start: 900, end: 999 });
    assert.deepEqual(B.parseRange("bytes=-5000", 1000), { start: 0, end: 999 });
    assert.deepEqual(B.parseRange("bytes=990-5000", 1000), { start: 990, end: 999 });
    assert.equal(B.parseRange("bytes=1000-", 1000), "bad");
    assert.equal(B.parseRange("bytes=5-3", 1000), "bad");
    assert.equal(B.parseRange("bytes=-0", 1000), "bad");
    assert.equal(B.parseRange("bytes=0-1,5-6", 1000), null);
    assert.equal(B.parseRange(null, 1000), null);
  });
  test("a range is split across the stored parts", () => {
    assert.deepEqual(B.pieces(0, 9, 10), [{ i: 0, offset: 0, length: 10 }]);
    assert.deepEqual(B.pieces(5, 24, 10), [{ i: 0, offset: 5, length: 5 }, { i: 1, offset: 0, length: 10 }, { i: 2, offset: 0, length: 5 }]);
    assert.deepEqual(B.pieces(10, 10, 10), [{ i: 1, offset: 0, length: 1 }]);
    const ps = B.pieces(PART - 3, PART + 2);
    assert.deepEqual(ps, [{ i: 0, offset: PART - 3, length: 3 }, { i: 1, offset: 0, length: 3 }]);
  });
});

describe("box storage", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });

  test("boxPut stores, boxFile finds it only in its own conversation", async () => {
    const r = await B.boxPut(hub, "g:a", "结果 表.xlsx", enc("hello"));
    assert.match(r.ref, /^x\d+$/);
    assert.match(r.link, /^https:\/\/bot\.example\/x\/box\/[0-9a-f]{32}\/%E7%BB%93/);
    const f = B.boxFile(hub, "g:a", r.ref);
    assert.equal(f.name, "结果 表.xlsx");
    assert.equal(f.size, 5);
    assert.equal(f.mime, B.mimeOf("x.xlsx"));
    assert.ok(f.expires - f.ts >= 7 * 86400000 - 1000);
    assert.equal(B.boxFile(hub, "g:b", r.ref), null);
    assert.equal(B.boxFile(hub, "t:x", r.ref), null);   // test rooms do not borrow the group's box
    assert.equal(B.boxLink(hub, "g:b", r.ref), null);
    assert.equal(B.boxDownloadCommand(hub, "g:b", r.ref, "/tmp/x"), null);
    assert.ok(keyOf(hub, r.ref).startsWith(B.prefixOf("g:a")));
    assert.ok(T.complete(hub, keyOf(hub, r.ref)));
  });

  test("lifetime follows box_days, clamped to 1..30, and an explicit days wins", async () => {
    hub.cfg.box_days = 3;
    const a = B.boxFile(hub, "g:a", (await B.boxPut(hub, "g:a", "a", enc("1"))).ref);
    assert.ok(Math.abs(a.expires - a.ts - 3 * 86400000) < 1000);
    const b = B.boxFile(hub, "g:a", (await B.boxPut(hub, "g:a", "b", enc("1"), 90)).ref);
    assert.ok(Math.abs(b.expires - b.ts - 30 * 86400000) < 1000);
    const c = B.boxFile(hub, "g:a", (await B.boxPut(hub, "g:a", "c", enc("1"), 0.2)).ref);
    assert.ok(Math.abs(c.expires - c.ts - 86400000) < 1000);
  });

  test("expired files disappear at once and the hourly sweep deletes their bytes", async () => {
    const a = await B.boxPut(hub, "g:a", "a.txt", enc("aaa")), b = await B.boxPut(hub, "g:a", "b.txt", enc("bbb"));
    const ka = keyOf(hub, a.ref), kb = keyOf(hub, b.ref);
    hub.sql.exec("UPDATE boxfile SET expires=? WHERE id=?", Date.now() - 1, B.parseRef(a.ref));
    assert.equal(B.boxFile(hub, "g:a", a.ref), null);
    assert.equal(B.boxLink(hub, "g:a", a.ref), null);
    const now = Date.now();
    await B.sweep(hub, now);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM boxfile").get().n, 1);
    assert.equal(T.row(hub, ka), null);
    assert.ok(!hub.env.FILES.objects.has(T.partKey(ka, 0)));
    assert.ok(hub.env.FILES.objects.has(T.partKey(kb, 0)));
    // at most once an hour
    hub.sql.exec("UPDATE boxfile SET expires=? WHERE id=?", now - 1, B.parseRef(b.ref));
    await B.sweep(hub, now + 60000);
    assert.ok(T.row(hub, kb));
    await B.sweep(hub, now + 3600000);
    assert.equal(T.row(hub, kb), null);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM boxfile").get().n, 0);
  });

  test("the sweep drops bytes nobody registered, but not uploads a live page is still waiting for", async () => {
    const old = Date.now() - 30 * 3600000;
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,?,?,?)", "box/zz/orphan", 3, 1, 1, old);
    hub.env.FILES.objects.set("box/zz/orphan.part0000", enc("abc"));
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,?,?,?)", "computer/cache/x", 3, 1, 1, old);
    const d = B.newDrop(hub, "g:a");
    const s = await (await post(hub, "/x/drop/" + d.token + "/start", { name: "a.bin", size: 3 })).json();
    const live = JSON.parse(hub.get("box:drop:" + d.token)).files[s.f].key;
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,?,?,?)", live, 3, 1, 1, old);
    await B.sweep(hub);
    assert.equal(T.row(hub, "box/zz/orphan"), null);
    assert.ok(!hub.env.FILES.objects.has("box/zz/orphan.part0000"));
    assert.ok(T.row(hub, "computer/cache/x"), "never touches other prefixes");
    assert.ok(T.row(hub, live));
  });

  test("room is the smallest of the box total, the transfer cap and R2, minus promised bytes", () => {
    const G = 1024 ** 3;
    assert.equal(B.roomFrom({ box: 0, xfer: 0, store: 0, reserved: 0 }, 3 * G, 5 * G, 8 * G), 3 * G);
    assert.equal(B.roomFrom({ box: 1 * G, xfer: 4.5 * G, store: 0, reserved: 0 }, 3 * G, 5 * G, 8 * G), 0.5 * G);
    assert.equal(B.roomFrom({ box: 0, xfer: 1 * G, store: 6.5 * G, reserved: 0 }, 3 * G, 5 * G, 8 * G), 0.5 * G);
    assert.equal(B.roomFrom({ box: 0, xfer: 0, store: 0, reserved: 1 * G }, 3 * G, 5 * G, 8 * G), 2 * G);
    assert.equal(B.roomFrom({ box: 4 * G, xfer: 0, store: 0, reserved: 0 }, 3 * G, 5 * G, 8 * G), 0);
    assert.equal(B.LIMITS.file, 2 * G);
    assert.equal(B.LIMITS.total, 3 * G);
  });

  test("boxPut refuses when the shared transfer cap is full, and an upload command says so", async () => {
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,?,?,?)", "computer/cache/big", T.CAP - 4, 1, 1, Date.now());
    assert.equal(await B.boxPut(hub, "g:a", "a", enc("hello")), null);
    assert.equal(B.room(hub), 4);
    hub.sql.exec("UPDATE xfer SET size=? WHERE key=?", T.CAP, "computer/cache/big");
    const u = B.boxUpload(hub, "g:a", "/work/a.mp4", "a.mp4");
    assert.match(u.command, /文件箱满了/);
    assert.equal(await u.claim(), null);
    const r = await bash(u.command);
    assert.notEqual(r.code, 0);
  });

  test("the per-file limit holds on the page and in the upload command", async () => {
    const d = B.newDrop(hub, "g:a");
    const st = await (await post(hub, "/x/drop/" + d.token + "/start", { name: "big.bin", size: B.LIMITS.file + 1 })).json();
    assert.equal(st.ok, false);
    assert.match(st.error, /最大 2\.00 GB/);
    assert.ok(B.boxUpload(hub, "g:a", "/w/a", "a").command.includes("-le " + Math.min(B.LIMITS.file, B.room(hub)) + " ]"));
  });
});

describe("claim()", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });
  const putOf = cmd => /u='([^']+)'/.exec(cmd)[1].replace("https://bot.example", "");

  test("refuses an upload that has not finished, then accepts it once the last part is in", async () => {
    const u = B.boxUpload(hub, "g:a", "/work/out/成片.mp4", "成片.mp4");
    syntax(u.command);
    assert.equal(await u.claim(), null, "nothing uploaded yet");
    const path = putOf(u.command), big = new Uint8Array(PART).fill(7);
    assert.equal((await putPart(hub, path + "?part=0&last=0", big)).status, 200);
    assert.equal(await u.claim(), null, "last part missing");
    assert.equal((await putPart(hub, path + "?part=1&last=1", enc("tail"))).status, 200);
    const c = await u.claim();
    assert.equal(c.name, "成片.mp4");
    assert.equal(c.size, PART + 4);
    assert.match(c.link, /\/x\/box\/[0-9a-f]{32}\/%E6%88%90%E7%89%87\.mp4$/);
    assert.equal((await u.claim()).ref, c.ref, "claiming twice gives the same file");
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM boxfile").get().n, 1);
  });

  test("refuses parts of the wrong size (byte ranges would be wrong) and drops them", async () => {
    const u = B.boxUpload(hub, "g:a", "/w/a.bin", "a.bin"), path = putOf(u.command);
    await putPart(hub, path + "?part=0&last=0", enc("short"));
    await putPart(hub, path + "?part=1&last=1", enc("tail"));
    assert.equal(await u.claim(), null);
    assert.equal(hub.db.prepare("SELECT COUNT(*) n FROM xfer").get().n, 0);
  });

  test("the upload token is confined to its one key", async () => {
    const u = B.boxUpload(hub, "g:a", "/w/a.bin", "a.bin"), path = putOf(u.command);
    const other = path.replace(/\/[^/]+$/, "/other");
    assert.equal((await putPart(hub, other + "?part=0&last=1", enc("x"))).status, 404);
  });
});

describe("links", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });

  test("a link lasts the hours asked for, never past the file, and stops working after", async () => {
    const r = await B.boxPut(hub, "g:a", "a.txt", enc("abc"));
    const l5 = B.boxLink(hub, "g:a", r.ref, 5), g5 = T.grant(hub, tokenOf(l5));
    assert.ok(Math.abs(g5.exp - Date.now() - 5 * 3600000) < 2000);
    assert.equal(g5.mode, "get");
    const far = T.grant(hub, tokenOf(B.boxLink(hub, "g:a", r.ref, 10000)));
    const f = B.boxFile(hub, "g:a", r.ref);
    assert.ok(far.exp <= f.expires + 1000, "clamped to the file's expiry");
    const d = T.grant(hub, tokenOf(B.boxLink(hub, "g:a", r.ref)));
    assert.ok(Math.abs(d.exp - Date.now() - 72 * 3600000) < 2000);
    assert.equal((await get(hub, new URL(l5).pathname)).status, 200);
    hub.set("xfer:tok:" + tokenOf(l5), JSON.stringify({ ...g5, exp: Date.now() - 1 }));
    const res = await get(hub, new URL(l5).pathname);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /链接失效了/);
  });

  test("downloads carry the name, type and full bytes; a deleted file is gone", async () => {
    const r = await B.boxPut(hub, "g:a", "会议纪要.pdf", enc("%PDF-1.4 hello"));
    const res = await get(hub, new URL(r.link).pathname);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/pdf");
    assert.match(res.headers.get("content-disposition"), /^inline; .*filename\*=UTF-8''%E4%BC%9A/);
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(res.headers.get("content-length"), "14");
    assert.equal(await res.text(), "%PDF-1.4 hello");
    const dl = await get(hub, new URL(r.link).pathname + "?dl=1");
    assert.match(dl.headers.get("content-disposition"), /^attachment;/);
    const html = await B.boxPut(hub, "g:a", "x.html", enc("<script>alert(1)</script>"));
    const h = await get(hub, new URL(html.link).pathname);
    assert.match(h.headers.get("content-disposition"), /^attachment;/);
    assert.match(h.headers.get("content-security-policy"), /sandbox/);
    const tool = box.tools({ hub, conv: "g:a", askers: [], host: {} })[0];
    assert.equal((await tool.run({ op: "delete", file: r.ref })).ok, true);
    assert.equal((await get(hub, new URL(r.link).pathname)).status, 404);
  });

  test("Range requests across a part boundary, suffixes, HEAD and 416", async () => {
    const bytes = new Uint8Array(PART + 100);
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i / 4096) & 255;
    bytes[PART - 1] = 11; bytes[PART] = 22; bytes[PART + 99] = 33;
    const r = await B.boxPut(hub, "g:a", "片段.mp4", bytes);
    assert.equal(hub.db.prepare("SELECT parts FROM xfer").get().parts, 2);
    const p = new URL(r.link).pathname;
    const a = await get(hub, p, { range: "bytes=" + (PART - 2) + "-" + (PART + 1) });
    assert.equal(a.status, 206);
    assert.equal(a.headers.get("content-range"), "bytes " + (PART - 2) + "-" + (PART + 1) + "/" + (PART + 100));
    assert.equal(a.headers.get("content-length"), "4");
    assert.deepEqual([...new Uint8Array(await a.arrayBuffer())], [...bytes.subarray(PART - 2, PART + 2)]);
    const s = await get(hub, p, { range: "bytes=-1" });
    assert.deepEqual([...new Uint8Array(await s.arrayBuffer())], [33]);
    const bad = await get(hub, p, { range: "bytes=" + (PART + 100) + "-" });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */" + (PART + 100));
    const head = await route(hub, new Request("https://bot.example" + p, { method: "HEAD" }));
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(PART + 100));
    assert.match(head.headers.get("content-disposition"), /^inline;/);
    const stale = await get(hub, p, { range: "bytes=0-1", "if-range": '"other"' });
    assert.equal(stale.status, 200);
    await stale.body.cancel();
  });
});

describe("upload page and drop tokens", () => {
  let hub;
  beforeEach(() => { hub = fakeHub(); });

  test("the page is Chinese, self-contained and shows the limits", async () => {
    const d = B.newDrop(hub, "g:a", { note: "把会议录音传上来，我转成文字", by: "小明", files: 3 });
    assert.match(d.url, /^https:\/\/bot\.example\/x\/drop\/[0-9a-f]{32}$/);
    const res = await get(hub, "/x/drop/" + d.token);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /传文件给 Bot/);
    assert.match(html, /还能传 3 个文件/);
    assert.match(html, /把会议录音传上来/);
    assert.ok(!/src="http|href="http|@import/.test(html), "no external resources");
    assert.match(res.headers.get("content-security-policy"), /connect-src 'self'/);
    const script = html.split("<script>")[1].split("</script>")[0];
    new Function(script);   // the whole page script parses
  });

  test("the page script, run against a fake DOM and XHR, uploads picked files and reports the x refs", async () => {
    const d = B.newDrop(hub, "g:a", { by: "小明" });
    const script = (await (await get(hub, "/x/drop/" + d.token)).text()).split("<script>")[1].split("</script>")[0];
    const el = () => ({ hidden: false, className: "", textContent: "", value: "", style: {}, children: [], appendChild(c) { this.children.push(c); }, addEventListener() {} });
    const els = { by: { ...el(), value: " 阿强 " }, pick: el(), list: el(), msg: el(), again: el(), zone: el() };
    const document = {
      getElementById: id => els[id],
      createElement() {
        const kids = { span1: el(), span2: el(), bar: el(), s: el() };
        return { ...el(), kids, set innerHTML(_v) {}, querySelector: q => (q === "i" ? kids.bar : q === ".s" ? kids.s : kids.span1), querySelectorAll: () => [kids.span1, kids.span2] };
      },
    };
    const abs = u => "https://bot.example" + u;
    const fetch = (u, init = {}) => route(hub, new Request(abs(u), init));
    class XMLHttpRequest {
      upload = {};
      open(m, u) { this.m = m; this.u = u; }
      async send(blob) {
        const r = await route(hub, new Request(abs(this.u), { method: this.m, body: blob, headers: { "content-length": String(blob.size) } }));
        this.status = r.status; this.responseText = await r.text();
        this.upload.onprogress?.({ loaded: blob.size });
        this.onload();
      }
    }
    new Function("document", "XMLHttpRequest", "fetch", script)(document, XMLHttpRequest, fetch);
    const files = [new File([enc("第一个文件")], "一.txt", { type: "text/plain" }), new File([new Uint8Array(3000)], "二.bin")];
    els.pick.onchange.call({ files, value: "x" });
    for (let i = 0; i < 200 && !els.msg.textContent; i++) await new Promise(r => setTimeout(r, 5));
    assert.match(els.msg.textContent, /Bot 已经收到/);
    assert.equal(els.list.children.length, 2);
    for (const li of els.list.children) { assert.equal(li.className, "ok"); assert.match(li.kids.s.textContent, /编号 x\d+/); }
    assert.equal(hub.said.length, 1);
    assert.equal(hub.said[0].name, "阿强");
    assert.match(hub.said[0].text, /x\d+ 一\.txt（1 KB）、x\d+ 二\.bin（3 KB）/);
    const list = await box.tools({ hub, conv: "g:a", askers: [], host: {} })[0].run({ op: "list" });
    assert.deepEqual(list.files.map(f => f.name).sort(), ["一.txt", "二.bin"]);
  });

  test("tokens last 24 hours and are limited to the files and bytes fixed at creation", async () => {
    const d = B.newDrop(hub, "g:a", { files: 2, mb: 1 });
    assert.ok(Math.abs(d.exp - Date.now() - 86400000) < 2000);
    const s = (body, h) => post(hub, "/x/drop/" + d.token + "/start", body, h).then(r => r.json());
    const a = await s({ name: "a.bin", size: 600000 });
    assert.equal(a.ok, true);
    assert.equal(a.part, PART);
    assert.match(a.put, /^\/x\/put\/[0-9a-f]{32}\/[0-9a-f]{24}$/);
    assert.deepEqual(await s({ name: "a.bin", size: 600000 }), a, "the same file again resumes the same upload");
    const big = await s({ name: "b.bin", size: 600000 });
    assert.equal(big.ok, false);
    assert.match(big.error, /一共能传 1\.0 MB/);
    assert.equal((await s({ name: "b.bin", size: 400000 })).ok, true);
    const third = await s({ name: "c.bin", size: 1 });
    assert.match(third.error, /最多传 2 个文件/);
    assert.equal((await post(hub, "/x/drop/" + d.token + "/start", { name: "x", size: 1 }, { "sec-fetch-site": "cross-site" })).status, 403);
    const g = T.grant(hub, /\/x\/put\/([0-9a-f]{32})/.exec(a.put)[1]);
    assert.ok(g.exp <= d.exp + 1000 && g.exp > Date.now() + 23 * 3600000, "part uploads live as long as the page");
    const rec = JSON.parse(hub.get("box:drop:" + d.token));
    rec.exp = Date.now() - 1;
    hub.set("box:drop:" + d.token, JSON.stringify(rec));
    const page = await get(hub, "/x/drop/" + d.token);
    assert.equal(page.status, 404);
    assert.match(await page.text(), /链接失效了/);
    assert.equal((await s({ name: "z", size: 1 })).ok, false);
    assert.equal((await get(hub, "/x/drop/" + "0".repeat(32))).status, 404);
    assert.equal((await get(hub, "/x/drop/nothex")).status, 404);
  });

  test("promised bytes count against the room until they arrive", async () => {
    const d = B.newDrop(hub, "g:a");
    const before = B.room(hub);
    await post(hub, "/x/drop/" + d.token + "/start", { name: "a.bin", size: 5 * 1048576 });
    assert.equal(B.room(hub), before - 5 * 1048576);
  });

  test("a full box refuses a new upload page", () => {
    hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,?,?,?)", "box/q/full", B.LIMITS.total, 1, 1, Date.now());
    assert.equal(B.newDrop(hub, "g:a"), null);
  });
});

describe("upload page JavaScript (chunking and retry)", () => {
  const core = () => new Function(B.UPLOAD_CORE + "; return { sendParts, viaFetch };")();

  // An in-order server like /x/put: part 0 starts over, later parts must follow the last one.
  function server() {
    const s = { parts: [], done: false, log: [] };
    s.accept = (i, last, bytes) => {
      if (i > 0 && (s.done || s.parts.length !== i)) return 409;
      if (i === 0) { s.parts = []; s.done = false; }
      s.parts.push(bytes); s.done = last; return 200;
    };
    s.status = async () => ({ parts: s.parts.length, done: s.done, size: s.parts.reduce((a, b) => a + b.length, 0) });
    return s;
  }
  const data = Uint8Array.from({ length: 35 }, (_x, i) => i);

  test("uploads every part in order, flags only the last, retries a failed part", async () => {
    const { sendParts } = core(), s = server(), fail = new Set(["2:net", "1:lost"]), seen = [];
    const put = async (i, last, start, end) => {
      seen.push(i + (last ? "L" : ""));
      if (fail.delete(i + ":net")) throw new Error("network down");
      const code = s.accept(i, last, data.slice(start, end));
      if (fail.delete(i + ":lost")) return { status: 0 };   // landed, but the answer was lost
      return { status: code };
    };
    const progress = [];
    assert.equal(await sendParts({ size: 35, part: 10, tries: 3, put, status: s.status, sleep: async () => {}, progress: n => progress.push(n) }), true);
    assert.deepEqual(seen, ["0", "1", "2", "2", "3L"], "after the lost answer the status says part 1 landed, so it goes on with 2");
    assert.deepEqual(Buffer.concat(s.parts), Buffer.from(data));
    assert.ok(s.done);
    assert.deepEqual(progress, [10, 20, 20, 30, 35], "after a retry it reports where the server stands");
  });

  test("gives up after the allowed tries, and stops at once on a refusal", async () => {
    const { sendParts } = core(), s = server();
    await assert.rejects(sendParts({ size: 35, part: 10, tries: 2, put: async () => ({ status: 502 }), status: s.status, sleep: async () => {} }), /试了 2 次/);
    let n = 0;
    await assert.rejects(sendParts({ size: 35, part: 10, tries: 5, put: async () => (n++, { status: 507, error: "storage cap reached" }), status: s.status, sleep: async () => {} }), /storage cap/);
    assert.equal(n, 1);
  });

  test("an empty file is one empty last part; resuming starts where the server is", async () => {
    const { sendParts } = core(), s = server(), seen = [];
    await sendParts({ size: 0, part: 10, tries: 1, put: async (i, last, a, b) => (seen.push([i, last, a, b]), { status: s.accept(i, last, data.slice(a, b)) }), status: s.status, sleep: async () => {} });
    assert.deepEqual(seen, [[0, true, 0, 0]]);
    const t = server(); t.accept(0, false, data.slice(0, 10)); t.accept(1, false, data.slice(10, 20));
    const seen2 = [];
    await sendParts({ size: 35, part: 10, tries: 1, from: 2, put: async (i, last, a, b) => (seen2.push(i), { status: t.accept(i, last, data.slice(a, b)) }), status: t.status, sleep: async () => {} });
    assert.deepEqual(seen2, [2, 3]);
    assert.deepEqual(Buffer.concat(t.parts), Buffer.from(data));
  });

  test("end to end through the real routes with a fake fetch: start, parts, a failed part, done, a chat line", async () => {
    const hub = fakeHub(), { sendParts, viaFetch } = core();
    const d = B.newDrop(hub, "g:a", { by: "小红", sender: "u7", note: "转成文字" });
    const file = new Blob([new Uint8Array(PART).fill(1), enc("最后一段")]);
    const st = await (await post(hub, "/x/drop/" + d.token + "/start", { name: "访谈 录音.m4a", size: file.size, type: "audio/x-m4a" })).json();
    let failed = false;
    const fetch = async (url, init) => {
      if (!failed && /part=1/.test(url)) { failed = true; return new Response("{}", { status: 502 }); }
      return route(hub, new Request("https://bot.example" + url, { method: init.method, body: init.body, headers: { "content-length": String(init.body.size) } }));
    };
    const status = async () => (await get(hub, "/x/drop/" + d.token + "/status?f=" + st.f)).json();
    await sendParts({ size: file.size, part: st.part, tries: 3, put: viaFetch(fetch, st.put, file), status, sleep: async () => {} });
    assert.ok(failed);
    const done = await (await post(hub, "/x/drop/" + d.token + "/done", { by: "", files: [st.f] })).json();
    assert.equal(done.ok, true);
    const ref = done.files[0].ref;
    assert.match(ref, /^x\d+$/);
    const f = B.boxFile(hub, "g:a", ref);
    assert.equal(f.name, "访谈 录音.m4a");
    assert.equal(f.mime, "audio/mp4");
    assert.equal(f.by, "小红");
    assert.equal(f.size, file.size);
    assert.equal(sha(joined(hub, keyOf(hub, ref))), sha(Buffer.from(await file.arrayBuffer())));
    assert.equal(hub.said.length, 1);
    const m = hub.said[0];
    assert.equal(m.conv, "g:a"); assert.equal(m.mentioned, false); assert.equal(m.name, "小红"); assert.equal(m.sender, "u7");
    assert.match(m.text, new RegExp("通过上传页传了文件\\] " + ref + " 访谈 录音\\.m4a（80\\.0 MB）"));
    assert.match(m.text, /转成文字/);
    // done again: same answer, no second chat line
    const again = await (await post(hub, "/x/drop/" + d.token + "/done", {})).json();
    assert.equal(again.files[0].ref, ref);
    assert.equal(hub.said.length, 1);
    assert.equal((await (await get(hub, "/x/drop/" + d.token + "/status?f=" + st.f)).json()).ref, ref);
  });

  test("done refuses a file whose size does not match what was announced, and leaves unfinished ones alone", async () => {
    const hub = fakeHub();
    const d = B.newDrop(hub, "g:a");
    const a = await (await post(hub, "/x/drop/" + d.token + "/start", { name: "a.bin", size: 10 })).json();
    const b = await (await post(hub, "/x/drop/" + d.token + "/start", { name: "b.bin", size: 10 })).json();
    await putPart(hub, a.put + "?part=0&last=1", enc("12345"));
    const r = await (await post(hub, "/x/drop/" + d.token + "/done", {})).json();
    assert.match(r.files.find(x => x.f === a.f).error, /大小/);
    assert.match(r.files.find(x => x.f === b.f).error, /还没传完/);
    assert.equal(hub.said.length, 0);
    await putPart(hub, b.put + "?part=0&last=1", enc("1234567890"));
    const r2 = await (await post(hub, "/x/drop/" + d.token + "/done", {})).json();
    assert.match(r2.files.find(x => x.f === b.f).ref, /^x\d+$/);
    assert.equal(hub.said.length, 1);
  });
});

describe("tool", () => {
  let hub, tool;
  beforeEach(() => {
    hub = fakeHub();
    hub.sql.exec("INSERT INTO blob(conv,ts,name) VALUES('g:a',1,'报告.docx')");
    hub.sql.exec("INSERT INTO blob(conv,ts,name) VALUES('g:other',1,'secret.txt')");
    const host = { fileRef: async ref => (/^f1$/.test(ref) ? { name: "报告.docx", bytes: enc("docx bytes") } : /^https:/.test(ref) ? { name: "x.zip", bytes: enc("zip") } : null) };
    tool = box.tools({ hub, conv: "g:a", askers: [{ id: "u1", name: "小明" }], host })[0];
  });

  test("describes when to offer the page and that x refs go to skill and computer", () => {
    assert.equal(tool.name, "filebox");
    for (const w of ["upload_link", "录音", "视频", "PDF", "skill", "computer", "x12"]) assert.ok(tool.description.includes(w), w);
    assert.deepEqual(tool.parameters.properties.op.enum, ["upload_link", "list", "link", "delete"]);
    assert.ok(box.about.length >= 3 && box.about.every(l => /[一-鿿]/.test(l)));
    assert.equal(box.tunables.box_days.default, 7);
  });

  test("upload_link, link (copying f1 in), list, delete; other conversations' files stay out", async () => {
    const u = await tool.run({ op: "upload_link", note: "传视频", max_files: 3 });
    assert.equal(u.ok, true);
    assert.match(u.url, /\/x\/drop\/[0-9a-f]{32}$/);
    assert.equal(u.max_files, 3);
    assert.equal(JSON.parse(hub.get("box:drop:" + tokenOf(u.url))).sender, "u1");
    const l = await tool.run({ op: "link", file: "f1", hours: 5 });
    assert.equal(l.ok, true);
    assert.match(l.ref, /^x\d+$/);
    assert.match(l.url, /\/x\/box\/[0-9a-f]{32}\/%E6%8A%A5/);
    assert.equal(B.boxFile(hub, "g:a", l.ref).by, "小明");
    assert.equal((await tool.run({ op: "link", file: "f2" })).ok, false, "f2 belongs to another conversation");
    assert.equal((await tool.run({ op: "link", file: "x999" })).ok, false);
    const again = await tool.run({ op: "link", file: l.ref });
    assert.equal(again.ref, l.ref);
    const list = await tool.run({ op: "list" });
    assert.deepEqual(list.files.map(f => f.ref), [l.ref]);
    assert.equal(list.files[0].by, "小明");
    const other = box.tools({ hub, conv: "g:b", askers: [], host: {} })[0];
    assert.equal((await other.run({ op: "list" })).files.length, 0);
    assert.equal((await other.run({ op: "delete", file: l.ref })).ok, false);
    assert.equal((await tool.run({ op: "delete", file: l.ref })).ok, true);
    assert.equal((await tool.run({ op: "list" })).files.length, 0);
  });

  test("admin shows files, totals and outstanding tokens", async () => {
    await tool.run({ op: "upload_link" });
    await tool.run({ op: "link", file: "f1" });
    const res = await box.admin(hub, new Request("https://hub/admin/filebox"), new URL("https://hub/admin/filebox"), {});
    const j = await res.json();
    assert.equal(j.totals.files, 1);
    assert.equal(j.totals.box_limit, B.LIMITS.total);
    assert.equal(j.upload_pages.length, 1);
    assert.ok(j.box_links_outstanding >= 1);
    assert.equal(box.admin(hub, null, new URL("https://hub/admin/other"), {}), null);
  });
});

describe("shell commands against a local server", () => {
  let srv, port, hub, dir;
  const log = [], faults = [];
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "filebox-"));
    srv = createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1:" + port);
      if (req.method === "PUT") log.push(url.searchParams.get("part") + ":" + url.searchParams.get("last"));
      const fault = faults.findIndex(f => req.method === "PUT" && url.searchParams.get("part") === f.part);
      const mode = fault >= 0 ? faults.splice(fault, 1)[0].mode : "";
      if (mode === "before") { req.resume(); req.on("end", () => { res.writeHead(502); res.end("bad gateway"); }); return; }
      const hasBody = req.method === "PUT" || req.method === "POST";
      const r = await route(hub, new Request(url, { method: req.method, headers: req.headers, ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}) }));
      if (mode === "after") { if (r.body) await r.body.cancel(); res.writeHead(502); res.end("lost"); return; }
      res.writeHead(r.status, Object.fromEntries(r.headers));
      if (r.body) Readable.fromWeb(r.body).pipe(res); else res.end();
    });
    await new Promise(r => srv.listen(0, "127.0.0.1", r));
    port = srv.address().port;
  });
  after(() => { srv.close(); rmSync(dir, { recursive: true, force: true }); });
  beforeEach(() => { hub = fakeHub("http://127.0.0.1:" + port); log.length = 0; faults.length = 0; });

  test("every generated command passes bash -n, Chinese paths and quotes included", () => {
    const tricky = "/work/ag-box/会议 录音's \"终版\" $(rm -rf x).m4a";
    syntax(B.uploadCommand(tricky, "https://h/x/put/t/k", 123));
    syntax(B.downloadCommand("https://h/x/get/t/k", tricky, 9, "x1（会议's.m4a）"));
    syntax(B.boxUpload(hub, "g:a", tricky, "会议's.m4a").command);
    assert.ok(B.uploadCommand(tricky, "u", 1).includes("'/work/ag-box/会议 录音'\\''s \"终版\" $(rm -rf x).m4a'"));
  });

  test("a three-part upload goes in order with only the last part flagged, then downloads back identical", async () => {
    const src = join(dir, "源 文件's.bin");
    execFileSync("bash", ["-c", "head -c " + (2 * PART + 12345) + " /dev/urandom > \"$0\"", src]);
    const u = B.boxUpload(hub, "g:a", src, "源 文件's.bin");
    const r = await bash(u.command);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /已传进文件箱：\d+ 字节，3 段/);
    assert.deepEqual(log, ["0:0", "1:0", "2:1"]);
    const c = await u.claim();
    assert.equal(c.size, 2 * PART + 12345);
    const want = sha(readFileSync(src));
    assert.equal(sha(joined(hub, keyOf(hub, c.ref))), want);
    // back into "the machine": the download command, into a Chinese directory that does not exist yet
    const dest = join(dir, "下载 目录", "回来's.bin");
    const dl = B.boxDownloadCommand(hub, "g:a", c.ref, dest);
    syntax(dl);
    const d = await bash(dl);
    assert.equal(d.code, 0, d.err);
    assert.equal(sha(readFileSync(dest)), want);
    assert.ok(!existsSync(dest + ".part"));
    // and the browser link with a range across the first boundary
    const res = await fetch(c.link, { headers: { range: "bytes=" + (PART - 10) + "-" + (PART + 9) } });
    assert.equal(res.status, 206);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), readFileSync(src).subarray(PART - 10, PART + 10));
    rmSync(src);
  });

  test("a failed part is sent again; a part whose answer was lost is not sent twice", async () => {
    const src = join(dir, "two.bin");
    execFileSync("bash", ["-c", "head -c " + (PART + 1000) + " /dev/urandom > \"$0\"", src]);
    faults.push({ part: "1", mode: "before" });
    const u = B.boxUpload(hub, "g:a", src, "two.bin");
    const r = await bash(u.command);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(log, ["0:0", "1:1", "1:1"]);
    const c = await u.claim();
    assert.equal(sha(joined(hub, keyOf(hub, c.ref))), sha(readFileSync(src)));

    log.length = 0;
    faults.push({ part: "1", mode: "after" });   // stored, then the answer is lost: the retry gets 409 and moves on
    const u2 = B.boxUpload(hub, "g:a", src, "two.bin");
    const r2 = await bash(u2.command);
    assert.equal(r2.code, 0, r2.err);
    assert.deepEqual(log, ["0:0", "1:1", "1:1"]);
    const c2 = await u2.claim();
    assert.equal(sha(joined(hub, keyOf(hub, c2.ref))), sha(readFileSync(src)));
    rmSync(src);
  });

  test("small and empty files are one last part; a missing or oversize file fails clearly", async () => {
    const small = join(dir, "小.txt"), empty = join(dir, "空.txt");
    writeFileSync(small, "你好"); writeFileSync(empty, "");
    for (const [p, size] of [[small, 6], [empty, 0]]) {
      log.length = 0;
      const u = B.boxUpload(hub, "g:a", p, "");
      const r = await bash(u.command);
      assert.equal(r.code, 0, r.err);
      assert.deepEqual(log, ["0:1"]);
      const c = await u.claim();
      assert.equal(c.size, size);
      assert.equal(c.name, p.split("/").pop());
    }
    const miss = await bash(B.boxUpload(hub, "g:a", join(dir, "没有.bin"), "x").command);
    assert.notEqual(miss.code, 0);
    assert.match(miss.err, /要放进文件箱的文件不存在/);
    const over = await bash(B.uploadCommand(small, "http://127.0.0.1:" + port + "/x/put/" + "0".repeat(32) + "/k", 3));
    assert.notEqual(over.code, 0);
    assert.match(over.err, /文件太大/);
  });

  test("an upload with a dead token gives up with the HTTP code; a dead download link fails without leaving a file", async () => {
    const small = join(dir, "s.txt");
    writeFileSync(small, "abc");
    const r = await bash(B.uploadCommand(small, "http://127.0.0.1:" + port + "/x/put/" + "0".repeat(32) + "/k", 100));
    assert.notEqual(r.code, 0);
    assert.match(r.err, /传进文件箱失败：第 1\/1 段，HTTP 404/);
    const dest = join(dir, "dead", "out.bin");
    mkdirSync(join(dir, "dead"), { recursive: true });
    const d = await bash(B.downloadCommand("http://127.0.0.1:" + port + "/x/get/" + "0".repeat(32) + "/k", dest, 3, "x9（死链.bin）"));
    assert.notEqual(d.code, 0);
    assert.match(d.err, /从文件箱取 x9（死链\.bin） 失败/);
    assert.ok(!existsSync(dest) && !existsSync(dest + ".part"));
  });
});
