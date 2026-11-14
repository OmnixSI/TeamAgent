// Site-specific readers. Three ways out to the internet:
//   direct  – from Cloudflare; fine for most of the world, refused by several Chinese sites
//   relay   – a small keyed function in Hong Kong (relay/), can carry login cookies
//   dsFetch – DeepSeek's own page reader, no cookies, good at public pages
import { dsJson } from "./llm.ts";
import { PRICE, meter } from "./meter.ts";
import { clip, unb64, b64 } from "./util.ts";
import type { Env } from "./util.ts";
import { X_BEARER_TOKEN, buildSearchTimelineRequest, formatTweetText, parseSearchTimeline, parseStatusId } from "./xgraphql.mjs";

export type Net = { env: Env & { RELAY_URL?: string; RELAY_KEY?: string }; cookie(site: string): string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

export async function relay(net: Net, req: { url: string; headers?: Record<string, string>; method?: string; body?: string; redirect?: string; max?: number }) {
  if (!net.env.RELAY_URL || !net.env.RELAY_KEY) throw new Error("中转没配置");
  const r = await fetch(net.env.RELAY_URL + "/api/fetch", {
    method: "POST", headers: { "Content-Type": "application/json", "x-relay-key": net.env.RELAY_KEY },
    body: JSON.stringify(req), signal: AbortSignal.timeout(32000),
  });
  const d: any = await r.json().catch(() => ({ status: 0, error: "relay http " + r.status }));
  const bytes = d.body ? unb64(d.body) : new Uint8Array();
  return { status: Number(d.status || 0), url: String(d.url || ""), location: d.location as string | null, type: String(d.type || ""), bytes, text: new TextDecoder().decode(bytes), error: d.error as string | undefined };
}
export async function dsFetch(env: Env, url: string) {
  for (let i = 0; i < 2; i++) {
    const r = await dsJson(env, "/v1/tools/fetch", { url }, 30000);
    if (r.ok) { const d: any = await r.json(); if (d.content) return { title: String(d.title || ""), content: String(d.content) }; }
  }
  throw new Error("页面读不出来");
}

export function htmlToText(html: string) {
  const pick = (re: RegExp) => (html.match(re)?.[1] || "").trim();
  const meta = [
    pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    pick(/<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']*)["']/i),
    pick(/<meta[^>]+(?:property|name)=["'](?:og:)?description["'][^>]+content=["']([^"']*)["']/i),
  ].filter(Boolean);
  const body = html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
  return { meta: [...new Set(meta)], body };
}

const RELAYED = /(^|\.)(bilibili\.com|xiaohongshu\.com|xhslink\.com|xhslink\.cn|rednote\.com|douyin\.com|iesdouyin\.com|weibo\.com|weibo\.cn|zhihu\.com|xueqiu\.com|weixin\.qq\.com)$/i;
const SITE_OF: [RegExp, string][] = [
  [/bilibili\.com|b23\.tv/, "bili"], [/xiaohongshu\.com|xhslink|rednote\.com/, "xhs"], [/douyin\.com/, "douyin"],
  [/weibo\.(com|cn)/, "weibo"], [/zhihu\.com/, "zhihu"], [/xueqiu\.com/, "xueqiu"],
];
export const siteOf = (host: string) => SITE_OF.find(([re]) => re.test(host))?.[1] || "";

/** Pages on sites that refuse Cloudflare: fetched through the relay with the saved login, as readable text. */
export async function readRelayed(net: Net, url: string) {
  const host = new URL(url).hostname;
  if (!RELAYED.test(host)) return null;
  const site = siteOf(host), cookie = net.cookie(site);
  const r = await relay(net, { url, headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", ...(cookie ? { Cookie: cookie } : {}) } });
  if (r.status !== 200 || r.bytes.length < 400) return null;
  if (/\/login|passport\.|signin|unhuman|captcha/i.test(r.url)) return { needLogin: site || host };
  const t = htmlToText(r.text);
  // Single-page apps keep the real content in an embedded state object.
  const state = r.text.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/)?.[1] || r.text.match(/<script id="js-initialData"[^>]*>([\s\S]*?)<\/script>/)?.[1] || "";
  const strings = state ? [...new Set([...state.matchAll(/"(?:title|desc|content|text|excerpt|nickname|name)":"((?:[^"\\]|\\.){8,})"/g)].map(m => m[1].replace(/\\n/g, "\n").replace(/\\u002F/g, "/").replace(/\\"/g, '"')))].slice(0, 60).join("\n") : "";
  const content = [t.meta.join("\n"), strings, t.body].filter(Boolean).join("\n\n");
  if (content.replace(/\s/g, "").length < 120) return null;
  return { title: t.meta[0] || "", content: clip(content, 16000), logged_in: !!cookie };
}

// ---------- Xiaohongshu (served as rednote.com outside mainland China; same notes, same account) ----------
export async function xhsNote(net: Net, url: string) {
  let target = url;
  if (/xhslink\.(com|cn)/.test(url)) {
    const r = await fetch(url, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    target = r.headers.get("location") || url;
  }
  const id = target.match(/\/(?:discovery\/item|explore|notes?)\/([0-9a-f]{24})/)?.[1];
  if (!id) return null;
  const cookie = net.cookie("xhs");
  const r = await relay(net, { url: target.replace(/\/\/www\.xiaohongshu\.com/, "//www.rednote.com"), headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9", ...(cookie ? { Cookie: cookie } : {}) } });
  if (/\/login/.test(r.url)) throw new Error("小红书要登录才能看这篇，保存的登录失效了，需要群主重新登录一次");
  const state = r.text.match(/window\.__INITIAL_STATE__\s*=\s*([\s\S]*?)<\/script>/)?.[1];
  if (!state) return null;
  let note: any;
  // The page state is a JavaScript literal, not strict JSON.
  try { note = JSON.parse(state.replace(/new (Set|Map)\(\[[^\]]*\]\)/g, "[]").replace(/([:\[,])\s*undefined/g, "$1null")).note?.noteDetailMap?.[id]?.note; } catch { return null; }
  if (!note) return null;
  return {
    title: note.title, author: note.user?.nickname, text: clip(note.desc || "", 6000), type: note.type,
    tags: (note.tagList || []).map((t: any) => t.name).slice(0, 12),
    stats: { likes: note.interactInfo?.likedCount, collects: note.interactInfo?.collectedCount, comments: note.interactInfo?.commentCount },
    images: (note.imageList || []).map((i: any) => i.urlDefault || i.url).filter(Boolean).slice(0, 6),
    published: note.time ? new Date(note.time).toISOString().slice(0, 10) : undefined,
  };
}

// ---------- Zhihu ----------
const strip = (html: string) => String(html || "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();
export async function zhihu(net: Net, url: string) {
  const cookie = net.cookie("zhihu");
  const api = async (path: string) => {
    const r = await relay(net, { url: "https://www.zhihu.com/api/v4" + path, headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) } });
    if (r.status === 401 || r.status === 403) throw new Error("知乎要登录才能看，保存的登录失效了");
    if (r.status !== 200) throw new Error("知乎返回 " + r.status);
    return JSON.parse(r.text);
  };
  const answer = url.match(/\/answer\/(\d+)/)?.[1], question = url.match(/\/question\/(\d+)/)?.[1], article = url.match(/zhuanlan\.zhihu\.com\/p\/(\d+)/)?.[1];
  if (answer) {
    const a = await api("/answers/" + answer + "?include=content,voteup_count,comment_count");
    return { question: a.question?.title, author: a.author?.name, votes: a.voteup_count, content: clip(strip(a.content), 12000) };
  }
  if (question) {
    const list = await api("/questions/" + question + "/answers?include=content,voteup_count&limit=4&sort_by=default");
    const first = list.data?.[0];
    return {
      question: first?.question?.title, answers_total: list.paging?.totals,
      top_answers: (list.data || []).map((a: any) => ({ author: a.author?.name, votes: a.voteup_count, content: clip(strip(a.content), 3500) })),
    };
  }
  if (article) {
    const a = await api("/articles/" + article);
    return { title: a.title, author: a.author?.name, votes: a.voteup_count, content: clip(strip(a.content), 12000) };
  }
  return null;
}

// ---------- Bilibili ----------
const biliHeaders = (cookie: string) => ({ "User-Agent": UA, Referer: "https://www.bilibili.com/", ...(cookie ? { Cookie: cookie } : {}) });

async function biliApi(net: Net, path: string): Promise<any> {
  const cookie = net.cookie("bili");
  try {
    const r = await relay(net, { url: "https://api.bilibili.com" + path, headers: biliHeaders(cookie) });
    if (r.status === 200) { const j = JSON.parse(r.text); if (j.code === 0) return j.data; if (![-412, -352, -101, -403].includes(j.code)) throw new Error("B 站返回：" + (j.message || j.code)); }
  } catch (e: any) { if (String(e?.message).startsWith("B 站返回")) throw e; }
  const d = await dsFetch(net.env, "https://api.bilibili.com" + path);
  const j = JSON.parse(d.content);
  if (j.code !== 0) throw new Error("B 站返回：" + (j.message || j.code));
  return j.data;
}
export async function biliResolve(input: string) {
  let text = input.trim();
  const short = text.match(/https?:\/\/(?:b23\.tv|bili2233\.cn)\/[0-9A-Za-z]+/)?.[0];
  if (short && !/BV[0-9A-Za-z]{10}/.test(text)) {
    const r = await fetch(short, { redirect: "manual", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
    text = r.headers.get("location") || text;
  }
  const page = Number(text.match(/[?&]p=(\d+)/)?.[1] || 1);
  const bv = text.match(/BV[0-9A-Za-z]{10}/)?.[0];
  if (bv) return { query: "bvid=" + bv, page };
  const av = text.match(/(?:\/|^)av(\d+)/i)?.[1];
  if (av) return { query: "aid=" + av, page };
  return null;
}
const stamp = (sec: number) => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");

export async function transcribe(env: Env, audio: Uint8Array, seconds = 0, type = "audio/mp4", name = "audio.m4a") {
  if (!env.OPENAI_API_KEY) throw new Error("没有配置转写用的 OpenAI 密钥");
  const form = new FormData();
  form.append("model", "gpt-4o-mini-transcribe");
  form.append("response_format", "json");
  form.append("file", new Blob([audio], { type }), name);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + env.OPENAI_API_KEY }, body: form, signal: AbortSignal.timeout(170000) });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || typeof d.text !== "string") throw new Error("转写失败（" + r.status + "）");
  // 64 kbit/s audio is about 480 KB a minute when the index gave no duration.
  const minutes = (seconds || audio.length / 8000) / 60;
  meter({ provider: "openai", item: "音频转文字", units: Math.round(minutes * 10) / 10, unit: "分钟", usd: minutes * PRICE.transcribePerMinute });
  return d.text as string;
}
async function range(url: string, from: number, to: number) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Referer: "https://www.bilibili.com/", Range: "bytes=" + from + "-" + to }, signal: AbortSignal.timeout(60000) });
  if (r.status !== 206 && r.status !== 200) throw new Error("音频下载被拒（" + r.status + "）");
  return new Uint8Array(await r.arrayBuffer());
}
/** Speech-to-text for a video without subtitles: split the audio track on its own index, transcribe pieces in parallel. */
async function biliTranscript(net: Net, query: string, cid: number, maxMinutes: number) {
  const play = await biliApi(net, "/x/player/playurl?" + query + "&cid=" + cid + "&fnval=16&fnver=0&fourk=0");
  const track = (play.dash?.audio || []).slice().sort((a: any, b: any) => a.bandwidth - b.bandwidth)[0];
  if (!track) throw new Error("这个视频拿不到音轨");
  const urls: string[] = [track.baseUrl || track.base_url, ...(track.backupUrl || track.backup_url || [])].filter(Boolean);
  const base = track.SegmentBase || track.segment_base || {};
  const init = String(base.Initialization || base.initialization || "0-999"), index = String(base.indexRange || base.index_range || "");
  let url = urls[0], head: Uint8Array | null = null;
  const headEnd = index ? Number(index.split("-")[1]) : 4000;
  for (const u of urls) { try { head = await range(u, 0, headEnd); url = u; break; } catch {} }
  if (!head) throw new Error("音频下载被拒");
  const initBytes = head.slice(0, Number(init.split("-")[1]) + 1);
  // sidx box: one entry per fragment with its byte size and duration.
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let o = index ? Number(index.split("-")[0]) : initBytes.length;
  const pieces: { from: number; to: number; start: number; dur: number }[] = [];
  if (String.fromCharCode(...head.slice(o + 4, o + 8)) === "sidx") {
    const size = view.getUint32(o), version = view.getUint8(o + 8), timescale = view.getUint32(o + 16);
    let p = o + 20, first = 0;
    if (version === 0) { first = view.getUint32(p + 4); p += 8; } else { first = Number(view.getBigUint64(p + 8)); p += 16; }
    const count = view.getUint16(p + 2); p += 4;
    let offset = o + size + first, at = 0, cur: { from: number; to: number; start: number; dur: number } | null = null;
    for (let i = 0; i < count && p + 12 <= head.length; i++, p += 12) {
      const bytes = view.getUint32(p) & 0x7fffffff, dur = view.getUint32(p + 4) / timescale;
      if (at >= maxMinutes * 60) break;
      if (!cur || cur.dur >= 600) { cur = { from: offset, to: offset + bytes - 1, start: at, dur: 0 }; pieces.push(cur); }
      cur.to = offset + bytes - 1; cur.dur += dur; offset += bytes; at += dur;
    }
  }
  if (!pieces.length) pieces.push({ from: initBytes.length, to: 18 * 1024 * 1024, start: 0, dur: 0 });
  const out: string[] = new Array(pieces.length).fill("");
  let next = 0;
  await Promise.all([0, 1, 2, 3].map(async () => {
    for (;;) {
      const i = next++; if (i >= pieces.length) return;
      const body = await range(url, pieces[i].from, pieces[i].to);
      const joined = new Uint8Array(initBytes.length + body.length); joined.set(initBytes); joined.set(body, initBytes.length);
      out[i] = "[" + stamp(pieces[i].start) + "] " + await transcribe(net.env, joined, pieces[i].dur).catch(e => "（这一段没转出来：" + e.message + "）");
    }
  }));
  return out.join("\n");
}

