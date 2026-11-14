import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pullReview,
  buildMorningReport,
  parseBacklogMarkdown,
  parseWranglerJson,
  digestFromRows,
  mergeLedger,
} from '../scripts/review-pull.mjs';

const DATE = '2026-11-13';
const TOKEN = 'test-token-do-not-print';
const execFileAsync = promisify(execFile);

function sampleDigest(overrides = {}) {
  return {
    date: DATE,
    groups: [{
      group_id: 'fx-group-1', run_id: 'fx-group-1:2026-11-13', step: 'done', mode: 'shadow',
      model: 'deepseek-flash', second_model: 'openai',
    }],
    questions: {
      what_went_wrong: {
        findings: [
          {
            id: 'f1', trace_id: 't1', severity: 'p1', capability: 'repo_changes',
            failure_type: 'tool.repo_changes.missing',
            what_happened: '被问仓库最近改了什么时，没有调用 repo_changes，只给了泛泛回答。',
            evidence: [{ source: 'message', id: 'fx-m1', quote: '仓库最近改了什么', origin: 'direct' }],
          },
          {
            id: 'f2', trace_id: 't2', severity: 'p2', capability: 'bili_shortlink',
            failure_type: 'tool.bili_shortlink.failed', what_happened: '短链解析失败。',
            evidence: [{ source: 'outbox', id: 'fx-o1', quote: '我打不开这个短链', origin: 'direct' }],
          },
        ],
        counts: { p0: 0, p1: 1, p2: 1 },
      },
      requirements: { rules: [], count: 1 },
      memory: { candidates: [], count: 0, to_remember: 0, to_forget: 0 },
      unanswered: { count: 1, traces: ['t3'] },
      to_change: { gaps: [], tasks: [] },
    },
    promises: {
      open: 1, kept: 2, broken: 1, cannot: 0,
      unfulfilled: [{ id: 'p1', what: '每天发一次日报', status: 'broken', due_at: 1763000000000, recurring: 'daily' }],
    },
    gaps: {
      new: [{
        fingerprint: 'fp-repo-1', gap_type: 'tool_missing', capability: 'repo_changes',
        occurrences: 3, status: 'open', first_seen: 1762900000000,
      }],
      escalated: [{
        fingerprint: 'fp-sched-2', gap_type: 'tool_not_selected', capability: 'scheduling',
        occurrences: 4, status: 'open', first_seen: 1762800000000,
      }],
      open: 2, regression: 0,
    },
    rules: {
      created: [{ id: 'r1', rule: '回答仓库问题前先查 repo_changes', kind: 'typed', status: 'canary' }],
      changed: [{ id: 'r2', rule: 'B 站短链先解析再回答', kind: 'typed', status: 'active' }],
      active: 2, canary: 1,
    },
    budget: {
      providers: [
        { day_utc: '2026-11-12', provider: 'deepseek', unit: 'usd_micros', used: 0, reserved: 0, cap: 100000, calls: 0 },
        { day_utc: '2026-11-13', provider: 'deepseek', unit: 'usd_micros', used: 36000, reserved: 0, cap: 100000, calls: 4 },
        { day_utc: '2026-11-13', provider: 'openai', unit: 'usd_micros', used: 210000, reserved: 50000, cap: 500000, calls: 2 },
      ],
      monthly_usd_micros: 442000,
      month_cap_usd_micros: 10000000,
    },
    coverage: {
      balanced: true,
      runs: [{
        run_id: 'fx-group-1:2026-11-13', group_id: 'fx-group-1', messages: 10, inbound_traces: 8,
        skipped_by_rule: 2, outbox: 4, outbox_paired: 4, outbox_standalone: 0, unaccounted: 0, balanced: true,
      }],
      unaccounted: 0,
    },
    judge_failed: 1,
    disputed: 1,
    agreement: { agree: 3, disagree: 1, single: 0, pending: 0, rate: 0.75 },
    tasks: [{ id: 'rv-fp-repo-1', title: '[复盘] repo_changes · tool_missing', status: 'proposal', created_at: 1763000000000 }],
    findings: { total: 3, p0: 0, p1: 1, p2: 2 },
    ...overrides,
  };
}

