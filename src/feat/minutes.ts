// Meeting minutes from a recording (录音纪要). A recording (file box x12, chat file f12 or a link) is fetched
// in the cloud computer, cut into 10-minute mono 16 kHz MP3 chunks there, packed into at most a few
// bundles so one call brings everything back, transcribed chunk by chunk on Workers AI whisper
// (46.63 neurons a minute, the daily stop line is shared with everything else), and written up by the
// chat model chunk group by chunk group, then merged. The transcript is kept as a file and stored in the
// library (table `doc`, same columns library.ts writes) so the group can ask about the meeting later.
// Finished chunks live in the job's scratch state, so a restarted job does not pay for them twice.
import type { Feature, Ctx } from "./types.ts";
import type { Tool } from "../core.ts";
import { dsChat } from "../llm.ts";
import { clip } from "../util.ts";
import { sh } from "../skills/types.ts";
import { boxDownloadCommand, boxFile, boxPut } from "./filebox.ts";
import { WHISPER_MODEL, aiTranscribe, indexText } from "./search.ts";

export const CHUNK_SECONDS = 600;          // one whisper call each (the model takes up to 20 minutes)
export const KBPS = 32;                    // mono 16 kHz MP3: 240 KB a minute
export const BUNDLE_MAX = 20 * 1024 * 1024; // chunks are concatenated into bundles below the 25 MB collect limit
const MAX_BUNDLES = 6;
export const NEURONS_PER_MINUTE = 46.63;   // whisper-large-v3-turbo, measured on the binding
const SAFETY = 1.05;                       // the same margin search.ts reserves per call
export const KEEP = 300;                   // neurons left today for voice messages and everything else
const EMBED_RESERVE = 60;                  // indexing the transcript: ~36k characters of bge-m3
const PARALLEL = 3;
export const GROUP_CHARS = 12000;          // transcript characters per note-taking call
const TEXT_MAX = 60000;                    // what the library keeps per document
const URL_MAX_BYTES = 1500 * 1024 * 1024;  // the machine has 4 GB of disk
const STALE_MS = 3 * 86400000;             // a half-done job can be continued for three days
const PROMPT_ZH = "以下是普通话的会议录音，用简体中文转写。";

// ---------- arguments ----------
export type Source = { kind: "box" | "file" | "url"; ref: string };
export type Args = { source: Source; focus: string; language: string; title: string };

const LANGS: Record<string, string> = {
  中文: "zh", 普通话: "zh", 汉语: "zh", 国语: "zh", 简体中文: "zh", chinese: "zh", mandarin: "zh",
  英语: "en", 英文: "en", english: "en", 日语: "ja", 日文: "ja", japanese: "ja", 韩语: "ko", 韩文: "ko", korean: "ko",
  粤语: "yue", 广东话: "yue", cantonese: "yue", 法语: "fr", french: "fr", 德语: "de", german: "de", 西班牙语: "es", spanish: "es",
  俄语: "ru", russian: "ru", 意大利语: "it", 葡萄牙语: "pt", 越南语: "vi", 泰语: "th", 印尼语: "id", 阿拉伯语: "ar",
  自动: "", auto: "", 不知道: "",
};
/** Whisper language code; "" lets the model detect it. Unknown names are an error, not a guess. */
export function languageCode(raw: unknown): string | null {
  const t = String(raw ?? "").trim().toLowerCase();
  if (!t) return "zh";
  if (t in LANGS) return LANGS[t];
  if (/^[a-z]{2,3}$/.test(t)) return t;
  return null;
}

export function parseArgs(a: any): Args | { error: string } {
  const raw = String(a?.file ?? a?.recording ?? "").trim().replace(/^\[?(文件|视频|录音)\s*/, "").replace(/\]$/, "").trim();
  let source: Source | null = null;
  if (/^x\d+$/i.test(raw)) source = { kind: "box", ref: raw.toLowerCase() };
  else if (/^f\d+$/i.test(raw)) source = { kind: "file", ref: raw.toLowerCase() };
  else if (/^https?:\/\/[^\s]+$/i.test(raw) && raw.length <= 2000) source = { kind: "url", ref: raw };
  if (!source) return { error: raw ? "认不出这个录音：要文件箱编号（x12）、存下的文件编号（f12）或音视频链接" : "要给录音：文件箱编号（x12）、存下的文件编号（f12）或音视频链接" };
  const language = languageCode(a?.language);
  if (language === null) return { error: "不认识这个语言：" + clip(String(a.language), 20) + "，写中文名（如 英语、日语）或两个字母的代码（如 en）" };
  return { source, focus: clip(String(a?.focus ?? "").trim(), 300), language, title: clip(String(a?.title ?? "").trim(), 60) };
}

