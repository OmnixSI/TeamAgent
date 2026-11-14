// Offline tests for the web kit: a fake BROWSER binding answering Quick Actions in the shapes Cloudflare really
// returns (observed on a lab Worker), a fake model, a fake read_url and library, and the real budget meter.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import feature, { deps, looseJson, fillFields, toCsv, csvCell, pageUrl, sameSite, matcher, crawl, titleOf, quick, failReason } from "../src/feat/webkit.ts";
import { Plan, PLAN } from "../src/budget.ts";

const META = (url, status = 200, title = "") => ({ status, title, headers: {}, finalUrl: url });
const json = (body, status = 200, ms = 300) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "x-browser-ms-used": String(ms) } });
const bin = (bytes, type, ms = 500) => new Response(bytes, { status: 200, headers: { "content-type": type, "x-browser-ms-used": String(ms) } });
const DNS_FAIL = () => json({ success: false, errors: [{ code: 5006, message: "Network connection closed.", detail: "Can also happen due to failure to resolve DNS." }] }, 422, 0);

let hub, calls, kept, sentImages, sentFiles, modelCalls, modelReply, pages, linkMap, readUrl, quotaLeft, libSaved;

function makeHub() {
  const kv = new Map();
  const h = {
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => void kv.set(k, String(v)),
    env: {
      BROWSER: {
        quickAction: async (action, body) => {
          calls.push({ action, body });
          const url = body.url;
          if (action === "markdown") {
            const p = pages[url];
            if (p === undefined) return DNS_FAIL();
            if (p.status) return json({ success: true, result: p.text || "", meta: META(url, p.status, p.title) }, 200, 200);
            return json({ success: true, result: "---\ntitle: \"" + p.title + "\"\n---\n\n" + p.text, meta: META(url, 200, p.title) }, 200, 400);
          }
          if (action === "links") {
            const l = linkMap[url];
            if (!l) return DNS_FAIL();
            return json({ success: true, result: l, meta: META(url) }, 200, 250);
          }
          if (action === "pdf") return bin(new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3]), "application/pdf", 1400);
          if (action === "screenshot") return bin(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]), "image/jpeg", 900);
          return json({ success: false, errors: [{ code: "x", message: "unknown" }] }, 400, 0);
        },
      },
    },
    tools: () => [
      { name: "read_url", run: async ({ url }) => { readUrl.push(url); const p = pages["reader:" + url]; if (!p) throw new Error("这个页面读不出来"); return { title: p.title, content: p.text }; } },
      { name: "library", run: async a => { libSaved.push(a); return { ok: true, id: 7, title: "存好了" }; } },
    ],
  };
  h.plan = new Plan(h);
  return h;
}
const host = {
  cfg: k => feature.tunables[k].default,
  quota: async () => quotaLeft-- > 0,
  keepFile: async (name, bytes) => { kept.push({ name, bytes }); return "f" + kept.length; },
  sendImage: async (bytes, note, mime, silent) => { sentImages.push({ bytes, note, silent }); return { ok: true, id: "g" + sentImages.length }; },
  sendFile: async (name, bytes) => { sentFiles.push({ name, bytes }); return { ok: true }; },
};
const tool = name => feature.tools({ hub, conv: "t:ag-web", askers: [{ id: "1", name: "小明" }], host }).find(t => t.name === name);
const usedSecs = () => hub.plan.used("browser_seconds");

