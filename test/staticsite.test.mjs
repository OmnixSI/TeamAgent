// Offline tests for src/feat/staticsite.ts: build planning, generated bash, the tar reader against real tar
// bytes, and deploys stored through publish.ts's tables and served by publish.ts's own route.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const S = await import("../src/feat/staticsite.ts");
const P = await import("../src/feat/publish.ts");
const X = await import("../src/feat/transfer.ts");
const feature = S.default;

// Made with Python's tarfile (GNU, pax and ustar formats): ./index.html, ./assets/{a.css,a.js}, a file under a
// 119-character path, ../escape.html, /etc/abs.txt, assets/../../up.txt (not in ustar), a symlink, a hard link,
// a .map, a .ttf and a duplicate assets/a.js.
const FX = {"gnu": "H4sIAAAAAAACE+2a746iMBTF2Tdh/TTzgZY/KsnGMfsAvkSFK+BUIG3Z0Uz23beMmcTRSSZrtmiW84sJ3hQw8XLaew9lXGhNRnPPHaFlPp2+HS3nx0++p8k08vyZNwCdNkL5vjdSGK/qnPasNDt5q/xH8+Rj/qMwTFLPD5F/5yy+501mDi35/ROwXMiqfvYVyaeJNgdJuiQyE79UtHmavE8VgmVaT5YLnamqNb5W2enYth/ix7HlQrxfO1mWzY4WXCw9cE/6P03qjeb/aXiu/zgNof8hWDf54XUtsudCNV2d/+iUfODVruB71tbF428oZDT63zqS/1f6j2fphf6jeA79D0HW1LqRxGRTPESPiBAhQoTIdXQ/6z/jP1dNXaxs4+dw/f9k3T/p/y/8n3QWe/4K679zRKCEKUkF0j4DQV4pykyjDkEtdhRsGhUY0qayQ0XdBfafejuvNwkCqo2qSHNN9snOA0m/SNorZE6KbypJwUtlykAcb9zfjpm9QcE9wvx/7f/GH/Wf2NMT1P9DUFbQwKj7f8ZJZ6Ilh28Avtb/hf8fw/8fyP8TOUQwYjiZjIu1dlmcXaH/MIH/B/0D9/X/0f23ZYD9dK2TaeDv9R+FEep/6B84p2/lnW7+8a7Y/xXFUd//x8dZqa9QWjtPveTQ/7/v/4XK7y//0TS1+Y/cb02D/9u2bKvZTrS3zH987v/P5uj/B+EVO3xGzaapDTNm4/I3rtB/Mo+h/0H4Bg2g/3e5+++K/r9//w//bxDyroUIAAAAAAAAAAAAAAAAAAAAAPhP+AMS23J0AFAAAA==", "pax": "H4sIAAAAAAACE+2awY6bMBCG6bVPQXPaPYCxQ4JUJVGPPfYVHJgAWQLINt1Eq757zUar7mZXihrVJCr/p0gwcsBSxr89M5mQSa3JaOa5I7LM4/j5ajm9fnCfxBH3/Jk3AJ02UtkpvXESsrLOaB8WZlddy/98Pn3rf25XQOL5EfzvnMWXrEnNoSW/XwGrRVXWD76iajnR5lCRLojMxC8UbZaTl61ChqnWk9VCp6psja9V+nps2w+x49hqIV+enayKZkcLJlceuCX9v3bqlfb/ODrV/3QaQf9DsG6yw9Napg+5aro6+9qp6o6Vu5ztw7bO739BIaPR/9aR/M/pX8ySd/rn8zn0PwRpU+umorBq8jt+DwsWLFiwXFu3c/6H7NsPuf9OMiPl7vz/4Nz/k/8n/PT8Fzz2/D3Of+dwwf1WmmIpA2UvpIKqqfMgKxWlplGHoJY7CjaNCgxpU9qhvO4C+5M9f6+vFgRUG1WSZprsEs+Cin5SZZ+o7Hpim7Ki4LE0RSCPL+5fF5q9+YzQ+yYYwu3n67/irf6nURJNEf8PQVFCA6PO/0NGOpUtOfwH4Lz+39X/Ber/A9X/ZAYRjBhGJmVyrfuYzNUcF+g/SlD/g/6B+/j/WP23YYD9dK2TbeDv9c+jGeJ/6B84p0/lnTb/eBf0f3Eh+vxfHHelPkJp7T71mEH//z7/lyq7Pf/z2dT6n7tvTRu9/2Xbhlsd7mR7Tf+L0/7PuUD+PwhP6PAZNZumNqExG5dzXKD/WAjofxA+QQPI/112/11W/+Oo/w1C1rUQAQAAAAAAAAAAAAAAAAAAAAD/Cb8BPisutwBQAAA=", "ustar": "H4sIAAAAAAACE+3Za2+bMBQGYPZPGJ/aDza3hEgT5b+4cLi0BiPbrImq/fc5qSq16aRN1SCpeB9FIpYTgTi8XA48FMaQNaE3n8jJNpvT0jlf/uH7bhPFnr/1FjAZK7RbpbdOPOyGiva8tb28VP3jLH1f/9gdATvPj1D/2eXfK1Xaw0j+8QgoctkNj74meRcYe5BkWiIb+K2m+i54PVUIXhoTFLkpdTda3+jy7dzDcSp8mSty8frfoGhVT3koCg+uKf9vi3qh8/8mOs9/mkbI/xLuVXV4vhflY6PVNFQ/Ji1vwq5vwj0fh+b2FxKymvw/zBT/v+U/2e4+5D/OMuR/CaUajJLEpWpu4luMMMIII4zmHl3L+d+Q266KSfpJktVKVqTDupPEnjrbMsGkGho2iJ643dvZ+j/J++t/muyi7Re//gumhW1Jv+zBqtNUWqUPp33pdrRmlozt3FQzTMxtwul3x6dvRoPVHZll6t92uAdes+MRN2vz7zP93zhJotTzE85D9yFbhqN7SnmqcP////MvdHV99Y+3qat/PH9revX1F+PoHvx5L8ZL1j85f/+TJej/L+IZHb5Vq9VgubX1nOv4RP43SYL8L+IbMrBm83f//yX/H9//x+j/L6KaRoQAAAAAAAAAAAAAAAAAAAAAAAAAAADgi/gNLXAqJgBQAAA="};
const LONG = "a-rather-long-directory-name-for-testing-gnu-tar-longlink-entries/second-level-folder/file-with-a-long-name.txt";
const gz = k => new Uint8Array(Buffer.from(FX[k], "base64"));
const raw = k => new Uint8Array(zlib.gunzipSync(gz(k)));
/** A stream that hands out the bytes in small uneven chunks, so header and data boundaries fall mid-chunk. */
const chunked = (b, n = 7) => new ReadableStream({ start(c) { for (let i = 0, k = n; i < b.length; i += k, k = (k % 13) + 3) c.enqueue(b.subarray(i, i + k)); c.close(); } });
const all = async it => { const out = []; for await (const e of it) out.push(e); return out; };
const enc = s => new TextEncoder().encode(s);
const dec = b => new TextDecoder().decode(b);

