// A public toolbox page at /x/toolbox: small tools that run entirely in the visitor's browser (images,
// PDF, text and developer bits, QR codes, a Beijing/Sydney time table) and a short catalogue of what the
// bot can do with example sentences. Nothing on the page calls the bot; files never leave the device.
// The page source lives in toolbox-page.ts; this file assembles it, serves it with caching and a strict
// CSP, and gives the chat model a `toolbox` tool that hands out (deep) links.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { CSS, APP_JS, TEXT_JS, RX_JS, IMAGE_JS, PDF_JS, QR_JS } from "./toolbox-page.ts";

const DEFAULT_URL = "https://teamagent.inkboard-server.workers.dev";
const BASE = "/x/toolbox";
// The one script fetched from elsewhere, pinned with its published integrity hash (cdnjs SRI).
export const PDFLIB = {
  src: "https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js",
  sri: "sha512-z8IYLHO8bTgFqj+yrPyIJnzBDf7DDhWwiEsk4sY+Oe6J2M+WQequeGS7qioI5vT6rXgVRb4K1UVQC5ER7MKzKQ==",
};

type Part = "text" | "image" | "pdf" | "qr";
type Item = { id: string; title: string; hint: string; parts: Part[] };
export const GROUPS: { name: string; items: Item[] }[] = [
  { name: "图片", items: [
    { id: "img-compress", title: "压缩和缩小", hint: "调质量、限制最长边，看前后大小", parts: ["image"] },
    { id: "img-convert", title: "转格式", hint: "JPEG、PNG、WebP 互转", parts: ["image"] },
    { id: "img-crop", title: "按比例裁剪", hint: "1:1、4:3、16:9 等，可选保留位置", parts: ["image"] },
    { id: "img-clean", title: "去掉定位信息", hint: "重新导出，拍摄信息和 GPS 都不带", parts: ["image"] },
  ] },
  { name: "PDF", items: [
    { id: "pdf-merge", title: "合并", hint: "几个 PDF 按顺序合成一个", parts: ["pdf"] },
    { id: "pdf-split", title: "拆分和提取页", hint: "按页码范围拆开或挑出几页", parts: ["pdf"] },
    { id: "pdf-pages", title: "调页序和旋转", hint: "上移下移、转 90°、删页", parts: ["pdf"] },
    { id: "img-pdf", title: "图片转 PDF", hint: "一张图一页，A4 或原尺寸", parts: ["image", "pdf"] },
  ] },
  { name: "二维码", items: [
    { id: "qr-make", title: "生成二维码", hint: "文字或网址，下载 PNG 或 SVG", parts: ["qr"] },
    { id: "qr-read", title: "识别二维码", hint: "从截图或照片里读出内容", parts: ["qr"] },
  ] },
  { name: "时间", items: [
    { id: "time", title: "时间戳换算", hint: "时间戳和日期互转，北京、悉尼、UTC", parts: ["text"] },
    { id: "tz", title: "北京悉尼时差表", hint: "一天 24 小时对照，含夏令时", parts: ["text"] },
  ] },
  { name: "文字和开发", items: [
    { id: "count", title: "字数统计", hint: "汉字、英文词、字符、字节", parts: ["text"] },
    { id: "diff", title: "文字对比", hint: "两段文字逐行比，标出改动的字", parts: ["text"] },
    { id: "json", title: "JSON 格式化", hint: "格式化、压缩、指出错在哪一行", parts: ["text"] },
    { id: "base64", title: "Base64", hint: "文字或文件编码、解码", parts: ["text"] },
    { id: "url", title: "网址编码", hint: "% 编码解码，拆出链接参数", parts: ["text"] },
    { id: "regex", title: "正则测试", hint: "高亮匹配、分组、替换预览", parts: ["text"] },
    { id: "hash", title: "SHA-256 校验", hint: "文字或文件的哈希，核对下载", parts: ["text"] },
    { id: "uuid", title: "UUID", hint: "v4 或 v7，一次多个", parts: ["text"] },
    { id: "password", title: "随机密码", hint: "长度、字符种类可选", parts: ["text"] },
    { id: "color", title: "颜色换算", hint: "HEX、RGB、HSL 和对比度", parts: ["text"] },
  ] },
];
export const TOOL_IDS = GROUPS.flatMap(g => g.items.map(i => i.id));

