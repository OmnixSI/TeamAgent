import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { env } from "./support.mjs";

const outfile = ".wrangler/ai-neurons-" + process.pid + ".mjs";
await build({
  stdin: {
    contents:
      'export { describeBytes, applyImageOutcomes } from "./src/vision";' +
      'export { reserve, refund, adjust } from "./src/budget";' +
      'export { runWorkersAi } from "./src/ai-budget";' +
      'export { estimateNeurons, actualNeurons, aiNeuronsCap, AI_NEURONS_DAILY_CAP } from "./src/ai-budget";',
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile,
});
const v = await import("../" + outfile);

const pic = (n) => Uint8Array.from([137, 80, 78, 71, n]);
const signal = () => new AbortController().signal;
const answer = { desc: "DeepSeek 看到的图", text: "", tags: ["图"], meme: false };

async function setting(e, key, value) {
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
    .bind(key, value)
    .run();
}
async function row(e) {
  const r = await e.DB.prepare(
    "SELECT value FROM settings WHERE key LIKE 'budget:workers_ai_neurons:%'",
  ).first();
  return r ? Number(r.value) : null;
}
function ai(e, run) {
  const calls = [];
  e.AI = {
    async run(model, input) {
      calls.push({ model, input });
      return run(model, input);
    },
  };
  return calls;
}
function dsResponse() {
  return Response.json({
    choices: [{ message: { content: JSON.stringify(answer) } }],
    usage: { prompt_tokens: 1200, completion_tokens: 40 },
  });
}
async function offline(run) {
  const old = globalThis.fetch;
  globalThis.fetch = async () => dsResponse();
  try {
    return await run();
  } finally {
    globalThis.fetch = old;
  }
}

test("CF-AI-1 第 N 张后 neuron 预算拒绝、不调用 AI，退回 DeepSeek", async () => {
  const e = env();
  await setting(e, "workers_ai:neurons_cap", "35");
  const calls = ai(e, async () => ({
    response: JSON.stringify({ desc: "Workers 看到的图", tags: [], meme: true }),
  }));
  const first = await offline(() =>
    v.describeBytes(e, pic(1), "image/png", "表情", signal(), "v1", undefined, { lowValue: true }),
  );
  assert.equal(first.desc, "Workers 看到的图");
  const second = await offline(() =>
    v.describeBytes(e, pic(2), "image/png", "表情", signal(), "v1", undefined, { lowValue: true }),
  );
  assert.equal(second.desc, answer.desc, "超额后应退回 DeepSeek");
  assert.equal(calls.length, 1, "超额后不得再调用 Workers AI");
  assert.equal(await row(e), 35);
});

test("CF-AI-2 调用失败退回预扣", async () => {
  const e = env();
  await setting(e, "vision:provider", "workers");
  ai(e, async () => {
    throw Error("binding boom");
  });
  const note = await offline(() =>
    v.describeBytes(e, pic(3), "image/png", "", signal()),
  );
  assert.equal(note, null);
  assert.equal(await row(e), 0, "失败的预扣必须归零");
});

test("CF-AI-3 超限退回 DeepSeek 并带标注", async () => {
  const e = env();
  await setting(e, "workers_ai:neurons_cap", "0");
  const calls = ai(e, async () => assert.fail("超限不得调用 AI"));
  const events = [];
  const note = await offline(() =>
    v.describeBytes(e, pic(4), "image/png", "表情", signal(), "v1", (ev) => events.push(ev), {
      lowValue: true,
    }),
  );
  assert.equal(note.desc, answer.desc);
  assert.equal(calls.length, 0);
  assert.ok(
    events.some((ev) => ev.note === "Workers AI 今日额度已用完，改用 DeepSeek"),
    "降级事件必须带标注",
  );
});

test("CF-AI-4 跨日重置", async () => {
  const e = env();
  const day1 = Date.parse("2026-11-14T00:00:00Z");
  const day2 = Date.parse("2026-11-15T00:00:00Z");
  assert.equal(await v.reserve(e, "workers_ai_neurons", 35, 35, day1), true);
  assert.equal(await v.reserve(e, "workers_ai_neurons", 35, 35, day1), false);
  assert.equal(await v.reserve(e, "workers_ai_neurons", 35, 35, day2), true);
  const rows = await e.DB.prepare(
    "SELECT key,value FROM settings WHERE key LIKE 'budget:workers_ai_neurons:%' ORDER BY key",
  ).all();
  assert.deepEqual(rows.results.map((r) => [r.key.slice(-10), Number(r.value)]), [
    ["2026-11-14", 35],
    ["2026-11-15", 35],
  ]);
});

test("CF-AI-5 响应带 usage 时按实际 neurons 校正", async () => {
  const e = env();
  const calls = ai(e, async () => ({
    response: JSON.stringify({ desc: "有 usage", tags: [], meme: false }),
    usage: { prompt_tokens: 1100, completion_tokens: 400 },
  }));
  const note = await v.describeBytes(e, pic(5), "image/png", "表情", signal(), "v1", undefined, {
    lowValue: true,
  });
  assert.equal(note.desc, "有 usage");
  assert.equal(calls.length, 1);
  const actual = v.actualNeurons("@cf/meta/llama-3.2-11b-vision-instruct", {
    prompt_tokens: 1100,
    completion_tokens: 400,
  });
  assert.equal(v.estimateNeurons("@cf/meta/llama-3.2-11b-vision-instruct", {}), 35);
  assert.equal(actual, 30);
  assert.equal(await row(e), actual);
  assert.equal(
    v.actualNeurons("@cf/meta/llama-3.2-11b-vision-instruct", { neurons: 42 }),
    42,
    "binding 直接返回 neurons 时以它为准",
  );
});

test("CF-AI-6 日上限默认 8000、settings 可调", async () => {
  const e = env();
  assert.equal(v.AI_NEURONS_DAILY_CAP, 8000);
  assert.equal(await v.aiNeuronsCap(e), 8000);
  const e2 = env();
  await setting(e2, "workers_ai:neurons_cap", "120");
  assert.equal(await v.aiNeuronsCap(e2), 120);
});

test("CF-AI-7 强制 workers 且额度用完：群回复用人话，不报原始错误", async () => {
  const e = env();
  await setting(e, "vision:provider", "workers");
  await setting(e, "workers_ai:neurons_cap", "0");
  const calls = ai(e, async () => assert.fail("超限不得调用 AI"));
  const events = [];
  const note = await v.describeBytes(e, pic(6), "image/png", "", signal(), "v1", (ev) =>
    events.push(ev),
  );
  assert.equal(note, null);
  assert.equal(calls.length, 0);
  const notes = new Map();
  v.applyImageOutcomes(notes, [
    { messageId: "m", idx: 0, ...events.at(-1) },
  ]);
  assert.match(notes.get("m")[0], /今天看图额度用完了/);
  assert.doesNotMatch(notes.get("m")[0], /workers_ai_neurons|binding|Error/);
});

test("CF-AI-8 悉尼跨日不翻倍：同一 UTC 日只有一份额度", async () => {
  const e = env();
  // 2026-11-14 12:59 Sydney-late and 2026-11-15 00:30 Sydney are the same UTC day.
  const a = Date.parse("2026-11-14T12:59:00Z");
  const b = Date.parse("2026-11-14T13:01:00Z"); // Sydney already rolled to 11-15
  assert.equal(await v.reserve(e, "workers_ai_neurons", 35, 35, a), true);
  assert.equal(await v.reserve(e, "workers_ai_neurons", 1, 35, b), false);
});

test("CF-AI-9 自检路径也过硬闸：额度为零时不调用 AI", async () => {
  const e = env();
  await setting(e, "workers_ai:neurons_cap", "0");
  const calls = ai(e, () => ({ response: "x" }));
  const smoke = { ...e, DB: undefined, aiBudgetDB: e.DB };
  await assert.rejects(
    () => v.runWorkersAi(smoke, "@cf/meta/llama-3.2-11b-vision-instruct", { messages: [] }),
    (err) => err.reason === "provider_cap",
  );
  assert.equal(calls.length, 0);
  // Without any database to account against, the call is refused too.
  await assert.rejects(
    () => v.runWorkersAi({ ...e, DB: undefined }, "@cf/meta/llama-3.2-11b-vision-instruct", { messages: [] }),
    (err) => err.reason === "provider_cap",
  );
  assert.equal(calls.length, 0);
});
