import { UNTRUSTED_MARK } from "./untrusted";
import { extraUntrustedNames } from "./toolkit";
import { isAutoSender } from "./feature-request-core";
import { evidenceText, metaOf, quoteEvidence, quoteIn } from "./view";

export type WriteTool = "create_file_task" | "prepare_project_task" | "remember_correction" | "request_feature";
export const WRITE_TOOLS = new Set<string>(["create_file_task", "prepare_project_task", "remember_correction", "request_feature"]);
export const UNTRUSTED_TOOLS = new Set<string>(["search_web", "read_web", "get_work_status", "list_repos", "repo_changes", "repo_commit", "repo_file", ...extraUntrustedNames()]);

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

export const STRONG: Record<Exclude<WriteTool, "request_feature">, RegExp> = {
  prepare_project_task: /(建|开|创建|新建|立|加|提)(一?[个条])?(任务|需求|工单|issue)|立项|排进(计划|任务)|交给(本地|AI|你)(去)?(做|干|实现|处理)/i,
  create_file_task: /(做|写|生成|整理|导出|出|弄)(一?[个份])?(成)?(文档|文件|表格|报告|总结|PPT|CSV|XLSX|PDF|DOCX|幻灯片|方案|清单|纪要)/i,
  remember_correction: /记住|记一下|记下来|以后(要|别|不要)|不是.{1,20}是|纠正(一下)?|说错了|搞错了/,
};

// Both work tools use this language contract on clean turns. No artifact nouns.
const REQUEST_TONE = /^(?:请问(?:你)?)?(?:(?:请|麻烦)(?:你)?|帮我|帮忙|给我|你来|你把|去|劳驾|能不能(?:帮我|帮忙|帮|请你)?|可以(?:帮我|帮忙|帮|请你)|能帮我)/;
const STRICT_REQUEST_TONE = /^(?:(?:请|麻烦)(?:你)?|帮我|帮忙|劳驾|能不能(?:帮我|帮忙|请你)?|(?:可以|能)帮我)/;
const WORK_ACTION = /修复|修|实现|开发|写|做|出|整理|改|加|排查|重构|测试|部署|规划|设计|方案|文档|看看|查一下|检查|看下/;
const TASK_REQUEST = new RegExp(STRONG.prepare_project_task.source + "|记(一?[个条])?任务", "i");
const CORRECTION = /^(?:(?:请|麻烦)(?:你)?(?:帮我)?|帮我)?(?:纠正(?:一下)?|不是.{1,80}是|应该叫|名字改成|其实是)/;
// Reject completion/aspect markers across the whole work request. 了/过 cover
// verb endings, result complements (好了/完了/成了), and sentence-final reports.
const COMPLETED_WORK = /[了过]|已经|搞定|弄好/;
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
  return !lead || (dirty ? STRICT_REQUEST_TONE : REQUEST_TONE).test(lead) ||
    /^(?:看完|读完|看了)[\s\S]{0,60}(?:帮我|帮忙|请你)$/.test(lead);
}

function ownClauses(text: string): string[] {
  // Reported speech and code are evidence, never the speaker's own command.
  const own = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, "");
  return own.split(/[，,。！？!?；;\n]/).map(part => part.trim().replace(/^@\S+\s+/, ""));
}

