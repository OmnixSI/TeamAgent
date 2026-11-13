// F6-6 用户日程：每日/每周摘要、一次性提醒、定时闭嘴。
// 纯时间计算放在文件顶部，便于按悉尼夏令时做红绿测试；所有出站都走现有 outbox。
import { left } from "./d1";
import { model, redact } from "./runtime";
import { namesFor } from "./context";

export type ScheduleKind = "digest_daily" | "digest_weekly" | "reminder" | "mute";
export type ScheduleSpec = {
  time?: string;
  weekdays?: number[];
  run_at?: number | string;
  text?: string;
  minutes?: number;
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
const MAX_MISSED_AGE_MS = 2 * 60 * MINUTE;
const RETRY_AFTER = 5 * MINUTE;
const DEFAULT_TZ = "Australia/Sydney";
const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DIGEST_PROMPT =
  "你在为群聊写日报。只写群里发布的日报正文：最多8行，先一句总览，再列3–6条真正有信息量的进展、决定或待办（点到相关的人或项目），最后一行只写一条最该推进的事。" +
  "只用消息里出现的事实，不编造，不猜没提到的计划；没有内容就直说没有新消息。不要客套、标题、表格或链接。";

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
function parseRunAt(value: unknown, tz: string) {
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

/** 2026-11-14 08:00（悉尼） */
export function sydneyText(ts: number | null | undefined, tz = DEFAULT_TZ) {
  if (!ts) return "无";
  const p = partsAt(Number(ts), tz || DEFAULT_TZ);
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}（悉尼）`;
}

export function nextRun(spec: ScheduleSpec, now: number, tz = DEFAULT_TZ): number | null {
  const runAt = Number(spec?.run_at);
  if (Number.isFinite(runAt) && runAt > 0) return runAt > now ? runAt : null;
  const time = parseTime(spec?.time) || [8, 0];
  const p = partsAt(now, tz || DEFAULT_TZ);
  const weekdays = Array.isArray(spec?.weekdays) && spec.weekdays.length
    ? new Set(spec.weekdays.map(Number))
    : null;
  for (let i = 0; i <= 8; i++) {
    const day = addDays(p.y, p.m, p.d, i);
    if (weekdays && !weekdays.has(new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay())) continue;
    const ts = zonedToUtc(day.y, day.m, day.d, time[0], time[1], tz || DEFAULT_TZ);
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
  if (schedule?.kind === "digest_daily") return `每天 ${spec.time || "08:00"}（悉尼）昨日总结`;
  if (schedule?.kind === "digest_weekly")
    return `每周${(spec.weekdays || [0]).map((d: number) => WEEKDAY_NAMES[d] || d).join("、")} ${spec.time || "08:00"}（悉尼）周报`;
  if (schedule?.kind === "reminder") return `提醒：${spec.text || "未写内容"}`;
  if (schedule?.kind === "mute") return `闭嘴到 ${sydneyText(Number(spec.run_at) || null)}`;
  return String(schedule?.kind || "日程");
}

export function publicSchedule(schedule: any) {
  const spec = specOf(schedule);
  return {
    id: schedule.id,
    kind: schedule.kind,
    status: schedule.status,
    owner: schedule.owner,
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

export async function createSchedule(e: any, input: NewSchedule, now = Date.now()) {
  const kind = input.kind;
  if (!["digest_daily", "digest_weekly", "reminder", "mute"].includes(kind))
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

  const next = nextRun(spec, now, tz);
  if (next === null) throw Error("这个时间已经过去，请说下一次的时间");
  const id = `sched-${kind}-${input.source_msg_id || crypto.randomUUID()}`;
  await e.DB.prepare(
    "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'active',?,0,?,?)",
  )
    .bind(id, input.group_id, input.owner, kind, tz, JSON.stringify(spec), next, now, input.source_msg_id || null)
    .run();
  const row = await e.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(id).first();
  if (row?.status === "cancelled")
    await e.DB.prepare(
      "UPDATE schedules SET status='active',spec=?,tz=?,next_run_at=?,fail_count=0,last_error=NULL WHERE id=?",
    )
      .bind(JSON.stringify(spec), tz, next, id)
      .run();
  return (await e.DB.prepare("SELECT * FROM schedules WHERE id=?").bind(id).first()) || row;
}

export async function listSchedules(e: any, groupId: string, opts: { includeDone?: boolean } = {}) {
  const where = opts.includeDone ? "" : "AND status='active'";
  const rows = (
    await e.DB.prepare(
      `SELECT * FROM schedules WHERE group_id=? ${where} ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,next_run_at`,
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

async function digestText(e: any, schedule: any, spec: ScheduleSpec, now: number) {
  const tz = schedule.tz || DEFAULT_TZ;
  const days = schedule.kind === "digest_weekly" ? 7 : 1;
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
        { role: "system", content: DIGEST_PROMPT },
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
  const lines = text.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 8);
  if (!lines.length) throw Error("日报模型没有返回内容");
  return lines.join("\n");
}

async function failSchedule(e: any, schedule: any, runId: string, now: number, error: any) {
  const fails = Number(schedule.fail_count || 0) + 1;
  const detail = redact(String(error?.message || error || "未知错误")).slice(0, 300);
  await e.DB.prepare("UPDATE schedule_runs SET finished_at=?,status='failed',error=? WHERE id=?")
    .bind(now, detail, runId)
    .run();
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
    if (schedule.kind !== 'mute' && now - dueAt > MAX_MISSED_AGE_MS) {
      const next = nextRun(spec, now, schedule.tz || DEFAULT_TZ);
      await e.DB.batch([
        e.DB.prepare("UPDATE schedule_runs SET finished_at=?,status='skipped',error='expired' WHERE id=?").bind(now, runId),
        e.DB.prepare("UPDATE schedules SET next_run_at=?,status=?,fail_count=0,last_error='expired' WHERE id=?")
          .bind(next, next === null ? 'done' : 'active', schedule.id),
      ]);
      continue;
    }
    try {
      const body = schedule.kind === "mute"
        ? null
        : schedule.kind === "reminder"
          ? String(spec.text || "").trim()
          : await digestText(e, schedule, spec, now);
      if (body === "") throw Error("日程内容为空");
      const late = body === null ? false : now - dueAt > LATE_AFTER;
      if (body !== null) {
        const minutes = Math.max(0, Math.floor((now - dueAt) / MINUTE));
        outboxId = `sched-${schedule.id}-${dueAt}`;
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
