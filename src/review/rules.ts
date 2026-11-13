import { metered } from '../d1';
import { quoteIn, metaOf } from '../view';
import type { Evidence, JudgeRequirement } from './types';
import { reviewBatch, reviewRead, type ReviewEnv, type ReviewStatement } from './db';

export type RuleRun = { id: string; group_id: string; now?: number };
export type BehaviorRule = { id: string; group_id: string; rule: string; scene: string; evidence_json: string; source: string; status: string; canary_until: number | null; expires_at: number; supersedes_id: string | null; hits: number; corrections: number; rollback_reason: string | null; created_at: number; updated_at: number };
export const DENY_WORDS = ['权限','授权','token','密钥','开关','部署','上线','关闭','删除','管理员'] as const;
const DAY = 86400000;
const text = (s: string, limit: number) => Array.from(s).slice(0, limit).join('');
const safeRule = (s: string) => {
  const normalized = s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu,'').toLowerCase();
  return !DENY_WORDS.some(word => normalized.includes(word));
};
const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s); } catch { return fallback; } };
const time = (run: RuleRun) => run.now ?? Date.now();
function freezeSurplus(group: string, now: number): ReviewStatement {
  return {sql:`UPDATE behavior_rules SET status='frozen',updated_at=? WHERE group_id=? AND status IN ('canary','active') AND id NOT IN
    (SELECT id FROM behavior_rules WHERE group_id=? AND status IN ('canary','active') AND expires_at>? ORDER BY hits DESC,updated_at DESC,id LIMIT 5)`,params:[now,group,group,now]};
}
async function stableId(parts: string[]) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return 'rule-' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
}

type Source = { id: string; body: string; sender: string; ts: string; metadata: string | null };
async function sources(e: ReviewEnv, group: string, ids: string[]): Promise<Map<string, Source>> {
  if (!ids.length) return new Map();
  const rows = await reviewRead<Source>(e, `SELECT m.id,m.body,m.sender,m.ts,mm.json AS metadata FROM messages m
    JOIN members member ON member.id=m.sender AND member.revoked=0
    LEFT JOIN message_meta mm ON mm.id=m.id
    WHERE m.group_id=? AND m.id IN (SELECT value FROM json_each(?))`, [group, JSON.stringify([...new Set(ids)])]);
  return new Map(rows.map(row => [row.id,row]));
}
function ownQuote(row: Source | undefined, evidence: Evidence): row is Source {
  if (!row || evidence.source !== 'message' || typeof evidence.quote !== 'string' || !evidence.quote.trim()) return false;
  const meta = metaOf(row);
  if (meta.quoted || meta.forwarded?.length || meta.cardView) return false;
  // Source body must authorize learning; displayed quotations/code are material.
  const own = row.body.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|^\s*>.*$/gm, '');
  return own.includes(evidence.quote) && quoteIn(row,evidence.quote);
}

/** Free-text requirements remain candidates until a reviewed bounded behavior contract exists. */
export async function applyRequirements(e: ReviewEnv, run: RuleRun, reqs: JudgeRequirement[]): Promise<string[]> {
  const ctx = metered(e), now = time(run);
  const candidates = reqs.filter(r => typeof r.rule === 'string' && !!r.rule.trim() && safeRule(r.rule) && typeof r.scene === 'string' && !!r.scene.trim() && Number.isFinite(r.ttl_days) && r.ttl_days > 0 && Array.isArray(r.evidence));
  const messages = await sources(ctx,run.group_id,candidates.flatMap(r => r.evidence.filter(v => v.source === 'message').map(v => v.id)));
  const statements: ReviewStatement[] = [], ids: string[] = [];
  for (const req of candidates) {
    if (!req.evidence.some(ev => ownQuote(messages.get(ev.id),ev))) continue;
    const rule = text(req.rule.trim(),80), scene = text(req.scene.trim(),120);
    const id = await stableId([run.group_id,scene,rule,...req.evidence.filter(ev => ownQuote(messages.get(ev.id),ev)).map(ev => ev.id).sort()]);
    if (ids.includes(id)) continue;
    ids.push(id);
    statements.push({ sql: `INSERT OR IGNORE INTO behavior_rules(id,group_id,rule,scene,evidence_json,source,status,canary_until,expires_at,supersedes_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?,'candidate',NULL,?,(SELECT id FROM behavior_rules WHERE group_id=? AND scene=? AND status IN ('canary','active') ORDER BY updated_at DESC,id LIMIT 1),?,?)`,
      params: [id,run.group_id,rule,scene,JSON.stringify(req.evidence),'review:'+run.id,now + Math.min(30,req.ttl_days)*DAY,run.group_id,scene,now,now] });
  }
  if (statements.length) statements.push(freezeSurplus(run.group_id,now));
  await reviewBatch(ctx,statements);
  return ids;
}

