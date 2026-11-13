import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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
for (const file of ["schema.sql", "migrations/0002_plan_authority.sql", "migrations/0003_stage_timings.sql", "migrations/0004_repo_index.sql", "migrations/0009_f6_schedules.sql", "migrations/0020_history_idx.sql", "migrations/0021_summaries.sql", "migrations/0022_profiles.sql", "migrations/0023_episodes.sql", "migrations/0025_tool_calls.sql", "migrations/0026_kb.sql", "migrations/0042_image_gen_log.sql"]) {
  const result = execute(readFileSync(file, "utf8"));
  if (file === "schema.sql") { ensureVideoWaitAttempts(execute); ensureVideoWaitPhase(execute); }
  console.log(file + ": " + result.length + " statements applied");
}
