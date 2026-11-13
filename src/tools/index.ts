// One line per F7 tool: import { xxxTool } from "./xxx"; then add it to EXTRA_TOOLS (keep one per line, alphabetical).
import type { BotTool } from "../toolkit";
import { readDocumentTool } from "./read-document";

export const EXTRA_TOOLS: BotTool[] = [readDocumentTool];
