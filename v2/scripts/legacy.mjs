// Converts the old D1 export (messages + outbox) into v2 rows. Used once for import and for local replay.
import fs from "node:fs";
import { decodeFaces } from "../src/util.ts";

export function loadLegacy(file) {
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const names = new Map(d.names.map(n => [n.member_id, n.name]));
  const group = d.settings.find(s => s.key === "group_id")?.value || d.msgs[0]?.group_id;
  const rows = [];
  for (const m of d.msgs) {
    let meta = {};
    try { meta = JSON.parse(m.meta || "{}"); } catch {}
    const media = Array.isArray(meta.media) ? meta.media : [];
    let text = decodeFaces(String(m.body || "")).replace(/<@!?([^>]+)>/g, (_a, id) => "@" + (names.get(id) || (meta.mentions || []).find(x => x.id === id)?.name || "成员" + id.slice(-4)));
    const voice = media.find(x => x.kind === "voice");
    if (voice?.asr && !text.trim()) text = "[语音] " + voice.asr;
    const out = {};
    const images = media.filter(x => x.kind === "image" && x.url).map(x => ({ url: x.url }));
    if (images.length) out.images = images;
    const files = media.filter(x => x.kind === "file" && x.url).map(x => ({ url: x.url, name: x.filename }));
    if (files.length) out.files = files;
    if (media.some(x => x.kind === "video")) out.video = true;
    if (meta.quoted?.text) out.quote = { name: meta.quoted.authorName || meta.replyTo?.authorName || (meta.replyTo?.kind === "bot" ? "你" : ""), text: decodeFaces(meta.quoted.text) };
    if (meta.cardView?.title) text += " [卡片：" + meta.cardView.title + (meta.cardView.url ? " " + meta.cardView.url : "") + "]";
    rows.push({
      id: m.id, role: "user", sender: m.sender, name: meta.senderName || names.get(m.sender) || "",
      text, ts: Date.parse(m.ts), mentioned: m.mentioned ? 1 : 0, meta: Object.keys(out).length ? out : undefined,
    });
  }
  for (const o of d.out) rows.push({ id: "bot:" + o.id, role: "bot", name: "Bot", text: String(o.body || ""), ts: Number(o.created_at), mentioned: 0 });
  rows.sort((a, b) => a.ts - b.ts);
  rows.forEach((r, i) => (r.seq = i + 1));
  return { conv: "g:" + group, rows, facts: d.facts, settings: d.settings };
}
