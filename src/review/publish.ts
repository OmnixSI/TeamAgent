// V-D / D-5a: publish proposal tasks and render the daily digest. This module
// reads the review tables and writes only through reviewWrite/reviewBatch.
import { metered } from '../d1';
import { reviewBatch, reviewRead, reviewRedact, type ReviewEnv, type ReviewStatement } from './db';
import { taskStatements, type ApplyRun, type GapTaskInput } from './apply';

type Row = Record<string, any>;
const arr = (value: any): any[] => Array.isArray(value) ? value : [];
const text = (value: any) => typeof value === 'string' ? value : '';
const changed = (result: any) => Number(result?.meta?.changes ?? result?.changes ?? 0);
const parse = (value: any, fallback: any): any => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
};
const rank = (severity: string) => severity === 'p0' ? 3 : severity === 'p1' ? 2 : severity === 'p2' ? 1 : 0;
const nowOf = (run: ApplyRun) => run.now ?? Date.now();

function sydneyOffset(at: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Australia/Sydney', timeZoneName: 'longOffset' }).formatToParts(new Date(at));
  const value = parts.find(part => part.type === 'timeZoneName')?.value ?? 'GMT+11:00';
  const match = value.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 3600000 + Number(match[3] ?? 0) * 60000);
}
function dayBounds(date: string): { start: number; end: number } {
  const guess = Date.parse(`${date}T00:00:00Z`);
  const start = guess - sydneyOffset(guess + 12 * 3600000);
  return { start, end: start + 86400000 };
}

/** A-quota: one developer-room line written by the main Worker's daily job. */
function morningQuota(value: any): { at: number; line: string } | null {
  const parsed = parse(value, null);
  if (!parsed || typeof parsed.line !== 'string') return null;
  const line = parsed.line.replace(/\s+/g, ' ').trim().slice(0, 200);
  const at = Number(parsed.at);
  if (!line || !Number.isFinite(at)) return null;
  return { at, line };
}

type Grouped = {
  fingerprint: string; severity: string; fix_layer: string; findings: Row[];
  evidence: any[]; allSingle: boolean; what_happened: string; expected: string;
  root_cause: string; next_attempt_plan: string;
};

