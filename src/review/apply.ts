// V-D / D-5a: consume validated judgments into findings, gaps, promises and
// memory candidates. Every count is derived from review_consumed; no counter is
// ever incremented in place. All writes stay inside the D-5b allowlist.
import { metered } from '../d1';
import { reviewBatch, reviewRead, reviewSources, reviewDirectQuote, reviewRedact, type ReviewEnv, type ReviewStatement } from './db';
import { applyRequirements } from './rules';
import { TOOLS_CATALOG } from './catalog';
import type { Agreement, Evidence, JudgePromise } from './types';

export type ApplyRun = { id: string; group_id: string; gen: number; now?: number };
export type ApplyResult = { consumed: boolean; findings: number; tasks: number; plan?: ReviewStatement[] };
export type PromiseCheck = { checked: number; kept: number; broken: number; cannot: number };
export type GapTaskInput = {
  fingerprint: string; gap_type: string; capability: string; severity: string; fix_layer: string;
  evidence: Evidence[]; occurrences: number; first_seen: number; last_seen: number; status: string;
  proposed_action?: string; owner?: string; what_happened?: string; expected?: string;
  root_cause?: string; next_attempt_plan?: string;
};

type Row = Record<string, any>;
type Issue = { v: any; fp: string; agreement: Agreement; status: 'open' | 'disputed'; findingId: string };
type SecondInfo = { v: any; provider: string; model: string };

const nowOf = (run: ApplyRun) => run.now ?? Date.now();
const arr = (value: any): any[] => Array.isArray(value) ? value : [];
const text = (value: any) => typeof value === 'string' ? value : '';
const changed = (result: any) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const parse = (value: any, fallback: any): any => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
};
const sha1 = async (value: string) => {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
};
const shortHash = async (parts: string[], length = 16) => (await sha1(parts.join('|'))).slice(0, length);
const familyOf = (provider: string) => provider === 'codex-offline' ? 'openai' : provider;

export function rootCauseFamily(failureType: string): string {
  const parts = String(failureType || '').split('.');
  return parts[1] ?? parts[0] ?? 'unknown';
}
export function acceptanceFamily(verdict: any): string {
  return verdict?.gap_type ?? verdict?.kind ?? 'none';
}
export function fingerprintOf(group: string, verdict: any): Promise<string> {
  return shortHash([group, rootCauseFamily(verdict?.failure_type), verdict?.capability ?? '', acceptanceFamily(verdict)]);
}
export function agreementOf(verdict: any, second: SecondInfo | undefined, primaryProvider: string, declared?: any): Agreement {
  if (declared && ['agree', 'disagree', 'single', 'pending'].includes(declared)) return declared;
  if (!second) return 'single';
  if (primaryProvider && second.provider && familyOf(primaryProvider) === familyOf(second.provider)) return 'single';
  const other = second.v;
  if (other?.verdict === 'insufficient') return 'disagree';
  const issue = verdict?.kind !== 'none' && verdict?.failure_type != null;
  const left = String(verdict?.failure_type ?? '').split('.')[0];
  const right = String(other?.failure_type ?? '').split('.')[0];
  return issue === (other?.verdict === 'issue') && left === right && (verdict?.gap_type ?? null) === (other?.gap_type ?? null) ? 'agree' : 'disagree';
}

function primaryOf(raw: any): any | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  if (body.schema && body.schema !== 'ta.review.result.v2') return null;
  if (!Array.isArray(body.verdicts)) return null;
  return body;
}
function secondOf(raw: any): any[] {
  if (!raw || typeof raw !== 'object') return [];
  const body = raw.result && typeof raw.result === 'object' ? raw.result : raw;
  if (body.schema && body.schema !== 'ta.review.second.v1') return [];
  return arr(body.verdicts);
}
async function secondMap(e: ReviewEnv, runId: string): Promise<Map<string, SecondInfo>> {
  const rows = await reviewRead<Row>(e,
    "SELECT provider,model,raw,created_at FROM review_judgments WHERE run_id=? AND role='second' AND state='ok' ORDER BY created_at DESC,id DESC",
    [runId]);
  const map = new Map<string, SecondInfo>();
  for (const row of rows) {
    for (const v of secondOf(parse(row.raw, null))) {
      if (v && typeof v.trace_id === 'string' && !map.has(v.trace_id)) {
        map.set(v.trace_id, { v, provider: text(row.provider), model: text(row.model) });
      }
    }
  }
  return map;
}

