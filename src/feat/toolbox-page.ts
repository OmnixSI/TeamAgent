// Browser-side source of the toolbox page (src/feat/toolbox.ts serves it). Everything here runs in the
// visitor's browser; nothing calls the bot. Each part is plain JavaScript kept in a String.raw literal, so
// the browser code must not contain backticks or "${". Pure logic hangs off TB.lib so the offline tests
// can evaluate the same text under Node without a DOM.

export const CSS = String.raw`
:root{--bg:#fbfbf9;--fg:#1d1d1b;--mute:#6b6b66;--line:#dcdcd6;--soft:#f0f0eb;--acc:#2d6a5a;--acc-fg:#fff;--bad:#a33a2a;--ok:#2d6a5a;--add:#e3f1e8;--del:#f8e3df;--addx:#bfe3cb;--delx:#f0c0b6;--mark:#f3e3a6;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#171716;--fg:#e6e6e1;--mute:#9a9a93;--line:#34342f;--soft:#21211f;--acc:#7cc2ab;--acc-fg:#10201b;--bad:#f08f7c;--ok:#7cc2ab;--add:#1f3329;--del:#3a2420;--addx:#2c5340;--delx:#5f3229;--mark:#5c4f1e}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--sans)}
a{color:var(--acc)}
.wrap{max-width:46rem;margin:0 auto;padding:0 16px 64px}
header.top{max-width:46rem;margin:0 auto;padding:20px 16px 4px;display:flex;align-items:baseline;gap:12px}
header.top a{color:var(--fg);text-decoration:none;font-weight:600;font-size:18px}
header.top span{color:var(--mute);font-size:14px}
h2{font-size:15px;font-weight:600;margin:36px 0 8px;color:var(--mute);letter-spacing:.02em}
#view h2{font-size:22px;color:var(--fg);margin:8px 0 16px;letter-spacing:0}
h2:focus{outline:none}
h3{font-size:16px;margin:0}
p{margin:0 0 12px}
.lede{color:var(--mute);margin:12px 0 0}
ul.tools{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:1fr;border-top:1px solid var(--line)}
@media (min-width:640px){ul.tools{grid-template-columns:1fr 1fr;column-gap:24px}}
ul.tools li{border-bottom:1px solid var(--line)}
ul.tools a{display:block;padding:10px 0;text-decoration:none;color:var(--fg)}
ul.tools a b{font-weight:500}
ul.tools a span{display:block;color:var(--mute);font-size:14px}
ul.tools a:hover b{color:var(--acc)}
.ab{padding:14px 0;border-bottom:1px solid var(--line)}
.ab:first-of-type{border-top:1px solid var(--line)}
.ab p{color:var(--mute);font-size:15px;margin:2px 0 6px}
.ex{list-style:none;margin:0;padding:0}
.ex li{display:flex;gap:10px;align-items:center;padding:3px 0}
.ex q{flex:1;quotes:none;font-size:15px;min-width:0;overflow-wrap:anywhere}
.ex q small{color:var(--mute);font-size:13px;margin-left:4px}
.foot{margin-top:40px;color:var(--mute);font-size:13px}
.back{display:inline-block;margin-top:8px;font-size:15px}
button,.btn{font:inherit;font-size:15px;line-height:1.3;white-space:nowrap;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;min-height:38px}
button:hover{border-color:var(--mute)}
button.pri{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
button.sm{padding:4px 10px;font-size:13px;min-height:30px}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
input,select,textarea{font:inherit;font-size:16px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;max-width:100%}
input[type=checkbox],input[type=radio]{accent-color:var(--acc);width:18px;height:18px;margin:0;vertical-align:-3px}
input[type=range]{accent-color:var(--acc);padding:0;border:0;width:12rem}
input[type=color]{padding:2px;width:44px;height:38px;vertical-align:middle}
textarea{width:100%;min-height:9rem;font-family:var(--mono);font-size:14px;line-height:1.5;resize:vertical}
textarea.prose{font-family:var(--sans);font-size:16px}
.row{display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin:12px 0}
.field{display:flex;flex-direction:column;gap:4px;margin:0}
.field>span{font-size:14px;color:var(--mute)}
.field small,.hint{color:var(--mute);font-size:13px}
.check{display:inline-flex;gap:6px;align-items:center;font-size:15px}
.drop{border:1px dashed var(--line);border-radius:8px;padding:16px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;color:var(--mute);font-size:14px}
.drop.over{border-color:var(--acc);background:var(--soft)}
.vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.status{min-height:1.6em;color:var(--mute);font-size:14px;margin:8px 0}
.status.err,.err{color:var(--bad)}
.muted{color:var(--mute)}
.mono{font-family:var(--mono);font-size:14px}
pre.out{font-family:var(--mono);font-size:14px;background:var(--soft);border-radius:6px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;max-height:32rem;overflow:auto}
table.kv{border-collapse:collapse;width:100%;font-size:15px;margin:8px 0}
table.kv th,table.kv td{text-align:left;padding:6px 8px 6px 0;border-bottom:1px solid var(--line);vertical-align:top}
table.kv th{font-weight:500;color:var(--mute);white-space:nowrap;width:1%}
table.kv td.mono{overflow-wrap:anywhere}
table.kv tr.now td,table.kv tr.now th{background:var(--soft)}
.list{list-style:none;margin:8px 0;padding:0;border-top:1px solid var(--line)}
.list:empty{display:none}
.list li{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)}
.list .nm{flex:1 1 12rem;min-width:0;overflow-wrap:anywhere}
.list .nm small{display:block;color:var(--mute)}
.list img{width:56px;height:56px;object-fit:cover;border-radius:4px;background:var(--soft)}
.grid{display:grid;grid-template-columns:1fr;gap:12px}
@media (min-width:640px){.grid.two{grid-template-columns:1fr 1fr}}
.diff{font-family:var(--mono);font-size:13px;line-height:1.5;border:1px solid var(--line);border-radius:6px;overflow:auto;max-height:36rem}
.diff div{white-space:pre-wrap;overflow-wrap:anywhere;padding:0 8px 0 2.4em;text-indent:-1.6em}
.diff .a{background:var(--add)}.diff .d{background:var(--del)}
.diff .a ins{background:var(--addx);text-decoration:none}.diff .d del{background:var(--delx);text-decoration:none}
.diff .gap{color:var(--mute);background:var(--soft);text-indent:0;padding-left:8px}
mark{background:var(--mark);color:inherit;border-radius:2px}
.hl{font-family:var(--mono);font-size:14px;white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--line);border-radius:6px;padding:10px 12px;max-height:24rem;overflow:auto}
.swatch{border:1px solid var(--line);border-radius:8px;padding:18px;font-size:18px;margin:10px 0}
.swatch small{display:block;font-size:13px}
.qr{display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;margin:12px 0}
.qr canvas{width:min(100%,280px);height:auto;image-rendering:pixelated;border:1px solid var(--line);background:#fff}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr));gap:8px;margin:12px 0}
.stats div{background:var(--soft);border-radius:6px;padding:8px 10px}
.stats b{display:block;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.stats span{color:var(--mute);font-size:13px}
.pass{color:var(--ok)}.fail{color:var(--bad)}
`;

export const APP_JS = String.raw`(function () {
"use strict";
const TB = self.TB = self.TB || { lib: {}, tools: {} };
const CONF = /*CONF*/{ parts: {}, index: {}, rx: "", pdflib: {} }/*END*/;
TB.conf = CONF;
const L = TB.lib;

// ---------- store-only zip ----------
let CRC = null;
function crc32(u8, crc) {
  if (!CRC) { CRC = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c >>> 0; } }
  crc = crc === undefined ? 0xFFFFFFFF : (crc ^ 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < u8.length; i++) crc = CRC[(crc ^ u8[i]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function uniqueNames(names) {
  const seen = {};
  return names.map(n => {
    n = String(n || "file").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 200) || "file";
    const m = /^(.*?)(\.[^.]*)?$/.exec(n), base = m[1], ext = m[2] || "";
    let k = n, i = 2;
    while (seen[k.toLowerCase()]) k = base + " (" + i++ + ")" + ext;
    seen[k.toLowerCase()] = 1;
    return k;
  });
}
// files: [{ name, data: Uint8Array, date?: Date }] -> the zip as a list of byte chunks (wrap in a Blob).
function zipStore(files) {
  if (files.length > 65535) throw new Error("文件太多，一个压缩包最多放 65535 个");
  const names = uniqueNames(files.map(f => f.name)), enc = new TextEncoder(), out = [], central = [];
  let offset = 0;
  files.forEach((f, i) => {
    const name = enc.encode(names[i]), data = f.data, d = f.date || new Date();
    if (offset + 30 + name.length + data.length > 0xFFFFFFFF) throw new Error("压缩包超过 4 GB 了，分几次打包");
    const crc = crc32(data), y = d.getFullYear();
    const time = y < 1980 ? 0 : (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = y < 1980 ? 33 : ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const h = new Uint8Array(30 + name.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, time, true); v.setUint16(12, date, true); v.setUint32(14, crc, true);
    v.setUint32(18, data.length, true); v.setUint32(22, data.length, true); v.setUint16(26, name.length, true);
    h.set(name, 30);
    const c = new Uint8Array(46 + name.length), w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true);
    w.setUint16(12, time, true); w.setUint16(14, date, true); w.setUint32(16, crc, true);
    w.setUint32(20, data.length, true); w.setUint32(24, data.length, true); w.setUint16(28, name.length, true);
    w.setUint32(42, offset, true);
    c.set(name, 46);
    out.push(h, data); central.push(c);
    offset += h.length + data.length;
  });
  const size = central.reduce((a, c) => a + c.length, 0), e = new Uint8Array(22), x = new DataView(e.buffer);
  x.setUint32(0, 0x06054b50, true); x.setUint16(8, files.length, true); x.setUint16(10, files.length, true);
  x.setUint32(12, size, true); x.setUint32(16, offset, true);
  return out.concat(central, [e]);
}
L.zip = { crc32, store: zipStore, uniqueNames };
L.size = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(n < 10240 ? 1 : 0) + " KB" : (n / 1048576).toFixed(n < 10485760 ? 2 : 1) + " MB";
L.base = name => String(name || "file").replace(/\.[^.]*$/, "") || "file";

if (typeof document === "undefined") return;

// ---------- small DOM helpers shared by every part ----------
const $ = s => document.querySelector(s);
function h(tag, props) {
  const el = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else if (k === "value" || k === "checked" || k === "disabled" || k === "selected") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (let i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, kid) {
  if (kid == null || kid === false) return;
  if (Array.isArray(kid)) kid.forEach(k => add(el, k));
  else el.append(kid instanceof Node ? kid : String(kid));
}
let uid = 0;
TB.id = p => (p || "f") + ++uid;
TB.h = h;
TB.save = (blob, name) => {
  const a = h("a", { href: URL.createObjectURL(blob), download: name, class: "vh" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 120000);
};
TB.copy = async (text, btn) => {
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {
    const t = h("textarea", { class: "vh", readonly: true }); t.value = text; document.body.append(t); t.select();
    try { ok = document.execCommand("copy"); } catch (e2) {}
    t.remove();
  }
  if (btn) { const was = btn.dataset.label || btn.textContent; btn.dataset.label = was; btn.textContent = ok ? "已复制" : "没复制上"; setTimeout(() => { btn.textContent = was; }, 1500); }
  return ok;
};
TB.copyBtn = (get, label) => h("button", { type: "button", class: "sm", onclick: e => TB.copy(typeof get === "function" ? get() : get, e.currentTarget) }, label || "复制");
TB.status = () => h("p", { class: "status", role: "status", "aria-live": "polite" });
TB.say = (el, text, bad) => { el.textContent = text || ""; el.classList.toggle("err", !!bad); };
TB.field = (label, control, hint) => h("label", { class: "field" }, h("span", null, label), control, hint ? h("small", null, hint) : null);
TB.check = (label, checked) => { const i = h("input", { type: "checkbox", checked: !!checked }); return [h("label", { class: "check" }, i, label), i]; };
TB.select = (opts, value) => h("select", null, opts.map(o => h("option", { value: o[0], selected: String(o[0]) === String(value) }, o[1])));
TB.area = (props) => h("textarea", Object.assign({ spellcheck: "false", autocapitalize: "off", autocomplete: "off" }, props || {}));
TB.zipBlob = files => new Blob(L.zip.store(files), { type: "application/zip" });
TB.debounce = (fn, ms) => { let t; return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(null, a), ms); }; };
// A file chooser that is a real button, accepts drops, and reports files through onfiles.
TB.picker = (opts) => {
  const input = h("input", { type: "file", class: "vh", accept: opts.accept || null, multiple: !!opts.multiple, tabindex: "-1", "aria-hidden": "true" });
  const btn = h("button", { type: "button", class: "pri", onclick: () => input.click() }, opts.label || "选择文件");
  const box = h("div", { class: "drop" }, btn, h("span", null, opts.hint || "也可以把文件拖到这里"), input);
  const give = list => { const files = [].slice.call(list || []); if (files.length) opts.onfiles(opts.multiple ? files : files.slice(0, 1)); };
  input.addEventListener("change", () => { give(input.files); input.value = ""; });
  box.addEventListener("dragover", e => { e.preventDefault(); box.classList.add("over"); });
  box.addEventListener("dragleave", () => box.classList.remove("over"));
  box.addEventListener("drop", e => { e.preventDefault(); box.classList.remove("over"); give(e.dataTransfer && e.dataTransfer.files); });
  return box;
};
// An ordered file list with move up / move down / remove buttons; returns { el, items, set(list) }.
TB.order = (describe, onchange) => {
  const ul = h("ul", { class: "list" }), self = { el: ul, items: [] };
  const draw = (focus) => {
    ul.replaceChildren();
    self.items.forEach((it, i) => {
      const label = describe(it, i);
      const name = typeof label === "string" ? label : label.name;
      ul.append(h("li", null,
        h("span", { class: "nm" }, (i + 1) + ". ", label.node || name),
        h("button", { type: "button", class: "sm", disabled: i === 0, "aria-label": "上移 " + name, "data-k": "u" + i, onclick: () => move(i, -1, "u") }, "上移"),
        h("button", { type: "button", class: "sm", disabled: i === self.items.length - 1, "aria-label": "下移 " + name, "data-k": "d" + i, onclick: () => move(i, 1, "d") }, "下移"),
        h("button", { type: "button", class: "sm", "aria-label": "移除 " + name, "data-k": "x" + i, onclick: () => { self.items.splice(i, 1); draw("x" + Math.min(i, self.items.length - 1)); } }, "移除")));
    });
    if (focus) {
      let b = ul.querySelector('[data-k="' + focus + '"]');
      if (b && b.disabled) b = ul.querySelector('[data-k="' + (focus[0] === "u" ? "d" : "u") + focus.slice(1) + '"]');
      if (b) b.focus(); else if (ul.previousElementSibling) { const p = ul.previousElementSibling.querySelector("button"); if (p) p.focus(); }
    }
    if (onchange) onchange(self.items);
  };
  const move = (i, d, k) => { const j = i + d; const t = self.items[i]; self.items[i] = self.items[j]; self.items[j] = t; draw(k + j); };
  self.set = list => { self.items = list; draw(); };
  self.redraw = draw;
  return self;
};

// ---------- loading parts on demand ----------
const loading = {};
TB.load = part => loading[part] || (loading[part] = new Promise((ok, bad) => {
  const s = h("script", { src: CONF.parts[part] });
  s.onload = ok;
  s.onerror = () => { delete loading[part]; bad(new Error("这部分没加载下来，检查网络后刷新")); };
  document.head.append(s);
}));

// ---------- routing: #tool-id opens a tool, anything else shows the list ----------
let seq = 0, lastLink = null;
function route() {
  const id = decodeURIComponent(location.hash.slice(1));
  const meta = CONF.index[id], home = $("#home"), view = $("#view");
  if (!meta) {
    const wasView = !view.hidden;
    view.hidden = true; home.hidden = false; $("#vb").replaceChildren();
    document.title = "工具箱";
    const target = id && document.getElementById(id);
    if (target) target.scrollIntoView();
    else if (wasView && lastLink) { const a = document.querySelector('a[href="#' + lastLink + '"]'); if (a) { a.focus(); a.scrollIntoView({ block: "center" }); } }
    return;
  }
  lastLink = id;
  home.hidden = true; view.hidden = false;
  const title = $("#vt"), body = $("#vb"), token = ++seq;
  title.textContent = meta[0]; document.title = meta[0] + " · 工具箱";
  body.replaceChildren(h("p", { class: "muted" }, "载入中…"));
  window.scrollTo(0, 0);
  Promise.all([].concat(meta[1]).map(TB.load)).then(() => {
    if (token !== seq) return;
    body.replaceChildren();
    TB.tools[id](body);
    title.focus();
  }, e => { if (token === seq) body.replaceChildren(h("p", { class: "err" }, e.message)); });
}
window.addEventListener("hashchange", route);
document.addEventListener("click", e => {
  const b = e.target.closest && e.target.closest("button[data-copy]");
  if (b) TB.copy(b.getAttribute("data-copy"), b);
});
route();
})();
`;

