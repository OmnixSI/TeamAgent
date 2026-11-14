import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { env } from "./support.mjs";

const outfile = `.wrangler/ds-balance-replay-${process.pid}.mjs`;
await build({
  entryPoints: ["src/semantic.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
});
const { agentAnswer, LOCAL_TOOLS } = await import("../" + outfile);
rmSync(outfile);

// Real group message read once from the online messages table (read-only):
// 2026-11-12 17:46:11 +08:00, body "查下你的api额度". No id or group is copied.
const REAL_QUESTION = "查下你的api额度";
const GROUP = "GROUP000001";

test("the quota tool answers inline instead of being queued as a research job", () => {
  assert.ok(LOCAL_TOOLS.has("get_quota"));
});

test("a real group question replays in an isolated local database", async () => {
  const e = env();
  const row = {
    id: "replay-quota-1",
    group_id: GROUP,
    sender: "U1",
    body: REAL_QUESTION,
    ts: new Date().toISOString(),
    mentioned: 1,
    meta: { direct: true, memberRole: "owner" },
  };
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)",
  )
    .bind(row.id, row.group_id, row.sender, row.body, row.ts, 1)
    .run();
  await e.DB.prepare("INSERT INTO message_meta VALUES(?,?)")
    .bind(row.id, JSON.stringify(row.meta))
    .run();
  const context = {
    latest: row,
    batch: [row],
    recent: [row],
    names: new Map(),
    refs: new Map(),
    mentioned: true,
    background: false,
  };

  const calls = [];
  const old = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const target = String(url);
    if (target === "https://api.deepseek.com/user/balance") {
      calls.push("balance");
      return Response.json({
        is_available: true,
        balance_infos: [
          {
            currency: "CNY",
            total_balance: "8.88",
            granted_balance: "2.00",
            topped_up_balance: "6.88",
          },
        ],
      });
    }
    assert.equal(target, "https://api.deepseek.com/chat/completions", "本地回放只允许模型与假余额接口");
    const body = JSON.parse(init.body);
    calls.push("model");
    if (String(body.messages[0]?.content || "").includes("最后的嘴替模块")) {
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: "work",
                text: "DeepSeek 里还有 ¥8.88，其中赠送 ¥2.00、充值 ¥6.88。这是第一次记录，以后我再回答就能告诉你比上次多了还是少了。",
              }),
            },
          },
        ],
      });
    }
    const sawTool = body.messages.some((message) => message.role === "tool");
    if (!sawTool) {
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "quota-replay-1",
                  type: "function",
                  function: { name: "get_quota", arguments: "{}" },
                },
              ],
            },
          },
        ],
      });
    }
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              action: "reply",
              kind: "direct",
              brief: "余额已经查到了，按工具结果回答。",
            }),
          },
        },
      ],
    });
  };

  try {
    const raw = await agentAnswer(e, context);
    const answer = JSON.parse(raw);
    assert.equal(answer.mode, "work");
    assert.match(answer.text, /DeepSeek 里还有 ¥8\.88/);
    assert.match(answer.text, /这是第一次记录/);

    const snapshots = (
      await e.DB.prepare(
        "SELECT scope,currency,total_balance,granted_balance,topped_up_balance FROM ds_balance_snapshots",
      ).all()
    ).results;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].scope, "global");
    assert.equal(snapshots[0].currency, "CNY");
    assert.equal(snapshots[0].total_balance, "8.88");
    assert.equal(snapshots[0].granted_balance, "2.00");
    assert.equal(snapshots[0].topped_up_balance, "6.88");
    assert.equal(calls.filter((kind) => kind === "balance").length, 1);
    assert.equal(e.WORK.sent.length, 0, "回放不得往群里发消息");
    assert.equal(
      (await e.DB.prepare("SELECT COUNT(*) n FROM jobs WHERE kind='research'").first()).n,
      0,
      "简单余额查询不应排成后台检索",
    );
    console.log(
      `真实群消息「${REAL_QUESTION}」本地独立 SQLite 回放：余额与首次记录文案正确；QQ 真实发送 0 次、线上 D1 写入 0 行`,
    );
  } finally {
    globalThis.fetch = old;
  }
});
