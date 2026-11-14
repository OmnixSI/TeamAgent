// Free speech and narrated videos. Speech comes from the Edge read-aloud service (what the Python
// package edge-tts talks to): `edgeSpeak` speaks to it directly from the Worker; `narrate` and `podcast`
// build videos and audio shows in the cloud computer with the Python package. Everything the model can
// say is kept in plain files so no text ever passes through shell quoting.
import type { Feature, Ctx } from "./types.ts";

/* ---------------------------------------------------------------- voices */

export const VOICES: Record<string, { id: string; label: string }> = {
  female: { id: "zh-CN-XiaoxiaoNeural", label: "晓晓（普通话女声，温柔自然）" },
  lively: { id: "zh-CN-XiaoyiNeural", label: "晓伊（普通话女声，活泼）" },
  male: { id: "zh-CN-YunxiNeural", label: "云希（普通话男声，阳光）" },
  calm: { id: "zh-CN-YunjianNeural", label: "云健（普通话男声，沉稳有力）" },
  news: { id: "zh-CN-YunyangNeural", label: "云扬（普通话男声，新闻播报）" },
  boy: { id: "zh-CN-YunxiaNeural", label: "云夏（普通话少年音）" },
  dongbei: { id: "zh-CN-liaoning-XiaobeiNeural", label: "晓北（东北话女声）" },
  shaanxi: { id: "zh-CN-shaanxi-XiaoniNeural", label: "晓妮（陕西话女声）" },
  cantonese: { id: "zh-HK-HiuGaaiNeural", label: "晓佳（粤语女声）" },
  cantonese2: { id: "zh-HK-HiuMaanNeural", label: "晓曼（粤语女声）" },
  cantonese_male: { id: "zh-HK-WanLungNeural", label: "云龙（粤语男声）" },
  taiwan: { id: "zh-TW-HsiaoChenNeural", label: "晓臻（台湾腔女声）" },
  taiwan2: { id: "zh-TW-HsiaoYuNeural", label: "晓雨（台湾腔女声）" },
  taiwan_male: { id: "zh-TW-YunJheNeural", label: "云哲（台湾腔男声）" },
};
export const DEFAULT_VOICE = "female";
/** A key from VOICES, or a full service voice name; anything else gets the default voice. */
export function pickVoice(key?: unknown): { key: string; id: string; label: string } {
  const k = String(key ?? "").trim();
  if (Object.prototype.hasOwnProperty.call(VOICES, k)) return { key: k, ...VOICES[k] };
  const byId = Object.entries(VOICES).find(([, v]) => v.id.toLowerCase() === k.toLowerCase());
  if (byId) return { key: byId[0], ...byId[1] };
  return { key: DEFAULT_VOICE, ...VOICES[DEFAULT_VOICE] };
}
const voiceList = () => Object.entries(VOICES).map(([k, v]) => k + "=" + v.label).join("；");

/* ------------------------------------------------- Edge protocol (pure) */

const BASE = "speech.platform.bing.com/consumer/speech/synthesize/readaloud";
const TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM = "143.0.3650.75";
const GEC_VERSION = "2-" + CHROMIUM;
const MAJOR = CHROMIUM.split(".")[0];
// The service refuses raw/riff PCM ("Unsupported Edge output format", close code 1007); it serves only MP3 and WebM-Opus.
export const OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const PCM_BYTES_PER_SECOND = 24000 * 2;

// SHA-256 with the service's modified constants, and the CS64 checksum, as in edge-tts 7.x (drm.py).
const M = 0xffffffff;
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
const STATE = [0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2];
const SCHEDULE = [0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6, 0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564];
const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const ADJ = 0xc9dc06a7;
const KB = K.map((v, i) => (i === 14 ? ADJ : v));
const S0_ADJ = 0x059c0b80, S1_ADJ = 0x000b92c0;
const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
const sg0 = (x: number) => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
const sg1 = (x: number) => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;
const add = (...v: number[]) => v.reduce((a, b) => a + b, 0) >>> 0;

function expand(w: number[], from: number) {
  for (let i = from; i < 64; i++) w[i] = add(sg1(w[i - 2]), w[i - 7], sg0(w[i - 15]), w[i - 16]);
}
function rounds(state: number[], w: number[], first: number): number[] {
  let [a, b, c, d, e, f, g, h] = state;
  const k = first === 14 ? KB : K;
  for (let i = first; i < 64; i++) {
    const t1 = add(h, rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25), (g ^ (e & (f ^ g))) >>> 0, k[i], w[i]);
    const t2 = add(rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22), ((a & b) | (c & (a | b))) >>> 0);
    h = g; g = f; f = e; e = add(d, t1); d = c; c = b; b = a; a = add(t1, t2);
  }
  return [a, b, c, d, e, f, g, h];
}
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
function shaInit(head: Uint8Array): number[] {
  const w: number[] = new Array(14).fill(0);
  w.push((head[0] << 16 | head[1] << 8 | head[2]) >>> 0, be32(head, 3));
  for (let i = 16; i < 30; i++) {
    let v = SCHEDULE[i - 16];
    if (i - 2 >= 14) v += i === 16 ? (sg1(w[i - 2]) ^ S1_ADJ) >>> 0 : sg1(w[i - 2]);
    if (i - 7 >= 14) v += w[i - 7];
    if (i - 15 >= 14) v += i === 29 ? (sg0(w[i - 15]) ^ S0_ADJ) >>> 0 : sg0(w[i - 15]);
    w.push(v >>> 0);
  }
  w.push(add(sg1(w[28]), w[23], sg0(w[15]), w[14], ADJ, -K[14]));
  expand(w, 31);
  const r = rounds(STATE, w, 14);
  return INITIAL.map((x, i) => add(x, r[i]));
}
function shaDigest(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const tail = new Uint8Array(data.length - 7 + 1 + pad + 8);
  tail.set(data.subarray(7));
  tail[data.length - 7] = 0x80;
  new DataView(tail.buffer).setBigUint64(tail.length - 8, BigInt(length) * 8n);
  let state = shaInit(data.subarray(0, 7));
  for (let o = 0; o < tail.length; o += 64) {
    const w: number[] = [];
    for (let i = 0; i < 16; i++) w.push(be32(tail, o + i * 4));
    expand(w, 16);
    const r = rounds(state, w, 0);
    state = state.map((x, i) => add(x, r[i]));
  }
  const out = new Uint8Array(32), dv = new DataView(out.buffer);
  state.forEach((x, i) => dv.setUint32(i * 4, x));
  return out;
}

const CS_COEF: [bigint, bigint][] = [
  [0xe82e91b1n, 0xb32700d0n], [0x44de24c6n, 0x88dff51dn], [0x3beb65bcn, 0x29514038n], [0xc89c5933n, 0xb328cbdfn], [0x8d1ec211n, 0xd405b4d5n],
  [0x314ef5d5n, 0x26e55f3cn], [0xe92491b1n, 0x607801c6n], [0xf0a5b9d5n, 0x82b2c1fbn], [0x06064cf3n, 0xfa51a3dan], [0xda79fa60n, 0x207cc464n],
  [0xbed20560n, 0x3c3c74f3n], [0x89f9c9f8n, 0xd2d14b61n], [0x35fa38c6n, 0xbb04a2c1n], [0xcb49e3c6n, 0xc5626167n],
];
const MB = 0xffffffffn;
const rol16 = (v: bigint) => { v &= MB; return ((v << 16n) | (v >> 16n)) & MB; };
function cs64(data: Uint8Array, digest: Uint8Array): [bigint, bigint] {
  const dv = new DataView(digest.buffer, digest.byteOffset);
  const keyA = BigInt(dv.getUint32(0, true)) | 1n, keyB = BigInt(dv.getUint32(4, true)) | 1n, FACTOR = 0x82893933n;
  const factors = [(keyA * FACTOR) & MB, (keyB * FACTOR) & MB];
  const terms = CS_COEF.map(([c], i) => (c * factors[i % 2]) & MB);
  const offsets = CS_COEF.map(([, o]) => o);
  const padded = new Uint8Array(1 + data.length + ((-(1 + data.length) % 4) + 4) % 4);
  padded.set(data, 1);
  const words: bigint[] = [];
  const pv = new DataView(padded.buffer);
  for (let i = 0; i < padded.length; i += 4) words.push(BigInt(pv.getUint32(i, true)));
  if (words.length % 2) words.push(0n);
  words.forEach((word, i) => {
    let term = word * (i % 2 === 0 ? keyA : keyB);
    let offset = rol16(word) * (i % 2 === 0 ? 0xef0569fbn : 0xc31713dbn);
    if (i === 0) { term += 0xf2f90b1an * factors[0]; offset += 0x0b1a0000n; }
    terms.push(term & MB); offsets.push(offset & MB);
  });
  let swapAcc = 0n, swapLast = 0n, state = 0n, acc = 0n;
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i], y = terms[i + 1];
    let t = rol16((offsets[i] + x) & MB);
    let q = (t * 0x76f50f34n) & MB;
    swapAcc += (rol16(q) * 0xc3efea97n + q) & MB;
    t = rol16((offsets[i + 1] + y) & MB);
    q = (t * 0x1881ce3cn) & MB;
    swapLast = (rol16(q) * 0x35bd1ec9n + q) & MB;
    swapAcc = (swapAcc + swapLast) & MB;
    state = (state * keyA + x) & MB;
    state = (rol16(state) * 0xcf98b111n) & MB;
    state = (rol16(state) * 0x87085b9fn) & MB;
    state = (rol16(state) * 0x12ceb96dn) & MB;
    state = (rol16(state) * 0x257e1d83n) & MB;
    acc += state;
    t = (state * keyB + y) & MB;
    t = (rol16(t) * 0xa27416f5n) & MB;
    t = (rol16(t) * 0xd38396ffn) & MB;
    state = (rol16((rol16(t) * 0x7c932b89n) & MB) * 0xbfa49f69n) & MB;
    acc = (acc + state) & MB;
  }
  return [swapLast ^ state, swapAcc ^ acc];
}
const hex = (b: Uint8Array) => [...b].map(x => x.toString(16).padStart(2, "0")).join("").toUpperCase();

/** The Sec-MS-GEC value for a Unix time in seconds: "<16 hex>-<64 hex>", constant inside each 5-minute window. */
export function secMsGec(unixSeconds: number): string {
  const win = BigInt(Math.floor(unixSeconds)) + 11644473600n;
  const ticks = (win - (win % 300n)) * 10000000n;
  const data = new TextEncoder().encode(ticks.toString() + TOKEN);
  const digest = shaDigest(data);
  const [a, b] = cs64(data, digest);
  const cs = new Uint8Array(8), dv = new DataView(cs.buffer);
  dv.setUint32(0, Number(a), true); dv.setUint32(4, Number(b), true);
  return hex(cs) + "-" + hex(digest);
}

const uuid = () => crypto.randomUUID().replace(/-/g, "");
export const WSS_HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
  "Accept-Language": "en-US,en;q=0.9",
};
export function edgeUrl(unixSeconds: number, connectionId = uuid()): string {
  return `https://${BASE}/edge/v1?TrustedClientToken=${TOKEN}&ConnectionId=${connectionId}&Sec-MS-GEC=${secMsGec(unixSeconds)}&Sec-MS-GEC-Version=${GEC_VERSION}`;
}
/** JavaScript-style date line the service expects in message headers. */
export function dateLine(d = new Date()): string {
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${day} ${mon} ${p(d.getUTCDate())} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}
export function configMessage(date: string, format = OUTPUT_FORMAT): string {
  return `X-Timestamp:${date}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${format}"}}}}\r\n`;
}
export const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
/** The service rejects most control characters (vertical tab from copied PDFs is the usual one). */
export const cleanForSpeech = (s: string) => s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ");
export function ssml(voiceId: string, escapedText: string, rate = "+0%", pitch = "+0Hz", volume = "+0%"): string {
  return "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
    `<voice name='${voiceId}'><prosody pitch='${pitch}' rate='${rate}' volume='${volume}'>${escapedText}</prosody></voice></speak>`;
}
export function ssmlMessage(requestId: string, date: string, ssmlText: string): string {
  // The trailing Z after the date is what Edge itself sends.
  return `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${date}Z\r\nPath:ssml\r\n\r\n${ssmlText}`;
}
/** "+10%", "-20%": accepts a number (percent) or a string already in that form. */
export const rateString = (v: unknown) => {
  if (typeof v === "string" && /^[+-]\d{1,3}%$/.test(v.trim())) return v.trim();
  const n = Math.round(Math.max(-50, Math.min(100, Number(v) || 0)));
  return (n >= 0 ? "+" : "") + n + "%";
};
export const pitchString = (v: unknown) => {
  if (typeof v === "string" && /^[+-]\d{1,3}Hz$/.test(v.trim())) return v.trim();
  const n = Math.round(Math.max(-50, Math.min(50, Number(v) || 0)));
  return (n >= 0 ? "+" : "") + n + "Hz";
};