// What the bot can do, written for a visitor: no names, no chat content, no private repositories.
// `tools` names the chat tools behind each line; the tests check they still exist.
export const ABILITIES: { title: string; what: string; examples: string[]; tools: string[] }[] = [
  { title: "查资料", what: "联网搜索、读链接全文、做多轮调研并给出处。", examples: ["帮我查一下最近口碑好的降噪耳机", "这篇讲了什么 （贴上链接）", "调研一下 Rust 和 Go 写后端各有什么坑"], tools: ["web_search", "read_url", "research"] },
  { title: "看视频", what: "读 B 站视频的字幕和热评，其他平台的视频也能取下来听一遍再总结。", examples: ["总结一下这个 B 站视频 （贴上链接）", "这个视频里说了哪几个要点"], tools: ["bilibili", "watch_video"] },
  { title: "热榜和行情", what: "各平台实时热榜，A 股、港股、美股行情。", examples: ["微博热搜前十是什么", "看下腾讯和英伟达今天的股价"], tools: ["hot", "stock"] },
  { title: "画图和改图", what: "按描述画图，或者在一张图上接着改；能先查清楚画的东西长什么样。", examples: ["画一张三个人在海边看日落的图，日系插画风", "把刚才那张改成夜景"], tools: ["generate_image"] },
  { title: "表情包", what: "把图片套进现成的表情模板，几秒出图。", examples: ["摸摸他 （回复一张头像）", "做个举牌表情，写“周五不加班”"], tools: ["meme", "sticker"] },
  { title: "排版成图", what: "把方案、总结、对比表排成一张长图，也能画思维导图和流程图。", examples: ["把刚才聊的方案整理成一张图", "画个学 Python 的思维导图"], tools: ["show"] },
  { title: "读文件", what: "读群里发的 PDF、Word、PPT 和截图里的文字。", examples: ["这个 PDF 讲了什么，挑重点说", "把这张截图里的表格整理出来"], tools: ["read_attachment"] },
  { title: "算数据、做表", what: "在云端跑代码：统计、画图表、处理 Excel 和 CSV。", examples: ["把这个表按月份汇总，画个折线图", "算一下每人这个月发了多少条消息"], tools: ["run_python", "computer", "chat_stats"] },
  { title: "处理文件", what: "视频转音频、剪视频、批量处理图片、生成二维码，做好发回群里。", examples: ["把这个视频的声音提出来转成 mp3", "这几张图都压到 1 MB 以内发回来"], tools: ["skill", "computer"] },
  { title: "传大文件", what: "聊天里发不了的大文件，给一个上传链接，传完能直接处理。", examples: ["给我一个上传链接，我传个 1 G 的录屏"], tools: ["filebox"] },
  { title: "定时提醒", what: "到点提醒，或者每天定时做一件事并把结果发群里。", examples: ["每天早上 9 点提醒我喝水", "30 分钟后提醒我拿快递", "每个工作日下午 6 点发一下今天的热搜"], tools: ["schedule"] },
  { title: "记住和忘掉", what: "记下大家的偏好和约定，之后都按这个来；说忘掉就删。", examples: ["记住我不吃香菜", "忘掉刚才那条"], tools: ["remember", "forget"] },
  { title: "翻聊天记录", what: "按关键词或按意思翻以前的聊天，也能总结某天聊了什么。", examples: ["上次聊到去海边是哪天", "总结一下今天群里聊了啥"], tools: ["search_history", "get_history", "recall"] },
  { title: "资料库", what: "群里分享过的文章和文档都存了全文，可以按内容找回来。", examples: ["上周谁发过一篇讲咖啡因的文章"], tools: ["library"] },
  { title: "找论文", what: "搜论文、查详情、给引用格式。", examples: ["找几篇讲扩散模型的综述，给 BibTeX"], tools: ["papers"] },
  { title: "盯着变化", what: "订阅博客、仓库新版本、论文；盯一个网页，变了就说一声；网站挂了也会提醒。", examples: ["这个网页有新版本发布时告诉我 （贴上链接）", "盯一下我们网站能不能打开"], tools: ["feeds", "watch", "uptime"] },
  { title: "网页摘取和存档", what: "从几个网页里按字段摘成表格，或把页面存档成 PDF 和截图。", examples: ["把这三款手机的价格和屏幕尺寸做成表", "把这个页面存个档"], tools: ["web_extract", "web_archive"] },
  { title: "做网页", what: "做个小页面发出来：投票、报名、小游戏、交互图表。", examples: ["做个周末去哪玩的投票页面"], tools: ["publish"] },
  { title: "语音和讲解视频", what: "用不同声音和方言念出来，做播客，把几张图配旁白做成视频。", examples: ["用东北话念一下这段", "把这几张图做成一个讲解视频"], tools: ["speak", "podcast", "narrate"] },
  { title: "代码", what: "读团队仓库、检查团队仓库的体检结果、把网页应用跑起来截图、按要求改代码开草稿 PR。", examples: ["检查团队仓库最近有什么提交", "把这个 PR 的页面跑起来截个图看看"], tools: ["github", "repo_health", "preview_app", "code_task"] },
  { title: "记账", what: "群内账本，谁名下有多少钱。", examples: ["给我记 30 块", "现在每个人余额多少"], tools: ["ledger"] },
  { title: "大活和进度", what: "多步的成品（带图的报告、一组海报、绘本）放到后台做，随时问进度。", examples: ["做一份去日本自由行的图文攻略", "刚才那个做到哪了"], tools: ["plan", "jobs", "make_book"] },
  { title: "额度", what: "这个月云服务额度还剩多少，什么事因为额度被推迟了。", examples: ["这个月云电脑额度还够吗"], tools: ["budget", "usage"] },
];

