/**
 * Public, read-only readers for Weibo / Zhihu / Douyin / WeChat articles.
 *
 * Command semantics and response field names were informed by OpenCLI
 * (Apache-2.0, commit 9bc5f5ca132ec4d4e48d7ee517d4303bf159e8e8,
 * docs/adapters/browser/{weibo,zhihu,douyin}.md). No OpenCLI source code is
 * copied. See NOTICE.
 *
 * Boundaries: fixed https endpoints, whitelisted hosts, at most six short-link
 * redirects, one short-lived process per request, no cookies, no media download
 * and no write action. The caller never supplies an executable or argv.
 */
import {fileURLToPath} from 'node:url';
import {CHANNELS, validTarget} from '../src/reach-contract.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const MAX_BODY = 4 * 1024 * 1024;
const TIMEOUT_MS = 20000;
const MAX_LIMIT = 10;

export class ReachError extends Error {
  constructor(code, stage) {
    super(code);
    this.code = code;
    this.stage = stage;
  }
}

const fail = (code, stage) => ({ok: false, error: {code, ...(stage ? {stage} : {})}});
const insufficient = stage => ({ok: false, error: {error_kind: 'insufficient_content', ...(stage ? {stage} : {})}});
const asLimit = value => Math.min(MAX_LIMIT, Math.max(1, Number(value) || MAX_LIMIT));
const limitOf = target => /^\d{1,2}$/.test(String(target ?? '').trim()) ? asLimit(target) : MAX_LIMIT;
const textOf = (html, re) => {
  const m = String(html || '').match(re);
  return m ? cleanText(m[1]) : '';
};
const metaOf = (html, name) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<meta[^>]+(?:name|property)=["']${esc}["'][^>]+content=["']([^"']*)["']`, 'i');
  const alt = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${esc}["']`, 'i');
  return cleanText((String(html || '').match(re) || String(html || '').match(alt) || [])[1] || '');
};

export function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

export function htmlToText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|li|h[1-6]|blockquote|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\u200b|\ufeff/g, '')
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanText(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractJsonAssignment(html, marker) {
  const source = String(html || '');
  const at = source.indexOf(marker);
  if (at < 0) return null;
  let i = source.indexOf('{', at + marker.length);
  if (i < 0) return null;
  const start = i;
  let depth = 0, quote = '', escape = false;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function findDouyinDetail(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value.aweme_detail) {
    const item = parseDouyinDetail(value.aweme_detail);
    if (item) return item;
  }
  for (const child of Object.values(value)) {
    const found = findDouyinDetail(child, seen);
    if (found) return found;
  }
  return null;
}

function webZhihuUrl(value) {
  const raw = String(value ?? '');
  const q = raw.match(/^https?:\/\/api\.zhihu\.com\/questions\/(\d+)/i);
  if (q) return 'https://www.zhihu.com/question/' + q[1];
  const a = raw.match(/^https?:\/\/api\.zhihu\.com\/answers\/(\d+)/i);
  if (a) return 'https://www.zhihu.com/answer/' + a[1];
  if (/^https:\/\//i.test(raw)) return raw;
  if (/^http:\/\//i.test(raw)) return raw.replace(/^http:/i, 'https:');
  return '';
}

const iso = seconds => Number.isFinite(Number(seconds)) && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toISOString() : null;

/* ------------------------------- Weibo ------------------------------- */

export function parseWeiboHot(raw, limit = MAX_LIMIT) {
  const data = raw?.data || {};
  const rows = [...(Array.isArray(data.realtime) ? data.realtime : []), ...(Array.isArray(data.hotgovs) ? data.hotgovs : [])];
  const seen = new Set(), items = [];
  for (const row of rows) {
    const word = cleanText(row?.word_scheme || row?.word || row?.name || '');
    if (!word || seen.has(word)) continue;
    seen.add(word);
    const heat = Number(row?.num);
    const label = cleanText(row?.label_name || '');
    items.push({
      title: word,
      text: word + (Number.isFinite(heat) && heat > 0 ? `（热度 ${heat}）` : '（置顶热搜）') + (label ? ` · ${label}` : ''),
      author: '微博热搜',
      source_url: 'https://s.weibo.com/weibo?q=' + encodeURIComponent(word),
      published_at: null,
    });
    if (items.length >= asLimit(limit)) break;
  }
  return items;
}

export function parseWeiboSearch(html, limit = MAX_LIMIT) {
  const source = String(html || '');
  const blocks = [...source.matchAll(/<div[^>]*class="[^"]*\bcard-wrap\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*\bcard-wrap\b|<\/body>|$)/gi)].map(m => m[0]);
  const items = [];
  for (const block of blocks) {
    const text = cleanText((block.match(/<p[^>]*(?:node-type="feed_list_content"|class="[^"]*\btxt\b[^"]*")[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '');
    if (!text) continue;
    const author = cleanText((block.match(/<a[^>]*class="[^"]*\bname\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i) || [])[1] || '');
    const href = (block.match(/href=["'](\/\/weibo\.com\/[^"']+)["']/i) || block.match(/href=["'](https:\/\/weibo\.com\/[^"']+)["']/i) || [])[1] || '';
    items.push({
      title: text.slice(0, 80),
      text,
      author,
      source_url: href ? (href.startsWith('//') ? 'https:' + href : href) : '',
      published_at: null,
    });
    if (items.length >= asLimit(limit)) break;
  }
  return items;
}

export function parseWeiboProfile(raw) {
  const user = raw?.data?.user;
  if (!user || typeof user !== 'object') return [];
  const name = cleanText(user.screen_name || user.name || '');
  const stats = [
    Number.isFinite(Number(user.followers_count)) ? `关注者 ${Number(user.followers_count)}` : '',
    Number.isFinite(Number(user.statuses_count)) ? `微博 ${Number(user.statuses_count)}` : '',
  ].filter(Boolean).join('，');
  const text = [cleanText(user.description || ''), stats, cleanText(user.verified_reason || '')].filter(Boolean).join('\n');
  if (!name && !text) return [];
  return [{
    title: name || '微博用户',
    text: text || name,
    author: name,
    source_url: user.profile_url || (user.id ? `https://weibo.com/u/${user.id}` : ''),
    published_at: null,
  }];
}

/* ------------------------------- Zhihu ------------------------------- */

export function parseZhihuHot(raw, limit = MAX_LIMIT) {
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  const items = [];
  for (const row of rows) {
    const target = row?.target || row;
    const title = cleanText(target?.title || '');
    const excerpt = cleanText(target?.excerpt || target?.description || '');
    if (!title && !excerpt) continue;
    items.push({
      title,
      text: excerpt || title,
      author: cleanText(target?.author?.name || ''),
      source_url: webZhihuUrl(target?.url || (target?.id ? `https://api.zhihu.com/questions/${target.id}` : '')),
      published_at: iso(target?.created_time),
    });
    if (items.length >= asLimit(limit)) break;
  }
  return items;
}

export function parseZhihuSearch(raw, limit = MAX_LIMIT) {
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  const items = [];
  for (const row of rows) {
    const object = row?.object || row;
    const title = cleanText(object?.title || object?.question?.title || '');
    const text = cleanText(object?.excerpt || object?.description || object?.content || '');
    if (!title && !text) continue;
    items.push({
      title,
      text: text || title,
      author: cleanText(object?.author?.name || ''),
      source_url: webZhihuUrl(object?.url || (object?.id ? `https://api.zhihu.com/answers/${object.id}` : '')),
      published_at: iso(object?.created_time),
    });
    if (items.length >= asLimit(limit)) break;
  }
  return items;
}

export function parseZhihuQuestion(raw) {
  const q = raw?.question || raw;
  if (!q || typeof q !== 'object') return null;
  const title = cleanText(q.title || '');
  const text = htmlToText(q.detail || q.excerpt || '');
  if (!title && !text) return null;
  return {
    title,
    text: [text, Number.isFinite(Number(q.answer_count)) ? `回答 ${Number(q.answer_count)}` : '', Number.isFinite(Number(q.follower_count)) ? `关注 ${Number(q.follower_count)}` : ''].filter(Boolean).join('\n'),
    author: cleanText(q.author?.name || ''),
    source_url: q.id ? `https://www.zhihu.com/question/${q.id}` : '',
    published_at: iso(q.created_time),
  };
}

export function parseZhihuAnswer(raw) {
  const a = raw?.answer || raw;
  if (!a || typeof a !== 'object') return null;
  const body = htmlToText(a.content || a.excerpt || '');
  if (!body) return null;
  const question = cleanText(a.question?.title || '');
  const qid = a.question?.id;
  return {
    title: question || cleanText(a.title || ''),
    text: [question ? `问题：${question}` : '', body, Number.isFinite(Number(a.voteup_count)) ? `赞同 ${Number(a.voteup_count)}` : '', Number.isFinite(Number(a.comment_count)) ? `评论 ${Number(a.comment_count)}` : ''].filter(Boolean).join('\n'),
    author: cleanText(a.author?.name || ''),
    source_url: qid ? `https://www.zhihu.com/question/${qid}/answer/${a.id}` : (a.id ? `https://www.zhihu.com/answer/${a.id}` : ''),
    published_at: iso(a.created_time),
  };
}

/* ------------------------------- Douyin ------------------------------- */

function dur(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? `时长 ${(ms / 1000).toFixed(1)} 秒` : '';
}

export function parseDouyinDetail(raw) {
  const d = raw?.aweme_detail || raw?.item_list?.[0] || raw?.data?.aweme_detail || raw?.videoInfo?.aweme_detail || raw;
  if (!d || typeof d !== 'object') return null;
  const desc = cleanText(d.desc || d.description || '');
  const author = cleanText(d.author?.nickname || d.author?.name || '');
  if (!desc && !author) return null;
  const stats = d.statistics || {};
  const parts = [
    desc,
    author ? `作者：${author}` : '',
    Number.isFinite(Number(stats.digg_count)) ? `点赞 ${Number(stats.digg_count)}` : '',
    Number.isFinite(Number(stats.comment_count)) ? `评论 ${Number(stats.comment_count)}` : '',
    Number.isFinite(Number(stats.share_count)) ? `分享 ${Number(stats.share_count)}` : '',
    dur(d.video?.duration),
    d.music?.title ? `音乐：${cleanText(d.music.title)}` : '',
  ].filter(Boolean);
  const id = String(d.aweme_id || '');
  return {
    title: author ? `${author}的抖音作品` : desc.slice(0, 80),
    text: parts.join('\n'),
    author,
    source_url: id ? `https://www.douyin.com/video/${id}` : '',
    published_at: iso(d.create_time),
  };
}

export function parseDouyinPage(html) {
  for (const marker of ['window._ROUTER_DATA', 'window._SSR_DATA']) {
    const value = extractJsonAssignment(html, marker);
    const item = value ? findDouyinDetail(value) : null;
    if (item) return item;
  }
  const description = metaOf(html, 'og:description') || metaOf(html, 'description');
  const title = metaOf(html, 'og:title') || textOf(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  if (description && !/在抖音记录美好生活|于\d{8}发布在抖音|抖音，记录美好生活/.test(description)) {
    return {
      title,
      text: description,
      author: '',
      source_url: '',
      published_at: null,
    };
  }
  return null;
}

/* ------------------------------- Weixin ------------------------------- */

function extractElementInner(html, id) {
  const source = String(html || '');
  const at = source.search(new RegExp(`id=["']${id}["']`, 'i'));
  if (at < 0) return '';
  const open = source.indexOf('>', at);
  if (open < 0) return '';
  let depth = 1, i = open + 1;
  while (i < source.length && depth > 0) {
    const nextOpen = source.indexOf('<div', i);
    const nextClose = source.indexOf('</div', i);
    if (nextClose < 0) break;
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 4;
    } else {
      depth--;
      if (depth === 0) return source.slice(open + 1, nextClose);
      i = nextClose + 5;
    }
  }
  return source.slice(open + 1);
}

export function parseWechatArticle(html) {
  const title = textOf(html, /id=["']activity-name["'][^>]*>([\s\S]*?)<\/h1>/i);
  const author = textOf(html, /id=["']js_name["'][^>]*>([\s\S]*?)<\/a>/i)
    || cleanText((String(html || '').match(/var\s+nickname\s*=\s*["']([^"']*)["']/) || [])[1] || '');
  const ct = Number((String(html || '').match(/var\s+(?:ct|create_time)\s*=\s*["']?(\d{9,})["']?/) || [])[1] || 0);
  const text = htmlToText(extractElementInner(html, 'js_content'));
  if (text.length < 20) return null;
  return {
    title,
    text,
    author,
    source_url: '',
    published_at: iso(ct),
  };
}

/* ------------------------------- HTTP ------------------------------- */

const headersFor = channel => channel === 'weibo'
  ? {'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://weibo.com/', 'Accept-Language': 'zh-CN,zh;q=0.9'}
  : channel === 'zhihu'
    ? {'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: 'https://www.zhihu.com/', 'Accept-Language': 'zh-CN,zh;q=0.9', 'x-requested-with': 'fetch'}
    : channel === 'douyin'
      ? {'User-Agent': MOBILE_UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8', Referer: 'https://www.douyin.com/', 'Accept-Language': 'zh-CN,zh;q=0.9'}
      : {'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', Referer: 'https://mp.weixin.qq.com/', 'Accept-Language': 'zh-CN,zh;q=0.9'};

function allowedHost(host, channel) {
  const info = CHANNELS[channel];
  return !!info && (info.hosts.includes(host) || info.short.includes(host));
}

async function readLimited(response, max = MAX_BODY) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const chunks = [];
  let total = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      try { await reader.cancel(); } catch {}
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function getPage(url, {channel, fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxHops = 0, follow = true} = {}) {
  let current = new URL(url);
  for (let hop = 0; ; hop++) {
    if (!allowedHost(current.hostname, channel)) throw new ReachError('BAD_INPUT', 'redirect_host');
    let response;
    try {
      response = await fetchImpl(current.href, {method: 'GET', redirect: 'manual', headers: headersFor(channel), signal: AbortSignal.timeout(timeoutMs)});
    } catch (e) {
      if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new ReachError('TIMEOUT', 'fetch');
      throw new ReachError('UPSTREAM_BROKEN', 'fetch');
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location') || '';
      try { await response.body?.cancel?.(); } catch {}
      if (!follow) return {status: response.status, headers: response.headers, body: '', url: current.href};
      if (!location) throw new ReachError('BAD_INPUT', 'redirect_missing');
      if (/wappoc_appmsgcaptcha|captcha|challenge/i.test(location)) return {status: 403, headers: response.headers, body: 'captcha', url: current.href};
      if (hop >= maxHops) {
        // A login wall is a result, not an unbounded redirect chain.
        if (/passport|login|signin/i.test(location)) return {status: 302, headers: response.headers, body: '', url: current.href};
        throw new ReachError('BAD_INPUT', 'redirect_limit');
      }
      current = new URL(location, current);
      continue;
    }
    return {status: response.status, headers: response.headers, body: await readLimited(response), url: current.href};
  }
}

export function classifyResponse({status, body = '', headers}, channel) {
  const location = headers?.get?.('location') || '';
  if (status === 302 && /passport|login|signin/i.test(location)) return 'NEED_LOGIN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 401) return 'NEED_LOGIN';
  if (status === 412) return 'SECURITY_BLOCK';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 403) {
    if (/need_login|身份未经过验证|请先登录|登录后(?:继续|查看|阅读)|sign in to/i.test(body)) return 'NEED_LOGIN';
    return 'SECURITY_BLOCK';
  }
  if (status >= 500) return 'UPSTREAM_BROKEN';
  if (/Sina Visitor System|passport\.weibo\.com\/visitor/i.test(body)) return 'NEED_LOGIN';
  if (/"ok"\s*:\s*-100|passport\.weibo\.com|weibo\.com\/login\.php/i.test(body)) return 'NEED_LOGIN';
  if (/人机验证|验证码|captcha|安全验证|异常风险|SECURITY_BLOCK|ArgusSecurityPlugin|访问触发保护|环境异常/i.test(body)) return 'SECURITY_BLOCK';
  if (/该内容已被发布者删除|此内容因违规无法查看|文章已删除|内容不存在|该作品已删除|Page Not Found/i.test(body)) return 'NOT_FOUND';
  return null;
}

export async function resolveShortLink(start, {fetchImpl = fetch, maxHops = 6, timeoutMs = TIMEOUT_MS} = {}) {
  const page = await getPage(start, {channel: 'douyin', fetchImpl, timeoutMs, maxHops});
  return page.url;
}

/* ------------------------------- Dispatchers ------------------------------- */

async function weiboAction(req, opts) {
  if (req.action === 'hot') {
    const page = await getPage('https://weibo.com/ajax/side/hotSearch', {channel: 'weibo', ...opts});
    const kind = classifyResponse(page, 'weibo');
    if (kind) return fail(kind, 'http');
    let raw;
    try { raw = JSON.parse(page.body); } catch { return fail('UPSTREAM_BROKEN', 'parse'); }
    if (raw?.ok !== 1) return fail('NEED_LOGIN', 'api');
    const items = parseWeiboHot(raw, limitOf(req.target));
    return items.length ? {ok: true, items} : insufficient('empty');
  }
  if (req.action === 'search') {
    const target = String(req.target || '').trim();
    if (!target) return fail('BAD_INPUT', 'target');
    const page = await getPage('https://s.weibo.com/weibo?q=' + encodeURIComponent(target), {channel: 'weibo', ...opts});
    const kind = classifyResponse(page, 'weibo');
    if (kind) return fail(kind, 'http');
    const items = parseWeiboSearch(page.body, MAX_LIMIT);
    return items.length ? {ok: true, items} : insufficient('empty');
  }
  if (req.action === 'profile') {
    const uid = String(req.target || '').trim();
    if (!/^\d{1,20}$/.test(uid)) return fail('BAD_INPUT', 'target');
    const page = await getPage('https://weibo.com/ajax/profile/info?uid=' + encodeURIComponent(uid), {channel: 'weibo', ...opts, follow: false});
    if (page.status === 302) return fail('NEED_LOGIN', 'redirect');
    const kind = classifyResponse(page, 'weibo');
    if (kind) return fail(kind, 'http');
    let raw;
    try { raw = JSON.parse(page.body); } catch { return fail('UPSTREAM_BROKEN', 'parse'); }
    const items = parseWeiboProfile(raw);
    return items.length ? {ok: true, items} : insufficient('empty');
  }
  return fail('BAD_INPUT', 'action');
}

async function zhihuAction(req, opts) {
  if (req.action === 'hot') {
    const page = await getPage('https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=' + MAX_LIMIT, {channel: 'zhihu', ...opts});
    const kind = classifyResponse(page, 'zhihu');
    if (kind) return fail(kind, 'http');
    let raw;
    try { raw = JSON.parse(page.body); } catch { return fail('UPSTREAM_BROKEN', 'parse'); }
    const items = parseZhihuHot(raw, MAX_LIMIT);
    return items.length ? {ok: true, items} : insufficient('empty');
  }
  if (req.action === 'search') {
    const target = String(req.target || '').trim();
    if (!target) return fail('BAD_INPUT', 'target');
    const page = await getPage('https://www.zhihu.com/api/v4/search_v3?t=general&q=' + encodeURIComponent(target) + '&correction=1&offset=0&limit=' + MAX_LIMIT, {channel: 'zhihu', ...opts});
    const kind = classifyResponse(page, 'zhihu');
    if (kind) return fail(kind, 'http');
    let raw;
    try { raw = JSON.parse(page.body); } catch { return fail('UPSTREAM_BROKEN', 'parse'); }
    const items = parseZhihuSearch(raw, MAX_LIMIT);
    return items.length ? {ok: true, items} : insufficient('empty');
  }
  if (req.action === 'read') {
    const parsed = new URL(req.target);
    const answer = parsed.pathname.match(/\/answer\/(\d+)/) || parsed.pathname.match(/^\/answer\/(\d+)/);
    const question = parsed.pathname.match(/\/question\/(\d+)/) || parsed.pathname.match(/^\/question\/(\d+)/);
    if (!answer && !question) return fail('BAD_INPUT', 'target');
    const api = answer
      ? 'https://www.zhihu.com/api/v4/answers/' + answer[1] + '?include=content,excerpt,author,created_time,voteup_count,comment_count,question'
      : 'https://www.zhihu.com/api/v4/questions/' + question[1] + '?include=detail,excerpt,author,created_time,answer_count,follower_count';
    const page = await getPage(api, {channel: 'zhihu', ...opts});
    const kind = classifyResponse(page, 'zhihu');
    if (kind) return fail(kind, 'http');
    let raw;
    try { raw = JSON.parse(page.body); } catch { return fail('UPSTREAM_BROKEN', 'parse'); }
    const item = answer ? parseZhihuAnswer(raw) : parseZhihuQuestion(raw);
    return item ? {ok: true, items: [item]} : insufficient('empty');
  }
  return fail('BAD_INPUT', 'action');
}

async function douyinAction(req, opts) {
  let target = String(req.target || '');
  const host = new URL(target).hostname;
  if (host === 'v.douyin.com') {
    target = await resolveShortLink(target, {fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs, maxHops: 6});
    if (new URL(target).hostname === 'www.douyin.com' && new URL(target).pathname === '/') return fail('NOT_FOUND', 'short_link');
  }
  const parsed = new URL(target);
  const match = parsed.pathname.match(/\/(?:share\/)?(?:video|note)\/(\d+)/);
  if (!match) return fail('BAD_INPUT', 'target');
  const id = match[1], note = /\/note\//.test(parsed.pathname);
  const api = 'https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=' + id;
  const apiPage = await getPage(api, {channel: 'douyin', ...opts});
  if (apiPage.status === 200 && apiPage.body.trim()) {
    try {
      const raw = JSON.parse(apiPage.body);
      const item = parseDouyinDetail(raw);
      if (item) return {ok: true, items: [item]};
    } catch {}
  }
  const page = await getPage(`https://www.iesdouyin.com/share/${note ? 'note' : 'video'}/${id}/`, {channel: 'douyin', ...opts});
  const kind = classifyResponse(page, 'douyin');
  if (kind) return fail(kind, 'http');
  const item = parseDouyinPage(page.body);
  // A share page may embed related videos; only accept the requested aweme id.
  if (item && (!item.source_url || item.source_url.endsWith('/' + id))) return {ok: true, items: [item]};
  if (/encrypt_data_miss|ArgusSecurityPlugin/i.test(apiPage.body + page.body)) return fail('SECURITY_BLOCK', 'detail');
  return insufficient('empty');
}

async function weixinAction(req, opts) {
  const parsed = new URL(req.target);
  if (parsed.hostname !== 'mp.weixin.qq.com' || !/^\/s(?:\/|$)/.test(parsed.pathname)) return fail('BAD_INPUT', 'target');
  const page = await getPage(req.target, {channel: 'weixin', ...opts, maxHops: 2});
  if (/id=["']js_content["']/i.test(page.body)) {
    const item = parseWechatArticle(page.body);
    return item ? {ok: true, items: [item]} : insufficient('empty');
  }
  const kind = classifyResponse(page, 'weixin');
  if (kind) return fail(kind, 'http');
  if (/请在微信客户端打开|登录后(?:继续|查看|阅读)|请先登录/.test(page.body)) return fail('NEED_LOGIN', 'wall');
  return insufficient('empty');
}

export async function runPublicRead(req, {fetchImpl = fetch, timeoutMs = TIMEOUT_MS} = {}) {
  if (!req || typeof req !== 'object') return fail('BAD_INPUT', 'request');
  const {channel, action, target} = req;
  if (!validTarget(channel, action, target)) return fail('BAD_INPUT', 'validate');
  const opts = {fetchImpl, timeoutMs};
  try {
    if (channel === 'weibo') return await weiboAction(req, opts);
    if (channel === 'zhihu') return await zhihuAction(req, opts);
    if (channel === 'douyin') return await douyinAction(req, opts);
    if (channel === 'weixin') return await weixinAction(req, opts);
    return fail('BAD_INPUT', 'channel');
  } catch (e) {
    if (e instanceof ReachError) return fail(e.code, e.stage);
    return fail('UPSTREAM_BROKEN', 'exception');
  }
}

/* ------------------------------- CLI ------------------------------- */

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [channel, action, target] = process.argv.slice(2);
  const result = await runPublicRead({channel, action, target});
  process.stdout.write(JSON.stringify(result));
}
