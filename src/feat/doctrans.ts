// Document translation: a Word, PowerPoint, Excel, PDF, Markdown, text or subtitle file comes back in
// another language with its layout kept. Office files are opened in the cloud computer by a Python script
// that lists the text as segments with stable ids and later writes the translations back into the same
// XML (everything it does not touch is copied byte for byte); the Worker does the translating with the chat
// model in batches. PDFs come back as a Word or Markdown document with page markers. Text formats never
// need the machine.
import type { Feature, Ctx } from "./types.ts";
import type { Tool } from "../core.ts";
import type { Hub } from "../hub.ts";
import type { ComputerRequest, ComputerResult } from "../computer.ts";
import { boxFile, boxDownloadCommand, boxUpload } from "./filebox.ts";
import { dsChat } from "../llm.ts";

const CAP = 25 * 1024 * 1024;   // the cloud computer's path in and out for one file
const ROOT = "/work/doctrans";
const BATCH_CHARS = 2500, BATCH_ITEMS = 40, PARALLEL = 3, PIECE_MAX = 3000;

export type Kind = "docx" | "pptx" | "xlsx" | "pdf" | "md" | "txt" | "srt";
/** One piece of text to translate. `ph` are the protected bits (code, links) a translation must keep. */
export type Seg = { id: string; text: string; kind?: string; page?: number; slide?: number; ph?: string[]; pipes?: number };
export type Ask = (messages: any[], maxTokens: number) => Promise<string>;

/** Everything with side effects, replaceable in tests. */
export type Deps = {
  runComputer(hub: Hub, req: ComputerRequest): Promise<ComputerResult>;
  ask(hub: Hub): Ask;
  boxFile: typeof boxFile;
  boxDownloadCommand: typeof boxDownloadCommand;
  boxUpload: typeof boxUpload;
  id(): string;
};
const realDeps: Deps = {
  // Imported on use: computer.ts needs the Workers runtime.
  runComputer: async (hub, req) => (await import("../computer.ts")).runComputer(hub, req),
  ask: hub => async (messages, maxTokens) => String((await dsChat(hub.env, { messages, max_tokens: maxTokens, label: "文档翻译" }, "none", 150000)).message?.content || ""),
  boxFile, boxDownloadCommand, boxUpload,
  id: () => [...crypto.getRandomValues(new Uint8Array(5))].map(b => b.toString(16).padStart(2, "0")).join(""),
};

const clip = (s: unknown, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const sq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
const mb = (n: number) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB");
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/;
const CJK_G = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;
const LATIN_G = /[A-Za-zÀ-ɏЀ-ӿ]/g;
const hasLetters = (t: string) => /\p{L}/u.test(t);

// ---------- kinds, languages, ranges ----------

export function kindOf(name: string): Kind | null {
  const e = (name.match(/\.([^./]{1,8})$/)?.[1] || "").toLowerCase();
  if (e === "docx" || e === "docm") return "docx";
  if (e === "pptx" || e === "pptm") return "pptx";
  if (e === "xlsx" || e === "xlsm") return "xlsx";
  if (e === "pdf") return "pdf";
  if (e === "md" || e === "markdown") return "md";
  if (e === "txt" || e === "text") return "txt";
  if (e === "srt" || e === "vtt") return "srt";
  return null;
}
const OLD: Record<string, string> = { doc: "docx", ppt: "pptx", xls: "xlsx" };

const LANGS: [RegExp, string, string][] = [
  [/^(en|eng|english|英文|英语)$/i, "英文", "EN"],
  [/^(zh|zh-cn|zh-hans|cn|chinese|中文|汉语|简体|简体中文)$/i, "简体中文", "中文"],
  [/^(zh-tw|zh-hk|zh-hant|繁体|繁體|繁体中文|繁體中文)$/i, "繁体中文", "繁中"],
  [/^(ja|jp|japanese|日文|日语|日語)$/i, "日文", "日文"],
  [/^(ko|kr|korean|韩文|韩语)$/i, "韩文", "韩文"],
  [/^(fr|french|法文|法语)$/i, "法文", "法文"],
  [/^(de|german|德文|德语)$/i, "德文", "德文"],
  [/^(es|spanish|西班牙文|西班牙语)$/i, "西班牙文", "西文"],
  [/^(ru|russian|俄文|俄语)$/i, "俄文", "俄文"],
];
/** The target language as the model and the file name see it. */
export function language(to: string): { name: string; tag: string } {
  const t = String(to || "").trim();
  for (const [re, name, tag] of LANGS) if (re.test(t)) return { name, tag };
  const name = clip(t.replace(/[^\p{L}\p{N} -]/gu, "").replace(/\s+/g, " ").trim(), 20) || "英文";
  return { name, tag: name.replace(/\s+/g, "") };
}
const isChinese = (l: string) => l === "简体中文" || l === "繁体中文";

/** "1-3,7" → [1,2,3,7]; null for nothing given; an error string for a bad range. */
export function parseRange(spec: unknown): number[] | null | string {
  const t = String(spec ?? "").trim();
  if (!t) return null;
  const out = new Set<number>();
  for (const part of t.split(/[,，、\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d{1,4})(?:\s*[-~–到至]\s*(\d{1,4}))?$/);
    if (!m) return "页码范围写成 1-5 或 1,3,8 这样";
    const a = Number(m[1]), b = Number(m[2] ?? m[1]);
    if (a < 1 || b < a || b - a > 2000) return "页码范围不对：" + part;
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

/** Mostly Chinese, Japanese or Korean (one such character counts about as much as a short word). */
export function mostlyCjk(segs: Seg[]) {
  let c = 0, l = 0;
  for (const s of segs) { c += (s.text.match(CJK_G) || []).length; l += (s.text.match(LATIN_G) || []).length; }
  return c > 0 && c * 3 >= l;
}

/** Segments that are already in the target language are left alone (names, code, terms in a Chinese text). */
export function needsWork(s: Seg, to: string, docCjk: boolean) {
  if (to === "英文" && docCjk) return CJK.test(s.text);
  if (isChinese(to) && !docCjk) return /[A-Za-zÀ-ɏЀ-ӿ]/.test(s.text);
  return true;
}

// ---------- protecting what must not change ----------

const MARK = (n: number) => "⟦" + n + "⟧";
const PROTECT = [
  /(`+)[^`\n][\s\S]*?\1/g,                        // inline code
  /\]\([^)\s]*(?:\s+"[^"]*")?\)/g,                // link and image targets
  /<https?:[^>\s]+>/g,                            // autolinks
  /<\/?[A-Za-z][^>\n]*>/g,                        // inline HTML and subtitle tags
  /\{\\[^}\n]*\}/g,                               // subtitle style codes like {\an8}
  /\{#[^}\n]+\}/g,                                // heading anchors
  /\[\^[^\]\n]+\]/g,                              // footnote markers
  /https?:\/\/[^\s)>\]"'，。、]+/g,                // bare links
];
export function protect(text: string): { text: string; ph: string[] } {
  const ph: string[] = [];
  let t = text;
  for (const re of PROTECT) t = t.replace(re, m => (/⟦\d+⟧/.test(m) ? m : (ph.push(m), MARK(ph.length))));
  return { text: t, ph };
}
export const restore = (t: string, ph: string[]) => t.replace(/⟦(\d+)⟧/g, (m, n) => ph[Number(n) - 1] ?? m);