const ownerFor = (gapType: string): string => {
  if (['tool_missing', 'tool_not_selected', 'tool_failed'].includes(gapType)) return '工程师';
  if (['capability_offline', 'switch_or_policy_off', 'data_stale_or_coverage'].includes(gapType)) return '交付员';
  if (gapType === 'prompt_rule_missing') return '主程';
  return '主程';
};
const actionFor = (capability: string, gapType: string): string => {
  if (gapType === 'tool_missing') return `补齐 ${capability} 所需工具并加固定探针`;
  if (gapType === 'tool_not_selected') return `补规则/提示，让该场景实际选用 ${capability} 工具`;
  if (gapType === 'tool_failed') return `修复 ${capability} 工具错误并保留错误码`;
  if (gapType === 'capability_offline') return `恢复 runner/上游并加健康检查`;
  if (gapType === 'switch_or_policy_off') return `核对开关与策略，对历史记录只读标注`;
  if (gapType === 'data_stale_or_coverage') return `刷新索引/数据并标注新鲜度`;
  if (gapType === 'prompt_rule_missing') return `补该场景的规则模板与验收`;
  return `复核 ${capability} 的能力边界`;
};

async function taskRows(e: ReviewEnv, inputs: GapTaskInput[]): Promise<Map<string, { rowid: number; body: string }>> {
  const ids = inputs.flatMap(g => g.evidence.filter(ev => ev?.source === 'message' || ev?.source === 'outbox').map(ev => ev.id));
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await reviewRead<Row>(e,
    `SELECT 'message' AS source,id,rowid,body FROM messages WHERE id IN (SELECT value FROM json_each(?))
     UNION ALL SELECT 'outbox' AS source,id,rowid,body FROM outbox WHERE id IN (SELECT value FROM json_each(?))`,
    [JSON.stringify(unique), JSON.stringify(unique)]);
  return new Map(rows.map(row => [`${row.source}:${row.id}`, { rowid: Number(row.rowid), body: text(row.body) }]));
}

function gapDetail(gap: GapTaskInput, rows: Map<string, { rowid: number; body: string }>): string | null {
  const evidence = gap.evidence.filter(ev => {
    if (!ev || (ev.source !== 'message' && ev.source !== 'outbox')) return false;
    const quote = text(ev.quote);
    if (quote.length < 4 || quote.length > 60 || reviewRedact(quote) !== quote) return false;
    const row = rows.get(`${ev.source}:${ev.id}`);
    return !!row && row.body.includes(quote);
  });
  if (!evidence.length) return null;
  const lines = [
    '# 能力缺口提案（gap:v1）',
    '',
    `- 指纹：${gap.fingerprint}`,
    `- 能力：${gap.capability}`,
    `- 缺口类型：${gap.gap_type}`,
    `- 修复层：${gap.fix_layer}`,
    `- 负责人：${gap.owner || ownerFor(gap.gap_type)}`,
    `- 状态：${gap.status}`,
    `- 出现次数：${gap.occurrences}`,
    `- 首次：${new Date(gap.first_seen).toISOString()}`,
    `- 最近：${new Date(gap.last_seen).toISOString()}`,
    '',
    '## 证据（逐字）',
    ...evidence.map(ev => `- ${ev.source}:${ev.id}（rowid=${rows.get(`${ev.source}:${ev.id}`)!.rowid}）「${ev.quote}」`),
    '',
    '## 复现',
    ...evidence.map(ev => `- ${ev.source === 'message' ? 'messages' : 'outbox'}.rowid=${rows.get(`${ev.source}:${ev.id}`)!.rowid}（${ev.source}:${ev.id}）`),
    '',
    '## 验收建议',
    `- ${gap.next_attempt_plan || `同场景回放应调用 ${gap.capability} 并给出可核对结果；失败即未修复。`}`,
    '',
    '## 现在怎么修',
    `- ${gap.proposed_action || actionFor(gap.capability, gap.gap_type)}`,
  ];
  if (gap.what_happened) lines.push('', `## 发生了什么`, `- ${gap.what_happened}`);
  if (gap.expected) lines.push('', `## 应该怎样`, `- ${gap.expected}`);
  if (gap.root_cause) lines.push('', `## 根因`, `- ${gap.root_cause}`);
  return reviewRedact(lines.join('\n'));
}

