// F6-6 用户日程：每日/每周摘要、一次性提醒、定时闭嘴。
// 纯时间计算放在文件顶部，便于按悉尼夏令时做红绿测试；所有出站都走现有 outbox。
import { composeWithNote, joinResults, runSteps, validateSteps } from "./actions";
import { left } from "./d1";
import { model, redact } from "./runtime";
import { namesFor } from "./context";
import { TEAM } from "./config";

export type ScheduleKind = "digest_daily" | "digest_weekly" | "reminder" | "mute" | "agent_task";
/** D 版：日程节奏；旧行没有这个字段，按 kind/spec 推断（见 cadenceOf）。 */
export type Cadence = "daily" | "weekly" | "monthly" | "once" | "every";
export type ScheduleSpec = {
  time?: string;
  weekdays?: number[];
  run_at?: number | string;
  text?: string;
  minutes?: number;
  cadence?: Cadence;
  /** 1..31，-1 = 当月最后一天。 */
  month_days?: number[];
  /** 5..1440 分钟。 */
  every_minutes?: number;
  /** every 的时段，墙上时间 "HH:MM"。 */
  window?: [string, string];
  /** 截止毫秒；every/once 用。 */
  until?: number;
  /** agent_task 的动作步骤（Step[]，§5.4）。 */
  steps?: unknown[];
  /** agent_task 的成文说明（≤600 字）。 */
  note?: string;
  /** 回执与推送标题（≤40 字）。 */
  title?: string;
  /** L1：自定义主题推送（1–40 字）。有它就不是「昨日总结」，而是写这个话题。 */
  topic?: string;
  /** L1：跨群唯一的去重键，出站 id 变成 `<dedup>:<悉尼日期>`。 */
  dedup?: string;
  /** L1：只用于展示和复盘统计。 */
  origin?: "chat" | "review" | "backfill";
  /** L1：成员原话（≤200 字），作为对推送内容口径的说明。 */
  request_quote?: string;
};
export type NewSchedule = {
  group_id: string;
  owner: string;
  kind: ScheduleKind;
  spec?: ScheduleSpec;
  tz?: string;
  source_msg_id?: string;
};

const MINUTE = 60000;
const LATE_AFTER = 5 * MINUTE;
// F6P-3：重启后错过的 08:00 日推在 2 小时内仍补发，之后作废；与 FIX-resend
// 的日程出站 2 小时窗口（src/recovery-policy.ts）同口径。mute 到期只解除静默，
// 不受这个上界影响。
export const MAX_MISSED_AGE_MS = 2 * 60 * MINUTE;
const RETRY_AFTER = 5 * MINUTE;
const DEFAULT_TZ = "Australia/Sydney";
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// L1：上限放 config/team.json 的 schedules 节；读不到就用设计里的默认值。
const SCHEDULE_LIMITS = ((TEAM as any)?.schedules || {}) as Record<string, unknown>;
const MAX_ACTIVE_PER_GROUP = Number(SCHEDULE_LIMITS.max_active_per_group) || 5;
const MAX_SENDS_PER_GROUP_DAY = Number(SCHEDULE_LIMITS.max_sends_per_group_day) || 6;
const MAX_SENDS_DAY = Number(SCHEDULE_LIMITS.max_sends_day) || 20;
/** D 版：每 tick 最多几个真正要调模型的任务（其余顺延到下一分钟）。 */
const MAX_AGENT_MODEL_PER_TICK = Number(SCHEDULE_LIMITS.agent_model_calls_per_tick) || 2;
/** D 版：每群每天 agent_task 运行次数（数 schedule_runs）。 */
const MAX_AGENT_RUNS_PER_GROUP_DAY = Number(SCHEDULE_LIMITS.agent_runs_per_group_day) || 24;
/** D 版：连续失败到这个次数就暂停并发一条通知。 */
const FAIL_PAUSE_AFTER = Number(SCHEDULE_LIMITS.fail_pause_after) || 9;
const DIGEST_PROMPT =
  "你在为群聊写日报。只写群里发布的日报正文：最多8行，先一句总览，再列3–6条真正有信息量的进展、决定或待办（点到相关的人或项目），最后一行只写一条最该推进的事。" +
  "只用消息里出现的事实，不编造，不猜没提到的计划；没有内容就直说没有新消息。不要客套、标题、表格或链接。";
/** L1：有 topic 的 digest 走这个提示词；素材不够就直说，不编。 */
const topicPrompt = (topic: string, maxLines: number) =>
  `你在为群聊写『${topic}』。只用下面消息里出现的事实；与主题无关的不写；素材不够就写一句『今天没有可报的${topic}内容』。最多 ${maxLines} 行，不要标题、表格、链接。`;
/** L1：成员原话接在提示词后面，作为内容口径。 */
const quoteLine = (quote: string) => `\n成员原话要求：${quote}；照这个口径写。`;

const pad = (n: number) => String(n).padStart(2, "0");

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function partsAt(ts: number, tz: string): Parts {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts)))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, m: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** Offset of the zone at that instant, in ms (local wall time minus UTC). */
function offsetAt(ts: number, tz: string) {
  const base = ts - (((ts % 1000) + 1000) % 1000);
  const p = partsAt(base, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - base;
}

/** Local wall time in tz → UTC instant. Two passes settle a DST boundary. */
function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let ts = guess - offsetAt(guess, tz);
  const offset = offsetAt(ts, tz);
  if (ts + offset !== guess) ts = guess - offset;
  return ts;
}

function addDays(y: number, m: number, d: number, n: number) {
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
}

/** run_at 接受毫秒、带时区的 ISO，也接受成员口中的「明天 9:00」无时区写法（按悉尼墙上时间）。 */
export function parseRunAt(value: unknown, tz: string) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim();
  if (!text) return 0;
  if (/^\d{10,}$/.test(text)) return Number(text);
  if (/(?:z|[+-]\d{2}:?\d{2})$/i.test(text)) return Date.parse(text);
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(text);
  if (local) return zonedToUtc(Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), tz);
  return Date.parse(text);
}

function parseTime(value: unknown): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!match) return null;
  const h = Number(match[1]), mi = Number(match[2]);
  return h >= 0 && h <= 23 && mi >= 0 && mi <= 59 ? [h, mi] : null;
}