export async function biliVideo(net: Net, input: string, wantTranscript = true, maxMinutes = 60) {
  const ref = await biliResolve(input);
  if (!ref) throw new Error("没认出这是哪个 B 站视频，给个链接或 BV 号");
  const v = await biliApi(net, "/x/web-interface/view?" + ref.query);
  const part = v.pages?.[ref.page - 1] || v.pages?.[0] || { cid: v.cid, duration: v.duration };
  const q = "bvid=" + v.bvid;
  const info: any = {
    title: v.title, up: v.owner?.name, url: "https://www.bilibili.com/video/" + v.bvid, published: new Date(v.pubdate * 1000).toISOString().slice(0, 10),
    duration: stamp(part.duration || v.duration), parts: v.pages?.length || 1, desc: clip(v.desc || "", 600),
    stat: { view: v.stat?.view, like: v.stat?.like, coin: v.stat?.coin, favorite: v.stat?.favorite, danmaku: v.stat?.danmaku, reply: v.stat?.reply },
  };
  try {
    const hot = await biliApi(net, "/x/v2/reply?type=1&oid=" + v.aid + "&sort=2&ps=10");
    info.top_comments = (hot.replies || []).slice(0, 8).map((c: any) => (c.member?.uname || "") + "（赞" + c.like + "）：" + clip(c.content?.message || "", 160));
  } catch {}
  if (!wantTranscript) return info;
  try {
    const player = await biliApi(net, "/x/player/v2?" + q + "&cid=" + part.cid);
    const sub = (player.subtitle?.subtitles || []).find((s: any) => /zh/.test(s.lan)) || player.subtitle?.subtitles?.[0];
    if (sub?.subtitle_url) {
      const subUrl = (sub.subtitle_url.startsWith("//") ? "https:" : "") + sub.subtitle_url;
      let raw = await fetch(subUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) }).then(r => r.ok ? r.text() : "").catch(() => "");
      if (!raw) raw = (await relay(net, { url: subUrl, headers: { "User-Agent": UA } })).text;
      const lines: any[] = JSON.parse(raw).body || [], length = Number(part.duration || v.duration || 0);
      const end = lines.length ? Number(lines[lines.length - 1].to || lines[lines.length - 1].from || 0) : 0;
      // Bilibili sometimes hands back another video's subtitles. Subtitles that run past the end of the
      // video, or stop long before it, are not this video's: drop them and transcribe the audio instead.
      const fits = !length || (end <= length + 20 && (length < 90 || end >= length * 0.4));
      if (fits && lines.length) {
        let last = -100;
        info.transcript = clip(lines.map((b: any) => { const mark = b.from - last >= 30 ? "\n[" + stamp(b.from) + "] " : ""; if (mark) last = b.from; return mark + b.content; }).join(" ").trim(), 40000);
        info.transcript_source = "字幕";
      } else if (lines.length) info.subtitle_note = "B 站给的字幕对不上这条视频的时长（多半是串了别的视频），没采用，改用音轨转写";
    }
  } catch {}
  if (!info.transcript) {
    try {
      const minutes = Math.min(Math.ceil((part.duration || v.duration) / 60), maxMinutes);
      info.transcript = clip(await biliTranscript(net, q, part.cid, maxMinutes), 40000);
      info.transcript_source = "音轨转写" + ((part.duration || v.duration) > maxMinutes * 60 ? "（只转了前 " + maxMinutes + " 分钟）" : "（共 " + minutes + " 分钟）");
    } catch (e: any) { info.transcript_error = clip(e?.message || String(e), 160); }
  }
  return info;
}
export async function biliSearch(net: Net, keyword: string) {
  const d = await biliApi(net, "/x/web-interface/search/type?search_type=video&page=1&keyword=" + encodeURIComponent(keyword));
  return (d.result || []).slice(0, 10).map((x: any) => ({ title: String(x.title || "").replace(/<[^>]+>/g, ""), up: x.author, bvid: x.bvid, play: x.play, duration: x.duration, date: x.pubdate ? new Date(x.pubdate * 1000).toISOString().slice(0, 10) : undefined }));
}

