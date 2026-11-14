/**
 * Inbound voice runner. QQ voice messages arrive as SILK; the Worker cannot
 * decode them, so this short-lived local job downloads the attachment, decodes
 * SILK with silk-wasm (DS-2a), normalises to 16 kHz mono WAV with ffmpeg and
 * posts one request to DeepSeek ASR. Anything already decodable by ffmpeg
 * (AMR/MP3/M4A) takes the same path without the SILK step. One job, one
 * request, no retained files.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, fault } from "./asr.mjs";
import { ffmpegToolchain, ffprobeToolchain, requireTool } from "./toolchain.mjs";

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_ASR_BYTES = 8 * 1024 * 1024;
export const TRUNCATE_SECONDS = 110;
export const SAMPLE_RATE = 16000;
export const DEFAULT_HOME = path.join(os.homedir(), ".inkboard-team");

const FAILURES = {
  expired: { reason_text: "语音链接已过期", next_action: "请重新发一次语音" },
  unsupported: {
    reason_text: "这种语音格式还转不了",
    next_action: "用 QQ 语音消息重发，或直接打字",
  },
  no_speech: {
    reason_text: "这段语音里没有听清人声",
    next_action: "再说一次，或打字补充",
  },
  tool_not_ready: {
    reason_text: "本机还没装 silk 解码组件",
    next_action: "让管理员按 runbook 安装 silk-wasm",
  },
  asr_silk_missing: {
    reason_text: "本机还没装 silk-wasm，语音转不了",
    next_action: "让管理员重跑 install-local.py --apply 安装 runner 依赖",
  },
  too_large: { reason_text: "语音太长或文件太大", next_action: "分成几条短语音发" },
  download_failed: {
    reason_text: "语音文件没下载下来",
    next_action: "请重新发一次语音",
  },
  auth: {
    reason_text: "语音识别服务没配置好",
    next_action: "让管理员检查 DeepSeek 密钥",
  },
  quota: {
    reason_text: "语音识别服务额度不足",
    next_action: "稍后再试，或让管理员检查 DeepSeek 账户",
  },
  timeout: { reason_text: "语音识别超时", next_action: "再说一次，或打字补充" },
  upstream: {
    reason_text: "语音识别服务暂时不可用",
    next_action: "稍后再试，或打字补充",
  },
  asr_failed: {
    reason_text: "语音识别失败",
    next_action: "再说一次，或打字补充",
  },
  asr_tool_missing: {
    reason_text: "本机缺少 ffmpeg，语音暂时转不了",
    next_action: "让管理员补装 ffmpeg 或配置 FFMPEG_BIN",
  },
};

function failure(kind, over = {}) {
  const base = FAILURES[kind] || FAILURES.asr_failed;
  return {
    success: false,
    error_kind: kind,
    reason_text: over.reason_text || base.reason_text,
    next_action: over.next_action || base.next_action,
    retryable: over.retryable === true,
  };
}

function asBuffer(bytes) {
  if (bytes instanceof Uint8Array)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Buffer.from(bytes || []);
}

function extOf(value) {
  if (!value) return "";
  try {
    const pathname = new URL(String(value), "https://voice.invalid").pathname;
    return (pathname.match(/\.([A-Za-z0-9]{1,8})$/) || [])[1]?.toLowerCase() || "";
  } catch {
    return "";
  }
}

function usableText(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!text) return "";
  const meaningful = text.replace(/[\p{P}\p{S}\s]/gu, "");
  if (!meaningful) return "";
  if (/^(?:嗯|啊|哦|呃|唔|嗯哼|la|♪)$/i.test(meaningful)) return "";
  if (/(.)\1{6,}/u.test(meaningful)) return "";
  return text;
}

function typeOf(value) {
  return String(value || "").toLowerCase().split(";")[0].trim();
}

/** Magic bytes win over a MIME label: QQ labels everything voice-ish "voice". */
export function detectVoiceFormat(bytes, contentType = "", filename = "") {
  const data = asBuffer(bytes);
  const head = data.subarray(0, 16).toString("latin1");
  if (head.startsWith("\u0002#!SILK_V3") || head.startsWith("#!SILK_V3")) return "silk";
  if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") return "wav";
  if (head.startsWith("OggS")) return "ogg";
  if (head.startsWith("#!AMR")) return "amr";
  const type = typeOf(contentType);
  const ext = extOf(filename);
  if (type === "voice" || type === "audio/silk" || ext === "silk") return "silk";
  if (["audio/ogg", "audio/opus", "application/ogg"].includes(type) || ["ogg", "opus"].includes(ext)) return "ogg";
  if (["audio/wav", "audio/wave", "audio/x-wav"].includes(type) || ext === "wav") return "wav";
  if (["audio/amr", "audio/amr-wb"].includes(type) || ext === "amr") return "amr";
  if (["audio/mpeg", "audio/mp3"].includes(type) || ext === "mp3") return "mp3";
  if (["audio/mp4", "audio/m4a", "audio/aac"].includes(type) || ["m4a", "aac"].includes(ext)) return "m4a";
  return "unknown";
}

