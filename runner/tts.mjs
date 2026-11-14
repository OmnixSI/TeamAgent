// 出站语音（TTS）：edge-tts 是免费主路径（LGPL-3.0，只执行、不 import、不改），
// 本机 edge-tts 不可用时回退 DeepSeek TTS（POST /v1/tools/tts）。两条路都先产出
// 24 kHz 单声道 16-bit WAV；voiceReply 再转成 QQ 要求的 SILK 并上传发送。
// 任何一步失败都回退原文文字，绝不发一半或重复发。
//
// provider: auto（默认，edge → deepseek）| edge | deepseek（deepseek → edge）。
// 缓存：sha256(provider|voice|rate|text)，默认 1 小时，按条数与体积封顶；
// 每次调用前清理过期文件；临时文件在缓存目录的 .work-* 里，用完即删。
import fs from "node:fs";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, fault } from "./asr.mjs";
import { ffmpegToolchain, requireTool } from "./toolchain.mjs";
import { wavToSilk } from "./silk.mjs";
import { sendQQVoice } from "./qq-voice.mjs";

export { wavToSilk };

export const EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
export const DEEPSEEK_VOICE = "stella";
export const PROVIDERS = ["auto", "edge", "deepseek"];
export const HARD_MAX_CHARS = 300;
export const DEFAULT_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_TIMEOUT_MS = 20 * 1000;
export const DEFAULT_MAX_FILES = 200;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;
const WORK_DIR_MAX_AGE_MS = 10 * 60 * 1000;
const FFMPEG_ARGS = (src, dst) => [
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
  "24000",
  "-c:a",
  "pcm_s16le",
  "-f",
  "wav",
  "-y",
  dst,
];

/**
 * The exact conversion both TTS providers share: any decodable input becomes
 * 24 kHz mono 16-bit PCM WAV. Resolving ffmpeg here (instead of spawning a
 * bare name) keeps voice working under launchd's minimal PATH.
 */
export async function normalizeAudio(src, dst, options = {}, deps = {}) {
  const bin = requireTool(ffmpegToolchain(deps), "tts_tool_missing");
  const run = deps.runCommand || runCommand;
  const result = await run(
    bin,
    FFMPEG_ARGS(src, dst),
    {
      timeoutMs: options.timeoutMs,
      timeoutReason: "tts_timeout",
      missingReason: "tts_tool_missing",
    },
    deps,
  );
  return { ...result, bin };
}

export const defaultCacheDir = (home = homedir()) =>
  join(home, ".inkboard-team", "tts-cache");

const num = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;

function options(cfg = {}, deps = {}) {
  return {
    enabled: cfg.enabled === true,
    provider: PROVIDERS.includes(cfg.provider) ? cfg.provider : "auto",
    voice:
      typeof cfg.voice === "string" && cfg.voice.trim()
        ? cfg.voice.trim()
        : EDGE_VOICE,
    deepseekVoice:
      typeof cfg.deepseek_voice === "string" && cfg.deepseek_voice.trim()
        ? cfg.deepseek_voice.trim()
        : DEEPSEEK_VOICE,
    rate: typeof cfg.rate === "string" && /^[+-]\d{1,3}%$/.test(cfg.rate)
      ? cfg.rate
      : "+0%",
    maxChars: Number.isInteger(cfg.max_chars)
      ? Math.min(Math.max(cfg.max_chars, 1), HARD_MAX_CHARS)
      : HARD_MAX_CHARS,
    ttlMs: num(cfg.cache_minutes, 60, 1, 24 * 60) * 60 * 1000,
    timeoutMs: num(cfg.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, 60 * 1000),
    cacheDir:
      typeof cfg.cache_dir === "string" && cfg.cache_dir.trim()
        ? cfg.cache_dir.trim()
        : deps.cacheDir || defaultCacheDir(),
    edgeTts: cfg.edge_tts,
  };
}

