#!/usr/bin/env node
// Read-only status table for the six configured repositories.
// No secrets are printed: D1 is queried with a SELECT and Worker secrets are only named.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const D1_SQL = "SELECT repo, COUNT(*) AS n FROM repo_commits GROUP BY repo ORDER BY repo";

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function parseJsonLoose(text) {
  const raw = String(text || "").trim();
  const starts = [raw.indexOf("["), raw.indexOf("{")].filter((i) => i >= 0);
  if (!starts.length) throw new Error("no JSON in wrangler output");
  return JSON.parse(raw.slice(Math.min(...starts)));
}

export function remoteMatches(remote, repo) {
  const cleaned = String(remote || "").trim()
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");
  return cleaned === "https://github.com/" + repo;
}

export function parseD1Counts(text) {
  const data = parseJsonLoose(text);
  const rows = Array.isArray(data) ? (data[0]?.results || []) : (data?.results || []);
  const counts = {};
  for (const row of rows) {
    if (row && row.repo != null) counts[row.repo] = Number(row.n ?? row.count ?? 0);
  }
  return counts;
}

export function parseSecretNames(text) {
  const data = parseJsonLoose(text);
  const list = Array.isArray(data) ? data : data?.secrets;
  if (!Array.isArray(list)) throw new Error("unexpected secret list");
  return list.map((item) => (typeof item === "string" ? item : item?.name)).filter(Boolean);
}

export function clonePath(home, repo) {
  return path.join(home, ".inkboard-team", "repos", repo.split("/").pop());
}

export function inspectClone(home, repo, run) {
  const dir = clonePath(home, repo);
  try {
    const top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]).trim();
    if (path.resolve(top) !== path.resolve(dir)) return { cloned: false, dir, problem: "not a repository root" };
    const head = run("git", ["-C", dir, "rev-parse", "HEAD"]).trim();
    const remote = run("git", ["-C", dir, "config", "--get", "remote.origin.url"]).trim();
    if (!remoteMatches(remote, repo)) return { cloned: false, dir, head, problem: "origin remote does not match" };
    return { cloned: true, dir, head, problem: null };
  } catch {
    return { cloned: false, dir, problem: "missing or unreadable clone" };
  }
}

export function installedRunner(home, read = readFileSync) {
  const file = path.join(home, ".inkboard-team", "repo_index.py");
  try {
    const text = read(file, "utf8");
    return { present: true, has_clone: text.includes("def _clone_once") && text.includes("'gh', 'repo', 'clone'") };
  } catch {
    return { present: false, has_clone: false };
  }
}

export function lastIndex(state, repo) {
  const entry = state?.[repo] || {};
  return {
    at: entry.last_success_at ?? entry.sent_at ?? null,
    ok: typeof entry.ok === "boolean" ? entry.ok : null,
    error: entry.last_error ?? null,
  };
}

export function formatTime(epoch) {
  if (!epoch) return "—";
  return new Date(Number(epoch) * 1000).toLocaleString("sv-SE", { hour12: false });
}

export function nextAction(row) {
  if (!row.configured) return "把这个仓库加入 config/team.json 的 repositories";
  if (!row.cloned) return "等 runner 下一轮 clone；仍失败看 repo-index-state.json 的 last_error";
  if (row.last_index_ok === false) return "本机索引失败：" + (row.last_error || "看 last_error");
  if (!row.last_index_at) return "等 runner 完成一轮索引，或运行 python3 runner/repo_index.py";
  if (row.commit_rows === null) return "设置 CLOUDFLARE_API_TOKEN 后重跑 verify（只读 D1）";
  if (row.commit_rows === 0) return "本机已 clone 但云端无提交：检查 /api/runner/repo_index 上报";
  if (row.worker_token === null) return "用 wrangler 登录后重跑 verify（只看 secret 名）";
  if (row.worker_token === false) return "设置 GITHUB_TOKEN（Contents/Metadata/Pull Requests 只读）";
  return "—";
}

function wranglerBinary() {
  const local = path.join(ROOT, "node_modules/.bin/wrangler");
  return existsSync(local) ? local : "npx";
}

function wranglerArgs(args) {
  return path.basename(wranglerBinary()) === "npx" ? ["--no-install", "wrangler", ...args] : args;
}