function sampleBacklog() {
  return `# 能力缺口提案（gap:v1）

- 指纹：fp-repo-1
- 能力：repo_changes
- 缺口类型：tool_missing
- 修复层：tool
- 负责人：工程师
- 状态：open
- 出现次数：3
- 首次：2026-11-11T00:00:00.000Z
- 最近：2026-11-13T00:00:00.000Z

## 证据（逐字）
- message:fx-m1（rowid=12）「仓库最近改了什么」

## 复现
- messages.rowid=12（message:fx-m1）

## 验收建议
- 同场景回放应调用 repo_changes 并给出可核对结果。

## 现在怎么修
- 补齐 repo_changes 所需工具并加固定探针。

# 能力缺口提案（gap:v1）

- 指纹：fp-disputed-9
- 能力：scheduling
- 缺口类型：tool_not_selected
- 修复层：prompt
- 负责人：主程
- 状态：disputed
- 出现次数：2
- 首次：2026-11-12T00:00:00.000Z
- 最近：2026-11-13T00:00:00.000Z

## 证据（逐字）
- message:fx-m9（rowid=44）「说好每天晚上发日报的」
`;
}

function startMockServer({ digest = sampleDigest(), backlog = sampleBacklog(), status = 200, checkAuth = true } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization });
    if (checkAuth && req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/review/digest') {
      if (status !== 200) {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'no digest' }));
        return;
      }
      assert.equal(url.searchParams.get('date'), DATE);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(digest));
      return;
    }
    if (url.pathname === '/review/backlog.md') {
      if (backlog == null) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      res.end(backlog);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function tempOut() {
  return mkdtempSync(join(tmpdir(), 'teamagent-test-review-pull-'));
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

test('parseBacklogMarkdown reads gap:v1 blocks and dedupes by fingerprint', () => {
  const parsed = parseBacklogMarkdown(sampleBacklog() + '\n' + sampleBacklog());
  assert.equal(parsed.length, 2);
  const repo = parsed.find((item) => item.fingerprint === 'fp-repo-1');
  assert.equal(repo.capability, 'repo_changes');
  assert.equal(repo.gap_type, 'tool_missing');
  assert.equal(repo.occurrences, 3);
  assert.equal(repo.owner, '工程师');
  assert.match(repo.evidence_text, /仓库最近改了什么/);
  const disputed = parsed.find((item) => item.fingerprint === 'fp-disputed-9');
  assert.equal(disputed.status, 'disputed');
});

test('parseBacklogMarkdown splits one title with several gap sections', () => {
  const parsed = parseBacklogMarkdown([
    '# 能力缺口提案（gap:v1）',
    '',
    '## repo_changes · tool_missing',
    '- 指纹：fp-a',
    '- 能力：repo_changes',
    '- 缺口类型：tool_missing',
    '- 状态：open',
    '- 出现次数：2',
    '',
    '## scheduling · tool_not_selected',
    '- 指纹：fp-b',
    '- 能力：scheduling',
    '- 缺口类型：tool_not_selected',
    '- 状态：disputed',
    '- 出现次数：1',
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].fingerprint, 'fp-a');
  assert.equal(parsed[1].fingerprint, 'fp-b');
  assert.equal(parsed[1].status, 'disputed');
});

test('parseBacklogMarkdown also reads a markdown table keyed by fingerprint', () => {
  const parsed = parseBacklogMarkdown([
    '| 指纹 | 能力 | 缺口类型 | 次数 | 状态 | 建议派给 |',
    '|---|---|---|---|---|---|',
    '| fp-table-1 | repo_changes | tool_missing | 2 | open | 工程师 |',
    '| fp-table-2 | scheduling | tool_not_selected | 4 | disputed | 主程 |',
  ].join('\n'));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].fingerprint, 'fp-table-1');
  assert.equal(parsed[0].occurrences, 2);
  assert.equal(parsed[1].status, 'disputed');
});

