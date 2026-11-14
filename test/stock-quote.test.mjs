import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";

// F9-1 stock_quote: Tencent's quote endpoint is GBK and its search endpoint is
// UTF-8 with \uXXXX escapes. The fixtures are the bytes Tencent actually
// returned on 2026-11-13, kept verbatim so the decoder is exercised for real.
async function load(entry, platform = "browser") {
  const out = await build({ entryPoints: [entry], bundle: true, format: "esm", platform, write: false });
  return import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));
}

const FIXTURES = new URL("./fixtures/stock-quote/", import.meta.url);
const fixture = (name) => readFileSync(new URL(name, FIXTURES));
const NOW = Date.parse("2026-11-14T00:00:00Z");

const api = await load("src/tools/stock-quote.ts");
const toolkit = await load("src/toolkit.ts", "neutral");

const ctx = (group = "G1") => ({ context: { group_id: group }, messages: [], isTainted: () => false });

function make({ fetchImpl, now = () => NOW, cacheTtlMs = 15_000, timeoutMs = 500 } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(String(url));
    return fetchImpl(String(url), init || {});
  };
  return { tool: api.createStockQuoteTool({ fetch, now, cacheTtlMs, timeoutMs }), calls };
}

const quoteResponse = (name) => new Response(fixture(name));

test("SH600519 与 600519 都归一到 sh600519，GBK 行情按字段索引解析", async () => {
  for (const symbol of ["SH600519", "600519"]) {
    const { tool, calls } = make({ fetchImpl: () => quoteResponse("sh600519.gbk") });
    const r = await tool.run({}, { symbol }, ctx());
    assert.equal(r.ok, true, symbol);
    assert.deepEqual(calls, ["https://qt.gtimg.cn/q=sh600519"], symbol);
    assert.equal(r.name, "贵州茅台");
    assert.equal(r.code, "sh600519");
    assert.equal(r.price, 1435.26);
    assert.equal(r.prev_close, 1410.27);
    assert.equal(r.open, 1404);
    assert.equal(r.change, 24.99);
    assert.equal(r.change_pct, 1.77);
    assert.equal(r.high, 1437.69);
    assert.equal(r.low, 1394);
    assert.equal(r.quote_time, "2026-11-13 16:14:55");
    assert.equal(r.source, "腾讯行情");
    assert.equal(r.content_scope, "quote");
  }
});

test("00700 → hk00700：港股时间格式归一，负涨跌保留", async () => {
  const { tool, calls } = make({ fetchImpl: () => quoteResponse("hk00700.gbk") });
  const r = await tool.run({}, { symbol: "00700" }, ctx());
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ["https://qt.gtimg.cn/q=hk00700"]);
  assert.equal(r.name, "腾讯控股");
  assert.equal(r.code, "hk00700");
  assert.equal(r.price, 386.6);
  assert.equal(r.change, -12.2);
  assert.equal(r.change_pct, -3.06);
  assert.equal(r.quote_time, "2026-11-13 16:08:22");
});

test("AAPL 与 us.AAPL → usAAPL：美股代码按规整后的代码请求", async () => {
  for (const symbol of ["AAPL", "us.AAPL"]) {
    const { tool, calls } = make({ fetchImpl: () => quoteResponse("usAAPL.gbk") });
    const r = await tool.run({}, { symbol }, ctx());
    assert.equal(r.ok, true, symbol);
    assert.deepEqual(calls, ["https://qt.gtimg.cn/q=usAAPL"], symbol);
    assert.equal(r.name, "苹果");
    assert.equal(r.code, "usAAPL");
    assert.equal(r.price, 358.21);
    assert.equal(r.quote_time, "2026-11-13 10:08:00");
  }
});

test("中文名先走 smartbox 搜索：茅台 → sh600519，UTF-8 \\uXXXX 正确反转义", async () => {
  const { tool, calls } = make({
    fetchImpl: (url) =>
      url.startsWith("https://smartbox.gtimg.cn/")
        ? new Response(fixture("smartbox-maotai.txt"))
        : quoteResponse("sh600519.gbk"),
  });
  const r = await tool.run({}, { symbol: "茅台" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.code, "sh600519");
  assert.equal(r.name, "贵州茅台");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^https:\/\/smartbox\.gtimg\.cn\/s3\/\?v=2&q=%E8%8C%85%E5%8F%B0&t=all$/);
  assert.equal(calls[1], "https://qt.gtimg.cn/q=sh600519");
});