const LONG = "这是一段足够长的正文，用来通过最短长度的检查。".repeat(5);
beforeEach(() => {
  calls = []; kept = []; sentImages = []; sentFiles = []; modelCalls = []; readUrl = []; libSaved = []; quotaLeft = 99;
  pages = {
    "https://shop.example/a": { title: "A 商品", text: LONG + "\n现价 ¥199，型号 X-1。\n上架时间：2026年3月1日。" },
    "https://shop.example/b": { title: "B 商品", text: LONG + "\n售价：$25.00 (含税)\n型号 \"Pro\", 二代" },
    "https://shop.example/blocked": { status: 403, title: "Just a moment...", text: "Just a moment..." },
    "reader:https://shop.example/blocked": { title: "B 读到了", text: LONG + "\n价格 88 元" },
  };
  linkMap = {};
  modelReply = (user) => {
    if (user.includes("X-1")) return "```json\n{\"价格\": {\"value\": \"¥199\", \"quote\": \"现价 ¥199，型号 X-1。\"}, \"作者\": {\"value\": null, \"quote\": null},}\n```";
    if (user.includes("Pro")) return "好的：{\"价格\": {\"value\": \"$25.00\", \"quote\": \"售价：$25.00 (含税)\"}, \"作者\": {\"value\": \"张三\", \"quote\": \"作者张三\"}}";
    if (user.includes("88 元")) return "{\"价格\": {\"value\": \"88 元\", \"quote\": \"价格 88 元\"}, \"作者\": {\"value\": \"未找到\", \"quote\": null}}";
    return "not json at all";
  };
  deps.model = async (_h, system, user) => { modelCalls.push({ system, user }); return modelReply(user); };
  deps.fetch = async url => new Response("<html><head><title>" + (url.endsWith("/") ? "首页" : "页 " + url.split("/").pop()) + " &amp; 文档</title></head><body>x</body></html>", { headers: { "content-type": "text/html" } });
  hub = makeHub();
});

const FIELDS = [{ name: "价格", what: "现价" }, { name: "作者", what: "作者名" }];

describe("strict JSON repair", () => {
  test("fences, trailing commas, prose around it", () => {
    assert.deepEqual(looseJson("```json\n{\"a\": 1,}\n```"), { a: 1 });
    assert.deepEqual(looseJson("结果如下：{\"a\": [1, 2,], \"b\": null} 以上"), { a: [1, 2], b: null });
  });
  test("python literals and a cut-off end", () => {
    assert.deepEqual(looseJson("{\"a\": None, \"b\": True, \"c\": {\"v\": \"x"), { a: null, b: true, c: { v: "x" } });
  });
  test("curly quotes as JSON quotes, but Chinese quotes inside values survive", () => {
    assert.deepEqual(looseJson("{“a”: “b”}"), { a: "b" });
    assert.deepEqual(looseJson("{\"t\": \"他说“你好”\",}"), { t: "他说“你好”" });
  });
  test("nothing usable", () => { assert.equal(looseJson("没有找到"), null); });
});

describe("field filling", () => {
  test("nulls are kept, empty markers become null, quotes are checked against the page", () => {
    const text = "现价 **¥199**，型号 X-1。";
    const r = fillFields([...FIELDS, { name: "型号", what: "" }, { name: "日期", what: "" }], {
      价格: { value: "¥199", quote: "现价 ¥199，型号 X-1。" }, 作者: { value: "无", quote: "x" }, 型号: { value: "X-9", quote: "型号 X-9" },
    }, text);
    assert.equal(r.values.价格, "¥199");
    assert.equal(r.quotes.价格, "现价 ¥199，型号 X-1。");
    assert.equal(r.values.作者, null);
    assert.equal(r.quotes.作者, null);
    assert.equal(r.values.日期, null, "missing field stays null");
    assert.equal(r.quotes.型号, null, "a quote not on the page is dropped");
    assert.deepEqual(r.unchecked, ["型号"]);
  });
  test("plain values without {value, quote} and a {fields: …} wrapper", () => {
    const r = fillFields(FIELDS, { fields: { 价格: "¥5", 作者: null } }, "价格 ¥5");
    assert.deepEqual(r.values, { 价格: "¥5", 作者: null });
    assert.deepEqual(r.unchecked, []);
  });
});

