// V-D-learning · L4：晨报（reflection-report）成稿。
// 素材全部来自已落库、已校验的数据；findings 的一句口语由 DeepSeek 改一次（每群每天至多一次），
// 校验不过就只丢 findings 段，其余段纯模板照常出稿。
import { metered } from '../d1';
import { REPORT_DENY, reportOutboxId } from '../learning-types';
import { judgeModel, type JudgePrice } from './judge-model';
import type { JudgeCall } from './types';
import { reviewRead, reviewWrite, type ReviewEnv, type ReviewStatement } from './db';

type Row = Record<string, any>;
const MAX_LINES = 12;
const MAX_CHARS = 500;
const parse = (value: any, fallback: any = null) => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
};
const text = (value: any) => typeof value === 'string' ? value : '';
const cut = (value: string, size: number) => Array.from(value).slice(0, size).join('');
const denied = (value: string) => REPORT_DENY.some(word => value.toLowerCase().includes(String(word).toLowerCase()));

export type ReportLearning = { id: string; plain: string; requester_name: string };
export type ReportInput = {
  date: string; mode: string; dialogues: number;
  findings: string[]; learnings: ReportLearning[]; applied: { plain: string }[];
  promise: string | null; violation: { phrase: string; count: number } | null;
  skipped?: string | null;
};
export type ReportItem = { no: number; learning_id: string; applied: boolean };
export type ComposedReport = { body: string; items: ReportItem[]; skipped: string | null };

const asksHeader = (mode: string) => mode === 'shadow'
  ? '· 我打算记住这几条，本人回我「数字+可以」就行：'
  : '· 想记住这几条，本人回我「数字+可以」就行：';

/** 纯函数：固定模板 + 行数/字数上限；不碰 DB、不调模型。 */
export function composeReport(input: ReportInput): ComposedReport {
  if (input.skipped) return { body: '', items: [], skipped: input.skipped };
  const state = {
    findings: input.findings.filter(line => typeof line === 'string' && line.trim() && !denied(line))
      .map(line => cut(line.trim(), 40)).slice(0, 2),
    asks: input.learnings.filter(item => item && item.id && !denied(text(item.plain)) && !denied(text(item.requester_name)))
      .map(item => ({ id: String(item.id), plain: cut(text(item.plain).trim(), 40), name: cut(text(item.requester_name).trim() || '成员', 20) }))
      .slice(0, 3),
    applied: input.applied.filter(item => item && !denied(text(item.plain)))
      .map(item => cut(text(item.plain).trim(), 40)).slice(0, 2),
    promise: input.promise && !denied(input.promise) ? cut(String(input.promise).trim(), 40) : null,
    violation: input.violation && !denied(String(input.violation.phrase))
      ? { phrase: cut(String(input.violation.phrase), 12), count: Math.max(0, Math.floor(Number(input.violation.count) || 0)) } : null,
  };
  if (!state.findings.length && !state.asks.length && !state.applied.length && !state.promise && !state.violation)
    return { body: '', items: [], skipped: 'nothing_to_say' };
  const render = () => {
    const lines: string[] = [`早上好，我把昨天的聊天复盘了一遍（看了 ${Math.max(0, Math.floor(input.dialogues || 0))} 段对话）。`];
    for (const finding of state.findings) lines.push(`· 我发现：${finding}`);
    if (state.asks.length) {
      lines.push(asksHeader(input.mode));
      state.asks.forEach((item, index) => lines.push(` ${index + 1}）${item.name} 说${item.plain}`));
    }
    for (const item of state.applied) lines.push(`· 已经记住：${item}（不对就回这条说「不对」）`);
    if (state.promise) lines.push(`· 昨天说好的${state.promise}没做到，今天补上。`);
    if (state.violation) lines.push(`· 「${state.violation.phrase}」我昨天还是说了 ${state.violation.count} 次，继续改。`);
    return lines;
  };
  let lines = render();
  const over = () => lines.length > MAX_LINES || Array.from(lines.join('\n')).length > MAX_CHARS;
  // 从最不重要的段开始整段/整条丢，编号会随 asks 重新渲染。
  while (over()) {
    if (state.violation) { state.violation = null; lines = render(); continue; }
    if (state.promise) { state.promise = null; lines = render(); continue; }
    if (state.applied.length) { state.applied.pop(); lines = render(); continue; }
    if (state.asks.length) { state.asks.pop(); lines = render(); continue; }
    if (state.findings.length) { state.findings.pop(); lines = render(); continue; }
    break;
  }
  const items = state.asks.map((item, index) => ({ no: index + 1, learning_id: item.id, applied: false }));
  const body = lines.join('\n');
  return body.trim() ? { body, items, skipped: null } : { body: '', items: [], skipped: 'nothing_to_say' };
}

const REWRITE_SYSTEM = `你在给群聊写第二天的晨报。把每条复盘发现改写成一句口语：不超过 40 字，不用技术词，不写编号，不加引号，
不要编造数字（只能出现原文里已有的数字）。只输出 JSON：{"lines":["…"]}，条数与输入条数相同、顺序不变。`;

