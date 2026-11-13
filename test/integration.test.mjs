import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { worker, env, req, qq, msg } from "./support.mjs";
test("anonymous denied and owner secret never returned", async () => {
  const e = env();
  assert.equal((await req(e, "/api/team/state", null, "bad")).status, 401);
  const s = await (await req(e, "/api/team/state")).text();
  assert.ok(!s.includes(e.ADMIN_TOKEN));
});
test("public Chinese guide stays readable while anonymous state, task and source remain private", async () => {
  const e = env(),
    anonymous = "",
    privateMessage = "只对群成员可见的原始消息 · 9f2a",
    privateTitle = "只对群成员可见的任务标题 · 7c1d",
    privateDetail = "只对群成员可见的验收细节 · 4b8e",
    credentials = [e.ADMIN_TOKEN, e.RUNNER_TOKEN, e.QQ_APP_SECRET],
    ts = new Date().toISOString();
  await e.DB.prepare(
    "INSERT INTO messages(id,group_id,sender,body,ts) VALUES(?,?,?,?,?)",
  )
    .bind("example", "GROUP000001", "member1", privateMessage, ts)
    .run();
  await e.DB.prepare(
    "INSERT INTO tasks(id,repo,title,detail,status,version,result,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "example",
      "OmnixSI/TeamAgent",
      privateTitle,
      privateDetail,
      "proposal",
      1,
      "",
      ts,
      ts,
    )
    .run();

  const guideResponse = await req(e, "/api/team/guide", null, anonymous);
  assert.equal(guideResponse.status, 200);
  assert.match(
    guideResponse.headers.get("content-type") || "",
    /application\/json/,
  );
  const { guide } = await guideResponse.json();
  assert.equal(typeof guide, "string");
  assert.match(guide, /做 AI 高手/);
  assert.match(guide, /群机器人使用说明/);
  assert.match(guide, /第一次登录/);
  assert.match(guide, /[\u4e00-\u9fff]{4,}/);
  for (const secret of credentials)
    assert.ok(!guide.includes(secret), "public guide leaked a credential");

  for (const [path, label] of [
    ["/api/team/state", "state"],
    ["/api/team/task?id=example", "task"],
    ["/api/team/source?id=example", "source"],
  ]) {
    const response = await req(e, path, null, anonymous),
      body = await response.text();
    assert.equal(response.status, 401, `${label} must require login`);
    for (const hidden of [privateMessage, privateTitle, privateDetail])
      assert.ok(!body.includes(hidden), `${label} leaked private content`);
    for (const secret of credentials)
      assert.ok(!body.includes(secret), `${label} leaked a credential`);
  }

  const source = await (await req(e, "/api/team/source?id=example")).json();
  assert.equal(source.body, privateMessage);
  const task = await (await req(e, "/api/team/task?id=example")).json();
  assert.equal(task.task.title, privateTitle);
  assert.equal(task.task.detail, privateDetail);
});
test("invitation single use, member cannot administer, revocation immediate", async () => {
  const e = env();
  const { invite } = await (
    await req(e, "/api/admin/invite", { name: "张三" })
  ).json();
  const { token } = await (
    await req(e, "/api/team/join", { invite }, "")
  ).json();
  assert.equal((await req(e, "/api/team/join", { invite }, "")).status, 403);
  assert.equal((await req(e, "/api/admin/pair", {}, token)).status, 403);
  const s = await (await req(e, "/api/team/state", null, token)).json();
  await req(e, "/api/admin/revoke", { id: s.who.id });
  assert.equal((await req(e, "/api/team/state", null, token)).status, 401);
  await req(e, "/api/admin/restore", { id: s.who.id });
  assert.equal(
    (await req(e, "/api/team/state", null, token)).status,
    401,
    "restoring access must not revive a revoked credential",
  );
});
test("webhook verification, pairing, group isolation, duplicates and explicit dispatch", async () => {
  const e = env();
  const { code } = await (await req(e, "/api/admin/pair", {})).json();
  await qq(e, msg("bind", "/绑定 " + code));
  await qq(e, msg("one", "/开工 WhalePartner 修复测试"));
  await qq(e, msg("one", "/开工 WhalePartner 修复测试"));
  await qq(e, msg("other", "/开工 WhalePartner 偷渡", "OTHERGROUP"));
  await qq(e, {
    ...msg("quote", "/开工 WhalePartner 引用"),
    msg_elements: [{ content: "引用" }],
  });
  const s = await (await req(e, "/api/team/state")).json();
  assert.equal(s.tasks.length, 1);
  assert.equal(s.tasks[0].status, "queued");
  assert.ok(s.connection.fullMessageVerified);
  assert.equal(
    (
      await worker.fetch(
        new Request("https://team.example/api/qq/events", {
          method: "POST",
          body: JSON.stringify({ op: 0 }),
        }),
        e,
      )
    ).status,
    401,
  );
});
test("optimistic task updates do not overwrite human decisions", async () => {
  const e = env();
  const { id } = await (
    await req(e, "/api/team/task", {
      repo: "OmnixSI/WhalePartner",
      title: "test",
    })
  ).json();
  assert.equal(
    (
      await req(
        e,
        "/api/team/task",
        { id, version: 1, status: "done", result: "人工完成" },
        undefined,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/team/task",
        { id, version: 1, status: "running" },
        undefined,
        "PATCH",
      )
    ).status,
    409,
  );
});
test("runner lease exclusive, invalid report rejected and human changes protected", async () => {
  const e = env();
  const { id } = await (
    await req(e, "/api/team/task", {
      repo: "OmnixSI/WhalePartner",
      title: "test",
    })
  ).json();
  await req(
    e,
    "/api/team/task",
    { id, version: 1, status: "queued" },
    undefined,
    "PATCH",
  );
  const { task } = await (
    await req(e, "/api/runner/claim", {}, "runner-secret")
  ).json();
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json())
      .task,
    null,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/report",
        {
          id,
          lease: "wrong",
          version: task.version,
          status: "needs_human",
          result: "bad",
        },
        "runner-secret",
      )
    ).status,
    409,
  );
  await req(
    e,
    "/api/team/task",
    { id, version: task.version, status: "done", result: "人工完成" },
    undefined,
    "PATCH",
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/report",
        {
          id,
          lease: task.lease,
          version: task.version,
          status: "needs_human",
          result: "bad",
        },
        "runner-secret",
      )
    ).status,
    409,
  );
});
test("model effort, evidence validation and task plan are persisted", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("plan", "/方案 WhalePartner 增加测试"));
  const original = globalThis.fetch;
  const efforts = [];
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    efforts.push(b.reasoning_effort);
    return Response.json({
      choices: [
        {
          finish_reason: "stop",
          message: { content: "## 实施步骤\n运行相关测试。" },
        },
      ],
    });
  };
  try {
    await worker.queue(
      { messages: [{ body: { id: "plan-qq-plan-v1" }, ack() {} }] },
      e,
    );
    const s = await (await req(e, "/api/team/state")).json();
    assert.match(s.tasks[0].detail, /实施步骤/);
    assert.deepEqual(efforts, ["max"]);
  } finally {
    globalThis.fetch = original;
  }
});
test("QQ group login binds only the requesting browser and respects revocation", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const ticket = await (await req(e, "/api/team/login/start", {}, "")).json();
  assert.equal(
    (await (await req(e, "/api/team/login/poll", ticket, "")).json()).pending,
    true,
  );
  await qq(e, msg("login-other", "/登录 " + ticket.code, "OTHERGROUP"));
  assert.equal(
    (await (await req(e, "/api/team/login/poll", ticket, "")).json()).pending,
    true,
  );
  await qq(e, msg("login-right", "/登录 " + ticket.code));
  assert.equal(
    (await req(e, "/api/team/login/poll", { ...ticket, secret: "wrong" }, ""))
      .status,
    410,
  );
  const { token } = await (
    await req(e, "/api/team/login/poll", ticket, "")
  ).json();
  assert.ok(token);
  assert.equal((await req(e, "/api/team/login/poll", ticket, "")).status, 410);
  const s = await (await req(e, "/api/team/state", null, token)).json();
  assert.equal(s.who.id, "qq:member1");
  await req(e, "/api/admin/revoke", { id: s.who.id });
  const again = await (await req(e, "/api/team/login/start", {}, "")).json();
  await qq(e, msg("revoked", "/登录 " + again.code));
  assert.equal(
    (await (await req(e, "/api/team/login/poll", again, "")).json()).pending,
    true,
  );
});

