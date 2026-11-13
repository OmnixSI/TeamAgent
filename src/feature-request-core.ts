/**
 * F11 FR-1: pure helpers behind the feature-request gates.
 * No I/O except isAutoSender's single parameterised members lookup.
 * Signatures are frozen (src/feature-request-types.ts is the interface).
 */
import { TEAM } from "./config";
import type { FrConfig, FrRiskTag } from "./feature-request-types";

const FR_DEFAULTS: FrConfig = {
  enabled: true,
  auto_senders: [],
  daily_auto_cap: 5,
  daily_cap_per_sender: 10,
  group_daily_cap: 30,
  max_developing: 2,
  lease_hours: 6,
  stale_hours: 72,
  quote_max: 600,
  title_max: 80,
  detail_max: 2000,
};

const FR_NUMERIC_KEYS = [
  "daily_auto_cap",
  "daily_cap_per_sender",
  "group_daily_cap",
  "max_developing",
  "lease_hours",
  "stale_hours",
  "quote_max",
  "title_max",
  "detail_max",
] as const;

/** team.json feature_requests merged over defaults (types.ts FrConfig). Never throws. */
export function loadFrConfig(): FrConfig {
  const out: FrConfig = { ...FR_DEFAULTS, auto_senders: [] };
  const raw: any = (TEAM as any)?.feature_requests;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (
    Array.isArray(raw.auto_senders) &&
    raw.auto_senders.every(
      (x: unknown) => typeof x === "string" && x.trim().length > 0,
    )
  )
    out.auto_senders = raw.auto_senders.map((x: string) => x.trim());
  for (const key of FR_NUMERIC_KEYS) {
    const value = raw[key];
    if (Number.isInteger(value) && value > 0) out[key] = value;
  }
  return out;
}

