// F7-12 news search: free Google News RSS first, Bing News RSS second, then the existing
// DeepSeek search API as a general fallback. RSS text is external, untrusted material: the
// registry marks this tool untrusted and semantic.ts wraps every result in the material envelope.
// No new dependency: the two RSS feeds are parsed with a small, deliberate XML item reader.
import type { BotTool, ToolCtx } from "../toolkit";
import { redact } from "../runtime";

const GOOGLE_NEWS = "https://news.google.com/rss/search";
const BING_NEWS = "https://www.bing.com/news/search";
const DEEPSEEK_SEARCH = "https://api.deepseek.com/v1/tools/search";
const HOUR = 3600_000;
const CLOCK_SKEW = 5 * 60_000;
const MAX_CALLS_PER_TURN = 2;
const MAX_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_CACHE_MS = 10 * 60_000;
const ANSWER_RULE =
  "回答时逐条给出结果的 url 和发布时间，并说明来源；只能引用 results 里出现的标题、时间和链接，没有结果就直说没有，不得编造新闻、日期或链接。";

type FetchLike = typeof fetch;

export interface NewsSearchDeps {
  fetch?: FetchLike;
  /** test seam: a fixed clock also makes the 24h window deterministic */
  now?: () => number;
  timeoutMs?: number;
  maxBytes?: number;
  cacheTtlMs?: number;
}

interface FeedItem {
  title: string;
  url: string;
  published_at: string | null;
  date_known: boolean;
  source: string;
  source_url?: string;
}

class ChannelError extends Error {
  kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeXml(value: string): string {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => {
      try {
        return String.fromCodePoint(parseInt(hex, 16));
      } catch {
        return "";
      }
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      try {
        return String.fromCodePoint(Number(dec));
      } catch {
        return "";
      }
    })
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name] ?? "");
}

function text(value: string): string {
  return decodeXml(value).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function pickTag(block: string, name: string): string {
  const match = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"),
  );
  return match ? text(match[1]) : "";
}

function httpUrl(value: string): string {
  try {
    const url = new URL(value);
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

/** RSS 2.0 item reader. Returns null when the body is not a feed (error pages often arrive as HTML). */
function parseRss(xml: string): Array<{ title: string; url: string; published: number; source: string; source_url: string }> | null {
  if (!/<rss(?:\s[^>]*)?>/i.test(xml) || !/<channel(?:\s[^>]*)?>/i.test(xml)) return null;
  const out: Array<{ title: string; url: string; published: number; source: string; source_url: string }> = [];
  for (const raw of xml.split(/<item(?:\s[^>]*)?>/i).slice(1)) {
    const block = raw.split(/<\/item>/i)[0];
    if (!block) continue;
    const title = pickTag(block, "title");
    const url = httpUrl(pickTag(block, "link"));
    const published = Date.parse(pickTag(block, "pubDate"));
    if (!title || !url || !Number.isFinite(published)) continue;
    const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
    const sourceUrl = sourceMatch ? httpUrl((sourceMatch[1].match(/url\s*=\s*"([^"]*)"/i) || [])[1] || "") : "";
    out.push({
      title,
      url,
      published,
      source: sourceMatch ? text(sourceMatch[2]) : "",
      source_url: sourceUrl,
    });
  }
  return out;
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string | null> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ChannelError("too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new ChannelError("too_large");
      }
      chunks.push(value);
    }
    if (signal.aborted) throw new ChannelError("timeout");
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  } catch (error) {
    if (signal.aborted) throw new ChannelError("timeout");
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function completedNewsCalls(messages: any[]): number {
  const names = new Map<string, string>();
  const done = new Set<string>();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (call?.id) names.set(String(call.id), String(call?.function?.name || ""));
      }
    } else if (message?.role === "tool" && message.tool_call_id) {
      done.add(String(message.tool_call_id));
    }
  }
  let count = 0;
  for (const [id, name] of names) if (name === "news_search" && done.has(id)) count++;
  return count;
}

