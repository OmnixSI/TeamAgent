// L2：speakBrief 之后的最后一道代码保底。
// ① 定时登记成功的回执由代码补；② 回执守卫（D4 §5.6）对所有 family 的承诺句对账：
//   有成功结果就保留，日程能补建就补建，否则换成老实措辞；
// ③ 口头禅 scrub（L7 填实，本包先留桩）。这里不直接碰 D1，读写都通过调用方传入的回调。
import { nextRun, parseScheduleRequest, slug, sydneyText } from "./schedules";
import type { NewSchedule, ScheduleSpec } from "./schedules";
import { GUARD_FALLBACK, familyOfTool, guardReceipts } from "./receipt-guard";
import type { Accepted, Family } from "./receipt-guard";

export { GUARD_FALLBACK };

const ACK = "记下了";

export type FinalizeAction = {
  tool?: string;
  accepted?: boolean;
  say?: string;
  [key: string]: any;
};

export type FinalizeOptions = {
  acceptedActions?: FinalizeAction[];
  /** 本轮失败的工具结果，honest() 用它的 reason 说明为什么没登记上。 */
  failedActions?: FinalizeAction[];
  avoid?: string[];
  /** 群友本轮原话，schedule 补建用它解析「每天/每周 X 点发 XX」。 */
  userText?: string;
  owner?: string;
  groupId?: string;
  sourceMsgId?: string;
  now?: number;
  /** 注入 createSchedule(e, input)；纯逻辑不直接拿 e。 */
  createSchedule?: (input: NewSchedule) => Promise<any>;
  /** 注入「本群同 kind、时间差 ≤10 分钟的 active 日程」查询。 */
  findDuplicate?: (kind: string, nextRunAt: number) => Promise<any | null>;
  /** 阶段 2：semantic 注入的补建（parseWhen/parseContent），优先于本地旧解析。 */
  autoLand?: (family: Family) => Promise<Accepted | null>;
  /** 阶段 2：semantic 注入的「本群是否已有对应 active 行」。 */
  existing?: (family: Family) => Promise<boolean>;
  /** 上一轮 bot 回复：同 family 的兜底句重复时换第二套措辞。 */
  lastBotText?: string;
  /** L7：口头禅命中后由调用方写 activity rule.violation；本文件不碰 D1。 */
  onViolation?: (phrase: string, count: number) => void;
};