export const TEXT_JS = String.raw`(function () {
"use strict";
const TB = self.TB, L = TB.lib;

// ---------- JSON ----------
// Validates with JSON.parse but re-prints the original tokens, so long numbers (ids) keep every digit.
function jsonTokens(s, ind) {
  let out = "", depth = 0, i = 0;
  const n = s.length, nl = d => ind ? "\n" + ind.repeat(d) : "";
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 34) { let j = i + 1; while (s.charCodeAt(j) !== 34) j += s.charCodeAt(j) === 92 ? 2 : 1; out += s.slice(i, j + 1); i = j + 1; continue; }
    if (c === 32 || c === 9 || c === 10 || c === 13) { i++; continue; }
    if (c === 123 || c === 91) {
      let j = i + 1; while (j < n && " \t\n\r".indexOf(s[j]) >= 0) j++;
      if (s.charCodeAt(j) === c + 2) { out += s[i] + s[j]; i = j + 1; continue; }
      depth++; out += s[i] + nl(depth); i++; continue;
    }
    if (c === 125 || c === 93) { depth--; out += nl(depth) + s[i]; i++; continue; }
    if (c === 44) { out += "," + nl(depth); i++; continue; }
    if (c === 58) { out += ind ? ": " : ":"; i++; continue; }
    let j = i; while (j < n && ",:]} \t\n\r".indexOf(s[j]) < 0) j++;
    out += s.slice(i, j); i = j;
  }
  return out;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach(k => { o[k] = sortKeys(v[k]); }); return o; }
  return v;
}
function jsonFormat(src, indent, sort) {
  const s = String(src).replace(/^﻿/, "");
  if (!s.trim()) return { ok: false, error: "没有内容" };
  const ind = indent === "t" ? "\t" : " ".repeat(Number(indent) || 0);
  let v;
  try { v = JSON.parse(s); } catch (e) {
    const msg = String(e && e.message || e);
    let line = 0, col = 0, m = /line (\d+) column (\d+)/.exec(msg);
    if (m) { line = +m[1]; col = +m[2]; }
    else if ((m = /position (\d+)/.exec(msg))) { const before = s.slice(0, +m[1]); line = before.split("\n").length; col = +m[1] - before.lastIndexOf("\n"); }
    let hint = "";
    if (/^\s*[{\[][\s\S]*'/.test(s) && !/"/.test(s)) hint = "JSON 里的字符串要用双引号。";
    else if (/,\s*[}\]]/.test(s)) hint = "最后一项后面多了逗号。";
    else if (/\/\/|\/\*/.test(s)) hint = "JSON 不允许写注释。";
    return { ok: false, error: (line ? "第 " + line + " 行第 " + col + " 列附近有错。" : "格式不对。") + hint, detail: msg, line, col };
  }
  const big = /(^|[^\w."])-?\d{16,}/.test(s.replace(/"(?:[^"\\]|\\.)*"/g, '""'));
  if (sort) return { ok: true, out: JSON.stringify(sortKeys(v), null, ind), lossy: big };
  return { ok: true, out: jsonTokens(s, ind) };
}
L.json = { format: jsonFormat, tokens: jsonTokens };

// ---------- Base64 / URL ----------
function b64encode(bytes, urlSafe) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  let s = btoa(bin);
  if (urlSafe) s = s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return s;
}
function b64decode(s) {
  s = String(s).replace(/^data:[^,]*,/, "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  if (/[^A-Za-z0-9+/]/.test(s)) throw new Error("里面有不属于 Base64 的字符");
  if (s.length % 4 === 1) throw new Error("长度不对，可能少复制了一截");
  const bin = atob(s + "=".repeat((4 - s.length % 4) % 4)), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function sniff(b) {
  const hex = Array.from(b.subarray(0, 12), x => x.toString(16).padStart(2, "0")).join("");
  if (hex.startsWith("89504e47")) return ["image/png", "png"];
  if (hex.startsWith("ffd8ff")) return ["image/jpeg", "jpg"];
  if (hex.startsWith("47494638")) return ["image/gif", "gif"];
  if (hex.startsWith("52494646") && hex.slice(16, 24) === "57454250") return ["image/webp", "webp"];
  if (hex.startsWith("25504446")) return ["application/pdf", "pdf"];
  if (hex.startsWith("504b0304")) return ["application/zip", "zip"];
  return ["application/octet-stream", "bin"];
}
const utf8 = s => new TextEncoder().encode(s);
const fromUtf8 = b => new TextDecoder("utf-8", { fatal: true }).decode(b);
function urlParams(s) {
  let u; try { u = new URL(s.trim()); } catch (e) { return null; }
  const out = []; u.searchParams.forEach((v, k) => out.push([k, v]));
  return { base: u.origin + u.pathname, params: out, hash: u.hash };
}
L.codec = { b64encode, b64decode, sniff, utf8, fromUtf8, urlParams };

// ---------- time ----------
const ZONES = [["北京", "Asia/Shanghai"], ["悉尼", "Australia/Sydney"], ["UTC", "UTC"]];
const WD = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"], fmts = {};
const pad = (n, w) => String(n).padStart(w || 2, "0");
function partsAt(ms, tz) {
  const f = fmts[tz] || (fmts[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short" }));
  const o = {}; f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) };
}
function offsetMin(ms, tz) {
  const t = Math.floor(ms / 1000) * 1000, p = partsAt(t, tz);
  return Math.round((Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t) / 60000);
}
function fmt(ms, tz) {
  const p = partsAt(ms, tz), frac = ((ms % 1000) + 1000) % 1000;
  return p.y + "-" + pad(p.mo) + "-" + pad(p.d) + " " + pad(p.h) + ":" + pad(p.mi) + ":" + pad(p.s) + (frac ? "." + pad(Math.floor(frac), 3) : "");
}
function offLabel(min) { const a = Math.abs(min); return "UTC" + (min < 0 ? "-" : "+") + Math.floor(a / 60) + (a % 60 ? ":" + pad(a % 60) : ""); }
function fromLocal(y, mo, d, hh, mi, s, msec, tz) {
  const guess = Date.UTC(y, mo - 1, d, hh, mi, s, msec || 0);
  let t = guess - offsetMin(guess, tz) * 60000;
  t = guess - offsetMin(t, tz) * 60000;
  return t;
}
// Reads a Unix timestamp (s, ms, µs or ns by its size), a date with an explicit offset, or a wall-clock date in tz.
function parseTime(input, tz, now) {
  const s = String(input).trim();
  if (!s) return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const x = Number(s), a = Math.abs(x);
    if (a < 1e11) return { ms: Math.round(x * 1000), kind: "秒级时间戳" };
    if (a < 1e14) return { ms: Math.round(x), kind: "毫秒级时间戳" };
    if (a < 1e17) return { ms: Math.round(x / 1000), kind: "微秒级时间戳" };
    return { ms: Math.round(x / 1e6), kind: "纳秒级时间戳" };
  }
  if (/\d[T ]\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
    const t = Date.parse(s.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (!isNaN(t)) return { ms: t, kind: "带时区的时间" };
  }
  let n = s.replace(/[年月]/g, "-").replace(/日|号/g, " ").replace(/[时点]/g, ":").replace(/分/g, ":").replace(/秒/g, "").replace(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/, "$1-$2-$3").replace(/T/i, " ").replace(/\s+/g, " ").replace(/:$/, "").replace(/: /, ":").trim().replace(/:$/, "");
  let m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/.exec(n);
  if (m) { const p = partsAt(now == null ? Date.now() : now, tz); n = p.y + "-" + p.mo + "-" + p.d + " " + n; }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?: (\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2})(?:\.(\d{1,3}))?)?)?$/.exec(n);
  if (!m) return { error: "看不懂这个时间。可以写 1731650000、2026-11-15 14:30 或 14:30" };
  const v = m.slice(1).map(x => x === undefined ? 0 : Number(x));
  if (v[1] < 1 || v[1] > 12 || v[2] < 1 || v[2] > 31 || v[3] > 23 || v[4] > 59 || v[5] > 59) return { error: "日期或时间超出范围" };
  const chk = new Date(Date.UTC(v[0], v[1] - 1, v[2]));
  if (chk.getUTCDate() !== v[2]) return { error: v[1] + " 月没有 " + v[2] + " 号" };
  const ms = (m[7] || "").padEnd(3, "0");
  return { ms: fromLocal(v[0], v[1], v[2], v[3], v[4], v[5], Number(ms), tz), kind: "当地时间" };
}
function rel(ms, now) {
  const d = Math.round((ms - now) / 1000), a = Math.abs(d), tail = d < 0 ? "前" : "后";
  if (a < 45) return "就是现在";
  if (a < 3600) return Math.round(a / 60) + " 分钟" + tail;
  if (a < 86400 * 2) return Math.round(a / 3600) + " 小时" + tail;
  if (a < 86400 * 60) return Math.round(a / 86400) + " 天" + tail;
  if (a < 86400 * 730) return Math.round(a / 86400 / 30.44) + " 个月" + tail;
  return (a / 86400 / 365.25).toFixed(1) + " 年" + tail;
}
// 24 rows, one per Beijing hour of the given Beijing date, with the same instant elsewhere.
function tzTable(dateStr, zones) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return [];
  const rows = [], base = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  for (let hh = 0; hh < 24; hh++) {
    const ms = fromLocal(+m[1], +m[2], +m[3], hh, 0, 0, 0, zones[0][1]);
    rows.push({ ms, cells: zones.map(z => { const p = partsAt(ms, z[1]); return { hm: pad(p.h) + ":" + pad(p.mi), day: Math.round((Date.UTC(p.y, p.mo - 1, p.d) - base) / 86400000) }; }) });
  }
  return rows;
}
// The next moment within the given days when tz changes its UTC offset (daylight saving), or null.
function nextShift(ms, tz, days) {
  const o0 = offsetMin(ms, tz);
  let lo = ms, hi = 0;
  for (let i = 1; i <= (days || 400); i++) { const t = ms + i * 86400000; if (offsetMin(t, tz) !== o0) { hi = t; break; } lo = t; }
  if (!hi) return null;
  while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 2 / 60000) * 60000; if (offsetMin(mid, tz) === o0) lo = mid; else hi = mid; }
  return { ms: hi, before: o0, after: offsetMin(hi, tz) };
}
L.time = { ZONES, WD, partsAt, offsetMin, fmt, offLabel, parseTime, rel, tzTable, nextShift, fromLocal };

// ---------- counting (Chinese-aware) ----------
function countText(s) {
  s = String(s);
  let graphemes = 0;
  if (typeof Intl !== "undefined" && Intl.Segmenter) { for (const _ of new Intl.Segmenter("zh", { granularity: "grapheme" }).segment(s)) graphemes++; }
  else graphemes = Array.from(s).length;
  const han = (s.match(/\p{Script=Han}/gu) || []).length;
  const kana = (s.match(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length;
  const words = (s.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu, " ").match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu) || []).length;
  const punct = (s.match(/\p{P}/gu) || []).length;
  const spaces = (s.match(/\s/gu) || []).length;
  const lines = s ? s.split(/\r\n|\r|\n/).length : 0;
  const paras = s.split(/\r\n|\r|\n/).filter(l => l.trim()).length;
  return { chars: graphemes, noSpace: graphemes - spaces, han, words, total: han + kana + words, punct, lines, paras, bytes: new TextEncoder().encode(s).length, minutes: (han + kana) / 400 + words / 230 };
}
L.count = countText;

// ---------- diff (Myers) ----------
// Returns [[op, ai, bi]] with op "=", "-", "+", or null when the inputs differ in more than maxD places.
function myers(a, b, maxD) {
  const n = a.length, m = b.length, max = n + m, off = max + 1, V = new Int32Array(2 * max + 3), trace = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxD) return null;
    trace.push(V.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) ? V[off + k + 1] : V[off + k - 1] + 1, y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= n && y >= m) return back(trace, d, n, m);
    }
  }
  return null;
}
function back(trace, D, n, m) {
  let x = n, y = m;
  const ops = [];
  for (let d = D; d > 0; d--) {
    const v = trace[d], k = x - y;
    const down = k === -d || (k !== d && v[k - 1 + d] < v[k + 1 + d]);
    const pk = down ? k + 1 : k - 1, px = v[pk + d], py = px - pk;
    while (x > px && y > py) { x--; y--; ops.push(["=", x, y]); }
    if (down) ops.push(["+", -1, py]); else ops.push(["-", px, -1]);
    x = px; y = py;
  }
  while (x > 0 && y > 0) { x--; y--; ops.push(["=", x, y]); }
  return ops.reverse();
}
function diffSeq(a, b, maxD) {
  let p = 0, s = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = myers(a.slice(p, a.length - s), b.slice(p, b.length - s), maxD == null ? 3000 : maxD);
  if (!mid) return null;
  const ops = [];
  for (let i = 0; i < p; i++) ops.push(["=", i, i]);
  mid.forEach(o => ops.push([o[0], o[1] < 0 ? -1 : o[1] + p, o[2] < 0 ? -1 : o[2] + p]));
  for (let i = s; i > 0; i--) ops.push(["=", a.length - i, b.length - i]);
  return ops;
}
function diffLines(ta, tb, ignoreSpace) {
  const A = String(ta).split(/\r\n|\r|\n/), B = String(tb).split(/\r\n|\r|\n/), ids = new Map();
  const key = l => { const k = ignoreSpace ? l.trim().replace(/\s+/g, " ") : l; if (!ids.has(k)) ids.set(k, ids.size); return ids.get(k); };
  const ops = diffSeq(A.map(key), B.map(key));
  if (!ops) return null;
  const rows = ops.map(o => o[0] === "=" ? { t: "=", text: A[o[1]], a: o[1] + 1, b: o[2] + 1 } : o[0] === "-" ? { t: "-", text: A[o[1]], a: o[1] + 1 } : { t: "+", text: B[o[2]], b: o[2] + 1 });
  // Pair runs of removed and added lines so changed characters inside them can be marked.
  for (let i = 0; i < rows.length;) {
    if (rows[i].t !== "-") { i++; continue; }
    let j = i; while (j < rows.length && rows[j].t === "-") j++;
    let k = j; while (k < rows.length && rows[k].t === "+") k++;
    const pairs = Math.min(j - i, k - j);
    for (let q = 0; q < pairs && pairs <= 50; q++) {
      const x = Array.from(rows[i + q].text), y = Array.from(rows[j + q].text), cd = diffSeq(x, y, 200);
      if (!cd) continue;
      const same = cd.filter(o => o[0] === "=").length;
      if (same * 2 < Math.max(x.length, y.length)) continue;
      rows[i + q].parts = spans(cd, x, "-"); rows[j + q].parts = spans(cd, y, "+");
    }
    i = k;
  }
  return { rows, added: rows.filter(r => r.t === "+").length, removed: rows.filter(r => r.t === "-").length };
}
function spans(cd, chars, side) {
  const out = [];
  cd.forEach(o => {
    if (o[0] !== "=" && o[0] !== side) return;
    const ch = chars[side === "-" ? o[1] : o[2]], hot = o[0] !== "=";
    const last = out[out.length - 1];
    if (last && last[1] === hot) last[0] += ch; else out.push([ch, hot]);
  });
  return out;
}
L.diff = { seq: diffSeq, lines: diffLines };

// ---------- random ----------
function rnd32() { return crypto.getRandomValues(new Uint32Array(1))[0]; }
function randInt(n, r) { const lim = Math.floor(0x100000000 / n) * n; let x; do x = (r || rnd32)(); while (x >= lim); return x % n; }
const SETS = { lower: "abcdefghijklmnopqrstuvwxyz", upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", digits: "0123456789", symbols: "!@#$%^&*-_=+?" };
function password(len, use, noAmbiguous, r) {
  const sets = Object.keys(SETS).filter(k => use[k]).map(k => noAmbiguous ? SETS[k].replace(/[Il1O0o]/g, "") : SETS[k]);
  if (!sets.length) throw new Error("至少选一种字符");
  if (len < sets.length) throw new Error("长度太短");
  const pool = sets.join("");
  for (let tries = 0; tries < 200; tries++) {
    let s = "";
    for (let i = 0; i < len; i++) s += pool[randInt(pool.length, r)];
    if (sets.every(set => [].some.call(s, c => set.indexOf(c) >= 0))) return { value: s, bits: Math.floor(len * Math.log2(pool.length)) };
  }
  throw new Error("生成失败，再点一次");
}
function uuidFrom(bytes, version, ms) {
  const b = bytes.slice(0, 16);
  if (version === 7) { let t = ms; for (let i = 5; i >= 0; i--) { b[i] = t % 256; t = Math.floor(t / 256); } }
  b[6] = (b[6] & 0x0f) | (version << 4); b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, v => v.toString(16).padStart(2, "0")).join("");
  return x.slice(0, 8) + "-" + x.slice(8, 12) + "-" + x.slice(12, 16) + "-" + x.slice(16, 20) + "-" + x.slice(20);
}
L.rand = { randInt, password, uuidFrom, SETS };

// ---------- hash ----------
async function digest(alg, bytes) {
  const d = new Uint8Array(await crypto.subtle.digest(alg, bytes));
  return { hex: Array.from(d, v => v.toString(16).padStart(2, "0")).join(""), b64: b64encode(d) };
}
L.hash = digest;

// ---------- colour ----------
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = n => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: Math.round(255 * f(0)), g: Math.round(255 * f(8)), b: Math.round(255 * f(4)) };
}
function rgbToHsl(c) {
  const r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: l * 100 };
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: s * 100, l: l * 100 };
}
function parseColor(input) {
  const s = String(input).trim().toLowerCase();
  let m = /^#?([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (m) { let x = m[1]; if (x.length <= 4) x = x.replace(/./g, "$&$&"); return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16) }; }
  const ch = v => Math.max(0, Math.min(255, Math.round(/%$/.test(v) ? parseFloat(v) * 2.55 : parseFloat(v))));
  m = /^rgba?\(\s*([\d.]+%?)[\s,]+([\d.]+%?)[\s,]+([\d.]+%?)(?:[\s,\/]+[\d.]+%?)?\s*\)$/.exec(s) || /^([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)$/.exec(s);
  if (m) return { r: ch(m[1]), g: ch(m[2]), b: ch(m[3]) };
  m = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?(?:[\s,\/]+[\d.]+%?)?\s*\)$/.exec(s);
  if (m) return hslToRgb(+m[1], +m[2], +m[3]);
  return null;
}
const hex = c => "#" + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, "0")).join("");
function luminance(c) { const f = v => (v /= 255) <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
function contrast(a, b) { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
L.color = { parseColor, hslToRgb, rgbToHsl, hex, luminance, contrast };

if (typeof document === "undefined") return;
const h = TB.h, T = TB.tools;
const out = () => h("pre", { class: "out", tabindex: "0" });

T.json = body => {
  const ta = TB.area({ "aria-label": "JSON 内容", placeholder: '{"粘贴":"到这里"}' }), st = TB.status(), res = out();
  const ind = TB.select([["2", "缩进 2 格"], ["4", "缩进 4 格"], ["t", "Tab 缩进"]], "2"), sort = TB.check("按键名排序");
  const run = (compact) => {
    const r = jsonFormat(ta.value, compact ? 0 : ind.value, sort[1].checked);
    res.textContent = r.ok ? r.out : "";
    TB.say(st, r.ok ? (r.lossy ? "按键名排序时超过 16 位的长数字会丢精度，要保留原样就别勾排序。" : "格式正确。") : r.error, !r.ok);
    if (!r.ok && r.line) { const lines = ta.value.split("\n"); let pos = 0; for (let i = 0; i < r.line - 1; i++) pos += lines[i].length + 1; ta.focus(); ta.setSelectionRange(pos, pos + (lines[r.line - 1] || "").length); }
  };
  body.append(ta, h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: () => run(false) }, "格式化"), h("button", { type: "button", onclick: () => run(true) }, "压成一行"), ind, sort[0], TB.copyBtn(() => res.textContent, "复制结果")), st, res);
};

T.base64 = body => {
  const ta = TB.area({ "aria-label": "要转换的内容", class: "prose" }), st = TB.status(), res = out(), extra = h("div");
  const safe = TB.check("网址安全格式（- 和 _，不补 =）");
  const show = (text) => { res.textContent = text; extra.replaceChildren(); };
  const enc = () => { show(b64encode(utf8(ta.value), safe[1].checked)); TB.say(st, "按 UTF-8 编码。"); };
  const dec = () => {
    let bytes;
    try { bytes = b64decode(ta.value); } catch (e) { show(""); return TB.say(st, e.message, true); }
    try { show(fromUtf8(bytes)); TB.say(st, "解出 " + bytes.length + " 字节文字。"); }
    catch (e) {
      const kind = sniff(bytes), blob = new Blob([bytes], { type: kind[0] });
      show(Array.from(bytes.subarray(0, 48), v => v.toString(16).padStart(2, "0")).join(" ") + (bytes.length > 48 ? " …" : ""));
      TB.say(st, "解出来是 " + L.size(bytes.length) + " 的二进制数据，不是文字。");
      extra.append(h("div", { class: "row" }, h("button", { type: "button", onclick: () => TB.save(blob, "解码." + kind[1]) }, "下载成文件（." + kind[1] + "）")));
      if (/^image\//.test(kind[0])) extra.append(h("img", { src: URL.createObjectURL(blob), alt: "解出的图片", class: "swatch" }));
    }
  };
  const pick = TB.picker({ label: "把文件转成 Base64", hint: "文件只在这台设备上读", onfiles: async fs => { const b = new Uint8Array(await fs[0].arrayBuffer()); show(b64encode(b, safe[1].checked)); TB.say(st, fs[0].name + "，" + L.size(b.length)); } });
  body.append(ta, h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: enc }, "编码"), h("button", { type: "button", onclick: dec }, "解码"), safe[0], TB.copyBtn(() => res.textContent, "复制结果")), st, res, extra, h("h2", null, "文件"), pick);
};

T.url = body => {
  const ta = TB.area({ "aria-label": "网址或文字", class: "prose" }), st = TB.status(), res = out(), tbl = h("div");
  const whole = TB.check("整条网址（保留 :/?&= 这些符号）"), plus = TB.check("把 + 当空格（表单格式）");
  const params = () => {
    tbl.replaceChildren();
    const p = urlParams(ta.value);
    if (p && p.params.length) tbl.append(h("h2", null, "参数"), h("table", { class: "kv" }, h("tbody", null, p.params.map(kv => h("tr", null, h("th", { class: "mono" }, kv[0]), h("td", { class: "mono" }, kv[1]))))));
  };
  const enc = () => { res.textContent = whole[1].checked ? encodeURI(ta.value) : encodeURIComponent(ta.value); TB.say(st, ""); params(); };
  const dec = () => {
    try { res.textContent = decodeURIComponent(plus[1].checked ? ta.value.replace(/\+/g, " ") : ta.value); TB.say(st, ""); }
    catch (e) { res.textContent = ""; TB.say(st, "里面有不完整的 % 编码，解不开。", true); }
    params();
  };
  body.append(ta, h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: dec }, "解码"), h("button", { type: "button", onclick: enc }, "编码"), whole[0], plus[0], TB.copyBtn(() => res.textContent, "复制结果")), st, res, tbl);
};

T.time = body => {
  const inp = h("input", { type: "text", inputmode: "text", autocomplete: "off", "aria-describedby": "time-hint", class: "mono" });
  inp.style.width = "100%";
  const zone = TB.select(ZONES.map(z => [z[1], "按" + z[0] + "时间理解"]), "Asia/Shanghai"), st = TB.status(), res = h("div");
  const draw = () => {
    res.replaceChildren();
    const now = Date.now(), r = parseTime(inp.value, zone.value, now);
    if (!r) return TB.say(st, "");
    if (r.error) return TB.say(st, r.error, true);
    TB.say(st, "当成" + r.kind + "，" + rel(r.ms, now) + "。");
    const rows = ZONES.map(z => { const p = partsAt(r.ms, z[1]); return [z[0], fmt(r.ms, z[1]) + "  " + WD[p.wd] + "  " + offLabel(offsetMin(r.ms, z[1]))]; });
    rows.push(["Unix 秒", String(Math.floor(r.ms / 1000))], ["Unix 毫秒", String(r.ms)], ["ISO 8601", new Date(r.ms).toISOString()]);
    res.append(h("table", { class: "kv" }, h("tbody", null, rows.map(x => h("tr", null, h("th", null, x[0]), h("td", { class: "mono" }, x[1]), h("td", null, TB.copyBtn(x[1].split("  ")[0])))))));
  };
  inp.addEventListener("input", TB.debounce(draw, 150));
  zone.addEventListener("change", draw);
  body.append(TB.field("时间戳或日期", inp), h("p", { id: "time-hint", class: "hint" }, "例：1731650000、1731650000123、2026-11-15 14:30、14:30、2026-11-15T06:30:00Z"),
    h("div", { class: "row" }, zone, h("button", { type: "button", onclick: () => { inp.value = String(Math.floor(Date.now() / 1000)); draw(); } }, "现在")), st, res);
  inp.value = String(Math.floor(Date.now() / 1000)); draw();
};

T.tz = body => {
  const now = Date.now(), p0 = partsAt(now, "Asia/Shanghai");
  const date = h("input", { type: "date", value: p0.y + "-" + pad(p0.mo) + "-" + pad(p0.d) });
  const note = h("p"), wrap = h("div");
  const draw = () => {
    const rows = tzTable(date.value, ZONES);
    if (!rows.length) return;
    const mid = rows[12].ms, diff = (offsetMin(mid, "Australia/Sydney") - offsetMin(mid, "Asia/Shanghai")) / 60;
    const shift = nextShift(mid, "Australia/Sydney", 370);
    note.textContent = "这天悉尼比北京快 " + diff + " 小时（悉尼 " + offLabel(offsetMin(mid, "Australia/Sydney")) + (offsetMin(mid, "Australia/Sydney") === 660 ? "，夏令时" : "") + "）。" +
      (shift ? "悉尼 " + fmt(shift.ms, "Australia/Sydney").slice(0, 10) + " 起改成 " + offLabel(shift.after) + "，届时快 " + (shift.after - 480) / 60 + " 小时。" : "");
    const curH = Math.floor(Date.now() / 3600000);
    const day = d => d ? (d > 0 ? " 次日" : " 前一天") : "";
    wrap.replaceChildren(h("table", { class: "kv" },
      h("thead", null, h("tr", null, ZONES.map(z => h("th", { scope: "col" }, z[0])))),
      h("tbody", null, rows.map(r => h("tr", { class: Math.floor(r.ms / 3600000) === curH ? "now" : null, "aria-current": Math.floor(r.ms / 3600000) === curH ? "time" : null },
        r.cells.map((c, i) => h(i ? "td" : "th", { class: "mono" }, c.hm + day(c.day))))))));
  };
  date.addEventListener("change", draw);
  body.append(h("div", { class: "row" }, TB.field("北京日期", date), h("button", { type: "button", onclick: () => { date.value = p0.y + "-" + pad(p0.mo) + "-" + pad(p0.d); draw(); } }, "今天")), note, wrap);
  draw();
};

T.count = body => {
  const ta = TB.area({ "aria-label": "要统计的文字", class: "prose", placeholder: "粘贴文字" }), grid = h("div", { class: "stats", "aria-live": "polite" });
  const draw = () => {
    const c = countText(ta.value);
    const items = [["字数", c.total, "汉字算一个，英文按词"], ["汉字", c.han], ["英文和数字词", c.words], ["字符", c.chars], ["不含空白", c.noSpace], ["标点", c.punct], ["行", c.lines], ["段落", c.paras], ["UTF-8 字节", c.bytes], ["阅读约", Math.max(c.total ? 1 : 0, Math.round(c.minutes)) + " 分钟"]];
    grid.replaceChildren.apply(grid, items.map(x => h("div", { title: x[2] || null }, h("b", null, String(x[1])), h("span", null, x[0]))));
  };
  ta.addEventListener("input", TB.debounce(draw, 100));
  body.append(ta, grid, h("p", { class: "hint" }, "字数的算法和 Word 一致：每个汉字算一个字，英文和数字按空格分开的词算。"));
  draw();
};

T.diff = body => {
  const a = TB.area({ "aria-label": "原文" }), b = TB.area({ "aria-label": "改后" }), st = TB.status(), res = h("div");
  const ws = TB.check("忽略空格差别"), only = TB.check("只看改动附近", true);
  const run = () => {
    const r = diffLines(a.value, b.value, ws[1].checked);
    res.replaceChildren();
    if (!r) return TB.say(st, "两段差别太大，逐行对比算不过来。", true);
    if (!r.added && !r.removed) return TB.say(st, "两段完全一样" + (ws[1].checked ? "（忽略空格）" : "") + "。");
    TB.say(st, "删了 " + r.removed + " 行，加了 " + r.added + " 行。");
    const box = h("div", { class: "diff", tabindex: "0", "aria-label": "对比结果" }), keep = new Array(r.rows.length).fill(!only[1].checked);
    if (only[1].checked) r.rows.forEach((x, i) => { if (x.t !== "=") for (let j = Math.max(0, i - 3); j <= Math.min(r.rows.length - 1, i + 3); j++) keep[j] = true; });
    let gap = 0;
    const flush = () => { if (gap) box.append(h("div", { class: "gap" }, "… 相同的 " + gap + " 行")); gap = 0; };
    r.rows.forEach((x, i) => {
      if (!keep[i]) { gap++; return; }
      flush();
      const sign = x.t === "=" ? "  " : x.t === "-" ? "- " : "+ ";
      const line = h("div", { class: x.t === "-" ? "d" : x.t === "+" ? "a" : null }, sign);
      if (x.parts) x.parts.forEach(p => line.append(p[1] ? h(x.t === "-" ? "del" : "ins", null, p[0]) : p[0]));
      else line.append(x.text || " ");
      box.append(line);
    });
    flush();
    res.append(box);
  };
  body.append(h("div", { class: "grid two" }, TB.field("原文", a), TB.field("改后", b)), h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: run }, "对比"), ws[0], only[0]), st, res);
};

T.regex = body => {
  const pat = h("input", { type: "text", class: "mono", autocomplete: "off", autocapitalize: "off", spellcheck: "false" });
  pat.style.width = "100%";
  const flags = ["g", "i", "m", "s", "u"].map(f => TB.check(f === "g" ? "g 全部" : f === "i" ? "i 不分大小写" : f === "m" ? "m 多行" : f === "s" ? "s 点号含换行" : "u Unicode", f === "g" || f === "u"));
  const text = TB.area({ "aria-label": "测试文字" }), rep = h("input", { type: "text", class: "mono", autocomplete: "off", placeholder: "替换成（可用 $1、$<名字>）" });
  rep.style.width = "100%";
  const st = TB.status(), hl = h("div", { class: "hl", "aria-label": "匹配结果" }), groups = h("div"), repOut = out();
  let worker = null, timer = 0;
  const flagStr = () => ["g", "i", "m", "s", "u"].filter((f, i) => flags[i][1].checked).join("");
  const run = () => {
    if (worker) worker.terminate();
    clearTimeout(timer);
    if (!pat.value) { hl.textContent = text.value; groups.replaceChildren(); repOut.textContent = ""; return TB.say(st, ""); }
    worker = new Worker(TB.conf.rx);
    timer = setTimeout(() => { worker.terminate(); worker = null; TB.say(st, "算了 1.5 秒还没完，这个表达式回溯太多，换个写法。", true); }, 1500);
    worker.onmessage = e => {
      clearTimeout(timer); worker.terminate(); worker = null;
      const r = e.data;
      if (!r.ok) { hl.textContent = text.value; groups.replaceChildren(); return TB.say(st, r.error, true); }
      TB.say(st, r.matches.length ? "匹配到 " + r.matches.length + (r.more ? "+ " : " ") + "处。" : "没有匹配。");
      const s = text.value, frag = [];
      let at = 0;
      r.matches.forEach(m => { if (m.i >= at) { frag.push(s.slice(at, m.i), h("mark", null, m.t || "")); at = m.i + m.t.length; } });
      frag.push(s.slice(at));
      hl.replaceChildren.apply(hl, frag);
      groups.replaceChildren();
      const withGroups = r.matches.filter(m => m.g.length);
      if (withGroups.length) groups.append(h("table", { class: "kv" }, h("tbody", null, withGroups.slice(0, 50).map((m, i) => h("tr", null, h("th", null, "第 " + (i + 1) + " 处"), h("td", { class: "mono" }, m.g.map((g, j) => "$" + (j + 1) + " = " + (g === undefined ? "（没匹配）" : JSON.stringify(g))).join("\n") + (m.n ? "\n" + Object.keys(m.n).map(k => k + " = " + JSON.stringify(m.n[k])).join("\n") : "")))))));
      repOut.textContent = rep.value ? r.replaced : "";
    };
    worker.postMessage([pat.value, flagStr(), text.value, rep.value || null]);
  };
  const later = TB.debounce(run, 250);
  [pat, text, rep].forEach(el => el.addEventListener("input", later));
  flags.forEach(f => f[1].addEventListener("change", run));
  body.append(TB.field("正则表达式（不用写两边的 /）", pat), h("div", { class: "row" }, flags.map(f => f[0])), TB.field("测试文字", text), st, hl, groups, TB.field("替换", rep), repOut);
};

T.uuid = body => {
  const n = h("input", { type: "number", min: "1", max: "500", value: "5", inputmode: "numeric" });
  n.style.width = "6rem";
  const ver = TB.select([["4", "v4 随机"], ["7", "v7 按时间排序"]], "4"), up = TB.check("大写"), bare = TB.check("去掉横线"), res = out();
  const gen = () => {
    const k = Math.max(1, Math.min(500, Math.floor(Number(n.value) || 1))), lines = [];
    for (let i = 0; i < k; i++) {
      let u = uuidFrom(crypto.getRandomValues(new Uint8Array(16)), Number(ver.value), Date.now());
      if (bare[1].checked) u = u.replace(/-/g, "");
      lines.push(up[1].checked ? u.toUpperCase() : u);
    }
    res.textContent = lines.join("\n");
  };
  body.append(h("div", { class: "row" }, TB.field("个数", n), TB.field("版本", ver), up[0], bare[0]), h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: gen }, "生成"), TB.copyBtn(() => res.textContent, "全部复制")), res);
  gen();
};

T.password = body => {
  const len = h("input", { type: "range", min: "6", max: "64", value: "16" }), lenOut = h("output", null, "16");
  const sets = [["lower", "小写"], ["upper", "大写"], ["digits", "数字"], ["symbols", "符号"]].map(x => [x[0]].concat(TB.check(x[1], x[0] !== "symbols")));
  const amb = TB.check("去掉易混的 I l 1 O 0 o", true), res = h("pre", { class: "out", "aria-live": "polite" }), st = TB.status();
  const gen = () => {
    lenOut.textContent = len.value;
    const use = {}; sets.forEach(x => { use[x[0]] = x[2].checked; });
    try { const r = password(Number(len.value), use, amb[1].checked); res.textContent = r.value; TB.say(st, "强度约 " + r.bits + " 位" + (r.bits >= 80 ? "，够用。" : r.bits >= 60 ? "，一般网站够用。" : "，偏弱，加长一点。")); }
    catch (e) { res.textContent = ""; TB.say(st, e.message, true); }
  };
  len.addEventListener("input", gen);
  sets.forEach(x => x[2].addEventListener("change", gen)); amb[1].addEventListener("change", gen);
  body.append(h("div", { class: "row" }, h("label", { class: "check" }, "长度 ", len), lenOut), h("div", { class: "row" }, sets.map(x => x[1]), amb[0]), res, st,
    h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: gen }, "换一个"), TB.copyBtn(() => res.textContent)), h("p", { class: "hint" }, "用浏览器的安全随机数生成，不保存、不上传。"));
  gen();
};

T.hash = body => {
  const ta = TB.area({ "aria-label": "文字", class: "prose", placeholder: "输入文字，或者在下面选文件" }), alg = TB.select([["SHA-256", "SHA-256"], ["SHA-1", "SHA-1"], ["SHA-384", "SHA-384"], ["SHA-512", "SHA-512"]], "SHA-256");
  const expect = h("input", { type: "text", class: "mono", placeholder: "可选：粘贴对方给的值来核对", autocomplete: "off" });
  expect.style.width = "100%";
  const st = TB.status(), res = h("div");
  let last = null;
  const show = async (bytes, what) => {
    TB.say(st, "计算中…");
    const d = await digest(alg.value, bytes);
    last = [bytes, what];
    const want = expect.value.trim().toLowerCase().replace(/\s+/g, "");
    res.replaceChildren(h("table", { class: "kv" }, h("tbody", null,
      h("tr", null, h("th", null, "十六进制"), h("td", { class: "mono" }, d.hex), h("td", null, TB.copyBtn(d.hex))),
      h("tr", null, h("th", null, "Base64"), h("td", { class: "mono" }, d.b64), h("td", null, TB.copyBtn(d.b64))))));
    TB.say(st, what + "。" + (want ? (want === d.hex || want === d.b64.toLowerCase() ? "和填的值一致。" : "和填的值不一致。") : ""), !!want && want !== d.hex && want !== d.b64.toLowerCase());
  };
  const pick = TB.picker({ label: "选文件", hint: "文件不会上传，大文件要等一会儿", onfiles: async fs => {
    const f = fs[0];
    if (f.size > 1024 * 1048576) return TB.say(st, "超过 1 GB 的文件在浏览器里算不动。", true);
    TB.say(st, "读取中…"); show(new Uint8Array(await f.arrayBuffer()), f.name + "，" + L.size(f.size));
  } });
  alg.addEventListener("change", () => { if (last) show(last[0], last[1]); });
  expect.addEventListener("input", () => { if (last) show(last[0], last[1]); });
  body.append(ta, h("div", { class: "row" }, h("button", { type: "button", class: "pri", onclick: () => show(utf8(ta.value), "按 UTF-8 文字计算") }, "算文字"), alg), pick, TB.field("核对", expect), st, res);
};

T.color = body => {
  const mk = (label, v) => {
    const t = h("input", { type: "text", value: v, class: "mono", autocomplete: "off", spellcheck: "false" }), c = h("input", { type: "color", value: v, "aria-label": label + "取色" });
    t.style.width = "12rem";
    c.addEventListener("input", () => { t.value = c.value; draw(); });
    t.addEventListener("input", draw);
    return { t, c, el: h("div", { class: "row" }, TB.field(label, t), c) };
  };
  const fg = mk("颜色（HEX、rgb() 或 hsl() 都行）", "#2d6a5a"), bg = mk("对比的背景色", "#ffffff"), conv = h("div"), sw = h("div", { class: "swatch" }), st = TB.status();
  function draw() {
    const a = parseColor(fg.t.value), b = parseColor(bg.t.value);
    conv.replaceChildren();
    if (!a) return TB.say(st, "第一个颜色看不懂。", true);
    TB.say(st, "");
    fg.c.value = hex(a); if (b) bg.c.value = hex(b);
    const hs = rgbToHsl(a), vals = [["HEX", hex(a)], ["RGB", "rgb(" + a.r + ", " + a.g + ", " + a.b + ")"], ["HSL", "hsl(" + Math.round(hs.h) % 360 + ", " + Math.round(hs.s) + "%, " + Math.round(hs.l) + "%)"]];
    conv.append(h("table", { class: "kv" }, h("tbody", null, vals.map(v => h("tr", null, h("th", null, v[0]), h("td", { class: "mono" }, v[1]), h("td", null, TB.copyBtn(v[1])))))));
    if (!b) return TB.say(st, "背景色看不懂。", true);
    const r = contrast(a, b), ok = (x) => h("span", { class: r >= x ? "pass" : "fail" }, r >= x ? "通过" : "不够");
    sw.style.color = hex(a); sw.style.background = hex(b);
    sw.replaceChildren("示例文字 Aa 123", h("small", null, "小字号的正文看起来是这样"));
    conv.append(h("table", { class: "kv" }, h("tbody", null,
      h("tr", null, h("th", null, "对比度"), h("td", { class: "mono" }, (Math.floor(r * 100) / 100).toFixed(2) + " : 1")),
      h("tr", null, h("th", null, "正文 AA（4.5）"), h("td", null, ok(4.5))),
      h("tr", null, h("th", null, "大字 AA（3）"), h("td", null, ok(3))),
      h("tr", null, h("th", null, "正文 AAA（7）"), h("td", null, ok(7))))));
  }
  body.append(fg.el, bg.el, st, sw, conv);
  draw();
};
})();
`;

