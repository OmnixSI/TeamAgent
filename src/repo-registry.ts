import { INITIAL_PROJECT_HINTS, REPOS } from "./policy";

export const validRepoName = (repo: string) => /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo) &&
  ![".", ".."].includes(repo.split("/")[1]);
export const listedRepos = (e?: any): string[] => e?.repoRegistry?.repos ?? REPOS;
export const isListed = (e: any, repo: string): boolean => listedRepos(e).includes(repo);
export function projectHints(e: any): Record<string, string[]> {
  return Object.fromEntries(listedRepos(e).map(repo => [repo, INITIAL_PROJECT_HINTS[repo] ?? [repo.split("/")[1]]]));
}

/** One snapshot per chat round. Only runner-cached, exact-owner names extend access. */
export async function loadRepoRegistry(e: any, includeFacts = false) {
  if (e.repoRegistry) return e.repoRegistry;
  // Chat already needs these facts. Share its statement so a registry refresh
  // does not consume the last query reserved for a split QQ reply.
  const factRows = includeFacts ? ` UNION ALL SELECT 'fact',repo,
    json_object('id',id,'repo',repo,'subject',subject,'predicate',predicate,'value',value,'evidence',evidence,'status',status),NULL,0
    FROM (SELECT id,repo,subject,predicate,value,evidence,status FROM facts
      WHERE valid_to IS NULL ORDER BY valid_from DESC LIMIT 60)` : "";
  const rows = (await e.DB.prepare(`WITH names AS (
    SELECT value AS repo FROM json_each(?) UNION SELECT repo FROM repo_cache
  ) SELECT 'repo' AS kind,n.repo,c.json,c.updated_at,CASE WHEN s.repo IS NULL THEN 0 ELSE 1 END AS indexed
    FROM names n LEFT JOIN repo_cache c ON c.repo=n.repo LEFT JOIN repo_state s ON s.repo=n.repo` + factRows)
    .bind(JSON.stringify(REPOS)).all()).results;
  const visible = rows.filter((r: any) => r.kind === "repo" && (REPOS.includes(r.repo) ||
    r.json !== null && typeof r.repo === "string" && validRepoName(r.repo) && r.repo.split("/")[0] === "OmnixSI"));
  const repos = [...new Set<string>([...REPOS, ...visible.filter((r: any) => r.json !== null).map((r: any) => r.repo)])];
  e.repoRegistry = { repos, rows: visible, facts: rows.filter((r: any) => r.kind === "fact").map((r: any) => JSON.parse(r.json)) };
  return e.repoRegistry;
}

export async function repoList(e: any) {
  const registry = await loadRepoRegistry(e), aliases = projectHints(e);
  const repositories = registry.repos.map((repo: string) => {
    const row = registry.rows.find((r: any) => r.repo === repo);
    let metadata: any = {};
    try { metadata = JSON.parse(row?.json || "{}").metadata || {}; } catch { /* Keep a registered repo visible if its metadata is damaged. */ }
    return { repo, aliases: aliases[repo], private: typeof metadata.private === "boolean" ? metadata.private : null,
      pushed_at: typeof metadata.pushed_at === "string" ? metadata.pushed_at : null,
      description: typeof metadata.description === "string" ? metadata.description : null,
      indexed: !!row?.indexed, cache_updated_at: row?.updated_at ?? null };
  });
  const timestamps = repositories.map((r: any) => r.cache_updated_at).filter((t: any) => typeof t === "number");
  return { repositories, source: "config/team.json.repositories ∪ OmnixSI repo_cache (runner sync); indexed: repo_state",
    cache_updated_at: timestamps.length ? Math.max(...timestamps) : null, untrusted: true };
}