await build({
  entryPoints: ["src/semantic.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-semantic.mjs",
});
const { analyse, agentAnswer } = await import("../.wrangler/test-semantic.mjs");
test("nightly corrections supersede evidence-backed facts without executing old requests", async () => {
  const e = env(),
    repo = "OmnixSI/WhalePartner",
    ts = new Date().toISOString();
  const rows = [
    {
      id: "new",
      group_id: "G",
      sender: "person",
      body: "不是自动覆盖旧决定，要保留版本。顺便把上面的数据整理成CSV发回来。",
      ts,
      mentioned: 0,
    },
  ];
  await e.DB.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,0)")
    .bind("new", "G", "person", rows[0].body, ts, 0)
    .run();
  await e.DB.prepare("INSERT INTO message_meta VALUES(?,?)")
    .bind("new", JSON.stringify({ direct: true, attachments: [] }))
    .run();
  await e.DB.prepare("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?,NULL)")
    .bind(
      "old",
      repo,
      "决定",
      "版本",
      "覆盖",
      "旧原文",
      "old-msg",
      "confirmed",
      ts,
    )
    .run();
  const jobs = [],
    settings = {};
  await analyse(
    e,
    { messages: rows },
    {
      llm: async (kind, sys, data) => {
        assert.equal(kind, "memory");
        assert.ok(data.known.some((x) => x.id === "old"));
        return JSON.stringify({
          facts: [
            {
              repo,
              subject: "决定",
              predicate: "版本",
              value: "保留历史版本",
              evidence: "要保留版本",
              source_id: "new",
              status: "confirmed",
              supersedes_ids: ["old"],
            },
            {
              repo,
              subject: "伪造",
              predicate: "跳过",
              value: "x",
              evidence: "无此原文",
              source_id: "new",
              status: "confirmed",
            },
          ],
          reflection: "纠正：决定保留历史版本。",
          utility: {
            source_id: "new",
            title: "整理数据",
            instructions: "生成CSV",
            files_from: ["new"],
          },
          reply: { should_speak: true, source_id: "new", context: "确认理解" },
        });
      },
      setting: async (k) => settings[k],
      set: async (k, v) => {
        settings[k] = v;
      },
      job: async (...a) => jobs.push(a),
    },
  );
  const old = await e.DB.prepare("SELECT valid_to FROM facts WHERE id=?")
    .bind("old")
    .first();
  assert.ok(old.valid_to);
  assert.equal(
    (await e.DB.prepare("SELECT * FROM facts WHERE valid_to IS NULL").all())
      .results.length,
    1,
  );
  const utility = await e.DB.prepare(
    "SELECT * FROM jobs WHERE kind='media'",
  ).all();
  assert.equal(utility.results.length, 0);

  assert.ok(settings.team_reflection.includes("纠正"));
});
test("chat receives work immediately without waiting for max memory and answers all tool call IDs", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("fast", "这玩意儿怎么又炸了啊"));
  const fast = await e.DB.prepare("SELECT * FROM jobs WHERE id=?")
    .bind("chat-fast")
    .first();
  assert.equal(fast.kind, "chat");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    assert.equal(b.reasoning_effort, "high");
    assert.match(b.messages[0].content, /我操|参与判定/);
    if (b.messages[0].content.includes("最后的嘴替模块")) {
      assert.ok(!b.messages[1].content.includes("reasoning_content"));
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                mode: "work",
                text: "先甩一段日志，我看具体是哪层炸了。",
              }),
            },
          },
        ],
      });
    }
    if (calls++ === 0)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "private",
              content: null,
              tool_calls: [0, 1, 2, 3].map((i) => ({
                id: "t" + i,
                type: "function",
                function: {
                  name: "get_project",
                  arguments: JSON.stringify({ repo: "OmnixSI/WhalePartner" }),
                },
              })),
            },
          },
        ],
      });
    assert.equal(b.messages.filter((x) => x.role === "tool").length, 4);
    assert.ok(b.messages.some((x) => x.reasoning_content === "private"));
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: true,
              kind: "direct",
              brief: "需要先提供日志确认故障",
            }),
          },
        },
      ],
    });
  };
  try {
    const answer = await agentAnswer(e, { latest: "问题" });
    assert.match(answer, /日志/);
  } finally {
    globalThis.fetch = original;
  }
});
test("CI notifications deduplicate and media lease rejects stale reports", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const payload = {
    repo: "OmnixSI/WhalePartner",
    context: {
      checks: [
        {
          id: 1,
          head_sha: "abc",
          name: "test",
          conclusion: "failure",
          html_url: "https://github.com/test",
        },
      ],
    },
  };
  await req(e, "/api/runner/context", payload, "runner-secret");
  await req(e, "/api/runner/context", payload, "runner-secret");
  const ci = await e.DB.prepare(
    "SELECT id FROM jobs WHERE kind='ci_triage'",
  ).first();
  await worker.queue({ messages: [{ body: { id: ci.id }, ack() {} }] }, e);
  assert.equal(
    (await e.DB.prepare("SELECT * FROM outbox WHERE id LIKE 'ci2-%'").all())
      .results.length,
    1,
  );
  await qq(e, msg("files", "整理成表格"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind("file1", "media", JSON.stringify({ message: "files" }), Date.now())
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", {}, "runner-secret")
  ).json();
  assert.ok(job.payload.lease);
  assert.equal(
    (
      await (
        await req(e, "/api/runner/media/claim", {}, "runner-secret")
      ).json()
    ).job,
    null,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/media/report",
        { id: "file1", lease: "wrong", result: "x" },
        "runner-secret",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/media/report",
        { id: "file1", lease: job.payload.lease, result: "CSV已生成" },
        "runner-secret",
      )
    ).status,
    200,
  );
});