/** Whether a translation keeps what it must: every placeholder exactly once, table cells intact. */
export function keeps(s: Seg, t: string) {
  if (typeof t !== "string" || !t.trim()) return false;
  for (let i = 1; i <= (s.ph?.length || 0); i++) if (t.split(MARK(i)).length !== 2) return false;
  if (/⟦\d+⟧/.test(t.replace(/⟦(\d+)⟧/g, (m, n) => (Number(n) <= (s.ph?.length || 0) ? "" : m)))) return false;
  if (s.pipes !== undefined && (t.match(/\|/g) || []).length !== s.pipes) return false;
  return true;
}

// ---------- translating ----------

/** Groups segments into requests of bounded size, in order. */
export function batches<T extends { text: string }>(items: T[], maxChars = BATCH_CHARS, maxItems = BATCH_ITEMS): T[][] {
  const out: T[][] = [];
  let cur: T[] = [], size = 0;
  for (const it of items) {
    if (cur.length && (size + it.text.length > maxChars || cur.length >= maxItems)) { out.push(cur); cur = []; size = 0; }
    cur.push(it); size += it.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function prompt(items: Seg[], to: string, glossary = "") {
  const system = "你是专业的文档翻译。把用户给的 JSON 里每个片段翻译成" + to + "。只输出一个 JSON 对象：键和输入的键完全一样，一个不少，值是译文。" +
    "要求：意思准确，读起来像母语者写的；数字、金额、日期、代码、网址、邮箱、文件名、型号和人名照原样保留；⟦1⟧ 这样的占位符原样留在译文里对应的位置；" +
    "Markdown 符号和表格竖线 | 不变；片段里有换行就照样换行；已经是" + to + "的片段原样返回；不要解释，JSON 以外一个字也不要写。" +
    (glossary ? "\n术语表（必须照用）：\n" + glossary : "");
  return [{ role: "system", content: system }, { role: "user", content: JSON.stringify(Object.fromEntries(items.map((s, i) => [String(i + 1), s.text]))) }];
}

export function parseReply(text: string): Record<string, unknown> | null {
  const t = String(text || "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { const j = JSON.parse(t.slice(a, b + 1)); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}

// A Chinese character can turn into two or three English tokens; leave room for the JSON around it.
export const maxTokensFor = (items: Seg[]) => Math.min(8000, 300 + items.length * 8 + Math.ceil(items.reduce((s, x) => s + x.text.length, 0) * 2.2));

export type Progress = { map: Record<string, string>; done: number; total: number };

/** Translates segments a few requests at a time. Identical texts are asked once; a request that fails or
 *  leaves ids out is tried once more in two halves; whatever still fails keeps its original text. */
export async function translate(segs: Seg[], o: { to: string; glossary?: string; parallel?: number; batchChars?: number; known?: Record<string, string>; progress?(p: Progress): void }, ask: Ask) {
  const groups = new Map<string, Seg[]>();
  for (const s of segs) { const g = groups.get(s.text); if (g) g.push(s); else groups.set(s.text, [s]); }
  const map: Record<string, string> = {}, todo: Seg[] = [];
  for (const g of groups.values()) {
    const k = o.known?.[g[0].id];
    if (typeof k === "string" && keeps(g[0], k)) for (const s of g) map[s.id] = k; else todo.push(g[0]);
  }
  let calls = 0, done = 0;
  const once = async (items: Seg[]) => {
    calls++;
    let reply: Record<string, unknown> | null = null;
    try { reply = parseReply(await ask(prompt(items, o.to, o.glossary), maxTokensFor(items))); } catch (e: any) { console.log("doctrans: request failed", e?.message); }
    const missing: Seg[] = [];
    items.forEach((s, i) => {
      const t = reply?.[String(i + 1)];
      if (typeof t === "string" && keeps(s, t)) for (const x of groups.get(s.text)!) map[x.id] = t;
      else missing.push(s);
    });
    return missing;
  };
  const queue = batches(todo, o.batchChars), total = queue.length, failed: Seg[] = [];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const miss = await once(b);
      if (miss.length > 1) { const h = Math.ceil(miss.length / 2); failed.push(...await once(miss.slice(0, h)), ...await once(miss.slice(h))); }
      else if (miss.length) failed.push(...await once(miss));
      done++;
      o.progress?.({ map, done, total });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.parallel || PARALLEL, total)) }, worker));
  return { map, failed: failed.flatMap(s => groups.get(s.text)!.map(x => x.id)), calls, batches: total };
}

// ---------- text formats, handled in the Worker ----------

export type Piece = string | { seg: Seg; prefix: string; raw: string; kind: "h" | "p" | "li" | "row" | "cue" | "txt" };
let counter = 0;
function piece(out: Piece[], prefix: string, body: string, raw: string, kind: Exclude<Piece, string>["kind"]) {
  const p = protect(body);
  if (!hasLetters(p.text.replace(/⟦\d+⟧/g, ""))) { out.push(raw); return; }
  const seg: Seg = { id: "t" + ++counter, text: p.text, ...(p.ph.length ? { ph: p.ph } : {}) };
  if (kind === "row") seg.pipes = (p.text.match(/\|/g) || []).length;
  out.push({ seg, prefix, raw, kind });
}
const joinLine = (a: string, b: string) => (CJK.test(a.slice(-1)) && CJK.test(b[0] || "") ? a + b : a + " " + b);

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const START = /^(?:\s{0,3}#{1,6}\s+|\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?|\s{0,3}>\s?)/;
const ROW = /^\s*\|.*\|\s*$/;
const KEEP_LINE = [
  /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,                                   // horizontal rule
  /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/,                // table separator
  /^\s{0,3}\[[^\]]+\]:\s*\S+/,                                        // link definition
  /^\s*<\/?[A-Za-z!][^>]*>\s*$/,                                      // a line of HTML
  /^\s*!\[[^\]]*\]\([^)]*\)\s*$/,                                     // an image alone
];
const keepLine = (l: string) => KEEP_LINE.some(re => re.test(l));

/** Markdown as pieces: front matter, code blocks, math blocks, rules and link definitions stay as they are;
 *  headings, list items, quotes, table rows and paragraphs are translated with their inline code and links protected. */
