// F9DS-4 live evidence: three real web_search calls, three real fetch_page
// calls (one is a forbidden-page probe) and the readUrl fallback chain over
// three real links taken read-only from the local message fixture. The key is
// read from DEEPSEEK_API_KEY_FILE into memory and never printed.
// Usage: DEEPSEEK_API_KEY_FILE=/path/to/key node scripts/f9ds-4-live.mjs [--only=search,fetch,readurl]
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const KEY_FILE = process.env.DEEPSEEK_API_KEY_FILE;
if (!KEY_FILE || !existsSync(KEY_FILE)) {
  console.error("DEEPSEEK_API_KEY_FILE is required and must exist");
  process.exit(2);
}
const KEY = readFileSync(KEY_FILE, "utf8").trim();
if (!KEY) {
  console.error("DEEPSEEK_API_KEY_FILE is empty");
  process.exit(2);
}

const only = (process.argv.find((arg) => arg.startsWith("--only=")) || "").split("=")[1] || "";
const want = (section) => !only || only.split(",").includes(section);

const repo = process.cwd();
const dir = mkdtempSync(join(tmpdir(), "teamagent-test-f9ds-4-live-"));
const outfile = join(dir, "bundle.mjs");
const fixture = "/Users/yanghongming/Projects/TeamAgent-f7-2-real-fixture-20261114/messages.json";

const counts = { search: 0, fetch: 0, jina: 0, other: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = String(input);
  if (url.includes("/v1/tools/search")) counts.search += 1;
  else if (url.includes("/v1/tools/fetch")) counts.fetch += 1;
  else if (url.startsWith("https://r.jina.ai/")) counts.jina += 1;
  else counts.other += 1;
  return realFetch(input, init);
};

const line = (label, value) => console.log(`${label}: ${value}`);

async function searchSection(api, e, ctx) {
  console.log("== web_search 3 条 ==");
  const searches = [
    ["中文时事", "2026年11月 人工智能 最新进展"],
    ["英文技术", "Cloudflare D1 query limits 2026"],
    ["site 限定", "DeepSeek search API site:api-docs.deepseek.com"],
  ];
  const tool = api.createWebSearchTool();
  for (const [label, query] of searches) {
    const started = Date.now();
    const r = await tool.run(e, { query, count: 5 }, ctx);
    const elapsed = Date.now() - started;
    if (r.ok) {
      line(
        label,
        `ok 耗时 ${elapsed}ms（上游 ${r.latency_ms}ms）条数 ${r.results.length} 空=${r.empty} 首条=${JSON.stringify(r.results[0]?.title || "")}`,
      );
    } else {
      line(label, `fail 耗时 ${elapsed}ms ${r.error_kind} ${r.reason_text}`);
    }
  }
}

async function fetchSection(api, e, ctx) {
  console.log("== fetch_page 3 个公开页（含 1 个被拒探测） ==");
  // 2026-11-14: 探针 §5.2 的 403 URL access denied 已不能复现——不存在的 api-docs
  // 路径现在返回 200 Page Not Found，知乎/微博/Reddit 等均返回 404。403→denied 的
  // 映射由 test/fetch-page.test.mjs 的夹具覆盖；这里保留一个“被拒探测”并如实打印当天状态。
  const pages = [
    ["中文新闻", "https://www.chinanews.com.cn/"],
    ["英文文档", "https://developers.cloudflare.com/d1/platform/limits/"],
    ["被拒探测", "https://api-docs.deepseek.com/this-page-does-not-exist-9f2c"],
  ];
  const tool = api.createFetchPageTool();
  for (const [label, url] of pages) {
    const started = Date.now();
    const r = await tool.run(e, { url }, ctx);
    const elapsed = Date.now() - started;
    if (r.ok) {
      line(label, `ok 耗时 ${elapsed}ms（上游 ${r.latency_ms}ms）字数 ${r.chars} truncated=${r.truncated} 标题=${JSON.stringify(r.title)}`);
      line(label + " 开头", JSON.stringify(r.content.slice(0, 80)));
    } else {
      line(label, `fail 耗时 ${elapsed}ms kind=${r.error_kind} status=${r.status ?? "-"} ${r.reason_text}`);
    }
  }
}

async function readUrlSection(api, e) {
  console.log("== readUrl 回退链（3 条线上真实链接，只读夹具） ==");
  const messages = JSON.parse(readFileSync(fixture, "utf8"));
  const urlPattern = /https?:\/\/[^\s"'<>()（）\[\]，。；、]+/g;
  const skip = /bilibili|b23\.tv|bili2233|x\.com|twitter\.com|qq\.com|url\.cn|ugcimg\.cn|gtimg\.cn|qpic\.cn|\.(png|jpe?g|gif|webp|svg)(\?|$)/i;
  const picks = [];
  for (const message of messages) {
    for (const raw of String(message?.body || "").match(urlPattern) || []) {
      const url = raw.replace(/[.,;)]+$/, "");
      if (skip.test(url)) continue;
      const host = url.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
      if (picks.some((p) => p.host === host)) continue;
      picks.push({ url, host, rid: message.rid });
      if (picks.length >= 3) break;
    }
    if (picks.length >= 3) break;
  }
  for (const pick of picks) {
    const started = Date.now();
    const r = await api.readUrl(e, pick.url, { purpose: "research", deadline: Date.now() + 15000 });
    const elapsed = Date.now() - started;
    if (r.ok) line(`rid ${pick.rid} ${pick.host}`, `ok ${r.source} 耗时 ${elapsed}ms 字数 ${Array.from(r.text).length}`);
    else line(`rid ${pick.rid} ${pick.host}`, `fail ${r.reason} 耗时 ${elapsed}ms`);
  }
}

async function main() {
  await build({
    stdin: {
      contents: [
        `export { createWebSearchTool } from ${JSON.stringify(join(repo, "src/tools/web-search.ts"))};`,
        `export { createFetchPageTool } from ${JSON.stringify(join(repo, "src/tools/fetch-page.ts"))};`,
        `export { readUrl } from ${JSON.stringify(join(repo, "src/semantic.ts"))};`,
      ].join("\n"),
      resolveDir: repo,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    outfile,
    logLevel: "error",
  });
  const api = await import(outfile + "?v=" + Date.now());
  const e = { DEEPSEEK_API_KEY: KEY };
  const ctx = {
    context: { group_id: "f9ds-4-live", latest: { group_id: "f9ds-4-live", sender: "probe" } },
    source: { sender: "probe" },
    messages: [],
    isTainted: () => false,
  };

  if (want("search")) await searchSection(api, e, ctx);
  if (want("fetch")) await fetchSection(api, e, ctx);
  if (want("readurl")) await readUrlSection(api, e);

  const calls = counts.search + counts.fetch;
  const micro = calls * 750;
  console.log("== 调用与花费 ==");
  line("search 调用", counts.search);
  line("fetch 调用", counts.fetch);
  line("Jina 调用（免费）", counts.jina);
  line("估算花费", `$${(micro / 1_000_000).toFixed(6)}（${micro} microUSD，按 $0.75/千次）`);
  if (micro > 10_000) {
    console.error("OVER BUDGET: > $0.01");
    process.exitCode = 1;
  }
}

try {
  await main();
} finally {
  rmSync(dir, { recursive: true, force: true });
  console.log(`临时目录已删除: ${dir}`);
}
