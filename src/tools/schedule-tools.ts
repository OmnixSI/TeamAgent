// D3b：日程 v2 的四个工具（design §5.5）。D4 负责删掉 semantic.ts 里的旧定义/旧 case，
// 之后这些名字由 toolkit 的 EXTRA_TOOLS 兜住。
//
// 三条硬规则：
// 1. when_text / 用户原话经 parseWhen 的结果优先于模型自己填的 time/tz（不一致记 overrides）。
// 2. 缺时间只问一次：写 pending_actions（30 分钟），同一人同一群下一次给时间就补建（RC-07）。
// 3. update/cancel 只允许 owner 或管理员（mute 例外：任何人可取消自己的闭嘴）。
import type { BotTool, ToolCtx } from "../toolkit";
import {
  cadenceOf,
  createSchedule,
  describeSchedule,
  dualText,
  listSchedules,
  parseRunAt,
  planSchedule,
  type ScheduleKind,
  type ScheduleSpec,
} from "../schedules";
import { describeWhen, parseContent, parseWhen, type When } from "../schedule-parse";
import { isAutoSender } from "../feature-request-core";

const DEFAULT_TZ = "Australia/Sydney";
const PENDING_TTL = 30 * 60 * 1000;
const TZ_VALUES = new Set(["Asia/Shanghai", "Australia/Sydney", "UTC"]);

type Violation = { field: string; model: string; parsed: string };
/** D4 可接：模型填的时间与用户原话解析结果不一致时回调。默认只进结果的 overrides。 */
export type ViolationHook = (v: Violation & { group_id: string; source_msg_id: string }) => void | Promise<void>;
let violationHook: ViolationHook | null = null;
export function setScheduleViolationHook(hook: ViolationHook | null) {
  violationHook = hook;
}

function scope(ctx: ToolCtx) {
  const latest = ctx?.context?.latest || {};
  return {
    groupId: String(latest.group_id || ""),
    sender: String(latest.sender || ""),
    sourceId: String(latest.id || ""),
    body: String(latest.body || ""),
  };
}

function normalizeTz(value: unknown): string | null {
  const tz = String(value ?? "").trim();
  if (!tz) return null;
  if (tz === "北京时间") return "Asia/Shanghai";
  if (tz === "悉尼时间") return "Australia/Sydney";
  return TZ_VALUES.has(tz) ? tz : null;
}

function failure(error_kind: string, reason_text: string, say?: string) {
  return {
    ok: false,
    error_kind,
    retryable: false,
    reason_text,
    say: say || reason_text,
  };
}

function stable(step: any) {
  if (!step || typeof step !== "object") return String(step);
  const keys = Object.keys(step).sort();
  return JSON.stringify(step, keys);
}

/** 模型 steps 与 parser steps 合并去重，保持先出现者在前。 */
function mergeSteps(a: unknown, b: unknown): any[] {
  const out: any[] = [];
  const seen = new Set<string>();
  for (const step of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!step || typeof step !== "object") continue;
    const key = stable(step);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(step);
  }
  return out;
}

/** 纯聊天总结走旧 digest 路径；有动作或成文说明才是 agent_task。 */
function pickKind(input: {
  asked?: unknown;
  steps: any[];
  note: string;
  cadence: string;
}): ScheduleKind {
  const asked = String(input.asked ?? "");
  const known: ScheduleKind[] = ["digest_daily", "digest_weekly", "reminder", "mute", "agent_task"];
  const base = known.includes(asked as ScheduleKind) ? (asked as ScheduleKind) : null;
  const actionful = input.steps.some((s) => s?.action && s.action !== "text" && s.action !== "chat_digest");
  const pureDigest = input.steps.length > 0 && input.steps.every((s) => s?.action === "chat_digest");
  if (actionful || input.note) return "agent_task";
  if (input.steps.length && base === "agent_task") return "agent_task";
  if (pureDigest) return input.cadence === "weekly" ? "digest_weekly" : "digest_daily";
  if (input.steps.length && input.cadence !== "once") return "agent_task";
  if (base) return base;
  if (input.cadence === "once") return "reminder";
  return input.cadence === "weekly" ? "digest_weekly" : "digest_daily";
}

