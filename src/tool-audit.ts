/** F6: bounded recovery and model-visible failures at the tool execution boundary. */
import { AuthorizationError } from "./authz";
import { ResourceLimitError } from "./d1";
import { redact } from "./runtime";
import { enqueueVoice } from "./voice";
import { READ_REASONS, webFailText, type ReadReason } from "./linkfail";
import { flushTail } from "./timing";

// V-B ErrorKind names are preserved; internal is the explicit F6 exception kind.
type ErrorKind = "unauthorized" | "budget" | "timeout" | "not_found" | "ambiguous"
  | "invalid_args" | "denied" | "stale_index" | "not_synced" | "runner_offline"
  | "runner_unsupported" | "upstream" | "risk" | "unknown" | "duplicate"
  | "internal" | "needs_token" | "rate_limited" | "too_large" | "binary";
const REASONS: Record<ErrorKind, [string, string]> = {
  unauthorized: ["缺少当前成员的明确授权", "请交办人用自己的话直接说明要做什么"],
  budget: ["本轮处理额度已用完", "保留已有结果，下一轮继续处理"],
  timeout: ["读取超时", "换一个来源或缩小查询范围再试"],
  not_found: ["已查范围没有对应资料", "换更准确的名称、路径或编号再查"],
  ambiguous: ["匹配到多个对象", "核对完整名称或编号后再查"],
  invalid_args: ["查询参数不正确", "按工具要求修正参数后再试"],
  denied: ["访问被拒绝或功能已关闭", "说明访问限制，改用允许读取的资料"],
  stale_index: ["现有索引尚未更新", "注明同步时间，改查实时来源"],
  not_synced: ["本机尚未同步这个项目", "改查云端仓库或已同步的项目资料"],
  runner_offline: ["本机执行端不在线", "改用云端资料，恢复在线后再处理本机部分"],
  runner_unsupported: ["本机执行端版本不支持", "保留请求，更新执行端后再试"],
  upstream: ["外部服务失败", "换来源再试，仍失败则保留已有资料并说明限制"],
  risk: ["网站拦截了自动读取", "改查公开来源；需要登录的部分待本人在原网站恢复后再试"],
  unknown: ["读取未完成，原因尚未确认", "改查其他来源，并保留问题供排查"],
  duplicate: ["相同调用已经处理过", "改用不同工具或不同参数，不重复相同操作"],
  internal: ["内部处理出错", "改查其他来源，保留请求供排查"],
  needs_token: ["私有仓库缺少读取凭据", "先查本地索引，缺失部分待配置只读凭据后再核实"],
  rate_limited: ["来源限制了请求频率", "先查本地索引或其他来源，稍后再查实时记录"],
  too_large: ["资料超过读取上限", "缩小文件路径、行号或查询范围再试"],
  binary: ["该文件是二进制内容", "改查文字说明或相关源码"],
};
export type ToolFailure = { ok: false; unavailable: true; error_kind: ErrorKind;
  reason: string; reason_text: string; next_action: string; retryable: boolean };
const NO_RETRY = new Set<ErrorKind>(["unauthorized", "budget", "denied", "risk", "duplicate", "runner_unsupported", "binary"]);
const ALIASES: Record<string, ErrorKind> = { login_required: "unauthorized", offline: "runner_offline",
  runner_outdated: "runner_unsupported", invalid: "invalid_args", unsupported: "denied", empty: "not_found" };
