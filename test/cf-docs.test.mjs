import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// CF-0: every agent reads AGENTS.md before working, so the billing premise must
// stay on Workers Paid. Historical records may keep the old wording only on a
// line that says it is history.
const OLD_PREMISE = /免费档|免费额度|50 ?查询|每次 ?50|保持免费/;
const docs = [
  "AGENTS.md",
  "README.md",
  "src/guide.ts",
  "docs/decisions.md",
  "docs/review.md",
  "docs/maintenance.md",
  "docs/operations.md",
  "docs/verification.md",
  "docs/c3-runner.md",
  "docs/fastlinks-p0a.md",
  "docs/fastlinks-p0b.md",
];

test("CF-0 docs no longer assume the free plan except where marked history", () => {
  for (const file of docs) {
    readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      if (!OLD_PREMISE.test(line)) return;
      assert.match(
        line,
        /历史|已升级/,
        `${file}:${index + 1} still states the free-plan premise without a history marker: ${line}`,
      );
    });
  }
  assert.match(readFileSync("AGENTS.md", "utf8"), /Workers Paid/);
  assert.match(readFileSync("AGENTS.md", "utf8"), /≤48/);
  assert.match(readFileSync("AGENTS.md", "utf8"), /≤200/);
  assert.match(readFileSync("docs/decisions.md", "utf8"), /1,000/);
  assert.match(readFileSync("docs/operations.md", "utf8"), /30 天/);
  assert.match(readFileSync("src/guide.ts", "utf8"), /\$5\/月/);
});

test("CF-4 Workers Logs stay on with 0.1 sampling and no invocation logs", () => {
  const wrangler = readFileSync("wrangler.toml", "utf8");
  const observability = wrangler.match(/\[observability\]([\s\S]*?)(?=\n\[|$)/);
  assert.ok(observability, "wrangler.toml is missing [observability]");
  assert.match(observability[1], /enabled\s*=\s*true/);
  assert.match(observability[1], /head_sampling_rate\s*=\s*0\.1/);
  const logs = wrangler.match(/\[observability\.logs\]([\s\S]*?)(?=\n\[|$)/);
  assert.ok(logs, "wrangler.toml is missing [observability.logs]");
  assert.match(logs[1], /invocation_logs\s*=\s*false/);
});
