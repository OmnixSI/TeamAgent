// Offline tests for the app preview: token records, proxy paths, recipes, PR parsing, shell commands, limits.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

// computer.ts imports cloudflare:workers and preview.ts imports @cloudflare/puppeteer; neither is needed here.
import { registerHooks } from "node:module";
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    if (spec === "@cloudflare/puppeteer") return { url: "data:text/javascript,export default {}", shortCircuit: true };
    return next(spec, ctx);
  },
});
const P = await import("../src/feat/preview.ts");
const feature = P.default;

const kv = () => {
  const m = new Map();
  return { m, get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, sql: { exec: (q, k) => { if (/^DELETE FROM kv WHERE k=\?/.test(q)) m.delete(k); return { toArray: () => [] }; } } };
};

describe("tokens", () => {
  test("issue, check, expiry, unknown, revoke", () => {
    const hub = kv(), now = 1_000_000;
    const t = P.issueToken(hub, 4173, now, 60000);
    assert.match(t, /^[a-f0-9]{32}$/);
    assert.equal(P.checkToken(hub, t, now + 1000), 4173);
    assert.equal(P.checkToken(hub, t, now + 60001), 0, "expired");
    assert.equal(P.checkToken(hub, "a".repeat(32), now), 0, "unknown");
    assert.equal(P.checkToken(hub, "BAD-token", now), 0, "malformed");
    assert.notEqual(P.issueToken(hub, 1, now), t, "tokens are random");
    P.revokeToken(hub, t);
    assert.equal(P.checkToken(hub, t, now), 0, "revoked");
  });
  test("a corrupt record is refused", () => {
    const hub = kv(), t = "b".repeat(32);
    hub.set("preview:tok:" + t, "{oops");
    assert.equal(P.checkToken(hub, t, 0), 0);
    hub.set("preview:tok:" + t, JSON.stringify({ port: 99999, exp: 10 }));
    assert.equal(P.checkToken(hub, t, 0), 0, "port out of range");
  });
});

describe("proxy paths", () => {
  const t = "0123456789abcdef0123";
  test("strips the prefix and keeps path and query", () => {
    assert.deepEqual(P.stripPreview("/x/preview/" + t + "/assets/a.js", "?v=1"), { token: t, path: "/assets/a.js?v=1" });
    assert.deepEqual(P.stripPreview("/x/preview/" + t), { token: t, path: "/" });
    assert.deepEqual(P.stripPreview("/x/preview/" + t + "/"), { token: t, path: "/" });
    assert.deepEqual(P.stripPreview("/x/preview/" + t + "/api/shop/auth/login"), { token: t, path: "/api/shop/auth/login" });
  });
  test("rejects other paths and bad tokens", () => {
    assert.equal(P.stripPreview("/x/other/" + t + "/a"), null);
    assert.equal(P.stripPreview("/x/preview/short/a"), null);
    assert.equal(P.stripPreview("/x/preview/" + t.toUpperCase() + "/a"), null);
    assert.equal(P.stripPreview("/x/preview/" + t + "x/../a").token, t + "x", "token is only the segment");
  });
  test("local redirects keep only the path", () => {
    assert.equal(P.localPath("http://localhost:4173/#/login"), "/#/login");
    assert.equal(P.localPath("http://127.0.0.1:8787"), "/");
    assert.equal(P.localPath("/next"), "/next");
    assert.equal(P.localPath("https://example.com/x"), "https://example.com/x");
  });
  test("open hook: unknown token is refused, other paths are not ours", async () => {
    const hub = kv();
    assert.equal(await feature.open(hub, new Request("https://h/x/files/1"), new URL("https://h/x/files/1")), null);
    const r = await feature.open(hub, new Request("https://h/x/preview/" + t + "/"), new URL("https://h/x/preview/" + t + "/"));
    assert.equal(r.status, 403);
  });
  test("open hook forwards method, body and query to the container port", async () => {
    const hub = kv(), seen = [];
    const tok = P.issueToken(hub, 4173);
    hub.env = { COMPUTER: { idFromName: n => n, get: () => ({ proxy: async (port, req) => { seen.push({ port, url: req.url, method: req.method, body: await req.text(), xp: req.headers.get("x-preview") }); return new Response("ok", { status: 302, headers: { location: "http://localhost:4173/#/home" } }); } }) } };
    const u = "https://h/x/preview/" + tok + "/api/login?a=1";
    const r = await feature.open(hub, new Request(u, { method: "POST", body: "{\"x\":1}", headers: { "x-preview": tok } }), new URL(u));
    assert.deepEqual(seen, [{ port: 4173, url: "http://localhost:4173/api/login?a=1", method: "POST", body: "{\"x\":1}", xp: null }]);
    assert.equal(r.status, 302);
    assert.equal(r.headers.get("location"), "/#/home");
  });
});

