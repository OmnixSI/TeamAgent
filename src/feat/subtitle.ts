// Subtitles for a video: tool `subtitle` fetches the video into the cloud computer, cuts its sound into at
// most six mono 16 kHz MP3 pieces at pauses, transcribes each on Workers AI with word timings, turns the
// words into readable cues (an .srt), optionally translates them with the chat model, and optionally burns
// them into the picture.
//
// Measured (2026-11-15): whisper-large-v3-turbo on the binding returns text, transcription_info
// {language, duration}, segments [{start, end, text, avg_logprob, no_speech_prob, words [{word, start, end}]}],
// a "vtt" with one cue per word (useless as subtitles), and usage.neurons at 46.6 a minute. A segment can
// run 17 s, so cues are built from the word timings. The machine's static ffmpeg has libass (subtitles/ass
// filters) but no fontconfig, so fonts come from a fontsdir. Debian's ffmpeg from apt would take 67 s to
// install and is not needed. Encoding 720p with libx264 on the one vCPU ran at 0.55 s per video second
// (veryfast) and 0.36 (superfast); the defaults below add a margin and are replaced by what real runs measure.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { dsChat } from "../llm.ts";

const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const NEURONS_PER_MINUTE = 46.63;
const CHUNK_SECONDS = 600;          // target length of one transcription call
const MAX_CHUNKS = 6;               // runComputer brings back at most six files a call
const SNAP = 45;                    // a cut moves at most this far to land in a pause
const ENCODE_MAX = 1500;            // seconds of encoding one burn may take (the machine allows 1800 a call)
const RATE: Record<string, number> = { veryfast: 0.7, superfast: 0.45 };   // encode seconds per video second at ≤ 720p
const BOX_OVER = 25 * 1024 * 1024;
const FETCH_MAX = 2_000_000_000;
const FONT = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc";
const BATCH = 40;                   // cues per translation call

/** Replaceable in tests. */
export const deps = {
  chat: (env: any, messages: any[], maxTokens: number) => dsChat(env, { messages, max_tokens: maxTokens, label: "视频字幕" }, "none", 120000).then(r => String(r.message?.content || "")),
  id: () => [...crypto.getRandomValues(new Uint8Array(4))].map(b => b.toString(16).padStart(2, "0")).join(""),
};

export const sq = (s: unknown) => "'" + String(s).replace(/'/g, "'\\''") + "'";
const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const round = (n: number, d = 1) => Math.round(n * 10 ** d) / 10 ** d;

// ---------- text ----------

const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;
/** Share of letters that are Chinese, Japanese or Korean. */
export function cjkShare(s: string) {
  const t = [...String(s).replace(/[\s\p{P}\p{S}\d]/gu, "")];
  return t.length ? t.filter(c => CJK.test(c)).length / t.length : 0;
}
const isCjk = (s: string) => cjkShare(s) > 0.5;
/** Display width in "em": a CJK character is one, Latin letters about half. */
export const ems = (s: string) => [...s].reduce((n, c) => n + (CJK.test(c) || /[＀-￯　-〿]/.test(c) ? 1 : c === " " ? 0.3 : 0.55), 0);

/** Chinese lines get full-width punctuation and lose a trailing comma or full stop, as subtitles do. */
export function tidy(text: string) {
  let t = String(text).replace(/\s+/g, " ").trim().replace(/-->/g, "→");
  if (!isCjk(t)) return t;
  const C = "぀-ヿ㐀-鿿豈-﫿가-힯";
  t = t.replace(new RegExp("([" + C + "])\\s*,\\s*", "g"), "$1，").replace(new RegExp("([" + C + "])\\s*\\?", "g"), "$1？")
    .replace(new RegExp("([" + C + "])\\s*!", "g"), "$1！").replace(new RegExp("([" + C + "])\\s*;\\s*", "g"), "$1；")
    .replace(new RegExp("([" + C + "])\\s*\\.(?!\\d)\\s*", "g"), "$1。").replace(new RegExp("([" + C + "])\\s*:\\s*", "g"), "$1：");
  return t.replace(/[，。、,.;；]+$/u, "").trim();
}

/** Breaks one cue's text into lines no wider than `max` characters, balanced, at spaces (Latin) or anywhere
 *  but preferably after punctuation (CJK). */
export function wrap(text: string, max: number): string[] {
  const t = text.trim(), cjk = isCjk(t), chars = [...t];
  if (chars.length <= max) return t ? [t] : [];
  const lines = Math.ceil(chars.length / max), target = chars.length / lines;
  let best = -1, score = Infinity;
  for (let i = 1; i < chars.length; i++) {
    if (i > max) break;
    const before = chars[i - 1], at = chars[i];
    let s = Math.abs(i - target);
    if (cjk) {
      if (/[，。！？、；：,.!?;:)）」』”]/.test(before)) s -= 4;
      else if (/\s/.test(before) || /\s/.test(at)) s -= 2;
      else if (/[，。！？、；：,.!?;:)）」』”]/.test(at)) s += 50;   // never start a line with punctuation
      else if (/[A-Za-z0-9]/.test(before) && /[A-Za-z0-9]/.test(at)) s += 20;   // nor cut a Latin word
    } else {
      if (at !== " ") continue;
      if (/[,.;:!?]/.test(before)) s -= 4;
    }
    if (s < score) { score = s; best = i; }
  }
  if (best < 0) best = Math.min(max, chars.length - 1);   // one Latin word longer than a line
  const head = chars.slice(0, best).join("").trim(), rest = chars.slice(best).join("").trim();
  return [head, ...wrap(rest, max)].filter(Boolean);
}

// ---------- timing ----------

