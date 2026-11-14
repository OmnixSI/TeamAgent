/**
 * X (Twitter) read-only GraphQL request builders and extractors.
 *
 * 来源：OpenCLI — https://github.com/jackwener/opencli
 *   clis/twitter/thread.js, tweets.js, search.js, profile.js, shared.js, utils.js
 *   版本 1.7.22（本机固定安装），Apache-2.0；见仓库根 NOTICE。
 * 改动：改写成本仓库的纯函数（不启动浏览器、不写 Cookie）；查询 ID / feature
 *   开关集中在本文件的 X_OPERATIONS 常量表，平台漂移时只改这一处并用测试夹具
 *   固定。新增长推 note_tweet 全文、引用推文、媒体标记、分页与错误分类。
 * Cookie / auth_token 不经过本文件：csrf 只在页面内读取并用于同页 fetch。
 */

/** Public X web bearer, same constant OpenCLI ships; it is not an account credential. */
export const X_BEARER_TOKEN='AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

const TWEET_DETAIL_FEATURES={
 responsive_web_graphql_exclude_directive_enabled:true,verified_phone_label_enabled:false,
 creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_timeline_navigation_enabled:true,
 responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,longform_notetweets_consumption_enabled:true,
 longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:true,
 freedom_of_speech_not_reach_fetch_enabled:true,
};
const TWEET_DETAIL_TOGGLES={withArticleRichContentState:true,withArticlePlainText:false};

const USER_TWEETS_FEATURES={
 rweb_video_screen_enabled:true,rweb_cashtags_enabled:true,payments_enabled:false,
 profile_label_improvements_pcf_label_in_post_enabled:true,responsive_web_profile_redirect_enabled:true,
 rweb_tipjar_consumption_enabled:true,verified_phone_label_enabled:false,
 creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_timeline_navigation_enabled:true,
 responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,premium_content_api_read_enabled:false,
 communities_web_enable_tweet_community_results_fetch:true,c9s_tweet_anatomy_moderator_badge_enabled:true,
 responsive_web_grok_analyze_button_fetch_trends_enabled:false,responsive_web_grok_analyze_post_followups_enabled:true,
 rweb_cashtags_composer_attachment_enabled:true,responsive_web_jetfuel_frame:true,
 responsive_web_grok_share_attachment_enabled:true,responsive_web_grok_annotations_enabled:true,
 articles_preview_enabled:true,responsive_web_edit_tweet_api_enabled:true,
 graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,view_counts_everywhere_api_enabled:true,
 longform_notetweets_consumption_enabled:true,responsive_web_twitter_article_tweet_consumption_enabled:true,
 tweet_awards_web_tipping_enabled:false,content_disclosure_indicator_enabled:true,
 content_disclosure_ai_generated_indicator_enabled:true,responsive_web_grok_show_grok_translated_post:false,
 responsive_web_grok_analysis_button_from_backend:true,post_ctas_fetch_enabled:false,
 freedom_of_speech_not_reach_fetch_enabled:true,standardized_nudges_misinfo:true,
 tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,
 longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:true,
 responsive_web_grok_image_annotation_enabled:true,responsive_web_grok_imagine_annotation_enabled:true,
 responsive_web_grok_community_note_auto_translation_is_enabled:false,responsive_web_enhance_cards_enabled:false,
};
const USER_TWEETS_TOGGLES={
 withPayments:true,withAuxiliaryUserLabels:true,withArticleRichContentState:true,withArticlePlainText:true,
 withArticleSummaryText:true,withArticleVoiceOver:true,withGrokAnalyze:true,withDisallowedReplyControls:true,
};

const USER_BY_SCREEN_NAME_FEATURES={
 hidden_profile_subscriptions_enabled:true,profile_label_improvements_pcf_label_in_post_enabled:true,
 responsive_web_profile_redirect_enabled:true,rweb_tipjar_consumption_enabled:true,
 responsive_web_graphql_exclude_directive_enabled:true,verified_phone_label_enabled:false,
 subscriptions_verification_info_is_identity_verified_enabled:true,
 subscriptions_verification_info_verified_since_enabled:true,highlights_tweets_tab_ui_enabled:true,
 responsive_web_twitter_article_notes_tab_enabled:true,subscriptions_feature_can_gift_premium:true,
 creator_subscriptions_tweet_preview_api_enabled:true,
 responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,
 responsive_web_graphql_timeline_navigation_enabled:true,
};
const USER_BY_SCREEN_NAME_TOGGLES={withPayments:true,withAuxiliaryUserLabels:true};

