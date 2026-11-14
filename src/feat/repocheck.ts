// Nightly health check of the team's repositories. Each one is cloned in the cloud computer, its own tests
// are run, and a compact result goes to a table the chat model can quote (daily digest, "do the tests pass?").
// The token reaches git only through the environment of the first command (GIT_CONFIG_* → http.extraHeader),
// is gone before any repository code runs, and never appears in a command text, a URL or a stored result.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { BJ, fmtDate, fmtFull, zonedToUtc } from "../util.ts";
import { allowed } from "./steward.ts";

export const DEFAULT_REPOS = ["TeamAgent", "peiwan-club-saas", "WhalePartner", "NextThought", "NextThought-Website"];
export const LIMITS = { total: 480, tail: 40, line: 200, keep: 60, summary: 14000, fresh: 7 * 86400000, since: 8 };
const WORK = "/work/repocheck";
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
/** What the nightly run may take of the plan's remaining CPU: the rest is for everything else the bot does. */
const CPU_SHARE = 0.6;

// ---------- recipes ----------
export type StepKind = "test" | "check" | "typecheck" | "lint" | "build" | "other";
export type StepDef = { id: string; cmd: string; kind: StepKind; limit: number; cpu: number; slow?: boolean };
export type Unit = { label: string; dir: string; install?: { cmd: string; limit: number; cpu: number }; steps: StepDef[] };
export type Recipe = { source: "table" | "package.json" | "pytest" | "none"; units: Unit[]; note?: string };

const PNPM = "command -v pnpm >/dev/null 2>&1 || npm i -g pnpm@12 --silent --no-fund --no-audit; ";
const NPM_CI = "npm ci --no-audit --no-fund";

export const TABLE: Record<string, Recipe> = {
  // `npm run check` is typecheck + tests; they run apart so each gets its own limit and counts.
  TeamAgent: { source: "table", units: [{ label: "bot", dir: ".", install: { cmd: NPM_CI, limit: 240, cpu: 45 }, steps: [
    { id: "typecheck", cmd: "npm run typecheck", kind: "typecheck", limit: 180, cpu: 35 },
    { id: "test", cmd: "npm test", kind: "test", limit: 180, cpu: 25 },
  ] }] },
  // The README's "73 tests" are the server's node:test suite; the web part only has a build.
  "peiwan-club-saas": { source: "table", units: [
    { label: "server", dir: ".", install: { cmd: PNPM + "pnpm install --frozen-lockfile --ignore-scripts --filter server...", limit: 150, cpu: 25 }, steps: [
      { id: "test", cmd: "pnpm --filter server test", kind: "test", limit: 180, cpu: 40 },
      { id: "typecheck", cmd: "pnpm --filter server typecheck", kind: "typecheck", limit: 150, cpu: 25 },
    ] },
    { label: "web", dir: ".", install: { cmd: PNPM + "pnpm install --frozen-lockfile --ignore-scripts --filter web...", limit: 200, cpu: 45 }, steps: [
      { id: "build", cmd: "pnpm --filter web build", kind: "build", limit: 240, cpu: 90, slow: true },
    ] },
  ] },
  // Two separate pnpm projects. The API wants Node 26; the cloud computer has 24, and a few process-group tests fail there.
  WhalePartner: { source: "table", units: [
    { label: "api", dir: "apps/api", install: { cmd: PNPM + "pnpm install --frozen-lockfile --ignore-scripts", limit: 200, cpu: 40 }, steps: [
      { id: "test", cmd: "pnpm test", kind: "test", limit: 300, cpu: 105 },
      { id: "typecheck", cmd: "pnpm run typecheck", kind: "typecheck", limit: 150, cpu: 33 },
    ] },
    { label: "client", dir: "apps/client", install: { cmd: PNPM + "pnpm install --frozen-lockfile --ignore-scripts", limit: 240, cpu: 50 }, steps: [
      { id: "test", cmd: "pnpm test", kind: "test", limit: 150, cpu: 15 },
      { id: "typecheck", cmd: "pnpm run typecheck", kind: "typecheck", limit: 150, cpu: 30 },
      { id: "build", cmd: "pnpm run build", kind: "build", limit: 240, cpu: 80, slow: true },
    ] },
  ] },
  // A macOS app: the Swift tests and the app build cannot run on Linux. The phone relay and the release-asset script can.
  NextThought: { source: "table", note: "Swift 部分（swift test、App 构建）要 macOS 和 Xcode，云电脑跑不了，没有检查", units: [
    { label: "relay", dir: "CompanionRelay", install: { cmd: NPM_CI, limit: 150, cpu: 20 }, steps: [
      { id: "test", cmd: "npm test", kind: "test", limit: 150, cpu: 20 },
    ] },
    { label: "assets", dir: ".", steps: [
      { id: "test", cmd: "python3 -m unittest discover -s Tools/Validation/ReleaseAssets -p 'test_*.py'", kind: "test", limit: 60, cpu: 3 },
    ] },
  ] },
  // No dependencies and no lockfile: plain node scripts.
  "NextThought-Website": { source: "table", units: [{ label: "site", dir: ".", steps: [
    { id: "check", cmd: "npm run check", kind: "check", limit: 120, cpu: 10 },
    { id: "build", cmd: "npm run build", kind: "build", limit: 120, cpu: 10 },
  ] }] },
};

export type Pkg = { path: string; scripts: Record<string, string>; workspaces?: boolean };
export type Manifest = { files: string[]; pkgs: Pkg[]; pytest: string[]; pyTests: number };

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
const inDir = (files: string[], dir: string, name: string) => files.includes(dir === "." ? name : dir + "/" + name);
const NO_TEST = /no test specified/i;
const SKIP_DIRS = /(^|\/)(node_modules|examples?|docs?|vendor|third_party|fixtures?)\//;

function pickScript(scripts: Record<string, string>, names: string[]) { return names.find(n => typeof scripts[n] === "string" && scripts[n].trim()); }

/** A recipe from what the repository contains: package.json scripts per directory, or pytest. */
export function genericRecipe(repo: string, m: Manifest): Recipe {
  const units: Unit[] = [], notes: string[] = [];
  let source: Recipe["source"] = "none";
  const rootLock = (name: string) => m.files.includes(name);
  for (const p of m.pkgs.filter(p => !SKIP_DIRS.test(p.path)).slice(0, 3)) {
    const dir = dirOf(p.path), s = p.scripts || {};
    const here = (n: string) => inDir(m.files, dir, n) || (dir !== "." && rootLock(n));
    const run = here("pnpm-lock.yaml") ? "pnpm run " : here("yarn.lock") ? "yarn " : "npm run ";
    const check = pickScript(s, ["check"]), test = pickScript(s, ["test", "test:unit", "tests"]), tc = pickScript(s, ["typecheck", "type-check", "check-types", "tsc"]), lint = pickScript(s, ["lint"]), build = pickScript(s, ["build"]);
    const steps: StepDef[] = [];
    const covered = (name: string | undefined, re: RegExp) => !!(check && name && re.test(s[check]) && check !== name);
    if (tc && !covered(tc, /typecheck|type-check|tsc/)) steps.push({ id: "typecheck", cmd: run + tc, kind: "typecheck", limit: 180, cpu: 35 });
    if (check) steps.push({ id: "check", cmd: run + check, kind: "check", limit: 240, cpu: 40 });
    if (test && !NO_TEST.test(s[test]) && !(check && /\btest\b/.test(s[check]))) steps.push({ id: "test", cmd: run + test, kind: "test", limit: 240, cpu: 40 });
    if (lint && !covered(lint, /lint/)) steps.push({ id: "lint", cmd: run + lint, kind: "lint", limit: 120, cpu: 15 });
    if (build) steps.push({ id: "build", cmd: run + build, kind: "build", limit: 240, cpu: 60, slow: true });
    if (!steps.length) continue;
    const hasDeps = m.files.some(f => /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f));
    let install: Unit["install"];
    if (here("package-lock.json")) install = { cmd: NPM_CI, limit: 240, cpu: 40 };
    else if (here("pnpm-lock.yaml")) install = { cmd: PNPM + "pnpm install --frozen-lockfile --ignore-scripts", limit: 240, cpu: 45 };
    else if (here("yarn.lock")) install = { cmd: "command -v yarn >/dev/null 2>&1 || npm i -g yarn@1 --silent; yarn install --frozen-lockfile --ignore-scripts", limit: 240, cpu: 45 };
    else if (here("bun.lock") || here("bun.lockb")) { notes.push(dir + " 用 bun，云电脑没装，没检查"); continue; }
    else if (!hasDeps) install = undefined;
    else install = { cmd: "npm install --no-audit --no-fund", limit: 240, cpu: 40 };
    units.push({ label: dir === "." ? repo : dir, dir, ...(install ? { install } : {}), steps });
    source = "package.json";
  }
  const hint = m.pytest[0];
  if (!units.length && (hint || m.pyTests > 0)) {
    const dir = hint ? dirOf(hint) : ".";
    const req = inDir(m.files, dir, "requirements.txt") ? " -r requirements.txt" : "";
    const proj = inDir(m.files, dir, "pyproject.toml") || inDir(m.files, dir, "setup.py") ? " && (VIRTUAL_ENV=\"$VENV\" uv pip install -q -e . || true)" : "";
    units.push({ label: dir === "." ? repo : dir, dir,
      install: { cmd: `uv venv -q "$VENV" && VIRTUAL_ENV="$VENV" uv pip install -q pytest${req}${proj}`, limit: 240, cpu: 30 },
      steps: [{ id: "test", cmd: '"$VENV/bin/python" -m pytest -q', kind: "test", limit: 240, cpu: 40 }] });
    source = "pytest";
  }
  return { source, units, ...(notes.length || !units.length ? { note: notes.concat(units.length ? [] : ["没认出怎么跑测试（没有可用的 package.json 脚本，也没有 pytest）"]).join("；") } : {}) };
}

