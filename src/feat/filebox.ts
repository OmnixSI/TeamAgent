// The file box: files too big for a chat message or for the 25 MB path into and out of the cloud computer.
// Bytes sit in R2 as numbered parts written through the transfer routes (so they count against the
// transfer cap); this file keeps the bookkeeping (table boxfile, referred to as "x12"), hands out links,
// serves downloads with a proper file name and Range support, and runs the upload page people use.
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import type { Feature, Ctx } from "./types.ts";
import { CAP, PART, issue, grant, row, remove, stored, partKey, newToken } from "./transfer.ts";
import { R2_STORAGE_STOP } from "../budget.ts";
import { sh } from "../skills/types.ts";
import { BJ, clip, fmtFull } from "../util.ts";

export type BoxFile = { ref: string; name: string; size: number; mime: string; ts: number; expires: number; by: string };

const MB = 1024 * 1024, GB = 1024 * MB, HOUR = 3600000, DAY = 24 * HOUR;
export const LIMITS = {
  file: 2 * GB,           // one file
  total: 3 * GB,          // the whole box, every conversation; R2 stops everything at 8 GB
  dropMs: DAY,            // an upload page stays open this long
  dropFiles: 10, dropFilesMax: 50,
  linkHours: 72, linkHoursMax: 720,
  putTtl: 3 * 3600,       // seconds a cloud-computer upload command stays valid
  getTtl: 2 * 3600,       // seconds a cloud-computer download command stays valid
  orphanMs: 26 * HOUR,    // uploaded bytes nobody registered are dropped after this
};
const DEFAULT_URL = "https://teamagent.inkboard-server.workers.dev";
const base = (hub: Hub) => String(hub.env.PUBLIC_URL || DEFAULT_URL).replace(/\/+$/, "");
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];

// ---------- names, types, sizes ----------

/** "x12" → 12, anything else → 0. */
export function parseRef(ref: unknown): number {
  const m = /^\s*\[?x(\d{1,9})\]?\s*$/i.exec(String(ref ?? ""));
  return m ? Number(m[1]) : 0;
}

/** A display name safe to store and show: the last path segment, no control characters, at most 120 characters. */
export function cleanName(raw: unknown, fallback = "file") {
  const s = String(raw ?? "").replace(/[\x00-\x1f\x7f]/g, "").split(/[\\/]/).pop()!.trim().replace(/^\.+/, "");
  return clip(s, 120).replace(/…$/, "") || fallback;
}

const TYPES: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo", flv: "video/x-flv", ts: "video/mp2t",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", amr: "audio/amr",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", heic: "image/heic", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", json: "application/json",
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xml: "application/xml", srt: "text/plain; charset=utf-8", vtt: "text/vtt",
  zip: "application/zip", "7z": "application/x-7z-compressed", rar: "application/vnd.rar", gz: "application/gzip", tar: "application/x-tar", zst: "application/zstd",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip", apk: "application/vnd.android.package-archive",
};
export function mimeOf(name: string, given = "") {
  const ext = (name.includes(".") ? name.split(".").pop()! : "").toLowerCase();
  if (TYPES[ext]) return TYPES[ext];
  return /^[\w.+-]{1,60}\/[\w.+-]{1,80}$/.test(given) ? given : "application/octet-stream";
}
/** Media, pictures and PDFs open in the browser (videos play on phones); everything else downloads. HTML and SVG never render on this origin. */
export const showsInline = (mime: string) => /^(video|audio)\//.test(mime) || /^image\/(png|jpeg|gif|webp)$/.test(mime) || mime === "application/pdf";

/** Content-Disposition with an ASCII fallback and the real name in RFC 5987 form. */
export function disposition(name: string, inline: boolean) {
  const ascii = name.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\%;]/g, "_").replace(/_+/g, "_") || "file";
  const ext = encodeURIComponent(name).replace(/['()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  return (inline ? "inline" : "attachment") + '; filename="' + ascii + "\"; filename*=UTF-8''" + ext;
}

export const human = (n: number) => n >= GB ? (n / GB).toFixed(2) + " GB" : n >= MB ? (n / MB).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

/** The bucket prefix for one conversation's files (a short hash, so chat ids do not appear in keys). */
export function prefixOf(conv: string) {
  let a = 2166136261, b = 5381;
  for (let i = 0; i < conv.length; i++) { const c = conv.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b, 33) ^ c; }
  return "box/" + (a >>> 0).toString(36) + (b >>> 0).toString(36) + "/";
}
const newKey = (conv: string) => prefixOf(conv) + newToken().slice(0, 24);
const keyName = (key: string) => key.slice(key.lastIndexOf("/") + 1);

// ---------- Range ----------

/** One byte range of a `size`-byte file: {start,end} inclusive, "bad" (answer 416), or null (send it all). */
export function parseRange(h: string | null, size: number): { start: number; end: number } | "bad" | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") { const n = Number(m[2]); return n === 0 || !size ? "bad" : { start: Math.max(0, size - n), end: size - 1 }; }
  const start = Number(m[1]), end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || start > end ? "bad" : { start, end };
}
/** Which stored parts (each `part` bytes except the last) cover bytes start..end, and where inside each. */
export function pieces(start: number, end: number, part = PART) {
  const out: { i: number; offset: number; length: number }[] = [];
  for (let i = Math.floor(start / part); i <= Math.floor(end / part); i++) {
    const from = Math.max(start, i * part), to = Math.min(end, (i + 1) * part - 1);
    out.push({ i, offset: from - i * part, length: to - from + 1 });
  }
  return out;
}

// ---------- room ----------

