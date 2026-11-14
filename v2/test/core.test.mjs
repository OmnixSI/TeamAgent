// Offline tests for the conversation loop: a scripted model and fake tools, no network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runTurn, buildMessages, renderLine, displayName } from "../src/core.ts";

const T = Date.UTC(2026, 10, 15, 2, 0); // 2026-11-15 10:00 Beijing

function row(seq, text, extra = {}) {
  return { seq, id: "m" + seq, role: "user", sender: "U000" + seq, name: "小王", text, ts: T, ...extra };
}
function input(extra = {}) {
  return { rows: [row(1, "大家好")], cursor: 0, mentioned: false, memory: "", notes: [], now: T, ...extra };
}
const tc = (id, name, args = {}) => ({ id, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

/** A model that follows a script. Each step is a string (plain answer), a message object, an Error, or a function. */
function fakeChat(script) {
  const calls = [];
  const chat = async (body, effort, timeoutMs) => {
    const i = calls.length;
    calls.push({ messages: body.messages.map(m => ({ ...m })), tools: body.tools, effort, maxTokens: body.max_tokens, timeoutMs });
    let step = typeof script === "function" ? script(i, body, effort) : script[i];
    if (step === undefined) throw new Error("script ran out at call " + i);
    if (step instanceof Error) throw step;
    const message = typeof step === "string" ? { content: step } : step;
    return { message, usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }, ms: 1 };
  };
  return { chat, calls };
}
function tool(name, run, extra = {}) {
  const t = { name, description: name, parameters: { type: "object", properties: {} }, runs: [], ...extra };
  t.run = async args => { t.runs.push(args); return run(args); };
  return t;
}

describe("runTurn", () => {
  test("(a) unaddressed chatter + PASS stays silent after one effort-none call", async () => {
    const m = fakeChat(["PASS"]);
    const res = await runTurn(input(), { chat: m.chat, tools: [] });
    assert.equal(res.silent, true);
    assert.deepEqual(res.replies, []);
    assert.equal(res.stats.calls, 1);
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].effort, "none");
    assert.equal(m.calls[0].maxTokens, 900);
    assert.equal(m.calls[0].timeoutMs, 45000);
    assert.equal(res.stats.inTok, 100);
    assert.equal(res.stats.outTok, 10);
    assert.equal(res.stats.cached, 40);
  });

  test("(a') bracketed PASS and empty answers also count as silence", async () => {
    for (const answer of ["（PASS）", "", "pass 没什么要说的"]) {
      const m = fakeChat([answer]);
      const res = await runTurn(input(), { chat: m.chat, tools: [] });
      assert.equal(res.silent, true, JSON.stringify(answer));
      assert.equal(m.calls.length, 1);
    }
  });

  test("(b) a real answer at effort none is redone at high and the second answer is used", async () => {
    const m = fakeChat(["哈哈确实", "确实离谱"]);
    const res = await runTurn(input(), { chat: m.chat, tools: [] });
    assert.equal(res.silent, false);
    assert.deepEqual(res.replies, ["确实离谱"]);
    assert.deepEqual(m.calls.map(c => c.effort), ["none", "high"]);
    assert.equal(m.calls[1].maxTokens, 5000);
    assert.equal(m.calls[1].timeoutMs, 150000);
    // The glance's answer is thrown away, not added to the conversation.
    assert.equal(m.calls[1].messages.length, m.calls[0].messages.length);
  });

  test("(b') a tool call at effort none is not executed; the step is redone at high", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat([{ content: "", tool_calls: [tc("c1", "lookup")] }, "PASS"]);
    const res = await runTurn(input(), { chat: m.chat, tools: [look] });
    assert.equal(look.runs.length, 0);
    assert.deepEqual(m.calls.map(c => c.effort), ["none", "high"]);
    assert.equal(res.silent, true);
  });

  test("(c) mentioned + PASS is nudged once and the second answer is used", async () => {
    const m = fakeChat(["PASS", "在的，咋了"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [] });
    assert.deepEqual(res.replies, ["在的，咋了"]);
    assert.deepEqual(m.calls.map(c => c.effort), ["high", "high"]);
    const msgs = m.calls[1].messages;
    assert.deepEqual(msgs.at(-2), { role: "assistant", content: "PASS" });
    assert.equal(msgs.at(-1).role, "user");
    assert.match(msgs.at(-1).content, /直接回话/);
  });

  test("(c') mentioned + PASS twice ends silent (nudge happens only once)", async () => {
    const m = fakeChat(["PASS", "PASS"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [] });
    assert.equal(res.silent, true);
    assert.equal(m.calls.length, 2);
  });

  test("(d) tool loop: result is fed back as a tool message and recorded in stats", async () => {
    const look = tool("lookup", args => ({ ok: true, answer: 42, q: args.q }));
    const m = fakeChat([{ content: "", tool_calls: [tc("c1", "lookup", { q: "x" })] }, "答案是 42"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look] });
    assert.deepEqual(res.replies, ["答案是 42"]);
    assert.deepEqual(look.runs, [{ q: "x" }]);
    assert.deepEqual(res.stats.tools, ["lookup"]);
    assert.equal(res.stats.runs.length, 1);
    assert.equal(res.stats.runs[0].name, "lookup");
    assert.equal(res.stats.runs[0].ok, true);
    assert.equal(res.stats.runs[0].args, '{"q":"x"}');
    assert.equal("error" in res.stats.runs[0], false);
    // Tool definitions are passed in OpenAI function format.
    assert.equal(m.calls[0].tools[0].type, "function");
    assert.equal(m.calls[0].tools[0].function.name, "lookup");
    const msgs = m.calls[1].messages;
    const asst = msgs.at(-2), toolMsg = msgs.at(-1);
    assert.equal(asst.role, "assistant");
    assert.equal(asst.tool_calls[0].id, "c1");
    assert.equal(toolMsg.role, "tool");
    assert.equal(toolMsg.tool_call_id, "c1");
    assert.deepEqual(JSON.parse(toolMsg.content), { ok: true, answer: 42, q: "x" });
  });

  test("(d') failing tools are recorded with ok=false and their error text", async () => {
    const boom = tool("boom", () => { throw new Error("炸了"); });
    const nope = tool("nope", () => ({ ok: false, error: "不行" }));
    const errOnly = tool("erronly", () => ({ error: "坏了" }));
    const m = fakeChat([
      { content: "", tool_calls: [tc("a", "boom"), tc("b", "nope"), tc("c", "erronly"), tc("d", "missing"), tc("e", "nope", "{bad json")] },
      "好吧都失败了",
    ]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [boom, nope, errOnly] });
    assert.deepEqual(res.stats.tools, ["boom", "nope", "erronly", "missing", "nope"]);
    const byId = res.stats.runs.map(r => [r.name, r.ok, r.error]);
    assert.deepEqual(byId.find(r => r[0] === "boom"), ["boom", false, "炸了"]);
    assert.deepEqual(byId.find(r => r[0] === "erronly"), ["erronly", false, "坏了"]);
    assert.deepEqual(byId.find(r => r[0] === "missing"), ["missing", false, "没有这个工具"]);
    assert.ok(byId.some(r => r[0] === "nope" && r[2] === "不行"));
    assert.ok(byId.some(r => r[0] === "nope" && r[2] === "参数不是合法 JSON"));
    assert.ok(res.stats.runs.every(r => r.ok === false));
    const toolMsgs = m.calls[1].messages.filter(x => x.role === "tool");
    assert.deepEqual(toolMsgs.map(x => x.tool_call_id), ["a", "b", "c", "d", "e"]);
    assert.deepEqual(JSON.parse(toolMsgs[0].content), { ok: false, error: "炸了" });
  });

  test("(e) a work tool switches later calls to effort max and keeps the reply whole", async () => {
    const work = tool("run_python", () => ({ ok: true }), { work: true });
    const m = fakeChat([{ content: "", tool_calls: [tc("c1", "run_python")] }, "第一行\n第二行"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [work] });
    assert.deepEqual(m.calls.map(c => c.effort), ["high", "max"]);
    assert.equal(m.calls[1].maxTokens, 12000);
    assert.deepEqual(res.replies, ["第一行\n第二行"]);
  });

  test("(e') without careful mode a short multi-line answer is split", async () => {
    const m = fakeChat(["第一行\n第二行"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [] });
    assert.deepEqual(res.replies, ["第一行", "第二行"]);
  });

  test("(f) a promise without tool use triggers exactly one corrective round", async () => {
    const m = fakeChat(["我先查一下再回你", "我先查一下再回你"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [] });
    assert.equal(m.calls.length, 2);
    assert.deepEqual(m.calls.map(c => c.effort), ["high", "max"]);
    const msgs = m.calls[1].messages;
    assert.deepEqual(msgs.at(-2), { role: "assistant", content: "我先查一下再回你" });
    assert.match(msgs.at(-1).content, /别预告/);
    assert.deepEqual(res.replies, ["我先查一下再回你"]);
  });

  test("(f') a promise after a tool was used is not corrected", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat([{ content: "", tool_calls: [tc("c1", "lookup")] }, "稍等，结果马上出"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look] });
    assert.equal(m.calls.length, 2);
    assert.deepEqual(res.replies, ["稍等，结果马上出"]);
  });

  test("(g) _images from a tool become a user message with image parts and are stripped", async () => {
    const shot = tool("screenshot", () => ({ ok: true, title: "页", _images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] }));
    const m = fakeChat([{ content: "", tool_calls: [tc("c1", "screenshot")] }, "看到了"]);
    await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [shot] });
    const msgs = m.calls[1].messages;
    const toolMsg = msgs.find(x => x.role === "tool");
    const parsed = JSON.parse(toolMsg.content);
    assert.equal("_images" in parsed, false);
    assert.equal(parsed.images_shown, true);
    assert.equal(parsed.title, "页");
    const pic = msgs.at(-1);
    assert.equal(pic.role, "user");
    assert.ok(Array.isArray(pic.content));
    assert.equal(pic.content[0].type, "text");
    assert.match(pic.content[0].text, /共 2 张/);
    assert.deepEqual(pic.content.slice(1).map(p => p.image_url.url), ["data:image/png;base64,AAA", "data:image/png;base64,BBB"]);
  });

  test("(h) without plan the loop stops at 8 rounds and the last round has no tools", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat((i, body) => body.tools ? { content: "", tool_calls: [tc("c" + i, "lookup")] } : "就查到这些");
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look] });
    assert.equal(m.calls.length, 8);
    assert.ok(m.calls.slice(0, 7).every(c => Array.isArray(c.tools)));
    assert.equal(m.calls[7].tools, undefined);
    assert.match(m.calls[7].messages.at(-1).content, /工具次数用完了/);
    assert.equal(look.runs.length, 7);
    assert.deepEqual(res.replies, ["就查到这些"]);
  });

  test("(h') calling plan raises the round limit beyond 8 and switches to careful mode", async () => {
    const plan = tool("plan", () => ({ ok: true }));
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat(i => i === 0 ? { content: "", tool_calls: [tc("p", "plan", { steps: ["a"] })] }
      : i <= 10 ? { content: "", tool_calls: [tc("c" + i, "lookup")] } : "做完了");
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [plan, look] });
    assert.equal(m.calls.length, 12);
    assert.equal(look.runs.length, 10);
    assert.equal(m.calls[0].effort, "high");
    assert.ok(m.calls.slice(1).every(c => c.effort === "max"));
    assert.ok(m.calls.every(c => Array.isArray(c.tools)));
    assert.deepEqual(res.replies, ["做完了"]);
  });

  test("(h'') after plan the hard ceiling is 30 rounds", async () => {
    const plan = tool("plan", () => ({ ok: true }));
    const m = fakeChat((i, body) => i === 0 ? { content: "", tool_calls: [tc("p", "plan")] }
      : body.tools ? { content: "", tool_calls: [tc("c" + i, "plan")] } : "收尾");
    await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [plan] });
    assert.equal(m.calls.length, 30);
    assert.equal(m.calls[29].tools, undefined);
  });

  test("(i) cancelled before the first call: silent with error cancelled", async () => {
    const m = fakeChat(["不该被调用"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [], cancelled: () => true });
    assert.equal(m.calls.length, 0);
    assert.equal(res.silent, true);
    assert.equal(res.stats.error, "cancelled");
  });

  test("(i') cancelled mid-turn stops the loop after the current round", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat(i => ({ content: "", tool_calls: [tc("c" + i, "lookup")] }));
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look], cancelled: () => m.calls.length >= 2 });
    assert.equal(m.calls.length, 2);
    assert.equal(look.runs.length, 2);
    assert.equal(res.silent, true);
    assert.equal(res.stats.error, "cancelled");
  });

  test("(j) resume uses the saved messages, appends a restart notice, and runs in the background budget", async () => {
    const saved = [{ role: "system", content: "SYS" }, { role: "user", content: "做本书" }, { role: "assistant", content: "", tool_calls: [tc("x", "plan")] }, { role: "tool", tool_call_id: "x", content: "{}" }];
    const copy = structuredClone(saved);
    const m = fakeChat(["书做好了"]);
    const res = await runTurn({ rows: [], cursor: 0, mentioned: true, memory: "M", notes: [], now: T, resume: saved }, { chat: m.chat, tools: [] });
    const msgs = m.calls[0].messages;
    assert.equal(msgs.length, saved.length + 1);
    assert.deepEqual(msgs.slice(0, 4), copy);
    assert.equal(msgs[4].role, "user");
    assert.match(msgs[4].content, /重启/);
    assert.deepEqual(saved, copy, "the caller's array is not mutated");
    assert.equal(m.calls[0].effort, "max");
    assert.deepEqual(res.replies, ["书做好了"]);
  });

  test("(k) checkpoint is called after every round of tool results", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const seen = [];
    const m = fakeChat([{ content: "", tool_calls: [tc("a", "lookup")] }, { content: "", tool_calls: [tc("b", "lookup"), tc("c", "lookup")] }, "好了"]);
    await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look], checkpoint: msgs => { seen.push(msgs.map(x => x.role)); } });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].at(-1), "tool");
    assert.deepEqual(seen[1].slice(-3), ["assistant", "tool", "tool"]);
  });

  test("(k') a rejecting async checkpoint does not break the turn", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat([{ content: "", tool_calls: [tc("a", "lookup")] }, "好了"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [look], checkpoint: async () => { throw new Error("disk full"); } });
    assert.deepEqual(res.replies, ["好了"]);
    assert.equal(res.stats.error, undefined);
  });

  test("(l) detach is called with a description when a long tool is used", async () => {
    const cases = [["make_book", "做一本插画书"], ["plan", "按计划做一个多步骤的成品"], ["render_video", "render_video"]];
    for (const [name, expected] of cases) {
      const t = tool(name, () => ({ ok: true }), { long: true });
      const what = [];
      const m = fakeChat([{ content: "", tool_calls: [tc("a", name)] }, "完成"]);
      await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [t], detach: w => what.push(w) });
      assert.deepEqual(what, [expected], name);
    }
    const short = tool("lookup", () => ({ ok: true }));
    const what = [];
    const m = fakeChat([{ content: "", tool_calls: [tc("a", "lookup")] }, "完成"]);
    await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [short], detach: w => what.push(w) });
    assert.deepEqual(what, []);
  });

  test("(m) a scheduled task starts in careful mode and gets the 30-round budget", async () => {
    const look = tool("lookup", () => ({ ok: true }));
    const m = fakeChat((i, body) => body.tools ? { content: "", tool_calls: [tc("c" + i, "lookup")] } : "早报：今天没大事");
    const res = await runTurn(input({ task: "发早报" }), { chat: m.chat, tools: [look] });
    assert.equal(m.calls.length, 30);
    assert.ok(m.calls.every(c => c.effort === "max"));
    assert.match(m.calls[0].messages.at(-1).content, /定时任务触发/);
    assert.deepEqual(res.replies, ["早报：今天没大事"]);
  });

  test("(m') scheduled task that answers PASS stays silent, as its prompt tells the model it may",
    async () => {
      const m = fakeChat(["PASS", "随便说点什么"]);
      const res = await runTurn(input({ task: "有新闻就发，没有就算了" }), { chat: m.chat, tools: [] });
      assert.equal(res.silent, true);
      assert.equal(m.calls.length, 1);
    });

  test("model error: mentioned turn gets the apology line, task turn stays silent", async () => {
    const r1 = await runTurn(input({ mentioned: true }), { chat: fakeChat([new Error("model http 500")]).chat, tools: [] });
    assert.equal(r1.silent, false);
    assert.match(r1.replies.join(""), /卡了一下/);
    assert.match(r1.stats.error, /model http 500/);
    const r2 = await runTurn(input({ task: "发早报" }), { chat: fakeChat([new Error("timeout")]).chat, tools: [] });
    assert.equal(r2.silent, true);
    assert.equal(r2.stats.error, "timeout");
    const r3 = await runTurn(input(), { chat: fakeChat([new Error("timeout")]).chat, tools: [] });
    assert.equal(r3.silent, true);
  });

  test("leaked markup and a speaker prefix are removed from the answer", async () => {
    const m = fakeChat(["Bot：好的\n<｜DSML｜function_calls>\n[你发了一张图 g12：猫]\n**行**"]);
    const res = await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [] });
    assert.deepEqual(res.replies, ["好的", "行"]);
  });

  test("a drawing request the model declines is pushed back once", async () => {
    const m = fakeChat(["这个我不画", "好，我画"]);
    const res = await runTurn(input({ mentioned: true, rows: [row(1, "帮我画一只猫")] }), { chat: m.chat, tools: [] });
    assert.equal(m.calls.length, 2);
    assert.match(m.calls[1].messages.at(-1).content, /generate_image/);
    assert.deepEqual(res.replies, ["好，我画"]);
  });

  test("a slow tool sends a short lead line as interim when mentioned", async () => {
    const slow = tool("search", () => ({ ok: true }), { slow: true });
    const sent = [];
    const m = fakeChat([{ content: "**我搜一下**", tool_calls: [tc("a", "search")] }, "搜到了"]);
    await runTurn(input({ mentioned: true }), { chat: m.chat, tools: [slow], interim: async t => { sent.push(t); } });
    assert.deepEqual(sent, ["我搜一下"]);
  });

  test("splitMax limits the number of chat bubbles", async () => {
    const m = fakeChat(["一\n二\n三"]);
    const res = await runTurn(input({ mentioned: true, splitMax: 2 }), { chat: m.chat, tools: [] });
    assert.deepEqual(res.replies, ["一", "二"]);
  });
});

