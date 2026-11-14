// Feed subscriptions: RSS / Atom sources (blogs, GitHub releases and commits, arXiv, Hacker News, YouTube) that the
// group picks. Every tick pulls a few due feeds with conditional requests and stores new items; feeds added with
// notify announce each new item, the others stay silent and feed the daily digest through `latest`.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { fmtFull, BJ } from "../util.ts";

export const LIMITS = {
  perConv: 40, perTick: 3, keepItems: 200, keepDays: 60, maxBytes: 2 * 1024 * 1024, timeoutMs: 10000,
  defaultEvery: 60, minEvery: 15, maxEvery: 10080, failsToPause: 10, maxBackoffMs: 24 * 3600000,
  perFeedNotifyDaily: 5, summary: 400, claimMs: 10 * 60000,
};

/** Seams the tests replace: the network and the random source. */
export const deps = {
  fetch: (url: string, init: any): Promise<Response> => fetch(url, init),
  random: (): number => Math.random(),
};

type Feed = {
  id: number; conv: string; url: string; title: string; kind: string; every_min: number; last: number | null; next: number;
  etag: string | null; modified: string | null; fails: number; active: number; notify: number; by: string; created: number;
};
export type Item = { guid: string; title: string; link: string; summary: string; published: number | null; authors: string[]; categories: string[] };
export type Parsed = { format: "rss" | "atom"; title: string; link: string; items: Item[] };

const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// ---------- the XML reader ----------
type XNode = { n: string; a: Record<string, string>; k: XNode[]; t?: string };

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  copy: "©", reg: "®", trade: "™", middot: "·", bull: "•", laquo: "«", raquo: "»", times: "×", deg: "°", euro: "€", pound: "£", yen: "¥", larr: "←", rarr: "→",
};
export function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z][a-zA-Z0-9]*));/g, (m, d, h, name) => {
    if (name) return NAMED[name] ?? NAMED[name.toLowerCase()] ?? m;
    const cp = d ? parseInt(d, 10) : parseInt(h, 16);
    try { return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; } catch { return m; }
  });
}

const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/([^\s>]+)\s*>|<([^\s\/>!?][^\s\/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)|</g;
const ATTR = /([^\s=\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/** Tolerant reader: unclosed tags, stray `<`, CDATA and comments do not stop it. Text nodes are `#` children. */
export function parseXml(xml: string): XNode {
  const root: XNode = { n: "#root", a: {}, k: [] };
  const stack: XNode[] = [root];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { if (m[1]) top.k.push({ n: "#", a: {}, k: [], t: m[1] }); }
    else if (m[2] !== undefined) {
      const name = m[2].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].n === name) { stack.length = i; break; }
    } else if (m[3] !== undefined) {
      const a: Record<string, string> = {};
      let am: RegExpExecArray | null;
      ATTR.lastIndex = 0;
      while ((am = ATTR.exec(m[4]))) a[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
      const node: XNode = { n: m[3].toLowerCase(), a, k: [] };
      top.k.push(node);
      if (!m[5] && stack.length < 200) stack.push(node);
    } else if (m[6] !== undefined) top.k.push({ n: "#", a: {}, k: [], t: decodeEntities(m[6]) });
    else top.k.push({ n: "#", a: {}, k: [], t: "<" });
    if (m[0].length === 0) TOKEN.lastIndex++;
  }
  return root;
}

const kids = (n: XNode, name: string) => n.k.filter(c => c.n === name);
const kid = (n: XNode, name: string) => n.k.find(c => c.n === name);
// Elements inside a text field (raw HTML that was not escaped) count as word breaks.
const fullText = (n: XNode): string => (n.n === "#" ? n.t || "" : n.k.map(c => (c.n === "#" ? c.t || "" : " " + fullText(c) + " ")).join(""));
const textOf = (n: XNode | undefined) => (n ? fullText(n).trim() : "");
const find = (n: XNode, names: Set<string>, out: XNode[] = []): XNode[] => {
  for (const c of n.k) { if (c.n !== "#") { if (names.has(c.n)) out.push(c); else find(c, names, out); } }
  return out;
};

/** HTML to one line of plain text: tags out, block breaks to spaces, entities decoded. */
export function stripHtml(html: string): string {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/?(?:p|div|br|li|ul|ol|h[1-6]|tr|td|pre|blockquote|table|section|article|hr)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/<[^>]*$/, ""))
    .replace(/[\s\u200b]+/g, " ").trim();
}

