import { metered } from '../d1';
import { quoteIn, metaOf } from '../view';
import { RULE_KINDS, type Evidence, type JudgeRequirement, type RuleKind, type Agreement } from './types';
import { DENY_WORDS } from './constants';
import { reviewBatch, reviewRead, reviewSources, reviewOwnClauses, reviewDirectQuote, reviewRedact, type ReviewSource, type ReviewEnv, type ReviewStatement } from './db';
export { DENY_WORDS } from './constants';

export type RuleRun = { id: string; group_id: string; now?: number };
export type BehaviorRule = { id: string; group_id: string; rule: string; scene: string; kind:RuleKind; params:string; approved_by:string|null; evidence_json: string; source: string; status: string; canary_until: number | null; expires_at: number; supersedes_id: string | null; hits: number; corrections: number; rollback_reason: string | null; created_at: number; updated_at: number };
const DAY = 86400000;
const text = (s: string, limit: number) => Array.from(s).slice(0, limit).join('');
const safeRule = (s: string) => {
  const normalized = s.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu,'').toLowerCase();
  return reviewRedact(s)===s && !DENY_WORDS.some(word => normalized.includes(word));
};
const parse = <T>(s: string, fallback: T): T => { try { return JSON.parse(s); } catch { return fallback; } };
const evidenceOf = (s:string):Evidence[] => { const v=parse<unknown>(s,[]); return Array.isArray(v)?v:[]; };
const time = (run: RuleRun) => run.now ?? Date.now();
function freezeSurplus(group: string, now: number): ReviewStatement {
  return {sql:`UPDATE behavior_rules SET status='frozen',updated_at=? WHERE group_id=? AND status IN ('canary','active') AND id NOT IN
    (SELECT id FROM behavior_rules WHERE group_id=? AND status IN ('canary','active') AND expires_at>? ORDER BY (SELECT COUNT(*) FROM review_consumed WHERE kind='rule_hit' AND subject=behavior_rules.id) DESC,updated_at DESC,id LIMIT 5)`,params:[now,group,group,now]};
}
function freezePredecessor(id:string,now:number):ReviewStatement {
  return {sql:`UPDATE behavior_rules SET status='frozen',updated_at=? WHERE id=(SELECT supersedes_id FROM behavior_rules WHERE id=? AND status='canary') AND status IN ('canary','active')`,params:[now,id]};
}
async function stableId(parts: string[]) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)));
  return 'rule-' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('');
}
const addressed = (row:ReviewSource) => row.mentioned===1 || metaOf(row).replyTo?.kind==='bot' || metaOf(row).mentionsBot===true || /^@?(?:bot|群助手|机器人|搭子)(?:\s|[，,:：]|$)/i.test(row.body.trim());
function sourceProof(row:ReviewSource):ReviewStatement {
  return {sql:`EXISTS(SELECT 1 FROM messages m WHERE m.id=? AND m.group_id=? AND m.sender=? AND m.body=? AND m.mentioned=?
    AND COALESCE((SELECT json FROM message_meta WHERE id=m.id),'')=?
    AND EXISTS(SELECT 1 FROM members WHERE id IN (m.sender,'qq:'||m.sender) AND revoked=0))`,
    params:[row.id,row.group_id,row.sender,row.body,row.mentioned,row.metadata||'']};
}
const requested = (clause:string) => /^(?:(?:你|麻烦|帮我|帮忙|能不能|可以|能|这次|接下来|现在|再|先)\s*)*(?:以后|下次|别|不要|请|少|多|只|收敛|简短|每天|每周|每早|每晚|定时|按时)/.test(clause);
/** 「qq:123」与「123」是同一个群友；称呼规则只比人，不比前缀。 */
const normMember = (v:string) => String(v ?? '').trim().toLowerCase().replace(/^qq:/,'');
function admitted(row:ReviewSource|undefined,ev:Evidence):row is ReviewSource {
  return reviewDirectQuote(row,ev) && addressed(row) && reviewOwnClauses(row.body).some(clause=>clause.includes(ev.quote) && requested(clause));
}
/** Only these bounded parameters enter templates; unknown properties fail closed. */
export function renderRule(kind:RuleKind,params:Record<string,string|number>,free:string,ttl:number,requester?:string):string|null {
  if (!RULE_KINDS.includes(kind) || !params || typeof params!=='object' || Array.isArray(params) || !Number.isFinite(ttl) || ttl<=0 || !safeRule(JSON.stringify(params)) || !safeRule(free)) return null;
  const keys=Object.keys(params);
  if (kind==='avoid_phrase') {
    const phrase=params.phrase;
    if (keys.length!==1 || keys[0]!=='phrase' || typeof phrase!=='string') return null;
    const value=phrase.trim(), size=Array.from(value).length;
    if (size<1 || size>12 || /[「」\r\n]/u.test(value)) return null;
    return `不要再说「${value}」。`;
  }
  if (kind==='address_as') {
    const member=params.member, name=params.name;
    if (keys.length!==2 || !keys.includes('member') || !keys.includes('name') ||
      typeof member!=='string' || typeof name!=='string') return null;
    const who=member.trim(), label=name.trim(), whoSize=Array.from(who).length, labelSize=Array.from(label).length;
    if (whoSize<1 || whoSize>40 || labelSize<1 || labelSize>10 || /[「」\r\n]/u.test(who) || /[「」\r\n]/u.test(label)) return null;
    // 只能自己定自己的称呼：给了原话发送者就必须相等（qq: 前缀归一）。
    if (requester!==undefined && normMember(who)!==normMember(requester)) return null;
    return `称呼${who}为「${label}」。`;
  }
  if (kind==='free') return keys.length===0 && !!free.trim()?text(free.trim(),80):null;
  const key=kind==='mention_only_window'?'minutes':kind==='language'?'language':kind==='format_pref'?'format':'max';
  if (keys.length!==1 || keys[0]!==key) return null;
  const value=params[key];
  if (kind==='reply_max_chars' && Number.isInteger(value) && Number(value)>=80 && Number(value)<=2000) return `回复最多${value}字。`;
  if (kind==='burst_max' && Number.isInteger(value) && Number(value)>=1 && Number(value)<=4) return `每次连续回复最多${value}条。`;
  if (kind==='mention_only_window' && Number.isInteger(value) && Number(value)>=30 && Number(value)<=120 && ttl<=1) return `未来${value}分钟仅在被点名时回复。`;
  if (kind==='language' && (value==='zh'||value==='en')) return value==='zh'?'使用中文回复。':'使用英文回复。';
  if (kind==='format_pref' && ['plain','list','table'].includes(String(value))) return ({plain:'优先使用普通段落回复。',list:'优先使用列表回复。',table:'优先使用表格回复。'} as Record<string,string>)[String(value)];
  return null;
}

