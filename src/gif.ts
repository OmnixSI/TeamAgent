/**
 * Minimal GIF first-frame reader. Vision providers get a still PNG instead of
 * an animated GIF, so a sticker never depends on provider-specific GIF support.
 * No dependency: GIF LZW + a small PNG writer using CompressionStream.
 */
export type RgbaFrame = { width: number; height: number; data: Uint8Array };

function u16(b: Uint8Array, p: number) {
  return b[p] | (b[p + 1] << 8);
}

function subBlocks(b: Uint8Array, p: number) {
  const parts: Uint8Array[] = [];
  while (p < b.length) {
    const n = b[p++];
    if (n === 0) break;
    if (p + n > b.length) return null;
    parts.push(b.subarray(p, p + n));
    p += n;
  }
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return { data: out, next: p };
}

function lzw(data: Uint8Array, minCode: number, expected: number): Uint8Array | null {
  if (minCode < 2 || minCode > 11) return null;
  const clear = 1 << minCode, end = clear + 1;
  let dict: number[][] = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < clear; i++) dict[i] = [i];
    dict[clear] = [];
    dict[end] = [];
  };
  reset();
  let codeSize = minCode + 1, next = end + 1, bit = 0, prev: number[] | null = null;
  const out = new Uint8Array(expected);
  let at = 0;
  const read = () => {
    if (bit + codeSize > data.length * 8) return -1;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      code |= ((data[bit >> 3] >> (bit & 7)) & 1) << i;
      bit++;
    }
    return code;
  };
  while (at < expected) {
    const code = read();
    if (code < 0 || code === end) break;
    if (code === clear) { reset(); codeSize = minCode + 1; next = end + 1; prev = null; continue; }
    let entry: number[] | null = null;
    if (code < next && dict[code]) entry = dict[code];
    else if (code === next && prev) entry = [...prev, prev[0]];
    if (!entry) return null;
    for (const value of entry) { if (at >= expected) break; out[at++] = value; }
    if (prev) {
      dict[next++] = [...prev, entry[0]];
      if (next === (1 << codeSize) && codeSize < 12) codeSize++;
    }
    prev = entry;
  }
  return at === expected ? out : null;
}

export function decodeGifFirstFrame(b: Uint8Array): RgbaFrame | null {
  if (b.length < 13) return null;
  const sig = String.fromCharCode(...b.subarray(0, 6));
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  const width = u16(b, 6), height = u16(b, 8), packed = b[10];
  if (!width || !height) return null;
  let p = 13;
  let palette: Uint8Array | null = null;
  if (packed & 0x80) {
    const n = 3 * (1 << ((packed & 7) + 1));
    if (p + n > b.length) return null;
    palette = b.subarray(p, p + n);
    p += n;
  }
  let transparent = -1;
  while (p < b.length) {
    const tag = b[p++];
    if (tag === 0x3b) return null;
    if (tag === 0x21) {
      if (p >= b.length) return null;
      const label = b[p++];
      if (label === 0xf9) {
        const size = b[p++];
        if (size !== 4 || p + 5 > b.length) return null;
        const flags = b[p];
        transparent = flags & 1 ? b[p + 3] : -1;
        p += 4;
        if (b[p++] !== 0) return null;
      } else {
        const blocks = subBlocks(b, p);
        if (!blocks) return null;
        p = blocks.next;
      }
      continue;
    }
    if (tag !== 0x2c) return null;
    if (p + 9 > b.length) return null;
    const left = u16(b, p), top = u16(b, p + 2), w = u16(b, p + 4), h = u16(b, p + 6), flags = b[p + 8];
    p += 9;
    if (!w || !h) return null;
    let local: Uint8Array | null = null;
    if (flags & 0x80) {
      const n = 3 * (1 << ((flags & 7) + 1));
      if (p + n > b.length) return null;
      local = b.subarray(p, p + n);
      p += n;
    }
    if (p >= b.length) return null;
    const minCode = b[p++];
    const blocks = subBlocks(b, p);
    if (!blocks) return null;
    const table = local || palette;
    if (!table) return null;
    const indices = lzw(blocks.data, minCode, w * h);
    if (!indices) return null;
    const out = new Uint8Array(width * height * 4);
    const interlace = !!(flags & 0x40);
    const rows: number[] = [];
    if (!interlace) for (let y = 0; y < h; y++) rows.push(y);
    else for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
    for (let i = 0; i < indices.length; i++) {
      const index = indices[i], row = rows[Math.floor(i / w)], col = i % w;
      const x = left + col, y = top + row;
      if (x >= width || y >= height) continue;
      const at = (y * width + x) * 4;
      if (index === transparent) { out[at + 3] = 0; continue; }
      const c = index * 3;
      if (c + 2 >= table.length) continue;
      out[at] = table[c]; out[at + 1] = table[c + 1]; out[at + 2] = table[c + 2]; out[at + 3] = 255;
    }
    return { width, height, data: out };
  }
  return null;
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n: number) {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}
function chunk(type: string, data: Uint8Array) {
  const name = new TextEncoder().encode(type);
  const body = new Uint8Array(name.length + data.length);
  body.set(name); body.set(data, name.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length)); out.set(body, 4); out.set(u32(crc32(body)), 4 + body.length);
  return out;
}

export async function gifFirstFramePng(b: Uint8Array): Promise<Uint8Array | null> {
  const frame = decodeGifFirstFrame(b);
  if (!frame) return null;
  const raw = new Uint8Array((frame.width * 4 + 1) * frame.height);
  for (let y = 0; y < frame.height; y++) {
    const row = y * (frame.width * 4 + 1);
    raw[row] = 0;
    raw.set(frame.data.subarray(y * frame.width * 4, (y + 1) * frame.width * 4), row + 1);
  }
  const stream = new CompressionStream("deflate");
  const writer = stream.writable.getWriter();
  await writer.write(raw);
  await writer.close();
  const compressed = new Uint8Array(await new Response(stream.readable).arrayBuffer());
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(frame.width), 0); ihdr.set(u32(frame.height), 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", new Uint8Array()),
  ];
  const total = parts.reduce((n, part) => n + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