/** Build a proposal task plus its activity and gap back-reference. */
export async function taskStatements(e: ReviewEnv, run: ApplyRun, gap: GapTaskInput, now: number): Promise<ReviewStatement[]> {
  const rows = await taskRows(e, [gap]);
  const detail = gapDetail(gap, rows);
  if (!detail) return [];
  const existing = await reviewRead<Row>(e, 'SELECT id FROM tasks WHERE id=? OR id LIKE ?', [`rv-${gap.fingerprint}`, `rv-${gap.fingerprint}-r%`]);
  const base = `rv-${gap.fingerprint}`;
  let id = base;
  if (gap.status === 'regression' && existing.some(row => row.id === base)) {
    const suffixes = existing.map(row => String(row.id)).filter(value => value.startsWith(base + '-r'))
      .map(value => Number(value.slice((base + '-r').length))).filter(Number.isInteger);
    id = `${base}-r${Math.max(0, ...suffixes) + 1}`;
  }
  if (existing.some(row => row.id === id)) return [];
  const title = reviewRedact(`[复盘] ${gap.capability} · ${gap.gap_type}`);
  const createdAt = new Date(now).toISOString();
  return [
    { sql: `INSERT OR IGNORE INTO tasks(id,repo,title,detail,status,assignee,source_id,created_at,updated_at) VALUES(?,?,?,?,'proposal','',?,?,?)`,
      params: [id, 'OmnixSI/TeamAgent', title, detail, `review:${gap.fingerprint}`, createdAt, createdAt] },
    { sql: `INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) VALUES(?,'task.created',?,'夜间复盘',?,?)`,
      params: [`review-task:${id}`, id, `[复盘] ${gap.capability} · ${gap.gap_type}`, createdAt] },
    { sql: `UPDATE capability_gaps SET status=CASE WHEN status='fixed' THEN 'regression' ELSE 'proposed' END,task_id=? WHERE fingerprint=?`,
      params: [id, gap.fingerprint] },
  ];
}

async function memoryStatements(e: ReviewEnv, run: ApplyRun, updates: any[], now: number, blocked: Set<string>): Promise<ReviewStatement[]> {
  if (!updates.length) return [];
  const ids = updates.flatMap(u => arr(u?.evidence).filter(ev => ev?.source === 'message').map(ev => text(ev.id)));
  const sources = await reviewSources(e, run.group_id, ids);
  const statements: ReviewStatement[] = [];
  for (const update of updates) {
    if (!update || !['ADD', 'UPDATE', 'DELETE'].includes(update.op)) continue;
    const evidence = arr(update.evidence).find(ev => !blocked.has(text(ev?.id)) && !blocked.has(text(ev?.id) + '|' + text(ev?.quote)) && reviewDirectQuote(sources.get(text(ev?.id)), ev));
    if (!evidence) continue;
    const source = sources.get(evidence.id)!;
    const repo = text(update.repo), subject = text(update.subject), predicate = text(update.predicate), value = text(update.value);
    if (!repo.trim() || !subject.trim() || !predicate.trim() || (update.op !== 'DELETE' && !value.trim())) continue;
    let target: any = null;
    if (update.op !== 'ADD') {
      const [row] = await reviewRead<Row>(e,
        'SELECT id,valid_from FROM facts WHERE repo=? AND subject=? AND predicate=? AND valid_to IS NULL ORDER BY valid_from DESC,id LIMIT 1',
        [repo, subject, predicate]);
      target = row ?? null;
    }
    const id = 'mc-' + await shortHash([update.op, repo, subject, predicate, value, source.id], 12);
    statements.push({
      sql: `INSERT OR IGNORE INTO review_memory_candidates(id,run_id,group_id,op,repo,subject,predicate,value,target_fact_id,target_version,source_msg_id,evidence_json,status,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'candidate',?)`,
      params: [id, run.id, run.group_id, update.op, repo, subject, predicate, value,
        target?.id ?? null, target?.valid_from ?? null, source.id, JSON.stringify([evidence]), now],
    });
  }
  return statements;
}