const AVOID_PHRASE_WINDOW_MS = 7*DAY;
/** L3：avoid_phrase 的额外准入。短语必须逐字出现在本群最近 7 天的 bot outbox 里（程序查，不信模型）。 */
export function avoidPhraseProof(groupId:string,phrase:string,now:number):ReviewStatement {
  return {sql:`EXISTS(SELECT 1 FROM outbox WHERE group_id=? AND instr(body,?)>0 AND created_at>=?)`,params:[groupId,phrase,now-AVOID_PHRASE_WINDOW_MS]};
}
export async function phraseInOutbox(e:ReviewEnv,groupId:string,phrase:string,now=Date.now()):Promise<boolean> {
  const rows=await reviewRead<{ok:number}>(metered(e),`SELECT EXISTS(SELECT 1 FROM outbox WHERE group_id=? AND instr(body,?)>0 AND created_at>=?) ok`,[groupId,phrase,now-AVOID_PHRASE_WINDOW_MS]);
  return rows[0]?.ok===1;
}

/** Revalidate original provenance; only typed rules with matching dual agreement auto-enter trial. */
export async function applyRequirements(e: ReviewEnv, run: RuleRun, reqs: JudgeRequirement[]): Promise<string[]> {
  const ctx = metered(e), now = time(run);
  const candidates=reqs.filter(r=>r && Array.isArray(r.evidence) && typeof r.scene==='string' && !!r.scene.trim() && safeRule(r.scene) && typeof r.rule==='string' && !!renderRule(r.kind,r.params,r.rule,r.ttl_days));
  const messages=await reviewSources(ctx,run.group_id,candidates.flatMap(r=>r.evidence.filter(v=>v?.source==='message').map(v=>v.id)));
  const findings= candidates.length ? await reviewRead<{id:string;agreement:Agreement;status:string;evidence_json:string}>(ctx,'SELECT id,agreement,status,evidence_json FROM review_findings WHERE run_id=?',[run.id]) : [];
  const statements:ReviewStatement[]=[],ids:string[]=[];
  for(const req of candidates) {
    const direct=req.evidence.filter(ev=>ev && admitted(messages.get(ev.id),ev));
    if(!direct.length) continue;
    const relevant=findings.filter(f=>evidenceOf(f.evidence_json).some(ev=>direct.some(source=>ev?.source==='message' && ev.id===source.id && typeof ev.quote==='string' && Array.from(ev.quote.trim()).length>=4 && quoteIn(messages.get(source.id)!,ev.quote))));
    if(relevant.some(f=>f.agreement==='disagree'||f.status==='disputed'||f.status==='rejected'||f.status==='wontfix')) continue;
    const canary=req.kind!=='free' && relevant.length>0 && relevant.every(f=>f.agreement==='agree');
    const source=messages.get(direct[0].id)!;
    if(req.kind==='address_as' && normMember(String(req.params.member))!==normMember(source.sender)) continue;
    const rule=renderRule(req.kind,req.params,req.rule,req.ttl_days,source.sender)!, scene=text(req.scene.trim(),120);
    const guards=[sourceProof(source)];
    if(req.kind==='avoid_phrase') guards.push(avoidPhraseProof(run.group_id,String(req.params.phrase),now));
    const guard=guards.map(g=>`(${g.sql})`).join(' AND '), guardParams=guards.flatMap(g=>g.params!);
    const expires=now+Math.min(30*DAY,req.ttl_days*DAY,req.kind==='mention_only_window'?Number(req.params.minutes)*60000:Infinity);
    const params=JSON.stringify(req.params), sourceIds=[...new Set(direct.map(ev=>ev.id))].sort();
    const id=await stableId([run.group_id,scene,req.kind,params,rule,...sourceIds]);
    if(ids.includes(id)) continue;
    ids.push(id);
    statements.push({sql:`INSERT OR IGNORE INTO behavior_rules(id,group_id,rule,scene,kind,params,evidence_json,source,status,canary_until,expires_at,supersedes_id,created_at,updated_at)
      SELECT ?,?,?,?,?,?,?,?,'candidate',NULL,?,(SELECT id FROM behavior_rules WHERE group_id=? AND scene=? AND status IN ('canary','active') ORDER BY updated_at DESC,id LIMIT 1),?,? WHERE ${guard}`,
      params:[id,run.group_id,rule,scene,req.kind,params,JSON.stringify(direct),'review:'+run.id,expires,run.group_id,scene,now,now,...guardParams]});
    if(canary) {
      statements.push({sql:`UPDATE behavior_rules SET status='canary',canary_until=?,updated_at=? WHERE id=? AND status='candidate' AND expires_at>?
        AND ${guard} AND NOT EXISTS(SELECT 1 FROM review_findings WHERE id IN (SELECT value FROM json_each(?)) AND (agreement!='agree' OR status IN ('disputed','rejected','wontfix')))`,params:[now+3*DAY,now,id,now,...guardParams,JSON.stringify(relevant.map(f=>f.id))]});
      statements.push(freezePredecessor(id,now));
    }
  }
  if(statements.length) statements.push(freezeSurplus(run.group_id,now));
  await reviewBatch(ctx,statements);
  if(!ids.length) return [];
  const saved=await reviewRead<{id:string}>(ctx,'SELECT id FROM behavior_rules WHERE id IN (SELECT value FROM json_each(?))',[JSON.stringify(ids)]);
  const present=new Set(saved.map(row=>row.id));
  return ids.filter(id=>present.has(id));
}

