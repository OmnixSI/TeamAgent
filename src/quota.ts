// ds-balance: answer "how much DeepSeek balance is left" from the provider's
// own read-only endpoint, and compare the read with the previous stored one.
//
// One ten-minute D1 cache keeps a chat from hammering the endpoint; one small
// ds_balance_snapshots row per currency holds the previous real read, so the
// next answer can say how much was used or topped up. No key, token or chat id
// is stored here or printed in the answer. A failed lookup is reported as a
// plain "cannot read it now" and never turned into a made-up number.
import { TEAM } from "./config";

export const DEEPSEEK_BALANCE_URL = "https://api.deepseek.com/user/balance";
export const DEEPSEEK_BALANCE_CACHE_KEY = "quota:deepseek:balance";
export const DEEPSEEK_BALANCE_TTL_MS = 10 * 60 * 1000;
export const DEEPSEEK_BALANCE_TIMEOUT_MS = 5000;
/** One account-wide snapshot: any group's question compares with the last one. */
export const DS_BALANCE_SCOPE = "global";
/** A-quota's warning line and exchange rate, reused for the non-owner band. */
export const DEEPSEEK_LOW_BALANCE_CNY = 10;
/** Team pricing converts at 7.2 CNY/USD; the balance endpoint reports CNY. */
export const CNY_PER_USD = 7.2;
/** USD-only accounts get their own threshold; never compare USD to ¥10. */
export const DEEPSEEK_LOW_BALANCE_USD = DEEPSEEK_LOW_BALANCE_CNY / CNY_PER_USD;

export type QuotaBand = "ok" | "low" | "critical" | "unknown";

const TIMEZONE = TEAM.memory?.timezone || "Australia/Sydney";

export type BalanceFailureKind =
  | "missing_key"
  | "timeout"
  | "upstream"
  | "auth"
  | "payment"
  | "rate_limit"
  | "invalid";

export type BalanceInfo = {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
  /** Raw provider decimals, kept exactly so the snapshot does not round. */
  totalText: string;
  grantedText: string;
  toppedUpText: string;
};

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
      infos: BalanceInfo[];
      /** True only when this read was served from the ten-minute cache. */
      fromCache?: boolean;
      /** True only when this read actually called the provider. */
      fresh?: boolean;
    }
  | {
      ok: false;
      at: number;
      kind: BalanceFailureKind;
      /** True only when this read was served from the ten-minute cache. */
      fromCache?: boolean;
      /** True only when this read actually called the provider. */
      fresh?: boolean;
    };

export type StoredBalanceRow = {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
};

export type StoredBalance = {
  at: number;
  rows: StoredBalanceRow[];
};

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