// ---------- fake hub: real SQLite with publish's, transfer's and this feature's tables, a Map for R2 ----------

function mkHub() {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(q, ...b) {
      if (!b.length && q.includes(";")) { db.exec(q); return { toArray: () => [] }; }
      const st = db.prepare(q), rows = /^\s*(SELECT|WITH)/i.test(q) || /RETURNING/i.test(q) ? st.all(...b) : (st.run(...b), []);
      return { toArray: () => rows };
    },
  };
  db.exec("CREATE TABLE kv(k TEXT PRIMARY KEY, v TEXT)");
  const files = new Map(), meta = new Map(), ops = { put: 0, del: 0 };
  const FILES = {
    files, ops, failAt: Infinity,
    async put(k, v, o) { if (++ops.put >= FILES.failAt) throw new Error("r2 down"); files.set(k, new Uint8Array(v instanceof Uint8Array ? v : await new Response(v).arrayBuffer())); meta.set(k, o); return { size: files.get(k).length }; },
    async get(k, o) {
      const v = files.get(k); if (!v) return null;
      const r = o?.range ? v.slice(o.range.offset, o.range.offset + o.range.length) : v;
      return { size: r.length, arrayBuffer: async () => r.buffer.slice(r.byteOffset, r.byteOffset + r.byteLength), body: new Blob([r]).stream() };
    },
    async delete(ks) { for (const k of [].concat(ks)) { ops.del++; files.delete(k); } },
  };
  const used = {}, limits = {};
  const hub = {
    sql, files, used, limits, meta,
    env: { FILES, PUBLIC_URL: "https://bot.example/", GITHUB_TOKEN: "ghs_secret_token" },
    get: k => db.prepare("SELECT v FROM kv WHERE k=?").get(k)?.v ?? null,
    set: (k, v) => db.prepare("INSERT INTO kv(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)),
    plan: {
      take(n, x) { if ((used[n] || 0) + x > (limits[n] ?? Infinity)) return false; used[n] = (used[n] || 0) + x; return true; },
      fits(n, x = 0) { return (used[n] || 0) + x <= (limits[n] ?? Infinity); },
      add(n, x) { used[n] = (used[n] || 0) + x; },
      used: n => used[n] || 0,
    },
    shadow: () => "",
    ctx: { waitUntil() {} },
  };
  sql.exec(P.default.schema); sql.exec(feature.schema); sql.exec(X.default.schema);
  return hub;
}
const serve = (hub, p, init = {}) => P.default.open(hub, new Request("https://bot.example" + p, init), new URL("https://bot.example" + p));
async function* entriesOf(list) { for (const [p, s] of list) yield { path: p, type: "file", size: enc(s).length, data: enc(s) }; }
/** publish.ts with versioned keys and the single-page fallback, as the lead is asked to add them. */
const PUB2 = { objectKey: (h, id, p) => { const v = h.get("site:ver:" + id); return v ? "site/" + id + "@" + v + "/" + p : "site/" + id + "/" + p; }, verKey: id => "site:ver:" + id, spaKey: id => "site:spa:" + id };
const store = (hub, o) => S.storeSite(hub, { id: "abcdefghijkl", conv: "t:r", name: "blog", ver: "v1", base: "/p/abcdefghijkl/", rewrite: false, spa: false, source: { kind: "repo", repo: "x", dir: "." }, by: "小明", note: "", ...o });

// ---------- inputs ----------

describe("names and inputs", () => {
  test("site names", () => {
    assert.equal(S.siteName(" Blog "), "blog");
    assert.equal(S.siteName("官网"), "官网");
    assert.equal(S.siteName("my site"), "my-site");
    for (const bad of ["", "a/b", "../x", "a'b", "$(id)", "x".repeat(41), "a;b"]) assert.equal(S.siteName(bad), null, bad);
  });
  test("sub-folders stay inside the project", () => {
    assert.equal(S.subDir(""), "."); assert.equal(S.subDir("./apps/web/"), "apps/web"); assert.equal(S.subDir("docs/.vitepress/dist"), "docs/.vitepress/dist");
    for (const bad of ["../x", "a/../../b", "/etc", "a b", "a'b", "a;rm -rf /", "$(id)", "a//b", "a/./b"]) assert.equal(S.subDir(bad), null, bad);
  });
  test("repository names", () => {
    assert.equal(S.repoName("https://github.com/OmnixSI/NextThought-Website.git"), "OmnixSI/NextThought-Website");
    for (const bad of ["a/b/c", "../x", "a b", "a;b", "x/.."]) assert.equal(S.repoName(bad), null, bad);
  });
});

// ---------- the probe, run for real with node ----------