const ZONES: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -5, EDT: -4, CST: -6, CDT: -5, MST: -7, MDT: -6, PST: -8, PDT: -7, CET: 1, CEST: 2, JST: 9, BST: 1 };
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** RFC 822 ("Sat, 14 Nov 2026 18:56:47 +0000") and ISO 8601 to milliseconds; null when it is neither. */
export function parseDate(s: string | undefined | null): number | null {
  const v = String(s || "").trim();
  if (!v) return null;
  const r = v.match(/^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,5}|[+-]\d{2}:?\d{2})?$/);
  if (r) {
    const mon = MONTHS.indexOf(r[2].slice(0, 3).toLowerCase());
    if (mon >= 0) {
      let y = Number(r[3]); if (r[3].length <= 2) y += y < 50 ? 2000 : 1900;
      let off = 0;
      const z = r[7];
      if (z) {
        const n = z.match(/^([+-])(\d{2}):?(\d{2})$/);
        off = n ? (n[1] === "-" ? -1 : 1) * (Number(n[2]) * 60 + Number(n[3])) : (ZONES[z.toUpperCase()] ?? 0) * 60;
      }
      const t = Date.UTC(y, mon, Number(r[1]), Number(r[4] || 0), Number(r[5] || 0), Number(r[6] || 0)) - off * 60000;
      return Number.isFinite(t) ? t : null;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
    // "2026-11-13 17:11:41" has no zone and a space instead of T: read it as UTC.
    const iso = /^\d{4}-\d{2}-\d{2} \d/.test(v) ? v.replace(" ", "T") : v;
    const t = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(iso) || !/T/.test(iso) ? iso : iso + "Z");
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

function pickLink(entry: XNode, base: string): string {
  const cands = kids(entry, "link").map(l => ({ rel: (l.a.rel || "").toLowerCase(), href: (l.a.href || textOf(l)).trim() })).filter(c => c.href);
  const best = cands.find(c => !c.rel || c.rel === "alternate") || cands.find(c => !["self", "enclosure", "related", "replies", "edit", "via", "hub"].includes(c.rel));
  let link = best?.href || "";
  if (!link) { const g = kid(entry, "guid"); const gv = textOf(g); if (gv.startsWith("http") && g?.a.ispermalink !== "false") link = gv; }
  if (link && !/^[a-z][a-z0-9+.-]*:/i.test(link) && base) { try { link = new URL(link, base).href; } catch { /* keep */ } }
  return link;
}

const arxivStrip = /^arXiv:\S+\s+Announce Type:\s*\S+\s*Abstract:\s*/i;

function readItem(e: XNode, base: string): Item | null {
  let title = textOf(kid(e, "title")) || textOf(kid(e, "media:title"));
  if (/<[a-z!\/]/i.test(title)) title = stripHtml(title);
  title = title.replace(/\s+/g, " ").trim();
  const link = pickLink(e, base);
  const guid = textOf(kid(e, "guid")) || textOf(kid(e, "id")) || e.a["rdf:about"] || link || title;
  if (!guid) return null;
  const mg = kid(e, "media:group");
  const body = [kid(e, "description"), kid(e, "summary"), kid(e, "content"), kid(e, "content:encoded"), kid(e, "media:description"), mg && kid(mg, "media:description")]
    .map(n => stripHtml(textOf(n || undefined))).find(s => s) || "";
  const dateRaw = ["published", "pubdate", "dc:date", "issued", "updated", "modified"].map(k => textOf(kid(e, k))).find(s => s && parseDate(s) !== null);
  const authors = [...kids(e, "author").map(a => textOf(kid(a, "name")) || textOf(a)), ...kids(e, "dc:creator").map(textOf)].map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean);
  const pc = kid(e, "arxiv:primary_category")?.a.term;
  const categories = [...new Set([...(pc ? [pc] : []), ...kids(e, "category").map(c => (c.a.term || textOf(c)).trim()).filter(Boolean)])];
  let summary = body;
  const comments = textOf(kid(e, "comments"));
  if (host(comments) === "news.ycombinator.com") summary = "讨论：" + comments;
  if (/(^|\.)arxiv\.org$/.test(host(link)) || /^oai:arxiv/i.test(guid)) {
    summary = summary.replace(arxivStrip, "");
    let who = authors.length === 1 && authors[0].includes(",") ? authors[0].split(/,\s*/) : authors;
    who = who.filter(Boolean);
    const head = (categories.length ? `[${categories.slice(0, 3).join(", ")}] ` : "") +
      (who.length ? who.slice(0, 3).join(", ") + (who.length > 3 ? ` 等 ${who.length} 人` : "") + "：" : "");
    summary = head + summary;
  }
  return { guid, title, link, summary: clip(summary, LIMITS.summary), published: parseDate(dateRaw), authors, categories };
}

/** Reads RSS 2.0, RSS 1.0 (RDF) and Atom; throws 「不是订阅源」 for anything else. */
export function parseFeed(xml: string, base = ""): Parsed {
  const doc = parseXml(xml);
  const top = find(doc, new Set(["rss", "feed", "rdf:rdf"]))[0];
  if (!top) throw new Error("这个链接不是订阅源");
  const format = top.n === "feed" ? "atom" : "rss";
  const chan = top.n === "feed" ? top : kid(top, "channel") || top;
  let title = textOf(kid(chan, "title"));
  if (/<[a-z!\/]/i.test(title)) title = stripHtml(title);
  const link = pickLink(chan, base);
  const items = find(top, new Set(["item", "entry"])).map(e => readItem(e, base || link)).filter((x): x is Item => !!x);
  return { format, title: title.replace(/\s+/g, " ").trim(), link, items };
}

