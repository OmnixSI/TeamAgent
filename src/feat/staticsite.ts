// Static site deploys: builds a team repository (or an archive someone uploaded) in the cloud computer and
// hosts the output at a stable /p/<id>/ link. Storage is publish.ts's own (table site, site_file, R2 under
// site/<id>…), so publish.ts serves these files exactly like its own pages. This file adds a name for each
// site, what it was built from (so "redeploy the blog" needs only the name), and versioned replacement.
//
// Flow: run 1 fetches the source (the GitHub token is in its env and nothing from the repository runs) and
// prints a probe; the Worker plans the build from the probe; run 2 installs, builds with the site's base
// path, packs the output as tar.gz and, when the pack is over 25 MB, sends it out through the transfer path;
// the Worker unpacks it (gzip through DecompressionStream, tar read here) and writes the files to R2.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import type { ComputerRequest, ComputerResult } from "../computer.ts";
import * as publish from "./publish.ts";
import { normPath, newId } from "./publish.ts";
import { issue, link, root, row, remove, partKey } from "./transfer.ts";
import { uploadCommand } from "./filebox.ts";
import { advice } from "./steward.ts";
import { BJ, clip, fmtFull } from "../util.ts";

export const LIMITS = {
  siteBytes: 60 * 1024 * 1024, siteFiles: 800, fileBytes: 25 * 1024 * 1024, sites: 12, totalBytes: 400 * 1024 * 1024,
  // a gzip bomb or a folder full of source maps stops here, long before the Worker runs out of memory
  rawBytes: 200 * 1024 * 1024, rawEntries: 6000, hold: 24 * 1024 * 1024, packBytes: 80 * 1024 * 1024,
  collect: 25 * 1024 * 1024, gcDelayMs: 15 * 60000, lockMs: 25 * 60000,
};
const HEAP = 640;              // MB for node during install and build, out of 1 GiB
const WORK = "/work/deploy";

const kb = (n: number) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
export const q = (s: string) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const baseUrl = (hub: Hub) => String(hub.env.PUBLIC_URL || "https://teamagent.inkboard-server.workers.dev").replace(/\/+$/, "");
const bucket = (hub: Hub) => hub.env.FILES as any;

// ---------- names and inputs ----------

// The same rules as preview.ts (which cannot be imported here: it pulls in the browser and the container runtime).
export const validRef = (ref: string) => /^[\w./-]{1,200}$/.test(ref) && !ref.includes("..") && !ref.startsWith("-") && !ref.endsWith(".lock");
export const refspecOf = (ref: string) => /^[0-9a-f]{40}$/.test(ref) || ref.startsWith("refs/") ? ref : "refs/heads/" + ref;

/** A site name people say in chat ("blog", "官网"): letters, digits, CJK, - and _. */
export function siteName(raw: unknown): string | null {
  const s = String(raw ?? "").trim().toLowerCase().replace(/\s+/g, "-");
  return /^[\p{L}\p{N}_-]{1,40}$/u.test(s) ? s : null;
}
/** A folder inside the project (sub-project or output folder): relative, no dot segments. */
export function subDir(raw: unknown): string | null {
  const s = String(raw ?? "").trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (!s || s === ".") return ".";
  if (s.length > 120 || !/^[\w.@+-]+(\/[\w.@+-]+)*$/.test(s)) return null;
  return s.split("/").some(p => p === ".." || p === ".") ? null : s;
}
export const repoName = (raw: unknown) => {
  const s = String(raw ?? "").trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
  return /^([\w.-]+\/)?[\w.-]+$/.test(s) && !s.split("/").some(p => p === "." || p === "..") ? s : null;
};

export type Source =
  | { kind: "repo"; repo: string; branch?: string; pr?: number; dir: string; out_dir?: string; build?: boolean }
  | { kind: "archive"; ref: string; file: string; dir: string; out_dir?: string; build?: boolean };

export function describeSource(s: Source) {
  const tail = (s.dir !== "." ? " 的 " + s.dir : "") + (s.out_dir ? "（发布 " + s.out_dir + "）" : "");
  return s.kind === "repo" ? "仓库 " + s.repo + (s.pr ? " PR #" + s.pr : s.branch ? " 分支 " + s.branch : "") + tail : "压缩包 " + s.ref + "（" + s.file + "）" + tail;
}

// ---------- what the machine reports about the project ----------

const KNOWN = ["vite", "astro", "vitepress", "react-scripts", "@vue/cli-service", "@docusaurus/core", "next", "nuxt", "@sveltejs/kit", "gatsby", "@angular/cli", "@11ty/eleventy"];
export type Pkg = { scripts: Record<string, string>; deps: string[]; pm: string; type: string; workspaces: boolean; count: number };
export type Probe = { exists: boolean; files: string[]; rootFiles: string[]; pkg: Pkg | null; rootPkg: Pkg | null; index: string[]; commit?: string };

/** Node program run in the machine: prints one line `PROBE {json}` about the project at <root>/<dir>. */
export const PROBE_JS = String.raw`const fs=require("fs"),p=require("path"),[root,dir]=process.argv.slice(1),app=p.join(root,dir),K=${JSON.stringify(KNOWN)};
const ls=d=>{try{return fs.readdirSync(d).slice(0,300)}catch{return[]}},rd=f=>{try{return JSON.parse(fs.readFileSync(f,"utf8"))}catch{return null}};
const slim=j=>{if(!j||typeof j!=="object")return null;const all=Object.keys(Object.assign({},j.dependencies,j.devDependencies)),s={};
for(const[k,v]of Object.entries(j.scripts&&typeof j.scripts==="object"?j.scripts:{}).slice(0,40))s[k]=String(v).slice(0,300);
return{scripts:s,deps:all.filter(d=>K.includes(d)),count:all.length,pm:typeof j.packageManager==="string"?j.packageManager.slice(0,40):"",type:String(j.type||""),workspaces:!!j.workspaces}};
const idx=[".","public","dist","build","out","_site","site","docs","www","html"].filter(d=>fs.existsSync(p.join(app,d,"index.html")));
console.log("PROBE "+JSON.stringify({exists:fs.existsSync(app),files:ls(app),rootFiles:dir==="."?ls(app):ls(root),pkg:slim(rd(p.join(app,"package.json"))),rootPkg:dir==="."?null:slim(rd(p.join(root,"package.json"))),index:idx}));`;

export function parseProbe(stdout: string): Probe | null {
  const line = stdout.split("\n").find(l => l.startsWith("PROBE "));
  if (!line) return null;
  try {
    const j = JSON.parse(line.slice(6));
    const arr = (x: any) => Array.isArray(x) ? x.map(String) : [];
    const pkg = (x: any): Pkg | null => x && typeof x === "object" ? { scripts: x.scripts && typeof x.scripts === "object" ? x.scripts : {}, deps: arr(x.deps), pm: String(x.pm || ""), type: String(x.type || ""), workspaces: !!x.workspaces, count: Number(x.count) || 0 } : null;
    return { exists: !!j.exists, files: arr(j.files), rootFiles: arr(j.rootFiles), pkg: pkg(j.pkg), rootPkg: pkg(j.rootPkg), index: arr(j.index) };
  } catch { return null; }
}

// ---------- the build plan ----------

export type Plan = {
  kind: "static" | "build"; framework: string; how: string;
  install?: string; installAt?: "root" | "app";
  build?: string; env: Record<string, string>; prep: string[];
  outs: string[]; rewrite: boolean; warn: string[]; error?: string; estimate: number;
};

const segments = (script: string) => script.split(/&&|\|\||;/).map(s => s.trim()).filter(Boolean);
/** The pm call that runs a package.json script with extra arguments passed to its last command. */
export function runScript(pm: string, name: string, extra = "") {
  if (!extra) return pm + " run " + name;
  return pm === "npm" ? "npm run " + name + " -- " + extra : pm + " run " + name + " " + extra;
}

