// F7 tool extension point. New bot tools live in src/tools/<name>.ts and are listed in src/tools/index.ts.
// semantic.ts only knows this file: it adds the defs to the tool list, dispatches unknown names here,
// and wraps results of untrusted tools in the material envelope. Do not put tool logic in semantic.ts.
import { EXTRA_TOOLS } from "./tools/index";

export interface ToolCtx {
  /** the turn context built by worker.ts (group id, latest message, mentioned, switches...) */
  context: any;
  /** the member message this call answers (sender, id, body) */
  source?: any;
  /** the running chat transcript, for authorize() taint checks on write tools */
  messages: any[];
  /** true once outside material (web, quoted, forwarded, files, untrusted tool results) is in this turn; write tools must refuse or require an explicit member request when true */
  isTainted: () => boolean;
}

export interface BotTool {
  name: string;
  /** OpenAI-style function definition shown to the model; def.function.name must equal name */
  def: { type: "function"; function: { name: string; description: string; parameters: any } };
  /** true when the result carries text from outside the team (web, files, other people's history): taints the turn */
  untrusted: boolean;
  /** admin kill switch is settings key `off:<switch>`; defaults to the tool name */
  switch?: string;
  run(e: any, args: any, ctx: ToolCtx): Promise<any>;
}

export function extraToolDefs(): any[] {
  return EXTRA_TOOLS.map((t) => t.def);
}
export function findExtraTool(name: string): BotTool | undefined {
  return EXTRA_TOOLS.find((t) => t.name === name);
}
export function extraUntrustedNames(): string[] {
  return EXTRA_TOOLS.filter((t) => t.untrusted).map((t) => t.name);
}
export async function toolSwitchedOff(e: any, t: BotTool): Promise<boolean> {
  const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind("off:" + (t.switch || t.name)).first();
  return !!row && String(row.value || "").length > 0 && row.value !== "0" && row.value !== "false";
}
/** Dispatch used by semantic.ts default branch. Failures are structured so the model can say why and change route. */
export async function runExtraTool(e: any, name: string, args: any, ctx: ToolCtx): Promise<any> {
  const t = findExtraTool(name);
  if (!t) return { error: "unknown tool" };
  if (await toolSwitchedOff(e, t)) return { unavailable: true, error_kind: "denied", reason_text: "该功能已被管理员关闭", next_action: "告诉成员该功能当前关闭，不要重试" };
  return t.run(e, args, ctx);
}
