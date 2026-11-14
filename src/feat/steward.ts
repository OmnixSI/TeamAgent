// Budget steward: budget.ts keeps usage under the plan; this paces it across the billing cycle so the
// first days cannot eat an allowance and most of it does not go unused. Once per UTC day it writes
// kv "steward:plan"; other features ask allowed()/advice() instead of reading meters themselves.
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import { DAILY, PLAN, cycleStart } from "../budget.ts";

const DAY = 86_400_000;
const PLAN_KEY = "steward:plan", HIST_KEY = "steward:hist", DONE_KEY = "steward:day";
const STALE_MS = 2 * DAY;
const KEEP_DAYS = 40;
const METERS = Object.keys(PLAN);

export type State = "rich" | "ok" | "tight" | "critical";
export type MeterPlan = {
  used: number; stop: number; days_left: number; pace: number; allowance: number;
  day_start_used: number; burn7: number; days_at_burn: number | null; state: State;
};
export type StewardPlan = {
  day: string; at: number;
  cycle: { start: string; end: string; days_total: number; days_left: number; elapsed_share: number };
  meters: Record<string, MeterPlan>;
  daily: { ai_neurons: { used_today: number; yesterday: number; stop: number; state: State } };
};
export const SWITCHES = ["repo_builds", "repo_full", "preview_auto", "index_boost", "media_heavy", "browser_heavy"] as const;
export type Switch = typeof SWITCHES[number];

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const midnight = (t: number) => Math.floor(t / DAY) * DAY;
const num = (v: any) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (n: number, d = 0) => { const k = 10 ** d; return Math.round(n * k) / k; };

export function cycleInfo(now: number) {
  const start = cycleStart(now);
  const s = new Date(start), end = Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 13);
  const total = Math.round((end - start) / DAY);
  const left = Math.max(1, Math.round((end - midnight(now)) / DAY));
  return { start, end, total, left, share: Math.min(1, Math.max(0, (now - start) / (end - start))) };
}

function readJson(hub: Hub, key: string): any { try { const s = hub.get(key); return s ? JSON.parse(s) : null; } catch { return null; } }
const readHist = (hub: Hub): Record<string, Record<string, number>> => readJson(hub, HIST_KEY)?.snaps || {};
const neuronsOn = (hub: Hub, date: string) => num(hub.get("plan:day:" + date + ":ai_neurons"));

/** Average daily use over the last 7 completed days; falls back to the cycle average when there is no history yet. */
export function burnRate(snaps: Record<string, Record<string, number>>, meter: string, now: number, used: number, cycle: { start: number; share: number }) {
  const today = midnight(now);
  const dates = Object.keys(snaps).filter(d => snaps[d]?.[meter] != null && Date.parse(d) >= today - 7 * DAY && Date.parse(d) <= today).sort();
  let total = 0, span = 0;
  for (let i = 1; i < dates.length; i++) {
    const diff = snaps[dates[i]][meter] - snaps[dates[i - 1]][meter];
    if (diff < 0) continue; // the cycle reset in between
    total += diff; span += (Date.parse(dates[i]) - Date.parse(dates[i - 1])) / DAY;
  }
  if (span >= 1) return total / span;
  return used / Math.max(1, (now - cycle.start) / DAY);
}

export function classify(m: { used: number; stop: number; pace: number; burn7: number }): State {
  const left = Math.max(0, m.stop - m.used);
  if (m.burn7 > 0 && left / m.burn7 < 3) return "critical";
  if (m.used > m.pace) return "tight";
  if (m.used < m.pace * 0.75) return "rich";
  return "ok";
}

export function classifyDaily(yesterday: number, today: number, stop: number): State {
  if (today >= stop) return "critical";
  if (Math.max(yesterday, today) > stop * 0.8) return "tight";
  if (yesterday < stop * 0.5 && today < stop * 0.5) return "rich";
  return "ok";
}

