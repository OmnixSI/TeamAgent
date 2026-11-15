// The team side of the task list: who is doing what and since when, each task's path from "said" to
// "done", what each person has finished (points, streaks, badges), a word of praise when something gets
// done, and a weekly report. Everything is computed from the task tables; nothing here is stored twice.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { dsChat } from "../llm.ts";
import { BJ, clip, fmtDate, zonedToUtc } from "../util.ts";
import { hooks, kindOf, listTasks, getTask, named, personOfName, tell, SIZE_LABEL } from "./tasks.ts";
import type { Task } from "./tasks.ts";

const DAY = 86400000, HOUR = 3600000;
const POINTS = { small: 5, normal: 10, big: 30 } as const;
const ON_TIME_BONUS = 5;
const WEEKLY_AT = "21:30";   // Sunday, Beijing

/** Seam the tests replace: one short model call for a line of praise. */
export const deps = {
  line: async (hub: Hub, system: string, user: string): Promise<string> => {
    const r = await dsChat(hub.env, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 2000, label: "任务夸奖" }, "none", 30000);
    return String(r.message?.content || "").trim();
  },
};

// ---------- time ----------
const dayOf = (ts: number) => fmtDate(ts, BJ);
/** Monday 00:00 Beijing of the week `now` is in. */
export function weekStart(now: number): number {
  const today = zonedToUtc(dayOf(now), "00:00", BJ), dow = new Date(today + 8 * HOUR).getUTCDay();   // 0 = Sunday
  return today - ((dow + 6) % 7) * DAY;
}
const monthStart = (now: number) => zonedToUtc(dayOf(now).slice(0, 8) + "01", "00:00", BJ);
/** "3 小时", "2 天半", "40 分钟": how long something took, in words a person would use. */
export function span(ms: number): string {
  if (!(ms > 0)) return "";
  if (ms < 90 * 60000) return Math.max(1, Math.round(ms / 60000)) + " 分钟";
  if (ms < 36 * HOUR) return (Math.round(ms / HOUR * 10) / 10 + "").replace(/\.0$/, "") + " 小时";
  const d = ms / DAY, whole = Math.floor(d);
  return whole + " 天" + (d - whole >= 0.4 && d - whole < 0.9 ? "半" : "");
}

// ---------- scoring ----------
export function pointsOf(t: Task): number {
  if (t.status !== "done") return 0;
  const onTime = !!t.due && !!t.done_at && dayOf(t.done_at) <= t.due;
  return POINTS[t.size] + (onTime ? ON_TIME_BONUS : 0);
}
/** Who gets the credit for a finished task. */
const creditOf = (t: Task) => t.done_by || personOfName(t.claimed_by) || personOfName(t.owner);
/** Who is on a task that is not finished: whoever claimed it, else whoever it was given to. */
const holderOf = (t: Task) => personOfName(t.claimed_by) || personOfName(t.owner);

export type Badge = { key: string; name: string; what: string; earned: boolean; at?: number };
const BADGES: { key: string; name: string; what: string; test(done: Task[], streak: number): number | boolean }[] = [
  { key: "first", name: "开张", what: "做完第一件事", test: d => d[0]?.done_at || false },
  { key: "five", name: "五连胜", what: "累计做完 5 件", test: d => d[4]?.done_at || false },
  { key: "ten", name: "十全", what: "累计做完 10 件", test: d => d[9]?.done_at || false },
  { key: "boss", name: "屠龙", what: "啃下一个大活", test: d => d.find(t => t.size === "big")?.done_at || false },
  { key: "flash", name: "闪电", what: "接手两小时内做完一件", test: d => d.find(t => t.claimed_at && t.done_at - t.claimed_at <= 2 * HOUR && t.done_at > t.claimed_at)?.done_at || false },
  { key: "ontime", name: "准点", what: "5 件事赶在截止日期前做完", test: d => d.filter(t => t.due && dayOf(t.done_at) <= t.due)[4]?.done_at || false },
  { key: "rescue", name: "救火", what: "做完一件已经过了截止日期的事", test: d => d.find(t => t.due && dayOf(t.done_at) > t.due)?.done_at || false },
  { key: "owl", name: "夜猫子", what: "凌晨 0 点到 5 点做完一件", test: d => d.find(t => { const h = new Date(t.done_at + 8 * HOUR).getUTCHours(); return h < 5; })?.done_at || false },
  { key: "streak3", name: "三天不断", what: "连续 3 天都有做完的事", test: (_d, s) => s >= 3 },
  { key: "streak7", name: "一周不断", what: "连续 7 天都有做完的事", test: (_d, s) => s >= 7 },
  { key: "ai", name: "驭 AI", what: "让本地 AI 做完 3 件", test: d => d.filter(t => /的本地\s*AI$/i.test(t.claimed_by))[2]?.done_at || false },
];
/** Longest run of consecutive Beijing days with something finished, counted back from today (or yesterday, if today is still empty). */
export function streakOf(done: Task[], now: number): number {
  const days = new Set(done.map(t => dayOf(t.done_at)));
  let at = days.has(dayOf(now)) ? now : now - DAY, n = 0;
  while (days.has(dayOf(at))) { n++; at -= DAY; }
  return n;
}
function badgesOf(done: Task[], streak: number, best: number): Badge[] {
  return BADGES.map(b => {
    const r = b.test(done, b.key.startsWith("streak") ? best : streak);
    return { key: b.key, name: b.name, what: b.what, earned: !!r, ...(typeof r === "number" && r > 0 ? { at: r } : {}) };
  });
}
/** The longest streak ever, so a streak badge stays earned after the streak ends. */
function bestStreak(done: Task[]): number {
  const days = [...new Set(done.map(t => zonedToUtc(dayOf(t.done_at), "00:00", BJ)))].sort((a, b) => a - b);
  let best = 0, run = 0, prev = 0;
  for (const d of days) { run = prev && d - prev === DAY ? run + 1 : 1; best = Math.max(best, run); prev = d; }
  return best;
}