// ---------- trending lists ----------
export async function hot(net: Net, source: string) {
  const cookie = (s: string) => net.cookie(s);
  switch (source) {
    case "weibo": {
      const r = await relay(net, { url: "https://weibo.com/ajax/side/hotSearch", headers: { "User-Agent": UA, Referer: "https://weibo.com/" } });
      return (JSON.parse(r.text).data?.realtime || []).slice(0, 30).map((x: any, i: number) => (i + 1) + ". " + x.word + (x.num ? "（" + x.num + "）" : ""));
    }
    case "douyin": {
      const r = await relay(net, { url: "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web", headers: { "User-Agent": UA, Referer: "https://www.douyin.com/" } });
      return (JSON.parse(r.text).data?.word_list || []).slice(0, 30).map((x: any, i: number) => (i + 1) + ". " + x.word + (x.hot_value ? "（" + x.hot_value + "）" : ""));
    }
    case "bilibili": {
      const d = await biliApi(net, "/x/web-interface/popular?ps=20");
      return (d.list || []).map((x: any, i: number) => (i + 1) + ". " + x.title + " — " + x.owner?.name + "，播放 " + x.stat?.view + "，" + x.bvid);
    }
    case "zhihu": {
      const r = await relay(net, { url: "https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=30", headers: { "User-Agent": UA, ...(cookie("zhihu") ? { Cookie: cookie("zhihu") } : {}) } });
      if (r.status !== 200) throw new Error("知乎热榜要登录后才能看，现在没有可用的知乎登录");
      return (JSON.parse(r.text).data || []).map((x: any, i: number) => (i + 1) + ". " + x.target?.title + (x.detail_text ? "（" + x.detail_text + "）" : ""));
    }
    case "baidu": {
      const r = await fetch("https://top.baidu.com/api/board?platform=wise&tab=realtime", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      const words: string[] = [];
      const walk = (o: any) => { if (!o || typeof o !== "object") return; if (typeof o.word === "string") words.push(o.word); for (const v of Object.values(o)) walk(v); };
      walk(await r.json());
      return [...new Set(words)].slice(0, 30).map((w, i) => (i + 1) + ". " + w);
    }
    case "github": {
      const html = await fetch("https://github.com/trending?since=daily", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) }).then(r => r.text());
      return html.split('<article class="Box-row">').slice(1, 26).map((a, i) => {
        const repo = (a.match(/<h2[\s\S]*?href="\/([^"]+)"/)?.[1] || "").trim();
        const desc = (a.match(/<p class="col-9[^>]*>([\s\S]*?)<\/p>/)?.[1] || "").replace(/<[^>]+>/g, "").trim();
        const lang = a.match(/itemprop="programmingLanguage">([^<]+)</)?.[1] || "";
        const today = a.match(/([\d,]+)\s+stars today/)?.[1] || "";
        return (i + 1) + ". " + repo + (lang ? " [" + lang + "]" : "") + (today ? " 今日+" + today : "") + (desc ? " — " + clip(desc, 140) : "");
      });
    }
    case "hackernews": {
      const d: any = await fetch("https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=25", { signal: AbortSignal.timeout(15000) }).then(r => r.json());
      return (d.hits || []).map((x: any, i: number) => (i + 1) + ". " + x.title + "（" + x.points + " 分，" + x.num_comments + " 评）" + (x.url ? " " + x.url : ""));
    }
  }
  throw new Error("source 只能是 weibo/douyin/bilibili/zhihu/baidu/github/hackernews");
}

// ---------- stocks (Tencent quotes: A shares, Hong Kong, US) ----------
export async function stock(query: string) {
  const text = async (url: string, charset: string) => new TextDecoder(charset).decode(await (await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) })).arrayBuffer());
  let symbols: string[] = [];
  for (const raw of query.split(/[,，\s]+/).filter(Boolean).slice(0, 6)) {
    if (/^(sh|sz|bj)\d{6}$/i.test(raw)) { symbols.push(raw.toLowerCase()); continue; }
    if (/^hk\d{5}$/i.test(raw)) { symbols.push(raw.toLowerCase()); continue; }
    const hint = await text("https://smartbox.gtimg.cn/s3/?v=2&t=all&q=" + encodeURIComponent(raw), "utf-8");
    const first = (hint.match(/v_hint="([^"]*)"/)?.[1] || "").split("^").map(e => e.split("~")).filter(e => e.length >= 5 && ["sh", "sz", "bj", "hk", "us"].includes(e[0]))
      .sort((x, y) => Number(y[4]?.startsWith("GP")) - Number(x[4]?.startsWith("GP")))[0];
    if (first) symbols.push(first[0] === "us" ? "us" + first[1].split(".")[0].toUpperCase() : first[0] + first[1]);
  }
  symbols = [...new Set(symbols)];
  if (!symbols.length) throw new Error("没找到这只股票，换个名字或直接给代码");
  const raw = await text("https://qt.gtimg.cn/q=" + symbols.join(","), "gbk");
  return [...raw.matchAll(/v_(\w+)="([^"]*)"/g)].map(m => {
    const f = m[2].split("~");
    return {
      symbol: m[1], name: f[1], code: f[2], price: f[3], change: f[31], change_pct: f[32] + "%", prev_close: f[4], open: f[5], high: f[33], low: f[34],
      volume: f[6], amount: f[37], turnover_pct: f[38], pe: f[39], market_cap: f[45], time: f[30],
    };
  });
}