export type ReportResult = { statements: ReviewStatement[]; body: string; items: ReportItem[]; skipped: string | null; id: string | null };

function reportStatement(id: string, run: Row, body: string, items: ReportItem[], state: string, reason: string | null, now: number): ReviewStatement {
  return {
    sql: `INSERT OR IGNORE INTO review_reports(id,group_id,date,run_id,mode,body,items,state,reason,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`,
    params: [id, run.group_id, run.date, run.id, String(run.mode || 'shadow'), body, JSON.stringify(items), state, reason, now],
  };
}

async function reportIdFor(e: ReviewEnv, run: Row): Promise<string> {
  const rows = await reviewRead<Row>(metered(e), 'SELECT COUNT(DISTINCT group_id) AS n FROM review_runs WHERE date=?', [run.date]);
  return reportOutboxId(run.date, run.group_id, Number(rows[0]?.n ?? 1));
}

/** 一次 DeepSeek 改写；结果（含失败=[]）当天缓存进 activity，重试不再花第二次钱。 */
async function rewriteFindings(e: ReviewEnv, run: Row, findings: Row[], now: number, opts: { fetch?: typeof fetch }): Promise<string[] | null> {
  if (!findings.length) return [];
  const cacheId = `report-rewrite:${run.group_id}:${run.date}`;
  const cached = await reviewRead<Row>(metered(e), 'SELECT summary FROM activity WHERE id=?', [cacheId]);
  if (cached.length) {
    const lines = parse(cached[0].summary, null);
    return Array.isArray(lines) ? lines.map(String) : null;
  }
  const input = findings.map(row => ({ what_happened: text(row.what_happened), expected: text(row.expected) }));
  const source = input.map(row => row.what_happened + row.expected).join('\n');
  const call: JudgeCall = {
    provider: 'deepseek', model: String((e as any).DEEPSEEK_MODEL ?? 'deepseek-flash'),
    system: REWRITE_SYSTEM, user: JSON.stringify(input), max_tokens: 400, timeout_ms: 30000,
  };
  const price: JudgePrice = { unit: 'usd_micros', input: Number((e as any).DEEPSEEK_INPUT_USD_MICROS), output: Number((e as any).DEEPSEEK_OUTPUT_USD_MICROS) };
  let lines: string[] | null = null;
  try {
    const reply = await judgeModel(e, call, {
      price, now: () => now, fetch: opts.fetch,
      dayCap: Number((e as any).DEEPSEEK_DAY_CAP_USD_MICROS ?? 100000),
    });
    const value = parse(reply.text, null);
    const raw = Array.isArray(value?.lines) ? value.lines : null;
    if (raw && raw.length === findings.length && raw.every((line: any) =>
      typeof line === 'string' && Array.from(line).length <= 40 && !denied(line) &&
      (line.match(/\d+/g) ?? []).every((n: string) => source.includes(n)))) lines = raw;
  } catch { lines = null; }
  await reviewWrite(metered(e),
    "INSERT OR IGNORE INTO activity(id,kind,entity,actor,summary,created_at) VALUES(?,'review_report_rewrite',?,'review',?,?)",
    [cacheId, run.group_id, JSON.stringify(lines ?? []), new Date(now).toISOString()]);
  return lines;
}

async function memberNames(e: ReviewEnv, requesters: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(requesters)].flatMap(id => [id, id.startsWith('qq:') ? id : 'qq:' + id]);
  if (!ids.length) return new Map();
  const rows = await reviewRead<Row>(metered(e), 'SELECT id,name FROM members WHERE id IN (SELECT value FROM json_each(?))', [JSON.stringify(ids)]);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(String(row.id), text(row.name));
    map.set(String(row.id).replace(/^qq:/, ''), text(row.name));
  }
  return map;
}

/**
 * 晨报阶段：读素材 → 必要时改写 findings → 写 review_reports（ready|skipped）并把被问到的 learning 置 asked。
 * 返回的 statements 由 worker 与 run 的 CAS 一起提交；不在这里自己推进 run。
 */
