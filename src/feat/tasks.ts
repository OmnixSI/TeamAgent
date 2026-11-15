// The group's task list: things people said they would do, or asked someone to do. The chat model records them
// through the `tasks` tool; once a night the previous day's chat is read once more to catch what it missed,
// what got finished and what was given up. The board and the MCP server read and change tasks through the
// exported functions below, whose signatures are a fixed contract.
import type { Feature, Ctx } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Tool } from "../core.ts";
import { dsChat } from "../llm.ts";
import { BJ, clip, fmtDate, fmtFull, zonedToUtc } from "../util.ts";

export type TaskStatus = "open" | "doing" | "done" | "dropped";
export type Task = {
  id: number; conv: string; title: string; detail: string; status: TaskStatus;
  owner: string;        // who is meant to do it (a group member's name, "bot", or "")
  due: string;          // "2026-11-20" or ""
  source: string;       // where it came from: a short quote from the chat, or "看板" / "本地 AI"
  by: string;           // who created it
  claimed_by: string;   // who (person or local AI) picked it up, or ""
  result: string;       // what was delivered when done: text, links, file references
  created: number; updated: number;
  size: TaskSize;       // how big a job it is; a "big" one is the group's boss fight
  claimed_at: number;   // when someone took it (0 while nobody has)
  done_at: number;      // when it was finished (0 until then)
  done_by: string;      // the person credited with finishing it (a local AI's work counts for its person)
  priority: TaskPriority; // 1 urgent, 2 normal, 3 can wait
  after: number[];      // tasks that have to be finished before this one can start
  parent: number;       // the task this one was split off from (0 for none)
  runs: number;         // how many times the bot has set out to work on it by itself
};
export type TaskPriority = 1 | 2 | 3;
export const PRIORITY_LABEL: Record<number, string> = { 1: "急", 2: "普通", 3: "不急" };
/** What a task carries for whoever takes it over: the words it came from, reports, links, files. */
export type RefKind = "quote" | "report" | "link" | "file";
export const REF_KINDS: RefKind[] = ["quote", "report", "link", "file"];
export const REF_LABEL: Record<RefKind, string> = { quote: "原话", report: "报告", link: "链接", file: "文件" };
export type TaskRef = { id: number; task: number; ts: number; who: string; kind: RefKind; title: string; ref: string; text: string };
/** Everything someone needs to pick a task up cold. */
export type Handoff = {
  task: Task;
  materials: (TaskRef & { from?: number })[];   // `from` is the parent task a piece was inherited from
  waits_for: { id: number; title: string; status: TaskStatus; owner: string; result: string }[];
  blocked_by: number[];
  parent: { id: number; title: string; status: TaskStatus; result: string } | null;
  children: { id: number; title: string; status: TaskStatus; owner: string }[];
  notes: TaskNote[];
};
export type TaskSize = "small" | "normal" | "big";
export const SIZES: TaskSize[] = ["small", "normal", "big"];
export const SIZE_LABEL: Record<TaskSize, string> = { small: "小事", normal: "普通", big: "大活" };
export type TaskNote = { ts: number; who: string; text: string; kind?: string };

const STATUSES: TaskStatus[] = ["open", "doing", "done", "dropped"];
const LABEL: Record<TaskStatus, string> = { open: "没开始", doing: "在做", done: "做完了", dropped: "不做了" };
const NIGHT = "夜间整理";
const EXTRACT_AT = "02:30";   // Beijing; the previous day is complete and the group is asleep
const REMIND_AT = "09:00";
const DAY_MSGS = 3000;        // messages read for one day at most
const LIMIT = { title: 120, detail: 1000, source: 200, result: 2000, note: 1000, who: 40, refTitle: 120, ref: 600, refText: 40000, quote: 6000, refs: 40 };
export const BOT = "bot";
export const isBot = (name: string) => String(name || "").trim().toLowerCase() === BOT;

/** Seam the tests replace: the chat model for the nightly pass. */
export const deps = {
  model: async (hub: Hub, system: string, user: string): Promise<{ text: string; usage: any }> => {
    const r = await dsChat(hub.env, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: 24000, label: "任务提取" }, "high", 240000);   // the limit covers the reasoning too: 6,000 ran out on a 1,300-message day before any answer came
    return { text: String(r.message?.content || ""), usage: r.usage || {} };
  },
};

// ---------- storage ----------
const ofRow = (r: any): Task => ({
  id: Number(r.id), conv: String(r.conv), title: String(r.title || ""), detail: String(r.detail || ""), status: (STATUSES.includes(r.status) ? r.status : "open") as TaskStatus,
  owner: String(r.owner || ""), due: String(r.due || ""), source: String(r.source || ""), by: String(r.made_by || ""), claimed_by: String(r.claimed_by || ""),
  result: String(r.result || ""), created: Number(r.created), updated: Number(r.updated),
  size: (SIZES.includes(r.size) ? r.size : "normal") as TaskSize, claimed_at: Number(r.claimed_at) || 0, done_at: Number(r.done_at) || 0, done_by: String(r.done_by || ""),
  priority: ([1, 2, 3].includes(Number(r.priority)) ? Number(r.priority) : 2) as TaskPriority, after: parseIds(r.after), parent: Number(r.parent) || 0, runs: Number(r.runs) || 0,
});
/** "25,26", "#25 #26" or [25, 26] → [25, 26]. */
export function parseIds(v: unknown): number[] {
  const parts = Array.isArray(v) ? v : String(v ?? "").split(/[^0-9]+/);
  return [...new Set(parts.map(x => Math.floor(Number(x))).filter(n => n > 0))].slice(0, 12);
}
/** 1 / 2 / 3 from a number or a word ("high", "急", "low", "不急"…); 0 when it is not a priority. */
export function normPriority(v: unknown): TaskPriority | 0 {
  const t = String(v ?? "").trim().toLowerCase();
  if (["1", "high", "urgent", "急", "高", "紧急", "优先"].includes(t)) return 1;
  if (["2", "normal", "medium", "中", "普通"].includes(t)) return 2;
  if (["3", "low", "低", "不急"].includes(t)) return 3;
  return 0;
}
/** Columns added after the first release: a table made before them gets them on first use. */
const ready = new WeakSet<object>();
function ensure(hub: Hub) {
  if (ready.has(hub)) return;
  ready.add(hub);
  const add = (table: string, col: string, def: string) => {
    try {
      const have = hub.sql.exec("PRAGMA table_info(" + table + ")").toArray().map((c: any) => String(c.name));
      if (have.length && !have.includes(col)) hub.sql.exec("ALTER TABLE " + table + " ADD COLUMN " + col + " " + def);
    } catch (e: any) { console.log("tasks: column", col, e?.message); }
  };
  add("task", "size", "TEXT DEFAULT 'normal'"); add("task", "claimed_at", "INTEGER DEFAULT 0"); add("task", "done_at", "INTEGER DEFAULT 0"); add("task", "done_by", "TEXT DEFAULT ''");
  add("task_note", "kind", "TEXT DEFAULT ''");
  add("task", "priority", "INTEGER DEFAULT 2"); add("task", "after", "TEXT DEFAULT ''"); add("task", "parent", "INTEGER DEFAULT 0");
  add("task", "runs", "INTEGER DEFAULT 0"); add("task", "last_run", "INTEGER DEFAULT 0");
  // Tasks finished before finish times were kept: the last change to them was the finishing, so that is their time.
  try { hub.sql.exec("UPDATE task SET done_at=updated WHERE status='done' AND (done_at IS NULL OR done_at=0)"); } catch (e: any) { console.log("tasks: backfill", e?.message); }
}
/** The person behind a name on a task: someone's local AI works for that someone; the bot and the nightly pass are nobody. */
export function personOfName(name: string): string {
  const n = String(name || "").trim().replace(/的本地\s*AI$/i, "").trim();
  return !n || /^(bot|夜间整理|群友|有人)$/i.test(n) ? "" : n;
}
const clean = (s: unknown, n: number) => clip(String(s ?? "").trim(), n);
/** `kind` says what happened, for timelines: add, claim, progress, done, drop, release, reopen, edit. */
const note = (hub: Hub, conv: string, id: number, who: string, text: string, ts = Date.now(), kind = "edit") => {
  ensure(hub);
  hub.sql.exec("INSERT INTO task_note(task,conv,ts,who,text,kind) VALUES(?,?,?,?,?,?)", id, conv, ts, clean(who, LIMIT.who), clean(text, LIMIT.note), kind);
};
/** What the team feature hangs on a finished task (praise, tallies); set from src/feat/teamwork.ts. */
export const hooks: {
  done: null | ((hub: Hub, conv: string, task: Task, who: string, quiet: boolean) => void);
  /** Facts worth saying when a task was finished in the chat: the person's tally, streak, new badges. */
  facts: null | ((hub: Hub, conv: string, task: Task) => any);
} = { done: null, facts: null };

