// Every paid call reports what it used here. The Hub adds the entries up per day, so the bot can say
// what its chatting, drawing and code runs cost. Prices are the published list prices and the amounts
// are estimates; the DeepSeek balance is the real figure they are checked against.
export type Use = {
  provider: "deepseek" | "openai"; item: string;
  inTok?: number; cachedTok?: number; outTok?: number;
  units?: number; unit?: string; usd: number;
};

let sink: ((u: Use) => void) | null = null;
export const setMeter = (fn: (u: Use) => void) => { sink = fn; };
export const meter = (u: Use) => { try { sink?.(u); } catch {} };

/** DeepSeek charges double on Beijing weekdays 09:00–12:00 and 14:00–18:00. */
export function isPeak(ts: number) {
  const bj = new Date(ts + 8 * 3600000), day = bj.getUTCDay(), hour = bj.getUTCHours();
  return day >= 1 && day <= 5 && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18));
}

// USD per token / per unit. Sources: DeepSeek "Models & Pricing" (2026-11) and OpenAI's pricing page (2026-11).
export const PRICE = {
  flash: { hit: 0.003e-6, miss: 0.15e-6, out: 0.6e-6 },        // off-peak; peak is double
  dsSearch: 0.00075, dsFetch: 0.00075, dsOcrPage: 0.000225, dsTtsPer10k: 0.225,
  image: { textIn: 5e-6, imageIn: 8e-6, imageOut: 30e-6 },      // gpt-image-2.5 standard
  code: { in: 1e-6, cached: 0.05e-6, out: 5e-6, container: 0.03 }, // gpt-6.1-terra + one sandbox session
  transcribePerMinute: 0.003,                                    // gpt-4o-mini-transcribe, approximate
  /** DeepSeek bills this account in CNY; its CNY list prices are the USD ones times 20/3. */
  dsCnyPerUsd: 20 / 3,
};

export function flashUsage(usage: any, now = Date.now()) {
  const inTok = Number(usage?.prompt_tokens || 0);
  const cachedTok = Number(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? 0);
  const outTok = Number(usage?.completion_tokens || 0);
  const tools = usage?.server_tool_use || {};
  const k = isPeak(now) ? 2 : 1;
  const usd = k * (cachedTok * PRICE.flash.hit + Math.max(0, inTok - cachedTok) * PRICE.flash.miss + outTok * PRICE.flash.out) +
    (Number(tools.tool_search || 0) + Number(tools.tool_image_search || 0)) * PRICE.dsSearch + Number(tools.tool_fetch || 0) * PRICE.dsFetch;
  return { inTok, cachedTok, outTok, usd };
}
