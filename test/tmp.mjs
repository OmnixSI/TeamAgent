/**
 * Shared scratch space for tests and replay scripts.
 *
 * Every directory lives under the OS temp directory with one prefix, and is
 * removed by an `after` hook so a failing assertion cannot leave residue
 * behind. runner/tmpclean.mjs sweeps the same prefix when a run is killed
 * before its hook fires.
 */
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';

export const TEST_TMP_PREFIX = 'teamagent-test-';

/** Create a scratch directory and register its removal with the test context. */
export function tmpDir(t, label = 'run') {
  const dir = fs.mkdtempSync(join(os.tmpdir(), TEST_TMP_PREFIX + label + '-'));
  t?.after?.(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
}

/** A scratch runner home: the directory playbook used by runner jobs. */
export function tmpHome(t, label = 'home') {
  const dir = tmpDir(t, label);
  fs.mkdirSync(join(dir, '.inkboard-team'), {recursive: true, mode: 0o700});
  return join(dir, '.inkboard-team');
}
