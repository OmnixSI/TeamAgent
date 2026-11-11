import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const name = process.env.TEAM_AGENT_D1 || "inkboard-team";
for (const file of ["schema.sql", "migrations/0002_plan_authority.sql"]) {
  const result = JSON.parse(
    execFileSync(
      "node_modules/.bin/wrangler",
      [
        "d1",
        "execute",
        name,
        "--remote",
        "--json",
        "--command=" + readFileSync(file, "utf8"),
      ],
      { encoding: "utf8" },
    ),
  );
  if (result.some((query) => !query.success))
    throw Error("Migration failed: " + file);
  console.log(file + ": " + result.length + " statements applied");
}