// Order is FrRiskTag order; the first match wins per tag but tags keep this order.
const RISK_RULES: ReadonlyArray<readonly [FrRiskTag, RegExp]> = [
  [
    "permission",
    /权限|管理员|授权|白名单|越权|(?:^|[^a-z])admin(?:[^a-z]|$)|(?:^|[^a-z])role(?:[^a-z]|$)/,
  ],
  [
    "secret",
    /密钥|秘钥|令牌|密码|私钥|凭据|凭证|cookie|tokens?\b|api[\s_-]?key|secret|credential/,
  ],
  [
    "delete",
    /删除|删掉|清空|清除|抹掉|清库|删库|(?:^|[^a-z])drop(?:[^a-z]|$)|重置|覆盖/,
  ],
  [
    "outbound",
    /代我|替我|主动.{0,6}(?:发|私聊|群发|@所有人)|对外发|发消息规则|发言规则|自动回复规则|群发|私聊|@所有人|批量发/,
  ],
  ["spend", /付费|花钱|充值|订阅|购买|扣费|额度|套餐|付款|支付|发票/],
  [
    "injection",
    /忽略(?:以上|之前|上面)|忽略.{0,8}规则|system\s*prompt|你现在是|越狱|ignore\s+(?:previous|above)|<tool|```|开发者模式|jailbreak/,
  ],
];

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Lowercase, drop zero-width controls and fold full-width ASCII (NFKC). */
function normaliseRiskText(text: string): string {
  return text.normalize("NFKC").replace(ZERO_WIDTH, "").toLowerCase();
}

/** Conservative regex classifier over the concatenated text. Order of tags = order of FrRiskTag. */
export function classifyRisk(text: string): FrRiskTag[] {
  if (typeof text !== "string" || !text) return [];
  const normalised = normaliseRiskText(text);
  return RISK_RULES.filter(([, rule]) => rule.test(normalised)).map(
    ([tag]) => tag,
  );
}

const URL_RE = /https?:\/\/|www\.|\.(?:com|cn|org|net)(?:[/?#\s]|$)/i;
const FENCE_RE = /```|~~~/;
const HEX_RE = /(?:^|[^0-9a-z])[0-9a-f]{7,}(?![0-9a-z])/i;
const PATH_RE =
  /(?:[A-Za-z_.-][\w.-]*\/)+[\w.-]+|[\w-]+\.(?:ts|mts|cts|js|mjs|cjs|jsx|tsx|json|sql|py|md|toml|ya?ml)\b/;
const TECH_RE =
  /(?:^|[^a-z0-9])(?:worker|d1|migration|commit|api|token|sha|release|npm)(?![a-z0-9])|pr\s*#|数据库|部署|令牌|分支|回滚/i;
const MENTION_RE = /<@[^>]*>|@全体|@所有人/;

const REPLY_MAX = 120;

/** Validates user-facing reply text. ok=false → why is a short Chinese reason for the studio to rewrite. */
export function sanitizeReply(
  text: string,
  max?: number,
): { ok: true; text: string } | { ok: false; why: string } {
  const limit =
    Number.isFinite(max) && (max as number) > 0
      ? Math.floor(max as number)
      : REPLY_MAX;
  if (typeof text !== "string") return { ok: false, why: "回复必须是文字" };
  const raw = text.trim();
  if (!raw) return { ok: false, why: "回复不能为空" };
  if (raw.split(/\r\n|\r|\n/).length > 2)
    return { ok: false, why: "回复最多两行" };
  if (Array.from(raw).length > limit)
    return { ok: false, why: "回复太长（最多 " + limit + " 字）" };
  if (URL_RE.test(raw)) return { ok: false, why: "回复不能带链接" };
  if (FENCE_RE.test(raw)) return { ok: false, why: "回复不能带代码" };
  if (HEX_RE.test(raw))
    return { ok: false, why: "回复不能带版本号或哈希" };
  if (PATH_RE.test(raw)) return { ok: false, why: "回复不能带文件路径" };
  if (TECH_RE.test(raw))
    return { ok: false, why: "回复不能带技术细节" };
  if (MENTION_RE.test(raw)) return { ok: false, why: "回复不能 @ 人" };
  return { ok: true, text: clip(raw, limit) };
}

/** Trim, collapse whitespace, cut to max chars (by code points). */
export function clip(text: unknown, max: number): string {
  if (typeof text !== "string") return "";
  const limit =
    Number.isFinite(max) && max > 0 ? Math.floor(max) : 0;
  if (!limit) return "";
  const clean = text.replace(/\s+/g, " ").trim();
  return Array.from(clean).slice(0, limit).join("");
}

const SYDNEY_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Sydney",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** YYYY-MM-DD in Australia/Sydney for the epoch ms. */
export function sydneyDay(ms: number): string {
  const value = Number(ms);
  if (!Number.isFinite(value) || Math.abs(value) > 8.64e15) return "";
  const parts = SYDNEY_DATE.formatToParts(new Date(value));
  const part = (type: string) =>
    parts.find((p) => p.type === type)?.value ?? "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

/** config.auto_senders contains sender OR members(id=sender|'qq:'+sender, role='owner', revoked=0). */
export async function isAutoSender(
  e: any,
  sender: string,
  cfg?: FrConfig,
): Promise<boolean> {
  if (typeof sender !== "string" || !sender) return false;
  const config = cfg ?? loadFrConfig();
  if (
    Array.isArray(config?.auto_senders) &&
    config.auto_senders.includes(sender)
  )
    return true;
  try {
    const result = await e.DB.prepare(
      "SELECT role, revoked FROM members WHERE id IN (?, ?)",
    )
      .bind(sender, "qq:" + sender)
      .all();
    const rows = (result?.results ?? []) as Array<{
      role?: string;
      revoked?: number | string;
    }>;
    return rows.some(
      (row) => row.role === "owner" && Number(row.revoked) === 0,
    );
  } catch {
    return false;
  }
}
