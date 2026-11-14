import { redact } from "./runtime";
import {extractUrls} from './policy';
import {parseBiliTarget,scanBiliPayload} from './bili-links';
import {BILI_CARD_NOTE,cleanCardTitle,isBiliCard,titleRef} from './bilititle';
import { hasSuperFace } from "./face";

export type Mention = { id: string; name: string; isBot: boolean };
export type Card = { type: string; name?: string; title?: string; desc?: string; url?: string; source?: string; preview?: string; note?: string };
export type Media = { kind: "image" | "video" | "voice" | "file"; url?: string; contentType?: string; width?: number; height?: number; size?: number; filename?: string; asr?: string; subType?: number; sticker?: boolean };

/** QQ sticker images are square (80x80 or larger), GIFs, or explicit subType=1 attachments. */
/** Notes for images inside a quoted/forwarded message use a separate index range. */
export const QUOTED_IMAGE_BASE = 1000;

export function isStickerMedia(m: Media) {
  if (m.kind !== "image") return false;
  if (m.sticker === true || m.subType === 1) return true;
  if (String(m.contentType || "").toLowerCase() === "image/gif") return true;
  const width = m.width ?? 0, height = m.height ?? 0;
  if (width < 72 || height < 72 || width > 300 || height > 300) return false;
  const ratio = width / height;
  return ratio >= 0.75 && ratio <= 1.33;
}
export type Bili = { bvid?: string; aid?: string; short?: string; page?: number; url: string };
export type Quoted = { authorId?: string; authorName?: string; text: string; msgIdx?: string; media: Media[]; card?: Card; biliCard?: {title:string} };
export type Inbound = {
  senderId: string; senderName: string; body: string;
  mentions: Mention[]; mentionsBot: boolean; msgIdx?: string; refMsgIdx?: string;
  quoted?: Quoted; card?: Card; media: Media[]; bili: Bili[]; biliCard?: {title:string};
  ownUrls: string[]; quotedUrls: string[]; biliUrls: string[]; quotedBiliUrls: string[]; placeholder: string;
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
  if (typeof ark === 'string') { try { ark = JSON.parse(ark); } catch { return undefined; } }
  if (!ark || typeof ark !== "object") return undefined;
  const fields = Array.isArray(ark.fields)
    ? Object.fromEntries(ark.fields.filter((f: any) => f && typeof f.key === "string").map((f: any) => [f.key, f.value]))
    : ark.fields || {};
  const str = (v: any) => typeof v === "string" ? v : undefined;
  return { type: str(ark.ark_type) || str(ark.type) || "card", name: str(ark.ark_name) || str(ark.name), title: str(fields.title), desc: str(fields.desc), url: str(fields.jump_url), preview: str(fields.preview), source: str(fields.source) || str(fields.tag) };
}
export function extractBili(urls: string[], _text: string): Bili[] {
  return urls.flatMap<Bili>(url => {
    const target = parseBiliTarget(url);
    if (!target) return [];
    if (target.kind === 'short') return [{ url, short: target.base, page: target.page }];
    if (target.kind === 'bv') return [{ url, bvid: target.base, page: target.page }];
    if (target.kind === 'aid') return [{ url, aid: target.base, page: target.page }];
    return [];
  });
}
export function mediaOf(attachments: any): Media[] {
  return (Array.isArray(attachments) ? attachments : []).map(a => {
    const contentType = String(a.content_type || "");
    const kind: Media["kind"] = contentType.startsWith("image/") ? "image" : contentType.startsWith("video/") ? "video" : contentType === "voice" || contentType.startsWith("audio/") || a.asr_refer_text ? "voice" : "file";
    const subType = Number(a.sub_type ?? a.subType ?? a.file_sub_type);
    return { kind, url: a.url, contentType, width: a.width, height: a.height, size: a.size, filename: a.filename, ...(Number.isFinite(subType) ? { subType } : {}), ...(typeof a.asr_refer_text === "string" ? { asr: a.asr_refer_text } : {}) };
  });
}
export function parseInbound(eventType: string, d: any): Inbound {
  const body = redact(String(d.content || "")).replace(/^\s*<@!?[^>]+>\s*/, "").trim();
  const mentions: Mention[] = (Array.isArray(d.mentions) ? d.mentions : []).map((m: any) => ({ id: String(m.member_openid ?? m.id ?? ""), name: String(m.nickname ?? m.username ?? ""), isBot: !!m.is_you }));
  const ext = parseExt(d.message_scene?.ext);
  const elements = Array.isArray(d.msg_elements) ? d.msg_elements : [];
  const refMsgIdx = d.message_type === 103 ? elements.find((el: any) => el?.msg_idx)?.msg_idx || ext.ref_msg_idx : ext.ref_msg_idx;
  const first = elements[0];
  let quoted: Quoted | undefined = first ? {
    authorId: first.author?.member_openid || first.author?.id,
    authorName: first.author?.username,
    text: elements.map((el: any) => String(el?.content || "")).join("\n"),
    msgIdx: refMsgIdx, media: elements.flatMap((el: any) => mediaOf(el?.attachments)),
    card: parseCard(elements.find((el: any) => el?.ark_data)?.ark_data),
  } : undefined;
  const scanned = scanBiliPayload({...d,content:body});
  const chooseCard = (values: any[]) => {
    const choices = values.map(raw => ({raw,card:parseCard(raw)}));
    return choices.find(x => x.card?.title && isBiliCard(x.card,x.raw.prompt)) || choices.find(x => x.card?.title) || choices.find(x => x.card);
  };
  const ownedCard = chooseCard(scanned.cards), quotedCard = chooseCard(scanned.quotedCards);
  let card = ownedCard?.card || parseCard(d.ark_data);
  if (quotedCard) {
    if (!quoted) quoted = {text:'',media:[],card:quotedCard.card};
    else quoted.card = quotedCard.card;
  }
  const media = mediaOf(d.attachments), biliUrls = scanned.biliUrls, quotedBiliUrls = scanned.quotedBiliUrls;
  if (hasSuperFace(body)) {
    for (const m of media) if (m.kind === "image") m.sticker = true;
  } else if (!body.trim()) {
    for (const m of media) if (m.kind === "image" && isStickerMedia(m)) m.sticker = true;
  }
  const ownUrls = extractUrls(body + ' ' + JSON.stringify(d.ark_data || {}));
  const quotedUrls = extractUrls(JSON.stringify(elements));
  const bili = extractBili(biliUrls,body);
  const titleOf = (c: Card | undefined, raw: any, links: Bili[]) => {
    if (!c || links.some(b => b.bvid || b.short && /^[0-9A-Za-z]{4,12}$/.test(b.short)) || !isBiliCard(c,raw?.prompt)) return undefined;
    const title = cleanCardTitle(c.title || ''); return titleRef(title) ? {title} : undefined;
  };
  const biliCard = titleOf(card,ownedCard?.raw || d.ark_data,bili);
  if (biliCard && card) card = {...card,note:BILI_CARD_NOTE};
  if (quoted) {
    quoted.biliCard = titleOf(quoted.card,quotedCard?.raw,extractBili(quotedBiliUrls,''));
    if (quoted.biliCard && quoted.card) quoted.card = {...quoted.card,note:BILI_CARD_NOTE};
  }
  const placeholder = body ? "" : card ? "[卡片] " + (card.source || card.name || "") + (card.title ? "：" + card.title : "") : media[0]?.kind === "image" ? "[图片]" : media[0]?.kind === "voice" ? "[语音]" : media[0]?.kind === "video" ? "[视频]" : media[0] ? "[文件]" + (media[0].filename ? " " + media[0].filename : "") : "";
  return { senderId: String(d.author?.member_openid || d.author?.id || ""), senderName: d.author?.username || "", body, mentions, mentionsBot: eventType === "GROUP_AT_MESSAGE_CREATE" || mentions.some(m => m.isBot), msgIdx: ext.msg_idx, refMsgIdx, quoted, card, media, bili, biliCard, ownUrls, quotedUrls, biliUrls, quotedBiliUrls, placeholder };
}