describe("CSV", () => {
  test("escaping", () => {
    assert.equal(csvCell("a,b"), "\"a,b\"");
    assert.equal(csvCell("say \"hi\""), "\"say \"\"hi\"\"\"");
    assert.equal(csvCell("x\ny"), "\"x\ny\"");
    assert.equal(csvCell(null), "");
    assert.equal(csvCell(" pad"), "\" pad\"");
    assert.equal(csvCell("plain"), "plain");
  });
  test("content: BOM, header, values, quotes, failures", () => {
    const csv = toCsv(FIELDS, [
      { url: "https://a", title: "A", ok: true, values: { 价格: "$1,000", 作者: null }, quotes: { 价格: "售价 \"$1,000\"", 作者: null } },
      { url: "https://b", ok: false, error: "页面不存在（404）" },
    ]);
    assert.ok(csv.startsWith("﻿链接,标题,价格,作者,价格（原文）,作者（原文）,状态\r\n"));
    const lines = csv.slice(1).trim().split("\r\n");
    assert.equal(lines[1], "https://a,A,\"$1,000\",,\"售价 \"\"$1,000\"\"\",,成功");
    assert.equal(lines[2], "https://b,,,,,,失败：页面不存在（404）");
  });
});

describe("web_extract", () => {
  test("rows, nulls, fallback reader, failures on some pages do not fail the call", async () => {
    const r = await tool("web_extract").run({ urls: ["https://shop.example/a", "https://shop.example/b", "https://shop.example/blocked", "https://gone.example/x"], fields: FIELDS });
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 4);
    const [a, b, blocked, gone] = r.rows;
    assert.deepEqual(a.values, { 价格: "¥199", 作者: null });
    assert.equal(a.quotes.价格, "现价 ¥199，型号 X-1。");
    assert.equal(b.values.价格, "$25.00");
    assert.deepEqual(b.not_found_in_page, ["作者"], "a value whose quote is not on the page is flagged");
    assert.equal(b.quotes.作者, null);
    assert.equal(blocked.values.价格, "88 元", "blocked page read through read_url");
    assert.equal(blocked.values.作者, null);
    assert.match(gone.failed, /连不上/);
    assert.deepEqual(r.failed.map(f => f.url), ["https://gone.example/x"]);
    assert.equal(modelCalls.length, 3, "one model call per readable page");
    assert.ok(modelCalls[0].system.includes("null") && modelCalls[0].user.includes("- 价格：现价"));
    assert.ok(!modelCalls[0].user.includes("title: "), "front matter stripped");
    assert.equal(r.csv, "f1");
    assert.equal(kept[0].name.endsWith(".csv"), true);
    const csv = new TextDecoder().decode(kept[0].bytes);
    assert.ok(csv.includes("失败：连不上"));
    assert.ok(csv.includes("\"$25.00\"") === false && csv.includes("$25.00"));
  });
  test("a page whose model reply is unreadable is a failed row", async () => {
    pages["https://x.example/"] = { title: "X", text: LONG };
    const r = await tool("web_extract").run({ urls: ["https://x.example/", "https://shop.example/a"], fields: FIELDS });
    assert.equal(r.ok, true);
    assert.match(r.rows[0].failed, /JSON/);
  });
  test("bad arguments", async () => {
    assert.equal((await tool("web_extract").run({ urls: [], fields: FIELDS })).ok, false);
    assert.equal((await tool("web_extract").run({ urls: Array.from({ length: 13 }, (_, i) => "https://a.example/" + i), fields: FIELDS })).ok, false);
    assert.equal((await tool("web_extract").run({ urls: ["https://a.example/"], fields: [] })).ok, false);
  });
  test("daily cap", async () => {
    quotaLeft = 0;
    const r = await tool("web_extract").run({ urls: ["https://shop.example/a"], fields: FIELDS });
    assert.equal(r.ok, false);
    assert.match(r.error, /web_extract_daily/);
  });
});