export const RX_JS = String.raw`(function () {
"use strict";
// Runs in a Worker so a runaway pattern can be stopped from the page.
function rxRun(p, f, s, rep) {
  let re;
  try { re = new RegExp(p, f.replace("g", "") + "g"); } catch (e) { return { ok: false, error: "表达式写错了：" + e.message }; }
  const out = [];
  let m, more = false;
  while ((m = re.exec(s))) {
    if (out.length >= 1000) { more = true; break; }
    out.push({ i: m.index, t: m[0], g: m.slice(1), n: m.groups ? Object.assign({}, m.groups) : null });
    if (m[0] === "") re.lastIndex += /u/.test(f) && s.codePointAt(m.index) > 0xffff ? 2 : 1;
  }
  let replaced = null;
  if (rep != null) { try { replaced = s.replace(new RegExp(p, f), rep); } catch (e) {} }
  return { ok: true, matches: out, more, replaced };
}
if (typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) self.onmessage = e => self.postMessage(rxRun.apply(null, e.data));
else if (self.TB) self.TB.lib.rx = rxRun;
})();
`;

export const IMAGE_JS = String.raw`(function () {
"use strict";
const TB = self.TB, L = TB.lib;

// Reads orientation and whether GPS tags exist from a JPEG's Exif block. null when not a JPEG.
function exifInfo(u8) {
  if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  const r = { exif: false, orientation: 1, gps: false };
  let i = 2;
  while (i + 4 <= u8.length) {
    if (u8[i] !== 0xFF) break;
    const mk = u8[i + 1];
    if (mk === 0xFF) { i++; continue; }
    if (mk === 0xD8 || mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { i += 2; continue; }
    if (mk === 0xDA || mk === 0xD9) break;
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (mk === 0xE1 && len > 14 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 && u8[i + 7] === 0x66 && u8[i + 8] === 0 && u8[i + 9] === 0) tiff(u8, i + 10, Math.min(u8.length, i + 2 + len), r);
    i += 2 + len;
  }
  return r;
}
function tiff(u8, start, end, r) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), le = u8[start] === 0x49;
  const ok = (o, n) => start + o >= start && start + o + n <= end;
  const u16 = o => dv.getUint16(start + o, le), u32 = o => dv.getUint32(start + o, le);
  if (!ok(0, 8) || u16(2) !== 42) return;
  r.exif = true;
  const ifd = u32(4);
  if (!ok(ifd, 2)) return;
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (!ok(e, 12)) break;
    const tag = u16(e);
    if (tag === 0x0112) r.orientation = u16(e + 8);
    if (tag === 0x8825) {
      const g = u32(e + 8);
      if (!ok(g, 2)) continue;
      for (let q = 0, gn = u16(g); q < gn; q++) { const ge = g + 2 + q * 12; if (!ok(ge, 12)) break; const t = u16(ge); if (t === 2 || t === 4) r.gps = true; }
    }
  }
}
// Source rectangle and output size for a crop ratio, an anchor and a longest-side limit.
function plan(w, h, o) {
  let sx = 0, sy = 0, sw = w, sh = h;
  if (o.ratio) {
    const want = o.ratio[0] / o.ratio[1];
    if (w / h > want) { sw = Math.max(1, Math.round(h * want)); sx = o.anchor === "start" ? 0 : o.anchor === "end" ? w - sw : Math.round((w - sw) / 2); }
    else if (w / h < want) { sh = Math.max(1, Math.round(w / want)); sy = o.anchor === "start" ? 0 : o.anchor === "end" ? h - sh : Math.round((h - sh) / 2); }
  }
  let scale = 1;
  if (o.maxSide && Math.max(sw, sh) > o.maxSide) scale = o.maxSide / Math.max(sw, sh);
  const cap = o.maxPixels || 16000000;
  if (sw * sh * scale * scale > cap) scale = Math.sqrt(cap / (sw * sh));
  let dw = Math.max(1, Math.round(sw * scale)), dh = Math.max(1, Math.round(sh * scale));
  if (dw * dh > cap) { dw = Math.floor(sw * scale); dh = Math.floor(sh * scale); }
  return { sx, sy, sw, sh, dw, dh, capped: scale < 1 && (!o.maxSide || Math.max(sw, sh) * scale < o.maxSide - 1) };
}
const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
function outType(inType, choice) {
  if (choice && choice !== "keep") return choice;
  return EXT[inType] ? inType : "image/jpeg";
}
L.img = { exifInfo, plan, outType, EXT };

if (typeof document === "undefined") return;
const h = TB.h, T = TB.tools;

async function decode(file) {
  if (self.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) {}
    try { return await createImageBitmap(file); } catch (e) {}
  }
  return new Promise((ok, bad) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(u); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(u); bad(new Error("浏览器打不开这个格式")); };
    img.src = u;
  });
}
TB.decode = decode;
TB.exifOf = async file => exifInfo(new Uint8Array(await file.slice(0, 262144).arrayBuffer()));
// Draws src into a w×h canvas, halving in steps so big reductions stay smooth.
function draw(src, p, opaque) {
  let cur = src, cw = p.sw, ch = p.sh, cx = p.sx, cy = p.sy;
  while (cw / 2 >= p.dw && ch / 2 >= p.dh) {
    const c = document.createElement("canvas"); c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(cur, cx, cy, cw, ch, 0, 0, c.width, c.height);
    if (cur !== src) { cur.width = cur.height = 0; }
    cur = c; cw = c.width; ch = c.height; cx = cy = 0;
  }
  const out = document.createElement("canvas"); out.width = p.dw; out.height = p.dh;
  const g = out.getContext("2d");
  if (opaque) { g.fillStyle = "#fff"; g.fillRect(0, 0, p.dw, p.dh); }
  g.imageSmoothingQuality = "high";
  g.drawImage(cur, cx, cy, cw, ch, 0, 0, p.dw, p.dh);
  if (cur !== src) { cur.width = cur.height = 0; }
  return out;
}
TB.encode = async (file, o) => {
  const src = await decode(file), w = src.width || src.naturalWidth, hh = src.height || src.naturalHeight;
  const p = plan(w, hh, o), type = outType(file.type, o.type);
  const cv = draw(src, p, type === "image/jpeg");
  if (src.close) src.close();
  const blob = await new Promise(ok => cv.toBlob(ok, type, o.quality));
  cv.width = cv.height = 0;
  if (!blob) throw new Error("浏览器没能导出这张图");
  return { blob, w, h: hh, p, type, gotType: blob.type };
};

const KIND = {
  "img-compress": { type: "keep", quality: 0.8, side: "1920", show: ["type", "quality", "side"], btn: "压缩" },
  "img-convert": { type: "image/webp", quality: 0.9, side: "0", show: ["type", "quality", "side"], btn: "转换" },
  "img-crop": { type: "keep", quality: 0.92, side: "0", show: ["ratio", "anchor", "type", "quality", "side"], btn: "裁剪" },
  "img-clean": { type: "keep", quality: 0.92, side: "0", show: ["quality"], btn: "去掉信息" },
};
function imageTool(id) {
  const k = KIND[id];
  return body => {
    let files = [], results = [];
    const type = TB.select([["keep", "保持原格式"], ["image/jpeg", "JPEG"], ["image/webp", "WebP"], ["image/png", "PNG"]], k.type);
    const q = h("input", { type: "range", min: "0.4", max: "1", step: "0.02", value: String(k.quality) }), qOut = h("output", null, Math.round(k.quality * 100));
    q.addEventListener("input", () => { qOut.textContent = Math.round(q.value * 100); });
    const side = TB.select([["0", "不缩小"], ["3840", "3840"], ["2560", "2560"], ["1920", "1920"], ["1600", "1600"], ["1280", "1280"], ["1080", "1080"], ["800", "800"], ["c", "自定义"]], k.side);
    const custom = h("input", { type: "number", min: "16", max: "16000", value: "1200", inputmode: "numeric", "aria-label": "自定义最长边像素", hidden: true });
    custom.style.width = "6rem";
    side.addEventListener("change", () => { custom.hidden = side.value !== "c"; });
    const ratio = TB.select([["1:1", "1:1 方图"], ["4:3", "4:3"], ["3:4", "3:4"], ["3:2", "3:2"], ["2:3", "2:3"], ["16:9", "16:9"], ["9:16", "9:16"], ["c", "自定义"]], "1:1");
    const rw = h("input", { type: "number", min: "1", value: "5", "aria-label": "宽", inputmode: "numeric" }), rh = h("input", { type: "number", min: "1", value: "4", "aria-label": "高", inputmode: "numeric" });
    rw.style.width = rh.style.width = "4.5rem";
    const rc = h("span", { hidden: true }, rw, " : ", rh);
    ratio.addEventListener("change", () => { rc.hidden = ratio.value !== "c"; });
    const anchor = TB.select([["center", "居中"], ["start", "靠上 / 靠左"], ["end", "靠下 / 靠右"]], "center");
    const ctl = { type: TB.field("格式", type), quality: h("label", { class: "check" }, "质量 ", q, qOut), side: h("span", { class: "row" }, TB.field("最长边（像素）", side), custom), ratio: h("span", { class: "row" }, TB.field("比例", ratio), rc), anchor: TB.field("保留", anchor) };
    const list = h("ul", { class: "list" }), st = TB.status(), go = h("button", { type: "button", class: "pri", disabled: true }, k.btn), zip = h("button", { type: "button", hidden: true }, "全部打包下载");
    const pick = TB.picker({ label: "选图片", multiple: true, accept: "image/*", hint: "可以一次选多张；图片不会离开这台设备", onfiles: fs => { files = fs; results = []; zip.hidden = true; drawList(); go.disabled = false; TB.say(st, fs.length + " 张，点“" + k.btn + "”开始。"); if (id === "img-clean") scanGps(); } });
    const drawList = () => {
      list.replaceChildren.apply(list, files.map((f, i) => {
        const r = results[i];
        const name = r && r.blob ? r.name : f.name;
        const info = [L.size(f.size)];
        if (r && r.blob) info.push("→ " + L.size(r.blob.size) + (r.blob.size < f.size ? "（小了 " + Math.round((1 - r.blob.size / f.size) * 100) + "%）" : "（比原图大）"), r.w + "×" + r.h + (r.p.dw !== r.w || r.p.dh !== r.h ? " → " + r.p.dw + "×" + r.p.dh : ""));
        if (r && r.note) info.push(r.note);
        if (r && r.error) info.push(r.error);
        if (f.gps !== undefined) info.push(f.gps === null ? "不是 JPEG，看不出有没有定位" : f.gps ? "原图带定位信息" : "原图没有定位信息");
        return h("li", null, r && r.url ? h("img", { src: r.url, alt: "" }) : null, h("span", { class: "nm" }, name, h("small", { class: r && r.error ? "err" : null }, info.join(" · "))),
          r && r.blob ? h("button", { type: "button", class: "sm", "aria-label": "下载 " + name, onclick: () => TB.save(r.blob, r.name) }, "下载") : null);
      }));
    };
    const scanGps = async () => { for (const f of files) { const x = await TB.exifOf(f).catch(() => null); f.gps = x ? x.gps : null; } drawList(); };
    const opts = () => {
      const ms = side.value === "c" ? Math.max(16, Number(custom.value) || 0) : Number(side.value);
      let ra = null;
      if (k.show.indexOf("ratio") >= 0) { const v = ratio.value === "c" ? [Number(rw.value), Number(rh.value)] : ratio.value.split(":").map(Number); if (v[0] > 0 && v[1] > 0) ra = v; }
      return { type: k.show.indexOf("type") >= 0 ? type.value : "keep", quality: Number(q.value), maxSide: ms || 0, ratio: ra, anchor: anchor.value };
    };
    go.addEventListener("click", async () => {
      go.disabled = true; zip.hidden = true;
      results.forEach(r => r && r.url && URL.revokeObjectURL(r.url));
      results = [];
      const o = opts();
      for (let i = 0; i < files.length; i++) {
        TB.say(st, "处理第 " + (i + 1) + " / " + files.length + " 张…");
        try {
          const r = await TB.encode(files[i], o), ext = L.img.EXT[r.gotType] || "img";
          r.name = L.base(files[i].name) + "." + ext;
          r.url = URL.createObjectURL(r.blob);
          if (r.gotType !== r.type) r.note = "这个浏览器导不出 " + (L.img.EXT[r.type] || r.type).toUpperCase() + "，存成了 " + ext.toUpperCase();
          else if (r.p.capped) r.note = "图太大，按浏览器上限缩到了 " + r.p.dw + "×" + r.p.dh;
          if (id === "img-clean") r.note = (r.note ? r.note + " · " : "") + "已去掉拍摄信息和定位";
          results[i] = r;
        } catch (e) { results[i] = { error: e.message || "处理失败" }; }
        drawList();
      }
      const done = results.filter(r => r && r.blob);
      TB.say(st, done.length === files.length ? "好了。" : "有 " + (files.length - done.length) + " 张没处理成。", done.length !== files.length);
      zip.hidden = done.length < 2; go.disabled = false;
    });
    zip.addEventListener("click", async () => {
      zip.disabled = true; TB.say(st, "打包中…");
      const items = [];
      for (const r of results) if (r && r.blob) items.push({ name: r.name, data: new Uint8Array(await r.blob.arrayBuffer()) });
      TB.save(TB.zipBlob(items), "图片.zip"); zip.disabled = false; TB.say(st, "已打包 " + items.length + " 张。");
    });
    const intro = {
      "img-compress": "调低质量、限制最长边来缩小文件。照片用 JPEG 或 WebP 最省；PNG 只能靠缩小尺寸。",
      "img-convert": "在 JPEG、PNG、WebP 之间转换。透明背景转 JPEG 会变成白底。",
      "img-crop": "按固定比例裁掉多余部分，可以选保留中间还是两端。",
      "img-clean": "把照片重新画一遍再导出，只留下像素：拍摄时间、相机型号、GPS 定位都不会带走。发到网上之前用。",
    }[id];
    body.append(h("p", null, intro), pick, h("div", { class: "row" }, k.show.map(s => ctl[s])), h("div", { class: "row" }, go, zip), st, list);
  };
}
Object.keys(KIND).forEach(id => { T[id] = imageTool(id); });
})();
`;

