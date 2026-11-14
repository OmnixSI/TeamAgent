// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { calcTool } from "./calc";
import { describeSelfTool } from "./describe-self";
import { emojiSearchTool } from "./emoji-search";
import { fetchPageTool } from "./fetch-page";
import { generateImageTool } from "./generate-image";
import { recallEpisodeTool } from "./episodes";
import { searchKbTool } from "./kb";
import { forgetProfileTool, getProfileTool } from "./profile";
import { getQuotaTool } from "./quota";
import { newsSearchTool } from "./news-search";
import { readDocumentTool } from "./read-document";
import { readImageTextTool } from "./read-image-text";
import { recordsReadTool, recordsWriteTool } from "./records";
import { repoSearchTools } from "./repo-search";
import { runStepsTool, runTaskTool } from "./run";
import { scheduleCancelTool, scheduleCreateTool, scheduleListTool, scheduleUpdateTool } from "./schedule-tools";
import { searchHistoryTool } from "./search-history";
import { stockQuoteTool } from "./stock-quote";
import { summarizeChatTool } from "./summarize-chat";
import { webSearchTool } from "./web-search";

export const EXTRA_TOOLS: BotTool[] = [
  calcTool,
  describeSelfTool,
  emojiSearchTool,
  fetchPageTool,
  forgetProfileTool,
  generateImageTool,
  getProfileTool,
  getQuotaTool,
  newsSearchTool,
  readDocumentTool,
  readImageTextTool,
  recallEpisodeTool,
  recordsReadTool,
  recordsWriteTool,
  ...repoSearchTools,
  runStepsTool,
  runTaskTool,
  scheduleCancelTool,
  scheduleCreateTool,
  scheduleListTool,
  scheduleUpdateTool,
  searchHistoryTool,
  searchKbTool,
  stockQuoteTool,
  summarizeChatTool,
  webSearchTool,
];
