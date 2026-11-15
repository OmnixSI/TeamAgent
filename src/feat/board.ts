// The team board at /x/board: one page where a group member sees what the group and its bot have going
// (day summaries, tasks, memory, repository checks, pictures and files, monitors, plan usage, tools).
// Visitors are people with a personal link (access.ts); everything shown is limited to their conversation.
// The page is static and the same for everyone; its content comes from the JSON API under /x/board/api/.
// Page source lives in board-page.ts.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { personOf, clearCookie, cookieToken, bearerToken, bases, listAccess } from "./access.ts";
import type { Person } from "./access.ts";
import * as T from "./tasks.ts";
import type { Task, TaskStatus } from "./tasks.ts";
import { latestAll, listRepos } from "./repocheck.ts";
import { boxLink, newDrop, human, mimeOf, disposition } from "./filebox.ts";
import { uptimePct } from "./uptime.ts";
import { describeSource } from "./staticsite.ts";
import { PRICE } from "../meter.ts";
import { ABILITIES, exampleParts } from "./toolbox.ts";
import { CSS, APP_JS, PAGE } from "./board-page.ts";
import { dailyAccountsStatus } from "./daily-accounts.ts";
import { BJ, fmtDate } from "../util.ts";
import { teamStats, taskEvents, taskTimeline, pointsOf, span, honorWall, shop, balanceOf, spends, redeem, canSettleSpend, settle } from "./teamwork.ts";

const BASE = "/x/board";
const DAY = 86400000;
const MAX_BODY = 100 * 1024;
const STATUSES: TaskStatus[] = ["open", "doing", "done", "dropped"];

/** The task contract, behind one object so tests can stand in for the real module. */
export const taskApi = {
  listTasks: T.listTasks, getTask: T.getTask, addTask: T.addTask, updateTask: T.updateTask,
  claimTask: T.claimTask, addTaskNote: T.addTaskNote, taskNotes: T.taskNotes,
};

// ---------- static parts ----------
function tag(s: string) {   // cyrb53, as in toolbox.ts: a cache key, not a security measure
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
type Asset = { body: string; type: string; etag: string };
const asset = (body: string, type: string): Asset => ({ body, type, etag: '"' + tag(body) + '"' });
const vurl = (name: string, a: Asset) => BASE + "/" + name + "?v=" + a.etag.slice(1, -1);

function build() {
  const files: Record<string, Asset> = { "app.css": asset(CSS, "text/css; charset=utf-8"), "app.js": asset(APP_JS, "text/javascript; charset=utf-8") };
  files[""] = asset(PAGE(vurl("app.css", files["app.css"]), vurl("app.js", files["app.js"])), "text/html; charset=utf-8");
  return files;
}
let FILES: Record<string, Asset> | null = null;
export const files = () => FILES || (FILES = build());

export const CSP = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "img-src 'self' data:", "connect-src 'self'",
  "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");

