// Browser-side source of the team board (src/feat/board.ts serves it). The page is the same for every
// visitor; everything personal comes from /x/board/api/ after it loads. APP_JS is a String.raw literal, so
// the browser code must not contain backticks or "${". Data only ever reaches the DOM as text nodes.
// Layout: a left sidebar (desktop), an icon rail (tablet) or a bottom tab bar (phone); one <section> per hash.

// ---------- icons (24 px grid, stroked with currentColor; cloned by the script from a <template>) ----------
const I: Record<string, string> = {
  home: '<path d="M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4.5v-6h-5v6H5A1.5 1.5 0 0 1 3.5 19z"/>',
  feed: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  tasks: '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12.2 2.8 2.8L16 9.5"/>',
  memory: '<path d="M6 3.5h11.5v14H7a2 2 0 0 0-2 2v-14a2 2 0 0 1 1-2z"/><path d="M5 19.5a1.5 1.5 0 0 0 1.5 1h11v-3"/>',
  repos: '<circle cx="6.5" cy="5.5" r="2"/><circle cx="6.5" cy="18.5" r="2"/><circle cx="17.5" cy="7.5" r="2"/><path d="M6.5 7.5v9M17.5 9.5c0 4.5-7 3.5-10.5 7"/>',
  works: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
  watch: '<path d="M3 12h4l2.5-6 5 12 2.5-6h4"/>',
  tools: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/>',
  dots: '<circle cx="12" cy="5.5" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="12" cy="18.5" r="1.3"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4v4.5H15"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  left: '<path d="m15 5-7 7 7 7"/>',
  right: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  download: '<path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/>',
  logout: '<path d="M14.5 4H18a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3.5M10 8l-4 4 4 4M6 12h10"/>',
  help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.7 9.6a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.5M12 16.8v.1"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M7 7l10 10M17 7 7 17"/>',
  dash: '<path d="M7 12h10"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  alert: '<path d="M12 4 3 19.5h18z"/><path d="M12 10v4M12 16.8v.1"/>',
  ext: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>',
  file: '<path d="M6.5 3.5h7.5l4.5 4.5v12.5h-12z"/><path d="M14 3.5V8h4.5"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5"/>',
  upload: '<path d="M12 15V4M7 8.5l5-5 5 5M5 20h14"/>',
  star: '<path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z"/>',
  bolt: '<path d="M13 3 5 13.5h6L10 21l8-10.5h-6z"/>',
  team: '<circle cx="9" cy="8.5" r="3.2"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9.5" r="2.5"/><path d="M15.5 14.6a4.5 4.5 0 0 1 5 4.9"/>',
  wall: '<path d="M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3.5M8.5 20.5h7M9.5 17.5h5"/>',
  medal: '<circle cx="12" cy="15" r="5"/><path d="m8.6 11-3.1-7.5h4L12 9.5l2.5-6h4L15.4 11"/>',
  shop: '<rect x="3.5" y="8.5" width="17" height="4" rx="1"/><path d="M5 12.5v8h14v-8M12 8.5v12M12 8.5c-1.5-3.5-5.5-4-5.5-1.5S10 8.5 12 8.5zm0 0c1.5-3.5 5.5-4 5.5-1.5S14 8.5 12 8.5z"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z"/>',
};
const ATTR = 'class="ic" viewBox="0 0 24 24" aria-hidden="true"';
const svg = (name: string) => "<svg " + ATTR + '><use href="#i-' + name + '"/></svg>';
const SPRITE = '<svg class="vh" aria-hidden="true">' + Object.keys(I).map(k => '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + I[k] + "</symbol>").join("") + "</svg>";

// [hash, label, short label for the rail and the tab bar]
const NAV: [string, string, string][] = [["home", "概览", "概览"], ["tasks", "任务", "任务"], ["team", "战绩", "战绩"], ["wall", "功勋墙", "功勋"], ["feed", "动态", "动态"], ["works", "作品和文件", "作品"],
  ["repos", "仓库", "仓库"], ["memory", "记忆", "记忆"], ["watch", "监控和额度", "监控"], ["tools", "工具", "工具"]];
const TABBAR = ["home", "tasks", "team", "feed"];
const FAVICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZklEQVR42u3XuwkAIAwE0CzkQo7g/r32RgIJ+YEXsFK4V6lHJMxYc3ss0oxXqAkTHS4issKfiOxwhvgbIB24x2OPIQAAAIAIgOouAAAAK8DtQQIAgHIA/oQtAOXFpEU1a1FOK+r5AcjYXCnJczmbAAAAAElFTkSuQmCC";

const navLink = (n: [string, string, string]) => `<a href="#${n[0]}" data-tab="${n[0]}">${svg(n[0])}<span class="l">${n[1]}</span><span class="s">${n[2]}</span></a>`;

export function PAGE(css: string, js: string) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>看板</title><link rel="icon" href="${FAVICON}"><link rel="stylesheet" href="${css}">
<script src="${js}" defer></script></head>
<body>
${SPRITE}<template id="ic"><svg ${ATTR}><use href=""/></svg></template>
<nav class="side" aria-label="分区">
<div class="brand">${svg("tasks")}<span>看板</span></div>
<div class="links">${NAV.map(navLink).join("")}</div>
<div class="foot"><a class="me" href="#shop" title="我的积分和兑换"><span class="av" id="av" aria-hidden="true"></span><span class="who"><b id="who"></b><span id="mine" class="mine"></span></span></a>
<button type="button" id="help" class="ib" aria-label="快捷键" aria-haspopup="dialog">${svg("help")}</button><button type="button" id="logout" class="ib" aria-label="退出" title="退出">${svg("logout")}</button></div>
</nav>
<div class="content">
<header class="bar"><h1 id="title">概览</h1><span id="stamp" class="stamp"></span><button type="button" id="refresh" class="ib" aria-label="刷新" title="刷新（R）">${svg("refresh")}</button></header>
<main id="main">${NAV.concat([["shop", "兑换", "兑换"], ["redemptions", "兑换台账", "台账"]]).map(n => `<section id="s-${n[0]}" class="sec" hidden aria-label="${n[1]}"><div class="body"></div></section>`).join("")}
<noscript><p class="empty">看板需要开启 JavaScript。</p></noscript></main>
</div>
<nav class="tabbar" aria-label="主要分区">${NAV.filter(n => TABBAR.includes(n[0])).map(navLink).join("")}<button type="button" id="more-btn" aria-expanded="false" aria-controls="more">${svg("more")}<span class="s">更多</span></button></nav>
<div id="more" class="sheet" hidden><div class="scrim" data-close="1"></div><div class="sheet-in" role="dialog" aria-modal="true" aria-label="更多分区">
<div class="links">${NAV.filter(n => !TABBAR.includes(n[0])).map(navLink).join("")}</div>
<div class="sheet-foot"><span class="me"><span class="av" id="av2" aria-hidden="true"></span><span id="who2" class="who"></span></span><button type="button" id="logout2" class="btn">${svg("logout")}退出</button></div></div></div>
<div id="drawer" class="drawer" hidden><div class="scrim" data-close="1"></div><div class="dw" role="dialog" aria-modal="true" aria-labelledby="dw-title">
<div class="dw-head"><span id="dw-kicker" class="kicker"></span><button type="button" class="ib" id="dw-x" aria-label="关闭">${svg("close")}</button></div><div class="dw-body" id="dw-body"></div></div></div>
<div id="lb" class="lb" hidden role="dialog" aria-modal="true" aria-label="看大图">
<div class="lb-top"><span id="lb-n" class="lb-n"></span><a id="lb-dl" class="ib" aria-label="下载" title="下载">${svg("download")}</a><a id="lb-open" class="ib" target="_blank" rel="noopener" aria-label="新窗口打开原图" title="原图">${svg("ext")}</a><button type="button" class="ib" id="lb-x" aria-label="关闭" title="关闭（Esc）">${svg("close")}</button></div>
<div class="lb-stage" id="lb-stage"><button type="button" class="ib lb-prev" id="lb-prev" aria-label="上一张">${svg("left")}</button><img id="lb-img" alt=""><button type="button" class="ib lb-next" id="lb-next" aria-label="下一张">${svg("right")}</button></div>
<div class="lb-cap" id="lb-cap"></div></div>
<div id="pop" class="pop" hidden></div>
<p id="toast" class="toast" role="status" aria-live="polite"></p>
</body></html>`;
}

// Served as written minus indentation, comments and line breaks: the page stays readable here and small on the wire.
const squeezeCss = (s: string) => s.replace(/\/\*[^*]*\*\//g, "").replace(/\n\s*/g, "").replace(/\s*([{};,>])\s*/g, "$1");
// Drops indentation, comment lines and spaces next to punctuation; strings, regular expressions and line breaks are kept as they are.
function squeezeJs(src: string) {
  const s = src.replace(/^[ \t]+/gm, "").replace(/^\/\/ .*\n/gm, ""), word = /[\w$]/;
  let out = "", i = 0;
  const last = () => { let k = out.length - 1; while (k >= 0 && out[k] === " ") k--; return out[k] || ""; };
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'") { let j = i + 1; while (j < s.length && s[j] !== c) j += s[j] === "\\" ? 2 : 1; out += s.slice(i, j + 1); i = j + 1; continue; }
    if (c === "/" && s[i + 1] !== "/" && (/[(,=:[!&|?{};]/.test(last()) || /(return|typeof)$/.test(out))) {
      let j = i + 1, cls = false;
      while (j < s.length && (s[j] !== "/" || cls)) { if (s[j] === "\\") j++; else if (s[j] === "[") cls = true; else if (s[j] === "]") cls = false; j++; }
      out += s.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === " " || c === "\t") {
      let j = i; while (s[j] === " " || s[j] === "\t") j++;
      const a = out[out.length - 1] || "", b = s[j] || "";
      if ((word.test(a) && word.test(b)) || ((a === "+" || a === "-") && (b === "+" || b === "-"))) out += " ";
      i = j; continue;
    }
    out += c; i++;
  }
  return out;
}

export const CSS = squeezeCss(String.raw`
:root{--bg:#f4f4f1;--surface:#fff;--sunk:#eeeee9;--fg:#1c1c1a;--mute:#5d5d57;--line:#e2e2dc;--line2:#cfcfc7;
--acc:#2d6a5a;--acc-fg:#fff;--acc-soft:#e1eee9;--ok:#2b7046;--ok-soft:#e2f0e6;--bad:#b0372a;--bad-soft:#f9e4e0;--warn:#875c0b;--warn-soft:#f6ecd5;--mark:#f5e09a;
--pop:0 12px 32px rgba(25,25,20,.16),0 2px 6px rgba(25,25,20,.06);--r:10px;--side:232px;--rail:80px;--bar:56px;
--sat:env(safe-area-inset-top,0px);--sab:env(safe-area-inset-bottom,0px);--sal:env(safe-area-inset-left,0px);--sar:env(safe-area-inset-right,0px);
--sans:-apple-system,BlinkMacSystemFont,"PingFang SC","Noto Sans SC","Noto Sans CJK SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",sans-serif;--mono:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121211;--surface:#1b1b19;--sunk:#242421;--fg:#e9e9e4;--mute:#a7a79f;--line:#2c2c29;--line2:#3d3d38;
--acc:#7cc2ab;--acc-fg:#0d1d18;--acc-soft:#1c322b;--ok:#76c994;--ok-soft:#18301f;--bad:#f2917e;--bad-soft:#3b211c;--warn:#e2b55c;--warn-soft:#352914;--mark:#5d4f1c;--pop:0 12px 32px rgba(0,0,0,.55)}}
*{box-sizing:border-box}
[hidden]{display:none!important}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 var(--sans);overflow-x:hidden}
body.lock{overflow:hidden}
a{color:var(--acc);text-decoration:none}
a:hover{text-decoration:underline}
h1,h2,h3,p{margin:0}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px;border-radius:4px}
.ic{flex:none;display:block;width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.who,header.bar h1,.rchip .nm,.rchip .meta,.mrow .nm,.prow .lbl,.spl .w,.src,.toc button span,.gallery figcaption,.frow .nm,.frow .meta,.mon .t span,.mon .u,.pname>span:nth-child(2),.recent li a{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vh{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.meta{color:var(--mute);font-size:13px}
.num{font-variant-numeric:tabular-nums}

/* ---- shell ---- */
nav.side{position:fixed;z-index:20;left:0;top:0;bottom:0;width:calc(var(--side) + var(--sal));padding:16px 12px 12px calc(12px + var(--sal));background:var(--surface);border-right:1px solid var(--line);display:flex;flex-direction:column;gap:4px}
.brand{display:flex;align-items:center;gap:10px;padding:4px 10px 14px;font-weight:650;font-size:17px;letter-spacing:.02em}
.brand .ic{color:var(--acc);width:24px;height:24px}
.side .links{display:flex;flex-direction:column;gap:2px;flex:1;min-height:0;overflow-y:auto}
.side .links a{display:flex;align-items:center;gap:12px;min-height:40px;padding:0 10px;border-radius:8px;color:var(--mute);font-size:15px}
.side .links a:hover{background:var(--sunk);color:var(--fg);text-decoration:none}
.side .links a[aria-current]{background:var(--acc-soft);color:var(--fg);font-weight:600}
.side .links a[aria-current] .ic{color:var(--acc)}
.links .s{display:none}
.foot{display:flex;align-items:center;gap:4px;border-top:1px solid var(--line);padding-top:10px;margin-top:8px}
.me{display:flex;align-items:center;gap:8px;flex:1;min-width:0}
.who{font-size:14px;min-width:0}
a.me{color:var(--fg);border-radius:8px;padding:2px}a.me:hover{text-decoration:none;background:var(--sunk)}
.side .who b{display:block;font-weight:600;overflow:hidden;text-overflow:ellipsis}
.mine{display:block;font-size:12px;color:var(--mute);white-space:normal;line-height:1.4}
.av{flex:none;width:28px;height:28px;border-radius:50%;background:var(--sunk);border:1px solid var(--line2);color:var(--fg);display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;line-height:1}
.av.sm{width:22px;height:22px;font-size:11px}
.av.none{color:var(--mute);border-style:dashed}
.content{margin-left:calc(var(--side) + var(--sal));min-width:0}
header.bar{position:sticky;top:0;z-index:10;height:calc(var(--bar) + var(--sat));padding:var(--sat) calc(28px + var(--sar)) 0 28px;display:flex;align-items:center;gap:12px;background:var(--bg);border-bottom:1px solid transparent}
header.bar.stuck{border-bottom-color:var(--line)}
header.bar h1{font-size:20px;font-weight:650;letter-spacing:.01em}
.stamp{margin-left:auto;color:var(--mute);font-size:13px;white-space:nowrap}
main{padding:8px calc(28px + var(--sar)) 56px 28px;max-width:1320px}
@media (min-width:1600px){main{max-width:1500px;padding-left:40px}header.bar{padding-left:40px}}
.tabbar,.sheet{display:none}

@media (max-width:1099px){
 nav.side{width:calc(var(--rail) + var(--sal));padding:12px 6px 10px calc(6px + var(--sal))}
 .brand span,.side .links .l,.side .who{display:none}
 .brand{justify-content:center;padding:4px 0 10px}
 .side .links a{flex-direction:column;justify-content:center;gap:2px;min-height:56px;padding:4px 0;font-size:11px}
 .side .links .s{display:block;line-height:1.2}
 .foot{flex-direction:column;gap:6px}
 .me{flex:none}
 #help{display:none}
 .content{margin-left:calc(var(--rail) + var(--sal))}
 header.bar,main{padding-left:20px;padding-right:calc(20px + var(--sar))}
}
@media (max-width:1099px) and (max-height:560px){
 .brand{display:none}
 .side .links a{min-height:44px}
 .side .links a .s{display:none}
 .foot .me{display:none}
}
@media (max-width:699px){
 body{font-size:16px}
 nav.side{display:none}
 .content{margin-left:0}
 header.bar{padding:var(--sat) calc(16px + var(--sar)) 0 calc(16px + var(--sal));height:calc(52px + var(--sat))}
 header.bar h1{font-size:19px}
 main{padding:4px calc(16px + var(--sar)) calc(88px + var(--sab)) calc(16px + var(--sal))}
 .tabbar{display:flex;position:fixed;z-index:20;left:0;right:0;bottom:0;background:var(--surface);border-top:1px solid var(--line);padding:0 var(--sar) var(--sab) var(--sal)}
 .tabbar>a,.tabbar>button{flex:1;min-width:0;min-height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;font:inherit;font-size:11px;color:var(--mute);background:none;border:0;padding:6px 0 4px;cursor:pointer}
 .tabbar>a:hover{text-decoration:none}
 .tabbar .l{display:none}
 .tabbar .s{display:block;line-height:1.2}
 .tabbar [aria-current],.tabbar [aria-current] .ic{color:var(--acc);font-weight:600}
 .sheet{display:block;position:fixed;inset:0;z-index:40}
 .sheet[hidden]{display:none!important}
 .sheet-in{position:absolute;left:0;right:0;bottom:0;background:var(--surface);border-radius:14px 14px 0 0;padding:8px calc(12px + var(--sar)) calc(12px + var(--sab)) calc(12px + var(--sal));box-shadow:var(--pop)}
 .sheet .links{display:flex;flex-direction:column}
 .sheet .links a{display:flex;align-items:center;gap:14px;min-height:52px;padding:0 8px;color:var(--fg);font-size:16px;border-bottom:1px solid var(--line)}
 .sheet .links a[aria-current]{color:var(--acc);font-weight:600}
 .sheet .links .s{display:none}
 .sheet-foot{display:flex;align-items:center;gap:12px;padding:12px 8px 4px}
 .sheet-foot .who{display:block;font-size:15px}
}
.scrim{position:absolute;inset:0;background:rgba(10,10,8,.42)}

/* ---- controls ---- */
button{font:inherit;color:inherit}
.btn{font:inherit;font-size:14px;line-height:1.2;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--line2);background:var(--surface);color:var(--fg);cursor:pointer;text-decoration:none}
.btn:hover{border-color:var(--mute);text-decoration:none}
.btn .ic{width:18px;height:18px}
.btn.pri{background:var(--acc);border-color:var(--acc);color:var(--acc-fg);font-weight:600}
.btn.pri:hover{filter:brightness(1.06)}
.btn.sm{min-height:30px;padding:0 10px;font-size:13px}
.btn.quiet{border-color:transparent;background:none;color:var(--acc);padding:0 6px}
.btn:disabled{opacity:.5;cursor:default}
.ib{flex:none;width:36px;height:36px;display:inline-flex;align-items:center;justify-content:center;border-radius:8px;border:0;background:none;color:var(--mute);cursor:pointer;padding:0}
.ib:hover{background:var(--sunk);color:var(--fg)}
.ib:disabled{opacity:.35;cursor:default;background:none}
@media (pointer:coarse){.btn{min-height:44px}.btn.sm{min-height:40px}.ib{width:44px;height:44px}}
#refresh.spin .ic{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
input,select,textarea{font:inherit;font-size:16px;color:var(--fg);background:var(--surface);border:1px solid var(--line2);border-radius:8px;padding:0 10px;min-height:38px;max-width:100%;width:100%}
textarea{padding:8px 10px;min-height:5.5rem;resize:vertical;line-height:1.5}
select{padding-right:6px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--acc);outline-offset:-1px;border-color:var(--acc)}
@media (pointer:coarse){input,select{min-height:44px}}
.search{position:relative;flex:1;min-width:0}
.search .ic{position:absolute;left:10px;top:50%;margin-top:-10px;color:var(--mute);pointer-events:none}
.search input{padding-left:36px}
.field{display:flex;flex-direction:column;gap:4px;margin:0 0 12px}
.field>span{font-size:13px;color:var(--mute)}
.two{display:grid;grid-template-columns:1fr 1fr;gap:0 12px}
.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.seg{display:inline-flex;background:var(--sunk);border-radius:9px;padding:3px;gap:2px;max-width:100%}
.seg button{border:0;background:none;border-radius:7px;min-height:32px;padding:0 12px;font-size:14px;color:var(--mute);cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;gap:6px}
.seg button[aria-selected=true],.seg button[aria-pressed=true]{background:var(--surface);color:var(--fg);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.seg .n{font-size:12px;color:var(--mute);font-weight:400}
@media (pointer:coarse){.seg button{min-height:40px}}
.seg.full{display:flex}.seg.full button{flex:1;justify-content:center;padding:0 6px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chips button{border:1px solid var(--line2);background:var(--surface);border-radius:999px;min-height:32px;padding:0 12px;font-size:13px;cursor:pointer;color:var(--fg)}
.chips button[aria-pressed=true]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
@media (pointer:coarse){.chips button{min-height:40px}}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:1;padding:4px 8px 4px 6px;border-radius:999px;white-space:nowrap;background:var(--sunk);color:var(--mute)}
.badge .ic{width:14px;height:14px;stroke-width:2.4}
.badge.ok{background:var(--ok-soft);color:var(--ok)}
.badge.bad{background:var(--bad-soft);color:var(--bad)}
.badge.warn{background:var(--warn-soft);color:var(--warn)}
.ok-t{color:var(--ok)}.bad-t{color:var(--bad)}.warn-t{color:var(--warn)}
mark{background:var(--mark);color:inherit;border-radius:2px;padding:0 1px}
time.rt{cursor:help}
code,.code{font-family:var(--mono);font-size:12.5px;background:var(--sunk);border-radius:8px;padding:10px 12px;display:block;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5}

/* ---- cards and lists ---- */
.card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:16px 18px;min-width:0}
.card-h{display:flex;align-items:center;gap:10px;margin:0 0 12px;min-height:24px}
.card-h h2{font-size:15px;font-weight:650;flex:1;min-width:0}
.card-h .go{font-size:13px;display:inline-flex;align-items:center;gap:2px;white-space:nowrap}
.card-h .go .ic{width:16px;height:16px}
.sub{font-size:13px;font-weight:650;color:var(--mute);margin:16px 0 6px;letter-spacing:.02em}
.lede{color:var(--mute);font-size:14px;margin:0 0 16px}
.empty{color:var(--mute);font-size:14px;padding:12px 0}
.empty b{display:block;color:var(--fg);font-weight:600;font-size:15px;margin-bottom:2px}
.list{list-style:none;margin:0;padding:0}
.list>li{border-top:1px solid var(--line);padding:10px 0;min-width:0;overflow-wrap:anywhere}
.list>li:first-child{border-top:0}
.sect{margin:0 0 28px}
.sect>h2{font-size:15px;font-weight:650;margin:0 0 10px;display:flex;align-items:center;gap:8px}
.sect>h2 .n{color:var(--mute);font-weight:400;font-size:13px}
.more-row{display:flex;justify-content:center;padding:14px 0 0}
.tools-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 16px}
.skel{display:flex;flex-direction:column;gap:12px;padding:6px 0}
.skel i{display:block;height:12px;border-radius:6px;background:var(--sunk);animation:pulse 1.4s ease-in-out infinite}
.skel i:nth-child(3n+2){width:72%}.skel i:nth-child(3n){width:48%}
.skel.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}
.skel.cards i{height:120px;width:auto!important;border-radius:var(--r)}
@keyframes pulse{50%{opacity:.45}}

