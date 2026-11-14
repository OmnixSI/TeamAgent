// A small data warehouse: twice a day the bot stores market quotes and trending lists, so it can answer
// "这个月纳指怎么走的" / "上周热搜都有啥" from its own history and hand CSVs to run_python for charts.
// Quotes and hot lists come from the existing `stock` and `hot` tools. SQLite holds what history questions
// need (no R2 reads); R2 keeps the full snapshots.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { BJ, fmtDate, zonedToUtc } from "../util.ts";

const DAY = 86400000;
const QUOTE_KEEP_DAYS = 730, HOT_KEEP_DAYS = 180, HOT_TOP = 30, WATCH_MAX = 30;
const R2_SELF_CAP = 300 * 1024 * 1024;   // this feature's own R2 bytes; the real objects are a few KB each

export const DEFAULT_WATCHLIST = ["上证指数", "深证成指", "创业板指", "恒生指数", "恒生科技指数", "纳斯达克指数", "标普500", "道琼斯", "英伟达", "特斯拉", "苹果", "腾讯控股", "阿里巴巴", "贵州茅台", "美元兑人民币", "黄金", "原油"];
export const HOT_SOURCES = ["weibo", "douyin", "bilibili", "zhihu", "baidu", "github", "hackernews"];

/** Names `stock` cannot resolve to the real thing (it returns an ETF or a company with a similar name), mapped to Tencent's own quote codes. */
export const ALIAS: Record<string, { code: string; name: string }> = {};
for (const [names, code, name] of [
  [["纳斯达克指数", "纳指", "纳斯达克综合指数", "纳斯达克", "ixic"], "usIXIC", "纳斯达克指数"],
  [["标普500", "标普500指数", "标普", "inx", "spx"], "usINX", "标普500"],
  [["道琼斯", "道琼斯指数", "道指", "dji"], "usDJI", "道琼斯指数"],
  [["恒生指数", "恒指", "hsi"], "hkHSI", "恒生指数"],
  [["恒生科技指数", "恒生科技", "hstech"], "hkHSTECH", "恒生科技指数"],
  [["美元兑人民币", "美元人民币", "美元对人民币", "usdcny"], "whUSDCNY", "美元兑人民币"],
  [["黄金", "伦敦金", "现货黄金"], "hf_XAU", "黄金（伦敦金）"],
  [["原油", "纽约原油", "wti原油", "wti"], "hf_CL", "原油（纽约WTI）"],
  [["布伦特原油", "布油"], "hf_OIL", "布伦特原油"],
] as [string[], string, string][]) for (const n of names) ALIAS[n.toLowerCase()] = { code, name };

export type Quote = { symbol: string; name: string; price: number; pct: number | null; prev?: number; high?: number; low?: number; volume?: number; time?: string; date: string };
export type HotItem = { rank: number; title: string; heat: string; x?: string };
type Net = { text(url: string, charset: string): Promise<string> };
/** The one network call this file makes itself (Tencent's public quote endpoint); tests replace it. */
export const NET: Net = {
  text: async (url, charset) => new TextDecoder(charset).decode(await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) })).arrayBuffer()),
};

// ---------- time slots ----------
export type Slot = { id: string; kind: "quotes" | "hot"; at: string; within: number; scope: "cnhk" | "us" | "all" };
/** Beijing wall-clock times. A-shares and Hong Kong are closed by 16:30. The US cash close is 04:00 or 05:00 (summer/winter) and the NY metal/oil/FX day ends by 06:00, so 06:10 sees all of them. */
export const SLOTS: Slot[] = [
  { id: "q-cnhk", kind: "quotes", at: "16:30", within: 7.5 * 3600000, scope: "cnhk" },
  { id: "q-us", kind: "quotes", at: "06:10", within: 6 * 3600000, scope: "us" },
  { id: "h-am", kind: "hot", at: "09:00", within: 3 * 3600000, scope: "all" },
  { id: "h-pm", kind: "hot", at: "21:00", within: 3 * 3600000, scope: "all" },
];
/** Slots that are due at `now`: past their time today (Beijing), not too late, not marked done. */
export function dueSlots(now: number, marked: (id: string, day: string) => boolean): { slot: Slot; day: string }[] {
  const day = fmtDate(now, BJ), out: { slot: Slot; day: string }[] = [];
  for (const slot of SLOTS) {
    const start = zonedToUtc(day, slot.at, BJ);
    if (now >= start && now < start + slot.within && !marked(slot.id, day)) out.push({ slot, day });
  }
  return out;
}
const markKey = (id: string, day: string) => "data:mark:" + id + ":" + day;
/** "1" = done; "r<tries>:<ts>" = running or failed, not to be tried before ts. */
function isMarked(hub: Hub, id: string, day: string, now: number) {
  const v = hub.get(markKey(id, day));
  if (!v) return false;
  if (v === "1") return true;
  return now < Number(v.split(":")[1] || 0);
}

// ---------- parsing ----------
const num = (s: any) => { const n = parseFloat(String(s ?? "").replace(/,/g, "")); return Number.isFinite(n) ? n : undefined; };
const DATE_IN = /(\d{4})\D?(\d{2})\D?(\d{2})/;
const dateOf = (s: any) => { const m = String(s ?? "").match(DATE_IN); return m ? m[1] + "-" + m[2] + "-" + m[3] : ""; };