/** Duration of a canonical 16-bit mono WAV; 0 when the header is incomplete. */
export function wavDurationMs(bytes) {
  const data = asBuffer(bytes);
  if (data.length < 44) return 0;
  if (data.toString("latin1", 0, 4) !== "RIFF") return 0;
  if (data.toString("latin1", 8, 12) !== "WAVE") return 0;
  const rate = data.readUInt32LE(24);
  const channels = data.readUInt16LE(22) || 1;
  const bits = data.readUInt16LE(34) || 16;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString("latin1", offset, offset + 4);
    const length = data.readUInt32LE(offset + 4);
    if (id === "data")
      return rate > 0
        ? Math.round((length * 1000) / (rate * channels * (bits / 8)))
        : 0;
    offset += 8 + length + (length % 2);
  }
  return 0;
}

export function isPrivateHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".local") || host === "::1" || host === "[::1]") return true;
  if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host === "metadata.google.internal" || host === "instance-data") return true;
  return false;
}

async function download(url, dest, deps = {}) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    throw fault("expired");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || isPrivateHost(parsed.hostname))
    throw fault("expired");
  const fetchImpl = deps.fetch || fetch;
  let response;
  try {
    response = await fetchImpl(parsed.href, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
      headers: { Accept: "audio/*,*/*;q=0.5" },
    });
  } catch {
    throw fault("download_failed");
  }
  if ([403, 404, 410].includes(response.status)) throw fault("expired");
  if (response.status === 413) throw fault("too_large");
  if (!response.ok) throw fault("download_failed");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw fault("too_large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.byteLength) throw fault("no_speech");
  if (bytes.byteLength > MAX_BYTES) throw fault("too_large");
  fs.writeFileSync(dest, Buffer.from(bytes), { mode: 0o600 });
  return bytes;
}

async function ffmpegNormalize(src, dst, deps = {}) {
  const bin = requireTool(ffmpegToolchain(deps), "asr_tool_missing");
  const result = await runCommand(
    bin,
    [
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
      String(SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-t",
      String(TRUNCATE_SECONDS),
      "-y",
      dst,
    ],
    { timeoutMs: 60000, timeoutReason: "unsupported", missingReason: "asr_tool_missing" },
    deps,
  );
  if (result.code !== 0) throw fault("unsupported");
  return result;
}

async function probeDuration(file, deps = {}) {
  const tool = ffprobeToolchain(deps);
  // Duration is advisory: a missing probe must not reject the whole voice.
  if (!tool.ok) {
    deps.log?.("ffprobe unavailable: " + tool.error);
    return 0;
  }
  const result = await runCommand(
    tool.path,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      file,
    ],
    { timeoutMs: 15000, timeoutReason: "asr_failed", missingReason: "asr_tool_missing" },
    deps,
  );
  const value = Number(String(result.stdout || "").trim());
  return result.code === 0 && Number.isFinite(value) && value > 0
    ? Math.round(value * 1000)
    : 0;
}

function makeForm(wavBytes) {
  const form = new FormData();
  const part = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
  const blob =
    typeof File === "function"
      ? new File([part], "voice.wav", { type: "audio/wav" })
      : new Blob([part], { type: "audio/wav" });
  form.append("file", blob, "voice.wav");
  return form;
}