/** 模型自己填的结构化时间，作为原话解析不出来时的兜底。 */
function whenFromArgs(args: any, now: number, tz: string): When | null {
  const cadence = String(args?.cadence || "");
  const time = String(args?.time || "").trim();
  const inferred =
    cadence ||
    (Array.isArray(args?.month_days) && args.month_days.length
      ? "monthly"
      : Number(args?.every_minutes) > 0
        ? "every"
        : args?.run_at
          ? "once"
          : Array.isArray(args?.weekdays) && args.weekdays.length
            ? "weekly"
            : time
              ? "daily"
              : "");
  if (inferred === "daily" && /^\d{2}:\d{2}$/.test(time)) return { cadence: "daily", time, tz };
  if (inferred === "weekly" && /^\d{2}:\d{2}$/.test(time)) {
    const days: number[] = ((args.weekdays || []) as any[])
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length) return { cadence: "weekly", time, weekdays: [...new Set<number>(days)].sort((a, b) => a - b), tz };
  }
  if (inferred === "monthly" && /^\d{2}:\d{2}$/.test(time)) {
    const days: number[] = ((args.month_days || [1]) as any[]).map((d) => Number(d));
    if (days.length) return { cadence: "monthly", time, month_days: [...new Set<number>(days)].sort((a, b) => a - b), tz };
  }
  if (inferred === "every" && Number(args?.every_minutes) > 0) {
    const window = Array.isArray(args.window) && args.window.length === 2 ? (args.window as [string, string]) : undefined;
    const until = args?.until ? parseRunAt(args.until, tz) : 0;
    return { cadence: "every", every_minutes: Number(args.every_minutes), ...(window ? { window } : {}), ...(until > now ? { until } : {}), tz };
  }
  if (inferred === "once" && args?.run_at) {
    const runAt = parseRunAt(args.run_at, tz);
    if (runAt > now) return { cadence: "once", run_at: runAt, tz };
  }
  return null;
}

/** 结构化字段与原话解析结果对不上时，全部记下来（用解析结果）。 */
function violationsOf(args: any, when: When): Violation[] {
  const out: Violation[] = [];
  const parsedCadence = when.cadence;
  if (args?.cadence && String(args.cadence) !== parsedCadence)
    out.push({ field: "cadence", model: String(args.cadence), parsed: parsedCadence });
  const parsedTime = "time" in when ? when.time : "";
  if (args?.time && parsedTime && String(args.time) !== parsedTime)
    out.push({ field: "time", model: String(args.time), parsed: parsedTime });
  if (args?.tz) {
    const tz = normalizeTz(args.tz);
    if (tz && tz !== when.tz) out.push({ field: "tz", model: tz, parsed: when.tz });
  }
  if (Array.isArray(args?.weekdays) && when.cadence === "weekly") {
    const a = [...new Set<number>((args.weekdays as any[]).map((d) => Number(d)))].sort((x, y) => x - y);
    const b = [...when.weekdays].sort((x, y) => x - y);
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: "weekdays", model: JSON.stringify(a), parsed: JSON.stringify(b) });
  }
  if (Array.isArray(args?.month_days) && when.cadence === "monthly") {
    const a = [...new Set<number>((args.month_days as any[]).map((d) => Number(d)))].sort((x, y) => x - y);
    const b = [...new Set<number>(when.month_days)].sort((x, y) => x - y);
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: "month_days", model: JSON.stringify(a), parsed: JSON.stringify(b) });
  }
  if (Number(args?.every_minutes) > 0 && when.cadence === "every" && Number(args.every_minutes) !== when.every_minutes)
    out.push({ field: "every_minutes", model: String(args.every_minutes), parsed: String(when.every_minutes) });
  return out;
}