// ---------- L1：群友原话 → 日程请求（L2 的 promiseGuard、L8 的回填共用；纯函数，不读写库） ----------

export type ParsedScheduleRequest = {
  cadence: "daily" | "weekly";
  time: string;
  weekdays?: number[];
  topic: string;
};

const CN_DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const WEEKDAY_OF: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const CN_NUMBER = "\\d{1,3}|[〇零一二两三四五六七八九十]{1,3}";

/** 「8」「八」「十五」「二十一」→ 数字；认不出返回 null。 */
function parseCount(text: string): number | null {
  if (/^\d{1,3}$/.test(text)) return Number(text);
  if (!text || !/^[〇零一二两三四五六七八九十]+$/.test(text)) return null;
  let total = 0;
  let unit = 0;
  for (const ch of text) {
    if (ch === "十") {
      total += (unit || 1) * 10;
      unit = 0;
    } else unit = CN_DIGIT[ch];
  }
  return total + unit;
}

/** 时段词 → 上午/下午/夜里；没有时段词时只有「每晚」这类线索才敢当晚上。 */
function periodOf(word: string | undefined, evening: boolean) {
  if (word === "下午" || word === "傍晚") return "pm" as const;
  if (word === "晚上" || word === "夜里" || word === "晚间") return "night" as const;
  if (word === "中午") return "noon" as const;
  if (word) return "am" as const;
  return evening ? ("night" as const) : null;
}

function applyPeriod(hour: number, period: ReturnType<typeof periodOf>): number | null {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return null;
  if (period === "pm") return hour === 12 ? 12 : hour + 12;
  if (period === "night") return hour === 12 ? 0 : hour + 12;
  if (period === "noon") return hour === 12 ? 12 : hour < 6 ? hour + 12 : hour;
  if (period === "am") return hour === 12 ? 0 : hour;
  return hour;
}

/** 只认紧跟在频率词后面的那个时间；认不出就是 null，不往后猜。 */
function clockAtStart(text: string, evening: boolean): { h: number; mi: number; rest: string } | null {
  const src = text.replace(/^\s+/, "");
  const colon = new RegExp(
    `^(?:(凌晨|早上|早晨|清早|上午|中午|下午|傍晚|晚上|夜里|晚间))?\\s*(\\d{1,2})\\s*[:：]\\s*(\\d{2})`,
  ).exec(src);
  if (colon) {
    const h = applyPeriod(Number(colon[2]), periodOf(colon[1], evening));
    const mi = Number(colon[3]);
    if (h === null || mi > 59) return null;
    return { h, mi, rest: src.slice(colon[0].length) };
  }
  const point = new RegExp(
    `^(?:(凌晨|早上|早晨|清早|上午|中午|下午|傍晚|晚上|夜里|晚间))?\\s*(${CN_NUMBER})\\s*[点时]\\s*(?:半|(${CN_NUMBER})\\s*分?)?`,
  ).exec(src);
  if (!point) return null;
  const h = applyPeriod(parseCount(point[2]) ?? NaN, periodOf(point[1], evening));
  if (h === null) return null;
  const mi = point[3] ? parseCount(point[3]) : /\s*[点时]\s*半/.test(point[0]) ? 30 : 0;
  if (mi === null || mi > 59) return null;
  return { h, mi, rest: src.slice(point[0].length) };
}

/**
 * 从群友原话里认出「每天/每周X + X点(半)/HH:MM + 发/推/出 + XX」。
 * 认不出、被否定（「别每天 8 点发了」）、没写主题或每周没写周几，一律 null——宁可 null 不猜。
 */
