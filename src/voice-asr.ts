/**
 * F9-DS inbound voice messages. QQ usually ships its own `asr_refer_text`,
 * which is free and immediate; only missing, empty or implausible text is sent
 * to the cloud. Ogg Opus / small WAV can be posted straight to DeepSeek from
 * the Worker; SILK, AMR and other containers go through the local runner,
 * which decodes with silk-wasm (DS-2a) and posts a normalised 16 kHz WAV.
 *
 * Nothing here runs for ordinary text messages: the queue statement exists
 * only after a voice attachment actually needs transcription.
 */
import {
  callDsTool,
  dsGuard,
  type DsFail,
  type DsOk,
} from "./deepseek-tools";

export const VOICE_MAX_BYTES = 20 * 1024 * 1024;
export const VOICE_ASR_MAX_BYTES = 8 * 1024 * 1024;
export const VOICE_ASR_SECONDS = 120;
export const VOICE_TRUNCATE_SECONDS = 110;
export const VOICE_MAX_CHARS = 4000;

export type VoiceFormat = "ogg" | "wav" | "silk" | "amr" | "mp3" | "m4a" | "unknown";
export type VoiceMedia = {
  kind?: string;
  url?: string;
  contentType?: string;
  filename?: string;
  size?: number;
  asr?: string;
};
export type VoiceSkipReason =
  | "no_url"
  | "too_large"
  | "bad_url"
  | "empty";
export type VoicePlan =
  | { route: "qq"; text: string }
  | {
      route: "cloud" | "runner";
      url: string;
      format: VoiceFormat;
      contentType: string;
      filename?: string;
      size?: number;
    }
  | {
      route: "skip";
      reason: VoiceSkipReason;
      error_kind: string;
      reason_text: string;
      next_action: string;
    };

export type VoiceFailure = {
  error_kind: string;
  reason_text: string;
  next_action: string;
  retryable?: boolean;
};

const FILLERS = new Set(["嗯", "啊", "哦", "呃", "唔", "嗯哼", "la", "♪"]);
const PLACEHOLDERS = new Set(["[语音]", "[voice]", "语音", "voice", "…", "..."]);

const FAILURES: Record<string, { reason_text: string; next_action: string }> = {
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
  too_large: {
    reason_text: "语音太长或文件太大",
    next_action: "分成几条短语音发",
  },
  quota: {
    reason_text: "今天的语音转写次数用完了",
    next_action: "明天再试，或让管理员调整限额",
  },
  budget: {
    reason_text: "今天的 DeepSeek 预算用完了",
    next_action: "明天（悉尼时间 0 点后）再试",
  },
  auth: {
    reason_text: "语音识别服务没配置好",
    next_action: "让管理员检查 DeepSeek 密钥",
  },
  denied: {
    reason_text: "语音识别现在是关着的",
    next_action: "让管理员打开 ds_asr",
  },
  timeout: {
    reason_text: "语音识别超时",
    next_action: "再说一次，或打字补充",
  },
  upstream: {
    reason_text: "语音识别服务暂时不可用",
    next_action: "稍后再试，或打字补充",
  },
  asr_failed: {
    reason_text: "语音识别失败",
    next_action: "再说一次，或打字补充",
  },
  download_failed: {
    reason_text: "语音文件没下载下来",
    next_action: "请重新发一次语音",
  },
  no_url: {
    reason_text: "这条语音没有可下载的地址",
    next_action: "请重新发一次语音",
  },
  bad_url: {
    reason_text: "这条语音的地址不安全",
    next_action: "请重新发一次语音",
  },
  empty: {
    reason_text: "这条语音是空的",
    next_action: "再说一次，或打字补充",
  },
};

export function voiceFailure(
  error_kind: string,
  over: Partial<VoiceFailure> = {},
): VoiceFailure {
  const base = FAILURES[error_kind] || FAILURES.asr_failed;
  return {
    error_kind,
    reason_text: over.reason_text || base.reason_text,
    next_action: over.next_action || base.next_action,
    retryable: over.retryable,
  };
}