/** auto keeps the free local path first; explicit deepseek tries the cloud first. */
export function providerPlan(provider = "auto") {
  if (provider === "edge") return ["edge"];
  if (provider === "deepseek") return ["deepseek", "edge"];
  return ["edge", "deepseek"];
}

/** 缓存键：provider、音色、语速和文本共同决定一份 wav。 */
export function ttsKey(text, voice = EDGE_VOICE, rate = "+0%", provider = "edge") {
  return crypto
    .createHash("sha256")
    .update(`${provider}|${voice}|${rate}|${String(text)}`)
    .digest("hex");
}

function asBytes(value) {
  if (!value) return null;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** edge-tts 可执行入口：显式配置 > 本机 runner venv > PATH。 */
export function edgeTtsCommand(cfg = {}, deps = {}) {
  const explicit = cfg.edge_tts ?? deps.env?.EDGE_TTS ?? process.env.EDGE_TTS;
  if (Array.isArray(explicit) && explicit.length)
    return { command: String(explicit[0]), args: explicit.slice(1).map(String) };
  if (typeof explicit === "string" && explicit.trim()) {
    const [command, ...args] = explicit.trim().split(/\s+/);
    return { command, args };
  }
  const local = join(deps.home || homedir(), ".inkboard-team", "venv/bin/edge-tts");
  if (fs.existsSync(local)) return { command: local, args: [] };
  return { command: "edge-tts", args: [] };
}

/** 清理过期 wav、残留的 .work-* 目录，并按条数/体积从旧到新删除。 */
export function pruneCache(dir, opts = {}) {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now();
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { removed: 0, files: 0, bytes: 0 };
  }
  let removed = 0;
  const keep = [];
  for (const name of names) {
    const file = join(dir, name);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (now - stat.mtimeMs > WORK_DIR_MAX_AGE_MS) {
        try {
          fs.rmSync(file, { recursive: true, force: true });
          removed += 1;
        } catch {}
      }
      continue;
    }
    const stale = now - stat.mtimeMs > ttlMs;
    if (!name.endsWith(".wav") || stat.size <= 0 || stale) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {}
      continue;
    }
    keep.push({ file, size: stat.size, mtime: stat.mtimeMs });
  }
  keep.sort((a, b) => a.mtime - b.mtime);
  let bytes = keep.reduce((sum, item) => sum + item.size, 0);
  while (keep.length && (keep.length > maxFiles || bytes > maxBytes)) {
    const oldest = keep.shift();
    try {
      fs.unlinkSync(oldest.file);
      removed += 1;
      bytes -= oldest.size;
    } catch {}
  }
  return { removed, files: keep.length, bytes };
}

/** DeepSeek client lives in DS-0; imported lazily so this module loads without it. */
async function defaultCallDs(purpose, request) {
  let mod;
  try {
    mod = await import("./deepseek-client.mjs");
  } catch {
    throw fault("tool_not_ready");
  }
  if (typeof mod?.callDs !== "function") throw fault("tool_not_ready");
  return mod.callDs(purpose, request);
}

function assertWav(file) {
  const stat = fs.statSync(file);
  if (stat.size <= 0) throw fault("tts_empty");
}

async function renderEdge(body, opts, deps, work, remaining) {
  const run = deps.runCommand || runCommand;
  const mp3 = join(work, "speech.mp3");
  const wav = join(work, "speech.wav");
  const cli = edgeTtsCommand({ edge_tts: opts.edgeTts }, deps);
  const speech = await run(
    cli.command,
    [
      ...cli.args,
      "--voice",
      opts.voice,
      "--rate",
      opts.rate,
      "--text",
      body,
      "--write-media",
      mp3,
    ],
    { timeoutMs: remaining(), timeoutReason: "tts_timeout" },
    deps,
  );
  if (speech?.code !== 0) throw fault("tts_failed");
  const audio = await normalizeAudio(mp3, wav, { timeoutMs: remaining() }, deps);
  if (audio?.code !== 0) throw fault("tts_failed");
  assertWav(wav);
  return wav;
}

