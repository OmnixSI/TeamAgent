import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { env, req } from './support.mjs';

const URL = '/api/team/imagegen/selftest';

// Minimal JPEG header carrying SOF0 dimensions; enough for the selftest parser.
function jpeg(width = 1024, height = 1024, pad = 64) {
  const bytes = new Uint8Array(21 + pad);
  bytes.set([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11,
    0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
  return bytes;
}

function imageResponse(width = 1024, height = 1024, pad = 64) {
  return Response.json({
    data: [{ b64_json: Buffer.from(jpeg(width, height, pad)).toString('base64') }],
  });
}

function stubFetch(fn) {
  const original = globalThis.fetch;
  globalThis.fetch = fn;
  return () => { globalThis.fetch = original; };
}

// Every route test gets its own hour bucket so the in-memory limiter is isolated.
async function atHour(hour, fn) {
  mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1, hour) });
  try {
    return await fn();
  } finally {
    mock.timers.reset();
  }
}

test('F8-3 selftest rejects anonymous requests', async () => {
  const e = env();
  const response = await req(e, URL, undefined, '');
  assert.equal(response.status, 401);
});

test('F8-3 owner selftest returns image metrics and writes no D1 rows', async () => atHour(0, async () => {
  const e = env();
  e.OPENAI_API_KEY = 'sk-test-owner-smoke';
  const writes = [];
  const prepare = e.DB.prepare.bind(e.DB);
  e.DB.prepare = (sql) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql)) writes.push(sql);
    return prepare(sql);
  };
  let request = null;
  const restore = stubFetch(async (input, init) => {
    request = { url: String(input), init };
    return imageResponse(1024, 1024, 128);
  });
  try {
    const response = await req(e, URL);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(), [
      'bytes', 'height', 'latency_ms', 'model', 'ok', 'width',
    ]);
    assert.equal(body.ok, true);
    assert.equal(body.width, 1024);
    assert.equal(body.height, 1024);
    assert.ok(body.bytes > 0);
    assert.equal(body.model, 'gpt-image-1');
    assert.equal(typeof body.latency_ms, 'number');
  } finally {
    restore();
  }
  assert.deepEqual(writes, [], writes.join('\n'));
  assert.equal(request.url, 'https://api.openai.com/v1/images/generations');
  const sent = JSON.parse(request.init.body);
  assert.equal(sent.size, '1024x1024');
  assert.equal(sent.quality, 'low');
  assert.equal(sent.n, 1);
}));

test('F8-3 missing key fails with auth and does not call the network', async () => atHour(1, async () => {
  const e = env();
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return imageResponse();
  });
  try {
    const response = await req(e, URL);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.error_kind, 'auth');
    assert.ok(body.next_action);
  } finally {
    restore();
  }
  assert.equal(calls, 0);
}));

test('F8-3 upstream failure is safe and never leaks key or prompt', async () => atHour(2, async () => {
  const e = env();
  e.OPENAI_API_KEY = 'sk-do-not-leak-123';
  const restore = stubFetch(async () => {
    throw new Error('Authorization: Bearer sk-do-not-leak-123 failed');
  });
  try {
    const response = await req(e, URL);
    assert.equal(response.status, 502);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.ok(body.error_kind);
    assert.ok(body.next_action);
    assert.doesNotMatch(JSON.stringify(body), /sk-do-not-leak-123|Bearer/i);
  } finally {
    restore();
  }
}));

test('F8-3 selftest allows at most two calls per hour', async () => atHour(3, async () => {
  const e = env();
  e.OPENAI_API_KEY = 'sk-test-rate-limit';
  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return imageResponse();
  });
  try {
    assert.equal((await req(e, URL)).status, 200);
    assert.equal((await req(e, URL)).status, 200);
    const third = await req(e, URL);
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.equal(body.ok, false);
    assert.equal(body.error_kind, 'quota');
    assert.match(body.next_action, /小时/);
    assert.equal(calls, 2);
  } finally {
    restore();
  }
}));