function kindOf(error: any): ErrorKind {
  if (error instanceof AuthorizationError) return "unauthorized";
  if (error instanceof ResourceLimitError) return "budget";
  if (error?.name === "AbortError" || error?.name === "TimeoutError") return "timeout";
  if (Object.hasOwn(REASONS, error?.kind)) return error.kind;
  // Classify only; raw errors, paths, credentials and stack traces never leave this function.
  if (/HTTP \d{3}/.test(String(error?.message))) return "upstream";
  return "internal";
}
export function toolFailure(kind: ErrorKind, reason?: string, nextAction?: string): ToolFailure {
  const [reason_text, action] = REASONS[kind];
  return { ok: false, unavailable: true, error_kind: kind, reason: reason ?? reason_text,
    reason_text, next_action: nextAction || action, retryable: !NO_RETRY.has(kind) };
}
function normalize(result: any, name: string): any {
  if (result !== null && result !== undefined && result.ok !== false && !result.unavailable && !result.error && result.accepted !== false) return result;
  const key = result?.error_kind ?? result?.reason;
  const kind: ErrorKind = Object.hasOwn(REASONS, key) ? key : ALIASES[key] ?? (result?.error ? "upstream" : name === "get_project" ? "not_synced" : "unknown");
  // Repo next actions come from our local constructors; a search response is untrusted data.
  const action = /^repo_(?:changes|commit|file)$/.test(name) && typeof result?.next_action === "string" ? redact(result.next_action).slice(0, 500) : undefined;
  return { ...toolFailure(kind, undefined, action),
    ...(name === "read_web" && READ_REASONS.includes(key) ? { reason: key, reason_text: webFailText(key as ReadReason) } : {}),
    ...(Array.isArray(result?.candidates) ? { candidates: result.candidates.map((v: any) => redact(String(v)).slice(0, 100)).slice(0, 50) } : {}) };
}
function signature(name: string, args: any): string {
  const stable = (x: any): any => Array.isArray(x) ? x.map(stable) : x && typeof x === "object"
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
  return name + ":" + JSON.stringify(stable(args));
}
type RecoveryState = { seen?: string[]; failure?: ToolFailure; switches?: number; alternatives?: number };
export class ToolRecovery {
  private seen: Set<string>;
  private failure?: ToolFailure;
  private switches: number;
  private alternatives: number;
  constructor(state: RecoveryState = {}) {
    this.seen = new Set(state.seen || []); this.failure = state.failure; this.switches = state.switches || 0;
    this.alternatives = state.alternatives || 0;
  }
  state(): RecoveryState { return { seen: [...this.seen], failure: this.failure, switches: this.switches, alternatives: this.alternatives }; }
  get retrying() { return this.switches > 0; }
  /** A prompt is a recovery attempt, never an unbounded retry of the same operation. */
  retry(messages: any[]): boolean {
    if (!this.failure?.retryable || this.switches >= 2 || this.alternatives >= 2) return false;
    this.switches++;
    messages.push({ role: "system", content: "换一条路：" + this.failure.next_action + "。使用不同工具或不同参数；不能重复相同调用，不能越过授权或访问限制。" });
    return true;
  }
  brief(facts: any): any {
    return this.failure ? { summary: facts, failure: this.failure.reason_text, next_action: this.failure.next_action,
      instruction: "最终回复必须说明失败原因和下一步，不得只说没拿到，也不能虚报成功。" } : facts;
  }
  voice(raw: string): string {
    if (!this.failure) return raw;
    const v = JSON.parse(raw);
    const suffix = this.failure.reason_text + "；下一步：" + this.failure.next_action + "。";
    if (!String(v.text).includes(this.failure.reason_text) || !String(v.text).includes(this.failure.next_action)) {
      v.text = String(v.text || "").replace(/(?:没拿到|未能获得资料)[^。\n]*[。]?/g, "").trim();
      v.text = (v.text ? v.text + "\n" : "") + suffix;
    }
    return JSON.stringify(v);
  }
  async run(e: any, context: any, call: any, offered: boolean, execute: (args: any) => Promise<any>): Promise<any> {
    const started = Date.now(), name = String(call.function?.name || "unknown");
    let result: any, args: any;
    try {
      try { args = JSON.parse(call.function.arguments); } catch { throw { kind: "invalid_args" }; }
      if (!args || typeof args !== "object" || Array.isArray(args)) throw { kind: "invalid_args" };
      if (!offered) throw { kind: name.startsWith("repo_") && context.switches?.["off:repo_tools"] === "1" ? "denied" : "budget" };
      const key = signature(name, args);
      if (this.seen.has(key)) result = toolFailure("duplicate");
      else if (this.failure && this.alternatives >= 2) result = this.failure;
      else {
        if (this.failure) this.alternatives++;
        this.seen.add(key); result = normalize(await execute(args), name);
      }
    } catch (error) {
      result = toolFailure(kindOf(error), error instanceof AuthorizationError || error instanceof ResourceLimitError ? error.message : undefined);
    }
    this.failure = result?.ok === false ? result : undefined;
    try {
      // Existing redact runs before clipping, so a boundary cannot leave part of a credential behind.
      const safe = redact(JSON.stringify(args ?? {})).slice(0, 200);
      const row = [crypto.randomUUID(), context.latest?.id || e.timingTurn || "unknown", context.latest?.group_id ?? null,
        name, safe, result?.ok === false ? 0 : 1, result?.error_kind ?? null, Math.max(0, Date.now() - started), offered ? 1 : 0, started];
      if (e.tail) (e.tail.toolAudits ??= []).push(row);
      else await writeAudits(e, [row]);
    } catch { /* Observability must not turn a successful operation into a failed reply. */ }
    return result;
  }
}

async function writeAudits(e: any, rows: any[][]): Promise<void> {
  // 10 bindings per row, at most 90 per D1 statement. Flush after sending, before optional metrics.
  for (let i = 0; i < rows.length; i += 9) {
    const batch = rows.slice(i, i + 9);
    await e.DB.prepare("INSERT INTO turn_tools(id,turn_id,group_id,name,args,ok,error_kind,ms,offered,created_at) VALUES" + batch.map(() => "(?,?,?,?,?,?,?,?,?,?)").join(","))
      .bind(...batch.flat()).run();
  }
}
export async function flushAuditedTail(e: any): Promise<void> {
  const rows = e.tail?.toolAudits?.splice(0) || [];
  try { await writeAudits(e, rows); } catch { /* Audit failure never blocks a reply or queue acknowledgement. */ }
  await flushTail(e);
}

/** Called only by the existing job catch; enqueue through the normal idempotent outbox. */
export async function notifyJobFailure(e: any, job: any, error: unknown): Promise<void> {
  if (job.attempts < 3 || ["dream", "scout", "ci", "sync"].includes(job.kind)) return;
  const p = JSON.parse(job.payload);
  let message = p.latestId || p.message || p.source_id || p.messages?.[0]?.id;
  if (!message && p.task) message = (await e.DB.prepare("SELECT source_id FROM tasks WHERE id=?").bind(p.task).first())?.source_id;
  if (!message) return;
  const source = await e.DB.prepare("SELECT id,group_id FROM messages WHERE id=?").bind(message).first();
  if (!source) return; // Never send a failure to a global/default group.
  const failure = toolFailure(kindOf(error));
  await enqueueVoice(e, "job-failed-" + job.id, source.group_id, source.id, JSON.stringify({ mode: "work",
    text: "这件事没做成：" + failure.reason_text + "；我下一步能做的是：" + failure.next_action + "。" }));
}
