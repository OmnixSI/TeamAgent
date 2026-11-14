#!/usr/bin/env node
// Build synthetic voice assets through the production TTS + SILK code.
// Key only from DEEPSEEK_API_KEY_FILE; no print, no repo writes.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.env.SYN_ASSETS_DIR || "/Users/yanghongming/Projects/.worktrees/TeamAgent-p4b-login/.agent/scenarios/ds-live/synthetic";
fs.mkdirSync(OUT, { recursive: true, mode: 0o700 });
const TEXT = process.env.SYN_TEXT || "张伟在2026年11月14日买了3斤苹果，花了28块5毛。李娜说这个价格比上周便宜了4块2。";
const { synthesize } = await import(pathToFileURL(path.join(ROOT, "runner/tts.mjs")).href);
const { wavToSilk } = await import(pathToFileURL(path.join(ROOT, "runner/silk.mjs")).href);

const tts = await synthesize(TEXT, {
  enabled: true, provider: "deepseek", deepseek_voice: "stella",
  cache_dir: path.join(OUT, "tts-cache"), timeout_ms: 60000,
});
if (!tts?.path) { console.error(JSON.stringify({ ok: false, stage: "tts" })); process.exit(1); }
const raw = tts.path;
const wav16 = path.join(OUT, "speech-16k.wav");
const ogg = path.join(OUT, "speech.ogg");
execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", raw, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", wav16]);
execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", raw, "-vn", "-ac", "1", "-ar", "24000", "-c:a", "libopus", "-b:a", "24k", "-y", ogg]);
const silk = await wavToSilk(raw, { timeoutMs: 30000 });
if (!silk?.ok) { console.error(JSON.stringify({ ok: false, stage: "silk", error: silk?.error_kind })); process.exit(1); }
const silkPath = path.join(OUT, "speech.silk");
fs.writeFileSync(silkPath, Buffer.from(silk.data), { mode: 0o600 });
const dur = f => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", f], { encoding: "utf8" }).trim()) || 0;
const seg = dur(wav16);
const loops = Math.max(1, Math.ceil(720 / seg) + 1);
const long = path.join(OUT, "speech-12min.wav");
if (!process.env.SYN_NO_LONG) execFileSync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-stream_loop", String(loops), "-i", wav16, "-t", "720", "-c:a", "pcm_s16le", "-y", long], { timeout: 120000 });
const manifest = {
  ok: true, text: TEXT, provider: tts.provider, cached: !!tts.cached,
  files: { raw, wav16, ogg, silk: silkPath, ...(process.env.SYN_NO_LONG ? {} : { long }) },
  bytes: { wav16: fs.statSync(wav16).size, ogg: fs.statSync(ogg).size, silk: fs.statSync(silkPath).size, ...(process.env.SYN_NO_LONG ? {} : { long: fs.statSync(long).size }) },
  duration_s: { wav16: Math.round(seg * 100) / 100, ...(process.env.SYN_NO_LONG ? {} : { long: Math.round(dur(long) * 100) / 100 }), silk_ms: silk.duration_ms },
};
fs.writeFileSync(path.join(OUT, "assets.json"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
console.log(JSON.stringify({ ...manifest, files: { wav16: path.basename(wav16), ogg: path.basename(ogg), silk: path.basename(silkPath), long: path.basename(long) } }));