/** When → 写入 schedules.spec 的时间字段（先清掉旧节奏的残留）。 */
function specTimingOf(when: When): ScheduleSpec {
  const spec: ScheduleSpec = { cadence: when.cadence };
  if (when.cadence === "daily" || when.cadence === "weekly" || when.cadence === "monthly") spec.time = when.time;
  if (when.cadence === "weekly") spec.weekdays = [...when.weekdays];
  if (when.cadence === "monthly") spec.month_days = [...when.month_days];
  if (when.cadence === "once") spec.run_at = when.run_at;
  if (when.cadence === "every") {
    spec.every_minutes = when.every_minutes;
    if (when.window) spec.window = [...when.window] as [string, string];
    if (when.until) spec.until = when.until;
  }
  return spec;
}

// ---------- pending_actions（§5.1） ----------
async function openPending(e: any, groupId: string, sender: string, tool: string, id?: string) {
  const row = id
    ? await e.DB.prepare("SELECT * FROM pending_actions WHERE id=?").bind(id).first()
    : await e.DB.prepare(
        "SELECT * FROM pending_actions WHERE group_id=? AND sender=? AND tool=? AND status='open' ORDER BY asked_at DESC LIMIT 1",
      )
        .bind(groupId, sender, tool)
        .first();
  if (!row) return null;
  if (row.group_id !== groupId || row.sender !== sender || row.tool !== tool) return null;
  if (Number(row.expires_at) <= Date.now()) {
    await e.DB.prepare("UPDATE pending_actions SET status='expired' WHERE id=? AND status='open'").bind(row.id).run();
    return null;
  }
  return row;
}

async function putPending(
  e: any,
  input: { id: string; groupId: string; sender: string; tool: string; draft: unknown; missing: string; now: number },
) {
  await e.DB.prepare(
    "INSERT OR REPLACE INTO pending_actions(id,group_id,sender,tool,draft,missing,status,asked_at,expires_at) VALUES(?,?,?,?,?,?,'open',?,?)",
  )
    .bind(
      input.id,
      input.groupId,
      input.sender,
      input.tool,
      JSON.stringify(input.draft),
      input.missing,
      input.now,
      input.now + PENDING_TTL,
    )
    .run();
}

function parseDraft(raw: unknown): any {
  try {
    return JSON.parse(String(raw || "{}")) || {};
  } catch {
    return {};
  }
}

function displayTitle(kind: string, spec: ScheduleSpec, fallback: string) {
  const title = String(spec.title || spec.topic || "").trim();
  if (title) return title;
  if (kind === "reminder") return String(spec.text || fallback).slice(0, 40);
  if (kind === "agent_task") {
    const actions = (Array.isArray(spec.steps) ? spec.steps : []).map((s: any) => String(s?.action || "")).filter(Boolean);
    return actions.length ? actions.join("+") : "定时任务";
  }
  return fallback;
}

function receiptOf(kind: string, spec: ScheduleSpec, tz: string, nextRunAt: number, when: When | null, now: number, head: string) {
  const absolute = dualText(nextRunAt, tz);
  const scheduleText = when ? describeWhen(when, now) : describeSchedule({ kind, tz, spec: JSON.stringify(spec) });
  const what = displayTitle(kind, spec, "定时推送");
  return {
    next_run_text: absolute,
    say: `${head}，${scheduleText} 发${what}，下次是 ${absolute}。`,
  };
}

async function findSchedule(e: any, groupId: string, args: any) {
  const id = String(args?.id || "").trim();
  if (id) return e.DB.prepare("SELECT * FROM schedules WHERE id=? AND group_id=?").bind(id, groupId).first();
  const topic = String(args?.topic || "").trim();
  if (!topic) return null;
  return e.DB.prepare(
    "SELECT * FROM schedules WHERE group_id=? AND status IN ('active','paused') AND (json_extract(spec,'$.topic')=? OR json_extract(spec,'$.title')=?) ORDER BY created_at DESC LIMIT 1",
  )
    .bind(groupId, topic, topic)
    .first();
}

