import test from 'node:test';
import assert from 'node:assert/strict';
import {
  X_OPERATIONS, normalizeHandle, parseStatusId, buildTweetDetailRequest, buildUserTweetsRequest,
  buildSearchTimelineRequest, parseTweetDetail, parseUserTweets, parseSearchTimeline, parseUserProfile,
  classifyGraphqlStatus, classifyXPage, formatTweetText, fitItems,
} from '../runner/x-graphql.mjs';
import {readX, xEnvelope} from '../runner/x-reader.mjs';
import {REACH_COMMANDS} from '../runner/reach-adapter.mjs';

const person=(handle,name='')=>({__typename:'User',core:{screen_name:handle,name},legacy:{screen_name:handle,name}});
const tw=(id,handle,text,extra={})=>({
  __typename:'Tweet',rest_id:id,core:{user_results:{result:person(handle,extra.name||'')}},
  legacy:{full_text:text,created_at:'Wed Nov 12 10:00:00 +0000 2025',favorite_count:1,retweet_count:0,...extra.legacy},
  ...extra.top,
});
const entry=(id,result)=>({entryId:'tweet-'+id,content:{entryType:'TimelineTimelineItem',itemContent:{tweet_results:{result}}}});
const bottom=value=>({entryId:'cursor-bottom-'+value,content:{entryType:'TimelineTimelineCursor',cursorType:'Bottom',value}});
const detail=entries=>({data:{threaded_conversation_with_injections_v2:{instructions:[{type:'TimelineAddEntries',entries}]}}});
const userTweets=entries=>({data:{user:{result:{__typename:'User',rest_id:'42',timeline_v2:{timeline:{instructions:[{type:'TimelineAddEntries',entries}]}}}}}});
const searchPage=entries=>({data:{search_by_raw_query:{search_timeline:{timeline:{instructions:[{type:'TimelineAddEntries',entries}]}}}}});
const evidence=(node)=>{
  const seen=new Set();
  return node.content?.itemContent?.tweet_results?.result ? parseTweetDetail(node,seen) : null;
};

test('long note_tweet is returned in full instead of the truncated legacy text',()=>{
  const long='这是一条长推文的完整正文。'.repeat(120);
  const result=tw('111','alice','短文本…',{top:{note_tweet:{note_tweet_results:{result:{text:long}}}}});
  assert.equal(X_OPERATIONS.TweetDetail.queryId.length>10,true);
  const parsed=parseTweetDetail(detail([entry('111',result)]),new Set());
  assert.equal(parsed.tweets.length,1);
  assert.equal(parsed.tweets[0].text,long);
  assert.ok(!parsed.tweets[0].text.includes('…'));
});

test('thread fixture keeps quoted tweet, media and the reply order',()=>{
  const quoted=tw('999','bob','被引用的原文内容');
  const original=tw('111','alice','主推文',{top:{quoted_status_result:{result:quoted}},legacy:{extended_entities:{media:[{type:'photo',media_url_https:'https://pbs.twimg.com/media/a.jpg'},{type:'photo',media_url_https:'https://pbs.twimg.com/media/b.jpg'}]}}});
  const reply=tw('222','carol','第一条回复',{legacy:{in_reply_to_status_id_str:'111'}});
  const parsed=parseTweetDetail(detail([entry('111',original),entry('222',reply)]),new Set());
  assert.deepEqual(parsed.tweets.map(t=>t.id),['111','222']);
  assert.equal(parsed.tweets[0].quoted.author,'bob');
  assert.equal(parsed.tweets[0].quoted.text,'被引用的原文内容');
  assert.equal(parsed.tweets[0].media.length,2);
  const text=formatTweetText(parsed.tweets[0]);
  assert.match(text,/主推文/);
  assert.match(text,/引用 @bob：被引用的原文内容/);
  assert.match(text,/\[媒体 2 项：图片\]/);
  assert.match(formatTweetText(parsed.tweets[1]),/第一条回复/);
});

test('thread pagination follows the bottom cursor and dedupes repeated entries',()=>{
  const one=tw('1','a','第一条'),two=tw('2','a','第二条'),three=tw('3','b','第三条');
  const first=parseTweetDetail(detail([entry('1',one),entry('2',two),bottom('CURSOR-2')]),new Set());
  assert.equal(first.nextCursor,'CURSOR-2');
  const seen=new Set(first.tweets.map(t=>t.id));
  const second=parseTweetDetail(detail([entry('2',two),entry('3',three),bottom('CURSOR-3')]),seen);
  assert.deepEqual(second.tweets.map(t=>t.id),['3']);
  assert.equal(second.nextCursor,'CURSOR-3');
  assert.match(buildTweetDetailRequest('1','CURSOR-2').url,/TweetDetail\?variables=.*cursor/);
});

