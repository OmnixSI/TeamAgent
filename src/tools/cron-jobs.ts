// One line per job: import { xxxJob } from "./xxx"; then add to CRON_JOBS (one per line, alphabetical).
import type { CronJob } from "../cron-extra";
import { summaryAutoJob } from "./summary-auto";

export const CRON_JOBS: CronJob[] = [
  summaryAutoJob,
];
