import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
await build({
  entryPoints: ["src/tts-policy.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/tts-policy-routing.mjs",
});
const { shouldVoice, voiceSkipReason } = await import(
  "../.wrangler/tts-policy-routing.mjs"
);
const cfg = { enabled: true, max_chars: 300, voice: "zh-CN-XiaoxiaoNeural" };
const care = (text, extra = {}) => shouldVoice(text, "care", { ...cfg, ...extra });
const reason = (text, mode = "care", extra = {}) =>
  voiceSkipReason(text, mode, { ...cfg, ...extra });

test("care and banter short plain replies are spoken", () => {
  assert.equal(care("明天九点提醒你开评审会。"), true);
  assert.equal(shouldVoice("先去睡吧，我把剩下的跑完。", "banter", cfg), true);
  assert.equal(reason("明天九点提醒你开评审会。"), "ok");
});

test("only care and banter modes are spoken", () => {
  for (const mode of ["work", "important-proposal", "quick", "", undefined])
    assert.equal(shouldVoice("明天九点提醒你开评审会。", mode, cfg), false);
  assert.equal(reason("好的", "work"), "mode");
});

test("the gray switch is fail-closed", () => {
  for (const enabled of [false, undefined, null, "true", 1])
    assert.equal(shouldVoice("好的，我记下了。", "care", { ...cfg, enabled }), false);
  assert.equal(reason("好的", "care", { enabled: false }), "disabled");
  assert.equal(shouldVoice("好的", "care", undefined), false);
});

test("over 300 characters falls back to text, exactly 300 is spoken", () => {
  assert.equal(care("字".repeat(300)), true);
  assert.equal(care("字".repeat(301)), false);
  assert.equal(reason("字".repeat(301)), "too_long");
  // Emoji count as one character each, not two UTF-16 code units.
  assert.equal(care("🙂".repeat(300)), true);
  assert.equal(care("🙂".repeat(301)), false);
});

test("configured max_chars can shorten but never exceed the 300 hard cap", () => {
  assert.equal(care("字".repeat(11), { max_chars: 10 }), false);
  assert.equal(care("字".repeat(10), { max_chars: 10 }), true);
  assert.equal(care("字".repeat(500), { max_chars: 5000 }), false);
  assert.equal(care("字".repeat(300), { max_chars: 5000 }), true);
  // Malformed values fall back to the default instead of opening the gate.
  for (const max_chars of [0, -1, 1.5, "300", null, NaN])
    assert.equal(care("字".repeat(301), { max_chars }), false);
});

test("code blocks and inline code fall back to text", () => {
  assert.equal(care("看这个：\n```js\nconsole.log(1)\n```"), false);
  assert.equal(reason("看这个：\n```js\nx\n```"), "code");
  assert.equal(care("跑 `npm test` 就行"), false);
  assert.equal(reason("跑 `npm test` 就行"), "code");
});

test("links of every common shape fall back to text", () => {
  const links = [
    "见 https://example.com/a?b=1",
    "看 www.example.com",
    "文档在 [这里](https://example.com/doc)",
    "仓库 github.com/OmnixSI/TeamAgent",
    "站点 example.cn",
  ];
  for (const text of links) {
    assert.equal(care(text), false, text);
    assert.equal(reason(text), "link", text);
  }
});

test("empty, whitespace and non-string replies are never spoken", () => {
  for (const reply of ["", "   ", "\n", null, undefined, 42, ["好的"]])
    assert.equal(shouldVoice(reply, "care", cfg), false);
  assert.equal(reason("   "), "empty");
});

test("spoken text is trimmed before the length check", () => {
  assert.equal(care("  " + "字".repeat(300) + "  "), true);
  assert.equal(care("\n" + "字".repeat(301) + "\n"), false);
});
