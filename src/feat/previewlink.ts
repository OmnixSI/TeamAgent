// Clickable preview links: runs a repository's web app (branch or PR) in the cloud computer like preview_app,
// then hands the group a link they open in their own browser for a few minutes.
//
// Routing. The app lives at the root of the Worker's host, not under a prefix: /x/live/<token> sets a
// host-only cookie and redirects to /, and the Worker sends every later request that carries the cookie and
// is not one of the bot's own paths (/admin/, /p/, /x/, /qq/, /health, /tick) here as /x/lv/<token>/<path>.
// So absolute paths an app uses (/assets/…, /_next/…, /@vite/client, /api/…) and history routing work with
// no base-path flags or HTML rewriting. Requests then go through preview_app's own token check and proxy.
//
// Machine time. A proxied request postpones the machine's 90-second sleep, but nothing else does, and
// proxied time is not metered; so while a link is open the 20-second tick pings the app (keeping it up
// between a visitor's clicks), charges container time up to the sleep line, and closes the link at expiry,
// after a few idle minutes, or when the allowance runs out. The token itself expires at the same moment,
// so even with no tick at all nothing can reach the machine afterwards and it sleeps within 90 seconds.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { runComputer } from "../computer.ts";
import preview, { gh, RECIPES, pickRecipe, parsePull, refspecOf, validRef, prepareCommands, stopCommand, issueToken, checkToken, revokeToken, newToken } from "./preview.ts";
import type { Recipe, Target } from "./preview.ts";
import { advice } from "./steward.ts";
import { RUNTIME, withDict } from "../i18n.ts";
import type { Dict } from "../i18n.ts";

export const COOKIE = "__Host-tapv";
const KEY = "previewlink:open";
const IDLE = 90;                       // the cloud computer sleeps this many seconds after its last use (computer.ts)
const START_LIMIT = 600;               // seconds allowed for clone, install, build and start
const MAX_MINUTES = 20;
const LOCK_TTL = 16 * 60000;           // preview_app's "preview:busy" lock
const VISIT_EVERY = 15000;             // how often a visit is written down
const TOKEN = /^[a-f0-9]{32}$/;
const DEFAULT_ORIGIN = "https://teamagent.inkboard-server.workers.dev";

// ---------- routing (pure; liveTarget is what the Worker calls) ----------

/** Paths the Worker itself serves; a preview cookie must never capture them. */
export const RESERVED = /^\/(?:health|tick|event)\/?$|^\/(?:admin|qq|p|x)(?:\/|$)/;

/** The preview token in a Cookie header, or "". */
export function cookieToken(cookie: string | null | undefined) {
  for (const part of String(cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === COOKIE) { const v = part.slice(i + 1).trim(); if (TOKEN.test(v)) return v; }
  }
  return "";
}
/** Cookie header without ours, so the app never sees the token. */
export function stripCookie(cookie: string | null | undefined) {
  return String(cookie || "").split(";").filter(p => { const i = p.indexOf("="); return p.trim() && (i < 0 || p.slice(0, i).trim() !== COOKIE); }).map(p => p.trim()).join("; ");
}
/** Where the Worker should send a request from a browser holding a preview cookie, or null to handle it as usual. */
export function liveTarget(url: URL, cookie: string | null | undefined): string | null {
  if (RESERVED.test(url.pathname)) return null;
  const t = cookieToken(cookie);
  return t ? "/x/lv/" + t + url.pathname + url.search : null;
}
/** /x/live/<token>[/path] (the link people click) or /x/lv/<token>/path (forwarded by the Worker). */
export function parseLive(pathname: string): { kind: "enter" | "pass"; token: string; path: string } | null {
  const m = /^\/x\/(live|lv)\/([a-f0-9]{32})(\/.*)?$/.exec(pathname);
  return m ? { kind: m[1] === "live" ? "enter" : "pass", token: m[2], path: m[3] || "/" } : null;
}
/** A same-site path to land on: "/\\evil.com" or "//evil.com" would leave the site. */
export const landing = (path: string) => "/" + String(path || "/").replace(/^[\/\\]+/, "");

export const setCookie = (token: string, seconds: number) => COOKIE + "=" + token + "; Path=/; Max-Age=" + Math.max(1, Math.floor(seconds)) + "; HttpOnly; Secure; SameSite=Lax";
export const clearCookie = () => COOKIE + "=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";

