/** Bounded, read-only GitHub access. Repository contents never authorize work. */
import { REPOS } from "./policy";
import { cutBytes, redactPatch, toolFailure } from "./repo";

export const DENY_GLOBS = [".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "id_rsa*", "id_ed25519*",
  ".npmrc", ".netrc", ".pypirc", "*secret*", "*credential*", "*cookie*", "worker-secrets.json",
  ".git/*", ".dev.vars", "wrangler.toml.local"];
const denyPatterns = DENY_GLOBS.map(s => new RegExp("^" + [...s].map(c =>
  c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&")).join("") + "$", "s"));
export function deniedPath(path: string): boolean {
  const lower = path.toLowerCase(), parts = lower.split("/");
  // A protected directory hides its descendants, including nested .git trees.
  return parts.includes(".git") || denyPatterns.some(r => r.test(lower) || parts.some(part => r.test(part)));
}
export function parseRepo(value: unknown): { owner: string; repo: string; full: string; listed: boolean } | null {
  if (typeof value !== "string") return null;
  let name = value.trim();
  const alias = REPOS.find(r => r.toLowerCase() === name.toLowerCase() || r.split("/")[1].toLowerCase() === name.toLowerCase());
  if (alias) name = alias;
  if (/^https?:\/\//i.test(name)) {
    try {
      const url = new URL(name);
      if (!["github.com", "www.github.com"].includes(url.hostname) || url.username || url.password || url.port) return null;
      name = url.pathname.split("/").slice(1, 3).join("/");
    } catch { return null; }
  }
  name = name.replace(/\.git$/, "");
  const parts = name.split("/");
  if (parts.length !== 2 || !/^[A-Za-z0-9-]{1,39}$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1]) || [".", ".."].includes(parts[1])) return null;
  const canonical = REPOS.find(r => r.toLowerCase() === name.toLowerCase());
  const full = canonical || name, [owner, repo] = full.split("/");
  return { owner, repo, full, listed: !!canonical };
}
export function validPath(value: unknown): string | null {
  if (value === undefined || value === "" || value === "." || value === "./") return "";
  if (typeof value !== "string" || value.length > 300 || value.startsWith("/") ||
      value !== value.trim() || /[\\\0]/.test(value) || value.includes("//") ||
      /%[0-9a-f]{2}/i.test(value) || value.split("/").includes("..")) return null;
  // Callers supply decoded paths. Normalize dot segments before DENY checks.
  return value.split("/").filter(part => part !== "." && part !== "").join("/");
}
const validRef = (r: any) => r === undefined || typeof r === "string" &&
  /^[A-Za-z0-9._/-]{1,100}$/.test(r) && !/^[-/]/.test(r) && !r.includes("..");
class GitHubFailure extends Error {
  constructor(public kind: string) { super("GitHub request unavailable"); }
}
function meter(e: any) {
  e.meter ??= { used: 0 };
  return e.meter.gh ??= { n: 0, sha: {}, meta: {} };
}
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(new GitHubFailure("upstream"));
  }
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener("abort", stop); reject(new GitHubFailure("upstream")); };
    signal.addEventListener("abort", stop, { once: true });
    work.then(v => { signal.removeEventListener("abort", stop); resolve(v); },
      error => { signal.removeEventListener("abort", stop); reject(error); });
  });
}
export async function readCapped(response: Response, cap: number, signal: AbortSignal) {
  if (!response.body) return { text: "", over: false };
  const reader = response.body.getReader(), parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > cap) { void reader.cancel().catch(() => {}); return { text: "", over: true }; }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return { text: new TextDecoder().decode(bytes), over: false };
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
export async function ghFetch(e: any, segs: string[], query: Record<string, any> = {},
    accept = "application/vnd.github+json", cap = 524288, signal?: AbortSignal,
    deadline = Date.now() + 8000): Promise<{ text: string; over: boolean }> {
  const controller = new AbortController(), stop = () => controller.abort();
  const remaining = Math.min(5000, deadline - Date.now());
  if (remaining <= 0 || signal?.aborted) throw new GitHubFailure("upstream");
  signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(stop, remaining);
  const headers: Record<string, string> = { "User-Agent": "TeamAgent", Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (e.GITHUB_TOKEN) headers.Authorization = "Bearer " + e.GITHUB_TOKEN;
  let url = new URL("https://api.github.com/" + segs.map(s => s.split("/").map(encodeURIComponent).join("/")).join("/"));
  for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  try {
    for (let hop = 0; ; hop++) {
      const budget = meter(e);
      if (budget.n >= 10) throw new GitHubFailure("budget");
      budget.n++;
      const response = await abortable(fetch(url.href, { headers, redirect: "manual", signal: controller.signal }), controller.signal);
      if (response.status >= 300 && response.status < 400) {
        void response.body?.cancel().catch(() => {});
        const location = response.headers.get("location");
        if (!location || hop >= 2) throw new GitHubFailure("upstream");
        const target = new URL(location, url);
        if (target.origin !== "https://api.github.com" || target.username || target.password) throw new GitHubFailure("upstream");
        url = target;
        continue;
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        const listed = segs[0] === "repos" && parseRepo(segs[1] + "/" + segs[2])?.listed;
        throw new GitHubFailure(response.status === 401 && listed ? "needs_token"
          : response.status === 429 || response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0" ? "rate_limited"
          : response.status === 404 ? "not_found" : "upstream");
      }
      return await readCapped(response, cap, controller.signal);
    }
  } catch (error) {
    throw error instanceof GitHubFailure ? error : new GitHubFailure("upstream");
  } finally {
    clearTimeout(timer); signal?.removeEventListener("abort", stop);
  }
}
export function redactKnown(e: any, text: string, preserveLines = false): string {
  text = redactPatch(text, preserveLines);
  const values = ["ADMIN_TOKEN", "DEEPSEEK_API_KEY", "QQ_APP_SECRET", "RUNNER_TOKEN", "GITHUB_TOKEN"]
    .map(k => e[k]).filter(v => typeof v === "string" && v.length >= 16).sort((a, b) => b.length - a.length);
  for (const value of values) text = text.split(value).join("[REDACTED]" + (preserveLines ? "\n".repeat(value.split("\n").length - 1) : ""));
  return text;
}
type Repo = NonNullable<ReturnType<typeof parseRepo>>;
type Call = { e: any; rp: Repo; deadline: number; signal: AbortSignal };
const base = (c: Call) => ["repos", c.rp.owner, c.rp.repo];
async function raw(c: Call, path: string[], query = {}, cap = 524288, accept?: string) {
  const result = await ghFetch(c.e, [...base(c), ...path], query, accept, cap, c.signal, c.deadline);
  if (result.over) throw new GitHubFailure("too_large");
  return result.text;
}
const json = async (c: Call, path: string[], query = {}, cap = 524288) => JSON.parse(await raw(c, path, query, cap));
async function gate(c: Call) {
  if (c.rp.listed) { if (!c.e.GITHUB_TOKEN) throw new GitHubFailure("needs_token"); return; }
  const cached = meter(c.e).meta;
  if (!cached[c.rp.full]) cached[c.rp.full] = await json(c, []);
  if (cached[c.rp.full]?.private !== false) throw new GitHubFailure("denied");
}
async function head(c: Call, ref = "HEAD") {
  const cached = meter(c.e).sha, key = c.rp.full + "@" + ref;
  if (!cached[key]) {
    const sha = (await raw(c, ["commits", ref], {}, 100, "application/vnd.github.sha")).trim();
    if (!/^[a-f0-9]{40}$/i.test(sha)) throw new GitHubFailure("upstream");
    cached[key] = sha;
  }
  return cached[key] as string;
}
const tree = async (c: Call, sha: string, path = "", recursive = false) => {
  const result = await json(c, ["git", "trees", sha + (path ? ":" + path : "")], recursive ? { recursive: 1 } : {});
  if (result.truncated) throw new GitHubFailure("too_large");
  if (!Array.isArray(result.tree)) throw new GitHubFailure("upstream");
  return result.tree;
};
function directory(c: Call, sha: string, path: string, entries: any[]) {
  let hidden = 0;
  const visible = entries.filter(item => {
    if (typeof item.path !== "string") return false;
    if (deniedPath((path ? path + "/" : "") + item.path)) { hidden++; return false; }
    return true;
  }).map(item => ({ name: redactKnown(c.e, item.path), type: item.type === "tree" ? "dir" : item.mode === "120000" ? "symlink"
    : item.mode === "160000" ? "submodule" : "file", size: typeof item.size === "number" ? item.size : 0 }));
  visible.sort((a, b) => Number(b.type === "dir") - Number(a.type === "dir") || a.name.localeCompare(b.name));
  return { repo: c.rp.full, sha7: sha.slice(0, 7), path, entries: visible.slice(0, 200), hidden, more: visible.length > 200, untrusted: true };
}
async function readFile(c: Call, a: any, path: string) {
  const sha = await head(c, a.ref);
  if (a.mode === "find") {
    const items = await tree(c, sha, path, true), query = a.query.toLowerCase();
    const paths = items.filter((t: any) => t.type === "blob" && typeof t.path === "string")
      .map((t: any) => (path ? path + "/" : "") + t.path)
      .filter((p: string) => !deniedPath(p) && p.toLowerCase().includes(query)).sort((a: string, b: string) => a.length - b.length || a.localeCompare(b));
    return { repo: c.rp.full, sha7: sha.slice(0, 7), paths: paths.slice(0, 30).map((p: string) => redactKnown(c.e, p)), more: paths.length > 30, untrusted: true };
  }
  if (!path) return directory(c, sha, "", await tree(c, sha));
  const slash = path.lastIndexOf("/"), parent = slash < 0 ? "" : path.slice(0, slash), name = path.slice(slash + 1);
  const item = (await tree(c, sha, parent)).find((t: any) => t.path === name);
  if (!item) throw new GitHubFailure("not_found");
  if (item.type === "tree") return directory(c, sha, path, await tree(c, sha, path));
  const common = { repo: c.rp.full, sha7: sha.slice(0, 7), path, untrusted: true };
  if (item.mode === "120000") return { ...common, type: "symlink", size: item.size || 0, note: "符号链接，不跟随目标" };
  if (item.mode === "160000") return { ...common, type: "submodule", sha: item.sha, note: "子模块，内容在另一个仓库" };
  if (item.type !== "blob" || !/^[a-f0-9]{40}$/i.test(item.sha)) throw new GitHubFailure("upstream");
  if (item.size > 256000) throw new GitHubFailure("too_large");
  const data = await json(c, ["git", "blobs", item.sha]);
  if (data.size > 256000) throw new GitHubFailure("too_large");
  if (data.encoding !== "base64" || typeof data.content !== "string" || data.size !== 0 && data.content === "")
    throw new GitHubFailure("upstream");
  const binary = atob(data.content.replace(/\s/g, "")), bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  if (bytes.length > 256000) throw new GitHubFailure("too_large");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new GitHubFailure("binary"); }
  if (bytes.subarray(0, 8000).includes(0) || text.startsWith("version https://git-lfs")) throw new GitHubFailure("binary");
  // Redact the complete blob before selecting lines, retaining source line positions.
  const lines = text === "" ? [] : redactKnown(c.e, text, true).split(/\r?\n/);
  if (text.endsWith("\n")) lines.pop();
  const start = a.start_line ?? 1, max = a.max_lines ?? 200;
  const selected = lines.slice(start - 1, start - 1 + max).join("\n"), output = cutBytes(selected, 12000);
  return { ...common, total_lines: lines.length, start_line: start, end_line: Math.min(start - 1 + max, lines.length),
    text: output, truncated: output !== selected || start - 1 + max < lines.length };
}
function sinceISO(since: any): string | null {
  const durations: Record<string, number> = { "24h": 86400000, "3d": 3 * 86400000, "7d": 7 * 86400000 };
  since ??= "7d";
  if (typeof since !== "string") return null;
  const date = durations[since] ? Date.now() - durations[since] : /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(since) ? Date.parse(since) : NaN;
  return Number.isFinite(date) ? new Date(date).toISOString() : null;
}
async function commits(c: Call, name: string, a: any, since: string | null, path: string) {
  if (name === "repo_changes") {
    const rows = await json(c, ["commits"], { sha: a.ref, since, author: a.author, path, per_page: a.limit ?? 10 }, 262144);
    if (!Array.isArray(rows)) throw new GitHubFailure("upstream");
    const result: any = { repo: c.rp.full, commits: rows.slice(0, a.limit ?? 10).map((r: any) => ({
      sha7: String(r.sha).slice(0, 7), date: r.commit?.author?.date, author: redactKnown(c.e, String(r.commit?.author?.name || r.author?.login || "")),
      message: redactKnown(c.e, String(r.commit?.message || "").split("\n")[0]).slice(0, 200) })), untrusted: true };
    if (c.rp.listed) {
      const stored = await c.e.DB.prepare("SELECT json,updated_at,checked_at FROM repo_state WHERE repo=?").bind(c.rp.full).first();
      if (stored) { const state = JSON.parse(stored.json); result.branches = state.branches || []; result.in_progress = state.worktrees || []; }
    }
    return result;
  }
  const data = await json(c, ["commits", a.sha], {}, 1048576);
  let remaining = 12000, hidden = 0;
  const files = [];
  for (const item of Array.isArray(data.files) ? data.files : []) {
    if (typeof item.filename !== "string") continue;
    if (deniedPath(item.filename) || typeof item.previous_filename === "string" && deniedPath(item.previous_filename)) { hidden++; continue; }
    const patch = cutBytes(redactKnown(c.e, String(item.patch || "")), remaining);
    remaining -= new TextEncoder().encode(patch).length;
    files.push({ path: redactKnown(c.e, item.filename), status: item.status, add: item.additions, del: item.deletions, patch });
  }
  return { repo: c.rp.full, sha7: String(data.sha || a.sha).slice(0, 7), files, hidden,
    message: redactKnown(c.e, String(data.commit?.message || "")).slice(0, 2000), untrusted: true };
}
export async function runCloudRepoTool(e: any, name: string, a: any): Promise<any> {
  const rp = parseRepo(a?.repo), path = validPath(a?.path), mode = a?.mode ?? "read";
  const since = name === "repo_changes" ? sinceISO(a?.since) : null;
  if (!rp || path === null || !validRef(a?.ref) || !["repo_file", "repo_changes", "repo_commit"].includes(name) ||
      name === "repo_commit" && (typeof a.sha !== "string" || !/^[a-f0-9]{7,40}$/i.test(a.sha)) ||
      name === "repo_changes" && (!since || a.author !== undefined && typeof a.author !== "string" ||
        a.limit !== undefined && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 20)) ||
      name === "repo_file" && (!["read", "list", "find"].includes(mode) ||
        a.start_line !== undefined && (!Number.isInteger(a.start_line) || a.start_line < 1) ||
        a.max_lines !== undefined && (!Number.isInteger(a.max_lines) || a.max_lines < 1 || a.max_lines > 400) ||
        mode === "find" && (typeof a.query !== "string" || !a.query.trim() || a.query.length > 80)))
    return toolFailure(name, null, { kind: "invalid_args" });
  if (path && deniedPath(path)) return toolFailure(name, null, { kind: "denied" });
  const controller = new AbortController(), deadline = Date.now() + 8000, timer = setTimeout(() => controller.abort(), 8000);
  const c: Call = { e, rp, deadline, signal: controller.signal };
  try {
    await gate(c);
    return name === "repo_file" ? await readFile(c, { ...a, mode }, path) : await commits(c, name, a, since, path);
  } catch (error) {
    const kind = error instanceof GitHubFailure ? error.kind : "upstream";
    const failure = toolFailure(name, null, { kind });
    return kind === "not_found" ? { ...failure, next_action: "核对仓库、ref、文件路径或提交号；可用 find 查找文件路径" } : failure;
  } finally { clearTimeout(timer); }
}
export const runRepoFile = (e: any, a: any) => runCloudRepoTool(e, "repo_file", a);
