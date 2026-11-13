/** C2 capability layer: what this turn can do, why a tool failed, what to say next. */
import { AuthorizationError } from "./authz";
import { ResourceLimitError } from "./d1";

export type ErrorKind =
  | "unauthorized"
  | "budget"
  | "timeout"
  | "not_found"
  | "ambiguous"
  | "invalid_args"
  | "denied"
  | "stale_index"
  | "not_synced"
  | "runner_offline"
  | "runner_unsupported"
  | "upstream"
  | "risk"
  | "unknown"
  | "duplicate";

/** Existing repo/github callers still pass these narrower kinds. */
export type FailureKind = ErrorKind | "needs_token" | "rate_limited" | "too_large" | "binary";

export type ToolFailure = {
  ok: false;
  tool: string;
  error_kind: string;
  retryable: boolean;
  next_action: string;
  tried?: string;
  detail?: string;
};

/** One sentence per kind, written for the model to turn into plain language. */
export const NEXT_ACTION: Record<ErrorKind, string> = {
  unauthorized: "请交办人用自己的话直接 @我说清要做什么",
  budget: "这一轮额度用完了，稍后再问或我转后台继续",
  timeout: "来源太慢，换个更具体的问法或稍后重试",
  not_found: "已查范围里没有（仓库索引只含最近 90 天）；说明查了哪里，问对方要更准的名字或编号",
  ambiguous: "匹配到多个，请给更完整的编号或名字",
  invalid_args: "参数不对，按正确格式再问",
  denied: "这是受保护内容，不提供",
  stale_index: "资料是 N 分钟前的，说明时间照常回答",
  not_synced: "本机同步端还没上报过这个仓库，需要本机 runner 在线",
  runner_offline: "本机执行端不在线，上线后可以重试",
  runner_unsupported: "本机执行端版本旧，需要更新",
  upstream: "外部服务失败，可以换来源再试",
  risk: "平台风控，需要在本机登录页重新登录后再试",
  unknown: "记下来交给开发排查",
  duplicate: "这条已经处理过，不重复执行",
};

const LEGACY_ACTION: Record<string, string> = {
  needs_token: "这是私有仓库，需要管理员配置 GitHub 只读 token",
  rate_limited: "GitHub 限流，稍后再问",
  too_large: "太大，请给更具体的 path 或行号",
  binary: "二进制或 LFS 文件，不展示内容",
};

const RETRYABLE = new Set<string>(["budget", "timeout", "runner_offline", "upstream"]);