/** Trim QQ's transcript; reject empty, punctuation-only and obvious filler. */
export function usableVoiceText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim().slice(0, VOICE_MAX_CHARS);
  if (!text || PLACEHOLDERS.has(text.toLowerCase())) return null;
  const meaningful = text.replace(/[\p{P}\p{S}\s]/gu, "");
  if (!meaningful) return null;
  if (FILLERS.has(text.toLowerCase()) || FILLERS.has(meaningful.toLowerCase()))
    return null;
  // Long runs of one character are decoder loops, not speech.
  if (/(.)\1{6,}/u.test(meaningful)) return null;
  return text;
}

function extOf(value: string | undefined): string {
  if (!value) return "";
  try {
    const path = new URL(value, "https://voice.invalid").pathname;
    return (path.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] || "").toLowerCase();
  } catch {
    return "";
  }
}

export function voiceFormat(media: VoiceMedia): VoiceFormat {
  const type = String(media.contentType || "").toLowerCase().split(";")[0].trim();
  const ext = extOf(media.filename) || extOf(media.url);
  if (type === "voice" || type === "audio/silk" || ext === "silk") return "silk";
  if (type === "audio/ogg" || type === "audio/opus" || type === "application/ogg" || ext === "ogg" || ext === "opus") return "ogg";
  if (type === "audio/wav" || type === "audio/wave" || type === "audio/x-wav" || ext === "wav") return "wav";
  if (type === "audio/amr" || type === "audio/amr-wb" || ext === "amr") return "amr";
  if (type === "audio/mpeg" || type === "audio/mp3" || ext === "mp3") return "mp3";
  if (type === "audio/mp4" || type === "audio/m4a" || type === "audio/aac" || ext === "m4a" || ext === "aac") return "m4a";
  return "unknown";
}

function httpsUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/**
 * Choose the cheapest path that can actually handle this attachment.
 * A WAV over the ASR request cap also goes local, where ffmpeg downmixes it.
 */
export function planVoice(media: VoiceMedia): VoicePlan {
  if (media?.kind && media.kind !== "voice")
    return {
      route: "skip",
      reason: "empty",
      ...voiceFailure("empty", { reason_text: "这条附件不是语音" }),
    };
  const asr = usableVoiceText(media?.asr);
  if (asr) return { route: "qq", text: asr };
  const url = httpsUrl(media?.url);
  if (!url) {
    const reason = media?.url ? "bad_url" : "no_url";
    return { route: "skip", reason, ...voiceFailure(reason) };
  }
  const size = Number(media?.size);
  if (Number.isFinite(size) && size > VOICE_MAX_BYTES)
    return { route: "skip", reason: "too_large", ...voiceFailure("too_large") };
  const format = voiceFormat(media);
  const contentType = String(media?.contentType || "").split(";")[0].trim();
  const common = {
    url,
    format,
    contentType,
    filename: media?.filename,
    size: Number.isFinite(size) ? size : undefined,
  };
  if (format === "ogg") return { route: "cloud", ...common };
  if (format === "wav" && !(Number.isFinite(size) && size > VOICE_ASR_MAX_BYTES))
    return { route: "cloud", ...common };
  return { route: "runner", ...common };
}

export function voiceNote(
  text: string,
  options: { truncated?: boolean; source?: "qq" | "cloud" | "runner" } = {},
): string {
  const clean = String(text || "").replace(/\s+/g, " ").trim().slice(0, VOICE_MAX_CHARS);
  const marks =
    "[语音转写]（自动转写，可能有误）" +
    (options.truncated ? "（语音较长，只转写了前 " + VOICE_TRUNCATE_SECONDS + " 秒）" : "");
  return marks + "\n" + clean;
}

export function voiceFailureNote(failure: VoiceFailure): string {
  return "[语音] 转写失败：" + failure.reason_text + "（" + failure.next_action + "）";
}

export function voiceJobId(messageId: string, idx: number): string {
  return "voice-" + messageId + "-" + Math.max(0, Math.floor(Number(idx) || 0));
}

