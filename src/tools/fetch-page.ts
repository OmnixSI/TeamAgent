// F9DS-4 fetch_page: read one public page as Markdown through the DeepSeek fetch
// API (POST /v1/tools/fetch). Bilibili/X links must keep using their dedicated
// readers; internal, credential-bearing and QQ-internal addresses never leave
// the Worker. The body is capped at 6000 characters and the same internal
// function is the last fallback in semantic.ts readUrl().
import type { BotTool, ToolCtx } from "../toolkit";

const MAX_URL_CHARS = 8192;
const MAX_CONTENT_CHARS = 6000;
const CALL_TIMEOUT_MS = 15_000;
const EST_COST_MICRO_USD = 750; // $0.75 / 1000 requests

export const FETCH_PAGE_HELP =
  "fetch_page：抓取公开网页正文（Markdown，最多 6000 字，超长标 truncated）；B 站/X 链接走专用读取，内网、localhost、带账号密码的地址和 QQ 内部链接不抓。";

type DsFailShape = {
  ok: false;
  error_kind: string;
  retryable?: boolean;
  status?: number;
  reason_text?: string;
  next_action?: string;
};

export interface FetchPageDeps {
  callDsTool?: (e: any, o: any) => Promise<any>;
  dsGuard?: (e: any, o: any) => Promise<any>;
}

export interface FetchPageOptions {
  timeoutMs?: number;
  group?: string;
  sender?: string;
  deps?: FetchPageDeps;
}

export type FetchPageResult =
  | {
      ok: true;
      tool: "fetch_page";
      url: string;
      title: string;
      content: string;
      chars: number;
      original_chars?: number;
      truncated: boolean;
      note?: string;
      source: "deepseek_fetch";
      latency_ms: number | null;
    }
  | {
      ok: false;
      tool: "fetch_page";
      url: string;
      error_kind: string;
      retryable: boolean;
      status?: number;
      reason_text: string;
      next_action: string;
    };

export type UrlCheck =
  | { ok: true; url: string }
  | { ok: false; error_kind: "unsupported" | "too_large"; retryable: false; reason_text: string; next_action: string };

let dsModule: Promise<any> | null = null;
const defaultCall = async (e: any, o: any) => (await (dsModule ||= import("../deepseek-tools"))).callDsTool(e, o);
const defaultGuard = async (e: any, o: any) => (await (dsModule ||= import("../deepseek-tools"))).dsGuard(e, o);

function reject(kind: "unsupported" | "too_large", reason: string, next: string): UrlCheck {
  return { ok: false, error_kind: kind, retryable: false, reason_text: reason, next_action: next };
}

function privateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

/** B 站、X/Twitter 和 QQ 内部链接各有专用链路；fetch_page 不碰它们。 */
function specialLink(host: string): { name: string } | null {
  if (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv" || host === "bili2233.cn") {
    return { name: "B 站" };
  }
  if (["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"].includes(host)) {
    return { name: "X/Twitter" };
  }
  if (host === "qq.com" || host.endsWith(".qq.com") || host === "url.cn") {
    return { name: "QQ 内部" };
  }
  return null;
}

/** 8192 上限、仅 http/https、拒绝 localhost/内网/IP 字面量私网段/凭据 URL/B 站/X/QQ。 */
export function validateFetchUrl(value: unknown): UrlCheck {
  const raw = String(value ?? "").trim();
  if (!raw) return reject("unsupported", "链接是空的，只支持 http/https 公开网页", "向成员要一个公开网页链接。");
  if (raw.length > MAX_URL_CHARS) {
    return reject("too_large", `链接超过 ${MAX_URL_CHARS} 个字符，只支持公开网页`, "让成员直接给出页面标题或更短的链接。");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject("unsupported", "链接格式不对，只支持 http/https 公开网页", "让成员发完整链接。");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return reject("unsupported", "只支持 http/https 公开网页", "换一个公开网页链接。");
  }
  if (url.username || url.password) {
    return reject("unsupported", "带账号密码的链接不抓取，只支持公开网页", "去掉链接里的账号密码，或换公开来源。");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host || host.startsWith("[") || host.includes(":")) {
    return reject("unsupported", "IP 字面量地址不抓取，只支持公开网页域名", "换公开域名链接。");
  }
  const special = specialLink(host);
  if (special) {
    return reject(
      "unsupported",
      `${special.name}链接不走网页抓取`,
      "这类链接走专用读取：B 站视频由视频读取链路处理，X/Twitter 走专用读取。",
    );
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return reject("unsupported", "内网或本机地址不抓取，只支持公开网页", "换公开网页链接。");
  }
  if (privateIPv4(host) || /^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host) || /(^|\.)0x[0-9a-f]+(\.|$)/i.test(host)) {
    return reject("unsupported", "内网或本机地址不抓取，只支持公开网页", "换公开网页链接。");
  }
  return { ok: true, url: url.toString() };
}

function failure(url: string, failed: DsFailShape | null | undefined): FetchPageResult {
  const kind = failed?.error_kind || "upstream";
  const status = typeof failed?.status === "number" ? failed.status : undefined;
  const allowed = failed?.retryable === true;
  if (status === 403) {
    return {
      ok: false,
      tool: "fetch_page",
      url,
      error_kind: "denied",
      retryable: false,
      status,
      reason_text: "站点不允许抓取（403 URL access denied）",
      next_action: "告诉成员这个站点不允许抓取，不要重试。",
    };
  }
  return {
    ok: false,
    tool: "fetch_page",
    url,
    error_kind: kind,
    retryable: allowed,
    ...(status !== undefined ? { status } : {}),
    reason_text: String(failed?.reason_text || "抓取失败"),
    next_action: String(failed?.next_action || "稍后再试；持续失败就告诉成员现在读不到这个页面。"),
  };
}