async function canManage(e: any, row: any, sender: string) {
  if (String(row?.owner || "") === sender) return true;
  return isAutoSender(e, sender);
}

// ---------- 工具定义 ----------
const createParameters = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: ["digest_daily", "digest_weekly", "reminder", "mute", "agent_task"],
      description: "旧四类；能确定要做动作（查账本/余额/token/聊天总结）时填 agent_task，不确定就不填",
    },
    when_text: { type: "string", description: "用户原话里讲时间的那一段，原样抄，例如「每天北京时间0点」「每月1号早上9点」" },
    cadence: { type: "string", enum: ["daily", "weekly", "monthly", "once", "every"] },
    time: { type: "string", description: "HH:MM；只在原话没写清时填" },
    tz: { type: "string", enum: ["Asia/Shanghai", "Australia/Sydney", "UTC"] },
    weekdays: { type: "array", items: { type: "integer" }, description: "0=周日" },
    month_days: { type: "array", items: { type: "integer" }, description: "1..31；-1=当月最后一天" },
    run_at: { type: "string", description: "一次性时间，ISO 8601 带时区" },
    minutes: { type: "integer" },
    every_minutes: { type: "integer", description: "5..1440" },
    until: { type: "string", description: "截止时间，ISO 8601 带时区" },
    steps: { type: "array", items: { type: "object" }, description: "动作步骤（§5.4）；有它且非纯聊天总结就是 agent_task" },
    content_text: { type: "string", description: "用户说要发什么的那段原话" },
    title: { type: "string", description: "回执与推送标题，≤40 字" },
    note: { type: "string", description: "成文说明，≤600 字；有它就用模型按说明成文" },
    topic: { type: "string" },
    text: { type: "string", description: "提醒正文（kind=reminder 时）" },
    pending_id: { type: "string", description: "上一轮缺时间时返回的 pending_id；补时间时带上" },
    source_id: { type: "string", description: "本条交办的消息 ID，默认最新消息" },
  },
  additionalProperties: false,
};

