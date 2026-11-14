// V-D-learning · L4：把本 run 的 primary ok 判决归成「群友要求」候选（review_learnings）。
// 这里只写 review_*；behavior_rules / schedules 的唯一写入入口是 L6（群友本人或管理员回复确认）。
import { metered } from '../d1';
import { learningId } from '../learning-types';
import { metaOf, quoteIn } from '../view';
import { reviewRead, reviewRedact, reviewSources, type ReviewEnv, type ReviewStatement } from './db';
import { phraseInOutbox, renderRule } from './rules';
import type { Agreement, RuleKind } from './types';

type Row = Record<string, any>;
/** 只有能写进 behavior_rules 的类型化规则才进晨报；free 要管理员批，mention_only_window 是即时窗口。 */
const LEARNABLE = new Set<string>(['avoid_phrase', 'address_as', 'reply_max_chars', 'burst_max', 'language', 'format_pref']);
const parse = (value: any, fallback: any = {}) => {
  try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; }
};
const text = (value: any) => typeof value === 'string' ? value : '';
const cut = (value: string, size: number) => Array.from(value).slice(0, size).join('');
const norm = (value: any) => String(value ?? '').trim().toLowerCase().replace(/^qq:/, '');
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export type LearningsRun = { id: string; group_id: string; mode?: string; now?: number };
type Candidate = {
  kind: 'rule' | 'schedule'; subkind: string; params: Record<string, any>;
  rule: string; scene: string; ttl_days: number; evidence: any[];
  time?: string; weekdays?: number[]; topic?: string; cadence?: 'daily' | 'weekly';
};
type Seed = {
  id: string; kind: 'rule' | 'schedule'; subkind: string; params: Record<string, any>; plain: string;
  requester: string; source_msg_id: string; quote: string; rule: string; scene: string; evidence: any[];
};
export type LearningsCommit = (extra: ReviewStatement[]) => Promise<void>;

/** 口语短句 ≤40 字；晨报只念这一句，不直接打印模型原文。 */
export function plainFor(kind: string, subkind: string, params: Record<string, any>): string {
  if (kind === 'schedule') {
    const time = String(params.time ?? '');
    const topic = String(params.topic ?? '');
    const days = Array.isArray(params.weekdays) ? params.weekdays.map((d: number) => '周' + (WEEKDAYS[d] ?? d)).join('、') : '';
    return cut(subkind === 'weekly' ? `每周${days}${time}发${topic}` : `每天${time}发${topic}`, 40);
  }
  if (subkind === 'avoid_phrase') return cut(`别再说「${String(params.phrase ?? '')}」`, 40);
  if (subkind === 'address_as') return cut(`以后叫我「${String(params.name ?? '')}」`, 40);
  if (subkind === 'reply_max_chars') return cut(`以后回复最多${Number(params.max)}字`, 40);
  if (subkind === 'burst_max') return cut(`每轮最多回复${Number(params.max)}条`, 40);
  if (subkind === 'language') return cut(`以后用${params.value === 'en' ? '英文' : '中文'}回复`, 40);
  if (subkind === 'format_pref') return cut(`回复多用${({ plain: '普通段落', list: '列表', table: '表格' } as Record<string, string>)[String(params.value)] ?? '普通段落'}`, 40);
  return cut(String(params.note ?? ''), 40);
}

/** 本条证据是不是「本人、没引用/转发、逐字」的原话（validate 已拦一次，写入候选前再验）。 */
function directSource(row: any, ev: any): boolean {
  if (!row?.member_id || ev?.source !== 'message' || typeof ev.quote !== 'string') return false;
  const meta = metaOf(row);
  if (meta.quoted || meta.forwarded?.length || meta.cardView || meta.bot || meta.senderBot) return false;
  return reviewRedact(ev.quote) === ev.quote && Array.from(ev.quote.trim()).length >= 4 && quoteIn(row, ev.quote);
}

/** 本 run 的判决摊平成候选；顺序固定（judgments 按 created_at,id，内部按数组顺序）。 */
export async function pendingCandidates(e: ReviewEnv, run: Row): Promise<Candidate[]> {
  const rows = await reviewRead<Row>(metered(e),
    "SELECT raw FROM review_judgments WHERE run_id=? AND role='primary' AND state='ok' ORDER BY created_at,id", [run.id]);
  const out: Candidate[] = [];
  for (const row of rows) {
    const raw = parse(row.raw);
    for (const req of Array.isArray(raw.requirements) ? raw.requirements : []) {
      if (!req || !LEARNABLE.has(text(req.kind)) || !req.params || typeof req.params !== 'object' || Array.isArray(req.params)) continue;
      out.push({ kind: 'rule', subkind: text(req.kind), params: req.params, rule: text(req.rule),
        scene: text(req.scene), ttl_days: Number(req.ttl_days), evidence: Array.isArray(req.evidence) ? req.evidence : [] });
    }
    for (const req of Array.isArray(raw.schedule_requests) ? raw.schedule_requests : []) {
      if (!req || !['daily', 'weekly'].includes(req.cadence)) continue;
      out.push({ kind: 'schedule', subkind: req.cadence, params: { time: req.time, ...(req.weekdays ? { weekdays: req.weekdays } : {}), topic: req.topic },
        rule: '', scene: '', ttl_days: 0, evidence: Array.isArray(req.evidence) ? req.evidence : [],
        cadence: req.cadence, time: req.time, weekdays: req.weekdays, topic: req.topic });
    }
  }
  return out;
}

