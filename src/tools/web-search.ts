// F9DS-4 web_search: general web search through the DeepSeek search API
// (POST /v1/tools/search). Unlike news_search (a recent-news timeline over RSS),
// this covers arbitrary pages; every result carries its source url so the reply
// can cite it. Results are external material: the registry marks the tool
// untrusted and semantic.ts wraps the JSON in the 外部资料·不可信 envelope.
import type { BotTool, ToolCtx } from "../toolkit";
import { redact } from "../runtime";

const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const MAX_QUERY_CHARS = 128;
const CALL_TIMEOUT_MS = 10_000;
const EST_COST_MICRO_USD = 750; // $0.75 / 1000 requests
const ANSWER_RULE =
  "回答时逐条给出结果的 url 和站点（date 有就带上），只引用 results 里出现的标题、摘要、日期和链接；没有结果就直说没搜到，不得编造链接、日期或标题。";
const CITATION_RULE = "每条结果都带来源 url；回答里引用哪条就写哪条的 url。";

export const WEB_SEARCH_HELP =
  "web_search：通用网页搜索，返回 title/url/snippet/summary/date/site，回答须逐条引用 url；与 news_search 的区别是 news_search 查最近 N 小时的新闻时间线，web_search 查任意网页资料。";

type DsFailShape = {
  ok: false;
  error_kind: string;
  retryable?: boolean;
  status?: number;
  reason_text?: string;
  next_action?: string;
};

export interface WebSearchDeps {
  callDsTool?: (e: any, o: any) => Promise<any>;
  dsGuard?: (e: any, o: any) => Promise<any>;
}

let dsModule: Promise<any> | null = null;
const defaultCall = async (e: any, o: any) => (await (dsModule ||= import("../deepseek-tools"))).callDsTool(e, o);
const defaultGuard = async (e: any, o: any) => (await (dsModule ||= import("../deepseek-tools"))).dsGuard(e, o);

function clip(value: unknown, max: number): string {
  return Array.from(String(value ?? "")).slice(0, max).join("");
}

