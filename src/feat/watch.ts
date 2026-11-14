// Page watching: people ask the bot to keep an eye on a page and tell the group when the thing they care about
// changes. Every check reads the page, drops volatile lines, and only asks the model when the text really differs.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { dsChat } from "../llm.ts";
import { clip, fmtFull, BJ } from "../util.ts";

export const LIMITS = { perConv: 15, perTick: 2, snapshot: 20000, browserDaily: 20, failsToPause: 3, claimMs: 15 * 60000, minEvery: 30, maxEvery: 10080, defaultEvery: 180 };

/** Seams the tests replace: the model, and the real browser (loaded lazily because it pulls in puppeteer). */
export const deps = {
  model: (hub: Hub, system: string, user: string): Promise<string> =>
    dsChat(hub.env, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 1500, label: "网页监控" }, "high", 60000).then(r => String(r.message?.content || "")),
  browse: async (hub: Hub, url: string): Promise<{ title?: string; content: string }> => {
    const { browse } = await import("../render.ts");
    const r = await browse(hub, url, false);
    return { title: r.title, content: r.text };
  },
};

type Row = {
  id: number; conv: string; url: string; what: string; every_min: number; by: string; created: number; last: number | null; next: number;
  state: string; snapshot: string; fails: number; active: number; use_browser: number; hits: number;
};

const day = (now: number) => new Date(now).toISOString().slice(0, 10);
const kvDay = (hub: Hub, kind: string, now: number) => `watch:${kind}:${day(now)}`;
const used = (hub: Hub, kind: string, now: number) => Number(hub.get(kvDay(hub, kind, now)) || 0);
const bump = (hub: Hub, kind: string, now: number) => hub.set(kvDay(hub, kind, now), String(used(hub, kind, now) + 1));
const mainConv = (hub: Hub) => hub.get("main") || "";
const cfgNum = (hub: Hub, key: string) => Number(hub.edit.cfg(mainConv(hub), key));
const dailyCap = (hub: Hub) => cfgNum(hub, "watch_daily");
const minEvery = (hub: Hub) => Math.max(15, cfgNum(hub, "watch_min_interval"));
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as unknown as Row[];
const jitter = (every: number) => Math.floor(Math.random() * Math.min(every * 0.1, 5) * 60000);

// ---------- reading and comparing ----------
// Lines that change on every load without meaning anything: "3 分钟前", view counters, CSRF-looking tokens.
const VOLATILE = [
  /\d+\s*(秒|分钟|分|小时|天)\s*前/, /刚刚|just now|\b\d+\s*(seconds?|minutes?|mins?|hours?)\s+ago\b/i,
  /(阅读|浏览|播放|观看|点赞|评论|收藏|在线)\s*[:：]?\s*[\d,.]+\s*[万kKwW]?\s*(次|人)?\s*$/, /^[\d,.]+\s*[万kKwW]?\s*(次)?\s*(阅读|浏览|播放|观看|views?)\s*$/i,
  /csrf|xsrf|authenticity_token|nonce|__RequestVerificationToken/i, /\b[A-Za-z0-9+/_-]{32,}={0,2}\b/,
];
export function normalise(text: string): string {
  const out: string[] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/[\s 　]+/g, " ").trim();
    if (!line || VOLATILE.some(re => re.test(line))) continue;
    out.push(line);
  }
  return clip(out.join("\n"), LIMITS.snapshot).replace(/…$/, "");
}

/** Lines added and removed, as multisets, so a moved line is not a change. */
export function diffLines(before: string, after: string) {
  const count = (s: string) => { const m = new Map<string, number>(); for (const l of s.split("\n")) if (l) m.set(l, (m.get(l) || 0) + 1); return m; };
  const a = count(before), b = count(after), added: string[] = [], removed: string[] = [];
  for (const [l, n] of b) for (let i = 0; i < n - (a.get(l) || 0); i++) added.push(l);
  for (const [l, n] of a) for (let i = 0; i < n - (b.get(l) || 0); i++) removed.push(l);
  return { added, removed };
}

async function readPage(hub: Hub, w: Row): Promise<string> {
  const page = w.use_browser
    ? await deps.browse(hub, w.url)
    : await (hub.tools(w.conv).find(t => t.name === "read_url")!.run({ url: w.url }) as Promise<any>);
  if (!page || typeof page.content !== "string") throw new Error("读不出来");
  const text = normalise(page.content);
  if (text.length < 20) throw new Error("页面几乎是空的");
  return text;
}

