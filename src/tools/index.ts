// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { forgetProfileTool, getProfileTool } from "./profile";

export const EXTRA_TOOLS: BotTool[] = [
  forgetProfileTool,
  getProfileTool,
];