export async function reportPhase(
  e: ReviewEnv, run: Row, stats: Row, now: number, opts: { fetch?: typeof fetch } = {},
): Promise<ReportResult> {
  const ctx = metered(e);
  const id = await reportIdFor(ctx, run);
  const learnMode = stats.learn_mode ?? (await reviewRead<Row>(ctx, "SELECT value FROM settings WHERE key='learn:mode'"))[0]?.value ?? 'ask';
  if (learnMode === 'off') return { statements: [], body: '', items: [], skipped: 'off', id: null };
  const skip = (reason: string): ReportResult => ({
    statements: [reportStatement(id, run, '', [], 'skipped', reason, now)], body: '', items: [], skipped: reason, id,
  });
  if (run.step === 'failed') return skip('run_failed');
  // 只数本 run 实际评过的 trace（跨晚复用的 trace 的 run_id 可能是前一晚的）。
  const [traceCounts] = await reviewRead<Row>(ctx, `SELECT COUNT(*) AS n,
    SUM(CASE WHEN t.state='judge_failed' THEN 1 ELSE 0 END) AS failed FROM review_traces t
    WHERE t.id IN (SELECT x.value FROM review_judgments j,json_each(j.trace_ids) x WHERE j.run_id=? AND j.role='primary')`, [run.id]);
  if (Number(traceCounts?.n ?? 0) > 0 && Number(traceCounts?.failed ?? 0) * 2 > Number(traceCounts.n)) return skip('judge_failed');

  await reviewWrite(ctx, "UPDATE review_learnings SET status='expired',updated_at=? WHERE group_id=? AND status IN ('proposed','asked') AND ask_count>=2",
    [now, run.group_id]);

  const findings = await reviewRead<Row>(ctx, `SELECT what_happened,expected FROM review_findings
    WHERE run_id=? AND severity IN ('p0','p1') AND status='open' AND agreement IN ('agree','single')
    ORDER BY CASE severity WHEN 'p0' THEN 0 ELSE 1 END,created_at,id LIMIT 2`, [run.id]);
  const learnings = await reviewRead<Row>(ctx, `SELECT id,plain,requester FROM review_learnings
    WHERE group_id=? AND status IN ('proposed','asked') AND ask_count<2 ORDER BY created_at,id LIMIT 3`, [run.group_id]);
  const [previous] = await reviewRead<Row>(ctx, `SELECT created_at FROM review_reports
    WHERE group_id=? AND date<? ORDER BY date DESC LIMIT 1`, [run.group_id, run.date]);
  const cutoff = Number(previous?.created_at ?? Date.parse(run.window_start));
  const appliedLearnings = await reviewRead<Row>(ctx, `SELECT plain,applied_ref FROM review_learnings
    WHERE group_id=? AND status='applied' AND updated_at>=? ORDER BY updated_at DESC,id LIMIT 2`, [run.group_id, cutoff]);
  const refs = appliedLearnings.map(row => text(row.applied_ref)).filter(Boolean);
  const appliedRules = await reviewRead<Row>(ctx, `SELECT rule FROM behavior_rules
    WHERE group_id=? AND source LIKE 'member:%' AND status IN ('canary','active') AND created_at>=?
      AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC,id LIMIT 2`,
    [run.group_id, cutoff, JSON.stringify(refs)]);
  const [promise] = await reviewRead<Row>(ctx, `SELECT what FROM promises
    WHERE group_id=? AND status IN ('broken','cannot') AND checked_at>=? AND checked_at<?
    ORDER BY checked_at DESC,id LIMIT 1`, [run.group_id, Date.parse(run.window_start), Date.parse(run.window_end)]);
  const [violation] = await reviewRead<Row>(ctx, `SELECT b.params,COUNT(a.id) AS n FROM behavior_rules b
    JOIN activity a ON a.entity=b.id AND a.kind='rule.violation'
    WHERE b.group_id=? AND b.kind='avoid_phrase' AND b.status IN ('canary','active') AND a.created_at>=? AND a.created_at<?
    GROUP BY b.id ORDER BY n DESC,b.id LIMIT 1`, [run.group_id, run.window_start, run.window_end]);

  if (!findings.length && !learnings.length && !appliedLearnings.length && !appliedRules.length && !promise && !violation) return skip('nothing_to_say');

  const names = await memberNames(ctx, learnings.map(row => text(row.requester)));
  // 第三晚被迫发布沿用既有「不再产生新的付费调用」约束：改写跳过，findings 段整段省略。
  const lines = stats.forced_publish ? null : await rewriteFindings(ctx, run, findings, now, opts);
  const dialogues = Number((await reviewRead<Row>(ctx, "SELECT COUNT(*) AS n FROM review_traces WHERE run_id=? AND kind='inbound'", [run.id]))[0]?.n ?? 0)
    || Number(parse(run.stats)?.coverage?.messages ?? 0);
  const violationParams = parse(violation?.params, {});
  const composed = composeReport({
    date: run.date, mode: String(run.mode || 'shadow'), dialogues,
    findings: lines ?? [],
    learnings: learnings.map(row => ({ id: text(row.id), plain: text(row.plain), requester_name: names.get(text(row.requester)) || '成员' })),
    applied: [...appliedLearnings.map(row => ({ plain: text(row.plain) })), ...appliedRules.map(row => ({ plain: text(row.rule) }))],
    promise: promise ? text(promise.what) : null,
    violation: violation ? { phrase: text(violationParams.phrase), count: Number(violation.n) } : null,
  });
  if (composed.skipped) return skip(composed.skipped);
  const statements: ReviewStatement[] = [reportStatement(id, run, composed.body, composed.items, 'ready', null, now)];
  if (composed.items.length) statements.push({
    sql: `UPDATE review_learnings SET status='asked',ask_count=ask_count+1,updated_at=?
      WHERE group_id=? AND id IN (SELECT value FROM json_each(?)) AND status IN ('proposed','asked') AND ask_count<2`,
    params: [now, run.group_id, JSON.stringify(composed.items.map(item => item.learning_id))],
  });
  return { statements, body: composed.body, items: composed.items, skipped: null, id };
}
