import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {env} from './support.mjs';

const outfile=`.wrangler/repo-list-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/repo"; export {loadRepoRegistry} from "./src/repo-registry"; export {agentAnswer} from "./src/semantic"; export {tainted} from "./src/authz";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile),fresh='OmnixSI/brand-new',stamp=1794578400000;
const statics=JSON.parse(readFileSync('config/team.json','utf8')).repositories;
async function cache(e,repo=fresh,metadata={private:true,pushed_at:'2026-11-13T12:00:00Z',description:'new project'}){
  await e.DB.prepare('INSERT INTO repo_cache VALUES(?,?,?)').bind(repo,JSON.stringify({repo,metadata,readme:'cached README'}),stamp).run();
}
function context(body='公司里面现在有几个仓库'){
  const row={id:'current',sender:'U1',body,ts:new Date().toISOString(),meta:{direct:true,media:[]}};
  return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true,background:true};
}
const call=(name,args={})=>({id:'tool-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});
async function model(steps,run){
  const old=globalThis.fetch,seen=[];let turn=0;
  globalThis.fetch=async(url,opt)=>{
    assert.ok(!String(url).includes('api.github.com'),'listed repository without a token must never use the public gate');
    const body=JSON.parse(opt.body);seen.push(body);
    const next=steps[turn++];
    return Response.json({choices:[{message:next?{role:'assistant',tool_calls:next}:{content:'{"action":"reply","kind":"direct","brief":"根据真实结果回答"}'}}]});
  };
  try{return await run(seen);}finally{globalThis.fetch=old;}
}

test('L1 repo_list unions static and cached organization repositories with index and freshness metadata',async()=>{
  const e=env();await cache(e);await cache(e,'evil/brand-new');await cache(e,'OmnixSI-evil/brand-new');
  await e.DB.prepare('INSERT INTO repo_state VALUES(?,?,?,?,?)').bind('OmnixSI/TeamAgent','{}','fp',stamp,stamp).run();
  const result=await api.runRepoTool(e,'repo_list',{});
  assert.ok(Array.isArray(result.repositories),JSON.stringify(result));
  assert.deepEqual(result.repositories.map(r=>r.repo).sort(),[...statics,fresh].sort());
  const row=result.repositories.find(r=>r.repo===fresh);
  assert.deepEqual(row,{repo:fresh,aliases:['brand-new'],private:true,pushed_at:'2026-11-13T12:00:00Z',description:'new project',indexed:false,cache_updated_at:stamp});
  assert.equal(result.repositories.find(r=>r.repo==='OmnixSI/TeamAgent').indexed,true);
  assert.equal(result.cache_updated_at,stamp);assert.match(result.source,/repo_cache/);
});

test('L2 cached organization repo without local index or token reports actionable not_synced',async()=>{
  const e=env();await cache(e);
  await model([],async()=>{
    for(const repo of [fresh,'brand-new','https://github.com/OmnixSI/brand-new']){
      const result=await api.runRepoTool(e,'repo_changes',{repo});
      assert.ok(['needs_token','not_synced'].includes(result.error_kind),JSON.stringify(result));
      assert.ok(result.next_action);
    }
  });
});

test('L3 other owners, lookalike owners and uncached private repos never become listed',async()=>{
  const e=env();for(const repo of ['evil/brand-new','OmnixSI-evil/brand-new','omnixsi/brand-new','OmnixSI/bad!'])await cache(e,repo);
  const old=globalThis.fetch;globalThis.fetch=async()=>Response.json({private:true,description:'must not leak'});
  try{
    for(const repo of ['evil/brand-new','OmnixSI-evil/brand-new','omnixsi/brand-new','OmnixSI/not-in-cache']){
      const result=await api.runRepoTool(e,'repo_changes',{repo});
      assert.ok(['denied','not_found'].includes(result.error_kind),repo+': '+JSON.stringify(result));
      assert.ok(!JSON.stringify(result).includes('must not leak'));
    }
    const result=await api.runRepoTool(e,'repo_list',{});
    assert.ok(result.repositories?.every(r=>statics.includes(r.repo)),JSON.stringify(result));
  }finally{globalThis.fetch=old;}
});

test('L4 chat offers repo_list, includes dynamic project hints and reuses a single registry query',async t=>{
  const e=env();await cache(e);e.meter={used:0,left:()=>48};
  const before=e.DB.executed,prepare=e.DB.prepare.bind(e.DB);let registryReads=0;
  e.DB.prepare=sql=>{if(/FROM repo_cache(?! WHERE)/.test(sql))registryReads++;return prepare(sql);};
  await model([[call('repo_list'),call('get_project',{repo:fresh}),call('repo_changes',{repo:fresh})]],async seen=>{
    await api.agentAnswer(e,context());
    const first=seen[0];assert.ok(first.tools?.some(t=>t.function.name==='repo_list'));
    assert.match(first.messages.at(-1).content,/必须先调用 repo_list/);
    assert.match(JSON.stringify(first.messages),/brand-new/);
    assert.ok(first.tools.find(t=>t.function.name==='get_project').function.parameters.properties.repo.enum.includes(fresh));
    const results=seen.flatMap(b=>b.messages||[]).filter(m=>m.role==='tool').map(m=>m.content).join('\n');
    assert.match(results,/cached README/);assert.match(results,/not_synced|needs_token/);
  });
  // Before F5d, this same three-tool round uses 15 statements, including the
  // get_project row/facts reads and repo_changes index lookup (measured baseline).
  assert.equal(registryReads,1);
  assert.ok(e.DB.executed-before<=16,`chat statements=${e.DB.executed-before}`);
  t.diagnostic(`chat SQL: ${e.DB.executed-before}; baseline: 15; registry snapshots: ${registryReads}`);
});

test('L2 token-backed cached private repo keeps cloud results and marks its missing local index',async()=>{
  const e=env();e.GITHUB_TOKEN='test-only-github';await cache(e);
  const old=globalThis.fetch,paths=[];
  globalThis.fetch=async(url,opt)=>{
    const u=new URL(url);paths.push(u.pathname);
    assert.equal(u.origin,'https://api.github.com');assert.equal(opt.headers.Authorization,'Bearer test-only-github');
    assert.equal(u.pathname,'/repos/OmnixSI/brand-new/commits','registered private repos bypass the anonymous metadata gate');
    return Response.json([{sha:'a'.repeat(40),commit:{author:{date:'2026-11-13T12:00:00Z',name:'Alice'},message:'new code'}}]);
  };
  try{
    const result=await api.runRepoTool(e,'repo_changes',{repo:fresh});
    assert.equal(result.commits[0].sha7,'aaaaaaa');assert.equal(paths.length,1);
    assert.equal(result.local_index?.status,'not_synced');assert.ok(result.local_index.next_action);
  }finally{globalThis.fetch=old;}
});

test('L1/L4 registry and chat facts share one valid statement on an isolated local D1 runtime',async()=>{
  const {Miniflare,convertV4MiniflareOptions}=await import('miniflare');
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("test");}}',compatibilityDate:'2026-11-12',d1Databases:{DB:'f5d-local-registry'},port:0}));
  try{
    const db=await mf.getD1Database('DB');
    for(const table of ['repo_cache','repo_state','facts']){
      const statement=readFileSync('schema.sql','utf8').split(';').find(s=>s.includes('CREATE TABLE IF NOT EXISTS '+table+'('));
      await db.prepare(statement).run();
    }
    const e={DB:db};await cache(e);
    await db.prepare("INSERT INTO facts(id,repo,subject,predicate,value,evidence,source_id,status,valid_from) VALUES('fact1','OmnixSI/TeamAgent','team','uses','cache','original words','source1','confirmed',?)").bind(stamp).run();
    const registry=await api.loadRepoRegistry(e,true);
    assert.ok(registry.repos.includes(fresh));
    assert.deepEqual(registry.facts,[{id:'fact1',repo:'OmnixSI/TeamAgent',subject:'team',predicate:'uses',value:'cache',evidence:'original words',status:'confirmed'}]);
    assert.equal((await api.runRepoTool(e,'repo_list',{})).repositories.find(r=>r.repo===fresh).indexed,false);
  }finally{await mf.dispose();}
});

test('L3 repo_list metadata remains untrusted even if its wrapper is stripped',()=>{
  assert.equal(api.tainted({},[{role:'assistant',tool_calls:[call('repo_list')]},{role:'tool',tool_call_id:'tool-repo_list',content:'{}'}]),true);
});
