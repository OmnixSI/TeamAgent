// Finding a picture by what is in it. Every picture already has words: chat pictures get a one-sentence caption when they
// arrive (msg.meta.images[i].caption), pictures the bot drew carry a note and often the request behind them (img.made), saved
// characters and stickers carry a name. Those words go into the shared meaning index (search.ts) under kind "image", with the
// picture's reference ("123-0" for chat pictures, "g12" for stored ones) as `ref`. Nothing here looks at pixels.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { clip, fmtDate, fmtFull } from "../util.ts";
import { dropText, indexText, searchText } from "./search.ts";

const DAY = 86400000;
const NEURONS_DAILY = 500;          // what indexing pictures may use per UTC day
const KEEP_LEFT = 50;               // and never when fewer than this are left today for everything else
const PER_FWD = 3, PER_BACK = 2;    // pictures indexed per tick: new ones first, then older ones
const WAIT_MS = 10 * 60000;         // a chat picture without a caption this young may still get one
const TEXT_MAX = 560;               // one passage chunk holds 600 characters
const SCAN_MAX = 800;               // rows read by the keyword fallback
const SHOW = 4, SHOWN_MATCHES = 6;

// ---------- seam to the shared index (tests replace it) ----------
type Hooks = {
  index: (hub: any, conv: string, kind: string, ref: string, title: string, text: string) => Promise<number | null>;
  search: (hub: any, conv: string, query: string, kind?: string, limit?: number) => Promise<any[] | null>;
  drop: (hub: any, conv: string, kind: string, ref: string) => void;
};
let hooks: Hooks = { index: indexText, search: searchText, drop: dropText };
export function setSearch(h: Partial<Hooks>) { hooks = { index: indexText, search: searchText, drop: dropText, ...h }; }

// ---------- which conversations ----------
const flagged = (hub: any) => { const v = String(hub.get("findimage:test") || "").trim(); return v ? (v.startsWith("t:") ? v : "t:" + v) : ""; };
export const eligible = (hub: any, conv: string) => !!conv && (!conv.startsWith("t:") || conv === flagged(hub));
const dayKey = (now: number) => "findimage:day:" + new Date(now).toISOString().slice(0, 10);
const spent = (hub: any, now: number) => Number(hub.get(dayKey(now)) || 0);

// ---------- what a picture is, in words ----------
export type Desc = { ref: string; conv: string; kind: "chat" | "mine"; ts: number; who: string; what: string; title: string; text: string; mime: string };
const rows = (hub: any, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
const imageTag = /\[(?:图片|表情|动画表情)[^\]]*\]/g;
const plain = (s: unknown) => String(s ?? "").replace(imageTag, " ").replace(/\s+/g, " ").trim();
const nameOf = (r: any) => String(r?.name || r?.sender || "群友");

/** The picture's row for a reference, or null when it no longer exists. */
export function rowFor(hub: any, conv: string, ref: string) {
  const g = ref.match(/^g(\d+)$/);
  if (g) return rows(hub, "SELECT * FROM img WHERE id=? AND conv=?", Number(g[1]), conv)[0] || null;
  if (/^\d+-\d+$/.test(ref)) return rows(hub, "SELECT * FROM img WHERE conv=? AND src=? ORDER BY id DESC LIMIT 1", conv, "chat:" + ref)[0] || null;
  return null;
}

