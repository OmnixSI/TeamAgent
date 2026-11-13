// /summary [24h|100] 的命令处理。基线没有 commands.ts，本文件只导出函数，接线点写在 notes/F7-3.md。
import { summaryModel, parseSummaryCommand, runSummaryCommand } from "../summary";

export { parseSummaryCommand, runSummaryCommand };

/**
 * Wiring point for worker.ts (one line, before the normal chat job):
 *   const summaryCommand = await runSummaryCommandGuarded(e, { groupId: m.group_openid, text, msgId: m.id });
 *   if (summaryCommand.handled) return json({ op: 12, d: 0 });
 */
export async function runSummaryCommandGuarded(
  e: any,
  options: { groupId: string; text: string; msgId?: string; now?: Date },
) {
  if (!parseSummaryCommand(options.text)) return { handled: false as const };
  return runSummaryCommand(e, options, summaryModel(e));
}