describe("recipes", () => {
  test("table hits", () => {
    assert.equal(P.pickRecipe("peiwan-club-saas", [], null).port, 4173);
    assert.ok(P.pickRecipe("peiwan-club-saas", [], null).login.length === 3);
    assert.match(P.pickRecipe("nextthought-website", [], null).start, /http\.server 4174 --bind 0\.0\.0\.0 --directory public/);
    assert.ok(P.pickRecipe("NextThought", [], null).none);
    assert.ok(P.pickRecipe("TeamAgent", [], null).none);
    assert.ok(P.pickRecipe("WhalePartner", [], null).warn);
  });
  test("package.json fallback", () => {
    const vite = P.pickRecipe("x", ["package.json", "pnpm-lock.yaml"], { scripts: { dev: "vite", build: "vite build", preview: "vite preview" } });
    assert.equal(vite.pm, "pnpm");
    assert.equal(vite.build, "pnpm run build");
    assert.match(vite.start, /pnpm run preview --host 0\.0\.0\.0 --port 4180 --strictPort$/);
    const next = P.pickRecipe("y", ["package.json", "package-lock.json"], { scripts: { build: "next build", start: "next start" } });
    assert.match(next.install, /^npm ci/);
    assert.match(next.start, /npm run start -- -H 0\.0\.0\.0 -p 4180$/);
    const plain = P.pickRecipe("z", ["package.json"], { scripts: { start: "node server.js" } });
    assert.match(plain.start, /^PORT=4180 HOST=0\.0\.0\.0 npm run start$/);
    assert.ok(plain.warn, "unknown server: warn about the port");
    assert.match(P.pickRecipe("w", ["package.json", "yarn.lock"], { scripts: { dev: "vite" } }).install, /yarn install/);
  });
  test("static fallback and none", () => {
    assert.match(P.pickRecipe("s", ["index.html", "a.css"], null).start, /--directory \.$/);
    assert.match(P.pickRecipe("s", ["public", "README.md"], null).start, /--directory public$/);
    assert.ok(P.pickRecipe("n", ["README.md"], null).none);
    assert.ok(P.pickRecipe("n", ["package.json"], { scripts: { test: "node --test" } }).none);
  });
});

describe("GitHub", () => {
  test("PR resolution", () => {
    const p = P.parsePull({ number: 44, title: "订单列表", state: "open", html_url: "u", head: { ref: "feat/issue-18-orders-table", sha: "abc", repo: { full_name: "OmnixSI/peiwan-club-saas" } }, base: { ref: "main", repo: { full_name: "OmnixSI/peiwan-club-saas" } } });
    assert.deepEqual(p, { number: 44, title: "订单列表", state: "open", headRef: "feat/issue-18-orders-table", headSha: "abc", headRepo: "OmnixSI/peiwan-club-saas", baseRef: "main", fork: false, url: "u" });
    assert.equal(P.parsePull({ number: 1, merged_at: "x", head: { ref: "a", repo: { full_name: "me/r" } }, base: { ref: "main", repo: { full_name: "o/r" } } }).fork, true);
    assert.equal(P.parsePull({ number: 1, merged_at: "x", head: { ref: "a", repo: null }, base: { ref: "main" } }).state, "merged");
    assert.throws(() => P.parsePull({ message: "Not Found" }));
  });
  test("refspecs and ref validation", () => {
    assert.equal(P.refspecOf("main"), "refs/heads/main");
    assert.equal(P.refspecOf("feat/x"), "refs/heads/feat/x");
    assert.equal(P.refspecOf("refs/tags/v1"), "refs/tags/v1");
    assert.equal(P.refspecOf("a".repeat(40)), "a".repeat(40));
    assert.equal(P.validRef("feat/issue-18"), true);
    for (const bad of ["a b", "-x", "a..b", "x;rm", "$(id)", "a`b`", "x.lock"]) assert.equal(P.validRef(bad), false, bad);
  });
});

