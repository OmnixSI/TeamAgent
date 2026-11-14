// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
//
// D3b（日程 v2）的四个工具已写好并在 test/schedules-v2.test.mjs 里通过，但**先不注册**：
// schedule_create / schedule_list / schedule_cancel 与 semantic.ts 里的旧定义同名，注册会让
// test/tool-names-unique.test.mjs 与 test/self-card-gen.test.mjs 变红。D4 删掉 semantic.ts 的
// 旧定义与旧 case 后，把下面四行加进 EXTRA_TOOLS（字母序，recallEpisodeTool 之后）：
//   import { scheduleCancelTool, scheduleCreateTool, scheduleListTool, scheduleUpdateTool } from "./schedule-tools";
//   scheduleCancelTool, scheduleCreateTool, scheduleListTool, scheduleUpdateTool,
// 同时把 config/self-manifest.json 的 schedules.tools 加上 schedule_update。
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
  searchHistoryTool,
  searchKbTool,
  stockQuoteTool,
  summarizeChatTool,
  webSearchTool,
];
