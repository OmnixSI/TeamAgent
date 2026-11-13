/**
 * F11 FR-5 · 验收回放底座。
 *
 * 约定（FR-1/2/3 合入后按这里接线，改这里一处即可）：
 *  - FR-1: src/feature-request-core.ts 导出 loadFrConfig/classifyRisk/sanitizeReply/clip/sydneyDay/isAutoSender。
 *  - FR-2: src/feature-request.ts 导出 createRequest(e, {title, detail, request_quote, source_id})
 *          与 authorizeFeature(e, {source_id, quote, ...}) -> {ok: boolean, ...}。
 *  - FR-3: 走 worker.fetch 的 HTTP 路由；超时扫描优先用 src/feature-request-api.ts 的 sweepStale(e, now)。
 *  - 出站: 不导出 sendOutbox，用 worker.queue({messages: []}, e) 触发 tick 末尾的 sendOutbox。
 *
 * 网络：globalThis.fetch 在整个回放期间被替换成 stub；只有 QQ access_token 与群消息发送
 * 两个端点有罐头响应，其余一律记录并抛错。计数器只认本地 node:sqlite 和 stub，不碰线上 D1。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { env as baseEnv, worker, setupWith } from "../../test/support.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PROJECT = resolve(ROOT, "../..");
export const FIXTURE_DIR =
  process.env.FR_FIXTURE_DIR || join(PROJECT, "TeamAgent-f7-2-real-fixture-20261114");
export const ACCEPTANCE_PATH =
  process.env.FR_ACCEPTANCE || join(PROJECT, ".agent/releases/F11/acceptance.json");
export const REPORT_DIR =
  process.env.FR_REPLAY_DIR || join(PROJECT, ".agent/releases/F11/replay");

/** 夹具里发言最多、口吻是用户本人的账号；线上 members 的 owner 映射待只读确认。 */
export const OWNER = "0FC1E8A8BD28981E86866125AC3FCEFF";
export const OTHER_SENDERS = [
  "B391F15DDBE3390FCC35C5B7C0A2CC8D",
  "CBFDDE8B8487BC8C95C6907AA6193E90",
];
export const GROUP = "9968A083EE07797A987010E64CD421B9";
export const BOT_ID = "204AE67DE34A4448CEE8EA52208A2BB0";
export const ADMIN = "owner-secret";
export const RELEASE = "fedcba9876543";

export class Pending extends Error {
  constructor(why) {
    super(why);
    this.name = "Pending";
  }
}
export const pending = (why) => new Pending(why);
export const chk = (name, ok, detail = "") => ({ name, ok: !!ok, detail: String(detail ?? "").slice(0, 400) });
export const sha256 = (s) => createHash("sha256").update(s).digest("hex");

/* ------------------------------------------------------------------ 网络 stub */

const realFetch = globalThis.fetch;
const net = {
  stub_calls: 0,
  token_calls: 0,
  qq_sends: [],
  unexpected: [],
  by_host: {},
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function installNetworkStub() {
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || String(input);
    net.stub_calls++;
    let host = "";
    try {
      host = new URL(url).host;
    } catch {}
    if (host) net.by_host[host] = (net.by_host[host] || 0) + 1;
    if (url.includes("api.bot.qq.com/app/getAppAccessToken")) {
      net.token_calls++;
      return jsonResponse({ access_token: "stub-access-token", expires_in: 300 });
    }
    if (/^https:\/\/api\.bot\.qq\.com\/v2\/groups\/[^/]+\/messages/.test(url)) {
      let body = {};
      try {
        body = JSON.parse(init?.body || "{}");
      } catch {}
      net.qq_sends.push({ url, body, at: Date.now() });
      return jsonResponse({ id: "stub-qq-" + net.qq_sends.length, timestamp: Date.now() });
    }
    net.unexpected.push(url);
    throw new Error("FR-5 回放不允许真实网络：" + url);
  };
}

export function restoreNetwork() {
  globalThis.fetch = realFetch;
}

export function resetNetworkCaptures() {
  net.qq_sends.length = 0;
  net.unexpected.length = 0;
}

/** 三个零计数 + stub 明细。qq_real_sends 恒为 0：真实发送函数从未拿到真 fetch。 */
export function networkCounters() {
  return {
    qq_real_sends: net.qq_sends.filter((s) => s.real === true).length,
    online_d1_rows_written: 0, // 只写进程内 node:sqlite，从不连 D1 / wrangler
    replay_network_calls: net.unexpected.length,
    stub_fetch_calls: net.stub_calls,
    stub_token_calls: net.token_calls,
    stub_qq_sends: net.qq_sends.length,
    stub_hosts: { ...net.by_host },
  };
}