/** Splits already-escaped text into pieces of at most `limit` UTF-8 bytes, at newlines or spaces when there are any,
 *  never inside a character or an &entity; (the service takes about 4 KB per request). */
export function splitEscaped(text: string, limit = 4096): string[] {
  const out: string[] = [];
  let rest = text;
  const bytes = (s: string) => new TextEncoder().encode(s).length;
  while (bytes(rest) > limit) {
    // longest prefix (in characters) that fits
    let lo = 0, hi = rest.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bytes(rest.slice(0, mid)) <= limit) lo = mid; else hi = mid - 1; }
    let cut = lo;
    const nl = rest.lastIndexOf("\n", cut - 1), sp = rest.lastIndexOf(" ", cut - 1);
    if (nl > 0) cut = nl; else if (sp > 0) cut = sp;
    const amp = rest.lastIndexOf("&", cut - 1);
    if (amp >= 0 && rest.indexOf(";", amp) >= cut) cut = amp;
    if (cut <= 0) cut = Math.max(1, lo);
    // keep surrogate pairs whole
    const c = rest.charCodeAt(cut - 1);
    if (c >= 0xd800 && c <= 0xdbff) cut--;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}

export type Frame = { type: "audio"; data: Uint8Array } | { type: "end" } | { type: "other"; path: string };
/** One WebSocket message from the service. Binary: 2-byte big-endian header length, header lines, then the payload. */
export function parseFrame(msg: string | ArrayBuffer | Uint8Array): Frame {
  if (typeof msg === "string") {
    const head = msg.split("\r\n\r\n")[0];
    const path = /(?:^|\r\n)Path:([^\r\n]*)/.exec(head)?.[1]?.trim() || "";
    return path === "turn.end" ? { type: "end" } : { type: "other", path };
  }
  const b = msg instanceof Uint8Array ? msg : new Uint8Array(msg);
  if (b.length < 2) throw new Error("语音服务发来的数据不完整");
  const hl = (b[0] << 8) | b[1];
  if (hl + 2 > b.length) throw new Error("语音服务发来的数据头长度不对");
  const head = new TextDecoder().decode(b.subarray(2, 2 + hl));
  const path = /(?:^|\r\n)Path:([^\r\n]*)/.exec(head)?.[1]?.trim() || "";
  if (path !== "audio") throw new Error("语音服务发来了没见过的数据：" + path);
  return { type: "audio", data: b.subarray(2 + hl) };
}

async function speakOnce(escaped: string, voiceId: string, rate: string, pitch: string, skew: { s: number }): Promise<Uint8Array> {
  const url = edgeUrl(Date.now() / 1000 + skew.s);
  const resp = await fetch(url, { headers: { Upgrade: "websocket", ...WSS_HEADERS, Cookie: "muid=" + uuid().toUpperCase().slice(0, 32) + ";" } });
  const ws = (resp as any).webSocket as WebSocket | undefined;
  if (!ws) {
    // A wrong clock shows up as 403 with the server's own time in the Date header.
    const server = Date.parse(resp.headers.get("Date") || "");
    if (resp.status === 403 && Number.isFinite(server) && Math.abs(server / 1000 - Date.now() / 1000 - skew.s) > 5) {
      skew.s = server / 1000 - Date.now() / 1000;
      return speakOnce(escaped, voiceId, rate, pitch, { s: skew.s });
    }
    throw new Error("语音服务连不上（" + resp.status + " " + (await resp.text().catch(() => "")).slice(0, 120) + "）");
  }
  (ws as any).accept();
  return new Promise<Uint8Array>((resolve, reject) => {
    const parts: Uint8Array[] = [];
    let done = false;
    const finish = (err?: Error) => {
      if (done) return; done = true; clearTimeout(timer);
      try { ws.close(1000); } catch {}
      if (err) return reject(err);
      const size = parts.reduce((n, p) => n + p.length, 0), pcm = new Uint8Array(size);
      let at = 0; for (const p of parts) { pcm.set(p, at); at += p.length; }
      size ? resolve(pcm) : reject(new Error("语音服务没有返回声音"));
    };
    const timer = setTimeout(() => finish(new Error("语音服务超时")), 40000);
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        const f = parseFrame(ev.data as any);
        if (f.type === "audio") { if (f.data.length) parts.push(f.data.slice()); }
        else if (f.type === "end") finish();
      } catch (e: any) { finish(e); }
    });
    ws.addEventListener("error", () => finish(new Error("语音服务连接出错")));
    ws.addEventListener("close", () => finish());
    ws.send(configMessage(dateLine()));
    ws.send(ssmlMessage(uuid(), dateLine(), ssml(voiceId, escaped, rate, pitch)));
  });
}

/** What the service sends back, as MP3 (24 kHz mono, 48 kbit/s). Several requests are joined when the text is long. */
export async function edgeSynthesize(text: string, voice: string, opts: { rate?: string; pitch?: string } = {}): Promise<Uint8Array> {
  const v = pickVoice(voice), rate = rateString(opts.rate ?? 0), pitch = pitchString(opts.pitch ?? 0);
  const pieces = splitEscaped(escapeXml(cleanForSpeech(String(text ?? ""))));
  if (!pieces.length) throw new Error("没有要念的字");
  const skew = { s: 0 }, chunks: Uint8Array[] = [];
  for (const p of pieces) chunks.push(await speakOnce(p, v.id, rate, pitch, skew));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0; for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
/** Speaks `text` with a voice from VOICES (unknown keys give the default). Returns 24 kHz, 16-bit, mono, little-endian PCM:
 *  the service only sends MP3, which is decoded here. */
export async function edgeSpeak(text: string, voice: string, opts: { rate?: string; pitch?: string } = {}): Promise<{ pcm: Uint8Array; seconds: number }> {
  const { pcm, hz } = decodeMp3(await edgeSynthesize(text, voice, opts));
  if (hz !== 24000) throw new Error("语音服务返回了 " + hz + " Hz 的声音，不是预期的 24 kHz");
  const bytes = new Uint8Array(pcm.length * 2), dv = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) dv.setInt16(i * 2, pcm[i], true);
  return { pcm: bytes, seconds: Math.round((pcm.length / 24000) * 100) / 100 };
}
/** WAV container around the PCM (for tests and for handing the audio to other tools). */
export function pcmToWav(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length), dv = new DataView(out.buffer);
  const tag = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  tag(0, "RIFF"); dv.setUint32(4, 36 + pcm.length, true); tag(8, "WAVE"); tag(12, "fmt ");
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 24000, true);
  dv.setUint32(28, 48000, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); tag(36, "data"); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

