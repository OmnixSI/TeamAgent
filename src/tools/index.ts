// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { newsSearchTool } from "./news-search";

export const EXTRA_TOOLS: BotTool[] = [
  newsSearchTool,
];
