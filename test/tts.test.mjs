import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { build } from "esbuild";
await build({
  entryPoints: ["src/tts-policy.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  outfile: ".wrangler/tts-policy-gateway.mjs",
});
const { shouldVoice } = await import("../.wrangler/tts-policy-gateway.mjs");
const { synthesize, voiceReply, pruneCache, ttsKey, edgeTtsCommand, EDGE_VOICE } =
  await import("../runner/tts.mjs");

const cfg = { enabled: true, max_chars: 300, voice: EDGE_VOICE, rate: "+0%" };
const FAKE_SILK = Buffer.concat([Buffer.from([0x02]), Buffer.from("#!SILK_V3"), Buffer.alloc(16, 5)]);
const fakeSilk = async () => ({ ok: true, data: FAKE_SILK, duration_ms: 1000, sample_rate: 24000 });
const scratch = (prefix = "tts-test-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cacheDir: path.join(dir, "cache"), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
};
const fakeBot = ({ voiceFails = false } = {}) => {
  const calls = [];
  return {
    calls,
    async sendVoice(target, source) {
      calls.push({ kind: "voice", target, source });
      if (voiceFails) throw new Error("upload failed");
      return { message: { id: "v1" } };
    },
    async sendText(target, content) {
      calls.push({ kind: "text", target, content });
      return { id: "t1" };
    },
  };
};
// The gateway decision under test: policy first, then voice with a text fallback.
async function gatewayReplay({ text, mode = "care", settings = cfg, bot, deps = {} }) {
  const target = { scope: "group", targetId: "g1" };
  if (!shouldVoice(text, mode, settings)) {
    await bot.sendText(target, text);
    return { via: "text", reason: "policy" };
  }
  return voiceReply({ bot, group: "g1", text, cfg: settings, deps: { wavToSilk: fakeSilk, ...deps } });
}
const audioFixture = (dir) => {
  const file = path.join(dir, "reply.wav");
  fs.writeFileSync(file, "RIFF0000WAVEfmt ");
  return file;
};

test("fake gateway replay: a care reply goes out as voice, not text", async () => {
  const s = scratch();
  try {
    const bot = fakeBot();
    const file = audioFixture(s.dir);
    const result = await gatewayReplay({
      text: "明天九点提醒你开评审会。",
      bot,
      deps: { synthesize: async () => ({ path: file, key: "k", cached: false }) },
    });
    assert.equal(result.via, "voice");
    assert.deepEqual(bot.calls.map((c) => c.kind), ["voice"]);
    assert.deepEqual(bot.calls[0].target, { scope: "group", targetId: "g1" });
    assert.ok(bot.calls[0].source.buffer.equals(FAKE_SILK));
    assert.equal(result.silk_bytes, FAKE_SILK.length);
  } finally {
    s.clean();
  }
});

test("fake gateway replay: overlong, code, link, work and disabled replies stay text", async () => {
  const s = scratch();
  try {
    const cases = [
      { text: "字".repeat(301), mode: "care" },
      { text: "跑 `npm test` 就行", mode: "care" },
      { text: "见 https://example.com/x", mode: "care" },
      { text: "明天九点提醒你开评审会。", mode: "work" },
      { text: "明天九点提醒你开评审会。", mode: "care", settings: { ...cfg, enabled: false } },
    ];
    for (const item of cases) {
      const bot = fakeBot();
      let synthesized = 0;
      const result = await gatewayReplay({
        ...item,
        bot,
        deps: { synthesize: async () => ((synthesized += 1), { path: audioFixture(s.dir) }) },
      });
      assert.equal(result.via, "text", item.text);
      assert.equal(synthesized, 0, "policy rejection must not synthesize");
      assert.deepEqual(bot.calls.map((c) => c.kind), ["text"], item.text);
      assert.equal(bot.calls[0].content, item.text);
    }
  } finally {
    s.clean();
  }
});

test("fake gateway replay: a tts failure falls back to the original text", async () => {
  const s = scratch();
  try {
    const bot = fakeBot();
    const result = await gatewayReplay({
      text: "我在，慢慢说。",
      bot,
      deps: { synthesize: async () => null },
    });
    assert.equal(result.via, "text");
    assert.equal(result.reason, "tts_failed");
    assert.deepEqual(bot.calls.map((c) => c.kind), ["text"]);
    assert.equal(bot.calls[0].content, "我在，慢慢说。");
  } finally {
    s.clean();
  }
});

test("fake gateway replay: a throwing synth or failed voice upload falls back to text", async () => {
  const s = scratch();
  try {
    for (const [label, deps, voiceFails] of [
      ["synth throws", { synthesize: async () => { throw new Error("edge-tts missing"); } }, false],
      ["upload fails", { synthesize: async () => ({ path: audioFixture(s.dir) }) }, true],
    ]) {
      const bot = fakeBot({ voiceFails });
      const result = await gatewayReplay({ text: "我在，慢慢说。", bot, deps });
      assert.equal(result.via, "text", label);
      assert.equal(bot.calls.at(-1).kind, "text", label);
      assert.equal(bot.calls.at(-1).content, "我在，慢慢说。", label);
    }
  } finally {
    s.clean();
  }
});

test("voiceReply refuses to synthesize when the gray switch is off", async () => {
  const bot = fakeBot();
  let synthesized = 0;
  const result = await voiceReply({
    bot,
    group: "g1",
    text: "我在。",
    cfg: { ...cfg, enabled: false },
    deps: { synthesize: async () => ((synthesized += 1), null) },
  });
  assert.equal(result.via, "text");
  assert.equal(result.reason, "disabled");
  assert.equal(synthesized, 0);
});

// A fake CLI: writes the mp3 that edge-tts would write, then the wav that ffmpeg would write.
function fakeCli({ fail = null, onCall } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push({ command, args });
    onCall?.(command, args);
    if (fail === "timeout") throw Object.assign(new Error("tts_timeout"), { reason: "tts_timeout" });
    if (fail === "missing") throw Object.assign(new Error("spawn edge-tts ENOENT"), { code: "ENOENT" });
    if (command === "ffmpeg") fs.writeFileSync(args.at(-1), "RIFFwav");
    else fs.writeFileSync(args[args.indexOf("--write-media") + 1], "ID3mp3");
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

test("synthesize renders 24 kHz mono wav through the edge-tts CLI and leaves no temp files", async () => {
  const s = scratch();
  try {
    const cli = fakeCli();
    const result = await synthesize(
      "明天九点提醒你开评审会。",
      cfg,
      { runCommand: cli.run, cacheDir: s.cacheDir, now: () => 1_700_000_000_000 },
    );
    assert.ok(result?.path, "expected a wav path");
    assert.equal(result.cached, false);
    assert.equal(path.dirname(result.path), s.cacheDir);
    assert.equal(fs.readFileSync(result.path, "utf8"), "RIFFwav");
    const ffmpeg = cli.calls.find((c) => c.command === "ffmpeg");
    assert.ok(ffmpeg, "ffmpeg must be called");
    for (const arg of ["-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le"])
      assert.ok(ffmpeg.args.includes(arg), arg);
    const tts = cli.calls[0];
    assert.ok(tts.args.includes(EDGE_VOICE));
    assert.ok(tts.args.includes("--text"));
    // Only the cached wav survives; the per-call work directory is gone.
    assert.deepEqual(fs.readdirSync(s.cacheDir), [path.basename(result.path)]);
  } finally {
    s.clean();
  }
});

test("synthesize reuses the 1 hour cache and re-renders once it expires", async () => {
  const s = scratch();
  try {
    const cli = fakeCli();
    const now = Date.now();
    const first = await synthesize("到点了，喝水。", cfg, { runCommand: cli.run, cacheDir: s.cacheDir, now: () => now });
    const hit = await synthesize("到点了，喝水。", cfg, {
      runCommand: async () => assert.fail("cache hit must not spawn a process"),
      cacheDir: s.cacheDir,
      now: () => now + 59 * 60_000,
    });
    assert.equal(hit.cached, true);
    assert.equal(hit.path, first.path);
    const expired = await synthesize("到点了，喝水。", cfg, {
      runCommand: cli.run,
      cacheDir: s.cacheDir,
      now: () => now + 61 * 60_000,
    });
    assert.equal(expired.cached, false);
    assert.equal(expired.key, first.key);
  } finally {
    s.clean();
  }
});

test("synthesize returns null on timeout, missing CLI or non-zero exit and cleans up", async () => {
  const s = scratch();
  try {
    for (const fail of ["timeout", "missing"]) {
      const cli = fakeCli({ fail });
      const result = await synthesize("我在。", cfg, { runCommand: cli.run, cacheDir: s.cacheDir });
      assert.equal(result, null, fail);
      const leftovers = fs.existsSync(s.cacheDir) ? fs.readdirSync(s.cacheDir) : [];
      assert.deepEqual(leftovers, [], fail + " must not leave temp files");
    }
    const broken = await synthesize("我在。", cfg, {
      runCommand: async (command, args) => { fs.writeFileSync(args.at(-1), ""); return { code: 3 }; },
      cacheDir: s.cacheDir,
    });
    assert.equal(broken, null);
    assert.deepEqual(fs.readdirSync(s.cacheDir), []);
  } finally {
    s.clean();
  }
});

test("synthesize refuses empty or over-300-character text without spawning", async () => {
  const s = scratch();
  try {
    for (const text of ["", "   ", "字".repeat(301), null]) {
      const result = await synthesize(text, cfg, {
        runCommand: async () => assert.fail("must not spawn"),
        cacheDir: s.cacheDir,
      });
      assert.equal(result, null);
    }
  } finally {
    s.clean();
  }
});

test("cache keys separate text, voice and rate; pruning drops expired and excess audio", async () => {
  assert.equal(ttsKey("你好", "v1", "+0%"), ttsKey("你好", "v1", "+0%"));
  assert.notEqual(ttsKey("你好", "v1", "+0%"), ttsKey("你好", "v2", "+0%"));
  assert.notEqual(ttsKey("你好", "v1", "+0%"), ttsKey("你好", "v1", "+10%"));
  assert.equal(ttsKey("你好", "v1", "+0%").length, 64);
  assert.equal(
    ttsKey("你好", "v1", "+0%"),
    crypto.createHash("sha256").update("edge|v1|+0%|你好").digest("hex"),
  );
  const s = scratch();
  try {
    fs.mkdirSync(s.cacheDir, { recursive: true });
    const old = path.join(s.cacheDir, "old.wav");
    const fresh = path.join(s.cacheDir, "fresh.wav");
    fs.writeFileSync(old, "x".repeat(10));
    fs.writeFileSync(fresh, "y".repeat(10));
    fs.utimesSync(old, new Date(1_000), new Date(1_000));
    const now = Date.now();
    const pruned = pruneCache(s.cacheDir, { ttlMs: 3_600_000, now, maxFiles: 10, maxBytes: 1024 });
    assert.equal(pruned.removed, 1);
    assert.deepEqual(fs.readdirSync(s.cacheDir), ["fresh.wav"]);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    s.clean();
  }
});

test("edge-tts resolution prefers configuration, then the runner venv, then PATH", () => {
  assert.deepEqual(edgeTtsCommand({ edge_tts: "/opt/x/edge-tts" }), { command: "/opt/x/edge-tts", args: [] });
  assert.deepEqual(edgeTtsCommand({ edge_tts: ["/usr/bin/python3", "-m", "edge_tts"] }), { command: "/usr/bin/python3", args: ["-m", "edge_tts"] });
  const s = scratch();
  try {
    const fake = path.join(s.dir, ".inkboard-team/venv/bin/edge-tts");
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, "#!/bin/sh\n");
    assert.deepEqual(edgeTtsCommand({}, { home: s.dir }), { command: fake, args: [] });
    assert.deepEqual(edgeTtsCommand({}, { home: path.join(s.dir, "nowhere") }), { command: "edge-tts", args: [] });
  } finally {
    s.clean();
  }
});