/** Response headers from the app, minus anything that could reach beyond the preview: our cookie, a service
 *  worker scope, wiping the site's storage. */
export function cleanHeaders(h: Headers) {
  const out = new Headers();
  for (const [k, v] of h) if (!["set-cookie", "service-worker-allowed", "clear-site-data"].includes(k.toLowerCase())) out.set(k, v);
  const cookies: string[] = typeof (h as any).getSetCookie === "function" ? (h as any).getSetCookie() : (h.get("set-cookie") ? [h.get("set-cookie")!] : []);
  for (const c of cookies) if (c.split("=")[0].trim().toLowerCase() !== COOKIE.toLowerCase()) out.append("set-cookie", c);
  return out;
}

// ---------- the open link (one at a time, in kv) ----------

export type Link = {
  token: string; conv: string; repo: string; what: string; port: number;
  state: "starting" | "open"; started: number; opened?: number; exp?: number; minutes: number; idle: number;
  url?: string; lastPing?: number; fails?: number; lastVisit?: number; entries?: number; cancel?: boolean;
};
type Kv = { get(k: string): string | null; set(k: string, v: string): void };
export function load(hub: Kv): Link | null {
  try { const r = JSON.parse(hub.get(KEY) || "null"); return r && r.token ? r : null; } catch { return null; }
}
const save = (hub: Kv, l: Link) => hub.set(KEY, JSON.stringify(l));
const stale = (l: Link, now: number) => l.state === "starting" ? now > l.started + (START_LIMIT + 180) * 1000 : now >= (l.exp || 0);

/** The open link a token belongs to, or null when it is unknown, closed or expired. */
export function liveLink(hub: Kv, token: string, now = Date.now()) {
  const l = load(hub);
  if (!l || l.state !== "open" || l.token !== token || !(now < (l.exp || 0))) return null;
  return checkToken(hub, token, now) ? l : null;
}

/** Why a link may not open now, or "". `seconds` is the machine time the whole window may take. */
export function linkRefusal(hub: Kv & { plan: { fits(n: string, a?: number): boolean } }, seconds: number, now = Date.now()) {
  const l = load(hub);
  if (l && !stale(l, now)) return "已经有一个预览链接开着（" + l.repo + " " + l.what + "），一次只能开一个；要换就先把它关掉";
  if (!l && now - Number(hub.get("preview:busy") || 0) < LOCK_TTL) return "云电脑上正在跑一个预览，等它跑完再开链接";
  if (!hub.plan.fits("container_seconds", seconds)) return "这个月云电脑的额度不够开这么久的预览链接了，缩短时间或者等下个周期";
  if (!hub.plan.fits("container_cpu_seconds", 60)) return "这个月云电脑的 CPU 额度到停止线了，下个周期再用";
  return "";
}
/** Machine time to budget for: start-up, the window, the sleep line after it. */
export const windowSeconds = (r: Recipe, minutes: number) => (r.install || r.build ? 420 : 60) + minutes * 60 + IDLE;

/** Container time from the last charged moment to the machine's sleep line; shares runComputer's mark. */
export function charge(hub: Kv & { plan: { add(n: string, a: number): void } }, from: number, now: number) {
  const end = now + IDLE * 1000, until = Number(hub.get("computer:billed_until") || 0);
  const s = (end - Math.max(until, from)) / 1000;
  if (s > 0) { hub.plan.add("container_seconds", s); hub.set("computer:billed_until", String(end)); }
  return Math.max(0, s);
}

type Stop = (hub: Hub) => Promise<unknown>;
const stopApp: Stop = hub => runComputer(hub, { commands: [stopCommand(), "rm -rf /work/preview"], timeoutSeconds: 40 });