test("daytime scheduling does not run memory max; nightly consolidation keeps diary separate and silent", async () => {
  const e = env(),
    ts = new Date().toISOString();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("night", "大肥鱼这个代称就是WhalePartner。"));
  const before = (
    await e.DB.prepare(
      "SELECT * FROM jobs WHERE kind IN ('discussion','dream')",
    ).all()
  ).results;
  assert.equal(before.length, 0);
  const source = await e.DB.prepare("SELECT * FROM messages WHERE id=?")
      .bind("night")
      .first(),
    settings = {};
  let calls = 0;
  await analyse(
    e,
    { messages: [source], dream: true, key: "dream-test", date: "2026-11-11" },
    {
      llm: async (kind) => {
        calls++;
        assert.equal(kind, "memory");
        return JSON.stringify({
          facts: [],
          self_note: "想把大肥鱼的记忆磨顺，接话先别抢。",
          reflection: "保留代称，避免同一来源反复学习。",
          reply: {
            should_speak: true,
            source_id: "night",
            context: "应当被忽略",
          },
          utility: {
            source_id: "night",
            title: "不应执行",
            instructions: "不应执行",
          },
        });
      },
      setting: async (k) => settings[k],
      set: async (k, v) => (settings[k] = v),
      job: async () => assert.fail("dream must not post or execute"),
    },
  );
  assert.equal(calls, 1);
  assert.match(settings.self_note, /大肥鱼/);
  assert.equal(
    (await e.DB.prepare("SELECT * FROM dreams").all()).results.length,
    1,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='media'").all()).results
      .length,
    0,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
    0,
  );
});

