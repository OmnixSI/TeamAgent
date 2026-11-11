import { test } from "node:test";
import assert from "node:assert/strict";
import { worker, env, req, qq, msg } from "./support.mjs";
test("file work yields chat and runs in the tools lane while the deep lane is unavailable", async () => {
  const e = env(),
    sent = [];
  e.CHAT = { async send() {} };
  e.TOOLS = {
    async send(x) {
      sent.push(x.id);
    },
  };
  e.WORK = {
    async send() {
      throw Error("deep lane occupied");
    },
  };
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("file-route", "把这些数据整理成CSV"));
  const original = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.messages[0].content.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          {
            message: {
              content:
                '{"mode":"work","text":"文件任务接下了，结果回到群里。"}',
            },
          },
        ],
      });
    if (b.messages.some((m) => m.role === "tool"))
      return Response.json({
        choices: [
          {
            message: {
              content:
                '{"should_reply":true,"kind":"direct","brief":"资料任务已经实际排队，尚未生成文件。"}',
            },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "create",
                type: "function",
                function: {
                  name: "create_file_task",
                  arguments:
                    '{"title":"CSV","instructions":"生成CSV","request_quote":"把这些数据整理成CSV"}',
                },
              },
            ],
          },
        },
      ],
    });
  };
  try {
    await worker.queue(
      { messages: [{ body: { id: "chat-file-route" }, ack() {} }] },
      e,
    );
    assert.equal(sent.length, 1);
    assert.equal(
      (await e.DB.prepare("SELECT id FROM jobs WHERE kind='media'").all())
        .results.length,
      0,
    );
    await worker.queue({ messages: [{ body: { id: sent[0] }, ack() {} }] }, e);
    assert.equal(
      (await e.DB.prepare("SELECT id FROM jobs WHERE kind='media'").all())
        .results.length,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("CI triage uses concrete annotations, is high effort, and never re-runs the same evidence", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const check = {
    id: 42,
    name: "check",
    head_sha: "abc",
    conclusion: "failure",
    html_url: "https://github.com/OmnixSI/TeamAgent/actions/runs/1",
    evidence: {
      annotations: [
        {
          message:
            "The job was not started because account payments have failed or the spending limit needs to be increased.",
          level: "failure",
        },
      ],
    },
  };
  const body = { repo: "OmnixSI/TeamAgent", context: { checks: [check] } };
  await req(e, "/api/runner/context", body, "runner-secret");
  await req(e, "/api/runner/context", body, "runner-secret");
  const jobs = (
    await e.DB.prepare("SELECT * FROM jobs WHERE kind='ci_triage'").all()
  ).results;
  assert.equal(jobs.length, 1);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u, o) => {
    calls++;
    const b = JSON.parse(o.body);
    assert.equal(b.reasoning_effort, "high");
    if (b.messages[0].content.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          {
            message: {
              content:
                '{"mode":"work","text":"是账户账单或额度限制，job根本没启动；先由管理员核对账户状态。"}',
            },
          },
        ],
      });
    assert.ok(b.messages[1].content.includes("The job was not started"));
    return Response.json({
      choices: [
        {
          message: {
            content:
              "具体annotation表明账户账单或额度受限，job未启动，不能判成代码测试失败。",
          },
        },
      ],
    });
  };
  try {
    await worker.queue(
      { messages: [{ body: { id: jobs[0].id }, ack() {} }] },
      e,
    );
    await worker.queue(
      { messages: [{ body: { id: jobs[0].id }, ack() {} }] },
      e,
    );
    assert.equal(calls, 2);
    assert.match(
      (await e.DB.prepare("SELECT body FROM discoveries").first()).body,
      /job未启动/,
    );
  } finally {
    globalThis.fetch = original;
  }
});