/** "2026-11-20", "11-20", "11月20日", "今天/明天/后天" → "YYYY-MM-DD"; anything else → "". */
export function normDue(s: unknown, now = Date.now()): string {
  const t = String(s ?? "").trim();
  if (!t) return "";
  const rel = ({ "今天": 0, "今日": 0, "明天": 1, "明日": 1, "后天": 2 } as Record<string, number>)[t];
  if (rel !== undefined) return fmtDate(now + rel * 86400000, BJ);
  let m = t.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/);
  let y = m ? Number(m[1]) : Number(fmtDate(now, BJ).slice(0, 4)), mo: number, d: number;
  if (m) { mo = Number(m[2]); d = Number(m[3]); }
  else {
    m = t.match(/^(\d{1,2})[-/.月](\d{1,2})[日号]?$/);
    if (!m) return "";
    mo = Number(m[1]); d = Number(m[2]);
    // A bare month and day that already passed this year means next year's.
    if (Date.UTC(y, mo - 1, d) < Date.UTC(y, Number(fmtDate(now, BJ).slice(5, 7)) - 1, Number(fmtDate(now, BJ).slice(8, 10))) - 60 * 86400000) y++;
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return "";
  return dt.toISOString().slice(0, 10);
}

export function listTasks(hub: Hub, conv: string, f: { status?: TaskStatus[]; owner?: string; limit?: number } = {}): Task[] {
  const where = ["conv=?"], binds: any[] = [conv];
  ensure(hub);
  const st = (f.status || []).filter(s => STATUSES.includes(s));
  if (st.length) { where.push("status IN (" + st.map(() => "?").join(",") + ")"); binds.push(...st); }
  if (f.owner) { where.push("(owner=? OR claimed_by=?)"); binds.push(f.owner, f.owner); }
  const limit = Math.max(1, Math.min(1000, Math.floor(Number(f.limit) || 200)));
  return hub.sql.exec("SELECT * FROM task WHERE " + where.join(" AND ") +
    " ORDER BY CASE status WHEN 'doing' THEN 0 WHEN 'open' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, CASE WHEN status IN ('open','doing') THEN COALESCE(priority,2) ELSE 2 END, CASE WHEN due='' THEN 1 ELSE 0 END, due, updated DESC LIMIT ?", ...binds, limit).toArray().map(ofRow);
}

export function getTask(hub: Hub, conv: string, id: number): Task | null {
  ensure(hub);
  const r = hub.sql.exec("SELECT * FROM task WHERE conv=? AND id=?", conv, Math.floor(Number(id)) || 0).toArray()[0];
  return r ? ofRow(r) : null;
}

const active = (t: Task | null | undefined): t is Task => !!t && (t.status === "open" || t.status === "doing");
/** The unfinished tasks this one is waiting for. */
export function blockers(hub: Hub, conv: string, t: Task): Task[] {
  return t.after.map(id => getTask(hub, conv, id)).filter(active);
}
/** Checks a "do these first" list for a task (0 for one not made yet): every id must exist and none may end up waiting for this task in turn. */
export function checkAfter(hub: Hub, conv: string, self: number, ids: number[]): { ids: number[]; error?: string } {
  for (const id of ids) {
    if (id === self) return { ids: [], error: "任务不能排在自己后面" };
    if (!getTask(hub, conv, id)) return { ids: [], error: "没有编号 " + id + " 的任务" };
    const seen = new Set<number>(), stack = [id];
    while (self && stack.length) {
      const x = stack.pop()!;
      if (x === self) return { ids: [], error: "#" + id + " 自己就在等 #" + self + " 做完，这样排两件事会互相等" };
      if (seen.has(x)) continue;
      seen.add(x); stack.push(...(getTask(hub, conv, x)?.after || []));
    }
  }
  return { ids };
}
/**
 * Unfinished tasks in the order to work on them: what is under way, then what can start now (urgent first,
 * then by due date, then oldest), then what is still waiting for another task. `blocked_by` lists what it waits for.
 */
