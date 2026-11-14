// A-quota: truthful, read-only quota self-knowledge.
//
// One balance lookup at a time, cached in D1 settings for ten minutes; every
// number the owner sees comes from a real provider table or the provider's own
// balance endpoint. Non-owners only ever get one coarse band word, so a public
// group can ask without publishing the team's spending. The developer-room
// morning report gets one line from `quota:morning`, refreshed once a day by
// `quotaMorningJob`; the bot never posts quota numbers to a chat by itself.
import type { CronJob } from "./cron-extra";
import { TEAM } from "./config";
import { AI_NEURONS_DAILY_CAP } from "./ai-budget";
import { OPENAI_DAILY_CAP_MICRO_USD, sydneyDayStart } from "./openai";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_BALANCE_CACHE_KEY = "quota:deepseek:balance";
export const DEEPSEEK_BALANCE_TTL_MS = 10 * 60 * 1000;
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 5000;

/** Order A-quota: below ¥10, or fewer than three days at the 7-day average. */
export const DEEPSEEK_LOW_BALANCE_CNY = 10;
export const DEEPSEEK_LOW_DAYS = 3;
export const DEEPSEEK_SPEND_WINDOW_MS = 7 * 86400000;
/** Team pricing converts at 7.2 CNY/USD; the balance endpoint reports CNY. */
export const CNY_PER_USD = 7.2;
/** USD-only accounts get their own threshold; never compare USD to ¥10. */
export const DEEPSEEK_LOW_BALANCE_USD = DEEPSEEK_LOW_BALANCE_CNY / CNY_PER_USD;

export const QUOTA_MORNING_KEY = "quota:morning";
export const QUOTA_LAST_KEY = "quota:last_snapshot";
export const QUOTA_MORNING_HOUR = 8;
const IMAGE_USER_DAILY_DEFAULT = 5;
const IMAGE_GROUP_DAILY_DEFAULT = 20;
/** Same rolling window as reserveQuota's default. */
const IMAGE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const TIMEZONE = TEAM.memory?.timezone || "Australia/Sydney";

export type BalanceFailureKind =
  | "missing_key"
  | "timeout"
  | "upstream"
  | "auth"
  | "payment"
  | "rate_limit"
  | "invalid";

export type DeepSeekBalance =
  | {
      ok: true;
      at: number;
      /** null when the provider omitted the optional is_available field. */
      available: boolean | null;
      currency: string;
      total: number;
      granted: number;
      toppedUp: number;
      /** Every balance_infos entry, raw decimal strings, for snapshot deltas. */
      totals: { currency: string; total: string }[];
      /** True only for this read when the D1 cache answered. Never persisted. */
      fromCache?: boolean;
      /** True only when this read actually called the provider. Never persisted. */
      fresh?: boolean;
    }
  | {
      ok: false;
      at: number;
      kind: BalanceFailureKind;
      /** True only for this read when the D1 cache answered. Never persisted. */
      fromCache?: boolean;
      /** True only when this read actually called the provider. Never persisted. */
      fresh?: boolean;
    };

export type QuotaSnapshot = {
  at: number;
  balance: DeepSeekBalance;
  /** True when this read came from the ten-minute D1 cache. */
  balanceFromCache: boolean;
  /** True only when this read actually called the balance endpoint. */
  balanceFresh: boolean;
  deepseek: {
    todayCalls: number;
    todayMicroUsd: number;
    monthCalls: number;
    monthMicroUsd: number;
    avg7MicroUsd: number;
  };
  openai: {
    todayCalls: number;
    todayMicroUsd: number;
    capMicroUsd: number;
    remainingMicroUsd: number;
  };
  images: { group: number; groupCap: number; user: number; userCap: number };
  ai: { used: number; cap: number };
};

export type QuotaBand = "ok" | "low" | "critical" | "unknown";

function sydneyDate(at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function sydneyHour(at: number): number {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: TIMEZONE,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at)),
  );
}

function sydneyClock(at: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value || "";
  return get("month") + "-" + get("day") + " " + get("hour") + ":" + get("minute");
}

/** First instant of the Sydney calendar month. */
export function sydneyMonthStart(at = Date.now()): number {
  const [year, month] = sydneyDate(at).split("-").map(Number);
  return sydneyDayStart(Date.UTC(year, month - 1, 1, 12));
}