test('user timeline skips pinned entries, keeps retweets and media-only posts',()=>{
  const pinned={type:'TimelinePinEntry',entry:entry('9',tw('9','a','置顶旧推'))};
  const rt=tw('10','a','RT @bob: 原始内容',{legacy:{retweeted_status_result:{result:tw('77','bob','原始内容')}}});
  const mediaOnly=tw('11','a','',{legacy:{extended_entities:{media:[{type:'video',media_url_https:'https://pbs.twimg.com/x.jpg',video_info:{variants:[{content_type:'video/mp4',url:'https://video.twimg.com/x.mp4'}]}}]}}});
  const parsed=parseUserTweets(userTweets([pinned,entry('10',rt),entry('11',mediaOnly),bottom('C1')]),new Set());
  assert.deepEqual(parsed.tweets.map(t=>t.id),['10','11']);
  assert.match(formatTweetText(parsed.tweets[0]),/转推 @bob：原始内容/);
  assert.equal(formatTweetText(parsed.tweets[1]),'[媒体 1 项：视频]');
  assert.equal(parsed.nextCursor,'C1');
  assert.match(buildUserTweetsRequest('42',20,null).url,/UserTweets\?variables=/);
});

test('search unwraps TweetWithVisibilityResults and keeps author and time',()=>{
  const result={__typename:'TweetWithVisibilityResults',tweet:tw('5','dave','搜索结果正文')};
  const parsed=parseSearchTimeline(searchPage([entry('5',result),bottom('C5')]),new Set());
  assert.equal(parsed.tweets.length,1);
  assert.equal(parsed.tweets[0].author,'dave');
  assert.equal(parsed.tweets[0].created_at,'2025-11-12T10:00:00.000Z');
  assert.equal(parsed.nextCursor,'C5');
  const req=buildSearchTimelineRequest('AI 新闻',10,null);
  assert.equal(req.method,'POST');
  assert.match(req.url,/SearchTimeline$/);
  assert.match(req.body,/AI 新闻/);
});

test('profile fixture keeps bio, counts and a stable source url',()=>{
  const payload={data:{user:{result:{__typename:'User',rest_id:'42',is_blue_verified:true,legacy:{screen_name:'elonmusk',name:'Elon Musk',description:'技术、火星与汽车',followers_count:200000000,friends_count:500,statuses_count:40000,protected:false}}}}};
  const p=parseUserProfile(payload);
  assert.equal(p.handle,'elonmusk');
  assert.equal(p.name,'Elon Musk');
  assert.equal(p.bio,'技术、火星与汽车');
  assert.equal(p.followers,200000000);
  assert.equal(parseUserProfile({data:{user:{result:{__typename:'UserUnavailable'}}}}),null);
});

test('unlogged page and platform challenge are separated, not guessed from an empty page',()=>{
  assert.equal(classifyXPage({path:'/i/flow/login',login:true,challenge:false,http:200}),'NEED_LOGIN');
  assert.equal(classifyXPage({path:'/home',login:false,challenge:true,http:200}),'PLATFORM_BLOCKED');
  assert.equal(classifyXPage({path:'/home',login:false,challenge:false,http:403}),'PLATFORM_BLOCKED');
  assert.equal(classifyXPage({path:'/home',login:false,challenge:false,http:429}),'RATE_LIMITED');
  assert.equal(classifyXPage({path:'/home',login:false,challenge:false,http:200}),null);
  assert.equal(classifyXPage({path:'/home',login:false,challenge:false,http:503}),'UPSTREAM_BROKEN');
});

test('graphql status and error shells map to distinct reach reasons',()=>{
  assert.equal(classifyGraphqlStatus(401,{}),'NEED_LOGIN');
  assert.equal(classifyGraphqlStatus(403,{errors:[{message:'This request requires a matching csrf cookie'}]}),'NEED_LOGIN');
  assert.equal(classifyGraphqlStatus(403,{errors:[{message:'Forbidden'}]}),'PLATFORM_BLOCKED');
  assert.equal(classifyGraphqlStatus(429,{}),'RATE_LIMITED');
  assert.equal(classifyGraphqlStatus(404,{}),'NOT_FOUND');
  assert.equal(classifyGraphqlStatus(500,{}),'UPSTREAM_BROKEN');
  assert.equal(classifyGraphqlStatus(200,{errors:[{code:88,message:'Rate limit exceeded'}]}),'RATE_LIMITED');
  assert.equal(classifyGraphqlStatus(200,{errors:[{message:'User has been suspended'}]}),'NOT_FOUND');
  assert.equal(classifyGraphqlStatus(200,{data:{tweetResult:{result:{__typename:'TweetTombstone'}}}}),'NOT_FOUND');
  assert.equal(classifyGraphqlStatus(200,{data:{user:{result:{__typename:'UserUnavailable'}}}}),'NOT_FOUND');
  assert.equal(classifyGraphqlStatus(200,{}),null);
});

