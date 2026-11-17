// The toolbox in two languages: nothing Chinese is left without an English entry, the dictionary has no dead
// entries, and the library functions speak English when the reader's language is English.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { assertCovered, dictProblems, hasCjk } from "./i18n-helpers.mjs";

const M = await import("../src/feat/toolbox.ts");
const P = await import("../src/feat/toolbox-page.ts");
const { TOOLBOX_EN, ABILITY_EN } = await import("../src/feat/toolbox-i18n.ts");
const files = M.files();
const html = files[""].body;

const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** What the page markup asks the script to translate: the text of data-i elements and the attributes named by data-ia. */
const chrome = (() => {
  const out = [];
  for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*\sdata-i(?=[\s>])[^>]*>([^<]*)</g)) out.push(unesc(m[1]));
  for (const m of html.matchAll(/<[a-z0-9]+\b[^>]*\sdata-ia="([^"]*)"[^>]*>/g)) {
    for (const a of m[1].split(" ")) { const v = new RegExp("\\s" + a + '="([^"]*)"').exec(m[0]); if (v) out.push(unesc(v[1])); }
  }
  return out.filter(hasCjk);
})();
const catalogue = M.GROUPS.flatMap(g => [g.name, ...g.items.flatMap(i => [i.title, i.hint])]).concat(M.ABILITIES.flatMap(a => [a.title, a.what, ...a.examples])).filter(hasCjk);

