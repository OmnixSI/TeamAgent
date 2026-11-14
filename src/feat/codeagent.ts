// Real coding work on an organisation repository: a coding agent (OpenCode on deepseek-flash, highest
// reasoning) edits a fresh shallow clone in the cloud computer, the repository's own checks run, and the
// result is pushed to a new bot/ branch and opened as a DRAFT pull request for a human to review. The bot
// never merges and never pushes to a default branch. "investigate" runs the same agent read-only and
// returns its answer without any branch.
//
// Tokens reach the container only through runComputer's env. git gets the GitHub token as an
// http.extraHeader given with -c on each command (never in the URL or .git/config); the agent and the
// repository's checks run with the GitHub token removed from their environment.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { githubTokens } from "../tools.ts";
import { PRICE, isPeak, meter } from "../meter.ts";

const MODEL = "deepseek/deepseek-flash";     // OpenCode's built-in DeepSeek provider (models.dev) knows this id
const OPENCODE_VERSION = "1.19.5";
const DEFAULT_MINUTES = 12, MAX_MINUTES = 25;
const CHECK_SECONDS = 420;
const BIG_CHANGE = 600;
const ALLOW_KEY = "codeagent:repos";
const BUSY_KEY = "codeagent:busy";
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const HOME_REPO = "TeamAgent";
const BOT_NAME = "TeamAgent Bot", BOT_MAIL = "teamagent-bot@users.noreply.github.com";

// ---- pure helpers (tested offline) ----

/** A short ASCII slug from the task text; Chinese-only tasks get a generic one. */
export function slugify(task: string) {
  const words = String(task || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(w => w.length > 1 || /\d/.test(w));
  let s = "";
  for (const w of words) { const next = s ? s + "-" + w : w; if (next.length > 30) break; s = next; }
  return s || (words[0] || "").slice(0, 30) || "change";
}

/** bot/<slug>-<yyyymmdd-hhmm>, the time in Beijing like everything else the group sees. */
export function branchName(task: string, now: number) {
  const d = new Date(now + 8 * 3600000), p = (n: number) => String(n).padStart(2, "0");
  return "bot/" + slugify(task) + "-" + d.getUTCFullYear() + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + "-" + p(d.getUTCHours()) + p(d.getUTCMinutes());
}

export type Rank = "owner" | "trusted" | "member";
export type Mode = "investigate" | "pr";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Who may do what: anyone may investigate any repository of the organisation; a pull request needs an
 *  owner or trusted asker in this turn, and outside TeamAgent also a repository on the allowlist. */
export function permit(mode: Mode, repo: string, rank: Rank, allow: string[]): { ok: true } | { ok: false; error: string } {
  if (mode === "investigate") return { ok: true };
  if (rank === "member") return { ok: false, error: "改代码开 PR 要群主或被授权的人来说。我可以先用只读方式（investigate）看看代码、回答问题" };
  if (same(repo, HOME_REPO) || allow.some(r => same(r, repo))) return { ok: true };
  return { ok: false, error: repo + " 对我是只读的（业务仓库默认不让 Bot 改）。只能只读分析；要开放，得群主在管理接口把它加进允许名单" };
}

const FORBIDDEN = [
  /(^|\/)\.github\//i,
  /(^|\/)(\.env[^/]*|\.dev\.vars[^/]*|\.npmrc|\.netrc|\.git-credentials|\.pypirc)$/i,
  /(^|\/)[^/]*(secret|credential|password|passwd)[^/]*$/i,
  /(^|\/)(id_rsa|id_ed25519|id_ecdsa)[^/]*$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
];
/** Paths the bot must not change in a pull request: CI workflows and anything that may hold a secret. */
export const forbiddenPaths = (paths: string[]) => paths.filter(p => FORBIDDEN.some(re => re.test(p)));

const LOCKFILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Cargo\.lock|go\.sum)$/;
export const lockfiles = (paths: string[]) => paths.filter(p => LOCKFILES.test(p));

/** The repository's own check: `check` script first, else a real `test` script, else nothing. */
export function checkCommand(pkg: any, hasLock: boolean): string | null {
  const scripts = pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : null;
  if (!scripts) return null;
  const install = hasLock ? "npm ci --no-audit --no-fund" : "npm install --no-audit --no-fund";
  if (typeof scripts.check === "string" && scripts.check.trim()) return install + " && npm run check";
  if (typeof scripts.test === "string" && scripts.test.trim() && !/no test specified/i.test(scripts.test)) return install + " && npm test";
  return null;
}

export type AgentRun = { text: string; errors: string[]; steps: number; inTok: number; cachedTok: number; outTok: number; reasoningTok: number; usd: number };