/** The recipe for a repository: the table by name, else what the repository itself says. */
export function selectRecipe(repo: string, m: Manifest | null): Recipe {
  if (TABLE[repo]) return TABLE[repo];
  return genericRecipe(repo, m || { files: [], pkgs: [], pytest: [], pyTests: 0 });
}

// ---------- plan: which steps fit the CPU left ----------
const PRIORITY: Record<StepKind, number> = { test: 0, check: 0, typecheck: 1, lint: 1, other: 1, build: 2 };

/** CPU seconds one night may spend: a share of what is left of this cycle, spread over the days left. */
export function cpuAllowance(left: number, daysLeft: number, share = CPU_SHARE) {
  return Math.max(0, Math.floor((left / Math.max(1, daysLeft)) * share));
}

/** Keeps the steps that fit `budget` CPU seconds (tests first, builds last), and says why the others were dropped. */
export function planSteps(recipe: Recipe, o: { builds?: boolean; budget?: number }) {
  const budget = o.budget ?? Infinity;
  const cand: { u: number; s: number; prio: number }[] = [];
  const skipped: { id: string; why: string; kind: StepKind }[] = [];
  recipe.units.forEach((u, ui) => u.steps.forEach((st, si) => {
    if (st.slow && !o.builds) skipped.push({ id: u.label + ":" + st.id, kind: st.kind, why: "默认不跑构建（慢，吃 CPU）" });
    else cand.push({ u: ui, s: si, prio: PRIORITY[st.kind] ?? 1 });
  }));
  cand.sort((a, b) => a.prio - b.prio || a.u - b.u || a.s - b.s);
  let spent = 0;
  const keep = new Set<string>(), installed = new Set<number>();
  for (const c of cand) {
    const u = recipe.units[c.u], st = u.steps[c.s];
    const cost = st.cpu + (u.install && !installed.has(c.u) ? u.install.cpu : 0);
    if (spent + cost <= budget) { spent += cost; installed.add(c.u); keep.add(c.u + ":" + c.s); }
    else skipped.push({ id: u.label + ":" + st.id, kind: st.kind, why: "CPU 额度紧，这次没跑" });
  }
  const units: Unit[] = [];
  recipe.units.forEach((u, ui) => {
    const steps = u.steps.filter((_, si) => keep.has(ui + ":" + si));
    if (steps.length) units.push({ ...u, steps });
  });
  return { units, skipped, estimate: spent };
}

/** Seconds a step may run: its own limit, but never past the repository's overall deadline. */
export function boxSeconds(limit: number, deadlineLeft: number, reserve = 10) {
  const left = Math.floor(deadlineLeft);
  if (left < reserve) return 0;
  return Math.min(limit, left);
}

// ---------- shell scripts ----------
const q = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const EXT_LANG: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", js: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", jsx: "JavaScript",
  py: "Python", swift: "Swift", rs: "Rust", go: "Go", java: "Java", kt: "Kotlin", c: "C", h: "C", cpp: "C++", cc: "C++", cs: "C#",
  rb: "Ruby", sh: "Shell", html: "HTML", css: "CSS", scss: "CSS", vue: "Vue", svelte: "Svelte", sql: "SQL", md: "Markdown",
};
const EXT_RE = "\\.(" + Object.keys(EXT_LANG).join("|") + ")$";
const SKIP_RE = "(^|/)(vendor|node_modules|dist|third_party|Pods|\\.build)/|\\.min\\.|-lock\\.|\\.lock$";
/** Lines that carry a test count in any runner's output; the script keeps these even when they are far from the end. */
const SUM_RE = "^(ℹ|#) (tests|pass|fail|cancelled|skipped|todo) |^Tests:|^ +Tests +[0-9]|^Ran [0-9]+ test|^(OK|FAILED)( |$)|[0-9]+ (passed|failed|error)|no tests ran";
const ENV = [
  "CI=1", "NO_COLOR=1", "FORCE_COLOR=0", "ELECTRON_SKIP_BINARY_DOWNLOAD=1", "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1", "PUPPETEER_SKIP_DOWNLOAD=1",
  "CYPRESS_INSTALL_BINARY=0", "ONNXRUNTIME_NODE_INSTALL=skip", "HUSKY=0", "npm_config_fund=false", "npm_config_audit=false", "npm_config_update_notifier=false",
  "TAURI_SKIP_DEVSERVER_CHECK=true", "PIP_DISABLE_PIP_VERSION_CHECK=1",
  // The machine runs on UTC; some tests compare "today" with the team's calendar, which at 02:40 Beijing is still yesterday in UTC.
  "TZ=Asia/Shanghai",
].join(" ");
const CPU_FN = "cpu() { awk 'NR==1{print int(($2+$3+$4+$7+$8)/100)}' /proc/stat; }";

function safeName(repo: string) { if (!REPO_RE.test(repo)) throw new Error("仓库名不合法"); return repo; }

