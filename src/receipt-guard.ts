// D4 §5.6：回执守卫。模型说「记下了 / 已建 / 已立项 / 已发布 / 建好了 / 在跑了」时，
// 必须有同 family 的成功工具结果；没有就补建（schedule）、查库（状态句）或换成老实措辞。
// 纯逻辑，不碰 D1：补建和查库都通过调用方传入的回调。

export type Family = "schedule" | "record" | "feature" | "task" | "skill" | "job";

export interface Accepted {
  tool: string;
  family: Family;
  id?: string;
  ok: boolean;
  reason?: string;
}

/** design §5.6 冻结的承诺词表，顺序也是单句多 family 时的兜底优先级。 */
export const CLAIMS: { family: Family; re: RegExp }[] = [
  {
    family: "schedule",
    re: /记下了|(已|已经)(设|建|定|登记)(好|上)?了?|设好了|定好了|真落地|以后每(天|周|月)|每(天|周|月).{0,10}(会|都会|准时)(发|推|提醒)/,
  },
  { family: "record", re: /记(好|上|下)了|已(记|入)(账|上|录)|账(已|记)(更新|改好)|删(掉|好)了/ },
  { family: "feature", re: /已立项|在建|已(登记|记录)(需求|下需求)|排进(计划|开发)/ },
  { family: "task", re: /已(发布|建|创建)(到工作台|任务)|任务(建好|已建)/ },
  { family: "skill", re: /(工具|技能|指令).{0,6}(建好|做好|已建|已保存|上线)/ },
  { family: "job", re: /(已经?|开始)(执行|跑)|在跑了|已排队/ },
];

export interface GuardInput {
  text: string;
  accepted: Accepted[];
  failures: Accepted[];
  lastBotText?: string;
  /** 仅 schedule：用 parseWhen/parseContent 对 userText 补建；返回 null 表示补不了。 */
  autoLand?: (family: Family) => Promise<Accepted | null>;
  /** 状态类追问时（「已经建好」）查库：本群是否已有对应 active 行。 */
  existing?: (family: Family) => Promise<boolean>;
}

export interface GuardViolation {
  family: Family;
  sentence: string;
  fixed: "landed" | "replaced" | "kept";
}

export interface GuardResult {
  text: string;
  /** 只记「本轮没有同 family 成功结果」的承诺句，以及它怎么被处理（补建/查库保留/换措辞）。 */
  violations: GuardViolation[];
}

/** schedule 第一套措辞；design §5.6 要求它原样保留。 */
export const GUARD_FALLBACK = "这个我还没登记上，你说一下每天几点、发什么，我马上建。";

type Wording = { plain: string; failed: (reason: string) => string };

const FIRST: Record<Family, Wording> = {
  schedule: {
    plain: GUARD_FALLBACK,
    failed: (reason) => `没登记上：${reason}，你说几点我马上建。`,
  },
  record: {
    plain: "这个我没记上，你说一下记什么、多少钱，我马上记。",
    failed: (reason) => `没记上：${reason}。`,
  },
  feature: {
    plain: "这个需求我没登记上，你说一下要什么，我马上提交。",
    failed: (reason) => `没登记上：${reason}。`,
  },
  task: {
    plain: "这个任务我没建到工作台，你说一下标题和要做什么，我马上建。",
    failed: (reason) => `没建上：${reason}。`,
  },
  skill: {
    plain: "这个技能我没存上，你说一下名字和步骤，我马上存。",
    failed: (reason) => `没存上：${reason}。`,
  },
  job: {
    plain: "这个还没跑起来，你说一下要跑什么，我马上执行。",
    failed: (reason) => `没跑起来：${reason}。`,
  },
};

// 第二套：上一条回复已经说过同一句时改用它，并给出可直接复制的一句话指令。
const SECOND: Record<Family, Wording> = {
  schedule: {
    plain: "这次没登记上。直接回我「每天几点、发什么」就行，比如「每天北京时间0点发余额」。",
    failed: (reason) =>
      `还是没登记上：${reason}。直接回我「每天几点、发什么」就行，比如「每天北京时间0点发余额」。`,
  },
  record: {
    plain: "这次没记上。直接回我「记账：我 360，卡特龙 50」这种就行。",
    failed: (reason) => `还是没记上：${reason}。直接回我「记账：我 360」这种就行。`,
  },
  feature: {
    plain: "这次没登记上。直接回我「记个需求：要什么」，写上要什么就行。",
    failed: (reason) => `还是没登记上：${reason}。直接回我「记个需求：…」就行。`,
  },
  task: {
    plain: "这次没建上。直接回我「建个任务：标题」就行。",
    failed: (reason) => `还是没建上：${reason}。直接回我「建个任务：标题」就行。`,
  },
  skill: {
    plain: "这次没存上。直接回我「建个技能：名字 + 步骤」就行。",
    failed: (reason) => `还是没存上：${reason}。直接回我「建个技能：名字 + 步骤」就行。`,
  },
  job: {
    plain: "这次没跑起来。直接回我「跑一下：要做什么」就行。",
    failed: (reason) => `还是没跑起来：${reason}。直接回我「跑一下：要做什么」就行。`,
  },
};

