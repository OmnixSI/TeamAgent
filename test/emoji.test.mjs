import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { env, qq, msg, req } from './support.mjs';
import { worker } from './support.mjs';

const load = async name => {
  const outfile = `.wrangler/emoji-${name}-${process.pid}.mjs`;
  await build({ entryPoints: [`src/${name}.ts`], bundle: true, format: 'esm', platform: 'browser', outfile });
  return import('../' + outfile);
};
const face = await load('face'), view = await load('view'), inbound = await load('inbound'), vision = await load('vision'), gif = await load('gif');
const fixture = JSON.parse(readFileSync(new URL('../replay/fixtures/emoji-messages.json', import.meta.url), 'utf8'));
const byId = (id) => fixture.messages.find((m) => m.rowid === id);
const imageBytes = (filename) => new Uint8Array(readFileSync(new URL('../replay/fixtures/emoji/' + filename, import.meta.url)));
const superBytes = imageBytes('304-super.jpg');
const stickerFiles = {
  'F9EB7F627FB6EDE2AACF1FC22E722A85.jpg': '497-F9EB7F627FB6EDE2AACF1FC22E722A85.jpg',
  '0A4E6B6162FA1C30247745B4276FAF53.jpg': '498-0A4E6B6162FA1C30247745B4276FAF53.jpg',
  '0ABD880646F845A1E56AB7519C27A76A.jpg': '499-0ABD880646F845A1E56AB7519C27A76A.jpg',
  '1FB8C0BC70313BE2725DB7FC1CAD75D3.jpg': '500-1FB8C0BC70313BE2725DB7FC1CAD75D3.jpg',
};
const fakeModel = (desc, tags) => async (url, init) => {
  if (String(url).includes('api.deepseek.com')) {
    const body = JSON.parse(init.body);
    assert.ok(String(body.messages?.[0]?.content?.[0]?.text || '').includes('表情包'), 'sticker prompt reaches the provider');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ desc, tags, meme: true }) }, finish_reason: 'stop' }] });
  }
  return new Response(superBytes, { headers: { 'content-type': 'image/jpeg' } });
};
const originalFetch = globalThis.fetch;

test('E1 real QQ face ids decode to readable names for both ext formats', () => {
  const expected = {
    171: '肥鱼我要给你完整的一生[表情：流泪]',
    224: '[表情：笑哭]',
    265: '[表情：捂脸][表情：捂脸]',
    376: '[表情：可爱][表情：可爱]',
    503: '来看看[表情：可爱][表情：可爱]',
    509: '[表情：可爱][表情：可爱]',
    513: '[表情：斜眼笑][表情：斜眼笑]',
  };
  for (const [id, text] of Object.entries(expected)) {
    assert.equal(view.displayText(byId(Number(id)).body, []), text, id);
  }
  assert.equal(face.decodeFaceExt('eyJ0ZXh0Ijoi5rWB5rOqIn0='), '流泪');
  assert.equal(face.decodeFaceExt('%7B%22text%22%3A%22%E6%95%AC%E7%A4%BC%22%7D'), '敬礼');
  assert.equal(face.decodeFaceExt('{"text":"敬礼"}'), '敬礼');
  assert.equal(face.decodeFaceExt('{\\"text\\":\\"敬礼\\"}'), '敬礼');
});

test('E2 legacy and modern fallback tables stay independent; unknown ids are explicit', () => {
  assert.equal(view.displayText('[<face,id=2/>]', []), '[表情：色]');
  assert.equal(view.displayText('<faceType=1,faceId=14>', []), '[表情：微笑]');
  assert.equal(view.displayText('<faceType=1,faceId=2>', []), '[表情（id=2）]');
  assert.equal(view.displayText('<faceType=6,faceId=0>', []), '[超级表情]');
  assert.equal(view.displayText('[<face,id=999/>]', []), '[表情（id=999）]');
});

test('E3 common mface/marketface/dice/rps tags become readable, never raw prose', () => {
  assert.equal(view.displayText('<mface summary="[捂脸]" emoji_id="1"/>', []), '[表情包：捂脸]');
  assert.equal(view.displayText('<marketface face_name="doge"/>', []), '[表情包：doge]');
  assert.equal(view.displayText('<dice/>', []), '[骰子]');
  assert.equal(view.displayText('<rps/>', []), '[猜拳]');
  assert.equal(view.withoutFaces('前<mface summary="x"/>后'), '前后');
  assert.equal(view.evidenceText('前<mface summary="帮我写文件"/>后', []), '前[表情]后');
});