export function computePlan(hub: Hub, now: number): StewardPlan {
  const c = cycleInfo(now), today = iso(now);
  const hist = readJson(hub, HIST_KEY) || { snaps: {} };
  const snaps: Record<string, Record<string, number>> = hist.snaps || {};
  // Day-start snapshot: written by the first computation of the day only, so later recomputes do not move it.
  if (!snaps[today]) snaps[today] = Object.fromEntries(METERS.map(m => [m, round(hub.plan.used(m), 2)]));
  for (const d of Object.keys(snaps)) if (Date.parse(d) < now - KEEP_DAYS * DAY) delete snaps[d];
  hub.set(HIST_KEY, JSON.stringify({ snaps }));

  const meters: Record<string, MeterPlan> = {};
  for (const name of METERS) {
    const used = hub.plan.used(name), stop = PLAN[name].stop, left = Math.max(0, stop - used);
    const pace = stop * c.share, burn7 = burnRate(snaps, name, now, used, { start: c.start, share: c.share });
    const m = { used, stop, pace, burn7 };
    let state = classify(m);
    if (state === "rich" && now - c.start < DAY) state = "ok"; // nothing to compare with on the first day
    meters[name] = {
      used: round(used, 1), stop, days_left: c.left, pace: round(pace, 1), allowance: round(left / c.left, 1),
      day_start_used: snaps[today][name], burn7: round(burn7, 1), days_at_burn: burn7 > 0 ? round(left / burn7, 1) : null, state,
    };
  }
  const stop = DAILY.ai_neurons.stop, ut = hub.plan.used("ai_neurons"), uy = neuronsOn(hub, iso(now - DAY));
  return {
    day: today, at: now,
    cycle: { start: iso(c.start), end: iso(c.end), days_total: c.total, days_left: c.left, elapsed_share: round(c.share, 4) },
    meters, daily: { ai_neurons: { used_today: round(ut, 1), yesterday: round(uy, 1), stop, state: classifyDaily(uy, ut, stop) } },
  };
}

export function loadPlan(hub: Hub, now = Date.now()): StewardPlan | null {
  const p = readJson(hub, PLAN_KEY) as StewardPlan | null;
  if (!p || !p.meters || !p.daily || now - num(p.at) > STALE_MS) return null;
  return p;
}

// ---------- switches ----------
const worse = (s?: State) => s === "tight" || s === "critical";
/** Truth table. With no plan: cheap and user-requested things stay on, optional heavy extras stay off. */
export function switches(plan: StewardPlan | null): Record<Switch, { on: boolean; why: string }> {
  if (!plan) {
    return {
      repo_builds: { on: false, why: "还没有额度计划，慢速构建先不做" },
      repo_full: { on: false, why: "还没有额度计划，不重跑没变的仓库" },
      preview_auto: { on: true, why: "还没有额度计划，自动预览照常" },
      index_boost: { on: false, why: "还没有额度计划，不加量建索引" },
      media_heavy: { on: true, why: "还没有额度计划，长视频照常接" },
      browser_heavy: { on: true, why: "还没有额度计划，多页浏览照常接" },
    };
  }
  const cpu = plan.meters.container_cpu_seconds?.state, sec = plan.meters.container_seconds?.state, br = plan.meters.browser_seconds?.state;
  const y = plan.daily.ai_neurons.yesterday, half = plan.daily.ai_neurons.stop / 2;
  const word = (s?: State) => (s === "rich" ? "宽裕" : s === "ok" ? "正常" : s === "tight" ? "偏快" : "快见底");
  return {
    repo_builds: cpu === "rich" ? { on: true, why: "云电脑算力用得慢，富余，夜检顺带跑慢速构建" } : { on: false, why: "云电脑算力" + word(cpu) + "，只在宽裕时才跑慢速构建" },
    repo_full: cpu === "rich" ? { on: true, why: "云电脑算力富余，没变的仓库也重新检查" } : { on: false, why: "云电脑算力" + word(cpu) + "，只在宽裕时才重跑没变的仓库" },
    preview_auto: !worse(cpu) && !worse(sec) && !worse(br)
      ? { on: true, why: "云电脑和浏览器额度都没超进度，自动预览照常" }
      : { on: false, why: [worse(cpu) && "云电脑算力" + word(cpu), worse(sec) && "云电脑时间" + word(sec), worse(br) && "浏览器" + word(br)].filter(Boolean).join("、") + "，暂停自动预览，需要时手动让我做" },
    index_boost: y < half ? { on: true, why: "昨天 AI 用量不到上限的一半，今天可以多建索引" } : { on: false, why: "昨天 AI 用量已过上限的一半，不加量建索引" },
    media_heavy: worse(cpu) ? { on: false, why: "云电脑算力" + word(cpu) + "，长视频任务先不接" } : { on: true, why: "云电脑算力" + word(cpu) + "，长视频任务可以接" },
    browser_heavy: worse(br) ? { on: false, why: "浏览器额度" + word(br) + "，多页浏览任务先不接" } : { on: true, why: "浏览器额度" + word(br) + "，多页浏览任务可以接" },
  };
}