/** Install command for a package manager, from lockfiles and the packageManager field. */
export function installCommand(files: string[], pm: string): { pm: "npm" | "pnpm" | "yarn"; cmd: string; warn?: string } {
  const has = (f: string) => files.includes(f);
  const want = /^(pnpm|yarn|npm)@(\d+)/.exec(pm);
  if (has("pnpm-lock.yaml") || want?.[1] === "pnpm") {
    const v = want?.[1] === "pnpm" ? want[2] : "10";
    return { pm: "pnpm", cmd: "(command -v pnpm >/dev/null || npm i -g -s pnpm@" + v + " >/dev/null 2>&1) && pnpm install " + (has("pnpm-lock.yaml") ? "--frozen-lockfile " : "") + "--reporter=silent" };
  }
  if (has("yarn.lock") || want?.[1] === "yarn") {
    const berry = want?.[1] === "yarn" && Number(want[2]) >= 2;
    return { pm: "yarn", cmd: berry ? "corepack enable >/dev/null 2>&1; COREPACK_ENABLE_DOWNLOAD_PROMPT=0 yarn install" + (has("yarn.lock") ? " --immutable" : "") : "yarn install " + (has("yarn.lock") ? "--frozen-lockfile " : "") + "--silent --non-interactive" };
  }
  const bun = has("bun.lockb") || has("bun.lock");
  return { pm: "npm", cmd: has("package-lock.json") ? "npm ci --no-audit --no-fund --loglevel=error" : "npm install --no-audit --no-fund --loglevel=error", ...(bun ? { warn: "项目用的是 bun，云电脑里没有，改用 npm 安装，版本可能和锁文件不完全一样" } : {}) };
}

const STATIC_OUTS = [".", "public", "dist", "build", "out", "_site", "site", "docs", "www", "html"];
const BUILD_OUTS = ["dist", "build", "out", "_site", "public", "dist/browser", ".output/public", ".vitepress/dist", "docs/.vitepress/dist", "storybook-static"];
const uniq = (a: string[]) => [...new Set(a)];

/**
 * Decides how to build and where the output is. `base` is the site's path ("/p/<id>/"): frameworks that
 * can take it get it (so absolute asset URLs work); for the rest root-absolute links in HTML and CSS are
 * rewritten after the build.
 */
export function planBuild(p: Probe, o: { base: string; dir: string; outDir?: string; build?: boolean }): Plan {
  const plan: Plan = { kind: "static", framework: "静态网页", how: "", env: {}, prep: [], outs: [], rewrite: true, warn: [], estimate: 60 };
  if (!p.exists) return { ...plan, error: "项目里找不到 " + o.dir + " 这个文件夹" };
  const pkg = p.pkg, scripts = pkg?.scripts || {};
  const wantsBuild = o.build !== false && !!pkg && (!!scripts.build || (!!scripts.generate && pkg.deps.includes("nuxt")));
  if (!wantsBuild) {
    plan.outs = o.outDir ? [o.outDir] : uniq([...p.index, ...STATIC_OUTS]);
    plan.how = "不用打包，直接发" + (o.outDir ? " " + o.outDir : p.index[0] && p.index[0] !== "." ? " " + p.index[0] + " 文件夹" : "项目里的网页");
    if (o.build !== false && pkg && !p.index.length) return { ...plan, error: "package.json 里没有 build 脚本，项目里也找不到 index.html，不知道要发布什么" };
    if (!p.index.length && !o.outDir) return { ...plan, error: "找不到 index.html：既没有能打包的 package.json，也没有现成的网页。打好的网页要把 index.html 放在最外层或 dist、build、public 这类文件夹里" };
    return plan;
  }
  const lockFiles = p.files.some(f => /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f)) ? p.files : p.rootFiles;
  const atRoot = o.dir !== "." && lockFiles === p.rootFiles && (p.rootPkg?.workspaces || p.rootFiles.some(f => /lock/.test(f)));
  const inst = installCommand(lockFiles, pkg!.pm || p.rootPkg?.pm || "");
  if (inst.warn) plan.warn.push(inst.warn);
  plan.kind = "build";
  if (pkg!.count > 0 || pkg!.workspaces || atRoot) { plan.install = inst.cmd; plan.installAt = atRoot ? "root" : "app"; }
  const base = o.base, bare = base.replace(/\/$/, ""), deps = pkg!.deps;
  let name = "build", extra = "", outs: string[] = [];
  const script = scripts.build || "", last = segments(script).pop() || "";
  const lastIs = (re: RegExp) => re.test(last), anyIs = (re: RegExp) => segments(script).some(s => re.test(s));
  plan.framework = "package.json 的 build 脚本";
  if (deps.includes("nuxt") && (scripts.generate || /\bnuxi?\s+generate\b/.test(script))) {
    name = scripts.generate ? "generate" : "build"; plan.env.NUXT_APP_BASE_URL = base; plan.framework = "Nuxt"; outs = [".output/public", "dist"]; plan.rewrite = false;
  } else if (lastIs(/\bnext\s+build\b/)) {
    plan.framework = "Next.js"; outs = ["out"]; plan.rewrite = false;
    const cfg = p.files.find(f => /^next\.config\.(js|mjs|cjs|ts|mts)$/.test(f));
    if (cfg && /ts$/.test(cfg)) return { ...plan, error: "这是 Next.js 项目，配置文件是 TypeScript 写的（" + cfg + "），没法安全地加上静态导出和路径前缀。在 next.config 里加 output: 'export' 和 basePath 后，用 out_dir 指 out 再试，或者先自己打包好上传 out 文件夹" };
    plan.prep.push(nextWrapper(cfg || "", pkg!.type === "module", bare));
    plan.warn.push("Next.js 只能发静态导出：用了服务端功能（API 路由、服务端渲染、middleware）的页面会打包失败或打不开");
  } else if (lastIs(/\bvitepress\s+build\b/)) { plan.framework = "VitePress"; extra = "--base " + base; outs = ["docs/.vitepress/dist", ".vitepress/dist"]; plan.rewrite = false; }
  else if (lastIs(/\bastro\s+build\b/)) { plan.framework = "Astro"; extra = "--base " + base; outs = ["dist"]; plan.rewrite = false; }
  else if (deps.includes("@sveltejs/kit")) { plan.framework = "SvelteKit"; outs = ["build"]; plan.warn.push("SvelteKit 的路径前缀要在 svelte.config.js 的 paths.base 里设，这里没改它，只把网页里以 / 开头的链接改到了网站的地址下，脚本里拼出来的地址可能不对；还要用 adapter-static 才有静态文件"); }
  else if (lastIs(/\bvite\s+build\b/) || /^vite$/.test(last)) { plan.framework = "Vite"; extra = "--base=" + base; outs = ["dist"]; plan.rewrite = false; }
  else if (lastIs(/\breact-scripts\s+build\b/) || lastIs(/\bcraco\s+build\b/)) { plan.framework = "Create React App"; plan.env.PUBLIC_URL = bare; outs = ["build"]; plan.rewrite = false; }
  else if (lastIs(/\bvue-cli-service\s+build\b/)) {
    plan.framework = "Vue CLI"; outs = ["dist"]; plan.rewrite = false;
    if (p.files.includes("vue.config.mjs")) { plan.rewrite = true; plan.warn.push("vue.config.mjs 没法套上路径前缀，只把网页里以 / 开头的链接改到了网站的地址下"); }
    else { plan.env.VUE_CLI_SERVICE_CONFIG_PATH = "$PWD/.deploy.vue.config.cjs"; plan.prep.push(vueWrapper(base)); }
  } else if (lastIs(/\bdocusaurus\s+build\b/)) {
    plan.framework = "Docusaurus"; outs = ["build"]; plan.rewrite = false;
    const cfg = p.files.find(f => /^docusaurus\.config\.(js|mjs|cjs|ts)$/.test(f));
    if (!cfg) return { ...plan, error: "这是 Docusaurus 项目，但找不到 docusaurus.config 文件" };
    plan.prep.push(docusaurusEdit(cfg, base));
  } else if (lastIs(/\bng\s+build\b/)) { plan.framework = "Angular"; extra = "--base-href " + base; outs = ["dist"]; plan.rewrite = false; }
  else if (anyIs(/\b(vite|astro|next|vitepress)\s+build\b/)) plan.warn.push("build 脚本里打包那一步不在最后，没法把网站的路径前缀传进去，只把网页里以 / 开头的链接改到了网站的地址下，脚本里拼出来的地址可能不对");
  plan.build = runScript(inst.pm, name, extra);
  plan.outs = o.outDir ? [o.outDir] : uniq([...outs, ...BUILD_OUTS]);
  plan.how = (plan.install ? inst.pm + " 安装依赖 → " : "") + plan.build + "（" + plan.framework + "）";
  plan.estimate = (plan.install ? 180 : 20) + 180 + 40;
  return plan;
}