describe("probe", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-probe-"));
  test("reads package.json, lockfiles and index folders", () => {
    fs.mkdirSync(path.join(tmp, "apps/web/public"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ workspaces: ["apps/*"], packageManager: "pnpm@9.12.0" }));
    fs.writeFileSync(path.join(tmp, "pnpm-lock.yaml"), "");
    fs.writeFileSync(path.join(tmp, "apps/web/package.json"), JSON.stringify({ type: "module", scripts: { build: "tsc && vite build" }, dependencies: { react: "1" }, devDependencies: { vite: "7", typescript: "5" } }));
    fs.writeFileSync(path.join(tmp, "apps/web/public/index.html"), "<p>");
    const out = execFileSync("node", ["-e", S.PROBE_JS, tmp, "apps/web"], { encoding: "utf8" });
    const p = S.parseProbe(out);
    assert.equal(p.exists, true);
    assert.deepEqual(p.pkg.deps, ["vite"]); assert.equal(p.pkg.count, 3); assert.equal(p.pkg.type, "module");
    assert.equal(p.rootPkg.workspaces, true); assert.equal(p.rootPkg.pm, "pnpm@9.12.0");
    assert.ok(p.rootFiles.includes("pnpm-lock.yaml")); assert.deepEqual(p.index, ["public"]);
    const plan = S.planBuild(p, { base: "/p/abcdefghijkl/", dir: "apps/web" });
    assert.equal(plan.installAt, "root"); assert.match(plan.install, /pnpm@9 .*pnpm install --frozen-lockfile/);
    assert.equal(plan.build, "pnpm run build --base=/p/abcdefghijkl/"); assert.equal(plan.framework, "Vite");
  });
  test("a missing folder and garbage output", () => {
    const p = S.parseProbe(execFileSync("node", ["-e", S.PROBE_JS, tmp, "nope"], { encoding: "utf8" }));
    assert.equal(p.exists, false);
    assert.match(S.planBuild(p, { base: "/p/x/", dir: "nope" }).error, /找不到 nope/);
    assert.equal(S.parseProbe("hello\nPROBE {bad"), null);
    assert.equal(S.parseProbe(""), null);
  });
});

// ---------- planning ----------

const probe = (pkg, files = ["package.json", "package-lock.json"], index = [], extra = {}) => ({ exists: true, files, rootFiles: files, pkg: pkg && { scripts: {}, deps: [], pm: "", type: "", workspaces: false, count: 5, ...pkg }, rootPkg: null, index, ...extra });
const BASE = "/p/abcdefghijkl/";
const plan = (p, o = {}) => S.planBuild(p, { base: BASE, dir: ".", ...o });

describe("build plans per framework", () => {
  test("Vite gets --base, npm passes it after --", () => {
    const r = plan(probe({ scripts: { build: "vue-tsc -b && vite build" }, deps: ["vite"] }));
    assert.equal(r.build, "npm run build -- --base=" + BASE); assert.equal(r.install, "npm ci --no-audit --no-fund --loglevel=error");
    assert.equal(r.rewrite, false); assert.equal(r.outs[0], "dist");
  });
  test("Vite not in the last step: no flag, links rewritten, a warning", () => {
    const r = plan(probe({ scripts: { build: "vite build && node post.js" }, deps: ["vite"] }));
    assert.equal(r.build, "npm run build"); assert.equal(r.rewrite, true); assert.match(r.warn.join(), /不在最后/);
  });
  test("Astro, VitePress, Angular take flags", () => {
    assert.equal(plan(probe({ scripts: { build: "astro build" }, deps: ["astro"] }, ["package.json", "yarn.lock"])).build, "yarn run build --base " + BASE);
    const vp = plan(probe({ scripts: { build: "vitepress build docs" } }));
    assert.equal(vp.build, "npm run build -- --base " + BASE); assert.equal(vp.outs[0], "docs/.vitepress/dist");
    assert.equal(plan(probe({ scripts: { build: "ng build" } })).build, "npm run build -- --base-href " + BASE);
  });
  test("Create React App uses PUBLIC_URL without the trailing slash", () => {
    const r = plan(probe({ scripts: { build: "react-scripts build" } }));
    assert.deepEqual(r.env, { PUBLIC_URL: "/p/abcdefghijkl" }); assert.equal(r.outs[0], "build"); assert.equal(r.build, "npm run build");
  });
  test("Vue CLI gets a config wrapper through VUE_CLI_SERVICE_CONFIG_PATH", () => {
    const r = plan(probe({ scripts: { build: "vue-cli-service build" } }, ["package.json", "vue.config.js"]));
    assert.equal(r.env.VUE_CLI_SERVICE_CONFIG_PATH, "$PWD/.deploy.vue.config.cjs"); assert.equal(r.prep.length, 1); assert.equal(r.rewrite, false);
    const m = plan(probe({ scripts: { build: "vue-cli-service build" } }, ["package.json", "vue.config.mjs"]));
    assert.equal(m.rewrite, true); assert.equal(m.prep.length, 0);
  });
  test("Docusaurus edits baseUrl; no config is an error", () => {
    assert.equal(plan(probe({ scripts: { build: "docusaurus build" } }, ["package.json", "docusaurus.config.js"])).prep.length, 1);
    assert.match(plan(probe({ scripts: { build: "docusaurus build" } })).error, /docusaurus/);
  });
  test("Next.js: wrapper for js/mjs or none, refusal for ts", () => {
    const r = plan(probe({ scripts: { build: "next build" } }, ["package.json", "next.config.js"]));
    assert.match(r.prep[0], /mv -f 'next.config.js' 'next.config.orig.cjs'/); assert.deepEqual(r.outs.slice(0, 1), ["out"]); assert.match(r.warn.join(), /静态导出/);
    assert.match(plan(probe({ scripts: { build: "next build" }, type: "module" }, ["package.json", "next.config.js"])).prep[0], /next\.config\.orig\.mjs/);
    assert.doesNotMatch(plan(probe({ scripts: { build: "next build" } })).prep[0], /mv -f/);
    assert.match(plan(probe({ scripts: { build: "next build" } }, ["package.json", "next.config.ts"])).error, /TypeScript/);
  });
  test("Nuxt generate with NUXT_APP_BASE_URL", () => {
    const r = plan(probe({ scripts: { build: "nuxt build", generate: "nuxt generate" }, deps: ["nuxt"] }));
    assert.equal(r.build, "npm run generate"); assert.equal(r.env.NUXT_APP_BASE_URL, BASE); assert.equal(r.outs[0], ".output/public");
  });
  test("unknown build script: build, then rewrite links (the team's website)", () => {
    const r = plan(probe({ scripts: { build: "node scripts/build.mjs", dev: "python3 -m http.server" }, count: 0 }, ["package.json", "public", "scripts"], ["public"]));
    assert.equal(r.kind, "build"); assert.equal(r.install, undefined); assert.equal(r.build, "npm run build"); assert.equal(r.rewrite, true);
    assert.ok(r.outs.indexOf("dist") < r.outs.indexOf("public"));
  });
  test("package managers", () => {
    assert.match(S.installCommand(["pnpm-lock.yaml"], "").cmd, /pnpm@10 .*--frozen-lockfile/);
    assert.match(S.installCommand([], "yarn@4.1.0").cmd, /corepack enable.*yarn install$/);
    assert.match(S.installCommand(["yarn.lock"], "yarn@4.1.0").cmd, /--immutable/);
    assert.match(S.installCommand(["yarn.lock"], "").cmd, /yarn install --frozen-lockfile/);
    assert.equal(S.installCommand([], "").cmd, "npm install --no-audit --no-fund --loglevel=error");
    assert.match(S.installCommand(["bun.lockb"], "").warn, /bun/);
  });
  test("static sites, build=false and out_dir", () => {
    const st = plan(probe(null, ["index.html", "a.css"], ["."]));
    assert.equal(st.kind, "static"); assert.equal(st.outs[0], "."); assert.equal(st.rewrite, true);
    const nb = plan(probe({ scripts: { build: "vite build" } }, ["package.json"], ["public"]), { build: false });
    assert.equal(nb.kind, "static"); assert.equal(nb.outs[0], "public");
    assert.deepEqual(plan(probe({ scripts: { build: "vite build" } }), { outDir: "web/out" }).outs, ["web/out"]);
    assert.match(plan(probe(null, ["README.md"])).error, /找不到 index.html/);
    assert.match(plan(probe({ scripts: { dev: "vite" } }, ["package.json"])).error, /没有 build 脚本/);
  });
});

