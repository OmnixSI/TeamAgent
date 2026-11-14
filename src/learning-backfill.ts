// V-D-learning · L8：owner-only 回填提案接口。
// 只把漏记的要求写成 review_learnings(status='proposed', run_id='backfill')，由第二天的晨报
// 问本人；这里不直接写 behavior_rules 或 schedules。requester 始终取原话发送者，
// 不信任调用方另填；params 先过 L3 的 renderRule（规则）或 L1 的 planSchedule（日程）。
import { learningId } from "./learning-types";
import { renderRule } from "./review/rules";
import { planSchedule } from "./schedules";

const MAX_PLAIN = 200;
const MAX_QUOTE = 500;

export class BackfillError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackfillError";
    this.status = status;
  }
}

type Params = Record<string, unknown>;
const isParams = (value: unknown): value is Params =>
  !!value && typeof value === "object" && !Array.isArray(value);

function sortParams(params: Params): Params {
  return Object.fromEntries(Object.keys(params).sort().map((key) => [key, params[key]]));
}

/** 同一提案跨次重放要得到同一 id：去空白、统一小写、参数按键排序。 */
function normKey(plain: string, params: Params): string {
  return `${plain.trim().replace(/\s+/g, " ").toLowerCase()}|${JSON.stringify(sortParams(params))}`;
}

/** 只把 L5 会用到的字段存进 params；未知字段不落库。 */
function canonicalParams(kind: string, params: Params): Params {
  if (kind !== "schedule") return sortParams(params);
  const out: Params = { time: params.time };
  if (Array.isArray(params.weekdays)) out.weekdays = params.weekdays;
  if (params.topic != null) out.topic = params.topic;
  if (params.dedup != null) out.dedup = params.dedup;
  return out;
}

export type BackfillLearningInput = {
  source_msg_id?: unknown;
  kind?: unknown;
  subkind?: unknown;
  params?: unknown;
  plain?: unknown;
  dry_run?: unknown;
};

/**
 * 写入一条「待晨报询问」的提案。返回的 learning 是提案口径，不是已生效的规则/日程：
 * status 永远是 proposed，run_id 永远是 backfill。
 */
export async function proposeLearning(e: any, body: BackfillLearningInput, now = Date.now()) {
  const sourceId = String(body?.source_msg_id ?? "").trim();
  if (!sourceId) throw new BackfillError(400, "source_msg_id required");
  const source = await e.DB.prepare(
    "SELECT id,group_id,sender,body,ts FROM messages WHERE id=?",
  )
    .bind(sourceId)
    .first();
  if (!source) throw new BackfillError(404, "source message not found");

  const kind = String(body?.kind ?? "").trim();
  if (!["rule", "schedule"].includes(kind))
    throw new BackfillError(400, "kind must be rule or schedule");
  const subkind = String(body?.subkind ?? "").trim();
  if (!subkind) throw new BackfillError(400, "subkind required");
  const plain = String(body?.plain ?? "").trim();
  if (!plain || Array.from(plain).length > MAX_PLAIN)
    throw new BackfillError(400, "plain 要 1–200 个字");
  if (!isParams(body?.params)) throw new BackfillError(400, "params 必须是对象");
  const params = canonicalParams(kind, body.params);

  if (kind === "rule") {
    // renderRule 同时做模板、deny-list 和 address_as 本人校验；null 一律拒绝。
    if (!renderRule(subkind as any, params as any, plain, 30, source.sender))
      throw new BackfillError(400, "规则参数没有通过 L3 校验");
  } else {
    if (!["daily", "weekly"].includes(subkind))
      throw new BackfillError(400, "日程只能是 daily 或 weekly");
    const spec: any = { time: params.time, origin: "review" };
    if (subkind === "weekly") spec.weekdays = params.weekdays ?? [0];
    if (params.topic != null) spec.topic = params.topic;
    if (params.dedup != null) spec.dedup = params.dedup;
    try {
      planSchedule(
        {
          group_id: source.group_id,
          owner: source.sender,
          kind: subkind === "weekly" ? "digest_weekly" : "digest_daily",
          spec,
          source_msg_id: source.id,
        },
        now,
      );
    } catch (error: any) {
      throw new BackfillError(400, String(error?.message || error));
    }
  }

  const id = await learningId(source.group_id, kind, subkind, normKey(plain, params));
  const existing = await e.DB.prepare("SELECT * FROM review_learnings WHERE id=?").bind(id).first();
  const quote = String(source.body ?? "").slice(0, MAX_QUOTE);
  const learning = {
    id,
    group_id: source.group_id,
    kind,
    subkind,
    params: JSON.stringify(params),
    plain,
    requester: source.sender,
    source_msg_id: source.id,
    quote,
    run_id: "backfill",
    status: "proposed",
  };
  if (body?.dry_run)
    return {
      ok: true,
      dry_run: true,
      would_write: !existing,
      duplicate: !!existing,
      learning,
    };
  if (!existing) {
    await e.DB.prepare(
      `INSERT OR IGNORE INTO review_learnings(id,group_id,kind,subkind,params,plain,requester,source_msg_id,quote,run_id,agreement,status,ask_count,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,'single','proposed',0,?,?)`,
    )
      .bind(id, source.group_id, kind, subkind, JSON.stringify(params), plain, source.sender, source.id, quote, "backfill", now, now)
      .run();
  }
  const saved = await e.DB.prepare("SELECT * FROM review_learnings WHERE id=?").bind(id).first();
  return {
    ok: true,
    dry_run: false,
    would_write: false,
    inserted: !existing,
    learning: {
      ...learning,
      created_at: saved?.created_at ?? now,
      updated_at: saved?.updated_at ?? now,
    },
  };
}
