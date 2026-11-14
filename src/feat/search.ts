// Searching the chat by meaning, and the metered gateway to Workers AI (embeddings and transcription).
//
// Workers AI gives 10,000 neurons a UTC day for free; every call here is checked against the daily meter
// "ai_neurons" before it runs and counts what the model reported afterwards, and does nothing once the
// day's allowance is used up. Measured on the binding (2026-11-15): bge-m3 reports meta.neurons
// (tokens × 1075 / 1e6, Chinese about 0.7 tokens a character), whisper-large-v3-turbo reports
// usage.neurons (46.63 a minute); an 11-minute AAC clip went through in one call in 47 s.
//
// Vectors live in the Hub's SQLite, not in Vectorize. Vectorize would fit the included amounts
// ((queries + stored) × 1024 queried dimensions a month), but 9,000 stored vectors already take 92% of
// the 10 M stored dimensions, its metadata filters cover only `conv`, and inserts show up seconds later.
// A brute-force scan of 9,000 × 1024 Float32 rows costs about 25 ms of CPU and nothing billable.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { BJ, clip, fmtDate, fmtFull } from "../util.ts";

export const EMBED_MODEL = "@cf/baai/bge-m3";
export const WHISPER_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const DIM = 1024;
const EMBED_NEURONS_PER_TOKEN = 1075 / 1e6;
const WHISPER_NEURONS_PER_MINUTE = 46.63;
const EMBED_BATCH = 100;            // texts per call; 200 worked in the lab
const EMBED_TEXT_MAX = 4000;        // characters per text sent (the model takes far more; this bounds the estimate)
const AUDIO_MAX_SECONDS = 20 * 60;  // one call; longer audio is split by the caller
const AUDIO_MAX_BYTES = 25 * 1024 * 1024;

export const CAP = 9000;            // passages kept in all (chat and documents together)
const GAP_MS = 20 * 60000;          // a pause this long starts a new passage
const PASSAGE_CHARS = 600;
const LINE_CHARS = 300;             // one message's share of a passage
const INDEX_DAILY = 3000;           // neurons a day the background indexing may use
const INDEX_KEEP = 500;             // and never when fewer than this are left today for everything else
const PER_RUN = 8;                  // passages embedded per tick, forward and backfill each
const WINDOW = 400;                 // messages read per step
const DOC_CHUNKS = 60;              // chunks kept per document

// ---------- metered Workers AI ----------
// Reservations of calls in flight, so parallel calls cannot together pass the stop line.
const inflight = new WeakMap<object, number>();
async function metered<T>(hub: Hub, estimate: number, call: () => Promise<{ value: T; used?: number }>): Promise<T | null> {
  const reserved = inflight.get(hub) || 0;
  if (!hub.env.AI || !hub.plan.fits("ai_neurons", reserved + estimate)) return null;
  inflight.set(hub, reserved + estimate);
  let used = estimate;
  try {
    const out = await call();
    if (Number.isFinite(out.used) && out.used! > 0) used = out.used!;
    return out.value;
  } catch (e: any) {
    console.log("workers ai failed", e?.message);
    return null;
  } finally {
    inflight.set(hub, Math.max(0, (inflight.get(hub) || 0) - estimate));
    hub.plan.add("ai_neurons", used);
  }
}

/** Conservative token count: one per character (Chinese runs about 0.7) plus the two special tokens. */
export const embedTokens = (texts: string[]) => texts.reduce((n, t) => n + t.length + 2, 0);

function unit(v: ArrayLike<number>) {
  const out = new Float32Array(DIM);
  let s = 0;
  for (let i = 0; i < DIM; i++) { out[i] = Number(v[i]) || 0; s += out[i] * out[i]; }
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < DIM; i++) out[i] /= n;
  return out;
}

