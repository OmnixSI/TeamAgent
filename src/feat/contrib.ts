// Contributions beyond the task list: what each member does in the organisation's GitHub repositories
// (pull requests, issues, reviews, merges, direct commits) and picking tasks up, turned into points with
// daily limits. Also the "season": the moment the group's scoring was last started over; nothing before it
// counts. teamwork.ts reads all of this when it adds people's scores up.
import type { Hub } from "../hub.ts";
import { BJ, clip, fmtDate, zonedToUtc } from "../util.ts";
import { personOfName } from "./tasks.ts";

export type Kind = "pr_merged" | "pr_opened" | "issue" | "commit" | "review" | "merge" | "claim";
/** Points for one event of each kind and the most one person can get from that kind in a day (0 = no limit of its own). */
export const RULES: Record<Kind, { points: number; cap: number; name: string }> = {
  pr_merged: { points: 10, cap: 0, name: "PR 合并" },
  pr_opened: { points: 2, cap: 6, name: "开 PR" },
  issue: { points: 1, cap: 8, name: "写 issue" },          // 2 for one that describes the problem properly
  commit: { points: 0.5, cap: 3, name: "直接提交" },        // only commits that did not arrive through a merged pull request
  review: { points: 2, cap: 6, name: "审别人的 PR" },
  merge: { points: 1, cap: 3, name: "合别人的 PR" },
  claim: { points: 1, cap: 3, name: "接任务" },
};
export const DAY_CAP = 20;          // per person per day from all of the above together
const SYNC_EVERY = 30 * 60000;
const LOOK_BACK = 30 * 86400000;    // how far back a sync reads when no season has been started
const dayOf = (ts: number) => fmtDate(ts, BJ);
/** The tables are made on first use as well as at start-up, so a database that predates this module works. */
const ready = new WeakSet<object>();
function ensure(hub: Hub) {
  if (ready.has(hub)) return;
  ready.add(hub);
  for (const st of SCHEMA.split(";").map(x => x.trim()).filter(Boolean)) { try { hub.sql.exec(st); } catch (e: any) { console.log("contrib: schema", e?.message); } }
}
const q = (hub: Hub, sql: string, ...b: any[]) => { ensure(hub); return hub.sql.exec(sql, ...b).toArray() as any[]; };

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS team_login(conv TEXT NOT NULL, login TEXT NOT NULL, who TEXT NOT NULL, PRIMARY KEY(conv, login));
  CREATE TABLE IF NOT EXISTS team_gh(id TEXT NOT NULL, conv TEXT NOT NULL, login TEXT NOT NULL, kind TEXT NOT NULL, repo TEXT NOT NULL, num TEXT DEFAULT '',
    title TEXT DEFAULT '', url TEXT DEFAULT '', ts INTEGER NOT NULL, points REAL NOT NULL DEFAULT 0, PRIMARY KEY(conv, id));
  CREATE INDEX IF NOT EXISTS team_gh_ts ON team_gh(conv, ts);
