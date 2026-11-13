/**
 * F9-DS local DeepSeek tools client. Same five fixed endpoints, same error
 * kinds and the same JSON/bytes handling as src/deepseek-tools.ts, but for the
 * local runner: the key comes from a private file and nothing is written to D1.
 * Never prints or returns the key.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DS_BASE = "https://api.deepseek.com";

export const DS_PATHS = {
  asr: "/v1/tools/asr",
  tts: "/v1/tools/tts",
  ocr: "/v1/tools/ocr",
  search: "/v1/tools/search",
  fetch: "/v1/tools/fetch",
};

export const DS_PRICES = {
  asr_micro_usd_per_hour: 58000,
  tts_micro_usd_per_10k_chars: 225000,
  ocr_micro_usd_per_page: 225,
  search_micro_usd_per_call: 750,
  fetch_micro_usd_per_call: 750,
};

const RETRYABLE = {
  refused: false,
  budget: false,
  quota: true,
  timeout: true,
  upstream: true,
  auth: false,
  unsupported: false,
  denied: false,
  too_large: false,
};

const FAILURE = {
  refused: {
    reason_text: "DeepSeek 的安全审核拒绝了这个内容",
    next_action: "换一种说法或换一份文件再试",
  },
  budget: {
    reason_text: "今天的 DeepSeek 预算已用完",
    next_action: "明天（悉尼时间 0 点后）再试，或让管理员提高预算",
  },
  quota: {
    reason_text: "DeepSeek 请求太频繁或额度不足",
    next_action: "稍后重试；若持续出现，让管理员检查 DeepSeek 账户余额",
  },
  timeout: { reason_text: "DeepSeek 请求超时", next_action: "稍后重试" },
  upstream: { reason_text: "DeepSeek 服务暂时不可用", next_action: "稍后重试" },
  auth: {
    reason_text: "DeepSeek 密钥无效或未配置",
    next_action:
      "把 key 文件路径放进 DEEPSEEK_API_KEY_FILE，或在 config 的 deepseek.key_file 里配置",
  },
  unsupported: {
    reason_text: "DeepSeek 不接受这个请求",
    next_action: "换一种格式或参数再试",
  },
  denied: {
    reason_text: "DeepSeek 拒绝访问这个地址",
    next_action: "换一个公开网页地址再试",
  },
  too_large: {
    reason_text: "文件太大，超过了 DeepSeek 的限制",
    next_action: "压缩或切分后再试",
  },
};

function failure(kind, status, over = {}) {
  return {
    ok: false,
    error_kind: kind,
    retryable: over.retryable ?? RETRYABLE[kind],
    ...(status === undefined ? {} : { status }),
    reason_text: over.reason_text ?? FAILURE[kind].reason_text,
    next_action: over.next_action ?? FAILURE[kind].next_action,
  };
}

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Han characters bill as two, everything else as one (probe report §7). */
export function billedChars(text) {
  let total = 0;
  for (const char of String(text ?? "")) total += HAN.test(char) ? 2 : 1;
  return total;
}

export function estimateCostMicroUsd(purpose, units, prices = DS_PRICES) {
  const u = Math.max(0, Number(units) || 0);
  if (purpose === "asr")
    return Math.round((u * prices.asr_micro_usd_per_hour) / 3600000);
  if (purpose === "tts")
    return Math.round((u * prices.tts_micro_usd_per_10k_chars) / 10000);
  if (purpose === "ocr") return Math.round(u * prices.ocr_micro_usd_per_page);
  if (purpose === "search")
    return Math.round(u * prices.search_micro_usd_per_call);
  return Math.round(u * prices.fetch_micro_usd_per_call);
}

export const dsCostMicroUsd = estimateCostMicroUsd;

function expandHome(path) {
  return typeof path === "string" && path.startsWith("~/")
    ? join(homedir(), path.slice(2))
    : path;
}

