// V-D-learning · L6 确认/取消/撤销。
// 群友回复晨报/回执/推送时在这里直接处理，不再进入聊天模型；这是 behavior_rules/schedules 的唯一写入入口。
// 授权：requester 本人，或 members.role ∈ {owner,admin}。所有写入与回执放进同一个 db.batch，回执 INSERT OR IGNORE。
import { describeSchedule, planSchedule } from "./schedules";
import { renderRule } from "./review/rules";
import type { LearningRow, ParsedAnswer } from "./learning-types";

const DAY = 86400000;
const ACK_PREFIX = "learn-ack:";
const SCHED_ACK_PREFIX = "sched-ack:";
const SCHED_CANCEL_PREFIX = "sched-cancel:";
const UNDO_PREFIX = "learn-undo:";
const REPORT_PREFIX = "reflection-report:";
const DEDUP = /^[a-z][a-z0-9-]{2,30}:\d{4}-\d{2}-\d{2}$/;
const NO_WORDS = ["不用", "不要", "别记", "算了", "不对", "不行", "取消", "停", "别发"];
const YES_WORDS = ["好", "可以", "行", "要", "嗯", "对", "记住", "记下", "ok", "没问题", "同意", "👍"];
const CN_NUMBERS: Record<string, number> = { 一: 1, 二: 2, 三: 3 };

type ReplyTo = { kind?: string; targetId?: string; authorId?: string };
type LearningReply = { groupId: string; messageId: string; sender: string; text: string; mentioned?: boolean; replyTo?: ReplyTo };
type Applied = { ref: string; statements: any[]; schedule?: any };

