import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildReport, formatTable, formatTime, inspectClone, installedRunner, lastIndex, nextAction,
  parseD1Counts, parseSecretNames, remoteMatches,
} from "../scripts/verify-repo-data.mjs";

const TEAM = "OmnixSI/TeamAgent";
const NEW = "OmnixSI/peiwan-club-saas";

function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), "verify-repo-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const stateDir = path.join(home, ".inkboard-team");
  mkdirSync(stateDir, { recursive: true });
  const configPath = path.join(home, "team.json");
  return { home, stateDir, configPath };
}

function fakeRun({ cloned = [], counts = {}, secrets = ["GITHUB_TOKEN"], d1Error = null, secretsError = null } = {}) {
  return (command, args) => {
    if (command === "git") {
      const dir = args[1];
      const base = path.basename(dir);
      if (!cloned.includes(base)) throw new Error("not a git repository");
      if (args[2] === "rev-parse" && args[3] === "--show-toplevel") return dir + "\n";
      if (args[2] === "rev-parse" && args[3] === "HEAD") return "a".repeat(40) + "\n";
      if (args[2] === "config") {
        const repo = base === "TeamAgent" ? TEAM : "OmnixSI/" + base;
        return "https://github.com/" + repo + ".git\n";
      }
      throw new Error("unexpected git " + args.join(" "));
    }
    if (args[0] === "d1") {
      if (d1Error) throw Object.assign(new Error("d1 failed"), { stderr: d1Error });
      return JSON.stringify([{ results: Object.entries(counts).map(([repo, n]) => ({ repo, n })) }]);
    }
    if (args[0] === "secret") {
      if (secretsError) throw Object.assign(new Error("secret failed"), { stderr: secretsError });
      return JSON.stringify(secrets.map((name) => ({ name, type: "secret_text" })));
    }
    throw new Error("unexpected command " + command + " " + args.join(" "));
  };
}

test("D1 and secret JSON shapes are parsed defensively", () => {
  assert.deepEqual(parseD1Counts(JSON.stringify([{ results: [{ repo: TEAM, n: 158 }] }])), { [TEAM]: 158 });
  assert.deepEqual(parseD1Counts(JSON.stringify({ results: [{ repo: NEW, count: 2 }] })), { [NEW]: 2 });
  assert.deepEqual(parseSecretNames(JSON.stringify([{ name: "ADMIN_TOKEN" }, { name: "GITHUB_TOKEN" }])),
    ["ADMIN_TOKEN", "GITHUB_TOKEN"]);
  assert.deepEqual(parseSecretNames(JSON.stringify(["GITHUB_TOKEN"])), ["GITHUB_TOKEN"]);
  assert.deepEqual(parseSecretNames(JSON.stringify({ secrets: [{ name: "GITHUB_TOKEN" }] })), ["GITHUB_TOKEN"]);
  assert.throws(() => parseSecretNames("not json"));
});

test("remote matching accepts https and ssh but not another repository", () => {
  assert.equal(remoteMatches("https://github.com/" + TEAM + ".git", TEAM), true);
  assert.equal(remoteMatches("https://github.com/" + TEAM, TEAM), true);
  assert.equal(remoteMatches("git@github.com:" + TEAM + ".git", TEAM), true);
  assert.equal(remoteMatches("https://github.com/other/repo.git", TEAM), false);
});

test("a missing clone is reported without running the rest of the checks", (t) => {
  const { home } = fixture(t);
  const result = inspectClone(home, TEAM, fakeRun({ cloned: [] }));
  assert.equal(result.cloned, false);
  assert.match(result.problem, /missing/);
});