export const PDF_JS = String.raw`(function () {
"use strict";
const TB = self.TB, L = TB.lib;

// "1-3, 5, 8-" -> [[1,3],[5,5],[8,total]]; a range written backwards ("5-3") keeps that order.
function parseRanges(input, total) {
  const s = String(input).replace(/[，、；;]/g, ",").replace(/[～~—–－至到]/g, "-").replace(/\s+/g, "");
  if (!s) throw new Error("先写要哪些页，比如 1-3,5,8-");
  const out = [];
  for (const part of s.split(",").filter(Boolean)) {
    let m = /^(\d+)$/.exec(part), a, b;
    if (m) a = b = +m[1];
    else if ((m = /^(\d*)-(\d*)$/.exec(part)) && (m[1] || m[2])) { a = m[1] ? +m[1] : 1; b = m[2] ? +m[2] : total; }
    else throw new Error("看不懂“" + part + "”，页码写成 3 或 2-5 这样");
    if (a < 1 || b < 1) throw new Error("页码从 1 开始");
    if (a > total || b > total) throw new Error("这个文件只有 " + total + " 页，“" + part + "”超出了");
    out.push([a, b]);
  }
  return out;
}
function expand(r) { const out = [], step = r[0] <= r[1] ? 1 : -1; for (let p = r[0]; p !== r[1] + step; p += step) out.push(p); return out; }
const A4 = [595.28, 841.89], MM = 72 / 25.4;
// Page size and image placement (PDF points) for an image of w×h pixels.
function placeImage(w, h, size, marginMm) {
  const m = marginMm * MM;
  if (size === "image") { const pw = w * 0.75, ph = h * 0.75; return { pw: pw + 2 * m, ph: ph + 2 * m, x: m, y: m, w: pw, h: ph }; }
  let pw = A4[0], ph = A4[1];
  if (size === "a4auto" && w > h) { pw = A4[1]; ph = A4[0]; }
  const s = Math.min((pw - 2 * m) / w, (ph - 2 * m) / h), iw = w * s, ih = h * s;
  return { pw, ph, x: (pw - iw) / 2, y: (ph - ih) / 2, w: iw, h: ih };
}
L.pdf = { parseRanges, expand, placeImage };

if (typeof document === "undefined") return;
const h = TB.h, T = TB.tools;
let libP = null;
function lib(st) {
  if (self.PDFLib) return Promise.resolve(self.PDFLib);
  if (st) TB.say(st, "第一次用，正在载入 PDF 组件（约 500 KB）…");
  return libP || (libP = new Promise((ok, bad) => {
    const c = TB.conf.pdflib, s = h("script", { src: c.src, integrity: c.sri, crossorigin: "anonymous", referrerpolicy: "no-referrer" });
    s.onload = () => self.PDFLib ? ok(self.PDFLib) : bad(new Error("PDF 组件载入异常"));
    s.onerror = () => { libP = null; s.remove(); bad(new Error("PDF 组件没载入成功，检查网络后再试")); };
    document.head.append(s);
  }));
}
async function open(file) {
  const P = await lib(), bytes = await file.arrayBuffer();
  try { return await P.PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) {
    if (/encrypt/i.test(String(e && e.message))) throw new Error("“" + file.name + "”有密码保护，先去掉密码再来");
    throw new Error("“" + file.name + "”读不出来，可能不是 PDF 或文件坏了");
  }
}
const pdfBlob = bytes => new Blob([bytes], { type: "application/pdf" });
const busy = (btn, st, fn) => async () => {
  btn.disabled = true;
  try { await fn(); } catch (e) { TB.say(st, e.message || "出错了", true); }
  btn.disabled = false;
};

T["pdf-merge"] = body => {
  const st = TB.status(), go = h("button", { type: "button", class: "pri", disabled: true }, "合并");
  const ord = TB.order(f => f.name + "（" + L.size(f.size) + "）", items => { go.disabled = items.length < 2; });
  const pick = TB.picker({ label: "选 PDF", multiple: true, accept: "application/pdf,.pdf", hint: "可以分几次添加，按列表顺序合并", onfiles: fs => { ord.set(ord.items.concat(fs)); TB.say(st, ""); } });
  go.addEventListener("click", busy(go, st, async () => {
    const P = await lib(st), outDoc = await P.PDFDocument.create();
    let n = 0;
    for (const f of ord.items) {
      TB.say(st, "读 " + f.name + "…");
      const src = await open(f), pages = await outDoc.copyPages(src, src.getPageIndices());
      pages.forEach(p => outDoc.addPage(p)); n += pages.length;
    }
    TB.say(st, "生成中…");
    const bytes = await outDoc.save();
    TB.save(pdfBlob(bytes), "合并.pdf");
    TB.say(st, "合成了 " + n + " 页，" + L.size(bytes.length) + "。");
  }));
  body.append(pick, ord.el, h("div", { class: "row" }, go), st);
};

T["pdf-split"] = body => {
  let file = null, doc = null;
  const st = TB.status(), info = h("p", { class: "muted" }), go = h("button", { type: "button", class: "pri", disabled: true }, "拆分");
  const ranges = h("input", { type: "text", class: "mono", value: "1-3, 4-", autocomplete: "off", "aria-describedby": "split-hint" });
  ranges.style.width = "100%";
  const mode = TB.select([["each", "每段存一个文件"], ["one", "这些页合成一个文件"], ["pages", "每一页存一个文件"]], "each");
  const pick = TB.picker({ label: "选 PDF", accept: "application/pdf,.pdf", onfiles: async fs => {
    file = fs[0]; doc = null; go.disabled = true;
    try { doc = await open(file); info.textContent = file.name + "，共 " + doc.getPageCount() + " 页"; go.disabled = false; TB.say(st, ""); }
    catch (e) { info.textContent = ""; TB.say(st, e.message, true); }
  } });
  pick.querySelector("button").addEventListener("click", () => lib(st).then(() => TB.say(st, "")).catch(e => TB.say(st, e.message, true)), { once: true });
  go.addEventListener("click", busy(go, st, async () => {
    const P = await lib(st), total = doc.getPageCount(), base = L.base(file.name);
    const groups = mode.value === "pages" ? Array.from({ length: total }, (_, i) => [i + 1, i + 1]) : parseRanges(ranges.value, total);
    const sets = mode.value === "one" ? [groups.reduce((a, r) => a.concat(expand(r)), [])] : groups.map(expand);
    const outs = [];
    for (let i = 0; i < sets.length; i++) {
      TB.say(st, "生成第 " + (i + 1) + " / " + sets.length + " 个…");
      const d = await P.PDFDocument.create(), pages = await d.copyPages(doc, sets[i].map(p => p - 1));
      pages.forEach(p => d.addPage(p));
      const label = mode.value === "one" ? "选页" : sets[i].length === 1 ? "第" + sets[i][0] + "页" : "第" + sets[i][0] + "-" + sets[i][sets[i].length - 1] + "页";
      outs.push({ name: base + "-" + label + ".pdf", data: await d.save() });
    }
    if (outs.length === 1) TB.save(pdfBlob(outs[0].data), outs[0].name);
    else TB.save(TB.zipBlob(outs), base + "-拆分.zip");
    TB.say(st, outs.length === 1 ? "好了。" : "拆成 " + outs.length + " 个文件，打包成了 zip。");
  }));
  body.append(pick, info, TB.field("要哪些页", ranges), h("p", { id: "split-hint", class: "hint" }, "用逗号分开，例如 1-3, 5, 8-（8- 是第 8 页到最后）；写 5-3 会倒过来。"), h("div", { class: "row" }, mode, go), st);
};

T["pdf-pages"] = body => {
  let file = null, doc = null, pages = [];
  const st = TB.status(), info = h("p", { class: "muted" }), list = h("ul", { class: "list" }), go = h("button", { type: "button", class: "pri", disabled: true }, "保存新 PDF");
  const tools = h("div", { class: "row", hidden: true },
    h("button", { type: "button", onclick: () => { pages.forEach(p => { p.rot = (p.rot + 90) % 360; }); draw(); } }, "全部转 90°"),
    h("button", { type: "button", onclick: () => { pages.reverse(); draw(); } }, "倒序"),
    h("button", { type: "button", onclick: () => { pages = fresh(); draw(); } }, "还原"));
  const fresh = () => Array.from({ length: doc.getPageCount() }, (_, i) => ({ i, rot: 0, base: doc.getPage(i).getRotation().angle }));
  const move = (k, d, kind) => { pages.splice(k + d, 0, pages.splice(k, 1)[0]); draw(kind + (k + d)); };
  const draw = (focus) => {
    list.replaceChildren.apply(list, pages.map((p, k) => {
      const name = "原第 " + (p.i + 1) + " 页";
      return h("li", null, h("span", { class: "nm" }, (k + 1) + ". " + name, p.rot ? h("small", null, "顺时针转 " + p.rot + "°") : null),
        h("button", { type: "button", class: "sm", "aria-label": "顺时针转 90 度 " + name, "data-k": "r" + k, onclick: () => { p.rot = (p.rot + 90) % 360; draw("r" + k); } }, "转 90°"),
        h("button", { type: "button", class: "sm", disabled: k === 0, "aria-label": "上移 " + name, "data-k": "u" + k, onclick: () => move(k, -1, "u") }, "上移"),
        h("button", { type: "button", class: "sm", disabled: k === pages.length - 1, "aria-label": "下移 " + name, "data-k": "d" + k, onclick: () => move(k, 1, "d") }, "下移"),
        h("button", { type: "button", class: "sm", "aria-label": "删除 " + name, "data-k": "x" + k, onclick: () => { pages.splice(k, 1); draw("x" + Math.min(k, pages.length - 1)); } }, "删除"));
    }));
    go.disabled = !pages.length;
    info.textContent = file ? file.name + "，原来 " + doc.getPageCount() + " 页，现在 " + pages.length + " 页" : "";
    if (focus) { let b = list.querySelector('[data-k="' + focus + '"]'); if (b && b.disabled) b = list.querySelector('[data-k="' + (focus[0] === "u" ? "d" : "u") + focus.slice(1) + '"]'); if (b) b.focus(); else if (!pages.length) pick.querySelector("button").focus(); }
  };
  const pick = TB.picker({ label: "选 PDF", accept: "application/pdf,.pdf", onfiles: async fs => {
    try {
      TB.say(st, "读取中…");
      file = fs[0]; doc = await open(file);
      pages = fresh();
      tools.hidden = false; draw(); TB.say(st, pages.length > 300 ? "页数很多，列表会很长。" : "");
    } catch (e) { TB.say(st, e.message, true); }
  } });
  go.addEventListener("click", busy(go, st, async () => {
    const P = await lib(st), d = await P.PDFDocument.create(), copied = await d.copyPages(doc, pages.map(p => p.i));
    copied.forEach((pg, k) => { const p = pages[k]; if (p.rot) pg.setRotation(P.degrees((p.base + p.rot) % 360)); d.addPage(pg); });
    const bytes = await d.save();
    TB.save(pdfBlob(bytes), L.base(file.name) + "-调整.pdf");
    TB.say(st, "好了，" + pages.length + " 页。");
  }));
  body.append(h("p", { class: "hint" }, "这里不显示页面缩略图，按原来的页码操作。"), pick, info, tools, list, h("div", { class: "row" }, go), st);
};

T["img-pdf"] = body => {
  const st = TB.status(), go = h("button", { type: "button", class: "pri", disabled: true }, "生成 PDF");
  const size = TB.select([["a4auto", "A4，横图自动横放"], ["a4", "A4 竖版"], ["image", "和图片一样大"]], "a4auto");
  const margin = TB.select([["0", "不留边"], ["10", "窄边 10 毫米"], ["20", "宽边 20 毫米"]], "10");
  const ord = TB.order(f => f.name + "（" + L.size(f.size) + "）", items => { go.disabled = !items.length; });
  const pick = TB.picker({ label: "选图片", multiple: true, accept: "image/*", hint: "一张图一页，按列表顺序", onfiles: fs => { ord.set(ord.items.concat(fs)); lib().catch(() => {}); } });
  go.addEventListener("click", busy(go, st, async () => {
    const P = await lib(st), d = await P.PDFDocument.create();
    for (let i = 0; i < ord.items.length; i++) {
      const f = ord.items[i];
      TB.say(st, "放第 " + (i + 1) + " / " + ord.items.length + " 张…");
      const head = await TB.exifOf(f).catch(() => null);
      let img;
      if (f.type === "image/jpeg" && head && head.orientation === 1) img = await d.embedJpg(await f.arrayBuffer());
      else if (f.type === "image/png") img = await d.embedPng(await f.arrayBuffer());
      else { const r = await TB.encode(f, { type: "image/jpeg", quality: 0.92, maxSide: 0 }); img = await d.embedJpg(await r.blob.arrayBuffer()); }
      const p = placeImage(img.width, img.height, size.value, Number(margin.value));
      d.addPage([p.pw, p.ph]).drawImage(img, { x: p.x, y: p.y, width: p.w, height: p.h });
    }
    const bytes = await d.save();
    TB.save(pdfBlob(bytes), "图片.pdf");
    TB.say(st, "好了，" + ord.items.length + " 页，" + L.size(bytes.length) + "。");
  }));
  body.append(pick, ord.el, h("div", { class: "row" }, TB.field("页面", size), TB.field("边距", margin)), h("div", { class: "row" }, go), st);
};
})();
`;