/** Script 1: clone, read the history, count lines, list what the repository contains. The token comes from GH_TOKEN. */
export function buildProbeScript(o: { org: string; repo: string; lastGood?: string }) {
  const repo = safeName(o.repo), org = safeName(o.org), lg = o.lastGood && SHA_RE.test(o.lastGood) ? o.lastGood : "";
  const dir = `${WORK}/${repo}`, out = `${WORK}/${repo}.a.txt`;
  return `set -u
export LANG=C.UTF-8 GIT_TERMINAL_PROMPT=0
mkdir -p ${WORK}; R=${q(dir)}; O=${q(out)}; rm -rf "$R" "$O"
# The header is built from the environment inside this shell and handed to git through its environment only.
auth() { if [ -n "\${GH_TOKEN:-}" ]; then GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.extraHeader GIT_CONFIG_VALUE_0="Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)" "$@"; else "$@"; fi; }
U=https://github.com/${org}/${repo}.git
S=$(date +%s)
if ! auth git clone -q --no-tags --single-branch --shallow-since='${LIMITS.since} days ago' "$U" "$R" 2>${q(WORK + "/" + repo + ".err")}; then
  rm -rf "$R"
  if ! auth git clone -q --no-tags --single-branch --depth 1 "$U" "$R" 2>${q(WORK + "/" + repo + ".err")}; then
    echo "@@ERR|clone|$(tail -n 2 ${q(WORK + "/" + repo + ".err")} | tr '\\n' ' ' | cut -c1-240)" > "$O"; rm -rf "$R"; exit 0
  fi
fi
cd "$R"
{
echo "@@CLONE|$(( $(date +%s) - S ))"
echo "@@HEAD|$(git log -1 --format='%H|%an|%at|%s' | cut -c1-300)"
echo "@@BRANCH|$(git rev-parse --abbrev-ref HEAD)"
echo "@@LOG24"; git log --since='24 hours ago' --no-merges --format='@@C|%h|%an|%at|%s' --shortstat | cut -c1-160
echo "@@LOG7"; git log --since='7 days ago' --no-merges --format='@@C|%h|%an|%at|%s' --shortstat | cut -c1-160
echo "@@BRANCHES|$(auth git ls-remote --heads origin 2>/dev/null | wc -l | tr -d ' ')"
echo "@@LOC"; git ls-files -z | grep -zE ${q(EXT_RE)} | grep -zvE ${q(SKIP_RE)} | xargs -0 wc -l 2>/dev/null | awk '{ n=$1; $1=""; sub(/^ /,""); if ($0=="total") next; k=split($0,a,"."); if (k>1) { e=tolower(a[k]); s[e]+=n; c[e]++ } } END { for (e in s) print e "|" s[e] "|" c[e] }'
echo "@@FILES"; git ls-files | grep -E '(^|/)(package\\.json|package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock|bun\\.lockb?|pyproject\\.toml|setup\\.py|setup\\.cfg|tox\\.ini|pytest\\.ini|conftest\\.py|requirements[^/]*\\.txt|Package\\.swift|Cargo\\.toml|go\\.mod|Makefile)$' | awk -F/ 'NF<=4' | head -80
for f in $(git ls-files | grep -E '(^|/)package\\.json$' | awk -F/ 'NF<=4' | head -8); do
  echo "@@PKG|$f|$(node -e 'const p=require(require("path").resolve(process.argv[1]));console.log(JSON.stringify({scripts:p.scripts||{},workspaces:!!p.workspaces}))' "$f" 2>/dev/null | cut -c1-3000)"
done
git ls-files | grep -E '(^|/)(pyproject\\.toml|setup\\.cfg|tox\\.ini|requirements[^/]*\\.txt)$' | awk -F/ 'NF<=3' | while read -r f; do grep -qi pytest "$f" && echo "@@HINT|pytest|$f"; done
echo "@@PYTESTS|$(git ls-files | grep -cE '(^|/)test_[^/]*\\.py$|_test\\.py$')"
${lg ? `if ! git cat-file -e '${lg}^{commit}' 2>/dev/null; then auth git fetch -q --no-tags --depth=300 origin 2>/dev/null; fi
if git cat-file -e '${lg}^{commit}' 2>/dev/null; then echo "@@SINCEGOOD"; git log --no-merges --format='@@C|%h|%an|%at|%s' '${lg}..HEAD' | head -30 | cut -c1-200; else echo "@@SINCEGOOD|missing"; fi` : ""}
echo "@@DISK|$(du -sm . | cut -f1)"
} > "$O" 2>/dev/null
exit 0
`;
}

/** Script 2: install and run the planned steps, each with its own limit inside the repository's overall one. No token here. */
export function buildRunScript(o: { repo: string; units: Unit[]; total?: number }) {
  const repo = safeName(o.repo), dir = `${WORK}/${repo}`, out = `${WORK}/${repo}.b.txt`, total = Math.max(30, Math.floor(o.total ?? LIMITS.total));
  const L: string[] = [];
  L.push(`set -u`, `export LANG=C.UTF-8 ${ENV}`,
    // The clone has served its purpose; nothing below may see the token.
    `unset GH_TOKEN GITHUB_TOKEN GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0`,
    `R=${q(dir)}; O=${q(out)}; T=${q(WORK + "/" + repo + ".step.txt")}; export VENV=${q(WORK + "/" + repo + ".venv")}`,
    `if [ ! -d "$R" ]; then echo "@@ERR|clone|克隆的目录不见了（云电脑中途休眠过？）" > "$O"; exit 0; fi`,
    `: > "$O"`, CPU_FN, `END=$(( $(date +%s) + ${total} )); C0=$(cpu); S0=$(date +%s)`,
    `skip() { printf '@@STEP|%s|skip|0|%s\\n@@END\\n' "$1" "$2" >> "$O"; }`,
    // step NAME DIR LIMIT CMD → runs CMD under timeout, keeps the tail and the lines that carry test counts; returns CMD's exit code
    `step() {`,
    `  local left lim s e code`,
    `  left=$(( END - $(date +%s) )); lim=$3`,
    `  if [ "$left" -lt 10 ]; then skip "$1" "总时限用完了"; return 99; fi`,
    `  [ "$lim" -gt "$left" ] && lim=$left`,
    `  s=$(date +%s)`,
    `  ( cd "$R/$2" && timeout -k 5 "$lim" bash -c "$4" ) > "$T" 2>&1; code=$?`,
    `  e=$(date +%s)`,
    `  { printf '@@STEP|%s|%s|%s|%s\\n' "$1" "$code" "$(( e - s ))" "$lim"; tail -n ${LIMITS.tail} "$T" | cut -c1-${LIMITS.line}; echo '@@SUM'; grep -aE ${q(SUM_RE)} "$T" | tail -n 12 | cut -c1-${LIMITS.line}; echo '@@END'; } >> "$O"`,
    `  return $code`,
    `}`);
  o.units.forEach((u, i) => {
    const body = u.steps.map(st => `  step ${q(u.label + ":" + st.id)} ${q(u.dir)} ${st.limit} ${q(st.cmd)}`).join("\n");
    if (u.install) {
      L.push(`if step ${q(u.label + ":install")} ${q(u.dir)} ${u.install.limit} ${q(u.install.cmd)}; then`, body, `else`,
        ...u.steps.map(st => `  skip ${q(u.label + ":" + st.id)} '安装没成功'`), `fi`);
    } else L.push(body.replace(/^ {2}/gm, ""));
    // The disk is 4 GB: free this unit's dependencies before the next one installs its own.
    if (i < o.units.length - 1) L.push(`find "$R/${u.dir === "." ? "" : u.dir.replace(/[^\w./-]/g, "")}" -maxdepth 2 -name node_modules -prune -exec rm -rf {} + 2>/dev/null`);
  });
  L.push(`echo "@@CPU|$(( $(cpu) - C0 ))|$(( $(date +%s) - S0 ))|$(du -sm "$R" 2>/dev/null | cut -f1)" >> "$O"`,
    `cd ${WORK} && rm -rf "$R" "$VENV" "$T" ${q(WORK + "/" + repo + ".err")}`, `exit 0`);
  return L.join("\n") + "\n";
}

export const cleanupScript = (repo: string) => `cd ${WORK} 2>/dev/null && rm -rf ${q(`${WORK}/${safeName(repo)}`)} ${q(`${WORK}/${repo}.venv`)} ${q(`${WORK}/${repo}.step.txt`)} ${q(`${WORK}/${repo}.err`)} ${q(`${WORK}/${repo}.a.txt`)} ${q(`${WORK}/${repo}.b.txt`)}; true`;

// ---------- parsing ----------
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

/** Removes anything that looks like the token (raw, as the Basic header, or a GitHub token shape). */
export function scrub(text: string, token?: string) {
  let t = text;
  if (token) {
    const basic = btoa("x-access-token:" + token);
    for (const secret of [token, basic]) if (secret.length >= 8) t = t.split(secret).join("***");
  }
  return t.replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "***");
}

export type Commits = { n: number; files: number; ins: number; del: number; authors: { name: string; n: number; ins: number; del: number }[]; list: { sha: string; author: string; at: number; subject: string }[] };

/** `git log --format='@@C|sha|author|unixtime|subject' --shortstat` → counts per author and totals. */
export function parseLog(text: string): Commits {
  const by = new Map<string, { name: string; n: number; ins: number; del: number }>();
  const out: Commits = { n: 0, files: 0, ins: 0, del: 0, authors: [], list: [] };
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@C|")) {
      const [, sha, author, at, ...rest] = line.split("|");
      cur = author || "?";
      if (!by.has(cur)) by.set(cur, { name: cur, n: 0, ins: 0, del: 0 });
      by.get(cur)!.n++;
      out.n++;
      out.list.push({ sha, author: cur, at: Number(at) * 1000, subject: rest.join("|") });
      continue;
    }
    const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(line);
    if (m && cur) {
      const f = Number(m[1]), i = Number(m[2] || 0), d = Number(m[3] || 0), a = by.get(cur)!;
      out.files += f; out.ins += i; out.del += d; a.ins += i; a.del += d;
    }
  }
  out.authors = [...by.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
  return out;
}

