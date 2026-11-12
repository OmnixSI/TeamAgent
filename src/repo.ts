/** Read-only, bounded index of pushed code and workspace file statistics (C1). */
import { REPOS } from "./policy";
import { chunks } from "./d1";

export const REPO_TOOL_NAMES = new Set(["repo_changes", "repo_commit"]);
export const repoTools: any[] = [
  { type: "function", function: { name: "repo_changes", description: "查某仓库最近的提交、各分支进度、正在改但还没提交的文件。回答代码改动问题前先用它，答复带 7 位提交号。", parameters: { type: "object", properties: { repo: { type: "string", enum: REPOS }, since: { type: "string" }, author: { type: "string" }, path: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["repo"] } } },
  { type: "function", function: { name: "repo_commit", description: "查某个已推送提交的具体文件改动和脱敏代码节选。sha 为 7–40 位十六进制提交号。", parameters: { type: "object", properties: { repo: { type: "string", enum: REPOS }, sha: { type: "string", pattern: "^[0-9a-fA-F]{7,40}$" } }, required: ["repo", "sha"] } } },
];

// C2 moves this small compatible failure constructor into capabilities.ts.
const NEXT: Record<string, string> = { invalid_args: "参数不对，按正确格式再问", denied: "这是受保护内容，不提供", not_synced: "本机同步端还没上报过这个仓库，需要本机 runner 在线", not_found: "索引只有最近 90 天、每仓库 500 条已推送提交；更早的或未推送的要本机查（C3 上线后可派子代理）", ambiguous: "匹配到多个，请给更完整的编号或名字", upstream: "外部服务失败，可以换来源再试" };
export function toolFailure(_name: string, _err: unknown, extra: { kind?: string; detail?: string } = {}) {
  const kind = extra.kind || "upstream";
  return { ok: false, error_kind: kind, retryable: kind === "upstream", next_action: NEXT[kind] || NEXT.upstream, ...(extra.detail ? { detail: redactPatch(extra.detail).slice(0, 120) } : {}) };
}
export function redactPatch(s: string): string {
  return s.replace(/ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|(?:SESSDATA|bili_jct|DedeUserID__ckMd5|auth_token|ct0)=[^;\s]+/g, "[REDACTED]");
}
export function cutBytes(s: string, n: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= n) return s;
  let end = n;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
}
const text = (v: any, cap = 500) => redactPatch(typeof v === "string" ? v : "").slice(0, cap);
const number = (v: any) => typeof v === "number" && Number.isFinite(v) ? v : 0;
const sha40 = (v: any) => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
function files(value: any): any[] {
  return (Array.isArray(value) ? value : []).slice(0, 100).map(f => ({ path: text(f?.path, 4096), status: text(f?.status, 8), add: typeof f?.add === "number" ? Math.max(0, number(f.add)) : null, del: typeof f?.del === "number" ? Math.max(0, number(f.del)) : null, ...(f?.hidden === true ? { hidden: true } : {}) }));
}
function state(item: any) {
  return {
    head: { sha: sha40(item.head?.sha) ? item.head.sha.toLowerCase() : "", branch: text(item.head?.branch), at: number(item.head?.at) },
    branches: (Array.isArray(item.branches) ? item.branches : []).slice(0, 30).map((b: any) => ({ name: text(b?.name), sha: sha40(b?.sha) ? b.sha.toLowerCase() : "", ahead: number(b?.ahead), behind: number(b?.behind), at: number(b?.at) })),
    worktrees: (Array.isArray(item.worktrees) ? item.worktrees : []).slice(0, 20).map((w: any) => w?.skipReason === "filters_configured" ? { label: text(w?.label), skipReason: "filters_configured" } : ({ label: text(w?.label), branch: text(w?.branch), base: sha40(w?.base) ? w.base.toLowerCase() : "", files: files(w?.files), untracked: number(w?.untracked), updatedAt: number(w?.updatedAt) })),
  };
}
export async function ingestRepoIndex(e: any, body: any): Promise<{ ok: true; stored: number }> {
  const commits: any[][] = [], states: any[][] = [], unchanged: any[][] = [], now = Date.now();
  for (const item of (Array.isArray(body?.repos) ? body.repos : []).slice(0, 8)) {
    if (!REPOS.includes(item?.repo)) continue;
    const fingerprint = text(item.fingerprint, 128);
    if (item.unchanged === true) { unchanged.push([item.repo, fingerprint]); continue; }
    states.push([item.repo, JSON.stringify(state(item)), fingerprint, now, now]);
    for (const c of Array.isArray(item.commits) ? item.commits : []) {
      if (commits.length >= 30) break;
      if (!sha40(c?.sha)) continue;
      const original = typeof c.patch === "string" ? c.patch : "", redacted = redactPatch(original), patch = cutBytes(redacted, 12000);
      commits.push([item.repo, c.sha.toLowerCase(), number(c.at), text(c.author), text(c.subject), text(c.body, 500), JSON.stringify(files(c.files)), patch, c.truncated || patch !== redacted ? 1 : 0]);
    }
  }
  const statements: any[] = [];
  for (const group of chunks(commits, 11)) statements.push(e.DB.prepare("INSERT OR IGNORE INTO repo_commits(repo,sha,at,author,subject,body,files,patch,truncated) VALUES " + group.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")).bind(...group.flat()));
  if (states.length) statements.push(e.DB.prepare("INSERT INTO repo_state(repo,json,fingerprint,updated_at,checked_at) VALUES " + states.map(() => "(?,?,?,?,?)").join(",") + " ON CONFLICT(repo) DO UPDATE SET json=excluded.json,fingerprint=excluded.fingerprint,updated_at=excluded.updated_at,checked_at=excluded.checked_at").bind(...states.flat()));
  if (unchanged.length) statements.push(e.DB.prepare("UPDATE repo_state SET checked_at=? WHERE " + unchanged.map(() => "(repo=? AND fingerprint=?)").join(" OR ")).bind(now, ...unchanged.flat()));
  if (statements.length) await e.DB.batch(statements);
  return { ok: true, stored: commits.length };
}
function ago(at: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - number(at)) / 60000));
  return minutes < 1 ? "刚刚" : minutes < 60 ? minutes + " 分钟前" : minutes < 1440 ? Math.floor(minutes / 60) + " 小时前" : Math.floor(minutes / 1440) + " 天前";
}
function totals(rows: any[]) {
  return { files: rows.length, add: rows.reduce((n, r) => n + number(r.add), 0), del: rows.reduce((n, r) => n + number(r.del), 0), topFiles: rows.slice(0, 5).map(r => r.path) };
}
export async function runRepoTool(e: any, name: string, a: any): Promise<any> {
  if (!a || !REPOS.includes(a.repo) || !REPO_TOOL_NAMES.has(name)) return toolFailure(name, null, { kind: "invalid_args" });
  if (name === "repo_commit") {
    if (typeof a.sha !== "string" || !/^[0-9a-f]{7,40}$/i.test(a.sha)) return toolFailure(name, null, { kind: "invalid_args" });
    const rows = (await e.DB.prepare("SELECT * FROM repo_commits WHERE repo=? AND sha LIKE ? LIMIT 2").bind(a.repo, a.sha.toLowerCase() + "%").all()).results;
    if (!rows.length) return toolFailure(name, null, { kind: "not_found" });
    if (rows.length > 1) return toolFailure(name, null, { kind: "ambiguous" });
    const row = rows[0];
    return { sha: row.sha, author: row.author, at: row.at, subject: row.subject, body: row.body, files: JSON.parse(row.files), patch: row.patch, truncated: row.truncated, untrusted: true };
  }
  const since = a.since ?? "7d", limit = a.limit ?? 10;
  const duration: Record<string, number> = { "24h": 86400000, "3d": 3 * 86400000, "7d": 7 * 86400000 };
  const at = typeof since === "string" ? duration[since] ? Date.now() - duration[since] : /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(since) ? Date.parse(since) : NaN : NaN;
  if (!Number.isFinite(at) || !Number.isInteger(limit) || limit < 1 || limit > 20 || (a.author !== undefined && typeof a.author !== "string") || (a.path !== undefined && typeof a.path !== "string")) return toolFailure(name, null, { kind: "invalid_args" });
  const index = await e.DB.prepare("SELECT json,updated_at,checked_at FROM repo_state WHERE repo=?").bind(a.repo).first();
  if (!index) return toolFailure(name, null, { kind: "not_synced" });
  const scanLimit = a.author || a.path ? "" : " LIMIT 50";
  const rows = (await e.DB.prepare("SELECT sha,at,author,subject,files,truncated FROM repo_commits WHERE repo=? AND at>=? ORDER BY at DESC" + scanLimit).bind(a.repo, at).all()).results;
  const data = JSON.parse(index.json), age = Math.max(0, Math.floor((Date.now() - index.checked_at) / 60000)), stale = Date.now() - index.checked_at > 600000;
  return { repo: a.repo, indexedAt: index.updated_at, stale, ...(stale ? { staleReason: `本机同步端 ${age} 分钟没上报，以下是 ${age} 分钟前的状态` } : {}),
    head: { sha7: data.head.sha.slice(0, 7), at: data.head.at, ago: ago(data.head.at) },
    commits: rows.map((r: any) => ({ ...r, files: JSON.parse(r.files) })).filter((r: any) => (!a.author || r.author.toLowerCase().includes(a.author.toLowerCase())) && (!a.path || r.files.some((f: any) => f.path.startsWith(a.path)))).slice(0, limit).map((r: any) => ({ sha7: r.sha.slice(0, 7), author: r.author, ago: ago(r.at), subject: r.subject, ...totals(r.files) })),
    branches: data.branches.map((b: any) => ({ name: b.name, sha7: b.sha.slice(0, 7), ahead: b.ahead, behind: b.behind, ago: ago(b.at) })),
    inProgress: data.worktrees.map((w: any) => { if (w.skipReason === "filters_configured") return { label: w.label, skipReason: w.skipReason, summary: "已跳过：仓库配置了过滤器" }; const summary = totals(w.files); return { label: w.label, branch: w.branch, ...summary, untracked: w.untracked, summary: `+${summary.add}/−${summary.del}，另有 ${w.untracked} 个新文件未计行数`, ago: ago(w.updatedAt) }; }),
  };
}
export async function cleanupRepoIndex(e: any) {
  await e.DB.batch([
    e.DB.prepare("DELETE FROM repo_commits WHERE at<?").bind(Date.now() - 90 * 86400000),
    e.DB.prepare("DELETE FROM repo_commits WHERE rowid IN (SELECT rowid FROM (SELECT rowid,ROW_NUMBER() OVER (PARTITION BY repo ORDER BY at DESC) AS rn FROM repo_commits) WHERE rn>500)"),
  ]);
}
