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
.foot{margin-top:40px;color:var(--mute);font-size:13px}
.back{display:inline-block;margin-top:8px;font-size:15px}
button,.btn{font:inherit;font-size:15px;line-height:1.3;padding:8px 14px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;min-height:38px}
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
        h("button", { type: "button", class: "sm", "aria-label": "移除 " + name, onclick: () => { self.items.splice(i, 1); draw(); } }, "移除")));
    });
    if (focus) { const b = ul.querySelector('[data-k="' + focus + '"]'); if (b && !b.disabled) b.focus(); else { const o = ul.querySelector('[data-k="' + (focus[0] === "u" ? "d" : "u") + focus.slice(1) + '"]'); if (o) o.focus(); } }
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
