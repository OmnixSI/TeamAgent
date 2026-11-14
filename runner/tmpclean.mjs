/**
 * Runner scratch cleanup.
 *
 * Every job already deletes its own directory in a `finally`, so this module is
 * the second line of defence: it walks the runner's own scratch roots on start
 * and every hour, deletes entries past their TTL, and keeps the total under a
 * cap by dropping the oldest first.
 *
 * Only the roots listed in `tempRoots()` are ever read. Config, secrets,
 * cursors, results, dependencies, the X-ASR model and anything another tool
 * keeps in the shared temp directory are outside them and are never entered.
 */
import fs from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
/** Audio and video work is short-lived; documents and caches may linger a day. */
export const MEDIA_TTL_MS = HOUR_MS;
export const CACHE_TTL_MS = DAY_MS;
export const DEFAULT_CAP_BYTES = 500 * 1024 ** 2;
/** Running work refreshes its files; a cap pass never touches anything younger than this. */
export const DEFAULT_GRACE_MS = 10 * 60 * 1000;
export const SILK_PREFIX = 'f9ds-silk-';
export const TEST_PREFIX = 'teamagent-test-';
/** Prefixes tests used before the shared one; kept one release so old junk is reclaimed. */
export const LEGACY_TEST_PREFIXES = [
  'media-test-', 'docread-job-', 'docread-replay-', 'card-samples-', 'silk-test-',
  'team-auth-', 'team-qr-', 'team-fetch-wake-', 'team-wake-port-', 'team-shared-auth-',
  'team-risk-', 'team-delivery-', 'team-login-', 'native-x-', 'qq-voice-',
  'review-d5a-', 'review-d6-', 'review-probes-', 'review-pull-', 'review-golden-', 'f9ds-1b-test-',
];
const CARD_DIR = '/tmp/inkboard-card-samples';
const MAX_DEPTH = 6;
/** Names that belong to configuration or state, never to scratch space. */
const PROTECTED = new Set([
  'config.json',
  'agent-settings.json',
  'dsh-team.yml',
  'secrets',
  'state',
  'results',
  'node_modules',
  'xasr-venv',
  'models',
]);

/** The runner's scratch roots with their individual TTLs. */
export function tempRoots({home = join(homedir(), '.inkboard-team'), tmp = tmpdir(), cardDir = CARD_DIR} = {}) {
  return [
    {kind: 'media', dir: join(home, 'media-tmp'), ttlMs: MEDIA_TTL_MS},
    {kind: 'voice', dir: join(home, 'voice-tmp'), ttlMs: MEDIA_TTL_MS},
    {kind: 'doc', dir: join(home, 'doc-tmp'), ttlMs: CACHE_TTL_MS},
    {kind: 'tts', dir: join(home, 'tts-cache'), ttlMs: CACHE_TTL_MS},
    {kind: 'card', dir: cardDir, ttlMs: CACHE_TTL_MS},
    // Shared temp directories are only swept by our own prefix.
    {kind: 'silk', dir: tmp, prefix: SILK_PREFIX, ttlMs: MEDIA_TTL_MS},
    {kind: 'test', dir: tmp, prefix: TEST_PREFIX, ttlMs: CACHE_TTL_MS},
    {kind: 'test-legacy', dir: tmp, prefixes: LEGACY_TEST_PREFIXES, ttlMs: CACHE_TTL_MS},
  ];
}

/**
 * Size and newest mtime of one entry. Symlinks are never followed: a link into
 * `secrets/` counts as zero bytes and its target keeps its own mtime.
 */
function measure(path, depth = 0) {
  const stat = fs.lstatSync(path);
  if (stat.isSymbolicLink()) return {bytes: 0, newest: stat.mtimeMs};
  if (!stat.isDirectory()) return {bytes: stat.size, newest: stat.mtimeMs};
  // Only file contents count: an empty directory is not storage pressure.
  let bytes = 0;
  let newest = stat.mtimeMs;
  if (depth >= MAX_DEPTH) return {bytes, newest};
  for (const name of fs.readdirSync(path)) {
    try {
      const child = measure(join(path, name), depth + 1);
      bytes += child.bytes;
      newest = Math.max(newest, child.newest);
    } catch {}
  }
  return {bytes, newest};
}

function remove(path) {
  try {
    fs.rmSync(path, {recursive: true, force: true, maxRetries: 2});
  } catch {
    return false;
  }
  return !fs.existsSync(path);
}

/**
 * One sweep. Returns the removals with their reason, plus the bytes that are
 * still on disk across the roots after the pass.
 */
