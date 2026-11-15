// An MCP server for the group's local AI tools (Claude Code and others): read the task list, claim a task,
// report progress, deliver the result, and look things up in what the bot keeps. It answers at
// /x/mcp/<token> (or /x/mcp with "Authorization: Bearer <token>"), the token being a personal link from access.ts.
//
// Protocol: MCP Streamable HTTP, dual-era and stateless.
// - Modern revision 2026-07-28 (per-request `_meta` version, `server/discover`, MCP-Protocol-Version /
//   Mcp-Method / Mcp-Name header checks, `resultType` in results, 404 for unknown methods).
// - Legacy revisions 2025-11-25, 2025-06-18, 2025-03-26 (`initialize` handshake; we negotiate down to one of
//   these). No session id is issued, so no handshake state is needed between requests; batches (2025-03-26)
//   are accepted too.
// Every request is answered with application/json; GET and DELETE answer 405 (no server stream, no sessions).
import type { Feature } from "./types.ts";
import type { Hub } from "../hub.ts";
import type { Task, TaskNote, TaskStatus } from "./tasks.ts";
import * as tasks from "./tasks.ts";
import { bases, bearerToken, checkAccess, type Person } from "./access.ts";
import { BJ, b64, clip, fmtDate, fmtTime } from "../util.ts";

export const MODERN = ["2026-07-28"];
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"];
const PV = "io.modelcontextprotocol/protocolVersion";
const BODY_MAX = 1024 * 1024;
const SERVER = { name: "teamagent", title: "TeamAgent 群任务", version: "1.0.0" };
const INSTRUCTIONS = "TeamAgent is the QQ group bot of a small team of friends. This server gives you the group's task list (任务) and read access to what the bot keeps. "
  + "Typical flow: list_tasks (already in working order) → get_task (the whole hand-off package: the original words from the chat, attached reports and links, what it waits for) → claim_task (领任务) → work on it locally → report_progress (进展) → attach_material for a report or links you produced → complete_task (交付); release_task if you give up. "
  + "A part you cannot do goes back to the group as its own task: add_task with parent set to the task you are on and the reason in detail. "
  + "Claiming, completing and releasing a task are announced in the group chat automatically, so do not repeat them; notify_group posts one extra short line and is only for progress or results worth telling the group. Everything you do is recorded as \"<person>的本地 AI\". Reply to the person in Chinese.";

export type Deps = {
  listTasks: typeof tasks.listTasks; getTask: typeof tasks.getTask; addTask: typeof tasks.addTask; updateTask: typeof tasks.updateTask;
  claimTask: typeof tasks.claimTask; addTaskNote: typeof tasks.addTaskNote; taskNotes: typeof tasks.taskNotes;
  handoff: typeof tasks.handoff; workOrder: typeof tasks.workOrder; checkAfter: typeof tasks.checkAfter; addTaskRef: typeof tasks.addTaskRef;
  checkAccess: (hub: Hub, token: string) => Promise<Person | null>;
};
const DEPS: Deps = { ...tasks, checkAccess: (hub, token) => checkAccess(hub, token) };

type Call = { hub: Hub; conv: string; who: Person; actor: string; token: string; base: string; d: Deps };
type Tool = { name: string; title: string; description: string; inputSchema: any; annotations: any; run(a: any, c: Call): Promise<any> | any };
class Refused extends Error {}
const no = (text: string): never => { throw new Refused(text); };

const TUNABLES = {
  mcp_calls_daily: { default: 500, min: 20, max: 5000, what: "每个人的本地 AI 每天最多调用几次群里的工具" },
  mcp_notify_daily: { default: 30, min: 0, max: 200, what: "每个人的本地 AI 每天最多让我往群里说几句" },
};
const cfg = (hub: Hub, conv: string, key: keyof typeof TUNABLES) => {
  const v = Number((hub as any).edit?.cfg(conv, key));
  return Number.isFinite(v) ? v : TUNABLES[key].default;
};
const today = () => fmtDate(Date.now(), BJ);
const when = (ts: number) => ts ? fmtDate(ts, BJ) + " " + fmtTime(ts, BJ) : "";
const rows = (hub: Hub, q: string, ...b: any[]) => hub.sql.exec(q, ...b).toArray() as any[];
/** Counts one use for this person today; false when the day's allowance is gone. */
function count(hub: Hub, kind: string, who: Person, limit: number) {
  const day = today(), k = "mcp:" + kind + ":" + who.conv + ":" + who.uid + ":" + day, used = Number(hub.get(k) || 0);
  if (hub.get("mcp:day") !== day) {   // forget earlier days' counters once a day
    hub.set("mcp:day", day);
    try { hub.sql.exec("DELETE FROM kv WHERE (k LIKE 'mcp:calls:%' OR k LIKE 'mcp:notify:%') AND substr(k, -10) < ?", day); } catch {}
  }
  if (used >= limit) return false;
  hub.set(k, String(used + 1));
  return true;
}