// ---------- the team ----------
export type Doing = { id: number; title: string; size: string; since: number; due: string; overdue: boolean; by_ai: boolean };
export type PersonStats = {
  name: string;
  doing: Doing[];            // in progress now, oldest first
  waiting: number;           // given to them, not started
  done_week: number; done_month: number; done_total: number;
  points_week: number; points_total: number;
  streak: number; best_streak: number;
  fastest_ms: number;        // quickest claim-to-done, 0 when none
  last_done: number;
  badges: Badge[];
  spent: number;             // points traded in for perks
  balance: number;           // points_total minus spent: what can still be traded in
  title: string;             // a title bought with points, while it lasts
};
export type TeamStats = {
  week: { start: number; end: number; done: number; points: number; by_day: number[] };   // by_day: Monday..Sunday
  totals: { open: number; doing: number; done: number; overdue: number };
  mvp: string;               // most points this week, "" when nobody scored
  people: PersonStats[];     // most points this week first
};

export function teamStats(hub: Hub, conv: string, now = Date.now()): TeamStats {
  const all = listTasks(hub, conv, { limit: 1000 });
  const ws = weekStart(now), ms = monthStart(now), today = dayOf(now);
  const names = new Set<string>();
  for (const t of all) { for (const n of [creditOf(t), holderOf(t), personOfName(t.by)]) if (n) names.add(n); }
  const people: PersonStats[] = [...names].map(name => {
    const done = all.filter(t => t.status === "done" && creditOf(t) === name).sort((a, b) => a.done_at - b.done_at);
    const mine = all.filter(t => (t.status === "doing" || t.status === "open") && holderOf(t) === name);
    const streak = streakOf(done, now), best = Math.max(streak, bestStreak(done));
    const times = done.filter(t => t.claimed_at && t.done_at > t.claimed_at).map(t => t.done_at - t.claimed_at);
    return {
      name,
      doing: mine.filter(t => t.status === "doing").sort((a, b) => (a.claimed_at || a.updated) - (b.claimed_at || b.updated))
        .map(t => ({ id: t.id, title: t.title, size: t.size, since: t.claimed_at || t.updated, due: t.due, overdue: !!t.due && t.due < today, by_ai: /的本地\s*AI$/i.test(t.claimed_by) })),
      waiting: mine.filter(t => t.status === "open").length,
      done_week: done.filter(t => t.done_at >= ws).length, done_month: done.filter(t => t.done_at >= ms).length, done_total: done.length,
      points_week: done.filter(t => t.done_at >= ws).reduce((s, t) => s + pointsOf(t), 0), points_total: done.reduce((s, t) => s + pointsOf(t), 0),
      streak, best_streak: best, fastest_ms: times.length ? Math.min(...times) : 0, last_done: done.length ? done[done.length - 1].done_at : 0,
      badges: badgesOf(done, streak, best),
      spent: 0, balance: 0, title: "",
    };
  }).map(p => { const spent = spentBy(hub, conv, p.name); return { ...p, spent, balance: Math.max(0, p.points_total - spent), title: titleOf(hub, conv, p.name, now) }; }).sort((a, b) => b.points_week - a.points_week || b.points_total - a.points_total || b.doing.length - a.doing.length || a.name.localeCompare(b.name, "zh"));
  const weekDone = all.filter(t => t.status === "done" && t.done_at >= ws);
  const by_day = [0, 0, 0, 0, 0, 0, 0];
  for (const t of weekDone) { const i = Math.floor((t.done_at - ws) / DAY); if (i >= 0 && i < 7) by_day[i]++; }
  return {
    week: { start: ws, end: ws + 7 * DAY, done: weekDone.length, points: weekDone.reduce((s, t) => s + pointsOf(t), 0), by_day },
    totals: {
      open: all.filter(t => t.status === "open").length, doing: all.filter(t => t.status === "doing").length, done: all.filter(t => t.status === "done").length,
      overdue: all.filter(t => (t.status === "open" || t.status === "doing") && !!t.due && t.due < today).length,
    },
    mvp: people[0] && people[0].points_week > 0 ? people[0].name : "",
    people,
  };
}

// ---------- what happened, in order ----------
export type TaskEvent = { ts: number; task: number; title: string; who: string; kind: string; text: string };
const EVENT_WORD: Record<string, string> = { add: "记下", claim: "接手", progress: "进展", done: "做完", drop: "不做了", release: "放下", reopen: "重新打开", edit: "修改" };
/** The group's task events, newest first: who took what, who finished what, progress notes. */
export function taskEvents(hub: Hub, conv: string, o: { limit?: number; before?: number; kinds?: string[] } = {}): TaskEvent[] {
  listTasks(hub, conv, { limit: 1 });   // makes sure the tables have their newer columns
  const limit = Math.max(1, Math.min(200, Math.floor(Number(o.limit) || 50)));
  const rows = hub.sql.exec(
    "SELECT n.ts, n.task, n.who, n.text, n.kind, t.title FROM task_note n JOIN task t ON t.id=n.task AND t.conv=n.conv WHERE n.conv=? AND n.ts<? ORDER BY n.ts DESC, n.id DESC LIMIT ?",
    conv, Number(o.before) > 0 ? Number(o.before) : 9e15, o.kinds?.length ? limit * 4 : limit).toArray() as any[];
  const out = rows.map(r => ({ ts: Number(r.ts), task: Number(r.task), title: String(r.title || ""), who: String(r.who || ""), kind: String(r.kind || "") || kindOf(String(r.text || "")), text: String(r.text || "") }));
  return (o.kinds?.length ? out.filter(e => o.kinds!.includes(e.kind)) : out).slice(0, limit);
}
export type Timeline = {
  task: Task; created: number; claimed_at: number; done_at: number;
  waited_ms: number;      // from written down to picked up
  worked_ms: number;      // from picked up to finished (or until now while in progress)
  steps: (TaskEvent & { word: string })[];   // oldest first
};
/** One task's path: written down, picked up, progress, finished, with how long each stretch took. */
export function taskTimeline(hub: Hub, conv: string, id: number, now = Date.now()): Timeline | null {
  const task = getTask(hub, conv, id);
  if (!task) return null;
  const rows = hub.sql.exec("SELECT ts, who, text, kind FROM task_note WHERE conv=? AND task=? ORDER BY ts, id", conv, task.id).toArray() as any[];
  const steps = rows.map(r => { const kind = String(r.kind || "") || kindOf(String(r.text || "")); return { ts: Number(r.ts), task: task.id, title: task.title, who: String(r.who || ""), kind, text: String(r.text || ""), word: EVENT_WORD[kind] || "修改" }; });
  const claimed = task.claimed_at, end = task.done_at || (task.status === "doing" ? now : 0);
  return { task, created: task.created, claimed_at: claimed, done_at: task.done_at, waited_ms: claimed ? Math.max(0, claimed - task.created) : 0, worked_ms: claimed && end ? Math.max(0, end - claimed) : 0, steps };
}