/** Reads OpenCode's `--format json` event lines: step_finish parts carry the tokens of each model call
 *  (`input` excludes cache hits, reasoning is billed as output), text parts carry what it said. */
export function parseAgentEvents(raw: string, now = Date.now()): AgentRun {
  const out: AgentRun = { text: "", errors: [], steps: 0, inTok: 0, cachedTok: 0, outTok: 0, reasoningTok: 0, usd: 0 };
  let miss = 0, lastText = "", texts: string[] = [];
  for (const line of String(raw || "").split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.part || {};
    if (e.type === "step_finish" && p.tokens) {
      const t = p.tokens, read = Number(t.cache?.read || 0), input = Number(t.input || 0);
      out.steps++; miss += input; out.cachedTok += read; out.inTok += input + read;
      out.outTok += Number(t.output || 0) + Number(t.reasoning || 0); out.reasoningTok += Number(t.reasoning || 0);
      // The last step's words are the answer; earlier ones are remarks between tool calls.
      if (texts.length) lastText = texts.join("\n").trim();
      texts = [];
    } else if (e.type === "text" && typeof p.text === "string") texts.push(p.text);
    else if (e.type === "error") out.errors.push(String(e.error?.data?.message || e.error?.message || e.error?.name || "未知错误").slice(0, 300));
  }
  out.text = (texts.join("\n").trim() || lastText);
  const k = isPeak(now) ? 2 : 1;
  out.usd = k * (out.cachedTok * PRICE.flash.hit + miss * PRICE.flash.miss + out.outTok * PRICE.flash.out);
  return out;
}

/** Splits the pipeline's stdout into the sections it marks with "@@ca:<name>" lines. */
export function sections(stdout: string) {
  const out: Record<string, string> = {};
  let cur = "";
  for (const line of String(stdout || "").split("\n")) {
    const m = line.match(/^@@ca:(\w+)\s*$/);
    if (m) { cur = m[1]; out[cur] ??= ""; continue; }
    if (cur) out[cur] += (out[cur] ? "\n" : "") + line;
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/\s+$/, "");
  return out;
}

const q = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";
// The header is built inside the container from $GH_TOKEN and handed to this one git command only.
const AUTH = `AUTH="AUTHORIZATION: basic $(printf 'x-access-token:%s' "\${GH_TOKEN:-}" | base64 -w0)"`;

/** Shallow clone that keeps the token out of the URL, .git/config and the command text. */
export function cloneCommand(full: string, base?: string) {
  return AUTH + "\ngit -c http.extraHeader=\"$AUTH\" clone -q --depth 1 --single-branch " + (base ? "--branch " + q(base) + " " : "") + q("https://github.com/" + full + ".git") + " repo";
}
export function pushCommand(branch: string, dryRun = false) {
  return AUTH + "\ngit -c http.extraHeader=\"$AUTH\" push -q " + (dryRun ? "--dry-run " : "") + "origin " + q("HEAD:refs/heads/" + branch);
}

/** OpenCode's settings: built-in DeepSeek provider, no sharing or self-update; investigate cannot edit. */
export function opencodeConfig(mode: Mode) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json", model: MODEL, autoupdate: false, share: "disabled",
    permission: { edit: mode === "pr" ? "allow" : "deny", bash: "allow", webfetch: "allow" },
  }, null, 1);
}

export function brief(mode: Mode, task: string) {
  const common = [
    "你是在云端一台临时 Linux 电脑里工作的编码代理，当前目录是一个 Git 仓库的新克隆（浅克隆）。",
    "电脑 1 核 1 GB 内存，有 git、Node 24、Python 3.12，能上网。时间有限，抓紧做最重要的部分。",
    "不要读取、打印或写入环境变量里的任何密钥。",
  ];
  const rules = mode === "pr" ? [
    ...common,
    "只改完成任务需要的文件，改动尽量小，保持仓库原有的风格。",
    "不要改 .github/ 下的文件，不要碰任何存密钥的文件（.env、*.pem、*.key 之类）。",
    "不要 git commit、git push、切换分支或改 git 配置：提交和开 PR 由外面的流程做。",
    "仓库有测试或检查命令（见下面的 AGENTS.md 或 package.json）就在改完后跑一下，没通过就修。",
    "最后用中文写一段简短的总结：改了哪些文件、各改了什么、怎么验证的、有什么没做完或拿不准。这段话会原样放进 PR 说明。",
  ] : [
    ...common,
    "这次只读：不要修改、创建或删除仓库里的任何文件，只读代码、跑只读命令（grep、git log、运行测试也可以）。",
    "最后用中文直接回答下面的问题，引用具体的文件和行号。",
  ];
  return "# 规则\n\n" + rules.map(r => "- " + r).join("\n") + "\n\n# 任务\n\n" + task.trim() + "\n";
}

