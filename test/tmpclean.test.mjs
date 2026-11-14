import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpDir} from './tmp.mjs';
import {
  DAY_MS,
  DEFAULT_CAP_BYTES,
  HOUR_MS,
  startTempSweeper,
  sweepDue,
  sweepTemp,
  tempRoots,
} from '../runner/tmpclean.mjs';
import {runMediaJob} from '../runner/media.mjs';
import {runDocJob} from '../runner/docread-job.mjs';

const BV = 'BV1GN4p6pEEP';

/** Backdate a path so a sweep sees it as old without waiting. */
const age = (path, ms) => {
  const seconds = (Date.now() - ms) / 1000;
  fs.utimesSync(path, seconds, seconds);
};

/** A stale job directory: one file inside, both directory and file backdated. */
function staleDir(root, name, {ageMs = 2 * HOUR_MS, bytes = 16} = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, {recursive: true});
  const file = join(dir, 'a.bin');
  fs.writeFileSync(file, Buffer.alloc(bytes));
  age(file, ageMs);
  age(dir, ageMs);
  return dir;
}

function freshDir(root, name, {bytes = 16} = {}) {
  const dir = join(root, name);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(join(dir, 'a.bin'), Buffer.alloc(bytes));
  return dir;
}

const mediaJob = () => ({
  id: 'bmedia-' + BV,
  kind: 'bili_media',
  payload: {bvid: BV, duration: 120, until: Date.now() + 60000, lease: 'lease-clean'},
});

function mediaStages(home, extra = {}) {
  const cdn = 'https://audio.bilivideo.com/a?token=secret';
  return {
    home,
    settings: {'asr:provider': 'local'},
    asrConfig: {python: '/python', model_dir: '/models'},
    client: {
      isPaused: () => false,
      sanitize: x => x,
      biliAudio: async () => ({duration: 120, cid: 1, urls: [{baseUrl: cdn}]}),
    },
    download: async (_url, dest) => fs.writeFileSync(dest, 'audio'),
    ffmpeg: async (_src, dest) => fs.writeFileSync(dest, 'wave'),
    asr: async () => ({
      segments: [{start: 0, end: 120, text: '这是超过十个字的一段中文转写文本。'}],
      audio_s: 120,
      max_rss_mb: 200,
      nice: 15,
    }),
    cloud: async () => ({status: 200}),
    ...extra,
  };
}

const docJob = () => ({
  id: 'docread-m1-0-abc123',
  kind: 'docread',
  payload: {
    message_id: 'm1',
    group_id: 'GROUP1',
    filename: 'report.pdf',
    key: 'doc:m1:0:abc123',
    url: 'https://multimedia.nt.qq.com.cn/download?fileid=1',
    lease: 'lease-1',
  },
});

test('CL-1 every runner scratch root has a TTL within the agreed bounds', t => {
  const home = tmpDir(t, 'roots');
  const roots = tempRoots({home, tmp: join(home, 'tmp'), cardDir: join(home, 'card')});
  const byKind = Object.fromEntries(roots.map(root => [root.kind, root]));
  for (const kind of ['media', 'voice']) assert.ok(byKind[kind].ttlMs <= HOUR_MS, kind + ' must expire within an hour');
  for (const kind of ['doc', 'tts', 'card']) assert.ok(byKind[kind].ttlMs <= DAY_MS, kind + ' must expire within a day');
  assert.ok(DEFAULT_CAP_BYTES <= 500 * 1024 ** 2);
});

test('CL-2 expired jobs are removed, active ones are kept', t => {
  const home = tmpDir(t, 'ttl');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const mediaOld = staleDir(join(home, 'media-tmp'), 'bmedia-old');
  const mediaFresh = freshDir(join(home, 'media-tmp'), 'bmedia-fresh');
  const docOld = staleDir(join(home, 'doc-tmp'), 'docread-old', {ageMs: 25 * HOUR_MS});
  const docFresh = freshDir(join(home, 'doc-tmp'), 'docread-fresh');
  const voiceOld = staleDir(join(home, 'voice-tmp'), 'voice-old');
  const ttsFresh = freshDir(join(home, 'tts-cache'), 'fresh.wav');

  const result = sweepTemp({home, tmp, cardDir: join(home, 'card')});

  assert.equal(fs.existsSync(mediaOld), false);
  assert.equal(fs.existsSync(docOld), false);
  assert.equal(fs.existsSync(voiceOld), false);
  assert.equal(fs.existsSync(mediaFresh), true, 'a job younger than an hour is still running');
  assert.equal(fs.existsSync(docFresh), true);
  assert.equal(fs.existsSync(ttsFresh), true);
  assert.deepEqual(result.removed.map(row => row.reason), ['ttl', 'ttl', 'ttl']);
});