/* ---- overview ---- */
.ov{display:grid;gap:16px;grid-template-columns:minmax(0,1fr);grid-template-areas:"who" "pulse" "tasks" "day" "repos" "pics" "mon" "plan" "spend"}
.ov>.stats{grid-area:stats}.ov>.c-tasks{grid-area:tasks}.ov>.c-day{grid-area:day}.ov>.c-repos{grid-area:repos}.ov>.c-pics{grid-area:pics}.ov>.c-mon{grid-area:mon}.ov>.c-plan{grid-area:plan}.ov>.c-spend{grid-area:spend}
@media (min-width:700px){.ov{grid-template-columns:minmax(0,1fr) minmax(0,1fr);grid-template-areas:"who who" "pulse tasks" "day day" "repos repos" "pics pics" "mon spend" "plan plan"}}
@media (min-width:1100px){.ov{grid-template-columns:minmax(0,7fr) minmax(0,5fr);grid-template-areas:"who who" "tasks pulse" "day repos" "pics mon" "plan spend"}}
@media (min-width:1600px){.ov{grid-template-columns:minmax(0,5fr) minmax(0,4fr) minmax(0,4fr);grid-template-areas:"who who who" "tasks pulse day" "repos repos mon" "pics pics spend" "plan plan plan"}}
.trow{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--line);color:var(--fg);min-width:0}
.trow:first-child{border-top:0;padding-top:2px}
.trow:hover{text-decoration:none}.trow:hover .tt{text-decoration:underline}
.trow .tt{flex:1;min-width:0;overflow-wrap:anywhere}
.trow .side-m{flex:none;display:flex;gap:6px;align-items:center}
.sdot{flex:none;width:10px;height:10px;margin-top:7px;border-radius:50%;border:2px solid var(--mute)}
.sdot.doing{border-color:var(--acc);background:linear-gradient(90deg,var(--acc) 50%,transparent 50%)}
.sdot.done{border-color:var(--ok);background:var(--ok)}
.sdot.dropped{border-color:var(--line2);background:var(--line2)}
.day1 h3,.day2 h3{font-size:14px;font-weight:650;margin:0 0 4px;display:flex;gap:8px;align-items:baseline}
.clamp{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:6;overflow:hidden;white-space:pre-wrap}
.clamp.c2{-webkit-line-clamp:2}
.day2{margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
.rchips{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.rchip{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;color:var(--fg);min-width:0}
.rchip:hover{text-decoration:none;border-color:var(--line2)}
.rchip .nm{font-weight:600}
.rchip .meta{display:block}
.rchip>span:last-child{min-width:0}
.mark{flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--sunk);color:var(--mute)}
.mark .ic{width:15px;height:15px;stroke-width:2.6}
.mark.ok{background:var(--ok-soft);color:var(--ok)}
.mark.bad{background:var(--bad-soft);color:var(--bad);border-radius:6px}
.strip{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:6px}
@media (max-width:699px){.strip{grid-template-columns:repeat(4,minmax(0,1fr))}}
.strip button{border:0;padding:0;background:var(--sunk);border-radius:6px;overflow:hidden;aspect-ratio:1;cursor:zoom-in;display:block;width:100%}
.strip img{width:100%;height:100%;object-fit:cover;display:block}
.mrow{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line);min-width:0}
.mrow:first-child{border-top:0;padding-top:0}
.mrow .nm{flex:1;min-width:0}
.allup{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--ok);margin-bottom:8px}
.dot{flex:none;width:10px;height:10px;border-radius:50%;background:var(--ok)}
.dot.down{background:none;width:0;height:0;border-radius:0;border-left:6px solid transparent;border-right:6px solid transparent;border-bottom:11px solid var(--bad)}
.dot.unk{background:none;border:2px solid var(--mute)}
.dot.off{background:var(--line2)}
.prow{display:grid;grid-template-columns:minmax(0,9em) minmax(0,1fr) 4.5em;gap:4px 12px;align-items:center;padding:6px 0}
.prow .lbl{font-size:13px}
.prow .meta{grid-column:1/-1;margin-top:-2px}
.gone{max-width:28em;margin:15vh auto;padding:0 20px;font-size:16px;line-height:1.7}
.prow .pct{text-align:right;font-size:13px;font-variant-numeric:tabular-nums}
.meter{position:relative;display:block;height:6px;border-radius:3px;background:var(--sunk)}
.meter .fill{position:absolute;left:0;top:0;bottom:0;border-radius:3px;background:var(--acc)}
.meter.warn .fill{background:var(--warn)}.meter.bad .fill{background:var(--bad)}
.meter .stop{position:absolute;top:-4px;bottom:-4px;width:2px;margin-left:-1px;background:var(--fg);opacity:.55;border-radius:1px}
.plan-cols{display:grid;grid-template-columns:minmax(0,1fr);gap:0 32px}
@media (min-width:700px) and (max-width:1099px),(min-width:1600px){.c-plan .plan-cols{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.legend{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mute);margin-top:8px}
.legend i{display:inline-block;width:2px;height:12px;background:var(--fg);opacity:.55}
.big{font-size:30px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums}
.spl{display:flex;align-items:center;gap:10px;padding:5px 0;font-size:14px}
.spl .w{flex:1;min-width:0}
.spl .meter{width:64px;flex:none}

/* ---- tasks ---- */
.kanban{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);gap:14px;align-items:start}
.col{background:var(--sunk);border-radius:var(--r);padding:10px 8px 8px;min-width:0;min-height:120px;border:2px solid transparent}
.col.over{border-color:var(--acc);border-style:dashed}
.col-h{display:flex;align-items:center;gap:8px;padding:0 6px 8px;font-weight:650;font-size:14px}
.col-h .n{color:var(--mute);font-weight:400;font-size:13px;flex:1}
.col-h .ib{width:30px;height:30px}
.cards{display:flex;flex-direction:column;gap:8px}
.col-empty{color:var(--mute);font-size:13px;text-align:center;padding:18px 0;border:1px dashed var(--line2);border-radius:8px}
.tc{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:8px;min-width:0}
.tc:hover{border-color:var(--line2)}
.tc[draggable=true]{cursor:grab}
.tc.dragging{opacity:.4}
.tc.pending{opacity:.6}
.tc.s-done .tt,.tc.s-dropped .tt{color:var(--mute)}
.tc.s-dropped .tt{text-decoration:line-through}
.tc-main{display:block;padding:10px 40px 10px 12px;color:var(--fg)}
.tc-main:hover{text-decoration:none}
.tc-main:hover .tt{text-decoration:underline}
.tc .tt{display:block;font-weight:550;line-height:1.45;overflow-wrap:anywhere}
.tc .tid{color:var(--mute);font-weight:400;font-size:12px;margin-right:6px;font-variant-numeric:tabular-nums}
.tm{display:flex;flex-wrap:wrap;align-items:center;gap:4px 10px;margin-top:6px;font-size:12.5px;color:var(--mute)}
.tm .who{display:inline-flex;align-items:center;gap:5px;font-size:12.5px}
.due{display:inline-flex;align-items:center;gap:3px;white-space:nowrap}
.due .ic{width:14px;height:14px}
.due.late{color:var(--bad);font-weight:600}
.due.soon{color:var(--warn);font-weight:600}
.src{display:block;margin-top:4px;font-size:12px;color:var(--mute)}
.tc-menu{position:absolute;top:4px;right:2px}
.tasks-list .cards{gap:10px}
.mobile-add{position:fixed;z-index:15;right:calc(16px + var(--sar));bottom:calc(72px + var(--sab));width:56px;height:56px;border-radius:50%;border:0;background:var(--acc);color:var(--acc-fg);box-shadow:var(--pop);display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.mobile-add .ic{width:26px;height:26px}
.toggle{display:inline-flex;align-items:center;gap:6px;font-size:14px;color:var(--mute);cursor:pointer;min-height:36px;white-space:nowrap}
.toggle input{width:18px;height:18px;min-height:0;margin:0;accent-color:var(--acc)}
.tools-row select{width:auto;min-width:8em}
@media (max-width:699px){.tools-row .search{flex-basis:100%;order:3}.tools-row select{flex:1}}

/* ---- drawer, popover, toast ---- */
.drawer{position:fixed;inset:0;z-index:50}
.dw{position:absolute;top:0;right:0;bottom:0;width:min(520px,100%);background:var(--surface);box-shadow:var(--pop);display:flex;flex-direction:column;transform:translateX(24px);opacity:0;transition:transform .18s ease,opacity .18s ease}
.drawer.on .dw{transform:none;opacity:1}
.dw-head{display:flex;align-items:center;gap:8px;padding:calc(10px + var(--sat)) calc(10px + var(--sar)) 6px 20px;border-bottom:1px solid var(--line)}
.kicker{flex:1;color:var(--mute);font-size:13px}
.dw-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:16px calc(20px + var(--sar)) calc(28px + var(--sab)) 20px}
.dw-body h2{font-size:20px;font-weight:650;line-height:1.35;margin:0 0 14px;overflow-wrap:anywhere}
.dw-body h3{font-size:13px;font-weight:650;color:var(--mute);margin:22px 0 8px;letter-spacing:.02em}
@media (max-width:699px){.dw{width:100%;left:0}.dw-head{padding-left:calc(16px + var(--sal))}.dw-body{padding-left:calc(16px + var(--sal));padding-right:calc(16px + var(--sar))}}
.facts{display:grid;grid-template-columns:5em minmax(0,1fr);gap:6px 12px;margin:14px 0 0;font-size:14px}
.facts dt{color:var(--mute)}
.facts dd{margin:0;overflow-wrap:anywhere}
.pre{white-space:pre-wrap;overflow-wrap:anywhere}
.ai{margin-top:24px;padding:14px;border-radius:var(--r);background:var(--sunk)}
.ai h3{margin:0 0 4px!important;color:var(--fg)!important;font-size:14px!important}
.ai p{font-size:13px;color:var(--mute);margin:0 0 10px}
.ai code{background:var(--surface)}
.ai .row{margin:8px 0 0}
.pop{position:fixed;z-index:60;min-width:180px;max-width:min(320px,calc(100vw - 16px));background:var(--surface);border:1px solid var(--line);border-radius:10px;box-shadow:var(--pop);padding:6px}
.pop [role=menuitemradio],.pop [role=menuitem]{display:flex;align-items:center;gap:10px;width:100%;min-height:38px;padding:0 10px;border:0;background:none;border-radius:6px;text-align:left;cursor:pointer;font-size:14px;color:var(--fg)}
.pop [role=menuitemradio]:hover,.pop [role=menuitem]:hover,.pop [role=menuitemradio]:focus{background:var(--sunk);outline:0}
.pop [aria-checked=true]{font-weight:650}
.pop .ck{width:18px;color:var(--acc)}
.pop hr{border:0;border-top:1px solid var(--line);margin:4px 0}
@media (pointer:coarse){.pop [role=menuitemradio],.pop [role=menuitem]{min-height:44px}}
.keys{margin:0;padding:8px 10px;display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px}
.keys dt{white-space:nowrap}
.keys dd{margin:0;color:var(--mute)}
kbd{font-family:var(--mono);font-size:12px;border:1px solid var(--line2);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--bg)}
.toast{position:fixed;z-index:70;left:50%;bottom:calc(24px + var(--sab));transform:translate(-50%,16px);max-width:min(92vw,480px);background:var(--fg);color:var(--bg);padding:10px 16px;border-radius:10px;font-size:14px;box-shadow:var(--pop);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;margin:0}
.toast.show{opacity:1;transform:translate(-50%,0)}
.toast.bad{background:#b0372a;color:#fff}
@media (max-width:699px){.toast{bottom:calc(76px + var(--sab))}}

/* ---- feed ---- */
.read{max-width:760px}
.tl{list-style:none;margin:0;padding:0;position:relative}
.tl>li{display:grid;grid-template-columns:76px minmax(0,1fr);gap:20px;padding:0 0 26px;position:relative}
.tl>li::before{content:"";position:absolute;left:87px;top:10px;bottom:0;width:1px;background:var(--line2)}
.tl>li:last-child::before{display:none}
.tl-date{text-align:right;line-height:1.25}
.tl-date b{display:block;font-size:24px;font-weight:650;font-variant-numeric:tabular-nums}
.tl-date span{display:block;font-size:12px;color:var(--mute)}
.tl-date em{display:inline-block;font-style:normal;font-size:11px;font-weight:650;color:var(--acc);margin-top:4px}
.tl-text{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 16px}
.tl-text::before{content:"";position:absolute;left:-17px;top:12px;width:9px;height:9px;border-radius:50%;background:var(--surface);border:2px solid var(--acc)}
.tl-text p{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.tl-text p:last-child{margin:0}
.tl>li.hl .tl-text{border-color:var(--acc)}
@media (max-width:699px){.tl>li{grid-template-columns:44px minmax(0,1fr);gap:16px}.tl>li::before{left:52px}.tl-date b{font-size:20px}.tl-text::before{left:-14px}.tl-text{padding:10px 12px}}

/* ---- memory ---- */
.memwrap{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@media (min-width:1100px){.memwrap{grid-template-columns:220px minmax(0,780px);gap:32px}.toc{position:sticky;top:calc(var(--bar) + 12px);align-self:start;max-height:calc(100vh - var(--bar) - 24px);overflow-y:auto}.toc>summary{display:none!important}}
.toc{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);padding:6px}
.toc>summary{cursor:pointer;min-height:40px;display:flex;align-items:center;padding:0 8px;font-weight:600;font-size:14px;list-style:none}
.toc>summary::-webkit-details-marker{display:none}
.toc>summary::after{content:"";margin-left:auto;width:7px;height:7px;border-right:2px solid var(--mute);border-bottom:2px solid var(--mute);transform:rotate(45deg) translate(-2px,-2px)}
.toc[open]>summary::after{transform:rotate(-135deg)}
.toc button{display:flex;width:100%;align-items:center;gap:8px;min-height:36px;padding:0 10px;border:0;background:none;border-radius:6px;cursor:pointer;text-align:left;font-size:14px;color:var(--fg)}
.toc button:hover{background:var(--sunk)}
.toc button span{flex:1;min-width:0}
.toc button .n{flex:none;color:var(--mute);font-size:12px}
.toc button.zero{color:var(--mute)}
@media (pointer:coarse){.toc button{min-height:44px}}
.mem section{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 18px;margin:0 0 12px;scroll-margin-top:calc(var(--bar) + 12px)}
.mem h2{font-size:15px;font-weight:650;margin:0 0 6px}
.mem ul{margin:0;padding:0 0 0 1.1em}
.mem li{padding:3px 0;overflow-wrap:anywhere}
.mem li::marker{color:var(--line2)}
.mem .when{color:var(--mute);font-size:13px;margin-right:8px}

/* ---- repos ---- */
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,360px),1fr));gap:16px;align-items:start}
.repo-h{display:flex;align-items:center;gap:10px;margin:0 0 6px}
.repo-h h2{font-size:16px;font-weight:650;flex:1;min-width:0;overflow-wrap:anywhere}
.card.failing{border-color:var(--bad)}
.hist{display:flex;align-items:flex-end;gap:3px;margin:12px 0 4px;height:18px}
.hist i{flex:1;max-width:14px;height:18px;border-radius:2px;background:var(--ok)}
.hist i.f{background:none;border:2px solid var(--bad);height:18px}
.hist i.u{background:var(--line2);height:8px}
.steps{list-style:none;margin:10px 0 0;padding:0;font-size:14px}
.steps li{display:flex;gap:8px;align-items:flex-start;padding:3px 0}
.steps .ic{width:16px;height:16px;margin-top:3px;stroke-width:2.4}
.steps .ok-t .ic,.steps .bad-t .ic{flex:none}
.steps li>span:last-child{min-width:0;overflow-wrap:anywhere}
details.more{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
details.more>summary{cursor:pointer;font-size:13px;color:var(--acc);min-height:32px;display:flex;align-items:center}
@media (pointer:coarse){details.more>summary{min-height:44px}}
pre.tail{font-family:var(--mono);font-size:12px;background:var(--sunk);border-radius:8px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;margin:6px 0 0;max-height:16rem;overflow:auto;line-height:1.5}
.err-line{color:var(--bad);font-size:14px;margin-top:8px}

/* ---- works ---- */
.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
@media (min-width:1600px){.gallery{grid-template-columns:repeat(auto-fill,minmax(180px,1fr))}}
@media (max-width:699px){.gallery{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.gallery figcaption{display:none}}
.gallery button{border:0;padding:0;background:none;text-align:left;cursor:zoom-in;min-width:0;display:block;color:inherit;width:100%}
.gallery .box{display:block;aspect-ratio:1;background:var(--sunk);border-radius:8px;overflow:hidden}
.gallery img{width:100%;height:100%;object-fit:cover;display:block}
.gallery figure{margin:0}
.gallery figcaption{font-size:12.5px;margin-top:6px;line-height:1.35}
.gallery figcaption .meta{display:block;font-size:12px}
.flist{border:1px solid var(--line);border-radius:var(--r);background:var(--surface);overflow:hidden}
.frow{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:10px 14px;border-top:1px solid var(--line);min-width:0}
.frow:first-child{border-top:0}
.frow .nm{font-weight:550;display:block}
.frow .meta{display:block}
.ftype{width:44px;height:44px;border-radius:8px;background:var(--sunk);display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:700;color:var(--mute);letter-spacing:.02em;font-family:var(--mono)}
.ftype.web{color:var(--acc)}
.ftype .ic{width:20px;height:20px}
.lb{position:fixed;inset:0;z-index:80;background:#0b0b0a;color:#eee;display:flex;flex-direction:column}
.lb .ib{color:#ddd}.lb .ib:hover{background:rgba(255,255,255,.12);color:#fff}
.lb-top{display:flex;align-items:center;gap:4px;padding:calc(8px + var(--sat)) calc(8px + var(--sar)) 4px calc(16px + var(--sal))}
.lb-n{flex:1;font-size:14px;color:#bbb;font-variant-numeric:tabular-nums}
.lb-stage{flex:1;min-height:0;position:relative;display:flex;align-items:center;justify-content:center;padding:0 60px;touch-action:pan-y}
.lb-stage img{width:100%;height:100%;object-fit:contain;display:block}
.lb-prev,.lb-next{position:absolute;top:50%;margin-top:-22px;width:44px!important;height:44px!important;border-radius:50%!important;background:rgba(255,255,255,.08)!important}
.lb-prev{left:calc(8px + var(--sal))}.lb-next{right:calc(8px + var(--sar))}
.lb-cap{padding:12px calc(20px + var(--sar)) calc(16px + var(--sab)) calc(20px + var(--sal));max-height:28vh;overflow-y:auto;font-size:14px;max-width:900px;width:100%;margin:0 auto}
.lb-cap .meta{color:#aaa;display:block;margin-top:2px}
@media (max-width:699px){.lb-stage{padding:0}.lb-prev,.lb-next{display:none!important}}

/* ---- watch ---- */
.wgrid{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
@media (min-width:1100px){.wgrid{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
.mon{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 12px;padding:12px 0;border-top:1px solid var(--line)}
.mon:first-child{border-top:0;padding-top:0}
.mon .t{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0}
.mon .st{font-size:13px;font-weight:600;text-align:right;white-space:nowrap}
.mon .u{grid-column:1/-1;font-size:12.5px;color:var(--mute)}
.mon .days{grid-column:1/-1;display:flex;gap:3px;margin-top:6px;align-items:center}
.mon .days i{flex:1;height:14px;border-radius:2px;background:var(--ok)}
.mon .days i.w{background:var(--warn)}
.mon .days i.b{background:none;border:2px solid var(--bad)}
.mon .days i.n{background:var(--sunk)}
.mon .days span{flex:none;margin-left:8px;font-size:12px;color:var(--mute);white-space:nowrap}

/* ---- tools ---- */
.tbox{display:flex;align-items:center;gap:16px;margin:0 0 24px}
.tbox p{flex:1;color:var(--mute);font-size:14px}
.agrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,320px),1fr));gap:16px;align-items:start}
.ab h2{font-size:15px;font-weight:650;margin:0 0 2px}
.ab>p{color:var(--mute);font-size:13.5px;margin:0 0 8px}
.ab ul{list-style:none;margin:0;padding:0}
.ab li{display:flex;gap:8px;align-items:center;padding:4px 0;border-top:1px solid var(--line);font-size:14px}
.ab li span{flex:1;min-width:0;overflow-wrap:anywhere}
.ab .ib{width:32px;height:32px}
@media (pointer:coarse){.ab .ib{width:44px;height:44px}}

/* ---- team ---- */
.ov>.c-who{grid-area:who}.ov>.c-pulse{grid-area:pulse}
.people{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,250px),1fr));gap:12px}
.pcol{border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
.pcol.free{background:var(--sunk);border-color:transparent}
.pname{display:flex;align-items:center;gap:8px;font-weight:650;margin-bottom:8px;min-width:0}
.pname>span:nth-child(2){flex:1;min-width:0}
.star{display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:650;color:var(--warn);white-space:nowrap}
.star .ic{width:15px;height:15px;fill:currentColor;stroke-width:1.2}
.on{display:block;padding:6px 0;border-top:1px solid var(--line);color:var(--fg);min-width:0}
.on:first-of-type{border-top:0;padding-top:0}
.on:hover{text-decoration:none}.on:hover .tt{text-decoration:underline}
.on .tt{display:block;overflow-wrap:anywhere;font-weight:550}
.on .meta{display:flex;flex-wrap:wrap;gap:2px 8px;align-items:center}
.freet{color:var(--mute);font-size:14px}
.pulse{display:flex;gap:20px;align-items:flex-end;flex-wrap:wrap}
.pulse .big{font-size:28px}
.pnum>span{display:block;font-size:13px;color:var(--mute)}
.pnum .star{display:inline-flex;color:var(--warn)}
.pnum>b:not(.big){display:block;font-size:18px;font-weight:650;line-height:1.5}
.wk{margin-top:12px;padding-top:4px;border-top:1px solid var(--line)}
.wk .spl .meter{width:auto;flex:1}
.wk .spl .w{flex:none;width:5em}
.bars{display:flex;gap:6px;align-items:flex-end;height:64px;margin:14px 0 4px}
.bars>span{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end;font-size:11px;color:var(--mute)}
.bars i{display:block;width:100%;max-width:28px;border-radius:3px 3px 0 0;background:var(--acc);min-height:2px}
.bars i.z{background:var(--line2)}
.bars .td{color:var(--fg);font-weight:650}
.tot{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--mute);margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.tot b{color:var(--fg);font-variant-numeric:tabular-nums}
.sz{font-size:11px;font-weight:700;padding:2px 6px;border-radius:4px;background:var(--sunk);color:var(--mute);white-space:nowrap}
.sz.big{background:var(--warn);color:var(--surface)}
.tc.boss{border-left:4px solid var(--warn)}
.path{display:block;margin-top:6px;font-size:12px;color:var(--mute)}
.path b{color:var(--ok);font-weight:650}
.tc.settle{animation:settle 1.2s ease-out}
@keyframes settle{0%{box-shadow:0 0 0 3px var(--ok)}100%{box-shadow:0 0 0 0 transparent}}
.toast.win{background:var(--ok);color:var(--surface);font-weight:650}
.stepper{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));margin:18px 0 4px;position:relative}
.stp{position:relative;padding-top:20px;font-size:13px;min-width:0}
.stp::before{content:"";position:absolute;top:5px;left:0;right:0;height:2px;background:var(--line2)}
.stp:first-child::before{left:6px}.stp:last-child::before{right:auto;width:6px}
.stp.done::before{background:var(--acc)}
.stp::after{content:"";position:absolute;top:0;left:0;width:8px;height:8px;border-radius:50%;border:2px solid var(--line2);background:var(--surface)}
.stp.done::after{border-color:var(--acc);background:var(--acc)}
.stp b{display:block;font-weight:650}
.stp .meta{display:block;padding-right:6px}
.gap{display:block;font-size:12px;color:var(--warn);margin-top:2px}
.vtl{list-style:none;margin:0;padding:0 0 0 18px;border-left:2px solid var(--line)}
.vtl li{position:relative;padding:0 0 12px;font-size:14px;overflow-wrap:anywhere}
.vtl li::before{content:"";position:absolute;left:-24px;top:6px;width:8px;height:8px;border-radius:50%;background:var(--surface);border:2px solid var(--line2)}
.vtl li.k-done::before{background:var(--ok);border-color:var(--ok)}
.vtl li.k-claim::before{border-color:var(--acc)}
.vtl li.pending{opacity:.55}
.vtl .meta{display:block}
.credit{display:flex;align-items:center;gap:8px;margin-top:14px;padding:10px 12px;border-radius:8px;background:var(--ok-soft);color:var(--ok);font-weight:600;font-size:14px}
.teamw{display:grid;grid-template-columns:minmax(0,1fr);gap:24px}
@media (min-width:1100px){.teamw{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}}
.mecard{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:16px}
.mecard>div{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:10px 14px}
.mecard b{display:block;font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
.mecard span{font-size:12.5px;color:var(--mute)}
@media (max-width:699px){.mecard{grid-template-columns:repeat(2,minmax(0,1fr))}}
.lb-row{display:grid;grid-template-columns:2em minmax(0,1fr) auto;gap:6px 12px;align-items:center;padding:10px 0;border-top:1px solid var(--line)}
.lb-row:first-child{border-top:0}
.rk{font-size:18px;font-weight:650;color:var(--mute);text-align:center;font-variant-numeric:tabular-nums}
.lb-row.top .rk{color:var(--warn)}
.lb-row .nm{display:flex;align-items:center;gap:8px;font-weight:600;min-width:0}
.lb-row .pts{font-size:18px;font-weight:650;text-align:right;font-variant-numeric:tabular-nums}
.lb-row .pts small{font-size:12px;color:var(--mute);font-weight:400}
.lb-row .meter{grid-column:2/-1}
.lb-row .meta{grid-column:2/-1}
.badges{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.bdg{display:inline-flex;align-items:center;gap:4px;font-size:12.5px;padding:4px 9px;border-radius:999px;border:1px solid var(--acc);color:var(--acc);font-weight:600;cursor:help}
.bdg .ic{width:14px;height:14px}
.bdg.no{border:1px dashed var(--line2);color:var(--mute);font-weight:400}
.recent{list-style:none;margin:10px 0 0;padding:0;font-size:13.5px}
.recent li{display:flex;gap:8px;padding:3px 0;min-width:0}
.recent li a{flex:1;min-width:0}
.ev-day{font-size:13px;font-weight:650;color:var(--mute);margin:18px 0 6px}
.ev-day:first-child{margin-top:0}
.ev{display:flex;gap:10px;align-items:flex-start;padding:7px 0;font-size:14px;min-width:0}
.ev .k{flex:none;width:26px;height:26px;border-radius:50%;background:var(--sunk);color:var(--mute);display:inline-flex;align-items:center;justify-content:center}
.ev .k .ic{width:15px;height:15px}
.ev>span:nth-child(2){flex:1;min-width:0;overflow-wrap:anywhere}
.ev .meta{display:block}
.ev.done{background:var(--ok-soft);border-radius:8px;padding:8px 10px;margin:4px 0}
.ev.done .k{background:var(--ok);color:var(--surface)}
.ev.done b{color:var(--ok)}

/* ---- wall and shop ---- */
.cols2{display:grid;grid-template-columns:minmax(0,1fr);gap:0 24px}
@media (min-width:1100px){.cols2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}
a.plain{color:var(--fg)}a.plain:hover{text-decoration:none}a.plain:hover .rec{border-color:var(--line2)}
.who-n{display:inline-flex;align-items:center;gap:2px;min-width:0}
.ttl{display:inline-block;font-size:12px;font-weight:600;color:var(--warn);background:var(--warn-soft);border-radius:4px;padding:1px 6px;margin-left:6px;white-space:nowrap;vertical-align:1px}
.wall{display:grid;grid-template-columns:minmax(0,1fr);gap:20px}
.hero{display:grid;grid-template-columns:minmax(0,1fr);gap:16px}
@media (min-width:900px){.hero{grid-template-columns:minmax(0,3fr) minmax(0,2fr)}}
.starcard{display:flex;gap:18px;align-items:center;border:1px solid var(--warn);background:var(--warn-soft)}
@media (min-width:900px){.starcard{flex-direction:column;justify-content:center;text-align:center;gap:10px}.starcard .big-star{width:84px;height:84px}.starcard .big-star .ic{width:44px;height:44px}.starcard .n{font-size:30px}}
.starcard .big-star{flex:none;width:64px;height:64px;border-radius:50%;background:var(--warn);color:var(--surface);display:flex;align-items:center;justify-content:center}
.starcard .big-star .ic{width:34px;height:34px;fill:currentColor;stroke-width:1}
.starcard .k{font-size:13px;font-weight:650;color:var(--warn)}
.starcard .n{font-size:24px;font-weight:700;line-height:1.3;margin:2px 0}
.roll li{display:flex;align-items:center;gap:10px;font-size:14px}
.roll li .w{flex:1;min-width:0}
.trophies{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,280px),1fr));gap:14px}
.trophy{position:relative;background:var(--surface);border:1px solid var(--line);border-top:4px solid var(--warn);border-radius:var(--r);padding:16px 18px 14px;color:var(--fg);display:block;min-width:0}
.trophy:hover{text-decoration:none;border-color:var(--warn)}
.trophy .ic{position:absolute;right:14px;top:14px;color:var(--warn);width:26px;height:26px}
.trophy h3{font-size:17px;font-weight:700;line-height:1.4;margin:6px 34px 10px 0;overflow-wrap:anywhere}
.trophy .by{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.trophy .meta{display:block;margin-top:6px}
.records{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}
.rec{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 16px}
.rec>span:first-child{display:block;font-size:13px;color:var(--mute)}
.rec b{display:block;font-size:22px;font-weight:650;line-height:1.3;font-variant-numeric:tabular-nums}
.rec .who{font-size:13px;display:flex;align-items:center;gap:6px;margin-top:4px}
.cabinet{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:12px}
@media (max-width:699px){.cabinet{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.medal{flex-direction:column;gap:6px;padding:10px 12px}.medal .m{width:32px;height:32px}.medal .m .ic{width:18px;height:18px}.medal.got{grid-column:1/-1;flex-direction:row}.records{gap:8px}.rec b{font-size:19px}}
.medal{display:flex;align-items:flex-start;gap:12px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 14px;min-width:0}
.medal .m{flex:none;width:40px;height:40px;border-radius:50%;background:var(--acc-soft);color:var(--acc);display:flex;align-items:center;justify-content:center}
.medal.open{background:none;border-style:dashed;border-color:var(--line2)}
.medal.open .m{background:var(--sunk);color:var(--mute)}
.medal b{display:block;font-weight:650}
.medal .meta{display:block}
.holders{display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:6px;font-size:13px}
.holders span{display:inline-flex;align-items:center;gap:4px}
.latest{display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 10px;border-radius:8px;background:var(--warn-soft);color:var(--fg);font-size:13.5px}
.latest .ic{color:var(--warn);width:18px;height:18px}
.latest>span{flex:1;min-width:0}
.mybal{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:10px;font-size:13.5px;color:var(--mute)}
.mybal b{color:var(--fg)}
.mybal .go{display:inline-flex;align-items:center;margin-left:auto;white-space:nowrap}.mybal .go .ic{width:16px;height:16px}
.wallet{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-bottom:20px}
.wallet>div{background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:12px 16px}
.wallet>div.left{border-color:var(--acc);background:var(--acc-soft)}
.wallet b{display:block;font-size:26px;font-weight:650;font-variant-numeric:tabular-nums;line-height:1.3}
.wallet span{font-size:13px;color:var(--mute)}
.items{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,260px),1fr));gap:14px}
.item{display:flex;flex-direction:column;gap:6px;background:var(--surface);border:1px solid var(--line);border-radius:var(--r);padding:14px 16px;min-width:0}
.item .top{display:flex;align-items:baseline;gap:8px}
.item h3{flex:1;font-size:16px;font-weight:650;margin:0}
.item .cost{font-size:18px;font-weight:700;color:var(--acc);white-space:nowrap;font-variant-numeric:tabular-nums}
.item .cost small{font-size:12px;font-weight:400;color:var(--mute)}
.item p{font-size:13.5px;color:var(--mute);flex:1}
.item .foot2{display:flex;align-items:center;gap:8px;margin-top:6px}
.item .foot2 .meta{flex:1}
.short{font-size:13px;color:var(--mute);text-align:right;white-space:nowrap}
.short .meter{width:90px;margin-top:4px}
.item.cant{background:var(--bg)}
.spl2 .frow{grid-template-columns:minmax(0,1fr) auto}
.done-box{text-align:center;padding:18px 0 6px}
.done-box .m{width:56px;height:56px;border-radius:50%;background:var(--ok);color:var(--surface);display:inline-flex;align-items:center;justify-content:center;margin-bottom:10px}
.done-box .m .ic{width:30px;height:30px;stroke-width:2.4}
.done-box h2{margin:0 0 6px!important}
@media (max-width:699px){.wallet b{font-size:22px}.wallet{gap:8px}.wallet>div{padding:10px 12px}.starcard .n{font-size:20px}}