export function parseScheduleRequest(text: string): ParsedScheduleRequest | null {
  const raw = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return null;
  // 否定/取消：别每天…、不用每天…、取消每天…
  if (/(?:别|不要|不用|不必|甭|停止|取消|不需要|不想)\s*每/.test(raw)) return null;

  const weekly = /每(?:个|一)?(?:周|星期|礼拜)([一二三四五六日天])/.exec(raw);
  const daily = /每(?:天|日|早|晚)/.exec(raw);
  let cadence: "daily" | "weekly";
  let weekdays: number[] | undefined;
  let start: number;
  if (weekly) {
    cadence = "weekly";
    weekdays = [WEEKDAY_OF[weekly[1]]];
    start = weekly.index + weekly[0].length;
  } else if (/每(?:个|一)?(?:周|星期|礼拜)/.test(raw)) {
    return null; // 说了每周却没说是周几
  } else if (daily) {
    cadence = "daily";
    start = daily.index + daily[0].length;
  } else return null;

  const clock = clockAtStart(raw.slice(start), /晚/.test(daily?.[0] || ""));
  if (!clock) return null;
  const time = `${pad(clock.h)}:${pad(clock.mi)}`;
  if (!parseTime(time)) return null; // 用现有 parseTime 收口，25:00 之类直接否决

  let rest = clock.rest;
  const strip = (pattern: RegExp) => {
    for (;;) {
      rest = rest.replace(/^\s+/, "");
      if (!pattern.test(rest)) return;
      rest = rest.replace(pattern, "");
    }
  };
  strip(/^(?:（悉尼）|\(悉尼\)|悉尼时间|悉尼)/);
  strip(/^(?:的时候|时候|在群里|群里|给大家|给我|给|准时|自动)/);

  const verb = /^(?:发送|发出|发|推送|推|出)/.exec(rest);
  if (!verb) return null;
  rest = rest.slice(verb[0].length);
  rest = rest.replace(/^\s*(?:一下|一份|一个|一条|一篇|下|份|个|条|篇)/, "");

  let topic = rest
    .replace(/^\s+/, "")
    .split(/[，。！？；、,;!?]/)[0]
    .trim()
    .replace(/^[「『“‘"']+/, "")
    .replace(/[」』”’"']+$/, "")
    .replace(/[吧呀啊哈哦嘛呢啦~～…]+$/, "");
  if (!topic) return null;
  return {
    cadence,
    time,
    ...(weekdays ? { weekdays } : {}),
    topic: topic.slice(0, 40),
  };
}

/** FNV-1a（32 位）压成 6 位 base36：同一 id 稳定，不同 id 几乎不撞。 */
function idHash(id: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(6, "0").slice(-6);
}

/**
 * L2：按 topic 生成去重键。ASCII 主题转 kebab-case，已上线的规则保持不变；
 * 中文等转不出合法键时用完整消息 id 的短哈希（rpt-<6 位 base36>）。QQ 消息 id
 * 都以 ROBOT1.0_ 开头，不能取前缀，否则所有群共用 rpt-robot1。
 * 结果保证符合 createSchedule 的 3–31 位小写规则。
 */
export function slug(topic: string, id = "") {
  const ascii = String(topic ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 31);
  if (/^[a-z][a-z0-9-]{2,30}$/.test(ascii)) return ascii;
  const key = String(id ?? "");
  if (!key) return "rpt-000000";
  return `rpt-${idHash(key)}`;
}

/** 2026-11-14 08:00（悉尼） */
export function sydneyText(ts: number | null | undefined, tz = DEFAULT_TZ) {
  if (!ts) return "无";
  const p = partsAt(Number(ts), tz || DEFAULT_TZ);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}（悉尼）`;
}

/**
 * 旧行没有 cadence 字段，按 spec 形状推断；顺序有意为之：
 * month_days → monthly，every_minutes → every，只有 run_at → once，weekdays → weekly，其余 daily。
 */
export function cadenceOf(spec: ScheduleSpec): Cadence {
  const c = spec?.cadence;
  if (c === "daily" || c === "weekly" || c === "monthly" || c === "once" || c === "every") return c;
  if (Array.isArray(spec?.month_days) && spec.month_days.length) return "monthly";
  if (Number(spec?.every_minutes) > 0) return "every";
  if (spec?.run_at !== undefined && spec?.run_at !== null && !spec?.time) return "once";
  if (Array.isArray(spec?.weekdays) && spec.weekdays.length) return "weekly";
  return "daily";
}

/** 时区的中文短名；未知时区原样显示。 */
function tzLabel(tz: string) {
  if (tz === "Asia/Shanghai") return "北京";
  if (tz === "Australia/Sydney") return "悉尼";
  if (tz === "UTC") return "UTC";
  return tz;
}

/** 双时区文本：非悉尼时区同时给悉尼墙上时间（§4.1）。悉尼行沿用旧格式，避免回归。 */
export function dualText(ts: number | null | undefined, tz = DEFAULT_TZ) {
  if (!ts) return "无";
  const zone = tz || DEFAULT_TZ;
  if (zone === DEFAULT_TZ) return sydneyText(ts, zone);
  const p = partsAt(Number(ts), zone);
  const s = partsAt(Number(ts), DEFAULT_TZ);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}（${tzLabel(zone)}），悉尼 ${pad(s.h)}:${pad(s.mi)}`;
}

function nextMonthly(spec: ScheduleSpec, now: number, tz: string, time: [number, number]) {
  const p = partsAt(now, tz);
  const days = (Array.isArray(spec?.month_days) && spec.month_days.length ? spec.month_days : [1])
    .map(Number)
    .filter((d) => Number.isInteger(d) && (d === -1 || (d >= 1 && d <= 31)));
  if (!days.length) return null;
  // 最多往后找 13 个月；2 月 30 日这种不存在的日期当月跳过，不向 3 月顺延。
  for (let k = 0; k <= 12; k++) {
    const index = p.m - 1 + k;
    const y = p.y + Math.floor(index / 12);
    const m = (index % 12) + 1;
    const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const targets = [...new Set(days.map((d) => (d === -1 ? lastDay : d)))]
      .filter((d) => d <= lastDay)
      .sort((a, b) => a - b);
    for (const d of targets) {
      const ts = zonedToUtc(y, m, d, time[0], time[1], tz);
      if (ts > now) return ts;
    }
  }
  return null;
}

function nextEvery(spec: ScheduleSpec, now: number, tz: string) {
  const every = Math.min(1440, Math.max(5, Math.floor(Number(spec?.every_minutes) || 0) || 5));
  const until = Number(spec?.until) > 0 ? Number(spec.until) : null;
  const capped = (ts: number) => (until !== null && ts > until ? null : ts);
  const window = Array.isArray(spec?.window) && spec.window.length === 2 ? spec.window : null;
  const start = window ? parseTime(window[0]) : null;
  const end = window ? parseTime(window[1]) : null;
  if (!window || !start || !end) return capped(now + every * MINUTE);
  const p = partsAt(now, tz);
  for (let i = 0; i <= 8; i++) {
    const day = addDays(p.y, p.m, p.d, i);
    const from = zonedToUtc(day.y, day.m, day.d, start[0], start[1], tz);
    let to = zonedToUtc(day.y, day.m, day.d, end[0], end[1], tz);
    if (to <= from) {
      // 跨午夜的时段（22:00–02:00）
      const nextDay = addDays(day.y, day.m, day.d, 1);
      to = zonedToUtc(nextDay.y, nextDay.m, nextDay.d, end[0], end[1], tz);
    }
    for (let ts = from; ts < to; ts += every * MINUTE) {
      if (ts <= now) continue;
      return capped(ts);
    }
  }
  return null;
}

export function nextRun(spec: ScheduleSpec, now: number, tz = DEFAULT_TZ): number | null {
  const zone = tz || DEFAULT_TZ;
  const cadence = cadenceOf(spec);
  if (cadence === "once") {
    const runAt = parseRunAt(spec?.run_at, zone);
    return runAt > now ? runAt : null;
  }
  if (cadence === "every") return nextEvery(spec, now, zone);
  const time = parseTime(spec?.time) || [8, 0];
  if (cadence === "monthly") return nextMonthly(spec, now, zone, time);
  const p = partsAt(now, zone);
  const weekdays = cadence === "weekly" && Array.isArray(spec?.weekdays) && spec.weekdays.length
    ? new Set(spec.weekdays.map(Number))
    : null;
  for (let i = 0; i <= 8; i++) {
    const day = addDays(p.y, p.m, p.d, i);
    if (weekdays && !weekdays.has(new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay())) continue;
    const ts = zonedToUtc(day.y, day.m, day.d, time[0], time[1], zone);
    if (ts > now) return ts;
  }
  return null;
}

function specOf(schedule: any): ScheduleSpec {
  try {
    return JSON.parse(schedule?.spec || "{}") || {};
  } catch {
    return {};
  }
}

export function describeSchedule(schedule: any) {
  const spec = specOf(schedule);
  const topic = String(spec.topic || "").trim();
  const time = spec.time || "08:00";
  const zone = schedule?.tz || DEFAULT_TZ;
  const label = tzLabel(zone);
  if (schedule?.kind === "digest_daily")
    return topic ? `每天 ${time}（${label}）发${topic}` : `每天 ${time}（${label}）昨日总结`;
  if (schedule?.kind === "digest_weekly") {
    const days = (spec.weekdays || [0])
      .map((d: number) => String(WEEKDAY_NAMES[d] ?? d).replace(/^周/, ""))
      .join("、");
    return topic ? `每周${days} ${time}（${label}）发${topic}` : `每周${days} ${time}（${label}）周报`;
  }
  if (schedule?.kind === "reminder") return `提醒：${spec.text || "未写内容"}`;
  if (schedule?.kind === "mute") return `闭嘴到 ${dualText(Number(spec.run_at) || null, zone)}`;
  if (schedule?.kind === "agent_task") {
    const title = String(spec.title || spec.topic || "定时任务");
    const cadence = cadenceOf(spec);
    if (cadence === "every")
      return `每 ${Number(spec.every_minutes) || 5} 分钟${spec.window ? `（${spec.window[0]}–${spec.window[1]}）` : ""}（${label}）发${title}`;
    if (cadence === "once") return `一次：${dualText(Number(spec.run_at) || null, zone)} 发${title}`;
    if (cadence === "monthly") {
      const days = (spec.month_days || [1]).map((d: number) => (d === -1 ? "最后一天" : `${d}日`)).join("、");
      return `每月${days} ${time}（${label}）发${title}`;
    }
    if (cadence === "weekly") {
      const days = (spec.weekdays || [])
        .map((d: number) => String(WEEKDAY_NAMES[d] ?? d).replace(/^周/, ""))
        .join("、");
      return `每周${days} ${time}（${label}）发${title}`;
    }
    return `每天 ${time}（${label}）发${title}`;
  }
  return String(schedule?.kind || "日程");
}

/** schedule_runs.status → 对外三元组：sent / failed / none。 */
function listRunStatus(raw: unknown) {
  const s = String(raw || "");
  if (s === "ok" || s === "late") return "sent";
  if (s === "failed") return "failed";
  return "none";
}

export function publicSchedule(schedule: any) {
  const spec = specOf(schedule);
  const title = String(spec.title || spec.topic || "").trim();
  return {
    id: schedule.id,
    kind: schedule.kind,
    status: schedule.status,
    owner: schedule.owner,
    title: title || null,
    description: describeSchedule(schedule),
    time: spec.time || null,
    weekdays: spec.weekdays || null,
    run_at: spec.run_at || null,
    text: spec.text || null,
    next_run_at: schedule.next_run_at ?? null,
    next_run_text: schedule.next_run_at ? sydneyText(schedule.next_run_at, schedule.tz) : "无",
    last_run_at: schedule.last_run_at ?? null,
    last_run_text: schedule.last_run_at ? sydneyText(schedule.last_run_at, schedule.tz) : "从未",
    fail_count: Number(schedule.fail_count || 0),
    last_error: schedule.last_error || null,
    last_run_status: listRunStatus(schedule.last_run_status),
  };
}

export function scheduleFailure(detail: string) {
  return {
    ok: false,
    error_kind: "invalid_args",
    retryable: false,
    next_action: "把类型、悉尼时间 HH:MM、分钟数或提醒内容说清楚再试",
    detail: redact(String(detail || "参数不完整")).slice(0, 160),
  };
}

export type PlannedSchedule = {
  id: string;
  group_id: string;
  owner: string;
  kind: ScheduleKind;
  tz: string;
  spec: ScheduleSpec;
  next_run_at: number;
  created_at: number;
  source_msg_id: string | null;
};

/** agent_task 的时间字段：校验 + 归一（monthly/every/once 是 D 版新增）。 */
function normalizeTiming(spec: ScheduleSpec, tz: string, now: number) {
  const cadence = cadenceOf(spec);
  spec.cadence = cadence;
  if (cadence === "once") {
    const runAt = parseRunAt(spec.run_at, tz);
    if (!runAt || runAt <= now) throw Error("这个时间已经过去，请说下一次的时间");
    spec.run_at = runAt;
    return;
  }
  if (cadence === "every") {
    const every = Math.floor(Number(spec.every_minutes) || 0);
    if (!(every >= 5 && every <= 1440)) throw Error("间隔要 5–1440 分钟");
    spec.every_minutes = every;
    if (spec.window !== undefined) {
      const w = Array.isArray(spec.window) ? spec.window : null;
      if (!w || w.length !== 2 || !parseTime(w[0]) || !parseTime(w[1]))
        throw Error("时段要写成 HH:MM–HH:MM");
      spec.window = [String(w[0]), String(w[1])] as [string, string];
    }
    if (spec.until !== undefined && spec.until !== null) {
      const until = parseRunAt(spec.until, tz);
      if (!until) throw Error("截止时间认不出来");
      spec.until = until;
    }
    return;
  }
  const time = parseTime(spec.time);
  if (!time) {
    if (spec.time) throw Error("时间要写成 HH:MM，比如 09:00");
    spec.time = "08:00";
  } else spec.time = `${pad(time[0])}:${pad(time[1])}`;
  if (cadence === "weekly") {
    const days = [...new Set((spec.weekdays || []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw Error("每周要说是周几（0=周日，1=周一…）");
    spec.weekdays = days;
  }
  if (cadence === "monthly") {
    const days = [...new Set((spec.month_days || [1]).map(Number))].filter(
      (d) => Number.isInteger(d) && (d === -1 || (d >= 1 && d <= 31)),
    ).sort((a, b) => a - b);
    if (!days.length) throw Error("每月要说是几号（1–31，-1=月末）");
    spec.month_days = days;
  }
}

/** 校验并算出将要写入 schedules 的那一行；dry-run 和真实创建共用同一套规则。 */
export function planSchedule(input: NewSchedule, now = Date.now()): PlannedSchedule {
  const kind = input.kind;
  if (!["digest_daily", "digest_weekly", "reminder", "mute", "agent_task"].includes(kind))
    throw Error("不支持的日程类型");
  const tz = input.tz || DEFAULT_TZ;
  const spec: ScheduleSpec = { ...(input.spec || {}) };

  if (kind === "digest_daily" || kind === "digest_weekly") {
    const time = parseTime(spec.time);
    if (!time) throw Error("时间要写成悉尼时间 HH:MM，比如 08:00");
    spec.time = `${pad(time[0])}:${pad(time[1])}`;
  }
  if (kind === "digest_weekly") {
    const days = [...new Set((spec.weekdays || [0]).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
    if (!days.length) throw Error("周报要选星期（0=周日，1=周一…）");
    spec.weekdays = days;
  }
  if (kind === "agent_task") {
    const checked = validateSteps(spec.steps);
    if (!checked.ok) throw Error(checked.reason);
    spec.steps = checked.steps;
    normalizeTiming(spec, tz, now);
    const note = String(spec.note ?? "").trim();
    if (note.length > 600) throw Error("成文说明最多 600 字");
    if (note) spec.note = note;
    else delete spec.note;
    const title = String(spec.title ?? "").trim();
    if (title.length > 40) throw Error("标题最多 40 字");
    if (title) spec.title = title;
    else delete spec.title;
  }
  if (kind === "reminder" || kind === "mute") {
    const explicit = parseRunAt(spec.run_at, tz);
    const runAt = explicit > 0
      ? explicit
      : Number(spec.minutes) > 0
        ? now + Number(spec.minutes) * MINUTE
        : 0;
    if (!runAt || runAt <= now) throw Error("要一个未来的时间或分钟数");
    spec.run_at = runAt;
    delete spec.minutes;
    if (kind === "reminder") {
      const text = String(spec.text || "").trim();
      if (!text) throw Error("提醒内容不能为空");
      spec.text = text.slice(0, 500);
    }
  }

  // L1：主题、去重键、来源和成员原话。空值当作没写，不往 spec 里塞默认值。
  const topic = String(spec.topic ?? "").trim();
  if (topic) {
    if (topic.length > 40) throw Error("主题要 1–40 个字");
    spec.topic = topic;
  } else delete spec.topic;
  const dedup = String(spec.dedup ?? "").trim();
  if (dedup) {
    if (!/^[a-z][a-z0-9-]{2,30}$/.test(dedup))
      throw Error("去重键只能用 3–31 位小写字母、数字和连字符，且以字母开头");
    spec.dedup = dedup;
  } else delete spec.dedup;
  const origin = String(spec.origin ?? "").trim();
  if (origin) {
    if (!["chat", "review", "backfill"].includes(origin)) throw Error("origin 只能是 chat/review/backfill");
    spec.origin = origin as ScheduleSpec["origin"];
  } else delete spec.origin;
  const quote = String(spec.request_quote ?? "").trim();
  if (quote) spec.request_quote = quote.slice(0, 200);
  else delete spec.request_quote;

  const next = nextRun(spec, now, tz);
  if (next === null) throw Error("这个时间已经过去，请说下一次的时间");
  return {
    id: `sched-${kind}-${input.source_msg_id || crypto.randomUUID()}`,
    group_id: input.group_id,
    owner: input.owner,
    kind,
    tz,
    spec,
    next_run_at: next,
    created_at: now,
    source_msg_id: input.source_msg_id || null,
  };
}

export async function createSchedule(e: any, input: NewSchedule, now = Date.now()) {
  const plan = planSchedule(input, now);
  const existing = await e.DB.prepare("SELECT id,status FROM schedules WHERE id=?").bind(plan.id).first();
  // 同一条消息重放是幂等的：已经 active 的行不再占新名额，也不和自己抢去重键。
  if (!existing || existing.status !== "active") {
    const active = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedules WHERE group_id=? AND status='active' AND kind<>'mute'",
    )
      .bind(plan.group_id)
      .first();
    if (Number(active?.n || 0) >= MAX_ACTIVE_PER_GROUP)
      throw Error(`本群定时已满 ${MAX_ACTIVE_PER_GROUP} 个，先取消一个`);
  }
  if (plan.spec.dedup) {
    const dup = await e.DB.prepare(
      "SELECT id FROM schedules WHERE status='active' AND id<>? AND json_extract(spec,'$.dedup')=? LIMIT 1",
    )
      .bind(plan.id, plan.spec.dedup)
      .first();
    if (dup) throw Error(`去重键 ${plan.spec.dedup} 已被 ${dup.id} 占用`);
  }
  await e.DB.prepare(
    "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'active',?,0,?,?)",
  )
    .bind(plan.id, plan.group_id, plan.owner, plan.kind, plan.tz, JSON.stringify(plan.spec), plan.next_run_at, plan.created_at, plan.source_msg_id)
    .run();
  const row = await e.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(plan.id).first();
  if (row?.status === "cancelled")
    await e.DB.prepare(
      "UPDATE schedules SET status='active',spec=?,tz=?,next_run_at=?,fail_count=0,last_error=NULL WHERE id=?",
    )
      .bind(JSON.stringify(plan.spec), plan.tz, plan.next_run_at, plan.id)
      .run();
  return (await e.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(plan.id).first()) || row;
}

export type BackfillScheduleOptions = {
  dry_run?: boolean;
  /** 非空时同批入队 `sched-ack:<schedule id>`，并写 learning_acks，供「不对」撤销。 */
  ack?: string;
  now?: number;
};

/**
 * L8：回填一条日程。与 createSchedule 同一套校验和幂等键；额外支持 dedup/request_quote（在
 * planSchedule 里已透传）与可选回执。回执和 learning_acks 与日程写入在同一个 db.batch，
 * 不会出现「日程建了但回执没发」的中间态。
 */
export async function backfillSchedule(
  e: any,
  input: NewSchedule,
  opts: BackfillScheduleOptions = {},
) {
  const now = opts.now ?? Date.now();
  const plan = planSchedule(input, now);
  const ack = String(opts.ack ?? "").trim();
  if (ack && Array.from(ack).length > 500) throw Error("回执最多 500 字");
  const ackId = ack ? `sched-ack:${plan.id}` : null;
  if (opts.dry_run) return { plan, row: null, ack_outbox_id: ackId };

  const existing = await e.DB.prepare("SELECT id,status FROM schedules WHERE id=?").bind(plan.id).first();
  // 与 createSchedule 相同：同一条消息重放不占新名额，也不和自己抢去重键。
  if (!existing || existing.status !== "active") {
    const active = await e.DB.prepare(
      "SELECT COUNT(*) AS n FROM schedules WHERE group_id=? AND status='active' AND kind<>'mute'",
    )
      .bind(plan.group_id)
      .first();
    if (Number(active?.n || 0) >= MAX_ACTIVE_PER_GROUP)
      throw Error(`本群定时已满 ${MAX_ACTIVE_PER_GROUP} 个，先取消一个`);
  }
  if (plan.spec.dedup) {
    const dup = await e.DB.prepare(
      "SELECT id FROM schedules WHERE status='active' AND id<>? AND json_extract(spec,'$.dedup')=? LIMIT 1",
    )
      .bind(plan.id, plan.spec.dedup)
      .first();
    if (dup) throw Error(`去重键 ${plan.spec.dedup} 已被 ${dup.id} 占用`);
  }

  const statements = [
    e.DB.prepare(
      "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'active',?,0,?,?)",
    ).bind(plan.id, plan.group_id, plan.owner, plan.kind, plan.tz, JSON.stringify(plan.spec), plan.next_run_at, plan.created_at, plan.source_msg_id),
    e.DB.prepare(
      "UPDATE schedules SET status='active',spec=?,tz=?,next_run_at=?,fail_count=0,last_error=NULL WHERE id=? AND status='cancelled'",
    ).bind(JSON.stringify(plan.spec), plan.tz, plan.next_run_at, plan.id),
  ];
  if (ack && ackId) {
    statements.push(
      e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,'pending',?)")
        .bind(ackId, plan.group_id, plan.source_msg_id, ack, now),
      e.DB.prepare(
        "INSERT OR IGNORE INTO learning_acks(outbox_id,group_id,answer_msg_id,refs,created_at) VALUES(?,?,?,?,?)",
      ).bind(ackId, plan.group_id, null, JSON.stringify([{ type: "schedule", id: plan.id }]), now),
    );
  }
  await e.DB.batch(statements);
  const row = await e.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(plan.id).first();
  return { plan, row: row || null, ack_outbox_id: ackId };
}

export async function listSchedules(e: any, groupId: string, opts: { includeDone?: boolean } = {}) {
  const where = opts.includeDone ? "" : "AND s.status='active'";
  const rows = (
    await e.DB.prepare(
      `SELECT s.*, (SELECT r.status FROM schedule_runs r WHERE r.schedule_id=s.id ORDER BY r.due_at DESC LIMIT 1) AS last_run_status FROM schedules s WHERE s.group_id=? ${where} ORDER BY CASE WHEN s.status='active' THEN 0 ELSE 1 END,s.next_run_at`,
    )
      .bind(groupId)
      .all()
  ).results;
  return rows.map(publicSchedule);
}

export async function cancelSchedule(e: any, groupId: string, id: string) {
  const row = await e.DB.prepare(
    "UPDATE schedules SET status='cancelled',next_run_at=NULL WHERE id=? AND group_id=? AND status='active' RETURNING *",
  )
    .bind(id, groupId)
    .first();
  return row || null;
}

/** 群现在是否处于定时闭嘴；创建闭嘴的那条消息仍可收到确认。 */
export async function muted(
  e: any,
  groupId: string | null | undefined,
  latestId: string | null | undefined,
  now = Date.now(),
) {
  if (!groupId) return false;
  const row = await e.DB.prepare(
    "SELECT source_msg_id FROM schedules WHERE group_id=? AND kind='mute' AND status='active' AND COALESCE(json_extract(spec,'$.run_at'),0)>? ORDER BY created_at DESC LIMIT 1",
  )
    .bind(groupId, now)
    .first();
  return !!row && (!latestId || row.source_msg_id !== latestId);
}

export async function digestText(e: any, schedule: any, spec: ScheduleSpec, now: number) {
  const tz = schedule.tz || DEFAULT_TZ;
  const days = schedule.kind === "digest_weekly" ? 7 : 1;
  // L1：有 topic 就是自定义主题推送；成员原话含「精简/简短/简单」时把行数上限降到 5。
  const topic = String(spec.topic || "").trim();
  const quote = String(spec.request_quote || "").trim().slice(0, 200);
  const maxLines = quote && /精简|简短|简单/.test(quote) ? 5 : 8;
  const basePrompt = topic
    ? topicPrompt(topic, maxLines)
    : maxLines === 8
      ? DIGEST_PROMPT
      : DIGEST_PROMPT.replace("最多8行", `最多${maxLines}行`);
  const prompt = quote ? basePrompt + quoteLine(quote) : basePrompt;
  const p = partsAt(now, tz);
  const startDay = addDays(p.y, p.m, p.d, -days);
  const start = zonedToUtc(startDay.y, startDay.m, startDay.d, 0, 0, tz);
  const end = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  const messages = (
    await e.DB.prepare(
      "SELECT id,sender,body,ts FROM messages WHERE group_id=? AND julianday(ts)>=julianday(?) AND julianday(ts)<julianday(?) ORDER BY ts LIMIT 200",
    )
      .bind(schedule.group_id, new Date(start).toISOString(), new Date(end).toISOString())
      .all()
  ).results;
  const label = days === 7 ? "上周" : "昨天";
  if (!messages.length) return `${label}群里没有新消息。`;
  const names = await namesFor(
    e,
    [...new Set(messages.map((m: any) => m.sender))] as string[],
  );
  const data = messages
    .map((m: any) => ({ who: names.get(m.sender) || "群友", text: String(m.body || "").slice(0, 400) }))
    .filter((m: any) => m.text.trim());
  if (!data.length) return `${label}群里没有新消息。`;
  const result: any = await model(
    e,
    "chat",
    "high",
    {
      model: e.MODEL || "deepseek-flash",
      reasoning_effort: "high",
      max_tokens: 1200,
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: JSON.stringify({
            date: `${p.y}-${pad(p.m)}-${pad(p.d)}`,
            period: label,
            messages: data.slice(-120),
          }),
        },
      ],
    },
    60000,
  );
  const text = String(result.choices?.[0]?.message?.content || "").trim();
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, maxLines);
  if (!lines.length) throw Error("日报模型没有返回内容");
  return lines.join("\n");
}

async function failSchedule(e: any, schedule: any, runId: string, now: number, error: any) {
  const fails = Number(schedule.fail_count || 0) + 1;
  const detail = redact(String(error?.message || error || "未知错误")).slice(0, 300);
  await e.DB.prepare("UPDATE schedule_runs SET finished_at=?,status='failed',error=? WHERE id=?")
    .bind(now, detail, runId)
    .run();
  // §4.6：连续失败到上限就暂停，不再每天刷屏；只发一条暂停通知，id 固定所以重试不会重复发。
  if (fails >= FAIL_PAUSE_AFTER) {
    const body = `⏰ 定时任务「${describeSchedule(schedule)}」已经连续失败 ${fails} 次，我先把它暂停了，不再继续重试。修好后让我恢复就行。最后一次错误：${detail}`;
    await e.DB.batch([
      e.DB.prepare("UPDATE schedules SET fail_count=?,last_error=?,next_run_at=NULL,status='paused' WHERE id=?")
        .bind(fails, detail, schedule.id),
      e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)")
        .bind(`sched-paused:${schedule.id}`, schedule.group_id, schedule.source_msg_id || null, body, "pending", now),
    ]);
    return;
  }
  const retryAt = fails >= 3 ? nextRun(specOf(schedule), now, schedule.tz || DEFAULT_TZ) : now + RETRY_AFTER;
  await e.DB.prepare("UPDATE schedules SET fail_count=?,last_error=?,next_run_at=?,status='active' WHERE id=?")
    .bind(fails, detail, retryAt, schedule.id)
    .run();
  if (fails >= 3 && fails % 3 === 0) {
    const body = `⏰ 定时任务「${describeSchedule(schedule)}」已经连续失败 ${fails} 次：${detail}。任务保留着，下次到点再试。`;
    await e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)")
      .bind(`sched-fail-${schedule.id}-${fails}`, schedule.group_id, schedule.source_msg_id || null, body, "pending", now)
      .run();
  }
}

/** settings 的 `off:<name>`：非空、非 0/false 即关。 */
async function switchedOff(e: any, name: string) {
  const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(`off:${name}`).first();
  const value = String(row?.value ?? "").trim();
  return value !== "" && value !== "0" && value !== "false";
}

/** D 版：agent_task（或带 steps 的旧 kind 行，对应 §10 备选 A）。 */
function isAgentTask(schedule: any, spec: ScheduleSpec) {
  return schedule?.kind === "agent_task" || (Array.isArray(spec?.steps) && spec.steps.length > 0);
}

/** 真正要调模型的任务：有 note（成文）或 chat_digest（内部用模型）。确定性动作不算。 */
function needsModel(spec: ScheduleSpec) {
  if (String(spec?.note || "").trim()) return true;
  return (Array.isArray(spec?.steps) ? spec.steps : []).some((s: any) => s?.action === "chat_digest");
}

/** 本群今天（日程 tz 的自然日）已经跑过多少次 agent_task。 */
async function agentRunsToday(e: any, schedule: any, now: number) {
  const tz = schedule.tz || DEFAULT_TZ;
  const p = partsAt(now, tz);
  const start = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  const tomorrow = addDays(p.y, p.m, p.d, 1);
  const end = zonedToUtc(tomorrow.y, tomorrow.m, tomorrow.d, 0, 0, tz);
  const row = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE s.group_id=? AND s.kind='agent_task' AND r.started_at>=? AND r.started_at<? AND r.status IN ('ok','late','failed','running')",
  )
    .bind(schedule.group_id, start, end)
    .first();
  return Number(row?.n || 0);
}