async function renderDeepSeek(body, opts, deps, work, remaining) {
  const call = deps.callDs || defaultCallDs;
  const result = await call("tts", {
    json: {
      text: body,
      voice_id: opts.deepseekVoice,
      format: "wav",
      filter_markdown: true,
    },
    expect: "bytes",
    timeoutMs: remaining(),
  });
  if (!result?.ok) throw fault(result?.error_kind || "tts_failed");
  const bytes = asBytes(result.bytes) || asBytes(result.data);
  if (!bytes?.length) throw fault("tts_empty");
  const raw = join(work, "raw.wav");
  const wav = join(work, "speech.wav");
  fs.writeFileSync(raw, bytes);
  // Normalise the RIFF header: DeepSeek streaming WAVs do not always match
  // their declared chunk length, which silk-wasm rejects later.
  const audio = await normalizeAudio(raw, wav, { timeoutMs: remaining() }, deps);
  if (audio?.code !== 0) throw fault("tts_failed");
  assertWav(wav);
  return wav;
}

/**
 * 生成语音。成功返回 {path,key,cached,provider}；任何失败返回 null（调用方回退文字）。
 * deps: runCommand(command,args,options,deps)、callDs(purpose,request)、now()、log(line)、cacheDir、home。
 */
export async function synthesize(text, cfg = {}, deps = {}) {
  const opts = options(cfg, deps);
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || [...body].length > opts.maxChars) return null;
  const now = () => (deps.now ? deps.now() : Date.now());
  try {
    fs.mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    deps.log?.(`tts cache unavailable: ${error?.code || "error"}`);
    return null;
  }
  pruneCache(opts.cacheDir, { ttlMs: opts.ttlMs, now: now() });
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());
  const plan = providerPlan(opts.provider);
  for (let index = 0; index < plan.length; index += 1) {
    const provider = plan[index];
    const voice = provider === "deepseek" ? opts.deepseekVoice : opts.voice;
    const rate = provider === "deepseek" ? "" : opts.rate;
    const key = ttsKey(body, voice, rate, provider);
    const file = join(opts.cacheDir, key + ".wav");
    try {
      const stat = fs.statSync(file);
      if (stat.size > 0 && now() - stat.mtimeMs <= opts.ttlMs)
        return { path: file, key, cached: true, provider };
    } catch {}
    if (remaining() <= 1000) break;
    // Split the remaining budget so a hung edge-tts still leaves room for the
    // DeepSeek fallback instead of eating the whole timeout.
    const budget = Math.max(1000, Math.floor((deadline - Date.now()) / (plan.length - index)));
    const attemptDeadline = Date.now() + budget;
    const attemptRemaining = () => Math.max(200, attemptDeadline - Date.now());
    let work = null;
    try {
      work = fs.mkdtempSync(join(opts.cacheDir, ".work-"));
      const wav =
        provider === "deepseek"
          ? await renderDeepSeek(body, opts, deps, work, attemptRemaining)
          : await renderEdge(body, opts, deps, work, attemptRemaining);
      if (fs.existsSync(file)) fs.rmSync(wav, { force: true });
      else fs.renameSync(wav, file);
      return { path: file, key, cached: false, provider };
    } catch (error) {
      // 只记 provider、原因和键前缀：群里的原文不进日志。
      deps.log?.(
        `tts failed: ${provider} ${error?.reason || error?.code || "error"} ${key.slice(0, 8)}`,
      );
    } finally {
      if (work) {
        try {
          fs.rmSync(work, { recursive: true, force: true });
        } catch {}
      }
    }
  }
  return null;
}

