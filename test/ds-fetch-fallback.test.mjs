import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// semantic.ts 的回退链：Jina 失败后先用既有 DeepSeek fetch，全部失败才走 fetch_page 同一内部函数。
const outfile = `.wrangler/f9ds-4-semantic-${process.pid}.mjs`;
await build({ entryPoints: ["src/semantic.ts"], bundle: true, format: "esm", platform: "browser", outfile });
const { readUrl } = await import("../" + outfile);

const LONG = "这是一篇可以正常读取的公开网页正文，用来验证回退链。".repeat(30);

async function withFetch(handler, run) {
  const old = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    return handler(url, init, calls);
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = old;
  }
}

const jinaFail = () => new Response("", { status: 429 });
const fetchCalls = (calls) => calls.filter((u) => u.includes("/v1/tools/fetch")).length;

test("现有读取成功（Jina）时绝不调用 fetch 回退", async () => {
  await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? new Response("Title: 正常页面\nMarkdown Content:\n" + LONG) : new Response("", { status: 500 })),
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/ok", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, true);
      assert.equal(r.source, "jina");
      assert.equal(fetchCalls(calls), 0);
    },
  );
});

test("既有 DeepSeek fetch 成功时不再走最后一级回退", async () => {
  await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? jinaFail() : Response.json({ content: LONG })),
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/ds", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, true);
      assert.equal(r.source, "deepseek");
      assert.equal(fetchCalls(calls), 1);
    },
  );
});

test("既有链全失败时 fetch_page 兜底成功，source=deepseek_fetch", async () => {
  await withFetch(
    (url, init, calls) => {
      if (url.startsWith("https://r.jina.ai/")) return jinaFail();
      return Response.json({ content: fetchCalls(calls) === 1 ? "" : "# 兜底正文\n" + LONG });
    },
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/fallback", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, true);
      assert.equal(r.source, "deepseek_fetch");
      assert.match(r.text, /兜底正文/);
      assert.equal(fetchCalls(calls), 2);
    },
  );
});

test("非 research 用途（inline）不调用云端回退", async () => {
  await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? jinaFail() : Response.json({ content: LONG })),
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/inline", { purpose: "inline", deadline: Date.now() + 3000 });
      assert.equal(r.ok, false);
      assert.equal(fetchCalls(calls), 0);
    },
  );
});

test("既有链返回短正文时保持原行为（source=deepseek），不回退", async () => {
  await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? jinaFail() : Response.json({ content: "短正文".repeat(20) })),
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/short", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, true);
      assert.equal(r.source, "deepseek");
      assert.equal(fetchCalls(calls), 1);
    },
  );
});

test("回退 403 URL access denied 映射为 login_required，如实失败", async () => {
  await withFetch(
    (url, init, calls) => {
      if (url.startsWith("https://r.jina.ai/")) return jinaFail();
      return fetchCalls(calls) === 1
        ? Response.json({ content: "" })
        : Response.json({ error: { message: "URL access denied" } }, { status: 403 });
    },
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://example.com/denied", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, false);
      assert.equal(r.reason, "login_required");
      assert.equal(fetchCalls(calls), 2);
    },
  );
});

test("B 站链接不走 fetch_page：回退校验直接拒绝，不额外发请求", async () => {
  await withFetch(
    (url) => (url.startsWith("https://r.jina.ai/") ? jinaFail() : Response.json({ content: "" })),
    async (calls) => {
      const r = await readUrl({ DEEPSEEK_API_KEY: "fake" }, "https://www.bilibili.com/video/BV1xx411c7mD", { purpose: "research", deadline: Date.now() + 15000 });
      assert.equal(r.ok, false);
      assert.equal(fetchCalls(calls), 1); // 只有既有链那一次
    },
  );
});
