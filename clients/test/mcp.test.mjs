import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { credentials } from "../api.mjs";

test("credentials require an encrypted remote endpoint and an explicit personal token", () => {
  assert.throws(
    () =>
      credentials({
        TEAM_AGENT_URL: "http://public.example",
        TEAM_AGENT_TOKEN: "test",
      }),
    /HTTPS/,
  );
  assert.throws(() => credentials({}), /接入凭证/);
  assert.equal(
    credentials({
      TEAM_AGENT_URL: "https://team.example/",
      TEAM_AGENT_TOKEN: "test",
    }).url,
    "https://team.example",
  );
});

test(
  "a real stdio MCP client can discover tools, claim and report using the member token",
  { timeout: 15000 },
  async () => {
    const calls = [];
    const backend = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      calls.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: body ? JSON.parse(body) : null,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url.startsWith("/api/team/tasks"))
        res.end(
          JSON.stringify({
            who: { name: "hongming" },
            tasks: [{ id: "one", version: 1 }],
          }),
        );
      else
        res.end(
          JSON.stringify({
            ok: true,
            task: {
              id: "one",
              version: req.url.endsWith("claim") ? 2 : 3,
              assignee: "hongming",
            },
          }),
        );
    });
    backend.listen(0, "127.0.0.1");
    await once(backend, "listening");
    const child = spawn(
      process.execPath,
      [new URL("../mcp.mjs", import.meta.url).pathname],
      {
        env: {
          ...process.env,
          TEAM_AGENT_URL: "http://127.0.0.1:" + backend.address().port,
          TEAM_AGENT_TOKEN: "isolated-personal-token",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const pending = new Map();
    let seq = 0,
      stderr = "";
    child.stderr.on("data", (b) => (stderr += b));
    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        message.error
          ? p?.reject(Error(JSON.stringify(message.error)))
          : p?.resolve(message.result);
      }
    });
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        child.stdin.write(
          JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
        );
      });
    try {
      const initialized = await send("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "teamagent-test", version: "1" },
      });
      assert.equal(initialized.serverInfo.name, "teamagent");
      child.stdin.write(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized",
        }) + "\n",
      );
      const { tools } = await send("tools/list", {});
      assert.equal(tools.length, 6);
      assert.ok(tools.find((t) => t.name === "teamagent_claim_task"));
      const listed = await send("tools/call", {
        name: "teamagent_list_tasks",
        arguments: { assignee: "me" },
      });
      assert.equal(JSON.parse(listed.content[0].text).who.name, "hongming");
      const claimed = await send("tools/call", {
        name: "teamagent_claim_task",
        arguments: { id: "one", version: 1 },
      });
      assert.equal(JSON.parse(claimed.content[0].text).task.version, 2);
      await send("tools/call", {
        name: "teamagent_report_task",
        arguments: {
          id: "one",
          version: 2,
          status: "ready_for_review",
          result: "实际验证证据",
        },
      });
      assert.equal(calls.length, 3);
      assert.ok(
        calls.every(
          (c) => c.authorization === "Bearer isolated-personal-token",
        ),
      );
      assert.equal(calls[1].body.version, 1);
      assert.equal(calls[2].body.status, "ready_for_review");
      assert.equal(stderr, "");
    } finally {
      child.kill();
      reader.close();
      backend.closeAllConnections();
      await new Promise((resolve) => backend.close(resolve));
    }
  },
);