const SEARCH_FEATURES={
 rweb_video_screen_enabled:true,rweb_cashtags_enabled:true,
 profile_label_improvements_pcf_label_in_post_enabled:true,responsive_web_profile_redirect_enabled:true,
 rweb_tipjar_consumption_enabled:true,verified_phone_label_enabled:false,
 creator_subscriptions_tweet_preview_api_enabled:true,responsive_web_graphql_timeline_navigation_enabled:true,
 responsive_web_graphql_skip_user_profile_image_extensions_enabled:false,premium_content_api_read_enabled:false,
 communities_web_enable_tweet_community_results_fetch:true,c9s_tweet_anatomy_moderator_badge_enabled:true,
 responsive_web_grok_analyze_button_fetch_trends_enabled:false,responsive_web_grok_analyze_post_followups_enabled:true,
 rweb_cashtags_composer_attachment_enabled:true,responsive_web_jetfuel_frame:true,
 responsive_web_grok_share_attachment_enabled:true,responsive_web_grok_annotations_enabled:true,
 articles_preview_enabled:true,responsive_web_edit_tweet_api_enabled:true,
 graphql_is_translatable_rweb_tweet_is_translatable_enabled:true,view_counts_everywhere_api_enabled:true,
 longform_notetweets_consumption_enabled:true,responsive_web_twitter_article_tweet_consumption_enabled:true,
 content_disclosure_indicator_enabled:true,content_disclosure_ai_generated_indicator_enabled:true,
 responsive_web_grok_show_grok_translated_post:false,responsive_web_grok_analysis_button_from_backend:true,
 post_ctas_fetch_enabled:false,freedom_of_speech_not_reach_fetch_enabled:true,standardized_nudges_misinfo:true,
 tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled:true,
 longform_notetweets_rich_text_read_enabled:true,longform_notetweets_inline_media_enabled:true,
 responsive_web_grok_image_annotation_enabled:true,responsive_web_grok_imagine_annotation_enabled:true,
 responsive_web_grok_community_note_auto_translation_is_enabled:false,responsive_web_enhance_cards_enabled:false,
};
const SEARCH_TOGGLES={
 withPayments:true,withAuxiliaryUserLabels:true,withArticleRichContentState:true,withArticlePlainText:true,
 withArticleSummaryText:true,withArticleVoiceOver:true,withGrokAnalyze:true,withDisallowedReplyControls:true,
};

/**
 * 本机可维护的查询常量表。X 轮换 queryId / feature 开关时只改这里，
 * 用 `node --test test/x-graphql.test.mjs` 的固定夹具回归。
 */
export const X_OPERATIONS=Object.freeze({
 TweetDetail:{queryId:'nBS-WpgA6ZG0CyNHD517JQ',features:TWEET_DETAIL_FEATURES,fieldToggles:TWEET_DETAIL_TOGGLES},
 UserTweets:{queryId:'lrMzG9qPQHpqJdP3AbM-bQ',features:USER_TWEETS_FEATURES,fieldToggles:USER_TWEETS_TOGGLES},
 UserByScreenName:{queryId:'IGgvgiOx4QZndDHuD3x9TQ',features:USER_BY_SCREEN_NAME_FEATURES,fieldToggles:USER_BY_SCREEN_NAME_TOGGLES},
 SearchTimeline:{queryId:'VhUd6vHVmLBcw0uX-6jMLA',features:SEARCH_FEATURES,fieldToggles:SEARCH_TOGGLES},
});

const RESERVED=new Set(['home','explore','search','notifications','messages','i','settings','login','logout','signup','tos','privacy','compose','intent','share','hashtag','lists','bookmarks','jobs','premium','verified','account','about','help']);
const X_HOSTS=new Set(['x.com','www.x.com','twitter.com','www.twitter.com']);

