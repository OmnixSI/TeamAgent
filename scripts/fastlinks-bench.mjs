#!/usr/bin/env node
/**
 * V-C fast-links reading-layer bench.
 *
 * Reads `.agent/fastlinks-corpus.json` (22 real/synthetic messages), runs each
 * entry through the current reading layer and prints PASS/FAIL with latency.
 *
 * - URL entries go through readUrl() with the production "research" budget.
 * - Bilibili entries go through parseInbound() + the public Bilibili view API
 *   (read-only; no login, no cookies); b23 short links are resolved through
 *   b23.tv exactly like the local fetcher.
 * - Card entries only check recognition (the card has no link to read).
 * - "end-to-end" entries have no URL and are reported N/A here.
 *
 * This script has no QQ/outbound-message code path. It only issues read-only
 * public GETs (Jina, Fx, raw.githubusercontent.com, b23.tv, api.bilibili.com).
 *
 * Usage:
 *   node scripts/fastlinks-bench.mjs --corpus /path/to/.agent/fastlinks-corpus.json
 *   node scripts/fastlinks-bench.mjs --corpus ... --json /tmp/baseline.json
 *   node scripts/fastlinks-bench.mjs --corpus ... --only b23
 *   node scripts/fastlinks-bench.mjs --corpus ... --no-bili   # offline recognition only
 *   node scripts/fastlinks-bench.mjs --corpus ... --strict    # exit 1 on FAIL
 */
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFetchClient } from '../runner/fetcher.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = name => {
  const index = process.argv.indexOf('--' + name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const flag = name => process.argv.includes('--' + name);

if (process.argv.includes('--corpus') && !arg('corpus')) throw new Error('--corpus needs a path');
const corpusPath = resolve(arg('corpus') || join(root, '.agent', 'fastlinks-corpus.json'));
const jsonPath = arg('json');
const only = arg('only');
const skipBili = flag('no-bili');
const strict = flag('strict');
const runId = `${process.pid}-${Date.now()}`;

const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const SHORT_RE = /^[0-9A-Za-z_-]{4,32}$/;

const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
if (!Array.isArray(corpus.entries)) throw new Error(`${corpusPath}: entries[] missing`);
if (Number.isInteger(corpus.count) && corpus.count !== corpus.entries.length)
  throw new Error(`${corpusPath}: count ${corpus.count} != entries ${corpus.entries.length}`);

const bundlePath = join(root, '.wrangler', `fastlinks-bench-${runId}.mjs`);
await mkdir(dirname(bundlePath), { recursive: true });
await build({
  stdin: {
    contents:
      'export {readUrl} from "./src/semantic";' +
      'export {parseInbound} from "./src/inbound";' +
      'export {scanBiliPayload} from "./src/bili-links";' +
      'export * as bilititle from "./src/bilititle";',
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  outfile: bundlePath,
});
const api = await import(pathToFileURL(bundlePath).href);

const riskPath = join(tmpdir(), `fastlinks-bench-risk-${runId}.json`);
const client = skipBili
  ? null
  : createFetchClient({ riskPath, log: () => {} });

if (client) {
  try {
    await client.prepare(true);
  } catch {
    // View API is public; a failed anonymous fingerprint only removes buvid.
  }
}

/** Mirrors fetchjobs refIn(): only bvid or short, never aid. */
function pipelineRef(parsed) {
  return (
    parsed.bili?.find(b => BV_RE.test(b.bvid || ''))?.bvid ||
    parsed.bili?.find(b => SHORT_RE.test(b.short || ''))?.short ||
    null
  );
}
function matchBili(parsed, expected) {
  const list = parsed.bili || [];
  if (expected.aid) return list.find(b => b.aid === expected.aid);
  if (expected.short) return list.find(b => b.short === expected.short);
  if (expected.bvid) return list.find(b => b.bvid === expected.bvid);
  return list[0];
}
/** Current Worker has no page field, so the fetcher reads pages[0]. */
function pageOf(match) {
  return Number.isInteger(match?.page) ? match.page : 1;
}

async function biliChecks(entry) {
  const checks = [];
  const expected = entry.expect || {};
  const parsed = api.parseInbound('GROUP_AT_MESSAGE_CREATE', entry.event || { content: entry.body || '' });
  const match = expected.bili ? matchBili(parsed, expected.bili) : undefined;
  const ref = pipelineRef(parsed);
  const titleRef = parsed.biliCard?.title ? api.bilititle.titleRef(parsed.biliCard.title) : null;

  if (expected.bili) {
    checks.push({
      name: 'recognize',
      ok: !!match,
      detail: match ? JSON.stringify(match) : `未识别为 ${JSON.stringify(expected.bili)}`,
    });
    checks.push({
      name: 'pipeline ref (refIn)',
      ok: !!ref,
      detail:
        ref ||
        (expected.bili.aid
          ? `aid ${expected.bili.aid} 被 refIn 丢弃（只认 bvid/short）`
          : 'null'),
    });
  }
  if (expected.bili_urls) {
    const urls = parsed.biliUrls || [];
    checks.push({
      name: 'bili urls',
      ok: expected.bili_urls.every(url => urls.includes(url)),
      detail: JSON.stringify(urls),
    });
  }
  if (expected.bili_card) {
    const title = parsed.biliCard?.title || '';
    checks.push({
      name: 'card title',
      ok: title.includes(expected.bili_card.title_contains),
      detail: title || 'null',
    });
    checks.push({ name: 'card titleRef', ok: !!titleRef, detail: titleRef || 'null' });
  }

  const actual = { ref, titleRef, bili: parsed.bili, biliUrls: parsed.biliUrls, card: parsed.card?.title };
  if (client && expected.video && (match || expected.bili?.aid)) {
    let bvid = match?.bvid || null;
    let resolvedFrom = bvid ? 'bvid' : null;
    try {
      if (!bvid && match?.short) {
        bvid = await client.resolveShort(match.short);
        resolvedFrom = 'short';
      }
      if (!bvid && match?.aid) {
        bvid = await client.resolveShort(match.aid);
        resolvedFrom = 'aid';
      }
      const view = await client.biliApi('/x/web-interface/view', { bvid });
      const video = view.data || {};
      checks.push({
        name: 'view',
        ok: view.code === 0 && !!video.bvid,
        detail: `code ${view.code} ${video.bvid || ''} ${String(video.title || '').slice(0, 40)}`,
      });
      if (expected.video.title_contains)
        checks.push({
          name: 'title',
          ok: String(video.title || '').includes(expected.video.title_contains),
          detail: String(video.title || '').slice(0, 60),
        });
      if (expected.video.pages)
        checks.push({
          name: 'pages',
          ok: (video.pages || []).length === expected.video.pages,
          detail: String((video.pages || []).length),
        });
      const page = pageOf(match);
      if (expected.video.page) {
        const want = (video.pages || []).find(p => p.page === expected.video.page);
        const got = (video.pages || []).find(p => p.page === page);
        checks.push({
          name: 'page',
          ok: page === expected.video.page,
          detail: `读到第 ${page} P（cid ${got?.cid || '?'}），期望第 ${expected.video.page} P（cid ${want?.cid || '?'}）`,
        });
        if (expected.video.cid)
          checks.push({
            name: 'cid',
            ok: String(got?.cid || '') === String(expected.video.cid),
            detail: String(got?.cid || ''),
          });
      }
      Object.assign(actual, {
        bvid,
        resolvedFrom,
        title: video.title,
        pages: (video.pages || []).length,
        page,
      });
    } catch (error) {
      checks.push({
        name: 'read',
        ok: false,
        detail: `${error.message}${error.code ? ' code ' + error.code : ''}`,
      });
    }
  }
  return { checks, actual };
}

async function webChecks(entry) {
  const checks = [];
  const expected = entry.expect?.read || {};
  let read;
  try {
    read = await api.readUrl({}, entry.url, {
      purpose: 'research',
      deadline: Date.now() + 15000,
    });
  } catch (error) {
    read = { ok: false, reason: 'threw:' + error.message };
  }
  if (expected.ok === true) {
    checks.push({ name: 'ok', ok: read.ok === true, detail: read.ok ? 'true' : read.reason || 'false' });
    if (read.ok && expected.source)
      checks.push({ name: 'source', ok: expected.source.includes(read.source), detail: read.source });
    if (read.ok && expected.contains) {
      const needles = Array.isArray(expected.contains) ? expected.contains : [expected.contains];
      checks.push({
        name: 'contains',
        ok: needles.some(needle => read.text.includes(needle)),
        detail: needles.join(' | '),
      });
    }
    if (read.ok && expected.min_length)
      checks.push({
        name: 'min_length',
        ok: read.text.length >= expected.min_length,
        detail: String(read.text.length),
      });
  } else {
    checks.push({ name: 'not ok', ok: read.ok === false, detail: read.ok ? 'unexpected ok' : 'false' });
    const reasons = Array.isArray(expected.reason) ? expected.reason : [expected.reason];
    checks.push({ name: 'reason', ok: reasons.includes(read.reason), detail: String(read.reason) });
  }
  return {
    checks,
    actual: {
      ok: read.ok,
      source: read.source,
      reason: read.reason,
      length: read.text?.length || 0,
      head: (read.text || '').slice(0, 120),
    },
  };
}

const results = [];
let skipped = 0;
for (const entry of corpus.entries) {
  if (only && entry.category !== only) continue;
  const started = Date.now();
  if (entry.layer === 'end-to-end') {
    skipped++;
    results.push({
      id: entry.id,
      category: entry.category,
      layer: entry.layer,
      status: 'N/A',
      ms: null,
      detail: '无链接，读取层不适用（端到端由 C-9 覆盖）',
      checks: [],
      actual: {},
    });
    continue;
  }
  const isBili = !!(entry.expect?.bili || entry.expect?.bili_card || entry.expect?.bili_urls);
  let outcome;
  try {
    outcome = isBili ? await biliChecks(entry) : await webChecks(entry);
  } catch (error) {
    outcome = { checks: [{ name: 'bench', ok: false, detail: error.message }], actual: {} };
  }
  const failed = outcome.checks.filter(check => !check.ok);
  results.push({
    id: entry.id,
    category: entry.category,
    layer: entry.layer,
    status: failed.length ? 'FAIL' : 'PASS',
    ms: Date.now() - started,
    detail: failed.length
      ? failed.map(check => `${check.name}: ${check.detail}`).join('; ')
      : 'ok',
    checks: outcome.checks,
    actual: outcome.actual,
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const index = Math.min(values.length - 1, Math.floor((p / 100) * values.length));
  return values[index];
}
const measured = results.filter(row => row.status !== 'N/A').map(row => row.ms).sort((a, b) => a - b);
const byCategory = {};
for (const row of results) {
  const bucket = (byCategory[row.category] ||= { pass: 0, fail: 0, na: 0 });
  if (row.status === 'PASS') bucket.pass++;
  else if (row.status === 'FAIL') bucket.fail++;
  else bucket.na++;
}
const pass = results.filter(row => row.status === 'PASS').length;
const fail = results.filter(row => row.status === 'FAIL').length;
const na = results.filter(row => row.status === 'N/A').length;
const commit = (() => {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
})();

for (const row of results) {
  const time = row.ms === null ? '    -' : String(row.ms).padStart(5) + 'ms';
  console.log(`${row.status.padEnd(4)} ${row.id.padEnd(22)} ${row.category.padEnd(14)} ${time}  ${row.detail}`);
}
console.log('');
console.log(
  `entries ${results.length}: ${pass} PASS, ${fail} FAIL, ${na} N/A` +
    (measured.length ? `  |  P50 ${percentile(measured, 50)}ms  P90 ${percentile(measured, 90)}ms` : ''),
);
console.log(
  'by category: ' +
    Object.entries(byCategory)
      .map(([name, bucket]) => `${name} ${bucket.pass}/${bucket.pass + bucket.fail}${bucket.na ? ` +${bucket.na}N/A` : ''}`)
      .join(', '),
);
console.log('QQ sends: 0 (this script has no send path)');
if (skipBili) console.log('note: --no-bili, video metadata checks were skipped');

const report = {
  version: corpus.version || null,
  generated_at: new Date().toISOString(),
  generated_by: 'scripts/fastlinks-bench.mjs',
  commit,
  node: process.version,
  corpus_path: corpusPath,
  corpus_count: corpus.entries.length,
  results,
  summary: {
    entries: results.length,
    pass,
    fail,
    na,
    measurable: measured.length,
    pass_rate: measured.length ? Number((pass / measured.length).toFixed(4)) : null,
    p50_ms: percentile(measured, 50),
    p90_ms: percentile(measured, 90),
    by_category: byCategory,
    qq_sends: 0,
    bili_network: !skipBili,
  },
};
if (jsonPath) {
  await mkdir(dirname(resolve(jsonPath)), { recursive: true });
  await writeFile(resolve(jsonPath), JSON.stringify(report, null, 2) + '\n');
  console.log(`json: ${resolve(jsonPath)}`);
}

await rm(bundlePath, { force: true });
await rm(riskPath, { force: true });
await rm(riskPath + '.lock', { force: true, recursive: true });
if (strict && fail) process.exitCode = 1;