describe("renderLine / displayName", () => {
  test("time, name, mention flag", () => {
    assert.equal(renderLine(row(3, "你好", { mentioned: 1 })), "[10:00] 小王（@你）：你好");
    assert.equal(displayName({ seq: 1, id: "", role: "user", text: "", ts: 0, sender: "abcdef1234" }), "成员1234");
    assert.equal(displayName({ seq: 1, id: "", role: "user", text: "", ts: 0 }), "成员");
  });

  test("quote, images with and without captions, files, video", () => {
    const r = row(5, "看这个", {
      meta: {
        quote: { name: "老李", text: "原来的话" },
        images: [{ caption: "一只猫" }, {}],
        files: [{ name: "a.pdf", url: "https://x/a.pdf" }, { url: "https://x/b" }],
        video: true,
      },
    });
    assert.equal(renderLine(r), "[10:00] 小王：〔回复 老李：“原来的话”〕看这个 [图片 5-0：一只猫] [图片 5-1] [文件 a.pdf https://x/a.pdf] [文件 未命名 https://x/b] [视频]");
    assert.equal(renderLine(r, false), "[10:00] 小王：〔回复 老李：“原来的话”〕看这个 [图片 5-0] [图片 5-1] [文件 a.pdf https://x/a.pdf] [文件 未命名 https://x/b] [视频]");
    assert.match(renderLine(row(6, "x", { meta: { quote: { text: "y" } } })), /〔回复 某人：“y”〕x/);
  });

  test("long quotes are clipped to 60 characters", () => {
    const line = renderLine(row(7, "嗯", { meta: { quote: { name: "a", text: "字".repeat(100) } } }));
    assert.ok(line.includes("字".repeat(60) + "…”〕"));
    assert.ok(!line.includes("字".repeat(61)));
  });
});