/** Words for one `img` row. "wait" for a fresh chat picture whose caption has not arrived yet, null when there is nothing to say about it. */
export function describe(hub: any, row: any, now: number): Desc | "wait" | null {
  const conv = String(row.conv), mime = String(row.mime || "image/jpeg");
  const src = String(row.src || "");
  if (src.startsWith("chat:")) {
    const m = src.match(/^chat:(\d+)-(\d+)$/);
    if (!m) return null;
    const msg = rows(hub, "SELECT seq,ts,name,sender,text,meta FROM msg WHERE conv=? AND seq=?", conv, Number(m[1]))[0];
    let caption = "";
    try { caption = plain(JSON.parse(String(msg?.meta || "{}")).images?.[Number(m[2])]?.caption); } catch {}
    if (!msg || !caption) return Number(row.ts) > now - WAIT_MS && msg ? "wait" : null;
    const prev = rows(hub, "SELECT name,sender,text,role FROM msg WHERE conv=? AND seq<? AND role IN ('user','bot') ORDER BY seq DESC LIMIT 1", conv, Number(msg.seq))[0];
    const who = nameOf(msg), ts = Number(msg.ts);
    const lines = [caption, who + " " + fmtDate(ts) + fmtFull(ts).slice(5) + " 发的"];
    const said = plain(msg.text), before = prev ? plain(prev.text) : "";
    if (said) lines.push("这条消息：" + clip(said, 100));
    if (before) lines.push("上一条（" + (prev.role === "bot" ? "Bot" : nameOf(prev)) + "）：" + clip(before, 100));
    return { ref: m[1] + "-" + m[2], conv, kind: "chat", ts, who, what: clip(caption, 100), title: "群友发的图", text: clip(lines.join("\n"), TEXT_MAX), mime };
  }
  let made: any = null;
  try { made = row.made ? JSON.parse(String(row.made)) : null; } catch {}
  const name = String(row.name || "").replace(/^sticker:/, "表情包 "), note = plain(row.note);
  const parts: string[] = [];
  if (name) parts.push(name);
  if (note && note !== name) parts.push(note);
  if (made?.request) parts.push("要求：" + clip(plain(made.request), 160));
  if (made?.idea) parts.push("想法：" + clip(plain(made.idea), 160));
  if (!parts.length) return null;
  const what = name && !note ? name : note || clip(plain(made?.idea || made?.request), 100);
  return { ref: "g" + row.id, conv, kind: "mine", ts: Number(row.ts), who: "Bot", what: clip(what, 100), title: name || "Bot 画的图", text: clip(parts.join("\n"), TEXT_MAX), mime };
}

// ---------- indexing ----------
const cursors = (hub: any, conv: string) => {
  const kf = "findimage:fwd:" + conv, kb = "findimage:back:" + conv;
  if (hub.get(kf) == null || hub.get(kb) == null) {
    const top = String(rows(hub, "SELECT COALESCE(MAX(id),0) m FROM img WHERE conv=?", conv)[0].m);
    if (hub.get(kf) == null) hub.set(kf, top);
    if (hub.get(kb) == null) hub.set(kb, top);
  }
  return { fwd: Number(hub.get(kf)), back: Number(hub.get(kb)), kf, kb };
};

type Run = { indexed: number; skipped: number; stopped?: string };
async function lane(hub: any, conv: string, dir: "fwd" | "back", n: number, now: number, out: Run) {
  if (n <= 0) return;
  const c = cursors(hub, conv);
  const list = dir === "fwd"
    ? rows(hub, "SELECT * FROM img WHERE conv=? AND id>? ORDER BY id LIMIT ?", conv, c.fwd, n)
    : rows(hub, "SELECT * FROM img WHERE conv=? AND id<=? ORDER BY id DESC LIMIT ?", conv, c.back, n);
  if (!list.length && dir === "back" && c.back > 0) hub.set(c.kb, "0");
  for (const r of list) {
    const d = describe(hub, r, now);
    if (d === "wait" && dir === "fwd") return;
    if (d && d !== "wait") {
      if (spent(hub, now) >= NEURONS_DAILY || hub.plan.left("ai_neurons") < KEEP_LEFT) { out.stopped = "额度"; return; }
      const before = hub.plan.used("ai_neurons");
      const got = await hooks.index(hub, conv, "image", d.ref, d.title, d.text);
      if (got === null) { out.stopped = "模型没成功"; return; }
      const used = hub.plan.used("ai_neurons") - before;
      hub.set(dayKey(now), String(Math.round((spent(hub, now) + (used > 0 ? used : (d.text.length + 2) * 1.075 / 1000)) * 100) / 100));
      out.indexed++;
    } else out.skipped++;
    hub.set(dir === "fwd" ? c.kf : c.kb, String(dir === "fwd" ? Number(r.id) : Number(r.id) - 1));
  }
}

function conversations(hub: any) {
  const set = new Set<string>(rows(hub, "SELECT DISTINCT conv FROM img").map(r => String(r.conv)));
  for (const c of [String(hub.get("main") || ""), flagged(hub)]) if (c) set.add(c);
  return [...set].filter(c => eligible(hub, c));
}

