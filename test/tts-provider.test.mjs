import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesize, ttsKey, HARD_MAX_CHARS } from "../runner/tts.mjs";

const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-tts-provider-"));
  return { dir, cacheDir: path.join(dir, "cache"), clean: () => fs.rmSync(dir, { recursive: true, force: true }) };
};

const WAV = Buffer.concat([
  Buffer.from("RIFF"),
  Buffer.alloc(4),
  Buffer.from("WAVEfmt "),
  Buffer.alloc(64, 1),
]);

const fakeRun = (log, { edgeFails = false } = {}) => async (command, args) => {
  log.push({ command, args: args.slice() });
  if (path.basename(command) === "ffmpeg") {
    fs.writeFileSync(args.at(-1), WAV);
    return { code: 0, stdout: "", stderr: "" };
  }
  if (edgeFails) throw Object.assign(new Error("spawn edge-tts ENOENT"), { code: "ENOENT" });
  fs.writeFileSync(args[args.indexOf("--write-media") + 1], "ID3");
  return { code: 0, stdout: "", stderr: "" };
};

const okDs = (bytes = WAV) => async () => ({ ok: true, bytes, status: 200, latency_ms: 12 });
const failDs = (error_kind = "quota") => async () => ({
  ok: false,
  error_kind,
  retryable: false,
  reason_text: "额度不够",
});

test("auto prefers the free edge path and never calls DeepSeek when edge works", async () => {
  const s = scratch();
  try {
    const calls = [];
    const result = await synthesize(
      "今天先做到这里。",
      { enabled: true, provider: "auto", max_chars: 300 },
      {
        cacheDir: s.cacheDir,
        runCommand: fakeRun(calls),
        callDs: async () => assert.fail("DeepSeek must not be called when edge succeeds"),
      },
    );
    assert.equal(result.provider, "edge");
    assert.equal(result.cached, false);
    assert.ok(calls.some((c) => path.basename(c.command) === "ffmpeg"));
    assert.deepEqual(fs.readdirSync(s.cacheDir), [path.basename(result.path)]);
  } finally {
    s.clean();
  }
});

test("auto falls back to DeepSeek TTS when edge-tts is unavailable", async () => {
  const s = scratch();
  try {
    const calls = [];
    const requests = [];
    const result = await synthesize(
      "这次改动的核心是把语音搬到云端。",
      { enabled: true, provider: "auto", max_chars: 300 },
      {
        cacheDir: s.cacheDir,
        runCommand: fakeRun(calls, { edgeFails: true }),
        callDs: async (purpose, options) => {
          requests.push({ purpose, options });
          return { ok: true, bytes: WAV, status: 200, latency_ms: 12 };
        },
      },
    );
    assert.equal(result.provider, "deepseek");
    assert.equal(result.path.endsWith(".wav"), true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].purpose, "tts");
    assert.equal(requests[0].options.json.voice_id, "stella");
    assert.equal(requests[0].options.json.format, "wav");
    assert.equal(requests[0].options.json.filter_markdown, true);
    assert.equal(requests[0].options.expect, "bytes");
    assert.ok(requests[0].options.timeoutMs > 0);
  } finally {
    s.clean();
  }
});

test("explicit deepseek provider falls back to edge and then to null", async () => {
  const s = scratch();
  try {
    const calls = [];
    const viaEdge = await synthesize(
      "先走云端，失败再走本机。",
      { enabled: true, provider: "deepseek", max_chars: 300 },
      { cacheDir: s.cacheDir, runCommand: fakeRun(calls), callDs: failDs("upstream") },
    );
    assert.equal(viaEdge.provider, "edge");
    assert.ok(viaEdge.path);

    const both = await synthesize(
      "两条路都失败就回文字。",
      { enabled: true, provider: "deepseek", max_chars: 300 },
      {
        cacheDir: s.cacheDir,
        runCommand: fakeRun([], { edgeFails: true }),
        callDs: failDs("timeout"),
      },
    );
    assert.equal(both, null);
    assert.deepEqual(fs.readdirSync(s.cacheDir), [path.basename(viaEdge.path)]);
  } finally {
    s.clean();
  }
});

test("over-limit text is refused before any provider is called", async () => {
  const s = scratch();
  try {
    for (const text of ["字".repeat(HARD_MAX_CHARS + 1), "", "   "]) {
      const result = await synthesize(
        text,
        { enabled: true, provider: "auto" },
        {
          cacheDir: s.cacheDir,
          runCommand: async () => assert.fail("must not spawn"),
          callDs: async () => assert.fail("must not call DeepSeek"),
        },
      );
      assert.equal(result, null);
    }
  } finally {
    s.clean();
  }
});

test("cache is keyed by provider and a hit skips the DeepSeek call", async () => {
  const s = scratch();
  try {
    const now = 1_700_000_000_000;
    let calls = 0;
    const cfg = { enabled: true, provider: "deepseek", max_chars: 300 };
    const first = await synthesize("缓存这句话。", cfg, {
      cacheDir: s.cacheDir,
      now: () => now,
      runCommand: fakeRun([]),
      callDs: async () => {
        calls += 1;
        return { ok: true, bytes: WAV, status: 200, latency_ms: 1 };
      },
    });
    const second = await synthesize("缓存这句话。", cfg, {
      cacheDir: s.cacheDir,
      now: () => now + 60_000,
      runCommand: async () => assert.fail("cache hit must not spawn"),
      callDs: async () => assert.fail("cache hit must not call DeepSeek"),
    });
    assert.equal(calls, 1);
    assert.equal(second.cached, true);
    assert.equal(second.key, first.key);
    assert.notEqual(
      ttsKey("缓存这句话。", "stella", "", "deepseek"),
      ttsKey("缓存这句话。", "zh-CN-XiaoxiaoNeural", "+0%", "edge"),
    );
  } finally {
    s.clean();
  }
});

test("unknown provider values degrade to auto instead of failing", async () => {
  const s = scratch();
  try {
    const calls = [];
    const result = await synthesize(
      "配置写错也不能哑掉。",
      { enabled: true, provider: "nonsense" },
      { cacheDir: s.cacheDir, runCommand: fakeRun(calls), callDs: failDs() },
    );
    assert.equal(result.provider, "edge");
    assert.ok(result.path);
  } finally {
    s.clean();
  }
});