@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
`);

export const APP_JS = squeezeJs(String.raw`(function () {
"use strict";
var API = "/x/board/api/";
var me = { name: "", people: [] };
function $(id) { return document.getElementById(id); }
function mq(q) { return window.matchMedia ? window.matchMedia(q) : { matches: false }; }
function onMq(m, f) { if (m.addEventListener) m.addEventListener("change", f); else if (m.addListener) m.addListener(f); }
var WIDE = mq("(min-width: 700px)"), FINE = mq("(hover: hover) and (pointer: fine)"), CALM = mq("(prefers-reduced-motion: reduce)");

// ---------- tiny helpers: elements, icons, storage, server ----------
function h(tag, props) {
  var el = document.createElement(tag), k, v, i;
  props = props || {};
  for (k in props) {
    v = props[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "value") el.value = v;
    else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (i = 2; i < arguments.length; i++) add(el, arguments[i]);
  return el;
}
function add(el, c) {
  if (c === undefined || c === null || c === false || c === "") return;
  if (Array.isArray(c)) { c.forEach(function (x) { add(el, x); }); return; }
  el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
function swap(root, node) { var y = window.pageYOffset; clear(root); add(root, node); if (y) window.scrollTo(0, y); }
var ICO = null;
function icon(name) {
  if (!ICO) { var t = $("ic"); ICO = t && t.content.firstChild; }
  if (!ICO) return h("span");
  var s = document.importNode(ICO, true);
  s.firstChild.setAttribute("href", "#i-" + name);
  return s;
}
var store = {
  get: function (k, d) { try { var v = window.localStorage.getItem("board." + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { window.localStorage.setItem("board." + k, JSON.stringify(v)); } catch (e) {} }
};
function api(path, body) {
  var init = { credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) { init.method = "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(API + path, init).then(null, function () { throw new Error("连不上看板，检查一下网络"); }).then(function (r) {
    if (r.status === 401) { gone("这个看板只给群友看。在群里对 Bot 说“给我看板链接”，点它发来的链接就能进来。"); throw new Error("401"); }
    return r.json().then(null, function () { return { ok: false, error: "服务器没回好，稍后再试" }; }).then(function (j) {
      if (!j.ok) throw new Error(j.error || "出错了");
      return j;
    });
  });
}
function gone(text) {
  document.body.className = "";
  clear(document.body).appendChild(h("main", { class: "gone" }, h("p", { text: text })));
}
var toastT = 0;
function toast(text, bad) {
  var t = $("toast"); t.textContent = text; t.className = "toast show" + (bad === "win" ? " win" : bad ? " bad" : "");
  clearTimeout(toastT); toastT = setTimeout(function () { t.className = "toast" + (bad === "win" ? " win" : bad ? " bad" : ""); }, bad === true ? 6000 : 3000);
}
function fail(e) { if (e && e.message !== "401") toast(e.message || "出错了", true); }

// ---------- time ----------
var WEEK = "日一二三四五六";
function pad(n) { return (n < 10 ? "0" : "") + n; }
function hm(d) { return pad(d.getHours()) + ":" + pad(d.getMinutes()); }
function exact(ts) { var d = new Date(ts); return d.getFullYear() + "年" + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + WEEK.charAt(d.getDay()) + " " + hm(d); }
function md(ts) { var d = new Date(ts), s = (d.getMonth() + 1) + "月" + d.getDate() + "日"; return d.getFullYear() === new Date().getFullYear() ? s : d.getFullYear() + "年" + s; }
function ago(ts) {
  if (!ts) return "还没有";
  var m = Math.round((Date.now() - ts) / 60000), d = new Date(ts);
  if (m < -1440) return Math.round(-m / 1440) + " 天后";
  if (m < -60) return Math.round(-m / 60) + " 小时后";
  if (m < 0) return -m + " 分钟后";
  if (m < 1) return "刚刚";
  if (m < 60) return m + " 分钟前";
  if (m < 360) return Math.round(m / 60) + " 小时前";
  var dd = dayDiff(localDay(new Date()), localDay(d));
  if (dd === 0) return "今天 " + hm(d);
  if (dd === 1) return "昨天 " + hm(d);
  if (dd < 7) return dd + " 天前";
  return md(ts);
}
function span(ms) {
  if (!(ms > 0)) return "";
  if (ms < 5400000) return Math.max(1, Math.round(ms / 60000)) + " 分钟";
  if (ms < 129600000) return String(Math.round(ms / 360000) / 10).replace(/\.0$/, "") + " 小时";
  var d = ms / 86400000, w = Math.floor(d);
  return w + " 天" + (d - w >= 0.4 && d - w < 0.9 ? "半" : "");
}
function rt(ts, pre, post) { return h("time", { class: "rt", datetime: new Date(ts).toISOString(), title: exact(ts), "data-ts": String(ts), "data-p": pre || "", "data-s": post || "", text: (pre || "") + ago(ts) + (post || "") }); }
function localDay(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
function today() { return localDay(new Date()); }
function dayDiff(a, b) { function u(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); } return Math.round((u(a) - u(b)) / 86400000); }
function dayTitle(s) { var p = s.split("-"), d = new Date(+p[0], +p[1] - 1, +p[2]); return (+p[1]) + "月" + (+p[2]) + "日 周" + WEEK.charAt(d.getDay()); }
function relDay(s) { var n = dayDiff(today(), s); return n === 0 ? "今天" : n === 1 ? "昨天" : n === 2 ? "前天" : ""; }

// ---------- shared pieces ----------
function empty(title, hint) { return h("div", { class: "empty" }, h("b", { text: title }), hint ? h("span", { text: hint }) : null); }
function skel(kind, n) { var w = h("div", { class: "skel " + (kind || ""), "aria-hidden": "true" }); for (var i = 0; i < (n || 6); i++) w.appendChild(h("i")); return w; }
function card(cls, title, go, goText) {
  var b = h("div", { class: "card-b" });
  var el = h("section", { class: "card " + (cls || "") }, title ? h("div", { class: "card-h" }, h("h2", { text: title }), go ? h("a", { class: "go", href: go }, goText || "全部", icon("right")) : null) : null, b);
  return { el: el, b: b };
}
function badge(kind, text, ic) { return h("span", { class: "badge " + (kind || "") }, ic ? icon(ic) : null, text); }
function initial(name) { name = String(name || "").replace(/的本地\s*AI$/i, ""); return !name ? "?" : /[\u4e00-\u9fff]$/.test(name) ? name.slice(-1) : name.charAt(0).toUpperCase(); }
function avatar(name, sm) { return h("span", { class: "av" + (sm ? " sm" : "") + (name ? "" : " none"), "aria-hidden": "true", text: initial(name) }); }
function meter(pct, stopPct) {
  var p = Math.max(0, Math.min(100, pct || 0)), fill = h("i", { class: "fill" });
  var cls = stopPct && p >= stopPct ? "bad" : stopPct && p >= stopPct * 0.75 ? "warn" : "";
  var el = h("span", { class: "meter " + cls, role: "img", "aria-label": "已用 " + (pct || 0) + "%" }, fill);
  fill.style.width = p + "%";
  if (stopPct) { var s = h("i", { class: "stop" }); s.style.left = Math.min(100, stopPct) + "%"; el.appendChild(s); }
  return el;
}
function copy(text, btn) {
  function done(ok) { toast(ok ? "已复制" : "复制失败，长按文字手动复制", !ok); if (btn) btn.blur(); }
  function legacy() {
    var ta = h("textarea", { readonly: true, class: "vh" }); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); return ok;
  }
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacy()); });
  else done(legacy());
}
function copyBtn(text, label) {
  var b = label ? h("button", { type: "button", class: "btn sm" }, icon("copy"), label) : h("button", { type: "button", class: "ib", "aria-label": "复制", title: "复制" }, icon("copy"));
  b.addEventListener("click", function () { copy(typeof text === "function" ? text() : text, b); });
  return b;
}
function seg(items, value, onPick, full) {
  var el = h("div", { class: "seg" + (full ? " full" : ""), role: "tablist" });
  items.forEach(function (it) {
    var b = h("button", { type: "button", role: "tab", "aria-selected": it[0] === value ? "true" : "false" }, it[1], it[2] !== undefined ? h("span", { class: "n", text: String(it[2]) }) : null);
    b.addEventListener("click", function () { el.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-selected", x === b ? "true" : "false"); }); onPick(it[0]); });
    el.appendChild(b);
  });
  return el;
}
function chips(items, value, onPick) {
  var el = h("div", { class: "chips" });
  items.forEach(function (it) {
    var b = h("button", { type: "button", "aria-pressed": it[0] === value ? "true" : "false" }, it[1]);
    b.addEventListener("click", function () { el.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", x === b ? "true" : "false"); }); onPick(it[0]); });
    el.appendChild(b);
  });
  return el;
}
function searchBox(ph, val, onInput) {
  var q = h("input", { type: "search", placeholder: ph, "aria-label": ph, value: val || "", "data-search": "1", enterkeyhint: "search" });
  q.addEventListener("input", function () { onInput(q.value); });
  return { el: h("label", { class: "search" }, icon("search"), q), input: q };
}
function marked(text, q) {
  if (!q) return [text];
  var out = [], low = text.toLowerCase(), i = 0, j;
  while ((j = low.indexOf(q, i)) >= 0) { out.push(text.slice(i, j)); out.push(h("mark", { text: text.slice(j, j + q.length) })); i = j + q.length; }
  out.push(text.slice(i));
  return out;
}
function extOf(name) { var m = /\.([a-z0-9]{1,5})$/i.exec(name || ""); return m ? m[1].toUpperCase() : "文件"; }

// ---------- overlays: popover, drawer, sheet ----------
var POP = { anchor: null };
function popOpen(anchor, content) {
  popClose(false);
  var p = $("pop"); clear(p).appendChild(content); p.hidden = false;
  var r = anchor.getBoundingClientRect(), pw = p.offsetWidth, ph = p.offsetHeight;
  var left = Math.max(8, Math.min(r.right - pw, window.innerWidth - pw - 8)), top = r.bottom + 6;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  p.style.left = left + "px"; p.style.top = top + "px";
  POP.anchor = anchor; anchor.setAttribute("aria-expanded", "true");
  var f = p.querySelector("[aria-checked=true], button, a"); if (f) f.focus();
}
function popClose(refocus) {
  var p = $("pop"); if (p.hidden) return false;
  p.hidden = true; clear(p);
  if (POP.anchor) { POP.anchor.setAttribute("aria-expanded", "false"); if (refocus !== false) POP.anchor.focus(); }
  POP.anchor = null; return true;
}
function menuKeys(menu) {
  menu.addEventListener("keydown", function (e) {
    var items = [].slice.call(menu.querySelectorAll("button")), i = items.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  });
  return menu;
}
var DW = { key: "", from: null, back: false };
function drawerOpen(key, kicker) {
  var d = $("drawer");
  if (d.hidden) DW.from = document.activeElement;
  DW.key = key; $("dw-kicker").textContent = kicker || "";
  d.hidden = false; document.body.classList.add("lock");
  requestAnimationFrame(function () { d.classList.add("on"); });
  var body = clear($("dw-body")); body.scrollTop = 0;
  setTimeout(function () { if (!d.contains(document.activeElement)) $("dw-x").focus(); }, 30);
  return body;
}
function drawerClose() {
  var d = $("drawer"); if (d.hidden) return false;
  d.hidden = true; d.classList.remove("on"); DW.key = ""; document.body.classList.remove("lock");
  if (DW.from && DW.from.focus && document.contains(DW.from)) DW.from.focus();
  return true;
}
// Closing a task leaves its hash; going back keeps the browser history tidy when the drawer was opened by a click here.
function leaveDrawer() { if (DW.back) { DW.back = false; history.back(); } else location.replace("#" + cur); }
function sheet(open) {
  var s = $("more"); s.hidden = !open; $("more-btn").setAttribute("aria-expanded", open ? "true" : "false");
  if (open) { var a = s.querySelector("a"); if (a) a.focus(); }
}
function trap(e, box) {
  var f = [].slice.call(box.querySelectorAll("a[href], button:not([disabled]), input, select, textarea, summary, [tabindex]")).filter(function (x) { return x.offsetParent !== null; });
  if (!f.length) return;
  var a = f[0], z = f[f.length - 1];
  if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
  else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
}

// ---------- 概览 ----------
var SL = { open: "没开始", doing: "进行中", done: "完成", dropped: "不做了" };
function dueInfo(t) {
  if (!t.due) return null;
  var live = t.status === "open" || t.status === "doing", n = dayDiff(t.due, today()), d = t.due.split("-");
  var label = (+d[1]) + "月" + (+d[2]) + "日";
  if (!live) return { cls: "", text: label + "截止" };
  if (n < 0) return { cls: "late", text: "过期 " + (-n) + " 天", ic: "alert", title: label + "截止" };
  if (n === 0) return { cls: "soon", text: "今天到期", ic: "clock" };
  if (n === 1) return { cls: "soon", text: "明天到期", ic: "clock" };
  if (n < 7) return { cls: "", text: "还剩 " + n + " 天", ic: "clock", title: label + "截止" };
  return { cls: "", text: label + "截止", ic: "clock" };
}
function dueChip(t) { var d = dueInfo(t); return d ? h("span", { class: "due " + d.cls, title: d.title || null }, d.ic ? icon(d.ic) : null, d.text) : null; }
function isMine(t) { return !!me.name && (t.owner === me.name || t.claimed_by === me.name); }
function byDue(a, b) { var x = a.due || "9999", y = b.due || "9999"; return x < y ? -1 : x > y ? 1 : b.id - a.id; }
function taskRow(t) {
  return h("a", { class: "trow", href: "#tasks/" + t.id }, h("span", { class: "sdot " + t.status, title: SL[t.status] }), h("span", { class: "tt" }, t.title, h("span", { class: "vh", text: "，" + SL[t.status] })),
    h("span", { class: "side-m" }, dueChip(t), t.owner && !isMine(t) ? avatar(t.owner, true) : null));
}
function home(root) {
  return api("overview").then(function (j) {
    var c = j.tasks.counts, list = j.tasks.list;
    var who = whoCard(j.team), pulse = pulseCard(j.team, c, j.me, j.latest);

    var tk = card("c-tasks", "我的任务", "#tasks", "全部任务");
    var mine = list.filter(isMine).sort(function (a, b) { return (a.status === "doing" ? 0 : 1) - (b.status === "doing" ? 0 : 1) || byDue(a, b); });
    if (mine.length) mine.slice(0, 6).forEach(function (t) { tk.b.appendChild(taskRow(t)); });
    else tk.b.appendChild(empty("你手上没有任务", "在任务页领一个，或者让 Bot 派给你。"));
    if (mine.length > 6) tk.b.appendChild(h("p", { class: "meta", text: "还有 " + (mine.length - 6) + " 个" }));
    var soon = list.filter(function (t) { return !isMine(t) && t.due && dayDiff(t.due, today()) <= 3; }).sort(byDue);
    if (soon.length) { tk.b.appendChild(h("h3", { class: "sub", text: "别人快到期的" })); soon.slice(0, 4).forEach(function (t) { tk.b.appendChild(taskRow(t)); }); }

    var dy = card("c-day", "群聊小结", "#feed", "全部");
    if (!j.days.length) dy.b.appendChild(empty("还没有整理过的日子", "每天夜里 Bot 把当天的群聊整理成一段。"));
    j.days.forEach(function (d, i) {
      var rel = relDay(d.date);
      var box = h("div", { class: i ? "day2" : "day1" }, h("h3", {}, dayTitle(d.date), rel ? h("span", { class: "meta", text: rel }) : null),
        h("p", { class: "clamp" + (i ? " c2" : ""), text: d.summary }));
      if (!i) box.appendChild(h("a", { class: "go", href: "#feed/" + d.date, text: "看这天全文" }));
      dy.b.appendChild(box);
    });

    var rp = card("c-repos", "仓库检查", "#repos", "详情");
    if (!j.repos.length) rp.b.appendChild(empty("还没有要检查的仓库"));
    else {
      var rc = h("div", { class: "rchips" });
      j.repos.slice().sort(function (a, b) { return (a.ok === 0 ? 0 : 1) - (b.ok === 0 ? 0 : 1); }).forEach(function (r) {
        var st = repoState(r);
        rc.appendChild(h("a", { class: "rchip", href: "#repos", title: r.commit || "" }, h("span", { class: "mark " + st.cls }, icon(st.ic)),
          h("span", {}, h("span", { class: "nm", text: r.repo }), h("span", { class: "meta" }, st.word, r.ok === 0 && r.failing_since ? [" · ", rt(r.failing_since, "", "起")] : r.checked_at ? [" · ", rt(r.checked_at)] : null))));
      });
      rp.b.appendChild(rc);
    }

    var pc = card("c-pics", "最新图片", "#works", "全部图片");
    if (!j.images.length) pc.b.appendChild(empty("还没有图片"));
    else {
      var strip = h("div", { class: "strip" });
      j.images.forEach(function (p, i) { strip.appendChild(h("button", { type: "button", "aria-label": "看大图：" + (p.note || p.ref), onclick: function () { lbOpen(j.images, i, null); } }, h("img", { src: p.url, alt: "", loading: "lazy", decoding: "async" }))); });
      pc.b.appendChild(strip);
    }

    var mo = card("c-mon", "网站在线", "#watch", "详情");
    if (!j.uptime.length) mo.b.appendChild(empty("没有在盯的网站", "在群里说“盯一下我们网站能不能打开”就会加上。"));
    else {
      var down = j.uptime.filter(function (u) { return u.active && u.state === "down"; });
      if (!down.length) mo.b.appendChild(h("p", { class: "allup" }, h("span", { class: "dot" }), "全部正常"));
      j.uptime.forEach(function (u) { mo.b.appendChild(monRow(u)); });
    }

    var pl = card("c-plan", "本月额度", "#watch", "详情");
    if (!j.plan) pl.b.appendChild(empty("额度数据暂时读不到"));
    else { pl.b.appendChild(h("p", { class: "meta", text: j.plan.cycle })); pl.b.appendChild(planRows(j.plan.items, true)); }

    var sp = card("c-spend", "今天花的钱", "#watch", "明细");
    sp.b.appendChild(spendBlock(j.spend, 3));

    swap(root, h("div", { class: "ov" }, who, pulse, tk.el, dy.el, rp.el, pc.el, mo.el, pl.el, sp.el));
  });
}
function titled(name, title) { return [name, title ? h("span", { class: "ttl", title: "用积分换的头衔", text: title }) : null]; }
function starMark(on) { return on ? h("span", { class: "star", title: "本周之星：这周分数最高" }, icon("star"), "本周之星") : null; }
function sizeTag(sz) { return sz === "big" ? h("span", { class: "sz big", text: "大活" }) : sz === "small" ? h("span", { class: "sz", text: "小事" }) : null; }
function whoCard(team) {
  var c = card("c-who", "谁在做什么", "#team", "战绩");
  var ps = team ? team.people : [];
  if (!ps.length) { c.b.appendChild(empty("还没有人接过任务", "在任务页点“我来做”，这里就会显示谁在忙什么。")); return c.el; }
  var grid = h("div", { class: "people" });
  ps.forEach(function (p) {
    var col = h("div", { class: "pcol" + (p.doing.length ? "" : " free") }, h("div", { class: "pname" }, avatar(p.name), h("span", {}, titled(p.name + (p.name === me.name ? "（我）" : ""), p.title)), starMark(team.mvp === p.name)));
    if (!p.doing.length) col.appendChild(h("p", { class: "freet", text: "空闲" + (p.waiting ? "，有 " + p.waiting + " 件等着开始" : "") }));
    p.doing.forEach(function (d) {
      col.appendChild(h("a", { class: "on", href: "#tasks/" + d.id }, h("span", { class: "tt" }, sizeTag(d.size), d.size === "normal" ? null : " ", d.title),
        h("span", { class: "meta" }, rt(d.since, "", "接的"), d.by_ai ? badge("", "本地 AI 在做", "bolt") : null, d.overdue ? badge("bad", "过期了", "alert") : null)));
    });
    if (p.doing.length && p.waiting) col.appendChild(h("p", { class: "meta", text: "还有 " + p.waiting + " 件没开始" }));
    grid.appendChild(col);
  });
  c.b.appendChild(grid);
  return c.el;
}
function weekBars(by) {
  var max = Math.max.apply(null, by.concat([1])), td = (new Date().getDay() + 6) % 7;
  return h("div", { class: "bars", role: "img", "aria-label": "这周每天做完：" + by.join("、") }, by.map(function (n, i) {
    var b = h("i", { class: n ? "" : "z", title: "周" + "一二三四五六日".charAt(i) + " 做完 " + n + " 件" }); b.style.height = Math.max(3, n / max * 44) + "px";
    return h("span", { class: i === td ? "td" : "" }, n ? String(n) : "", b, "一二三四五六日".charAt(i));
  }));
}
function pulseCard(team, c, mineNow, latest) {
  var k = card("c-pulse", "这周", "#team", "排行");
  if (!team) { k.b.appendChild(empty("战绩暂时读不到")); return k.el; }
  var w = team.week;
  k.b.appendChild(h("div", { class: "pulse" }, h("div", { class: "pnum" }, h("b", { class: "big", text: String(w.done) }), h("span", { text: "件做完" })),
    h("div", { class: "pnum" }, h("b", { class: "big", text: String(w.points) }), h("span", { text: "分" })),
    team.mvp ? h("div", { class: "pnum" }, h("span", { class: "star" }, icon("star"), "本周之星"), h("b", { text: team.mvp })) : null));
  k.b.appendChild(weekBars(w.by_day));
  var top = team.people.filter(function (p) { return p.points_week; }).slice(0, 3), max = top.length ? top[0].points_week : 1;
  if (top.length) k.b.appendChild(h("div", { class: "wk" }, top.map(function (p) { return h("div", { class: "spl" }, h("span", { class: "w", text: p.name }), meter(p.points_week / max * 100), h("span", { class: "num meta", text: p.points_week + " 分" })); })));
  else k.b.appendChild(h("p", { class: "meta", text: "这周还没人得分。做完一件，Bot 会在群里夸你。" }));
  if (mineNow) k.b.appendChild(h("p", { class: "mybal" }, "我本周 ", h("b", { text: mineNow.points_week + " 分" }), " · 可用 ", h("b", { text: mineNow.balance + " 分" }), h("a", { href: "#shop", class: "go" }, "兑换", icon("right"))));
  if (latest) k.b.appendChild(h("a", { class: "latest", href: latest.kind === "boss" ? "#tasks/" + latest.task : "#wall" }, icon(latest.kind === "boss" ? "wall" : "medal"),
    h("span", {}, h("b", { text: "最新功勋 " }), latest.who + (latest.kind === "boss" ? " 拿下大活「" + latest.title + "」" : " 拿到徽章「" + latest.title + "」"), " · ", rt(latest.at))));
  k.b.appendChild(h("p", { class: "tot" }, h("span", {}, "进行中 ", h("b", { text: String(c.doing) })), h("span", {}, "没开始 ", h("b", { text: String(c.open) })),
    h("span", { class: c.overdue ? "bad-t" : "" }, "过期 ", h("b", { class: c.overdue ? "bad-t" : "", text: String(c.overdue) }))));
  return k.el;
}
function repoState(r) {
  if (r.ok === 1) return { cls: "ok", ic: "check", word: "通过" };
  if (r.ok === 0) return { cls: "bad", ic: "x", word: "没通过" };
  return { cls: "", ic: "dash", word: r.result || "还没检查过" };
}
function monState(u) {
  if (!u.active) return { cls: "off", word: "停了", t: "" };
  if (u.state === "down") return { cls: "down", word: "打不开", t: "bad-t" };
  if (u.state === "up") return { cls: "", word: "正常", t: "ok-t" };
  return { cls: "unk", word: "确认中", t: "" };
}
function monRow(u) {
  var s = monState(u);
  return h("div", { class: "mrow" }, h("span", { class: "dot " + s.cls, "aria-hidden": "true" }), h("span", { class: "nm", text: u.name, title: u.url }),
    h("span", { class: "meta " + s.t }, s.word, u.state === "down" && u.since ? [" · ", rt(u.since, "", "起")] : u.uptime_7d !== null && u.uptime_7d !== undefined ? " · 7 天 " + u.uptime_7d + "%" : null));
}
function planLabel(what) { var daily = /（今天）$/.test(what); return what.split(/[，（]/)[0] + (daily ? " · 今天" : ""); }
function planRows(items, compact) {
  var box = h("div", { class: "plan-cols" });
  items.forEach(function (i) {
    var stopPct = i.stop_at ? Math.round(i.stop_at / i.included * 1000) / 10 : 0;
    var row = h("div", { class: "prow", title: i.what }, h("span", { class: "lbl", text: planLabel(i.what) }), meter(i.percent_of_included, stopPct),
      h("span", { class: "pct" + (stopPct && i.percent_of_included >= stopPct * 0.75 ? " warn-t" : ""), text: i.percent_of_included + "%" }));
    if (!compact) row.appendChild(h("span", { class: "meta", text: "已用 " + i.used + " / " + i.included + " " + i.unit + (i.stop_at ? "，到 " + i.stop_at + " 停" : "") + (i.whole_cycle_estimate_percent ? "，整月约 " + i.whole_cycle_estimate_percent + "%" : "") }));
    box.appendChild(row);
  });
  return h("div", {}, box, h("p", { class: "legend" }, h("i"), "竖线是停止线，用到那里就停，不会多收钱"));
}
function spendBlock(s, top) {
  if (!s) return empty("花费数据暂时读不到");
  var box = h("div", {}, h("p", {}, h("span", { class: "big", text: s.today === null ? "—" : "¥" + s.today.toFixed(2) })),
    h("p", { class: "meta", text: s.yesterday === null ? "按官方价格估算，北京时间算一天" : "昨天 ¥" + s.yesterday.toFixed(2) + " · 按官方价格估算" }));
  var items = s.items.slice(0, top || 12), max = items.reduce(function (m, i) { return Math.max(m, i.cny); }, 0) || 1;
  if (items.length) {
    var ul = h("div", { class: "spl-list" });
    items.forEach(function (i) { ul.appendChild(h("div", { class: "spl" }, h("span", { class: "w", text: i.what, title: i.via + " · " + i.calls + " 次" }), meter(i.cny / max * 100), h("span", { class: "num meta", text: "¥" + i.cny.toFixed(2) }))); });
    box.appendChild(h("div", { class: "spl-wrap" }, ul));
  } else box.appendChild(h("p", { class: "meta", text: "今天还没有花钱的调用。" }));
  return box;
}

// ---------- 战绩 ----------
var EVW = { add: "记下了", claim: "接了", progress: "写了进展", done: "做完了", drop: "不做了", release: "放下了", reopen: "重新打开了", edit: "改了" };
var EVI = { add: "plus", claim: "right", progress: "feed", done: "check", drop: "x", release: "left", reopen: "refresh", edit: "dots" };
var TM = { board: store.get("board", "week") };
function mine() {
  return api("team").then(function (j) {
    var p = null; j.people.forEach(function (x) { if (x.name === me.name) p = x; });
    var line = p ? "本周 " + p.points_week + " 分 · 可用 " + p.balance + " 分" + (p.streak ? " · 连续 " + p.streak + " 天" : "") + " · 手上 " + (p.doing.length + p.waiting) + " 件" : "还没接过任务";
    $("mine").textContent = line; $("av").title = me.name + "：" + line;
    return j;
  }).then(null, function () { return null; });
}
function team(root) {
  return Promise.all([api("team"), api("events?n=30"), api("tasks?status=done&n=200")]).then(function (r) {
    var j = r[0], ev = r[1], done = r[2].tasks, p = null;
    j.people.forEach(function (x) { if (x.name === me.name) p = x; });
    var mecard = h("div", { class: "mecard", "aria-label": "我的" },
      [[p ? p.points_week : 0, "本周分数"], [p ? p.streak : 0, "连续天数"], [p ? p.doing.length + p.waiting : 0, "手上的任务"], [p ? p.points_total : 0, "总分"]].map(function (x) { return h("div", {}, h("b", { text: String(x[0]) }), h("span", { text: x[1] })); }));
    var left = h("div"), right = h("div");
    if (!j.people.length || !j.people.some(function (x) { return x.done_total; })) left.appendChild(h("div", { class: "card" }, empty("还没有人做完任务", "做完一件，Bot 会在群里夸你；每周日晚上它会发一份团队周报。")));
    else {
      var lbc = card("", "排行"), list = h("div");
      var pick = seg([["week", "本周"], ["all", "总榜"]], TM.board, function (v) { TM.board = v; store.set("board", v); drawLb(); });
      lbc.el.querySelector(".card-h").appendChild(pick);
      function drawLb() {
        var wk = TM.board === "week", ps = j.people.slice().sort(function (a, b) { return wk ? b.points_week - a.points_week || b.done_week - a.done_week : b.points_total - a.points_total || b.done_total - a.done_total; });
        var max = Math.max.apply(null, ps.map(function (x) { return wk ? x.points_week : x.points_total; }).concat([1]));
        swap(list, ps.map(function (x, i) {
          var pts = wk ? x.points_week : x.points_total;
          return h("div", { class: "lb-row" + (i === 0 && pts ? " top" : "") }, h("span", { class: "rk", text: String(i + 1) }),
            h("span", { class: "nm" }, avatar(x.name, true), titled(x.name, x.title), j.mvp === x.name ? starMark(true) : null), h("span", { class: "pts" }, String(pts), h("small", { text: " 分" })),
            meter(pts / max * 100), h("span", { class: "meta", text: "做完 " + (wk ? x.done_week : x.done_total) + " 件 · " + (x.streak ? "连续 " + x.streak + " 天" : "最长连续 " + x.best_streak + " 天") }));
        }));
      }
      drawLb(); lbc.b.appendChild(list); left.appendChild(lbc.el);
      var grid = h("div", { class: "people" });
      grid.style.marginTop = "16px";
      j.people.forEach(function (x) {
        var c = h("section", { class: "card" }, h("div", { class: "pname" }, avatar(x.name), h("span", {}, titled(x.name, x.title)), starMark(j.mvp === x.name)),
          h("p", { class: "meta", text: "共 " + x.points_total + " 分 · 做完 " + x.done_total + " 件 · 这个月 " + x.done_month + " 件" + (x.fastest_ms ? " · 最快 " + span(x.fastest_ms) : "") }));
        var b = h("div", { class: "badges" });
        x.badges.filter(function (g) { return g.earned; }).concat(x.badges.filter(function (g) { return !g.earned; }).slice(0, 3)).forEach(function (g) {
          b.appendChild(h("span", { class: "bdg" + (g.earned ? "" : " no"), tabindex: "0", title: g.what + (g.earned ? (g.at ? "，" + md(g.at) + " 拿到" : "") : "，还没拿到") }, g.earned ? icon("star") : null, g.name, g.earned ? null : h("span", { class: "vh", text: "：" + g.what })));
        });
        c.appendChild(b);
        var rec = done.filter(function (t) { return t.done_by === x.name; }).sort(function (a, b) { return b.done_at - a.done_at; }).slice(0, 3);
        if (rec.length) c.appendChild(h("ul", { class: "recent" }, rec.map(function (t) { return h("li", {}, h("a", { href: "#tasks/" + t.id, text: t.title }), h("span", { class: "meta" }, "+" + t.points + " · ", rt(t.done_at))); })));
        grid.appendChild(c);
      });
      left.appendChild(grid);
    }
    var sc = card("", "大家最近做的事"), stream = h("div"), more = h("button", { type: "button", class: "btn", hidden: !ev.more }, "更早的"), lastDay = "", last = 0;
    function addEvents(list) {
      list.forEach(function (e) {
        var d = localDay(new Date(e.ts));
        if (d !== lastDay) { lastDay = d; stream.appendChild(h("h3", { class: "ev-day", text: (relDay(d) ? relDay(d) + " · " : "") + dayTitle(d) })); }
        var isDone = e.kind === "done";
        stream.appendChild(h("div", { class: "ev" + (isDone ? " done" : "") }, h("span", { class: "k", "aria-hidden": "true" }, icon(EVI[e.kind] || "dots")),
          h("span", {}, h("b", { text: e.who || "有人" }), " " + (EVW[e.kind] || "改了") + " ", h("a", { href: "#tasks/" + e.task, text: "#" + e.task + " " + e.title }),
            e.kind === "progress" && e.text ? h("span", { class: "meta", text: e.text.slice(0, 140) }) : null, h("span", { class: "meta" }, rt(e.ts)))));
        last = e.ts;
      });
    }
    addEvents(ev.events);
    if (!ev.events.length) stream.appendChild(empty("还没有动静", "有人接任务、写进展、做完，都会记在这里。"));
    more.addEventListener("click", function () { more.disabled = true; api("events?n=30&before=" + last).then(function (k) { addEvents(k.events); more.hidden = !k.more; more.disabled = false; }, function (e) { more.disabled = false; fail(e); }); });
    sc.b.appendChild(stream); sc.b.appendChild(h("div", { class: "more-row" }, more));
    right.appendChild(sc.el);
    var links = h("div", { class: "row" }, h("a", { class: "btn pri", href: "#shop" }, icon("shop"), "用积分兑换" + (p ? "（可用 " + p.balance + " 分）" : "")), h("a", { class: "btn", href: "#wall" }, icon("wall"), "功勋墙"));
    links.style.margin = "-4px 0 20px";
    swap(root, [h("h2", { class: "sub", text: "我的战绩" }), mecard, links, h("div", { class: "teamw" }, left, right)]);
  });
}

// ---------- 功勋墙 ----------
function weekName(ws) { var d = new Date(ws), e = new Date(ws + 6 * 86400000); return (d.getMonth() + 1) + "月" + d.getDate() + "日–" + (d.getMonth() === e.getMonth() ? "" : (e.getMonth() + 1) + "月") + e.getDate() + "日"; }
function wallView(root) {
  return api("wall").then(function (j) {
    var tt = {}; j.titles.forEach(function (x) { if (!tt[x.who]) tt[x.who] = x.title; });
    function who(n, sm) { return h("span", { class: "who-n" }, avatar(n, sm), " ", titled(n, tt[n])); }
    var held = j.badges.some(function (b) { return b.holders.length; });
    if (!j.current && !j.stars.length && !j.bosses.length && !held) {
      swap(root, h("div", { class: "card" }, h("div", { class: "empty" }, h("b", { text: "功勋墙还空着" }),
        h("span", { text: "做完任务就有分。每周分数最高的人是本周之星，拿下大活、解锁徽章、创下纪录，都会挂在这里。" })), h("a", { class: "btn pri", href: "#tasks" }, "去接一件任务")));
      return;
    }
    var out = [];
    var star = j.current;
    var sc = h("section", { class: "card starcard" }, h("span", { class: "big-star", "aria-hidden": "true" }, icon("star")),
      star ? h("div", {}, h("div", { class: "k", text: "本周之星 · " + weekName(star.week) }), h("div", { class: "n" }, titled(star.who, star.title || tt[star.who])), h("div", { class: "meta", text: "这周 " + star.points + " 分，做完 " + star.done + " 件" }))
        : h("div", {}, h("div", { class: "k", text: "本周之星" }), h("div", { class: "n", text: "还空着" }), h("div", { class: "meta", text: "这周第一个做完任务的人先上。" })));
    var roll = card("", "历届本周之星");
    if (!j.stars.length) roll.b.appendChild(h("p", { class: "meta", text: "每周日晚上记下这周的之星，第一位会出现在这里。" }));
    else roll.b.appendChild(h("ul", { class: "list roll" }, j.stars.map(function (x) {
      var kids = [h("span", { class: "star", "aria-hidden": "true" }, icon("star")), h("span", { class: "w" }, who(x.who, true)), h("span", { class: "meta", text: weekName(x.week) + " · " + x.points + " 分" })];
      // The certificate printed for that week, kept as a picture.
      if (x.cert) kids.push(h("a", { class: "meta", href: "/x/board/img/" + String(x.cert).replace(/^g/, ""), target: "_blank", rel: "noopener", text: "看奖状" }));
      return h.apply(null, ["li", {}].concat(kids));
    })));
    out.push(h("div", { class: "hero" }, sc, roll.el));
    var bs = h("div", { class: "sect" }, h("h2", {}, "拿下的大活", h("span", { class: "n", text: String(j.bosses.length) })));
    if (!j.bosses.length) bs.appendChild(h("div", { class: "card" }, empty("还没有人拿下大活", "大活值 30 分，拿下就挂在这里，带上是谁、用了多久。")));
    else bs.appendChild(h("div", { class: "trophies" }, j.bosses.map(function (b) {
      return h("a", { class: "trophy", href: "#tasks/" + b.id }, icon("wall"), h("span", { class: "sz big", text: "大活" }), h("h3", { text: b.title }), h("span", { class: "by" }, who(b.who)),
        h("span", { class: "meta" }, md(b.done_at) + " 拿下" + (b.took ? "，用了 " + b.took : "")));
    })));
    out.push(bs);
    if (j.records.length) out.push(h("div", { class: "sect" }, h("h2", { text: "纪录" }), h("div", { class: "records" }, j.records.map(function (r) {
      var el = h("div", { class: "rec" }, h("span", { text: r.what }), h("b", { text: r.value }), h("span", { class: "who" }, avatar(r.who, true), titled(r.who, tt[r.who])));
      return r.task ? h("a", { href: "#tasks/" + r.task, class: "plain" }, el) : el;
    }))));
    var cab = j.badges.slice().sort(function (a, b) { return (b.holders.length ? 1 : 0) - (a.holders.length ? 1 : 0); });
    out.push(h("div", { class: "sect" }, h("h2", {}, "徽章柜", h("span", { class: "n", text: j.badges.filter(function (b) { return b.holders.length; }).length + " / " + j.badges.length + " 有人拿到" })),
      h("div", { class: "cabinet" }, cab.map(function (b) {
        var on = b.holders.length;
        return h("div", { class: "medal" + (on ? " got" : " open") }, h("span", { class: "m", "aria-hidden": "true" }, icon(on ? "medal" : "star")),
          h("div", {}, h("b", { text: b.name }), h("span", { class: "meta", text: on ? b.what : "还没人拿到 · " + b.what }),
            on ? h("div", { class: "holders" }, b.holders.map(function (x) { return h("span", {}, avatar(x.who, true), x.who, h("span", { class: "meta", text: x.at ? md(x.at) + " 起" : "" })); })) : null));
      }))));
    if (j.titles.length) out.push(h("div", { class: "sect" }, h("h2", { text: "正在挂着的头衔" }), h("div", { class: "card" }, h("ul", { class: "list" }, j.titles.map(function (x) { return h("li", { class: "row" }, who(x.who, true), h("span", { class: "meta" }, rt(x.until, "", "摘下"))); })))));
    swap(root, h("div", { class: "wall" }, out));
  });
}

// ---------- 兑换 ----------
var SHOP = null;
var KINDW = { now: "Bot 马上兑现", timed: "持续几天", weekly: "下期周报兑现", manual: "要人来兑现" };
var STW = { pending: ["warn", "待兑现"], done: ["ok", "已兑现"], refunded: ["", "已退分"] };
function shopView(root) {
  return api("shop").then(function (j) {
    SHOP = j;
    var w = j.me;
    var wallet = h("div", { class: "wallet" }, h("div", {}, h("b", { text: String(w.earned) }), h("span", { text: "一共挣到" })), h("div", {}, h("b", { text: String(w.spent) }), h("span", { text: "已经花掉" })),
      h("div", { class: "left" }, h("b", { text: String(w.balance) }), h("span", { text: "现在可用" })));
    var items = h("div", { class: "items" }, j.items.map(function (it) {
      var can = w.balance >= it.cost, kind = it.kind === "timed" && it.days ? "持续 " + it.days + " 天" : KINDW[it.kind] || "";
      var act = can ? h("a", { class: "btn pri sm", href: "#shop/" + encodeURIComponent(it.key) }, "兑换")
        : h("span", { class: "short" }, "还差 " + (it.cost - w.balance) + " 分", meter(w.balance / it.cost * 100));
      return h("section", { class: "item" + (can ? "" : " cant") }, h("div", { class: "top" }, h("h3", { text: it.name }), h("span", { class: "cost" }, String(it.cost), h("small", { text: " 分" }))),
        h("p", { text: it.what }), h("div", { class: "foot2" }, h("span", { class: "meta", text: kind + (it.custom ? " · 群里自定的" : "") }), act));
    }));
    function spendList(list, showWho) {
      if (!list.length) return h("div", { class: "card" }, empty(showWho ? "还没有人兑换过" : "你还没兑换过", showWho ? "" : "做完任务攒分，攒够了来这里换。"));
      return h("div", { class: "flist spl2" }, list.map(function (x) {
        var st = STW[x.state] || ["", x.state];
        return h("div", { class: "frow" }, h("span", { class: "fm" }, h("span", { class: "nm" }, showWho ? h("span", { class: "meta", text: x.who + " 换了 " }) : "", x.name, x.note ? "：" + x.note : ""),
          h("span", { class: "meta" }, x.cost + " 分 · ", rt(x.ts), x.until && x.state !== "refunded" ? [" · ", rt(x.until, "", "到期")] : null)), badge(st[0], st[1]));
      }));
    }
    swap(root, [wallet, h("div", { class: "row" }, h("a", { class: "btn", href: "#redemptions" }, icon("file"), "兑换台账")), h("div", { class: "sect" }, h("h2", { text: "能换的" }), items),
      h("div", { class: "cols2" }, h("div", { class: "sect" }, h("h2", { text: "我的兑换" }), spendList(j.mine, false)), h("div", { class: "sect" }, h("h2", { text: "大家最近换的" }), spendList(j.recent, true)))]);
  });
}
function shopArg(arg) {
  if (!arg) { if (DW.key) drawerClose(); return; }
  var it = null; (SHOP ? SHOP.items : []).forEach(function (x) { if (x.key === arg) it = x; });
  if (!it) { location.replace("#shop"); return; }
  var body = drawerOpen("shop", "兑换"), bal = SHOP.me.balance;
  body.appendChild(h("h2", { id: "dw-title", text: it.name }));
  body.appendChild(h("p", { class: "meta", text: it.what }));
  body.appendChild(h("dl", { class: "facts" }, h("dt", { text: "花" }), h("dd", { text: it.cost + " 分" }), h("dt", { text: "换完还剩" }), h("dd", { text: (bal - it.cost) + " 分" }),
    h("dt", { text: "怎么兑现" }), h("dd", { text: it.kind === "manual" ? "群主或群友来兑现，Bot 会在群里说一声" : it.kind === "weekly" ? "下一期周日战报兑现" : "Bot 会在群里兑现" })));
  var isTitle = it.key === "title";
  var note = it.needs || it.custom ? h(isTitle ? "input" : "textarea", { maxlength: isTitle ? "12" : "200", placeholder: it.needs || "附言（可以不写）", "aria-label": it.needs || "附言", required: isTitle || null }) : null;
  if (note && !isTitle) note.style.minHeight = "4.5rem";
  var go2 = h("button", { type: "submit", class: "btn pri" }, "确认兑换，花 " + it.cost + " 分"), cancel = h("button", { type: "button", class: "btn", onclick: leaveDrawer }, "再想想");
  var form = h("form", {}, note ? h("label", { class: "field" }, h("span", { text: isTitle ? "头衔（12 个字以内，必填）" : "你的要求" }), note) : null, h("div", { class: "row" }, go2, cancel));
  form.style.marginTop = "18px";
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = note ? note.value.trim() : "";
    if (isTitle && !v) { note.focus(); return; }
    go2.disabled = true;
    api("shop/redeem", { item: it.key, note: v }).then(function (r) {
      var b2 = clear($("dw-body"));
      b2.appendChild(h("div", { class: "done-box" }, h("span", { class: "m" }, icon("check")), h("h2", { id: "dw-title", text: "换到了：" + r.spend.name }),
        h("p", { text: "记录 #" + r.spend.id + " · 花了 " + r.spend.cost + " 分，还剩 " + r.balance + " 分。" }), h("p", { class: "meta", text: it.kind === "manual" ? "等群主兑现。" : it.kind === "weekly" ? "已登记到周报，等群主确认兑现。" : it.kind === "timed" ? "新头衔已生效。" : "Bot 会在群里办理，办完由群主确认。" }),
        h("div", { class: "row" }, h("a", { class: "btn", href: "#redemptions" }, "查看台账"), h("button", { type: "button", class: "btn", onclick: leaveDrawer }, "好的"))));
      b2.querySelector(".row").style.justifyContent = "center";
      toast("换到了：" + r.spend.name + "，还剩 " + r.balance + " 分", "win");
      loaded.shop = 0; loaded.team = 0; loaded.wall = 0; loaded.home = 0; loaded.redemptions = 0;
      load("shop", true); mine();
    }, function (e) { go2.disabled = false; fail(e); });
  });
  body.appendChild(form);
  if (note) setTimeout(function () { note.focus(); }, 60);
}

function redemptionsView(root) {
  var filter = "", next = null, serial = 0;
  var list = h("div", { class: "sect", "aria-live": "polite" });
  var more = h("button", { type: "button", class: "btn", hidden: true }, "更早的兑换");
  var filters = [["", "全部"], ["pending", "待兑现"], ["done", "已兑现"], ["refunded", "已退分"]];
  var toolbar = h("div", { class: "row" });
  function tabs() {
    var group = seg(filters, filter, function (value) { filter = value; tabs(); fetchPage(null).catch(fail); });
    clear(toolbar).append(h("a", { class: "btn", href: "#shop" }, "返回兑换"), group);
  }
  function record(x, can) {
    var st = STW[x.state] || ["", x.state];
    var event = x.state === "refunded" ? "退分" : "兑现";
    var detail = h("div", { class: "card" },
      h("div", { class: "row" }, h("strong", { text: "#" + x.id + " · " + x.who + " · " + x.name }), badge(st[0], st[1])),
      h("p", { class: "meta" }, "兑换 " + exact(x.ts) + " · 花 " + x.cost + " 分 · 现在可用 " + x.balance + " 分",
        x.balance_after === null ? null : " · 兑换后余 " + x.balance_after + " 分"),
      x.settled_at ? h("p", { class: "meta", text: event + " " + exact(x.settled_at) + (x.settled_by ? " · " + x.settled_by : " · 旧记录") }) : null,
      x.note ? h("p", { text: x.note }) : null);
    if (can && x.state === "pending") {
      var yes = h("button", { type: "button", class: "btn pri sm", onclick: function () { finish(x, "done", yes, back); } }, "确认兑现");
      var back = h("button", { type: "button", class: "btn sm", onclick: function () { finish(x, "refunded", yes, back); } }, "退回 " + x.cost + " 分");
      detail.appendChild(h("div", { class: "row" }, yes, back));
    }
    return detail;
  }
  function finish(x, state, yes, back) {
    var refund = state === "refunded";
    if (!window.confirm((refund ? "退回 " + x.cost + " 分给" : "确认已为") + x.who + "办理「" + x.name + "」？")) return;
    yes.disabled = back.disabled = true;
    api("redemptions/settle", { id: x.id, state: state }).then(function (r) {
      toast((refund ? "已退回 " + x.cost + " 分" : "已确认兑现") + " · 可用 " + r.balance + " 分", "win");
      loaded.shop = 0; loaded.team = 0; loaded.wall = 0; loaded.home = 0;
      mine();
      return fetchPage(null);
    }).catch(function (e) { yes.disabled = back.disabled = false; fail(e); });
  }
  function fetchPage(before) {
    var id = ++serial;
    more.disabled = true;
    return api("redemptions?state=" + filter + (before ? "&before=" + before : "")).then(function (j) {
      if (id !== serial) return;
      if (!before) clear(list);
      j.records.forEach(function (x) { list.appendChild(record(x, j.can_settle)); });
      if (!list.childNodes.length) list.appendChild(empty("没有这个状态的兑换记录", ""));
      next = j.next; more.hidden = !next;
    }).finally(function () { if (id === serial) more.disabled = false; });
  }
  more.addEventListener("click", function () { if (next) fetchPage(next).catch(fail); });
  tabs();
  swap(root, [toolbar, list, more]);
  return fetchPage(null);
}

// ---------- 动态 ----------
function feed(root) {
  var list = h("ol", { class: "tl" }), more = h("button", { type: "button", class: "btn", hidden: true }, "更早的"), last = "";
  function item(d) {
    var p = d.date.split("-"), dt = new Date(+p[0], +p[1] - 1, +p[2]), rel = relDay(d.date);
    return h("li", { id: "d-" + d.date }, h("div", { class: "tl-date" }, h("b", { text: String(+p[2]) }), h("span", { text: (+p[1]) + "月 周" + WEEK.charAt(dt.getDay()) }), rel ? h("em", { text: rel }) : null),
      h("div", { class: "tl-text" }, d.summary.split(/\n+/).filter(Boolean).map(function (x) { return h("p", { text: x }); })));
  }
  function page(n) {
    more.disabled = true;
    return api("days?n=" + n + (last ? "&before=" + last : "")).then(function (j) {
      j.days.forEach(function (d) { list.appendChild(item(d)); last = d.date; });
      more.hidden = !j.more; more.disabled = false; return j;
    });
  }
  more.addEventListener("click", function () { page(14).catch(function (e) { more.disabled = false; fail(e); }); });
  var want = /^\d{4}-\d{2}-\d{2}$/.test(route.arg) ? route.arg : "";
  return page(want ? 21 : 7).then(function (j) {
    swap(root, h("div", { class: "read" }, h("p", { class: "lede", text: "每天夜里 Bot 把当天的群聊整理成一段小结。" }), j.days.length ? list : empty("还没有整理过的日子"), h("div", { class: "more-row" }, more)));
  });
}
function feedArg(arg) {
  if (!arg) return;
  var el = $("d-" + arg); if (!el) return;
  document.querySelectorAll(".tl>li.hl").forEach(function (x) { x.classList.remove("hl"); });
  el.classList.add("hl"); el.scrollIntoView({ block: "start", behavior: CALM.matches ? "auto" : "smooth" });
}

// ---------- 任务 ----------
var TS = { all: [], root: null, view: null, f: store.get("tasks", { who: "", q: "", dropped: false, seg: "" }), doneShow: 20 };
function saveF() { store.set("tasks", TS.f); }
function byId(id) { for (var i = 0; i < TS.all.length; i++) if (TS.all[i].id === id) return TS.all[i]; return null; }
function upsert(t) { var o = byId(t.id); if (o) { for (var k in t) o[k] = t[k]; return o; } TS.all.push(t); return t; }
function loadTasks() {
  var q = [api("tasks?status=open,doing&n=300"), api("tasks?status=done&n=100")];
  if (TS.f.dropped) q.push(api("tasks?status=dropped&n=60"));
  return Promise.all(q).then(function (r) { TS.all = r[0].tasks.concat(r[1].tasks, r[2] ? r[2].tasks : []); });
}
function passes(t) {
  var w = TS.f.who, q = (TS.f.q || "").trim().toLowerCase();
  if (w === "@me" && !isMine(t)) return false;
  if (w === "@none" && (t.owner || t.claimed_by)) return false;
  if (w && w.charAt(0) !== "@" && t.owner !== w && t.claimed_by !== w) return false;
  if (q && ("#" + t.id + " " + t.title + " " + t.detail + " " + t.owner + " " + t.claimed_by + " " + t.source).toLowerCase().indexOf(q) < 0) return false;
  return true;
}
function inCol(s) {
  var l = TS.all.filter(function (t) { return t.status === s && passes(t); });
  return l.sort(s === "done" || s === "dropped" ? function (a, b) { return b.updated - a.updated; } : function (a, b) { return (a._new ? -1 : 0) - (b._new ? -1 : 0) || byDue(a, b); });
}
function people() {
  var seen = {}, out = [];
  me.people.concat(TS.all.map(function (t) { return t.owner; }), TS.all.map(function (t) { return t.claimed_by; })).forEach(function (n) { if (n && n !== "bot" && !seen[n]) { seen[n] = 1; out.push(n); } });
  return out;
}
function tasksView(root) {
  TS.root = root;
  return loadTasks().then(function () {
    var add = h("button", { type: "button", class: "btn pri" }, icon("plus"), "新任务");
    add.addEventListener("click", function () { go("tasks/new"); });
    var sel = h("select", { "aria-label": "看谁的任务" });
    [["", "所有人"], ["@me", "我的"]].concat(people().filter(function (n) { return n !== me.name; }).map(function (n) { return [n, n]; }), [["bot", "交给 Bot 的"], ["@none", "没人负责的"]]).forEach(function (o) { sel.appendChild(h("option", { value: o[0], text: o[1] })); });
    sel.value = TS.f.who || ""; if (sel.value !== (TS.f.who || "")) { TS.f.who = ""; sel.value = ""; }
    sel.addEventListener("change", function () { TS.f.who = sel.value; saveF(); drawTasks(); });
    var sb = searchBox("找任务", TS.f.q, function (v) { TS.f.q = v; saveF(); drawTasks(); });
    var dr = h("input", { type: "checkbox" }); dr.checked = !!TS.f.dropped;
    dr.addEventListener("change", function () { TS.f.dropped = dr.checked; saveF(); if (TS.f.seg === "dropped" && !dr.checked) TS.f.seg = ""; (dr.checked ? api("tasks?status=dropped&n=60").then(function (j) { j.tasks.forEach(upsert); }) : Promise.resolve()).then(drawTasks, fail); });
    TS.view = h("div");
    var tools = h("div", { class: "tools-row" }, WIDE.matches ? add : null, sel, sb.el, h("label", { class: "toggle" }, dr, "显示不做了的"));
    var fab = WIDE.matches ? null : h("button", { type: "button", class: "mobile-add", "aria-label": "新任务", onclick: function () { go("tasks/new"); } }, icon("plus"));
    swap(root, h("div", { class: "tasks" }, tools, TS.view, fab));
    drawTasks();
  });
}
function drawTasks() {
  if (!TS.view) return;
  var cols = ["open", "doing", "done"].concat(TS.f.dropped ? ["dropped"] : []);
  var any = TS.all.some(passes);
  if (WIDE.matches) {
    var kb = h("div", { class: "kanban" });
    cols.forEach(function (s) { kb.appendChild(column(s)); });
    swap(TS.view, [kb, !TS.all.length ? h("p", { class: "empty", text: "还没有任务。点“新任务”加一个，或者在群里说“记个任务”。" }) : !any ? h("p", { class: "empty", text: "没有符合筛选的任务。" }) : null]);
  } else {
    var s = TS.f.seg && cols.indexOf(TS.f.seg) >= 0 ? TS.f.seg : inCol("doing").length ? "doing" : "open";
    var tabs = seg(cols.map(function (c) { return [c, SL[c], inCol(c).length]; }), s, function (v) { TS.f.seg = v; saveF(); drawTasks(); }, true);
    var l = inCol(s), box = h("div", { class: "cards" });
    (s === "done" ? l.slice(0, TS.doneShow) : l).forEach(function (t) { box.appendChild(taskCard(t)); });
    swap(TS.view, [tabs, h("div", { class: "tasks-list" }, h("div", { class: "vh", text: SL[s] }), l.length ? box : h("p", { class: "empty", text: s === "doing" ? "没有进行中的任务。" : s === "open" ? "没有没开始的任务。" : "这里是空的。" }),
      s === "done" && l.length > TS.doneShow ? moreDone() : null)]);
    tabs.style.marginBottom = "12px";
  }
}
function moreDone() { return h("div", { class: "more-row" }, h("button", { type: "button", class: "btn", onclick: function () { TS.doneShow += 30; drawTasks(); } }, "再看一些")); }
var dragId = 0;
function column(s) {
  var l = inCol(s), cards = h("div", { class: "cards" });
  (s === "done" ? l.slice(0, TS.doneShow) : l).forEach(function (t) { cards.appendChild(taskCard(t)); });
  if (!l.length) cards.appendChild(h("p", { class: "col-empty", text: FINE.matches ? "没有，可以把卡片拖到这里" : "没有" }));
  var addB = s === "open" ? h("button", { type: "button", class: "ib", "aria-label": "新任务", title: "新任务（N）", onclick: function () { go("tasks/new"); } }, icon("plus")) : null;
  var col = h("section", { class: "col", "data-s": s, "aria-label": SL[s] }, h("div", { class: "col-h" }, h("span", { text: SL[s] }), h("span", { class: "n", text: String(l.length) }), addB), cards, s === "done" && l.length > TS.doneShow ? moreDone() : null);
  col.addEventListener("dragover", function (e) { if (!dragId) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; col.classList.add("over"); });
  col.addEventListener("dragleave", function (e) { if (!col.contains(e.relatedTarget)) col.classList.remove("over"); });
  col.addEventListener("drop", function (e) { e.preventDefault(); col.classList.remove("over"); var t = byId(dragId); dragId = 0; if (t) moveTask(t, s).catch(function () {}); });
  return col;
}
function taskCard(t) {
  var who = t.status === "doing" && t.claimed_by ? h("span", { class: "who" }, avatar(t.claimed_by, true), t.claimed_by + " 在做")
    : t.owner ? h("span", { class: "who" }, avatar(t.owner, true), (t.owner === "bot" ? "交给 Bot" : "交给 " + t.owner) + (t.claimed_by ? "，" + t.claimed_by + " 领了" : ""))
    : t.claimed_by ? h("span", { class: "who" }, avatar(t.claimed_by, true), t.claimed_by + " 领了") : h("span", { class: "who" }, avatar("", true), "没人负责");
  var main = h("a", { class: "tc-main", href: t._new ? null : "#tasks/" + t.id, draggable: "false" },
    h("span", { class: "tt" }, h("span", { class: "tid", text: t._new ? "新" : "#" + t.id }), t.title),
    h("span", { class: "tm" }, sizeTag(t.size), who, dueChip(t)), pathLine(t), t.source && t.status !== "done" ? h("span", { class: "src", text: "来自 " + t.source }) : null);
  var menu = t._new ? null : h("button", { type: "button", class: "ib tc-menu", "aria-label": "改状态：" + t.title, "aria-haspopup": "menu", "aria-expanded": "false", title: "改状态" }, icon("dots"));
  if (menu) menu.addEventListener("click", function () { statusMenu(menu, t); });
  var el = h("article", { class: "tc s-" + t.status + (t.size === "big" ? " boss" : "") + (t._new ? " pending" : "") + (t._win ? " settle" : ""), "data-id": String(t.id) }, main, menu);
  t._win = false;
  if (FINE.matches && WIDE.matches && !t._new) {
    el.setAttribute("draggable", "true");
    el.addEventListener("dragstart", function (e) { dragId = t.id; el.classList.add("dragging"); try { e.dataTransfer.setData("text/plain", "#" + t.id); e.dataTransfer.effectAllowed = "move"; } catch (x) {} });
    el.addEventListener("dragend", function () { dragId = 0; el.classList.remove("dragging"); document.querySelectorAll(".col.over").forEach(function (c) { c.classList.remove("over"); }); });
  }
  return el;
}
function pathLine(t) {
  if (t.status === "done" && t.done_at) return h("span", { class: "path" }, "做完", t.claimed_at && t.done_at > t.claimed_at ? "，用了 " + span(t.done_at - t.claimed_at) : "", t.done_by ? [" · ", t.done_by + " ", h("b", { text: "+" + (t.points || 0) + " 分" })] : null);
  if (t.status === "doing" && t.claimed_at) return h("span", { class: "path" }, rt(t.claimed_at, "", "接手"), t.claimed_at - t.created > 3600000 ? "，等了 " + span(t.claimed_at - t.created) : "");
  if (t.status === "open") return h("span", { class: "path" }, rt(t.created, "", "记下"), t.by ? "，" + t.by : "");
  return null;
}
function statusMenu(anchor, t) {
  var m = menuKeys(h("div", { role: "menu", "aria-label": "改状态" }));
  ["open", "doing", "done", "dropped"].forEach(function (s) {
    var on = t.status === s;
    m.appendChild(h("button", { type: "button", role: "menuitemradio", "aria-checked": on ? "true" : "false", onclick: function () { popClose(); moveTask(t, s).catch(function () {}); } },
      h("span", { class: "ck" }, on ? icon("check") : null), s === "doing" && t.status === "open" && !t.claimed_by ? "进行中（我来做）" : SL[s]));
  });
  m.appendChild(h("hr"));
  m.appendChild(h("button", { type: "button", role: "menuitem", onclick: function () { popClose(false); go("tasks/" + t.id); } }, h("span", { class: "ck" }), "打开详情"));
  popOpen(anchor, m);
}
// Moves a task at once on screen, then tells the server; puts it back and says why when the server refuses.
function moveTask(t, to, after) {
  if (t.status === to) return Promise.resolve(t);
  var prev = { status: t.status, claimed_by: t.claimed_by, updated: t.updated };
  var claim = to === "doing" && t.status === "open" && !t.claimed_by;
  t.status = to; t.updated = Date.now(); if (claim) t.claimed_by = me.name;
  drawTasks(); if (after) after(t, "now");
  return api(claim ? "tasks/" + t.id + "/claim" : "tasks/" + t.id, claim ? {} : { status: to }).then(function (j) {
    upsert(j.task);
    if (to === "done") { t._win = true; toast("做完了 #" + t.id + (t.points ? "，+" + t.points + " 分" : ""), "win"); mine(); }
    else { toast("#" + t.id + " 改成了" + SL[to]); if (claim) mine(); }
    drawTasks(); if (after) after(t, "ok");
    return t;
  }, function (e) {
    t.status = prev.status; t.claimed_by = prev.claimed_by; t.updated = prev.updated;
    drawTasks(); if (after) after(t, "undo"); fail(e);
    throw e;
  });
}
function tasksArg(arg) {
  if (!arg) { if (DW.key) drawerClose(); return; }
  if (arg === "new") return newTask();
  var id = parseInt(arg, 10);
  if (id > 0) openTask(id);
}
function taskForm(t, submitText, onSubmit) {
  var f = {
    title: h("input", { maxlength: "200", required: true, value: t ? t.title : "", placeholder: "要做什么", autocomplete: "off" }),
    detail: h("textarea", { maxlength: "4000", placeholder: "说明、链接、验收标准" }),
    owner: h("input", { maxlength: "40", list: "people", value: t ? t.owner : "", placeholder: "名字，或者 bot", autocomplete: "off" }),
    due: h("input", { type: "date", value: t ? t.due : "" }),
    size: h("select", {}, h("option", { value: "small", text: "小事（5 分）" }), h("option", { value: "normal", text: "普通（10 分）" }), h("option", { value: "big", text: "大活（30 分）" }))
  };
  f.size.value = t && t.size ? t.size : "normal";
  f.detail.value = t ? t.detail : "";
  if (t && t.id) { f.result = h("textarea", { maxlength: "4000", placeholder: "交付了什么：文字、链接、文件编号" }); f.result.value = t.result || ""; }
  var dl = h("datalist", { id: "people" }); people().concat(["bot"]).forEach(function (n) { dl.appendChild(h("option", { value: n })); });
  var save = h("button", { type: "submit", class: "btn pri" }, submitText), cancel = h("button", { type: "button", class: "btn", onclick: function () { onSubmit(null); } }, "取消");
  var form = h("form", { class: "tform" },
    h("label", { class: "field" }, h("span", { text: "标题" }), f.title),
    h("label", { class: "field" }, h("span", { text: "说明" }), f.detail),
    h("div", { class: "two" }, h("label", { class: "field" }, h("span", { text: "谁来做" }), f.owner), h("label", { class: "field" }, h("span", { text: "截止" }), f.due)),
    h("label", { class: "field" }, h("span", { text: "多大的事（按时做完再加 5 分）" }), f.size),
    f.result ? h("label", { class: "field" }, h("span", { text: "交付" }), f.result) : null, dl,
    h("div", { class: "row" }, save, cancel));
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var v = { title: f.title.value.trim(), detail: f.detail.value.trim(), owner: f.owner.value.trim(), due: f.due.value, size: f.size.value };
    if (f.result) v.result = f.result.value.trim();
    if (!v.title) { f.title.focus(); return; }
    save.disabled = true;
    Promise.resolve(onSubmit(v)).then(function () { save.disabled = false; }, function () { save.disabled = false; });
  });
  setTimeout(function () { f.title.focus(); }, 60);
  return form;
}
function newTask(keep) {
  var body = drawerOpen("new", "新任务");
  body.appendChild(h("h2", { id: "dw-title", text: "加一个任务" }));
  body.appendChild(taskForm(keep || null, "加上", function (v) {
    if (!v) { leaveDrawer(); return; }
    var tmp = { id: -Date.now(), _new: true, title: v.title, detail: v.detail, owner: v.owner, due: v.due, status: "open", source: "看板", by: me.name, claimed_by: "", result: "", created: Date.now(), updated: Date.now() };
    TS.all.push(tmp); leaveDrawer(); drawTasks();
    return api("tasks", v).then(function (j) {
      TS.all = TS.all.filter(function (x) { return x !== tmp; }); upsert(j.task); drawTasks(); toast("加上了 #" + j.task.id);
    }, function (e) {
      TS.all = TS.all.filter(function (x) { return x !== tmp; }); drawTasks(); fail(e);
      go("tasks/new"); setTimeout(function () { if (DW.key === "new") newTask(v); }, 50);
    });
  }));
}
function openTask(id) {
  var t0 = byId(id), body = drawerOpen("t" + id, "任务 #" + id);
  if (t0) body.appendChild(h("h2", { id: "dw-title", text: t0.title }));
  body.appendChild(skel("", 5));
  fetchTask(id).then(function (j) { if (DW.key === "t" + id) taskPanel(j); }, function (e) {
    if (DW.key !== "t" + id) return;
    clear(body).appendChild(h("h2", { id: "dw-title", text: "打不开这个任务" })); body.appendChild(h("p", { class: "meta", text: e.message === "401" ? "" : e.message }));
  });
}
function fetchTask(id) {
  return Promise.all([api("tasks/" + id), api("tasks/" + id + "/timeline").then(null, function () { return null; })]).then(function (r) { r[0].tl = r[1]; return r[0]; });
}
function stepper(t, tl) {
  var claimed = t.claimed_at, done = t.done_at;
  function stp(on, word, who, ts, extra) { return h("div", { class: "stp" + (on ? " done" : "") }, h("b", { text: word }), h("span", { class: "meta" }, on ? [who ? who + " · " : "", rt(ts)] : "还没有"), extra); }
  return h("div", { class: "stepper", role: "list", "aria-label": "经过" },
    stp(true, "记下", t.by, t.created),
    stp(!!claimed, "接手", t.claimed_by, claimed, claimed && claimed - t.created > 60000 ? h("span", { class: "gap", text: "等了 " + span(claimed - t.created) + " 才有人接" }) : !claimed && t.status === "open" ? h("span", { class: "gap", text: "已经等了 " + span(Date.now() - t.created) }) : null),
    stp(!!done, "做完", t.done_by, done, done && claimed ? h("span", { class: "gap ok-t", text: "做了 " + span(done - claimed) }) : t.status === "doing" && claimed ? h("span", { class: "gap", text: "已经做了 " + span(Date.now() - claimed) }) : null));
}
function taskPanel(j) {
  var t = upsert(j.task), body = clear($("dw-body")), notes = j.notes || [], tl = j.tl;
  function redraw() { if (DW.key === "t" + t.id) fetchTask(t.id).then(function (k) { if (DW.key === "t" + t.id) taskPanel(k); }, function () { taskPanel({ task: t, notes: notes, prompt: j.prompt, tl: tl }); }); }
  body.appendChild(h("h2", { id: "dw-title", text: t.title }));
  var stat = h("div", { class: "seg full", role: "group", "aria-label": "状态" });
  ["open", "doing", "done", "dropped"].forEach(function (s) {
    stat.appendChild(h("button", { type: "button", "aria-pressed": t.status === s ? "true" : "false", onclick: function () { moveTask(t, s, moved).catch(function () {}); } }, SL[s]));
  });
  body.appendChild(stat);
  var sizeSeg = h("div", { class: "seg", role: "group", "aria-label": "多大的事" });
  [["small", "小事 5"], ["normal", "普通 10"], ["big", "大活 30"]].forEach(function (z) {
    sizeSeg.appendChild(h("button", { type: "button", "aria-pressed": (t.size || "normal") === z[0] ? "true" : "false", onclick: function () {
      var old = t.size; if (old === z[0]) return; t.size = z[0]; drawTasks(); redrawLocal();
      api("tasks/" + t.id, { size: z[0] }).then(function (r) { upsert(r.task); drawTasks(); toast("定为" + z[1].split(" ")[0]); }, function (e) { t.size = old; drawTasks(); redrawLocal(); fail(e); });
    } }, z[1] + " 分"));
  });
  function moved(x, ph) { if (ph === "ok") redraw(); else redrawLocal(); }
  function redrawLocal() { taskPanel({ task: t, notes: notes, prompt: j.prompt, tl: tl }); }
  sizeSeg.style.marginTop = "8px";
  body.appendChild(sizeSeg);
  body.appendChild(stepper(t, tl));
  if (t.status === "done" && t.done_by) body.appendChild(h("p", { class: "credit" }, icon("check"), "记在 " + t.done_by + " 名下，+" + (t.points || 0) + " 分"));
  var acts = h("div", { class: "row" });
  acts.style.marginTop = "12px";
  if (t.status === "open" && !t.claimed_by) acts.appendChild(h("button", { type: "button", class: "btn pri", onclick: function () { moveTask(t, "doing", moved).catch(function () {}); } }, "我来做"));
  var edit = h("button", { type: "button", class: "btn" }, "编辑");
  acts.appendChild(edit);
  body.appendChild(acts);
  var info = h("div");
  var d = dueInfo(t);
  info.appendChild(h("dl", { class: "facts" },
    h("dt", { text: "负责人" }), h("dd", { text: t.owner ? (t.owner === "bot" ? "Bot" : t.owner) : "没指定" }),
    h("dt", { text: "截止" }), h("dd", {}, t.due ? [t.due, d && d.cls ? h("span", { class: "due " + d.cls }, "　", d.text) : null] : "没定"),
    h("dt", { text: "领取" }), h("dd", { text: t.claimed_by || "还没人领" }),
    h("dt", { text: "来源" }), h("dd", { text: t.source || "—" }),
    h("dt", { text: "加的" }), h("dd", {}, t.by ? t.by + " · " : "", rt(t.created)),
    h("dt", { text: "更新" }), h("dd", {}, rt(t.updated))));
  if (t.detail) { info.appendChild(h("h3", { text: "说明" })); info.appendChild(h("p", { class: "pre", text: t.detail })); }
  if (t.result) { info.appendChild(h("h3", { text: "交付" })); info.appendChild(h("p", { class: "pre", text: t.result })); }
  body.appendChild(info);
  edit.addEventListener("click", function () {
    edit.disabled = true;
    var form = taskForm(t, "保存", function (v) {
      if (!v) { form.replaceWith(info); edit.disabled = false; return; }
      return api("tasks/" + t.id, v).then(function (r) { upsert(r.task); drawTasks(); toast("改好了"); redraw(); }, fail);
    });
    form.style.marginTop = "16px";
    info.replaceWith(form);
  });

  body.appendChild(h("h3", { text: "经过和进展" }));
  var nl = h("ul", { class: "vtl" });
  function drawNotes() {
    clear(nl);
    var steps = tl && tl.steps && tl.steps.length ? tl.steps.slice() : notes.map(function (n) { return { ts: n.ts, who: n.who, kind: n.kind || "progress", word: "进展", text: n.text, _p: n._p }; });
    notes.forEach(function (n) { if (n._p) steps.push({ ts: n.ts, who: n.who, kind: "progress", word: "进展", text: n.text, _p: true }); });
    if (!steps.length) nl.appendChild(h("li", { class: "meta", text: "还没有记录。" }));
    steps.forEach(function (n) { nl.appendChild(h("li", { class: "k-" + n.kind + (n._p ? " pending" : "") }, h("span", { class: "meta" }, (n.who || "") + " " + (n.word || "") + " · ", rt(n.ts)), h("span", { class: "pre", text: n.text }))); });
  }
  drawNotes(); body.appendChild(nl);
  var note = h("textarea", { maxlength: "2000", placeholder: "进展、问题、链接", "aria-label": "写进展" }), addN = h("button", { type: "submit", class: "btn sm" }, "记一笔");
  note.style.minHeight = "4rem";
  var nf = h("form", {}, note, h("div", { class: "row" }, addN));
  nf.lastChild.style.marginTop = "8px";
  nf.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = note.value.trim(); if (!text) { note.focus(); return; }
    var p = { who: me.name, ts: Date.now(), text: text, _p: true };
    notes.push(p); drawNotes(); note.value = ""; addN.disabled = true;
    api("tasks/" + t.id + "/note", { text: text }).then(function (r) { notes = r.notes || notes; addN.disabled = false; redraw(); }, function (e) {
      notes = notes.filter(function (x) { return x !== p; }); drawNotes(); note.value = text; addN.disabled = false; fail(e);
    });
  });
  body.appendChild(nf);

  if (t.status === "open" || t.status === "doing") {
    var ai = h("div", { class: "ai" }, h("h3", { text: "交给本地 AI" }), h("p", { text: "把这句话发给你电脑上的 AI 工具，它会领走任务，做完交回来。" }), h("code", { text: j.prompt }), h("div", { class: "row" }, copyBtn(j.prompt, "复制这句话")));
    var how = h("button", { type: "button", class: "btn quiet", "aria-expanded": "false" }, "第一次用：接上 Claude Code 或 Codex");
    var out = h("div");
    how.addEventListener("click", function () {
      if (out.firstChild) { clear(out); how.setAttribute("aria-expanded", "false"); return; }
      how.disabled = true;
      api("mcp", {}).then(function (r) {
        how.disabled = false; how.setAttribute("aria-expanded", "true");
        out.appendChild(h("p", { text: "在终端里运行一次。命令里带着你的个人令牌，只在这里复制，不要发到群里。" }));
        (r.tools || [{ name: "", lines: r.lines }]).forEach(function (tool) {
          if (tool.name) out.appendChild(h("p", {}, h("b", { text: tool.name })));
          tool.lines.forEach(function (line) {
            out.appendChild(h("code", { text: line.replace(/[a-f0-9]{40}/, function (k) { return k.slice(0, 4) + "…" + k.slice(-4); }) }));
            out.appendChild(h("div", { class: "row" }, copyBtn(line, "复制命令")));
          });
        });
        if (r.lines.length > 1) out.appendChild(h("p", { text: "每种工具的第二条走香港镜像，大陆网络连不上第一条就用它。" }));
      }, function (e) { how.disabled = false; fail(e); });
    });
    ai.appendChild(how); ai.appendChild(out);
    body.appendChild(ai);
  }
}