/* ---------------------------------------------------------------- MP3 decoder */
// The service answers only in MP3 (raw/riff PCM is refused), and QQ voice needs PCM. This is a mono Layer III
// decoder (MPEG-1/2/2.5) ported from minimp3 (CC0, https://github.com/lieff/minimp3); the tables are copied from it.
// Stereo, Layer I/II and free-format streams are not needed here and are refused.
const SCF_LONG = Uint8Array.of(
  6,6,6,6,6,6,8,10,12,14,16,20,24,28,32,38,46,52,60,68,58,54,0,
  12,12,12,12,12,12,16,20,24,28,32,40,48,56,64,76,90,2,2,2,2,2,0,
  6,6,6,6,6,6,8,10,12,14,16,20,24,28,32,38,46,52,60,68,58,54,0,
  6,6,6,6,6,6,8,10,12,14,16,18,22,26,32,38,46,54,62,70,76,36,0,
  6,6,6,6,6,6,8,10,12,14,16,20,24,28,32,38,46,52,60,68,58,54,0,
  4,4,4,4,4,4,6,6,8,8,10,12,16,20,24,28,34,42,50,54,76,158,0,
  4,4,4,4,4,4,6,6,6,8,10,12,16,18,22,28,34,40,46,54,54,192,0,
  4,4,4,4,4,4,6,6,8,10,12,16,20,24,30,38,46,56,68,84,102,26,0,
);
const SCF_SHORT = Uint8Array.of(
  4,4,4,4,4,4,4,4,4,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,30,30,30,40,40,40,18,18,18,0,
  8,8,8,8,8,8,8,8,8,12,12,12,16,16,16,20,20,20,24,24,24,28,28,28,36,36,36,2,2,2,2,2,2,2,2,2,26,26,26,0,
  4,4,4,4,4,4,4,4,4,6,6,6,6,6,6,8,8,8,10,10,10,14,14,14,18,18,18,26,26,26,32,32,32,42,42,42,18,18,18,0,
  4,4,4,4,4,4,4,4,4,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,32,32,32,44,44,44,12,12,12,0,
  4,4,4,4,4,4,4,4,4,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,30,30,30,40,40,40,18,18,18,0,
  4,4,4,4,4,4,4,4,4,4,4,4,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,22,22,22,30,30,30,56,56,56,0,
  4,4,4,4,4,4,4,4,4,4,4,4,6,6,6,6,6,6,10,10,10,12,12,12,14,14,14,16,16,16,20,20,20,26,26,26,66,66,66,0,
  4,4,4,4,4,4,4,4,4,4,4,4,6,6,6,8,8,8,12,12,12,16,16,16,20,20,20,26,26,26,34,34,34,42,42,42,12,12,12,0,
);
const SCF_MIXED = Uint8Array.of(
  6,6,6,6,6,6,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,30,30,30,40,40,40,18,18,18,0,0,0,0,
  12,12,12,4,4,4,8,8,8,12,12,12,16,16,16,20,20,20,24,24,24,28,28,28,36,36,36,2,2,2,2,2,2,2,2,2,26,26,26,0,
  6,6,6,6,6,6,6,6,6,6,6,6,8,8,8,10,10,10,14,14,14,18,18,18,26,26,26,32,32,32,42,42,42,18,18,18,0,0,0,0,
  6,6,6,6,6,6,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,32,32,32,44,44,44,12,12,12,0,0,0,0,
  6,6,6,6,6,6,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,24,24,24,30,30,30,40,40,40,18,18,18,0,0,0,0,
  4,4,4,4,4,4,6,6,4,4,4,6,6,6,8,8,8,10,10,10,12,12,12,14,14,14,18,18,18,22,22,22,30,30,30,56,56,56,0,0,
  4,4,4,4,4,4,6,6,4,4,4,6,6,6,6,6,6,10,10,10,12,12,12,14,14,14,16,16,16,20,20,20,26,26,26,66,66,66,0,0,
  4,4,4,4,4,4,6,6,4,4,4,6,6,6,8,8,8,12,12,12,16,16,16,20,20,20,26,26,26,34,34,34,42,42,42,12,12,12,0,0,
);
const POW43 = Float64Array.of(
  0,-1,-2.519842,-4.326749,-6.349604,-8.549880,-10.902724,-13.390518,-16.000000,-18.720754,-21.544347,-24.463781,-27.473142,-30.567351,-33.741992,
  -36.993181,0,1,2.519842,4.326749,6.349604,8.549880,10.902724,13.390518,16.000000,18.720754,21.544347,24.463781,27.473142,30.567351,33.741992,
  36.993181,40.317474,43.711787,47.173345,50.699631,54.288352,57.937408,61.644865,65.408941,69.227979,73.100443,77.024898,81.000000,85.024491,
  89.097188,93.216975,97.382800,101.593667,105.848633,110.146801,114.487321,118.869381,123.292209,127.755065,132.257246,136.798076,141.376907,
  145.993119,150.646117,155.335327,160.060199,164.820202,169.614826,174.443577,179.305980,184.201575,189.129918,194.090580,199.083145,204.107210,
  209.162385,214.248292,219.364564,224.510845,229.686789,234.892058,240.126328,245.389280,250.680604,256.000000,261.347174,266.721841,272.123723,
  277.552547,283.008049,288.489971,293.998060,299.532071,305.091761,310.676898,316.287249,321.922592,327.582707,333.267377,338.976394,344.709550,
  350.466646,356.247482,362.051866,367.879608,373.730522,379.604427,385.501143,391.420496,397.362314,403.326427,409.312672,415.320884,421.350905,
  427.402579,433.475750,439.570269,445.685987,451.822757,457.980436,464.158883,470.357960,476.577530,482.817459,489.077615,495.357868,501.658090,
  507.978156,514.317941,520.677324,527.056184,533.454404,539.871867,546.308458,552.764065,559.238575,565.731879,572.243870,578.774440,585.323483,
  591.890898,598.476581,605.080431,611.702349,618.342238,625.000000,631.675540,638.368763,645.079578,
);
const TABS = Int16Array.of(
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,785,785,785,785,784,784,784,784,513,513,513,513,513,513,513,513,256,256,256,256,256,
  256,256,256,256,256,256,256,256,256,256,256,-255,1313,1298,1282,785,785,785,785,784,784,784,784,769,769,769,769,256,256,256,256,256,256,256,256,256,
  256,256,256,256,256,256,256,290,288,-255,1313,1298,1282,769,769,769,769,529,529,529,529,529,529,529,529,528,528,528,528,528,528,528,528,512,512,512,
  512,512,512,512,512,290,288,-253,-318,-351,-367,785,785,785,785,784,784,784,784,769,769,769,769,256,256,256,256,256,256,256,256,256,256,256,256,256,
  256,256,256,819,818,547,547,275,275,275,275,561,560,515,546,289,274,288,258,-254,-287,1329,1299,1314,1312,1057,1057,1042,1042,1026,1026,784,784,784,
  784,529,529,529,529,529,529,529,529,769,769,769,769,768,768,768,768,563,560,306,306,291,259,-252,-413,-477,-542,1298,-575,1041,1041,784,784,784,784,
  769,769,769,769,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,-383,-399,1107,1092,1106,1061,849,849,789,789,1104,1091,773,773,
  1076,1075,341,340,325,309,834,804,577,577,532,532,516,516,832,818,803,816,561,561,531,531,515,546,289,289,288,258,-252,-429,-493,-559,1057,1057,
  1042,1042,529,529,529,529,529,529,529,529,784,784,784,784,769,769,769,769,512,512,512,512,512,512,512,512,-382,1077,-415,1106,1061,1104,849,849,789,
  789,1091,1076,1029,1075,834,834,597,581,340,340,339,324,804,833,532,532,832,772,818,803,817,787,816,771,290,290,290,290,288,258,-253,-349,-414,-447,
  -463,1329,1299,-479,1314,1312,1057,1057,1042,1042,1026,1026,785,785,785,785,784,784,784,784,769,769,769,769,768,768,768,768,-319,851,821,-335,836,
  850,805,849,341,340,325,336,533,533,579,579,564,564,773,832,578,548,563,516,321,276,306,291,304,259,-251,-572,-733,-830,-863,-879,1041,1041,784,784,
  784,784,769,769,769,769,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,-511,-527,-543,1396,1351,1381,1366,1395,1335,1380,-559,1334,
  1138,1138,1063,1063,1350,1392,1031,1031,1062,1062,1364,1363,1120,1120,1333,1348,881,881,881,881,375,374,359,373,343,358,341,325,791,791,1123,1122,
  -703,1105,1045,-719,865,865,790,790,774,774,1104,1029,338,293,323,308,-799,-815,833,788,772,818,803,816,322,292,307,320,561,531,515,546,289,274,288,
  258,-251,-525,-605,-685,-765,-831,-846,1298,1057,1057,1312,1282,785,785,785,785,784,784,784,784,769,769,769,769,512,512,512,512,512,512,512,512,
  1399,1398,1383,1367,1382,1396,1351,-511,1381,1366,1139,1139,1079,1079,1124,1124,1364,1349,1363,1333,882,882,882,882,807,807,807,807,1094,1094,1136,
  1136,373,341,535,535,881,775,867,822,774,-591,324,338,-671,849,550,550,866,864,609,609,293,336,534,534,789,835,773,-751,834,804,308,307,833,788,832,
  772,562,562,547,547,305,275,560,515,290,290,-252,-397,-477,-557,-622,-653,-719,-735,-750,1329,1299,1314,1057,1057,1042,1042,1312,1282,1024,1024,785,
  785,785,785,784,784,784,784,769,769,769,769,-383,1127,1141,1111,1126,1140,1095,1110,869,869,883,883,1079,1109,882,882,375,374,807,868,838,881,791,
  -463,867,822,368,263,852,837,836,-543,610,610,550,550,352,336,534,534,865,774,851,821,850,805,593,533,579,564,773,832,578,578,548,548,577,577,307,
  276,306,291,516,560,259,259,-250,-2107,-2507,-2764,-2909,-2974,-3007,-3023,1041,1041,1040,1040,769,769,769,769,256,256,256,256,256,256,256,256,256,
  256,256,256,256,256,256,256,-767,-1052,-1213,-1277,-1358,-1405,-1469,-1535,-1550,-1582,-1614,-1647,-1662,-1694,-1726,-1759,-1774,-1807,-1822,-1854,
  -1886,1565,-1919,-1935,-1951,-1967,1731,1730,1580,1717,-1983,1729,1564,-1999,1548,-2015,-2031,1715,1595,-2047,1714,-2063,1610,-2079,1609,-2095,1323,
  1323,1457,1457,1307,1307,1712,1547,1641,1700,1699,1594,1685,1625,1442,1442,1322,1322,-780,-973,-910,1279,1278,1277,1262,1276,1261,1275,1215,1260,
  1229,-959,974,974,989,989,-943,735,478,478,495,463,506,414,-1039,1003,958,1017,927,942,987,957,431,476,1272,1167,1228,-1183,1256,-1199,895,895,941,
  941,1242,1227,1212,1135,1014,1014,490,489,503,487,910,1013,985,925,863,894,970,955,1012,847,-1343,831,755,755,984,909,428,366,754,559,-1391,752,486,
  457,924,997,698,698,983,893,740,740,908,877,739,739,667,667,953,938,497,287,271,271,683,606,590,712,726,574,302,302,738,736,481,286,526,725,605,711,
  636,724,696,651,589,681,666,710,364,467,573,695,466,466,301,465,379,379,709,604,665,679,316,316,634,633,436,436,464,269,424,394,452,332,438,363,347,
  408,393,448,331,422,362,407,392,421,346,406,391,376,375,359,1441,1306,-2367,1290,-2383,1337,-2399,-2415,1426,1321,-2431,1411,1336,-2447,-2463,-2479,
  1169,1169,1049,1049,1424,1289,1412,1352,1319,-2495,1154,1154,1064,1064,1153,1153,416,390,360,404,403,389,344,374,373,343,358,372,327,357,342,311,
  356,326,1395,1394,1137,1137,1047,1047,1365,1392,1287,1379,1334,1364,1349,1378,1318,1363,792,792,792,792,1152,1152,1032,1032,1121,1121,1046,1046,
  1120,1120,1030,1030,-2895,1106,1061,1104,849,849,789,789,1091,1076,1029,1090,1060,1075,833,833,309,324,532,532,832,772,818,803,561,561,531,560,515,
  546,289,274,288,258,-250,-1179,-1579,-1836,-1996,-2124,-2253,-2333,-2413,-2477,-2542,-2574,-2607,-2622,-2655,1314,1313,1298,1312,1282,785,785,785,
  785,1040,1040,1025,1025,768,768,768,768,-766,-798,-830,-862,-895,-911,-927,-943,-959,-975,-991,-1007,-1023,-1039,-1055,-1070,1724,1647,-1103,-1119,
  1631,1767,1662,1738,1708,1723,-1135,1780,1615,1779,1599,1677,1646,1778,1583,-1151,1777,1567,1737,1692,1765,1722,1707,1630,1751,1661,1764,1614,1736,
  1676,1763,1750,1645,1598,1721,1691,1762,1706,1582,1761,1566,-1167,1749,1629,767,766,751,765,494,494,735,764,719,749,734,763,447,447,748,718,477,506,
  431,491,446,476,461,505,415,430,475,445,504,399,460,489,414,503,383,474,429,459,502,502,746,752,488,398,501,473,413,472,486,271,480,270,-1439,-1455,
  1357,-1471,-1487,-1503,1341,1325,-1519,1489,1463,1403,1309,-1535,1372,1448,1418,1476,1356,1462,1387,-1551,1475,1340,1447,1402,1386,-1567,1068,1068,
  1474,1461,455,380,468,440,395,425,410,454,364,467,466,464,453,269,409,448,268,432,1371,1473,1432,1417,1308,1460,1355,1446,1459,1431,1083,1083,1401,
  1416,1458,1445,1067,1067,1370,1457,1051,1051,1291,1430,1385,1444,1354,1415,1400,1443,1082,1082,1173,1113,1186,1066,1185,1050,-1967,1158,1128,1172,
  1097,1171,1081,-1983,1157,1112,416,266,375,400,1170,1142,1127,1065,793,793,1169,1033,1156,1096,1141,1111,1155,1080,1126,1140,898,898,808,808,897,
  897,792,792,1095,1152,1032,1125,1110,1139,1079,1124,882,807,838,881,853,791,-2319,867,368,263,822,852,837,866,806,865,-2399,851,352,262,534,534,821,
  836,594,594,549,549,593,593,533,533,848,773,579,579,564,578,548,563,276,276,577,576,306,291,516,560,305,305,275,259,-251,-892,-2058,-2620,-2828,
  -2957,-3023,-3039,1041,1041,1040,1040,769,769,769,769,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,256,-511,-527,-543,-559,1530,-575,
  -591,1528,1527,1407,1526,1391,1023,1023,1023,1023,1525,1375,1268,1268,1103,1103,1087,1087,1039,1039,1523,-604,815,815,815,815,510,495,509,479,508,
  463,507,447,431,505,415,399,-734,-782,1262,-815,1259,1244,-831,1258,1228,-847,-863,1196,-879,1253,987,987,748,-767,493,493,462,477,414,414,686,669,
  478,446,461,445,474,429,487,458,412,471,1266,1264,1009,1009,799,799,-1019,-1276,-1452,-1581,-1677,-1757,-1821,-1886,-1933,-1997,1257,1257,1483,1468,
  1512,1422,1497,1406,1467,1496,1421,1510,1134,1134,1225,1225,1466,1451,1374,1405,1252,1252,1358,1480,1164,1164,1251,1251,1238,1238,1389,1465,-1407,
  1054,1101,-1423,1207,-1439,830,830,1248,1038,1237,1117,1223,1148,1236,1208,411,426,395,410,379,269,1193,1222,1132,1235,1221,1116,976,976,1192,1162,
  1177,1220,1131,1191,963,963,-1647,961,780,-1663,558,558,994,993,437,408,393,407,829,978,813,797,947,-1743,721,721,377,392,844,950,828,890,706,706,
  812,859,796,960,948,843,934,874,571,571,-1919,690,555,689,421,346,539,539,944,779,918,873,932,842,903,888,570,570,931,917,674,674,-2575,1562,-2591,
  1609,-2607,1654,1322,1322,1441,1441,1696,1546,1683,1593,1669,1624,1426,1426,1321,1321,1639,1680,1425,1425,1305,1305,1545,1668,1608,1623,1667,1592,
  1638,1666,1320,1320,1652,1607,1409,1409,1304,1304,1288,1288,1664,1637,1395,1395,1335,1335,1622,1636,1394,1394,1319,1319,1606,1621,1392,1392,1137,
  1137,1137,1137,345,390,360,375,404,373,1047,-2751,-2767,-2783,1062,1121,1046,-2799,1077,-2815,1106,1061,789,789,1105,1104,263,355,310,340,325,354,
  352,262,339,324,1091,1076,1029,1090,1060,1075,833,833,788,788,1088,1028,818,818,803,803,561,561,531,531,816,771,546,546,289,274,288,258,-253,-317,
  -381,-446,-478,-509,1279,1279,-811,-1179,-1451,-1756,-1900,-2028,-2189,-2253,-2333,-2414,-2445,-2511,-2526,1313,1298,-2559,1041,1041,1040,1040,1025,
  1025,1024,1024,1022,1007,1021,991,1020,975,1019,959,687,687,1018,1017,671,671,655,655,1016,1015,639,639,758,758,623,623,757,607,756,591,755,575,754,
  559,543,543,1009,783,-575,-621,-685,-749,496,-590,750,749,734,748,974,989,1003,958,988,973,1002,942,987,957,972,1001,926,986,941,971,956,1000,910,
  985,925,999,894,970,-1071,-1087,-1102,1390,-1135,1436,1509,1451,1374,-1151,1405,1358,1480,1420,-1167,1507,1494,1389,1342,1465,1435,1450,1326,1505,
  1310,1493,1373,1479,1404,1492,1464,1419,428,443,472,397,736,526,464,464,486,457,442,471,484,482,1357,1449,1434,1478,1388,1491,1341,1490,1325,1489,
  1463,1403,1309,1477,1372,1448,1418,1433,1476,1356,1462,1387,-1439,1475,1340,1447,1402,1474,1324,1461,1371,1473,269,448,1432,1417,1308,1460,-1711,
  1459,-1727,1441,1099,1099,1446,1386,1431,1401,-1743,1289,1083,1083,1160,1160,1458,1445,1067,1067,1370,1457,1307,1430,1129,1129,1098,1098,268,432,
  267,416,266,400,-1887,1144,1187,1082,1173,1113,1186,1066,1050,1158,1128,1143,1172,1097,1171,1081,420,391,1157,1112,1170,1142,1127,1065,1169,1049,
  1156,1096,1141,1111,1155,1080,1126,1154,1064,1153,1140,1095,1048,-2159,1125,1110,1137,-2175,823,823,1139,1138,807,807,384,264,368,263,868,838,853,
  791,867,822,852,837,866,806,865,790,-2319,851,821,836,352,262,850,805,849,-2399,533,533,835,820,336,261,578,548,563,577,532,532,832,772,562,562,547,
  547,305,275,560,515,290,290,288,258,
);
const TAB32 = Uint8Array.of(
  130,162,193,209,44,28,76,140,9,9,9,9,9,9,9,9,190,254,222,238,126,94,157,157,109,61,173,205,
);
const TAB33 = Uint8Array.of(
  252,236,220,204,188,172,156,140,124,108,92,76,60,44,28,12,
);
const TABINDEX = Int16Array.of(
  0,32,64,98,0,132,180,218,292,364,426,538,648,746,0,1126,1460,1460,1460,1460,1460,1460,1460,1460,1842,1842,1842,1842,1842,1842,1842,1842,
);
const LINBITS = Uint8Array.of(
  0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,2,3,4,6,8,10,13,4,5,6,7,8,9,11,13,
);
const WIN = Float64Array.of(
  -1,26,-31,208,218,401,-519,2063,2000,4788,-5517,7134,5959,35640,-39336,74992,-1,24,-35,202,222,347,-581,2080,1952,4425,-5879,7640,5288,33791,-41176,
  74856,-1,21,-38,196,225,294,-645,2087,1893,4063,-6237,8092,4561,31947,-43006,74630,-1,19,-41,190,227,244,-711,2085,1822,3705,-6589,8492,3776,30112,
  -44821,74313,-1,17,-45,183,228,197,-779,2075,1739,3351,-6935,8840,2935,28289,-46617,73908,-1,16,-49,176,228,153,-848,2057,1644,3004,-7271,9139,2037,
  26482,-48390,73415,-2,14,-53,169,227,111,-919,2032,1535,2663,-7597,9389,1082,24694,-50137,72835,-2,13,-58,161,224,72,-991,2001,1414,2330,-7910,9592,
  70,22929,-51853,72169,-2,11,-63,154,221,36,-1064,1962,1280,2006,-8209,9750,-998,21189,-53534,71420,-2,10,-68,147,215,2,-1137,1919,1131,1692,-8491,
  9863,-2122,19478,-55178,70590,-3,9,-73,139,208,-29,-1210,1870,970,1388,-8755,9935,-3300,17799,-56778,69679,-3,8,-79,132,200,-57,-1283,1817,794,1095,
  -8998,9966,-4533,16155,-58333,68692,-4,7,-85,125,189,-83,-1356,1759,605,814,-9219,9959,-5818,14548,-59838,67629,-4,7,-91,117,177,-106,-1428,1698,
  402,545,-9416,9916,-7154,12980,-61289,66494,-5,6,-97,111,163,-127,-1498,1634,185,288,-9585,9838,-8540,11455,-62684,65290,
);
const SEC = Float64Array.of(
  10.19000816,0.50060302,0.50241929,3.40760851,0.50547093,0.52249861,2.05778098,0.51544732,0.56694406,1.48416460,0.53104258,0.64682180,1.16943991,
  0.55310392,0.78815460,0.97256821,0.58293498,1.06067765,0.83934963,0.62250412,1.72244716,0.74453628,0.67480832,5.10114861,
);