export type Word = { text: string; start: number; end: number };
export type Cue = { start: number; end: number; text: string; tr?: string };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
function split(t: number) {
  const ms = Math.max(0, Math.round((Number(t) || 0) * 1000));
  return { h: Math.floor(ms / 3600000), m: Math.floor(ms / 60000) % 60, s: Math.floor(ms / 1000) % 60, ms: ms % 1000 };
}
/** 3725.4 → "01:02:05,400" */
export const srtTime = (t: number) => { const x = split(t); return pad(x.h) + ":" + pad(x.m) + ":" + pad(x.s) + "," + pad(x.ms, 3); };
/** 3725.4 → "1:02:05.40" (ASS counts centiseconds) */
export const assTime = (t: number) => { const cs = Math.max(0, Math.round((Number(t) || 0) * 100)); return Math.floor(cs / 360000) + ":" + pad(Math.floor(cs / 6000) % 60) + ":" + pad(Math.floor(cs / 100) % 60) + "." + pad(cs % 100); };

// Whisper's usual inventions over silence or music.
const INVENTED = /(字幕由\s*Amara\.org\s*社(区|區)提供|請不吝點贊|请不吝点赞|訂閱\s*轉發|Thanks? (you )?for watching|Subtitles by the Amara\.org)/i;

/** Words of one whisper answer, moved by the piece's offset. Segments without word timings are spread
 *  evenly over the segment; segments that are probably silence are dropped. */
export function wordsFrom(r: any, offset: number): Word[] {
  const out: Word[] = [];
  for (const seg of Array.isArray(r?.segments) ? r.segments : []) {
    const s0 = Number(seg?.start), s1 = Number(seg?.end), text = String(seg?.text || "");
    if (!text.trim() || INVENTED.test(text)) continue;
    if (Number(seg?.no_speech_prob) > 0.6 && Number(seg?.avg_logprob) < -0.8) continue;
    const ws = (Array.isArray(seg?.words) ? seg.words : []).filter((w: any) => String(w?.word || "").trim() && Number.isFinite(Number(w?.start)) && Number.isFinite(Number(w?.end)));
    if (ws.length) { for (const w of ws) out.push({ text: String(w.word), start: offset + Number(w.start), end: offset + Math.max(Number(w.end), Number(w.start)) }); continue; }
    if (!Number.isFinite(s0) || !Number.isFinite(s1)) continue;
    const parts = isCjk(text) ? text.match(/[^，。！？,.!?；;]+[，。！？,.!?；;]*/g) || [text] : text.split(/(?=\s)/).filter(p => p.trim());
    const total = parts.reduce((n, p) => n + p.length, 0) || 1;
    let at = 0;
    for (const p of parts) { const a = s0 + (s1 - s0) * at / total; at += p.length; out.push({ text: p, start: offset + a, end: offset + s0 + (s1 - s0) * at / total }); }
  }
  if (!out.length && typeof r?.text === "string" && r.text.trim() && !INVENTED.test(r.text)) {
    const d = Number(r?.transcription_info?.duration) || 0;
    if (d > 0) out.push({ text: r.text, start: offset, end: offset + d });
  }
  return out;
}

export type Shape = { maxChars: number; line: number; minDur: number; maxDur: number; gap: number };
/** Limits for a cue: one or two lines of 16 CJK / 42 Latin characters; fewer when a translation goes under it. */
export const shape = (cjk: boolean, bilingual: boolean): Shape => ({
  maxChars: cjk ? (bilingual ? 18 : 32) : (bilingual ? 60 : 84), line: cjk ? 16 : 42, minDur: 1, maxDur: 7, gap: 0.9,
});
const joinWords = (ws: Word[]) => ws.map(w => w.text).join("").replace(/\s+/g, " ").trim();
const SENTENCE_END = /([。！？!?…]|[^.\d]\.)["'”’」）)]*$/;
const PAUSE_MARK = /[，、,；;：:]["'”’」）)]*$/;

/** Groups timed words into cues: a cue ends at a sentence end, at a pause, when it would get too long or
 *  last too long; when it gets too long it is split at its last comma if that leaves it at least a third full. */
export function buildCues(words: Word[], sh: Shape): Cue[] {
  const ws = words.filter(w => w.text.trim()).sort((a, b) => a.start - b.start);
  const cues: Cue[] = [];
  let cur: Word[] = [];
  const flush = (part: Word[]) => { const text = tidy(joinWords(part)); if (text) cues.push({ start: part[0].start, end: Math.max(...part.map(w => w.end)), text }); };
  for (const w of ws) {
    if (cur.length) {
      const longer = [...joinWords([...cur, w])].length > sh.maxChars, late = w.end - cur[0].start > sh.maxDur, pause = w.start - cur[cur.length - 1].end > sh.gap;
      if (pause) { flush(cur); cur = []; }
      else if (longer || late) {
        let cut = -1;
        for (let i = cur.length - 2; i >= 0; i--) if (PAUSE_MARK.test(cur[i].text.trim()) || SENTENCE_END.test(cur[i].text.trim())) { cut = i; break; }
        if (cut >= 0 && [...joinWords(cur.slice(0, cut + 1))].length >= sh.maxChars / 3) { flush(cur.slice(0, cut + 1)); cur = cur.slice(cut + 1); }
        else { flush(cur); cur = []; }
        if (cur.length && ([...joinWords([...cur, w])].length > sh.maxChars || w.end - cur[0].start > sh.maxDur)) { flush(cur); cur = []; }
      }
    }
    cur.push(w);
    const t = joinWords(cur);
    if (SENTENCE_END.test(t) || (PAUSE_MARK.test(t) && [...t].length >= sh.maxChars * 0.6)) { flush(cur); cur = []; }
  }
  if (cur.length) flush(cur);
  return settle(cues, sh);
}

const readSeconds = (t: string) => (isCjk(t) ? [...t].length / 7 : t.length / 18);
const GAP = 0.04;

/** Makes the timing watchable: sorted, no overlaps, each cue on screen at least `minDur` (and long enough
 *  to read, using the silence after it), cues that cannot get a second merged into a neighbour. */
export function settle(input: Cue[], sh: Shape): Cue[] {
  let cues = input.filter(c => c.text && Number.isFinite(c.start) && Number.isFinite(c.end)).map(c => ({ ...c, end: Math.max(c.end, c.start) })).sort((a, b) => a.start - b.start);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i], prev = cues[i - 1], next = cues[i + 1];
      if (prev && c.start < prev.end + GAP) c.start = Math.min(prev.end + GAP, c.end);
      const want = Math.max(sh.minDur, Math.min(readSeconds(c.text), sh.maxDur));
      let end = Math.max(c.end, Math.min(c.start + want, c.end + 1.5));
      if (next) end = Math.min(end, Math.max(next.start - GAP, c.start));
      c.end = end;
      if (c.end - c.start < sh.minDur) c.start = Math.max(prev ? prev.end + GAP : 0, c.end - sh.minDur);
      // Still short: borrow the start of a following cue that can spare it (speech then leads by a moment).
      const short = sh.minDur - (c.end - c.start);
      if (short > 0 && next && next.end - (c.start + sh.minDur + GAP) >= sh.minDur) { c.end = c.start + sh.minDur; next.start = Math.max(next.start, c.end + GAP); }
    }
    const merged: Cue[] = [];
    let changed = false;
    for (const c of cues) {
      const last = merged[merged.length - 1];
      if (last && c.end - c.start < sh.minDur - 0.05) {
        last.text = tidy(last.text + (isCjk(last.text) ? "，" : " ") + c.text); last.end = Math.max(last.end, c.end);
        if (c.tr || last.tr) last.tr = [last.tr, c.tr].filter(Boolean).join(isCjk(last.tr || c.tr || "") ? "，" : " ");
        changed = true;
      } else merged.push({ ...c });
    }
    // A first cue that is too short has no earlier neighbour: give it to the second one.
    if (merged.length > 1 && merged[0].end - merged[0].start < sh.minDur - 0.05) {
      const [a, b] = merged;
      b.text = tidy(a.text + (isCjk(a.text) ? "，" : " ") + b.text); b.start = a.start;
      if (a.tr || b.tr) b.tr = [a.tr, b.tr].filter(Boolean).join(" ");
      merged.shift(); changed = true;
    }
    cues = merged;
    if (!changed) break;
  }
  return cues.map(c => ({ ...c, start: round(c.start, 3), end: round(c.end, 3) }));
}