function nextWrapper(cfg: string, esm: boolean, basePath: string) {
  // The original config stays as it is under a new name; the wrapper adds static export and the base path.
  const ext = cfg.endsWith(".mjs") ? "mjs" : cfg.endsWith(".cjs") ? "cjs" : esm ? "mjs" : "cjs";
  const orig = cfg ? "next.config.orig." + ext : "";
  const js = (orig ? "import c from \"./" + orig + "\";\n" : "const c = {};\n") +
    "export default async (...a) => { const o = (typeof c === \"function\" ? await c(...a) : await c) || {};\n" +
    "  return { ...o, output: \"export\", basePath: " + JSON.stringify(basePath) + ", trailingSlash: true, images: { ...(o.images || {}), unoptimized: true } }; };\n";
  return (cfg ? "mv -f " + q(cfg) + " " + q(orig) + " && " : "") + "printf '%s' " + q(js) + " > next.config.mjs";
}
function vueWrapper(base: string) {
  const js = "let o = {}; try { o = require(require(\"path\").join(__dirname, \"vue.config.js\")); } catch (e) { if (e.code !== \"MODULE_NOT_FOUND\") throw e; }\n" +
    "if (typeof o === \"function\") o = o(); module.exports = { ...o, publicPath: " + JSON.stringify(base) + " };\n";
  return "printf '%s' " + q(js) + " > .deploy.vue.config.cjs";
}
function docusaurusEdit(cfg: string, base: string) {
  const js = "const fs=require(\"fs\"),f=process.argv[1],t=fs.readFileSync(f,\"utf8\"),re=/baseUrl\\s*:\\s*([\"'`])[^\"'`]*\\1/g,n=(t.match(re)||[]).length;" +
    "if(n!==1){console.error(\"docusaurus 配置里 baseUrl 出现了 \"+n+\" 次，没法安全地改\");process.exit(3)}fs.writeFileSync(f,t.replace(re,\"baseUrl: \"+JSON.stringify(process.argv[2])))";
  return "node -e " + q(js) + " " + q(cfg) + " " + q(base);
}

// ---------- shell commands ----------

/** Fetches a repository into <w>/src. The token travels only as a one-off header, as in preview.ts. */
export function cloneCommands(w: string, repo: string, refspec: string) {
  return [
    "rm -rf " + q(w) + " && mkdir -p " + q(w + "/src") + " && cd " + q(w + "/src") + " && git init -q && " +
    "H=(); [ -n \"$GH_TOKEN\" ] && H=(-c \"http.extraHeader=Authorization: Basic $(printf 'x-access-token:%s' \"$GH_TOKEN\" | base64 -w0)\"); " +
    "git \"${H[@]}\" fetch -q --depth 1 " + q("https://github.com/" + repo + ".git") + " " + q(refspec) + " && git checkout -q FETCH_HEAD && git log -1 --format='COMMIT %h %s'",
  ];
}
// Python's extractors refuse absolute paths and "..", and tarfile's "data" filter refuses links that leave the folder.
const UNPACK_PY = String.raw`import sys,tarfile,zipfile
src,dst=sys.argv[1:3]
if zipfile.is_zipfile(src): zipfile.ZipFile(src).extractall(dst)
else:
  with tarfile.open(src) as t: t.extractall(dst,filter="data")`;
/** Unpacks an uploaded archive (already at `input`) into <w>/src, dropping links and Mac junk, and steps into a single top folder. */
export function archiveCommands(w: string, input: string) {
  return [
    "rm -rf " + q(w + "/src") + " && mkdir -p " + q(w + "/src") + " && cd " + q(w) + " && " +
    "{ /opt/py/bin/python -I -c " + q(UNPACK_PY) + " " + q(input) + " src 2>err.txt || { echo \"压缩包解不开（只认 zip、tar.gz、tar）：$(tail -c 300 err.txt)\" >&2; exit 4; }; } && rm -f " + q(input) + " && " +
    "find src -type l -delete && rm -rf src/__MACOSX && find src -name .DS_Store -delete && " +
    "shopt -s nullglob dotglob && set -- src/* && if [ $# -eq 1 ] && [ -d \"$1\" ]; then mv -- \"$1\" top.tmp && rmdir src && mv top.tmp src; fi && echo 'COMMIT 上传的压缩包'",
  ];
}
export const probeCommand = (w: string, dir: string) => "unset GH_TOKEN; cd " + q(w + "/src") + " && node -e " + q(PROBE_JS) + " " + q(w + "/src") + " " + q(dir);

const OOM = "内存不够被系统杀掉了（云电脑只有 1 GB 内存），这个项目太大，没法在这里打包；可以在自己电脑上打包好，把输出文件夹压缩成 zip 上传再发布";
/** Install, build and pack. Each command starts without the token and with a bounded Node heap. */
export function buildCommands(w: string, dir: string, plan: Plan, pack: string, max = { files: LIMITS.siteFiles, bytes: LIMITS.siteBytes }) {
  const app = w + "/src" + (dir === "." ? "" : "/" + dir);
  const env = Object.entries(plan.env).map(([k, v]) => k + "=" + (v.startsWith("$PWD/") ? "\"$PWD\"" + q(v.slice(4)) : q(v))).join(" ");
  const at = (where: string, cmd: string) => "unset GH_TOKEN; set -o pipefail; export NODE_OPTIONS=--max-old-space-size=" + HEAP + " NPM_CONFIG_UPDATE_NOTIFIER=false && cd " + q(where) + " && " + cmd;
  // 137 = SIGKILL from the kernel's out-of-memory killer; Node's own heap limit prints "heap out of memory".
  const watch = (cmd: string, what: string) => "{ " + cmd + " ; } > " + q(w + "/" + what + ".log") + " 2>&1; c=$?; tail -c 3000 " + q(w + "/" + what + ".log") +
    "; if [ $c -ne 0 ] && { [ $c -eq 137 ] || grep -qE 'heap out of memory|Killed|ENOMEM' " + q(w + "/" + what + ".log") + "; }; then echo " + q(OOM) + " >&2; exit 137; fi; exit $c";
  const cmds: string[] = [];
  if (plan.install) cmds.push(at(plan.installAt === "root" ? w + "/src" : app, watch(plan.install, "install")));
  for (const p of plan.prep) cmds.push(at(app, p));
  if (plan.build) cmds.push(at(app, watch((env ? "export " + env + " && " : "") + plan.build, "build")));
  const outs = plan.outs.map(q).join(" ");
  cmds.push(at(app, [
    "OUT=''; for d in " + outs + "; do [ -f \"$d/index.html\" ] && { OUT=$d; break; }; done",
    // Angular and friends put the site one or two levels down (dist/<project>/browser).
    "[ -n \"$OUT\" ] || OUT=$(find dist build out -maxdepth 3 -name index.html -printf '%d %h\\n' 2>/dev/null | sort -n | head -1 | cut -d' ' -f2-)",
    "[ -n \"$OUT\" ] || { echo " + q("打包好了，但找不到输出的网页（试过 " + plan.outs.slice(0, 8).join("、") + "，都没有 index.html）。可以用 out_dir 告诉我输出在哪个文件夹") + " >&2; exit 3; }",
    "cd \"$OUT\" && L=" + q(w + "/list") + " && find . -type f ! -name '*.map' ! -path '*/.*' ! -path './node_modules/*' -printf '%P\\0' > \"$L\"",
    "n=$(tr -cd '\\0' < \"$L\" | wc -c); b=$(find . -type f ! -name '*.map' ! -path '*/.*' ! -path './node_modules/*' -printf '%s\\n' | awk '{s+=$1} END {print s+0}')",
    "[ \"$n\" -le " + max.files + " ] || { echo \"输出有 $n 个文件，一个网站最多 " + max.files + " 个\" >&2; exit 5; }",
    "[ \"$b\" -le " + max.bytes + " ] || { echo \"输出有 $((b / 1048576)) MB，一个网站最多 " + Math.round(max.bytes / 1048576) + " MB\" >&2; exit 5; }",
    "tar --format=gnu --owner=0 --group=0 --null --no-recursion -czf " + q(pack) + " -T \"$L\"",
    "printf 'DEPLOY {\"out\":\"%s\",\"files\":%s,\"bytes\":%s,\"pack\":%s}\\n' \"$(printf '%s' \"$OUT\" | tr -d '\"\\\\')\" \"$n\" \"$b\" \"$(stat -c %s " + q(pack) + ")\"",
  ].join("\n")));
  return cmds;
}
export function parseDeploy(stdout: string): { out: string; files: number; bytes: number; pack: number } | null {
  const line = stdout.split("\n").reverse().find(l => l.startsWith("DEPLOY "));
  if (!line) return null;
  try { const j = JSON.parse(line.slice(7)); return { out: String(j.out), files: Number(j.files), bytes: Number(j.bytes), pack: Number(j.pack) }; } catch { return null; }
}