/** One quote as the `stock` tool returns it (all fields strings). */
export function quoteFromStock(q: any): Quote | null {
  const price = num(q?.price), date = dateOf(q?.time);
  if (!q?.symbol || price === undefined || price <= 0 || !date) return null;
  return { symbol: String(q.symbol), name: String(q.name || q.symbol), price, pct: num(String(q.change_pct || "").replace("%", "")) ?? null, prev: num(q.prev_close), high: num(q.high), low: num(q.low), volume: num(q.volume), time: String(q.time || ""), date };
}
/** Tencent raw quotes: `v_<symbol>="…"`, fields split by ~ (stocks, indices, FX) or , (metals and oil). */
export function parseQt(raw: string): Quote[] {
  const out: Quote[] = [];
  for (const m of raw.matchAll(/v_([\w.]+)="([^"]*)"/g)) {
    const sym = m[1], body = m[2];
    if (!body || sym === "pv_none_match") continue;
    let q: Quote | null = null;
    if (sym.startsWith("hf_")) {
      const f = body.split(",");
      const price = num(f[0]), date = dateOf(f[12]);
      if (price !== undefined && price > 0 && date) q = { symbol: sym, name: f[13] || sym, price, pct: num(f[1]) ?? null, prev: num(f[7]), high: num(f[4]), low: num(f[5]), time: f[6], date };
    } else if (sym.startsWith("wh")) {
      const f = body.split("~");
      const price = num(f[3]), date = dateOf(f[f.length - 1]);
      if (price !== undefined && price > 0 && date) q = { symbol: sym, name: f[1] || sym, price, pct: num(f[13]) ?? null, prev: num(f[6]), time: f[5], date };
    } else {
      const f = body.split("~");
      q = quoteFromStock({ symbol: sym, name: f[1], price: f[3], change_pct: f[32], prev_close: f[4], high: f[33], low: f[34], volume: f[6], time: f[30] });
    }
    if (q) out.push(q);
  }
  return out;
}

const marketOf = (symbol: string): "cnhk" | "us" => (/^(sh|sz|bj|hk)/.test(symbol) ? "cnhk" : "us");

/** Splits a hot-list line ("3. 标题（热度）") into rank, title, heat; each source decorates its lines differently. */
export function parseHot(source: string, line: string, at: number): HotItem | null {
  const m = String(line).match(/^\s*(\d+)\.\s+([\s\S]*)$/);
  const rank = m ? Number(m[1]) : at + 1;
  const rest = (m ? m[2] : String(line)).trim();
  if (!rest) return null;
  let title = rest, heat = "", x = "";
  switch (source) {
    case "weibo": case "douyin": case "zhihu": {
      const t = rest.match(/^([\s\S]*)（([^（）]*)）$/);
      if (t) { title = t[1].trim(); heat = t[2].trim(); }
      break;
    }
    case "bilibili": {
      const t = rest.match(/^([\s\S]*?) — ([^，]*)，播放 (\d+)，(BV\w+)\s*$/);
      if (t) { title = t[1].trim(); heat = "播放 " + t[3]; x = t[2] + " " + t[4]; }
      break;
    }
    case "github": {
      const t = rest.match(/^(\S+)(?: \[([^\]]*)\])?(?: 今日\+([\d,]+))?(?: — ([\s\S]*))?$/);
      if (t) { title = t[1]; heat = t[3] ? "今日+" + t[3] : ""; x = [t[2], t[4]].filter(Boolean).join(" ").slice(0, 160); }
      break;
    }
    case "hackernews": {
      const t = rest.match(/^([\s\S]*?)（([^（）]*)）\s*([\s\S]*)$/);
      if (t && /分/.test(t[2])) { title = t[1].trim(); heat = t[2].split("，")[0].trim(); x = t[3].trim(); }
      break;
    }
  }
  title = title.trim();
  return title ? { rank, title, heat, ...(x ? { x } : {}) } : null;
}

