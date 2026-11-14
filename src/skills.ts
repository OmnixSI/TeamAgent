// D5 skills: a skill is a named, read-only recipe (Step[] + note), never code or a URL.
// Storage and limits follow design §5.1/§5.7; execution goes through the single action
// layer in ./actions (§5.4), so a skill can never grow a second execution path.
import * as actions from "./actions";
import type { Actor, Step } from "./actions";

export const SKILL_LIMITS = {
  name: 12,
  triggers: 5,
  trigger: 12,
  steps: 6,
  note: 600,
  perGroup: 20,
  promptSkills: 30,
  promptChars: 400,
} as const;

export type SkillStatus = "proposed" | "active" | "disabled";
export type SkillErrorKind =
  | "invalid"
  | "unsupported"
  | "denied"
  | "quota"
  | "not_found"
  | "ambiguous"
  | "unavailable";

export class SkillError extends Error {
  kind: SkillErrorKind;
  unsupported: string[];
  candidates: { id: string; name: string }[];

  constructor(
    kind: SkillErrorKind,
    message: string,
    unsupported: string[] = [],
    candidates: { id: string; name: string }[] = [],
  ) {
    super(message);
    this.name = "SkillError";
    this.kind = kind;
    this.unsupported = unsupported;
    this.candidates = candidates;
  }
}

