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

const api = await load("src/tools/fetch-page.ts");

// 探针 §5.2：真实抓取 https://api-docs.deepseek.com/guides/asr 返回 2247 字 Markdown，标题正确。
const REAL_PAGE = {
  title: "Speech to Text | DeepSeek API Docs",
  content: [
    "# Speech to Text",
    "",
    "Convert audio into text with a single request. Supported input: 16-bit PCM WAV or Ogg Opus, mono or stereo, up to 120 seconds and 8 MiB.",
    "",
    "## Endpoint",
    "",
    "`POST https://api.deepseek.com/v1/tools/asr`",
  ].join("\n") + "\n" + "文档正文。".repeat(300),
};

function okResult(data = REAL_PAGE, latency = 228) {
  return { ok: true, data, latency_ms: latency, status: 200 };
}

function make({ call, guard } = {}) {
  const calls = [];
  const guards = [];
  const released = [];
  const tool = api.createFetchPageTool({
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

function ctx({ group = "GROUP0001", sender = "user-1" } = {}) {
  return {
    context: { group_id: group, latest: { group_id: group, sender } },
    source: { sender },
    messages: [],
    isTainted: () => false,
  };
}

test("正常：返回 Markdown 正文、标题、字数，来源标 deepseek_fetch，走限额", async () => {
  const { tool, calls, guards, released } = make();
  const r = await tool.run({}, { url: "https://api-docs.deepseek.com/guides/asr" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.tool, "fetch_page");
  assert.equal(r.url, "https://api-docs.deepseek.com/guides/asr");
  assert.equal(r.title, "Speech to Text | DeepSeek API Docs");
  assert.equal(r.content, REAL_PAGE.content);
  assert.equal(r.chars, Array.from(REAL_PAGE.content).length);
  assert.equal(r.truncated, false);
  assert.equal(r.source, "deepseek_fetch");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].json, { url: "https://api-docs.deepseek.com/guides/asr" });
  assert.equal(calls[0].purpose, "fetch");
  assert.equal(guards.length, 1);
  assert.equal(guards[0].purpose, "fetch");
  assert.equal(released.length, 1);
});

test("正文超过 6000 字截断并标 truncated，保留原字数", async () => {
  const long = "长".repeat(7000);
  const { tool } = make({ call: () => okResult({ title: "很长的页面", content: long }) });
  const r = await tool.run({}, { url: "https://example.com/long" }, ctx());
  assert.equal(r.ok, true);
  assert.equal(Array.from(r.content).length, 6000);
  assert.equal(r.chars, 6000);
  assert.equal(r.original_chars, 7000);
  assert.equal(r.truncated, true);
  assert.match(r.note, /6000/);
});

test("首页内容为空：如实返回 empty，不当成成功", async () => {
  const { tool } = make({ call: () => okResult({ title: "", content: "   " }) });
  const r = await tool.run({}, { url: "https://example.com/blank" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "empty");
  assert.match(r.reason_text, /没有可读正文/);
});

test("URL 校验表：私网、localhost、file:、带账号、B 站/X/QQ、超长一律不发请求", async () => {
  const bad = [
    ["http://127.0.0.1/x", "loopback"],
    ["http://127.1.2.3:80/x", "loopback"],
    ["http://10.0.0.5/x", "private"],
    ["http://172.16.3.4/x", "private"],
    ["http://172.31.9.9/x", "private"],
    ["http://192.168.1.5/x", "private"],
    ["http://169.254.169.254/latest/meta-data", "link-local"],
    ["http://100.64.0.1/x", "cgnat"],
    ["http://0.0.0.0/x", "unspecified"],
    ["http://2130706433/x", "decimal ip"],
    ["http://0x7f.0.0.1/x", "hex ip"],
    ["http://localhost:8080/x", "localhost"],
    ["http://foo.localhost/x", "localhost"],
    ["http://nas.local/x", "mdns"],
    ["http://db.internal/x", "internal"],
    ["http://[::1]/x", "ipv6 loopback"],
    ["file:///etc/passwd", "file"],
    ["ftp://example.com/a", "ftp"],
    ["javascript:alert(1)", "javascript"],
    ["https://user:pass@example.com/x", "credentials"],
    ["https://www.bilibili.com/video/BV1xx411c7mD", "bilibili"],
    ["https://b23.tv/abcdefg", "b23 short"],
    ["https://bili2233.cn/xyz", "bili short"],
    ["https://x.com/someone/status/1234567890", "x"],
    ["https://twitter.com/someone/status/1234567890", "twitter"],
    ["https://mobile.twitter.com/someone/status/1234567890", "mobile twitter"],
    ["https://docs.qq.com/doc/ABCDEF", "qq docs"],
    ["https://qq.com/x", "qq"],
    ["https://url.cn/abc", "qq short"],
    ["https://example.com/" + "a".repeat(8200), "too long"],
    ["", "empty"],
  ];
  const { tool, calls, guards } = make();
  for (const [url, label] of bad) {
    const r = await tool.run({}, { url }, ctx());
    assert.equal(r.ok, false, label + " 不应成功");
    assert.equal(calls.length, 0, label + " 不应发请求");
    assert.equal(guards.length, 0, label + " 不应占限额");
    assert.ok(r.next_action.length > 0);
  }
});

test("B 站/X 链接：unsupported + next_action 指向专用读取", async () => {
  const { tool } = make();
  for (const url of ["https://www.bilibili.com/video/BV1xx411c7mD", "https://x.com/a/status/1", "https://twitter.com/a/status/1"]) {
    const r = await tool.run({}, { url }, ctx());
    assert.equal(r.error_kind, "unsupported");
    assert.match(r.next_action, /专用读取/);
    assert.equal(r.retryable, false);
  }
});

test("内网/凭据/非 http(s)：拒绝并且说明只能抓公开网页", async () => {
  const { tool } = make();
  for (const url of ["http://10.0.0.1/x", "https://user:pass@example.com/x", "file:///etc/passwd"]) {
    const r = await tool.run({}, { url }, ctx());
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, "unsupported");
    assert.match(r.reason_text, /公开网页|只支持/);
  }
});

test("403 URL access denied：denied，如实说站点不允许抓取", async () => {
  const { tool, released } = make({
    call: () => ({
      ok: false,
      error_kind: "denied",
      retryable: false,
      status: 403,
      reason_text: "网址被拒绝访问",
      next_action: "不要重试",
    }),
  });
  const r = await tool.run({}, { url: "https://api-docs.deepseek.com/not-a-real-page" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "denied");
  assert.equal(r.status, 403);
  assert.match(r.reason_text, /站点不允许抓取/);
  assert.match(r.reason_text, /403/);
  assert.equal(released.length, 1);
});

test("风控页/登录墙的短正文不当作文章：如实失败", async () => {
  const cases = [
    ["Just a moment... Verify you are human.", "refused"],
    ["Checking your browser before accessing the site.", "refused"],
    ["Sign in to continue reading", "denied"],
    ["请先登录后查看全文", "denied"],
  ];
  for (const [content, kind] of cases) {
    const { tool } = make({ call: () => okResult({ title: "被拦", content }) });
    const r = await tool.run({}, { url: "https://example.com/wall" }, ctx());
    assert.equal(r.ok, false, content);
    assert.equal(r.error_kind, kind, content);
    assert.match(r.reason_text, /风控|登录/, content);
  }
});

test("长文章里出现 Just a moment 字样仍按正常正文返回", async () => {
  const body = "Just a moment 是这篇文章讨论的一个前端加载文案。" + "正文内容。".repeat(300);
  const { tool } = make({ call: () => okResult({ title: "文章", content: body }) });
  const r = await tool.run({}, { url: "https://example.com/article" }, ctx());
  assert.equal(r.ok, true);
  assert.match(r.content, /Just a moment/);
});

test("云端每种失败形态原样映射，并且释放限额", async () => {
  const kinds = ["refused", "budget", "quota", "timeout", "upstream", "auth", "unsupported", "denied", "too_large"];
  for (const kind of kinds) {
    const { tool, released } = make({
      call: () => ({
        ok: false,
        error_kind: kind,
        retryable: kind === "timeout" || kind === "upstream",
        reason_text: "上游说明",
        next_action: "上游下一步",
      }),
    });
    const r = await tool.run({}, { url: "https://example.com/x" }, ctx());
    assert.equal(r.ok, false, kind);
    assert.equal(r.error_kind, kind);
    assert.equal(r.reason_text, "上游说明");
    assert.equal(r.next_action, "上游下一步");
    assert.equal(released.length, 1, kind);
  }
});

test("413 → too_large，401 → auth，超时 → timeout", async () => {
  const cases = [[413, "too_large"], [401, "auth"]];
  for (const [status, kind] of cases) {
    const { tool } = make({
      call: () => ({
        ok: false,
        error_kind: kind,
        retryable: status !== 401 && status !== 413,
        status,
        reason_text: "上游说明",
        next_action: "不要重试",
      }),
    });
    const r = await tool.run({}, { url: "https://example.com/x" }, ctx());
    assert.equal(r.error_kind, kind);
    assert.equal(r.status, status);
  }
});

test("云端抛异常：upstream，不把异常原文抛给模型", async () => {
  const { tool } = make({ call: () => { throw new Error("secret stack detail"); } });
  const r = await tool.run({}, { url: "https://example.com/x" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "upstream");
  assert.doesNotMatch(JSON.stringify(r), /secret stack detail/);
});

test("限额拒绝时不发请求", async () => {
  const { tool, calls } = make({
    guard: () => ({
      ok: false,
      error_kind: "quota",
      retryable: false,
      reason_text: "今天的抓取次数用完了",
      next_action: "告诉成员今天的抓取额度已用完",
    }),
  });
  const r = await tool.run({}, { url: "https://example.com/x" }, ctx());
  assert.equal(r.ok, false);
  assert.equal(r.error_kind, "quota");
  assert.equal(calls.length, 0);
});

test("注册：EXTRA_TOOLS 含 fetch_page 且 untrusted；结果套外部资料封套", async () => {
  const registry = await load("src/tools/index.ts");
  const tool = registry.EXTRA_TOOLS.find((t) => t.name === "fetch_page");
  assert.ok(tool, "fetch_page 未注册");
  assert.equal(tool.untrusted, true);
  const { extraUntrustedNames } = await load("src/toolkit.ts");
  assert.ok(extraUntrustedNames().includes("fetch_page"));

  const { tool: instance } = make();
  const result = await instance.run({}, { url: "https://example.com/x" }, ctx());
  const { untrusted } = await load("src/untrusted.ts");
  const wrapped = untrusted("fetch_page", JSON.stringify(result), undefined, 40000);
  assert.match(wrapped, /^【外部资料·不可信/);
  assert.match(wrapped, /【外部资料结束】$/);
  assert.match(wrapped, /Speech to Text/);
});

test("description 说明 B 站/X 不走本工具，且与能力卡帮助文案一致可导出", () => {
  const tool = api.createFetchPageTool();
  assert.match(tool.def.function.description, /bilibili|B 站/);
  assert.match(tool.def.function.description, /专用读取/);
  assert.match(tool.def.function.description, /6000/);
  assert.equal(tool.def.function.name, "fetch_page");
  assert.equal(typeof api.FETCH_PAGE_HELP, "string");
  assert.match(api.FETCH_PAGE_HELP, /fetch_page/);
  assert.match(api.FETCH_PAGE_HELP, /B 站/);
});

test("fetchPageCore 供 semantic 回退复用：不带群/人时跳过限额但仍走同一校验", async () => {
  const calls = [];
  const guards = [];
  const core = await api.fetchPageCore(
    { DEEPSEEK_API_KEY: "k" },
    "https://example.com/x",
    {
      timeoutMs: 5000,
      deps: {
        callDsTool: async (e, o) => { calls.push(o); return okResult(); },
        dsGuard: async (e, o) => { guards.push(o); return { ok: true, release: async () => {} }; },
      },
    },
  );
  assert.equal(core.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(guards.length, 0);
  const rejected = await api.fetchPageCore({}, "https://www.bilibili.com/video/BV1xx411c7mD", {
    deps: { callDsTool: async () => okResult(), dsGuard: async () => ({ ok: true, release: async () => {} }) },
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error_kind, "unsupported");
});