/** `ext|lines|files` lines → lines per language, biggest first. */
export function parseLoc(text: string) {
  const by: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [ext, n] = line.trim().split("|");
    const lang = EXT_LANG[(ext || "").toLowerCase()];
    if (lang && Number(n) > 0) by[lang] = (by[lang] || 0) + Number(n);
  }
  const sorted = Object.entries(by).sort((a, b) => b[1] - a[1]);
  return { by: Object.fromEntries(sorted) as Record<string, number>, total: sorted.reduce((s, [, n]) => s + n, 0) };
}

export type Counts = { n: number; p: number; f: number; s: number; runner: string };

/** Test counts from the lines a runner prints at the end: node:test (spec and TAP), vitest, jest, pytest, unittest. */
export function parseCounts(text: string): Counts | null {
  const t = stripAnsi(text), lines = t.split("\n");
  const last = (re: RegExp) => { let m: RegExpExecArray | null = null; for (const l of lines) { const x = re.exec(l); if (x) m = x; } return m; };
  const nodeNum = (name: string) => { const m = last(new RegExp("^(?:ℹ|#) " + name + " (\\d+)\\s*$")); return m ? Number(m[1]) : null; };
  const nt = nodeNum("tests");
  if (nt !== null) {
    const f = (nodeNum("fail") ?? 0) + (nodeNum("cancelled") ?? 0);
    return { n: nt, p: nodeNum("pass") ?? Math.max(0, nt - f), f, s: (nodeNum("skipped") ?? 0) + (nodeNum("todo") ?? 0), runner: "node:test" };
  }
  const words = (s: string) => { const o: Record<string, number> = {}; for (const m of s.matchAll(/(\d+) (passed|failed|skipped|errors?|xfailed|xpassed|todo|total)/g)) o[m[2].replace(/^errors$/, "error")] = (o[m[2]] || 0) + Number(m[1]); return o; };
  const jest = last(/^Tests:\s+(.*)$/);
  if (jest) {
    const w = words(jest[1]), n = w.total ?? (w.passed || 0) + (w.failed || 0) + (w.skipped || 0) + (w.todo || 0);
    return { n, p: w.passed || 0, f: w.failed || 0, s: (w.skipped || 0) + (w.todo || 0), runner: "jest" };
  }
  const vt = last(/^\s*Tests\s+(\d.*)$/);
  if (vt) {
    const w = words(vt[1]), paren = /\((\d+)\)\s*$/.exec(vt[1]);
    const n = paren ? Number(paren[1]) : (w.passed || 0) + (w.failed || 0) + (w.skipped || 0);
    return { n, p: w.passed || 0, f: w.failed || 0, s: (w.skipped || 0) + (w.todo || 0), runner: "vitest" };
  }
  const ut = last(/^Ran (\d+) tests? in /);
  if (ut) {
    const n = Number(ut[1]);
    const res = last(/^(OK|FAILED)\b(?: \((.*)\))?/), kv = (k: string) => Number(new RegExp(k + "=(\\d+)").exec(res?.[2] || "")?.[1] || 0);
    const f = res?.[1] === "FAILED" ? kv("failures") + kv("errors") : 0, s = kv("skipped");
    return { n, p: Math.max(0, n - f - s), f, s, runner: "unittest" };
  }
  const py = last(/^=*\s*((?:\d+ [a-z]+(?:, | )?)+(?:\([^)]*\))?)\s+in [\d.]+s\b.*$/i);
  if (py) {
    const w = words(py[1]), f = (w.failed || 0) + (w.error || 0), p = w.passed || 0, s = (w.skipped || 0) + (w.xfailed || 0);
    return { n: p + f + s + (w.xpassed || 0), p: p + (w.xpassed || 0), f, s, runner: "pytest" };
  }
  if (last(/no tests ran/i)) return { n: 0, p: 0, f: 0, s: 0, runner: "pytest" };
  return null;
}

/** The first lines worth showing from a failed step: test names marked as failed, else error-looking lines, else the last lines. */
export function failureLines(tail: string[], max = 6) {
  const lines = tail.map(l => stripAnsi(l).trimEnd()).filter(Boolean);
  const names: string[] = [];
  for (const l of lines) if (/^\s*(✖|✗|×)\s/.test(l) && !/failing tests?:?\s*$/i.test(l) && !names.includes(l.trim())) names.push(l.trim());
  if (names.length) return names.slice(0, max);
  const errs = lines.filter(l => /^(FAILED|FAIL\b|not ok|E\s{2,}|npm ERR!|ERR_PNPM|.*\berror TS\d+|.*(AssertionError|Error:))/.test(l.trim()));
  if (errs.length) return [...new Set(errs.map(l => l.trim()))].slice(0, max);
  return lines.slice(-max);
}

export type Probe = {
  err?: string; clone?: number; head?: { sha: string; author: string; at: number; msg: string }; branch?: string;
  c24: Commits; c7: Commits; branches?: number; loc: ReturnType<typeof parseLoc>; manifest: Manifest;
  sinceGood?: Commits | "missing"; diskMb?: number;
};

/** Everything script 1 wrote. */
export function parseProbe(text: string): Probe {
  const sections: Record<string, string[]> = {}, single: Record<string, string> = {}, pkgs: Pkg[] = [], pytest: string[] = [];
  let cur = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@C|")) { (sections[cur] ||= []).push(line); continue; }
    const m = /^@@([A-Z0-9]+)(?:\|(.*))?$/.exec(line);
    if (m) {
      cur = m[1];
      if (m[2] !== undefined) {
        if (cur === "PKG") {
          const i = m[2].indexOf("|");
          try { const j = JSON.parse(m[2].slice(i + 1)); pkgs.push({ path: m[2].slice(0, i), scripts: j.scripts || {}, workspaces: !!j.workspaces }); } catch { pkgs.push({ path: m[2].slice(0, i), scripts: {} }); }
        } else if (cur === "HINT") { const [, f] = m[2].split("|"); if (f) pytest.push(f); }
        else single[cur] = m[2];
      } else sections[cur] = sections[cur] || [];
      continue;
    }
    if (cur) (sections[cur] ||= []).push(line);
  }
  if (single.ERR !== undefined) return { err: single.ERR.replace(/^clone\|/, "克隆失败：") || "克隆失败", c24: parseLog(""), c7: parseLog(""), loc: parseLoc(""), manifest: { files: [], pkgs: [], pytest: [], pyTests: 0 } };
  const h = (single.HEAD || "").split("|");
  const out: Probe = {
    ...(single.CLONE ? { clone: Number(single.CLONE) } : {}),
    ...(h[0] ? { head: { sha: h[0], author: h[1] || "", at: Number(h[2] || 0) * 1000, msg: h.slice(3).join("|") } } : {}),
    ...(single.BRANCH ? { branch: single.BRANCH } : {}),
    c24: parseLog((sections.LOG24 || []).join("\n")), c7: parseLog((sections.LOG7 || []).join("\n")),
    ...(single.BRANCHES !== undefined ? { branches: Number(single.BRANCHES) } : {}),
    loc: parseLoc((sections.LOC || []).join("\n")),
    manifest: { files: (sections.FILES || []).filter(Boolean), pkgs, pytest, pyTests: Number(single.PYTESTS || 0) },
    ...(single.DISK ? { diskMb: Number(single.DISK) } : {}),
  };
  if (single.SINCEGOOD === "missing") out.sinceGood = "missing";
  else if (sections.SINCEGOOD) out.sinceGood = parseLog(sections.SINCEGOOD.join("\n"));
  return out;
}

export type RunStep = { name: string; code: string; secs: number; note: string; tail: string[]; sum: string[] };
/** Everything script 2 wrote. */
export function parseRun(text: string): { steps: RunStep[]; cpu?: number; wall?: number; mb?: number; err?: string } {
  const steps: RunStep[] = [];
  let cur: RunStep | null = null, mode: "tail" | "sum" = "tail";
  const out: ReturnType<typeof parseRun> = { steps };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("@@STEP|")) { const [, name, code, secs, ...note] = line.split("|"); cur = { name, code, secs: Number(secs) || 0, note: note.join("|"), tail: [], sum: [] }; mode = "tail"; steps.push(cur); continue; }
    if (line === "@@SUM") { mode = "sum"; continue; }
    if (line === "@@END") { cur = null; continue; }
    if (line.startsWith("@@ERR|")) { out.err = line.split("|").slice(2).join("|"); continue; }
    if (line.startsWith("@@CPU|")) { const [, cpu, wall, mb] = line.split("|"); out.cpu = Number(cpu); out.wall = Number(wall); if (mb) out.mb = Number(mb); continue; }
    if (cur) cur[mode].push(line);
  }
  return out;
}

