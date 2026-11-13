/**
 * F9-DS shared DeepSeek tools channel. ASR, TTS, OCR, search and fetch all come
 * through here: one fixed host, one secret, the agreed error kinds, accounting
 * and the per-day limits. Quota reservation is reused from the OpenAI channel.
 */
import { releaseQuota, reserveQuota, sydneyDayStart } from "./openai";

export const DS_BASE = "https://api.deepseek.com";
export const DS_DAILY_CAP_MICRO_USD = 2_000_000;

export type DsPurpose = "asr" | "tts" | "ocr" | "search" | "fetch";

/** Purpose -> path is fixed here; callers can never pass a host or a path. */
export const DS_PATHS: Record<DsPurpose, string> = {
  asr: "/v1/tools/asr",
  tts: "/v1/tools/tts",
  ocr: "/v1/tools/ocr",
  search: "/v1/tools/search",
  fetch: "/v1/tools/fetch",
};

export type DsFail = {
  ok: false;
  error_kind:
    | "refused"
    | "budget"
    | "quota"
    | "timeout"
    | "upstream"
    | "auth"
    | "unsupported"
    | "denied"
    | "too_large";
  retryable: boolean;
  status?: number;
  reason_text: string;
  next_action: string;
};

export type DsOk<T = any> = {
  ok: true;
  data: T;
  bytes?: Uint8Array;
  latency_ms: number;
  status: number;
  /** Size of the response body, also for JSON answers (smoke checks report it). */
  body_bytes?: number;
};

export type DsCall = {
  purpose: DsPurpose;
  json?: any;
  form?: FormData;
  expect?: "json" | "bytes";
  timeoutMs: number;
  group?: string;
  sender?: string;
  estCostMicroUsd?: number;
  /** asr: audio milliseconds; tts: billed characters; ocr: pages; search/fetch: calls. */
  units?: number;
};

export type DsPrices = {
  asr_micro_usd_per_hour: number;
  tts_micro_usd_per_10k_chars: number;
  ocr_micro_usd_per_page: number;
  search_micro_usd_per_call: number;
  fetch_micro_usd_per_call: number;
};

/** Official limited-time prices checked in the 2026-11-14 probe report. */
export const DS_PRICES: DsPrices = {
  asr_micro_usd_per_hour: 58_000,
  tts_micro_usd_per_10k_chars: 225_000,
  ocr_micro_usd_per_page: 225,
  search_micro_usd_per_call: 750,
  fetch_micro_usd_per_call: 750,
};

export const DS_PRICE_KEYS: Record<keyof DsPrices, string> = {
  asr_micro_usd_per_hour: "ds:price:asr_micro_usd_per_hour",
  tts_micro_usd_per_10k_chars: "ds:price:tts_micro_usd_per_10k_chars",
  ocr_micro_usd_per_page: "ds:price:ocr_micro_usd_per_page",
  search_micro_usd_per_call: "ds:price:search_micro_usd_per_call",
  fetch_micro_usd_per_call: "ds:price:fetch_micro_usd_per_call",
};

/** Defaults from the shared F9DS rules: per user / per group, per day. */
export const DS_LIMITS: Record<DsPurpose, { user: number; group: number }> = {
  tts: { user: 20, group: 60 },
  ocr: { user: 30, group: 100 },
  search: { user: 50, group: 200 },
  fetch: { user: 50, group: 200 },
  asr: { user: 200, group: 1000 },
};

export const DS_LABEL: Record<DsPurpose, string> = {
  asr: "语音识别",
  tts: "语音合成",
  ocr: "文字识别",
  search: "联网搜索",
  fetch: "网页抓取",
};