export function splitMarkdown(src: string): Piece[] {
  counter = 0;
  const lines = src.split("\n"), out: Piece[] = [];
  let i = 0, last = "";
  if (/^---\s*$/.test(lines[0] || "")) {
    const end = lines.findIndex((l, k) => k > 0 && /^(---|\.\.\.)\s*$/.test(l));
    if (end > 0) { out.push(lines.slice(0, end + 1).join("\n")); i = end + 1; }
  }
  while (i < lines.length) {
    const line = lines[i], f = line.match(FENCE);
    if (f) {
      const close = new RegExp("^\\s{0,3}[" + f[1][0] + "]{" + f[1].length + ",}\\s*$");
      let j = i + 1;
      while (j < lines.length && !close.test(lines[j])) j++;
      out.push(lines.slice(i, j + 1).join("\n")); i = j + 1; last = "code"; continue;
    }
    if (/^\s*\$\$/.test(line)) {
      let j = /\$\$.*\$\$/.test(line) ? i : i + 1;
      while (j < lines.length && !lines[j].includes("$$")) j++;
      out.push(lines.slice(i, j + 1).join("\n")); i = j + 1; last = "code"; continue;
    }
    if (!line.trim() || keepLine(line)) { out.push(line); i++; if (line.trim()) last = "keep"; continue; }
    // An indented block after a blank line is code, unless it continues a list item.
    if (/^( {4}|\t)/.test(line) && !START.test(line) && (i === 0 || !lines[i - 1].trim()) && last !== "li") { out.push(line); i++; continue; }
    const h = line.match(/^(\s{0,3}#{1,6}\s+)(.*)$/);
    if (h) { piece(out, h[1], h[2], line, "h"); i++; last = "h"; continue; }
    if (ROW.test(line)) { piece(out, "", line, line, "row"); i++; last = "row"; continue; }
    const m = line.match(START), prefix = m ? m[0] : line.match(/^\s*/)![0], raw = [line];
    let body = line.slice(prefix.length), j = i + 1;
    while (j < lines.length && lines[j].trim() && !START.test(lines[j]) && !FENCE.test(lines[j]) && !ROW.test(lines[j]) && !keepLine(lines[j]) && !/^\s*\$\$/.test(lines[j])) {
      body = joinLine(body.trimEnd(), lines[j].trim()); raw.push(lines[j]); j++;
    }
    const kind = m ? "li" : "p";
    piece(out, prefix, body, raw.join("\n"), kind);
    i = j; last = kind;
  }
  return out;
}

/** Subtitles: numbering and times stay, the cue text is translated. */
export function splitSrt(src: string): Piece[] {
  counter = 0;
  const out: Piece[] = [], end = src.match(/\s*$/)![0];
  src.slice(0, src.length - end.length).split(/\n[ \t]*\n/).forEach((block, k) => {
    if (k) out.push("\n\n");
    const lines = block.split("\n"), t = lines.findIndex(l => l.includes("-->"));
    if (t < 0 || t > 1 || t >= lines.length - 1) { out.push(block); return; }
    piece(out, lines.slice(0, t + 1).join("\n") + "\n", lines.slice(t + 1).join("\n"), block, "cue");
  });
  if (end) out.push(end);
  return out;
}

/** Plain text: paragraphs (separated by blank lines) are the pieces; very long ones are cut at line ends. */
export function splitText(src: string): Piece[] {
  counter = 0;
  const out: Piece[] = [], end = src.match(/\s*$/)![0];
  src.slice(0, src.length - end.length).split(/(\n[ \t]*\n+)/).forEach((part, k) => {
    if (k % 2) { out.push(part); return; }
    const chunks: string[] = [];
    let cur = "";
    for (const line of part.split("\n")) {
      if (cur && cur.length + line.length > PIECE_MAX) { chunks.push(cur); cur = line; } else cur = cur ? cur + "\n" + line : line;
    }
    chunks.push(cur);
    chunks.forEach((c, n) => {
      if (n) out.push("\n");
      const prefix = c.match(/^\s*/)![0];
      piece(out, prefix, c.slice(prefix.length), c, "txt");
    });
  });
  if (end) out.push(end);
  return out;
}

export const segsOf = (pieces: Piece[]) => pieces.filter(p => typeof p !== "string").map(p => (p as Exclude<Piece, string>).seg);

export function joinPieces(pieces: Piece[], map: Record<string, string>, bilingual: boolean, sep = "\n") {
  return pieces.map(p => {
    if (typeof p === "string") return p;
    const t = map[p.seg.id];
    if (t === undefined) return p.raw;
    const tr = restore(t.trim(), p.seg.ph || []), orig = restore(p.seg.text, p.seg.ph || []);
    if (!bilingual || p.kind === "row") return p.prefix + tr;
    if (p.kind === "h") return p.prefix + orig + " / " + tr;
    if (p.kind === "cue") return p.prefix + orig + "\n" + tr;
    if (p.kind === "li") return p.raw + "  \n" + (/^\s*>/.test(p.prefix) ? p.prefix : " ".repeat(p.prefix.length)) + tr;
    if (p.kind === "p") return p.raw + "\n\n" + p.prefix + tr;
    return p.raw + "\n" + p.prefix + tr;
  }).join(sep);
}

/** Text bytes as a string: UTF-8 first, then UTF-16 with a mark, then GBK (common for Chinese subtitles). */
export function decodeText(bytes: Uint8Array): { text: string; bom: boolean; crlf: boolean; note?: string } {
  let b = bytes, bom = false, text = "", note: string | undefined;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) { b = b.subarray(3); bom = true; }
  if (b[0] === 0xff && b[1] === 0xfe) { text = new TextDecoder("utf-16le").decode(b.subarray(2)); note = "原文件是 UTF-16 编码，译文存成了 UTF-8"; }
  else {
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b); }
    catch {
      try { text = new TextDecoder("gb18030").decode(b); note = "原文件是 GBK 编码，译文存成了 UTF-8"; }
      catch { text = new TextDecoder().decode(b); }
    }
  }
  return { text: text.replace(/\r\n?/g, "\n"), bom, crlf: /\r\n/.test(text), note };
}
export function encodeText(text: string, how: { bom: boolean; crlf: boolean }) {
  return new TextEncoder().encode((how.bom ? "﻿" : "") + (how.crlf ? text.replace(/\n/g, "\r\n") : text));
}

/** PDF pages as Markdown: a marker per page, headings kept as headings, the original quoted above each paragraph when bilingual. */
export function pdfMarkdown(title: string, items: { page: number; kind?: string; o: string; t: string }[], pageLabel: string, bilingual: boolean) {
  const out = ["# " + title, ""];
  let page = 0;
  for (const it of items) {
    if (it.page !== page) { page = it.page; out.push("## " + pageLabel.replace("{n}", String(page)), ""); }
    if (bilingual) out.push("> " + it.o.replace(/\n/g, " "), "");
    out.push((it.kind === "h" ? "### " : "") + it.t.replace(/\n/g, " "), "");
  }
  return out.join("\n");
}

// ---------- the cloud computer side ----------

