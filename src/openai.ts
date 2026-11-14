// LOCAL TEST STUB for F8-0 src/openai.ts. Not committed: F8-0 lands the real module.
export type OpenAiFail = {
  ok: false;
  error_kind:
    | "refused"
    | "budget"
    | "quota"
    | "timeout"
    | "upstream"
    | "auth"
    | "unsupported"
    | "denied";
  retryable: boolean;
  status?: number;
  reason_text: string;
  next_action: string;
};
export type OpenAiOk<T = any> = {
  ok: true;
  json: T;
  latency_ms: number;
  status: number;
};

export async function callOpenAi<T = any>(
  e: any,
  o: {
    purpose: "image_gen" | "vision" | "judge" | "other";
    path: string;
    body: any;
    timeoutMs: number;
    group?: string;
    sender?: string;
    model: string;
    estCostMicroUsd?: number;
  },
): Promise<OpenAiOk<T> | OpenAiFail> {
  const key = e?.OPENAI_API_KEY;
  const started = Date.now();
  if (!key)
    return {
      ok: false,
      error_kind: "auth",
      retryable: false,
      reason_text: "未配置 OPENAI_API_KEY",
      next_action: "联系管理员检查 OPENAI_API_KEY",
    };
  try {
    const response = await fetch("https://api.openai.com" + o.path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + key,
      },
      body: JSON.stringify(o.body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      const kind =
        response.status === 401 || response.status === 403
          ? "auth"
          : response.status === 429
            ? "quota"
            : "upstream";
      return {
        ok: false,
        error_kind: kind,
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
        reason_text: "OpenAI 返回 HTTP " + response.status,
        next_action:
          kind === "auth"
            ? "联系管理员检查 OPENAI_API_KEY"
            : "稍后再试",
      };
    }
    return {
      ok: true,
      json: JSON.parse(text) as T,
      latency_ms: Date.now() - started,
      status: response.status,
    };
  } catch (error: any) {
    const timeout =
      error?.name === "TimeoutError" || error?.name === "AbortError";
    return {
      ok: false,
      error_kind: timeout ? "timeout" : "upstream",
      retryable: true,
      reason_text: timeout ? "OpenAI 超时" : "OpenAI 请求失败",
      next_action: "稍后再试",
    };
  }
}