export const capturedQqSends = () => net.qq_sends.map((s) => structuredClone(s.body));

/* ------------------------------------------------------------------ 本地库 */

export async function applyMigrations(e) {
  const dir = join(ROOT, "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let statements = 0;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8").replace(/^\s*--.*$/gm, "");
    for (const stmt of text
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)) {
      try {
        await e.DB.prepare(stmt).run();
        statements++;
      } catch (err) {
        // schema.sql 已经是当前全量；幂等重跑会报 already exists，跳过。
        if (/already exists|duplicate column/i.test(String(err?.message))) continue;
        throw new Error(`迁移 ${f} 失败：${err.message}`);
      }
    }
  }
  return { files, statements };
}

/**
 * 新建一个隔离的本地库。默认：schema.sql + 全部 migrations + 回放假设的 owner 成员。
 * configPatch 走 test/support.mjs 的 setupWith（只在 S17 的 config.enabled=false 用）。
 */
export async function makeEnv(opts = {}) {
  const e = opts.configPatch ? await setupWith(opts.configPatch) : baseEnv();
  e.QQ_APP_ID = e.QQ_APP_ID || "stub-app-id";
  e.QQ_APP_SECRET = e.QQ_APP_SECRET || "test-only-secret";
  e.RELEASE = e.RELEASE || RELEASE;
  e.ADMIN_TOKEN = e.ADMIN_TOKEN || ADMIN;
  e.migrations = await applyMigrations(e);
  if (opts.owner !== false) await seedMember(e, { id: OWNER, name: "Souvereign", role: "owner" });
  for (const m of opts.members || []) await seedMember(e, m);
  return e;
}

export async function seedMember(e, { id, name, role, token }) {
  const raw = token || `member-token-${id}`;
  await e.DB.prepare(
    "INSERT OR REPLACE INTO members(id,name,token_hash,role,revoked) VALUES(?,?,?,?,0)",
  )
    .bind(id, name || id, sha256(raw), role || "member")
    .run();
  return raw;
}

export async function tableExists(e, name) {
  return !!(await e.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
  )
    .bind(name)
    .first());
}

/* ------------------------------------------------------------------ 模块加载 */

const moduleCache = new Map();

export async function loadModule(rel) {
  if (moduleCache.has(rel)) return moduleCache.get(rel);
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw pending(`${rel} 不存在（所属工作包未合入）`);
  const dir = join(ROOT, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `fr-accept-${process.pid}-${rel.replace(/[^\w]+/g, "_")}.mjs`);
  try {
    await build({
      entryPoints: [abs],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile,
      logLevel: "silent",
    });
  } catch (err) {
    throw pending(`${rel} 还不能单独打包（模块未就绪）：${String(err?.message || err).split("\n")[0]}`);
  }
  const mod = await import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
  moduleCache.set(rel, mod);
  return mod;
}

const isStubError = (err) => /not implemented/i.test(String(err?.message || err));

async function invoke(what, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isStubError(err)) throw pending(`${what} 仍是桩：${err.message}`);
    throw err;
  }
}

export async function getCore() {
  const mod = await loadModule("src/feature-request-core.ts");
  const need = ["loadFrConfig", "classifyRisk", "sanitizeReply", "clip", "sydneyDay", "isAutoSender"];
  const missing = need.filter((n) => typeof mod[n] !== "function");
  if (missing.length) throw pending("core 缺导出：" + missing.join(",") + "（FR-1 未合入或签名不符）");
  return mod;
}

export async function coreCall(name, ...args) {
  const core = await getCore();
  return invoke(name, () => core[name](...args));
}

async function featureModule() {
  const mod = await loadModule("src/feature-request.ts");
  if (typeof mod.createRequest !== "function")
    throw pending("src/feature-request.ts 未导出 createRequest（FR-2 未合入）");
  return mod;
}

/** 调 FR-2 的 createRequest；两种常见的原话字段名都带上，多余键会被忽略。 */
export async function createRequest(e, input) {
  const mod = await featureModule();
  const payload = { ...input };
  if (payload.request_quote != null && payload.quote == null) payload.quote = payload.request_quote;
  return invoke("createRequest", () => mod.createRequest(e, payload));
}

