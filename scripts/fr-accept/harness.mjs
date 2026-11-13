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
  e.__configPatch = opts.configPatch || null;
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

/** 直接调 src 里的函数时不经过 setupWith 的 worker bundle，必须自己带同一份 config patch。 */
function patchedTeamConfig(patch) {
  const base = JSON.parse(readFileSync(join(ROOT, "config/team.json"), "utf8"));
  for (const [key, value] of Object.entries(patch || {}))
    base[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? { ...(base[key] || {}), ...value }
        : value;
  return base;
}

export async function loadModule(rel, configPatch) {
  const tag = configPatch ? createHash("sha1").update(JSON.stringify(configPatch)).digest("hex").slice(0, 8) : "";
  const cacheKey = rel + "|" + tag;
  if (moduleCache.has(cacheKey)) return moduleCache.get(cacheKey);
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) throw pending(`${rel} 不存在（所属工作包未合入）`);
  const dir = join(ROOT, ".wrangler");
  mkdirSync(dir, { recursive: true });
  const outfile = join(dir, `fr-accept-${process.pid}-${rel.replace(/[^\w]+/g, "_")}${tag ? "-" + tag : ""}.mjs`);
  try {
    await build({
      entryPoints: [abs],
      bundle: true,
      format: "esm",
      platform: "browser",
      outfile,
      logLevel: "silent",
      ...(configPatch
        ? {
            plugins: [
              {
                name: "fr-accept-config-patch",
                setup(builder) {
                  builder.onLoad({ filter: /config\/team\.json$/ }, () => ({
                    contents: JSON.stringify(patchedTeamConfig(configPatch)),
                    loader: "json",
                  }));
                },
              },
            ],
          }
        : {}),
    });
  } catch (err) {
    throw pending(`${rel} 还不能单独打包（模块未就绪）：${String(err?.message || err).split("\n")[0]}`);
  }
  const mod = await import(pathToFileURL(outfile).href + `?v=${Date.now()}`);
  moduleCache.set(cacheKey, mod);
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

async function featureModule(e) {
  const mod = await loadModule("src/feature-request.ts", e?.__configPatch);
  if (typeof mod.createRequest !== "function")
    throw pending("src/feature-request.ts 未导出 createRequest（FR-2 未合入）");
  return mod;
}

/** FR-2 真实签名：createRequest(e, {source, sender_name, quote, title, detail, tainted}, {now?})。 */
export async function createRequest(e, input, options = {}) {
  const mod = await featureModule(e);
  return invoke("createRequest", () => mod.createRequest(e, input, options));
}

/** 夹具/合成消息 → createRequest 需要的 source。 */
export function sourceOf(msg) {
  let meta = {};
  try {
    meta = typeof msg.meta === "string" ? JSON.parse(msg.meta) : msg.meta || {};
  } catch {
    meta = {};
  }
  return {
    id: msg.id,
    group_id: msg.group_id,
    sender: msg.sender,
    body: msg.body,
    meta,
  };
}

export function senderNameOf(msg) {
  try {
    const meta = typeof msg.meta === "string" ? JSON.parse(msg.meta) : msg.meta || {};
    return meta.senderName || "Souvereign";
  } catch {
    return "Souvereign";
  }
}

/** FR-2 真实签名：authorizeFeature(quote, source, context, messages) → {ok, tainted, reason}。 */
export async function authorizeFeature(quote, msg, messages = [], extra = {}) {
  const mod = await loadModule("src/authz.ts");
  const fn = mod.authorizeFeature;
  if (typeof fn !== "function")
    throw pending("src/authz.ts 未导出 authorizeFeature（FR-2 未合入）");
  const source = sourceOf(msg);
  const context = {
    batch: [source],
    latest: source,
    names: new Map([[msg.sender, senderNameOf(msg)]]),
    ...extra,
  };
  return invoke("authorizeFeature", () => fn(quote, source, context, messages));
}

/** FR-3 的超时扫描：sweepFeatureRequests(e, now)。 */
export async function sweepStale(e, now = Date.now()) {
  const mod = await loadModule("src/feature-request-api.ts", e?.__configPatch);
  if (typeof mod.sweepFeatureRequests !== "function")
    throw pending("src/feature-request-api.ts 未导出 sweepFeatureRequests（FR-3 未合入）");
  await invoke("sweepFeatureRequests", () => mod.sweepFeatureRequests(e, now));
  return "sweepFeatureRequests";
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

/** 给工作室脚本用的 fetch：把 URL/init 直接交给本地 worker。 */
export async function fetchWorker(e, url, init) {
  return (e.testWorker || worker).fetch(new Request(url, init), e);
}

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
