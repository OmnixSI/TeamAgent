#!/usr/bin/env node
/**
 * SK-1: build-time generator for the self-knowledge card (src/self-card.generated.ts).
 *
 * Everything that can be read from code is read from code: the registered tool table
 * (real objects where they are exported, a strict literal parser for the inline
 * baseTools array in src/semantic.ts), each provider's host/model, the limit number,
 * D1 tables, wrangler crons/queues/bindings, worker entry lines and git HEAD.
 * The hand-written part is config/self-manifest.json, and this script *validates* it:
 * a missing file, a stale anchor, a pattern that no longer matches, a switch name that
 * appears nowhere, a registered tool no capability claims, or a tool that does not
 * exist -> non-zero exit, so a stale manifest cannot ship.
 *
 * Secret rule: only src/, runner/, scripts/, migrations/, config/team.json,
 * wrangler.toml, package.json, schema.sql are read. .env, .dev.vars and key files are
 * rejected by path. The output carries env var NAMES only; it is scanned for
 * token-shaped values and for the live values of secret-looking environment variables
 * before it is written.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf("--" + name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const argPath = (value, fallback) => (value ? (isAbsolute(value) ? value : resolve(ROOT, value)) : fallback);
const MANIFEST = argPath(flag("manifest"), join(ROOT, "config/self-manifest.json"));
const OUTPUT = argPath(flag("out"), join(ROOT, "src/self-card.generated.ts"));

/** Fail the build with a reason a human can act on. */
function fail(reason) {
  console.error("自知卡生成失败: " + reason);
  process.exit(1);
}

// ---------------------------------------------------------------- read policy

const ALLOWED_DIRS = ["src", "runner", "scripts", "migrations"];
const ALLOWED_FILES = [
  "config/team.json",
  "config/self-manifest.json",
  "wrangler.toml",
  "package.json",
  "schema.sql",
];
const SECRET_PATH =
  /(^|\/)(\.env|\.dev\.vars|\.prod\.vars|\.npmrc|\.netrc|id_rsa|id_ed25519|worker-secrets\.json)(\..*)?$|(^|\/)[^/]*(secret|credential)[^/]*\.(json|toml|txt|env)$|\.(pem|key|p12|pfx)$/i;

/** Reject anything that is not an allow-listed source path (no traversal, no keys). */
function assertReadable(rel, what) {
  if (typeof rel !== "string" || !rel.trim()) fail(`${what} 缺少路径`);
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) fail(`${what} 不许用绝对路径: ${rel}`);
  const clean = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  if (clean.split("/").includes("..")) fail(`${what} 不许越过仓库目录: ${rel}`);
  if (SECRET_PATH.test(clean)) fail(`${what} 指向密钥类文件，拒绝读取: ${rel}`);
  const allowed =
    ALLOWED_FILES.includes(clean) || ALLOWED_DIRS.some((dir) => clean.startsWith(dir + "/"));
  if (!allowed) fail(`${what} 不在可读范围（src/ runner/ scripts/ migrations/ config/team.json wrangler.toml package.json schema.sql）: ${rel}`);
  const full = resolve(ROOT, clean);
  if (!full.startsWith(ROOT + "/")) fail(`${what} 解析后不在仓库内: ${rel}`);
  return clean;
}

const textCache = new Map();
function read(rel, what = "清单文件") {
  const clean = assertReadable(rel, what);
  if (!textCache.has(clean)) {
    const full = join(ROOT, clean);
    if (!existsSync(full) || !statSync(full).isFile()) fail(`${what} 不存在: ${clean}`);
    textCache.set(clean, readFileSync(full, "utf8"));
  }
  return textCache.get(clean);
}