export const runDir = (id: string) => ROOT + "/" + id;
const rel = (p: string) => p.replace(/^\/work\//, "");

/** Puts the input in place: a chat file dropped in /work, or a file-box download (skipped when an earlier step of the same job left it there). */
export function prepareCommand(dir: string, srcName: string | null, moves: { from: string; to: string }[], download: string | null) {
  return [
    "set -e",
    "mkdir -p " + sq(ROOT),
    // Leftovers of jobs whose cleanup never happened go after two hours.
    "find " + sq(ROOT) + " -mindepth 1 -maxdepth 1 -type d -mmin +120 -exec rm -rf {} + 2>/dev/null || true",
    "mkdir -p " + sq(dir + "/out"),
    "cd " + sq(dir),
    ...moves.map(m => "mv -f -- " + sq(m.from) + " " + sq(m.to)),
    ...(download && srcName ? ["[ -s " + sq(srcName) + " ] || " + download] : []),
  ].join("\n");
}

/** Writes the script into the run directory and runs it with its arguments as one JSON word. */
export function scriptCommand(dir: string, args: Record<string, unknown>) {
  const pdf = args.kind === "pdf" && args.mode === "extract";
  return [
    "cd " + sq(dir) + " || exit 1",
    "set -e",
    "cat > dt.py <<'DT_PY_EOF'\n" + SCRIPT + "\nDT_PY_EOF",
    'PY=/opt/py/bin/python; [ -x "$PY" ] || PY=python3',
    ...(pdf ? ['"$PY" -c "import pymupdf" 2>/dev/null || "$PY" -c "import fitz" 2>/dev/null || uv pip install -q --python "$PY" pymupdf >&2 || "$PY" -m pip install -q pymupdf >&2'] : []),
    '"$PY" -I dt.py ' + sq(JSON.stringify(args)),
  ].join("\n");
}

/** Reports the result's size and, when it is too big to come back through the Worker, runs the file-box upload. */
export function finishCommand(dir: string, out: string, upload: string) {
  return [
    "cd " + sq(dir) + " || exit 1",
    "size=$(wc -c < " + sq(out) + " | tr -d ' ')",
    'echo "@@size $size"',
    'if [ "$size" -gt ' + CAP + " ]; then ( " + upload + "\n) && echo @@boxed || echo @@boxfail; fi",
  ].join("\n");
}

export function parseStats(stdout: string): Record<string, any> {
  const line = stdout.split("\n").reverse().find(l => l.startsWith("@@dt "));
  try { return line ? JSON.parse(line.slice(5)) : {}; } catch { return {}; }
}

function stepError(r: ComputerResult, what: string) {
  const st = r.steps.find(s => s.exit !== 0);
  if (!st) return what + "没做完：" + (r.error || "不知道为什么停了");
  const last = (st.stderr.trim() || st.stdout.trim()).split("\n").map(l => l.trim()).filter(Boolean).pop() || "";
  return st.exit === 124 ? what + "超时了" : what + "出错了" + (last ? "：" + clip(last, 200) : "");
}

// ---------- the tool ----------

export type Args = { file?: string; to?: string; bilingual?: boolean; glossary?: string; pages?: string; slides?: string; format?: string };
const TEXTY = new Set<Kind>(["md", "txt", "srt"]);

/** Pulls the link out of "[文件 名字 链接]" and keeps the name as a fallback. */
function parseRef(ref: string): { ref: string; name?: string } {
  const t = ref.trim(), m = t.match(/^\[?文件\s+(.+?)\s+(https?:\/\/\S+?)\]?$/);
  return m ? { ref: m[2], name: m[1] } : { ref: t.replace(/^\[|\]$/g, "") };
}

export function outName(name: string, tag: string, ext: string) {
  const base = (name.split(/[\\/]/).pop() || "").replace(/\.[^.]{1,8}$/, "").replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, "_").trim();
  return ([...(base || "文档")].slice(0, 60).join("") + "_" + tag + "." + ext);
}

/** Rough wait: a request of about 2,500 characters takes half a minute, a few run at once. */
export const estimateSeconds = (segs: Seg[]) => 10 + Math.ceil(batches(segs).length / PARALLEL) * 35;

async function digest(text: string) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...h.slice(0, 10)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const NOTES: Record<Kind, string> = {
  docx: "每段译文沿用这一段里字数最多那处的字体格式；同一段里局部加粗、变色、超链接对不上词，会变成整段一种格式。样式、编号、表格、图片、页眉页脚都保留；页码、目录这类域没动（目录在 Word 里更新域就行）",
  pptx: "版式、图片、表格、备注都保留；每段译文沿用这一段里字数最多那处的格式；译文明显变长的文本框把字号缩小了（最多缩到七成），个别框可能还要手动调；图表和 SmartArt 里的字没翻",
  xlsx: "公式、数字、日期都没动，单元格格式保留；工作表名字和图表里的字没翻；列宽没变，长的译文可能要拉宽列或设自动换行",
  pdf: "PDF 没法原样排版，给的是按页整理的文档；表格、多栏排版的段落顺序可能有点乱",
  md: "代码块、行内代码、链接地址、front matter 都没动",
  txt: "按段翻译，空行和段落顺序不变",
  srt: "字幕序号和时间轴不变",
};