/** Unit-length bge-m3 vectors (1024), or null when today's allowance would not cover it or the model failed. */
export async function aiEmbed(hub: Hub, texts: string[]): Promise<Float32Array[] | null> {
  const clean = texts.map(t => String(t || "").replace(/\s+/g, " ").trim().slice(0, EMBED_TEXT_MAX) || "（空）");
  if (!clean.length) return [];
  const out: Float32Array[] = [];
  for (let i = 0; i < clean.length; i += EMBED_BATCH) {
    const batch = clean.slice(i, i + EMBED_BATCH);
    const got = await metered(hub, Math.ceil(embedTokens(batch) * EMBED_NEURONS_PER_TOKEN * 100) / 100, async () => {
      const r = await hub.env.AI.run(EMBED_MODEL, { text: batch });
      if (!Array.isArray(r?.data) || r.data.length !== batch.length || r.data[0]?.length !== DIM) throw new Error("bge-m3 returned " + JSON.stringify(r?.shape));
      return { value: r.data.map(unit), used: Number(r?.meta?.neurons ?? r?.usage?.neurons) };
    });
    if (!got) return null;
    out.push(...got);
  }
  return out;
}

/** Length of a PCM WAV from its header; 0 when it is not one. */
function wavSeconds(a: Uint8Array) {
  if (a.length < 44 || String.fromCharCode(...a.slice(0, 4)) !== "RIFF") return 0;
  const v = new DataView(a.buffer, a.byteOffset, a.byteLength), rate = v.getUint32(28, true);
  return rate ? (a.length - 44) / rate : 0;
}

/**
 * Speech to text on Workers AI. Null when it would not fit today's allowance, the clip is too long for one
 * call, or the model failed: the caller then uses its paid fallback. When `seconds` is unknown it is
 * estimated from the bytes as 32 kbit/s audio, which over-counts anything compressed harder.
 */
export async function aiTranscribe(hub: Hub, audio: Uint8Array, seconds: number, mime = "audio/mp4"): Promise<string | null> {
  if (!audio?.length || audio.length > AUDIO_MAX_BYTES) return null;
  const length = seconds > 0 ? seconds : wavSeconds(audio) || audio.length / 4000;
  if (length > AUDIO_MAX_SECONDS) return null;
  const estimate = Math.ceil(length / 60 * WHISPER_NEURONS_PER_MINUTE * 1.05 * 100) / 100 + 1;
  return metered(hub, estimate, async () => {
    const r = await hub.env.AI.run(WHISPER_MODEL, { audio: { body: new Blob([audio]).stream(), contentType: mime } });
    if (typeof r?.text !== "string") throw new Error("whisper returned no text");
    return { value: r.text.trim(), used: Number(r?.usage?.neurons) };
  });
}

// ---------- passages ----------
export type Msg = { seq: number; role: string; name?: string | null; sender?: string | null; text: string; ts: number; meta?: any };
export type Passage = { from_seq: number; to_seq: number; ts: number; end_ts: number; speakers: string[]; text: string; closed: boolean };

const who = (m: Msg) => (m.role === "bot" ? "Bot" : m.name || (m.sender ? "成员" + String(m.sender).slice(-4) : "成员"));
function body(m: Msg) {
  let t = String(m.text || "");
  const meta = typeof m.meta === "string" ? (() => { try { return JSON.parse(m.meta); } catch { return {}; } })() : m.meta || {};
  for (const im of meta.images || []) if (im.caption) t += " [图：" + clip(im.caption, 60) + "]";
  return clip(t.replace(/\s+/g, " ").trim(), LINE_CHARS);
}

/**
 * Consecutive messages, a new passage after a 20-minute pause or once one passes ~600 characters.
 * The last passage stays open (not to be indexed yet) until it is full or 20 minutes have passed.
 */