const CODE_EXT = new Set([".ts", ".mjs", ".js", ".py"]);
/** Generated bundles are build output, not evidence: never let them satisfy a check. */
const GENERATED_FILE = /\.generated\.(ts|js|mjs)$/;
function walk(relDir, out = []) {
  const full = join(ROOT, relDir);
  if (!existsSync(full)) return out;
  for (const name of readdirSync(full).sort()) {
    if (["node_modules", "__pycache__", "sdk", "skills"].includes(name)) continue;
    const rel = relDir + "/" + name;
    const stat = statSync(join(ROOT, rel));
    if (stat.isDirectory()) walk(rel, out);
    else if (CODE_EXT.has(name.slice(name.lastIndexOf("."))) && !GENERATED_FILE.test(name)) out.push(rel);
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

// ---------------------------------------------------------------- static sources

/** Real exported registries, bundled with the project's own esbuild. */
async function registries() {
  const dir = mkdtempSync(join(tmpdir(), "selfcard-reg-"));
  const outfile = join(dir, "registries.mjs");
  try {
    await build({
      stdin: {
        contents:
          'export {EXTRA_TOOLS} from "./src/tools/index"; export {repoTools} from "./src/repo";',
        resolveDir: ROOT,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile,
      logLevel: "silent",
    });
    return await import(pathToFileURL(outfile).href);
  } catch (error) {
    fail("打包 src/tools/index.ts 与 src/repo.ts 失败: " + (error?.message || error));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** baseTools is an inline const in src/semantic.ts (not exported): parse its literals. */
function baseTools() {
  const text = read("src/semantic.ts");
  const start = text.indexOf("const baseTools = [");
  const end = text.indexOf("const allTools = [");
  if (start < 0 || end < start) fail("src/semantic.ts 里找不到 baseTools 数组（结构变了就更新生成器）");
  const region = text.slice(start, end);
  const tools = [];
  const nameMatches = [...region.matchAll(/name: "([a-z][a-z0-9_]*)"/g)];
  if (!nameMatches.length) fail("baseTools 里没解析到任何工具名");
  for (const [index, match] of nameMatches.entries()) {
    const name = match[1];
    const next = nameMatches[index + 1]?.index ?? region.length;
    const chunk = region.slice(match.index, next);
    const descAt = chunk.indexOf("description:");
    const paramsAt = chunk.indexOf("parameters:", descAt);
    if (descAt < 0 || paramsAt < 0) fail(`baseTools 的 ${name} 没有 description/parameters`);
    const literals = [...chunk.slice(descAt, paramsAt).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => {
      try {
        return JSON.parse('"' + m[1] + '"');
      } catch {
        return m[1];
      }
    });
    const desc = firstSentence(literals.join(""));
    if (!desc) fail(`baseTools 的 ${name} 描述解析为空（生成器需要更新）`);
    tools.push({ name, desc, raw: literals.join("") });
  }
  return tools;
}

/** src/capability-card.ts owns which admin switch gates each JSON-schema tool. */
function toolSwitches() {
  const text = read("src/capability-card.ts");
  const at = text.indexOf("const TOOL_SWITCHES");
  const end = at >= 0 ? text.indexOf("};", at) : -1;
  if (at < 0 || end < 0) fail("src/capability-card.ts 里找不到 TOOL_SWITCHES（结构变了就更新生成器）");
  const map = new Map();
  for (const entry of text.slice(at, end).matchAll(/([a-z_]+):\s*\[([^\]]*)\]/g)) {
    const switchName = entry[1];
    for (const name of entry[2].matchAll(/"([a-z_]+)"/g)) if (!map.has(name[1])) map.set(name[1], switchName);
  }
  if (!map.has("repo_changes") || !map.has("generate_image"))
    fail("TOOL_SWITCHES 解析结果异常（至少要含 repo_changes 与 generate_image）");
  return map;
}

/** First sentence, mirroring src/capability-card.ts::firstSentence. */
function firstSentence(value) {
  const clean = String(value || "").replace(/\s+/g, " ").trim();
  const end = clean.indexOf("。");
  return (end < 0 ? clean : clean.slice(0, end)).trim();
}

// ---------------------------------------------------------------- manifest

function loadManifest() {
  if (!existsSync(MANIFEST)) fail("找不到清单: " + MANIFEST);
  let data;
  try {
    data = JSON.parse(readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    fail("清单不是合法 JSON: " + (error?.message || error));
  }
  const top = new Set(["capabilities", "vendors", "module_roles", "uncovered_ok"]);
  for (const key of Object.keys(data)) if (!top.has(key)) fail(`清单里有未知字段: ${key}`);
  if (!Array.isArray(data.capabilities) || !data.capabilities.length) fail("清单没有 capabilities");
  if (!Array.isArray(data.vendors) || !data.vendors.length) fail("清单没有 vendors");
  data.module_roles ??= {};
  data.uncovered_ok ??= [];
  if (!Array.isArray(data.uncovered_ok)) fail("uncovered_ok 必须是数组");
  return data;
}

const CAP_KEYS = new Set([
  "id", "title", "aliases", "tools", "how", "files", "providers",
  "switches", "requires_env", "runs_on", "local_component", "limit", "default_state",
]);

function str(value, what) {
  if (typeof value !== "string" || !value.trim()) fail(`${what} 必须是非空字符串`);
  return value;
}
function strArray(value, what) {
  if (!Array.isArray(value)) fail(`${what} 必须是数组`);
  for (const item of value) str(item, what + " 的一项");
  return value;
}

/** Resolve one manifest file+anchor to SelfRef with a real line number. */
function resolveRef(entry, capId) {
  const allowed = new Set(["path", "anchor", "role"]);
  for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`${capId}.files 里有未知字段: ${key}`);
  const path = assertReadable(entry.path, `${capId}.files`);
  const text = read(cleanPath(path), `${capId}.files`);
  const anchor = str(entry.anchor, `${capId}.files[${entry.path}].anchor`);
  let pattern;
  try {
    pattern = new RegExp(anchor);
  } catch {
    fail(`${capId}.files[${entry.path}].anchor 不是合法正则: ${anchor}`);
  }
  const match = pattern.exec(text);
  if (!match) fail(`${capId}.files[${entry.path}].anchor 在文件里没匹配到: ${anchor}`);
  return { path, line: lineOf(text, match.index), role: str(entry.role, `${capId}.files[${entry.path}].role`) };
}
const cleanPath = (rel) => rel.replace(/\\/g, "/").replace(/^\.\//, "");

/** Resolve one provider: patterns must match, and the card records the REAL string. */
function resolveProvider(entry, capId, vendors) {
  const allowed = new Set([
    "role", "vendor", "file", "host_pattern", "model_pattern", "host_file", "model_file", "evidence_pattern",
  ]);
  for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`${capId}.providers 里有未知字段: ${key}`);
  const role = str(entry.role, `${capId}.providers[].role`);
  const vendor = str(entry.vendor, `${capId}.providers[].vendor`);
  if (!vendors.has(vendor)) fail(`${capId} 的厂商 ${vendor} 没在 vendors 里登记`);
  const file = assertReadable(entry.file, `${capId}.providers[${vendor}].file`);
  const evidence = [];
  const provider = { role, vendor, evidence };
  const look = (kind, patternText, fileRel) => {
    const rel = assertReadable(fileRel || file, `${capId}.providers[${vendor}].${kind}`);
    const text = read(rel, `${capId}.providers[${vendor}].${kind}`);
    let pattern;
    try {
      pattern = new RegExp(patternText);
    } catch {
      fail(`${capId}.providers[${vendor}].${kind} 不是合法正则: ${patternText}`);
    }
    const match = pattern.exec(text);
    if (!match) fail(`${capId}.providers[${vendor}].${kind} 在 ${rel} 里没匹配到: ${patternText}`);
    evidence.push({ path: rel, line: lineOf(text, match.index) });
    return match[1] !== undefined ? match[1] : match[0];
  };
  if (entry.host_pattern) provider.host = look("host_pattern", entry.host_pattern, entry.host_file);
  if (entry.model_pattern) provider.model = look("model_pattern", entry.model_pattern, entry.model_file);
  if (entry.evidence_pattern) look("evidence_pattern", entry.evidence_pattern, entry.file);
  if (!evidence.length) evidence.push({ path: file, line: 1 });
  return provider;
}

function resolveLimit(entry, capId) {
  const allowed = new Set(["template", "file", "pattern"]);
  for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`${capId}.limit 里有未知字段: ${key}`);
  const full = read(assertReadable(entry.file, `${capId}.limit.file`), `${capId}.limit.file`);
  const template = str(entry.template, `${capId}.limit.template`);
  if (!template.includes("{n}")) fail(`${capId}.limit.template 必须用 {n} 表示数字: ${template}`);
  let pattern;
  try {
    pattern = new RegExp(entry.pattern);
  } catch {
    fail(`${capId}.limit.pattern 不是合法正则: ${entry.pattern}`);
  }
  const match = pattern.exec(full);
  if (!match) fail(`${capId}.limit.pattern 在 ${entry.file} 里没匹配到: ${entry.pattern}`);
  const number = match[1];
  if (!/^\d+$/.test(String(number))) fail(`${capId}.limit.pattern 的第一个捕获组必须是数字，实际: ${number}`);
  return template.replace("{n}", number);
}

/** Every switch must exist in code: off:<name>, a BotTool.switch, or a tool name. */
function validateSwitch(name, capId, srcCorpus, toolRows, registered) {
  const literal = "off:" + name;
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const known = new RegExp(escaped + "(?![A-Za-z0-9_])").test(srcCorpus) ||
    toolRows.some((t) => t.switch === name) || registered.includes(name);
  if (!known) fail(`${capId}.switches 里的 ${name} 在 src/ 里找不到（既无 "${literal}"，也不是工具名或 BotTool.switch）`);
}

function validateEnv(name, roots) {
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])${name}([^A-Za-z0-9_]|$)`);
  for (const corpus of roots) if (pattern.test(corpus)) return;
  fail(`环境变量 ${name} 在 src/ runner/ scripts/ 里找不到`);
}

// ---------------------------------------------------------------- repo map

const TOP_ROLES = {
  src: "Cloudflare Worker 主体（群聊处理、工具、D1）",
  runner: "本机常驻服务：QQ 网关、B站抓取、语音、文档解析、任务执行",
  scripts: "构建、迁移、部署与发布校验脚本",
  migrations: "D1 表结构迁移（按编号）",
  config: "团队配置、提示词与仓库白名单",
  test: "node:test / unittest 测试与真实数据夹具",
  web: "团队看板前端源码（构建进 src/ui.generated.ts）",
  docs: "设计、决策、运维与验收文档",
  shared: "前后端共享的拒绝路径清单",
  clients: "成员本机 CLI 与 MCP 客户端",
  ".github": "GitHub Actions 工作流（本仓库不以 CI 为上线门槛）",
};
const TOP_IGNORE = new Set(["node_modules", ".git", ".wrangler", ".agent", ".worktrees"]);
const MODULE_IGNORE = /(^|\/)(ui|self-card)\.generated\.ts$|(^|\/)test_/;

/** First /** *\/ or // comment (docstring for Python) in the file, first line. */
function moduleRole(rel, text) {
  const block = /\/\*\*([\s\S]*?)\*\//.exec(text);
  const line = /(?:^|\n)[ \t]*\/\/[ \t]*([^\n]+)/.exec(text);
  const py = /"""([\s\S]*?)"""/.exec(text);
  const candidates = [];
  if (block) candidates.push([block.index, block[1]]);
  if (line) candidates.push([line.index, line[1]]);
  if (py && rel.endsWith(".py")) candidates.push([py.index, py[1]]);
  candidates.sort((a, b) => a[0] - b[0]);
  for (const [, body] of candidates) {
    const firstLine = body
      .split("\n")
      .map((s) => s.replace(/^\s*\*+\s?/, "").trim())
      .find(Boolean);
    if (firstLine) return firstLine.replace(/\s+/g, " ").slice(0, 160);
  }
  return "";
}

function jsonArrayAfter(text, key) {
  const at = text.indexOf(key);
  if (at < 0) return [];
  const open = text.indexOf("[", at);
  const close = text.indexOf("]", open);
  if (open < 0 || close < 0) return [];
  return [...text.slice(open, close).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

function wranglerInfo() {
  const text = read("wrangler.toml");
  const crons = jsonArrayAfter(text, "crons =");
  const producers = [...text.matchAll(/\[\[queues\.producers\]\]([\s\S]*?)(?=\[\[|\n\[|$)/g)]
    .map((block) => block[1].match(/queue = "([^"]+)"/)?.[1])
    .filter(Boolean);
  const queues = [...new Set(producers)];
  const bindings = [...new Set([...text.matchAll(/^\s*binding = "([^"]+)"/gm)].map((m) => m[1]))];
  if (!bindings.length) fail("wrangler.toml 里没解析到任何 binding");
  return { crons, queues, bindings };
}

function tables() {
  const files = ["schema.sql", ...readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort().map((f) => "migrations/" + f)];
  const found = new Map();
  // Migrations are the incremental truth; schema.sql only fills in tables without one.
  for (const file of [...files.slice(1), files[0]]) {
    const text = read(file, "数据库表");
    for (const match of text.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      if (!found.has(match[1])) found.set(match[1], file);
    }
  }
  if (!found.has("messages")) fail("schema.sql + migrations 里没找到 messages 表");
  return [...found.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, migration]) => ({ name, migration }));
}

function repoMap(manifest) {
  const team = JSON.parse(read("config/team.json", "团队配置"));
  if (!Array.isArray(team.repositories) || !team.repositories.includes("OmnixSI/TeamAgent"))
    fail("config/team.json 的 repositories 里没有 OmnixSI/TeamAgent");

  const top_dirs = readdirSync(ROOT)
    .sort()
    .filter((name) => !TOP_IGNORE.has(name) && statSync(join(ROOT, name)).isDirectory())
    .map((name) => ({
      path: name,
      role: manifest.module_roles[name] || TOP_ROLES[name] || "（未说明）",
    }));

  const moduleFiles = [
    ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts")).map((f) => "src/" + f),
    ...readdirSync(join(ROOT, "src/tools")).filter((f) => f.endsWith(".ts")).map((f) => "src/tools/" + f),
    ...readdirSync(join(ROOT, "runner"))
      .filter((f) => /\.(mjs|js|py)$/.test(f))
      .map((f) => "runner/" + f),
  ]
    .filter((rel) => !MODULE_IGNORE.test(rel))
    .sort();
  const modules = moduleFiles.map((path) => {
    const text = read(path, "模块清单");
    const lines = text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
    const role = manifest.module_roles[path] || moduleRole(path, text) || "（无文件头注释）";
    return { path, role, lines };
  });
  for (const key of Object.keys(manifest.module_roles)) {
    const clean = cleanPath(key);
    if (!existsSync(join(ROOT, clean))) fail(`module_roles 里的 ${key} 不存在（陈旧清单）`);
  }

  const worker = read("src/worker.ts").split("\n");
  const entrypoints = [];
  for (const kind of ["fetch", "queue", "scheduled"]) {
    const at = worker.findIndex((line) => new RegExp(`^\\s*async ${kind}\\(`).test(line));
    if (at < 0) fail(`src/worker.ts 里找不到 async ${kind}（结构变了就更新生成器）`);
    entrypoints.push({ kind, path: "src/worker.ts", symbol: kind, line: at + 1 });
  }
  const runnerEntries = {
    "runner/qq-gateway.mjs": "QQ 网关常驻进程",
    "runner/fetcher.mjs": "B站抓取与登录",
    "runner/media.mjs": "音轨抽取与转写调度",
    "runner/bridge.py": "任务桥（领取/回填）",
    "runner/execute.py": "本机执行（dsh/CLI）",
    "runner/docread.py": "文档解析",
    "runner/xasr_transcribe.py": "X-ASR 转写",
    "runner/reload_runtime.py": "运行时重载",
  };
  for (const path of Object.keys(runnerEntries)) {
    if (!existsSync(join(ROOT, path))) fail(`runner 入口不存在: ${path}`);
    const text = read(path, "runner 入口");
    const mainAt = /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function main\(|(?:^|\n)\s*def main\(/.exec(text);
    const guardAt = /(?:^|\n)\s*if __name__ == ["']__main__["']/.exec(text);
    entrypoints.push({
      kind: "runner",
      path,
      ...(mainAt ? { symbol: "main", line: lineOf(text, mainAt.index + 1) } : { line: guardAt ? lineOf(text, guardAt.index + 1) : 1 }),
    });
  }
  for (const [path, role] of [
    ["scripts/deploy.mjs", "部署"],
    ["scripts/migrate.mjs", "数据库迁移"],
    ["scripts/verify-release.mjs", "发布校验"],
  ]) {
    if (!existsSync(join(ROOT, path))) fail(`部署脚本不存在: ${path}`);
    entrypoints.push({ kind: "script", path, symbol: role, line: 1 });
  }

  const { crons, queues, bindings } = wranglerInfo();
  return {
    repo: "OmnixSI/TeamAgent",
    top_dirs,
    modules,
    entrypoints,
    tables: tables(),
    crons,
    queues,
    bindings,
  };
}

// ---------------------------------------------------------------- capability card

function buildCard(manifest, api) {
  const registeredTools = [
    ...baseTools().map((t) => ({ name: t.name, desc: t.desc, gap: true })),
    ...api.repoTools.map((t) => ({
      name: (t.def || t).function.name,
      desc: firstSentence((t.def || t).function.description),
      gap: true,
    })),
    ...api.EXTRA_TOOLS.map((t) => ({ name: t.name, desc: firstSentence(t.def.function.description), switch: t.switch, extra: true })),
  ];
  const registered = registeredTools.map((t) => t.name);
  if (new Set(registered).size !== registered.length) fail("注册工具重名（生成器需要更新）");
  const switchMap = toolSwitches();
  // Explicit BotTool.switch first, then the project's own TOOL_SWITCHES mapping,
  // then the toolkit default (off:<tool name>) only for registry tools.
  const switchFor = (t) => t.switch || switchMap.get(t.name) || (t.extra ? t.name : undefined);
  const tools = registeredTools
    .map((t) => ({ name: t.name, desc: t.desc, ...(switchFor(t) ? { switch: switchFor(t) } : {}) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const tool of tools) if (!tool.desc) fail(`工具 ${tool.name} 的首句描述为空`);

  const vendors = new Map();
  const vendorRows = manifest.vendors.map((entry) => {
    const allowed = new Set(["vendor", "env_names", "key_location"]);
    for (const key of Object.keys(entry)) if (!allowed.has(key)) fail(`vendors 里有未知字段: ${key}`);
    const vendor = str(entry.vendor, "vendors[].vendor");
    if (vendors.has(vendor)) fail(`vendors 里重复: ${vendor}`);
    const env_names = strArray(entry.env_names ?? [], `vendors[${vendor}].env_names`);
    const key_location = str(entry.key_location, `vendors[${vendor}].key_location`);
    vendors.set(vendor, { vendor, used_for: [], env_names, key_location });
    return vendor;
  });

  const srcCorpus = walk("src").map((rel) => read(rel, "src 扫描")).join("\n");
  const envCorpus = [...walk("src"), ...walk("runner"), ...walk("scripts")].map((rel) => read(rel, "环境变量扫描")).join("\n");

  const capabilities = [];
  const seen = new Set();
  const claimed = new Set();
  for (const entry of manifest.capabilities) {
    for (const key of Object.keys(entry)) if (!CAP_KEYS.has(key)) fail(`能力 ${entry.id || "?"} 有未知字段: ${key}`);
    const id = str(entry.id, "capabilities[].id");
    if (!/^[a-z][a-z0-9_]*$/.test(id)) fail(`能力 id 必须是 snake_case: ${id}`);
    if (seen.has(id)) fail(`能力 id 重复: ${id}`);
    seen.add(id);
    const title = str(entry.title, `${id}.title`);
    const aliases = strArray(entry.aliases ?? [], `${id}.aliases`);
    const toolsFor = strArray(entry.tools ?? [], `${id}.tools`);
    for (const name of toolsFor) {
      if (!registered.includes(name)) fail(`${id}.tools 里的 ${name} 不是真实注册的工具`);
      if (claimed.has(name)) fail(`工具 ${name} 被多个能力重复登记`);
      claimed.add(name);
    }
    const how = str(entry.how, `${id}.how`);
    if (!Array.isArray(entry.files) || !entry.files.length) fail(`${id} 没有 files`);
    const files = entry.files.map((file) => resolveRef(file, id));
    const providers = (entry.providers ?? []).map((provider) => resolveProvider(provider, id, vendors));
    for (const provider of providers) vendors.get(provider.vendor).used_for.push(title);
    const switches = strArray(entry.switches ?? [], `${id}.switches`);
    for (const name of switches) validateSwitch(name, id, srcCorpus, tools, registered);
    const requires_env = strArray(entry.requires_env ?? [], `${id}.requires_env`);
    for (const name of requires_env) validateEnv(name, [envCorpus]);
    const runs_on = str(entry.runs_on, `${id}.runs_on`);
    if (!["cloud", "local", "both"].includes(runs_on)) fail(`${id}.runs_on 只能是 cloud|local|both`);
    const default_state = str(entry.default_state, `${id}.default_state`);
    if (!["on", "off_by_default"].includes(default_state)) fail(`${id}.default_state 只能是 on|off_by_default`);
    const capability = {
      id, title, aliases, tools: toolsFor, how, providers, files, switches, requires_env, runs_on,
      ...(entry.local_component ? { local_component: str(entry.local_component, `${id}.local_component`) } : {}),
      ...(entry.limit ? { limit: resolveLimit(entry.limit, id) } : {}),
      default_state,
    };
    capabilities.push(capability);
  }

  for (const name of manifest.uncovered_ok) {
    if (!registered.includes(name)) fail(`uncovered_ok 里的 ${name} 不是真实注册的工具`);
    if (claimed.has(name)) fail(`uncovered_ok 里的 ${name} 又被某个能力登记了，去掉一边`);
  }
  const missing = registered.filter((name) => !claimed.has(name) && !manifest.uncovered_ok.includes(name));
  if (missing.length) fail("这些已注册工具没有登记进任何能力，也没进 uncovered_ok: " + missing.join(", "));

  for (const vendor of vendorRows) {
    if (vendors.get(vendor).used_for.length === 0) fail(`vendors 里的 ${vendor} 没有任何能力在用（陈旧清单）`);
    for (const name of vendors.get(vendor).env_names) validateEnv(name, [envCorpus]);
  }
  for (const vendor of vendors.values()) vendor.used_for = [...new Set(vendor.used_for)];

  return {
    schema: 1,
    commit: gitHead(),
    built_at: new Date().toISOString(),
    capabilities,
    vendors: vendorRows.map((vendor) => vendors.get(vendor)),
    tools,
    repo_map: repoMap(manifest),
  };
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------- secret guard

const TOKEN_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abpr]-[A-Za-z0-9-]{10,}/,
  /(?:SESSDATA|bili_jct|DedeUserID__ckMd5|auth_token|ct0)=[^;\s"]+/,
];
function assertNoSecrets(output) {
  for (const pattern of TOKEN_SHAPES) {
    const match = pattern.exec(output);
    if (match) fail(`生成物里出现了像密钥的值（已被拦截，不打印）: ${pattern.source.slice(0, 24)}…`);
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (!/(KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)/i.test(name)) continue;
    if (typeof value !== "string" || value.length < 8) continue;
    if (output.includes(value)) fail(`生成物里出现了环境变量 ${name} 的值（已被拦截，不打印）`);
  }
  if (output.includes("/Users/")) fail("生成物里出现了本机绝对路径");
}

// ---------------------------------------------------------------- main

const api = await registries();
const manifest = loadManifest();
const card = buildCard(manifest, api);
const header = "// Generated by scripts/gen-self-card.mjs; edit config/self-manifest.json instead.\n";
const body =
  header +
  'import type { SelfCard } from "./self-card-types";\n\n' +
  "export const SELF_CARD: SelfCard = " +
  JSON.stringify(card, null, 2) +
  ";\n";
assertNoSecrets(body);
writeFileSync(OUTPUT, body);
console.log(`自知卡已生成: ${OUTPUT}（${card.capabilities.length} 个能力，${card.tools.length} 个工具，commit ${card.commit.slice(0, 7)}）`);
