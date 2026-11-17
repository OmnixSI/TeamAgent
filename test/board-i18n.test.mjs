// The board in Chinese or English: every Chinese string the page writes has an English entry, the words the
// server sends are covered, the shell carries its markers, and the script that reaches the browser keeps working.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { APP_JS, PAGE } from "../src/feat/board-page.ts";
import { BOARD_EN, PAGE_EN, SERVER_EN } from "../src/feat/board-i18n.ts";
import { ABILITY_EN } from "../src/feat/toolbox-i18n.ts";
import { ABILITIES } from "../src/feat/toolbox.ts";
import { RUNTIME, withDict } from "../src/i18n.ts";
import { BADGES, ITEMS } from "../src/feat/teamwork.ts";
import { REF_LABEL } from "../src/feat/tasks.ts";
import { PLAN, DAILY } from "../src/budget.ts";
import { countText, changesBetween } from "../src/feat/repocheck.ts";
import { stringLiterals, hasCjk, untranslated, dictProblems } from "./i18n-helpers.mjs";

// The script as written, before the dictionary is put in.
const RAW = APP_JS.replace(JSON.stringify(BOARD_EN), '"__I18N__"');
const HTML = PAGE("/app.css", "/app.js");
const KEEP = ["中文", "\u3000"];   // the Chinese name of the language, and a layout space
// Dates: the page passes the month name too ({mon}), and English leaves out what Chinese needs ({m} before 月).
const DATES = ["{y}年{m}月{d}日 {w} {t}", "{m}月{d}日", "{y}年{m}月{d}日", "{m}月{d}日 {w}", "{m}月{d}日–{e}日", "{m}月{d}日–{n}月{e}日", "{m}月 {w}"];

/** What a browser sets up for the given language. */
function browser(language, stored) {
  const ctx = { navigator: { languages: [language], language }, window: { localStorage: { getItem: () => stored ?? null, setItem() {}, removeItem() {} }, addEventListener() {} }, Object, String, RegExp, Array };
  vm.createContext(ctx);
  vm.runInContext(withDict(RUNTIME, BOARD_EN) + "\nthis.LANG = LANG; this.tx = tx; this.txs = txs;", ctx);
  return ctx;
}

