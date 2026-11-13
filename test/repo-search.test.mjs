import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// Bundle the two new tools (and the registry) the same way semantic.ts sees them.
async function load() {
  const out = await build({
    stdin: {
      contents: 'export * from "./src/tools/repo-search"; export * from "./src/tools/index"; export * from "./src/github";',
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    write: false,
  });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}
const api = await load();
const TOKEN = "SyntheticGithubToken123456789";
const env = () => ({ GITHUB_TOKEN: TOKEN });
const tool = (name) => api.EXTRA_TOOLS.find((t) => t.name === name);

async function network(work, reply = () => undefined) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options = {}) => {
    url = String(url);
    assert.ok(url.startsWith("https://api.github.com/"), url);
    calls.push({ url, options });
    const custom = await reply(url, options, calls);
    return custom !== undefined ? custom : Response.json({ total_count: 0, incomplete_results: false, items: [] });
  };
  try { return await work(calls); } finally { globalThis.fetch = original; }
}

const issue = (number, extra = {}) => ({
  number,
  title: "标题 " + number,
  state: "open",
  user: { login: "alice" },
  updated_at: "2026-11-13T00:00:00Z",
  html_url: "https://github.com/OmnixSI/TeamAgent/issues/" + number,
  body: "第一行\n第二行",
  ...extra,
});

test("T1 both tools register as untrusted read-only definitions", () => {
  const mine = api.EXTRA_TOOLS.filter((t) => ["search_code", "search_pr_issue"].includes(t.name));
  assert.deepEqual(mine.map((t) => t.name).sort(), ["search_code", "search_pr_issue"]);
  for (const t of mine) {
    assert.equal(t.untrusted, true);
    assert.equal(t.def.function.name, t.name);
    assert.equal(t.def.function.parameters.type, "object");
    assert.deepEqual(t.def.function.parameters.required, t.name === "search_code" ? ["repo", "query"] : ["repo"]);
  }
});

test("T2 repositories outside the whitelist are refused before any request", async () => {
  await network(async (calls) => {
    for (const repo of ["evil/repo", "https://github.com/evil/repo", "OmnixSI/TeamAgent-extra"]) {
      const r = await tool("search_pr_issue").run(env(), { repo, query: "x" }, {});
      assert.equal(r.ok, false);
      assert.equal(r.error_kind, "denied");
      assert.match(r.next_action, /OmnixSI\/TeamAgent/);
    }
    assert.equal(calls.length, 0);
  });
});

test("T3 PR/Issue search uses the whitelist qualifier, state and updated order", async () => {
  await network(async (calls) => {
    const r = await tool("search_pr_issue").run(env(), { repo: "TeamAgent", query: "cursor", state: "open" }, {});
    const u = new URL(calls[0].url), q = u.searchParams.get("q");
    assert.equal(u.pathname, "/search/issues");
    assert.match(q, /^repo:OmnixSI\/TeamAgent\b/);
    assert.match(q, /cursor/);
    assert.match(q, /state:open/);
    assert.equal(u.searchParams.get("sort"), "updated");
    assert.equal(u.searchParams.get("order"), "desc");
    assert.equal(u.searchParams.get("per_page"), "10");
    assert.equal(r.ok, true);
    assert.equal(r.repo, "OmnixSI/TeamAgent");
    assert.equal(r.untrusted, true);
    assert.equal(r.total, 2);
    assert.equal(r.truncated, false);
    assert.equal(r.results[0].kind, "pr");
    assert.equal(r.results[0].number, 34);
    assert.equal(r.results[0].state, "closed");
    assert.equal(r.results[0].author, "alice");
    assert.equal(r.results[0].html_url, "https://github.com/OmnixSI/TeamAgent/pull/34");
    assert.equal(r.results[1].kind, "issue");
    assert.equal(r.results[1].snippet.includes("\n"), false, "摘要要压成一行");
  }, () => Response.json({
    total_count: 2, incomplete_results: false, items: [
      issue(34, { state: "closed", pull_request: { url: "https://api.github.com/pulls/34" }, html_url: "https://github.com/OmnixSI/TeamAgent/pull/34" }),
      issue(12),
    ],
  }));
});

test("T4 empty query lists the most recently updated items for '最近的 PR'", async () => {
  await network(async (calls) => {
    const r = await tool("search_pr_issue").run(env(), { repo: "OmnixSI/TeamAgent" }, {});
    const q = new URL(calls[0].url).searchParams.get("q");
    assert.equal(q, "repo:OmnixSI/TeamAgent");
    assert.equal(r.ok, true);
    assert.equal(r.results.length, 2);
  }, () => Response.json({ total_count: 2, incomplete_results: false, items: [issue(1), issue(2)] }));
});