export type ScriptA = { id: string; full: string; base?: string; branch?: string; mode: Mode; agentSeconds: number };

/** Phase one: clone, branch, run the agent, stage the result and report what changed. */
export function scriptA(o: ScriptA) {
  const D = "/work/ca-" + o.id;
  return [
    "set -u; export GIT_TERMINAL_PROMPT=0",
    `D=${D}; OC=/opt/opencode/.opencode/bin/opencode`,
    `fail() { echo "@@ca:fail"; echo "$1"; exit 0; }`,
    `rm -rf "$D"; mkdir -p "$D/home/.config/opencode" && cd "$D" || fail "建不了工作目录"`,
    `mv ${D}-brief.md brief.md 2>/dev/null || fail "任务说明没放进去"`,
    cloneCommand(o.full, o.base) + " 2> clone.err || fail \"克隆失败：$(tail -c 300 clone.err)\"",
    `cd repo; ORIG=$(git rev-parse HEAD)`,
    o.mode === "pr" && o.branch ? `git checkout -q -b ${q(o.branch)} || fail "建不了分支"` : "",
    `[ -f AGENTS.md ] && { printf '\\n# 仓库自带的 AGENTS.md（照它的规矩做）\\n\\n'; head -c 20000 AGENTS.md; } >> ../brief.md`,
    `[ -x "$OC" ] || (curl -fsSL https://opencode.ai/install | HOME=/opt/opencode bash -s -- --version ${OPENCODE_VERSION} --no-modify-path) >/dev/null 2>&1`,
    `[ -x "$OC" ] || fail "装不上编码代理 OpenCode"`,
    `cat > ../home/.config/opencode/opencode.json <<'OCJSON'\n${opencodeConfig(o.mode)}\nOCJSON`,
    `export HOME="$D/home" OPENCODE_DISABLE_AUTOUPDATE=1`,
    `echo "@@ca:agent_start"; date +%s`,
    `timeout -k 15 ${Math.round(o.agentSeconds)} env -u GH_TOKEN "$OC" run --model ${MODEL} --variant max --auto --format json --title codeagent "$(cat ../brief.md)" </dev/null 2>../agent.err | grep -E '^\\{"type":"(step_finish|text|error)"' > ${D}-events.jsonl`,
    `RC=\${PIPESTATUS[0]}; echo "@@ca:agent_exit"; echo $RC; date +%s`,
    `echo "@@ca:agent_err"; tail -c 600 ../agent.err | sed 's/\\x1b\\[[0-9;]*m//g'`,
    ...(o.mode === "pr" ? [
      // Fold anything the agent committed back into staged changes on top of the clone's commit.
      `git checkout -q ${q(o.branch || "")} 2>/dev/null; [ "$(git rev-parse HEAD)" = "$ORIG" ] || git reset -q --soft "$ORIG"`,
      `git add -A -- . ':(exclude)node_modules' ':(exclude)**/node_modules'`,
      `echo "@@ca:files"; git diff --cached --name-only --no-renames | head -n 400`,
      `echo "@@ca:numstat"; git diff --cached --numstat --no-renames | awk '{a+=$1;d+=$2;n++} END {print n+0, a+0, d+0}'`,
      `echo "@@ca:stat"; git diff --cached --stat=100 --no-renames | tail -n 25`,
      `echo "@@ca:leak"; for v in "\${GH_TOKEN:-}" "\${DEEPSEEK_API_KEY:-}"; do [ -n "$v" ] && git diff --cached | grep -qF -- "$v" && echo yes; done; true`,
      `echo "@@ca:pkg"; [ -f package.json ] && node -e 'try{const p=require("./package.json");process.stdout.write(JSON.stringify({scripts:p.scripts||{}}))}catch{}'; echo`,
      `echo "@@ca:lock"; [ -f package-lock.json ] && echo yes; true`,
      `rm -rf "$D/home"`,
    ] : [`cd /; rm -rf "$D"`]),
    `echo "@@ca:end"`,
  ].filter(Boolean).join("\n");
}

export type ScriptB = { id: string; branch: string; check: string | null; dryRun?: boolean };