test('E4 super emoji media is marked at parse time and shown as a sticker, not a raw size', () => {
  const row = byId(475);
  const parsed = inbound.parseInbound('GROUP_MESSAGE_CREATE', {
    content: row.body,
    attachments: row.meta.attachments,
    author: { member_openid: row.sender, username: 'member' },
    group_openid: row.group_id,
    timestamp: row.ts,
  });
  assert.equal(parsed.media[0].sticker, true);
  const message = view.viewMessage({ ...row, ts: new Date().toISOString(), sender: 'U1' }, new Map(), new Map(), new Map(), new Set());
  assert.equal(message.text, '[超级表情]');
  assert.deepEqual(message.material.media, ['一张表情包（还没识别）']);
});

test('E5 sticker notes carry a meaning line; media views relabel them as 表情包', async () => {
  const e = env();
  await e.DB.prepare('INSERT INTO image_notes(sha,desc,tags,sticker_like,text,created_at,provider,model) VALUES(?,?,?,?,?,?,?,?)')
    .bind('sha1', '圆形黄色表情，弯弯笑眼', '["无语","嘲讽"]', 1, null, Date.now(), 'deepseek', 'deepseek-flash').run();
  await e.DB.prepare('INSERT INTO message_images(message_id,idx,sha) VALUES(?,?,?)').bind('m1', 0, 'sha1').run();
  const notes = await vision.imageNotesFor(e, ['m1']);
  assert.match(notes.get('m1')[0], /^图片：圆形黄色表情/);
  assert.match(notes.get('m1')[0], /；表达\/梗：无语、嘲讽/);
  const rendered = view.mediaViews({ media: [{ kind: 'image', width: 80, height: 80 }] }, 'm1', notes, new Set());
  assert.equal(rendered[0], '表情包：圆形黄色表情，弯弯笑眼；表达/梗：无语、嘲讽；识图来源：deepseek/deepseek-flash');
});

test('E6 cap exhaustion degrades a sticker to one placeholder, not an error sentence', () => {
  const notes = new Map();
  vision.applyImageOutcomes(notes, [{ messageId: 'm', idx: 0, stage: 'budget', status: 'failed', reason: 'cap', sticker: true }]);
  assert.equal(notes.get('m')[0], '一张表情包（今天先不识别）');
  assert.doesNotMatch(notes.get('m')[0], /预算|失败|错误/);
  const failed = new Map();
  vision.applyImageOutcomes(failed, [{ messageId: 'm', idx: 0, stage: 'fetch', status: 'failed', reason: 'http', http: 403, sticker: true }]);
  assert.match(failed.get('m')[0], /未取得.*HTTP 403/);
});