// ---------- 记忆 ----------
var MEM = { q: "" };
function memory(root) {
  return api("memory").then(function (j) {
    var secs = [], curS = null;
    (j.memory || "").split("\n").forEach(function (raw) {
      var line = raw.trim(); if (!line) return;
      var m = /^【([^】]+)】\s*(.*)$/.exec(line);
      if (m) { curS = { title: m[1], items: [] }; secs.push(curS); if (!m[2]) return; line = m[2]; }
      if (!curS) { curS = { title: "未分类", items: [] }; secs.push(curS); }
      curS.items.push(line.replace(/^[·•\-]\s*/, ""));
    });
    var notes = (j.notes || []).slice().sort(function (a, b) { return b.ts - a.ts; });
    var sb = searchBox("在记忆里找", MEM.q, function (v) { MEM.q = v; draw(); });
    var count = h("p", { class: "meta" }), tocList = h("div"), doc = h("div", { class: "mem" });
    var toc = h("details", { class: "toc" }, h("summary", { text: "目录" }), tocList);
    if (window.innerWidth >= 1100) toc.open = true;
    function jump(el) { if (window.innerWidth < 1100) toc.open = false; el.scrollIntoView({ block: "start", behavior: CALM.matches ? "auto" : "smooth" }); var hd = el.querySelector("h2"); if (hd) { hd.setAttribute("tabindex", "-1"); hd.focus({ preventScroll: true }); } }
    function draw() {
      var k = MEM.q.trim().toLowerCase(), shown = 0;
      clear(doc); clear(tocList);
      var all = secs.map(function (s) { return { title: s.title, items: s.items.map(function (x) { return { text: x }; }) }; });
      all.push({ title: "最近记下的，还没整理进去", items: notes.map(function (n) { return { text: n.text, ts: n.ts }; }), notes: true });
      all.forEach(function (s, i) {
        var items = s.items.filter(function (x) { return !k || x.text.toLowerCase().indexOf(k) >= 0 || (!x.ts && s.title.toLowerCase().indexOf(k) >= 0); });
        shown += items.length;
        if (k && !items.length) { tocList.appendChild(h("button", { type: "button", class: "zero", disabled: true }, h("span", { text: s.title }), h("span", { class: "n", text: "0" }))); return; }
        var sec = h("section", { id: "m-" + i }, h("h2", {}, marked(s.title, k)));
        if (!items.length) sec.appendChild(h("p", { class: "meta", text: "没有。" }));
        else sec.appendChild(h("ul", {}, items.map(function (x) { return h("li", {}, x.ts ? h("span", { class: "when" }, rt(x.ts)) : null, marked(x.text, k)); })));
        doc.appendChild(sec);
        tocList.appendChild(h("button", { type: "button", onclick: function () { jump(sec); } }, h("span", { text: s.title }), h("span", { class: "n", text: String(items.length) })));
      });
      if (!secs.length && !k) doc.insertBefore(empty("还没有长期记忆", "Bot 会从聊天里慢慢记下来。"), doc.firstChild);
      count.textContent = k ? "找到 " + shown + " 条" : "Bot 每天夜里重写一遍这份记忆。这里只能看，要改在群里跟它说。";
    }
    draw();
    swap(root, h("div", {}, h("div", { class: "tools-row" }, sb.el), count, h("div", { class: "memwrap" }, toc, doc)));
    count.style.margin = "-8px 0 16px";
  });
}

