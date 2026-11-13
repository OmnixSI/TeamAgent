import type { JudgeResult } from "./types";
import type { JudgeMessage } from "./prompt";

type Usage = { neurons?: number; prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number };
export type JudgeUsage = { neurons: number; prompt_tokens: number; completion_tokens: number; attempts: number };
export type JudgeProvider = "deepseek" | "workers-ai" | "openai-luna" | "codex-offline";
export type JudgeReservation = { account: string; utcDay: string; neurons: number; cap: number; provider: JudgeProvider; model: string };
export type JudgeLedger = {
  /** Implement atomically in the orchestrator's account/day ledger. This module never writes storage. */
  reserve(request: JudgeReservation): Promise<boolean>;
  settle(request: JudgeReservation & { used: number; uncertain: boolean }): Promise<void>;
};
export type JudgeModelOptions = {
  cap: number; spentNeurons?: number; model?: string; deepseekModel?: string;
  maxTokens?: number; timeoutMs?: number; fetch?: typeof fetch;
  provider?: JudgeProvider; fallbackProvider?: JudgeProvider | null;
  offline?: (input: { messages: JudgeMessage[]; model: string; max_tokens: number }) => Promise<unknown>;
  account?: string; ledger?: JudgeLedger; now?: () => number;
  /** D-0 may override the conservative per-token rates for a different model. */
  neuronRates?: { input: number; output: number };
};
type JudgeEnv = { AI?: { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  DEEPSEEK_API_KEY?: string; OPENAI_API_KEY?: string; OPENAI_MODEL?: string; REVIEW_JUDGE_PROVIDER?: JudgeProvider };
const RATES = { input: 0.031818, output: 0.068182 }; // gpt-oss-120b; Cloudflare pricing, 2026-11-14.
function nonnegative(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw Error("invalid neuron accounting");
  return n;
}
/** Explicit neurons win; otherwise tokens, then a conservative one-char/one-token estimate. */
export function neuronsOf(usage: Usage | number, rates = RATES): number {
  if (typeof usage === "number") return Math.ceil(nonnegative(usage) * Math.max(nonnegative(rates.input), nonnegative(rates.output)));
  if (usage.neurons !== undefined) return nonnegative(usage.neurons);
  return Math.ceil(nonnegative(usage.prompt_tokens ?? usage.input_tokens ?? 0) * nonnegative(rates.input) +
    nonnegative(usage.completion_tokens ?? usage.output_tokens ?? 0) * nonnegative(rates.output));
}
function resultObject(value: unknown): value is JudgeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return r.schema === "ta.review.result.v1" && [r.verdicts, r.requirements, r.memory_updates, r.promises, r.no_action].every(Array.isArray);
}
export class JudgeModelError extends Error {
  constructor(public code: "judge_failed" | "judge_budget", public usage: JudgeUsage) { super(code); }
}