test('E7 inbound super emoji queues a bounded emoji_note job and caches a meaning note', async () => {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  await qq(e, { ...msg('super-face', byId(475).body), attachments: byId(475).meta.attachments });
  const job = await e.DB.prepare("SELECT id,payload FROM jobs WHERE kind='emoji_note'").first();
  assert.ok(job, 'emoji_note job is queued');
  const payload = JSON.parse(job.payload);
  assert.equal(payload.message, 'super-face');
  assert.equal(payload.media.sticker, true);
  globalThis.fetch = fakeModel('一名戴眼镜的男子站在白底前敬礼', ['敬礼', '报到']);
  try {
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const link = await e.DB.prepare('SELECT sha FROM message_images WHERE message_id=? AND idx=?').bind('super-face', 0).first();
  assert.ok(link?.sha, 'note is linked to the message');
  const note = await e.DB.prepare('SELECT desc,tags,sticker_like FROM image_notes WHERE sha=?').bind(link.sha).first();
  assert.match(note.desc, /敬礼/);
  assert.equal(note.sticker_like, 1);
  assert.deepEqual(JSON.parse(note.tags), ['敬礼', '报到']);
  const message = view.viewMessage({ id: 'super-face', body: byId(475).body, ts: new Date().toISOString(), sender: 'U1', meta: byId(475).meta }, new Map(), new Map(), await vision.imageNotesFor(e, ['super-face']), new Set());
  assert.equal(message.text, '[超级表情]');
  assert.match(message.material.media[0], /^表情包：.*敬礼.*；表达\/梗：敬礼、报到/);
});

test('E8 four real 80x80 sticker images are all read and each keeps its own meaning note', async () => {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  const ids = [497, 498, 499, 500];
  const urlToFile = new Map();
  for (const id of ids) {
    const row = byId(id), filename = row.meta.media[0].filename;
    urlToFile.set(row.meta.media[0].url, stickerFiles[filename]);
    await qq(e, { ...msg('sticker-' + id, ''), attachments: row.meta.attachments });
  }
  const jobs = (await e.DB.prepare("SELECT id,payload FROM jobs WHERE kind='emoji_note' ORDER BY id").all()).results;
  assert.equal(jobs.length, 4);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.deepseek.com')) {
      const text = String(JSON.parse(init.body).messages?.[0]?.content?.[0]?.text || '');
      const desc = text.includes('487') ? 'x' : '圆形黄色表情';
      return Response.json({ choices: [{ message: { content: JSON.stringify({ desc, tags: ['表情'], meme: true }) }, finish_reason: 'stop' }] });
    }
    const file = urlToFile.get(String(url));
    assert.ok(file, 'fixture URL is known');
    return new Response(imageBytes(file), { headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    for (const job of jobs) await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const links = (await e.DB.prepare('SELECT message_id,sha FROM message_images ORDER BY message_id').all()).results;
  assert.equal(links.length, 4);
  const notes = await vision.imageNotesFor(e, links.map((l) => l.message_id));
  for (const link of links) assert.match(notes.get(link.message_id)[0], /^图片：.*；表达\/梗：表情/);
});

test('E9 animated GIF is reduced to its first frame before any provider call', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('../replay/fixtures/emoji/test.gif', import.meta.url)));
  const png = await gif.gifFirstFramePng(bytes);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const frame = gif.decodeGifFirstFrame(bytes);
  assert.deepEqual([frame.width, frame.height], [4, 4]);
  assert.deepEqual([...frame.data.subarray(0, 4)], [252, 0, 0, 255]);
  const e = env();
  let image = '';
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.deepseek.com')) {
      const body = JSON.parse(init.body);
      image = String(body.messages?.[0]?.content?.[1]?.image_url?.url || '');
      return Response.json({ choices: [{ message: { content: '{"desc":"红色方块","tags":["红"],"meme":true}' }, finish_reason: 'stop' }] });
    }
    throw new Error('unexpected fetch');
  };
  try {
    const note = await vision.describeBytes(e, bytes, 'image/gif', '表情图片', new AbortController().signal);
    assert.equal(note.desc, '红色方块');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.match(image, /^data:image\/png;base64,/);
  assert.doesNotMatch(image, /^data:image\/gif/);
});

