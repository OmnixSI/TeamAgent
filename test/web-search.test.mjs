import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(entry) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: "esm",
    platform: "browser",
    write: false,
  });
  const code = Buffer.from(out.outputFiles[0].text).toString("base64");
  return import("data:text/javascript;base64," + code);
}

const api = await load("src/tools/web-search.ts");

// 形态取自探针报告 §5：真实 5 条标题/URL + API 文档列出的字段（snippet/summary/date/site_name）。
const FIXTURE = {
  results: [
    {
      title: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real | DeepSeek API Docs",
      url: "https://api-docs.deepseek.com/news/news261017/",
      snippet: "DeepSeek V4.1 Flash 发布：许愿式编程。",
      summary: "V4.1 Flash 把一次性需求直接变成可运行项目，并公布限时价格。",
      date: "2026-10-17",
      site_name: "api-docs.deepseek.com",
      rerank_score: 2.476604461669922,
      authority: 3,
    },
    {
      title: "DeepSeek V4.1 Flash 新版本：许愿式编程一键成真 | DeepSeek API Docs",
      url: "https://api-docs.deepseek.com/zh-cn/news/news261017/#1",
      snippet: "中文版发布说明。",
      summary: "中文发布说明与迁移提示。",
      date: "2026-10-17",
      site_name: "api-docs.deepseek.com",
      rerank_score: 2.476604461669922,
      authority: 3,
    },
    {
      title: "DeepSeek V4.1 Flash：更强、更快、更普惠 | DeepSeek API Docs",
      url: "https://api-docs.deepseek.com/zh-cn/news/news260910/#1",
      snippet: "更强、更快、更普惠。",
      summary: "9 月版本的能力与价格说明。",
      date: "2026-09-10",
      site_name: "api-docs.deepseek.com",
      rerank_score: 2.429729461669922,
      authority: 3,
    },
    {
      title: "Change Log | DeepSeek API Docs - Search / Fetch API is now available, powered by our in-house search engine and supporting web search and fetch",
      url: "https://api-docs.deepseek.com/updates/#1",
      snippet: "Search / Fetch API is now available.",
      summary: "更新日志：搜索与抓取 API 上线。",
      date: "2026-10-17",
      site_name: "api-docs.deepseek.com",
      rerank_score: 2.414104461669922,
      authority: 3,
    },
    {
      title: "Change Log | DeepSeek API Docs",
      url: "https://api-docs.deepseek.com/updates",
      snippet: "All API changes in one page.",
      summary: "API 变更汇总。",
      date: "2026-10-17",
      site_name: "api-docs.deepseek.com",
      rerank_score: 2.398479461669922,
      authority: 3,
    },
  ],
};

function okResult(data = FIXTURE, latency = 12) {
  return { ok: true, data, latency_ms: latency, status: 200 };
}

function make({ call, guard } = {}) {
  const calls = [];
  const guards = [];
  const released = [];
  const tool = api.createWebSearchTool({
    callDsTool: async (e, o) => {
      calls.push(o);
      return call ? call(o, e) : okResult();
    },
    dsGuard: async (e, o) => {
      guards.push(o);
      const result = guard ? guard(o, e) : { ok: true, release: async () => {} };
      if (result.ok) {
        const inner = result.release;
        result.release = async () => {
          released.push(o);
          await inner();
        };
      }
      return result;
    },
  });
  return { tool, calls, guards, released };
}

function ctx({ group = "GROUP0001", sender = "user-1", messages = [] } = {}) {
  return {
    context: { group_id: group, latest: { group_id: group, sender } },
    source: { sender },
    messages,
    isTainted: () => false,
  };
}

