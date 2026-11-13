import { left, metered, ResourceLimitError } from '../d1';

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
  if (!insert || table.value !== 'tasks' || !word(ts[0], 'insert') || word(ts[1], 'or')) throw denied();

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
  return database(e, 1).prepare(sql).bind(...params).run();
}

/** Validate the whole batch before preparing/executing any statement; D1 is atomic. */
export async function reviewBatch(e: ReviewEnv, statements: ReviewStatement[]): Promise<any[]> {
  for (const s of statements) validateWrite(s.sql, s.params);
  if (!statements.length) return [];
  const db = database(e, statements.length);
  return db.batch(statements.map(s => db.prepare(s.sql).bind(...(s.params || []))));
}

/** SELECT only, returning rows; callers share metered(e) for an invocation budget. */
export async function reviewRead<T = any>(e: ReviewEnv, sql: string, params: unknown[] = []): Promise<T[]> {
  const ts = tokens(sql);
  if (!word(ts[0], 'select') || ts.some(t => t.kind === 'word' && ['insert','update','delete','replace','pragma','attach','detach','load_extension'].includes(t.value))) throw denied();
  return (await database(e, 1).prepare(sql).bind(...params).all()).results || [];
}