/** Translates one document for a conversation; tests call it with fake deps. */
export async function translateDoc(ctx: Ctx, a: Args, deps: Deps = realDeps): Promise<any> {
  const { hub, conv, host } = ctx;
  const given = String(a.file ?? "").trim();
  if (!given) return { ok: false, error: "要给文件：聊天里 [文件 名字 链接] 的链接、f 开头的文件编号，或文件箱的 x 编号" };
  let name = "", bytes: Uint8Array | null = null, box = "";
  if (/^x\d+$/i.test(given)) {
    const b = deps.boxFile(hub, conv, given.toLowerCase());
    if (!b) return { ok: false, error: "文件箱里找不到 " + given + "（可能过期了或不是这个群的）" };
    name = b.name; box = given.toLowerCase();
  } else {
    const p = parseRef(given);
    const got = await host.fileRef(p.ref).catch(() => null);
    if (!got) return { ok: false, error: "取不到文件 " + clip(given, 80) + "，让群友重发一次，或者换成文件编号" };
    name = got.name || p.name || "file"; bytes = got.bytes;
  }
  const ext = (name.match(/\.([^./]{1,8})$/)?.[1] || "").toLowerCase(), kind = kindOf(name);
  if (!kind) return { ok: false, error: OLD[ext] ? "「" + name + "」是老的 ." + ext + " 格式，先用 Office 或 WPS 另存为 ." + OLD[ext] + " 再发" : "「" + name + "」这种文件翻不了；能翻的是 Word（docx）、PPT（pptx）、Excel（xlsx）、PDF、Markdown、txt 和 srt 字幕" };
  if (bytes && bytes.length > CAP) return { ok: false, error: name + " 有 " + mb(bytes.length) + "，超过 25 MB；先存进文件箱，再用 x 开头的编号" };
  if (box && TEXTY.has(kind)) return { ok: false, error: "文本和字幕文件直接发在群里就行，文件箱里的这类文件翻不了" };
  const pages = parseRange(a.pages), slides = parseRange(a.slides);
  if (typeof pages === "string") return { ok: false, error: pages };
  if (typeof slides === "string") return { ok: false, error: slides.replace("页码", "幻灯片") };
  const format = kind === "pdf" && String(a.format || "").toLowerCase() === "md" ? "md" : "docx";
  const bilingual = a.bilingual === true || String(a.bilingual) === "true";
  const glossary = clip(String(a.glossary || "").trim(), 1500);
  const cfg = (k: string, d: number) => { const n = Number(host.cfg(k)); return Number.isFinite(n) && n > 0 ? n : d; };
  const capChars = cfg("doctrans_max_chars", 150000);
  const office = !TEXTY.has(kind);
  if (office && (!hub.plan.fits("container_seconds", 300) || !hub.plan.fits("container_cpu_seconds", 60))) return { ok: false, error: "这个月云电脑的额度快到停止线了，这种文件现在翻不了；Markdown、txt 和字幕还能翻" };
  if (!(await host.quota("doctrans", cfg("doctrans_daily", 20)))) return { ok: false, error: "今天翻译文档的次数用完了，明天再来" };

  const notes: string[] = [NOTES[kind]];
  if ((pages && kind !== "pdf") || (slides && kind !== "pptx")) notes.push("页码范围只对 PDF（pages）和 PPT（slides）有效，这次是整份翻的");

  // Shared by every kind: pick the language, skip what is already in it, check the size, translate.
  const work = async (segs: Seg[]) => {
    const docCjk = mostlyCjk(segs);
    const lang = language(a.to ? String(a.to) : docCjk ? "英文" : "简体中文");
    const todo = segs.filter(s => needsWork(s, lang.name, docCjk));
    const chars = todo.reduce((s, x) => s + x.text.length, 0);
    if (chars > capChars) return { error: "这份文件要翻的文字有 " + chars + " 字，超过一次的上限 " + capChars + " 字" + (kind === "pdf" ? "；可以用 pages 分几次翻" : kind === "pptx" ? "；可以用 slides 分几次翻" : "；可以拆成几个文件，或者请群主调高 doctrans_max_chars") };
    const est = estimateSeconds(todo);
    if (todo.length && est >= 60) await host.say("开始翻《" + clip(name, 40) + "》：要翻大约 " + chars + " 字，估计 " + Math.ceil(est / 60) + " 分钟左右，翻好直接发群里。").catch(() => false);
    const key = await digest(JSON.stringify([lang.name, glossary, todo.map(s => s.id + "\u0001" + s.text)]));
    const saved = host.scratch("doctrans");
    let lastSave = Date.now();
    const r = await translate(todo, {
      to: lang.name, glossary, known: saved?.key === key ? saved.map : undefined,
      progress: p => { if (Date.now() - lastSave > 15000) { lastSave = Date.now(); host.scratch("doctrans", { key, map: p.map }); } },
    }, deps.ask(hub));
    host.scratch("doctrans", null);
    return { lang, todo, chars, r, skipped: segs.length - todo.length };
  };
  const summary = (w: { todo: Seg[]; chars: number; r: { map: Record<string, string>; failed: string[]; calls: number }; skipped: number; lang: { name: string } }) => ({
    to: w.lang.name, chars: w.chars, segments_translated: Object.keys(w.r.map).length,
    ...(w.r.failed.length ? { kept_original: w.r.failed.length, kept_note: "有 " + w.r.failed.length + " 段翻译没成功，保留了原文" } : {}),
    ...(w.skipped ? { already_in_target_language: w.skipped } : {}),
    requests: w.r.calls,
  });
  const deliver = async (file: string, out: Uint8Array) => {
    const r = await host.sendFile(file, out);
    const ref = await host.keepFile(file, out);
    return {
      file, size: mb(out.length), ...(ref ? { ref } : {}),
      ...(r.ok ? { sent: true } : { sent: false, send_error: r.error || "发送失败" }),
      ...(r.queued ? { delivery: "现在群里没人说话，QQ 不让主动发文件；已经排好队，下一次有人说话时会自动发出去。照实说还没发出去" } : {}),
    };
  };

  if (!office) {
    const d = decodeText(bytes!);
    const pieces = kind === "md" ? splitMarkdown(d.text) : kind === "srt" ? splitSrt(d.text) : splitText(d.text);
    const segs = segsOf(pieces);
    if (!segs.length) return { ok: false, error: "文件里没找到要翻的文字" };
    const w = await work(segs);
    if ("error" in w) return { ok: false, error: w.error };
    const text = joinPieces(pieces, w.r.map, bilingual, kind === "md" ? "\n" : "");
    const file = outName(name, (bilingual ? "双语_" : "") + w.lang.tag, ext);
    if (d.note) notes.push(d.note);
    return { ok: true, ...summary(w), ...(await deliver(file, encodeText(text, d))), notes };
  }

  const id = deps.id(), dir = runDir(id), src = "src." + ext, tmp = "doctrans-" + id + "-in";
  const download = box ? deps.boxDownloadCommand(hub, conv, box, src) : null;
  if (box && !download) return { ok: false, error: "文件箱现在用不了，取不到 " + box };
  const range = kind === "pptx" ? slides : kind === "pdf" ? pages : null;
  const machine = (req: ComputerRequest) => deps.runComputer(hub, req).catch((e: any): ComputerResult => ({ ok: false, steps: [], files: [], seconds: 0, error: String(e?.message || e) }));
  let seconds = 0, touched = false;
  const cleanup = async () => { if (touched) seconds += (await machine({ commands: ["rm -rf -- " + sq(dir)], timeoutSeconds: 30 })).seconds; touched = false; };
  try {
    touched = true;
    const r1 = await machine({
      commands: [prepareCommand(dir, src, bytes ? [{ from: "/work/" + tmp, to: src }] : [], download), scriptCommand(dir, { mode: "extract", kind, src, out: "seg.json", range })],
      files: bytes ? [{ name: tmp, bytes }] : [], collect: [rel(dir) + "/seg.json"], timeoutSeconds: box ? 900 : 300,
    });
    seconds += r1.seconds;
    const raw = r1.files.find(f => f.name.endsWith("seg.json"));
    if (!r1.ok || !raw) { await cleanup(); return { ok: false, error: stepError(r1, "读取文件时"), seconds }; }
    let data: any;
    try { data = JSON.parse(new TextDecoder().decode(raw.bytes)); } catch { await cleanup(); return { ok: false, error: "读出来的内容坏了，再试一次" }; }
    if (data.scanned) { await cleanup(); return { ok: false, scanned: true, error: "这个 PDF 是扫描出来的图片，没有文字层，没法直接翻；要先做文字识别（OCR）再翻" }; }
    const segs: Seg[] = (data.segs || []).map((s: any) => ({ id: String(s.id), text: String(s.text), ...(s.kind ? { kind: s.kind } : {}), ...(s.page ? { page: s.page } : {}) }));
    if (!segs.length) { await cleanup(); return { ok: false, error: range ? "选的范围里没找到要翻的文字" : "文件里没找到要翻的文字" }; }
    const w = await work(segs);
    if ("error" in w) { await cleanup(); return { ok: false, error: w.error }; }
    const tag = (bilingual ? "双语_" : "") + w.lang.tag;
    const extra = { ...(data.pages_total ? { pages_total: data.pages_total, pages_done: data.pages } : {}), ...(data.slides_total ? { slides_total: data.slides_total } : {}) };
    const writeBack = async (tr: unknown, outExt: string) => {
      const file = outName(name, tag, outExt), outPath = "out/result." + outExt, trTmp = "doctrans-" + id + "-tr";
      const up = deps.boxUpload(hub, conv, dir + "/" + outPath, file);
      const moves = [{ from: "/work/" + trTmp, to: "tr.json" }, ...(bytes && kind !== "pdf" ? [{ from: "/work/" + tmp, to: src }] : [])];
      const r2 = await machine({
        commands: [
          prepareCommand(dir, kind === "pdf" ? null : src, moves, kind === "pdf" ? null : download),
          scriptCommand(dir, { mode: "write", kind, src, tr: "tr.json", dst: outPath, bilingual, range }),
          finishCommand(dir, outPath, up.command),
        ],
        files: [{ name: trTmp, bytes: new TextEncoder().encode(JSON.stringify(tr)) }, ...(bytes && kind !== "pdf" ? [{ name: tmp, bytes }] : [])],
        collect: [rel(dir) + "/" + outPath], timeoutSeconds: box ? 1200 : 600,
      });
      seconds += r2.seconds;
      await cleanup();
      if (!r2.ok) return { ok: false, error: stepError(r2, "写回译文时"), seconds };
      const stats = parseStats(r2.steps[1]?.stdout || ""), done = r2.steps[2]?.stdout || "";
      if (stats.shrunk) notes.push("有 " + stats.shrunk + " 个文本框因为译文变长缩小了字号");
      const base = { ok: true, ...summary(w), notes, seconds: Math.round(seconds * 10) / 10 };
      if (done.includes("@@boxed")) {
        const c = await up.claim().catch(() => null);
        if (c) return { ...base, file, big_file: { ref: c.ref, link: c.link, size: mb(c.size) }, big_note: "译好的文件超过 25 MB，放进了文件箱：把链接原样发给群友下载" };
      }
      const got = r2.files.find(f => f.name.endsWith(outPath));
      if (!got) return { ok: false, error: done.includes("@@boxfail") ? "译好的文件超过 25 MB，文件箱也存不进去" : "译好的文件没取回来", seconds };
      return { ...base, ...(await deliver(file, got.bytes)) };
    };

    if (kind === "pdf") {
      const items = segs.map(s => ({ page: s.page || 0, kind: s.kind, o: s.text, t: w.r.map[s.id] ?? s.text }));
      const label = isChinese(w.lang.name) ? "第 {n} 页" : "Page {n}", title = outName(name, w.lang.tag, "x").slice(0, -2);
      if (format === "md") {
        await cleanup();
        return { ok: true, ...summary(w), ...extra, ...(await deliver(outName(name, tag, "md"), new TextEncoder().encode(pdfMarkdown(title, items, label, bilingual)))), notes, seconds };
      }
      return { ...(await writeBack({ title, page_label: label, bilingual, items }, "docx")), ...extra };
    }
    return { ...(await writeBack(w.r.map, ext)), ...extra };
  } finally {
    await cleanup();
  }
}