// ---------- tools ----------
const STATUS: TaskStatus[] = ["open", "doing", "done", "dropped"];
const PRIORITY: Record<number, string> = { 1: "high", 3: "low" };
const brief = (t: Task) => ({ id: t.id, title: t.title, status: t.status, owner: t.owner || undefined, due: t.due || undefined, claimed_by: t.claimed_by || undefined,
  priority: PRIORITY[t.priority] || undefined, after: t.after?.length ? t.after : undefined, split_from: t.parent || undefined, updated: when(t.updated) });
const full = (t: Task) => ({ ...brief(t), detail: t.detail || undefined, source: t.source || undefined, by: t.by || undefined, result: t.result || undefined, created: when(t.created) });
const mine = (t: Task, c: Call) => !!t.claimed_by && (t.claimed_by === c.actor || t.claimed_by === c.who.name);
const need = (c: Call, id: number) => c.d.getTask(c.hub, c.conv, id) || no("没有 #" + id + " 这个任务。用 list_tasks 看看现有的任务。");
const finished = (t: Task) => t.status === "done" ? "任务 #" + t.id + " 已经做完了" : t.status === "dropped" ? "任务 #" + t.id + " 已经取消了" : "";

const str = (description: string, extra: any = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: any = {}) => ({ type: "integer", description, ...extra });
const schema = (properties: any, required: string[] = []) => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const TASK_ID = int("Task number, the 12 of 任务 #12");

const TEXTY = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|log|html?|css|xml|svg|js|mjs|cjs|ts|tsx|jsx|py|sh|go|rs|java|kt|swift|c|cc|cpp|h|hpp|sql|tex|srt|vtt)$/i;
const TEXT_MAX = 100 * 1024, IMAGE_MAX = 1024 * 1024;