// ---------- trading points for perks ----------
export type Item = { key: string; name: string; cost: number; what: string; kind: "now" | "timed" | "weekly" | "manual"; days?: number; needs?: string; custom?: boolean };
/** What points buy. "now": the bot does it on the spot. "timed": lasts some days. "weekly": honoured in the next weekly report. "manual": a person has to honour it. */
const ITEMS: Item[] = [
  { key: "meme", name: "定制表情包", cost: 5, kind: "now", what: "指定一张图或一个人，Bot 做成梗图并存进表情库", needs: "用哪张图、配什么字" },
  { key: "roast", name: "点一段语音", cost: 10, kind: "now", what: "让 Bot 用你选的方言夸你一段，或者损你点名的人一段", needs: "夸谁损谁、用什么方言" },
  { key: "blame", name: "甩锅券", cost: 15, kind: "now", what: "Bot 当众替你背一次锅，认错要诚恳", needs: "什么锅" },
  { key: "draw", name: "点一张图", cost: 20, kind: "now", what: "Bot 按你的要求认真画一张图", needs: "画什么" },
  { key: "title", name: "专属头衔一周", cost: 25, kind: "timed", days: 7, what: "自己起一个头衔，挂在看板和功勋墙上，这一周 Bot 就这么叫你", needs: "头衔叫什么（12 个字以内）" },
  { key: "delegate", name: "代办券", cost: 40, kind: "now", what: "把一件小事甩给 Bot 去做：查资料、写文档、整理表格这类一两步能做完的", needs: "要它做什么" },
  { key: "cover", name: "战报封面人物", cost: 50, kind: "weekly", what: "下一期周日战报以你为主角，Bot 给你画一张专属封面" },
];
export const SHOP_SCHEMA = `
  CREATE TABLE IF NOT EXISTS team_spend(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, who TEXT NOT NULL, item TEXT NOT NULL, name TEXT NOT NULL,
    cost INTEGER NOT NULL, ts INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'pending', note TEXT DEFAULT '', until INTEGER DEFAULT 0, done_at INTEGER DEFAULT 0);
  CREATE INDEX IF NOT EXISTS team_spend_who ON team_spend(conv, who, ts);
  CREATE TABLE IF NOT EXISTS team_item(conv TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, cost INTEGER NOT NULL, what TEXT DEFAULT '', made_by TEXT DEFAULT '', ts INTEGER, PRIMARY KEY(conv, key));
  CREATE TABLE IF NOT EXISTS team_star(conv TEXT NOT NULL, week INTEGER NOT NULL, who TEXT NOT NULL, points INTEGER, done INTEGER, PRIMARY KEY(conv, week));
`;
const q = (hub: Hub, sql: string, ...b: any[]): any[] => { try { return hub.sql.exec(sql, ...b).toArray() as any[]; } catch (e: any) { if (/no such table/i.test(String(e?.message))) return []; throw e; } };
export type Spend = { id: number; who: string; item: string; name: string; cost: number; ts: number; state: "pending" | "done" | "refunded"; note: string; until: number };
const spendOf = (r: any): Spend => ({ id: Number(r.id), who: String(r.who), item: String(r.item), name: String(r.name), cost: Number(r.cost), ts: Number(r.ts), state: r.state, note: String(r.note || ""), until: Number(r.until) || 0 });