const defaultRun = (command, args, options = {}) =>
  execFileSync(command, args, { encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"], ...options });

function shortFailure(error) {
  const text = String(error?.stderr || error?.message || error || "").trim();
  return text.split("\n").filter(Boolean).pop()?.slice(0, 200) || "unavailable";
}

export function buildReport({ configPath, home = os.homedir(), run = defaultRun } = {}) {
  const config = readJson(configPath, {});
  const configured = Array.isArray(config.repositories) ? config.repositories : [];
  const state = readJson(path.join(home, ".inkboard-team/repo-index-state.json"), {});
  const extra = Object.keys(state).filter((key) => key.includes("/") && !configured.includes(key));
  const repos = [...configured, ...extra];
  const wrangler = wranglerBinary();
  let d1 = null; let d1Error = null; let secrets = null; let secretsError = null;
  try {
    d1 = parseD1Counts(run(wrangler, wranglerArgs(["d1", "execute", "inkboard-team", "--remote", "--json", "--command", D1_SQL])));
  } catch (error) { d1Error = shortFailure(error); }
  try {
    secrets = parseSecretNames(run(wrangler, wranglerArgs(["secret", "list", "--format", "json"])));
  } catch (error) { secretsError = shortFailure(error); }
  const tokens = secrets ? secrets.includes("GITHUB_TOKEN") : null;
  const runner = installedRunner(home);
  const rows = repos.map((repo) => {
    const clone = inspectClone(home, repo, run);
    const index = lastIndex(state, repo);
    const row = {
      repo,
      configured: configured.includes(repo),
      cloned: clone.cloned,
      head: clone.head || null,
      clone_problem: clone.problem,
      last_index_at: index.at,
      last_index_time: formatTime(index.at),
      last_index_ok: index.ok,
      last_error: index.error,
      commit_rows: d1 ? (d1[repo] ?? 0) : null,
      worker_token: tokens,
    };
    row.next_action = nextAction(row);
    return row;
  });
  return {
    generated_at: new Date().toISOString(),
    d1_ok: d1 !== null,
    d1_error: d1Error,
    secrets_ok: secrets !== null,
    secrets_error: secretsError,
    runner,
    rows,
  };
}

function displayWidth(value) {
  let width = 0;
  for (const char of String(value)) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(char) ? 2 : 1;
  }
  return width;
}

function pad(value, width) {
  const text = String(value);
  return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

export function formatTable(report) {
  const header = ["仓库", "配置", "本机 clone", "HEAD", "最后索引", "repo_commits", "Worker token", "next_action"];
  const body = report.rows.map((row) => [
    row.repo,
    row.configured ? "有" : "无",
    row.cloned ? "在" : "缺",
    row.head ? row.head.slice(0, 7) : "—",
    row.last_index_time,
    row.commit_rows === null ? "?" : String(row.commit_rows),
    row.worker_token === null ? "?" : row.worker_token ? "有" : "无",
    row.next_action,
  ]);
  const widths = header.map((name, i) => Math.max(displayWidth(name), ...body.map((line) => displayWidth(line[i]))));
  const render = (line) => line.map((cell, i) => pad(cell, widths[i])).join("  ").trimEnd();
  const lines = [render(header), widths.map((width) => "─".repeat(width)).join("  "), ...body.map(render)];
  if (!report.d1_ok) lines.push("", "D1: 不可用（设置 CLOUDFLARE_API_TOKEN 后重跑；本次不写任何数据）");
  if (!report.secrets_ok) lines.push("Worker secrets: 不可用（wrangler 登录后重跑；只看名字）");
  if (!report.runner?.present || !report.runner?.has_clone) {
    lines.push("", "本机 runner: " + (report.runner?.present ? "旧版，没有 clone 逻辑" :
      "未安装到 ~/.inkboard-team") + "；合并后运行 python3 scripts/install-local.py --apply");
  }
  return lines.join("\n");
}

function main(argv) {
  const json = argv.includes("--json");
  const configPath = process.env.TEAM_AGENT_SETTINGS || path.join(ROOT, "config/team.json");
  const report = buildReport({ configPath });
  process.stdout.write(json ? JSON.stringify(report, null, 2) + "\n" : formatTable(report) + "\n");
  process.exitCode = report.rows.every((row) => row.next_action === "—") ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