`;

// ---------- the season ----------
/** When this group's scoring was last started over (0 = never: everything counts). */
export const sinceOf = (hub: Hub, conv: string): number => Number(hub.get("team:since:" + conv) || 0) || 0;
/** Starts the scoring over from `at`: tasks finished, points spent and repository work before it no longer count. */
export function restart(hub: Hub, conv: string, at: number, by = ""): number {
  hub.set("team:since:" + conv, String(Math.floor(at)));
  hub.set("team:since:by:" + conv, clip(by, 40));
  return Math.floor(at);
}

// ---------- GitHub accounts ----------
const low = (s: unknown) => String(s ?? "").trim().toLowerCase();
export function linkLogin(hub: Hub, conv: string, login: string, who: string): boolean {
  const l = low(login).replace(/^@/, ""), w = String(who || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(l) || !w) return false;
  ensure(hub);
  hub.sql.exec("INSERT INTO team_login(conv, login, who) VALUES(?,?,?) ON CONFLICT(conv, login) DO UPDATE SET who=excluded.who", conv, l, clip(w, 40));
  return true;
}
export function unlinkLogin(hub: Hub, conv: string, login: string): boolean {
  const had = q(hub, "SELECT 1 FROM team_login WHERE conv=? AND login=?", conv, low(login)).length > 0;
  hub.sql.exec("DELETE FROM team_login WHERE conv=? AND login=?", conv, low(login));
  return had;
}
export function logins(hub: Hub, conv: string): { login: string; who: string }[] {
  return q(hub, "SELECT login, who FROM team_login WHERE conv=? ORDER BY who, login", conv).map(r => ({ login: String(r.login), who: String(r.who) }));
}

// ---------- adding it up ----------
export type RepoEvent = { id: string; login: string; who: string; kind: Kind; repo: string; num: string; title: string; url: string; ts: number; points: number };
export type Activity = {
  who: string;
  week: number; total: number;                 // points that count, after the daily limits
  over_week: number; over_total: number;       // what the limits cut off: shown, never spendable
  kinds: Record<string, { n: number; points: number }>;   // this week, before limits
  last: number;
};
/** Everything since the season started that belongs to a known member, repository work and task claims alike, oldest first. */
export function events(hub: Hub, conv: string, now = Date.now()): RepoEvent[] {
  const since = sinceOf(hub, conv), who = new Map(logins(hub, conv).map(l => [l.login, l.who]));
  const out: RepoEvent[] = q(hub, "SELECT * FROM team_gh WHERE conv=? AND ts>=? AND ts<=? AND points>0 ORDER BY ts", conv, since, now)
    .filter(r => who.has(String(r.login)))
    .map(r => ({ id: String(r.id), login: String(r.login), who: who.get(String(r.login))!, kind: String(r.kind) as Kind, repo: String(r.repo), num: String(r.num || ""), title: String(r.title || ""), url: String(r.url || ""), ts: Number(r.ts), points: Number(r.points) }));
  // Picking a task up counts once per task, for whoever still holds it or finished it; one that was put back does not.
  let claims: any[] = [];
  try {
    claims = q(hub, "SELECT n.task, n.who, MIN(n.ts) ts, t.title, t.status, t.claimed_by, t.done_by FROM task_note n JOIN task t ON t.id=n.task AND t.conv=n.conv " +
      "WHERE n.conv=? AND n.kind='claim' AND n.ts>=? AND n.ts<=? AND t.status IN ('doing','done') GROUP BY n.task, n.who", conv, since, now);
  } catch {}
  const seen = new Set<string>();
  for (const c of claims) {
    const p = personOfName(String(c.who || ""));
    if (!(RULES.claim.points > 0)) break;
    if (!p || (personOfName(String(c.claimed_by || "")) !== p && String(c.done_by || "") !== p) || seen.has(c.task + ":" + p)) continue;
    seen.add(c.task + ":" + p);
    out.push({ id: "claim:" + c.task, login: "", who: p, kind: "claim", repo: "", num: String(c.task), title: String(c.title || ""), url: "", ts: Number(c.ts), points: RULES.claim.points });
  }
  return out.sort((a, b) => a.ts - b.ts);
}
/** Each member's points from this activity: per kind and per day the limits apply, what is over them is kept apart. */
export function activity(hub: Hub, conv: string, weekStart: number, now = Date.now()): Map<string, Activity> {
  const out = new Map<string, Activity>(), days = new Map<string, Map<string, number>>();
  for (const e of events(hub, conv, now)) {
    const a = out.get(e.who) || { who: e.who, week: 0, total: 0, over_week: 0, over_total: 0, kinds: {}, last: 0 };
    out.set(e.who, a);
    a.last = Math.max(a.last, e.ts);
    if (e.ts >= weekStart) { const k = a.kinds[e.kind] || (a.kinds[e.kind] = { n: 0, points: 0 }); k.n++; k.points += e.points; }
    const key = e.who + "|" + dayOf(e.ts), d = days.get(key) || new Map<string, number>();
    days.set(key, d);
    d.set(e.kind, (d.get(e.kind) || 0) + e.points);
    d.set("ts", Math.max(d.get("ts") || 0, e.ts));
  }
  for (const [key, d] of days) {
    const a = out.get(key.split("|")[0])!, ts = d.get("ts") || 0;
    let raw = 0, kept = 0;
    for (const [kind, sum] of d) { if (kind === "ts") continue; raw += sum; const cap = RULES[kind as Kind]?.cap || 0; kept += cap ? Math.min(sum, cap) : sum; }
    kept = Math.min(kept, DAY_CAP);
    a.total += kept; a.over_total += raw - kept;
    // The day belongs to the week its events fell in (a day is never split across two weeks: weeks start at Beijing midnight).
    if (ts >= weekStart) { a.week += kept; a.over_week += raw - kept; }
  }
  for (const a of out.values()) for (const k of ["week", "total", "over_week", "over_total"] as const) a[k] = Math.round(a[k] * 10) / 10;
  return out;
}
/** Repository work by accounts nobody has been matched to yet, so the owner can say whose they are. */
export function strangers(hub: Hub, conv: string): { login: string; events: number }[] {
  const known = new Set(logins(hub, conv).map(l => l.login));
  return q(hub, "SELECT login, COUNT(*) n FROM team_gh WHERE conv=? AND ts>=? AND points>0 GROUP BY login ORDER BY n DESC", conv, sinceOf(hub, conv))
    .filter(r => !known.has(String(r.login))).map(r => ({ login: String(r.login), events: Number(r.n) }));
}

// ---------- reading GitHub ----------
/** Seam the tests replace. */
export const deps = { gh: async (hub: Hub, path: string): Promise<any> => (await (await import("./preview.ts")).gh(hub.env, path)).data };   // loaded when used: that module pulls in the container runtime
const put = (hub: Hub, conv: string, e: { id: string; login: string; kind: string; repo: string; num?: string | number; title?: string; url?: string; ts: number; points: number }) => {
  if (!e.login || !Number.isFinite(e.ts)) return false;
  const before = q(hub, "SELECT 1 FROM team_gh WHERE conv=? AND id=?", conv, e.id).length;
  if (before) return false;
  ensure(hub);
  hub.sql.exec("INSERT INTO team_gh(id, conv, login, kind, repo, num, title, url, ts, points) VALUES(?,?,?,?,?,?,?,?,?,?)", e.id, conv, low(e.login), e.kind, e.repo, String(e.num ?? ""), clip(e.title || "", 160), clip(e.url || "", 300), Math.floor(e.ts), e.points);
  return true;
};
const robot = (u: any, ref = "") => !u?.login || u.type === "Bot" || /\[bot\]$/i.test(String(u.login)) || ref.startsWith("bot/");   // bot/… branches are the group bot's own work
/** How much an issue is worth: 2 when it describes the problem at some length in parts, 1 when it says something, 0 for a bare title. */
export function issuePoints(body: unknown): number {
  const b = String(body ?? "").trim();
  if (b.length < 30) return 0;
  return b.length >= 200 && b.split(/\n\s*\n|\n#+ |\n[-*] |\n\d+[.、] /).length >= 3 ? 2 : 1;
}
/**
 * Reads what happened in the organisation's repositories since the last look (or since the season started)
 * and records each thing once. Returns how many new events there were.
 */
export async function syncRepos(hub: Hub, conv: string, now = Date.now()): Promise<{ repos: number; added: number; errors: string[] }> {
  const org = String(hub.env.GITHUB_ORG || "OmnixSI"), since = sinceOf(hub, conv);
  const floor = Math.max(since, now - LOOK_BACK), last = Number(hub.get("team:gh:synced:" + conv) || 0);
  const from = Math.max(floor, last ? last - 2 * 3600000 : 0), iso = new Date(from).toISOString();
  const errors: string[] = [];
  let added = 0, repos: any[] = [];
  try { repos = await deps.gh(hub, "/orgs/" + org + "/repos?per_page=100&type=all"); } catch (e: any) { return { repos: 0, added: 0, errors: ["列不出组织的仓库：" + clip(e?.message || String(e), 120)] }; }
  for (const r of Array.isArray(repos) ? repos : []) {
    const name = String(r.name || ""), full = org + "/" + name;
    if (!name || r.archived || (r.pushed_at && Date.parse(r.pushed_at) < from - 86400000 && Date.parse(r.updated_at || r.pushed_at) < from - 86400000)) continue;
    try {
      const pulls: any[] = await deps.gh(hub, "/repos/" + full + "/pulls?state=all&sort=updated&direction=desc&per_page=50");
      for (const p of pulls) {
        if (Date.parse(p.updated_at) < from) break;
        const ref = String(p.head?.ref || ""), n = Number(p.number), author = low(p.user?.login);
        if (!robot(p.user, ref) && Date.parse(p.created_at) >= floor && put(hub, conv, { id: name + "#" + n + ":open", login: author, kind: "pr_opened", repo: name, num: n, title: p.title, url: p.html_url, ts: Date.parse(p.created_at), points: RULES.pr_opened.points })) added++;
        if (p.merged_at && Date.parse(p.merged_at) >= floor && !q(hub, "SELECT 1 FROM team_gh WHERE conv=? AND id=?", conv, name + "#" + n + ":done").length) {
          // The commits that came in with it are not counted a second time as direct commits, whoever opened it.
          const commits: any[] = await deps.gh(hub, "/repos/" + full + "/pulls/" + n + "/commits?per_page=100").catch(() => []);
          for (const c of commits) put(hub, conv, { id: name + "@" + c.sha, login: low(c.author?.login) || "-", kind: "in_pr", repo: name, num: n, ts: Date.parse(p.merged_at), points: 0 });
          const one = await deps.gh(hub, "/repos/" + full + "/pulls/" + n).catch(() => null);
          const merger = low(one?.merged_by?.login);
          if (!robot(p.user, ref) && put(hub, conv, { id: name + "#" + n + ":merged", login: author, kind: "pr_merged", repo: name, num: n, title: p.title, url: p.html_url, ts: Date.parse(p.merged_at), points: RULES.pr_merged.points })) added++;
          if (merger && merger !== author && !robot(one?.merged_by) && put(hub, conv, { id: name + "#" + n + ":merge", login: merger, kind: "merge", repo: name, num: n, title: p.title, url: p.html_url, ts: Date.parse(p.merged_at), points: RULES.merge.points })) added++;
          put(hub, conv, { id: name + "#" + n + ":done", login: "-", kind: "seen", repo: name, num: n, ts: Date.parse(p.merged_at), points: 0 });
        }
        // Reviews: one per reviewer per pull request, on someone else's work.
        const reviews: any[] = await deps.gh(hub, "/repos/" + full + "/pulls/" + n + "/reviews?per_page=100").catch(() => []);
        for (const v of reviews) {
          const who = low(v.user?.login), at = Date.parse(v.submitted_at);
          if (robot(v.user) || who === author || !(at >= floor) || !["APPROVED", "CHANGES_REQUESTED", "COMMENTED"].includes(String(v.state))) continue;
          if (put(hub, conv, { id: name + "#" + n + ":review:" + who, login: who, kind: "review", repo: name, num: n, title: p.title, url: v.html_url || p.html_url, ts: at, points: RULES.review.points })) added++;
        }
      }
      const issues: any[] = await deps.gh(hub, "/repos/" + full + "/issues?state=all&per_page=100&since=" + encodeURIComponent(iso));
      for (const i of issues) {
        const pts = issuePoints(i.body);
        if (i.pull_request || robot(i.user) || !(Date.parse(i.created_at) >= floor) || !pts) continue;
        if (put(hub, conv, { id: name + "#" + i.number + ":issue", login: low(i.user.login), kind: "issue", repo: name, num: i.number, title: i.title, url: i.html_url, ts: Date.parse(i.created_at), points: pts })) added++;
      }
      const commits: any[] = await deps.gh(hub, "/repos/" + full + "/commits?per_page=100&since=" + encodeURIComponent(iso));
      for (const c of commits) {
        const msg = String(c.commit?.message || "").split("\n")[0], at = Date.parse(c.commit?.author?.date || c.commit?.committer?.date || "");
        // Merge commits and squashed pull requests ("… (#12)") are the pull request's points, not a commit's.
        if ((c.parents || []).length > 1 || /\(#\d+\)\s*$/.test(msg) || robot(c.author) || !(at >= floor)) continue;
        if (put(hub, conv, { id: name + "@" + c.sha, login: low(c.author.login), kind: "commit", repo: name, num: String(c.sha).slice(0, 7), title: msg, url: c.html_url, ts: at, points: RULES.commit.points })) added++;
      }
    } catch (e: any) { errors.push(name + "：" + clip(e?.message || String(e), 100)); }
  }
  hub.set("team:gh:synced:" + conv, String(now));
  return { repos: Array.isArray(repos) ? repos.length : 0, added, errors };
}
/** Keeps the main group's repository activity fresh, a look every half hour. */
export function tick(hub: Hub, now: number) {
  const conv = String(hub.get("main") || "");
  // "busy" is a time, not a flag: a restart in the middle of a look must not leave it set for good.
  if (!conv || !logins(hub, conv).length || now - Number(hub.get("team:gh:synced:" + conv) || 0) < SYNC_EVERY || now - Number(hub.get("team:gh:busy") || 0) < 10 * 60000) return;
  hub.set("team:gh:busy", String(now));
  hub.ctx.waitUntil(syncRepos(hub, conv, now).catch(e => console.log("contrib: sync failed", e?.message)).finally(() => hub.set("team:gh:busy", "0")));
}
/** A Beijing date and time ("2026-11-15 21:56") as a moment; 0 when it cannot be read. */
export function parseWhen(s: unknown): number {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/.exec(String(s ?? "").trim());
  if (!m) return 0;
  const t = zonedToUtc(m[1], m[2].padStart(2, "0") + ":" + m[3], BJ);
  return Number.isFinite(t) ? t : 0;
}