export function shop(hub: Hub, conv: string): Item[] {
  const custom = q(hub, "SELECT key, name, cost, what FROM team_item WHERE conv=? ORDER BY cost, name", conv)
    .map(r => ({ key: String(r.key), name: String(r.name), cost: Number(r.cost), what: String(r.what || ""), kind: "manual" as const, custom: true }));
  return [...ITEMS, ...custom].sort((a, b) => a.cost - b.cost);
}
const spentBy = (hub: Hub, conv: string, who: string) => Number(q(hub, "SELECT COALESCE(SUM(cost),0) n FROM team_spend WHERE conv=? AND who=? AND state<>'refunded'", conv, who)[0]?.n) || 0;
/** The title someone bought, while it lasts. */
export function titleOf(hub: Hub, conv: string, who: string, now = Date.now()): string {
  return String(q(hub, "SELECT note FROM team_spend WHERE conv=? AND who=? AND item='title' AND state<>'refunded' AND until>? ORDER BY ts DESC LIMIT 1", conv, who, now)[0]?.note || "");
}
export function spends(hub: Hub, conv: string, o: { who?: string; state?: string; limit?: number } = {}): Spend[] {
  const where = ["conv=?"], b: any[] = [conv];
  if (o.who) { where.push("who=?"); b.push(o.who); }
  if (o.state) { where.push("state=?"); b.push(o.state); }
  return q(hub, "SELECT * FROM team_spend WHERE " + where.join(" AND ") + " ORDER BY ts DESC LIMIT ?", ...b, Math.max(1, Math.min(200, Number(o.limit) || 50))).map(spendOf);
}
export function balanceOf(hub: Hub, conv: string, who: string, now = Date.now()): { earned: number; spent: number; balance: number } {
  const p = teamStats(hub, conv, now).people.find(x => x.name === who);
  return { earned: p?.points_total || 0, spent: p?.spent || 0, balance: p?.balance || 0 };
}
/** What the bot has to do to honour a perk bought just now. */
function honour(item: Item, who: string, note: string): string {
  const ask = note ? "他的要求：“" + note + "”。" : "他没说具体要求，先问清楚再做。";
  switch (item.key) {
    case "meme": return who + " 用积分换了一个定制表情包。" + ask + "用 meme 做出来发到群里，再用 sticker 存进表情库。";
    case "roast": return who + " 用积分点了一段语音。" + ask + "写一段 60 字以内的词，用 speak 选对应的方言说出来，跟一条文字稿。";
    case "blame": return who + " 用积分买了一张甩锅券。" + ask + "你当众把这个锅认下来：说得诚恳、具体，像真是你干的，最后保证不再犯。";
    case "draw": return who + " 用积分点了一张图。" + ask + "用 generate_image 认真画一张发到群里，intent 里写明这是他用积分换的。";
    case "delegate": return who + " 用积分买了一张代办券。" + ask + "现在就把这件事做了（需要好几步就先调 plan），做完把结果发群里；如果这事太大、不是一两步能做完的，照实说并请他换一件，积分让群主退。";
    case "title": return who + " 用积分换了一周的专属头衔“" + note + "”。用 remember 记下：到期之前称呼 " + who + " 时带上这个头衔。在群里用这个头衔叫他一声。";
    case "cover": return who + " 用积分换了下一期战报的封面人物，周日晚上的战报会给他画封面。现在在群里说一声已经记下了。";
    default: return who + " 用积分换了「" + item.name + "」（" + item.what + "）。" + (note ? "附言：“" + note + "”。" : "") + "这个要人来兑现：在群里说清楚谁换了什么，请群主兑现，兑现后让群主说一声“兑现了”。";
  }
}
export type Redeemed = { ok: true; spend: Spend; balance: number; do: string } | { ok: false; error: string };
/**
 * Trades points for a perk. `via` "chat": the caller is the bot in a conversation and gets back what to do.
 * `via` "board": nobody is talking to the bot, so it is told in a background task and does it in the group.
 */
export function redeem(hub: Hub, conv: string, who: string, key: string, note = "", via: "chat" | "board" = "chat", now = Date.now()): Redeemed {
  const person = personOfName(who);
  if (!person) return { ok: false, error: "不知道是谁要兑换" };
  const item = shop(hub, conv).find(i => i.key === key || i.name === key);
  if (!item) return { ok: false, error: "没有这一项，能换的有：" + shop(hub, conv).map(i => i.name + "（" + i.cost + " 分）").join("、") };
  const text = clip(String(note || "").trim(), 200);
  if (item.key === "title" && (!text || text.length > 12)) return { ok: false, error: "头衔要给一个名字，12 个字以内" };
  const { balance } = balanceOf(hub, conv, person, now);
  if (balance < item.cost) return { ok: false, error: person + " 现在有 " + balance + " 分，「" + item.name + "」要 " + item.cost + " 分，还差 " + (item.cost - balance) + " 分" };
  const until = item.kind === "timed" ? now + (item.days || 7) * DAY : 0;
  const state = item.kind === "now" || item.kind === "timed" ? "done" : "pending";
  hub.sql.exec("INSERT INTO team_spend(conv, who, item, name, cost, ts, state, note, until, done_at) VALUES(?,?,?,?,?,?,?,?,?,?)", conv, person, item.key, item.name, item.cost, now, state, text, until, state === "done" ? now : 0);
  const row = spendOf(hub.sql.exec("SELECT * FROM team_spend WHERE conv=? AND who=? ORDER BY id DESC LIMIT 1", conv, person).toArray()[0]);
  const todo = honour(item, person, text), left = balance - item.cost;
  if (via === "board") {
    const p = (hub as any).runTask?.(conv, todo + "（这是他在看板上兑换的，花了 " + item.cost + " 分，还剩 " + left + " 分。你这一轮只有最后那条回复会发到群里，开头先说一句谁用多少分换了什么。）");
    if (p && typeof p.catch === "function") (hub as any).ctx?.waitUntil?.(p.catch((e: any) => console.log("teamwork: honour failed", e?.message)));
  }
  return { ok: true, spend: row, balance: left, do: todo };
}
/** Marks a perk as honoured, or gives the points back. */
export function settle(hub: Hub, conv: string, id: number, to: "done" | "refunded", now = Date.now()): Spend | null {
  const r = q(hub, "SELECT * FROM team_spend WHERE conv=? AND id=?", conv, Math.floor(Number(id)) || 0)[0];
  if (!r) return null;
  hub.sql.exec("UPDATE team_spend SET state=?, done_at=?, until=CASE WHEN ?='refunded' THEN 0 ELSE until END WHERE conv=? AND id=?", to, now, to, conv, Number(r.id));
  return spendOf({ ...r, state: to });
}
export function setItem(hub: Hub, conv: string, name: string, cost: number, what: string, by: string, now = Date.now()): Item | string {
  const n = clip(String(name || "").trim(), 20), c = Math.round(Number(cost));
  if (!n) return "要给这一项起个名字";
  if (!(c >= 1 && c <= 1000)) return "价格要在 1 到 1000 分之间";
  if (ITEMS.some(i => i.name === n)) return "已经有一项叫这个名字了";
  const have = q(hub, "SELECT COUNT(*) n FROM team_item WHERE conv=?", conv)[0];
  const key = "c" + Math.abs([...n].reduce((h, ch) => (h * 31 + ch.codePointAt(0)!) | 0, 7)).toString(36);
  if (Number(have?.n) >= 20 && !q(hub, "SELECT 1 FROM team_item WHERE conv=? AND key=?", conv, key).length) return "自定的特权最多 20 项，先删掉不用的";
  hub.sql.exec("INSERT INTO team_item(conv, key, name, cost, what, made_by, ts) VALUES(?,?,?,?,?,?,?) ON CONFLICT(conv, key) DO UPDATE SET cost=excluded.cost, what=excluded.what, made_by=excluded.made_by, ts=excluded.ts", conv, key, n, c, clip(String(what || "").trim(), 120), by, now);
  return { key, name: n, cost: c, what: clip(String(what || "").trim(), 120), kind: "manual", custom: true };
}
export function dropItem(hub: Hub, conv: string, name: string): boolean {
  const it = shop(hub, conv).find(i => i.custom && (i.name === name || i.key === name));
  if (!it) return false;
  hub.sql.exec("DELETE FROM team_item WHERE conv=? AND key=?", conv, it.key);
  return true;
}