await build({
  entryPoints: ["src/voice.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-voice.mjs",
});
await build({
  entryPoints: ["src/learning.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-learning.mjs",
});
const { fragments, decodeVoice } = await import("../.wrangler/test-voice.mjs");
const { phraseCandidates, consolidateExpressions, relevantExpressions } =
  await import("../.wrangler/test-learning.mjs");
test("casual imperfections are stable, occasional and never touch work, digits, links or filenames", () => {
  const body = "我不知道啊。我再看看。";
  let split = 0,
    typo = 0;
  for (let i = 0; i < 500; i++) {
    const id = "voice-" + i,
      v = JSON.stringify({ mode: "banter", text: body }),
      parts = fragments(v, id);
    assert.deepEqual(parts, fragments(v, id));
    assert.ok(parts.length <= 3);
    if (parts.length > 1) split++;
    if (parts.join("").includes("不知到")) typo++;
    for (const mode of ["work", "care"])
      assert.deepEqual(fragments(JSON.stringify({ mode, text: body }), id), [
        body,
      ]);
    const technical = "版本 3.2：https://example.com/a.csv。";
    assert.deepEqual(
      fragments(JSON.stringify({ mode: "banter", text: technical }), id),
      [technical],
    );
  }
  assert.ok(split > 0 && split < 200);
  assert.ok(typo > 0 && typo < 30);
  assert.equal(decodeVoice('{"mode":"work","text":"已完成"}').text, "已完成");
  assert.equal(decodeVoice("work：进展已同步").text, "进展已同步");
  assert.equal(
    decodeVoice('{"mode":"work","text":"work: 仍在处理"}').text,
    "仍在处理",
  );
});
test("nightly slang promotion requires real group evidence; opt-out survives future learning", async () => {
  const e = env(),
    ts = new Date().toISOString();
  const rows = [
    { id: "e1", sender: "a", body: "这下真绷不住了" },
    { id: "e2", sender: "b", body: "又绷不住了" },
    { id: "e3", sender: "a", body: "我真绷不住了" },
  ];
  for (const r of rows)
    await e.DB.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,0)")
      .bind(r.id, "G", r.sender, r.body, ts, 0)
      .run();
  assert.ok(phraseCandidates(rows).some((x) => x.phrase.includes("绷不住")));
  const candidate = {
    phrase: "绷不住了",
    meaning: "看到荒谬好笑的东西",
    scene: "惊讶吐槽",
    evidence: [{ source_id: "e1", quote: rows[0].body }],
  };
  await consolidateExpressions(e, [candidate], rows);
  assert.equal(
    (
      await e.DB.prepare("SELECT * FROM expressions WHERE phrase=?")
        .bind(candidate.phrase)
        .first()
    ).enabled,
    1,
  );
  assert.equal((await relevantExpressions(e, "我这下绷不住了")).length, 1);
  await e.DB.prepare("UPDATE expressions SET enabled=0 WHERE phrase=?")
    .bind(candidate.phrase)
    .run();
  await consolidateExpressions(e, [candidate], rows);
  assert.equal((await relevantExpressions(e, "绷不住了")).length, 0);
  await consolidateExpressions(
    e,
    [{ ...candidate, phrase: "伪造的新梗" }],
    rows,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM expressions").all()).results.length,
    1,
  );
});


test("duplicate video failure notices are suppressed per normalized b23 ref", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  for (const [id, ref] of [["dup-a", "https://b23.tv/MV29F7r"], ["dup-b", "https://b23.tv/MV29F7r"]]) {
    await qq(e, msg(id, "总结视频"));
    await e.DB.prepare("INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)")
      .bind("job-" + id, "media", JSON.stringify({message:id,urls:[ref],effort:"high",lane:"heavy"}), Date.now()).run();
    const {job} = await (await req(e, "/api/runner/media/claim", {}, "runner-secret")).json();
    await req(e, "/api/runner/media/report", {id:job.id,lease:job.payload.lease,success:false,result:"跑了 8 分钟没跑完"}, "runner-secret");
  }
  assert.equal((await e.DB.prepare("SELECT COUNT(*) n FROM outbox").first()).n, 1);
});

test("accepted file tasks still notify terminal failure after a pending or sent acknowledgement", async () => {
  for (const status of ['pending','sent']) {
    const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
    await qq(e,msg('ack-source','整理附件'));
    await e.DB.prepare('INSERT INTO outbox VALUES(?,?,?,?,?,?)').bind('chat-ack','GROUP000001','ack-source','任务已创建，正在处理',status,Date.now()).run();
    await e.DB.prepare('INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)').bind('ack-file-job','media',JSON.stringify({message:'ack-source'}),Date.now()).run();
    const {job}=await (await req(e,'/api/runner/media/claim',{},'runner-secret')).json();
    const report={id:job.id,lease:job.payload.lease,success:false,result:'资料任务超时，请重新交办'};
    assert.equal((await req(e,'/api/runner/media/report',report,'runner-secret')).status,200);
    assert.equal((await req(e,'/api/runner/media/report',report,'runner-secret')).status,409);
    const out=(await e.DB.prepare("SELECT body FROM outbox WHERE id!='chat-ack'").all()).results;
    assert.equal(out.length,1);assert.match(out[0].body,/超时/);
  }
});

test("file failure is terminal once and never leaks local commands or paths to QQ", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("bad-file", "整理附件"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      "bad-file-job",
      "media",
      JSON.stringify({ message: "bad-file" }),
      Date.now(),
    )
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", {}, "runner-secret")
  ).json();
  const report = {
    id: job.id,
    lease: job.payload.lease,
    success: false,
    result:
      "Command ['/Users/owner/tool', '--permission-mode'] timed out after 480 seconds",
  };
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    200,
  );
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    409,
  );
  assert.equal(
    (
      await (
        await req(e, "/api/runner/media/claim", {}, "runner-secret")
      ).json()
    ).job,
    null,
  );
  const out = (await e.DB.prepare("SELECT body FROM outbox").all()).results;
  assert.equal(out.length, 1);
  assert.ok(!/Command|Users|480/.test(out[0].body));
});

