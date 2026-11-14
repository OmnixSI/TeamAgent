// Previews a repository's web app (a branch or a pull request) without anyone pulling the code: the cloud
// computer clones, installs, builds and serves it, the headless browser loads it through this Worker and
// takes screenshots, and the pictures go to the chat. The browser reaches the server inside the container
// with an `x-preview: <token>` header on every request; the Worker turns that into /x/preview/<token>/…,
// and the `open` hook below checks the token and forwards the request to the container port.
import puppeteer from "@cloudflare/puppeteer";
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { runComputer } from "../computer.ts";
import type { ComputerResult } from "../computer.ts";

const ROOT = "/work/preview";
const TOKEN_TTL = 15 * 60000;
const LOCK_TTL = 16 * 60000;
const MAX_PAGES = 6;

// ---------- tokens: short-lived records in kv that map a token to a container port ----------

export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, "0")).join("");
}
type Kv = { get(k: string): string | null; set(k: string, v: string): void; sql?: any };
export function issueToken(hub: Kv, port: number, now = Date.now(), ttl = TOKEN_TTL) {
  const token = newToken();
  hub.set("preview:tok:" + token, JSON.stringify({ port, exp: now + ttl }));
  return token;
}
/** The port a token stands for, or 0 when it is unknown, malformed or expired. */
export function checkToken(hub: Kv, token: string, now = Date.now()) {
  if (!/^[a-z0-9]{16,64}$/.test(token)) return 0;
  let rec: any = null;
  try { rec = JSON.parse(hub.get("preview:tok:" + token) || "null"); } catch { rec = null; }
  if (!rec || !(Number(rec.exp) > now)) return 0;
  const port = Number(rec.port);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0;
}
export function revokeToken(hub: Kv, token: string) {
  if (hub.sql) hub.sql.exec("DELETE FROM kv WHERE k=?", "preview:tok:" + token);
  else hub.set("preview:tok:" + token, "null");
}

