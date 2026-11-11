import { redact } from "./runtime";
import { extractUrls } from "./policy";

export type Mention = { id: string; name: string; isBot: boolean };
export type Card = { type: string; name?: string; title?: string; desc?: string; url?: string; source?: string; preview?: string };
export type Media = { kind: "image" | "video" | "voice" | "file"; url?: string; contentType?: string; width?: number; height?: number; size?: number; filename?: string; asr?: string };
export type Bili = { bvid?: string; aid?: string; short?: string; url: string };
export type Quoted = { authorId?: string; authorName?: string; text: string; msgIdx?: string; media: Media[]; card?: Card };
export type Inbound = {
  senderId: string; senderName: string; body: string;
  mentions: Mention[]; mentionsBot: boolean; msgIdx?: string; refMsgIdx?: string;
  quoted?: Quoted; card?: Card; media: Media[]; bili: Bili[];
  ownUrls: string[]; quotedUrls: string[]; placeholder: string;
};

export function parseExt(ext: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  if (Array.isArray(ext)) for (const entry of ext) {
    if (typeof entry !== "string") continue;
    const eq = entry.indexOf("=");
    if (eq < 0) continue;
    const key = entry.slice(0, eq).trim(), value = entry.slice(eq + 1).trim();
    if (value) result[key] = value;
  }
  return result;
}
export function renderMentions(body: string, mentions: Mention[]): string {
  return body.replace(/<@!?([^>]+)>/g, (_match, id) => {
    const name = mentions.find(m => m.id === id)?.name;
    return "@" + (name || "成员" + id.slice(-4));
  });
}
export function parseCard(ark: any): Card | undefined {
  if (!ark || typeof ark !== "object") return undefined;
  const fields = Array.isArray(ark.fields)
    ? Object.fromEntries(ark.fields.filter((f: any) => f && typeof f.key === "string").map((f: any) => [f.key, f.value]))
    : ark.fields || {};
  const str = (v: any) => typeof v === "string" ? v : undefined;
  return { type: str(ark.ark_type) || str(ark.type) || "card", name: str(ark.ark_name) || str(ark.name), title: str(fields.title), desc: str(fields.desc), url: str(fields.jump_url), preview: str(fields.preview), source: str(fields.source) || str(fields.tag) };
}
export function extractBili(urls: string[], _text: string): Bili[] {
  return urls.flatMap<Bili>(url => {
    let u: URL;
    try { u = new URL(url); } catch { return []; }
    if (u.hostname === "b23.tv") {
      const short = u.pathname.split("/").filter(Boolean)[0];
      return short ? [{ url, short }] : [];
    }
    if (u.hostname !== "bilibili.com" && !u.hostname.endsWith(".bilibili.com")) return [];
    const bvid = u.pathname.match(/\bBV[0-9A-Za-z]{10}\b/)?.[0];
    const aid = u.pathname.match(/\bav\d+\b/i)?.[0];
    return bvid || aid ? [{ url, ...(bvid ? { bvid } : { aid }) }] : [];
  });
}
export function mediaOf(attachments: any): Media[] {
  return (Array.isArray(attachments) ? attachments : []).map(a => {
    const contentType = String(a.content_type || "");
    const kind: Media["kind"] = contentType.startsWith("image/") ? "image" : contentType.startsWith("video/") ? "video" : contentType === "voice" || contentType.startsWith("audio/") || a.asr_refer_text ? "voice" : "file";
    return { kind, url: a.url, contentType, width: a.width, height: a.height, size: a.size, filename: a.filename, ...(typeof a.asr_refer_text === "string" ? { asr: a.asr_refer_text } : {}) };
  });
}
export function parseInbound(eventType: string, d: any): Inbound {
  const body = redact(String(d.content || "")).replace(/^\s*<@!?[^>]+>\s*/, "").trim();
  const mentions: Mention[] = (Array.isArray(d.mentions) ? d.mentions : []).map((m: any) => ({ id: String(m.member_openid ?? m.id ?? ""), name: String(m.nickname ?? m.username ?? ""), isBot: !!m.is_you }));
  const ext = parseExt(d.message_scene?.ext);
  const elements = Array.isArray(d.msg_elements) ? d.msg_elements : [];
  const refMsgIdx = d.message_type === 103 ? elements.find((el: any) => el?.msg_idx)?.msg_idx || ext.ref_msg_idx : ext.ref_msg_idx;
  const first = elements[0];
  const quoted: Quoted | undefined = first ? {
    authorId: first.author?.member_openid || first.author?.id,
    authorName: first.author?.username,
    text: elements.map((el: any) => String(el?.content || "")).join("\n"),
    msgIdx: refMsgIdx, media: elements.flatMap((el: any) => mediaOf(el?.attachments)),
    card: parseCard(elements.find((el: any) => el?.ark_data)?.ark_data),
  } : undefined;
  const card = parseCard(d.ark_data), media = mediaOf(d.attachments);
  const ownUrls = extractUrls(body + " " + JSON.stringify(d.ark_data || {}));
  const quotedUrls = extractUrls(JSON.stringify(elements));
  const placeholder = body ? "" : card ? "[卡片] " + (card.source || card.name || "") + (card.title ? "：" + card.title : "") : media[0]?.kind === "image" ? "[图片]" : media[0]?.kind === "voice" ? "[语音]" : media[0]?.kind === "video" ? "[视频]" : media[0] ? "[文件]" + (media[0].filename ? " " + media[0].filename : "") : "";
  return { senderId: String(d.author?.member_openid || d.author?.id || ""), senderName: d.author?.username || "", body, mentions, mentionsBot: eventType === "GROUP_AT_MESSAGE_CREATE" || mentions.some(m => m.isBot), msgIdx: ext.msg_idx, refMsgIdx, quoted, card, media, bili: extractBili(ownUrls, body), ownUrls, quotedUrls, placeholder };
}
