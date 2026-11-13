// D-8: run the workspace-side pull test suite. It exercises the real CLI
// against an in-process HTTP mock, writes both local artifacts twice, keeps
// human annotations, and prints an at-most-15-line morning report.
import { spawnSync } from "node:child_process";
import { assert } from "../harness.mjs";

let cached = null;

export async function vdPull() {
  if (!cached) {
    const result = spawnSync(process.execPath, ["--test", "test/review-pull.test.mjs"], {
      encoding: "utf8", timeout: 120_000,
    });
    const output = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (result.status !== 0) throw new Error(`D-8 review-pull tests failed (exit ${result.status}):\n${output.slice(-3000)}`);
    const pass = Number(output.match(/^ℹ pass (\d+)/m)?.[1] || 0);
    assert(pass >= 16, `D-8 review-pull pass=${pass}, expected >=16`);
    cached = { pass };
  }
  return {
    detail: `D-8 review-pull ${cached.pass} tests：CLI 生成 self-review/<date>.md + capability-gaps.md、晨报≤15 行、人工批注保留、0 群发、0 常驻进程`,
    evidence: [],
  };
}