describe("coverage", () => {
  test("every Chinese string in the page scripts has an English entry, and every entry is used", () => {
    // The scripts as written, before the dictionary is put in (the served app.js carries the dictionary itself).
    const code = [P.APP_JS, P.TEXT_JS, P.RX_JS, P.IMAGE_JS, P.PDF_JS, P.QR_JS].join("\n;\n");
    assertCovered(code, TOOLBOX_EN, {
      // "中文" is the language's own name and stays as it is; the Worker in rx.js answers with its own Chinese `error` (the tests and the
      // page's fallback read it) and the page shows the translated message built from `msg`.
      keep: ["中文", "表达式写错了："],
      // Used by the markup the server writes (page(), GROUPS, ABILITIES) rather than by a script string.
      server: [...chrome, ...catalogue],
    });
  });
  test("the page markup, the tool list and the catalogue are all in the dictionary", () => {
    assert.ok(chrome.length >= 8, "the markup marks its texts with data-i");
    for (const s of [...chrome, ...catalogue]) assert.ok(s in TOOLBOX_EN, "no English for: " + s);
  });
  test("ABILITY_EN is exactly the catalogue, and the toolbox dictionary contains it", () => {
    const want = M.ABILITIES.flatMap(a => [a.title, a.what, ...a.examples]);
    assert.deepEqual(Object.keys(ABILITY_EN).sort(), [...new Set(want)].sort());
    for (const [k, v] of Object.entries(ABILITY_EN)) assert.equal(TOOLBOX_EN[k], v);
    assert.deepEqual(dictProblems(ABILITY_EN), []);
  });
  test("English examples keep their note and give a sentence that can be copied", () => {
    for (const a of M.ABILITIES) for (const e of a.examples) {
      const zh = M.exampleParts(e), en = M.exampleParts(ABILITY_EN[e]);
      assert.equal(!!en[1], !!zh[1], "note kept or left out the same way: " + e);
      assert.ok(en[0] && !/[()（）]/.test(en[0]), "copyable sentence: " + ABILITY_EN[e]);
    }
    assert.deepEqual(M.exampleParts("What is this article about? (paste the link)"), ["What is this article about?", "paste the link"]);
    assert.deepEqual(M.exampleParts("Make a meme that says “No overtime”"), ["Make a meme that says “No overtime”", ""]);
  });
  test("the dictionary has no emoji and every title is short enough to sit in the list", () => {
    assert.doesNotMatch(JSON.stringify(TOOLBOX_EN), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    for (const g of M.GROUPS) for (const i of g.items) assert.ok((TOOLBOX_EN[i.title] || i.title).length <= 32, i.title);
  });
  test("the page carries the picker, hidden until the script runs, and the example sentences to redraw", () => {
    assert.match(html, /<select id="lang" class="lang" hidden data-ia="aria-label" aria-label="界面语言"><option value="auto" data-i>跟随系统<\/option><option value="zh">中文<\/option><option value="en">English<\/option><\/select>/);
    assert.equal((html.match(/<li data-ex="/g) || []).length, M.ABILITIES.reduce((n, a) => n + a.examples.length, 0));
    assert.match(html, /<noscript><p>这些工具需要开启 JavaScript。<br>These tools need JavaScript\.<\/p><\/noscript>/);
    const app = files["app.js"].body;
    assert.ok(app.includes('"No overtime') === false && app.includes('"Toolbox"'), "the dictionary is inside app.js");
    assert.doesNotMatch(app, /__I18N__/);
  });
});

/** The scripts in a DOM-less context for a reader whose browser prefers `languages`. */
function toolbox(languages) {
  const ctx = { TextEncoder, TextDecoder, crypto, btoa, atob, URL };
  if (languages) ctx.navigator = { languages, language: languages[0] };
  ctx.self = ctx;
  vm.createContext(ctx);
  for (const k of ["app.js", "text.js", "rx.js", "image.js", "pdf.js", "qr.js"]) vm.runInContext(files[k].body, ctx, { filename: k });
  return ctx.TB;
}

describe("the library speaks the reader's language", () => {
  const now = Date.UTC(2026, 10, 15, 6, 30);
  test("no browser, or a Chinese one: the Chinese the tests always saw", () => {
    for (const tb of [toolbox(), toolbox(["zh-CN"]), toolbox(["zh-Hans", "en"])]) {
      assert.equal(tb.lib.time.rel(now - 3 * 3600e3, now), "3 小时前");
      assert.equal(tb.lib.gap(), "");
    }
  });
  test("English: relative times, with one and many", () => {
    const { lib: L } = toolbox(["en-AU", "zh-CN"]);
    assert.equal(L.time.rel(now - 3 * 3600e3, now), "3 hours ago");
    assert.equal(L.time.rel(now - 60e3, now), "1 minute ago");
    assert.equal(L.time.rel(now + 5 * 60e3, now), "in 5 minutes");
    assert.equal(L.time.rel(now + 86400e3, now), "in 24 hours");
    assert.equal(L.time.rel(now - 40 * 86400e3, now), "40 days ago");
    assert.equal(L.time.rel(now - 3 * 86400e3 * 30.44, now), "3 months ago");
    assert.equal(L.time.rel(now + 400 * 86400e3, now), "in 13 months");
    assert.equal(L.time.rel(now + 800 * 86400e3, now), "in 2.2 years");
    assert.equal(L.time.rel(now + 10e3, now), "just now");
    assert.equal(L.gap(), " ");
  });
  test("English: what a timestamp was read as, and why a date was refused", () => {
    const { lib: { time: T } } = toolbox(["en-US"]);
    assert.equal(T.parseTime("1731650000123", "UTC").kind, "a Unix timestamp in milliseconds");
    assert.equal(T.parseTime("2026-11-15T14:30:00+08:00", "UTC").kind, "a time with a time zone");
    assert.equal(T.parseTime("2026-11-15 14:30", "UTC").kind, "local time");
    assert.equal(T.parseTime("2026-02-30", "UTC").error, "Month 2 has no day 30");
    assert.match(T.parseTime("tomorrow", "UTC").error, /^Can't read that time\./);
    assert.equal(T.parseTime("2026-13-01", "UTC").error, "The date or time is out of range");
    // Input in Chinese is still understood, whatever the language of the page.
    assert.equal(new Date(T.parseTime("2026年11月15日 14点30分", "Asia/Shanghai").ms).toISOString(), "2026-11-15T06:30:00.000Z");
    assert.equal(T.ZONES[0][0], "北京", "the zone table itself stays as it is; the page translates it when drawing");
  });
  test("English: messages from the JSON, Base64, password and PDF page-range helpers", () => {
    const { lib: L } = toolbox(["en"]);
    assert.equal(L.json.format("  ").error, "Nothing to process");
    const bad = L.json.format('{"a":1,}');
    assert.equal(bad.ok, false);
    assert.match(bad.error, /^Error near line \d+, column \d+\. There is a trailing comma after the last item\.$/);
    assert.equal(L.json.format("{").error.startsWith("Error near line"), true);
    assert.throws(() => L.codec.b64decode("abc*"), /not Base64/);
    assert.throws(() => L.codec.b64decode("abcde"), /length is wrong/);
    assert.throws(() => L.pdf.parseRanges("", 10), /Enter the pages first/);
    assert.throws(() => L.pdf.parseRanges("0-2", 10), /start at 1/);
    assert.throws(() => L.pdf.parseRanges("9-11", 10), /only 10 pages; “9-11” is out of range/);
    assert.throws(() => L.pdf.parseRanges("2,x", 10), /Can't read “x”\. Write page numbers like 3 or 2-5\./);
    assert.throws(() => L.rand.password(8, {}, false), /Choose at least one character type/);
    assert.equal(L.rx("(", "", "x", null).msg.length > 0, true);
    assert.match(L.rx("(", "", "x", null).error, /写错/, "the Worker's own reply stays Chinese; the page builds the English from msg");
  });
  test("switching at run time changes the next message, and back again", () => {
    const tb = toolbox(["en-US"]);
    assert.equal(tb.lib.time.rel(now - 3 * 3600e3, now), "3 hours ago");
    tb.LANG.set("zh");
    assert.equal(tb.lib.time.rel(now - 3 * 3600e3, now), "3 小时前");
    assert.equal(tb.tx("复制"), "复制");
    tb.LANG.set("en");
    assert.equal(tb.tx("复制"), "Copy");
    tb.LANG.set("auto");
    assert.equal(tb.tx("复制"), "Copy", "following an English system");
  });
  test("every entry with {n} in its key and two forms reads right for 1 and for 2", () => {
    const tb = toolbox(["en"]);
    for (const [k, v] of Object.entries(TOOLBOX_EN)) {
      if (!Array.isArray(v)) continue;
      const one = tb.tx(k, { n: 1, size: "1 KB", off: "UTC+11", dst: "", date: "2026-04-05", btn: "Compress", plus: "", name: "a.pdf" });
      const two = tb.tx(k, { n: 2, size: "1 KB", off: "UTC+11", dst: "", date: "2026-04-05", btn: "Compress", plus: "", name: "a.pdf" });
      assert.notEqual(one, two, k);
      assert.doesNotMatch(one + two, /\{\w+\}/, "all slots filled: " + k);
    }
  });
});