/** Closes the link: token and record go at once, the app is stopped when the machine is known to be up. */
export async function closeLink(hub: Hub, l: Link, why: string, opts: { now?: number; tell?: boolean; stop?: Stop; wait?: boolean } = {}) {
  const now = opts.now ?? Date.now();
  if (load(hub)?.token === l.token) hub.set(KEY, "null");
  revokeToken(hub, l.token);
  hub.set("preview:busy", "0");
  const up = l.state === "open" && !!l.lastPing && now - l.lastPing < 60000;
  if (up) {
    const p = (opts.stop || stopApp)(hub).catch(() => {});
    if (opts.wait) await p; else hub.ctx.waitUntil(p);
  }
  if (opts.tell !== false && l.state === "open") await hub.say(l.conv, l.repo + " " + l.what + " 的预览链接关了（" + why + "）。").catch(() => false);
  return { closed: true, why, stopped_app: up };
}

/** Pings the app through the preview proxy: keeps the machine up and tells whether the server still answers. */
async function ping(hub: Hub, token: string) {
  const req = new Request("https://hub/x/preview/" + token + "/", { headers: { "user-agent": "teamagent-keepalive" } });
  try {
    const r = await preview.open!(hub, req, new URL(req.url));
    if (!r) return false;
    const body = r.status === 502 || r.status === 403 ? await r.text() : (await r.body?.cancel().catch(() => {}), "");
    return !(r.status === 403 || (r.status === 502 && body.startsWith("预览服务没有响应")));
  } catch { return false; }
}

export async function tick(hub: Hub, now: number, opts: { stop?: Stop } = {}) {
  const l = load(hub);
  if (!l) return;
  if (l.state === "starting") {
    // A start that never finished (the Hub restarted mid-way): no token was issued, so nothing reaches the app.
    if (stale(l, now)) { hub.set(KEY, "null"); hub.set("preview:busy", "0"); }
    return;
  }
  const why = now >= (l.exp || 0) ? "到时间了" : now - Math.max(l.lastVisit || 0, l.opened || 0) > l.idle * 60000 ? "连续 " + l.idle + " 分钟没人用"
    : !hub.plan.fits("container_seconds", IDLE) ? "这个月云电脑额度到停止线了" : "";
  if (why) { await closeLink(hub, l, why, { now, stop: opts.stop }); return; }
  if (await ping(hub, l.token)) {
    charge(hub, l.opened || now, now);
    l.lastPing = now; l.fails = 0;
  } else if ((l.fails = (l.fails || 0) + 1) >= 2) { await closeLink(hub, l, "网页服务停了", { now, stop: opts.stop }); return; }
  hub.set("preview:busy", String(now));
  if (load(hub)?.token === l.token) save(hub, l);
}

// ---------- serving ----------

/** English for the page a closed preview link lands on. */
export const PAGE_EN: Dict = {
  "预览链接": "Preview link",
  "这个预览链接已经关闭或过期了。想再看，就在群里让 Bot 重新开一个。": "This preview link has closed or expired. To see the app again, ask the Bot in the group to open a new one.",
};
// One sentence, so no language picker: the page follows the reader's choice from the other pages, else the system language.
const page = (status: number, text: string, extra: Record<string, string> = {}) => new Response(
  "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title data-i>预览链接</title>" +
  "<p data-i style='font:16px/1.6 system-ui,sans-serif;margin:2em'>" + text + "</p><script>" + withDict(RUNTIME, PAGE_EN) + "\nLANG.apply();</script>",
  { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...extra } });
const ended = (clear: boolean) => page(410, "这个预览链接已经关闭或过期了。想再看，就在群里让 Bot 重新开一个。", clear ? { "set-cookie": clearCookie() } : {});

