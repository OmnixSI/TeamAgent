import { left, metered, ResourceLimitError } from '../d1';
import { redact } from '../runtime';
import { quoteIn, metaOf } from '../view';
import type { Evidence } from './types';

export type ReviewEnv = { DB: any; meter?: { left(): number } };
export type ReviewStatement = { sql: string; params?: unknown[] };
type Token = { kind: 'word' | 'string' | 'symbol' | 'param' | 'number'; value: string };
const denied = () => new Error('review SQL is outside the write/read allowlist');

/** Tokenize before matching: comments cannot disguise identifiers or extra statements. */
function tokens(sql: string): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < sql.length;) {
    const text = sql.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = text.match(/^\s+/))) { i += m[0].length; continue; }
    if (text.startsWith('--')) { const end = text.indexOf('\n'); i += end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith('/*')) { const end = text.indexOf('*/', 2); if (end < 0) throw denied(); i += end + 2; continue; }
    if (text[0] === "'") {
      let value = '', closed = false;
      i++;
      while (i < sql.length) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") { value += "'"; i += 2; }
          else { i++; closed = true; break; }
        } else value += sql[i++];
      }
      if (!closed) throw denied();
      out.push({ kind: 'string', value }); continue;
    }
    if ((m = text.match(/^[A-Za-z_][A-Za-z_0-9]*/))) { out.push({ kind: 'word', value: m[0].toLowerCase() }); i += m[0].length; continue; }
    if ((m = text.match(/^\d+(?:\.\d+)?/))) { out.push({ kind: 'number', value: m[0] }); i += m[0].length; continue; }
    if (text[0] === '?') {
      // Only anonymous parameters: numbering/named bindings complicate value ownership.
      if (/\d/.test(text[1] || '')) throw denied();
      out.push({ kind: 'param', value: '?' }); i++; continue;
    }
    if (/[(),;.*=<>!+/%|&~-]/.test(text[0])) { out.push({ kind: 'symbol', value: text[0] }); i++; continue; }
    // Quoted/schema-qualified identifiers are intentionally outside this internal API.
    throw denied();
  }
  if (out.at(-1)?.value === ';') out.pop();
  if (!out.length || out.some(t => t.kind === 'symbol' && t.value === ';')) throw denied();
  return out;
}
const word = (t: Token | undefined, value: string) => t?.kind === 'word' && t.value === value;

function validateWrite(sql: string, params: unknown[] = []): void {
  const ts = tokens(sql);
  let i = 0;
  const insert = word(ts[i], 'insert'), update = word(ts[i], 'update');
  if (!insert && !update) throw denied();
  i++;
  if (insert && word(ts[i], 'or')) { if (!word(ts[i + 1], 'ignore')) throw denied(); i += 2; }
  if (insert) { if (!word(ts[i], 'into')) throw denied(); i++; }
  const table = ts[i++];
  if (table?.kind !== 'word' || ts[i]?.value === '.') throw denied();
  const general = /^review_[a-z0-9_]+$/.test(table.value) || ['behavior_rules','promises','capability_gaps'].includes(table.value);
  if (general || (insert && table.value === 'activity')) return;
  // Memory candidates belong to review-owned storage, never daytime facts.
  if (!insert || table.value !== 'tasks' || !word(ts[0], 'insert')) throw denied();

  // Restrict task INSERT to explicit columns + literal VALUES. No SELECT, defaults,
  // UPSERT or expression can change the proposal/status/source invariants.
  if (ts[i++]?.value !== '(') throw denied();
  const columns: string[] = [];
  do {
    const col = ts[i++];
    if (col?.kind !== 'word' || columns.includes(col.value)) throw denied();
    columns.push(col.value);
    if (ts[i]?.value !== ',') break;
    i++;
  } while (true);
  if (ts[i++]?.value !== ')' || !word(ts[i++], 'values')) throw denied();
  const status = columns.indexOf('status'), source = columns.indexOf('source_id'), title = columns.indexOf('title');
  if (status < 0 || source < 0 || title < 0) throw denied();
  let binding = 0;
  do {
    if (ts[i++]?.value !== '(') throw denied();
    const values: { token: Token; value: unknown }[] = [];
    do {
      const t = ts[i++];
      if (!t || !(t.kind === 'param' || t.kind === 'string' || t.kind === 'number' || word(t, 'null'))) throw denied();
      values.push({ token: t, value: t.kind === 'param' ? params[binding++] : t.value });
      if (ts[i]?.value !== ',') break;
      i++;
    } while (true);
    if (ts[i++]?.value !== ')' || values.length !== columns.length) throw denied();
    if (values[status].token.kind !== 'string' || values[status].value !== 'proposal') throw denied();
    if (typeof values[source].value !== 'string' || !/^review:.+/.test(values[source].value as string)) throw denied();
    if (typeof values[title].value !== 'string' || !(values[title].value as string).startsWith('[复盘]')) throw denied();
    if (ts[i]?.value !== ',') break;
    i++;
  } while (true);
  if (i !== ts.length || binding !== params.length) throw denied();
}