// ---------- tar ----------

export type TarEntry = { path: string; type: "file" | "dir" | "link" | "other"; size: number; data?: Uint8Array };

/** Pulls exact byte counts out of a stream without copying the whole buffer each time. */
function byteReader(stream: ReadableStream<Uint8Array>) {
  const r = stream.getReader(), chunks: Uint8Array[] = [];
  let have = 0, ended = false, total = 0;
  const fill = async (n: number) => {
    while (have < n && !ended) {
      const x = await r.read();
      if (x.done) ended = true;
      else if (x.value?.length) { chunks.push(x.value); have += x.value.length; total += x.value.length; }
    }
    return have >= n;
  };
  const take = (n: number) => {
    const out = new Uint8Array(n);
    let at = 0;
    while (at < n) {
      const c = chunks[0], k = Math.min(c.length, n - at);
      out.set(c.subarray(0, k), at); at += k;
      if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k);
    }
    have -= n;
    return out;
  };
  return {
    async read(n: number) { return (await fill(n)) ? take(n) : null; },
    async skip(n: number) {
      while (n > 0) { const k = Math.min(n, 1 << 20); if (!(await fill(k))) return false; take(k); n -= k; }
      return true;
    },
    get total() { return total; },
    get left() { return have; },
    cancel: () => r.cancel().catch(() => {}),
  };
}

const td = new TextDecoder();
const cstr = (b: Uint8Array) => { const i = b.indexOf(0); return td.decode(i < 0 ? b : b.subarray(0, i)); };
function octal(b: Uint8Array): number {
  if (b[0] & 0x80) { let n = 0; for (let i = 1; i < b.length; i++) n = n * 256 + b[i]; return n; }   // base-256 for huge sizes
  const s = cstr(b).trim();
  return s ? parseInt(s, 8) : 0;
}
function checksumOk(h: Uint8Array) {
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return sum === octal(h.subarray(148, 156));
}
function paxPath(data: Uint8Array) {
  let at = 0, path: string | undefined;
  while (at < data.length) {
    const sp = data.indexOf(32, at);
    if (sp < 0) break;
    const len = Number(td.decode(data.subarray(at, sp)));
    if (!(len > 0)) break;
    const rec = td.decode(data.subarray(sp + 1, at + len - 1)), eq = rec.indexOf("=");
    if (rec.slice(0, eq) === "path") path = rec.slice(eq + 1);
    at += len;
  }
  return path;
}

/**
 * Reads a tar stream entry by entry (ustar, GNU long names, pax paths). File contents come with the entry
 * only when `want(path, size)` says so; links, devices and the rest are reported without data.
 */
export async function* untar(stream: ReadableStream<Uint8Array>, o: { want?: (path: string, size: number) => boolean; maxRaw?: number; maxEntries?: number } = {}): AsyncGenerator<TarEntry> {
  const br = byteReader(stream), maxRaw = o.maxRaw ?? LIMITS.rawBytes, maxEntries = o.maxEntries ?? LIMITS.rawEntries;
  let longName: string | undefined, entries = 0;
  try {
    for (;;) {
      const h = await br.read(512);
      if (!h) { if (br.left) throw new Error("tar 包不完整"); return; }   // a clean end right after an entry is fine
      if (h.every(b => b === 0)) return;               // end-of-archive marker
      if (!checksumOk(h)) throw new Error("不是有效的 tar 包（文件头校验不对）");
      const flag = String.fromCharCode(h[156] || 48), size = octal(h.subarray(124, 136)), pad = (512 - (size % 512)) % 512;
      if (br.total > maxRaw || size > maxRaw) throw new Error("压缩包解开后太大了（超过 " + kb(maxRaw) + "）");
      if (flag === "L" || flag === "x") {
        const d = await br.read(size);
        if (!d || !(await br.skip(pad))) throw new Error("tar 包不完整");
        if (flag === "L") longName = cstr(d); else longName = paxPath(d) ?? longName;
        continue;
      }
      if (flag === "g" || flag === "K") { if (!(await br.skip(size + pad))) throw new Error("tar 包不完整"); continue; }
      if (++entries > maxEntries) throw new Error("压缩包里文件太多（超过 " + maxEntries + " 个）");
      const prefix = h[257] === 0x75 && cstr(h.subarray(257, 263)) === "ustar" ? cstr(h.subarray(345, 500)) : "";
      const path = longName ?? (prefix ? prefix + "/" : "") + cstr(h.subarray(0, 100));
      longName = undefined;
      const type = flag === "0" || flag === "7" ? "file" : flag === "5" ? "dir" : flag === "1" || flag === "2" ? "link" : "other";
      // A link's size field is 0, but a hard link from some writers carries one: skip whatever it says.
      if (type === "file" && (!o.want || o.want(path, size))) {
        const data = await br.read(size);
        if (!data || !(await br.skip(pad))) throw new Error("tar 包不完整");
        yield { path, type, size, data };
      } else {
        if (!(await br.skip(size + pad))) throw new Error("tar 包不完整");
        yield { path, type, size };
      }
    }
  } finally { br.cancel(); }
}

/** A path from an archive made safe, or null: no absolute paths, no "..", "./" and doubled slashes dropped. */
export function cleanEntryPath(raw: string): string | null {
  const p = raw.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[a-z]:/i.test(p)) return null;
  const segs = p.split("/").filter(s => s && s !== ".");
  if (!segs.length || segs.includes("..")) return null;
  return segs.join("/");
}

// ---------- links that start at the server root ----------