// ---------- 仓库 ----------
function repos(root) {
  return api("repos").then(function (j) {
    if (!j.repos.length) { swap(root, empty("还没有要检查的仓库", "在群里让 Bot 每晚检查某个仓库就会出现在这里。")); return; }
    var grid = h("div", { class: "rgrid" });
    j.repos.slice().sort(function (a, b) { var o = function (r) { return r.ok === 0 ? 0 : r.ok === 1 ? 1 : 2; }; return o(a) - o(b); }).forEach(function (r) {
      var st = repoState(r), c = h("section", { class: "card" + (r.ok === 0 ? " failing" : "") });
      c.appendChild(h("div", { class: "repo-h" }, h("span", { class: "mark " + st.cls }, icon(st.ic)), h("h2", { text: r.repo }), badge(st.cls, st.word)));
      var line = [];
      if (r.checked_at) line.push(rt(r.checked_at, "查于 "));
      if (r.ok === 0 && r.failing_since) line.push(h("span", { class: "bad-t" }, rt(r.failing_since, "从 ", "起没通过")));
      else if (r.ok === 0 && r.last_pass) line.push(rt(r.last_pass, "上次通过 "));
      if (line.length) c.appendChild(h("p", { class: "meta" }, line.map(function (x, i) { return i ? [" · ", x] : x; })));
      if (r.commit) c.appendChild(h("p", { class: "meta", text: r.commit, title: r.commit }));
      if (r.history && r.history.length > 1) {
        var hist = h("div", { class: "hist", role: "img", "aria-label": "最近 " + r.history.length + " 次：" + r.history.filter(function (x) { return x.ok === 1; }).length + " 次通过" });
        r.history.forEach(function (x) { hist.appendChild(h("i", { class: x.ok === 1 ? "" : x.ok === 0 ? "f" : "u", title: md(x.ts) + " " + (x.ok === 1 ? "通过" : x.ok === 0 ? "没通过" : "没跑成") })); });
        c.appendChild(hist);
        c.appendChild(h("p", { class: "meta", text: "最近 " + r.history.length + " 次，实心是通过，空心是没通过" }));
      }
      if (r.problem) c.appendChild(h("p", { class: "err-line", text: r.problem }));
      if (r.steps && r.steps.length) {
        c.appendChild(h("ul", { class: "steps" }, r.steps.map(function (s) {
          var good = s.result === "通过", skip = s.result === "没跑";
          return h("li", {}, h("span", { class: good ? "ok-t" : skip ? "meta" : "bad-t", title: s.result }, icon(good ? "check" : skip ? "dash" : "x")),
            h("span", {}, s.step, h("span", { class: "meta", text: " " + (good ? "" : s.result) + (s.tests ? (good ? "" : "，") + s.tests : "") + (s.note ? "（" + s.note + "）" : "") })));
        })));
      }
      if (r.first_failing_lines && r.first_failing_lines.length) c.appendChild(h("details", { class: "more" }, h("summary", { text: "报错开头 " + r.first_failing_lines.length + " 行" }), h("pre", { class: "tail", text: r.first_failing_lines.join("\n") })));
      var cm = [];
      if (r.commits_24h) cm.push("24 小时 " + r.commits_24h.count + " 次提交");
      if (r.commits_7d) cm.push("7 天 " + r.commits_7d.count + " 次");
      var extra = [].concat(r.changed_since_previous || [], r.commits_7d && r.commits_7d.authors ? r.commits_7d.authors : [], r.note_carried ? [r.note_carried] : [], r.not_checked ? [r.not_checked] : []);
      if (cm.length || extra.length) {
        var dt = h("details", { class: "more" }, h("summary", { text: cm.length ? cm.join(" · ") : "和上次比" }), h("ul", { class: "list" }, extra.map(function (x) { return h("li", { class: "meta", text: x }); })));
        c.appendChild(dt);
      }
      grid.appendChild(c);
    });
    swap(root, [h("p", { class: "lede", text: "每天夜里自动拉一遍团队仓库，跑测试和检查。" }), grid]);
  });
}

