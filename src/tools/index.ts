// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { emojiSearchTool } from "./emoji-search";

export const EXTRA_TOOLS: BotTool[] = [
  emojiSearchTool,
];