/** Whether an optional activity is on right now, from the day's plan. Unknown names are off. */
export function allowed(hub: Hub, what: string): boolean {
  if (!(SWITCHES as readonly string[]).includes(what)) return false;
  return switches(loadPlan(hub))[what as Switch].on;
}

// ---------- wording ----------
const LABEL: Record<string, string> = {
  browser_seconds: "浏览器时间", container_seconds: "云电脑时间", container_cpu_seconds: "云电脑算力",
  r2_writes: "文件存储的写入次数", r2_reads: "文件存储的读取次数", ai_neurons: "AI 额度",
};
const STOPS: Record<string, string> = {
  browser_seconds: "网页截图、文档转 PDF、多页浏览",
  container_seconds: "剪视频、跑项目、做项目预览这类要云电脑的活",
  container_cpu_seconds: "剪视频、跑项目、做项目预览这类吃算力的活",
  r2_writes: "存文件、备份、发布页面",
  r2_reads: "取回文件、打开已发布的页面",
};
export function fmtAmount(meter: string, n: number) {
  if (meter === "r2_writes" || meter === "r2_reads") return n >= 10000 ? round(n / 10000, 1) + " 万次" : Math.round(n) + " 次";
  if (meter === "ai_neurons") return Math.round(n) + " neurons";
  if (n < 90) return Math.round(n) + " 秒";
  if (n < 5400) return Math.round(n / 60) + " 分钟";
  return round(n / 3600, 1) + " 小时";
}
const resetText = (plan: StewardPlan) => { const [, m, d] = plan.cycle.end.split("-"); return Number(m) + " 月 " + Number(d) + " 日"; };
const STATE_ZH: Record<State, string> = { rich: "宽裕", ok: "正常", tight: "偏快", critical: "快见底" };
const MEANING: Record<State, string> = {
  rich: "用得比平均进度慢得多，可以放开用", ok: "和平均进度差不多", tight: "已经超过平均进度，得匀着用", critical: "照最近一周的用量，几天内就会用完",
};

/** Null when a planned use of `amount` fits today's share; otherwise one Chinese sentence the model may relay. */
export function advice(hub: Hub, meter: string, amount: number): string | null {
  const plan = loadPlan(hub);
  if (!plan || !(amount > 0)) return null;
  if (meter === "ai_neurons") {
    const used = hub.plan.used("ai_neurons"), left = Math.max(0, DAILY.ai_neurons.stop - used);
    if (amount <= left) return null;
    return "今天的 AI 额度只剩约 " + fmtAmount(meter, left) + "，这次要用约 " + fmtAmount(meter, amount) + "；这项按天算，明天 0 点（UTC）重置，先缓一缓。";
  }
  const m = plan.meters[meter];
  if (!m) return null;
  const todayShare = (m.stop - m.day_start_used) / m.days_left;
  const live = hub.plan.used(meter), remaining = Math.max(0, todayShare - Math.max(0, live - m.day_start_used));
  if (amount <= remaining) return null;
  return "今天" + LABEL[meter] + "的份额只剩约 " + fmtAmount(meter, remaining) + "，这次要用约 " + fmtAmount(meter, amount) +
    "；这项按月算，本月还要撑 " + m.days_left + " 天到 " + resetText(plan) + " 重置，所以要匀着用，建议缩小范围或明天再做。";
}