/** The first RSS/Atom link an HTML page advertises, for people who paste a site address. */
export function discoverFeed(html: string, base: string): string | null {
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a: Record<string, string> = {};
    for (const am of m[0].matchAll(ATTR)) a[am[1].toLowerCase()] = decodeEntities(am[2] ?? am[3] ?? am[4] ?? "");
    if (/alternate/i.test(a.rel || "") && /(rss|atom)\+xml/i.test(a.type || "") && a.href) { try { return new URL(a.href, base).href; } catch { /* next */ } }
  }
  return null;
}

// ---------- which URL does the user mean ----------
const ARXIV_CAT = /^(?:[a-z-]{2,12}\.[A-Za-z-]{2,20}|cs|stat|math|eess|econ|physics|astro-ph|cond-mat|hep-th|hep-ph|hep-ex|hep-lat|gr-qc|quant-ph|nucl-th|nucl-ex|math-ph|nlin|q-bio|q-fin)$/;
const UPPER_SUB = new Set(["cs", "stat", "math", "eess", "econ", "q-bio", "q-fin", "astro-ph"]);
export type Source = { url: string } | { error: string };

/** `github:o/r` (releases), `github:o/r@branch` (commits), `arxiv:cs.AI`, `arxiv:keywords`, `hn`, `youtube:UC…`, or a plain URL. */
export function expandSource(input: string): Source {
  const s = String(input || "").trim();
  if (!s) return { error: "要给一个订阅源：链接，或者 github:owner/repo、arxiv:cs.AI、hn 这样的简写" };
  const sh = s.match(/^([a-z]+):(?!\/\/)\s*(.*)$/i);
  if (sh || /^hn$/i.test(s)) {
    const kind = (sh ? sh[1] : s).toLowerCase(), arg = sh ? sh[2].trim() : "";
    if (kind === "github" || kind === "gh") {
      const g = arg.match(/^([\w.-]+)\/([\w.-]+?)(?:@(\S+))?$/);
      if (!g) return { error: "github 简写要写成 github:owner/repo（看新版本）或 github:owner/repo@分支名（看提交）" };
      return { url: g[3] ? `https://github.com/${g[1]}/${g[2]}/commits/${encodeURI(g[3])}.atom` : `https://github.com/${g[1]}/${g[2]}/releases.atom` };
    }
    if (kind === "arxiv") {
      if (!arg) return { error: "arxiv 简写要写成 arxiv:cs.AI（某个分类）或 arxiv:英文关键词" };
      if (ARXIV_CAT.test(arg)) { const [a0, a1] = arg.split("."); const cat = a1 && UPPER_SUB.has(a0.toLowerCase()) ? a0.toLowerCase() + "." + a1.toUpperCase() : arg; return { url: `https://rss.arxiv.org/rss/${cat}` }; }
      if (/[^\x00-\x7f]/.test(arg)) return { error: "arXiv 只能搜英文，请把关键词换成英文再试" };
      const q = arg.split(/\s+/).map(w => "all:" + encodeURIComponent(w.replace(/[^\w.-]/g, ""))).filter(w => w !== "all:").join("+AND+");
      if (!q) return { error: "关键词里没有能搜的字" };
      return { url: `https://export.arxiv.org/api/query?search_query=${q}&sortBy=submittedDate&sortOrder=descending&max_results=20` };
    }
    if (kind === "hn") return { url: arg === "best" ? "https://hnrss.org/best" : arg === "newest" ? "https://hnrss.org/newest?points=100" : "https://hnrss.org/frontpage" };
    if (kind === "youtube" || kind === "yt") {
      if (/^UC[\w-]{22}$/.test(arg)) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${arg}` };
      return { error: "youtube 简写要写成 youtube:频道 ID（UC 开头），或者直接给频道页链接" };
    }
    if (kind === "bilibili" || kind === "bili") return { error: BILI };
    if (kind !== "http" && kind !== "https") return { error: "不认识 " + kind + ": 这种简写。可以用链接，或 github:、arxiv:、hn、youtube:" };
  }
  if (!/^https?:\/\/\S+$/i.test(s)) return { error: "要一个 http 或 https 开头的完整链接，或 github:owner/repo、arxiv:cs.AI、hn 这样的简写" };
  const h = host(s);
  if (/(^|\.)(bilibili\.com|b23\.tv)$/.test(h)) return { error: BILI };
  let u: URL;
  try { u = new URL(s); } catch { return { error: "链接格式不对" }; }
  if (h === "github.com") {
    const p = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (p.length === 2 || (p.length === 3 && p[2] === "releases")) return { url: `https://github.com/${p[0]}/${p[1]}/releases.atom` };
    if (p.length >= 4 && p[2] === "commits" && !p[p.length - 1].endsWith(".atom")) return { url: `https://github.com/${p[0]}/${p[1]}/commits/${p.slice(3).join("/")}.atom` };
  }
  const yt = u.pathname.match(/^\/channel\/(UC[\w-]{22})/);
  if (/(^|\.)youtube\.com$/.test(h) && yt) return { url: `https://www.youtube.com/feeds/videos.xml?channel_id=${yt[1]}` };
  return { url: u.href };
}
const BILI = "B 站没有订阅源，订阅不了。想盯某个 UP 主有没有新视频，可以用网页监控（watch）去盯他的空间页。";

/** arXiv names its search feeds "arXiv Query: search_query=…", which tells the group nothing. */
function niceTitle(url: string, title: string): string {
  if (!/^arXiv Query:/i.test(title)) return title;
  try { return "arXiv 搜索：" + (new URL(url).searchParams.get("search_query") || "").replace(/\ball:/g, "").replace(/\s+AND\s+/g, " "); } catch { return title; }
}

export function kindOf(url: string, format: string): string {
  const h = host(url);
  if (h === "github.com") return /\/commits\//.test(url) ? "github-commits" : "github-releases";
  if (h.endsWith("arxiv.org")) return "arxiv";
  if (h === "hnrss.org") return "hn";
  if (h.endsWith("youtube.com")) return "youtube";
  return format;
}

// ---------- fetching ----------
type Pulled = { status: number; text: string; etag: string | null; modified: string | null };

async function readBody(res: Response, limit: number, truncate: boolean): Promise<string> {
  const len = Number(res.headers.get("content-length") || 0);
  if (!truncate && len > limit) throw new Error("内容太大（超过 2 MB）");
  const ct = res.headers.get("content-type") || "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
      if (total > limit) { try { await reader.cancel(); } catch { /* ignore */ } if (truncate) break; throw new Error("内容太大（超过 2 MB）"); }
    }
  } else { const b = new Uint8Array(await res.arrayBuffer()); if (b.length > limit && !truncate) throw new Error("内容太大（超过 2 MB）"); chunks.push(b.slice(0, limit)); total = chunks[0].length; }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  const head = new TextDecoder().decode(all.subarray(0, 300));
  const label = (ct.match(/charset=["']?([\w-]+)/i) || head.match(/<\?xml[^>]*encoding=["']([\w-]+)/i) || [])[1];
  try { return new TextDecoder(label || "utf-8").decode(all); } catch { return new TextDecoder().decode(all); }
}

async function pull(url: string, cond: { etag?: string | null; modified?: string | null } = {}, opts: { limit?: number; truncate?: boolean } = {}): Promise<Pulled> {
  const headers: Record<string, string> = {
    "user-agent": "TeamAgent-Feeds/1.0 (+group bot)", accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5",
  };
  if (cond.etag) headers["if-none-match"] = cond.etag;
  if (cond.modified) headers["if-modified-since"] = cond.modified;
  let res: Response;
  try { res = await deps.fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(LIMITS.timeoutMs) }); }
  catch (e: any) { throw new Error(e?.name === "TimeoutError" || e?.name === "AbortError" ? "连接超时（10 秒没回应）" : "连不上：" + clip(String(e?.message || e), 60)); }
  if (res.status === 304) return { status: 304, text: "", etag: cond.etag ?? null, modified: cond.modified ?? null };
  if (!res.ok) { try { await res.body?.cancel(); } catch { /* ignore */ } throw new Error("对方返回 " + res.status); }
  const text = await readBody(res, opts.limit ?? LIMITS.maxBytes, !!opts.truncate);
  return { status: res.status, text, etag: res.headers.get("etag"), modified: res.headers.get("last-modified") };
}