/** Phase two: run the repository's checks, commit the staged change as the bot and push the branch. */
export function scriptB(o: ScriptB) {
  const D = "/work/ca-" + o.id;
  return [
    "set -u; export GIT_TERMINAL_PROMPT=0",
    `D=${D}`,
    `fail() { echo "@@ca:fail"; echo "$1"; cd /; rm -rf "$D" "$D"-*; exit 0; }`,
    `cd "$D/repo" 2>/dev/null || fail "工作目录不见了（云电脑中途关机了），这次没推送任何东西"`,
    `mv ${D}-msg.txt ../msg.txt || fail "提交说明没放进去"`,
    ...(o.check ? [
      `echo "@@ca:check_start"; date +%s`,
      `( timeout -k 10 ${CHECK_SECONDS} env -u GH_TOKEN -u DEEPSEEK_API_KEY bash -c ${q(o.check)} ) > ../check.log 2>&1 </dev/null; RC=$?`,
      `echo "@@ca:check_exit"; echo $RC; date +%s`,
      `echo "@@ca:check_tail"; tail -n 30 ../check.log | sed 's/\\x1b\\[[0-9;]*m//g' | cut -c1-300`,
    ] : []),
    `git -c user.name=${q(BOT_NAME)} -c user.email=${q(BOT_MAIL)} commit -q --no-verify -F ../msg.txt || fail "提交失败"`,
    `echo "@@ca:sha"; git rev-parse HEAD`,
    pushCommand(o.branch, o.dryRun) + " 2> ../push.err; RC=$?",
    `echo "@@ca:push_exit"; echo $RC`,
    `echo "@@ca:push_err"; tail -c 500 ../push.err`,
    `cd /; rm -rf "$D" "$D"-*`,
    `echo "@@ca:end"`,
  ].join("\n");
}

export type CheckResult = { command: string | null; passed: boolean | null; exit?: number; seconds?: number; tail?: string; timedOut?: boolean };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function checkLine(c: CheckResult) {
  if (!c.command) return "仓库没有可跑的检查（package.json 里没有 check 或 test 脚本）";
  if (c.timedOut) return "`" + c.command + "`：超过 " + CHECK_SECONDS / 60 + " 分钟没跑完，被停掉了";
  return "`" + c.command + "`：" + (c.passed ? "通过" : "没通过（退出码 " + c.exit + "）") + (c.seconds ? "，用时 " + c.seconds + " 秒" : "");
}

export type PrInfo = {
  task: string; who: string; proposal?: number; summary: string; stat: string; changed: number; files: number;
  check: CheckResult; locks: string[]; seconds: number; usd: number;
};

