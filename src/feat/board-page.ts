// Browser-side source of the team board (src/feat/board.ts serves it). The page is the same for every
// visitor; everything personal comes from /x/board/api/ after it loads. Kept in String.raw literals, so the
// browser code must not contain backticks or "${". Data only ever reaches the DOM as text nodes.

export const CSS = String.raw`
:root{--bg:#fbfbf9;--fg:#1d1d1b;--mute:#6b6b66;--line:#dcdcd6;--soft:#f0f0eb;--acc:#2d6a5a;--acc-fg:#fff;--bad:#a33a2a;--warn:#8a6414;--mark:#f3e3a6;
--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Noto Sans SC",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#171716;--fg:#e6e6e1;--mute:#9a9a93;--line:#34342f;--soft:#21211f;--acc:#7cc2ab;--acc-fg:#10201b;--bad:#f08f7c;--warn:#e0b45a;--mark:#5c4f1e}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 var(--sans)}
a{color:var(--acc)}
.wrap{max-width:46rem;margin:0 auto;padding:0 16px 64px}
header.top{max-width:46rem;margin:0 auto;padding:18px 16px 6px;display:flex;align-items:center;gap:12px}
header.top .home{color:var(--fg);text-decoration:none;font-weight:600;font-size:18px}
header.top #who{flex:1;color:var(--mute);font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
nav.tabs{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);display:flex;gap:4px;overflow-x:auto;scrollbar-width:none;padding:0 max(8px,calc((100% - 46rem)/2 + 8px))}
nav.tabs::-webkit-scrollbar{display:none}
nav.tabs a{flex:none;padding:10px 8px;color:var(--mute);text-decoration:none;font-size:15px;border-bottom:2px solid transparent;margin-bottom:-1px}
nav.tabs a[aria-current]{color:var(--fg);border-bottom-color:var(--acc)}
h2{font-size:15px;font-weight:600;margin:28px 0 8px;color:var(--mute);letter-spacing:.02em}
h3{font-size:16px;font-weight:600;margin:0}
p{margin:0 0 10px}
.body{padding-top:14px}
.body>h2:first-child{margin-top:4px}
.vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.muted,.meta{color:var(--mute)}
.meta{font-size:14px}
.err{color:var(--bad)}
.status{min-height:1.4em;color:var(--mute);font-size:14px;margin:12px 0}
.status.err{color:var(--bad)}
button,.btn{font:inherit;font-size:15px;line-height:1.3;white-space:nowrap;padding:7px 13px;border-radius:6px;border:1px solid var(--line);background:var(--bg);color:var(--fg);cursor:pointer;min-height:36px;text-decoration:none;display:inline-flex;align-items:center}
button:hover,.btn:hover{border-color:var(--mute)}
button.pri{background:var(--acc);border-color:var(--acc);color:var(--acc-fg)}
button.sm,.btn.sm{padding:3px 10px;font-size:13px;min-height:28px}
button.link{border:0;background:none;color:var(--acc);padding:4px 0;min-height:0}
button:disabled{opacity:.5;cursor:default}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
input,select,textarea{font:inherit;font-size:16px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;max-width:100%;width:100%}
textarea{min-height:5rem;resize:vertical;line-height:1.5}
.row{display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;margin:10px 0}
.field{display:flex;flex-direction:column;gap:4px;margin:0 0 10px}
.field>span{font-size:14px;color:var(--mute)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.list>li{padding:10px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.list>li .meta{display:block}
.empty{color:var(--mute);font-size:15px;padding:10px 0}
.day h3{font-size:15px}
.day p{white-space:pre-wrap;margin:2px 0 0}
.task>button.t{all:unset;display:block;width:100%;cursor:pointer}
.task>button.t:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.task .tt{font-weight:500}
.task.done .tt,.task.dropped .tt{color:var(--mute)}
.task.dropped .tt{text-decoration:line-through}
.late{color:var(--bad)}
.panel{margin:10px 0 4px;padding:12px;background:var(--soft);border-radius:8px}
.panel .pre{white-space:pre-wrap;margin:0 0 10px}
.notes{list-style:none;margin:6px 0 10px;padding:0;font-size:15px}
.notes li{padding:4px 0;border-bottom:1px solid var(--line)}
.notes li:last-child{border-bottom:0}
.ai{border-top:1px solid var(--line);margin-top:12px;padding-top:10px}
code,.code{font-family:var(--mono);font-size:13px;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:8px 10px;display:block;white-space:pre-wrap;overflow-wrap:anywhere}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px}
.chips button[aria-pressed=true]{border-color:var(--acc);color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}
@media (min-width:640px){.grid{grid-template-columns:repeat(5,minmax(0,1fr))}}
.grid button{all:unset;cursor:pointer;display:block;min-width:0}
.grid .box{aspect-ratio:1;background:var(--soft);border-radius:6px;overflow:hidden}
.grid img{width:100%;height:100%;object-fit:cover;display:block}
.grid small{display:block;font-size:12px;color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.grid button:focus-visible .box{outline:2px solid var(--acc);outline-offset:2px}
dialog{border:0;padding:0;max-width:min(92vw,60rem);background:var(--bg);color:var(--fg);border-radius:8px}
dialog::backdrop{background:rgba(0,0,0,.6)}
dialog figure{margin:0}
dialog img{display:block;width:100%;max-height:70vh;object-fit:contain;margin:0 auto;background:var(--soft)}
dialog figcaption{padding:10px 14px 0;font-size:15px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:20vh;overflow:auto}
dialog .row{padding:0 14px 12px;justify-content:flex-end}
.ok{color:var(--acc)}
.repo{padding:12px 0;border-bottom:1px solid var(--line)}
.repo:first-of-type{border-top:1px solid var(--line)}
.repo h3{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.repo h3 span{font-weight:400;font-size:14px}
.steps{list-style:none;margin:6px 0;padding:0;font-size:14px}
.steps li{display:flex;gap:8px}
.steps li b{font-weight:500;min-width:3em}
pre.tail{font-family:var(--mono);font-size:12px;background:var(--soft);border-radius:6px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0;max-height:14rem;overflow:auto}
.mem h3{font-size:15px;margin:18px 0 4px;color:var(--mute);font-weight:600}
.mem p{margin:0 0 4px;font-size:15px}
mark{background:var(--mark);color:inherit;border-radius:2px}
progress{width:100%;height:6px;appearance:none;-webkit-appearance:none;border:0;border-radius:3px;background:var(--soft);overflow:hidden;display:block;margin:4px 0 2px}
progress::-webkit-progress-bar{background:var(--soft)}
progress::-webkit-progress-value{background:var(--acc)}
progress::-moz-progress-bar{background:var(--acc)}
progress.hot::-webkit-progress-value{background:var(--bad)}
progress.hot::-moz-progress-bar{background:var(--bad)}
.big{font-size:22px;font-weight:600}
.ab{padding:10px 0;border-bottom:1px solid var(--line)}
.ab p{color:var(--mute);font-size:15px;margin:2px 0 4px}
.ab ul{list-style:none;margin:0;padding:0}
.ab li{display:flex;gap:10px;align-items:center;padding:2px 0;font-size:15px}
.ab li span{flex:1;min-width:0}
`;

