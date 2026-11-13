// V-D v2 / P1-1: split a QQ message into provenance segments and expose the
// exact own-clause splitter used by src/authz.ts. Only `direct` segments may
// become a rule or memory candidate; everything else is evidence of what happened.
import type { Origin, Seg } from "./types";

const BOT_NAMES = ["小助手", "群助手", "机器人", "bot"];

// Copied verbatim from src/authz.ts:54-58 (ownClauses). Keep the two copies in
// sync; test/review-trace.test.mjs pins the shared behaviour.
export function ownClauses(text: string): string[] {
  // Reported speech and code are evidence, never the speaker's own command.
  const own = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, "");
  return own.split(/[，,。！？!?；;\n]/).map(part => part.trim().replace(/^@\S+\s+/, ""));
}

export function directText(segs: Seg[]): string {
  return segs.filter(seg => seg.origin === "direct").map(seg => seg.text).join("\n");
}

const asMeta = (meta: unknown): any => {
  if (!meta) return {};
  if (typeof meta === "string") {
    try { return JSON.parse(meta); } catch { return {}; }
  }
  return meta;
};

type Span = { start: number; end: number; origin: Origin };

function locate(text: string, needle: unknown, origin: Origin, spans: Span[], wrap = false) {
  const value = String(needle || "");
  if (value.length < 2) return;
  let from = 0;
  while (from <= text.length - value.length) {
    const at = text.indexOf(value, from);
    if (at < 0) break;
    let start = at, end = at + value.length;
    if (wrap && text[start - 1] === "「" && text[end] === "」") { start--; end++; }
    else if (wrap && text[start - 1] === "“" && text[end] === "”") { start--; end++; }
    else if (wrap && text[start - 1] === '"' && text[end] === '"') { start--; end++; }
    spans.push({ start, end, origin });
    from = at + value.length;
  }
}

/** Deterministic source split. Bodies not found in the text are appended as evidence. */
export function segmentsOf(body: string, meta: unknown, images: { desc?: string | null; text?: string | null }[] = []): Seg[] {
  const text = String(body || "");
  const m = asMeta(meta);
  if (m.isBot === true || m.bot === true || m.senderIsBot === true) return [{ origin: "bot", text }];

  const card = m.cardView || m.card;
  if (card && /^\s*\[(?:卡片消息|QQ小程序|小程序)\]/.test(text)) {
    return [{ origin: "card", text }];
  }

  const spans: Span[] = [];
  locate(text, m.quoted?.text, "quoted", spans, true);
  locate(text, m.replyTo?.text, "quoted", spans, true);
  for (const item of Array.isArray(m.forwarded) ? m.forwarded : []) locate(text, item?.content, "forwarded", spans);

  if (card) {
    locate(text, card.prompt, "card", spans);
    if (String(card.title || "").length >= 4) locate(text, card.title, "card", spans);
  }

  for (const item of Array.isArray(m.attachments) ? m.attachments : []) {
    locate(text, item?.name || item?.filename, "attachment_text", spans);
  }

  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start < last.end) continue;
    merged.push(span);
  }

  const out: Seg[] = [];
  let at = 0;
  for (const span of merged) {
    if (span.start > at) {
      const direct = text.slice(at, span.start).trim();
      if (direct) out.push({ origin: "direct", text: direct });
    }
    const found = text.slice(span.start, span.end).trim();
    if (found) out.push({ origin: span.origin, text: found });
    at = span.end;
  }
  const tail = text.slice(at).trim();
  if (tail) out.push({ origin: "direct", text: tail });

  // Text that QQ supplies out-of-band: keep it as evidence, never as a direct quote.
  const seen = new Set(out.map((seg) => seg.text));
  const append = (origin: Origin, value: unknown) => {
    const extra = typeof value === "string" ? value.trim() : "";
    if (!extra || text.includes(extra) || seen.has(extra)) return;
    seen.add(extra);
    out.push({ origin, text: extra });
  };
  append("forwarded", m.quoted?.text);
  append("quoted", m.replyTo?.text);
  for (const item of Array.isArray(m.forwarded) ? m.forwarded : []) append("forwarded", item?.content);
  for (const item of Array.isArray(m.attachments) ? m.attachments : []) append("attachment_text", item?.analysed || item?.text);
  for (const image of images) append("image_text", image?.text || image?.desc);
  return out;
}

const firstSentence = (text: string) => String(text || "").split(/[。！？!?\n]/)[0].toLowerCase();

/** mentioned / replyTo.kind='bot' / first sentence names the bot. */
export function addressedOf(body: string, mentioned: number, meta: unknown): "bot" | "other" | "none" {
  const m = asMeta(meta);
  if (mentioned === 1 || m.replyTo?.kind === "bot" ||
      (Array.isArray(m.mentions) && m.mentions.some((x: any) => x && x.isBot === true)) ||
      BOT_NAMES.some(name => firstSentence(body).includes(name))) return "bot";
  if (m.addressedOther === true || (Array.isArray(m.mentions) && m.mentions.some((x: any) => x && x.isBot !== true))) return "other";
  return "none";
}

export function senderTag(sender: unknown): string {
  const id = String(sender || "");
  return id.startsWith("qq:") ? id : "qq:" + id;
}