const SEC = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
const text = (status: number, body: string, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...SEC, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...extra } });
const json = (v: any, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { ...SEC, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", Vary: "Cookie, Authorization", ...extra } });
const bad = (error: string, status = 400) => json({ ok: false, error }, status);
const NO_PERSON = "这个看板只给群友看。在群里对 Bot 说“给我看板链接”，点它发来的链接就能进来。";
const noPersonPage = () => new Response(`<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><meta name=color-scheme content='light dark'><title>看板</title><body style='font:16px/1.7 system-ui;margin:15vh auto;max-width:28em;padding:0 20px'><p>${NO_PERSON}`,
  { status: 401, headers: { ...SEC, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });

function serveAsset(req: Request, u: URL, name: string, isPage: boolean): Response {
  const a = files()[name];
  if (!a) return text(404, "没有这个页面");
  const headers: Record<string, string> = { ...SEC, ETag: a.etag };
  headers["Cache-Control"] = isPage ? "private, no-cache" : u.searchParams.get("v") === a.etag.slice(1, -1) ? "public, max-age=31536000, immutable" : "public, max-age=300";
  if (isPage) { headers["Content-Security-Policy"] = CSP; headers["Cross-Origin-Opener-Policy"] = "same-origin"; headers["Vary"] = "Cookie"; }
  const inm = req.headers.get("If-None-Match") || "";
  if (inm.split(",").some(t => t.trim().replace(/^W\//, "") === a.etag)) return new Response(null, { status: 304, headers });
  headers["Content-Type"] = a.type;
  return new Response(req.method === "HEAD" ? null : a.body, { headers });
}

// ---------- helpers ----------
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
const safeRows = (hub: Hub, q: string, ...b: any[]) => { try { return rows(hub, q, ...b); } catch { return []; } };   // a feature's table may not exist yet
const num = (v: string | null, def: number, min: number, max: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) && v !== null && v !== "" ? Math.min(max, Math.max(min, n)) : def; };
const str = (v: unknown, max: number) => typeof v === "string" ? v.trim().slice(0, max) : undefined;
const parseJson = (s: unknown) => { try { return s ? JSON.parse(String(s)) : null; } catch { return null; } };

/** A POST the page itself sent: JSON, same site, small. Returns the parsed body or an error response. */
async function readPost(hub: Hub, req: Request, u: URL): Promise<any | Response> {
  const origin = req.headers.get("origin");
  if (origin) {
    let host = "";
    try { host = new URL(origin).host; } catch {}
    const allowed = new Set([u.host, ...bases(hub).map(b => { try { return new URL(b).host; } catch { return ""; } })]);
    if (!host || !allowed.has(host)) return bad("不接受从别的网站发来的修改", 403);
  }
  if (!/^application\/json\b/i.test(req.headers.get("content-type") || "")) return bad("请求格式不对", 415);
  if (Number(req.headers.get("content-length") || 0) > MAX_BODY) return bad("内容太长", 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY) return bad("内容太长", 413);
  if (!raw) return {};
  const body = parseJson(raw);
  return body && typeof body === "object" && !Array.isArray(body) ? body : bad("请求内容不是 JSON 对象");
}

// ---------- reads ----------
function days(hub: Hub, p: Person, u: URL) {
  const n = num(u.searchParams.get("n"), 7, 1, 31), before = u.searchParams.get("before") || "";
  const list = /^\d{4}-\d{2}-\d{2}$/.test(before)
    ? rows(hub, "SELECT date, summary FROM day WHERE conv=? AND date<? ORDER BY date DESC LIMIT ?", p.conv, before, n + 1)
    : rows(hub, "SELECT date, summary FROM day WHERE conv=? ORDER BY date DESC LIMIT ?", p.conv, n + 1);
  return { ok: true, days: list.slice(0, n).map(r => ({ date: String(r.date), summary: String(r.summary || "") })), more: list.length > n };
}

const taskOut = (t: Task) => ({ id: t.id, title: t.title, detail: t.detail, status: t.status, owner: t.owner, due: t.due, source: t.source, by: t.by, claimed_by: t.claimed_by, result: t.result, created: t.created, updated: t.updated,
  size: t.size || "normal", claimed_at: t.claimed_at || 0, done_at: t.done_at || 0, done_by: t.done_by || "", points: part(() => pointsOf(t), 0) });
const mine = (t: Task | null, p: Person) => t && t.conv === p.conv ? t : null;

function tasks(hub: Hub, p: Person, u: URL) {
  const want = (u.searchParams.get("status") || "open,doing").split(",").filter(s => (STATUSES as string[]).includes(s)) as TaskStatus[];
  const n = num(u.searchParams.get("n"), 100, 1, 300);
  const list = taskApi.listTasks(hub, p.conv, { status: want.length ? want : ["open", "doing"], limit: n + 1 }).filter(t => t.conv === p.conv);
  return { ok: true, tasks: list.slice(0, n).map(taskOut), more: list.length > n };
}
function task(hub: Hub, p: Person, id: number) {
  const t = mine(taskApi.getTask(hub, p.conv, id), p);
  return t ? { ok: true, task: taskOut(t), notes: taskApi.taskNotes(hub, p.conv, id), prompt: promptFor(t) } : null;
}
const promptFor = (t: Task) => "用 teamagent 的 claim_task 领取任务 #" + t.id + "，做完用 complete_task 交付";

function memory(hub: Hub, p: Person) {
  return { ok: true, memory: hub.memoryOf(p.conv), notes: rows(hub, "SELECT text, ts FROM note WHERE conv=? ORDER BY id DESC LIMIT 60", p.conv).map(r => ({ text: String(r.text), ts: Number(r.ts) })) };
}

const imgKind = (r: any) => r.name ? (String(r.name).startsWith("sticker:") ? "sticker" : "named") : String(r.src || "").startsWith("chat:") ? "chat" : "made";
function images(hub: Hub, p: Person, u: URL) {
  const n = num(u.searchParams.get("n"), 30, 1, 60), before = num(u.searchParams.get("before"), 0, 0, 2 ** 52) || 2 ** 52;
  const kind = u.searchParams.get("kind") || "";
  const cond = kind === "made" ? " AND name IS NULL AND (src IS NULL OR src NOT LIKE 'chat:%')" : kind === "chat" ? " AND src LIKE 'chat:%'" : kind === "named" ? " AND name IS NOT NULL" : "";
  const list = rows(hub, "SELECT id, ts, mime, note, name, src, made, size FROM img WHERE conv=? AND id<?" + cond + " ORDER BY id DESC LIMIT ?", p.conv, before, n + 1);
  return {
    ok: true, more: list.length > n,
    images: list.slice(0, n).map(r => {
      const made = parseJson(r.made);
      return { id: Number(r.id), ref: "g" + r.id, ts: Number(r.ts), note: String(r.note || ""), kind: imgKind(r), name: r.name ? String(r.name).replace(/^sticker:/, "") : "",
        how: made ? String(made.request || made.idea || made.prompt || "").slice(0, 600) : "", size: Number(r.size || 0), url: BASE + "/img/" + r.id, mime: String(r.mime || "") };
    }),
  };
}
function blobs(hub: Hub, p: Person, u: URL) {
  const n = num(u.searchParams.get("n"), 30, 1, 60), before = num(u.searchParams.get("before"), 0, 0, 2 ** 52) || 2 ** 52;
  const list = rows(hub, "SELECT id, ts, name, src, size FROM blob WHERE conv=? AND id<? ORDER BY id DESC LIMIT ?", p.conv, before, n + 1);
  return { ok: true, more: list.length > n, files: list.slice(0, n).map(r => ({ id: Number(r.id), ref: "f" + r.id, ts: Number(r.ts), name: String(r.name || "file"), received: !!r.src, size: Number(r.size || 0), size_text: human(Number(r.size || 0)), url: BASE + "/file/" + r.id })) };
}
function sites(hub: Hub, p: Person) {
  const deployed = safeRows(hub, 'SELECT name, id, source, at, note FROM deploy WHERE conv=? ORDER BY at DESC LIMIT 100', p.conv);
  const named = new Set(deployed.map(r => String(r.id)));
  const pages = safeRows(hub, "SELECT id, title, updated, files, bytes, views FROM site WHERE conv=? ORDER BY updated DESC LIMIT 100", p.conv).filter(r => !named.has(String(r.id)));
  const src = (s: any) => { try { return describeSource(JSON.parse(String(s))); } catch { return ""; } };
  return {
    ok: true,
    sites: deployed.map(r => ({ name: String(r.name), url: "/p/" + r.id + "/", at: Number(r.at), source: src(r.source), commit: String(r.note || "") })),
    pages: pages.map(r => ({ title: String(r.title || "未命名页面"), url: "/p/" + r.id + "/", at: Number(r.updated), views: Number(r.views || 0) })),
  };
}
function box(hub: Hub, p: Person) {
  const list = safeRows(hub, 'SELECT id, name, size, ts, expires, "by" AS "by", note FROM boxfile WHERE conv=? AND expires>? ORDER BY id DESC LIMIT 60', p.conv, Date.now());
  return { ok: true, files: list.map(r => ({ ref: "x" + r.id, name: String(r.name), size: Number(r.size), size_text: human(Number(r.size)), ts: Number(r.ts), expires: Number(r.expires), by: String(r.by || ""), note: String(r.note || ""), url: BASE + "/box/" + r.id })) };
}
function monitors(hub: Hub, p: Person) {
  const now = Date.now();
  const up = safeRows(hub, "SELECT id, name, url, state, since, last, latency_ms, err, active, created FROM uptime WHERE conv=? ORDER BY id", p.conv).map(r => {
    let pct: number | null = null;
    try { pct = uptimePct(hub, { ...r, id: Number(r.id), created: Number(r.created || 0) } as any, now, 7 * DAY); } catch {}
    return { name: String(r.name || r.url), url: String(r.url), state: String(r.state || ""), since: Number(r.since || 0), last: Number(r.last || 0), ms: r.latency_ms === null ? null : Number(r.latency_ms), error: String(r.err || ""), active: !!r.active, uptime_7d: pct,
      days: uptimeDays(hub, Number(r.id), Number(r.created || 0), now) };
  });
  const feeds = safeRows(hub, "SELECT id, title, url, kind, last, fails, active FROM feed WHERE conv=? ORDER BY id", p.conv).map(r => {
    const it = safeRows(hub, "SELECT title, link, published FROM feeditem WHERE feed=? ORDER BY COALESCE(published, seen) DESC LIMIT 1", r.id)[0];
    return { title: String(r.title || r.url), url: String(r.url), kind: String(r.kind || ""), last: Number(r.last || 0), fails: Number(r.fails || 0), active: !!r.active,
      latest: it ? { title: String(it.title || ""), link: /^https?:\/\//.test(String(it.link || "")) ? String(it.link) : "", at: Number(it.published || 0) } : null };
  });
  const watches = safeRows(hub, "SELECT id, url, what, last, state, active, hits, fails, every_min FROM watch WHERE conv=? ORDER BY id", p.conv).map(r => ({
    url: String(r.url), what: String(r.what || ""), state: String(r.state || ""), last: Number(r.last || 0), active: !!r.active, hits: Number(r.hits || 0), fails: Number(r.fails || 0), every_min: Number(r.every_min || 0),
  }));
  return { ok: true, uptime: up, feeds, watches };
}
function plan(hub: Hub, p: Person) {
  const now = Date.now(), today = fmtDate(now, BJ), yesterday = fmtDate(now - DAY, BJ);
  const cny = (d: string) => { try { return Math.round(hub.accounts.dayEstimateCny(d) * 100) / 100; } catch { return null; } };
  const items = safeRows(hub, "SELECT provider, item, calls, usd FROM spend WHERE day=? ORDER BY usd DESC LIMIT 12", today)
    .map(r => ({ what: String(r.item), via: r.provider === "deepseek" ? "DeepSeek" : "OpenAI", calls: Number(r.calls), cny: Math.round(Number(r.usd) * (r.provider === "deepseek" ? PRICE.dsCnyPerUsd : 7.2) * 100) / 100 }));
  return { ok: true, plan: hub.plan.report(hub.store.r2All(), now), spend: { today: cny(today), yesterday: cny(yesterday), items }, accounts_report: part(() => dailyAccountsStatus(hub, p.conv), null) };
}
const tools = () => ({ ok: true, link: "/x/toolbox", abilities: ABILITIES.map(a => ({ title: a.title, what: a.what, examples: a.examples.map(e => exampleParts(e)[0]) })) });

// ---------- page extras: history for the visual indicators, and the overview in one request ----------
/** Per Beijing day for the last 7 days, the share of time the site was up (null before monitoring started). */
export function uptimeDays(hub: Hub, id: number, created: number, now = Date.now()) {
  const off = 8 * 3600000, from = Math.floor((now + off) / DAY) * DAY - off - 6 * DAY;
  const inc = safeRows(hub, "SELECT start, end FROM uptimeinc WHERE target=? AND start<? AND (end IS NULL OR end>?)", id, now, from);
  const out: { date: string; pct: number | null }[] = [];
  for (let d = 0; d < 7; d++) {
    const a = Math.max(from + d * DAY, created), b = Math.min(from + (d + 1) * DAY, now), date = fmtDate(from + d * DAY, BJ);
    if (b <= a) { out.push({ date, pct: null }); continue; }
    let down = 0;
    for (const i of inc) down += Math.max(0, Math.min(b, Number(i.end ?? now)) - Math.max(a, Number(i.start)));
    out.push({ date, pct: Math.round((1 - Math.min(down, b - a) / (b - a)) * 1000) / 10 });
  }
  return out;
}
/** A repository's recent runs: the latest verdict, since when it has been failing, the last pass, and up to 14 runs oldest first. */
export function repoHistory(hub: Hub, repo: string) {
  const list = safeRows(hub, "SELECT ts, ok FROM repocheck WHERE repo=? ORDER BY id DESC LIMIT 30", repo)
    .map(r => ({ ts: Number(r.ts), ok: r.ok === null || r.ok === undefined ? null : Number(r.ok) }));
  const known = list.filter(r => r.ok !== null), pass = known.find(r => r.ok === 1);
  let since: number | null = null;
  if (known.length && known[0].ok === 0) { let i = 0; while (i + 1 < known.length && known[i + 1].ok === 0) i++; since = known[i].ts; }
  return { ok: list.length ? list[0].ok : null, checked_at: list.length ? list[0].ts : null, failing_since: since, last_pass: pass ? pass.ts : null, history: list.slice(0, 14).reverse() };
}
const reposOut = (hub: Hub) => latestAll(hub, listRepos(hub)).map((r: any) => ({ ...r, ...repoHistory(hub, String(r.repo)) }));

/** The newest boss kill or badge, for the overview's one line; null when there is none in the last two weeks. */
function latestHonor(hub: Hub, conv: string, now: number) {
  const w = honorWall(hub, conv, now), cut = now - 14 * DAY;
  const boss = w.bosses[0], badge = w.badges.flatMap(b => b.holders.map(x => ({ who: x.who, at: x.at, name: b.name, what: b.what }))).sort((a, b) => b.at - a.at)[0];
  const pick = boss && (!badge || boss.done_at >= badge.at) ? { kind: "boss", who: boss.who, at: boss.done_at, title: boss.title, task: boss.id } : badge ? { kind: "badge", who: badge.who, at: badge.at, title: badge.name, what: badge.what } : null;
  return pick && pick.at > cut ? pick : null;
}
function wall(hub: Hub, p: Person) {
  const now = Date.now(), s = teamStats(hub, p.conv, now), w = honorWall(hub, p.conv, now), star = s.people.find(x => x.name === s.mvp);
  return { ok: true, ...w, bosses: w.bosses.map(b => ({ ...b, took: span(b.took_ms) })), current: star ? { who: star.name, points: star.points_week, done: star.done_week, title: star.title, week: s.week.start } : null };
}
function shopOut(hub: Hub, p: Person) {
  return { ok: true, name: p.name, items: shop(hub, p.conv), me: balanceOf(hub, p.conv, p.name), mine: spends(hub, p.conv, { who: p.name, limit: 30 }), recent: spends(hub, p.conv, { limit: 20 }) };
}
const settleAs = (hub: Hub, p: Person) => canSettleSpend(hub, p.conv, { id: p.uid, name: p.name });
function redemptions(hub: Hub, p: Person, u: URL) {
  const status = u.searchParams.get("state");
  const state = status === "pending" || status === "done" || status === "refunded" ? status : undefined;
  const before = num(u.searchParams.get("before"), 0, 0, Number.MAX_SAFE_INTEGER);
  const list = spends(hub, p.conv, { state, before, limit: 31 });
  const canSettle = settleAs(hub, p), balances = new Map(teamStats(hub, p.conv).people.map(person => [person.name, person.balance]));
  const records = list.slice(0, 30).map(({ note, ...entry }) => ({
    ...entry, ...(canSettle || entry.who === p.name ? { note } : {}), balance: balances.get(entry.who) ?? 0,
  }));
  return { ok: true, can_settle: canSettle, records, next: list.length > 30 ? records[records.length - 1].id : null };
}
const params = (s: string) => ({ searchParams: new URLSearchParams(s) }) as URL;
function part<T>(f: () => T, fallback: T): T { try { return f(); } catch { return fallback; } }   // one missing table must not blank the whole overview

function overview(hub: Hub, p: Person) {
  const now = Date.now(), today = fmtDate(now, BJ);
  const live = part(() => taskApi.listTasks(hub, p.conv, { status: ["open", "doing"], limit: 300 }).filter(t => t.conv === p.conv), [] as Task[]);
  const done7 = part(() => taskApi.listTasks(hub, p.conv, { status: ["done"], limit: 300 }).filter(t => t.conv === p.conv && t.updated > now - 7 * DAY).length, 0);
  const m = part(() => monitors(hub, p).uptime, [] as ReturnType<typeof monitors>["uptime"]);
  const pl = part(() => plan(hub, p), null);
  return {
    ok: true, name: p.name, today,
    days: part(() => days(hub, p, params("n=2")).days, []),
    tasks: {
      list: live.map(taskOut),
      counts: {
        open: live.filter(t => t.status === "open").length, doing: live.filter(t => t.status === "doing").length,
        overdue: live.filter(t => t.due && t.due < today).length, mine: live.filter(t => t.owner === p.name || t.claimed_by === p.name).length, done_7d: done7,
      },
    },
    repos: part(() => reposOut(hub).map((r: any) => ({ repo: r.repo, result: r.result, ok: r.ok, checked_at: r.checked_at, failing_since: r.failing_since, commit: r.commit || "" })), []),
    images: part(() => images(hub, p, params("n=8")).images, []),
    uptime: m.map(u => ({ name: u.name, url: u.url, state: u.state, since: u.since, last: u.last, error: u.error, active: u.active, uptime_7d: u.uptime_7d })),
    plan: pl ? pl.plan : null, spend: pl ? pl.spend : null,
    team: part(() => { const s = teamStats(hub, p.conv, now); return { week: s.week, mvp: s.mvp, people: s.people.map(x => ({ name: x.name, doing: x.doing, waiting: x.waiting, done_week: x.done_week, points_week: x.points_week, streak: x.streak, balance: x.balance, title: x.title })) }; }, null),
    me: part(() => { const s = teamStats(hub, p.conv, now).people.find(x => x.name === p.name); return { points_week: s?.points_week || 0, balance: s?.balance || 0, title: s?.title || "" }; }, null),
    latest: part(() => latestHonor(hub, p.conv, now), null),
  };
}

// ---------- changes ----------
const DUE = /^(\d{4}-\d{2}-\d{2})?$/;
function taskPatch(b: any): Record<string, string> | string {
  const out: Record<string, string> = {};
  for (const [k, max] of [["title", 200], ["detail", 4000], ["owner", 40], ["result", 4000]] as const) { const v = str(b[k], max); if (v !== undefined) out[k] = v; }
  if (b.due !== undefined) { const d = str(b.due, 10) ?? ""; if (!DUE.test(d)) return "日期写成 2026-11-20 这样"; out.due = d; }
  if (b.status !== undefined) { if (!(STATUSES as unknown[]).includes(b.status)) return "状态不对"; out.status = b.status; }
  if (b.size !== undefined) { if (!["small", "normal", "big"].includes(b.size)) return "大小不对"; out.size = b.size; }
  if (out.title !== undefined && !out.title) return "标题不能空着";
  return out;
}

async function post(hub: Hub, req: Request, u: URL, p: Person, path: string): Promise<Response> {
  const b = await readPost(hub, req, u);
  if (b instanceof Response) return b;
  if (path === "logout") return json({ ok: true }, 200, { "Set-Cookie": clearCookie() });
  if (path === "mcp") {
    const token = bearerToken(req.headers.get("authorization")) || cookieToken(req.headers.get("cookie"));
    if (!token) return bad("没找到你的登录信息，重新点一次群里的看板链接", 401);
    const urls = bases(hub).map(base => base + "/x/mcp/" + token);
    return json({
      ok: true, lines: urls.map(u => "claude mcp add --scope user --transport http teamagent " + u),
      tools: [
        { name: "Claude Code", lines: urls.map(u => "claude mcp add --scope user --transport http teamagent " + u) },
        { name: "Codex", lines: urls.map(u => "codex mcp add teamagent --url " + u) },
      ],
    });
  }
  if (path === "box/upload") {
    const d = newDrop(hub, p.conv, { by: p.name, sender: p.uid, note: str(b.note, 200) || "" });
    return d ? json({ ok: true, url: "/x/drop/" + d.token, expires: d.exp }) : bad("文件箱满了，先删掉一些再传", 507);
  }
  if (path === "shop/redeem") {   // always the visitor's own points: the name comes from the sign-in, never from the body
    const item = str(b.item, 40);
    if (!item) return bad("选一项再兑换");
    const r = redeem(hub, p.conv, p.name, item, str(b.note, 200) || "", "board");
    return r.ok ? json({ ok: true, spend: r.spend, balance: r.balance }) : bad(r.error, 400);
  }
  if (path === "redemptions/settle") {
    if (!settleAs(hub, p)) return bad("兑现确认和退分由群主办理", 403);
    if (!Number.isSafeInteger(b.id) || b.id <= 0 || (b.state !== "done" && b.state !== "refunded")) return bad("兑换编号或结算结果不对");
    const entry = settle(hub, p.conv, b.id, b.state, Date.now(), p.name);
    return entry ? json({ ok: true, entry, balance: balanceOf(hub, p.conv, entry.who).balance }) : bad("查不到这条兑换，或已按另一结果结算", 409);
  }
  if (path === "tasks") {
    const patch = taskPatch(b);
    if (typeof patch === "string") return bad(patch);
    if (!patch.title) return bad("先写个标题");
    const t = taskApi.addTask(hub, p.conv, { title: patch.title, detail: patch.detail || "", owner: patch.owner || "", due: patch.due || "", source: "看板", by: p.name, ...(patch.size ? { size: patch.size as any } : {}) });
    return t ? json({ ok: true, task: taskOut(t) }) : bad("没加上，稍后再试", 500);
  }
  const m = /^tasks\/(\d{1,9})(?:\/(note|claim))?$/.exec(path);
  if (!m) return bad("没有这个操作", 404);
  const id = Number(m[1]);
  if (!mine(taskApi.getTask(hub, p.conv, id), p)) return bad("没有这个任务", 404);
  if (m[2] === "note") {
    const t = str(b.text, 2000);
    if (!t) return bad("进展写点什么再提交");
    return taskApi.addTaskNote(hub, p.conv, id, p.name, t) ? json({ ok: true, notes: taskApi.taskNotes(hub, p.conv, id) }) : bad("没记上", 500);
  }
  if (m[2] === "claim") {
    const t = taskApi.claimTask(hub, p.conv, id, p.name);
    return t ? json({ ok: true, task: taskOut(t) }) : bad("这个任务已经有人在做了，或者已经结束", 409);
  }
  const patch = taskPatch(b);
  if (typeof patch === "string") return bad(patch);
  if (!Object.keys(patch).length) return bad("没有要改的");
  const t = taskApi.updateTask(hub, p.conv, id, patch as any, p.name);
  return t && t.conv === p.conv ? json({ ok: true, task: taskOut(t) }) : bad("没改成", 500);
}

// ---------- bytes ----------
async function bytesOf(hub: Hub, r: any): Promise<{ body: BodyInit; size?: number } | null | "plan"> {
  if (r.r2) {
    if (!hub.env.FILES) return null;
    if (!hub.plan.take("r2_reads", 1)) return "plan";
    const o = await hub.env.FILES.get(String(r.r2)).catch(() => null);
    return o ? { body: o.body, size: o.size } : null;
  }
  if (!r.data) return null;
  const d = r.data instanceof Uint8Array ? r.data : new Uint8Array(r.data as ArrayBuffer);
  return { body: d, size: d.byteLength };
}
async function media(hub: Hub, req: Request, p: Person, kind: "img" | "file", id: number): Promise<Response> {
  const r = kind === "img" ? rows(hub, "SELECT id, ts, mime, data, r2, size FROM img WHERE id=? AND conv=?", id, p.conv)[0]
    : rows(hub, "SELECT id, ts, name, data, r2, size FROM blob WHERE id=? AND conv=?", id, p.conv)[0];
  if (!r) return text(404, "没有这个文件");
  const etag = '"' + kind + id + "-" + r.ts + '"';
  const headers: Record<string, string> = { ...SEC, "Cache-Control": "private, max-age=86400", ETag: etag, Vary: "Cookie" };
  if ((req.headers.get("If-None-Match") || "").split(",").some(t => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
  const got = await bytesOf(hub, r);
  if (got === "plan") return text(503, "这个月的文件读取额度用完了，下个周期再看");
  if (!got) return text(404, "文件已经不在了");
  if (kind === "img") {
    const mime = String(r.mime || "");
    headers["Content-Type"] = /^image\/(png|jpeg|gif|webp|avif)$/.test(mime) ? mime : "application/octet-stream";
    headers["Content-Disposition"] = headers["Content-Type"].startsWith("image/") ? "inline" : disposition("g" + id, false);
  } else {
    const name = String(r.name || "file");
    headers["Content-Type"] = mimeOf(name);
    headers["Content-Disposition"] = disposition(name, false);
  }
  headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
  if (got.size !== undefined) headers["Content-Length"] = String(got.size);
  return new Response(req.method === "HEAD" ? null : got.body, { headers });
}

// ---------- routing ----------
export async function serve(hub: Hub, req: Request, u: URL): Promise<Response | null> {
  const path = u.pathname;
  if (path !== BASE && !path.startsWith(BASE + "/")) return null;
  if (path.startsWith(BASE + "/k/")) return null;   // personal links belong to access.ts
  const rest = path === BASE ? "" : path.slice(BASE.length + 1);
  const read = req.method === "GET" || req.method === "HEAD";
  if (rest === "app.css" || rest === "app.js") return read ? serveAsset(req, u, rest, false) : text(405, "只支持 GET", { Allow: "GET, HEAD" });

  const p = await personOf(hub, req);
  if (rest === "") {
    if (!read) return text(405, "只支持 GET", { Allow: "GET, HEAD" });
    return p ? serveAsset(req, u, "", true) : noPersonPage();
  }
  if (!p) return rest.startsWith("api/") ? json({ ok: false, error: NO_PERSON }, 401) : text(401, NO_PERSON);

  let m = /^(img|file|box)\/(\d{1,12})$/.exec(rest);
  if (m) {
    if (!read) return text(405, "只支持 GET", { Allow: "GET, HEAD" });
    if (m[1] !== "box") return media(hub, req, p, m[1] === "img" ? "img" : "file", Number(m[2]));
    const link = boxLink(hub, p.conv, "x" + m[2]);
    if (!link) return text(404, "这个文件已经过期或者不在了");
    const l = new URL(link);
    return new Response(null, { status: 302, headers: { ...SEC, Location: l.pathname + l.search, "Cache-Control": "no-store" } });
  }
  if (!rest.startsWith("api/")) return text(404, "没有这个页面");
  const api = rest.slice(4);
  if (req.method === "POST") return post(hub, req, u, p, api);
  if (req.method !== "GET") return bad("不支持这种请求", 405);

  if (api === "me") return json({ ok: true, name: p.name, people: [...new Set(listAccess(hub, p.conv).map(x => x.name).filter(Boolean))] });
  if (api === "days") return json(days(hub, p, u));
  if (api === "tasks") return json(tasks(hub, p, u));
  if ((m = /^tasks\/(\d{1,9})$/.exec(api))) { const t = task(hub, p, Number(m[1])); return t ? json(t) : bad("没有这个任务", 404); }
  if (api === "memory") return json(memory(hub, p));
  if (api === "repos") return json({ ok: true, repos: reposOut(hub) });
  if (api === "overview") return json(overview(hub, p));
  if (api === "wall") return json(wall(hub, p));
  if (api === "shop") return json(shopOut(hub, p));
  if (api === "redemptions") return json(redemptions(hub, p, u));
  if (api === "team") return json({ ok: true, name: p.name, ...teamStats(hub, p.conv) });
  if (api === "events") {
    const before = num(u.searchParams.get("before"), 0, 0, 2 ** 52), n = num(u.searchParams.get("n"), 50, 1, 200);
    const list = taskEvents(hub, p.conv, { limit: n + 1, ...(before ? { before } : {}) });
    return json({ ok: true, events: list.slice(0, n), more: list.length > n });
  }
  if ((m = /^tasks\/(\d{1,9})\/timeline$/.exec(api))) {
    const tl = taskTimeline(hub, p.conv, Number(m[1]));
    if (!tl || tl.task.conv !== p.conv) return bad("没有这个任务", 404);
    return json({ ok: true, created: tl.created, claimed_at: tl.claimed_at, done_at: tl.done_at, waited_ms: tl.waited_ms, worked_ms: tl.worked_ms, waited: span(tl.waited_ms), worked: span(tl.worked_ms),
      status: tl.task.status, done_by: tl.task.done_by, points: pointsOf(tl.task), steps: tl.steps.map(s => ({ ts: s.ts, who: s.who, kind: s.kind, word: s.word, text: s.text })) });
  }
  if (api === "images") return json(images(hub, p, u));
  if (api === "files") return json(blobs(hub, p, u));
  if (api === "sites") return json(sites(hub, p));
  if (api === "box") return json(box(hub, p));
  if (api === "monitors") return json(monitors(hub, p));
  if (api === "plan") return json(plan(hub, p));
  if (api === "tools") return json(tools());
  return bad("没有这个接口", 404);
}

const feature: Feature = {
  name: "board",
  open: (hub, req, u) => serve(hub, req, u),
  about: [
    "团队看板是一个网页（" + BASE + "），群友用自己的看板链接打开：最近每天的群聊小结、任务清单、我的长期记忆、团队仓库的夜检结果、我画的图和收发的文件、做过的网页、文件箱、网站监控和订阅、这个月的额度用量。",
    "任务能在看板上直接加、改、标完成或放弃、写进展，每一步都记着是谁做的；每个任务有“交给本地 AI”，复制一句话给自己电脑上的 AI 工具，它就能领走这个任务、做完交回来。",
    "看板首页先看谁在做什么、这周做完几件；“战绩”一栏有本周和总排行、每个人的徽章、最快一次和最近做完的事，还有大家接任务、写进展、做完的流水。",
    "看板只显示看的人所在的群的东西，图片和文件也要登录才能打开；点“退出”就清掉这台设备上的登录。",
  ],
};
export default feature;
