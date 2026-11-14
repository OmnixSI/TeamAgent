import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { env } from "./support.mjs";

await build({
  entryPoints: ["src/vision.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/f6p1-vision.mjs",
});
const v = await import("../.wrangler/f6p1-vision.mjs");

const png = Uint8Array.from([137, 80, 78, 71, 1, 2, 3, 4]);
const signal = () => new AbortController().signal;
const answer = {
  desc: "戴眼镜的年轻人举起右手敬礼",
  text: "THE FIRST STEP",
  tags: ["人像", "敬礼"],
  meme: false,
};

async function withFetch(fetcher, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function setting(e, key, value) {
  await e.DB.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)")
    .bind(key, value)
    .run();
}

function dsResponse(content = JSON.stringify(answer), usage) {
  return Response.json({
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: usage || { prompt_tokens: 1200, completion_tokens: 40 },
  });
}

test("F6P1-V1 auto 先走 DeepSeek：data URI、JSON 约束、max_tokens 400、deepseek-flash", async () => {
  const e = env();
  const calls = [];
  const note = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      return dsResponse();
    },
    () => v.describeBytes(e, png, "image/png", "看这张表情", signal()),
  );
  assert.equal(note.desc, answer.desc);
  assert.equal(note.text, answer.text);
  assert.deepEqual(note.tags, answer.tags);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.max_tokens, 400);
  assert.equal(body.stream, false);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.match(String(calls[0].init.headers.Authorization), /^Bearer /);
  const [textPart, imagePart] = body.messages[0].content;
  assert.equal(textPart.type, "text");
  assert.match(textPart.text, /desc/);
  assert.match(textPart.text, /tags/);
  assert.equal(imagePart.type, "image_url");
  assert.equal(imagePart.image_url.url, "data:image/png;base64," + v.b64(png));
});

test("F6P1-V2 settings 可覆盖模型和强制 provider，workers 模式不发 HTTP 模型请求", async () => {
  const e = env();
  await setting(e, "vision:ds_model", "deepseek-vision-x");
  let model;
  await withFetch(
    async (_url, init) => {
      model = JSON.parse(init.body).model;
      return dsResponse();
    },
    () => v.describeBytes(e, png, "image/png", "", signal()),
  );
  assert.equal(model, "deepseek-vision-x");

  const e2 = env();
  await setting(e2, "vision:provider", "workers");
  let http = 0;
  e2.AI = {
    async run() {
      return { response: JSON.stringify({ desc: "本地绑定读图", tags: [], meme: false }) };
    },
  };
  const note = await withFetch(
    async () => {
      http++;
      throw Error("workers 模式不应发 HTTP");
    },
    () => v.describeBytes(e2, png, "image/png", "", signal()),
  );
  assert.equal(note.desc, "本地绑定读图");
  assert.equal(http, 0);
});

test("F6P1-V3 DeepSeek 失败按错误形态分类，auto 降级 Workers AI", async () => {
  const cases = [
    [429, "provider_cap"],
    [401, "provider_denied"],
    [404, "unsupported"],
  ];
  for (const [status, reason] of cases) {
    const e = env();
    await setting(e, "vision:provider", "deepseek");
    let ai = 0;
    e.AI = { async run() { ai++; return { response: JSON.stringify(answer) }; } };
    const events = [];
    const note = await withFetch(
      async () => new Response("upstream said no", { status }),
      () => v.describeBytes(e, png, "image/png", "", signal(), "v1", event => events.push(event)),
    );
    assert.equal(note, null, "deepseek 单挂时不能假装成功");
    assert.equal(events.at(-1)?.status, "failed");
    assert.equal(events.at(-1)?.reason, reason);
    assert.equal(ai, 0, "显式 deepseek 不应偷偷换 workers");
  }

  const e = env();
  let ai = 0;
  e.AI = {
    async run() {
      ai++;
      return { response: JSON.stringify({ desc: "降级读到了", tags: [], meme: false }) };
    },
  };
  const note = await withFetch(
    async () => new Response("quota", { status: 429 }),
    () => v.describeBytes(e, png, "image/png", "", signal()),
  );
  assert.equal(note.desc, "降级读到了");
  assert.equal(ai, 1);
});

test("F6P1-V4 坏 JSON、网络错误、超时都不当成成功", async () => {
  const bad = env();
  await setting(bad, "vision:provider", "deepseek");
  const badEvents = [];
  assert.equal(
    await withFetch(
      async () => dsResponse("not json"),
      () => v.describeBytes(bad, png, "image/png", "", signal(), "v1", event => badEvents.push(event)),
    ),
    null,
  );
  assert.equal(badEvents.at(-1)?.reason, "invalid");

  const net = env();
  await setting(net, "vision:provider", "deepseek");
  const netEvents = [];
  assert.equal(
    await withFetch(
      async () => {
        throw new TypeError("network down");
      },
      () => v.describeBytes(net, png, "image/png", "", signal(), "v1", event => netEvents.push(event)),
    ),
    null,
  );
  assert.equal(netEvents.at(-1)?.reason, "network");

  const slow = env();
  await setting(slow, "vision:provider", "deepseek");
  const controller = new AbortController();
  controller.abort();
  const timeoutEvents = [];
  assert.equal(
    await v.describeBytes(slow, png, "image/png", "", controller.signal, "v1", event => timeoutEvents.push(event)),
    null,
  );
  assert.equal(timeoutEvents.at(-1)?.reason, "timeout");
});