async function writeSetting(e: any, key: string, value: string): Promise<void> {
  await e.DB.prepare(
    "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  )
    .bind(key, value)
    .run();
}

function balanceText(value: any): string {
  return String(value ?? "")
    .replace(/,/g, "")
    .trim();
}

function numberText(value: any): string {
  return balanceText(value) || "0";
}

function parseBalance(value: any): DeepSeekBalance | null {
  const raw = parseJson(value);
  if (!raw || typeof raw !== "object" || typeof raw.ok !== "boolean") return null;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (raw.ok) {
    const infos = (Array.isArray(raw.infos) ? raw.infos : [])
      .map((entry: any) => {
        const currency = String(entry?.currency || "UNKNOWN").toUpperCase();
        const totalText = balanceText(entry?.totalText);
        const total = Number(totalText);
        if (totalText === "" || !Number.isFinite(total)) return null;
        const grantedText = numberText(entry?.grantedText);
        const toppedUpText = numberText(entry?.toppedUpText);
        return {
          currency,
          total,
          granted: Number(grantedText) || 0,
          toppedUp: Number(toppedUpText) || 0,
          totalText,
          grantedText,
          toppedUpText,
        };
      })
      .filter(Boolean) as BalanceInfo[];
    if (!infos.length) return null;
    const primary =
      infos.find((entry) => entry.currency === "CNY") || infos[0];
    return {
      ok: true,
      at,
      available:
        raw.available === true ? true : raw.available === false ? false : null,
      currency: primary.currency,
      total: primary.total,
      granted: primary.granted,
      toppedUp: primary.toppedUp,
      infos,
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
 * The provider's balance, served from D1 cache when it is younger than ten
 * minutes. A failure is cached too: asking again in the same window must not
 * hammer an endpoint that is already down.
 */
export async function readDeepSeekBalance(
  e: any,
  at = Date.now(),
  options: { cache?: string | null; maxAgeMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<DeepSeekBalance> {
  const maxAgeMs = options.maxAgeMs ?? DEEPSEEK_BALANCE_TTL_MS;
  const cache =
    options.cache === undefined
      ? await readSetting(e, DEEPSEEK_BALANCE_CACHE_KEY)
      : options.cache;
  const hit = cachedBalance(cache, at, maxAgeMs);
  if (hit) return { ...hit, fromCache: true, fresh: false };

  const key = String(e?.DEEPSEEK_API_KEY || "");
  if (!key) return { ok: false, at, kind: "missing_key", fresh: false };

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

  const infos: BalanceInfo[] = [];
  for (const entry of Array.isArray(body?.balance_infos) ? body.balance_infos : []) {
    const currency = String(entry?.currency || "UNKNOWN").toUpperCase();
    const totalText = balanceText(entry?.total_balance);
    const total = Number(totalText);
    if (totalText === "" || !Number.isFinite(total)) continue;
    const grantedText = numberText(entry?.granted_balance);
    const toppedUpText = numberText(entry?.topped_up_balance);
    infos.push({
      currency,
      total,
      granted: Number(grantedText) || 0,
      toppedUp: Number(toppedUpText) || 0,
      totalText,
      grantedText,
      toppedUpText,
    });
  }
  if (!infos.length) return store({ ok: false, at, kind: "invalid" });
  const primary = infos.find((entry) => entry.currency === "CNY") || infos[0];
  return store({
    ok: true,
    at,
    available:
      body?.is_available === true ? true : body?.is_available === false ? false : null,
    currency: primary.currency,
    total: primary.total,
    granted: primary.granted,
    toppedUp: primary.toppedUp,
    infos,
  });
}

/** The previous real read, one row per currency, or null on the first ask. */
export async function readBalanceSnapshot(
  e: any,
  scope = DS_BALANCE_SCOPE,
): Promise<StoredBalance | null> {
  try {
    const result = await e.DB.prepare(
      "SELECT currency,total_balance,granted_balance,topped_up_balance,created_at FROM ds_balance_snapshots WHERE scope=? ORDER BY currency",
    )
      .bind(scope)
      .all();
    const rows = (result?.results || []) as any[];
    if (!rows.length) return null;
    const at = Math.max(...rows.map((row) => Number(row.created_at) || 0));
    return {
      at,
      rows: rows.map((row) => ({
        currency: String(row.currency || "UNKNOWN").toUpperCase(),
        total: String(row.total_balance ?? ""),
        granted: String(row.granted_balance ?? ""),
        toppedUp: String(row.topped_up_balance ?? ""),
      })),
    };
  } catch {
    return null;
  }
}

async function writeBalanceSnapshot(
  e: any,
  balance: DeepSeekBalance & { ok: true },
  scope = DS_BALANCE_SCOPE,
): Promise<void> {
  for (const info of balance.infos) {
    await e.DB.prepare(
      "INSERT INTO ds_balance_snapshots(scope,currency,total_balance,granted_balance,topped_up_balance,created_at) VALUES(?,?,?,?,?,?) " +
        "ON CONFLICT(scope,currency) DO UPDATE SET total_balance=excluded.total_balance,granted_balance=excluded.granted_balance,topped_up_balance=excluded.topped_up_balance,created_at=excluded.created_at",
    )
      .bind(
        scope,
        info.currency,
        info.totalText,
        info.grantedText,
        info.toppedUpText,
        balance.at,
      )
      .run();
  }
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

function sydneyDate(at: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

function sydneyClock(at: number, withDate: boolean): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (kind: string) => parts.find((part) => part.type === kind)?.value || "";
  return (withDate ? get("month") + "-" + get("day") + " " : "") + get("hour") + ":" + get("minute");
}

function previousTime(at: number, now: number): string {
  return sydneyClock(at, sydneyDate(at) !== sydneyDate(now));
}

function balanceLine(balance: DeepSeekBalance & { ok: true }): string {
  const holding =
    "余额 " +
    money(balance.total, balance.currency) +
    "（赠送 " +
    money(balance.granted, balance.currency) +
    "、充值 " +
    money(balance.toppedUp, balance.currency) +
    "）";
  if (balance.available === false) return "DeepSeek 账户现在显示不可用，" + holding + "。";
  return "DeepSeek 里还有 " + money(balance.total, balance.currency) + "，其中赠送 " + money(balance.granted, balance.currency) + "、充值 " + money(balance.toppedUp, balance.currency) + "。";
}

function direction(value: number): string {
  return value > 0 ? "多了" : "少了";
}

function changeLine(
  previous: StoredBalance | null,
  balance: DeepSeekBalance & { ok: true },
  now: number,
): string {
  if (!previous || !previous.rows.length)
    return "这是第一次记录，以后我再回答就能告诉你比上次多了还是少了。";
  const before = previous.rows.find((row) => row.currency === balance.currency);
  if (!before) return "上次记录的是别的币种，这次先按第一次记录算。";
  const totalBefore = Number(before.total);
  const grantedBefore = Number(before.granted);
  const topUpBefore = Number(before.toppedUp);
  if (
    !Number.isFinite(totalBefore) ||
    !Number.isFinite(grantedBefore) ||
    !Number.isFinite(topUpBefore)
  )
    return "上次的记录不完整，这次先按第一次记录算。";

  const totalDelta = Number((balance.total - totalBefore).toFixed(2));
  const grantedDelta = Number((balance.granted - grantedBefore).toFixed(2));
  const topUpDelta = Number((balance.toppedUp - topUpBefore).toFixed(2));
  const when = previousTime(previous.at, now);
  if (totalDelta === 0 && grantedDelta === 0 && topUpDelta === 0)
    return "跟上次（" + when + "）比没有变化。";

  const main =
    totalDelta === 0
      ? "总共没变"
      : "总共" + direction(totalDelta) + " " + money(Math.abs(totalDelta), balance.currency);
  // Only spell out a part when it moved differently from the total; a normal
  // usage dip would otherwise repeat the same number twice.
  const parts: string[] = [];
  if (grantedDelta !== 0 && grantedDelta !== totalDelta)
    parts.push("赠送部分" + direction(grantedDelta) + " " + money(Math.abs(grantedDelta), balance.currency));
  if (topUpDelta !== 0 && topUpDelta !== totalDelta)
    parts.push("充值部分" + direction(topUpDelta) + " " + money(Math.abs(topUpDelta), balance.currency));
  return "比上次（" + when + "）" + [main, ...parts].join("，") + "。";
}

export function balanceFailureText(balance: DeepSeekBalance & { ok: false }): string {
  if (balance.kind === "missing_key")
    return "这次查不到 DeepSeek 余额，机器人这边还没配好查询权限，让管理员看一下。";
  if (balance.kind === "auth")
    return "这次查不到 DeepSeek 余额，账号的查询权限可能有问题，去 DeepSeek 后台看一眼。";
  if (balance.kind === "payment")
    return "这次查不到 DeepSeek 余额，账户可能欠费了，去 DeepSeek 后台看一眼。";
  if (balance.kind === "rate_limit")
    return "这次查不到 DeepSeek 余额，问得太频繁了，过一会儿再问我。";
  if (balance.kind === "timeout")
    return "这次查不到 DeepSeek 余额，查询超时了，过一会儿再问我。";
  if (balance.kind === "invalid")
    return "这次查到的余额我看不懂，先不猜，过一会儿再试。";
  return "这次查不到 DeepSeek 余额，服务暂时不通，过一会儿再问我。";
}

/** A-quota's non-owner wording, reused verbatim. */
function bandText(band: QuotaBand): string {
  if (band === "critical") return "额度：快没了。";
  if (band === "low") return "额度：偏低。";
  if (band === "unknown") return "额度：暂时查不到。";
  return "额度：够用。";
}

function balanceAmountLow(balance: DeepSeekBalance): boolean | null {
  if (!balance.ok) return null;
  const currency = balance.currency.toUpperCase();
  if (currency === "CNY") return balance.total < DEEPSEEK_LOW_BALANCE_CNY;
  if (currency === "USD") return balance.total < DEEPSEEK_LOW_BALANCE_USD;
  return null;
}

/**
 * Balance-only band for the focused tool: the full A-quota also estimated days
 * left from usage counters, which this narrow version intentionally does not
 * read. The words and thresholds are A-quota's.
 */
function balanceBand(balance: DeepSeekBalance): QuotaBand {
  if (!balance.ok) return "unknown";
  if (balance.available === false) return "critical";
  const low = balanceAmountLow(balance);
  return low === true ? "critical" : low === null ? "unknown" : "ok";
}

/**
 * Read-only answer for the get_quota tool: the current DeepSeek balance plus
 * how it moved since the previous real read. Exact amounts only for the owner
 * who directly asked; everyone else gets A-quota's one-line band. A failed
 * lookup returns an honest sentence (ok=true, so the model repeats it) instead
 * of invented numbers.
 */
export async function renderQuota(
  e: any,
  options: { owner: boolean; now?: number; scope?: string },
): Promise<
  | { ok: true; text: string }
  | {
      ok: false;
      error_kind: "unavailable";
      retryable: boolean;
      reason_text: string;
      next_action: string;
    }
> {
  const at = options.now ?? Date.now();
  try {
    const previous = await readBalanceSnapshot(e, options.scope);
    const balance = await readDeepSeekBalance(e, at);
    if (balance.ok && (balance.fresh || !previous)) {
      try {
        await writeBalanceSnapshot(e, balance, options.scope);
      } catch {}
    }
    if (!options.owner) return { ok: true, text: bandText(balanceBand(balance)) };
    if (!balance.ok) return { ok: true, text: balanceFailureText(balance) };
    return { ok: true, text: balanceLine(balance) + "\n" + changeLine(previous, balance, at) };
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
