import { TEAM } from "./config";

/**
 * F8 shared OpenAI channel. Image generation, vision, the second judge and
 * keyframes all come through here: one place for the secret, the fixed host,
 * error classification, accounting and the global daily cap.
 */
export const OPENAI_BASE = "https://api.openai.com";
export const OPENAI_DAILY_CAP_MICRO_USD = 3_000_000;

export type OpenAiPurpose = "image_gen" | "vision" | "judge" | "other";

export type OpenAiFail = {
  ok: false;
  error_kind:
    | "refused"
    | "budget"
    | "quota"
    | "timeout"
    | "upstream"
    | "auth"
    | "unsupported"
    | "denied";
  retryable: boolean;
  status?: number;
  reason_text: string;
  next_action: string;
};

export type OpenAiOk<T = any> = {
  ok: true;
  json: T;
  latency_ms: number;
  status: number;
};

export type OpenAiCall = {
  purpose: OpenAiPurpose;
  path: string;
  body: any;
  timeoutMs: number;
  group?: string;
  sender?: string;
  model: string;
  estCostMicroUsd?: number;
};

export type QuotaReservation = {
  ok: boolean;
  used: number;
  limit: number;
  /** Extra field: releaseQuota needs it. Kept optional so the agreed shape holds. */
  id?: string;
};

const RETRYABLE: Record<OpenAiFail["error_kind"], boolean> = {
  refused: false,
  budget: false,
  quota: true,
  timeout: true,
  upstream: true,
  auth: false,
  unsupported: false,
  denied: false,
};

const FAILURE: Record<
  OpenAiFail["error_kind"],
  { reason_text: string; next_action: string }
> = {
  refused: {
    reason_text: "图片内容安全系统拒绝了这个提示词",
    next_action: "换一个描述再试，或换一张图片",
  },
  budget: {
    reason_text: "今天的 OpenAI 预算已用完",
    next_action: "明天（悉尼时间 0 点后）再试，或联系管理员提高预算",
  },
  quota: {
    reason_text: "OpenAI 请求过于频繁或额度不足",
    next_action: "稍后重试；若持续出现，联系管理员检查 OpenAI 额度",
  },
  timeout: { reason_text: "OpenAI 请求超时", next_action: "稍后重试" },
  upstream: { reason_text: "OpenAI 服务暂时不可用", next_action: "稍后重试" },
  auth: {
    reason_text: "OpenAI 密钥无效或没有权限",
    next_action: "联系管理员检查 OPENAI_API_KEY",
  },
  unsupported: {
    reason_text: "OpenAI 不接受这个请求",
    next_action: "换一种请求方式，或联系管理员检查模型与参数",
  },
  denied: {
    reason_text: "这个 OpenAI 请求已被拒绝",
    next_action: "检查功能开关或请求路径",
  },
};

function failure(
  kind: OpenAiFail["error_kind"],
  status?: number,
  over?: Partial<Pick<OpenAiFail, "reason_text" | "next_action">>,
): OpenAiFail {
  return {
    ok: false,
    error_kind: kind,
    retryable: RETRYABLE[kind],
    ...(status === undefined ? {} : { status }),
    reason_text: over?.reason_text ?? FAILURE[kind].reason_text,
    next_action: over?.next_action ?? FAILURE[kind].next_action,
  };
}

/** Only a relative /v1/… path on the fixed host; anything carrying a host is refused. */
export function openAiPathAllowed(path: unknown): path is string {
  if (typeof path !== "string" || path.length <= 4) return false;
  if (!path.startsWith("/v1/")) return false;
  if (path.includes("//") || path.includes("\\") || /\s/.test(path)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  return true;
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

const TIMEZONE = TEAM.memory?.timezone || "Australia/Sydney";

function sydneyDay(at: number) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** Milliseconds that the zone is ahead of UTC at `ms` (DST-safe enough for a day start). */
function zoneOffset(ms: number) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour) % 24,
    Number(p.minute),
    Number(p.second),
  );
  return asUTC - Math.floor(ms / 1000) * 1000;
}

/** Start of the team's (Sydney) calendar day; the budget resets there. */
export function sydneyDayStart(at = Date.now()) {
  const [y, m, d] = sydneyDay(at).split("-").map(Number);
  const midnightUTC = Date.UTC(y, m - 1, d);
  let start = midnightUTC - zoneOffset(midnightUTC);
  start = midnightUTC - zoneOffset(start);
  return start;
}

async function budgetExhausted(e: any, estCost: number) {
  let spent = 0;
  try {
    const row = await e.DB.prepare(
      "SELECT COALESCE(SUM(est_cost_micro_usd),0) AS spent FROM openai_usage WHERE created_at>=?",
    )
      .bind(sydneyDayStart())
      .first();
    spent = Number(row?.spent || 0);
  } catch {
    return false;
  }
  let cap = OPENAI_DAILY_CAP_MICRO_USD;
  const raw = await setting(e, "openai:daily_cap_micro_usd");
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) cap = n;
  }
  return spent + Math.max(0, estCost) >= cap;
}

/** One line per call: purpose/model/latency only — never the key, never the prompt. */
function logCall(
  call: OpenAiCall,
  status: "ok" | "failed",
  error_kind: string | null,
  latency_ms: number,
) {
  try {
    console.info(
      "openai",
      JSON.stringify({
        purpose: call.purpose,
        model: call.model,
        status,
        error_kind,
        latency_ms,
      }),
    );
  } catch {}
}

