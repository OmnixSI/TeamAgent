/** Feature intake stores untrusted descriptions; it never queues a group reply. */
import { loadFrConfig, classifyRisk, clip, sydneyDay, isAutoSender } from "./feature-request-core";
import { FR_PREFIX, type CreateOutcome, type FeatureRequestRow, type FrRiskTag } from "./feature-request-types";
import { redact } from "./runtime";

export function featureRequestEnabled(switches: Record<string, string | undefined>): boolean {
  return switches["off:feature_request"] !== "1" && loadFrConfig().enabled;
}

export interface FeatureRequestInput {
  source: { id: string; group_id: string; sender: string; body: string; meta?: any };
  sender_name: string;
  quote: string;
  title: string;
  detail: string;
  tainted: boolean;
}

function outcome(row: FeatureRequestRow, duplicate: boolean): CreateOutcome {
  const proposal = row.mode === "proposal";
  return {
    ok: true, id: row.id, duplicate, status: row.status, mode: row.mode,
    auto: row.auto === 1, risk_tags: JSON.parse(row.risk_tags) as FrRiskTag[],
    say: duplicate ? "这条之前已记过，不要再回复。"
      : row.status === "queued" ? "已立项，只回一句：收到，已记下，做好了告诉你。"
      : proposal ? "已记下，这类需求只出方案，需要管理员确认。只回一句说明这一点，不要复述细节。"
      : "已记下，但需要管理员先确认才会做。只回一句说明这一点。",
  };
}

const COUNTS = `SELECT
  (SELECT COUNT(*) FROM feature_request WHERE group_id=? AND day=?) AS g,
  (SELECT COUNT(*) FROM feature_request WHERE sender=? AND day=?) AS s,
  (SELECT COUNT(*) FROM feature_request WHERE day=? AND auto=1 AND status<>'needs_human') AS a`;

export async function createRequest(e: any, input: FeatureRequestInput, options: { now?: number } = {}): Promise<CreateOutcome> {
  const cfg = loadFrConfig();
  if (!cfg.enabled) return { ok: false, reason: "disabled", say: "功能需求记录已关闭。" };
  const quote = clip(redact(String(input.quote ?? "")), cfg.quote_max);
  const title = clip(redact(String(input.title ?? "")), cfg.title_max);
  const detail = clip(redact(String(input.detail ?? "")), cfg.detail_max);
  const source = input.source;
  if (!quote || !title || !source?.id || !source.group_id || !source.sender)
    return { ok: false, reason: "invalid", say: "需要成员的原话和需求标题。" };
  const id = FR_PREFIX + source.id;
  const existing = () => e.DB.prepare("SELECT * FROM feature_request WHERE id=?").bind(id).first() as Promise<FeatureRequestRow | null>;
  const prior = await existing();
  if (prior) return outcome(prior, true);
  const now = options.now ?? Date.now(), day = sydneyDay(now);
  const quotaArgs = [source.group_id, day, source.sender, day, day];
  const capped = (counts: { g: number; s: number }): CreateOutcome | null =>
    counts.g >= cfg.group_daily_cap ? { ok: false, reason: "group_cap", say: "今天记的需求太多了，只回一句让对方明天再提。" }
      : counts.s >= cfg.daily_cap_per_sender ? { ok: false, reason: "sender_cap", say: "你今天记的需求太多了，只回一句让对方明天再提。" } : null;
  const counts = await e.DB.prepare(COUNTS).bind(...quotaArgs).first();
  const limit = capped(counts);
  if (limit) {
    // Another intake of this message may have filled the final slot since our
    // first id lookup. Duplicate receipts take precedence over quota rejection.
    const concurrent = await existing();
    return concurrent ? outcome(concurrent, true) : limit;
  }
  const tags = classifyRisk(quote + " " + title + " " + detail);
  if (input.tainted && !tags.includes("injection")) tags.push("injection");
  const mode = tags.length ? "proposal" : "build";
  const owner = await isAutoSender(e, source.sender, cfg), eligible = owner && mode === "build";
  const reason = tags.includes("injection") ? "injection" : tags.length ? "sensitive:" + tags.join(",") : "not_owner";
  // Repeat quota checks inside the INSERT: interleaved requests cannot cross a
  // hard cap, and the sixth auto request is demoted in the same atomic statement.
  const inserted = await e.DB.prepare(`WITH quotas AS (${COUNTS}),
    decision AS (SELECT CASE WHEN ?=1 AND a<? THEN 1 ELSE 0 END AS auto FROM quotas)
    INSERT OR IGNORE INTO feature_request
      (id,group_id,msg_id,sender,sender_name,quote,title,detail,mode,risk_tags,auto,status,status_reason,version,day,attempts,created_at,updated_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,decision.auto,
      CASE WHEN decision.auto=1 THEN 'queued' ELSE 'needs_human' END,
      CASE WHEN decision.auto=1 THEN 'queued' WHEN ?=1 THEN 'daily_auto_cap' ELSE ? END,
      0,?,0,?,? FROM decision,quotas WHERE g<? AND s<?`)
    .bind(...quotaArgs, eligible ? 1 : 0, cfg.daily_auto_cap,
      id, source.group_id, source.id, source.sender, clip(redact(String(input.sender_name ?? "")), 80),
      quote, title, detail, mode, JSON.stringify(tags), eligible ? 1 : 0, reason,
      day, now, now, cfg.group_daily_cap, cfg.daily_cap_per_sender).run();
  const stored = await existing();
  if (stored) return outcome(stored, Number(inserted.meta?.changes ?? inserted.changes) === 0);
  // A concurrent request may have used the last quota slot after the first read.
  const racedLimit = capped(await e.DB.prepare(COUNTS).bind(...quotaArgs).first());
  if (racedLimit) return racedLimit;
  throw new Error("Feature request insert did not persist");
}