export function normalizeHandle(value){
 let raw=String(value??'').trim();
 if(!raw)return '';
 if(/^https?:\/\//i.test(raw)){
  try{
   const u=new URL(raw);
   if(!X_HOSTS.has(u.hostname)||u.username||u.password||(u.port&&u.port!=='443'))return '';
   const parts=u.pathname.split('/').filter(Boolean);
   if(parts.length!==1)return '';
   raw=parts[0];
  }catch{return '';}
 }
 raw=raw.replace(/^@+/,'');
 if(!/^[A-Za-z0-9_]{1,15}$/.test(raw))return '';
 return RESERVED.has(raw.toLowerCase())?'':raw;
}

export function parseStatusId(value){
 const raw=String(value??'').trim();
 if(/^\d{1,25}$/.test(raw))return raw;
 try{
  const u=new URL(raw);
  if(!X_HOSTS.has(u.hostname)||u.username||u.password||(u.port&&u.port!=='443'))return '';
  const m=u.pathname.match(/^\/(?:i\/(?:web\/)?status|[A-Za-z0-9_]{1,15}\/status)\/(\d{1,25})(?:\/(?:photo|video)\/\d+)?\/?$/);
  return m?m[1]:'';
 }catch{return '';}
}

function graphqlGet(path,variables,operation){
 const params=[
  `variables=${encodeURIComponent(JSON.stringify(variables))}`,
  `features=${encodeURIComponent(JSON.stringify(operation.features))}`,
 ];
 if(operation.fieldToggles&&Object.keys(operation.fieldToggles).length)params.push(`fieldToggles=${encodeURIComponent(JSON.stringify(operation.fieldToggles))}`);
 return {method:'GET',url:`https://x.com/i/api/graphql/${operation.queryId}/${path}?${params.join('&')}`};
}

export function buildTweetDetailRequest(tweetId,cursor){
 const variables={focalTweetId:String(tweetId),referrer:'tweet',with_rux_injections:false,includePromotedContent:false,rankingMode:'Recency',withCommunity:true,withQuickPromoteEligibilityTweetFields:true,withBirdwatchNotes:true,withVoice:true};
 if(cursor)variables.cursor=cursor;
 return graphqlGet('TweetDetail',variables,X_OPERATIONS.TweetDetail);
}
export function buildUserByScreenNameRequest(handle){
 return graphqlGet('UserByScreenName',{screen_name:handle,withSafetyModeUserFields:true},X_OPERATIONS.UserByScreenName);
}
export function buildUserTweetsRequest(userId,count,cursor){
 const variables={userId:String(userId),count,includePromotedContent:false,withQuickPromoteEligibilityTweetFields:true,withVoice:true};
 if(cursor)variables.cursor=cursor;
 return graphqlGet('UserTweets',variables,X_OPERATIONS.UserTweets);
}
export function buildSearchTimelineRequest(query,count,cursor){
 const variables={rawQuery:String(query),count,querySource:'typed_query',product:'Top'};
 if(cursor)variables.cursor=cursor;
 const operation=X_OPERATIONS.SearchTimeline;
 return {
  method:'POST',
  url:`https://x.com/i/api/graphql/${operation.queryId}/SearchTimeline`,
  body:JSON.stringify({variables,features:operation.features,fieldToggles:operation.fieldToggles}),
 };
}

const MEDIA_LABEL={photo:'图片',video:'视频',animated_gif:'动图'};

export function extractMedia(legacy){
 const media=legacy?.extended_entities?.media||legacy?.entities?.media;
 if(!Array.isArray(media))return [];
 return media.filter(Boolean).map(m=>({type:Object.hasOwn(MEDIA_LABEL,m.type)?m.type:'photo',url:typeof m.media_url_https==='string'?m.media_url_https:''}));
}

function userOf(result){
 const u=result?.core?.user_results?.result||result?.user_results?.result||{};
 return {author:u.core?.screen_name||u.legacy?.screen_name||'unknown',name:u.core?.name||u.legacy?.name||''};
}