async function recordUsage(
  e: any,
  call: OpenAiCall,
  status: "ok" | "failed",
  error_kind: string | null,
  latency_ms: number,
  cost: number,
) {
  try {
    await e.DB.prepare(
      "INSERT INTO openai_usage(id,purpose,model,group_id,sender_id,status,error_kind,latency_ms,est_cost_micro_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
      .bind(
        crypto.randomUUID(),
        call.purpose,
        call.model,
        call.group ?? null,
        call.sender ?? null,
        status,
        error_kind,
        latency_ms,
        cost,
        Date.now(),
      )
      .run();
  } catch {
    // Accounting must never turn a successful call into a failure.
  }
}

function classify(status: number, data: any): OpenAiFail["error_kind"] {
  const err = data && typeof data === "object" ? (data.error ?? {}) : {};
  const hay = (
    String((err as any)?.code ?? "") +
    " " +
    String((err as any)?.type ?? "") +
    " " +
    String((err as any)?.message ?? "")
  )
    .toLowerCase()
    .replace(/[\s_-]+/g, "_");
  if (status === 400 && /content_policy|safety|moderation/.test(hay))
    return "refused";
  if (status === 429)
    return /insufficient_quota|billing_hard_limit/.test(hay) ? "budget" : "quota";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "upstream";
  if (status === 400 || status === 404) return "unsupported";
  return "upstream";
}

export async function callOpenAi<T = any>(
  e: any,
  call: OpenAiCall,
): Promise<OpenAiOk<T> | OpenAiFail> {
  const started = Date.now();
  const estCost = Number.isFinite(Number(call?.estCostMicroUsd))
    ? Math.max(0, Math.floor(Number(call.estCostMicroUsd)))
    : 0;

  const finish = async (result: OpenAiFail) => {
    const latency = Date.now() - started;
    logCall(call, "failed", result.error_kind, latency);
    await recordUsage(e, call, "failed", result.error_kind, latency, 0);
    return result;
  };

  const off = await setting(e, "off:openai");
  if (off != null && ["1", "true", "on", "yes"].includes(off.trim().toLowerCase()))
    return finish(
      failure("denied", undefined, {
        reason_text: "OpenAI 功能已关闭",
        next_action: "联系管理员在设置里开启 openai",
      }),
    );

  if (!openAiPathAllowed(call?.path))
    return finish(
      failure("denied", undefined, {
        reason_text: "请求地址不在允许范围",
        next_action: "只允许调用 api.openai.com 的 /v1 接口",
      }),
    );

  const key =
    typeof e?.OPENAI_API_KEY === "string" ? e.OPENAI_API_KEY.trim() : "";
  if (!key) return finish(failure("auth"));

  if (await budgetExhausted(e, estCost)) return finish(failure("budget"));

  let payload: string;
  try {
    payload = JSON.stringify(call.body ?? {});
  } catch {
    return finish(
      failure("unsupported", undefined, {
        reason_text: "请求内容无法序列化",
        next_action: "检查调用参数",
      }),
    );
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer: any;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(
        Object.assign(new Error("openai timeout"), { name: "TimeoutError" }),
      );
    }, Math.max(1, Number(call.timeoutMs) || 1));
  });

  const pending = fetch(OPENAI_BASE + call.path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      "Content-Type": "application/json",
    },
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

  const latency = Date.now() - started;
  let data: any = null;
  try {
    data = await response.json();
  } catch {}

  if (!response.ok)
    return finish(failure(classify(response.status, data), response.status));
  if (data == null) return finish(failure("upstream", response.status));

  logCall(call, "ok", null, latency);
  await recordUsage(e, call, "ok", null, latency, estCost);
  return { ok: true, json: data as T, latency_ms: latency, status: response.status };
}

async function quotaCount(e: any, kind: string, key: string, cutoff: number) {
  const row = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM quota_reservations WHERE kind=? AND key=? AND created_at>=?",
  )
    .bind(kind, key, cutoff)
    .first();
  return Number(row?.n || 0);
}

/**
 * Atomic reservation: the decision lives inside one INSERT … SELECT … WHERE,
 * so concurrent callers cannot all pass the count and overdraw the bucket.
 */
export async function reserveQuota(
  e: any,
  o: { kind: string; key: string; limit: number; windowMs?: number },
): Promise<QuotaReservation> {
  const limit = Math.max(0, Math.floor(Number(o.limit) || 0));
  const now = Date.now();
  const cutoff = now - (o.windowMs ?? 24 * 60 * 60 * 1000);
  const kind = String(o.kind);
  const key = String(o.key);

  if (!limit)
    return { ok: false, used: await quotaCount(e, kind, key, cutoff), limit };

  const id = crypto.randomUUID();
  const result: any = await e.DB.prepare(
    "INSERT INTO quota_reservations(id,kind,key,created_at) SELECT ?,?,?,? WHERE (SELECT COUNT(*) FROM quota_reservations WHERE kind=? AND key=? AND created_at>=?)<?",
  )
    .bind(id, kind, key, now, kind, key, cutoff, limit)
    .run();
  const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
  const ok = changes > 0;
  return {
    ok,
    used: await quotaCount(e, kind, key, cutoff),
    limit,
    ...(ok ? { id } : {}),
  };
}

/** Give a reservation back after a failed or refused call. */
export async function releaseQuota(e: any, reservationId: string): Promise<void> {
  if (!reservationId) return;
  await e.DB.prepare("DELETE FROM quota_reservations WHERE id=?")
    .bind(reservationId)
    .run();
}