/** Fetches and parses; if the address is a web page that advertises a feed, follows that once. */
async function load(url: string, cond: Parameters<typeof pull>[1] = {}): Promise<{ url: string; p: Pulled; parsed: Parsed | null }> {
  const p = await pull(url, cond);
  if (p.status === 304) return { url, p, parsed: null };
  try { return { url, p, parsed: parseFeed(p.text, url) }; }
  catch (e) {
    const found = /<html|<!doctype html/i.test(p.text.slice(0, 2000)) ? discoverFeed(p.text, url) : null;
    if (!found || found === url) throw e;
    const p2 = await pull(found);
    return { url: found, p: p2, parsed: parseFeed(p2.text, found) };
  }
}

/** `https://www.youtube.com/@name` to its feed: the channel page names its own id. */
async function resolveYoutube(url: string): Promise<string | null> {
  const u = new URL(url);
  if (!/(^|\.)youtube\.com$/.test(u.hostname) || !/^\/(@|c\/|user\/)/.test(u.pathname)) return null;
  const p = await pull(url, {}, { limit: 600000, truncate: true });
  const id = p.text.match(/rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] || p.text.match(/itemprop="(?:identifier|channelId)" content="(UC[\w-]{22})"/)?.[1];
  return id ? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` : null;
}

// ---------- storing ----------
const jitter = (every: number) => Math.floor(deps.random() * Math.min(every * 0.1, 5) * 60000);
const dayKey = (now: number) => new Date(now + 8 * 3600000).toISOString().slice(0, 10);
type DayState = { d: string; f: Record<string, number>; c: Record<string, number>; o: Record<string, number> };
function dayState(hub: Hub, now: number): DayState {
  try { const s = JSON.parse(hub.get("feeds:day") || "null"); if (s?.d === dayKey(now)) return s; } catch { /* new day */ }
  return { d: dayKey(now), f: {}, c: {}, o: {} };
}

/** Keeps the newest 200 items of a feed, and nothing older than 60 days (by when it was first seen). */
export function prune(hub: Hub, feed: number | null, now: number) {
  hub.sql.exec("DELETE FROM feeditem WHERE seen<?", now - LIMITS.keepDays * 86400000);
  if (feed !== null) hub.sql.exec("DELETE FROM feeditem WHERE feed=? AND id NOT IN (SELECT id FROM feeditem WHERE feed=? ORDER BY COALESCE(published,seen) DESC, id DESC LIMIT ?)", feed, feed, LIMITS.keepItems);
}

const ts = (it: Item, now: number) => Math.min(it.published ?? now, now);

/** Inserts what is new and returns it, newest first. */
function store(hub: Hub, f: Feed, items: Item[], now: number): Item[] {
  const sorted = [...items].sort((a, b) => ts(b, now) - ts(a, now)).slice(0, LIMITS.keepItems);
  const added: Item[] = [];
  for (const it of sorted) {
    const r = rows(hub, "INSERT OR IGNORE INTO feeditem(feed,guid,title,link,summary,published,seen) VALUES(?,?,?,?,?,?,?) RETURNING id",
      f.id, clip(it.guid, 500), clip(it.title, 300), clip(it.link, 1000), it.summary, it.published === null ? null : Math.min(it.published, now), now);
    if (r.length) added.push(it);
  }
  prune(hub, f.id, now);
  return added;
}

async function announce(hub: Hub, f: Feed, added: Item[], now: number) {
  if (!f.notify || !added.length) return;
  const st = dayState(hub, now), src = f.title || host(f.url);
  const cap = Number(hub.edit.cfg(f.conv, "feeds_notify_daily"));
  const room = Math.max(0, Math.min(LIMITS.perFeedNotifyDaily - (st.f[f.id] || 0), cap - (st.c[f.conv] || 0)));
  const show = added.slice(0, room), rest = added.length - show.length;
  const lines = show.reverse().map(it => `【${clip(src, 30)}】${clip(it.title || "（无标题）", 90)}${it.link ? " " + it.link : ""}`);
  if (rest > 0 && !st.o[f.conv]) { st.o[f.conv] = 1; lines.push(`「${clip(src, 30)}」今天新内容多，还有 ${rest} 条没逐条发，想看说一声，我列出来。`); }
  st.f[f.id] = (st.f[f.id] || 0) + show.length; st.c[f.conv] = (st.c[f.conv] || 0) + show.length;
  hub.set("feeds:day", JSON.stringify(st));
  if (lines.length) await hub.say(f.conv, lines.join("\n"));
}

// ---------- one check ----------
export type CheckResult = { ok: boolean; added?: number; notModified?: boolean; error?: string; paused?: boolean; skipped?: string };
const inFlight = new Set<number>();

export async function checkFeed(hub: Hub, f: Feed, now = Date.now(), fresh = false): Promise<CheckResult> {
  const every = f.every_min;
  let got: Awaited<ReturnType<typeof load>>;
  try { got = await load(f.url, fresh ? {} : { etag: f.etag, modified: f.modified }); }
  catch (e: any) {
    const fails = Number(f.fails || 0) + 1, pause = fails >= LIMITS.failsToPause;
    const wait = Math.min(every * 60000 * 2 ** fails, LIMITS.maxBackoffMs);
    hub.sql.exec("UPDATE feed SET last=?, next=?, fails=?, active=? WHERE id=?", now, now + wait, fails, pause ? 0 : 1, f.id);
    if (pause) await hub.say(f.conv, `订阅的「${clip(f.title || host(f.url), 30)}」连着 ${fails} 次拉不到（${clip(e?.message || "", 40)}），先停了：${f.url}\n源恢复后让我重新订阅一次就行。`);
    return { ok: false, error: clip(e?.message || "拉取失败", 80), paused: pause };
  }
  const next = now + every * 60000 + jitter(every);
  if (!got.parsed) { hub.sql.exec("UPDATE feed SET last=?, next=?, fails=0 WHERE id=?", now, next, f.id); return { ok: true, added: 0, notModified: true }; }
  const added = store(hub, f, got.parsed.items, now);
  hub.sql.exec("UPDATE feed SET last=?, next=?, fails=0, etag=?, modified=?, title=? WHERE id=?",
    now, next, got.p.etag, got.p.modified, f.title || clip(got.parsed.title, 120), f.id);
  // A feed's first fetch only fills the shelf: nothing from it is announced.
  if (f.last !== null) await announce(hub, f, added, now);
  return { ok: true, added: f.last === null ? 0 : added.length };
}

async function checkNow(hub: Hub, id: number, conv?: string, fresh = false): Promise<CheckResult> {
  const f = rows(hub, "SELECT * FROM feed WHERE id=?", id)[0] as Feed | undefined;
  if (!f || (conv && f.conv !== conv)) return { ok: false, error: "没有这个编号的订阅" };
  if (inFlight.has(id)) return { ok: false, error: "这个正在拉取，稍等" };
  inFlight.add(id);
  try { return await checkFeed(hub, f, Date.now(), fresh); } finally { inFlight.delete(id); }
}

// ---------- the tool ----------
const everyText = (m: number) => (m % 1440 === 0 ? m / 1440 + " 天" : m % 60 === 0 ? m / 60 + " 小时" : m + " 分钟");
const when = (t: number | null) => (t ? fmtFull(Number(t), BJ) : "");
const like = (w: string) => "%" + w.replace(/[\\%_]/g, "\\$&") + "%";
const view = (r: any, now: number) => ({ title: r.title, link: r.link, time: when(Math.min(r.published ?? r.seen, now)), summary: clip(r.summary || "", 200) });

function pickFeeds(hub: Hub, conv: string, a: any): Feed[] {
  const all = rows(hub, "SELECT * FROM feed WHERE conv=? ORDER BY id", conv) as Feed[];
  const key = a.feed ?? a.id;
  if (key === undefined || key === null || key === "") return all;
  if (/^\d+$/.test(String(key))) return all.filter(f => f.id === Number(key));
  const k = String(key).toLowerCase();
  return all.filter(f => (f.title || "").toLowerCase().includes(k) || f.url.toLowerCase().includes(k));
}

function tools({ hub, conv, askers }: Ctx): Tool[] {
  return [{
    name: "feeds", slow: true,
    description: "订阅信息源，群里要的新内容自动攒下来：博客和网站的 RSS/Atom、GitHub 仓库的新版本和新提交、arXiv 论文、Hacker News、YouTube 频道。" +
      "【写每日摘要/日报/早报时，先调 op=latest 看这个群订阅的源今天有什么新内容，挑重要的写进去，带上链接。】" +
      "op=add：url 填订阅源链接，也可以填简写——github:owner/repo（仓库发新版本）、github:owner/repo@分支（新提交）、arxiv:cs.AI（某个分类的新论文）、arxiv:英文关键词（按关键词搜最新论文，关键词要先翻成英文）、hn（Hacker News 首页）、youtube:频道ID，" +
      "也可以直接给博客/网站/YouTube 频道的网址，我会去找它的订阅源。title 可选，给这个源起个名字；every 是多少分钟查一次（最少 15，默认 60）；" +
      "notify=true 表示有新内容就马上在群里说一句（每个源每天最多 5 条），不填就是安静地攒着，只在 latest 和日报里出现。加的时候会马上拉一次，把源的名字和最新三条告诉群友；已有的内容不会当成新消息刷屏。" +
      "op=list：看这个群订阅了哪些。op=remove：取消订阅，给 id。op=latest：最近的新内容，按源分组带链接，hours 默认 24，可选 feed（编号或名字）、keyword（只看含这个词的）。op=find：用 keyword 在所有攒下的内容里搜（最多留 60 天），可选 feed。" +
      "B 站没有订阅源，订不了。每个群最多订 40 个。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "list", "remove", "latest", "find"] },
        url: { type: "string", description: "op=add：订阅源链接、网站网址，或 github:owner/repo、arxiv:cs.AI、hn 这样的简写" },
        title: { type: "string", description: "op=add：给这个源起的名字，可不填" },
        every: { type: "number", description: "op=add：多少分钟查一次，15 到 10080，默认 60" },
        notify: { type: "boolean", description: "op=add：true 表示有新内容就在群里说，默认 false（只攒着）" },
        id: { type: "number", description: "op=remove：订阅编号" },
        feed: { type: "string", description: "op=latest / find / remove：只看某个源，填编号或名字里的词" },
        hours: { type: "number", description: "op=latest：往前看多少小时，默认 24，最多 1440" },
        keyword: { type: "string", description: "op=latest / find：关键词，多个词用空格隔开，都要出现" },
        limit: { type: "number", description: "op=find：最多返回几条，默认 20，最多 50" },
      },
      required: ["op"],
    },
    run: async a => {
      const now = Date.now();
      const op = String(a.op || "");
      if (op === "list") {
        const fs = rows(hub, "SELECT f.*, (SELECT COUNT(*) FROM feeditem i WHERE i.feed=f.id) n FROM feed f WHERE conv=? ORDER BY id", conv);
        return { ok: true, count: fs.length, feeds: fs.map(f => ({ id: f.id, title: f.title || host(f.url), url: f.url, kind: f.kind, every: everyText(f.every_min), notify: !!f.notify, stored_items: f.n, last_checked: when(f.last) || "还没拉过", status: f.active ? (f.fails ? `在订（最近 ${f.fails} 次没拉到）` : "在订") : "已暂停（连着拉不到）" })) };
      }
      if (op === "remove") {
        const hit = pickFeeds(hub, conv, a);
        if (a.id === undefined && !a.feed) return { ok: false, error: "要给订阅编号（op=list 能看到）" };
        if (hit.length !== 1) return { ok: false, error: hit.length ? "有好几个都对得上，给编号：" + hit.map(f => `#${f.id} ${f.title || host(f.url)}`).join("、") : "这个群里没有这个订阅" };
        hub.sql.exec("DELETE FROM feeditem WHERE feed=?", hit[0].id);
        hub.sql.exec("DELETE FROM feed WHERE id=?", hit[0].id);
        return { ok: true, removed: hit[0].id, title: hit[0].title, url: hit[0].url };
      }
      if (op === "latest" || op === "find") {
        const word = String(a.keyword || "").trim();
        if (op === "find" && !word) return { ok: false, error: "要给一个关键词" };
        const scope = (a.feed ?? "") === "" ? null : pickFeeds(hub, conv, { feed: a.feed });
        if (scope && !scope.length) return { ok: false, error: "这个群里没有这个订阅" };
        const total = Number(hub.sql.exec("SELECT COUNT(*) n FROM feed WHERE conv=?", conv).toArray()[0].n);
        if (!total) return { ok: true, groups: [], note: "这个群还没订阅任何源，群友想看哪些可以让我订阅。" };
        const hours = op === "latest" ? Math.min(1440, Math.max(1, Number(a.hours) > 0 ? Number(a.hours) : 24)) : 0;
        const binds: any[] = [conv];
        let q = "SELECT i.*, f.title ftitle, f.url furl FROM feeditem i JOIN feed f ON f.id=i.feed WHERE f.conv=?";
        if (hours) { q += " AND COALESCE(i.published,i.seen)>=?"; binds.push(now - hours * 3600000); }
        if (scope) { q += ` AND i.feed IN (${scope.map(() => "?").join(",")})`; binds.push(...scope.map(f => f.id)); }
        for (const w of word.split(/\s+/).filter(Boolean).slice(0, 6)) { q += " AND (i.title LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\')"; binds.push(like(w), like(w)); }
        if (op === "find") {
          const lim = Math.min(50, Math.max(1, Number(a.limit) > 0 ? Math.round(Number(a.limit)) : 20));
          const r = rows(hub, q + " ORDER BY COALESCE(i.published,i.seen) DESC, i.id DESC LIMIT ?", ...binds, lim);
          return { ok: true, count: r.length, items: r.map(x => ({ source: x.ftitle || host(x.furl), ...view(x, now) })), note: r.length ? undefined : "攒下的内容里没找到" };
        }
        const r = rows(hub, q + " ORDER BY COALESCE(i.published,i.seen) DESC, i.id DESC LIMIT 200", ...binds);
        const groups = new Map<number, { feed: number; source: string; items: any[]; more: number }>();
        let shown = 0;
        for (const x of r) {
          let g = groups.get(x.feed);
          if (!g) { g = { feed: x.feed, source: x.ftitle || host(x.furl), items: [], more: 0 }; groups.set(x.feed, g); }
          if (g.items.length < 12 && shown < 60) { g.items.push(view(x, now)); shown++; } else g.more++;
        }
        const paused = rows(hub, "SELECT title, url FROM feed WHERE conv=? AND active=0", conv).map(f => f.title || host(f.url));
        return { ok: true, hours, count: r.length, groups: [...groups.values()], paused: paused.length ? paused : undefined, note: r.length ? undefined : `最近 ${hours} 小时订阅的源里没有新内容` };
      }
      if (op !== "add") return { ok: false, error: "op 只能是 add / list / remove / latest / find" };

      // add
      const src = expandSource(String(a.url || ""));
      if ("error" in src) return { ok: false, error: src.error };
      const every = Math.min(LIMITS.maxEvery, Math.max(LIMITS.minEvery, Number(a.every) > 0 ? Math.round(Number(a.every)) : LIMITS.defaultEvery));
      const notify = a.notify === true ? 1 : 0, by = String(askers?.[0]?.name || "");
      let got: Awaited<ReturnType<typeof load>>;
      try {
        let url = src.url;
        const yt = await resolveYoutube(url).catch(() => null);
        if (yt) url = yt;
        got = await load(url);
      } catch (e: any) { return { ok: false, error: "这个源现在拉不下来，没有订阅：" + clip(e?.message || "", 80) }; }
      const url = got.url, parsed = got.parsed!;
      const dup = rows(hub, "SELECT * FROM feed WHERE conv=? AND url=?", conv, url)[0] as Feed | undefined;
      let f: Feed;
      if (dup) {
        hub.sql.exec("UPDATE feed SET every_min=?, notify=?, active=1, fails=0, title=?, next=? WHERE id=?", every, notify, clip(String(a.title || "").trim() || dup.title || niceTitle(url, parsed.title), 120), now + every * 60000 + jitter(every), dup.id);
        f = { ...dup, last: dup.last };
      } else {
        if (Number(hub.sql.exec("SELECT COUNT(*) n FROM feed WHERE conv=?", conv).toArray()[0].n) >= LIMITS.perConv) return { ok: false, error: `这个群已经订了 ${LIMITS.perConv} 个源，先去掉几个再加` };
        const id = Number(rows(hub,
          "INSERT INTO feed(conv,url,title,kind,every_min,last,next,etag,modified,fails,active,notify,by,created) VALUES(?,?,?,?,?,NULL,?,?,?,0,1,?,?,?) RETURNING id",
          conv, url, clip(String(a.title || "").trim() || niceTitle(url, parsed.title) || host(url), 120), kindOf(url, parsed.format), every, now + every * 60000 + jitter(every), got.p.etag, got.p.modified, notify, by, now)[0].id);
        f = rows(hub, "SELECT * FROM feed WHERE id=?", id)[0] as Feed;
      }
      store(hub, f, parsed.items, now);
      hub.sql.exec("UPDATE feed SET last=? WHERE id=?", now, f.id);
      const fresh = rows(hub, "SELECT * FROM feed WHERE id=?", f.id)[0] as Feed;
      const newest = [...parsed.items].sort((x, y) => ts(y, now) - ts(x, now)).slice(0, 3).map(it => ({ title: it.title, link: it.link, time: when(ts(it, now)) }));
      return {
        ok: true, id: f.id, title: fresh.title, url, kind: fresh.kind, every: everyText(every), notify: !!notify, already: dup ? "这个源之前订过，已按这次的设置更新" : undefined,
        newest, note: parsed.items.length ? (notify ? "已有的内容不会刷屏，之后有新的才会在群里说。" : "安静地攒着，日报和 latest 里会出现。") : "这个源现在一条内容都没有（可能在休息日），之后有了会攒下来。",
      };
    },
  }];
}