// ---------- announcements ----------
async function announce(hub: Hub, plan: StewardPlan) {
  const main = hub.get("main");
  if (!main) return;
  const cyc = plan.cycle.start;
  for (const name of METERS) {
    const m = plan.meters[name];
    if (m.state !== "critical") continue;
    const mark = "steward:crit:" + cyc + ":" + name;
    if (hub.get(mark)) continue;
    hub.set(mark, "1");
    const left = Math.max(0, m.stop - m.used);
    await hub.say(main, LABEL[name] + "这个月的额度快见底了：还剩 " + fmtAmount(name, left) + (m.days_at_burn != null ? "，照最近一周的用量大约 " + m.days_at_burn + " 天就用完" : "") +
      "。用完之前我会先停掉" + STOPS[name] + "；每月 13 号重置，下次是 " + resetText(plan) + "。");
  }
  const mark = "steward:use:" + cyc;
  if (plan.cycle.days_left > 5 || hub.get(mark)) return;
  const unused = (n: string) => plan.meters[n].state === "rich" && (plan.meters[n].stop - plan.meters[n].used) * 5 > plan.meters[n].stop * 2;
  const left = (n: string) => fmtAmount(n, plan.meters[n].stop - plan.meters[n].used);
  const parts: string[] = [];
  if (unused("container_seconds")) parts.push("云电脑还剩 " + left("container_seconds") + "没用，这几天要剪视频、跑项目尽管叫我");
  else if (unused("container_cpu_seconds")) parts.push("云电脑算力还剩 " + left("container_cpu_seconds") + "没用，这几天要剪视频、跑项目尽管叫我");
  if (unused("browser_seconds")) parts.push("浏览器还剩 " + left("browser_seconds") + "没用，要截网页、转 PDF 也尽管叫我");
  if (!parts.length) return;
  hub.set(mark, "1");
  await hub.say(main, parts.join("；") + "。");
}

/** Computes the day's plan once per UTC day (or when forced) and sends any announcements due. */
export async function ensurePlan(hub: Hub, now: number, force = false): Promise<StewardPlan> {
  const today = iso(now);
  if (!force && hub.get(DONE_KEY) === today) { const p = loadPlan(hub, now); if (p) return p; }
  const plan = computePlan(hub, now);
  hub.set(PLAN_KEY, JSON.stringify(plan));
  hub.set(DONE_KEY, today);
  try { await announce(hub, plan); } catch (e: any) { console.log("steward announce failed", e?.message); }
  return plan;
}

// ---------- history ----------
export function history(hub: Hub, days: number, now = Date.now()) {
  const snaps = readHist(hub), today = midnight(now), out: any[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = today - i * DAY, d = iso(t), next = iso(t + DAY), row: Record<string, any> = { date: d };
    for (const name of METERS) {
      const a = snaps[d]?.[name];
      if (a == null) { row[name] = null; continue; }
      if (i === 0) { row[name] = round(Math.max(0, hub.plan.used(name) - a), 1); continue; }
      const b = snaps[next]?.[name];
      row[name] = b == null || b < a ? null : round(b - a, 1);
    }
    row.ai_neurons = i === 0 ? round(hub.plan.used("ai_neurons"), 1) : round(neuronsOn(hub, d), 1);
    out.push(row);
  }
  return out;
}