/** One claimed voice job. The caller reports the returned report to the Worker. */
export async function runVoiceJob(job, deps = {}) {
  const started = Date.now();
  const home = deps.home || DEFAULT_HOME;
  const id = String(job?.id || "");
  const payload = job?.payload || {};
  if (!id.startsWith("voice-") || typeof payload.url !== "string" || !payload.message)
    throw fault("not_found");
  const root = path.join(home, "voice-tmp");
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let report = null;
  try {
    const raw = await download(payload.url, path.join(dir, "in.bin"), deps);
    const format = detectVoiceFormat(raw, payload.contentType, payload.filename);
    let input = path.join(dir, "in.bin");
    let decodedDuration = 0;
    if (format === "silk") {
      const decoder = deps.decodeSilk || (await import("./silk.mjs")).decodeSilkToWav;
      const decoded = await decoder(raw, {}, deps.silkDeps || {});
      if (!decoded || decoded.ok === false)
        throw fault(decoded?.error_kind || "unsupported");
      decodedDuration = Number(decoded.duration_ms) || 0;
      input = path.join(dir, "decoded.wav");
      fs.writeFileSync(input, Buffer.from(decoded.wav), { mode: 0o600 });
    }
    const probed = await (deps.probeDuration || probeDuration)(input, deps);
    const duration = Number(probed) || decodedDuration || 0;
    const wavPath = path.join(dir, "voice.wav");
    await (deps.normalize || ffmpegNormalize)(input, wavPath, deps);
    const wavBytes = fs.readFileSync(wavPath);
    if (!wavBytes.length) throw fault("no_speech");
    if (wavBytes.length > MAX_ASR_BYTES) throw fault("too_large");
    const callDs = deps.callDs || (await import("./deepseek-client.mjs")).callDs;
    const result = await callDs("asr", {
      form: makeForm(wavBytes),
      timeoutMs: 90000,
      log: deps.log,
    });
    if (!result?.ok) {
      report = failure(String(result?.error_kind || "asr_failed"), {
        reason_text: result?.reason_text,
        next_action: result?.next_action,
        retryable: result?.retryable,
      });
    } else {
      const text = usableText(result.data?.text);
      if (!text) throw fault("no_speech");
      report = {
        success: true,
        text,
        truncated: duration > TRUNCATE_SECONDS * 1000,
        duration_ms: Number(result.data?.duration_ms) || duration || wavDurationMs(wavBytes),
        latency_ms: Number(result.latency_ms) || 0,
      };
    }
  } catch (error) {
    report = failure(String(error?.reason || "asr_failed"));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    try {
      if (fs.existsSync(root) && !fs.readdirSync(root).length) fs.rmdirSync(root);
    } catch {}
  }
  const residue = fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
  if (report) report = { ...report, cleanup: { residue, paths: [] } };
  return {
    report,
    cleanup: { residue, paths: [] },
    wall_s: Math.round((Date.now() - started) / 100) / 10,
  };
}

/** Claim and process at most `max` voice jobs, reporting each result. */
export async function runVoiceCycle({ cloud, deps = {}, max = 1 } = {}) {
  if (typeof cloud !== "function") throw Error("voice cloud client is required");
  const reports = [];
  for (let i = 0; i < max; i++) {
    let claimed;
    try {
      claimed = await cloud("claim", {});
    } catch {
      break;
    }
    const job = claimed?.data?.job;
    if (claimed?.status !== 200 || !job) break;
    let result;
    try {
      result = await runVoiceJob(job, deps);
    } catch (error) {
      result = {
        report: failure(String(error?.reason || "asr_failed")),
        cleanup: { residue: 0, paths: [] },
      };
    }
    const body = {
      id: job.id,
      lease: job.payload?.lease,
      ...(result.report || failure("asr_failed")),
    };
    let status = 0;
    try {
      status = (await cloud("report", body))?.status || 0;
    } catch {}
    reports.push({ ...body, report_status: status });
    if (status === 409) break;
  }
  return {
    reports,
    cleanup: { residue: reports.some(r => r.cleanup?.residue) ? 1 : 0, paths: [] },
  };
}