/** A/B 快速放行用：NFKC 后去掉 @ 与表情。 */
function clean(text: string): string {
  return String(text || "")
    .normalize("NFKC")
    .replace(/<@!?[^>]+>/g, " ")
    .replace(/(^|[\s，,])@[^\s，,。:：]+/g, "$1")
    .replace(/[\p{Extended_Pictographic}\uFE0F\u200D]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![0-9])[1-3](?![0-9])/g)) {
    const n = Number(m[0]);
    if (!out.includes(n)) out.push(n);
  }
  for (const m of text.matchAll(/(?<=^|[\s,，、和])[一二三](?=$|[\s,，、和])/g)) {
    const n = CN_NUMBERS[m[0]];
    if (!out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

/** 纯函数：编号答句。NO 优先于 YES；多项无编号 → ambiguous。 */
export function parseAnswer(text: string, openNos: number[]): ParsedAnswer {
  const t = clean(text);
  const low = t.toLowerCase();
  const nos = numbersIn(t);
  const all = /都|全部/.test(t);
  if (!t || Array.from(t).length > 30) return { kind: "none", nos: [], all: false };
  const no = NO_WORDS.some((w) => low.includes(w));
  const yes = YES_WORDS.some((w) => low.includes(w));
  if (!no && !yes) {
    if (nos.length) return { kind: "ambiguous", nos, all: false };
    return { kind: "none", nos: [], all: false };
  }
  if (all) return { kind: no ? "no" : "yes", nos: [...openNos], all: true };
  if (nos.length) return { kind: no ? "no" : "yes", nos, all: false };
  if (openNos.length === 1) return { kind: no ? "no" : "yes", nos: [openNos[0]], all: false };
  if (openNos.length > 1) return { kind: "ambiguous", nos: [], all: false };
  return { kind: no ? "no" : "yes", nos: [], all: false };
}

const baseOf = (id: string) => String(id || "").split("~")[0];
const sameMember = (a: string | null | undefined, b: string) =>
  String(a || "") === b || String(a || "") === "qq:" + b || "qq:" + String(a || "") === b;

function numberedMention(text: string, mentioned: boolean): boolean {
  if (!mentioned) return false;
  const t = clean(text);
  return Array.from(t).length > 0 && Array.from(t).length <= 30 &&
    /^\s*[1-3一二三](?:[\s,，、和]+[1-3一二三])*\s*(?:可以|好|行|要|记|不用|不要|算了)/.test(t);
}

function targetOf(id: string): "report" | "ack" | "schedule" | null {
  if (id.startsWith(REPORT_PREFIX)) return "report";
  if (id.startsWith(ACK_PREFIX) || id.startsWith(SCHED_ACK_PREFIX)) return "ack";
  if (id.startsWith("sched-")) return "schedule";
  if (DEDUP.test(id)) return "schedule";
  return null;
}

async function setting(e: any, key: string): Promise<string | undefined> {
  return (await e.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first())?.value;
}

async function isAdmin(e: any, sender: string): Promise<boolean> {
  const row = await e.DB.prepare("SELECT role,revoked FROM members WHERE id IN (?,?)")
    .bind(sender, "qq:" + sender).first();
  return !row?.revoked && ["owner", "admin"].includes(String(row?.role || ""));
}

async function nameOf(e: any, member: string): Promise<string> {
  const row = await e.DB.prepare("SELECT name FROM member_names WHERE member_id IN (?,?)")
    .bind(member, "qq:" + member).first();
  return String(row?.name || "对方");
}

function ack(e: any, id: string, groupId: string, messageId: string, body: string, now: number) {
  return e.DB.prepare("INSERT OR IGNORE INTO outbox VALUES(?,?,?,?,'pending',?)")
    .bind(id, groupId, messageId, body, now);
}

function acksRow(e: any, outboxId: string, groupId: string, messageId: string, refs: unknown[], now: number) {
  return e.DB.prepare(
    "INSERT OR IGNORE INTO learning_acks(outbox_id,group_id,answer_msg_id,refs,created_at) VALUES(?,?,?,?,?)",
  ).bind(outboxId, groupId, messageId, JSON.stringify(refs), now);
}

function partsAt(ts: number) {
  const p: Record<string, number> = {};
  for (const x of new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(ts)))
    if (x.type !== "literal") p[x.type] = Number(x.value);
  return p;
}

function sydneyDay(ts: number): string {
  const p = partsAt(ts), pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function firstRunText(next: number, now: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = partsAt(next), today = partsAt(now);
  const key = (p: Record<string, number>) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  const tomorrow = new Date(Date.UTC(today.year, today.month - 1, today.day + 1)).toISOString().slice(0, 10);
  const hm = `${pad(at.hour)}:${pad(at.minute)}`;
  if (key(at) === key(today)) return `今天 ${hm} 第一次`;
  if (key(at) === tomorrow) return `明天 ${hm} 第一次`;
  return `${key(at)} ${hm} 第一次`;
}

async function stable(prefix: string, parts: unknown[]): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  return prefix + "-" + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 新规则模板；L3 的 renderRule 合入后优先用它，未合入时用同一契约的本地模板。 */
function learningRule(kind: string, params: Record<string, any>): string | null {
  if (kind === "avoid_phrase") {
    const phrase = String(params.phrase || "").trim();
    return Array.from(phrase).length >= 1 && Array.from(phrase).length <= 12 ? `不要再说「${phrase}」。` : null;
  }
  if (kind === "address_as") {
    const member = String(params.member || "").trim(), name = String(params.name || "").trim();
    return member && Array.from(name).length >= 1 && Array.from(name).length <= 10 ? `称呼${member}为「${name}」。` : null;
  }
  return null;
}

function parseParams(raw: string): Record<string, any> {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/**
 * 把一条已确认的 learning 变成同一 batch 里的写入语句（不自己执行，保证与回执同批）。
 * rule → behavior_rules(canary) + expressions 关闭；schedule → schedules(active, origin=review)。
 */
export async function applyLearning(e: any, row: LearningRow, answerer: string): Promise<Applied | null> {
  const now = Date.now(), params = parseParams(row.params);
  if (row.kind === "rule") {
    // 只能自己定自己的称呼：params.member 必须等于原话发送者，写入前再挡一次冒名。
    if (row.subkind === "address_as" && String(params.member || "") !== row.requester) return null;
    const rendered = renderRule(row.subkind as any, params, row.plain, 30) || learningRule(row.subkind, params);
    if (!rendered) return null;
    const id = await stable("rule", [row.group_id, "learning", row.id]);
    const statements = [
      e.DB.prepare(
        `INSERT OR IGNORE INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,approved_by,canary_until,expires_at,supersedes_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,'canary',?,?,?,NULL,?,?)`,
      ).bind(id, row.group_id, rendered, String(row.plain).slice(0, 80), row.subkind, JSON.stringify(params),
        JSON.stringify([{ source: "message", id: row.source_msg_id, quote: row.quote }]),
        "member:" + row.requester, "member:" + answerer, now + 3 * DAY, now + 30 * DAY, now, now),
      e.DB.prepare(
        "UPDATE behavior_rules SET rule=?,params=?,approved_by=?,canary_until=?,expires_at=?,updated_at=? WHERE id=? AND status='candidate'",
      ).bind(rendered, JSON.stringify(params), "member:" + answerer, now + 3 * DAY, now + 30 * DAY, now, id),
      e.DB.prepare(
        "UPDATE review_learnings SET status='applied',answered_by=?,applied_ref=?,updated_at=? WHERE id=?",
      ).bind(answerer, id, now, row.id),
    ];
    if (row.subkind === "avoid_phrase" && params.phrase)
      statements.push(e.DB.prepare("UPDATE expressions SET enabled=0 WHERE phrase=?").bind(String(params.phrase)));
    return { ref: id, statements };
  }
  if (row.kind === "schedule") {
    const cadence = row.subkind === "weekly" ? "weekly" : "daily";
    const spec: any = { time: params.time, origin: "review" };
    if (cadence === "weekly") spec.weekdays = params.weekdays;
    if (params.topic) spec.topic = String(params.topic);
    if (params.dedup) spec.dedup = String(params.dedup);
    let plan;
    try {
      plan = planSchedule({
        group_id: row.group_id, owner: row.requester,
        kind: cadence === "weekly" ? "digest_weekly" : "digest_daily",
        spec, source_msg_id: row.source_msg_id,
      }, now);
    } catch {
      return null;
    }
    return {
      ref: plan.id, schedule: plan,
      statements: [
        e.DB.prepare(
          "INSERT OR IGNORE INTO schedules(id,group_id,owner,kind,tz,spec,status,next_run_at,fail_count,created_at,source_msg_id) VALUES(?,?,?,?,?,?,'active',?,0,?,?)",
        ).bind(plan.id, plan.group_id, plan.owner, plan.kind, plan.tz, JSON.stringify(plan.spec), plan.next_run_at, plan.created_at, plan.source_msg_id),
        e.DB.prepare(
          "UPDATE schedules SET status='active',spec=?,tz=?,next_run_at=?,fail_count=0,last_error=NULL WHERE id=? AND status='cancelled'",
        ).bind(JSON.stringify(plan.spec), plan.tz, plan.next_run_at, plan.id),
        e.DB.prepare(
          "UPDATE review_learnings SET status='applied',answered_by=?,applied_ref=?,updated_at=? WHERE id=?",
        ).bind(answerer, plan.id, now, row.id),
      ],
    };
  }
  return null;
}

function retire(e: any, type: string, id: string, groupId: string, now: number) {
  if (type === "rule")
    return e.DB.prepare(
      "UPDATE behavior_rules SET status='retired',rollback_reason='member_undo',updated_at=? WHERE id=? AND group_id=? AND status IN ('candidate','canary','active')",
    ).bind(now, id, groupId);
  if (type === "schedule")
    return e.DB.prepare(
      "UPDATE schedules SET status='cancelled',next_run_at=NULL WHERE id=? AND group_id=? AND status='active'",
    ).bind(id, groupId);
  return e.DB.prepare("UPDATE review_learnings SET status='declined',updated_at=? WHERE id=? AND group_id=?").bind(now, id, groupId);
}

async function loadLearnings(e: any, groupId: string, ids: string[]): Promise<Map<string, LearningRow>> {
  if (!ids.length) return new Map();
  const rows = (await e.DB.prepare(
    "SELECT * FROM review_learnings WHERE group_id=? AND id IN (" + ids.map(() => "?").join(",") + ")",
  ).bind(groupId, ...ids).all()).results as LearningRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** 晨报（含 @bot 的编号答复）分派。 */
async function handleReport(e: any, input: LearningReply, explicitId: string | null, now: number): Promise<boolean> {
  const report = explicitId
    ? await e.DB.prepare("SELECT * FROM review_reports WHERE id=? AND group_id=?").bind(explicitId, input.groupId).first()
    : await e.DB.prepare(
      "SELECT * FROM review_reports WHERE group_id=? AND date>=? ORDER BY date DESC,created_at DESC LIMIT 1",
    ).bind(input.groupId, sydneyDay(now - DAY)).first();
  if (!report) return false;
  let items: { no: number; learning_id: string }[] = [];
  try { items = JSON.parse(report.items || "[]"); } catch { return false; }
  if (!Array.isArray(items) || !items.length) return false;
  const learnings = await loadLearnings(e, input.groupId, items.map((i) => i.learning_id));
  const open = items.filter((i) => {
    const row = learnings.get(i.learning_id);
    return row && ["proposed", "asked", "confirmed", "applied"].includes(row.status);
  });
  const openNos = open.map((i) => i.no);
  if (!openNos.length) return false;
  const answer = parseAnswer(input.text, openNos);
  if (answer.kind === "none") return false;
  const ambiguous = answer.kind === "ambiguous" ||
    (answer.nos.length > 0 && !answer.nos.some((n) => openNos.includes(n)));
  if (ambiguous) {
    await e.DB.batch([ack(e, ACK_PREFIX + input.messageId, input.groupId, input.messageId,
      "要记哪几条？回数字就行，比如「1 可以」。", now)]);
    return true;
  }
  const selected = open.filter((i) => answer.all || answer.nos.includes(i.no));
  if (!selected.length) return false;
  const admin = await isAdmin(e, input.sender);
  const statements: any[] = [];
  const appliedPlains: string[] = [], undonePlains: string[] = [], unauthorized: string[] = [];
  let disputed = false, declined = false, undo = false;
  const refs: { type: string; id: string }[] = [];
  for (const item of selected) {
    const row = learnings.get(item.learning_id)!;
    const allowed = admin || sameMember(row.requester, input.sender);
    if (!allowed) {
      unauthorized.push(await nameOf(e, row.requester));
      continue;
    }
    if (answer.kind === "yes") {
      if (row.status === "applied") { appliedPlains.push(row.plain); continue; }
      const result = await applyLearning(e, row, input.sender);
      if (!result) { continue; }
      statements.push(...result.statements);
      statements.push(e.DB.prepare("UPDATE review_learnings SET answer_msg_id=? WHERE id=?").bind(input.messageId, row.id));
      refs.push({ type: row.kind, id: result.ref }, { type: "learning", id: row.id });
      const first = result.schedule ? "，" + firstRunText(result.schedule.next_run_at, now) : "";
      appliedPlains.push(row.plain + first);
    } else if (row.status === "applied" && row.applied_ref) {
      statements.push(retire(e, row.kind, row.applied_ref, input.groupId, now));
      statements.push(retire(e, "learning", row.id, input.groupId, now));
      undonePlains.push(row.plain);
      undo = true;
    } else {
      statements.push(e.DB.prepare(
        "UPDATE review_learnings SET status='declined',answered_by=?,answer_msg_id=?,updated_at=? WHERE id=?",
      ).bind(input.sender, input.messageId, now, row.id));
      declined = true;
    }
  }
  // 他人反对不自动批；但本人/管理员的拒绝优先记为 declined。
  if (answer.kind === "no" && !undo) {
    for (const item of selected) {
      const row = learnings.get(item.learning_id)!;
      if (admin || sameMember(row.requester, input.sender)) continue;
      statements.push(e.DB.prepare(
        "UPDATE review_learnings SET status='disputed',note=?,updated_at=? WHERE id=? AND status IN ('proposed','asked','confirmed')",
      ).bind("member objection", now, row.id));
      disputed = true;
    }
  }
  let id = ACK_PREFIX + input.messageId, body = "";
  if (undo) {
    id = UNDO_PREFIX + input.messageId;
    body = `好，撤回了：${undonePlains.join("、")}。`;
  } else if (appliedPlains.length) {
    body = `好，记下了：${appliedPlains.join("、")}。不对就回这条说「不对」。`;
    if (unauthorized.length) body += `另外，${unauthorized[0]}那几条要本人说一声才算。`;
  } else if (disputed) {
    body = "好，有人觉得不合适，这条先不记，等大家再看看。";
  } else if (declined) {
    body = "好，这条先不记。";
  } else if (unauthorized.length) {
    body = `这条要${unauthorized[0]}本人说一声才算。`;
  } else {
    return false;
  }
  statements.push(ack(e, id, input.groupId, input.messageId, body, now));
  if (refs.length) statements.push(acksRow(e, id, input.groupId, input.messageId, refs, now));
  await e.DB.batch(statements);
  return true;
}

/** 推送的「不用发了」：按 schedule_runs.outbox_id 反查日程，owner/管理员才能取消。 */
async function handleScheduleCancel(e: any, input: LearningReply, target: string, now: number): Promise<boolean> {
  const answer = parseAnswer(input.text, [1]);
  if (answer.kind !== "no") return false;
  const run = await e.DB.prepare("SELECT schedule_id FROM schedule_runs WHERE outbox_id=? ORDER BY due_at DESC LIMIT 1")
    .bind(target).first();
  const schedule = run
    ? await e.DB.prepare("SELECT * FROM schedules WHERE id=? AND group_id=?").bind(run.schedule_id, input.groupId).first()
    : await e.DB.prepare("SELECT * FROM schedules WHERE id=? AND group_id=?").bind(target, input.groupId).first();
  if (!schedule) return false;
  const admin = await isAdmin(e, input.sender);
  if (!admin && !sameMember(schedule.owner, input.sender)) {
    await e.DB.batch([ack(e, SCHED_CANCEL_PREFIX + input.messageId, input.groupId, input.messageId,
      "这个日程只有建立它的人或管理员才能取消。", now)]);
    return true;
  }
  await e.DB.batch([
    e.DB.prepare("UPDATE schedules SET status='cancelled',next_run_at=NULL WHERE id=? AND group_id=? AND status='active'")
      .bind(schedule.id, input.groupId),
    ack(e, SCHED_CANCEL_PREFIX + input.messageId, input.groupId, input.messageId,
      `好，${describeSchedule(schedule)}停了。想恢复再跟我说。`, now),
  ]);
  return true;
}

/** 回执上的「不对」：24 小时内按 learning_acks.refs 撤销。 */
async function handleAckUndo(e: any, input: LearningReply, target: string, now: number): Promise<boolean> {
  const answer = parseAnswer(input.text, [1]);
  if (answer.kind !== "no") return false;
  const saved = await e.DB.prepare("SELECT * FROM learning_acks WHERE outbox_id=?").bind(target).first();
  if (!saved || saved.group_id !== input.groupId) return false;
  if (Number(saved.created_at) + DAY < now) return false;
  let refs: { type: string; id: string }[] = [];
  try { refs = JSON.parse(saved.refs || "[]"); } catch { return false; }
  const learningIds = refs.filter((r) => r.type === "learning").map((r) => r.id);
  const learnings = await loadLearnings(e, input.groupId, learningIds);
  const owners = [...learnings.values()].map((r) => r.requester);
  const admin = await isAdmin(e, input.sender);
  if (!admin && !owners.length && refs.length) {
    const first = refs[0];
    if (first.type === "schedule") {
      const s = await e.DB.prepare("SELECT owner FROM schedules WHERE id=? AND group_id=?").bind(first.id, input.groupId).first();
      if (s?.owner) owners.push(String(s.owner));
    }
  }
  if (!admin && !owners.some((o) => sameMember(o, input.sender))) {
    const who = owners[0] ? await nameOf(e, owners[0]) : "对方";
    await e.DB.batch([ack(e, UNDO_PREFIX + input.messageId, input.groupId, input.messageId,
      `这条要${who}本人说一声才算。`, now)]);
    return true;
  }
  const plains = [...learnings.values()].map((r) => r.plain);
  if (saved.undone_at) {
    await e.DB.batch([ack(e, UNDO_PREFIX + input.messageId, input.groupId, input.messageId,
      `好，撤回了：${plains.join("、") || "这条安排"}。`, now)]);
    return true;
  }
  const statements: any[] = [];
  for (const ref of refs) {
    if (ref.type === "rule" || ref.type === "schedule" || ref.type === "learning")
      statements.push(retire(e, ref.type, ref.id, input.groupId, now));
  }
  statements.push(e.DB.prepare("UPDATE learning_acks SET undone_at=? WHERE outbox_id=?").bind(now, target));
  statements.push(ack(e, UNDO_PREFIX + input.messageId, input.groupId, input.messageId,
    `好，撤回了：${plains.join("、") || "这条安排"}。`, now));
  await e.DB.batch(statements);
  return true;
}

export async function handleLearningReply(e: any, input: LearningReply): Promise<boolean> {
  const targetId = baseOf(input.replyTo?.targetId || "");
  const target = input.replyTo?.kind === "bot" && targetId ? targetOf(targetId) : null;
  const byMention = !target && numberedMention(input.text, input.mentioned === true);
  // 快速放行：不是回复 bot 的已知出站、也不是带编号的 @ 答复 → 0 次 D1。
  if (!target && !byMention) return false;
  try {
    const mode = await setting(e, "learn:mode");
    const pushCancel = target === "schedule";
    if (mode === "off" && !pushCancel) return false;
    const now = Date.now();
    if (target === "schedule") return await handleScheduleCancel(e, input, targetId, now);
    if (target === "ack") return await handleAckUndo(e, input, targetId, now);
    return await handleReport(e, input, target === "report" ? targetId : null, now);
  } catch {
    return false;
  }
}