/** D-6 authenticates the admin; this operation rechecks candidate integrity and live sources. */
export async function approveRule(e:ReviewEnv,id:string,who:string):Promise<boolean> {
  if(!who.trim()||reviewRedact(who)!==who) throw new Error('review rule approval requires actor');
  const ctx=metered(e),now=Date.now();
  const [row]=await reviewRead<BehaviorRule>(ctx,'SELECT * FROM behavior_rules WHERE id=?',[id]);
  if(!row) return false;
  if(row.status!=='candidate') return ['canary','active'].includes(row.status);
  if(row.expires_at<=now || !safeRule(row.rule) || !safeRule(row.scene)) return false;
  const params=parse<Record<string,string|number>>(row.params,{}),evs=evidenceOf(row.evidence_json);
  const sources=await reviewSources(ctx,row.group_id,evs.map(ev=>ev.id));
  const evidence=evs.find(ev=>admitted(sources.get(ev.id),ev));
  if(!evidence) return false;
  const source=sources.get(evidence.id)!;
  const rendered=renderRule(row.kind,params,row.rule,(row.expires_at-row.created_at)/DAY,source.sender);
  if(!rendered || rendered!==row.rule) return false;
  const guards=[sourceProof(source)];
  if(row.kind==='avoid_phrase') guards.push(avoidPhraseProof(row.group_id,String(params.phrase),now));
  const guard=guards.map(g=>`(${g.sql})`).join(' AND '), guardParams=guards.flatMap(g=>g.params!);
  await reviewBatch(ctx,[
    {sql:`UPDATE behavior_rules SET status='canary',approved_by=?,canary_until=?,updated_at=? WHERE id=? AND status='candidate' AND expires_at>?
      AND evidence_json=? AND rule=? AND kind=? AND params=? AND ${guard}`,params:[who,now+3*DAY,now,id,now,row.evidence_json,row.rule,row.kind,row.params,...guardParams]},
    {sql:`INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) SELECT ?,'review_rule_approved',id,?,'已批准规则试用',? FROM behavior_rules WHERE id=? AND approved_by=?`,params:['review-approve:'+id,who,new Date(now).toISOString(),id,who]},
    freezePredecessor(id,now),freezeSurplus(row.group_id,now),
  ]);
  const [approved]=await reviewRead<BehaviorRule>(ctx,'SELECT status FROM behavior_rules WHERE id=?',[id]);
  return ['canary','active','frozen'].includes(approved?.status);
}

