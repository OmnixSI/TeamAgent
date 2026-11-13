import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {runtimeHome} from '../runner/home.mjs';

test('runtime home defaults to the real private runtime', () => {
  assert.equal(runtimeHome({}), join(homedir(), '.inkboard-team'));
});

test('INKBOARD_TEAM_HOME selects an isolated runtime', () => {
  assert.equal(runtimeHome({INKBOARD_TEAM_HOME: '/tmp/b5-iso'}), '/tmp/b5-iso');
});

test('node entrypoints resolve their runtime through the shared helper', () => {
  for (const path of ['runner/qq-gateway.mjs', 'runner/fetcher.mjs', 'runner/media.mjs', 'runner/browser-auth.mjs']) {
    const text = readFileSync(path, 'utf8');
    assert.match(text, /runtimeHome/, path);
    assert.doesNotMatch(text, /join\(homedir\(\), ?['"]\.inkboard-team['"]\)/, path);
  }
});
