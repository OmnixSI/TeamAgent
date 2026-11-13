// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
<<<<<<< HEAD
import { calcTool } from "./calc";
import { searchHistoryTool } from "./search-history";
import { summarizeChatTool } from "./summarize-chat";
import { forgetProfileTool, getProfileTool } from "./profile";

export const EXTRA_TOOLS: BotTool[] = [
  calcTool,
  forgetProfileTool,
  getProfileTool,
  searchHistoryTool,
  summarizeChatTool,
=======
import { recallEpisodeTool } from "./episodes";

export const EXTRA_TOOLS: BotTool[] = [
  recallEpisodeTool,
>>>>>>> pkg/F7-6
];