/** Read-modify-write only after a voice result; never on the per-message path. */
async function patchMedia(
  e: any,
  messageId: string,
  idx: number,
  patch: Record<string, any>,
): Promise<boolean> {
  if (!messageId) return false;
  const row = await e.DB.prepare("SELECT json FROM message_meta WHERE id=?")
    .bind(messageId)
    .first();
  if (!row?.json) return false;
  let meta: any;
  try {
    meta = JSON.parse(row.json);
  } catch {
    return false;
  }
  const list = Array.isArray(meta.media) ? meta.media : [];
  const item = list[idx];
  if (!item || item.kind !== "voice") return false;
  const next = { ...item, ...patch, asrAt: new Date().toISOString() };
  if ("asr" in patch && !patch.asr) delete next.asr;
  if (patch.asrError === undefined && "asrError" in patch) delete next.asrError;
  list[idx] = next;
  meta.media = list;
  await e.DB.prepare("UPDATE message_meta SET json=? WHERE id=?")
    .bind(JSON.stringify(meta), messageId)
    .run();
  return true;
}

export async function recordVoiceTranscript(
  e: any,
  messageId: string,
  idx: number,
  text: string,
  options: { truncated?: boolean; source?: "qq" | "cloud" | "runner" } = {},
): Promise<boolean> {
  const clean = usableVoiceText(text);
  if (!clean) return false;
  return patchMedia(e, messageId, idx, {
    asr: clean,
    asrSource: options.source || "cloud",
    asrTruncated: options.truncated === true,
    asrError: undefined,
  });
}

export async function recordVoiceFailure(
  e: any,
  messageId: string,
  idx: number,
  failure: VoiceFailure,
): Promise<boolean> {
  return patchMedia(e, messageId, idx, {
    asrError: {
      error_kind: failure.error_kind,
      reason_text: failure.reason_text,
      next_action: failure.next_action,
    },
  });
}

function changesOf(result: any): number {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

/**
 * Enqueue one job per voice attachment that still needs transcription.
 * Called only when a new voice message was stored, so a replayed webhook
 * neither re-reserves quota nor creates a duplicate job.
 */
export async function enqueueVoiceJobs(
  e: any,
  media: VoiceMedia[],
  message: { message: string; group: string; sender: string },
): Promise<{ enqueued: number; skipped: number }> {
  let enqueued = 0, skipped = 0;
  const list = Array.isArray(media) ? media : [];
  for (let idx = 0; idx < list.length; idx++) {
    const item = list[idx];
    if (!item || item.kind !== "voice") continue;
    const plan = planVoice(item);
    if (plan.route === "qq") continue;
    if (plan.route === "skip") {
      // A missing/unsafe URL is not a transcription failure; leave the plain
      // "[语音]" placeholder instead of inventing an error the member cannot act on.
      if (plan.reason !== "no_url" && plan.reason !== "bad_url")
        await recordVoiceFailure(e, message.message, idx, voiceFailure(plan.reason, plan));
      skipped++;
      continue;
    }
    const id = voiceJobId(message.message, idx);
    const existing = await e.DB.prepare("SELECT id FROM jobs WHERE id=?")
      .bind(id)
      .first();
    if (existing) continue;
    const guard = await dsGuard(e, {
      purpose: "asr",
      group: message.group,
      sender: message.sender,
    });
    if (!guard.ok) {
      await recordVoiceFailure(e, message.message, idx, {
        error_kind: guard.error_kind,
        reason_text: guard.reason_text,
        next_action: guard.next_action,
      });
      skipped++;
      continue;
    }
    const kind = plan.route === "cloud" ? "voice_asr" : "voice_runner";
    const payload = {
      message: message.message,
      group: message.group,
      sender: message.sender,
      idx,
      url: plan.url,
      format: plan.format,
      contentType: plan.contentType,
      filename: plan.filename,
      size: plan.size,
      created_at: Date.now(),
    };
    const result = await e.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,kind,payload,created_at) VALUES(?,?,?,?)",
    )
      .bind(id, kind, JSON.stringify(payload), Date.now())
      .run();
    if (changesOf(result) > 0) {
      enqueued++;
      if (plan.route === "cloud" && e.WORK) {
        try {
          await e.WORK.send({ id });
        } catch {
          // The cron sweep re-sends pending work; the job is already durable.
        }
      }
    } else {
      await guard.release();
    }
  }
  return { enqueued, skipped };
}