/** Independent model boundary. Only the two review messages cross it; never import chat runtime. */
export async function judgeModel(e: JudgeEnv, messages: readonly JudgeMessage[], opts: JudgeModelOptions): Promise<{
  json: JudgeResult; usage: JudgeUsage; model: string; same_family: 0 | 1;
}> {
  if (!Number.isFinite(opts.cap) || opts.cap <= 0 || opts.cap > 7000) throw Error("invalid review cap");
  const spent = nonnegative(opts.spentNeurons ?? 0), rates = opts.neuronRates ?? RATES;
  const maxTokens = opts.maxTokens ?? 4096;
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw Error("invalid review maxTokens");
  const timeoutMs = opts.timeoutMs ?? 90000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 180000) throw Error("invalid review timeoutMs");
  // Copy a strict two-message envelope: no inherited extra fields, tools or prior conversation.
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user" ||
    messages.some(m => typeof m.content !== "string") || messages.reduce((n, m) => n + m.content.length, 0) > 24000) throw Error("invalid review messages");
  const isolated = messages.map(({ role, content }) => ({ role, content }));
  const inputEstimate = new TextEncoder().encode(JSON.stringify(isolated)).length;
  const reserve = neuronsOf({ prompt_tokens: inputEstimate, completion_tokens: maxTokens }, rates);
  const usage: JudgeUsage = { neurons: 0, prompt_tokens: 0, completion_tokens: 0, attempts: 0 };
  const fail = (code: "judge_failed" | "judge_budget"): never => { throw new JudgeModelError(code, { ...usage }); };
  const selected = opts.provider ?? e.REVIEW_JUDGE_PROVIDER ?? "workers-ai";
  const providers: JudgeProvider[] = [selected];
  const fallback = opts.fallbackProvider === undefined ? selected === "workers-ai" && e.DEEPSEEK_API_KEY ? "deepseek" : null : opts.fallbackProvider;
  if (fallback && fallback !== selected) providers.push(fallback);
  if (providers.some(p => !["deepseek", "workers-ai", "openai-luna", "codex-offline"].includes(p))) throw Error("invalid review provider");
  const modelFor = (p: JudgeProvider) => p === "workers-ai" ? (selected === p ? opts.model : undefined) ?? "@cf/openai/gpt-oss-120b" :
    p === "deepseek" ? opts.deepseekModel ?? (selected === p ? opts.model : undefined) ?? "deepseek-flash" :
    p === "openai-luna" ? opts.model ?? e.OPENAI_MODEL ?? "" : opts.model ?? "codex-offline";
  const budget = async (provider: JudgeProvider, model: string): Promise<JudgeReservation> => {
    if (spent + usage.neurons + reserve > opts.cap) fail("judge_budget");
    const request = { account: opts.account ?? provider, utcDay: new Date((opts.now ?? Date.now)()).toISOString().slice(0, 10),
      neurons: reserve, cap: opts.cap, provider, model };
    if (opts.ledger && !await opts.ledger.reserve(request)) fail("judge_budget");
    return request;
  };
  const account = async (request: JudgeReservation, raw?: Usage, uncertain = false) => {
    usage.attempts++;
    let used = reserve;
    try {
      // Missing fields may hide reasoning tokens. Reserve the full requested output, not just visible JSON.
      used = neuronsOf(raw?.neurons !== undefined ? raw : {
        prompt_tokens: raw?.prompt_tokens ?? raw?.input_tokens ?? inputEstimate,
        completion_tokens: raw?.completion_tokens ?? raw?.output_tokens ?? maxTokens }, rates);
      usage.neurons += used;
      usage.prompt_tokens += nonnegative(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
      usage.completion_tokens += nonnegative(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
    } catch {
      usage.neurons += reserve; uncertain = true;
      if (opts.ledger) await opts.ledger.settle({ ...request, used: reserve, uncertain: true });
      fail("judge_failed");
    }
    if (opts.ledger) await opts.ledger.settle({ ...request, used, uncertain });
  };
  const bounded = async <T>(call: () => Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve().then(call), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(Error("review_model_timeout")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  };
  const parse = (content: unknown): JudgeResult | undefined => {
    try { const value = typeof content === "string" ? JSON.parse(content) : content; return resultObject(value) ? value : undefined; }
    catch { return undefined; }
  };
  const call = async (provider: JudgeProvider, model: string, structured: boolean): Promise<any> => {
    if (provider === "workers-ai") {
      if (!e.AI) throw Error("review_provider_unavailable");
      return e.AI.run(model, { messages: isolated, max_tokens: maxTokens,
        ...(structured ? { response_format: { type: "json_object" } } : {}) });
    }
    if (provider === "codex-offline") {
      if (!opts.offline) throw Error("review_offline_adapter_required");
      return opts.offline({ messages: isolated, model, max_tokens: maxTokens });
    }
    const key = provider === "deepseek" ? e.DEEPSEEK_API_KEY : e.OPENAI_API_KEY;
    if (!key || !model) throw Error("review_provider_unavailable");
    const r = await (opts.fetch ?? fetch)(provider === "deepseek" ? "https://api.deepseek.com/chat/completions" : "https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: isolated, stream: false,
        ...(structured ? { response_format: { type: "json_object" } } : {}),
        ...(provider === "deepseek" ? { max_tokens: maxTokens } : { max_completion_tokens: maxTokens }) }),
      signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw Error("review_provider_http_" + r.status);
    return r.json();
  };
  let malformed = 0;
  for (const provider of providers) {
    let structured = true;
    const model = modelFor(provider);
    for (;;) {
      const reservation = await budget(provider, model);
      let response: any;
      try {
        response = await bounded(() => call(provider, model, structured));
      } catch (error) {
        await account(reservation, undefined, true); // Unknown timeout/service errors retain the full reservation.
        const unsupported = /response_format/i.test(String(error)) && /not support|unsupported|not allowed|unknown (field|parameter)/i.test(String(error));
        if (structured && unsupported) { structured = false; continue; }
        break;
      }
      const content = response?.response ?? response?.choices?.[0]?.message?.content ?? response;
      await account(reservation, response?.usage);
      if (response?.finish_reason === "length" || Array.isArray(response?.choices) && response.choices.some((c: any) => c?.finish_reason === "length") || response?.status === "incomplete") fail("judge_failed");
      const json = parse(content);
      if (json) return { json, usage, model, same_family: provider === "deepseek" || /deepseek/i.test(model) ? 1 : 0 };
      if (malformed++ >= 1) fail("judge_failed");
    }
  }
  return fail("judge_failed");
}