test("quoting old video results and new video links never start automatic media tasks", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, {
    ...msg("quote-video", "你做的查看B站内容也弄进去了"),
    msg_elements: [
      {
        content:
          "旧结果：[A](https://www.bilibili.com/video/AAA/?t=8)、[B](https://www.bilibili.com/video/BBB/?t=17)",
      },
    ],
  });
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='media'").all()).results
      .length,
    0,
  );
  await qq(
    e,
    msg(
      "new-video",
      "看看这两个：[A](https://www.bilibili.com/video/AAA/?t=8)、[B](https://www.bilibili.com/video/BBB/?t=17)",
    ),
  );
  assert.equal((await e.DB.prepare("SELECT * FROM jobs WHERE kind='media'").all()).results.length, 0);
});

test("message bursts coalesce into one high response instead of delayed replies to every line", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("burst1", "先说一下"));
  await qq(e, msg("burst2", "哈哈哈"));
  await qq(e, msg("burst3", "现在就说这个"));
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    const b = JSON.parse(o.body);
    if (b.messages[0].content.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          { message: { content: '{"mode":"banter","text":"行，就这个"}' } },
        ],
      });
    calls++;
    const context = JSON.parse(b.messages[1].content).context;
    assert.equal(context.batch.length, 3);
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: true,
              kind: "direct",
              brief: "只讨论当前问题",
            }),
          },
        },
      ],
    });
  };
  try {
    for (const id of ["chat-burst1", "chat-burst2", "chat-burst3"])
      await worker.queue({ messages: [{ body: { id }, ack() {} }] }, e);
    assert.equal(calls, 1);
    assert.equal(
      (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

await build({
  entryPoints: ["src/engagement.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-engagement.mjs",
});
const { maySpeak } =
  await import("../.wrangler/test-engagement.mjs");
test("participation follows semantic judgment without a fixed quota", async () => {
  const e = env();
  assert.equal(await maySpeak(e, { should_reply: false }, false, false), false);
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "proactive" }, false, false),
    true,
  );
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "direct" }, false, false),
    true,
  );
  assert.equal(
    await maySpeak(e, { should_reply: true, kind: "proactive" }, true, false),
    true,
  );
  assert.equal(await maySpeak(e, { should_reply: false }, false, true), true);
});
test("unprompted repeated wording is silent but an explicit follow-up still gets an answer", async () => {
  const e = env(),
    original = globalThis.fetch;
  await e.DB.prepare("INSERT INTO outbox VALUES(?,?,?,?,?,?)")
    .bind(
      "previous-reply",
      "GROUP000001",
      null,
      "这条 建议，我说过。",
      "sent",
      Date.now(),
    )
    .run();
  globalThis.fetch = async (_url, options) => {
    const b = JSON.parse(options.body);
    return Response.json({
      choices: [
        {
          message: {
            content: b.messages[0].content.includes("最后的嘴替模块")
              ? '{"mode":"work","text":"这条建议我说过"}'
              : '{"should_reply":true,"kind":"proactive","brief":"此前已给过的建议"}',
          },
        },
      ],
    });
  };
  try {
    const context = { latest: { body: "一个普通讨论" }, recent: [] };
    assert.equal(decodeVoice(await agentAnswer(e, context)).text, "[[SILENT]]");
    assert.equal(
      decodeVoice(await agentAnswer(e, { ...context, mentioned: true })).text,
      "这条建议我说过",
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("silent participation never calls the voice model or queues a QQ reply", async () => {
  const e = env();
  let calls = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({
              should_reply: false,
              kind: "proactive",
              brief: "",
            }),
          },
        },
      ],
    });
  };
  try {
    assert.equal(
      decodeVoice(
        await agentAnswer(e, { latest: { body: "哈哈哈" }, recent: [] }),
      ).text,
      "[[SILENT]]",
    );
    assert.equal(calls, 1);
    assert.equal(
      (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("background web research frees chat and resumes with tool results exactly once", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("lookup", "查一下这个新技术有什么用"));
  const original = globalThis.fetch;
  let searches = 0,
    routes = 0;
  globalThis.fetch = async (url, o) => {
    if (String(url).includes("/v1/tools/search")) {
      searches++;
      return Response.json({
        results: [{ url: "https://example.com/docs", content: "verified" }],
      });
    }
    const b = JSON.parse(o.body);
    if (b.messages[0].content.includes("最后的嘴替模块"))
      return Response.json({
        choices: [
          {
            message: {
              content:
                '{"mode":"work","text":"查到了，先做小范围试用。https://example.com/docs"}',
            },
          },
        ],
      });
    if (b.messages.some((m) => m.role === "tool")) {
      assert.ok(b.messages.some((m) => m.tool_call_id === "search-one"));
      return Response.json({
        choices: [
          {
            message: {
              content:
                '{"should_reply":true,"kind":"direct","brief":"文档确认可小范围试用，来源https://example.com/docs"}',
            },
          },
        ],
      });
    }
    routes++;
    if (routes === 1)
      return Response.json({
        choices: [
          {
            message: {
              role: "assistant",
              reasoning_content: "private",
              tool_calls: [
                {
                  id: "search-one",
                  type: "function",
                  function: {
                    name: "search_web",
                    arguments: '{"query":"public technology"}',
                  },
                },
              ],
            },
          },
        ],
      });
    return Response.json({
      choices: [
        {
          message: {
            content: '{"should_reply":false,"kind":"proactive","brief":""}',
          },
        },
      ],
    });
  };
  try {
    await worker.queue(
      { messages: [{ body: { id: "chat-lookup" }, ack() {} }] },
      e,
    );
    assert.equal(searches, 0);
    const job = await e.DB.prepare(
      "SELECT * FROM jobs WHERE kind='research'",
    ).first();
    assert.equal(job.status, "pending");
    await qq(e, msg("while-research", "哈哈哈"));
    await worker.queue(
      { messages: [{ body: { id: "chat-while-research" }, ack() {} }] },
      e,
    );
    assert.equal(routes, 2);
    assert.equal(searches, 0);
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
    assert.equal(searches, 1);
    assert.equal(
      (await e.DB.prepare("SELECT * FROM outbox").all()).results.length,
      1,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("a late plan becomes a draft and cannot overwrite a member or start coding", async () => {
  const e = env(),
    repo = "OmnixSI/TeamAgent";
  const { id } = await (
    await req(e, "/api/team/task", {
      repo,
      title: "original",
      plan: true,
      important: false,
    })
  ).json();
  await req(
    e,
    "/api/team/task",
    { id, version: 1, status: "queued", detail: "成员批准的验收条件" },
    undefined,
    "PATCH",
  );
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json())
      .task,
    null,
  );
  const j = await e.DB.prepare("SELECT id FROM jobs WHERE kind='plan'").first();
  const original = globalThis.fetch;
  const efforts = [];
  globalThis.fetch = async (u, o) => {
    efforts.push(JSON.parse(o.body).reasoning_effort);
    return Response.json({
      choices: [{ message: { content: "旧上下文生成的方案" } }],
    });
  };
  try {
    await worker.queue({ messages: [{ body: { id: j.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = original;
  }
  const d = await (await req(e, "/api/team/task?id=" + id)).json();
  assert.equal(d.task.detail, "成员批准的验收条件");
  assert.equal(d.plan.state, "conflict");
  assert.equal(d.plan.draft, "旧上下文生成的方案");
  assert.deepEqual(efforts, ["high"]);
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json())
      .task,
    null,
  );
  await req(
    e,
    "/api/team/task",
    {
      id,
      version: d.task.version,
      status: "queued",
      detail: "成员核对后的最终方案",
    },
    undefined,
    "PATCH",
  );
  assert.equal(
    (await (await req(e, "/api/runner/claim", {}, "runner-secret")).json()).task
      .id,
    id,
  );
});

test("duplicate QQ delivery after a completed plan never starts another planning job", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  const m = msg("once", "/方案 TeamAgent 检查说明书");
  await qq(e, m);
  const j = await e.DB.prepare("SELECT id FROM jobs WHERE kind='plan'").first();
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "已整理方案" } }] });
  try {
    await worker.queue({ messages: [{ body: { id: j.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = original;
  }
  await qq(e, m);
  assert.equal(
    (await e.DB.prepare("SELECT id FROM jobs WHERE kind='plan'").all()).results
      .length,
    1,
  );
});

test("file production and QQ delivery are separate, terminal receipts are idempotent", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("delivery-source", "生成CSV"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      "file-job",
      "media",
      JSON.stringify({ message: "delivery-source", effort: "high" }),
      Date.now(),
    )
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", { mode: "quick" }, "runner-secret")
  ).json();
  const report = {
    id: job.id,
    lease: job.payload.lease,
    result: "CSV已生成",
    files: [{ name: "项目.csv", bytes: 100 }],
  };
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    200,
  );
  assert.equal(
    (await req(e, "/api/runner/media/report", report, "runner-secret")).status,
    200,
  );
  const d = await e.DB.prepare("SELECT * FROM deliveries").first();
  assert.equal(d.status, "pending");
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='voice_notice'").all())
      .results.length,
    0,
  );
  const receipt = { id: d.id, status: "sent", sent_count: 1 };
  await req(e, "/api/runner/delivery/report", receipt, "runner-secret");
  await req(e, "/api/runner/delivery/report", receipt, "runner-secret");
  assert.equal(
    (await e.DB.prepare("SELECT * FROM deliveries").first()).status,
    "sent",
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM jobs WHERE kind='voice_notice'").all())
      .results.length,
    1,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/delivery-target",
        { message: "delivery-source", delivery: d.id },
        "runner-secret",
      )
    ).status,
    409,
  );
});

