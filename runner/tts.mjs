// 出站语音（TTS）：edge-tts 作为独立 CLI 调用（LGPL-3.0，只执行、不 import、不改），
// mp3 再用 ffmpeg 转 24kHz 单声道 wav；失败一律返回 null，由调用方回退文字。
// 思路参考 AstrBot ProviderEdgeTTS（AGPL-3.0）的「CLI 生成 + ffmpeg 转码 + 灰度」做法，代码自写。
// 缓存：sha256(voice|rate|text)，默认 1 小时，按条数与体积封顶；每次调用前清理过期文件。
// 临时文件：每次合成在缓存目录内建 .work-* 目录，成功/失败都会删掉，只留最终 wav。
import fs from "node:fs";
import crypto from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand, fault } from "./asr.mjs";

export const EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
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
  "-y",
  dst,
];

export const defaultCacheDir = (home = homedir()) =>
  join(home, ".inkboard-team", "tts-cache");

const num = (value, fallback, min, max) =>
  Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;

function options(cfg = {}, deps = {}) {
  return {
    enabled: cfg.enabled === true,
    voice:
      typeof cfg.voice === "string" && cfg.voice.trim()
        ? cfg.voice.trim()
        : EDGE_VOICE,
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

/** 缓存键：同一个音色/语速下的同一段文字共用一份 wav。 */
export function ttsKey(text, voice = EDGE_VOICE, rate = "+0%") {
  return crypto
    .createHash("sha256")
    .update(`${voice}|${rate}|${String(text)}`)
    .digest("hex");
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

/**
 * 生成语音。成功返回 {path, key, cached}，任何失败返回 null（调用方回退文字）。
 * deps: runCommand(command,args,options,deps)、now()、log(line)、cacheDir、home。
 */
export async function synthesize(text, cfg = {}, deps = {}) {
  const opts = options(cfg, deps);
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || [...body].length > opts.maxChars) return null;
  const now = () => (deps.now ? deps.now() : Date.now());
  const key = ttsKey(body, opts.voice, opts.rate);
  const file = join(opts.cacheDir, key + ".wav");
  let work = null;
  try {
    fs.mkdirSync(opts.cacheDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    deps.log?.(`tts cache unavailable: ${error?.code || "error"}`);
    return null;
  }
  try {
    const stat = fs.statSync(file);
    if (stat.size > 0 && now() - stat.mtimeMs <= opts.ttlMs)
      return { path: file, key, cached: true };
  } catch {}
  pruneCache(opts.cacheDir, { ttlMs: opts.ttlMs, now: now() });
  const run = deps.runCommand || runCommand;
  const deadline = Date.now() + opts.timeoutMs;
  const remaining = () => Math.max(1000, deadline - Date.now());
  try {
    work = fs.mkdtempSync(join(opts.cacheDir, ".work-"));
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
    const audio = await run("ffmpeg", FFMPEG_ARGS(mp3, wav), {
      timeoutMs: remaining(),
      timeoutReason: "tts_timeout",
    }, deps);
    if (audio?.code !== 0) throw fault("tts_failed");
    if (fs.statSync(wav).size <= 0) throw fault("tts_empty");
    fs.renameSync(wav, file);
    return { path: file, key, cached: false };
  } catch (error) {
    // 只记原因和键前缀：群里的原文不进日志。
    deps.log?.(`tts failed: ${error?.reason || error?.code || "error"} ${key.slice(0, 8)}`);
    return null;
  } finally {
    if (work) {
      try {
        fs.rmSync(work, { recursive: true, force: true });
      } catch {}
    }
  }
}

/**
 * 发送一条语音回复；任何一步失败都用原文发文字（不重试，避免重复消息）。
 * deps 透传给 synthesize，另外可用 deps.synthesize 注入假 TTS 做回放测试。
 */
export async function voiceReply({ bot, group, text, cfg = {}, deps = {} } = {}) {
  const opts = options(cfg, deps);
  const target = { scope: "group", targetId: group };
  const body = typeof text === "string" ? text.trim() : "";
  if (!opts.enabled || !body) {
    await bot.sendText(target, typeof text === "string" ? text : String(text ?? ""));
    return { via: "text", reason: opts.enabled ? "empty" : "disabled" };
  }
  const synth = deps.synthesize || synthesize;
  let audio = null;
  try {
    audio = await synth(body, cfg, deps);
  } catch (error) {
    deps.log?.(`tts failed: ${error?.reason || error?.code || "error"}`);
    audio = null;
  }
  if (audio?.path) {
    try {
      await bot.sendVoice(target, { localPath: audio.path });
      return { via: "voice", path: audio.path, key: audio.key, cached: !!audio.cached };
    } catch (error) {
      deps.log?.(`tts send failed: ${error?.code || "error"}`);
    }
  }
  await bot.sendText(target, typeof text === "string" ? text : String(text ?? ""));
  return { via: "text", reason: audio?.path ? "send_failed" : "tts_failed" };
}
