import { redact } from "./runtime";
import {extractUrls} from './policy';
import {scanBiliPayload,SHORT_HOSTS} from './bili-links';
import {BILI_CARD_NOTE,cleanCardTitle,isBiliCard,titleRef} from './bilititle';
import { normalize, elementKind, chooseEventCard, parseEventCard as parseCard, parseEventExt as parseExt } from './event/normalize';
import type { NormalizedEvent, Segment } from './event/types';
export { parseCard, parseExt };

export type Mention = { id: string; name: string; isBot: boolean };
export type Card = { type: string; name?: string; title?: string; desc?: string; url?: string; source?: string; preview?: string; note?: string };
export type Media = { kind: "image" | "video" | "voice" | "file"; url?: string; contentType?: string; width?: number; height?: number; size?: number; filename?: string; asr?: string };
export type Bili = { bvid?: string; aid?: string; short?: string; url: string };
export type Quoted = { authorId?: string; authorName?: string; text: string; msgIdx?: string; media: Media[]; card?: Card; biliCard?: {title:string} };
export type Inbound = {
  senderId: string; senderName: string; body: string;
  mentions: Mention[]; mentionsBot: boolean; msgIdx?: string; refMsgIdx?: string;
  quoted?: Quoted; card?: Card; media: Media[]; bili: Bili[]; biliCard?: {title:string};
  ownUrls: string[]; quotedUrls: string[]; biliUrls: string[]; quotedBiliUrls: string[]; placeholder: string;
};

export function renderMentions(body: string, mentions: Mention[]): string {
  return body.replace(/<@!?([^>]+)>/g, (_match, id) => {
    const name = mentions.find(m => m.id === id)?.name;
    return "@" + (name || "成员" + id.slice(-4));
  });
}
export function extractBili(urls: string[], _text: string): Bili[] {
  return urls.flatMap<Bili>(url => {
    let u: URL;
    try { u = new URL(url); } catch { return []; }
    if (SHORT_HOSTS.has(u.hostname)) {
      const short = u.pathname.split("/").filter(Boolean)[0];
      return short ? [{ url, short }] : [];
    }
    if (u.hostname !== "bilibili.com" && !u.hostname.endsWith(".bilibili.com")) return [];
    const bvid = u.pathname.match(/\bBV[0-9A-Za-z]{10}\b/)?.[0] || u.searchParams.get('bvid')?.match(/^BV[0-9A-Za-z]{10}$/)?.[0];
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
const records = (value: any): any[] => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];
const mediaSegment = (s: Segment): s is Extract<Segment, { type: 'image' | 'voice' | 'video' | 'file' }> => ['image','voice','video','file'].includes(s.type);

function segmentText(segments: Segment[], original: string): string {
  const faces = original.match(/\[<face,id=\d+\/>\]|<faceType=(?:ext="\{(?:[^{}"]|"(?:\\.|[^"\\])*")*\}"|"(?:\\.|[^"\\])*"|[^">])*>/g) || [];
  const mentions = [...original.matchAll(/<@!?([^>]+)>/g)];
  let face = 0, mention = 0;
  return segments.map(s => {
    if (s.type === 'text') return s.text;
    if (s.type === 'mention') {
      const raw = mentions[mention++];
      return raw ? raw[0].replace(raw[1],s.id) : '<@'+s.id+'>';
    }
    if (s.type === 'face') return s.kind === 'mface' ? '' : faces[face++] || '[<face,id='+s.id+'/>]';
    return '';
  }).join('');
}

function normalizedMedia(segments: Segment[], attachments: any): Media[] {
  const fallback = mediaOf(records(attachments));
  return segments.filter(mediaSegment).map((s,i) => {
    const raw = fallback[i] || {} as Media;
    return {
      kind:s.type, url:s.url === '' && raw.url === undefined ? undefined : s.url,
      contentType:s.type === 'image' ? s.contentType : raw.contentType ?? '',
      width:s.type === 'image' ? s.w ?? raw.width : raw.width,
      height:s.type === 'image' ? s.h ?? raw.height : raw.height,
      size:s.type === 'voice' ? raw.size : s.size ?? raw.size,
      filename:s.type === 'image' || s.type === 'voice' ? raw.filename : s.filename ?? raw.filename,
      ...(s.type === 'voice' && s.asr !== undefined ? {asr:s.asr} : {}),
    };
  });
}