export async function fetchPageCore(e: any, rawUrl: unknown, opt: FetchPageOptions = {}): Promise<FetchPageResult> {
  const checked = validateFetchUrl(rawUrl);
  if (!checked.ok) {
    return {
      ok: false,
      tool: "fetch_page",
      url: String(rawUrl ?? "").trim(),
      error_kind: checked.error_kind,
      retryable: false,
      reason_text: checked.reason_text,
      next_action: checked.next_action,
    };
  }
  const url = checked.url;
  const callDsTool = opt.deps?.callDsTool || defaultCall;
  const dsGuard = opt.deps?.dsGuard || defaultGuard;
  const group = String(opt.group || "");
  const sender = String(opt.sender || "");
  let guard: any = null;
  if (group || sender) {
    guard = await dsGuard(e, { purpose: "fetch", group, sender });
    if (!guard || guard.ok !== true) return failure(url, guard);
  }
  try {
    const response = await callDsTool(e, {
      purpose: "fetch",
      json: { url },
      timeoutMs: opt.timeoutMs ?? CALL_TIMEOUT_MS,
      ...(group ? { group } : {}),
      ...(sender ? { sender } : {}),
      estCostMicroUsd: EST_COST_MICRO_USD,
    });
    if (!response || response.ok !== true) return failure(url, response);
    const data = response.data || {};
    const title = String(data.title ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
    const body = String(data.content ?? data.markdown ?? data.text ?? "");
    if (!body.trim()) {
      return {
        ok: false,
        tool: "fetch_page",
        url,
        error_kind: "empty",
        retryable: false,
        reason_text: "页面打开了，但没有可读正文（可能只有图片/视频，或要登录后才显示）",
        next_action: "如实告诉成员这个页面没有可读正文，不要编造内容。",
      };
    }
    const chars = Array.from(body);
    if (chars.length < 1500) {
      if (/just a moment|checking your browser|verify (?:you are|that you are) human|captcha challenge/i.test(body)) {
        return {
          ok: false,
          tool: "fetch_page",
          url,
          error_kind: "refused",
          retryable: false,
          reason_text: "页面是风控验证页，没有可读正文",
          next_action: "如实告诉成员这个页面被风控拦截，不要编造内容。",
        };
      }
      if (/sign in to (?:continue|read|view)|log in to (?:continue|read|view)|please (?:sign|log) in|请先登录|登录后(?:继续|查看|阅读)/i.test(body)) {
        return {
          ok: false,
          tool: "fetch_page",
          url,
          error_kind: "denied",
          retryable: false,
          reason_text: "页面需要登录后才有正文",
          next_action: "如实告诉成员这个页面要登录才能看，不要编造内容。",
        };
      }
    }
    const truncated = chars.length > MAX_CONTENT_CHARS || data.truncated === true;
    const content = truncated ? chars.slice(0, MAX_CONTENT_CHARS).join("") : body;
    return {
      ok: true,
      tool: "fetch_page",
      url,
      title,
      content,
      chars: Array.from(content).length,
      ...(truncated ? { original_chars: chars.length } : {}),
      truncated,
      ...(truncated ? { note: `正文超过 ${MAX_CONTENT_CHARS} 字，已截断；只依据截断后的内容回答。` } : {}),
      source: "deepseek_fetch",
      latency_ms: typeof response.latency_ms === "number" ? response.latency_ms : null,
    };
  } catch {
    return {
      ok: false,
      tool: "fetch_page",
      url,
      error_kind: "upstream",
      retryable: true,
      reason_text: "抓取服务调用异常",
      next_action: "稍后再试；持续失败就告诉成员现在读不到这个页面，不要编造内容。",
    };
  } finally {
    if (guard) {
      try {
        await guard.release?.();
      } catch {}
    }
  }
}

function groupOf(ctx: ToolCtx): string {
  const c: any = ctx?.context || {};
  const direct = c.group_id ?? c.groupId;
  if (direct) return String(direct);
  const rows = [c.latest, ...(c.batch || []), ...(c.recent || []), ctx?.source];
  for (const row of rows) {
    const id = row?.group_id ?? row?.groupId;
    if (id) return String(id);
  }
  return "";
}

function senderOf(ctx: ToolCtx): string {
  const rows = [ctx?.source, ...(ctx?.context?.batch || []), ctx?.context?.latest];
  for (const row of rows) {
    const id = row?.sender ?? row?.sender_id ?? row?.user_id;
    if (id) return String(id);
  }
  return "";
}

export function createFetchPageTool(deps: FetchPageDeps = {}): BotTool {
  return {
    name: "fetch_page",
    untrusted: true,
    def: {
      type: "function",
      function: {
        name: "fetch_page",
        description:
          "抓取公开网页正文（Markdown，最多 6000 字，超长标 truncated）。只支持 http/https 公开页面；B 站视频（bilibili.com/b23.tv）、X/Twitter 链接不走本工具（这类链接走专用读取）；内网、localhost、带账号密码的地址和 QQ 内部链接会被拒绝。回答时引用来源 url。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要读取的公开网页链接（最多 8192 字符）" },
          },
          required: ["url"],
        },
      },
    },
    async run(e: any, args: any, ctx: ToolCtx) {
      return fetchPageCore(e, args?.url, { group: groupOf(ctx), sender: senderOf(ctx), deps });
    },
  };
}

export const fetchPageTool: BotTool = createFetchPageTool();
