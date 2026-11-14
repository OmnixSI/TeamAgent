// D2：日程 v2 的时间解析（纯函数，无 IO）。
// 规格：.agent/releases/D/design.md §5.5（When / ParseResult / 三个函数签名冻结）。
// 约束：不依赖 src/actions.ts（D3a 并行），Step 按 §5.4 结构同构声明；
//       日期一律走 zonedToUtc（两遍，DST 安全），不硬编码悉尼 +11。

/** design §5.4 的 Step；D3a 的 src/actions.ts 合并后类型同构，本包先自带声明。 */
export type Step =
  | {
      action: "records_summary";
      type: string;
      group_by?: string;
      period?: "all" | "today" | "yesterday" | "this_month" | "last_month";
    }
  | {
      action: "records_query";
      type: string;
      filter?: { person?: string; status?: string; text?: string };
      limit?: number;
    }
  | { action: "quota" }
  | { action: "token_usage"; period?: "today" | "yesterday" }
  | { action: "chat_digest"; days?: 1 | 7; topic?: string }
  | { action: "work_status" }
  | { action: "text"; text: string };

export type When =
  | { cadence: "daily"; time: string; tz: string }
  | { cadence: "weekly"; time: string; weekdays: number[]; tz: string }
  | { cadence: "monthly"; time: string; month_days: number[]; tz: string }
  | { cadence: "once"; run_at: number; tz: string }
  | {
      cadence: "every";
      every_minutes: number;
      window?: [string, string];
      until?: number;
      tz: string;
    };
export type ParseResult =
  | { ok: true; when: When; tzSaid: boolean; matched: string }
  | { ok: false; missing: "time" | "date"; cadence?: string }
  | null;

const DEFAULT_TZ = "Australia/Sydney";
const SYDNEY = "Australia/Sydney";
const SHANGHAI = "Asia/Shanghai";
const UTC = "UTC";
const MINUTE = 60000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

// ---------- 日期/时区（与 src/schedules.ts 的 zonedToUtc 同算法，本文件自足） ----------

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };
type Wall = { y: number; m: number; d: number; h: number; mi: number; wd: number };

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

function partsAt(ts: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const x of formatter(tz).formatToParts(new Date(ts)))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

function offsetAt(ts: number, tz: string): number {
  const base = ts - (((ts % 1000) + 1000) % 1000);
  const p = partsAt(base, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - base;
}

/** 墙上时间 → UTC 瞬间；两遍settle DST 边界。 */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetAt(guess, tz);
  const offset = offsetAt(ts, tz);
  if (ts + offset !== guess) ts = guess - offset;
  return ts;
}

function normalizeTz(tz?: string): string {
  const s = String(tz ?? "").trim();
  if (!s) return DEFAULT_TZ;
  try {
    formatter(s).format(new Date(0));
    return s;
  } catch {
    return DEFAULT_TZ;
  }
}

function wallAt(ts: number, tz: string): Wall {
  const p = partsAt(ts, tz);
  return {
    y: p.y,
    m: p.m,
    d: p.d,
    h: p.h,
    mi: p.mi,
    wd: new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay(),
  };
}