/** The model's reply as { changed, state, say }, or null when it is not that. */
export function parseVerdict(raw: string): { changed: boolean; state: string; say: string } | null {
  const s = String(raw || ""), a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (typeof j?.changed !== "boolean") return null;
    return { changed: j.changed, state: typeof j.state === "string" ? j.state.trim().replace(/\s+/g, " ") : "", say: typeof j.say === "string" ? j.say.trim() : "" };
  } catch { return null; }
}

const JUDGE = "你在替一个 QQ 群盯着一个网页。群友只关心他们说的那一件事，页面上别的变动（广告、推荐、计数、时间、排版）都不算变化。" +
  "只输出一个 JSON，不要别的字：{\"changed\":true或false,\"state\":\"一行字，这件事现在的情况\",\"say\":\"changed 为 true 时，一两句通顺的中文，告诉群里发生了什么，带上具体的版本号/价格/数字；否则空字符串\"}。拿不准就当没变。";
const EXTRACT = "你在替一个 QQ 群盯着一个网页。根据网页内容，用一行中文写出群友关心的那件事现在的情况（例如“最新版本 v1.4.2”“现价 199 元，有货”），带上具体的数字或名称。只输出这一行。";

// ---------- one check ----------
export type CheckResult = { ok: boolean; changed?: boolean; state?: string; say?: string; error?: string; paused?: boolean; skipped?: string };
const inFlight = new Set<number>();

/** Spends one check from today's allowance; false when it is used up (browser checks have their own, smaller one). */
function spend(hub: Hub, w: { use_browser: number }, now: number): string | null {
  if (used(hub, "checks", now) >= dailyCap(hub)) return "今天盯网页的检查次数用完了";
  if (w.use_browser && (used(hub, "browser", now) >= LIMITS.browserDaily || !hub.plan.fits("browser_seconds", 30))) return "今天用浏览器盯网页的次数用完了（或这个月浏览器额度到停止线了）";
  bump(hub, "checks", now); if (w.use_browser) bump(hub, "browser", now);
  return null;
}

export async function checkWatch(hub: Hub, w: Row, now = Date.now()): Promise<CheckResult> {
  const schedule = (extra = "") => hub.sql.exec(`UPDATE watch SET last=?, next=?${extra} WHERE id=?`, now, now + w.every_min * 60000 + jitter(w.every_min), w.id);
  let text: string;
  try { text = await readPage(hub, w); }
  catch (e: any) {
    const fails = Number(w.fails || 0) + 1, pause = fails >= LIMITS.failsToPause;
    hub.sql.exec("UPDATE watch SET last=?, next=?, fails=?, active=? WHERE id=?", now, now + w.every_min * 60000 + jitter(w.every_min), fails, pause ? 0 : 1, w.id);
    if (pause) await hub.say(w.conv, `盯着的这个页面（${clip(w.what, 30)}）连着 ${fails} 次读不出来，先不盯了：${w.url}\n页面能打开了再跟我说一声，我重新盯。`);
    return { ok: false, error: "页面读不出来：" + clip(e?.message, 80), paused: pause };
  }
  if (text === w.snapshot) { schedule(", fails=0"); return { ok: true, changed: false, state: w.state }; }

  const { added, removed } = diffLines(w.snapshot || "", text);
  const diff = w.snapshot
    ? "新增的行：\n" + (clip(added.join("\n"), 2500) || "（无）") + "\n\n去掉的行：\n" + (clip(removed.join("\n"), 1500) || "（无）")
    : "（之前没有记录）";
  let verdict: ReturnType<typeof parseVerdict> = null;
  try {
    verdict = parseVerdict(await deps.model(hub, JUDGE,
      `群友关心的事：${w.what}\n上一次记下的情况：${w.state || "（没有）"}\n\n${diff}\n\n页面现在的内容（开头）：\n${clip(text, 2500)}`));
  } catch (e: any) { console.log("watch judge failed", w.id, e?.message); }
  // A reply that is not the agreed shape is not a verdict: keep the old snapshot so the next check looks again.
  if (!verdict) { schedule(", fails=0"); return { ok: true, changed: false, state: w.state, error: "判断没有出结果，下次再看" }; }

  const state = clip(verdict.state || w.state, 200);
  const say = verdict.changed ? (verdict.say || "有变化：" + state) : "";
  hub.sql.exec("UPDATE watch SET snapshot=?, state=?, hits=hits+?, fails=0, last=?, next=? WHERE id=?",
    text, state, verdict.changed ? 1 : 0, now, now + w.every_min * 60000 + jitter(w.every_min), w.id);
  if (verdict.changed) await hub.say(w.conv, `盯着的「${clip(w.what, 24)}」有动静（#${w.id}）：${clip(say, 300)}\n${w.url}`);
  return { ok: true, changed: verdict.changed, state, say };
}