export const TOOLS: Tool[] = [
  {
    name: "list_tasks", title: "看任务", annotations: READ,
    description: "List the group's tasks (群里的任务清单). Default shows the open ones (open = 待办, nobody working on it; doing = 进行中, someone claimed it). "
      + "status: active (open + doing, default), open, doing, done (做完的), dropped (取消的) or all. owner: only tasks meant for this person (群昵称). mine: true for tasks meant for or claimed by the person you work for. "
      + "Unfinished tasks come back in the order to work on them: under way, then startable now (priority high first), then those still waiting for another task (waiting_for lists the unfinished tasks it needs first). "
      + "Returns id, title, status, owner, due date, priority (only when high or low), who claimed it and when it last changed; use get_task for the details.",
    inputSchema: schema({
      status: str("Which tasks", { enum: ["active", "open", "doing", "done", "dropped", "all"] }),
      owner: str("Only tasks meant for this group member (their nickname)"),
      mine: { type: "boolean", description: "Only tasks meant for or claimed by the person you work for" },
      limit: int("At most this many, default 30, up to 100"),
    }),
    run(a, c) {
      const s = String(a.status || "active");
      const status: TaskStatus[] = s === "all" ? STATUS : s === "active" ? ["open", "doing"] : [s as TaskStatus];
      const limit = Math.min(Math.max(Number(a.limit) || 30, 1), 100);
      let list = c.d.listTasks(c.hub, c.conv, { status, ...(a.owner ? { owner: String(a.owner) } : {}), limit: a.mine ? 500 : limit });
      if (a.mine) list = list.filter(t => t.owner === c.who.name || mine(t, c)).slice(0, limit);
      const order = new Map(c.d.workOrder(c.hub, c.conv).map((r, i) => [r.task.id, { i, wait: r.blocked_by }]));
      if (list.length && list.every(t => order.has(t.id))) list = list.sort((x, y) => order.get(x.id)!.i - order.get(y.id)!.i);
      return { you_work_for: c.who.name, count: list.length, tasks: list.map(t => ({ ...brief(t), ...(order.get(t.id)?.wait.length ? { waiting_for: order.get(t.id)!.wait } : {}) })), ...(list.length ? {} : { note: "没有符合条件的任务" }) };
    },
  },
  {
    name: "get_task", title: "看一个任务", annotations: READ,
    description: "One task with everything needed to take it over: detail (要求), original_words (原话: what the people who asked said in the chat, verbatim), materials (reports with their full text, links, file numbers; from_task marks a piece inherited from the task this one was split from), "
      + "waits_for (tasks that must be finished first, with their state and results), split_from / split_into, who created and claimed it, the delivered result, and its notes (进展记录, newest last). Read this before you start working.",
    inputSchema: schema({ id: TASK_ID }, ["id"]),
    run(a, c) {
      const t = need(c, a.id), h = c.d.handoff(c.hub, c.conv, t.id);
      const notes: TaskNote[] = h?.notes || c.d.taskNotes(c.hub, c.conv, t.id);
      let room = 150000;   // characters of attached text in one answer
      const piece = (m: any) => { const text = clip(String(m.text || ""), Math.max(0, room)); room -= text.length; return { kind: m.kind, title: m.title, url_or_number: m.ref || undefined, text: text || undefined, cut: text.length < String(m.text || "").length || undefined, from_task: m.from || undefined, attached_by: m.who || undefined, when: when(m.ts) }; };
      const quotes = (h?.materials || []).filter(m => m.kind === "quote"), rest = (h?.materials || []).filter(m => m.kind !== "quote");
      return {
        ...full(t),
        original_words: quotes.length ? quotes.map(m => (m.from ? "（来自 #" + m.from + "）\n" : "") + m.text).join("\n\n") : undefined,
        materials: rest.length ? rest.map(piece) : undefined,
        waits_for: h?.waits_for.length ? h.waits_for.map(w => ({ id: w.id, title: w.title, status: w.status, who: w.owner || undefined, result: w.result || undefined })) : undefined,
        blocked_by: h?.blocked_by.length ? h.blocked_by : undefined,
        split_from: h?.parent ? { id: h.parent.id, title: h.parent.title, status: h.parent.status, result: h.parent.result || undefined } : undefined,
        split_into: h?.children.length ? h.children.map(x => ({ id: x.id, title: x.title, status: x.status, who: x.owner || undefined })) : undefined,
        notes: notes.slice(-40).map(n => ({ when: when(n.ts), who: n.who, text: n.text })),
      };
    },
  },
  {
    name: "claim_task", title: "领任务", annotations: WRITE,
    description: "Claim a task (领任务) for the person you work for, so the group sees it is being done (status becomes doing). "
      + "Refused when the task is finished or someone else already claimed it. Claim before you start working; then report_progress while working and complete_task when done.",
    inputSchema: schema({ id: TASK_ID }, ["id"]),
    run(a, c) {
      const t = need(c, a.id);
      if (finished(t)) no(finished(t) + "，不能再领。");
      if (mine(t, c) && t.status === "doing") return { ok: true, note: "这个任务本来就是你领的", task: full(t) };
      if (t.claimed_by && !mine(t, c)) no("任务 #" + t.id + " 已经被" + t.claimed_by + "领了。可以用 report_progress 给它留言，或者换一个任务。");
      const got = c.d.claimTask(c.hub, c.conv, t.id, c.actor);
      if (!got) { const now = c.d.getTask(c.hub, c.conv, t.id); no(now?.claimed_by ? "任务 #" + t.id + " 刚被" + now.claimed_by + "领走了。" : "任务 #" + t.id + " 现在领不了。"); }
      const wait = c.d.handoff(c.hub, c.conv, t.id)?.blocked_by || [];
      return { ok: true, task: full(got!), ...(wait.length ? { warning: "这件排在 " + wait.map(x => "#" + x).join("、") + " 之后，它们还没做完；先用 get_task 看清楚要不要等" } : {}),
        next: "先 get_task 把原话和材料读完；做的过程中用 report_progress 记进展，产出的报告和链接用 attach_material 挂上，做完用 complete_task 交付" };
    },
  },
  {
    name: "report_progress", title: "记进展", annotations: WRITE,
    description: "Add a progress note to a task (进展): what was done, what is blocked, a question for the group. One or a few plain sentences; the group sees it on the board. "
      + "Any task can get a note, including one claimed by someone else.",
    inputSchema: schema({ id: TASK_ID, text: str("The note, at most 2000 characters") }, ["id", "text"]),
    run(a, c) {
      const t = need(c, a.id), text = String(a.text).trim();
      if (!text) no("进展内容是空的。");
      if (text.length > 2000) no("进展太长了（" + text.length + " 字），控制在 2000 字以内，长的内容放进 complete_task 的结果里。");
      if (!c.d.addTaskNote(c.hub, c.conv, t.id, c.actor, text)) no("进展没记上，稍后再试。");
      return { ok: true, task: t.id, noted: clip(text, 120) };
    },
  },
  {
    name: "complete_task", title: "交付任务", annotations: WRITE,
    description: "Mark a task done (交付) and record what was delivered: result is the text the group reads (summary, where the work is, how to use it); links are optional URLs (pull request, page, file). "
      + "Allowed for tasks claimed by the person you work for, or not claimed by anyone; a task claimed by someone else is refused.",
    inputSchema: schema({
      id: TASK_ID,
      result: str("What was delivered, at most 8000 characters"),
      links: { type: "array", items: { type: "string" }, description: "Optional links to the work (PR, page, file), at most 10" },
    }, ["id", "result"]),
    run(a, c) {
      const t = need(c, a.id), text = String(a.result).trim(), links = (a.links || []).map((l: any) => String(l).trim()).filter(Boolean);
      if (!text) no("交付内容是空的，写一下做了什么、成果在哪。");
      if (text.length > 8000) no("交付内容太长了（" + text.length + " 字），控制在 8000 字以内，长文放到文件或网页里给链接。");
      if (links.length > 10) no("链接最多 10 个。");
      if (finished(t)) no(finished(t) + "，不用再交付。");
      if (t.claimed_by && !mine(t, c)) no("任务 #" + t.id + " 是" + t.claimed_by + "领的，只有他能交付。可以用 report_progress 把你的成果留在进展里。");
      const done = c.d.updateTask(c.hub, c.conv, t.id, { status: "done", result: [text, ...links].join("\n") }, c.actor);
      if (!done) no("没交付上，任务可能刚被删了。");
      return { ok: true, task: full(done!), next: "群里已经自动说过这条任务做完了，不用再 notify_group；有额外要交代的才用" };
    },
  },
  {
    name: "attach_material", title: "挂材料", annotations: WRITE,
    description: "Attach what you produced, or what the next person needs, to a task (挂材料): a report or plan as text (kind report, the full text in text), a link such as a pull request or a page (kind link, url), or a file / picture number from the bot such as x12 or g300 (kind file, url holds the number). "
      + "The board shows it on the task and get_task returns it, so whoever takes the task over, a person or another AI, starts from it. Any task can get material, including one someone else claimed.",
    inputSchema: schema({
      id: TASK_ID, kind: str("What it is", { enum: ["report", "link", "file"] }), title: str("A short name for it"),
      text: str("report: the full text, at most 40000 characters"), url: str("link: the URL; file: the file or picture number"),
    }, ["id", "kind"]),
    run(a, c) {
      const t = need(c, a.id), kind = String(a.kind), text = String(a.text || "").trim(), url = String(a.url || "").trim();
      if (!["report", "link", "file"].includes(kind)) no("kind 只能是 report / link / file。");
      if (kind === "report" ? !text : !url) no(kind === "report" ? "报告的正文是空的（text）。" : "要给链接或编号（url）。");
      if (text.length > 40000) no("正文太长了（" + text.length + " 字），控制在 4 万字以内，更长的放成文件或网页再给链接。");
      if (kind === "link" && !/^https?:\/\//i.test(url)) no("链接要以 http:// 或 https:// 开头。");
      const r = c.d.addTaskRef(c.hub, c.conv, t.id, { kind: kind as any, title: String(a.title || ""), ref: url, text, who: c.actor });
      if (!r) no("没挂上：这件任务挂的材料已经到上限了。");
      return { ok: true, task: t.id, attached: { kind: r!.kind, title: r!.title, url_or_number: r!.ref || undefined, chars: r!.text.length } };
    },
  },
  {
    name: "release_task", title: "退回任务", annotations: WRITE,
    description: "Give a claimed task back (退回) so someone else can take it: status returns to open. Only for tasks claimed by the person you work for. reason is kept as a note.",
    inputSchema: schema({ id: TASK_ID, reason: str("Why it is given back (optional)") }, ["id"]),
    run(a, c) {
      const t = need(c, a.id);
      if (finished(t)) no(finished(t) + "，没什么可退的。");
      if (!mine(t, c)) no(t.claimed_by ? "任务 #" + t.id + " 是" + t.claimed_by + "领的，不是你的，退不了。" : "任务 #" + t.id + " 没人领，不用退。");
      // claimed_by is not in updateTask's patch type; tasks.ts clears it when the status goes back to open (and takes it here if not).
      const back = c.d.updateTask(c.hub, c.conv, t.id, { status: "open", claimed_by: "" } as any, c.actor);
      if (!back) no("没退回去，稍后再试。");
      const reason = String(a.reason || "").trim();
      if (reason) c.d.addTaskNote(c.hub, c.conv, t.id, c.actor, "退回：" + clip(reason, 1000));
      return { ok: true, task: full(back!) };
    },
  },
  {
    name: "add_task", title: "加任务", annotations: WRITE,
    description: "Add a task to the group's list (加任务), for example a follow-up found while working, or a part of your task that you cannot do (set parent to your task and say why in detail). owner is who should do it (a member's nickname, \"bot\", or empty); due is YYYY-MM-DD; "
      + "priority is high / normal / low; after lists the task numbers that must be finished before this one can start.",
    inputSchema: schema({
      title: str("Short title, at most 200 characters"), detail: str("What exactly should be done; for a split-off part: why it is split off and what is already done (optional)"),
      owner: str("Who should do it (optional)"), due: str("Due date YYYY-MM-DD (optional)"),
      priority: str("How urgent (optional)", { enum: ["high", "normal", "low"] }),
      after: { type: "array", items: { type: "integer" }, description: "Task numbers that must be finished first (optional)" },
      parent: int("The task this one is split off from (optional)"),
    }, ["title"]),
    run(a, c) {
      const title = String(a.title).trim(), due = String(a.due || "").trim();
      if (!title) no("标题是空的。");
      if (title.length > 200) no("标题太长，控制在 200 字以内，细节写进 detail。");
      if (String(a.detail || "").length > 4000) no("detail 太长，控制在 4000 字以内。");
      if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) no("due 要写成 2026-11-20 这样的日期。");
      const dep = c.d.checkAfter(c.hub, c.conv, 0, (Array.isArray(a.after) ? a.after : []).map(Number).filter((n: number) => n > 0));
      if (dep.error) no(dep.error + "。");
      const parent = a.parent ? need(c, a.parent) : null;
      const t = c.d.addTask(c.hub, c.conv, { title, detail: String(a.detail || ""), owner: String(a.owner || ""), due, source: parent?.source || "本地 AI", by: c.actor, priority: a.priority, after: dep.ids, parent: parent?.id });
      if (!t) no("任务没加上，稍后再试。");
      if (parent) c.d.addTaskNote(c.hub, c.conv, parent.id, c.actor, "拆出 #" + t!.id + "「" + clip(t!.title, 40) + "」" + (t!.owner ? "交给 " + t!.owner : "，还没定谁做"));
      return { ok: true, task: full(t!) };
    },
  },
  {
    name: "search_chat", title: "翻聊天记录", annotations: READ,
    description: "Search the group's chat history (群聊记录). mode meaning finds passages by what they are about (按意思找, best when you do not know the exact words); words finds lines containing every given word (按关键词, space separated); both (default) does both. "
      + "Use it to find the context of a task: what was asked, decisions, links people shared.",
    inputSchema: schema({
      query: str("What to look for: a natural sentence for meaning, or words for words"),
      mode: str("How to search", { enum: ["both", "meaning", "words"] }),
      days: int("Only the last N days (optional)"),
      who: str("Only what this member said (nickname, meaning search only)"),
    }, ["query"]),
    async run(a, c) {
      const query = String(a.query).trim(), mode = String(a.mode || "both"), days = Math.max(Number(a.days) || 0, 0);
      if (!query) no("要搜什么？query 是空的。");
      const tools = c.hub.tools(c.conv), out: any = { query };
      const use = async (name: string, args: any) => {
        const t = tools.find(x => x.name === name);
        if (!t) return "这项搜索现在用不了";
        try { return await t.run(args); } catch (e: any) { return "没搜成：" + clip(e?.message || e, 200); }
      };
      if (mode !== "words") out.by_meaning = await use("recall", { query, ...(days ? { days } : {}), ...(a.who ? { who: String(a.who) } : {}) });
      if (mode !== "meaning") out.by_words = await use("search_history", { query, days: days || 30 });
      return out;
    },
  },
  {
    name: "get_memory", title: "看长期记忆", annotations: READ,
    description: "The bot's long-term memory document for this group (长期记忆): who is who, ongoing projects, preferences, decisions, rewritten every night from the chat; plus notes taken since the last rewrite. Read-only.",
    inputSchema: schema({}),
    run(_a, c) {
      const memory = c.hub.memoryOf(c.conv), notes = c.hub.notes(c.conv);
      if (!memory && !notes.length) return "这个群还没有长期记忆。";
      return (memory || "（长期记忆还是空的）") + (notes.length ? "\n\n—— 最近记下、还没整理进去的 ——\n" + notes.map(n => "· " + n).join("\n") : "");
    },
  },
  {
    name: "list_files", title: "看文件和图片", annotations: READ,
    description: "Files and pictures the bot kept for this group (文件 f12, 图片 g12): reference, name, note, size, when. kind: all (default), files or images. query filters by name or note. Use get_file to read one.",
    inputSchema: schema({
      kind: str("Which ones", { enum: ["all", "files", "images"] }),
      query: str("Only names or notes containing this (optional)"),
      limit: int("At most this many, default 20, up to 50"),
    }),
    run(a, c) {
      const kind = String(a.kind || "all"), limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50), q = String(a.query || "").trim();
      const like = "%" + q.replace(/[%_\\]/g, m => "\\" + m) + "%";
      const files = kind === "images" ? [] : rows(c.hub, "SELECT id, ts, name, src, COALESCE(size, length(data)) size FROM blob WHERE conv=?" + (q ? " AND name LIKE ? ESCAPE '\\'" : "") + " ORDER BY id DESC LIMIT ?", c.conv, ...(q ? [like] : []), limit)
        .map(r => ({ ref: "f" + r.id, name: String(r.name || ""), size: Number(r.size) || 0, when: when(Number(r.ts)), ...(r.src ? { from: clip(r.src, 80) } : {}), ts: Number(r.ts) }));
      const images = kind === "files" ? [] : rows(c.hub, "SELECT id, ts, mime, note, name, COALESCE(size, length(data)) size FROM img WHERE conv=? AND (name IS NULL OR name NOT LIKE 'sticker:%')" + (q ? " AND (note LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')" : "") + " ORDER BY id DESC LIMIT ?", c.conv, ...(q ? [like, like] : []), limit)
        .map(r => ({ ref: "g" + r.id, ...(r.name ? { name: String(r.name) } : {}), note: clip(r.note, 160), type: String(r.mime || ""), size: Number(r.size) || 0, when: when(Number(r.ts)), ts: Number(r.ts) }));
      const all = [...files, ...images].sort((x, y) => y.ts - x.ts).slice(0, limit).map(({ ts, ...r }) => r);
      return { count: all.length, items: all, ...(all.length ? {} : { note: "没有找到" }) };
    },
  },
  {
    name: "get_file", title: "取文件", annotations: READ,
    description: "One kept file or picture by reference (f12 or g12). A small text file comes back with its content; a picture up to 1 MB comes back as an image you can look at; for anything else you get a download URL and a curl command (it needs the Authorization header shown).",
    inputSchema: schema({ ref: str("f12 for a file, g12 for a picture") }, ["ref"]),
    async run(a, c) {
      const m = /^\s*([fg])(\d+)\s*$/i.exec(String(a.ref));
      if (!m) no("ref 要写成 f12（文件）或 g12（图片）。");
      const image = m![1].toLowerCase() === "g", id = Number(m![2]);
      const row = rows(c.hub, image ? "SELECT id, ts, mime, note, name, data, r2, COALESCE(size, length(data)) size FROM img WHERE id=? AND conv=?" : "SELECT id, ts, name, src, data, r2, COALESCE(size, length(data)) size FROM blob WHERE id=? AND conv=?", id, c.conv)[0];
      if (!row) no("这个群里没有 " + m![0].trim() + "。用 list_files 看看有哪些。");
      const size = Number(row.size) || 0, path = "/x/board/" + (image ? "img/" : "file/") + id, url = c.base + path;
      const info: any = { ref: (image ? "g" : "f") + id, name: String(row.name || ""), ...(image ? { note: String(row.note || ""), type: String(row.mime || "") } : {}), size, when: when(Number(row.ts)) };
      const link = { download: url, curl: "curl -fsSL -H 'Authorization: Bearer " + c.token + "' -o '" + (String(row.name || "").replace(/[^\w.一-鿿-]/g, "_") || info.ref) + "' '" + url + "'" };
      if (image && size <= IMAGE_MAX) {
        const bytes = await c.hub.store.bytes(row);
        if (bytes) return { _content: [{ type: "text", text: JSON.stringify({ ...info, ...link }) }, { type: "image", data: b64(bytes), mimeType: info.type || "image/jpeg" }] };
      }
      if (!image && size <= TEXT_MAX && (TEXTY.test(info.name) || !/\.[a-z0-9]{1,5}$/i.test(info.name))) {
        const bytes = await c.hub.store.bytes(row);
        if (bytes && !bytes.includes(0)) {
          try { return { ...info, content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes) }; } catch {}
        }
      }
      return { ...info, ...link };
    },
  },
  {
    name: "repo_status", title: "仓库体检", annotations: READ,
    description: "The nightly repository check (仓库体检) of the team's repositories: latest commits, who committed, whether install, tests and type checks passed, the first failing lines. repo picks one repository (e.g. TeamAgent); empty returns all. Say which night it was checked.",
    inputSchema: schema({ repo: str("Repository name (optional)") }),
    async run(a, c) {
      const t = c.hub.tools(c.conv).find(x => x.name === "repo_health");
      if (!t) no("仓库体检现在用不了。");
      return t!.run({ op: "last", ...(a.repo ? { repo: String(a.repo) } : {}) });
    },
  },
  {
    name: "notify_group", title: "在群里说一声", annotations: { ...WRITE, openWorldHint: true },
    description: "Say something in the group chat (发到群里) through the bot, shown as 【<person>的本地 AI】<text>. Use it when the person asks you to tell the group something, or when the group should hear it now: a result worth announcing, a question for a teammate that blocks the task, a hand-over. "
      + "Claiming, completing and releasing a task are already announced automatically, so do not repeat those. Keep it to what a teammate would want to read; routine progress belongs in report_progress, which does not interrupt the chat. At most 500 characters.",
    inputSchema: schema({ text: str("The message, at most 500 characters; mention the task number when it is about a task"), task: int("The task it is about (optional)") }, ["text"]),
    async run(a, c) {
      const text = String(a.text).trim().replace(/\s*\n\s*/g, " ");
      if (!text) no("消息是空的。");
      if (text.length > 500) no("消息太长了（" + text.length + " 字），群消息最多 500 字，长的放进 complete_task 的结果里。");
      if (a.task !== undefined) need(c, a.task);
      const limit = cfg(c.hub, c.conv, "mcp_notify_daily");
      if (!count(c.hub, "notify", c.who, limit)) no("今天" + c.who.name + "的本地 AI 已经在群里发了 " + limit + " 条，到上限了；进展请用 report_progress 记在任务上。");
      const said = await c.hub.say(c.conv, "【" + c.actor + "】" + text);
      return said ? { ok: true, sent: "已经发到群里" } : { ok: true, sent: "QQ 这会儿没让发，已经排队，群里下一个人说话时补发" };
    },
  },
];

