// V-D-learning · L5：把 L4 写好的复盘晨报在 08:40–10:00（悉尼）原样放进 outbox。
// 规格：design.md §投递；v2 修订第 1、5 条（不调 applyConfirmed，影子期措辞由 L4 负责）。
// 窗口外不碰 D1；入队与置 queued 放在同一个 batch，重复 tick 只出一条。
import type { CronJob } from "./cron-extra";
import { TEAM } from "./config";
import { REPORT_DENY, reportOutboxId } from "./learning-types";

const TZ = "Australia/Sydney";
const MINUTE = 60000;
const DEFAULT_WINDOW = ["08:40", "10:00"];
const LIMITS = ((TEAM as any)?.schedules || {}) as Record<string, unknown>;
const MAX_SENDS_DAY = Number(LIMITS.max_sends_day) || 20;

type Parts = { y: number; m: number; d: number; h: number; min: number };

function partsAt(at: number): Parts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(at));
  const get = (kind: string) => Number(parts.find((p) => p.type === kind)?.value || 0);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute") };
}

const pad = (n: number) => String(n).padStart(2, "0");

function windowOf(raw: unknown): [number, number] {
  const text = Array.isArray(raw) && raw.length === 2 ? raw.map(String) : DEFAULT_WINDOW;
  const parse = (value: string) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(value);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  const start = parse(text[0]);
  const end = parse(text[1]);
  // 配置在 config/validate.mjs 已校验；这里再容错一次，坏值回落到设计默认。
  return Number.isFinite(start) && Number.isFinite(end) && start < end ? [start, end] : [520, 600];
}

const REPORT_WINDOW = windowOf(LIMITS.report_window);

function inWindow(at: number): boolean {
  const p = partsAt(at);
  const clock = p.h * 60 + p.min;
  return clock >= REPORT_WINDOW[0] && clock <= REPORT_WINDOW[1];
}

/** 某时刻悉尼相对 UTC 的偏移（分钟，东为正）。 */
function offsetMinutes(at: number): number {
  const p = partsAt(at);
  const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return Math.round((local - (at - (at % MINUTE))) / MINUTE);
}

/** 悉尼墙上时间 → UTC 毫秒；跨夏令时用第二次迭代校正。 */
function localToUtc(y: number, m: number, d: number, h: number, min: number): number {
  const wall = Date.UTC(y, m - 1, d, h, min);
  let at = wall - offsetMinutes(wall) * MINUTE;
  at = wall - offsetMinutes(at) * MINUTE;
  return at;
}

/** 悉尼当天 00:00 到次日 00:00 的 UTC 边界。 */
function dayBounds(at: number): { start: number; end: number } {
  const p = partsAt(at);
  const start = localToUtc(p.y, p.m, p.d, 0, 0);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  const end = localToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0);
  return { start, end };
}

export const reviewReportJob: CronJob = {
  name: "review-report",
  async run(e: any, now: Date = new Date()) {
    const at = now.getTime();
    if (!inWindow(at)) return;

    const p = partsAt(at);
    const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    // 一次查询拿到当天 ready 的报告和「当天会发的群数」：后者的 id 规则见 reportOutboxId。
    const rows = (
      await e.DB.prepare(
        `SELECT r.id,r.group_id,r.body,
           (SELECT COUNT(DISTINCT x.group_id) FROM review_reports x
             WHERE x.date=r.date AND x.state IN ('ready','queued')) AS groups_that_day
         FROM review_reports r
         WHERE r.date=? AND r.state='ready'
         ORDER BY r.group_id`,
      )
        .bind(date)
        .all()
    ).results as any[];
    if (!rows.length) return;

    const settings = (
      await e.DB.prepare("SELECT key,value FROM settings WHERE key IN ('off:review_report','learn:mode')").all()
    ).results as any[];
    const switches = Object.fromEntries(settings.map((row) => [row.key, String(row.value)]));
    if (switches["off:review_report"] === "1" || switches["learn:mode"] === "off") {
      await e.DB.prepare("UPDATE review_reports SET state='skipped', reason='off' WHERE date=? AND state='ready'")
        .bind(date)
        .run();
      return;
    }

    // 与 L1 的全局上限同口径：今日已发的定时推送 + 今日已入队的晨报。
    const { start, end } = dayBounds(at);
    const cap = await e.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM schedule_runs
           WHERE status IN ('ok','late') AND outbox_id IS NOT NULL AND due_at>=? AND due_at<?) +
         (SELECT COUNT(*) FROM outbox
           WHERE id LIKE 'reflection-report:%' AND created_at>=? AND created_at<?) AS n`,
    )
      .bind(start, end, start, end)
      .first();
    let budget = MAX_SENDS_DAY - Number(cap?.n || 0);
    if (budget <= 0) {
      await e.DB.prepare("UPDATE review_reports SET state='skipped', reason='cap' WHERE date=? AND state='ready'")
        .bind(date)
        .run();
      return;
    }

    const groups = Math.max(1, Number(rows[0].groups_that_day || rows.length));
    for (const row of rows) {
      if (budget <= 0) {
        await e.DB.prepare("UPDATE review_reports SET state='skipped', reason='cap' WHERE id=? AND state='ready'")
          .bind(row.id)
          .run();
        continue;
      }
      const body = String(row.body ?? "");
      if (REPORT_DENY.some((word) => body.toLowerCase().includes(word))) {
        await e.DB.batch([
          e.DB.prepare("UPDATE review_reports SET state='held', reason='deny' WHERE id=? AND state='ready'").bind(row.id),
          e.DB.prepare("INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?)").bind(
            `review-report-held:${row.id}`,
            "review_report_held",
            row.group_id,
            "review",
            "复盘晨报命中禁词，已在投递前拦下",
            new Date(at).toISOString(),
          ),
        ]);
        continue;
      }
      const id = reportOutboxId(date, row.group_id, groups);
      await e.DB.batch([
        e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,?,?)").bind(
          id,
          row.group_id,
          null,
          body,
          "pending",
          at,
        ),
        e.DB.prepare("UPDATE review_reports SET state='queued', queued_at=? WHERE id=? AND state='ready'").bind(at, row.id),
      ]);
      budget--;
    }
  },
};