/** Runs a check for the tool and the admin route: counts it, and refuses to overlap with a running one. */
async function checkNow(hub: Hub, id: number, conv?: string): Promise<CheckResult> {
  const w = rows(hub, "SELECT * FROM watch WHERE id=?", id)[0];
  if (!w || (conv && w.conv !== conv)) return { ok: false, error: "没有这个编号的监控" };
  if (inFlight.has(id)) return { ok: false, error: "这个正在检查，稍等" };
  const refused = spend(hub, w, Date.now());
  if (refused) return { ok: false, error: refused };
  inFlight.add(id);
  try { return await checkWatch(hub, w); } finally { inFlight.delete(id); }
}

// ---------- the tool ----------
const fmt = (ts: number | null) => (ts ? fmtFull(Number(ts), BJ) : "还没查过");
const everyText = (m: number) => (m % 1440 === 0 ? m / 1440 + " 天" : m % 60 === 0 ? m / 60 + " 小时" : m + " 分钟");

function tools({ hub, conv, askers }: Ctx): Tool[] {
  return [{
    name: "watch", work: true, slow: true,
    description: "替群里盯一个网页，里面群友关心的那件事变了就在群里说一声（发布页出新版本、商品降价、仓库发新 release、公告更新、有货了……）。" +
      "op=add：url 是要盯的链接，what 用群友自己的话写清楚关心什么（例如“有没有新版本，要版本号”“价格低于 200 吗”），every 是多少分钟查一次（最少 30，默认 180，最多 10080），" +
      "页面必须用真浏览器才能打开时再填 use_browser=true（费额度，一天最多 20 次）；加的时候会马上读一次页面记下现在的情况，把它告诉群友。" +
      "op=list：看这个群盯着的所有页面。op=remove：不盯了，给 id。op=check：现在就查一次，给 id，变化会自动发到群里。每个群最多同时盯 15 个。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "list", "remove", "check"] },
        url: { type: "string", description: "完整链接，op=add 时必填" },
        what: { type: "string", description: "群友关心的那件事，用他们的话" },
        every: { type: "number", description: "检查间隔，分钟，30 到 10080，默认 180" },
        use_browser: { type: "boolean", description: "页面要真浏览器才能读时才填 true" },
        id: { type: "number", description: "监控编号，op=remove / check 时必填" },
      },
      required: ["op"],
    },
    run: async a => {
      const now = Date.now();
      if (a.op === "list") {
        const list = rows(hub, "SELECT * FROM watch WHERE conv=? ORDER BY id", conv);
        return { ok: true, count: list.length, watches: list.map(w => ({ id: w.id, url: w.url, what: w.what, every: everyText(w.every_min), last_checked: fmt(w.last), state: w.state, fired: w.hits, status: w.active ? "在盯" : "已暂停（连着读不出来）" })) };
      }
      if (a.op === "remove") {
        const w = rows(hub, "SELECT * FROM watch WHERE id=? AND conv=?", Number(a.id), conv)[0];
        if (!w) return { ok: false, error: "这个群里没有编号 " + a.id + " 的监控" };
        hub.sql.exec("DELETE FROM watch WHERE id=?", w.id);
        return { ok: true, removed: w.id, url: w.url };
      }
      if (a.op === "check") return checkNow(hub, Number(a.id), conv);
      if (a.op !== "add") return { ok: false, error: "op 只能是 add / list / remove / check" };

      const url = String(a.url || "").trim(), what = String(a.what || "").trim();
      if (!/^https?:\/\/\S+$/i.test(url)) return { ok: false, error: "要一个 http 或 https 开头的完整链接" };
      if (!what) return { ok: false, error: "要说清楚关心这个页面里的什么" };
      if (Number(hub.sql.exec("SELECT COUNT(*) n FROM watch WHERE conv=? AND active=1", conv).toArray()[0].n) >= LIMITS.perConv) return { ok: false, error: `这个群已经盯着 ${LIMITS.perConv} 个页面了，先去掉几个再加` };
      const useBrowser = a.use_browser === true;
      const min = minEvery(hub);
      const asked = Number(a.every) > 0 ? Math.round(Number(a.every)) : LIMITS.defaultEvery;
      const every = Math.min(LIMITS.maxEvery, Math.max(min, asked));
      const refused = spend(hub, { use_browser: useBrowser ? 1 : 0 }, now);
      if (refused) return { ok: false, error: refused };

      const w = { conv, url, use_browser: useBrowser ? 1 : 0 } as Row;
      let text: string;
      try { text = await readPage(hub, w); } catch (e: any) { return { ok: false, error: "这个页面现在读不出来，没有加：" + clip(e?.message, 80) + (useBrowser ? "" : "。如果它要真浏览器才能打开，可以加上 use_browser 再试") }; }
      let state = "";
      try { state = clip((await deps.model(hub, EXTRACT, `群友关心的事：${what}\n\n页面内容：\n${clip(text, 6000)}`)).trim().split("\n")[0], 200); } catch (e: any) { console.log("watch baseline failed", e?.message); }
      const id = Number(hub.sql.exec(
        "INSERT INTO watch(conv,url,what,every_min,by,created,last,next,state,snapshot,fails,active,use_browser,hits) VALUES(?,?,?,?,?,?,?,?,?,?,0,1,?,0) RETURNING id",
        conv, url, clip(what, 200), every, String(askers?.[0]?.name || ""), now, now, now + every * 60000 + jitter(every), state, text, w.use_browser).toArray()[0].id);
      return { ok: true, id, every: everyText(every), clamped: every !== asked ? "间隔超出允许范围，已按 " + everyText(every) + " 设置" : undefined, baseline: state || "（页面读到了，但没能概括出现在的情况，之后有变化还是会提醒）" };
    },
  }];
}