export const scheduleCreateTool: BotTool = {
  name: "schedule_create",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "schedule_create",
      description:
        "在群里登记定时任务/提醒。群友说「每天/每周/每月/每N分钟/明天几点」要发什么或提醒什么时当场调用，不要只口头答应。" +
        "把用户讲时间的那段原话原样放进 when_text（例如「每天北京时间0点」），把说要发什么放进 content_text。" +
        "原话里没写几点就调用一次、不要猜：工具会返回 need=time，你只问一句「几点发？」。" +
        "没调用成功前不要说「记下了」「会发」。",
      parameters: createParameters,
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const { groupId, sender, sourceId, body } = scope(ctx);
    if (!groupId) return failure("invalid_args", "缺少群信息", "这次没登记上：我不知道是哪个群。");
    const now = Date.now();
    const pending = await openPending(e, groupId, sender, "schedule_create", args?.pending_id ? String(args.pending_id) : undefined);
    const draft = pending ? parseDraft(pending.draft) : {};
    const continuing = !!pending;

    // 1) 时间：原话 > 模型字段。补时间的第二轮只看这一条新消息。
    const whenText = String(args?.when_text || (continuing ? body : body) || "").trim();
    const tzFromArgs = normalizeTz(args?.tz) || normalizeTz(draft.tz) || DEFAULT_TZ;
    const parsed = whenText ? parseWhen(whenText, now, tzFromArgs) : null;
    const violations = parsed?.ok ? violationsOf(args, parsed.when) : [];
    const when: When | null = parsed?.ok ? parsed.when : whenFromArgs({ ...draft, ...stripEmpty(args) }, now, tzFromArgs);
    if (violations.length && violationHook) {
      for (const v of violations) {
        try {
          await violationHook({ ...v, group_id: groupId, source_msg_id: sourceId });
        } catch {
          /* 记录失败不影响登记 */
        }
      }
    }

    // 2) 内容：合并上一轮草稿与本轮步骤，再和 parser 的结果去重合并。
    const stepsAsked = mergeSteps(draft.steps, args?.steps);
    const contentParts: string[] = [];
    if (draft.content_text) contentParts.push(String(draft.content_text));
    if (args?.content_text) contentParts.push(String(args.content_text));
    if (!continuing && !args?.content_text && body) contentParts.push(body);
    let parsedSteps: any[] = [];
    for (const text of contentParts) parsedSteps = mergeSteps(parsedSteps, parseContent(text));
    if (stepsAsked.length && parsedSteps.length === 1 && parsedSteps[0]?.action === "text") parsedSteps = [];
    const steps = mergeSteps(stepsAsked, parsedSteps);
    const note = String(args?.note || draft.note || "").trim();

    if (!when) {
      const pendingId = String(args?.pending_id || pending?.id || `pa-${sourceId || now}`);
      const draftNext = {
        kind: args?.kind || draft.kind,
        cadence: args?.cadence || draft.cadence,
        time: args?.time || draft.time,
        tz: normalizeTz(args?.tz) || draft.tz,
        weekdays: args?.weekdays || draft.weekdays,
        month_days: args?.month_days || draft.month_days,
        run_at: args?.run_at || draft.run_at,
        minutes: args?.minutes || draft.minutes,
        every_minutes: args?.every_minutes || draft.every_minutes,
        until: args?.until || draft.until,
        steps,
        note,
        title: args?.title || draft.title,
        topic: args?.topic || draft.topic,
        text: args?.text || draft.text,
        content_text: contentParts.join("\n").slice(0, 500),
      };
      await putPending(e, {
        id: pendingId,
        groupId,
        sender,
        tool: "schedule_create",
        draft: draftNext,
        missing: "time",
        now,
      });
      return {
        ok: false,
        need: "time",
        pending_id: pendingId,
        say: "几点发？（默认悉尼时间，也可以说北京时间）",
      };
    }

    // 3) 落库。
    const cadence = when.cadence;
    const kind = pickKind({ asked: args?.kind || draft.kind, steps, note, cadence });
    const stepText = String(steps.find((s: any) => s?.action === "text" && s.text)?.text || "").trim();
    // steps 只属于 agent_task：旧 kind 带着 steps 会被 runSchedules 当成动作任务。
    const isAgent = kind === "agent_task";
    const spec: ScheduleSpec = {
      ...specTimingOf(when),
      ...(isAgent && steps.length ? { steps } : {}),
      ...(isAgent && note ? { note } : {}),
      ...(args?.title ? { title: String(args.title).trim() } : draft.title ? { title: String(draft.title).trim() } : {}),
      ...(args?.topic ? { topic: String(args.topic).trim() } : draft.topic ? { topic: String(draft.topic).trim() } : {}),
      ...(args?.text ? { text: String(args.text).trim() } : draft.text ? { text: String(draft.text).trim() } : {}),
      ...(Number(args?.minutes) > 0 ? { minutes: Number(args.minutes) } : {}),
    };
    // 一次性提醒的正文也可能来自 parseContent 的 text 步骤（「提醒我交周报」）。
    if (kind === "reminder" && !spec.text && stepText) spec.text = stepText;
    try {
      const created = await createSchedule(
        e,
        {
          group_id: groupId,
          owner: sender,
          kind,
          spec,
          tz: when.tz,
          source_msg_id: sourceId || undefined,
        },
        now,
      );
      const stored = parseDraft(created.spec);
      const receipt = receiptOf(kind, stored, created.tz, Number(created.next_run_at), when, now, "记下了");
      if (pending) await e.DB.prepare("UPDATE pending_actions SET status='done' WHERE id=?").bind(pending.id).run();
      return {
        ok: true,
        accepted: true,
        family: "schedule",
        id: created.id,
        kind,
        tz: created.tz,
        next_run_at: created.next_run_at,
        next_run_text: receipt.next_run_text,
        say: receipt.say,
        ...(violations.length ? { overrides: violations.map((v) => `${v.field}: ${v.model}→${v.parsed}`) } : {}),
      };
    } catch (error: any) {
      return failure("invalid_args", String(error?.message || error || "登记失败"), `这次没登记上：${String(error?.message || error)}`);
    }
  },
};

