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
    };
  }).sort((a, b) => b.points_week - a.points_week || b.points_total - a.points_total || b.doing.length - a.doing.length || a.name.localeCompare(b.name, "zh"));
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
export function weeklyTask(stats: TeamStats, done: Task[]): string {
  const facts = {
    本周做完: stats.week.done, 本周总分: stats.week.points, 还在做: stats.totals.doing, 没开始: stats.totals.open, 已过期: stats.totals.overdue, 本周之星: stats.mvp || "（没有人得分）",
    每个人: stats.people.filter(p => p.done_week || p.doing.length).map(p => ({ 名字: p.name, 本周做完: p.done_week, 本周得分: p.points_week, 连续天数: p.streak, 正在做: p.doing.map(d => d.title), 称号: p.badges.filter(b => b.earned).map(b => b.name) })),
    本周做完的事: done.map(t => ({ 事: t.title, 谁: creditOf(t), 大小: SIZE_LABEL[t.size], 用时: t.claimed_at ? span(t.done_at - t.claimed_at) : "" })),
  };
  return "发本周的团队战报。下面是这一周任务清单的真实数据，只能用这些数，不许编：\n" + JSON.stringify(facts) +
    "\n规矩：你这一轮只有最后那条回复会发到群里，战报写在最后的回复里，一条消息写完，用你平时的口气，不超过 12 行，不要写成公告，不要标题。内容：这周一共做成了几件、每个人做成了什么（点名，具体到事），本周之星是谁、凭什么；谁手上还压着活、哪件过期了（点到为止，别训人）；最后一句给下周起个头。"
    + (stats.mvp ? "写之前先用 meme 工具给本周之星做一张图发出来（拿保存的形象“奶蛙”套“摸头”这类模板就行，不要用 generate_image）；meme 做不出来就跳过，战报照发。" : "")
    + "这周一件都没做成也照实说，别硬夸。";
}
async function weekly(hub: Hub, now: number) {
  const convs = (hub.sql.exec("SELECT DISTINCT conv FROM task").toArray() as any[]).map(r => String(r.conv)).filter(c => !c.startsWith("t:"));
  for (const conv of convs) {
    if (String(hub.edit.cfg(conv, "team_weekly")) !== "on") continue;
    const stats = teamStats(hub, conv, now);
    if (!stats.week.done && !stats.totals.doing && !stats.totals.open) continue;
    const done = listTasks(hub, conv, { status: ["done"], limit: 1000 }).filter(t => t.done_at >= stats.week.start).sort((a, b) => a.done_at - b.done_at);
    await hub.runTask(conv, weeklyTask(stats, done));
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
  streak_days: p.streak, fastest: p.fastest_ms ? span(p.fastest_ms) : "", badges: p.badges.filter(b => b.earned).map(b => b.name),
  next_badges: p.badges.filter(b => !b.earned).slice(0, 2).map(b => b.name + "：" + b.what),
});
function tools({ hub, conv, askers }: Ctx): Tool[] {
  return [{
    name: "team",
    description: "团队的协作情况，数据来自任务清单：谁正在做什么、什么时候接的手、这周每个人做成了几件、得了多少分、连续几天有产出、拿了哪些称号、本周之星是谁；也能看一件任务从记下到做完的完整过程。"
      + "有人问“谁在做什么”“大家进度怎么样”“这周战绩”“排行榜”“我有多少分”“我有什么称号”“这件事是谁什么时候接的、做了多久”时用，不要凭印象答。"
      + "op=status：全队现在的情况和本周战绩（who 填名字只看一个人，mine=true 看提问的人）；op=timeline：一件任务的过程（id 必填）；op=recent：最近发生的事（谁接了、谁做完了）。"
      + "计分规矩：小事 5 分、普通 10 分、大活 30 分，赶在截止日期前做完再加 5 分；本地 AI 做的算在它主人头上。回答时点名、说具体的事，简短，别念数据表。",
    parameters: {
      type: "object", required: ["op"],
      properties: {
        op: { type: "string", enum: ["status", "timeline", "recent"] },
        who: { type: "string", description: "status：只看这个人" }, mine: { type: "boolean", description: "status：只看提问的人" },
        id: { type: "integer", description: "timeline：任务编号" }, limit: { type: "integer", description: "recent：最多几条，默认 15" },
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
      const stats = teamStats(hub, conv, now), me = askers[askers.length - 1]?.name || "";
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
  tunables: {
    team_praise: { default: "on", options: ["on", "off"], what: "有人在看板上或用本地 AI 做完任务时，在群里夸一句（带上他这周的战绩）" },
    team_weekly: { default: "on", options: ["on", "off"], what: "每周日晚上发一份团队战报：这周谁做成了什么、本周之星" },
  },
  tools,
  tick,
  about: [
    "任务清单同时是团队的记分牌：每件任务记着谁记下的、谁什么时候接的手、做了多久、什么时候做完，看板上能看到完整过程。",
    "做完一件事有分：小事 5 分、普通 10 分、大活 30 分，赶在截止日期前做完再加 5 分；本地 AI 做完的算在它主人头上。还有称号（开张、屠龙、闪电、三天不断等），都是从任务记录里算出来的，不是我随口封的。",
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