test("F6P1-V5 贴纸/低价值图先 Workers AI，失败再走 DeepSeek", async () => {
  const e = env();
  const order = [];
  e.AI = {
    async run() {
      order.push("workers");
      return { response: JSON.stringify({ desc: "小表情", tags: ["表情"], meme: true }) };
    },
  };
  const image = { kind: "image", url: "https://multimedia.nt.qq.com.cn/small.png", width: 64, height: 64, size: 100 };
  const note = await withFetch(
    async (url) => {
      if (String(url).includes("api.deepseek.com")) {
        order.push("deepseek");
        return dsResponse();
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
    () => v.describeImage(e, image, "", signal()),
  );
  assert.equal(note.desc, "小表情");
  assert.deepEqual(order, ["workers"]);

  const e2 = env();
  const fallback = [];
  e2.AI = {
    async run() {
      fallback.push("workers");
      throw Object.assign(Error("license"), { code: 5016 });
    },
  };
  const note2 = await withFetch(
    async (url) => {
      if (String(url).includes("api.deepseek.com")) {
        fallback.push("deepseek");
        return dsResponse();
      }
      return new Response(png, { headers: { "content-type": "image/png" } });
    },
    () => v.describeImage(e2, image, "", signal()),
  );
  assert.equal(note2.desc, answer.desc);
  assert.deepEqual(fallback, ["workers", "deepseek"]);
});

test("F6P1-V6 书法、手写、低置信文字标「可能有误」，正常文字不动", async () => {
  const e = env();
  await setting(e, "vision:provider", "deepseek");
  const calligraphy = await withFetch(
    async () => dsResponse(JSON.stringify({ desc: "一幅书法作品", text: "自强不息", tags: [], meme: false })),
    () => v.describeBytes(e, png, "image/png", "这写的什么", signal()),
  );
  assert.match(calligraphy.text, /可能有误）/);

  const e2 = env();
  await setting(e2, "vision:provider", "deepseek");
  const clear = await withFetch(
    async () => dsResponse(JSON.stringify({ desc: "聊天截图", text: "明天九点开会", tags: [], meme: false })),
    () => v.describeBytes(e2, png, "image/png", "截图", signal()),
  );
  assert.equal(clear.text, "明天九点开会");

  const e3 = env();
  await setting(e3, "vision:provider", "deepseek");
  const hinted = await withFetch(
    async () => dsResponse(JSON.stringify({ desc: "手写便签", text: "记得买牛奶", tags: [], meme: false })),
    () => v.describeBytes(e3, png, "image/png", "这张是书法吗", signal()),
  );
  assert.match(hinted.text, /可能有误）/);
});

test("F6P1-V7 失败文案如实说看不了 + error_kind，不编内容", () => {
  const notes = new Map();
  v.applyImageOutcomes(notes, [
    { messageId: "m1", idx: 0, stage: "describe", status: "failed", reason: "provider_cap" },
    { messageId: "m2", idx: 0, stage: "fetch", status: "failed", reason: "http", http: 403 },
  ]);
  assert.match(notes.get("m1")[0], /看不了这张图/);
  assert.match(notes.get("m1")[0], /error_kind=budget/);
  assert.match(notes.get("m1")[0], /reason=provider_cap/);
  assert.match(notes.get("m2")[0], /看不了这张图/);
  assert.match(notes.get("m2")[0], /未取得.*HTTP 403/);
  assert.match(notes.get("m2")[0], /请重发图片/);
  assert.doesNotMatch(notes.get("m2")[0], /图片：/);
});

test("F6P1-V8 显式 luna 缺 OpenAI 密钥时跳过 Luna、回退原链", async () => {
  const e = env();
  await setting(e, "vision:provider", "luna");
  let openai = 0;
  e.AI = { async run() { return { response: "{}" }; } };
  const events = [];
  const note = await withFetch(
    async url => {
      if (String(url).includes("api.openai.com")) openai++;
      return dsResponse();
    },
    () => v.describeBytes(e, png, "image/png", "", signal(), "v1", event => events.push(event)),
  );
  assert.equal(note?.desc, answer.desc);
  assert.equal(openai, 0, "缺密钥时不能向 OpenAI 发请求");
  assert.ok(!events.some(ev => ev.reason === "provider_auth"));
});
