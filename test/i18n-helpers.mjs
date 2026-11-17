// Shared by the page tests: finds the string literals in a page script and checks a dictionary against them.
// Not a test file itself (the runner only picks up *.test.mjs).
import assert from "node:assert/strict";

const CJK = /[　-〿㐀-鿿＀-￯]/;
export const hasCjk = s => CJK.test(s);

/** String literals of a JS text, unescaped. Skips comments and regular expressions the way the page squeezer reads them. */
export function stringLiterals(js) {
  const out = [];
  let i = 0, prev = "";   // prev: the last significant character, to tell a regular expression from a division
  while (i < js.length) {
    const c = js[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < js.length && js[j] !== c) j += js[j] === "\\" ? 2 : 1;
      const raw = js.slice(i + 1, j);
      let text = raw;
      try { text = new Function("return " + c + raw + c)(); } catch {}
      out.push(text);
      i = j + 1; prev = c; continue;
    }
    if (c === "/" && js[i + 1] === "/") { while (i < js.length && js[i] !== "\n") i++; continue; }
    if (c === "/" && js[i + 1] === "*") { const j = js.indexOf("*/", i + 2); i = j < 0 ? js.length : j + 2; continue; }
    if (c === "/" && (prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev) || /(?:return|typeof)$/.test(js.slice(Math.max(0, i - 8), i).trimEnd()))) {
      let j = i + 1, cls = false;
      while (j < js.length && (js[j] !== "/" || cls)) { if (js[j] === "\\") j++; else if (js[j] === "[") cls = true; else if (js[j] === "]") cls = false; j++; }
      i = j + 1; prev = "/"; continue;
    }
    if (!/\s/.test(c)) prev = c;
    i++;
  }
  return out;
}

/** Literals with Chinese in them that the dictionary does not know, minus those the page may keep as they are. */
export function untranslated(js, dict, keep = []) {
  const known = new Set([...Object.keys(dict), ...keep]);
  return [...new Set(stringLiterals(js).filter(s => hasCjk(s) && !known.has(s)))];
}

/** Entries must carry the same {slots} as their key, and a pair is [one, other] for a count n. */
export function dictProblems(dict) {
  const slots = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(",");
  const bad = [];
  for (const [k, v] of Object.entries(dict)) {
    const forms = typeof v === "string" ? [v] : v;
    if (!Array.isArray(forms) || forms.length > 2 || !forms.every(f => typeof f === "string" && f.trim())) { bad.push(`${k}: not a string or [one, other]`); continue; }
    if (Array.isArray(v) && !slots(k).split(",").includes("n")) bad.push(`${k}: a pair needs {n} in the key`);
    for (const f of forms) if (slots(f) !== slots(k)) bad.push(`${k}: slots differ in "${f}"`);
    if (forms.some(f => hasCjk(f))) bad.push(`${k}: Chinese left in the English entry`);
  }
  return bad;
}

/** Keys the page never mentions are dead weight; `server` lists keys that only the server's own sentences use. */
export function unusedKeys(js, dict, server = []) {
  const seen = new Set(stringLiterals(js));
  const skip = new Set(server);
  return Object.keys(dict).filter(k => !seen.has(k) && !skip.has(k));
}

export function assertCovered(js, dict, { keep = [], server = [] } = {}) {
  assert.deepEqual(dictProblems(dict), [], "dictionary entries");
  assert.deepEqual(untranslated(js, dict, keep), [], "Chinese strings in the page code with no English entry");
  assert.deepEqual(unusedKeys(js, dict, server), [], "dictionary keys that no string in the page matches");
}