export function workOrder(hub: Hub, conv: string): { task: Task; blocked_by: number[] }[] {
  const rows = listTasks(hub, conv, { status: ["open", "doing"], limit: 1000 }).map(task => ({ task, blocked_by: blockers(hub, conv, task).map(b => b.id) }));
  const key = (r: { task: Task; blocked_by: number[] }) => [r.blocked_by.length ? 1 : 0, r.blocked_by.length ? 0 : r.task.status === "doing" ? 0 : 1, r.task.priority, r.task.due ? 0 : 1, r.task.due, r.task.id] as (number | string)[];
  return rows.sort((a, b) => { const x = key(a), y = key(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
}
/** Tasks that were waiting for `id` and have nothing left to wait for. */
export function unblockedBy(hub: Hub, conv: string, id: number): Task[] {
  return listTasks(hub, conv, { status: ["open", "doing"], limit: 1000 }).filter(t => t.after.includes(id) && !blockers(hub, conv, t).length);
}

/**
 * One line in the group when something happens to a task outside the chat (on the board, or by someone's
 * local AI). Changes made by talking to the bot pass `quiet`: the bot's own reply already says it.
 */
export function tell(hub: Hub, conv: string, text: string) {
  try {
    if (String((hub as any).edit?.cfg?.(conv, "tasks_announce") ?? "on") !== "on") return;
    const p = (hub as any).say?.(conv, "【任务】" + text);
    if (p && typeof p.catch === "function") { const q = p.catch((e: any) => console.log("tasks: notice failed", e?.message)); (hub as any).ctx?.waitUntil?.(q); }
  } catch (e: any) { console.log("tasks: notice failed", e?.message); }
}
export const named = (t: Task) => "#" + t.id + "「" + clip(t.title, 40) + "」";

export function addTask(hub: Hub, conv: string, t: { title: string; detail?: string; owner?: string; due?: string; source?: string; by?: string; size?: TaskSize; priority?: unknown; after?: unknown; parent?: number }, quiet = false): Task | null {
  const title = clean(t?.title, LIMIT.title);
  if (!title) return null;
  const now = Date.now(), by = clean(t.by, LIMIT.who);
  ensure(hub);
  // Ids that do not exist are left out rather than refusing the whole task; callers that want to complain use checkAfter first.
  const after = parseIds(t.after).filter(id => !!getTask(hub, conv, id)), parent = getTask(hub, conv, Number(t.parent) || 0)?.id || 0;
  hub.sql.exec("INSERT INTO task(conv,title,detail,status,owner,due,source,made_by,claimed_by,result,created,updated,size,priority,after,parent) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    conv, title, clean(t.detail, LIMIT.detail), "open", clean(t.owner, LIMIT.who), normDue(t.due, now), clean(t.source, LIMIT.source), by, "", "", now, now, SIZES.includes(t.size as TaskSize) ? t.size! : "normal",
    normPriority(t.priority) || 2, after.join(","), parent);
  const id = Number(hub.sql.exec("SELECT MAX(id) id FROM task WHERE conv=?", conv).toArray()[0]?.id);
  note(hub, conv, id, by, "记下了这件事" + (t.source ? "：“" + clean(t.source, 80) + "”" : "") + (parent ? "（从 #" + parent + " 拆出来的）" : "") + (after.length ? "，排在 " + after.map(x => "#" + x).join("、") + " 之后" : ""), now, "add");
  const made = getTask(hub, conv, id);
  if (made && !quiet) tell(hub, conv, (by || "有人") + " 加了 " + named(made) + (made.size === "big" ? "（大活）" : "") + (made.priority === 1 ? "（急）" : "") + (made.owner ? "，交给 " + made.owner : "") + (made.due ? "，" + made.due + " 前" : "") + (after.length ? "，要等 " + after.map(x => "#" + x).join("、") + " 做完" : ""));
  return made;
}

/** Changes fields of a task; `who` is recorded in the task's notes. Returns the task, or null when it does not exist. */
export function updateTask(hub: Hub, conv: string, id: number, patch: Partial<Pick<Task, "title" | "detail" | "status" | "owner" | "due" | "result" | "size">> & { priority?: unknown; after?: unknown }, who = "", quiet = false): Task | null {
  const cur = getTask(hub, conv, id);
  if (!cur) return null;
  const next: Record<string, string | number> = {}, lines: [string, string][] = [];
  const set = (k: string, v: string, line: string, kind = "edit") => { if (v !== (cur as any)[k]) { next[k] = v; lines.push([line, kind]); } };
  if (patch.title !== undefined) { const v = clean(patch.title, LIMIT.title); if (v) set("title", v, "标题改成“" + v + "”"); }
  if (patch.detail !== undefined) { const v = clean(patch.detail, LIMIT.detail); set("detail", v, v ? "补充说明：" + clip(v, 200) : "清掉了说明"); }
  if (patch.owner !== undefined) { const v = clean(patch.owner, LIMIT.who); set("owner", v, v ? "交给 " + v : "不再指定谁做"); }
  if (patch.due !== undefined) { const v = normDue(patch.due); set("due", v, v ? "截止日期定为 " + v : "去掉了截止日期"); }
  if (patch.size !== undefined && SIZES.includes(patch.size)) set("size", patch.size, "定为" + SIZE_LABEL[patch.size]);
  if (patch.result !== undefined) { const v = clean(patch.result, LIMIT.result); set("result", v, v ? "结果：" + clip(v, 300) : "清掉了结果", "progress"); }
  if (patch.priority !== undefined) { const v = normPriority(patch.priority); if (v && v !== cur.priority) { next.priority = v; lines.push(["优先级改成“" + PRIORITY_LABEL[v] + "”", "edit"]); } }
  if (patch.after !== undefined) {
    const ok = checkAfter(hub, conv, cur.id, parseIds(patch.after));
    if (!ok.error && ok.ids.join(",") !== cur.after.join(",")) { next.after = ok.ids.join(","); lines.push([ok.ids.length ? "排在 " + ok.ids.map(x => "#" + x).join("、") + " 之后" : "不用等别的任务了", "edit"]); }
  }
  const now = Date.now();
  if (patch.status !== undefined && STATUSES.includes(patch.status) && patch.status !== cur.status) {
    const to = patch.status;
    set("status", to, "状态：" + LABEL[cur.status] + " → " + LABEL[to], to === "done" ? "done" : to === "dropped" ? "drop" : cur.status === "done" || cur.status === "dropped" ? "reopen" : to === "doing" ? "claim" : "release");
    if (to === "done") { next.done_at = now; next.done_by = personOfName(cur.claimed_by) || personOfName(cur.owner) || personOfName(who); if (!cur.claimed_at) next.claimed_at = cur.created; }
    else if (cur.done_at) { next.done_at = 0; next.done_by = ""; }
    if (to === "doing" && !cur.claimed_at) next.claimed_at = now;
    // Put back to "not started" means nobody holds it any more, so someone else can pick it up.
    if (to === "open" && cur.claimed_by) { next.claimed_by = ""; next.claimed_at = 0; lines.push([cur.claimed_by + " 放下了，可以重新领取", "release"]); }
  }
  if (!lines.length) return cur;
  const keys = Object.keys(next);
  hub.sql.exec("UPDATE task SET " + keys.map(k => k + "=?").join(",") + ", updated=? WHERE conv=? AND id=?", ...keys.map(k => next[k]), now, conv, cur.id);
  for (const [l, kind] of lines) note(hub, conv, cur.id, who, l, now, kind);
  const after = getTask(hub, conv, cur.id);
  if (after && !quiet && next.status) {
    const by = who || "有人";
    // A finished task is the team feature's moment (praise with the person's tally); the plain line is the fallback.
    if (next.status === "done") { if (!hooks.done) tell(hub, conv, named(after) + " 做完了（" + by + "）" + (after.result ? "：" + clip(after.result, 160) : "")); }
    else if (next.status === "dropped") tell(hub, conv, named(after) + " 不做了（" + by + "）");
    else if (next.status === "open" && cur.claimed_by) tell(hub, conv, cur.claimed_by + " 放下了 " + named(after) + "，谁有空可以接");
    else if (next.status === "doing") tell(hub, conv, by + " 开始做 " + named(after));
  }
  if (after && next.status === "done" && hooks.done) { try { hooks.done(hub, conv, after, who, quiet); } catch (e: any) { console.log("tasks: done hook failed", e?.message); } }
  if (after && (next.status === "done" || next.status === "dropped")) {
    // Whatever was waiting for this one can start; the bot's own waiting tasks get their tries back and are picked up by themselves.
    const free = unblockedBy(hub, conv, after.id);
    for (const t of free) {
      note(hub, conv, t.id, who, "#" + after.id + " " + (next.status === "done" ? "做完了" : "不做了") + "，这件可以开始了", now, "ready");
      hub.sql.exec("UPDATE task SET runs=0, last_run=0 WHERE conv=? AND id=?", conv, t.id);
    }
    if (free.length && !quiet) tell(hub, conv, "#" + after.id + " " + (next.status === "done" ? "做完" : "取消") + "之后，" + free.map(t => named(t) + (t.owner || t.claimed_by ? "（" + (t.claimed_by || t.owner) + "）" : "")).join("、") + " 可以开始了");
  }
  return after;
}

/** Marks a task as picked up by `who` and in progress; null when it does not exist, is finished, or is already claimed by someone else. */
export function claimTask(hub: Hub, conv: string, id: number, who: string, quiet = false): Task | null {
  const cur = getTask(hub, conv, id), w = clean(who, LIMIT.who);
  if (!cur || !w || cur.status === "done" || cur.status === "dropped") return null;
  if (cur.claimed_by && cur.claimed_by !== w) return null;
  if (cur.claimed_by === w && cur.status === "doing") return cur;
  const now = Date.now();
  hub.sql.exec("UPDATE task SET claimed_by=?, status='doing', updated=?, claimed_at=? WHERE conv=? AND id=?", w, now, cur.claimed_at || now, conv, cur.id);
  note(hub, conv, cur.id, w, cur.claimed_by ? "接着做" : "认领了，开始做", now, "claim");
  const after = getTask(hub, conv, cur.id);
  if (after && !quiet) tell(hub, conv, w + " 接了 " + named(after) + "，开干了");
  return after;
}

/** What an old note (written before notes carried a kind) was about, read off its wording. */
export function kindOf(text: string): string {
  if (text.startsWith("记下了这件事")) return "add";
  if (text.startsWith("认领了") || text === "接着做") return "claim";
  if (/^状态：.* → 做完了$/.test(text)) return "done";
  if (/^状态：.* → 不做了$/.test(text)) return "drop";
  if (text.endsWith("可以重新领取") || /^状态：.* → 没开始$/.test(text)) return "release";
  if (/^状态：/.test(text)) return "claim";
  if (/^(标题改成|补充说明|清掉了|交给 |不再指定|截止日期|去掉了截止|定为)/.test(text)) return "edit";
  return "progress";
}

export function addTaskNote(hub: Hub, conv: string, id: number, who: string, text: string): boolean {
  const t = clean(text, LIMIT.note);
  if (!t || !getTask(hub, conv, id)) return false;
  const now = Date.now();
  note(hub, conv, Number(id), who, t, now, "progress");
  hub.sql.exec("UPDATE task SET updated=? WHERE conv=? AND id=?", now, conv, Number(id));
  return true;
}

export function taskNotes(hub: Hub, conv: string, id: number): TaskNote[] {
  ensure(hub);
  return hub.sql.exec("SELECT ts, who, text, kind FROM task_note WHERE conv=? AND task=? ORDER BY ts, id", conv, Math.floor(Number(id)) || 0).toArray()
    .map((r: any) => ({ ts: Number(r.ts), who: String(r.who || ""), text: String(r.text || ""), kind: String(r.kind || "") || kindOf(String(r.text || "")) }));
}

// ---------- what a task carries: original words, reports, links, files ----------
const ofRef = (r: any): TaskRef => ({ id: Number(r.id), task: Number(r.task), ts: Number(r.ts), who: String(r.who || ""), kind: (REF_KINDS.includes(r.kind) ? r.kind : "link") as RefKind, title: String(r.title || ""), ref: String(r.ref || ""), text: String(r.text || "") });
/**
 * Attaches material to a task: `text` is the content itself (the words from the chat, a report's full text),
 * `ref` is where it lives (a URL, or a file / picture number like x12 or g300). The same piece is not attached twice.
 */
export function addTaskRef(hub: Hub, conv: string, id: number, r: { kind: RefKind; title?: string; ref?: string; text?: string; who?: string }): TaskRef | null {
  const t = getTask(hub, conv, id);
  if (!t || !REF_KINDS.includes(r?.kind)) return null;
  const text = clean(r.text, r.kind === "quote" ? LIMIT.quote : LIMIT.refText), ref = clean(r.ref, LIMIT.ref);
  if (!text && !ref) return null;
  const have = taskRefs(hub, conv, t.id);
  const same = have.find(x => x.kind === r.kind && x.ref === ref && x.text === text);
  if (same) return same;
  if (have.length >= LIMIT.refs) return null;
  const now = Date.now(), who = clean(r.who, LIMIT.who), title = clean(r.title, LIMIT.refTitle) || (r.kind === "quote" ? "群里的原话" : REF_LABEL[r.kind]);
  hub.sql.exec("INSERT INTO task_ref(task,conv,ts,who,kind,title,ref,text) VALUES(?,?,?,?,?,?,?,?)", t.id, conv, now, who, r.kind, title, ref, text);
  const row = hub.sql.exec("SELECT MAX(id) id FROM task_ref WHERE conv=? AND task=?", conv, t.id).toArray()[0] as any;
  if (r.kind !== "quote") note(hub, conv, t.id, who, "挂上了" + REF_LABEL[r.kind] + "《" + title + "》" + (ref ? " " + clip(ref, 120) : ""), now, "attach");
  hub.sql.exec("UPDATE task SET updated=? WHERE conv=? AND id=?", now, conv, t.id);
  return { id: Number(row.id), task: t.id, ts: now, who, kind: r.kind, title, ref, text };
}
export function taskRefs(hub: Hub, conv: string, id: number): TaskRef[] {
  ensure(hub);
  return hub.sql.exec("SELECT * FROM task_ref WHERE conv=? AND task=? ORDER BY ts, id", conv, Math.floor(Number(id)) || 0).toArray().map(ofRef);
}
export function removeTaskRef(hub: Hub, conv: string, id: number, refId: number, who = ""): boolean {
  const r = taskRefs(hub, conv, id).find(x => x.id === Number(refId));
  if (!r) return false;
  hub.sql.exec("DELETE FROM task_ref WHERE conv=? AND task=? AND id=?", conv, r.task, r.id);
  note(hub, conv, r.task, who, "拿掉了" + REF_LABEL[r.kind] + "《" + r.title + "》", Date.now(), "edit");
  return true;
}
/** The whole package for taking a task over: its materials (and those of the task it was split from), what it waits for, its parent and children, its notes. */
export function handoff(hub: Hub, conv: string, id: number): Handoff | null {
  const task = getTask(hub, conv, id);
  if (!task) return null;
  const materials: Handoff["materials"] = taskRefs(hub, conv, task.id);
  const seen = new Set([task.id]);
  for (let up = task.parent, hop = 0; up && !seen.has(up) && hop < 5; hop++) {
    seen.add(up);
    const p = getTask(hub, conv, up);
    if (!p) break;
    materials.push(...taskRefs(hub, conv, p.id).map(r => ({ ...r, from: p.id })));
    up = p.parent;
  }
  const parent = getTask(hub, conv, task.parent);
  return {
    task, materials,
    waits_for: task.after.map(x => getTask(hub, conv, x)).filter((x): x is Task => !!x).map(x => ({ id: x.id, title: x.title, status: x.status, owner: x.claimed_by || x.owner, result: x.result })),
    blocked_by: blockers(hub, conv, task).map(b => b.id),
    parent: parent ? { id: parent.id, title: parent.title, status: parent.status, result: parent.result } : null,
    children: hub.sql.exec("SELECT * FROM task WHERE conv=? AND parent=? ORDER BY id", conv, task.id).toArray().map(ofRow).map(c => ({ id: c.id, title: c.title, status: c.status, owner: c.claimed_by || c.owner })),
    notes: taskNotes(hub, conv, task.id),
  };
}
/** The words a task came from, as they were said: the last few messages of the people asking, with time and name. */
export function quoteOf(hub: Hub, conv: string, askerIds: string[], now = Date.now()): string {
  if (!askerIds.length || typeof (hub as any).recent !== "function") return "";
  const rows = ((hub as any).recent(conv, 60) as any[]).filter(r => r.role === "user" && askerIds.includes(String(r.sender || "")) && now - Number(r.ts) < 30 * 60000 && String(r.text || "").trim());
  return rows.slice(-8).map(r => "[" + fmtFull(Number(r.ts), BJ) + "] " + String(r.name || "群友") + "：" + clip(String(r.text), 1500)).join("\n");
}

// ---------- matching ----------
const norm = (s: string) => String(s || "").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");
const grams = (s: string) => { const g = new Set<string>(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); if (s.length === 1) g.add(s); return g; };
/** Rough "same thing" test for two task titles: equal after dropping punctuation, one containing the other, or most two-character pieces shared. */
export function sameTask(a: string, b: string) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  // "第 1 章" and "第 2 章" are different jobs however alike the rest is.
  if ((x.match(/\d+/g) || []).join(",") !== (y.match(/\d+/g) || []).join(",")) return false;
  if (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x))) return true;
  const jac = (a: Set<string>, b: Set<string>) => { let both = 0; for (const g of a) if (b.has(g)) both++; return both / (a.size + b.size - both || 1); };
  if (jac(grams(x), grams(y)) >= 0.6) return true;
  // Chinese moves words around ("改完登录页" / "把登录页改完"): compare the characters that carry meaning, ignoring order.
  const cx = new Set([...x].filter(c => !FILLER.includes(c))), cy = new Set([...y].filter(c => !FILLER.includes(c)));
  return Math.min(cx.size, cy.size) >= 3 && jac(cx, cy) >= 0.75;
}
const FILLER = "把将的了要去来我你他她们一下个这那给再先就也都还得着过和与及";
/** An unfinished task in this conversation that looks like the same thing. */
export function similarTask(hub: Hub, conv: string, title: string): Task | null {
  return listTasks(hub, conv, { status: ["open", "doing"], limit: 1000 }).find(t => sameTask(t.title, title)) || null;
}