// A short heading before a colon ("小任务：请…", "接入验收小活：请…") labels the
// request after it; it is not reported speech. Split it off so the existing
// tone/action rules judge the request on its own. The head must stay short and
// free of quotation, report and past-time markers, and a negated or quoted
// tail stays in one piece, so "他说：请…" and "注意：请勿…" remain rejected.
const LABEL_MAX = 16;
// Only a head that names the work item may open a request; any other head
// (a person, "没有授权", ...) keeps the whole clause so it is judged as reported speech.
const TASK_LABEL = /^(?:小|大|新|临时|紧急|接入|验收|开发|修复|测试|文档|一个|个)*(?:任务|小活|活|需求|工单|待办|事项)$/;
const REPORTED_LABEL = /说|讲|问|写道|回复|提到|表示|称|转述|引用|贴|粘贴|转发|上次|昨天|之前|曾经|已经|刚才/;
const NEGATED_LABEL = /^(?:别|不要|不用|不必|无需|勿|请勿|禁止)/;
const NEGATED_REQUEST = /^(?:请|麻烦)?(?:你)?\s*(?:勿|不要|别|不用|不必|无需|不想|不需要)/;
const HALF_COLON_REQUEST = /^\s*(?:请|麻烦|帮我|帮忙|给我|你来|去|劳驾|能不能|可以)/;
function splitLabel(clause: string): string[] {
  for (let at = 0; at < clause.length; at++) {
    const mark = clause[at];
    if (mark !== "：" && mark !== ":") continue;
    const head = clause.slice(0, at).trim(), rawTail = clause.slice(at + 1), tail = rawTail.trim();
    // A half-width colon only counts in front of a request ("任务: 请…"), so
    // times, ratios and URLs keep their clause whole.
    if (mark === ":" && !HALF_COLON_REQUEST.test(rawTail)) continue;
    if (!head || [...head].length > LABEL_MAX || !TASK_LABEL.test(head) || REPORTED_LABEL.test(head) || NEGATED_LABEL.test(head) || NEGATED_REQUEST.test(tail)) return [clause];
    return [head, tail];
  }
  return [clause];
}
function workClauses(text: string): string[] {
  return ownClauses(text).flatMap(splitLabel);
}

// A face alone between 不是 and 是 is the corrected old value: keep a one-char,
// non-space, non-punctuation gap there. Everywhere else faces vanish, so
// contiguous phrases and negative guards see the member's prose unchanged.
const FACE_GAP = /(不是)(?:\s*\[表情\])+\s*(?=是)/g;
function neutralFaces(text: string): string {
  return text.replace(FACE_GAP, "$1￼").replaceAll("[表情]", "").trim();
}

