// Offline tests for the coding agent feature: naming, permissions, path rules, check selection, usage
// parsing, the shell it sends to the cloud computer, the PR body and the whole flow with a fake computer.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  slugify, branchName, permit, forbiddenPaths, lockfiles, checkCommand, parseAgentEvents, sections,
  cloneCommand, pushCommand, scriptA, scriptB, opencodeConfig, prBody, checkLine, commitMessage, codeTask, allowList,
} from "../src/feat/codeagent.ts";
import feature from "../src/feat/codeagent.ts";
import { PRICE } from "../src/meter.ts";

const NIGHT = Date.UTC(2026, 10, 14, 18, 8);    // Sunday 02:08 Beijing: off-peak

describe("naming", () => {
  test("slug from the task", () => {
    assert.equal(slugify("Add a one-line comment at the top of test/pure.test.mjs"), "add-one-line-comment-at-the");
    assert.equal(slugify("给 ledger 加一个导出功能"), "ledger");
    assert.equal(slugify("把记账改成按月汇总"), "change");
    assert.equal(slugify(""), "change");
    assert.ok(slugify("x".repeat(80)).length <= 30);
    assert.match(slugify("Fix Bug #42 in watch.ts!!"), /^[a-z0-9-]+$/);
  });
  test("branch is bot/<slug>-<yyyymmdd-hhmm> in Beijing time", () => {
    assert.equal(branchName("Fix the README typo", NIGHT), "bot/fix-the-readme-typo-20261115-0208");
    assert.equal(branchName("修一下", Date.UTC(2026, 11, 31, 16, 0)), "bot/change-20270101-0000");
  });
});

describe("permissions", () => {
  const allow = ["TeamAgent", "Docs"];
  for (const rank of ["owner", "trusted", "member"]) {
    for (const repo of ["TeamAgent", "teamagent", "Docs", "WhalePartner"]) {
      test(rank + " × " + repo, () => {
        assert.equal(permit("investigate", repo, rank, allow).ok, true, "investigate is open to everyone");
        const pr = permit("pr", repo, rank, allow);
        const want = rank !== "member" && repo !== "WhalePartner";
        assert.equal(pr.ok, want);
        if (!want) assert.match(pr.error, rank === "member" ? /群主或被授权/ : /只读/);
      });
    }
  }
  test("TeamAgent stays allowed even if the list lost it", () => {
    assert.equal(permit("pr", "TeamAgent", "owner", []).ok, true);
    assert.equal(permit("pr", "Docs", "owner", []).ok, false);
  });
});

describe("paths", () => {
  test("forbidden paths", () => {
    const bad = [".github/workflows/ci.yml", "sub/.github/x.yml", ".env", ".env.production", "app/.dev.vars", ".npmrc",
      "config/secrets.json", "aws_credentials", "keys/server.pem", "deploy.key", "id_rsa", "id_ed25519.pub", "cert.p12"];
    const ok = ["src/feat/codeagent.ts", "README.md", "test/pure.test.mjs", "docs/github-notes.md", "src/keyboard.ts", "package-lock.json", "src/env.ts"];
    assert.deepEqual(forbiddenPaths([...bad, ...ok]), bad);
  });
  test("lockfiles are reported, not refused", () => {
    assert.deepEqual(lockfiles(["package-lock.json", "web/yarn.lock", "src/a.ts"]), ["package-lock.json", "web/yarn.lock"]);
    assert.deepEqual(forbiddenPaths(["package-lock.json"]), []);
  });
});

describe("checkCommand", () => {
  test("check script wins, with ci when there is a lockfile", () => {
    assert.equal(checkCommand({ scripts: { check: "tsc && node --test", test: "node --test" } }, true), "npm ci --no-audit --no-fund && npm run check");
    assert.equal(checkCommand({ scripts: { check: "x" } }, false), "npm install --no-audit --no-fund && npm run check");
  });
  test("falls back to a real test script", () => {
    assert.equal(checkCommand({ scripts: { test: "vitest run" } }, true), "npm ci --no-audit --no-fund && npm test");
    assert.equal(checkCommand({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }, true), null);
  });
  test("nothing to run", () => {
    assert.equal(checkCommand(null, false), null);
    assert.equal(checkCommand({}, true), null);
    assert.equal(checkCommand({ scripts: { build: "tsc" } }, true), null);
    assert.equal(checkCommand({ scripts: { check: "  " } }, true), null);
  });
});

