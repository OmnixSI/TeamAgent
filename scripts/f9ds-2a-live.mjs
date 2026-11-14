#!/usr/bin/env node
// DS-2a live evidence: two real DeepSeek TTS sentences -> 24 kHz WAV -> SILK
// -> decode back to WAV, compare durations, and run the local X-ASR over the
// 16 kHz copy to check intelligibility. No QQ upload, no group message, no D1.
//
// Requires DEEPSEEK_API_KEY_FILE (private file, never printed). silk-wasm is
// loaded from SILK_WASM_MODULE when the worktree dependency is not installed
// yet (the lead installs silk-wasm@3.7.1 into the runner dependencies).
//
//   DEEPSEEK_API_KEY_FILE=... SILK_WASM_MODULE=/tmp/.../lib/index.mjs \
//   node scripts/f9ds-2a-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { synthesize } from "../runner/tts.mjs";
import { wavToSilk, decodeSilkToWav, wavDurationMs, isSilkData } from "../runner/silk.mjs";

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "teamagent-test-f9ds-2a-live-"));
const CASES = [
  { id: "zh", text: "今天的进度我发群里了，你看一下。" },
  { id: "mix", text: "这次改动把 ASR 从本机搬到云端，延迟大概两秒，但不用再占 500MB 内存。" },
];
const PRICE_MICRO_USD_PER_10K = 225_000;
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const billed = (text) => [...text].reduce((sum, ch) => sum + (HAN.test(ch) ? 2 : 1), 0);

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16);
}

function ffprobe(file) {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
    { encoding: "utf8" },
  );
  return Number(JSON.parse(out)?.format?.duration);
}

function to16k(src, dst) {
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error", "-i", src,
    "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-y", dst,
  ]);
}

function asrConfig() {
  try {
    const config = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".inkboard-team", "config.json"), "utf8"),
    );
    return config?.asr || {};
  } catch {
    return {};
  }
}

function transcribe(wav) {
  const config = asrConfig();
  const python =
    process.env.XASR_PYTHON ||
    config.python ||
    path.join(os.homedir(), ".inkboard-team", "xasr-venv/bin/python");
  const model =
    process.env.XASR_MODEL_DIR ||
    config.model_dir ||
    path.join(
      os.homedir(),
      "Library/Application Support/NextThought/models/sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03",
    );
  const script = fileURLToPath(new URL("../runner/xasr_transcribe.py", import.meta.url));
  const out = execFileSync(python, ["-u", script, wav, "--model-dir", model], {
    encoding: "utf8",
    timeout: 180_000,
  });
  const lines = out.trim().split("\n").filter(Boolean);
  const result = JSON.parse(lines.at(-1));
  return result.segments.map((s) => s.text).join("");
}

const keyFile = process.env.DEEPSEEK_API_KEY_FILE;
if (!keyFile) {
  console.error("DEEPSEEK_API_KEY_FILE is not set; refusing to call the paid API.");
  process.exit(2);
}
const clientPath =
  process.env.DS_CLIENT_PATH ||
  fileURLToPath(new URL("../runner/deepseek-client.mjs", import.meta.url));
if (!fs.existsSync(clientPath)) {
  console.error("runner/deepseek-client.mjs (DS-0) is not available; set DS_CLIENT_PATH.");
  process.exit(2);
}
const { callDs } = await import(pathToFileURL(clientPath).href);

let silkModule = null;
try {
  silkModule = await import("silk-wasm");
} catch {}
const silkModulePath = process.env.SILK_WASM_MODULE;
const loadSilk =
  silkModule || silkModulePath
    ? () => (silkModule ? Promise.resolve(silkModule) : import(pathToFileURL(silkModulePath).href))
    : null;
if (!loadSilk) {
  console.error("silk-wasm is not installed; set SILK_WASM_MODULE to its lib/index.mjs.");
  process.exit(2);
}

let spentMicro = 0;
const rows = [];
try {
  for (const item of CASES) {
    const started = Date.now();
    const audio = await synthesize(
      item.text,
      {
        enabled: true,
        provider: "deepseek",
        max_chars: 300,
        cache_dir: path.join(OUT, "cache"),
        timeout_ms: 60_000,
        deepseek_voice: "stella",
      },
      {
        callDs: (purpose, options) => callDs(purpose, options),
        log: (line) => console.error("[tts]", line),
      },
    );
    if (!audio?.path) throw new Error(`${item.id}: DeepSeek TTS returned no audio`);
    const synthMs = Date.now() - started;
    const wavBytes = fs.readFileSync(audio.path);
    const wavMs = wavDurationMs(wavBytes);
    const silk = await wavToSilk(audio.path, { tmpDir: OUT }, { loadSilk });
    if (!silk.ok) throw new Error(`${item.id}: ${silk.error_kind} ${silk.reason_text}`);
    const decoded = await decodeSilkToWav(silk.data, {}, { loadSilk });
    if (!decoded.ok) throw new Error(`${item.id}: ${decoded.error_kind}`);
    const decodedPath = path.join(OUT, `${item.id}-decoded.wav`);
    fs.writeFileSync(decodedPath, Buffer.from(decoded.wav));
    const silkPath = path.join(OUT, `${item.id}.silk`);
    fs.writeFileSync(silkPath, Buffer.from(silk.data));

    const wav16 = path.join(OUT, `${item.id}-16k.wav`);
    to16k(audio.path, wav16);
    const transcript = transcribe(wav16);

    const chars = billed(item.text);
    const cost = Math.round((chars * PRICE_MICRO_USD_PER_10K) / 10_000);
    spentMicro += cost;
    rows.push({
      id: item.id,
      chars,
      text_chars: [...item.text].length,
      synth_ms: synthMs,
      provider: audio.provider,
      wav_bytes: wavBytes.length,
      wav_ms: wavMs,
      wav_ffprobe_s: ffprobe(audio.path),
      silk_bytes: silk.data.length,
      silk_ms: silk.duration_ms,
      silk_magic: isSilkData(silk.data),
      decoded_bytes: decoded.pcm.length,
      decoded_ms: decoded.duration_ms,
      decoded_ffprobe_s: ffprobe(decodedPath),
      transcript,
      sha256_16: sha256(silkPath),
      cost_micro_usd: cost,
    });
  }
  const totalCost = spentMicro / 1_000_000;
  console.log(
    JSON.stringify(
      {
        ok: true,
        cases: rows,
        estimated_cost_usd: Number(totalCost.toFixed(6)),
        qq_uploaded: 0,
        d1_rows_written: 0,
      },
      null,
      2,
    ),
  );
  if (totalCost > 0.01) {
    console.error(`estimated cost $${totalCost.toFixed(6)} exceeds the $0.01 budget`);
    process.exitCode = 3;
  }
} finally {
  fs.rmSync(OUT, { recursive: true, force: true });
}