// ---------- the chat tool ----------
const brief = (t: Task) => ({ id: t.id, title: t.title, status: LABEL[t.status], owner: t.owner, due: t.due, claimed_by: t.claimed_by, ...(t.priority !== 2 ? { priority: PRIORITY_LABEL[t.priority] } : {}), ...(t.after.length ? { after: t.after } : {}), ...(t.parent ? { split_from: t.parent } : {}), ...(t.result ? { result: clip(t.result, 200) } : {}) });
const full = (t: Task) => ({ ...brief(t), detail: t.detail, source: t.source, by: t.by, result: t.result, created: fmtFull(t.created), updated: fmtFull(t.updated) });
const STATUS_ARG: Record<string, TaskStatus[]> = { active: ["open", "doing"], open: ["open"], doing: ["doing"], done: ["done"], dropped: ["dropped"], all: [] };

function tools({ hub, conv, askers }: Ctx): Tool[] {
  const me = askers.map(a => a.name || a.id.slice(-4)).filter(Boolean);
  // With nobody asking, it is the bot itself at work (a scheduled run, or a task it is doing on its own).
  const who = me.join("、") || BOT;
  const waits = (t: Task) => { const b = blockers(hub, conv, t); return b.length ? { waiting_for: b.map(x => ({ id: x.id, title: clip(x.title, 40), who: x.claimed_by || x.owner })) } : {}; };
  const need = (id: unknown) => {
    const t = getTask(hub, conv, Number(id));
    return t ? { t } : { err: { ok: false, error: Number(id) ? "没有编号 " + Number(id) + " 的任务" : "要说是哪个任务（编号）" } };
  };
  return [{
    name: "tasks",
    description: "群里的任务清单：谁要做什么、做到哪了、做完没有。群里的看板也是读这份清单。\n"
      + "什么时候记（不用等人开口让你记）：有人明确说自己要做某件事（“我明天把登录页改完”“报告我来写”），或者把事交给某人（“小王你周五前把预算发出来”），而且做完能看得出来（有个具体的东西或结果）。随口的愿望（“哪天想去学滑雪”）、玩笑、反问、已经顺手做完的事都不记。有人说“bot 记一下……”就一定记。\n"
      + "记之前先 list 看一眼有没有同一件事，有就别重复记，改那一条（update / note）；add 自己也会挡掉标题几乎一样的。\n"
      + "有人说做完了（“登录页改好了”“报告发群里了”）就 done，result 写交了什么（文字、链接、文件编号）；说不做了、取消了就 drop；说做到一半、卡住了就 note。有人说“这个我来”就 claim。\n"
      + "有人问“我们现在有哪些事在做”“我还欠什么”“先做哪个”，用 list 照清单回答，不要凭印象；list 已经按该做的顺序排好（在做的、能开工的按优先级、还在等前置的排最后）。\n"
      + "交给你自己做的事（owner 是 bot）不是记一笔就完了，清单上要看得出你在干：开工前 start，做出来的东西（调研报告、方案全文、网页链接、PR、文件编号）用 attach 挂到任务上，做完 done。看板和群友的本地 AI 只看得到挂在任务上的东西，只发在群里不算交接。\n"
      + "你做不了的部分照实说，不要硬做也不要假装做了：要人拍板的、要线下办的、要别人的账号或权限的、超出你工具能力的。每一块用 split 从原任务里拆成一件新任务交给合适的人，reason 写你为什么做不了，detail 写你已经做到哪、他接手要知道什么；你剩下的活要等他做完才能继续就填 blocks=true。在群里说清楚哪部分你做了、哪部分拆给了谁。\n"
      + "先后和轻重：一件事要等另一件做完才能做，填 after（前置任务的编号）；急的填 priority=high，不急的填 low。别人口头说“先做 A 再做 B”“这个最急”也照这个记。\n"
      + "op：add（title 必填，一句话说清要交付什么；owner 填负责人在群里的名字，交给你自己就填 bot；due 填 YYYY-MM-DD，也认“明天”“11月20日”；source 填原话里的一小句，提出这件事的人最近说的原话会自动整段存进任务，不用你抄）、"
      + "list（status：active 没做完的（默认）/ open / doing / done / dropped / all；owner 按人筛；mine=true 只看提问的人自己的）、"
      + "update（id 加要改的 title / detail / owner / due / status）、done（id，result）、drop（id，reason）、note（id，text 进展）、claim（id，认领的人就是提问的人）、show（id，看这件事的全部经过和挂着的材料）、"
      + "start（id，你自己开工做这件事）、attach（id，kind：report 报告或方案全文放 text / link 链接放 ref / file 文件或图片编号放 ref，title 起个名字）、split（id 是原任务，title、owner、reason、detail，可选 priority、blocks）。\n"
      + "返回任务的编号、标题、状态、负责人、截止日期。回群里关于任务的话要短：一两句，记下了就说“记下了”，别把整张清单念出来，除非有人要看。",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["add", "list", "update", "done", "drop", "note", "claim", "show", "start", "attach", "split"] },
        id: { type: "integer", description: "任务编号（add 以外都要；split 时是被拆的原任务）" },
        title: { type: "string" }, detail: { type: "string", description: "补充说明，可空" },
        owner: { type: "string", description: "负责人在群里的名字；add / update 用来指定，list 用来筛" },
        due: { type: "string", description: "截止日期 YYYY-MM-DD；清掉就填空字符串" },
        size: { type: "string", enum: ["small", "normal", "big"], description: "这件事多大：small 顺手的小事，normal 普通（默认），big 大活（要啃好几天、算这个群的 Boss）" },
        source: { type: "string", description: "add 时：群里原话的一小句" },
        status: { type: "string", description: "list：active / open / doing / done / dropped / all；update：open / doing / done / dropped" },
        mine: { type: "boolean", description: "list：只看提问的人负责或认领的" },
        result: { type: "string", description: "done：交了什么" },
        reason: { type: "string", description: "drop：为什么不做了" },
        text: { type: "string", description: "note：进展；attach：报告或方案的全文（最多 4 万字）" },
        priority: { type: "string", enum: ["high", "normal", "low"], description: "add / update / split：轻重，high 急、normal 普通（默认）、low 不急" },
        after: { type: "array", items: { type: "integer" }, description: "add / update：要等哪些任务做完才能开始（它们的编号）；update 填空数组表示不用等了" },
        kind: { type: "string", enum: ["report", "link", "file"], description: "attach：挂的是什么" },
        ref: { type: "string", description: "attach：链接，或文件、图片的编号（如 x12、g300）" },
        blocks: { type: "boolean", description: "split：原任务要等拆出去的这件做完才能继续" },
      },
      required: ["op"],
    },
    run: async (a: any) => {
      const op = String(a.op || "list");
      if (op === "add") {
        const title = clean(a.title, LIMIT.title);
        if (!title) return { ok: false, error: "要说清楚是什么事（title）" };
        const same = similarTask(hub, conv, title);
        if (same) return { ok: true, duplicate: true, note: "清单里已经有这件事了，没有重复记；要补充就 update 或 note 这一条", task: brief(same) };
        const dep = checkAfter(hub, conv, 0, parseIds(a.after));
        if (dep.error) return { ok: false, error: dep.error };
        const t = addTask(hub, conv, { title, detail: a.detail, owner: a.owner, due: a.due, source: a.source, by: who, size: a.size, priority: a.priority, after: dep.ids }, true)!;
        const said = quoteOf(hub, conv, askers.map(x => x.id));
        if (said) addTaskRef(hub, conv, t.id, { kind: "quote", text: said, who });
        return { ok: true, added: brief(t), ...waits(t), ...(isBot(t.owner) ? { next: "这件在你名下。这一轮就做的话先 start 再动手；这一轮不做也行，之后轮到它（按优先级和先后顺序）你会自己开工，开工、进展、结果都会显示在看板上。别说“我排期做”却不动。" } : {}) };
      }
      if (op === "list") {
        const st = STATUS_ARG[String(a.status || "active")] ?? STATUS_ARG.active;
        let owner = clean(a.owner, LIMIT.who);
        if (a.mine) { if (!me.length) return { ok: false, error: "不知道是谁在问，没法只看“我的”" }; owner = me[0]; }
        let list = listTasks(hub, conv, { status: st, owner, limit: 60 });
        // Unfinished tasks come back in working order, each saying what it still waits for.
        const order = new Map(workOrder(hub, conv).map((r, i) => [r.task.id, i]));
        if (list.every(t => order.has(t.id))) list = list.sort((x, y) => order.get(x.id)! - order.get(y.id)!);
        return { ok: true, today: fmtDate(Date.now(), BJ), count: list.length, tasks: list.map(t => ({ ...brief(t), ...waits(t) })) };
      }
      const { t, err } = need(a.id);
      if (!t) return err;
      if (op === "show") {
        const h = handoff(hub, conv, t.id)!;
        return {
          ok: true, task: full(t), ...waits(t),
          ...(h.parent ? { split_from: { id: h.parent.id, title: h.parent.title } } : {}), ...(h.children.length ? { split_into: h.children.map(c => ({ id: c.id, title: c.title, status: LABEL[c.status], who: c.owner })) } : {}),
          materials: h.materials.map(m => ({ kind: REF_LABEL[m.kind], title: m.title, ...(m.ref ? { ref: m.ref } : {}), ...(m.text ? { text: clip(m.text, m.kind === "quote" ? 2000 : 6000) } : {}), ...(m.from ? { from_task: m.from } : {}) })),
          history: h.notes.map(n => ({ at: fmtFull(n.ts), who: n.who, what: n.text })),
        };
      }
      if (op === "start") {
        if (t.status === "done" || t.status === "dropped") return { ok: false, error: "这件事已经" + LABEL[t.status], task: brief(t) };
        if (t.claimed_by && !isBot(t.claimed_by)) return { ok: false, error: t.claimed_by + " 已经在做这件事了，你别抢；要帮忙就 note 留言", task: brief(t) };
        const b = blockers(hub, conv, t);
        if (b.length) return { ok: false, error: "这件要等 " + b.map(x => "#" + x.id).join("、") + " 做完才能开始", ...waits(t) };
        if (!t.owner) updateTask(hub, conv, t.id, { owner: BOT }, who, true);
        return { ok: true, task: brief(claimTask(hub, conv, t.id, BOT, true)!), next: "现在动手做。产出用 attach 挂上，做不了的部分用 split 拆给人，做完 done" };
      }
      if (op === "attach") {
        const kind = (REF_KINDS.includes(a.kind) && a.kind !== "quote" ? a.kind : a.text && !a.ref ? "report" : "link") as RefKind;
        if (!clean(a.text, 10) && !clean(a.ref, 10)) return { ok: false, error: "要挂什么：报告全文放 text，链接或文件编号放 ref" };
        const r = addTaskRef(hub, conv, t.id, { kind, title: a.title, ref: a.ref, text: a.text, who });
        if (!r) return { ok: false, error: "没挂上：这件任务挂的材料已经到上限（" + LIMIT.refs + " 份）" };
        return { ok: true, attached: { kind: REF_LABEL[r.kind], title: r.title, ...(r.ref ? { ref: r.ref } : {}), chars: r.text.length }, task: brief(getTask(hub, conv, t.id)!) };
      }
      if (op === "split") {
        const title = clean(a.title, LIMIT.title), reason = clean(a.reason, 300);
        if (!title) return { ok: false, error: "拆出来的这件是什么事（title）" };
        if (!reason) return { ok: false, error: "写清楚这部分为什么要拆出去（reason）：你做不了的原因，或者为什么要别人来" };
        const same = similarTask(hub, conv, title);
        if (same && same.id !== t.id) return { ok: true, duplicate: true, note: "清单里已经有这件事了，没有重复拆", task: brief(same) };
        const detail = [clean(a.detail, 700), "拆出来的原因：" + reason].filter(Boolean).join("\n");
        const child = addTask(hub, conv, { title, detail, owner: a.owner, due: a.due, source: t.source, by: who, size: a.size, priority: a.priority ?? t.priority, parent: t.id }, true)!;
        addTaskNote(hub, conv, t.id, who, "拆出 #" + child.id + "「" + clip(child.title, 40) + "」" + (child.owner ? "交给 " + child.owner : "，还没定谁做") + "：" + reason);
        if (a.blocks) updateTask(hub, conv, t.id, { after: [...t.after, child.id] }, who, true);
        return { ok: true, split: brief(child), from: brief(getTask(hub, conv, t.id)!), ...(a.blocks ? { note: "原任务会等 #" + child.id + " 做完再继续，到时候自动轮到" } : {}), say: "在群里说清楚这部分为什么拆给" + (child.owner || "别人") + "，别悄悄挂上去" };
      }
      if (op === "update") {
        const patch: any = {};
        for (const k of ["title", "detail", "owner", "due", "size"]) if (a[k] !== undefined) patch[k] = a[k];
        if (a.priority !== undefined) { if (!normPriority(a.priority)) return { ok: false, error: "优先级只能是 high / normal / low" }; patch.priority = a.priority; }
        if (a.after !== undefined) { const dep = checkAfter(hub, conv, t.id, parseIds(a.after)); if (dep.error) return { ok: false, error: dep.error }; patch.after = dep.ids; }
        if (a.status !== undefined) { if (!STATUSES.includes(a.status)) return { ok: false, error: "状态只能是 open / doing / done / dropped" }; patch.status = a.status; }
        if (a.result !== undefined) patch.result = a.result;
        if (patch.due && !normDue(patch.due)) return { ok: false, error: "截止日期看不懂，用 2026-11-20 这样的写法" };
        const up = updateTask(hub, conv, t.id, patch, who, true)!;
        return { ok: true, task: brief(up), ...waits(up) };
      }
      if (op === "done") {
        const fin = updateTask(hub, conv, t.id, { status: "done", ...(a.result !== undefined ? { result: a.result } : {}) }, who, true)!;
        const cheer = hooks.facts?.(hub, conv, fin), free = unblockedBy(hub, conv, fin.id);
        return { ok: true, task: brief(fin), ...(free.length ? { now_can_start: free.map(x => ({ id: x.id, title: clip(x.title, 40), who: x.claimed_by || x.owner })), tell: "顺口说一句这几件现在可以开始了" } : {}), ...(cheer ? { cheer, say: "做完一件事值得当场夸一句：用你平时的口气，具体说他做成了什么，带上 cheer 里一两个真实的数（这周第几件、连续几天、花了多久、新拿的称号），别说“辛苦了”这种套话，别编 cheer 里没有的数" } : {}) };
      }
      if (op === "drop") {
        const r = updateTask(hub, conv, t.id, { status: "dropped" }, who, true)!;
        if (clean(a.reason, 300)) addTaskNote(hub, conv, t.id, who, "不做的原因：" + clean(a.reason, 300));
        return { ok: true, task: brief(r) };
      }
      if (op === "note") {
        if (!clean(a.text, 10)) return { ok: false, error: "进展写什么（text）" };
        addTaskNote(hub, conv, t.id, who, a.text);
        return { ok: true, task: brief(getTask(hub, conv, t.id)!) };
      }
      if (op === "claim") {
        if (!me.length) return { ok: false, error: "不知道是谁要认领" };
        const r = claimTask(hub, conv, t.id, me[0], true);
        if (!r) return { ok: false, error: t.status === "done" || t.status === "dropped" ? "这件事已经" + LABEL[t.status] : t.claimed_by + " 已经在做这件事了", task: brief(t) };
        return { ok: true, task: brief(r) };
      }
      return { ok: false, error: "不认识的操作 " + op };
    },
  }];
}

