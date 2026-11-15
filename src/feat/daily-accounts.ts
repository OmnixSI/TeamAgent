import type { Hub } from "../hub.ts";
import { reportHeading } from "../accounts.ts";
import { BJ, SYD, fmtDate, fmtTime, nextDaily, zonedToUtc } from "../util.ts";
import type { Feature } from "./types.ts";

const DAY = 86400000;
const TITLE = "群账本、DeepSeek 余额和 token 日报";
const KIND = "daily-accounts";
const SPEC = { type: "daily", time: "00:00", tz: BJ, report: KIND };
type ScheduleRow = { id: number; spec: string; task: string; next: number; active: number; last?: number | null };
type ScheduleSpec = { type?: string; time?: string; tz?: string; days?: number[]; dom?: number[]; report?: string; adopted?: boolean };

function specOf(row: ScheduleRow): ScheduleSpec {
  try { return JSON.parse(row.spec) || {}; } catch { return {}; }
}

function rowsOf(hub: Hub, conv: string): ScheduleRow[] {
  return hub.sql.exec("SELECT id,spec,task,next,active,last FROM sched WHERE conv=? AND (active=1 OR task=?) ORDER BY id", conv, TITLE).toArray();
}

function legacyReport(row: ScheduleRow) {
  const spec = specOf(row);
  if (!row.active || spec.report || spec.type !== "daily" || spec.days?.length || spec.dom?.length) return false;
  const time = String(spec.time).padStart(5, "0");
  const midnight = (spec.tz === BJ && time === "00:00") || (spec.tz === SYD && ["02:00", "03:00"].includes(time));
  return midnight && /账本|群内账|\bledger\b/i.test(row.task) && /deepseek|API\s*余额|token/i.test(row.task);
}

/** Keep the old report's row and run history when upgrading from a prose schedule. */
export function ensureDailyAccountsSchedule(hub: Hub, conv: string, now: number) {
  if (!conv.startsWith("g:")) return;
  const rows = rowsOf(hub, conv);
  // A cancelled managed schedule is deliberate and persists across restarts.
  if (rows.some(row => specOf(row).report === KIND)) return;
  const matching = rows.filter(legacyReport);
  const prior = matching.shift();
  if (!prior) {
    hub.addSchedule(conv, SPEC, TITLE);
    return;
  }
  const midnight = zonedToUtc(fmtDate(now, BJ), SPEC.time, BJ);
  const next = prior.next === midnight ? midnight : nextDaily(SPEC.time, BJ, now);
  hub.ctx.storage.transactionSync(() => {
    hub.sql.exec("UPDATE sched SET spec=?,task=?,next=? WHERE id=?", JSON.stringify({ ...SPEC, adopted: true }), TITLE, next, prior.id);
    for (const duplicate of matching) hub.sql.exec("UPDATE sched SET active=0 WHERE id=?", duplicate.id);
  });
}

export function dailyAccountsStatus(hub: Hub, conv: string) {
  const row = rowsOf(hub, conv).find(r => specOf(r).report === KIND);
  if (!row) return null;
  const when = (ts: number) => `${fmtDate(ts, BJ)} ${fmtTime(ts, BJ)}`;
  return { id: row.id, active: !!row.active, timezone: BJ, time: SPEC.time,
    source: specOf(row).adopted ? "upgraded" : "created", next_beijing: row.active ? when(row.next) : null,
    last_started_beijing: row.last ? when(row.last) : null };
}

export function dailyAccountsTask(spec: ScheduleSpec, due: number, task: string) {
  return spec.report === KIND ? `${KIND}/${fmtDate(due - DAY, BJ)}` : task;
}

export const dailyAccountsDay = (task: string) => /^daily-accounts\/(\d{4}-\d{2}-\d{2})$/.exec(task)?.[1];

/** Retrying a background job after restart can reuse a delivered or queued report. */
export async function publishDailyAccounts(hub: Hub, conv: string, day: string, cancelled: () => boolean) {
  const prefix = reportHeading(day) + "\n%";
  if (hub.sql.exec("SELECT 1 FROM msg WHERE conv=? AND role='bot' AND text LIKE ? LIMIT 1", conv, prefix).toArray().length ||
      hub.sql.exec("SELECT 1 FROM pending WHERE conv=? AND kind='text' AND body LIKE ? LIMIT 1", conv, prefix).toArray().length) return true;
  const report = await hub.accounts.dailyReport(conv, day);
  if (cancelled()) return false;
  await hub.say(conv, report.text);
  return true;
}

const feature: Feature = {
  name: KIND,
  tools: ({ hub, conv }) => [{
    name: "daily_accounts",
    description: "查询一份账目日报，包含本群账本、DeepSeek 余额、指定北京日期已记录的 token 总数与费用估算。默认昨天。只查询。",
    parameters: { type: "object", properties: { date: { type: "string", description: "北京时间日期，YYYY-MM-DD，必须是已结束的一天" } } },
    async run({ date }) {
      const yesterday = fmtDate(Date.now() - DAY, BJ);
      const day = date === undefined ? yesterday : String(date);
      const midnight = Date.parse(day + "T00:00:00+08:00");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > yesterday || !Number.isFinite(midnight) || fmtDate(midnight, BJ) !== day) {
        throw new Error("请给出已结束的北京时间日期，格式 YYYY-MM-DD");
      }
      return hub.accounts.dailyReport(conv, day);
    },
  }],
  about: ["每晚北京时间 00:00 发前一日的账目日报。群账本和余额在发报时读取，token 总数按当日 SQLite 中的输入加输出统计。也可以用 daily_accounts 查已经结束的日期。"],
};
export default feature;
