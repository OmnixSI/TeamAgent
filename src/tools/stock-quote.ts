// F9-1 stock quote: Tencent's public quote/search endpoints over plain HTTP, read-only.
// The symbol mapping and the quote field layout are adapted from Agent-Reach
// channels/xueqiu.py:130-158 and :291-330 (github.com/Panniantong/Agent-Reach at
// c70ae6da5d39bc90e09ad2ae0575ccc89f31e284, MIT, Copyright (c) 2025 Agent Eyes;
// see NOTICE). Rewritten for this repo's BotTool contract: Worker-side fetch,
// 15 s cache, structured error_kind. No Xueqiu session, cookies or community posts.
import type { BotTool, ToolCtx } from "../toolkit";
import { redact } from "../runtime";

export const STOCK_QUOTE_HELP =
  "查沪深北、港股、美股的最新行情（来源：腾讯行情，只读）；给代码或中文名都行，回答时带上报价时间。";

const QUOTE_URL = "https://qt.gtimg.cn/q=";
const SEARCH_URL = "https://smartbox.gtimg.cn/s3/?v=2&q=";
const SOURCE = "腾讯行情";
const CONTENT_SCOPE = "quote";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_MS = 15_000;
const MAX_CACHE_ENTRIES = 200;
const MAX_SYMBOL_CHARS = 32;
const MAX_BODY_BYTES = 256 * 1024;
const ANSWER_RULE =
  "回答时写明「来源：腾讯行情」和报价时间（交易所当地时间）；只能说返回里的数字，涨跌原因、社区讨论和盘后预测都不要编。";

type FetchLike = typeof fetch;

export interface StockQuoteDeps {
  fetch?: FetchLike;
  /** test seam: fixed clock also makes the 15 s cache deterministic */
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

interface SearchHit {
  code: string;
  name: string;
  type: string;
}

interface CachedQuote {
  at: number;
  payload: any;
}

class QuoteError extends Error {
  kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

/**
 * SH600519 / 600519 / sh600519 → sh600519; 00700 / HK00700 → hk00700;
 * AAPL / us.AAPL → usAAPL. Chinese names return null and go to smartbox.
 * The A-share prefix rule follows Agent-Reach: 920 → bj, 6/9 → sh, 4/8 → bj,
 * everything else → sz; 1–5 digit numbers are Hong Kong codes.
 */
export function normalizeTencentCode(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > MAX_SYMBOL_CHARS) return null;
  const s = raw.toUpperCase();
  if (/^(SH|SZ|BJ)\d{6}$/.test(s)) return s.toLowerCase();
  if (/^HK\d{1,5}$/.test(s)) return "hk" + s.slice(2).padStart(5, "0");
  if (/^US\.[A-Z][A-Z.\-]{0,9}$/.test(s)) return "us" + s.slice(3);
  if (/^\d{6}$/.test(s)) {
    if (s.startsWith("920")) return "bj" + s;
    const prefix = "69".includes(s[0]) ? "sh" : "48".includes(s[0]) ? "bj" : "sz";
    return prefix + s;
  }
  if (/^\d{1,5}$/.test(s)) return "hk" + s.padStart(5, "0");
  if (/^[A-Z][A-Z.\-]{0,9}$/.test(s)) return "us" + s;
  return null;
}

function codeFromSearch(market: string, code: string): string | null {
  const m = String(market || "").toLowerCase();
  const c = String(code || "").trim();
  if (m === "us") {
    const base = c.replace(/\.(oq|n|ps|am)$/i, "").toUpperCase();
    return /^[A-Z][A-Z.\-]{0,9}$/.test(base) ? "us" + base : null;
  }
  if (!/^\d{1,6}$/.test(c)) return null;
  if (m === "hk") return "hk" + c.padStart(5, "0");
  if (m === "sh" || m === "sz" || m === "bj") return c.length === 6 ? m + c : null;
  return null;
}

function decodeUnicodeEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(parseInt(hex, 16)),
  );
}

/** smartbox returns `v_hint="sh~600519~\u8d35...~gzmt~GP-A^..."`; Chinese is escaped. */
function parseSmartbox(body: string): SearchHit[] {
  const match = /v_hint="([^"]*)"/.exec(body);
  if (!match) return [];
  const raw = decodeUnicodeEscapes(match[1]);
  if (!raw || raw === "N") return [];
  const hits: SearchHit[] = [];
  for (const entry of raw.split("^")) {
    const parts = entry.split("~");
    if (parts.length < 3) continue;
    const code = codeFromSearch(parts[0], parts[1]);
    const name = String(parts[2] || "").trim();
    if (!code || !name) continue;
    hits.push({ code, name, type: String(parts[4] || "").trim().toUpperCase() });
  }
  return hits;
}

/** Prefer listed stocks (GP, GP-A) over indexes/funds; an exact name wins first. */
function pickSearchHit(hits: SearchHit[], query: string): SearchHit | null {
  if (!hits.length) return null;
  const stocks = hits.filter((hit) => hit.type.startsWith("GP"));
  const pool = stocks.length ? stocks : hits;
  return pool.find((hit) => hit.name === query) || pool[0];
}

function num(value: string | undefined): number | null {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : null;
}

function normalizeQuoteTime(value: string | undefined): string | null {
  const s = String(value || "").trim();
  let m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  m = /^(\d{4})[/-](\d{2})[/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
  return s || null;
}

async function readText(response: Response, encoding: string): Promise<string> {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new QuoteError("upstream_unavailable");
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > MAX_BODY_BYTES) throw new QuoteError("upstream_unavailable");
  return new TextDecoder(encoding).decode(buffer);
}