export interface SkillRow {
  id: string;
  group_id: string;
  name: string;
  triggers: string[];
  steps: Step[];
  note: string;
  owner: string;
  status: SkillStatus;
  uses: number;
  last_used_at: number | null;
  source_msg_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SkillCtx {
  e: any;
  groupId: string;
  actor: Actor;
  now?: number;
  sourceMsgId?: string;
}

export interface SkillSaveInput {
  name: unknown;
  triggers?: unknown;
  steps: unknown;
  note?: unknown;
}

// ---------- small helpers ----------
function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
function chars(value: string): number {
  return Array.from(value).length;
}
function clip(value: string, limit: number): string {
  const all = Array.from(value);
  return all.length > limit ? all.slice(0, limit).join("") : value;
}
function randomId(prefix: string): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return prefix + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function parseJson<T>(value: unknown, fallback: T): T {
  try {
    return JSON.parse(String(value ?? "")) as T;
  } catch {
    return fallback;
  }
}
async function rows(e: any, sql: string, ...args: unknown[]): Promise<any[]> {
  return (await e.DB.prepare(sql).bind(...args).all()).results ?? [];
}
async function first(e: any, sql: string, ...args: unknown[]): Promise<any> {
  return (await e.DB.prepare(sql).bind(...args).first()) ?? null;
}

function fromRow(raw: any): SkillRow {
  const status = raw?.status === "disabled" || raw?.status === "proposed" ? raw.status : "active";
  return {
    id: String(raw?.id ?? ""),
    group_id: String(raw?.group_id ?? ""),
    name: String(raw?.name ?? ""),
    triggers: parseJson<string[]>(raw?.triggers, []).filter((item) => typeof item === "string"),
    steps: parseJson<Step[]>(raw?.steps, []),
    note: String(raw?.note ?? ""),
    owner: String(raw?.owner ?? ""),
    status,
    uses: Number(raw?.uses ?? 0) || 0,
    last_used_at: raw?.last_used_at == null ? null : Number(raw.last_used_at),
    source_msg_id: raw?.source_msg_id == null ? null : String(raw.source_msg_id),
    created_at: Number(raw?.created_at ?? 0) || 0,
    updated_at: Number(raw?.updated_at ?? 0) || 0,
  };
}

// ---------- validation ----------
export function normalizeSkillName(raw: unknown): string {
  const name = text(raw).replace(/^[「『"']+|[」』"']+$/g, "").trim();
  if (!name) throw new SkillError("invalid", "技能要有个名字（不超过 12 个字）");
  if (chars(name) > SKILL_LIMITS.name)
    throw new SkillError("invalid", `技能名最多 ${SKILL_LIMITS.name} 个字`);
  if (/[\u0000-\u001f\u007f]/.test(name))
    throw new SkillError("invalid", "技能名里不能有控制字符");
  return name;
}

export function normalizeSkillTriggers(raw: unknown): string[] {
  if (raw == null || raw === "") return [];
  if (!Array.isArray(raw)) throw new SkillError("invalid", "触发词要是一个字符串数组");
  if (raw.length > SKILL_LIMITS.triggers)
    throw new SkillError("invalid", `触发词最多 ${SKILL_LIMITS.triggers} 个`);
  const out: string[] = [];
  for (const item of raw) {
    const trigger = text(item);
    if (!trigger) throw new SkillError("invalid", "触发词不能为空");
    if (chars(trigger) > SKILL_LIMITS.trigger)
      throw new SkillError("invalid", `触发词「${clip(trigger, SKILL_LIMITS.trigger)}…」超过 ${SKILL_LIMITS.trigger} 个字`);
    if (!out.includes(trigger)) out.push(trigger);
  }
  return out;
}

function normalizeNote(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw !== "string") throw new SkillError("invalid", "note 要是一段文字");
  return clip(raw.trim(), SKILL_LIMITS.note);
}

function unsupportedActions(steps: unknown): string[] {
  if (!Array.isArray(steps)) return [];
  const out: string[] = [];
  for (const step of steps) {
    const action =
      step && typeof step === "object" && typeof (step as any).action === "string"
        ? String((step as any).action)
        : "";
    if (action && !actions.READ_ONLY_ACTIONS?.has(action) && !out.includes(action)) out.push(action);
  }
  return out;
}

/** Store only a read-only recipe. Code/URL-like text is rejected; unknown or write actions
 *  come back as `unsupported` with the action names so the model can file a feature request. */
export function normalizeSkillSteps(raw: unknown): Step[] {
  if (Array.isArray(raw)) {
    for (const step of raw) {
      if (!step || typeof step !== "object") continue;
      const candidate = step as any;
      if (candidate.action === "text" && typeof candidate.text === "string" && /https?:\/\/|www\./i.test(candidate.text))
        throw new SkillError("invalid", "技能只存只读配方，不存网址");
    }
  }
  const checked = actions.validateSteps(raw);
  if (!checked.ok) throw new SkillError("unsupported", checked.reason, unsupportedActions(raw));
  return checked.steps;
}

export function stepSummary(steps: Step[]): string {
  const parts = steps.map((step) => {
    switch (step.action) {
      case "records_summary":
        return `查「${step.type}」汇总`;
      case "records_query":
        return `查「${step.type}」记录`;
      case "quota":
        return "查余额";
      case "token_usage":
        return "报 token 用量";
      case "chat_digest":
        return "发聊天摘要";
      case "work_status":
        return "报工作状态";
      case "text":
        return `说「${clip(step.text, 24)}」`;
      default:
        return "做一步";
    }
  });
  return parts.join("、") || "做一步";
}

// ---------- storage ----------
export async function listSkills(e: any, groupId: string, includeDisabled = true): Promise<SkillRow[]> {
  const all = (await rows(
    e,
    "SELECT * FROM skills WHERE group_id=? ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, uses DESC, created_at ASC",
    groupId,
  )).map(fromRow);
  return includeDisabled ? all : all.filter((skill) => skill.status === "active");
}

export async function saveSkill(
  ctx: SkillCtx,
  input: SkillSaveInput,
): Promise<{ skill: SkillRow; created: boolean }> {
  const name = normalizeSkillName(input.name);
  const triggers = normalizeSkillTriggers(input.triggers);
  const note = normalizeNote(input.note);
  const steps = normalizeSkillSteps(input.steps);
  const now = ctx.now ?? Date.now();
  const existingRaw = await first(ctx.e, "SELECT * FROM skills WHERE group_id=? AND name=?", ctx.groupId, name);
  const existing = existingRaw ? fromRow(existingRaw) : null;

  if (existing) {
    if (existing.owner !== ctx.actor.sender && !ctx.actor.isAdmin)
      throw new SkillError("denied", `「${name}」是别人建的，只有建它的人或管理员能覆盖`);
    await ctx.e.DB.prepare(
      "UPDATE skills SET triggers=?,steps=?,note=?,status='active',source_msg_id=?,updated_at=? WHERE id=? AND group_id=?",
    )
      .bind(
        JSON.stringify(triggers),
        JSON.stringify(steps),
        note,
        ctx.sourceMsgId ?? existing.source_msg_id,
        now,
        existing.id,
        ctx.groupId,
      )
      .run();
    const updated = await first(ctx.e, "SELECT * FROM skills WHERE id=?", existing.id);
    return { skill: fromRow(updated), created: false };
  }

  const total = Number((await first(ctx.e, "SELECT COUNT(*) n FROM skills WHERE group_id=?", ctx.groupId))?.n ?? 0);
  if (total >= SKILL_LIMITS.perGroup)
    throw new SkillError("quota", `本群技能到 ${SKILL_LIMITS.perGroup} 个上限了，先停用或覆盖一个旧的`);
  const id = randomId("sk-");
  await ctx.e.DB.prepare(
    "INSERT INTO skills(id,group_id,name,triggers,steps,note,owner,status,uses,last_used_at,source_msg_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'active',0,NULL,?,?,?)",
  )
    .bind(
      id,
      ctx.groupId,
      name,
      JSON.stringify(triggers),
      JSON.stringify(steps),
      note,
      ctx.actor.sender,
      ctx.sourceMsgId ?? null,
      now,
      now,
    )
    .run();
  const created = await first(ctx.e, "SELECT * FROM skills WHERE id=?", id);
  return { skill: fromRow(created), created: true };
}

export async function disableSkill(ctx: SkillCtx, nameRaw: unknown): Promise<SkillRow> {
  const name = normalizeSkillName(nameRaw);
  const found = (await listSkills(ctx.e, ctx.groupId, true)).find((skill) => skill.name === name);
  if (!found) throw new SkillError("not_found", `没找到叫「${name}」的技能`);
  if (found.owner !== ctx.actor.sender && !ctx.actor.isAdmin)
    throw new SkillError("denied", `「${name}」是别人建的，只有建它的人或管理员能停用`);
  const now = ctx.now ?? Date.now();
  await ctx.e.DB.prepare("UPDATE skills SET status='disabled',updated_at=? WHERE id=? AND group_id=?")
    .bind(now, found.id, ctx.groupId)
    .run();
  return { ...found, status: "disabled", updated_at: now };
}

// ---------- lookup / run ----------
export interface SkillLookup {
  skill?: SkillRow;
  matches: SkillRow[];
  all: SkillRow[];
}

export async function findSkill(e: any, groupId: string, nameRaw: unknown): Promise<SkillLookup> {
  const wanted = text(nameRaw).replace(/^[「『"']+|[」』"']+$/g, "").trim();
  const all = await listSkills(e, groupId, true);
  const active = all.filter((skill) => skill.status === "active");
  const byName = active.filter((skill) => skill.name === wanted);
  if (byName.length === 1) return { skill: byName[0], matches: byName, all };
  const hits = active.filter((skill) => skill.name === wanted || skill.triggers.includes(wanted));
  return { skill: hits.length === 1 ? hits[0] : undefined, matches: hits, all };
}

export interface SkillRunArgs {
  type?: string;
  period?: string;
}

function applyArgs(steps: Step[], args?: SkillRunArgs): Step[] {
  const copy = JSON.parse(JSON.stringify(steps)) as any[];
  if (!args) return copy as Step[];
  const type = text(args.type);
  const period = text(args.period);
  for (const step of copy) {
    if (!step || typeof step !== "object") continue;
    if (type && (step.action === "records_summary" || step.action === "records_query")) step.type = type;
    if (period && step.action === "records_summary" && ["all", "today", "yesterday", "this_month", "last_month"].includes(period))
      step.period = period;
    if (period && step.action === "token_usage" && ["today", "yesterday"].includes(period)) step.period = period;
  }
  return copy as Step[];
}

/** Run one active skill by exact name or trigger. Missing names are reported with the
 *  group's available skills so the model can ask instead of guessing. */
export async function runSkill(
  ctx: SkillCtx & { tz: string },
  nameRaw: unknown,
  args?: SkillRunArgs,
): Promise<{ ok: true; text: string }> {
  const wanted = text(nameRaw);
  if (!wanted) throw new SkillError("invalid", "要跑哪个技能？说名字或触发词");
  const { skill, matches, all } = await findSkill(ctx.e, ctx.groupId, wanted);
  if (!skill) {
    if (matches.length > 1) {
      const names = matches.map((item) => item.name);
      throw new SkillError("ambiguous", `「${wanted}」对上多个技能：${names.join("、")}，说名字更准一点`, [], matches.map((item) => ({ id: item.id, name: item.name })));
    }
    const available = all.filter((item) => item.status === "active").map((item) => item.name);
    throw new SkillError(
      "not_found",
      available.length
        ? `没有叫「${wanted}」的技能。本群可用：${available.join("、")}`
        : `没有叫「${wanted}」的技能，本群还没有技能`,
    );
  }
  const now = ctx.now ?? Date.now();
  let results;
  try {
    results = await actions.runSteps(
      {
        e: ctx.e,
        groupId: ctx.groupId,
        viewer: ctx.actor,
        tz: ctx.tz,
        now,
        purpose: "skill",
      },
      applyArgs(skill.steps, args),
    );
  } catch (error) {
    throw new SkillError("unavailable", `动作层暂时没跑起来：${error instanceof Error ? error.message : String(error)}`);
  }
  await ctx.e.DB.prepare("UPDATE skills SET uses=uses+1,last_used_at=?,updated_at=? WHERE id=? AND group_id=?")
    .bind(now, now, skill.id, ctx.groupId)
    .run();
  return { ok: true, text: actions.joinResults(results, skill.name) };
}

// ---------- prompt / listing text ----------
/** One line for the model's system prompt: 本群技能：日结(日结|收工)、… (≤30 skills, ≤400 chars). */
export async function skillPromptLine(e: any, groupId: string): Promise<string> {
  try {
    const all = await rows(
      e,
      "SELECT name,triggers FROM skills WHERE group_id=? AND status='active' ORDER BY uses DESC, created_at ASC",
      groupId,
    );
    const items: string[] = [];
    for (const row of all) {
      const name = String(row?.name ?? "");
      if (!name) continue;
      const triggers = parseJson<string[]>(row?.triggers, []).filter((item) => item && item !== name);
      items.push(`${name}(${[name, ...triggers].join("|")})`);
      if (items.length >= SKILL_LIMITS.promptSkills) break;
    }
    if (!items.length) return "";
    let line = "本群技能：" + items.join("、");
    while (chars(line) > SKILL_LIMITS.promptChars && items.length > 1) {
      items.pop();
      line = "本群技能：" + items.join("、");
    }
    return chars(line) > SKILL_LIMITS.promptChars ? clip(line, SKILL_LIMITS.promptChars) : line;
  } catch {
    return "";
  }
}

export function skillListText(skills: SkillRow[]): string {
  if (!skills.length) return "本群还没有技能。";
  return skills
    .map((skill) => {
      const triggers = [skill.name, ...skill.triggers.filter((item) => item !== skill.name)];
      return `${skill.name}（${triggers.join("|")}）— ${skill.status}，用 ${skill.uses} 次`;
    })
    .join("\n");
}
