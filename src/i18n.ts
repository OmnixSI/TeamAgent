// Interface language for the pages the bot serves (board, toolbox, file drop, preview link).
// The source text in the page code is Chinese and doubles as the lookup key: tx("概览") returns "概览" in
// Chinese and the dictionary entry in English. Placeholders are {name}; an entry may be [one, other]
// and then picks on the parameter n. A missing entry shows the Chinese, never a blank.
// The reader chooses 跟随系统 (default), 中文 or English; the choice sits in localStorage under one key, so the
// pages of one site share it. With no choice made the first language the browser lists decides: Chinese
// gives Chinese, anything else English. Outside a browser (the offline tests) the language is Chinese.
//
// RUNTIME is ES5 text that goes into a page script (the page code must not contain backticks or "${").
// It defines `LANG`, `tx` and `txs` and expects the dictionary where "__I18N__" stands; use withDict() to fill it in.

export type Entry = string | [string, string];
export type Dict = Record<string, Entry>;

export const STORAGE_KEY = "ta.lang";

export const RUNTIME = String.raw`
var LANG = (function () {
  var KEY = "ta.lang", EN = "__I18N__", own = Object.prototype.hasOwnProperty, pref = "auto", tpl = null, subs = [];
  function stored() { try { var v = window.localStorage.getItem(KEY); return v === "zh" || v === "en" ? v : "auto"; } catch (e) { return "auto"; } }
  function system() {
    var n = typeof navigator === "undefined" ? null : navigator, l = n && ((n.languages && n.languages[0]) || n.language);
    return !l || /^zh/i.test(l) ? "zh" : "en";
  }
  function cur() { return pref === "auto" ? system() : pref; }
  function fill(s, p) { return p ? s.replace(/\{(\w+)\}/g, function (m, k) { return own.call(p, k) ? String(p[k]) : m; }) : s; }
  function pick(e, p) { return typeof e === "string" ? e : p && +p.n === 1 ? e[0] : e[1]; }
  function t(zh, p) { return fill(cur() === "en" && own.call(EN, zh) ? pick(EN[zh], p) : zh, p); }
  // A sentence that came from the server: the entry itself, or an entry with {slots} whose values the sentence carries
  // (a value that is itself a known word, such as a step's result, is translated too).
  function templates() {
    var k, list = [];
    for (k in EN) if (own.call(EN, k) && k.indexOf("{") >= 0) {
      var names = [], parts = k.split(/\{(\w+)\}/), src = "";
      parts.forEach(function (x, i) { if (i % 2) { names.push(x); src += "(.+?)"; } else src += x.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&"); });
      list.push({ key: k, names: names, re: new RegExp("^" + src + "$"), len: k.replace(/\{\w+\}/g, "").length });
    }
    // the entry with the most fixed text first, so "过期 {n} 天" is tried before "{n} 天"
    return list.sort(function (a, b) { return b.len - a.len; });
  }
  function tr(s) {
    if (cur() !== "en" || typeof s !== "string" || !s) return s;
    if (own.call(EN, s)) return pick(EN[s]);
    var i, m, p, j, list = tpl || (tpl = templates());
    for (i = 0; i < list.length; i++) {
      m = list[i].re.exec(s);
      if (m) { p = {}; for (j = 0; j < list[i].names.length; j++) p[list[i].names[j]] = tr(m[j + 1]); return t(list[i].key, p); }
    }
    return s;
  }
  // Text and attributes written into the page itself: data-i marks an element whose text is a key, data-ia lists attributes that are.
  function apply(root) {
    if (typeof document === "undefined") return;
    var en = cur() === "en";
    [].forEach.call((root || document).querySelectorAll("[data-i]"), function (el) {
      if (el.__zh === undefined) el.__zh = el.textContent;
      el.textContent = t(el.__zh);
    });
    [].forEach.call((root || document).querySelectorAll("[data-ia]"), function (el) {
      if (!el.__za) el.__za = {};
      el.getAttribute("data-ia").split(" ").forEach(function (a) {
        if (el.__za[a] === undefined) el.__za[a] = el.getAttribute(a) || "";
        el.setAttribute(a, t(el.__za[a]));
      });
    });
    document.documentElement.lang = en ? "en" : "zh-CN";
  }
  function changed() { apply(); subs.forEach(function (f) { f(); }); }
  function set(v) {
    pref = v === "zh" || v === "en" ? v : "auto";
    try { if (pref === "auto") window.localStorage.removeItem(KEY); else window.localStorage.setItem(KEY, pref); } catch (e) {}
    changed();
  }
  pref = stored();
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("storage", function (e) { if (e.key === KEY || e.key === null) { pref = stored(); changed(); } });
    window.addEventListener("languagechange", function () { if (pref === "auto") changed(); });
  }
  return {
    t: t, tr: tr, apply: apply, set: set,
    cur: cur, pref: function () { return pref; },
    on: function (f) { subs.push(f); },
    // [value, label] for a language picker; the two language names stay in their own language
    choices: function () { return [["auto", t("跟随系统")], ["zh", "中文"], ["en", "English"]]; }
  };
})();
var tx = LANG.t, txs = LANG.tr;   // tx: text written in the page code; txs: a sentence the server sent
`;

/** Puts the dictionary into script text that carries RUNTIME. A function replacer, since the text may hold "$&" and the like. */
export function withDict(js: string, dict: Dict): string {
  if (!js.includes('"__I18N__"')) throw new Error("no dictionary slot in the script");
  return js.replace('"__I18N__"', () => JSON.stringify(dict));
}

/** Keys that need a different entry shape than the source has, e.g. "{n} 条" must carry {n}. Used by the tests. */
export function slotsOf(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
}
