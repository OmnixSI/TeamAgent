import { isOn } from "./rhythm";

export function decideQuote(x: { target?: string; latestId: string; batch: any[]; mentioned: boolean; groupNewestId: string }): string | null {
  const target = x.target && x.batch.some(r => r.id === x.target) ? x.target
    : x.mentioned ? x.batch.filter(r => r.mentioned).at(-1)?.id : null;
  if (!target) return null;
  const senders = new Set(x.batch.map(r => r.sender)).size;
  return target === x.groupNewestId && senders <= 1 ? null : target;
}
export async function quoteRef(e: any, decision: any, context: any, switches: Record<string, string | undefined>): Promise<string | undefined> {
  if (!isOn(switches, "quote")) return undefined;
  const target = decideQuote({ target: decision.target, latestId: context.latest.id, batch: context.batch, mentioned: !!context.mentioned, groupNewestId: context.groupNewestId });
  if (!target) return undefined;
  const row = await e.DB.prepare("SELECT ref_idx FROM message_refs WHERE kind='member' AND target_id=? AND group_id=? AND created_at>? ORDER BY created_at DESC LIMIT 1")
    .bind(target, context.latest.group_id,Date.now()-24*60*60*1000).first();
  return row?.ref_idx;
}
export function quoteOutcome(httpStatus: number, result: any): "ok" | "maybe_ref" | "other" {
  if (httpStatus >= 200 && httpStatus < 300 && (result?.id || result?.code === 0)) return "ok";
  return (httpStatus === 400 || httpStatus === 422) && result !== undefined ? "maybe_ref" : "other";
}