// ---------- plan and cost ----------
export type PlanChunk = { index: number; start: number; seconds: number; bytes: number };
/** How a recording of `seconds` is cut: 10-minute chunks, their MP3 size, and how many bundles carry them back. */
export function chunkPlan(seconds: number, chunk = CHUNK_SECONDS, kbps = KBPS, bundleMax = BUNDLE_MAX) {
  const chunks: PlanChunk[] = [];
  for (let start = 0; start < seconds; start += chunk) {
    const s = Math.min(chunk, seconds - start);
    chunks.push({ index: chunks.length, start, seconds: s, bytes: Math.ceil(s * kbps * 125) });
  }
  let bundles = chunks.length ? 1 : 0, fill = 0;
  for (const c of chunks) { if (fill && fill + c.bytes > bundleMax) { bundles++; fill = 0; } fill += c.bytes; }
  return { chunks, count: chunks.length, bytes: chunks.reduce((n, c) => n + c.bytes, 0), bundles };
}
/** Neurons reserved for one whisper call of `seconds`, as the meter counts it. */
export const callNeurons = (seconds: number) => Math.ceil(seconds / 60 * NEURONS_PER_MINUTE * SAFETY * 100) / 100 + 1;
/** Neurons the whole recording will take: every chunk's call plus indexing the transcript. */
export function estimateNeurons(seconds: number, chunk = CHUNK_SECONDS) {
  return Math.ceil(chunkPlan(seconds, chunk).chunks.reduce((n, c) => n + callNeurons(c.seconds), 0) + EMBED_RESERVE);
}
/** Whole minutes of recording that `left` neurons cover today after the reserve for everything else. */
export function affordableMinutes(left: number) {
  const spare = left - KEEP - EMBED_RESERVE;
  if (spare <= 2) return 0;
  // a call per 10 minutes adds one neuron on top of the per-minute rate, plus one for the last short chunk
  return Math.max(0, Math.floor((spare - 2) / (NEURONS_PER_MINUTE * SAFETY + 0.1)));
}
export const minutesText = (seconds: number) => {
  const m = Math.round(seconds / 60);
  return m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? " " + (m % 60) + " 分钟" : "") : Math.max(1, m) + " 分钟";
};
/** Null when a recording of `seconds` may go ahead; otherwise one plain sentence. */
export function refusal(seconds: number, left: number, maxMinutes: number): string | null {
  if (seconds > maxMinutes * 60 + 1) return "这段录音有 " + minutesText(seconds) + "，超过了一次最多 " + maxMinutes + " 分钟（minutes_max_minutes），先剪短或分段再发。";
  const need = estimateNeurons(seconds);
  if (need + KEEP <= left) return null;
  const can = affordableMinutes(left);
  return "这段录音有 " + minutesText(seconds) + "，转写要约 " + need + " neurons，今天的 AI 额度只剩 " + Math.round(left) + "，" +
    (can >= 1 ? "只够转约 " + can + " 分钟" : "已经不够转了") + "；额度每天 8 点（北京时间）重置，明天再来。";
}

// ---------- cloud-computer steps ----------
export function fetchUrlCommand(dir: string, url: string, maxBytes = URL_MAX_BYTES) {
  return "mkdir -p " + sh("/work/" + dir) + " && curl -fsSL --retry 2 --connect-timeout 20 --max-filesize " + maxBytes +
    " -A 'Mozilla/5.0' -o " + sh("/work/" + dir + "/in.media") + " " + sh(url) +
    " || { echo " + sh("录音链接下载失败（打不开、要登录，或者超过 " + Math.round(maxBytes / 1048576) + " MB）") + " >&2; exit 1; }";
}
export function moveCommand(dir: string, putName: string) {
  return "mkdir -p " + sh("/work/" + dir) + " && mv -f " + sh("/work/" + putName) + " " + sh("/work/" + dir + "/in.media");
}
/**
 * Probes the input, converts it to mono 16 kHz MP3 chunks and concatenates them into bundles. Prints
 * `DURATION s`, then `TOOLONG s` / `NOAUDIO`, or one `CHUNK bundle offset size seconds` per chunk.
 * Nothing that came from a person reaches this script: the input always sits at ./in.media.
 */
export function convertScript(dir: string, limitSeconds: number, chunk = CHUNK_SECONDS, kbps = KBPS, bundleMax = BUNDLE_MAX) {
  const limit = Math.max(1, Math.floor(limitSeconds));
  return [
    "cd " + sh("/work/" + dir) + " || exit 1",
    "IN=in.media",
    "[ -s \"$IN\" ] || { echo " + sh("录音文件没拿到") + " >&2; exit 1; }",
    "if [ -z \"$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 \"$IN\" 2>/dev/null | head -1)\" ]; then echo NOAUDIO; rm -f \"$IN\"; exit 0; fi",
    "D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 \"$IN\" 2>/dev/null | head -1 | cut -d. -f1)",
    "case \"$D\" in ''|*[!0-9]*) D='' ;; esac",
    "echo \"DURATION ${D:-?}\"",
    "if [ -n \"$D\" ] && [ \"$D\" -gt " + limit + " ]; then echo \"TOOLONG $D\"; rm -f \"$IN\"; exit 0; fi",
    "ffmpeg -nostdin -v error -y -i \"$IN\" -map 0:a:0 -vn -sn -dn -ac 1 -ar 16000 -c:a libmp3lame -b:a " + kbps + "k -t " + (limit + 2) +
      " -f segment -segment_time " + chunk + " -reset_timestamps 1 c%03d.mp3 || { echo " + sh("转换音频失败，文件可能坏了或不是音视频") + " >&2; exit 1; }",
    "rm -f \"$IN\"",
    "b=0; off=0",
    "for f in c[0-9][0-9][0-9].mp3; do",
    "  [ -f \"$f\" ] || continue",
    "  s=$(wc -c < \"$f\" | tr -d ' ')",
    "  d=$(ffprobe -v error -show_entries format=duration -of csv=p=0 \"$f\" 2>/dev/null | head -1)",
    "  if [ \"$off\" -gt 0 ] && [ $((off + s)) -gt " + bundleMax + " ]; then b=$((b + 1)); off=0; fi",
    "  cat \"$f\" >> \"b$b.bin\" && rm -f \"$f\"",
    "  echo \"CHUNK $b $off $s ${d:-0}\"",
    "  off=$((off + s))",
    "done",
  ].join("\n");
}

