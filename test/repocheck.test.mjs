// Offline tests for the nightly repository check: recipe choice, parsing of real runner output, the shell
// scripts (run for real in a temp directory, with a stand-in for `timeout`), storage, change detection,
// the once-a-day clock and the guarantee that the token never reaches a command text or a stored result.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const R = await import("../src/feat/repocheck.ts");
const feat = R.default;
const bj = (y, m, d, hh, mm = 0) => Date.UTC(y, m - 1, d, hh - 8, mm);

function fakeHub(over = {}) {
  const db = new DatabaseSync(":memory:"), kv = new Map(), said = [];
  const hub = {
    sql: { exec(q, ...b) { const st = db.prepare(q); if (/^\s*(SELECT|PRAGMA)/i.test(q)) return { toArray: () => st.all(...b) }; st.run(...b); return { toArray: () => [] }; } },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => { kv.set(k, String(v)); },
    env: { COMPUTER: {}, GITHUB_ORG: "OmnixSI", GITHUB_TOKEN_2: "ghp_" + "A".repeat(36), ...(over.env || {}) },
    plan: { left: () => over.cpuLeft ?? 15000, fits: () => over.fits ?? true, report: () => ({ cycle: "2026-11-13 到 2026-12-13" }) },
    say: async (c, t) => { said.push([c, t]); return true; },
    ctx: { waitUntil: p => { (hub.bg ||= []).push(p); } },
    said, kv,
  };
  db.exec(feat.schema.split(";")[0]);
  db.exec(feat.schema.split(";")[1]);
  return hub;
}

// ---------- real outputs ----------
const NODE_SPEC = `ℹ tests 399
ℹ suites 0
ℹ pass 386
ℹ fail 4
ℹ cancelled 0
ℹ skipped 9
ℹ todo 0
ℹ duration_ms 172460.506235

✖ failing tests:

test at test/codex.test.ts:120:1
✖ kills the Codex process group when the video summary is aborted (5064.402375ms)
  Error: 等待进程退出超时。
test at test/voice.test.ts:657:1
✖ closing the voice setup runner kills a script that ignores SIGTERM (1557.173532ms)
  Error: 等待进程退出超时。`;
const NODE_TAP = `1..4
# tests 4
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 1
# todo 0
# duration_ms 56.722042`;
const VITEST = ` Test Files  1 failed (1)
      Tests  1 failed | 2 passed | 1 skipped (4)
   Start at  05:03:28
   Duration  305ms (transform 13ms, setup 0ms, collect 6ms, tests 4ms, environment 0ms, prepare 51ms)`;
const VITEST_OK = ` Test Files  3 passed (3)
      Tests  17 passed (17)`;
const JEST = `Test Suites: 1 failed, 1 total
Tests:       1 failed, 1 skipped, 2 passed, 4 total
Snapshots:   0 total
Time:        0.152 s
Ran all test suites.`;
const PYTEST = `FAILED test_a.py::test_bad - assert 1 == 2
==================== 1 failed, 1 passed, 1 skipped in 0.02s ====================`;
const PYTEST_Q = `1 failed, 1 passed, 1 skipped in 0.01s`;
const PYTEST_OK = `..s                                                                      [100%]
2 passed, 1 skipped in 0.00s`;
const UNITTEST_BAD = `----------------------------------------------------------------------
Ran 3 tests in 0.000s

FAILED (failures=1, skipped=1)`;
const UNITTEST_OK = `Ran 3 tests in 0.000s

OK (skipped=1)`;

const LOG = `@@C|52500e4|Spdor|1794569395|chore: 发布 0.3.6

 7 files changed, 15 insertions(+), 6 deletions(-)
@@C|9ac18b4|Spdor|1794568719|docs/DESIGN：人物占可画区的阈值由 85% 改为 72%

 1 file changed, 3 insertions(+), 3 deletions(-)
@@C|aaa1111|Wang|1794554656|only deletions | with a bar

 2 files changed, 5 deletions(-)
@@C|bbb2222|Wang|1794549105|empty commit`;

describe("parsing test summaries", () => {
  test("node:test spec, with the failing list after the summary", () => {
    assert.deepEqual(R.parseCounts(NODE_SPEC), { n: 399, p: 386, f: 4, s: 9, runner: "node:test" });
  });
  test("node:test TAP", () => assert.deepEqual(R.parseCounts(NODE_TAP), { n: 4, p: 2, f: 1, s: 1, runner: "node:test" }));
  test("vitest", () => {
    assert.deepEqual(R.parseCounts(VITEST), { n: 4, p: 2, f: 1, s: 1, runner: "vitest" });
    assert.deepEqual(R.parseCounts(VITEST_OK), { n: 17, p: 17, f: 0, s: 0, runner: "vitest" });
  });
  test("jest", () => assert.deepEqual(R.parseCounts(JEST), { n: 4, p: 2, f: 1, s: 1, runner: "jest" }));
  test("pytest, with and without the ===== frame", () => {
    for (const t of [PYTEST, PYTEST_Q]) assert.deepEqual(R.parseCounts(t), { n: 3, p: 1, f: 1, s: 1, runner: "pytest" });
    assert.deepEqual(R.parseCounts(PYTEST_OK), { n: 3, p: 2, f: 0, s: 1, runner: "pytest" });
    assert.equal(R.parseCounts("============ no tests ran in 0.01s ============").n, 0);
  });
  test("unittest", () => {
    assert.deepEqual(R.parseCounts(UNITTEST_BAD), { n: 3, p: 1, f: 1, s: 1, runner: "unittest" });
    assert.deepEqual(R.parseCounts(UNITTEST_OK), { n: 3, p: 2, f: 0, s: 1, runner: "unittest" });
  });
  test("colour codes do not matter and unknown output gives null", () => {
    assert.equal(R.parseCounts("\u001b[32mℹ tests 5\u001b[39m\n\u001b[32mℹ pass 5\u001b[39m").p, 5);
    assert.equal(R.parseCounts("Found 0 errors. Watching for file changes."), null);
    assert.equal(R.parseCounts("added 120 packages in 12s"), null);
  });
  test("failure lines prefer the names of failed tests, then errors, then the last lines", () => {
    assert.deepEqual(R.failureLines(NODE_SPEC.split("\n")), [
      "✖ kills the Codex process group when the video summary is aborted (5064.402375ms)",
      "✖ closing the voice setup runner kills a script that ignores SIGTERM (1557.173532ms)",
    ]);
    assert.deepEqual(R.failureLines(["a", "src/x.ts(3,1): error TS2322: nope", "b"]), ["src/x.ts(3,1): error TS2322: nope"]);
    assert.deepEqual(R.failureLines(["l1", "l2", "l3"], 2), ["l2", "l3"]);
  });
});

