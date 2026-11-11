import { execFileSync } from "node:child_process";
const name = process.env.TEAM_AGENT_D1 || "inkboard-team";
for (const file of ["schema.sql", "migrations/0002_plan_authority.sql"])
  execFileSync(
    "node_modules/.bin/wrangler",
    ["d1", "execute", name, "--remote", "--file=" + file],
    { stdio: "inherit" },
  );