// ---------- output ----------

export type Mode = "original" | "translated" | "bilingual";
const lineWidth = (t: string) => (isCjk(t) ? 16 : 42);
export function cueLines(c: Cue, mode: Mode): string[] {
  const o = wrap(c.text, lineWidth(c.text)), t = c.tr ? wrap(c.tr, lineWidth(c.tr)) : [];
  return mode === "original" ? o : mode === "translated" ? (t.length ? t : o) : [...o, ...t];
}
export function toSrt(cues: Cue[], mode: Mode = "original"): string {
  return cues.map((c, i) => (i + 1) + "\n" + srtTime(c.start) + " --> " + srtTime(c.end) + "\n" + cueLines(c, mode).join("\n") + "\n").join("\n");
}

/** An ASS script sized to the picture, so the font fits the widest line on portrait videos too. In
 *  bilingual mode the original is drawn smaller above the translation. */
export function toAss(cues: Cue[], mode: Mode, w: number, h: number): string {
  const W = Math.max(64, Math.round(w) || 1280), H = Math.max(64, Math.round(h) || 720);
  const widest = Math.max(8, ...cues.flatMap(c => cueLines(c, mode)).map(ems));
  const fs = Math.max(12, Math.floor(Math.min(H * 0.052, (W * 0.94) / widest)));
  const small = Math.round(fs * 0.8), outline = Math.max(1, round(fs / 16));
  const esc = (s: string) => s.replace(/\\/g, "＼").replace(/\{/g, "（").replace(/\}/g, "）");
  const body = cues.map(c => {
    const o = wrap(c.text, lineWidth(c.text)).map(esc), t = c.tr ? wrap(c.tr, lineWidth(c.tr)).map(esc) : [];
    const text = mode === "original" ? o.join("\\N") : mode === "translated" ? (t.length ? t : o).join("\\N") : t.length ? "{\\fs" + small + "}" + o.join("\\N") + "\\N{\\fs" + fs + "}" + t.join("\\N") : o.join("\\N");
    return "Dialogue: 0," + assTime(c.start) + "," + assTime(c.end) + ",Default,,0,0,0,," + text;
  });
  return [
    "[Script Info]", "ScriptType: v4.00+", "PlayResX: " + W, "PlayResY: " + H, "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Noto Sans CJK SC," + fs + ",&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1," + outline + ",0,2," + Math.round(W * 0.03) + "," + Math.round(W * 0.03) + "," + Math.round(H * 0.045) + ",1",
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", ...body, "",
  ].join("\n");
}

// ---------- translation ----------

/** "中文" / "英文" / "ja" … → a language code when it is one of the common ones. */
export function langCode(s: string): string {
  const t = String(s || "").trim().toLowerCase();
  if (!t) return "";
  if (/^(zh|中|汉|漢|chinese|简体|繁体|普通话|国语|粤语)/.test(t) || /中文/.test(t)) return "zh";
  if (/^(en|英|english)/.test(t)) return "en";
  if (/^(ja|日|japanese)/.test(t)) return "ja";
  if (/^(ko|韩|韓|korean)/.test(t)) return "ko";
  if (/^(fr|法|french)/.test(t)) return "fr";
  if (/^(de|德|german)/.test(t)) return "de";
  if (/^(es|西班牙|spanish)/.test(t)) return "es";
  if (/^(ru|俄|russian)/.test(t)) return "ru";
  return /^[a-z]{2}$/.test(t) ? t : "";
}

/** Reads "12|text" lines back; null unless every number asked for came back exactly once, non-empty, and nothing else. */
export function parseNumbered(answer: string, nums: number[]): Map<number, string> | null {
  const got = new Map<number, string>();
  for (const line of String(answer || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s*[|｜]\s*(.*?)\s*$/);
    if (!m) continue;
    const n = Number(m[1]);
    if (got.has(n) || !nums.includes(n) || !m[2]) return null;
    got.set(n, m[2]);
  }
  return got.size === nums.length ? got : null;
}