// ---------- generated bash ----------

const bashOk = cmd => { const r = spawnSync("bash", ["-n", "-c", cmd], { encoding: "utf8" }); assert.equal(r.status, 0, r.stderr + "\n" + cmd); };
describe("generated bash", () => {
  const W = "/work/deploy/abcdefghijkl";
  const plans = [
    plan(probe({ scripts: { build: "vite build" }, deps: ["vite"] })),
    plan(probe({ scripts: { build: "vue-cli-service build" } }, ["package.json", "vue.config.js"])),
    plan(probe({ scripts: { build: "docusaurus build" } }, ["package.json", "docusaurus.config.js"])),
    plan(probe({ scripts: { build: "next build" } }, ["package.json", "next.config.mjs"])),
    plan(probe({ scripts: { build: "react-scripts build" } })),
    plan(probe(null, ["index.html"], ["."])),
  ];
  test("every command parses", () => {
    for (const c of S.cloneCommands(W, "OmnixSI/x", "refs/pull/12/head")) bashOk(c);
    for (const c of S.archiveCommands(W, W + "/in.pack")) bashOk(c);
    bashOk(S.probeCommand(W, "apps/web"));
    for (const p of plans) for (const c of S.buildCommands(W, "apps/web", p, W + "/site.tgz")) bashOk(c);
  });
  test("hostile values stay single words, even when run", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-evil-"));
    for (const evil of ["x'; touch pwned1; echo '", "$(touch pwned2)", "`touch pwned3`", "x\"; touch pwned4; echo \"", "a\nb; touch pwned5"]) {
      const cmds = [...S.cloneCommands(evil, "o/r", evil), ...S.archiveCommands(evil, evil), S.probeCommand(evil, evil),
        ...S.buildCommands(evil, evil, { ...plans[0], outs: [evil], env: { A: evil }, prep: [] }, evil)];
      for (const c of cmds) {
        bashOk(c);
        // https is refused before any network use; every command stops at its first cd or fetch into the odd path.
        spawnSync("bash", ["-c", c], { cwd: d, env: { ...process.env, GIT_ALLOW_PROTOCOL: "file", PATH: process.env.PATH }, timeout: 10000 });
      }
    }
    assert.deepEqual(fs.readdirSync(d).filter(f => f.startsWith("pwned")), []);
  });
  test("the token never reaches install or build", () => {
    for (const p of plans) for (const c of S.buildCommands(W, ".", p, W + "/site.tgz")) assert.ok(c.startsWith("unset GH_TOKEN; "), c);
    assert.ok(S.probeCommand(W, ".").startsWith("unset GH_TOKEN; "));
    const clone = S.cloneCommands(W, "o/r", "HEAD")[0];
    assert.doesNotMatch(clone, /ghs_|github\.com\/.*@/); assert.match(clone, /http\.extraHeader/);
  });
  test("pack step checks limits and prints one DEPLOY line", () => {
    const c = S.buildCommands(W, ".", plans[0], W + "/site.tgz", { files: 800, bytes: 60 * 1048576 }).pop();
    assert.match(c, /-le 800 \]/); assert.match(c, /--format=gnu/); assert.match(c, /! -name '\*\.map'/);
    assert.deepEqual(S.parseDeploy('noise\nDEPLOY {"out":"dist","files":3,"bytes":1200,"pack":800}\n'), { out: "dist", files: 3, bytes: 1200, pack: 800 });
    assert.equal(S.parseDeploy("nothing"), null);
  });
  test("framework helpers work when run (node)", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-fw-"));
    const at = cmd => execFileSync("bash", ["-c", "cd " + S.q(d) + " && " + cmd], { encoding: "utf8" });
    fs.writeFileSync(path.join(d, "docusaurus.config.js"), "module.exports = { title: 'x', url: 'https://a.b', baseUrl: '/', };");
    at(plans[2].prep[0]);
    assert.match(fs.readFileSync(path.join(d, "docusaurus.config.js"), "utf8"), /baseUrl: "\/p\/abcdefghijkl\/"/);
    fs.writeFileSync(path.join(d, "docusaurus.config.js"), "const a = { baseUrl: '/' }; const b = { baseUrl: '/x/' };");
    assert.throws(() => at(plans[2].prep[0]));
    fs.writeFileSync(path.join(d, "vue.config.js"), "module.exports = { lintOnSave: false, publicPath: '/' };");
    at(plans[1].prep[0]);
    const vue = JSON.parse(execFileSync("node", ["-e", "console.log(JSON.stringify(require(process.argv[1])))", path.join(d, ".deploy.vue.config.cjs")], { encoding: "utf8" }));
    assert.deepEqual(vue, { lintOnSave: false, publicPath: BASE });
    fs.writeFileSync(path.join(d, "next.config.js"), "module.exports = { reactStrictMode: true, images: { domains: ['a'] } };");
    at(S.planBuild(probe({ scripts: { build: "next build" } }, ["package.json", "next.config.js"]), { base: BASE, dir: "." }).prep[0]);
    const next = JSON.parse(execFileSync("node", ["--input-type=module", "-e", "const m = await import(process.argv[1]); console.log(JSON.stringify(await m.default('phase-production-build', {})))", path.join(d, "next.config.mjs")], { encoding: "utf8" }));
    assert.deepEqual(next, { reactStrictMode: true, images: { domains: ["a"], unoptimized: true }, output: "export", basePath: "/p/abcdefghijkl", trailingSlash: true });
  });
});