function isCorrection(row:ReviewSource|undefined,ev:Evidence,rule:BehaviorRule,now:number):boolean {
  if(!row || ev.source!=='message' || !ev.quote?.trim() || !quoteIn(row,ev.quote)) return false;
  const at=Date.parse(row.ts),meta=metaOf(row);
  if(!Number.isFinite(at)||at<rule.created_at||at>now||meta.quoted||meta.forwarded?.length||meta.cardView||/```/.test(row.body)) return false;
  const own=reviewOwnClauses(row.body.replace(/^\s*>.*$/gm,'')).join(' ');
  return /纠正|不要|别再|不再|改成|错了|不对/.test(own) && (ev.quote.includes(rule.rule)||ev.quote.includes(rule.id)) && /纠正|不要|别再|不再|改成|错了|不对/.test(ev.quote);
}
export async function advanceRules(e:ReviewEnv,run:RuleRun):Promise<void> {
  const ctx=metered(e),now=time(run);
  const rules=await reviewRead<BehaviorRule>(ctx,"SELECT * FROM behavior_rules WHERE group_id=? AND status IN ('candidate','canary','active','frozen')",[run.group_id]);
  const findings=await reviewRead<{evidence_json:string}>(ctx,"SELECT evidence_json FROM review_findings WHERE run_id=? AND status NOT IN ('rejected','wontfix','disputed')",[run.id]);
  const evidence=findings.flatMap(f=>evidenceOf(f.evidence_json)).filter(ev=>ev?.source==='message' && typeof ev.id==='string');
  const sources=await reviewSources(ctx,run.group_id,evidence.map(ev=>ev.id));
  evidence.sort((a,b)=>(Date.parse(sources.get(a.id)?.ts||'')||0)-(Date.parse(sources.get(b.id)?.ts||'')||0));
  const ledger=await reviewRead<{subject:string;event:string;kind:string}>(ctx,`SELECT subject,event,kind FROM review_consumed WHERE kind IN ('rule_correction','rule_hit') AND subject IN (SELECT value FROM json_each(?))`,[JSON.stringify(rules.map(r=>r.id))]);
  const statements:ReviewStatement[]=[];
  for(const rule of rules) {
    if(!['canary','active'].includes(rule.status)||rule.expires_at<=now) continue;
    const consumed=new Set(ledger.filter(row=>row.subject===rule.id&&row.kind==='rule_correction').map(row=>row.event));
    let count=consumed.size;
    for(const ev of evidence) {
      if(consumed.has(ev.id)||!isCorrection(sources.get(ev.id),ev,rule,now)) continue;
      consumed.add(ev.id); count++;
      const at=Date.parse(sources.get(ev.id)!.ts);
      statements.push({sql:`INSERT OR IGNORE INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('rule_correction',?,?,?,?)`,params:[rule.id,ev.id,run.id,at]});
      statements.push({sql:`INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) VALUES(?,'review_rule_correction',?,'review',?,?)`,params:['review-correction:'+rule.id+':'+ev.id,rule.id,ev.id,new Date(now).toISOString()]});
      if(at<(rule.canary_until??0)||count>=2) break;
    }
  }
  statements.push({sql:`UPDATE behavior_rules SET hits=(SELECT COUNT(*) FROM review_consumed WHERE kind='rule_hit' AND subject=behavior_rules.id),
    corrections=(SELECT COUNT(*) FROM review_consumed WHERE kind='rule_correction' AND subject=behavior_rules.id) WHERE group_id=?`,params:[run.group_id]});
  statements.push({sql:`UPDATE behavior_rules SET status='retired',rollback_reason=CASE WHEN expires_at<=? THEN 'expired' ELSE 'member correction' END,updated_at=?
    WHERE group_id=? AND status IN ('candidate','canary','active','frozen') AND (expires_at<=? OR (status IN ('canary','active') AND (corrections>=2 OR
      EXISTS(SELECT 1 FROM review_consumed WHERE kind='rule_correction' AND subject=behavior_rules.id AND created_at<behavior_rules.canary_until))))`,params:[now,now,run.group_id,now]});
  statements.push({sql:`UPDATE behavior_rules SET status='active',updated_at=? WHERE group_id=? AND status='canary' AND canary_until<=? AND expires_at>?`,params:[now,run.group_id,now,now]});
  statements.push(freezeSurplus(run.group_id,now));
  await reviewBatch(ctx,statements);
}

export async function revokeRule(e:ReviewEnv,id:string,who:string,reason:string):Promise<boolean> {
  if(!who.trim()||!reason.trim()) throw new Error('review rule revocation requires actor and reason');
  const ctx=metered(e),now=Date.now(),summary=text(reviewRedact(reason.trim()),300);
  const rows=await reviewRead<BehaviorRule>(ctx,'SELECT * FROM behavior_rules WHERE id=?',[id]);
  if(!rows.length) return false;
  await reviewBatch(ctx,[
    {sql:`INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) SELECT ?,'review_rule_revoked',id,?,?,? FROM behavior_rules WHERE id=? AND status!='retired'`,params:['review-revoke:'+id,who,summary,new Date(now).toISOString(),id]},
    {sql:"UPDATE behavior_rules SET status='retired',rollback_reason=?,updated_at=? WHERE id=? AND status!='retired'",params:[summary,now,id]},
  ]);
  return true;
}
export async function activeRulesFor(e:ReviewEnv,groupId:string,now=Date.now(),limit=5):Promise<BehaviorRule[]> {
  const rows=await reviewRead<BehaviorRule>(e,`SELECT * FROM behavior_rules WHERE group_id=? AND status IN ('canary','active') AND expires_at>? ORDER BY updated_at DESC,id LIMIT ?`,[groupId,now,limit]);
  return rows.map(row=>({...row,rule:text(row.rule,80)}));
}