function docTool(ctx: Ctx, deps: Deps): Tool {
  return {
    name: "translate_doc", work: true, slow: true, long: true,
    description: "把一整份文档翻译成另一种语言，排版保持原样，翻完直接把文件发群里。Word（docx）、PPT（pptx）、Excel（xlsx）返回同样格式的文件：样式、编号、表格、图片、页眉页脚、幻灯片版式和备注都在，公式和数字不动，PPT 译文变长时自动把字号缩小一点。PDF 没法原样排版，返回按页整理的 Word（或 Markdown）。Markdown、txt、srt 字幕返回同格式文件，代码块、链接、字幕时间轴不动。扫描版 PDF（没有文字层）翻不了，要先做文字识别。默认中文译成英文、其他语言译成简体中文。大文件要几分钟到十几分钟，开始前会在群里说一声。只想知道文件讲了什么、或者只翻几句话，就别用它。",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "要翻的文件：聊天里 [文件 名字 链接] 的链接、之前存下的文件编号（f12），或文件箱编号（x12，超过 25 MB 的文件走这个）" },
        to: { type: "string", description: "译成什么语言，如 英文、简体中文、日文；不填就按原文自动选（中文→英文，其他→简体中文）" },
        bilingual: { type: "boolean", description: "要原文和译文对照就填 true（Word 里原段落后面跟一段译文，PPT 和 Excel 在原文下面换行加译文）。默认 false，只留译文" },
        glossary: { type: "string", description: "群友指定的固定译法，一行一条，如 \"大模型=LLM\"。没有就不填" },
        pages: { type: "string", description: "PDF 只翻这些页，如 \"1-5\" 或 \"2,4,9-12\"。不填翻全部" },
        slides: { type: "string", description: "PPT 只翻这些页，写法同 pages。不填翻全部" },
        format: { type: "string", enum: ["docx", "md"], description: "PDF 的结果做成 Word（docx，默认）还是 Markdown（md）" },
      },
      required: ["file"],
    },
    run: a => translateDoc(ctx, a || {}, deps),
  };
}

export function makeFeature(deps: Deps = realDeps): Feature {
  return {
    name: "doctrans",
    tools: ctx => [docTool(ctx, deps)],
    tunables: {
      doctrans_daily: { default: 20, min: 0, max: 100, what: "每天最多翻译几份文档" },
      doctrans_max_chars: { default: 150000, min: 5000, max: 400000, what: "一份文档一次最多翻多少字（原文字数）" },
    },
    about: [
      "文档翻译（translate_doc）：Word、PPT、Excel 在云电脑里用 Python 把文字一段段取出来，翻好再写回原文件，没碰的部分原样复制，所以版式、图片、表格、公式都在。",
      "翻译用的是聊天同一个模型，分批并行地翻，每批要求按编号返回 JSON；漏了或格式不对的那批再试一次，还不行就保留原文并说明有几段。",
      "每段译文沿用这一段里字数最多那处的格式，所以同一段里局部加粗、超链接会变成整段统一；PPT 译文变长时字号最多缩到七成。",
      "PDF 没法原样排版，给的是按页整理的 Word 或 Markdown，可以原文译文对照；扫描版 PDF 要先做文字识别。",
      "Markdown、txt、srt 字幕不用云电脑，直接在服务器上翻：代码块、链接、字幕时间轴不动。",
      "一份文档默认最多翻 15 万字，每天最多 20 份，群主可以调。",
    ],
  };
}