// ---------- storage ----------
const schema = `
CREATE TABLE IF NOT EXISTS datapoint(day TEXT, symbol TEXT, name TEXT, close REAL, change_pct REAL, extra TEXT, PRIMARY KEY(day, symbol));
CREATE TABLE IF NOT EXISTS hotitem(day TEXT, source TEXT, rank INTEGER, title TEXT, heat TEXT, PRIMARY KEY(day, source, rank));
`;
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
const addDays = (day: string, n: number) => new Date(Date.parse(day + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);

export function saveQuotes(hub: Hub, quotes: Quote[]) {
  for (const q of quotes)
    hub.sql.exec("INSERT INTO datapoint(day,symbol,name,close,change_pct,extra) VALUES(?,?,?,?,?,?) ON CONFLICT(day,symbol) DO UPDATE SET name=excluded.name, close=excluded.close, change_pct=excluded.change_pct, extra=excluded.extra",
      q.date, q.symbol, q.name, q.price, q.pct, JSON.stringify({ prev: q.prev, high: q.high, low: q.low, vol: q.volume, time: q.time }));
}
/** The later snapshot of a day replaces the earlier one for that source; an empty list never wipes a day. */
export function saveHot(hub: Hub, day: string, source: string, items: HotItem[]) {
  const top = items.slice(0, HOT_TOP);
  if (!top.length) return 0;
  hub.sql.exec("DELETE FROM hotitem WHERE day=? AND source=?", day, source);
  const seen = new Set<number>();
  for (const it of top) {
    let rank = it.rank; while (seen.has(rank)) rank++;
    seen.add(rank);
    hub.sql.exec("INSERT INTO hotitem(day,source,rank,title,heat) VALUES(?,?,?,?,?)", day, source, rank, it.title.slice(0, 300), it.heat.slice(0, 60));
  }
  return top.length;
}
export function retain(hub: Hub, now: number) {
  const today = fmtDate(now, BJ);
  hub.sql.exec("DELETE FROM datapoint WHERE day < ?", addDays(today, -QUOTE_KEEP_DAYS));
  hub.sql.exec("DELETE FROM hotitem WHERE day < ?", addDays(today, -HOT_KEEP_DAYS));
}

// ---------- state ----------
type State = { quotes?: any; hot?: any; fails: { ts: number; what: string; error: string }[]; r2_bytes: number; r2_writes: number };
const readState = (hub: Hub): State => { try { return { fails: [], r2_bytes: 0, r2_writes: 0, ...JSON.parse(hub.get("data:state") || "{}") }; } catch { return { fails: [], r2_bytes: 0, r2_writes: 0 }; } };
const writeState = (hub: Hub, s: State) => hub.set("data:state", JSON.stringify({ ...s, fails: s.fails.slice(-20) }));

async function putR2(hub: Hub, key: string, obj: any): Promise<boolean> {
  const bucket = hub.env.FILES;
  if (!bucket) return false;
  const body = JSON.stringify(obj), s = readState(hub);
  if (s.r2_bytes + body.length > R2_SELF_CAP || !hub.plan.take("r2_writes", 1)) return false;
  await bucket.put(key, body);
  const now = readState(hub);
  now.r2_bytes += body.length; now.r2_writes++;
  writeState(hub, now);
  return true;
}

// ---------- watchlist ----------
const watchKey = (hub: Hub, conv: string) => "data:watchlist:" + (hub.shadow(conv) || conv);
export function getWatchlist(hub: Hub, conv: string): string[] {
  const raw = hub.get(watchKey(hub, conv));
  if (raw) { try { const l = JSON.parse(raw); if (Array.isArray(l)) return l.map(String); } catch {} }
  const main = hub.get("main");
  return !main || conv === main || hub.shadow(conv) === main ? [...DEFAULT_WATCHLIST] : [];
}
const setWatchlist = (hub: Hub, conv: string, l: string[]) => hub.set(watchKey(hub, conv), JSON.stringify(l));
const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, "");

type ToolLike = { name: string; run(args: any): Promise<any> };
const toolOf = (hub: Hub, conv: string, name: string): ToolLike => {
  const t = (hub.tools(conv) as ToolLike[]).find(x => x.name === name);
  if (!t) throw new Error("找不到 " + name + " 工具");
  return t;
};

/** Pool of `n` workers; never rejects, one result per item. */
async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<({ ok: true; v: R } | { ok: false; e: string })[]> {
  const out: any[] = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const at = i++; try { out[at] = { ok: true, v: await fn(items[at]) }; } catch (e: any) { out[at] = { ok: false, e: String(e?.message || e) }; } }
  }));
  return out;
}

/** Resolves watchlist entries to quotes: known aliases straight from Tencent, everything else through `stock`. */
export async function fetchQuotes(hub: Hub, conv: string, entries: string[], scope: "cnhk" | "us" | "all") {
  const quotes: Quote[] = [], failed: { entry: string; error: string }[] = [];
  const direct: { entry: string; code: string; name: string }[] = [], viaStock: string[] = [];
  for (const e of entries) {
    const a = ALIAS[normName(e)];
    if (a) { if (scope === "all" || marketOf(a.code) === scope) direct.push({ entry: e, ...a }); }
    else {
      const cached = hub.get("data:mk:" + normName(e));
      if (scope === "all" || !cached || cached === scope) viaStock.push(e);
    }
  }
  if (direct.length) {
    try {
      const got = new Map(parseQt(await NET.text("https://qt.gtimg.cn/q=" + [...new Set(direct.map(d => d.code))].join(","), "gbk")).map(q => [q.symbol, q]));
      for (const d of direct) { const q = got.get(d.code); if (q) quotes.push({ ...q, name: d.name }); else failed.push({ entry: d.entry, error: "行情源没返回" }); }
    } catch (e: any) { for (const d of direct) failed.push({ entry: d.entry, error: String(e?.message || e) }); }
  }
  if (viaStock.length) {
    const stock = toolOf(hub, conv, "stock");
    const res = await pool(viaStock, 3, async e => ((await stock.run({ query: e }))?.quotes || []) as any[]);
    res.forEach((r, i) => {
      const qs = r.ok ? (r.v.map(quoteFromStock).filter(Boolean) as Quote[]) : [];
      if (!qs.length) { failed.push({ entry: viaStock[i], error: r.ok ? "没有可用的报价" : r.e }); return; }
      hub.set("data:mk:" + normName(viaStock[i]), marketOf(qs[0].symbol));
      for (const q of qs) if (scope === "all" || marketOf(q.symbol) === scope) quotes.push(q);
    });
  }
  return { quotes, failed };
}

export async function snapshotQuotes(hub: Hub, conv: string, now: number, scope: "cnhk" | "us" | "all", slotId = "manual") {
  const { quotes, failed } = await fetchQuotes(hub, conv, getWatchlist(hub, conv), scope);
  const fails: State["fails"] = failed.map(f => ({ ts: now, what: "行情 " + f.entry, error: f.error }));
  if (quotes.length) {
    saveQuotes(hub, quotes);
    const key = "data/quotes/" + fmtDate(now, BJ) + (scope === "us" ? "-us" : scope === "all" ? "-now" : "") + ".json";
    await putR2(hub, key, { slot: slotId, ts: now, quotes: quotes.map(q => ({ s: q.symbol, n: q.name, d: q.date, c: q.price, p: q.pct, pc: q.prev, h: q.high, l: q.low, v: q.volume, t: q.time })) })
      .catch(e => { fails.push({ ts: now, what: "R2 行情", error: String(e?.message || e) }); });
  }
  retain(hub, now);
  const st = readState(hub);
  st.fails.push(...fails);
  st.quotes = { ts: now, slot: slotId, saved: quotes.length, failed: failed.map(f => f.entry), days: [...new Set(quotes.map(q => q.date))].sort() };
  writeState(hub, st);
  return { saved: quotes.length, days: st.quotes.days as string[], failed };
}

