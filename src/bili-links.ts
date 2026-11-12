/** Walk unknown QQ card wrappers without promoting quoted media to the sender. */
export function scanBiliPayload(raw: unknown) {
  const biliUrls = new Set<string>(), quotedBiliUrls = new Set<string>();
  const cards: any[] = [], quotedCards: any[] = [];
  function visit(value: any, quoted = false, card = false, depth = 0) {
    if (depth > 32 || value == null) return;
    if (typeof value === 'string') {
      if (/^\s*[\[{"]/.test(value)) {
        try { const parsed = JSON.parse(value); if (parsed !== value) { visit(parsed, quoted, card, depth + 1); return; } } catch {}
      }
      let text = value.replace(/\\u002f/gi, '/');
      for (let i = 0; i < 4 && text.includes('\\/'); i++) text = text.replace(/\\\//g, '/');
      const urls = quoted ? quotedBiliUrls : biliUrls;
      const accept = (url: string) => {
        try { const u = new URL(url); if (!u.username && !u.password && ['http:','https:'].includes(u.protocol) && (u.hostname === 'b23.tv' || u.hostname === 'bilibili.com' || u.hostname.endsWith('.bilibili.com'))) urls.add(u.href); } catch {}
      };
      const rest = text.replace(/(?:https?:\/\/|\/\/)[^\s"'<>\\\[\]()（）、，。；]+/gi, match => {
        accept((match.startsWith('//') ? 'https:' : '') + match.replace(/[.,;!?]+$/, '')); return ' ';
      }).replace(/(?<![A-Za-z0-9_.-])(?:[A-Za-z0-9-]+\.)*(?:b23\.tv|bilibili\.com)\/[^\s"'<>\\\[\]()（）、，。；]+/gi, match => {
        accept('https://' + match.replace(/[.,;!?]+$/, '')); return ' ';
      });
      for (const match of rest.matchAll(/(?<![A-Za-z0-9])BV[0-9A-Za-z]{10}(?![A-Za-z0-9])/g))
        urls.add('https://www.bilibili.com/video/' + match[0]);
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