/** One round of indexing: new pictures first, older ones after. Stops for the day when the allowance or the model says so. */
export async function step(hub: any, now: number, o: { fwd?: number; back?: number; convs?: string[] } = {}): Promise<Run> {
  const out: Run = { indexed: 0, skipped: 0 };
  for (const conv of o.convs || conversations(hub)) {
    if (!eligible(hub, conv)) continue;
    await lane(hub, conv, "fwd", o.fwd ?? PER_FWD, now, out);
    if (out.stopped) break;
    await lane(hub, conv, "back", o.back ?? PER_BACK, now, out);
    if (out.stopped) break;
  }
  return out;
}

/** Drops index entries whose picture is gone (chat pictures expire after 45 days, the bot's own are trimmed). */
export function sweep(hub: any) {
  let n = 0;
  for (const r of rows(hub, "SELECT DISTINCT conv, ref FROM passage WHERE kind='image' LIMIT 4000")) {
    if (!rowFor(hub, String(r.conv), String(r.ref))) { hooks.drop(hub, String(r.conv), "image", String(r.ref)); n++; }
  }
  return n;
}

const busy = new WeakSet<object>();
function tick(hub: Hub, now: number) {
  const h: any = hub;
  if (busy.has(h) || !h.env?.AI) return;
  busy.add(h);
  h.ctx.waitUntil((async () => {
    const day = dayKey(now).slice(-10);
    if (h.get("findimage:sweep") !== day) { h.set("findimage:sweep", day); sweep(h); }
    await step(h, now);
  })().catch(e => console.log("findimage index failed", e?.message)).finally(() => busy.delete(h)));
}

// ---------- searching ----------
export type Item = Desc & { score: number };

const STOP = /[的了吗呢吧啊嘛呀那这张个一些之前上次以前过里中有没吗是我你他她它们和跟与或请帮找下]+/u;
/** Terms for plain matching: whole words (weight 2) and two-character pieces of Chinese runs (weight 1). */
export function terms(query: string) {
  const out = new Map<string, number>();
  const put = (t: string, w: number) => { if (t.length >= 2 || /^\d$/.test(t)) out.set(t, Math.max(out.get(t) || 0, w)); };
  for (const run of query.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!run) continue;
    if (!/[\u4e00-\u9fff]/.test(run)) { put(run, 2); continue; }
    for (const seg of run.split(STOP)) {
      if (seg.length < 2) continue;
      put(seg, 2);
      for (let i = 0; i + 2 <= seg.length; i++) put(seg.slice(i, i + 2), 1);
    }
  }
  return out;
}

function keywordRank(hub: any, conv: string, query: string, now: number): Item[] {
  const t = terms(query);
  if (!t.size) return [];
  const total = [...t.values()].reduce((a, b) => a + b, 0), out: Item[] = [];
  for (const r of rows(hub, "SELECT * FROM img WHERE conv=? ORDER BY id DESC LIMIT ?", conv, SCAN_MAX)) {
    const d = describe(hub, r, now);
    if (!d || d === "wait") continue;
    const hay = d.text.toLowerCase();
    let got = 0;
    for (const [w, k] of t) if (hay.includes(w)) got += k;
    if (got > 0) out.push({ ...d, score: Math.round(got / total * 1000) / 1000 });
  }
  return out.sort((a, b) => b.score - a.score || b.ts - a.ts);
}

export type Args = { query: string; who?: string; days?: number; only?: string };
const keep = (d: Desc, a: Args, now: number) => {
  if (a.only === "chat" && d.kind !== "chat") return false;
  if (a.only === "mine" && d.kind !== "mine") return false;
  if (a.days && a.days > 0 && d.ts < now - a.days * DAY) return false;
  if (a.who && String(a.who).trim() && !(d.kind === "chat" && d.who.toLowerCase().includes(String(a.who).trim().toLowerCase()))) return false;
  return true;
};

