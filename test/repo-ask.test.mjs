import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {env} from './support.mjs';

// F5c: repository-activity questions must keep the read-only repo tools even
// when a round is low on D1 budget, and failures must reach the model intact.
const outfile=`.wrangler/repo-ask-${process.pid}.mjs`;
await build({stdin:{contents:'export {isRepoActivityAsk,agentAnswer} from "./src/semantic";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);

const call=(name,args)=>({id:'tool-'+name,type:'function',function:{name,arguments:JSON.stringify(args)}});

async function context(e,body,{mentioned=false,direct=true}={}){
  const row={id:'current',group_id:'GROUP000001',sender:'U1',body,ts:new Date().toISOString(),mentioned:mentioned?1:0,meta:{direct,media:[]}};
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,row.body,row.ts,row.mentioned).run();
  return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned};
}

async function model(steps,run){
  const old=globalThis.fetch,seen=[];let turn=0;
  globalThis.fetch=async(_url,opt)=>{
    const b=JSON.parse(opt.body);seen.push(b);
    if(b.messages?.[0]?.content?.includes('最后的嘴替模块'))return Response.json({choices:[{message:{content:'{"mode":"work","text":"按提交记录回答。"}'}}]});
    const next=steps[turn++];
    return Response.json({choices:[{message:next?{role:'assistant',tool_calls:next}:{content:'{"action":"reply","kind":"direct","brief":"依据真实仓库记录回答"}'}}]});
  };
  try{return await run({seen});}finally{globalThis.fetch=old;}
}

async function offeredRound(body,left,opts){
  const e=env();e.meter={used:0,left:()=>left};
  const ctx=await context(e,body,opts);let round={names:[],messages:[]};
  await model([],async s=>{await api.agentAnswer(e,ctx);const b=s.seen[0]||{};round={names:(b.tools||[]).map(t=>t.function.name),messages:b.messages||[]};});
  return round;
}

test('A1 isRepoActivityAsk matches repository-activity questions only',()=>{
  for(const body of ['陪玩店那个项目目前改的怎么样，做了哪些新修改','bot 最近有哪些新提交','pkg 分支最近的提交','check the latest commit on main'])assert.equal(api.isRepoActivityAsk(body),true,body);
  for(const body of ['今天吃什么','你好','repo_changes 是什么工具'])assert.equal(api.isRepoActivityAsk(body),false,body);
});

test('A2 repo activity asks keep repo tools at D1 budget 16–31',async()=>{
  for(const left of [16,20,31]){
    const round=await offeredRound('bot 最近有哪些新提交',left,{mentioned:true});
    assert.ok(round.names.includes('repo_changes'),`left=${left}: ${round.names}`);
    assert.ok(round.names.includes('repo_commit'),`left=${left}: ${round.names}`);
    const hint=round.messages.at(-1);
    assert.equal(hint?.role,'system',`left=${left}: ${JSON.stringify(hint)}`);
    assert.match(hint.content,/用户在问仓库动态，必须先调用 repo_changes/);
  }
  const low=await offeredRound('bot 最近有哪些新提交',15,{mentioned:true});
  assert.ok(!low.names.includes('repo_changes'),`left=15: ${low.names}`);
  const chat=await offeredRound('今天吃什么',20,{mentioned:true});
  assert.ok(!chat.names.includes('repo_changes'),`chat left=20: ${chat.names}`);
  const baseline=await offeredRound('今天吃什么',32,{mentioned:true});
  assert.ok(baseline.names.includes('repo_changes'),`baseline left=32: ${baseline.names}`);
});

test('A2 direct repository ask without @ still receives repo tools, unrelated does not',async()=>{
  const direct=await offeredRound('仓库最近有哪些更新',20,{mentioned:false,direct:true});
  assert.ok(direct.names.includes('repo_changes'),`direct: ${direct.names}`);
  const passive=await offeredRound('仓库最近有哪些更新',20,{mentioned:false,direct:false});
  assert.ok(!passive.names.includes('repo_changes'),`passive: ${passive.names}`);
});

test('A3 system prompt and help copy are read-only and never claim write access',()=>{
  const policy=JSON.parse(readFileSync('config/participation.json','utf8')).text;
  assert.match(policy,/只读/);
  assert.match(policy,/repo_changes/);
  const files=[];
  const walk=dir=>{for(const ent of readdirSync(dir,{withFileTypes:true})){const p=join(dir,ent.name);if(ent.isDirectory()){if(ent.name!=='node_modules')walk(p);}else if(/\.(ts|tsx|js|mjs|json|html|css|md)$/.test(ent.name))files.push(p);}};
  for(const dir of ['src','config','web'])walk(dir);
  assert.ok(files.length>10,'expected to scan source and prompt copy');
  for(const file of files)assert.doesNotMatch(readFileSync(file,'utf8'),/改文件|提变更/,file);
  assert.match(readFileSync('src/guide.ts','utf8'),/只读/);
});

test('A4 repo tool failure keeps error_kind and next_action in the model-facing message',async()=>{
  const e=env();const ctx=await context(e,'读一下 TeamAgent 仓库的 README',{mentioned:true});
  await model([[call('repo_file',{repo:'OmnixSI/TeamAgent',path:'README.md'})]],async s=>{
    await api.agentAnswer(e,ctx);
    const tool=s.seen.flatMap(b=>b.messages||[]).find(m=>m.role==='tool');
    assert.ok(tool,'tool message missing');
    assert.match(tool.content,/"ok":false/);
    assert.match(tool.content,/"error_kind":"needs_token"/);
    assert.match(tool.content,/"next_action":"[^"]+"/);
  });
});