const feature: Feature = {
  name: "feeds",
  schema: `CREATE TABLE IF NOT EXISTS feed(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, url TEXT, title TEXT, kind TEXT, every_min INTEGER, last INTEGER, next INTEGER, etag TEXT, modified TEXT, fails INTEGER, active INTEGER, notify INTEGER, by TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS feed_due ON feed(active, next);
CREATE TABLE IF NOT EXISTS feeditem(id INTEGER PRIMARY KEY AUTOINCREMENT, feed INTEGER, guid TEXT, title TEXT, link TEXT, summary TEXT, published INTEGER, seen INTEGER, UNIQUE(feed, guid));
CREATE INDEX IF NOT EXISTS feeditem_feed ON feeditem(feed, published);`,
  tunables: {
    feeds_notify_daily: { default: 20, min: 0, max: 200, what: "订阅的源每天最多在群里主动说几条新内容（所有源加起来）" },
  },
  tools,
  tick(hub, now) {
    const today = dayKey(now);
    if (hub.get("feeds:swept") !== today) { hub.set("feeds:swept", today); prune(hub, null, now); }
    const due = rows(hub, "SELECT * FROM feed WHERE active=1 AND next<=? ORDER BY next LIMIT ?", now, LIMITS.perTick) as Feed[];
    for (const f of due) {
      if (inFlight.has(f.id)) continue;
      // Not due again until this check finishes (or the claim runs out, if the Worker is cut off).
      hub.sql.exec("UPDATE feed SET next=? WHERE id=?", now + LIMITS.claimMs, f.id);
      inFlight.add(f.id);
      hub.ctx.waitUntil(checkFeed(hub, f, now).catch(e => console.log("feed check failed", f.id, e?.message)).finally(() => inFlight.delete(f.id)));
    }
  },
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/feeds") return null;
    const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    if (req.method === "POST") return json(await checkNow(hub, Number(body?.check), undefined, body?.fresh === true));
    const now = Date.now(), st = dayState(hub, now);
    return json({
      today: { announced_by_conv: st.c, announced_by_feed: st.f },
      feeds: rows(hub, "SELECT f.*, (SELECT COUNT(*) FROM feeditem i WHERE i.feed=f.id) n FROM feed f ORDER BY id").map(f => ({
        id: f.id, conv: f.conv, url: f.url, title: f.title, kind: f.kind, every_min: f.every_min, notify: !!f.notify, active: !!f.active, fails: f.fails,
        last: when(f.last), due_in_min: Math.round((f.next - now) / 60000), items: f.n, etag: !!f.etag,
      })),
    });
  },
  about: [
    "我能替群里订阅信息源：博客和网站的 RSS/Atom、GitHub 仓库的新版本和新提交、arXiv 某个分类或关键词的新论文、Hacker News 首页、YouTube 频道。B 站没有订阅源，订不了。",
    "订阅的内容我会定期去拉（默认每小时，最短 15 分钟），攒下每个源最新的 200 条、最多留 60 天；写每日摘要时我会把当天的新内容放进去。",
    "订阅时说一声「有新的就告诉大家」，新内容出现我就在群里发一行（源名、标题、链接）；每个源每天最多 5 条，全群每天最多 20 条（可以改），多出来的不刷屏，想看随时让我列。不说的话就安静地攒着。",
    "刚订阅时源里已有的内容不会当成新消息发出来。某个源连着 10 次拉不到，我会说一声并先停下，恢复后让我重新订阅就行。每个群最多订 40 个源。",
  ],
};
export default feature;