// ---------- X ----------
export async function tweet(url: string) {
  const id = parseStatusId(url);
  if (!id) return null;
  const r = await fetch("https://api.fxtwitter.com/status/" + id, { headers: { "User-Agent": "teamagent/2 (group chat reader)" }, signal: AbortSignal.timeout(15000) });
  const d: any = await r.json().catch(() => ({}));
  const t = d.tweet;
  if (!r.ok || !t) return null;
  const one = (x: any) => ({
    author: x.author?.name + " @" + x.author?.screen_name, text: x.text, time: x.created_at,
    stats: { likes: x.likes, reposts: x.retweets, replies: x.replies, views: x.views },
    media: (x.media?.all || []).map((m: any) => m.type + " " + m.url).slice(0, 6),
  });
  const photos = (t.media?.photos || []).map((m: any) => m.url).filter(Boolean).slice(0, 4);
  return { ...one(t), ...(t.quote ? { quoted: one(t.quote) } : {}), url: t.url, ...(photos.length ? { images: photos } : {}) };
}
export async function xSearch(net: Net, query: string) {
  const cookie = net.cookie("x"), ct0 = cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
  if (!cookie || !ct0) throw new Error("没有可用的 X 登录，搜不了；单条推文链接可以直接读");
  const req = buildSearchTimelineRequest(query, 20);
  const r = await fetch(req.url, {
    method: req.method, body: req.body,
    headers: {
      Authorization: "Bearer " + decodeURIComponent(X_BEARER_TOKEN), "x-csrf-token": ct0, Cookie: cookie, "Content-Type": "application/json",
      "x-twitter-auth-type": "OAuth2Session", "x-twitter-active-user": "yes", "x-twitter-client-language": "zh-cn", "User-Agent": UA, Referer: "https://x.com/search",
    },
    signal: AbortSignal.timeout(20000),
  });
  if (r.status === 401 || r.status === 403) throw new Error("X 登录失效或被拦了（" + r.status + "）");
  if (!r.ok) throw new Error("X 搜索返回 " + r.status);
  const parsed: any = parseSearchTimeline(await r.json());
  return (parsed.tweets || []).slice(0, 15).map((t: any) => ({ author: t.name + " @" + t.author, time: t.created_at, text: clip(formatTweetText(t), 600), url: t.url }));
}