export type Chunk = { index: number; bundle: number; offset: number; size: number; seconds: number; start: number };
export type Manifest = { duration: number | null; tooLong: number | null; noAudio: boolean; chunks: Chunk[] };
export function parseManifest(stdout: string): Manifest {
  const m: Manifest = { duration: null, tooLong: null, noAudio: false, chunks: [] };
  let at = 0;
  for (const line of String(stdout || "").split("\n")) {
    const w = line.trim().split(/\s+/);
    if (w[0] === "DURATION" && /^\d+$/.test(w[1] || "")) m.duration = Number(w[1]);
    else if (w[0] === "TOOLONG") m.tooLong = Number(w[1]) || 0;
    else if (w[0] === "NOAUDIO") m.noAudio = true;
    else if (w[0] === "CHUNK" && w.length >= 5) {
      const [bundle, offset, size, seconds] = w.slice(1, 5).map(Number);
      if (![bundle, offset, size, seconds].every(Number.isFinite) || size <= 0) continue;
      m.chunks.push({ index: m.chunks.length, bundle, offset, size, seconds, start: Math.round(at * 100) / 100 });
      at += seconds;
    }
  }
  return m;
}
/** The chunk's bytes out of the collected bundles (keyed by file name, "b0.bin"); null when a bundle is missing or short. */
export function sliceChunk(c: Chunk, bundles: Map<string, Uint8Array>): Uint8Array | null {
  const b = bundles.get("b" + c.bundle + ".bin");
  if (!b || c.offset + c.size > b.length) return null;
  return b.subarray(c.offset, c.offset + c.size);
}