describe("metering", () => {
  test("actual time from the header is added", async () => {
    const before = usedSecs();
    const g = await quick(hub, "markdown", { url: "https://shop.example/a" });
    assert.equal(g.ok, true);
    assert.equal(g.title, "A 商品");
    assert.equal(g.secs, 0.4);
    assert.equal(Math.round((usedSecs() - before) * 100) / 100, 0.4);
    const p = await quick(hub, "pdf", { url: "https://shop.example/a" });
    assert.equal(p.mime, "application/pdf");
    assert.equal(p.bytes[0], 0x25);
    assert.equal(Math.round((usedSecs() - before) * 100) / 100, 1.8);
  });
  test("each call checks its estimate first", async () => {
    const stop = PLAN.browser_seconds.stop;
    hub.plan.add("browser_seconds", stop - 3);   // less than one markdown estimate left
    await assert.rejects(quick(hub, "markdown", { url: "https://shop.example/a" }), /停止线/);
    assert.equal(calls.length, 0);
  });
  test("a big request is refused before it starts when the month is nearly used", async () => {
    hub.plan.add("browser_seconds", PLAN.browser_seconds.stop - 30);   // 30 s left, 12 pages need 60
    const urls = Array.from({ length: 12 }, (_, i) => "https://shop.example/p" + i);
    const r = await tool("web_extract").run({ urls, fields: FIELDS });
    assert.equal(r.ok, false);
    assert.match(r.error, /停止线/);
    assert.equal(calls.length, 0);
    assert.equal(quotaLeft, 99, "refusal does not use the daily allowance");
    const a = await tool("web_archive").run({ url: "https://shop.example/a" });
    assert.equal(a.ok, true, "a single archive (23 s) still fits");
  });
  test("refused at the stop line", async () => {
    hub.plan.add("browser_seconds", PLAN.browser_seconds.stop);
    for (const [name, args] of [["web_archive", { url: "https://shop.example/a" }], ["site_map", { url: "https://docs.example/" }], ["web_extract", { urls: ["https://shop.example/a"], fields: FIELDS }]]) {
      const r = await tool(name).run(args);
      assert.equal(r.ok, false, name);
      assert.match(r.error, /停止线/);
    }
    assert.equal(calls.length, 0);
  });
  test("failure reasons", () => {
    assert.match(failReason(422, [{ code: 5006, message: "Network connection closed." }]), /连不上/);
    assert.match(failReason(403), /拦截/);
    assert.match(failReason(404), /不存在/);
    assert.match(failReason(422, [{ code: 6000, message: "The execution context was destroyed, most likely because of a navigation" }]), /跳转/);
  });
});

describe("web_archive", () => {
  test("text, library, PDF and screenshot, delivered", async () => {
    const r = await tool("web_archive").run({ url: "https://shop.example/a" });
    assert.equal(r.ok, true);
    assert.equal(r.title, "A 商品");
    assert.equal(r.text_file, "f1");
    assert.ok(kept[0].name.endsWith(".md") && new TextDecoder().decode(kept[0].bytes).includes("来源：https://shop.example/a"));
    assert.deepEqual(libSaved, [{ op: "save", url: "https://shop.example/a" }]);
    assert.equal(r.library.id, 7);
    assert.equal(r.pdf.ref, "f2");
    assert.equal(r.pdf.sent, true);
    assert.equal(sentFiles.length, 1);
    assert.equal(r.screenshot, "g1");
    assert.equal(sentImages[0].silent, false);
    assert.deepEqual(calls.map(c => c.action), ["markdown", "pdf", "screenshot"]);
    assert.equal(calls[2].body.screenshotOptions.type, "jpeg");
    assert.equal(r.problems, undefined);
  });
  test("deliver false keeps quietly; pdf false skips it", async () => {
    const r = await tool("web_archive").run({ url: "https://shop.example/a", deliver: false, pdf: false });
    assert.equal(r.pdf, undefined);
    assert.equal(sentFiles.length, 0);
    assert.equal(sentImages[0].silent, true);
    assert.equal(calls.some(c => c.action === "pdf"), false);
  });
  test("a page that cannot be opened at all", async () => {
    const r = await tool("web_archive").run({ url: "https://gone.example/" , pdf: false, screenshot: false });
    assert.equal(r.ok, false);
    assert.match(r.error, /连不上/);
  });
});