/** Puts the site's path in front of root-absolute URLs in HTML attributes and CSS url()/@import ("/a.css" → "/p/<id>/a.css"). */
export function rewriteRoot(text: string, base: string, kind: "html" | "css") {
  const b = base.replace(/\/$/, "");
  const fix = (u: string) => u.startsWith("//") || u === b || u.startsWith(b + "/") ? u : b + u;
  const css = (t: string) => t
    .replace(/url\(\s*(["']?)(\/[^"')\s]*)\1\s*\)/g, (_m, qt, u) => "url(" + qt + fix(u) + qt + ")")
    .replace(/@import\s+(["'])(\/[^"']*)\1/g, (_m, qt, u) => "@import " + qt + fix(u) + qt);
  if (kind === "css") return css(text);
  const out = text
    .replace(/(\s(?:href|src|action|poster|data-src|formaction|xlink:href)\s*=\s*)(["'])(\/[^"']*)\2/gi, (_m, pre, qt, u) => pre + qt + fix(u) + qt)
    .replace(/(\s(?:href|src|action)\s*=\s*)(\/[^\s"'>]*)/gi, (_m, pre, u) => pre + fix(u))
    .replace(/(\s(?:srcset|data-srcset)\s*=\s*)(["'])([^"']*)\2/gi, (_m, pre, qt, v) => pre + qt + v.split(",").map((c: string) => c.replace(/^(\s*)(\/\S*)/, (_x, sp, u) => sp + fix(u))).join(",") + qt);
  return css(out);
}

// ---------- storage: publish.ts's tables and keys ----------

type Pub = { objectKey?: (hub: { get(k: string): string | null }, id: string, path: string) => string; verKey?: (id: string) => string; spaKey?: (id: string) => string };
/** What publish.ts offers. Versioned keys need `objectKey` and `verKey`; serving index.html for unknown paths needs `spaKey`. */
export function support(pub: Pub = publish as any) {
  let versioned = false;
  if (typeof pub.objectKey === "function" && typeof pub.verKey === "function") {
    const kv = new Map([[pub.verKey("aaaaaaaaaaaa"), "v1"]]);
    try { versioned = pub.objectKey({ get: k => kv.get(k) ?? null }, "aaaaaaaaaaaa", "a/b.js") === "site/aaaaaaaaaaaa@v1/a/b.js"; } catch { versioned = false; }
  }
  return { versioned, spa: typeof pub.spaKey === "function", pub };
}
export const plainKey = (id: string, path: string) => "site/" + id + "/" + path;
export const verKeyOf = (id: string, ver: string, path: string) => ver ? "site/" + id + "@" + ver + "/" + path : plainKey(id, path);

export type Deps = {
  runComputer(hub: Hub, req: ComputerRequest): Promise<ComputerResult>;
  pub: Pub;
  now(): number;
};
export const deps: Deps = {
  // Imported on use: computer.ts needs the Workers runtime.
  runComputer: async (hub, req) => (await import("../computer.ts")).runComputer(hub, req),
  pub: publish as any,
  now: () => Date.now(),
};

type DeployRow = { conv: string; name: string; id: string; source: Source; ver: string; spa: boolean; files: number; bytes: number; at: number; by: string; note: string };
const toRow = (r: any): DeployRow => ({ conv: String(r.conv), name: String(r.name), id: String(r.id), source: JSON.parse(String(r.source)), ver: String(r.ver || ""), spa: !!r.spa, files: Number(r.files), bytes: Number(r.bytes), at: Number(r.at), by: String(r.by || ""), note: String(r.note || "") });
export const deployRow = (hub: Hub, conv: string, name: string) => { const r = hub.sql.exec('SELECT conv,name,id,source,ver,spa,files,bytes,at,"by" AS "by",note FROM deploy WHERE conv=? AND name=?', conv, name).toArray()[0]; return r ? toRow(r) : null; };
const siteExists = (hub: Hub, id: string) => hub.sql.exec("SELECT id FROM site WHERE id=?", id).toArray().length > 0;
const curVer = (hub: Hub, s: ReturnType<typeof support>, id: string) => s.versioned ? hub.get(s.pub.verKey!(id)) || "" : "";

/** Every R2 key a site's live files sit at. */
function liveKeys(hub: Hub, s: ReturnType<typeof support>, id: string) {
  const ver = curVer(hub, s, id);
  return hub.sql.exec("SELECT path FROM site_file WHERE id=?", id).toArray().map((r: any) => verKeyOf(id, ver, String(r.path)));
}
function scheduleGc(hub: Hub, keys: string[], at: number) {
  for (const k of keys) hub.sql.exec("INSERT INTO deploy_gc(k, after) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET after=excluded.after", k, at);
}
/** True when a key is what a site serves right now (a path deployed again in place, or the current version). */
export function isLive(hub: Hub, s: ReturnType<typeof support>, key: string) {
  const m = /^site\/([a-z0-9]{12})(?:@([a-z0-9]+))?\/(.+)$/.exec(key);
  if (!m) return false;
  const [, id, ver = "", path] = m;
  if (!siteExists(hub, id) || curVer(hub, s, id) !== ver) return false;
  return hub.sql.exec("SELECT 1 FROM site_file WHERE id=? AND path=?", id, path).toArray().length > 0;
}
/** Deletes old versions' files once nobody can still be loading them (pages are cached for 5 minutes). */
export async function collectGarbage(hub: Hub, now: number, s = support(deps.pub)) {
  const due = hub.sql.exec("SELECT k FROM deploy_gc WHERE after<=? ORDER BY after LIMIT 500", now).toArray().map((r: any) => String(r.k));
  if (!due.length || !bucket(hub)) return 0;
  const dead = due.filter(k => !isLive(hub, s, k));
  if (dead.length) await bucket(hub).delete(dead);
  for (const k of due) hub.sql.exec("DELETE FROM deploy_gc WHERE k=?", k);
  return dead.length;
}

export type Stored = { ok: true; files: number; bytes: number; skipped: string[]; skippedCount: number } | { ok: false; error: string };

/**
 * Writes a deploy's files and switches the site to them. With versioned keys every file goes under a new
 * version prefix and the switch is one synchronous block of SQL (the Durable Object runs nothing else in
 * between). Without them, files at new paths go first, files replacing old ones are held back and written
 * last, pages after everything else, so a visitor mostly sees either the old or the new site.
 */
export async function storeSite(hub: Hub, o: {
  id: string; conv: string; name: string; ver: string; base: string; rewrite: boolean; spa: boolean; source: Source; by: string; note: string;
  entries: AsyncIterable<TarEntry>; s?: ReturnType<typeof support>; now?: number;
}): Promise<Stored> {
  const s = o.s || support(deps.pub), b = bucket(hub);
  if (!b) return { ok: false, error: "存储没接好，现在发布不了" };
  const exists = siteExists(hub, o.id), oldVer = exists ? curVer(hub, s, o.id) : "";
  const old = new Map<string, number>(exists ? hub.sql.exec("SELECT path,size FROM site_file WHERE id=?", o.id).toArray().map((r: any) => [String(r.path), Number(r.size)] as [string, number]) : []);
  const ver = s.versioned ? o.ver : "", keyOf = (p: string) => verKeyOf(o.id, ver, p);
  const files = new Map<string, number>(), written: string[] = [], skipped: string[] = [];
  const held: [string, Uint8Array][] = [];
  let bytes = 0, heldBytes = 0, skippedCount = 0;
  const skip = (why: string) => { skippedCount++; if (skipped.length < 12) skipped.push(why); };
  const put = async (path: string, data: Uint8Array) => {
    if (!hub.plan.take("r2_writes", 1)) throw new Error("这个月 R2 写入的额度用完了，下个周期再发布");
    await b.put(keyOf(path), data, { httpMetadata: { contentType: publish.contentType(path) || "application/octet-stream" } });
    written.push(path);
  };
  const undo = async () => {
    // Only files that are not live yet: new paths, or anything under the new version prefix.
    const gone = written.filter(p => s.versioned || !old.has(p));
    if (gone.length) await b.delete(gone.map(keyOf)).catch(() => {});
  };
  try {
    for await (const e of o.entries) {
      if (e.type === "dir") continue;
      const clean = cleanEntryPath(e.path);
      if (e.type !== "file") { skip(e.path + "（" + (e.type === "link" ? "链接" : "特殊文件") + "，跳过）"); continue; }
      if (!clean) { skip(e.path + "（路径不安全，跳过）"); continue; }
      const path = normPath(clean);
      if (!path || path !== clean) { skip(clean + "（文件类型或路径不支持，跳过）"); continue; }
      if (files.has(path)) continue;
      if (e.size > LIMITS.fileBytes) return await undo(), { ok: false, error: path + " 有 " + kb(e.size) + "，单个文件最多 " + kb(LIMITS.fileBytes) };
      if (!e.data) { skip(path + "（没有读到内容，跳过）"); continue; }
      if (files.size + 1 > LIMITS.siteFiles) return await undo(), { ok: false, error: "一个网站最多 " + LIMITS.siteFiles + " 个文件" };
      let data = e.data;
      if (o.rewrite && /\.(html?|css)$/i.test(path)) {
        const t = td.decode(data), r = rewriteRoot(t, o.base, /\.css$/i.test(path) ? "css" : "html");
        if (r !== t) data = new TextEncoder().encode(r);
      }
      bytes += data.length;
      if (bytes > LIMITS.siteBytes) return await undo(), { ok: false, error: "网站超过 " + kb(LIMITS.siteBytes) + " 了，放不下" };
      files.set(path, data.length);
      if (!s.versioned && old.has(path) && heldBytes + data.length <= LIMITS.hold) { held.push([path, data]); heldBytes += data.length; }
      else await put(path, data);
    }
    if (!files.has("index.html")) return await undo(), { ok: false, error: "输出里最外层没有 index.html，网站没有首页。用 out_dir 指一下网页所在的文件夹" };
    const other = await totalOther(hub, o.id);
    if (other.count + (exists ? 0 : 1) > LIMITS.sites) return await undo(), { ok: false, error: "已经部署了 " + LIMITS.sites + " 个网站，先删掉不要的" };
    if (other.bytes + bytes > LIMITS.totalBytes) return await undo(), { ok: false, error: "部署的网站加起来超过 " + kb(LIMITS.totalBytes) + " 了，先删掉不要的" };
    if (!s.versioned) {
      // New paths become servable before any old file is overwritten, so a new page never points at a missing asset.
      for (const p of files.keys()) if (!old.has(p)) hub.sql.exec("INSERT INTO site_file(id,path,size) VALUES(?,?,?) ON CONFLICT(id,path) DO UPDATE SET size=excluded.size", o.id, p, files.get(p)!);
      held.sort((x, y) => Number(/\.html?$/i.test(x[0])) - Number(/\.html?$/i.test(y[0])));
      for (const [p, d] of held) await put(p, d);
    }
  } catch (e: any) {
    await undo();
    return { ok: false, error: String(e?.message || e) };
  }
  // ---- the switch: no await from here on ----
  const now = o.now ?? deps.now();
  if (!exists) hub.sql.exec('INSERT INTO site(id,conv,title,created,updated,"by",files,bytes,views) VALUES(?,?,?,?,?,?,0,0,0)', o.id, o.conv, o.name, now, now, "deploy");
  hub.sql.exec("DELETE FROM site_file WHERE id=?", o.id);
  for (const [p, n] of files) hub.sql.exec("INSERT INTO site_file(id,path,size) VALUES(?,?,?)", o.id, p, n);
  if (s.versioned) hub.set(s.pub.verKey!(o.id), ver);
  if (s.spa) hub.set(s.pub.spaKey!(o.id), o.spa ? "1" : "");
  hub.sql.exec("UPDATE site SET files=?, bytes=?, updated=?, title=? WHERE id=?", files.size, bytes, now, o.name, o.id);
  hub.sql.exec('INSERT INTO deploy(conv,name,id,source,ver,spa,files,bytes,at,"by",note) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(conv,name) DO UPDATE SET id=excluded.id, source=excluded.source, ver=excluded.ver, spa=excluded.spa, files=excluded.files, bytes=excluded.bytes, at=excluded.at, "by"=excluded."by", note=excluded.note',
    o.conv, o.name, o.id, JSON.stringify(o.source), ver, o.spa ? 1 : 0, files.size, bytes, now, o.by, o.note);
  // Versioned: the whole previous version goes. In place: only paths the new version no longer has.
  const stale = s.versioned ? [...old.keys()].map(p => verKeyOf(o.id, oldVer, p)) : [...old.keys()].filter(p => !files.has(p)).map(p => plainKey(o.id, p));
  scheduleGc(hub, stale, now + LIMITS.gcDelayMs);
  return { ok: true, files: files.size, bytes, skipped, skippedCount };
}
async function totalOther(hub: Hub, id: string) {
  const r = hub.sql.exec("SELECT COUNT(*) c, COALESCE(SUM(s.bytes),0) b FROM deploy d JOIN site s ON s.id=d.id WHERE d.id<>?", id).toArray()[0] as any;
  return { count: Number(r.c), bytes: Number(r.b) };
}

/** Removes a deployed site: its rows, its live files now, anything still waiting in the garbage list later. */
export async function deleteSite(hub: Hub, conv: string, name: string, s = support(deps.pub)) {
  const d = deployRow(hub, conv, name);
  if (!d) return false;
  const keys = siteExists(hub, d.id) ? liveKeys(hub, s, d.id) : [];
  for (const t of ["site", "site_file", "site_state", "site_item"]) hub.sql.exec(`DELETE FROM ${t} WHERE id=?`, d.id);
  if (s.versioned) hub.set(s.pub.verKey!(d.id), "");
  if (s.spa) hub.set(s.pub.spaKey!(d.id), "");
  hub.sql.exec("DELETE FROM deploy WHERE conv=? AND name=?", conv, name);
  for (let i = 0; i < keys.length; i += 1000) await bucket(hub)?.delete(keys.slice(i, i + 1000)).catch((e: any) => console.log("staticsite: delete failed", e?.message));
  return true;
}

// ---------- getting the pack back ----------

const bytesStream = (b: Uint8Array) => new ReadableStream<Uint8Array>({ start(c) { c.enqueue(b); c.close(); } });
/** The parts of a finished transfer upload, one after another, as one stream. */
function partsStream(hub: Hub, key: string, parts: number) {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= parts) { c.close(); return; }
      hub.plan.add("r2_reads", 1);
      const o = await bucket(hub).get(partKey(key, i++));
      if (!o) { c.error(new Error("取回打包结果时少了一段")); return; }
      c.enqueue(new Uint8Array(await o.arrayBuffer()));
    },
  });
}
export const gunzip = (s: ReadableStream<Uint8Array>) => s.pipeThrough(new DecompressionStream("gzip") as any) as ReadableStream<Uint8Array>;

// ---------- the job ----------

const stepName = (c: string) => c.includes("git init") ? "下载代码" : c.includes("zipfile") ? "解压" : c.includes("PROBE") ? "查看项目" : c.includes("install.log") ? "安装依赖" : c.includes("build.log") ? "打包" : c.includes("tar --format") ? "收集输出" : c.includes("/x/put/") ? "传回" : c.includes("x/get/") || c.includes("curl -fsS") ? "取文件" : "准备";
const tailOf = (s: string, n: number) => s.length > n ? "…" + s.slice(-n) : s;
const summarize = (r: ComputerResult) => r.steps.map(s => ({ step: stepName(s.command), seconds: s.seconds, ok: s.exit === 0, ...(s.exit !== 0 ? { output: tailOf((s.stdout + "\n" + s.stderr).trim(), 1200) } : {}) }));
function failure(r: ComputerResult, what: string) {
  const bad = r.steps.find(s => s.exit !== 0);
  if (!bad) return what + "没跑完：" + (r.error || "原因不明");
  if (bad.exit === 137) return OOM;
  const said = bad.stderr.split("\n").map(l => l.trim()).filter(l => /[一-鿿]/.test(l) && !l.includes("超时")).pop();
  return said ? said : bad.exit === 124 || /超时/.test(bad.stderr) ? stepName(bad.command) + "超时了，被停掉了" : stepName(bad.command) + "失败了（退出码 " + bad.exit + "），详情见 steps";
}

export type Args = { name: string; source: Source; spa: boolean };

export async function runDeploy(ctx: Ctx, a: Args, d: Deps = deps) {
  const { hub, conv, host } = ctx, started = d.now(), s = support(d.pub);
  const prev = deployRow(hub, conv, a.name);
  const id = prev && siteExists(hub, prev.id) ? prev.id : (() => { let x: string; do x = newId(); while (siteExists(hub, x)); return x; })();
  const base = "/p/" + id + "/", ver = started.toString(36), w = WORK + "/" + id;
  const src = a.source, putFiles: { name: string; bytes: Uint8Array }[] = [];
  let fetch: string[];
  const env: Record<string, string> = {};
  if (src.kind === "repo") {
    const org = hub.env.GITHUB_ORG || "OmnixSI", full = src.repo.includes("/") ? src.repo : org + "/" + src.repo;
    const token = String(hub.env.GITHUB_TOKEN_2 || hub.env.GITHUB_TOKEN || "");
    if (token) env.GH_TOKEN = token;
    fetch = cloneCommands(w, full, src.pr ? "refs/pull/" + src.pr + "/head" : src.branch ? refspecOf(src.branch) : "HEAD");
  } else {
    const input = w + "/in.pack";
    if (/^x\d+$/i.test(src.ref)) {
      const b = host.boxIn(src.ref.toLowerCase());
      if (!b) return { ok: false, error: "文件箱里找不到 " + src.ref + "（可能过期了或不是这个群的）" };
      fetch = [b.command, "mkdir -p " + q(w) + " && mv -f " + q("/work/" + b.name) + " " + q(input)];
    } else {
      const f = await host.fileRef(src.ref).catch(() => null);
      if (!f) return { ok: false, error: "取不到文件 " + src.ref + "，可以让群友重发，或者先存进文件箱再用 x 开头的编号" };
      if (f.bytes.length > LIMITS.collect) return { ok: false, error: "这个压缩包超过 25 MB，先存进文件箱，再用 x 开头的编号" };
      const tmp = "deploy-" + id + "-" + ver + ".pack";
      putFiles.push({ name: tmp, bytes: f.bytes });
      fetch = ["mkdir -p " + q(w) + " && mv -f " + q("/work/" + tmp) + " " + q(input)];
    }
    fetch.push(...archiveCommands(w, input));
  }
  const steps: any[] = [];
  const cleanup = () => d.runComputer(hub, { commands: ["rm -rf " + q(w)], timeoutSeconds: 30 }).catch(() => null);
  let xferKey = "";
  try {
    // ---- 1: source and probe; the token exists only in this run, and nothing from the project runs here ----
    const r1 = await d.runComputer(hub, { commands: [...fetch, probeCommand(w, src.dir)], env, files: putFiles, timeoutSeconds: 300 });
    steps.push(...summarize(r1));
    if (!r1.ok) return { ok: false, error: failure(r1, "取代码"), steps };
    const commit = (r1.steps.map(x => x.stdout).join("\n").match(/^COMMIT (.*)$/m)?.[1] || "").slice(0, 120);
    const probe = parseProbe(r1.steps[r1.steps.length - 1].stdout);
    if (!probe) return { ok: false, error: "没看懂项目的结构（检查那一步没有输出）", steps };
    const plan = planBuild(probe, { base, dir: src.dir, outDir: src.out_dir, build: src.build });
    if (plan.error) return { ok: false, error: plan.error, commit, steps };
    if (!hub.plan.fits("container_seconds", plan.estimate + 90)) return { ok: false, error: "这个月云电脑的额度快到停止线了，打包要几分钟，下个周期再来", steps };
    if (plan.kind === "build") await host.say("代码取到了" + (commit ? "（" + commit + "）" : "") + "，开始" + plan.how + "，要几分钟").catch(() => false);

    // ---- 2: install, build, pack; big packs leave through the transfer path ----
    const pack = w + "/site.tgz", rel = pack.replace(/^\/work\//, "");
    xferKey = root(hub) + "deploy/" + id + "-" + ver + ".tgz";
    const t = issue(hub, { mode: "put", prefix: root(hub) + "deploy/", name: id + "-" + ver + ".tgz" }, 3600);
    const up = "s=$(stat -c %s " + q(pack) + "); if [ \"$s\" -gt " + LIMITS.collect + " ]; then " + uploadCommand(pack, link(hub, "put", t, id + "-" + ver + ".tgz"), LIMITS.packBytes) + "; fi";
    const r2 = await d.runComputer(hub, { commands: [...buildCommands(w, src.dir, plan, pack), up], collect: [rel], timeoutSeconds: 900 });
    steps.push(...summarize(r2));
    if (!r2.ok) return { ok: false, error: failure(r2, "打包"), commit, how: plan.how, steps };
    const out = parseDeploy(r2.steps.map(x => x.stdout).join("\n"));
    if (!out) return { ok: false, error: "打包完了但没拿到输出清单", steps };

    // ---- 3: unpack in the Worker and switch the site over ----
    let gz: ReadableStream<Uint8Array>;
    const got = r2.files.find(f => f.name === rel);
    if (got) gz = bytesStream(got.bytes);
    else {
      const x = row(hub, xferKey);
      if (!x || !x.done) return { ok: false, error: "打包结果有 " + kb(out.pack) + "，没能传回来", steps };
      if (!hub.plan.fits("r2_reads", x.parts)) return { ok: false, error: "这个月 R2 读取额度到停止线了", steps };
      gz = partsStream(hub, xferKey, x.parts);
    }
    if (!hub.plan.fits("r2_writes", out.files)) return { ok: false, error: "这个月 R2 写入的额度不够写 " + out.files + " 个文件了，下个周期再发布", steps };
    const entries = untar(gunzip(gz), { want: (p, n) => n <= LIMITS.fileBytes && !!normPath(cleanEntryPath(p) || "") });
    const by = ctx.askers.map(x => x.name).filter(Boolean).join("、").slice(0, 40);
    const saved = await storeSite(hub, { id, conv, name: a.name, ver, base, rewrite: plan.rewrite, spa: a.spa, source: src, by, note: commit, entries, s });
    if (!saved.ok) return { ok: false, error: saved.error, steps };
    const warn = [...plan.warn];
    if (a.spa && !s.spa) warn.push("单页应用的“未知路径回到首页”现在还没开（要等发布功能支持），直接打开子页面的链接会 404，从首页点进去没问题");
    if (prev && !s.versioned) warn.push("这次是原地替换：换文件的几秒钟里，正在打开的人可能看到新旧混在一起");
    return {
      ok: true, name: a.name, url: baseUrl(hub) + base + (prev ? "?v=" + ver : ""), replaced: !!prev,
      source: describeSource(src), ...(commit ? { commit } : {}), how: plan.how, output_folder: out.out,
      files: saved.files, size: kb(saved.bytes),
      ...(saved.skippedCount ? { skipped: saved.skipped, skipped_count: saved.skippedCount } : {}),
      ...(warn.length ? { warnings: warn } : {}),
      ...(plan.rewrite && plan.kind === "build" ? { note: "没认出用的是什么框架，网页里以 / 开头的链接已经改到网站地址下；脚本里拼出来的地址如果出问题，告诉我是哪个页面" } : {}),
      seconds: Math.round((d.now() - started) / 1000), steps,
    };
  } finally {
    await cleanup();
    if (xferKey) await remove(hub, xferKey).catch(() => {});
  }
}

// ---------- tool ----------

function parseSource(a: any, last: DeployRow | null): Source | string {
  // A new source starts from defaults; only a bare redeploy ("deploy blog again") keeps the earlier settings.
  const prev = a.repo || a.file ? null : last;
  const dir = subDir(a.dir ?? (prev ? prev.source.dir : "."));
  if (!dir) return "dir 要写项目里的相对路径，如 apps/web";
  const out = a.out_dir === undefined || a.out_dir === null || a.out_dir === "" ? prev?.source.out_dir : subDir(a.out_dir);
  if (out === null) return "out_dir 要写相对路径，如 dist";
  const build = typeof a.build === "boolean" ? a.build : prev?.source.build;
  const common = { dir, ...(out ? { out_dir: out } : {}), ...(build !== undefined ? { build } : {}) };
  if (a.repo) {
    const repo = repoName(a.repo);
    if (!repo) return "仓库名看不懂，写成 TeamAgent 或 owner/name";
    const pr = a.pr === undefined || a.pr === null || a.pr === "" ? 0 : Number(String(a.pr).replace(/^#/, ""));
    if (pr && !(Number.isInteger(pr) && pr > 0)) return "PR 编号要是正整数";
    const branch = a.branch ? String(a.branch).trim() : "";
    if (branch && !validRef(branch)) return "分支名看不懂";
    return { kind: "repo", repo, ...(pr ? { pr } : branch ? { branch } : {}), ...common };
  }
  if (a.file) {
    const ref = String(a.file).trim();
    if (!/^(x|f)\d+$/i.test(ref) && !/^\d+-\d+$/.test(ref)) return "file 要写文件编号，如 f12（聊天里的文件）或 x12（文件箱）";
    return { kind: "archive", ref, file: ref, ...common };
  }
  if (prev) return { ...prev.source, ...common } as Source;
  return "要给 repo（仓库名）或 file（上传的 zip / tar.gz 压缩包编号）";
}

export function refusal(hub: { plan: { fits(n: string, a?: number): boolean }; get(k: string): string | null }, now = Date.now()) {
  if (!hub.plan.fits("container_seconds", 600) || !hub.plan.fits("container_cpu_seconds", 300)) return "这个月云电脑的额度快到停止线了，打包一次要几分钟，下个周期再来";
  if (!hub.plan.fits("r2_writes", LIMITS.siteFiles)) return "这个月 R2 写入额度快到停止线了，下个周期再发布";
  if (now - Number(hub.get("deploy:busy") || 0) < LIMITS.lockMs) return "上一个网站还在打包，等它好了再来";
  if (now - Number(hub.get("preview:busy") || 0) < 16 * 60000) return "云电脑正在跑项目预览，内存不够同时打包，等它结束再来";
  return "";
}

function makeTool(ctx: Ctx, d: Deps): Tool {
  const { hub, conv, host } = ctx;
  return {
    name: "deploy_site", work: true, slow: true, long: true,
    description: "把一个网站部署到固定链接（静态站部署）：在云电脑里把团队仓库或上传的压缩包打包（npm/pnpm/yarn 安装 + build，自动认 Vite、Astro、Create React App、Vue CLI、Docusaurus、VitePress、Nuxt、Angular、Next.js 静态导出），把输出的网页放到 Bot 的网址下，链接一直不变，再部署同一个名字就原地换成新版本。适合「把官网发上去」「部署一下 blog 的 PR 12 看看」「这个 zip 发成网页」「重新部署 blog」。" +
      "op=deploy：name 是网站的名字（之后靠它重新部署和删除；不给就用仓库名）；来源二选一：repo（仓库名，可加 branch 或 pr，monorepo 用 dir 指子项目），或 file（群友上传的 zip / tar.gz，聊天文件 f12 或文件箱 x12；可以是要打包的项目，也可以是已经打包好的网页文件夹）。已经部署过的名字只给 name 就按上次的来源重新部署。" +
      "out_dir 指输出文件夹（认不出时用）；build=false 不打包、直接发现成的网页；spa=true 是单页应用（React Router 这类，未知路径回到首页）。要几分钟，返回 url，把它原样发到群里。" +
      "op=list 列出部署过的网站（名字、链接、来源、时间、大小）；op=delete 给 name 删掉。限制：一个网站最多 800 个文件、60 MB，Node 内存 1 GB 以内，太大的项目会打包失败；网站是公开链接（拿到链接的人都能看），每天部署次数有限。",
    parameters: {
      type: "object", required: ["op"], additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["deploy", "list", "delete"] },
        name: { type: "string", description: "网站名字，如 blog、官网；deploy 时不给就用仓库名或压缩包编号" },
        repo: { type: "string", description: "仓库名，如 NextThought-Website；别的组织写 owner/name" },
        branch: { type: "string", description: "分支名，不填用默认分支" },
        pr: { type: "integer", description: "PR 编号，部署这个 PR 的代码（和 branch 二选一）" },
        file: { type: "string", description: "上传的压缩包（zip、tar.gz）：聊天文件编号 f12，或文件箱编号 x12" },
        dir: { type: "string", description: "项目在仓库或压缩包里的子文件夹，如 apps/web；默认最外层" },
        out_dir: { type: "string", description: "打包输出的文件夹（相对 dir），如 dist；默认自动找" },
        build: { type: "boolean", description: "false 表示不安装不打包，直接发布现成的网页" },
        spa: { type: "boolean", description: "单页应用填 true：不存在的路径都返回首页" },
      },
    },
    run: async a => {
      const op = String(a.op || "");
      if (op === "list") {
        const rows = hub.sql.exec('SELECT conv,name,id,source,ver,spa,files,bytes,at,"by" AS "by",note FROM deploy WHERE conv=? ORDER BY at DESC LIMIT 50', conv).toArray().map(toRow);
        const gone = rows.filter(r => !siteExists(hub, r.id));
        for (const g of gone) hub.sql.exec("DELETE FROM deploy WHERE conv=? AND name=?", conv, g.name);
        const live = rows.filter(r => !gone.includes(r));
        return { ok: true, sites: live.map(r => ({ name: r.name, url: baseUrl(hub) + "/p/" + r.id + "/", source: describeSource(r.source), ...(r.note ? { commit: r.note } : {}), deployed: fmtFull(r.at, BJ) + " 北京时间", ...(r.by ? { by: r.by } : {}), files: r.files, size: kb(r.bytes), ...(r.spa ? { spa: true } : {}) })),
          ...(live.length ? {} : { note: "这个对话还没有部署过网站" }) };
      }
      if (op === "delete") {
        const name = siteName(a.name);
        if (!name || !deployRow(hub, conv, name)) return { ok: false, error: "没有叫这个名字的网站，先 list 看看" };
        await deleteSite(hub, conv, name, support(d.pub));
        return { ok: true, deleted: name };
      }
      if (op !== "deploy") return { ok: false, error: "op 只能是 deploy、list、delete" };
      const fallback = a.repo ? String(repoName(a.repo) || "").split("/").pop() : "";
      const name = siteName(a.name || fallback || (a.file && !a.repo ? "site-" + String(a.file).toLowerCase() : ""));
      if (!name) return { ok: false, error: "网站名字只能用字母、数字、汉字、- 和 _，最多 40 个字" };
      const prev = deployRow(hub, conv, name);
      const source = parseSource(a, prev);
      if (typeof source === "string") return { ok: false, error: source };
      const why = refusal(hub, d.now());
      if (why) return { ok: false, error: why };
      if (!(await host.quota("deploy_site", Number(host.cfg("deploy_daily"))))) return { ok: false, error: "今天部署网站的次数用完了，明天再来" };
      const note = host.advice ? host.advice("container_seconds", 480) : advice(hub, "container_seconds", 480);
      hub.set("deploy:busy", String(d.now()));
      try {
        const r: any = await runDeploy(ctx, { name, source, spa: typeof a.spa === "boolean" ? a.spa : !!prev?.spa }, d);
        return note ? { ...r, budget_note: note } : r;
      } catch (e: any) {
        return { ok: false, error: "部署出错：" + clip(String(e?.message || e), 300) };
      } finally { hub.set("deploy:busy", "0"); }
    },
  };
}

const feature: Feature = {
  name: "staticsite",
  schema: `CREATE TABLE IF NOT EXISTS deploy(conv TEXT, name TEXT, id TEXT, source TEXT, ver TEXT, spa INTEGER, files INTEGER, bytes INTEGER, at INTEGER, "by" TEXT, note TEXT, PRIMARY KEY(conv, name));
CREATE TABLE IF NOT EXISTS deploy_gc(k TEXT PRIMARY KEY, after INTEGER);`,
  tunables: { deploy_daily: { default: 4, min: 0, max: 20, what: "每天最多部署几次网站（静态站部署，每次要用几分钟云电脑）" } },
  tools: ctx => [makeTool(ctx, deps)],
  tick(hub, now) {
    if (now - Number(hub.get("deploy:gc") || 0) < 60000) return;
    hub.set("deploy:gc", String(now));
    hub.ctx.waitUntil(collectGarbage(hub, now).catch((e: any) => console.log("staticsite: gc failed", e?.message)));
  },
  about: [
    "deploy_site 能把团队仓库或群友上传的压缩包在云电脑里打包成网站，发到 Bot 网址下的固定链接（/p/一串随机字符/），再部署同一个名字链接不变、内容换新。",
    "会自己认包管理器（npm、pnpm、yarn）和框架（Vite、Astro、Create React App、Vue CLI、Docusaurus、VitePress、Nuxt、Angular，Next.js 只能静态导出），打包时把网站所在的路径传给框架，资源地址才对；认不出框架时把网页里以 / 开头的链接改到网站地址下。",
    "每个网站记着是从哪个仓库、分支或压缩包做的，说“重新部署 blog”就按原样再做一遍；换版本时新文件先放好再一下切过去，旧文件过 15 分钟才删。",
    "取代码时 GitHub 令牌只在下载那一步有，装依赖和打包时已经拿掉了，项目里的脚本读不到它。",
    "限制：一个网站最多 800 个文件、60 MB，所有部署的网站加起来 400 MB、最多 12 个；云电脑只有 1 GB 内存，太大的项目打包会被杀掉，这时可以在自己电脑上打包好上传；每天部署次数有上限（deploy_daily，默认 4）。",
  ],
};
export default feature;