function addDays(y: number, m: number, d: number, n: number) {
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const x = new Date(Date.UTC(y, m - 1, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m - 1 && x.getUTCDate() === d;
}

const pad = (n: number) => String(n).padStart(2, "0");
const fmtTime = (h: number, mi: number) => `${pad(h)}:${pad(mi)}`;

// ---------- 数字 ----------

const CN_DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
const CN_NUM = "零〇一二两三四五六七八九十廿";
const NUM_SRC = `(?:\\d{1,3}|[${CN_NUM}]{1,3})`;

/** 「8」「八」「十五」「二十一」「廿三」→ 数字；认不出返回 null。 */
function parseCount(text: string): number | null {
  const s = String(text ?? "").trim();
  if (/^\d{1,3}$/.test(s)) return Number(s);
  const mixed = /^[零〇]+(\d{1,2})$/.exec(s);
  if (mixed) return Number(mixed[1]);
  if (!s || !new RegExp(`^[${CN_NUM}]+$`).test(s)) return null;
  let total = 0;
  let unit = 0;
  for (const ch of s) {
    if (ch === "廿") {
      total += 20;
      unit = 0;
    } else if (ch === "十") {
      total += (unit || 1) * 10;
      unit = 0;
    } else {
      unit = CN_DIGIT[ch];
      if (unit === undefined) return null;
    }
  }
  return total + unit;
}

// ---------- 通用类型 ----------

type Span = { start: number; end: number };
type ClockMatch = { h: number; mi: number; span: Span };
type DateMatch = { y: number; m: number; d: number; span: Span };

function covered(raw: string, spans: Span[]): string {
  const list = spans.filter((s) => s && s.end > s.start);
  if (!list.length) return raw;
  const start = Math.min(...list.map((s) => s.start));
  const end = Math.max(...list.map((s) => s.end));
  return raw.slice(start, end);
}

function good(when: When, tzSaid: boolean, matched: string): ParseResult {
  return { ok: true, when, tzSaid, matched };
}

// ---------- 时区词 ----------

const TZ_RE = /(北京时间|澳大利亚时间|澳洲时间|悉尼时间|国内时间|中国时间|格林威治|格林尼治|北京|悉尼|UTC)/i;

function matchTz(text: string): { tz: string; span: Span } | null {
  const m = TZ_RE.exec(text);
  if (!m) return null;
  const word = m[0];
  let tz = UTC;
  if (/北京|国内|中国/.test(word)) tz = SHANGHAI;
  else if (/悉尼|澳洲|澳大利亚/.test(word)) tz = SYDNEY;
  else tz = UTC;
  return { tz, span: { start: m.index, end: m.index + word.length } };
}

// ---------- 节奏词 ----------

const DAILY_RE = /每晚|每早|每(?:一)?(?:天|日)|天天/;
const EVERY_HALF_RE = /每\s*(?:隔\s*)?半\s*个?\s*(?:小时|钟头)/;
const EVERY_N_RE = new RegExp(`每\\s*(?:隔\\s*)?(${NUM_SRC})\\s*个?\\s*(分钟|小时|钟头)`);
const EVERY_HOUR_RE = /每\s*(?:隔\s*)?(?:一\s*个?\s*)?小时/;

const WD = "一二三四五六日天";
const WEEKLY_RANGE_RE = new RegExp(
  `(?:每(?:个|一)?)?(?:周|星期|礼拜)\\s*([${WD}])\\s*(?:到|至|~|—|-)\\s*(?:周|星期|礼拜)?\\s*([${WD}])`
);
const WEEKLY_LIST_RE = new RegExp(
  `每(?:个|一)?(?:周|星期|礼拜)\\s*([${WD}])((?:\\s*(?:、|,|，|和|及|与|\\/)?\\s*(?:周|星期|礼拜)?\\s*[${WD}])*)`
);
const WEEKLY_GENERIC_RE = /每(?:个|一)?(?:周|星期|礼拜)/;
const WORKDAY_RE = /工作日/;
const WEEKEND_RE = /(?:每(?:个|一)?)?周末/;

const MONTHLY_RE = /每(?:个)?月/;
const MONTH_END_RE = /每(?:个)?月(?:的)?(?:底|末|最后一天)|月底|月末|最后一天/;
const MONTH_START_RE = /每(?:个)?月(?:的)?初|月初/;
const MONTH_DAY_LIST_RE = new RegExp(
  `每(?:个)?月(?:的)?\\s*(${NUM_SRC}\\s*[号日](?:\\s*(?:、|,|，|和|及|与)\\s*${NUM_SRC}\\s*[号日])*)`
);

const WEEKDAY_OF: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};
const WEEKDAY_NAME = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const DAY_WORD_RE = /大后天|后天|明天|明日|明晚|今天|今日|今晚/;
const NEXT_WEEK_RE = new RegExp(`下(?:个)?(?:周|星期|礼拜)\\s*([${WD}])`);
const THIS_WEEK_RE = new RegExp(`(?:本|这)(?:个)?(?:周|星期|礼拜)\\s*([${WD}])`);
const BARE_WEEK_RE = new RegExp(
  `(?<!每)(?<!下)(?<!本)(?<!这)(?:周|星期|礼拜)\\s*([${WD}])`
);
const MONTH_DATE_RE = new RegExp(`(${NUM_SRC})\\s*月\\s*(${NUM_SRC})\\s*[日号]`);
const DAY_OF_MONTH_RE = new RegExp(`(?<![月号\\d])(${NUM_SRC})\\s*[日号]`);

const REL_NUM = `(?:半|\\d{1,3}|[${CN_NUM}]{1,3})`;
const REL_MIN_RE = new RegExp(`(${REL_NUM})\\s*个?\\s*(分钟|小时|钟头)\\s*(?:之后|以后|后)`);
const REL_DAY_RE = new RegExp(`(${REL_NUM})\\s*天\\s*(?:之后|以后|后)`);
const REL_WEEK_RE = new RegExp(`(${REL_NUM})\\s*(?:周|星期|礼拜)\\s*(?:之后|以后|后)`);

const VERB_RE = /提醒|叫我|喊我|通知|发|推送|推|播报|告诉|说|执行|运行/;
const MISSING_TIME_RE = /固定(?:的)?时间|某个时间|定时|找个时间|挑个时间|定个时间|一会儿/;

function addWeekdays(a: number, b: number): number[] {
  const out: number[] = [];
  let x = a;
  for (let i = 0; i < 7; i++) {
    out.push(x);
    if (x === b) break;
    x = (x + 1) % 7;
  }
  return out;
}

function matchEvery(text: string): { minutes: number; span: Span } | null {
  let m = EVERY_HALF_RE.exec(text);
  if (m) return { minutes: 30, span: { start: m.index, end: m.index + m[0].length } };
  m = EVERY_N_RE.exec(text);
  if (m) {
    const n = parseCount(m[1]);
    if (n === null) return null;
    const unit = m[2];
    const minutes = /小时|钟头/.test(unit) ? n * 60 : n;
    return { minutes, span: { start: m.index, end: m.index + m[0].length } };
  }
  m = EVERY_HOUR_RE.exec(text);
  if (m) return { minutes: 60, span: { start: m.index, end: m.index + m[0].length } };
  return null;
}

function matchDaily(text: string): { bias: "night" | "am" | null; span: Span } | null {
  const m = DAILY_RE.exec(text);
  if (!m) return null;
  const bias = m[0].startsWith("每晚") ? "night" : m[0].startsWith("每早") ? "am" : null;
  return { bias, span: { start: m.index, end: m.index + m[0].length } };
}

function matchWeekly(
  text: string
): { weekdays: number[] | null; span: Span } | null {
  let m = WORKDAY_RE.exec(text);
  if (m) return { weekdays: [1, 2, 3, 4, 5], span: { start: m.index, end: m.index + m[0].length } };

  m = WEEKEND_RE.exec(text);
  if (m) return { weekdays: [0, 6], span: { start: m.index, end: m.index + m[0].length } };

  m = WEEKLY_RANGE_RE.exec(text);
  if (m) {
    const a = WEEKDAY_OF[m[1]];
    const b = WEEKDAY_OF[m[2]];
    return { weekdays: addWeekdays(a, b), span: { start: m.index, end: m.index + m[0].length } };
  }

  m = WEEKLY_LIST_RE.exec(text);
  if (m) {
    const list = [WEEKDAY_OF[m[1]]];
    for (const ch of m[2] || "") {
      const n = WEEKDAY_OF[ch];
      if (n !== undefined && !list.includes(n)) list.push(n);
    }
    return { weekdays: list, span: { start: m.index, end: m.index + m[0].length } };
  }

  m = WEEKLY_GENERIC_RE.exec(text);
  if (m) return { weekdays: null, span: { start: m.index, end: m.index + m[0].length } };
  return null;
}

function matchMonthly(text: string): { monthDays: number[]; span: Span } | null {
  const spans: Span[] = [];
  const days: number[] = [];
  let found = false;

  let m = MONTH_END_RE.exec(text);
  if (m) {
    found = true;
    spans.push({ start: m.index, end: m.index + m[0].length });
    days.push(-1);
  }

  m = MONTH_START_RE.exec(text);
  if (m) {
    found = true;
    spans.push({ start: m.index, end: m.index + m[0].length });
    days.push(1);
  }

  m = MONTH_DAY_LIST_RE.exec(text);
  if (m) {
    found = true;
    spans.push({ start: m.index, end: m.index + m[0].length });
    for (const x of m[1].matchAll(new RegExp(`(${NUM_SRC})\\s*[号日]`, "g"))) {
      const n = parseCount(x[1]);
      if (n !== null && n >= 1 && n <= 31) days.push(n);
    }
  }

  const generic = MONTHLY_RE.exec(text);
  if (generic) {
    found = true;
    spans.push({ start: generic.index, end: generic.index + generic[0].length });
  }

  if (!found) return null;
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  const unique = [...new Set(days)].sort((a, b) => (a === -1 ? 1 : b === -1 ? -1 : a - b));
  return { monthDays: unique, span: { start, end } };
}

// ---------- 钟点 ----------

const PERIOD_SRC =
  "凌晨|清晨|清早|早晨|早上|上午|中午|下午|傍晚|晚上|晚间|夜里|夜晚|今晚|明晚|昨晚|半夜|午夜|晚|早";
const MIN_SRC = `(?:\\d{1,2}|[${CN_NUM}]{1,3}|[零〇]\\d{1,2})`;
const CLOCK_POINT_RE = new RegExp(
  `(?<!\\d)(${PERIOD_SRC})?\\s*(${NUM_SRC})\\s*[点时](?:\\s*(半|一刻|三刻|整|(${MIN_SRC})\\s*分))?`,
  "g"
);
const CLOCK_COLON_RE = new RegExp(
  `(?<!\\d)(${PERIOD_SRC})?\\s*(\\d{1,2})\\s*[:：]\\s*(\\d{2})`,
  "g"
);
const MIDNIGHT_RE = /午夜|半夜/;

function applyPeriod(h: number, period: string | undefined, bias?: "night" | "am" | null): number | null {
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  if (!period) {
    if (bias === "night") return h === 12 ? 0 : h >= 1 && h <= 11 ? h + 12 : h;
    if (bias === "am") return h === 12 ? 12 : h;
    return h;
  }
  if (/^(凌晨|半夜|午夜)$/.test(period)) return h === 12 ? 0 : h;
  if (/^(早上|早晨|清晨|清早|上午|早)$/.test(period)) return h;
  if (period === "中午") return h === 12 ? 12 : h < 6 ? h + 12 : h;
  if (/^(下午|傍晚)$/.test(period)) return h > 12 ? h : h === 12 ? 12 : h === 0 ? 12 : h + 12;
  if (/^(晚上|晚间|夜里|夜晚|晚|今晚|明晚|昨晚)$/.test(period))
    return h > 12 ? h : h === 12 ? 0 : h === 0 ? 0 : h + 12;
  return h;
}

function matchClockPoint(text: string, bias?: "night" | "am" | null): ClockMatch | null {
  CLOCK_POINT_RE.lastIndex = 0;
  const m = CLOCK_POINT_RE.exec(text);
  if (!m) return null;
  const hour = parseCount(m[2]);
  if (hour === null) return null;
  const h = applyPeriod(hour, m[1], bias);
  if (h === null) return null;
  let mi = 0;
  if (m[3]) {
    if (m[3] === "半") mi = 30;
    else if (m[3] === "一刻") mi = 15;
    else if (m[3] === "三刻") mi = 45;
    else if (m[3] === "整") mi = 0;
    else if (m[4]) {
      const n = parseCount(m[4]);
      if (n === null || n < 0 || n > 59) return null;
      mi = n;
    }
  }
  return { h, mi, span: { start: m.index, end: m.index + m[0].length } };
}

function matchClockColon(text: string, bias?: "night" | "am" | null): ClockMatch | null {
  CLOCK_COLON_RE.lastIndex = 0;
  const m = CLOCK_COLON_RE.exec(text);
  if (!m) return null;
  const hour = Number(m[2]);
  const mi = Number(m[3]);
  if (hour > 23 || mi > 59) return null;
  const h = applyPeriod(hour, m[1], bias);
  if (h === null) return null;
  return { h, mi, span: { start: m.index, end: m.index + m[0].length } };
}

function matchClock(text: string, bias?: "night" | "am" | null): ClockMatch | null {
  const point = matchClockPoint(text, bias);
  const colon = matchClockColon(text, bias);
  if (!point) return colon;
  if (!colon) return point;
  return point.span.start <= colon.span.start ? point : colon;
}

function matchMidnight(text: string): ClockMatch | null {
  const m = MIDNIGHT_RE.exec(text);
  if (!m) return null;
  return { h: 0, mi: 0, span: { start: m.index, end: m.index + m[0].length } };
}

function resolveClock(text: string, bias?: "night" | "am" | null): ClockMatch | null {
  return matchClock(text, bias) ?? matchMidnight(text);
}

// ---------- 一次性日期/相对时间 ----------

function matchRelative(text: string): { ms: number; span: Span } | null {
  const each = (re: RegExp, factor: (unit: string) => number): { ms: number; span: Span } | null => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 2), m.index);
      if (/每|隔/.test(before)) continue;
      const n = m[1] === "半" ? 0.5 : parseCount(m[1]);
      if (n === null || n <= 0) return null;
      const unit = m[2] || "";
      return { ms: n * factor(unit), span: { start: m.index, end: m.index + m[0].length } };
    }
    return null;
  };

  const min = each(REL_MIN_RE, (unit) => (/小时|钟头/.test(unit) ? HOUR : MINUTE));
  if (min) return min;
  const day = each(REL_DAY_RE, () => DAY);
  if (day) return day;
  return each(REL_WEEK_RE, () => WEEK);
}