// The machine-side script: lists the text of an Office file or a PDF as segments (mode extract) and writes
// translations back into the same XML parts, copying every other part of the package unchanged (mode write).
// It only needs lxml, which python-docx brings along; PDFs need PyMuPDF, installed on first use.
const SCRIPT = String.raw`import sys, os, json, re, copy, math, zipfile, unicodedata
from lxml import etree

ARGS = json.loads(sys.argv[1])
W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
SPACE = '{http://www.w3.org/XML/1998/namespace}space'
PARSER = etree.XMLParser(resolve_entities=False, no_network=True, huge_tree=True)


def w(t): return '{%s}%s' % (W, t)
def a(t): return '{%s}%s' % (A, t)
def s(t): return '{%s}%s' % (S, t)


def fail(msg):
    sys.stderr.write(msg + '\n')
    sys.exit(2)


def letters(t): return any(c.isalpha() for c in t)


def parse(z, name): return etree.fromstring(z.read(name), PARSER)


def dump(root): return etree.tostring(root, xml_declaration=True, encoding='UTF-8', standalone=True)


def open_zip(path):
    try:
        return zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        fail('文件打不开：不是有效的 Office 文件（老的 .doc/.ppt/.xls 要先另存为新格式）')


def save_zip(src, dst, changed):
    with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED) as zo:
        for info in zi.infolist():
            data = changed.get(info.filename)
            zo.writestr(info, zi.read(info.filename) if data is None else data, compress_type=info.compress_type)


def wrap_ws(orig, text):
    lead = orig[:len(orig) - len(orig.lstrip())]
    trail = orig[len(orig.rstrip()):]
    return lead + text.strip() + trail


def longest(runs, text_of):
    best, size = None, -1
    for r in runs:
        n = len(text_of(r).strip())
        if n > size: best, size = r, n
    return best

# ---------- Word ----------

DOCX_PART = re.compile(r'^word/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$')
W_TEXT = {w('t'), w('tab'), w('cr'), w('noBreakHyphen')}


def w_textual(c):
    if c.tag == w('br'): return c.get(w('type')) in (None, 'textWrapping')
    return c.tag in W_TEXT


def w_run_text(r):
    out = []
    for c in r:
        if not w_textual(c): continue
        if c.tag == w('t'): out.append(c.text or '')
        elif c.tag == w('tab'): out.append('\t')
        elif c.tag == w('noBreakHyphen'): out.append('-')
        else: out.append('\n')
    return ''.join(out)


def owner(el, tag):
    e = el.getparent()
    while e is not None and e.tag != tag: e = e.getparent()
    return e


def w_runs(p):
    # The paragraph's own runs, leaving out field codes and field results (page numbers, tables of contents).
    runs, depth = [], 0
    for r in p.iter(w('r')):
        if owner(r, w('p')) is not p: continue
        marks = r.findall(w('fldChar'))
        if marks:
            for fc in marks:
                t = fc.get(w('fldCharType'))
                if t == 'begin': depth += 1
                elif t == 'end': depth = max(0, depth - 1)
            continue
        if depth or owner(r, w('fldSimple')) is not None: continue
        runs.append(r)
    return runs


def w_elements(text):
    els = []
    for k, line in enumerate(text.split('\n')):
        if k: els.append(etree.Element(w('br')))
        for j, piece in enumerate(line.split('\t')):
            if j: els.append(etree.Element(w('tab')))
            if piece:
                t = etree.Element(w('t'))
                t.text = piece
                t.set(SPACE, 'preserve')
                els.append(t)
    return els


def w_fill(r, text):
    kids = [c for c in r if w_textual(c)]
    pos = list(r).index(kids[0]) if kids else len(r)
    for c in kids: r.remove(c)
    for el in reversed(w_elements(text)): r.insert(pos, el)


def docx_paras(z):
    for name in z.namelist():
        if not DOCX_PART.match(name): continue
        root = parse(z, name)
        yield name, root, list(root.iter(w('p')))


def docx_extract(z, opt):
    segs = []
    for name, root, paras in docx_paras(z):
        for i, p in enumerate(paras):
            text = ''.join(w_run_text(r) for r in w_runs(p))
            if letters(text): segs.append({'id': '%s#%d' % (name, i), 'text': text.strip()})
    return {'segs': segs}


def docx_write(z, tr, opt):
    changed, done = {}, 0
    for name, root, paras in docx_paras(z):
        hit = False
        for i, p in enumerate(paras):
            t = tr.get('%s#%d' % (name, i))
            if t is None: continue
            runs = w_runs(p)
            orig = ''.join(w_run_text(r) for r in runs)
            carrier = longest(runs, w_run_text)
            if carrier is None: continue
            if opt.get('bilingual'):
                np = etree.Element(w('p'))
                ppr = p.find(w('pPr'))
                if ppr is not None:
                    c = copy.deepcopy(ppr)
                    for tag in ('numPr', 'sectPr', 'pPrChange'):
                        e = c.find(w(tag))
                        if e is not None: c.remove(e)
                    np.append(c)
                nr = etree.SubElement(np, w('r'))
                rpr = carrier.find(w('rPr'))
                if rpr is not None: nr.append(copy.deepcopy(rpr))
                for el in w_elements(t.strip()): nr.append(el)
                p.addnext(np)
            else:
                for r in runs:
                    if r is carrier: w_fill(r, wrap_ws(orig, t))
                    else:
                        for c in [c for c in r if w_textual(c)]: r.remove(c)
            hit = True
            done += 1
        if hit: changed[name] = dump(root)
    return changed, {'changed': done}

# ---------- PowerPoint ----------


def norm(base, target):
    if target.startswith('/'): return target[1:]
    out = []
    for x in (base + '/' + target).split('/'):
        if x == '..':
            if out: out.pop()
        elif x and x != '.': out.append(x)
    return '/'.join(out)


def rels(z, part):
    d, b = part.rsplit('/', 1)
    rp = d + '/_rels/' + b + '.rels'
    if rp not in z.namelist(): return []
    return [(r.get('Id'), r.get('Type') or '', norm(d, r.get('Target') or '')) for r in parse(z, rp) if r.get('TargetMode') != 'External']


def pptx_parts(z, wanted):
    pres = parse(z, 'ppt/presentation.xml')
    by_id = {i: t for i, _, t in rels(z, 'ppt/presentation.xml')}
    lst = pres.find('{%s}sldIdLst' % P)
    slides = [by_id.get(e.get('{%s}id' % R)) for e in (lst if lst is not None else [])]
    out = []
    for n, part in enumerate(slides, 1):
        if not part or part not in z.namelist() or (wanted and n not in wanted): continue
        out.append((n, part))
        for _, typ, t in rels(z, part):
            if typ.endswith('/notesSlide') and t in z.namelist(): out.append((n, t))
    return out, len(slides)


def a_text(p):
    out = []
    for c in p:
        if c.tag == a('r'):
            t = c.find(a('t'))
            out.append((t.text or '') if t is not None else '')
        elif c.tag == a('br'): out.append('\n')
    return ''.join(out)


def a_run_text(r):
    t = r.find(a('t'))
    return (t.text or '') if t is not None else ''


def body_text(tb): return '\n'.join(a_text(p) for p in tb.iter(a('p')))


def width(t):
    return sum(1.0 if unicodedata.east_asian_width(c) in 'WF' else 0.3 if c.isspace() else 0.55 for c in t)


def a_line(carrier, text):
    r = copy.deepcopy(carrier)
    t = r.find(a('t'))
    if t is None: t = etree.SubElement(r, a('t'))
    t.text = text
    return r


def a_br(carrier):
    br = etree.Element(a('br'))
    rpr = carrier.find(a('rPr'))
    if rpr is not None: br.append(copy.deepcopy(rpr))
    return br


def shrink(tb, before):
    old, new = width(before), width(body_text(tb))
    if old < 2 or new <= old * 1.15: return False
    scale = math.floor(max(0.7, min(1.0, (old / new) ** 0.5)) * 20) / 20
    if scale >= 0.95: return False
    runs = [r for r in tb.iter(a('r')) if a_run_text(r).strip()]
    cell = tb.getparent() is not None and tb.getparent().tag == a('tc')
    explicit = runs and all(r.find(a('rPr')) is not None and r.find(a('rPr')).get('sz') for r in runs)
    if explicit or cell:
        for e in tb.iter(a('rPr'), a('endParaRPr'), a('defRPr')):
            if e.get('sz'): e.set('sz', str(max(600, int(round(int(e.get('sz')) * scale / 50) * 50))))
        if cell and not explicit:
            for r in runs:
                rpr = r.find(a('rPr'))
                if rpr is None:
                    rpr = etree.Element(a('rPr'))
                    r.insert(0, rpr)
                if not rpr.get('sz'): rpr.set('sz', str(int(round(1800 * scale / 50) * 50)))
        return True
    bp = tb.find(a('bodyPr'))
    if bp is None: return False
    for tag in ('noAutofit', 'normAutofit', 'spAutoFit'):
        for e in bp.findall(a(tag)): bp.remove(e)
    fit = etree.Element(a('normAutofit'))
    fit.set('fontScale', str(int(scale * 100000)))
    warp = bp.find(a('prstTxWarp'))
    bp.insert(list(bp).index(warp) + 1 if warp is not None else 0, fit)
    return True


def pptx_extract(z, opt):
    parts, total = pptx_parts(z, set(opt.get('range') or []))
    segs = []
    for n, part in parts:
        for i, p in enumerate(parse(z, part).iter(a('p'))):
            text = a_text(p)
            if letters(text): segs.append({'id': '%s#%d' % (part, i), 'text': text.strip(), 'slide': n})
    return {'segs': segs, 'slides_total': total}


def pptx_write(z, tr, opt):
    parts, _ = pptx_parts(z, set(opt.get('range') or []))
    changed, done, shrunk = {}, 0, 0
    for n, part in parts:
        root = parse(z, part)
        bodies = [(tb, body_text(tb)) for tb in root.iter() if isinstance(tb.tag, str) and tb.tag.endswith('}txBody')]
        hit = False
        for i, p in enumerate(list(root.iter(a('p')))):
            t = tr.get('%s#%d' % (part, i))
            if t is None: continue
            runs = [c for c in p if c.tag == a('r')]
            carrier = longest(runs, a_run_text)
            if carrier is None: continue
            orig = a_text(p)
            if opt.get('bilingual'):
                end = p.find(a('endParaRPr'))
                at = list(p).index(end) if end is not None else len(p)
                new = []
                for line in t.strip().split('\n'): new += [a_br(carrier), a_line(carrier, line)]
                for el in reversed(new): p.insert(at, el)
            else:
                for c in [c for c in p if c.tag == a('br')]: p.remove(c)
                for r in runs:
                    if r is not carrier and r.find(a('t')) is not None: r.find(a('t')).text = ''
                lines = wrap_ws(orig, t).split('\n')
                carrier.find(a('t')).text = lines[0]
                anchor = carrier
                for line in lines[1:]:
                    br, nr = a_br(carrier), a_line(carrier, line)
                    anchor.addnext(br)
                    br.addnext(nr)
                    anchor = nr
            hit = True
            done += 1
        if hit:
            if opt.get('shrink', True):
                for tb, before in bodies:
                    if shrink(tb, before): shrunk += 1
            changed[part] = dump(root)
    return changed, {'changed': done, 'shrunk': shrunk}

# ---------- Excel ----------


def x_text(si):
    rs = si.findall(s('r'))
    if not rs:
        t = si.find(s('t'))
        return (t.text or '') if t is not None else ''
    return ''.join((r.find(s('t')).text or '') for r in rs if r.find(s('t')) is not None)


def x_run_text(r):
    t = r.find(s('t'))
    return (t.text or '') if t is not None else ''


def x_set(si, text):
    rs = si.findall(s('r'))
    if not rs:
        t = si.find(s('t'))
        if t is None: t = etree.SubElement(si, s('t'))
        t.text = text
        t.set(SPACE, 'preserve')
        return
    carrier = longest(rs, x_run_text)
    for r in rs:
        t = r.find(s('t'))
        if t is None: continue
        t.text = text if r is carrier else ''
        t.set(SPACE, 'preserve')


def xlsx_items(z):
    names = z.namelist()
    if 'xl/sharedStrings.xml' in names:
        root = parse(z, 'xl/sharedStrings.xml')
        yield 'xl/sharedStrings.xml', root, root.findall(s('si'))
    for name in sorted(n for n in names if re.match(r'^xl/worksheets/[^/]+\.xml$', n)):
        raw = z.read(name)
        if b'inlineStr' not in raw: continue
        root = etree.fromstring(raw, PARSER)
        yield name, root, [c.find(s('is')) for c in root.iter(s('c')) if c.get('t') == 'inlineStr' and c.find(s('is')) is not None]


def xlsx_extract(z, opt):
    segs = []
    for name, root, items in xlsx_items(z):
        for i, si in enumerate(items):
            text = x_text(si)
            if letters(text): segs.append({'id': '%s#%d' % (name, i), 'text': text.strip()})
    return {'segs': segs}


def xlsx_write(z, tr, opt):
    changed, done = {}, 0
    for name, root, items in xlsx_items(z):
        hit = False
        for i, si in enumerate(items):
            t = tr.get('%s#%d' % (name, i))
            if t is None: continue
            orig = x_text(si)
            x_set(si, orig.rstrip() + '\n' + t.strip() if opt.get('bilingual') else wrap_ws(orig, t))
            hit = True
            done += 1
        if hit: changed[name] = dump(root)
    return changed, {'changed': done}

# ---------- PDF ----------


def cjk(c): return '　' <= c <= '鿿' or '가' <= c <= '힯' or '＀' <= c <= '￯'


def join_lines(lines):
    out = ''
    for l in lines:
        l = l.strip()
        if not l: continue
        if not out: out = l
        elif out.endswith('-') and l[:1].islower(): out = out[:-1] + l
        elif cjk(out[-1]) or cjk(l[0]): out += l
        else: out += ' ' + l
    return out


def pdf_extract(src, opt):
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    try:
        doc = fitz.open(src)
    except Exception:
        fail('PDF 打不开，文件可能坏了')
    if doc.needs_pass: fail('PDF 有密码，打不开')
    total, wanted = doc.page_count, set(opt.get('range') or [])
    pages = [n for n in range(1, total + 1) if not wanted or n in wanted]
    raw, sizes, chars, pics = [], [], 0, 0
    for n in pages:
        page = doc[n - 1]
        if page.get_images(): pics += 1
        k = 0
        for b in page.get_text('dict')['blocks']:
            if b.get('type') != 0: continue
            size, lines = 0, []
            for l in b['lines']:
                lines.append(''.join(sp['text'] for sp in l['spans']))
                for sp in l['spans']:
                    if sp['text'].strip():
                        size = max(size, sp['size'])
                        sizes += [round(sp['size'], 1)] * min(len(sp['text']), 200)
            text = join_lines(lines)
            chars += len(text)
            if letters(text):
                raw.append((n, k, text, size))
                k += 1
    sizes.sort()
    body = sizes[len(sizes) // 2] if sizes else 0
    segs = [{'id': 'p%d#%d' % (n, k), 'text': t, 'page': n, 'kind': 'h' if body and size >= body * 1.25 and len(t) <= 120 else 'p'} for n, k, t, size in raw]
    return {'segs': segs, 'pages_total': total, 'pages': len(pages), 'scanned': chars < 20 * max(1, len(pages)) and (pics > 0 or chars == 0)}


def pdf_docx(opt):
    from docx import Document
    from docx.shared import Pt, RGBColor
    data = json.load(open(opt['tr'], encoding='utf-8'))
    doc = Document()
    doc.add_heading(data.get('title') or '', 0)
    page = None
    for it in data['items']:
        if it['page'] != page:
            page = it['page']
            doc.add_heading(data['page_label'].replace('{n}', str(page)), 2)
        if data.get('bilingual'):
            o = doc.add_paragraph()
            r = o.add_run(it['o'])
            r.font.color.rgb = RGBColor(0x80, 0x80, 0x80)
            r.font.size = Pt(9)
        if it.get('kind') == 'h': doc.add_heading(it['t'], 3)
        else: doc.add_paragraph(it['t'])
    doc.save(opt['dst'])
    return {'changed': len(data['items'])}

# ---------- main ----------

KINDS = {'docx': (docx_extract, docx_write), 'pptx': (pptx_extract, pptx_write), 'xlsx': (xlsx_extract, xlsx_write)}
mode, kind = ARGS['mode'], ARGS['kind']
if mode == 'extract':
    if kind == 'pdf': res = pdf_extract(ARGS['src'], ARGS)
    else:
        z = open_zip(ARGS['src'])
        try:
            res = KINDS[kind][0](z, ARGS)
        except KeyError as e:
            fail('文件里缺少 %s，可能不是标准的 %s 文件' % (e, kind))
    res['ok'] = True
    with open(ARGS['out'], 'w', encoding='utf-8') as f: json.dump(res, f, ensure_ascii=False)
    print('@@dt ' + json.dumps({'segments': len(res['segs']), 'chars': sum(len(x['text']) for x in res['segs'])}))
elif mode == 'write':
    os.makedirs(os.path.dirname(ARGS['dst']) or '.', exist_ok=True)
    if kind == 'pdf': stats = pdf_docx(ARGS)
    else:
        tr = json.load(open(ARGS['tr'], encoding='utf-8'))
        z = open_zip(ARGS['src'])
        changed, stats = KINDS[kind][1](z, tr, ARGS)
        save_zip(ARGS['src'], ARGS['dst'], changed)
    print('@@dt ' + json.dumps(stats))`;

const feature = makeFeature();
export default feature;
