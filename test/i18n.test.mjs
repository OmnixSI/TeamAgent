import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { RUNTIME, withDict } from "../src/i18n.ts";
import { stringLiterals, dictProblems } from "./i18n-helpers.mjs";

const DICT = {
  "概览": "Overview",
  "共 {n} 项": ["{n} item", "{n} items"],
  "{who} 在做 {what}": "{who} is working on {what}",
  "跟随系统": "Follow system",
};

const plain = v => JSON.parse(JSON.stringify(v));   // arrays made inside the vm are not this realm's arrays

/** Runs the runtime the way a page would, with a made-up browser around it. */
function browser({ languages, stored, nav = true } = {}) {
  const store = new Map(stored ? [["ta.lang", stored]] : []);
  const listeners = {};
  const els = [];
  const el = (attrs, text) => ({
    _a: { ...attrs }, textContent: text,
    getAttribute(k) { return k in this._a ? this._a[k] : null; },
    setAttribute(k, v) { this._a[k] = v; },
  });
  const document = {
    documentElement: {},
    querySelectorAll: sel => els.filter(e => (sel === "[data-i]" ? "data-i" in e._a : "data-ia" in e._a)),
  };
  const window = {
    localStorage: { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    addEventListener: (type, f) => { listeners[type] = f; },
  };
  const ctx = { window, document, Object, String, RegExp, Array };
  if (nav) ctx.navigator = { languages, language: languages && languages[0] };
  vm.createContext(ctx);
  vm.runInContext(withDict(RUNTIME, DICT) + "\nthis.LANG = LANG; this.tx = tx; this.txs = txs;", ctx);
  return { ...ctx, store, listeners, els, el, document };
}

test("the language follows the system until the reader chooses", () => {
  const cases = [[["zh-CN"], "zh"], [["zh-Hant-TW", "en"], "zh"], [["en-AU", "zh-CN"], "en"], [["ja"], "en"], [["fr-FR"], "en"]];
  for (const [languages, want] of cases) assert.equal(browser({ languages }).LANG.cur(), want, languages.join());
  assert.equal(browser({ nav: false }).LANG.cur(), "zh", "outside a browser the pages stay Chinese");
  assert.equal(browser({ languages: ["en-US"], stored: "zh" }).LANG.cur(), "zh", "a stored choice beats the system");
  assert.equal(browser({ languages: ["zh-CN"], stored: "en" }).LANG.cur(), "en");
  assert.equal(browser({ languages: ["en-US"], stored: "junk" }).LANG.pref(), "auto", "an unknown stored value means follow the system");
});

test("tx: Chinese stays as written, English comes from the dictionary, slots and plurals fill in", () => {
  const zh = browser({ languages: ["zh-CN"] });
  assert.equal(zh.tx("概览"), "概览");
  assert.equal(zh.tx("共 {n} 项", { n: 3 }), "共 3 项");
  const en = browser({ languages: ["en-US"] });
  assert.equal(en.tx("概览"), "Overview");
  assert.equal(en.tx("共 {n} 项", { n: 1 }), "1 item");
  assert.equal(en.tx("共 {n} 项", { n: 0 }), "0 items");
  assert.equal(en.tx("共 {n} 项", { n: 12 }), "12 items");
  assert.equal(en.tx("{who} 在做 {what}", { who: "A", what: "B" }), "A is working on B");
  assert.equal(en.tx("没有这一条"), "没有这一条", "a missing entry shows the Chinese, not a blank");
  assert.equal(en.tx("constructor"), "constructor", "inherited object keys are not entries");
  assert.equal(en.tx("{who} 在做 {what}", { who: "A" }), "A is working on {what}", "a slot with no value stays visible");
});

test("txs: sentences from the server match an entry or a template with slots", () => {
  const en = browser({ languages: ["en-US"] });
  assert.equal(en.txs("概览"), "Overview");
  assert.equal(en.txs("共 5 项"), "5 items");
  assert.equal(en.txs("共 1 项"), "1 item");
  assert.equal(en.txs("小明 在做 周报 (1)"), "小明 is working on 周报 (1)");
  assert.equal(en.txs("服务器自己的话"), "服务器自己的话");
  assert.equal(en.txs(""), "");
  assert.equal(en.txs(undefined), undefined);
  assert.equal(browser({ languages: ["zh-CN"] }).txs("共 5 项"), "共 5 项");
});

test("txs: the entry with the most fixed text wins, and slot values that are known words are translated too", () => {
  const dict = { "{n} 天": "{n} d", "过期 {n} 天": "{n} d overdue", "上次（{when}）{a}": "Last ({when}): {a}", "通过": "Passed", "{x} 检查": "{x} check" };
  const en = (() => { const c = { navigator: { languages: ["en-US"] }, window: { localStorage: { getItem: () => null }, addEventListener() {} }, Object, String, RegExp, Array }; vm.createContext(c); vm.runInContext(withDict(RUNTIME, dict) + "\nthis.txs = txs;", c); return c; })();
  assert.equal(en.txs("过期 3 天"), "3 d overdue");
  assert.equal(en.txs("3 天"), "3 d");
  assert.equal(en.txs("上次（01-01）通过"), "Last (01-01): Passed");
  assert.equal(en.txs("teamagent 检查"), "teamagent check");
});

test("set: remembered, and switches at once; follow-system clears the choice", () => {
  const b = browser({ languages: ["en-US"] });
  let n = 0;
  b.LANG.on(() => n++);
  assert.equal(b.tx("概览"), "Overview");
  b.LANG.set("zh");
  assert.equal(b.tx("概览"), "概览");
  assert.equal(b.store.get("ta.lang"), "zh");
  assert.equal(b.document.documentElement.lang, "zh-CN");
  b.LANG.set("en");
  assert.equal(b.store.get("ta.lang"), "en");
  assert.equal(b.document.documentElement.lang, "en");
  b.LANG.set("auto");
  assert.equal(b.store.has("ta.lang"), false);
  assert.equal(b.LANG.cur(), "en", "back to the system language");
  assert.equal(n, 3, "listeners hear every change");
  b.LANG.set("nonsense");
  assert.equal(b.LANG.pref(), "auto");
});

test("another tab's choice arrives through the storage event", () => {
  const b = browser({ languages: ["en-US"] });
  let n = 0;
  b.LANG.on(() => n++);
  b.store.set("ta.lang", "zh");
  b.listeners.storage({ key: "ta.lang" });
  assert.equal(b.LANG.cur(), "zh");
  assert.equal(n, 1);
  b.listeners.storage({ key: "something.else" });
  assert.equal(n, 1);
});

test("apply: marked text and attributes are translated from their first (Chinese) value, both ways", () => {
  const b = browser({ languages: ["en-US"] });
  const a = b.el({ "data-i": "" }, "概览");
  const c = b.el({ "data-ia": "aria-label title", "aria-label": "概览", title: "跟随系统" }, "");
  const d = b.el({}, "概览");
  b.els.push(a, c, d);
  b.LANG.apply();
  assert.equal(a.textContent, "Overview");
  assert.equal(c.getAttribute("aria-label"), "Overview");
  assert.equal(c.getAttribute("title"), "Follow system");
  assert.equal(d.textContent, "概览", "unmarked elements are left alone");
  b.LANG.set("zh");
  assert.equal(a.textContent, "概览");
  assert.equal(c.getAttribute("title"), "跟随系统");
  b.LANG.set("en");
  assert.equal(a.textContent, "Overview");
});

test("the picker lists follow-system, then the two languages by their own names", () => {
  assert.deepEqual(plain(browser({ languages: ["en-US"] }).LANG.choices()), [["auto", "Follow system"], ["zh", "中文"], ["en", "English"]]);
  assert.deepEqual(plain(browser({ languages: ["zh-CN"] }).LANG.choices()), [["auto", "跟随系统"], ["zh", "中文"], ["en", "English"]]);
});

test("withDict: fills the slot once and refuses a script without one", () => {
  const js = withDict('var EN = "__I18N__";', { "$&": "a$'b" });
  assert.equal(js, 'var EN = {"$&":"a$\'b"};');
  assert.throws(() => withDict("var x;", {}), /no dictionary slot/);
});

test("test helpers: literals, regular expressions and comments are told apart", () => {
  const js = 'var a = "你好", b = \'it\\\'s\'; var r = /["\']中/; // 注释 "x"\n/* 块 */ x = y / 2; z = "好" + "\\u4e2d";';
  assert.deepEqual(stringLiterals(js), ["你好", "it's", "好", "中"]);
  assert.deepEqual(dictProblems({ "{n} 条": ["{n} row", "{n} rows"], "好": "ok" }), []);
  assert.equal(dictProblems({ "好": ["a", "b"] }).length, 1);
  assert.equal(dictProblems({ "{n} 条": "rows" }).length, 1);
  assert.equal(dictProblems({ "好": "好" }).length, 1);
});