/** Translates the cue texts in numbered batches. A batch whose answer does not have exactly the lines asked
 *  for is asked once more; if it fails again its cues stay untranslated and are counted in `missing`. */
export async function translateAll(env: any, texts: string[], target: string, title: string, chat = deps.chat): Promise<{ out: (string | null)[]; missing: number; calls: number }> {
  const out: (string | null)[] = texts.map(() => null);
  let calls = 0;
  const batches: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH) batches.push(texts.slice(i, i + BATCH).map((_, j) => i + j));
  const one = async (idx: number[]) => {
    const nums = idx.map(i => i + 1);
    const messages = [
      { role: "system", content: "你是字幕翻译。把每一行字幕翻译成" + target + "。输入每行是“编号|原文”，你输出的每行也必须是“编号|译文”：一行对一行，编号原样保留，行数和输入完全一样，不合并、不拆分、不跳过，不加任何解释。译文口语、简短，适合做字幕；前后行是连着的话，照上下文译。" + (title ? "视频标题：" + clip(title, 100) : "") },
      { role: "user", content: idx.map(i => (i + 1) + "|" + texts[i].replace(/\s*\n\s*/g, " ")).join("\n") },
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const answer = await chat(env, messages, Math.min(8000, 300 + idx.reduce((n, i) => n + texts[i].length * 3 + 12, 0))).catch(() => "");
      const got = parseNumbered(answer, nums);
      if (got) { for (const i of idx) out[i] = tidy(got.get(i + 1)!); return; }
    }
  };
  for (let i = 0; i < batches.length; i += 3) await Promise.all(batches.slice(i, i + 3).map(one));
  return { out, missing: out.filter(x => x === null).length, calls };
}

// ---------- the machine ----------