export function splitPassages(rows: Msg[], now: number): Passage[] {
  const out: Passage[] = [];
  let cur: Passage | null = null;
  for (const m of rows) {
    const line = who(m) + "：" + body(m);
    if (cur && (m.ts - cur.end_ts > GAP_MS || cur.text.length >= PASSAGE_CHARS)) { cur.closed = true; cur = null; }
    if (!cur) { cur = { from_seq: m.seq, to_seq: m.seq, ts: m.ts, end_ts: m.ts, speakers: [], text: "", closed: false }; out.push(cur); }
    cur.text += (cur.text ? "\n" : "") + line;
    cur.to_seq = m.seq; cur.end_ts = m.ts;
    if (m.role !== "bot" && !cur.speakers.includes(who(m))) cur.speakers.push(who(m));
  }
  if (cur && (cur.text.length >= PASSAGE_CHARS || now - cur.end_ts > GAP_MS)) cur.closed = true;
  return out;
}

/** A document cut into pieces of about 600 characters with a little overlap, at line or sentence ends where possible. */
export function chunkText(text: string, size = PASSAGE_CHARS) {
  const t = String(text || "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim(), out: string[] = [];
  let i = 0;
  while (i < t.length && out.length < DOC_CHUNKS) {
    let end = Math.min(t.length, i + size);
    if (end < t.length) {
      const cut = Math.max(t.lastIndexOf("\n", end), t.lastIndexOf("。", end), t.lastIndexOf(". ", end));
      if (cut > i + size / 2) end = cut + 1;
    }
    out.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = Math.max(end - 60, i + 1);
  }
  return out.filter(Boolean);
}

const blob = (v: Float32Array) => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
function vecOf(b: any): Float32Array {
  const u = b instanceof ArrayBuffer ? new Uint8Array(b) : b instanceof Uint8Array ? b : new Uint8Array(0);
  if (u.byteOffset % 4) return new Float32Array(u.slice().buffer);
  return new Float32Array(u.buffer, u.byteOffset, u.byteLength >> 2);
}
export function dot(a: Float32Array, b: Float32Array) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function store(hub: Hub, conv: string, kind: string, ref: string, title: string, p: { from_seq?: number; to_seq?: number; ts: number; end_ts?: number; speakers?: string[]; text: string }, v: Float32Array) {
  hub.sql.exec("INSERT INTO passage(conv,kind,ref,title,from_seq,to_seq,ts,end_ts,speakers,text,vec) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    conv, kind, ref, title, p.from_seq ?? 0, p.to_seq ?? 0, p.ts, p.end_ts ?? p.ts, (p.speakers || []).join("、"), p.text, blob(v));
}
/** Keeps at most CAP passages: the oldest chat passages go first, documents only when no chat is left. */
export function evict(hub: Hub) {
  let over = Number(hub.sql.exec("SELECT COUNT(*) n FROM passage").toArray()[0].n) - CAP;
  if (over <= 0) return 0;
  const gone = over;
  for (const kind of ["chat", ""]) {
    if (over <= 0) break;
    const where = kind ? "kind='chat'" : "1=1";
    const n = Number(hub.sql.exec("SELECT COUNT(*) n FROM passage WHERE " + where).toArray()[0].n);
    const k = Math.min(over, n);
    if (k > 0) hub.sql.exec("DELETE FROM passage WHERE id IN (SELECT id FROM passage WHERE " + where + " ORDER BY ts, id LIMIT ?)", k);
    over -= k;
  }
  return gone;
}
const count = (hub: Hub) => Number(hub.sql.exec("SELECT COUNT(*) n FROM passage").toArray()[0].n);

// ---------- documents (for other features) ----------
/** Puts a document into the index as chunks, replacing what was there under the same ref. Number of chunks, or null when today's allowance is used up. */
export async function indexText(hub: Hub, conv: string, kind: string, ref: string, title: string, text: string): Promise<number | null> {
  const chunks = chunkText(text);
  if (!chunks.length) return 0;
  const vecs = await aiEmbed(hub, chunks.map(c => (title ? title + "\n" : "") + c));
  if (!vecs) return null;
  hub.sql.exec("DELETE FROM passage WHERE conv=? AND kind=? AND ref=?", conv, kind, ref);
  const now = Date.now();
  chunks.forEach((c, i) => store(hub, conv, kind, ref, title, { ts: now, from_seq: i, to_seq: i, text: c }, vecs[i]));
  evict(hub);
  return chunks.length;
}
export function dropText(hub: Hub, conv: string, kind: string, ref: string) {
  hub.sql.exec("DELETE FROM passage WHERE conv=? AND kind=? AND ref=?", conv, kind, ref);
}

export type Hit = { id: number; conv: string; kind: string; ref: string; title: string; from_seq: number; to_seq: number; ts: number; end_ts: number; speakers: string; text: string; score: number };
type Filter = { kind?: string; since?: number; who?: string; limit?: number };

/** Brute-force cosine over the stored vectors of one conversation; rows are read one at a time so the vectors never sit in memory together. */
export function nearest(hub: Hub, conv: string, q: Float32Array, f: Filter = {}): Hit[] {
  const where = ["conv=?"], binds: any[] = [conv];
  if (f.kind) { where.push("kind=?"); binds.push(f.kind); }
  if (f.since) { where.push("end_ts>=?"); binds.push(f.since); }
  if (f.who) { where.push("speakers LIKE ?"); binds.push("%" + f.who + "%"); }
  const top: { id: number; score: number }[] = [], limit = f.limit || 6;
  for (const r of hub.sql.exec("SELECT id, vec FROM passage WHERE " + where.join(" AND "), ...binds) as Iterable<any>) {
    const score = dot(q, vecOf(r.vec));
    if (top.length < limit * 3 || score > top[top.length - 1].score) {
      top.push({ id: Number(r.id), score });
      top.sort((a, b) => b.score - a.score);
      if (top.length > limit * 3) top.pop();
    }
  }
  if (!top.length) return [];
  const rows = hub.sql.exec("SELECT id,conv,kind,ref,title,from_seq,to_seq,ts,end_ts,speakers,text FROM passage WHERE id IN (" + top.map(() => "?").join(",") + ")", ...top.map(t => t.id)).toArray();
  const byId = new Map(rows.map((r: any) => [Number(r.id), r]));
  return top.filter(t => byId.has(t.id)).slice(0, limit).map(t => {
    const r: any = byId.get(t.id);
    return { id: t.id, conv: String(r.conv), kind: String(r.kind), ref: String(r.ref), title: String(r.title || ""), from_seq: Number(r.from_seq), to_seq: Number(r.to_seq),
      ts: Number(r.ts), end_ts: Number(r.end_ts), speakers: String(r.speakers || ""), text: String(r.text), score: Math.round(t.score * 1000) / 1000 };
  });
}

/** Passages of `conv` closest in meaning to `query` (all kinds unless `kind` is given). Null when the query cannot be embedded today. */
export async function searchText(hub: Hub, conv: string, query: string, kind?: string, limit = 6): Promise<Hit[] | null> {
  const q = await aiEmbed(hub, [query]);
  if (!q) return null;
  bumpQueries(hub);
  return nearest(hub, conv, q[0], { kind, limit });
}
function bumpQueries(hub: Hub) {
  const k = "search:q:" + new Date().toISOString().slice(0, 10);
  hub.set(k, String(Number(hub.get(k) || 0) + 1));
}

// ---------- recall: meaning plus exact words ----------
/** Words worth an exact match: quoted phrases, Latin words and numbers, and short space-separated pieces. */
export function keywords(query: string) {
  const out = new Set<string>();
  for (const m of query.matchAll(/[“"「『']([^”"」』']{1,30})[”"」』']/g)) out.add(m[1].trim());
  for (const m of query.matchAll(/[A-Za-z][A-Za-z0-9_.\-]{1,30}|\d[\d.,:：\-/]*\d|\d{2,}/g)) out.add(m[0]);
  for (const w of query.split(/[\s,，、;；。？?！!]+/)) if (w.length >= 2 && w.length <= 8 && !/的那次|有没有|什么|谁说/.test(w)) out.add(w);
  return [...out].filter(w => w.length >= 2).slice(0, 5);
}

type Found = { from_seq: number; to_seq: number; ts: number; speakers: string; text: string; score: number; how: string };

export async function recall(hub: Hub, conv: string, a: { query: string; days?: number; who?: string }, now = Date.now()) {
  const query = String(a.query || "").trim();
  if (!query) return { ok: false, error: "要说清楚找什么" };
  const since = a.days && a.days > 0 ? now - a.days * 86400000 : 0, person = String(a.who || "").trim();
  const q = await aiEmbed(hub, [query]);
  if (q) bumpQueries(hub);
  const found: Found[] = q ? nearest(hub, conv, q[0], { kind: "chat", since, who: person, limit: 12 }).map(h => ({ ...h, how: "意思相近" })) : [];

  // Exact words: a passage that also contains them moves up; a message not yet indexed comes with its neighbours.
  const words = keywords(query);
  const counts = new Map<number, { m: any; n: number }>();
  for (const w of words) {
    const binds: any[] = [conv, "%" + w + "%"];
    let sql = "SELECT seq,role,name,sender,text,ts FROM msg WHERE conv=? AND text LIKE ?";
    if (since) { sql += " AND ts>=?"; binds.push(since); }
    if (person) { sql += " AND name LIKE ?"; binds.push("%" + person + "%"); }
    for (const m of hub.sql.exec(sql + " ORDER BY seq DESC LIMIT 20", ...binds).toArray() as any[]) {
      const c = counts.get(Number(m.seq)) || { m, n: 0 };
      c.n++; counts.set(Number(m.seq), c);
    }
  }
  const hits = [...counts.values()].sort((x, y) => y.n - x.n || Number(y.m.seq) - Number(x.m.seq)).slice(0, 12);
  for (const { m, n } of hits) {
    const seq = Number(m.seq), bonus = 0.08 * n;
    const inFound = found.find(f => f.from_seq <= seq && seq <= f.to_seq);
    if (inFound) { if (!inFound.how.includes("关键词")) { inFound.score += bonus; inFound.how = "意思相近，也有原话"; } continue; }
    const p = hub.sql.exec("SELECT from_seq,to_seq,ts,speakers,text FROM passage WHERE conv=? AND kind='chat' AND from_seq<=? AND to_seq>=? LIMIT 1", conv, seq, seq).toArray()[0] as any;
    if (p) { found.push({ from_seq: Number(p.from_seq), to_seq: Number(p.to_seq), ts: Number(p.ts), speakers: String(p.speakers || ""), text: String(p.text), score: 0.5 + bonus, how: "有原话" }); continue; }
    const around = hub.sql.exec("SELECT * FROM (SELECT seq,role,name,sender,text,ts,meta FROM msg WHERE conv=? AND seq<=? ORDER BY seq DESC LIMIT 3) UNION SELECT * FROM (SELECT seq,role,name,sender,text,ts,meta FROM msg WHERE conv=? AND seq>? ORDER BY seq LIMIT 2) ORDER BY seq",
      conv, seq, conv, seq).toArray() as any[];
    const part = splitPassages(around.map(r => ({ ...r, seq: Number(r.seq), ts: Number(r.ts) })), now).find(x => x.from_seq <= seq && seq <= x.to_seq);
    if (part) found.push({ from_seq: part.from_seq, to_seq: part.to_seq, ts: part.ts, speakers: part.speakers.join("、"), text: part.text, score: 0.5 + bonus, how: "有原话" });
  }

  // Overlapping excerpts are one; similar scores (within 0.03) go newest first.
  const kept: Found[] = [];
  for (const f of found.sort((x, y) => y.score - x.score)) if (!kept.some(k => k.from_seq <= f.to_seq && f.from_seq <= k.to_seq)) kept.push(f);
  const best = kept.slice(0, 6).sort((x, y) => Math.round(y.score / 0.03) - Math.round(x.score / 0.03) || y.ts - x.ts);
  return {
    ok: true,
    ...(q ? {} : { note: "今天按意思找的免费额度用完了，这次只按原话找" }),
    passages: best.map(f => ({ time: fmtDate(f.ts, BJ) + " " + fmtFull(f.ts, BJ).slice(6) + "（北京时间）", speakers: f.speakers, how: f.how, text: clip(f.text, 700), score: Math.round(f.score * 100) / 100 })),
    ...(best.length ? {} : { found: "没找到相关的聊天" }),
  };
}

// ---------- background indexing ----------
type State = { conv: string; fwd: number; back: number; done: number };
const stateOf = (hub: Hub, conv: string): State | null => {
  const r = hub.sql.exec("SELECT * FROM passage_state WHERE conv=?", conv).toArray()[0] as any;
  return r ? { conv, fwd: Number(r.fwd), back: Number(r.back), done: Number(r.done) } : null;
};
const saveState = (hub: Hub, s: State) =>
  hub.sql.exec("INSERT INTO passage_state(conv,fwd,back,done) VALUES(?,?,?,?) ON CONFLICT(conv) DO UPDATE SET fwd=excluded.fwd, back=excluded.back, done=excluded.done", s.conv, s.fwd, s.back, s.done);
const dayKey = (now: number) => "search:idx:" + new Date(now).toISOString().slice(0, 10);
const rowsOf = (list: any[]): Msg[] => list.map(r => ({ seq: Number(r.seq), role: String(r.role), name: r.name, sender: r.sender, text: String(r.text), ts: Number(r.ts), meta: r.meta }));

/** Conversations with new messages since the last look (test rooms never), each starting from the current point; older history is backfilled. */
function discover(hub: Hub, now: number) {
  const seen = Number(hub.get("search:seen") || 0);
  const fresh = hub.sql.exec("SELECT conv, MAX(seq) top FROM msg WHERE seq>? GROUP BY conv", seen).toArray() as any[];
  let top = seen;
  for (const r of fresh) {
    top = Math.max(top, Number(r.top));
    const conv = String(r.conv);
    if (conv.startsWith("t:") || stateOf(hub, conv)) continue;
    const settled = hub.sql.exec("SELECT MAX(seq) s FROM msg WHERE conv=? AND ts<?", conv, now - GAP_MS).toArray()[0] as any;
    const at = Number(settled?.s || 0);
    saveState(hub, { conv, fwd: at, back: at, done: at ? 0 : 1 });
  }
  if (top > seen) hub.set("search:seen", String(top));
}

/** New messages: complete passages after the forward mark, oldest first. */
function forward(hub: Hub, s: State, now: number, room: number) {
  const rows = rowsOf(hub.sql.exec("SELECT seq,role,name,sender,text,ts,meta FROM msg WHERE conv=? AND seq>? ORDER BY seq LIMIT ?", s.conv, s.fwd, WINDOW).toArray());
  return splitPassages(rows, now).filter(p => p.closed).slice(0, room);
}
/** Older history, newest first, stopping at the cap. A passage cut by the window's start is left for the next step. */
function backward(hub: Hub, s: State, now: number, room: number) {
  if (s.done || s.back <= 0) return { list: [] as Passage[], end: true };
  const desc = hub.sql.exec("SELECT seq,role,name,sender,text,ts,meta FROM msg WHERE conv=? AND seq<=? ORDER BY seq DESC LIMIT ?", s.conv, s.back, WINDOW).toArray();
  const all = splitPassages(rowsOf(desc.reverse()), now).map(p => ({ ...p, closed: true }));
  const end = desc.length < WINDOW;
  const usable = end || all.length < 2 ? all : all.slice(1);
  return { list: usable.slice(-room).reverse(), end: end && usable.length <= room };
}

export async function indexStep(hub: Hub, now: number) {
  discover(hub, now);
  if (hub.plan.left("ai_neurons") < INDEX_KEEP || Number(hub.get(dayKey(now)) || 0) >= INDEX_DAILY) return { indexed: 0, why: "额度" };
  const states = (hub.sql.exec("SELECT conv FROM passage_state").toArray() as any[]).map(r => stateOf(hub, String(r.conv))!).filter(Boolean);
  const jobs: { s: State; p: Passage; dir: "fwd" | "back" }[] = [];
  const back = new Map<string, boolean>();
  for (const s of states) for (const p of forward(hub, s, now, PER_RUN - jobs.length)) jobs.push({ s, p, dir: "fwd" });
  if (jobs.length < PER_RUN && count(hub) < CAP) {
    for (const s of states) {
      if (jobs.length >= PER_RUN) break;
      const b = backward(hub, s, now, Math.min(PER_RUN - jobs.length, CAP - count(hub)));
      for (const p of b.list) jobs.push({ s, p, dir: "back" });
      back.set(s.conv, b.end);
    }
  }
  if (!jobs.length) {
    for (const [conv, end] of back) if (end) { const s = stateOf(hub, conv)!; s.done = 1; saveState(hub, s); }
    return { indexed: 0 };
  }
  const before = hub.plan.used("ai_neurons");
  const vecs = await aiEmbed(hub, jobs.map(j => j.p.text));
  hub.set(dayKey(now), String(Number(hub.get(dayKey(now)) || 0) + Math.max(0, hub.plan.used("ai_neurons") - before)));
  if (!vecs) return { indexed: 0, why: "模型没成功" };
  for (let i = 0; i < jobs.length; i++) {
    const { s, p, dir } = jobs[i], cur = stateOf(hub, s.conv)!;
    store(hub, s.conv, "chat", "s" + p.from_seq, "", p, vecs[i]);
    if (dir === "fwd") cur.fwd = Math.max(cur.fwd, p.to_seq);
    else cur.back = Math.min(cur.back, p.from_seq - 1);
    saveState(hub, cur);
  }
  for (const [conv, end] of back) if (end) { const s = stateOf(hub, conv)!; if (s.back <= 0 || !hub.sql.exec("SELECT 1 FROM msg WHERE conv=? AND seq<=? LIMIT 1", conv, s.back).toArray().length) { s.done = 1; saveState(hub, s); } }
  evict(hub);
  return { indexed: jobs.length, forward: jobs.filter(j => j.dir === "fwd").length };
}

const busy = new WeakSet<object>();
function tick(hub: Hub, now: number) {
  if (busy.has(hub) || !hub.env.AI) return;
  busy.add(hub);
  hub.ctx.waitUntil(indexStep(hub, now).catch(e => console.log("search index failed", e?.message)).finally(() => busy.delete(hub)));
}

// ---------- feature ----------
const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

function status(hub: Hub) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    passages: count(hub), cap: CAP,
    by_kind: hub.sql.exec("SELECT conv, kind, COUNT(*) n, MIN(ts) oldest, MAX(ts) newest FROM passage GROUP BY conv, kind").toArray().map((r: any) => ({ ...r, oldest: fmtFull(Number(r.oldest)), newest: fmtFull(Number(r.newest)) })),
    state: hub.sql.exec("SELECT * FROM passage_state").toArray(),
    neurons_today: hub.plan.used("ai_neurons"), neurons_left_today: hub.plan.left("ai_neurons"),
    indexing_neurons_today: Number(hub.get("search:idx:" + today) || 0), indexing_daily_limit: INDEX_DAILY,
    queries_today: Number(hub.get("search:q:" + today) || 0),
  };
}