test('CL-3 the total cap deletes the oldest entries first and stops at the cap', t => {
  const home = tmpDir(t, 'cap');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const oldest = staleDir(join(home, 'media-tmp'), 'a-oldest', {ageMs: 50 * 60000, bytes: 50});
  const middle = staleDir(join(home, 'doc-tmp'), 'b-middle', {ageMs: 40 * 60000, bytes: 50});
  const newest = staleDir(join(home, 'doc-tmp'), 'c-newest', {ageMs: 30 * 60000, bytes: 50});

  const result = sweepTemp({home, tmp, cardDir: join(home, 'card'), capBytes: 90, graceMs: 600000});

  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(middle), false);
  assert.equal(fs.existsSync(newest), true);
  assert.ok(result.bytes <= 90);
  assert.deepEqual(result.removed.every(row => row.reason === 'cap'), true);
});

test('CL-4 runs younger than the grace window are never deleted to satisfy the cap', t => {
  const home = tmpDir(t, 'grace');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const active = freshDir(join(home, 'media-tmp'), 'active', {bytes: 400});
  const result = sweepTemp({home, tmp, cardDir: join(home, 'card'), capBytes: 1});
  assert.equal(fs.existsSync(active), true);
  assert.equal(result.removed.length, 0);
});

test('CL-5 config, cursors, tokens, dependencies and models are never removed', t => {
  const home = tmpDir(t, 'keep');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const keep = {
    config: join(home, 'config.json'),
    settings: join(home, 'agent-settings.json'),
    token: join(home, 'secrets', 'admin-token'),
    cursor: join(home, 'state', 'chat-cursor.json'),
    result: join(home, 'results', 'last.json'),
    dep: join(home, 'node_modules', 'silk-wasm', 'package.json'),
    venv: join(home, 'xasr-venv', 'bin', 'python'),
    model: join(home, 'models', 'x-asr', 'model.onnx'),
  };
  for (const [name, path] of Object.entries(keep)) {
    fs.mkdirSync(join(path, '..'), {recursive: true});
    fs.writeFileSync(path, name);
    age(path, 3 * DAY_MS);
  }
  fs.mkdirSync(join(home, 'media-tmp'), {recursive: true});
  const stale = staleDir(join(home, 'media-tmp'), 'stale', {ageMs: 2 * HOUR_MS});

  const result = sweepTemp({home, tmp, cardDir: join(home, 'card'), capBytes: 1});

  for (const [name, path] of Object.entries(keep)) assert.equal(fs.existsSync(path), true, name + ' must survive');
  assert.equal(fs.existsSync(stale), false);
  assert.deepEqual(result.skipped, 0);
});

test('CL-6 a symlink inside a scratch root is never followed or removed', t => {
  const home = tmpDir(t, 'link');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const token = join(home, 'secrets', 'admin-token');
  fs.mkdirSync(join(home, 'secrets'), {recursive: true});
  fs.writeFileSync(token, 'secret-value');
  age(token, 3 * DAY_MS);
  const media = join(home, 'media-tmp');
  fs.mkdirSync(media, {recursive: true});
  fs.symlinkSync(join(home, 'secrets'), join(media, 'secrets-link'));
  age(join(media, 'secrets-link'), 3 * DAY_MS);

  sweepTemp({home, tmp, cardDir: join(home, 'card'), capBytes: 1});

  assert.equal(fs.readFileSync(token, 'utf8'), 'secret-value');
});

test('CL-7 only the runner-owned prefixes in the shared temp directory are touched', t => {
  const home = tmpDir(t, 'prefix');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const silkOld = staleDir(tmp, 'f9ds-silk-old', {ageMs: 2 * HOUR_MS});
  const testOld = staleDir(tmp, 'teamagent-test-old', {ageMs: 25 * HOUR_MS});
  const silkFresh = freshDir(tmp, 'f9ds-silk-fresh');
  const foreign = staleDir(tmp, 'some-other-tool', {ageMs: 10 * DAY_MS});

  const result = sweepTemp({home, tmp, cardDir: join(home, 'card')});

  assert.equal(fs.existsSync(silkOld), false);
  assert.equal(fs.existsSync(testOld), false);
  assert.equal(fs.existsSync(silkFresh), true);
  assert.equal(fs.existsSync(foreign), true, 'another tool\'s scratch space is not ours');
  assert.equal(result.removed.length, 2);
});

test('CL-8 the sweeper runs at startup and then every hour until stopped', t => {
  const home = tmpDir(t, 'timer');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const first = staleDir(join(home, 'media-tmp'), 'first');
  const timers = [];
  let cleared = null;
  const sweeper = startTempSweeper({
    home,
    tmp,
    cardDir: join(home, 'card'),
    log: () => {},
    setInterval: (fn, ms) => {
      timers.push({fn, ms});
      return 7;
    },
    clearInterval: id => {
      cleared = id;
    },
  });
  assert.equal(fs.existsSync(first), false, 'startup sweep runs immediately');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, HOUR_MS);

  const second = staleDir(join(home, 'media-tmp'), 'second');
  timers[0].fn();
  assert.equal(fs.existsSync(second), false, 'the hourly tick sweeps again');

  sweeper.stop();
  assert.equal(cleared, 7);
});

