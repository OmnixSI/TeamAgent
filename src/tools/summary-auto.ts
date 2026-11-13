// 自动群聊总结的 CronJob 包装：默认关，由 settings summary_auto:<group_id> 打开。
import type { CronJob } from "../cron-extra";
import { autoSummary } from "../summary";

export const summaryAutoJob: CronJob = {
  name: "summary-auto",
  async run(e: any, now: Date) {
    await autoSummary(e, now);
  },
};
