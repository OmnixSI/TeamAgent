import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

// DS-1 P0: DeepSeek rejects a request whose tool names repeat
// ("Tool names must be unique"), so assert on the exact array the model receives.
// That array is assembled from the core list, repo tools, the F7/F9/F11 registry
// and dynamic MCP discovery — one assertion therefore covers every source. The
// regression was a second spread of extraToolDefs: 49 defs with 17 duplicates.
const fixture = JSON.parse(readFileSync("config/team.json", "utf8"));
fixture.mcp_servers = [
  {
    name: "docs",
    transport: "streamable-http",
    url: "https://mcp.test/mcp",
    enabled: true,
    allow_tools: ["lookup"],
    group_ids: ["GROUP000001"],
    timeout_ms: 5000,
  },
];
await build({
  stdin: {
    contents:
      'export { agentAnswer } from "./src/semantic"; export { EXTRA_TOOLS } from "./src/tools/index"; export { repoTools } from "./src/repo";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: `.wrangler/tool-names-${process.pid}.mjs`,
  plugins: [
    {
      name: "tool-names-fixture",
      setup(builder) {
        builder.onLoad({ filter: /config\/team\.json$/ }, () => ({
          contents: JSON.stringify(fixture),
          loader: "json",
        }));
      },
    },
  ],
});
const api = await import("../.wrangler/tool-names-" + process.pid + ".mjs");

function database() {
  const d = new DatabaseSync(":memory:");
  d.exec(readFileSync("schema.sql", "utf8"));
  return {
    prepare(sql) {
      const statement = (args = []) => ({
        bind(...values) {
          return statement(
            values.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v))
          );
        },
        async first() {
          return d.prepare(sql).get(...args) || null;
        },
        async all() {
          return { results: d.prepare(sql).all(...args) };
        },
        async run() {
          return d.prepare(sql).run(...args);
        },
      });
      return statement();
    },
    async batch(statements) {
      return Promise.all(statements.map((s) => s.run()));
    },
  };
}

function env() {
  return {
    DB: database(),
    DEEPSEEK_API_KEY: "fake",
    WORK: { sent: [], async send() {} },
  };
}

async function context(e) {
  const row = {
    id: "current",
    group_id: "GROUP000001",
    sender: "U1",
    body: "你好",
    ts: new Date().toISOString(),
    mentioned: 1,
    meta: { direct: true, media: [] },
  };
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)"
  )
    .bind(row.id, row.group_id, row.sender, row.body, row.ts, row.mentioned)
    .run();
  return {
    latest: row,
    batch: [row],
    recent: [row],
    names: new Map(),
    refs: new Map(),
    mentioned: true,
  };
}

// Minimal read-only MCP server so the dynamic source is present in the capture.
function mcp(body) {
  const rpc = JSON.parse(body);
  if (rpc.method === "initialize")
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "fake", version: "1" },
        },
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Mcp-Session-Id": "session-1",
        },
      }
    );
  if (rpc.method === "notifications/initialized")
    return new Response(null, { status: 202 });
  if (rpc.method === "tools/list")
    return Response.json({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        tools: [
          {
            name: "lookup",
            description: "read-only lookup",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    });
  return new Response(null, { status: 400 });
}

async function capturedTools() {
  const e = env(),
    ctx = await context(e),
    requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const address = String(url);
    if (address === "https://mcp.test/mcp") return mcp(options.body);
    const body = JSON.parse(options.body);
    requests.push(body);
    if (body.messages?.[0]?.content?.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          {
            message: {
              content: '{"mode":"work","text":"按真实工具结果回答。"}',
            },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            content:
              '{"action":"reply","kind":"direct","brief":"依据真实工具结果回答"}',
          },
        },
      ],
    });
  };
  try {
    await api.agentAnswer(e, ctx);
  } finally {
    globalThis.fetch = original;
  }
  const sent = requests.find((body) => Array.isArray(body.tools) && body.tools.length);
  assert.ok(sent, "agentAnswer must send tools to the model");
  return sent.tools.map((def) => def.function?.name);
}

test("DS1 the tool list sent to the model has unique names from every source", async () => {
  const names = await capturedTools();
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(duplicates, [], `duplicate tool names: ${duplicates.join(", ")}`);
  assert.equal(names.length, new Set(names).size);

  // F7/F9/F11 registry: every registered tool is offered exactly once.
  for (const tool of api.EXTRA_TOOLS) {
    const count = names.filter((n) => n === tool.name).length;
    assert.equal(count, 1, `${tool.name} should be offered exactly once, got ${count}`);
  }
  // Repo tools (separate source).
  for (const def of api.repoTools)
    assert.equal(
      names.filter((n) => n === def.function?.name).length,
      1,
      `${def.function?.name} should be offered exactly once`
    );
  // Core tools and the dynamic MCP tool.
  for (const name of ["get_work_status", "schedule_create", "mcp_docs_lookup"])
    assert.equal(
      names.filter((n) => n === name).length,
      1,
      `${name} should be offered exactly once`
    );
});