const G_EXPFRAC = [9.31322575e-10, 7.83145814e-10, 6.58544508e-10, 5.53767716e-10];
const G_SCF_PART = [
  [6, 5, 5, 5, 6, 5, 5, 5, 6, 5, 7, 3, 11, 10, 0, 0, 7, 7, 7, 0, 6, 6, 6, 3, 8, 8, 5, 0],
  [8, 9, 6, 12, 6, 9, 9, 9, 6, 9, 12, 6, 15, 18, 0, 0, 6, 15, 12, 0, 6, 12, 9, 6, 6, 18, 9, 0],
  [9, 9, 6, 12, 9, 9, 9, 9, 9, 9, 12, 6, 18, 18, 0, 0, 12, 12, 12, 0, 12, 9, 9, 6, 15, 12, 9, 0],
];
const G_SCFC_DECODE = [0, 1, 2, 3, 12, 5, 6, 7, 9, 10, 11, 13, 14, 15, 18, 19];
const G_MOD = [5, 5, 4, 4, 5, 5, 4, 1, 4, 3, 1, 1, 5, 6, 6, 1, 4, 4, 4, 1, 4, 3, 1, 1];
const G_PREAMP = [1, 1, 1, 1, 2, 2, 3, 3, 3, 2];
const G_AA = [[0.85749293, 0.881742, 0.94962865, 0.98331459, 0.99551782, 0.99916056, 0.9998992, 0.99999316], [0.51449576, 0.47173197, 0.31337745, 0.1819132, 0.09457419, 0.04096558, 0.01419856, 0.00369997]];
const G_TWID9 = [0.73727734, 0.79335334, 0.84339145, 0.88701083, 0.92387953, 0.95371695, 0.97629601, 0.99144486, 0.99904822, 0.67559021, 0.60876143, 0.53729961, 0.46174861, 0.38268343, 0.3007058, 0.21643961, 0.13052619, 0.04361938];
const G_TWID3 = [0.79335334, 0.92387953, 0.99144486, 0.60876143, 0.38268343, 0.13052619];
const G_MDCT_WINDOW = [
  [0.99904822, 0.99144486, 0.97629601, 0.95371695, 0.92387953, 0.88701083, 0.84339145, 0.79335334, 0.73727734, 0.04361938, 0.13052619, 0.21643961, 0.3007058, 0.38268343, 0.46174861, 0.53729961, 0.60876143, 0.67559021],
  [1, 1, 1, 1, 1, 1, 0.99144486, 0.92387953, 0.79335334, 0, 0, 0, 0, 0, 0, 0.13052619, 0.38268343, 0.60876143],
];

type Bits = { buf: Uint8Array; pos: number; limit: number };
function getBits(bs: Bits, n: number): number {
  const s = bs.pos & 7;
  let shl = n + s, p = bs.pos >> 3;
  if ((bs.pos += n) > bs.limit) return 0;
  let next = (bs.buf[p++] ?? 0) & (255 >> s), cache = 0;
  while ((shl -= 8) > 0) { cache |= next << shl; next = bs.buf[p++] ?? 0; }
  return (cache | (next >> -shl)) >>> 0;
}
const hdrValid = (b: Uint8Array, o: number) => b[o] === 0xff && ((b[o + 1] & 0xf0) === 0xf0 || (b[o + 1] & 0xfe) === 0xe2) && ((b[o + 1] >> 1) & 3) !== 0 && (b[o + 2] >> 4) !== 15 && ((b[o + 2] >> 2) & 3) !== 3;
const HALFRATE = [
  [[0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80], [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 72, 80], [0, 16, 24, 28, 32, 40, 48, 56, 64, 72, 80, 88, 96, 112, 128]],
  [[0, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160], [0, 16, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192], [0, 16, 32, 48, 64, 80, 96, 112, 128, 144, 160, 176, 192, 208, 224]],
];
type Hdr = { mpeg1: boolean; mono: boolean; crc: boolean; hz: number; frameBytes: number; srIdx: number; layer: number };
function parseHdr(b: Uint8Array, o: number): Hdr {
  const mpeg1 = !!(b[o + 1] & 8), notMpeg25 = !!(b[o + 1] & 0x10), layer = 4 - ((b[o + 1] >> 1) & 3);
  const rate = (b[o + 2] >> 2) & 3, hz = [44100, 48000, 32000][rate] >> (mpeg1 ? 0 : 1) >> (notMpeg25 ? 0 : 1);
  const kbps = 2 * HALFRATE[mpeg1 ? 1 : 0][((b[o + 1] >> 1) & 3) - 1][b[o + 2] >> 4];
  const samples = (b[o + 1] & 14) === 2 ? 576 : 1152;
  const frameBytes = Math.floor(samples * kbps * 125 / hz) + ((b[o + 2] & 2) ? 1 : 0);
  return { mpeg1, mono: (b[o + 3] & 0xc0) === 0xc0, crc: !(b[o + 1] & 1), hz, frameBytes, layer, srIdx: rate + ((mpeg1 ? 1 : 0) + (notMpeg25 ? 1 : 0)) * 3 };
}

type Gr = { sfbtab: Uint8Array; sfbOff: number; part23: number; bigValues: number; scalefacCompress: number; globalGain: number; blockType: number; mixed: number; nLongSfb: number; nShortSfb: number; tableSelect: number[]; regionCount: number[]; subblockGain: number[]; preflag: number; scalefacScale: number; count1Table: number; scfsi: number };
function readSideInfo(bs: Bits, h: Hdr): { mainDataBegin: number; grs: Gr[] } | null {
  let tables: number, scfsi = 0, part23Sum = 0;
  const sr = h.srIdx - (h.srIdx !== 0 ? 1 : 0);
  let grCount = h.mono ? 1 : 2, mainDataBegin: number;
  if (h.mpeg1) { grCount *= 2; mainDataBegin = getBits(bs, 9); scfsi = getBits(bs, 7 + grCount); }
  else mainDataBegin = getBits(bs, 8 + grCount) >> grCount;
  const grs: Gr[] = [];
  do {
    if (h.mono) scfsi <<= 4;
    const g: Gr = { sfbtab: SCF_LONG, sfbOff: sr * 23, part23: getBits(bs, 12), bigValues: 0, scalefacCompress: 0, globalGain: 0, blockType: 0, mixed: 0, nLongSfb: 22, nShortSfb: 0, tableSelect: [0, 0, 0], regionCount: [0, 0, 0], subblockGain: [0, 0, 0], preflag: 0, scalefacScale: 0, count1Table: 0, scfsi: 0 };
    part23Sum += g.part23;
    g.bigValues = getBits(bs, 9);
    if (g.bigValues > 288) return null;
    g.globalGain = getBits(bs, 8);
    g.scalefacCompress = getBits(bs, h.mpeg1 ? 4 : 9);
    if (getBits(bs, 1)) {
      g.blockType = getBits(bs, 2);
      if (!g.blockType) return null;
      g.mixed = getBits(bs, 1);
      g.regionCount[0] = 7; g.regionCount[1] = 255;
      if (g.blockType === 2) {
        scfsi &= 0x0f0f;
        if (!g.mixed) { g.regionCount[0] = 8; g.sfbtab = SCF_SHORT; g.sfbOff = sr * 40; g.nLongSfb = 0; g.nShortSfb = 39; }
        else { g.sfbtab = SCF_MIXED; g.sfbOff = sr * 40; g.nLongSfb = h.mpeg1 ? 8 : 6; g.nShortSfb = 30; }
      }
      tables = getBits(bs, 10) << 5;
      g.subblockGain = [getBits(bs, 3), getBits(bs, 3), getBits(bs, 3)];
    } else {
      tables = getBits(bs, 15);
      g.regionCount[0] = getBits(bs, 4); g.regionCount[1] = getBits(bs, 3); g.regionCount[2] = 255;
    }
    g.tableSelect = [tables >> 10, (tables >> 5) & 31, tables & 31];
    g.preflag = h.mpeg1 ? getBits(bs, 1) : (g.scalefacCompress >= 500 ? 1 : 0);
    g.scalefacScale = getBits(bs, 1);
    g.count1Table = getBits(bs, 1);
    g.scfsi = (scfsi >> 12) & 15;
    scfsi <<= 4;
    grs.push(g);
  } while (--grCount);
  if (part23Sum + bs.pos > bs.limit + mainDataBegin * 8) return null;
  return { mainDataBegin, grs };
}