describe("the page script", () => {
  test("the dictionary went into the script that is served, once", () => {
    assert.notEqual(RAW, APP_JS);
    assert.equal(RAW.includes("__I18N__"), true);
    assert.equal(APP_JS.split(JSON.stringify(BOARD_EN)).length, 2);
  });
  test("every Chinese string in it has an English entry", () => {
    assert.deepEqual(untranslated(RAW, BOARD_EN, KEEP), []);
  });
  test("entries are well formed: same {slots}, [one, other] only with {n}, no Chinese left", () => {
    assert.deepEqual(dictProblems(BOARD_EN, { loose: DATES }), []);
  });
  test("the page's own entries are all used by the script or the page shell", () => {
    const used = new Set(stringLiterals(RAW));
    for (const m of HTML.matchAll(/<[^>]*\bdata-i\b[^>]*>([^<]+)</g)) used.add(m[1]);
    for (const tag of HTML.matchAll(/<[^>]*\bdata-ia="([^"]*)"[^>]*>/g)) for (const a of tag[1].split(" ")) used.add(new RegExp(`\\b${a}="([^"]*)"`).exec(tag[0])?.[1]);
    for (const m of HTML.matchAll(/<span class="(?:l|s)" data-i>([^<]+)</g)) used.add(m[1]);
    assert.deepEqual(Object.keys(PAGE_EN).filter(k => !used.has(k)), []);
  });
  test("the script still parses and carries no absolute URLs outside the dictionary", () => {
    new Function(APP_JS);
    assert.doesNotMatch(RAW, /https?:\/\//);
  });
  test("the squeezed runtime inside it works", () => {
    const m = /var LANG=\(function\(\)\{[\s\S]*?var tx=LANG\.t,txs=LANG\.tr;/.exec(APP_JS);
    assert.ok(m, "runtime found in the served script");
    for (const [language, want] of [["en-AU", "Overview"], ["zh-CN", "概览"]]) {
      const ctx = { navigator: { languages: [language] }, window: { localStorage: { getItem: () => null }, addEventListener() {} }, Object, String, RegExp, Array };
      vm.createContext(ctx);
      vm.runInContext(m[0] + "\nthis.out = [tx('概览'), tx('{n} 天', { n: 1 }), txs('没有编号 7 的任务')];", ctx);
      assert.equal(ctx.out[0], want);
      assert.equal(ctx.out[1], language === "en-AU" ? "1 day" : "1 天");
      assert.equal(ctx.out[2], language === "en-AU" ? "There is no task numbered 7" : "没有编号 7 的任务");
    }
  });
});

describe("the page shell", () => {
  test("is Chinese until the script says otherwise, and every marked text and attribute has an English entry", () => {
    assert.match(HTML, /<html lang="zh-CN">/);
    const texts = [...HTML.matchAll(/<[^>]*\bdata-i\b[^>]*>([^<]+)</g)].map(m => m[1]);
    assert.ok(texts.length > 20);
    for (const t of texts) assert.ok(BOARD_EN[t], "no English for page text: " + t);
    let attrs = 0;
    for (const tag of HTML.matchAll(/<[^>]*\bdata-ia="([^"]*)"[^>]*>/g)) for (const a of tag[1].split(" ")) {
      const v = new RegExp(`\\b${a}="([^"]*)"`).exec(tag[0])?.[1];
      assert.ok(v && BOARD_EN[v], `no English for ${a} of ${tag[0].slice(0, 60)}`);
      attrs++;
    }
    assert.ok(attrs > 20);
  });
  test("no Chinese in the shell is left unmarked", () => {
    const unmarked = [...HTML.matchAll(/<([a-z0-9]+)\b([^>]*)>([^<]*)</g)]
      .filter(m => hasCjk(m[3]) && !/\bdata-i\b/.test(m[2]) && !/\bid="title"/.test(m[2]) && m[1] !== "noscript").map(m => m[3]);   // the h1 is written by the script at once
    const attrsUnmarked = [...HTML.matchAll(/<[^>]*>/g)].map(m => m[0]).filter(tag => {
      if (!/\b(aria-label|title|placeholder)="[^"]*[一-鿿]/.test(tag)) return false;
      const marked = (/\bdata-ia="([^"]*)"/.exec(tag)?.[1] || "").split(" ");
      return [...tag.matchAll(/\b(aria-label|title|placeholder)="([^"]*[一-鿿][^"]*)"/g)].some(m => !marked.includes(m[1]));
    });
    assert.deepEqual(unmarked, []);
    assert.deepEqual(attrsUnmarked, []);
  });
  test("has one language button, in the header beside refresh, so desktop and phone share it", () => {
    assert.match(HTML, /<button[^>]*id="refresh"[^>]*>[^]*?<\/button><button[^>]*id="lang"[^>]*aria-haspopup="menu"[^>]*>[^]*?<\/button><\/header>/);
    assert.equal(HTML.match(/id="lang"/g).length, 1);
  });
  test("the noscript note is in both languages, since without a script nothing can choose", () => {
    assert.match(HTML, /<noscript>[^]*看板需要开启 JavaScript。<br>The board needs JavaScript\./);
  });
});