function money(value: number, currency: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "——";
  const code = String(currency || "").toUpperCase();
  const digits = Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2;
  if (code === "CNY") return "¥" + amount.toFixed(digits);
  if (code === "USD") return "$" + amount.toFixed(digits);
  return amount.toFixed(digits) + "（币种未知）";
}

function usdMicro(value: number): string {
  const amount = Number(value) / 1e6;
  if (!Number.isFinite(amount) || amount === 0) return "$0";
  if (Math.abs(amount) < 0.01) return "$" + amount.toFixed(4);
  return "$" + amount.toFixed(2);
}

function parseJson(raw: any): any {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

async function readSetting(e: any, key: string): Promise<string | null> {
  try {
    const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
    return row ? String(row.value) : null;
  } catch {
    return null;
  }
}

async function readSettings(e: any, keys: string[]): Promise<Record<string, string>> {
  if (!keys.length) return {};
  try {
    const rows = (
      await e.DB.prepare(
        "SELECT key,value FROM settings WHERE key IN (" + keys.map(() => "?").join(",") + ")",
      )
        .bind(...keys)
        .all()
    ).results as any[];
    return Object.fromEntries(rows.map((row) => [String(row.key), String(row.value)]));
  } catch {
    return {};
  }
}

async function writeSetting(e: any, key: string, value: string): Promise<void> {
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(key, value)
    .run();
}

function parseBalance(value: any): DeepSeekBalance | null {
  const raw = parseJson(value);
  if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (raw.ok) {
    const total = Number(raw.total),
      granted = Number(raw.granted),
      toppedUp = Number(raw.toppedUp);
    if (!Number.isFinite(total)) return null;
    const currency = String(raw.currency || "UNKNOWN").toUpperCase();
    const totals = (Array.isArray(raw.totals) ? raw.totals : [])
      .map((entry: any) => ({
        currency: String(entry?.currency || "UNKNOWN").toUpperCase(),
        total: String(entry?.total ?? "").trim(),
      }))
      .filter((entry: any) => entry.total !== "");
    if (!totals.length) totals.push({ currency, total: String(raw.total) });
    return {
      ok: true,
      at,
      available:
        raw.available === true ? true : raw.available === false ? false : null,
      currency,
      total,
      granted: Number.isFinite(granted) ? granted : 0,
      toppedUp: Number.isFinite(toppedUp) ? toppedUp : 0,
      totals,
    };
  }
  const kind = String(raw.kind || "upstream");
  return {
    ok: false,
    at,
    kind: (["missing_key", "timeout", "upstream", "auth", "payment", "rate_limit", "invalid"].includes(kind)
      ? kind
      : "upstream") as BalanceFailureKind,
  };
}

function cachedBalance(raw: any, at: number, maxAgeMs: number): DeepSeekBalance | null {
  const value = parseBalance(raw);
  if (!value) return null;
  const age = at - value.at;
  return age >= 0 && age < maxAgeMs ? value : null;
}

/**
 * The provider's balance, served from the D1 cache when it is younger than ten
 * minutes. A failure is cached too: asking again in the same window must not
 * hammer an endpoint that is already down.
 */
export async function readDeepSeekBalance(
  e: any,
  at = Date.now(),
  options: { cache?: string | null; maxAgeMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<DeepSeekBalance> {
  const maxAgeMs = options.maxAgeMs ?? DEEPSEEK_BALANCE_TTL_MS;
  const cache = options.cache === undefined ? await readSetting(e, DEEPSEEK_BALANCE_CACHE_KEY) : options.cache;
  const hit = cachedBalance(cache, at, maxAgeMs);
  if (hit) return { ...hit, fromCache: true, fresh: false };

  const key = String(e?.DEEPSEEK_API_KEY || "");
  if (!key)
    return { ok: false, at, kind: "missing_key", fromCache: false, fresh: false };

  const store = async (value: DeepSeekBalance): Promise<DeepSeekBalance> => {
    const fresh = { ...value, fromCache: false, fresh: true } as DeepSeekBalance;
    try {
      await writeSetting(e, DEEPSEEK_BALANCE_CACHE_KEY, JSON.stringify(fresh));
    } catch {}
    return fresh;
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEEPSEEK_BALANCE_TIMEOUT_MS);
  let response: Response;
  try {
    const doFetch = options.fetchImpl || fetch;
    response = await doFetch(DEEPSEEK_BALANCE_URL, {
      method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (error: any) {
    const kind = error?.name === "AbortError" ? "timeout" : "upstream";
    return store({ ok: false, at, kind });
  } finally {
    clearTimeout(timer);
  }

  let body: any = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const kind =
      response.status === 401 || response.status === 403
        ? "auth"
        : response.status === 402
          ? "payment"
          : response.status === 429
            ? "rate_limit"
            : "upstream";
    return store({ ok: false, at, kind });
  }

  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : [];
  const info =
    infos.find((entry: any) => String(entry?.currency || "").toUpperCase() === "CNY") || infos[0];
  const rawTotal = String(info?.total_balance ?? "").replace(/,/g, "").trim();
  const total = rawTotal === "" ? NaN : Number(rawTotal);
  if (!info || !Number.isFinite(total)) return store({ ok: false, at, kind: "invalid" });

  const number = (value: any) => {
    const parsed = Number(String(value ?? "").replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const totals = infos
    .map((entry: any) => ({
      currency: String(entry?.currency || "UNKNOWN").toUpperCase(),
      total: String(entry?.total_balance ?? "").replace(/,/g, "").trim(),
    }))
    .filter((entry: any) => entry.total !== "");
  return store({
    ok: true,
    at,
    available:
      body?.is_available === true ? true : body?.is_available === false ? false : null,
    currency: String(info?.currency || "UNKNOWN").toUpperCase(),
    total,
    granted: number(info?.granted_balance),
    toppedUp: number(info?.topped_up_balance),
    totals,
  });
}

/** True when the account is below the matching currency's warning line. */
export function balanceAmountLow(balance: DeepSeekBalance): boolean | null {
  if (!balance.ok) return null;
  const currency = balance.currency.toUpperCase();
  if (currency === "CNY") return balance.total < DEEPSEEK_LOW_BALANCE_CNY;
  if (currency === "USD") return balance.total < DEEPSEEK_LOW_BALANCE_USD;
  return null;
}

function ratioBand(used: number, cap: number): QuotaBand {
  if (!Number.isFinite(cap) || cap <= 0) return "critical";
  const ratio = Math.max(0, used) / cap;
  if (ratio >= 0.9) return "critical";
  if (ratio >= 0.75) return "low";
  return "ok";
}

function daysLeft(balance: DeepSeekBalance, avg7MicroUsd: number): number | null {
  if (!balance.ok) return null;
  const dailyUsd = Math.max(0, Number(avg7MicroUsd) || 0) / 1e6;
  if (dailyUsd <= 0) return null;
  const currency = balance.currency.toUpperCase();
  if (currency === "USD") return balance.total / dailyUsd;
  if (currency === "CNY") return balance.total / CNY_PER_USD / dailyUsd;
  return null;
}

/** Balance currency, availability and the 7-day average decide the band. */
export function deepseekBand(balance: DeepSeekBalance, avg7MicroUsd: number): QuotaBand {
  if (!balance.ok) return "unknown";
  if (balance.available === false) return "critical";
  const amountLow = balanceAmountLow(balance);
  if (amountLow === true) return "critical";
  const days = daysLeft(balance, avg7MicroUsd);
  if (days === null) return amountLow === null ? "unknown" : "ok";
  if (days < 1.5) return "critical";
  if (days < DEEPSEEK_LOW_DAYS) return "low";
  return "ok";
}

/** Pure band calculator, exported so the thresholds can be tested directly. */
export function quotaBand(input: {
  balance: DeepSeekBalance | null;
  avg7MicroUsd: number;
  openaiUsedMicroUsd: number;
  openaiCapMicroUsd: number;
  aiUsed: number;
  aiCap: number;
}): QuotaBand {
  const deepseek = input.balance ? deepseekBand(input.balance, input.avg7MicroUsd) : "unknown";
  const openai = ratioBand(input.openaiUsedMicroUsd, input.openaiCapMicroUsd);
  const ai = ratioBand(input.aiUsed, input.aiCap);
  if ([deepseek, openai, ai].includes("critical")) return "critical";
  if ([deepseek, openai, ai].includes("low")) return "low";
  if (deepseek === "unknown") return "unknown";
  return "ok";
}

function bandText(band: QuotaBand): string {
  if (band === "critical") return "额度：快没了。";
  if (band === "low") return "额度：偏低。";
  if (band === "unknown") return "额度：暂时查不到。";
  return "额度：够用。";
}

function positive(value: any, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Every number here comes from a D1 table or the balance endpoint above. */
export async function quotaSnapshot(
  e: any,
  options: { at?: number; group?: string; sender?: string } = {},
): Promise<QuotaSnapshot> {
  const at = options.at ?? Date.now();
  const utcDay = new Date(at).toISOString().slice(0, 10);
  const aiKey = "budget:workers_ai_neurons:utc:" + utcDay;
  const settings = await readSettings(e, [
    DEEPSEEK_BALANCE_CACHE_KEY,
    "openai:daily_cap_micro_usd",
    "imagegen:user_daily",
    "imagegen:group_daily",
    aiKey,
    "workers_ai:neurons_cap",
  ]);
  const balance = await readDeepSeekBalance(e, at, {
    cache: settings[DEEPSEEK_BALANCE_CACHE_KEY] ?? null,
  });

  const today = sydneyDayStart(at);
  const month = sydneyMonthStart(at);
  const ds =
    (await e.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN created_at>=? THEN 1 ELSE 0 END),0) AS today_calls," +
        "COALESCE(SUM(CASE WHEN created_at>=? THEN est_cost_micro_usd ELSE 0 END),0) AS today_cost," +
        "COUNT(*) AS month_calls," +
        "COALESCE(SUM(est_cost_micro_usd),0) AS month_cost," +
        "COALESCE(SUM(CASE WHEN created_at>=? THEN est_cost_micro_usd ELSE 0 END),0) AS week_cost" +
        " FROM ds_usage WHERE created_at>=?",
    )
      .bind(today, today, at - DEEPSEEK_SPEND_WINDOW_MS, month)
      .first()) || {};
  const openai =
    (await e.DB.prepare(
      "SELECT COUNT(*) AS calls,COALESCE(SUM(est_cost_micro_usd),0) AS spent FROM openai_usage WHERE created_at>=?",
    )
      .bind(today)
      .first()) || {};
  // Read the same reservations the image limiter checks: a rolling 24 hours,
  // and failed calls have already been released.
  const images =
    (await e.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM quota_reservations WHERE kind='imagegen_group' AND key=? AND created_at>=?) AS total," +
        "(SELECT COUNT(*) FROM quota_reservations WHERE kind='imagegen_user' AND key=? AND created_at>=?) AS mine",
    )
      .bind(String(options.group || ""), at - IMAGE_QUOTA_WINDOW_MS, String(options.group || "") + ":" + String(options.sender || ""), at - IMAGE_QUOTA_WINDOW_MS)
      .first()) || {};

  const capMicroUsd = positive(settings["openai:daily_cap_micro_usd"], OPENAI_DAILY_CAP_MICRO_USD);
  const spentMicroUsd = Number(openai.spent) || 0;
  const aiCap = positive(settings["workers_ai:neurons_cap"], AI_NEURONS_DAILY_CAP);
  const aiUsed = positive(settings[aiKey], 0);

  return {
    at,
    balance,
    balanceFromCache: balance.fromCache === true,
    balanceFresh: balance.fresh === true,
    deepseek: {
      todayCalls: Number(ds.today_calls) || 0,
      todayMicroUsd: Number(ds.today_cost) || 0,
      monthCalls: Number(ds.month_calls) || 0,
      monthMicroUsd: Number(ds.month_cost) || 0,
      avg7MicroUsd: (Number(ds.week_cost) || 0) / 7,
    },
    openai: {
      todayCalls: Number(openai.calls) || 0,
      todayMicroUsd: spentMicroUsd,
      capMicroUsd,
      remainingMicroUsd: Math.max(0, capMicroUsd - spentMicroUsd),
    },
    images: {
      group: Number(images.total) || 0,
      groupCap: positive(settings["imagegen:group_daily"], IMAGE_GROUP_DAILY_DEFAULT),
      user: Number(images.mine) || 0,
      userCap: positive(settings["imagegen:user_daily"], IMAGE_USER_DAILY_DEFAULT),
    },
    ai: { used: aiUsed, cap: aiCap },
  };
}

type StoredQuota = {
  at: number;
  deepseek: Record<string, string>;
  dsCalls: number | null;
  dsMicroUsd: number | null;
  openaiCalls: number | null;
  openaiMicroUsd: number | null;
  aiUsed: number | null;
  band: QuotaBand | null;
};

function storedNumber(value: any): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseStoredQuota(raw: any): StoredQuota | null {
  const parsed = parseJson(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const at = Number(parsed.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  const deepseek: Record<string, string> = {};
  if (parsed.deepseek && typeof parsed.deepseek === "object") {
    for (const [currency, total] of Object.entries(parsed.deepseek)) {
      const value = typeof total === "string" ? total.trim() : "";
      if (/^[A-Z]{3,8}$/.test(currency) && value && Number.isFinite(Number(value))) {
        deepseek[currency] = value;
      }
    }
  }
  const band =
    parsed.band === "ok" || parsed.band === "low" || parsed.band === "critical"
      ? parsed.band
      : null;
  return {
    at,
    deepseek,
    dsCalls: storedNumber(parsed.dsCalls),
    dsMicroUsd: storedNumber(parsed.dsMicroUsd),
    openaiCalls: storedNumber(parsed.openaiCalls),
    openaiMicroUsd: storedNumber(parsed.openaiMicroUsd),
    aiUsed: storedNumber(parsed.aiUsed),
    band,
  };
}

/** Numbers and times only: no key, token or account identifier. */
function storedFromSnapshot(snapshot: QuotaSnapshot, band: QuotaBand): StoredQuota {
  const deepseek: Record<string, string> = {};
  if (snapshot.balance.ok) {
    for (const entry of snapshot.balance.totals) {
      if (!(entry.currency in deepseek)) deepseek[entry.currency] = entry.total;
    }
  }
  return {
    at: snapshot.at,
    deepseek,
    dsCalls: snapshot.deepseek.todayCalls,
    dsMicroUsd: snapshot.deepseek.todayMicroUsd,
    openaiCalls: snapshot.openai.todayCalls,
    openaiMicroUsd: snapshot.openai.todayMicroUsd,
    aiUsed: snapshot.ai.used,
    band,
  };
}

function sydneyTime(at: number, reference: number): string {
  const clock = sydneyClock(at).slice(-5);
  return sydneyDate(at) === sydneyDate(reference) ? clock : sydneyClock(at);
}

function signed(value: number, digits = 2): string {
  const rounded = Number(value.toFixed(digits));
  if (rounded === 0) return "0";
  return (rounded > 0 ? "+" : "−") + Math.abs(rounded).toFixed(digits);
}

function signedInt(value: number): string {
  if (value === 0) return "0";
  return (value > 0 ? "+" : "−") + Math.abs(value);
}

function signedUsd(microUsd: number): string {
  const value = Number(microUsd) / 1e6;
  const rounded = Number(value.toFixed(2));
  if (rounded === 0) return "$0";
  return (rounded > 0 ? "+" : "−") + "$" + Math.abs(rounded).toFixed(2);
}

function currencyUnit(currency: string): string {
  if (currency === "CNY") return "元";
  if (currency === "USD") return "美元";
  return currency;
}

function deltaLine(previous: StoredQuota | null, snapshot: QuotaSnapshot): string {
  if (!previous) return "较上次：这是第一次记录";
  const items: string[] = [];
  if (snapshot.balance.ok) {
    for (const entry of snapshot.balance.totals) {
      const before = previous.deepseek[entry.currency];
      const current = Number(entry.total);
      const old = Number(before);
      if (before === undefined || !Number.isFinite(current) || !Number.isFinite(old)) continue;
      const delta = Number((current - old).toFixed(2));
      if (delta === 0) continue;
      items.push("DeepSeek 余额 " + signed(delta) + " " + currencyUnit(entry.currency));
    }
  }
  if (previous.dsCalls !== null) {
    const delta = snapshot.deepseek.todayCalls - previous.dsCalls;
    if (delta !== 0) items.push("今日调用 " + signedInt(delta) + " 次");
  }
  if (previous.dsMicroUsd !== null) {
    const delta = snapshot.deepseek.todayMicroUsd - previous.dsMicroUsd;
    if (Math.round(delta / 10000) !== 0) items.push("今日 DeepSeek 花费 " + signedUsd(delta));
  }
  if (previous.openaiMicroUsd !== null) {
    const delta = snapshot.openai.todayMicroUsd - previous.openaiMicroUsd;
    if (Math.round(delta / 10000) !== 0) items.push("OpenAI 今日花费 " + signedUsd(delta));
  }
  if (previous.aiUsed !== null) {
    const delta = snapshot.ai.used - previous.aiUsed;
    if (delta !== 0) items.push("neurons " + signedInt(delta));
  }
  if (!items.length) return "较上次（" + sydneyTime(previous.at, snapshot.at) + "）：没变化";
  return "较上次（" + sydneyTime(previous.at, snapshot.at) + "）：" + items.join(" / ");
}

function notchNote(previous: StoredQuota | null, band: QuotaBand): string {
  const rank: Record<string, number> = { critical: 0, low: 1, ok: 2 };
  if (!previous || !previous.band) return "";
  const before = rank[previous.band],
    after = rank[band];
  if (before === undefined || after === undefined || before === after) return "";
  return after < before ? "（比上次低了一档）" : "（比上次高了一档）";
}

function balanceLine(balance: DeepSeekBalance): string {
  if (!balance.ok) {
    const suffix = "），请看 DeepSeek 后台";
    if (balance.kind === "missing_key") return "DeepSeek 余额：暂时查不到（没有配置密钥" + suffix;
    if (balance.kind === "auth") return "DeepSeek 余额：暂时查不到（密钥或权限问题" + suffix;
    if (balance.kind === "payment") return "DeepSeek 余额：暂时查不到（账户余额不足或欠费" + suffix;
    if (balance.kind === "rate_limit") return "DeepSeek 余额：暂时查不到（查询太频繁" + suffix;
    if (balance.kind === "timeout") return "DeepSeek 余额：暂时查不到（查询超时" + suffix;
    if (balance.kind === "invalid") return "DeepSeek 余额：暂时查不到（返回内容无法识别" + suffix;
    return "DeepSeek 余额：暂时查不到（接口暂时不可用" + suffix;
  }
  if (balance.available === false) return "DeepSeek 余额：账户当前不可用";
  return (
    "DeepSeek 余额：" +
    money(balance.total, balance.currency) +
    "（" +
    (balance.available === true ? "可用；" : "官方未返回可用状态；") +
    "赠送 " +
    money(balance.granted, balance.currency) +
    " / 充值 " +
    money(balance.toppedUp, balance.currency) +
    "；查于 " +
    sydneyClock(balance.at) +
    "）"
  );
}

export function ownerQuotaText(snapshot: QuotaSnapshot): string {
  const parts = [balanceLine(snapshot.balance)];
  const days = daysLeft(snapshot.balance, snapshot.deepseek.avg7MicroUsd);
  const average =
    snapshot.deepseek.avg7MicroUsd > 0
      ? "近 7 天日均 " + usdMicro(snapshot.deepseek.avg7MicroUsd)
      : "近 7 天没有用量";
  parts.push(
    "DeepSeek 用量：今天 " +
      snapshot.deepseek.todayCalls +
      " 次 / " +
      usdMicro(snapshot.deepseek.todayMicroUsd) +
      "，本月 " +
      snapshot.deepseek.monthCalls +
      " 次 / " +
      usdMicro(snapshot.deepseek.monthMicroUsd) +
      "；" +
      average +
      (days === null ? "" : "，按此估算余额约够 " + days.toFixed(1) + " 天"),
  );
  parts.push(
    "OpenAI：今天 " +
      snapshot.openai.todayCalls +
      " 次 / " +
      usdMicro(snapshot.openai.todayMicroUsd) +
      "，上限 " +
      usdMicro(snapshot.openai.capMicroUsd) +
      "，剩 " +
      usdMicro(snapshot.openai.remainingMicroUsd),
  );
  parts.push(
    "生图：近 24 小时本群 " +
      snapshot.images.group +
      " / " +
      snapshot.images.groupCap +
      " 张，你 " +
      snapshot.images.user +
      " / " +
      snapshot.images.userCap +
      " 张",
  );
  parts.push(
    "Workers AI：今天 " + snapshot.ai.used + " / " + snapshot.ai.cap + " neurons（UTC 日）",
  );
  parts.push("Cloudflare 账户级额度没有公开接口，请看 Cloudflare 后台。");
  return parts.join("\n");
}

/**
 * Read-only answer for the get_quota tool. The owner gets the real numbers;
 * everyone else gets one band word, because this is a public group.
 */
export async function renderQuota(
  e: any,
  options: { owner: boolean; group?: string; sender?: string; now?: number },
): Promise<
  | { ok: true; text: string; band: QuotaBand }
  | { ok: false; error_kind: "unavailable"; retryable: true; reason_text: string; next_action: string }
> {
  try {
    const previous = parseStoredQuota(await readSetting(e, QUOTA_LAST_KEY));
    const snapshot = await quotaSnapshot(e, {
      at: options.now,
      group: options.group,
      sender: options.sender,
    });
    const band = quotaBand({
      balance: snapshot.balance,
      avg7MicroUsd: snapshot.deepseek.avg7MicroUsd,
      openaiUsedMicroUsd: snapshot.openai.todayMicroUsd,
      openaiCapMicroUsd: snapshot.openai.capMicroUsd,
      aiUsed: snapshot.ai.used,
      aiCap: snapshot.ai.cap,
    });
    // A cache hit must not overwrite the previous real fetch; only a fresh
    // balance read advances the snapshot. The one exception is the very first
    // record (a cache seeded by the morning job), which initializes it once.
    if (snapshot.balanceFresh || !previous) {
      try {
        await writeSetting(e, QUOTA_LAST_KEY, JSON.stringify(storedFromSnapshot(snapshot, band)));
      } catch {}
    }
    if (!options.owner) {
      const note = notchNote(previous, band);
      const text = bandText(band);
      return { ok: true, text: note ? text.slice(0, -1) + note + "。" : text, band };
    }
    return { ok: true, text: ownerQuotaText(snapshot) + "\n" + deltaLine(previous, snapshot), band };
  } catch {
    return {
      ok: false,
      error_kind: "unavailable",
      retryable: true,
      reason_text: "暂时查不到额度，这次不猜数字",
      next_action: "如实告诉成员这次查不到，稍后可以再问",
    };
  }
}

/**
 * One line for the developer-room morning report. Empty when the balance is
 * healthy or unknown: the report must not grow a row that says nothing.
 */
export async function morningQuotaLine(e: any, at = Date.now()): Promise<string> {
  const cache = await readSetting(e, DEEPSEEK_BALANCE_CACHE_KEY);
  const balance = await readDeepSeekBalance(e, at, { cache });
  if (!balance.ok) return "";
  const spent =
    (
      await e.DB.prepare(
        "SELECT COALESCE(SUM(est_cost_micro_usd),0) AS spent FROM ds_usage WHERE created_at>=?",
      )
        .bind(at - DEEPSEEK_SPEND_WINDOW_MS)
        .first()
    )?.spent ?? 0;
  const average = (Number(spent) || 0) / 7;
  const days = daysLeft(balance, average);
  const belowAmount = balanceAmountLow(balance) === true;
  const belowDays = days !== null && days < DEEPSEEK_LOW_DAYS;
  const unavailable = balance.available === false;
  if (!belowAmount && !belowDays && !unavailable) return "";
  const moneyText = money(balance.total, balance.currency);
  const currency = balance.currency.toUpperCase();
  const reasons: string[] = [];
  if (unavailable) reasons.push("账户当前不可用");
  if (belowAmount) {
    const threshold = currency === "USD" ? "$" + DEEPSEEK_LOW_BALANCE_USD.toFixed(2) : "¥" + DEEPSEEK_LOW_BALANCE_CNY;
    reasons.push("低于 " + threshold + " 警戒线");
  }
  if (belowDays && days !== null) reasons.push("按近 7 天日均只够 " + days.toFixed(1) + " 天");
  return "DeepSeek 余额 " + moneyText + "，" + reasons.join("，") + "。";
}

/**
 * Daily 08:00 (Sydney) refresh for the morning report. One settings read per
 * tick in the window, one write per day; no group message is sent.
 */
export const quotaMorningJob: CronJob = {
  name: "quota-morning",
  async run(e: any, now: Date): Promise<void> {
    if (!e?.DB) return;
    const at = now instanceof Date ? now.getTime() : Date.now();
    if (sydneyHour(at) !== QUOTA_MORNING_HOUR) return;
    const day = sydneyDate(at);
    const previous = parseJson(await readSetting(e, QUOTA_MORNING_KEY));
    if (previous && previous.day === day) return;
    let line = "";
    try {
      line = await morningQuotaLine(e, at);
    } catch {
      line = "";
    }
    try {
      await writeSetting(e, QUOTA_MORNING_KEY, JSON.stringify({ day, at, line }));
    } catch {}
  },
};