function readScalefactors(scf: Uint8Array, istPos: Uint8Array, scfSize: number[], scfCount: number[], bs: Bits, scfsi: number) {
  let o = 0;
  for (let i = 0; i < 4 && scfCount[i]; i++, scfsi *= 2) {
    const cnt = scfCount[i];
    if (scfsi & 8) { for (let k = 0; k < cnt; k++) scf[o + k] = istPos[o + k]; }
    else {
      const bits = scfSize[i];
      if (!bits) { for (let k = 0; k < cnt; k++) { scf[o + k] = 0; istPos[o + k] = 0; } }
      else {
        const maxScf = scfsi < 0 ? (1 << bits) - 1 : -1;
        for (let k = 0; k < cnt; k++) { const s = getBits(bs, bits); istPos[o + k] = s === maxScf ? 255 : s; scf[o + k] = s; }
      }
    }
    o += cnt;
  }
  scf[o] = scf[o + 1] = scf[o + 2] = 0;
}
function ldexpQ2(y: number, expQ2: number): number {
  let e: number;
  do { e = Math.min(30 * 4, expQ2); y *= G_EXPFRAC[e & 3] * ((1 << 30) >> (e >> 2)); } while ((expQ2 -= e) > 0);
  return y;
}
function decodeScalefactors(h: Hdr, istPos: Uint8Array, bs: Bits, gr: Gr, scf: Float64Array) {
  let part = G_SCF_PART[(gr.nShortSfb ? 1 : 0) + (gr.nLongSfb ? 0 : 1)], partOff = 0;
  const scfSize = [0, 0, 0, 0], iscf = new Uint8Array(44), scfShift = gr.scalefacScale + 1;
  let scfsi = gr.scfsi;
  if (h.mpeg1) {
    const p = G_SCFC_DECODE[gr.scalefacCompress];
    scfSize[1] = scfSize[0] = p >> 2; scfSize[3] = scfSize[2] = p & 3;
  } else {
    let k = 0, modprod: number, sfc = gr.scalefacCompress;
    for (; sfc >= 0; sfc -= modprod, k += 4) {
      modprod = 1;
      for (let i = 3; i >= 0; i--) { scfSize[i] = Math.floor(sfc / modprod) % G_MOD[k + i]; modprod *= G_MOD[k + i]; }
    }
    partOff = k; scfsi = -16;
  }
  readScalefactors(iscf, istPos, scfSize, part.slice(partOff, partOff + 4), bs, scfsi);
  if (gr.nShortSfb) {
    const sh = 3 - scfShift;
    for (let i = 0; i < gr.nShortSfb; i += 3) {
      iscf[gr.nLongSfb + i] += gr.subblockGain[0] << sh;
      iscf[gr.nLongSfb + i + 1] += gr.subblockGain[1] << sh;
      iscf[gr.nLongSfb + i + 2] += gr.subblockGain[2] << sh;
    }
  } else if (gr.preflag) for (let i = 0; i < 10; i++) iscf[11 + i] += G_PREAMP[i];
  const gainExp = gr.globalGain - 4 - 210;
  const gain = ldexpQ2(1 << 11, 44 - gainExp);
  for (let i = 0; i < gr.nLongSfb + gr.nShortSfb; i++) scf[i] = ldexpQ2(gain, iscf[i] << scfShift);
}
function pow43(x: number): number {
  let mult = 256;
  if (x < 129) return POW43[16 + x];
  if (x < 1024) { mult = 16; x <<= 3; }
  const sign = 2 * x & 64, frac = ((x & 63) - sign) / ((x & ~63) + sign);
  return POW43[16 + ((x + sign) >> 6)] * (1 + frac * (4 / 3 + frac * (2 / 9))) * mult;
}
function huffman(dst: Float64Array, bs: Bits, gr: Gr, scf: Float64Array, limit: number) {
  const buf = bs.buf, at = (i: number) => buf[i] ?? 0;
  let one = 0, ireg = 0, bigValCnt = gr.bigValues, sfbI = gr.sfbOff, scfI = 0, d = 0;
  let nextPtr = bs.pos >> 3;
  let cache = ((((at(nextPtr) * 256 + at(nextPtr + 1)) * 256 + at(nextPtr + 2)) * 256 + at(nextPtr + 3)) << (bs.pos & 7)) >>> 0;
  let sh = (bs.pos & 7) - 8;
  nextPtr += 4;
  const peek = (n: number) => cache >>> (32 - n);
  const flush = (n: number) => { cache = (cache << n) >>> 0; sh += n; };
  const check = () => { while (sh >= 0) { cache = (cache | (at(nextPtr++) << sh)) >>> 0; sh -= 8; } };
  while (bigValCnt > 0) {
    const tabNum = gr.tableSelect[ireg];
    let sfbCnt = gr.regionCount[ireg++];
    const cb = TABINDEX[tabNum], linbits = LINBITS[tabNum];
    do {
      const np = gr.sfbtab[sfbI++] >> 1;
      let pairs = Math.min(bigValCnt, np);
      one = scf[scfI++];
      do {
        let w = 5, leaf = TABS[cb + peek(w)];
        while (leaf < 0) { flush(w); w = leaf & 7; leaf = TABS[cb + peek(w) - (leaf >> 3)]; }
        flush(leaf >> 8);
        for (let j = 0; j < 2; j++, d++, leaf >>= 4) {
          let lsb = leaf & 15;
          if (linbits && lsb === 15) {
            lsb += peek(linbits); flush(linbits); check();
            dst[d] = one * pow43(lsb) * ((cache | 0) < 0 ? -1 : 1);
          } else dst[d] = POW43[16 + lsb - 16 * (cache >>> 31)] * one;
          flush(lsb ? 1 : 0);
        }
        check();
      } while (--pairs);
      bigValCnt -= np;
    } while (bigValCnt > 0 && --sfbCnt >= 0);
  }
  const cb1 = gr.count1Table ? TAB33 : TAB32;
  let np = 1 - bigValCnt;
  for (;; d += 4) {
    let leaf = cb1[peek(4)];
    if (!(leaf & 8)) leaf = cb1[(leaf >> 3) + ((cache << 4) >>> (32 - (leaf & 3)))];
    flush(leaf & 7);
    if ((nextPtr * 8 - 24 + sh) > limit) break;
    if (!--np) { np = gr.sfbtab[sfbI++] >> 1; if (!np) break; one = scf[scfI++]; }
    if (leaf & 128) { dst[d] = (cache | 0) < 0 ? -one : one; flush(1); }
    if (leaf & 64) { dst[d + 1] = (cache | 0) < 0 ? -one : one; flush(1); }
    if (!--np) { np = gr.sfbtab[sfbI++] >> 1; if (!np) break; one = scf[scfI++]; }
    if (leaf & 32) { dst[d + 2] = (cache | 0) < 0 ? -one : one; flush(1); }
    if (leaf & 16) { dst[d + 3] = (cache | 0) < 0 ? -one : one; flush(1); }
    check();
  }
  bs.pos = limit;
}
function reorder(g: Float64Array, off: number, scratch: Float64Array, sfb: Uint8Array, sfbOff: number) {
  let src = off, dst = 0;
  for (let len: number; (len = sfb[sfbOff]) !== 0; sfbOff += 3, src += 2 * len) {
    for (let i = 0; i < len; i++, src++) { scratch[dst++] = g[src]; scratch[dst++] = g[src + len]; scratch[dst++] = g[src + 2 * len]; }
  }
  for (let i = 0; i < dst; i++) g[off + i] = scratch[i];
}
function antialias(g: Float64Array, nbands: number) {
  for (let o = 0; nbands > 0; nbands--, o += 18) {
    for (let i = 0; i < 8; i++) {
      const u = g[o + 18 + i], d = g[o + 17 - i];
      g[o + 18 + i] = u * G_AA[0][i] - d * G_AA[1][i];
      g[o + 17 - i] = u * G_AA[1][i] + d * G_AA[0][i];
    }
  }
}
function dct39(y: Float64Array) {
  let s0 = y[0], s2 = y[2], s4 = y[4], s6 = y[6], s8 = y[8];
  let t0 = s0 + s6 * 0.5;
  s0 -= s6;
  let t4 = (s4 + s2) * 0.93969262, t2 = (s8 + s2) * 0.76604444;
  s6 = (s4 - s8) * 0.17364818;
  s4 += s8 - s2;
  s2 = s0 - s4 * 0.5;
  y[4] = s4 + s0;
  s8 = t0 - t2 + s6; s0 = t0 - t4 + t2; s4 = t0 + t4 - s6;
  let s1 = y[1], s3 = y[3], s5 = y[5], s7 = y[7];
  s3 *= 0.8660254;
  t0 = (s5 + s1) * 0.98480775; t4 = (s5 - s7) * 0.34202014; t2 = (s1 + s7) * 0.64278761;
  s1 = (s1 - s5 - s7) * 0.8660254;
  s5 = t0 - s3 - t2; s7 = t4 - s3 - t0; s3 = t4 + s3 - t2;
  y[0] = s4 - s7; y[1] = s2 + s1; y[2] = s0 - s3; y[3] = s8 + s5; y[5] = s8 - s5; y[6] = s0 + s3; y[7] = s2 - s1; y[8] = s4 + s7;
}
function imdct36(g: Float64Array, go: number, ov: Float64Array, oo: number, win: number[], nbands: number) {
  const co = new Float64Array(9), si = new Float64Array(9);
  for (let j = 0; j < nbands; j++, go += 18, oo += 9) {
    co[0] = -g[go]; si[0] = g[go + 17];
    for (let i = 0; i < 4; i++) {
      si[8 - 2 * i] = g[go + 4 * i + 1] - g[go + 4 * i + 2];
      co[1 + 2 * i] = g[go + 4 * i + 1] + g[go + 4 * i + 2];
      si[7 - 2 * i] = g[go + 4 * i + 4] - g[go + 4 * i + 3];
      co[2 + 2 * i] = -(g[go + 4 * i + 3] + g[go + 4 * i + 4]);
    }
    dct39(co); dct39(si);
    si[1] = -si[1]; si[3] = -si[3]; si[5] = -si[5]; si[7] = -si[7];
    for (let i = 0; i < 9; i++) {
      const ovl = ov[oo + i], sum = co[i] * G_TWID9[9 + i] + si[i] * G_TWID9[i];
      ov[oo + i] = co[i] * G_TWID9[i] - si[i] * G_TWID9[9 + i];
      g[go + i] = ovl * win[i] - sum * win[9 + i];
      g[go + 17 - i] = ovl * win[9 + i] + sum * win[i];
    }
  }
}
function idct3(x0: number, x1: number, x2: number, dst: Float64Array) {
  const m1 = x1 * 0.8660254, a1 = x0 - x2 * 0.5;
  dst[1] = x0 + x2; dst[0] = a1 + m1; dst[2] = a1 - m1;
}
function imdct12(x: Float64Array, xo: number, dst: Float64Array, dd: number, ov: Float64Array, oo: number) {
  const co = new Float64Array(3), si = new Float64Array(3);
  idct3(-x[xo], x[xo + 6] + x[xo + 3], x[xo + 12] + x[xo + 9], co);
  idct3(x[xo + 15], x[xo + 12] - x[xo + 9], x[xo + 6] - x[xo + 3], si);
  si[1] = -si[1];
  for (let i = 0; i < 3; i++) {
    const ovl = ov[oo + i], sum = co[i] * G_TWID3[3 + i] + si[i] * G_TWID3[i];
    ov[oo + i] = co[i] * G_TWID3[i] - si[i] * G_TWID3[3 + i];
    dst[dd + i] = ovl * G_TWID3[2 - i] - sum * G_TWID3[5 - i];
    dst[dd + 5 - i] = ovl * G_TWID3[5 - i] + sum * G_TWID3[2 - i];
  }
}
function imdctShort(g: Float64Array, go: number, ov: Float64Array, oo: number, nbands: number) {
  const tmp = new Float64Array(18);
  for (; nbands > 0; nbands--, oo += 9, go += 18) {
    for (let i = 0; i < 18; i++) tmp[i] = g[go + i];
    for (let i = 0; i < 6; i++) g[go + i] = ov[oo + i];
    imdct12(tmp, 0, g, go + 6, ov, oo + 6);
    imdct12(tmp, 1, g, go + 12, ov, oo + 6);
    imdct12(tmp, 2, ov, oo, ov, oo + 6);
  }
}
function changeSign(g: Float64Array) {
  for (let b = 0, o = 18; b < 32; b += 2, o += 36) for (let i = 1; i < 18; i += 2) g[o + i] = -g[o + i];
}
function imdctGr(g: Float64Array, ov: Float64Array, blockType: number, nLongBands: number) {
  let go = 0, oo = 0;
  if (nLongBands) { imdct36(g, go, ov, oo, G_MDCT_WINDOW[0], nLongBands); go += 18 * nLongBands; oo += 9 * nLongBands; }
  if (blockType === 2) imdctShort(g, go, ov, oo, 32 - nLongBands);
  else imdct36(g, go, ov, oo, G_MDCT_WINDOW[blockType === 3 ? 1 : 0], 32 - nLongBands);
}
function dct2(g: Float64Array, n: number) {
  const t = new Float64Array(32);
  for (let k = 0; k < n; k++) {
    const y = k;
    for (let i = 0; i < 8; i++) {
      const x0 = g[y + i * 18], x1 = g[y + (15 - i) * 18], x2 = g[y + (16 + i) * 18], x3 = g[y + (31 - i) * 18];
      const t0 = x0 + x3, t1 = x1 + x2, t2 = (x1 - x2) * SEC[3 * i], t3 = (x0 - x3) * SEC[3 * i + 1];
      t[i] = t0 + t1; t[8 + i] = (t0 - t1) * SEC[3 * i + 2]; t[16 + i] = t3 + t2; t[24 + i] = (t3 - t2) * SEC[3 * i + 2];
    }
    for (let i = 0, x = 0; i < 4; i++, x += 8) {
      let x0 = t[x], x1 = t[x + 1], x2 = t[x + 2], x3 = t[x + 3], x4 = t[x + 4], x5 = t[x + 5], x6 = t[x + 6], x7 = t[x + 7], xt: number;
      xt = x0 - x7; x0 += x7;
      x7 = x1 - x6; x1 += x6;
      x6 = x2 - x5; x2 += x5;
      x5 = x3 - x4; x3 += x4;
      x4 = x0 - x3; x0 += x3;
      x3 = x1 - x2; x1 += x2;
      t[x] = x0 + x1;
      t[x + 4] = (x0 - x1) * 0.70710677;
      x5 = x5 + x6;
      x6 = (x6 + x7) * 0.70710677;
      x7 = x7 + xt;
      x3 = (x3 + x4) * 0.70710677;
      x5 -= x7 * 0.198912367;
      x7 += x5 * 0.382683432;
      x5 -= x7 * 0.198912367;
      x0 = xt - x6; xt += x6;
      t[x + 1] = (xt + x7) * 0.50979561;
      t[x + 2] = (x4 + x3) * 0.54119611;
      t[x + 3] = (x0 - x5) * 0.60134488;
      t[x + 5] = (x0 + x5) * 0.89997619;
      t[x + 6] = (x4 - x3) * 1.30656302;
      t[x + 7] = (xt - x7) * 2.56291556;
    }
    let yy = y;
    for (let i = 0; i < 7; i++, yy += 4 * 18) {
      g[yy] = t[i];
      g[yy + 18] = t[16 + i] + t[24 + i] + t[24 + i + 1];
      g[yy + 36] = t[8 + i] + t[8 + i + 1];
      g[yy + 54] = t[16 + i + 1] + t[24 + i] + t[24 + i + 1];
    }
    g[yy] = t[7]; g[yy + 18] = t[16 + 7] + t[24 + 7]; g[yy + 36] = t[8 + 7]; g[yy + 54] = t[24 + 7];
  }
}
const scalePcm = (s: number) => {
  if (s >= 32766.5) return 32767;
  if (s <= -32767.5) return -32768;
  let v = Math.trunc(s + 0.5);
  if (v < 0) v -= 1;
  return v;
};
function synthPair(pcm: Int16Array, po: number, nch: number, z: Float64Array, zo: number) {
  let a = (z[zo + 14 * 64] - z[zo]) * 29;
  a += (z[zo + 64] + z[zo + 13 * 64]) * 213;
  a += (z[zo + 12 * 64] - z[zo + 2 * 64]) * 459;
  a += (z[zo + 3 * 64] + z[zo + 11 * 64]) * 2037;
  a += (z[zo + 10 * 64] - z[zo + 4 * 64]) * 5153;
  a += (z[zo + 5 * 64] + z[zo + 9 * 64]) * 6574;
  a += (z[zo + 8 * 64] - z[zo + 6 * 64]) * 37489;
  a += z[zo + 7 * 64] * 75038;
  pcm[po] = scalePcm(a);
  zo += 2;
  a = z[zo + 14 * 64] * 104;
  a += z[zo + 12 * 64] * 1567;
  a += z[zo + 10 * 64] * 9727;
  a += z[zo + 8 * 64] * 64019;
  a += z[zo + 6 * 64] * -9975;
  a += z[zo + 4 * 64] * -45;
  a += z[zo + 2 * 64] * 146;
  a += z[zo] * -5;
  pcm[po + 16 * nch] = scalePcm(a);
}
// One pair of subbands, mono: xl and xr are the same buffer (as in minimp3 with nch = 1).
function synth(xl: Float64Array, xo: number, pcm: Int16Array, po: number, nch: number, lins: Float64Array, lo: number) {
  const zl = lo + 15 * 64, xr = xl, dstl = po, dstr = po + (nch - 1);
  lins[zl + 60] = xl[xo + 18 * 16]; lins[zl + 61] = xr[xo + 18 * 16]; lins[zl + 62] = xl[xo]; lins[zl + 63] = xr[xo];
  lins[zl + 124] = xl[xo + 1 + 18 * 16]; lins[zl + 125] = xr[xo + 1 + 18 * 16]; lins[zl + 126] = xl[xo + 1]; lins[zl + 127] = xr[xo + 1];
  synthPair(pcm, dstr, nch, lins, lo + 4 * 15 + 1);
  synthPair(pcm, dstr + 32 * nch, nch, lins, lo + 4 * 15 + 64 + 1);
  synthPair(pcm, dstl, nch, lins, lo + 4 * 15);
  synthPair(pcm, dstl + 32 * nch, nch, lins, lo + 4 * 15 + 64);
  const a = [0, 0, 0, 0], b = [0, 0, 0, 0], mode = [0, 2, 1, 2, 1, 2, 1, 2];
  for (let i = 14; i >= 0; i--) {
    lins[zl + 4 * i] = xl[xo + 18 * (31 - i)]; lins[zl + 4 * i + 1] = xr[xo + 18 * (31 - i)];
    lins[zl + 4 * i + 2] = xl[xo + 1 + 18 * (31 - i)]; lins[zl + 4 * i + 3] = xr[xo + 1 + 18 * (31 - i)];
    lins[zl + 4 * (i + 16)] = xl[xo + 1 + 18 * (1 + i)]; lins[zl + 4 * (i + 16) + 1] = xr[xo + 1 + 18 * (1 + i)];
    lins[zl + 4 * (i - 16) + 2] = xl[xo + 18 * (1 + i)]; lins[zl + 4 * (i - 16) + 3] = xr[xo + 18 * (1 + i)];
    for (let k = 0; k < 8; k++) {
      // the window is walked 16 values per round, starting with i = 14
      const w0 = WIN[(14 - i) * 16 + 2 * k], w1 = WIN[(14 - i) * 16 + 2 * k + 1];
      const vz = zl + 4 * i - k * 64, vy = zl + 4 * i - (15 - k) * 64;
      for (let j = 0; j < 4; j++) {
        const bb = lins[vz + j] * w1 + lins[vy + j] * w0;
        const aa = mode[k] === 2 ? lins[vy + j] * w1 - lins[vz + j] * w0 : lins[vz + j] * w0 - lins[vy + j] * w1;
        if (k === 0) { b[j] = bb; a[j] = aa; } else { b[j] += bb; a[j] += aa; }
      }
    }
    pcm[dstr + (15 - i) * nch] = scalePcm(a[1]); pcm[dstr + (17 + i) * nch] = scalePcm(b[1]);
    pcm[dstl + (15 - i) * nch] = scalePcm(a[0]); pcm[dstl + (17 + i) * nch] = scalePcm(b[0]);
    pcm[dstr + (47 - i) * nch] = scalePcm(a[3]); pcm[dstr + (49 + i) * nch] = scalePcm(b[3]);
    pcm[dstl + (47 - i) * nch] = scalePcm(a[2]); pcm[dstl + (49 + i) * nch] = scalePcm(b[2]);
  }
}