describe("buildMessages", () => {
  const bot = (seq, text) => ({ seq, id: "b" + seq, role: "bot", text, ts: T });

  test("leading bot rows dropped, user rows grouped, bot rows become assistant turns", () => {
    const msgs = buildMessages(input({
      rows: [bot(1, "开场白"), row(2, "一"), row(3, "二"), bot(4, "回答A"), bot(5, "回答B"), row(6, "三")],
      cursor: 5, mentioned: true,
    }));
    assert.deepEqual(msgs.map(m => m.role), ["system", "user", "assistant", "user"]);
    assert.equal(msgs[1].content, "[10:00] 小王：一\n[10:00] 小王：二");
    assert.equal(msgs[2].content, "回答A\n回答B");
    assert.ok(msgs[3].content.startsWith("[10:00] 小王：三\n"));
    assert.ok(!JSON.stringify(msgs).includes("开场白"));
    assert.ok(!msgs[3].content.includes("以下是新消息"), "no marker when an assistant turn already separates old and new");
    assert.match(msgs[3].content, /必须回应/);
  });

  test("the new-messages marker sits between old and new lines of one user group", () => {
    const msgs = buildMessages(input({ rows: [row(1, "旧"), row(2, "新1"), row(3, "新2")], cursor: 1 }));
    const lines = msgs[1].content.split("\n");
    assert.equal(lines[0], "[10:00] 小王：旧");
    assert.equal(lines[1], "———— 以下是新消息 ————");
    assert.equal(lines[2], "[10:00] 小王：新1");
    assert.equal(lines[3], "[10:00] 小王：新2");
    assert.equal(msgs[1].content.split("以下是新消息").length, 2);
  });

  test("no marker when everything is new or nothing is new", () => {
    for (const cursor of [0, 10]) {
      const msgs = buildMessages(input({ rows: [row(1, "a"), row(2, "b")], cursor }));
      assert.ok(!msgs[1].content.includes("以下是新消息"), "cursor " + cursor);
    }
  });

  test("old bot lines are clipped to 500 characters, recent ones kept whole", () => {
    const long = "长".repeat(800);
    const msgs = buildMessages(input({ rows: [row(1, "q"), bot(2, long), row(100, "q2")], cursor: 99 }));
    assert.equal(msgs[2].content, "长".repeat(500) + "…");
    const recent = buildMessages(input({ rows: [row(1, "q"), bot(80, long), row(100, "q2")], cursor: 99 }));
    assert.equal(recent[2].content, long);
  });

  test("fresh images are attached as image parts and their captions are hidden", () => {
    const r = row(5, "看图", { meta: { images: [{ caption: "旧说明" }] } });
    const msgs = buildMessages(input({ rows: [r], cursor: 4, images: [{ seq: 5, index: 0, dataUrl: "data:image/png;base64,Q" }] }));
    const last = msgs.at(-1);
    assert.ok(Array.isArray(last.content));
    assert.equal(last.content[0].type, "text");
    assert.match(last.content[0].text, /\[图片 5-0\]/);
    assert.ok(!last.content[0].text.includes("旧说明"));
    assert.deepEqual(last.content.slice(1), [
      { type: "text", text: "图片 5-0：" },
      { type: "image_url", image_url: { url: "data:image/png;base64,Q" } },
    ]);
  });

  test("trailer: idle levels, askers, job, task, memory/rules/notes in the system prompt", () => {
    const quiet = buildMessages(input({ talkative: "quiet" })).at(-1).content;
    assert.match(quiet, /除非有非说不可的新信息/);
    const chatty = buildMessages(input({ talkative: "chatty" })).at(-1).content;
    assert.match(chatty, /抖的机灵/);
    const asked = buildMessages(input({ mentioned: true, askers: ["甲", "乙", "甲"] })).at(-1).content;
    assert.match(asked, /找你的有 甲、乙/);
    const job = buildMessages(input({ job: "做一本插画书" })).at(-1).content;
    assert.match(job, /后台任务正在做：做一本插画书/);
    const task = buildMessages(input({ task: "发早报" })).at(-1).content;
    assert.match(task, /定时任务触发，不是群友发言：发早报/);
    assert.match(task, /北京时间 11-15 周日 10:00（悉尼 11-15 周日 13:00）/);
    const sys = buildMessages(input({ memory: "记忆X", notes: ["笔记Y"], rules: "规矩Z" }))[0];
    assert.equal(sys.role, "system");
    assert.match(sys.content, /规矩Z/);
    assert.match(sys.content, /记忆X/);
    assert.match(sys.content, /· 笔记Y/);
  });
});