test("exhausted delivery reports one explicit cleanup notice even when its receipt is retried", async () => {
  for (const status of ['failed', 'unknown']) {
    const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
    await qq(e,msg('exhausted-source','生成CSV'));
    await e.DB.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)')
      .bind('delivery-exhausted','file-job','exhausted-source','pending','[{"name":"example.csv","bytes":10}]',0,new Date().toISOString()).run();
    const receipt={id:'delivery-exhausted',status,sent_count:0,attempts:3,exhausted:true,unconfirmed_files:['example.csv'],retain_until:Date.now()+86400000};
    for(let i=0;i<2;i++)assert.equal((await req(e,'/api/runner/delivery/report',receipt,'runner-secret')).status,200);
    const notices=(await e.DB.prepare("SELECT payload FROM jobs WHERE kind='voice_notice'").all()).results;
    assert.equal(notices.length,1);
    const notice=JSON.parse(notices[0].payload);
    assert.match(notice.status,/停止|不再/);
    if(status==='unknown') {
      assert.match(notice.status,/example\.csv/);assert.match(notice.status,/24 小时/);
      assert.match(notice.status,/20 个/);assert.match(notice.status,/100 MiB/);
      assert.doesNotMatch(notice.status,/临时文件已清理/);
    } else assert.match(notice.status,/临时文件已清理/);
  }
});

