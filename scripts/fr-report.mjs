#!/usr/bin/env node
/**
 * F11 FR-4 · report a feature request back to the Worker.
 *
 *   node scripts/fr-report.mjs <id> shipped --release <sha7> --rollback <sha> \
 *        --reply "<一句话>" --smoke-passed
 *   node scripts/fr-report.mjs <id> failed --reason "<给用户看的原因>"
 *   node scripts/fr-report.mjs <id> needs-human --reason "<内部原因>"
 *   node scripts/fr-report.mjs <id> proposal --note "<提案摘要>"
 *   node scripts/fr-report.mjs <id> release
 *   node scripts/fr-report.mjs <id> heartbeat [--worker bini-cron]
 *
 * Reply text is preflighted locally with the server's sanitizeReply rules
 * (≤120 chars, no URL/code/hex/path/technical words) before any POST. A local
 * rejection exits 5; a server 409/422 prints its error/why and exits 6.
 *
 * Token: --token-file or FR_TOKEN_FILE, sent only in the Authorization header.
 * Exit codes: 0 ok, 2 token/usage, 3 auth, 4 network, 5 preflight, 6 server refused, 1 other.
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_WORKER, FrError, clipChars, httpFailure, oneLine, redact,
  requestJson, resolveBase, resolveToken, sanitizeReplyLocal, text,
} from './fr-lib.mjs';

const ACTIONS = ['shipped', 'failed', 'needs-human', 'proposal', 'release', 'heartbeat'];

const HELP = `Usage: node scripts/fr-report.mjs <id> <action> [options]

Actions:
  shipped      --release <sha7> --rollback <上一版> --reply "<一句话>" --smoke-passed
                （自动带 smoke_verified:true，所以必须显式 --smoke-passed）
  failed       --reason "<给用户看的原因，≤150 字>"
  needs-human  --reason "<内部原因>"
  proposal     --note "<提案摘要>"（只对 mode=proposal 的单）
  release      （developing → queued，放回队列）
  heartbeat    [--worker ${DEFAULT_WORKER}]（延长租约）

Options:
  --base URL          Worker 地址（默认 FR_BASE → TEAM_BOARD_URL → wrangler.toml → 线上地址）
  --token-file FILE   管理员令牌文件（默认 FR_TOKEN_FILE）
  -h, --help          显示本说明

回复本地预检：≤120 字；不能有链接、代码块、7+ 位十六进制、文件路径、技术词
（Worker D1 migration commit PR API token 令牌 数据库 部署 sha release 分支 回滚 npm）。

Exit codes: 0 成功，2 令牌/参数，3 鉴权，4 网络，5 预检不通过，6 服务端拒绝，1 其它。
`;

export function parseArgs(argv = []) {
  const args = {};
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') { args.help = true; continue; }
    if (arg === '--smoke-passed') { args.smokePassed = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const value = argv[++index];
    if (value == null || value.startsWith('--')) throw new FrError(2, `参数 ${arg} 缺值`);
    if (key === 'base') args.base = value;
    else if (key === 'token-file') args.tokenFile = value;
    else if (key === 'release') args.release = value;
    else if (key === 'rollback') args.rollback = value;
    else if (key === 'reply') args.reply = value;
    else if (key === 'reason') args.reason = value;
    else if (key === 'note') args.note = value;
    else if (key === 'worker') args.worker = value;
    else throw new FrError(2, `不认识的参数：${arg}`);
  }
  if (positional.length > 2) throw new FrError(2, '参数太多：只接受 <id> <action>');
  args.id = positional[0];
  args.action = positional[1];
  return args;
}

function buildReport(options) {
  const { action } = options;
  if (action === 'shipped') {
    if (!options.smokePassed) {
      throw new FrError(2, 'shipped 必须先通过冒烟，并显式加 --smoke-passed');
    }
    const release = text(options.release).trim();
    if (!/^[0-9a-f]{7,40}$/i.test(release)) {
      throw new FrError(2, 'shipped 需要 --release <sha7>（线上 /health 的版本前缀）');
    }
    const rollback = text(options.rollback).trim();
    if (!rollback) throw new FrError(2, 'shipped 需要 --rollback <上一版 sha 或版本>');
    const reply = text(options.reply).trim();
    if (!reply) throw new FrError(2, 'shipped 需要 --reply "<一句话>"');
    const checked = sanitizeReplyLocal(reply, 120);
    if (!checked.ok) throw new FrError(5, `回复预检不通过：${checked.why}`);
    return {
      outcome: 'shipped',
      release,
      rollback_point: rollback,
      smoke_verified: true,
      reply_text: checked.text,
    };
  }
  if (action === 'failed') {
    const reason = text(options.reason).trim();
    if (!reason) throw new FrError(2, 'failed 需要 --reason "<给用户看的原因>"');
    const checked = sanitizeReplyLocal(reason, 150);
    if (!checked.ok) throw new FrError(5, `失败原因预检不通过：${checked.why}`);
    return { outcome: 'failed', reason: checked.text };
  }
  if (action === 'needs-human') {
    const reason = text(options.reason).trim();
    if (!reason) throw new FrError(2, 'needs-human 需要 --reason "<内部原因>"');
    return { outcome: 'needs_human', reason: clipChars(reason, 200) };
  }
  if (action === 'proposal') {
    const note = text(options.note).trim();
    if (!note) throw new FrError(2, 'proposal 需要 --note "<提案摘要>"');
    return { outcome: 'proposal', note: clipChars(note, 2000) };
  }
  if (action === 'release') return { outcome: 'release' };
  throw new FrError(2, `不认识的动作：${text(action) || '（空）'}`);
}

export async function reportFeatureRequest(options = {}) {
  const id = text(options.id).trim();
  if (!/^fr-[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new FrError(2, `单号不合法：${oneLine(id, 80) || '（空）'}`);
  }
  const action = text(options.action).trim();
  if (!ACTIONS.includes(action)) {
    throw new FrError(2, `不认识的动作：${action || '（空）'}（见 --help）`);
  }
  const worker = oneLine(options.worker || DEFAULT_WORKER, 64);
  if (action === 'heartbeat' && !worker) throw new FrError(2, '--worker 不能是空的');
  // Validate flags and preflight before asking for a token: usage errors win.
  const body = action === 'heartbeat' ? { worker } : buildReport(options);
  const token = resolveToken(options);
  const base = resolveBase({ baseUrl: options.baseUrl, cwd: options.cwd });
  const route = action === 'heartbeat' ? 'heartbeat' : 'report';
  const url = `${base}/api/team/feature-requests/${id}/${route}`;
  const result = await requestJson(url, {
    method: 'POST', body, token, fetchImpl: options.fetchImpl,
  });
  if (result.status === 409 || result.status === 422) {
    const why = [result.json?.error, result.json?.why || result.json?.message]
      .filter(Boolean).map((part) => oneLine(redact(part, token), 200)).join(' — ');
    throw new FrError(6, `服务端拒绝（HTTP ${result.status}）：${why || oneLine(redact(result.raw, token), 200) || '无说明'}`);
  }
  if (!result.ok) throw httpFailure('POST', url, result, token);
  const status = result.json?.item?.status;
  return {
    summary: `已回写：${id} ${action}${status ? `（${status}）` : ''}`,
    status: result.status,
    body,
    json: result.json,
  };
}

export async function runCli(argv = process.argv.slice(2), deps = {}) {
  const write = deps.stdout || ((chunk) => process.stdout.write(chunk));
  const writeErr = deps.stderr || ((chunk) => process.stderr.write(chunk));
  try {
    const args = parseArgs(argv);
    if (args.help) {
      write(HELP);
      return 0;
    }
    if (!args.id || !args.action) {
      throw new FrError(2, '用法：node scripts/fr-report.mjs <id> <shipped|failed|needs-human|proposal|release|heartbeat> [选项]（--help 看说明）');
    }
    const result = await reportFeatureRequest({
      ...deps,
      id: args.id,
      action: args.action,
      baseUrl: args.base || deps.baseUrl,
      tokenFile: args.tokenFile || deps.tokenFile,
      release: args.release,
      rollback: args.rollback,
      reply: args.reply,
      reason: args.reason,
      note: args.note,
      worker: args.worker || deps.worker,
      smokePassed: args.smokePassed || deps.smokePassed,
    });
    write(`${result.summary}\n`);
    return 0;
  } catch (error) {
    const code = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
    writeErr(`fr-report: ${oneLine(redact(error?.message || error, deps.token), 500)}\n`);
    return code;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  runCli().then((code) => { process.exitCode = code; });
}