/** Matches for a description, best first. Meaning search first; plain word matching when it is unavailable or finds nothing. */
export async function find(hub: any, conv: string, a: Args, now = Date.now()): Promise<{ mode: "意思" | "关键词"; note?: string; items: Item[] }> {
  const query = String(a.query || "").trim();
  const convs = [conv, ...(conv.startsWith("t:") && hub.shadow?.(conv) ? [hub.shadow(conv)] : [])];
  let hits: any[] | null = [];
  for (const c of convs) {
    let h: any[] | null = null;
    try { h = await hooks.search(hub, c, query, "image", 40); } catch (e: any) { console.log("findimage: search failed", e?.message); }
    if (h === null) { hits = null; break; }
    hits.push(...h.map(x => ({ ...x, conv: c })));
  }
  const items: Item[] = [], seen = new Set<string>();
  for (const h of hits || []) {
    const id = h.conv + "|" + h.ref;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = rowFor(hub, String(h.conv), String(h.ref));
    if (!row) { hooks.drop(hub, String(h.conv), "image", String(h.ref)); continue; }
    const d = describe(hub, row, now);
    if (!d || d === "wait" || !keep(d, a, now)) continue;
    items.push({ ...d, score: Number(h.score) });
  }
  items.sort((x, y) => y.score - x.score);
  if (hits !== null && items.length) return { mode: "意思", items: items.slice(0, SHOWN_MATCHES) };
  const words = convs.flatMap(c => keywordRank(hub, c, query, now)).filter(d => keep(d, a, now)).sort((x, y) => y.score - x.score || y.ts - x.ts).slice(0, SHOWN_MATCHES);
  const why = hits === null ? "按意思找的功能今天用不了（额度用完了），改成只按词匹配图片的文字描述，找不到不代表没有这张图。"
    : "按意思没有找到合适的，改用词匹配了一遍图片的文字描述。";
  return { mode: "关键词", note: why, items: words };
}

const dataUrl = (bytes: Uint8Array, mime: string) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return "data:" + mime + ";base64," + btoa(s);
};

async function load(ctx: any, it: Item) {
  let r: any = await ctx.host.imageRef(it.ref).catch(() => null);
  if (!r && it.conv !== ctx.conv) r = await ctx.hub.store?.imageRef?.(it.conv, it.ref).catch(() => null);
  return r as { bytes: Uint8Array; mime: string } | null;
}

const view = (it: Item) => ({
  ref: it.ref, when: fmtFull(it.ts), who: it.who, type: it.kind === "chat" ? "群友发的图" : "Bot 画的或存的图", what: it.what, score: it.score,
});

function tools(ctx: any): Tool[] {
  return [{
    name: "find_image",
    slow: true,
    description: "按内容找图：群里发过的图（最近 45 天，有文字描述的）和你自己画过、存过的图（形象、表情包）。有人说“找一下之前那张戴墨镜的小黄鸡”“上周谁发的那张报价截图”“你画过的那张奶蛙敲代码”，先来这里，不要凭印象答。" +
      "它搜的是图片的文字描述（发图时自动写的一句话、你画图时的说明和群友的要求），不是看像素，所以 query 要写图里有什么、是什么场景，像描述一张图那样写，别写“那张好看的图”。" +
      "who 只看某个群友发的图（对你自己画的图不起作用），days 只看最近几天，only=chat 只找群友发的、only=mine 只找你画的或存的。" +
      "返回最多 6 条：编号（ref，群友的图像 123-0，你的像 g12，可以直接拿去当 references 改图）、时间、谁发的、描述和相似度分数；前 4 张图会直接给你看，务必对一下图是不是真的符合，不符合就如实说没找到或换个说法再搜。" +
      "send=true 会把最相似的那张重新发到群里（只在对方明确要你把图发出来时用）。mode 是“关键词”时说明语义搜索暂时不可用，结果可能不全，要告诉对方。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "图里有什么，用自然语言描述，如“戴墨镜的小黄鸡”“报价截图”“奶蛙在敲代码”" },
        who: { type: "string", description: "只看这个群友发的图（名字）" },
        days: { type: "number", description: "只看最近几天" },
        only: { type: "string", enum: ["chat", "mine"], description: "chat 只找群友发的，mine 只找你画的或存的" },
        send: { type: "boolean", description: "把最相似的那张重新发到群里" },
      },
      required: ["query"],
    },
    run: async (a: any) => {
      const query = String(a?.query || "").trim();
      if (!query) return { ok: false, error: "要告诉我图里有什么" };
      const only = a.only === "chat" || a.only === "mine" ? a.only : undefined;
      const now = ctx.host.now?.() ?? Date.now();
      const r = await find(ctx.hub, ctx.conv, { query, who: a.who, days: Number(a.days) || undefined, only }, now);
      if (!r.items.length) return { ok: true, mode: r.mode, matches: [], note: (r.note ? r.note + " " : "") + "没有找到。能搜到的是最近 45 天群里带文字描述的图和我画过存过的图，更早的和没有描述的搜不到。" };
      const shown: Item[] = [], urls: string[] = [], loaded = new Map<string, { bytes: Uint8Array; mime: string }>();
      for (const it of r.items) {
        if (shown.length >= SHOW) break;
        const img = await load(ctx, it);
        if (!img) continue;
        shown.push(it);
        loaded.set(it.conv + "|" + it.ref, img);
        urls.push(dataUrl(img.bytes, img.mime));
      }
      const out: any = { ok: true, mode: r.mode, ...(r.note ? { note: r.note } : {}), matches: r.items.map(view), images_are_first: shown.map(s => s.ref).join("、") };
      if (urls.length) out._images = urls.slice(0, SHOW);
      if (a.send) {
        const best = r.items[0], img = loaded.get(best.conv + "|" + best.ref) || await load(ctx, best);
        if (!img) out.sent = false, out.send_error = "最相似的那张图读不出来了";
        else {
          const s = await ctx.host.sendImage(img.bytes, best.what, img.mime);
          out.sent = !!s?.ok;
          out.sent_ref = best.ref;
          if (!s?.ok) out.send_error = s?.error || "没发出去";
        }
      }
      return out;
    },
  }];
}