/** Create proposal tasks for this run's gaps. P0 is immediate; P1 needs two occurrences. */
export async function proposeTasks(e: ReviewEnv, run: ApplyRun): Promise<number> {
  const ctx = metered(e), now = nowOf(run);
  const findings = await reviewRead<Row>(ctx,
    "SELECT * FROM review_findings WHERE run_id=? AND fingerprint IS NOT NULL AND status NOT IN ('disputed','rejected','wontfix','fixed') ORDER BY created_at,id",
    [run.id]);
  if (!findings.length) return 0;
  const grouped = new Map<string, Grouped>();
  for (const finding of findings) {
    const fingerprint = text(finding.fingerprint);
    if (!fingerprint) continue;
    const current = grouped.get(fingerprint);
    const evidence = arr(parse(finding.evidence_json, []));
    if (!current) {
      grouped.set(fingerprint, {
        fingerprint, severity: text(finding.severity), fix_layer: text(finding.fix_layer),
        findings: [finding], evidence, allSingle: finding.agreement === 'single',
        what_happened: text(finding.what_happened), expected: text(finding.expected),
        root_cause: text(finding.root_cause), next_attempt_plan: text(finding.next_attempt_plan),
      });
      continue;
    }
    current.findings.push(finding);
    current.allSingle &&= finding.agreement === 'single';
    if (rank(finding.severity) > rank(current.severity)) {
      current.severity = text(finding.severity); current.fix_layer = text(finding.fix_layer);
      current.evidence = evidence; current.what_happened = text(finding.what_happened);
      current.expected = text(finding.expected); current.root_cause = text(finding.root_cause);
      current.next_attempt_plan = text(finding.next_attempt_plan);
    }
  }
  const fingerprints = [...grouped.keys()];
  if (!fingerprints.length) return 0;
  const gaps = await reviewRead<Row>(ctx,
    'SELECT * FROM capability_gaps WHERE fingerprint IN (SELECT value FROM json_each(?))',
    [JSON.stringify(fingerprints)]);
  const gapMap = new Map(gaps.map(row => [row.fingerprint, row]));
  const covered = new Set((await reviewRead<Row>(ctx,
    'SELECT DISTINCT capability FROM capability_gaps WHERE external_ref IS NOT NULL')).map(row => text(row.capability)));
  const existing = await reviewRead<Row>(ctx,
    "SELECT id,source_id FROM tasks WHERE source_id IN (SELECT 'review:'||value FROM json_each(?))",
    [JSON.stringify(fingerprints)]);
  const existingByFp = new Map(existing.map((row) => [text(row.source_id).slice('review:'.length), text(row.id)] as const));

  const createdThisRun = await reviewRead<Row>(ctx,
    "SELECT COUNT(*) AS n FROM tasks WHERE created_at>=? AND source_id IN (SELECT 'review:'||fingerprint FROM review_findings WHERE run_id=?)",
    [new Date(now - 6 * 3600000).toISOString(), run.id]);
  const remaining = Math.max(0, 3 - Number(createdThisRun[0]?.n ?? 0));
  const candidates: { group: Grouped; gap: Row; input: GapTaskInput; rank: number }[] = [];
  for (const group of grouped.values()) {
    const gap = gapMap.get(group.fingerprint);
    if (!gap || !['open', 'regression', 'proposed'].includes(text(gap.status))) continue;
    if (gap.external_ref) continue;
    if (covered.has(text(gap.capability))) continue;
    if (existingByFp.has(group.fingerprint) && gap.status !== 'regression') continue;
    const occurrences = Number(gap.occurrences ?? 0);
    if (group.severity === 'p2') continue;
    if (group.severity === 'p1' && (occurrences < 2 || group.allSingle)) continue;
    if (group.severity !== 'p0' && group.severity !== 'p1') continue;
    candidates.push({
      group, gap,
      input: {
        fingerprint: group.fingerprint, gap_type: text(gap.gap_type), capability: text(gap.capability),
        severity: group.severity, fix_layer: group.fix_layer, evidence: group.evidence,
        occurrences, first_seen: Number(gap.first_seen), last_seen: Number(gap.last_seen),
        status: text(gap.status), proposed_action: text(gap.proposed_action), owner: text(gap.owner),
        what_happened: group.what_happened, expected: group.expected, root_cause: group.root_cause,
        next_attempt_plan: group.next_attempt_plan,
      },
      rank: rank(group.severity) * 1000 + occurrences,
    });
  }
  candidates.sort((a, b) => b.rank - a.rank || a.group.fingerprint.localeCompare(b.group.fingerprint));
  const statements: ReviewStatement[] = [];
  if (candidates.length && remaining > 0) {
    for (const candidate of candidates.slice(0, remaining)) {
      const task = await taskStatements(e, run, candidate.input, now);
      if (task.length) statements.push(...task);
    }
  }
  if (!statements.length) return 0;
  const results = await reviewBatch(e, statements);
  let created = 0;
  for (let index = 0; index < statements.length; index++) {
    if (/^INSERT OR IGNORE INTO tasks/.test(statements[index].sql)) created += changed(results[index]);
  }
  return created;
}

export type Digest = {
  date: string;
  groups: { group_id: string; run_id: string; step: string; mode: string; model: string | null; second_model: string | null }[];
  questions: {
    what_went_wrong: { findings: any[]; counts: { p0: number; p1: number; p2: number } };
    requirements: { rules: any[]; count: number };
    memory: { candidates: any[]; count: number; to_remember: number; to_forget: number };
    unanswered: { count: number; traces: string[] };
    to_change: { gaps: any[]; tasks: any[] };
  };
  promises: { open: number; kept: number; broken: number; cannot: number; unfulfilled: any[] };
  gaps: { new: any[]; escalated: any[]; open: number; regression: number };
  rules: { created: any[]; changed: any[]; active: number; canary: number };
  budget: { providers: any[]; monthly_usd_micros: number; month_cap_usd_micros: number };
  coverage: { balanced: boolean; runs: any[]; unaccounted: number };
  judge_failed: number;
  disputed: number;
  agreement: { agree: number; disagree: number; single: number; pending: number; rate: number | null };
  tasks: any[];
  findings: { total: number; p0: number; p1: number; p2: number };
  /** A-quota: developer-room line from quota:morning; null when absent. */
  quota: { at: number; line: string } | null;
};