const feature: Feature = {
  name: "search",
  schema: `
    CREATE TABLE IF NOT EXISTS passage(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, kind TEXT NOT NULL, ref TEXT, title TEXT,
      from_seq INTEGER, to_seq INTEGER, ts INTEGER, end_ts INTEGER, speakers TEXT, text TEXT, vec BLOB);
    CREATE INDEX IF NOT EXISTS passage_conv ON passage(conv, kind, end_ts);
    CREATE INDEX IF NOT EXISTS passage_ref ON passage(conv, kind, ref);
    CREATE INDEX IF NOT EXISTS passage_age ON passage(kind, ts);
    CREATE TABLE IF NOT EXISTS passage_state(conv TEXT PRIMARY KEY, fwd INTEGER, back INTEGER, done INTEGER DEFAULT 0);
  `,
  tick,
  tools: ({ hub, conv }): Tool[] => [{
    name: "recall",
    description: "按意思翻以前的聊天：不知道当时原话是怎么说的时候用它，比如“上次聊到去海边的那次”“谁说过类似‘不想上班’的话”“之前讨论过换电脑的事吗”。"
      + "同时也会按原话里的人名、数字找一遍。返回最相关的 6 段聊天摘录（时间、谁在说、原文节选），不是全部记录；要某一天的完整记录用 get_history，记得确切的词用 search_history 更快更全。"
      + "最近几分钟还在聊的内容可能还没收进来。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "要找什么，用一句自然的话描述，例如“小王说的那个装修预算”" },
        days: { type: "integer", description: "只看最近几天，不填就是全部" },
        who: { type: "string", description: "只看某个人说过的，填群昵称" },
      },
      required: ["query"],
    },
    slow: true,
    run: async a => recall(hub, hub.shadow(conv) || conv, { query: String(a.query || ""), days: Number(a.days) || 0, who: a.who ? String(a.who) : "" }),
  }],
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/search") return null;
    if (req.method === "GET") {
      const q = url.searchParams.get("q"), conv = url.searchParams.get("conv") || hub.get("main") || "";
      if (!q) return json({ ok: true, ...status(hub) });
      const vec = await aiEmbed(hub, [q]);
      return json({
        ok: true, conv, query: q,
        semantic: vec ? nearest(hub, conv, vec[0], { kind: url.searchParams.get("kind") || undefined, limit: 10 }).map(h => ({ score: h.score, kind: h.kind, ref: h.ref, when: fmtFull(h.ts), speakers: h.speakers, text: clip(h.text, 300) })) : "今天的额度用完了",
        recall: await recall(hub, conv, { query: q, days: Number(url.searchParams.get("days")) || 0, who: url.searchParams.get("who") || "" }),
        keywords: keywords(q), ...status(hub),
      });
    }
    if (req.method === "POST" && body?.backfill) {
      const runs = Math.min(Math.max(1, Number(body.backfill) || 1), 50), out: any[] = [];
      for (let i = 0; i < runs; i++) { const r = await indexStep(hub, Date.now()); out.push(r); if (!r.indexed) break; }
      return json({ ok: true, runs: out, ...status(hub) });
    }
    return json({ ok: false, error: 'GET ?q=…&conv=… 试搜；POST {"backfill":N} 立刻多跑 N 步收录（每步最多 8 段）' }, 400);
  },
  about: [
    "群聊记录会在后台被切成一段一段（中间停了 20 分钟以上就另起一段，一段大约 600 字），每段算出一个表示意思的向量，存在 Bot 自己的数据库里，用来按意思找以前的聊天（recall 工具）。",
    "新消息聊完一段之后才收录，还在聊的那段要等停下来 20 分钟左右；更早的历史从新到旧慢慢补，最多保留 9000 段，再多就先删最旧的。测试房间不收录。",
    "按意思找的同时也按原话里的词（人名、数字）找一遍，结果合在一起，最多给 6 段摘录，不是完整记录。",
    "算向量和语音转文字用的是 Cloudflare Workers AI 每天的免费额度（1 万 neurons，Bot 用到 8000 就停），后台收录每天最多用 3000；当天额度用完就不再按意思找，只按原话找，第二天零点（UTC，北京时间早上 8 点）恢复。",
    "转写 B 站视频和语音时先用这份免费额度（Whisper 模型，大约每分钟 47 neurons，一天够转两个多小时），用完了才改用付费的 OpenAI 转写。",
  ],
};
export default feature;