export const QR_JS = String.raw`(function () {
"use strict";
const TB = self.TB, L = TB.lib;

// ---------- QR code encoder (ISO/IEC 18004: numeric, alphanumeric and byte modes, versions 1-40) ----------
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const mul = (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0;
function rsGen(n) {
  let g = [1];
  for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; }
  return g;
}
function rsEc(data, n) {
  const g = rsGen(n), r = new Array(n).fill(0);
  for (const d of data) { const f = d ^ r.shift(); r.push(0); for (let j = 0; j < n; j++) r[j] ^= mul(g[j + 1], f); }
  return r;
}
// Error-correction codewords per block and number of blocks, indexed [level L,M,Q,H][version].
const ECC = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const LEVELS = { L: 0, M: 1, Q: 2, H: 3 }, FORMAT = [1, 0, 3, 2];
function rawModules(v) {
  let r = (16 * v + 128) * v + 64;
  if (v >= 2) { const n = Math.floor(v / 7) + 2; r -= (25 * n - 10) * n - 55; if (v >= 7) r -= 36; }
  return r;
}
const dataCodewords = (v, e) => Math.floor(rawModules(v) / 8) - ECC[e][v] * BLOCKS[e][v];
function alignPos(v) {
  if (v === 1) return [];
  const n = Math.floor(v / 7) + 2, step = Math.floor((v * 8 + n * 3 + 5) / (n * 4 - 4)) * 2, out = [6];
  for (let p = v * 4 + 10; out.length < n; p -= step) out.splice(1, 0, p);
  return out;
}
const ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
function segment(text) {
  if (/^[0-9]*$/.test(text)) return { mode: 1, count: text.length, bits: numBits(text), cc: [10, 12, 14] };
  if (/^[0-9A-Z $%*+\-.\/:]*$/.test(text)) return { mode: 2, count: text.length, bits: alnumBits(text), cc: [9, 11, 13] };
  const bytes = new TextEncoder().encode(text), bits = [];
  bytes.forEach(b => push(bits, b, 8));
  return { mode: 4, count: bytes.length, bits, cc: [8, 16, 16] };
}
function push(bits, val, len) { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
function numBits(t) { const b = []; for (let i = 0; i < t.length; i += 3) { const c = t.substr(i, 3); push(b, +c, c.length * 3 + 1); } return b; }
function alnumBits(t) { const b = []; for (let i = 0; i < t.length; i += 2) { if (i + 1 < t.length) push(b, ALNUM.indexOf(t[i]) * 45 + ALNUM.indexOf(t[i + 1]), 11); else push(b, ALNUM.indexOf(t[i]), 6); } return b; }
const ccIndex = v => v <= 9 ? 0 : v <= 26 ? 1 : 2;
function segBits(seg, v) { return 4 + seg.cc[ccIndex(v)] + seg.bits.length; }
// The data plus error-correction codewords, interleaved, for one version and level.
function codewords(seg, v, e) {
  const cap = dataCodewords(v, e) * 8, bits = [];
  push(bits, seg.mode, 4); push(bits, seg.count, seg.cc[ccIndex(v)]);
  seg.bits.forEach(b => bits.push(b));
  for (let i = 0; i < 4 && bits.length < cap; i++) bits.push(0);
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) { let x = 0; for (let j = 0; j < 8; j++) x = (x << 1) | bits[i + j]; data.push(x); }
  for (let pad = 0xEC; data.length < cap / 8; pad ^= 0xEC ^ 0x11) data.push(pad);
  const nb = BLOCKS[e][v], el = ECC[e][v], raw = Math.floor(rawModules(v) / 8), short = nb - raw % nb, slen = Math.floor(raw / nb);
  const blocks = [];
  for (let i = 0, k = 0; i < nb; i++) { const len = slen - el + (i < short ? 0 : 1), d = data.slice(k, k + len); k += len; blocks.push({ d, e: rsEc(d, el) }); }
  const out = [];
  for (let i = 0; i <= slen - el; i++) blocks.forEach(b => { if (i < b.d.length) out.push(b.d[i]); });
  for (let i = 0; i < el; i++) blocks.forEach(b => out.push(b.e[i]));
  return { data, out };
}
function formatBits(e, mask) {
  const d = (FORMAT[e] << 3) | mask;
  let r = d;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((d << 10) | r) ^ 0x5412;
}
function versionBits(v) {
  let r = v;
  for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
  return (v << 12) | r;
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
  (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0,
];
function build(v, e, cw, mask) {
  const n = v * 4 + 17, m = [], fn = [];
  for (let y = 0; y < n; y++) { m.push(new Uint8Array(n)); fn.push(new Uint8Array(n)); }
  const set = (x, y, dark) => { m[y][x] = dark ? 1 : 0; fn[y][x] = 1; };
  for (let i = 0; i < n; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy)); if (x >= 0 && x < n && y >= 0 && y < n) set(x, y, d !== 2 && d !== 4); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  const al = alignPos(v);
  al.forEach((ax, i) => al.forEach((ay, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const fmt = bits => {
    const b = i => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i));
    set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(n - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) set(8, n - 15 + i, b(i));
    set(8, n - 8, 1);
  };
  fmt(0);
  if (v >= 7) { const vb = versionBits(v); for (let i = 0; i < 18; i++) { const bit = (vb >>> i) & 1, a = n - 11 + i % 3, b = Math.floor(i / 3); set(a, b, bit); set(b, a, bit); } }
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? n - 1 - vert : vert;
      if (!fn[y][x] && i < cw.length * 8) { m[y][x] = (cw[i >>> 3] >>> (7 - (i & 7))) & 1; i++; }
    }
  }
  const apply = k => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fn[y][x] && MASKS[k](x, y)) m[y][x] ^= 1; };
  let best = mask;
  if (best < 0) {
    let low = Infinity;
    for (let k = 0; k < 8; k++) { apply(k); fmt(formatBits(e, k)); const p = penalty(m); if (p < low) { low = p; best = k; } apply(k); }
  }
  apply(best); fmt(formatBits(e, best));
  return { size: n, version: v, level: "LMQH"[e], mask: best, modules: m, fn };
}
function penalty(m) {
  const n = m.length;
  let p = 0, dark = 0;
  const line = get => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) run++;
      else { if (run >= 5) p += 3 + run - 5; run = 1; }
    }
    // 1:1:3:1:1 finder look-alikes with four light modules on one side (outside the symbol counts as light).
    for (let i = -4; i < n; i++) {
      const at = k => (k < 0 || k >= n) ? 0 : get(k);
      if (at(i) && !at(i + 1) && at(i + 2) && at(i + 3) && at(i + 4) && !at(i + 5) && at(i + 6)) {
        const before = !at(i - 1) && !at(i - 2) && !at(i - 3) && !at(i - 4), after = !at(i + 7) && !at(i + 8) && !at(i + 9) && !at(i + 10);
        if (before || after) p += 40;
      }
    }
  };
  for (let y = 0; y < n; y++) line(x => m[y][x]);
  for (let x = 0; x < n; x++) line(y => m[y][x]);
  for (let y = 0; y < n - 1; y++) for (let x = 0; x < n - 1; x++) { const c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) dark += m[y][x];
  p += (Math.ceil(Math.abs(dark * 20 - n * n * 10) / (n * n)) - 1) * 10;
  return p;
}
function encode(text, level, opts) {
  opts = opts || {};
  const e = LEVELS[level || "M"], seg = segment(String(text));
  for (let v = opts.minVersion || 1; v <= 40; v++) {
    if (seg.count >= 1 << seg.cc[ccIndex(v)]) continue;
    if (segBits(seg, v) <= dataCodewords(v, e) * 8) {
      if (opts.version && v !== opts.version) continue;
      const c = codewords(seg, v, e);
      const q = build(v, e, c.out, opts.mask == null ? -1 : opts.mask);
      q.dataBytes = Math.ceil(segBits(seg, v) / 8); q.capacity = dataCodewords(v, e); q.mode = seg.mode;
      return q;
    }
  }
  return null;
}
function toSvg(q, margin) {
  const n = q.size + margin * 2;
  let d = "";
  for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) {
    if (!q.modules[y][x]) continue;
    let w = 1; while (x + w < q.size && q.modules[y][x + w]) w++;
    d += "M" + (x + margin) + " " + (y + margin) + "h" + w + "v1h-" + w + "z"; x += w - 1;
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + " " + n + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
}
L.qr = { encode, codewords, segment, formatBits, versionBits, alignPos, rawModules, dataCodewords, rsEc, toSvg, penalty };

if (typeof document === "undefined") return;
const h = TB.h, T = TB.tools;

T["qr-make"] = body => {
  const ta = TB.area({ "aria-label": "二维码内容", class: "prose", placeholder: "网址、文字、Wi-Fi 信息……" });
  ta.style.minHeight = "5rem";
  const lv = TB.select([["L", "容错低（码最小）"], ["M", "容错中"], ["Q", "容错较高"], ["H", "容错高（可以盖住一角）"]], "M");
  const cv = h("canvas", { role: "img", "aria-label": "生成的二维码" }), st = TB.status(), side = h("div");
  let q = null;
  const draw = () => {
    q = ta.value ? encode(ta.value, lv.value) : null;
    side.hidden = !q;
    if (!ta.value) { cv.width = cv.height = 0; return TB.say(st, ""); }
    if (!q) { cv.width = cv.height = 0; return TB.say(st, "太长了，换低一点的容错或者缩短内容（现在 " + new TextEncoder().encode(ta.value).length + " 字节）。", true); }
    const margin = 4, scale = Math.max(4, Math.floor(600 / (q.size + margin * 2))), px = (q.size + margin * 2) * scale;
    cv.width = cv.height = px;
    const g = cv.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, px, px); g.fillStyle = "#000";
    for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.modules[y][x]) g.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
    TB.say(st, "版本 " + q.version + "，" + q.size + "×" + q.size + " 格，用了 " + q.dataBytes + " / " + q.capacity + " 字节。");
  };
  ta.addEventListener("input", TB.debounce(draw, 120));
  lv.addEventListener("change", draw);
  side.append(h("div", { class: "row" },
    h("button", { type: "button", onclick: () => cv.toBlob(b => TB.save(b, "二维码.png"), "image/png") }, "下载 PNG"),
    h("button", { type: "button", onclick: () => TB.save(new Blob([toSvg(q, 4)], { type: "image/svg+xml" }), "二维码.svg") }, "下载 SVG")));
  body.append(ta, h("div", { class: "row" }, TB.field("容错", lv)), st, h("div", { class: "qr" }, cv, side));
  draw();
};

T["qr-read"] = body => {
  const st = TB.status(), res = h("div");
  if (!("BarcodeDetector" in self)) {
    body.append(h("p", null, "这个浏览器不支持识别二维码。安卓上的 Chrome、电脑上的 Chrome 和 Edge 可以；iPhone 上可以直接用相机或微信扫。"));
    return;
  }
  const pick = TB.picker({ label: "选图片或拍照", accept: "image/*", multiple: true, hint: "截图也行", onfiles: async fs => {
    res.replaceChildren();
    let found = 0;
    const det = new BarcodeDetector({ formats: ["qr_code"] });
    for (const f of fs) {
      try {
        const bmp = await TB.decodeImage(f), codes = await det.detect(bmp);
        if (bmp.close) bmp.close();
        if (!codes.length) { res.append(h("p", { class: "muted" }, f.name + "：没找到二维码")); continue; }
        codes.forEach(c => {
          found++;
          const v = c.rawValue, isUrl = /^https?:\/\/\S+$/i.test(v);
          res.append(h("div", { class: "ab" }, h("p", null, f.name), h("pre", { class: "out" }, v),
            h("div", { class: "row" }, TB.copyBtn(v), isUrl ? h("a", { href: v, rel: "noopener noreferrer", target: "_blank" }, "打开链接") : null)));
        });
      } catch (e) { res.append(h("p", { class: "err" }, f.name + "：" + (e.message || "读不出来"))); }
    }
    TB.say(st, found ? "找到 " + found + " 个。" : "");
  } });
  body.append(pick, st, res);
};
TB.decodeImage = f => self.createImageBitmap ? createImageBitmap(f) : Promise.reject(new Error("浏览器不支持"));
})();
`;
