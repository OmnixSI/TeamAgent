// Runs the script of a small served page (runtime + LANG.apply()) against a made-up browser, for the tests of
// pages that are one sentence long. Not a test file itself.
import vm from "node:vm";

const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** The texts the page marks with data-i, as the page script leaves them for a browser that lists `languages` (and may hold a stored choice). */
export function runStaticPage(html, { languages = ["zh-CN"], stored } = {}) {
  const script = html.split("<script>")[1].split("</script>")[0];
  const els = [...html.matchAll(/<\w+[^>]*\sdata-i(?=[\s>=])[^>]*>([^<]*)</g)].map(m => ({ textContent: unesc(m[1]) }));
  const documentElement = {}, store = new Map(stored ? [["ta.lang", stored]] : []);
  const document = { documentElement, querySelectorAll: sel => (sel === "[data-i]" ? els : []) };
  const window = { localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }, addEventListener() {} };
  const ctx = { document, window, navigator: { languages }, Object, String, RegExp, Array };
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return { texts: els.map(e => e.textContent), lang: documentElement.lang, marked: [...html.matchAll(/<\w+[^>]*\sdata-i(?=[\s>=])[^>]*>([^<]*)</g)].map(m => unesc(m[1])) };
}