test("report shows a healthy repo and a missing repo with an actionable next step", (t) => {
  const { home, stateDir, configPath } = fixture(t);
  writeFileSync(configPath, JSON.stringify({ repositories: [TEAM, NEW] }));
  writeFileSync(path.join(stateDir, "repo-index-state.json"), JSON.stringify({
    [TEAM]: { ok: true, last_success_at: 1000, sent_at: 1000 },
    [NEW]: { ok: false, last_error: "clone failed: exit 1", last_success_at: null },
  }));
  const report = buildReport({
    configPath, home,
    run: fakeRun({ cloned: ["TeamAgent"], counts: { [TEAM]: 158 }, secrets: ["GITHUB_TOKEN"] }),
  });
  assert.equal(report.d1_ok, true);
  assert.equal(report.secrets_ok, true);
  const byRepo = Object.fromEntries(report.rows.map((row) => [row.repo, row]));
  assert.equal(byRepo[TEAM].configured, true);
  assert.equal(byRepo[TEAM].cloned, true);
  assert.equal(byRepo[TEAM].commit_rows, 158);
  assert.equal(byRepo[TEAM].worker_token, true);
  assert.equal(byRepo[TEAM].last_index_ok, true);
  assert.equal(byRepo[TEAM].next_action, "—");
  assert.equal(byRepo[NEW].cloned, false);
  assert.match(byRepo[NEW].next_action, /clone/);
  assert.equal(byRepo[NEW].last_index_ok, false);
});

test("D1 or secret failures become unknown cells, not exceptions", (t) => {
  const { home, stateDir, configPath } = fixture(t);
  writeFileSync(configPath, JSON.stringify({ repositories: [TEAM] }));
  writeFileSync(path.join(stateDir, "repo-index-state.json"), JSON.stringify({
    [TEAM]: { ok: true, last_success_at: 1000 },
  }));
  const d1Down = buildReport({
    configPath, home,
    run: fakeRun({ cloned: ["TeamAgent"], d1Error: "Authentication error" }),
  });
  assert.equal(d1Down.d1_ok, false);
  assert.equal(d1Down.rows[0].commit_rows, null);
  assert.match(d1Down.rows[0].next_action, /CLOUDFLARE_API_TOKEN/);

  const secretsDown = buildReport({
    configPath, home,
    run: fakeRun({ cloned: ["TeamAgent"], counts: { [TEAM]: 3 }, secrets: [], secretsError: "not logged in" }),
  });
  assert.equal(secretsDown.secrets_ok, false);
  assert.equal(secretsDown.rows[0].worker_token, null);
  assert.match(secretsDown.rows[0].next_action, /wrangler/);
});

test("state-only repositories are listed as not configured", (t) => {
  const { home, stateDir, configPath } = fixture(t);
  writeFileSync(configPath, JSON.stringify({ repositories: [TEAM] }));
  writeFileSync(path.join(stateDir, "repo-index-state.json"), JSON.stringify({ [NEW]: { ok: false } }));
  const report = buildReport({ configPath, home, run: fakeRun({ cloned: ["TeamAgent"] }) });
  const row = report.rows.find((item) => item.repo === NEW);
  assert.equal(row.configured, false);
  assert.match(row.next_action, /config\/team\.json/);
});

test("installed runner without clone logic is visible", (t) => {
  const { home, stateDir } = fixture(t);
  assert.deepEqual(installedRunner(home), { present: false, has_clone: false });
  writeFileSync(path.join(stateDir, "repo_index.py"), "def build():\n    print('clone missing')\n");
  assert.deepEqual(installedRunner(home), { present: true, has_clone: false });
  writeFileSync(path.join(stateDir, "repo_index.py"),
    "def _clone_once():\n    pass\n# ['gh', 'repo', 'clone']\n");
  assert.deepEqual(installedRunner(home), { present: true, has_clone: true });
});

test("table has a header, one line per repository and all values readable", (t) => {
  const { home, stateDir, configPath } = fixture(t);
  writeFileSync(configPath, JSON.stringify({ repositories: [TEAM, NEW] }));
  writeFileSync(path.join(stateDir, "repo-index-state.json"), JSON.stringify({
    [TEAM]: { ok: true, last_success_at: 1000 },
  }));
  const report = buildReport({
    configPath, home,
    run: fakeRun({ cloned: ["TeamAgent"], counts: { [TEAM]: 158 } }),
  });
  const text = formatTable(report);
  assert.match(text, /仓库/);
  assert.match(text, /repo_commits/);
  assert.match(text, /OmnixSI\/TeamAgent/);
  assert.match(text, /OmnixSI\/peiwan-club-saas/);
  assert.equal(text.split("\n").filter((line) => line.includes("OmnixSI/")).length, 2);
  assert.match(text, /install-local/);
  assert.equal(formatTime(0), "—");
  assert.equal(lastIndex({}, TEAM).at, null);
  assert.match(nextAction({ configured: true, cloned: true, last_index_at: 1, commit_rows: 0 }), /上报/);
});
