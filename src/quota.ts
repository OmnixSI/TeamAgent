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

export const QUOTA_MORNING_KEY = "quota:morning";
export const QUOTA_MORNING_HOUR = 8;
const IMAGE_USER_DAILY_DEFAULT = 5;
const IMAGE_GROUP_DAILY_DEFAULT = 20;
/** Same rolling window as reserveQuota's default. */
const IMAGE_QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;

const TIMEZONE = TEAM.memory?.timezone || "Australia/Sydney";

export type BalanceFailureKind = "missing_key" | "timeout" | "upstream" | "auth" | "invalid";

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
    }
  | {
      ok: false;
      at: number;
      kind: BalanceFailureKind;
    };

export type QuotaSnapshot = {
  at: number;
  balance: DeepSeekBalance;
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
  const code = String(currency || "CNY").toUpperCase();
  const digits = Math.abs(amount) < 0.01 && amount !== 0 ? 4 : 2;
  if (code === "CNY") return "¥" + amount.toFixed(digits);
  if (code === "USD") return "$" + amount.toFixed(digits);
  return amount.toFixed(digits) + " " + code;
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
    return {
      ok: true,
      at,
      available:
        raw.available === true ? true : raw.available === false ? false : null,
      currency: String(raw.currency || "CNY").toUpperCase(),
      total,
      granted: Number.isFinite(granted) ? granted : 0,
      toppedUp: Number.isFinite(toppedUp) ? toppedUp : 0,
    };
  }
  const kind = String(raw.kind || "upstream");
  return {
    ok: false,
    at,
    kind: (["missing_key", "timeout", "upstream", "auth", "invalid"].includes(kind)
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
  if (hit) return hit;

  const key = String(e?.DEEPSEEK_API_KEY || "");
  if (!key)
    return { ok: false, at, kind: "missing_key" };

  const store = async (value: DeepSeekBalance): Promise<DeepSeekBalance> => {
    try {
      await writeSetting(e, DEEPSEEK_BALANCE_CACHE_KEY, JSON.stringify(value));
    } catch {}
    return value;
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
    const kind = response.status === 401 || response.status === 403 ? "auth" : "upstream";
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
  return store({
    ok: true,
    at,
    available:
      body?.is_available === true ? true : body?.is_available === false ? false : null,
    currency: String(info?.currency || "CNY").toUpperCase(),
    total,
    granted: number(info?.granted_balance),
    toppedUp: number(info?.topped_up_balance),
  });
}

function balanceCny(balance: DeepSeekBalance): number | null {
  if (!balance.ok) return null;
  if (balance.currency === "CNY") return balance.total;
  if (balance.currency === "USD") return balance.total * CNY_PER_USD;
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
  const cny = balanceCny(balance);
  if (cny === null) return null;
  const dailyUsd = Math.max(0, Number(avg7MicroUsd) || 0) / 1e6;
  if (dailyUsd <= 0) return null;
  return cny / CNY_PER_USD / dailyUsd;
}

/** Pure band calculator, exported so the thresholds can be tested directly. */
export function quotaBand(input: {
  balanceCny: number | null;
  /** false is the provider's own "cannot call" signal. */
  balanceAvailable?: boolean | null;
  avg7MicroUsd: number;
  openaiUsedMicroUsd: number;
  openaiCapMicroUsd: number;
  aiUsed: number;
  aiCap: number;
}): QuotaBand {
  let deepseek: QuotaBand;
  if (input.balanceAvailable === false) deepseek = "critical";
  else if (input.balanceCny === null || !Number.isFinite(input.balanceCny)) deepseek = "unknown";
  else if (input.balanceCny < DEEPSEEK_LOW_BALANCE_CNY) deepseek = "critical";
  else {
    const dailyUsd = Math.max(0, Number(input.avg7MicroUsd) || 0) / 1e6;
    const days = dailyUsd > 0 ? input.balanceCny / CNY_PER_USD / dailyUsd : null;
    deepseek = days === null ? "ok" : days < 1.5 ? "critical" : days < DEEPSEEK_LOW_DAYS ? "low" : "ok";
  }
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

function balanceLine(balance: DeepSeekBalance): string {
  if (!balance.ok) {
    if (balance.kind === "missing_key") return "DeepSeek 余额：暂时查不到（没有配置密钥）";
    return "DeepSeek 余额：暂时查不到（接口暂时不可用，10 分钟内不再重试）";
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
    const snapshot = await quotaSnapshot(e, {
      at: options.now,
      group: options.group,
      sender: options.sender,
    });
    const band = quotaBand({
      balanceCny: balanceCny(snapshot.balance),
      balanceAvailable: snapshot.balance.ok ? snapshot.balance.available : null,
      avg7MicroUsd: snapshot.deepseek.avg7MicroUsd,
      openaiUsedMicroUsd: snapshot.openai.todayMicroUsd,
      openaiCapMicroUsd: snapshot.openai.capMicroUsd,
      aiUsed: snapshot.ai.used,
      aiCap: snapshot.ai.cap,
    });
    if (!options.owner) return { ok: true, text: bandText(band), band };
    return { ok: true, text: ownerQuotaText(snapshot), band };
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
  const belowAmount = (balanceCny(balance) ?? Infinity) < DEEPSEEK_LOW_BALANCE_CNY;
  const belowDays = days !== null && days < DEEPSEEK_LOW_DAYS;
  const unavailable = balance.available === false;
  if (!belowAmount && !belowDays && !unavailable) return "";
  const moneyText = money(balance.total, balance.currency);
  const reasons: string[] = [];
  if (unavailable) reasons.push("账户当前不可用");
  if (belowAmount) reasons.push("低于 ¥" + DEEPSEEK_LOW_BALANCE_CNY + " 警戒线");
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
