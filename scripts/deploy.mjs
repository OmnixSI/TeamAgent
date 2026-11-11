import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout } from "node:timers/promises";
import { retryableDeployment } from "./deploy-policy.mjs";
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
for (let attempt = 0; attempt < 3; attempt++) {
  try {
    const result = await promisify(execFile)(
      "node_modules/.bin/wrangler",
      ["deploy", "--var", "RELEASE:" + sha],
      { encoding: "utf8", timeout: 120000, maxBuffer: 2000000 },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    break;
  } catch (error) {
    const output = String(error.stdout || "") + String(error.stderr || "");
    process.stdout.write(output);
    if (attempt === 2 || !retryableDeployment(output)) throw error;
    console.log(
      "D1 binding generation暂时不可用，稍后重试同一提交（" +
        (attempt + 2) +
        "/3）",
    );
    await setTimeout((attempt + 1) * 5000);
  }
}