export function extractTweet(result,seen){
 if(!result)return null;
 const tw=result.__typename==='TweetWithVisibilityResults'&&result.tweet?result.tweet:(result.tweet||result);
 if(!tw?.rest_id||tw.__typename==='TweetTombstone')return null;
 if(seen){if(seen.has(tw.rest_id))return null;seen.add(tw.rest_id);}
 const legacy=tw.legacy||{},user=userOf(tw);
 const note=tw.note_tweet?.note_tweet_results?.result?.text;
 const text=typeof note==='string'&&note.trim()?note:(typeof legacy.full_text==='string'?legacy.full_text:'');
 const quoted=tw.quoted_status_result?.result?extractTweet(tw.quoted_status_result.result,null):null;
 const retweeted=legacy.retweeted_status_result?.result?extractTweet(legacy.retweeted_status_result.result,null):null;
 const at=Date.parse(legacy.created_at);
 return {
  id:tw.rest_id,author:user.author,name:user.name,text,quoted,retweeted,media:extractMedia(legacy),
  created_at:Number.isFinite(at)?new Date(at).toISOString():null,
  in_reply_to:legacy.in_reply_to_status_id_str||null,
  url:`https://x.com/${user.author}/status/${tw.rest_id}`,
 };
}

function bodyWithExtras(tweet){
 let text=tweet.text||'';
 if(tweet.quoted){
  const q=tweet.quoted.text||'';
  text+=(text?'\n\n':'')+`引用 @${tweet.quoted.author}：${q}`;
 }
 if(tweet.media?.length){
  const labels=[...new Set(tweet.media.map(m=>MEDIA_LABEL[m.type]||'媒体'))].join('、');
  text+=(text?'\n\n':'')+`[媒体 ${tweet.media.length} 项：${labels}]`;
 }
 return text;
}
export function formatTweetText(tweet){
 if(!tweet)return '';
 if(tweet.retweeted)return `转推 @${tweet.retweeted.author}：${bodyWithExtras(tweet.retweeted)}`;
 return bodyWithExtras(tweet);
}

function cursorOf(value){
 if((value?.entryType==='TimelineTimelineCursor'||value?.__typename==='TimelineTimelineCursor')&&(value.cursorType==='Bottom'||value.cursorType==='ShowMore')&&typeof value.value==='string')return value.value;
 return null;
}

export function parseTweetDetail(payload,seen=new Set()){
 const tweets=[];let nextCursor=null,tombstone=false;
 const focal=payload?.data?.tweetResult?.result;
 if(focal?.__typename==='TweetTombstone')tombstone=true;
 const instructions=payload?.data?.threaded_conversation_with_injections_v2?.instructions||focal?.timeline?.instructions||[];
 for(const inst of Array.isArray(instructions)?instructions:[]){
  for(const entry of inst?.entries||[]){
   const content=entry?.content;
   const cursor=cursorOf(content);
   if(cursor){nextCursor=cursor;}
   else if(typeof entry?.entryId==='string'&&(entry.entryId.startsWith('cursor-bottom-')||entry.entryId.startsWith('cursor-showMore-'))){
    if(typeof content?.itemContent?.value==='string')nextCursor=content.itemContent.value;
    else if(typeof content?.value==='string')nextCursor=content.value;
   }
   const direct=extractTweet(content?.itemContent?.tweet_results?.result,seen);
   if(direct)tweets.push(direct);
   for(const item of content?.items||[]){
    const nested=extractTweet(item?.item?.itemContent?.tweet_results?.result,seen);
    if(nested)tweets.push(nested);
   }
  }
 }
 return {tweets,nextCursor,tombstone};
}

function timelineVisit(instructions,seen){
 const tweets=[];let nextCursor=null;
 const visit=value=>{
  if(!value||typeof value!=='object')return;
  if(value.type==='TimelinePinEntry')return;
  const cursor=cursorOf(value);
  if(cursor)nextCursor=cursor;
  if(value.tweet_results?.result){
   const tweet=extractTweet(value.tweet_results.result,seen);
   if(tweet)tweets.push(tweet);
  }
  if(Array.isArray(value)){for(const item of value)visit(item);return;}
  for(const child of Object.values(value))if(child&&typeof child==='object')visit(child);
 };
 visit(instructions);
 return {tweets,nextCursor};
}

