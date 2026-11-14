// Model boundary for DeepSeek: chat, tools and the application APIs. Image and sandbox calls live in draw.ts.
import type { Env } from "./util.ts";
import { PRICE, flashUsage, meter } from "./meter.ts";

export type Effort = "none" | "low" | "high" | "max";
export type ChatResult = { message: any; usage: any; ms: number; annotations?: any[] };

const DS = "https://api.deepseek.com";

export async function dsChat(
  env: Env,
  body: { messages: any[]; tools?: any[]; max_tokens?: number; model?: string; label?: string },
  effort: Effort = "none",
  timeoutMs = 60000,
): Promise<ChatResult> {
  const started = Date.now();
  const r = await fetch(DS + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: body.model || env.CHAT_MODEL || "deepseek-flash",
      messages: body.messages,
      ...(body.tools?.length ? { tools: body.tools } : {}),
      max_tokens: body.max_tokens ?? 1200,
      ...(effort === "none"
        ? { thinking: { type: "disabled" } }
        : { thinking: { type: "enabled" }, reasoning_effort: effort }),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error("model http " + r.status + " " + (await r.text()).slice(0, 300));
  const data: any = await r.json();
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("model returned no message");
  meter({ provider: "deepseek", item: body.label || "聊天", ...flashUsage(data.usage) });
  return { message, usage: data.usage || {}, ms: Date.now() - started };
}

/** DeepSeek application APIs that take JSON: search, fetch, tts. */
export async function dsJson(env: Env, path: string, body: any, timeoutMs = 25000) {
  const r = await fetch(DS + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (r.ok) {
    if (path.endsWith("/search")) meter({ provider: "deepseek", item: "联网搜索", units: 1, unit: "次", usd: PRICE.dsSearch });
    else if (path.endsWith("/fetch")) meter({ provider: "deepseek", item: "网页抓取", units: 1, unit: "次", usd: PRICE.dsFetch });
    else if (path.endsWith("/tts")) {
      const text = String(body?.text || ""), chars = text.length + (text.match(/[\u4e00-\u9fff]/g) || []).length;   // a Chinese character is billed as two
      meter({ provider: "deepseek", item: "语音合成", units: chars, unit: "计费字符", usd: chars / 10000 * PRICE.dsTtsPer10k });
    }
  }
  return r;
}

export async function dsBalance(env: Env) {
  const r = await fetch(DS + "/user/balance", {
    headers: { Authorization: "Bearer " + env.DEEPSEEK_API_KEY },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error("balance http " + r.status);
  return r.json();
}