// ---------- the wall of honour ----------
export type Wall = {
  stars: { week: number; who: string; points: number; done: number }[];                       // each past week's star, newest first
  bosses: { id: number; title: string; who: string; done_at: number; took_ms: number }[];     // big tasks brought down, newest first
  badges: { key: string; name: string; what: string; holders: { who: string; at: number }[] }[];
  records: { what: string; who: string; value: string; task?: number }[];
  titles: { who: string; title: string; until: number }[];
  perks: Spend[];                                                                             // what points were traded for lately
};
export function honorWall(hub: Hub, conv: string, now = Date.now()): Wall {
  const stats = teamStats(hub, conv, now), done = listTasks(hub, conv, { status: ["done"], limit: 1000 });
  const badges = BADGES.map(b => ({ key: b.key, name: b.name, what: b.what,
    holders: stats.people.map(p => { const x = p.badges.find(y => y.key === b.key); return x?.earned ? { who: p.name, at: x.at || p.last_done } : null; }).filter(Boolean).sort((a, c) => a!.at - c!.at) as { who: string; at: number }[] }));
  const records: Wall["records"] = [];
  const timed = done.filter(t => t.claimed_at && t.done_at > t.claimed_at && creditOf(t)).sort((a, b) => (a.done_at - a.claimed_at) - (b.done_at - b.claimed_at))[0];
  if (timed) records.push({ what: "最快做完", who: creditOf(timed), value: span(timed.done_at - timed.claimed_at), task: timed.id });
  const top = (f: (p: PersonStats) => number) => [...stats.people].sort((a, b) => f(b) - f(a))[0];
  const streak = top(p => p.best_streak); if (streak?.best_streak >= 2) records.push({ what: "最长连续", who: streak.name, value: streak.best_streak + " 天" });
  const most = top(p => p.done_total); if (most?.done_total) records.push({ what: "做完最多", who: most.name, value: most.done_total + " 件" });
  const rich = top(p => p.points_total); if (rich?.points_total) records.push({ what: "累计积分最高", who: rich.name, value: rich.points_total + " 分" });
  const stars = q(hub, "SELECT week, who, points, done FROM team_star WHERE conv=? ORDER BY week DESC LIMIT 26", conv).map(r => ({ week: Number(r.week), who: String(r.who), points: Number(r.points), done: Number(r.done) }));
  const bestWeek = [...stars].sort((a, b) => b.points - a.points)[0];
  if (bestWeek) records.push({ what: "单周最高分", who: bestWeek.who, value: bestWeek.points + " 分" });
  return {
    stars,
    bosses: done.filter(t => t.size === "big").sort((a, b) => b.done_at - a.done_at).slice(0, 30).map(t => ({ id: t.id, title: t.title, who: creditOf(t), done_at: t.done_at, took_ms: t.claimed_at ? Math.max(0, t.done_at - t.claimed_at) : 0 })),
    badges, records,
    titles: q(hub, "SELECT who, note, until FROM team_spend WHERE conv=? AND item='title' AND state<>'refunded' AND until>? ORDER BY ts DESC", conv, now).map(r => ({ who: String(r.who), title: String(r.note), until: Number(r.until) })),
    perks: spends(hub, conv, { limit: 20 }).filter(s => s.state !== "refunded"),
  };
}
/** Writes down this week's star, so the wall keeps every week's. */
export function recordStar(hub: Hub, conv: string, stats: TeamStats) {
  if (!stats.mvp) return;
  const p = stats.people.find(x => x.name === stats.mvp)!;
  hub.sql.exec("INSERT INTO team_star(conv, week, who, points, done) VALUES(?,?,?,?,?) ON CONFLICT(conv, week) DO UPDATE SET who=excluded.who, points=excluded.points, done=excluded.done", conv, stats.week.start, p.name, p.points_week, p.done_week);
}

// ---------- praise ----------
export type Cheer = {
  who: string; task: string; size: string; took: string; by_ai: boolean; on_time: boolean | null;
  points: number; week_count: number; week_points: number; total_count: number; streak: number;
  new_badges: string[]; leads_week: boolean;
};
/** The true facts worth saying when `task` has just been finished. Null when nobody gets the credit. */
export function cheerFacts(hub: Hub, conv: string, task: Task, now = Date.now()): Cheer | null {
  const who = creditOf(task);
  if (!who || task.status !== "done") return null;
  const stats = teamStats(hub, conv, now), me = stats.people.find(p => p.name === who);
  if (!me) return null;
  // A badge is new when this very task earned it.
  const fresh = me.badges.filter(b => b.earned && (b.at === task.done_at || (b.key.startsWith("streak") && me.streak === (b.key === "streak3" ? 3 : 7) && dayOf(task.done_at) === dayOf(now))));
  return {
    who, task: task.title, size: SIZE_LABEL[task.size], took: task.claimed_at && task.done_at > task.claimed_at ? span(task.done_at - task.claimed_at) : "",
    by_ai: /的本地\s*AI$/i.test(task.claimed_by), on_time: task.due ? dayOf(task.done_at) <= task.due : null,
    points: pointsOf(task), week_count: me.done_week, week_points: me.points_week, total_count: me.done_total, streak: me.streak,
    new_badges: fresh.map(b => b.name + "（" + b.what + "）"), leads_week: stats.mvp === who && stats.people.filter(p => p.points_week > 0).length > 1,
  };
}
/** A plain line that is always true, used when the model is unavailable. */
export function plainCheer(c: Cheer, t: Task): string {
  const bits = [c.took && "用了 " + c.took, "+" + c.points + " 分", "这周第 " + c.week_count + " 件", c.streak >= 2 && "连续 " + c.streak + " 天有产出"].filter(Boolean);
  return named(t) + " 做完了，" + c.who + (c.by_ai ? "（本地 AI 出的力）" : "") + " 拿下：" + bits.join("，") + (c.new_badges.length ? "。新称号：" + c.new_badges.join("、") : "") + (t.result ? "。结果：" + clip(t.result, 120) : "");
}
const CHEER_SYSTEM = "你是这个三人小群里的 Bot，平时说话像损友，但别人把事做成了你是真服气。有人刚做完一件任务，你在群里夸他一句。"
  + "要求：一到两句，不超过 70 个字；必须具体说出他做成的是什么事；从给你的事实里挑一两个带上（用了多久、这周第几件、连续几天、得了多少分、新拿的称号、是不是本周领先、是不是大活），数字只能用给你的，不许编；"
  + "可以损一下但落点是夸；不要“辛苦了”“太棒了”这类套话，不要感叹号连用，不要表情符号，不要加引号和前缀。本地 AI 出的力就顺带调侃一句“会用工具也是本事”之类的。只输出这句话本身。";