async function promiseStatements(e: ReviewEnv, run: ApplyRun, promises: any[], now: number): Promise<ReviewStatement[]> {
  const wanted = promises.filter(p => p && typeof p.outbox_id === 'string' && typeof p.quote === 'string' && p.quote.length >= 4);
  if (!wanted.length) return [];
  const rows = await reviewRead<Row>(e,
    'SELECT id,group_id,body,created_at FROM outbox WHERE id IN (SELECT value FROM json_each(?))',
    [JSON.stringify([...new Set(wanted.map(p => p.outbox_id))])]);
  const map = new Map(rows.map(row => [row.id, row]));
  const statements: ReviewStatement[] = [];
  for (const promise of wanted) {
    const row = map.get(promise.outbox_id);
    if (!row || row.group_id !== run.group_id || !text(row.body).includes(promise.quote)) continue;
    const due = promise.due ? Date.parse(promise.due) : NaN;
    const id = 'pr-' + await shortHash([run.group_id, promise.outbox_id, promise.quote], 12);
    statements.push({
      sql: `INSERT OR IGNORE INTO promises(id,group_id,outbox_id,quote,what,due_at,recurring,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)`,
      params: [id, run.group_id, promise.outbox_id, promise.quote, text(promise.what), Number.isFinite(due) ? due : null, promise.recurring || null, now],
    });
  }
  return statements;
}

const schedulingTool = () => TOOLS_CATALOG.some(tool => /sched|remind|calendar|cron/i.test(tool.name));

