import { execFileSync } from "node:child_process";
const sha = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    encoding: "utf8",
  }).trim()
)
  throw Error(
    "Commit tracked changes before deployment so the health version identifies exact source.",
  );
execFileSync(
  "node_modules/.bin/wrangler",
  ["deploy", "--var", "RELEASE:" + sha],
  { stdio: "inherit" },
);