/** Says the praise in the group for a task finished outside the chat. */
export async function cheer(hub: Hub, conv: string, task: Task, now = Date.now()): Promise<string> {
  const c = cheerFacts(hub, conv, task, now);
  if (!c) { const line = named(task) + " 做完了" + (task.result ? "：" + clip(task.result, 160) : ""); tell(hub, conv, line); return line; }
  let line = "";
  try {
    const said = (await deps.line(hub, CHEER_SYSTEM, JSON.stringify({ 任务: "#" + task.id + " " + task.title, 结果: clip(task.result, 200), ...c }))).replace(/^["“「]|["”」]$/g, "").trim();
    if (said && said.length <= 160) line = named(task) + " 做完了。" + said + "（" + c.who + " +" + c.points + " 分" + (c.new_badges.length ? "，新称号：" + c.new_badges.map(b => b.split("（")[0]).join("、") : "") + "）";
  } catch (e: any) { console.log("teamwork: praise failed", e?.message); }
  line ||= plainCheer(c, task);
  tell(hub, conv, line);
  return line;
}

// ---------- weekly report ----------
/** What the bot is asked to do on Sunday night; it runs as a normal background task, so it can use its tools. */
export function weeklyTask(stats: TeamStats, done: Task[], covers: string[] = []): string {
  const facts = {
    本周做完: stats.week.done, 本周总分: stats.week.points, 还在做: stats.totals.doing, 没开始: stats.totals.open, 已过期: stats.totals.overdue, 本周之星: stats.mvp || "（没有人得分）",
    每个人: stats.people.filter(p => p.done_week || p.doing.length).map(p => ({ 名字: p.name, 本周做完: p.done_week, 本周得分: p.points_week, 连续天数: p.streak, 正在做: p.doing.map(d => d.title), 称号: p.badges.filter(b => b.earned).map(b => b.name) })),
    本周做完的事: done.map(t => ({ 事: t.title, 谁: creditOf(t), 大小: SIZE_LABEL[t.size], 用时: t.claimed_at ? span(t.done_at - t.claimed_at) : "" })),
  };
  return "发本周的团队战报。下面是这一周任务清单的真实数据，只能用这些数，不许编：\n" + JSON.stringify(facts) +
    "\n规矩：你这一轮只有最后那条回复会发到群里，战报写在最后的回复里，一条消息写完，用你平时的口气，不超过 12 行，不要写成公告，不要标题。内容：这周一共做成了几件、每个人做成了什么（点名，具体到事），本周之星是谁、凭什么；谁手上还压着活、哪件过期了（点到为止，别训人）；最后一句给下周起个头。"
    + (stats.mvp ? "写之前先用 meme 工具给本周之星做一张图发出来（拿保存的形象“奶蛙”套“摸头”这类模板就行，不要用 generate_image）；meme 做不出来就跳过，战报照发。" : "")
    + (covers.length ? "另外，" + covers.join("、") + " 用积分换了这一期的封面人物：用 generate_image 给" + (covers.length > 1 ? "他们各" : "他") + "画一张专属封面发出来（画成奶蛙给他颁奖之类的场面，intent 里写明是战报封面），战报开头点一句这一期的封面人物是谁。" : "")
    + "这周一件都没做成也照实说，别硬夸。";
}
async function weekly(hub: Hub, now: number) {
  const convs = (hub.sql.exec("SELECT DISTINCT conv FROM task").toArray() as any[]).map(r => String(r.conv)).filter(c => !c.startsWith("t:"));
  for (const conv of convs) {
    if (String(hub.edit.cfg(conv, "team_weekly")) !== "on") continue;
    const stats = teamStats(hub, conv, now);
    if (!stats.week.done && !stats.totals.doing && !stats.totals.open && !spends(hub, conv, { state: "pending" }).some(x => x.item === "cover")) continue;
    const done = listTasks(hub, conv, { status: ["done"], limit: 1000 }).filter(t => t.done_at >= stats.week.start).sort((a, b) => a.done_at - b.done_at);
    recordStar(hub, conv, stats);
    const covers = spends(hub, conv, { state: "pending" }).filter(x => x.item === "cover");
    for (const c of covers) settle(hub, conv, c.id, "done", now);
    await hub.runTask(conv, weeklyTask(stats, done, [...new Set(covers.map(c => c.who))]));
  }
}
function tick(hub: Hub, now: number) {
  const today = dayOf(now);
  if (new Date(zonedToUtc(today, "12:00", BJ) + 8 * HOUR).getUTCDay() !== 0) return;
  if (hub.get("team:weekly:day") === today || now < zonedToUtc(today, WEEKLY_AT, BJ)) return;
  hub.set("team:weekly:day", today);
  hub.ctx.waitUntil(weekly(hub, now).catch(e => console.log("teamwork: weekly failed", e?.message)));
}

