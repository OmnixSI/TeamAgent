// WAV -> SILK (QQ voice) conversion. The QQ voice upload API only accepts SILK
// (file_type=3), while both edge-tts and DeepSeek TTS hand us WAV.
//
// silk-wasm is MIT licensed and pinned to 3.7.1; the lead installs it into the
// runner dependencies. It is imported lazily inside the call so the rest of the
// gateway keeps working (text fallback) on machines without it.
//
// Why ffmpeg normalisation is mandatory: DeepSeek returns a sizeable WAV whose
// RIFF chunk length does not match the file size. silk-wasm validates that
// header and throws "Main chunk length ... does not match file size", so the
// input is first rewritten as a canonical 24 kHz mono 16-bit RIFF.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./asr.mjs";
import { ffmpegToolchain, requireTool } from "./toolchain.mjs";

export const SILK_MAGIC = "#!SILK_V3";
export const SILK_SAMPLE_RATE = 24000;
export const SILK_MAX_WAV_BYTES = 50 * 1024 * 1024;
export const SILK_DEFAULT_TIMEOUT_MS = 30 * 1000;

const fail = (error_kind, reason_text, extra = {}) => ({
  ok: false,
  error_kind,
  retryable: false,
  reason_text,
  ...extra,
});

function asBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** SILK files start with 0x02 followed by "#!SILK_V3". */
export function isSilkData(data) {
  const bytes = asBytes(data);
  if (!bytes || bytes.length < 10) return false;
  const head = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 12))).toString("latin1");
  return head.startsWith(SILK_MAGIC) || head.startsWith("\u0002" + SILK_MAGIC);
}

/** Lazy load, injectable for tests; a missing package is a normal state. */
export async function loadSilkModule(deps = {}) {
  if (deps.loadSilk) return deps.loadSilk();
  try {
    return await import("silk-wasm");
  } catch {
    return null;
  }
}

const FFMPEG_NORMALIZE = (src, dst) => [
  "-nostdin",
  "-hide_banner",
  "-loglevel",
  "error",
  "-i",
  src,
  "-vn",
  "-ac",
  "1",
  "-ar",
  String(SILK_SAMPLE_RATE),
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  "-y",
  dst,
];

/**
 * Convert a WAV (or anything ffmpeg can decode) to SILK.
 * Returns {ok:true, data, duration_ms, sample_rate, bytes, wav_bytes}
 *      or {ok:false, error_kind, retryable, reason_text}.
 */
export async function wavToSilk(wavPath, opts = {}, deps = {}) {
  const step = typeof wavPath === "string" && wavPath.trim();
  if (!step) return fail("invalid_audio", "没有可转换的音频文件");
  let stat;
  try {
    stat = fs.statSync(wavPath);
  } catch {
    return fail("invalid_audio", "音频文件不存在或已被清理");
  }
  if (!stat.isFile() || stat.size <= 0)
    return fail("invalid_audio", "音频文件是空的");
  if (stat.size > SILK_MAX_WAV_BYTES)
    return fail("too_large", "音频文件过大，无法转换成语音");

  const silk = await loadSilkModule(deps);
  if (!silk || typeof silk.encode !== "function")
    return fail("tool_not_ready", "本机未安装 silk-wasm，语音先回退文字", {
      missing: "silk-wasm",
    });

  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? Math.max(1000, Math.min(opts.timeoutMs, 60_000))
    : SILK_DEFAULT_TIMEOUT_MS;
  const run = deps.runCommand || runCommand;
  let bin;
  try {
    bin = requireTool(ffmpegToolchain(deps), "silk_tool_missing");
  } catch {
    return fail("tool_missing", "本机缺少 ffmpeg，无法转换成语音", {
      missing: "ffmpeg",
    });
  }
  let work = null;
  try {
    work = fs.mkdtempSync(path.join(opts.tmpDir || os.tmpdir(), "f9ds-silk-"));
    const normalized = path.join(work, "normalized.wav");
    const audio = await run(
      bin,
      FFMPEG_NORMALIZE(wavPath, normalized),
      { timeoutMs, timeoutReason: "silk_timeout", missingReason: "silk_tool_missing" },
      deps,
    );
    if (audio?.code !== 0) return fail("invalid_audio", "音频无法解码成 24 kHz 单声道 WAV");
    const wavBytes = fs.readFileSync(normalized);
    if (!wavBytes.length) return fail("invalid_audio", "规范化后的音频是空的");

    const encoded = await silk.encode(new Uint8Array(wavBytes), SILK_SAMPLE_RATE);
    const data = asBytes(encoded?.data);
    if (!data?.length) return fail("encode_failed", "SILK 编码返回了空文件");
    if (!isSilkData(data))
      return fail("encode_failed", "SILK 编码结果缺少合法文件头");
    const duration = Number(encoded?.duration);
    return {
      ok: true,
      data,
      duration_ms:
        Number.isFinite(duration) && duration > 0
          ? Math.round(duration)
          : wavDurationMs(wavBytes),
      sample_rate: SILK_SAMPLE_RATE,
      bytes: data.length,
      wav_bytes: wavBytes.length,
    };
  } catch (error) {
    deps.log?.(`silk encode failed: ${error?.code || error?.name || "error"}`);
    return fail("encode_failed", "SILK 编码失败，语音先回退文字");
  } finally {
    if (work) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {}
    }
  }
}