describe("commit statistics and lines of code", () => {
  test("parseLog sums shortstat per author, including insertion-less and stat-less commits", () => {
    const c = R.parseLog(LOG);
    assert.equal(c.n, 4);
    assert.equal(c.files, 10);
    assert.equal(c.ins, 18);
    assert.equal(c.del, 14);
    assert.deepEqual(c.authors, [
      { name: "Spdor", n: 2, ins: 18, del: 9 },
      { name: "Wang", n: 2, ins: 0, del: 5 },
    ]);
    assert.equal(c.list[2].subject, "only deletions | with a bar");
    assert.equal(c.list[0].at, 1794569395000);
    assert.deepEqual(R.parseLog("").authors, []);
  });
  test("parseLoc maps extensions to languages and drops unknown ones", () => {
    const l = R.parseLoc("ts|1200|10\ntsx|300|4\njs|50|1\npy|700|3\nzzz|99999|9\nmd|20|2\n");
    assert.deepEqual(l.by, { TypeScript: 1500, Python: 700, JavaScript: 50, Markdown: 20 });
    assert.equal(l.total, 2270);
  });
});

describe("recipe selection", () => {
  test("every repository of the team has a table entry", () => {
    for (const r of R.DEFAULT_REPOS) assert.ok(R.TABLE[r], r);
    assert.equal(R.selectRecipe("WhalePartner", null).source, "table");
    assert.deepEqual(R.TABLE.WhalePartner.units.map(u => u.dir), ["apps/api", "apps/client"]);
    assert.match(R.TABLE.NextThought.note, /Swift/);
    assert.ok(R.TABLE["peiwan-club-saas"].units[0].steps.some(s => s.cmd === "pnpm --filter server test"));
  });
  test("heavy builds are marked slow (the website's one-second build is not)", () => {
    for (const [name, r] of Object.entries(R.TABLE)) for (const u of r.units) for (const s of u.steps) if (s.kind === "build" && name !== "NextThought-Website") assert.equal(s.slow, true, name);
  });
  const pkg = (path, scripts) => ({ path, scripts });
  test("unknown repository: package.json scripts with an npm lockfile", () => {
    const rec = R.selectRecipe("other", { files: ["package.json", "package-lock.json"], pkgs: [pkg("package.json", { test: "node --test", typecheck: "tsc", build: "vite build", lint: "eslint ." })], pytest: [], pyTests: 0 });
    assert.equal(rec.source, "package.json");
    assert.equal(rec.units[0].install.cmd, "npm ci --no-audit --no-fund");
    assert.deepEqual(rec.units[0].steps.map(s => s.id), ["typecheck", "test", "lint", "build"]);
    assert.equal(rec.units[0].steps[1].cmd, "npm run test");
    assert.equal(rec.units[0].steps[3].slow, true);
  });
  test("a check script that already runs the tests and typecheck replaces them", () => {
    const rec = R.selectRecipe("other", { files: ["package.json", "package-lock.json"], pkgs: [pkg("package.json", { check: "npm run typecheck && npm test", typecheck: "tsc --noEmit", test: "node --test" })], pytest: [], pyTests: 0 });
    assert.deepEqual(rec.units[0].steps.map(s => s.id), ["check"]);
  });
  test("pnpm lockfile, placeholder test script, no lockfile, no dependencies at all", () => {
    const pn = R.selectRecipe("o", { files: ["package.json", "pnpm-lock.yaml"], pkgs: [pkg("package.json", { test: "vitest run" })], pytest: [], pyTests: 0 });
    assert.match(pn.units[0].install.cmd, /pnpm install --frozen-lockfile/);
    assert.equal(pn.units[0].steps[0].cmd, "pnpm run test");
    const none = R.selectRecipe("o", { files: ["package.json"], pkgs: [pkg("package.json", { test: 'echo "Error: no test specified" && exit 1' })], pytest: [], pyTests: 0 });
    assert.equal(none.source, "none");
    const nolock = R.selectRecipe("o", { files: ["package.json", "sub/package-lock.json"], pkgs: [pkg("package.json", { test: "node t.js" })], pytest: [], pyTests: 0 });
    assert.match(nolock.units[0].install.cmd, /npm install/);
    const nodeps = R.selectRecipe("o", { files: ["package.json"], pkgs: [pkg("package.json", { check: "node c.js" })], pytest: [], pyTests: 0 });
    assert.equal(nodeps.units[0].install, undefined);
    const bun = R.selectRecipe("o", { files: ["package.json", "bun.lock"], pkgs: [pkg("package.json", { test: "bun test" })], pytest: [], pyTests: 0 });
    assert.match(bun.note, /bun/);
  });
  test("a package in a subfolder uses the lockfile next to it, else the root's", () => {
    const a = R.selectRecipe("o", { files: ["pnpm-lock.yaml", "web/package.json"], pkgs: [pkg("web/package.json", { test: "vitest" })], pytest: [], pyTests: 0 });
    assert.equal(a.units[0].dir, "web");
    assert.match(a.units[0].install.cmd, /pnpm/);
    const skipped = R.selectRecipe("o", { files: [], pkgs: [pkg("node_modules/x/package.json", { test: "x" }), pkg("docs/package.json", { test: "x" })], pytest: [], pyTests: 0 });
    assert.equal(skipped.units.length, 0);
  });
  test("pytest is detected from a hint, or from test files, and installs into a venv", () => {
    const hint = R.selectRecipe("py", { files: ["pyproject.toml", "requirements.txt"], pkgs: [], pytest: ["pyproject.toml"], pyTests: 4 });
    assert.equal(hint.source, "pytest");
    assert.match(hint.units[0].install.cmd, /uv pip install -q pytest -r requirements.txt/);
    assert.match(hint.units[0].steps[0].cmd, /-m pytest -q/);
    const files = R.selectRecipe("py", { files: [], pkgs: [], pytest: [], pyTests: 2 });
    assert.equal(files.source, "pytest");
  });
  test("nothing recognised: no steps and a plain explanation", () => {
    const rec = R.selectRecipe("empty", { files: ["Makefile"], pkgs: [], pytest: [], pyTests: 0 });
    assert.equal(rec.source, "none");
    assert.equal(rec.units.length, 0);
    assert.match(rec.note, /没认出/);
    assert.equal(R.selectRecipe("empty", null).source, "none");
  });
});

