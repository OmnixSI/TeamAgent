import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {env} from './support.mjs';

// F6-4: the capability card must be generated from the deployed tool table and
// tell the truth about the read-only repo tools, switched-off tools included.
const outfile=`.wrangler/capability-card-${process.pid}.mjs`;
await build({stdin:{contents:'export {agentAnswer} from "./src/semantic"; export {capabilityCard,CARD_MAX,toolDisabled} from "./src/capability-card"; export {PARTICIPATION} from "./src/engagement";',resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'browser',format:'esm',outfile});
const api=await import('../'+outfile);

const tool=(name,description)=>({type:'function',function:{name,description}});
const rows=card=>card.split('\n').filter(line=>/^- [a-z_]+：/.test(line));

async function context(e,body,{mentioned=true,direct=true}={}){
  const row={id:'current',group_id:'GROUP000001',sender:'U1',body,ts:new Date().toISOString(),mentioned:mentioned?1:0,meta:{direct,media:[]}};
  await e.DB.prepare('INSERT INTO messages(id,group_id,sender,body,ts,mentioned) VALUES(?,?,?,?,?,?)').bind(row.id,row.group_id,row.sender,row.body,row.ts,row.mentioned).run();
  return {latest:row,batch:[row],recent:[row],names:new Map(),refs:new Map(),mentioned};
}

// One real round of agentAnswer with the network mocked; returns the first
// model request so tests inspect exactly what the model was told.
async function request(body,{switches={}}={}){
  const e=env();
  for(const [key,value] of Object.entries(switches))
    await e.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(key,value).run();
  const ctx=await context(e,body);
  const old=globalThis.fetch,seen=[];
  globalThis.fetch=async(_url,opt)=>{
    const b=JSON.parse(opt.body);seen.push(b);
    if(b.messages?.[0]?.content?.includes('最后的嘴替模块'))
      return Response.json({choices:[{message:{content:'{"mode":"work","text":"我先核对工具。"}'}}]});
    return Response.json({choices:[{message:{content:'{"action":"reply","kind":"direct","brief":"按能力卡回答"}'}}]});
  };
  try{await api.agentAnswer(e,ctx);}finally{globalThis.fetch=old;}
  return seen[0];
}

test('C1-1 card rows come from the tool table, one row per tool, first sentence only',()=>{
  const card=api.capabilityCard([
    tool('alpha_tool','做甲事。第二句不应出现。'),
    tool('beta_tool','做乙事。'),
  ],{switches:{}});
  assert.ok(card.includes('- alpha_tool：做甲事'),card);
  assert.ok(card.includes('- beta_tool：做乙事'),card);
  assert.ok(!card.includes('第二句不应出现'),'only the first sentence is the capability');
  assert.ok(!card.includes('gamma_tool'),'a tool absent from the table must not be claimed');
  assert.equal(rows(card).length,2,'exactly one row per tool');
  assert.ok(card.includes('没列出的就是不能做'),'the card says absent tools do not exist');
});

test('C1-2 off:repo_tools marks every switched-off tool as 当前已关闭',()=>{
  const table=[tool('repo_changes','查仓库最近提交。'),tool('repo_commit','查提交改动。'),tool('repo_file','读仓库文件。'),tool('read_web','读网页。')];
  assert.ok(!api.capabilityCard(table,{switches:{}}).includes('当前已关闭'));
  const card=api.capabilityCard(table,{switches:{'off:repo_tools':'1'}});
  for(const name of ['repo_changes','repo_commit','repo_file']){
    const line=rows(card).find(x=>x.startsWith('- '+name+'：'));
    assert.ok(line?.includes('当前已关闭'),`${name}: ${line}`);
  }
  assert.ok(!rows(card).find(x=>x.startsWith('- read_web：')).includes('当前已关闭'));
  assert.equal(api.toolDisabled('repo_changes',{'off:repo_tools':'1'}),true);
  assert.equal(api.toolDisabled('repo_changes',{}),false);
  assert.equal(api.toolDisabled('read_web',{'off:repo_tools':'1'}),false);
});

test('C1-3 real tool table: read-only boundary, corrected create-task wording, no write claims',async()=>{
  const req=await request('你都能干啥');
  const prepare=req.tools.find(t=>t.function.name==='prepare_project_task');
  assert.ok(prepare,'prepare_project_task must still be offered');
  assert.match(prepare.function.description,/^创建开发任务（复杂的转人工），不是我亲手改代码/);
  const system=req.messages[0].content;
  assert.ok(system.includes('我对代码仓库只读，不能直接改文件、提交或合并；要改代码我会建开发任务交给团队'),system);
  assert.ok(system.includes('prepare_project_task：创建开发任务（复杂的转人工），不是我亲手改代码'),system);
  for(const name of ['repo_changes','repo_commit','repo_file'])
    assert.ok(system.includes(name+'：'),name+' row missing from the card');
  for(const bad of ['能读仓库、改文件、提变更','能改文件','能提交代码','能合并 PR'])
    assert.ok(!system.includes(bad),`false capability claim: ${bad}`);
});

test('C1-4 card stays within CARD_MAX and adds nothing but the card to the system prompt',async()=>{
  const req=await request('你都能干啥');
  const card=api.capabilityCard(req.tools,{switches:{}});
  assert.ok([...card].length<=api.CARD_MAX,`card ${[...card].length} > ${api.CARD_MAX}`);
  assert.equal(api.CARD_MAX,1800);
  assert.equal(req.messages[0].role,'system');
  // SK-2 inserts the generated vendor line inside the card, so compare the frame.
  assert.ok(req.messages[0].content.startsWith(api.PARTICIPATION+'\n\n能力卡（当前部署真实存在的工具）：'),'system prompt is original budget plus exactly one card');
  assert.ok(req.messages[0].content.endsWith('没列出的就是不能做，不要声称能做。'),'nothing follows the card');
});

test('C2 real prompt with off:repo_tools still names the tools and marks them closed',async()=>{
  const req=await request('你都能干啥',{switches:{'off:repo_tools':'1'}});
  assert.ok(!req.tools.some(t=>t.function.name==='repo_changes'),'disabled tools are not offered to the model');
  const system=req.messages[0].content;
  for(const name of ['repo_changes','repo_commit','repo_file']){
    const line=rows(system).find(x=>x.startsWith('- '+name+'：'));
    assert.ok(line?.includes('当前已关闭'),`${name}: ${line}`);
  }
});

test('C3 replay msg#436/437 and capability questions carry the card in the system segment',async()=>{
  // Real production messages (read-only ledger): msg#436 asked about the newest
  // 陪玩店, msg#437 asked how many repos the company has.
  for(const body of ['最新的陪玩店','公司里面现在有几个仓库','你能改我们仓库的代码吗','你都能干啥']){
    const req=await request(body);
    const system=req.messages[0].content;
    assert.equal(req.messages[0].role,'system',body);
    assert.ok(system.includes('能力卡'),`${body}: no card`);
    assert.ok(system.includes('我对代码仓库只读，不能直接改文件、提交或合并'),`${body}: no read-only boundary`);
    assert.ok(system.includes('- repo_changes：'),`${body}: no repo_changes row`);
    assert.ok(req.tools.some(t=>t.function.name==='repo_changes'),`${body}: repo tools not offered`);
  }
});

// F8-4: F7/F8 extension tools collapse into one 还能 line so the base rows keep
// their real wording (C1-3 was red because CARD_MAX clipped every description).
test('C4-1 extra tools merge into one 还能 line; base rows keep full wording',()=>{
  const card=api.capabilityCard([
    tool('prepare_project_task','创建开发任务（复杂的转人工），不是我亲手改代码。第二句不出现。'),
    tool('repo_changes','云端查 GitHub 仓库最近提交。'),
    tool('calc','安全计算数学表达式。'),
    tool('search_kb','在本群知识库检索。'),
    tool('generate_image','按提示词生成图片。'),
  ],{switches:{},extraNames:['calc','search_kb','generate_image']});
  assert.ok(card.includes('- prepare_project_task：创建开发任务（复杂的转人工），不是我亲手改代码 / 需用户明确交办，不自动编码'),card);
  assert.ok(card.includes('- repo_changes：云端查 GitHub 仓库最近提交 / 只读；私有仓库需 GitHub 只读令牌，本机部分需本机 runner'),card);
  const line=card.split('\n').find(x=>x.startsWith('还能：'));
  assert.ok(line,'no merged 还能 line\n'+card);
  assert.ok(line.startsWith('还能：generate_image（按你给的描述生成一张图并发到群里 / 需成员明确要求，每人每天限 5 张，会被内容安全拒绝）'),line);
  assert.ok(line.includes('、calc、search_kb'),line);
  assert.ok(line.endsWith('（各只读/需明确要求）'),line);
  assert.ok(!card.includes('- calc：'),'extra tools must not get their own row');
  assert.ok([...card].length<=api.CARD_MAX,`card ${[...card].length} > ${api.CARD_MAX}`);
});

test('C4-2 real tool table card keeps base rows whole with generate_image squeezed in',async()=>{
  const req=await request('你都能干啥');
  const extraNames=['calc','search_emoji','forget_profile','get_profile','news_search','read_document','recall_episode','search_code','search_pr_issue','search_history','search_kb','summarize_chat','generate_image'];
  const table=[...req.tools,tool('generate_image','按提示词生成图片。')];
  const card=api.capabilityCard(table,{switches:{},extraNames});
  assert.ok([...card].length<=api.CARD_MAX,`card ${[...card].length} > ${api.CARD_MAX}`);
  assert.ok(card.includes('- prepare_project_task：创建开发任务（复杂的转人工），不是我亲手改代码 / 需用户明确交办，不自动编码'),card);
  for(const name of ['repo_changes','repo_commit','repo_file'])
    assert.ok(card.includes('- '+name+'：'),name+' row missing');
  assert.ok(!card.includes('- calc：'),'F7 extras must be merged, not rows');
  const line=card.split('\n').find(x=>x.startsWith('还能：'));
  assert.ok(line?.startsWith('还能：generate_image（按你给的描述生成一张图并发到群里'),line);
  for(const name of ['calc','search_kb','summarize_chat']) assert.ok(line.includes(name),name);
});

test('C4-3 off:generate_image / off:openai mark the image tool closed',()=>{
  const table=[tool('generate_image','按提示词生成图片。'),tool('calc','安全计算数学表达式。')];
  for(const sw of ['off:generate_image','off:openai']){
    const card=api.capabilityCard(table,{switches:{[sw]:'1'},extraNames:['generate_image','calc']});
    assert.ok(card.includes('generate_image（按你给的描述生成一张图并发到群里 / 需成员明确要求，每人每天限 5 张，会被内容安全拒绝；当前已关闭）'),sw+'\n'+card);
  }
  assert.equal(api.toolDisabled('generate_image',{'off:generate_image':'1'}),true);
  assert.equal(api.toolDisabled('generate_image',{'off:openai':'1'}),true);
  assert.equal(api.toolDisabled('generate_image',{}),false);
});
