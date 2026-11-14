import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { ensureVideoWaitAttempts, ensureVideoWaitPhase } from "./migrate-video-waits.mjs";
const name = process.env.TEAM_AGENT_D1 || "inkboard-team";
function execute(command) {
  const result = JSON.parse(
    execFileSync(
      "node_modules/.bin/wrangler",
      [
        "d1",
        "execute",
        name,
        "--remote",
        "--json",
        "--command=" + command,
      ],
      { encoding: "utf8" },
    ),
  );
  if (result.some((query) => !query.success))
    throw Error("Migration failed");
  return result;
}
/** Idempotent upgrade: SQLite ALTER ADD COLUMN has no IF NOT EXISTS. */
export function ensureImageNotesProvider(execute) {
  const columns = execute("PRAGMA table_info(image_notes)").flatMap(q => q.results || []);
  if (!columns.some(c => c.name === "provider")) execute("ALTER TABLE image_notes ADD COLUMN provider TEXT NOT NULL DEFAULT 'workers_ai'");
  if (!columns.some(c => c.name === "model")) execute("ALTER TABLE image_notes ADD COLUMN model TEXT NOT NULL DEFAULT '@cf/meta/llama-3.2-11b-vision-instruct'");
}
if (import.meta.url === (process.argv[1] ? pathToFileURL(process.argv[1]).href : "")) {
  for (const file of ["schema.sql", "migrations/0002_plan_authority.sql", "migrations/0003_stage_timings.sql", "migrations/0004_repo_index.sql", "migrations/0008_review.sql", "migrations/0009_f6_schedules.sql", "migrations/0020_history_idx.sql", "migrations/0021_summaries.sql", "migrations/0022_profiles.sql", "migrations/0023_episodes.sql", "migrations/0025_tool_calls.sql", "migrations/0026_kb.sql", "migrations/0040_openai.sql", "migrations/0041_generated_images.sql", "migrations/0042_image_gen_log.sql", "migrations/0043_image_notes_provider.sql", "migrations/0044_image_cache.sql", "migrations/0060_ds_usage.sql", "migrations/0061_ds_balance.sql", "migrations/0070_feature_requests.sql"]) {
    const result = execute(readFileSync(file, "utf8"));
    if (file === "schema.sql") { ensureVideoWaitAttempts(execute); ensureVideoWaitPhase(execute); ensureImageNotesProvider(execute); }
    console.log(file + ": " + result.length + " statements applied");
  }
}