// ---------- JSON-RPC ----------
type Msg = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any; result?: any; error?: any };
type Out = { body: any; status: number } | null;   // null: a notification, nothing to answer
const err = (id: any, code: number, message: string, data?: any) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const ok = (id: any, result: any) => ({ jsonrpc: "2.0", id, result });
const isId = (v: any) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const decodeHeader = (v: string) => {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v);
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), ch => ch.charCodeAt(0))); } catch { return "\0"; }
};

async function callTool(p: any, c: Call) {
  const tool = TOOLS.find(t => t.name === p.name)!;
  const a = p.arguments ?? {}, s = tool.inputSchema;
  const say = (text: string) => ({ content: [{ type: "text", text }], isError: true });
  for (const k of s.required || []) if (a[k] === undefined || a[k] === null || a[k] === "") return say("缺少参数 " + k + "。");
  for (const [k, v] of Object.entries<any>(a)) {
    const d = s.properties[k];
    if (!d) return say("不认识参数 " + k + "，能用的有：" + (Object.keys(s.properties).join("、") || "无") + "。");
    if (v === null || v === undefined) continue;
    const t = d.type, bad = t === "integer" ? !Number.isInteger(v) : t === "array" ? !Array.isArray(v) || v.some((x: any) => (d.items?.type === "integer" ? !Number.isInteger(x) : typeof x !== "string")) : typeof v !== t;
    if (bad) return say("参数 " + k + " 应该是" + ({ string: "文字", integer: "整数", boolean: "true 或 false", array: d.items?.type === "integer" ? "整数列表" : "文字列表" } as any)[t] + "。");
    if (d.enum && !d.enum.includes(v)) return say("参数 " + k + " 只能是 " + d.enum.join(" / ") + "。");
  }
  const limit = cfg(c.hub, c.conv, "mcp_calls_daily");
  if (!count(c.hub, "calls", c.who, limit)) return say("今天" + c.who.name + "的本地 AI 已经调用了 " + limit + " 次，到每天的上限了，明天再来。");
  const t0 = Date.now();
  let res: any, error = "";
  try {
    const r = await tool.run(a, c);
    res = r && typeof r === "object" && r._content ? { content: r._content }
      : { content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r) }] };
  } catch (e: any) {
    error = e instanceof Refused ? e.message : "出错了：" + clip(e?.message || e, 300);
    if (!(e instanceof Refused)) console.log("mcp tool failed", tool.name, e?.stack || e);
    res = say(error);
  }
  try {   // shows up in /admin/toolruns next to the chat's own tool calls
    c.hub.sql.exec("INSERT INTO toolrun(turn,conv,ts,name,ms,ok,args,error) VALUES(?,?,?,?,?,?,?,?)", 0, c.conv, Date.now(), "mcp:" + tool.name, Date.now() - t0, error ? 0 : 1, clip(c.actor + " " + JSON.stringify(a), 300), error || null);
  } catch {}
  return res;
}