function failure(
  input: string,
  code: string | null,
  kind: string,
  reason: string,
  nextAction: string,
): any {
  return {
    tool: "stock_quote",
    symbol: input,
    ...(code ? { code } : {}),
    ok: false,
    error_kind: kind,
    retryable: kind === "upstream_unavailable" || kind === "rate_limited" || kind === "timeout",
    reason_text: reason,
    next_action: nextAction,
  };
}

const NEXT: Record<string, string> = {
  not_found:
    "确认交易所前缀或换一个名称；找不到就直接告诉成员没有这只股票，不要猜价格或涨跌。",
  upstream_unavailable:
    "腾讯行情暂时不可达，如实告诉成员这次没拿到行情，不要编价格；稍后可以再试一次。",
  rate_limited: "腾讯行情限流了，告诉成员稍后再试，不要连续重试或换接口硬刷。",
  timeout: "请求超时，如实告诉成员这次没拿到行情，不要编价格；可以稍后重试一次。",
};

export function createStockQuoteTool(deps: StockQuoteDeps = {}): BotTool {
  const doFetch: FetchLike = deps.fetch || ((input, init) => fetch(input, init));
  const now = deps.now || (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_MS;
  const cache = new Map<string, CachedQuote>();

  async function search(query: string, signal: AbortSignal): Promise<SearchHit | null> {
    try {
      const response = await doFetch(SEARCH_URL + encodeURIComponent(query) + "&t=all", {
        signal,
        headers: { Accept: "text/plain,*/*" },
      });
      if (response.status === 429) throw new QuoteError("rate_limited");
      if (!response.ok) throw new QuoteError("upstream_unavailable");
      const body = await readText(response, "utf-8");
      return pickSearchHit(parseSmartbox(body), query);
    } catch (error) {
      if (signal.aborted) throw new QuoteError("timeout");
      throw error;
    }
  }

  async function quote(code: string, signal: AbortSignal): Promise<any> {
    try {
      const response = await doFetch(QUOTE_URL + code, {
        signal,
        headers: { Accept: "text/plain,*/*" },
      });
      if (response.status === 429) throw new QuoteError("rate_limited");
      if (!response.ok) throw new QuoteError("upstream_unavailable");
      const body = await readText(response, "gbk");
      if (/v_pv_none_match\s*=/.test(body)) throw new QuoteError("not_found");
      const match = /v_[a-zA-Z0-9_]+="([^"]*)"/.exec(body);
      if (!match) throw new QuoteError("upstream_unavailable");
      const f = match[1].split("~");
      if (f.length < 35) throw new QuoteError("upstream_unavailable");
      const price = num(f[3]);
      if (!f[1] || !f[2] || price === null) throw new QuoteError("upstream_unavailable");
      return {
        ok: true,
        tool: "stock_quote",
        name: f[1].trim(),
        code,
        price,
        change: num(f[31]),
        change_pct: num(f[32]),
        open: num(f[5]),
        prev_close: num(f[4]),
        high: num(f[33]),
        low: num(f[34]),
        quote_time: normalizeQuoteTime(f[30]),
        source: SOURCE,
        content_scope: CONTENT_SCOPE,
        answer_rule: ANSWER_RULE,
      };
    } catch (error) {
      if (signal.aborted) throw new QuoteError("timeout");
      throw error;
    }
  }

  return {
    name: "stock_quote",
    switch: "stock_quote",
    untrusted: true,
    def: {
      type: "function",
      function: {
        name: "stock_quote",
        description:
          STOCK_QUOTE_HELP +
          " 返回最新价、涨跌额、涨跌幅、今开/昨收/最高/最低和报价时间；只查行情，不读雪球社区帖子，也不需要登录。",
        parameters: {
          type: "object",
          properties: {
            symbol: {
              type: "string",
              description: "股票代码或中文名，例如 SH600519、600519、00700、AAPL、us.AAPL、茅台、英伟达",
            },
          },
          required: ["symbol"],
        },
      },
    },
    async run(_e: any, args: any, _ctx: ToolCtx) {
      const input = redact(String(args?.symbol ?? ""))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_SYMBOL_CHARS);
      if (!input) {
        return failure(
          input,
          null,
          "unsupported",
          "没有给股票代码或名称",
          "向成员要一个股票代码或中文名，例如 SH600519、00700、AAPL、茅台。",
        );
      }

      let code = normalizeTencentCode(input);
      try {
        if (!code) {
          const hit = await search(input, AbortSignal.timeout(timeoutMs));
          if (!hit) {
            return failure(
              input,
              null,
              "not_found",
              `没有找到「${input}」对应的股票`,
              NEXT.not_found,
            );
          }
          code = hit.code;
        }

        const cached = cache.get(code);
        if (cached && now() - cached.at < cacheTtlMs) return cached.payload;

        const payload = await quote(code, AbortSignal.timeout(timeoutMs));
        if (cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = cache.keys().next().value;
          if (oldest) cache.delete(oldest);
        }
        cache.set(code, { at: now(), payload });
        return payload;
      } catch (error) {
        const kind = error instanceof QuoteError ? error.kind : "upstream_unavailable";
        const reason =
          kind === "not_found"
            ? `腾讯行情没有「${input}」这只股票`
            : kind === "rate_limited"
              ? "腾讯行情限流"
              : kind === "timeout"
                ? "腾讯行情请求超时"
                : "腾讯行情暂时不可用";
        return failure(input, code, kind, reason, NEXT[kind] || NEXT.upstream_unavailable);
      }
    },
  };
}

export const stockQuoteTool = createStockQuoteTool();
