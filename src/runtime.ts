/** Credentials are never prompt material, query strings, metrics or activity records. */
export function redact(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[密钥已隐藏]")
    .replace(
      /\b(?:gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,})\b/g,
      "[凭据已隐藏]",
    )
    .replace(
      /((?:API[_ -]?KEY|Authorization|密码|验证码|access_token|clientSecret)\s*[=:：]\s*)["']?[^\s,"'\n}]+/gi,
      "$1[已隐藏]",
    );
}
export function promptData(data: any) {
  return JSON.parse(redact(JSON.stringify(data)));
}
export function utilityText(value: any) {
  const text = redact(String(value || ""));
  if (/timed out|Traceback|Command \[|--permission-mode/.test(text))
    return "这份资料处理超时或工具中断，原始输入与已有成果保留在开发台，需要成员接手。";
  return text.replace(/\/Users\/[^\s\"'`<>，。\n]+/g, "[本机文件]");
}
export async function activity(
  e: any,
  kind: string,
  entity: string,
  actor: string,
  summary: string,
  id: string = crypto.randomUUID(),
) {
  await e.DB.prepare("INSERT OR IGNORE INTO activity VALUES(?,?,?,?,?,?)")
    .bind(
      id,
      kind,
      entity,
      actor,
      redact(summary).slice(0, 1000),
      new Date().toISOString(),
    )
    .run();
}
/** A single instrumented model boundary for routing, voice, plans and memory. */
export async function model(
  e: any,
  kind: string,
  effort: "high" | "max",
  body: any,
  timeout = 90000,
) {
  const start = Date.now();
  let usage: any = {},
    status = "failed";
  try {
    const r = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + e.DEEPSEEK_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...promptData(body),
        model: e.MODEL || "deepseek-flash",
        reasoning_effort: effort,
      }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) {
      status = "http_" + r.status;
      throw Error("模型请求失败（" + r.status + "）");
    }
    const data: any = await r.json();
    usage = data.usage || {};
    if (
      !data.choices?.[0]?.message ||
      data.choices[0].finish_reason === "length"
    )
      throw Error("模型未完成输出");
    status = "ok";
    return data;
  } finally {
    if (e.DB)
      await e.DB.batch([
        e.DB.prepare("INSERT INTO model_runs VALUES(?,?,?,?,?,?,?,?)").bind(
          crypto.randomUUID(),
          kind,
          effort,
          status,
          Date.now() - start,
          Number(usage.prompt_tokens || 0),
          Number(usage.completion_tokens || 0),
          start,
        ),
        e.DB.prepare(
          "INSERT INTO model_usage VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(hour,kind,effort,status) DO UPDATE SET n=n+1,input_tokens=input_tokens+excluded.input_tokens,output_tokens=output_tokens+excluded.output_tokens,duration_ms=duration_ms+excluded.duration_ms",
        ).bind(
          Math.floor(start / 3600000) * 3600000,
          kind,
          effort,
          status,
          Number(usage.prompt_tokens || 0),
          Number(usage.completion_tokens || 0),
          Date.now() - start,
        ),
      ]);
  }
}