function cleanReason(reason: unknown) {
  return String(reason ?? "")
    .trim()
    .replace(/[。！？!?，,；;：:\s]+$/u, "");
}

/** honest(F, failures)：有失败原因说原因，没调用就说没登记上；variant 2 用于不与上一条重复。 */
export function honest(family: Family, failures: Accepted[] = [], variant: 1 | 2 = 1): string {
  const reason =
    (failures || [])
      .filter((f) => f && f.family === family)
      .map((f) => cleanReason(f.reason))
      .find(Boolean) || "";
  const table = variant === 2 ? SECOND : FIRST;
  const wording = table[family] || FIRST.record;
  return reason ? wording.failed(reason) : wording.plain;
}

/** 工具名 → family；未知工具返回 null（不参与对账）。 */
export function familyOfTool(tool: string): Family | null {
  const name = String(tool || "");
  if (!name) return null;
  if (name.startsWith("schedule_")) return "schedule";
  if (name === "records_write" || name === "records_read") return "record";
  if (name === "request_feature" || name === "feature_request") return "feature";
  if (name === "prepare_project_task" || name === "create_file_task") return "task";
  if (name.startsWith("skill_")) return "skill";
  if (name === "run_task" || name === "queue_task" || name === "job_start") return "job";
  return null;
}

// 逐句扫描：。！？!?；; 和换行都是句子边界，替换只动命中句。
const SENTENCE_SOURCE = "[^。！？!?；;\\n]+[。！？!?；;\\n]?";

// 旧 promiseGuard 的整句模式（节奏词 + 钟点 + 发/推/出），保留为 schedule 的补充触发：
// 真实回复常写「口径定这样：每天 8:00 推…」，不含冻结表里的承诺词，但仍是承诺。
const RECURRING_RE = /每\s*(?:天|日|早|晚|个?\s*(?:周|星期|礼拜))/;
const CLOCK_RE = /(?:\d{1,2}\s*[:：]\s*\d{2}|\d{1,2}\s*[点时])/;
const PUSH_VERB_RE = /(?:发|推|出)/;
const PROMISE_WORD_RE = /(?:我会|我就|记下了|已经(?:设|定|建|安排)|安排好了|设好了|定好了)/;
const OPEN_ITEM_RE = /(?:未闭环|待确认|还没答复|要我(?:记|设|建|帮|每))/;
const QUESTION_TAIL_RE = /(?:吗|呢|要不要|好不好|行不行|可以吗)[？?。]?\s*$/;

function askingForConsent(sentence: string) {
  const tail = (sentence.split(/[，,：:]/).pop() || "").trim();
  return /[？?]\s*$/.test(sentence) || QUESTION_TAIL_RE.test(tail);
}

function legacySchedulePromise(sentence: string) {
  if (OPEN_ITEM_RE.test(sentence) || (!PROMISE_WORD_RE.test(sentence) && askingForConsent(sentence)))
    return false;
  return RECURRING_RE.test(sentence) && CLOCK_RE.test(sentence) && PUSH_VERB_RE.test(sentence);
}

// design 的冻结表漏了「已记：…」这种省略「上/账」的说法；模型真的会这样编记录号。
const RECORD_SHORT_RE = /已记(?=[：:，,。]|$)/;

function familiesFor(sentence: string): Family[] {
  const hits: Family[] = [];
  for (const claim of CLAIMS) if (claim.re.test(sentence)) hits.push(claim.family);
  if (!hits.includes("record") && RECORD_SHORT_RE.test(sentence)) hits.push("record");
  if (!hits.includes("schedule") && legacySchedulePromise(sentence)) hits.unshift("schedule");
  return hits;
}

// ② 只豁免陈述既有事实的句子；「以后每天都会发」仍是承诺。
const EXISTING_RE = /(已经|已|早就|之前|原来)/;
const FUTURE_RE = /(以后|从今|接下来|往后|我会|会每|每(天|周|月).{0,12}(都|准|会)发)/;

function isExistingStatement(sentence: string) {
  return EXISTING_RE.test(sentence) && !FUTURE_RE.test(sentence);
}