export function sweepTemp({
  home = join(homedir(), '.inkboard-team'),
  tmp = tmpdir(),
  cardDir = CARD_DIR,
  roots,
  now = Date.now(),
  capBytes = DEFAULT_CAP_BYTES,
  graceMs = DEFAULT_GRACE_MS,
  log = () => {},
} = {}) {
  const candidates = [];
  let skipped = 0;
  for (const root of roots || tempRoots({home, tmp, cardDir})) {
    const base = resolve(root.dir);
    let names;
    try {
      names = fs.readdirSync(base);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      const prefixes = root.prefixes || (root.prefix ? [root.prefix] : []);
      if (prefixes.length && !prefixes.some(prefix => name.startsWith(prefix))) continue;
      if (PROTECTED.has(name)) {
        skipped += 1;
        continue;
      }
      const path = join(base, name);
      const resolved = resolve(path);
      if (resolved !== join(base, name) || !resolved.startsWith(base + sep)) {
        skipped += 1;
        continue;
      }
      let stat;
      try {
        stat = fs.lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      let size;
      try {
        size = measure(path);
      } catch {
        continue;
      }
      candidates.push({path, kind: root.kind, ttlMs: root.ttlMs, bytes: size.bytes, newest: size.newest, removed: false});
    }
  }

  const removed = [];
  for (const item of candidates) {
    if (now - item.newest <= item.ttlMs) continue;
    if (!remove(item.path)) continue;
    item.removed = true;
    removed.push({path: item.path, kind: item.kind, reason: 'ttl', bytes: item.bytes});
  }

  let bytes = candidates.filter(item => !item.removed).reduce((sum, item) => sum + item.bytes, 0);
  const cap = Number.isFinite(capBytes) ? Math.max(0, capBytes) : DEFAULT_CAP_BYTES;
  // A media job can hold its directory for up to forty minutes without touching
  // it again, so a cap pass never trims media-tmp while that lock is held. The
  // TTL pass still reclaims a hung job once it is over an hour old.
  const mediaBusy = fs.existsSync(join(home, 'media.lock'));
  if (bytes > cap) {
    for (const item of candidates.filter(entry => !entry.removed).sort((a, b) => a.newest - b.newest)) {
      if (bytes <= cap) break;
      // A recently touched entry may still be an active job; the TTL pass reclaims it later.
      if (now - item.newest < graceMs) continue;
      if (mediaBusy && item.kind === 'media') continue;
      if (!remove(item.path)) continue;
      item.removed = true;
      bytes -= item.bytes;
      removed.push({path: item.path, kind: item.kind, reason: 'cap', bytes: item.bytes});
    }
  }

  if (removed.length) log('临时文件清理 ' + removed.length + ' 项');
  return {
    removed,
    bytes,
    capBytes: cap,
    kept: candidates.filter(item => !item.removed).length,
    skipped,
  };
}

/**
 * Sweep once at startup, then every `intervalMs`. A tick that lands while the
 * previous sweep is still running is skipped rather than queued.
 */
export function startTempSweeper(options = {}) {
  const {
    intervalMs = HOUR_MS,
    log = () => {},
    setInterval: every = setInterval,
    clearInterval: cancel = clearInterval,
    sweep = sweepTemp,
  } = options;
  let busy = false;
  let stopped = false;
  let timer;
  const api = {
    run() {
      if (stopped || busy) return null;
      busy = true;
      try {
        return sweep(options);
      } catch {
        log('临时文件清理未完成');
        return null;
      } finally {
        busy = false;
      }
    },
    stop() {
      stopped = true;
      cancel(timer);
    },
  };
  api.run();
  timer = every(api.run, intervalMs);
  timer?.unref?.();
  return api;
}

/**
 * Startup sweep that self-gates to once per interval, for processes launchd
 * restarts every minute. The stamp lives with the runner's other state.
 */
export function sweepDue({
  home = join(homedir(), '.inkboard-team'),
  tmp = tmpdir(),
  cardDir = CARD_DIR,
  roots,
  now = Date.now(),
  intervalMs = HOUR_MS,
  capBytes = DEFAULT_CAP_BYTES,
  statePath,
  log = () => {},
} = {}) {
  const state = statePath || join(home, 'state', 'tmpclean.json');
  let last = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(state, 'utf8'));
    last = Number(parsed?.last) || 0;
  } catch {}
  if (now - last < intervalMs) return false;
  sweepTemp({home, tmp, cardDir, roots, now, capBytes, log});
  try {
    fs.mkdirSync(dirname(state), {recursive: true, mode: 0o700});
    const temp = state + '.tmp-' + process.pid;
    fs.writeFileSync(temp, JSON.stringify({last: now}), {mode: 0o600});
    fs.renameSync(temp, state);
  } catch {}
  return true;
}