// Shaped like OpenCode 1.19.5 `run --format json` output (filtered to the three event types we keep).
const ev = (type, part) => JSON.stringify({ type, timestamp: 1, sessionID: "ses_1", part: { type: type.replace("_", "-"), ...part } });
const EVENTS = [
  ev("step_finish", { reason: "tool-calls", tokens: { total: 7509, input: 7472, output: 37, reasoning: 0, cache: { write: 0, read: 0 } }, cost: 0.001143 }),
  ev("text", { text: "先看一下文件。" }),
  ev("step_finish", { reason: "tool-calls", tokens: { total: 7614, input: 228, output: 90, reasoning: 10, cache: { write: 0, read: 7296 } } }),
  ev("text", { text: "改好了：calc.py 的 add 现在返回 a + b。" }),
  ev("step_finish", { reason: "stop", tokens: { total: 7890, input: 188, output: 22, reasoning: 0, cache: { write: 0, read: 7680 } } }),
  "not json", "",
].join("\n");

describe("parseAgentEvents", () => {
  test("tokens, cost and the final answer", () => {
    const r = parseAgentEvents(EVENTS, NIGHT);
    assert.equal(r.steps, 3);
    assert.equal(r.cachedTok, 7296 + 7680);
    assert.equal(r.inTok, 7472 + 228 + 188 + 7296 + 7680, "input excludes cache hits, so they are added back");
    assert.equal(r.outTok, 37 + 90 + 10 + 22, "reasoning is billed as output");
    assert.equal(r.reasoningTok, 10);
    const usd = (7296 + 7680) * PRICE.flash.hit + (7472 + 228 + 188) * PRICE.flash.miss + 159 * PRICE.flash.out;
    assert.ok(Math.abs(r.usd - usd) < 1e-12);
    assert.equal(r.text, "改好了：calc.py 的 add 现在返回 a + b。");
    assert.deepEqual(r.errors, []);
  });
  test("peak hours cost double", () => {
    const peak = Date.UTC(2026, 10, 16, 2, 0);   // Monday 10:00 Beijing
    assert.ok(Math.abs(parseAgentEvents(EVENTS, peak).usd - 2 * parseAgentEvents(EVENTS, NIGHT).usd) < 1e-12);
  });
  test("text after the last step and errors", () => {
    const r = parseAgentEvents(EVENTS + "\n" + ev("text", { text: "补一句" }) + "\n" + JSON.stringify({ type: "error", error: { name: "APIError", data: { message: "Authentication Fails" } } }), NIGHT);
    assert.equal(r.text, "补一句");
    assert.deepEqual(r.errors, ["Authentication Fails"]);
    assert.equal(parseAgentEvents("", NIGHT).usd, 0);
  });
});

