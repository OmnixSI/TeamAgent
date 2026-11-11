import { UNTRUSTED_MARK } from "./untrusted";
import { displayText, metaOf, quoteIn } from "./view";

export type WriteTool = "create_file_task" | "prepare_project_task" | "remember_correction";
export const WRITE_TOOLS = new Set<string>(["create_file_task", "prepare_project_task", "remember_correction"]);
export const UNTRUSTED_TOOLS = new Set<string>(["search_web", "read_web", "get_work_status"]);

/** Once external material enters a turn, later tool calls cannot shed its taint. */
export function tainted(context: any, messages: any[]): boolean {
  if (context.videoWaited || context.materials?.length || context.authz?.tainted) return true;
  if ((context.batch || []).some((r: any) => {
    const meta = metaOf(r);
    return meta.quoted || meta.forwarded?.length || meta.cardView || meta.replyTo || String(r.body || "").includes(UNTRUSTED_MARK);
  })) return true;
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

// Both work tools use this language contract on clean turns. No artifact nouns.
const REQUEST_TONE = /^(?:请问(?:你)?)?(?:(?:请|麻烦)(?:你)?|帮我|帮忙|给我|你来|去|劳驾|能不能(?:帮我|帮忙|帮|请你)?|可以(?:帮我|帮忙|帮|请你)|能帮我|把)/;
const STRICT_REQUEST_TONE = /^(?:(?:请|麻烦)(?:你)?|帮我|帮忙|劳驾|能不能(?:帮我|帮忙|请你)?|(?:可以|能)帮我)/;
const WORK_ACTION = /修复|修|实现|开发|写|做|出|整理|改|加|排查|重构|测试|部署|规划|设计|方案|文档|看看|查一下|检查|看下/;
const TASK_REQUEST = new RegExp(STRONG.prepare_project_task.source + "|记(一?[个条])?任务", "i");
const CORRECTION = /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我)?(?:纠正(?:一下)?|不是.{1,80}是|应该叫|名字改成|其实是)/;
const COMMAND_EXCLUSIONS = {
  statementTail: /^(?:了|过|的|很|挺|真|太|是|会|不|效果)|的(?:人)?是/,
  negatedLead: /(?:没有|不要|别|不用|不必|无需|不想|不需要|记住|记一下|记下来)/,
  commentQuestion: /^为什么|(?:有必要|合适|合理|值得|难不难|好不好|怎么样|是谁|是不是|对不对)(?:吗|呢|么)?$/,
  reportedLead: /^(?:上次|昨天|之前|曾经|已经|刚才)/,
};

function imperativeMatch(clause: string, match: RegExpExecArray, dirty: boolean): boolean {
  const prefix = clause.slice(0, match.index), suffix = clause.slice(match.index + match[0].length);
  if (COMMAND_EXCLUSIONS.statementTail.test(suffix) || COMMAND_EXCLUSIONS.negatedLead.test(prefix) || COMMAND_EXCLUSIONS.reportedLead.test(prefix)) return false;
  const lead = prefix.replace(/^(?:现在|这次|接下来|明天|稍后|然后|再|先)\s*/, "");
  return !lead || (dirty ? STRICT_REQUEST_TONE : REQUEST_TONE).test(lead) || /^把/.test(lead) ||
    /^(?:看完|读完|看了)[\s\S]{0,60}(?:帮我|帮忙|请你)$/.test(lead);
}

function ownClauses(text: string): string[] {
  // Reported speech and code are evidence, never the speaker's own command.
  const own = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, "");
  return own.split(/[，,。！？!?；;\n]/).map(part => part.trim().replace(/^@\S+\s+/, ""));
}

/** The only clean-turn work predicate, shared by file and project tools. */
export function cleanWorkRequest(text: string): boolean {
  return ownClauses(text).some(clause => {
    if (COMMAND_EXCLUSIONS.commentQuestion.test(clause)) return false;
    const task = TASK_REQUEST.exec(clause);
    if (task && imperativeMatch(clause, task, false)) return true;
    const tone = REQUEST_TONE.exec(clause);
    if (!tone) return false;
    const action = WORK_ACTION.exec(clause.slice(tone[0].length));
    if (!action) return false;
    action.index += tone[0].length;
    return imperativeMatch(clause, action, false);
  });
}

/** Clean work, explicit correction, and strict tainted authorization are separate intents. */
function explicitCommand(tool: WriteTool, text: string, dirty: boolean): boolean {
  if (tool !== "remember_correction" && !dirty) return cleanWorkRequest(text);
  return ownClauses(text).some(clause => {
    if (COMMAND_EXCLUSIONS.commentQuestion.test(clause)) return false;
    if (tool === "remember_correction") {
      const correction = CORRECTION.exec(clause);
      if (!correction || COMMAND_EXCLUSIONS.statementTail.test(clause.slice(correction[0].length))) return false;
      // External material still cannot grant new forms of memory authorization.
      if (!dirty) return true;
      const strict = STRONG.remember_correction.exec(clause);
      return !!strict && imperativeMatch(clause, strict, true);
    }
    const strict = STRONG[tool].exec(clause);
    return !!strict && imperativeMatch(clause, strict, true);
  });
}

/** Shared by routing and authorization; inspect the whole original, not a model-selected substring. */
export function explicitWriteRequest(tool: WriteTool, source: any, names = new Map<string, string>(), dirty?: boolean): boolean {
  const meta = metaOf(source);
  const mentions = (meta.mentions || []).map((m: any) => ({ ...m, name: m.name || names.get(m.id) || "" }));
  const text = displayText(String(source.body || ""), mentions).replace(/^@\S+\s+/, "");
  return explicitCommand(tool, text, dirty ?? tainted({ batch: [{ meta }] }, [{ role: "user", content: source.body }]));
}

type Authorization = { ok: true; tainted: boolean } | { ok: false; reason: string };
export function authorize(tool: WriteTool, quote: unknown, source: any, context: any, messages: any[]): Authorization {
  const dirty = tainted(context, messages);
  if (typeof quote !== "string" || !source?.id || !(context.batch?.some((r: any) => r.id === source.id) || source.id === context.latest?.id))
    return { ok: false, reason: "外部资料不能作为交办依据" };
  if (!quoteIn(source, quote, context.names)) return { ok: false, reason: "原话不在成员发言里" };
  if (quote.replace(/[\s\p{P}]/gu, "").length < 4) return { ok: false, reason: "原话太短" };
  if (!explicitCommand(tool, quote, dirty) || !explicitWriteRequest(tool, source, context.names, dirty))
    return { ok: false, reason: "成员原话里没有明确交办" };
  return { ok: true, tainted: dirty };
}

/** Only these application-generated reasons may cross the generic tool error filter. */
export class AuthorizationError extends Error {}
