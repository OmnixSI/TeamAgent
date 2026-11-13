// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import { calcTool } from "./calc";
import type { BotTool } from "../toolkit";

export const EXTRA_TOOLS: BotTool[] = [
  calcTool,
];