export function prBody(p: PrInfo) {
  const fence = (s: string) => "```\n" + s.replace(/```/g, "ˋˋˋ") + "\n```";
  const quote = (s: string) => s.trim().split("\n").map(l => "> " + l).join("\n");
  return [
    "> 这个 PR 是 QQ 群里的 TeamAgent Bot 用编码代理自动做的，**需要人工审查后再合并**。Bot 不会自己合并。",
    p.changed > BIG_CHANGE ? "\n**注意：改动很大，共 " + p.changed + " 行（超过 " + BIG_CHANGE + " 行），请逐个文件仔细看。**" : "",
    "\n## 要求\n",
    (p.proposal ? "来自第 " + p.proposal + " 号改进提议，" : "") + p.who + " 在群里让 Bot 做的：\n",
    quote(clip(p.task, 3000)),
    "\n## 代理说它做了什么\n",
    clip(p.summary.trim(), 4000) || "（代理没有留下总结）",
    "\n## 改动\n",
    p.files + " 个文件，共 " + p.changed + " 行增删。\n",
    fence(p.stat || "（无）"),
    p.locks.length ? "\n依赖锁文件也变了：" + p.locks.join("、") + "，请确认是有意的。" : "",
    "\n## 检查\n",
    checkLine(p.check),
    p.check.command && p.check.tail ? "\n<details><summary>最后几行输出</summary>\n\n" + fence(p.check.tail) + "\n</details>" : "",
    "\n---\n",
    "由 TeamAgent Bot 生成：编码代理 OpenCode " + OPENCODE_VERSION + " + deepseek-flash（最高推理档），用时 " + Math.round(p.seconds) + " 秒，模型花费约 $" + p.usd.toFixed(4) + "。需要人工审查后再合并。",
  ].filter(Boolean).join("\n");
}

export function commitMessage(task: string, who: string, proposal?: number) {
  const first = task.trim().split("\n")[0].replace(/\s+/g, " ");
  return "bot: " + clip(first, 66) + "\n\n" + clip(task.trim(), 2000) + "\n\nRequested by " + who + (proposal ? " (proposal #" + proposal + ")" : "") + " through the TeamAgent bot; made by a coding agent, needs human review.\n";
}

// ---- GitHub ----

const GH = "https://api.github.com";
const ghHeaders = (token: string) => ({ Accept: "application/vnd.github+json", "User-Agent": "teamagent", "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: "Bearer " + token } : {}) });
async function ghCall(token: string, method: string, path: string, body?: any) {
  const r = await fetch(GH + path, { method, headers: { ...ghHeaders(token), ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  let data: any = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
}

export type Access = { token: string; defaultBranch: string; private: boolean; missing?: string[] };

/** The first token that can read the repository and, for a pull request, push a branch and open a PR.
 *  The write probes are requests GitHub rejects on validation (422) only after the permission check (403),
 *  so they change nothing. */
export async function pickToken(tokens: string[], full: string, needWrite: boolean): Promise<Access | { error: string }> {
  let seen = false, missing: string[] = [];
  for (const token of [...tokens, ...(needWrite ? [] : [""])]) {
    const repo = await ghCall(token, "GET", "/repos/" + full).catch(() => ({ status: 0, data: null }));
    if (repo.status !== 200) continue;
    seen = true;
    const access: Access = { token, defaultBranch: String(repo.data?.default_branch || "main"), private: !!repo.data?.private };
    if (!needWrite) return access;
    const ref = await ghCall(token, "POST", "/repos/" + full + "/git/refs", { ref: "refs/heads/bot/permission-probe", sha: "0".repeat(40) }).catch(() => ({ status: 0, data: null }));
    const pr = await ghCall(token, "POST", "/repos/" + full + "/pulls", { title: "probe", head: "bot/no-such-branch-probe", base: access.defaultBranch, draft: true }).catch(() => ({ status: 0, data: null }));
    const m = [ref.status === 422 ? "" : "Contents 写（推分支）", pr.status === 422 ? "" : "Pull requests 写（开 PR）"].filter(Boolean);
    if (!m.length) return access;
    if (!missing.length || m.length < missing.length) missing = m;
  }
  if (!seen) return { error: "GitHub 上找不到 " + full + "，或者令牌没有读它的权限" };
  return { error: "GitHub 令牌对 " + full + " 缺这些权限：" + missing.join("、") + "。要群主在 GitHub 给令牌加上，才推得了分支、开得了 PR" };
}

// ---- the tool ----

export const allowList = (hub: Hub): string[] => {
  try { const v = JSON.parse(hub.get(ALLOW_KEY) || "null"); if (Array.isArray(v)) return v.map(String); } catch {}
  return [HOME_REPO];
};

type Opts = { rehearse?: boolean; now?: () => number };
const cny = (usd: number) => Math.round(usd * PRICE.dsCnyPerUsd * 100) / 100;
const num = (s: string | undefined) => Number(String(s || "").trim().split("\n")[0]);

export async function codeTask(ctx: Ctx, a: any, opts: Opts = {}) {
  const { hub, host } = ctx, env = hub.env, now = opts.now || Date.now;
  const org = env.GITHUB_ORG || "OmnixSI";
  const mode: Mode = a.mode === "investigate" ? "investigate" : "pr";
  let repo = String(a.repo || HOME_REPO).trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/, "");
  if (repo.includes("/")) {
    const [owner, name] = repo.split("/");
    if (!same(owner, org)) return { ok: false, error: "只能动 " + org + " 组织里的仓库" };
    repo = name;
  }
  if (!REPO_RE.test(repo)) return { ok: false, error: "仓库名不对：" + repo };
  const full = org + "/" + repo;

  let task = String(a.task || "").trim(), proposal: number | undefined;
  if (a.proposal !== undefined && a.proposal !== null && String(a.proposal).trim() !== "") {
    proposal = Number(String(a.proposal).replace(/\D/g, ""));
    const real = hub.shadow(ctx.conv) || ctx.conv;
    const row = hub.sql.exec("SELECT id, key, after, status FROM change WHERE id=? AND kind='code' AND (conv=? OR conv=?)", proposal, ctx.conv, real).toArray()[0] as any;
    if (!row) return { ok: false, error: "没有第 " + proposal + " 号代码改进提议" };
    task = String(row.key) + "\n\n" + String(row.after) + (task ? "\n\n补充要求：" + task : "");
  }
  if (task.length < 8) return { ok: false, error: "要把改什么、改成什么样算完成写清楚（task）" };

  const rank = hub.edit.rank(ctx.conv, ctx.askers) as Rank;
  const perm = permit(mode, repo, rank, allowList(hub));
  if (!perm.ok) return perm;
  if (!hub.plan.fits("container_seconds", 1500)) return { ok: false, error: "这个月云电脑的额度快用完了，编码代理一次要二十多分钟，先不跑" };
  const busy = Number(hub.get(BUSY_KEY) || 0);
  if (busy && now() - busy < 45 * 60000) return { ok: false, error: "上一个编码任务还在跑（云电脑只有一台），等它做完再来" };

  // A rehearsal (lab only) skips the write probe and pushes with --dry-run, so it runs up to the push.
  const access = await pickToken(githubTokens(env), full, mode === "pr" && !opts.rehearse);
  if ("error" in access) return { ok: false, error: access.error };
  if (!(await host.quota("code", Number(host.cfg("code_daily"))))) return { ok: false, error: "今天的编码任务次数用完了" };

  const minutes = Math.min(Math.max(Number(a.minutes) || DEFAULT_MINUTES, 2), MAX_MINUTES);
  const base = String(a.base || "").trim() || access.defaultBranch;
  const started = now(), id = started.toString(36) + Math.random().toString(36).slice(2, 6);
  const branch = mode === "pr" ? branchName(task, started) : undefined;
  const who = [...new Set(ctx.askers.map(x => x.name || "成员" + x.id.slice(-4)))].join("、") || "（系统任务）";
  const secretEnv = { GH_TOKEN: access.token, DEEPSEEK_API_KEY: String(env.DEEPSEEK_API_KEY || "") };
  const enc = (s: string) => new TextEncoder().encode(s);
  const spent = { usd: 0 };
  const cleanup = () => host.computer({ commands: [`rm -rf /work/ca-${id} /work/ca-${id}-*`], timeoutSeconds: 30 }).catch(() => null);

  hub.set(BUSY_KEY, String(started));
  try {
    // Phase one: clone, agent, staged diff.
    const A = await host.computer({
      commands: [scriptA({ id, full, base, branch, mode, agentSeconds: minutes * 60 })],
      files: [{ name: "ca-" + id + "-brief.md", bytes: enc(brief(mode, task)) }],
      collect: ["ca-" + id + "-events.jsonl"],
      timeoutSeconds: minutes * 60 + 300, env: secretEnv,
    });
    const sa = sections(A.steps[0]?.stdout || "");
    const events = A.files.find(f => f.name.endsWith("events.jsonl"));
    const agent = parseAgentEvents(events ? new TextDecoder().decode(events.bytes) : "", started);
    spent.usd = agent.usd;
    if (agent.steps) meter({ provider: "deepseek", item: "代码代理", inTok: agent.inTok, cachedTok: agent.cachedTok, outTok: agent.outTok, usd: agent.usd });
    const usage = { model_calls: agent.steps, input_tokens: agent.inTok, cached_tokens: agent.cachedTok, output_tokens: agent.outTok, cost_usd: Math.round(agent.usd * 10000) / 10000, cost_cny: cny(agent.usd) };
    const secs = () => Math.round((now() - started) / 1000);
    const agentExit = num(sa.agent_exit);
    const agentNote = agentExit === 124 || agentExit === 137 ? "编码代理到了 " + minutes + " 分钟的时限被停掉了" : agent.errors.length ? "编码代理报错：" + agent.errors[0] : agentExit ? "编码代理异常退出（" + agentExit + "）：" + clip(sa.agent_err || "", 300) : "";

    if (sa.fail !== undefined || !A.steps.length || sa.end === undefined) {
      await cleanup();
      return { ok: false, error: sa.fail ? "云电脑里出错：" + clip(sa.fail, 400) : "云电脑没跑完：" + (A.error || clip(A.steps[0]?.stderr || "", 300) || "原因不明"), seconds: secs(), ...usage };
    }
    if (mode === "investigate") {
      await cleanup();
      if (!agent.text) return { ok: false, error: agentNote || "编码代理没给出回答", seconds: secs(), ...usage };
      return { ok: true, repo: full, base, answer: clip(agent.text, 6000), ...(agentNote ? { note: agentNote } : {}), seconds: secs(), ...usage };
    }

    const files = (sa.files || "").split("\n").map(s => s.trim()).filter(Boolean);
    const [nFiles, adds, dels] = (sa.numstat || "0 0 0").split(/\s+/).map(Number);
    const changed = (adds || 0) + (dels || 0);
    const refuse = async (error: string) => { await cleanup(); return { ok: false, error, ...(agent.text ? { agent_said: clip(agent.text, 1500) } : {}), seconds: secs(), ...usage }; };
    if (!files.length) return refuse((agentNote ? agentNote + "；" : "") + "编码代理没有改任何文件，没开 PR");
    const bad = forbiddenPaths(files);
    if (bad.length) return refuse("改动碰到了不允许 Bot 改的文件（CI 配置或可能存密钥的文件）：" + bad.slice(0, 8).join("、") + "。没推送，也没开 PR");
    if ((sa.leak || "").includes("yes")) return refuse("改动里出现了密钥原文，已整个丢弃，没推送");

    let pkg: any = null;
    try { pkg = sa.pkg ? JSON.parse(sa.pkg) : null; } catch {}
    const check = checkCommand(pkg, (sa.lock || "").includes("yes"));
    const B = await host.computer({
      commands: [scriptB({ id, branch: branch!, check, dryRun: opts.rehearse })],
      files: [{ name: "ca-" + id + "-msg.txt", bytes: enc(commitMessage(task, who, proposal)) }],
      timeoutSeconds: CHECK_SECONDS + 240, env: secretEnv,
    });
    const sb = sections(B.steps[0]?.stdout || "");
    if (sb.fail !== undefined || sb.end === undefined) {
      await cleanup();
      return { ok: false, error: sb.fail ? clip(sb.fail, 300) + "。没开 PR" : "云电脑没跑完提交和推送：" + (B.error || "原因不明") + "。没开 PR", seconds: secs(), ...usage };
    }
    const cr: CheckResult = { command: check, passed: null };
    if (check) {
      cr.exit = num(sb.check_exit); cr.passed = cr.exit === 0; cr.timedOut = cr.exit === 124 || cr.exit === 137;
      const [t0] = (sb.check_start || "").split("\n").map(Number), t1 = Number((sb.check_exit || "").split("\n")[1]);
      if (t0 && t1) cr.seconds = t1 - t0;
      cr.tail = (sb.check_tail || "").split("\n").slice(-15).join("\n");
    }
    const stat = (sa.stat || "").trim();
    const title = "[bot] " + clip(task.split("\n")[0].trim(), 70);
    const body = prBody({ task, who, proposal, summary: (agentNote ? agentNote + "。\n\n" : "") + agent.text, stat, changed, files: nFiles || files.length, check: cr, locks: lockfiles(files), seconds: secs(), usd: agent.usd });
    const result = {
      branch, base, diffstat: clip(stat, 2500), files_changed: nFiles || files.length, lines_changed: changed,
      ...(changed > BIG_CHANGE ? { warning: "改动很大（" + changed + " 行，超过 " + BIG_CHANGE + " 行），PR 里已经醒目标出，提醒大家仔细看" } : {}),
      checks: { result: checkLine(cr), passed: cr.passed, ...(cr.tail && !cr.passed ? { last_lines: clip(cr.tail, 1500) } : {}) },
      agent_summary: clip(agent.text, 1500), seconds: secs(), ...usage,
    };
    const pushed = num(sb.push_exit) === 0;
    if (opts.rehearse) return { ok: pushed, rehearsal: true, push: pushed ? "试推（--dry-run）通过" : "试推（--dry-run）失败：" + clip((sb.push_err || "").trim(), 300), pr_title: title, pr_body: body, ...result };
    if (!pushed) return { ok: false, error: "推送分支失败，没开 PR：" + clip((sb.push_err || "").trim(), 300), ...result };

    const pr = await ghCall(access.token, "POST", "/repos/" + full + "/pulls", { title, head: branch, base, body, draft: true, maintainer_can_modify: true })
      .catch(e => ({ status: 0, data: { message: String(e?.message || e) } }));
    if (pr.status !== 201) {
      // Leave no orphan branch behind.
      const del = await ghCall(access.token, "DELETE", "/repos/" + full + "/git/refs/heads/" + branch!.split("/").map(encodeURIComponent).join("/")).catch(() => ({ status: 0 }));
      return { ok: false, error: "分支推上去了但开 PR 失败（" + pr.status + " " + clip(String(pr.data?.message || ""), 200) + "），" + (del.status === 204 ? "分支已经删掉" : "分支没删掉，要人手删：" + branch), seconds: secs(), ...usage };
    }
    if (proposal) hub.sql.exec("UPDATE change SET status='pr', reason=reason || ? WHERE id=? AND kind='code'", "\n【处理结果】编码代理开了草稿 PR：" + pr.data.html_url, proposal);
    return { ok: true, pr: pr.data.html_url, number: pr.data.number, draft: true, ...result, note: "草稿 PR，要人看过再合并；Bot 不会自己合并" };
  } catch (e: any) {
    await cleanup();
    return { ok: false, error: "编码任务出错：" + clip(String(e?.message || e), 300), usd: spent.usd };
  } finally {
    hub.set(BUSY_KEY, "");
  }
}

function tools(ctx: Ctx): Tool[] {
  return [{
    name: "code_task", work: true, slow: true, long: true,
    description: "让编码代理真的去改团队 GitHub 组织里某个仓库的代码，做完开成草稿 PR 等人审查；或者只读地分析一个仓库、回答关于代码的问题。" +
      "流程：云电脑里浅克隆仓库 → 编码代理（OpenCode + deepseek-flash 最高推理档）按 task 改代码 → 跑仓库自己的检查（npm run check 或 npm test）→ 以 TeamAgent Bot 身份提交，推到新分支 bot/… → 开草稿 PR。Bot 不会合并，也不会推默认分支；合并要人在 GitHub 上点。" +
      "mode=pr（默认）：只有群主或被授权的人这一轮亲口要求时才能用；TeamAgent 仓库可以，其他仓库默认只读，除非在允许名单里。mode=investigate：任何人都能用，只读分析，不建分支。" +
      "task：要改什么、改成什么样算完成（验收标准）、相关文件，写得像给工程师的工单。proposal：处理某条代码改进提议时填它的编号，会用提议的内容当任务。一次要 5 到 20 分钟，期间照常聊天。返回 PR 链接、分支、改动统计、检查通没通过、用时和花费；没开成会说原因。",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: "组织里的仓库名，默认 TeamAgent" },
        task: { type: "string", description: "要改什么、验收标准、相关文件；investigate 时写要回答的问题" },
        mode: { type: "string", enum: ["pr", "investigate"], description: "pr：改代码开草稿 PR（默认）；investigate：只读分析" },
        base: { type: "string", description: "从哪个分支改，默认仓库的默认分支" },
        proposal: { type: "integer", description: "代码改进提议的编号（self_update 里 kind=code 的那条）" },
        minutes: { type: "integer", description: "给编码代理的时间，默认 12 分钟，最多 25" },
      },
      required: ["task"],
    },
    run: a => codeTask(ctx, a),
  }];
}

async function admin(hub: Hub, req: Request, url: URL, body: any) {
  if (url.pathname !== "/admin/codeagent") return null;
  const json = (v: any, status = 200) => new Response(JSON.stringify(v, null, 1), { status, headers: { "Content-Type": "application/json" } });
  let list = allowList(hub);
  if (req.method === "POST") {
    const org = String(hub.env.GITHUB_ORG || "OmnixSI"), raw = String(body?.allow ?? body?.deny ?? "").trim();
    const name = raw.toLowerCase().startsWith(org.toLowerCase() + "/") ? raw.slice(org.length + 1) : raw;
    if (!REPO_RE.test(name)) return json({ ok: false, error: "repo name required: {\"allow\":\"Repo\"} or {\"deny\":\"Repo\"}" }, 400);
    if (body.deny !== undefined && same(name, HOME_REPO)) return json({ ok: false, error: HOME_REPO + " is always allowed for owners and trusted members" }, 400);
    list = list.filter(r => !same(r, name));
    if (body.allow !== undefined) list.push(name);
    if (!list.some(r => same(r, HOME_REPO))) list.unshift(HOME_REPO);
    hub.set(ALLOW_KEY, JSON.stringify(list));
  }
  return json({ ok: true, allowed_for_pr: list, busy_since: Number(hub.get(BUSY_KEY) || 0) || null });
}

const feature: Feature = {
  name: "codeagent",
  tools,
  admin,
  tunables: { code_daily: { default: 6, min: 0, max: 30, what: "每天最多让编码代理改几次代码或分析几次仓库" } },
  about: [
    "我能让编码代理真的改代码：在云电脑里浅克隆组织的仓库，用 OpenCode 跑 deepseek-flash（最高推理档）按要求改，跑仓库自己的检查，然后推到一个 bot/ 开头的新分支，开成草稿 PR。",
    "我不会合并 PR，也不会推到 main 或任何默认分支；合并要人在 GitHub 上看过再点。TeamAgent 合进 main 后会自动部署。",
    "改代码开 PR 只听群主和被授权的人；TeamAgent 仓库可以，其他业务仓库默认只读，要群主在管理接口把仓库加进允许名单才行。只读分析谁都能叫。",
    "动到 .github 工作流、.env、密钥文件，或者改动里出现密钥原文，我会整个丢弃不推送；什么都没改也不开 PR。改动超过 600 行照样开，但在 PR 里醒目标出。",
    "一次要 5 到 20 分钟（编码代理默认最多 12 分钟，最多给 25 分钟，检查最多 7 分钟），每天默认最多 6 次，云电脑一次只跑一个。花费按 DeepSeek 实际用的 token 记在账上，一般一次几分钱到几毛钱人民币。",
    "代码质量取决于编码代理，检查通过不等于做对了；PR 说明里写着谁要求的、代理说它做了什么、改动统计和检查结果，审查的人照这个看。",
  ],
};
export default feature;