type Dec = { reserv: number; reservBuf: Uint8Array; overlap: Float64Array; qmf: Float64Array; hdr: Uint8Array | null };
/** MP3 bytes (mono Layer III) to 16-bit PCM and the sample rate. Throws on anything it does not support. */
export function decodeMp3(mp3: Uint8Array): { pcm: Int16Array; hz: number } {
  const dec: Dec = { reserv: 0, reservBuf: new Uint8Array(511), overlap: new Float64Array(9 * 32), qmf: new Float64Array(15 * 64), hdr: null };
  let pos = 0;
  if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) pos = 10 + (((mp3[6] & 0x7f) << 21) | ((mp3[7] & 0x7f) << 14) | ((mp3[8] & 0x7f) << 7) | (mp3[9] & 0x7f));
  const out: Int16Array[] = [];
  let hz = 0;
  const syn = new Float64Array((18 + 15) * 64), grbuf = new Float64Array(576 * 2), scf = new Float64Array(44), scratch = new Float64Array(576), istPos = new Uint8Array(39);
  while (pos + 4 <= mp3.length) {
    if (!hdrValid(mp3, pos)) { pos++; continue; }
    const h = parseHdr(mp3, pos);
    if (h.layer !== 3) throw new Error("语音服务返回的不是 MP3 第三层");
    if (!h.mono) throw new Error("只能解码单声道");
    if (!h.frameBytes) throw new Error("不支持的 MP3 格式");
    if (pos + h.frameBytes > mp3.length) break;
    // a real frame is followed by another header (or the end of the data)
    if (pos + h.frameBytes + 4 <= mp3.length && !hdrValid(mp3, pos + h.frameBytes)) { pos++; continue; }
    hz = h.hz;
    const frame = mp3.subarray(pos + 4, pos + h.frameBytes);
    pos += h.frameBytes;
    const bs: Bits = { buf: frame, pos: 0, limit: frame.length * 8 };
    if (h.crc) getBits(bs, 16);
    const side = readSideInfo(bs, h);
    if (!side || bs.pos > bs.limit) { dec.reserv = 0; continue; }
    // bit reservoir: bytes kept from earlier frames come first
    const frameBytes = (bs.limit - bs.pos) >> 3, have = Math.min(dec.reserv, side.mainDataBegin);
    const main = new Uint8Array(have + frameBytes + 16);
    main.set(dec.reservBuf.subarray(Math.max(0, dec.reserv - side.mainDataBegin), Math.max(0, dec.reserv - side.mainDataBegin) + have), 0);
    main.set(frame.subarray(bs.pos >> 3, (bs.pos >> 3) + frameBytes), have);
    const mb: Bits = { buf: main, pos: 0, limit: (have + frameBytes) * 8 };
    const ok = dec.reserv >= side.mainDataBegin;
    const nGr = h.mpeg1 ? 2 : 1, pcm = new Int16Array(576 * nGr);
    if (ok) {
      for (let igr = 0; igr < nGr; igr++) {
        grbuf.fill(0);
        const gr = side.grs[igr], limit = mb.pos + gr.part23;
        decodeScalefactors(h, istPos, mb, gr, scf);
        huffman(grbuf, mb, gr, scf, limit);
        let aaBands = 31;
        const nLongBands = (gr.mixed ? 2 : 0) << (h.srIdx === 2 ? 1 : 0);
        if (gr.nShortSfb) { aaBands = nLongBands - 1; reorder(grbuf, nLongBands * 18, scratch, gr.sfbtab, gr.sfbOff + gr.nLongSfb); }
        antialias(grbuf, aaBands);
        imdctGr(grbuf, dec.overlap, gr.blockType, nLongBands);
        changeSign(grbuf);
        // synthesis: 18 subband samples per granule through the polyphase filter bank
        dct2(grbuf, 18);
        for (let i = 0; i < 15 * 64; i++) syn[i] = dec.qmf[i];
        const gp = new Int16Array(576);
        for (let i = 0; i < 18; i += 2) synth(grbuf, i, gp, 32 * i, 1, syn, i * 64);
        for (let i = 0; i < 15 * 64; i += 2) dec.qmf[i] = syn[18 * 64 + i];
        pcm.set(gp, igr * 576);
      }
    }
    // keep the unread tail of this frame's main data for the next frame
    let p = (mb.pos + 7) >> 3, remains = (mb.limit >> 3) - p;
    if (remains > 511) { p += remains - 511; remains = 511; }
    if (remains > 0) dec.reservBuf.set(main.subarray(p, p + remains), 0);
    dec.reserv = Math.max(0, remains);
    if (ok) out.push(pcm);
  }
  const total = out.reduce((n, p) => n + p.length, 0), all = new Int16Array(total);
  let at = 0; for (const p of out) { all.set(p, at); at += p.length; }
  if (!total) throw new Error("没有解出声音");
  return { pcm: all, hz };
}