// ---------- nightly extraction ----------
type Plan = {
  conv: string; day: string; dry: boolean; messages: number;
  added: { title: string; owner: string; due: string; source: string; detail?: string; id?: number }[];
  finished: { id: number; title: string; result: string; quote: string }[];
  dropped: { id: number; title: string; quote: string }[];
  skipped: { what: string; why: string }[];
  tokens?: { input: number; output: number };
  error?: string; ran?: string;
};

const SYSTEM = "你在帮一个三人小群整理任务清单。读一天的群聊记录，找出三类事，只输出一个 JSON 对象，不要别的文字：\n"
  + "{\"new\":[{\"title\":\"一句话说清要交付什么\",\"owner\":\"负责人在群里的名字，交给 Bot 就写 bot，不清楚写空\",\"due\":\"YYYY-MM-DD 或空\",\"detail\":\"可空\",\"quote\":\"聊天里的原话，一字不改地抄 6 到 40 个字\"}],"
  + "\"done\":[{\"id\":已有任务编号,\"result\":\"交了什么，可空\",\"quote\":\"原话\"}],"
  + "\"dropped\":[{\"id\":已有任务编号,\"quote\":\"原话\"}]}\n"
  + "new：有人明确说自己要做某件事，或者把事交给某人，而且做完能看得出来。随口的愿望、玩笑、反问、问句、当场已经做完的事都不算。交给 Bot 的事要特别小心：Bot 在同一天的聊天里已经做完并回复了的（查了、画了、发了、提醒了），或者已经答应并设成每天/每周自动做的定时任务，都不算任务，不要列；只有 Bot 明显还没做、或者做失败了还欠着的才列。已有清单里有同一件事的不要再列进 new。截止日期按说话那天推算（“明天”“周五前”）。\n"
  + "done：有人说已有清单里的某件事做完了。dropped：有人说某件事不做了、取消了。拿不准就不列。\n"
  + "quote 必须是记录里真实出现的原话片段，不能改写或拼接；找不到原话就不要列这一条。三类都没有就输出 {\"new\":[],\"done\":[],\"dropped\":[]}。";