const feature: Feature = {
  name: "watch",
  schema: `CREATE TABLE IF NOT EXISTS watch(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT, url TEXT, what TEXT, every_min INTEGER, by TEXT, created INTEGER, last INTEGER, next INTEGER, state TEXT, snapshot TEXT, fails INTEGER, active INTEGER, use_browser INTEGER, hits INTEGER);
CREATE INDEX IF NOT EXISTS watch_due ON watch(active, next);`,
  tunables: {
    watch_daily: { default: 200, min: 10, max: 2000, what: "每天所有网页监控加起来最多检查几次" },
    watch_min_interval: { default: 30, min: 15, max: 1440, what: "网页监控两次检查之间最短隔多少分钟" },
  },
  tools,
  tick(hub, now) {
    const due = rows(hub, "SELECT * FROM watch WHERE active=1 AND next<=? ORDER BY next LIMIT ?", now, LIMITS.perTick);
    for (const w of due) {
      if (inFlight.has(w.id)) continue;
      const refused = spend(hub, w, now);
      if (refused) { if (w.use_browser) hub.sql.exec("UPDATE watch SET next=? WHERE id=?", now + 3600000, w.id); continue; }
      // Mark it not due before the slow part starts, so the next tick cannot pick it up again.
      hub.sql.exec("UPDATE watch SET next=? WHERE id=?", now + LIMITS.claimMs, w.id);
      inFlight.add(w.id);
      hub.ctx.waitUntil(checkWatch(hub, w, now).catch(e => console.log("watch check failed", w.id, e?.message)).finally(() => inFlight.delete(w.id)));
    }
  },
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/watch") return null;
    const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });
    if (req.method === "POST") return json(await checkNow(hub, Number(body?.check)));
    const now = Date.now();
    return json({
      today: { checks: used(hub, "checks", now), cap: dailyCap(hub), browser_checks: used(hub, "browser", now), browser_cap: LIMITS.browserDaily },
      watches: rows(hub, "SELECT * FROM watch ORDER BY id").map(w => ({ id: w.id, conv: w.conv, url: w.url, what: w.what, every_min: w.every_min, active: !!w.active, browser: !!w.use_browser, last: fmt(w.last), due_in_min: Math.round((w.next - now) / 60000), state: w.state, fails: w.fails, hits: w.hits })),
    });
  },
  about: [
    "我能帮群里盯网页：发布页出新版本、商品降价、仓库发新 release、公告更新，让我盯着，变了我就在群里说。",
    "加的时候我会先读一次页面，记下现在的情况；之后每隔设定的时间（最少 30 分钟，默认 3 小时）再读一次，只有群友关心的那件事变了才出声，别的小变动不吵人。",
    "每个群最多同时盯 15 个页面；全部监控加起来每天最多检查 200 次（可以改）；要真浏览器才能打开的页面每天最多 20 次。",
    "连着 3 次读不出来我会说一声并先停下，页面恢复后让我重新盯就行。想看盯着什么、不盯了、现在就查一次，都可以直接说。",
  ],
};
export default feature;