/** 找第一条能对上原话的 message 证据（未绑定/已吊销/引用/转发都不算）。 */
async function admittedSource(e: ReviewEnv, group: string, evidence: any[]) {
  const ids = evidence.filter(ev => ev?.source === 'message' && typeof ev.id === 'string').map(ev => ev.id);
  if (!ids.length) return null;
  const rows = await reviewSources(metered(e), group, ids);
  for (const ev of evidence) {
    const row = rows.get(ev.id);
    if (row && directSource(row, ev)) return { row, ev };
  }
  return null;
}

async function agreementFor(e: ReviewEnv, run: Row, ids: string[]): Promise<Agreement> {
  const findings = await reviewRead<Row>(metered(e),
    'SELECT agreement,status,evidence_json FROM review_findings WHERE run_id=?', [run.id]);
  const wanted = new Set(ids);
  const hits = findings.filter(row => parse(row.evidence_json, []).some((ev: any) => wanted.has(ev?.id)));
  if (hits.some(row => row.agreement === 'disagree' || row.status === 'disputed')) return 'disagree';
  if (hits.some(row => row.agreement === 'agree')) return 'agree';
  return 'single';
}

async function seedOf(e: ReviewEnv, run: Row, candidate: Candidate, now: number): Promise<Seed | null> {
  const source = await admittedSource(e, run.group_id, candidate.evidence);
  if (!source) return null;
  const sender = text(source.row.sender);
  const evidence = [{ source: 'message', id: source.ev.id, quote: source.ev.quote }];
  if (candidate.kind === 'rule') {
    if (candidate.subkind === 'address_as' && norm(candidate.params.member) !== norm(sender)) return null;
    // 只能自己定自己的称呼：member 收敛成原话发送者，L6 写入前的严格比对才不会被 qq: 前缀卡住。
    const params = candidate.subkind === 'address_as'
      ? { member: sender, name: String(candidate.params.name ?? '').trim() }
      : candidate.params;
    const rule = renderRule(candidate.subkind as RuleKind, params, candidate.rule, candidate.ttl_days, sender);
    if (!rule) return null;
    if (candidate.subkind === 'avoid_phrase') {
      const phrase = String(params.phrase ?? '').trim();
      if (!phrase || !(await phraseInOutbox(e, run.group_id, phrase, now))) return null;
    }
    return { id: await learningId(run.group_id, 'rule', candidate.subkind, rule), kind: 'rule', subkind: candidate.subkind,
      params, plain: plainFor('rule', candidate.subkind, params), requester: sender,
      source_msg_id: source.ev.id, quote: source.ev.quote, rule, scene: cut(candidate.scene.trim(), 120), evidence };
  }
  const time = text(candidate.time), topic = text(candidate.topic).trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !topic || Array.from(topic).length > 40) return null;
  if (candidate.subkind === 'weekly' && !(candidate.weekdays?.length)) return null;
  const params = { time, ...(candidate.subkind === 'weekly' ? { weekdays: candidate.weekdays } : {}), topic };
  const key = [candidate.subkind, time, candidate.subkind === 'weekly' ? (candidate.weekdays ?? []).join(',') : '', topic].join('|');
  return { id: await learningId(run.group_id, 'schedule', candidate.subkind, key), kind: 'schedule', subkind: candidate.subkind,
    params, plain: plainFor('schedule', candidate.subkind, params), requester: sender,
    source_msg_id: source.ev.id, quote: source.ev.quote, rule: '', scene: '', evidence };
}

const minutesOf = (value: any): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const hour = Number(match[1]), minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null;
};
/** 同 time±10 分钟；跨午夜按环算。 */
export function sameTime(a: any, b: any): boolean {
  const x = minutesOf(a), y = minutesOf(b);
  if (x === null || y === null) return false;
  const delta = Math.abs(x - y);
  return Math.min(delta, 1440 - delta) <= 10;
}
const sameWeekdays = (a: any, b: any) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

