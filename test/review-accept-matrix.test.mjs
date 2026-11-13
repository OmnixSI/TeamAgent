import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ITEMS, RUNNABLE, BLOCKED, SCRIPT_FILES } from "../scripts/review-accept/registry.mjs";
import { renderMatrix, matrixRows } from "../scripts/review-accept/matrix.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const acceptance = `${root}/.agent/releases/V-D-reflection-loop/acceptance.json`;

test("registry covers all 76 acceptance ids exactly once", () => {
  assert.equal(ITEMS.length, 76);
  assert.equal(new Set(ITEMS.map((item) => item.id)).size, 76);
  assert.equal(RUNNABLE.length, 18);
  assert.equal(BLOCKED.length, 58);
  assert.equal(RUNNABLE.length + BLOCKED.length, 76);
  for (const item of ITEMS) {
    assert.ok(item.id && item.scenario && item.packages && item.script, item.id);
    assert.ok(["run", "block"].includes(item.mode), item.id);
    if (item.mode === "block") assert.ok(item.blockedBy && item.blockedBy !== "D-?", `${item.id} blockedBy`);
    assert.ok(item.data, `${item.id} data`);
  }
  for (const file of SCRIPT_FILES) assert.ok(existsSync(`${root}/scripts/review-accept/${file}`), file);
});

test("registry matches the acceptance.json in the release folder", { skip: !existsSync(acceptance) }, () => {
  const ids = JSON.parse(readFileSync(acceptance, "utf8")).items.map((item) => item.id);
  assert.deepEqual(ITEMS.map((item) => item.id), ids);
});

test("accept-matrix renders one row per item", () => {
  const fake = ITEMS.map((item) => ({ item, id: item.id, status: item.mode === "run" ? "PASS" : "BLOCKED", blockedBy: item.blockedBy, detail: "x" }));
  const markdown = renderMatrix(fake, new Date("2026-11-14T00:00:00Z"));
  assert.equal(matrixRows(markdown), 76);
  for (const item of ITEMS) assert.ok(markdown.includes(`| ${item.id} |`), item.id);
  assert.match(markdown, /PASS 18 · FAIL 0 · BLOCKED 58/);
});

test("cli --list prints 76 items without running checks", () => {
  const out = spawnSync(process.execPath, ["scripts/review-accept.mjs", "--list"], { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(out.status, 0, out.stderr);
  const lines = out.stdout.trim().split("\n");
  assert.equal(lines.length, 77);
  assert.match(lines.at(-1), /^TOTAL 76 RUNNABLE 18 BLOCKED 58$/);
});
