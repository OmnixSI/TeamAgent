// QQ official bot API: access token, text / image / voice sending, inbound event parsing.
import { decodeFaces } from "./util.ts";
import type { Env } from "./util.ts";

const API = "https://api.bot.qq.com";

export class QQ {
  env: Env;
  tok: { value: string; expires: number } | null = null;
  constructor(env: Env) { this.env = env; }

  async token(force = false) {
    if (!force && this.tok && this.tok.expires > Date.now()) return this.tok.value;
    const r = await fetch(API + "/app/getAppAccessToken", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.env.QQ_APP_ID, clientSecret: this.env.QQ_APP_SECRET }),
      signal: AbortSignal.timeout(10000),
    });
    const d: any = await r.json().catch(() => ({}));
    if (!r.ok || !d.access_token) throw new Error("QQ token http " + r.status);
    this.tok = { value: d.access_token, expires: Date.now() + Math.max(60, Number(d.expires_in || 300) - 90) * 1000 };
    return this.tok.value;
  }

  async call(path: string, body?: any, method = body ? "POST" : "GET") {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch(API + path, {
        method,
        headers: { Authorization: "QQBot " + (await this.token(attempt > 0)), "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(25000),
      });
      const d: any = await r.json().catch(() => ({}));
      if (r.status === 401 && attempt === 0) continue;
      return { ok: r.ok && (d.code === undefined || d.code === 0), status: r.status, data: d };
    }
    return { ok: false, status: 401, data: {} };
  }

  gatewayUrl = async () => {
    const r = await this.call("/gateway");
    if (!r.data?.url) throw new Error("QQ gateway http " + r.status);
    return String(r.data.url);
  };

  /** conv is "g:<group_openid>" or "u:<user_openid>". */
  base(conv: string) {
    return (conv.startsWith("u:") ? "/v2/users/" : "/v2/groups/") + encodeURIComponent(conv.slice(2));
  }
  seq() { return ((Date.now() % 100_000_000) ^ Math.floor(Math.random() * 65536)) % 65536; }

  /** `quote` shows the reply as answering that message; if QQ rejects the quote the text is sent plainly. */
  async sendText(conv: string, text: string, msgId?: string, quote?: string) {
    const body = { content: text.slice(0, 4000), msg_type: 0, msg_id: msgId };
    if (quote) {
      const r = await this.call(this.base(conv) + "/messages", { ...body, msg_seq: this.seq(), message_reference: { message_id: quote } });
      if (r.ok) return r;
    }
    return this.call(this.base(conv) + "/messages", { ...body, msg_seq: this.seq() });
  }
  /** fileType 1 = image, 3 = voice (SILK), 4 = file. Uploads, then sends as a rich-media message. */
  async sendMedia(conv: string, fileType: number, dataB64: string, msgId?: string, fileName?: string) {
    const up = await this.call(this.base(conv) + "/files", { file_type: fileType, file_data: dataB64, srv_send_msg: false, ...(fileType === 4 && fileName ? { file_name: fileName } : {}) });
    if (!up.ok || !up.data?.file_info) return { ok: false, status: up.status, data: up.data, stage: "upload" };
    const sent = await this.call(this.base(conv) + "/messages", { msg_type: 7, media: { file_info: up.data.file_info }, msg_id: msgId, msg_seq: this.seq() });
    return { ...sent, stage: "send" };
  }
}

export type Inbound = {
  id: string; conv: string; sender: string; name: string; text: string; ts: number; mentioned: boolean; meta?: any;
};

/** Typed names people use for the bot when they do not use a real @; talking about "bot" counts as talking to it. */
const CALLED = /@\s*(bot|boat|机器人|奶蛙)|(^|[^a-z])(bot|boat)(?![a-z])|^\s*奶蛙/i;