/** L1：有 dedup 时出站 id 是 `<dedup>:<悉尼日期>`，没有就沿用 sched-<id>-<due>。 */
function outboxIdFor(schedule: any, spec: ScheduleSpec, dueAt: number) {
  const dedup = String(spec.dedup || "").trim();
  if (!dedup) return `sched-${schedule.id}-${dueAt}`;
  const p = partsAt(dueAt, schedule.tz || DEFAULT_TZ);
  return `${dedup}:${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 今天（悉尼日）本群和全局已经发出的条数到顶没有。mute 没有出站，自然不计。 */
async function overSendCap(e: any, schedule: any, now: number) {
  const tz = schedule.tz || DEFAULT_TZ;
  const p = partsAt(now, tz);
  const start = zonedToUtc(p.y, p.m, p.d, 0, 0, tz);
  const tomorrow = addDays(p.y, p.m, p.d, 1);
  const end = zonedToUtc(tomorrow.y, tomorrow.m, tomorrow.d, 0, 0, tz);
  const group = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM schedule_runs r JOIN schedules s ON s.id=r.schedule_id WHERE s.group_id=? AND r.status IN ('ok','late') AND r.outbox_id IS NOT NULL AND r.due_at>=? AND r.due_at<?",
  )
    .bind(schedule.group_id, start, end)
    .first();
  if (Number(group?.n || 0) >= MAX_SENDS_PER_GROUP_DAY) return true;
  const all = await e.DB.prepare(
    "SELECT COUNT(*) AS n FROM schedule_runs WHERE status IN ('ok','late') AND outbox_id IS NOT NULL AND due_at>=? AND due_at<?",
  )
    .bind(start, end)
    .first();
  return Number(all?.n || 0) >= MAX_SENDS_DAY;
}

/** 每分钟由 cron 调用；抢占式写 schedule_runs，同一到期时间只执行一次。 */
export async function runSchedules(e: any, now = Date.now()) {
  // 一次摘要要查到期、抢占、读消息、写出站和回写；预算不够就留到下一分钟。
  if (left(e) < 24) return;
  // 上次执行到一半进程被杀会留下 started_at 的 running 行；十分钟后由同一 due 重跑，
  // 出站 id 固定为 sched-<id>-<due>，重跑不会多出一条消息。
  await e.DB.prepare(
    "UPDATE schedule_runs SET started_at=NULL,status='pending' WHERE status='running' AND started_at<?",
  )
    .bind(now - 10 * MINUTE)
    .run();
  const due = (
    await e.DB.prepare(
      "SELECT * FROM schedules WHERE status='active' AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at LIMIT 4",
    )
      .bind(now)
      .all()
  ).results;
  // 没有到期的就到此为止：cron 的 D1 预算是给维护工作留的，别为一个开关多花一次查询。
  if (!due.length) return;
  // §10：迁移 schedules 表期间的保险丝，交付前置 1、迁移后置 0。
  if (await switchedOff(e, "schedules_cron")) return;
  // 每 tick 最多 MAX_AGENT_MODEL_PER_TICK 个要调模型的任务，其余顺延到下一分钟。
  let modelTasks = 0;
  for (const schedule of due) {
    if (left(e) < 24) break;
    const dueAt = Number(schedule.next_run_at);
    const runId = `run-${schedule.id}-${dueAt}`;
    await e.DB.prepare(
      "INSERT OR IGNORE INTO schedule_runs(id,schedule_id,due_at,started_at,status) VALUES(?,?,?,NULL,'pending')",
    )
      .bind(runId, schedule.id, dueAt)
      .run();
    const claim = await e.DB.prepare(
      "UPDATE schedule_runs SET started_at=?,status='running' WHERE id=? AND started_at IS NULL RETURNING id",
    )
      .bind(now, runId)
      .first();
    if (!claim) continue;
    const spec = specOf(schedule);
    let outboxId: string | null = null;
    if (schedule.kind !== "mute" && now - dueAt > MAX_MISSED_AGE_MS) {
      // 错过窗口：不调用模型、不入 outbox；周期任务推进到下一次，一次提醒直接结束。
      const next = nextRun(spec, now, schedule.tz || DEFAULT_TZ);
      await e.DB.batch([
        e.DB.prepare(
          "UPDATE schedule_runs SET finished_at=?,status='skipped',error='expired' WHERE id=?",
        ).bind(now, runId),
        e.DB.prepare(
          "UPDATE schedules SET next_run_at=?,status=?,fail_count=0,last_error='expired' WHERE id=?",
        ).bind(next, next === null ? "done" : "active", schedule.id),
      ]);
      continue;
    }
    const agent = isAgentTask(schedule, spec);
    if (agent && needsModel(spec) && modelTasks >= MAX_AGENT_MODEL_PER_TICK) {
      // 把抢占还回去：下一分钟同一 due 还能再抢，出站 id 不变，不会重复发。
      await e.DB.prepare("UPDATE schedule_runs SET started_at=NULL,status='pending' WHERE id=?").bind(runId).run();
      continue;
    }
    if (agent && (await agentRunsToday(e, schedule, now)) >= MAX_AGENT_RUNS_PER_GROUP_DAY) {
      const next = nextRun(spec, Math.max(now, dueAt), schedule.tz || DEFAULT_TZ);
      await e.DB.batch([
        e.DB.prepare("UPDATE schedule_runs SET finished_at=?,status='skipped',error='agent_daily_cap' WHERE id=?").bind(now, runId),
        e.DB.prepare("UPDATE schedules SET next_run_at=?,status=?,last_error='agent_daily_cap' WHERE id=?").bind(
          next,
          next === null ? "done" : "active",
          schedule.id,
        ),
      ]);
      continue;
    }
    if (schedule.kind !== "mute" && (await overSendCap(e, schedule, now))) {
      // 当天发送量到顶：这次不写 outbox，进度照常推进，明天配额重新算。
      const next = nextRun(spec, now, schedule.tz || DEFAULT_TZ);
      await e.DB.batch([
        e.DB.prepare(
          "UPDATE schedule_runs SET finished_at=?,status='skipped',error='cap' WHERE id=?",
        ).bind(now, runId),
        e.DB.prepare(
          "UPDATE schedules SET next_run_at=?,status=?,fail_count=0,last_error='cap' WHERE id=?",
        ).bind(next, next === null ? "done" : "active", schedule.id),
      ]);
      continue;
    }
    try {
      let body: string | null;
      if (schedule.kind === "mute") body = null;
      else if (agent) {
        // S-15：被注入的非只读动作在这里被拒，run 记 denied，绝不执行。
        const checked = validateSteps(spec.steps);
        if (!checked.ok) throw Error(`denied：${checked.reason}`);
        if (needsModel(spec)) modelTasks++;
        const ctx = {
          e,
          groupId: schedule.group_id,
          viewer: { sender: schedule.owner },
          tz: schedule.tz || DEFAULT_TZ,
          now,
          purpose: "schedule" as const,
        };
        const results = await runSteps(ctx, checked.steps);
        if (!results.length) throw Error("动作层没有返回结果");
        if (results.every((r: any) => !r.ok)) throw Error(`全部步骤失败（${results[0]?.error_kind || "unknown"}）`);
        const note = String(spec.note || "").trim();
        body = note
          ? await composeWithNote(ctx, results, note)
          : joinResults(results, String(spec.title || "").trim() || undefined);
      } else if (schedule.kind === "reminder") body = String(spec.text || "").trim();
      else body = await digestText(e, schedule, spec, now);
      if (body === "") throw Error("日程内容为空");
      const late = body === null ? false : now - dueAt > LATE_AFTER;
      if (body !== null) {
        const minutes = Math.max(0, Math.floor((now - dueAt) / MINUTE));
        outboxId = outboxIdFor(schedule, spec, dueAt);
        await e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)")
          .bind(
            outboxId,
            schedule.group_id,
            schedule.source_msg_id || null,
            (late ? `（晚了 ${minutes} 分钟）` : "") + body,
            "pending",
            now,
          )
          .run();
      }
      await e.DB.prepare("UPDATE schedule_runs SET finished_at=?,status=?,outbox_id=? WHERE id=?")
        .bind(now, late ? "late" : "ok", outboxId, runId)
        .run();
      const next = nextRun(spec, Math.max(now, dueAt), schedule.tz || DEFAULT_TZ);
      await e.DB.prepare(
        "UPDATE schedules SET last_run_at=?,fail_count=0,last_error=NULL,next_run_at=?,status=? WHERE id=?",
      )
        .bind(now, next, next === null ? "done" : "active", schedule.id)
        .run();
    } catch (error) {
      await failSchedule(e, schedule, runId, now, error);
    }
  }
}