// "这篇讲了什么 （贴上链接）": the part in full-width brackets at the end is a note, not copied.
export const exampleParts = (e: string): [string, string] => { const m = /^(.*?)\s*（([^（）]+)）$/.exec(e); return m ? [m[1], m[2]] : [e, ""]; };

// ---------- assembling the page ----------
const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
// 53-bit string hash (cyrb53) for ETags and version tags; no crypto needed for a cache key.
function tag(s: string) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
type Asset = { body: string; type: string; etag: string };
const asset = (body: string, type: string): Asset => ({ body, type, etag: '"' + tag(body) + '"' });
const url = (name: string, a: Asset) => BASE + "/" + name + "?v=" + a.etag.slice(1, -1);

function build() {
  const files: Record<string, Asset> = {
    "text.js": asset(TEXT_JS, "text/javascript; charset=utf-8"),
    "rx.js": asset(RX_JS, "text/javascript; charset=utf-8"),
    "image.js": asset(IMAGE_JS, "text/javascript; charset=utf-8"),
    "pdf.js": asset(PDF_JS, "text/javascript; charset=utf-8"),
    "qr.js": asset(QR_JS, "text/javascript; charset=utf-8"),
    "app.css": asset(CSS, "text/css; charset=utf-8"),
  };
  const conf = {
    parts: Object.fromEntries((["text", "image", "pdf", "qr"] as Part[]).map(p => [p, url(p + ".js", files[p + ".js"])])),
    index: Object.fromEntries(GROUPS.flatMap(g => g.items.map(i => [i.id, [i.title, i.parts.length === 1 ? i.parts[0] : i.parts]]))),
    rx: url("rx.js", files["rx.js"]),
    pdflib: PDFLIB,
  };
  // "</" cannot appear in the config, but escape it anyway since the text ends up inside a script file.
  files["app.js"] = asset(APP_JS.replace(/\/\*CONF\*\/[\s\S]*?\/\*END\*\//, JSON.stringify(conf).replace(/</g, "\\u003c")), "text/javascript; charset=utf-8");
  files[""] = asset(page(files), "text/html; charset=utf-8");
  return files;
}

function page(files: Record<string, Asset>) {
  const tools = GROUPS.map(g => `<h2>${esc(g.name)}</h2><ul class="tools">${g.items.map(i =>
    `<li><a href="#${i.id}"><b>${esc(i.title)}</b><span>${esc(i.hint)}</span></a></li>`).join("")}</ul>`).join("");
  const abilities = ABILITIES.map(a => `<div class="ab"><h3>${esc(a.title)}</h3><p>${esc(a.what)}</p><ul class="ex">${a.examples.map(e => {
    const [say, note] = exampleParts(e);
    return `<li><q>${esc(say)}${note ? ` <small>${esc(note)}</small>` : ""}</q><button type="button" class="sm" data-copy="${esc(say)}" aria-label="复制：${esc(say)}">复制</button></li>`;
  }).join("")}</ul></div>`).join("");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex"><title>工具箱</title><link rel="icon" href="data:,"><link rel="stylesheet" href="${url("app.css", files["app.css"])}">
<script src="${url("app.js", files["app.js"])}" defer></script></head>
<body><header class="top"><a href="#">工具箱</a><span>在你自己的浏览器里算，文件不上传</span></header>
<main class="wrap">
<section id="home">${tools}
<h2 id="bot">机器人能做什么</h2>
<p class="muted">在群里 @ 它，把下面的话换成你的内容发出去。</p>
${abilities}
<p class="foot">PDF 工具第一次用时会从 cdnjs 载入开源库 pdf-lib 1.17.1（带校验），其余代码都来自这个页面。在 QQ 里打开时下载可能没反应，点右上角用浏览器打开。</p>
</section>
<section id="view" hidden><a href="#" class="back">← 全部工具</a><h2 id="vt" tabindex="-1"></h2><div id="vb"></div></section>
<noscript><p>这些工具需要开启 JavaScript。</p></noscript>
</main></body></html>`;
}

let FILES: Record<string, Asset> | null = null;
export const files = () => FILES || (FILES = build());

export const CSP = [
  "default-src 'none'",
  "script-src 'self' " + PDFLIB.src,
  "worker-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export function serve(req: Request, u: URL): Response | null {
  const p = u.pathname;
  if (p !== BASE && !p.startsWith(BASE + "/")) return null;
  const name = p === BASE || p === BASE + "/" ? "" : p.slice(BASE.length + 1);
  const a = files()[name];
  const headers: Record<string, string> = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
  if (!a) return new Response("没有这个页面", { status: 404, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("只支持 GET", { status: 405, headers: { ...headers, Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" } });
  headers["ETag"] = a.etag;
  // The page revalidates every time (cheap 304s) so a deploy shows up at once; the parts it links carry a
  // version tag and can be cached for good, unless an old tag is asked for.
  headers["Cache-Control"] = !name ? "no-cache" : u.searchParams.get("v") === a.etag.slice(1, -1) ? "public, max-age=31536000, immutable" : "public, max-age=300";
  if (!name) { headers["Content-Security-Policy"] = CSP; headers["Cross-Origin-Opener-Policy"] = "same-origin"; }
  const inm = req.headers.get("If-None-Match") || "";
  if (inm.split(",").some(t => t.trim().replace(/^W\//, "") === a.etag)) return new Response(null, { status: 304, headers });
  headers["Content-Type"] = a.type;
  return new Response(req.method === "HEAD" ? null : a.body, { headers });
}

const linkOf = (hub: Hub, id?: string) => String(hub.env.PUBLIC_URL || DEFAULT_URL).replace(/\/+$/, "") + BASE + (id ? "#" + id : "");
const titleOf = (id: string) => GROUPS.flatMap(g => g.items).find(i => i.id === id);

const feature: Feature = {
  name: "toolbox",
  tools: ({ hub }) => [{
    name: "toolbox",
    description: "给群友一个网页工具箱的链接，可以直接打开到某个工具。工具箱里的小工具全在对方自己的手机或电脑浏览器里跑，文件不上传、不占任何额度。有这些：" +
      GROUPS.map(g => g.name + "（" + g.items.map(i => i.id + " " + i.title).join("、") + "）").join("；") + "。" +
      "什么时候给链接：群友想自己动手做这类小转换；文件私密、不想发到群里（证件照去定位、合同 PDF 合并）；只是快速转一下（压一张图、合两个 PDF、算个时间戳、对比两段文字）；或者问“有没有什么工具能……”。" +
      "什么时候不要：群友已经把文件发到群里、要你直接给结果，就自己用 skill 或 computer 做好发回去；视频和音频转码、几百 MB 的文件、OCR、翻译、要看懂内容的活工具箱都做不了。" +
      "tool 填要直接打开的工具编号，不填就给首页（首页也列了你能做的事和可以照抄的说法）。返回 link，原样发出去，可以顺带说一句文件不会离开他的设备。",
    parameters: { type: "object", properties: { tool: { type: "string", enum: TOOL_IDS, description: "要直接打开的工具编号；不填给首页" } } },
    async run(args: any) {
      const id = String(args?.tool || "").trim();
      if (!id) return { ok: true, link: linkOf(hub), what: "工具箱首页：图片、PDF、二维码、时间换算、文字和开发小工具，以及机器人能做什么" };
      const it = titleOf(id);
      if (!it) return { ok: false, error: "没有这个工具，能用的编号：" + TOOL_IDS.join("、") };
      return { ok: true, link: linkOf(hub, id), tool: it.title, what: it.hint };
    },
  }],
  open: (_hub, req, u) => serve(req, u),
  about: [
    "工具箱是一个网页（" + BASE + "），群友收藏起来自己用：图片压缩、转格式、裁剪、去定位，PDF 合并、拆分、调页序、图片转 PDF，生成和识别二维码，时间戳换算和北京悉尼时差表，字数统计、文字对比、JSON、Base64、网址编码、正则、哈希、UUID、随机密码、颜色换算。",
    "这些工具全在打开网页的那台设备上运行，文件不上传，也不花 Bot 的任何额度；只有 PDF 工具第一次用时会从 cdnjs 下载一个开源库 pdf-lib。",
    "首页下半部分列了 Bot 能做的事，每项带一两句可以直接复制到群里的说法。",
    "要给人链接时用 toolbox 工具，能直接打开到某一个小工具。",
  ],
};
export default feature;
