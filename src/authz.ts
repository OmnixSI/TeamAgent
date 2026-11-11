import { UNTRUSTED_MARK } from "./untrusted";
import { displayText, metaOf, quoteIn } from "./view";

export type WriteTool = "create_file_task" | "prepare_project_task" | "remember_correction";
export const WRITE_TOOLS = new Set<string>(["create_file_task", "prepare_project_task", "remember_correction"]);
export const UNTRUSTED_TOOLS = new Set<string>(["search_web", "read_web", "get_work_status"]);

/** Once external material enters a turn, later tool calls cannot shed its taint. */
export function tainted(context: any, messages: any[]): boolean {
  if (context.videoWaited || context.materials?.length || context.authz?.tainted) return true;
  if ((context.batch || []).some((r: any) => r.meta?.quoted || r.meta?.forwarded?.length || r.meta?.cardView || r.meta?.replyTo)) return true;
  const names = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") for (const call of m.tool_calls || []) names.set(call.id, call.function.name);
    if (m.role === "tool" && UNTRUSTED_TOOLS.has(names.get(m.tool_call_id) || "")) return true;
    if (m.role !== "system" && typeof m.content === "string" && m.content.includes(UNTRUSTED_MARK)) return true;
  }
  return false;
}

export const STRONG: Record<WriteTool, RegExp> = {
  prepare_project_task: /(建|开|创建|新建|立|加|提)(一?[个条])?(任务|需求|工单|issue)|立项|排进(计划|任务)|交给(本地|AI|你)(去)?(做|干|实现|处理)/i,
  create_file_task: /(做|写|生成|整理|导出|出|弄)(一?[个份])?(成)?(文档|文件|表格|报告|总结|PPT|CSV|XLSX|PDF|DOCX|幻灯片|方案|清单|纪要)/i,
  remember_correction: /记住|记一下|记下来|以后(要|别|不要)|不是.{1,20}是|纠正(一下)?|说错了|搞错了/,
};

/** An action mentioned in a statement is not an instruction to perform it. */
function explicitCommand(tool: WriteTool, text: string): boolean {
  // Reported speech and code are evidence, never the speaker's own command.
  const own = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, "");
  return own.split(/[，,。！？!?；;\n]/).some(part => {
    const clause = part.trim().replace(/^@\S+\s+/, ""), match = STRONG[tool].exec(clause);
    if (!match) return false;
    const prefix = clause.slice(0, match.index), suffix = clause.slice(match.index + match[0].length);
    if (/^(?:了|过|的|很|挺|真|太|是|会|不|效果)/.test(suffix)) return false;
    if (/(?:没有|不要|别|不用|不必|无需|不想|不需要)/.test(prefix)) return false;
    const lead = prefix.replace(/^(?:现在|这次|接下来|明天|稍后|然后|再|先)\s*/, "");
    return !lead || /^(?:(?:请|麻烦)(?:你)?|帮我|帮忙|劳驾|能不能(?:帮我|帮忙|请你)?|(?:可以|能)帮我|把)/.test(lead) ||
      /^(?:看完|读完|看了)[\s\S]{0,60}(?:帮我|帮忙|请你)$/.test(lead);
  });
}

/** Shared by routing and authorization; inspect the whole original, not a model-selected substring. */
export function explicitWriteRequest(tool: WriteTool, source: any, names = new Map<string, string>()): boolean {
  const meta = metaOf(source);
  const mentions = (meta.mentions || []).map((m: any) => ({ ...m, name: m.name || names.get(m.id) || "" }));
  const text = displayText(String(source.body || ""), mentions).replace(/^@\S+\s+/, "");
  return explicitCommand(tool, text);
}

type Authorization = { ok: true; tainted: boolean } | { ok: false; reason: string };
export function authorize(tool: WriteTool, quote: unknown, source: any, context: any, messages: any[]): Authorization {
  const dirty = tainted(context, messages);
  if (typeof quote !== "string" || !source?.id || !(context.batch?.some((r: any) => r.id === source.id) || source.id === context.latest?.id))
    return { ok: false, reason: "外部资料不能作为交办依据" };
  if (!quoteIn(source, quote, context.names)) return { ok: false, reason: "原话不在成员发言里" };
  if (dirty && quote.replace(/[\s\p{P}]/gu, "").length < 4) return { ok: false, reason: "原话太短" };
  if (!explicitCommand(tool, quote) || !explicitWriteRequest(tool, source, context.names))
    return { ok: false, reason: "成员原话里没有明确交办" };
  return { ok: true, tainted: dirty };
}

/** Only these application-generated reasons may cross the generic tool error filter. */
export class AuthorizationError extends Error {}