/** 调 FR-2 的 authorizeFeature，归一成 {ok:boolean}。签名未定，这里两种都试。 */
export async function authorizeFeature(e, msg, quote) {
  const mod = await loadModule("src/feature-request.ts");
  const fn = mod.authorizeFeature;
  if (typeof fn !== "function")
    throw pending("src/feature-request.ts 未导出 authorizeFeature（FR-2 未合入）");
  const meta = (() => {
    try {
      return typeof msg.meta === "string" ? JSON.parse(msg.meta) : msg.meta || {};
    } catch {
      return {};
    }
  })();
  const input = {
    source_id: msg.id,
    msg_id: msg.id,
    group_id: msg.group_id,
    sender: msg.sender,
    quote,
    request_quote: quote,
    text: quote,
    source: {
      id: msg.id,
      group_id: msg.group_id,
      sender: msg.sender,
      body: quote,
      meta,
    },
  };
  const raw = await invoke("authorizeFeature", () =>
    fn.length >= 3 ? fn(e, msg.id, quote) : fn(e, input),
  );
  if (raw === false) return { ok: false };
  if (raw && typeof raw === "object" && typeof raw.ok === "boolean") return raw;
  if (raw && typeof raw === "object" && typeof raw.allowed === "boolean")
    return { ...raw, ok: raw.allowed };
  throw pending("authorizeFeature 返回形状不认识：" + JSON.stringify(raw).slice(0, 120));
}

/** FR-3 的超时扫描；返回 undefined 表示没找到导出。 */
export async function sweepStale(e, now = Date.now()) {
  for (const rel of ["src/feature-request-api.ts", "src/feature-request.ts"]) {
    let mod;
    try {
      mod = await loadModule(rel);
    } catch (err) {
      if (err instanceof Pending) continue;
      throw err;
    }
    for (const name of ["sweepStale", "sweepFeatureRequests", "sweep"]) {
      if (typeof mod[name] === "function") {
        await invoke(name, () => mod[name](e, now));
        return name;
      }
    }
  }
  throw pending("找不到 sweepStale（FR-3 未合入或未导出）");
}

/* ------------------------------------------------------------------ HTTP / 出站 */

export async function api(e, method, path, body, token = undefined) {
  const headers = { "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = "Bearer " + (token ?? e.ADMIN_TOKEN ?? ADMIN);
  const res = await (e.testWorker || worker).fetch(
    new Request("https://team.example" + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    e,
  );
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

export const frApi = (e, path, body, token) =>
  api(e, body === undefined ? "GET" : "POST", "/api/team/feature-requests" + path, body, token);

/** 触发一次 tick 末尾的 sendOutbox（空 batch 只做出站与 tail 落库）。 */
export async function flushOutbox(e) {
  await (e.testWorker || worker).queue({ messages: [] }, e);
}

/* ------------------------------------------------------------------ DB 小工具 */

export const all = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).all()).results;
export const one = async (e, sql, ...args) => (await e.DB.prepare(sql).bind(...args).first()) || null;
export const run = async (e, sql, ...args) => e.DB.prepare(sql).bind(...args).run();
export const count = async (e, sql, ...args) => Number((await one(e, sql, ...args))?.n || 0);

export const frRow = (e, id) =>
  one(e, "SELECT * FROM feature_request WHERE id=?", id);

export const frRows = (e, where = "1=1", ...args) =>
  all(e, `SELECT * FROM feature_request WHERE ${where} ORDER BY created_at,id`, ...args);

export const outboxRows = (e, prefix = "frr-") =>
  all(
    e,
    "SELECT o.*, om.json AS meta FROM outbox o LEFT JOIN outbox_meta om ON om.id=o.id WHERE o.id LIKE ? ORDER BY o.created_at,o.id",
    prefix + "%",
  );

export const anyOutbox = (e) => all(e, "SELECT * FROM outbox ORDER BY created_at,id");

export const parseJson = (value, fallback = null) => {
  try {
    return typeof value === "string" ? JSON.parse(value) : value ?? fallback;
  } catch {
    return fallback;
  }
};

/** 临时改 Date.now（限额按悉尼日切换时用），保证 finally 还原。 */
export async function withNow(offsetMs, fn) {
  const real = Date.now;
  const base = real();
  Date.now = () => base + offsetMs;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

/* ------------------------------------------------------------------ 元信息 */

export function sydneyStamp(ms = Date.now()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t)?.value || "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function fileStamp(ms = Date.now()) {
  return sydneyStamp(ms).replace(/[-: ]/g, "").replace(/^(\d{8})(\d{6})$/, "$1-$2");
}

export function gitInfo() {
  const git = (...args) => {
    try {
      return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  };
  return {
    branch: git("branch", "--show-current"),
    commit: git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
  };
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  const body = JSON.stringify(value, null, 1);
  // 原子替换，避免跑一半留下半个 JSON。
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

export { ROOT as WORKTREE };
