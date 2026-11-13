// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
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
];