function clean(value: unknown, max: number): string {
  return clip(
    String(value ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    max,
  );
}

function httpUrl(value: unknown): string {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function hostOf(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function dateOf(value: unknown): string | null {
  const raw = clean(value, 40);
  return raw || null;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 群和成员只从本轮上下文取，模型参数不能指定。 */
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

const OPERATORS: Array<[string, string]> = [
  ["site", "site"],
  ["lang", "lang"],
  ["after", "after"],
  ["before", "before"],
];

/** site:/lang:/after:/before: 属于查询串本身；结构化的同名参数只在缺操作符时追加。 */
function buildQuery(query: string, args: any): string {
  let out = query;
  for (const [argName] of OPERATORS) {
    const value = clean(args?.[argName], 200);
    if (!value) continue;
    if (out.toLowerCase().includes(argName + ":")) continue;
    out += ` ${argName}:${value.replace(/\s+/g, "")}`;
  }
  return out;
}

function normalize(item: any): { title: string; url: string; snippet: string | null; summary: string | null; date: string | null; site: string } | null {
  const url = httpUrl(item?.url);
  if (!url) return null;
  const title = clean(item?.title, 300);
  if (!title) return null;
  return {
    title,
    url,
    snippet: clean(item?.snippet ?? item?.description, 500) || null,
    summary: clean(item?.summary, 500) || null,
    date: dateOf(item?.date ?? item?.published_at ?? item?.published),
    site: clean(item?.site_name ?? item?.site, 80) || hostOf(url),
  };
}

export function createWebSearchTool(deps: WebSearchDeps = {}): BotTool {
  const callDsTool = deps.callDsTool || defaultCall;
  const dsGuard = deps.dsGuard || defaultGuard;

  return {
    name: "web_search",
    untrusted: true,
    def: {
      type: "function",
      function: {
        name: "web_search",
        description:
          "通用网页搜索，每条结果都带来源 url。与 news_search 的区别：news_search 查最近 N 小时的新闻时间线，web_search 查任意网页资料。支持 site:/lang:/after:/before: 检索语法，最多返回 10 条。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索词（最多 128 字，超长会截断并说明）；可直接写 site:/lang:/after:/before: 操作符" },
            count: { type: "integer", minimum: 1, maximum: 10, description: "返回条数，默认 5，最多 10" },
            site: { type: "string", description: "可选：只搜某个站点，等价于 query 里写 site:" },
            lang: { type: "string", description: "可选：语言，等价于 query 里写 lang:" },
            after: { type: "string", description: "可选：起始日期，等价于 query 里写 after:" },
            before: { type: "string", description: "可选：截止日期，等价于 query 里写 before:" },
          },
          required: ["query"],
        },
      },
    },
    async run(e: any, args: any, ctx: ToolCtx) {
      const raw = redact(String(args?.query ?? "")).replace(/\s+/g, " ").trim();
      const base = { tool: "web_search", query: raw };
      if (!raw) {
        return {
          ...base,
          ok: false,
          error_kind: "bad_query",
          retryable: false,
          reason_text: "搜索词是空的",
          next_action: "向成员要一个具体的搜索词再查，不要用空查询。",
        };
      }
      const built = buildQuery(raw, args);
      const chars = Array.from(built);
      const queryTruncated = chars.length > MAX_QUERY_CHARS;
      const query = (queryTruncated ? chars.slice(0, MAX_QUERY_CHARS) : chars).join("");
      const count = clampInt(args?.count, 1, MAX_COUNT, DEFAULT_COUNT);
      const group = groupOf(ctx);
      const sender = senderOf(ctx);
      const resultBase = { ...base, query };

      const guard = await dsGuard(e, { purpose: "search", group, sender });
      if (!guard || guard.ok !== true) {
        const failed = (guard || {}) as DsFailShape;
        return {
          ...resultBase,
          ok: false,
          error_kind: failed.error_kind || "quota",
          retryable: failed.retryable === true,
          ...(typeof failed.status === "number" ? { status: failed.status } : {}),
          reason_text: String(failed.reason_text || "搜索额度或开关不允许这次调用"),
          next_action: String(failed.next_action || "告诉成员当前不能搜索，不要重试。"),
        };
      }
      try {
        const response = await callDsTool(e, {
          purpose: "search",
          json: { query, count },
          timeoutMs: CALL_TIMEOUT_MS,
          group,
          sender,
          estCostMicroUsd: EST_COST_MICRO_USD,
        });
        if (!response || response.ok !== true) {
          const failed = (response || {}) as DsFailShape;
          return {
            ...resultBase,
            ok: false,
            error_kind: failed.error_kind || "upstream",
            retryable: failed.retryable === true,
            ...(typeof failed.status === "number" ? { status: failed.status } : {}),
            reason_text: String(failed.reason_text || "搜索失败"),
            next_action: String(failed.next_action || "稍后再试；持续失败就告诉成员现在查不到。"),
          };
        }
        const rows = Array.isArray(response.data?.results) ? response.data.results : [];
        const results = rows.map(normalize).filter(Boolean).slice(0, count);
        const notes: string[] = [];
        if (queryTruncated) notes.push("搜索词超过 128 字，已截断后检索。");
        if (results.length === 0) notes.push("没有搜到结果，直接告诉成员没搜到。");
        return {
          ...resultBase,
          ok: true,
          count,
          empty: results.length === 0,
          results,
          citation_required: true,
          citation_rule: CITATION_RULE,
          answer_rule: ANSWER_RULE,
          source: "deepseek_search",
          latency_ms: typeof response.latency_ms === "number" ? response.latency_ms : null,
          ...(queryTruncated ? { query_truncated: true } : {}),
          ...(notes.length ? { note: notes.join(" ") } : {}),
        };
      } catch {
        return {
          ...resultBase,
          ok: false,
          error_kind: "upstream",
          retryable: true,
          reason_text: "搜索服务调用异常",
          next_action: "稍后再试；持续失败就告诉成员现在查不到，不要编造结果。",
        };
      } finally {
        try {
          await guard.release?.();
        } catch {}
      }
    },
  };
}

export const webSearchTool: BotTool = createWebSearchTool();