test("T5 results are capped and truncation is reported", async () => {
  await network(async () => {
    const r = await tool("search_pr_issue").run(env(), { repo: "TeamAgent", query: "d1" }, {});
    assert.equal(r.results.length, 10);
    assert.equal(r.returned, 10);
    assert.equal(r.total, 57);
    assert.equal(r.truncated, true);
  }, () => Response.json({ total_count: 57, incomplete_results: false, items: Array.from({ length: 20 }, (_, i) => issue(i + 1)) }));
});

test("T6 code search asks for text matches and maps paths/fragments", async () => {
  await network(async (calls) => {
    const r = await tool("search_code").run(env(), { repo: "群助手", query: "getChatCursor" }, {});
    const u = new URL(calls[0].url);
    assert.equal(u.pathname, "/search/code");
    assert.match(u.searchParams.get("q"), /^repo:OmnixSI\/TeamAgent\b/);
    assert.match(u.searchParams.get("q"), /getChatCursor/);
    assert.match(String(calls[0].options.headers.Accept), /text-match\+json/);
    assert.equal(r.ok, true);
    assert.equal(r.untrusted, true);
    assert.equal(r.results[0].path, "src/cursor.ts");
    assert.equal(r.results[0].name, "cursor.ts");
    assert.match(r.results[0].snippet, /getChatCursor/);
    assert.equal(r.results[0].html_url, "https://github.com/OmnixSI/TeamAgent/blob/main/src/cursor.ts");
    assert.equal(r.truncated, true);
  }, () => Response.json({
    total_count: 12, incomplete_results: false, items: [{
      name: "cursor.ts", path: "src/cursor.ts", html_url: "https://github.com/OmnixSI/TeamAgent/blob/main/src/cursor.ts",
      text_matches: [{ fragment: "export function getChatCursor(e) {", matches: [{ text: "getChatCursor" }] }],
    }],
  }));
});

test("T7 code search needs a term and a token", async () => {
  await network(async (calls) => {
    const noToken = await tool("search_code").run({}, { repo: "TeamAgent", query: "x" }, {});
    assert.equal(noToken.error_kind, "needs_token");
    assert.equal(noToken.ok, false);
    assert.ok(noToken.next_action);
    const empty = await tool("search_code").run(env(), { repo: "TeamAgent", query: "   " }, {});
    assert.equal(empty.error_kind, "invalid_args");
    assert.equal(calls.length, 0);
  });
});

test("T8 structured failures: rate limit, oversized reply, budget, invalid args", async () => {
  await network(async () => {
    const r = await tool("search_pr_issue").run(env(), { repo: "TeamAgent", query: "x" }, {});
    assert.equal(r.error_kind, "rate_limited");
    assert.equal(r.retryable, false, "限流按现有约定不可立即重试");
    assert.match(r.next_action, /限流/);
  }, () => new Response(null, { status: 429 }));
  await network(async () => {
    const r = await tool("search_code").run(env(), { repo: "TeamAgent", query: "x" }, {});
    assert.equal(r.error_kind, "too_large");
    assert.equal(r.retryable, false);
  }, () => Response.json({ items: [], padding: "x".repeat(300000) }));
  await network(async (calls) => {
    const e = env();
    e.meter = { gh: { n: 10, sha: {}, meta: {} } };
    const r = await tool("search_pr_issue").run(e, { repo: "TeamAgent", query: "x" }, {});
    assert.equal(r.error_kind, "budget");
    assert.equal(calls.length, 0);
  });
  await network(async (calls) => {
    for (const args of [
      {},
      { repo: "TeamAgent", query: "x".repeat(257) },
      { repo: "TeamAgent", query: "repo:evil/x" },
      { repo: "TeamAgent", query: "x", state: "merged" },
    ]) assert.equal((await tool("search_pr_issue").run(env(), args, {})).error_kind, "invalid_args");
    assert.equal(calls.length, 0);
  });
});

test("T9 group isolation: no D1 access and no group data in results", async () => {
  const e = { GITHUB_TOKEN: TOKEN, DB: { prepare() { throw new Error("repo search must not touch D1"); } } };
  await network(async () => {
    for (const group of ["GROUP_A", "GROUP_B"]) {
      const ctx = { context: { group_id: group }, messages: [], isTainted: () => false };
      const r = await tool("search_pr_issue").run(e, { repo: "TeamAgent", query: "x" }, ctx);
      assert.equal(r.ok, true);
      assert.equal(JSON.stringify(r).includes(group), false);
    }
  }, () => Response.json({ total_count: 1, incomplete_results: false, items: [issue(1)] }));
});

test("T10 every url returned is a github.com link", async () => {
  await network(async () => {
    const r = await tool("search_pr_issue").run(env(), { repo: "TeamAgent", query: "x" }, {});
    assert.match(r.results[0].html_url, /^https:\/\/github\.com\//);
    assert.equal(r.results[1].html_url, "", "非 github.com 的链接不外传");
  }, () => Response.json({
    total_count: 2, incomplete_results: false, items: [issue(1), issue(2, { html_url: "javascript:alert(1)" })],
  }));
});