// ---------- summary ----------
export type StepRes = {
  id: string; k: StepKind; s: "pass" | "fail" | "timeout" | "skip"; t: number;
  c?: { n: number; p: number; f: number; s: number; runner: string }; x?: string; tail?: string[];
};
export type Summary = {
  v: 1; repo: string; sha?: string; head?: { msg: string; author: string; at: number }; branch?: string;
  src: Recipe["source"]; builds: boolean; steps: StepRes[]; note?: string; err?: string;
  c24?: { n: number; files: number; ins: number; del: number; au: { name: string; n: number; ins: number; del: number }[] };
  c7?: { n: number; files: number; ins: number; del: number; au: { name: string; n: number; ins: number; del: number }[] };
  br?: number; loc?: { by: Record<string, number>; total: number };
  good?: { sha: string; ts: number; since: { sha: string; author: string; subject: string }[] | "missing" };
  cpu?: number; wall?: number; carried?: { from: number }; boxed?: number;
};

const trimLines = (lines: string[], n = LIMITS.tail) => lines.map(l => stripAnsi(l).replace(/\s+$/, "").slice(0, LIMITS.line)).filter((l, i, a) => l || (i > 0 && a[i - 1])).slice(-n);

/** One step's result from what script 2 printed (or from the plan, when it never ran). */
export function stepResult(id: string, kind: StepKind, r: RunStep | undefined, token?: string): StepRes {
  if (!r) return { id, k: kind, s: "skip", t: 0, x: "没有结果" };
  const secs = r.secs;
  if (r.code === "skip") return { id, k: kind, s: "skip", t: 0, x: r.note };
  const code = Number(r.code), s: StepRes["s"] = code === 0 ? "pass" : code === 124 || code === 137 ? "timeout" : "fail";
  const counts = parseCounts(r.sum.join("\n") + "\n" + r.tail.join("\n"));
  return {
    id, k: kind, s, t: secs, ...(counts && (kind === "test" || kind === "check") ? { c: counts } : {}),
    ...(s === "timeout" ? { x: "超过 " + (Number(r.note) || secs) + " 秒被停掉" } : {}),
    ...(s !== "pass" ? { tail: trimLines(scrub(r.tail.join("\n"), token).split("\n")) } : {}),
  };
}

/** 1 = everything that ran passed (and the tests ran), 0 = something failed, null = could not tell. */
export function judge(steps: StepRes[], err?: string): 1 | 0 | null {
  if (err) return null;
  const ran = steps.filter(s => s.s !== "skip");
  if (ran.some(s => s.s === "fail")) return 0;
  if (!ran.length || ran.some(s => s.s === "timeout")) return null;
  const wantTests = steps.some(s => s.k === "test" || s.k === "check");
  if (wantTests && !ran.some(s => (s.k === "test" || s.k === "check") && s.s === "pass")) return null;
  return 1;
}

/** Keeps the stored summary under the size cap by dropping the least useful parts first. */
export function trimSummary(s: Summary, cap = LIMITS.summary): Summary {
  const size = () => JSON.stringify(s).length;
  if (size() <= cap) return s;
  const pass = s.steps.filter(x => x.s === "pass" && x.tail);
  for (const x of pass) delete x.tail;
  for (const keep of [20, 10, 5]) {
    if (size() <= cap) break;
    for (const x of s.steps) if (x.tail && x.tail.length > keep) x.tail = x.tail.slice(-keep);
  }
  if (size() > cap) { if (s.c24) s.c24.au = s.c24.au.slice(0, 5); if (s.c7) s.c7.au = s.c7.au.slice(0, 8); }
  if (size() > cap && s.good && Array.isArray(s.good.since)) s.good.since = s.good.since.slice(0, 5);
  if (size() > cap) for (const x of s.steps) delete x.tail;
  return s;
}

const commitsOut = (c: Commits) => ({ n: c.n, files: c.files, ins: c.ins, del: c.del, au: c.authors.slice(0, 8) });

export function buildSummary(o: {
  repo: string; probe: Probe; recipe: Recipe; plan: ReturnType<typeof planSteps>; run?: ReturnType<typeof parseRun>; builds: boolean; token?: string; lastGood?: { sha: string; ts: number }; err?: string;
}): Summary {
  const { probe, recipe, plan, run } = o;
  const steps: StepRes[] = [];
  for (const u of recipe.units) {
    const planned = plan.units.find(p => p.label === u.label);
    if (planned?.install) steps.push(stepResult(u.label + ":install", "other", run?.steps.find(r => r.name === u.label + ":install"), o.token));
    for (const st of u.steps) {
      const id = u.label + ":" + st.id, drop = plan.skipped.find(x => x.id === id);
      if (drop) steps.push({ id, k: st.kind, s: "skip", t: 0, x: drop.why });
      else steps.push(stepResult(id, st.kind, run?.steps.find(r => r.name === id), o.token));
    }
  }
  const err = o.err || probe.err || run?.err;
  const sum: Summary = {
    v: 1, repo: o.repo, ...(probe.head ? { sha: probe.head.sha, head: { msg: probe.head.msg.slice(0, 160), author: probe.head.author, at: probe.head.at } } : {}),
    ...(probe.branch ? { branch: probe.branch } : {}), src: recipe.source, builds: o.builds, steps,
    ...(recipe.note ? { note: recipe.note } : {}), ...(err ? { err } : {}),
    c24: commitsOut(probe.c24), c7: commitsOut(probe.c7), ...(probe.branches !== undefined ? { br: probe.branches } : {}),
    loc: probe.loc, ...(run?.cpu !== undefined ? { cpu: run.cpu } : {}), ...(run?.wall !== undefined ? { wall: run.wall } : {}),
  };
  if (o.lastGood && probe.sinceGood) {
    sum.good = { sha: o.lastGood.sha, ts: o.lastGood.ts, since: probe.sinceGood === "missing" ? "missing" : probe.sinceGood.list.slice(0, 8).map(c => ({ sha: c.sha, author: c.author, subject: c.subject.slice(0, 100) })) };
  }
  return trimSummary(sum);
}

// ---------- storage ----------
export type Row = { id: number; repo: string; ts: number; sha: string | null; ok: number | null; summary: Summary };

const SCHEMA = `CREATE TABLE IF NOT EXISTS repocheck(id INTEGER PRIMARY KEY AUTOINCREMENT, repo TEXT NOT NULL, ts INTEGER NOT NULL, sha TEXT, ok INTEGER, summary TEXT);
CREATE INDEX IF NOT EXISTS repocheck_repo ON repocheck(repo, id);`;

const toRow = (r: any): Row => { let summary: Summary; try { summary = JSON.parse(String(r.summary)); } catch { summary = { v: 1, repo: String(r.repo), src: "none", builds: false, steps: [], err: "记录损坏" }; } return { id: Number(r.id), repo: String(r.repo), ts: Number(r.ts), sha: r.sha ?? null, ok: r.ok === null || r.ok === undefined ? null : Number(r.ok), summary }; };

export function saveRow(hub: Hub, repo: string, ts: number, sha: string | null, ok: number | null, summary: Summary): number {
  hub.sql.exec("INSERT INTO repocheck(repo, ts, sha, ok, summary) VALUES(?,?,?,?,?)", repo, ts, sha, ok, JSON.stringify(summary));
  const id = Number(hub.sql.exec("SELECT MAX(id) AS id FROM repocheck WHERE repo=?", repo).toArray()[0].id);
  hub.sql.exec("DELETE FROM repocheck WHERE repo=? AND id NOT IN (SELECT id FROM repocheck WHERE repo=? ORDER BY id DESC LIMIT ?)", repo, repo, LIMITS.keep);
  return id;
}
export const recentRows = (hub: Hub, repo: string, n = LIMITS.keep): Row[] => hub.sql.exec("SELECT * FROM repocheck WHERE repo=? ORDER BY id DESC LIMIT ?", repo, n).toArray().map(toRow);
export const storedRepos = (hub: Hub): string[] => hub.sql.exec("SELECT DISTINCT repo FROM repocheck ORDER BY repo").toArray().map((r: any) => String(r.repo));

