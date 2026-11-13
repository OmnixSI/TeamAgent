import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/resend-outbox.mjs", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

async function stub(responder) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      const parsed = body ? JSON.parse(body) : {};
      seen.push({ url: req.url, body: parsed });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responder(parsed)));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("resend-outbox defaults to a dry run and prints the content that would be sent", async () => {
  const s = await stub(() => ({
    dry_run: true,
    id: "media-result-msg34",
    status: "failed",
    created_at: 1794386441467,
    age_ms: 259_200_000,
    stale: true,
    group_id: "GROUP000001",
    msg_id: "msg34",
    body: "任务已完成，表格文件已生成。\n已生成文件：项目状态示例数据.csv",
    body_bytes: 1609,
    expected: "1 条群文本消息；无附件",
    eligible: true,
  }));
  try {
    const result = await run(["media-result-msg34"], {
      INKBOARD_TEAM_URL: s.url,
      INKBOARD_TEAM_ADMIN_TOKEN: "owner-secret",
    });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /DRY RUN/);
    assert.match(result.out, /media-result-msg34/);
    assert.match(result.out, /项目状态示例数据\.csv/);
    assert.match(result.out, /1 条群文本消息；无附件/);
    assert.doesNotMatch(result.out, /owner-secret/);
    assert.deepEqual(s.seen, [{ url: "/api/team/outbox/resend", body: { id: "media-result-msg34", confirm: false } }]);
  } finally {
    await s.close();
  }
});

test("resend-outbox only queues a send with an explicit --confirm", async () => {
  const s = await stub(() => ({ ok: true, queued: true, id: "media-result-msg34", status: "pending" }));
  try {
    const result = await run(["media-result-msg34", "--confirm"], {
      INKBOARD_TEAM_URL: s.url,
      INKBOARD_TEAM_ADMIN_TOKEN: "owner-secret",
    });
    assert.equal(result.code, 0, result.err);
    assert.match(result.out, /已入队|pending/);
    assert.deepEqual(s.seen, [{ url: "/api/team/outbox/resend", body: { id: "media-result-msg34", confirm: true } }]);
  } finally {
    await s.close();
  }
});

test("resend-outbox refuses to run without an outbox id", async () => {
  const result = await run([]);
  assert.equal(result.code, 1);
  assert.match(result.err, /用法/);
});
