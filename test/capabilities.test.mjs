import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const outfile=`.wrangler/capabilities-tests-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/capabilities"; export {AuthorizationError} from "./src/authz"; export {ResourceLimitError} from "./src/d1"; export {redactPatch as repoRedactPatch, toolFailure as repoToolFailure} from "./src/repo";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);
const tool=(name,description)=>({type:'function',function:{name,description,parameters:{type:'object',properties:{}}}});
const KINDS=['unauthorized','budget','timeout','not_found','ambiguous','invalid_args','denied','stale_index','not_synced','runner_offline','runner_unsupported','upstream','risk','unknown','duplicate'];
const RETRYABLE=['budget','timeout','runner_offline','upstream'];
const NO_TOOLS='本轮已不能再调用工具，基于已有结果回答，缺什么就写缺什么。';

test('C2-1 capabilityCard lists exactly the offered tools and ignores the second sentence',()=>{
 const card=api.capabilityCard([tool('repo_changes','云端查仓库最近提交。第二句不应出现'),tool('repo_file','读仓库文件。第二句不应出现'),tool('read_web','读网页。第二句不应出现')],{toolsOffered:true});
 for(const name of ['repo_changes','repo_file','read_web'])assert.ok(card.includes(name+'：'),card);
 assert.ok(!card.includes('第二句不应出现'),card);
 assert.match(card,/不能直接改仓库/);
 assert.match(card,/回答分三类说/);
 assert.ok(card.length<=600,'card '+card.length);
});
test('C2-1 capabilityCard without tools carries the cap sentence and stays under 600 chars',()=>{
 const card=api.capabilityCard([],{toolsOffered:false});
 assert.ok(card.includes(NO_TOOLS),card);
 assert.ok(card.length<=600,'card '+card.length);
 const offered=api.capabilityCard([],{toolsOffered:true});
 assert.ok(!offered.includes(NO_TOOLS));
 assert.ok(offered.length<=600);
});
test('C2-1 capabilityCard truncates a full tool table under 600 chars without dropping the first tool',()=>{
 const tools=Array.from({length:24},(_,i)=>tool('tool_'+i,'这是第 '+i+' 个工具的用途说明，写得很长很长，用来测试六百字上限是否能兜住。第二句'));
 const card=api.capabilityCard(tools,{toolsOffered:true});
 assert.ok(card.length<=600,'card '+card.length);
 assert.ok(card.includes('tool_0：'),card);
 assert.match(card,/不能直接改仓库/);
 assert.match(card,/回答分三类说/);
});
test('C2-2 NEXT_ACTION covers all ErrorKind values exactly, one sentence each',()=>{
 assert.deepEqual(Object.keys(api.NEXT_ACTION).sort(),[...KINDS].sort());
 for(const kind of KINDS){const text=api.NEXT_ACTION[kind];assert.equal(typeof text,'string');assert.ok(text.trim().length>0,kind);assert.ok(!text.includes('\n'),kind);}
});
for(const kind of KINDS){
 test('C2-2 NEXT_ACTION row '+kind+' is returned by toolFailure',()=>{
  const failure=api.toolFailure('probe',null,{kind});
  assert.deepEqual({ok:failure.ok,error_kind:failure.error_kind,next_action:failure.next_action,retryable:failure.retryable},{ok:false,error_kind:kind,next_action:api.NEXT_ACTION[kind],retryable:RETRYABLE.includes(kind)});
 });
}
test('C2-2 error classes map to unauthorized, budget and timeout before an explicit kind',()=>{
 assert.equal(api.toolFailure('t',new api.AuthorizationError('没有交办'),{kind:'upstream'}).error_kind,'unauthorized');
 assert.equal(api.toolFailure('t',new api.ResourceLimitError(),{kind:'upstream'}).error_kind,'budget');
 const abort=Object.assign(new Error('aborted'),{name:'AbortError'});
 assert.equal(api.toolFailure('t',abort).error_kind,'timeout');
 const timed=Object.assign(new Error('slow'),{name:'TimeoutError'});
 assert.equal(api.toolFailure('t',timed).error_kind,'timeout');
 assert.equal(api.toolFailure('t',new Error('boom')).error_kind,'upstream');
 assert.equal(api.toolFailure('t',new Error('boom'),{kind:'risk'}).error_kind,'risk');
});
test('C2-2 retryable is true only for budget, timeout, runner_offline and upstream',()=>{
 for(const kind of KINDS)assert.equal(api.toolFailure('t',null,{kind}).retryable,RETRYABLE.includes(kind),kind);
});
test('C2-2 legacy kinds used by existing callers keep their own next_action',()=>{
 const legacy={needs_token:/token/,rate_limited:/限流/,too_large:/太大/,binary:/二进制/};
 for(const [kind,pattern] of Object.entries(legacy)){
  const failure=api.toolFailure('repo_file',null,{kind});
  assert.equal(failure.error_kind,kind);
  assert.match(failure.next_action,pattern);
  assert.notEqual(failure.next_action,api.NEXT_ACTION.upstream);
 }
});
test('C2-2 toolFailure keeps tool, tried, redacts and caps detail at 120 chars',()=>{
 const detail='前情 '+'sk-'+'a'.repeat(40)+' '+'尾'.repeat(200);
 const failure=api.toolFailure('read_web',null,{kind:'upstream',tried:'read_web',detail});
 assert.equal(failure.tool,'read_web');
 assert.equal(failure.tried,'read_web');
 assert.ok(failure.detail.length<=120,'detail '+failure.detail.length);
 assert.ok(!failure.detail.includes('sk-'+'a'.repeat(40)),failure.detail);
 assert.equal(api.toolFailure('x',null,{}).detail,undefined);
});
test('C2-2 repo still exports the same toolFailure and redactPatch for existing callers',()=>{
 assert.equal(api.repoToolFailure,api.toolFailure);
 assert.equal(typeof api.repoRedactPatch,'function');
 assert.ok(!api.repoRedactPatch('Authorization: Bearer '+'b'.repeat(30)).includes('b'.repeat(30)));
});