function dayRange(day: string) { const from = zonedToUtc(day, "00:00", BJ); return { from, to: from + 86400000 }; }
const yesterday = (now: number) => fmtDate(now - 86400000, BJ);
const speaker = (r: any) => (r.role === "bot" ? "Bot" : String(r.name || (r.sender ? "成员" + String(r.sender).slice(-4) : "成员")));

function parseJson(text: string): any {
  const s = String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
  try { return JSON.parse(s); } catch {}
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch {} }
  return null;
}

/** Reads one Beijing day of a group's chat, asks the model once, checks every item against the chat, and applies it unless `dry`. */
export async function extractDay(hub: Hub, conv: string, day: string, dry = false): Promise<Plan> {
  const plan: Plan = { conv, day, dry, messages: 0, added: [], finished: [], dropped: [], skipped: [] };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return { ...plan, error: "日期要写成 2026-11-14" };
  const { from, to } = dayRange(day);
  const rows = hub.sql.exec("SELECT role, name, sender, text, ts FROM msg WHERE conv=? AND ts>=? AND ts<? ORDER BY seq LIMIT ?", conv, from, to, DAY_MSGS).toArray() as any[];
  plan.messages = rows.length;
  if (rows.filter(r => r.role === "user").length < 3) return { ...plan, skipped: [{ what: "整天", why: "这天群里说话太少" }] };
  const open = listTasks(hub, conv, { status: ["open", "doing"], limit: 200 });
  const transcript = rows.map(r => "[" + fmtFull(Number(r.ts), BJ).slice(-5) + "] " + speaker(r) + "：" + clip(String(r.text || "").replace(/\s+/g, " "), 300)).join("\n");
  const user = "那天是 " + day + "（北京时间）。\n\n【已有的没做完的任务】\n"
    + (open.map(t => "#" + t.id + " " + t.title + (t.owner ? "（" + t.owner + "）" : "") + (t.due ? " 截止 " + t.due : "")).join("\n") || "（没有）")
    + "\n\n【当天聊天】\n" + clip(transcript, 120000);
  let out: any;
  try {
    const r = await deps.model(hub, SYSTEM, user);
    plan.tokens = { input: Number(r.usage?.prompt_tokens || 0), output: Number(r.usage?.completion_tokens || 0) };
    out = parseJson(r.text);
  } catch (e: any) { return { ...plan, error: "模型没答上来：" + clip(e?.message || String(e), 200) }; }
  if (!out || typeof out !== "object") return { ...plan, error: "模型的回答不是能读的 JSON" };

  const said = rows.filter(r => r.role === "user").map(r => norm(String(r.text || "")));
  const grounded = (q: unknown) => { const n = norm(String(q || "")); return n.length >= 4 && said.some(s => s.includes(n)); };
  const cap = Math.max(0, Number(hub.edit.cfg(conv, "tasks_nightly_max")) || 0);
  const openIds = new Map(open.map(t => [t.id, t]));
  const touched = new Set<number>();

  for (const d of Array.isArray(out.done) ? out.done : []) {
    const t = openIds.get(Number(d?.id));
    if (!t || touched.has(t.id)) { plan.skipped.push({ what: "做完 #" + d?.id, why: "不是没做完的任务" }); continue; }
    if (!grounded(d.quote)) { plan.skipped.push({ what: "做完 #" + t.id, why: "聊天里找不到这句原话" }); continue; }
    touched.add(t.id);
    plan.finished.push({ id: t.id, title: t.title, result: clean(d.result, LIMIT.result), quote: clean(d.quote, LIMIT.source) });
  }
  for (const d of Array.isArray(out.dropped) ? out.dropped : []) {
    const t = openIds.get(Number(d?.id));
    if (!t || touched.has(t.id)) { plan.skipped.push({ what: "不做 #" + d?.id, why: "不是没做完的任务" }); continue; }
    if (!grounded(d.quote)) { plan.skipped.push({ what: "不做 #" + t.id, why: "聊天里找不到这句原话" }); continue; }
    touched.add(t.id);
    plan.dropped.push({ id: t.id, title: t.title, quote: clean(d.quote, LIMIT.source) });
  }
  const fresh: string[] = [];
  for (const n of Array.isArray(out.new) ? out.new : []) {
    const title = clean(n?.title, LIMIT.title);
    if (!title) continue;
    if (!grounded(n.quote)) { plan.skipped.push({ what: title, why: "聊天里找不到这句原话" }); continue; }
    const same = open.find(t => sameTask(t.title, title));
    if (same || fresh.some(f => sameTask(f, title))) { plan.skipped.push({ what: title, why: same ? "清单里已有 #" + same.id : "同一晚重复" }); continue; }
    if (plan.added.length >= cap) { plan.skipped.push({ what: title, why: "超过一晚最多新记 " + cap + " 件" }); continue; }
    fresh.push(title);
    plan.added.push({ title, owner: clean(n.owner, LIMIT.who), due: normDue(n.due, from + 43200000), source: clean(n.quote, LIMIT.source), ...(n.detail ? { detail: clean(n.detail, LIMIT.detail) } : {}) });
  }
  if (dry) return plan;

  for (const f of plan.finished) { updateTask(hub, conv, f.id, { status: "done", ...(f.result ? { result: f.result } : {}) }, NIGHT, true); addTaskNote(hub, conv, f.id, NIGHT, "聊天里说：“" + f.quote + "”"); }
  for (const f of plan.dropped) { updateTask(hub, conv, f.id, { status: "dropped" }, NIGHT, true); addTaskNote(hub, conv, f.id, NIGHT, "聊天里说：“" + f.quote + "”"); }
  for (const a of plan.added) {
    const t = addTask(hub, conv, { title: a.title, owner: a.owner, due: a.due, source: a.source, detail: a.detail, by: NIGHT }, true);
    if (t) a.id = t.id;
  }
  plan.ran = new Date().toISOString();
  hub.set("tasks:extract:last:" + conv, JSON.stringify({ day, added: plan.added.length, finished: plan.finished.length, dropped: plan.dropped.length, skipped: plan.skipped.length, tokens: plan.tokens, ran: plan.ran }));
  return plan;
}

