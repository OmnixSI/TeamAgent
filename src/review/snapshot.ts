// D-3 capability snapshot: deterministic reads of switches, health, repo index and jobs.
// auth:* is probed for key existence only; its value is never selected.
import TEAM from "../../config/team.json";
import { SWITCH_KEYS } from "../rhythm";
import type { Snapshot } from "./types";

export type ToolCatalogEntry = {
  name: string;
  readonly: boolean;
  needs: ("runner" | "github_token" | "switch")[];
};

// D-2's catalog.ts replaces this table after rebase; signature stays the same.
export const PLACEHOLDER_CATALOG: ToolCatalogEntry[] = [
  { name: "repo_changes", readonly: true, needs: ["github_token"] },
  { name: "repo_commit", readonly: true, needs: ["github_token"] },
  { name: "repo_file", readonly: true, needs: ["github_token"] },
  { name: "get_project", readonly: true, needs: ["github_token"] },
  { name: "recall_memory", readonly: true, needs: [] },
  { name: "search_web", readonly: true, needs: [] },
  { name: "read_web", readonly: true, needs: [] },
  { name: "get_work_status", readonly: true, needs: [] },
  { name: "create_file_task", readonly: false, needs: ["runner"] },
  { name: "prepare_project_task", readonly: false, needs: ["runner"] },
  { name: "remember_correction", readonly: false, needs: ["switch"] },
];

export type HealthPoint = { health_at: number; gateway_ok: 0 | 1; runner_ok: 0 | 1 };

export async function healthAt(e: any, ts: number): Promise<HealthPoint | null> {
  const row = await e.DB.prepare(
    "SELECT at,gateway_ok,runner_ok FROM health_samples WHERE at <= ? ORDER BY at DESC LIMIT 1",
  ).bind(ts).first();
  return row
    ? { health_at: row.at, gateway_ok: row.gateway_ok ? 1 : 0, runner_ok: row.runner_ok ? 1 : 0 }
    : null;
}

export async function capabilitySnapshot(
  e: any,
  catalog: ToolCatalogEntry[] = PLACEHOLDER_CATALOG,
): Promise<Snapshot> {
  const now = Date.now();
  const offKeys = SWITCH_KEYS.filter((key) => key.startsWith("off:"));
  const authKeys = SWITCH_KEYS.filter((key) => key.startsWith("auth:"));
  const switches: Record<string, "on" | "off"> = {};

  const settings = offKeys.length
    ? (await e.DB.prepare(
        `SELECT key,value FROM settings WHERE key IN (${offKeys.map(() => "?").join(",")},?)`,
      ).bind(...offKeys, "runner_seen").all()).results
    : (await e.DB.prepare("SELECT key,value FROM settings WHERE key = ?").bind("runner_seen").all()).results;
  const values = new Map<string, string>(settings.map((row: any) => [row.key, row.value]));
  for (const key of offKeys) switches[key] = values.get(key) === "1" ? "off" : "on";

  if (authKeys.length) {
    // Literal keys: the SQL never selects the auth value, only the row's existence.
    const existing: any[] = (await e.DB.prepare(
      `SELECT key FROM settings WHERE key IN (${authKeys.map((key) => `'${key}'`).join(",")})`,
    ).all()).results;
    const present = new Set(existing.map((row) => row.key));
    for (const key of authKeys) switches[key] = present.has(key) ? "on" : "off";
  }

  const seen = Date.parse(values.get("runner_seen") || "");
  const health = await e.DB.prepare(
    "SELECT AVG(gateway_ok) AS gateway,AVG(runner_ok) AS runner FROM health_samples WHERE at >= ?",
  ).bind(now - 86_400_000).first();

  const states: any[] = (await e.DB.prepare(
    "SELECT repo,updated_at,checked_at FROM repo_state",
  ).all()).results;
  const stateByRepo = new Map(states.map((row) => [row.repo, row]));
  const commits: any[] = (await e.DB.prepare(
    "SELECT repo,COUNT(*) AS commits FROM repo_commits WHERE at >= ? GROUP BY repo",
  ).bind(now - 7 * 86_400_000).all()).results;
  const commitByRepo = new Map(commits.map((row) => [row.repo, Number(row.commits)]));

  const jobs: any[] = (await e.DB.prepare(
    `SELECT kind,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
     FROM jobs WHERE created_at >= ? GROUP BY kind ORDER BY kind`,
  ).bind(now - 86_400_000).all()).results;

  const repos = ((TEAM as any).repositories || []) as string[];
  return {
    at: now,
    switches,
    runner: {
      seen_age_s: Number.isFinite(seen) ? Math.max(0, Math.round((now - seen) / 1000)) : null,
      ok_ratio_24h: Number(health?.runner || 0),
    },
    gateway: { ok_ratio_24h: Number(health?.gateway || 0) },
    repo: repos.map((repo) => {
      const state = stateByRepo.get(repo);
      return {
        repo,
        state_age_s: state?.checked_at ? Math.max(0, Math.round((now - state.checked_at) / 1000)) : null,
        cache_age_s: state?.updated_at ? Math.max(0, Math.round((now - state.updated_at) / 1000)) : null,
        commits: commitByRepo.get(repo) || 0,
      };
    }),
    jobs_24h: jobs.map((row) => ({ kind: row.kind, failed: Number(row.failed || 0), done: Number(row.done || 0) })),
    tools_catalog: catalog.map((entry) => ({ ...entry, needs: [...entry.needs] })),
    release: e.RELEASE || "development",
  };
}