function configKeyFile() {
  try {
    const config = JSON.parse(
      readFileSync(new URL("../config/team.json", import.meta.url), "utf8"),
    );
    const value = config?.deepseek?.key_file;
    return typeof value === "string" && value ? expandHome(value) : "";
  } catch {
    return "";
  }
}

/**
 * Resolve the key without ever logging it. `key` is for tests only.
 * Throws a plain error when a configured file cannot be read.
 */
export function readKey(options = {}) {
  if (typeof options.key === "string" && options.key.trim())
    return options.key.trim();
  const explicitFile = expandHome(
    options.keyFile || process.env.DEEPSEEK_API_KEY_FILE || "",
  );
  if (explicitFile) {
    try {
      const value = readFileSync(explicitFile, "utf8").trim();
      if (value) return value;
    } catch {
      throw new Error("deepseek key file is not readable");
    }
  }
  const env = process.env.DEEPSEEK_API_KEY;
  if (typeof env === "string" && env.trim()) return env.trim();
  const configured = configKeyFile();
  if (configured) {
    try {
      const value = readFileSync(configured, "utf8").trim();
      if (value) return value;
    } catch {
      throw new Error("deepseek key file is not readable");
    }
  }
  return "";
}

function normalizeErrorData(data) {
  const err = data && typeof data === "object" ? data.error ?? {} : {};
  return [
    err?.message,
    err?.type,
    err?.code,
    data && typeof data === "object" ? data.message : "",
  ]
    .filter((part) => typeof part === "string" && part)
    .join(" ")
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
}

function classify(status, data) {
  const hay = normalizeErrorData(data);
  if (/content_exists_risk|content_risk|content_policy|safety|moderation/.test(hay))
    return "refused";
  if (/url_access_denied|access_denied/.test(hay)) return "denied";
  if (status === 413 || /too_large|exceeds_\d+_bytes|max_100_mib/.test(hay))
    return "too_large";
  if (status === 401) return "auth";
  if (status === 403) return "auth";
  if (status === 429 || /insufficient_balance|insufficient_quota|no_balance/.test(hay))
    return "quota";
  if (status >= 500) return "upstream";
  if (status === 400 || status === 404) return "unsupported";
  if (status === 200) {
    if (/quota|balance|rate_limit/.test(hay)) return "quota";
    if (/internal|server_error|busy|timeout/.test(hay)) return "upstream";
    return "unsupported";
  }
  return "upstream";
}

function looksLikeJson(bytes) {
  for (const byte of bytes) {
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
    return byte === 123 || byte === 91;
  }
  return false;
}

