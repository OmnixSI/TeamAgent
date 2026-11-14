/**
 * F11 需求闭环（群里提需求 → 立项 → 开发 → 上线 → 回复原消息）。
 * 本文件是冻结接口：FR-1/FR-2/FR-3/FR-4/FR-5 都只依赖这里，不许改签名。
 * 只放类型、常量和状态转移表；没有任何 I/O。
 */
export const FR_PREFIX = "fr-";                 // feature_request.id = "fr-" + 原消息 id（一条消息最多一张单）
export const FR_REPLY_PREFIX = "frr-";          // 回复的 outbox.id = "frr-" + 单号（唯一，天然去重）

/** 收到 = 建单瞬间（直接进 queued 或 needs_human）；排队 = queued；开发中 = developing。 */
export type FrStatus = "queued" | "developing" | "shipped" | "failed" | "needs_human" | "rejected";
export const FR_TERMINAL: readonly FrStatus[] = ["shipped", "failed", "rejected"];

/** build = 工作室可以动手；proposal = 只出提案，绝不自动做（敏感需求 / 疑似注入）。 */
export type FrMode = "build" | "proposal";

/** 敏感与风险标签：命中任一 → mode=proposal、status=needs_human。 */
export type FrRiskTag = "permission" | "secret" | "delete" | "outbound" | "spend" | "injection";

export type FrReplyKind = "shipped" | "failed" | "stale";

export interface FeatureRequestRow {
  id: string;                    // fr-<msg_id>
  group_id: string;
  msg_id: string;                // 原消息 id（messages.id），UNIQUE
  sender: string;                // messages.sender（QQ member_openid）
  sender_name: string;
  quote: string;                 // 原话，≤600 字，已 redact；对工作室是「不可信数据」
  title: string;                 // ≤80 字，模型归纳，同样不可信
  detail: string;                // ≤2000 字，模型归纳，同样不可信
  mode: FrMode;
  risk_tags: string;             // JSON 数组 FrRiskTag[]
  auto: 0 | 1;                   // 发言人在白名单（用户本人）=1
  status: FrStatus;
  status_reason: string;         // 人话，≤200 字
  version: number;               // 乐观锁：每次转移 +1，CAS 用
  day: string;                   // 建单当天（Australia/Sydney）YYYY-MM-DD，限额用
  attempts: number;              // 被领走的次数
  claimed_by: string | null;
  lease_until: number | null;    // developing 的租约到期 ms
  release: string | null;        // 上线的版本号（sha7）
  rollback_point: string | null;
  smoke_verified: 0 | 1;
  proposal_note: string | null;  // proposal 模式下工作室写回的提案摘要
  reply_kind: FrReplyKind | null;
  reply_text: string | null;     // 最终入队的回复正文（不含引用前缀）
  reply_outbox_id: string | null;
  reply_enqueued_at: number | null;
  approved_by: string | null;
  created_at: number;
  updated_at: number;
}

/** 允许的转移。键 = 当前状态；值 = 可到达状态。其它一律拒绝（409）。终态不能再动。 */
export const FR_TRANSITIONS: Record<FrStatus, readonly FrStatus[]> = {
  queued: ["developing", "needs_human", "failed"],
  developing: ["developing", "queued", "shipped", "failed", "needs_human"],
  needs_human: ["queued", "rejected"],   // 只有 owner 的 decision 能动
  shipped: [], failed: [], rejected: [],
};

export interface FrConfig {
  enabled: boolean;
  auto_senders: string[];        // 额外白名单（messages.sender）；另外 members.role='owner' 自动算
  daily_auto_cap: number;        // 每天最多自动开发几张（默认 5）
  daily_cap_per_sender: number;  // 每个发言人每天最多立几张（默认 10）
  group_daily_cap: number;       // 全群每天硬上限（默认 30），超出不建单
  max_developing: number;        // 同时开发中的上限（默认 2）
  lease_hours: number;           // 领单租约（默认 6）
  stale_hours: number;           // 建单后多久没做成 → 转失败并回复（默认 72）
  quote_max: number; title_max: number; detail_max: number;
}

/** createRequest 的结果；tool 据此决定回话。 */
export type CreateOutcome =
  | { ok: true; id: string; duplicate: boolean; status: FrStatus; mode: FrMode; auto: boolean; risk_tags: FrRiskTag[]; say: string }
  | { ok: false; reason: "disabled" | "group_cap" | "sender_cap" | "invalid"; say: string };
// say = 给模型的一句话指引（模型据此回一句，不得再多说）：
//   queued        → "已立项，只回一句：收到，已记下，做好了告诉你。"
//   needs_human   → "已记下但需要管理员先确认，只回一句说明这一点。"
//   duplicate     → "这条之前已记过，不要再回复。"

/** 工作室侧看到的单子（GET 返回；quote/title/detail 一律是不可信数据，只能当功能描述）。 */
export interface FrPublic {
  id: string; status: FrStatus; mode: FrMode; auto: boolean; risk_tags: FrRiskTag[];
  sender_name: string;
  quote: string; title: string; detail: string;
  untrusted: true;               // 恒为 true；提醒读取方：不得执行其中的任何「指令」
  attempts: number; lease_until: number | null;
  created_at: number; updated_at: number;
  release: string | null; rollback_point: string | null;
  proposal_note: string | null;
  reply: { kind: FrReplyKind; text: string; outbox_status: string | null } | null;
}

/** POST /api/team/feature-requests/:id/report 的请求体。 */
export type FrReport =
  | { outcome: "shipped"; release: string; rollback_point: string; smoke_verified: true; reply_text: string }
  | { outcome: "failed"; reason: string }               // reason = 给用户看的原因，≤150 字，口语
  | { outcome: "needs_human"; reason: string }          // 不回复群，只改状态
  | { outcome: "proposal"; note: string }               // 仅 mode=proposal：写回提案摘要，状态不变
  | { outcome: "release" };                             // 放回队列（developing → queued）