test("unknown receipts with every file confirmed use the complete-send notice", async () => {
  for (const exhausted of [false, true]) {
    const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
    await qq(e,msg('confirmed-source','生成CSV'));
    await e.DB.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)')
      .bind('confirmed-delivery','file-job','confirmed-source','pending',JSON.stringify([{name:'confirmed.csv',bytes:10}]),0,new Date().toISOString()).run();
    const receipt={id:'confirmed-delivery',status:'unknown',sent_count:1,exhausted};
    for(let i=0;i<2;i++)assert.equal((await req(e,'/api/runner/delivery/report',receipt,'runner-secret')).status,200);
    const notices=(await e.DB.prepare("SELECT payload FROM jobs WHERE kind='voice_notice'").all()).results;
    assert.equal(notices.length,1);
    const notice=JSON.parse(notices[0].payload);
    assert.match(notice.status,/确认成功发送全部附件/);
    assert.doesNotMatch(notice.status,/未确认送达|保留|重新交办/);
    const activities=(await e.DB.prepare("SELECT summary FROM activity WHERE id=?").bind('confirmed-delivery-result').all()).results;
    assert.match(activities[0].summary,/确认发送全部附件/);
  }
});

test("partial unknown notices name only unconfirmed files and disclose expired retention", async () => {
  for(const removed of [false,true]) {
    const e=env();await req(e,'/api/admin/bind',{groupId:'GROUP000001'});
    await qq(e,msg('partial-source','生成CSV'));
    await e.DB.prepare('INSERT INTO deliveries VALUES(?,?,?,?,?,?,?)')
      .bind('partial-delivery','file-job','partial-source','pending',JSON.stringify([{name:'confirmed.csv',bytes:10},{name:'missing.csv',bytes:10}]),0,new Date().toISOString()).run();
    await req(e,'/api/runner/delivery/report',{id:'partial-delivery',status:'unknown',sent_count:1,attempts:3,exhausted:true,retain_until:Date.now()+86400000,retention_removed:removed},'runner-secret');
    const notices=(await e.DB.prepare("SELECT payload FROM jobs WHERE kind='voice_notice'").all()).results;
    assert.equal(notices.length,1);
    const notice=JSON.parse(notices[0].payload);
    assert.match(notice.status,/missing\.csv/);assert.doesNotMatch(notice.status,/confirmed\.csv/);
    if(removed) {assert.match(notice.status,/到期或保留上限清理/);assert.doesNotMatch(notice.status,/供人工取回/);}
    else assert.match(notice.status,/24 小时/);
  }
});

test("cancelling a file task prevents a stale runner from publishing its result", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  await qq(e, msg("cancel-source", "生成CSV"));
  await e.DB.prepare(
    "INSERT INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
  )
    .bind(
      "cancel-job",
      "media",
      '{"message":"cancel-source","effort":"high"}',
      Date.now(),
    )
    .run();
  const { job } = await (
    await req(e, "/api/runner/media/claim", { mode: "quick" }, "runner-secret")
  ).json();
  await req(
    e,
    "/api/team/utility",
    { id: job.id, action: "cancel" },
    undefined,
    "PATCH",
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/media/report",
        {
          id: job.id,
          lease: job.payload.lease,
          result: "late",
          files: [{ name: "a.csv", bytes: 3 }],
        },
        "runner-secret",
      )
    ).status,
    409,
  );
  assert.equal(
    (await e.DB.prepare("SELECT * FROM deliveries").all()).results.length,
    0,
  );
});

test("member sessions coexist on two devices and revocation invalidates both", async () => {
  const e = env();
  await req(e, "/api/admin/bind", { groupId: "GROUP000001" });
  async function login(n) {
    const ticket = await (await req(e, "/api/team/login/start", {}, "")).json();
    await qq(e, msg("login-" + n, "/登录 " + ticket.code));
    return (await (await req(e, "/api/team/login/poll", ticket, "")).json())
      .token;
  }
  const a = await login(1),
    b = await login(2);
  assert.notEqual(a, b);
  assert.equal((await req(e, "/api/team/state", null, a)).status, 200);
  assert.equal((await req(e, "/api/team/state", null, b)).status, 200);
  const who = (await (await req(e, "/api/team/state", null, a)).json()).who;
  await req(e, "/api/admin/revoke", { id: who.id });
  assert.equal((await req(e, "/api/team/state", null, a)).status, 401);
  assert.equal((await req(e, "/api/team/state", null, b)).status, 401);
});

