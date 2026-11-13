import { adjust, refund, reserve } from "./budget";

/**
 * Workers AI neuron holds, one table.
 * Source (checked 2026-11-14, TeamAgent-cf-paid-plan-20261114.md [AI-P]):
 *   @cf/meta/llama-3.1-8b-instruct-fp8-fast: 4,119 neurons/M input, 34,868/M output tokens.
 *   @cf/meta/llama-3.2-11b-vision-instruct: 61,493 neurons/M output tokens;
 *   one image is ≈1,100 input tokens plus up to 400 output tokens.
 * The CF-AI order/audit §3 uses a 35-neuron hold per image and ≈200 per 70B call.
 * Holds are rounded up, given back when the call fails, and corrected from
 * `usage` when the binding returns it. Never drops below the verified rates.
 */
export const AI_NEURON_RATES = {
  vision: { input: 4119, output: 61493, hold: 35 },
  "text-small": { input: 4119, output: 34868, hold: 0 },
  "text-large": { input: 0, output: 0, hold: 200 },
} as const;

export const AI_NEURONS_BUDGET = "workers_ai_neurons";
/** Daily ceiling; 10k free neurons/day, so stop at 8k and leave headroom. */
export const AI_NEURONS_DAILY_CAP = 8000;
/** Runtime override; also loaded once per turn with the switch snapshot. */
export const AI_NEURONS_CAP_SETTING = "workers_ai:neurons_cap";

export type AiModelKind = keyof typeof AI_NEURON_RATES;

export function modelKind(model: string): AiModelKind {
  const name = String(model || "").toLowerCase();
  if (/vision/.test(name)) return "vision";
  if (/70b|34b|32b|reasoning|large/.test(name)) return "text-large";
  return "text-small";
}

function promptTokens(body: any): number {
  return Math.max(1, Math.ceil(JSON.stringify(body ?? {}).length / 4));
}

/** Conservative hold charged before the call. */
export function estimateNeurons(model: string, body: any): number {
  const kind = modelKind(model);
  const rate = AI_NEURON_RATES[kind];
  if (rate.hold > 0) return rate.hold;
  const out = Math.max(1, Number(body?.max_tokens || 300));
  return Math.max(
    1,
    Math.ceil((promptTokens(body) * rate.input + out * rate.output) / 1_000_000),
  );
}

/** Actual neurons from the binding's usage, or null when it cannot be priced. */
export function actualNeurons(model: string, usage: any): number | null {
  const exact = Number(usage?.neurons);
  if (Number.isFinite(exact) && exact > 0) return Math.ceil(exact);
  const input = Number(usage?.prompt_tokens || 0);
  const output = Number(usage?.completion_tokens || 0);
  if (!Number.isFinite(input) || !Number.isFinite(output)) return null;
  if (!input && !output) return null;
  const kind = modelKind(model);
  // No verified 70B rates: keep the conservative hold instead of guessing.
  if (kind === "text-large") return null;
  const rate = AI_NEURON_RATES[kind];
  return Math.max(
    1,
    Math.ceil((input * rate.input + output * rate.output) / 1_000_000),
  );
}

export async function aiNeuronsCap(e: any): Promise<number> {
  if (typeof e.aiNeuronsCap === "number") return e.aiNeuronsCap;
  let raw: any = e.switches?.[AI_NEURONS_CAP_SETTING];
  if (raw === undefined || raw === null) {
    try {
      raw = (
        await e.DB.prepare("SELECT value FROM settings WHERE key=?")
          .bind(AI_NEURONS_CAP_SETTING)
          .first()
      )?.value;
    } catch {
      raw = undefined;
    }
  }
  const n = Number(raw);
  const cap =
    raw !== undefined && raw !== null && String(raw) !== "" && Number.isFinite(n) && n >= 0
      ? Math.floor(n)
      : AI_NEURONS_DAILY_CAP;
  e.aiNeuronsCap = cap;
  return cap;
}

/** Budget rejection with the reason the vision chain already understands. */
export class WorkersAiBudgetFault extends Error {
  readonly reason = "provider_cap";
  constructor() {
    super("workers_ai_neurons");
  }
}

/**
 * The single wrapper for `env.AI.run`: hold, call, correct.
 * Over budget it throws before touching the binding, so callers can fall back.
 */
export async function runWorkersAi<T = any>(
  e: any,
  model: string,
  body: any,
): Promise<T> {
  if (typeof e.AI?.run !== "function") throw new Error("AI binding unavailable");
  // DB-less callers are the owner smoke path (`DB: undefined`), which must not
  // write production counters; it also has nowhere to keep a hold.
  if (!e.DB) return e.AI.run(model, body) as Promise<T>;
  const at = Date.now();
  const hold = estimateNeurons(model, body);
  const cap = await aiNeuronsCap(e);
  if (!(await reserve(e, AI_NEURONS_BUDGET, hold, cap, at))) throw new WorkersAiBudgetFault();
  let result: any;
  try {
    result = await e.AI.run(model, body);
  } catch (error) {
    await refund(e, AI_NEURONS_BUDGET, hold, at).catch(() => {});
    throw error;
  }
  const actual = actualNeurons(model, result?.usage);
  if (actual !== null) await adjust(e, AI_NEURONS_BUDGET, actual - hold, at).catch(() => {});
  return result as T;
}