async function readBodyLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw Object.assign(Error("too_large"), { reason: "too_large" });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > limit)
    throw Object.assign(Error("too_large"), { reason: "too_large" });
  return bytes;
}

const ASR_TYPES = /^(?:audio\/(?:ogg|opus|wav|wave|x-wav)|application\/ogg)$/i;

/** Worker-side path: Ogg Opus and small WAV are posted to DeepSeek directly. */
export async function runVoiceCloudJob(
  e: any,
  payload: any,
): Promise<{ ok: boolean; error_kind?: string; text?: string }> {
  const fail = async (kind: string, over: Partial<VoiceFailure> = {}) => {
    const failure = voiceFailure(kind, over);
    await recordVoiceFailure(e, payload?.message, Number(payload?.idx) || 0, failure);
    return { ok: false, error_kind: kind };
  };
  if (!payload?.url) return fail("no_url");
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    response = await fetch(String(payload.url), {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "audio/ogg,audio/opus,audio/wav,*/*;q=0.5" },
    });
  } catch {
    return fail("expired");
  } finally {
    clearTimeout(timer);
  }
  if ([403, 404, 410].includes(response.status)) return fail("expired");
  if (response.status === 413) return fail("too_large");
  if (!response.ok) return fail("download_failed");
  let bytes: Uint8Array;
  try {
    bytes = await readBodyLimited(response, VOICE_ASR_MAX_BYTES);
  } catch (error: any) {
    return fail(error?.reason === "too_large" ? "too_large" : "download_failed");
  }
  if (!bytes.byteLength) return fail("no_speech");
  let type = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const declared = String(payload.contentType || "").split(";")[0].trim().toLowerCase();
  if (!ASR_TYPES.test(type) && ASR_TYPES.test(declared)) type = declared;
  const head = String.fromCharCode(...Array.from(bytes.slice(0, 12)));
  if (head.startsWith("\u0002#!SILK_V3") || head.startsWith("#!SILK_V3"))
    return fail("unsupported", {
      reason_text: "这条语音是 SILK 格式，Worker 不能直接解码",
      next_action: "让本机 runner 处理，或直接打字",
    });
  if (!ASR_TYPES.test(type)) {
    if (head.startsWith("OggS")) type = "audio/ogg";
    else if (head.startsWith("RIFF") && head.slice(8, 12) === "WAVE") type = "audio/wav";
  }
  if (!ASR_TYPES.test(type)) return fail("unsupported");
  const filename = String(payload.filename || "voice." + (type.includes("ogg") || type.includes("opus") ? "ogg" : "wav"));
  const form = new FormData();
  const part = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const blob = typeof File === "function"
    ? new File([part], filename, { type })
    : new Blob([part], { type });
  form.append("file", blob, filename);
  const result = await callDsTool(e, {
    purpose: "asr",
    form,
    timeoutMs: 90000,
    group: payload.group,
    sender: payload.sender,
  });
  if (!result.ok) {
    const failure = result as DsFail;
    return fail(failure.error_kind, {
      reason_text: failure.reason_text,
      next_action: failure.next_action,
      retryable: failure.retryable,
    });
  }
  const text = usableVoiceText((result as DsOk)?.data?.text);
  if (!text) return fail("no_speech");
  const stored = await recordVoiceTranscript(e, payload.message, Number(payload.idx) || 0, text, {
    source: "cloud",
  });
  return { ok: true, text, ...(stored ? {} : { error_kind: "message_missing" }) } as any;
}

async function recordDsUsage(e: any, body: any, payload: any, status: string) {
  const units = Number(body?.units);
  if (!Number.isFinite(units) || units < 0) return;
  try {
    await e.DB.prepare(
      "INSERT OR REPLACE INTO ds_usage(id,purpose,group_id,sender_id,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        "voice:" + body.id,
        "asr",
        payload.group || null,
        payload.sender || null,
        status,
        status === "ok" ? null : String(body.error_kind || "asr_failed"),
        Number(body.latency_ms) || 0,
        Math.floor(units),
        Math.round((Math.floor(units) * 58000) / 3600000),
        Date.now(),
      )
      .run();
  } catch {
    // DS-0's table may not have been merged yet; accounting must not lose the result.
  }
}

