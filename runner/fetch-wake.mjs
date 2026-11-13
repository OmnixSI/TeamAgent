/** Local wake signal: the QQ gateway marks fetch-wake when a Bilibili link arrives. */
import {mkdirSync,renameSync,statSync,watch as watchFs,writeFileSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';

export const WAKE_FILE = 'fetch-wake';
export const BILI_LINK = /b23\.tv|bilibili\.com|BV[0-9A-Za-z]{10}/;

export function mentionsBili(raw) {
  return BILI_LINK.test(typeof raw === 'string' ? raw : String(raw ?? ''));
}

export function writeFetchWake(home, stamp = Date.now()) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const target = join(home, WAKE_FILE);
  const tmp = target + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2);
  writeFileSync(tmp, String(stamp), { mode: 0o600 });
  renameSync(tmp, target);
  return target;
}

/** fs.watch on the directory plus a stat poll: the wait never misses a replaced file. */
export function createWakePort(file, options = {}) {
  const statFile =
    options.stat ||
    ((path) => {
      try {
        return statSync(path);
      } catch {
        return null;
      }
    });
  const watchDir = options.watch || watchFs;
  const pollMs = options.pollMs ?? 250;
  const dir = dirname(file);
  const name = basename(file);
  let last = statFile(file)?.mtimeMs ?? 0;
  const pending = new Set();
  const changed = () => {
    const current = statFile(file);
    if (current && current.mtimeMs > last) {
      last = current.mtimeMs;
      return true;
    }
    return false;
  };
  const broadcast = () => {
    if (!changed()) return;
    for (const done of [...pending]) done(true);
  };
  let watcher = null;
  try {
    watcher = watchDir(dir, (_event, changedName) => {
      if (changedName && changedName !== name) return;
      broadcast();
    });
    watcher?.on?.('error', () => {});
    watcher?.unref?.();
  } catch {}
  return {
    check: changed,
    close() {
      try {
        watcher?.close?.();
      } catch {}
    },
    wait(ms) {
      if (changed()) return Promise.resolve(true);
      return new Promise((resolve) => {
        let timer, poll;
        const done = (value) => {
          clearTimeout(timer);
          clearInterval(poll);
          pending.delete(done);
          resolve(value);
        };
        pending.add(done);
        timer = setTimeout(() => done(false), ms);
        poll = setInterval(() => {
          if (changed()) done(true);
        }, Math.min(pollMs, ms));
      });
    },
  };
}
