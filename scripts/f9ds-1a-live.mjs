#!/usr/bin/env node
/**
 * F9DS-1a real-chain evidence: TTS-produced SILK -> decode -> 16 kHz WAV ->
 * DeepSeek cloud ASR. The key is read from DEEPSEEK_API_KEY_FILE; neither the
 * key nor its path is printed. Temporary files live under /tmp and are removed.
 *
 * During parallel development DS-0/DS-2a may not be merged yet, so the runner
 * directories can be pointed at their worktrees:
 *   DEEPSEEK_CLIENT_DIR=... SILK_MODULE_DIR=... node scripts/f9ds-1a-live.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = process.env.F9DS_SILK_SAMPLE;
const keyFile = process.env.DEEPSEEK_API_KEY_FILE;
if (!keyFile) {
  console.error("DEEPSEEK_API_KEY_FILE is not set");
  process.exit(2);
}
if (!SAMPLE) {
  console.error("F9DS_SILK_SAMPLE is not set (path to a real .silk file)");
  process.exit(2);
}
if (!fs.existsSync(SAMPLE)) {
  console.error("SILK sample not found: " + SAMPLE);
  process.exit(2);
}

const clientDir = process.env.DEEPSEEK_CLIENT_DIR || path.join(ROOT, "runner");
const silkDir = process.env.SILK_MODULE_DIR || path.join(ROOT, "runner");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "f9ds-1a-live-"));
const cost = ms => Math.round((Math.max(0, ms) * 58000) / 3600000);

try {
  fs.mkdirSync(path.join(tmp, "runner"), { recursive: true });
  for (const [from, name] of [
    [path.join(silkDir, "silk.mjs"), "silk.mjs"],
    [path.join(silkDir, "asr.mjs"), "asr.mjs"],
    [path.join(clientDir, "deepseek-client.mjs"), "deepseek-client.mjs"],
  ]) {
    if (!fs.existsSync(from)) {
      if (name === "silk.mjs") console.error("silk.mjs not found (merge DS-2a or set SILK_MODULE_DIR)");
      else if (name === "deepseek-client.mjs") console.error("deepseek-client.mjs not found (merge DS-0 or set DEEPSEEK_CLIENT_DIR)");
      else console.error(name + " not found");
      process.exit(2);
    }
    fs.copyFileSync(from, path.join(tmp, "runner", name));
  }
  if (!fs.existsSync(path.join(silkDir, "asr.mjs")))
    fs.copyFileSync(path.join(ROOT, "runner", "asr.mjs"), path.join(tmp, "runner", "asr.mjs"));

  execFileSync("npm", ["install", "--prefix", tmp, "--cache", path.join(tmp, "npm-cache"), "silk-wasm@3.7.1", "--no-audit", "--no-fund", "--silent"], {
    stdio: ["ignore", "ignore", "inherit"],
    timeout: 120000,
  });

  const silk = await import(pathToFileURL(path.join(tmp, "runner", "silk.mjs")).href);
  const client = await import(pathToFileURL(path.join(tmp, "runner", "deepseek-client.mjs")).href);

  const raw = fs.readFileSync(SAMPLE);
  const decoded = await silk.decodeSilkToWav(new Uint8Array(raw), {});
  if (!decoded.ok) {
    console.error("silk decode failed: " + (decoded.reason_text || decoded.error_kind));
    process.exit(1);
  }
  const decodedPath = path.join(tmp, "decoded.wav");
  const wavPath = path.join(tmp, "voice.wav");
  fs.writeFileSync(decodedPath, Buffer.from(decoded.wav), { mode: 0o600 });
  execFileSync("ffmpeg", [
    "-nostdin", "-hide_banner", "-loglevel", "error",
    "-i", decodedPath, "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", "-t", "110", "-y", wavPath,
  ]);
  const wav = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append("file", new File([wav], "voice.wav", { type: "audio/wav" }), "voice.wav");
  const started = Date.now();
  const result = await client.callDs("asr", { form, timeoutMs: 90000, keyFile });
  const elapsed = Date.now() - started;
  if (!result.ok) {
    console.log(JSON.stringify({
      ok: false,
      error_kind: result.error_kind,
      reason_text: result.reason_text,
      next_action: result.next_action,
      sample_bytes: raw.length,
      decoded_ms: decoded.duration_ms,
      wav_bytes: wav.length,
      latency_ms: elapsed,
    }, null, 2));
    process.exit(1);
  }
  const text = String(result.data?.text || "");
  const duration = Number(result.data?.duration_ms) || decoded.duration_ms || 0;
  console.log(JSON.stringify({
    ok: true,
    sample: path.basename(SAMPLE),
    sample_bytes: raw.length,
    decoded_ms: decoded.duration_ms,
    wav_bytes: wav.length,
    transcript: text,
    chars: [...text].length,
    cost_micro_usd: cost(duration),
    latency_ms: elapsed,
  }, null, 2));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