// ---------- voice ----------
/** Text → DeepSeek TTS (24 kHz PCM) → SILK, the only voice format QQ accepts. */
/** A voice message from QQ (SILK): decode it on the relay, wrap the samples as WAV, and transcribe. */
export async function hearSilk(net: Net, silk: Uint8Array) {
  const dec = await fetch(net.env.RELAY_URL + "/api/silk", {
    method: "POST", headers: { "Content-Type": "application/json", "x-relay-key": net.env.RELAY_KEY || "" },
    body: JSON.stringify({ op: "decode", data: b64(silk), rate: 24000 }), signal: AbortSignal.timeout(30000),
  });
  const d: any = await dec.json().catch(() => ({}));
  if (!d.data) throw new Error("语音解码失败" + (d.error ? "：" + d.error : ""));
  const pcm = unb64(d.data), wav = new Uint8Array(44 + pcm.length), v = new DataView(wav.buffer);
  const tag = (at: number, t: string) => { for (let i = 0; i < 4; i++) wav[at + i] = t.charCodeAt(i); };
  tag(0, "RIFF"); v.setUint32(4, 36 + pcm.length, true); tag(8, "WAVE"); tag(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 24000, true); v.setUint32(28, 48000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, pcm.length, true);
  wav.set(pcm, 44);
  return (await transcribe(net.env, wav, pcm.length / 48000, "audio/wav", "voice.wav")).trim();
}

export async function ttsSilk(net: Net, text: string, voice: string) {
  const r = await dsJson(net.env, "/v1/tools/tts", { text, voice_id: voice === "male" ? "tide" : "stella", format: "pcm", filter_markdown: true }, 60000);
  if (!r.ok) throw new Error("语音合成失败（" + r.status + "）");
  const pcm = new Uint8Array(await r.arrayBuffer());
  if (pcm.length < 2000) throw new Error("语音合成没有返回声音");
  if (pcm.length > 3_000_000) throw new Error("这段话太长了，语音最多一分钟左右");
  const enc = await fetch(net.env.RELAY_URL + "/api/silk", {
    method: "POST", headers: { "Content-Type": "application/json", "x-relay-key": net.env.RELAY_KEY || "" },
    body: JSON.stringify({ op: "encode", data: b64(pcm), rate: 24000 }), signal: AbortSignal.timeout(30000),
  });
  const d: any = await enc.json().catch(() => ({}));
  if (!d.data) throw new Error("语音编码失败" + (d.error ? "：" + d.error : ""));
  return { silk: d.data as string, seconds: Math.round(Number(d.duration || 0) / 1000) };
}