// ---------- tar ----------

describe("tar reader", () => {
  for (const fmt of ["gnu", "pax", "ustar"]) {
    test(fmt + ": entries, long names, links reported without data", async () => {
      const list = await all(S.untar(S.gunzip(chunked(gz(fmt)))));
      const files = list.filter(e => e.type === "file").map(e => e.path);
      assert.ok(files.includes("./index.html") && files.includes("./assets/a.css"));
      assert.ok(files.includes(LONG), "long name: " + files.join(","));
      assert.equal(dec(list.find(e => e.path === "./assets/a.js").data), "console.log(1)".repeat(100));
      assert.ok(list.find(e => e.path === "link.html" && e.type === "link" && !e.data));
      assert.ok(list.find(e => e.path === "hard.html" && e.type === "link"));
      assert.ok(list.find(e => e.path.replace(/\/$/, "") === "./assets" && e.type === "dir"));
      if (fmt !== "ustar") assert.ok(files.includes("../escape.html") && files.includes("/etc/abs.txt"));
    });
  }
  test("the real GNU tar, when this machine has one", async t => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-tar-"));
    fs.mkdirSync(path.join(d, path.dirname(LONG)), { recursive: true });
    fs.writeFileSync(path.join(d, LONG), "hi"); fs.writeFileSync(path.join(d, "index.html"), "<p>");
    fs.symlinkSync("/etc/passwd", path.join(d, "evil.html"));
    const gnu = spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.includes("GNU") ? ["--format=gnu"] : ["--format", "gnutar"];
    const r = spawnSync("tar", [...gnu, "-czf", "-", "-C", d, "."], { maxBuffer: 1 << 24 });
    if (r.status !== 0) return t.skip("no tar that writes the GNU format");
    const list = await all(S.untar(S.gunzip(chunked(new Uint8Array(r.stdout), 50))));
    assert.ok(list.some(e => e.path.replace(/^\.\//, "") === LONG && dec(e.data) === "hi"));
    assert.ok(list.some(e => e.path.endsWith("evil.html") && e.type === "link"));
  });
  test("want() keeps unwanted contents out of memory", async () => {
    const list = await all(S.untar(S.gunzip(chunked(gz("gnu"))), { want: p => p.endsWith(".css") }));
    assert.ok(list.filter(e => e.data).every(e => e.path.endsWith(".css")));
  });
  test("damage and limits", async () => {
    const r = raw("gnu");
    const bad = r.slice(); bad[10] ^= 0xff;
    await assert.rejects(all(S.untar(chunked(bad))), /校验/);
    await assert.rejects(all(S.untar(chunked(r.slice(0, 700)))), /不完整/);
    await assert.rejects(all(S.untar(chunked(r), { maxEntries: 3 })), /太多/);
    await assert.rejects(all(S.untar(chunked(r), { maxRaw: 2000 })), /太大/);
    assert.deepEqual(await all(S.untar(chunked(new Uint8Array(1024)))), []);
    await assert.rejects(all(S.untar(S.gunzip(chunked(enc("not gzip at all"))))));
  });
  test("entry paths", () => {
    assert.equal(S.cleanEntryPath("./a//b/./c.js"), "a/b/c.js");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "..\\x", ".", ""]) assert.equal(S.cleanEntryPath(bad), null, bad);
  });
});

// ---------- links from the root ----------

describe("root-absolute links", () => {
  test("html and css", () => {
    const h = '<link href="/gallery.css"><a href="/">home</a><a href=/minimal/>m</a><img src="/a.png" srcset="/a.png 1x, /b.png 2x, https://x/c.png 3x">' +
      '<script src="//cdn.x/y.js"></script><a href="https://x/">x</a><a href="#top">t</a><img src="rel.png"><div style="background:url(/bg.png)"></div><a href="/p/abcdefghijkl/ok">ok</a>';
    const out = S.rewriteRoot(h, BASE, "html");
    assert.match(out, /href="\/p\/abcdefghijkl\/gallery\.css"/); assert.match(out, /href="\/p\/abcdefghijkl\/">home/);
    assert.match(out, /href=\/p\/abcdefghijkl\/minimal\/>/); assert.match(out, /srcset="\/p\/abcdefghijkl\/a\.png 1x, \/p\/abcdefghijkl\/b\.png 2x, https:\/\/x\/c\.png 3x"/);
    assert.match(out, /src="\/\/cdn\.x\/y\.js"/); assert.match(out, /url\(\/p\/abcdefghijkl\/bg\.png\)/); assert.match(out, /href="\/p\/abcdefghijkl\/ok"/);
    assert.match(out, /src="rel\.png"/);
    assert.equal(S.rewriteRoot(out, BASE, "html"), out, "running it twice changes nothing");
    assert.equal(S.rewriteRoot("@import '/a.css'; b{background:url( \"/x.woff2\" )} c{background:url(data:x)}", BASE, "css"), "@import '/p/abcdefghijkl/a.css'; b{background:url(\"/p/abcdefghijkl/x.woff2\")} c{background:url(data:x)}");
  });
});

// ---------- storing and serving ----------