/**
 * 发送一条语音回复：合成 WAV → 转 SILK → 走 runner/qq-voice.mjs 上传发送；
 * 任何一步失败都用原文发文字（只发一次，不重试）。
 * deps 透传给 synthesize，另外可用 deps.wavToSilk / deps.sendVoice / deps.token /
 * deps.msgId / deps.msgSeq / deps.qqBaseUrl 注入假实现做回放测试。
 */
export async function voiceReply({ bot, group, text, cfg = {}, deps = {} } = {}) {
  const opts = options(cfg, deps);
  const target = { scope: "group", targetId: group };
  const body = typeof text === "string" ? text.trim() : "";
  const say = async (reason, extra = {}) => {
    await bot?.sendText?.(target, typeof text === "string" ? text : String(text ?? ""));
    return { via: "text", reason, ...extra };
  };
  if (!opts.enabled || !body) return say(opts.enabled ? "empty" : "disabled");
  const tool = (deps.ffmpegToolchain || ffmpegToolchain)(deps);
  if (!tool.ok) {
    deps.log?.(`tts toolchain unavailable: ${tool.error}`);
    return say("tool_missing");
  }
  const synth = deps.synthesize || synthesize;
  let audio = null;
  try {
    audio = await synth(body, cfg, deps);
  } catch (error) {
    deps.log?.(`tts failed: ${error?.reason || error?.code || "error"}`);
    audio = null;
  }
  if (!audio?.path) return say("tts_failed");

  let silk = null;
  try {
    silk = await (deps.wavToSilk || wavToSilk)(
      audio.path,
      { timeoutMs: opts.timeoutMs },
      deps,
    );
  } catch (error) {
    deps.log?.(`silk failed: ${error?.code || "error"}`);
  }
  if (silk instanceof Uint8Array) silk = { ok: true, data: silk };
  if (!silk?.ok || !silk.data?.length) {
    deps.log?.(`silk unavailable: ${silk?.error_kind || "encode_failed"}`);
    return say(silk?.error_kind || "silk_failed");
  }

  let token = deps.token;
  if (!token && bot?.api?.getToken) {
    try {
      token = await bot.api.getToken();
    } catch {}
  }
  let sent = null;
  try {
    if (deps.sendVoice) {
      sent = await deps.sendVoice({
        group,
        silk: silk.data,
        token,
        msgId: deps.msgId,
        msgSeq: deps.msgSeq,
        baseUrl: deps.qqBaseUrl,
        timeoutMs: opts.timeoutMs,
        fetch: deps.fetch,
      });
    } else if (token || deps.qqBaseUrl) {
      sent = await sendQQVoice({
        group,
        silk: silk.data,
        token,
        msgId: deps.msgId,
        msgSeq: deps.msgSeq,
        baseUrl: deps.qqBaseUrl,
        timeoutMs: opts.timeoutMs,
        fetch: deps.fetch,
      });
    } else if (bot?.sendVoice) {
      // Older callers only have the SDK bot. It base64-uploads whatever bytes
      // it is given, so handing it SILK keeps the format correct.
      const media = await bot.sendVoice(target, { buffer: Buffer.from(silk.data) });
      sent = {
        ok: true,
        message_id: media?.message?.id,
        file_info: media?.upload?.file_info,
      };
    } else {
      sent = { ok: false, error_kind: "auth", reason_text: "缺少 QQ 访问令牌" };
    }
  } catch (error) {
    deps.log?.(`tts send failed: ${error?.code || "error"}`);
    sent = { ok: false, error_kind: "upstream" };
  }
  if (sent?.ok) {
    return {
      via: "voice",
      path: audio.path,
      key: audio.key,
      cached: !!audio.cached,
      provider: audio.provider,
      silk_bytes: silk.data.length,
      duration_ms: silk.duration_ms,
      message_id: sent.message_id,
    };
  }
  deps.log?.(`tts send failed: ${sent?.error_kind || "send_failed"}`);
  return say(sent?.error_kind || "send_failed");
}