export async function serve(hub: Hub, req: Request, url: URL, now = Date.now()): Promise<Response | null> {
  const p = parseLive(url.pathname);
  if (!p) return null;
  const l = liveLink(hub, p.token, now);
  // An old link clicked by mistake must not drop the cookie of a link that is still open.
  if (!l) return ended(p.kind === "pass" || cookieToken(req.headers.get("cookie")) === p.token);
  if (p.kind === "enter") {
    l.entries = (l.entries || 0) + 1; l.lastVisit = now; save(hub, l);
    return new Response(null, { status: 302, headers: {
      location: landing(p.path) + url.search, "set-cookie": setCookie(p.token, ((l.exp || now) - now) / 1000),
      "cache-control": "no-store", "referrer-policy": "no-referrer",
    } });
  }
  // Workers cannot carry a WebSocket from the machine back to the browser; dev servers' live reload gives up.
  if ((req.headers.get("upgrade") || "").toLowerCase() === "websocket") return new Response("预览链接不支持 WebSocket（开发服务器的热更新），页面本身照常能用", { status: 501 });
  // A service worker registered on this host would outlive the preview and sit in front of the bot's own pages.
  if (req.headers.get("service-worker")) return new Response("预览链接不允许注册 service worker", { status: 403 });
  if (now - (l.lastVisit || 0) > VISIT_EVERY) { l.lastVisit = now; save(hub, l); }
  const headers = new Headers(req.headers);
  const rest = stripCookie(headers.get("cookie"));
  if (rest) headers.set("cookie", rest); else headers.delete("cookie");
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const inner = new Request(url.origin + "/x/preview/" + p.token + p.path + url.search, { method: req.method, headers, body, redirect: "manual" });
  const r = await preview.open!(hub, inner, new URL(inner.url));
  if (!r) return ended(true);
  return new Response(r.body, { status: r.status, statusText: r.statusText, headers: cleanHeaders(r.headers) });
}

// ---------- opening ----------

export type Resolved = { full: string; target: Target; what: string; recipe: Recipe; ghToken: string };
type Resolve = (hub: Hub, repo: string, pr: number, ref: string) => Promise<Resolved>;

/** What to check out and how to run it, the same way preview_app decides. */
export const resolve: Resolve = async (hub, repo, pr, ref) => {
  const full = repo.includes("/") ? repo : (hub.env.GITHUB_ORG || "OmnixSI") + "/" + repo, name = full.split("/")[1];
  const meta = await gh(hub.env, "/repos/" + full);
  let target: Target, what: string, at: string;
  if (pr) {
    const pull = parsePull((await gh(hub.env, "/repos/" + full + "/pulls/" + pr)).data);
    target = { label: "PR #" + pull.number, slot: "live", refspec: "refs/pull/" + pull.number + "/head" };
    what = "PR #" + pull.number + "「" + pull.title + "」"; at = pull.headSha;
  } else {
    const r = ref || String(meta.data.default_branch || "main");
    target = { label: r, slot: "live", refspec: refspecOf(r) };
    what = "分支 " + r; at = r;
  }
  let recipe = RECIPES[name];
  if (!recipe) {
    const enc = encodeURIComponent(at);
    const list = await gh(hub.env, "/repos/" + full + "/contents?ref=" + enc).catch(() => ({ data: [] as any[] }));
    const files = Array.isArray(list.data) ? list.data.map((f: any) => String(f.name)) : [];
    const pkg = files.includes("package.json") ? await gh(hub.env, "/repos/" + full + "/contents/package.json?ref=" + enc, true).then(r => JSON.parse(r.data)).catch(() => null) : null;
    recipe = pickRecipe(name, files, pkg);
  }
  return { full, target, what, recipe, ghToken: meta.token };
};

export type OpenArgs = { conv: string; repo: string; pr: number; ref: string; minutes: number; idle: number; page: string };