type Drop = {
  conv: string; by: string; sender: string; note: string; exp: number; days: number; maxFiles: number; maxBytes: number;
  files: { name: string; size: number; mime: string; key: string; put: string; ref?: string; bad?: string }[];
};
const dropKey = (t: string) => "box:drop:" + t;
function readDrop(hub: Hub, t: string): Drop | null {
  if (!/^[0-9a-f]{32}$/.test(t)) return null;
  try { return JSON.parse(hub.get(dropKey(t)) || "null"); } catch { return null; }
}
const writeDrop = (hub: Hub, t: string, d: Drop) => hub.set(dropKey(t), JSON.stringify(d));
function drops(hub: Hub): [string, Drop][] {
  const out: [string, Drop][] = [];
  for (const r of rows(hub, "SELECT k, v FROM kv WHERE k LIKE 'box:drop:%'")) { try { out.push([String(r.k).slice(9), JSON.parse(String(r.v))]); } catch {} }
  return out;
}
const xferSize = (hub: Hub, key: string) => row(hub, key)?.size || 0;

/** Bytes promised to upload pages that have not arrived yet. */
function reserved(hub: Hub, now = Date.now()) {
  let n = 0;
  for (const [, d] of drops(hub)) if (d.exp > now) for (const f of d.files) if (!f.ref && !f.bad) n += Math.max(0, f.size - xferSize(hub, f.key));
  return n;
}
export const boxBytes = (hub: Hub) => Number(rows(hub, "SELECT COALESCE(SUM(size),0) n FROM xfer WHERE substr(key,1,4)='box/'")[0].n);

/** How many more bytes the box can take: its own total, the transfer cap shared with caches and workspaces, and R2 as a whole. */
export function roomFrom(s: { box: number; xfer: number; store: number; reserved: number }, total = LIMITS.total, cap = CAP, r2 = R2_STORAGE_STOP) {
  return Math.max(0, Math.min(total - s.box, cap - s.xfer, r2 - s.xfer - s.store) - s.reserved);
}
export function room(hub: Hub) {
  return roomFrom({ box: boxBytes(hub), xfer: stored(hub), store: Number(hub.store?.r2Bytes?.() || 0), reserved: reserved(hub) });
}

// ---------- the box ----------

const days = (hub: Hub, conv: string, d?: number) => {
  const n = Number(d ?? hub.edit?.cfg?.(conv, "box_days") ?? 7);
  return Math.min(30, Math.max(1, Number.isFinite(n) ? Math.round(n) : 7));
};
const fileOf = (r: any): BoxFile & { key: string; conv: string; note: string } => ({
  ref: "x" + r.id, name: String(r.name), size: Number(r.size), mime: String(r.mime), ts: Number(r.ts), expires: Number(r.expires),
  by: String(r.by || ""), key: String(r.key), conv: String(r.conv), note: String(r.note || ""),
});
function find(hub: Hub, conv: string, ref: string, now = Date.now()) {
  const id = parseRef(ref);
  const r = id ? rows(hub, 'SELECT id, conv, name, size, mime, key, ts, expires, "by" AS "by", note FROM boxfile WHERE id=? AND conv=?', id, conv)[0] : null;
  return r && Number(r.expires) > now ? fileOf(r) : null;
}

/** A box file this conversation may use, or null. */
export function boxFile(hub: Hub, conv: string, ref: string): BoxFile | null {
  const f = find(hub, conv, ref);
  return f ? { ref: f.ref, name: f.name, size: f.size, mime: f.mime, ts: f.ts, expires: f.expires, by: f.by } : null;
}

/** Every part but the last must be exactly PART bytes, or byte ranges would land in the wrong place. */
async function layoutOk(hub: Hub, key: string, size: number, parts: number) {
  if (parts < 1 || size > parts * PART) return false;
  if (parts === 1) return true;
  if (size <= (parts - 1) * PART) return false;
  const b = hub.env.FILES as any;
  if (!b?.head) return true;
  hub.plan.add("r2_reads", parts - 1);
  for (let i = 0; i < parts - 1; i++) { const h = await b.head(partKey(key, i)).catch(() => null); if (!h || h.size !== PART) return false; }
  return true;
}

/** Registers a finished upload; returns the row id, or an error in plain Chinese. The bytes are dropped when refused. */
async function register(hub: Hub, conv: string, key: string, name: string, mime: string, by: string, note: string, d: number, expect?: number): Promise<number | string> {
  const have = rows(hub, "SELECT id FROM boxfile WHERE key=?", key)[0];
  if (have) return Number(have.id);
  const r = row(hub, key);
  if (!r || !r.done) return "文件还没传完";
  let why = "";
  if (expect !== undefined && r.size !== expect) why = "收到的大小和文件不一样，可能没传完整";
  else if (r.size > LIMITS.file) why = "单个文件最大 " + human(LIMITS.file);
  else if (boxBytes(hub) > LIMITS.total) why = "文件箱满了（总共 " + human(LIMITS.total) + "），先删掉一些";
  else if (!(await layoutOk(hub, key, r.size, r.parts))) why = "文件分段不对，没法存";
  if (why) { await remove(hub, key); return why; }
  const now = Date.now();
  return Number(rows(hub, 'INSERT INTO boxfile(conv, name, size, mime, key, ts, expires, "by", note) VALUES(?,?,?,?,?,?,?,?,?) RETURNING id',
    conv, name, r.size, mime, key, now, now + d * DAY, by, note)[0].id);
}

/** A link people can open in a browser to download a box file, valid for `hours`. */
export function boxLink(hub: Hub, conv: string, ref: string, hours = LIMITS.linkHours): string | null {
  const f = find(hub, conv, ref);
  if (!f) return null;
  const h = Math.min(LIMITS.linkHoursMax, Math.max(1, Number(hours) || LIMITS.linkHours));
  const ttl = Math.max(60, Math.min(h * 3600, Math.ceil((f.expires - Date.now()) / 1000)));
  const t = issue(hub, { mode: "get", prefix: prefixOf(conv), name: keyName(f.key) }, ttl);
  return base(hub) + "/x/box/" + t + "/" + encodeURIComponent(f.name);
}