export async function snapshotHot(hub: Hub, conv: string, now: number, hourTag?: string) {
  const day = fmtDate(now, BJ), hh = hourTag || new Date(now + 8 * 3600000).toISOString().slice(11, 13);
  const hot = toolOf(hub, conv, "hot");
  const res = await pool(HOT_SOURCES, 3, async source => {
    const list: string[] = (await hot.run({ source }))?.list || [];
    const items = list.map((l, i) => parseHot(source, l, i)).filter(Boolean) as HotItem[];
    if (!items.length) throw new Error("榜单是空的");
    return items;
  });
  const ok: { source: string; n: number }[] = [], failed: { source: string; error: string }[] = [], fails: State["fails"] = [];
  for (let i = 0; i < HOT_SOURCES.length; i++) {
    const source = HOT_SOURCES[i], r = res[i];
    if (!r.ok) { failed.push({ source, error: r.e }); fails.push({ ts: now, what: "热榜 " + source, error: r.e }); continue; }
    const items = r.v.slice(0, HOT_TOP);
    ok.push({ source, n: saveHot(hub, day, source, items) });
    await putR2(hub, "data/hot/" + source + "/" + day + "-" + hh + ".json", { ts: now, items: items.map(it => ({ r: it.rank, t: it.title, h: it.heat, ...(it.x ? { x: it.x } : {}) })) })
      .catch(e => fails.push({ ts: now, what: "R2 热榜 " + source, error: String(e?.message || e) }));
  }
  retain(hub, now);
  const st = readState(hub);
  st.fails.push(...fails);
  st.hot = { ts: now, hour: hh, ok, failed };
  writeState(hub, st);
  return { ok, failed };
}