export async function openLink(hub: Hub, a: OpenArgs, deps: { resolve?: Resolve; now?: () => number } = {}) {
  const now = deps.now || Date.now;
  const minutes = Math.min(MAX_MINUTES, Math.max(1, Math.round(a.minutes)));
  const early = linkRefusal(hub, minutes * 60 + IDLE + 60, now());
  if (early) return { ok: false, error: early };
  const old = load(hub);
  if (old) await closeLink(hub, old, "到时间了", { wait: true });   // expired, the tick has not got to it yet
  const l: Link = { token: newToken(), conv: a.conv, repo: a.repo, what: "", port: 0, state: "starting", started: now(), minutes, idle: a.idle };
  save(hub, l);
  hub.set("preview:busy", String(now()));
  const give = (out: any) => { if (load(hub)?.token === l.token) hub.set(KEY, "null"); hub.set("preview:busy", "0"); return out; };
  let res: Resolved;
  try { res = await (deps.resolve || resolve)(hub, a.repo, a.pr, a.ref); }
  catch (e: any) { return give({ ok: false, error: String(e?.message || e) }); }
  if (res.recipe.none) return give({ ok: false, previewable: false, error: "这个仓库没法预览：" + res.recipe.none });
  const seconds = windowSeconds(res.recipe, minutes);
  if (!hub.plan.fits("container_seconds", seconds)) return give({ ok: false, error: "这个月云电脑的额度不够开 " + minutes + " 分钟的预览链接了，缩短时间或者等下个周期" });
  l.repo = res.full.split("/")[1]; l.what = res.what; l.port = res.recipe.port || 0; save(hub, l);

  const password = newToken().slice(0, 20);
  const env: Record<string, string> = { PREVIEW_PASSWORD: password, ...(res.ghToken ? { GH_TOKEN: res.ghToken } : {}) };
  const r = await runComputer(hub, { commands: prepareCommands(res.full, res.target, res.recipe), env, timeoutSeconds: START_LIMIT });
  const cancelled = !!load(hub)?.cancel || load(hub)?.token !== l.token;
  if (!r.ok || cancelled) {
    await stopApp(hub).catch(() => {});
    const bad = r.steps.find(s => s.exit !== 0);
    return give(cancelled ? { ok: false, error: "启动途中被关掉了" } : {
      ok: false, repo: res.full, what: res.what, recipe: res.recipe.how,
      error: "网页没能跑起来" + (r.error ? "：" + r.error : ""), ...(bad ? { output: (bad.stdout + "\n" + bad.stderr).trim().slice(-1500) } : {}),
    });
  }
  const opened = now(), exp = opened + minutes * 60000;
  revokeToken(hub, l.token);
  const token = issueToken(hub, res.recipe.port!, opened, minutes * 60000);
  const origin = new URL(hub.env.PUBLIC_URL || DEFAULT_ORIGIN).origin;
  const land = a.page ? (a.page.startsWith("#") ? "/" + a.page : landing(a.page)) : "/";
  const url = origin + "/x/live/" + token + land;
  Object.assign(l, { token, state: "open", opened, exp, lastPing: opened, fails: 0, url });
  save(hub, l);
  hub.set("preview:busy", String(opened));
  const logins = (res.recipe.login || []).map(x => Object.entries(x.body).map(([k, v]) => k + "=" + v.replace("{password}", password)).join("，"));
  const note = advice(hub, "container_seconds", seconds);
  return {
    ok: true, url, repo: res.full, what: res.what, minutes, recipe: res.recipe.how,
    closes: minutes + " 分钟后自动关闭；连续 " + a.idle + " 分钟没人打开也会提前关",
    ...(res.recipe.warn ? { warning: res.recipe.warn } : {}), ...(res.recipe.routes ? { routes: res.recipe.routes } : {}),
    ...(logins.length ? { demo_logins: logins, login_note: "应用要登录时用这些演示账号，密码只在这次预览里有效" } : {}),
    note: "手机、电脑浏览器直接点开就行，几个人同时看也可以；页面改动不会自动刷新（开发服务器的热更新连不上），想看最新的就重新开一个链接",
    ...(note ? { budget_note: note } : {}),
  };
}

// ---------- the tool ----------