export const APP_JS = String.raw`(function () {
"use strict";
var API = "/x/board/api/";
var $ = function (id) { return document.getElementById(id); };
var me = { name: "", people: [] };
var loaded = {};

function h(tag, props) {
  var el = document.createElement(tag), i, k, c;
  props = props || {};
  for (k in props) {
    var v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (i = 2; i < arguments.length; i++) {
    c = arguments[i];
    if (c === undefined || c === null || c === false) continue;
    if (Array.isArray(c)) c.forEach(function (x) { if (x) el.appendChild(typeof x === "string" ? document.createTextNode(x) : x); });
    else el.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  }
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function say(t, bad) { var s = $("status"); s.textContent = t || ""; s.className = "status" + (bad ? " err" : ""); }

function gone() {
  document.body.textContent = "";
  document.body.appendChild(h("main", { class: "wrap" }, h("p", { class: "status", text: "" }), h("p", { text: "这个看板只给群友看。在群里对 Bot 说“给我看板链接”，点它发来的链接就能进来。" })));
}
function api(path, body) {
  var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(API + path, init).then(function (r) {
    if (r.status === 401) { gone(); throw new Error("401"); }
    return r.json().catch(function () { return { ok: false, error: "服务器没回好，稍后再试" }; }).then(function (j) {
      if (!j.ok) throw new Error(j.error || "出错了");
      return j;
    });
  });
}
function fail(e) { if (e && e.message !== "401") say(e.message || "出错了", true); }

var WEEK = "日一二三四五六";
function pad(n) { return (n < 10 ? "0" : "") + n; }
function when(ts) {
  if (!ts) return "";
  var d = new Date(ts), now = new Date(), s = (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad(d.getHours()) + ":" + pad(d.getMinutes());
  return d.getFullYear() === now.getFullYear() ? s : d.getFullYear() + "年" + s;
}
function ago(ts) {
  if (!ts) return "还没有";
  var m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  if (m < 1440) return Math.round(m / 60) + " 小时前";
  return when(ts);
}
function dayTitle(s) {
  var p = s.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]);
  return (+p[1]) + "月" + (+p[2]) + "日 周" + WEEK.charAt(d.getDay());
}
function today() { var d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }

function copy(text, btn) {
  function done(ok) { if (btn) { var t = btn.textContent; btn.textContent = ok ? "已复制" : "复制失败"; setTimeout(function () { btn.textContent = t; }, 1500); } }
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacy()); });
  done(legacy());
  function legacy() {
    var ta = h("textarea", { readonly: true, class: "vh" }); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); return ok;
  }
}
function copyBtn(text, label) { var b = h("button", { type: "button", class: "sm" }, label || "复制"); b.addEventListener("click", function () { copy(typeof text === "function" ? text() : text, b); }); return b; }
function empty(t) { return h("p", { class: "empty", text: t }); }
function body(id) { return document.querySelector("#s-" + id + " .body"); }

// ---------- 动态 ----------
function feed(root) {
  var list = h("ul", { class: "list" }), more = h("button", { type: "button", hidden: true }, "更早的");
  clear(root).appendChild(h("p", { class: "meta", text: "每天夜里 Bot 把当天的群聊整理成一段小结。" }));
  root.appendChild(list); root.appendChild(h("div", { class: "row" }, more));
  var last = "";
  function page(n) {
    more.disabled = true;
    return api("days?n=" + n + (last ? "&before=" + last : "")).then(function (j) {
      if (!j.days.length && !last) list.replaceWith(empty("还没有整理过的日子。"));
      j.days.forEach(function (d) { list.appendChild(h("li", { class: "day" }, h("h3", { text: dayTitle(d.date) }), h("p", { text: d.summary }))); last = d.date; });
      more.hidden = !j.more; more.disabled = false;
    });
  }
  more.addEventListener("click", function () { page(14).catch(fail); });
  return page(7);
}

// ---------- 任务 ----------
var STATUS = { open: "待办", doing: "在做", done: "完成了", dropped: "放弃了" };
function taskForm(t, onSave) {
  var f = {
    title: h("input", { maxlength: 200, required: true, value: t ? t.title : "" }),
    detail: h("textarea", { maxlength: 4000 }),
    owner: h("input", { maxlength: 40, list: "people", value: t ? t.owner : "", placeholder: "名字，或者 bot" }),
    due: h("input", { type: "date", value: t ? t.due : "" }),
  };
  f.detail.value = t ? t.detail : "";
  if (t) { f.result = h("textarea", { maxlength: 4000 }); f.result.value = t.result || ""; }
  var save = h("button", { type: "submit", class: "pri" }, t ? "保存" : "加上"), cancel = h("button", { type: "button" }, "取消");
  var form = h("form", { class: "panel" },
    h("label", { class: "field" }, h("span", { text: "要做什么" }), f.title),
    h("label", { class: "field" }, h("span", { text: "说明" }), f.detail),
    h("div", { class: "two" }, h("label", { class: "field" }, h("span", { text: "谁来做" }), f.owner), h("label", { class: "field" }, h("span", { text: "截止" }), f.due)),
    f.result ? h("label", { class: "field" }, h("span", { text: "交付了什么" }), f.result) : null,
    h("div", { class: "row" }, save, cancel));
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = { title: f.title.value.trim(), detail: f.detail.value.trim(), owner: f.owner.value.trim(), due: f.due.value };
    if (f.result) v.result = f.result.value.trim();
    if (!v.title) { f.title.focus(); return; }
    save.disabled = true;
    onSave(v).then(function () { form.remove(); }, function (e) { save.disabled = false; fail(e); });
  });
  cancel.addEventListener("click", function () { form.remove(); });
  return form;
}
function due(t) {
  if (!t.due) return "";
  var late = t.due < today() && (t.status === "open" || t.status === "doing");
  return h("span", { class: late ? "late" : "", text: "截止 " + t.due.slice(5).replace("-", "月") + "日" + (late ? "，已过" : "") });
}
function joinMeta(parts) {
  var out = h("span", { class: "meta" });
  parts.filter(Boolean).forEach(function (p, i) { if (i) out.appendChild(document.createTextNode(" · ")); out.appendChild(typeof p === "string" ? document.createTextNode(p) : p); });
  return out;
}
function taskItem(t, refresh) {
  var li = h("li", { class: "task " + t.status }), panel = null;
  var head = h("button", { type: "button", class: "t", "aria-expanded": "false" },
    h("span", { class: "tt", text: "#" + t.id + " " + t.title }),
    joinMeta([t.status === "doing" && t.claimed_by ? t.claimed_by + " 在做" : t.owner ? "交给 " + t.owner : "还没人认领", due(t), t.source ? "来自 " + t.source : ""]));
  li.appendChild(head);
  head.addEventListener("click", function () {
    if (panel) { panel.remove(); panel = null; head.setAttribute("aria-expanded", "false"); return; }
    head.setAttribute("aria-expanded", "true");
    panel = h("div", { class: "panel" }, h("p", { class: "meta", text: "载入中" }));
    li.appendChild(panel);
    api("tasks/" + t.id).then(function (j) { if (panel) detail(panel, j, refresh); }).catch(fail);
  });
  return li;
}
function detail(panel, j, refresh) {
  var t = j.task;
  clear(panel);
  if (t.detail) panel.appendChild(h("p", { class: "pre", text: t.detail }));
  if (t.result) panel.appendChild(h("p", { class: "pre" }, h("b", { text: "交付：" }), t.result));
  panel.appendChild(h("p", { class: "meta", text: [STATUS[t.status], t.by ? t.by + " 在 " + when(t.created) + " 加的" : "加于 " + when(t.created), t.claimed_by ? t.claimed_by + " 领了" : "", t.source ? "来自：" + t.source : ""].filter(Boolean).join(" · ") }));
  var notes = h("ul", { class: "notes" });
  function showNotes(ns) { clear(notes); ns.forEach(function (n) { notes.appendChild(h("li", {}, h("span", { class: "meta", text: n.who + " · " + when(n.ts) + "　" }), n.text)); }); }
  showNotes(j.notes || []);
  panel.appendChild(notes);

  function act(label, change, pri) {
    var b = h("button", { type: "button", class: "sm" + (pri ? " pri" : "") }, label);
    b.addEventListener("click", function () { b.disabled = true; change().then(refresh, function (e) { b.disabled = false; fail(e); }); });
    return b;
  }
  var set = function (s) { return function () { return api("tasks/" + t.id, { status: s }); }; };
  var acts = h("div", { class: "row" });
  if (t.status === "open") acts.appendChild(act("我来做", function () { return api("tasks/" + t.id + "/claim", {}); }, true));
  if (t.status === "open" || t.status === "doing") { acts.appendChild(act("完成了", set("done"), t.status === "doing")); acts.appendChild(act("放弃", set("dropped"))); }
  else acts.appendChild(act("重新打开", set("open")));
  var edit = h("button", { type: "button", class: "sm" }, "改");
  edit.addEventListener("click", function () {
    if (panel.querySelector("form.panel")) return;
    panel.insertBefore(taskForm(t, function (v) { return api("tasks/" + t.id, v).then(refresh); }), acts.nextSibling);
  });
  acts.appendChild(edit);
  panel.appendChild(acts);

  var note = h("textarea", { maxlength: 2000, placeholder: "进展、问题、链接" }), add = h("button", { type: "submit", class: "sm" }, "记一笔");
  var nf = h("form", {}, h("label", { class: "field" }, h("span", { text: "写进展" }), note), h("div", { class: "row" }, add));
  nf.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = note.value.trim(); if (!text) return;
    add.disabled = true;
    api("tasks/" + t.id + "/note", { text: text }).then(function (r) { note.value = ""; add.disabled = false; showNotes(r.notes || []); }, function (e) { add.disabled = false; fail(e); });
  });
  panel.appendChild(nf);

  if (t.status === "open" || t.status === "doing") {
    var ai = h("div", { class: "ai" }, h("h3", { text: "交给本地 AI" }), h("p", { class: "meta", text: "把这句话发给你电脑上的 AI 工具（Claude Code 等），它会领走任务，做完交回来。" }));
    ai.appendChild(h("code", { text: j.prompt }));
    ai.appendChild(h("div", { class: "row" }, copyBtn(j.prompt)));
    var how = h("button", { type: "button", class: "link" }, "第一次用：怎么把 AI 工具接上");
    var out = h("div", {});
    how.addEventListener("click", function () {
      if (out.firstChild) { clear(out); return; }
      how.disabled = true;
      api("mcp", {}).then(function (r) {
        how.disabled = false;
        out.appendChild(h("p", { class: "meta", text: "在终端里运行一次（别的工具填同样的地址，类型选 HTTP）。命令里带着你的个人令牌，只在这里复制，不要发到群里。" }));
        r.lines.forEach(function (line) {
          out.appendChild(h("code", { text: line.replace(/[a-f0-9]{40}/, function (k) { return k.slice(0, 4) + "…" + k.slice(-4); }) }));
          out.appendChild(h("div", { class: "row" }, copyBtn(line, "复制命令")));
        });
        if (r.lines.length > 1) out.appendChild(h("p", { class: "meta", text: "第二个走香港镜像，大陆网络连不上第一个就用它。" }));
      }, function (e) { how.disabled = false; fail(e); });
    });
    ai.appendChild(how); ai.appendChild(out);
    panel.appendChild(ai);
  }
}
function tasks(root) {
  clear(root);
  var add = h("button", { type: "button", class: "pri" }, "新任务"), top = h("div", { class: "row" }, add);
  var groups = h("div", {}), oldBox = h("div", {}), showOld = h("button", { type: "button" }, "看已经结束的");
  root.appendChild(top); root.appendChild(groups); root.appendChild(h("div", { class: "row" }, showOld)); root.appendChild(oldBox);
  var dl = h("datalist", { id: "people" }); (me.people.concat(["bot"])).forEach(function (n) { dl.appendChild(h("option", { value: n })); }); root.appendChild(dl);
  var oldN = 0;
  function refresh() { return load().then(function () { if (oldN) return loadOld(oldN); }).catch(fail); }
  add.addEventListener("click", function () {
    if (root.querySelector(":scope > form.panel")) return;
    root.insertBefore(taskForm(null, function (v) { return api("tasks", v).then(refresh); }), groups);
  });
  function load() {
    return api("tasks?status=open,doing&n=200").then(function (j) {
      clear(groups);
      [["doing", "在做"], ["open", "待办"]].forEach(function (g) {
        var ts = j.tasks.filter(function (t) { return t.status === g[0]; });
        groups.appendChild(h("h2", { text: g[1] + (ts.length ? " " + ts.length : "") }));
        if (!ts.length) { groups.appendChild(empty(g[0] === "doing" ? "没有正在做的。" : "没有待办。")); return; }
        ts.sort(function (a, b) { return (a.due || "9") < (b.due || "9") ? -1 : (a.due || "9") > (b.due || "9") ? 1 : b.id - a.id; });
        var ul = h("ul", { class: "list" }); ts.forEach(function (t) { ul.appendChild(taskItem(t, refresh)); }); groups.appendChild(ul);
      });
    });
  }
  function loadOld(n) {
    return api("tasks?status=done,dropped&n=" + n).then(function (j) {
      oldN = n; clear(oldBox);
      oldBox.appendChild(h("h2", { text: "已结束" }));
      if (!j.tasks.length) { oldBox.appendChild(empty("还没有结束的任务。")); showOld.hidden = true; return; }
      var ul = h("ul", { class: "list" }); j.tasks.forEach(function (t) { ul.appendChild(taskItem(t, refresh)); }); oldBox.appendChild(ul);
      showOld.textContent = "再多看一些"; showOld.hidden = !j.more;
    });
  }
  showOld.addEventListener("click", function () { loadOld(oldN + 30).catch(fail); });
  return load();
}

// ---------- 记忆 ----------
function marked(text, q) {
  var out = [], low = text.toLowerCase(), i = 0, j;
  if (!q) return [text];
  while ((j = low.indexOf(q, i)) >= 0) { out.push(text.slice(i, j)); out.push(h("mark", { text: text.slice(j, j + q.length) })); i = j + q.length; }
  out.push(text.slice(i));
  return out;
}
function memory(root) {
  return api("memory").then(function (j) {
    clear(root);
    var q = h("input", { type: "search", placeholder: "在记忆里找", "aria-label": "在记忆里找" }), doc = h("div", { class: "mem" }), count = h("p", { class: "meta" });
    root.appendChild(h("div", { class: "row" }, q)); root.appendChild(count); root.appendChild(doc);
    var lines = (j.memory || "").split("\n"), notes = j.notes || [];
    function draw() {
      var k = q.value.trim().toLowerCase(), head = null, shown = 0;
      clear(doc);
      lines.forEach(function (raw) {
        var line = raw.trim(); if (!line) return;
        var m = /^【([^】]+)】\s*(.*)$/.exec(line);
        if (m) { head = h("h3", { text: m[1] }); if (!k) doc.appendChild(head); else head.dataset.pending = "1"; if (!m[2]) return; line = m[2]; }
        if (k && line.toLowerCase().indexOf(k) < 0) return;
        if (head && head.dataset.pending) { delete head.dataset.pending; doc.appendChild(head); }
        doc.appendChild(h("p", {}, marked(line, k))); shown++;
      });
      if (!lines.join("").trim()) doc.appendChild(empty("还没有长期记忆。"));
      var ns = notes.filter(function (n) { return !k || n.text.toLowerCase().indexOf(k) >= 0; });
      doc.appendChild(h("h3", { text: "最近记下的，还没整理进去" }));
      if (!ns.length) doc.appendChild(empty(k ? "没有对得上的。" : "没有。"));
      ns.forEach(function (n) { doc.appendChild(h("p", {}, h("span", { class: "meta", text: when(n.ts) + "　" }), marked(n.text, k))); shown++; });
      count.textContent = k ? "找到 " + shown + " 条" : "Bot 每天夜里重写一遍这份记忆；这里只能看，要改在群里跟它说。";
    }
    q.addEventListener("input", draw);
    draw();
  });
}

// ---------- 仓库 ----------
function repos(root) {
  return api("repos").then(function (j) {
    clear(root);
    root.appendChild(h("p", { class: "meta", text: "每天夜里自动拉一遍团队仓库，跑测试和检查。" }));
    if (!j.repos.length) { root.appendChild(empty("还没有要检查的仓库。")); return; }
    j.repos.forEach(function (r) {
      var good = r.result && /通过/.test(r.result) && !/没/.test(r.result), badr = r.result && /失败|没通过/.test(r.result);
      var box = h("div", { class: "repo" }, h("h3", {}, r.repo, h("span", { class: good ? "ok" : badr ? "err" : "muted", text: r.result || "" })));
      if (r.checked) box.appendChild(h("p", { class: "meta", text: "查于 " + r.checked + (r.commit ? " · " + r.commit : "") }));
      if (r.problem) box.appendChild(h("p", { class: "err", text: r.problem }));
      if (r.steps && r.steps.length) {
        var ul = h("ul", { class: "steps" });
        r.steps.forEach(function (s) { ul.appendChild(h("li", {}, h("b", { class: s.result === "通过" ? "ok" : s.result === "没跑" ? "muted" : "err", text: s.result }), h("span", { text: s.step + (s.tests ? "：" + s.tests : "") + (s.note ? "（" + s.note + "）" : "") }))); });
        box.appendChild(ul);
      }
      if (r.first_failing_lines && r.first_failing_lines.length) box.appendChild(h("pre", { class: "tail", text: r.first_failing_lines.join("\n") }));
      var c = [];
      if (r.commits_24h) c.push("24 小时 " + r.commits_24h.count + " 次提交");
      if (r.commits_7d) c.push("7 天 " + r.commits_7d.count + " 次" + (r.commits_7d.authors && r.commits_7d.authors.length ? "（" + r.commits_7d.authors.join("，") + "）" : ""));
      if (c.length) box.appendChild(h("p", { class: "meta", text: c.join(" · ") }));
      if (r.changed_since_previous && r.changed_since_previous.length) box.appendChild(h("p", { class: "meta", text: r.changed_since_previous.join("；") }));
      if (r.not_checked) box.appendChild(h("p", { class: "meta", text: r.not_checked }));
      root.appendChild(box);
    });
  });
}

// ---------- 作品和文件 ----------
var KIND = { made: "Bot 画的", chat: "群里发的", named: "角色", sticker: "表情" };
function openPic(p) {
  var d = $("pic"), img = d.querySelector("img"), cap = d.querySelector("figcaption"), a = d.querySelector("a");
  img.src = p.url; img.alt = p.note || p.ref;
  clear(cap).appendChild(h("span", { text: (p.note || "") + (p.name ? "（" + p.name + "）" : "") }));
  cap.appendChild(h("span", { class: "meta", text: "\n" + [p.ref, KIND[p.kind], when(p.ts)].join(" · ") }));
  if (p.how) cap.appendChild(h("span", { class: "meta", text: "\n怎么画的：" + p.how }));
  a.href = p.url;
  if (d.showModal) d.showModal(); else window.open(p.url, "_blank", "noopener");
}
function works(root) {
  clear(root);
  var pics = h("div", {}), files = h("div", {}), sites = h("div", {}), boxEl = h("div", {});
  root.appendChild(h("h2", { text: "图片" })); root.appendChild(pics);
  root.appendChild(h("h2", { text: "文件" })); root.appendChild(files);
  root.appendChild(h("h2", { text: "网页和网站" })); root.appendChild(sites);
  root.appendChild(h("h2", { text: "文件箱" })); root.appendChild(boxEl);

  var kind = "", grid, more, before = 0;
  var chips = h("div", { class: "chips" });
  [["", "全部"], ["made", "Bot 画的"], ["chat", "群里发的"], ["named", "角色和表情"]].forEach(function (c) {
    var b = h("button", { type: "button", class: "sm", "aria-pressed": c[0] === kind ? "true" : "false" }, c[1]);
    b.addEventListener("click", function () { kind = c[0]; chips.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); resetPics(); });
    chips.appendChild(b);
  });
  pics.appendChild(chips);
  function resetPics() {
    if (grid) grid.remove(); if (more) more.parentNode.remove();
    grid = h("div", { class: "grid" }); more = h("button", { type: "button", hidden: true }, "再看 30 张"); before = 0;
    pics.appendChild(grid); pics.appendChild(h("div", { class: "row" }, more));
    more.addEventListener("click", function () { pagePics().catch(fail); });
    return pagePics().catch(fail);
  }
  function pagePics() {
    more.disabled = true;
    return api("images?n=30" + (kind ? "&kind=" + kind : "") + (before ? "&before=" + before : "")).then(function (j) {
      if (!j.images.length && !before) grid.appendChild(empty("还没有图片。"));
      j.images.forEach(function (p) {
        var b = h("button", { type: "button", title: p.note || p.ref, "aria-label": "看大图：" + (p.note || p.ref) },
          h("div", { class: "box" }, h("img", { src: p.url, alt: "", loading: "lazy", decoding: "async" })), h("small", { text: p.note || p.ref }));
        b.addEventListener("click", function () { openPic(p); });
        grid.appendChild(b); before = p.id;
      });
      more.hidden = !j.more; more.disabled = false;
    });
  }

  var fl = h("ul", { class: "list" }), fmore = h("button", { type: "button", hidden: true }, "再看 30 个"), fbefore = 0;
  files.appendChild(fl); files.appendChild(h("div", { class: "row" }, fmore));
  function pageFiles() {
    fmore.disabled = true;
    return api("files?n=30" + (fbefore ? "&before=" + fbefore : "")).then(function (j) {
      if (!j.files.length && !fbefore) fl.replaceWith(empty("还没有文件。"));
      j.files.forEach(function (f) {
        fl.appendChild(h("li", {}, h("a", { href: f.url, download: f.name, text: f.name }), h("span", { class: "meta", text: [f.ref, f.received ? "群里收到的" : "Bot 做的", f.size_text, when(f.ts)].join(" · ") })));
        fbefore = f.id;
      });
      fmore.hidden = !j.more; fmore.disabled = false;
    });
  }
  fmore.addEventListener("click", function () { pageFiles().catch(fail); });

  function loadSites() {
    return api("sites").then(function (j) {
      clear(sites);
      if (!j.sites.length && !j.pages.length) { sites.appendChild(empty("还没有做过网页。")); return; }
      var ul = h("ul", { class: "list" });
      j.sites.forEach(function (s) { ul.appendChild(h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.name }), h("span", { class: "meta", text: ["部署的网站", s.source, s.commit, when(s.at)].filter(Boolean).join(" · ") }))); });
      j.pages.forEach(function (s) { ul.appendChild(h("li", {}, h("a", { href: s.url, target: "_blank", rel: "noopener", text: s.title }), h("span", { class: "meta", text: ["发布的页面", when(s.at), s.views ? s.views + " 次打开" : ""].filter(Boolean).join(" · ") }))); });
      sites.appendChild(ul);
    });
  }
  function loadBox() {
    return api("box").then(function (j) {
      clear(boxEl);
      var up = h("button", { type: "button" }, "要一个上传链接"), out = h("div", {});
      boxEl.appendChild(h("p", { class: "meta", text: "大文件放这里，最大 2 GB 一个，过几天自动删。" }));
      boxEl.appendChild(h("div", { class: "row" }, up)); boxEl.appendChild(out);
      up.addEventListener("click", function () {
        up.disabled = true;
        api("box/upload", {}).then(function (r) {
          up.disabled = false; clear(out);
          var full = location.origin + r.url;
          out.appendChild(h("p", {}, h("a", { href: r.url, target: "_blank", rel: "noopener", text: "打开上传页" }), h("span", { class: "meta", text: " · " + when(r.expires) + " 前有效" })));
          out.appendChild(h("div", { class: "row" }, copyBtn(full, "复制上传链接")));
        }, function (e) { up.disabled = false; fail(e); });
      });
      if (!j.files.length) { boxEl.appendChild(empty("文件箱是空的。")); return; }
      var ul = h("ul", { class: "list" });
      j.files.forEach(function (f) { ul.appendChild(h("li", {}, h("a", { href: f.url, text: f.name }), h("span", { class: "meta", text: [f.ref, f.size_text, f.by ? f.by + " 传的" : "", when(f.expires) + " 到期"].filter(Boolean).join(" · ") }))); });
      boxEl.appendChild(ul);
    });
  }
  var d = $("pic");
  d.querySelector(".close").onclick = function () { d.close(); };
  d.onclick = function (e) { if (e.target === d) d.close(); };
  return Promise.all([resetPics(), pageFiles(), loadSites(), loadBox()]);
}

// ---------- 监控和额度 ----------
function watch(root) {
  return Promise.all([api("monitors"), api("plan")]).then(function (r) {
    var m = r[0], p = r[1];
    clear(root);
    root.appendChild(h("h2", { text: "网站在线" }));
    if (!m.uptime.length) root.appendChild(empty("没有在盯的网站。在群里说“盯一下我们网站能不能打开”就会加上。"));
    else {
      var ul = h("ul", { class: "list" });
      m.uptime.forEach(function (u) {
        var st = u.state === "up" ? "正常" : u.state === "down" ? "打不开" : "还在确认";
        ul.appendChild(h("li", {}, h("b", { text: u.name }), " ", h("span", { class: u.state === "down" ? "err" : u.state === "up" ? "ok" : "muted", text: st + (u.active ? "" : "（停了）") }),
          h("span", { class: "meta", text: [u.uptime_7d !== null && u.uptime_7d !== undefined ? "7 天在线 " + u.uptime_7d + "%" : "", u.ms ? u.ms + " 毫秒" : "", "查于 " + ago(u.last), u.state === "down" && u.error ? u.error : ""].filter(Boolean).join(" · ") }),
          h("span", { class: "meta", text: u.url })));
      });
      root.appendChild(ul);
    }
    root.appendChild(h("h2", { text: "订阅" }));
    if (!m.feeds.length) root.appendChild(empty("没有订阅。"));
    else {
      var fl = h("ul", { class: "list" });
      m.feeds.forEach(function (f) {
        fl.appendChild(h("li", {}, h("b", { text: f.title }), f.active ? null : h("span", { class: "muted", text: "（停了）" }),
          f.latest ? h("span", { class: "meta" }, "最新：", f.latest.link ? h("a", { href: f.latest.link, target: "_blank", rel: "noopener noreferrer", text: f.latest.title || f.latest.link }) : f.latest.title, f.latest.at ? "（" + when(f.latest.at) + "）" : "") : null,
          h("span", { class: "meta", text: ["查于 " + ago(f.last), f.fails ? "连续 " + f.fails + " 次没取到" : ""].filter(Boolean).join(" · ") })));
      });
      root.appendChild(fl);
    }
    root.appendChild(h("h2", { text: "盯着的网页" }));
    if (!m.watches.length) root.appendChild(empty("没有在盯的网页。"));
    else {
      var wl = h("ul", { class: "list" });
      m.watches.forEach(function (w) {
        wl.appendChild(h("li", {}, h("b", { text: w.what || w.url }), w.active ? null : h("span", { class: "muted", text: "（停了）" }),
          w.state ? h("span", { class: "meta", text: "现在：" + w.state }) : null,
          h("span", { class: "meta", text: [w.url, "查于 " + ago(w.last), w.hits ? "提醒过 " + w.hits + " 次" : ""].filter(Boolean).join(" · ") })));
      });
      root.appendChild(wl);
    }
    root.appendChild(h("h2", { text: "今天花的钱" }));
    var s = p.spend;
    root.appendChild(h("p", {}, h("span", { class: "big", text: s.today === null ? "—" : "¥" + s.today.toFixed(2) }), h("span", { class: "meta", text: s.yesterday === null ? "" : "　昨天 ¥" + s.yesterday.toFixed(2) })));
    if (s.items.length) {
      var il = h("ul", { class: "list" });
      s.items.forEach(function (i) { il.appendChild(h("li", {}, i.what, h("span", { class: "meta", text: i.via + " · " + i.calls + " 次 · 约 ¥" + i.cny }))); });
      root.appendChild(il);
    }
    root.appendChild(h("p", { class: "meta", text: "按官方价格估算，北京时间算一天。" }));
    root.appendChild(h("h2", { text: "这个月的套餐额度" }));
    root.appendChild(h("p", { class: "meta", text: p.plan.cycle + "。" + p.plan.rule + "。" }));
    var pl = h("ul", { class: "list" });
    p.plan.items.forEach(function (i) {
      var pct = Math.min(100, i.percent_of_included || 0), pr = h("progress", { max: "100", value: String(pct), class: pct >= 80 ? "hot" : "" });
      pl.appendChild(h("li", {}, h("span", { text: i.what }), pr, h("span", { class: "meta", text: "已用 " + i.used + " / " + i.included + " " + i.unit + "（" + i.percent_of_included + "%）" + (i.stop_at ? " · 到 " + i.stop_at + " 就停" : "") + (i.whole_cycle_estimate_percent ? " · 整月约 " + i.whole_cycle_estimate_percent + "%" : "") })));
    });
    root.appendChild(pl);
  });
}

// ---------- 工具 ----------
function toolsView(root) {
  return api("tools").then(function (j) {
    clear(root);
    root.appendChild(h("p", {}, h("a", { href: j.link, text: "打开工具箱" }), h("span", { class: "meta", text: "　图片、PDF、二维码、时间换算这些小活，在你自己的浏览器里做，文件不上传。" })));
    root.appendChild(h("h2", { text: "怎么叫 Bot" }));
    root.appendChild(h("p", { class: "meta", text: "在群里 @ 它，把下面的话换成你的内容发出去。" }));
    j.abilities.forEach(function (a) {
      var ul = h("ul", {});
      a.examples.forEach(function (e) { ul.appendChild(h("li", {}, h("span", { text: e }), copyBtn(e))); });
      root.appendChild(h("div", { class: "ab" }, h("h3", { text: a.title }), h("p", { text: a.what }), ul));
    });
  });
}

// ---------- shell ----------
var VIEWS = { feed: feed, tasks: tasks, memory: memory, repos: repos, works: works, watch: watch, tools: toolsView };
function show() {
  var id = (location.hash || "#feed").slice(1);
  if (!VIEWS[id]) id = "feed";
  var dlg = $("pic"); if (dlg.open) dlg.close();
  document.querySelectorAll("nav.tabs a").forEach(function (a) { if (a.dataset.tab === id) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
  document.querySelectorAll("main > section").forEach(function (s) { s.hidden = s.id !== "s-" + id; });
  var cur = document.querySelector("nav.tabs a[aria-current]"); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: "nearest", inline: "nearest" });
  say("");
  var stale = !loaded[id] || Date.now() - loaded[id] > 60000;
  if (!stale) return;
  loaded[id] = Date.now();
  var root = body(id);
  if (!root.firstChild) root.appendChild(h("p", { class: "meta", text: "载入中" }));
  Promise.resolve(VIEWS[id](root)).catch(function (e) { loaded[id] = 0; fail(e); });
}
function start() {
  $("logout").addEventListener("click", function () {
    api("logout", {}).then(function () {
      document.body.textContent = "";
      document.body.appendChild(h("main", { class: "wrap" }, h("p", { class: "status" }), h("p", { text: "已经退出了。要再进来，点群里 Bot 发的看板链接。" })));
    }).catch(fail);
  });
  api("me").then(function (j) { me = j; $("who").textContent = j.name; window.addEventListener("hashchange", show); show(); }).catch(fail);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
`;