// ---------- chat tool ----------
const personLine = (p: PersonStats, now: number) => ({
  name: p.name,
  doing: p.doing.map(d => "#" + d.id + " " + d.title + "（" + span(now - d.since) + "前接的" + (d.by_ai ? "，本地 AI 在做" : "") + (d.overdue ? "，已过期" : "") + "）"),
  waiting: p.waiting, done_this_week: p.done_week, points_this_week: p.points_week, done_total: p.done_total, points_total: p.points_total,
  balance: p.balance, spent: p.spent, ...(p.title ? { title: p.title } : {}),
  streak_days: p.streak, fastest: p.fastest_ms ? span(p.fastest_ms) : "", badges: p.badges.filter(b => b.earned).map(b => b.name),
  next_badges: p.badges.filter(b => !b.earned).slice(0, 2).map(b => b.name + "：" + b.what),
});
function tools({ hub, conv, askers }: Ctx): Tool[] {
  return [{
    name: "team",
    description: "团队的协作情况，数据来自任务清单：谁正在做什么、什么时候接的手、这周每个人做成了几件、得了多少分、连续几天有产出、拿了哪些称号、本周之星是谁；也能看一件任务从记下到做完的完整过程。"
      + "有人问“谁在做什么”“大家进度怎么样”“这周战绩”“排行榜”“我有多少分”“我有什么称号”“这件事是谁什么时候接的、做了多久”时用，不要凭印象答。"
      + "op=status：全队现在的情况和本周战绩，每个人的 balance 是还能花的积分（who 填名字只看一个人，mine=true 看提问的人）；op=timeline：一件任务的过程（id 必填）；op=recent：最近发生的事（谁接了、谁做完了）；op=wall：功勋墙（历届本周之星、打下的大活、谁有哪些称号、各项纪录、谁挂着什么头衔）。"
      + "积分能换特权：op=shop 看能换什么、各多少分、提问的人有多少分；有人说要换某样（“我要换甩锅券”“用积分点一张图”），用 op=redeem（item 填名字，note 填他的具体要求，头衔必须给名字）。redeem 成功后返回的 do 就是你现在要做的事，当场照做；返回失败（分不够、没这一项）就照实说，别替他垫分。"
      + "op=fulfil：群主说某次兑换“兑现了”时标记（id 必填）；op=refund：群主说退分时用。op=add_item / remove_item：群主或被授权的人增删自定的特权（name、cost、what），比如“奶茶一杯 30 分，群主请”。"
      + "计分规矩：小事 5 分、普通 10 分、大活 30 分，赶在截止日期前做完再加 5 分；本地 AI 做的算在它主人头上。回答时点名、说具体的事，简短，别念数据表。",
    parameters: {
      type: "object", required: ["op"],
      properties: {
        op: { type: "string", enum: ["status", "timeline", "recent", "wall", "shop", "redeem", "fulfil", "refund", "add_item", "remove_item"] },
        item: { type: "string", description: "redeem：要换的那一项的名字" }, note: { type: "string", description: "redeem：他的具体要求（画什么、什么锅、头衔叫什么……）" },
        name: { type: "string", description: "add_item / remove_item：特权的名字" }, cost: { type: "integer", description: "add_item：要多少分" }, what: { type: "string", description: "add_item：换到的是什么" },
        who: { type: "string", description: "status：只看这个人" }, mine: { type: "boolean", description: "status：只看提问的人" },
        id: { type: "integer", description: "timeline：任务编号；fulfil / refund：兑换记录的编号" }, limit: { type: "integer", description: "recent：最多几条，默认 15" },
      },
    },
    run: async (a: any) => {
      const now = Date.now(), op = String(a.op || "status");
      if (op === "timeline") {
        const tl = taskTimeline(hub, conv, Number(a.id), now);
        if (!tl) return { ok: false, error: "没有这个编号的任务" };
        return {
          ok: true, task: "#" + tl.task.id + " " + tl.task.title, status: tl.task.status, size: SIZE_LABEL[tl.task.size], credited_to: creditOf(tl.task),
          waited_before_pickup: tl.claimed_at ? span(tl.waited_ms) || "马上就接了" : "还没人接", worked: tl.worked_ms ? span(tl.worked_ms) + (tl.done_at ? "" : "（还在做）") : "",
          steps: tl.steps.map(s => dayOf(s.ts).slice(5) + " " + new Date(s.ts + 8 * HOUR).toISOString().slice(11, 16) + " " + (s.who || "有人") + " " + s.word + (s.kind === "progress" || s.kind === "edit" ? "：" + clip(s.text, 80) : "")),
        };
      }
      if (op === "recent") {
        const ev = taskEvents(hub, conv, { limit: Math.min(Number(a.limit) || 15, 40), kinds: ["add", "claim", "done", "drop", "release", "progress"] });
        return { ok: true, events: ev.map(e => span(now - e.ts) + "前 " + (e.who || "有人") + " " + (EVENT_WORD[e.kind] || "") + " #" + e.task + " " + clip(e.title, 30) + (e.kind === "progress" ? "：" + clip(e.text, 60) : "")) };
      }
      const me = askers[askers.length - 1]?.name || "";
      const boss = () => { const r = (hub as any).edit?.rank?.(conv, askers); return r === "owner" || r === "trusted"; };
      if (op === "wall") {
        const w = honorWall(hub, conv, now);
        return {
          ok: true,
          stars: w.stars.map(x => dayOf(x.week).slice(5) + " 那周：" + x.who + "（" + x.points + " 分，" + x.done + " 件）"),
          bosses: w.bosses.map(b => "#" + b.id + " " + b.title + "：" + (b.who || "没记是谁") + "，" + dayOf(b.done_at).slice(5) + (b.took_ms ? "，用了 " + span(b.took_ms) : "")),
          badges: w.badges.filter(b => b.holders.length).map(b => b.name + "（" + b.what + "）：" + b.holders.map(h => h.who).join("、")),
          records: w.records.map(r => r.what + "：" + r.who + "，" + r.value),
          titles: w.titles.map(t => t.who + "：" + t.title + "（到 " + dayOf(t.until).slice(5) + "）"),
          recent_perks: w.perks.slice(0, 8).map(x => x.who + " 换了" + x.name + (x.state === "pending" ? "（还没兑现）" : "")),
          ...(!w.stars.length && !w.bosses.length && !w.badges.some(b => b.holders.length) ? { note: "功勋墙还是空的：还没人做完过任务" } : {}),
        };
      }
      if (op === "shop") {
        const b = me ? balanceOf(hub, conv, personOfName(me) || me, now) : null;
        return { ok: true, ...(b ? { asker: me, balance: b.balance, earned: b.earned, spent: b.spent } : {}), items: shop(hub, conv).map(i => ({ name: i.name, cost: i.cost, what: i.what, ...(i.needs ? { tell_me: i.needs } : {}), ...(i.custom ? { honoured_by: "群主" } : {}) })),
          pending: spends(hub, conv, { state: "pending" }).map(x => "#" + x.id + " " + x.who + " 的" + x.name + (x.note ? "：" + x.note : "")), rule: "积分只能靠做完任务挣，不能转让、不能预支" };
      }
      if (op === "redeem") {
        if (!me) return { ok: false, error: "不知道是谁要换；让他自己在群里说" };
        const r = redeem(hub, conv, me, String(a.item || ""), String(a.note || ""), "chat", now);
        return r.ok ? { ok: true, redeemed: r.spend.name, cost: r.spend.cost, balance_left: r.balance, record: r.spend.id, do: r.do } : r;
      }
      if (op === "fulfil" || op === "refund") {
        if (!boss()) return { ok: false, error: "这个要群主或被授权的人来说" };
        const x = settle(hub, conv, Number(a.id), op === "fulfil" ? "done" : "refunded", now);
        return x ? { ok: true, record: x.id, who: x.who, item: x.name, state: op === "fulfil" ? "兑现了" : "分已退回 " + x.cost } : { ok: false, error: "没有这条兑换记录" };
      }
      if (op === "add_item" || op === "remove_item") {
        if (!boss()) return { ok: false, error: "增删特权要群主或被授权的人来说" };
        if (op === "remove_item") return dropItem(hub, conv, String(a.name || "")) ? { ok: true, removed: a.name } : { ok: false, error: "没有这一项自定的特权（自带的那几项删不了）" };
        const it = setItem(hub, conv, String(a.name || ""), Number(a.cost), String(a.what || ""), me, now);
        return typeof it === "string" ? { ok: false, error: it } : { ok: true, added: it.name, cost: it.cost, note: "这一项要人来兑现：有人换了之后我会在群里说，兑现后说一声“兑现了”" };
      }
      const stats = teamStats(hub, conv, now);
      const want = a.mine ? me : String(a.who || "").trim();
      const people = want ? stats.people.filter(p => p.name === want || p.name.includes(want)) : stats.people;
      if (want && !people.length) return { ok: true, note: want + " 在任务清单里还没有记录：没接过也没做完过任务" };
      return {
        ok: true,
        this_week: { done: stats.week.done, points: stats.week.points, star: stats.mvp || "还没有人得分" },
        now: { in_progress: stats.totals.doing, not_started: stats.totals.open, overdue: stats.totals.overdue },
        people: people.map(p => personLine(p, now)),
      };
    },
  }];
}