describe("store through publish.ts", () => {
  test("today's publish.ts: in-place mode, served by publish's own route", async () => {
    const hub = mkHub();
    const s = S.support(P);
    assert.deepEqual([s.versioned, s.spa], [false, false]);
    const r = await store(hub, { s, rewrite: true, entries: S.untar(S.gunzip(chunked(gz("gnu")))) });
    assert.equal(r.ok, true, r.error);
    assert.equal(r.files, 3);   // index.html, a.css, a.js; the long path has a 65-letter folder, over publish.ts's 60
    assert.ok(r.skipped.some(x => x.startsWith(LONG) && /不支持/.test(x)));
    assert.ok(r.skipped.some(x => /link\.html.*链接/.test(x)) && r.skipped.some(x => /escape.*不安全/.test(x)) && r.skipped.some(x => /font\.ttf.*不支持/.test(x)) && r.skipped.some(x => /\.map/.test(x)));
    const res = await serve(hub, "/p/abcdefghijkl/");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /href="\/p\/abcdefghijkl\/assets\/a\.css"/);
    assert.equal(await (await serve(hub, "/p/abcdefghijkl/assets/a.css")).text(), "body{background:url(/p/abcdefghijkl/img/x.png)}");
    assert.ok(![...hub.files.keys()].some(k => /escape|abs|up\.txt|passwd/.test(k)));
    assert.equal(hub.used.r2_writes, 3);
    const site = hub.sql.exec("SELECT * FROM site").toArray()[0];
    assert.equal(site.by, "deploy"); assert.equal(site.files, 3); assert.equal(site.title, "blog");
    assert.equal(S.deployRow(hub, "t:r", "blog").files, 3);
  });
  test("in place: a redeploy keeps old assets until the delay, never deletes live files", async () => {
    const hub = mkHub(), s = S.support(P);
    await store(hub, { s, now: 1000, entries: entriesOf([["index.html", "v1 <script src=a-1.js>"], ["a-1.js", "1"], ["keep.css", "k1"]]) });
    const order = [];
    const put = hub.env.FILES.put; hub.env.FILES.put = async (k, v, o) => { order.push(k.split("/").pop()); return put(k, v, o); };
    const r = await store(hub, { s, now: 2000, entries: entriesOf([["index.html", "v2 <script src=a-2.js>"], ["a-2.js", "2"], ["keep.css", "k2"]]) });
    assert.equal(r.ok, true);
    assert.deepEqual(order, ["a-2.js", "keep.css", "index.html"], "new paths first, replaced files after, pages last");
    assert.equal(await (await serve(hub, "/p/abcdefghijkl/")).text(), "v2 <script src=a-2.js>");
    assert.equal((await serve(hub, "/p/abcdefghijkl/a-1.js")).status, 404, "no longer listed");
    assert.ok(hub.files.has("site/abcdefghijkl/a-1.js"), "but still stored for pages opened before");
    assert.equal(await S.collectGarbage(hub, 2000 + 60000, s), 0);
    // a-1.js comes back before the old copy is collected: it must survive the sweep
    await store(hub, { s, now: 3000, entries: entriesOf([["index.html", "v3"], ["a-1.js", "again"]]) });
    assert.equal(await S.collectGarbage(hub, 3000 + S.LIMITS.gcDelayMs + 1, s), 2, "a-2.js and keep.css go, a-1.js stays");
    assert.equal(await (await serve(hub, "/p/abcdefghijkl/a-1.js")).text(), "again");
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM deploy_gc").toArray()[0].n, 0);
  });
  test("versioned keys: switch in one step, old version removed later, single-page fallback flag", async () => {
    const hub = mkHub(), s = S.support(PUB2);
    assert.deepEqual([s.versioned, s.spa], [true, true]);
    await store(hub, { s, ver: "v1", spa: true, now: 1000, entries: entriesOf([["index.html", "one"], ["a.js", "1"]]) });
    assert.deepEqual([...hub.files.keys()].sort(), ["site/abcdefghijkl@v1/a.js", "site/abcdefghijkl@v1/index.html"]);
    assert.equal(hub.get("site:ver:abcdefghijkl"), "v1"); assert.equal(hub.get("site:spa:abcdefghijkl"), "1");
    await store(hub, { s, ver: "v2", now: 2000, entries: entriesOf([["index.html", "two"]]) });
    assert.equal(hub.get("site:ver:abcdefghijkl"), "v2"); assert.equal(hub.get("site:spa:abcdefghijkl"), "");
    assert.ok(hub.files.has("site/abcdefghijkl@v1/index.html"));
    assert.equal(await S.collectGarbage(hub, 2000 + S.LIMITS.gcDelayMs, s), 2);
    assert.deepEqual([...hub.files.keys()], ["site/abcdefghijkl@v2/index.html"]);
    assert.equal(PUB2.objectKey(hub, "abcdefghijkl", "index.html"), "site/abcdefghijkl@v2/index.html");
  });
  test("a failed write leaves the old site exactly as it was", async () => {
    for (const s of [S.support(P), S.support(PUB2)]) {
      const hub = mkHub();
      await store(hub, { s, ver: "v1", entries: entriesOf([["index.html", "old"], ["a.js", "1"]]) });
      const before = new Map(hub.files);
      hub.env.FILES.failAt = hub.env.FILES.ops.put + 2;
      const r = await store(hub, { s, ver: "v2", entries: entriesOf([["b.js", "new"], ["c.js", "new"], ["index.html", "new"]]) });
      assert.equal(r.ok, false); assert.match(r.error, /r2 down/);
      assert.deepEqual(new Map(hub.files), before);
      assert.deepEqual(hub.sql.exec("SELECT path FROM site_file ORDER BY path").toArray().map(x => x.path), ["a.js", "index.html"]);
      assert.equal(S.deployRow(hub, "t:r", "blog").ver, s.versioned ? "v1" : "");
    }
  });
  test("limits: files, bytes, one file, index, all sites, R2 writes", async () => {
    const s = S.support(P);
    const many = n => entriesOf([["index.html", "i"], ...Array.from({ length: n }, (_, i) => ["f" + i + ".js", "x"])]);
    let hub = mkHub();
    let r = await store(hub, { s, entries: many(S.LIMITS.siteFiles) });
    assert.match(r.error, /最多 800 个文件/); assert.equal(hub.files.size, 0); assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM site").toArray()[0].n, 0);
    const big = (async function* () { yield { path: "index.html", type: "file", size: 5, data: enc("hello") }; for (let i = 0; i < 3; i++) yield { path: i + ".png", type: "file", size: 24 << 20, data: new Uint8Array(24 << 20) }; })();
    r = await store(hub, { s, entries: big });
    assert.match(r.error, /超过 60\.0 MB/); assert.equal(hub.files.size, 0);
    r = await store(hub, { s, entries: (async function* () { yield { path: "index.html", type: "file", size: 30 << 20 }; })() });
    assert.match(r.error, /单个文件最多/);
    r = await store(hub, { s, entries: entriesOf([["about.html", "x"]]) });
    assert.match(r.error, /没有 index\.html/); assert.equal(hub.files.size, 0);
    hub = mkHub(); hub.limits.r2_writes = 1;
    r = await store(hub, { s, entries: entriesOf([["a.js", "1"], ["index.html", "i"]]) });
    assert.match(r.error, /R2 写入/); assert.equal(hub.files.size, 0);
    hub = mkHub();
    for (let i = 0; i < S.LIMITS.sites; i++) assert.equal((await store(hub, { s, id: "site" + String(i).padStart(8, "0"), name: "s" + i, entries: entriesOf([["index.html", "i"]]) })).ok, true);
    r = await store(hub, { s, id: "zzzzzzzzzzzz", name: "one-more", entries: entriesOf([["index.html", "i"]]) });
    assert.match(r.error, /12 个网站/);
    assert.equal((await store(hub, { s, id: "site00000000", name: "s0", entries: entriesOf([["index.html", "again"]]) })).ok, true, "redeploying an existing one still works");
  });
  test("delete removes rows and files", async () => {
    for (const s of [S.support(P), S.support(PUB2)]) {
      const hub = mkHub();
      await store(hub, { s, entries: entriesOf([["index.html", "x"], ["a.js", "1"]]) });
      assert.equal(await S.deleteSite(hub, "t:r", "blog", s), true);
      assert.equal(hub.files.size, 0); assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM site_file").toArray()[0].n, 0);
      assert.equal((await serve(hub, "/p/abcdefghijkl/")).status, 404);
      assert.equal(await S.deleteSite(hub, "t:r", "blog", s), false);
    }
  });
});