export function redactPatch(s: string, preserveLines = false): string {
  // Scan delimiter tokens once; repeated unclosed BEGIN headers stay linear.
  const markers = /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/g;
  let start = -1, cursor = 0;
  const safe: string[] = [];
  for (const match of s.matchAll(markers)) {
    if (match[0].startsWith("-----BEGIN")) { if (start < 0) start = match.index; }
    else if (start >= 0) {
      const end = match.index + match[0].length;
      safe.push(s.slice(cursor, start), "[REDACTED]", preserveLines ? "\n".repeat(s.slice(start, end).split("\n").length - 1) : "");
      cursor = end; start = -1;
    }
  }
  if (start >= 0) {
    safe.push(s.slice(cursor, start), "[REDACTED]", preserveLines ? "\n".repeat(s.slice(start).split("\n").length - 1) : "");
    cursor = s.length;
  }
  return (safe.join("") + s.slice(cursor))
    .replace(/(\bAuthorization["']?[\t ]*:[\t ]*["']?Bearer[\t ]+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|(?:SESSDATA|bili_jct|DedeUserID__ckMd5|auth_token|ct0)=[^;\s]+/g, "[REDACTED]")
    // Only complete standard base64 runs >=128 characters (96 decoded bytes)
    // with upper/lowercase letters and digits, avoiding plain identifiers.
    // Keep short examples and surrounding code intact; scan each run just once.
    .replace(/[A-Za-z0-9+/_-]+={0,2}/g, value => value.length >= 128 && value.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /[0-9]/.test(value) ? "[REDACTED]" : value);
}

function kindOf(err: unknown): ErrorKind | undefined {
  if (err instanceof AuthorizationError) return "unauthorized";
  if (err instanceof ResourceLimitError) return "budget";
  const name = (err as any)?.name;
  if (name === "AbortError" || typeof name === "string" && /timeout/i.test(name)) return "timeout";
  return undefined;
}

export function toolFailure(
  name: string,
  err: unknown,
  extra: { kind?: FailureKind | (string & {}); tried?: string; detail?: string } = {},
): ToolFailure {
  const kind = kindOf(err) ?? extra.kind ?? "upstream";
  return {
    ok: false,
    tool: name,
    error_kind: kind,
    retryable: RETRYABLE.has(kind),
    next_action: NEXT_ACTION[kind as ErrorKind] || LEGACY_ACTION[kind] || NEXT_ACTION.upstream,
    ...(extra.tried ? { tried: extra.tried } : {}),
    ...(extra.detail ? { detail: redactPatch(extra.detail).slice(0, 120) } : {}),
  };
}

const CARD_MAX = 600;
const CARD_BOUNDARY = "不能直接改仓库、合并、发布、改密钥、替人对外发消息。写代码要成员原话交办，经开发任务走 PR。合并和发布由交付员或 owner 做。";
const CARD_NO_TOOLS = "本轮已不能再调用工具，基于已有结果回答，缺什么就写缺什么。";
const CARD_THREE_KINDS = "回答分三类说：查到的（带提交号、文件或链接）、推断的（标我猜）、没核实的（写差什么）。";

function firstSentence(text: string): string {
  const end = text.indexOf("。");
  return (end < 0 ? text : text.slice(0, end)).trim();
}

function clip(text: string, size: number): string {
  const chars = [...text];
  if (chars.length <= size) return chars.join("");
  return chars.slice(0, Math.max(1, size - 1)).join("") + "…";
}

/** Pure, D1-free: one card per model call, rewritten from the tools actually offered. */
export function capabilityCard(tools: any[], opts: { toolsOffered: boolean }): string {
  const offered = !!opts?.toolsOffered;
  const entries = (Array.isArray(tools) ? tools : [])
    .map((t: any) => ({
      name: String(t?.function?.name || ""),
      desc: firstSentence(String(t?.function?.description || "")),
    }))
    .filter((entry) => entry.name);
  const tail = [CARD_BOUNDARY, ...(offered ? [] : [CARD_NO_TOOLS]), CARD_THREE_KINDS];
  const header = entries.length ? "这一轮实际提供的工具：" : (offered ? "这一轮没有工具可调用。" : "");
  const compose = (rows: string[]) => [header, ...rows, ...tail].filter(Boolean).join("\n");
  const full = compose(entries.map((entry) => entry.name + "：" + entry.desc));
  if (full.length <= CARD_MAX) return full;
  for (const size of [36, 24, 16, 10, 6]) {
    const shortened = compose(entries.map((entry) => entry.name + "：" + clip(entry.desc, size)));
    if (shortened.length <= CARD_MAX) return shortened;
  }
  for (let keep = entries.length - 1; keep > 0; keep--) {
    const rows = entries.slice(0, keep).map((entry) => entry.name + "：" + clip(entry.desc, 10));
    rows.push("（另有 " + (entries.length - keep) + " 个工具见工具表）");
    const cut = compose(rows);
    if (cut.length <= CARD_MAX) return cut;
  }
  const minimal = compose([entries[0].name + "：" + clip(entries[0].desc, 6), "（其余 " + (entries.length - 1) + " 个工具见工具表）"]);
  return minimal.length <= CARD_MAX ? minimal : minimal.slice(0, CARD_MAX);
}