export function parseEvent(type: string, d: any, aliases: string[] = []): Inbound | null {
  const group = type === "GROUP_AT_MESSAGE_CREATE" || type === "GROUP_MESSAGE_CREATE";
  const c2c = type === "C2C_MESSAGE_CREATE";
  if (!group && !c2c) return null;
  if (d.author?.bot) return null;
  const sender = String(d.author?.member_openid || d.author?.user_openid || d.author?.id || "");
  const mentions: any[] = Array.isArray(d.mentions) ? d.mentions : [];
  let text = String(d.content || "");
  for (const m of mentions) {
    const id = String(m.member_openid ?? m.id ?? "");
    if (id) text = text.split("<@" + id + ">").join(m.is_you ? "" : "@" + (m.nickname || m.username || "成员" + id.slice(-4)));
  }
  text = decodeFaces(text.replace(/<@!?[^>]+>/g, "")).trim();
  const meta: any = {};
  const images: any[] = [], files: any[] = [];
  for (const a of Array.isArray(d.attachments) ? d.attachments : []) {
    const ct = String(a.content_type || "");
    if (ct.startsWith("image/")) images.push({ url: a.url, w: a.width, h: a.height });
    else if (ct === "voice" || ct.startsWith("audio/") || a.asr_refer_text) text += (text ? " " : "") + "[语音] " + (a.asr_refer_text || "（没听清）");
    else if (ct.startsWith("video/")) meta.video = true;
    else if (a.url) files.push({ url: a.url, name: a.filename });
  }
  if (images.length) meta.images = images.slice(0, 6);
  if (files.length) meta.files = files.slice(0, 4);
  const elements: any[] = Array.isArray(d.msg_elements) ? d.msg_elements : [];
  if (elements.length) {
    const quoted = decodeFaces(elements.map(el => String(el?.content || "")).join(" ")).trim();
    const qImages = elements.flatMap(el => (el?.attachments || []).filter((a: any) => String(a.content_type || "").startsWith("image/")));
    if (quoted || qImages.length) meta.quote = { name: elements[0]?.author?.username || "", text: quoted || "[图片]", bot: !!elements[0]?.author?.bot };
    if (qImages.length && !images.length) meta.images = qImages.slice(0, 3).map((a: any) => ({ url: a.url }));
  }
  // Share cards (Bilibili, Xiaohongshu, articles…): keep the source, title and the link behind the card.
  if (d.ark_data || d.ark) {
    try {
      const ark = typeof d.ark_data === "string" ? JSON.parse(d.ark_data) : d.ark_data || d.ark;
      const fields: Record<string, any> = Array.isArray(ark.fields) ? Object.fromEntries(ark.fields.map((f: any) => [f.key, f.value])) : ark.fields || {};
      const decode = (v: any) => { let t = String(v || ""); for (let i = 0; i < 2 && /%[0-9A-Fa-f]{2}/.test(t); i++) { try { t = decodeURIComponent(t); } catch { break; } } return t; };
      const raw = decode(JSON.stringify(ark));
      const link = [fields.qqdocurl, fields.jumpUrl, fields.jump_url, fields.pcJumpUrl, fields.url].map(decode).find(u => /^https?:\/\//.test(u)) || raw.match(/https?:\/\/[^"\\\s]+/)?.[0] || "";
      const title = [ark.prompt, fields.title, fields.desc].map(v => String(v || "").trim()).filter(Boolean);
      text += (text ? " " : "") + "[分享卡片 " + [...new Set(title)].join(" / ").slice(0, 200) + (link ? " " + link : "") + "]";
    } catch {}
  }
  const named = aliases.some(a => a && text.toLowerCase().includes(a.toLowerCase()));
  const mentioned = c2c || type === "GROUP_AT_MESSAGE_CREATE" || mentions.some(m => m.is_you) || CALLED.test(text) || named || !!meta.quote?.bot;
  if (!text && !images.length && !files.length && !meta.video) return null;
  return {
    id: String(d.id), conv: c2c ? "u:" + sender : "g:" + String(d.group_openid),
    sender, name: String(d.author?.username || d.author?.nickname || ""), text,
    ts: Date.parse(d.timestamp) || Date.now(), mentioned, meta: Object.keys(meta).length ? meta : undefined,
  };
}
