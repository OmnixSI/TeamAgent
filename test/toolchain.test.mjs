import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const {
  FFMPEG_CANDIDATES,
  ffmpegToolchain,
  ffprobeToolchain,
  preflightTools,
  requireTool,
} = await import("../runner/toolchain.mjs");
const { synthesize } = await import("../runner/tts.mjs");
const { runCommand } = await import("../runner/asr.mjs");

const minimalEnv = () => ({ PATH: "/usr/bin:/bin", HOME: os.homedir() });

test("ffmpeg resolves to an absolute binary when launchd's PATH has no Homebrew", () => {
  const tool = ffmpegToolchain({ env: minimalEnv() });
  assert.equal(tool.ok, true, tool.error);
  assert.ok(path.isAbsolute(tool.path));
  assert.equal(path.basename(tool.path), "ffmpeg");
  // It must come from the standard Homebrew location, not from a PATH entry.
  assert.ok(FFMPEG_CANDIDATES.includes(tool.path) || tool.source === "PATH");
  assert.notEqual(tool.source, "PATH");
});

test("FFMPEG_BIN wins over every other location", () => {
  const tool = ffmpegToolchain({ env: { ...minimalEnv(), FFMPEG_BIN: process.execPath } });
  assert.equal(tool.ok, true);
  assert.equal(tool.path, process.execPath);
  assert.equal(tool.source, "FFMPEG_BIN");
});

test("a broken FFMPEG_BIN is reported, never silently replaced", () => {
  const tool = ffmpegToolchain({
    env: { ...minimalEnv(), FFMPEG_BIN: "/definitely/not/here/ffmpeg" },
  });
  assert.equal(tool.ok, false);
  assert.equal(tool.path, "/definitely/not/here/ffmpeg");
  assert.match(tool.error, /FFMPEG_BIN/);
});

test("ffprobe follows the resolved ffmpeg directory", () => {
  const ffmpeg = ffmpegToolchain({ env: minimalEnv() });
  const ffprobe = ffprobeToolchain({ env: minimalEnv() });
  const sibling = path.join(path.dirname(ffmpeg.path), "ffprobe");
  if (fs.existsSync(sibling)) {
    assert.equal(ffprobe.ok, true, ffprobe.error);
    assert.equal(ffprobe.path, sibling);
  } else {
    assert.equal(typeof ffprobe.ok, "boolean");
  }
});

test("missing tools list the standard locations instead of blaming ASR", () => {
  const tools = preflightTools({
    env: { PATH: "" },
    isExecutable: () => false,
  });
  assert.equal(tools.ffmpeg.ok, false);
  assert.equal(tools.ffprobe.ok, false);
  assert.match(tools.ffmpeg.error, /\/opt\/homebrew\/bin\/ffmpeg/);
  assert.match(tools.ffmpeg.error, /PATH/);
  assert.doesNotMatch(tools.ffmpeg.error, /asr_unavailable/);
});

test("requireTool keeps the caller's error name", () => {
  assert.throws(
    () => requireTool({ ok: false, error: "ffmpeg missing" }, "tts_tool_missing"),
    (error) => error.reason === "tts_tool_missing" && error.message === "ffmpeg missing",
  );
});

test("runCommand maps a missing TTS binary to tts_tool_missing, not asr_unavailable", async () => {
  await assert.rejects(
    runCommand("/definitely/not/here/ffmpeg", [], {
      timeoutMs: 5000,
      missingReason: "tts_tool_missing",
    }),
    (error) => error.reason === "tts_tool_missing",
  );
  await assert.rejects(
    runCommand("/definitely/not/here/asr-python", [], { timeoutMs: 5000 }),
    (error) => error.reason === "asr_unavailable",
  );
});

test("synthesize reports a missing ffmpeg as tts_tool_missing, never asr_unavailable", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-tts-missing-ffmpeg-"));
  const logs = [];
  try {
    const result = await synthesize("你好。", { enabled: true }, {
      cacheDir: path.join(dir, "cache"),
      env: { ...minimalEnv(), FFMPEG_BIN: "/definitely/not/here/ffmpeg" },
      log: (line) => logs.push(line),
      runCommand: async (_command, args) => {
        const index = args.indexOf("--write-media");
        if (index >= 0) fs.writeFileSync(args[index + 1], "ID3mp3");
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result, null);
    assert.ok(logs.some((line) => line.includes("tts_tool_missing")), logs.join("\n"));
    assert.equal(logs.some((line) => line.includes("asr_unavailable")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeWav(file, seconds = 0.1, sampleRate = 24000) {
  const samples = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(samples * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

test("TTS conversion chain works under env -i with launchd's minimal PATH", () => {
  const ffmpeg = ffmpegToolchain({ env: minimalEnv() });
  if (!ffmpeg.ok) return; // A machine without ffmpeg cannot exercise this path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-tts-env-i-"));
  try {
    const input = path.join(dir, "in.wav");
    const output = path.join(dir, "out.wav");
    writeWav(input);
    const moduleUrl = pathToFileURL(
      path.join(path.dirname(new URL(import.meta.url).pathname), "../runner/tts.mjs"),
    ).href;
    const script = `
      import { normalizeAudio } from ${JSON.stringify(moduleUrl)};
      const result = await normalizeAudio(process.env.IN, process.env.OUT);
      console.log(JSON.stringify({ bin: result.bin, code: result.code }));
    `;
    const child = spawnSync(
      "/usr/bin/env",
      [
        "-i",
        "PATH=/usr/bin:/bin",
        "IN=" + input,
        "OUT=" + output,
        process.execPath,
        "--input-type=module",
        "-e",
        script,
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const info = JSON.parse(String(child.stdout).trim());
    assert.equal(info.code, 0);
    assert.ok(path.isAbsolute(info.bin));
    assert.equal(path.basename(info.bin), "ffmpeg");
    const bytes = fs.readFileSync(output);
    assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString(), "WAVE");
    assert.ok(bytes.length > 1000, "converted audio must not be empty");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
