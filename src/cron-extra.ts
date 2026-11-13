// F7 extension point for per-minute Worker cron work. Each job decides by itself whether it is due
// (night window, interval, lease) and must be cheap when idle: at most 2 D1 statements when nothing is due.
// worker.ts calls runCronExtras once per cron tick inside optionalCron; failures here never block mandatory maintenance.
import { CRON_JOBS } from "./tools/cron-jobs";

export interface CronJob {
  name: string;
  run(e: any, now: Date): Promise<void>;
}
export async function runCronExtras(e: any, now = new Date()): Promise<void> {
  for (const job of CRON_JOBS) {
    try { await job.run(e, now); } catch (error) { console.log("cron-extra " + job.name + " failed: " + String((error as any)?.message || error).slice(0, 200)); }
  }
}