export function listRepos(hub: Hub): string[] {
  try { const l = JSON.parse(hub.get("repocheck:repos") || "null"); if (Array.isArray(l) && l.length) return l.map(String).filter(r => REPO_RE.test(r)); } catch {}
  return DEFAULT_REPOS.slice();
}

// ---------- change detection ----------
/** The current stretch of failures: its first failing row and the last passing row before it (rows newest first; rows that could not tell are skipped). */
export function episode(rows: Row[]) {
  const known = rows.filter(r => r.ok !== null);
  if (!known.length || known[0].ok !== 0) return null;
  let i = 0;
  while (i + 1 < known.length && known[i + 1].ok === 0) i++;
  return { first: known[i], good: known[i + 1]?.ok === 1 ? known[i + 1] : null, last: known[0] };
}

/** Passing → failing that has not been told yet; null for steady states, first-ever failures and ones already announced. */
export function pendingAnnouncement(rows: Row[], toldId: number) {
  const ep = episode(rows);
  if (!ep || !ep.good || ep.first.id === toldId) return null;
  return ep;
}

const verdictText = (ok: number | null) => (ok === 1 ? "通过" : ok === 0 ? "没通过" : "没跑成");
const stepName = (id: string) => id.replace(/:install$/, " 装依赖").replace(/:test$/, " 测试").replace(/:typecheck$/, " 类型检查").replace(/:check$/, " 检查").replace(/:build$/, " 构建").replace(/:lint$/, " 代码规范");
export const countText = (c: { n: number; p: number; f: number; s: number }) => c.p + " 通过" + (c.f ? "、" + c.f + " 失败" : "") + (c.s ? "、" + c.s + " 跳过" : "") + "（共 " + c.n + "）";
const stepLine = (s: StepRes) => stepName(s.id) + (s.s === "pass" ? "过了" : s.s === "fail" ? "没过" : s.s === "timeout" ? "超时" : "没跑") + (s.c ? "，" + countText(s.c) : "") + (s.x && s.s !== "pass" ? "，" + s.x : "");

export function announcementText(ep: NonNullable<ReturnType<typeof pendingAnnouncement>>) {
  const cur = ep.first.summary, bad = cur.steps.filter(s => s.s === "fail");
  const L: string[] = [];
  L.push("「" + cur.repo + "」夜里的检查从通过变成了失败（" + fmtFull(ep.first.ts, BJ) + "，最新提交 " + (cur.sha || "").slice(0, 7) + (cur.head ? " " + cur.head.msg : "") + "）");
  L.push(bad.map(stepLine).join("；"));
  const tail = bad.find(s => s.tail?.length)?.tail;
  if (tail) L.push("开头几行报错：\n" + failureLines(tail).map(l => "  " + l.slice(0, 120)).join("\n"));
  if (ep.good) {
    const since = cur.good?.since;
    L.push("上一次通过是 " + fmtFull(ep.good.ts, BJ) + "，提交 " + (ep.good.sha || "").slice(0, 7) + "。");
    if (Array.isArray(since) && since.length === 1) L.push("这中间只有一个提交，多半就是它：" + since[0].sha + " " + since[0].author + "：" + since[0].subject);
    else if (Array.isArray(since) && since.length > 1) L.push("这中间有 " + since.length + " 个提交，最新的几个：\n" + since.slice(0, 4).map(c => "  " + c.sha + " " + c.author + "：" + c.subject).join("\n"));
    else if (since === "missing") L.push("上次通过的提交已经不在拉下来的历史里，没法列出区间。");
  }
  return L.join("\n");
}

/** What differs between two runs of the same repository, in short Chinese lines. */
export function changesBetween(prev: Row | undefined, cur: Row): string[] {
  if (!prev) return ["这是第一次检查，没有上次可比"];
  const out: string[] = [], a = prev.summary, b = cur.summary, when = fmtFull(prev.ts, BJ);
  if (prev.ok !== cur.ok) out.push("上次（" + when + "）" + verdictText(prev.ok) + "，这次" + verdictText(cur.ok));
  if (a.sha && b.sha && a.sha !== b.sha) out.push("提交从 " + a.sha.slice(0, 7) + " 变成 " + b.sha.slice(0, 7));
  for (const s of b.steps) {
    const was = a.steps.find(x => x.id === s.id);
    if (!was) continue;
    if (was.s !== s.s && !(was.s === "skip" && s.s === "skip")) out.push(stepName(s.id) + "：" + ({ pass: "过了", fail: "没过", timeout: "超时", skip: "没跑" })[was.s] + " → " + ({ pass: "过了", fail: "没过", timeout: "超时", skip: "没跑" })[s.s]);
    else if (was.c && s.c && (was.c.n !== s.c.n || was.c.f !== s.c.f)) out.push(stepName(s.id) + "：" + was.c.p + "/" + was.c.n + " → " + s.c.p + "/" + s.c.n + "（失败 " + was.c.f + " → " + s.c.f + "）");
  }
  if (a.loc && b.loc && a.loc.total !== b.loc.total) out.push("代码行数 " + a.loc.total + " → " + b.loc.total);
  if (!out.length) out.push("和上次（" + when + "）一样，没有变化");
  return out;
}

// ---------- reading ----------
/** One repository's latest result in the shape the model reads. */
export function describe(rows: Row[], now = Date.now()) {
  const cur = rows[0], s = cur.summary;
  const age = Math.max(0, Math.round((now - cur.ts) / 360000) / 10);
  const bad = s.steps.filter(x => x.s === "fail" || x.s === "timeout");
  const first = bad.find(x => x.tail?.length);
  return {
    repo: s.repo, checked: fmtFull(cur.ts, BJ) + "（北京时间）", hours_ago: age,
    result: verdictText(cur.ok),
    ...(s.err ? { problem: s.err } : {}),
    commit: s.sha ? s.sha.slice(0, 7) + (s.head ? " " + s.head.msg + "（" + s.head.author + "）" : "") : undefined,
    steps: s.steps.filter(x => !x.id.endsWith(":install") || x.s !== "pass").map(x => ({
      step: stepName(x.id), result: ({ pass: "通过", fail: "失败", timeout: "超时", skip: "没跑" })[x.s], seconds: x.t,
      ...(x.c ? { tests: countText(x.c), runner: x.c.runner } : {}), ...(x.x ? { note: x.x } : {}),
    })),
    ...(first ? { first_failing_lines: failureLines(first.tail!) } : {}),
    ...(s.c24 ? { commits_24h: commitText(s.c24) } : {}), ...(s.c7 ? { commits_7d: commitText(s.c7) } : {}),
    ...(s.br !== undefined ? { open_branches: s.br } : {}),
    ...(s.loc && s.loc.total ? { lines_of_code: { total: s.loc.total, ...s.loc.by } } : {}),
    changed_since_previous: changesBetween(rows[1], cur),
    ...(s.carried ? { note_carried: "这个仓库没有新提交，沿用 " + fmtFull(s.carried.from, BJ) + " 的结果，没有重跑" } : {}),
    ...(s.note ? { not_checked: s.note } : {}),
    ...(s.cpu !== undefined ? { cost: "用了 " + (s.wall ?? "?") + " 秒、" + s.cpu + " 秒 CPU" } : {}),
  };
}
const commitText = (c: NonNullable<Summary["c24"]>) => ({ count: c.n, files_changed: c.files, insertions: c.ins, deletions: c.del, authors: c.au.map(a => a.name + " " + a.n + " 次（+" + a.ins + " -" + a.del + "）") });

export function latestAll(hub: Hub, repos: string[], now = Date.now()) {
  return repos.map(r => { const rows = recentRows(hub, r, 2); return rows.length ? describe(rows, now) : { repo: r, result: "还没检查过" }; });
}

// ---------- doing it ----------
export const hooks: { run?: (hub: Hub, req: any) => Promise<any>; fetch?: typeof fetch } = {};
const busy = new WeakMap<object, string>();