/** Parse one validated judgment. Kept small and fail-closed: malformed rows stay unconsumed. */
export async function applyJudgment(e: ReviewEnv, run: ApplyRun, judgmentId: string, options: { prepareOnly?: boolean } = {}): Promise<ApplyResult> {
  const ctx = metered(e), now = nowOf(run);
  const [judgment] = await reviewRead<Row>(ctx, 'SELECT * FROM review_judgments WHERE id=?', [judgmentId]);
  if (!judgment || judgment.state !== 'ok' || judgment.consumed_at != null) return { consumed: false, findings: 0, tasks: 0 };

  if (judgment.role !== 'primary') {
    const result = await reviewBatch(e, [{ sql: "UPDATE review_judgments SET consumed_at=? WHERE id=? AND state='ok' AND consumed_at IS NULL", params: [now, judgment.id] }]);
    return { consumed: changed(result?.[0]) === 1, findings: 0, tasks: 0 };
  }

  const parsed = primaryOf(parse(judgment.raw, null));
  if (!parsed) return { consumed: false, findings: 0, tasks: 0 };
  const seconds = await secondMap(ctx, run.id);
  const issues: Issue[] = [];
  const seen = new Set<string>();
  for (const verdict of arr(parsed.verdicts)) {
    if (!verdict || verdict.kind === 'none' || !verdict.failure_type || typeof verdict.trace_id !== 'string') continue;
    if (!arr(verdict.evidence).length) continue;
    const key = verdict.trace_id + '|' + verdict.failure_type;
    if (seen.has(key)) continue;
    seen.add(key);
    const fp = await fingerprintOf(run.group_id, verdict);
    const agreement = agreementOf(verdict, seconds.get(verdict.trace_id), text(judgment.provider), verdict.agreement);
    const findingId = 'rf-' + await shortHash([run.group_id, verdict.trace_id, verdict.failure_type]);
    issues.push({ v: verdict, fp, agreement, status: agreement === 'agree' || agreement === 'single' ? 'open' : 'disputed', findingId });
  }

  const fps = [...new Set(issues.map(issue => issue.fp))];
  const existingGaps = fps.length ? await reviewRead<Row>(ctx,
    'SELECT fingerprint,status,occurrences,first_seen,last_seen,external_ref FROM capability_gaps WHERE fingerprint IN (SELECT value FROM json_each(?))',
    [JSON.stringify(fps)]) : [];
  const gapMap = new Map(existingGaps.map(row => [row.fingerprint, row]));
  const existingEvents = issues.length ? await reviewRead<Row>(ctx,
    "SELECT event FROM review_consumed WHERE kind='gap_occurrence' AND event IN (SELECT value FROM json_each(?))",
    [JSON.stringify(issues.filter(issue => issue.status !== 'disputed').map(issue => issue.findingId))]) : [];
  const knownEvents = new Set(existingEvents.map(row => row.event));
  const occurrenceCounts = new Map<string, number>();
  if (fps.length) {
    const counts = await reviewRead<Row>(ctx,
      "SELECT subject,COUNT(*) AS n FROM review_consumed WHERE kind='gap_occurrence' AND subject IN (SELECT value FROM json_each(?)) GROUP BY subject",
      [JSON.stringify(fps)]);
    for (const row of counts) occurrenceCounts.set(row.subject, Number(row.n));
  }
  for (const issue of issues) {
    if (issue.status === 'disputed' || knownEvents.has(issue.findingId)) continue;
    occurrenceCounts.set(issue.fp, (occurrenceCounts.get(issue.fp) ?? 0) + 1);
  }

  const statements: ReviewStatement[] = [];
  const findingIndexes: number[] = [];
  for (const issue of issues) {
    const second = seconds.get(issue.v.trace_id);
    const secondJson = second ? JSON.stringify({
      provider: second.provider, model: second.model, failure_type: second.v.failure_type,
      gap_type: second.v.gap_type, severity: second.v.severity, dimensions: second.v.dimensions,
    }) : null;
    statements.push({
      sql: `INSERT OR IGNORE INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,second_json,status,fingerprint,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      params: [issue.findingId, run.id, issue.v.trace_id, issue.v.failure_type, issue.v.severity, issue.v.fix_layer,
        issue.v.gap_type ?? null, issue.v.capability ?? null, issue.v.should_use_tool ?? null,
        JSON.stringify(issue.v.dimensions ?? {}), JSON.stringify(issue.v.evidence ?? []),
        text(issue.v.what_happened), text(issue.v.expected), text(issue.v.root_cause), text(issue.v.next_attempt_plan),
        Number(issue.v.confidence ?? 0), issue.agreement, secondJson, issue.status, issue.fp, now],
    });
    findingIndexes.push(statements.length - 1);
    if (issue.status !== 'disputed' && issue.v.gap_type && issue.v.capability) {
      statements.push({
        sql: `INSERT OR IGNORE INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('gap_occurrence',?,?,?,?)`,
        params: [issue.fp, issue.findingId, run.id, now],
      });
    }
  }

  const createdThisRun = await reviewRead<Row>(ctx,
    "SELECT COUNT(*) AS n FROM tasks WHERE created_at>=? AND source_id IN (SELECT 'review:'||fingerprint FROM review_findings WHERE run_id=?)",
    [new Date(now - 6 * 3600000).toISOString(), run.id]);
  let taskBudget = Math.max(0, 3 - Number(createdThisRun[0]?.n ?? 0));
  const coveredCapabilities = new Set((await reviewRead<Row>(ctx,
    'SELECT DISTINCT capability FROM capability_gaps WHERE external_ref IS NOT NULL')).map(row => text(row.capability)));
  const gapStatements: ReviewStatement[] = [];
  const taskStatementsOut: ReviewStatement[] = [];
  for (const fingerprint of fps) {
    const issue = issues.find(item => item.fp === fingerprint && item.status !== 'disputed');
    if (!issue || !issue.v.gap_type || !issue.v.capability) continue;
    const existing = gapMap.get(fingerprint);
    const occurrences = occurrenceCounts.get(fingerprint) ?? 0;
    const firstSeen = existing?.first_seen ?? now;
    const lastSeen = Math.max(Number(existing?.last_seen ?? 0), now);
    const status = existing?.status === 'fixed' ? 'regression' : (existing?.status ?? 'open');
    const proposed = actionFor(issue.v.capability, issue.v.gap_type);
    const owner = ownerFor(issue.v.gap_type);
    gapStatements.push({ sql: `INSERT OR IGNORE INTO capability_gaps(fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,task_id,external_ref) VALUES(?,?,?,0,?,?,?,?,?,'open',NULL,NULL)`,
      params: [fingerprint, issue.v.gap_type, issue.v.capability, firstSeen, lastSeen, JSON.stringify(issue.v.evidence ?? []), proposed, owner] });
    gapStatements.push({ sql: `UPDATE capability_gaps SET gap_type=?,capability=?,occurrences=(SELECT COUNT(*) FROM review_consumed WHERE kind='gap_occurrence' AND subject=capability_gaps.fingerprint),last_seen=CASE WHEN last_seen<=? THEN ? ELSE last_seen END,evidence_json=CASE WHEN last_seen<=? THEN ? ELSE evidence_json END,proposed_action=?,owner=?,status=CASE WHEN status='fixed' THEN 'regression' ELSE status END WHERE fingerprint=?`,
      params: [issue.v.gap_type, issue.v.capability, now, now, now, JSON.stringify(issue.v.evidence ?? []), proposed, owner, fingerprint] });
    if (issue.v.severity === 'p0' && !existing?.external_ref && !coveredCapabilities.has(issue.v.capability)) {
      const task = await taskStatements(e, run, {
        fingerprint, gap_type: issue.v.gap_type, capability: issue.v.capability, severity: issue.v.severity,
        fix_layer: issue.v.fix_layer, evidence: issue.v.evidence ?? [], occurrences, first_seen: firstSeen,
        last_seen: lastSeen, status, proposed_action: proposed, owner, what_happened: issue.v.what_happened,
        expected: issue.v.expected, root_cause: issue.v.root_cause, next_attempt_plan: issue.v.next_attempt_plan,
      }, now);
      if (task.length && taskBudget > 0) { taskStatementsOut.push(...task); taskBudget--; }
    }
  }
  statements.push(...gapStatements, ...taskStatementsOut);

  const disputedEvidence = new Set<string>();
  for (const issue of issues) if (issue.status === 'disputed') for (const ev of arr(issue.v.evidence)) if (ev?.source === 'message') {
    disputedEvidence.add(text(ev.id)); disputedEvidence.add(text(ev.id) + '|' + text(ev.quote));
  }
  const memory = await memoryStatements(ctx, run, arr(parsed.memory_updates), now, disputedEvidence);
  const promises = await promiseStatements(ctx, run, arr(parsed.promises), now);
  statements.push(...memory, ...promises);

  const judged = issues.map(issue => issue.v.trace_id);
  if (judged.length) statements.push({
    sql: `UPDATE review_traces SET state='judged',judged_run_id=? WHERE id IN (SELECT value FROM json_each(?)) AND state IN ('pending','judge_failed')`,
    params: [run.id, JSON.stringify([...new Set(judged)])],
  });
  if (fps.length) statements.push({
    sql: `UPDATE capability_gaps SET occurrences=(SELECT COUNT(*) FROM review_consumed WHERE kind='gap_occurrence' AND subject=capability_gaps.fingerprint) WHERE fingerprint IN (SELECT value FROM json_each(?))`,
    params: [JSON.stringify(fps)],
  });
  statements.push({
    sql: `UPDATE behavior_rules SET hits=(SELECT COUNT(*) FROM review_consumed WHERE kind='rule_hit' AND subject=behavior_rules.id),corrections=(SELECT COUNT(*) FROM review_consumed WHERE kind='rule_correction' AND subject=behavior_rules.id) WHERE group_id=?`,
    params: [run.group_id],
  });
  statements.push({
    sql: "UPDATE review_judgments SET consumed_at=? WHERE id=? AND state='ok' AND consumed_at IS NULL",
    params: [now, judgment.id],
  });

  // D-6 persists the immutable plan before executing bounded pages on later ticks.
  // The default D-5a call retains its original execution contract.
  if (options.prepareOnly) return { consumed: false, findings: 0, tasks: 0, plan: statements };

  const donePages = new Set((await reviewRead<Row>(ctx,
    "SELECT event FROM review_consumed WHERE kind='apply_page' AND subject=?", [judgment.id]))
    .map(row => Number(row.event)).filter(Number.isInteger));
  const pages: ReviewStatement[][] = [];
  for (let i = 0; i < statements.length; i += 47) pages.push(statements.slice(i, i + 47));
  if (!pages.length) pages.push([]);
  let findings = 0, tasks = 0, consumed = false;
  for (let page = 0; page < pages.length; page++) {
    if (donePages.has(page)) continue;
    const batch = [...pages[page]];
    if (pages.length > 1) {
      batch.push({ sql: `INSERT OR IGNORE INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('apply_page',?,?,?,?)`, params: [judgment.id, String(page), run.id, now] });
    }
    const results = await reviewBatch(e, batch);
    for (const index of findingIndexes) {
      const offset = index - page * 47;
      if (offset >= 0 && offset < pages[page].length) findings += changed(results[offset]);
    }
    const taskStarts = taskStatementsOut.length ? pages[page] : [];
    if (taskStarts.length) {
      // Task inserts are the first statement of each 3-statement task block.
      for (let offset = 0; offset < pages[page].length; offset++) {
        if (/^INSERT OR IGNORE INTO tasks/.test(pages[page][offset].sql)) tasks += changed(results[offset]);
      }
    }
    if (page === pages.length - 1) {
      const at = batch.findIndex(statement => /UPDATE review_judgments SET consumed_at=/.test(statement.sql));
      consumed = at >= 0 && changed(results[at]) === 1;
    }
  }
  try { await applyRequirements(e, run, arr(parsed.requirements)); } catch { /* requirements are a separate D-5b batch; core consume stays valid */ }
  return { consumed, findings, tasks };
}

/** Insert promises discovered by a judgment. The outbox quote is checked live. */
export async function applyPromises(e: ReviewEnv, run: ApplyRun, promises: JudgePromise[]): Promise<number> {
  const statements = await promiseStatements(metered(e), run, promises as any[], nowOf(run));
  if (!statements.length) return 0;
  const results = await reviewBatch(e, statements);
  return results.reduce((n, result) => n + changed(result), 0);
}

function sydneyOffset(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'longOffset' }).formatToParts(new Date(at));
  const value = parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT+11:00';
  const match = value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3600000 + Number(match[3] ?? 0) * 60000);
}
function sydneyDate(at: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at));
  const pick = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}
function sydneyTime(date: string, hour: number, minute: number): number {
  const base = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  let guess = base;
  for (let i = 0; i < 2; i++) guess = base - sydneyOffset(guess);
  return guess;
}

/** Check open promises against real outbox rows. Rechecking the same day is idempotent. */
export async function checkPromises(e: ReviewEnv, run: ApplyRun): Promise<PromiseCheck> {
  const ctx = metered(e), now = nowOf(run), day = sydneyDate(now);
  const promises = await reviewRead<Row>(ctx, "SELECT * FROM promises WHERE group_id=? AND status='open' ORDER BY created_at,id LIMIT 8", [run.group_id]);
  const statements: ReviewStatement[] = [];
  const counts = { checked: 0, kept: 0, broken: 0, cannot: 0 };
  const scheduling = schedulingTool();
  for (const promise of promises) {
    let target: number | null = null;
    const recurring = text(promise.recurring).match(/^daily\s+(\d{1,2}):(\d{2})$/i);
    if (recurring) {
      // The night reviews the previous local day; 04:00-07:30 runs cannot see today's 08:00.
      target = sydneyTime(sydneyDate(now - 86400000), Number(recurring[1]), Number(recurring[2]));
    } else if (promise.due_at != null && Number.isFinite(Number(promise.due_at))) {
      target = Number(promise.due_at);
    }
    if (target == null || target + 1800000 > now || Number(promise.created_at) > target + 1800000) continue;
    const rows = await reviewRead<Row>(ctx, 'SELECT id,body,created_at FROM outbox WHERE group_id=? AND created_at BETWEEN ? AND ? ORDER BY created_at,id LIMIT 20',
      [run.group_id, target - 1800000, target + 1800000]);
    const kept = rows.length > 0;
    const status = kept ? 'kept' : scheduling ? 'broken' : 'cannot';
    counts.checked++;
    if (kept) counts.kept++;
    else if (status === 'cannot') counts.cannot++;
    else counts.broken++;
    const note = kept ? `窗口内找到 ${rows.length} 条外发` : scheduling ? '窗口内没有对应外发' : '能力表没有 scheduling 工具';
    statements.push({ sql: `INSERT OR IGNORE INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('promise_check',?,?,?,?)`, params: [promise.id, day, run.id, now] });
    statements.push({ sql: `UPDATE promises SET status=?,check_note=?,checked_at=? WHERE id=? AND status='open'`, params: [status, note, now, promise.id] });
    if (kept) continue;

    const fingerprint = await fingerprintOf(run.group_id, { failure_type: 'planning.task.goal_deviation', capability: 'scheduling', gap_type: 'tool_missing' });
    const findingId = 'rf-' + await shortHash([run.group_id, promise.id, 'planning.task.goal_deviation']);
    const evidence = [{ source: 'outbox', id: promise.outbox_id, quote: promise.quote, origin: 'bot' }];
    statements.push({
      sql: `INSERT OR IGNORE INTO review_findings(id,run_id,trace_id,failure_type,severity,fix_layer,gap_type,capability,should_use_tool,dimensions,evidence_json,what_happened,expected,root_cause,next_attempt_plan,confidence,agreement,status,fingerprint,created_at)
        VALUES(?,?,?,?, 'p1','prompt','tool_missing','scheduling','none','{"answered":"UNSATISFIED","facts":"SATISFIED","tool_choice":"UNSATISFIED","memory":"SATISFIED","expression":"SATISFIED","boundary":"SATISFIED"}',?,?,?,?,?,0.9,'single',?,?,?)`,
      params: [findingId, run.id, `tr-out-${promise.outbox_id}`, 'planning.task.goal_deviation', JSON.stringify(evidence),
        `承诺未兑现：${text(promise.what)}`, '按承诺的时间给出可核对结果或明确说明做不了',
        scheduling ? '承诺了但没有兑现记录' : '没有调度能力，却按定时任务承诺', '补调度工具或把承诺改成可核对的一次性动作',
        'open', fingerprint, now],
    });
    statements.push({ sql: `INSERT OR IGNORE INTO review_consumed(kind,subject,event,run_id,created_at) VALUES('gap_occurrence',?,?,?,?)`, params: [fingerprint, findingId, run.id, now] });
    statements.push({ sql: `INSERT OR IGNORE INTO capability_gaps(fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,task_id,external_ref) VALUES(?,'tool_missing','scheduling',0,?,?,?,?,'工程师','open',NULL,NULL)`,
      params: [fingerprint, now, now, JSON.stringify(evidence), actionFor('scheduling', 'tool_missing')] });
    statements.push({ sql: `UPDATE capability_gaps SET occurrences=(SELECT COUNT(*) FROM review_consumed WHERE kind='gap_occurrence' AND subject=capability_gaps.fingerprint),last_seen=CASE WHEN last_seen<=? THEN ? ELSE last_seen END,evidence_json=CASE WHEN last_seen<=? THEN ? ELSE evidence_json END WHERE fingerprint=?`,
      params: [now, now, now, JSON.stringify(evidence), fingerprint] });
  }
  if (statements.length) await reviewBatch(e, statements);
  return counts;
}