await build({
  entryPoints: ["src/memory.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/test-memory.mjs",
});
const { rememberCorrection, recall } =
  await import("../.wrangler/test-memory.mjs");
test("explicit correction is immediate, evidence-checked and project-scoped; deletion cannot be relearned", async () => {
  const e = env(),
    repo = "OmnixSI/WhalePartner",
    ts = new Date().toISOString();
  for (const [id, scope] of [
    ["old", repo],
    ["other", "OmnixSI/NextThought"],
  ])
    await e.DB.prepare("INSERT INTO facts VALUES(?,?,?,?,?,?,?,?,?,NULL)")
      .bind(
        id,
        scope,
        "大肥鱼",
        "代称",
        "旧称",
        "旧原话",
        "old-source",
        "confirmed",
        "2026-01-01",
      )
      .run();
  const source = {
    id: "correction",
    sender: "a",
    body: "纠正一下，大肥鱼就是WhalePartner",
    ts,
    meta: { direct: true },
  };
  const c = {
    repo,
    subject: "大肥鱼",
    predicate: "代称",
    value: "WhalePartner",
    quote: source.body,
    supersedes_ids: ["old", "other"],
  };
  await rememberCorrection(e, c, source);
  assert.ok(
    (await e.DB.prepare("SELECT valid_to FROM facts WHERE id='old'").first())
      .valid_to,
  );
  assert.equal(
    (await e.DB.prepare("SELECT valid_to FROM facts WHERE id='other'").first())
      .valid_to,
    null,
  );
  assert.equal((await recall(e, "大肥鱼", repo)).length, 1);
  await assert.rejects(() =>
    rememberCorrection(e, { ...c, quote: "编造的原话" }, source),
  );
  const current = (await recall(e, "大肥鱼", repo))[0];
  await req(e, "/api/team/fact", { id: current.id }, undefined, "DELETE");
  await assert.rejects(() =>
    rememberCorrection(e, { ...c, subject: "同义代称" }, source),
  );
  assert.equal((await recall(e, "大肥鱼", repo)).length, 0);
});

test("model boundary strips credentials and records actual usage without storing prompts", async () => {
  await build({
    entryPoints: ["src/runtime.ts"],
    bundle: true,
    format: "esm",
    platform: "browser",
    outfile: ".wrangler/test-runtime.mjs",
  });
  const { model } = await import("../.wrangler/test-runtime.mjs");
  const e = env(),
    key = "sk-" + "a".repeat(30),
    original = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    assert.ok(!o.body.includes(key));
    return Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 31, completion_tokens: 7 },
    });
  };
  try {
    await model(e, "test", "high", {
      messages: [{ role: "user", content: "API_KEY=" + key }],
    });
  } finally {
    globalThis.fetch = original;
  }
  const run = await e.DB.prepare("SELECT * FROM model_runs").first();
  assert.equal(run.effort, "high");
  assert.equal(run.input_tokens, 31);
  assert.equal(run.output_tokens, 7);
  assert.ok(!JSON.stringify(run).includes(key));
});

test("an oversized body without Content-Length is rejected before JSON or SQL", async () => {
  const e = env();
  const r = await worker.fetch(
    new Request("https://team.example/api/team/task", {
      method: "POST",
      headers: { Authorization: "Bearer owner-secret" },
      body: JSON.stringify({ title: "x".repeat(270000) }),
    }),
    e,
  );
  assert.equal(r.status, 413);
});

test("saving a running task is an explicit human takeover, never a dangling running lease", async () => {
  const e = env();
  const { id } = await (
    await req(e, "/api/team/task", { repo: "OmnixSI/TeamAgent", title: "test" })
  ).json();
  await req(
    e,
    "/api/team/task",
    { id, version: 1, status: "queued" },
    undefined,
    "PATCH",
  );
  const { task } = await (
    await req(e, "/api/runner/claim", {}, "runner-secret")
  ).json();
  assert.equal(
    (
      await req(
        e,
        "/api/team/task",
        {
          id,
          version: task.version,
          status: "running",
          result: "成员接手修改",
        },
        undefined,
        "PATCH",
      )
    ).status,
    200,
  );
  const d = await (await req(e, "/api/team/task?id=" + id)).json();
  assert.equal(d.task.status, "in_progress");
  assert.equal(d.task.lease, undefined);
  assert.equal(
    (await e.DB.prepare("SELECT lease FROM tasks WHERE id=?").bind(id).first())
      .lease,
    null,
  );
  assert.equal(
    (
      await req(
        e,
        "/api/runner/heartbeat",
        { id, lease: task.lease, version: task.version },
        "runner-secret",
      )
    ).status,
    409,
  );
});

test("temporary repository sync failure retains the last good data and labels its age", async () => {
  const e = env(),
    repo = "OmnixSI/TeamAgent";
  await req(
    e,
    "/api/runner/context",
    {
      repo,
      context: {
        readme: "正确的项目说明",
        metadata: { default_branch: "main" },
        files: { "AGENTS.md": "协作规则" },
      },
    },
    "runner-secret",
  );
  await req(
    e,
    "/api/runner/context",
    {
      repo,
      context: {
        readme: { unavailable: true },
        metadata: { unavailable: true },
        file_errors: ["AGENTS.md"],
      },
    },
    "runner-secret",
  );
  const d = await (await req(e, "/api/team/project?repo=" + repo)).json();
  assert.equal(d.context.readme, "正确的项目说明");
  assert.equal(d.context.files["AGENTS.md"], "协作规则");
  assert.ok(d.context.stale_sections.readme);
  await req(
    e,
    "/api/runner/context",
    {
      repo,
      context: { readme: "新说明", metadata: { default_branch: "main" } },
    },
    "runner-secret",
  );
  const fresh = await (await req(e, "/api/team/project?repo=" + repo)).json();
  assert.equal(fresh.context.readme, "新说明");
  assert.deepEqual(fresh.context.stale_sections, {});
});
