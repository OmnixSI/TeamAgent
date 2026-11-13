import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { env } from './support.mjs';

const outfile = `.wrangler/vision-dedupe-${process.pid}.mjs`;
await build({ entryPoints: ['src/vision.ts'], bundle: true, format: 'esm', platform: 'browser', outfile });
const vision = await import('../' + outfile);
const bytes = new Uint8Array([1, 2, 3]);
const media = { kind: 'image', url: 'https://gchat.qpic.cn/image', contentType: 'image/jpeg' };
const pick = (messageId, idx = 0) => ({ messageId, idx, media, hint: '' });
const description = { desc: '一张相同的图片', tags: [], meme: false };

async function withModel(run, failFirst = false, concurrentHashes = false) {
  const old = globalThis.fetch;
  const digest = crypto.subtle.digest;
  let hashes = [];
  // Release real SHA results together to reproduce two simultaneous cache misses
  // deterministically, without depending on model/network or thread-pool timing.
  if (concurrentHashes) crypto.subtle.digest = function (...args) {
    const result = digest.apply(this, args);
    return new Promise((resolve, reject) => {
      hashes.push({ result, resolve, reject });
      if (hashes.length === 2) {
        const pair = hashes;
        hashes = [];
        Promise.all(pair.map(h => h.result)).then(
          values => pair.forEach((h, i) => h.resolve(values[i])),
          error => pair.forEach(h => h.reject(error)),
        );
      }
    });
  };
  let calls = 0;
  globalThis.fetch = async url => {
    if (String(url).startsWith('https://gchat.qpic.cn/'))
      return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
    assert.equal(new URL(url).hostname, 'api.deepseek.com');
    calls++;
    return Response.json({ choices: [{ message: {
      content: failFirst && calls === 1 ? 'invalid-json' : JSON.stringify(description),
    }, finish_reason: 'stop' }] });
  };
  try { await run(() => calls); } finally {
    globalThis.fetch = old;
    crypto.subtle.digest = digest;
  }
}

async function spent(e) {
  const row = await e.DB.prepare("SELECT SUM(CAST(value AS INTEGER)) n FROM settings WHERE key LIKE 'budget:vision:%'").first();
  return row.n ?? 0;
}

test('B24 two identical attachments in one message share analysis and budget while linking both slots', async () => {
  const e = env();
  await withModel(async calls => {
    const outcomes = await vision.annotateTurn(e, [pick('same', 0), pick('same', 1)]);
    assert.deepEqual(outcomes.map(o => o.status), ['ok', 'ok']);
    assert.equal(calls(), 1);
    assert.equal(await spent(e), 1);
    const notes = await vision.imageNotesFor(e, ['same']);
    assert.deepEqual(notes.get('same'), ['图片：一张相同的图片', '图片：一张相同的图片']);
  }, false, true);
});

test('B24 current and quoted copies of an image share analysis and preserve both associations', async () => {
  const e = env();
  await withModel(async calls => {
    const outcomes = await vision.annotateTurn(e, [pick('current'), { ...pick('original'), quoted: true }]);
    assert.deepEqual(outcomes.map(o => o.status), ['ok', 'ok']);
    assert.equal(calls(), 1);
    assert.equal(await spent(e), 1);
    const notes = await vision.imageNotesFor(e, ['current', 'original']);
    assert.equal(notes.get('current')[0], '图片：一张相同的图片');
    assert.equal(notes.get('original')[0], '图片：一张相同的图片');
  }, false, true);
});

test('B24 Promise.all byte requests share one in-flight analysis and release the successful entry', async () => {
  const e = env(), inFlight = new Map();
  await withModel(async calls => {
    const analyze = () => vision.describeBytes(e, bytes, 'image/jpeg', '', new AbortController().signal, 'v1', () => {}, inFlight);
    const notes = await Promise.all([analyze(), analyze()]);
    assert.deepEqual(notes.map(n => n?.desc), [description.desc, description.desc]);
    assert.equal(calls(), 1);
    assert.equal(await spent(e), 1);
    assert.equal(inFlight.size, 0);
  }, false, true);
});

test('B24 concurrent failure reports its reason to both images and a later turn retries successfully', async () => {
  const e = env();
  await withModel(async calls => {
    const picks = [pick('retry', 0), pick('retry', 1)];
    const failed = await vision.annotateTurn(e, picks);
    assert.deepEqual(failed.map(o => [o.status, o.stage, o.reason]), [
      ['failed', 'describe', 'invalid'], ['failed', 'describe', 'invalid'],
    ]);
    assert.equal(calls(), 1);
    assert.equal(await spent(e), 1);
    assert.equal((await e.DB.prepare('SELECT COUNT(*) n FROM message_images').first()).n, 0);
    const retried = await vision.annotateTurn(e, picks);
    assert.deepEqual(retried.map(o => o.status), ['ok', 'ok']);
    assert.equal(calls(), 2);
    assert.equal(await spent(e), 2);
  }, true, true);
});

test('B24 failed in-flight entry is removed so the same scope can retry', async () => {
  const e = env(), inFlight = new Map();
  await withModel(async calls => {
    const analyze = () => vision.describeBytes(e, bytes, 'image/jpeg', '', new AbortController().signal, 'v1', () => {}, inFlight);
    assert.equal(await analyze(), null);
    assert.equal(inFlight.size, 0);
    assert.equal((await analyze())?.desc, description.desc);
    assert.equal(calls(), 2);
    assert.equal(await spent(e), 2);
    assert.equal(inFlight.size, 0);
  }, true);
});

test('B24 model versions keep separate analysis entries for identical bytes', async () => {
  const e = env(), inFlight = new Map();
  await withModel(async calls => {
    const notes = await Promise.all(['v1', 'v2'].map(version =>
      vision.describeBytes(e, bytes, 'image/jpeg', '', new AbortController().signal, version, () => {}, inFlight)));
    assert.ok(notes.every(n => n?.desc === description.desc));
    assert.notEqual(notes[0].sha, notes[1].sha);
    assert.equal(calls(), 2);
    assert.equal(await spent(e), 2);
  });
});

test('B24 later turns reuse the persisted image note and still link the new message', async () => {
  const e = env();
  await withModel(async calls => {
    await vision.annotateTurn(e, [pick('first')]);
    const outcomes = await vision.annotateTurn(e, [pick('later')]);
    assert.equal(outcomes[0].status, 'ok');
    assert.equal(calls(), 1);
    assert.equal(await spent(e), 1);
    assert.equal((await vision.imageNotesFor(e, ['later'])).get('later')[0], '图片：一张相同的图片');
  });
});
