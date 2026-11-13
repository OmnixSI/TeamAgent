// V-D 评判闭环 · 共享类型（种子 v2，来自 design.md §接口与数据结构 + amendments-v2.md；其他包只 import 不改枚举）
export const FAILURE_TYPES = [
  "reasoning.hallucination.language", "reasoning.hallucination.tool",
  "reasoning.information.poor_retrieval", "reasoning.information.tool_misread",
  "reasoning.decision.problem_id", "reasoning.decision.tool_selection",
  "reasoning.output.format", "reasoning.output.instruction",
  "system.config.tool_definition", "system.config.environment",
  "system.api.rate_limit", "system.api.auth", "system.api.service", "system.api.not_found",
  "system.resource.exhaustion", "system.resource.timeout",
  "planning.context.handling", "planning.context.abuse",
  "planning.task.goal_deviation", "planning.task.orchestration",
  "team.prompt_rule_missing",
] as const;                                        // TRAIL 叶子 + 本团队一项
export const GAP_TYPES = ["tool_missing", "tool_not_selected", "tool_failed", "capability_offline",
  "switch_or_policy_off", "data_stale_or_coverage", "prompt_rule_missing"] as const;
export const FIX_LAYERS = ["product", "prompt", "tool_impl", "ops", "permission", "data", "memory"] as const;
export const SEVERITIES = ["p0", "p1", "p2"] as const;
// p0 安全/越权/丢数据；p1 漏答、事实错、有可用工具没用、静默失败；p2 表达、啰嗦、效率
export const DIMENSIONS = ["answered", "facts", "tool_choice", "memory", "expression", "boundary"] as const;
export const VERDICT = ["SATISFIED", "UNSATISFIED", "INSUFFICIENT"] as const;
// V-B src/capabilities.ts 的 ErrorKind 镜像；D-7 合入后改成 import 并加编译期相等断言
export const TOOL_ERROR_KINDS = ["unauthorized", "budget", "timeout", "not_found", "ambiguous",
  "invalid_args", "denied", "stale_index", "not_synced", "runner_offline", "runner_unsupported",
  "upstream", "risk", "unknown", "duplicate", "unrecorded"] as const; // unrecorded: D-7 之前没审计
export const SIGNALS = { S1:"漏答", S2:"拒答/降级措辞", S3:"随后用户纠正/抱怨", S4:"发送或交付失败",
  S5:"job 失败/超时/工具报错", S6:"承诺措辞", S7:"连发≥4 条", S8:"能力自述",
  S9:"与当前对话无关的主动长文", S10:"30 分钟内同问同答/自相矛盾" } as const;
export const CAPABILITIES = ["repo_visibility", "repo_read", "repo_disambiguation", "bili_video", "bili_shortlink",
  "xhs_note", "web_search", "attachment_send", "attachment_read", "image_read", "ci_logs", "scheduling", "api_quota",
  "memory_write", "participation", "addressee", "persona_tone", "health_selfcheck"] as const; // 另允许 `other:<词>`
// v2/P1-1：文本来源。只有 direct 能当规则/记忆的证据；其余只能当「发生了什么」的证据
export const ORIGINS = ["direct", "quoted", "forwarded", "card", "attachment_text", "image_text", "bot"] as const;
// v2/P1-1：类型化规则；free 只能停在 candidate，管理员批准后才进 canary
export const RULE_KINDS = ["reply_max_chars", "burst_max", "mention_only_window", "language", "format_pref", "free"] as const;
// v2：双判官
export const PROVIDERS = ["deepseek", "workers-ai", "openai", "codex-offline"] as const;
export const AGREEMENT = ["agree", "disagree", "single", "pending"] as const;
export const FINDING_STATUS = ["open", "disputed", "accepted", "rejected", "fixed", "wontfix", "regression"] as const;
export const MEMORY_CANDIDATE_STATUS = ["candidate", "approved", "applied", "rejected", "blocked", "conflict", "superseded"] as const;

export type FailureType = (typeof FAILURE_TYPES)[number];
export type GapType = (typeof GAP_TYPES)[number];
export type FixLayer = (typeof FIX_LAYERS)[number];
export type Severity = (typeof SEVERITIES)[number];
export type Dimension = (typeof DIMENSIONS)[number];
export type Verdict = (typeof VERDICT)[number];
export type SignalKey = keyof typeof SIGNALS;
export type ToolErrorKind = (typeof TOOL_ERROR_KINDS)[number];
export type Origin = (typeof ORIGINS)[number];
export type RuleKind = (typeof RULE_KINDS)[number];
export type Provider = (typeof PROVIDERS)[number];
export type Agreement = (typeof AGREEMENT)[number];
export type FindingStatus = (typeof FINDING_STATUS)[number];

export type Seg = { origin: Origin; text: string };   // 一条消息按来源切开的片段
export type TraceMsg = { id: string; sender: string; ts: string; body: string; segs: Seg[];
  bound_member: string | null;                     // members.id（未绑定 / 已吊销 = null）
  addressed: "bot" | "other" | "none";            // mentioned / replyTo.kind='bot' / 点名在前 = bot
  images: { idx: number; sha: string; desc: string | null; url_ok: boolean | null }[] };