export function createNewsSearchTool(deps: NewsSearchDeps = {}): BotTool {
  const doFetch: FetchLike = deps.fetch || ((input, init) => fetch(input, init));
  const now = deps.now || (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = deps.maxBytes ?? DEFAULT_MAX_BYTES;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_MS;
  const cache = new Map<string, { at: number; source: string; fallback: boolean; results: FeedItem[] }>();

  async function fetchFeed(
    url: string,
    signal: AbortSignal,
    redirect: RequestRedirect = "follow",
  ): Promise<FeedItem[]> {
    const response = await doFetch(url, { signal, redirect, headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!response.ok) throw new ChannelError("http");
    const body = await readCapped(response, maxBytes, signal);
    if (body === null) throw new ChannelError("too_large");
    const channel = parseRss(body);
    if (channel === null) throw new ChannelError("invalid");
    return channel.map((entry) => ({
      title: entry.title.slice(0, 300),
      url: entry.url,
      published_at: new Date(entry.published).toISOString(),
      date_known: true,
      source: (entry.source || hostOf(entry.url) || "新闻源").slice(0, 80),
      ...(entry.source_url ? { source_url: entry.source_url } : {}),
    }));
  }

  async function fetchGeneralSearch(e: any, query: string, limit: number, signal: AbortSignal): Promise<FeedItem[]> {
    if (!e?.DEEPSEEK_API_KEY) throw new ChannelError("unavailable");
    const response = await doFetch(DEEPSEEK_SEARCH, {
      method: "POST",
      headers: { Authorization: "Bearer " + e.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ query, count: limit, need_content: false }),
      signal,
    });
    if (!response.ok) throw new ChannelError("http");
    const body = await readCapped(response, maxBytes, signal);
    if (body === null) throw new ChannelError("too_large");
    let data: any;
    try {
      data = JSON.parse(body);
    } catch {
      throw new ChannelError("invalid");
    }
    const results = Array.isArray(data?.results) ? data.results : [];
    const out: FeedItem[] = [];
    for (const item of results) {
      const title = String(item?.title || "").slice(0, 300);
      const url = httpUrl(String(item?.url || ""));
      if (!title || !url) continue;
      out.push({
        title,
        url,
        published_at: null,
        date_known: false,
        source: hostOf(url) || "通用搜索",
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  return {
    name: "news_search",
    untrusted: true,
    def: {
      type: "function",
      function: {
        name: "news_search",
        description:
          "搜索最近 N 小时内的新闻和最新消息：免费新闻 RSS 优先，新闻源不可用时回退通用搜索。结果含标题、url、发布时间和来源；回答必须逐条引用 url 和发布时间，没有结果就直说没有，不得编造标题、时间或链接。每轮最多调用 2 次。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "新闻关键词，主体和主题越具体越好" },
            hours: { type: "integer", minimum: 1, maximum: 168, description: "时间窗口（小时），默认 24" },
            limit: { type: "integer", minimum: 1, maximum: 10, description: "最多返回条数，默认 10" },
          },
          required: ["query"],
        },
      },
    },
    async run(e: any, args: any, ctx: ToolCtx) {
      const query = redact(String(args?.query ?? "")).replace(/\s+/g, " ").trim().slice(0, 128);
      const base = {
        tool: "news_search",
        query,
        untrusted: true,
        fetched_at: new Date(now()).toISOString(),
      };
      if (!query) {
        return {
          ...base,
          ok: false,
          error_kind: "bad_query",
          retryable: false,
          next_action: "向成员要一个具体的新闻关键词再查，不要用空查询。",
        };
      }
      // Count finished calls in this turn: semantic.ts appends each tool result before the
      // next call starts, so two parallel calls still run in order and a third is refused.
      if (completedNewsCalls(ctx?.messages || []) >= MAX_CALLS_PER_TURN) {
        return {
          ...base,
          ok: false,
          error_kind: "rate_limited",
          retryable: false,
          next_action: "这一轮已经查过两次新闻，请直接用已有结果回答；还不够就说明缺什么。",
        };
      }

      const hours = clampInt(args?.hours, 1, 168, 24);
      const limit = clampInt(args?.limit, 1, MAX_LIMIT, MAX_LIMIT);
      const group = String(ctx?.context?.group_id || ctx?.context?.chat_id || "");
      const cacheKey = [group, query.toLowerCase(), hours, limit].join("|");
      const cached = cache.get(cacheKey);
      if (cached && now() - cached.at < cacheTtlMs) {
        return {
          ...base,
          ok: true,
          source: cached.source,
          window_hours: hours,
          count: cached.results.length,
          empty: cached.results.length === 0,
          cached: true,
          citation_required: true,
          answer_rule: ANSWER_RULE,
          results: cached.results,
          ...(cached.fallback ? { fallback: true, warning: "新闻源不可用，这是通用搜索结果（可能没有发布时间）。" } : {}),
          ...(cached.results.length === 0 ? { note: "这个时间窗内没有新闻，直接告诉成员没有，不要编造。" } : {}),
        };
      }

      const deadline = now() + timeoutMs;
      const attempts: Array<{ source: string; error_kind: string }> = [];
      const encoded = encodeURIComponent(query);
      const channels: Array<{ source: string; cap: number; load: (signal: AbortSignal) => Promise<FeedItem[]> }> = [
        {
          source: "google_news_rss",
          cap: 6000,
          load: (signal) =>
            fetchFeed(
              `${GOOGLE_NEWS}?q=${encoded}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
              signal,
            ),
        },
        {
          source: "bing_news_rss",
          cap: 3000,
          load: (signal) =>
            fetchFeed(`${BING_NEWS}?q=${encoded}&format=rss&setlang=zh-cn&cc=cn`, signal, "manual"),
        },
        {
          source: "deepseek_search",
          cap: timeoutMs,
          load: (signal) => fetchGeneralSearch(e, query, limit, signal),
        },
      ];

      for (const channel of channels) {
        const remaining = deadline - now();
        if (remaining < 20) {
          attempts.push({ source: channel.source, error_kind: "timeout" });
          continue;
        }
        const signal = AbortSignal.timeout(Math.min(channel.cap, remaining));
        try {
          const feed = await channel.load(signal);
          const cutoff = now() - hours * HOUR;
          const upper = now() + CLOCK_SKEW;
          const results = feed
            .filter((item) => item.published_at === null || (Date.parse(item.published_at) >= cutoff && Date.parse(item.published_at) <= upper))
            .sort((a, b) => (b.published_at ? Date.parse(b.published_at) : 0) - (a.published_at ? Date.parse(a.published_at) : 0))
            .slice(0, limit);
          const fallback = channel.source === "deepseek_search";
          if (cache.size >= 100) {
            const oldest = cache.keys().next().value;
            if (oldest) cache.delete(oldest);
          }
          cache.set(cacheKey, { at: now(), source: channel.source, fallback, results });
          return {
            ...base,
            ok: true,
            source: channel.source,
            window_hours: hours,
            count: results.length,
            empty: results.length === 0,
            citation_required: true,
            answer_rule: ANSWER_RULE,
            results,
            ...(fallback ? { fallback: true, warning: "新闻源不可用，这是通用搜索结果（可能没有发布时间）。" } : {}),
            ...(results.length === 0 ? { note: "这个时间窗内没有新闻，直接告诉成员没有，不要编造。" } : {}),
          };
        } catch (error) {
          attempts.push({
            source: channel.source,
            error_kind: signal.aborted ? "timeout" : error instanceof ChannelError ? error.kind : "invalid",
          });
        }
      }

      const kinds = attempts.map((a) => a.error_kind);
      const errorKind = kinds.length === 0
        ? "unavailable"
        : kinds.every((kind) => kind === "timeout")
          ? "timeout"
          : "unavailable";
      return {
        ...base,
        ok: false,
        error_kind: errorKind,
        retryable: true,
        next_action: "新闻源和通用搜索都不可用；告诉成员现在查不到最新消息，不要编造新闻、时间或链接。",
        attempts,
      };
    },
  };
}

export const newsSearchTool: BotTool = createNewsSearchTool();