function database(e: ReviewEnv, cost: number) {
  const ctx = metered(e);
  if (left(ctx) < cost || cost > 48) throw new ResourceLimitError();
  return ctx.DB;
}

/** All review mutations pass through this fail-closed boundary. */
export async function reviewWrite(e: ReviewEnv, sql: string, params: unknown[] = []): Promise<any> {
  validateWrite(sql, params);
  return database(e, 1).prepare(sql).bind(...cleanParams(params)).run();
}

/** Validate the whole batch before preparing/executing any statement; D1 is atomic. */
export async function reviewBatch(e: ReviewEnv, statements: ReviewStatement[]): Promise<any[]> {
  for (const s of statements) validateWrite(s.sql, s.params);
  if (!statements.length) return [];
  const db = database(e, statements.length);
  return db.batch(statements.map(s => db.prepare(s.sql).bind(...cleanParams(s.params || []))));
}

/** SELECT only, returning rows; callers share metered(e) for an invocation budget. */
export async function reviewRead<T = any>(e: ReviewEnv, sql: string, params: unknown[] = []): Promise<T[]> {
  const ts = tokens(sql);
  if (!word(ts[0], 'select') || ts.some(t => t.kind === 'word' && ['insert','update','delete','replace','pragma','attach','detach','load_extension'].includes(t.value))) throw denied();
  return (await database(e, 1).prepare(sql).bind(...params).all()).results || [];
}

/** Stricter short-key rule supplements the shared credential redactor. */
export const reviewRedact = (value: string) => redact(value).replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g,'[密钥已隐藏]');
const cleanParams = (params: unknown[]) => params.map(v=>typeof v==='string'?reviewRedact(v):v);
export type ReviewSource = {id:string; group_id:string; sender:string; body:string; ts:string; mentioned:number; metadata:string|null; member_id:string};
export async function reviewSources(e: ReviewEnv, group: string, ids: string[]): Promise<Map<string,ReviewSource>> {
  if (!ids.length) return new Map();
  const rows=await reviewRead<ReviewSource>(e,`SELECT m.*,mm.json AS metadata,
    (SELECT id FROM members WHERE id IN (m.sender,'qq:'||m.sender) AND revoked=0 ORDER BY id LIMIT 1) AS member_id
    FROM messages m LEFT JOIN message_meta mm ON mm.id=m.id
    WHERE m.group_id=? AND m.id IN (SELECT value FROM json_each(?))`,[group,JSON.stringify([...new Set(ids)])]);
  return new Map(rows.filter(row=>!!row.member_id).map(row=>[row.id,row]));
}
/** Copied from src/authz.ts:53-57; no import of the business authorization module. */
export function reviewOwnClauses(text: string): string[] {
  const own = text.replace(/```[\s\S]*?```|`[^`]*`|“[^”]*”|「[^」]*」|"[^"]*"|'[^']*'/g, '');
  return own.split(/[，,。！？!?；;\n]/).map(part=>part.trim().replace(/^@\S+\s+/,''));
}
export function reviewDirectQuote(row: ReviewSource | undefined, evidence: Evidence): row is ReviewSource {
  if (!row || !row.member_id || evidence.source!=='message' || evidence.origin!=='direct' || typeof evidence.quote!=='string' || Array.from(evidence.quote.trim()).length<4) return false;
  const meta=metaOf(row);
  if (meta.quoted || meta.forwarded?.length || meta.cardView || meta.bot || meta.senderBot) return false;
  const own=row.body.replace(/```[\s\S]*?```|```[\s\S]*$|~~~[\s\S]*?~~~|~~~[\s\S]*$|`[^`]*`|`[^\n]*$/g,'').replace(/^\s*>.*$/gm,'');
  return reviewRedact(evidence.quote)===evidence.quote && reviewOwnClauses(own).some(clause=>clause.includes(evidence.quote)) && quoteIn(row,evidence.quote);
}