test('CL-9 an overlapping tick is skipped instead of sweeping twice', t => {
  const home = tmpDir(t, 'overlap');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  let entered = 0;
  let api = null;
  let tick = null;
  const sweeper = startTempSweeper({
    home,
    tmp,
    cardDir: join(home, 'card'),
    log: () => {},
    sweep: () => {
      entered += 1;
      if (entered === 2) api.run();
      return {removed: [], bytes: 0};
    },
    setInterval: fn => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {},
  });
  api = sweeper;
  assert.equal(entered, 1);
  tick();
  assert.equal(entered, 2, 'a tick that re-enters while sweeping is skipped');
  sweeper.stop();
});

test('CL-10 the hourly gate stays closed until the interval has passed', t => {
  const home = tmpDir(t, 'due');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const state = join(home, 'state', 'tmpclean.json');
  const start = Date.now();
  const first = staleDir(join(home, 'media-tmp'), 'first');

  assert.equal(sweepDue({home, tmp, cardDir: join(home, 'card'), now: start, statePath: state}), true);
  assert.equal(fs.existsSync(first), false);
  assert.equal(sweepDue({home, tmp, cardDir: join(home, 'card'), now: start + 60000, statePath: state}), false);
  const second = staleDir(join(home, 'media-tmp'), 'second');
  assert.equal(sweepDue({home, tmp, cardDir: join(home, 'card'), now: start + HOUR_MS, statePath: state}), true);
  assert.equal(fs.existsSync(second), false);
});

test('CL-11 a failed media job still leaves no audio or partial files behind', async t => {
  const home = tmpDir(t, 'media');
  const result = await runMediaJob(
    mediaJob(),
    mediaStages(home, {
      asr: async () => {
        throw Object.assign(Error('bad'), {reason: 'asr_failed'});
      },
    }),
  );
  assert.equal(result.report.reason, 'asr_failed');
  assert.equal(result.cleanup.residue, 0);
  assert.deepEqual(fs.readdirSync(join(home, 'media-tmp')), []);
});

test('CL-12 a timed-out document job still removes its download directory', async t => {
  const home = tmpDir(t, 'doc');
  const {report, cleanup} = await runDocJob(docJob(), {
    home,
    python: '/fixture/python',
    download: async (_url, dest) => fs.writeFileSync(dest, 'PDF'),
    exec: async () => ({code: 'ETIMEDOUT', killed: true, stdout: '', stderr: ''}),
  });
  assert.equal(report.reason, 'timeout');
  assert.equal(cleanup.residue, 0);
  assert.deepEqual(fs.readdirSync(join(home, 'doc-tmp')), []);
});

test('CL-13 a failed document download also removes its directory', async t => {
  const home = tmpDir(t, 'docfail');
  const {report, cleanup} = await runDocJob(docJob(), {
    home,
    download: async () => {
      throw Error('download_failed');
    },
  });
  assert.equal(report.success, false);
  assert.equal(report.reason, 'download_failed');
  assert.equal(cleanup.residue, 0);
  assert.deepEqual(fs.readdirSync(join(home, 'doc-tmp')), []);
});

test('CL-14 scratch prefixes from before the shared name are reclaimed once stale', t => {
  const home = tmpDir(t, 'legacy');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  const legacyOld = staleDir(tmp, 'media-test-CPYRM2', {ageMs: 25 * HOUR_MS});
  const legacyFresh = freshDir(tmp, 'media-test-FRESH1');
  const reviewOld = staleDir(tmp, 'review-pull-abc', {ageMs: 2 * DAY_MS});

  sweepTemp({home, tmp, cardDir: join(home, 'card')});

  assert.equal(fs.existsSync(legacyOld), false);
  assert.equal(fs.existsSync(reviewOld), false);
  assert.equal(fs.existsSync(legacyFresh), true, 'a running test keeps its directory');
});

test('CL-15 the cap pass leaves media scratch alone while a job holds the media lock', t => {
  const home = tmpDir(t, 'locked');
  const tmp = join(home, 'tmp');
  fs.mkdirSync(tmp, {recursive: true});
  fs.mkdirSync(join(home, 'media.lock'), {recursive: true});
  const running = staleDir(join(home, 'media-tmp'), 'running', {ageMs: 20 * 60000, bytes: 90});
  const other = staleDir(join(home, 'doc-tmp'), 'old-doc', {ageMs: 30 * 60000, bytes: 90});

  const result = sweepTemp({home, tmp, cardDir: join(home, 'card'), capBytes: 60, graceMs: 600000});

  assert.equal(fs.existsSync(running), true, 'a locked media job is not trimmed mid-run');
  assert.equal(fs.existsSync(other), false, 'other roots still respect the cap');
  assert.deepEqual(result.removed.map(row => row.kind), ['doc']);
});