describe("shell", () => {
  test("clone and push keep the token out of the URL, config and command text", () => {
    for (const cmd of [cloneCommand("OmnixSI/TeamAgent", "main"), pushCommand("bot/x-20261115-0208")]) {
      assert.match(cmd, /git -c http\.extraHeader="\$AUTH" (clone|push)/);
      assert.match(cmd, /\$\{GH_TOKEN:-\}/, "the token comes from the environment at run time");
      assert.doesNotMatch(cmd, /https:\/\/[^/\s]*@github\.com/, "no credentials in the URL");
      assert.doesNotMatch(cmd, /git config|credential\.helper|insteadOf/);
    }
    assert.match(cloneCommand("OmnixSI/TeamAgent", "dev"), /--depth 1 --single-branch --branch 'dev' 'https:\/\/github\.com\/OmnixSI\/TeamAgent\.git' repo$/);
    assert.match(pushCommand("bot/a-1", true), /push -q --dry-run origin 'HEAD:refs\/heads\/bot\/a-1'$/);
  });
  test("quotes survive odd branch names", () => {
    assert.match(pushCommand("bot/it's"), /'HEAD:refs\/heads\/bot\/it'\\''s'/);
  });
  test("pipeline scripts", () => {
    const a = scriptA({ id: "abc", full: "OmnixSI/TeamAgent", base: "main", branch: "bot/x-1", mode: "pr", agentSeconds: 720 });
    assert.match(a, /git checkout -q -b 'bot\/x-1'/);
    assert.match(a, /timeout -k 15 720 env -u GH_TOKEN "\$OC" run --model deepseek\/deepseek-flash --variant max --auto --format json/);
    assert.match(a, /git add -A/);
    assert.match(a, /@@ca:leak/);
    assert.match(a, /--version 1\.19\.5/);
    const i = scriptA({ id: "abc", full: "OmnixSI/Other", mode: "investigate", agentSeconds: 180 });
    assert.doesNotMatch(i, /checkout -q -b|git add|@@ca:files/);
    assert.match(i, /"edit": "deny"/);
    assert.match(opencodeConfig("pr"), /"edit": "allow"/);
    const b = scriptB({ id: "abc", branch: "bot/x-1", check: "npm ci --no-audit --no-fund && npm run check" });
    assert.match(b, /env -u GH_TOKEN -u DEEPSEEK_API_KEY bash -c 'npm ci --no-audit --no-fund && npm run check'/);
    assert.match(b, /user\.name='TeamAgent Bot'/);
    assert.match(b, /commit -q --no-verify -F/);
    assert.doesNotMatch(scriptB({ id: "abc", branch: "bot/x-1", check: null }), /@@ca:check/);
    for (const s of [a, i, b]) assert.doesNotMatch(s, /refs\/heads\/(main|master)\b/, "never targets a default branch");
  });
  test("sections", () => {
    const s = sections("noise\n@@ca:files\na.ts\nb.ts\n@@ca:numstat\n2 5 1\n@@ca:leak\n@@ca:end\n");
    assert.deepEqual(s, { files: "a.ts\nb.ts", numstat: "2 5 1", leak: "", end: "" });
  });
});

describe("PR text", () => {
  const base = { task: "加一行注释\n验收：只改一行", who: "小明", summary: "改了 test/pure.test.mjs 第 2 行。", stat: " test/pure.test.mjs | 1 +", changed: 1, files: 1, locks: [], seconds: 117.4, usd: 0.0023,
    check: { command: "npm ci && npm run check", passed: true, exit: 0, seconds: 13, tail: "ℹ pass 99" } };
  test("body has request, asker, summary, diffstat, check and the review line", () => {
    const b = prBody(base);
    assert.match(b, /需要人工审查后再合并/);
    assert.match(b, /小明 在群里让 Bot 做的/);
    assert.match(b, /> 加一行注释\n> 验收：只改一行/);
    assert.match(b, /改了 test\/pure\.test\.mjs 第 2 行/);
    assert.match(b, /test\/pure\.test\.mjs \| 1 \+/);
    assert.match(b, /`npm ci && npm run check`：通过，用时 13 秒/);
    assert.match(b, /用时 117 秒/);
    assert.doesNotMatch(b, /改动很大/);
  });
  test("big change, failed check, proposal and lockfiles are flagged", () => {
    const b = prBody({ ...base, changed: 812, proposal: 7, locks: ["package-lock.json"], check: { command: "npm test", passed: false, exit: 1, tail: "1 failing" } });
    assert.match(b, /改动很大，共 812 行/);
    assert.match(b, /来自第 7 号改进提议/);
    assert.match(b, /没通过（退出码 1）/);
    assert.match(b, /package-lock\.json/);
  });
  test("check lines", () => {
    assert.match(checkLine({ command: null, passed: null }), /没有可跑的检查/);
    assert.match(checkLine({ command: "npm test", passed: false, exit: 124, timedOut: true }), /被停掉/);
  });
  test("commit message", () => {
    const m = commitMessage("Fix the typo in README\nmore detail", "小明", 3);
    assert.match(m, /^bot: Fix the typo in README\n\n/);
    assert.match(m, /Requested by 小明 \(proposal #3\)/);
  });
});

// ---- the whole flow with a fake Hub, a fake cloud computer and a fake GitHub ----

function fakeHub({ rank = "owner", proposal } = {}) {
  const kv = new Map(), updates = [];
  return {
    kv, updates,
    env: { GITHUB_ORG: "OmnixSI", GITHUB_TOKEN_2: "tok2", GITHUB_TOKEN: "tok1", DEEPSEEK_API_KEY: "dsk" },
    get: k => (kv.has(k) ? kv.get(k) : null), set: (k, v) => kv.set(k, String(v)),
    shadow: c => (c.startsWith("t:") ? "main" : ""),
    plan: { fits: () => true },
    edit: { rank: () => rank },
    sql: { exec: (q, ...b) => {
      if (q.startsWith("SELECT")) return { toArray: () => (proposal && b[0] === proposal.id ? [proposal] : []) };
      updates.push([q, ...b]); return { toArray: () => [] };
    } },
  };
}
function fakeComputer(outputs) {
  const calls = [];
  return { calls, run: async req => {
    calls.push(req);
    const cmd = req.commands[0];
    if (cmd.startsWith("rm -rf")) return { ok: true, steps: [{ stdout: "", exit: 0 }], files: [], seconds: 1 };
    const phase = cmd.includes("@@ca:push_exit") ? "b" : "a";
    return { ok: true, steps: [{ command: cmd, exit: 0, stdout: outputs[phase], stderr: "", seconds: 30 }], files: phase === "a" ? [{ name: req.collect[0], bytes: new TextEncoder().encode(EVENTS) }] : [], seconds: 30 };
  } };
}
const A_OK = "@@ca:agent_start\n100\n@@ca:agent_exit\n0\n160\n@@ca:agent_err\n@@ca:files\ntest/pure.test.mjs\n@@ca:numstat\n1 1 0\n@@ca:stat\n test/pure.test.mjs | 1 +\n 1 file changed, 1 insertion(+)\n@@ca:leak\n@@ca:pkg\n{\"scripts\":{\"check\":\"tsc && node --test\"}}\n@@ca:lock\nyes\n@@ca:end\n";
const B_OK = "@@ca:check_start\n200\n@@ca:check_exit\n0\n213\n@@ca:check_tail\nℹ pass 99\n@@ca:sha\nabc\n@@ca:push_exit\n0\n@@ca:push_err\n@@ca:end\n";

function fakeGitHub({ write = true, prStatus = 201 } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url), method = init.method || "GET", auth = init.headers?.Authorization || "";
    calls.push({ method, path: u.replace("https://api.github.com", ""), auth, body: init.body ? JSON.parse(init.body) : null });
    const json = (s, d) => new Response(d === null ? null : JSON.stringify(d), { status: s });
    if (method === "GET" && u.endsWith("/repos/OmnixSI/TeamAgent")) return json(200, { default_branch: "main", private: true });
    if (method === "POST" && (u.endsWith("/git/refs") || u.endsWith("/pulls")) && init.body.includes("probe")) return json(write ? 422 : 403, { message: write ? "Validation Failed" : "Resource not accessible by personal access token" });
    if (method === "POST" && u.endsWith("/pulls")) return json(prStatus, prStatus === 201 ? { html_url: "https://github.com/OmnixSI/TeamAgent/pull/9", number: 9 } : { message: "Validation Failed" });
    if (method === "DELETE") return json(204, null);
    return json(404, { message: "Not Found" });
  };
  return calls;
}
function ctxFor(hub, computer, quota = true) {
  return { hub, conv: "t:ag-code", askers: [{ id: "u1", name: "小明" }], host: { computer: computer.run, quota: async () => quota, cfg: () => 6 } };
}
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("codeTask flow", () => {
  test("opens a draft PR and reports branch, diffstat, check, time and cost", async () => {
    const gh = fakeGitHub(), hub = fakeHub(), pc = fakeComputer({ a: A_OK, b: B_OK });
    const r = await codeTask(ctxFor(hub, pc), { task: "Add a one-line comment at the top of test/pure.test.mjs" }, { now: () => NIGHT });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.pr, "https://github.com/OmnixSI/TeamAgent/pull/9");
    assert.equal(r.branch, "bot/add-one-line-comment-at-the-20261115-0208");
    assert.equal(r.lines_changed, 1);
    assert.equal(r.checks.passed, true);
    assert.match(r.checks.result, /npm run check`：通过，用时 13 秒/);
    assert.ok(r.cost_usd > 0 && r.model_calls === 3);
    const pr = gh.find(c => c.method === "POST" && c.path.endsWith("/pulls") && !c.body.title.includes("probe"));
    assert.equal(pr.body.draft, true);
    assert.equal(pr.body.base, "main");
    assert.equal(pr.body.head, r.branch);
    assert.equal(pr.auth, "Bearer tok2", "the long-lived token is tried first");
    assert.match(pr.body.body, /小明 在群里让 Bot 做的/);
    // Secrets go through env only, never through the command text.
    for (const c of pc.calls) {
      for (const s of ["tok2", "tok1", "dsk"]) assert.ok(!c.commands.join("\n").includes(s));
    }
    assert.deepEqual(pc.calls[0].env, { GH_TOKEN: "tok2", DEEPSEEK_API_KEY: "dsk" });
    assert.equal(hub.get("codeagent:busy"), "", "the lock is released");
  });

  test("a member cannot open a PR; nothing runs", async () => {
    const gh = fakeGitHub(), pc = fakeComputer({});
    const r = await codeTask(ctxFor(fakeHub({ rank: "member" }), pc), { task: "change something in TeamAgent" });
    assert.equal(r.ok, false);
    assert.match(r.error, /群主或被授权/);
    assert.equal(pc.calls.length, 0);
    assert.equal(gh.length, 0);
  });

  test("a token without write access is refused before any computer time", async () => {
    fakeGitHub({ write: false });
    const pc = fakeComputer({});
    const r = await codeTask(ctxFor(fakeHub(), pc), { task: "Add a comment to README" });
    assert.equal(r.ok, false);
    assert.match(r.error, /Contents 写.*Pull requests 写/);
    assert.equal(pc.calls.length, 0);
  });

  test("forbidden paths stop before commit and push", async () => {
    fakeGitHub();
    const pc = fakeComputer({ a: A_OK.replace("test/pure.test.mjs\n@@ca:numstat", ".github/workflows/x.yml\n@@ca:numstat"), b: B_OK });
    const r = await codeTask(ctxFor(fakeHub(), pc), { task: "Tweak the CI workflow" });
    assert.equal(r.ok, false);
    assert.match(r.error, /\.github\/workflows\/x\.yml/);
    assert.ok(!pc.calls.some(c => c.commands[0].includes("@@ca:push_exit")), "phase two never ran");
    assert.ok(pc.calls.some(c => c.commands[0].startsWith("rm -rf /work/ca-")), "the work directory is cleaned");
  });

  test("no change, leaked secret", async () => {
    fakeGitHub();
    let r = await codeTask(ctxFor(fakeHub(), fakeComputer({ a: A_OK.replace("test/pure.test.mjs\n@@ca:numstat", "@@ca:numstat") })), { task: "Add a comment to README" });
    assert.match(r.error, /没有改任何文件/);
    r = await codeTask(ctxFor(fakeHub(), fakeComputer({ a: A_OK.replace("@@ca:leak\n", "@@ca:leak\nyes\n") })), { task: "Add a comment to README" });
    assert.match(r.error, /密钥原文/);
  });

  test("a failed PR deletes the pushed branch", async () => {
    const gh = fakeGitHub({ prStatus: 422 });
    const r = await codeTask(ctxFor(fakeHub(), fakeComputer({ a: A_OK, b: B_OK })), { task: "Add a comment to README" }, { now: () => NIGHT });
    assert.equal(r.ok, false);
    assert.match(r.error, /分支已经删掉/);
    const del = gh.find(c => c.method === "DELETE");
    assert.equal(del.path, "/repos/OmnixSI/TeamAgent/git/refs/heads/bot/add-comment-to-readme-20261115-0208");
  });

  test("a failed push opens nothing", async () => {
    const gh = fakeGitHub();
    const r = await codeTask(ctxFor(fakeHub(), fakeComputer({ a: A_OK, b: B_OK.replace("@@ca:push_exit\n0", "@@ca:push_exit\n128").replace("@@ca:push_err\n", "@@ca:push_err\nremote: Write access to repository not granted.\n") })), { task: "Add a comment to README" });
    assert.equal(r.ok, false);
    assert.match(r.error, /推送分支失败.*Write access/s);
    assert.ok(!gh.some(c => c.method === "POST" && c.path.endsWith("/pulls") && !c.body.title.includes("probe")));
  });

  test("proposal text becomes the task and the proposal is marked", async () => {
    fakeGitHub();
    const hub = fakeHub({ proposal: { id: 5, key: "Add a comment", after: "在 README 顶部加一句说明", status: "proposed" } });
    const pc = fakeComputer({ a: A_OK, b: B_OK });
    const r = await codeTask(ctxFor(hub, pc), { proposal: 5 });
    assert.equal(r.ok, true);
    assert.match(new TextDecoder().decode(pc.calls[0].files[0].bytes), /在 README 顶部加一句说明/);
    assert.ok(hub.updates.some(u => u[0].includes("status='pr'") && u[2] === 5));
    assert.match((await codeTask(ctxFor(fakeHub(), pc), { proposal: 99 })).error, /没有第 99 号/);
  });

  test("investigate returns the answer and makes no branch", async () => {
    fakeGitHub({ write: false });
    const pc = fakeComputer({ a: "@@ca:agent_start\n1\n@@ca:agent_exit\n0\n2\n@@ca:agent_err\n@@ca:end\n" });
    const r = await codeTask(ctxFor(fakeHub({ rank: "member" }), pc), { mode: "investigate", task: "预算的停止线在哪里定义？" });
    assert.equal(r.ok, true);
    assert.match(r.answer, /改好了/);
    assert.ok(!pc.calls[0].commands[0].includes("checkout -q -b"));
  });

  test("other organisations, busy machine and daily cap", async () => {
    fakeGitHub();
    assert.match((await codeTask(ctxFor(fakeHub(), fakeComputer({})), { repo: "someone/else", task: "look at this repo" })).error, /OmnixSI/);
    const busy = fakeHub(); busy.set("codeagent:busy", String(Date.now()));
    assert.match((await codeTask(ctxFor(busy, fakeComputer({})), { task: "Add a comment to README" })).error, /还在跑/);
    assert.match((await codeTask(ctxFor(fakeHub(), fakeComputer({}), false), { task: "Add a comment to README" })).error, /次数用完/);
    const full = fakeHub(); full.plan.fits = () => false;
    assert.match((await codeTask(ctxFor(full, fakeComputer({})), { task: "Add a comment to README" })).error, /额度/);
  });
});

describe("admin allowlist", () => {
  const call = (hub, body) => feature.admin(hub, new Request("https://x/admin/codeagent", { method: body ? "POST" : "GET" }), new URL("https://x/admin/codeagent"), body);
  test("allow, deny and TeamAgent always on", async () => {
    const hub = fakeHub();
    assert.deepEqual(allowList(hub), ["TeamAgent"]);
    assert.deepEqual((await (await call(hub, { allow: "Docs" })).json()).allowed_for_pr, ["TeamAgent", "Docs"]);
    assert.deepEqual((await (await call(hub, { allow: "OmnixSI/docs" })).json()).allowed_for_pr, ["TeamAgent", "docs"]);
    assert.deepEqual((await (await call(hub, { deny: "docs" })).json()).allowed_for_pr, ["TeamAgent"]);
    assert.equal((await call(hub, { deny: "TeamAgent" })).status, 400);
    assert.equal((await call(hub, { allow: "../x" })).status, 400);
    assert.equal(await feature.admin(hub, new Request("https://x/admin/other"), new URL("https://x/admin/other"), {}), null);
  });
  test("tunable and about", () => {
    assert.equal(feature.tunables.code_daily.default, 6);
    assert.ok(feature.about.length >= 4);
  });
});