test("正常：默认 count=5，结果只保留 title/url/snippet/summary/date/site 并带来源 url", async () => {
  const { tool, calls, guards, released } = make();
  const r = await tool.run({ DEEPSEEK_API_KEY: "k" }, { query: "DeepSeek V4.1 Flash" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.tool, "web_search");
  assert.equal(r.count, 5);
  assert.equal(r.empty, false);
  assert.equal(r.citation_required, true);
  assert.match(r.answer_rule, /url/);
  assert.equal(r.results.length, 5);
  assert.deepEqual(r.results[0], {
    title: "DeepSeek-V4.1-Flash-1017: Wish-Driven Programming Made Real | DeepSeek API Docs",
    url: "https://api-docs.deepseek.com/news/news261017/",
    snippet: "DeepSeek V4.1 Flash 发布：许愿式编程。",
    summary: "V4.1 Flash 把一次性需求直接变成可运行项目，并公布限时价格。",
    date: "2026-10-17",
    site: "api-docs.deepseek.com",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].json, { query: "DeepSeek V4.1 Flash", count: 5 });
  assert.equal(calls[0].purpose, "search");
  assert.equal(calls[0].group, "GROUP0001");
  assert.equal(calls[0].sender, "user-1");
  assert.equal(guards.length, 1);
  assert.equal(guards[0].purpose, "search");
  assert.equal(released.length, 1);
});

test("count 夹在 1..10：0→1、99→10、非数字→5；query 空白折叠", async () => {
  for (const [input, expected] of [[0, 1], [99, 10], ["abc", 5], [3, 3], [10, 10]]) {
    const { tool, calls } = make();
    const r = await tool.run({}, { query: "  量子   计算  ", count: input }, ctx());
    assert.equal(r.ok, true);
    assert.equal(calls[0].json.count, expected);
    assert.equal(calls[0].json.query, "量子 计算");
  }
});

test("query 超过 128 字截断并说明", async () => {
  const { tool, calls } = make();
  const long = "搜".repeat(200);
  const r = await tool.run({}, { query: long }, ctx());
  assert.equal(r.ok, true);
  assert.equal(Array.from(calls[0].json.query).length, 128);
  assert.equal(r.query_truncated, true);
  assert.match(r.note, /128/);
  assert.equal(r.query, "搜".repeat(128));
});

test("site:/lang:/after:/before: 原样透传；结构化参数追加为操作符", async () => {
  {
    const { tool, calls } = make();
    const q = "量子计算 site:arxiv.org lang:en after:2026-01-01 before:2026-12-31";
    await tool.run({}, { query: q }, ctx());
    assert.equal(calls[0].json.query, q);
  }
  {
    const { tool, calls } = make();
    await tool.run({}, { query: "量子计算", site: "arxiv.org", lang: "en", after: "2026-01-01", before: "2026-12-31" }, ctx());
    assert.equal(calls[0].json.query, "量子计算 site:arxiv.org lang:en after:2026-01-01 before:2026-12-31");
  }
  {
    // 已经有 site: 时不重复追加
    const { tool, calls } = make();
    await tool.run({}, { query: "量子计算 site:arxiv.org", site: "arxiv.org" }, ctx());
    assert.equal(calls[0].json.query, "量子计算 site:arxiv.org");
  }
});

test("空结果：ok=true、empty=true，如实提示没搜到", async () => {
  const { tool } = make({ call: () => okResult({ results: [] }) });
  const r = await tool.run({}, { query: "根本不存在的关键词" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.empty, true);
  assert.equal(r.count, 5);
  assert.deepEqual(r.results, []);
  assert.match(r.note, /没搜到/);
  assert.doesNotMatch(r.note, /编造/);
});

test("结果清洗：缺 title/url 的丢弃，非 http(s) URL 丢弃，缺站点时从 url 推导", async () => {
  const data = {
    results: [
      { title: "没有链接", snippet: "x" },
      { title: "坏协议", url: "javascript:alert(1)" },
      { title: "正常但没站点名", url: "https://example.com/a", snippet: "s" },
      { title: "ftp 也不收", url: "ftp://example.com/x" },
    ],
  };
  const { tool } = make({ call: () => okResult(data) });
  const r = await tool.run({}, { query: "q" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].url, "https://example.com/a");
  assert.equal(r.results[0].site, "example.com");
  assert.equal(r.results[0].date, null);
});

test("参数校验：空 query 不调用云端也不占用限额", async () => {
  const { tool, calls, guards } = make();
  const r = await tool.run({}, { query: "   " }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "bad_query");
  assert.equal(r.retryable, false);
  assert.equal(calls.length, 0);
  assert.equal(guards.length, 0);
});

test("限额：dsGuard 拒绝时直接返回，不调用云端", async () => {
  const { tool, calls } = make({
    guard: () => ({
      ok: false,
      error_kind: "quota",
      retryable: false,
      reason_text: "今天的搜索次数用完了",
      next_action: "告诉成员今天的搜索额度已用完，不要重试",
    }),
  });
  const r = await tool.run({}, { query: "q" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "quota");
  assert.match(r.reason_text, /搜索次数用完/);
  assert.match(r.next_action, /额度/);
  assert.equal(calls.length, 0);
});

test("限额检查本身抛异常：结构化 upstream，不调用云端", async () => {
  const calls = [];
  const tool = api.createWebSearchTool({
    callDsTool: async (e, o) => { calls.push(o); return okResult(); },
    dsGuard: async () => { throw new Error("db down"); },
  });
  const r = await tool.run({}, { query: "q" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "upstream");
  assert.equal(calls.length, 0);
  assert.doesNotMatch(JSON.stringify(r), /db down/);
});

test("云端每种失败形态原样映射，并且释放限额", async () => {
  const kinds = ["refused", "budget", "quota", "timeout", "upstream", "auth", "unsupported", "denied", "too_large"];
  for (const kind of kinds) {
    const { tool, released } = make({
      call: () => ({
        ok: false,
        error_kind: kind,
        retryable: kind === "timeout" || kind === "upstream",
        status: kind === "denied" ? 403 : undefined,
        reason_text: "上游说明",
        next_action: "上游下一步",
      }),
    });
    const r = await tool.run({}, { query: "q" }, ctx());
    assert.equal(r.ok, false, kind);
    assert.equal(r.error_kind, kind);
    assert.equal(r.status, kind === "denied" ? 403 : undefined);
    assert.equal(r.reason_text, "上游说明");
    assert.equal(r.next_action, "上游下一步");
    assert.equal(released.length, 1, kind);
  }
});

test("云端抛异常时转成 upstream 并释放限额", async () => {
  const { tool, released } = make({ call: () => { throw new Error("boom"); } });
  const r = await tool.run({}, { query: "q" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "upstream");
  assert.equal(released.length, 1);
});

test("返回摘要包含来源与时间，且每条结果都能引用 url", async () => {
  const { tool } = make();
  const r = await tool.run({}, { query: "q" }, ctx());
  assert.match(r.citation_rule, /url/);
  for (const item of r.results) assert.match(item.url, /^https:\/\//);
});

test("注册：EXTRA_TOOLS 含 web_search 且标记 untrusted；结果套外部资料封套", async () => {
  const registry = await load("src/tools/index.ts");
  const tool = registry.EXTRA_TOOLS.find((t) => t.name === "web_search");
  assert.ok(tool, "web_search 未注册");
  assert.equal(tool.untrusted, true);
  const { extraUntrustedNames } = await load("src/toolkit.ts");
  assert.ok(extraUntrustedNames().includes("web_search"));

  const { tool: instance } = make();
  const result = await instance.run({}, { query: "q" }, ctx());
  const { untrusted } = await load("src/untrusted.ts");
  const wrapped = untrusted("web_search", JSON.stringify(result), undefined, 40000);
  assert.match(wrapped, /^【外部资料·不可信/);
  assert.match(wrapped, /【外部资料结束】$/);
  assert.match(wrapped, /api-docs\.deepseek\.com/);
});

test("description 说明与 news_search 的区别", () => {
  const tool = api.createWebSearchTool();
  assert.match(tool.def.function.description, /news_search/);
  assert.match(tool.def.function.description, /新闻/);
  assert.match(tool.def.function.description, /site:/);
  assert.match(tool.def.function.description, /url/);
  assert.equal(tool.def.function.name, "web_search");
  assert.equal(tool.name, "web_search");
});

test("导出帮助文案常量，供能力卡（DS-5）使用", () => {
  assert.equal(typeof api.WEB_SEARCH_HELP, "string");
  assert.match(api.WEB_SEARCH_HELP, /web_search/);
  assert.match(api.WEB_SEARCH_HELP, /url/);
});
