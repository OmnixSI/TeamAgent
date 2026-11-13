/* Ported from Mai-with-u/MaiBot@03347c9b8f6fa2208e763da3cd4713db22af87bf
 * src/plugins/built_in/qq_official_adapter/codec.py::decode_message,
 * _extract_content, _rewrite_mention_tokens, extract_message_scene_fields (MIT).
 * Copyright (c) 2026 MaiBot Team
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { Card, EventNotice, MediaOrigin, NormalizedEvent, Segment, SegmentNode } from "./types";
import { scanBiliPayload } from "../bili-links";
import { FACE, parseFace } from "./face";
import { normalizeForward } from "./forward";

const records = (value: any): any[] => Array.isArray(value) ? value.filter(x => x && typeof x === "object" && !Array.isArray(x)) : [];
const text = (value: any) => String(value || "");
const authorId = (value: any) => text(value?.member_openid || value?.id);
const authorName = (value: any) => text(value?.username);
export const elementKind = (value: any) => String(value?.message_type ?? value?.type ?? "");

// Ported from Mai-with-u/MaiBot@03347c9 codec.py::extract_message_scene_fields (MIT; full path/license above).
export function parseEventExt(ext: unknown): Record<string, string> {
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

export function parseEventCard(ark: any): Card | undefined {
  if (typeof ark === "string") { try { ark = JSON.parse(ark); } catch { return undefined; } }
  if (!ark || typeof ark !== "object") return undefined;
  const fields = Array.isArray(ark.fields)
    ? Object.fromEntries(ark.fields.filter((f: any) => f && typeof f.key === "string").map((f: any) => [f.key, f.value]))
    : ark.fields || {};
  const str = (v: any) => typeof v === "string" ? v : undefined;
  return { type: str(ark.ark_type) || str(ark.type) || "card", name: str(ark.ark_name) || str(ark.name), title: str(fields.title), desc: str(fields.desc), url: str(fields.jump_url), preview: str(fields.preview), source: str(fields.source) || str(fields.tag) };
}

export function chooseEventCard(values: any[]) {
  const choices = values.map(raw => ({ raw, card: parseEventCard(raw) }));
  return choices.find(x => x.card?.title && /哔哩哔哩|bilibili|b站/i.test([x.card.source, x.card.name, typeof x.raw.prompt === "string" ? x.raw.prompt : ""].join(" ")))
    || choices.find(x => x.card?.title) || choices.find(x => x.card);
}

// Ported from Mai-with-u/MaiBot@03347c9 codec.py::_rewrite_mention_tokens (MIT; full path/license above).
function bodySegments(content: string, mentions: any[]): Segment[] {
  // Keep member text intact; the Inbound bridge owns legacy redaction/leading-@ trimming.
  const token = new RegExp('<@!?([^>]+)>|'+FACE.source,'g');
  const result: Segment[] = [];
  let cursor = 0;
  for (const match of content.matchAll(token)) {
    if (match.index! > cursor) result.push({ type: "text", text: content.slice(cursor, match.index) });
    if (match[1]) {
      const mention = mentions.find(m => String(m.member_openid ?? m.id ?? "") === match[1]);
      result.push({ type: "mention", id: match[1], name: String(mention?.nickname ?? mention?.username ?? ""), self: !!mention?.is_you });
    } else {
      result.push(parseFace(match[0]));
    }
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) result.push({ type: "text", text: content.slice(cursor) });
  return result;
}

function attachmentsOf(raw: any, owner: string, origin: MediaOrigin): Segment[] {
  return records(raw).flatMap((a): Segment[] => {
    const url = text(a.url), contentType = text(a.content_type);
    if (contentType.startsWith("image/")) return [{ type: "image", url, contentType,
      ...(a.width === undefined ? {} : { w: a.width }), ...(a.height === undefined ? {} : { h: a.height }),
      ...(a.size === undefined ? {} : { size: a.size }), animated: contentType.toLowerCase() === "image/gif", owner, origin },
      ...(['mface','emoji','face','sticker'].includes(String(a.type || '').toLowerCase()) || a.is_emoji
        ? [{type:'face' as const,id:String(a.face_id || a.emoji_id || ''),kind:'mface' as const}] : [])];
    if (contentType.startsWith("video/")) return [{ type: "video", url, filename: a.filename, size: a.size, owner, origin }];
    if (contentType === "voice" || contentType.startsWith("audio/") || a.asr_refer_text) return [{
      type: "voice", url, ...(typeof a.asr_refer_text === "string" ? { asr: a.asr_refer_text } : {}),
      ...(typeof a.wav_url === "string" ? { wavUrl: a.wav_url } : {}), owner, origin }];
    return [{ type: "file", url, filename: a.filename, size: a.size, owner, origin }];
  });
}

function elementText(node: any): string {
  if (typeof node.content === "string") return node.content;
  if (typeof node.text === "string") return node.text;
  return text(node.content?.content || node.text?.content || node.text_element?.content);
}

function forwardSegments(elements: any[]): Extract<Segment, { type: "forward" }> {
  return normalizeForward(elements,node=>{
    const owner = authorId(node.author), segments = bodySegments(elementText(node), records(node.mentions));
    segments.push(...attachmentsOf(node.attachments, owner, "forward"));
    const card = parseEventCard(node.ark_data);
    if (card) segments.push({ type: "card", card });
    return segments;
  });
}

function replySegment(elements: any[], refIdx: string): Extract<Segment, { type: "reply" }> {
  const first = elements[0], owner = authorId(first?.author);
  const segments: Segment[] = [];
  elements.forEach((node, index) => {
    if (index) segments.push({ type: "text", text: "\n" });
    segments.push(...bodySegments(text(node.content), records(node.mentions)), ...attachmentsOf(node.attachments, authorId(node.author) || owner, "quote"));
  });
  const card = parseEventCard(elements.find(node => node.ark_data)?.ark_data);
  if (card) segments.push({ type: "card", card });
  return { type: "reply", refIdx, preview: {
    authorId: first?.author?.member_openid || first?.author?.id,
    authorName: first?.author?.username, segments,
  } };
}

const NOTICES: Record<string, EventNotice> = {
  GROUP_ADD_ROBOT: "bot_added", GROUP_DEL_ROBOT: "bot_removed",
  GROUP_MSG_REJECT: "active_rejected", GROUP_MSG_RECEIVE: "active_allowed",
};

// Ported from Mai-with-u/MaiBot@03347c9 codec.py::decode_message/_extract_content (MIT; full path/license above).
export function normalize(eventType: string, raw: any): NormalizedEvent {
  const d = raw && typeof raw === "object" ? raw : {}, notice = NOTICES[eventType];
  const mentions = records(d.mentions), ext = parseEventExt(d.message_scene?.ext), elements = records(d.msg_elements);
  const kind = elementKind(d), actor = notice ? { id: text(d.op_member_openid), name: "", bot: false }
    : { id: authorId(d.author), name: authorName(d.author), bot: d.author?.bot === true || d.author?.bot === "true" };
  const ne: NormalizedEvent = {
    kind: notice ? "notice" : "message", type: eventType, id: text(d.id), groupId: text(d.group_openid), actor,
    ts: typeof d.timestamp === "number" ? d.timestamp : Date.parse(text(d.timestamp)),
    ...(ext.msg_idx ? { msgIdx: ext.msg_idx } : {}), ...(ext.ref_msg_idx ? { refIdx: ext.ref_msg_idx } : {}),
    segments: [], mentionsBot: !notice && (eventType === "GROUP_AT_MESSAGE_CREATE" || mentions.some(m => !!m.is_you)),
    ...(notice ? { notice } : {}),
  };
  if (notice) return ne;
  ne.segments.push(...bodySegments(text(d.content), mentions), ...attachmentsOf(d.attachments, actor.id, "own"));
  const scanned = scanBiliPayload(d), own = chooseEventCard(scanned.cards);
  const card = own?.card || parseEventCard(d.ark_data);
  if (card) ne.segments.push({ type: "card", card });
  if (kind === "102") {
    ne.segments.push(forwardSegments(elements));
  } else if (kind === "103") {
    ne.refIdx = elements.find(node => node.msg_idx)?.msg_idx || ext.ref_msg_idx;
    ne.segments.push(replySegment(elements, ne.refIdx || ""));
  } else {
    const legacy = elements.filter(node => !["101", "102", "103"].includes(elementKind(node)));
    if (legacy.length && kind !== "101") ne.segments.push(replySegment(legacy, ext.ref_msg_idx || ""));
    for (const node of elements) {
      const nodeKind = elementKind(node);
      if (nodeKind === "101" || kind === "101" && !["102", "103"].includes(nodeKind)) {
        if (!text(d.content)) ne.segments.push(...bodySegments(elementText(node), records(node.mentions)));
        ne.segments.push(...attachmentsOf(node.attachments, actor.id, "own"));
        const nodeCard = parseEventCard(node.ark_data);
        if (nodeCard) ne.segments.push({ type: "card", card: nodeCard });
      } else if (nodeKind === "102") ne.segments.push(forwardSegments(records(node.msg_elements).length ? records(node.msg_elements) : [node]));
      else if (nodeKind === "103") {
        const ref = text(node.msg_idx) || ext.ref_msg_idx;
        if (ref) ne.refIdx = ref;
        ne.segments.push(replySegment([node], ref || ""));
      }
    }
  }
  const quoted = chooseEventCard(scanned.quotedCards);
  if (quoted?.card && kind !== "101" && kind !== "102") {
    let reply = ne.segments.find((s): s is Extract<Segment, { type: "reply" }> => s.type === "reply");
    if (!reply) { reply = { type: "reply", refIdx: ext.ref_msg_idx || "", preview: { segments: [] } }; ne.segments.push(reply); }
    reply.preview.segments = reply.preview.segments.filter(s => s.type !== "card");
    reply.preview.segments.push({ type: "card", card: quoted.card });
  }
  return ne;
}