/** A bash command that downloads a box file to `dest` inside the cloud computer through a short-lived link. */
export function boxDownloadCommand(hub: Hub, conv: string, ref: string, dest: string): string | null {
  const f = find(hub, conv, ref);
  if (!f || !dest) return null;
  const t = issue(hub, { mode: "get", prefix: prefixOf(conv), name: keyName(f.key) }, LIMITS.getTtl);
  return downloadCommand(base(hub) + "/x/get/" + t + "/" + keyName(f.key), dest, f.size, f.ref + "（" + f.name + "）");
}
export function downloadCommand(url: string, dest: string, size: number, label: string) {
  const fail = sh("从文件箱取 " + label + " 失败：链接过期、网络断了或者没下完整");
  return "( d=" + sh(dest) + "; mkdir -p \"$(dirname -- \"$d\")\" && " +
    "curl -fsS --retry 3 --retry-delay 2 --connect-timeout 20 -o \"$d.part\" " + sh(url) + " && " +
    "[ \"$(wc -c < \"$d.part\" | tr -d ' ')\" = " + sh(String(size)) + " ] && mv -f \"$d.part\" \"$d\" " +
    "|| { rm -f \"$d.part\"; echo " + fail + " >&2; exit 1; } )";
}

/**
 * The upload loop the cloud computer runs: one part at a time with dd (so at most one part sits on the
 * small disk), PUT with curl -T (curl sends Content-Length), the last part flagged, each part retried.
 * A 409 after a failed try means the earlier try did land and only its answer was lost.
 */
export function uploadCommand(path: string, url: string, limit: number, block = 1048576, count = PART / 1048576) {
  const P = block * count, say = (s: string) => "echo " + sh(s);
  return [
    "( f=" + sh(path) + "; u=" + sh(url) + "; P=" + P,
    "[ -f \"$f\" ] || { " + say("要放进文件箱的文件不存在：") + " \"$f\" >&2; exit 1; }",
    "size=$(wc -c < \"$f\" | tr -d ' ')",
    "[ \"$size\" -le " + limit + " ] || { " + say("文件太大放不进文件箱：最多还能放 " + human(limit)) + " >&2; exit 1; }",
    "n=$(( size == 0 ? 1 : (size + P - 1) / P )); tmp=$(mktemp -d); trap 'rm -rf \"$tmp\"' EXIT; i=0",
    "while [ $i -lt $n ]; do",
    "  last=0; [ $i -eq $((n - 1)) ] && last=1",
    "  dd if=\"$f\" of=\"$tmp/p\" bs=" + block + " skip=$((i * " + count + ")) count=" + count + " 2>/dev/null || { " + say("读文件失败") + " >&2; exit 1; }",
    "  t=0",
    "  while :; do",
    "    code=$(curl -sS -H 'Expect:' -o \"$tmp/r\" -w '%{http_code}' -T \"$tmp/p\" \"$u?part=$i&last=$last\") || code=000",
    "    case $code in 2??) break ;; esac",
    "    [ \"$code\" = 409 ] && [ $t -gt 0 ] && break",
    "    t=$((t + 1))",
    "    case $code in 408|429) ;; 4??|507) t=5 ;; esac",
    "    if [ $t -ge 5 ]; then echo \"传进文件箱失败：第 $((i + 1))/$n 段，HTTP $code $(head -c 200 \"$tmp/r\" 2>/dev/null)\" >&2; exit 1; fi",
    "    sleep $t",
    "  done",
    "  i=$((i + 1))",
    "done",
    "echo \"已传进文件箱：$size 字节，$n 段\" )",
  ].join("\n");
}

/** A bash command that uploads `path` from the cloud computer into the box; call `claim()` after it ran to register the file and get its reference and a download link people can open. */
export function boxUpload(hub: Hub, conv: string, path: string, name: string, days_?: number): { command: string; claim(): Promise<{ ref: string; name: string; size: number; link: string } | null> } {
  const limit = Math.min(LIMITS.file, room(hub));
  if (!hub.env.FILES || limit <= 0) return { command: "echo " + sh(limit <= 0 ? "文件箱满了，放不下新文件" : "存储没接好，文件箱用不了") + " >&2; false", claim: async () => null };
  const key = newKey(conv), shown = cleanName(name || path), d = days(hub, conv, days_);
  const t = issue(hub, { mode: "put", prefix: prefixOf(conv), name: keyName(key) }, LIMITS.putTtl);
  return {
    command: uploadCommand(path, base(hub) + "/x/put/" + t + "/" + keyName(key), limit),
    async claim() {
      const id = await register(hub, conv, key, shown, mimeOf(shown), "", "", d);
      if (typeof id === "string") { console.log("filebox: claim refused", id); return null; }
      const f = find(hub, conv, "x" + id)!;
      return { ref: f.ref, name: f.name, size: f.size, link: boxLink(hub, conv, f.ref) || "" };
    },
  };
}

/** Puts bytes the Worker already holds into the box (a result too big for a chat message). */
export async function boxPut(hub: Hub, conv: string, name: string, bytes: Uint8Array, days_?: number): Promise<{ ref: string; link: string } | null> {
  const b = hub.env.FILES, parts = Math.max(1, Math.ceil(bytes.length / PART));
  if (!b || bytes.length > LIMITS.file || bytes.length > room(hub) || !hub.plan.take("r2_writes", parts)) return null;
  const key = newKey(conv), shown = cleanName(name);
  hub.sql.exec("INSERT INTO xfer(key, size, parts, done, at) VALUES(?, 0, 0, 0, ?)", key, Date.now());
  try {
    for (let i = 0; i < parts; i++) await b.put(partKey(key, i), bytes.subarray(i * PART, Math.min(bytes.length, (i + 1) * PART)));
  } catch (e: any) {
    console.log("filebox: put failed", e?.message);
    hub.sql.exec("UPDATE xfer SET parts=? WHERE key=?", parts, key);
    await remove(hub, key);
    return null;
  }
  hub.sql.exec("UPDATE xfer SET size=?, parts=?, done=1, at=? WHERE key=?", bytes.length, parts, Date.now(), key);
  const id = await register(hub, conv, key, shown, mimeOf(shown), "Bot", "", days(hub, conv, days_));
  if (typeof id === "string") return null;
  return { ref: "x" + id, link: boxLink(hub, conv, "x" + id) || "" };
}

