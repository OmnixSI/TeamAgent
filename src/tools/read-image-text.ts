// F9DS DS-3 read_image_text: OCR for screenshots, scans and text-heavy images in this group.
// The image bytes come from the same QQ image channel as vision.ts (host-gated, redirect-limited,
// size-capped). OCR output is checked for the #183 failure mode (finish_reason=length, >8000 chars,
// "DO ONE" runs, very low character diversity) and then falls back to the existing vision provider.
// The result is untrusted material; toolkit.ts marks this tool untrusted and semantic.ts envelopes it.
import type { BotTool, ToolCtx } from "../toolkit";
import { callDsTool, dsGuard, type DsFail } from "../deepseek-tools";
import type { ImageNote } from "../vision";

export const MAX_OCR_BYTES = 8 * 1024 * 1024;
export const MAX_OCR_CHARS = 8000;
export const RESULT_CHARS = 3000;
export const OCR_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 20_000;
const VISION_TIMEOUT_MS = 25_000;
const EST_COST_MICRO_USD = 225; // one page at $0.225 / 1,000 pages
const FALLBACK_HINT =
  "只提取图中可见文字，原样输出；不要描述人物、不要猜测；图中没有文字就返回空。";
const SUCCESS_NEXT_ACTION = "只引用识别出的文字；看不清或疑似异常就说明可能不准，不要补全。";

type VisionModule = typeof import("../vision");
type FetchImage = VisionModule["fetchImage"];
type DescribeBytes = VisionModule["describeBytes"];
type CallDs = typeof callDsTool;
type Guard = typeof dsGuard;

export interface ReadImageTextDeps {
  callDs?: CallDs;
  guard?: Guard;
  fetchImage?: FetchImage;
  describeBytes?: DescribeBytes;
}

export type ReadImageTextSuccess = {
  ok: true;
  text: string;
  via: "ocr" | "vision_fallback";
  pages: number;
  truncated: boolean;
};
export type ReadImageTextFailure = {
  ok: false;
  error_kind: string;
  retryable: boolean;
  reason_text: string;
  next_action: string;
  status?: number;
};
export type ReadImageTextResult = ReadImageTextSuccess | ReadImageTextFailure;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function fail(error_kind: string, next_action: string, reason_text: string, retryable = false): ReadImageTextFailure {
  return { ok: false, error_kind, retryable, reason_text, next_action };
}

function fromDsFailure(f: DsFail): ReadImageTextFailure {
  return {
    ok: false,
    error_kind: f.error_kind,
    retryable: f.retryable,
    reason_text: f.reason_text,
    next_action: f.next_action,
    ...(f.status === undefined ? {} : { status: f.status }),
  };
}

/** Two or more letters/digits/CJK characters count as text; punctuation-only OCR is empty. */
function hasText(value: string) {
  return (String(value || "").match(/[\p{L}\p{N}]/gu) || []).length >= 2;
}

function extensionOfMime(mime: string) {
  return (
    { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[mime] || ".img"
  );
}

function bodyError(raw: any): DsFail {
  const message = text(raw?.message || raw?.code || raw || "");
  let error_kind: DsFail["error_kind"] = "upstream";
  let reason_text = "识别服务返回错误，不能当作图片文字";
  let next_action = "请成员重发清晰截图，或把图片里的文字贴出来；不要猜。";
  if (/format|supported|unsupported/i.test(message)) {
    error_kind = "unsupported";
    reason_text = "识别服务不支持这种文件格式";
    next_action = "请成员换一张 JPG/PNG 截图或 PDF 再试，不要把文件名当文字。";
  } else if (/too large|100 mib|exceeds/i.test(message)) {
    error_kind = "too_large";
    reason_text = "图片超过识别服务的大小上限";
    next_action = "请成员压缩或截小一点再发；不要声称读过原图。";
  } else if (/risk|safety|refus/i.test(message)) {
    error_kind = "refused";
    reason_text = "识别服务拒绝了这张图片";
    next_action = "不要重试同一张图；让成员换一张或把文字贴出来。";
  }
  return { ok: false, error_kind, retryable: false, reason_text, next_action };
}

/** The #183 signature: a run of the same 4–12 character unit at least 8 times in a row. */
const CONSECUTIVE_RUN = /([\s\S]{4,12}?)\1{7,}/;

/**
 * Degenerate OCR output guard. Deliberately conservative for ordinary chat text:
 * length, consecutive runs, one fragment dominating the page, and character diversity.
 */
export function looksLikeLoop(raw: string): { loop: boolean; reason?: string } {
  const value = String(raw ?? "");
  if (!value.trim()) return { loop: false };
  if (value.length > MAX_OCR_CHARS) return { loop: true, reason: "too_long" };
  const normalized = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (CONSECUTIVE_RUN.test(normalized)) return { loop: true, reason: "repeat" };

  const compact = normalized.replace(/\s+/g, "");
  if (compact.length < 200) return { loop: false };
  const bad = (compact.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g) || []).length;
  if (bad / compact.length > 0.05) return { loop: true, reason: "invalid_chars" };
  const unique = new Set(Array.from(compact)).size;
  if (unique / compact.length < 0.002) return { loop: true, reason: "low_diversity" };

  if (compact.length >= 500) {
    const counts = new Map<string, number>();
    let max = 0;
    for (let i = 0; i + 4 <= compact.length; i++) {
      const key = compact.slice(i, i + 4);
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      if (next > max) max = next;
    }
    if (max * 4 / compact.length > 0.3) return { loop: true, reason: "dominant_fragment" };
  }
  return { loop: false };
}