/** covered：本群已有同规则，或同 time±10 分钟/同 topic 的 active 日程；full 模式下本 run 已写过同一原话的规则。 */
async function isCovered(e: ReviewEnv, run: Row, seed: Seed, now: number): Promise<boolean> {
  if (seed.kind === 'rule') {
    const hit = await reviewRead<Row>(metered(e), `SELECT 1 AS ok FROM behavior_rules WHERE group_id=? AND rule=?
      AND status IN ('candidate','canary','active','frozen') AND expires_at>? LIMIT 1`, [run.group_id, seed.rule, now]);
    if (hit.length) return true;
  } else {
    const rows = await reviewRead<Row>(metered(e), "SELECT kind,spec FROM schedules WHERE group_id=? AND status='active'", [run.group_id]);
    for (const row of rows) {
      const spec = parse(row.spec);
      if (seed.params.topic && spec.topic === seed.params.topic) return true;
      if (!sameTime(spec.time, seed.params.time)) continue;
      const weekly = row.kind === 'digest_weekly';
      // 每周只覆盖那一天，不能顶掉每天；每天能覆盖每周的同一条。
      if (seed.subkind === 'daily' && weekly) continue;
      if (seed.subkind === 'weekly' && weekly && !sameWeekdays(spec.weekdays, seed.params.weekdays)) continue;
      return true;
    }
  }
  if (run.mode === 'full') {
    const hit = await reviewRead<Row>(metered(e), `SELECT 1 AS ok FROM behavior_rules b, json_each(b.evidence_json) ev
      WHERE b.group_id=? AND b.source=? AND b.status!='retired' AND json_extract(ev.value,'$.id')=? LIMIT 1`,
      [run.group_id, 'review:' + run.id, seed.source_msg_id]);
    if (hit.length) return true;
  }
  return false;
}

function upsertStatement(seed: Seed, run: Row, agreement: Agreement, now: number): ReviewStatement {
  return {
    sql: `INSERT INTO review_learnings(id,group_id,kind,subkind,params,plain,requester,source_msg_id,quote,run_id,agreement,status,ask_count,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'proposed',0,?,?)
      ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,agreement=excluded.agreement,plain=excluded.plain,
        quote=excluded.quote,updated_at=excluded.updated_at,
        status=CASE WHEN review_learnings.status='covered' THEN 'proposed' ELSE review_learnings.status END
      WHERE review_learnings.group_id=excluded.group_id`,
    params: [seed.id, run.group_id, seed.kind, seed.subkind, JSON.stringify(seed.params), seed.plain, seed.requester,
      seed.source_msg_id, seed.quote, run.id, agreement, now, now],
  };
}

/**
 * 一个 tick 处理一条候选（跨 batch 稳定性靠 learning_offset，3 条上限靠 learning_new 持久化）。
 * commit 必须把 statements 与 run 的 CAS 一起提交（review 侧 planTick 的同一约定）。
 */
export async function learningsPhase(
  e: ReviewEnv, run: Row, stats: Row, now: number, commit: LearningsCommit,
): Promise<void> {
  const ctx = metered(e);
  if (!stats.learn_mode) {
    const rows = await reviewRead<Row>(ctx, "SELECT value FROM settings WHERE key='learn:mode'");
    stats.learn_mode = rows[0]?.value === 'off' ? 'off' : 'ask';   // v2：只有 ask|off，未知值按 ask
  }
  if (stats.learn_mode === 'off') { stats.phase = 'report'; await commit([]); return; }
  let candidates = await pendingCandidates(ctx, run);
  let offset = Number(stats.learning_offset ?? 0);
  if (offset >= candidates.length) { stats.phase = 'report'; await commit([]); return; }
  const statements: ReviewStatement[] = [];
  // 一个 tick 最多处理 3 条，既减少 5 分钟窗口里的 tick 数，又守住 48 条 D1 预算。
  for (let handled = 0; handled < 3 && offset < candidates.length && statements.length < 24; handled++, offset++) {
    const seed = await seedOf(ctx, run, candidates[offset], now);
    if (!seed) continue;
    const [existing] = await reviewRead<Row>(ctx, 'SELECT id,status FROM review_learnings WHERE id=?', [seed.id]);
    if (await isCovered(ctx, run, seed, now)) {
      // covered 只修正本群已有的待答候选；新要求不落库（施工单：covered → 不入库）。
      if (existing && ['proposed', 'asked'].includes(text(existing.status)))
        statements.push({ sql: "UPDATE review_learnings SET status='covered',updated_at=? WHERE id=? AND status IN ('proposed','asked')", params: [now, seed.id] });
    } else if (existing) {
      const agreement = await agreementFor(ctx, run, seed.evidence.map(ev => ev.id));
      statements.push(upsertStatement(seed, run, agreement, now));
    } else if (Number(stats.learning_new ?? 0) < 3) {
      stats.learning_new = Number(stats.learning_new ?? 0) + 1;
      const agreement = await agreementFor(ctx, run, seed.evidence.map(ev => ev.id));
      statements.push(upsertStatement(seed, run, agreement, now));
    }
  }
  stats.learning_offset = offset;
  if (offset >= candidates.length) stats.phase = 'report';
  await commit(statements);
}