test('handles and status targets accept the real group link shapes and reject reserved paths',()=>{
  assert.equal(normalizeHandle('@elonmusk'),'elonmusk');
  assert.equal(normalizeHandle('https://x.com/elonmusk'),'elonmusk');
  assert.equal(normalizeHandle('home'),'');
  assert.equal(normalizeHandle('a-b'),'');
  assert.equal(parseStatusId('https://x.com/CBSNews/status/2054921950263116053'),'2054921950263116053');
  assert.equal(parseStatusId('https://x.com/i/web/status/2103288108360069344'),'2103288108360069344');
  assert.equal(parseStatusId('https://x.com/elonmusk'),'');
});

const fakePage=(probe,responses)=>{let n=0;return {evaluate:async(_fn,arg)=>{
  if(arg===undefined)return probe;
  const next=responses[n++];if(!next)throw Error('unexpected fetch');
  return next;
}};};

test('reader returns the normalized envelope with loaded count and no cookie material',async()=>{
  const long='长文'.repeat(6500);
  const page=fakePage({path:'/home',login:false,challenge:false,account:true,http:200},[{status:200,body:JSON.stringify(detail([entry('1',tw('1','alice',long+' auth_token=SECRET ct0=SECRET'))]))}]);
  const req={channel:'x',action:'thread',target:'https://x.com/alice/status/1'};
  const raw=await readX(page,{...req,limit:20,deadline:Date.now()+5000});
  const envelope=xEnvelope(req,raw);
  assert.equal(envelope.ok,true);
  assert.equal(envelope.meta.loaded,1);
  assert.ok(envelope.items[0].text.length>12900);
  assert.equal(envelope.items[0].author,'alice');
  assert.doesNotMatch(JSON.stringify(envelope),/SECRET|ct0|auth_token|cookie/i);
});

test('reader stops before any platform request when logged out or challenged',async()=>{
  for(const [probe,kind] of [[{path:'/i/flow/login',login:true,challenge:false,http:200},'login_required'],[{path:'/home',login:false,challenge:true,http:200},'platform_blocked']]){
    const raw=await readX(fakePage(probe,[]),{channel:'x',action:'search',target:'AI',limit:10,deadline:Date.now()+5000});
    assert.equal(xEnvelope({channel:'x',action:'search',target:'AI'},raw).error.error_kind,kind);
  }
});

test('reader maps deleted tweets to not_found instead of an empty success',async()=>{
  const page=fakePage({path:'/home',login:false,challenge:false,account:true,http:200},[{status:200,body:JSON.stringify({data:{tweetResult:{result:{__typename:'TweetTombstone'}}}})}]);
  const raw=await readX(page,{channel:'x',action:'thread',target:'https://x.com/a/status/1',limit:20,deadline:Date.now()+5000});
  assert.equal(xEnvelope({channel:'x',action:'thread',target:'https://x.com/a/status/1'},raw).error.error_kind,'not_found');
});

test('fitItems drops whole items instead of cutting a long tweet in half',()=>{
  const items=[{text:'甲'.repeat(3000)},{text:'乙'.repeat(3000)}];
  const kept=fitItems(items,7000);
  assert.equal(kept.length,1);
  assert.equal(kept[0].text.length,3000);
});

test('adapter exposes only fixed read-only X commands with the skeleton scope contract',()=>{
 const expected={thread:'post_text',profile:'post_text',tweets:'post_text',search:'search_results'};
 for(const [action,scope] of Object.entries(expected)){
  const entry=REACH_COMMANDS[`x:${action}:local`];
  assert.ok(entry,action);
  assert.equal(entry.access,'read');assert.equal(entry.resource,'browser');
  assert.equal(entry.requires_login,true);assert.equal(entry.content_scope,scope);
  const argv=entry.argv('https://x.com/a/status/1');
  assert.equal(argv.length,4);assert.ok(argv[0].startsWith('/'));
  assert.match(argv[1],/x-reader\.mjs$/);assert.equal(argv[2],action);assert.equal(argv[3],'https://x.com/a/status/1');
 }
 assert.equal(REACH_COMMANDS['x:post:local'],undefined);
 assert.equal(REACH_COMMANDS['x:thread:public-web'],undefined);
});