async function runBox(hub: Hub, req: any) {
  if (hooks.run) return hooks.run(hub, req);
  const { runComputer } = await import("../computer.ts");
  return runComputer(hub, req);
}

const tokensOf = (hub: Hub) => [hub.env.GITHUB_TOKEN_2, hub.env.GITHUB_TOKEN].filter(Boolean) as string[];

/** The default branch's latest commit, and which token can read the repository (none needed for a public one). */
export async function probeHead(hub: Hub, org: string, repo: string): Promise<{ sha: string; token: string } | null> {
  const f = hooks.fetch || fetch;
  for (const token of [...tokensOf(hub), ""]) {
    try {
      const r = await f(`https://api.github.com/repos/${org}/${repo}/commits?per_page=1`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "teamagent", ...(token ? { Authorization: "Bearer " + token } : {}) }, signal: AbortSignal.timeout(15000),
      });
      if (r.ok) { const j: any = await r.json(); const sha = String(j?.[0]?.sha || ""); return sha ? { sha, token } : null; }
      if (![401, 403, 404].includes(r.status)) return null;
    } catch { return null; }
  }
  return null;
}

/** Days left in the plan's billing cycle, from the cycle text "YYYY-MM-DD 到 YYYY-MM-DD". */
export function daysLeft(cycle: string, now: number) {
  const m = /到 (\d{4}-\d{2}-\d{2})/.exec(cycle || "");
  return m ? Math.max(1, Math.ceil((Date.parse(m[1] + "T00:00:00Z") - now) / 86400000)) : 15;
}

export type CheckOpts = { builds?: boolean; total?: number; budget?: number; force?: boolean; now?: number };

/** Checks one repository: clone, history and size, install, the recipe's steps, then a stored row. */
export async function checkRepo(hub: Hub, repo: string, o: CheckOpts = {}): Promise<{ row: Row; ran: boolean }> {
  safeName(repo);
  const now = o.now ?? Date.now(), org = hub.env.GITHUB_ORG || "OmnixSI", total = Math.max(60, Math.floor(o.total ?? LIMITS.total)), started = Date.now();
  const prev = recentRows(hub, repo, LIMITS.keep), last = prev[0];
  const head = await probeHead(hub, org, repo);
  const lastGood = prev.find(r => r.ok === 1 && r.sha);

  // Nothing new since a recent, conclusive run: the answer would be the same, so say so without waking the computer.
  if (!o.force && head && last && last.sha === head.sha && last.ok !== null && !last.summary.err && now - last.ts < LIMITS.fresh && last.summary.builds === !!o.builds) {
    const s = last.summary, fresh = now - last.ts < 86400000;
    const carried: Summary = { ...s, carried: { from: s.carried?.from ?? last.ts }, c24: fresh && s.c24 ? s.c24 : { n: 0, files: 0, ins: 0, del: 0, au: [] }, c7: fresh ? s.c7 : undefined };
    const id = saveRow(hub, repo, now, last.sha, last.ok, carried);
    return { row: { id, repo, ts: now, sha: last.sha, ok: last.ok, summary: carried }, ran: false };
  }

  if (!hub.env.COMPUTER) throw new Error("没有云电脑，没法检查");
  const token = head?.token || "";
  let cleaned = false;
  try {
    const a = await runBox(hub, { commands: [buildProbeScript({ org, repo, lastGood: lastGood?.sha || undefined })], collect: [`repocheck/${repo}.a.txt`], timeoutSeconds: 240, ...(token ? { env: { GH_TOKEN: token } } : {}) });
    const file = a.files?.find((f: any) => f.name.endsWith(".a.txt"));
    if (a.error && !file) throw new Error(scrub(String(a.error), token));
    const probe = parseProbe(file ? new TextDecoder().decode(file.bytes) : "");
    const recipe = selectRecipe(repo, probe.manifest);
    const failed = (err: string): { row: Row; ran: boolean } => {
      const summary = buildSummary({ repo, probe, recipe, plan: { units: [], skipped: [], estimate: 0 }, builds: !!o.builds, token, err });
      const ts = Date.now();
      const id = saveRow(hub, repo, ts, probe.head?.sha || head?.sha || null, null, summary);
      return { row: { id, repo, ts, sha: probe.head?.sha || head?.sha || null, ok: null, summary }, ran: true };
    };
    if (probe.err) return failed(scrub(probe.err, token));
    const plan = planSteps(recipe, { builds: o.builds, budget: o.budget });
    let run: ReturnType<typeof parseRun> | undefined;
    if (plan.units.length) {
      const left = Math.max(40, total - Math.round((Date.now() - started) / 1000));
      const b = await runBox(hub, { commands: [buildRunScript({ repo, units: plan.units, total: left })], collect: [`repocheck/${repo}.b.txt`], timeoutSeconds: left + 90 });
      cleaned = true;
      const bf = b.files?.find((f: any) => f.name.endsWith(".b.txt"));
      if (!bf) throw new Error(scrub(String(b.error || b.steps?.[0]?.stderr || "云电脑没有返回结果"), token).slice(0, 200));
      run = parseRun(new TextDecoder().decode(bf.bytes));
    }
    const summary = buildSummary({ repo, probe, recipe, plan, run, builds: !!o.builds, token, ...(lastGood ? { lastGood: { sha: lastGood.sha!, ts: lastGood.ts } } : {}) });
    const ok = judge(summary.steps, summary.err);
    const ts = Date.now(), sha = probe.head?.sha || head?.sha || null;
    const id = saveRow(hub, repo, ts, sha, ok, summary);
    return { row: { id, repo, ts, sha, ok, summary }, ran: true };
  } catch (e: any) {
    const msg = scrub(String(e?.message || e), token).slice(0, 240);
    const summary: Summary = { v: 1, repo, src: "none", builds: !!o.builds, steps: [], err: msg, ...(head ? { sha: head.sha } : {}) };
    const ts = Date.now();
    if (/额度|停止线/.test(msg)) throw new Error(msg);
    const id = saveRow(hub, repo, ts, head?.sha || null, null, summary);
    return { row: { id, repo, ts, sha: head?.sha || null, ok: null, summary }, ran: true };
  } finally {
    if (!cleaned) { try { await runBox(hub, { commands: [cleanupScript(repo)], timeoutSeconds: 30 }); } catch {} }
  }
}

/** Guards against two checks at once (one small machine) and tells the group about a new failure once. */
export async function checkOne(hub: Hub, repo: string, o: CheckOpts & { announce?: boolean; told?: boolean } = {}) {
  const cur = busy.get(hub);
  if (cur) throw new Error("正在检查 " + cur + "，等它跑完再来");
  busy.set(hub, repo);
  try {
    const r = await checkRepo(hub, repo, o);
    await announceIfNew(hub, repo, { say: !!o.announce, mark: !!o.announce || !!o.told });
    return r;
  } finally { busy.delete(hub); }
}

/** Tells the main group when the repository has newly gone from passing to failing; each failure is told once. */
export async function announceIfNew(hub: Hub, repo: string, o: { say: boolean; mark: boolean }) {
  const rows = recentRows(hub, repo), told = Number(hub.get("repocheck:told:" + repo) || 0), ep = pendingAnnouncement(rows, told);
  if (!ep) return false;
  const main = hub.get("main");
  if (o.say && main) { await hub.say(main, announcementText(ep)); hub.set("repocheck:told:" + repo, String(ep.first.id)); return true; }
  if (o.mark) hub.set("repocheck:told:" + repo, String(ep.first.id));
  return false;
}

/** The nightly pass over the list, one repository after another. */
export async function nightly(hub: Hub, repos: string[], now = Date.now()) {
  const left = hub.plan.left("container_cpu_seconds");
  let cpuBudget = cpuAllowance(left, daysLeft(hub.plan.report(0, now).cycle, now));
  const done: string[] = [];
  for (const repo of repos) {
    if (!hub.plan.fits("container_seconds", 600)) { hub.set("repocheck:skip", fmtDate(now, BJ) + "|云电脑时间额度不够，" + (repos.length - done.length) + " 个仓库没查"); break; }
    try {
      // The steward turns the optional extras on only in months with plenty of machine time left.
      const r = await checkOne(hub, repo, { announce: true, budget: cpuBudget, now, builds: allowed(hub, "repo_builds"), force: allowed(hub, "repo_full") });
      cpuBudget = Math.max(0, cpuBudget - (r.row.summary.cpu || 0));
      done.push(repo);
    } catch (e: any) {
      console.log("repocheck failed", repo, String(e?.message || e).slice(0, 200));
      if (/额度|停止线/.test(String(e?.message))) { hub.set("repocheck:skip", fmtDate(now, BJ) + "|" + String(e.message)); break; }
    }
  }
  hub.set("repocheck:night", JSON.stringify({ day: fmtDate(now, BJ), done, at: Date.now() }));
  return done;
}