describe("words the server sends", () => {
  const board = fs.readFileSync(new URL("../src/feat/board.ts", import.meta.url), "utf8");
  const have = s => assert.ok(BOARD_EN[s], "no English for server text: " + s);
  test("API and file errors", () => {
    const found = new Set();
    for (const m of board.matchAll(/\bbad\("([^"]+)"/g)) found.add(m[1]);
    for (const m of board.matchAll(/\btext\(\d{3}, "([^"]+)"/g)) found.add(m[1]);
    for (const m of board.matchAll(/\breturn "([^"]*)"(?!\s*\+)/g)) found.add(m[1]);
    const sentences = [...found].filter(hasCjk);
    assert.ok(sentences.length > 30, "found the errors: " + sentences.length);
    sentences.forEach(have);
    have(/const NO_PERSON = "([^"]+)"/.exec(board)[1]);
    have("没有编号 {id} 的任务");
  });
  test("quota items, units, the cycle and its rule", () => {
    for (const p of Object.values(PLAN)) { have(p.what); have(p.what.split(/[，（]/)[0]); if (hasCjk(p.unit)) have(p.unit); }
    for (const p of Object.values(DAILY)) { have(p.what + "（今天）"); if (hasCjk(p.unit)) have(p.unit); }
    ["R2 存储，免费额度 10 GB", "R2 存储", "Durable Object 在线时长（常驻 QQ 长连接，全月在线是固定开销）", "Durable Object 在线时长", "GB·秒", "{a} 到 {b}",
      "每一项用到停止线就不再用，等下个周期；不会产生套餐外的费用"].forEach(have);
    const src = fs.readFileSync(new URL("../src/budget.ts", import.meta.url), "utf8");
    assert.ok(src.includes('rule: "每一项用到停止线就不再用，等下个周期；不会产生套餐外的费用"'), "the rule sentence the dictionary knows is still the one the server sends");
  });
  test("badges, rewards, material labels and records", () => {
    for (const b of BADGES) { have(b.name); have(b.what); }
    for (const i of ITEMS) { have(i.name); have(i.what); if (i.needs) have(i.needs); }
    for (const l of Object.values(REF_LABEL)) have(l);
    const tw = fs.readFileSync(new URL("../src/feat/teamwork.ts", import.meta.url), "utf8");
    const records = [...tw.matchAll(/records\.push\(\{ what: "([^"]+)"/g)].map(m => m[1]);
    assert.equal(records.length, 5);
    records.forEach(have);
    ["{n} 天", "{n} 件", "{n} 分", "{n} 小时", "{n} 分钟", "{n} 天半"].forEach(have);
  });
  test("repository check texts come out in English with the server's own functions", () => {
    const en = browser("en-US");
    const row = (ok, steps, sha, ts) => ({ ok, ts, summary: { repo: "teamagent", sha, steps, loc: { total: 100, by: {} } } });
    const st = (id, s, c) => ({ id, s, c, t: 1 });
    const prev = row(1, [st("teamagent:test", "pass", { n: 10, p: 10, f: 0, s: 0 }), st("teamagent:typecheck", "pass")], "aaaaaaa1", 1);
    const cur = row(0, [st("teamagent:test", "fail", { n: 12, p: 10, f: 2, s: 0 }), st("teamagent:typecheck", "skip")], "bbbbbbb2", 2);
    for (const line of [...changesBetween(prev, cur), ...changesBetween(undefined, cur), ...changesBetween(cur, cur),
      countText({ n: 5, p: 5, f: 0, s: 0 }), countText({ n: 5, p: 3, f: 1, s: 1 }), countText({ n: 5, p: 4, f: 1, s: 0 }), countText({ n: 5, p: 4, f: 0, s: 1 })]) {
      const t = en.txs(line);
      assert.equal(hasCjk(t), false, line + "  →  " + t);
    }
    assert.equal(en.txs(countText({ n: 12, p: 10, f: 2, s: 0 })), "10 passed, 2 failed (12 in total)");
    assert.equal(en.txs("teamagent:test 测试".replace(":test 测试", " 测试")), "teamagent tests");
    assert.equal(en.txs("失败"), "Failed");
  });
  test("a sentence with no entry is shown as it came", () => {
    assert.equal(browser("en-US").txs("一句没有收录的话"), "一句没有收录的话");
  });
});

describe("tools tab", () => {
  test("every ability the board lists is in the dictionary", () => {
    const keys = new Set(Object.keys(BOARD_EN));
    for (const a of ABILITIES) {
      assert.ok(keys.has(a.title), a.title);
      assert.ok(keys.has(a.what), a.what);
    }
    assert.ok(Object.keys(ABILITY_EN).every(k => keys.has(k)));
  });
  test("the board sends the example without its note, and that is what the dictionary translates", () => {
    const examples = ABILITIES.flatMap(a => a.examples.map(e => e.replace(/\s*（[^（）]+）$/, "")));
    const missing = examples.filter(e => !BOARD_EN[e]);
    assert.deepEqual(missing, []);
  });
});

test("SERVER_EN and PAGE_EN do not overlap with different meanings", () => {
  const both = Object.keys(PAGE_EN).filter(k => k in SERVER_EN);
  assert.deepEqual(both, []);
});
