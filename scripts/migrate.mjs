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
for (const file of ["schema.sql", "migrations/0002_plan_authority.sql", "migrations/0003_stage_timings.sql", "migrations/0004_repo_index.sql", "migrations/0005_event_layer.sql"]) {
  const result = execute(readFileSync(file, "utf8"));
  if (file === "schema.sql") { ensureVideoWaitAttempts(execute); ensureVideoWaitPhase(execute); }
  console.log(file + ": " + result.length + " statements applied");
}