export type Source = { kind: "url"; url: string; direct: boolean } | { kind: "box"; ref: string } | { kind: "file"; ref: string } | { kind: "seq"; seq: number };
export function parseSource(given: string): Source | null {
  const g = String(given || "").trim().replace(/^\[?\s*视频\s*/, "").replace(/\]$/, "").trim();
  if (/^\d+$/.test(g)) return { kind: "seq", seq: Number(g) };
  if (/^x\d+$/i.test(g)) return { kind: "box", ref: g.toLowerCase() };
  if (/^f\d+$/i.test(g)) return { kind: "file", ref: g.toLowerCase() };
  if (/^https?:\/\/[^\s'"`\\]+$/i.test(g)) return { kind: "url", url: g, direct: /\.(mp4|mov|m4v|webm|mkv|avi|flv|ts|m4a|mp3|wav|aac|ogg|opus|flac)(\?|#|$)/i.test(g) };
  return null;
}

/** How the video gets into `dir` as in.<ext>. `limit` > 0 checks the length first where that is possible
 *  without downloading (pages through yt-dlp, direct links through ffprobe) and stops with TOO_LONG. */
export type Fetch = { kind: "curl"; url: string } | { kind: "page"; url: string } | { kind: "moved"; path: string; pre?: string };
export function fetchCommand(f: Fetch, dir: string, limit = 0): string {
  const check = (d: string) => limit > 0 ? "D0=" + d + "; case \"$D0\" in ''|*[!0-9.]*) ;; *) if awk -v d=\"$D0\" -v l=" + limit + " 'BEGIN{exit !(d+0>l)}'; then echo \"DURATION $D0\"; echo TOO_LONG; exit 0; fi;; esac; " : "";
  const into = "mkdir -p " + sq(dir) + " && cd " + sq(dir) + " && rm -f in.* && ";
  if (f.kind === "curl") return into + check("$(timeout 40 ffprobe -v error -show_entries format=duration -of csv=p=0 " + sq(f.url) + " 2>/dev/null | head -1)") +
    "curl -fsSL --retry 2 --max-filesize " + FETCH_MAX + " -A 'Mozilla/5.0' -o in.mp4 " + sq(f.url);
  if (f.kind === "page") {
    const y = "yt-dlp --no-playlist --no-warnings ";
    return into + "(command -v yt-dlp >/dev/null || uv pip install -q --python /opt/py/bin/python yt-dlp) && " +
      check("$(timeout 60 " + y + "--skip-download --print duration " + sq(f.url) + " 2>/dev/null | head -1)") +
      y + "-q -f 'bv*[height<=720]+ba/b[height<=720]/b' --max-filesize 1900M --merge-output-format mp4 -o 'in.%(ext)s' --print-to-file '%(title)s' title.txt " + sq(f.url);
  }
  return into + (f.pre ? f.pre + " && " : "") + "mv -f -- " + sq(f.path) + " in.bin";
}

// Picks cut points near k·D/n that fall in a pause, so no word is cut in half.
const CUTS_PY = String.raw`import re,sys
d=float(sys.argv[1]);n=int(sys.argv[2]);t=open(sys.argv[3],errors="ignore").read()
s=[float(x) for x in re.findall(r"silence_start: ([\d.]+)",t)];e=[float(x) for x in re.findall(r"silence_end: ([\d.]+)",t)]
m=[(a+b)/2 for a,b in zip(s,e)];c=[]
for k in range(1,n):
  g=d*k/n;near=[x for x in m if abs(x-g)<=${SNAP} and (not c or x>c[-1]+30)]
  c.append(min(near,key=lambda x:abs(x-g)) if near else g)
print(",".join("%.3f"%x for x in c))`;

/** After the fetch: length and picture size, a stop when too long or silent, then the sound as at most six
 *  MP3 pieces with their exact start times (CHUNK lines). The video stays only when it will be burned. */
export function prepCommand(dir: string, limit: number, keepVideo: boolean): string {
  return [
    "cd " + sq(dir),
    "if [ -s title.txt ]; then echo \"TITLE $(head -c 300 title.txt | tr '\\n' ' ')\"; fi",
    "IN=$(ls in.* 2>/dev/null | head -1); if [ -z \"$IN\" ]; then echo '视频没取下来' >&2; exit 1; fi",
    "D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 \"$IN\" | head -1)",
    "case \"$D\" in ''|*[!0-9.]*) D=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 \"$IN\" | head -1);; esac",
    "case \"$D\" in ''|*[!0-9.]*) echo '看不出这个文件有多长，可能不是视频或者没下完整' >&2; exit 1;; esac",
    "echo \"DURATION $D\"",
    "ffprobe -v error -select_streams v:0 -show_entries stream=width,height:stream_side_data=rotation -of default=nw=1 \"$IN\" | sed 's/^/PROBE /'",
    "if awk -v d=\"$D\" -v l=" + limit + " 'BEGIN{exit !(d+0>l)}'; then echo TOO_LONG; rm -f in.*; exit 0; fi",
    "if [ -z \"$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 \"$IN\" | head -1)\" ]; then echo NOAUDIO; exit 0; fi",
    "ffmpeg -nostdin -v error -y -i \"$IN\" -vn -ac 1 -ar 16000 a.wav",
    "N=$(awk -v d=\"$D\" 'BEGIN{n=int((d+" + (CHUNK_SECONDS - 1) + ")/" + CHUNK_SECONDS + "); if(n<1)n=1; if(n>" + MAX_CHUNKS + ")n=" + MAX_CHUNKS + "; print n}')",
    "CUTS=''; if [ \"$N\" -gt 1 ]; then ffmpeg -nostdin -hide_banner -nostats -i a.wav -af silencedetect=n=-35dB:d=0.35 -f null - 2> sil.txt || true; CUTS=$(\"${PY:-/opt/py/bin/python}\" -c " + sq(CUTS_PY) + " \"$D\" \"$N\" sil.txt); fi",
    "if [ -n \"$CUTS\" ]; then SEG=\"-segment_times $CUTS\"; else SEG='-segment_time 100000'; fi",
    "rm -f c*.mp3 list.csv && ffmpeg -nostdin -v error -y -i a.wav -c:a libmp3lame -b:a 32k -f segment $SEG -segment_list list.csv -segment_list_type csv c%02d.mp3",
    "rm -f a.wav sil.txt" + (keepVideo ? "" : " in.*"),
    "sed 's/^/CHUNK /' list.csv",
  ].join("\n");
}

/** Encodes the video with the ASS burned in (≤ 1280 on the long side), stops at `seconds`, reports the
 *  encode time and size, and hands a result over 25 MB to `upload`. */
export function burnCommand(dir: string, assPath: string, preset: string, seconds: number, upload: string): string {
  const vf = "scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,subtitles=sub.ass:fontsdir=fonts";
  return [
    "cd " + sq(dir),
    "mv -f -- " + sq(assPath) + " sub.ass",
    "mkdir -p fonts && { ln -f " + FONT + " fonts/ 2>/dev/null || cp -f " + FONT + " fonts/; }",
    "IN=$(ls in.* 2>/dev/null | head -1); if [ -z \"$IN\" ]; then echo '视频没取下来' >&2; exit 1; fi",
    "S=$(date +%s)",
    "timeout " + Math.max(30, Math.round(seconds)) + " ffmpeg -nostdin -y -v error -i \"$IN\" -map 0:v:0 -map '0:a:0?' -vf \"" + vf + "\" -c:v libx264 -preset " + (preset === "superfast" ? "superfast" : "veryfast") + " -crf 23 -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart out.mp4 || { e=$?; if [ $e = 124 ]; then echo '烧录超时了' >&2; fi; rm -f out.mp4; exit $e; }",
    "echo \"ENCODE $(( $(date +%s) - S ))\"",
    "rm -f in.* && ffmpeg -nostdin -v error -y -ss 1 -i out.mp4 -frames:v 1 -vf scale=640:-2 -q:v 5 shot.jpg || true",
    "SZ=$(wc -c < out.mp4 | tr -d ' '); echo \"OUTSIZE $SZ\"",
    "if [ \"$SZ\" -gt " + BOX_OVER + " ]; then " + upload + "; fi",
  ].join("\n");
}

export type Prep = { duration: number; title: string; width: number; height: number; tooLong: boolean; noAudio: boolean; chunks: { file: string; start: number; end: number }[] };
export function parsePrep(stdout: string): Prep {
  const p: Prep = { duration: 0, title: "", width: 0, height: 0, tooLong: false, noAudio: false, chunks: [] };
  let rot = 0;
  for (const line of String(stdout || "").split("\n")) {
    const [k, ...rest] = line.split(" "), v = rest.join(" ").trim();
    if (k === "DURATION") p.duration = Number(v) || p.duration;
    else if (k === "TITLE") p.title = v;
    else if (k === "TOO_LONG") p.tooLong = true;
    else if (k === "NOAUDIO") p.noAudio = true;
    else if (k === "PROBE") {
      const m = v.match(/^(width|height|rotation)=(-?\d+)/);
      if (m && m[1] === "width" && !p.width) p.width = Number(m[2]);
      else if (m && m[1] === "height" && !p.height) p.height = Number(m[2]);
      else if (m && m[1] === "rotation") rot = Number(m[2]);
    } else if (k === "CHUNK") {
      const [file, a, b] = v.split(",");
      if (file && Number.isFinite(Number(a))) p.chunks.push({ file: file.trim(), start: Number(a), end: Number(b) || Number(a) });
    }
  }
  if (Math.abs(rot) % 180 === 90) [p.width, p.height] = [p.height, p.width];
  return p;
}

// ---------- estimates ----------

export const neuronEstimate = (seconds: number, pieces = 1) => Math.ceil(seconds / 60 * NEURONS_PER_MINUTE * 1.05 + pieces * 2);
/** Seconds of audio today's AI allowance still covers. */
export const secondsCovered = (left: number) => Math.max(0, Math.floor((left - MAX_CHUNKS * 2) / (NEURONS_PER_MINUTE * 1.05) * 60));

/** Encode plan for a burn: preset, expected encode seconds, and the longest video that fits the time limit. */
export function burnPlan(seconds: number, width: number, height: number, rates: Record<string, number> = RATE) {
  const px = (width || 1280) * (height || 720), factor = 1 + 0.25 * Math.max(0, px / 921600 - 1);
  const vf = (rates.veryfast || RATE.veryfast) * factor, sf = (rates.superfast || RATE.superfast) * factor;
  const preset = seconds * vf + 20 <= 600 ? "veryfast" : "superfast";
  const encode = Math.ceil(seconds * (preset === "veryfast" ? vf : sf) + 20);
  return { preset, encode, fits: encode <= ENCODE_MAX, maxMinutes: Math.max(0, Math.floor((ENCODE_MAX - 20) / sf / 60)), factor };
}

const rates = (hub: Hub) => Object.fromEntries(Object.keys(RATE).map(k => [k, Number(hub.get("subtitle:rate:" + k)) || RATE[k]]));
function learnRate(hub: Hub, preset: string, measured: number) {
  if (!(measured > 0.05 && measured < 20)) return;
  const old = Number(hub.get("subtitle:rate:" + preset)) || 0;
  hub.set("subtitle:rate:" + preset, String(round(old ? old * 0.5 + measured * 0.5 : measured, 3)));
}

// ---------- the tool ----------

const fileName = (title: string, fallback: string) => {
  const t = String(title || "").normalize("NFC").replace(/[\u0000-\u001f\u007f\/\\:*?"<>|'`$!&;(){}\[\]#~]/g, " ").replace(/\s+/g, " ").trim();
  return [...t].slice(0, 40).join("").trim() || fallback;
};

async function whisper(hub: Hub, bytes: Uint8Array, seconds: number, opts: any): Promise<any> {
  const estimate = neuronEstimate(seconds);
  if (!hub.plan.fits("ai_neurons", estimate)) throw new Error("今天的 AI 额度不够了");
  let used = estimate;
  try {
    const r = await hub.env.AI.run(WHISPER, { audio: { body: new Blob([bytes]).stream(), contentType: "audio/mpeg" }, ...opts });
    if (!r || (typeof r.text !== "string" && !Array.isArray(r.segments))) throw new Error("转写没有结果");
    const n = Number(r?.usage?.neurons);
    if (Number.isFinite(n) && n > 0) used = n;
    return r;
  } finally { hub.plan.add("ai_neurons", used); }
}

export function subtitleTool(ctx: Ctx): Tool {
  const { hub, host } = ctx;
  return {
    name: "subtitle", work: true, slow: true, long: true,
    description: "给视频做字幕：把视频里说的话转成带时间轴的 .srt 字幕文件发到群里，可以翻译成别的语言、做双语字幕（原文在上、译文在下），也可以直接把字幕烧进画面，发回一个带字幕的视频。视频可以是群里发的视频（消息里显示成 [视频 123]，video 填 123）、聊天文件编号（f12）、文件箱编号（x12，大视频走这个）、视频文件直链，或抖音、B 站、YouTube 等视频页面链接。要等几分钟，视频越长越久；最长能做多长、一天几次由设置决定，额度不够时会直说。只要文字内容、不要字幕文件时用 watch_video。",
    parameters: {
      type: "object",
      properties: {
        video: { type: "string", description: "视频：聊天里的视频编号（[视频 123] 填 123）、f12、x12，或链接" },
        translate: { type: "string", description: "要翻译成的语言，比如“中文”“英文”“日文”；不翻译就不填" },
        mode: { type: "string", enum: ["original", "translated", "bilingual"], description: "字幕里放什么：original 只放原文；translated 只放译文；bilingual 原文在上、译文在下。填了 translate 时默认 bilingual，否则 original" },
        language: { type: "string", description: "视频里说的是什么语言（如“英文”“中文”），知道就填，转写更准；不知道不填，会自动识别" },
        burn: { type: "boolean", description: "true 时把字幕烧进画面，另外发回一个带字幕的视频（要多等，按视频长度占云电脑时间，太长的会拒绝并说明能烧多长）" },
      },
      required: ["video"],
    },
    run: async a => {
      const src = parseSource(String(a.video || ""));
      if (!src) return { ok: false, error: "要给视频编号（[视频 123] 的 123）、f12、x12，或 http 链接" };
      const target = String(a.translate || "").trim().slice(0, 20);
      let mode: Mode = a.mode === "translated" || a.mode === "bilingual" || a.mode === "original" ? a.mode : target ? "bilingual" : "original";
      const lang = target || (mode === "original" ? "" : "中文");
      if (mode !== "original" && !lang) mode = "original";
      const burn = a.burn === true;
      const spoken = langCode(String(a.language || ""));
      const maxMinutes = Number(host.cfg("subtitle_max_minutes")) || 60;

      // Resolve the video before spending anything.
      const id = deps.id(), dir = "/work/sub-" + id;
      let how: Fetch, files: { name: string; bytes: Uint8Array }[] = [], label = "";
      const resolve = async (): Promise<Fetch | string> => {
        if (src.kind === "seq") { const u = host.videoUrl(src.seq); return /^https?:\/\/[^\s'"`\\]+$/.test(u) ? { kind: "curl", url: u } : "这条视频的链接没存下来（可能是早些时候发的），让群友重发一次，或者传到文件箱"; }
        if (src.kind === "url") { label = src.url; return src.direct ? { kind: "curl", url: src.url } : { kind: "page", url: src.url }; }
        if (src.kind === "box") { const b = host.boxIn(src.ref); if (!b) return "文件箱里没有 " + src.ref + "（可能过期了）"; label = b.name; return { kind: "moved", path: "/work/" + b.name, pre: b.command }; }
        const f = await host.fileRef(src.ref).catch(() => null);
        if (!f) return "找不到文件 " + src.ref;
        label = f.name; files = [{ name: "sub-" + id + "-in.bin", bytes: f.bytes }];
        return { kind: "moved", path: "/work/sub-" + id + "-in.bin" };
      };
      const got = await resolve();
      if (typeof got === "string") return { ok: false, error: got };
      how = got;

      if (!hub.env.AI) return { ok: false, error: "转写服务没接好，做不了字幕" };
      const covered = secondsCovered(hub.plan.left("ai_neurons"));
      if (covered < 60) return { ok: false, error: "今天的 AI 转写额度用完了（每天 0 点 UTC 重置），明天再做" };
      if (!hub.plan.fits("container_seconds", 300) || !hub.plan.fits("container_cpu_seconds", 60)) return { ok: false, error: "这个月云电脑的额度不够了，做不了字幕" };
      if (!(await host.quota("subtitle", Number(host.cfg("subtitle_daily"))))) return { ok: false, error: "今天做字幕的次数用完了" };

      // 1. Fetch, measure, cut the sound.
      const limit = Math.min(maxMinutes * 60, covered);
      const first = await host.computer({
        timeoutSeconds: 1200, files, collect: ["sub-" + id + "/c*.mp3"],
        commands: [fetchCommand(how, dir, limit) + "\n" + prepCommand(dir, limit, burn)].map(c => "set -o pipefail\n" + c),
      });
      const stdout = first.steps.map(s => s.stdout).join("\n"), prep = parsePrep(stdout);
      const minutes = round(prep.duration / 60);
      if (prep.tooLong) {
        return prep.duration > maxMinutes * 60
          ? { ok: false, error: "视频有 " + minutes + " 分钟，超过了字幕能做的上限 " + maxMinutes + " 分钟（设置 subtitle_max_minutes）；可以先剪一段再做" }
          : { ok: false, error: "视频有 " + minutes + " 分钟，今天剩下的 AI 转写额度只够约 " + Math.floor(covered / 60) + " 分钟；明天 0 点（UTC）重置后再做，或者先剪短" };
      }
      if (!first.ok) { const bad = first.steps.find(s => s.exit !== 0); return { ok: false, error: "视频没处理好：" + clip(first.error || bad?.stderr || bad?.stdout || "未知原因", 300) }; }
      if (prep.noAudio) return { ok: false, error: "这个视频没有声音，做不了字幕" };
      const title = prep.title || label.replace(/^https?:\/\/[^/]+\//, "").replace(/\.[^.]+$/, "") || "视频";
      const pieces = prep.chunks.map(c => ({ ...c, bytes: first.files.find(f => f.name.split("/").pop() === c.file)?.bytes }));
      if (!pieces.length || pieces.some(p => !p.bytes)) return { ok: false, error: "声音没取回来" + (first.skipped?.length ? "：" + first.skipped.join("；") : "") };
      const need = neuronEstimate(prep.duration, pieces.length);
      if (!hub.plan.fits("ai_neurons", need)) return { ok: false, error: "今天的 AI 转写额度只够约 " + Math.floor(secondsCovered(hub.plan.left("ai_neurons")) / 60) + " 分钟，这个视频要 " + minutes + " 分钟" };
      const notes: string[] = [], tips: string[] = [];
      const tip = host.advice("ai_neurons", need);
      if (tip) tips.push(tip);
      await host.say("视频 " + minutes + " 分钟，在转写" + (mode !== "original" ? "和翻译" : "") + "，稍等").catch(() => false);

      // 2. Transcribe the pieces, three at a time, each moved by its own start time.
      const opts: any = { ...(spoken ? { language: spoken } : {}), ...(spoken === "zh" ? { initial_prompt: "以下是普通话的句子。" } : {}) };
      const answers: any[] = new Array(pieces.length);
      const before = hub.plan.used("ai_neurons");
      try {
        for (let i = 0; i < pieces.length; i += 3) {
          await Promise.all(pieces.slice(i, i + 3).map(async (p, j) => {
            const k = i + j;
            try { answers[k] = await whisper(hub, p.bytes!, p.end - p.start, opts); }
            catch (e: any) { if (/额度/.test(String(e?.message))) throw e; answers[k] = await whisper(hub, p.bytes!, p.end - p.start, opts); }
          }));
        }
      } catch (e: any) { return { ok: false, error: "转写失败：" + clip(e?.message || e, 120) }; }
      const neurons = round(hub.plan.used("ai_neurons") - before);
      const words = answers.flatMap((r, k) => wordsFrom(r, pieces[k].start));
      const heard = langCode(String(answers.find(r => r?.transcription_info?.language)?.transcription_info?.language || "")) || spoken;
      if (!words.length) return { ok: false, error: "没听出有人说话（可能只有音乐或噪音）", seconds: prep.duration };
      const cjk = isCjk(joinWords(words.slice(0, 400)));

      // 3. Cues, translation.
      const cues = buildCues(words, shape(cjk, mode === "bilingual"));
      let missing = 0, translated = false;
      if (mode !== "original") {
        if (heard && langCode(lang) === heard) { mode = "original"; notes.push("视频里说的已经是" + lang + "，没有翻译"); }
        else {
          const t = await translateAll(hub.env, cues.map(c => c.text), lang, title);
          t.out.forEach((x, i) => { if (x) cues[i].tr = x; });
          missing = t.missing; translated = true;
          if (missing === cues.length) { mode = "original"; notes.push("翻译没成功，先给原文字幕"); }
          else if (missing) notes.push("有 " + missing + " 条没翻出来，只有原文");
        }
      }
      const srt = toSrt(cues, mode), base = fileName(title, "字幕-" + id);
      const srtName = base + (mode === "bilingual" ? ".双语" : mode === "translated" ? "." + lang : "") + ".srt";
      const srtBytes = new TextEncoder().encode(srt);
      const sent = await host.sendFile(srtName, srtBytes);
      const srtRef = await host.keepFile(srtName, srtBytes).catch(() => "");
      const result: any = {
        ok: sent.ok, title: clip(title, 120), minutes, language: heard || "未知", cues: cues.length, mode, ...(translated ? { translated_to: lang } : {}),
        srt: { name: srtName, ...(srtRef ? { ref: srtRef } : {}), sent: sent.ok, ...(sent.error ? { error: sent.error } : {}), ...(sent.queued ? { queued: true } : {}) },
        first_lines: cues.slice(0, 6).map(c => srtTime(c.start) + " " + cueLines(c, mode).join(" / ")),
        neurons_used: neurons,
      };

      // 4. Burn in.
      if (burn) {
        const plan = burnPlan(prep.duration, prep.width, prep.height, rates(hub));
        const machine = plan.encode + 120 + 90;
        if (!prep.width) result.burn = { ok: false, error: "这个文件没有画面，烧不了字幕" };
        else if (!plan.fits) result.burn = { ok: false, error: "视频 " + minutes + " 分钟，烧字幕要编码约 " + Math.ceil(plan.encode / 60) + " 分钟，超过单次上限；这台电脑一次能烧约 " + plan.maxMinutes + " 分钟以内的视频，可以先剪短，字幕文件照样能用" };
        else if (!hub.plan.fits("container_seconds", machine) || !hub.plan.fits("container_cpu_seconds", plan.encode)) result.burn = { ok: false, error: "这个月云电脑剩下的额度不够烧这段视频（要约 " + Math.ceil(machine / 60) + " 分钟），字幕文件照样能用" };
        else {
          const cpuTip = host.advice("container_cpu_seconds", plan.encode);
          if (cpuTip) tips.push(cpuTip);
          await host.say("字幕好了，在烧进视频，大约要 " + Math.max(1, Math.ceil(plan.encode / 60)) + " 分钟").catch(() => false);
          const again = await resolve();
          const name = base + "-字幕.mp4", assName = "sub-" + id + ".ass";
          const up = host.boxOut(dir + "/out.mp4", name);
          const refetch = typeof again === "string" ? "false" : fetchCommand(again, dir, 0);
          const second = await host.computer({
            timeoutSeconds: Math.min(1800, plan.encode * 1.6 + 300), collect: ["sub-" + id + "/out.mp4", "sub-" + id + "/shot.jpg"],
            files: [...files, { name: assName, bytes: new TextEncoder().encode(toAss(cues, mode, prep.width, prep.height)) }],
            commands: [
              "if ! ls " + sq(dir) + "/in.* >/dev/null 2>&1; then " + refetch.replace(/\n/g, "; ") + "; fi",
              burnCommand(dir, "/work/" + assName, plan.preset, Math.min(ENCODE_MAX + 100, Math.ceil(plan.encode * 1.6) + 30), up.command),
            ],
          });
          const out = second.steps.map(s => s.stdout).join("\n"), enc = Number(out.match(/ENCODE (\d+)/)?.[1]), size = Number(out.match(/OUTSIZE (\d+)/)?.[1]);
          if (enc > 0 && prep.duration > 20) learnRate(hub, plan.preset, (enc - 20) / prep.duration / plan.factor);
          const shot = second.files.find(f => f.name.endsWith("shot.jpg"));
          if (!second.ok && !(size > 0)) { const bad = second.steps.find(s => s.exit !== 0); result.burn = { ok: false, error: "烧字幕没成功：" + clip(second.error || bad?.stderr || bad?.stdout || "未知原因", 300) }; }
          else if (size > BOX_OVER) {
            const c = await up.claim().catch(() => null);
            result.burn = c ? { ok: true, name: c.name, ref: c.ref, link: c.link, mb: round(c.size / 1048576), note: "视频超过 25 MB，放进了文件箱：把 link 原样发给群友下载" } : { ok: false, error: "视频做好了但没放进文件箱（可能满了）" };
          } else {
            const v = second.files.find(f => f.name.endsWith("out.mp4"));
            if (!v) result.burn = { ok: false, error: "视频做好了但没取回来" };
            else {
              let r = await host.sendVideo(name, v.bytes);
              if (!r.ok) r = await host.sendFile(name, v.bytes);
              result.burn = { ok: r.ok, name, mb: round(v.bytes.length / 1048576), ...(r.error ? { error: r.error } : {}), ...(r.queued ? { queued: true } : {}) };
            }
          }
          if (result.burn.ok) result.burn.encode_seconds = enc || undefined;
          if (shot) result._images = ["data:image/jpeg;base64," + b64(shot.bytes)];
        }
      }
      if (notes.length) result.notes = notes;
      if (tips.length) result.budget_note = tips.join(" ");
      return result;
    },
  };
}

function b64(bytes: Uint8Array) { let t = ""; for (let i = 0; i < bytes.length; i += 0x8000) t += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(t); }

const feature: Feature = {
  name: "subtitle",
  tunables: {
    subtitle_max_minutes: { default: 60, min: 5, max: 100, what: "做字幕的视频最长多少分钟" },
    subtitle_daily: { default: 6, min: 0, max: 30, what: "每天最多做几次视频字幕" },
  },
  about: [
    "做字幕：视频在云电脑里取下来，声音按停顿切成几段，用 Cloudflare 的 Whisper 模型转写，带每个词的时间",
    "字幕按句子和停顿断行：中文一行最多 16 个字、英文 42 个字母，每条至少显示一秒，前后不重叠，输出标准 .srt",
    "翻译用 DeepSeek，一批 40 条带编号，回来的行数对不上就重试一次；双语字幕原文在上、译文在下",
    "烧进画面用云电脑里的 ffmpeg 和思源黑体，画面缩到 720p 左右；太长的视频会拒绝并说能烧多长，超过 25 MB 的成品放文件箱",
    "转写按分钟占每天的免费 AI 额度（一分钟约 47 neurons），烧字幕按视频长度占云电脑时间；额度不够时先说清楚再停",
  ],
  tools: ctx => [subtitleTool(ctx)],
};
export default feature;
