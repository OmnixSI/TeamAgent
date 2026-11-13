// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { calcTool } from "./calc";
import { emojiSearchTool } from "./emoji-search";
import { recallEpisodeTool } from "./episodes";
import { searchKbTool } from "./kb";
import { forgetProfileTool, getProfileTool } from "./profile";
import { newsSearchTool } from "./news-search";
import { readDocumentTool } from "./read-document";
import { repoSearchTools } from "./repo-search";
import { searchHistoryTool } from "./search-history";
import { stockQuoteTool } from "./stock-quote";
import { summarizeChatTool } from "./summarize-chat";

export const EXTRA_TOOLS: BotTool[] = [
  calcTool,
  emojiSearchTool,
  forgetProfileTool,
  getProfileTool,
  newsSearchTool,
  readDocumentTool,
  recallEpisodeTool,
  ...repoSearchTools,
  searchHistoryTool,
  searchKbTool,
  stockQuoteTool,
  summarizeChatTool,
];
