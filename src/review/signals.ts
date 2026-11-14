// D-3 deterministic signals. No model, no I/O. Defaults come from D-2's
// constants.ts; config.review.signals may override the same sections.
import TEAM from "../../config/team.json";
import { SIGNAL_DEFAULTS as CONSTANTS } from "./constants";
import { CAPABILITIES, type SignalKey, type Trace } from "./types";

export type NeighborMessage = { id?: string; body: string; ts?: string; at?: number };
export type Neighbors = {
  after?: NeighborMessage[];                 // next user messages after this trace
  user_before?: NeighborMessage[];           // user messages before inbound (for S9)
  bot_before?: { outbox_id?: string; body: string; at: number }[];
  deliveries?: number;                       // deliveries with files for this turn
  follows_bot?: boolean;                     // inbound directly follows a bot reply
  batch_started_at?: number;                 // first inbound covered by the same decision batch
  batch_replied_at?: number | null;          // first outbox for that batch
  batch_trigger?: boolean;                   // any batch member was addressed to the bot
};

type SignalConfig = {
  s1_window_ms: number;
  s1_follow_ms: number;
  bot_names: string[];
  s2_phrases: string[];
  s3_phrases: string[];
  s3_window_messages: number;
  s4_file_phrases: string[];
  s5_model_ms: number;
  s6_phrases: string[];
  s7_count: number;
  s7_window_ms: number;
  s8_phrases: string[];
  s9_window_ms: number;
  s9_kinds: string[];
  s10_window_ms: number;
  s10_similarity: number;
  s11_phrases: string[];
  capability_aliases: Record<string, string[]>;
  capability_positive: string[];
  capability_negative: string[];
};

const TUNED = ((TEAM as any).review?.signals || {}) as any;

export const SIGNAL_DEFAULTS: SignalConfig = {
  s1_window_ms: (TUNED.s1?.no_outbox_minutes ?? CONSTANTS.s1.no_outbox_minutes) * 60_000,
  s1_follow_ms: 10 * 60_000,
  bot_names: ["小助手", "群助手", "机器人", "bot"],
  s2_phrases: [...(TUNED.s2?.words ?? CONSTANTS.s2.words)],
  s3_phrases: [...(TUNED.s3?.words ?? CONSTANTS.s3.words)],
  s3_window_messages: TUNED.s3?.window_messages ?? CONSTANTS.s3.window_messages,
  s4_file_phrases: ["发你了", "发给你", "已发送", "已经发", "文件已发", "附件已发", "传给你", "传到", "下载链接"],
  s5_model_ms: TUNED.s5?.model_ms ?? CONSTANTS.s5.model_ms,
  s6_phrases: [...(TUNED.s6?.words ?? CONSTANTS.s6.words)],
  s7_count: TUNED.s7?.min_messages ?? CONSTANTS.s7.min_messages,
  s7_window_ms: (TUNED.s7?.window_minutes ?? CONSTANTS.s7.window_minutes) * 60_000,
  s8_phrases: [...(TUNED.s8?.words ?? CONSTANTS.s8.words)],
  s9_window_ms: (TUNED.s9?.lookback_minutes ?? CONSTANTS.s9.lookback_minutes) * 60_000,
  s9_kinds: [...(TUNED.s9?.kinds ?? CONSTANTS.s9.kinds)],
  s10_window_ms: (TUNED.s10?.window_minutes ?? CONSTANTS.s10.window_minutes) * 60_000,
  s10_similarity: TUNED.s10?.jaccard ?? CONSTANTS.s10.jaccard,
  s11_phrases: [...(TUNED.s11?.words ?? CONSTANTS.s11.words)],
  capability_aliases: {
    repo_read: ["仓库", "提交", "分支", "repo_changes", "repo_commit"],
    bili_video: ["b 站", "b站", "bili", "视频"],
    xhs_note: ["小红书", "xhs"],
    web_search: ["搜索", "搜一下", "网页"],
    attachment_send: ["文件", "附件"],
    image_read: ["图片", "看图"],
    memory_write: ["记忆", "remember_correction", "长期记忆"],
    ci_logs: ["ci", "流水线"],
  },
  capability_positive: ["能用", "可以用", "可用", "能看到", "可以看到", "有权限", "可以查", "已同步", "在线", "支持", "保存成功"],
  capability_negative: ["不能用", "用不了", "不可用", "看不到", "没权限", "没有权限", "不支持", "查不到", "没同步", "离线", "拿不到", "保存失败", "没保存"],
};