/* ------------------------------------------- shell pieces for the cloud computer */

export const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export const NARRATE_LIMITS = { scenes: 12, sceneChars: 400, capMB: 18, audioKbps: 64, maxVideoKbps: 2500, minVideoKbps: 120 };
/** Video bitrate in kbit/s that keeps video plus audio of `seconds` under the size cap. */
export function videoKbps(seconds: number, capMB = NARRATE_LIMITS.capMB, audioKbps = NARRATE_LIMITS.audioKbps): number {
  const total = Math.floor((capMB * 8192) / Math.max(1, seconds)) - audioKbps;
  return Math.max(NARRATE_LIMITS.minVideoKbps, Math.min(NARRATE_LIMITS.maxVideoKbps, total));
}

const wide = (ch: string) => /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch);
const width = (s: string) => [...s].reduce((n, c) => n + (wide(c) ? 2 : 1), 0);
/** Breaks a spoken text into subtitle pages of at most `lines` lines of `cols` columns (a CJK character takes 2). */
export function subtitlePages(text: string, cols = 44, lines = 2): string[][] {
  const flat = text.replace(/\s+/g, " ").trim();
  const rows: string[] = [];
  let cur = "";
  const soft = /[，。！？；、,.!?;:：）)」』”]/;
  for (const ch of [...flat]) {
    if (width(cur + ch) > cols && !(soft.test(ch) && width(cur) <= cols + 2)) { rows.push(cur.trim()); cur = ""; if (ch === " ") continue; }
    cur += ch;
  }
  if (cur.trim()) rows.push(cur.trim());
  const pages: string[][] = [];
  for (let i = 0; i < rows.length; i += lines) pages.push(rows.slice(i, i + lines));
  return pages;
}
/** Each page's share of the scene's time, by how much is said on it. Sums to 1. */
export function pageShares(pages: string[][]): number[] {
  const w = pages.map(p => Math.max(1, p.join("").length));
  const sum = w.reduce((a, b) => a + b, 0);
  return w.map(x => x / sum);
}

/** Characters that mean something to ffmpeg's filter parser or to the shell inside a filter option value. */
export const filterEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]").replace(/;/g, "\\;").replace(/%/g, "\\%");

/** Burns an SRT file in with libass (the cloud computer's ffmpeg has no drawtext). The words stay in the SRT file, so quotes,
 *  colons and percent signs in what is said never reach the filter parser; only the file name and the style do. */