function matchDayWord(text: string): { offset: number; bias: "night" | "am" | null; span: Span } | null {
  const m = DAY_WORD_RE.exec(text);
  if (!m) return null;
  const w = m[0];
  const offset = w === "大后天" ? 3 : w === "后天" ? 2 : w === "明天" || w === "明日" || w === "明晚" ? 1 : 0;
  const bias = /晚/.test(w) ? "night" : null;
  return { offset, bias, span: { start: m.index, end: m.index + w.length } };
}

function nextWeekdayAt(now: number, tz: string, idx: number, h: number, mi: number): number {
  const w = wallAt(now, tz);
  let delta = (idx - w.wd + 7) % 7;
  let t = addDays(w.y, w.m, w.d, delta);
  let ts = zonedToUtc(t.y, t.m, t.d, h, mi, tz);
  if (ts <= now) {
    t = addDays(t.y, t.m, t.d, 7);
    ts = zonedToUtc(t.y, t.m, t.d, h, mi, tz);
  }
  return ts;
}

function nextWeekAt(now: number, tz: string, idx: number, h: number, mi: number): number {
  const w = wallAt(now, tz);
  const toMon = ((8 - w.wd) % 7) || 7;
  const t = addDays(w.y, w.m, w.d, toMon + idx);
  return zonedToUtc(t.y, t.m, t.d, h, mi, tz);
}