// ---------- 作品和文件 ----------
var KIND = { made: "Bot 画的", chat: "群里发的", named: "角色", sticker: "表情" };
var WK = { tab: store.get("wtab", "pics"), kind: store.get("wkind", "") };
function works(root) {
  var pane = h("div");
  var tabs = seg([["pics", "图片"], ["files", "文件"], ["sites", "网页"], ["box", "文件箱"]], WK.tab, function (v) { WK.tab = v; store.set("wtab", v); draw().catch(fail); });
  tabs.style.marginBottom = "16px";
  function draw() { clear(pane).appendChild(skel(WK.tab === "pics" ? "cards" : "", 6)); return ({ pics: pics, files: fileList, sites: siteList, box: boxList })[WK.tab](pane); }
  return draw().then(function () { swap(root, [tabs, pane]); }, function (e) { swap(root, [tabs, pane]); throw e; });
}
function pics(pane) {
  var list = [], before = 0, grid = h("div", { class: "gallery" }), more = h("button", { type: "button", class: "btn", hidden: true }, "再看 30 张");
  function page() {
    more.disabled = true;
    return api("images?n=30" + (WK.kind ? "&kind=" + WK.kind : "") + (before ? "&before=" + before : "")).then(function (j) {
      j.images.forEach(function (p) {
        var i = list.length; list.push(p); before = p.id;
        grid.appendChild(h("figure", {}, h("button", { type: "button", "aria-label": "看大图：" + (p.note || p.ref), onclick: function () { lbOpen(list, i, more.hidden ? null : page); } },
          h("span", { class: "box" }, h("img", { src: p.url, alt: "", loading: "lazy", decoding: "async" }))), h("figcaption", { title: p.note || p.ref }, p.note || p.ref, h("span", { class: "meta" }, KIND[p.kind] || "", " · ", rt(p.ts)))));
      });
      more.hidden = !j.more; more.disabled = false;
      LB.more = j.more ? page : null;
      return j;
    });
  }
  more.addEventListener("click", function () { page().catch(fail); });
  var ch = chips([["", "全部"], ["made", "Bot 画的"], ["chat", "群里发的"], ["named", "角色和表情"]], WK.kind, function (v) { WK.kind = v; store.set("wkind", v); pics(pane).catch(fail); });
  return page().then(function (j) {
    swap(pane, [h("div", { class: "tools-row" }, ch), list.length ? grid : empty(WK.kind ? "这一类还没有图片" : "还没有图片", "Bot 画的图和群里发的图都会出现在这里。"), h("div", { class: "more-row" }, more)]);
  });
}
var LB = { list: [], i: 0, more: null, from: null };
function lbOpen(list, i, more) {
  LB.list = list; LB.i = i; LB.more = more; LB.from = document.activeElement;
  $("lb").hidden = false; document.body.classList.add("lock"); lbShow(); $("lb-x").focus();
}
function lbClose() { if ($("lb").hidden) return false; $("lb").hidden = true; $("lb-img").removeAttribute("src"); document.body.classList.remove("lock"); if (LB.from && LB.from.focus) LB.from.focus(); return true; }
function lbShow() {
  var p = LB.list[LB.i]; if (!p) return;
  var img = $("lb-img"); img.src = p.url; img.alt = p.note || p.ref;
  $("lb-n").textContent = (LB.i + 1) + " / " + LB.list.length + (LB.more ? "+" : "");
  var ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/avif": ".avif" }[p.mime] || "";
  var dl = $("lb-dl"); dl.href = p.url; dl.setAttribute("download", (p.name || p.ref) + ext);
  $("lb-open").href = p.url;
  var cap = clear($("lb-cap"));
  cap.appendChild(h("div", { text: (p.note || "") + (p.name ? "（" + p.name + "）" : "") }));
  cap.appendChild(h("span", { class: "meta" }, [p.ref, KIND[p.kind] || ""].filter(Boolean).join(" · ") + " · ", rt(p.ts)));
  if (p.how) cap.appendChild(h("span", { class: "meta", text: "怎么画的：" + p.how }));
  $("lb-prev").disabled = LB.i === 0; $("lb-next").disabled = LB.i >= LB.list.length - 1 && !LB.more;
  [LB.i - 1, LB.i + 1].forEach(function (k) { if (LB.list[k]) { var im = new Image(); im.src = LB.list[k].url; } });
}
function lbStep(d) {
  if (d < 0 && LB.i > 0) { LB.i--; lbShow(); return; }
  if (d > 0 && LB.i < LB.list.length - 1) { LB.i++; lbShow(); return; }
  if (d > 0 && LB.more) LB.more().then(function () { if (LB.i < LB.list.length - 1) { LB.i++; } lbShow(); }, fail);
}
function frow(kind, name, href, metaParts, extra, dl) {
  return h("div", { class: "frow" }, h("span", { class: "ftype" + (kind === "web" ? " web" : ""), "aria-hidden": "true" }, kind === "web" ? icon("globe") : kind),
    h("span", { class: "fm" }, h("a", { class: "nm", href: href, download: dl || null, target: kind === "web" ? "_blank" : null, rel: kind === "web" ? "noopener" : null, title: name, text: name }),
      h("span", { class: "meta" }, metaParts.filter(Boolean).map(function (x, i) { return i ? [" · ", x] : x; }))), extra || h("span"));
}
function fileList(pane) {
  var box = h("div", { class: "flist" }), more = h("button", { type: "button", class: "btn", hidden: true }, "再看 30 个"), before = 0;
  function page() {
    more.disabled = true;
    return api("files?n=30" + (before ? "&before=" + before : "")).then(function (j) {
      j.files.forEach(function (f) {
        box.appendChild(frow(extOf(f.name), f.name, f.url, [f.ref, f.received ? "群里收到的" : "Bot 做的", f.size_text, rt(f.ts)],
          h("a", { class: "ib", href: f.url, download: f.name, "aria-label": "下载 " + f.name, title: "下载" }, icon("download")), f.name));
        before = f.id;
      });
      more.hidden = !j.more; more.disabled = false; return j;
    });
  }
  more.addEventListener("click", function () { page().catch(fail); });
  return page().then(function (j) { swap(pane, j.files.length ? [box, h("div", { class: "more-row" }, more)] : empty("还没有文件", "Bot 做的文档和群里收到的文件都在这里。")); });
}
function siteList(pane) {
  return api("sites").then(function (j) {
    if (!j.sites.length && !j.pages.length) { swap(pane, empty("还没有做过网页", "让 Bot 做个网页或者部署一个仓库，就会出现在这里。")); return; }
    var out = [];
    if (j.sites.length) out.push(h("div", { class: "sect" }, h("h2", {}, "部署的网站", h("span", { class: "n", text: String(j.sites.length) })), h("div", { class: "flist" }, j.sites.map(function (s) { return frow("web", s.name, s.url, [s.source, s.commit, rt(s.at)], h("a", { class: "ib", href: s.url, target: "_blank", rel: "noopener", "aria-label": "打开 " + s.name }, icon("ext"))); }))));
    if (j.pages.length) out.push(h("div", { class: "sect" }, h("h2", {}, "发布的页面", h("span", { class: "n", text: String(j.pages.length) })), h("div", { class: "flist" }, j.pages.map(function (s) { return frow("web", s.title, s.url, [rt(s.at), s.views ? s.views + " 次打开" : "还没人打开"], h("a", { class: "ib", href: s.url, target: "_blank", rel: "noopener", "aria-label": "打开 " + s.title }, icon("ext"))); }))));
    swap(pane, out);
  });
}
function boxList(pane) {
  return api("box").then(function (j) {
    var up = h("button", { type: "button", class: "btn pri" }, icon("upload"), "要一个上传链接"), out = h("div");
    up.addEventListener("click", function () {
      up.disabled = true;
      api("box/upload", {}).then(function (r) {
        up.disabled = false; clear(out);
        out.appendChild(h("div", { class: "card" }, h("p", {}, h("a", { href: r.url, target: "_blank", rel: "noopener", text: "打开上传页" }), h("span", { class: "meta" }, " · ", rt(r.expires, "", "失效"))),
          h("div", { class: "row" }, copyBtn(function () { return location.origin + r.url; }, "复制上传链接"))));
        out.firstChild.style.marginBottom = "16px";
      }, function (e) { up.disabled = false; fail(e); });
    });
    var head = h("div", { class: "tools-row" }, up, h("span", { class: "meta", text: "大文件放这里，一个最大 2 GB，过几天自动删。" }));
    swap(pane, [head, out, j.files.length ? h("div", { class: "flist" }, j.files.map(function (f) {
      return frow(extOf(f.name), f.name, f.url, [f.ref, f.size_text, f.by ? f.by + " 传的" : "", rt(f.expires, "", "到期")], h("a", { class: "ib", href: f.url, "aria-label": "下载 " + f.name, title: "下载" }, icon("download")));
    })) : empty("文件箱是空的")]);
  });
}