/** The only clean-turn work predicate, shared by file and project tools. */
export function cleanWorkRequest(text: string): boolean {
  if (COMPLETED_WORK.test(text)) return false;
  return workClauses(text).some(clause => {
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
  if (tool === "request_feature") return false; // Feature intent belongs to the model, never these regexes.
  text = neutralFaces(text);
  if (tool !== "remember_correction" && !dirty) return cleanWorkRequest(text);
  if (tool !== "remember_correction" && COMPLETED_WORK.test(text)) return false;
  // Corrections keep the original clause splitter; labels only open work requests.
  const clauses = tool === "remember_correction" ? ownClauses(text) : workClauses(text);
  return clauses.some(clause => {
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
  const text = evidenceText(String(source.body || ""), mentions).replace(/^@\S+\s+/, "");
  return explicitCommand(tool, text, dirty ?? tainted({ batch: [{ meta }] }, [{ role: "user", content: source.body }]));
}

type Authorization = { ok: true; tainted: boolean } | { ok: false; reason: string };
export function authorize(tool: WriteTool, quote: unknown, source: any, context: any, messages: any[]): Authorization {
  if (tool === "request_feature") return authorizeFeature(quote, source, context, messages);
  const dirty = tainted(context, messages);
  if (typeof quote !== "string" || !source?.id || !(context.batch?.some((r: any) => r.id === source.id) || source.id === context.latest?.id))
    return { ok: false, reason: "外部资料不能作为交办依据" };
  if (!quoteIn(source, quote, context.names)) return { ok: false, reason: "原话不在成员发言里" };
  const evidence = quoteEvidence(String(source.body || ""), quote);
  if (evidence.replace(/[\s\p{P}]/gu, "").length < 4) return { ok: false, reason: "原话太短" };
  if (!explicitCommand(tool, evidence, dirty) || !explicitWriteRequest(tool, source, context.names, dirty))
    return { ok: false, reason: "成员原话里没有明确交办" };
  return { ok: true, tainted: dirty };
}

/** Only these application-generated reasons may cross the generic tool error filter. */
export class AuthorizationError extends Error {}

/** Feature intent is semantic; only provenance, direct addressing and evidence are checked here. */
export function authorizeFeature(quote: unknown, source: any, context: any, messages: any[]): Authorization {
  if (!source?.id || !(context.batch?.some((row: any) => row.id === source.id) || context.latest?.id === source.id))
    return { ok: false, reason: "外部资料不能作为交办依据" };
  if (source.meta?.direct !== true) return { ok: false, reason: "需要直接@机器人提需求" };
  if (typeof quote !== "string" || !quoteIn(source, quote, context.names))
    return { ok: false, reason: "原话不在成员发言里" };
  if ([...quoteEvidence(String(source.body || ""), quote).replace(/[\s\p{P}]/gu, "")].length < 6)
    return { ok: false, reason: "原话太短" };
  return { ok: true, tainted: tainted(context, messages) };
}

// ---- D1 records write authorization (design §5.9 授权表) -------------------
// D4 wires these operations into WRITE_TOOLS; D1 tools call this directly.
export type RecordsAuthOp = "read" | "define_type" | "add" | "undo" | "quote_update" | "quote_delete" | "confirm";
export interface RecordsAuthInput {
  e: any;
  source: any;
  context: any;
  messages: any[];
  request_quote?: unknown;
  recordId?: string;
  token?: string;
  /** ToolCtx.isTainted(): the turn's authoritative taint flag. */
  tainted?: boolean;
}

/** records_read is open to every member; writes need the speaker's own words, and
 *  change/confirm needs the record creator or an admin (and never tainted material). */
export async function authorizeRecords(
  op: RecordsAuthOp,
  input: RecordsAuthInput,
): Promise<{ ok: true; tainted: boolean } | { ok: false; reason: string }> {
  const { e, source, context, messages } = input;
  if (op === "read") return { ok: true, tainted: input.tainted ?? tainted(context, messages) };
  const dirty = input.tainted ?? tainted(context, messages);
  if (!source?.id || !(context?.batch?.some((row: any) => row.id === source.id) || context?.latest?.id === source.id))
    return { ok: false, reason: "外部资料不能作为记账依据" };
  if (typeof input.request_quote !== "string" || !input.request_quote.trim())
    return { ok: false, reason: "需要成员自己的原话" };
  if (!quoteIn(source, input.request_quote, context.names))
    return { ok: false, reason: "原话不在成员发言里" };
  const evidence = quoteEvidence(String(source.body || ""), input.request_quote);
  if ([...evidence.replace(/[\s\p{P}]/gu, "")].length < 2)
    return { ok: false, reason: "原话太短" };
  if (dirty && (op === "quote_update" || op === "quote_delete" || op === "confirm"))
    return { ok: false, reason: "引用、转发或网页内容不能作为改动依据" };
  const addressed = source.meta?.direct === true || Number(source.mentioned) === 1 || source.id === context?.latest?.id;
  if (!addressed) return { ok: false, reason: "需要成员直接对机器人说" };
  if (op === "quote_update" || op === "quote_delete" || op === "confirm") {
    const admin = await isAutoSender(e, source.sender);
    if (admin) return { ok: true, tainted: dirty };
    const ids: string[] = [];
    if (input.recordId) ids.push(input.recordId);
    if (input.token) {
      const row = await e.DB.prepare("SELECT draft FROM pending_actions WHERE id=? AND group_id=?").bind(input.token, source.group_id).first();
      if (row?.draft) {
        try {
          const draft = JSON.parse(String(row.draft));
          if (Array.isArray(draft?.recordIds)) ids.push(...draft.recordIds.filter((id: unknown) => typeof id === "string"));
        } catch { /* a broken draft is rejected later by applyChange */ }
      }
    }
    for (const id of ids) {
      const row = await e.DB.prepare("SELECT creator FROM records WHERE id=?").bind(id).first();
      if (row && row.creator !== source.sender)
        return { ok: false, reason: "只能改自己记的，或请管理员改" };
    }
  }
  return { ok: true, tainted: dirty };
}