describe("time and CPU boxes", () => {
  test("boxSeconds never runs past the repository deadline", () => {
    assert.equal(R.boxSeconds(300, 480), 300);
    assert.equal(R.boxSeconds(300, 120.9), 120);
    assert.equal(R.boxSeconds(300, 9), 0);
    assert.equal(R.boxSeconds(30, 500), 30);
  });
  test("cpuAllowance spreads what is left over the days left", () => {
    assert.equal(R.cpuAllowance(14000, 20), 420);
    assert.equal(R.cpuAllowance(100, 0), 60);
    assert.equal(R.cpuAllowance(0, 10), 0);
  });
  test("planSteps keeps tests first and drops what does not fit", () => {
    const rec = R.TABLE.WhalePartner;
    const all = R.planSteps(rec, { builds: false });
    assert.deepEqual(all.units.map(u => u.steps.map(s => s.id)), [["test", "typecheck"], ["test", "typecheck"]]);
    assert.deepEqual(all.skipped.map(s => s.id), ["client:build"]);
    const tight = R.planSteps(rec, { builds: false, budget: 160 });
    assert.deepEqual(tight.units.map(u => u.label + ":" + u.steps.map(s => s.id)), ["api:test"]);
    assert.ok(tight.skipped.some(s => s.id === "api:typecheck" && /CPU/.test(s.why)));
    assert.ok(tight.estimate <= 160);
    const none = R.planSteps(rec, { builds: false, budget: 50 });
    assert.equal(none.units.length, 0);
    const withBuilds = R.planSteps(rec, { builds: true });
    assert.ok(withBuilds.units[1].steps.some(s => s.id === "build"));
  });
  test("the cycle's days left come from the plan's cycle text", () => {
    assert.equal(R.daysLeft("2026-11-13 到 2026-12-13", Date.UTC(2026, 10, 15, 12)), 28);
    assert.equal(R.daysLeft("garbage", 0), 15);
  });
});