// ---------- the whole job with a fake cloud computer ----------

function tgzOf(list) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-out-"));
  for (const [p, c] of list) { fs.mkdirSync(path.dirname(path.join(d, p)), { recursive: true }); fs.writeFileSync(path.join(d, p), c); }
  return new Uint8Array(execFileSync("tar", ["-czf", "-", "-C", d, "."], { maxBuffer: 1 << 26 }));
}
function fakeComputer(o) {
  const calls = [];
  return {
    calls,
    runComputer: async (hub, req) => {
      calls.push(req);
      if (req.commands.length === 1 && req.commands[0].startsWith("rm -rf")) return { ok: true, steps: [], files: [], seconds: 0 };
      if (req.commands.at(-1).includes("PROBE")) return { ok: true, files: [], seconds: 3, steps: [...req.commands.slice(0, -1).map(c => ({ command: c, exit: 0, stdout: c.includes("git init") ? "COMMIT abc1234 首页改版" : "", stderr: "", seconds: 1 })), { command: req.commands.at(-1), exit: 0, stdout: "PROBE " + JSON.stringify(o.probe), stderr: "", seconds: 0.2 }] };
      if (o.fail) return { ok: false, files: [], seconds: 9, steps: [{ command: req.commands.at(-2), exit: 137, stdout: "", stderr: "", seconds: 9 }] };
      const pack = o.pack, deployLine = 'DEPLOY {"out":"dist","files":3,"bytes":100,"pack":' + pack.length + "}";
      const steps = req.commands.map(c => ({ command: c, exit: 0, stdout: c.includes("tar --format") ? deployLine : "", stderr: "", seconds: 1 }));
      if (o.big) {   // what the upload loop would have done: parts into the transfer key
        const name = req.commands.at(-1).match(/\/x\/put\/([0-9a-f]{32})\/([^'"]+)/);
        const g = X.grant(hub, name[1]), key = X.allowed(g, "put", decodeURIComponent(name[2]));
        hub.sql.exec("INSERT INTO xfer(key,size,parts,done,at) VALUES(?,?,2,1,0)", key, pack.length);
        const half = pack.length >> 1;
        await hub.env.FILES.put(X.partKey(key, 0), pack.slice(0, half)); await hub.env.FILES.put(X.partKey(key, 1), pack.slice(half));
        return { ok: true, files: [], skipped: ["deploy/…/site.tgz（超过 25 MB）"], steps, seconds: 30 };
      }
      return { ok: true, files: [{ name: req.collect[0], bytes: pack }], steps, seconds: 30 };
    },
  };
}
const vprobe = { exists: true, files: ["package.json", "package-lock.json", "index.html"], rootFiles: [], pkg: { scripts: { build: "vite build" }, deps: ["vite"], pm: "", type: "module", workspaces: false, count: 2 }, rootPkg: null, index: ["."] };
const ctxOf = (hub, extra = {}) => {
  const said = [];
  return { said, hub, conv: "t:r", askers: [{ id: "1", name: "小明" }], host: {
    cfg: k => (k === "deploy_daily" ? 4 : 0), quota: async () => true, advice: () => null, say: async t => { said.push(t); return true; },
    boxIn: ref => ref === "x7" ? { name: "site's build.zip", command: "curl -fsS https://bot.example/x/get/t/n -o '/work/site'\\''s build.zip'" } : null,
    fileRef: async ref => (ref === "f3" ? { name: "dist.tar.gz", bytes: tgzOf([["index.html", "<p>up</p>"]]) } : null),
    ...extra,
  } };
};

describe("deploy job", () => {
  test("repo: token only in the first run, served at /p/<id>/, redeploy by name keeps the link", async () => {
    const hub = mkHub();
    const pc = fakeComputer({ probe: vprobe, pack: tgzOf([["index.html", "<script src=/p/x/a.js>"], ["assets/a-1.js", "1"], ["assets/a-1.js.map", "{}"]]) });
    const d = { ...S.deps, runComputer: pc.runComputer, pub: P, now: () => 1_700_000_000_000 };
    const ctx = ctxOf(hub);
    const tool = feature.tools(ctx)[0];
    assert.equal(tool.name, "deploy_site"); assert.equal(tool.long, true); assert.equal(tool.work, true);
    const r = await S.runDeploy(ctx, { name: "blog", spa: false, source: { kind: "repo", repo: "NextThought-Website", dir: "." } }, d);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.url, /^https:\/\/bot\.example\/p\/[a-z0-9]{12}\/$/);
    assert.equal(r.commit, "abc1234 首页改版"); assert.equal(r.files, 2);
    assert.deepEqual(pc.calls[0].env, { GH_TOKEN: "ghs_secret_token" });
    assert.equal(pc.calls[1].env, undefined, "install and build run without any secret");
    assert.ok(pc.calls.every(c => !JSON.stringify(c.commands).includes("ghs_secret_token")));
    assert.match(pc.calls[1].commands.find(c => c.includes("build.log")), /npm run build -- --base=\/p\/[a-z0-9]{12}\//);
    assert.match(pc.calls.at(-1).commands[0], /^rm -rf '\/work\/deploy\//);
    const id = r.url.split("/")[4];
    assert.equal((await serve(hub, "/p/" + id + "/assets/a-1.js")).status, 200);
    // redeploy with just the name: same id, same source, ?v= on the link
    const pc2 = fakeComputer({ probe: vprobe, pack: tgzOf([["index.html", "v2"]]) });
    const r2 = await S.runDeploy(ctx, { name: "blog", spa: false, source: S.deployRow(hub, "t:r", "blog").source }, { ...d, runComputer: pc2.runComputer, now: () => 1_700_000_100_000 });
    assert.equal(r2.ok, true); assert.equal(r2.url.split("/")[4].slice(0, 12), id); assert.match(r2.url, /\?v=/); assert.equal(r2.replaced, true);
    assert.equal(await (await serve(hub, "/p/" + id + "/")).text(), "v2");
  });
  test("a pack over 25 MB comes back through the transfer path and is removed after", async () => {
    const hub = mkHub();
    const pc = fakeComputer({ probe: vprobe, pack: tgzOf([["index.html", "big"], ["a.js", "x".repeat(5000)]]), big: true });
    const r = await S.runDeploy(ctxOf(hub), { name: "big", spa: false, source: { kind: "repo", repo: "x", dir: "." } }, { ...S.deps, runComputer: pc.runComputer, pub: P });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM xfer").toArray()[0].n, 0);
    assert.ok(![...hub.files.keys()].some(k => k.startsWith("computer/")));
    assert.equal(hub.used.r2_reads, 2);
  });
  test("out of memory is said plainly; archives from chat and file box", async () => {
    let hub = mkHub();
    let r = await S.runDeploy(ctxOf(hub), { name: "x", spa: false, source: { kind: "repo", repo: "x", dir: "." } }, { ...S.deps, runComputer: fakeComputer({ probe: vprobe, fail: true }).runComputer, pub: P });
    assert.equal(r.ok, false); assert.match(r.error, /内存不够/);
    assert.equal(hub.sql.exec("SELECT COUNT(*) n FROM site").toArray()[0].n, 0);
    hub = mkHub();
    const pc = fakeComputer({ probe: { ...vprobe, pkg: null, files: ["index.html"] }, pack: tgzOf([["index.html", "<link href=/s.css>"], ["s.css", "a{}"]]) });
    r = await S.runDeploy(ctxOf(hub), { name: "up", spa: false, source: { kind: "archive", ref: "f3", file: "f3", dir: "." } }, { ...S.deps, runComputer: pc.runComputer, pub: P });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(pc.calls[0].files.length, 1); assert.deepEqual(pc.calls[0].env, {});
    assert.match(await (await serve(hub, r.url.replace("https://bot.example", ""))).text(), /href=\/p\/[a-z0-9]{12}\/s\.css/);
    const pc2 = fakeComputer({ probe: { ...vprobe, pkg: null }, pack: tgzOf([["index.html", "x"]]) });
    r = await S.runDeploy(ctxOf(hub), { name: "box", spa: false, source: { kind: "archive", ref: "x7", file: "x7", dir: "." } }, { ...S.deps, runComputer: pc2.runComputer, pub: P });
    assert.equal(r.ok, true); assert.match(pc2.calls[0].commands[1], /mv -f '\/work\/site'\\''s build\.zip'/);
    for (const c of pc2.calls[0].commands) bashOk(c);
  });
  test("tool: list, redeploy by name, delete, refusals", async () => {
    const hub = mkHub();
    const pc = fakeComputer({ probe: vprobe, pack: tgzOf([["index.html", "x"]]) });
    const old = S.deps.runComputer; S.deps.runComputer = pc.runComputer;
    try {
      const tool = feature.tools(ctxOf(hub))[0];
      assert.match((await tool.run({ op: "deploy", name: "a/b", repo: "x" })).error, /名字/);
      assert.match((await tool.run({ op: "deploy", name: "blog" })).error, /repo/);
      assert.match((await tool.run({ op: "deploy", repo: "x", dir: "../etc" })).error, /dir/);
      const r = await tool.run({ op: "deploy", repo: "OmnixSI/NextThought-Website", dir: "web", spa: true });
      assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.name, "nextthought-website");
      assert.match(r.warnings.join(), /单页应用/);
      assert.equal(hub.get("deploy:busy"), "0");
      const again = await tool.run({ op: "deploy", name: "nextthought-website" });
      assert.equal(again.ok, true); assert.match(again.source, /NextThought-Website 的 web/);
      const list = await tool.run({ op: "list" });
      assert.equal(list.sites.length, 1); assert.equal(list.sites[0].name, "nextthought-website"); assert.match(list.sites[0].url, /\/p\/[a-z0-9]{12}\/$/); assert.equal(list.sites[0].spa, true);
      hub.set("deploy:busy", String(Date.now()));
      assert.match((await tool.run({ op: "deploy", name: "nextthought-website" })).error, /还在打包/);
      hub.set("deploy:busy", "0");
      const q = feature.tools(ctxOf(hub, { quota: async () => false }))[0];
      assert.match((await q.run({ op: "deploy", name: "nextthought-website" })).error, /次数用完/);
      assert.deepEqual(await tool.run({ op: "delete", name: "nextthought-website" }), { ok: true, deleted: "nextthought-website" });
      assert.equal((await tool.run({ op: "list" })).sites.length, 0);
    } finally { S.deps.runComputer = old; }
  });
  test("schema and settings", () => {
    assert.equal(feature.tunables.deploy_daily.default, 4);
    assert.ok(feature.about.length >= 3);
    assert.match(feature.schema, /CREATE TABLE IF NOT EXISTS deploy\(/);
  });
});