const POSITIVE = new Set(CAPABILITIES as readonly string[]);

const cut = (s: unknown) => String(s ?? "");
const normalize = (s: unknown) => cut(s).toLowerCase()
  .replace(/[\s，。！？、,.!?;；:："'“”‘’()（）【】\[\]…—_-]+/g, "");
const ms = (x: { at?: number; ts?: string }) =>
  typeof x.at === "number" ? x.at : Date.parse(String(x.ts || ""));

export function threeGramJaccard(a: string, b: string): number {
  const grams = (text: string) => {
    const chars = [...normalize(text)];
    const out = new Set<string>();
    for (let i = 0; i + 3 <= chars.length; i++) out.add(chars.slice(i, i + 3).join(""));
    return out;
  };
  const A = grams(a), B = grams(b);
  if (!A.size && !B.size) return 1;
  let overlap = 0;
  for (const g of A) if (B.has(g)) overlap++;
  return overlap / (A.size + B.size - overlap);
}

const matches = (text: string, phrases: string[]) => phrases.some((p) => text.includes(p));
const firstSentence = (text: string) => cut(text).split(/[。！？!?\n]/)[0];

function polarity(text: string, c: SignalConfig): "positive" | "negative" | null {
  const t = normalize(text);
  const occurrences = (phrase: string) => {
    const needle = normalize(phrase), out: number[] = [];
    if (!needle) return out;
    let from = 0;
    while (from <= t.length - needle.length) {
      const at = t.indexOf(needle, from);
      if (at < 0) break;
      out.push(at);
      from = at + needle.length;
    }
    return out;
  };
  // A negative phrase contains its positive counterpart ("不可用" vs "可用").
  // Mask the negative spans so the positive match inside it is not counted.
  const negatives: { start: number; end: number }[] = [];
  let best: { at: number; polarity: "positive" | "negative" } | null = null;
  for (const phrase of c.capability_negative) {
    const len = normalize(phrase).length;
    for (const at of occurrences(phrase)) {
      negatives.push({ start: at, end: at + len });
      if (!best || at > best.at) best = { at, polarity: "negative" };
    }
  }
  for (const phrase of c.capability_positive) {
    const len = normalize(phrase).length;
    for (const at of occurrences(phrase)) {
      if (negatives.some((span) => at >= span.start && at < span.end)) continue;
      if (!best || at > best.at) best = { at, polarity: "positive" };
    }
  }
  return best?.polarity || null;
}

function contradiction(a: string, b: string, c: SignalConfig): boolean {
  const x = normalize(a), y = normalize(b);
  for (const [capability, aliases] of Object.entries(c.capability_aliases)) {
    if (!POSITIVE.has(capability)) continue;
    if (!aliases.some((alias) => x.includes(normalize(alias)))) continue;
    if (!aliases.some((alias) => y.includes(normalize(alias)))) continue;
    const pa = polarity(a, c), pb = polarity(b, c);
    if (pa && pb && pa !== pb) return true;
  }
  return false;
}

/** S1-S10 in table order. Inputs are already redacted by the trace builder. */
export function signalsOf(trace: Trace, neighbors: Neighbors = {}, config: Partial<SignalConfig> = {}): SignalKey[] {
  const c = { ...SIGNAL_DEFAULTS, ...config };
  const inbound = trace.inbound;
  const inboundAt = inbound ? Date.parse(inbound.ts) : (trace.replies[0]?.at ?? 0);
  const replies = trace.replies || [];
  const replyText = replies.map((r) => cut(r.body)).join("\n");
  const found: SignalKey[] = [];

  if (inbound) {
    const startedAt = neighbors.batch_started_at ?? inboundAt;
    const trigger = neighbors.batch_trigger === true || inbound.mentioned === 1 ||
      matches(firstSentence(inbound.body), c.bot_names) ||
      Boolean(neighbors.follows_bot) ||
      (neighbors.bot_before || []).some((r) => inboundAt - r.at >= 0 && inboundAt - r.at <= c.s1_follow_ms);
    const ownReply = replies.find((r) => r.at >= startedAt - 5_000);
    const repliedAt = neighbors.batch_replied_at ?? ownReply?.at;
    const repliedSoon = typeof repliedAt === "number" && repliedAt >= startedAt && repliedAt - startedAt <= c.s1_window_ms;
    const reasonedStop = trace.decision?.action === "stop" && Boolean(cut(trace.decision.reason).trim());
    if (trigger && !repliedSoon && !reasonedStop) found.push("S1");
  }

  if (matches(replyText, c.s2_phrases)) found.push("S2");

  if ((neighbors.after || []).slice(0, c.s3_window_messages).some((m) => matches(m.body, c.s3_phrases))) found.push("S3");

  const failedSend = replies.some((r) => r.status === "failed" || r.status === "unknown");
  const claimsFile = replies.some((r) => matches(r.body, c.s4_file_phrases));
  if (failedSend || (claimsFile && (neighbors.deliveries || 0) === 0)) found.push("S4");

  const failedTool = Array.isArray(trace.tools) && trace.tools.some((t) => !t.ok);
  if (trace.job?.status === "failed" || (trace.decision?.model_ms || 0) > c.s5_model_ms || failedTool) found.push("S5");

  if (matches(replyText, c.s6_phrases)) found.push("S6");

  const times = replies.map((r) => r.at).sort((a, b) => a - b);
  for (let i = 0; i + c.s7_count - 1 < times.length; i++) {
    const start = times[i], end = times[i + c.s7_count - 1];
    if (end - start > c.s7_window_ms) continue;
    // A user message between the first and last segment breaks the run.
    const interrupted = (neighbors.after || []).some((m) => {
      const at = ms(m);
      return at > start && at < end;
    });
    if (!interrupted) { found.push("S7"); break; }
  }

  if (matches(replyText, c.s8_phrases)) found.push("S8");

  const proactive = Boolean(trace.decision?.spoken_kind && c.s9_kinds.includes(trace.decision.spoken_kind));
  const priorS3 = (neighbors.user_before || []).some((m) => {
    const at = ms(m);
    return at >= inboundAt - c.s9_window_ms && at <= inboundAt && matches(m.body, c.s3_phrases);
  });
  if (proactive && priorS3) found.push("S9");

  const duplicate = (neighbors.bot_before || []).some((previous) => {
    if (inboundAt - previous.at < 0 || inboundAt - previous.at > c.s10_window_ms) return false;
    return replies.some((reply) =>
      threeGramJaccard(reply.body, previous.body) >= c.s10_similarity ||
      contradiction(reply.body, previous.body, c));
  });
  if (duplicate) found.push("S10");

  // S11：只认群友 inbound、确实在对 bot 说（@ / 回复 / 点名开头）；bot 自己的 outbound 没有 inbound。
  const addressedToBot = inbound && (inbound.addressed === "bot" || inbound.mentioned === 1);
  if (trace.kind === "inbound" && inbound && addressedToBot && matches(inbound.body, c.s11_phrases)) found.push("S11");

  return found;
}

const PRIORITY = CONSTANTS.priority as Record<SignalKey, number>;

export function priorityOf(signals: Iterable<SignalKey>): number {
  let total = 0;
  for (const signal of signals) total += PRIORITY[signal] || 0;
  return total;
}
