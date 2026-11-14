#!/usr/bin/env node
/**
 * D-emoji replay: real online messages, isolated local D1, no group sends.
 *
 * Source rows were exported read-only from inkboard-team (see
 * replay/fixtures/emoji-messages.json). Image bytes are local copies of the
 * same attachments (or of the image_cache row for the expired 304/475 URL).
 * The model is a deterministic review stub; it is not a quality claim about
 * DeepSeek. The real 499 note (desc/tags) comes from online image_notes.
 *
 * Run: node replay/emoji-replay.mjs
 * Output: replay/out/emoji-replay.json and .md, plus a short stdout table.
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { env, qq, msg, req, worker } from '../test/support.mjs';

const fixture = JSON.parse(readFileSync('replay/fixtures/emoji-messages.json', 'utf8'));
const rows = new Map(fixture.messages.map((m) => [m.rowid, m]));
const outFile = '.wrangler/emoji-replay-view.mjs';
await build({ entryPoints: ['src/view.ts'], bundle: true, format: 'esm', platform: 'node', outfile: outFile });
const view = await import('../' + outFile);

const fileFor = (filename) => {
  const known = {
    'D2CA5B4308698710F717D194B869CE94.jpg': '304-super.jpg',
    'C91B58130A64D53C8BA6854333321F9C.jpg': '480-C91B58130A64D53C8BA6854333321F9C.jpg',
    'F9EB7F627FB6EDE2AACF1FC22E722A85.jpg': '497-F9EB7F627FB6EDE2AACF1FC22E722A85.jpg',
    '0A4E6B6162FA1C30247745B4276FAF53.jpg': '498-0A4E6B6162FA1C30247745B4276FAF53.jpg',
    '0ABD880646F845A1E56AB7519C27A76A.jpg': '499-0ABD880646F845A1E56AB7519C27A76A.jpg',
    '1FB8C0BC70313BE2725DB7FC1CAD75D3.jpg': '500-1FB8C0BC70313BE2725DB7FC1CAD75D3.jpg',
  };
  return known[filename] || '';
};
const bytes = (filename) => new Uint8Array(readFileSync('replay/fixtures/emoji/' + filename));
const fileHash = new Map();
for (const row of fixture.messages) {
  const media = [...(row.meta?.media || []), ...(row.meta?.quoted?.media || [])];
  for (const m of media) {
    const file = fileFor(m.filename);
    if (file) fileHash.set(createHash('sha256').update(bytes(file)).digest('hex'), file);
  }
}
const descriptions = {
  '304-super.jpg': { desc: '一名戴眼镜的短发男子站在白色背景前，右手举至头侧敬礼，身穿印有图案和文字的白色短袖T恤、浅色短裤和黑色运动鞋。', tags: ['敬礼', '报到'] },
  '480-C91B58130A64D53C8BA6854333321F9C.jpg': { desc: '显示器上的 DeepSeek 用量看板：余额 ¥77.66，累计消费 ¥432.84，近30天 ¥400.07、请求 42,911 次、Tokens 76.39 亿。', tags: ['用量', '余额'], meme: false },
  '497-F9EB7F627FB6EDE2AACF1FC22E722A85.jpg': { desc: '圆形黄色表情，皱眉瞪眼，嘴部戴着蓝色口罩。', tags: ['生气', '无语'] },
  '498-0A4E6B6162FA1C30247745B4276FAF53.jpg': { desc: '圆形黄色表情，眯眼大笑，张大嘴。', tags: ['大笑', '开心'] },
  '499-0ABD880646F845A1E56AB7519C27A76A.jpg': { desc: '圆形黄色表情，弯弯笑眼，粉色脸颊，嘴角伸出红色舌头。', tags: ['调皮', '坏笑'] },
  '500-1FB8C0BC70313BE2725DB7FC1CAD75D3.jpg': { desc: '圆形黄色表情，半睁眼，额头一滴汗。', tags: ['无语', '流汗'] },
};

const visionOut = '.wrangler/emoji-replay-vision.mjs';
await build({ entryPoints: ['src/vision.ts'], bundle: true, format: 'esm', platform: 'node', outfile: visionOut });
const vision = await import('../' + visionOut);
const contextOut = '.wrangler/emoji-replay-context.mjs';
await build({ entryPoints: ['src/context.ts'], bundle: true, format: 'esm', platform: 'node', outfile: contextOut });
const context = await import('../' + contextOut);
const e = env();
const groupId = fixture.messages[0].group_id;
await req(e, '/api/admin/bind', { groupId });
const urlToFile = new Map();
for (const row of fixture.messages) {
  const media = [...(row.meta?.media || []), ...(row.meta?.quoted?.media || [])];
  for (const m of media) if (m.kind === 'image' && m.url) urlToFile.set(m.url, fileFor(m.filename));
}
let cloudflareCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const text = String(url);
  if (text.includes('api.cloudflare.com')) { cloudflareCalls++; throw new Error('online D1/API call blocked in replay'); }
  if (text.includes('api.deepseek.com')) {
    const body = JSON.parse(init.body);
    const content = body.messages?.[0]?.content;
    const parts = Array.isArray(content) ? content : [];
    const image = parts.find((part) => part?.type === 'image_url')?.image_url?.url;
    if (!image) return Response.json({ choices: [{ message: { content: '已按回放数据回答。' }, finish_reason: 'stop' }] });
    const prompt = String(parts.find((part) => part?.type === 'text')?.text || '');
    if (!/表情包|只描述图片/.test(prompt)) throw new Error('vision prompt missing');
    const hash = createHash('sha256').update(Buffer.from(String(image).split(',')[1], 'base64')).digest('hex');
    const file = fileHash.get(hash);
    const d = descriptions[file] || { desc: '一张群聊图片', tags: [] };
    return Response.json({ choices: [{ message: { content: JSON.stringify({ ...d, meme: d.meme ?? true }) }, finish_reason: 'stop' }] });
  }
  const file = urlToFile.get(text);
  if (!file) throw new Error('unexpected image URL');
  return new Response(bytes(file), { headers: { 'content-type': 'image/jpeg' } });
};

const ask502 = { ...rows.get(502), id: 'r502', meta: rows.get(502).meta };
let crossBatchPicks = [];
try {
  for (const row of fixture.messages) {
    await qq(e, {
      ...msg('r' + row.rowid, row.body),
      group_openid: groupId,
      timestamp: row.ts,
      author: { id: row.sender, member_openid: row.sender, username: '群友', member_role: 'member', bot: false },
      attachments: row.meta?.attachments || [],
    });
  }
  const jobs = (await e.DB.prepare("SELECT id,kind,payload,status FROM jobs WHERE kind='emoji_note' ORDER BY id").all()).results
    .filter((job) => !/^emoji-note-r(?:497|498|499|500)-/.test(job.id));
  for (const job of jobs) await worker.queue({ messages: [{ body: { id: job.id }, ack() {} }] }, e);
  const quotedRow = rows.get(518);
  const quotedLatest = { ...quotedRow, id: 'r518', meta: quotedRow.meta };
  const quotedPicks = vision.pickImages([quotedLatest], quotedLatest, new Map(), 4);
  if (quotedPicks.length) await vision.annotateTurn(e, quotedPicks, 20000);
  // Ordinary (non-sticker) image: 480 was a 1920x1080 screenshot. The ask is
  // replay-only (the real message had no text); the image and its metadata are
  // the real ones, so the comparison exercises the same pick/vision path.
  const normalRow = { ...rows.get(480), id: 'r480', meta: rows.get(480).meta };
  const normalAsk = { id: 'r480ask', group_id: groupId, body: '这张截图里余额和 token 是多少？', mentioned: 1, meta: {} };
  const normalPicks = vision.pickImages([normalRow, normalAsk], normalAsk, new Map(), 4);
  if (normalPicks.length) await vision.annotateTurn(e, normalPicks, 20000);
  // Same lookback the worker does for 502: current batch has no image, so load
  // the last 24 messages up to 502 and feed them to pickImages.
  const ask502Ordinal = (await e.DB.prepare("SELECT rowid AS ordinal FROM messages WHERE id='r502'").first()).ordinal;
  const recent = (await context.loadRecent(e, groupId, 24)).filter((row) => row.ordinal <= ask502Ordinal);
  crossBatchPicks = vision.pickImages([...recent.filter((row) => row.id !== 'r502'), ask502], ask502, new Map(), 4);
  if (crossBatchPicks.length) await vision.annotateTurn(e, crossBatchPicks, 20000);
} finally {
  globalThis.fetch = originalFetch;
}

const ids = [...fixture.messages.map((m) => 'r' + m.rowid), 'r480'];
const notes = await vision.imageNotesFor(e, ids);

const render = (row) => {
  const id = 'r' + row.rowid;
  const v = view.viewMessage({ ...row, id, sender: 'U1', ts: row.ts, meta: row.meta }, new Map(), new Map(), notes, new Set());
  return { text: v.text, media: v.material?.media || [], quoteMedia: v.material?.quote?.media || [] };
};
const cases = [];
const faceRows = [503, 509, 513];
const superRows = [304, 475];
const stickerRows = [497, 498, 499, 500];
const faceBefore = {
  503: '来看看[表情（名称未知）][表情（名称未知）]',
  509: '[表情（名称未知）][表情（名称未知）]',
  513: '[表情（名称未知）][表情（名称未知）]',
};
for (const id of faceRows) {
  const row = rows.get(id);
  cases.push({ category: '系统小黄脸', rid: id, before: faceBefore[id], after: { text: view.displayText(row.body, []), media: [] } });
}
for (const id of superRows) {
  const row = rows.get(id);
  cases.push({ category: '超级表情/大表情', rid: id, before: { text: '[表情（名称未知）]', media: ['图片 519×1271'] }, after: render(row) });
}
for (const id of stickerRows) {
  const row = rows.get(id);
  cases.push({
    category: '表情包图片',
    rid: id,
    before: id === 499
      ? { text: '[图片]', media: ['图片：圆形黄色表情，弯弯笑眼，粉色脸颊，嘴角伸出红色舌头；识图来源：deepseek/deepseek-flash'] }
      : { text: '[图片]', media: ['图片 80×80'] },
    after: render(row),
  });
}
const quotedRow = rows.get(518);
cases.push({
  category: '引用图片（kind=unknown）',
  rid: 518,
  before: { text: quotedRow.body, media: ['只有下载链接，没有识图结果'] },
  after: render(quotedRow),
});
cases.push({
  category: '普通图片（非表情）',
  rid: 480,
  before: { text: '[图片]', media: ['图片 1920×1080'] },
  after: render(rows.get(480)),
});
const crossBatchNotes = [497, 498, 499, 500].filter((id) => (notes.get('r' + id) || []).some(Boolean));

const outbox = (await e.DB.prepare('SELECT COUNT(*) AS n FROM outbox').first()).n;
const zero = { onlineD1Writes: 0, qqSends: outbox, cloudflareCalls };
if (outbox !== 0 || cloudflareCalls !== 0) throw new Error('replay wrote or sent: ' + JSON.stringify(zero));

const result = {
  source: fixture.source,
  zero,
  emojiJobs: (await e.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind='emoji_note' AND status='done'").first()).n,
  notes: (await e.DB.prepare('SELECT COUNT(*) AS n FROM image_notes').first()).n,
  links: (await e.DB.prepare('SELECT COUNT(*) AS n FROM message_images').first()).n,
  crossBatchPicks: crossBatchPicks.map((p) => p.messageId),
  crossBatchNotes,
  normalNote: notes.get('r480') || [],
  quotedPick: { messageId: quotedRow.id, idx: vision.pickImages([{ ...quotedRow, id: 'r518', meta: quotedRow.meta }], { ...quotedRow, id: 'r518', meta: quotedRow.meta }, new Map(), 4)[0]?.idx },
  cases,
  realBotRepliesBefore: fixture.bot_replies,
};
mkdirSync('replay/out', { recursive: true });
writeFileSync('replay/out/emoji-replay.json', JSON.stringify(result, null, 2) + '\n');

const line = (s) => String(s).replaceAll('\n', ' ');
const md = [
  '# D-emoji 回放：真实消息前后对比',
  '',
  `来源：${fixture.source}。本地独立库，模型为确定性审查桩（304/475 使用同一张图的线上识图描述；499 的 desc 来自线上 image_notes；480 的 desc 由回放按真实截图人工核对后固定，不是新的 provider 调用）。`,
  '',
  '| 类别 | rid | 回放前 bot 看到 | 回放后 bot 看到 |',
  '|---|---|---|---|',
  ...cases.map((c) => `| ${c.category} | ${c.rid} | ${line(JSON.stringify(c.before))} | ${line(JSON.stringify(c.after))} |`),
  `| 跨批次补图 | 502 | — | 回看最近 24 条，取到 ${crossBatchPicks.length} 张：${crossBatchPicks.map((p) => p.messageId).join('、')}；其中已识图 ${crossBatchNotes.length} 张（${crossBatchNotes.map((id) => 'r' + id).join('、')}） |`,
  '',
  `统计：emoji_note 完成 ${result.emojiJobs} 个；image_notes ${result.notes} 条；message_images ${result.links} 条。`,
  `零写入/零发送：线上 D1 写入 0 行、QQ 真实发送 ${outbox} 次、Cloudflare API 调用 ${cloudflareCalls} 次。`,
  '',
  '回放前的真实 bot 回复（线上）：',
  ...fixture.bot_replies.map((r) => `- outbox.rid=${r.rowid}: ${line(r.body)}`),
].join('\n') + '\n';
writeFileSync('replay/out/emoji-replay.md', md);
console.log(md);
