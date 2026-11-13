/** Read-only discovery of the OmnixSI organisation's repositories.
 *
 * The worker never enumerates GitHub itself: the local runner already mirrors
 * `gh repo list OmnixSI` into D1 repo_cache (runner/bridge.py), so a newly
 * created repository becomes usable without editing config/team.json.
 * When repo_cache is unavailable the static config remains the fallback.
 */
import { INITIAL_PROJECT_HINTS, REPOS } from "./policy";
import { parseRepo, type RepoRef } from "./github";

export type RepoEntry = {
  full: string;
  aliases: string[];
  pushed_at: string | null;
  default_branch: string | null;
  indexed: boolean;
};
export type Catalog = { count: number; repos: RepoEntry[]; source: "repo_cache" | "config" | "mixed" };
export type RepoResolution = {
  ref: RepoRef | null;
  ambiguous: boolean;
  candidates: string[];
  picked?: "latest";
  next_action?: string;
};

const ORG_REPO = /^OmnixSI\/[A-Za-z0-9._-]{1,100}$/;
export function isOrgRepo(full: unknown): full is string {
  return typeof full === "string" && ORG_REPO.test(full) && !/\/\.{1,2}$/.test(full);
}
const fuzzyKey = (value: string) => String(value ?? "").replace(/[\s_-]+/g, "").toLowerCase();
// Keep GitHub's own ISO string so callers can quote it verbatim; only numeric
// timestamps are converted. Invalid values become null rather than "now".
const when = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && value.trim() && Number.isFinite(Date.parse(value))) return value.trim();
  return null;
};
function details(json: unknown) {
  try {
    const context: any = JSON.parse(String(json ?? ""));
    const metadata: any = context?.metadata && typeof context.metadata === "object" ? context.metadata : {};
    return {
      pushed_at: when(metadata.pushed_at) ?? when(context?.pushed_at) ?? when(context?.head?.at),
      default_branch: typeof metadata.default_branch === "string" && metadata.default_branch
        ? metadata.default_branch
        : typeof context?.default_branch === "string" && context.default_branch ? context.default_branch : null,
    };
  } catch {
    return { pushed_at: null, default_branch: null };
  }
}
function configuredAliases(aliases: Record<string, string[]>, repo: string) {
  const list = aliases?.[repo];
  return Array.isArray(list) ? list.filter((alias): alias is string => typeof alias === "string") : [];
}
export function catalog(rows: any[], aliases: Record<string, string[]> = INITIAL_PROJECT_HINTS): Catalog {
  const known = new Map<string, RepoEntry>();
  for (const repo of REPOS) {
    if (!isOrgRepo(repo)) continue;
    known.set(repo, { full: repo, aliases: [], pushed_at: null, default_branch: null, indexed: false });
  }
  let cached = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!isOrgRepo(row?.repo)) continue;
    const detail = details(row.json);
    known.set(row.repo, { full: row.repo, aliases: [], ...detail, indexed: true });
    cached++;
  }
  let missingConfig = false;
  for (const entry of known.values()) {
    entry.aliases = configuredAliases(aliases, entry.full);
    if (!entry.indexed && REPOS.includes(entry.full)) missingConfig = true;
  }
  const repos = [...known.values()].sort((a, b) =>
    (b.pushed_at || "").localeCompare(a.pushed_at || "") || a.full.localeCompare(b.full));
  return { count: repos.length, repos, source: cached === 0 ? "config" : missingConfig ? "mixed" : "repo_cache" };
}
export async function repoCatalog(e: any, aliases: Record<string, string[]> = INITIAL_PROJECT_HINTS): Promise<Catalog> {
  try {
    const rows = (await e.DB.prepare("SELECT repo,json,updated_at FROM repo_cache ORDER BY repo LIMIT 200").all()).results || [];
    return catalog(rows, aliases);
  } catch {
    return catalog([], aliases);
  }
}
export async function listRepos(e: any, aliases: Record<string, string[]> = INITIAL_PROJECT_HINTS) {
  const found = await repoCatalog(e, aliases);
  return { count: found.count, repos: found.repos };
}
function latest(cat: Catalog, candidates: string[]): string | null {
  const pushed = new Map(cat.repos.map(repo => [repo.full, repo.pushed_at || ""]));
  const ranked = candidates.map(full => ({ full, at: pushed.get(full) || "" }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.full.localeCompare(b.full));
  // A missing or tied timestamp is ambiguous; never silently pick one.
  if (!ranked.length || !ranked[0].at || ranked[1]?.at === ranked[0].at) return null;
  return ranked[0].full;
}
function fuzzyCandidates(cat: Catalog, value: unknown): string[] {
  const key = fuzzyKey(String(value ?? ""));
  if (!key) return [];
  return cat.repos.filter(repo => {
    const names = [repo.full.split("/")[1], ...repo.aliases].map(fuzzyKey).filter(name => name.length >= 2);
    return names.some(name => key === name || key.includes(name));
  }).map(repo => repo.full);
}
function ambiguous(candidates: string[]): RepoResolution {
  const unique = [...new Set(candidates)].sort();
  return { ref: null, ambiguous: true, candidates: unique, next_action: `请选 1/${unique.length}：${unique.join("、")}` };
}
export async function resolveRepoRef(e: any, value: unknown,
    options: { aliases?: Record<string, string[]>; repos?: Iterable<string>; text?: string; catalog?: Catalog } = {}): Promise<RepoResolution> {
  const aliases = options.aliases ?? INITIAL_PROJECT_HINTS;
  const listed = options.repos ?? REPOS;
  const quick = parseRepo(value, aliases, listed);
  if (quick && !quick.ambiguous) {
    // Configured repos and other owners keep the zero-query path; an OmnixSI
    // full name missing from config may still be a newly discovered repo.
    if (quick.listed || !/^OmnixSI\//i.test(quick.full))
      return { ref: quick, ambiguous: false, candidates: [] };
  }
  // A pure-Chinese phrase with no configured alias or ASCII name cannot name a
  // repository; answer invalid_args without spending a D1 read.
  if (!quick && !options.repos && !/[A-Za-z0-9]/.test(String(value ?? "")) &&
      !fuzzyCandidates(catalog([], aliases), value).length)
    return { ref: null, ambiguous: false, candidates: [] };
  const cat = options.catalog ?? await repoCatalog(e, aliases);
  const repos = options.repos ?? cat.repos.map(repo => repo.full);
  const ref = parseRepo(value, aliases, repos);
  if (ref && !ref.ambiguous) return { ref, ambiguous: false, candidates: [] };
  let candidates = ref?.ambiguous ? [...(ref.candidates || [])] : [];
  if (!ref) candidates = fuzzyCandidates(cat, value);
  if (!candidates.length) return { ref: null, ambiguous: false, candidates: [] };
  if (candidates.length === 1) {
    const single = parseRepo(candidates[0], aliases, repos);
    return single ? { ref: single, ambiguous: false, candidates: [] } : { ref: null, ambiguous: false, candidates: [] };
  }
  const wanted = `${String(value ?? "")} ${String(options.text ?? "")}`;
  if (/最新|最近|latest|newest/i.test(wanted)) {
    const pick = latest(cat, candidates);
    const chosen = pick ? parseRepo(pick, aliases, repos) : null;
    if (chosen) return { ref: chosen, ambiguous: false, candidates: [], picked: "latest" };
  }
  return ambiguous(candidates);
}