// ---------- admin ----------
async function admin(hub: Hub, req: Request, url: URL, body: any) {
  if (url.pathname !== "/admin/findimage") return null;
  const h: any = hub, now = Date.now();
  const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  const conv = String(body?.conv || url.searchParams.get("conv") || h.get("main") || "");
  if (!conv) return json({ error: "要 conv" }, 400);
  const out: any = {};
  if (req.method === "POST") {
    const n = Math.min(Math.max(Number(body?.backfill) || 0, 0), 60);
    if (!n) return json({ error: "POST 要 {\"backfill\":N,\"conv\":\"…\"}，N 最多 60" }, 400);
    if (!eligible(h, conv)) return json({ error: "测试房间默认不索引。先 POST /admin/set {\"k\":\"findimage:test\",\"v\":\"" + conv.replace(/^t:/, "") + "\"}" }, 400);
    out.run = await step(h, now, { convs: [conv], fwd: 0, back: n });
  }
  const q = url.searchParams.get("q");
  if (q) {
    const found = await find(h, conv, { query: q, who: url.searchParams.get("who") || undefined, days: Number(url.searchParams.get("days")) || undefined, only: (url.searchParams.get("only") as any) || undefined }, now);
    out.mode = found.mode;
    if (found.note) out.note = found.note;
    out.matches = found.items.map(i => ({ ...view(i), text: i.text }));
  }
  const c = rows(h, "SELECT COUNT(*) n, COUNT(DISTINCT ref) pics FROM passage WHERE conv=? AND kind='image'", conv)[0];
  const cur = eligible(h, conv) ? cursors(h, conv) : null;
  out.conv = conv;
  out.index = { eligible: eligible(h, conv), passages: Number(c.n), pictures: Number(c.pics), pictures_in_store: Number(rows(h, "SELECT COUNT(*) n FROM img WHERE conv=?", conv)[0].n), forward_cursor: cur?.fwd, backfill_cursor: cur?.back };
  out.neurons_today = { findimage: spent(h, now), limit: NEURONS_DAILY, all_features: h.plan.used("ai_neurons") };
  return json(out);
}

const feature: Feature = {
  name: "findimage",
  tools: tools as any,
  tick,
  admin,
  about: [
    "找图：有人想找之前的某张图（“那张戴墨镜的小黄鸡”“上周谁发的报价截图”“你画过的奶蛙敲代码”），我用 find_image 工具按内容找，找到后会把前几张图拿来对一下，确认是它再回答，需要时可以把那张图重新发出来。",
    "能搜到的是：群友最近 45 天发的、有文字描述的图（发图时会自动写一句话描述），以及我画过的所有图、存下来的形象和表情包。更早的群友图和没有描述的图搜不到。",
    "搜的是图片的文字描述（描述、谁发的、什么时候、发图前后说的话，我画的图还有当时的要求），不是看图片的像素，所以描述不到位的图可能找不到。",
    "新图会在后台悄悄建索引，旧图慢慢补；每天最多花 500 点免费 AI 额度，用完当天就停，这时找图会退回成只按词匹配。",
  ],
};
export default feature;