test('morning report is at most 15 lines and includes the four v2 lines', () => {
  const report = buildMorningReport({
    date: DATE,
    digest: sampleDigest(),
    gaps: parseBacklogMarkdown(sampleBacklog()),
    baseUrl: 'http://127.0.0.1:8787',
    mirrorPath: '/tmp/.agent/backlog/self-review/2026-11-13.md',
    ledgerPath: '/tmp/.agent/backlog/capability-gaps.md',
    safety: { qq_sent: 0, d1_rows_written: 0 },
  });
  const lines = report.split('\n');
  assert.ok(lines.length <= 15, `report has ${lines.length} lines`);
  assert.match(lines[0], /QQ 真实发送 0 次、线上 D1 写入 0 行/);
  assert.match(report, /预算：deepseek \$0\.0360 \/ \$0\.1000 · openai \$0\.2100 \/ \$0\.5000；当月 \$0\.4420 \/ \$10\.0000/);
  assert.match(report, /覆盖账：平/);
  assert.match(report, /judge_failed：1/);
  assert.match(report, /双判一致率：75\.0%/);
  assert.match(report, /待复核：1 条（scheduling · tool_not_selected）/);
  assert.match(report, /建议派给：/);
  // Disputed entries must never appear in the assignment line.
  const assignment = lines.find((line) => line.startsWith('建议派给：')) || '';
  assert.doesNotMatch(assignment, /fp-disputed-9/);
  assert.doesNotMatch(assignment, /scheduling/);
});

test('morning report tolerates a digest with only a date', () => {
  const report = buildMorningReport({
    date: DATE,
    digest: { date: DATE },
    gaps: [],
    baseUrl: 'http://127.0.0.1:8787',
    mirrorPath: '/tmp/.agent/backlog/self-review/2026-11-13.md',
    ledgerPath: '/tmp/.agent/backlog/capability-gaps.md',
    safety: { qq_sent: 0, d1_rows_written: 0 },
  });
  const lines = report.split('\n');
  assert.ok(lines.length <= 15);
  assert.match(report, /预算：无数据/);
  assert.match(report, /覆盖账：无数据/);
  assert.match(report, /judge_failed：0/);
  assert.match(report, /双判一致率：—/);
});

test('the zero-send line is not printed when the run reports sends or writes', () => {
  const report = buildMorningReport({
    date: DATE,
    digest: sampleDigest({ safety: { qq_sent: 2, d1_rows_written: 1 } }),
    gaps: [],
    baseUrl: 'http://127.0.0.1:8787',
    mirrorPath: '/tmp/mirror.md',
    ledgerPath: '/tmp/ledger.md',
    safety: { qq_sent: 2, d1_rows_written: 1 },
  });
  const first = report.split('\n')[0];
  assert.match(first, /QQ 真实发送 2 次、线上 D1 写入 1 行/);
  assert.doesNotMatch(first, /QQ 真实发送 0 次/);
});