const feature: Feature = {
  name: "teamwork",
  schema: SHOP_SCHEMA,
  tunables: {
    team_praise: { default: "on", options: ["on", "off"], what: "有人在看板上或用本地 AI 做完任务时，在群里夸一句（带上他这周的战绩）" },
    team_weekly: { default: "on", options: ["on", "off"], what: "每周日晚上发一份团队战报：这周谁做成了什么、本周之星" },
  },
  tools,
  tick,
  about: [
    "任务清单同时是团队的记分牌：每件任务记着谁记下的、谁什么时候接的手、做了多久、什么时候做完，看板上能看到完整过程。",
    "做完一件事有分：小事 5 分、普通 10 分、大活 30 分，赶在截止日期前做完再加 5 分；本地 AI 做完的算在它主人头上。还有称号（开张、屠龙、闪电、三天不断等），都是从任务记录里算出来的，不是我随口封的。",
    "积分能换特权：定制表情包 5 分、点一段方言语音 10 分、甩锅券 15 分、点一张图 20 分、专属头衔一周 25 分、代办券 40 分、战报封面人物 50 分；群主还能加自定的（比如请奶茶）。积分只能靠做完任务挣，不能转让、不能预支，换了就从余额里扣。在群里跟我说“我要换……”，或者在看板上点。",
    "功勋墙记着历届本周之星、打下来的大活、谁拿了哪些称号、各项纪录和大家挂着的头衔，看板上有，在群里问我也行。",
    "有人做完任务我会在群里夸一句，说的数（这周第几件、连续几天、用了多久）都来自记录；每周日晚上九点半发一份战报，点名这周谁做成了什么、谁是本周之星。不想要可以关（team_praise、team_weekly）。",
  ],
};
export default feature;

// A finished task is praised here. In the chat the bot's own reply does the praising, so only the facts are handed over.
hooks.done = (hub, conv, task, _who, quiet) => {
  if (quiet) return;
  if (String((hub as any).edit?.cfg?.(conv, "team_praise") ?? "on") !== "on") { tell(hub, conv, named(task) + " 做完了" + (task.result ? "：" + clip(task.result, 160) : "")); return; }
  const p = cheer(hub, conv, task).catch(e => console.log("teamwork: cheer failed", e?.message));
  (hub as any).ctx?.waitUntil?.(p);
};
hooks.facts = (hub, conv, task) => cheerFacts(hub, conv, task);
