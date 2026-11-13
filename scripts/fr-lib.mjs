/**
 * F11 FR-4 · shared helpers for the studio-side feature-request scripts.
 *
 * The token is only ever placed in the Authorization header. It is never
 * printed, logged or written to disk; error text is passed through redact().
 * Scripts are import-safe: nothing runs until runCli() is called.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const DEFAULT_BASE = 'https://inkboard-team.inkboard-server.workers.dev';
export const DEFAULT_WORKER = 'bini-cron';
export const DEFAULT_LIMIT = 20;

/** Failure with a CLI exit code. */
export class FrError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'FrError';
    this.exitCode = exitCode;
  }
}

export function text(value) {
  return value == null ? '' : String(value);
}

export function oneLine(value, max = 300) {
  const flat = text(value).replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : flat;
}

export function clipChars(value, max) {
  const chars = [...text(value)];
  return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
}

/** Strip the token from anything that may be echoed back. */
export function redact(value, token) {
  let result = text(value);
  if (token) result = result.split(token).join('***');
  return result;
}

export function resolveToken({ token, tokenFile, env = process.env } = {}) {
  if (typeof token === 'string' && token.trim()) return token.trim();
  const file = text(tokenFile || env.FR_TOKEN_FILE).trim();
  if (!file) {
    throw new FrError(2, '缺少令牌：用 --token-file <文件> 或设置 FR_TOKEN_FILE');
  }
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    throw new FrError(2, `读不了令牌文件：${file}`);
  }
  const value = raw.trim();
  if (!value) throw new FrError(2, `令牌文件是空的：${file}`);
  return value;
}

export function normalizeBase(value) {
  const base = text(value).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+/i.test(base)) {
    throw new FrError(2, `--base 必须是 http(s) 地址：${oneLine(base, 80) || '（空）'}`);
  }
  return base;
}

/** Read a Worker URL from wrangler.toml: a route/pattern or an explicit *_URL var. */
export function readWranglerBase(cwd = process.cwd()) {
  const file = resolve(cwd, 'wrangler.toml');
  if (!existsSync(file)) return '';
  let source = '';
  try {
    source = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const variable = source.match(/^\s*(?:WORKER_URL|BASE_URL|PUBLIC_URL)\s*=\s*"([^"]+)"/m);
  if (variable) return variable[1];
  const route = source.match(/^\s*(?:route|pattern)\s*=\s*"([^"]+)"/m);
  if (!route) return '';
  const host = route[1]
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .trim();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) ? `https://${host}` : '';
}

export function resolveBase({ baseUrl, cwd = process.cwd(), env = process.env } = {}) {
  return normalizeBase(
    baseUrl || env.FR_BASE || env.TEAM_BOARD_URL || readWranglerBase(cwd) || DEFAULT_BASE,
  );
}

/**
 * One JSON request. 401/403 become exit 3 and network failures exit 4;
 * every other status is returned for the caller to interpret.
 */
export async function requestJson(url, {
  method = 'GET', body, token, fetchImpl, timeoutMs = 20000, accept = 'application/json',
} = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') throw new FrError(1, '当前 Node 没有 fetch');
  const headers = { authorization: `Bearer ${token}`, accept };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetchFn(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new FrError(4, `网络错误：${oneLine(redact(error?.message || error, token), 200)}`);
  }
  const raw = await response.text().catch(() => '');
  let json = null;
  if (raw) {
    try {
      json = JSON.parse(raw);
    } catch {
      json = null;
    }
  }
  if (response.status === 401 || response.status === 403) {
    throw new FrError(3, `鉴权失败（HTTP ${response.status}）：检查令牌文件里是不是管理员令牌`);
  }
  return { response, status: response.status, ok: response.ok, json, raw };
}

export function httpFailure(verb, url, result, token) {
  const detail = oneLine(redact(result.raw, token), 160);
  return new FrError(1, `${verb} ${url} → HTTP ${result.status}${detail ? `：${detail}` : ''}`);
}

export function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temp, content);
    renameSync(temp, file);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // best effort
    }
    throw new FrError(1, `写不了 ${file}：${oneLine(error?.message || error, 160)}`);
  }
}

export function formatSydney(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return '未知';
  const stamp = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Australia/Sydney',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
  return `${stamp}（Sydney）`;
}

/** risk_tags arrives as an array (FrPublic) or a JSON string (D1 row). */
export function parseTags(value) {
  let tags = [];
  if (Array.isArray(value)) tags = value;
  else {
    try {
      const parsed = JSON.parse(text(value));
      if (Array.isArray(parsed)) tags = parsed;
    } catch {
      tags = text(value) ? [text(value)] : [];
    }
  }
  return tags.map((tag) => oneLine(tag, 40)).filter(Boolean);
}

const URL_RE = /https?:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|cn|net|org|io|dev|app)\b/i;
const CODE_RE = /`|~~~/;
const HEX_RE = /\b[0-9a-f]{7,40}\b/i;
const PATH_RE = /(^|[\s（(])(?:~\/|\.{1,2}\/|[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|opt|usr|private|root|workspace|projects)\/)|\b[\w.-]+\.(?:ts|tsx|js|mjs|cjs|json|md|py|sql|toml|ya?ml|sh)\b/i;
const TECH_RE = /\b(?:worker|d1|migration|commit|pr|api|token|sha|release|npm)\b/i;
const TECH_CN = ['令牌', '数据库', '部署', '分支', '回滚'];

/**
 * Local mirror of the server's sanitizeReply (FR-1): same rules, slightly
 * stricter. Returns {ok:true,text} or {ok:false,why} in plain Chinese.
 */
export function sanitizeReplyLocal(value, max = 120) {
  const cleaned = text(value).replace(/\s+/g, ' ').trim();
  if (!cleaned) return { ok: false, why: '回复不能为空' };
  const size = [...cleaned].length;
  if (size > max) return { ok: false, why: `回复超过 ${max} 字（现在 ${size} 字）` };
  if (URL_RE.test(cleaned)) return { ok: false, why: '回复里有链接' };
  if (CODE_RE.test(cleaned)) return { ok: false, why: '回复里有代码块' };
  if (HEX_RE.test(cleaned)) return { ok: false, why: '回复里有 7 位以上十六进制串（像提交号）' };
  if (PATH_RE.test(cleaned)) return { ok: false, why: '回复里有文件路径' };
  const english = cleaned.match(TECH_RE);
  if (english) return { ok: false, why: `回复里有技术词「${english[0]}」` };
  const chinese = TECH_CN.find((word) => cleaned.includes(word));
  if (chinese) return { ok: false, why: `回复里有技术词「${chinese}」` };
  return { ok: true, text: cleaned };
}
