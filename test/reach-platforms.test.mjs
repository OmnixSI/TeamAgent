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

test('registered commands are read-only and API-bound', () => {
  const expected = ['weibo:hot', 'weibo:search', 'weibo:profile'];
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
