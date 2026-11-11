// Optional real-model regression. Uses only synthetic scenes, sends no QQ message.
import { build } from "esbuild";
if (!process.env.DEEPSEEK_API_KEY)
  throw Error("Set DEEPSEEK_API_KEY in the local process environment.");
await build({
  entryPoints: ["src/engagement.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: ".wrangler/eval-engagement.mjs",
});
await build({
  entryPoints: ["src/voice.ts"],
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: ".wrangler/eval-voice.mjs",
});
const { PARTICIPATION, participation } = await import(
  "../.wrangler/eval-engagement.mjs"
);
const { speakBrief, decodeVoice } = await import("../.wrangler/eval-voice.mjs");
const cases = [
  ["笑声", false, "哈哈哈哈绷不住了", { sender: "a" }],
  [
    "成员互聊",
    false,
    "@小王 你先去吃饭吧",
    { addressedOther: true, sender: "a" },
  ],
  ["自己接活", false, "这个bug我自己修，晚点推上去", { sender: "a" }],
  ["附和", false, "确实，我也这么觉得", { sender: "b" }],
  ["直接交办", true, "Bot，帮大肥鱼把方案的验收条件列一下", { sender: "a" }],
  [
    "调侃搭子",
    true,
    "@Bot 你搁这做季度汇报呢",
    { mentioned: true, sender: "a" },
  ],
];
let pass = 0;
const e = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };
for (const [name, expected, body, meta] of cases) {
  const start = Date.now();
  const r = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + e.DEEPSEEK_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "deepseek-flash",
      reasoning_effort: "high",
      max_tokens: 8192,
      messages: [
        { role: "system", content: PARTICIPATION },
        {
          role: "user",
          content: JSON.stringify({
            latest: { body, meta },
            newMessages: [{ body, meta }],
            conversation: [],
          }),
        },
      ],
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!r.ok) throw Error("model HTTP " + r.status);
  const d = await r.json(),
    p = participation(d.choices[0].message.content);
  const ok = p.should_reply === expected;
  if (ok) pass++;
  console.log(
    JSON.stringify({
      scene: name,
      expected,
      actual: p.should_reply,
      ok,
      ms: Date.now() - start,
    }),
  );
}
for (const [name, body, brief] of [
  [
    "闲聊",
    "你搁这做季度汇报呢",
    "群友调侃你太一本正经，接一下气氛，自嘲但不要解释工作流程。",
  ],
  [
    "正式工作",
    "认真说，验收条件怎么定",
    "验收条件为 /api/health 返回200，超时5秒，最多2次重试。只列条件，不承诺已经执行。",
  ],
  [
    "未知梗",
    "这下赛博炒凉粉了",
    "无法确定本群这个新说法的意思，短问一句，不装懂。",
  ],
]) {
  const start = Date.now();
  const v = decodeVoice(
    await speakBrief(e, { facts: brief }, { latest: { body } }),
  );
  console.log(
    JSON.stringify({
      voice: name,
      mode: v.mode,
      text: v.text,
      ms: Date.now() - start,
    }),
  );
}
console.log(JSON.stringify({ participationPass: pass, total: cases.length }));
if (pass !== cases.length) process.exitCode = 1;