function parseOcr(data: any) {
  if (data && typeof data === "object" && data.error) return { error: bodyError(data.error) };
  const pages = Array.isArray(data?.pages) ? data.pages : [];
  const body = pages.length
    ? pages.map((page: any) => (typeof page === "string" ? page : text(page?.text))).join("\n\n")
    : typeof data === "string"
      ? data
      : text(data?.text);
  const finish = pages.map((page: any) => text(page?.finish_reason)).filter(Boolean);
  if (text(data?.finish_reason)) finish.push(text(data.finish_reason));
  const pagesCount = Number(data?.page_count) || pages.length || 1;
  return { text: body, pages: Number.isFinite(pagesCount) && pagesCount > 0 ? pagesCount : 1, finish };
}

function bounded(value: string) {
  const clean = value.trim();
  return { text: clean.slice(0, RESULT_CHARS), truncated: clean.length > RESULT_CHARS };
}

/**
 * Run OCR on one image and fall back to the existing vision provider when recognition fails or
 * looks like the #183 loop. Exposed so the live script can exercise real bytes end to end.
 */
export async function extractImageText(
  e: any,
  bytes: Uint8Array,
  mime: string,
  o: { group: string; sender: string; deps?: ReadImageTextDeps },
): Promise<ReadImageTextResult> {
  const deps = o.deps || {};
  const guard = deps.guard || dsGuard;
  const callDs = deps.callDs || callDsTool;
  const describe = deps.describeBytes || (await import("../vision")).describeBytes;

  const reserved = await guard(e, { purpose: "ocr", group: o.group, sender: o.sender });
  if (!reserved.ok) return fromDsFailure(reserved);
  let ocrFailure: ReadImageTextFailure | null = null;
  try {
    if (!bytes?.byteLength) {
      ocrFailure = {
        ok: false,
        error_kind: "empty",
        retryable: false,
        reason_text: "图片内容为空",
        next_action: "让成员重发一张完整的图片。",
      };
    } else if (bytes.byteLength > MAX_OCR_BYTES) {
      ocrFailure = {
        ok: false,
        error_kind: "too_large",
        retryable: false,
        reason_text: "图片超过 8 MiB 上限",
        next_action: "让成员压缩或截小一点再发；不要声称读过这张图。",
      };
    } else {
      const form = new FormData();
      form.append("purpose", "text_recognition");
      form.append("file", new Blob([bytes as unknown as BlobPart], { type: mime }), "image" + extensionOfMime(mime));
      const result = await callDs<any>(e, {
        purpose: "ocr",
        form,
        expect: "json",
        timeoutMs: OCR_TIMEOUT_MS,
        group: o.group,
        sender: o.sender,
        estCostMicroUsd: EST_COST_MICRO_USD,
      });
      if (!result.ok) {
        ocrFailure = fromDsFailure(result);
      } else {
        const parsed = parseOcr(result.data);
        if ("error" in parsed && parsed.error) {
          ocrFailure = parsed.error;
        } else if (!hasText((parsed as any).text)) {
          ocrFailure = {
            ok: false,
            error_kind: "empty",
            retryable: true,
            reason_text: "图片里没有识别到文字",
            next_action: "换视觉模型再看一次，或让成员把文字贴出来。",
          };
        } else if ((parsed as any).finish.includes("length") || looksLikeLoop((parsed as any).text).loop) {
          ocrFailure = {
            ok: false,
            error_kind: "unreadable",
            retryable: false,
            reason_text: "文字识别疑似陷入重复/超长，结果不可用",
            next_action: "改用视觉模型只提取可见文字；仍不可用就请成员重发清晰特写。",
          };
        } else {
          const boundedText = bounded((parsed as any).text);
          return {
            ok: true,
            text: boundedText.text,
            via: "ocr",
            pages: (parsed as any).pages,
            truncated: boundedText.truncated,
          };
        }
      }
    }
  } catch {
    ocrFailure = {
      ok: false,
      error_kind: "upstream",
      retryable: true,
      reason_text: "文字识别请求失败",
      next_action: "稍后再试，或让成员把文字贴出来。",
    };
  } finally {
    await reserved.release().catch(() => {});
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VISION_TIMEOUT_MS);
  let note: ImageNote | null = null;
  try {
    note = await describe(e, bytes, mime, FALLBACK_HINT, controller.signal);
  } catch {
    note = null;
  } finally {
    clearTimeout(timer);
  }
  const fallback = bounded(note?.text || "");
  if (fallback.text) {
    return {
      ok: true,
      text: fallback.text + "\n\n【视觉回退识别，可能有误】",
      via: "vision_fallback",
      pages: 1,
      truncated: fallback.truncated,
    };
  }
  if (ocrFailure) {
    const reason =
      ocrFailure.error_kind === "unreadable"
        ? "这张图疑似识别异常（重复或超长），视觉回退也没有取到可用文字"
        : ocrFailure.reason_text;
    return {
      ...ocrFailure,
      reason_text: reason,
      next_action:
        ocrFailure.error_kind === "unreadable" || ocrFailure.error_kind === "empty"
          ? "请成员重发更清晰的特写，或把图里的文字贴出来；不要猜。"
          : ocrFailure.next_action,
    };
  }
  return fail("empty", "请成员重发更清晰的图片，或把图里的文字贴出来；不要猜。", "没有取到可用文字", true);
}