export const SUB_STYLE = "FontName=Noto Sans CJK SC,FontSize=24,PrimaryColour=&HFFFFFF&,OutlineColour=&H000000&,BorderStyle=1,Outline=2.5,Shadow=0,MarginV=26,Alignment=2";
export function subtitlesFilter(file: string, style = SUB_STYLE): string {
  if (/['\\]/.test(style)) throw new Error("subtitle style cannot hold quotes or backslashes");
  return "subtitles=filename=" + filterEscape(file) + ":original_size=1280x720:force_style='" + style + "'";
}
/** A slow zoom (even scenes in, odd scenes pan), 1920x1080 still to 1280x720 at 25 fps. `frames` is a shell expression. */
export function motionFilter(index: number, frames: string): string {
  const base = "zoompan=";
  const tail = ":d=" + frames + ":s=1280x720:fps=25";
  const m = index % 3;
  if (m === 0) return base + "z='1+0.14*on/" + frames + "':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" + tail;
  if (m === 1) return base + "z=1.15:x='(iw-iw/zoom)*on/" + frames + "':y='(ih-ih/zoom)/2'" + tail;
  return base + "z='1.15-0.14*on/" + frames + "':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" + tail;
}

export type NarrateJob = { scenes: { file: string; text: string }[]; voiceId: string; rate: string; subtitles: boolean };
/** Emoji and other symbols the CJK font cannot draw would show as empty boxes in the subtitles. */
export const subtitleText = (s: string) => s.replace(/[\p{Extended_Pictographic}‍️]/gu, "").replace(/\s+/g, " ").trim();

/** The text files of a narration (flat names, moved under /work/voice/): vs{i}.txt is what is said in scene i,
 *  vc{i}_{k}.txt is subtitle page k of it. */
export function narrateTexts(job: NarrateJob): Record<string, string> {
  const out: Record<string, string> = {};
  job.scenes.forEach((s, i) => {
    out[`vs${i + 1}.txt`] = s.text;
    if (job.subtitles) subtitlePages(subtitleText(s.text) || " ").forEach((p, k) => { out[`vc${i + 1}_${k + 1}.txt`] = p.join("\n"); });
  });
  return out;
}
/** The shell script that cuts one clip per scene and joins them (voice-over already in a{i}.mp3). */
export function narrateScript(job: NarrateJob): string {
  const n = job.scenes.length, cap = NARRATE_LIMITS;
  const lines: string[] = ["set -e", "cd /work/voice",
    // the total length decides the bitrate: the same formula as videoKbps()
    `TOTAL=0; for i in $(seq 1 ${n}); do D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 a$i.mp3); TOTAL=$(awk -v t=$TOTAL -v d=$D 'BEGIN{print t+d+0.3}'); done`,
    `VB=$(awk -v t=$TOTAL 'BEGIN{v=int(${cap.capMB}*8192/(t>1?t:1))-${cap.audioKbps}; if(v>${cap.maxVideoKbps})v=${cap.maxVideoKbps}; if(v<${cap.minVideoKbps})v=${cap.minVideoKbps}; print v}')`,
    'echo "total=$TOTAL video_kbps=$VB"', ": > list.txt",
    `tc(){ awk -v t="$1" 'BEGIN{printf "%02d:%02d:%06.3f", int(t/3600), int((t%3600)/60), t%60}' | tr . ,; }`];
  job.scenes.forEach((s, idx) => {
    const i = idx + 1;
    const pages = job.subtitles ? subtitlePages(subtitleText(s.text) || " ") : [], shares = pageShares(pages);
    // times are worked out in the shell once the length of the voice-over is known
    let acc = 0;
    const srt = pages.map((_, k) => {
      const a = acc, b = k === pages.length - 1 ? 1 : acc + shares[k];
      acc = b;
      return `printf '%d\\n%s --> %s\\n' ${k + 1} "$(tc $(f ${a.toFixed(4)}))" "$(tc $(f ${b.toFixed(4)}))"; cat vc${i}_${k + 1}.txt; printf '\\n\\n'`;
    });
    const vf = [motionFilter(idx, "$FR"), ...(pages.length ? [subtitlesFilter(`s${i}.srt`)] : []), "format=yuv420p"].join(",");
    lines.push(
      `# scene ${i}`,
      `D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 a${i}.mp3); T=$(awk -v d=$D 'BEGIN{printf "%.3f", d+0.3}'); FR=$(awk -v t=$T 'BEGIN{printf "%d", t*25+1}')`,
      `f(){ awk -v t="$T" -v k="$1" 'BEGIN{printf "%.3f", t*k}'; }`,
      ...(srt.length ? [`{ ${srt.join("; ")}; } > s${i}.srt`] : []),
      `ffmpeg -v error -y -i ${shq(s.file)} -filter_complex "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=30:5[bg];[0:v]scale=1920:1080:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24" -frames:v 1 bg${i}.png`,
      `ffmpeg -v error -y -i bg${i}.png -i a${i}.mp3 -vf "${vf}" -af "apad=pad_dur=0.3,aresample=44100,aformat=channel_layouts=stereo" -t $T -r 25 -c:v libx264 -preset veryfast -crf 27 -maxrate \${VB}k -bufsize \${VB}k -c:a aac -b:a ${cap.audioKbps}k clip${i}.mp4`,
      `echo "file 'clip${i}.mp4'" >> list.txt`,
    );
  });
  lines.push("ffmpeg -v error -y -f concat -safe 0 -i list.txt -c copy -movflags +faststart out.mp4",
    "ffprobe -v error -show_entries format=duration,size:stream=codec_type,codec_name,width,height -of default=nw=1 out.mp4");
  return lines.join("\n") + "\n";
}
const UNPACK = (job: string, dir: string) =>
  `rm -rf ${dir} && mkdir -p ${dir} && cd ${dir} && /opt/py/bin/python -c "import json,base64;j=json.load(open('/work/${job}'));[open(k,'wb').write(base64.b64decode(v['b64']) if isinstance(v,dict) else v.encode()) for k,v in j.items()]" && rm -f /work/${job}`;
const INSTALL_TTS = "(/opt/py/bin/python -c 'import edge_tts' 2>/dev/null || uv pip install -q --python /opt/py/bin/python edge-tts)";
/** Speaks each text file, four at a time, each tried up to four times; fails (printing the service's error) if any output is missing. */
export function ttsLoop(jobs: { input: string; voiceId: string; rate: string; output: string }[], bin = "/opt/py/bin/edge-tts"): string {
  const calls = jobs.map(j => `( for try in 1 2 3 4; do ${bin} --file ${shq(j.input)} --voice ${shq(j.voiceId)} --rate=${shq(j.rate)} --write-media ${shq(j.output)} 2>${shq(j.output + ".err")} && [ -s ${shq(j.output)} ] && break; sleep 2; done ) &`);
  const batched = calls.flatMap((c, i) => (i % 4 === 3 ? [c, "wait;"] : [c]));
  const check = jobs.map(j => `[ -s ${shq(j.output)} ] || { echo "配音失败：${j.input}"; cat ${shq(j.output + ".err")}; exit 1; }`);
  // braces keep the background jobs and the checks in the directory the preceding cd chose
  return "{ " + batched.join(" ") + " wait; " + check.join("; ") + "; }";
}
export function narrateCommands(job: NarrateJob): string[] {
  const jobs = job.scenes.map((_, i) => ({ input: `vs${i + 1}.txt`, voiceId: job.voiceId, rate: job.rate, output: `a${i + 1}.mp3` }));
  return [UNPACK("vjob.json", "/work/voice"), "cd /work/voice && " + INSTALL_TTS, "cd /work/voice && " + ttsLoop(jobs), "bash /work/voice/vbuild.sh"];
}

export type PodcastLine = { speaker: "A" | "B"; text: string };
export type PodcastJob = { lines: PodcastLine[]; voices: { A: string; B: string }; rate: string; pause: number };
export function podcastScript(job: PodcastJob): string {
  const n = job.lines.length;
  return ["set -e", "cd /work/pod", `ffmpeg -v error -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${job.pause.toFixed(2)} -c:a libmp3lame -b:a 48k gap.mp3`,
    ": > list.txt", `for i in $(seq 1 ${n}); do echo "file 'p$i.mp3'" >> list.txt; [ $i -lt ${n} ] && echo "file 'gap.mp3'" >> list.txt; done`,
    "ffmpeg -v error -y -f concat -safe 0 -i list.txt -ar 24000 -ac 1 -c:a libmp3lame -b:a 56k show.mp3",
    "ffprobe -v error -show_entries format=duration,size -of default=nw=1 show.mp3"].join("\n") + "\n";
}
export function podcastTexts(job: PodcastJob): Record<string, string> {
  const out: Record<string, string> = {};
  job.lines.forEach((l, i) => { out[`pl${i + 1}.txt`] = l.text; });
  return out;
}
export function podcastCommands(job: PodcastJob): string[] {
  const jobs = job.lines.map((l, i) => ({ input: `pl${i + 1}.txt`, voiceId: job.voices[l.speaker], rate: job.rate, output: `p${i + 1}.mp3` }));
  return [UNPACK("pjob.json", "/work/pod"), "cd /work/pod && " + INSTALL_TTS, "cd /work/pod && " + ttsLoop(jobs), "bash /work/pod/pbuild.sh"];
}

/** File name safe for QQ and for the shell-free path through the bot. */
export const safeName = (title: string, ext: string) => (String(title || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30) || "作品") + "." + ext;
const b64 = (bytes: Uint8Array) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const num = (re: RegExp, s: string) => Number(re.exec(s)?.[1] || 0);
const ext = (mime: string) => ({ "image/png": "png", "image/webp": "webp", "image/gif": "gif" } as Record<string, string>)[mime] || "jpg";
const speedRate = (v: unknown) => rateString(Number(v) || 0);

/* ------------------------------------------------------------------ tools */

const obj = (properties: any, required: string[] = []) => ({ type: "object", properties, required });
const voiceParam = (what: string) => ({ type: "string", enum: Object.keys(VOICES), description: what + "可选：" + voiceList() });

function tools(ctx: Ctx) {
  const { host, hub } = ctx;
  const timeFail = (e: any) => ({ ok: false, error: String(e?.message || e) });
  const sendOut = async (name: string, bytes: Uint8Array, video: boolean, deliver: boolean) => {
    if (!deliver) return { kept_as: await host.keepFile(name, bytes) || "太大没存下", sent: false };
    let r = video ? await host.sendVideo(name, bytes) : await host.sendFile(name, bytes);
    let how = video ? "video" : "file";
    if (!r.ok && video) { r = await host.sendFile(name, bytes); how = "file"; }
    if (r.ok) await host.keepFile(name, bytes);
    return r.ok ? { sent: true, sent_as: how, ...(r.queued ? { delivery: "已排队，网络恢复后自动发出" } : {}) } : { sent: false, error: "做好了但发到 QQ 失败：" + (r.error || "未知原因") };
  };

  return [
    {
      name: "narrate", work: true, slow: true, long: true,
      description: "把几张图配上旁白做成一个讲解视频，直接发群里：每张图一段，画面缓慢推拉，配音念 text，底部可以烧上字幕（默认有）。群友说“做个视频讲讲这个”“把这几张图配音做成短片”“用东北话/粤语念出来”时用。scenes 一到十二段，每段 image 是图的编号（聊天里的 123-0、你画过的 g12、保存过的名字如 奶蛙），text 是这一段要念的话（口语，每段 30 到 150 字，一句话 5 到 15 秒）。画面顺序就是 scenes 的顺序，同一张图可以用在几段里。voice 选配音：" + voiceList() + "。speed 语速，-30 到 50（百分比），默认 0。整个过程一到三分钟，视频 720p，不超过 20 MB。返回 sent=true 才算发出去；deliver=false 时只保存不发群，返回文件编号。",
      parameters: obj({
        title: { type: "string", description: "视频标题，用作文件名" },
        scenes: { type: "array", minItems: 1, maxItems: 12, items: obj({ image: { type: "string", description: "图的编号或保存过的名字" }, text: { type: "string", description: "这一段旁白" } }, ["image", "text"]) },
        voice: voiceParam("配音。"),
        subtitles: { type: "boolean", description: "是否烧字幕，默认 true" },
        speed: { type: "integer", description: "语速百分比，-30 到 50，默认 0" },
        deliver: { type: "boolean", description: "默认 true，做完发群里；填 false 只保存" },
      }, ["title", "scenes"]),
      run: async (a: any) => {
        const raw = (Array.isArray(a.scenes) ? a.scenes : []).slice(0, NARRATE_LIMITS.scenes);
        const scenes = raw.map((s: any) => ({ image: String(s?.image || "").trim(), text: String(s?.text || "").replace(/\s+/g, " ").trim().slice(0, NARRATE_LIMITS.sceneChars) })).filter((s: any) => s.image && s.text);
        if (!scenes.length) return { ok: false, error: "scenes 里每段都要有 image 和 text，一到十二段" };
        const files: Record<string, any> = {}, byRef = new Map<string, string>(), missing: string[] = [];
        let total = 0;
        for (const s of scenes) {
          if (byRef.has(s.image)) continue;
          const img = await host.imageRef(s.image).catch(() => null);
          if (!img) { missing.push(s.image); continue; }
          total += img.bytes.length;
          const name = "vimg" + (byRef.size + 1) + "." + ext(img.mime);
          byRef.set(s.image, name); files[name] = { b64: b64(img.bytes) };
        }
        if (missing.length) return { ok: false, error: "这些图取不到：" + missing.join("、") + "（可能过期了，让群友重发或换一张）" };
        if (total > 16 * 1024 * 1024) return { ok: false, error: "图片加起来太大了（超过 16 MB），少用几张或换小一点的图" };
        if (!(await host.quota("narrate", Number(host.cfg("narrate_daily"))))) return { ok: false, error: "今天做配音视频的次数用完了" };
        const v = pickVoice(a.voice), job: NarrateJob = { scenes: scenes.map((s: any) => ({ file: byRef.get(s.image)!, text: s.text })), voiceId: v.id, rate: speedRate(a.speed), subtitles: a.subtitles !== false };
        Object.assign(files, narrateTexts(job), { "vbuild.sh": narrateScript(job) });
        const json = new TextEncoder().encode(JSON.stringify(files));
        let out;
        try { out = await host.computer({ commands: narrateCommands(job), files: [{ name: "vjob.json", bytes: json }], collect: ["voice/out.mp4"], timeoutSeconds: 1200 }); }
        catch (e) { return timeFail(e); }
        const failed = out.steps.find(st => st.exit !== 0), last = out.steps[out.steps.length - 1]?.stdout || "";
        const video = out.files.find(f => f.name.endsWith("out.mp4"));
        if (!out.ok || !video) return { ok: false, error: "视频没做成：" + (out.error || (failed ? failed.stdout.slice(-300) + failed.stderr.slice(-400) : "没有产出")).slice(0, 700) };
        if (video.bytes.length > 20 * 1024 * 1024) return { ok: false, error: "视频超过 20 MB 发不出去，少放几段或把每段话缩短" };
        const seconds = Math.round(num(/duration=([\d.]+)/, last) * 10) / 10, name = safeName(a.title, "mp4");
        const streams = [...last.matchAll(/codec_type=(\w+)/g)].map(m => m[1]);
        return { ok: true, title: String(a.title || ""), seconds, size_mb: Math.round(video.bytes.length / 1048576 * 10) / 10, voice: v.label, subtitles: job.subtitles, streams, ...(await sendOut(name, video.bytes, true, a.deliver !== false)) };
      },
    },
    {
      name: "podcast", work: true, slow: true,
      description: "把一段对话稿做成音频节目（MP3），作为文件发群里：一个人讲或两个人聊都行，每句可以用不同的声音（普通话、东北话、粤语、台湾腔）。群友说“做个播客”“把这篇整理成两个人聊天的音频”“用东北话和粤语各念一个角色”时用。lines 按顺序写每句话，speaker 填 A 或 B，text 是这一句（口语，别太长，每句 150 字以内，最多 60 句）。voices 给 A 和 B 各选一个声音（只有一个人时 B 也填个声音，不用就行）：" + voiceList() + "。pause 是句与句之间停多少秒，默认 0.4。要先自己把稿子写好再调用。返回时长；sent=true 才算发出去。",
      parameters: obj({
        title: { type: "string", description: "节目标题，用作文件名" },
        lines: { type: "array", minItems: 1, maxItems: 60, items: obj({ speaker: { type: "string", enum: ["A", "B"] }, text: { type: "string" } }, ["speaker", "text"]) },
        voices: obj({ A: voiceParam("A 的声音。"), B: voiceParam("B 的声音。") }, ["A"]),
        pause: { type: "number", description: "句间停顿秒数，0 到 1.5，默认 0.4" },
        speed: { type: "integer", description: "语速百分比，-30 到 50，默认 0" },
        deliver: { type: "boolean", description: "默认 true，做完发群里；填 false 只保存" },
      }, ["title", "lines", "voices"]),
      run: async (a: any) => {
        const lines: PodcastLine[] = (Array.isArray(a.lines) ? a.lines : []).slice(0, 60)
          .map((l: any) => ({ speaker: String(l?.speaker).toUpperCase() === "B" ? "B" : "A", text: String(l?.text || "").replace(/\s+/g, " ").trim().slice(0, 400) })).filter((l: PodcastLine) => l.text);
        if (!lines.length) return { ok: false, error: "lines 里要有至少一句话" };
        if (!(await host.quota("podcast", Number(host.cfg("podcast_daily"))))) return { ok: false, error: "今天做音频节目的次数用完了" };
        const A = pickVoice(a.voices?.A), B = pickVoice(a.voices?.B ?? a.voices?.A);
        const job: PodcastJob = { lines, voices: { A: A.id, B: B.id }, rate: speedRate(a.speed), pause: Math.min(1.5, Math.max(0, Number.isFinite(Number(a.pause)) && a.pause !== undefined ? Number(a.pause) : 0.4)) };
        const files = { ...podcastTexts(job), "pbuild.sh": podcastScript(job) };
        let out;
        try { out = await host.computer({ commands: podcastCommands(job), files: [{ name: "pjob.json", bytes: new TextEncoder().encode(JSON.stringify(files)) }], collect: ["pod/show.mp3"], timeoutSeconds: 900 }); }
        catch (e) { return timeFail(e); }
        const failed = out.steps.find(st => st.exit !== 0), last = out.steps[out.steps.length - 1]?.stdout || "";
        const audio = out.files.find(f => f.name.endsWith("show.mp3"));
        if (!out.ok || !audio) return { ok: false, error: "音频没做成：" + (out.error || (failed ? failed.stdout.slice(-300) + failed.stderr.slice(-400) : "没有产出")).slice(0, 700) };
        const seconds = Math.round(num(/duration=([\d.]+)/, last) * 10) / 10;
        return { ok: true, title: String(a.title || ""), seconds, size_mb: Math.round(audio.bytes.length / 1048576 * 100) / 100, voices: { A: A.label, B: B.label }, lines: lines.length, ...(await sendOut(safeName(a.title, "mp3"), audio.bytes, false, a.deliver !== false)) };
      },
    },
  ];
}

const feature: Feature = {
  name: "voice",
  tools,
  tunables: {
    narrate_daily: { default: 10, min: 0, max: 60, what: "每天最多做几个配音讲解视频" },
    podcast_daily: { default: 6, min: 0, max: 60, what: "每天最多做几期音频节目" },
  },
  about: [
    "配音用的是微软 Edge 的免费朗读服务，有普通话男女声、东北话、陕西话、粤语、台湾腔，不花钱。",
    "做讲解视频（narrate）：几张图加每张图的旁白，在云电脑里配音、做缓慢推拉的画面、烧字幕、合成 720p 的 MP4，一般一到三分钟，不超过 20 MB。",
    "做音频节目（podcast）：一个人或两个人对话的稿子，每句用指定的声音念，拼成一个 MP3 发成文件。",
    "做视频和音频节目都要用云电脑，占每月的云电脑额度；每天最多做的个数群里可以调（narrate_daily、podcast_daily）。",
  ],
};
export default feature;
