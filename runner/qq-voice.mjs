// QQ group voice upload + send (rich media).
//
// QQ only accepts SILK for voice messages: upload with file_type=3 and
// srv_send_msg=false, then send msg_type=7 with media.file_info. This mirrors
// the authentication / failure semantics of sendSticker in src/stickers.ts:
// "QQBot <token>" bearer, 20 s timeout, manual redirects, JSON body codes are
// checked, and one bad response is reported instead of being retried blindly
// (a retry could duplicate a voice message). The caller falls back to text.
import fs from "node:fs";

export const MAX_VOICE_BYTES = 20 * 1024 * 1024;
export const QQ_DEFAULT_TIMEOUT_MS = 20 * 1000;
export const QQ_DEFAULT_BASE_URL = "https://api.bot.qq.com";

const fail = (error_kind, reason_text, extra = {}) => ({
  ok: false,
  error_kind,
  retryable: extra.retryable ?? false,
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

function timeoutFor(value) {
  return Number.isFinite(value) ? Math.max(100, Math.min(value, 60_000)) : QQ_DEFAULT_TIMEOUT_MS;
}

/** Read a SILK file from disk when the caller only has a path. */
export function readSilkFile(file) {
  try {
    const bytes = fs.readFileSync(file);
    return bytes?.length ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

async function postJson({ url, token, body, timeoutMs, fetchImpl }) {
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: "QQBot " + token, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { response, status: response.status, data, text };
  } catch (error) {
    const kind =
      error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "upstream";
    return {
      error: fail(kind, kind === "timeout" ? "QQ 接口超时，未确认是否送达" : "连不上 QQ 接口", {
        retryable: true,
      }),
    };
  }
}

function httpFailure(status, data, text, stage) {
  if (status === 401 || status === 403)
    return fail("auth", "QQ 拒绝了应用鉴权，请核对机器人凭据", { http_status: status, stage });
  if (status === 413)
    return fail("too_large", "语音文件超过 QQ 的上传上限", { http_status: status, stage });
  if (status === 429)
    return fail("quota", "QQ 接口限流，稍后再试", {
      http_status: status,
      stage,
      retryable: true,
    });
  const code = Number(data?.code);
  const suffix = Number.isFinite(code) && code !== 0 ? `（code ${code}）` : "";
  return fail(
    "upstream",
    `QQ 接口返回异常${suffix}`,
    {
      http_status: status,
      stage,
      code: Number.isFinite(code) ? code : undefined,
      retryable: status >= 500,
    },
  );
}

/**
 * Upload SILK bytes as QQ rich media (file_type=3, srv_send_msg=false).
 * No message is sent; the caller gets a file_info to reuse.
 */
export async function uploadVoice({
  group,
  silk,
  token,
  baseUrl = QQ_DEFAULT_BASE_URL,
  timeoutMs = QQ_DEFAULT_TIMEOUT_MS,
  fetch: fetchImpl = fetch,
} = {}) {
  const bytes = asBytes(silk);
  if (!group || typeof group !== "string")
    return fail("unsupported", "缺少 QQ 群标识");
  if (!bytes?.length) return fail("invalid_audio", "没有可上传的 SILK 语音数据");
  if (bytes.length > MAX_VOICE_BYTES)
    return fail("too_large", "语音文件超过 QQ 20 MB 上传上限", {
      bytes: bytes.length,
      max_bytes: MAX_VOICE_BYTES,
    });
  if (!token) return fail("auth", "缺少 QQ 访问令牌，无法上传语音");

  const { response, status, data, text, error } = await postJson({
    url: `${baseUrl}/v2/groups/${encodeURIComponent(group)}/files`,
    token,
    body: {
      file_type: 3,
      file_data: Buffer.from(bytes).toString("base64"),
      srv_send_msg: false,
    },
    timeoutMs: timeoutFor(timeoutMs),
    fetchImpl,
  });
  if (error) return { ...error, stage: "upload" };
  if (!response.ok) return httpFailure(status, data, text, "upload");
  if (typeof data?.file_info !== "string" || !data.file_info)
    return fail("upstream", "QQ 没有返回可用的语音 file_info", {
      http_status: status,
      stage: "upload",
      code: Number.isFinite(Number(data?.code)) ? Number(data.code) : undefined,
    });
  if (data.code !== undefined && Number(data.code) !== 0)
    return fail("upstream", `QQ 上传语音失败（code ${data.code}）`, {
      http_status: status,
      stage: "upload",
      code: Number(data.code),
    });
  const ttl = Number(data.ttl);
  return {
    ok: true,
    file_info: data.file_info,
    file_uuid: typeof data.file_uuid === "string" ? data.file_uuid : undefined,
    ttl_ms: Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 3600 * 1000,
    http_status: status,
    bytes: bytes.length,
  };
}

/**
 * Upload (unless file_info is supplied) and send a msg_type=7 voice message.
 * Failure returns {ok:false, error_kind, retryable, stage, reason_text, ...}.
 */
export async function sendQQVoice({
  group,
  silk,
  fileInfo,
  token,
  msgId,
  msgSeq = 1,
  baseUrl = QQ_DEFAULT_BASE_URL,
  timeoutMs = QQ_DEFAULT_TIMEOUT_MS,
  fetch: fetchImpl = fetch,
} = {}) {
  let uploaded = null;
  let info = typeof fileInfo === "string" && fileInfo ? fileInfo : null;
  if (!info) {
    uploaded = await uploadVoice({ group, silk, token, baseUrl, timeoutMs, fetch: fetchImpl });
    if (!uploaded.ok) return uploaded;
    info = uploaded.file_info;
  }
  const body = {
    msg_type: 7,
    media: { file_info: info },
    msg_seq: Number.isFinite(Number(msgSeq)) ? Number(msgSeq) : 1,
  };
  if (msgId) body.msg_id = String(msgId);
  const { response, status, data, text, error } = await postJson({
    url: `${baseUrl}/v2/groups/${encodeURIComponent(group)}/messages`,
    token,
    body,
    timeoutMs: timeoutFor(timeoutMs),
    fetchImpl,
  });
  if (error) return { ...error, stage: "send", file_info: info };
  if (!response.ok || !(data?.id || Number(data?.code) === 0))
    return {
      ...httpFailure(status, data, text, "send"),
      file_info: info,
    };
  return {
    ok: true,
    message_id: data.id,
    file_info: info,
    uploaded: !!uploaded,
    http_status: status,
    code: Number.isFinite(Number(data.code)) ? Number(data.code) : undefined,
  };
}

/** Alias kept for callers that import the module by its action name. */
export const sendVoice = sendQQVoice;