/** Once a Beijing day, after 02:40: starts the nightly pass in the background. */
export function tick(hub: Hub, now: number) {
  const day = fmtDate(now, BJ);
  if (hub.get("repocheck:day") === day || now < zonedToUtc(day, "02:40", BJ) || !hub.env.COMPUTER) return;
  hub.set("repocheck:day", day);
  if (!hub.plan.fits("container_seconds", 2400)) { hub.set("repocheck:skip", day + "|云电脑时间额度不够，今晚没查"); return; }
  hub.ctx.waitUntil(nightly(hub, listRepos(hub), now).catch(e => console.log("repocheck night failed", String(e?.message || e).slice(0, 200))));
}

// ---------- the feature ----------
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const feature: Feature = {
  name: "repocheck",
  schema: SCHEMA,
  tunables: { repocheck_daily: { default: 6, min: 0, max: 30, what: "每天最多手动检查几次仓库（夜里的自动检查不算）" } },
  tick,
  about: [
    "每天北京时间 02:40 之后，我会在云电脑里把团队的几个仓库（默认 TeamAgent、peiwan-club-saas、WhalePartner、NextThought、NextThought-Website）挨个拉下来，真的装依赖、跑它们自己的测试，再把结果记下来。",
    "每个仓库记：最新提交、24 小时和 7 天内谁提交了多少、各步骤过没过、测试通过多少条、分支数、各语言代码行数，每个仓库留最近 60 次。",
    "仓库自上次以来没有新提交就不重跑，直接沿用上次结果（最多沿用 7 天）；云电脑额度紧的时候会先跳过慢的步骤（构建、类型检查），只保测试。",
    "某个仓库从通过变成失败时，我会在群里说一次：哪个仓库、哪一步挂了、开头几行报错、最近一次通过之后的提交。结果没变化就不吭声。",
    "NextThought 的 Swift 部分要 macOS 才能跑，云电脑检查不了，只检查它的手机中转服务和发布脚本；WhalePartner 要求 Node 26，云电脑是 Node 24，api 里 4 个管进程的测试在这里一直是红的，所以它夜里的结果是“没通过”，看的是失败数有没有变。",
    "写每日简报的团队项目部分、或有人问某个仓库测试过没过时，用 repo_health 看最近一次结果；要现在重新检查某个仓库也能让它跑，每天手动检查次数有上限。",
  ],
  tools({ hub, host, conv }): Tool[] {
    return [{
      name: "repo_health", slow: true, work: true,
      description: "团队几个仓库（TeamAgent、peiwan-club-saas、WhalePartner、NextThought、NextThought-Website）的夜间体检结果：我每晚在云电脑里把仓库拉下来，真的装依赖、跑它们自己的测试和类型检查，记下最近提交、24 小时和 7 天里谁提交了多少、各步骤通过没有、测试通过几条、代码行数。写每日简报的“团队项目”部分、或有人问“某个仓库的测试过没过”“最近谁在提交”“项目现在什么状态”时，先用 op=last，别凭印象答。op=last：不填 repo 返回每个仓库最近一次结果，填 repo 只看那一个；结果里 changed_since_previous 是和上一次相比变了什么，first_failing_lines 是失败的开头几行，commits_24h / commits_7d 是提交统计。要引用时说清是哪天夜里查的（checked 字段），超过一两天没更新就说数据旧了。op=run：现在重新检查 repo 指定的那一个仓库（要等几分钟，只有群友明确要求“现在跑一下”才用，每天次数有限）；builds 填 true 才连构建一起跑（很慢，一般不用）。有些部分云电脑检查不了（比如 NextThought 的 Swift），结果里 not_checked 会写明，别说成“全都测过了”。",
      parameters: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["last", "run"], description: "last：看最近一次结果；run：现在重新检查 repo 指定的仓库" },
          repo: { type: "string", description: "仓库名，如 WhalePartner。last 可不填（看全部），run 必填" },
          builds: { type: "boolean", description: "run 时是否连构建一起跑，默认 false（慢，吃 CPU 额度）" },
        },
        required: ["op"],
      },
      async run(a: any) {
        const repos = listRepos(hub), name = a.repo ? String(a.repo).trim() : "";
        if (a.op === "run") {
          if (!name) return { ok: false, error: "要检查哪个仓库？给 repo（" + repos.join("、") + "）" };
          if (!REPO_RE.test(name)) return { ok: false, error: "仓库名不对" };
          if (!(await host.quota("repocheck", Number(host.cfg("repocheck_daily"))))) return { ok: false, error: "今天手动检查仓库的次数用完了，看夜里的结果就行（op=last）" };
          try {
            const r = await checkOne(hub, name, { builds: a.builds === true, force: true, total: 420, told: hub.get("main") === conv });
            return { ok: true, ...describe(recentRows(hub, name, 2)), ran_seconds: r.row.summary.wall };
          } catch (e: any) { return { ok: false, error: String(e?.message || e) }; }
        }
        if (name) {
          const rows = recentRows(hub, name, 2);
          return rows.length ? { ok: true, ...describe(rows) } : { ok: true, repo: name, result: "还没检查过这个仓库", hint: "夜里 02:40 之后会查，或者用 op=run 现在查" };
        }
        const skip = (hub.get("repocheck:skip") || "").split("|");
        const list = latestAll(hub, repos);
        return {
          ok: true, repos: list, ...(list.every((x: any) => x.result === "还没检查过") ? { hint: "还没有任何检查记录，夜里 02:40 之后会跑第一次" } : {}),
          ...(skip[0] && skip[1] ? { last_skipped: skip[0] + "：" + skip[1] } : {}),
        };
      },
    }];
  },
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/repocheck") return null;
    if (req.method === "GET") {
      const repos = listRepos(hub), night = (() => { try { return JSON.parse(hub.get("repocheck:night") || "null"); } catch { return null; } })();
      return json({ ok: true, repos, running: busy.get(hub) || null, night, skipped: hub.get("repocheck:skip") || null, latest: latestAll(hub, repos) });
    }
    if (req.method !== "POST") return json({ ok: false, error: "GET 或 POST" }, 405);
    if (Array.isArray(body?.repos)) {
      const list = [...new Set(body.repos.map((r: any) => String(r).trim()))].filter(Boolean) as string[];
      if (!list.length || list.length > 12 || list.some(r => !REPO_RE.test(r))) return json({ ok: false, error: "repos 要 1 到 12 个仓库名（字母数字和 . _ -）" }, 400);
      hub.set("repocheck:repos", JSON.stringify(list));
      return json({ ok: true, repos: list });
    }
    if (body?.repo) {
      const repo = String(body.repo).trim();
      if (!REPO_RE.test(repo)) return json({ ok: false, error: "仓库名不对" }, 400);
      if (busy.get(hub)) return json({ ok: false, error: "正在检查 " + busy.get(hub) }, 409);
      const job = checkOne(hub, repo, { builds: body.builds === true, force: body.force !== false, announce: body.announce === true, total: Number(body.total) || undefined });
      if (body.wait === true) {
        try { const r = await job; return json({ ok: true, ran: r.ran, ...describe(recentRows(hub, repo, 2)) }); } catch (e: any) { return json({ ok: false, error: String(e?.message || e) }, 500); }
      }
      hub.ctx.waitUntil(job.catch(e => console.log("repocheck run failed", String(e?.message || e).slice(0, 200))));
      return json({ ok: true, started: repo, note: "后台在跑，几分钟后 GET /admin/repocheck 看结果" });
    }
    return json({ ok: false, error: '用 {"repo":"名字"} 现在检查一个（加 "wait":true 等结果、"builds":true 连构建、"announce":true 失败时发群），或 {"repos":[…]} 设置夜里检查的名单' }, 400);
  },
};
export default feature;
