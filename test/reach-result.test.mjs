import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReachResult, validators} from '../runner/reach-result.mjs';

const request={version:1,channel:'xiaohongshu',action:'read',backend:'local',target:'https://www.xiaohongshu.com/explore/abc?xsec_token=SECRET'};
const good={ok:true,items:[{title:'标题',text:'可核实的笔记正文',author:'作者',url:request.target}],completeness_verified:true};
test('trial §4 error shells, 412 and SECURITY_BLOCK never become readable material',()=>{
 for(const [channel,raw,want] of [
  ['xiaohongshu',{ok:true,text:'300031 unavailable'},'insufficient_content'],
  ['xueqiu',{ok:true,items:[{text:'人机验证 请完成验证码'}]},'platform_blocked'],
  ['xiaohongshu',{ok:false,error:{status:412}},'platform_blocked'],
  ['x',{ok:false,error:{code:'SECURITY_BLOCK',stage:'navigate'}},'platform_blocked'],
  ['x',{ok:false,error:{code:'UPSTREAM_BROKEN',message:'unknown login error'}},'upstream_unavailable'],
  ['x',{ok:false,error:{code:'NEED_LOGIN'}},'login_required'],
  ['x',{ok:true,items:[]},'insufficient_content'],
 ]){
  const r=normalizeReachResult({...request,channel},raw);
  assert.equal(r.ok,false);assert.equal(r.error.error_kind,want);assert.equal(r.items.length,0);assert.ok(r.error.next_action);
 }
});
test('envelope allowlists fields, scrubs embedded credentials, and preserves honest scope',()=>{
 const r=normalizeReachResult(request,{...good,cookie:'TOPSECRET',raw:{token:'TOPSECRET'},meta:{cookie:'TOPSECRET'},items:[{...good.items[0],text:'正文 Cookie: a=TOPSECRET\n更多正文 xsec_token=SECRET',cookie:'TOPSECRET',stack:'stack trace'}]});
 const s=JSON.stringify(r);assert.doesNotMatch(s,/cookie|TOPSECRET|SECRET|stack|xsec_token/i);
 assert.equal(r.schema_version,1);assert.equal(r.content_scope,'post_text');assert.equal(r.completeness_verified,false);
 assert.equal(r.source_url,'https://www.xiaohongshu.com/explore/abc');
 assert.equal(normalizeReachResult({...request,action:'search'},good).content_scope,'search_results');
 assert.equal(normalizeReachResult({...request,action:'comments'},good).content_scope,'loaded_comments');
});
test('platform validators reject structurally incomplete content and cannot elevate scope',()=>{
 validators.set('xiaohongshu',raw=>raw.items?.[0]?.author ? null : 'insufficient_content');
 try{assert.equal(normalizeReachResult(request,{ok:true,items:[{text:'长'.repeat(500)}]}).ok,false);assert.equal(normalizeReachResult(request,good).ok,true);}finally{validators.delete('xiaohongshu');}
});
test('rate limit preserves bounded retry_after, vendor code and stage without upstream messages',()=>{
 const r=normalizeReachResult(request,{ok:false,error:{code:'RATE_LIMITED',retry_after:3600,stage:'read',message:'Cookie: secret'}});
 assert.equal(r.error.error_kind,'rate_limited');assert.equal(r.error.retry_after,3600);assert.equal(r.error.vendor_code,'RATE_LIMITED');assert.equal(r.error.stage,'read');assert.doesNotMatch(JSON.stringify(r),/cookie|secret/i);
});