async function drop(hub: Hub, ref: string) {
  const r = rows(hub, "SELECT key FROM boxfile WHERE id=?", parseRef(ref))[0];
  if (!r) return;
  await remove(hub, String(r.key));
  hub.sql.exec("DELETE FROM boxfile WHERE id=?", parseRef(ref));
}

/** Expired files, expired upload pages, and uploaded bytes nobody registered, at most once an hour. */
export async function sweep(hub: Hub, now = Date.now()) {
  if (now - Number(hub.get("box:swept") || 0) < HOUR) return;
  hub.set("box:swept", String(now));
  for (const r of rows(hub, "SELECT id FROM boxfile WHERE expires<=?", now)) await drop(hub, "x" + r.id);
  const live = new Set<string>();
  for (const [t, d] of drops(hub)) {
    if (d.exp + HOUR < now) hub.sql.exec("DELETE FROM kv WHERE k=?", dropKey(t));
    else for (const f of d.files) live.add(f.key);
  }
  for (const r of rows(hub, "SELECT key FROM xfer WHERE substr(key,1,4)='box/' AND at<? AND key NOT IN (SELECT key FROM boxfile)", now - LIMITS.orphanMs))
    if (!live.has(String(r.key))) await remove(hub, String(r.key));
}

// ---------- upload page ----------

/** Creates an upload page for this conversation; null when the box has no room. */
export function newDrop(hub: Hub, conv: string, o: { by?: string; sender?: string; note?: string; files?: number; mb?: number; days?: number } = {}, now = Date.now()) {
  const left = Math.min(room(hub), o.mb ? Math.round(o.mb * MB) : Infinity);
  if (left < MB) return null;
  const t = newToken(), d: Drop = {
    conv, by: clip(o.by || "", 20), sender: o.sender || "", note: clip(o.note || "", 200), exp: now + LIMITS.dropMs, days: days(hub, conv, o.days),
    maxFiles: Math.min(LIMITS.dropFilesMax, Math.max(1, Math.round(o.files || LIMITS.dropFiles))), maxBytes: left, files: [],
  };
  writeDrop(hub, t, d);
  return { token: t, url: base(hub) + "/x/drop/" + t, ...d };
}