function escapeRe(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** 只命中单独成句的口头禅：前后是标点/空白或文本边界。 */
function phrasePattern(phrase: string) {
  // 边界先判、再吞掉紧跟的标点：「草，这个」整体删成「这个」；
  // 「work：草，被骂」保留前导冒号，不会把词黏到上一段。
  return new RegExp(
    "(^|[，。！？!?,；;：:\\s])" + escapeRe(phrase) + "(?=$|[，。！？!?,；;：:\\s])" + "[！!。.~～…，,]*",
    "g",
  );
}
/** 内部带归因的版本；对外签名保持 L2 接好的 { text, count }。 */
function scrubHits(
  text: string,
  phrases: string[],
): { text: string; count: number; hits: { phrase: string; count: number }[] } {
  const original = String(text ?? "");
  let out = original;
  const hits: { phrase: string; count: number }[] = [];
  let count = 0;
  for (const raw of phrases || []) {
    const phrase = String(raw ?? "").trim();
    if (!phrase) continue;
    let removed = 0;
    // 保留前导标点：「work：草，…」删完仍是「work：…」，不会把词黏到上一段。
    // 前导标点会随匹配一起被跳过，连续两次命中时再扫一遍（最多 4 轮）。
    for (let pass = 0; pass < 4; pass++) {
      let hit = 0;
      out = out.replace(phrasePattern(phrase), (_match, lead: string) => {
        hit++;
        return lead;
      });
      removed += hit;
      if (!hit) break;
    }
    if (!removed) continue;
    // ≤2 字的短语只删不计数：「草」可能只是「草稿/草案」的一部分。
    if (Array.from(phrase).length >= 3) {
      count += removed;
      hits.push({ phrase, count: removed });
    }
  }
  if (out !== original) {
    out = out
      .replace(/([，,。.；;：:])(?:\s*\1)+/g, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
    // 删空就退回原文（群里不能发空消息），但命中仍计数。
    if (!out) return { text: original, count, hits };
  }
  return { text: out, count, hits };
}

/** L7：删除单独成句的口头禅；嵌入句子的不改。≥3 字才计 violation，删空退回原文。 */
export function scrubAvoided(text: string, phrases: string[]): { text: string; count: number } {
  const result = scrubHits(text, phrases);
  return { text: result.text, count: result.count };
}

function parseSpoken(spoken: string): Record<string, any> {
  try {
    const value = JSON.parse(spoken);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  return { mode: "banter", text: spoken };
}

function prefixLead(text: string, lead: string) {
  const s = String(lead || "").trim();
  if (!s) return text;
  if (!text) return s;
  return /[。！？!?；;：:，,、\s]$/.test(s) ? s + text : s + "。" + text;
}

/** FinalizeAction → 守卫用的 Accepted；未知工具不参与对账。 */
function toAccepted(action: FinalizeAction, ok: boolean): Accepted | null {
  const tool = String(action?.tool || "");
  const family = (action?.family as Family) || familyOfTool(tool);
  if (!family) return null;
  const accepted: Accepted = { tool, family, ok };
  const id = action?.id ?? action?.row_id ?? action?.schedule_id;
  if (id !== undefined && id !== null && String(id)) accepted.id = String(id);
  const reason = action?.reason_text ?? action?.reason;
  if (reason) accepted.reason = String(reason);
  const next = action?.next_run_text;
  if (typeof next === "string" && next.trim()) (accepted as any).next_run_text = next.trim();
  return accepted;
}

/** 阶段 1 的 schedule 补建：沿用旧 parseScheduleRequest + createSchedule；阶段 2 由 semantic 注入新版。 */
function legacyAutoLand(o: FinalizeOptions) {
  return async (family: Family): Promise<Accepted | null> => {
    if (family !== "schedule") return null;
    const parsed = parseScheduleRequest(o.userText || "");
    if (!parsed || !o.groupId) return null;
    const kind = parsed.cadence === "daily" ? "digest_daily" : "digest_weekly";
    const spec: ScheduleSpec = {
      time: parsed.time,
      ...(parsed.weekdays ? { weekdays: parsed.weekdays } : {}),
      topic: parsed.topic,
      origin: "chat",
      request_quote: String(o.userText || "").trim().slice(0, 200),
      dedup: slug(parsed.topic, o.sourceMsgId || ""),
    };
    const now = o.now ?? Date.now();
    const next = nextRun(spec, now);
    let duplicate: any = null;
    if (next !== null && o.findDuplicate) {
      try {
        duplicate = await o.findDuplicate(kind, next);
      } catch {
        duplicate = null;
      }
    }
    if (duplicate) {
      const nextText = duplicate.next_run_at ? sydneyText(duplicate.next_run_at, duplicate.tz) : "";
      return {
        tool: "schedule_create",
        family: "schedule",
        id: duplicate.id,
        ok: true,
        ...(nextText ? { next_run_text: nextText } : {}),
      } as Accepted;
    }
    if (next === null || !o.createSchedule) return null;
    try {
      const made = await o.createSchedule({
        group_id: o.groupId,
        owner: o.owner || "群友",
        kind,
        spec,
        source_msg_id: o.sourceMsgId,
      });
      const nextText = made?.next_run_at ? sydneyText(made.next_run_at, made.tz) : "";
      return {
        tool: "schedule_create",
        family: "schedule",
        id: made?.id,
        ok: true,
        ...(nextText ? { next_run_text: nextText } : {}),
      } as Accepted;
    } catch {
      return null;
    }
  };
}

/**
 * 把 speakBrief 的 JSON / 纯文本做最后收口。没有可改的地方时原样返回，
 * 保证「没有 avoid、没有 accepted、没有承诺」的旧路径逐字不变。
 */
export async function finalizeSpoken(spoken: string, o: FinalizeOptions = {}): Promise<string> {
  if (!spoken) return spoken;
  if (spoken.trim() === "[[SILENT]]") return spoken;
  const value = parseSpoken(spoken);
  const originalText = typeof value.text === "string" ? value.text : "";
  if (originalText.trim() === "[[SILENT]]") return spoken;
  let text = originalText;
  let changed = false;

  // ① schedule_create 成功后的回执：模型没说「记下了」就由代码补。
  const creates = (o.acceptedActions || []).filter((a) => a?.tool === "schedule_create");
  const ack = creates.find((a) => typeof a.say === "string" && a.say.trim());
  if (ack && !text.includes(ACK)) {
    text = prefixLead(text, String(ack.say));
    changed = true;
  }

  // ② 回执守卫：所有 family 的承诺句都要有本轮成功结果、库里已有行或补建，否则换老实措辞。
  if (text) {
    const accepted: Accepted[] = [];
    for (const action of o.acceptedActions || []) {
      const ok = action?.accepted !== false && action?.ok !== false;
      const mapped = toAccepted(action, ok);
      if (mapped) accepted.push(mapped);
    }
    const failures: Accepted[] = [];
    for (const action of o.failedActions || []) {
      const mapped = toAccepted(action, false);
      if (mapped) failures.push(mapped);
    }
    const guarded = await guardReceipts({
      text,
      accepted,
      failures,
      lastBotText: o.lastBotText,
      autoLand: o.autoLand || legacyAutoLand(o),
      existing: o.existing,
    });
    if (guarded.text !== text) {
      text = guarded.text;
      changed = true;
    }
  }

  // ③ 口头禅清理：只删单独成句的词；命中计数经注入回调写 activity（本文件不碰 D1）。
  const scrubbed = scrubHits(text, o.avoid ?? []);
  if (scrubbed.text !== text) {
    text = scrubbed.text;
    changed = true;
  }
  for (const hit of scrubbed.hits) o.onViolation?.(hit.phrase, hit.count);

  if (!changed) return spoken;
  value.text = text;
  return JSON.stringify(value);
}