test('pullReview writes both files over the mock server and never prints the token', async () => {
  const mock = await startMockServer();
  const outDir = tempOut();
  try {
    const result = await pullReview({
      baseUrl: mock.baseUrl,
      date: DATE,
      token: TOKEN,
      outDir,
    });
    assert.equal(result.date, DATE);
    assert.equal(result.gaps.length, 3);
    assert.ok(existsSync(result.mirrorPath));
    assert.ok(existsSync(result.ledgerPath));
    const mirror = readFileSync(result.mirrorPath, 'utf8');
    assert.match(mirror, /# 自省镜像 · 2026-11-13/);
    assert.match(mirror, /## 待复核/);
    assert.match(mirror, /## 建议派给谁/);
    const ledger = readFileSync(result.ledgerPath, 'utf8');
    assert.match(ledger, /<!-- gap:fp-repo-1 -->/);
    assert.match(ledger, /<!-- gap:fp-disputed-9 -->/);
    assert.equal((ledger.match(/<!-- gap:fp-repo-1 -->/g) || []).length, 1);
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every((item) => item.authorization === `Bearer ${TOKEN}`));
  } finally {
    await mock.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('two runs are idempotent and preserve human annotations', async () => {
  const mock = await startMockServer();
  const outDir = tempOut();
  try {
    const first = await pullReview({ baseUrl: mock.baseUrl, date: DATE, token: TOKEN, outDir });
    const before = readFileSync(first.ledgerPath, 'utf8');

    const annotated = before
      .replace('<!-- human:begin -->\n', '<!-- human:begin -->\n> 人工总备注：这条别删。\n')
      .replace(
        '<!-- gap:fp-repo-1 -->\n',
        '<!-- gap:fp-repo-1 -->\n<!-- note:begin -->\n> 已确认，等下周修。\n<!-- note:end -->\n',
      )
      .replace('<!-- gap:fp-disputed-9 -->\n', '<!-- gap:fp-disputed-9 -->\n> 这条要等架构师复核。\n');
    writeFileSync(first.ledgerPath, annotated);

    const second = await pullReview({ baseUrl: mock.baseUrl, date: DATE, token: TOKEN, outDir });
    const after = readFileSync(second.ledgerPath, 'utf8');

    assert.equal((after.match(/<!-- gap:fp-repo-1 -->/g) || []).length, 1);
    assert.equal((after.match(/<!-- gap:fp-disputed-9 -->/g) || []).length, 1);
    assert.match(after, /> 人工总备注：这条别删。/);
    assert.match(after, /> 已确认，等下周修。/);
    assert.match(after, /> 这条要等架构师复核。/);
    // Re-rendering the same feed changes nothing else.
    const stripNotes = (text) => text
      .replace(/> 人工总备注：这条别删。\n/, '')
      .replace(/<!-- note:begin -->\n> 已确认，等下周修。\n<!-- note:end -->\n/, '<!-- note:begin -->\n<!-- note:end -->\n')
      .replace(/> 这条要等架构师复核。\n/, '');
    assert.equal(stripNotes(after), stripNotes(before.replace('<!-- note:begin -->\n<!-- note:end -->\n', '<!-- note:begin -->\n<!-- note:end -->\n')));
  } finally {
    await mock.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('CLI prints only the at-most-15-line report and exits 0', async () => {
  const mock = await startMockServer();
  const outDir = tempOut();
  const tokenFile = join(outDir, 'token.txt');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const args = [
    'scripts/review-pull.mjs', '--date', DATE, '--base-url', mock.baseUrl,
    '--out', outDir, '--token-file', tokenFile,
  ];
  try {
    const first = await execFileAsync(process.execPath, args, { encoding: 'utf8' });
    const lines = first.stdout.trimEnd().split('\n');
    assert.ok(lines.length <= 15, `CLI printed ${lines.length} lines`);
    assert.match(lines[0], /QQ 真实发送 0 次、线上 D1 写入 0 行/);
    assert.ok(!first.stdout.includes(TOKEN));
    const ledgerPath = join(outDir, 'capability-gaps.md');
    const mirrorPath = join(outDir, 'self-review', `${DATE}.md`);
    const ledger = readFileSync(ledgerPath, 'utf8');
    const mirror = readFileSync(mirrorPath, 'utf8');
    await execFileAsync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(readFileSync(ledgerPath, 'utf8'), ledger);
    assert.equal(readFileSync(mirrorPath, 'utf8'), mirror);
  } finally {
    await mock.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('a missing backlog.md falls back to gaps in the digest', async () => {
  const mock = await startMockServer({ backlog: null });
  const outDir = tempOut();
  try {
    const result = await pullReview({ baseUrl: mock.baseUrl, date: DATE, token: TOKEN, outDir });
    assert.equal(result.gaps.length, 2);
    const mirror = readFileSync(result.mirrorPath, 'utf8');
    assert.match(mirror, /fp-repo-1/);
    assert.match(mirror, /fp-sched-2/);
    const ledger = readFileSync(result.ledgerPath, 'utf8');
    assert.match(ledger, /<!-- gap:fp-repo-1 -->/);
    assert.match(ledger, /<!-- gap:fp-sched-2 -->/);
  } finally {
    await mock.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('an unauthorized digest stops without writing files', async () => {
  const mock = await startMockServer();
  const outDir = tempOut();
  try {
    await assert.rejects(
      pullReview({ baseUrl: mock.baseUrl, date: DATE, token: 'wrong-token', outDir }),
      /401/,
    );
    assert.deepEqual(readdirSync(outDir), []);
  } finally {
    await mock.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('parseWranglerJson accepts read-only output and rejects writes', () => {
  const ok = parseWranglerJson(JSON.stringify([{ results: [{ n: 1 }], success: true, meta: { rows_written: 0, changes: 0 } }]));
  assert.deepEqual(ok.rows, [{ n: 1 }]);
  assert.throws(
    () => parseWranglerJson(JSON.stringify([{ results: [], success: true, meta: { rows_written: 1, changes: 1 } }])),
    /rows_written|changes/,
  );
});

test('digestFromRows rebuilds the digest shape from D1 rows', () => {
  const digest = digestFromRows({
    review_runs: [{
      id: `fx-group-1:${DATE}`, group_id: 'fx-group-1', step: 'done', mode: 'shadow',
      model: 'deepseek-flash', second_model: 'openai',
      stats: JSON.stringify({ coverage: { messages: 10, inbound_traces: 8, skipped_by_rule: 2, outbox: 4, outbox_paired: 4, outbox_standalone: 0, unaccounted: 0 } }),
    }],
    review_traces: [
      { id: 't1', run_id: `fx-group-1:${DATE}`, state: 'judged', trace_json: JSON.stringify({ signals: ['S1'] }) },
      { id: 't2', run_id: `fx-group-1:${DATE}`, state: 'judge_failed', trace_json: JSON.stringify({ signals: [] }) },
    ],
    review_findings: [{
      id: 'f1', run_id: `fx-group-1:${DATE}`, trace_id: 't1', severity: 'p1', capability: 'repo_changes',
      failure_type: 'tool.repo_changes.missing', what_happened: '没有调用工具', evidence_json: '[]',
      status: 'open', agreement: 'agree',
    }, {
      id: 'f2', run_id: `fx-group-1:${DATE}`, trace_id: 't1', severity: 'p2', capability: 'scheduling',
      failure_type: 'tool.scheduling.missing', what_happened: '没有排程', evidence_json: '[]',
      status: 'disputed', agreement: 'disagree',
    }],
    capability_gaps: [],
    promises: [],
    behavior_rules: [],
    review_budget: [{
      day_utc: '2026-11-13', provider: 'openai', unit: 'usd_micros', used: 1000, reserved: 0, cap: 500000, calls: 1,
    }],
    tasks: [],
  }, DATE);
  assert.equal(digest.date, DATE);
  assert.equal(digest.coverage.balanced, true);
  assert.equal(digest.judge_failed, 1);
  assert.equal(digest.disputed, 1);
  assert.equal(digest.questions.unanswered.count, 1);
  assert.equal(digest.questions.what_went_wrong.counts.p1, 1);
  assert.equal(digest.agreement.rate, 0.5);
  assert.equal(digest.budget.monthly_usd_micros, 1000);
});

test('wrangler fallback works with an injected read-only query and reports zero', async () => {
  const outDir = tempOut();
  const sqls = [];
  const tables = {
    review_runs: [{
      id: `fx-group-1:${DATE}`, group_id: 'fx-group-1', step: 'done', mode: 'shadow',
      model: 'deepseek-flash', second_model: 'openai',
      stats: JSON.stringify({ coverage: { messages: 10, inbound_traces: 8, skipped_by_rule: 2, outbox: 4, outbox_paired: 4, outbox_standalone: 0, unaccounted: 0 } }),
    }],
    review_traces: [{ id: 't1', run_id: `fx-group-1:${DATE}`, state: 'judged', trace_json: JSON.stringify({ signals: ['S1'] }) }],
    review_findings: [{
      id: 'f1', run_id: `fx-group-1:${DATE}`, trace_id: 't1', severity: 'p1', capability: 'repo_changes',
      failure_type: 'tool.repo_changes.missing', what_happened: '没有调用工具', evidence_json: '[]',
      status: 'open', agreement: 'agree',
    }],
    capability_gaps: [{
      fingerprint: 'fp-repo-1', gap_type: 'tool_missing', capability: 'repo_changes', occurrences: 3,
      first_seen: 1762900000000, last_seen: 1763000000000, owner: '工程师', status: 'open',
      proposed_action: '补工具', what_happened: '没有调用工具', expected: '调用工具', root_cause: '缺工具',
      next_attempt_plan: '回放应调用 repo_changes',
    }],
    promises: [],
    behavior_rules: [],
    review_budget: [{
      day_utc: '2026-11-13', provider: 'openai', unit: 'usd_micros', used: 1000, reserved: 0, cap: 500000, calls: 1,
    }],
    tasks: [],
  };
  const wranglerQuery = async (sql) => {
    sqls.push(sql);
    assert.match(sql.trim(), /^SELECT\b/i);
    const monthly = /SUM\(used\)/.test(sql);
    const table = monthly ? 'review_budget'
      : Object.keys(tables).find((name) => sql.includes(`FROM ${name}`));
    if (monthly) return { rows: [{ n: 1000 }], rows_written: 0, changes: 0 };
    assert.ok(table, `unexpected SQL: ${sql}`);
    return { rows: tables[table], rows_written: 0, changes: 0 };
  };
  try {
    const result = await pullReview({
      baseUrl: null, date: DATE, token: null, outDir, wranglerQuery,
      fetchImpl: async () => { throw new Error('fetch must not run without a token'); },
    });
    assert.ok(result.report.split('\n').length <= 15);
    assert.match(result.report.split('\n')[0], /QQ 真实发送 0 次、线上 D1 写入 0 行/);
    assert.ok(existsSync(result.mirrorPath));
    assert.ok(existsSync(result.ledgerPath));
    assert.ok(sqls.length >= 8);
    assert.ok(sqls.every((sql) => /^\s*SELECT\b/i.test(sql)));
    assert.match(readFileSync(result.mirrorPath, 'utf8'), /fp-repo-1/);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('wrangler fallback refuses to continue when the database reports a write', async () => {
  const outDir = tempOut();
  try {
    await assert.rejects(
      pullReview({
        baseUrl: null, date: DATE, token: null, outDir,
        wranglerQuery: async () => ({ rows: [], rows_written: 1, changes: 1 }),
      }),
      /rows_written/,
    );
    assert.deepEqual(readdirSync(outDir), []);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('mergeLedger keeps entries that are absent from today feed', () => {
  const first = mergeLedger('', [
    { fingerprint: 'fp-a', capability: 'repo_changes', gap_type: 'tool_missing', status: 'open', occurrences: 1 },
    { fingerprint: 'fp-b', capability: 'bili_shortlink', gap_type: 'tool_failed', status: 'open', occurrences: 2 },
  ], { date: DATE, baseUrl: 'http://127.0.0.1:8787' });
  assert.match(first, /<!-- gap:fp-a -->/);
  assert.match(first, /<!-- gap:fp-b -->/);
  const second = mergeLedger(first, [
    { fingerprint: 'fp-a', capability: 'repo_changes', gap_type: 'tool_missing', status: 'fixed', occurrences: 4 },
  ], { date: DATE, baseUrl: 'http://127.0.0.1:8787' });
  assert.match(second, /<!-- gap:fp-a -->/);
  assert.match(second, /- 状态：fixed/);
  assert.match(second, /<!-- gap:fp-b -->/);
  assert.equal((second.match(/<!-- gap:fp-a -->/g) || []).length, 1);
});
