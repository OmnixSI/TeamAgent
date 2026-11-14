// L2：speakBrief 之后的最后一道代码保底。
// ① 定时登记成功的回执由代码补；② 模型只口头答应、没调工具时按群友原话补登记；
// ③ 口头禅 scrub（L7 填实，本包先留桩）。这里不直接碰 D1，读写都通过调用方传入的回调。
import { describeSchedule, nextRun, parseScheduleRequest, slug, sydneyText } from "./schedules";
import type { NewSchedule, ScheduleSpec } from "./schedules";

const ACK = "记下了";
const GUARD_FALLBACK = "这个我还没登记上，你说一下每天几点、发什么，我马上建。";

export type FinalizeAction = {
  tool?: string;
  accepted?: boolean;
  say?: string;
  [key: string]: any;
};

export type FinalizeOptions = {
  acceptedActions?: FinalizeAction[];
  avoid?: string[];
  /** 群友本轮原话，promiseGuard 用它解析「每天/每周 X 点发 XX」。 */
  userText?: string;
  owner?: string;
  groupId?: string;
  sourceMsgId?: string;
  now?: number;
  /** 注入 createSchedule(e, input)；纯逻辑不直接拿 e。 */
  createSchedule?: (input: NewSchedule) => Promise<any>;
  /** 注入「本群同 kind、时间差 ≤10 分钟的 active 日程」查询。 */
  findDuplicate?: (kind: string, nextRunAt: number) => Promise<any | null>;
};

/** L7 会把这个桩填实；L2 只保证调用点已经接上。 */
export function scrubAvoided(text: string, phrases: string[]): { text: string; count: number } {
  void phrases;
  return { text, count: 0 };
}

function parseSpoken(spoken: string): Record<string, any> {
  try {
    const value = JSON.parse(spoken);
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {}
  return { mode: "banter", text: spoken };
}

function withSpecString(row: any) {
  if (row && typeof row.spec === "object" && row.spec !== null)
    return { ...row, spec: JSON.stringify(row.spec) };
  return row;
}

function prefixLead(text: string, lead: string) {
  const s = String(lead || "").trim();
  if (!s) return text;
  if (!text) return s;
  return /[。！？!?；;：:，,、\s]$/.test(s) ? s + text : s + "。" + text;
}

function replaceOnce(text: string, needle: string, replacement: string) {
  const i = text.indexOf(needle);
  if (i < 0) return text;
  return text.slice(0, i) + replacement + text.slice(i + needle.length);
}

const SENTENCE_RE = /[^。！？!?；;\n]+[。！？!?；;\n]?/g;
const RECURRING_RE = /每\s*(?:天|日|早|晚|个?\s*(?:周|星期|礼拜))/;
const CLOCK_RE = /(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*[点时])/;
const PUSH_VERB_RE = /(?:发|推|出)/;

/** 找回复里那句「每天/每周…X 点…发/推/出」的承诺；只认同句里三样都出现。 */
function promiseSentence(text: string) {
  SENTENCE_RE.lastIndex = 0;
  for (let m = SENTENCE_RE.exec(text); m; m = SENTENCE_RE.exec(text)) {
    const sentence = m[0];
    if (RECURRING_RE.test(sentence) && CLOCK_RE.test(sentence) && PUSH_VERB_RE.test(sentence))
      return sentence;
  }
  return null;
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

  // ② promiseGuard：回复在承诺定时推送，但这一轮没有 accepted 的 schedule_create。
  const hasAccepted = creates.some((a) => a.accepted !== false);
  if (!hasAccepted && text) {
    const sentence = promiseSentence(text);
    if (sentence) {
      const parsed = parseScheduleRequest(o.userText || "");
      if (parsed && o.groupId) {
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
          text = prefixLead(text, `已经在发了，${describeSchedule(withSpecString(duplicate))}`);
          changed = true;
        } else if (next !== null && o.createSchedule) {
          try {
            const made = await o.createSchedule({
              group_id: o.groupId,
              owner: o.owner || "群友",
              kind,
              spec,
              source_msg_id: o.sourceMsgId,
            });
            text = prefixLead(
              text,
              `记下了，${describeSchedule(withSpecString(made))}，第一次是 ${sydneyText(made?.next_run_at, made?.tz)}。`,
            );
            changed = true;
          } catch {
            text = replaceOnce(text, sentence, GUARD_FALLBACK);
            changed = true;
          }
        } else {
          text = replaceOnce(text, sentence, GUARD_FALLBACK);
          changed = true;
        }
      } else {
        text = replaceOnce(text, sentence, GUARD_FALLBACK);
        changed = true;
      }
    }
  }

  // ③ 口头禅清理：L2 的桩不动文本，L7 填实后这里自动生效。
  const scrubbed = scrubAvoided(text, o.avoid ?? []);
  if (scrubbed.text !== text) {
    text = scrubbed.text;
    changed = true;
  }

  if (!changed) return spoken;
  value.text = text;
  return JSON.stringify(value);
}
