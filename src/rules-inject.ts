// V-D-learning · L7：行为规则注入与口头禅清理的归因。
// 读取复用 review/rules.ts 的 activeRulesFor，不复制 SQL；这里只排队，不直接写 D1。
import { activeRulesFor, type BehaviorRule } from "./review/rules";

export const RULES_TITLE = "群里大家提过的要求（照做）：";
const MAX_ADDRESS = 3;
const MAX_OTHER = 5;
const MAX_RULE = 80;
const MAX_TEXT = 400;

export type RulesBlock = { text: string; avoid: string[] };

/** 计数/跳过写入走 e.tail（发送后由 flushTail 落库），不占回复路径预算。 */
export type RuleActivity = {
  id: string;
  kind: string;
  entity: string;
  actor: string;
  summary: string;
  created_at: string;
};

/**
 * 规则读取的预算门槛。普通回复的尾部（模型→finalize→一次发送→尾巴）约 30 句；
 * 随消息图片的引用/笔记每张再留 2 句，引用回复的发送重试再留 2 句。
 * 四个 48 句预算夹具（B3/B4/P0a/W-9）是「3 图 + 引用」，读取点剩 37 句 < 38 → 跳过；
 * 普通文本回合剩 36–37 句 ≥ 30，照常读规则。
 */
export const RULE_MIN_LEFT = 30;
export function ruleReserve(images: number, quoted: boolean): number {
  return RULE_MIN_LEFT + 2 * Math.max(0, Number(images) || 0) + (quoted ? 2 : 0);
}
export function rulesBudgetAllows(left: number, images: number, quoted: boolean): boolean {
  return left >= ruleReserve(images, quoted);
}

function paramsOf(row: { params?: string }): Record<string, any> {
  try {
    const value = JSON.parse(String(row.params || "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const clip = (value: any, size: number) => Array.from(String(value ?? "")).slice(0, size).join("");
/** 「qq:123」与「123」是同一个群友（与 review/rules.ts 的判定一致）。 */
const member = (value: any) => String(value ?? "").trim().toLowerCase().replace(/^qq:/, "");

/** 1 次 D1：本群 canary/active 且未过期，最近更新的在前。规则注入是增强项：读失败返回空块，绝不让回复失败。 */
export async function loadGroupRules(e: any, groupId: string, now = Date.now()): Promise<BehaviorRule[]> {
  if (!groupId) return [];
  try {
    return await activeRulesFor(e, groupId, now, 12);
  } catch {
    return [];
  }
}

/**
 * 纯函数：address_as 只认本批发言人（≤3 条），其余 ≤5 条；每条 ≤80 字、整块 ≤400 字。
 * avoid 取所有 avoid_phrase，即使它的正文行被条数上限挤掉，出站仍要清理。
 */
export function rulesBlock(rows: BehaviorRule[], senders: string[]): RulesBlock {
  const who = new Set((senders || []).map(member).filter(Boolean));
  const address: string[] = [], others: string[] = [], avoid: string[] = [];
  for (const row of rows || []) {
    const params = paramsOf(row);
    if (row.kind === "address_as") {
      if (address.length >= MAX_ADDRESS || !who.has(member(params.member))) continue;
      const line = clip(row.rule, MAX_RULE).trim();
      if (line) address.push(line);
      continue;
    }
    if (row.kind === "avoid_phrase") {
      const phrase = String(params.phrase ?? "").trim();
      if (phrase && !avoid.includes(phrase)) avoid.push(phrase);
    }
    if (others.length >= MAX_OTHER) continue;
    const line = clip(row.rule, MAX_RULE).trim();
    if (line) others.push(line);
  }
  let body = "";
  for (const line of [...address, ...others]) {
    const next = body ? body + "\n" + line : line;
    if (Array.from(RULES_TITLE + "\n" + next).length > MAX_TEXT) break;
    body = next;
  }
  return { text: body ? RULES_TITLE + "\n" + body : "", avoid };
}

/** violation 归因：被删的口头禅 → behavior_rules.id（同词多规则取最新一条）。 */
export function ruleIdForPhrase(rows: BehaviorRule[] | undefined, phrase: string): string | undefined {
  const wanted = String(phrase ?? "").trim();
  for (const row of rows || []) {
    if (row.kind !== "avoid_phrase") continue;
    if (String(paramsOf(row).phrase ?? "").trim() === wanted) return row.id;
  }
  return undefined;
}

function queueActivity(e: any, row: RuleActivity): boolean {
  if (!e?.tail) return false;
  const tail = e.tail as { ruleActivities?: RuleActivity[] };
  (tail.ruleActivities ??= []).push(row);
  return true;
}

/** 排队到 e.tail；flushTail 在发送后统一写 activity，失败只丢指标，不影响回复。 */
export function queueRuleViolation(
  e: any,
  ruleId: string,
  messageId: string | undefined,
  count: number,
  now = Date.now(),
): boolean {
  if (!ruleId || count <= 0) return false;
  return queueActivity(e, {
    id: "rule-violation:" + ruleId + ":" + (messageId || now),
    kind: "rule.violation",
    entity: ruleId,
    actor: "Bot",
    summary: "口头禅清理命中 " + count + " 次",
    created_at: new Date(now).toISOString(),
  });
}

/** 预算不足跳过规则读取时的观察点；activity 只能尽力写，写不下就靠调用方的日志。 */
export function queueRuleSkip(
  e: any,
  groupId: string | undefined,
  messageId: string | undefined,
  left: number,
  reserve: number,
  now = Date.now(),
): boolean {
  const group = groupId || "unknown";
  return queueActivity(e, {
    id: "rules.skipped_budget:" + group + ":" + (messageId || now),
    kind: "rules.skipped_budget",
    entity: group,
    actor: "Bot",
    summary: "剩余 D1 " + left + " 句，低于本轮预留 " + reserve + " 句，跳过规则块",
    created_at: new Date(now).toISOString(),
  });
}
