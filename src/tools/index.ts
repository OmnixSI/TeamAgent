// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { calcTool } from "./calc";
import { emojiSearchTool } from "./emoji-search";
import { fetchPageTool } from "./fetch-page";
import { generateImageTool } from "./generate-image";
import { recallEpisodeTool } from "./episodes";
import { searchKbTool } from "./kb";
import { forgetProfileTool, getProfileTool } from "./profile";
import { newsSearchTool } from "./news-search";
import { readDocumentTool } from "./read-document";
import { repoSearchTools } from "./repo-search";
import { searchHistoryTool } from "./search-history";
import { summarizeChatTool } from "./summarize-chat";
import { webSearchTool } from "./web-search";

export const EXTRA_TOOLS: BotTool[] = [
  calcTool,
  emojiSearchTool,
  fetchPageTool,
  forgetProfileTool,
  generateImageTool,
  getProfileTool,
  newsSearchTool,
  readDocumentTool,
  recallEpisodeTool,
  ...repoSearchTools,
  searchHistoryTool,
  searchKbTool,
  summarizeChatTool,
  webSearchTool,
];