type MemoryCandidate = {id:string; group_id:string; op:string; repo:string; subject:string; predicate:string; value:string; target_fact_id:string|null; target_version:string|null; source_msg_id:string; evidence_json:string; status:string; applied_fact_id:string|null};

/** Admin-only operation, never a general SQL writer. D-6 authenticates the actor. */
export async function applyMemoryCandidate(e: ReviewEnv, id: string, who: string): Promise<string|null> {
  if (!who.trim() || reviewRedact(who)!==who) throw new Error('review memory approval requires an actor');
  const ctx=metered(e), now=Date.now(), iso=new Date(now).toISOString();
  const [c]=await reviewRead<MemoryCandidate>(ctx,'SELECT * FROM review_memory_candidates WHERE id=?',[id]);
  if (!c) return null;
  if (c.status==='applied') return c.applied_fact_id;
  if (!['candidate','approved'].includes(c.status)) return c.status==='superseded'?c.applied_fact_id:null;
  let evidence: Evidence[]=[];
  try { const parsed=JSON.parse(c.evidence_json); if (Array.isArray(parsed)) evidence=parsed; } catch {}
  const rows=await reviewSources(ctx,c.group_id,[c.source_msg_id]);
  const source=rows.get(c.source_msg_id), ev=evidence.find(ev=>ev?.id===c.source_msg_id && reviewDirectQuote(source,ev));
  const valid=!!ev && ['ADD','UPDATE','DELETE'].includes(c.op) && !!c.repo.trim() && !!c.subject.trim() && !!c.predicate.trim() && (c.op==='DELETE'||!!c.value.trim())
    && [c.repo,c.subject,c.predicate,c.value,c.evidence_json].every(s=>reviewRedact(s)===s);
  if (!valid) {
    await reviewWrite(ctx,"UPDATE review_memory_candidates SET status='blocked',reviewed_by=?,reviewed_at=?,note='invalid direct evidence or sensitive data' WHERE id=? AND status IN ('candidate','approved')",[who,now,id]);
    return null;
  }
  const factId='review-memory:'+id;
  const sourceIds=[...new Set([c.source_msg_id,...evidence.filter(ev=>ev?.source==='message').map(ev=>ev.id)])];
  const targetMatches=`EXISTS(SELECT 1 FROM facts f WHERE f.id=c.target_fact_id AND f.repo=c.repo AND f.subject=c.subject AND f.predicate=c.predicate AND f.valid_from=c.target_version AND f.valid_to IS NULL)`;
  const duplicate=`SELECT f.id FROM facts f WHERE f.repo=c.repo AND f.subject=c.subject AND f.predicate=c.predicate AND f.value=c.value AND f.valid_to IS NULL ORDER BY f.id LIMIT 1`;
  // Recheck live membership, exact original, tombstones and target version inside
  // the same transaction as the facts writes; a preflight read is not a lock.
  const statements: ReviewStatement[]=[
    {sql:`UPDATE review_memory_candidates AS c SET status=CASE
      WHEN NOT EXISTS(SELECT 1 FROM messages m WHERE m.id=c.source_msg_id AND m.group_id=c.group_id AND m.body=? AND m.sender=?
        AND COALESCE((SELECT json FROM message_meta WHERE id=m.id),'')=?
        AND EXISTS(SELECT 1 FROM members WHERE id IN (m.sender,'qq:'||m.sender) AND revoked=0))
        OR EXISTS(SELECT 1 FROM memory_blocks WHERE source_id IN (SELECT value FROM json_each(?)) OR source_id=(SELECT source_id FROM facts WHERE id=c.target_fact_id)) THEN 'blocked'
      WHEN c.op IN ('UPDATE','DELETE') AND NOT ${targetMatches} THEN 'conflict'
      WHEN c.op IN ('ADD','UPDATE') AND EXISTS(${duplicate}) THEN 'superseded' ELSE 'approved' END,
      applied_fact_id=CASE WHEN c.op IN ('ADD','UPDATE') THEN (${duplicate}) ELSE NULL END,
      reviewed_by=?,reviewed_at=?
      WHERE id=? AND status IN ('candidate','approved') AND op=? AND repo=? AND subject=? AND predicate=? AND value=?
        AND source_msg_id=? AND evidence_json=? AND COALESCE(target_fact_id,'')=? AND COALESCE(target_version,'')=?`,
      params:[source!.body,source!.sender,source!.metadata||'',JSON.stringify(sourceIds),who,now,id,c.op,c.repo,c.subject,c.predicate,c.value,c.source_msg_id,c.evidence_json,c.target_fact_id||'',c.target_version||'']},
    {sql:`UPDATE facts SET valid_to=? WHERE id=(SELECT target_fact_id FROM review_memory_candidates WHERE id=? AND status='approved' AND op IN ('UPDATE','DELETE') AND reviewed_by=? AND reviewed_at=?)
      AND valid_to IS NULL AND valid_from=(SELECT target_version FROM review_memory_candidates WHERE id=?)`,params:[iso,id,who,now,id]},
    {sql:`INSERT INTO facts(id,repo,subject,predicate,value,evidence,source_id,status,valid_from,valid_to)
      SELECT ?,repo,subject,predicate,value,?,source_msg_id,'confirmed',?,NULL FROM review_memory_candidates WHERE id=? AND status='approved' AND op IN ('ADD','UPDATE') AND reviewed_by=? AND reviewed_at=?`,params:[factId,ev!.quote,iso,id,who,now]},
    {sql:`INSERT OR IGNORE INTO memory_blocks(source_id,subject,predicate) SELECT f.source_id,f.subject,f.predicate FROM facts f JOIN review_memory_candidates c ON c.target_fact_id=f.id
      WHERE c.id=? AND c.op='DELETE' AND c.status='approved' AND c.reviewed_by=? AND c.reviewed_at=?`,params:[id,who,now]},
    {sql:`UPDATE review_memory_candidates SET status='applied',applied_fact_id=CASE WHEN op='DELETE' THEN target_fact_id ELSE ? END
      WHERE id=? AND status='approved' AND reviewed_by=? AND reviewed_at=?`,params:[factId,id,who,now]},
    {sql:`INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) SELECT ?,'review_memory_applied',id,?,'已审核应用记忆候选',? FROM review_memory_candidates WHERE id=? AND status='applied'`,params:['review-memory-applied:'+id,who,iso,id]},
  ];
  // These fixed statements are the only privileged facts/tombstone writes.
  const db=database(ctx,statements.length);
  await db.batch(statements.map(s=>db.prepare(s.sql).bind(...cleanParams(s.params||[]))));
  const [result]=await reviewRead<MemoryCandidate>(ctx,'SELECT status,applied_fact_id FROM review_memory_candidates WHERE id=?',[id]);
  return ['applied','superseded'].includes(result?.status)?result.applied_fact_id:null;
}
export const reviewWriteAdmin = Object.freeze({applyMemoryCandidate});