const feature: Feature = {
  name: "previewlink",
  tunables: {
    previewlink_minutes: { default: 10, min: 3, max: MAX_MINUTES, what: "可点击的预览链接默认开几分钟（最多 20）" },
    previewlink_daily: { default: 3, min: 0, max: 10, what: "每天最多开几次可点击的预览链接" },
    previewlink_idle_minutes: { default: 5, min: 2, max: MAX_MINUTES, what: "预览链接连续几分钟没人用就提前关掉，省云电脑额度" },
  },
  tools: ctx => [{
    name: "preview_link", work: true, slow: true, long: true,
    description: "把团队某个仓库的网页应用（某个分支或某个 PR）在云电脑里跑起来，给群里一个能直接点开的链接，大家用自己的手机或电脑浏览器点着玩几分钟，比看截图直观。适合「把 PR 44 跑起来给我个链接」「我想自己点点看」。op=open 开链接（要几十秒到几分钟，跑起来才返回 url，把 url 原样发给大家）；op=close 提前关掉；op=list 看现在开着的链接。一次只能开一个，默认 10 分钟（minutes 最多 20），到时间或连续几分钟没人用会自动关，关的时候会在群里说一声。需要登录的应用会返回演示账号。只看几页的样子用 preview_app 截图更省。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["open", "close", "list"], description: "open 开链接（默认）、close 关掉开着的链接、list 看开着的链接" },
        repo: { type: "string", description: "open 时必填：仓库名，如 peiwan-club-saas、NextThought-Website；别的组织写 owner/name" },
        pr: { type: "integer", description: "PR 编号。和 ref 二选一" },
        ref: { type: "string", description: "分支名、标签或提交号；不填 pr 也不填 ref 就用默认分支" },
        minutes: { type: "integer", description: "开几分钟，默认 10，最多 20。只在对方要求更久或更短时填" },
        page: { type: "string", description: "点开后先到哪一页，如 /client.html 或 #/orders；不填就是首页" },
      },
    },
    run: async a => {
      const hub = ctx.hub, host = ctx.host, op = String(a.op || "open");
      if (op === "list") {
        const l = load(hub), now = Date.now();
        if (!l || stale(l, now)) return { ok: true, links: [] };
        return { ok: true, links: [l.state === "starting" ? { repo: l.repo, what: l.what, state: "还在启动" }
          : { repo: l.repo, what: l.what, url: l.url, minutes_left: Math.max(0, Math.ceil(((l.exp || now) - now) / 60000)), opened_times: l.entries || 0 }] };
      }
      if (op === "close") {
        const l = load(hub);
        if (!l || stale(l, Date.now())) return { ok: true, closed: false, note: "现在没有开着的预览链接" };
        if (l.state === "starting") { l.cancel = true; save(hub, l); return { ok: true, closed: false, note: "还在启动，起来之后会立刻关掉" }; }
        return { ok: true, ...(await closeLink(hub, l, "有人让关的", { tell: false, wait: true })) };
      }
      if (op !== "open") return { ok: false, error: "op 只能是 open、close 或 list" };
      const repo = String(a.repo || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
      if (!/^([\w.-]+\/)?[\w.-]+$/.test(repo)) return { ok: false, error: "仓库名看不懂，写成 peiwan-club-saas 或 owner/name" };
      const pr = a.pr === undefined || a.pr === null || a.pr === "" ? 0 : Number(String(a.pr).replace(/^#/, ""));
      if (pr && !(Number.isInteger(pr) && pr > 0)) return { ok: false, error: "PR 编号要是正整数" };
      const ref = a.ref ? String(a.ref).trim() : "";
      if (ref && !validRef(ref)) return { ok: false, error: "分支名看不懂" };
      const name = repo.split("/").pop()!;
      if (RECIPES[name]?.none) return { ok: false, previewable: false, error: "这个仓库没法预览：" + RECIPES[name].none };
      const minutes = Math.min(MAX_MINUTES, Math.max(3, Number(a.minutes) || Number(host.cfg("previewlink_minutes")) || 10));
      const why = linkRefusal(hub, minutes * 60 + IDLE + 60);
      if (why) return { ok: false, error: why };
      if (!(await host.quota("previewlink", Number(host.cfg("previewlink_daily"))))) return { ok: false, error: "今天开预览链接的次数用完了" };
      return openLink(hub, { conv: ctx.conv, repo, pr, ref, minutes, idle: Number(host.cfg("previewlink_idle_minutes")) || 5, page: String(a.page || "").trim() });
    },
  }],
  tick: (hub, now) => tick(hub, now),
  open: (hub, req, url) => serve(hub, req, url),
  about: [
    "preview_link 能把团队仓库的网页应用（某个分支或 PR）在云电脑里跑起来，给一个能直接点开的链接，大家用自己的浏览器点着玩，不只是看截图",
    "一次只开一个链接，默认 10 分钟、最多 20 分钟，到时间或者连续 5 分钟没人用就自动关，关的时候在群里说一声；每天默认最多开 3 次",
    "链接里有一串随机通行码，第一次点开时存进浏览器，之后应用的所有页面和接口都经由 Bot 的网址转到云电脑里；到时间通行码作废，云电脑一分半钟后自己睡下",
    "开着的时候 Bot 每 20 秒碰一下应用，免得云电脑在两次点击之间睡着；这段时间都记进云电脑的月额度，开之前会先算够不够",
    "开发服务器的热更新（WebSocket）连不上，所以改了代码页面不会自动刷新；页面本身、接口、登录都正常",
  ],
};
export default feature;