function decodeJson(bytes) {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function unitsFor(purpose, json, data, ok, override) {
  if (Number.isFinite(Number(override)))
    return Math.max(0, Math.floor(Number(override)));
  if (!ok) return 0;
  if (purpose === "tts") return billedChars(json?.text);
  if (purpose === "asr")
    return Number.isFinite(Number(data?.duration_ms))
      ? Math.max(0, Math.floor(Number(data.duration_ms)))
      : 0;
  if (purpose === "ocr")
    return Number.isFinite(Number(data?.page_count))
      ? Math.max(0, Math.floor(Number(data.page_count)))
      : 1;
  return 1;
}

function logCall(log, purpose, status, latency_ms) {
  try {
    log?.({ purpose, status, latency_ms });
  } catch {}
}

/**
 * One call to a fixed DeepSeek tool endpoint.
 * @param {keyof DS_PATHS} purpose
 * @param {{json?:any, form?:FormData, expect?:'json'|'bytes', timeoutMs?:number,
 *          key?:string, keyFile?:string, fetch?:Function, log?:Function,
 *          units?:number, estCostMicroUsd?:number}} options
 */
export async function callDs(purpose, options = {}) {
  const started = Date.now();
  const log = options.log;
  const finish = (result) => {
    logCall(log, String(purpose || "unknown"), "failed", Date.now() - started);
    return result;
  };

  if (
    typeof purpose !== "string" ||
    !Object.prototype.hasOwnProperty.call(DS_PATHS, purpose)
  )
    return finish(
      failure("denied", undefined, {
        reason_text: "请求地址不在允许范围",
        next_action: "只能调用 DeepSeek 固定的五个工具接口",
      }),
    );

  let key = "";
  try {
    key = readKey({ key: options.key, keyFile: options.keyFile });
  } catch {
    return finish(
      failure("auth", undefined, {
        reason_text: "读不到 DeepSeek 的 key 文件",
        next_action: "检查 DEEPSEEK_API_KEY_FILE 指向的文件权限",
      }),
    );
  }
  if (!key) return finish(failure("auth"));

  const headers = { Authorization: "Bearer " + key };
  let payload;
  if (options.form) {
    payload = options.form;
  } else {
    headers["Content-Type"] = "application/json";
    try {
      payload = JSON.stringify(options.json ?? {});
    } catch {
      return finish(
        failure("unsupported", undefined, {
          reason_text: "请求内容无法序列化",
          next_action: "检查调用参数",
        }),
      );
    }
  }

  const doFetch = options.fetch || globalThis.fetch;
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
        reject(
          Object.assign(new Error("deepseek timeout"), { name: "TimeoutError" }),
        );
      },
      Math.max(1, Number(options.timeoutMs) || 30000),
    );
  });
  const pending = doFetch(DS_BASE + DS_PATHS[purpose], {
    method: "POST",
    headers,
    body: payload,
    redirect: "error",
    signal: controller.signal,
  });
  pending.catch(() => {});

  let response;
  try {
    response = await Promise.race([pending, deadline]);
  } catch (error) {
    const timed =
      timedOut ||
      controller.signal.aborted ||
      error?.name === "AbortError" ||
      error?.name === "TimeoutError";
    return finish(failure(timed ? "timeout" : "upstream"));
  } finally {
    clearTimeout(timer);
  }

  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return finish(failure("upstream", response.status));
  }
  if (bytes.byteLength > 24 * 1024 * 1024)
    return finish(failure("too_large", response.status));

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const expected = options.expect ?? (purpose === "tts" ? "bytes" : "json");
  const isJsonBody = contentType.includes("json") || looksLikeJson(bytes);

  if (!response.ok) {
    const data = isJsonBody ? decodeJson(bytes) : null;
    return finish(failure(classify(response.status, data), response.status));
  }

  if (expected === "bytes") {
    if (isJsonBody) {
      const data = decodeJson(bytes);
      if (data && typeof data === "object" && data.error)
        return finish(failure(classify(200, data), 200));
    }
    const latency = Date.now() - started;
    const units = unitsFor(purpose, options.json, null, true, options.units);
    const cost = Number.isFinite(Number(options.estCostMicroUsd))
      ? Math.max(0, Math.floor(Number(options.estCostMicroUsd)))
      : estimateCostMicroUsd(purpose, units);
    logCall(log, purpose, "ok", latency);
    return {
      ok: true,
      data: null,
      bytes,
      latency_ms: latency,
      status: response.status,
      body_bytes: bytes.byteLength,
      units,
      est_cost_micro_usd: cost,
    };
  }

  const data = decodeJson(bytes);
  if (data == null) return finish(failure("upstream", response.status));
  if (typeof data === "object" && data.error)
    return finish(failure(classify(200, data), 200));

  const latency = Date.now() - started;
  const units = unitsFor(purpose, options.json, data, true, options.units);
  const cost = Number.isFinite(Number(options.estCostMicroUsd))
    ? Math.max(0, Math.floor(Number(options.estCostMicroUsd)))
    : estimateCostMicroUsd(purpose, units);
  logCall(log, purpose, "ok", latency);
  return {
    ok: true,
    data,
    latency_ms: latency,
    status: response.status,
    body_bytes: bytes.byteLength,
    units,
    est_cost_micro_usd: cost,
  };
}