describe("site map", () => {
  test("link normalisation", () => {
    assert.equal(pageUrl("/docs/a/#intro", "https://docs.example/start"), "https://docs.example/docs/a");
    assert.equal(pageUrl("b?utm_source=x&z=1&a=2", "https://docs.example/docs/"), "https://docs.example/docs/b?a=2&z=1");
    assert.equal(pageUrl("mailto:a@b.c", "https://docs.example/"), null);
    assert.equal(pageUrl("/logo.png", "https://docs.example/"), null);
    assert.equal(pageUrl("javascript:void(0)", "https://docs.example/"), null);
  });
  test("same site", () => {
    assert.equal(sameSite("https://www.docs.example/a", "https://docs.example/"), true);
    assert.equal(sameSite("https://other.example/a", "https://docs.example/"), false);
    assert.equal(sameSite("https://api.docs.example/a", "https://docs.example/"), false);
  });
  test("wildcard and substring matching", () => {
    const w = matcher("/blog/2026/*");
    assert.equal(w("https://x.example/blog/2026/hello"), true);
    assert.equal(w("https://x.example/blog/2025/hello"), false);
    assert.equal(w("https://x.example/blog/2026"), true);
    const s = matcher("Guide");
    assert.equal(s("https://x.example/docs/user-guide"), true);
    assert.equal(s("https://x.example/docs/api"), false);
    const loose = matcher("*.html");
    assert.equal(loose("https://x.example/a/b.html"), true);
    assert.equal(matcher("docs*api")("https://x.example/en/docs/v2/api"), true);
    assert.equal(matcher("")("https://anything"), true);
  });
  test("breadth-first, two levels, limit, same-site filter, page failures", async () => {
    linkMap = {
      "https://docs.example/": ["https://docs.example/a", "/b", "https://other.example/x", "https://docs.example/#top", "https://docs.example/a#sec", "/c"],
      "https://docs.example/a": ["https://docs.example/a1", "https://docs.example/a2", "https://docs.example/b"],
      "https://docs.example/c": ["https://docs.example/c1"],
      "https://docs.example/a1": ["https://docs.example/deep"],
    };
    const r = await tool("site_map").run({ url: "https://docs.example/", limit: 6 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.pages.map(p => [p.url.replace("https://docs.example", ""), p.level]), [["/a", 1], ["/b", 1], ["/c", 1], ["/a1", 2], ["/a2", 2], ["/c1", 2]]);
    assert.equal(r.pages[0].title, "页 a & 文档");
    assert.deepEqual(r.failed.map(f => f.url), ["https://docs.example/b"], "a level-1 page that fails is reported, not fatal");
    assert.equal(calls.filter(c => c.action === "links").length, 4);
    assert.ok(!calls.some(c => c.body.url.endsWith("/a1")), "level-2 pages are never expanded");
    assert.match(r.tip, /上限/);
  });
  test("other sites when same_site_only is false; match filters what is listed", async () => {
    linkMap = { "https://docs.example/": ["https://other.example/x", "/guide/one", "/api/two"] };
    const all = await tool("site_map").run({ url: "https://docs.example/", same_site_only: false });
    assert.ok(all.pages.some(p => p.url === "https://other.example/x"));
    const g = await tool("site_map").run({ url: "https://docs.example/", match: "/guide/*" });
    assert.deepEqual(g.pages.map(p => p.url), ["https://docs.example/guide/one"]);
  });
  test("start page that cannot be opened", async () => {
    const r = await tool("site_map").run({ url: "https://nowhere.example/" });
    assert.equal(r.ok, false);
    assert.match(r.error, /起始页面打不开/);
  });
  test("crawl stops expanding at the expand cap", async () => {
    const seen = [];
    const getLinks = async u => { seen.push(u); return { ok: true, links: u === "https://s.example/" ? ["/1", "/2", "/3", "/4"] : [u + "/x"], secs: 0 }; };
    const r = await crawl(getLinks, "https://s.example/", { limit: 60, sameSite: true, match: "", expand: 3 });
    assert.equal(seen.length, 3);
    assert.equal(r.pages.length, 6);
  });
  test("title parsing", () => {
    assert.equal(titleOf("<head><title>\n  A &amp; B &#39;c&#39;  </title>"), "A & B 'c'");
    assert.equal(titleOf("<p>none</p>"), "");
  });
});
