import { test } from "node:test";
import assert from "node:assert/strict";
import { worker, env, req } from "./support.mjs";
async function members(e) {
  const names = ["hongming", "jinxiang", "jinyi"];
  assert.equal(
    (
      await req(e, "/api/admin/name-members", {
        members: names.map((name) => ({ name, password: name })),
      })
    ).status,
    200,
  );
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => {
        const r = await req(
          e,
          "/api/team/login-name",
          { password: " " + name.toUpperCase() + " " },
          "",
        );
        assert.equal(r.status, 200);
        const value = await r.json();
        assert.equal(value.who.name, name);
        assert.equal(value.who.role, "member");
        return [name, value.token];
      }),
    ),
  );
}
async function task(e, title = "协作验收") {
  const { id } = await (
    await req(e, "/api/team/task", { repo: "OmnixSI/TeamAgent", title })
  ).json();
  return id;
}
test("runtime reload quiesces new claims and refuses to restart over running work", async () => {
  const e = env();
  const id = await task(e);
  await req(
    e,
    "/api/team/task",
    { id, version: 1, status: "queued" },
    undefined,
    "PATCH",
  );
  assert.equal((await req(e, "/api/runner/idle", {}, "bad")).status, 401);
  assert.equal(
    (
      await (
        await req(e, "/api/runner/idle", { quiesce: true }, "runner-secret")
      ).json()
    ).idle,
    true,
  );
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json())
      .task,
    null,
  );
  await req(e, "/api/runner/idle", { resume: true }, "runner-secret");
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json()).task
      .id,
    id,
  );
  assert.equal(
    (
      await (
        await req(e, "/api/runner/idle", { quiesce: true }, "runner-secret")
      ).json()
    ).idle,
    false,
  );
  assert.equal(
    (
      await e.DB.prepare(
        "SELECT value FROM settings WHERE key='runner_pause_until'",
      ).first()
    ).value,
    "0",
  );
});
test("three case-insensitive named identities share data without admin privileges or legacy login", async () => {
  const e = env(),
    keys = await members(e),
    id = await task(e);
  for (const [name, key] of Object.entries(keys)) {
    const state = await (await req(e, "/api/team/state", null, key)).json();
    assert.equal(state.who.name, name);
    assert.deepEqual(
      state.tasks.map((t) => t.id),
      [id],
    );
    assert.deepEqual(
      state.teammates.map((m) => m.name),
      ["hongming", "jinxiang", "jinyi"],
    );
    assert.ok(!JSON.stringify(state).includes("password_hash"));
    assert.equal((await req(e, "/api/admin/pair", {}, key)).status, 403);
    assert.equal(
      (await req(e, "/api/team/profile", { name: "other" }, key, "PATCH"))
        .status,
      400,
    );
  }
  assert.equal(
    (await req(e, "/api/team/login-name", { password: "nobody" }, "")).status,
    401,
  );
  assert.equal((await req(e, "/api/team/login/start", {}, "")).status, 410);
  assert.equal(
    (await req(e, "/api/team/join", { invite: "old" }, "")).status,
    410,
  );
  await req(e, "/api/admin/revoke", { id: "name:jinyi" });
  assert.equal((await req(e, "/api/team/state", null, keys.jinyi)).status, 401);
  assert.equal(
    (await req(e, "/api/team/login-name", { password: "JINYI" }, "")).status,
    403,
  );
  await req(e, "/api/admin/restore", { id: "name:jinyi" });
  assert.equal((await req(e, "/api/team/state", null, keys.jinyi)).status, 401);
  assert.equal(
    (await req(e, "/api/team/login-name", { password: "jinyi" }, "")).status,
    200,
  );
});
test("concurrent claims have one winner, shared attribution and one durable praise notice", async () => {
  const e = env(),
    keys = await members(e),
    id = await task(e);
  const attempts = await Promise.all(
    ["jinxiang", "jinyi"].map((n) =>
      req(e, "/api/team/task/claim", { id, version: 1 }, keys[n]),
    ),
  );
  assert.deepEqual(attempts.map((r) => r.status).sort(), [200, 409]);
  const winner = (await (await req(e, "/api/team/task?id=" + id)).json()).task;
  assert.ok(["jinxiang", "jinyi"].includes(winner.assignee));
  assert.equal(winner.status, "in_progress");
  assert.equal(winner.version, 2);
  assert.equal(winner.lease, undefined);
  const retry = await (
    await req(
      e,
      "/api/team/task/claim",
      { id, version: 1 },
      keys[winner.assignee],
    )
  ).json();
  assert.equal(retry.already, true);
  assert.equal(
    (await req(e, "/api/team/task/claim", { id, version: 2 }, keys.hongming))
      .status,
    409,
  );
  assert.equal(
    (await e.DB.prepare("SELECT COUNT(*) AS n FROM task_claims").first()).n,
    1,
  );
  assert.equal(
    (
      await e.DB.prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE kind='claim_notice'",
      ).first()
    ).n,
    1,
  );
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const original = globalThis.fetch,
    prompts = [];
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              mode: "work",
              text: "主动扛活这波可以！",
            }),
          },
        },
      ],
    });
  };
  try {
    const job = { body: { id: "claim-" + id + "-v2" }, ack() {} };
    await worker.queue({ messages: [job] }, e);
    await worker.queue({ messages: [job] }, e);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].reasoning_effort, "high");
  const notices = (await e.DB.prepare("SELECT body FROM outbox").all()).results;
  assert.equal(notices.length, 1);
  assert.ok(notices[0].body.includes(winner.assignee));
  assert.ok(notices[0].body.includes("「协作验收」"));
});
test("claim attribution still reaches the group when the voice provider fails", async () => {
  const e = env(),
    keys = await members(e),
    id = await task(e, "模型断连仍报领取人");
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await req(e, "/api/team/task/claim", { id, version: 1 }, keys.jinyi);
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  try {
    await worker.queue(
      { messages: [{ body: { id: "claim-" + id + "-v2" }, ack() {} }] },
      e,
    );
  } finally {
    globalThis.fetch = original;
  }
  const row = await e.DB.prepare("SELECT status,body FROM outbox").first();
  assert.equal(row.status, "pending");
  assert.ok(row.body.includes("jinyi接手了「模型断连仍报领取人」"));
});
test("local AI tokens can claim and report their own work, cannot administer, impersonate or approve completion", async () => {
  const e = env(),
    keys = await members(e),
    id = await task(e);
  const key = await (
    await req(e, "/api/team/ai-tokens", { label: "隔离MCP验收" }, keys.hongming)
  ).json();
  assert.ok(key.token.startsWith("teamai_"));
  const listing = await (
    await req(e, "/api/team/ai-tokens", null, keys.hongming)
  ).json();
  assert.ok(!JSON.stringify(listing).includes(key.token));
  assert.ok(!JSON.stringify(listing).includes("token_hash"));
  for (const path of [
    "/api/admin/pair",
    "/api/team/ai-tokens",
    "/api/team/fact",
  ]) {
    assert.equal((await req(e, path, {}, key.token)).status, 403);
  }
  assert.equal((await req(e, "/api/runner/claim", {}, key.token)).status, 401);
  const claimed = await (
    await req(e, "/api/team/task/claim", { id, version: 1 }, key.token)
  ).json();
  assert.equal(claimed.task.assignee, "hongming");
  assert.equal(
    (await e.DB.prepare("SELECT actor_type FROM task_claims").first())
      .actor_type,
    "ai",
  );
  assert.equal(
    (
      await req(
        e,
        "/api/team/task/report",
        { id, version: 2, status: "done", result: "claimed done" },
        key.token,
      )
    ).status,
    400,
  );
  const report = {
    id,
    version: 2,
    status: "ready_for_review",
    result: "实际修改与验证结果；等待成员确认",
  };
  const reported = await (
    await req(e, "/api/team/task/report", report, key.token)
  ).json();
  assert.equal(reported.task.version, 3);
  assert.equal(reported.task.status, "ready_for_review");
  assert.equal(
    (await req(e, "/api/team/task/report", report, key.token)).status,
    409,
  );
  const other = await task(e, "别人正在做");
  await req(e, "/api/team/task/claim", { id: other, version: 1 }, keys.jinyi);
  assert.equal(
    (await req(e, "/api/team/task/report", { ...report, id: other }, key.token))
      .status,
    409,
  );
  const proposal = await (
    await req(
      e,
      "/api/team/task",
      {
        repo: "OmnixSI/TeamAgent",
        title: "AI建议",
        assignee: "jinyi",
        plan: true,
      },
      key.token,
    )
  ).json();
  const created = await (
    await req(e, "/api/team/task?id=" + proposal.id, null, key.token)
  ).json();
  assert.equal(created.task.status, "proposal");
  assert.equal(created.task.assignee, "");
  assert.equal(created.plan, null);
  await req(e, "/api/team/ai-tokens", { id: key.id }, keys.jinyi, "DELETE");
  assert.equal((await req(e, "/api/team/tasks", null, key.token)).status, 200);
  await req(e, "/api/team/ai-tokens", { id: key.id }, keys.hongming, "DELETE");
  assert.equal((await req(e, "/api/team/tasks", null, key.token)).status, 401);
});
test("all synchronized organization projects expose latest commit and author links", async () => {
  const e = env();
  const head = {
    sha: "a".repeat(40),
    url: "https://github.com/OmnixSI/NewProject/commit/" + "a".repeat(40),
    message: "改进项目",
    at: "2026-11-11T00:00:00Z",
    author: {
      name: "队友",
      login: "teammate",
      url: "https://github.com/teammate",
    },
  };
  assert.equal(
    (
      await req(
        e,
        "/api/runner/context",
        { repo: "OmnixSI/NewProject", context: { head, readme: "资料" } },
        "runner-secret",
      )
    ).status,
    200,
  );
  const s = await (await req(e, "/api/team/state")).json();
  assert.deepEqual(JSON.parse(s.projects[0].head), head);
  const p = await (
    await req(e, "/api/team/project?repo=OmnixSI%2FNewProject")
  ).json();
  assert.deepEqual(p.context.head, head);
});