/** Real groups that talked on `day` and have the nightly pass switched on. */
export function nightlyConvs(hub: Hub, day: string): string[] {
  const { from, to } = dayRange(day);
  return hub.sql.exec("SELECT DISTINCT conv FROM msg WHERE ts>=? AND ts<? AND role='user' AND conv NOT LIKE 't:%'", from, to).toArray()
    .map((r: any) => String(r.conv)).filter(c => String(hub.edit.cfg(c, "tasks_nightly")) !== "off");
}

const busy = new WeakSet<object>();
async function nightly(hub: Hub, day: string) {
  for (const c of nightlyConvs(hub, day)) {
    try { await extractDay(hub, c, day); } catch (e: any) { console.log("task extract failed", c, e?.message); }
  }
}

/** Morning reminder: one message per group listing unfinished tasks due today, each task reminded once. */
export async function remind(hub: Hub, now: number) {
  const today = fmtDate(now, BJ), sent: string[] = [];
  const rows = hub.sql.exec("SELECT * FROM task WHERE due=? AND status IN ('open','doing') AND reminded<>? ORDER BY conv, id", today, today).toArray() as any[];
  const byConv = new Map<string, Task[]>();
  for (const r of rows) { const t = ofRow(r); if (String(hub.edit.cfg(t.conv, "tasks_remind")) !== "on") continue; byConv.set(t.conv, [...(byConv.get(t.conv) || []), t]); }
  for (const [conv, list] of byConv) {
    for (const t of list) hub.sql.exec("UPDATE task SET reminded=? WHERE id=?", today, t.id);
    const text = list.length === 1
      ? "提醒一下，今天到期：" + list[0].title + (list[0].owner ? "（" + list[0].owner + "）" : "")
      : "提醒一下，今天到期的：" + list.map(t => t.title + (t.owner ? "（" + t.owner + "）" : "")).join("；");
    await hub.say(conv, text);
    sent.push(conv);
  }
  return sent;
}

