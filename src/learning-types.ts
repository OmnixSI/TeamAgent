// V-D-learning · 复盘学习面（L0 冻结）。review Worker 与主 Worker 都 import 这个文件：
// 枚举、状态、类型、learningId、reportOutboxId、REPORT_DENY 只在这里定义，别的包不改。
export const LEARNING_KINDS = ["rule", "schedule"] as const;
export const LEARNING_STATUS = ["proposed", "asked", "confirmed", "applied", "declined",
  "disputed", "expired", "covered", "needs_human", "failed"] as const;
// proposed=刚归纳 asked=已在晨报问 confirmed=本人/管理员同意(写入前瞬态) applied=已写入
// declined=本人说不要 disputed=别人反对→needs_human covered=已有同等日程/规则 expired=问两次没人理
export const NEW_RULE_KINDS = ["avoid_phrase", "address_as"] as const;   // L3 追加进 review/types.ts RULE_KINDS

export const REPORT_DENY = ["trace", "judge", "finding", "p0", "p1", "p2", "deepseek", "openai",
  "模型", "判官", "影子", "shadow", "canary", "规则候选", "d1", "cron", "worker", "token", "阈值", "置信",
  "证据id", "json"]; // 晨报正文不得出现（小写比较）

export type LearningKind = (typeof LEARNING_KINDS)[number];
export type LearningStatus = (typeof LEARNING_STATUS)[number];
export type NewRuleKind = (typeof NEW_RULE_KINDS)[number];

export type LearningRow = { id: string; group_id: string; kind: LearningKind; subkind: string; params: string;
  plain: string; requester: string; source_msg_id: string; quote: string; run_id: string; agreement: string;
  status: string; ask_count: number; answered_by: string | null; answer_msg_id: string | null; applied_ref: string | null;
  note: string | null; created_at: number; updated_at: number };

export type ScheduleRequest = { evidence: { source: "message"; id: string; quote: string }[];
  cadence: "daily" | "weekly"; time: string /* HH:MM 悉尼 */; weekdays?: number[]; topic: string /* ≤40 */ };

export type ParsedAnswer = { kind: "yes" | "no" | "ambiguous" | "none"; nos: number[] /* 空=未指明 */; all: boolean };

/** 'ln-' + sha256(JSON.stringify([group,kind,subkind,normKey])) 的前 12 位十六进制。
 *  normKey 由调用方归一化（去空白/统一大小写）；同一要求跨晚必须得到同一 id。
 *  与 src/review/rules.ts 的 stableId 同一写法，便于两端对照。 */
export async function learningId(group: string, kind: string, subkind: string, normKey: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(JSON.stringify([group, kind, subkind, normKey])));
  return "ln-" + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

/** 晨报 outbox id：当天只有一群要发时全群共用一个 id；多群时加群 id 前 8 位防跨群撞车。 */
export function reportOutboxId(date: string, groupId: string, groupsThatDay: number): string {
  const base = "reflection-report:" + date;
  return groupsThatDay <= 1 ? base : base + ":" + groupId.slice(0, 8);
}