/** Preserve unknown ark fields for legacy scanning, replacing represented fields only when NE changed them. */
function canonicalArk(raw: any, previous: any, card: Card | undefined): any {
  if (!card) return undefined;
  if (!previous || JSON.stringify(previous.card) === JSON.stringify(card)) return raw;
  const updated = card;
  const target = JSON.stringify(previous.raw);
  function visit(value: any, depth = 0): any {
    if (depth > 32 || value == null) return value;
    if (typeof value === 'string') {
      try { const parsed=JSON.parse(value),changed=visit(parsed,depth+1);return changed === parsed ? value : JSON.stringify(changed); } catch { return value; }
    }
    if (typeof value !== 'object') return value;
    if (JSON.stringify(value) === target) {
      const fields = {title:updated.title,desc:updated.desc,jump_url:updated.url,preview:updated.preview,source:updated.source,tag:undefined};
      return {...value,ark_type:updated.type,ark_name:updated.name,fields:Array.isArray(value.fields)
        ? [...value.fields.filter((f:any)=>!Object.hasOwn(fields,f?.key)),...Object.entries(fields).filter(([,v])=>v!==undefined).map(([key,v])=>({key,value:v}))]
        : {...value.fields,...fields}};
    }
    if (Array.isArray(value)) {
      const next=value.map(item=>visit(item,depth+1));return next.some((item,i)=>item!==value[i])?next:value;
    }
    const next=Object.fromEntries(Object.entries(value).map(([key,item])=>[key,visit(item,depth+1)]));
    return Object.keys(next).some(key=>next[key]!==value[key])?next:value;
  }
  return visit(raw);
}

// raw supplies only legacy attributes absent from the shared contract (e.g. voice MIME and opaque ark fields).
// Worker wiring: toInbound(normalize(t, d), d); represented fields always come from the NormalizedEvent.
export function toInbound(ne: NormalizedEvent, raw: any): Inbound {
  const d = raw || {}, elements = records(d.msg_elements), kind = elementKind(d);
  const parallel = elements.filter(el => elementKind(el)==='101' || kind==='101' && !['102','103'].includes(elementKind(el)));
  const quotes = kind==='102' ? [] : kind==='103' ? elements : elements.filter(el=>elementKind(el)==='103' || kind!=='101' && !['101','102'].includes(elementKind(el)));
  const original = String(d.content || '') + parallel.map(el=>String(el.content || el.text || el.text_element?.content || '')).join('');
  const body = redact(segmentText(ne.segments,original)).replace(/^\s*<@!?[^>]+>\s*/,'').trim();
  const tokens = ne.segments.filter((s):s is Extract<Segment,{type:'mention'}>=>s.type==='mention');
  const rawMentions=records(d.mentions);
  const mentions:Mention[] = rawMentions.map((m:any,i:number) => {
    const id=String(m.member_openid ?? m.id ?? ''),token=tokens.find(s=>s.id===id) || (tokens.length===rawMentions.length ? tokens[i] : undefined);
    return {id:token?.id ?? id,name:token?.name ?? String(m.nickname ?? m.username ?? ''),isBot:token?.self ?? !!m.is_you};
  });
  const refMsgIdx=ne.refIdx,reply=ne.segments.find((s):s is Extract<Segment,{type:'reply'}>=>s.type==='reply');
  const quoteText=reply ? segmentText(reply.preview.segments,quotes.map(el=>String(el.content || '')).join('\n')) : '';
  const quoteMedia=reply ? normalizedMedia(reply.preview.segments,quotes.flatMap(el=>records(el.attachments))) : [];
  const quoteCard=reply?.preview.segments.find((s):s is Extract<Segment,{type:'card'}>=>s.type==='card');
  let quoted:Quoted|undefined=reply && (quotes.length || reply.preview.segments.length) ? quotes.length ? {
    authorId:reply.preview.authorId,authorName:reply.preview.authorName,text:quoteText,msgIdx:refMsgIdx,media:quoteMedia,
    card:quoteCard ? {...quoteCard.card} : undefined,
  } : {text:quoteText,media:quoteMedia,card:quoteCard ? {...quoteCard.card} : undefined} : undefined;
  const segmentCard=ne.segments.find((s):s is Extract<Segment,{type:'card'}>=>s.type==='card');
  let card=segmentCard ? {...segmentCard.card} : undefined;
  const scoped = {...d,content:body,msg_elements:quotes,...(parallel.length ? {parallel_elements:parallel} : {})};
  const previous=chooseEventCard(scanBiliPayload(scoped).cards);
  const ark=canonicalArk(d.ark_data,previous,card);
  const scanned=scanBiliPayload({...scoped,ark_data:ark});
  const ownedCard=chooseEventCard(scanned.cards),quotedCard=chooseEventCard(scanned.quotedCards);
  const media=normalizedMedia(ne.segments,[...records(d.attachments),...parallel.flatMap(el=>records(el.attachments))]);
  const biliUrls=scanned.biliUrls,quotedBiliUrls=scanned.quotedBiliUrls;
  const ownUrls=extractUrls(body+' '+JSON.stringify(ark || {}));
  const quotedUrls=extractUrls(JSON.stringify(quotes));
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
  return { senderId:ne.actor.id,senderName:ne.actor.name,body,mentions,mentionsBot:ne.mentionsBot,msgIdx:ne.msgIdx,refMsgIdx,quoted,card,media,bili,biliCard,ownUrls,quotedUrls,biliUrls,quotedBiliUrls,placeholder };
}

export function parseInbound(eventType: string, d: any): Inbound {
  return toInbound(normalize(eventType,d),d);
}