function planView(hub: Hub, plan: StewardPlan) {
  const meters = METERS.map(name => {
    const m = plan.meters[name], used = hub.plan.used(name), todayUsed = Math.max(0, used - m.day_start_used);
    const share = (m.stop - m.day_start_used) / m.days_left;
    return {
      what: LABEL[name], used: fmtAmount(name, used) + "（可用上限 " + fmtAmount(name, m.stop) + "）", today_share: "今天的份额约 " + fmtAmount(name, share) + "，已用 " + fmtAmount(name, todayUsed),
      state: STATE_ZH[m.state], meaning: MEANING[m.state] + (m.state === "critical" && m.days_at_burn != null ? "（约 " + m.days_at_burn + " 天）" : ""),
    };
  });
  const d = plan.daily.ai_neurons, sw = switches(plan);
  return {
    cycle: "本周期 " + plan.cycle.start + " 到 " + plan.cycle.end + "，还剩 " + plan.cycle.days_left + " 天，每月 13 号重置",
    meters,
    ai_daily: { what: LABEL.ai_neurons + "（按天）", used_today: fmtAmount("ai_neurons", hub.plan.used("ai_neurons")), yesterday: fmtAmount("ai_neurons", d.yesterday), state: STATE_ZH[d.state], limit: fmtAmount("ai_neurons", d.stop) },
    optional: Object.entries(sw).map(([k, v]) => ({ key: k, name: SWITCH_ZH[k as Switch], on: v.on, why: v.why })),
  };
}
const SWITCH_ZH: Record<Switch, string> = {
  repo_builds: "夜检顺带跑慢速构建", repo_full: "重跑没变的仓库", preview_auto: "自动预览", index_boost: "加量建索引", media_heavy: "长视频任务", browser_heavy: "多页浏览任务",
};

const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const feature: Feature = {
  name: "steward",
  async tick(hub, now) {
    if (hub.get(DONE_KEY) === iso(now)) return;
    await ensurePlan(hub, now);
  },
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/steward") return null;
    if (req.method === "POST") {
      if (!body?.recompute) return json({ ok: false, error: '用 {"recompute":true} 重算今天的计划' }, 400);
      await ensurePlan(hub, Date.now(), true);
    } else if (req.method !== "GET") return json({ ok: false, error: "GET 或 POST" }, 405);
    const plan = loadPlan(hub);
    return json({ ok: true, plan, switches: switches(plan), history: history(hub, Math.min(31, Math.max(1, Number(url.searchParams.get("days")) || 14))) });
  },
  tools: ({ hub }) => [{
    name: "budget",
    description: "看这个月的云服务额度还够不够、今天还能用多少、为什么某件事被推迟。群里问“额度还剩多少”“云电脑今天还能用吗”“为什么没自动做预览/为什么没跑构建”，或者你自己要做一件很费云电脑、浏览器的事、想先看看合不合适，就用这个。op=plan：每一项额度（云电脑时间和算力、浏览器、文件存储）已用多少、今天的份额、是宽裕还是吃紧，以及哪些可选的活现在开着、哪些关着和原因；op=history：每天各项用了多少，days 是看几天（默认 7，最多 31）。额度按每月 13 号重置，用完会停，不会多花钱。",
    parameters: { type: "object", properties: { op: { type: "string", enum: ["plan", "history"], description: "plan 看额度和开关；history 看每天用量" }, days: { type: "number", description: "history 看几天，默认 7" } }, required: ["op"] },
    async run(args: any) {
      const plan = await ensurePlan(hub, Date.now());
      if (args?.op === "history") return { ok: true, days: history(hub, Math.min(31, Math.max(1, Math.round(Number(args.days)) || 7))), unit: "云电脑、浏览器按秒；文件存储按次；ai_neurons 是当天用量" };
      if (args?.op === "plan" || !args?.op) return { ok: true, ...planView(hub, plan) };
      return { ok: false, error: "op 只能是 plan 或 history" };
    },
  }],
  about: [
    "额度管家：Cloudflare 套餐的每一项按量额度（云电脑、浏览器、文件存储）都有停止线，保证不会超出套餐。",
    "管家每天（UTC 0 点）算一次计划：每项已经用了多少、本周期还剩几天、今天大约能用多少，并判断宽裕、正常、偏快还是快见底。",
    "额度宽裕时才放开可选的活（夜检跑慢速构建、重跑没变的仓库）；偏快时暂停自动预览，长视频和多页浏览任务也会先放一放。",
    "某项照最近一周的用量不到 3 天就用完时，会在群里提醒一次；周期最后 5 天还剩很多时，会提醒大家尽管多用。",
    "可以问我“额度还够不够”“为什么某件事被推迟”，我会查 budget 工具。额度每月 13 号重置。",
  ],
};
export default feature;