const RETRYABLE: Record<DsFail["error_kind"], boolean> = {
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

const FAILURE: Record<
  DsFail["error_kind"],
  { reason_text: string; next_action: string }
> = {
  refused: {
    reason_text: "DeepSeek 的安全审核拒绝了这个内容",
    next_action: "换一种说法或换一份文件再试",
  },
  budget: {
    reason_text: "今天的 DeepSeek 预算已用完",
    next_action: "明天（悉尼时间 0 点后）再试，或让管理员提高 ds:daily_cap_micro_usd",
  },
  quota: {
    reason_text: "DeepSeek 请求太频繁或额度不足",
    next_action: "稍后重试；若持续出现，让管理员检查 DeepSeek 账户余额",
  },
  timeout: { reason_text: "DeepSeek 请求超时", next_action: "稍后重试" },
  upstream: {
    reason_text: "DeepSeek 服务暂时不可用",
    next_action: "稍后重试",
  },
  auth: {
    reason_text: "DeepSeek 密钥无效或未配置",
    next_action: "让管理员检查 DEEPSEEK_API_KEY",
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

function failure(
  kind: DsFail["error_kind"],
  status?: number,
  over?: Partial<Pick<DsFail, "reason_text" | "next_action" | "retryable">>,
): DsFail {
  return {
    ok: false,
    error_kind: kind,
    retryable: over?.retryable ?? RETRYABLE[kind],
    ...(status === undefined ? {} : { status }),
    reason_text: over?.reason_text ?? FAILURE[kind].reason_text,
    next_action: over?.next_action ?? FAILURE[kind].next_action,
  };
}

function isPurpose(value: unknown): value is DsPurpose {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(DS_PATHS, value)
  );
}

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * Billing counts a Han character as two and everything else as one; the probe
 * report reproduced 30 / 69 / 105 / 89 for the four measured samples.
 */
export function billedChars(text: unknown): number {
  let total = 0;
  for (const char of String(text ?? "")) total += HAN.test(char) ? 2 : 1;
  return total;
}

export function dsCostMicroUsd(
  purpose: DsPurpose,
  units: number,
  prices: DsPrices = DS_PRICES,
): number {
  const u = Math.max(0, Number(units) || 0);
  if (purpose === "asr")
    return Math.round((u * prices.asr_micro_usd_per_hour) / 3_600_000);
  if (purpose === "tts")
    return Math.round((u * prices.tts_micro_usd_per_10k_chars) / 10_000);
  if (purpose === "ocr") return Math.round(u * prices.ocr_micro_usd_per_page);
  if (purpose === "search")
    return Math.round(u * prices.search_micro_usd_per_call);
  return Math.round(u * prices.fetch_micro_usd_per_call);
}

async function setting(e: any, key: string): Promise<string | undefined> {
  try {
    const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?")
      .bind(key)
      .first();
    return row?.value == null ? undefined : String(row.value);
  } catch {
    return undefined;
  }
}

function isOff(value: string | undefined) {
  return (
    value != null && ["1", "true", "on", "yes"].includes(value.trim().toLowerCase())
  );
}

async function numberSetting(e: any, key: string, fallback: number) {
  const raw = await setting(e, key);
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** One price override read per call; anything malformed keeps the constant. */
async function priceFor(e: any, purpose: DsPurpose): Promise<DsPrices> {
  const prices = { ...DS_PRICES };
  if (!e?.DB) return prices;
  const field = (
    purpose === "asr"
      ? "asr_micro_usd_per_hour"
      : purpose === "tts"
        ? "tts_micro_usd_per_10k_chars"
        : purpose === "ocr"
          ? "ocr_micro_usd_per_page"
          : purpose === "search"
            ? "search_micro_usd_per_call"
            : "fetch_micro_usd_per_call"
  ) as keyof DsPrices;
  const raw = await setting(e, DS_PRICE_KEYS[field]);
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) prices[field] = n;
  }
  return prices;
}

/** One line per call: purpose/status/latency only — never the key or the text. */
function logCall(
  purpose: string,
  status: "ok" | "failed",
  latency_ms: number,
) {
  try {
    console.info("deepseek", JSON.stringify({ purpose, status, latency_ms }));
  } catch {}
}

function normalizeErrorData(data: any): string {
  const err = data && typeof data === "object" ? (data.error ?? {}) : {};
  return [
    (err as any)?.message,
    (err as any)?.type,
    (err as any)?.code,
    data && typeof data === "object" ? (data as any).message : "",
  ]
    .filter((part) => typeof part === "string" && part)
    .join(" ")
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
}

function classify(status: number, data: any): DsFail["error_kind"] {
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

function unitsFor(call: DsCall, data: any, ok: boolean): number {
  if (Number.isFinite(Number(call.units)))
    return Math.max(0, Math.floor(Number(call.units)));
  if (!ok) return 0;
  if (call.purpose === "tts") return billedChars(call.json?.text);
  if (call.purpose === "asr")
    return Number.isFinite(Number(data?.duration_ms))
      ? Math.max(0, Math.floor(Number(data.duration_ms)))
      : 0;
  if (call.purpose === "ocr")
    return Number.isFinite(Number(data?.page_count))
      ? Math.max(0, Math.floor(Number(data.page_count)))
      : 1;
  return 1;
}

async function recordUsage(
  e: any,
  call: DsCall,
  status: "ok" | "failed",
  error_kind: string | null,
  latency_ms: number,
  units: number,
  cost: number,
) {
  if (!e?.DB) return; // Smoke checks and unit tests may run without persistence.
  try {
    await e.DB.prepare(
      "INSERT INTO ds_usage(id,purpose,group_id,sender_id,status,error_kind,latency_ms,units,est_cost_micro_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        call.purpose,
        call.group ?? null,
        call.sender ?? null,
        status,
        error_kind,
        latency_ms,
        units,
        cost,
        Date.now(),
      )
      .run();
  } catch {
    // Accounting must never turn a successful call into a failure.
  }
}

function looksLikeJson(bytes: Uint8Array) {
  for (const byte of bytes) {
    if (byte === 32 || byte === 9 || byte === 10 || byte === 13) continue;
    return byte === 123 || byte === 91; // '{' or '['
  }
  return false;
}

function decodeJson(bytes: Uint8Array): any {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

export async function callDsTool<T = any>(
  e: any,
  call: DsCall,
): Promise<DsOk<T> | DsFail> {
  const started = Date.now();
  const purpose = call?.purpose;
  const finish = async (
    result: DsFail,
    units = 0,
    cost = 0,
  ): Promise<DsFail> => {
    const latency = Date.now() - started;
    logCall(String(purpose || "unknown"), "failed", latency);
    await recordUsage(
      e,
      call,
      "failed",
      result.error_kind,
      latency,
      units,
      cost,
    );
    return result;
  };

  if (!isPurpose(purpose))
    return finish(
      failure("denied", undefined, {
        reason_text: "请求地址不在允许范围",
        next_action: "只能调用 DeepSeek 固定的五个工具接口",
      }),
    );

  const key =
    typeof e?.DEEPSEEK_API_KEY === "string" ? e.DEEPSEEK_API_KEY.trim() : "";
  if (!key) return finish(failure("auth"));

  const headers: Record<string, string> = { Authorization: "Bearer " + key };
  let payload: any;
  if (call.form) {
    payload = call.form; // fetch adds the multipart boundary itself.
  } else {
    headers["Content-Type"] = "application/json";
    try {
      payload = JSON.stringify(call.json ?? {});
    } catch {
      return finish(
        failure("unsupported", undefined, {
          reason_text: "请求内容无法序列化",
          next_action: "检查调用参数",
        }),
      );
    }
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: any;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => {
        timedOut = true;
        controller.abort();
        reject(
          Object.assign(new Error("deepseek timeout"), {
            name: "TimeoutError",
          }),
        );
      },
      Math.max(1, Number(call.timeoutMs) || 30_000),
    );
  });

  const pending = fetch(DS_BASE + DS_PATHS[purpose], {
    method: "POST",
    headers,
    body: payload,
    redirect: "error",
    signal: controller.signal,
  });
  // The loser of the race may reject later; never leave it unhandled.
  pending.catch(() => {});

  let response: Response;
  try {
    response = await Promise.race([pending, deadline]);
  } catch (error: any) {
    const timed =
      timedOut ||
      controller.signal.aborted ||
      error?.name === "AbortError" ||
      error?.name === "TimeoutError";
    return finish(failure(timed ? "timeout" : "upstream"));
  } finally {
    clearTimeout(timer);
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return finish(failure("upstream", response.status));
  }
  if (bytes.byteLength > 24 * 1024 * 1024)
    return finish(failure("too_large", response.status));

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const expected = call.expect ?? (purpose === "tts" ? "bytes" : "json");
  const isJsonBody = contentType.includes("json") || looksLikeJson(bytes);

  if (!response.ok) {
    const data = isJsonBody ? decodeJson(bytes) : null;
    return finish(failure(classify(response.status, data), response.status));
  }

  if (expected === "bytes") {
    // TTS answers audio; a JSON body with 200 still means the call failed.
    if (isJsonBody) {
      const data = decodeJson(bytes);
      if (data && typeof data === "object" && "error" in data && (data as any).error)
        return finish(failure(classify(200, data), 200));
    }
    const units = unitsFor(call, null, true);
    const prices = await priceFor(e, purpose);
    const cost = Number.isFinite(Number(call.estCostMicroUsd))
      ? Math.max(0, Math.floor(Number(call.estCostMicroUsd)))
      : dsCostMicroUsd(purpose, units, prices);
    const latency = Date.now() - started;
    logCall(purpose, "ok", latency);
    await recordUsage(e, call, "ok", null, latency, units, cost);
    return {
      ok: true,
      data: null as T,
      bytes,
      latency_ms: latency,
      status: response.status,
      body_bytes: bytes.byteLength,
    };
  }

  const data = decodeJson(bytes);
  if (data == null) return finish(failure("upstream", response.status));
  if (typeof data === "object" && "error" in data && (data as any).error)
    return finish(failure(classify(200, data), 200));

  const units = unitsFor(call, data, true);
  const prices = await priceFor(e, purpose);
  const cost = Number.isFinite(Number(call.estCostMicroUsd))
    ? Math.max(0, Math.floor(Number(call.estCostMicroUsd)))
    : dsCostMicroUsd(purpose, units, prices);
  const latency = Date.now() - started;
  logCall(purpose, "ok", latency);
  await recordUsage(e, call, "ok", null, latency, units, cost);
  return {
    ok: true,
    data: data as T,
    latency_ms: latency,
    status: response.status,
    body_bytes: bytes.byteLength,
  };
}

export type DsGuard = { ok: true; release: () => Promise<void> } | DsFail;

/**
 * Reserve the per-user and per-group daily slots (plus off switches and the
 * daily budget). Call `release()` only when the following call failed or never
 * ran; a successful call keeps its reservations until the day rolls over.
 */
export async function dsGuard(
  e: any,
  o: { purpose: DsPurpose; group: string; sender: string },
): Promise<DsGuard> {
  if (!isPurpose(o?.purpose))
    return failure("denied", undefined, {
      reason_text: "未知的 DeepSeek 用途",
      next_action: "检查调用参数",
    });
  // Without D1 there is nothing to enforce; smoke checks use this path.
  if (!e?.DB) return { ok: true, release: async () => {} };

  if (isOff(await setting(e, "off:dstools")))
    return failure("denied", undefined, {
      reason_text: "DeepSeek 工具已关闭",
      next_action: "让管理员在设置里开启 dstools",
    });
  const purpose = o.purpose;
  if (isOff(await setting(e, `off:ds_${purpose}`)))
    return failure("denied", undefined, {
      reason_text: `DeepSeek ${DS_LABEL[purpose]}已关闭`,
      next_action: `让管理员在设置里开启 ds_${purpose}`,
    });

  const cap = await numberSetting(
    e,
    "ds:daily_cap_micro_usd",
    DS_DAILY_CAP_MICRO_USD,
  );
  let spent = 0;
  try {
    const row = await e.DB.prepare(
      "SELECT COALESCE(SUM(est_cost_micro_usd),0) AS spent FROM ds_usage WHERE created_at>=?",
    )
      .bind(sydneyDayStart())
      .first();
    spent = Number(row?.spent || 0);
  } catch {
    spent = 0;
  }
  if (spent >= cap)
    return failure("budget", undefined, {
      reason_text: "今天的 DeepSeek 预算已用完",
      next_action: "明天（悉尼时间 0 点后）再试，或让管理员提高 ds:daily_cap_micro_usd",
    });

  const now = Date.now();
  const windowMs = Math.max(1, now - sydneyDayStart(now));
  const defaults = DS_LIMITS[purpose];
  const held: string[] = [];
  const release = async () => {
    while (held.length) {
      const id = held.pop() as string;
      try {
        await releaseQuota(e, id);
      } catch {}
    }
  };

  if (o.sender) {
    const limit = await numberSetting(
      e,
      `ds:${purpose}:user_daily`,
      defaults.user,
    );
    const reservation = await reserveQuota(e, {
      kind: `ds:${purpose}:user`,
      key: String(o.sender),
      limit,
      windowMs,
    });
    if (!reservation.ok) {
      await release();
      return failure("quota", undefined, {
        reason_text: `今天的 DeepSeek ${DS_LABEL[purpose]}次数用完了（${reservation.used}/${reservation.limit}）`,
        next_action: `明天再试，或让管理员调整 ds:${purpose}:user_daily`,
        retryable: false,
      });
    }
    if (reservation.id) held.push(reservation.id);
  }

  if (o.group) {
    const limit = await numberSetting(
      e,
      `ds:${purpose}:group_daily`,
      defaults.group,
    );
    const reservation = await reserveQuota(e, {
      kind: `ds:${purpose}:group`,
      key: String(o.group),
      limit,
      windowMs,
    });
    if (!reservation.ok) {
      await release();
      return failure("quota", undefined, {
        reason_text: `这个群的 DeepSeek ${DS_LABEL[purpose]}次数用完了（${reservation.used}/${reservation.limit}）`,
        next_action: `明天再试，或让管理员调整 ds:${purpose}:group_daily`,
        retryable: false,
      });
    }
    if (reservation.id) held.push(reservation.id);
  }

  return { ok: true, release };
}

/** In-memory per-isolate throttle for the smoke endpoint: at most twice an hour. */
const selfTestHits: number[] = [];
const SELF_TEST_WINDOW_MS = 60 * 60 * 1000;
const SELF_TEST_MAX = 2;

export function _resetDsSelfTest() {
  selfTestHits.length = 0;
}

/**
 * Owner smoke check: one minimal search and one four-character TTS call.
 * Runs without persistence (`DB: undefined`) so it never writes D1.
 */
export async function dsSelfTest(
  e: any,
): Promise<{ status: number; body: any }> {
  const now = Date.now();
  while (selfTestHits.length && now - selfTestHits[0] >= SELF_TEST_WINDOW_MS)
    selfTestHits.shift();
  if (selfTestHits.length >= SELF_TEST_MAX)
    return {
      status: 429,
      body: {
        ok: false,
        error_kind: "quota",
        reason_text: "自检每小时最多 2 次",
        next_action: "稍后再试",
      },
    };

  if (isOff(await setting(e, "off:dstools")))
    return { status: 503, body: { ok: false, error: "deepseek tools disabled" } };
  selfTestHits.push(now);

  const started = Date.now();
  const smoke = { ...e, DB: undefined };
  const search = await callDsTool(smoke, {
    purpose: "search",
    json: { query: "ping", count: 1 },
    timeoutMs: 15_000,
  });
  if (!search.ok)
    return {
      status: 502,
      body: {
        ok: false,
        stage: "search",
        error_kind: search.error_kind,
        status: search.status,
        reason_text: search.reason_text,
        next_action: search.next_action,
        ms: Date.now() - started,
      },
    };
  const tts = await callDsTool(smoke, {
    purpose: "tts",
    json: { text: "语音自检", voice_id: "stella", format: "wav" },
    expect: "bytes",
    timeoutMs: 20_000,
  });
  if (!tts.ok)
    return {
      status: 502,
      body: {
        ok: false,
        stage: "tts",
        error_kind: tts.error_kind,
        status: tts.status,
        reason_text: tts.reason_text,
        next_action: tts.next_action,
        ms: Date.now() - started,
      },
    };

  return {
    status: 200,
    body: {
      ok: true,
      search: {
        ok: true,
        latency_ms: search.latency_ms,
        bytes: search.body_bytes ?? 0,
        results: Array.isArray((search.data as any)?.results)
          ? (search.data as any).results.length
          : 0,
      },
      tts: {
        ok: true,
        latency_ms: tts.latency_ms,
        bytes: tts.bytes?.byteLength ?? 0,
      },
      ms: Date.now() - started,
    },
  };
}
