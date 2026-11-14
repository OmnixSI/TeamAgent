#!/usr/bin/env node
/**
 * D-8 · 工作室侧拉取：backlog 镜像 + 晨报
 *
 * Reads the review Worker's read-only endpoints:
 *   GET /review/digest?date=YYYY-MM-DD
 *   GET /review/backlog.md?date=YYYY-MM-DD
 *
 * Writes (local only, never D1):
 *   .agent/backlog/self-review/<date>.md
 *   .agent/backlog/capability-gaps.md   (merged by fingerprint, human notes kept)
 *
 * Prints a morning report of at most 15 lines to stdout.
 *
 * Token: REVIEW_TOKEN_FILE (or --token-file). The token is only sent in the
 * Authorization header; it is never printed, logged or written to disk.
 * Without a token the script falls back to read-only `wrangler d1 execute
 * --remote --command "SELECT ..."` and asserts rows_written == 0 before it
 * writes any local file. Tests exercise that path with an injected query.
 *
 * No long-running process, no QQ calls, no D1 writes.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const SYDNEY = 'Australia/Sydney';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const OPEN_STATUSES = new Set(['open', 'proposed', 'regression', 'candidate', 'canary', 'active']);
// A-quota: quota:morning is written daily by the main Worker; older lines are
// dropped so a stopped job cannot keep printing an old balance.
const QUOTA_LINE_FRESH_MS = 36 * 60 * 60 * 1000;

const FIELD_MAP = {
  指纹: 'fingerprint',
  能力: 'capability',
  缺口类型: 'gap_type',
  修复层: 'fix_layer',
  负责人: 'owner',
  状态: 'status',
  出现次数: 'occurrences',
  首次: 'first_seen',
  最近: 'last_seen',
  建议派给: 'assignee',
  fingerprint: 'fingerprint',
  capability: 'capability',
  gap_type: 'gap_type',
  type: 'gap_type',
  fix_layer: 'fix_layer',
  owner: 'owner',
  status: 'status',
  occurrences: 'occurrences',
  次数: 'occurrences',
  类型: 'gap_type',
  first_seen: 'first_seen',
  last_seen: 'last_seen',
};

const OWNER_BY_GAP = {
  tool_missing: '工程师',
  tool_not_selected: '工程师',
  tool_failed: '工程师',
  prompt_rule_missing: '主程',
  capability_offline: '交付员',
  switch_or_policy_off: '交付员',
  data_stale_or_coverage: '交付员',
  regression: '工程师',
};

const HELP = `Usage: node scripts/review-pull.mjs [options]

  --date YYYY-MM-DD     Sydney snapshot date (default: today in Sydney)
  --base-url URL        review Worker base URL (default: REVIEW_BASE_URL or http://127.0.0.1:8787)
  --out DIR             output root (default: <cwd>/.agent/backlog)
  --token-file FILE     token file (default: REVIEW_TOKEN_FILE)
  --db NAME             D1 database for the read-only fallback (default: REVIEW_D1_DB or inkboard-team)
  -h, --help            show this help

Without a token the script uses only SELECT statements through
\`wrangler d1 execute --remote --command ...\` and aborts if rows_written != 0.
`;

function text(value) {
  return value == null ? '' : String(value);
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function countOf(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;
  return value == null ? fallback : num(value, fallback);
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function sha1(value) {
  return createHash('sha1').update(String(value)).digest('hex');
}

function assertDate(date) {
  if (!DATE_RE.test(text(date))) throw new Error(`invalid date: ${text(date)} (expected YYYY-MM-DD)`);
}

function sydneyOffset(at) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SYDNEY, timeZoneName: 'longOffset',
  }).formatToParts(new Date(at));
  const value = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+11:00';
  const match = value.match(/GMT([+-])(\d{2}):(\d{2})/);
  if (!match) return 11 * 3600000;
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 3600000 + Number(match[3]) * 60000);
}

export function sydneyDayBounds(date) {
  assertDate(date);
  const guess = Date.parse(`${date}T00:00:00Z`);
  const start = guess - sydneyOffset(guess + 12 * 3600000);
  return { start, end: start + 86400000 };
}

export function sydneyDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SYDNEY, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

function utcDaysFor(date) {
  const { start, end } = sydneyDayBounds(date);
  return [...new Set([
    new Date(start).toISOString().slice(0, 10),
    new Date(end - 1).toISOString().slice(0, 10),
  ])];
}

function parseDateMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value) {
  const ms = parseDateMs(value);
  return ms == null ? '' : new Date(ms).toISOString();
}

function redact(value, token = '') {
  let out = text(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, 'sk-***');
  if (token) out = out.split(token).join('***');
  return out;
}

function oneLine(value, limit = 120) {
  const clean = text(value).replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function cell(value, limit = 80) {
  return oneLine(value, limit).replace(/\|/g, '\\|');
}

function usd(micros) {
  return `$${(num(micros) / 1e6).toFixed(4)}`;
}

function relativePath(path) {
  const rel = relative(process.cwd(), path);
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : path;
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

function extractBetween(source, begin, end) {
  const start = source.indexOf(begin);
  if (start < 0) return null;
  const from = start + begin.length;
  const stop = source.indexOf(end, from);
  if (stop < 0) return null;
  return source.slice(from, stop);
}

function uniqueLines(lines) {
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const value = text(line).trimEnd();
    if (!value.trim() || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function parseBacklogMarkdown(markdown) {
  const source = text(markdown);
  if (!source.trim()) return [];

  // Tolerate a JSON array/object if a future backend returns JSON on this route.
  if (/^\s*[[{]/.test(source)) {
    const parsed = parseJson(source, null);
    const items = Array.isArray(parsed) ? parsed : arr(parsed?.gaps);
    if (items.length) return dedupeEntries(items.map(normalizeGap));
  }

  const blocks = [];
  const heading = /^#\s*能力缺口提案（gap:v1）\s*$/gm;
  let starts = [...source.matchAll(heading)].map((match) => match.index);
  // One document title may wrap several gaps as `## <capability> · <gap_type>`
  // sections. In that case split at the sections, not at the single title.
  if (starts.length <= 1) {
    const sections = [...source.matchAll(/^##\s+[^\n]*·[^\n]*$/gm)].map((match) => match.index);
    if (sections.length) starts = sections;
  }
  if (!starts.length) {
    const table = parseGapTable(source);
    if (table.length) return dedupeEntries(table);
    return [];
  }

  for (let index = 0; index < starts.length; index++) {
    const start = starts[index];
    const end = index + 1 < starts.length ? starts[index + 1] : source.length;
    blocks.push(source.slice(start, end));
  }

  return dedupeEntries(blocks.map(parseGapBlock));
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
}

function parseGapTable(source) {
  const lines = source.split('\n');
  for (let index = 0; index + 1 < lines.length; index++) {
    if (!/^\s*\|/.test(lines[index])) continue;
    const headers = splitTableRow(lines[index]).map((header) => header.trim());
    const keys = headers.map((header) => FIELD_MAP[header] || FIELD_MAP[header.replace(/\s+/g, '')] || null);
    if (!keys.includes('fingerprint')) continue;
    if (!/^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1])) continue;
    const out = [];
    for (let row = index + 2; row < lines.length && /^\s*\|/.test(lines[row]); row++) {
      const cells = splitTableRow(lines[row]);
      const raw = {};
      keys.forEach((key, column) => {
        if (key && cells[column] != null) raw[key] = cells[column].trim();
      });
      if (raw.fingerprint) out.push(normalizeGap(raw));
    }
    return out;
  }
  return [];
}

function parseGapBlock(block) {
  const fields = {};
  const evidence = [];
  let section = '';
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^#\s+/.test(line)) {
      // The document title is not a section; keep reading top-level fields.
      section = '';
      continue;
    }
    if (/^#{2,3}\s+/.test(line)) {
      const heading = line.replace(/^#{2,3}\s+/, '').trim();
      section = /^gap:v1$/i.test(heading) || heading.includes('·') ? '' : heading;
      continue;
    }
    const bullet = line.match(/^\s*-\s*(.+)$/);
    if (!bullet) continue;
    const body = bullet[1];
    if (section.startsWith('证据')) {
      evidence.push(body);
      continue;
    }
    if (section) continue;
    const field = body.match(/^([^:：]{1,16})[:：]\s*(.*)$/);
    if (!field) continue;
    const key = FIELD_MAP[field[1].trim()];
    if (key) fields[key] = field[2].trim();
  }

  const gap = normalizeGap(fields);
  if (evidence.length) gap.evidence_text = evidence.join('\n');
  const rawStatus = text(fields.status).toLowerCase();
  if (/disputed|待复核|disagree/.test(rawStatus)) gap.status = 'disputed';
  else if (/^#{1,3}[^\n]*(disputed|待复核)/im.test(block)) gap.status = 'disputed';
  return gap;
}

function normalizeGap(raw) {
  const item = raw && typeof raw === 'object' ? raw : {};
  const gapType = text(item.gap_type ?? item.gapType ?? item.type) || 'unknown';
  const capability = text(item.capability ?? item.cap) || 'unknown';
  const firstSeen = parseDateMs(item.first_seen ?? item.firstSeen);
  const fingerprint = text(item.fingerprint ?? item.fp)
    || `syn-${sha1(`${capability}|${gapType}|${firstSeen ?? ''}`).slice(0, 16)}`;
  return {
    fingerprint,
    capability,
    gap_type: gapType,
    status: text(item.status) || 'open',
    occurrences: num(item.occurrences ?? item.count, 1),
    first_seen: firstSeen,
    last_seen: parseDateMs(item.last_seen ?? item.lastSeen),
    fix_layer: text(item.fix_layer ?? item.fixLayer),
    owner: text(item.owner),
    proposed_action: text(item.proposed_action ?? item.proposedAction),
    expected: text(item.expected),
    what_happened: text(item.what_happened ?? item.whatHappened),
    root_cause: text(item.root_cause ?? item.rootCause),
    next_attempt_plan: text(item.next_attempt_plan ?? item.nextAttemptPlan),
    evidence: arr(item.evidence),
    evidence_text: text(item.evidence_text),
  };
}

function dedupeEntries(entries) {
  const map = new Map();
  for (const entry of arr(entries)) {
    const gap = normalizeGap(entry);
    const existing = map.get(gap.fingerprint);
    if (!existing) {
      map.set(gap.fingerprint, gap);
      continue;
    }
    for (const [key, value] of Object.entries(gap)) {
      if (value == null || value === '') continue;
      if (Array.isArray(value) && value.length === 0) continue;
      if (existing[key] == null || existing[key] === '' || (Array.isArray(existing[key]) && existing[key].length === 0)) {
        existing[key] = value;
      }
    }
  }
  return [...map.values()];
}

function isOpenStatus(status) {
  return OPEN_STATUSES.has(text(status));
}

function suggestOwner(gap) {
  return text(gap?.owner)
    || OWNER_BY_GAP[text(gap?.gap_type)]
    || '主程';
}

function gapsFromDigest(digest) {
  const d = digest || {};
  const pools = [
    arr(d.gaps?.new),
    arr(d.gaps?.escalated),
    arr(d.gaps?.all),
    arr(d.gaps?.open_items),
    arr(d.questions?.to_change?.gaps),
    arr(d.disputed_items),
  ];
  return dedupeEntries(pools.flat().map(normalizeGap));
}

function mergeGapEntries(primary, secondary) {
  const merged = dedupeEntries(primary);
  const known = new Set(merged.map((gap) => gap.fingerprint));
  for (const gap of dedupeEntries(secondary)) {
    if (!known.has(gap.fingerprint)) {
      merged.push(gap);
      known.add(gap.fingerprint);
    }
  }
  return merged;
}

function gapEvidenceLines(gap) {
  if (gap.evidence_text) return gap.evidence_text.split('\n').slice(0, 20);
  return arr(gap.evidence).slice(0, 10).map((evidence) => {
    const source = text(evidence?.source) || 'evidence';
    const id = text(evidence?.id) || '?';
    const rowid = evidence?.rowid == null ? '' : `（rowid=${evidence.rowid}）`;
    const quote = evidence?.quote ? `「${text(evidence.quote)}」` : '';
    return `${source}:${id}${rowid}${quote}`;
  });
}

function renderLedgerBlock(gap, notes, meta) {
  const lines = [
    `<!-- gap:${gap.fingerprint} -->`,
    `## ${text(gap.capability)} · ${text(gap.gap_type)}`,
    `- 指纹：${gap.fingerprint}`,
    `- 能力：${text(gap.capability)}`,
    `- 缺口类型：${text(gap.gap_type)}`,
  ];
  if (gap.fix_layer) lines.push(`- 修复层：${gap.fix_layer}`);
  if (gap.owner) lines.push(`- 负责人：${gap.owner}`);
  lines.push(`- 状态：${text(gap.status) || 'open'}`);
  lines.push(`- 出现次数：${num(gap.occurrences, 1)}`);
  if (gap.first_seen != null) lines.push(`- 首次：${iso(gap.first_seen)}`);
  if (gap.last_seen != null) lines.push(`- 最近：${iso(gap.last_seen)}`);
  lines.push(`- 建议派给：${suggestOwner(gap)}`);
  lines.push(`- 来源：${text(meta.date)}`);

  const evidence = gapEvidenceLines(gap);
  if (evidence.length) {
    lines.push('', '## 证据（逐字）', ...evidence.map((line) => `- ${line}`));
  }
  lines.push('<!-- note:begin -->');
  lines.push(...uniqueLines(notes));
  lines.push('<!-- note:end -->');
  lines.push(`<!-- /gap:${gap.fingerprint} -->`);
  return lines.join('\n');
}

export function parseLedger(source) {
  const content = text(source);
  let human = extractBetween(content, '<!-- human:begin -->', '<!-- human:end -->');
  if (human == null) {
    const match = content.match(/##\s*人工批注\s*\n([\s\S]*?)(?=\n<!-- gap:|\n##\s|$)/);
    human = match ? match[1] : '';
  }
  const blocks = [];
  const pattern = /<!-- gap:([^\s>]+) -->\n([\s\S]*?)<!-- \/gap:\1 -->/g;
  for (const match of content.matchAll(pattern)) {
    const fingerprint = match[1];
    const body = match[2].replace(/\s+$/, '');
    const noteBlock = extractBetween(body, '<!-- note:begin -->', '<!-- note:end -->');
    let outside = body;
    if (noteBlock != null) outside = body.replace(/<!-- note:begin -->[\s\S]*?<!-- note:end -->/, '');
    const notes = [];
    if (noteBlock != null) notes.push(...noteBlock.split('\n').filter((line) => line.trim()));
    for (const line of outside.split('\n')) {
      if (/^\s*>/.test(line)) notes.push(line);
    }
    blocks.push({ fingerprint, body, notes: uniqueLines(notes) });
  }
  return { human: human ?? '', blocks };
}

export function mergeLedger(existing, entries, meta = {}) {
  const old = parseLedger(existing);
  const oldByFp = new Map(old.blocks.map((block) => [block.fingerprint, block]));
  const seen = new Set();
  const rendered = [];

  const sorted = dedupeEntries(entries).sort((a, b) => {
    const delta = num(b.last_seen) - num(a.last_seen);
    return delta || a.fingerprint.localeCompare(b.fingerprint);
  });
  for (const gap of sorted) {
    seen.add(gap.fingerprint);
    const notes = oldByFp.get(gap.fingerprint)?.notes ?? [];
    rendered.push(renderLedgerBlock(gap, notes, meta));
  }
  // Entries absent from today's feed stay in the ledger (they may be open from
  // an earlier night); their body — including human notes — is left untouched.
  for (const block of old.blocks) {
    if (seen.has(block.fingerprint)) continue;
    rendered.push(`<!-- gap:${block.fingerprint} -->\n${block.body}\n<!-- /gap:${block.fingerprint} -->`);
  }

  const keptBlocks = old.blocks.filter((block) => !seen.has(block.fingerprint));
  const statusOfBlock = (block) => text(block.body.match(/^- 状态：(.+)$/m)?.[1]);
  const statuses = [
    ...sorted.map((gap) => gap.status),
    ...keptBlocks.map(statusOfBlock),
  ];
  const disputed = statuses.filter((status) => status === 'disputed').length;
  const open = statuses.filter((status) => isOpenStatus(status) && status !== 'disputed').length;
  const lines = [
    '# 能力缺口台账（自动镜像）',
    '',
    `- 快照日期：${text(meta.date)}`,
    `- 来源：${text(meta.baseUrl) || '—'}`,
    `- 条目：${sorted.length + keptBlocks.length}（open ${open} / disputed ${disputed}）`,
    '- 说明：自动生成；人工批注写在 <!-- note:begin -->…<!-- note:end --> 之间或「人工批注」段，重跑会保留。',
    '',
    '## 人工批注',
    '<!-- human:begin -->',
    ...(old.human.trim() ? old.human.replace(/^\n+|\n+$/g, '').split('\n') : []),
    '<!-- human:end -->',
    '',
    rendered.join('\n\n'),
    '',
  ];
  return lines.join('\n');
}

function budgetRows(digest) {
  const rows = arr(digest?.budget?.providers);
  const date = text(digest?.date);
  if (!DATE_RE.test(date)) return rows;
  const days = new Set(utcDaysFor(date));
  const filtered = rows.filter((row) => !row?.day_utc || days.has(text(row.day_utc)));
  return filtered.length ? filtered : rows;
}

function aggregateBudget(rows) {
  const map = new Map();
  for (const row of rows) {
    const provider = text(row?.provider) || 'unknown';
    const unit = text(row?.unit) || 'unknown';
    const current = map.get(provider) ?? { provider, used: 0, cap: 0, reserved: 0, calls: 0, units: new Set() };
    current.used += num(row?.used);
    current.cap += num(row?.cap);
    current.reserved += num(row?.reserved);
    current.calls += num(row?.calls);
    current.units.add(unit);
    map.set(provider, current);
  }
  return [...map.values()];
}

function budgetValue(value, unit) {
  if (unit === 'usd_micros') return usd(value);
  if (unit === 'neurons') return `${num(value)} neurons`;
  return `${num(value)} ${unit}`;
}

function budgetText(digest) {
  const rows = budgetRows(digest);
  if (!rows.length) return '无数据';
  // A Sydney day can span two UTC budget days. Show only the rows that actually
  // had traffic; otherwise a zero row from the neighbouring UTC day would
  // silently double the displayed cap.
  const active = rows.filter((row) => num(row.used) || num(row.reserved) || num(row.calls));
  const pool = active.length ? active : rows;
  const byProvider = new Map();
  for (const row of pool) {
    const provider = text(row.provider) || 'unknown';
    if (!byProvider.has(provider)) byProvider.set(provider, []);
    byProvider.get(provider).push(row);
  }
  const parts = [...byProvider.entries()].map(([provider, items]) => {
    if (items.length === 1) {
      const row = items[0];
      return `${provider} ${budgetValue(row.used, row.unit)} / ${budgetValue(row.cap, row.unit)}`;
    }
    return `${provider} ${items.map((row) => `${budgetValue(row.used, row.unit)}/${budgetValue(row.cap, row.unit)}（${text(row.day_utc).slice(5)}）`).join(' + ')}`;
  });

  let monthly = null;
  if (digest?.budget?.monthly_usd_micros != null) monthly = num(digest.budget.monthly_usd_micros);
  else if (digest?.budget?.month_usd != null) monthly = num(digest.budget.month_usd) * 1e6;
  else if (digest?.budget?.monthly_usd != null) monthly = num(digest.budget.monthly_usd) * 1e6;

  let cap = 10000000;
  if (digest?.budget?.month_cap_usd_micros != null) cap = num(digest.budget.month_cap_usd_micros);
  else if (digest?.budget?.month_cap_usd != null) cap = num(digest.budget.month_cap_usd) * 1e6;

  const monthlyText = monthly == null ? '当月 无数据' : `当月 ${usd(monthly)} / ${usd(cap)}`;
  return `${parts.join(' · ')}；${monthlyText}`;
}

function coverageText(digest) {
  const coverage = digest?.coverage;
  if (!coverage) return '无数据';
  const runs = arr(coverage.runs).length;
  const unaccounted = num(coverage.unaccounted);
  return coverage.balanced
    ? `平（${runs} 个 run，unaccounted ${unaccounted}）`
    : `不平（${runs} 个 run，unaccounted ${unaccounted}）`;
}

function agreementText(digest) {
  const agreement = digest?.agreement ?? {};
  const rate = agreement.rate;
  let percent = '—';
  if (rate != null && Number.isFinite(Number(rate))) {
    const value = Number(rate) <= 1 ? Number(rate) * 100 : Number(rate);
    percent = `${value.toFixed(1)}%`;
  }
  return `${percent}（agree ${num(agreement.agree)} / disagree ${num(agreement.disagree)} / single ${num(agreement.single)}）`;
}

function claimedQqSent(digest) {
  const candidates = [
    digest?.safety?.qq_sent,
    digest?.qq_sent,
    digest?.sent,
    digest?.stats?.qq_sent,
    digest?.safety?.qq_real_sends,
  ];
  for (const value of candidates) {
    if (value != null && Number.isFinite(Number(value))) return num(value);
  }
  return 0;
}

function claimedD1Writes(digest) {
  const candidates = [
    digest?.safety?.d1_rows_written,
    digest?.d1_rows_written,
    digest?.stats?.d1_rows_written,
    digest?.rows_written,
  ];
  for (const value of candidates) {
    if (value != null && Number.isFinite(Number(value))) return num(value);
  }
  return 0;
}

function assignmentGroups(gaps) {
  const open = gaps.filter((gap) => isOpenStatus(gap.status) && gap.status !== 'disputed');
  const map = new Map();
  for (const gap of open) {
    const owner = suggestOwner(gap);
    if (!map.has(owner)) map.set(owner, []);
    map.get(owner).push(gap);
  }
  return [...map.entries()].map(([owner, items]) => ({
    owner,
    count: items.length,
    types: [...new Set(items.map((gap) => text(gap.gap_type) || 'unknown'))],
  }));
}

function assignmentText(gaps) {
  const groups = assignmentGroups(gaps);
  if (!groups.length) return '无 open 缺口';
  return groups.map((group) => `${group.owner} ${group.count}（${group.types.join(' / ')}）`).join('；');
}

export function buildMorningReport({
  date, digest, gaps = [], baseUrl = '', mirrorPath = '', ledgerPath = '', safety = {}, now = Date.now(),
}) {
  const d = digest || {};
  const qqSent = num(safety?.qq_sent ?? claimedQqSent(d));
  const d1Writes = num(safety?.d1_rows_written ?? claimedD1Writes(d));
  const safetyHead = qqSent === 0 && d1Writes === 0
    ? 'QQ 真实发送 0 次、线上 D1 写入 0 行'
    : `QQ 真实发送 ${qqSent} 次、线上 D1 写入 ${d1Writes} 行`;

  const groups = arr(d.groups).length;
  const modes = [...new Set(arr(d.groups).map((group) => text(group?.mode)).filter(Boolean))].join('/');
  const counts = d?.questions?.what_went_wrong?.counts ?? d?.findings ?? {};
  const unanswered = d?.questions?.unanswered?.count ?? arr(d?.questions?.unanswered?.traces).length;
  const tasks = arr(d.tasks).length;
  const disputedFindings = arr(d?.questions?.what_went_wrong?.findings)
    .filter((finding) => finding?.status === 'disputed' || finding?.agreement === 'disagree');
  const disputedGaps = gaps.filter((gap) => gap.status === 'disputed');
  const disputedList = Array.isArray(d.disputed) ? d.disputed : [];
  const disputed = d.disputed == null
    ? disputedGaps.length + disputedFindings.length
    : countOf(d.disputed);
  const disputedItems = [...new Set([
    ...disputedGaps.map((gap) => `${text(gap.capability)} · ${text(gap.gap_type)}`),
    ...disputedFindings.map((finding) => `${text(finding.capability)} · ${text(finding.failure_type)}`),
    ...disputedList.map((item) => `${text(item?.capability)} · ${text(item?.gap_type ?? item?.failure_type)}`),
  ].filter((item) => item !== ' · '))];

  const lines = [
    `${safetyHead} · 复盘 ${date} · ${groups} 个群/run${modes ? ` · ${modes}` : ''}`,
    `问题：p0 ${num(counts.p0)} / p1 ${num(counts.p1)} / p2 ${num(counts.p2)}；未回答 S1 ${num(unanswered)}；任务提案 ${tasks}`,
    `预算：${budgetText(d)}`,
    `覆盖账：${coverageText(d)}`,
    `judge_failed：${countOf(d.judge_failed)}（评判方失败，不算 bot 的问题）`,
    `双判一致率：${agreementText(d)}；待复核 ${disputed}`,
    `待复核：${disputed} 条${disputedItems.length ? `（${disputedItems.slice(0, 3).join('；')}）` : ''}`,
    `缺口：新增 ${arr(d?.gaps?.new).length} / 升级 ${arr(d?.gaps?.escalated).length} / open ${num(d?.gaps?.open)} / regression ${num(d?.gaps?.regression)}`,
    `规则：新增 ${arr(d?.rules?.created).length} / 变更 ${arr(d?.rules?.changed).length} / 生效 ${num(d?.rules?.active)} / 试用 ${num(d?.rules?.canary)}`,
    `承诺：open ${num(d?.promises?.open)} / kept ${num(d?.promises?.kept)} / broken ${num(d?.promises?.broken)} / cannot ${num(d?.promises?.cannot)}`,
    `建议派给：${assignmentText(gaps)}`,
    `镜像：${relativePath(mirrorPath || '-')} + ${relativePath(ledgerPath || '-')}（${gaps.length} 条）`,
  ];
  const quotaLine = text(d?.quota?.line).trim();
  const quotaAt = num(d?.quota?.at);
  if (quotaLine && quotaAt > 0 && now - quotaAt >= 0 && now - quotaAt < QUOTA_LINE_FRESH_MS) {
    lines.splice(3, 0, `额度：${quotaLine}`);
  }
  return lines.slice(0, 15).join('\n');
}

export function buildMirror({ date, digest, gaps = [], baseUrl = '', safety = {}, backlogMarkdown = '' }) {
  const d = digest || {};
  const findings = arr(d?.questions?.what_went_wrong?.findings);
  const normalFindings = findings.filter((finding) => finding?.status !== 'disputed' && finding?.agreement !== 'disagree');
  const disputedFindings = findings.filter((finding) => finding?.status === 'disputed' || finding?.agreement === 'disagree');
  const disputedGaps = gaps.filter((gap) => gap.status === 'disputed');
  const openGaps = gaps.filter((gap) => isOpenStatus(gap.status) && gap.status !== 'disputed');

  const coverage = d.coverage;
  const budget = aggregateBudget(budgetRows(d));
  const lines = [
    `# 自省镜像 · ${date}`,
    '',
    `- 快照日期：${date}`,
    `- 来源：${text(baseUrl) || '—'}（digest + backlog.md）`,
    `- 群组：${arr(d.groups).map((group) => text(group.group_id)).filter(Boolean).join('、') || '—'}`,
    `- 安全：QQ 真实发送 ${num(safety?.qq_sent ?? claimedQqSent(d))} 次、线上 D1 写入 ${num(safety?.d1_rows_written ?? claimedD1Writes(d))} 行`,
    '',
    '## 问题',
    '',
  ];
  if (normalFindings.length) {
    lines.push('| 严重度 | 能力 | 失败类型 | 发生了什么 |', '|---|---|---|---|');
    for (const finding of normalFindings) {
      lines.push(`| ${cell(finding.severity, 12)} | ${cell(finding.capability, 32)} | ${cell(finding.failure_type, 48)} | ${cell(finding.what_happened, 100)} |`);
    }
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 待复核', '');
  if (disputedGaps.length || disputedFindings.length) {
    for (const gap of disputedGaps) {
      lines.push(`- ${text(gap.capability)} · ${text(gap.gap_type)} · \`${text(gap.fingerprint).slice(0, 12)}\`（次数 ${num(gap.occurrences, 1)}）`);
    }
    for (const finding of disputedFindings) {
      lines.push(`- ${text(finding.capability)} · ${text(finding.failure_type)} · ${text(finding.id)}`);
    }
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 建议派给谁', '');
  const groups = assignmentGroups(openGaps);
  if (groups.length) {
    for (const group of groups) {
      const detail = group.types.map((type) => {
        const items = openGaps.filter((gap) => suggestOwner(gap) === group.owner && text(gap.gap_type) === type);
        return `${type} ${items.length}`;
      }).join('、');
      lines.push(`- ${group.owner}：${detail}`);
    }
  } else {
    lines.push('- 无 open 缺口');
  }

  lines.push('', '## 缺口', '');
  if (gaps.length) {
    lines.push('| 指纹 | 能力 | 类型 | 次数 | 状态 | 首次 | 最近 |', '|---|---|---|---|---|---|---|');
    for (const gap of gaps) {
      lines.push(`| \`${cell(gap.fingerprint, 20)}\` | ${cell(gap.capability, 32)} | ${cell(gap.gap_type, 28)} | ${num(gap.occurrences, 1)} | ${cell(gap.status, 14)} | ${cell(iso(gap.first_seen), 24)} | ${cell(iso(gap.last_seen), 24)} |`);
    }
  } else {
    lines.push('- 无');
  }

  lines.push('', '## 承诺', '');
  lines.push(`- open ${num(d?.promises?.open)} / kept ${num(d?.promises?.kept)} / broken ${num(d?.promises?.broken)} / cannot ${num(d?.promises?.cannot)}`);
  for (const promise of arr(d?.promises?.unfulfilled)) {
    lines.push(`- 未兑现：${cell(promise.what, 100)}（${text(promise.status)}${promise.recurring ? `，${text(promise.recurring)}` : ''}）`);
  }

  lines.push('', '## 规则', '');
  lines.push(`- 新增 ${arr(d?.rules?.created).length} / 变更 ${arr(d?.rules?.changed).length} / 生效 ${num(d?.rules?.active)} / 试用 ${num(d?.rules?.canary)}`);
  for (const rule of arr(d?.rules?.created)) lines.push(`- 新增：${cell(rule.rule, 100)}（${text(rule.status)}）`);
  for (const rule of arr(d?.rules?.changed)) lines.push(`- 变更：${cell(rule.rule, 100)}（${text(rule.status)}）`);

  lines.push('', '## 预算', '');
  if (budget.length) {
    lines.push('| provider | 当日已用 | 上限 | 预留 | 调用 |', '|---|---|---|---|---|');
    for (const row of budget) {
      const unit = row.units.size === 1 ? [...row.units][0] : 'mixed';
      lines.push(`| ${cell(row.provider, 20)} | ${budgetValue(row.used, unit)} | ${budgetValue(row.cap, unit)} | ${budgetValue(row.reserved, unit)} | ${num(row.calls)} |`);
    }
  } else {
    lines.push('- 无数据');
  }
  let monthly = null;
  if (d?.budget?.monthly_usd_micros != null) monthly = num(d.budget.monthly_usd_micros);
  else if (d?.budget?.month_usd != null) monthly = num(d.budget.month_usd) * 1e6;
  lines.push('');
  lines.push(monthly == null ? '- 当月累计：无数据' : `- 当月累计：${usd(monthly)}`);

  lines.push('', '## 覆盖账', '');
  if (coverage) {
    lines.push(`- 是否平：${coverage.balanced ? '平' : '不平'}；unaccounted ${num(coverage.unaccounted)}`);
    for (const run of arr(coverage.runs)) {
      lines.push(`- ${text(run.run_id || run.group_id)}：messages ${num(run.messages)} = traces ${num(run.inbound_traces)} + skipped ${num(run.skipped_by_rule)}；outbox ${num(run.outbox)} = paired ${num(run.outbox_paired)} + standalone ${num(run.outbox_standalone)}；balanced ${run.balanced ? 'yes' : 'no'}`);
    }
  } else {
    lines.push('- 无数据');
  }

  lines.push('', '## 评判', '');
  lines.push(`- judge_failed：${countOf(d.judge_failed)}（评判方失败，不算 bot 的问题）`);
  const disputedCount = d.disputed == null
    ? disputedGaps.length + disputedFindings.length
    : countOf(d.disputed);
  lines.push(`- 双判一致率：${agreementText(d)}；待复核 ${disputedCount}`);

  lines.push('', '## 任务提案', '');
  if (arr(d.tasks).length) {
    for (const task of arr(d.tasks)) lines.push(`- ${text(task.id)} · ${cell(task.title, 100)}（${text(task.status)}）`);
  } else {
    lines.push('- 无');
  }

  const backlog = text(backlogMarkdown);
  if (backlog.trim()) {
    lines.push('', '## backlog.md 原文', '', '```markdown', backlog.trim(), '```');
  }

  lines.push('');
  return lines.join('\n');
}

function parseWranglerOutput(stdout) {
  const parsed = parseJson(text(stdout).trim(), null);
  if (parsed == null) throw new Error('wrangler 输出不是 JSON');
  const first = Array.isArray(parsed)
    ? (parsed[0] ?? {})
    : (Array.isArray(parsed.result) ? (parsed.result[0] ?? {}) : parsed);
  if (first.success === false) {
    const errors = JSON.stringify(first.errors ?? first.error ?? 'unknown');
    throw new Error(`D1 error: ${oneLine(errors, 300)}`);
  }
  const meta = first.meta ?? first.result?.meta ?? {};
  const rows = first.results ?? first.result?.results ?? [];
  const rowsWritten = Number(meta.rows_written);
  const changes = Number(meta.changes ?? 0);
  if (!Number.isFinite(rowsWritten) || rowsWritten !== 0 || changes !== 0) {
    throw new Error(`D1 只读断言失败 rows_written=${meta.rows_written} changes=${meta.changes}`);
  }
  return { rows: arr(rows), rows_written: rowsWritten, changes };
}

export function parseWranglerJson(stdout) {
  return parseWranglerOutput(stdout);
}

function assertSelect(sql) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`refusing non-SELECT query: ${oneLine(sql, 80)}`);
}

function makeWranglerQuery({ db, cwd = process.cwd() } = {}) {
  const bin = process.env.REVIEW_WRANGLER_BIN || 'npx';
  const database = db || process.env.REVIEW_D1_DB || 'inkboard-team';
  return async (sql) => {
    assertSelect(sql);
    const base = /(^|[\\/])npx$/.test(bin) ? ['wrangler'] : [];
    const args = [...base, 'd1', 'execute', database, '--remote', '--command', sql, '--json'];
    const result = spawnSync(bin, args, {
      cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
    });
    if (result.error) throw new Error(`wrangler 启动失败：${result.error.message}`);
    if (result.status !== 0) {
      throw new Error(`wrangler exit ${result.status}：${oneLine(redact(result.stderr || result.stdout), 300)}`);
    }
    return parseWranglerOutput(result.stdout);
  };
}

function fallbackQueries(date) {
  const { start, end } = sydneyDayBounds(date);
  const startIso = new Date(start).toISOString();
  const endIso = new Date(end).toISOString();
  const days = utcDaysFor(date).map((day) => `'${day}'`).join(',');
  const month = date.slice(0, 7);
  return [
    ['review_runs', `SELECT id,group_id,step,mode,model,second_model,stats FROM review_runs WHERE date='${date}' ORDER BY group_id,id`],
    ['review_findings', `SELECT id,run_id,trace_id,severity,capability,failure_type,what_happened,evidence_json,status,agreement,fingerprint FROM review_findings WHERE run_id IN (SELECT id FROM review_runs WHERE date='${date}') ORDER BY CASE severity WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 ELSE 2 END,created_at,id`],
    ['review_traces', `SELECT id,run_id,state,trace_json FROM review_traces WHERE run_id IN (SELECT id FROM review_runs WHERE date='${date}')`],
    ['capability_gaps', "SELECT fingerprint,gap_type,capability,occurrences,first_seen,last_seen,evidence_json,proposed_action,owner,status,task_id,external_ref FROM capability_gaps ORDER BY last_seen DESC,fingerprint LIMIT 200"],
    ['promises', `SELECT id,what,status,due_at,recurring,created_at,checked_at FROM promises WHERE (created_at>=${start} AND created_at<${end}) OR (checked_at>=${start} AND checked_at<${end}) ORDER BY created_at,id`],
    ['behavior_rules', "SELECT id,rule,kind,status,scene,hits,corrections,created_at,updated_at,expires_at FROM behavior_rules ORDER BY updated_at DESC,id"],
    ['review_budget', `SELECT day_utc,provider,unit,used,reserved,cap,calls FROM review_budget WHERE day_utc IN (${days}) ORDER BY provider,day_utc`],
    ['monthly', `SELECT COALESCE(SUM(used),0) AS n FROM review_budget WHERE unit='usd_micros' AND substr(day_utc,1,7)='${month}'`],
    ['tasks', `SELECT id,title,status,source_id,created_at FROM tasks WHERE source_id LIKE 'review:%' AND created_at>='${startIso}' AND created_at<'${endIso}' ORDER BY created_at,id`],
  ];
}

async function queryRows(query, date) {
  const rows = {};
  let rowsWritten = 0;
  let changes = 0;
  for (const [name, sql] of fallbackQueries(date)) {
    assertSelect(sql);
    let result;
    try {
      result = await query(sql);
    } catch (error) {
      if (/no such table/i.test(text(error?.message))) {
        rows[name] = [];
        continue;
      }
      throw error;
    }
    const written = Number(result?.rows_written);
    const changed = Number(result?.changes ?? 0);
    if (!Number.isFinite(written) || written !== 0 || changed !== 0) {
      throw new Error(`${name}: D1 只读断言失败 rows_written=${result?.rows_written} changes=${result?.changes}`);
    }
    rowsWritten += written;
    changes += changed;
    rows[name] = arr(result?.rows);
  }
  rows.rows_written = rowsWritten;
  rows.changes = changes;
  return rows;
}

export function digestFromRows(rows, date, options = {}) {
  const { start } = sydneyDayBounds(date);
  const runs = arr(rows?.review_runs);
  const allFindings = arr(rows?.review_findings);
  const traces = arr(rows?.review_traces);
  const allGaps = arr(rows?.capability_gaps).map((gap) => ({
    ...gap,
    evidence: arr(parseJson(gap.evidence_json, [])),
  }));
  const promises = arr(rows?.promises);
  const rules = arr(rows?.behavior_rules);
  const budget = arr(rows?.review_budget);
  const tasks = arr(rows?.tasks);
  const monthly = arr(rows?.monthly)[0]?.n;

  const counts = { p0: 0, p1: 0, p2: 0 };
  const agreement = { agree: 0, disagree: 0, single: 0, pending: 0, rate: null };
  let disputed = 0;
  for (const finding of allFindings) {
    if (finding?.severity in counts) counts[finding.severity]++;
    if (finding?.agreement in agreement) agreement[finding.agreement]++;
    else agreement.pending++;
    if (finding?.status === 'disputed') disputed++;
  }
  const decided = agreement.agree + agreement.disagree;
  agreement.rate = decided ? agreement.agree / decided : null;

  const traceRows = traces.map((trace) => ({
    id: trace.id,
    run_id: trace.run_id,
    state: trace.state,
    signals: arr(parseJson(trace.trace_json, {})?.signals),
  }));
  const unanswered = traceRows.filter((trace) => trace.signals.includes('S1')).map((trace) => trace.id);
  const judgeFailed = traceRows.filter((trace) => trace.state === 'judge_failed').length;

  const coverageRuns = [];
  let coverage = true;
  let unaccounted = 0;
  for (const run of runs) {
    const stats = parseJson(run.stats, {});
    const item = stats?.coverage;
    if (!item) {
      coverage = false;
      continue;
    }
    const balanced = num(item.messages) === num(item.inbound_traces) + num(item.skipped_by_rule)
      && num(item.outbox) === num(item.outbox_paired) + num(item.outbox_standalone)
      && num(item.unaccounted) === 0;
    coverage &&= balanced;
    unaccounted += num(item.unaccounted);
    coverageRuns.push({
      run_id: run.id, group_id: run.group_id, ...item, balanced,
    });
  }

  const normalize = (gap) => normalizeGap(gap);
  const todayGaps = allGaps.filter((gap) => {
    const first = parseDateMs(gap.first_seen);
    const last = parseDateMs(gap.last_seen);
    return (first != null && first >= start) || (last != null && last >= start);
  });
  const newGaps = todayGaps.filter((gap) => num(parseDateMs(gap.first_seen), -Infinity) >= start).map(normalize);
  const escalated = todayGaps.filter((gap) => num(parseDateMs(gap.first_seen), Infinity) < start).map(normalize);

  const ruleItems = rules.map((rule) => ({
    id: rule.id, rule: rule.rule, kind: rule.kind, status: rule.status, scene: rule.scene,
    hits: rule.hits, corrections: rule.corrections, expires_at: rule.expires_at,
  }));
  const createdRules = ruleItems.filter((_, index) => num(rules[index].created_at) >= start);
  const changedRules = ruleItems.filter((_, index) => num(rules[index].created_at) < start);
  const countStatus = (name) => rules.filter((rule) => rule.status === name && num(rule.expires_at) > start).length;

  return {
    date,
    groups: runs.map((run) => ({
      group_id: run.group_id, run_id: run.id, step: run.step, mode: run.mode,
      model: run.model ?? null, second_model: run.second_model ?? null,
    })),
    questions: {
      what_went_wrong: {
        findings: allFindings.filter((finding) => finding.status !== 'disputed').map((finding) => ({
          id: finding.id, trace_id: finding.trace_id, severity: finding.severity,
          capability: finding.capability, failure_type: finding.failure_type,
          what_happened: finding.what_happened, evidence: arr(parseJson(finding.evidence_json, [])),
          status: finding.status, agreement: finding.agreement,
        })),
        counts,
      },
      requirements: { rules: createdRules, count: createdRules.length },
      memory: { candidates: [], count: 0, to_remember: 0, to_forget: 0 },
      unanswered: { count: unanswered.length, traces: unanswered },
      to_change: { gaps: [...newGaps, ...escalated], tasks },
    },
    promises: {
      open: promises.filter((item) => item.status === 'open').length,
      kept: promises.filter((item) => item.status === 'kept').length,
      broken: promises.filter((item) => item.status === 'broken').length,
      cannot: promises.filter((item) => item.status === 'cannot').length,
      unfulfilled: promises.filter((item) => ['broken', 'cannot'].includes(item.status)).map((item) => ({
        id: item.id, what: item.what, status: item.status, due_at: item.due_at, recurring: item.recurring,
      })),
    },
    gaps: {
      new: newGaps,
      escalated,
      open: allGaps.filter((gap) => isOpenStatus(gap.status)).length,
      regression: allGaps.filter((gap) => gap.status === 'regression').length,
      all: allGaps.map(normalize),
    },
    rules: {
      created: createdRules, changed: changedRules,
      active: countStatus('active'), canary: countStatus('canary'),
    },
    budget: {
      providers: budget.map((row) => ({
        day_utc: row.day_utc, provider: row.provider, unit: row.unit, used: row.used,
        reserved: row.reserved, cap: row.cap, calls: row.calls,
      })),
      monthly_usd_micros: monthly == null
        ? budget.filter((row) => row.unit === 'usd_micros').reduce((sum, row) => sum + num(row.used), 0)
        : num(monthly),
      month_cap_usd_micros: num(options.monthCap ?? 10000000),
    },
    coverage: { balanced: coverage && coverageRuns.length > 0, runs: coverageRuns, unaccounted },
    judge_failed: judgeFailed,
    disputed,
    agreement,
    tasks: tasks.map((task) => ({
      id: task.id, title: task.title, status: task.status, created_at: task.created_at,
    })),
    findings: { total: allFindings.length, ...counts },
  };
}

function resolveToken(options = {}) {
  if (typeof options.token === 'string' && options.token.trim()) return options.token.trim();
  const file = text(options.tokenFile || process.env.REVIEW_TOKEN_FILE);
  if (!file) return '';
  if (!existsSync(file)) throw new Error(`令牌文件不存在：${file}`);
  const token = readFileSync(file, 'utf8').trim();
  if (!token) return '';
  return token;
}

async function httpGet(url, token, fetchImpl) {
  const fetch = fetchImpl || globalThis.fetch;
  if (typeof fetch !== 'function') throw new Error('当前 Node 没有 fetch');
  let response;
  try {
    response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/markdown, text/plain' },
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new Error(`GET ${url} 失败：${redact(error?.message, token)}`);
  }
  return response;
}

async function fetchDigest(baseUrl, date, token, fetchImpl) {
  const url = `${baseUrl}/review/digest?date=${encodeURIComponent(date)}`;
  const response = await httpGet(url, token, fetchImpl);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${url} → HTTP ${response.status}${body ? `：${oneLine(redact(body, token), 160)}` : ''}`);
  }
  const body = await response.text();
  const digest = parseJson(body, null);
  if (!digest || typeof digest !== 'object') throw new Error(`GET ${url} 返回的不是 JSON 对象`);
  return digest;
}

async function fetchBacklog(baseUrl, date, token, fetchImpl) {
  const url = `${baseUrl}/review/backlog.md?date=${encodeURIComponent(date)}`;
  const response = await httpGet(url, token, fetchImpl);
  if (response.status === 404) return '';
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`GET ${url} → HTTP ${response.status}${body ? `：${oneLine(redact(body, token), 160)}` : ''}`);
  }
  return response.text();
}

export async function pullReview(options = {}) {
  const date = text(options.date) || sydneyDate(options.now);
  assertDate(date);
  const cwd = resolve(options.cwd || process.cwd());
  const outDir = resolve(options.outDir || join(cwd, '.agent', 'backlog'));
  const token = resolveToken(options);
  let baseUrl = text(options.baseUrl || process.env.REVIEW_BASE_URL);
  let digest;
  let backlogMarkdown = '';
  let safety;

  if (token) {
    baseUrl = (baseUrl || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    digest = await fetchDigest(baseUrl, date, token, options.fetchImpl);
    backlogMarkdown = await fetchBacklog(baseUrl, date, token, options.fetchImpl);
    safety = { qq_sent: claimedQqSent(digest), d1_rows_written: claimedD1Writes(digest) };
  } else {
    const query = options.wranglerQuery || makeWranglerQuery({ db: options.db, cwd });
    const rows = await queryRows(query, date);
    digest = digestFromRows(rows, date, { monthCap: options.monthCap });
    safety = { qq_sent: claimedQqSent(digest), d1_rows_written: rows.rows_written };
    baseUrl = baseUrl || 'wrangler d1（只读）';
  }

  if (digest?.date && text(digest.date) !== date) {
    throw new Error(`digest 日期不符：请求 ${date}，返回 ${text(digest.date)}`);
  }
  const parsedBacklog = parseBacklogMarkdown(backlogMarkdown);
  const digestGaps = gapsFromDigest(digest);
  const gaps = mergeGapEntries(parsedBacklog, digestGaps);

  const mirrorPath = join(outDir, 'self-review', `${date}.md`);
  const ledgerPath = join(outDir, 'capability-gaps.md');
  const mirror = buildMirror({
    date, digest, gaps, baseUrl, safety, backlogMarkdown,
  });
  const existingLedger = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8') : '';
  const ledger = mergeLedger(existingLedger, gaps, { date, baseUrl });

  atomicWrite(mirrorPath, mirror);
  atomicWrite(ledgerPath, ledger);

  const report = buildMorningReport({
    date, digest, gaps, baseUrl, mirrorPath, ledgerPath, safety,
  });
  return {
    date,
    baseUrl,
    digest,
    gaps,
    mirrorPath,
    ledgerPath,
    report,
    safety,
    backlogMarkdown,
  };
}

export function parseArgs(argv = []) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') { args.help = true; continue; }
    if (!arg.startsWith('--')) throw new Error(`unknown argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    if (key === 'date') args.date = value;
    else if (key === 'base-url') args.baseUrl = value;
    else if (key === 'out') args.out = value;
    else if (key === 'token-file') args.tokenFile = value;
    else if (key === 'db') args.db = value;
    else throw new Error(`unknown option: ${arg}`);
  }
  return args;
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const result = await pullReview({
    date: args.date,
    baseUrl: args.baseUrl,
    outDir: args.out,
    tokenFile: args.tokenFile,
    db: args.db,
    ...deps,
  });
  process.stdout.write(`${result.report}\n`);
  return 0;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`review-pull: ${oneLine(error?.message, 500)}\n`);
      process.exitCode = 1;
    });
}