function stripEmpty(args: any) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = v;
  }
  return out;
}

export const scheduleUpdateTool: BotTool = {
  name: "schedule_update",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "schedule_update",
      description:
        "改本群已有的定时任务：换时间、换内容、暂停/恢复。只有创建者或管理员能改。用 id 或 topic 指定；时间字段与 schedule_create 相同，when_text 优先。",
      parameters: {
        ...createParameters,
        properties: {
          ...createParameters.properties,
          id: { type: "string", description: "日程 ID（schedule_list 里有）" },
          status: { type: "string", enum: ["paused", "active"], description: "暂停或恢复" },
        },
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const { groupId, sender, sourceId, body } = scope(ctx);
    if (!groupId) return failure("invalid_args", "缺少群信息");
    const row = await findSchedule(e, groupId, args);
    if (!row) return failure("not_found", "本群没有这条日程", "没找到这条日程，先看 schedule_list。");
    if (!(await canManage(e, row, sender)))
      return failure("denied", "只有创建者或管理员可以改这条日程", "这条日程不是你建的，只有创建者或管理员能改。");

    const now = Date.now();
    const existing = parseDraft(row.spec);
    const tz = normalizeTz(args?.tz) || row.tz || DEFAULT_TZ;
    const whenText = String(args?.when_text || "").trim();
    const parsed = whenText ? parseWhen(whenText, now, tz) : null;
    const violations = parsed?.ok ? violationsOf(args, parsed.when) : [];
    const when: When | null = parsed?.ok ? parsed.when : whenFromArgs(args, now, tz);
    if (violations.length && violationHook) {
      for (const v of violations) {
        try {
          await violationHook({ ...v, group_id: groupId, source_msg_id: sourceId });
        } catch {
          /* ignore */
        }
      }
    }

    const spec: ScheduleSpec = { ...existing };
    if (when) {
      for (const key of ["time", "weekdays", "month_days", "run_at", "every_minutes", "window", "until"] as const) delete (spec as any)[key];
      Object.assign(spec, specTimingOf(when));
    }
    const contentParts: string[] = [];
    if (args?.content_text) contentParts.push(String(args.content_text));
    if (!args?.content_text && args?.when_text !== body && body) contentParts.push(body);
    let parsedSteps: any[] = [];
    for (const text of contentParts) parsedSteps = mergeSteps(parsedSteps, parseContent(text));
    const askedSteps = mergeSteps(existing.steps, args?.steps);
    if (askedSteps.length && parsedSteps.length === 1 && parsedSteps[0]?.action === "text") parsedSteps = [];
    const steps = mergeSteps(askedSteps, parsedSteps);
    if (steps.length) spec.steps = steps;
    if (args?.note !== undefined) {
      const note = String(args.note || "").trim();
      if (note) spec.note = note;
      else delete spec.note;
    }
    if (args?.title) spec.title = String(args.title).trim();
    if (args?.topic) spec.topic = String(args.topic).trim();
    if (args?.text) spec.text = String(args.text).trim();

    const kind: ScheduleKind = steps.length
      ? pickKind({ asked: row.kind, steps, note: String(spec.note || ""), cadence: cadenceOf(spec) })
      : (row.kind as ScheduleKind);
    const paused = String(args?.status || "") === "paused";
    try {
      // 复用 planSchedule 的校验，但不新建行：更新已有 id。
      const plan = planSchedule({ group_id: groupId, owner: row.owner, kind, spec, tz }, now);
      await e.DB.prepare(
        "UPDATE schedules SET kind=?,tz=?,spec=?,next_run_at=?,status=?,last_error=NULL WHERE id=? AND group_id=?",
      )
        .bind(
          kind,
          tz,
          JSON.stringify(plan.spec),
          paused ? null : plan.next_run_at,
          paused ? "paused" : "active",
          row.id,
          groupId,
        )
        .run();
      const receipt = receiptOf(kind, plan.spec, tz, plan.next_run_at, when, now, paused ? "已暂停" : "改好了");
      return {
        ok: true,
        accepted: true,
        family: "schedule",
        id: row.id,
        kind,
        tz,
        next_run_at: paused ? null : plan.next_run_at,
        next_run_text: paused ? "已暂停" : receipt.next_run_text,
        say: paused ? `已暂停「${displayTitle(kind, plan.spec, describeSchedule(row))}」，要恢复就跟我说。` : receipt.say,
        ...(violations.length ? { overrides: violations.map((v) => `${v.field}: ${v.model}→${v.parsed}`) } : {}),
      };
    } catch (error: any) {
      return failure("invalid_args", String(error?.message || error || "改不了"), `这次没改成：${String(error?.message || error)}`);
    }
  },
};