/** The chunking and retry loop of the upload page, as plain browser JavaScript (also evaluated by the tests). */
export const UPLOAD_CORE = String.raw`
async function sendParts(o) {
  var n = Math.max(1, Math.ceil(o.size / o.part)), i = o.from || 0, tries = 0;
  while (i < n) {
    var start = i * o.part, end = Math.min(o.size, start + o.part);
    var r = await o.put(i, i === n - 1, start, end).catch(function () { return { status: 0 }; });
    if (r.status >= 200 && r.status < 300) { i++; tries = 0; if (o.progress) o.progress(end); continue; }
    if (r.status >= 400 && r.status < 500 && r.status !== 408 && r.status !== 409 && r.status !== 429 || r.status === 503 || r.status === 507)
      throw new Error(r.error || ("服务器拒绝了这个文件（" + r.status + "）"));
    if (++tries > o.tries) throw new Error("第 " + (i + 1) + "/" + n + " 段试了 " + o.tries + " 次都没传上去，网络可能断了，点重试接着传");
    await o.sleep(Math.min(20000, 1000 * Math.pow(2, tries - 1)));
    var s = await o.status().catch(function () { return null; });
    if (s && s.done && s.size === o.size) return true;
    if (s && !s.done && typeof s.parts === "number" && s.parts >= 0 && s.parts <= n) i = s.parts;
    else if (s && s.done) i = 0;
    if (o.progress) o.progress(Math.min(o.size, i * o.part));
  }
  return true;
}
function viaFetch(fetch, url, file) {
  return function (i, last, start, end) {
    return fetch(url + "?part=" + i + "&last=" + (last ? 1 : 0), { method: "PUT", body: file.slice(start, end) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, error: j && j.error }; }); });
  };
}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" } as Record<string, string>)[c]);
const secure = (h: Record<string, string>) => new Headers({
  "X-Robots-Tag": "noindex, nofollow", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store", ...h,
});
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: secure({ "Content-Type": "application/json; charset=utf-8" }) });
const page = (status: number, title: string, body: string, script = "") => new Response(
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>
*{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#222;font:16px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 6px}.sub{color:#777;margin:0 0 16px;font-size:14px}
.note{background:#fff;border-radius:10px;padding:10px 12px;margin:0 0 14px;font-size:15px}
label.n{display:block;font-size:14px;color:#666;margin:0 0 4px}input[type=text]{width:100%;font:inherit;padding:10px 12px;border:1px solid #ddd;border-radius:10px;margin:0 0 14px;background:#fff}
#zone{display:block;border:2px dashed #bbb;border-radius:14px;padding:34px 12px;text-align:center;background:#fff;color:#555;cursor:pointer}
#zone.on{border-color:#2a7;background:#effaf3}#zone b{display:block;font-size:18px;color:#222;margin-bottom:4px}
ul{list-style:none;padding:0;margin:16px 0}li{background:#fff;border-radius:10px;padding:10px 12px;margin:0 0 8px}
li .t{display:flex;justify-content:space-between;gap:8px;font-size:15px}li .t span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
li .s{font-size:13px;color:#888}.bar{height:6px;background:#eee;border-radius:3px;overflow:hidden;margin:6px 0 2px}.bar i{display:block;height:100%;width:0;background:#2a7}
li.err .s{color:#c33}li.ok .s{color:#2a7}button{font:inherit;padding:10px 18px;border:0;border-radius:10px;background:#222;color:#fff;margin-top:6px}
#msg{font-size:15px;margin-top:10px}#msg.ok{color:#2a7}#msg.err{color:#c33}
</style></head><body><main>${body}</main>${script}</body></html>`,
  { status, headers: secure({ "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }) });
const gone = () => page(404, "链接失效了", "<h1>链接失效了</h1><p class=sub>这个上传链接已经过期或者用完了，让 Bot 再给一个。</p>");

function dropPage(t: string, d: Drop) {
  const usedBytes = d.files.reduce((a, f) => a + (f.bad ? 0 : f.size), 0), usedFiles = d.files.filter(f => !f.bad).length;
  const cfg = { api: "/x/drop/" + t, part: PART, filesLeft: d.maxFiles - usedFiles, bytesLeft: d.maxBytes - usedBytes, fileMax: LIMITS.file, by: d.by };
  const body = `<h1>传文件给 Bot</h1><p class=sub>还能传 ${cfg.filesLeft} 个文件，一共 ${human(Math.max(0, cfg.bytesLeft))}，单个最大 ${human(LIMITS.file)}；链接 ${esc(fmtFull(d.exp, BJ))}（北京时间）前有效，文件保存 ${d.days} 天。</p>
${d.note ? `<p class=note>${esc(d.note)}</p>` : ""}<label class=n for=by>你的名字（可以不填）</label><input type=text id=by maxlength=20 value="${esc(d.by)}">
<label id=zone><b>点这里选文件</b>或者把文件拖进来，可以一次选多个<input type=file id=pick multiple hidden></label>
<ul id=list></ul><div id=msg></div><button id=again hidden>重试没传完的</button>`;
  const script = `<script>${UPLOAD_CORE}
var C=${JSON.stringify(cfg).replace(/</g, "\\u003c")},items=[],busy=false;
function $(id){return document.getElementById(id)}
function size(n){return n>=1073741824?(n/1073741824).toFixed(2)+" GB":n>=1048576?(n/1048576).toFixed(1)+" MB":Math.max(1,Math.round(n/1024))+" KB"}
function post(path,body){return fetch(C.api+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||("出错了（"+r.status+"）"));return j})})}
function xhrPut(url,file,it){return function(i,last,start,end){return new Promise(function(res){var x=new XMLHttpRequest();x.open("PUT",url+"?part="+i+"&last="+(last?1:0));
x.upload.onprogress=function(e){show(it,start+e.loaded)};x.onload=function(){var j={};try{j=JSON.parse(x.responseText)}catch(e){}res({status:x.status,error:j.error})};x.onerror=x.ontimeout=function(){res({status:0})};x.send(file.slice(start,end))})}}
function show(it,done){it.bar.style.width=(it.file.size?Math.min(100,done/it.file.size*100):100)+"%";it.s.textContent=size(done)+" / "+size(it.file.size)}
function add(files){for(var k=0;k<files.length;k++){var f=files[k],li=document.createElement("li");li.innerHTML='<div class=t><span></span><span></span></div><div class=bar><i></i></div><div class=s>等待上传</div>';
li.querySelector(".t span").textContent=f.name;li.querySelectorAll(".t span")[1].textContent=size(f.size);
var it={file:f,li:li,bar:li.querySelector("i"),s:li.querySelector(".s"),state:"wait"};
if(f.size>C.fileMax){it.state="bad";li.className="err";it.s.textContent="太大了，单个文件最多 "+size(C.fileMax)}
items.push(it);$("list").appendChild(li)}run()}
async function one(it){it.li.className="";it.s.textContent="准备中";
if(!it.f){var st=await post("/start",{name:it.file.name,size:it.file.size,type:it.file.type});it.f=st.f;it.url=st.put}
var s=await fetch(C.api+"/status?f="+it.f).then(function(r){return r.json()}).catch(function(){return null});
if(!(s&&s.done&&s.size===it.file.size))await sendParts({size:it.file.size,part:C.part,tries:6,from:s&&!s.done?s.parts||0:0,put:xhrPut(it.url,it.file,it),
status:function(){return fetch(C.api+"/status?f="+it.f).then(function(r){return r.json()})},sleep:function(ms){return new Promise(function(r){setTimeout(r,ms)})},progress:function(n){show(it,n)}});
it.state="up";show(it,it.file.size);it.s.textContent="传好了，正在交给 Bot"}
async function run(){if(busy)return;busy=true;$("again").hidden=true;var m=$("msg");m.className="";m.textContent="";
for(var k=0;k<items.length;k++){var it=items[k];if(it.state!=="wait"&&it.state!=="fail")continue;
try{await one(it)}catch(e){it.state="fail";it.li.className="err";it.s.textContent=e.message||"没传上去"}}
var up=items.filter(function(it){return it.state==="up"});
if(up.length){try{var r=await post("/done",{by:$("by").value.trim(),files:up.map(function(it){return it.f})});
up.forEach(function(it){var g=(r.files||[]).filter(function(x){return x.f===it.f})[0];it.state=g&&g.ref?"done":"fail";it.li.className=g&&g.ref?"ok":"err";it.s.textContent=g&&g.ref?"已交给 Bot，编号 "+g.ref:(g&&g.error)||"没登记上"});
m.className="ok";m.textContent=(r.files||[]).some(function(x){return x.ref})?"传好了，Bot 已经收到。可以回群里说一声要它做什么。":""}catch(e){m.className="err";m.textContent=e.message}}
if(items.some(function(it){return it.state==="fail"}))$("again").hidden=false;busy=false}
$("pick").onchange=function(){add(this.files);this.value=""};$("again").onclick=run;
var z=$("zone");["dragenter","dragover"].forEach(function(e){z.addEventListener(e,function(v){v.preventDefault();z.className="on"})});
["dragleave","drop"].forEach(function(e){z.addEventListener(e,function(v){v.preventDefault();z.className=""})});
z.addEventListener("drop",function(v){add(v.dataTransfer.files)});
</script>`;
  return page(200, "传文件给 Bot", body, script);
}

async function body(req: Request, max = 8192): Promise<any> {
  const text = await req.text().catch(() => "");
  if (text.length > max) return null;
  try { return JSON.parse(text || "{}"); } catch { return null; }
}

async function dropRoute(hub: Hub, req: Request, url: URL, t: string, op: string) {
  const d = readDrop(hub, t), now = Date.now();
  if (!d || d.exp <= now) return op ? json({ ok: false, error: "上传链接已经过期，让 Bot 再给一个" }, 404) : gone();
  if (!op) return req.method === "GET" || req.method === "HEAD" ? dropPage(t, d) : json({ ok: false, error: "method" }, 405);
  const site = req.headers.get("sec-fetch-site");
  if (req.method === "POST" && site && site !== "same-origin") return json({ ok: false, error: "只能从上传页面提交" }, 403);
  if (op === "status" && req.method === "GET") {
    const f = d.files[Number(url.searchParams.get("f"))];
    if (!f) return json({ ok: false, error: "没有这个文件" }, 404);
    const r = row(hub, f.key);
    return json({ ok: true, parts: r?.parts || 0, size: r?.size || 0, done: !!r?.done, ref: f.ref || null });
  }
  if (req.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const b = await body(req);
  if (!b) return json({ ok: false, error: "请求格式不对" }, 400);
  if (op === "start") {
    const name = cleanName(b.name), size = Number(b.size);
    if (!Number.isInteger(size) || size < 0) return json({ ok: false, error: "文件大小不对" }, 400);
    // The same file again (page reloaded): carry on with the upload already under way.
    const again = d.files.findIndex(f => !f.ref && !f.bad && f.name === name && f.size === size);
    if (again >= 0) return json({ ok: true, f: again, put: "/x/put/" + d.files[again].put + "/" + keyName(d.files[again].key), part: PART });
    const live = d.files.filter(f => !f.bad);
    if (live.length >= d.maxFiles) return json({ ok: false, error: "这个链接最多传 " + d.maxFiles + " 个文件，已经传满了" }, 403);
    if (size > LIMITS.file) return json({ ok: false, error: "单个文件最大 " + human(LIMITS.file) }, 413);
    const usedBytes = live.reduce((a, f) => a + f.size, 0);
    if (usedBytes + size > d.maxBytes) return json({ ok: false, error: "这个链接一共能传 " + human(d.maxBytes) + "，还剩 " + human(Math.max(0, d.maxBytes - usedBytes)) }, 413);
    if (size > room(hub)) return json({ ok: false, error: "文件箱放不下了，还剩 " + human(room(hub)) }, 507);
    const key = newKey(d.conv), ttl = Math.max(60, Math.ceil((d.exp - now) / 1000));
    const put = issue(hub, { mode: "put", prefix: prefixOf(d.conv), name: keyName(key) }, ttl);
    d.files.push({ name, size, mime: mimeOf(name, String(b.type || "")), key, put });
    writeDrop(hub, t, d);
    return json({ ok: true, f: d.files.length - 1, put: "/x/put/" + put + "/" + keyName(key), part: PART });
  }
  if (op === "done") {
    const want: number[] = Array.isArray(b.files) ? b.files.map(Number) : d.files.map((_f, i) => i);
    const by = clip(String(b.by || "").replace(/[\x00-\x1f]/g, "").trim(), 20) || d.by || "有人";
    const out: { f: number; ref?: string; name: string; error?: string }[] = [], fresh: string[] = [];
    for (const i of [...new Set(want)]) {
      const f = d.files[i];
      if (!f || f.bad) continue;
      if (f.ref) { out.push({ f: i, ref: f.ref, name: f.name }); continue; }
      if (!row(hub, f.key)?.done) { out.push({ f: i, name: f.name, error: "还没传完" }); continue; }   // may still finish
      const id = await register(hub, d.conv, f.key, f.name, f.mime, by, d.note, d.days, f.size);
      if (typeof id === "string") { f.bad = id; out.push({ f: i, name: f.name, error: id }); continue; }
      f.ref = "x" + id;
      out.push({ f: i, ref: f.ref, name: f.name });
      fresh.push(f.ref + " " + f.name + "（" + human(f.size) + "）");
    }
    writeDrop(hub, t, d);
    if (fresh.length) {
      // A normal chat line from the uploader, so the next turn sees the files the way it sees anything said in the chat.
      const text = "[通过上传页传了文件] " + fresh.join("、") + (d.note ? "。当初要这些文件是为了：" + d.note : "") + "。文件在文件箱里，用编号就能拿来处理。";
      hub.ingest({ id: "box:" + t.slice(0, 12) + ":" + fresh.map(x => x.split(" ")[0]).join(","), conv: d.conv, sender: d.sender || "", name: by, text, ts: Date.now(), mentioned: false });
    }
    return json({ ok: true, files: out });
  }
  return json({ ok: false, error: "没有这个接口" }, 404);
}

/** Downloads with a real file name, the right type, and byte ranges (phones play videos by asking for ranges). */
async function serveBox(hub: Hub, req: Request, t: string, now = Date.now()) {
  if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method" }, 405);
  const g = grant(hub, t);
  if (!g || g.mode !== "get" || !(g.exp > now) || !g.prefix.startsWith("box/") || !g.name) return gone();
  const r = rows(hub, 'SELECT id, conv, name, size, mime, key, ts, expires, "by" AS "by", note FROM boxfile WHERE key=?', g.prefix + g.name)[0];
  const f = r && Number(r.expires) > now ? fileOf(r) : null;
  const x = f && row(hub, f.key);
  if (!f || !x?.done) return page(404, "文件不在了", "<h1>文件不在了</h1><p class=sub>这个文件已经过期或者被删掉了。</p>");
  const inline = showsInline(f.mime) && new URL(req.url).searchParams.get("dl") !== "1";
  const etag = '"' + f.ref + "-" + f.size.toString(36) + '"';
  const head: Record<string, string> = {
    "Content-Type": f.mime, "Content-Disposition": disposition(f.name, inline), "Accept-Ranges": "bytes", ETag: etag,
    "Cache-Control": "private, max-age=3600",
  };
  // Anything that is not shown inline is never rendered as a page on this origin, even if a browser tried.
  if (!inline) head["Content-Security-Policy"] = "sandbox; default-src 'none'";
  const ifRange = req.headers.get("if-range");
  let range = parseRange(req.headers.get("range"), f.size);
  if (ifRange && ifRange !== etag) range = null;
  if (range === "bad") return new Response(null, { status: 416, headers: secure({ ...head, "Content-Range": "bytes */" + f.size }) });
  const start = range ? range.start : 0, end = range ? range.end : f.size - 1, len = f.size ? end - start + 1 : 0;
  if (range) head["Content-Range"] = "bytes " + start + "-" + end + "/" + f.size;
  head["Content-Length"] = String(len);
  const status = range ? 206 : 200;
  if (req.method === "HEAD" || !len) return new Response(null, { status, headers: secure(head) });
  const ps = pieces(start, end);
  if (!hub.plan.fits("r2_reads", ps.length)) return page(503, "这个月的额度用完了", "<h1>这个月的额度用完了</h1><p class=sub>存储的读取次数到了本月上限，下个周期恢复。</p>");
  hub.plan.add("r2_reads", ps.length);
  const F = (globalThis as any).FixedLengthStream;
  const { readable, writable } = (F ? new F(len) : new TransformStream()) as TransformStream;
  const pump = (async () => {
    for (const p of ps) {
      const o = await (hub.env.FILES as any).get(partKey(f.key, p.i), { range: { offset: p.offset, length: p.length } });
      if (!o) throw new Error("missing part " + p.i);
      await o.body.pipeTo(writable, { preventClose: true });
    }
    await writable.close();
  })().catch(e => writable.abort(e).catch(() => {}));
  (hub as any).ctx?.waitUntil?.(pump);
  return new Response(readable, { status, headers: secure(head) });
}

// ---------- tool ----------

function makeTool(ctx: Ctx): Tool {
  const { hub, conv } = ctx, who = ctx.askers.map(a => a.name).filter(Boolean).join("、");
  const when = (ts: number) => fmtFull(ts, BJ) + " 北京时间";
  const mine = (table: "blob" | "img", id: number) => {
    const r = rows(hub, `SELECT conv FROM ${table} WHERE id=?`, id)[0];
    return r && (String(r.conv) === conv || (!!hub.shadow(conv) && String(r.conv) === hub.shadow(conv)));
  };
  return {
    name: "filebox", slow: true,
    description: "文件箱：放聊天里发不了的大文件（单个最大 2 GB，默认保存 7 天、群里可以调，到期自动删），文件编号是 x 加数字，如 x12。" +
      "op=upload_link：有人要给你大文件时用——录音、视频、大的 PDF、压缩包、一次好多文件，QQ 传不了或者传了会被压缩，就给他上传页链接，他用手机或电脑浏览器打开，选文件就能传，传完聊天里会出现一条“通过上传页传了文件 x12 …”的消息。可以给 note（一句话写清要这个文件做什么，会显示在上传页上，传完也会带回来），max_files（最多几个文件，默认 10）。返回 url，原样发给他，24 小时内有效。" +
      "op=list：列出这个对话文件箱里的文件（编号、名字、大小、谁传的、什么时候、什么时候到期）。" +
      "op=link：给 file 生成一个浏览器能直接打开或下载的链接（视频和音频在手机上能直接播），默认 72 小时有效，可给 hours（1 到 720，不会超过文件到期时间）。file 可以是 x12，也可以是你手上的 f12、g12、聊天里的文件链接——这些会先放进文件箱再给链接。结果太大发不进聊天、或者有人想要链接而不是文件时用。" +
      "op=delete：删掉 file（x12）。" +
      "x 开头的编号可以直接放进 skill 和 computer 的 files 里，云电脑会从文件箱取（不受 25 MB 限制）。",
    parameters: {
      type: "object", required: ["op"], additionalProperties: false,
      properties: {
        op: { type: "string", enum: ["upload_link", "list", "link", "delete"] },
        file: { type: "string", description: "link、delete 用：x12；link 还可以是 f12、g12 或文件链接" },
        note: { type: "string", description: "upload_link 用：要这些文件做什么，一句话" },
        max_files: { type: "integer", description: "upload_link 用：最多传几个文件，默认 10，最多 50" },
        hours: { type: "integer", description: "link 用：链接有效几小时，默认 72" },
      },
    },
    run: async a => {
      const op = String(a.op || "");
      if (op === "upload_link") {
        const d = newDrop(hub, conv, { by: ctx.askers[0]?.name || "", sender: ctx.askers[0]?.id || "", note: String(a.note || ""), files: Number(a.max_files) || undefined });
        if (!d) return { ok: false, error: "文件箱满了，放不下新文件，先删掉一些（op=list 看看）" };
        return { ok: true, url: d.url, valid_until: when(d.exp), max_files: d.maxFiles, max_total: human(d.maxBytes), max_per_file: human(Math.min(LIMITS.file, d.maxBytes)), keep_days: d.days, note: "把 url 原样发给要传文件的人；传完聊天里会出现一条带 x 编号的消息" };
      }
      if (op === "list") {
        const list = rows(hub, 'SELECT id, conv, name, size, mime, key, ts, expires, "by" AS "by", note FROM boxfile WHERE conv=? AND expires>? ORDER BY id DESC LIMIT 60', conv, Date.now()).map(fileOf);
        return { ok: true, files: list.map(f => ({ ref: f.ref, name: f.name, size: human(f.size), by: f.by || "未知", at: when(f.ts), expires: when(f.expires), ...(f.note ? { note: f.note } : {}) })), left: human(room(hub)), ...(list.length ? {} : { note: "文件箱里没有这个对话的文件" }) };
      }
      const ref = String(a.file || "").trim();
      if (!ref) return { ok: false, error: "要给 file" };
      if (op === "delete") {
        const f = find(hub, conv, ref);
        if (!f) return { ok: false, error: "这个对话的文件箱里没有 " + clip(ref, 30) };
        await drop(hub, f.ref);
        return { ok: true, deleted: f.ref + " " + f.name };
      }
      if (op !== "link") return { ok: false, error: "op 只能是 upload_link、list、link、delete" };
      let f = find(hub, conv, ref), copied = false;
      if (!f) {
        if (parseRef(ref)) return { ok: false, error: "这个对话的文件箱里没有 " + clip(ref, 30) + "（可能已经过期）" };
        const k = /^([fg])(\d+)$/i.exec(ref);
        if (k && !mine(k[1].toLowerCase() === "f" ? "blob" : "img", Number(k[2]))) return { ok: false, error: "这个对话里没有 " + ref };
        const got = await ctx.host.fileRef(ref).catch(() => null) as { name: string; bytes: Uint8Array } | null;
        if (!got) return { ok: false, error: "拿不到 " + clip(ref, 60) + " 这个文件" };
        const put = await boxPut(hub, conv, got.name, got.bytes);
        if (!put) return { ok: false, error: "放不进文件箱（满了或者这个月的存储额度用完了）" };
        f = find(hub, conv, put.ref)!;
        if (who) hub.sql.exec('UPDATE boxfile SET "by"=? WHERE id=?', who.slice(0, 40), parseRef(f.ref));
        copied = true;
      }
      const link = boxLink(hub, conv, f.ref, Number(a.hours) || LIMITS.linkHours)!;
      const hours = Math.min(LIMITS.linkHoursMax, Math.max(1, Number(a.hours) || LIMITS.linkHours));
      return { ok: true, ref: f.ref, name: f.name, size: human(f.size), url: link, valid_until: when(Math.min(Date.now() + hours * HOUR, f.expires)), ...(copied ? { note: "已放进文件箱，编号 " + f.ref } : {}) };
    },
  };
}

const feature: Feature = {
  name: "filebox",
  schema: 'CREATE TABLE IF NOT EXISTS boxfile(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, name TEXT, size INTEGER, mime TEXT, key TEXT, ts INTEGER, expires INTEGER, "by" TEXT, note TEXT); CREATE INDEX IF NOT EXISTS boxfile_conv ON boxfile(conv, expires);',
  tunables: { box_days: { default: 7, min: 1, max: 30, what: "文件箱里的文件默认保存几天" } },
  tools: ctx => [makeTool(ctx)],
  tick: (hub, now) => sweep(hub, now),
  open(hub, req, url) {
    let m = /^\/x\/box\/([0-9a-f]{32})\/[^/]*$/.exec(url.pathname);
    if (m) return serveBox(hub, req, m[1]);
    m = /^\/x\/drop\/([0-9a-f]{32})(?:\/(start|status|done))?\/?$/.exec(url.pathname);
    if (m) return dropRoute(hub, req, url, m[1], m[2] || "");
    return url.pathname.startsWith("/x/box/") || url.pathname.startsWith("/x/drop/") ? gone() : null;
  },
  admin(hub, _req, url) {
    if (url.pathname !== "/admin/filebox") return null;
    const now = Date.now();
    const files = rows(hub, 'SELECT id, conv, name, size, mime, key, ts, expires, "by" AS "by", note FROM boxfile ORDER BY id DESC LIMIT 500').map(fileOf);
    let links = 0;
    for (const r of rows(hub, "SELECT v FROM kv WHERE k LIKE 'xfer:tok:%'")) { try { const g = JSON.parse(String(r.v)); if (g.exp > now && String(g.prefix).startsWith("box/")) links++; } catch {} }
    return json({
      totals: { files: files.length, box_bytes: boxBytes(hub), box_limit: LIMITS.total, file_limit: LIMITS.file, reserved: reserved(hub), room: room(hub), transfer_stored: stored(hub), transfer_cap: CAP },
      files: files.map(f => ({ ...f, expired: f.expires <= now })),
      upload_pages: drops(hub).filter(([, d]) => d.exp > now).map(([t, d]) => ({ token: t.slice(0, 6) + "…", conv: d.conv, by: d.by, note: d.note, exp: d.exp, files: d.files.length, max_files: d.maxFiles, bytes: d.files.reduce((a, f) => a + f.size, 0), max_bytes: d.maxBytes })),
      box_links_outstanding: links,
    });
  },
  about: [
    "大文件放在“文件箱”里，编号是 x 加数字（如 x12）：聊天里发不了的录音、视频、大 PDF、压缩包都放这里，单个最大 2 GB，整个文件箱最多 3 GB。",
    "要别人给我大文件时，我用 filebox 生成一个上传页链接，打开后选文件或拖进去就能传，大文件会分成 80 MB 一段上传，断了会自动重传那一段；传完聊天里会出现一条“通过上传页传了文件 x12 …”，我下一轮就能看到。上传链接 24 小时内有效，文件数和总大小在生成时就定好了。",
    "文件箱里的文件可以直接交给云电脑处理（不受 25 MB 的限制），处理出来的大结果也会放回文件箱，再给大家一个下载链接；链接在手机上点开，视频和音频能直接播放，默认 72 小时有效。",
    "文件默认保存 7 天（box_days，可改成 1 到 30 天），到期每小时检查一次自动删掉；文件只在传它的那个对话里能用，别的群或私聊拿不到。",
    "文件存在 Cloudflare R2 里，和云电脑的工具缓存共用一个存储上限，满了就不再收新文件，不会超出免费额度。",
  ],
};
export default feature;
