// One line per job: import { xxxJob } from "./xxx"; then add to CRON_JOBS (one per line, alphabetical).
import type { CronJob } from "../cron-extra";
import { generatedImagesCleanupJob } from "../imagegen";
import { imageCachePurgeJob } from "../imagecache";
import { summaryAutoJob } from "./summary-auto";
import { profilesNightJob } from "../profiles";
import { quotaMorningJob } from "../quota";
import { reviewReportJob } from "../review-report";

export const CRON_JOBS: CronJob[] = [
  generatedImagesCleanupJob,
  imageCachePurgeJob,
  profilesNightJob,
  quotaMorningJob,
  reviewReportJob,
  summaryAutoJob,
];