// ---------- 监控和额度 ----------
function watch(root) {
  return Promise.all([api("monitors"), api("plan")]).then(function (r) {
    var m = r[0], p = r[1];
    var left = h("div"), right = h("div");
    var up = card("", "网站在线");
    if (!m.uptime.length) up.b.appendChild(empty("没有在盯的网站", "在群里说“盯一下我们网站能不能打开”就会加上。"));
    m.uptime.forEach(function (u) {
      var s = monState(u), el = h("div", { class: "mon" }, h("span", { class: "t" }, h("span", { class: "dot " + s.cls, "aria-hidden": "true" }), h("span", { text: u.name })),
        h("span", { class: "st " + s.t }, s.word, u.state === "down" && u.since ? h("span", { class: "meta" }, " ", rt(u.since, "", "起")) : null),
        h("span", { class: "u" }, [u.url, u.ms ? u.ms + " 毫秒" : "", rt(u.last, "查于 ")].filter(Boolean).map(function (x, i) { return i ? [" · ", x] : x; })));
      if (u.state === "down" && u.error) el.appendChild(h("span", { class: "u bad-t", text: u.error }));
      if (u.days && u.days.length) {
        var dd = h("span", { class: "days", role: "img", "aria-label": "最近 7 天在线 " + (u.uptime_7d === null ? "未知" : u.uptime_7d + "%") });
        u.days.forEach(function (x) { dd.appendChild(h("i", { class: x.pct === null ? "n" : x.pct >= 99.9 ? "" : x.pct >= 99 ? "w" : "b", title: x.date.slice(5) + " " + (x.pct === null ? "还没开始盯" : x.pct + "%") })); });
        dd.appendChild(h("span", { text: u.uptime_7d === null || u.uptime_7d === undefined ? "" : "7 天 " + u.uptime_7d + "%" }));
        el.appendChild(dd);
      }
      up.b.appendChild(el);
    });
    left.appendChild(up.el);
    var fe = card("", "订阅");
    if (!m.feeds.length) fe.b.appendChild(empty("没有订阅"));
    else fe.b.appendChild(h("ul", { class: "list" }, m.feeds.map(function (f) {
      return h("li", {}, h("div", { class: "row" }, h("b", { text: f.title }), f.active ? null : badge("", "停了"), f.fails ? badge("warn", "连续 " + f.fails + " 次没取到", "alert") : null),
        f.latest ? h("p", { class: "meta" }, "最新：", f.latest.link ? h("a", { href: f.latest.link, target: "_blank", rel: "noopener noreferrer", text: f.latest.title || f.latest.link }) : f.latest.title, f.latest.at ? [" · ", rt(f.latest.at)] : null) : null,
        h("p", { class: "meta" }, rt(f.last, "查于 ")));
    })));
    fe.el.style.marginTop = "16px"; left.appendChild(fe.el);
    var wa = card("", "盯着的网页");
    if (!m.watches.length) wa.b.appendChild(empty("没有在盯的网页"));
    else wa.b.appendChild(h("ul", { class: "list" }, m.watches.map(function (w) {
      return h("li", {}, h("div", { class: "row" }, h("b", { text: w.what || w.url }), w.active ? null : badge("", "停了"), w.hits ? badge("", "提醒过 " + w.hits + " 次") : null),
        w.state ? h("p", { text: "现在：" + w.state }) : null, h("p", { class: "meta" }, w.url, " · ", rt(w.last, "查于 ")));
    })));
    wa.el.style.marginTop = "16px"; left.appendChild(wa.el);
    var sp = card("", "今天花的钱"); sp.b.appendChild(spendBlock(p.spend)); right.appendChild(sp.el);
    var pl = card("", "这个月的套餐额度"); pl.b.appendChild(h("p", { class: "meta", text: p.plan.cycle + "。" + p.plan.rule + "。" })); pl.b.appendChild(planRows(p.plan.items, false));
    pl.el.style.marginTop = "16px"; right.appendChild(pl.el);
    swap(root, h("div", { class: "wgrid" }, left, right));
  });
}