async function one(m: Msg, c: Call, req: Request | null): Promise<Out> {
  if (!m || typeof m !== "object" || Array.isArray(m)) return { body: err(null, -32600, "Invalid Request"), status: 400 };
  if (m.method === undefined && ("result" in m || "error" in m)) return null;   // a response from the client: we never ask anything
  const hasId = "id" in m && m.id !== undefined;
  if (m.jsonrpc !== "2.0" || typeof m.method !== "string" || (hasId && !isId(m.id) && m.id !== null)) return { body: err(isId(m.id) ? m.id : null, -32600, "Invalid Request"), status: 400 };
  if (m.params !== undefined && (typeof m.params !== "object" || m.params === null)) return hasId ? { body: err(m.id, -32602, "Invalid params: params must be an object"), status: 400 } : null;
  if (!hasId) return null;   // notifications (initialized, cancelled, …) need no answer
  const id = m.id, p = m.params || {}, meta = p._meta || {}, version: unknown = meta[PV];
  const hv = req?.headers.get("mcp-protocol-version") || "";
  const all = [...MODERN, ...LEGACY];
  // Era: a request carrying a version in _meta is modern; anything else follows the legacy handshake rules.
  let modern = false;
  if (version !== undefined) {
    if (typeof version !== "string") return { body: err(id, -32602, "Invalid params: _meta protocol version must be a string"), status: 400 };
    if (req && hv !== version) return { body: err(id, -32020, "Header mismatch: MCP-Protocol-Version header '" + hv + "' does not match body value '" + version + "'"), status: 400 };
    if (!MODERN.includes(version)) return { body: err(id, -32022, "Unsupported protocol version", { supported: all, requested: version }), status: 400 };
    modern = true;
    if (req) {
      const hm = req.headers.get("mcp-method");
      if (hm !== m.method) return { body: err(id, -32020, hm === null ? "Header mismatch: Mcp-Method header is missing" : "Header mismatch: Mcp-Method header value '" + hm + "' does not match body value '" + m.method + "'"), status: 400 };
      if (m.method === "tools/call") {
        const hn = req.headers.get("mcp-name");
        if (hn === null || decodeHeader(hn) !== p.name) return { body: err(id, -32020, hn === null ? "Header mismatch: Mcp-Name header is missing" : "Header mismatch: Mcp-Name header does not match body value"), status: 400 };
      }
    }
  } else if (req && hv && m.method !== "initialize" && !LEGACY.includes(hv)) {
    return MODERN.includes(hv)
      ? { body: err(id, -32020, "Header mismatch: MCP-Protocol-Version header is '" + hv + "' but the request has no _meta protocol version"), status: 400 }
      : { body: err(id, -32022, "Unsupported protocol version", { supported: all, requested: hv }), status: 400 };
  }
  const done = (result: any) => ({ body: ok(id, modern ? { resultType: "complete", ...result } : result), status: 200 });
  switch (m.method) {
    case "initialize": {
      const want = String(p.protocolVersion || "");
      return done({
        protocolVersion: LEGACY.includes(want) ? want : LEGACY[0],
        capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return done({ supportedVersions: all, capabilities: { tools: { listChanged: false } }, _meta: { "io.modelcontextprotocol/serverInfo": SERVER }, instructions: INSTRUCTIONS });
    case "ping": return done({});
    case "tools/list": return done({ tools: TOOLS.map(({ run, ...t }) => t) });
    case "tools/call": {
      if (typeof p.name !== "string") return { body: err(id, -32602, "Invalid params: name is required"), status: modern ? 400 : 200 };
      if (!TOOLS.some(t => t.name === p.name)) return { body: err(id, -32602, "Unknown tool: " + p.name), status: modern ? 400 : 200 };
      if (p.arguments !== undefined && (typeof p.arguments !== "object" || p.arguments === null || Array.isArray(p.arguments))) return { body: err(id, -32602, "Invalid params: arguments must be an object"), status: modern ? 400 : 200 };
      return done(await callTool(p, c));
    }
    default:
      return { body: err(id, -32601, "Method not found: " + m.method), status: modern ? 404 : 200 };
  }
}

const reply = (status: number, body?: any, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), "Cache-Control": "no-store", ...headers } });

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (Number(req.headers.get("content-length") || 0) > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader(), parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}

