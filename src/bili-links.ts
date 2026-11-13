export const SHORT_HOSTS = new Set(['b23.tv','bili2233.cn']);
export const SHORT_CODE = /^[0-9A-Za-z_-]{4,32}$/;
export type BiliTarget = { kind: 'bv' | 'aid' | 'short' | 'title'; base: string; page: number };
/** Decode percent escapes twice at most; a broken layer keeps the previous value. */
export function safeDecode(s: string): string {
  let value = s;
  for (let i = 0; i < 2; i++) {
    let next: string;
    try { next = decodeURIComponent(value); } catch { break; }
    if (next === value) break;
    value = next;
  }
  return value;
}
function pageOf(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= 999 ? page : 1;
}
function bareTarget(text: string): BiliTarget | null {
  const bv = text.match(/^(BV[0-9A-Za-z]{10})(?:\?([^#]*))?$/);
  if (bv) return {kind:'bv', base:bv[1], page:pageOf(new URLSearchParams(bv[2] || '').get('p'))};
  const aid = text.match(/^av(\d{1,12})(?:\?([^#]*))?$/i);
  if (aid) return {kind:'aid', base:'av' + aid[1], page:pageOf(new URLSearchParams(aid[2] || '').get('p'))};
  return null;
}
/** Parse a Bilibili URL, a scheme-less card link or a bare BV/av ref. */
export function parseBiliTarget(value: string): BiliTarget | null {
  const text = safeDecode(String(value ?? '')).trim();
  if (!text) return null;
  const candidate = text.startsWith('//') ? 'https:' + text : text;
  let url: URL | null = null;
  try { url = new URL(candidate); } catch {
    if (/^(?:[A-Za-z0-9-]+\.)*(?:b23\.tv|bili2233\.cn|bilibili\.com)\//i.test(candidate)) {
      try { url = new URL('https://' + candidate); } catch {}
    }
  }
  if (!url) return bareTarget(text);
  if (url.username || url.password || !['http:','https:'].includes(url.protocol)) return null;
  if (SHORT_HOSTS.has(url.hostname)) {
    const short = url.pathname.split('/').filter(Boolean)[0];
    return short && /^[0-9A-Za-z_-]+$/.test(short) ? {kind:'short', base:short, page:0} : null;
  }
  if (url.hostname !== 'bilibili.com' && !url.hostname.endsWith('.bilibili.com')) return null;
  const bvid = url.pathname.match(/\bBV[0-9A-Za-z]{10}\b/)?.[0] || url.searchParams.get('bvid')?.match(/^BV[0-9A-Za-z]{10}$/)?.[0];
  if (bvid) return {kind:'bv', base:bvid, page:pageOf(url.searchParams.get('p'))};
  const aid = url.pathname.match(/\bav(\d{1,12})\b/i)?.[1] || url.searchParams.get('aid')?.match(/^(?:av)?(\d{1,12})$/i)?.[1];
  if (aid) return {kind:'aid', base:'av' + aid, page:pageOf(url.searchParams.get('p'))};
  return null;
}
/** Walk unknown QQ card wrappers without promoting quoted media to the sender. */
export function scanBiliPayload(raw: unknown) {
  const biliUrls = new Set<string>(), quotedBiliUrls = new Set<string>();
  const cards: any[] = [], quotedCards: any[] = [];
  const accept = (urls: Set<string>, url: string) => {
    try { const u = new URL(url); if (!u.username && !u.password && ['http:','https:'].includes(u.protocol) && (SHORT_HOSTS.has(u.hostname) || u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'))) urls.add(u.href); } catch {}
  };
  const scanText = (text: string, urls: Set<string>) => {
    const rest = text.replace(/(?:https?:\/\/|\/\/)[^\s"'<>\\\[\]()（）、，。；]+/gi, match => {
      accept(urls, (match.startsWith('//') ? 'https:' : '') + match.replace(/[.,;!?]+$/, '')); return ' ';
    }).replace(/(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]+\.)*(?:b23\.tv|bili2233\.cn|bilibili\.com)\/[^\s"'<>\\\[\]()（）、，。；]+/gi, match => {
      accept(urls, 'https://' + match.replace(/[.,;!?]+$/, '')); return ' ';
    });
    for (const match of rest.matchAll(/(?<![A-Za-z0-9])BV[0-9A-Za-z]{10}(?![A-Za-z0-9])/g))
      urls.add('https://www.bilibili.com/video/' + match[0]);
  };
  function visit(value: any, quoted = false, card = false, depth = 0) {
    if (depth > 32 || value == null) return;
    if (typeof value === 'string') {
      if (/^\s*[\[{"]/.test(value)) {
        try { const parsed = JSON.parse(value); if (parsed !== value) { visit(parsed, quoted, card, depth + 1); return; } } catch {}
      }
      let text = value.replace(/\\u002f/gi, '/');
      for (let i = 0; i < 4 && text.includes('\\/'); i++) text = text.replace(/\\\//g, '/');
      const urls = quoted ? quotedBiliUrls : biliUrls;
      scanText(text, urls);
      const decoded = safeDecode(text);
      if (decoded !== text) scanText(decoded, urls);
      return;
    }
    if (Array.isArray(value)) { for (const entry of value) visit(entry, quoted, card, depth + 1); return; }
    if (typeof value !== 'object') return;
    if (typeof value.key === 'string' && ['preview','source_logo','attachments'].includes(value.key.toLowerCase())) return;
    if (card || value.ark_type || value.ark_name) (quoted ? quotedCards : cards).push(value);
    for (const [key, entry] of Object.entries(value)) {
      if (['preview','source_logo','attachments'].includes(key.toLowerCase())) continue;
      visit(entry, quoted || key === 'msg_elements' || key === 'quoted', key === 'ark_data', depth + 1);
    }
  }
  visit(raw);
  return {biliUrls:[...biliUrls],quotedBiliUrls:[...quotedBiliUrls],cards,quotedCards};
}
