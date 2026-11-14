import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {build} from 'esbuild';

const outfile = `.wrangler/event-101-102-103-fixtures-${process.pid}.mjs`;
await build({
  stdin: {contents: 'export {normalize} from "./src/event/normalize"; export {toInbound} from "./src/inbound"; export {forwardMeta, renderForward} from "./src/event/forward";', resolveDir: process.cwd(), loader: 'ts'},
  bundle: true, platform: 'browser', format: 'esm', outfile,
});
const api = await import('../' + outfile);

// G4's real-sample fixtures live in the g4/ subdirectory so the table-driven
// event-replay suite can own test/fixtures/events/*.json (88 fixtures, 121 total).
const dir = 'test/fixtures/events/g4';
// This suite owns the single-object G4 fixtures; the table-driven event-replay suite owns
// the array files written by scripts/fixtures-from-d1.mjs.
const fixtures = readdirSync(dir).filter(name => name.endsWith('.json'))
  .flatMap(name => {
    const value = JSON.parse(readFileSync(dir + '/' + name, 'utf8'));
    return Array.isArray(value) ? [] : [{file: name, ...value}];
  });
const byId = id => {
  const fixture = fixtures.find(f => f.id === id);
  assert.ok(fixture, 'missing fixture ' + id);
  return fixture;
};
const actual = fixture => {
  const ne = api.normalize(fixture.event, fixture.raw);
  return {ne, ib: api.toInbound(ne, fixture.raw)};
};

// Real samples: message_meta stores the raw msg_elements, messages.body stores the Inbound body
// that production wrote for the same event. Both sides come from D1, so a mismatch is a real
// regression in normalize()/toInbound(), not fixture drift.
for (const fixture of fixtures.filter(f => f.source.kind === 'd1' && !f.id.startsWith('E15-legacy'))) {
  test(`EV15-1 ${fixture.id}: 线上 103 样本正文与 D1 存档一致，引用归原消息`, () => {
    const {ne, ib} = actual(fixture), expect = fixture.expect;
    assert.equal(fixture.raw.msg_elements[0].message_type, 103);
    assert.equal(ib.body, expect.body);
    assert.deepEqual(ne.segments.map(s => s.type), expect.segmentTypes);
    assert.equal(ib.refMsgIdx, expect.refIdx);
    assert.equal(ib.quoted.text, expect.quoted.text);
    // The legacy Inbound quote shape only carries kind; owner/origin live on the normalized
    // reply preview and are what the meta `images` key later consumes.
    assert.deepEqual((ib.quoted.media || []).map(m => m.kind), expect.quoted.media.map(m => m.kind));
    const preview = ne.segments.find(s => s.type === 'reply')?.preview.segments || [];
    assert.deepEqual(preview.filter(s => s.type === 'image').map(s => ({kind: 'image', origin: s.origin, owner: s.owner})), expect.quoted.media);
    assert.equal(ib.placeholder, '');
  });
}

test('EV14-1 101 顶层正文非空时优先，元素正文不重复且图片保留', () => {
  const fixture = byId('E14-101-content-priority'), {ne, ib} = actual(fixture), expect = fixture.expect;
  assert.equal(ib.body, expect.body);
  assert.deepEqual(ne.segments.map(s => s.type), expect.segmentTypes);
  assert.equal(ne.segments.find(s => s.type === 'mention').name, '成员乙');
  for (const text of expect.absentText) assert.doesNotMatch(ib.body, new RegExp(text));
  assert.equal(ne.segments.filter(s => s.type === 'image').length, 1);
});

test('EV15-2 101 空白正文按 trim 回退元素正文，图片只出现一次', () => {
  const fixture = byId('E15-101-blank-fallback'), {ne, ib} = actual(fixture), expect = fixture.expect;
  assert.equal(ib.body, expect.body);
  assert.deepEqual(ne.segments.map(s => s.type), expect.segmentTypes);
  assert.equal(ne.segments.filter(s => s.type === 'image').length, 1);
});

test('EV14-2 102 转发的 forward 节点保留内容与作者，meta.forward 逐节点一致', () => {
  const fixture = byId('E14-102-forward-meta'), {ne, ib} = actual(fixture), expect = fixture.expect;
  assert.equal(ib.body, expect.body);
  assert.deepEqual(ne.segments.map(s => s.type), expect.segmentTypes);
  const forward = ne.segments.find(s => s.type === 'forward');
  assert.deepEqual(forward.nodes.map(n => ({authorId: n.authorId, authorName: n.authorName})), [
    {authorId: 'OPENID_SAMPLE_03', authorName: '成员丙'},
    {authorId: 'OPENID_SAMPLE_04', authorName: '成员丁'},
  ]);
  const meta = api.forwardMeta({nodes: forward.nodes, truncated: forward.truncated});
  assert.deepEqual(meta, expect.forward);
  // Forward material stays inside the untrusted envelope; it never becomes member prose.
  assert.equal(ib.body, '');
  assert.match(api.renderForward(forward), /成员丙：第一条转发原话/);
});

// Known divergence, reported to G4 without touching src: QQ delivered two type-less
// msg_elements whose content is a merged-forward text rendering ("=== 消息 1 ==="). The current
// normalizer has no other branch for a missing message_type, so the blob lands in `quoted`.
// This test pins today's output so a future fix fails loudly here instead of silently.
for (const fixture of fixtures.filter(f => f.id.startsWith('E15-legacy'))) {
  test(`EV15-3 ${fixture.id}: 无 message_type 的合并转发目前被当作引用（已知差异）`, () => {
    const {ne, ib} = actual(fixture);
    assert.deepEqual(ne.segments.map(s => s.type), ['text', 'reply']);
    assert.equal(ne.segments.filter(s => s.type === 'forward').length, 0);
    assert.equal(ib.quoted.text, fixture.expect.quoted.text);
    assert.match(ib.quoted.text, /=== 消息 1 ===/);
  });
}

test('EV15-4 夹具来源可核对：103 来自线上 D1，101/102 标注为合成', () => {
  assert.deepEqual(fixtures.filter(f => f.source.kind === 'd1').map(f => f.id).sort(), [
    'E15-103-blank-content', 'E15-103-quote-image', 'E15-103-quote-mention', 'E15-103-quote-text',
    'E15-legacy-merged-forward-a', 'E15-legacy-merged-forward-b',
  ]);
  assert.deepEqual(fixtures.filter(f => f.source.kind === 'synth').map(f => f.id).sort(), [
    'E14-101-content-priority', 'E14-102-forward-meta', 'E15-101-blank-fallback',
  ]);
});