// ---------- transcripts ----------
/** "12:05" below an hour, "1:02:05" from an hour on. */
export function stamp(seconds: number, long = seconds >= 3600) {
  const s = Math.max(0, Math.floor(seconds)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  return (long ? h + ":" + String(m).padStart(2, "0") : String(m + h * 60).padStart(2, "0")) + ":" + String(r).padStart(2, "0");
}
/** Whisper loops on silence ("谢谢观看" forty times); keep a sentence at most twice in a row. */
export function squeezeRepeats(text: string) {
  const parts = String(text || "").split(/(?<=[。！？!?.,，])/);
  const out: string[] = [];
  let run = 0;
  for (const p of parts) {
    const k = p.replace(/[\s。！？!?.,，]/g, "");
    const prev = out.length ? out[out.length - 1].replace(/[\s。！？!?.,，]/g, "") : null;
    if (k && k === prev) { if (++run >= 2) continue; } else run = 0;
    out.push(p);
  }
  return out.join("").trim();
}
export type Line = [number, string];
/** Lines of about a minute each, stamped with their time in the whole recording. */
export function toLines(start: number, text: string, segments?: { start: number; text: string }[], every = 60): Line[] {
  const segs = (segments || []).filter(s => String(s.text || "").trim());
  if (!segs.length) { const t = squeezeRepeats(text); return t ? [[start, t]] : []; }
  const out: Line[] = [];
  let cur: Line | null = null;
  for (const s of segs) {
    const at = start + Math.max(0, Number(s.start) || 0);
    if (!cur || at - cur[0] >= every) { cur = [Math.round(at), ""]; out.push(cur); }
    cur[1] += (cur[1] ? " " : "") + String(s.text).trim();
  }
  return out.map(([at, t]) => [at, squeezeRepeats(t)] as Line).filter(l => l[1]);
}
export type Done = { start: number; seconds: number; lines?: Line[]; failed?: boolean };
export function transcriptText(chunks: Done[], long: boolean) {
  const out: string[] = [];
  for (const c of chunks) {
    if (c.failed) out.push("[" + stamp(c.start, long) + "] （这一段没转出来）");
    else for (const [at, t] of c.lines || []) out.push("[" + stamp(at, long) + "] " + t);
  }
  return out.join("\n");
}
/** Transcript lines grouped so each note-taking call stays under `max` characters. */
export function groupLines(chunks: Done[], long: boolean, max = GROUP_CHARS): string[] {
  const groups: string[] = [];
  let cur = "";
  for (const line of transcriptText(chunks, long).split("\n").filter(Boolean)) {
    const l = clip(line, max);
    if (cur && cur.length + l.length + 1 > max) { groups.push(cur); cur = ""; }
    cur += (cur ? "\n" : "") + l;
  }
  if (cur) groups.push(cur);
  return groups;
}

// ---------- speech to text ----------
const inflight = new WeakMap<object, number>();
export type Heard = { text: string; segments?: { start: number; text: string }[] } | "budget" | null;
/**
 * One chunk through whisper with the language set (a Chinese prompt keeps it to simplified characters),
 * counted on the daily meter. If the call with options fails, the plain gateway in search.ts is tried once.
 */
export async function hear(hub: any, audio: Uint8Array, seconds: number, language: string): Promise<Heard> {
  const estimate = callNeurons(seconds), reserved = inflight.get(hub) || 0;
  if (!hub.env?.AI || !hub.plan.fits("ai_neurons", reserved + estimate)) return "budget";
  inflight.set(hub, reserved + estimate);
  let used = estimate;
  try {
    const input: any = { audio: { body: new Blob([audio]).stream(), contentType: "audio/mpeg" }, vad_filter: true };
    if (language) input.language = language;
    if (language === "zh") input.initial_prompt = PROMPT_ZH;
    const r = await hub.env.AI.run(WHISPER_MODEL, input);
    if (Number(r?.usage?.neurons) > 0) used = Number(r.usage.neurons);
    if (typeof r?.text !== "string") throw new Error("whisper returned no text");
    const segments = Array.isArray(r.segments) ? r.segments.map((s: any) => ({ start: Number(s.start) || 0, text: String(s.text || "") })) : undefined;
    return { text: r.text.trim(), segments };
  } catch (e: any) {
    console.log("minutes: whisper failed", e?.message);
  } finally {
    inflight.set(hub, Math.max(0, (inflight.get(hub) || 0) - estimate));
    hub.plan.add("ai_neurons", used);
  }
  if (!hub.plan.fits("ai_neurons", callNeurons(seconds))) return "budget";
  const text = await aiTranscribe(hub, audio, seconds, "audio/mpeg").catch(() => null);
  return text === null ? null : { text };
}

// ---------- writing the minutes ----------
export type Item = { text: string; at?: string };
export type Action = { task: string; who?: string; due?: string; at?: string };
export type Notes = { title?: string; summary?: string; points: string[]; decisions: Item[]; actions: Action[]; questions: string[]; timeline: Item[]; focus?: string };

const RULES = "这是自动语音识别的转写稿，可能有同音错字，也没有区分说话人。只写稿子里明确说到的内容：不要编人名、不要编决定、不要补稿子里没有的细节；" +
  "who（负责人）和 due（截止时间）只有录音里明确说了才填，否则留空字符串；说话人没点名就不要猜是谁说的。at 填最接近的方括号里的时间（照抄格式）。";
const SHAPE = "{\"points\":[\"要点\"],\"decisions\":[{\"text\":\"定下来的事\",\"at\":\"12:30\"}],\"actions\":[{\"task\":\"要做的事\",\"who\":\"\",\"due\":\"\",\"at\":\"\"}],\"questions\":[\"还没定或没答上的问题\"],\"timeline\":[{\"at\":\"00:00\",\"text\":\"这段在讲什么\"}]}";

const arr = (v: any) => (Array.isArray(v) ? v : []);
const s = (v: any, n = 300) => clip(String(v ?? "").replace(/\s+/g, " ").trim(), n);
export function cleanNotes(j: any): Notes {
  return {
    title: s(j?.title, 40) || undefined, summary: s(j?.summary, 600) || undefined, focus: s(j?.focus, 800) || undefined,
    points: arr(j?.points).map((x: any) => s(x)).filter(Boolean),
    decisions: arr(j?.decisions).map((x: any) => (typeof x === "string" ? { text: s(x) } : { text: s(x?.text), at: s(x?.at, 10) || undefined })).filter((x: Item) => x.text),
    actions: arr(j?.actions).map((x: any) => (typeof x === "string" ? { task: s(x) } : { task: s(x?.task ?? x?.text), who: s(x?.who, 40) || undefined, due: s(x?.due, 40) || undefined, at: s(x?.at, 10) || undefined })).filter((x: Action) => x.task),
    questions: arr(j?.questions).map((x: any) => s(typeof x === "string" ? x : x?.text)).filter(Boolean),
    timeline: arr(j?.timeline).map((x: any) => ({ text: s(x?.text, 120), at: s(x?.at, 10) || undefined })).filter((x: Item) => x.text),
  };
}
export function parseJson(text: string): any | null {
  const m = String(text || "").replace(/```(json)?/g, "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}
const key = (t: string) => t.replace(/[\s，。,.、；;：:！!？?“”"'（）()]/g, "");
/** Joins part notes in time order without a model: everything kept, exact repeats dropped. */
export function mergeNotes(parts: Notes[]): Notes {
  const out: Notes = { points: [], decisions: [], actions: [], questions: [], timeline: [] };
  const seen = new Set<string>();
  const add = <T>(list: T[], kind: string, item: T, k: string) => { if (!k || seen.has(kind + k)) return; seen.add(kind + k); list.push(item); };
  for (const p of parts) {
    for (const x of p.points) add(out.points, "p", x, key(x));
    for (const x of p.decisions) add(out.decisions, "d", x, key(x.text));
    for (const x of p.actions) add(out.actions, "a", x, key(x.task));
    for (const x of p.questions) add(out.questions, "q", x, key(x));
    for (const x of p.timeline) add(out.timeline, "t", x, key((x.at || "") + x.text));
  }
  out.title = parts.find(p => p.title)?.title;
  out.summary = parts.map(p => p.summary).filter(Boolean).join(" ") || out.points.slice(0, 4).join("；") || undefined;
  out.focus = parts.map(p => p.focus).filter(Boolean).join(" ") || undefined;
  return out;
}
/** Keeps only stamps that look like times inside the recording. */
export function cleanAt(at: string | undefined, seconds: number) {
  const m = String(at || "").match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return "";
  const t = m[3] !== undefined ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
  return t <= seconds + 60 ? stamp(t, seconds >= 3600) : "";
}
export const SPEAKER_NOTE = "（转写不区分说话人：只有录音里点了名的才写了是谁。）";
/** The minutes as plain text for the chat (QQ shows no Markdown). */
export function renderMinutes(n: Notes, meta: { title: string; seconds: number; focus?: string; missing?: number }) {
  const at = (x?: string) => { const t = cleanAt(x, meta.seconds); return t ? "（" + t + "）" : ""; };
  const out: string[] = ["《" + meta.title + "》纪要 · 录音 " + minutesText(meta.seconds)];
  if (n.summary) out.push("", "【概要】", n.summary);
  if (meta.focus && n.focus) out.push("", "【关于" + clip(meta.focus, 30) + "】", n.focus);
  if (n.decisions.length) out.push("", "【定下来的事】", ...n.decisions.map((d, i) => (i + 1) + ". " + d.text + at(d.at)));
  if (n.actions.length) out.push("", "【待办】", ...n.actions.map((a, i) => (i + 1) + ". " + a.task + [a.who ? "负责：" + a.who : "", a.due ? "截止：" + a.due : ""].filter(Boolean).map(x => "，" + x).join("") + at(a.at)));
  if (n.questions.length) out.push("", "【还没定的问题】", ...n.questions.map(q => "· " + q));
  const tl = n.timeline.map(t => ({ t: cleanAt(t.at, meta.seconds), text: t.text })).filter(t => t.t);
  if (tl.length) out.push("", "【时间线】", ...tl.slice(0, 20).map(t => t.t + " " + t.text));
  if (!n.summary && !n.decisions.length && !n.actions.length && n.points.length) out.push("", "【要点】", ...n.points.slice(0, 12).map(p => "· " + p));
  if (n.decisions.length || n.actions.length) out.push("", SPEAKER_NOTE);
  if (meta.missing) out.push("有 " + meta.missing + " 段（每段 10 分钟）没转出来，那部分没写进纪要。");
  return out.join("\n");
}

async function askJson(env: any, system: string, user: string, effort: "none" | "high", maxTokens: number) {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await dsChat(env, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens, label: "录音纪要" }, effort, 150000);
      const j = parseJson(String(r.message?.content || ""));
      if (j) return j;
    } catch (e: any) { console.log("minutes: model failed", e?.message); }
  }
  return null;
}
const focusLine = (focus: string) => (focus ? "群友特别关心：" + focus + "。把和它有关的内容写全，并在 focus 字段里用几句话专门回答（录音没提到就照实说没提到）。" : "");

/** Map over transcript groups, then one merge; a single group is written up directly. */
export async function writeMinutes(env: any, groups: string[], o: { focus: string; seconds: number; name: string }): Promise<Notes> {
  const head = "录音总长 " + minutesText(o.seconds) + "，文件名：" + clip(o.name, 80) + "。";
  const finalShape = SHAPE.replace("{\"points\"", "{\"title\":\"一个短标题，15字内\",\"summary\":\"3到5句话的概要\",\"focus\":\"\",\"points\"");
  if (groups.length === 1) {
    const j = await askJson(env, "你在给一段会议、讲座或通话的录音写纪要。" + RULES + focusLine(o.focus) + "时间线每 3 到 8 分钟一条。只输出 JSON：" + finalShape, head + "\n转写稿：\n" + groups[0], "high", 8000);
    return cleanNotes(j || {});
  }
  const parts: Notes[] = new Array(groups.length);
  let next = 0;
  await Promise.all([0, 1, 2].map(async () => {
    for (;;) {
      const i = next++; if (i >= groups.length) return;
      const j = await askJson(env, "你在给一段长录音分段记笔记，这是第 " + (i + 1) + "/" + groups.length + " 部分。" + RULES + focusLine(o.focus) +
        "要点、决定、待办、问题一条都别漏；时间线每 3 到 8 分钟一条。只输出 JSON：" + SHAPE.replace("{\"points\"", "{\"focus\":\"\",\"points\""), head + "\n这一部分的转写稿：\n" + groups[i], "none", 2500);
      parts[i] = cleanNotes(j || {});
    }
  }));
  const union = mergeNotes(parts);
  const j = await askJson(env, "下面是同一段录音按时间顺序分段记下的笔记（JSON）。合并成一份纪要：去掉重复，同一件事合成一条；决定、待办和问题不要丢；时间线保留 8 到 20 条，覆盖整段录音。" + RULES + focusLine(o.focus) +
    "只输出 JSON：" + finalShape, head + "\n" + JSON.stringify(parts.map((p, i) => ({ part: i + 1, ...p }))), "high", 10000);
  if (!j) return union;
  const merged = cleanNotes(j);
  // A merge that lost a whole kind of item is not trusted for that kind.
  for (const k of ["decisions", "actions", "questions", "timeline"] as const) if (!merged[k].length && union[k].length) (merged as any)[k] = union[k];
  merged.summary ||= union.summary;
  return merged;
}

// ---------- library ----------
/** Inserts or replaces the meeting in the library's `doc` table (same columns library.ts writes) and its indexes. */
export async function saveDoc(hub: any, conv: string, by: string, d: { url: string; title: string; summary: string; text: string }): Promise<number> {
  const fts = (() => { try { return hub.sql.exec("SELECT 1 FROM sqlite_master WHERE name='doc_fts'").toArray().length > 0; } catch { return false; } })();
  const text = d.text.length > TEXT_MAX ? d.text.slice(0, TEXT_MAX) : d.text;
  const old = hub.sql.exec("SELECT * FROM doc WHERE conv=? AND url=?", conv, d.url).toArray()[0];
  let id: number;
  if (old) {
    if (fts && old.status === "ok") { try { hub.sql.exec("INSERT INTO doc_fts(doc_fts, rowid, title, summary, text) VALUES('delete',?,?,?,?)", old.id, old.title, old.summary, old.text); } catch { /* index is optional */ } }
    hub.sql.exec("UPDATE doc SET title=?, summary=?, text=?, chars=?, status='ok', tries=0, retry_at=0, ts=?, kind='minutes' WHERE id=?", d.title, d.summary, text, d.text.length, Date.now(), old.id);
    id = Number(old.id);
  } else {
    id = Number(hub.sql.exec(
      "INSERT INTO doc(conv, ts, seq, by, kind, url, title, summary, text, chars, status, tries, retry_at) VALUES(?,?,0,?,'minutes',?,?,?,?,?,'ok',0,0) RETURNING id",
      conv, Date.now(), by, d.url, d.title, d.summary, text, d.text.length).toArray()[0].id);
  }
  if (fts) { try { hub.sql.exec("INSERT INTO doc_fts(rowid, title, summary, text) VALUES(?,?,?,?)", id, d.title, d.summary, text); } catch (e: any) { console.log("minutes: fts put failed", e?.message); } }
  try { await indexText(hub, conv, "doc", String(id), d.title, text); } catch (e: any) { console.log("minutes: semantic index failed", e?.message); }
  return id;
}

// ---------- the tool ----------
export type State = { v: 1; src: string; lang: string; at: number; seconds: number; name: string; chunks: Done[] };
/** Short, stable scratch key for a source. */
export function stateKey(src: Source, language: string) {
  let h = 2166136261;
  for (const ch of src.kind + ":" + src.ref + ":" + language) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  return "minutes:" + h.toString(36);
}
const fileName = (s: string) => clip(s.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, ""), 40) || "录音";

function tools(ctx: Ctx): Tool[] {
  const { host, conv } = ctx, hub: any = ctx.hub;
  return [{
    name: "minutes", work: true, slow: true, long: true,
    description: "录音纪要：把会议、讲座、电话的录音或视频（常见 30 到 120 分钟）转成文字，写成纪要：概要、定下来的事、待办（负责人和截止时间只写录音里说了的）、还没定的问题、带时间点的时间线。" +
      "file 填录音：文件箱编号 x12（大文件让群友用 filebox 的上传页传，最常见）、存下的文件编号 f12、或音视频文件的直链。focus 填群友特别关心的事（可空）；录音不是中文就在 language 写语言（如 英语、日语），默认中文；title 可给个名字。" +
      "一次最长 " + (Number(host.cfg("minutes_max_minutes")) || 120) + " 分钟。转写花每天的免费 AI 额度：每分钟约 47 neurons，一小时约 2900，全站一天共 8000；不够时会直接说今天还能转多少分钟，照实转告。要几分钟到十几分钟，开工前先在群里说一声。" +
      "返回 minutes（纪要正文，原样发群里）、transcript_file（完整转写稿 txt 的编号，群友要就发给他们）和 library_id（已存进资料库，以后问这次会的细节用 library 查）。同一个录音做到一半断了，再叫一次会接着做，已转好的不重复花额度。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "录音：x12（文件箱）、f12（存下的文件）、群文件链接或音视频直链" },
        focus: { type: "string", description: "群友特别关心的事，如 预算、谁负责上线；没说就不填" },
        language: { type: "string", description: "录音的语言，默认中文；英语、日语等写中文名或 en、ja" },
        title: { type: "string", description: "会议名字，群友说了才填" },
      },
      required: ["file"],
    },
    run: async (a: any) => {
      const p = parseArgs(a);
      if ("error" in p) return { ok: false, error: p.error };
      const maxMinutes = Math.max(1, Number(host.cfg("minutes_max_minutes")) || 120);
      const skey = stateKey(p.source, p.language);
      let st: State | null = host.scratch(skey);
      if (st && (st.v !== 1 || host.now() - st.at > STALE_MS)) st = null;
      const left = hub.plan.left("ai_neurons");

      // Refuse before the machine starts when today's allowance cannot cover the rest.
      if (st) {
        const rest = st.chunks.filter(c => !c.lines).reduce((n, c) => n + c.seconds, 0);
        const need = st.chunks.filter(c => !c.lines).reduce((n, c) => n + callNeurons(c.seconds), 0) + EMBED_RESERVE;
        if (rest > 0 && need + KEEP > left) return { ok: false, error: "这段录音还剩 " + minutesText(rest) + " 没转，要约 " + Math.ceil(need) + " neurons，今天的 AI 额度只剩 " + Math.round(left) + "；已转好的留着，明天再叫我接着转。" };
      } else {
        const can = Math.min(maxMinutes, affordableMinutes(left));
        if (can < 1) return { ok: false, error: "今天的 AI 额度只剩 " + Math.round(left) + " neurons，已经不够转录音了；额度每天 8 点（北京时间）重置，明天再来。" };
        if (!(await host.quota("minutes", Number(host.cfg("minutes_daily"))))) return { ok: false, error: "今天做录音纪要的次数用完了（minutes_daily）" };
      }

      let note = "", machine = 0;
      // Chunks that failed last time are tried again; finished ones are never paid for twice.
      if (!st || st.chunks.some(c => !c.lines)) {
        // ---- 1. audio in the cloud computer ----
        const dir = "minutes-" + host.now().toString(36) + Math.random().toString(36).slice(2, 6), putName = dir + ".in";
        const files: { name: string; bytes: Uint8Array }[] = [];
        let fetch = "", name = p.title, size = 0;
        if (p.source.kind === "box") {
          const f = boxFile(hub, conv, p.source.ref);
          const cmd = f ? boxDownloadCommand(hub, conv, p.source.ref, "/work/" + dir + "/in.media") : null;
          if (!f || !cmd) return { ok: false, error: "文件箱里没有 " + p.source.ref + "（可能过期了），让群友重新传一次" };
          fetch = cmd; name ||= f.name; size = f.size;
        } else if (p.source.kind === "url" && !hub.sql.exec("SELECT 1 FROM blob WHERE conv=? AND src=? LIMIT 1", conv, p.source.ref).toArray().length) {
          fetch = fetchUrlCommand(dir, p.source.ref);
          const tail = p.source.ref.split(/[?#]/)[0].split("/").pop() || "";
          try { name ||= decodeURIComponent(tail); } catch { name ||= tail; }
        } else {
          const f = await host.fileRef(p.source.ref).catch(() => null);
          if (!f) return { ok: false, error: "没找到这个文件（" + clip(p.source.ref, 60) + "），让群友重发一次或用文件箱上传" };
          name ||= f.name; size = f.bytes.length;
          if (f.bytes.length <= 24 * 1024 * 1024) { files.push({ name: putName, bytes: f.bytes }); fetch = moveCommand(dir, putName); }
          else {
            const boxed = await boxPut(hub, conv, f.name, f.bytes, 1);
            const cmd = boxed ? boxDownloadCommand(hub, conv, boxed.ref, "/work/" + dir + "/in.media") : null;
            if (!cmd) return { ok: false, error: "文件太大，没能放进文件箱，让群友用 filebox 的上传页传" };
            fetch = cmd;
          }
        }
        const limit = st ? Math.ceil(st.seconds) + 2 : Math.min(maxMinutes, affordableMinutes(left)) * 60;
        if (!st) await host.say("收到，开始处理录音" + (name ? "「" + clip(name, 30) + "」" : "") + "，转写加整理要几分钟到十几分钟").catch(() => false);
        let out: any;
        try {
          out = await host.computer({ commands: [fetch, convertScript(dir, limit)], files, collect: [dir + "/b*.bin"], timeoutSeconds: 1500 });
        } finally {
          // Its own directory goes either way; the disk is wiped when the machine sleeps anyway.
          await host.computer({ commands: ["rm -rf " + sh("/work/" + dir) + " " + sh("/work/" + putName)], timeoutSeconds: 30 }).catch(() => null);
        }
        const failed = out.steps.find((x: any) => x.exit !== 0);
        if (failed || out.error) return { ok: false, error: (failed ? clip((failed.stderr || failed.stdout).trim().split("\n").pop() || "", 160) : "") || "云电脑出错：" + clip(out.error || "", 160) };
        const m = parseManifest(out.steps[1]?.stdout || "");
        if (m.noAudio) return { ok: false, error: "这个文件里没有声音" };
        const total = m.chunks.reduce((n, c) => n + c.seconds, 0);
        // ffmpeg stops at limit + 2 s, so a recording of unknown length that ran past the limit shows up here.
        if (m.tooLong !== null || (!st && total > limit + 1)) {
          const seconds = m.tooLong || total;
          return { ok: false, error: refusal(seconds, left, maxMinutes) || "这段录音太长了（" + minutesText(seconds) + "以上）" };
        }
        if (!m.chunks.length) return { ok: false, error: "没转出音频来，文件可能坏了" };
        const fresh = !st || st.chunks.length !== m.chunks.length;
        if (fresh) {
          const r = refusal(total, left, maxMinutes);
          if (r) { host.scratch(skey, null); return { ok: false, error: r }; }
        }
        const bundles = new Map<string, Uint8Array>(out.files.map((f: any) => [String(f.name).split("/").pop(), f.bytes] as [string, Uint8Array]));
        const s1: State = !st || fresh ? { v: 1, src: p.source.ref, lang: p.language, at: host.now(), seconds: total, name: name || "录音", chunks: m.chunks.map(c => ({ start: c.start, seconds: c.seconds })) } : st;
        st = s1;
        s1.at = host.now();
        host.scratch(skey, s1);
        machine = out.seconds + 90;
        note = "云电脑用了 " + Math.round(out.seconds) + " 秒" + (size ? "，原文件 " + Math.round(size / 1048576) + " MB" : "");

        // ---- 2. speech to text, a few chunks at a time ----
        const todo = s1.chunks.map((_c, i) => i).filter(i => !s1.chunks[i].lines);
        let stop = "" as "" | "budget" | "broken", next = 0, good = 0, bad = 0;
        await Promise.all(new Array(PARALLEL).fill(0).map(async () => {
          for (;;) {
            if (stop) return;
            const i = todo[next++]; if (i === undefined) return;
            const c = s1.chunks[i], bytes = sliceChunk(m.chunks[i], bundles);
            if (!bytes) { c.failed = true; bad++; continue; }
            if (c.seconds < 0.5) { c.lines = []; continue; }
            const got = await hear(hub, bytes, c.seconds, p.language);
            if (got === "budget") { stop = "budget"; return; }
            if (got === null) { c.failed = true; bad++; } else { c.lines = toLines(c.start, got.text, got.segments); delete c.failed; good++; }
            host.scratch(skey, s1);
            // Every failed call is charged its estimate; a service that is down must not eat the day's allowance.
            if (bad >= 2 && !good) stop = "broken";
          }
        }));
        const done = s1.chunks.filter(c => c.lines).length;
        if (stop === "budget") return { ok: false, error: "转到一半今天的 AI 额度用完了：" + done + "/" + s1.chunks.length + " 段已经转好并留着，明天再叫我做这个录音会接着转，不重复花额度。" };
        if (stop === "broken") return { ok: false, error: "转写服务现在出错（连着两段没转出来），" + (done ? done + " 段已经转好并留着，" : "") + "过一阵再叫我做这个录音会接着转。" };
      }

      // ---- 3. minutes, transcript file, library ----
      const s0 = st!, long = s0.seconds >= 3600;
      const text = transcriptText(s0.chunks, long);
      const heardChars = s0.chunks.reduce((n, c) => n + (c.lines || []).reduce((k, l) => k + l[1].length, 0), 0);
      if (heardChars < 10) { host.scratch(skey, null); return { ok: false, error: s0.chunks.some(c => c.failed) ? "转写服务出错，没转出文字，过一会儿再试" : "录音里没听出有人说话" }; }
      const notes = await writeMinutes(hub.env, groupLines(s0.chunks, long), { focus: p.focus, seconds: s0.seconds, name: s0.name });
      const title = p.title || notes.title || clip(s0.name.replace(/\.[a-z0-9]{2,4}$/i, ""), 30) || "录音";
      const failedCount = s0.chunks.filter(c => c.failed).length;
      const minutes = renderMinutes(notes, { title, seconds: s0.seconds, focus: p.focus, missing: failedCount });
      const header = "《" + title + "》录音转写（" + minutesText(s0.seconds) + "，自动识别，不区分说话人，可能有错字）\n来源：" + clip(s0.name, 80) + "\n\n";
      const fileRef = await host.keepFile(fileName(title) + "-转写.txt", new TextEncoder().encode(header + text + "\n"));
      let libraryId: number | null = null;
      try {
        libraryId = await saveDoc(hub, conv, String(ctx.askers?.[0]?.name || "群友"), {
          url: "minutes:" + p.source.ref, title: "录音纪要：" + title, summary: clip(notes.summary || notes.points.slice(0, 3).join("；") || title, 160), text: minutes + "\n\n——完整转写——\n" + text,
        });
      } catch (e: any) { console.log("minutes: library save failed", e?.message); }
      host.scratch(skey, null);
      const tip = machine ? host.advice("container_seconds", machine) : null;
      return {
        ok: true, title, length: minutesText(s0.seconds), minutes,
        transcript_file: fileRef || "没存下来", ...(libraryId ? { library_id: libraryId } : {}),
        ...(failedCount ? { not_transcribed: failedCount + " 段（每段 10 分钟）转写服务出错，没转出来" } : {}),
        how_to_deliver: "把 minutes 原样发群里；有人要全文就把 transcript_file 发给他们。以后问这次会议的细节，用 library 搜「" + title + "」。",
        ...(note ? { used: note } : {}), ...(tip ? { budget_note: tip } : {}),
      };
    },
  }];
}

const feature: Feature = {
  name: "minutes",
  tools,
  tunables: {
    minutes_max_minutes: { default: 120, min: 5, max: 150, what: "录音纪要一次最多转写多少分钟" },
    minutes_daily: { default: 3, min: 0, max: 10, what: "每天最多做几次录音纪要" },
  },
  about: [
    "录音纪要：群友把会议、讲座、电话的录音或视频发来（大文件用文件箱上传），我在云电脑里把声音转成小段，逐段转成文字，再写成纪要：概要、定下来的事、待办、还没定的问题和带时间点的时间线。",
    "转写用的是 Cloudflare 每天的免费 AI 额度，每分钟录音约 47 neurons，一小时约 2900，全站一天共 8000；不够时我会先说今天还能转多少分钟，不会超额。",
    "转写不区分谁在说话，所以纪要里只有录音里点了名的事才写负责人；截止时间也只写录音里说了的。",
    "一次最长 120 分钟（minutes_max_minutes 可调），每天最多做 3 次（minutes_daily）；完整转写稿存成文本文件，同时存进资料库，以后可以问这次会的细节。",
    "做到一半被打断，再叫一次同一个录音会接着转，已经转好的段不重复花额度。",
  ],
};
export default feature;