/** The whole endpoint; `d` is replaced in tests. */
export async function handleMcp(hub: Hub, req: Request, url: URL, d: Deps = DEPS): Promise<Response | null> {
  const path = /^\/x\/mcp(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!path) return null;
  const origin = req.headers.get("origin");
  if (origin && !bases(hub).some(b => new URL(b).origin === origin) && origin !== url.origin) return reply(403, err(null, -32600, "Forbidden origin"));
  const token = path[1] || bearerToken(req.headers.get("authorization"));
  const who = token ? await d.checkAccess(hub, token) : null;
  if (!who) return reply(401, err(null, -32001, "这个令牌无效或已作废。在群里对 Bot 说“给我看板链接”拿一个新的。"), { "WWW-Authenticate": 'Bearer realm="teamagent"' });
  if (req.method !== "POST") return reply(405, err(null, -32600, "Method not allowed: this server only answers POST (no server stream, no sessions)"), { Allow: "POST" });
  const raw = await readCapped(req, BODY_MAX);
  if (!raw) return reply(413, err(null, -32600, "Request body too large (limit 1 MB)"));
  let msg: any;
  try { msg = JSON.parse(new TextDecoder().decode(raw)); } catch { return reply(400, err(null, -32700, "Parse error")); }
  const b = bases(hub), base = b.find(x => new URL(x).origin === url.origin) || b[b.length - 1];
  const c: Call = { hub, conv: who.conv, who, actor: who.name + "的本地 AI", token, base, d };
  if (Array.isArray(msg)) {
    if (!msg.length) return reply(400, err(null, -32600, "Invalid Request: empty batch"));
    const outs = (await Promise.all(msg.slice(0, 50).map(m => one(m, c, null)))).filter(Boolean).map(o => o!.body);
    return outs.length ? reply(200, outs) : reply(202);
  }
  const out = await one(msg, c, req);
  return out ? reply(out.status, out.body) : reply(202);
}

const feature: Feature = {
  name: "mcp",
  tunables: TUNABLES,
  open: (hub, req, url) => handleMcp(hub, req, url),
  about: [
    "群友电脑上的 AI 工具（Claude Code 等支持 MCP 的）可以接群里的活：用看板链接里同一个令牌连上 /x/mcp，它就能看任务清单、领任务、记进展、交付结果，还能翻群聊记录、看长期记忆、看我存的文件和图片、看仓库体检。",
    "本地 AI 做的每件事都记成“某某的本地 AI”；别人领了的任务它交付不了，只能留进展。它只能碰任务清单，改不了我的设置、记忆和代码。",
    "本地 AI 接任务、做完、放下时我会自动在群里说一句；它也能让我在群里替它说话（值得大家知道的结果、卡住要问人的事、交接），开头写明是谁的本地 AI，每人每天默认最多 30 条、每条 500 字以内；每人每天调用工具默认最多 500 次，这两个数可以调。",
    "连法：在群里让我给看板链接，回复里有一行 claude mcp add 的命令，在自己电脑的终端里运行就连上了；令牌作废后本地 AI 也就连不上了。",
  ],
};
export default feature;
