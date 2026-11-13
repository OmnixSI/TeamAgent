import { FACE, faceName } from "./event/face";
export { withoutFaces, hasFace } from "./event/face";
import { renderForward } from "./event/forward";
import { quotedImagesFromMeta } from "./media/quoted";
import type { EvidenceResult } from "./event/types";
import { renderMentions, mediaOf, extractBili, type Card, type Mention } from "./inbound";

export type ViewMsg = {
  id: string; sortAt: number; ord: number; at: string; from: string; fromId: string;
  to?: string; re?: string; th?: number; text: string;
  material?: { forward?: string; card?: Card; quote?: { from: string; text: string; media?: string[] }; media?: string[]; links?: string[]; analysed?: string };
  flags?: ("mentionsYou" | "quotesYou" | "addressedOther")[];
};
export type RefTarget = { id: string; from: string; fromId: string; text: string; media?: string[] };
export function renderEvidence(label:string,result:EvidenceResult):string {
  if(result.status==='ok')return result.text || label;
  const status={partial:'部分读取',failed:'读取失败',unsupported:'通道不支持'}[result.status];
  return '['+label+'：'+status+'（'+(result.reason || '原因未记录')+'）]'+(result.text || '');
}
const mentionsOf = new WeakMap<ViewMsg, Mention[]>();
export function withLegacy(meta: any): any {
  if (meta.media !== undefined) return meta;
  const next = { ...meta }, media = mediaOf(meta.attachments);
  if (media.length) next.media = media;
  if (next.ownUrls === undefined && meta.urls !== undefined) next.ownUrls = meta.urls;
  if (next.quoted === undefined && meta.forwarded?.length)
    next.quoted = { authorId: "", text: meta.forwarded.map((q: any) => q.content).join(" ").slice(0, 200), media: [] };
  if (next.bili === undefined && next.ownUrls?.length) next.bili = extractBili(next.ownUrls, "");
  return next;
}
export function metaOf(row: any): any {
  if (row.meta) return withLegacy(row.meta);
  try { return withLegacy(JSON.parse(row.metadata || "{}")); } catch { return {}; }
}
export function displayText(body: string, mentions: Mention[]): string {
  return renderMentions(body, mentions).replace(FACE, faceName);
}
/** Attachment attributes and decoded labels are display material, not member prose. */
export function evidenceText(body: string, mentions: Mention[]): string {
  return renderMentions(body.replace(FACE, "[表情]"), mentions);
}
/** Only labels actually rendered from this message can become neutral evidence markers. */
export function quoteEvidence(body: string, quote: string): string {
  for (const tag of body.match(FACE) || []) quote = quote.replaceAll(faceName(tag), "[表情]");
  return quote;
}
function resolvedMentions(meta: any, names: Map<string, string>): Mention[] {
  return (meta.mentions || []).map((m: Mention) => ({ ...m, name: m.name || names.get(m.id) || "" }));
}
export function quoteIn(row: { body: string; meta?: any }, quote: string, names = new Map<string, string>()): boolean {
  const mentions = resolvedMentions(metaOf(row), names);
  const evidence = quoteEvidence(row.body, quote);
  return row.body.replace(FACE, "[表情]").includes(evidence) || evidenceText(row.body, mentions).includes(evidence);
}
const memberName = (id = "", name?: string) => name || "成员" + id.slice(-4);
function named(id: string, name: string | undefined, names: Map<string, string>) {
  return memberName(id, name || names.get(id));
}
export function addressee(meta: any, names: Map<string, string>): string | undefined {
  if (meta.replyTo?.kind === "bot") return "你";
  if (meta.replyTo?.authorId || meta.replyTo?.authorName) return named(meta.replyTo.authorId || "", meta.replyTo.authorName, names);
  const other = meta.mentions?.find((m: Mention) => !m.isBot);
  if (other) return named(other.id, other.name, names);
  if (meta.mentionsBot) return "你";
}
function stamp(at: number) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  const p = Object.fromEntries(parts.map(v => [v.type, v.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, label: `${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export function mediaViews(
  meta: any,
  messageId: string,
  imageNotes?: Map<string, string[]>,
  imagePicks?: Set<string>,
  names = new Map<string,string>(),
): string[] | undefined {
  if (!meta?.media?.length) return undefined;
  let imageIdx = -1;
  return meta.media.map((m: any) => {
    if (m.kind !== "image")
      return m.kind === "voice"
        ? m.asr
          ? "语音转写：" + m.asr
          : "语音"
        : m.kind === "video"
          ? "视频"
          : "文件" + (m.filename ? " " + m.filename : "");
    imageIdx++;
    const info = meta.images?.find((image:any) => image.url === m.url);
    const label = info ? (info.owner ? memberName(info.owner,names.get(info.owner))+"发的" : "")+(info.animated ? "动图" : "图片") : "";
    const describe = (value:string) => label ? label+"："+value.replace(/^图片：/, "") : value;
    const note = imageNotes?.get(messageId)?.[imageIdx];
    if (note) return describe(note);
    if (imagePicks?.has(messageId + ":" + imageIdx)) return describe("图片（未分析：没有可用结果，原因未记录）");
    return (label || "图片") + (m.width && m.height ? ` ${m.width}×${m.height}` : "");
  });
}
function previewImageViews(meta:any,id:string,offset:number,names:Map<string,string>,notes?:Map<string,string[]>,picks?:Set<string>):string[]|undefined {
  const images=quotedImagesFromMeta(meta);
  if(!images.length)return undefined;
  const localNotes=notes?.has(id)?new Map([[id,notes.get(id)!.slice(offset)]]):undefined;
  const localPicks=new Set(images.flatMap((_,idx)=>picks?.has(id+':'+(idx+offset))?[id+':'+idx]:[]));
  const values=mediaViews({media:images.map(image=>image.media),images:images.map(image=>({url:image.media.url,owner:image.owner,animated:image.animated}))},id,localNotes,localPicks,names)!;
  return values.map((value,idx)=>{
    const note=localNotes?.get(id)?.[idx];
    if(note && /未取得|未分析/.test(note))return (images[idx].owner?named(images[idx].owner,undefined,names)+'发的图：':'')+
      renderEvidence('图片',{status:'failed',reason:note.replace(/^图片（未取得：图片下载失败：/,'').replace(/）$/,''),source:'引用预览',owner:images[idx].owner});
    return value;
  });
}
export function viewMessage(row: any, names: Map<string, string>, refs: Map<string, RefTarget>, imageNotes?: Map<string, string[]>, imagePicks?: Set<string>): ViewMsg {
  const meta = metaOf(row), reply = meta.replyTo;
  const reId = reply?.kind === "bot" ? "b:" + reply.targetId : reply?.kind === "member" ? reply.targetId : undefined;
  const target = reId ? refs.get(reId) : undefined;
  const mentions = resolvedMentions(meta, names);
  const sortAt = Date.parse(row.ts) || 0;
  const material: ViewMsg["material"] = {};
  if (meta.cardView) material.card = meta.cardView;
  if (meta.forward) material.forward = renderForward(meta.forward,String(row.ts || "原始转发"));
  if (target) {
    let imageIdx = -1;
    const media = target.media?.map(item => item.startsWith("图片")
      ? imageNotes?.get(target.id)?.[++imageIdx] || item
      : item) || previewImageViews(meta,target.id,0,names,imageNotes,imagePicks);
    material.quote = {
      from: target.from,
      text: target.text.slice(0, 200),
      ...(media?.length ? { media } : {}),
    };
  }
  else if (meta.quoted) {
    const offset=(meta.media || []).filter((m:any)=>m.kind==='image').length;
    const media=previewImageViews(meta,row.id,offset,names,imageNotes,imagePicks);
    material.quote = { from: named(meta.quoted.authorId || "", meta.quoted.authorName, names), text: String(meta.quoted.text || "").slice(0, 200),...(media?.length?{media}: {}) };
  }
  const media = mediaViews(meta, row.id, imageNotes, imagePicks,names);
  if (media) material.media = media;
  const links = [...new Set<string>([...(meta.ownUrls || []), ...(meta.quotedUrls || [])])].slice(0, 5);
  if (links.length) material.links = links;
  if (row.analysed_media) material.analysed = String(row.analysed_media).slice(0, 600);
  const flags: NonNullable<ViewMsg["flags"]> = [];
  const mentionsBot = !!row.mentioned || mentions.some(m => m.isBot);
  if (mentionsBot) flags.push("mentionsYou");
  if (reply?.kind === "bot") flags.push("quotesYou");
  if (meta.addressedOther) flags.push("addressedOther");
  const v: ViewMsg = {
    id: row.id, sortAt, ord: row.ordinal || 0, at: stamp(sortAt).time,
    from: named(row.sender || "", names.get(row.sender) || meta.senderName, names), fromId: String(row.sender || "").slice(-6),
    to: addressee({ ...meta, mentionsBot }, names), re: target?.id,
    text: displayText(String(row.body || ""), mentions) || meta.placeholder || "",
    ...(Object.keys(material).length ? { material } : {}), ...(flags.length ? { flags } : {}),
  };
  mentionsOf.set(v, mentions);
  return v;
}
export function botView(o: { id: string; body: string; created_at: number; msg_id?: string | null }): ViewMsg {
  return { id: "b:" + o.id, sortAt: o.created_at, ord: 0, at: stamp(o.created_at).time, from: "你", fromId: "bot", re: o.msg_id || undefined, text: o.body };
}
export function refIdsOf(rows: any[]): { member: string[]; bot: string[] } {
  const member = new Set<string>(), bot = new Set<string>();
  for (const row of rows) {
    const r = metaOf(row).replyTo;
    if (r?.targetId && r.kind === "member") member.add(r.targetId);
    if (r?.targetId && r.kind === "bot") bot.add(r.targetId);
  }
  return { member: [...member].slice(0, 40), bot: [...bot].slice(0, 40) };
}
export function threadize(views: ViewMsg[]): ViewMsg[] {
  const parents = views.map((_, i) => i), edges = new Set<number>();
  const root = (n: number): number => parents[n] === n ? n : (parents[n] = root(parents[n]));
  const join = (a: number, b: number) => { if (a !== b) { parents[root(b)] = root(a); edges.add(a); edges.add(b); } };
  const ids = new Map(views.map((v, i) => [v.id, i]));
  views.forEach((v, i) => {
    const ref = v.re ? ids.get(v.re) : undefined;
    if (ref !== undefined) join(i, ref);
    for (const mention of mentionsOf.get(v) || []) {
      if (mention.isBot) continue;
      for (let j = i - 1; j >= 0; j--) if (views[j].fromId === mention.id.slice(-6)) { join(i, j); break; }
    }
  });
  const threads = new Map<number, number>();
  return views.map((v, i) => {
    const result = { ...v };
    delete result.th;
    if (edges.has(i)) {
      const r = root(i);
      if (!threads.has(r)) threads.set(r, threads.size + 1);
      result.th = threads.get(r);
    }
    mentionsOf.set(result, mentionsOf.get(v) || []);
    return result;
  });
}
export function buildConversation(members: ViewMsg[], bots: ViewMsg[], limit = 32): ViewMsg[] {
  // Same millisecond: members precede bots, then member rowid and stable ID (D3).
  const sorted = [...members, ...bots].sort((a, b) => a.sortAt - b.sortAt || Number(a.fromId === "bot") - Number(b.fromId === "bot") || a.ord - b.ord || a.id.localeCompare(b.id)).slice(-limit);
  const lastDate = sorted.length ? stamp(sorted[sorted.length - 1].sortAt).date : "";
  return threadize(sorted).map((v, i) => {
    const at = stamp(v.sortAt);
    const result = { ...v, at: (at.date === lastDate ? "" : at.label + " ") + at.time, text: v.text.slice(0, i >= sorted.length - 4 ? 1800 : 500) };
    mentionsOf.set(result, mentionsOf.get(v) || []);
    return result;
  });
}
export function toPrompt(v: ViewMsg) {
  const { sortAt, ord, ...prompt } = v;
  return prompt;
}
