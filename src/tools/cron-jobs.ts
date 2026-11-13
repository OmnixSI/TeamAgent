// One line per job: import { xxxJob } from "./xxx"; then add to CRON_JOBS (one per line, alphabetical).
import type { CronJob } from "../cron-extra";
import { generatedImagesCleanupJob } from "../imagegen";
import { summaryAutoJob } from "./summary-auto";
import { profilesNightJob } from "../profiles";

export const CRON_JOBS: CronJob[] = [
  generatedImagesCleanupJob,
  profilesNightJob,
  summaryAutoJob,
];