/** Splits /x/preview/<token>/<path>?<query> into the token and the path the app should see. */
export function stripPreview(pathname: string, search = ""): { token: string; path: string } | null {
  const m = /^\/x\/preview\/([a-z0-9]{16,64})(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return { token: m[1], path: (m[2] || "/") + search };
}

const DROP = ["x-preview", "host", "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor", "cf-worker", "cdn-loop", "x-forwarded-proto", "x-real-ip", "x-forwarded-for"];

/** A redirect to the server's own address would send the browser to its own localhost; keep only the path. */
export function localPath(location: string) {
  const m = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(:\d+)?(\/.*)?$/i.exec(location);
  return m ? m[3] || "/" : location;
}

async function forward(hub: Hub, req: Request, port: number, path: string) {
  const headers = new Headers(req.headers);
  for (const h of DROP) headers.delete(h);
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  const out = new Request("http://localhost:" + port + path, { method: req.method, headers, body, redirect: "manual" });
  const box = hub.env.COMPUTER.get(hub.env.COMPUTER.idFromName("computer"));
  const resp: Response = await box.proxy(port, out);
  const h = new Headers(resp.headers);
  const loc = h.get("location");
  if (loc) h.set("location", localPath(loc));
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

// ---------- recipes: how each repository is installed, built and served ----------

export type Login = { when: string; endpoint: string; body: Record<string, string>; key: string };
export type Recipe = {
  how: string;                 // short Chinese description of the recipe, reported back
  dir?: string;                // subdirectory the app lives in
  pm?: "npm" | "pnpm" | "yarn";
  install?: string; build?: string; setup?: string;
  start?: string; port?: number;
  heap?: number;               // MB for the build; the server gets a smaller heap
  serverHeap?: number;         // MB for the running server, when 320 is not enough (a dev server compiles on demand)
  login?: Login[];
  routes?: string;             // what pages exist, for the model
  warn?: string;               // the preview works only partly
  none?: string;               // cannot be previewed, and why
};

const PNPM = "(command -v pnpm >/dev/null || npm i -g -s pnpm@10 >/dev/null 2>&1)";
export const RECIPES: Record<string, Recipe> = {
  "peiwan-club-saas": {
    // A production build of the three entry points is killed for memory in the 1 GiB machine (measured:
    // 115 s, then "Killed"), so the pages are served by the dev server, which compiles only what is opened.
    how: "pnpm 安装 → 写演示数据 → 后端 :8787 + 前端开发服务器 :4173（/api 转给后端；整包打包在 1 GB 内存里会被杀掉，所以不打包）→ 用演示账号登录后截图",
    pm: "pnpm", install: PNPM + " && pnpm install --frozen-lockfile --reporter=silent",
    setup: "mkdir -p .pv && DB_PATH=$PWD/.pv/app.db SEED_PASSWORD=\"$PREVIEW_PASSWORD\" node server/src/seed.ts | tail -3",
    start: "(cd server && PORT=8787 DB_PATH=$PWD/../.pv/app.db UPLOAD_DIR=$PWD/../.pv/uploads node src/index.ts) & (cd web && npx vite --host 0.0.0.0 --port 4173 --strictPort --logLevel warn) & wait",
    port: 4173, heap: 700, serverHeap: 640,
    login: [
      { when: "^/platform\\.html", endpoint: "/api/platform/auth/login", body: { username: "admin", password: "{password}" }, key: "pw_platform_token" },
      { when: "^/client\\.html", endpoint: "/api/client/auth/login", body: { phone: "13800000000", password: "{password}" }, key: "pw_client_token" },
      { when: "^/(?!platform\\.html|client\\.html)", endpoint: "/api/shop/auth/login", body: { shop_code: "APEX001", username: "boss", password: "{password}" }, key: "pw_shop_token" },
    ],
    routes: "店铺后台（以店长 boss 登录）：/#/dashboard 工作台、/#/orders 订单、/#/customers 客户、/#/boosters 打手、/#/catalog 游戏与服务、/#/promotions 活动、/#/finance 财务、/#/after-sales 售后、/#/logs 日志、/#/settings 店铺设置、/#/login 登录页（会先登录，所以要看登录页得关掉 login）；客户端（手机号 13800000000）：/client.html、/client.html#/orders、/client.html#/me；平台后台（admin）：/platform.html#/dashboard、/platform.html#/shops、/platform.html#/orders",
  },
  "NextThought-Website": {
    how: "纯静态网站，不用安装和打包，直接用静态服务器发 public/ 目录（:4174）",
    start: "python3 -m http.server 4174 --bind 0.0.0.0 --directory public", port: 4174,
    routes: "/ 风格画廊首页、/compare/ 并排对比、/minimal/、/technology/、/story/、/classic/、/final/、/turn/ 各风格首页",
  },
  "WhalePartner": {
    how: "只打包桌面应用的界面部分（apps/client，vite build）用 vite preview 发出来（:4175）",
    dir: "apps/client", pm: "pnpm", install: PNPM + " && pnpm install --frozen-lockfile --reporter=silent",
    build: "npx vite build --logLevel warn", start: "npx vite preview --host 0.0.0.0 --port 4175 --strictPort", port: 4175, heap: 700,
    warn: "这是桌面应用（Tauri），后端要 Node 26 和模型密钥，云电脑提供不了，所以界面会显示连不上后端；只适合看静态布局",
    routes: "/ 主界面、/character-cards.html 角色卡",
  },
  "NextThought": { how: "", none: "这是原生 macOS 应用（Swift），没有网页界面；云电脑是 Linux，跑不了它" },
  "TeamAgent": { how: "", none: "这是 Bot 自己，跑在 Cloudflare 上，没有可以打开的网页界面" },
};

const PORT_GENERIC = 4180;
/** Flags that make a dev/preview server listen on every interface at our port, by the tool the script runs. */
export function serveFlags(script: string, port: number) {
  if (/\bnext\b/.test(script)) return "-H 0.0.0.0 -p " + port;
  if (/\b(vite|astro)\b/.test(script)) return "--host 0.0.0.0 --port " + port + (/\bvite\b/.test(script) ? " --strictPort" : "");
  return "";
}
function runScript(pm: string, name: string, flags: string) {
  if (!flags) return pm + " run " + name;
  return pm === "npm" ? "npm run " + name + " -- " + flags : pm + " run " + name + " " + flags;
}

/** The recipe for a repository: the table first, then a guess from package.json scripts or a plain index.html. */
export function pickRecipe(repo: string, files: string[], pkg: any): Recipe {
  const hit = RECIPES[repo] || Object.entries(RECIPES).find(([k]) => k.toLowerCase() === repo.toLowerCase())?.[1];
  if (hit) return hit;
  const has = (f: string) => files.includes(f);
  const scripts: Record<string, string> = pkg && typeof pkg.scripts === "object" ? pkg.scripts : {};
  if (pkg) {
    const pm = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const install = pm === "pnpm" ? PNPM + " && pnpm install --frozen-lockfile --reporter=silent"
      : pm === "yarn" ? "corepack enable >/dev/null 2>&1; yarn install --frozen-lockfile --silent"
      : has("package-lock.json") ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error";
    const pick = scripts.build && scripts.preview ? "preview" : scripts.build && scripts.start ? "start" : scripts.dev ? "dev" : scripts.start ? "start" : "";
    if (pick) {
      const flags = serveFlags(scripts[pick], PORT_GENERIC);
      const build = pick === "dev" ? undefined : pm + " run build";
      return {
        how: "按 package.json 猜的：" + pm + " 安装" + (build ? " → " + pm + " run build" : "") + " → " + pm + " run " + pick + "（:" + PORT_GENERIC + "）",
        pm: pm as Recipe["pm"], install, build, start: "PORT=" + PORT_GENERIC + " HOST=0.0.0.0 " + runScript(pm, pick, flags), port: PORT_GENERIC, heap: 700,
        ...(flags ? {} : { warn: "不确定这个服务会不会听 PORT 环境变量；起不来就是端口不对" }),
      };
    }
  }
  const dir = has("index.html") ? "." : has("public") ? "public" : has("dist") ? "dist" : "";
  if (dir && (dir === "." || !pkg || !Object.keys(scripts).length)) {
    return { how: "按目录猜的：静态文件，用静态服务器发 " + (dir === "." ? "仓库根目录" : dir + "/") + "（:" + PORT_GENERIC + "）", start: "python3 -m http.server " + PORT_GENERIC + " --bind 0.0.0.0 --directory " + dir, port: PORT_GENERIC };
  }
  return { how: "", none: pkg ? "package.json 里没有 dev、start、preview 这类能把网页跑起来的脚本" : "找不到能跑起来的网页（没有 package.json，也没有 index.html）" };
}

// ---------- GitHub: resolving what to check out ----------

export type Pull = { number: number; title: string; state: string; headRef: string; headSha: string; headRepo: string; baseRef: string; fork: boolean; url: string };
export function parsePull(j: any): Pull {
  if (!j || typeof j.number !== "number" || !j.head || !j.base) throw new Error("GitHub 返回的 PR 信息看不懂");
  const headRepo = String(j.head.repo?.full_name || ""), baseRepo = String(j.base.repo?.full_name || "");
  return {
    number: j.number, title: String(j.title || ""), state: j.merged_at ? "merged" : String(j.state || ""),
    headRef: String(j.head.ref || ""), headSha: String(j.head.sha || ""), headRepo, baseRef: String(j.base.ref || ""),
    fork: !!headRepo && !!baseRepo && headRepo !== baseRepo, url: String(j.html_url || ""),
  };
}
/** What git should fetch for a branch, tag, full ref or commit. */
export function refspecOf(ref: string) {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (ref.startsWith("refs/")) return ref;
  return "refs/heads/" + ref;
}
export const validRef = (ref: string) => /^[\w./-]{1,200}$/.test(ref) && !ref.includes("..") && !ref.startsWith("-") && !ref.endsWith(".lock");

const tokensOf = (env: any) => [env.GITHUB_TOKEN_2, env.GITHUB_TOKEN].filter(Boolean) as string[];
async function gh(env: any, path: string, raw = false): Promise<{ data: any; token: string }> {
  let status = 0;
  for (const token of [...tokensOf(env), ""]) {
    const r = await fetch("https://api.github.com" + path, {
      headers: { Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json", "User-Agent": "teamagent", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (r.ok) return { data: raw ? await r.text() : await r.json(), token };
    status = r.status;
    if (![401, 403, 404].includes(status)) break;
  }
  throw new Error(status === 404 ? "找不到这个仓库或分支（也可能没有访问权限）" : "GitHub 返回 " + status);
}

// ---------- shell commands ----------

export const q = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// Install scripts from a pull request run here; they must never see the GitHub token.
const CLEAN = "unset GH_TOKEN; set -o pipefail; ";

export type Target = { label: string; slot: string; refspec: string };
export function cloneCommand(full: string, t: Target) {
  const dir = ROOT + "/" + t.slot;
  return "rm -rf " + q(dir) + " && mkdir -p " + q(dir) + " && cd " + q(dir) + " && git init -q && " +
    // The token only travels as a one-off header: never in a URL, a remote or a config file.
    "H=(); [ -n \"$GH_TOKEN\" ] && H=(-c \"http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 -w0)\"); " +
    "git \"${H[@]}\" fetch -q --depth 1 " + q("https://github.com/" + full + ".git") + " " + q(t.refspec) + " && git checkout -q FETCH_HEAD && git log -1 --format='%h %s'";
}
/** Commands that turn a fresh checkout into a running server; the last one waits until the port answers. */
export function prepareCommands(full: string, t: Target, r: Recipe, waitSeconds = 90) {
  const dir = ROOT + "/" + t.slot, app = dir + (r.dir && r.dir !== "." ? "/" + r.dir : ""), log = ROOT + "/" + t.slot + ".log", pid = ROOT + "/" + t.slot + ".pid";
  const heap = r.heap || 512, serverHeap = r.serverHeap || Math.min(heap, 320);
  const at = (cmd: string, h = heap) => CLEAN + "export NODE_OPTIONS=--max-old-space-size=" + h + " && cd " + q(app) + " && " + cmd;
  const cmds = [stopCommand(), cloneCommand(full, t)];
  if (r.install) cmds.push(at("(" + r.install + ") 2>&1 | tail -25"));
  if (r.build) cmds.push(at("(" + r.build + ") 2>&1 | tail -30"));
  if (r.setup) cmds.push(at("(" + r.setup + ") 2>&1 | tail -10", serverHeap));
  cmds.push(at("curl -s -o /dev/null -m 2 http://127.0.0.1:" + r.port + "/ && { echo 'port " + r.port + " is taken by another program'; exit 1; }; " +
    // Launched from a subshell so this shell has no child left to wait for: with the server as its own child,
    // bash sat in wait() after `exit` and the container's exec never returned.
    "(setsid nohup bash -c " + q(r.start || "false") + " > " + q(log) + " 2>&1 < /dev/null & echo $! > " + q(pid) + "); " +
    "for i in $(seq 1 " + waitSeconds + "); do curl -s -o /dev/null -m 2 http://127.0.0.1:" + r.port + "/ && echo \"ready after ${i}s\" && exit 0; " +
    "kill -0 $(cat " + q(pid) + ") 2>/dev/null || break; sleep 1; done; echo 'server did not answer'; tail -c 2500 " + q(log) + "; exit 1", serverHeap));
  return cmds;
}
/** Stops every preview server and prints the end of one target's log. Process groups from the pid files go
 *  first; then anything still running inside the preview directory, which also catches a server whose run was
 *  cut off before it wrote or after it lost its pid file. */
export function stopCommand(logOf = "") {
  const sweep = (sig: string) => "for p in /proc/[0-9]*; do case \"$(readlink $p/cwd 2>/dev/null)\" in " + ROOT + "/*) kill -" + sig + " ${p#/proc/} 2>/dev/null;; esac; done; ";
  return "mkdir -p " + ROOT + " && for f in " + ROOT + "/*.pid; do [ -f \"$f\" ] && kill -TERM -- -$(cat \"$f\") 2>/dev/null; done; " + sweep("TERM") + "sleep 1; " +
    "for f in " + ROOT + "/*.pid; do [ -f \"$f\" ] && kill -KILL -- -$(cat \"$f\") 2>/dev/null; rm -f \"$f\"; done; " + sweep("KILL") +
    // Successful requests in an access log say nothing; keep errors, warnings and failed requests.
    (logOf ? "grep -v -E '\" [23][0-9][0-9] ' " + q(ROOT + "/" + logOf + ".log") + " 2>/dev/null | tail -n 30 | cut -c1-300; " : "") + "true";
}
const CLEANUP = "rm -rf " + ROOT;

// ---------- screenshots ----------

export type Device = "desktop" | "phone";
const VIEW: Record<Device, any> = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const CAP = { desktop: 3200, phone: 2400 };

export type Shot = { label: string; page: string; device: Device; bytes: Uint8Array; truncated: boolean; title: string };
export const devicesOf = (d: unknown): Device[] => d === "both" ? ["desktop", "phone"] : d === "phone" ? ["phone"] : ["desktop"];
export function normPages(p: unknown): string[] {
  const list = (Array.isArray(p) ? p : p ? [p] : ["/"]).map(x => String(x).trim()).filter(Boolean)
    .map(x => x.startsWith("#") ? "/" + x : x.startsWith("/") ? x : "/" + x);
  return [...new Set(list.length ? list : ["/"])].slice(0, MAX_PAGES);
}
/** Pairs for base-vs-PR: for each page and device, the base shot then the PR shot. */
export function pairShots(base: Shot[], head: Shot[]) {
  const out: { page: string; device: Device; base?: Shot; head?: Shot }[] = [];
  for (const h of head) out.push({ page: h.page, device: h.device, head: h, base: base.find(b => b.page === h.page && b.device === h.device) });
  for (const b of base) if (!out.some(o => o.page === b.page && o.device === b.device)) out.push({ page: b.page, device: b.device, base: b });
  return out;
}
export const deviceName = (d: Device) => d === "phone" ? "手机" : "电脑";

function b64(u: Uint8Array) {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
const dataUrl = (u: Uint8Array) => "data:image/jpeg;base64," + b64(u);
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));

type Browse = { tab: any; origin: string; errors: string[] };
/** One metered browser session whose requests to the Worker's own origin carry the preview token. */
export async function browserSession<T>(hub: Hub, token: string, work: (b: Browse) => Promise<T>): Promise<T> {
  if (!hub.plan.fits("browser_seconds", 60)) throw new Error("这个月无头浏览器的额度用到停止线了，下个周期才能再截图");
  const origin = new URL(hub.env.PUBLIC_URL || "https://teamagent.inkboard-server.workers.dev").origin;
  const started = Date.now();
  const browser = await puppeteer.launch(hub.env.BROWSER);
  try {
    const tab: any = await browser.newPage();
    const errors: string[] = [];
    // Only requests to our own origin get the header; a custom header on third-party requests (fonts, CDNs)
    // would trigger CORS preflights they refuse.
    await tab.setRequestInterception(true);
    tab.on("request", (r: any) => {
      const same = String(r.url()).startsWith(origin + "/");
      (same ? r.continue({ headers: { ...r.headers(), "x-preview": token } }) : r.continue()).catch(() => {});
    });
    tab.on("console", (m: any) => { if (m.type() === "error" && errors.length < 12) errors.push(String(m.text()).slice(0, 300)); });
    tab.on("pageerror", (e: any) => { if (errors.length < 12) errors.push("页面脚本出错：" + String(e?.message || e).slice(0, 300)); });
    return await work({ tab, origin, errors });
  } finally {
    await browser.close().catch(() => {});
    hub.plan.add("browser_seconds", (Date.now() - started) / 1000 + 1);
  }
}

async function login(b: Browse, logins: Login[], pages: string[], password: string) {
  const done: string[] = [];
  const need = logins.filter(l => pages.some(p => new RegExp(l.when).test(p)));
  if (!need.length) return done;
  await b.tab.goto(b.origin + "/", { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
  for (const l of need) {
    const body = JSON.stringify(Object.fromEntries(Object.entries(l.body).map(([k, v]) => [k, v.replace("{password}", password)])));
    const status = await b.tab.evaluate(async (ep: string, bodyText: string, key: string) => {
      const r = await fetch(ep, { method: "POST", headers: { "content-type": "application/json" }, body: bodyText });
      const j: any = await r.json().catch(() => ({}));
      if (j && j.token) localStorage.setItem(key, j.token);
      return r.status + (j && j.token ? "" : " 没拿到令牌");
    }, l.endpoint, body, l.key).catch((e: any) => "出错 " + String(e?.message || e).slice(0, 100));
    done.push(l.endpoint + " → " + status);
  }
  return done;
}

export async function capture(b: Browse, label: string, pages: string[], devices: Device[], deadline: number) {
  const shots: Shot[] = [], skipped: string[] = [];
  for (const device of devices) {
    await b.tab.setUserAgent(device === "phone" ? PHONE_UA : "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
    await b.tab.setViewport(VIEW[device]);
    for (const page of pages) {
      if (Date.now() > deadline - 15000) { skipped.push(page + "（" + deviceName(device) + "，时间不够了）"); continue; }
      // A blank page between captures makes hash routes load fresh instead of switching in place.
      await b.tab.goto("about:blank").catch(() => {});
      await b.tab.goto(b.origin + page, { waitUntil: "networkidle0", timeout: 25000 }).catch(() => {});
      await pause(900);
      const title = String(await b.tab.title().catch(() => ""));
      const h = Number(await b.tab.evaluate("Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)").catch(() => 0)) || VIEW[device].height;
      const height = Math.max(VIEW[device].height, Math.min(h, CAP[device]));
      const bytes = new Uint8Array(await b.tab.screenshot({ type: "jpeg", quality: 78, clip: { x: 0, y: 0, width: VIEW[device].width, height } }) as ArrayBuffer);
      shots.push({ label, page, device, bytes, truncated: h > CAP[device], title });
    }
  }
  return { shots, skipped };
}

/** Base and PR side by side in one picture, base on the left. Uses the session that is already open. */
async function compose(b: Browse, pair: { page: string; device: Device; base?: Shot; head?: Shot }) {
  const col = pair.device === "phone" ? 390 : 900;
  const cell = (s: Shot | undefined, name: string) => "<div class=c><div class=t>" + name + "</div>" + (s ? "<img src=\"" + dataUrl(s.bytes) + "\">" : "<div class=n>没截到</div>") + "</div>";
  const html = "<!doctype html><meta charset=utf-8><style>body{margin:0;background:#e9e9ee;font:600 18px 'Noto Sans CJK SC',sans-serif}" +
    ".w{display:flex;gap:16px;padding:16px;align-items:flex-start}.c{width:" + col + "px;background:#fff;border-radius:8px;overflow:hidden}" +
    ".t{padding:10px 14px;border-bottom:1px solid #ddd}img{width:100%;display:block}.n{padding:40px;color:#999}</style>" +
    "<div class=w>" + cell(pair.base, pair.base?.label || "原来") + cell(pair.head, pair.head?.label || "改动后") + "</div>";
  await b.tab.setViewport({ width: col * 2 + 48, height: 900, deviceScaleFactor: pair.device === "phone" ? 2 : 1 });
  await b.tab.setContent(html, { waitUntil: "load", timeout: 20000 }).catch(() => {});
  const h = Number(await b.tab.evaluate("document.body.scrollHeight").catch(() => 900)) || 900;
  return new Uint8Array(await b.tab.screenshot({ type: "jpeg", quality: 80, clip: { x: 0, y: 0, width: col * 2 + 48, height: Math.min(h, 4000) } }) as ArrayBuffer);
}

// ---------- the pipeline ----------

const stepName = (cmd: string) => cmd.includes("git init") ? "下载代码" : cmd.includes("setsid") ? "启动服务" : cmd.includes("seed") ? "写演示数据" : cmd.includes(" install") || cmd.includes("npm ci") ? "安装依赖" : cmd.includes("build") ? "打包" : cmd.includes("kill") ? "清理" : "命令";
const tailOf = (s: string, n: number) => s.length > n ? "…" + s.slice(-n) : s;
function summarize(r: ComputerResult) {
  return r.steps.filter(s => !s.command.includes("kill -TERM") || s.exit !== 0).map(s => ({ step: stepName(s.command), seconds: s.seconds, ok: s.exit === 0, ...(s.exit !== 0 ? { output: tailOf((s.stdout + "\n" + s.stderr).trim(), 1500) } : {}) }));
}

export type Run = { repo: string; pr?: number; ref?: string; pages: string[]; devices: Device[]; compare: boolean; deliver: boolean; login: boolean; minutes: number };
type Send = (bytes: Uint8Array, note: string, silent: boolean) => Promise<{ ok: boolean; id?: string; error?: string }>;

export async function preview(hub: Hub, run: Run, send: Send) {
  const started = Date.now(), deadline = started + run.minutes * 60000;
  const org = hub.env.GITHUB_ORG || "OmnixSI";
  const full = run.repo.includes("/") ? run.repo : org + "/" + run.repo, name = full.split("/")[1];
  const meta = await gh(hub.env, "/repos/" + full);
  const ghToken = meta.token;
  let targets: Target[], what: string, pull: Pull | null = null;
  if (run.pr) {
    pull = parsePull((await gh(hub.env, "/repos/" + full + "/pulls/" + run.pr)).data);
    const head: Target = { label: "PR #" + pull.number + "（" + pull.headRef + "）", slot: "pr" + pull.number, refspec: "refs/pull/" + pull.number + "/head" };
    targets = run.compare ? [{ label: "改之前（" + pull.baseRef + "）", slot: "base", refspec: refspecOf(pull.baseRef) }, head] : [head];
    what = "PR #" + pull.number + "「" + pull.title + "」";
  } else {
    const ref = run.ref || String(meta.data.default_branch || "main");
    targets = [{ label: ref, slot: "ref", refspec: refspecOf(ref) }];
    what = "分支 " + ref;
  }
  // The recipe comes from the code being previewed (a PR may add or change scripts).
  const at = encodeURIComponent(pull ? pull.headSha : targets[0].refspec.replace(/^refs\/heads\//, ""));
  let recipe = RECIPES[name];
  if (!recipe) {
    const list = await gh(hub.env, "/repos/" + full + "/contents?ref=" + at).catch(() => ({ data: [] as any[] }));
    const files = Array.isArray(list.data) ? list.data.map((f: any) => String(f.name)) : [];
    let pkg: any = null;
    if (files.includes("package.json")) pkg = await gh(hub.env, "/repos/" + full + "/contents/package.json?ref=" + at, true).then(r => JSON.parse(r.data)).catch(() => null);
    recipe = pickRecipe(name, files, pkg);
  }
  if (recipe.none) return { ok: false, repo: full, previewable: false, error: "这个仓库没法预览：" + recipe.none };

  const password = newToken().slice(0, 20);
  const env: Record<string, string> = { PREVIEW_PASSWORD: password, ...(ghToken ? { GH_TOKEN: ghToken } : {}) };
  const report: any[] = [], shotsBy: Shot[][] = [], errors: string[] = [];
  const pics: { pair: ReturnType<typeof pairShots>[number]; bytes: Uint8Array }[] = [];
  let logs = "", logins: string[] = [];
  const skipped: string[] = [];
  try {
    for (const t of targets) {
      const left = Math.floor((deadline - Date.now()) / 1000) - 45;
      if (left < 60) { report.push({ target: t.label, ok: false, error: "时间不够了，没跑" }); shotsBy.push([]); continue; }
      const r = await runComputer(hub, { commands: prepareCommands(full, t, recipe), env, timeoutSeconds: Math.min(left, 900) });
      const commit = r.steps.find(s => s.command.includes("git init"))?.stdout.trim() || "";
      report.push({ target: t.label, commit, ok: r.ok, ...(r.bootstrap_seconds ? { machine_boot_seconds: r.bootstrap_seconds } : {}), steps: summarize(r), ...(r.error ? { error: r.error } : {}) });
      if (!r.ok) { shotsBy.push([]); break; }
      const token = issueToken(hub, recipe.port!);
      const isLast = t === targets[targets.length - 1];
      try {
        const t0 = Date.now();
        const got = await browserSession(hub, token, async b => {
          if (run.login && recipe.login) logins = await login(b, recipe.login, run.pages, password);
          const c = await capture(b, t.label, run.pages, run.devices, deadline);
          errors.push(...b.errors.map(e => t.label + "：" + e));
          // Side-by-side pictures are made in the PR's session, so the base build never waits on an open browser.
          if (isLast && targets.length > 1) for (const pair of pairShots(shotsBy[0] || [], c.shots)) pics.push({ pair, bytes: await compose(b, pair) });
          return c;
        });
        report[report.length - 1].capture_seconds = Math.round((Date.now() - t0) / 1000);
        skipped.push(...got.skipped);
        shotsBy.push(got.shots);
      } finally { revokeToken(hub, token); }
      const stop = await runComputer(hub, { commands: [stopCommand(t.slot)], timeoutSeconds: 30 });
      logs = tailOf(stop.steps[0]?.stdout || "", 2500);
    }
  } finally {
    await runComputer(hub, { commands: [stopCommand(), CLEANUP], timeoutSeconds: 40 }).catch(() => {});
  }

  // Send: side-by-side pictures when comparing, otherwise every shot, in page order.
  const sent: string[] = [], images: string[] = [];
  const tag = full.split("/")[1] + " " + (pull ? "PR #" + pull.number : targets[0].label);
  if (pics.length) {
    for (const p of pics) {
      const note = tag + " " + p.pair.page + " " + deviceName(p.pair.device) + "：左边改之前，右边改之后";
      const r = await send(p.bytes, note, !run.deliver);
      sent.push((r.id || "") + " " + note);
      if (images.length < 4) images.push(dataUrl(p.bytes));
    }
  } else {
    for (const s of shotsBy.flat()) {
      const note = tag + " " + s.page + " " + deviceName(s.device) + (s.truncated ? "（页面太长，只截了上面一段）" : "");
      const r = await send(s.bytes, note, !run.deliver);
      sent.push((r.id || "") + " " + note);
      if (images.length < 4) images.push(dataUrl(s.bytes));
    }
  }
  const any = shotsBy.flat().length > 0;
  return {
    ok: any, repo: full, what, recipe: recipe.how, ...(recipe.warn ? { warning: recipe.warn } : {}),
    ...(pull ? { pr: { number: pull.number, title: pull.title, state: pull.state, head: pull.headRef, base: pull.baseRef, url: pull.url } } : {}),
    runs: report.map(r => ({ ...r })), ...(logins.length ? { login: logins } : {}),
    pictures: sent, ...(run.deliver ? {} : { note: "没发群里，图片编号在 pictures 里" }),
    ...(skipped.length ? { not_captured: skipped } : {}),
    ...(errors.length ? { page_errors: errors.slice(0, 12) } : {}),
    ...(logs ? { server_log_tail: logs } : {}),
    ...(recipe.routes ? { routes: recipe.routes } : {}),
    seconds: Math.round((Date.now() - started) / 1000),
    ...(any ? {} : { error: "没截到图：" + (report.find(r => !r.ok)?.steps?.find((s: any) => !s.ok)?.step || report.find(r => r.error)?.error || "服务没起来") + "那一步出了问题，详情见 runs" }),
    _images: images,
  };
}

/** Why a run may not start now, or "" when it may. */
export function refusal(hub: { plan: { fits(n: string, a?: number): boolean }; get(k: string): string | null }, now = Date.now()) {
  if (!hub.plan.fits("container_seconds", 900)) return "这个月云电脑的额度快到停止线了，预览一次要十几分钟的量，下个周期再用";
  if (!hub.plan.fits("browser_seconds", 60)) return "这个月无头浏览器的额度用到停止线了，下个周期才能截图";
  if (now - Number(hub.get("preview:busy") || 0) < LOCK_TTL) return "上一个预览还在跑（云电脑一次只能跑一个），等它跑完再来";
  return "";
}

const feature: Feature = {
  name: "preview",
  tunables: {
    preview_daily: { default: 8, min: 0, max: 40, what: "每天最多预览几次仓库的网页" },
    preview_minutes: { default: 8, min: 3, max: 15, what: "一次预览最多跑几分钟（装依赖、打包、截图加起来）" },
  },
  tools: ctx => [{
    name: "preview_app", work: true, slow: true, long: true,
    description: "在云电脑里把团队某个仓库的网页应用跑起来（某个分支，或某个 PR），用无头浏览器打开要看的页面截图发群里，大家不用拉代码就能看到界面改成了什么样。适合「看看 #44 改完长啥样」「PR 45 的设置页截个图」「对比一下改之前和之后」。给 pr 时会自动找到 PR 的分支；compare_with_base 填 true 会把 PR 的目标分支也跑一遍，同一页面左右拼在一张图里（左边改之前，右边改之后）。peiwan-club-saas 会先写入演示数据并用演示账号登录，页面路径用 /#/orders 这种（店铺后台）、/client.html#/me（客户端）、/platform.html#/shops（平台后台）。要几分钟，跑完会把截图发出来并返回每一步用时、服务器日志末尾、页面报错。桌面应用和要外部服务才能跑的仓库会直接说跑不了。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "仓库名，如 peiwan-club-saas、NextThought-Website；别的组织写 owner/name" },
        pr: { type: "integer", description: "PR 编号。和 ref 二选一" },
        ref: { type: "string", description: "分支名、标签或提交号；不填 pr 也不填 ref 就用默认分支" },
        pages: { type: "array", items: { type: "string" }, description: "要截图的页面路径，最多 6 个，默认 [\"/\"]。看 PR 改了哪些页面就填哪些，如 [\"/#/orders\", \"/#/settings\"]" },
        device: { type: "string", enum: ["desktop", "phone", "both"], description: "电脑（1440×900，默认）、手机（390×844）或两种都截" },
        compare_with_base: { type: "boolean", description: "给了 pr 时可填 true：PR 的目标分支也截同样的页面，左右拼图对比。时间差不多翻倍" },
        login: { type: "boolean", description: "默认 true：需要登录的应用先用演示账号登录。想看登录页本身时填 false" },
        deliver: { type: "boolean", description: "默认 true，截图直接发群里；false 只存下来返回编号" },
      },
      required: ["repo"],
    },
    run: async a => {
      const hub = ctx.hub, host = ctx.host;
      const repo = String(a.repo || "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
      if (!/^([\w.-]+\/)?[\w.-]+$/.test(repo)) return { ok: false, error: "仓库名看不懂，写成 peiwan-club-saas 或 owner/name" };
      const pr = a.pr === undefined || a.pr === null || a.pr === "" ? 0 : Number(String(a.pr).replace(/^#/, ""));
      if (pr && !(Number.isInteger(pr) && pr > 0)) return { ok: false, error: "PR 编号要是正整数" };
      const ref = a.ref ? String(a.ref).trim() : "";
      if (ref && !validRef(ref)) return { ok: false, error: "分支名看不懂" };
      const name = repo.split("/").pop()!;
      if (RECIPES[name]?.none) return { ok: false, previewable: false, error: "这个仓库没法预览：" + RECIPES[name].none };
      const why = refusal(hub);
      if (why) return { ok: false, error: why };
      if (!(await host.quota("preview", Number(host.cfg("preview_daily"))))) return { ok: false, error: "今天预览网页的次数用完了" };
      hub.set("preview:busy", String(Date.now()));
      try {
        return await preview(hub, {
          repo, pr: pr || undefined, ref: ref || undefined, pages: normPages(a.pages), devices: devicesOf(a.device),
          compare: !!pr && a.compare_with_base === true, deliver: a.deliver !== false, login: a.login !== false,
          minutes: Number(host.cfg("preview_minutes")) || 8,
        }, (bytes, note, silent) => host.sendImage(bytes, note, "image/jpeg", silent));
      } finally { hub.set("preview:busy", "0"); }
    },
  }],
  open: async (hub, req, url) => {
    if (!url.pathname.startsWith("/x/preview/")) return null;
    const p = stripPreview(url.pathname, url.search);
    const port = p ? checkToken(hub, p.token) : 0;
    if (!p || !port) return new Response("这个预览链接无效或已经过期", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
    try { return await forward(hub, req, port, p.path); }
    catch (e: any) { return new Response("预览服务没有响应：" + String(e?.message || e).slice(0, 200), { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } }); }
  },
  about: [
    "preview_app 能把团队仓库的网页应用（某个分支或某个 PR）在云电脑里跑起来，用无头浏览器截图发群里，大家不用拉代码就能看界面改动",
    "给 PR 时会自动找到它的分支；要对比时把目标分支也跑一遍，同一页面左右拼成一张图，左边改之前、右边改之后",
    "每个仓库有一份固定做法：陪玩店管家（peiwan-club-saas）先写演示数据、只打包前端，后端加前端一起起，再用演示店长账号登录截图；NextThought 官网是纯静态网站，直接发 public 目录；其他仓库按 package.json 里的 dev/start/preview 脚本猜",
    "NextThought（macOS 原生应用）和 TeamAgent（Bot 自己）没有网页可看；WhalePartner 只能看界面布局，后端起不来",
    "浏览器带着一次性的通行码经由 Bot 的网址访问云电脑里的服务，通行码 15 分钟后作废，别人拿不到",
    "云电脑只有 1 GB 内存，所以优先打包成静态文件再发，不开开发服务器；一次预览限时 8 分钟，每天默认最多 8 次",
    "装依赖时 GitHub 令牌已经从环境里拿掉，PR 里的安装脚本读不到它",
  ],
};
export default feature;