describe("commands", () => {
  test("quoting survives hostile strings in a real shell", () => {
    for (const s of ["plain", "it's", "$(touch /tmp/pwned)", "a\"b`c`", "x; rm -rf /", "中文 空格"]) {
      assert.equal(execFileSync("bash", ["-c", "printf %s " + P.q(s)]).toString(), s);
    }
  });
  test("clone never puts the token in a URL or config and later steps drop it", () => {
    const t = { label: "PR #44", slot: "pr44", refspec: "refs/pull/44/head" };
    const clone = P.cloneCommand("OmnixSI/peiwan-club-saas", t);
    assert.match(clone, /git "\$\{H\[@\]\}" fetch -q --depth 1 'https:\/\/github\.com\/OmnixSI\/peiwan-club-saas\.git' 'refs\/pull\/44\/head'/);
    assert.doesNotMatch(clone, /x-access-token:[^%]/);
    assert.doesNotMatch(clone, /remote add|config /);
    const cmds = P.prepareCommands("OmnixSI/peiwan-club-saas", t, P.RECIPES["peiwan-club-saas"]);
    assert.equal(cmds.length, 6, "stop, clone, install, build, seed, start");
    for (const c of cmds.slice(2)) assert.match(c, /^unset GH_TOKEN; set -o pipefail; export NODE_OPTIONS=--max-old-space-size=\d+ && cd '\/work\/preview\/pr44' && /);
    assert.match(cmds[3], /max-old-space-size=700/);
    assert.match(cmds[5], /max-old-space-size=320/);
    assert.match(cmds[5], /\(setsid nohup bash -c '.*' > '\/work\/preview\/pr44\.log' 2>&1 < \/dev\/null & echo \$! > '\/work\/preview\/pr44\.pid'\); /, "launched from a subshell");
    assert.match(cmds[5], /port 4173 is taken/);
    assert.match(cmds[0], /readlink \$p\/cwd/, "stop also sweeps processes left in the preview directory");
    assert.match(cmds[5], /curl -s -o \/dev\/null -m 2 http:\/\/127\.0\.0\.1:4173\//);
  });
  test("generated scripts parse in bash", () => {
    const t = { label: "x", slot: "ref", refspec: "refs/heads/it's" };
    for (const r of [P.RECIPES["peiwan-club-saas"], P.RECIPES["NextThought-Website"], P.RECIPES.WhalePartner]) {
      for (const c of [...P.prepareCommands("o/r", t, r), P.stopCommand("ref")]) execFileSync("bash", ["-n", "-c", c]);
    }
    const whale = P.prepareCommands("o/r", t, P.RECIPES.WhalePartner);
    assert.match(whale[2], /cd '\/work\/preview\/ref\/apps\/client'/);
    const site = P.prepareCommands("o/r", t, P.RECIPES["NextThought-Website"]);
    assert.equal(site.length, 3, "static site: stop, clone, start");
  });
});

describe("screenshots", () => {
  const s = (label, page, device) => ({ label, page, device, bytes: new Uint8Array(), truncated: false, title: "" });
  test("base-vs-PR pairs follow the PR's order, base first in each pair", () => {
    const base = [s("base", "/a", "desktop"), s("base", "/b", "desktop"), s("base", "/c", "phone")];
    const head = [s("pr", "/b", "desktop"), s("pr", "/a", "desktop"), s("pr", "/d", "desktop")];
    const pairs = P.pairShots(base, head);
    assert.deepEqual(pairs.map(p => [p.page, p.device, p.base?.label, p.head?.label]), [
      ["/b", "desktop", "base", "pr"], ["/a", "desktop", "base", "pr"], ["/d", "desktop", undefined, "pr"], ["/c", "phone", "base", undefined],
    ]);
  });
  test("pages and devices", () => {
    assert.deepEqual(P.normPages(undefined), ["/"]);
    assert.deepEqual(P.normPages(["#/orders", "minimal/", "/", "/", "", "/a", "/b", "/c", "/d", "/e"]), ["/#/orders", "/minimal/", "/", "/a", "/b", "/c"]);
    assert.deepEqual(P.normPages("/client.html#/me"), ["/client.html#/me"]);
    assert.deepEqual(P.devicesOf("both"), ["desktop", "phone"]);
    assert.deepEqual(P.devicesOf("phone"), ["phone"]);
    assert.deepEqual(P.devicesOf(undefined), ["desktop"]);
  });
});

describe("limits", () => {
  const hub = (fits, busy = null) => ({ plan: { fits: (n, a) => fits[n] === undefined || fits[n] >= a }, get: () => busy });
  test("refusals", () => {
    assert.equal(P.refusal(hub({})), "");
    assert.match(P.refusal(hub({ container_seconds: 899 })), /云电脑/);
    assert.match(P.refusal(hub({ browser_seconds: 10 })), /浏览器/);
    assert.match(P.refusal(hub({}, String(Date.now() - 60000))), /还在跑/);
    assert.equal(P.refusal(hub({}, String(Date.now() - 20 * 60000))), "", "a stale lock does not block");
  });
  test("tool checks input, unpreviewable repos and the daily cap before any work", async () => {
    let quota = true, sets = 0;
    const h = { plan: { fits: () => true }, get: () => null, set: () => { sets++; } };
    const host = { quota: async () => quota, cfg: k => ({ preview_daily: 8, preview_minutes: 8 })[k] };
    const tool = feature.tools({ hub: h, conv: "t:x", askers: [], host })[0];
    assert.equal(tool.name, "preview_app");
    assert.equal(tool.long, true);
    assert.match((await tool.run({ repo: "a b" })).error, /仓库名/);
    assert.match((await tool.run({ repo: "peiwan-club-saas", pr: -2 })).error, /正整数/);
    assert.match((await tool.run({ repo: "peiwan-club-saas", ref: "$(id)" })).error, /分支/);
    const nt = await tool.run({ repo: "NextThought" });
    assert.equal(nt.previewable, false);
    quota = false;
    assert.match((await tool.run({ repo: "peiwan-club-saas" })).error, /用完/);
    assert.equal(sets, 0, "nothing started");
    assert.equal(feature.tunables.preview_daily.default, 8);
    assert.ok(feature.about.length >= 3);
  });
});