export function parseUserTweets(payload,seen=new Set()){
 const result=payload?.data?.user?.result||{};
 const instructions=[
  ...(Array.isArray(result.timeline_v2?.timeline?.instructions)?result.timeline_v2.timeline.instructions:[]),
  ...(Array.isArray(result.timeline?.timeline?.instructions)?result.timeline.timeline.instructions:[]),
 ];
 return timelineVisit(instructions,seen);
}

export function parseSearchTimeline(payload,seen=new Set()){
 const instructions=payload?.data?.search_by_raw_query?.search_timeline?.timeline?.instructions||[];
 return timelineVisit(instructions,seen);
}

export function parseUserProfile(payload){
 const result=payload?.data?.user?.result;
 if(!result||result.__typename==='UserUnavailable')return null;
 const user=result.user||result,legacy=user.legacy||{};
 const created=Date.parse(legacy.created_at);
 return {
  id:user.rest_id||'',handle:legacy.screen_name||'',name:legacy.name||'',bio:legacy.description||'',
  location:legacy.location||'',url:legacy.entities?.url?.urls?.[0]?.expanded_url||'',
  followers:Number(legacy.followers_count)||0,following:Number(legacy.friends_count)||0,
  tweets:Number(legacy.statuses_count)||0,protected:legacy.protected===true,
  verified:user.is_blue_verified===true||legacy.verified===true,
  created_at:Number.isFinite(created)?new Date(created).toISOString():null,
 };
}

export function classifyGraphqlStatus(status,payload){
 const errors=Array.isArray(payload?.errors)?payload.errors:[];
 const message=errors.map(e=>String(e?.message??'')).join(' ');
 if(status===401)return 'NEED_LOGIN';
 if(status===403)return /csrf|authenticate|logged in|authorization|oauth/i.test(message)?'NEED_LOGIN':'PLATFORM_BLOCKED';
 if(status===412)return 'PLATFORM_BLOCKED';
 if(status===429)return 'RATE_LIMITED';
 if(status===404)return 'NOT_FOUND';
 if(status>=500)return 'UPSTREAM_BROKEN';
 if(errors.length){
  if(errors.some(e=>Number(e?.code)===88)||/rate limit|too many requests/i.test(message))return 'RATE_LIMITED';
  if(/not found|does not exist|no user|could not resolve|unavailable|suspended|deleted|tombstone/i.test(message))return 'NOT_FOUND';
  if(/csrf|could not authenticate|not logged in|authorization|oauth/i.test(message))return 'NEED_LOGIN';
  if(/blocked|forbidden|security|risk/i.test(message))return 'PLATFORM_BLOCKED';
  return 'UPSTREAM_BROKEN';
 }
 if(payload?.data?.user?.result?.__typename==='UserUnavailable')return 'NOT_FOUND';
 if(payload?.data?.tweetResult?.result?.__typename==='TweetTombstone')return 'NOT_FOUND';
 return null;
}

export function classifyXPage(probe){
 if(!probe||typeof probe!=='object')return 'UPSTREAM_BROKEN';
 if(probe.challenge)return 'PLATFORM_BLOCKED';
 if(probe.login||/^\/(?:login|i\/flow\/login)(?:\/|$)/.test(String(probe.path||'')))return 'NEED_LOGIN';
 if(probe.http===429)return 'RATE_LIMITED';
 if(probe.http===403||probe.http===412)return 'PLATFORM_BLOCKED';
 if(Number(probe.http)>=500)return 'UPSTREAM_BROKEN';
 return null;
}

/** Keep long posts whole: drop a later item instead of cutting text. */
export function fitItems(items,maxBytes=800000){
 const out=[];let bytes=2;
 for(const item of items){
  const size=new TextEncoder().encode(JSON.stringify(item)).length;
  if(out.length&&bytes+size+1>maxBytes)break;
  out.push(item);bytes+=size+1;
 }
 return out;
}