function thisWeekAt(now: number, tz: string, idx: number, h: number, mi: number): number {
  const w = wallAt(now, tz);
  const fromMon = (w.wd + 6) % 7;
  let t = addDays(w.y, w.m, w.d, idx - fromMon);
  let ts = zonedToUtc(t.y, t.m, t.d, h, mi, tz);
  if (ts <= now) {
    t = addDays(t.y, t.m, t.d, 7);
    ts = zonedToUtc(t.y, t.m, t.d, h, mi, tz);
  }
  return ts;
}

function nextMonthDate(now: number, tz: string, month: number, day: number, h: number, mi: number): number | null {
  const w = wallAt(now, tz);
  let y = w.y;
  for (let i = 0; i < 8; i++) {
    if (validYmd(y, month, day)) {
      const ts = zonedToUtc(y, month, day, h, mi, tz);
      if (ts > now) return ts;
    }
    y++;
  }
  return null;
}

function nextDayOfMonth(now: number, tz: string, day: number, h: number, mi: number): number | null {
  const w = wallAt(now, tz);
  let y = w.y;
  let m = w.m;
  for (let i = 0; i < 24; i++) {
    if (validYmd(y, m, day)) {
      const ts = zonedToUtc(y, m, day, h, mi, tz);
      if (ts > now) return ts;
    }
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return null;
}

function nextWallTime(now: number, tz: string, h: number, mi: number): number {
  const w = wallAt(now, tz);
  let ts = zonedToUtc(w.y, w.m, w.d, h, mi, tz);
  if (ts <= now) {
    const t = addDays(w.y, w.m, w.d, 1);
    ts = zonedToUtc(t.y, t.m, t.d, h, mi, tz);
  }
  return ts;
}

// ---------- until（every 的截止） ----------

const UNTIL_RE = /(?:到|直到|至)\s*([^，。；,;]{0,12}?)(?:为止|截止|结束|之前|前)/;

function matchUntil(text: string, now: number, tz: string): number | null {
  const m = UNTIL_RE.exec(text);
  if (!m) return null;
  const clock = matchClock(" " + m[1]) ?? matchMidnight(m[1]);
  if (!clock) return null;
  return nextWallTime(now, tz, clock.h, clock.mi);
}

// ---------- 主函数 ----------

/**
 * 群友原话 → 日程时间。认不出返回 null；缺钟点/缺日期返回 {ok:false,missing}。
 * 绝不抛异常，也绝不为缺失的钟点编一个默认值。
 */
export function parseWhen(text: string, now: number, defaultTz?: string): ParseResult {
  try {
    const raw = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return null;
    const base = Number.isFinite(now) ? now : Date.now();
    const tzMatch = matchTz(raw);
    const tz = tzMatch ? tzMatch.tz : normalizeTz(defaultTz);
    const tzSaid = Boolean(tzMatch);
    const spans: Span[] = tzMatch ? [tzMatch.span] : [];

    // 每 N 分钟/小时：不需要钟点。
    const every = matchEvery(raw);
    if (every) {
      if (every.minutes < 5 || every.minutes > 1440) return { ok: false, missing: "time" };
      spans.push(every.span);
      const until = matchUntil(raw, base, tz);
      const when: When = {
        cadence: "every",
        every_minutes: every.minutes,
        tz,
        ...(until !== null ? { until } : {}),
      };
      return good(when, tzSaid, covered(raw, spans));
    }

    const monthly = matchMonthly(raw);
    if (monthly) {
      spans.push(monthly.span);
      if (!monthly.monthDays.length) return { ok: false, missing: "date", cadence: "monthly" };
      const clock = resolveClock(raw);
      if (!clock) return { ok: false, missing: "time" };
      spans.push(clock.span);
      const when: When = {
        cadence: "monthly",
        time: fmtTime(clock.h, clock.mi),
        month_days: monthly.monthDays,
        tz,
      };
      return good(when, tzSaid, covered(raw, spans));
    }

    const weekly = matchWeekly(raw);
    if (weekly) {
      spans.push(weekly.span);
      if (!weekly.weekdays) return { ok: false, missing: "date", cadence: "weekly" };
      const clock = resolveClock(raw);
      if (!clock) return { ok: false, missing: "time" };
      spans.push(clock.span);
      const when: When = {
        cadence: "weekly",
        time: fmtTime(clock.h, clock.mi),
        weekdays: weekly.weekdays,
        tz,
      };
      return good(when, tzSaid, covered(raw, spans));
    }

    const daily = matchDaily(raw);
    if (daily) {
      spans.push(daily.span);
      const clock = resolveClock(raw, daily.bias);
      if (!clock) return { ok: false, missing: "time" };
      spans.push(clock.span);
      const when: When = { cadence: "daily", time: fmtTime(clock.h, clock.mi), tz };
      return good(when, tzSaid, covered(raw, spans));
    }

    // once：相对时间优先（「十分钟后」明确）。
    const rel = matchRelative(raw);
    if (rel) {
      spans.push(rel.span);
      const when: When = { cadence: "once", run_at: base + rel.ms, tz };
      return good(when, tzSaid, covered(raw, spans));
    }

    const dayWord = matchDayWord(raw);
    const nextWeek = NEXT_WEEK_RE.exec(raw);
    const thisWeek = THIS_WEEK_RE.exec(raw);
    const monthDate = MONTH_DATE_RE.exec(raw);
    const dayOfMonth = monthDate ? null : DAY_OF_MONTH_RE.exec(raw);
    const bareWeek = dayWord || nextWeek || thisWeek || monthDate || dayOfMonth ? null : BARE_WEEK_RE.exec(raw);

    const dateSpan = dayWord
      ? dayWord.span
      : nextWeek
        ? { start: nextWeek.index, end: nextWeek.index + nextWeek[0].length }
        : thisWeek
          ? { start: thisWeek.index, end: thisWeek.index + thisWeek[0].length }
          : monthDate
            ? { start: monthDate.index, end: monthDate.index + monthDate[0].length }
            : dayOfMonth
              ? { start: dayOfMonth.index, end: dayOfMonth.index + dayOfMonth[0].length }
              : bareWeek
                ? { start: bareWeek.index, end: bareWeek.index + bareWeek[0].length }
                : null;

    if (dateSpan) {
      spans.push(dateSpan);
      const clock = resolveClock(raw, dayWord?.bias);
      if (!clock) return { ok: false, missing: "time" };
      spans.push(clock.span);

      let runAt: number | null = null;
      if (dayWord) {
        const w = wallAt(base, tz);
        const t = addDays(w.y, w.m, w.d, dayWord.offset);
        runAt = zonedToUtc(t.y, t.m, t.d, clock.h, clock.mi, tz);
        if (dayWord.offset === 0 && runAt <= base) {
          const t2 = addDays(t.y, t.m, t.d, 1);
          runAt = zonedToUtc(t2.y, t2.m, t2.d, clock.h, clock.mi, tz);
        }
      } else if (nextWeek) {
        runAt = nextWeekAt(base, tz, (WEEKDAY_OF[nextWeek[1]] + 6) % 7, clock.h, clock.mi);
      } else if (thisWeek) {
        runAt = thisWeekAt(base, tz, (WEEKDAY_OF[thisWeek[1]] + 6) % 7, clock.h, clock.mi);
      } else if (bareWeek) {
        runAt = nextWeekdayAt(base, tz, WEEKDAY_OF[bareWeek[1]], clock.h, clock.mi);
      } else if (monthDate) {
        const month = parseCount(monthDate[1]);
        const day = parseCount(monthDate[2]);
        if (month === null || day === null || month < 1 || month > 12 || day < 1 || day > 31)
          return null;
        runAt = nextMonthDate(base, tz, month, day, clock.h, clock.mi);
        if (runAt === null) return null;
      } else if (dayOfMonth) {
        const day = parseCount(dayOfMonth[1]);
        if (day === null || day < 1 || day > 31) return null;
        runAt = nextDayOfMonth(base, tz, day, clock.h, clock.mi);
        if (runAt === null) return null;
      }

      if (runAt === null) return null;
      const when: When = { cadence: "once", run_at: runAt, tz };
      return good(when, tzSaid, covered(raw, spans));
    }

    // 没有节奏词/日期，但「8点提醒我」这类裸钟点 + 动作动词可当今天/明天的 once。
    const clock = resolveClock(raw);
    if (clock && VERB_RE.test(raw)) {
      spans.push(clock.span);
      const runAt = nextWallTime(base, tz, clock.h, clock.mi);
      const when: When = { cadence: "once", run_at: runAt, tz };
      return good(when, tzSaid, covered(raw, spans));
    }

    if (MISSING_TIME_RE.test(raw)) return { ok: false, missing: "time" };
    return null;
  } catch {
    return null;
  }
}

// ---------- 内容关键词 → 步骤 ----------

function ledgerType(raw: string): string {
  const quoted = /[「“"]([^」”"]{1,20})[」”"]\s*(?:账本|账单)/.exec(raw);
  if (quoted) {
    const name = stripLedgerName(quoted[1]);
    if (name) return name;
  }
  if (/报销额度/.test(raw)) return "报销额度";
  const idx = Math.max(raw.lastIndexOf("账本"), raw.lastIndexOf("账单"));
  if (idx > 0) {
    const before = raw.slice(Math.max(0, idx - 12), idx);
    const parts = before.split(/[把将给跟和与的在于是为，,。；;：:「」“”"\s]/);
    const name = stripLedgerName(parts[parts.length - 1] || "");
    if (name) return name;
  }
  if (/报销/.test(raw)) return "报销";
  return "账本";
}

function stripLedgerName(value: string): string {
  let s = String(value ?? "").trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(
      /^(?:上个月|上月|上一个月|这个月|本月|当月|下个月|下月|昨天|昨日|今天|今日|明天|后天|每天|每月|每周|所有|全部|我的|你的|咱们的?|群里的?|这个|那个|这些|那些|每|的)+/,
      ""
    );
    if (next === s) break;
    s = next;
  }
  return s.replace(/^[的了着]+/, "").trim();
}

function recordsPeriod(raw: string): "all" | "today" | "yesterday" | "this_month" | "last_month" | undefined {
  if (/上个月|上月|上一个月/.test(raw)) return "last_month";
  if (/这个月|本月|当月/.test(raw)) return "this_month";
  if (/昨天|昨日/.test(raw)) return "yesterday";
  if (/今天|今日/.test(raw)) return "today";
  if (/所有|全部|历来|历史/.test(raw)) return "all";
  return undefined;
}

function tokenPeriod(raw: string): "today" | "yesterday" | undefined {
  if (/昨天|昨日/.test(raw)) return "yesterday";
  if (/今天|今日|当天/.test(raw)) return "today";
  return undefined;
}

function chatDays(raw: string): 1 | 7 {
  return /上周|最近一周|近一周|过去一周|最近7天|近7天/.test(raw) ? 7 : 1;
}

/**
 * 用户说要发什么 → 只读步骤。关键词按 §5.5；「日报/总结/昨日」在同时出现
 * 账本/余额/token 时只是格式词或时间修饰，不额外加聊天总结。
 */
export function parseContent(text: string): Step[] {
  try {
    const raw = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return [];

    const hasLedger = /账本|账单|记账|报销/.test(raw);
    const hasQuota = /余额|(?<!报销)额度/.test(raw);
    const hasToken = /token|tokens|用量|消耗/i.test(raw);
    const strongChat = /聊天|群聊|聊了|聊过|聊啥|聊什么|消息|聊天记录/.test(raw);
    const weakChat = /日报|总结|昨日|昨天|上周/.test(raw);

    const steps: Step[] = [];
    if (hasLedger) {
      const period = recordsPeriod(raw);
      const step: Step = { action: "records_summary", type: ledgerType(raw) };
      if (period) step.period = period;
      steps.push(step);
    }
    if (hasQuota) steps.push({ action: "quota" });
    if (hasToken) {
      const period = tokenPeriod(raw);
      steps.push(period ? { action: "token_usage", period } : { action: "token_usage" });
    }
    if (strongChat || (weakChat && !hasLedger && !hasQuota && !hasToken)) {
      steps.push({ action: "chat_digest", days: chatDays(raw) });
    }
    if (!steps.length) steps.push({ action: "text", text: raw.slice(0, 300) });
    return steps;
  } catch {
    return [];
  }
}

// ---------- 双时区文案 ----------

function tzLabel(tz: string): string {
  if (tz === SHANGHAI) return "北京时间";
  if (tz === SYDNEY) return "悉尼时间";
  if (tz === UTC) return "UTC";
  return tz;
}

function repInstant(when: When, now: number, h: number, mi: number): number {
  if (when.cadence === "once") return when.run_at;
  const w = wallAt(now, when.tz);
  return zonedToUtc(w.y, w.m, w.d, h, mi, when.tz);
}

function sydneyClock(ts: number): string {
  const p = partsAt(ts, SYDNEY);
  return fmtTime(p.h, p.mi);
}

function onceText(when: Extract<When, { cadence: "once" }>): string {
  const p = partsAt(when.run_at, when.tz);
  return `${p.y}年${p.m}月${p.d}日`;
}

/** 双时区文案：「每天 北京时间 00:00（悉尼 03:00）」「每月1日 09:00」。 */
export function describeWhen(when: When, now: number): string {
  try {
    const showTz = when.tz !== SYDNEY;
    const zone = showTz ? ` ${tzLabel(when.tz)}` : "";
    if (when.cadence === "daily") {
      const [h, mi] = when.time.split(":").map(Number);
      const ts = repInstant(when, now, h, mi);
      return `每天${zone} ${when.time}${showTz ? `（悉尼 ${sydneyClock(ts)}）` : ""}`;
    }
    if (when.cadence === "weekly") {
      const [h, mi] = when.time.split(":").map(Number);
      const ts = repInstant(when, now, h, mi);
      const names = when.weekdays.map((d) => WEEKDAY_NAME[d] ?? "周日").join("、");
      return `每${names}${zone} ${when.time}${showTz ? `（悉尼 ${sydneyClock(ts)}）` : ""}`;
    }
    if (when.cadence === "monthly") {
      const [h, mi] = when.time.split(":").map(Number);
      const ts = repInstant(when, now, h, mi);
      const days = when.month_days.map((d) => (d === -1 ? "最后一天" : `${d}日`)).join("、");
      return `每月${days}${zone} ${when.time}${showTz ? `（悉尼 ${sydneyClock(ts)}）` : ""}`;
    }
    if (when.cadence === "once") {
      const p = partsAt(when.run_at, when.tz);
      const time = fmtTime(p.h, p.mi);
      const sydney = sydneyClock(when.run_at);
      return `${onceText(when)}${zone} ${time}${showTz ? `（悉尼 ${sydney}）` : ""}`;
    }
    const n = when.every_minutes;
    let s = n % 60 === 0 && n >= 60 ? `每${n / 60}小时` : `每${n}分钟`;
    if (showTz) s += `（${tzLabel(when.tz)}）`;
    if (when.window) s += `，时段 ${when.window[0]}–${when.window[1]}`;
    if (when.until) {
      const p = partsAt(when.until, when.tz);
      s += `，到 ${fmtTime(p.h, p.mi)} 为止`;
    }
    return s;
  } catch {
    return when.cadence;
  }
}