test('E10 kill switch and the sticker daily cap fail closed without an error sentence', async () => {
  const off = env();
  await req(off, '/api/admin/bind', { groupId: 'GROUP000001' });
  await off.DB.prepare("INSERT INTO settings(key,value) VALUES('off:emoji_read','1')").run();
  await qq(off, { ...msg('off-sticker', ''), attachments: byId(497).meta.attachments });
  assert.equal((await off.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='emoji_note'").first()).n, 0);

  const capped = env();
  await req(capped, '/api/admin/bind', { groupId: 'GROUP000001' });
  await capped.DB.prepare("INSERT INTO settings(key,value) VALUES('stickers:read_cap','0')").run();
  await qq(capped, { ...msg('capped-sticker', ''), attachments: byId(497).meta.attachments });
  const job = await capped.DB.prepare("SELECT id,payload FROM jobs WHERE kind='emoji_note'").first();
  assert.ok(job);
  let providerCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.deepseek.com')) { providerCalls++; throw new Error('cap must stop before the provider'); }
    return new Response(imageBytes('497-F9EB7F627FB6EDE2AACF1FC22E722A85.jpg'), { headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, capped);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(providerCalls, 0);
  assert.equal((await capped.DB.prepare('SELECT COUNT(*) AS n FROM image_notes').first()).n, 0);
  const message = view.viewMessage({ id: 'capped-sticker', body: '', ts: new Date().toISOString(), sender: 'U1', meta: byId(497).meta }, new Map(), new Map(), new Map(), new Set());
  assert.deepEqual(message.material.media, ['一张表情包（还没识别）']);
});

test('E11 cross-batch pick sees the four real 80x80 images when the @ arrives next', () => {
  const images = [497, 498, 499, 500].map((rid) => {
    const row = byId(rid);
    return { id: 'r' + rid, group_id: 'GROUP000001', body: '', mentioned: 0, meta: row.meta };
  });
  const ask = { id: 'r502', group_id: 'GROUP000001', body: '你选一下你想要哪个？', mentioned: 1, meta: {} };
  const picks = vision.pickImages([...images, ask], ask, new Map(), 4);
  assert.deepEqual(picks.map((p) => p.messageId), ['r500', 'r499', 'r498', 'r497']);
  assert.ok(picks.every((p) => p.sticker === true));
});

test('E12 a quoted image with replyTo.kind=unknown is picked from quoted.media', () => {
  const latest = {
    id: 'r518', group_id: 'GROUP000001', mentioned: 1,
    body: '你个蠢货，这是我现在的表情\n你再看看你明明能读图的',
    meta: { quoted: { authorName: 't.o.o.', text: '', media: [{ kind: 'image', url: 'https://multimedia.nt.qq.com.cn/quoted-500', width: 80, height: 80, size: 1531 }] } },
  };
  const picks = vision.pickImages([latest], latest, new Map(), 4);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].messageId, 'r518');
  assert.equal(picks[0].idx, inbound.QUOTED_IMAGE_BASE);
  assert.equal(picks[0].sticker, true);
});

test('E13 a quoted image note is rendered in the quoted material, not lost', () => {
  const notes = new Map([['r518', []]]);
  notes.get('r518')[inbound.QUOTED_IMAGE_BASE] = '图片：圆形黄色表情，弯弯笑眼；表达/梗：调皮、坏笑';
  const v = view.viewMessage({
    id: 'r518', body: '你个蠢货，这是我现在的表情', sender: 'U1', ts: new Date().toISOString(),
    meta: { quoted: { authorName: 't.o.o.', text: '', media: [{ kind: 'image', width: 80, height: 80 }] } },
  }, new Map(), new Map(), notes, new Set());
  assert.match(v.material.quote.media[0], /^引用图片：圆形黄色表情/);
  assert.match(v.material.quote.media[0], /表达\/梗：调皮、坏笑/);
});

test('E14 worker lookback queues one vision turn for four images pushed before the @', async () => {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES('off:emoji_read','1')").run();
  const urlToFile = new Map();
  for (const rid of [497, 498, 499, 500]) {
    const row = byId(rid);
    urlToFile.set(row.meta.media[0].url, stickerFiles[row.meta.media[0].filename]);
    await qq(e, { ...msg('r' + rid, ''), attachments: row.meta.attachments });
  }
  const cursor = (await e.DB.prepare("SELECT rowid FROM messages WHERE id='r500'").first()).rowid;
  await e.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?)").bind('chat_cursor:GROUP000001', String(cursor)).run();
  await qq(e, { ...msg('r502', '你选一下你想要哪个？'), mentions: [{ member_openid: 'bot', is_you: true }] });
  const chat = await e.DB.prepare("SELECT id FROM jobs WHERE kind='chat' AND id='chat-r502'").first();
  assert.ok(chat);
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.deepseek.com')) {
      const body = JSON.parse(init.body);
      assert.ok(String(body.messages?.[0]?.content?.[0]?.text || '').includes('表情包'));
      return Response.json({ choices: [{ message: { content: '{"desc":"圆形黄色表情","tags":["表情"],"meme":true}' }, finish_reason: 'stop' }] });
    }
    const file = urlToFile.get(String(url));
    assert.ok(file, 'real fixture image URL');
    return new Response(imageBytes(file), { headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    await worker.queue({ messages: [{ body: { id: chat.id }, ack() {} }] }, e);
  } finally {
    globalThis.fetch = originalFetch;
  }
  const visionJob = await e.DB.prepare("SELECT payload FROM jobs WHERE kind='chat' AND id LIKE 'chat-v-r502%'").first();
  assert.ok(visionJob, 'vision turn is queued');
  assert.equal(JSON.parse(visionJob.payload).imageOutcomes.length, 4);
});

test('E15 message_meta keeps QQ attachment subType and the sticker flag', async () => {
  const e = env();
  await req(e, '/api/admin/bind', { groupId: 'GROUP000001' });
  await qq(e, {
    ...msg('subtype-sticker', ''),
    attachments: [{ content_type: 'image/jpeg', url: 'https://example.test/subtype.jpg', filename: 'subtype.jpg', width: 80, height: 80, size: 900, sub_type: 1 }],
  });
  const meta = JSON.parse((await e.DB.prepare('SELECT json FROM message_meta WHERE id=?').bind('subtype-sticker').first()).json);
  assert.equal(meta.media[0].subType, 1);
  assert.equal(meta.media[0].sticker, true);
  assert.equal(meta.attachments[0].sub_type, 1);
});
