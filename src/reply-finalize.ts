// L2：speakBrief 之后的最后一道代码保底。
// ① 定时登记成功的回执由代码补；② 模型只口头答应、没调工具时按群友原话补登记；
// ③ 口头禅 scrub（L7 填实，本包先留桩）。这里不直接碰 D1，读写都通过调用方传入的回调。
import { describeSchedule, nextRun, parseScheduleRequest, slug, sydneyText } from "./schedules";
import type { NewSchedule, ScheduleSpec } from "./schedules";

const ACK = "记下了";
/** 登记类工具成功后的实话回执；模型自己的答应句不一定提到已登记。 */
const FEATURE_ACK = "收到，已记下，做好了告诉你。";
const FEATURE_ACKED = /已记下|已立项|已登记|记下了|记上了/;
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
  /** L7：口头禅命中后由调用方写 activity rule.violation；本文件不碰 D1。 */
  onViolation?: (phrase: string, count: number) => void;
  /** 本轮是否真的成功排入了一张生成图（generate_image 的 accepted 结果）。 */
  imageGenerated?: boolean;
  /** 群友这条消息是否明确在要一张图；是则即使模型没提画图也要补。 */
  imageRequested?: boolean;
  /** 本轮模型已经调过 generate_image（失败也算）；不要因为失败再花第二次钱。 */
  imageAttempted?: boolean;
  /** 图片承诺没有兑现时的重做：用群友原话直接调 generate_image。 */
  generateImage?: (prompt: string) => Promise<any>;
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
// 整句带这些词才算在承诺；后面的疑问词只是从句（「列出当天是否有新 PR」）。
const PROMISE_WORD_RE = /(?:我会|我就|记下了|已经(?:设|定|建|安排)|安排好了|设好了|定好了)/;
// 明显在列待办/征求同意（VL-6 rid=254「…未闭环…」），一律不算承诺。
const OPEN_ITEM_RE = /(?:未闭环|待确认|还没答复|要我(?:记|设|建|帮|每))/;
// 只认最后一个分句的句尾疑问语气；不限位置的「是不是/怎么」会放过真承诺。
const QUESTION_TAIL_RE = /(?:吗|呢|要不要|好不好|行不行|可以吗)[？?。]?\s*$/;

/** 疑问句是在征求同意（「每天早 8 点推送，要吗？」），不是承诺。
 *  只看最后一个分句；整句有承诺词时仍按承诺处理。 */
function askingForConsent(sentence: string) {
  const tail = (sentence.split(/[，,：:]/).pop() || "").trim();
  return /[？?]\s*$/.test(sentence) || QUESTION_TAIL_RE.test(tail);
}

/** 找回复里那句「每天/每周…X 点…发/推/出」的承诺；只认同句里三样都出现。 */
function promiseSentence(text: string) {
  SENTENCE_RE.lastIndex = 0;
  for (let m = SENTENCE_RE.exec(text); m; m = SENTENCE_RE.exec(text)) {
    const sentence = m[0];
    if (OPEN_ITEM_RE.test(sentence) || (!PROMISE_WORD_RE.test(sentence) && askingForConsent(sentence))) continue;
    if (RECURRING_RE.test(sentence) && CLOCK_RE.test(sentence) && PUSH_VERB_RE.test(sentence))
      return sentence;
  }
  return null;
}

const IMAGE_CLAIM_RE = /\[图片\]|画好了|画好啦|已经画好|图已发|图发你了|图给你了|这张补上|给你补上|上面那张就是|出图了/;
const IMAGE_MEASURE_RE =
  /(?:画|绘制|生成|做|整|来)\s*(?:一|两|几)?\s*(?:下|个|张|幅|只|条|版|套)/;
const IMAGE_SHORT_RE = /^(?:帮我|给我|请|麻烦)?\s*(?:画|绘制|生成)\s*[^，。！？\n]{1,20}$/;
const IMAGE_NOUN_RE = /形象|头像|海报|插画|壁纸|表情包/;
const IMAGE_VERB_RE = /画|绘制|生成|做|整|来|拟|设计/;
const NOT_IMAGE_REQUEST_RE =
  /数据图|图表|流程图|架构图|示意图|画饼|画重点|画个屁|画个鬼|画你|画啥|画什么|别画|不画|不要画|不想画/;
const IMAGE_CLAIM_REPLY = "刚才那句不算：这一轮没有真的把图发出去";

/** 模型常见假回执：文字里说图已经发了，但本轮没有任何 generate_image 成功记录。 */
export function claimsGeneratedImage(text: string) {
  return IMAGE_CLAIM_RE.test(String(text ?? ""));
}
/** 只把明确的画面请求拿去重做；「你单独发图」这类指令不会变成奇怪的生图提示词。 */
export function isImageRequest(text: string) {
  const value = String(text ?? "").trim();
  if (!value || NOT_IMAGE_REQUEST_RE.test(value)) return false;
  return (
    IMAGE_MEASURE_RE.test(value) ||
    IMAGE_SHORT_RE.test(value) ||
    (IMAGE_NOUN_RE.test(value) && IMAGE_VERB_RE.test(value))
  );
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

  // ①b request_feature 成功但模型只顾着答应（「以后…」）时，先把登记的事实说清楚。
  const feature = (o.acceptedActions || []).find(
    (a) => a?.tool === "request_feature" && a.accepted !== false
      && typeof a.say === "string" && /已立项|已记下|已登记/.test(a.say),
  );
  if (feature && !FEATURE_ACKED.test(text)) {
    text = prefixLead(text, FEATURE_ACK);
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

  // ③ 口头禅清理：只删单独成句的词；命中计数经注入回调写 activity（本文件不碰 D1）。
  const scrubbed = scrubHits(text, o.avoid ?? []);
  if (scrubbed.text !== text) {
    text = scrubbed.text;
    changed = true;
  }
  for (const hit of scrubbed.hits) o.onViolation?.(hit.phrase, hit.count);

  // ④ 图片兜底：本轮没有 generate_image 成功记录时，两种触发都要补。
  //   a) 模型说「画好了/[图片]」——假回执；
  //   b) 群友明确在要图、模型只回文字——漏调工具。
  // 图片和文字始终是两条独立消息：这里只补 outbox~g，文字随后单独发。
  if (!o.imageGenerated) {
    const claim = claimsGeneratedImage(text);
    const requested = o.imageRequested ?? isImageRequest(o.userText || "");
    if (claim || requested) {
      let made: any = null;
      if (o.generateImage && requested && !o.imageAttempted) {
        try {
          made = await o.generateImage(String(o.userText || "").trim().slice(0, 1000));
        } catch {
          made = null;
        }
      }
      if (made?.ok === true) {
        // 图已经单独排队，文字只留一句回执；不再让模型描述它没看过的图。
        text = "画好了，图单独发。";
        changed = true;
      } else if (claim) {
        const reason =
          typeof made?.reason_text === "string" && made.reason_text
            ? `（${made.reason_text}）`
            : "";
        text = `${IMAGE_CLAIM_REPLY}${reason}。你再说一句要画什么，我重画。`;
        changed = true;
      }
    }
  }

  if (!changed) return spoken;
  value.text = text;
  return JSON.stringify(value);
}
