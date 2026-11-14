import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeReachResult} from '../runner/reach-result.mjs';
import {REACH_COMMANDS} from '../runner/reach-adapter.mjs';
import {scopeFor, validTarget} from '../src/reach-contract.mjs';
import {
  parseWeiboHot, parseWeiboSearch, parseWeiboProfile,
  parseZhihuHot, parseZhihuSearch, parseZhihuQuestion, parseZhihuAnswer,
  parseDouyinDetail, parseDouyinPage, parseWechatArticle,
  resolveShortLink, runPublicRead,
} from '../runner/reach-public.mjs';

const fixture = name => readFile(new URL('./fixtures/reach/' + name, import.meta.url), 'utf8');
const reply = body => new Response(body, {status: 200, headers: {'content-type': 'text/html; charset=utf-8'}});
const json = body => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
const reach = (channel, action, target, raw) => normalizeReachResult({channel, action, target, backend: 'local'}, raw);

test('weibo hot: ten entries, bounded, and no tracking or media fields', async () => {
  const items = parseWeiboHot(JSON.parse(await fixture('weibo-hot.json')), 10);
  assert.equal(items.length, 10);
  assert.ok(items.every(i => i.title && i.text && /^https:\/\/s\.weibo\.com\//.test(i.source_url)));
  assert.ok(items[0].text.includes('热度'));
  const result = reach('weibo', 'hot', '热搜', {ok: true, items});
  assert.equal(result.ok, true);
  assert.equal(result.content_scope, 'search_results');
  assert.equal(result.items.length, 10);
  assert.doesNotMatch(JSON.stringify(result), /simg\.s\.weibo\.com|douyinpic|https?:\/\/[^"]*\.(?:png|jpg|mp4)/i);
});

test('weibo search: real card fixture parses; visitor page is login_required', async () => {
  const items = parseWeiboSearch(await fixture('weibo-search.html'), 10);
  assert.equal(items.length, 2);
  assert.equal(items[0].author, '示例作者甲');
  assert.ok(items[0].text.includes('重复工作'));
  const wall = await runPublicRead({channel: 'weibo', action: 'search', target: '人工智能'}, {fetchImpl: async () => reply(await fixture('weibo-login.html'))});
  assert.equal(wall.ok, false);
  assert.equal(wall.error.code, 'NEED_LOGIN');
  assert.equal(reach('weibo', 'search', '人工智能', wall).error.error_kind, 'login_required');
});

test('weibo profile: redirect to passport is login_required; profile JSON is bounded', async () => {
  const wall = await runPublicRead({channel: 'weibo', action: 'profile', target: '1001'}, {fetchImpl: async () => new Response(null, {status: 302, headers: {location: 'https://passport.weibo.com/visitor/visitor?a=enter'}})});
  assert.equal(wall.error.code, 'NEED_LOGIN');
  const items = parseWeiboProfile(JSON.parse(await fixture('weibo-profile.json')));
  assert.equal(items.length, 1);
  assert.ok(items[0].text.includes('12345'));
  assert.equal(items[0].author, '示例用户');
});

test('zhihu hot/search: fixture shapes parse and 401/captcha map to login_required/platform_blocked', async () => {
  const hot = parseZhihuHot(JSON.parse(await fixture('zhihu-hot.json')), 10);
  assert.equal(hot.length, 10);
  assert.match(hot[0].source_url, /^https:\/\/www\.zhihu\.com\/question\/101$/);
  assert.equal(reach('zhihu', 'hot', '热榜', {ok: true, items: hot}).content_scope, 'search_results');
  const search = parseZhihuSearch(JSON.parse(await fixture('zhihu-search.json')), 10);
  assert.equal(search.length, 3);
  assert.match(search[0].source_url, /^https:\/\/www\.zhihu\.com\/answer\/201$/);
  const login = await runPublicRead({channel: 'zhihu', action: 'hot', target: '热榜'}, {fetchImpl: async () => new Response(await fixture('zhihu-login.json'), {status: 401, headers: {'content-type': 'application/json'}})});
  assert.equal(login.error.code, 'NEED_LOGIN');
  const blocked = await runPublicRead({channel: 'zhihu', action: 'hot', target: '热榜'}, {fetchImpl: async () => reply(await fixture('zhihu-blocked.html'))});
  assert.equal(blocked.error.code, 'SECURITY_BLOCK');
});

test('zhihu read: answer body and question detail stay post_text and route to the right API', async () => {
  const answer = parseZhihuAnswer(JSON.parse(await fixture('zhihu-answer.json')));
  assert.match(answer.text, /输入过滤/);
  assert.equal(answer.author, '示例答主');
  assert.ok(answer.text.includes('321'));
  const result = reach('zhihu', 'read', 'https://www.zhihu.com/question/301/answer/401', {ok: true, items: [answer]});
  assert.equal(result.content_scope, 'post_text');
  const seen = [];
  const ok = await runPublicRead({channel: 'zhihu', action: 'read', target: 'https://www.zhihu.com/question/301/answer/401'}, {fetchImpl: async url => {seen.push(url); return json(JSON.parse(await fixture('zhihu-answer.json')));}});
  assert.equal(ok.ok, true);
  assert.match(seen[0], /\/api\/v4\/answers\/401/);
  const q = await runPublicRead({channel: 'zhihu', action: 'read', target: 'https://www.zhihu.com/question/301'}, {fetchImpl: async url => {seen.push(url); return json(JSON.parse(await fixture('zhihu-question.json')));}});
  assert.equal(q.ok, true);
  assert.match(seen[1], /\/api\/v4\/questions\/301/);
  assert.ok(parseZhihuQuestion(JSON.parse(await fixture('zhihu-question.json'))).text.includes('内存和功耗'));
});

test('douyin short links: six redirects allowed, seventh and foreign hosts rejected', async () => {
  const chain = n => {
    let hops = 0;
    return async () => {
      hops++;
      return hops <= n
        ? new Response(null, {status: 302, headers: {location: hops === n ? 'https://www.iesdouyin.com/share/video/123/' : `https://v.douyin.com/hop/${hops}`}})
        : new Response('<html></html>', {status: 200, headers: {'content-type': 'text/html'}});
    };
  };
  assert.equal(await resolveShortLink('https://v.douyin.com/hop/0', {fetchImpl: chain(6)}), 'https://www.iesdouyin.com/share/video/123/');
  await assert.rejects(resolveShortLink('https://v.douyin.com/hop/0', {fetchImpl: chain(7)}), e => e.code === 'BAD_INPUT' && e.stage === 'redirect_limit');
  await assert.rejects(resolveShortLink('https://v.douyin.com/hop/0', {fetchImpl: async () => new Response(null, {status: 302, headers: {location: 'https://evil.example/x'}})}), e => e.code === 'BAD_INPUT');
  assert.equal(validTarget('douyin', 'read', 'https://v.douyin.com/abc/'), true);
  assert.equal(validTarget('douyin', 'read', 'https://www.iesdouyin.com/share/video/123/'), true);
});

test('douyin detail: copy/author/interactions/duration parse without media URLs; page JSON also parses', async () => {
  const raw = JSON.parse(await fixture('douyin-detail.json'));
  const item = parseDouyinDetail(raw);
  assert.ok(item);
  assert.equal(item.author, '示例创作者');
  assert.ok(item.text.includes('流水线'));
  assert.ok(item.text.includes('12345'));
  assert.ok(item.text.includes('12.3 秒'));
  const page = parseDouyinPage(await fixture('douyin-page.html'));
  assert.ok(page);
  assert.equal(page.author, '示例创作者');
  const result = reach('douyin', 'read', 'https://www.douyin.com/video/7298145681699622182', {ok: true, items: [item]});
  assert.equal(result.content_scope, 'post_text');
  assert.doesNotMatch(JSON.stringify(result), /play_addr|douyinvod|\.mp4|secret\.mp4/i);
});

test('douyin deleted and security block map to not_found and platform_blocked', async () => {
  const gone = await runPublicRead({channel: 'douyin', action: 'read', target: 'https://www.douyin.com/video/123'}, {fetchImpl: async () => reply(await fixture('douyin-deleted.html'))});
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'NOT_FOUND');
  assert.equal(reach('douyin', 'read', 'https://www.douyin.com/video/123', gone).error.error_kind, 'not_found');
  const blocked = await runPublicRead({channel: 'douyin', action: 'read', target: 'https://www.douyin.com/video/123'}, {fetchImpl: async () => new Response(await fixture('douyin-blocked.txt'), {status: 403})});
  assert.equal(blocked.error.code, 'SECURITY_BLOCK');
  assert.equal(reach('douyin', 'read', 'https://www.douyin.com/video/123', blocked).error.error_kind, 'platform_blocked');
});

test('registered commands are read-only and API-bound', () => {
  const expected = ['weibo:hot', 'weibo:search', 'weibo:profile', 'zhihu:hot', 'zhihu:search', 'zhihu:read', 'douyin:read'];
  for (const key of expected) {
    const entry = REACH_COMMANDS[key + ':local'];
    assert.ok(entry, key);
    assert.equal(entry.access, 'read');
    assert.equal(entry.resource, 'api');
    assert.equal(entry.content_scope, scopeFor(key.split(':')[1]));
    const argv = entry.argv('AI');
    assert.ok(Array.isArray(argv) && argv.every(x => typeof x === 'string'));
    assert.match(argv[0], /^\//);
  }
  assert.ok(!Object.keys(REACH_COMMANDS).some(k => /:(?:post|write|delete|publish|setup):/.test(k)));
});
