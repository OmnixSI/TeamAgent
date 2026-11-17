// Changing the language while a tool is open (here, or from another tab of the site) must not cost the reader
// anything: what they typed, the options they picked and the result on screen stay, and only the words change.
// The real page scripts run against a made-up document (test/fake-dom.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { makeDocument, toolboxShell, byText, Node } from "./fake-dom.mjs";

const M = await import("../src/feat/toolbox.ts");
const { TOOLBOX_EN: EN } = await import("../src/feat/toolbox-i18n.ts");
const files = M.files();

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));

/** Opens the toolbox at `hash` for a reader whose browser lists `languages`. */
async function open(hash, languages = ["zh-CN"]) {
  const store = new Map(), listeners = {};
  const ctx = { TextEncoder, TextDecoder, crypto, btoa, atob, URL, setTimeout, clearTimeout, Node, navigator: { languages, language: languages[0] } };
  ctx.self = ctx;
  ctx.location = { hash };
  ctx.window = {
    addEventListener: (type, f) => { listeners[type] = f; },
    localStorage: { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) },
    scrollTo() {},
  };
  const run = src => { const name = new URL(src, "https://bot.test/x/toolbox/").pathname.split("/").pop(); vm.runInContext(files[name].body, ctx, { filename: name }); };
  const document = ctx.document = makeDocument({ run });
  const shell = toolboxShell(document);
  vm.createContext(ctx);
  vm.runInContext(files["app.js"].body, ctx, { filename: "app.js" });
  for (let i = 0; i < 4; i++) await tick();
  return {
    ...shell, document,
    /** The reader picks a language here. */
    choose: v => ctx.TB.LANG.set(v),
    /** The reader picks a language in another tab: the browser tells this one through the storage event. */
    otherTab: v => { if (v === "auto") store.delete("ta.lang"); else store.set("ta.lang", v); listeners.storage({ key: "ta.lang" }); },
    go: async h => { ctx.location.hash = h; listeners.hashchange(); for (let i = 0; i < 4; i++) await tick(); },
  };
}

test("JSON tool: text, options and result stay when another tab switches to English, and come back in Chinese", async () => {
  const t = await open("#json");
  const vb = t.vb;
  const ta = vb.querySelector("textarea"), indent = vb.querySelector("select"), [sort] = vb.querySelectorAll("input");
  ta.value = '{"b":1,"a":[1,2]}';
  indent.value = "4"; sort.checked = true;
  byText(vb, "格式化", "button").click();
  const pre = vb.querySelector("pre"), status = vb.querySelector("p.status");
  const result = pre.textContent;
  assert.match(result, /^\{\n {4}"a": \[/, "sorted and indented by 4");
  assert.equal(status.textContent, "格式正确。");
  pre.textContent = "复制";   // a result that happens to read like a button label is still the reader's data, not a label

  t.otherTab("en");

  assert.equal(vb.querySelector("textarea"), ta, "the same text box, not a new one");
  assert.equal(vb.querySelector("pre"), pre);
  assert.equal(ta.value, '{"b":1,"a":[1,2]}');
  assert.equal(indent.value, "4");
  assert.equal(sort.checked, true);
  assert.equal(pre.textContent, "复制", "results are never reworded");
  assert.equal(status.textContent, EN["格式正确。"]);
  assert.ok(byText(vb, EN["格式化"], "button"), "buttons are in English");
  assert.equal(ta.getAttribute("aria-label"), EN["JSON 内容"]);
  assert.equal(ta.getAttribute("placeholder"), EN['{"粘贴":"到这里"}']);
  assert.equal(t.vt.textContent, EN["JSON"] || t.vt.textContent);
  assert.match(t.document.title, /Toolbox$/);

  t.choose("zh");
  assert.equal(vb.querySelector("textarea"), ta);
  assert.equal(ta.value, '{"b":1,"a":[1,2]}');
  assert.ok(byText(vb, "格式化", "button"));
  assert.equal(status.textContent, "格式正确。");
  assert.equal(ta.getAttribute("aria-label"), "JSON 内容");
});

test("an error message made of several sentences is said again whole", async () => {
  const t = await open("#json");
  const vb = t.vb;
  vb.querySelector("textarea").value = '{"a":1,}';
  byText(vb, "格式化", "button").click();
  const status = vb.querySelector("p.status");
  const zh = status.textContent;
  assert.match(zh, /^第 \d+ 行第 \d+ 列附近有错。最后一项后面多了逗号。$/);

  t.choose("en");
  assert.match(status.textContent, /^Error near line \d+, column \d+\. There is a trailing comma after the last item\.$/);
  t.choose("zh");
  assert.equal(status.textContent, zh);
});

test("a tool that shows figures about the text redraws them in the new language and keeps the text", async () => {
  const t = await open("#count");
  const vb = t.vb;
  const ta = vb.querySelector("textarea");
  ta.value = "你好 world";
  ta.fire("input");
  await tick(150);
  assert.ok(byText(vb, "汉字", "span"));
  const grid = vb.querySelector(".stats");

  t.choose("en");

  assert.equal(vb.querySelector("textarea"), ta);
  assert.equal(ta.value, "你好 world");
  assert.ok(byText(vb, EN["汉字"], "span"), "the figures' labels follow the language");
  assert.equal(byText(vb, "汉字", "span"), null);
  assert.equal(vb.querySelector(".stats"), grid, "drawn into the same box");
});

test("opening another tool, or the list, still builds from scratch", async () => {
  const t = await open("#json");
  const first = t.vb.querySelector("textarea");
  first.value = "abc";
  await t.go("#count");
  const second = t.vb.querySelector("textarea");
  assert.notEqual(second, first);
  assert.equal(second.value, "");
  await t.go("#json");
  assert.notEqual(t.vb.querySelector("textarea"), first, "coming back is a fresh tool");
  assert.equal(t.vb.querySelector("textarea").value, "");
  await t.go("#");
  assert.equal(t.view.hidden, true);
  assert.equal(t.vb.childNodes.length, 0);
});

test("an English reader gets English from the start, and switching to Chinese changes the words at once", async () => {
  const t = await open("#", ["en-US"]);
  await t.go("#json");
  assert.ok(byText(t.vb, EN["格式化"], "button"), "an English reader gets English from the start");
  t.choose("zh");
  assert.ok(byText(t.vb, "格式化", "button"));
  assert.equal(t.vb.querySelectorAll("textarea").length, 1);
});
