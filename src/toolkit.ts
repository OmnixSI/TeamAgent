// F7 tool extension point. New bot tools live in src/tools/<name>.ts and are listed in src/tools/index.ts.
// semantic.ts only knows this file: it adds the defs to the tool list, dispatches unknown names here,
// and wraps results of untrusted tools in the material envelope. Do not put tool logic in semantic.ts.
import { EXTRA_TOOLS } from "./tools/index";
import { discoverMcpTools } from "./tools/mcp-bridge";
import { McpError, mcpFailure } from "./mcp";

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

// Dynamic registries are scoped to one context object, never shared across turns/groups.
const dynamicTools = new WeakMap<object, BotTool[]>();
export function extraToolDefs(): any[];
export function extraToolDefs(e: any, context: any): Promise<any[]>;
export function extraToolDefs(e?: any, context?: any): any[] | Promise<any[]> {
  if (!e || !context) return EXTRA_TOOLS.map(t => t.def);
  return discoverMcpTools(e, context).then(tools => {
    dynamicTools.set(context, tools);
    return [...EXTRA_TOOLS, ...tools].map(t => t.def);
  });
}
export function findExtraTool(name: string, context?: object): BotTool | undefined {
  return EXTRA_TOOLS.find(t => t.name === name) || (context ? dynamicTools.get(context)?.find(t => t.name === name) : undefined);
}
export function extraUntrustedNames(context?: object): string[] {
  return [...EXTRA_TOOLS, ...(context ? dynamicTools.get(context) || [] : [])].filter(t => t.untrusted).map(t => t.name);
}
export async function toolSwitchedOff(e: any, t: BotTool): Promise<boolean> {
  const row = await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind("off:" + (t.switch || t.name)).first();
  return !!row && String(row.value || "").length > 0 && row.value !== "0" && row.value !== "false";
}
async function auditTool(e: any, name: string, args: any, ctx: ToolCtx, started: number, result: any) {
  const group = ctx.context?.latest?.group_id, turn = ctx.context?.latest?.id;
  if (!group || !turn) return;
  const data = new TextEncoder().encode(JSON.stringify(args) ?? "null");
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), b => b.toString(16).padStart(2, "0")).join("");
  await e.DB.prepare("INSERT INTO tool_calls(group_id,turn_id,name,args_hash,status,error_kind,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?)")
    .bind(group, turn, name, hash, result?.ok === true ? "ok" : "error", result?.error_kind || null, Date.now() - started, Date.now()).run();
}
/** Dispatch used by semantic.ts default branch. Failures are structured so the model can say why and change route. */
export async function runExtraTool(e: any, name: string, args: any, ctx: ToolCtx): Promise<any> {
  const started = Date.now(), t = findExtraTool(name, ctx.context);
  let result: any;
  if (!t) result = name.startsWith("mcp_") ? mcpFailure(new McpError("denied", "unknown MCP tool")) : { error: "unknown tool" };
  else if (await toolSwitchedOff(e, t)) result = { ok: false, unavailable: true, error_kind: "denied", retryable: false, reason_text: "该功能已被管理员关闭", next_action: "告诉成员该功能当前关闭，不要重试" };
  else result = await t.run(e, args, ctx);
  if (name === "calc" || name.startsWith("mcp_")) {
    try { await auditTool(e, name, args, ctx, started, result); }
    catch { return { ok: false, error_kind: "unavailable", retryable: false, reason_text: "工具审计写入失败", next_action: "告知成员审计不可用，停止调用并联系管理员" }; }
  }
  return result;
}
