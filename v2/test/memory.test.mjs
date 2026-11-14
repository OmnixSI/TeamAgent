// reflect() parses the model's nightly rewrite. The model is replaced by a stubbed global fetch,
// so nothing leaves the machine.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reflect } from "../src/memory.ts";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function stub(contents) {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url: String(url), body });
    const content = contents[bodies.length - 1];
    if (content === undefined) throw new Error("unexpected extra call");
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  };
  return bodies;
}
const env = { DEEPSEEK_API_KEY: "test-key" };
const input = { memory: "", notes: ["小王换工作了"], transcript: "[10:00] 小王：我换工作了", label: "11-15" };
const good = "===记忆===\n【群友】\n" + "· 小王在做 AI 项目（11-15）\n".repeat(20) + "\n===小结===\n今天小王说换工作了。";

describe("memory.reflect", () => {
  test("splits the answer into memory and summary", async () => {
    const calls = stub([good]);
    const r = await reflect(env, input);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.reasoning_effort, "max");
    assert.ok(r.memory.startsWith("【群友】"));
    assert.ok(!r.memory.includes("===小结==="));
    assert.equal(r.summary, "今天小王说换工作了。");
    const user = calls[0].body.messages[1].content;
    assert.match(user, /· 小王换工作了/);
    assert.match(user, /【群聊记录：11-15】/);
  });

  test("a rewrite much shorter than the old memory is retried at high, then accepted", async () => {
    const old = "【群友】" + "旧".repeat(1000);
    const calls = stub(["===记忆===\n【群友】太短\n===小结===\nx", "===记忆===\n【群友】" + "新".repeat(600) + "\n===小结===\n好"]);
    const r = await reflect(env, { ...input, memory: old });
    assert.deepEqual(calls.map(c => c.body.reasoning_effort), ["max", "high"]);
    assert.equal(r.summary, "好");
    assert.ok(r.memory.length >= 500);
  });

  test("throws when neither attempt is usable", async () => {
    stub(["没有分隔行的回答", "===记忆===\n没有小节标记" + "x".repeat(300)]);
    await assert.rejects(reflect(env, input), /reflect produced no usable memory/);
  });
});