/** Deletes R2 snapshots past retention; once a day. */
export async function pruneR2(hub: Hub, now: number) {
  const bucket = hub.env.FILES;
  if (!bucket) return 0;
  const today = fmtDate(now, BJ);
  let removed = 0, freed = 0;
  for (const [prefix, keep] of [["data/quotes/", QUOTE_KEEP_DAYS], ["data/hot/", HOT_KEEP_DAYS]] as [string, number][]) {
    const cutoff = addDays(today, -keep);
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      if (!hub.plan.take("r2_reads", 1)) return removed;
      const l = await bucket.list({ prefix, cursor, limit: 1000 });
      const old = (l.objects || []).filter((o: any) => { const d = dateOf(String(o.key).slice(prefix.length).replace(/^[^/]*\//, "")); return d && d < cutoff; });
      if (old.length) { await bucket.delete(old.map((o: any) => o.key)); removed += old.length; freed += old.reduce((a: number, o: any) => a + (o.size || 0), 0); }
      if (!l.truncated) break;
      cursor = l.cursor;
    }
  }
  if (freed) { const s = readState(hub); s.r2_bytes = Math.max(0, s.r2_bytes - freed); writeState(hub, s); }
  return removed;
}

// ---------- history queries ----------
type Pt = { day: string; close: number; pct: number | null };
const r2 = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

/** Period facts for one series (oldest first). */
export function factsOf(pts: Pt[]) {
  if (!pts.length) return null;
  const moves = pts.map((p, i) => ({ date: p.day, pct: p.pct ?? (i ? (p.close / pts[i - 1].close - 1) * 100 : NaN) })).filter(m => Number.isFinite(m.pct));
  const first = pts[0], last = pts[pts.length - 1];
  const hi = pts.reduce((a, p) => (p.close > a.close ? p : a)), lo = pts.reduce((a, p) => (p.close < a.close ? p : a));
  const up = [...moves].sort((a, b) => b.pct - a.pct).filter(m => m.pct > 0).slice(0, 3), down = [...moves].sort((a, b) => a.pct - b.pct).filter(m => m.pct < 0).slice(0, 3);
  return {
    points: pts.length,
    first: { date: first.day, close: first.close }, last: { date: last.day, close: last.close },
    change_pct: first.close ? r2((last.close / first.close - 1) * 100) : null,
    high: { date: hi.day, close: hi.close }, low: { date: lo.day, close: lo.close },
    from_high_pct: hi.close ? r2((last.close / hi.close - 1) * 100) : null,
    up_days: moves.filter(m => m.pct > 0).length, down_days: moves.filter(m => m.pct < 0).length,
    biggest_up: up.map(m => ({ date: m.date, pct: r2(m.pct) })), biggest_down: down.map(m => ({ date: m.date, pct: r2(m.pct) })),
  };
}

/** Maps what the user typed (name, code, alias) to symbols present in the history. */
export function findSymbols(hub: Hub, query: string): { symbol: string; name: string }[] {
  const all = rows(hub, "SELECT symbol, MAX(name) name, MAX(day) last FROM datapoint GROUP BY symbol ORDER BY last DESC") as { symbol: string; name: string }[];
  const q = normName(query);
  if (!q) return [];
  const a = ALIAS[q];
  if (a) return all.filter(r => r.symbol === a.code);
  const lc = (s: string) => String(s).toLowerCase();
  const exact = all.filter(r => lc(r.symbol) === q || normName(r.name) === q);
  if (exact.length) return exact;
  const suffix = all.filter(r => lc(r.symbol).replace(/^(us|hk|sh|sz|bj)/, "") === q);
  if (suffix.length) return suffix;
  return all.filter(r => normName(r.name).includes(q)).slice(0, 3);
}

const historyStart = (hub: Hub, table: "datapoint" | "hotitem") => rows(hub, `SELECT MIN(day) d FROM ${table}`)[0]?.d || null;

export function quotesHistory(hub: Hub, symbols: string[], days: number, now: number) {
  days = Math.min(Math.max(Math.floor(days) || 30, 1), 400);
  const since = addDays(fmtDate(now, BJ), -days), out: any[] = [], missing: string[] = [];
  for (const query of symbols.slice(0, 8)) {
    const hits = findSymbols(hub, query);
    if (!hits.length) { missing.push(query); continue; }
    for (const h of hits.slice(0, 2)) {
      const pts = rows(hub, "SELECT day, close, change_pct pct FROM datapoint WHERE symbol=? AND day>=? ORDER BY day", h.symbol, since).map(r => ({ day: String(r.day), close: Number(r.close), pct: r.pct === null ? null : Number(r.pct) }));
      if (!pts.length) { missing.push(query); continue; }
      const step = Math.ceil(pts.length / 60), shown = step > 1 ? pts.filter((_, i) => i % step === 0 || i === pts.length - 1) : pts;
      out.push({ symbol: h.symbol, name: h.name, facts: factsOf(pts), series: shown.map(p => [p.day, p.close, p.pct === null ? null : r2(p.pct)]), ...(step > 1 ? { series_note: "点太多，每 " + step + " 天取一个，统计用的是全部数据" } : {}) });
    }
  }
  const start = historyStart(hub, "datapoint");
  return {
    ok: out.length > 0, history_starts: start, days_asked: days,
    ...(out.length ? {} : { error: start ? "没找到这些标的的历史：" + missing.join("、") + "。观察清单里有的才会存" : "还没有存过行情，历史要从开始记录那天起才有。可以先用 snapshot_now 存一次" }),
    ...(missing.length && out.length ? { not_found: missing } : {}),
    series_format: "[日期, 收盘, 当日涨跌%]", symbols: out,
  };
}

const keyTitle = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
function streaks(days: string[]) {
  const s = [...new Set(days)].sort();
  let best = 0, run = 0;
  s.forEach((d, i) => { run = i && addDays(s[i - 1], 1) === d ? run + 1 : 1; best = Math.max(best, run); });
  return { days: s.length, streak: best, first: s[0], last: s[s.length - 1] };
}
type HotRow = { day: string; source: string; rank: number; title: string; heat: string };
export function topics(rs: HotRow[]) {
  const by = new Map<string, HotRow[]>();
  for (const r of rs) { const k = r.source + "\u0000" + keyTitle(r.title); const g = by.get(k); if (g) g.push(r); else by.set(k, [r]); }
  return [...by.values()].map(g => ({ source: g[0].source, title: g[0].title, best_rank: Math.min(...g.map(r => r.rank)), ...streaks(g.map(r => r.day)), rows: g }));
}

export function hotHistory(hub: Hub, source: string | undefined, days: number, keyword: string | undefined, now: number) {
  days = Math.min(Math.max(Math.floor(days) || 7, 1), 60);
  const since = addDays(fmtDate(now, BJ), -days);
  if (source && !HOT_SOURCES.includes(source)) return { ok: false, error: "source 只能是 " + HOT_SOURCES.join("/") };
  const srcs = source ? [source] : HOT_SOURCES;
  const all = rows(hub, "SELECT day, source, rank, title, heat FROM hotitem WHERE day>=? AND source IN (" + srcs.map(() => "?").join(",") + ") ORDER BY day, source, rank", since, ...srcs) as HotRow[];
  const start = historyStart(hub, "hotitem");
  if (!all.length) return { ok: false, history_starts: start, error: start ? "这段时间没有存热榜（最早的记录是 " + start + "）" : "还没有存过热榜，历史要从开始记录那天起才有。可以先用 snapshot_now 存一次" };
  const kw = keyword ? keyword.toLowerCase().trim() : "";
  if (kw) {
    const hits = topics(all.filter(r => r.title.toLowerCase().includes(kw)));
    hits.sort((a, b) => b.days - a.days || a.best_rank - b.best_rank);
    return {
      ok: true, history_starts: start, keyword, days_asked: days, matches: hits.length,
      topics: hits.slice(0, 12).map(h => ({ source: h.source, title: h.title, days_on_list: h.days, longest_streak_days: h.streak, first: h.first, last: h.last, best_rank: h.best_rank, appearances: h.rows.slice(-10).map(r => r.day.slice(5) + " 第" + r.rank + "名" + (r.heat ? "（" + r.heat + "）" : "")) })),
      ...(hits.length ? {} : { note: "这段时间的榜单里没出现过这个词" }),
    };
  }
  const single = srcs.length === 1, out: any = {};
  for (const s of srcs) {
    const rs = all.filter(r => r.source === s);
    if (!rs.length) continue;
    const lasting = topics(rs).filter(t => t.days >= 2).sort((a, b) => b.streak - a.streak || b.days - a.days || a.best_rank - b.best_rank).slice(0, single ? 15 : 6);
    const dayList = [...new Set(rs.map(r => r.day))].sort();
    out[s] = {
      days_with_data: dayList.length, from: dayList[0], to: dayList[dayList.length - 1],
      stayed_longest: lasting.map(t => ({ title: t.title, days_on_list: t.days, longest_streak_days: t.streak, best_rank: t.best_rank, first: t.first, last: t.last })),
      daily_top: dayList.slice(-(single ? 14 : 7)).map(d => ({ date: d, top: rs.filter(r => r.day === d).slice(0, single ? 8 : 3).map(r => r.rank + ". " + r.title + (r.heat ? "（" + r.heat + "）" : "")) })),
    };
  }
  return { ok: true, history_starts: start, days_asked: days, sources: out };
}

/** Week-over-week facts for a daily digest: watched quotes against 7 and 30 days ago, and topics new on the lists this week. */
export function digest(hub: Hub, now: number) {
  const today = fmtDate(now, BJ), out: any = { ok: true, quotes: [], hot_new_this_week: {} };
  const at = (symbol: string, day: string) => rows(hub, "SELECT day, close FROM datapoint WHERE symbol=? AND day<=? ORDER BY day DESC LIMIT 1", symbol, day)[0] as { day: string; close: number } | undefined;
  for (const s of rows(hub, "SELECT symbol, MAX(name) name FROM datapoint WHERE day>=? GROUP BY symbol ORDER BY symbol", addDays(today, -4))) {
    const cur = at(s.symbol, today), w = at(s.symbol, addDays(today, -7)), m = at(s.symbol, addDays(today, -30));
    if (!cur) continue;
    out.quotes.push({ name: s.name, date: cur.day, close: cur.close, vs_week_ago_pct: w && w.day !== cur.day ? r2((cur.close / w.close - 1) * 100) : null, vs_month_ago_pct: m && m.day !== cur.day ? r2((cur.close / m.close - 1) * 100) : null });
  }
  for (const src of ["weibo", "baidu", "zhihu", "douyin"]) {
    const thisWeek = rows(hub, "SELECT title, MIN(rank) r, COUNT(DISTINCT day) d FROM hotitem WHERE source=? AND day>? GROUP BY title", src, addDays(today, -7));
    const before = new Set(rows(hub, "SELECT DISTINCT title FROM hotitem WHERE source=? AND day<=? AND day>?", src, addDays(today, -7), addDays(today, -14)).map(r => keyTitle(String(r.title))));
    const fresh = thisWeek.filter(t => !before.has(keyTitle(String(t.title)))).sort((a, b) => b.d - a.d || a.r - b.r).slice(0, 5);
    if (fresh.length) out.hot_new_this_week[src] = fresh.map(t => t.title + "（上榜 " + t.d + " 天，最高第 " + t.r + "）");
  }
  out.history_starts = { quotes: historyStart(hub, "datapoint"), hot: historyStart(hub, "hotitem") };
  return out;
}

// ---------- CSV ----------
const csvCell = (v: any) => { const s = v === null || v === undefined ? "" : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
const csv = (head: string[], body: any[][]) => [head, ...body].map(r => r.map(csvCell).join(",")).join("\n") + "\n";

export function exportCsv(hub: Hub, kind: string, days: number, filter: string[] | undefined, now: number) {
  if (kind === "hot") {
    days = Math.min(Math.max(Math.floor(days) || 30, 1), 180);
    const since = addDays(fmtDate(now, BJ), -days), srcs = (filter || []).filter(s => HOT_SOURCES.includes(s));
    const rs = rows(hub, "SELECT day, source, rank, title, heat FROM hotitem WHERE day>=?" + (srcs.length ? " AND source IN (" + srcs.map(() => "?").join(",") + ")" : "") + " ORDER BY day, source, rank", since, ...srcs);
    return { name: "hot_" + fmtDate(now, BJ) + ".csv", rows: rs.length, columns: ["date", "source", "rank", "title", "heat"], text: csv(["date", "source", "rank", "title", "heat"], rs.map(r => [r.day, r.source, r.rank, r.title, r.heat])) };
  }
  days = Math.min(Math.max(Math.floor(days) || 90, 1), 730);
  const since = addDays(fmtDate(now, BJ), -days);
  const syms = (filter || []).flatMap(q => findSymbols(hub, q).map(h => h.symbol));
  const rs = rows(hub, "SELECT day, symbol, name, close, change_pct FROM datapoint WHERE day>=?" + (filter?.length ? " AND symbol IN (" + (syms.length ? syms.map(() => "?").join(",") : "NULL") + ")" : "") + " ORDER BY symbol, day", since, ...syms);
  return { name: "quotes_" + fmtDate(now, BJ) + ".csv", rows: rs.length, columns: ["date", "symbol", "name", "close", "change_pct"], text: csv(["date", "symbol", "name", "close", "change_pct"], rs.map(r => [r.day, r.symbol, r.name, r.close, r.change_pct === null ? "" : r2(Number(r.change_pct))])) };
}

// ---------- tick ----------
const running = new Set<string>();
async function runSlot(hub: Hub, conv: string, slot: Slot, day: string, now: number) {
  const key = slot.id + day;
  if (running.has(key)) return;
  running.add(key);
  try {
    let good = 0;
    try {
      if (slot.kind === "quotes") good = (await snapshotQuotes(hub, conv, now, slot.scope, slot.id)).saved;
      else good = (await snapshotHot(hub, conv, now, slot.at.slice(0, 2))).ok.length;
    } catch (e: any) { const s = readState(hub); s.fails.push({ ts: now, what: slot.id, error: String(e?.message || e) }); writeState(hub, s); }
    const tries = Number((hub.get(markKey(slot.id, day)) || "").match(/^r(\d+)/)?.[1] || 1);
    // Nothing saved at all (network down): try again up to three times, 15 minutes apart.
    hub.set(markKey(slot.id, day), good || tries >= 3 ? "1" : "r" + tries + ":" + (now + 15 * 60000));
  } finally { running.delete(key); }
}

async function tick(hub: Hub, now: number) {
  const main = hub.get("main");
  if (!main) return;
  const day = fmtDate(now, BJ);
  for (const { slot, day: d } of dueSlots(now, (id, dd) => isMarked(hub, id, dd, now))) {
    const prev = hub.get(markKey(slot.id, d)) || "";
    hub.set(markKey(slot.id, d), "r" + (Number(prev.match(/^r(\d+)/)?.[1] || 0) + 1) + ":" + (now + 15 * 60000));   // claimed before the work starts
    hub.ctx.waitUntil(runSlot(hub, main, slot, d, now).catch(e => console.log("data slot failed", slot.id, e?.message)));
  }
  if (hub.get("data:prune:day") !== day) {
    hub.set("data:prune:day", day);
    hub.sql.exec("DELETE FROM kv WHERE k LIKE 'data:mark:%' AND substr(k,-10) < ?", addDays(day, -5));
    hub.ctx.waitUntil((async () => { retain(hub, now); await pruneR2(hub, now); })().catch(e => console.log("data prune failed", e?.message)));
  }
}

// ---------- tool and admin ----------
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

export function overview(hub: Hub) {
  const q = rows(hub, "SELECT COUNT(DISTINCT day) days, COUNT(DISTINCT symbol) symbols, MIN(day) first, MAX(day) last FROM datapoint")[0];
  const s = readState(hub), iso = (o: any) => (o ? { ...o, at: new Date(o.ts).toISOString() } : null);
  return {
    ok: true,
    quotes: { ...q, per_symbol: rows(hub, "SELECT symbol, MAX(name) name, COUNT(*) days, MIN(day) first, MAX(day) last FROM datapoint GROUP BY symbol ORDER BY symbol") },
    hot: { sources: rows(hub, "SELECT source, COUNT(DISTINCT day) days, MIN(day) first, MAX(day) last, COUNT(*) items FROM hotitem GROUP BY source"), total_days: rows(hub, "SELECT COUNT(DISTINCT day) n FROM hotitem")[0]?.n || 0 },
    last_snapshots: { quotes: iso(s.quotes), hot: iso(s.hot) },
    recent_failures: s.fails.slice(-10).map(f => ({ ...f, at: new Date(f.ts).toISOString() })),
    r2: { bytes_written_tracked: s.r2_bytes, writes: s.r2_writes },
    slots: SLOTS.map(x => x.id + " " + x.at + " 北京时间"),
  };
}

const feature: Feature = {
  name: "data",
  schema,
  tick,
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/data") return null;
    if (req.method === "GET") return json(overview(hub));
    if (req.method !== "POST") return json({ ok: false, error: "GET 或 POST" }, 405);
    const conv = String(body?.conv || hub.get("main") || "");
    if (!conv) return json({ ok: false, error: "还没有主群" }, 400);
    const now = Date.now();
    try {
      if (body?.snapshot === "quotes") return json({ ok: true, ...(await snapshotQuotes(hub, conv, now, "all")) });
      if (body?.snapshot === "hot") { const r = await snapshotHot(hub, conv, now); return json({ ok: true, saved: r.ok, failed: r.failed }); }
    } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
    return json({ ok: false, error: '用 {"snapshot":"quotes"} 或 {"snapshot":"hot"} 立即存一次' }, 400);
  },
  tools: ({ hub, conv, host }) => [{
    name: "data",
    slow: true,
    description: "Bot 自己攒下的历史数据：每天存两次行情（观察清单里的指数、美股、A 股、港股、汇率、黄金原油）和热榜（微博、抖音、B站、知乎、百度、GitHub、Hacker News）。" +
      "查实时价格还是用 stock，查当前热榜还是用 hot；这个工具查的是走势、涨跌、哪些话题上过榜上了几天，以及给 run_python 画图准备数据。历史只从开始记录那天起才有，问得比这更早就如实说没有。" +
      "op：quotes_history（symbols 给名字或代码如 [\"纳斯达克指数\",\"英伟达\"]，days 最多 400；返回每个标的的收盘序列和统计：区间涨跌、最高最低及日期、涨跌最大的几天）；" +
      "hot_history（source 不给就是全部榜，days 最多 60，keyword 可选；返回每天榜首、上榜最久的话题、关键词出现过的日期和名次）；" +
      "digest（给每日新闻加料：观察清单相对一周前、一个月前的涨跌，和这周新上榜的话题）；" +
      "watchlist（action 为 show 看清单，add 或 remove 加减 names；加之前会先查得到行情）；" +
      "export（kind 为 quotes 或 hot，days，可选 symbols/source 过滤；生成 CSV 并返回文件编号如 f12，再给 run_python 的 files 传 [\"f12\"] 画图）；" +
      "snapshot_now（现在就存一次行情和热榜，历史是空的时用）。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["quotes_history", "hot_history", "digest", "watchlist", "export", "snapshot_now"] },
        symbols: { type: "array", items: { type: "string" }, description: "quotes_history / export：标的名字或代码，最多 8 个" },
        days: { type: "number", description: "往回看多少天；行情最多 400，热榜最多 60" },
        source: { type: "string", enum: HOT_SOURCES, description: "hot_history / export(hot)：哪个榜，不给就是全部" },
        keyword: { type: "string", description: "hot_history：只看标题里带这个词的话题" },
        action: { type: "string", enum: ["show", "add", "remove"], description: "watchlist 用，默认 show" },
        names: { type: "array", items: { type: "string" }, description: "watchlist add / remove 的名字或代码" },
        kind: { type: "string", enum: ["quotes", "hot"], description: "export 用" },
      },
      required: ["op"],
    },
    async run(a: any) {
      const now = host.now();
      switch (a.op) {
        case "quotes_history": {
          const syms = (Array.isArray(a.symbols) ? a.symbols : a.symbols ? [a.symbols] : []).map(String).filter(Boolean);
          if (!syms.length) return { ok: false, error: "要给 symbols，比如 [\"纳斯达克指数\"]" };
          return quotesHistory(hub, syms, Number(a.days) || 30, now);
        }
        case "hot_history": return hotHistory(hub, a.source ? String(a.source) : undefined, Number(a.days) || 7, a.keyword ? String(a.keyword) : undefined, now);
        case "digest": return digest(hub, now);
        case "watchlist": {
          const list = getWatchlist(hub, conv), action = String(a.action || "show");
          const names = (Array.isArray(a.names) ? a.names : a.names ? [a.names] : []).map((x: any) => String(x).trim()).filter(Boolean);
          if (action === "show") return { ok: true, watchlist: list, note: "每天存两次这些标的的收盘；美元兑人民币、黄金、原油是专门接的行情源" };
          if (!names.length) return { ok: false, error: "要给 names" };
          if (action === "remove") {
            const gone: string[] = [], keep = list.filter(e => { const hit = names.some((n: string) => normName(e) === normName(n)); if (hit) gone.push(e); return !hit; });
            if (!gone.length) return { ok: false, error: "清单里没有 " + names.join("、"), watchlist: list };
            setWatchlist(hub, conv, keep);
            return { ok: true, removed: gone, watchlist: keep, note: "已存的历史不会删" };
          }
          if (action !== "add") return { ok: false, error: "action 只能是 show / add / remove" };
          const added: any[] = [], rejected: any[] = [], next = [...list];
          for (const n of names) {
            if (next.some(e => normName(e) === normName(n))) { rejected.push({ name: n, why: "已经在清单里" }); continue; }
            if (next.length >= WATCH_MAX) { rejected.push({ name: n, why: "清单最多 " + WATCH_MAX + " 个" }); continue; }
            const { quotes, failed } = await fetchQuotes(hub, conv, [n], "all");
            if (!quotes.length) { rejected.push({ name: n, why: failed[0]?.error || "查不到行情，换个名字或直接给代码" }); continue; }
            next.push(n); added.push({ name: n, resolved_to: quotes[0].name + "（" + quotes[0].symbol + "），最新 " + quotes[0].price });
          }
          if (added.length) setWatchlist(hub, conv, next);
          return { ok: added.length > 0, added, rejected, watchlist: next, note: "resolved_to 是实际查到的标的，和用户想要的不一样就把它删掉重新加" };
        }
        case "export": {
          const kind = a.kind === "hot" ? "hot" : "quotes";
          const filter = kind === "hot" ? (a.source ? [String(a.source)] : undefined) : Array.isArray(a.symbols) && a.symbols.length ? a.symbols.map(String) : undefined;
          const r = exportCsv(hub, kind, Number(a.days) || (kind === "hot" ? 30 : 90), filter, now);
          if (!r.rows) return { ok: false, error: "这段时间没有数据，历史要从开始记录那天起才有；可以先用 snapshot_now" };
          const id = await host.keepFile(r.name, new TextEncoder().encode(r.text));
          return { ok: true, file: id, name: r.name, rows: r.rows, columns: r.columns, how_to_use: "run_python 的 files 传 [\"" + id + "\"]，用 pandas.read_csv 读；图里有中文要用 Noto CJK 字体" };
        }
        case "snapshot_now": {
          if (!(await host.quota("data_snapshot", 6))) return { ok: false, error: "今天手动存的次数用完了" };
          const q = await snapshotQuotes(hub, conv, now, "all").catch((e: any) => ({ saved: 0, days: [] as string[], failed: [{ entry: "全部", error: String(e?.message || e) }] }));
          const h = await snapshotHot(hub, conv, now).catch((e: any) => ({ ok: [] as any[], failed: [{ source: "全部", error: String(e?.message || e) }] }));
          return { ok: q.saved > 0 || h.ok.length > 0, quotes_saved: q.saved, quote_days: q.days, quotes_failed: q.failed, hot_saved: h.ok, hot_failed: h.failed, note: "手动存的行情可能是盘中价，到点的定时快照会换成收盘价" };
        }
      }
      return { ok: false, error: "op 只能是 quotes_history / hot_history / digest / watchlist / export / snapshot_now" };
    },
  }],
  about: [
    "Bot 自己攒了一份小数据仓库：每天存两次行情快照，A 股和港股在北京时间 16:30 以后存当天收盘，美股、汇率、黄金原油在 06:10 以后存前一晚的收盘。",
    "行情观察清单默认有上证、深证、创业板、恒生、恒生科技、纳指、标普、道指，英伟达、特斯拉、苹果、腾讯、阿里、茅台，以及美元兑人民币、黄金、原油，群里可以让 Bot 加减。",
    "热榜每天北京时间 09:00 和 21:00 各存一次，包括微博、抖音、B站、知乎、百度、GitHub Trending 和 Hacker News，每个榜留前 30 名，同一天后一次会覆盖前一次。",
    "这些历史只从开始记录那天起才有，更早的 Bot 不知道；行情留两年，热榜留 180 天。完整快照放在 R2，查走势用的精简表放在 Hub 的数据库里。",
    "能回答“这个月纳指怎么走的”“上周热搜都有啥”，也能导出 CSV 交给 Python 画走势图，或者给每日新闻补上和上周相比的变化。",
  ],
};
export default feature;