/** One merged digest for one Sydney date, across all groups. */
export async function renderDigest(e: ReviewEnv, date: string): Promise<Digest> {
  const ctx = metered(e), { start, end } = dayBounds(date);
  const runs = await reviewRead<Row>(ctx, 'SELECT * FROM review_runs WHERE date=? ORDER BY group_id,id', [date]);
  const runIds = runs.map(row => text(row.id));
  const findings = runIds.length ? await reviewRead<Row>(ctx,
    'SELECT * FROM review_findings WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY CASE severity WHEN \'p0\' THEN 0 WHEN \'p1\' THEN 1 ELSE 2 END,created_at,id',
    [JSON.stringify(runIds)]) : [];
  const traces = runIds.length ? await reviewRead<Row>(ctx,
    'SELECT id,run_id,state,trace_json FROM review_traces WHERE run_id IN (SELECT value FROM json_each(?))',
    [JSON.stringify(runIds)]) : [];
  const promises = await reviewRead<Row>(ctx,
    'SELECT * FROM promises WHERE (created_at>=? AND created_at<?) OR (checked_at>=? AND checked_at<?) ORDER BY created_at,id',
    [start, end, start, end]);
  const gaps = await reviewRead<Row>(ctx,
    'SELECT * FROM capability_gaps WHERE (first_seen>=? AND first_seen<?) OR (last_seen>=? AND last_seen<?) ORDER BY last_seen DESC,fingerprint',
    [start, end, start, end]);
  const rules = await reviewRead<Row>(ctx,
    'SELECT * FROM behavior_rules WHERE (created_at>=? AND created_at<?) OR (updated_at>=? AND updated_at<?) ORDER BY updated_at DESC,id',
    [start, end, start, end]);
  const ruleCounts = await reviewRead<Row>(ctx,
    'SELECT status,COUNT(*) AS n FROM behavior_rules WHERE expires_at>? GROUP BY status', [start]);
  const memory = await reviewRead<Row>(ctx,
    'SELECT * FROM review_memory_candidates WHERE created_at>=? AND created_at<? ORDER BY created_at,id', [start, end]);
  const utcDays = [...new Set([new Date(start).toISOString().slice(0, 10), new Date(end - 1).toISOString().slice(0, 10)])];
  const budget = await reviewRead<Row>(ctx,
    'SELECT * FROM review_budget WHERE day_utc IN (SELECT value FROM json_each(?)) ORDER BY provider',
    [JSON.stringify(utcDays)]);
  const monthly = await reviewRead<Row>(ctx,
    "SELECT COALESCE(SUM(used),0) AS n FROM review_budget WHERE unit='usd_micros' AND substr(day_utc,1,7)=?",
    [date.slice(0, 7)]);
  const tasks = await reviewRead<Row>(ctx,
    "SELECT id,title,status,source_id,created_at FROM tasks WHERE source_id LIKE 'review:%' AND created_at>=? AND created_at<? ORDER BY created_at,id",
    [new Date(start).toISOString(), new Date(end).toISOString()]);
  const [quotaRow] = await reviewRead<Row>(ctx,
    'SELECT value FROM settings WHERE key=?', ['quota:morning']);
  const quota = morningQuota(quotaRow?.value);

  const counts = { p0: 0, p1: 0, p2: 0 };
  const agreement = { agree: 0, disagree: 0, single: 0, pending: 0, rate: null as number | null };
  let disputed = 0;
  for (const finding of findings) {
    if (finding.severity in counts) counts[finding.severity as keyof typeof counts]++;
    if (finding.agreement in agreement) (agreement as any)[finding.agreement]++;
    if (finding.status === 'disputed') disputed++;
  }
  const decided = agreement.agree + agreement.disagree;
  agreement.rate = decided ? agreement.agree / decided : null;

  const unanswered = traces.filter(trace => {
    const signals = arr(parse(trace.trace_json, {}).signals);
    return signals.includes('S1');
  }).map(trace => text(trace.id));
  const judgeFailed = traces.filter(trace => trace.state === 'judge_failed').length;

  const coverageRuns: any[] = [];
  let coverage = true, unaccounted = 0;
  for (const run of runs) {
    const raw = parse(run.stats, {});
    const item = raw?.coverage;
    if (!item) { coverage = false; continue; }
    const balanced = Number(item.messages) === Number(item.inbound_traces) + Number(item.skipped_by_rule)
      && Number(item.outbox) === Number(item.outbox_paired) + Number(item.outbox_standalone)
      && Number(item.unaccounted) === 0;
    coverage &&= balanced;
    unaccounted += Number(item.unaccounted ?? 0);
    coverageRuns.push({ run_id: run.id, group_id: run.group_id, ...item, balanced });
  }

  const newGaps = gaps.filter(gap => Number(gap.first_seen) >= start).map(gap => ({
    fingerprint: gap.fingerprint, gap_type: gap.gap_type, capability: gap.capability,
    occurrences: gap.occurrences, status: gap.status, first_seen: gap.first_seen,
  }));
  const escalated = gaps.filter(gap => Number(gap.first_seen) < start && Number(gap.last_seen) >= start).map(gap => ({
    fingerprint: gap.fingerprint, gap_type: gap.gap_type, capability: gap.capability,
    occurrences: gap.occurrences, status: gap.status, first_seen: gap.first_seen,
  }));
  const ruleItems = rules.map(rule => ({
    id: rule.id, rule: rule.rule, kind: rule.kind, status: rule.status, scene: rule.scene,
    hits: rule.hits, corrections: rule.corrections, expires_at: rule.expires_at,
  }));
  const createdRules = ruleItems.filter((_, index) => Number(rules[index].created_at) >= start);
  const changedRules = ruleItems.filter((_, index) => Number(rules[index].created_at) < start);
  const statusCount = (name: string) => Number(ruleCounts.find(row => row.status === name)?.n ?? 0);

  return {
    date,
    groups: runs.map(run => ({
      group_id: text(run.group_id), run_id: text(run.id), step: text(run.step), mode: text(run.mode),
      model: run.model ?? null, second_model: run.second_model ?? null,
    })),
    questions: {
      what_went_wrong: {
        findings: findings.filter(finding => finding.status !== 'disputed').map(finding => ({
          id: finding.id, trace_id: finding.trace_id, severity: finding.severity,
          capability: finding.capability, failure_type: finding.failure_type,
          what_happened: finding.what_happened, evidence: arr(parse(finding.evidence_json, [])),
        })),
        counts,
      },
      requirements: { rules: createdRules, count: createdRules.length },
      memory: {
        candidates: memory.map(item => ({ id: item.id, op: item.op, subject: item.subject, predicate: item.predicate, value: item.value, status: item.status })),
        count: memory.length,
        to_remember: memory.filter(item => item.op !== 'DELETE').length,
        to_forget: memory.filter(item => item.op === 'DELETE').length,
      },
      unanswered: { count: unanswered.length, traces: unanswered },
      to_change: { gaps: [...newGaps, ...escalated], tasks },
    },
    promises: {
      open: promises.filter(item => item.status === 'open').length,
      kept: promises.filter(item => item.status === 'kept').length,
      broken: promises.filter(item => item.status === 'broken').length,
      cannot: promises.filter(item => item.status === 'cannot').length,
      unfulfilled: promises.filter(item => ['broken', 'cannot'].includes(item.status)).map(item => ({
        id: item.id, what: item.what, status: item.status, due_at: item.due_at, recurring: item.recurring,
      })),
    },
    gaps: {
      new: newGaps, escalated,
      open: gaps.filter(gap => ['open', 'proposed', 'regression'].includes(gap.status)).length,
      regression: gaps.filter(gap => gap.status === 'regression').length,
    },
    rules: { created: createdRules, changed: changedRules, active: statusCount('active'), canary: statusCount('canary') },
    budget: {
      providers: budget.map(row => ({
        day_utc: row.day_utc, provider: row.provider, unit: row.unit, used: row.used,
        reserved: row.reserved, cap: row.cap, calls: row.calls,
      })),
      monthly_usd_micros: Number(monthly[0]?.n ?? 0),
      month_cap_usd_micros: Number((e as any).REVIEW_MONTH_CAP_USD_MICROS ?? 10000000),
    },
    coverage: { balanced: coverage && coverageRuns.length > 0, runs: coverageRuns, unaccounted },
    judge_failed: judgeFailed,
    disputed,
    agreement,
    tasks: tasks.map(task => ({ id: task.id, title: task.title, status: task.status, created_at: task.created_at })),
    findings: { total: findings.length, ...counts },
    quota,
  };
}
