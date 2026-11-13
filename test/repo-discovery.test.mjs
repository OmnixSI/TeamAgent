import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {build} from 'esbuild';
import {env} from './support.mjs';
const outfile=`.wrangler/repo-discovery-tests-${process.pid}.mjs`;
await build({stdin:{contents:'export * from "./src/repo"; export * from "./src/repo-discovery"; export {metered} from "./src/d1"; export {agentAnswer,LOCAL_TOOLS} from "./src/semantic";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);
const team=JSON.parse(readFileSync('config/team.json','utf8'));
const PEIWAN='OmnixSI/peiwan-club-saas',BLUEPRINT='OmnixSI/peiwan-store-platform-blueprint';
const SHA='9fa6a12'+'b'.repeat(33);
const call=(name,args)=>({id:'tool-t-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});

async function cacheRepos(e,rows){
 for(const [repo,json,at] of rows) await e.DB.prepare('INSERT INTO repo_cache VALUES(?,?,?) ON CONFLICT(repo) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at').bind(repo,JSON.stringify(json),at??Date.now()).run();
}
const cacheJson=(pushed,sha='a'.repeat(40),branch='main')=>({metadata:{default_branch:branch,pushed_at:pushed},head:{sha,branch,at:pushed}});
const six=()=>[
 [PEIWAN,cacheJson('2026-11-13T13:50:53Z',SHA),Date.now()],
 [BLUEPRINT,cacheJson('2026-11-06T08:00:00Z','c'.repeat(40)),Date.now()],
 ['OmnixSI/TeamAgent',cacheJson('2026-11-13T12:00:00Z','d'.repeat(40)),Date.now()],
 ['OmnixSI/WhalePartner',cacheJson('2026-11-12T09:00:00Z','e'.repeat(40)),Date.now()],
 ['OmnixSI/NextThought',cacheJson('2026-11-10T09:00:00Z','f'.repeat(40)),Date.now()],
 ['OmnixSI/NextThought-Website',cacheJson('2026-11-09T09:00:00Z','1'.repeat(40)),Date.now()],
];
async function context(e,body){
 const row={id:'current-'+Math.random().toString(36).slice(2),group_id:'GROUP000001',sender:'U1',body,ts:new Date().toISOString(),mentioned:1,meta:{direct:true,media:[]}};
 await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,body,row.ts,1).run();
 return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned:true};
}
// Every fetch in these replays is the model endpoint. A repository call would
// surface as a non-DeepSeek URL, and a QQ send would land in e.WORK.sent.
async function replay(e,body,steps,voiceText,background=false){
 const old=globalThis.fetch,urls=[],byKey=new Map();let turn=0;
 globalThis.fetch=async(url,opt)=>{
  urls.push(String(url));
  const b=JSON.parse(opt.body);
  for(const m of b.messages||[])if(m.role==='tool'){
   const raw=String(m.content),text=raw.startsWith('【外部资料')?raw.split('\n').slice(1,-1).join('\n'):raw;
   byKey.set(raw,JSON.parse(text));
  }
  if(String(b.messages?.[0]?.content||'').includes('最后的嘴替模块'))
   return Response.json({choices:[{message:{content:JSON.stringify({mode:'work',text:voiceText})}}]});
  const next=steps[turn++];
  return Response.json({choices:[{message:next?{role:'assistant',tool_calls:next}:{content:JSON.stringify({action:'reply',kind:'direct',brief:voiceText})}}]});
 };
 try{const ctx=await context(e,body);ctx.background=background;const answer=await api.agentAnswer(e,ctx);return {answer,tools:[...byKey.values()],urls};}
 finally{globalThis.fetch=old;}
}

test('D1 config 之外的 repo_cache 仓库自动放行，且只限 OmnixSI 组织',async()=>{
 const fresh='OmnixSI/Fresh-Repo_Two',repos=[...team.repositories,fresh];
 const aliases={...team.project_aliases,[fresh]:['新仓库二']};
 const parsed=api.parseRepo('OmnixSI/Fresh-Repo_Two',aliases,repos);
 assert.equal(parsed?.full,fresh);assert.equal(parsed?.listed,true);
 for(const input of ['fresh repo two','FRESH-REPO_TWO','fresh_repo_two','freshrepotwo'])
  assert.equal(api.parseRepo(input,aliases,repos)?.full,fresh,input);
 assert.equal(api.parseRepo('新仓库二',aliases,repos)?.full,fresh);
 const other=api.parseRepo('Other/Fresh-Repo_Two',aliases,repos);
 assert.equal(other?.full,'Other/Fresh-Repo_Two');assert.equal(other?.listed,false);
 assert.equal(api.parseRepo('OmnixSI/Fresh-Repo_Two')?.listed,false,'default set stays static');

 const e=env();await cacheRepos(e,[[fresh,cacheJson('2026-11-13T14:00:00Z','2'.repeat(40))]]);
 const changes=await api.runRepoTool(e,'repo_changes',{repo:'fresh repo two'});
 assert.notEqual(changes.error_kind,'invalid_args');
 assert.ok(['needs_token','not_synced'].includes(changes.error_kind),JSON.stringify(changes));
 const alias=await api.runRepoTool(e,'repo_changes',{repo:'陪玩店'});
 assert.notEqual(alias.error_kind,'invalid_args');
 const seen=await replay(e,'看看新仓库',[[call('get_project',{repo:fresh})]],'好',true);
 assert.ok(seen.tools.some(t=>t.repo===fresh),'get_project 放行 repo_cache 里的动态仓库');
 const outside=await replay(e,'看看外部仓库',[[call('get_project',{repo:'Other/hidden'})]],'好',true);
 assert.equal(outside.tools[0]?.error_kind,'invalid_args','非组织仓库拒绝 get_project');
});

test('D2 list_repos 返回并集 count、代称、push 时间和默认分支',async()=>{
 const e=env(),fresh='OmnixSI/Fresh-Repo_Two';
 await cacheRepos(e,[...six(),[fresh,cacheJson('2026-11-13T14:00:00Z','3'.repeat(40),'trunk')]]);
 const listed=await api.listRepos(e);
 assert.equal(listed.count,7);
 assert.equal(listed.repos.length,7);
 assert.equal(new Set(listed.repos.map(r=>r.full)).size,7);
 const pei=listed.repos.find(r=>r.full===PEIWAN);
 assert.deepEqual(pei.aliases,team.project_aliases[PEIWAN]);
 assert.equal(pei.pushed_at,'2026-11-13T13:50:53Z');
 assert.equal(pei.default_branch,'main');assert.equal(pei.indexed,true);
 const newbie=listed.repos.find(r=>r.full===fresh);
 assert.deepEqual(newbie.aliases,[]);assert.equal(newbie.default_branch,'trunk');
 assert.equal(newbie.indexed,true);
 assert.equal(listed.repos[0].full,fresh,'最新 push 排最前');
 assert.equal(listed.repos.at(-1).full,BLUEPRINT);

 const plain=env();
 await plain.DB.prepare('DROP TABLE repo_cache').run();
 const fallback=await api.listRepos(plain);
 assert.equal(fallback.count,team.repositories.length);
 assert.ok(fallback.repos.every(r=>r.indexed===false));
});

test('D3 代称歧义列候选；带最新/最近按 pushed_at 选，并列不猜',async()=>{
 const e=env();
 await cacheRepos(e,[
  [PEIWAN,cacheJson('2026-11-13T13:50:53Z',SHA),Date.now()],
  [BLUEPRINT,cacheJson('2026-11-06T08:00:00Z','c'.repeat(40)),Date.now()],
 ]);
 const aliases={[PEIWAN]:['陪玩店'],[BLUEPRINT]:['陪玩店']};
 const plain=await api.resolveRepoRef(e,'陪玩店',{aliases});
 assert.equal(plain.ambiguous,true);assert.deepEqual(plain.candidates,[PEIWAN,BLUEPRINT]);
 const failure=api.toolFailure('repo_changes',null,{kind:'ambiguous',candidates:plain.candidates});
 assert.equal(failure.next_action,'匹配到多个仓库，请选 1/2，或写 owner/repo：'+PEIWAN+'、'+BLUEPRINT);
 assert.deepEqual(failure.candidates,plain.candidates);

 const latest=await api.resolveRepoRef(e,'陪玩店',{aliases,text:'读一下最新的陪玩店那个项目'});
 assert.equal(latest.ambiguous,false);assert.equal(latest.ref.full,PEIWAN);assert.equal(latest.picked,'latest');
 const ownWords=await api.resolveRepoRef(e,'最新的陪玩店',{aliases});
 assert.equal(ownWords.ref.full,PEIWAN);

 await cacheRepos(e,[[BLUEPRINT,cacheJson('2026-11-13T13:50:53Z','c'.repeat(40)),Date.now()]]);
 const tied=await api.resolveRepoRef(e,'陪玩店',{aliases,text:'最新的陪玩店'});
 assert.equal(tied.ambiguous,true,'same pushed_at must not be guessed');
});

test('D4 动态仓库无代称时英文/中文名模糊匹配',async()=>{
 const fresh='OmnixSI/Fresh-Repo_Two',repos=[...team.repositories,fresh];
 const aliases={...team.project_aliases,[fresh]:['新仓库二']};
 for(const input of ['fresh repo two','Fresh-Repo_Two','FRESH_REPO_TWO'])
  assert.equal(api.parseRepo(input,aliases,repos)?.full,fresh,input);
 const e=env();
 await cacheRepos(e,[[fresh,cacheJson('2026-11-13T14:00:00Z','4'.repeat(40))]]);
 const named=await api.resolveRepoRef(e,'看一下新仓库二那个项目',{aliases,repos});
 assert.equal(named.ref.full,fresh);assert.equal(named.ref.listed,true);
 const english=await api.resolveRepoRef(e,'check fresh repo two',{aliases,repos});
 assert.equal(english.ref.full,fresh);
});

test('回放 msg#436 最新陪玩店：repo 工具放行并带出 peiwan-club-saas 9fa6a12',async()=>{
 const e=env();await cacheRepos(e,six());
 await e.DB.prepare('INSERT INTO repo_state VALUES(?,?,?,?,?)').bind(PEIWAN,JSON.stringify({head:{sha:SHA,branch:'main',at:Date.parse('2026-11-13T13:50:53Z')},branches:[],worktrees:[]}),'synthetic-fp',Date.now(),Date.now()).run();
 const {answer,tools,urls}=await replay(e,'读一下最新的陪玩店那个项目',[[
  call('repo_changes',{repo:'陪玩店'}),
 ]],'最新的是 OmnixSI/peiwan-club-saas，最新提交 9fa6a12。');
 const project=tools.find(t=>t.repo===PEIWAN);
 assert.ok(project,'repo_changes 必须解析代称到新仓库并返回本地索引');
 assert.equal(project.head.sha7,'9fa6a12');
 assert.ok(!project.error_kind,JSON.stringify(project));
 assert.match(answer,/peiwan-club-saas/);
 const snapshot=await replay(e,'读一下最新的陪玩店那个项目',[[call('get_project',{repo:'最新的陪玩店那个项目'})]],
  '读到了 OmnixSI/peiwan-club-saas。',true);
 const cached=snapshot.tools.find(t=>t.repo===PEIWAN);
 assert.ok(cached,'get_project 必须从 repo_cache 解析代称');
 assert.ok(JSON.stringify(cached).includes('9fa6a12'));
 assert.equal(e.WORK.sent.length,0,'QQ 真实发送 0 次');
 assert.ok([...urls,...snapshot.urls].length>0&&[...urls,...snapshot.urls].every(u=>u.startsWith('https://api.deepseek.com')),'只访问模型端点，线上 D1 写入 0 行');
});

test('回放 msg#437/438 仓库数量与新仓库：count 6 且点出 peiwan-club-saas',async()=>{
 const e=env();await cacheRepos(e,six());
 const ask=await replay(e,'公司里面现在有几个仓库',[[call('list_repos',{})]],
  '公司现在有 6 个仓库：OmnixSI/NextThought、OmnixSI/NextThought-Website、OmnixSI/WhalePartner、OmnixSI/peiwan-store-platform-blueprint、OmnixSI/peiwan-club-saas、OmnixSI/TeamAgent。');
 const listed=ask.tools.find(t=>typeof t.count==='number');
 assert.ok(listed,'437 必须调用 list_repos');assert.equal(listed.count,6);
 assert.ok(listed.repos.some(r=>r.full===PEIWAN));
 assert.match(ask.answer,/6 个仓库/);
 assert.equal(ask.urls.every(u=>u.startsWith('https://api.deepseek.com')),true);

 const follow=await replay(e,'应该还有一个新的仓库才对',[[call('list_repos',{})]],
  '对，还有一个 OmnixSI/peiwan-club-saas，代称是陪玩店，最新 push 2026-11-13T13:50:53Z。');
 const again=follow.tools.find(t=>typeof t.count==='number');
 assert.ok(again);assert.equal(again.count,6);
 const pei=again.repos.find(r=>r.full===PEIWAN);
 assert.ok(pei,'438 必须点出新仓库');assert.ok(pei.aliases.includes('陪玩店'));
 assert.match(follow.answer,/peiwan-club-saas/);
 assert.equal(e.WORK.sent.length,0,'QQ 真实发送 0 次');
});