export const scheduleListTool: BotTool = {
  name: "schedule_list",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "schedule_list",
      description:
        "查本群日程：每条带 id、标题、双时区下次时间、最近一次到底发没发（sent/failed/none）、连续失败次数和状态。" +
        "群友问「我的日报呢」「有几个定时」时调用，按结果说，不要猜。",
      parameters: {
        type: "object",
        properties: { include_done: { type: "boolean", description: "连已取消/已完成一起列" } },
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const { groupId } = scope(ctx);
    if (!groupId) return failure("invalid_args", "缺少群信息");
    const all = await listSchedules(e, groupId, { includeDone: args?.include_done === true });
    const rows = (all as any[]).map((s) => ({
      id: s.id,
      title: s.title || s.description,
      kind: s.kind,
      status: s.status,
      next_run_text: s.next_run_text,
      last_run_status: (s as any).last_run_status || "none",
      fail_count: s.fail_count || 0,
    }));
    const lines = rows.length
      ? rows
          .map((s, i) => {
            const mark = s.status === "paused" ? "（已暂停）" : s.status === "done" ? "（已完成）" : "";
            return `${i + 1}. ${s.title}${mark} · 下次 ${s.next_run_text} · 最近一次 ${
              s.last_run_status === "sent" ? "已发出" : s.last_run_status === "failed" ? "失败" : "还没跑过"
            }${s.fail_count ? ` · 连续失败 ${s.fail_count} 次` : ""} · id ${s.id}`;
          })
          .join("\n")
      : "本群还没有日程。";
    return { ok: true, schedules: rows, say: lines };
  },
};

export const scheduleCancelTool: BotTool = {
  name: "schedule_cancel",
  untrusted: false,
  def: {
    type: "function",
    function: {
      name: "schedule_cancel",
      description:
        "取消本群的一条日程（用 id 或 topic）。只有创建者或管理员能取消；闭嘴（mute）例外，任何人可以取消自己的。取消后不能再发，需要的话重新建。",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          topic: { type: "string" },
        },
        additionalProperties: false,
      },
    },
  },
  async run(e: any, args: any, ctx: ToolCtx) {
    const { groupId, sender } = scope(ctx);
    if (!groupId) return failure("invalid_args", "缺少群信息");
    const row = await findSchedule(e, groupId, args);
    if (!row) return failure("not_found", "本群没有这条日程", "没找到这条日程，先看 schedule_list。");
    const ownMute = row.kind === "mute" && String(row.owner || "") === sender;
    if (!ownMute && !(await canManage(e, row, sender)))
      return failure("denied", "只有创建者或管理员可以取消这条日程", "这条日程不是你建的，只有创建者或管理员能取消。");
    await e.DB.prepare("UPDATE schedules SET status='cancelled',next_run_at=NULL WHERE id=? AND group_id=?")
      .bind(row.id, groupId)
      .run();
    return {
      ok: true,
      accepted: true,
      family: "schedule",
      id: row.id,
      status: "cancelled",
      say: `已取消「${displayTitle(row.kind, parseDraft(row.spec), describeSchedule(row))}」。`,
    };
  },
};