// ---------- 工具 ----------
function toolsView(root) {
  return api("tools").then(function (j) {
    var top = h("div", { class: "card tbox" }, h("p", { text: "图片、PDF、二维码、时间换算这些小活，在你自己的浏览器里做，文件不上传。" }), h("a", { class: "btn pri", href: j.link }, "打开工具箱", icon("right")));
    var grid = h("div", { class: "agrid" }, j.abilities.map(function (a) {
      return h("section", { class: "card ab" }, h("h2", { text: a.title }), h("p", { text: a.what }), h("ul", {}, a.examples.map(function (e) { return h("li", {}, h("span", { text: e }), copyBtn(e)); })));
    }));
    swap(root, [top, h("div", { class: "sect" }, h("h2", { text: "怎么叫 Bot" }), h("p", { class: "lede", text: "在群里 @ 它，把下面的话换成你的内容发出去。" }), grid)]);
  });
}

// ---------- shell: routing, refresh, keys ----------
var VIEWS = {
  home: { t: "概览", load: home, auto: true },
  tasks: { t: "任务", load: tasksView, arg: tasksArg, auto: true },
  team: { t: "战绩", load: team, auto: true },
  wall: { t: "功勋墙", load: wallView, auto: true },
  shop: { t: "兑换", load: shopView, arg: shopArg },
  redemptions: { t: "兑换台账", load: redemptionsView },
  feed: { t: "动态", load: feed, arg: feedArg },
  works: { t: "作品和文件", load: works },
  repos: { t: "仓库", load: repos, auto: true },
  memory: { t: "记忆", load: memory },
  watch: { t: "监控和额度", load: watch, auto: true },
  tools: { t: "工具", load: toolsView }
};
var ORDER = ["home", "tasks", "team", "wall", "feed", "works", "repos", "memory", "watch", "tools"];
var GKEY = { h: "home", t: "tasks", z: "team", b: "wall", d: "shop", f: "feed", w: "works", r: "repos", m: "memory", s: "watch", o: "tools" };
var cur = "", loaded = {}, loading = {}, route = { id: "", arg: "" }, hops = 0;
function go(h2) { location.hash = "#" + h2; }
function parse() {
  var raw = (location.hash || "").slice(1), i = raw.indexOf("/");
  var id = i < 0 ? raw : raw.slice(0, i), arg = i < 0 ? "" : raw.slice(i + 1);
  try { arg = decodeURIComponent(arg); } catch (e) {}
  return { id: VIEWS[id] ? id : "home", arg: VIEWS[id] ? arg : "" };
}
function load(id, quiet) {
  if (loading[id]) return loading[id];
  var root = document.querySelector("#s-" + id + " .body");
  if (!root.firstChild) root.appendChild(skel(id === "home" || id === "repos" || id === "tools" ? "cards" : "", 7));
  if (!quiet) $("refresh").classList.add("spin");
  var p = Promise.resolve().then(function () { return VIEWS[id].load(root); }).then(function () { loaded[id] = Date.now(); stamp(); }, function (e) {
    loaded[id] = 0;
    if (root.querySelector(".skel")) swap(root, [empty("没载入成功", e && e.message !== "401" ? e.message : ""), h("button", { type: "button", class: "btn", onclick: function () { load(id); } }, "再试一次")]);
    else if (!quiet) fail(e);
  });
  loading[id] = p;
  return p.then(function () { loading[id] = null; $("refresh").classList.remove("spin"); });
}
function show() {
  var r = parse(), prev = route;
  route = r;
  if (!/^\w+\/./.test((location.hash || "").slice(1))) DW.back = false;
  popClose(false); sheet(false); lbClose();
  if (r.id !== cur) {
    if (DW.key && !(r.arg && VIEWS[r.id].arg)) drawerClose();
    cur = r.id;
    var navId = r.id === "shop" ? "team" : r.id;
    document.querySelectorAll("a[data-tab]").forEach(function (a) { if (a.getAttribute("data-tab") === navId) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    var inMore = ["wall", "works", "repos", "memory", "watch", "tools"].indexOf(r.id) >= 0; if (inMore) $("more-btn").setAttribute("aria-current", "page"); else $("more-btn").removeAttribute("aria-current");
    document.querySelectorAll("main > section").forEach(function (s) { s.hidden = s.id !== "s-" + r.id; });
    $("title").textContent = VIEWS[r.id].t;
    document.title = VIEWS[r.id].t + " · 看板";
    if (prev.id) window.scrollTo(0, 0);
    store.set("last", { id: r.id, at: Date.now() });
  }
  var stale = !loaded[r.id] || Date.now() - loaded[r.id] > 90000;
  var ready = stale ? load(r.id) : Promise.resolve();
  ready.then(function () { if (route === r && VIEWS[r.id].arg) VIEWS[r.id].arg(r.arg); });
  stamp();
}
function stamp() { $("stamp").textContent = loaded[cur] ? "更新于 " + ago(loaded[cur]) : ""; }
function quiet() {
  var a = document.activeElement, tag = a && a.tagName;
  return document.visibilityState !== "hidden" && $("drawer").hidden && $("lb").hidden && $("pop").hidden && $("more").hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(tag || "") && !dragId;
}
function tick() {
  document.querySelectorAll("time.rt:not([data-x])").forEach(function (t) { t.textContent = t.getAttribute("data-p") + ago(+t.getAttribute("data-ts")) + t.getAttribute("data-s"); });
  stamp();
  if (cur && VIEWS[cur].auto && loaded[cur] && Date.now() - loaded[cur] > 90000 && quiet()) load(cur, true);
}
function helpPop(anchor) {
  var keys = [["G H", "概览"], ["G T", "任务"], ["G Z", "战绩"], ["G B", "功勋墙"], ["G D", "兑换"], ["G F", "动态"], ["G W", "作品和文件"], ["G R", "仓库"], ["G M", "记忆"], ["G S", "监控和额度"], ["G O", "工具"], ["1 9", "按顺序切换分区"], ["N", "新任务"], ["/", "搜索当前分区"], ["R", "刷新"], ["← →", "看图时翻页"], ["Esc", "关掉弹窗"]];
  popOpen(anchor, h("div", { role: "dialog", "aria-label": "快捷键" }, h("dl", { class: "keys" }, keys.map(function (k) { return [h("dt", {}, k[0].split(" ").map(function (x, i) { return [i ? (k[0] === "1 9" ? " – " : " ") : null, h("kbd", { text: x })]; })), h("dd", { text: k[1] })]; }))));
}
var gWait = 0;
function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  var t = e.target, typing = t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
  if (e.key === "Escape") {
    if (popClose()) return;
    if (lbClose()) return;
    if (!$("more").hidden) { sheet(false); $("more-btn").focus(); return; }
    if (DW.key) { e.preventDefault(); leaveDrawer(); return; }
    if (typing && t.getAttribute("data-search") && t.value) { t.value = ""; t.dispatchEvent(new Event("input")); }
    return;
  }
  if (e.key === "Tab") { if (DW.key) trap(e, $("drawer").querySelector(".dw")); else if (!$("lb").hidden) trap(e, $("lb")); else if (!$("more").hidden) trap(e, $("more").querySelector(".sheet-in")); return; }
  if (!$("lb").hidden) { if (e.key === "ArrowLeft") lbStep(-1); else if (e.key === "ArrowRight") lbStep(1); return; }
  if (typing || DW.key) return;
  var k = (e.key || "").toLowerCase();
  if (gWait) { gWait = 0; if (GKEY[k]) { e.preventDefault(); go(GKEY[k]); } return; }
  if (k === "g") { gWait = 1; setTimeout(function () { gWait = 0; }, 1500); return; }
  if (/^[1-9]$/.test(k)) { go(ORDER[+k - 1]); return; }
  if (k === "n") { e.preventDefault(); go("tasks/new"); return; }
  if (k === "r") { load(cur); mine(); return; }
  if (k === "/") { var s = document.querySelector("#s-" + cur + " [data-search]"); if (s) { e.preventDefault(); s.focus(); } return; }
  if (e.key === "?") helpPop($("help"));
}
function logout() {
  api("logout", {}).then(function () { gone("已经退出了。要再进来，点群里 Bot 发的看板链接。"); }, fail);
}
function start() {
  window.addEventListener("hashchange", function () { hops++; var r = parse(); if (r.arg && VIEWS[r.id].arg && !DW.key) DW.back = hops > 0; show(); });
  document.addEventListener("keydown", onKey);
  document.addEventListener("click", function (e) {
    var t = e.target;
    var tm = t.closest && t.closest("time.rt");
    if (tm && !tm.closest("a, button")) { var x = tm.hasAttribute("data-x"); if (x) tm.removeAttribute("data-x"); else tm.setAttribute("data-x", "1"); tm.textContent = x ? tm.getAttribute("data-p") + ago(+tm.getAttribute("data-ts")) + tm.getAttribute("data-s") : exact(+tm.getAttribute("data-ts")); }
    if (!$("pop").hidden && !$("pop").contains(t) && !(POP.anchor && POP.anchor.contains(t))) popClose(false);
    if (t.getAttribute && t.getAttribute("data-close")) { if (t.closest("#drawer")) leaveDrawer(); else sheet(false); }
  });
  $("dw-x").addEventListener("click", leaveDrawer);
  $("more-btn").addEventListener("click", function () { sheet($("more").hidden); });
  $("refresh").addEventListener("click", function () { load(cur); });
  $("help").addEventListener("click", function () { if (!$("pop").hidden) popClose(); else helpPop($("help")); });
  $("logout").addEventListener("click", logout); $("logout2").addEventListener("click", logout);
  $("lb-x").addEventListener("click", lbClose);
  $("lb-prev").addEventListener("click", function () { lbStep(-1); });
  $("lb-next").addEventListener("click", function () { lbStep(1); });
  var sx = 0, sy = 0, st = $("lb-stage");
  st.addEventListener("touchstart", function (e) { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
  st.addEventListener("touchend", function (e) { var dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy; if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) lbStep(dx < 0 ? 1 : -1); else if (dy > 90 && Math.abs(dy) > Math.abs(dx) * 2) lbClose(); }, { passive: true });
  st.addEventListener("click", function (e) { if (e.target === st) lbClose(); });
  window.addEventListener("scroll", function () { document.querySelector("header.bar").classList.toggle("stuck", window.pageYOffset > 4); }, { passive: true });
  onMq(WIDE, function () { if (cur === "tasks" && loaded.tasks) tasksView(document.querySelector("#s-tasks .body")).catch(fail); });
  document.addEventListener("visibilitychange", tick);
  setInterval(tick, 30000);
  if (!location.hash) { var last = store.get("last", null); if (last && VIEWS[last.id] && Date.now() - last.at < 30 * 60000) location.replace("#" + last.id); }
  api("me").then(function (j) {
    me = j;
    ["who", "who2"].forEach(function (id) { $(id).textContent = j.name; });
    mine(); setInterval(function () { if (document.visibilityState !== "hidden") mine(); }, 300000);
    ["av", "av2"].forEach(function (id) { $(id).textContent = initial(j.name); $(id).title = j.name; });
    $("logout").title = "退出（" + j.name + "）";
    show();
  }, function (e) { if (e.message !== "401") { fail(e); show(); } });
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
`);