describe("shell scripts", () => {
  const TOKEN = "ghp_" + "Z".repeat(36);
  test("the probe script reads the token from the environment only", () => {
    const s = R.buildProbeScript({ org: "OmnixSI", repo: "peiwan-club-saas", lastGood: "abc1234" });
    assert.ok(!s.includes(TOKEN));
    assert.match(s, /GIT_CONFIG_VALUE_0="Authorization: Basic \$\(printf 'x-access-token:%s' "\$GH_TOKEN" \| base64 -w0\)"/);
    assert.match(s, /http\.extraHeader/);
    assert.match(s, /https:\/\/github\.com\/OmnixSI\/peiwan-club-saas\.git/);
    assert.ok(!/https:\/\/[^/\s]*@/.test(s), "no credentials in a URL");
    assert.match(s, /--shallow-since='8 days ago'/);
    assert.match(s, /abc1234\.\.HEAD/);
  });
  test("the run script drops the token before anything runs and quotes every command", () => {
    const s = R.buildRunScript({ repo: "WhalePartner", units: [{ label: "a", dir: "apps/a", install: { cmd: "echo 'hi' && npm ci", limit: 60, cpu: 1 }, steps: [{ id: "test", cmd: "it's \"fine\"", kind: "test", limit: 30, cpu: 1 }] }] });
    assert.ok(s.indexOf("unset GH_TOKEN") < s.indexOf("step 'a:install'"));
    assert.ok(s.includes(`'echo '\\''hi'\\'' && npm ci'`));
    assert.ok(s.includes(`'it'\\''s "fine"'`));
    assert.ok(!/GH_TOKEN"/.test(s.replace(/unset GH_TOKEN[^\n]*/, "")));
    assert.match(s, /tail -n 40/);
    assert.match(s, /TZ=Asia\/Shanghai/);
  });
  test("dependencies of a finished unit are removed before the next unit installs (4 GB disk)", () => {
    const two = R.buildRunScript({ repo: "W", units: R.TABLE.WhalePartner.units });
    assert.equal(two.match(/-name node_modules -prune/g).length, 1);
    assert.match(two, /find "\$R\/apps\/api" -maxdepth 2 -name node_modules/);
    assert.ok(two.indexOf("find ") < two.indexOf("'client:install'"));
  });
  test("names that could smuggle shell are refused", () => {
    for (const bad of ["a;rm -rf /", "x y", "$(id)", "../etc", "", "a'b"]) {
      assert.throws(() => R.buildProbeScript({ org: "OmnixSI", repo: bad }), /不合法/);
      assert.throws(() => R.buildRunScript({ repo: bad, units: [] }), /不合法/);
      assert.throws(() => R.cleanupScript(bad), /不合法/);
    }
    assert.doesNotThrow(() => R.buildProbeScript({ org: "OmnixSI", repo: "NextThought-Website" }));
    assert.ok(!R.buildProbeScript({ org: "OmnixSI", repo: "r", lastGood: "x; rm -rf /" }).includes("rm -rf /"));
  });
  test("scrub removes the token in every shape it could take", () => {
    const t = "https://x:" + TOKEN + "@github.com and " + btoa("x-access-token:" + TOKEN) + " and github_pat_" + "q".repeat(30);
    const out = R.scrub(t, TOKEN);
    assert.ok(!out.includes(TOKEN) && !out.includes(btoa("x-access-token:" + TOKEN)) && !out.includes("github_pat_q"));
  });

  // The run script executed for real against a temp directory. `timeout` and /proc/stat do not exist on a Mac.
  describe("running the generated script", () => {
    let dir, env;
    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-"));
      fs.mkdirSync(path.join(dir, "bin"));
      fs.writeFileSync(path.join(dir, "bin", "timeout"), `#!/bin/bash\nshift 2; secs=$1; shift\n"$@" & pid=$!\n( sleep "$secs"; kill -TERM $pid 2>/dev/null ) & w=$!\nwait $pid; c=$?; kill $w 2>/dev/null\n[ $c -ge 128 ] && exit 124\nexit $c\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(dir, "stat"), "cpu  100 0 200 5000 0 0 0 0\n");
      env = { ...process.env, PATH: path.join(dir, "bin") + ":" + process.env.PATH, GH_TOKEN: TOKEN };
    });
    const run = (script, repo) => {
      const text = script.replaceAll("/work/repocheck", dir + "/work").replaceAll("/proc/stat", dir + "/stat");
      fs.mkdirSync(dir + "/work/" + repo, { recursive: true });
      return text;
    };
    test("install, pass, fail, timeout, skipped after a failed install, and cleanup", () => {
      const units = [
        { label: "api", dir: "sub", install: { cmd: "echo installing; echo token=${GH_TOKEN:-gone}", limit: 20, cpu: 1 }, steps: [
          { id: "test", cmd: "printf 'ℹ tests 3\\nℹ pass 2\\nℹ fail 1\\nℹ cancelled 0\\nℹ skipped 0\\n'; seq 1 60; echo '✖ boom (1ms)'; exit 1", kind: "test", limit: 20, cpu: 1 },
          { id: "typecheck", cmd: "echo fine", kind: "typecheck", limit: 20, cpu: 1 },
          { id: "slowone", cmd: "sleep 4", kind: "other", limit: 1, cpu: 1 },
        ] },
        { label: "bad", dir: ".", install: { cmd: "echo nope >&2; exit 3", limit: 20, cpu: 1 }, steps: [{ id: "test", cmd: "echo never", kind: "test", limit: 20, cpu: 1 }] },
      ];
      const script = run(R.buildRunScript({ repo: "demo", units, total: 120 }), "demo");
      fs.mkdirSync(dir + "/work/demo/sub", { recursive: true });
      execFileSync("bash", ["-c", script], { env, cwd: dir, stdio: "pipe" });
      const out = fs.readFileSync(dir + "/work/demo.b.txt", "utf8");
      assert.ok(!out.includes(TOKEN), "token must not reach repository code");
      assert.match(out, /token=gone/);
      const parsed = R.parseRun(out);
      assert.deepEqual(parsed.steps.map(s => [s.name, s.code]), [["api:install", "0"], ["api:test", "1"], ["api:typecheck", "0"], ["api:slowone", "124"], ["bad:install", "3"], ["bad:test", "skip"]]);
      const test = parsed.steps[1];
      assert.equal(test.tail.length, 40, "tail trimmed to the last 40 lines");
      assert.equal(test.tail.at(-1), "✖ boom (1ms)");
      assert.ok(test.sum.includes("ℹ tests 3"), "counts survive even when they are far from the end");
      const res = R.stepResult("api:test", "test", test);
      assert.deepEqual([res.s, res.c.n, res.c.f], ["fail", 3, 1]);
      assert.equal(R.stepResult("api:slowone", "other", parsed.steps[3]).s, "timeout");
      assert.equal(R.stepResult("bad:test", "test", parsed.steps[5]).x, "安装没成功");
      assert.equal(parsed.cpu, 0);
      assert.ok(parsed.wall >= 1);
      assert.equal(fs.existsSync(dir + "/work/demo"), false, "the clone is deleted afterwards");
    });
    test("a missing clone directory is reported, not crashed on", () => {
      const script = R.buildRunScript({ repo: "gone", units: [], total: 60 }).replaceAll("/work/repocheck", dir + "/work");
      fs.mkdirSync(dir + "/work", { recursive: true });
      execFileSync("bash", ["-c", script], { env, cwd: dir });
      assert.match(R.parseRun(fs.readFileSync(dir + "/work/gone.b.txt", "utf8")).err, /不见了/);
    });
    test("the probe script writes its report on a clone failure", () => {
      const script = R.buildProbeScript({ org: "OmnixSI", repo: "nope" }).replaceAll("/work/repocheck", dir + "/work").replace(/git clone/g, "false git clone");
      // a git stand-in that fails like an unreachable remote
      fs.writeFileSync(dir + "/bin/git", "#!/bin/sh\necho 'fatal: could not read from remote' >&2\nexit 128\n", { mode: 0o755 });
      execFileSync("bash", ["-c", script.replace(/false git clone/g, "git clone")], { env, cwd: dir });
      const p = R.parseProbe(fs.readFileSync(dir + "/work/nope.a.txt", "utf8"));
      assert.match(p.err, /克隆失败.*could not read/);
    });
  });
});

describe("probe and run parsing", () => {
  test("parseProbe reads every section", () => {
    const text = `@@CLONE|7
@@HEAD|52500e48ed8cc33b603ea8e9f96cd9b7759c673a|Spdor|1794569395|chore: 发布 0.3.6 | extra
@@BRANCH|main
@@LOG24
${LOG.split("\n").slice(0, 6).join("\n")}
@@LOG7
${LOG}
@@BRANCHES|8
@@LOC
ts|1200|10
@@FILES
package.json
apps/api/package.json
@@PKG|package.json|{"scripts":{"test":"node --test"},"workspaces":false}
@@PKG|broken/package.json|
@@HINT|pytest|pyproject.toml
@@PYTESTS|3
@@SINCEGOOD
@@C|ccc3333|Wang|1794569000|fix
@@DISK|66`;
    const p = R.parseProbe(text);
    assert.equal(p.head.sha.length, 40);
    assert.equal(p.head.msg, "chore: 发布 0.3.6 | extra");
    assert.equal(p.branch, "main");
    assert.equal(p.c24.n, 2);
    assert.equal(p.c7.n, 4);
    assert.equal(p.branches, 8);
    assert.equal(p.loc.total, 1200);
    assert.deepEqual(p.manifest.files, ["package.json", "apps/api/package.json"]);
    assert.deepEqual(p.manifest.pkgs.map(x => [x.path, x.scripts.test]), [["package.json", "node --test"], ["broken/package.json", undefined]]);
    assert.deepEqual(p.manifest.pytest, ["pyproject.toml"]);
    assert.equal(p.manifest.pyTests, 3);
    assert.equal(p.sinceGood.n, 1);
    assert.equal(p.diskMb, 66);
    assert.equal(R.parseProbe("@@SINCEGOOD|missing").sinceGood, "missing");
    assert.match(R.parseProbe("@@ERR|clone|fatal: repository not found").err, /克隆失败：fatal/);
  });
});

describe("summary size", () => {
  const big = () => ({
    v: 1, repo: "r", src: "table", builds: false,
    steps: [
      { id: "a:install", k: "other", s: "pass", t: 1, tail: Array(40).fill("x".repeat(200)) },
      { id: "a:test", k: "test", s: "fail", t: 2, tail: Array(40).fill("y".repeat(200)) },
      { id: "b:test", k: "test", s: "fail", t: 2, tail: Array(40).fill("z".repeat(200)) },
    ],
    c24: { n: 1, files: 1, ins: 1, del: 1, au: Array.from({ length: 30 }, (_, i) => ({ name: "n" + i, n: 1, ins: 1, del: 1 })) },
  });
  test("trimSummary shrinks to the cap, keeping the newest failure lines", () => {
    const s = R.trimSummary(big(), 6000);
    assert.ok(JSON.stringify(s).length <= 6000);
    assert.equal(s.steps[0].tail, undefined);
    assert.ok(s.steps[1].tail.length >= 1 || s.steps[2].tail === undefined);
  });
  test("a small summary is left alone", () => {
    const s = { v: 1, repo: "r", src: "none", builds: false, steps: [{ id: "x", k: "test", s: "fail", t: 1, tail: ["a", "b"] }] };
    assert.deepEqual(R.trimSummary(JSON.parse(JSON.stringify(s))), s);
  });
  test("tails are cut to 40 lines of 200 characters when a step result is made", () => {
    const r = R.stepResult("a:test", "test", { name: "a:test", code: "1", secs: 3, note: "30", sum: [], tail: Array.from({ length: 90 }, (_, i) => "line" + i + "x".repeat(300)) });
    assert.equal(r.tail.length, 40);
    assert.ok(r.tail.every(l => l.length <= 200));
    assert.ok(r.tail[39].startsWith("line89"));
  });
});

describe("judging and change detection", () => {
  const st = (id, k, s, c) => ({ id, k, s, t: 1, ...(c ? { c } : {}) });
  test("judge", () => {
    assert.equal(R.judge([st("t", "test", "pass"), st("c", "typecheck", "pass")]), 1);
    assert.equal(R.judge([st("t", "test", "fail"), st("c", "typecheck", "pass")]), 0);
    assert.equal(R.judge([st("t", "test", "pass"), st("c", "typecheck", "fail")]), 0);
    assert.equal(R.judge([st("t", "test", "skip"), st("c", "typecheck", "pass")]), null, "tests skipped: cannot call it passing");
    assert.equal(R.judge([st("t", "test", "timeout")]), null);
    assert.equal(R.judge([st("t", "test", "pass"), st("b", "build", "skip")]), 1);
    assert.equal(R.judge([]), null);
    assert.equal(R.judge([st("t", "test", "pass")], "克隆失败"), null);
  });

  const row = (id, ok, sha, ts, extra = {}) => ({ id, repo: "r", ts, sha, ok, summary: { v: 1, repo: "r", sha, src: "table", builds: false, steps: [st("a:test", "test", ok === 0 ? "fail" : "pass", { n: 10, p: ok === 0 ? 8 : 10, f: ok === 0 ? 2 : 0, s: 0, runner: "node:test" })], ...extra } });
  test("episode: first failing row after the last pass, ignoring runs that could not tell", () => {
    const rows = [row(6, 0, "f"), row(5, null, "e"), row(4, 0, "d"), row(3, 1, "c"), row(2, 0, "b"), row(1, 1, "a")];
    const ep = R.episode(rows);
    assert.equal(ep.first.id, 4);
    assert.equal(ep.good.id, 3);
    assert.equal(R.episode([row(2, 1, "b"), row(1, 0, "a")]), null);
    assert.equal(R.episode([row(2, null, "b"), row(1, 1, "a")]), null);
    assert.equal(R.episode([]), null);
  });
  test("pendingAnnouncement: only pass→fail, only once, never for a first-ever failure", () => {
    const fail = [row(2, 0, "b"), row(1, 1, "a")];
    assert.equal(R.pendingAnnouncement(fail, 0).first.id, 2);
    assert.equal(R.pendingAnnouncement(fail, 2), null, "already told");
    assert.equal(R.pendingAnnouncement([row(3, 0, "c"), row(2, 0, "b"), row(1, 1, "a")], 2), null, "still the same failure");
    assert.equal(R.pendingAnnouncement([row(2, 0, "b"), row(1, 0, "a")], 0), null, "never passed before");
    assert.equal(R.pendingAnnouncement([row(2, 1, "b"), row(1, 1, "a")], 0), null);
    assert.equal(R.pendingAnnouncement([row(4, 0, "d"), row(3, 1, "c"), row(2, 0, "b"), row(1, 1, "a")], 2).first.id, 4, "a new failure after another pass is news again");
  });
  test("the announcement names the repository, the failing step, the first lines and the suspects", () => {
    const failed = row(2, 0, "bbbbbbb1111", bj(2026, 11, 15, 2, 50));
    failed.summary.steps[0].tail = NODE_SPEC.split("\n");
    failed.summary.head = { msg: "break things", author: "Wang", at: 0 };
    failed.summary.good = { sha: "aaaaaaa", ts: 0, since: [{ sha: "bbbbbbb", author: "Wang", subject: "break things" }] };
    const good = row(1, 1, "aaaaaaa2222", bj(2026, 11, 14, 2, 50));
    const text = R.announcementText({ first: failed, good, last: failed });
    assert.match(text, /「r」夜里的检查从通过变成了失败/);
    assert.match(text, /a 测试没过，8 通过、2 失败/);
    assert.match(text, /✖ kills the Codex process group/);
    assert.match(text, /只有一个提交，多半就是它：bbbbbbb Wang：break things/);
    failed.summary.good.since = Array.from({ length: 6 }, (_, i) => ({ sha: "c" + i, author: "A", subject: "s" + i }));
    assert.match(R.announcementText({ first: failed, good, last: failed }), /这中间有 6 个提交/);
    failed.summary.good.since = "missing";
    assert.match(R.announcementText({ first: failed, good, last: failed }), /已经不在拉下来的历史里/);
  });
  test("changesBetween", () => {
    assert.match(R.changesBetween(undefined, row(1, 1, "a"))[0], /第一次/);
    const same = R.changesBetween(row(1, 1, "a", bj(2026, 11, 14, 3)), row(2, 1, "a", bj(2026, 11, 15, 3)));
    assert.match(same[0], /一样/);
    const bad = R.changesBetween(row(1, 1, "aaaaaaa1", bj(2026, 11, 14, 3)), row(2, 0, "bbbbbbb1", bj(2026, 11, 15, 3)));
    assert.ok(bad.some(l => /通过，这次没通过/.test(l)));
    assert.ok(bad.some(l => /提交从 aaaaaaa 变成 bbbbbbb/.test(l)));
    assert.ok(bad.some(l => /测试：通过 → 没过|a 测试：过了 → 没过/.test(l)));
  });
});

// ---------- the whole check with a stand-in for the cloud computer ----------
const enc = s => new TextEncoder().encode(s);
const PROBE_OUT = (sha = "5".repeat(40)) => `@@CLONE|5
@@HEAD|${sha}|Wang|${Math.floor(Date.now() / 1000)}|add a thing
@@BRANCH|main
@@LOG24
@@C|abc1234|Wang|1794569395|add a thing

 2 files changed, 10 insertions(+), 1 deletion(-)
@@LOG7
@@C|abc1234|Wang|1794569395|add a thing

 2 files changed, 10 insertions(+), 1 deletion(-)
@@C|def5678|Li|1794569000|other

 1 file changed, 3 insertions(+)
@@BRANCHES|4
@@LOC
ts|900|9
@@FILES
package.json
package-lock.json
@@PKG|package.json|{"scripts":{"test":"node --test","typecheck":"tsc --noEmit"}}
@@PYTESTS|0
@@DISK|3
`;
const RUN_OUT = (testCode, extra = "") => `@@STEP|bot:install|0|20|240
added 200 packages
@@SUM
@@END
@@STEP|bot:typecheck|0|8|180
@@SUM
@@END
@@STEP|bot:test|${testCode}|9|180
${testCode === 0 ? "ℹ tests 61\nℹ pass 61\nℹ fail 0\n" : "✖ the broken one (2ms)\n  Error: nope\n" + extra}
@@SUM
ℹ tests 61
ℹ pass ${testCode === 0 ? 61 : 60}
ℹ fail ${testCode === 0 ? 0 : 1}
@@END
@@CPU|40|45|300
`;

function boxFor(hub, opts = {}) {
  const calls = [];
  R.hooks.run = async (h, req) => {
    calls.push(req);
    const cmd = req.commands[0];
    if (opts.fail && calls.length === 1) throw new Error(opts.fail);
    if (/@@CLONE/.test(cmd)) return { ok: true, steps: [], files: [{ name: "repocheck/TeamAgent.a.txt", bytes: enc(PROBE_OUT(opts.sha)) }] };
    if (/@@STEP/.test(cmd)) return { ok: true, steps: [], files: [{ name: "repocheck/TeamAgent.b.txt", bytes: enc(RUN_OUT(opts.testCode ?? 0, opts.leak || "")) }] };
    return { ok: true, steps: [], files: [] };
  };
  R.hooks.fetch = async () => ({ ok: true, status: 200, json: async () => [{ sha: opts.sha || "5".repeat(40) }] });
  return calls;
}

describe("checkRepo with a fake cloud computer", () => {
  test("a passing run is stored with steps, counts, commits and lines of code", async () => {
    const hub = fakeHub(), calls = boxFor(hub);
    const { row, ran } = await R.checkRepo(hub, "TeamAgent", { force: true });
    assert.equal(ran, true);
    assert.equal(row.ok, 1);
    assert.equal(calls.length, 2);
    const s = row.summary;
    assert.deepEqual(s.steps.map(x => [x.id, x.s]), [["bot:install", "pass"], ["bot:typecheck", "pass"], ["bot:test", "pass"]]);
    assert.equal(s.steps[2].c.n, 61);
    assert.equal(s.c24.n, 1);
    assert.equal(s.c7.n, 2);
    assert.deepEqual(s.c7.au.map(a => a.name), ["Li", "Wang"]);
    assert.equal(s.br, 4);
    assert.equal(s.loc.total, 900);
    assert.equal(s.cpu, 40);
    const stored = R.recentRows(hub, "TeamAgent");
    assert.equal(stored.length, 1);
    assert.equal(stored[0].ok, 1);
    const d = R.describe(stored);
    assert.equal(d.result, "通过");
    assert.equal(d.commits_24h.count, 1);
    assert.match(d.steps.find(x => x.step === "bot 测试").tests, /61 通过/);
  });
  test("the token goes to the first command's environment only, never into a command, a row or the second call", async () => {
    const hub = fakeHub(), calls = boxFor(hub, { testCode: 1, leak: "token was " + "ghp_" + "A".repeat(36) + "\n" });
    const token = hub.env.GITHUB_TOKEN_2;
    await R.checkRepo(hub, "TeamAgent", { force: true });
    assert.equal(calls[0].env.GH_TOKEN, token);
    assert.equal(calls[1].env, undefined);
    for (const c of calls) for (const cmd of c.commands) assert.ok(!cmd.includes(token));
    const raw = JSON.stringify(hub.sql.exec("SELECT * FROM repocheck").toArray());
    assert.ok(!raw.includes(token) && !raw.includes("ghp_"));
  });
  test("the second script only runs the planned steps and respects the repository time box", async () => {
    const hub = fakeHub(), calls = boxFor(hub);
    await R.checkRepo(hub, "TeamAgent", { force: true, total: 300 });
    assert.match(calls[1].commands[0], /END=\$\(\( \$\(date \+%s\) \+ (2[5-9]\d|300) \)\)/);
    assert.ok(calls[1].timeoutSeconds <= 300 + 90);
  });
  test("a clone failure is stored as 'could not tell', not as a failure", async () => {
    const hub = fakeHub();
    R.hooks.run = async () => ({ ok: true, steps: [], files: [{ name: "repocheck/TeamAgent.a.txt", bytes: enc("@@ERR|clone|fatal: Authentication failed") }] });
    R.hooks.fetch = async () => ({ ok: false, status: 404 });
    const { row } = await R.checkRepo(hub, "TeamAgent", { force: true });
    assert.equal(row.ok, null);
    assert.match(row.summary.err, /Authentication failed/);
    assert.match(R.describe([row]).result, /没跑成/);
  });
  test("a runner crash is stored; the plan's stop line propagates", async () => {
    const hub = fakeHub();
    R.hooks.fetch = async () => ({ ok: false, status: 404 });
    R.hooks.run = async (h, req) => { if (/@@CLONE/.test(req.commands[0])) throw new Error("云电脑坏了"); return { ok: true, steps: [], files: [] }; };
    const { row } = await R.checkRepo(hub, "TeamAgent", { force: true });
    assert.equal(row.ok, null);
    assert.match(row.summary.err, /云电脑坏了/);
    R.hooks.run = async () => { throw new Error("这个月云电脑的额度用到停止线了，下个周期才能再用"); };
    await assert.rejects(R.checkRepo(hub, "TeamAgent", { force: true }), /停止线/);
  });
  test("steps that do not fit the CPU budget are recorded as skipped and the verdict says 'not sure'", async () => {
    const hub = fakeHub(), calls = boxFor(hub);
    const { row } = await R.checkRepo(hub, "TeamAgent", { force: true, budget: 10 });
    assert.equal(calls.length, 2, "probe and cleanup only");
    assert.match(calls[1].commands[0], /rm -rf/);
    assert.equal(row.ok, null);
    assert.ok(row.summary.steps.every(s => s.s === "skip" && /CPU/.test(s.x)));
  });
  test("nothing new since a recent conclusive run: no computer, the old result is carried", async () => {
    const hub = fakeHub(), calls = boxFor(hub);
    const first = await R.checkRepo(hub, "TeamAgent", { force: true });
    assert.equal(calls.length, 2);
    const again = await R.checkRepo(hub, "TeamAgent", { now: first.row.ts + 3 * 3600000 });
    assert.equal(again.ran, false);
    assert.equal(calls.length, 2);
    assert.equal(again.row.ok, 1);
    assert.equal(again.row.summary.carried.from, first.row.ts);
    assert.match(R.describe(R.recentRows(hub, "TeamAgent", 2)).note_carried, /没有新提交/);
    const later = await R.checkRepo(hub, "TeamAgent", { now: first.row.ts + 8 * 86400000 });
    assert.equal(later.ran, true, "after a week it is run again");
    boxFor(hub, { sha: "6".repeat(40) });
    const changed = await R.checkRepo(hub, "TeamAgent", { now: Date.now() + 1000 });
    assert.equal(changed.ran, true, "a new commit means a new run");
  });
  test("only the last 60 rows per repository are kept", () => {
    const hub = fakeHub();
    for (let i = 0; i < 75; i++) R.saveRow(hub, "a", i, "s" + i, 1, { v: 1, repo: "a", src: "none", builds: false, steps: [] });
    R.saveRow(hub, "b", 1, "x", 0, { v: 1, repo: "b", src: "none", builds: false, steps: [] });
    const rows = R.recentRows(hub, "a");
    assert.equal(rows.length, 60);
    assert.equal(rows[0].sha, "s74");
    assert.equal(rows.at(-1).sha, "s15");
    assert.equal(R.recentRows(hub, "b").length, 1);
    assert.deepEqual(R.storedRepos(hub), ["a", "b"]);
  });
});

describe("announcing a new failure once", () => {
  test("pass → fail tells the main group once; the next failing night is silent; a fix and a new break tell again", async () => {
    const hub = fakeHub();
    hub.set("main", "g:main");
    const calls = boxFor(hub, { sha: "1".repeat(40), testCode: 0 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 0, "a pass says nothing");
    boxFor(hub, { sha: "2".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 1);
    assert.equal(hub.said[0][0], "g:main");
    assert.match(hub.said[0][1], /「TeamAgent」/);
    assert.match(hub.said[0][1], /✖ the broken one/);
    boxFor(hub, { sha: "3".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 1, "same failure, nothing new");
    boxFor(hub, { sha: "4".repeat(40), testCode: 0 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    boxFor(hub, { sha: "5".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 2);
  });
  test("a failure found by a chat or admin run is held back and told by the next night's run, once", async () => {
    const hub = fakeHub();
    hub.set("main", "g:main");
    boxFor(hub, { sha: "1".repeat(40), testCode: 0 });
    await R.checkOne(hub, "TeamAgent", { force: true });
    boxFor(hub, { sha: "2".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { force: true });
    assert.equal(hub.said.length, 0, "a manual run does not speak");
    boxFor(hub, { sha: "3".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 1, "the night tells it");
    assert.match(hub.said[0][1], /最新提交 2222222/, "about the run that first failed");
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 1);
  });
  test("a run in the main group itself counts as told (the model says it there)", async () => {
    const hub = fakeHub();
    hub.set("main", "g:main");
    boxFor(hub, { sha: "1".repeat(40), testCode: 0 });
    await R.checkOne(hub, "TeamAgent", { force: true });
    boxFor(hub, { sha: "2".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { force: true, told: true });
    boxFor(hub, { sha: "3".repeat(40), testCode: 1 });
    await R.checkOne(hub, "TeamAgent", { announce: true, force: true });
    assert.equal(hub.said.length, 0);
  });
  test("two checks cannot overlap", async () => {
    const hub = fakeHub();
    boxFor(hub);
    let release, n = 0;
    R.hooks.run = () => (n++ ? Promise.resolve({ ok: true, steps: [], files: [] }) : new Promise(r => { release = () => r({ ok: true, steps: [], files: [] }); }));
    const first = R.checkOne(hub, "TeamAgent", { force: true });
    await new Promise(r => setTimeout(r, 5));
    await assert.rejects(R.checkOne(hub, "WhalePartner", { force: true }), /正在检查 TeamAgent/);
    release(); await first.catch(() => {});
    await R.checkOne(hub, "WhalePartner", { force: true }).catch(() => {});
  });
});

describe("the daily clock", () => {
  test("starts once per Beijing day, after 02:40, and not before", async () => {
    const hub = fakeHub();
    boxFor(hub);
    R.tick(hub, bj(2026, 11, 15, 2, 39));
    assert.equal(hub.bg, undefined);
    assert.equal(hub.get("repocheck:day"), null);
    R.tick(hub, bj(2026, 11, 15, 2, 40));
    assert.equal(hub.bg.length, 1);
    assert.equal(hub.get("repocheck:day"), "2026-11-15");
    R.tick(hub, bj(2026, 11, 15, 2, 40) + 20000);
    R.tick(hub, bj(2026, 11, 15, 23, 0));
    assert.equal(hub.bg.length, 1, "once a day");
    await hub.bg[0];
    const night = JSON.parse(hub.get("repocheck:night"));
    assert.equal(night.day, "2026-11-15");
    assert.equal(R.recentRows(hub, "TeamAgent").length, 1);
    R.tick(hub, bj(2026, 11, 16, 2, 41));
    assert.equal(hub.bg.length, 2, "the next day runs again");
    await hub.bg[1];
  });
  test("the Beijing day is used, not UTC: 02:40 on the 16th in Beijing is 18:40 UTC on the 15th", async () => {
    const hub = fakeHub();
    boxFor(hub);
    R.tick(hub, Date.UTC(2026, 10, 15, 18, 30));   // 02:30 on the 16th in Beijing
    assert.equal(hub.bg, undefined);
    R.tick(hub, Date.UTC(2026, 10, 15, 18, 41));
    assert.equal(hub.bg.length, 1);
    assert.equal(hub.get("repocheck:day"), "2026-11-16");
    await hub.bg[0];
  });
  test("a night the plan cannot afford is skipped and noted", () => {
    const hub = fakeHub({ fits: false });
    R.tick(hub, bj(2026, 11, 15, 3, 0));
    assert.equal(hub.bg, undefined);
    assert.equal(hub.get("repocheck:day"), "2026-11-15");
    assert.match(hub.get("repocheck:skip"), /额度/);
  });
  test("no cloud computer, no run", () => {
    const hub = fakeHub({ env: { COMPUTER: undefined } });
    R.tick(hub, bj(2026, 11, 15, 3, 0));
    assert.equal(hub.get("repocheck:day"), null);
  });
  test("the repository list defaults to all five and can be set", async () => {
    const hub = fakeHub();
    assert.deepEqual(R.listRepos(hub), R.DEFAULT_REPOS);
    const post = body => feat.admin(hub, { method: "POST" }, new URL("https://x/admin/repocheck"), body);
    assert.equal((await post({ repos: ["A", "B-c", "A"] })).status, 200);
    assert.deepEqual(R.listRepos(hub), ["A", "B-c"]);
    assert.equal((await post({ repos: ["bad name"] })).status, 400);
    assert.equal((await post({ repos: [] })).status, 400);
    assert.equal((await post({ repo: "x;y" })).status, 400);
    assert.equal((await post({})).status, 400);
  });
  test("a night works through the list in order and skips what the CPU cannot pay for", async () => {
    const hub = fakeHub({ cpuLeft: 1000 });
    const order = [];
    R.hooks.fetch = async () => ({ ok: false, status: 404 });
    R.hooks.run = async (h, req) => {
      const m = /@@CLONE/.test(req.commands[0]) ? /repocheck\/([\w.-]+)\.a\.txt/.exec(req.commands[0]) : null;
      if (m) { order.push(m[1]); return { ok: true, steps: [], files: [{ name: `repocheck/${m[1]}.a.txt`, bytes: enc(PROBE_OUT("7".repeat(40))) }] }; }
      return { ok: true, steps: [], files: [] };
    };
    await R.nightly(hub, ["A", "B"], bj(2026, 11, 15, 3));
    assert.deepEqual(order, ["A", "B"]);
    assert.equal(R.recentRows(hub, "A")[0].ok, null);
  });
});

describe("the model's tool and the admin route", () => {
  const ctx = (hub, over = {}) => ({ hub, conv: "t:x", askers: [], host: { conv: "t:x", cfg: () => 6, quota: async () => true, ...over } });
  test("the tool is described for the digest and for 'do the tests pass', and has op last and run", () => {
    const [t] = feat.tools(ctx(fakeHub()));
    assert.equal(t.name, "repo_health");
    assert.match(t.description, /每日简报/);
    assert.match(t.description, /测试过没过/);
    assert.deepEqual(t.parameters.properties.op.enum, ["last", "run"]);
    assert.equal(feat.tunables.repocheck_daily.default, 6);
    assert.ok(feat.about.length >= 4 && feat.about.every(l => /[一-鿿]/.test(l)));
  });
  test("last: nothing yet, then one repository, then all", async () => {
    const hub = fakeHub(), [t] = feat.tools(ctx(hub));
    const none = await t.run({ op: "last" });
    assert.match(none.hint, /还没有/);
    boxFor(hub);
    await R.checkOne(hub, "TeamAgent", { force: true });
    const one = await t.run({ op: "last", repo: "TeamAgent" });
    assert.equal(one.result, "通过");
    assert.ok(one.commit && one.commits_7d.count === 2 && one.changed_since_previous.length);
    const all = await t.run({ op: "last" });
    assert.equal(all.repos.length, 5);
    assert.equal(all.repos.find(r => r.repo === "TeamAgent").result, "通过");
    assert.equal(all.repos.find(r => r.repo === "NextThought").result, "还没检查过");
    assert.match((await t.run({ op: "last", repo: "Zed" })).result, /还没检查/);
  });
  test("run: needs a repo, honours the daily limit, and returns the fresh result", async () => {
    const hub = fakeHub(), [t] = feat.tools(ctx(hub));
    assert.equal((await t.run({ op: "run" })).ok, false);
    assert.equal((await t.run({ op: "run", repo: "a b" })).ok, false);
    const [limited] = feat.tools(ctx(hub, { quota: async () => false }));
    assert.match((await limited.run({ op: "run", repo: "TeamAgent" })).error, /次数用完/);
    boxFor(hub);
    const r = await t.run({ op: "run", repo: "TeamAgent" });
    assert.equal(r.ok, true);
    assert.equal(r.result, "通过");
    assert.equal(hub.said.length, 0);
  });
  test("admin GET lists the latest; POST with wait runs one; without wait it starts in the background", async () => {
    const hub = fakeHub();
    boxFor(hub);
    const url = new URL("https://x/admin/repocheck");
    assert.equal(await feat.admin(hub, { method: "GET" }, new URL("https://x/admin/other"), null), null);
    const run = await feat.admin(hub, { method: "POST" }, url, { repo: "TeamAgent", wait: true });
    const j = await run.json();
    assert.equal(j.ok, true);
    assert.equal(j.result, "通过");
    const get = await (await feat.admin(hub, { method: "GET" }, url, null)).json();
    assert.equal(get.repos.length, 5);
    assert.equal(get.latest.find(x => x.repo === "TeamAgent").result, "通过");
    const bg = await (await feat.admin(hub, { method: "POST" }, url, { repo: "TeamAgent" })).json();
    assert.equal(bg.started, "TeamAgent");
    await hub.bg[0];
  });
});