/** A correction needs an exact rule reference in a bound member's original message. */
function isCorrection(row: Source | undefined, ev: Evidence, rule: BehaviorRule, now: number): boolean {
  if (!row || ev.source !== 'message' || !ev.quote?.trim() || !quoteIn(row,ev.quote)) return false;
  const at = Date.parse(row.ts);
  if (!Number.isFinite(at) || at < rule.created_at || at > now) return false;
  const meta = metaOf(row);
  if (meta.quoted || meta.forwarded?.length || meta.cardView || /```/.test(row.body)) return false;
  const own = row.body.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|^\s*>.*$/gm,'');
  return /纠正|不要|别再|不再|改成|错了|不对/.test(own) && (ev.quote.includes(rule.rule) || ev.quote.includes(rule.id)) && /纠正|不要|别再|不再|改成|错了|不对/.test(ev.quote);
}

export async function advanceRules(e: ReviewEnv, run: RuleRun): Promise<void> {
  const ctx = metered(e), now = time(run);
  const rules = await reviewRead<BehaviorRule>(ctx,"SELECT * FROM behavior_rules WHERE group_id=? AND status IN ('candidate','canary','active','frozen')",[run.group_id]);
  const findings = await reviewRead<{ evidence_json: string }>(ctx,"SELECT evidence_json FROM review_findings WHERE run_id=? AND status NOT IN ('rejected','wontfix')",[run.id]);
  const evidence = findings.flatMap(f => parse<Evidence[]>(f.evidence_json,[])).filter(ev => ev?.source === 'message' && typeof ev.id === 'string');
  const messages = await sources(ctx,run.group_id,evidence.map(ev=>ev.id));
  evidence.sort((a,b) => (Date.parse(messages.get(a.id)?.ts || '') || 0) - (Date.parse(messages.get(b.id)?.ts || '') || 0));
  const past = await reviewRead<{id:string}>(ctx,`SELECT id FROM activity WHERE kind='review_rule_correction' AND entity IN (SELECT value FROM json_each(?))`,[JSON.stringify(rules.map(r=>r.id))]);
  const previous = new Set(past.map(row=>row.id));
  const statements: ReviewStatement[] = [];
  for (const rule of rules) {
    if (!['canary','active'].includes(rule.status) || rule.expires_at <= now) continue;
    const consumed = new Set<string>();
    let corrections = rule.corrections;
    for (const ev of evidence) {
      if (consumed.has(ev.id) || !isCorrection(messages.get(ev.id),ev,rule,now)) continue;
      consumed.add(ev.id);
      const event = 'review-correction:' + rule.id + ':' + ev.id;
      if (previous.has(event)) continue;
      const duringTrial = Date.parse(messages.get(ev.id)!.ts) < (rule.canary_until ?? 0);
      corrections++;
      // D1 batch transaction couples the counter and unique consumption event.
      statements.push({ sql: `UPDATE behavior_rules SET corrections=corrections+1,
        status=CASE WHEN (?<canary_until) OR corrections+1>=2 THEN 'retired' ELSE status END,
        rollback_reason=CASE WHEN (?<canary_until) OR corrections+1>=2 THEN 'member correction' ELSE rollback_reason END,
        updated_at=? WHERE id=? AND status IN ('canary','active')
        AND NOT EXISTS(SELECT 1 FROM activity WHERE id=?)`, params:[Date.parse(messages.get(ev.id)!.ts),Date.parse(messages.get(ev.id)!.ts),now,rule.id,event] });
      statements.push({ sql: `INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) VALUES(?,'review_rule_correction',?,'review',?,?)`,params:[event,rule.id,ev.id,new Date(now).toISOString()] });
      if (duringTrial || corrections >= 2) break;
    }
  }
  statements.push({sql:`UPDATE behavior_rules SET status='retired',rollback_reason=CASE WHEN expires_at<=? THEN 'expired' ELSE 'member correction' END,updated_at=?
    WHERE group_id=? AND status IN ('candidate','canary','active','frozen') AND (expires_at<=? OR (status='active' AND corrections>=2))`, params:[now,now,run.group_id,now]});
  statements.push({sql:`UPDATE behavior_rules SET status='active',updated_at=? WHERE group_id=? AND status='canary' AND canary_until<=? AND expires_at>?`,params:[now,run.group_id,now,now]});
  statements.push(freezeSurplus(run.group_id,now));
  await reviewBatch(ctx,statements);
}

/** Caller authenticates who and group scope before invoking this internal mutation. */
export async function revokeRule(e: ReviewEnv, id: string, who: string, reason: string): Promise<boolean> {
  if (!who.trim() || !reason.trim()) throw new Error('review rule revocation requires actor and reason');
  const ctx = metered(e), now = Date.now(), summary = text(reason.trim(),300);
  const rows = await reviewRead<BehaviorRule>(ctx,'SELECT * FROM behavior_rules WHERE id=?',[id]);
  if (!rows.length) return false;
  await reviewBatch(ctx,[
    {sql:`INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) SELECT ?,'review_rule_revoked',id,?,?,? FROM behavior_rules WHERE id=? AND status!='retired'`,params:['review-revoke:'+id,who,summary,new Date(now).toISOString(),id]},
    {sql:"UPDATE behavior_rules SET status='retired',rollback_reason=?,updated_at=? WHERE id=? AND status!='retired'",params:[summary,now,id]},
  ]);
  return true;
}

/** Shared daytime reader: no model or side effects; at most five 80-character rules. */
export async function activeRulesFor(e: ReviewEnv, groupId: string, now = Date.now()): Promise<BehaviorRule[]> {
  const rows = await reviewRead<BehaviorRule>(e,`SELECT * FROM behavior_rules WHERE group_id=? AND status IN ('canary','active') AND expires_at>? ORDER BY updated_at DESC,id LIMIT 5`,[groupId,now]);
  return rows.map(row=>({...row,rule:text(row.rule,80)}));
}