function imageAttachments(meta: any) {
  const list = Array.isArray(meta?.media)
    ? meta.media
    : Array.isArray(meta?.attachments)
      ? meta.attachments
      : [];
  return list
    .filter((item: any) => {
      if (!item || typeof item !== "object") return false;
      const contentType = text(item.content_type || item.contentType).toLowerCase();
      const isImage = /^image\//i.test(contentType) || text(item.kind).toLowerCase() === "image";
      return isImage && /^https:\/\//i.test(text(item.url));
    })
    .map((item: any) => ({ url: text(item.url), contentType: text(item.content_type || item.contentType) }));
}

export function createReadImageTextTool(deps: ReadImageTextDeps = {}): BotTool {
  return {
    name: "read_image_text",
    switch: "read_image_text",
    untrusted: true,
    def: {
      type: "function",
      function: {
        name: "read_image_text",
        description:
          "读取本群消息里图片上的文字：截图、扫描件、文档照片、聊天记录截图。只读不写。人像、表情包、普通照片不要用这个工具（会识别成重复乱码），直接用看图结果；图里没字也会返回空。",
        parameters: {
          type: "object",
          properties: {
            message_id: { type: "string", description: "发图片的那条消息ID；默认本轮最新消息" },
            index: { type: "integer", description: "一条消息有多张图时，从 0 开始选第几张；默认第一张" },
          },
        },
      },
    },
    async run(e: any, input: any, ctx: ToolCtx) {
      const args = input && typeof input === "object" ? input : {};
      const latest = ctx?.context?.latest || {};
      const source = ctx?.source || latest;
      const groupId = text(latest.group_id) || text(source.group_id);
      if (!groupId) return fail("unavailable", "没有群上下文，无法确定图片属于哪个群；不要猜内容。", "缺少群信息");
      const messageId = text(args.message_id) || text(source.id) || text(latest.id);
      if (!messageId) {
        return fail("invalid_args", "需要 message_id：让成员重新发一次图片再问。", "没有指定消息");
      }
      const row = await e.DB.prepare(
        "SELECT m.id,m.group_id,m.sender,m.body,mm.json AS metadata FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id WHERE m.id=? AND m.group_id=?",
      )
        .bind(messageId, groupId)
        .first();
      if (!row) {
        return fail(
          "not_found",
          "这条消息不在本群或已经过期；让成员重新发一次图片再问，不要猜图里的内容。",
          "找不到这条消息",
        );
      }
      let meta: any = {};
      try {
        meta = row.metadata ? JSON.parse(row.metadata) : {};
      } catch {
        meta = {};
      }
      const images = imageAttachments(meta);
      if (!images.length) {
        return fail(
          "no_image",
          "这条消息里没有图片；让成员直接发截图或图片再问，不要把文件名当内容。",
          "这条消息没有图片",
        );
      }
      const index = Number.isInteger(args.index) ? Number(args.index) : 0;
      const chosen = images[index];
      if (!chosen) {
        return fail(
          "invalid_args",
          "这条消息有 " + images.length + " 张图片，index 从 0 开始；换一个 index 再调用。",
          "图片序号超出范围",
        );
      }

      const fetchImage = deps.fetchImage || (await import("../vision")).fetchImage;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let fetched: { bytes: Uint8Array; mime: string } | null = null;
      try {
        fetched = await fetchImage(chosen.url, controller.signal, MAX_OCR_BYTES);
      } finally {
        clearTimeout(timer);
      }
      if (!fetched) {
        if (controller.signal.aborted) {
          return fail("timeout", "取图超时；让成员稍后重发，或把文字贴出来。", "图片下载超时", true);
        }
        return fail(
          "not_found",
          "图片链接已过期，请重发；不要猜图里的内容。",
          "图片已经下载不到（QQ 链接会过期）",
          false,
        );
      }
      const sender = text(source.sender) || text(latest.sender) || "unknown";
      return extractImageText(e, fetched.bytes, fetched.mime, { group: groupId, sender, deps });
    },
  };
}

export const readImageTextTool: BotTool = createReadImageTextTool();