async function claimVoice(e: any): Promise<Response> {
  const lease = crypto.randomUUID();
  const row = await e.DB.prepare(
    "UPDATE jobs SET status='running',attempts=attempts+1,lease_until=?,payload=json_set(payload,'$.lease',?) " +
      "WHERE id=(SELECT id FROM jobs WHERE kind='voice_runner' AND attempts<3 AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1) RETURNING *",
  )
    .bind(Date.now() + 180000, lease, Date.now())
    .first();
  return Response.json({
    job: row ? { ...row, payload: JSON.parse(row.payload) } : null,
  });
}

async function heartbeatVoice(e: any, body: any): Promise<Response> {
  const row = await e.DB.prepare(
    "UPDATE jobs SET lease_until=? WHERE id=? AND kind='voice_runner' AND status='running' AND json_extract(payload,'$.lease')=? AND lease_until>? RETURNING id",
  )
    .bind(Date.now() + 180000, body?.id, body?.lease, Date.now())
    .first();
  return Response.json({ ok: !!row }, { status: row ? 200 : 409 });
}

async function reportVoice(e: any, body: any): Promise<Response> {
  if (typeof body?.id !== "string" || typeof body?.lease !== "string")
    return Response.json({ error: "invalid report" }, { status: 400 });
  const row = await e.DB.prepare(
    "SELECT status,attempts,payload FROM jobs WHERE id=? AND kind='voice_runner'",
  )
    .bind(body.id)
    .first();
  if (!row) return Response.json({ error: "not found" }, { status: 404 });
  const payload = JSON.parse(row.payload || "{}");
  if (payload.lease !== body.lease)
    return Response.json({ error: "lease conflict" }, { status: 409 });
  if (row.status === "done" && body.success === true)
    return Response.json({ ok: true, already: true });
  if (!["running", "failed"].includes(row.status))
    return Response.json({ error: "lease conflict" }, { status: 409 });

  if (body.success === true) {
    const text = usableVoiceText(body.text);
    if (!text) return Response.json({ error: "invalid transcription" }, { status: 400 });
    await recordVoiceTranscript(e, payload.message, Number(payload.idx) || 0, text, {
      truncated: body.truncated === true,
      source: "runner",
    });
    await e.DB.prepare(
      "UPDATE jobs SET status='done',error=NULL WHERE id=? AND kind='voice_runner' AND json_extract(payload,'$.lease')=?",
    )
      .bind(body.id, body.lease)
      .run();
    await recordDsUsage(e, { ...body, id: body.id, units: body.units ?? body.duration_ms }, payload, "ok");
    return Response.json({ ok: true });
  }

  const kind = String(body.error_kind || "asr_failed");
  const failure = voiceFailure(kind, {
    reason_text: typeof body.reason_text === "string" ? body.reason_text : undefined,
    next_action: typeof body.next_action === "string" ? body.next_action : undefined,
    retryable: body.retryable === true,
  });
  if (body.retryable === true && Number(row.attempts) < 2) {
    await e.DB.prepare(
      "UPDATE jobs SET status='pending',lease_until=0,error=? WHERE id=? AND kind='voice_runner' AND json_extract(payload,'$.lease')=?",
    )
      .bind(failure.error_kind, body.id, body.lease)
      .run();
    return Response.json({ ok: true, retry: true });
  }
  await recordVoiceFailure(e, payload.message, Number(payload.idx) || 0, failure);
  await e.DB.prepare(
    "UPDATE jobs SET status='failed',error=? WHERE id=? AND kind='voice_runner' AND json_extract(payload,'$.lease')=?",
  )
    .bind(failure.error_kind, body.id, body.lease)
    .run();
  await recordDsUsage(e, { ...body, id: body.id, error_kind: failure.error_kind }, payload, "failed");
  return Response.json({ ok: true });
}

export async function voiceRoute(e: any, path: string, body: any): Promise<Response> {
  if (path.endsWith("/claim")) return claimVoice(e);
  if (path.endsWith("/heartbeat")) return heartbeatVoice(e, body);
  if (path.endsWith("/report")) return reportVoice(e, body);
  return Response.json({ error: "not found" }, { status: 404 });
}