test("搜索优先个股而不是指数：腾讯 → hk00700 腾讯控股，不取 000847 腾讯济安", async () => {
  const { tool, calls } = make({
    fetchImpl: (url) =>
      url.startsWith("https://smartbox.gtimg.cn/")
        ? new Response(fixture("smartbox-tencent.txt"))
        : quoteResponse("hk00700.gbk"),
  });
  const r = await tool.run({}, { symbol: "腾讯" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.code, "hk00700");
  assert.equal(r.name, "腾讯控股");
  assert.equal(calls.at(-1), "https://qt.gtimg.cn/q=hk00700");
});

test("坏代码/搜不到：not_found，不重试，不返回价格字段", async () => {
  const bad = make({ fetchImpl: () => new Response(fixture("none.txt")) });
  const r = await bad.tool.run({}, { symbol: "SH999999" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "not_found");
  assert.equal(r.retryable, false);
  assert.equal(typeof r.next_action, "string");
  assert.ok(r.next_action.length > 0);
  assert.equal(r.price, undefined);

  const empty = make({ fetchImpl: () => new Response('v_hint="";') });
  const q = await empty.tool.run({}, { symbol: "不存在的股票" }, ctx());
  assert.equal(q.ok, false);
  assert.equal(q.error_kind, "not_found");
  assert.equal(empty.calls.length, 1, "empty search must not fall through to a quote");
});

test("腾讯不可达 → upstream_unavailable；HTTP 429 → rate_limited", async () => {
  const down = make({ fetchImpl: () => { throw new TypeError("fetch failed"); } });
  const d = await down.tool.run({}, { symbol: "SH600519" }, ctx());
  assert.equal(d.ok, false);
  assert.equal(d.error_kind, "upstream_unavailable");
  assert.equal(d.retryable, true);
  assert.ok(d.next_action.length > 0);

  const limited = make({ fetchImpl: () => new Response("", { status: 429 }) });
  const l = await limited.tool.run({}, { symbol: "SH600519" }, ctx());
  assert.equal(l.ok, false);
  assert.equal(l.error_kind, "rate_limited");
  assert.equal(l.retryable, true);
});

test("超时 → timeout，且在预算内结束", async () => {
  const { tool } = make({
    timeoutMs: 20,
    fetchImpl: (_url, init) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      }),
  });
  const started = Date.now();
  const r = await tool.run({}, { symbol: "SH600519" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "timeout");
  assert.ok(Date.now() - started < 1000);
});

test("同代码 15 s 内只请求一次，跨群共用；过期后重新请求", async () => {
  let n = 0;
  const clock = { t: NOW };
  const { tool } = make({
    now: () => clock.t,
    fetchImpl: () => {
      n++;
      return quoteResponse("sh600519.gbk");
    },
  });
  const first = await tool.run({}, { symbol: "SH600519" }, ctx("GROUP-A"));
  clock.t += 14_999;
  const second = await tool.run({}, { symbol: "600519" }, ctx("GROUP-B"));
  assert.equal(n, 1, "same code within 15s must hit the in-memory cache");
  assert.deepEqual(second, first);
  clock.t += 1;
  const third = await tool.run({}, { symbol: "sh600519" }, ctx("GROUP-A"));
  assert.equal(n, 2, "exactly at the 15s boundary the cache must expire");
  assert.deepEqual(third, first);
});

test("解析边界：可选字段缺失返回 null，价格缺失按上游异常处理", async () => {
  const source = fixture("sh600519.gbk");
  const replaceOnce = (buf, from, to) => {
    const b = Buffer.from(buf);
    const needle = Buffer.from(from, "latin1");
    const at = b.indexOf(needle);
    assert.ok(at >= 0, "fixture must contain " + from);
    return Buffer.concat([b.subarray(0, at), Buffer.from(to, "latin1"), b.subarray(at + needle.length)]);
  };

  const missingChange = make({
    fetchImpl: () => new Response(replaceOnce(source, "~24.99~1.77~", "~~1.77~")),
  });
  const ok = await missingChange.tool.run({}, { symbol: "SH600519" }, ctx());
  assert.equal(ok.ok, true);
  assert.equal(ok.change, null);
  assert.equal(ok.change_pct, 1.77);
  assert.equal(ok.price, 1435.26);

  const missingPrice = make({
    fetchImpl: () => new Response(replaceOnce(source, "~600519~1435.26~", "~600519~~")),
  });
  const bad = await missingPrice.tool.run({}, { symbol: "SH600519" }, ctx());
  assert.equal(bad.ok, false);
  assert.equal(bad.error_kind, "upstream_unavailable");
});

test("_tencent_code 映射：沪深北/港股/美股与拒绝中文", () => {
  const cases = [
    ["SH600519", "sh600519"],
    ["sh600519", "sh600519"],
    ["600519", "sh600519"],
    ["688981", "sh688981"],
    ["000001", "sz000001"],
    ["300750", "sz300750"],
    ["430047", "bj430047"],
    ["920001", "bj920001"],
    ["00700", "hk00700"],
    ["HK00700", "hk00700"],
    ["700", "hk00700"],
    ["60051", "hk60051"],
    ["AAPL", "usAAPL"],
    ["us.AAPL", "usAAPL"],
    ["BRK.B", "usBRK.B"],
  ];
  for (const [input, want] of cases) assert.equal(api.normalizeTencentCode(input), want, input);
  for (const bad of ["茅台", "", "  ", "1234567", "SH60051"]) {
    assert.equal(api.normalizeTencentCode(bad), null, bad);
  }
});

test("工具已注册，untrusted；off:stock_quote 关闭后不发任何请求", async () => {
  const registered = toolkit.findExtraTool("stock_quote");
  assert.ok(registered);
  assert.equal(registered.name, "stock_quote");
  assert.equal(registered.untrusted, true);
  assert.equal(registered.switch, "stock_quote");

  let fetched = 0;
  const old = globalThis.fetch;
  globalThis.fetch = async () => {
    fetched++;
    throw new Error("switched-off tool must not fetch");
  };
  try {
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({ value: "1" }) }) }) };
    const r = await toolkit.runExtraTool({ DB: db }, "stock_quote", { symbol: "SH600519" }, ctx());
    assert.equal(r.unavailable, true);
    assert.equal(r.error_kind, "denied");
  } finally {
    globalThis.fetch = old;
  }
  assert.equal(fetched, 0);
});

test("STOCK_QUOTE_HELP 是一句话常量，工具描述以它开头", () => {
  assert.equal(typeof api.STOCK_QUOTE_HELP, "string");
  assert.ok(api.STOCK_QUOTE_HELP.length > 0);
  assert.ok(!/\n/.test(api.STOCK_QUOTE_HELP));
  assert.ok(registeredDescription(api).startsWith(api.STOCK_QUOTE_HELP));
});

function registeredDescription(mod) {
  return mod.stockQuoteTool.def.function.description;
}
