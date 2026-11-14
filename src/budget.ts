// The Cloudflare plan is a fixed monthly allowance and nothing here may run past it. Usage this bot
// drives itself is counted as it happens; each meter stops some way before the included amount, so a
// busy month ends with a refusal ("this month's allowance is used up") rather than a charge.
import type { Hub } from "./hub.ts";

/** The account's billing cycle starts on this day of the month (UTC). */
const CYCLE_DAY = 13;
const DO_GB = 0.128;                       // a Durable Object is billed as 128 MB while it is awake
const DO_DURATION_INCLUDED = 400_000;      // GB-seconds per cycle

export const PLAN: Record<string, { included: number; stop: number; unit: string; what: string }> = {
  browser_seconds: { included: 36_000, stop: 30_600, unit: "秒", what: "无头浏览器（渲染文档和截图），套餐内每月 10 小时" },
  container_seconds: { included: 90_000, stop: 72_000, unit: "秒", what: "云电脑（容器，1 GiB 内存），套餐内每月 25 小时" },
  container_cpu_seconds: { included: 22_500, stop: 18_000, unit: "秒", what: "云电脑 CPU，套餐内每月 375 vCPU 分钟" },
  r2_writes: { included: 1_000_000, stop: 700_000, unit: "次", what: "R2 写入，免费额度每月 100 万次" },
  r2_reads: { included: 10_000_000, stop: 7_000_000, unit: "次", what: "R2 读取，免费额度每月 1000 万次" },
};
/** R2 keeps 10 GB for free; stop storing new large files well before that. */
export const R2_STORAGE_INCLUDED = 10 * 1024 ** 3;
export const R2_STORAGE_STOP = 8 * 1024 ** 3;

export function cycleStart(now: number) {
  const d = new Date(now);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - (d.getUTCDate() >= CYCLE_DAY ? 0 : 1), CYCLE_DAY));
  return start.getTime();
}

export class Plan {
  private hub: Hub;
  constructor(hub: Hub) { this.hub = hub; }
  private key(name: string, now = Date.now()) { return "plan:" + new Date(cycleStart(now)).toISOString().slice(0, 10) + ":" + name; }
  used(name: string) { return Number(this.hub.get(this.key(name)) || 0); }
  /** Whether `amount` more of this still fits under the stop line. */
  fits(name: string, amount = 0) { const p = PLAN[name]; return !p || this.used(name) + amount <= p.stop; }
  add(name: string, amount: number) { if (amount > 0) this.hub.set(this.key(name), String(Math.round((this.used(name) + amount) * 100) / 100)); }
  /** Counts `amount` if it fits; false means the allowance for this cycle is used up. */
  take(name: string, amount: number) { if (!this.fits(name, amount)) return false; this.add(name, amount); return true; }
  left(name: string) { const p = PLAN[name]; return p ? Math.max(0, p.stop - this.used(name)) : Infinity; }

  report(r2Bytes: number, now = Date.now()) {
    const start = cycleStart(now), end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const pct = (used: number, included: number) => Math.round(used / included * 1000) / 10;
    // The Hub is awake around the clock because it holds the QQ connection; a running container adds its own object.
    const cycleSeconds = (end.getTime() - start) / 1000;
    const durationSoFar = ((now - start) / 1000 + this.used("container_seconds")) * DO_GB;
    const durationWhole = (cycleSeconds + this.used("container_seconds")) * DO_GB;
    return {
      cycle: new Date(start).toISOString().slice(0, 10) + " 到 " + end.toISOString().slice(0, 10),
      rule: "每一项用到停止线就不再用，等下个周期；不会产生套餐外的费用",
      items: [
        ...Object.entries(PLAN).map(([name, p]) => ({
          what: p.what, used: Math.round(this.used(name)), stop_at: p.stop, included: p.included, unit: p.unit, percent_of_included: pct(this.used(name), p.included),
        })),
        { what: "R2 存储，免费额度 10 GB", used: Math.round(r2Bytes / 1048576), stop_at: Math.round(R2_STORAGE_STOP / 1048576), included: Math.round(R2_STORAGE_INCLUDED / 1048576), unit: "MB", percent_of_included: pct(r2Bytes, R2_STORAGE_INCLUDED) },
        {
          what: "Durable Object 在线时长（常驻 QQ 长连接，全月在线是固定开销）", used: Math.round(durationSoFar), included: DO_DURATION_INCLUDED, unit: "GB·秒",
          percent_of_included: pct(durationSoFar, DO_DURATION_INCLUDED), whole_cycle_estimate_percent: pct(durationWhole, DO_DURATION_INCLUDED),
        },
      ],
    };
  }
  /** Items that have used four fifths of what is included. */
  tight(r2Bytes: number) {
    return this.report(r2Bytes).items.filter(i => !i.what.startsWith("Durable Object") && i.percent_of_included >= 80).map(i => i.what + "已用 " + i.percent_of_included + "%");
  }
}
