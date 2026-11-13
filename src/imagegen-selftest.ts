/**
 * Owner-only, read-only smoke check for the image generation path.
 * Calls OpenAI through the shared channel with DB removed, so the smoke
 * never writes usage rows or image logs.  At most two calls per hour.
 */
import { callOpenAi } from "./openai";

const HOUR_MS = 3_600_000;
const MAX_PER_HOUR = 2;
const DEFAULT_MODEL = "gpt-image-1";
const SMOKE_PROMPT =
  "A single flat red circle centered on a plain white background, minimal icon, no text.";
const calls = new Map<number, number>();

const reply = (body: any, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function modelFor(e: any): Promise<string> {
  try {
    const row = await e.DB.prepare(
      "SELECT value FROM settings WHERE key='imagegen:model'",
    ).first();
    return row?.value || DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/** Read width/height from a JPEG SOF marker. Returns null when not a JPEG. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  let i = 2;
  while (i + 8 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    const sof =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (sof)
      return {
        height: (bytes[i + 5] << 8) | bytes[i + 6],
        width: (bytes[i + 7] << 8) | bytes[i + 8],
      };
    i += 2 + length;
  }
  return null;
}

export async function imagegenSelftest(e: any, who: any): Promise<Response> {
  if (who?.role !== "owner") return reply({ error: "owner only" }, 403);
  const hour = Math.floor(Date.now() / HOUR_MS);
  const used = calls.get(hour) || 0;
  if (used >= MAX_PER_HOUR)
    return reply(
      {
        ok: false,
        error_kind: "quota",
        next_action: "自检每小时最多 2 次，请下一个小时再试",
      },
      429,
    );
  for (const key of calls.keys()) if (key < hour - 1) calls.delete(key);
  calls.set(hour, used + 1);

  const model = await modelFor(e);
  const result = await callOpenAi({ ...e, DB: undefined }, {
    purpose: "image_gen",
    path: "/v1/images/generations",
    body: {
      model,
      prompt: SMOKE_PROMPT,
      n: 1,
      size: "1024x1024",
      quality: "low",
      output_format: "jpeg",
      output_compression: 80,
    },
    timeoutMs: 100_000,
    model,
    estCostMicroUsd: 11_000,
  });
  if (!result.ok)
    return reply(
      { ok: false, error_kind: result.error_kind, next_action: result.next_action },
      502,
    );

  try {
    const b64 = result.json?.data?.[0]?.b64_json;
    if (!b64) throw new Error("missing b64_json");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const size = jpegSize(bytes);
    if (!size) throw new Error("not a jpeg");
    return reply({
      ok: true,
      latency_ms: result.latency_ms,
      bytes: bytes.length,
      width: size.width,
      height: size.height,
      model,
    });
  } catch {
    return reply(
      {
        ok: false,
        error_kind: "upstream",
        next_action: "返回里没有可解析的 JPEG 图片，检查模型输出格式",
      },
      502,
    );
  }
}