// autoLand 成功时由调用方在运行时附带「下次 …」文本；不动冻结的 Accepted 接口。
type LandedAccepted = Accepted & { next_run_text?: string };

function appendLanded(sentence: string, landed: LandedAccepted) {
  const id = landed.id ? String(landed.id) : "";
  if (!id) return sentence;
  const next = typeof landed.next_run_text === "string" ? landed.next_run_text.trim() : "";
  const note = next ? `（#${id}，下次 ${next}）` : `（#${id}）`;
  const trailing = /[。！？!?；;]\s*$/.exec(sentence);
  if (!trailing) return sentence + note;
  return sentence.slice(0, trailing.index) + note + sentence.slice(trailing.index);
}

function pickFamily(families: Family[], sentence: string, failures: Accepted[]): Family {
  const failed = families.find((family) => failures.some((f) => f && f.family === family));
  if (failed) return failed;
  if (families.length === 1) return families[0];
  // 一句命中多个 family 且都没落地：按句中最明显的线索选措辞，别拿「每天几点」回答记账。
  const clues: { family: Family; re: RegExp }[] = [
    {
      family: "schedule",
      re: /每天|每日|每周|每月|每星期|\d{1,2}\s*[点时]|\d{1,2}\s*[:：]\s*\d{2}/,
    },
    { family: "record", re: /账|清单|金额|￥|¥|\d+\s*元/ },
    { family: "feature", re: /立项|需求|开发|计划/ },
    { family: "task", re: /工作台|任务/ },
    { family: "skill", re: /技能|工具|指令/ },
    { family: "job", re: /执行|跑|排队/ },
  ];
  for (const clue of clues)
    if (families.includes(clue.family) && clue.re.test(sentence)) return clue.family;
  return families[0];
}

export async function guardReceipts(g: GuardInput): Promise<GuardResult> {
  const source = typeof g?.text === "string" ? g.text : "";
  const violations: GuardViolation[] = [];
  if (!source || source.trim() === "[[SILENT]]") return { text: source, violations };

  const accepted = Array.isArray(g.accepted) ? g.accepted : [];
  const failures = Array.isArray(g.failures) ? g.failures.slice() : [];
  const lastBotText = typeof g.lastBotText === "string" ? g.lastBotText : "";
  const used = new Set<string>();

  const sentences: { index: number; sentence: string }[] = [];
  const sentenceRe = new RegExp(SENTENCE_SOURCE, "g");
  for (let m = sentenceRe.exec(source); m; m = sentenceRe.exec(source))
    sentences.push({ index: m.index, sentence: m[0] });
  if (!sentences.length) return { text: source, violations };

  let out = "";
  let cursor = 0;
  for (const { index, sentence } of sentences) {
    out += source.slice(cursor, index);
    cursor = index + sentence.length;

    const families = familiesFor(sentence);
    if (!families.length) {
      out += sentence;
      continue;
    }
    // ① 本轮有同 family 的成功工具结果 → 保留。
    if (accepted.some((a) => a && a.ok === true && families.includes(a.family))) {
      out += sentence;
      continue;
    }

    // ② 状态类陈述：库里已有对应 active 行 → 保留。
    let kept = false;
    if (isExistingStatement(sentence) && typeof g.existing === "function") {
      for (const family of families) {
        let exists = false;
        try {
          exists = await g.existing(family);
        } catch {
          exists = false;
        }
        if (exists) {
          kept = true;
          violations.push({ family, sentence, fixed: "kept" });
          break;
        }
      }
    }
    if (kept) {
      out += sentence;
      continue;
    }

    // ③ schedule 承诺没有落地 → 用原话补建，成功就保留并补 id/下次时间。
    if (families.includes("schedule") && typeof g.autoLand === "function") {
      let landed: LandedAccepted | null = null;
      try {
        landed = await g.autoLand("schedule");
      } catch {
        landed = null;
      }
      if (landed && landed.ok === true) {
        out += appendLanded(sentence, landed);
        violations.push({ family: "schedule", sentence, fixed: "landed" });
        continue;
      }
      if (landed && landed.ok === false && landed.reason)
        failures.push({ ...landed, family: "schedule", ok: false });
    }

    // ④ 换成老实措辞；与上一条/本回复前面的同句重复时用第二套。
    const family = pickFamily(families, sentence, failures);
    const first = honest(family, failures, 1);
    const second = honest(family, failures, 2);
    const repeat = used.has(first) || (!!lastBotText && lastBotText.includes(first));
    const replacement = repeat ? second : first;
    used.add(replacement);
    out += replacement;
    violations.push({ family, sentence, fixed: "replaced" });
  }
  out += source.slice(cursor);
  return { text: out, violations };
}