export type Trace = {
  id: string; group_id: string;                   // 'tr-in-<message id>' | 'tr-out-<outbox id>'
  kind: "inbound" | "outbound";                   // v2/P1-3：outbound = 无法配对的独立外发
  inbound: (TraceMsg & { mentioned: 0|1 }) | null; // v2/P1-3：outbound trace 为 null；不再带 rowid
  context_before: TraceMsg[];                      // ≤6 条，每条 ≤300 字
  decision?: { action: string; gate: string; spoken_kind?: string; reason?: string; model_ms?: number };
  replies: { outbox_id: string; body: string; status: string; at: number;
    link: "reply_to" | "decision" | "batch" | "none" }[];  // ≤4 条，每条 ≤800 字；link=怎么配上的
  after: TraceMsg[];                               // 其后 ≤3 条用户消息（看纠正）
  job?: { id: string; kind: string; status: string; error?: string };
  tools: { id: string; name: string; ok: boolean; error_kind: string; ms: number }[] | "unrecorded"; // id=turn_tools.id
  tools_offered: { names: string[]; catalog_version: string; switches: Record<string, "on"|"off">;
    runner_ok: 0|1|null; turn_id: string } | "unknown";  // v2/P1-7：当轮 turn_offers；没有就是 unknown，不拿现在补
  snapshot_ref: { health_at: number; gateway_ok: 0|1; runner_ok: 0|1 } | null;
  has_image: boolean;
  signals: (keyof typeof SIGNALS)[];
};

export type Snapshot = {
  at: number;
  switches: Record<string, "on"|"off">;           // SWITCH_KEYS 里所有 off:*（不读 auth:* 的值，只读是否存在）
  runner: { seen_age_s: number|null; ok_ratio_24h: number };   // settings.runner_seen + health_samples
  gateway: { ok_ratio_24h: number };
  repo: { repo: string; state_age_s: number|null; cache_age_s: number|null; commits: number }[];
  jobs_24h: { kind: string; failed: number; done: number }[];
  tools_catalog: { name: string; readonly: boolean; needs: ("runner"|"github_token"|"switch")[] }[];
  catalog_version: string;                        // v2/P1-7：结构化目录版本；capabilityCard 文本不是数据源
  release: string;                                // /health 的 release
};

export type Evidence = { source: "message" | "outbox" | "snapshot" | "tool" | "image"; id: string; quote: string;
  origin?: Origin;                                // v2/P1-1：校验器回填，不信模型自报
  image?: { message_id: string; idx: number; sha: string } }; // source='image' 时必填；quote 对 image_notes.desc 或看图模型输出逐字
export type JudgeVerdict = {
  trace_id: string; reasoning: string; dimensions: Record<Dimension, Verdict>;
  failure_type: FailureType | null; severity: Severity; fix_layer: FixLayer;
  gap_type: GapType | null; capability: string | null; should_use_tool: string | null;
  evidence: Evidence[]; what_happened: string; expected: string; root_cause: string;
  next_attempt_plan: string; confidence: number;
  kind: "response_fault" | "capability_gap" | "system_fault" | "none"; // v2：与黄金基线 judge-prompt-v2 对齐
};
export type JudgeRequirement = { kind: RuleKind; params: Record<string, string | number>; // v2/P1-1
  rule: string; scene: string; evidence: Evidence[]; ttl_days: number };  // rule 仅 free 用；类型化规则由模板渲染
export type JudgeMemoryUpdate = { op: "ADD" | "UPDATE" | "DELETE" | "NONE"; repo: string; subject: string;
  predicate: string; value: string; evidence: Evidence[] };
export type JudgePromise = { outbox_id: string; quote: string; what: string; due: string | null; recurring: string | null };
export type JudgeResult = {
  schema: "ta.review.result.v2"; verdicts: JudgeVerdict[]; requirements: JudgeRequirement[];
  memory_updates: JudgeMemoryUpdate[]; promises: JudgePromise[]; no_action: { trace_id: string; why: string }[];
};
// v2：第二家复核的输出（只判不提新要求/记忆/承诺）
export type SecondVerdict = { trace_id: string; verdict: "issue" | "pass" | "insufficient";
  failure_type: FailureType | null; gap_type: GapType | null; severity: Severity;
  dimensions: Record<Dimension, Verdict>; evidence: Evidence[]; reason: string; confidence: number };
export type SecondResult = { schema: "ta.review.second.v1"; verdicts: SecondVerdict[] };
// v2：provider 适配层接口（judge-model.ts 实现；按配置选）
export type JudgeCall = { provider: Provider; model: string; system: string; user: string;
  images?: { message_id: string; idx: number; mime: string; b64: string }[];  // 只 openai(Luna) 用
  max_tokens: number; timeout_ms: number };
export type JudgeReply = { ok: boolean; text: string; finish_reason: "stop" | "length" | "error" | "timeout";
  usage: { input: number; output: number; neurons?: number; usd_micros?: number } | null; error_kind?: string };