function tick(hub: Hub, now: number) {
  const today = fmtDate(now, BJ);
  if (hub.get("tasks:extract:day") !== today && now >= zonedToUtc(today, EXTRACT_AT, BJ) && !busy.has(hub)) {
    hub.set("tasks:extract:day", today);
    busy.add(hub);
    hub.ctx.waitUntil(nightly(hub, yesterday(now)).catch(e => console.log("task nightly failed", e?.message)).finally(() => busy.delete(hub)));
  }
  if (hub.get("tasks:remind:day") !== today && now >= zonedToUtc(today, REMIND_AT, BJ)) {
    hub.set("tasks:remind:day", today);
    hub.ctx.waitUntil(remind(hub, now).catch(e => console.log("task remind failed", e?.message)));
  }
}

const json = (o: any, status = 200) => new Response(JSON.stringify(o, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const feature: Feature = {
  name: "tasks",
  schema: `
    CREATE TABLE IF NOT EXISTS task(id INTEGER PRIMARY KEY AUTOINCREMENT, conv TEXT NOT NULL, title TEXT NOT NULL, detail TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'open', owner TEXT DEFAULT '', due TEXT DEFAULT '', source TEXT DEFAULT '', made_by TEXT DEFAULT '',
      claimed_by TEXT DEFAULT '', result TEXT DEFAULT '', created INTEGER NOT NULL, updated INTEGER NOT NULL, reminded TEXT DEFAULT '',
      size TEXT DEFAULT 'normal', claimed_at INTEGER DEFAULT 0, done_at INTEGER DEFAULT 0, done_by TEXT DEFAULT '',
      priority INTEGER DEFAULT 2, after TEXT DEFAULT '', parent INTEGER DEFAULT 0, runs INTEGER DEFAULT 0, last_run INTEGER DEFAULT 0);
    CREATE INDEX IF NOT EXISTS task_conv ON task(conv, status, updated);
    CREATE INDEX IF NOT EXISTS task_due ON task(due, status);
    CREATE TABLE IF NOT EXISTS task_note(id INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, conv TEXT NOT NULL, ts INTEGER NOT NULL, who TEXT DEFAULT '', text TEXT NOT NULL, kind TEXT DEFAULT '');
    CREATE INDEX IF NOT EXISTS task_note_task ON task_note(conv, task, ts);
    CREATE TABLE IF NOT EXISTS task_ref(id INTEGER PRIMARY KEY AUTOINCREMENT, task INTEGER NOT NULL, conv TEXT NOT NULL, ts INTEGER NOT NULL, who TEXT DEFAULT '',
      kind TEXT NOT NULL, title TEXT DEFAULT '', ref TEXT DEFAULT '', text TEXT DEFAULT '');
    CREATE INDEX IF NOT EXISTS task_ref_task ON task_ref(conv, task, ts);
  `,
  tunables: {
    tasks_nightly: { default: "on", options: ["on", "off"], what: "每天夜里从前一天的聊天里补记任务、标出做完和不做的" },
    tasks_nightly_max: { default: 8, min: 0, max: 30, what: "夜间整理一晚最多新记几件任务" },
    tasks_remind: { default: "off", options: ["off", "on"], what: "任务到期那天早上在群里提醒一句" },
    tasks_announce: { default: "on", options: ["on", "off"], what: "有人在看板上或用本地 AI 接了任务、做完、放下、加了新任务时，在群里说一句" },
  },
  tools,
  tick,
  async admin(hub, req, url, body) {
    if (url.pathname !== "/admin/tasks") return null;
    if (req.method === "POST") {
      const conv = String(body?.extract || "");
      if (!conv) return json({ error: "extract 要填群的会话编号" }, 400);
      return json(await extractDay(hub, conv, String(body.day || yesterday(Date.now())), body.dry !== false));
    }
    const conv = url.searchParams.get("conv") || hub.get("main") || "";
    const status = (url.searchParams.get("status") || "").split(",").filter(s => STATUSES.includes(s as TaskStatus)) as TaskStatus[];
    let last: any = null;
    try { last = JSON.parse(hub.get("tasks:extract:last:" + conv) || "null"); } catch {}
    return json({ conv, last_extract: last, extract_day_mark: hub.get("tasks:extract:day"), tasks: listTasks(hub, conv, { status, limit: 500 }) });
  },
  about: [
    "我会记群里的任务：谁说了要做什么、交给了谁、什么时候要，记在一张清单里，看板上也能看到。",
    "有人明确说要做某件具体的事，或者把事交给别人，我会自己记下；随口说说的、开玩笑的不记。想让我记，说“记一下……”就行。",
    "说做完了、不做了、做到哪了，我会在清单上改；问“现在有哪些事在做”，我照清单回答。",
    "每天夜里我会把前一天的聊天再过一遍，补上漏记的、标出做完和取消的，每件新记的都对得上群里的原话；一晚最多新记 8 件（可以改），不在群里说。",
    "有人在看板上或用本地 AI 加了任务、接了任务、做完、放下，我会在群里说一句（以【任务】开头）；在群里直接跟我说的不重复提醒。不想要可以把 tasks_announce 关掉。",
    "到期提醒默认关着；打开后，任务到期那天早上我在群里提一句，每件只提一次。",
  ],
};
export default feature;