/** Decode SILK back to PCM and wrap it in a canonical RIFF for verification. */
export async function decodeSilkToWav(silkData, opts = {}, deps = {}) {
  const data = asBytes(silkData);
  if (!data?.length) return fail("invalid_audio", "SILK 数据是空的");
  const silk = await loadSilkModule(deps);
  if (!silk || typeof silk.decode !== "function")
    return fail("tool_not_ready", "本机未安装 silk-wasm，无法解码 SILK");
  const sampleRate = Number(opts.sampleRate) || SILK_SAMPLE_RATE;
  try {
    const decoded = await silk.decode(new Uint8Array(data), sampleRate);
    const pcm = asBytes(decoded?.data);
    if (!pcm?.length) return fail("decode_failed", "SILK 解码返回了空音频");
    const duration = Number(decoded?.duration);
    return {
      ok: true,
      pcm,
      wav: pcmToWav(pcm, sampleRate),
      duration_ms:
        Number.isFinite(duration) && duration > 0
          ? Math.round(duration)
          : pcmDurationMs(pcm, sampleRate),
      sample_rate: sampleRate,
    };
  } catch (error) {
    deps.log?.(`silk decode failed: ${error?.code || error?.name || "error"}`);
    return fail("decode_failed", "SILK 解码失败");
  }
}

/** Duration of a canonical 24 kHz mono 16-bit WAV, in milliseconds. */
export function wavDurationMs(wavBytes) {
  const bytes = asBytes(wavBytes);
  if (!bytes || bytes.length < 44) return 0;
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.toString("latin1", 0, 4) !== "RIFF") return 0;
  const rate = view.readUInt32LE(24);
  const channels = view.readUInt16LE(22) || 1;
  const bits = view.readUInt16LE(34) || 16;
  let offset = 12;
  while (offset + 8 <= view.length) {
    const id = view.toString("latin1", offset, offset + 4);
    const length = view.readUInt32LE(offset + 4);
    if (id === "data")
      return rate > 0 ? Math.round((length * 1000) / (rate * channels * (bits / 8))) : 0;
    offset += 8 + length + (length % 2);
  }
  return 0;
}

export function pcmDurationMs(pcm, sampleRate = SILK_SAMPLE_RATE) {
  const bytes = asBytes(pcm);
  return bytes && sampleRate > 0 ? Math.round((bytes.length * 1000) / (sampleRate * 2)) : 0;
}

/** Build a canonical 44-byte-header 16-bit mono RIFF around PCM bytes. */
export function pcmToWav(pcm, sampleRate = SILK_SAMPLE_RATE) {
  const bytes = asBytes(pcm) || new Uint8Array();
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + bytes.length, 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(bytes.length, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.from(bytes)]));
}
